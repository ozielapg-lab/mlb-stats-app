"use client";
import { useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const MLB_API = "https://statsapi.mlb.com/api/v1";
const SEASON = "2026";
const MONTE_CARLO_RUNS = 10000;

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
  era: string;
  whip: string;
  strikeOuts: string;
  baseOnBalls: string;
  inningsPitched: string;
  wins: string;
  losses: string;
  strikeoutsPer9: string;
  walksPer9: string;
}

interface RecentForm {
  recentEra: string;
  trend: "hot" | "cold" | "neutral";
  lastStarts: number;
}

interface PitcherRole {
  isStarter: boolean;
  position: string;
}

interface TeamBatting {
  avg: string;
  ops: string;
  obp: string;
  slg: string;
  runs: string;
  homeRuns: string;
  runsPerGame: string;
}

interface SimulationResult {
  homeWinPct: number;
  awayWinPct: number;
  avgHomeRuns: number;
  avgAwayRuns: number;
  simulations: number;
}

interface GameAnalysis {
  game: Game;
  homePitcher: { name: string; stats: PitcherStats | null; form: RecentForm | null; role: PitcherRole | null };
  awayPitcher: { name: string; stats: PitcherStats | null; form: RecentForm | null; role: PitcherRole | null };
  homeBatting: TeamBatting | null;
  awayBatting: TeamBatting | null;
  simulation: SimulationResult | null;
  score: number;
  recommendation: string;
  confidence: number;
  isLocked: boolean;
}

interface Pick {
  game_pk: number;
  created_at: string;
  game_date: string;
  home_team: string;
  away_team: string;
  home_pitcher: string;
  away_pitcher: string;
  score: number;
  my_pick: string;
  result: string | null;
  units: number;
}

function poissonRandom(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function runMonteCarlo(
  homeBatting: TeamBatting | null, awayBatting: TeamBatting | null,
  homePitcher: PitcherStats | null, awayPitcher: PitcherStats | null,
  homeForm: RecentForm | null, awayForm: RecentForm | null,
  homeIsStarter: boolean, awayIsStarter: boolean
): SimulationResult | null {
  if (!homeBatting || !awayBatting) return null;
  const leagueAvg = 4.5;
  let homeLambda = parseFloat(homeBatting.runsPerGame) || leagueAvg;
  let awayLambda = parseFloat(awayBatting.runsPerGame) || leagueAvg;

  // Adjust by opposing pitcher ERA — less weight if reliever
  if (awayPitcher) {
    const era = parseFloat(awayPitcher.era);
    if (!isNaN(era) && era > 0) {
      const weight = awayIsStarter ? 0.85 : 0.4;
      homeLambda = homeLambda * (era / leagueAvg) * weight + homeLambda * (1 - weight);
    }
  }
  if (homePitcher) {
    const era = parseFloat(homePitcher.era);
    if (!isNaN(era) && era > 0) {
      const weight = homeIsStarter ? 0.85 : 0.4;
      awayLambda = awayLambda * (era / leagueAvg) * weight + awayLambda * (1 - weight);
    }
  }

  // Recent form adjustment
  if (homeForm && homeIsStarter) {
    const re = parseFloat(homeForm.recentEra);
    if (!isNaN(re) && re > 0) awayLambda = awayLambda * (re / leagueAvg) * 0.15 + awayLambda * 0.85;
  }
  if (awayForm && awayIsStarter) {
    const re = parseFloat(awayForm.recentEra);
    if (!isNaN(re) && re > 0) homeLambda = homeLambda * (re / leagueAvg) * 0.15 + homeLambda * 0.85;
  }

  // Home field advantage — reduced from 1.05 to 1.02
  homeLambda *= 1.02;

  homeLambda = Math.max(1.5, Math.min(9, homeLambda));
  awayLambda = Math.max(1.5, Math.min(9, awayLambda));

  let homeWins = 0, awayWins = 0, totalHomeRuns = 0, totalAwayRuns = 0;
  for (let i = 0; i < MONTE_CARLO_RUNS; i++) {
    const h = poissonRandom(homeLambda);
    const a = poissonRandom(awayLambda);
    totalHomeRuns += h; totalAwayRuns += a;
    if (h > a) homeWins++;
    else if (a > h) awayWins++;
    else homeWins += 0.5;
  }

  return {
    homeWinPct: Math.round((homeWins / MONTE_CARLO_RUNS) * 100),
    awayWinPct: Math.round((awayWins / MONTE_CARLO_RUNS) * 100),
    avgHomeRuns: Math.round((totalHomeRuns / MONTE_CARLO_RUNS) * 10) / 10,
    avgAwayRuns: Math.round((totalAwayRuns / MONTE_CARLO_RUNS) * 10) / 10,
    simulations: MONTE_CARLO_RUNS,
  };
}

async function fetchPitcherStats(pitcherId: number): Promise<PitcherStats | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${pitcherId}/stats?stats=season&season=${SEASON}&group=pitching`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits?.length) return null;
    const s = splits[0].stat;
    return { era: s.era ?? "N/A", whip: s.whip ?? "N/A", strikeOuts: s.strikeOuts ?? "0", baseOnBalls: s.baseOnBalls ?? "0", inningsPitched: s.inningsPitched ?? "0", wins: s.wins ?? "0", losses: s.losses ?? "0", strikeoutsPer9: s.strikeoutsPer9Inn ?? "0", walksPer9: s.walksPer9Inn ?? "0" };
  } catch { return null; }
}

async function fetchRecentForm(pitcherId: number): Promise<RecentForm | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${pitcherId}/stats?stats=gameLog&season=${SEASON}&group=pitching`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits ?? [];
    const last5 = splits.slice(-5);
    if (!last5.length) return null;
    let totalER = 0, totalIP = 0;
    for (const g of last5) { totalIP += parseFloat(g.stat.inningsPitched ?? "0"); totalER += parseFloat(g.stat.earnedRuns ?? "0"); }
    const recentEra = totalIP > 0 ? ((totalER * 9) / totalIP).toFixed(2) : "N/A";
    const n = parseFloat(recentEra);
    return { recentEra, trend: n < 3.0 ? "hot" : n > 5.0 ? "cold" : "neutral", lastStarts: last5.length };
  } catch { return null; }
}

async function fetchPitcherRole(pitcherId: number): Promise<PitcherRole | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${pitcherId}?hydrate=currentTeam`);
    const data = await res.json();
    const person = data.people?.[0];
    if (!person) return null;
    const pos = person.primaryPosition?.abbreviation ?? "P";
    return { isStarter: pos === "SP", position: pos };
  } catch { return null; }
}

async function fetchTeamBatting(teamId: number): Promise<TeamBatting | null> {
  try {
    const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&season=${SEASON}&group=hitting`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits?.length) return null;
    const s = splits[0].stat;
    const games = parseFloat(s.gamesPlayed ?? "1");
    const runs = parseFloat(s.runs ?? "0");
    return { avg: s.avg ?? ".000", ops: s.ops ?? ".000", obp: s.obp ?? ".000", slg: s.slg ?? ".000", runs: s.runs ?? "0", homeRuns: s.homeRuns ?? "0", runsPerGame: games > 0 ? (runs / games).toFixed(2) : "0.00" };
  } catch { return null; }
}

function calcScore(
  sim: SimulationResult | null,
  hf: RecentForm | null, af: RecentForm | null,
  hb: TeamBatting | null, ab: TeamBatting | null,
  hp: PitcherStats | null, ap: PitcherStats | null,
  homeIsStarter: boolean, awayIsStarter: boolean
) {
  // MC carries 50% of the score
  let mcScore = 50;
  if (sim) mcScore = sim.homeWinPct;

  // Recent form — 20% weight, only for starters
  let formScore = 50;
  if (hf && homeIsStarter) formScore += hf.trend === "hot" ? 15 : hf.trend === "cold" ? -15 : 0;
  if (af && awayIsStarter) formScore -= af.trend === "hot" ? 15 : af.trend === "cold" ? -15 : 0;
  formScore = Math.max(0, Math.min(100, formScore));

  // OPS differential — 15% weight
  let opsScore = 50;
  if (hb && ab) {
    const hOps = parseFloat(hb.ops);
    const aOps = parseFloat(ab.ops);
    if (!isNaN(hOps) && !isNaN(aOps)) {
      const diff = (hOps - aOps) * 200;
      opsScore = Math.max(0, Math.min(100, 50 + diff));
    }
  }

  // ERA differential — 15% weight, only for starters
  let eraScore = 50;
  if (hp && ap && homeIsStarter && awayIsStarter) {
    const hEra = parseFloat(hp.era);
    const aEra = parseFloat(ap.era);
    if (!isNaN(hEra) && !isNaN(aEra)) {
      const diff = (aEra - hEra) * 8;
      eraScore = Math.max(0, Math.min(100, 50 + diff));
    }
  }

  // Weighted average
  const score = (mcScore * 0.50) + (formScore * 0.20) + (opsScore * 0.15) + (eraScore * 0.15);
  const rounded = Math.round(Math.max(15, Math.min(85, score)));
  const rec = rounded >= 62 ? "✅ Local favorito" : rounded <= 38 ? "⚠️ Visitante ventaja" : "➡️ Partido parejo";
  return { score: rounded, rec, conf: Math.round(Math.abs(rounded - 50) * 2) };
}

function getRating(score: number) {
  if (score >= 68) return { color: "#00E096", label: "FUERTE" };
  if (score >= 60) return { color: "#7DF9A6", label: "BUENO" };
  if (score >= 45) return { color: "#FFD84D", label: "NEUTRO" };
  if (score >= 35) return { color: "#FF9F43", label: "DÉBIL" };
  return { color: "#FF6B6B", label: "EVITAR" };
}

function getMCRating(pct: number) {
  if (pct >= 85) return { color: "#00E096", label: "ALTA" };
  if (pct >= 75) return { color: "#FFD84D", label: "MEDIA" };
  return { color: "#FF6B6B", label: "BAJA" };
}

function getTrendEmoji(form: RecentForm | null) {
  if (!form) return "";
  return form.trend === "hot" ? "🔥" : form.trend === "cold" ? "📉" : "➡️";
}

function isGameLive(game: Game): boolean {
  return game.status.abstractGameState === "Live" || game.status.abstractGameState === "Final";
}

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

        const [hp, ap, hb, ab, hf, af, hRole, aRole] = await Promise.all([
          hpId ? fetchPitcherStats(hpId) : null,
          apId ? fetchPitcherStats(apId) : null,
          fetchTeamBatting(game.teams.home.team.id),
          fetchTeamBatting(game.teams.away.team.id),
          hpId ? fetchRecentForm(hpId) : null,
          apId ? fetchRecentForm(apId) : null,
          hpId ? fetchPitcherRole(hpId) : null,
          apId ? fetchPitcherRole(apId) : null,
        ]);

        const homeIsStarter = hRole?.isStarter ?? true;
        const awayIsStarter = aRole?.isStarter ?? true;
        const locked = isGameLive(game);

        const sim = runMonteCarlo(hb, ab, hp, ap, hf, af, homeIsStarter, awayIsStarter);
        const { score, rec, conf } = calcScore(sim, hf, af, hb, ab, hp, ap, homeIsStarter, awayIsStarter);

        return {
          game,
          homePitcher: { name: game.teams.home.probablePitcher?.fullName ?? "Por confirmar", stats: hp, form: hf, role: hRole },
          awayPitcher: { name: game.teams.away.probablePitcher?.fullName ?? "Por confirmar", stats: ap, form: af, role: aRole },
          homeBatting: hb, awayBatting: ab, simulation: sim,
          score, recommendation: rec, confidence: conf,
          isLocked: locked
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
    const today = new Date().toISOString().split("T")[0];
    await dbInsert({
      game_pk: analysis.game.gamePk,
      game_date: today,
      home_team: analysis.game.teams.home.team.name,
      away_team: analysis.game.teams.away.team.name,
      home_pitcher: analysis.homePitcher.name,
      away_pitcher: analysis.awayPitcher.name,
      score: analysis.score,
      my_pick: myPick,
      result: null,
      units: 1,
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

  const today = new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const wins = picks.filter(p => p.result === "W").length;
  const losses = picks.filter(p => p.result === "L").length;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
  const strongPicks = games.filter(g => g.simulation && (g.simulation.homeWinPct >= 85 || g.simulation.awayWinPct >= 85) && !g.isLocked).length;

  return (
    <div style={{ minHeight: "100vh", background: "#080C14", color: "#E8EDF5", fontFamily: "'DM Mono', 'Courier New', monospace" }}>
      <div style={{ borderBottom: "1px solid #1A2535", padding: "16px 20px", background: "#0A0F1A" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #C8102E, #002D72)", display: "flex", alignItems: "center", justifyContent: "center" }}>⚾</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em" }}>MLB STATS</div>
              <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em" }}>ANÁLISIS DE APUESTAS • {SEASON} • V3</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#4A6080", textAlign: "right" }}>
            <div style={{ color: "#00E096" }}>{strongPicks} picks fuertes hoy</div>
            <div>{wins}W {losses}L {winRate > 0 ? `${winRate}%` : ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["games", "picks"].map(t => (
            <button key={t} onClick={() => { setView(t as "games" | "picks"); setSelected(null); }}
              style={{ flex: 1, padding: "8px", borderRadius: 8, border: "1px solid", fontSize: 12, fontWeight: 600, cursor: "pointer", borderColor: view === t ? "#00E096" : "#1A2535", background: view === t ? "#00E09615" : "transparent", color: view === t ? "#00E096" : "#4A6080" }}>
              {t === "games" ? `🎮 JUEGOS (${games.length})` : `📊 MIS PICKS (${picks.length})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "50vh", gap: 16 }}>
          <div style={{ width: 40, height: 40, border: "3px solid #1A2535", borderTopColor: "#00E096", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: "#4A6080", fontSize: 12 }}>Analizando juegos y verificando pitchers...</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); }}`}</style>
        </div>
      ) : view === "picks" ? (
        <PicksView picks={picks} onMarkResult={markResult} wins={wins} losses={losses} winRate={winRate} />
      ) : selected ? (
        <DetailView analysis={selected} onBack={() => setSelected(null)} onSavePick={savePick} savingPick={savingPick} pickSaved={pickSaved} picks={picks} />
      ) : (
        <div style={{ padding: "16px 20px" }}>
          <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 12 }}>MEJORES PICKS DEL DÍA — {today}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {games.map((a, i) => <GameCard key={a.game.gamePk} analysis={a} rank={i + 1} onClick={() => setSelected(a)} picks={picks} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function GameCard({ analysis, rank, onClick, picks }: { analysis: GameAnalysis; rank: number; onClick: () => void; picks: Pick[] }) {
  const { game, homePitcher, awayPitcher, score, recommendation, simulation, isLocked } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const alreadyPicked = picks.some(p => p.game_pk === game.gamePk);
  const isStrong = simulation && (simulation.homeWinPct >= 85 || simulation.awayWinPct >= 85);

  return (
    <div onClick={onClick} style={{ background: "#0D1520", border: `1px solid ${isStrong && !isLocked ? rating.color + "60" : rank <= 3 ? rating.color + "30" : "#1A2535"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", position: "relative", overflow: "hidden", opacity: isLocked ? 0.7 : 1 }}>
      {isStrong && !isLocked && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${rating.color}, transparent)` }} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 20, height: 20, borderRadius: 4, background: "#1A2535", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#4A6080", fontWeight: 700 }}>#{rank}</div>
          <div style={{ fontSize: 11, color: isLocked ? "#FF6B6B" : "#4A6080" }}>{isLocked ? "🔒 En curso" : `${time} CT`}</div>
          {alreadyPicked && <div style={{ fontSize: 10, color: "#00E096", background: "#00E09615", border: "1px solid #00E09640", borderRadius: 4, padding: "1px 5px" }}>✓</div>}
          {isStrong && !isLocked && <div style={{ fontSize: 10, color: "#00E096", background: "#00E09615", border: "1px solid #00E09640", borderRadius: 4, padding: "1px 5px" }}>⭐ PICK</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 10, color: rating.color, fontWeight: 700 }}>{rating.label}</div>
          <div style={{ background: rating.color + "20", border: `1px solid ${rating.color}50`, borderRadius: 6, padding: "2px 8px", fontSize: 13, fontWeight: 700, color: rating.color }}>{score}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.away.team.name}</div>
          <div style={{ fontSize: 11, color: "#4A6080", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            🔴 {awayPitcher.name} {getTrendEmoji(awayPitcher.form)}
            {awayPitcher.role && !awayPitcher.role.isStarter && <span style={{ color: "#FF9F43", marginLeft: 4 }}>⚠️RP</span>}
          </div>
        </div>
        <div style={{ padding: "0 8px", color: "#4A6080", fontSize: 10, flexShrink: 0 }}>VS</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.home.team.name}</div>
          <div style={{ fontSize: 11, color: "#4A6080", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {homePitcher.role && !homePitcher.role.isStarter && <span style={{ color: "#FF9F43", marginRight: 4 }}>⚠️RP</span>}
            {getTrendEmoji(homePitcher.form)} {homePitcher.name} 🏠
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid #1A2535" }}>
        <div style={{ fontSize: 11, color: rating.color }}>{recommendation}</div>
        {simulation && (
          <div style={{ fontSize: 11, color: "#4A6080" }}>
            MC: <span style={{ color: getMCRating(Math.max(simulation.homeWinPct, simulation.awayWinPct)).color, fontWeight: 700 }}>
              {simulation.homeWinPct}%
            </span> local
          </div>
        )}
      </div>
    </div>
  );
}

function DetailView({ analysis, onBack, onSavePick, savingPick, pickSaved, picks }: { analysis: GameAnalysis; onBack: () => void; onSavePick: (a: GameAnalysis, pick: string) => void; savingPick: boolean; pickSaved: boolean; picks: Pick[] }) {
  const { game, homePitcher, awayPitcher, homeBatting, awayBatting, simulation, score, recommendation, isLocked } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const alreadyPicked = picks.find(p => p.game_pk === game.gamePk);
  const isStrong = simulation && (simulation.homeWinPct >= 85 || simulation.awayWinPct >= 85);

  return (
    <div style={{ padding: "16px 20px" }}>
      <button onClick={onBack} style={{ background: "none", border: "1px solid #1A2535", borderRadius: 8, color: "#7A9CC0", padding: "6px 12px", cursor: "pointer", fontSize: 12, marginBottom: 16 }}>← Volver</button>

      <div style={{ background: `linear-gradient(135deg, ${rating.color}15, #0D1520)`, border: `1px solid ${rating.color}40`, borderRadius: 12, padding: "16px", marginBottom: 14, textAlign: "center" }}>
        <div style={{ fontSize: 44, fontWeight: 700, color: rating.color, lineHeight: 1 }}>
          {score} {isLocked ? "🔒" : ""}
        </div>
        <div style={{ fontSize: 12, color: "#7A9CC0", marginTop: 4 }}>{isLocked ? "Score bloqueado — juego en curso" : "Score de análisis"}</div>
        <div style={{ fontSize: 15, color: rating.color, fontWeight: 600, marginTop: 6 }}>{recommendation}</div>
        <div style={{ fontSize: 11, color: "#4A6080", marginTop: 4 }}>{isLocked ? "🔴 EN CURSO" : `${time} CT`} • {game.venue?.name}</div>
        {isStrong && !isLocked && <div style={{ marginTop: 8, fontSize: 12, color: "#00E096", fontWeight: 700 }}>⭐ PICK RECOMENDADO — MC 85%+</div>}
      </div>

      {simulation && (
        <div style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: "14px", marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 10 }}>MONTE CARLO — {simulation.simulations.toLocaleString()} SIMULACIONES</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <div style={{ background: "#080C14", borderRadius: 8, padding: "10px", textAlign: "center", border: `1px solid ${simulation.homeWinPct >= 85 ? "#00E09640" : "#1A2535"}` }}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4 }}>LOCAL GANA</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: simulation.homeWinPct > simulation.awayWinPct ? "#00E096" : "#7A9CC0" }}>{simulation.homeWinPct}%</div>
              <div style={{ fontSize: 10, color: "#4A6080", marginTop: 4 }}>~{simulation.avgHomeRuns} carreras</div>
            </div>
            <div style={{ background: "#080C14", borderRadius: 8, padding: "10px", textAlign: "center", border: `1px solid ${simulation.awayWinPct >= 85 ? "#FF9F4340" : "#1A2535"}` }}>
              <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 4 }}>VISITANTE GANA</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: simulation.awayWinPct > simulation.homeWinPct ? "#FF9F43" : "#7A9CC0" }}>{simulation.awayWinPct}%</div>
              <div style={{ fontSize: 10, color: "#4A6080", marginTop: 4 }}>~{simulation.avgAwayRuns} carreras</div>
            </div>
          </div>
          <div style={{ background: "#080C14", borderRadius: 6, padding: "6px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 10, color: "#4A6080" }}>
              Marcador más probable: <strong style={{ color: "#E8EDF5" }}>{simulation.avgHomeRuns} - {simulation.avgAwayRuns}</strong> a favor del {simulation.homeWinPct > simulation.awayWinPct ? "local" : "visitante"}
            </div>
          </div>
        </div>
      )}

      {!isLocked && (alreadyPicked ? (
        <div style={{ background: "#00E09615", border: "1px solid #00E09640", borderRadius: 10, padding: "12px", marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#00E096" }}>✓ Pick registrado: <strong>{alreadyPicked.my_pick}</strong></div>
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 8 }}>REGISTRAR MI PICK</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => onSavePick(analysis, game.teams.home.team.name)} disabled={savingPick}
              style={{ padding: "10px 6px", borderRadius: 8, border: "1px solid #1D9E7540", background: "#1D9E7515", color: "#00E096", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
              🏠 {game.teams.home.team.name}
            </button>
            <button onClick={() => onSavePick(analysis, game.teams.away.team.name)} disabled={savingPick}
              style={{ padding: "10px 6px", borderRadius: 8, border: "1px solid #4A608040", background: "#1A2535", color: "#7A9CC0", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
              🔴 {game.teams.away.team.name}
            </button>
          </div>
          {pickSaved && <div style={{ textAlign: "center", color: "#00E096", fontSize: 12, marginTop: 8 }}>✓ Pick guardado</div>}
        </div>
      ))}

      {isLocked && (
        <div style={{ background: "#FF6B6B15", border: "1px solid #FF6B6B40", borderRadius: 10, padding: "12px", marginBottom: 14, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "#FF6B6B" }}>🔒 Juego en curso — no se pueden registrar picks</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[
          { label: "VISITANTE", pitcher: awayPitcher, batting: awayBatting, emoji: "🔴", teamName: game.teams.away.team.name },
          { label: "LOCAL", pitcher: homePitcher, batting: homeBatting, emoji: "🏠", teamName: game.teams.home.team.name }
        ].map(({ label, pitcher, batting, emoji, teamName }) => (
          <div key={label} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
            <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{emoji} {pitcher.name}</div>
            {pitcher.role && (
              <div style={{ marginBottom: 8, display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: pitcher.role.isStarter ? "#00E09615" : "#FF9F4320", color: pitcher.role.isStarter ? "#00E096" : "#FF9F43", border: `1px solid ${pitcher.role.isStarter ? "#00E09640" : "#FF9F4340"}` }}>
                {pitcher.role.isStarter ? "✅ ABRIDOR" : "⚠️ RELEVISTA — análisis menos confiable"}
              </div>
            )}
            {pitcher.form && (
              <div style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 6, background: pitcher.form.trend === "hot" ? "#00E09615" : pitcher.form.trend === "cold" ? "#FF6B6B15" : "#1A2535", border: `1px solid ${pitcher.form.trend === "hot" ? "#00E09640" : pitcher.form.trend === "cold" ? "#FF6B6B40" : "#1A2535"}` }}>
                <div style={{ fontSize: 9, color: "#4A6080" }}>ÚLTIMAS {pitcher.form.lastStarts} SALIDAS</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: pitcher.form.trend === "hot" ? "#00E096" : pitcher.form.trend === "cold" ? "#FF6B6B" : "#FFD84D" }}>ERA {pitcher.form.recentEra} {getTrendEmoji(pitcher.form)}</div>
              </div>
            )}
            {pitcher.stats ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 8 }}>
                {[["ERA", pitcher.stats.era], ["WHIP", pitcher.stats.whip], ["K/9", pitcher.stats.strikeoutsPer9], ["BB/9", pitcher.stats.walksPer9]].map(([l, v]) => (
                  <div key={l} style={{ background: "#080C14", borderRadius: 6, padding: "5px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: "#4A6080" }}>{l}</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{v}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 8 }}>Sin datos pitcher</div>}
            {batting && (
              <div style={{ paddingTop: 8, borderTop: "1px solid #1A2535" }}>
                <div style={{ fontSize: 9, color: "#4A6080", marginBottom: 6 }}>OFENSIVA DEL EQUIPO</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  {[["AVG", batting.avg], ["OBP", batting.obp], ["SLG", batting.slg], ["OPS", batting.ops], ["R/G", batting.runsPerGame], ["HR", batting.homeRuns]].map(([l, v]) => (
                    <div key={l} style={{ background: "#080C14", borderRadius: 6, padding: "5px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "#4A6080" }}>{l}</div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PicksView({ picks, onMarkResult, wins, losses, winRate }: { picks: Pick[]; onMarkResult: (gamePk: number, r: "W" | "L") => void; wins: number; losses: number; winRate: number }) {
  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        {[["GANADOS", wins, "#00E096"], ["PERDIDOS", losses, "#FF6B6B"], ["WIN RATE", `${winRate}%`, "#FFD84D"]].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0D1520", border: `1px solid ${c}30`, borderRadius: 10, padding: "12px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#4A6080", letterSpacing: "0.1em" }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c as string, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>
      {picks.length === 0 ? (
        <div style={{ textAlign: "center", color: "#4A6080", fontSize: 13, marginTop: 40 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div>No hay picks registrados todavía</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>Abre un juego y registra tu primera apuesta</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {picks.map(pick => {
            const rating = getRating(pick.score);
            return (
              <div key={pick.game_pk} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: "#4A6080" }}>{pick.game_date}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: rating.color, background: rating.color + "20", borderRadius: 4, padding: "1px 6px" }}>{pick.score}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{pick.away_team} @ {pick.home_team}</div>
                <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 8 }}>Mi pick: <strong style={{ color: "#E8EDF5" }}>{pick.my_pick}</strong></div>
                {pick.result ? (
                  <div style={{ display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700, background: pick.result === "W" ? "#00E09620" : "#FF6B6B20", color: pick.result === "W" ? "#00E096" : "#FF6B6B", border: `1px solid ${pick.result === "W" ? "#00E09640" : "#FF6B6B40"}` }}>
                    {pick.result === "W" ? "✓ GANADO" : "✗ PERDIDO"}
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => onMarkResult(pick.game_pk, "W")} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #00E09640", background: "#00E09615", color: "#00E096", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>✓ GANADO</button>
                    <button onClick={() => onMarkResult(pick.game_pk, "L")} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #FF6B6B40", background: "#FF6B6B15", color: "#FF6B6B", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>✗ PERDIDO</button>
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
