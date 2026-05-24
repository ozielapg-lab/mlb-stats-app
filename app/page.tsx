"use client";
import { useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const MLB_API = "https://statsapi.mlb.com/api/v1";
const SEASON = "2026";
const MC_RUNS = 10000;
const LEAGUE_AVG_RPG = 4.5;     // carreras por equipo por juego (referencia liga)
const FIP_CONSTANT = 3.15;       // constante FIP aprox 2026
const SP_INNINGS = 5.5;          // innings esperados que cubre el SP
const LEAGUE_BULLPEN_FIP = 4.10; // FIP promedio bullpen liga

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

type PitcherRole = "SP" | "OPENER" | "RP";

interface PitcherProfile {
  era: string;
  fip: string;              // NUEVO: predictor principal
  whip: string;
  kPct: string;             // NUEVO: K%
  bbPct: string;            // NUEVO: BB%
  medianRecentFip: string;  // mediana FIP últimas salidas (reemplaza ERA mediana)
  recentTrend: "hot" | "cold" | "neutral";
  lastOutings: number;
  role: PitcherRole;        // NUEVO: 3 niveles en vez de booleano
  avgIP: number;            // innings promedio por apertura
  pitchHand: string;
  wins: string;
  losses: string;
  ip: string;
  firstInningRunPct: string; // NUEVO: % de aperturas con carrera en 1er inning
}

interface TeamOffense {
  runsPerGame: string;
  ops: string;
  opsVsLeft: string;
  opsVsRight: string;
  firstInningRunPct: string; // NUEVO: % de juegos donde anota en 1er inning
  bullpenFip: string;        // NUEVO: FIP del bullpen del equipo
}

interface SimResult {
  homeWinPct: number;
  awayWinPct: number;
  avgHomeRuns: number;
  avgAwayRuns: number;
  nrfiPct: number;           // NUEVO: prob de NO carrera en 1er inning (ambos equipos)
  yrfiPct: number;           // NUEVO: prob de SÍ carrera en 1er inning
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

// ─── UTILIDADES DE MERCADO (NUEVO) ────────────────────────────
// Convierte momio americano a probabilidad implícita
function oddsToImpliedProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (-odds + 100);
}

// Valor esperado: compara prob del modelo contra prob implícita del mercado
// Retorna el edge en puntos porcentuales (positivo = +EV)
function calcEdge(modelProb: number, americanOdds: number): number {
  const implied = oddsToImpliedProb(americanOdds) * 100;
  return Math.round((modelProb - implied) * 10) / 10;
}

// ─── FIP (NUEVO) ──────────────────────────────────────────────
// FIP = ((13*HR)+(3*(BB+HBP))-(2*K))/IP + constante
function calcFip(hr: number, bb: number, hbp: number, k: number, ip: number): number | null {
  if (ip <= 0) return null;
  return ((13 * hr) + (3 * (bb + hbp)) - (2 * k)) / ip + FIP_CONSTANT;
}

// ─── POISSON ──────────────────────────────────────────────────
function poissonRandom(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// ─── MONTE CARLO (mejorado con NRFI) ──────────────────────────
function runMC(
  homeLambda: number,
  awayLambda: number,
  homeFirstInningLambda: number,
  awayFirstInningLambda: number,
): SimResult {
  let hw = 0, aw = 0, thr = 0, tar = 0, nrfi = 0;
  for (let i = 0; i < MC_RUNS; i++) {
    const h = poissonRandom(homeLambda);
    const a = poissonRandom(awayLambda);
    thr += h; tar += a;
    if (h > a) hw++;
    else if (a > h) aw++;
    else hw += 0.5;

    // Primer inning: simular carreras de ambos equipos en el 1er inning
    const h1 = poissonRandom(homeFirstInningLambda);
    const a1 = poissonRandom(awayFirstInningLambda);
    if (h1 === 0 && a1 === 0) nrfi++;
  }
  const nrfiPct = Math.round((nrfi / MC_RUNS) * 100);
  return {
    homeWinPct: Math.round((hw / MC_RUNS) * 100),
    awayWinPct: Math.round((aw / MC_RUNS) * 100),
    avgHomeRuns: Math.round((thr / MC_RUNS) * 10) / 10,
    avgAwayRuns: Math.round((tar / MC_RUNS) * 10) / 10,
    nrfiPct,
    yrfiPct: 100 - nrfiPct,
  };
}

// ─── LAMBDAS (reescrito: FIP + bullpen + fix doble-conteo) ────
function buildLambdas(
  homeOffense: TeamOffense | null,
  awayOffense: TeamOffense | null,
  homePitcher: PitcherProfile | null,
  awayPitcher: PitcherProfile | null,
): { homeLambda: number; awayLambda: number; homeFirstInningLambda: number; awayFirstInningLambda: number } {
  const base = LEAGUE_AVG_RPG;
  let homeLambda = parseFloat(homeOffense?.runsPerGame ?? "0") || base;
  let awayLambda = parseFloat(awayOffense?.runsPerGame ?? "0") || base;

  // Función que ajusta la ofensiva de un equipo según el pitcher rival.
  // Usa FIP mezclado (40% temporada / 60% reciente) y reparte el peso
  // entre SP (segun innings que cubre) y bullpen del equipo rival.
  function adjustOffense(
    offenseRPG: number,
    pitcher: PitcherProfile | null,
    rivalBullpenFip: number,
    offense: TeamOffense | null,
  ): number {
    if (!pitcher) return offenseRPG;

    const seasonFip = parseFloat(pitcher.fip);
    const recentFip = parseFloat(pitcher.medianRecentFip);
    const blendedFip = !isNaN(recentFip) ? seasonFip * 0.40 + recentFip * 0.60 : seasonFip;
    if (isNaN(blendedFip) || blendedFip <= 0) return offenseRPG;

    // Peso SP vs bullpen segun rol e innings esperados
    let spWeight: number;
    if (pitcher.role === "SP") spWeight = Math.min(pitcher.avgIP, SP_INNINGS) / 9;
    else if (pitcher.role === "OPENER") spWeight = Math.min(pitcher.avgIP, 2) / 9;
    else spWeight = 1.5 / 9; // RP que abre

    const bullpenWeight = 1 - spWeight;
    const effectiveFip = blendedFip * spWeight + rivalBullpenFip * bullpenWeight;

    // Escalar carreras por el FIP efectivo relativo a la liga.
    // FIP bajo (bueno) => menos carreras del rival.
    let adjusted = offenseRPG * (effectiveFip / base);

    // Split L/R: aplicar SOLO como ajuste fino, no multiplicativo total
    // (fix del bug de doble-conteo del V5: ahora es un nudge de +-, no x).
    if (offense) {
      const hand = pitcher.pitchHand;
      const splitOps = hand === "L" ? parseFloat(offense.opsVsLeft) : parseFloat(offense.opsVsRight);
      const baseOps = parseFloat(offense.ops);
      if (!isNaN(splitOps) && !isNaN(baseOps) && baseOps > 0) {
        // El split aporta máximo +-15% del efecto, no el 100%
        const splitRatio = splitOps / baseOps;
        const dampened = 1 + (splitRatio - 1) * 0.30;
        adjusted *= dampened;
      }
    }
    return adjusted;
  }

  const awayBullpenFip = parseFloat(awayOffense?.bullpenFip ?? "") || LEAGUE_BULLPEN_FIP;
  const homeBullpenFip = parseFloat(homeOffense?.bullpenFip ?? "") || LEAGUE_BULLPEN_FIP;

  homeLambda = adjustOffense(homeLambda, awayPitcher, awayBullpenFip, homeOffense);
  awayLambda = adjustOffense(awayLambda, homePitcher, homeBullpenFip, awayOffense);

  // Primer inning: solo cuenta el SP (no bullpen) y la tendencia del equipo.
  // Lambda del 1er inning = mezcla de (tendencia ofensiva 1er inning del equipo)
  // y (tendencia del pitcher rival a permitir carrera en 1er inning).
  function firstInningLambda(offense: TeamOffense | null, rivalPitcher: PitcherProfile | null): number {
    const teamRate = parseFloat(offense?.firstInningRunPct ?? "") / 100;
    const pitcherRate = parseFloat(rivalPitcher?.firstInningRunPct ?? "") / 100;
    // Si no hay datos, usar base liga ~0.27 carreras esperadas en 1er inning
    const t = isNaN(teamRate) ? 0.27 : teamRate;
    const p = isNaN(pitcherRate) ? 0.27 : pitcherRate;
    // Promedio de ambas tendencias como tasa de "anota en 1er", convertida a lambda
    const rate = (t + p) / 2;
    // rate es prob de anotar >=1; aproximar lambda con -ln(1-rate)
    return Math.max(0.05, -Math.log(1 - Math.min(rate, 0.95)));
  }

  const homeFirstInningLambda = firstInningLambda(homeOffense, awayPitcher);
  const awayFirstInningLambda = firstInningLambda(awayOffense, homePitcher);

  return {
    homeLambda: Math.max(1.5, Math.min(9, homeLambda)),
    awayLambda: Math.max(1.5, Math.min(9, awayLambda)),
    homeFirstInningLambda,
    awayFirstInningLambda,
  };
}

// ─── FETCHERS ─────────────────────────────────────────────────
async function fetchPitcherProfile(id: number): Promise<PitcherProfile | null> {
  try {
    const [seasonRes, logRes, bioRes] = await Promise.all([
      fetch(`${MLB_API}/people/${id}/stats?stats=season&season=${SEASON}&group=pitching`),
      fetch(`${MLB_API}/people/${id}/stats?stats=gameLog&season=${SEASON}&group=pitching`),
      fetch(`${MLB_API}/people/${id}`),
    ]);
    const [sd, ld, bd] = await Promise.all([seasonRes.json(), logRes.json(), bioRes.json()]);

    const s = sd.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;

    // ── Datos crudos para FIP ──
    const hr = parseFloat(s.homeRuns ?? "0");
    const bb = parseFloat(s.baseOnBalls ?? "0");
    const hbp = parseFloat(s.hitByPitch ?? "0");
    const k = parseFloat(s.strikeOuts ?? "0");
    const totalIP = parseFloat(s.inningsPitched ?? "0");
    const tbf = parseFloat(s.battersFaced ?? "0");

    const fipNum = calcFip(hr, bb, hbp, k, totalIP);
    const fip = fipNum !== null ? fipNum.toFixed(2) : "N/A";

    // ── K% y BB% (sobre bateadores enfrentados) ──
    const kPct = tbf > 0 ? ((k / tbf) * 100).toFixed(1) : "N/A";
    const bbPct = tbf > 0 ? ((bb / tbf) * 100).toFixed(1) : "N/A";

    // ── Detección de rol en 3 niveles ──
    const gamesStarted = parseFloat(s.gamesStarted ?? "0");
    const gamesPitched = parseFloat(s.gamesPlayed ?? s.gamesPitched ?? "1");
    const avgIP = gamesPitched > 0 ? totalIP / gamesPitched : 0;
    const startRate = gamesPitched > 0 ? gamesStarted / gamesPitched : 0;

    let role: PitcherRole;
    if (startRate >= 0.7 && avgIP >= 4.5) {
      role = "SP";                          // titular tradicional
    } else if (startRate >= 0.5 && avgIP < 4.5) {
      role = "OPENER";                      // inicia pero pocas entradas
    } else if (gamesStarted > 0 && avgIP < 3.0) {
      role = "OPENER";                      // abre pero rol corto
    } else {
      role = "RP";                          // relevista
    }

    // ── Mediana FIP de últimas 7 salidas ──
    const allOutings = ld.stats?.[0]?.splits ?? [];
    const last7 = allOutings.slice(-7);
    const recentFips: number[] = last7
      .map((g: { stat: Record<string, string | undefined> }) => {
        const gip = parseFloat(g.stat.inningsPitched ?? "0");
        const ghr = parseFloat(g.stat.homeRuns ?? "0");
        const gbb = parseFloat(g.stat.baseOnBalls ?? "0");
        const ghbp = parseFloat(g.stat.hitByPitch ?? "0");
        const gk = parseFloat(g.stat.strikeOuts ?? "0");
        return calcFip(ghr, gbb, ghbp, gk, gip);
      })
      .filter((f: number | null): f is number => f !== null)
      .sort((a: number, b: number) => a - b);

    let medianRecentFip = "N/A";
    if (recentFips.length > 0) {
      const mid = Math.floor(recentFips.length / 2);
      const median = recentFips.length % 2 !== 0
        ? recentFips[mid]
        : (recentFips[mid - 1] + recentFips[mid]) / 2;
      medianRecentFip = median.toFixed(2);
    }

    // ── % de aperturas con carrera en 1er inning ──
    // Aproximación: usar gameLog. La MLB Stats API no expone inning-by-inning
    // en el gameLog season, así que estimamos vía runs allowed temprano.
    // Para precisión real se requiere playByPlay por juego (ver nota).
    let firstInningRunPct = "N/A";
    if (last7.length > 0) {
      // Heurística: pitchers con FIP alto y BB% alto tienden a permitir 1er inning
      const fipBase = fipNum ?? 4.5;
      const bbRate = tbf > 0 ? k / tbf : 0.08;
      // Estimación crude de prob de permitir carrera en 1er inning
      const est = Math.min(0.55, Math.max(0.12, (fipBase / 4.5) * 0.27 + parseFloat(bbPct) / 100 * 0.5));
      firstInningRunPct = (est * 100).toFixed(0);
    }

    const fipForTrend = parseFloat(medianRecentFip);
    const seasonFip = parseFloat(fip);
    const recentTrend = isNaN(fipForTrend) || isNaN(seasonFip) ? "neutral"
      : fipForTrend < seasonFip * 0.85 ? "hot"
      : fipForTrend > seasonFip * 1.20 ? "cold"
      : "neutral";

    return {
      era: s.era ?? "N/A",
      fip,
      whip: s.whip ?? "N/A",
      kPct,
      bbPct,
      medianRecentFip,
      recentTrend,
      lastOutings: last7.length,
      role,
      avgIP: Math.round(avgIP * 10) / 10,
      pitchHand: bd.people?.[0]?.pitchHand?.code ?? "R",
      wins: s.wins ?? "0",
      losses: s.losses ?? "0",
      ip: s.inningsPitched ?? "0",
      firstInningRunPct,
    };
  } catch { return null; }
}

async function fetchTeamOffense(teamId: number): Promise<TeamOffense | null> {
  try {
    const [seasonRes, vsLRes, vsRRes, bullpenRes] = await Promise.all([
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&season=${SEASON}&group=hitting`),
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=vl`),
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=vr`),
      fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&season=${SEASON}&group=pitching`),
    ]);
    const [sd, ld, rd, bd] = await Promise.all([
      seasonRes.json(), vsLRes.json(), vsRRes.json(), bullpenRes.json()
    ]);
    const s = sd.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    const games = parseFloat(s.gamesPlayed ?? "1");
    const runs = parseFloat(s.runs ?? "0");

    // Bullpen FIP aproximado del staff completo del equipo
    const ps = bd.stats?.[0]?.splits?.[0]?.stat;
    let bullpenFip = String(LEAGUE_BULLPEN_FIP);
    if (ps) {
      const f = calcFip(
        parseFloat(ps.homeRuns ?? "0"),
        parseFloat(ps.baseOnBalls ?? "0"),
        parseFloat(ps.hitByPitch ?? "0"),
        parseFloat(ps.strikeOuts ?? "0"),
        parseFloat(ps.inningsPitched ?? "0"),
      );
      if (f !== null) bullpenFip = f.toFixed(2);
    }

    return {
      runsPerGame: games > 0 ? (runs / games).toFixed(2) : "0.00",
      ops: s.ops ?? ".000",
      opsVsLeft: ld.stats?.[0]?.splits?.[0]?.stat?.ops ?? s.ops ?? ".000",
      opsVsRight: rd.stats?.[0]?.splits?.[0]?.stat?.ops ?? s.ops ?? ".000",
      firstInningRunPct: "N/A", // requiere playByPlay; placeholder por ahora
      bullpenFip,
    };
  } catch { return null; }
}

function getConfidence(sim: SimResult | null, homeSP: PitcherRole | null, awaySP: PitcherRole | null): "strong" | "moderate" | "weak" | "none" {
  if (!sim) return "none";
  const max = Math.max(sim.homeWinPct, sim.awayWinPct);
  // Si algun pitcher no es SP real, bajar el techo de confianza
  const bothReal = homeSP === "SP" && awaySP === "SP";
  if (!bothReal) return max >= 75 ? "moderate" : "weak";
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

// ─── COMPONENTES UI ───────────────────────────────────────────
function Accordion({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: "1px solid #1A2535", borderRadius: 12, overflow: "hidden", marginBottom: 10 }}>
      <button onClick={() => setOpen(!open)} style={{ width: "100%", padding: "14px 16px", background: "#0D1520", border: "none", color: "#E8EDF5", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 15, fontWeight: 600, fontFamily: "inherit" }}>
        <span>{title}</span>
        <span style={{ color: "#4A6080" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "14px 16px", background: "#080C14" }}>{children}</div>}
    </div>
  );
}

function StatBox({ label, value, highlight, color }: { label: string; value: string; highlight?: boolean; color?: string }) {
  return (
    <div style={{ background: "#0D1520", borderRadius: 8, padding: "10px 10px", textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color ?? (highlight ? "#00E096" : "#E8EDF5") }}>{value}</div>
    </div>
  );
}

function RoleBadge({ role }: { role: PitcherRole }) {
  const config = {
    SP: { color: "#00E096", bg: "#00E09618", label: "✅ Titular (SP)" },
    OPENER: { color: "#FFD84D", bg: "#FFD84D18", label: "⚡ Opener" },
    RP: { color: "#FF9F43", bg: "#FF9F4318", label: "⚠️ Relevista (RP)" },
  }[role];
  return (
    <span style={{ fontSize: 12, fontWeight: 700, color: config.color, background: config.bg, border: `1px solid ${config.color}40`, borderRadius: 6, padding: "3px 9px" }}>
      {config.label}
    </span>
  );
}

function TrendBadge({ trend }: { trend: "hot" | "cold" | "neutral" }) {
  const config = {
    hot: { color: "#00E096", bg: "#00E09615", label: "🔥 EN FORMA" },
    cold: { color: "#FF6B6B", bg: "#FF6B6B15", label: "📉 FRÍO" },
    neutral: { color: "#FFD84D", bg: "#FFD84D15", label: "➡️ ESTABLE" },
  }[trend];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: config.color, background: config.bg, border: `1px solid ${config.color}40`, borderRadius: 5, padding: "3px 8px" }}>
      {config.label}
    </span>
  );
}

// ─── CALCULADORA DE VALOR / MOMIO (NUEVO) ─────────────────────
// El usuario escribe el momio que ve en la casa, y el modelo le dice
// si su probabilidad calculada tiene valor (+EV) contra ese momio.
function OddsValueCalc({ modelProb, label }: { modelProb: number; label: string }) {
  const [odds, setOdds] = useState("");
  const oddsNum = parseInt(odds.replace(/[^0-9-]/g, ""), 10);
  const valid = !isNaN(oddsNum) && oddsNum !== 0;
  const implied = valid ? oddsToImpliedProb(oddsNum) * 100 : null;
  const edge = valid ? calcEdge(modelProb, oddsNum) : null;

  return (
    <div style={{ background: "#0D1520", borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
      <div style={{ fontSize: 12, color: "#7A9CC0", marginBottom: 8 }}>💰 Valor para <strong style={{ color: "#E8EDF5" }}>{label}</strong></div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input
          value={odds}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOdds(e.target.value)}
          placeholder="Momio (ej -125)"
          inputMode="numeric"
          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #1A2535", background: "#080C14", color: "#E8EDF5", fontSize: 15, fontFamily: "inherit", outline: "none" }}
        />
        <div style={{ textAlign: "center", minWidth: 90 }}>
          <div style={{ fontSize: 10, color: "#4A6080" }}>MODELO</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#7A9CC0" }}>{modelProb}%</div>
        </div>
      </div>
      {valid && implied !== null && edge !== null && (
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "#7A9CC0" }}>
            Implícita casa: <strong style={{ color: "#E8EDF5" }}>{implied.toFixed(1)}%</strong>
          </div>
          <div style={{
            fontSize: 14, fontWeight: 700, padding: "4px 12px", borderRadius: 8,
            background: edge > 0 ? "#00E09618" : "#FF6B6B18",
            color: edge > 0 ? "#00E096" : "#FF6B6B",
            border: `1px solid ${edge > 0 ? "#00E09640" : "#FF6B6B40"}`,
          }}>
            {edge > 0 ? `+${edge}% VALOR ✓` : `${edge}% sin valor`}
          </div>
        </div>
      )}
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
        const { homeLambda, awayLambda, homeFirstInningLambda, awayFirstInningLambda } = buildLambdas(ho, ao, hp, ap);
        const sim = runMC(homeLambda, awayLambda, homeFirstInningLambda, awayFirstInningLambda);
        const confidence = getConfidence(sim, hp?.role ?? null, ap?.role ?? null);

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
    <div style={{ minHeight: "100vh", background: "#080C14", color: "#E8EDF5", fontFamily: "'DM Sans', -apple-system, system-ui, sans-serif" }}>
      {/* HEADER */}
      <div style={{ background: "#0A0F1A", borderBottom: "1px solid #1A2535", padding: "16px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #C8102E, #002D72)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⚾</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "0.04em" }}>MLB STATS</div>
              <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.1em" }}>ANÁLISIS • {SEASON} • V6</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {strongToday > 0
              ? <div style={{ fontSize: 14, color: "#00E096", fontWeight: 700 }}>⭐ {strongToday} pick{strongToday > 1 ? "s" : ""} fuerte{strongToday > 1 ? "s" : ""}</div>
              : <div style={{ fontSize: 13, color: "#4A6080" }}>Sin picks fuertes hoy</div>
            }
            <div style={{ fontSize: 13, color: "#4A6080", marginTop: 3 }}>{wins}W {losses}L{winRate > 0 ? ` · ${winRate}%` : ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {(["games", "picks"] as const).map(t => (
            <button key={t} onClick={() => { setView(t); setSelected(null); }}
              style={{ flex: 1, padding: "10px", borderRadius: 10, border: `1px solid ${view === t ? "#00E096" : "#1A2535"}`, background: view === t ? "#00E09615" : "transparent", color: view === t ? "#00E096" : "#7A9CC0", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
              {t === "games" ? `🎮 Juegos (${games.length})` : `📊 Mis picks (${picks.length})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "55vh", gap: 14 }}>
          <div style={{ width: 44, height: 44, border: "3px solid #1A2535", borderTopColor: "#00E096", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: "#4A6080", fontSize: 13, letterSpacing: "0.1em" }}>ANALIZANDO JUEGOS...</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      ) : view === "picks" ? (
        <PicksView picks={picks} onMarkResult={markResult} wins={wins} losses={losses} winRate={winRate} />
      ) : selected ? (
        <DetailView analysis={selected} onBack={() => setSelected(null)} onSavePick={savePick} savingPick={savingPick} pickSaved={pickSaved} picks={picks} />
      ) : (
        <div style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 12, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 12 }}>
            {today.toUpperCase()}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {games.map((a, i) => <GameCard key={a.game.gamePk} analysis={a} rank={i + 1} onClick={() => setSelected(a)} picks={picks} />)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GAME CARD (LOCAL a la izquierda, consistente con casas) ──
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
    weak: { color: "#7A9CC0", label: "DÉBIL", border: "#1A2535" },
    none: { color: "#4A6080", label: "PAREJO", border: "#1A2535" },
  }[confidence];

  // Render de una fila de equipo (reutilizable). Local arriba, visitante abajo.
  function teamRow(teamName: string, pitcher: { name: string; profile: PitcherProfile | null }, isHome: boolean) {
    const role = pitcher.profile?.role;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14 }}>{isHome ? "🏠" : "🔴"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
          <div style={{ fontSize: 12, color: "#7A9CC0", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pitcher.name}</span>
            {role && role !== "SP" && (
              <span style={{ color: role === "OPENER" ? "#FFD84D" : "#FF9F43", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                {role}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClick} style={{ background: "#0D1520", border: `1px solid ${isStrong ? "#00E09650" : "#1A2535"}`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", position: "relative", overflow: "hidden", opacity: isLocked ? 0.6 : 1 }}>
      {isStrong && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #00E096, transparent)" }} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ fontSize: 12, color: "#2A3545" }}>#{rank}</span>
          <span style={{ fontSize: 13, color: isLocked ? "#FF6B6B" : "#7A9CC0" }}>{isLocked ? "🔒 En curso" : `${time} CT`}</span>
          {alreadyPicked && <span style={{ fontSize: 12, color: "#00E096", background: "#00E09615", borderRadius: 5, padding: "1px 6px" }}>✓</span>}
          {isStrong && <span style={{ fontSize: 12, color: "#00E096", background: "#00E09615", borderRadius: 5, padding: "1px 7px", fontWeight: 700 }}>⭐ PICK</span>}
        </div>
        <div style={{ fontSize: 12, color: confConfig.color, fontWeight: 700, background: confConfig.color + "15", border: `1px solid ${confConfig.border}`, borderRadius: 5, padding: "3px 10px" }}>
          {confConfig.label}
        </div>
      </div>

      {/* LOCAL arriba, VISITANTE abajo — orientación consistente */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
        {teamRow(game.teams.home.team.name, homePitcher, true)}
        {teamRow(game.teams.away.team.name, awayPitcher, false)}
      </div>

      {simulation && (
        <div style={{ paddingTop: 12, borderTop: "1px solid #1A2535", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14, color: favColor, fontWeight: confidence !== "none" ? 700 : 400 }}>
            {confidence !== "none" ? `${favTeam.split(" ").pop()} ${favPct}%` : "Partido parejo"}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#7A9CC0" }}>NRFI <strong style={{ color: simulation.nrfiPct >= 65 ? "#00E096" : "#7A9CC0" }}>{simulation.nrfiPct}%</strong></span>
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
  const confColor = { strong: "#00E096", moderate: "#FFD84D", weak: "#7A9CC0", none: "#4A6080" }[confidence];

  // Orden consistente: LOCAL primero (izquierda/arriba), VISITANTE segundo
  const teamsOrdered = [
    { label: "🏠 LOCAL", teamName: game.teams.home.team.name, pitcher: homePitcher, offense: homeOffense, vsHand: awayPitcher.profile?.pitchHand, winPct: simulation?.homeWinPct ?? 0, isHome: true },
    { label: "🔴 VISITANTE", teamName: game.teams.away.team.name, pitcher: awayPitcher, offense: awayOffense, vsHand: homePitcher.profile?.pitchHand, winPct: simulation?.awayWinPct ?? 0, isHome: false },
  ];

  return (
    <div style={{ padding: "16px 18px" }}>
      <button onClick={onBack} style={{ background: "none", border: "1px solid #1A2535", borderRadius: 10, color: "#7A9CC0", padding: "8px 14px", cursor: "pointer", fontSize: 13, marginBottom: 16, fontFamily: "inherit" }}>← Volver</button>

      {/* Banner */}
      <div style={{ background: `linear-gradient(135deg, ${confColor}10, #0D1520)`, border: `1px solid ${confColor}40`, borderRadius: 14, padding: "22px", marginBottom: 14, textAlign: "center" }}>
        <div style={{ fontSize: 13, color: confColor, fontWeight: 700, letterSpacing: "0.12em", marginBottom: 12 }}>
          {confidence === "strong" ? "⭐ PICK RECOMENDADO" : confidence === "moderate" ? "MODERADO" : confidence === "weak" ? "SEÑAL DÉBIL" : "PARTIDO PAREJO"}
        </div>
        {simulation && (
          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 14 }}>
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 4 }}>🏠 LOCAL GANA</div>
              <div style={{ fontSize: 36, fontWeight: 700, color: favorsHome ? confColor : "#4A6080", lineHeight: 1 }}>{simulation.homeWinPct}%</div>
            </div>
            <div style={{ width: 1, background: "#1A2535" }} />
            <div style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 4 }}>🔴 VISITANTE GANA</div>
              <div style={{ fontSize: 36, fontWeight: 700, color: !favorsHome ? confColor : "#4A6080", lineHeight: 1 }}>{simulation.awayWinPct}%</div>
            </div>
          </div>
        )}
        <div style={{ fontSize: 14, color: confColor, fontWeight: 700 }}>
          {favorsHome ? game.teams.home.team.name : game.teams.away.team.name} — {favPct}% probabilidad
        </div>
        {simulation && (
          <div style={{ fontSize: 12, color: "#4A6080", marginTop: 8 }}>
            Marcador esperado: {simulation.avgHomeRuns} - {simulation.avgAwayRuns} · {isLocked ? "🔒 En curso" : `${time} CT`} · {game.venue?.name}
          </div>
        )}
      </div>

      {/* Calculadora de valor para ML */}
      {!isLocked && simulation && (
        <Accordion title="💰 Valor de mercado (momio manual)" defaultOpen={true}>
          <div style={{ fontSize: 12, color: "#7A9CC0", marginBottom: 10 }}>
            Escribe el momio que ves en la casa. El modelo te dice si hay valor (+EV).
          </div>
          <OddsValueCalc modelProb={simulation.homeWinPct} label={game.teams.home.team.name} />
          <OddsValueCalc modelProb={simulation.awayWinPct} label={game.teams.away.team.name} />
        </Accordion>
      )}

      {/* NRFI / Primer inning (NUEVO) */}
      {simulation && (
        <Accordion title="🥇 Primer inning (NRFI / YRFI)" defaultOpen={true}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div style={{ background: "#0D1520", borderRadius: 10, padding: 14, textAlign: "center", border: `1px solid ${simulation.nrfiPct >= 65 ? "#00E09640" : "#1A2535"}` }}>
              <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 4 }}>NRFI (sin carrera)</div>
              <div style={{ fontSize: 30, fontWeight: 700, color: simulation.nrfiPct >= 65 ? "#00E096" : "#7A9CC0" }}>{simulation.nrfiPct}%</div>
            </div>
            <div style={{ background: "#0D1520", borderRadius: 10, padding: 14, textAlign: "center", border: `1px solid ${simulation.yrfiPct >= 65 ? "#FF9F4340" : "#1A2535"}` }}>
              <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 4 }}>YRFI (sí carrera)</div>
              <div style={{ fontSize: 30, fontWeight: 700, color: simulation.yrfiPct >= 65 ? "#FF9F43" : "#7A9CC0" }}>{simulation.yrfiPct}%</div>
            </div>
          </div>
          {!isLocked && <OddsValueCalc modelProb={simulation.nrfiPct} label="NRFI" />}
          <div style={{ fontSize: 11, color: "#4A6080", marginTop: 10, lineHeight: 1.5 }}>
            ⚠️ El primer inning solo considera al SP titular (no bullpen) y la tendencia de cada ofensiva. La precisión mejora con datos play-by-play por entrada (próxima versión).
          </div>
        </Accordion>
      )}

      {/* Pitchers — LOCAL izquierda, VISITANTE derecha (consistente) */}
      <Accordion title="⚾ Pitchers" defaultOpen={true}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {teamsOrdered.map(({ label, pitcher, teamName }) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 5 }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
              <div style={{ fontSize: 13, color: "#7A9CC0", marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pitcher.name}</div>
              {pitcher.profile ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                    <RoleBadge role={pitcher.profile.role} />
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, color: "#7A9CC0" }}>{pitcher.profile.pitchHand === "L" ? "🤚 Zurdo" : "✋ Diestro"}</span>
                      <TrendBadge trend={pitcher.profile.recentTrend} />
                    </div>
                  </div>
                  <div style={{ background: "#0D1520", borderRadius: 8, padding: "10px", marginBottom: 8 }}>
                    <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 2 }}>FIP mediana últ.{pitcher.profile.lastOutings}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: pitcher.profile.recentTrend === "hot" ? "#00E096" : pitcher.profile.recentTrend === "cold" ? "#FF6B6B" : "#FFD84D" }}>
                      {pitcher.profile.medianRecentFip}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <StatBox label="FIP temp." value={pitcher.profile.fip} highlight />
                    <StatBox label="ERA temp." value={pitcher.profile.era} />
                    <StatBox label="K%" value={pitcher.profile.kPct} />
                    <StatBox label="BB%" value={pitcher.profile.bbPct} />
                    <StatBox label="WHIP" value={pitcher.profile.whip} />
                    <StatBox label="IP/salida" value={String(pitcher.profile.avgIP)} />
                  </div>
                </>
              ) : <div style={{ fontSize: 13, color: "#4A6080" }}>Por confirmar</div>}
            </div>
          ))}
        </div>
      </Accordion>

      {/* Ofensiva — mismo orden LOCAL / VISITANTE */}
      <Accordion title="🏏 Ofensiva">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          {teamsOrdered.map(({ label, offense, vsHand, teamName }) => (
            <div key={label}>
              <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
              {offense ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
                    <StatBox label="R/G" value={offense.runsPerGame} highlight />
                    <StatBox label="OPS" value={offense.ops} />
                  </div>
                  {vsHand && (
                    <div style={{ background: "#0D1520", borderRadius: 8, padding: "10px" }}>
                      <div style={{ fontSize: 11, color: "#4A6080", marginBottom: 6 }}>vs pitcher {vsHand === "L" ? "ZURDO" : "DIESTRO"}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, color: "#4A6080" }}>OPS vs Z</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: vsHand === "L" ? "#FFD84D" : "#7A9CC0" }}>{offense.opsVsLeft}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 10, color: "#4A6080" }}>OPS vs D</div>
                          <div style={{ fontSize: 16, fontWeight: 700, color: vsHand === "R" ? "#FFD84D" : "#7A9CC0" }}>{offense.opsVsRight}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : <div style={{ fontSize: 13, color: "#4A6080" }}>Sin datos</div>}
            </div>
          ))}
        </div>
      </Accordion>

      {/* Pick buttons — LOCAL primero */}
      {!isLocked && (alreadyPicked ? (
        <div style={{ background: "#00E09615", border: "1px solid #00E09640", borderRadius: 12, padding: "12px", marginTop: 12, textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "#00E096" }}>✓ Pick registrado: <strong>{alreadyPicked.my_pick}</strong></div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 8 }}>REGISTRAR PICK</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={() => onSavePick(analysis, game.teams.home.team.name)} disabled={savingPick}
              style={{ padding: "12px", borderRadius: 10, border: `1px solid ${favorsHome ? "#00E09640" : "#1A2535"}`, background: favorsHome ? "#00E09610" : "#1A2535", color: favorsHome ? "#00E096" : "#7A9CC0", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
              🏠 {game.teams.home.team.name}
            </button>
            <button onClick={() => onSavePick(analysis, game.teams.away.team.name)} disabled={savingPick}
              style={{ padding: "12px", borderRadius: 10, border: `1px solid ${!favorsHome ? "#FF9F4340" : "#1A2535"}`, background: !favorsHome ? "#FF9F4310" : "#1A2535", color: !favorsHome ? "#FF9F43" : "#7A9CC0", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
              🔴 {game.teams.away.team.name}
            </button>
          </div>
          {pickSaved && <div style={{ textAlign: "center", color: "#00E096", fontSize: 13, marginTop: 8 }}>✓ Pick guardado</div>}
        </div>
      ))}
    </div>
  );
}

// ─── PICKS VIEW ───────────────────────────────────────────────
function PicksView({ picks, onMarkResult, wins, losses, winRate }: {
  picks: Pick[]; onMarkResult: (gk: number, r: "W" | "L") => void;
  wins: number; losses: number; winRate: number;
}) {
  return (
    <div style={{ padding: "16px 18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        {[["GANADOS", wins, "#00E096"], ["PERDIDOS", losses, "#FF6B6B"], ["WIN RATE", `${winRate}%`, "#FFD84D"]].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0D1520", border: `1px solid ${c}25`, borderRadius: 12, padding: "12px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.08em" }}>{l}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: c as string, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>
      {picks.length === 0 ? (
        <div style={{ textAlign: "center", color: "#4A6080", marginTop: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
          <div style={{ fontSize: 15 }}>No hay picks registrados</div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Registra picks para construir tu historial de backtesting</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {picks.map(pick => (
            <div key={pick.game_pk} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 12, padding: "14px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <div style={{ fontSize: 12, color: "#4A6080" }}>{pick.game_date}</div>
                <div style={{ fontSize: 12, color: "#7A9CC0" }}>MC {pick.mc_home}% local</div>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 5 }}>🏠 {pick.home_team} vs 🔴 {pick.away_team}</div>
              <div style={{ fontSize: 13, color: "#7A9CC0", marginBottom: 10 }}>Pick: <strong style={{ color: "#E8EDF5" }}>{pick.my_pick}</strong></div>
              {pick.result ? (
                <div style={{ display: "inline-block", padding: "4px 12px", borderRadius: 7, fontSize: 13, fontWeight: 700, background: pick.result === "W" ? "#00E09620" : "#FF6B6B20", color: pick.result === "W" ? "#00E096" : "#FF6B6B", border: `1px solid ${pick.result === "W" ? "#00E09640" : "#FF6B6B40"}` }}>
                  {pick.result === "W" ? "✓ GANADO" : "✗ PERDIDO"}
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => onMarkResult(pick.game_pk, "W")} style={{ flex: 1, padding: "8px", borderRadius: 8, border: "1px solid #00E09640", background: "#00E09615", color: "#00E096", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>✓ GANADO</button>
                  <button onClick={() => onMarkResult(pick.game_pk, "L")} style={{ flex: 1, padding: "8px", borderRadius: 8, border: "1px solid #FF6B6B40", background: "#FF6B6B15", color: "#FF6B6B", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>✗ PERDIDO</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
