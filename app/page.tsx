"use client";
import { useEffect, useState } from "react";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const MLB_API = "https://statsapi.mlb.com/api/v1";

interface Game {
  gamePk: number;
  gameDate: string;
  status: { detailedState: string };
  teams: {
    away: { team: { id: number; name: string }; probablePitcher?: { id: number; fullName: string } };
    home: { team: { id: number; name: string }; probablePitcher?: { id: number; fullName: string } };
  };
  venue: { name: string };
}

interface PitcherStats {
  era: string; whip: string; strikeOuts: string;
  baseOnBalls: string; inningsPitched: string; wins: string; losses: string;
}

interface RecentForm {
  recentEra: string;
  trend: "hot" | "cold" | "neutral";
  lastStarts: number;
}

interface TeamStats { avg: string; ops: string; runs: string; homeRuns: string; }

interface GameAnalysis {
  game: Game;
  homePitcher: { name: string; stats: PitcherStats | null; form: RecentForm | null };
  awayPitcher: { name: string; stats: PitcherStats | null; form: RecentForm | null };
  homeTeamStats: TeamStats | null;
  awayTeamStats: TeamStats | null;
  score: number;
  recommendation: string;
  confidence: number;
}

interface Pick {
  id: number;
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

async function fetchPitcherStats(pitcherId: number): Promise<PitcherStats | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${pitcherId}/stats?stats=season&season=2025&group=pitching`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits?.length) return null;
    const s = splits[0].stat;
    return { era: s.era ?? "N/A", whip: s.whip ?? "N/A", strikeOuts: s.strikeOuts ?? "0", baseOnBalls: s.baseOnBalls ?? "0", inningsPitched: s.inningsPitched ?? "0", wins: s.wins ?? "0", losses: s.losses ?? "0" };
  } catch { return null; }
}

async function fetchRecentForm(pitcherId: number): Promise<RecentForm | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${pitcherId}/stats?stats=gameLog&season=2025&group=pitching`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits ?? [];
    const last5 = splits.slice(-5);
    if (!last5.length) return null;
    let totalER = 0, totalIP = 0;
    for (const g of last5) {
      const ip = parseFloat(g.stat.inningsPitched ?? "0");
      const er = parseFloat(g.stat.earnedRuns ?? "0");
      totalER += er;
      totalIP += ip;
    }
    const recentEra = totalIP > 0 ? ((totalER * 9) / totalIP).toFixed(2) : "N/A";
    const recentEraNum = parseFloat(recentEra);
    const trend = recentEraNum < 3.0 ? "hot" : recentEraNum > 5.0 ? "cold" : "neutral";
    return { recentEra, trend, lastStarts: last5.length };
  } catch { return null; }
}

async function fetchTeamStats(teamId: number): Promise<TeamStats | null> {
  try {
    const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&season=2025&group=hitting`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits?.length) return null;
    const s = splits[0].stat;
    return { avg: s.avg ?? ".000", ops: s.ops ?? ".000", runs: s.runs ?? "0", homeRuns: s.homeRuns ?? "0" };
  } catch { return null; }
}

function calcScore(hp: PitcherStats | null, ap: PitcherStats | null, ht: TeamStats | null, at: TeamStats | null, hf: RecentForm | null, af: RecentForm | null) {
  let score = 50;
  if (hp) {
    const era = parseFloat(hp.era);
    if (!isNaN(era)) score += era < 3.0 ? 12 : era < 4.0 ? 6 : era < 5.0 ? 0 : -6;
    const whip = parseFloat(hp.whip);
    if (!isNaN(whip)) score += whip < 1.1 ? 8 : whip < 1.3 ? 3 : -4;
  }
  if (hf) {
    if (hf.trend === "hot") score += 10;
    else if (hf.trend === "cold") score -= 10;
  }
  if (ap) {
    const era = parseFloat(ap.era);
    if (!isNaN(era)) score -= era < 3.0 ? 12 : era < 4.0 ? 6 : era < 5.0 ? 0 : -6;
  }
  if (af) {
    if (af.trend === "hot") score -= 10;
    else if (af.trend === "cold") score += 10;
  }
  if (ht) {
    const ops = parseFloat(ht.ops);
    if (!isNaN(ops)) score += ops > 0.800 ? 6 : ops > 0.720 ? 2 : -2;
  }
  score = Math.max(15, Math.min(85, score));
  const rec = score >= 62 ? "✅ Local favorito" : score <= 38 ? "⚠️ Visitante ventaja" : "➡️ Partido parejo";
  return { score, rec, conf: Math.round(Math.abs(score - 50) * 2) };
}

function getRating(score: number) {
  if (score >= 65) return { color: "#00E096", label: "FUERTE" };
  if (score >= 58) return { color: "#7DF9A6", label: "BUENO" };
  if (score >= 45) return { color: "#FFD84D", label: "NEUTRO" };
  if (score >= 35) return { color: "#FF9F43", label: "DÉBIL" };
  return { color: "#FF6B6B", label: "EVITAR" };
}

function getTrendEmoji(form: RecentForm | null) {
  if (!form) return "";
  if (form.trend === "hot") return "🔥";
  if (form.trend === "cold") return "📉";
  return "➡️";
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

async function dbUpdate(id: number, row: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/picks?id=eq.${id}`, {
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
        const [hp, ap, ht, at, hf, af] = await Promise.all([
          hpId ? fetchPitcherStats(hpId) : null,
          apId ? fetchPitcherStats(apId) : null,
          fetchTeamStats(game.teams.home.team.id),
          fetchTeamStats(game.teams.away.team.id),
          hpId ? fetchRecentForm(hpId) : null,
          apId ? fetchRecentForm(apId) : null,
        ]);
        const { score, rec, conf } = calcScore(hp, ap, ht, at, hf, af);
        return {
          game,
          homePitcher: { name: game.teams.home.probablePitcher?.fullName ?? "Por confirmar", stats: hp, form: hf },
          awayPitcher: { name: game.teams.away.probablePitcher?.fullName ?? "Por confirmar", stats: ap, form: af },
          homeTeamStats: ht, awayTeamStats: at, score, recommendation: rec, confidence: conf
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

  async function markResult(pickId: number, result: "W" | "L") {
    await dbUpdate(pickId, { result });
    dbGet().then(setPicks);
  }

  const today = new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const wins = picks.filter(p => p.result === "W").length;
  const losses = picks.filter(p => p.result === "L").length;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;

  return (
    <div style={{ minHeight: "100vh", background: "#080C14", color: "#E8EDF5", fontFamily: "'DM Mono', 'Courier New', monospace" }}>
      <div style={{ borderBottom: "1px solid #1A2535", padding: "16px 20px", background: "#0A0F1A" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, #C8102E, #002D72)", display: "flex", alignItems: "center", justifyContent: "center" }}>⚾</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.08em" }}>MLB STATS</div>
              <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em" }}>ANÁLISIS DE APUESTAS</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#4A6080", textAlign: "right" }}>
            <div style={{ color: "#00E096" }}>{games.length} juegos</div>
            <div>{wins}W {losses}L {winRate > 0 ? `${winRate}%` : ""}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["games", "picks"].map(t => (
            <button key={t} onClick={() => { setView(t as "games" | "picks"); setSelected(null); }}
              style={{ flex: 1, padding: "8px", borderRadius: 8, border: "1px solid", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: "0.05em", borderColor: view === t ? "#00E096" : "#1A2535", background: view === t ? "#00E09615" : "transparent", color: view === t ? "#00E096" : "#4A6080" }}>
              {t === "games" ? `🎮 JUEGOS (${games.length})` : `📊 MIS PICKS (${picks.length})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "50vh", gap: 16 }}>
          <div style={{ width: 40, height: 40, border: "3px solid #1A2535", borderTopColor: "#00E096", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: "#4A6080", fontSize: 12 }}>Analizando juegos y forma reciente...</div>
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
  const { game, homePitcher, awayPitcher, score, recommendation, confidence } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const alreadyPicked = picks.some(p => p.game_pk === game.gamePk);
  const homeTrend = getTrendEmoji(homePitcher.form);
  const awayTrend = getTrendEmoji(awayPitcher.form);

  return (
    <div onClick={onClick} style={{ background: "#0D1520", border: `1px solid ${rank <= 3 ? rating.color + "40" : "#1A2535"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", position: "relative", overflow: "hidden" }}>
      {rank <= 3 && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${rating.color}, transparent)` }} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 20, height: 20, borderRadius: 4, background: "#1A2535", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#4A6080", fontWeight: 700 }}>#{rank}</div>
          <div style={{ fontSize: 11, color: "#4A6080" }}>{time} CT</div>
          {alreadyPicked && <div style={{ fontSize: 10, color: "#00E096", background: "#00E09615", border: "1px solid #00E09640", borderRadius: 4, padding: "1px 5px" }}>✓</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 10, color: rating.color, fontWeight: 700 }}>{rating.label}</div>
          <div style={{ background: rating.color + "20", border: `1px solid ${rating.color}50`, borderRadius: 6, padding: "2px 8px", fontSize: 13, fontWeight: 700, color: rating.color }}>{score}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.away.team.name}</div>
          <div style={{ fontSize: 11, color: "#4A6080", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>🔴 {awayPitcher.name} {awayTrend}</div>
        </div>
        <div style={{ padding: "0 8px", color: "#4A6080", fontSize: 10, flexShrink: 0 }}>VS</div>
        <div style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{game.teams.home.team.name}</div>
          <div style={{ fontSize: 11, color: "#4A6080", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{homeTrend} {homePitcher.name} 🏠</div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, borderTop: "1px solid #1A2535" }}>
        <div style={{ fontSize: 11, color: rating.color }}>{recommendation}</div>
        <div style={{ fontSize: 11, color: "#4A6080" }}>Conf: <span style={{ color: "#7A9CC0" }}>{confidence}%</span></div>
      </div>
    </div>
  );
}

function DetailView({ analysis, onBack, onSavePick, savingPick, pickSaved, picks }: { analysis: GameAnalysis; onBack: () => void; onSavePick: (a: GameAnalysis, pick: string) => void; savingPick: boolean; pickSaved: boolean; picks: Pick[] }) {
  const { game, homePitcher, awayPitcher, homeTeamStats, awayTeamStats, score, recommendation, confidence } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });
  const alreadyPicked = picks.find(p => p.game_pk === game.gamePk);

  return (
    <div style={{ padding: "16px 20px" }}>
      <button onClick={onBack} style={{ background: "none", border: "1px solid #1A2535", borderRadius: 8, color: "#7A9CC0", padding: "6px 12px", cursor: "pointer", fontSize: 12, marginBottom: 16 }}>← Volver</button>
      <div style={{ background: `linear-gradient(135deg, ${rating.color}15, #0D1520)`, border: `1px solid ${rating.color}40`, borderRadius: 12, padding: "16px", marginBottom: 14, textAlign: "center" }}>
        <div style={{ fontSize: 44, fontWeight: 700, color: rating.color, lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: 12, color: "#7A9CC0", marginTop: 4 }}>Score de análisis</div>
        <div style={{ fontSize: 15, color: rating.color, fontWeight: 600, marginTop: 6 }}>{recommendation}</div>
        <div style={{ fontSize: 11, color: "#4A6080", marginTop: 4 }}>{time} CT • {game.venue?.name}</div>
      </div>

      {alreadyPicked ? (
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
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[
          { label: "VISITANTE", pitcher: awayPitcher, team: awayTeamStats, emoji: "🔴", teamName: game.teams.away.team.name },
          { label: "LOCAL", pitcher: homePitcher, team: homeTeamStats, emoji: "🏠", teamName: game.teams.home.team.name }
        ].map(({ label, pitcher, team, emoji, teamName }) => (
          <div key={label} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{teamName}</div>
            <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{emoji} {pitcher.name}</div>
            {pitcher.form && (
              <div style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 6, background: pitcher.form.trend === "hot" ? "#00E09615" : pitcher.form.trend === "cold" ? "#FF6B6B15" : "#1A2535", border: `1px solid ${pitcher.form.trend === "hot" ? "#00E09640" : pitcher.form.trend === "cold" ? "#FF6B6B40" : "#1A2535"}` }}>
                <div style={{ fontSize: 9, color: "#4A6080" }}>ÚLTIMAS {pitcher.form.lastStarts} SALIDAS</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: pitcher.form.trend === "hot" ? "#00E096" : pitcher.form.trend === "cold" ? "#FF6B6B" : "#FFD84D" }}>
                  ERA {pitcher.form.recentEra} {getTrendEmoji(pitcher.form)}
                </div>
              </div>
            )}
            {pitcher.stats ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                {[["ERA", pitcher.stats.era], ["WHIP", pitcher.stats.whip], ["K", pitcher.stats.strikeOuts], ["BB", pitcher.stats.baseOnBalls]].map(([l, v]) => (
                  <div key={l} style={{ background: "#080C14", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: "#4A6080" }}>{l} temp.</div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{v}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ fontSize: 11, color: "#4A6080" }}>Sin datos</div>}
            {team && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #1A2535" }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                  {[["AVG", team.avg], ["OPS", team.ops]].map(([l, v]) => (
                    <div key={l} style={{ background: "#080C14", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: "#4A6080" }}>{l}</div>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{v}</div>
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

function PicksView({ picks, onMarkResult, wins, losses, winRate }: { picks: Pick[]; onMarkResult: (id: number, r: "W" | "L") => void; wins: number; losses: number; winRate: number }) {
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
              <div key={pick.id} style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: "12px 14px" }}>
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
                    <button onClick={() => onMarkResult(pick.id, "W")} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #00E09640", background: "#00E09615", color: "#00E096", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>✓ GANADO</button>
                    <button onClick={() => onMarkResult(pick.id, "L")} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid #FF6B6B40", background: "#FF6B6B15", color: "#FF6B6B", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>✗ PERDIDO</button>
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
