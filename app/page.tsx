"use client";
import { useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const MLB_API = "https://statsapi.mlb.com/api/v1";
const SEASON = "2026";
const MC_RUNS = 10000;

// ─── INTERFACES ───────────────────────────────────────────────
interface Game {
  gamePk: number;
  gameDate: string;
  status: { detailedState: string; abstractGameState: string };
  teams: {
    away: { team: { id: number; name: string }; probablePitcher?: { id: number; fullName: string } };
    home: { team: { id: number; name: string }; probablePitcher?: { id: number; fullName: string } };
  };
  venue: { name: string };
}

interface PitcherStats {
  era: string; whip: string; strikeOuts: string; baseOnBalls: string;
  inningsPitched: string; wins: string; losses: string;
  strikeoutsPer9: string; walksPer9: string;
  homeEra: string; awayEra: string;
  pitchHand: string;
}

interface RecentForm {
  recentEra: string;
  trend: "hot" | "cold" | "neutral";
  lastStarts: number;
}

interface PitcherRole { isStarter: boolean; position: string; }

interface TeamBatting {
  avg: string; ops: string; obp: string; slg: string;
  runs: string; homeRuns: string; runsPerGame: string;
  opsVsLeft: string; opsVsRight: string;
}

interface BullpenStats { era: string; whip: string; count: number; }

interface PoissonResult { homeWinPct: number; awayWinPct: number; }

interface SimResult {
  homeWinPct: number; awayWinPct: number;
  avgHomeRuns: number; avgAwayRuns: number;
}

interface GameAnalysis {
  game: Game;
  homePitcher: { name: string; stats: PitcherStats | null; form: RecentForm | null; role: PitcherRole | null };
  awayPitcher: { name: string; stats: PitcherStats | null; form: RecentForm | null; role: PitcherRole | null };
  homeBatting: TeamBatting | null;
  awayBatting: TeamBatting | null;
  homeBullpen: BullpenStats | null;
  awayBullpen: BullpenStats | null;
  poisson: PoissonResult | null;
  simulation: SimResult | null;
  score: number;
  recommendation: string;
  isLocked: boolean;
}

interface Pick {
  game_pk: number; created_at: string; game_date: string;
  home_team: string; away_team: string; home_pitcher: string;
  away_pitcher: string; score: number; my_pick: string;
  result: string | null; units: number;
}

// ─── MATH ─────────────────────────────────────────────────────
function poissonProb(lambda: number, k: number): number {
  let r = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) r *= lambda / i;
  return r;
}

function calcPoisson(homeLambda: number, awayLambda: number): PoissonResult {
  let hw = 0, aw = 0;
  const max = 15;
  for (let h = 0; h <= max; h++) {
    for (let a = 0; a <= max; a++) {
      const p = poissonProb(homeLambda, h) * poissonProb(awayLambda, a);
      if (h > a) hw += p; else if (a > h) aw += p; else { hw += p * 0.5; aw += p * 0.5; }
    }
  }
  const t = hw + aw;
  return { homeWinPct: Math.round((hw / t) * 100), awayWinPct: Math.round((aw / t) * 100) };
}

function poissonRandom(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function buildLambdas(
  homeBatting: TeamBatting | null, awayBatting: TeamBatting | null,
  homePitcher: PitcherStats | null, awayPitcher: PitcherStats | null,
  homeForm: RecentForm | null, awayForm: RecentForm | null,
  homeIsHome: boolean, homeIsStarter: boolean, awayIsStarter: boolean
): { homeLambda: number; awayLambda: number } {
  const leagueAvg = 4.5;
  let homeLambda = parseFloat(homeBatting?.runsPerGame ?? "0") || leagueAvg;
  let awayLambda = parseFloat(awayBatting?.runsPerGame ?? "0") || leagueAvg;

  // Apply relevant batting splits vs pitcher handedness
  if (awayPitcher && homeBatting) {
    const hand = awayPitcher.pitchHand;
    const splitOps = hand === "L" ? parseFloat(homeBatting.opsVsLeft) : parseFloat(homeBatting.opsVsRight);
    const baseOps = parseFloat(homeBatting.ops);
    if (!isNaN(splitOps) && !isNaN(baseOps) && baseOps > 0) {
      homeLambda *= (splitOps / baseOps);
    }
  }
  if (homePitcher && awayBatting) {
    const hand = homePitcher.pitchHand;
    const splitOps = hand === "L" ? parseFloat(awayBatting.opsVsLeft) : parseFloat(awayBatting.opsVsRight);
    const baseOps = parseFloat(awayBatting.ops);
    if (!isNaN(splitOps) && !isNaN(baseOps) && baseOps > 0) {
      awayLambda *= (splitOps / baseOps);
    }
  }

  // Pitcher ERA adjustment — use home/away splits
  if (awayPitcher && awayIsStarter) {
    const era = parseFloat(homeIsHome ? awayPitcher.awayEra : awayPitcher.homeEra) || parseFloat(awayPitcher.era);
    if (!isNaN(era) && era > 0) homeLambda = homeLambda * (era / leagueAvg) * 0.80 + homeLambda * 0.20;
  }
  if (homePitcher && homeIsStarter) {
    const era = parseFloat(homeIsHome ? homePitcher.homeEra : homePitcher.awayEra) || parseFloat(homePitcher.era);
    if (!isNaN(era) && era > 0) awayLambda = awayLambda * (era / leagueAvg) * 0.80 + awayLambda * 0.20;
  }

  // Recent form
  if (homeForm && homeIsStarter) {
    const re = parseFloat(homeForm.recentEra);
    if (!isNaN(re) && re > 0) awayLambda = awayLambda * (re / leagueAvg) * 0.15 + awayLambda * 0.85;
  }
  if (awayForm && awayIsStarter) {
    const re = parseFloat(awayForm.recentEra);
    if (!isNaN(re) && re > 0) homeLambda = homeLambda * (re / leagueAvg) * 0.15 + homeLambda * 0.85;
  }

  // Home field advantage — minimal
  homeLambda *= 1.02;

  return {
    homeLambda: Math.max(1.5, Math.min(9, homeLambda)),
    awayLambda: Math.max(1.5, Math.min(9, awayLambda))
  };
}

function runMonteCarlo(homeLambda: number, awayLambda: number): SimResult {
  let hw = 0, aw = 0, thr = 0, tar = 0;
  for (let i = 0; i < MC_RUNS; i++) {
    const h = poissonRandom(homeLambda);
    const a = poissonRandom(awayLambda);
    thr += h; tar += a;
    if (h > a) hw++; else if (a > h) aw++; else hw += 0.5;
  }
  return {
    homeWinPct: Math.round((hw / MC_RUNS) * 100),
    awayWinPct: Math.round((aw / MC_RUNS) * 100),
    avgHomeRuns: Math.round((thr / MC_RUNS) * 10) / 10,
    avgAwayRuns: Math.round((tar / MC_RUNS) * 10) / 10,
  };
}

// ─── API FETCHERS ──────────────────────────────────────────────
async function fetchPitcherStats(id: number): Promise<PitcherStats | null> {
  try {
    const [seasonRes, homeRes, awayRes, bioRes] = await Promise.all([
      fetch(`${MLB_API}/people/${id}/stats?stats=season&season=${SEASON}&group=pitching`),
      fetch(`${MLB_API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=pitching&sitCodes=h`),
      fetch(`${MLB_API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=pitching&sitCodes=a`),
      fetch(`${MLB_API}/people/${id}`),
    ]);
    const [sd, hd, ad, bd] = await Promise.all([seasonRes.json(), homeRes.json(), awayRes.json(), bioRes.json()]);
    const s = sd.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    const homeEra = hd.stats?.[0]?.splits?.[0]?.stat?.era ?? s.era;
    const awayEra = ad.stats?.[0]?.splits?.[0]?.stat?.era ?? s.era;
    const pitchHand = bd.people?.[0]?.pitchHand?.code ?? "R";
    return { era: s.era ?? "N/A", whip: s.whip ?? "N/A", strikeOuts: s.strikeOuts ?? "0", baseOnBalls: s.baseOnBalls ?? "0", inningsPitched: s.inningsPitched ?? "0", wins: s.wins ?? "0", losses: s.losses ?? "0", strikeoutsPer9: s.strikeoutsPer9Inn ?? "0", walksPer9: s.walksPer9Inn ?? "0", homeEra, awayEra, pitchHand };
  } catch { return null; }
}

async function fetchRecentForm(id: number): Promise<RecentForm | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${id}/stats?stats=gameLog&season=${SEASON}&group=pitching`);
    const data = await res.json();
    const last5 = (data.stats?.[0]?.splits ?? []).slice(-5);
    if (!last5.length) return null;
    let er = 0, ip = 0;
    for (const g of last5) { ip += parseFloat(g.stat.inningsPitched ?? "0"); er += parseFloat(g.stat.earnedRuns ?? "0"); }
    const recentEra = ip > 0 ? ((er * 9) / ip).toFixed(2) : "N/A";
    const n = parseFloat(recentEra);
    return { recentEra, trend: n < 3.0 ? "hot" : n > 5.0 ? "cold" : "neutral", lastStarts: last5.length };
  } catch { return null; }
}

async function fetchPitcherRole(id: number): Promise<PitcherRole | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${id}`);
    const data = await res.json();
    const pos = data.people?.[0]?.primaryPosition?.abbreviation ?? "P";
    return { isStarter: pos === "SP", position: pos };
  } catch { return null; }
}

async function fetchTeamBatting(teamId: number): Promise<TeamBatting | null> {
  try {
    const [seasonRes, vsLRes, vsRRes] = await Promise.all([
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&season=${SEASON}&group=hitting`),
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=vl`),
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=vr`),
    ]);
    const [sd, ld, rd] = await Promise.all([seasonRes.json(), vsLRes.json(), vsRRes.json()]);
    const s = sd.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    const games = parseFloat(s.gamesPlayed ?? "1");
    const runs = parseFloat(s.runs ?? "0");
    const opsVsLeft = ld.stats?.[0]?.splits?.[0]?.stat?.ops ?? s.ops;
    const opsVsRight = rd.stats?.[0]?.splits?.[0]?.stat?.ops ?? s.ops;
    return { avg: s.avg ?? ".000", ops: s.ops ?? ".000", obp: s.obp ?? ".000", slg: s.slg ?? ".000", runs: s.runs ?? "0", homeRuns: s.homeRuns ?? "0", runsPerGame: games > 0 ? (runs / games).toFixed(2) : "0.00", opsVsLeft, opsVsRight };
  } catch { return null; }
}

async function fetchBullpen(teamId: number, starterId?: number): Promise<BullpenStats | null> {
  try {
    const res = await fetch(`${MLB_API}/teams/${teamId}/roster?rosterType=active&season=${SEASON}`);
    const data = await res.json();
    const pitchers = (data.roster ?? []).filter((p: { person: { id: number }; position: { abbreviation: string } }) =>
      ["RP", "CL"].includes(p.position.abbreviation) && p.person.id !== starterId
    );
    if (!pitchers.length) return null;
    const stats = await Promise.all(pitchers.slice(0, 8).map(async (p: { person: { id: number } }) => {
      try {
        const r = await fetch(`${MLB_API}/people/${p.person.id}/stats?stats=season&season=${SEASON}&group=pitching`);
        const d = await r.json();
        return d.stats?.[0]?.splits?.[0]?.stat;
      } catch { return null; }
    }));
    const valid = stats.filter(Boolean);
    if (!valid.length) return null;
    let totalER = 0, totalIP = 0, totalBB = 0, totalH = 0;
    for (const s of valid) {
      const ip = parseFloat(s.inningsPitched ?? "0");
      totalER += parseFloat(s.earnedRuns ?? "0");
      totalIP += ip;
      totalBB += parseFloat(s.baseOnBalls ?? "0");
      totalH += parseFloat(s.hits ?? "0");
    }
    const era = totalIP > 0 ? ((totalER * 9) / totalIP).toFixed(2) : "N/A";
    const whip = totalIP > 0 ? ((totalBB + totalH) / totalIP).toFixed(2) : "N/A";
    return { era, whip, count: valid.length };
  } catch { return null; }
}

function calcScore(
  sim: SimResult | null, poisson: PoissonResult | null,
  hf: RecentForm | null, af: RecentForm | null,
  hb: TeamBatting | null, ab: TeamBatting | null,
  hp: PitcherStats | null, ap: PitcherStats | null,
  hBullpen: BullpenStats | null, aBullpen: BullpenStats | null,
  homeIsStarter: boolean, awayIsStarter: boolean
) {
  // MC 40% + Poisson 10% = 50% models
  const mcScore = sim ? sim.homeWinPct : 50;
  const poissonScore = poisson ? poisson.homeWinPct : 50;
  const modelScore = mcScore * 0.80 + poissonScore * 0.20;

  // Recent form 15%
  let formScore = 50;
  if (hf && homeIsStarter) formScore += hf.trend === "hot" ? 15 : hf.trend === "cold" ? -15 : 0;
  if (af && awayIsStarter) formScore -= af.trend === "hot" ? 15 : af.trend === "cold" ? -15 : 0;

  // OPS differential 10%
  let opsScore = 50;
  if (hb && ab) {
    const diff = (parseFloat(hb.ops) - parseFloat(ab.ops)) * 200;
    opsScore = Math.max(0, Math.min(100, 50 + (isNaN(diff) ? 0 : diff)));
  }

  // ERA differential 10%
  let eraScore = 50;
  if (hp && ap && homeIsStarter && awayIsStarter) {
    const diff = (parseFloat(ap.era) - parseFloat(hp.era)) * 8;
    eraScore = Math.max(0, Math.min(100, 50 + (isNaN(diff) ? 0 : diff)));
  }

  // Bullpen differential 15%
  let bullpenScore = 50;
  if (hBullpen && aBullpen) {
    const hEra = parseFloat(hBullpen.era);
    const aEra = parseFloat(aBullpen.era);
    if (!isNaN(hEra) && !isNaN(aEra)) {
      const diff = (aEra - hEra) * 6;
      bullpenScore = Math.max(0, Math.min(100, 50 + diff));
    }
  }

  const score = modelScore * 0.50 + formScore * 0.15 + opsScore * 0.10 + eraScore * 0.10 + bullpenScore * 0.15;
  const rounded = Math.round(Math.max(15, Math.min(85, score)));
  const rec = rounded >= 62 ? "✅ Local favorito" : rounded <= 38 ? "⚠️ Visitante ventaja" : "➡️ Partido parejo";
  return { score: rounded, rec };
}

function getRating(score: number) {
  if (score >= 68) return { color: "#00E096", label: "FUERTE", stars: 5 };
  if (score >= 60) return { color: "#7DF9A6", label: "BUENO", stars: 4 };
  if (score >= 45) return { color: "#FFD84D", label: "NEUTRO", stars: 3 };
  if (score >= 35) return { color: "#FF9F43", label: "DÉBIL", stars: 2 };
  return { color: "#FF6B6B", label: "EVITAR", stars: 1 };
}

function getTrend(form: RecentForm | null) {
  if (!form) return "";
  return form.trend === "hot" ? "🔥" : form.trend === "cold" ? "📉" : "➡️";
}

function Stars({ count, color }: { count: number; color: string }) {
  return (
    <span style={{ color, fontSize: 12 }}>
      {"★".repeat(count)}{"☆".repeat(5 - count)}
    </span>
  );
}

function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #1A2535", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", padding: "10px 14px", background: "#0D1520", border: "none", color: "#E8EDF5", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
        <span>{title}</span>
        <span style={{ color: "#4A6080", fontSize: 14 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "12px 14px", background: "#080C14" }}>{children}</div>}
    </div>
  );
}

// ─── DB ───────────────────────────────────────────────────────
async function dbGet(): Promise<Pick[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/picks?select=*&order=game_pk.desc`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: "application/json" } });
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
async function dbInsert(row: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/picks`, { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify(row) });
}
async function dbUpdate(gamePk: number, row: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/picks?game_pk=eq.${gamePk}`, { method: "PATCH", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(row) });
}

// ─── MAIN APP ─────────────────────────────────────────────────
export default function MLBApp() {
  const [games, setGames] = useState<GameAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GameAnalysis | null>(null);
  const [view, setView] = useState<"games" | "picks">("games");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [savingPick, setSavingPick] = useState(false);
  const [pickSaved, setPickSaved] = useState(false);

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().split("T")[0];
      const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${today}&hydrate=probablePitcher`);
      const data = await res.json();
      const gameList: Game[] = data.dates?.[0]?.games ?? [];

      const analyses: GameAnalysis[] = await Promise.all(gameList.map(async (game) => {
        const hpId = game.teams.home.probablePitcher?.id;
        const apId = game.teams.away.probablePitcher?.id;
        const [hp, ap, hb, ab, hf, af, hRole, aRole, hBullpen, aBullpen] = await Promise.all([
          hpId ? fetchPitcherStats(hpId) : null,
          apId ? fetchPitcherStats(apId) : null,
          fetchTeamBatting(game.teams.home.team.id),
          fetchTeamBatting(game.teams.away.team.id),
          hpId ? fetchRecentForm(hpId) : null,
          apId ? fetchRecentForm(apId) : null,
          hpId ? fetchPitcherRole(hpId) : null,
          apId ? fetchPitcherRole(apId) : null,
          fetchBullpen(game.teams.home.team.id, hpId),
          fetchBullpen(game.teams.away.team.id, apId),
        ]);

        const homeIsStarter = hRole?.isStarter ?? true;
        const awayIsStarter = aRole?.isStarter ?? true;
        const locked = ["Live", "Final"].includes(game.status.abstractGameState);

        const { homeLambda, awayLambda } = buildLambdas(hb, ab, hp, ap, hf, af, true, homeIsStarter, awayIsStarter);
        const poisson = calcPoisson(homeLambda, awayLambda);
        const simulation = runMonteCarlo(homeLambda, awayLambda);
        const { score, rec } = calcScore(simulation, poisson, hf, af, hb, ab, hp, ap, hBullpen, aBullpen, homeIsStarter, awayIsStarter);

        return {
          game,
          homePitcher: { name: game.teams.home.probablePitcher?.fullName ?? "Por confirmar", stats: hp, form: hf, role: hRole },
          awayPitcher: { name: game.teams.away.probablePitcher?.fullName ?? "Por confirmar", stats: ap, form: af, role: aRole },
          homeBatting: hb, awayBatting: ab,
          homeBullpen: hBullpen, awayBullpen: aBullpen,
          poisson, simulation,
          score, recommendation: rec, isLocked: locked
        };
      }));

      setGames(analyses.sort((a, b) => b.score - a.score));
      setLoading(false);
    }
    load();
    dbGet().then(setPicks);
  }, []);

  async function savePick(analysis: GameAnalysis, myPick: string) {
    setSavingPick(true);
    await dbInsert({ game_pk: analysis.game.gamePk, game_date: new Date().toISOString().split("T")[0], home_team: analysis.game.teams.home.team.name, away_team: analysis.game.teams.away.team.name, home_pitcher: analysis.homePitcher.name, away_pitcher: analysis.awayPitcher.name, score: analysis.score, my_pick: myPick, result: null, units: 1 });
    setSavingPick(false); setPickSaved(true);
    dbGet().then(setPicks);
    setTimeout(() => setPickSaved(false), 2000);
  }

  async function markResult(gamePk: number, result: "W" | "L") {
    await dbUpdate(gamePk, { result });
    dbGet().then(setPicks);
  }

  const wins = picks.filter(p => p.result === "W").length;
  const losses = picks.filter(p => p.result === "L").length;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const strongPicks = games.filter(g => g.simulation && Math.max(g.simulation.homeWinPct, g.simulation.awayWinPct) >= 85 && !g.isLocked).length;
  const today = new Date().toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div style={{ minHeight: "100vh", background: "#080C14", color: "#E8EDF5", fontFamily: "'DM Mono', 'Courier New', monospace" }}>
      {/* HEADER */}
      <div style={{ background: "#0A0F1A", borderBottom: "1px solid #1A2535", padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: "linear-gradient(135deg, #C8102E, #002D72)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚾</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.06em" }}>MLB STATS</div>
              <div style={{ fontSize: 9, color: "#4A6080", letterSpacing: "0.12em" }}>ANÁLISIS • {SEASON} • V4</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: strongPicks > 0 ? "#00E096" : "#4A6080", fontWeight: strongPicks > 0 ? 700 : 400 }}>
              {strongPicks > 0 ? `⭐ ${strongPicks} picks fuertes` : "Sin picks fuertes hoy"}
            </div>
            <div style={{ fontSize: 11, color: "#4A6080", marginTop: 2 }}>{wins}W {losses}L {winRate > 0 ? `· ${winRate}%` : ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {(["games", "picks"] as const).map(t => (
            <button key={t} onClick={() => { setView(t); setSelected(null); }}
              style={{ flex: 1, padding: "7px", borderRadius: 8, border: `1px solid ${view === t ? "#00E096" : "#1A2535"}`, background: view === t ? "#00E09615" : "transparent", color: view === t ? "#00E096" : "#4A6080", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {t === "games" ? `🎮 Juegos (${games.length})` : `📊 Mis picks (${picks.length})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "55vh", gap: 14 }}>
          <div style={{ width: 40, height: 40, border: "3px solid #1A2535", borderTopColor: "#00E096", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: "#4A6080", fontSize: 11, letterSpacing: "0.1em" }}>CARGANDO ANÁLISIS COMPLETO...</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      ) : view === "picks" ? (
        <PicksView picks={picks} onMarkResult={markResult} wins={wins} losses={losses} winRate={winRate} />
      ) : selected ? (
        <DetailView analysis={selected} onBack={() => setSelected(null)} onSavePick={savePick} savingPick={savingPick} pickSaved={pickSaved} picks={picks} />
      ) : (
        <div style={{ padding: "14px 18px" }}>
          <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.12em", marginBottom: 10 }}>PICKS DEL DÍA — {today.toUpperCase()}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {games.map((a, i) => <GameCard key={a.game.gamePk} analysis={a} rank={i + 1} onClick={() => setSelected(a)} picks={picks} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GAME CARD ────────────────────────────────────────────────
function GameCard({ analysis, rank, onClick, picks }: { analysis: GameAnalysis; rank: number; onClick: () => void; picks: Pick[] }) {
  const { game, homePitcher, awayPitcher, score, recommendation, simulation, poisson, isLocked } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const alreadyPicked = picks.some(p => p.game_pk === game.gamePk);
  const mcPct = simulation ? Math.max(simulation.homeWinPct, simulation.awayWinPct) : 0;
  const isStrong = mcPct >= 85 && !isLocked;
  const mcFavorsHome = simulation ? simulation.homeWinPct >= simulation.awayWinPct : true;
  const poissonFavorsHome = poisson ? poisson.homeWinPct >= poisson.awayWinPct : true;
  const consensus = mcFavorsHome === poissonFavorsHome;

  return (
    <div onClick={onClick} style={{ background: "#0D1520", border: `1px solid ${isStrong ? rating.color + "50" : "#1A2535"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", position: "relative", overflow: "hidden", opacity: isLocked ? 0.65 : 1, transition: "border-color 0.15s" }}>
      {isStrong && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${rating.color}, transparent)` }} />}

      {/* Top row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 10, color: "#4A6080", minWidth: 24 }}>#{rank}</div>
          <div style={{ fontSize: 11, color: isLocked ? "#FF6B6B" : "#4A6080" }}>{isLocked ? "🔒 En curso" : `${time} CT`}</div>
          {alreadyPicked && <div style={{ fontSize: 10, color: "#00E096", background: "#00E09615", borderRadius: 4, padding: "1px 5px" }}>✓</div>}
          {isStrong && <div style={{ fontSize: 10, color: "#00E096", background: "#00E09615", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>⭐</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Stars count={rating.stars} color={rating.color} />
          <div style={{ fontSize: 13, fontWeight: 700, color: rating.color }}>{score}</div>
        </div>
      </div>

      {/* Teams */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.away.team.name}</div>
          <div style={{ fontSize: 10, color: "#4A6080", display: "flex", alignItems: "center", gap: 4 }}>
            <span>🔴</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{awayPitcher.name}</span>
            <span>{getTrend(awayPitcher.form)}</span>
            {awayPitcher.role && !awayPitcher.role.isStarter && <span style={{ color: "#FF9F43", fontSize: 9 }}>RP</span>}
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#2A3545", flexShrink: 0 }}>VS</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.home.team.name}</div>
          <div style={{ fontSize: 10, color: "#4A6080", display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
            {homePitcher.role && !homePitcher.role.isStarter && <span style={{ color: "#FF9F43", fontSize: 9 }}>RP</span>}
            <span>{getTrend(homePitcher.form)}</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{homePitcher.name}</span>
            <span>🏠</span>
          </div>
        </div>
      </div>

      {/* Bottom row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 6, borderTop: "1px solid #1A2535" }}>
        <div style={{ fontSize: 11, color: rating.color }}>{recommendation}</div>
        <div style={{ display: "flex", gap: 8, fontSize: 10, color: "#4A6080" }}>
          {simulation && <span>MC <strong style={{ color: "#7A9CC0" }}>{simulation.homeWinPct}%</strong></span>}
          {poisson && <span>P <strong style={{ color: consensus ? "#7A9CC0" : "#FFD84D" }}>{poisson.homeWinPct}%</strong></span>}
        </div>
      </div>
    </div>
  );
}

// ─── DETAIL VIEW ──────────────────────────────────────────────
function DetailView({ analysis, onBack, onSavePick, savingPick, pickSaved, picks }: {
  analysis: GameAnalysis; onBack: () => void;
  onSavePick: (a: GameAnalysis, pick: string) => void;
  savingPick: boolean; pickSaved: boolean; picks: Pick[];
}) {
  const { game, homePitcher, awayPitcher, homeBatting, awayBatting, homeBullpen, awayBullpen, poisson, simulation, score, recommendation, isLocked } = analysis;
  const rating = getRating(score);
  const alreadyPicked = picks.find(p => p.game_pk === game.gamePk);
  const mcFavorsHome = simulation ? simulation.homeWinPct >= simulation.awayWinPct : true;
  const poissonFavorsHome = poisson ? poisson.homeWinPct >= poisson.awayWinPct : true;
  const consensus = mcFavorsHome === poissonFavorsHome;
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const isStrong = simulation && Math.max(simulation.homeWinPct, simulation.awayWinPct) >= 85 && !isLocked;

  return (
    <div style={{ padding: "14px 18px" }}>
      <button onClick={onBack} style={{ background: "none", border: "1px solid #1A2535", borderRadius: 8, color: "#7A9CC0", padding: "6px 12px", cursor: "pointer", fontSize: 11, marginBottom: 14, fontFamily: "inherit" }}>← Volver</button>

      {/* Score banner */}
      <div style={{ background: `linear-gradient(135deg, ${rating.color}12, #0D1520)`, border: `1px solid ${rating.color}40`, borderRadius: 12, padding: "18px", marginBottom: 12, textAlign: "center" }}>
        <Stars count={rating.stars} color={rating.color} />
        <div style={{ fontSize: 48, fontWeight: 700, color: rating.color, lineHeight: 1.1, marginTop: 4 }}>{score}{isLocked ? " 🔒" : ""}</div>
        <div style={{ fontSize: 14, color: rating.color, fontWeight: 600, marginTop: 6 }}>{recommendation}</div>
        <div style={{ fontSize: 10, color: "#4A6080", marginTop: 6 }}>
          {isLocked ? "🔴 JUEGO EN CURSO — score bloqueado" : `${time} CT · ${game.venue?.name}`}
        </div>
        {isStrong && <div style={{ marginTop: 8, fontSize: 11, color: "#00E096", fontWeight: 700, letterSpacing: "0.08em" }}>⭐ PICK RECOMENDADO</div>}
        {!consensus && <div style={{ marginTop: 6, fontSize: 10, color: "#FFD84D" }}>⚠️ Poisson y Monte Carlo no coinciden — señal mixta</div>}
      </div>

      {/* Pick buttons */}
      {!isLocked && (
        alreadyPicked ? (
          <div style={{ background: "#00E09615", border: "1px solid #00E09640", borderRadius: 10, padding: "10px", marginBottom: 12, textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "#00E096" }}>✓ Pick: <strong>{alreadyPicked.my_pick}</strong></div>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 8 }}>REGISTRAR PICK</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button onClick={() => onSavePick(analysis, game.teams.home.team.name)} disabled={savingPick}
                style={{ padding: "10px", borderRadius: 8, border: "1px solid #00E09640", background: "#00E09610", color: "#00E096", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>
                🏠 {game.teams.home.team.name}
              </button>
              <button onClick={() => onSavePick(analysis, game.teams.away.team.name)} disabled={savingPick}
                style={{ padding: "10px", borderRadius: 8, border: "1px solid #1A2535", background: "#1A2535", color: "#7A9CC0", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>
                🔴 {game.teams.away.team.name}
              </button>
            </div>
            {pickSaved && <div style={{ textAlign: "center", color: "#00E096", fontSize: 11, marginTop: 6 }}>✓ Pick guardado</div>}
          </div>
        )
      )}

      {/* Modelos */}
      <Accordion title="🎲 Modelos predictivos" defaultOpen={true}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          {[
            { label: "MONTE CARLO", sub: `${MC_RUNS.toLocaleString()} simulaciones`, h: simulation?.homeWinPct ?? 50, a: simulation?.awayWinPct ?? 50, hr: simulation?.avgHomeRuns, ar: simulation?.avgAwayRuns },
            { label: "POISSON", sub: "Distribución directa", h: poisson?.homeWinPct ?? 50, a: poisson?.awayWinPct ?? 50 }
          ].map(m => (
            <div key={m.label} style={{ background: "#0D1520", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 6 }}>{m.label}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#4A6080" }}>LOCAL</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: m.h >= m.a ? "#00E096" : "#7A9CC0" }}>{m.h}%</div>
                  {m.hr && <div style={{ fontSize: 9, color: "#4A6080" }}>~{m.hr} c</div>}
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#4A6080" }}>VISIT.</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: m.a > m.h ? "#FF9F43" : "#7A9CC0" }}>{m.a}%</div>
                  {m.ar && <div style={{ fontSize: 9, color: "#4A6080" }}>~{m.ar} c</div>}
                </div>
              </div>
              <div style={{ fontSize: 9, color: "#4A6080", textAlign: "center", marginTop: 4 }}>{m.sub}</div>
            </div>
          ))}
        </div>
        {!consensus && (
          <div style={{ background: "#FFD84D15", border: "1px solid #FFD84D40", borderRadius: 6, padding: "6px 10px", fontSize: 10, color: "#FFD84D" }}>
            ⚠️ Los modelos no coinciden — considera no apostar en este juego
          </div>
        )}
      </Accordion>

      {/* Pitchers */}
      <Accordion title="⚾ Análisis de pitchers">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { label: "VISITANTE", pitcher: awayPitcher, teamName: game.teams.away.team.name, emoji: "🔴" },
            { label: "LOCAL", pitcher: homePitcher, teamName: game.teams.home.team.name, emoji: "🏠" }
          ].map(({ label, pitcher, teamName, emoji }) => (
            <div key={label}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
              <div style={{ fontSize: 10, color: "#7A9CC0", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{emoji} {pitcher.name}</div>
              {pitcher.role && (
                <div style={{ marginBottom: 6, fontSize: 9, fontWeight: 700, color: pitcher.role.isStarter ? "#00E096" : "#FF9F43" }}>
                  {pitcher.role.isStarter ? "✅ ABRIDOR" : "⚠️ RELEVISTA"}
                </div>
              )}
              {pitcher.form && (
                <div style={{ marginBottom: 6, padding: "5px 8px", borderRadius: 6, background: pitcher.form.trend === "hot" ? "#00E09615" : pitcher.form.trend === "cold" ? "#FF6B6B15" : "#1A2535", fontSize: 11, fontWeight: 700, color: pitcher.form.trend === "hot" ? "#00E096" : pitcher.form.trend === "cold" ? "#FF6B6B" : "#FFD84D" }}>
                  Últ.{pitcher.form.lastStarts}: ERA {pitcher.form.recentEra} {getTrend(pitcher.form)}
                </div>
              )}
              {pitcher.stats && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  {[["ERA", pitcher.stats.era], ["WHIP", pitcher.stats.whip], ["Casa", pitcher.stats.homeEra], ["Visit.", pitcher.stats.awayEra], ["K/9", pitcher.stats.strikeoutsPer9], ["BB/9", pitcher.stats.walksPer9]].map(([l, v]) => (
                    <div key={l} style={{ background: "#0D1520", borderRadius: 6, padding: "5px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 8, color: "#4A6080" }}>{l}</div>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{v}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Accordion>

      {/* Ofensiva + Splits */}
      <Accordion title="🏏 Ofensiva y splits">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { label: "VISITANTE", batting: awayBatting, vsHand: homePitcher.stats?.pitchHand },
            { label: "LOCAL", batting: homeBatting, vsHand: awayPitcher.stats?.pitchHand }
          ].map(({ label, batting, vsHand }) => (
            <div key={label}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 8 }}>{label}</div>
              {batting ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 6 }}>
                    {[["AVG", batting.avg], ["OBP", batting.obp], ["SLG", batting.slg], ["OPS", batting.ops], ["R/G", batting.runsPerGame], ["HR", batting.homeRuns]].map(([l, v]) => (
                      <div key={l} style={{ background: "#0D1520", borderRadius: 6, padding: "5px 6px", textAlign: "center" }}>
                        <div style={{ fontSize: 8, color: "#4A6080" }}>{l}</div>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {vsHand && (
                    <div style={{ background: "#0D1520", borderRadius: 6, padding: "8px" }}>
                      <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4 }}>vs PITCHER {vsHand === "L" ? "ZURDO" : "DIESTRO"}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 8, color: "#4A6080" }}>OPS vs Z</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: vsHand === "L" ? "#FFD84D" : "#7A9CC0" }}>{batting.opsVsLeft}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 8, color: "#4A6080" }}>OPS vs D</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: vsHand === "R" ? "#FFD84D" : "#7A9CC0" }}>{batting.opsVsRight}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : <div style={{ fontSize: 11, color: "#4A6080" }}>Sin datos</div>}
            </div>
          ))}
        </div>
      </Accordion>

      {/* Bullpen */}
      <Accordion title="💪 Bullpen">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { label: "VISITANTE", bullpen: awayBullpen },
            { label: "LOCAL", bullpen: homeBullpen }
          ].map(({ label, bullpen }) => (
            <div key={label} style={{ background: "#0D1520", borderRadius: 8, padding: 10 }}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 8 }}>{label}</div>
              {bullpen ? (
                <>
                  <div style={{ textAlign: "center", marginBottom: 6 }}>
                    <div style={{ fontSize: 9, color: "#4A6080" }}>ERA BULLPEN</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: parseFloat(bullpen.era) < 3.5 ? "#00E096" : parseFloat(bullpen.era) > 4.5 ? "#FF6B6B" : "#FFD84D" }}>{bullpen.era}</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                    <div style={{ background: "#080C14", borderRadius: 6, padding: "5px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 8, color: "#4A6080" }}>WHIP</div>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{bullpen.whip}</div>
                    </div>
                    <div style={{ background: "#080C14", borderRadius: 6, padding: "5px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 8, color: "#4A6080" }}>PITCHERS</div>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{bullpen.count}</div>
                    </div>
                  </div>
                </>
              ) : <div style={{ fontSize: 11, color: "#4A6080" }}>Sin datos</div>}
            </div>
          ))}
        </div>
      </Accordion>
    </div>
  );
}

// ─── PICKS VIEW ───────────────────────────────────────────────
function PicksView({ picks, onMarkResult, wins, losses, winRate }: { picks: Pick[]; onMarkResult: (gk: number, r: "W" | "L") => void; wins: number; losses: number; winRate: number }) {
  return (
    <div style={{ padding: "14px 18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[["GANADOS", wins, "#00E096"], ["PERDIDOS", losses, "#FF6B6B"], ["WIN RATE", `${winRate}%`, "#FFD84D"]].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0D1520", border: `1px solid ${c}25`, borderRadius: 10, padding: "10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#4A6080", letterSpacing: "0.1em" }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c as string, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>
      {picks.length === 0 ? (
        <div style={{ textAlign: "center", color: "#4A6080", marginTop: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
          <div style={{ fontSize: 13 }}>No hay picks registrados</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>Abre un juego y registra tu primera apuesta</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {picks.map(pick => {
            const rating = getRating(pick.score);
            return (
              <div key={pick.game_pk} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <div style={{ fontSize: 10, color: "#4A6080" }}>{pick.game_date}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Stars count={rating.stars} color={rating.color} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: rating.color }}>{pick.score}</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{pick.away_team} @ {pick.home_team}</div>
                <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 8 }}>Pick: <strong style={{ color: "#E8EDF5" }}>{pick.my_pick}</strong></div>
                {pick.result ? (
                  <div style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: pick.result === "W" ? "#00E09620" : "#FF6B6B20", color: pick.result === "W" ? "#00E096" : "#FF6B6B", border: `1px solid ${pick.result === "W" ? "#00E09640" : "#FF6B6B40"}` }}>
                    {pick.result === "W" ? "✓ GANADO" : "✗ PERDIDO"}
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => onMarkResult(pick.game_pk, "W")} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #00E09640", background: "#00E09615", color: "#00E096", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>✓ GANADO</button>
                    <button onClick={() => onMarkResult(pick.game_pk, "L")} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #FF6B6B40", background: "#FF6B6B15", color: "#FF6B6B", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>✗ PERDIDO</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
