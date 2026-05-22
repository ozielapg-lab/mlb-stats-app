"use client";
import { useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const MLB_API = "https://statsapi.mlb.com/api/v1";
const SEASON = "2026";
const MC_RUNS = 10000;
const MIN_AVG_IP = 3.5; // Minimum avg innings per outing to be considered SP

// ─── INTERFACES ───────────────────────────────────────────────
interface Game {
  gamePk: number;
  gameDate: string;
  status: { abstractGameState: string };
  teams: {
    away: { team: { id: number; name: string }; probablePitcher?: { id: number; fullName: string } };
    home: { team: { id: number; name: string }; probablePitcher?: { id: number; fullName: string } };
  };
  venue: { name: string };
}

interface PitcherProfile {
  era: string;
  homeEra: string;
  awayEra: string;
  medianRecentEra: string;
  recentTrend: "hot" | "cold" | "neutral";
  lastOutings: number;
  isStarter: boolean;
  pitchHand: string;
  wins: string;
  losses: string;
  ip: string;
}

interface TeamOffense {
  runsPerGame: string;
  ops: string;
  opsVsLeft: string;
  opsVsRight: string;
}

interface SimResult {
  homeWinPct: number;
  awayWinPct: number;
  avgHomeRuns: number;
  avgAwayRuns: number;
}

interface GameAnalysis {
  game: Game;
  homePitcher: { name: string; profile: PitcherProfile | null };
  awayPitcher: { name: string; profile: PitcherProfile | null };
  homeOffense: TeamOffense | null;
  awayOffense: TeamOffense | null;
  simulation: SimResult | null;
  confidence: "strong" | "moderate" | "weak" | "none";
  isLocked: boolean;
}

interface Pick {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  home_pitcher: string;
  away_pitcher: string;
  mc_home: number;
  mc_away: number;
  my_pick: string;
  result: string | null;
}

// ─── POISSON ──────────────────────────────────────────────────
function poissonRandom(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function runMC(homeLambda: number, awayLambda: number): SimResult {
  let hw = 0, aw = 0, thr = 0, tar = 0;
  for (let i = 0; i < MC_RUNS; i++) {
    const h = poissonRandom(homeLambda);
    const a = poissonRandom(awayLambda);
    thr += h; tar += a;
    if (h > a) hw++;
    else if (a > h) aw++;
    else hw += 0.5;
  }
  return {
    homeWinPct: Math.round((hw / MC_RUNS) * 100),
    awayWinPct: Math.round((aw / MC_RUNS) * 100),
    avgHomeRuns: Math.round((thr / MC_RUNS) * 10) / 10,
    avgAwayRuns: Math.round((tar / MC_RUNS) * 10) / 10,
  };
}

// ─── LAMBDAS ──────────────────────────────────────────────────
function buildLambdas(
  homeOffense: TeamOffense | null,
  awayOffense: TeamOffense | null,
  homePitcher: PitcherProfile | null,
  awayPitcher: PitcherProfile | null,
): { homeLambda: number; awayLambda: number } {
  const leagueAvg = 4.5;
  let homeLambda = parseFloat(homeOffense?.runsPerGame ?? "0") || leagueAvg;
  let awayLambda = parseFloat(awayOffense?.runsPerGame ?? "0") || leagueAvg;

  // Adjust home offense by away pitcher — use home ERA (pitching at home)
  if (awayPitcher && awayPitcher.isStarter) {
    const era = parseFloat(awayPitcher.awayEra) || parseFloat(awayPitcher.era);
    const recentEra = parseFloat(awayPitcher.medianRecentEra);
    // Blend season ERA (40%) with recent median ERA (60%)
    const blendedEra = !isNaN(recentEra) ? era * 0.40 + recentEra * 0.60 : era;
    if (!isNaN(blendedEra) && blendedEra > 0) {
      homeLambda = homeLambda * (blendedEra / leagueAvg) * 0.85 + homeLambda * 0.15;
    }
    // Apply L/R splits if available
    if (awayOffense && homeOffense) {
      const hand = awayPitcher.pitchHand;
      const splitOps = hand === "L"
        ? parseFloat(homeOffense.opsVsLeft)
        : parseFloat(homeOffense.opsVsRight);
      const baseOps = parseFloat(homeOffense.ops);
      if (!isNaN(splitOps) && !isNaN(baseOps) && baseOps > 0) {
        homeLambda *= (splitOps / baseOps);
      }
    }
  }

  // Adjust away offense by home pitcher — use away ERA (pitching at home)
  if (homePitcher && homePitcher.isStarter) {
    const era = parseFloat(homePitcher.homeEra) || parseFloat(homePitcher.era);
    const recentEra = parseFloat(homePitcher.medianRecentEra);
    const blendedEra = !isNaN(recentEra) ? era * 0.40 + recentEra * 0.60 : era;
    if (!isNaN(blendedEra) && blendedEra > 0) {
      awayLambda = awayLambda * (blendedEra / leagueAvg) * 0.85 + awayLambda * 0.15;
    }
    if (awayOffense && homePitcher) {
      const hand = homePitcher.pitchHand;
      const splitOps = hand === "L"
        ? parseFloat(awayOffense.opsVsLeft)
        : parseFloat(awayOffense.opsVsRight);
      const baseOps = parseFloat(awayOffense.ops);
      if (!isNaN(splitOps) && !isNaN(baseOps) && baseOps > 0) {
        awayLambda *= (splitOps / baseOps);
      }
    }
  }

  // NO home field advantage — let data decide
  return {
    homeLambda: Math.max(1.5, Math.min(9, homeLambda)),
    awayLambda: Math.max(1.5, Math.min(9, awayLambda)),
  };
}

// ─── FETCHERS ─────────────────────────────────────────────────
async function fetchPitcherProfile(id: number): Promise<PitcherProfile | null> {
  try {
    const [seasonRes, homeRes, awayRes, logRes, bioRes] = await Promise.all([
      fetch(`${MLB_API}/people/${id}/stats?stats=season&season=${SEASON}&group=pitching`),
      fetch(`${MLB_API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=pitching&sitCodes=h`),
      fetch(`${MLB_API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=pitching&sitCodes=a`),
      fetch(`${MLB_API}/people/${id}/stats?stats=gameLog&season=${SEASON}&group=pitching`),
      fetch(`${MLB_API}/people/${id}`),
    ]);
    const [sd, hd, ad, ld, bd] = await Promise.all([
      seasonRes.json(), homeRes.json(), awayRes.json(), logRes.json(), bioRes.json()
    ]);

    const s = sd.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;

    // Detect SP by average innings per outing
    const totalIP = parseFloat(s.inningsPitched ?? "0");
    const games = parseFloat(s.gamesStarted ?? s.gamesPitched ?? "1");
    const avgIP = games > 0 ? totalIP / games : 0;
    const isStarter = avgIP >= MIN_AVG_IP;

    // Recent outings — last 7, use median to avoid outlier bias
    const allOutings = ld.stats?.[0]?.splits ?? [];
    const last7 = allOutings.slice(-7);
    const individualERAs: number[] = last7
      .map((g: { stat: { inningsPitched?: string; earnedRuns?: string } }) => {
        const ip = parseFloat(g.stat.inningsPitched ?? "0");
        const er = parseFloat(g.stat.earnedRuns ?? "0");
        return ip > 0 ? (er * 9) / ip : null;
      })
      .filter((e: number | null): e is number => e !== null)
      .sort((a: number, b: number) => a - b);

    // Median ERA
    let medianRecentEra = "N/A";
    if (individualERAs.length > 0) {
      const mid = Math.floor(individualERAs.length / 2);
      const median = individualERAs.length % 2 !== 0
        ? individualERAs[mid]
        : (individualERAs[mid - 1] + individualERAs[mid]) / 2;
      medianRecentEra = median.toFixed(2);
    }

    const medianNum = parseFloat(medianRecentEra);
    const seasonEra = parseFloat(s.era ?? "4.5");
    const recentTrend = isNaN(medianNum) ? "neutral"
      : medianNum < seasonEra * 0.85 ? "hot"
      : medianNum > seasonEra * 1.20 ? "cold"
      : "neutral";

    return {
      era: s.era ?? "N/A",
      homeEra: hd.stats?.[0]?.splits?.[0]?.stat?.era ?? s.era ?? "N/A",
      awayEra: ad.stats?.[0]?.splits?.[0]?.stat?.era ?? s.era ?? "N/A",
      medianRecentEra,
      recentTrend,
      lastOutings: last7.length,
      isStarter,
      pitchHand: bd.people?.[0]?.pitchHand?.code ?? "R",
      wins: s.wins ?? "0",
      losses: s.losses ?? "0",
      ip: s.inningsPitched ?? "0",
    };
  } catch { return null; }
}

async function fetchTeamOffense(teamId: number): Promise<TeamOffense | null> {
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
    return {
      runsPerGame: games > 0 ? (runs / games).toFixed(2) : "0.00",
      ops: s.ops ?? ".000",
      opsVsLeft: ld.stats?.[0]?.splits?.[0]?.stat?.ops ?? s.ops ?? ".000",
      opsVsRight: rd.stats?.[0]?.splits?.[0]?.stat?.ops ?? s.ops ?? ".000",
    };
  } catch { return null; }
}

function getConfidence(sim: SimResult | null, homeSP: boolean, awaySP: boolean): "strong" | "moderate" | "weak" | "none" {
  if (!sim) return "none";
  const max = Math.max(sim.homeWinPct, sim.awayWinPct);
  if (!homeSP || !awaySP) return max >= 75 ? "moderate" : "weak";
  if (max >= 80) return "strong";
  if (max >= 70) return "moderate";
  if (max >= 60) return "weak";
  return "none";
}

// ─── DB ───────────────────────────────────────────────────────
async function dbGet(): Promise<Pick[]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/picks?select=*&order=game_pk.desc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: "application/json" }
    });
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function dbInsert(row: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/picks`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row)
  });
}

async function dbUpdate(gamePk: number, row: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/picks?game_pk=eq.${gamePk}`, {
    method: "PATCH",
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(row)
  });
}

// ─── COMPONENTS ───────────────────────────────────────────────
function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #1A2535", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", padding: "10px 14px", background: "#0D1520", border: "none", color: "#E8EDF5", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
        <span>{title}</span>
        <span style={{ color: "#4A6080" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "12px 14px", background: "#080C14" }}>{children}</div>}
    </div>
  );
}

function StatBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ background: "#0D1520", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
      <div style={{ fontSize: 8, color: "#4A6080", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: highlight ? "#00E096" : "#E8EDF5" }}>{value}</div>
    </div>
  );
}

function TrendBadge({ trend }: { trend: "hot" | "cold" | "neutral" }) {
  const config = {
    hot: { color: "#00E096", bg: "#00E09615", border: "#00E09640", label: "🔥 EN FORMA" },
    cold: { color: "#FF6B6B", bg: "#FF6B6B15", border: "#FF6B6B40", label: "📉 FRÍO" },
    neutral: { color: "#FFD84D", bg: "#FFD84D15", border: "#FFD84D40", label: "➡️ ESTABLE" },
  }[trend];
  return (
    <span style={{ fontSize: 9, fontWeight: 700, color: config.color, background: config.bg, border: `1px solid ${config.border}`, borderRadius: 4, padding: "2px 6px" }}>
      {config.label}
    </span>
  );
}

function MCBar({ pct, label, color }: { pct: number; label: string; color: string }) {
  return (
    <div style={{ flex: 1, textAlign: "center" }}>
      <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color, lineHeight: 1 }}>{pct}%</div>
      <div style={{ height: 4, background: "#1A2535", borderRadius: 2, marginTop: 6, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.5s" }} />
      </div>
    </div>
  );
}

// ─── MAIN ─────────────────────────────────────────────────────
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

        const [hp, ap, ho, ao] = await Promise.all([
          hpId ? fetchPitcherProfile(hpId) : null,
          apId ? fetchPitcherProfile(apId) : null,
          fetchTeamOffense(game.teams.home.team.id),
          fetchTeamOffense(game.teams.away.team.id),
        ]);

        const locked = ["Live", "Final"].includes(game.status.abstractGameState);
        const { homeLambda, awayLambda } = buildLambdas(ho, ao, hp, ap);
        const sim = runMC(homeLambda, awayLambda);
        const confidence = getConfidence(sim, hp?.isStarter ?? false, ap?.isStarter ?? false);

        return {
          game,
          homePitcher: { name: game.teams.home.probablePitcher?.fullName ?? "Por confirmar", profile: hp },
          awayPitcher: { name: game.teams.away.probablePitcher?.fullName ?? "Por confirmar", profile: ap },
          homeOffense: ho, awayOffense: ao,
          simulation: sim, confidence, isLocked: locked,
        };
      }));

      setGames(analyses.sort((a, b) => {
        const aMax = a.simulation ? Math.max(a.simulation.homeWinPct, a.simulation.awayWinPct) : 0;
        const bMax = b.simulation ? Math.max(b.simulation.homeWinPct, b.simulation.awayWinPct) : 0;
        return bMax - aMax;
      }));
      setLoading(false);
    }
    load();
    dbGet().then(setPicks);
  }, []);

  async function savePick(analysis: GameAnalysis, myPick: string) {
    setSavingPick(true);
    await dbInsert({
      game_pk: analysis.game.gamePk,
      game_date: new Date().toISOString().split("T")[0],
      home_team: analysis.game.teams.home.team.name,
      away_team: analysis.game.teams.away.team.name,
      home_pitcher: analysis.homePitcher.name,
      away_pitcher: analysis.awayPitcher.name,
      mc_home: analysis.simulation?.homeWinPct ?? 0,
      mc_away: analysis.simulation?.awayWinPct ?? 0,
      my_pick: myPick,
      result: null,
    });
    setSavingPick(false);
    setPickSaved(true);
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
  const strongToday = games.filter(g => g.confidence === "strong" && !g.isLocked).length;
  const today = new Date().toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div style={{ minHeight: "100vh", background: "#080C14", color: "#E8EDF5", fontFamily: "'DM Mono', 'Courier New', monospace" }}>
      {/* HEADER */}
      <div style={{ background: "#0A0F1A", borderBottom: "1px solid #1A2535", padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, #C8102E, #002D72)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚾</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.06em" }}>MLB STATS</div>
              <div style={{ fontSize: 9, color: "#4A6080", letterSpacing: "0.12em" }}>ANÁLISIS • {SEASON} • V5</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {strongToday > 0
              ? <div style={{ fontSize: 12, color: "#00E096", fontWeight: 700 }}>⭐ {strongToday} pick{strongToday > 1 ? "s" : ""} fuerte{strongToday > 1 ? "s" : ""}</div>
              : <div style={{ fontSize: 11, color: "#4A6080" }}>Sin picks fuertes hoy</div>
            }
            <div style={{ fontSize: 11, color: "#4A6080", marginTop: 2 }}>{wins}W {losses}L{winRate > 0 ? ` · ${winRate}%` : ""}</div>
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
          <div style={{ color: "#4A6080", fontSize: 11, letterSpacing: "0.1em" }}>ANALIZANDO JUEGOS...</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      ) : view === "picks" ? (
        <PicksView picks={picks} onMarkResult={markResult} wins={wins} losses={losses} winRate={winRate} />
      ) : selected ? (
        <DetailView analysis={selected} onBack={() => setSelected(null)} onSavePick={savePick} savingPick={savingPick} pickSaved={pickSaved} picks={picks} />
      ) : (
        <div style={{ padding: "14px 18px" }}>
          <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.12em", marginBottom: 10 }}>
            {today.toUpperCase()}
          </div>
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
  const { game, homePitcher, awayPitcher, simulation, confidence, isLocked } = analysis;
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const alreadyPicked = picks.some(p => p.game_pk === game.gamePk);
  const isStrong = confidence === "strong" && !isLocked;

  const favorsHome = simulation ? simulation.homeWinPct >= simulation.awayWinPct : true;
  const favPct = simulation ? Math.max(simulation.homeWinPct, simulation.awayWinPct) : 50;
  const favTeam = favorsHome ? game.teams.home.team.name : game.teams.away.team.name;
  const favColor = isStrong ? "#00E096" : confidence === "moderate" ? "#FFD84D" : "#4A6080";

  const confConfig = {
    strong: { color: "#00E096", label: "FUERTE", border: "#00E09640" },
    moderate: { color: "#FFD84D", label: "MODERADO", border: "#FFD84D40" },
    weak: { color: "#4A6080", label: "DÉBIL", border: "#1A2535" },
    none: { color: "#2A3545", label: "PAREJO", border: "#1A2535" },
  }[confidence];

  return (
    <div onClick={onClick} style={{ background: "#0D1520", border: `1px solid ${isStrong ? "#00E09650" : "#1A2535"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", position: "relative", overflow: "hidden", opacity: isLocked ? 0.6 : 1 }}>
      {isStrong && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, #00E096, transparent)" }} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "#2A3545" }}>#{rank}</span>
          <span style={{ fontSize: 11, color: isLocked ? "#FF6B6B" : "#4A6080" }}>{isLocked ? "🔒 En curso" : `${time} CT`}</span>
          {alreadyPicked && <span style={{ fontSize: 10, color: "#00E096", background: "#00E09615", borderRadius: 4, padding: "1px 5px" }}>✓</span>}
          {isStrong && <span style={{ fontSize: 10, color: "#00E096", background: "#00E09615", borderRadius: 4, padding: "1px 6px", fontWeight: 700 }}>⭐ PICK</span>}
        </div>
        <div style={{ fontSize: 10, color: confConfig.color, fontWeight: 700, background: confConfig.color + "15", border: `1px solid ${confConfig.border}`, borderRadius: 4, padding: "2px 8px" }}>
          {confConfig.label}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.away.team.name}</div>
          <div style={{ fontSize: 10, color: "#4A6080", display: "flex", alignItems: "center", gap: 3 }}>
            <span>🔴</span>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{awayPitcher.name}</span>
            {awayPitcher.profile && !awayPitcher.profile.isStarter && <span style={{ color: "#FF9F43", fontSize: 9, flexShrink: 0 }}>RP</span>}
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#2A3545", flexShrink: 0, alignSelf: "center" }}>VS</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.home.team.name}</div>
          <div style={{ fontSize: 10, color: "#4A6080", display: "flex", alignItems: "center", gap: 3, justifyContent: "flex-end" }}>
            {homePitcher.profile && !homePitcher.profile.isStarter && <span style={{ color: "#FF9F43", fontSize: 9, flexShrink: 0 }}>RP</span>}
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{homePitcher.name}</span>
            <span>🏠</span>
          </div>
        </div>
      </div>

      {simulation && (
        <div style={{ paddingTop: 8, borderTop: "1px solid #1A2535", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, color: favColor, fontWeight: confidence !== "none" ? 700 : 400 }}>
            {confidence !== "none" ? `${favTeam.split(" ").pop()} ${favPct}%` : "Partido parejo"}
          </div>
          <div style={{ fontSize: 10, color: "#4A6080" }}>
            MC <span style={{ color: "#7A9CC0" }}>{simulation.homeWinPct}%</span> local
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DETAIL VIEW ──────────────────────────────────────────────
function DetailView({ analysis, onBack, onSavePick, savingPick, pickSaved, picks }: {
  analysis: GameAnalysis; onBack: () => void;
  onSavePick: (a: GameAnalysis, pick: string) => void;
  savingPick: boolean; pickSaved: boolean; picks: Pick[];
}) {
  const { game, homePitcher, awayPitcher, homeOffense, awayOffense, simulation, confidence, isLocked } = analysis;
  const alreadyPicked = picks.find(p => p.game_pk === game.gamePk);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const isStrong = confidence === "strong" && !isLocked;
  const favorsHome = simulation ? simulation.homeWinPct >= simulation.awayWinPct : true;
  const favPct = simulation ? Math.max(simulation.homeWinPct, simulation.awayWinPct) : 50;

  const confColor = { strong: "#00E096", moderate: "#FFD84D", weak: "#4A6080", none: "#2A3545" }[confidence];

  return (
    <div style={{ padding: "14px 18px" }}>
      <button onClick={onBack} style={{ background: "none", border: "1px solid #1A2535", borderRadius: 8, color: "#7A9CC0", padding: "6px 12px", cursor: "pointer", fontSize: 11, marginBottom: 14, fontFamily: "inherit" }}>← Volver</button>

      {/* Score banner */}
      <div style={{ background: `linear-gradient(135deg, ${confColor}10, #0D1520)`, border: `1px solid ${confColor}40`, borderRadius: 12, padding: "20px", marginBottom: 12, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: confColor, fontWeight: 700, letterSpacing: "0.15em", marginBottom: 8 }}>
          {confidence === "strong" ? "⭐ PICK RECOMENDADO" : confidence === "moderate" ? "MODERADO" : confidence === "weak" ? "SEÑAL DÉBIL" : "PARTIDO PAREJO"}
        </div>
        {simulation && (
          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 12 }}>
            <MCBar pct={simulation.homeWinPct} label="LOCAL GANA" color={favorsHome ? confColor : "#4A6080"} />
            <div style={{ width: 1, background: "#1A2535" }} />
            <MCBar pct={simulation.awayWinPct} label="VISITANTE GANA" color={!favorsHome ? confColor : "#4A6080"} />
          </div>
        )}
        <div style={{ fontSize: 12, color: confColor, fontWeight: 700 }}>
          {favorsHome ? game.teams.home.team.name : game.teams.away.team.name} — {favPct}% probabilidad
        </div>
        {simulation && (
          <div style={{ fontSize: 10, color: "#4A6080", marginTop: 6 }}>
            Marcador esperado: {simulation.avgHomeRuns} - {simulation.avgAwayRuns} · {isLocked ? "🔒 En curso" : `${time} CT`} · {game.venue?.name}
          </div>
        )}
      </div>

      {/* Pick buttons */}
      {!isLocked && (alreadyPicked ? (
        <div style={{ background: "#00E09615", border: "1px solid #00E09640", borderRadius: 10, padding: "10px", marginBottom: 12, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#00E096" }}>✓ Pick registrado: <strong>{alreadyPicked.my_pick}</strong></div>
          <div style={{ fontSize: 10, color: "#4A6080", marginTop: 4 }}>MC al registrar: {alreadyPicked.mc_home}% local / {alreadyPicked.mc_away}% visitante</div>
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 8 }}>REGISTRAR PICK</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => onSavePick(analysis, game.teams.home.team.name)} disabled={savingPick}
              style={{ padding: "10px", borderRadius: 8, border: `1px solid ${favorsHome ? "#00E09640" : "#1A2535"}`, background: favorsHome ? "#00E09610" : "#1A2535", color: favorsHome ? "#00E096" : "#7A9CC0", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>
              🏠 {game.teams.home.team.name}
            </button>
            <button onClick={() => onSavePick(analysis, game.teams.away.team.name)} disabled={savingPick}
              style={{ padding: "10px", borderRadius: 8, border: `1px solid ${!favorsHome ? "#FF9F4340" : "#1A2535"}`, background: !favorsHome ? "#FF9F4310" : "#1A2535", color: !favorsHome ? "#FF9F43" : "#7A9CC0", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: "inherit" }}>
              🔴 {game.teams.away.team.name}
            </button>
          </div>
          {pickSaved && <div style={{ textAlign: "center", color: "#00E096", fontSize: 11, marginTop: 6 }}>✓ Pick guardado</div>}
        </div>
      ))}

      {/* Pitchers */}
      <Accordion title="⚾ Pitchers" defaultOpen={true}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "VISITANTE", pitcher: awayPitcher, teamName: game.teams.away.team.name, isHome: false },
            { label: "LOCAL", pitcher: homePitcher, teamName: game.teams.home.team.name, isHome: true }
          ].map(({ label, pitcher, teamName }) => (
            <div key={label}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
              <div style={{ fontSize: 10, color: "#7A9CC0", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pitcher.name}</div>
              {pitcher.profile ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: pitcher.profile.isStarter ? "#00E096" : "#FF9F43" }}>
                      {pitcher.profile.isStarter ? "✅ SP" : "⚠️ RP"}
                    </span>
                    <span style={{ fontSize: 9, color: "#4A6080" }}>{pitcher.profile.pitchHand === "L" ? "🤚 Zurdo" : "✋ Diestro"}</span>
                    <TrendBadge trend={pitcher.profile.recentTrend} />
                  </div>
                  <div style={{ background: "#0D1520", borderRadius: 6, padding: "6px 8px", marginBottom: 6, fontSize: 10 }}>
                    <div style={{ color: "#4A6080", marginBottom: 2 }}>Mediana últ.{pitcher.profile.lastOutings} salidas</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: pitcher.profile.recentTrend === "hot" ? "#00E096" : pitcher.profile.recentTrend === "cold" ? "#FF6B6B" : "#FFD84D" }}>
                      ERA {pitcher.profile.medianRecentEra}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                    <StatBox label="ERA temp." value={pitcher.profile.era} />
                    <StatBox label="IP total" value={pitcher.profile.ip} />
                    <StatBox label="ERA casa" value={pitcher.profile.homeEra} />
                    <StatBox label="ERA visit." value={pitcher.profile.awayEra} />
                  </div>
                </>
              ) : <div style={{ fontSize: 11, color: "#4A6080" }}>Por confirmar</div>}
            </div>
          ))}
        </div>
      </Accordion>

      {/* Ofensiva */}
      <Accordion title="🏏 Ofensiva">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { label: "VISITANTE", offense: awayOffense, vsHand: homePitcher.profile?.pitchHand },
            { label: "LOCAL", offense: homeOffense, vsHand: awayPitcher.profile?.pitchHand }
          ].map(({ label, offense, vsHand }) => (
            <div key={label}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 8 }}>{label}</div>
              {offense ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 6 }}>
                    <StatBox label="R/G" value={offense.runsPerGame} highlight />
                    <StatBox label="OPS" value={offense.ops} />
                  </div>
                  {vsHand && (
                    <div style={{ background: "#0D1520", borderRadius: 6, padding: "8px" }}>
                      <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 6 }}>vs pitcher {vsHand === "L" ? "ZURDO" : "DIESTRO"}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 8, color: "#4A6080" }}>OPS vs Z</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: vsHand === "L" ? "#FFD84D" : "#7A9CC0" }}>{offense.opsVsLeft}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 8, color: "#4A6080" }}>OPS vs D</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: vsHand === "R" ? "#FFD84D" : "#7A9CC0" }}>{offense.opsVsRight}</div>
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

      {/* Monte Carlo detail */}
      <Accordion title="🎲 Monte Carlo">
        {simulation ? (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
              {[
                { label: game.teams.home.team.name, pct: simulation.homeWinPct, runs: simulation.avgHomeRuns, isFav: favorsHome },
                { label: game.teams.away.team.name, pct: simulation.awayWinPct, runs: simulation.avgAwayRuns, isFav: !favorsHome },
              ].map(item => (
                <div key={item.label} style={{ background: "#0D1520", borderRadius: 8, padding: 10, border: `1px solid ${item.isFav ? confColor + "40" : "#1A2535"}`, textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: item.isFav ? confColor : "#4A6080" }}>{item.pct}%</div>
                  <div style={{ fontSize: 10, color: "#4A6080", marginTop: 4 }}>~{item.runs} carreras</div>
                </div>
              ))}
            </div>
            <div style={{ background: "#0D1520", borderRadius: 6, padding: "8px 12px", textAlign: "center", fontSize: 11, color: "#4A6080" }}>
              {MC_RUNS.toLocaleString()} simulaciones · Sin ventaja de local
            </div>
          </div>
        ) : <div style={{ fontSize: 11, color: "#4A6080" }}>Sin datos</div>}
      </Accordion>
    </div>
  );
}

// ─── PICKS VIEW ───────────────────────────────────────────────
function PicksView({ picks, onMarkResult, wins, losses, winRate }: {
  picks: Pick[]; onMarkResult: (gk: number, r: "W" | "L") => void;
  wins: number; losses: number; winRate: number;
}) {
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
          <div style={{ fontSize: 11, marginTop: 6 }}>Solo registra picks con confianza FUERTE</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {picks.map(pick => (
            <div key={pick.game_pk} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: "#4A6080" }}>{pick.game_date}</div>
                <div style={{ fontSize: 10, color: "#7A9CC0" }}>MC {pick.mc_home}% local</div>
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
          ))}
        </div>
      )}
    </div>
  );
}
