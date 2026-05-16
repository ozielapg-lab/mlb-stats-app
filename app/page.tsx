"use client";
import { useEffect, useState } from "react";

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
  era: string;
  whip: string;
  strikeOuts: string;
  baseOnBalls: string;
  inningsPitched: string;
  wins: string;
  losses: string;
}

interface TeamStats {
  avg: string;
  ops: string;
  runs: string;
  homeRuns: string;
}

interface GameAnalysis {
  game: Game;
  homePitcher: { name: string; stats: PitcherStats | null };
  awayPitcher: { name: string; stats: PitcherStats | null };
  homeTeamStats: TeamStats | null;
  awayTeamStats: TeamStats | null;
  score: number;
  recommendation: string;
  confidence: number;
}

async function fetchPitcherStats(pitcherId: number): Promise<PitcherStats | null> {
  try {
    const res = await fetch(`${MLB_API}/people/${pitcherId}/stats?stats=season&season=2025&group=pitching`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits?.length) return null;
    const s = splits[0].stat;
    return {
      era: s.era ?? "N/A",
      whip: s.whip ?? "N/A",
      strikeOuts: s.strikeOuts ?? "0",
      baseOnBalls: s.baseOnBalls ?? "0",
      inningsPitched: s.inningsPitched ?? "0",
      wins: s.wins ?? "0",
      losses: s.losses ?? "0",
    };
  } catch { return null; }
}

async function fetchTeamStats(teamId: number): Promise<TeamStats | null> {
  try {
    const res = await fetch(`${MLB_API}/teams/${teamId}/stats?stats=season&season=2025&group=hitting`);
    const data = await res.json();
    const splits = data.stats?.[0]?.splits;
    if (!splits?.length) return null;
    const s = splits[0].stat;
    return {
      avg: s.avg ?? ".000",
      ops: s.ops ?? ".000",
      runs: s.runs ?? "0",
      homeRuns: s.homeRuns ?? "0",
    };
  } catch { return null; }
}

function calcScore(homePitcher: PitcherStats | null, awayPitcher: PitcherStats | null, homeTeam: TeamStats | null, awayTeam: TeamStats | null): { score: number; rec: string; conf: number } {
  let score = 50;
  if (homePitcher) {
    const era = parseFloat(homePitcher.era);
    if (!isNaN(era)) score += era < 3.0 ? 15 : era < 4.0 ? 8 : era < 5.0 ? 0 : -8;
    const whip = parseFloat(homePitcher.whip);
    if (!isNaN(whip)) score += whip < 1.1 ? 10 : whip < 1.3 ? 4 : -5;
  }
  if (awayPitcher) {
    const era = parseFloat(awayPitcher.era);
    if (!isNaN(era)) score -= era < 3.0 ? 15 : era < 4.0 ? 8 : era < 5.0 ? 0 : -8;
  }
  if (homeTeam) {
    const ops = parseFloat(homeTeam.ops);
    if (!isNaN(ops)) score += ops > 0.800 ? 8 : ops > 0.720 ? 3 : -3;
  }
  score = Math.max(20, Math.min(80, score));
  const rec = score >= 62 ? "✅ Local favorito" : score <= 38 ? "⚠️ Visitante ventaja" : "➡️ Partido parejo";
  const conf = Math.round(Math.abs(score - 50) * 2);
  return { score, rec, conf };
}

function getRating(score: number): { stars: number; color: string; label: string } {
  if (score >= 65) return { stars: 5, color: "#00E096", label: "FUERTE" };
  if (score >= 58) return { stars: 4, color: "#7DF9A6", label: "BUENO" };
  if (score >= 45) return { stars: 3, color: "#FFD84D", label: "NEUTRO" };
  if (score >= 35) return { stars: 2, color: "#FF9F43", label: "DÉBIL" };
  return { stars: 1, color: "#FF6B6B", label: "EVITAR" };
}

export default function MLBApp() {
  const [games, setGames] = useState<GameAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GameAnalysis | null>(null);
  const [loadingMsg, setLoadingMsg] = useState("Jalando juegos del día...");

  useEffect(() => {
    async function load() {
      try {
        const today = new Date().toISOString().split("T")[0];
        setLoadingMsg("Jalando juegos del día...");
        const res = await fetch(`${MLB_API}/schedule?sportId=1&date=${today}&hydrate=probablePitcher`);
        const data = await res.json();
        const gameList: Game[] = data.dates?.[0]?.games ?? [];

        setLoadingMsg(`Analizando ${gameList.length} juegos...`);

        const analyses: GameAnalysis[] = await Promise.all(
          gameList.map(async (game) => {
            const homePitcherId = game.teams.home.probablePitcher?.id;
            const awayPitcherId = game.teams.away.probablePitcher?.id;

            const [homePStats, awayPStats, homeTeamStats, awayTeamStats] = await Promise.all([
              homePitcherId ? fetchPitcherStats(homePitcherId) : Promise.resolve(null),
              awayPitcherId ? fetchPitcherStats(awayPitcherId) : Promise.resolve(null),
              fetchTeamStats(game.teams.home.team.id),
              fetchTeamStats(game.teams.away.team.id),
            ]);

            const { score, rec, conf } = calcScore(homePStats, awayPStats, homeTeamStats, awayTeamStats);

            return {
              game,
              homePitcher: { name: game.teams.home.probablePitcher?.fullName ?? "Por confirmar", stats: homePStats },
              awayPitcher: { name: game.teams.away.probablePitcher?.fullName ?? "Por confirmar", stats: awayPStats },
              homeTeamStats,
              awayTeamStats,
              score,
              recommendation: rec,
              confidence: conf,
            };
          })
        );

        setGames(analyses.sort((a, b) => b.score - a.score));
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const today = new Date().toLocaleDateString("es-MX", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div style={{ minHeight: "100vh", background: "#080C14", color: "#E8EDF5", fontFamily: "'DM Mono', 'Courier New', monospace" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #1A2535", padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0A0F1A" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, #C8102E, #002D72)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚾</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "0.08em", color: "#E8EDF5" }}>MLB STATS</div>
            <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.15em" }}>ANÁLISIS DE APUESTAS</div>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#4A6080", textAlign: "right" }}>
          <div>{today}</div>
          <div style={{ color: "#00E096", marginTop: 2 }}>{games.length} juegos analizados</div>
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60vh", gap: 16 }}>
          <div style={{ width: 48, height: 48, border: "3px solid #1A2535", borderTopColor: "#00E096", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: "#4A6080", fontSize: 13, letterSpacing: "0.1em" }}>{loadingMsg}</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); }}`}</style>
        </div>
      ) : selected ? (
        <DetailView analysis={selected} onBack={() => setSelected(null)} />
      ) : (
        <div style={{ padding: "20px 24px" }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: "#4A6080", letterSpacing: "0.15em", marginBottom: 4 }}>MEJORES PICKS DEL DÍA</div>
            <div style={{ fontSize: 13, color: "#7A9CC0" }}>Ordenados por score de confianza • Toca para ver análisis completo</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {games.map((a, i) => <GameCard key={a.game.gamePk} analysis={a} rank={i + 1} onClick={() => setSelected(a)} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function GameCard({ analysis, rank, onClick }: { analysis: GameAnalysis; rank: number; onClick: () => void }) {
  const { game, homePitcher, awayPitcher, score, recommendation, confidence } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });

  return (
    <div onClick={onClick} style={{ background: "#0D1520", border: `1px solid ${rank <= 3 ? rating.color + "40" : "#1A2535"}`, borderRadius: 12, padding: "14px 16px", cursor: "pointer", transition: "all 0.15s", position: "relative", overflow: "hidden" }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = rating.color + "80")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = rank <= 3 ? rating.color + "40" : "#1A2535")}>
      {rank <= 3 && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${rating.color}, transparent)` }} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: "#1A2535", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#4A6080", fontWeight: 700 }}>#{rank}</div>
          <div style={{ fontSize: 12, color: "#4A6080" }}>{time} CT</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontSize: 11, color: rating.color, fontWeight: 700, letterSpacing: "0.1em" }}>{rating.label}</div>
          <div style={{ background: rating.color + "20", border: `1px solid ${rating.color}50`, borderRadius: 6, padding: "2px 8px", fontSize: 13, fontWeight: 700, color: rating.color }}>{score}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#E8EDF5" }}>{game.teams.away.team.name}</div>
          <div style={{ fontSize: 11, color: "#4A6080", marginTop: 2 }}>🔴 {awayPitcher.name}</div>
        </div>
        <div style={{ padding: "4px 12px", color: "#4A6080", fontSize: 12 }}>VS</div>
        <div style={{ flex: 1, textAlign: "right" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#E8EDF5" }}>{game.teams.home.team.name}</div>
          <div style={{ fontSize: 11, color: "#4A6080", marginTop: 2 }}>{homePitcher.name} 🏠</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid #1A2535" }}>
        <div style={{ fontSize: 12, color: rating.color }}>{recommendation}</div>
        <div style={{ fontSize: 11, color: "#4A6080" }}>Confianza: <span style={{ color: "#7A9CC0" }}>{confidence}%</span></div>
      </div>
    </div>
  );
}

function StatBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "#080C14", borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
      <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#E8EDF5" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#4A6080", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function DetailView({ analysis, onBack }: { analysis: GameAnalysis; onBack: () => void }) {
  const { game, homePitcher, awayPitcher, homeTeamStats, awayTeamStats, score, recommendation, confidence } = analysis;
  const rating = getRating(score);
  const time = new Date(game.gameDate).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Monterrey" });

  return (
    <div style={{ padding: "20px 24px" }}>
      <button onClick={onBack} style={{ background: "none", border: "1px solid #1A2535", borderRadius: 8, color: "#7A9CC0", padding: "8px 14px", cursor: "pointer", fontSize: 12, marginBottom: 20, letterSpacing: "0.05em" }}>← Volver</button>

      {/* Score banner */}
      <div style={{ background: `linear-gradient(135deg, ${rating.color}15, #0D1520)`, border: `1px solid ${rating.color}40`, borderRadius: 12, padding: "20px", marginBottom: 16, textAlign: "center" }}>
        <div style={{ fontSize: 48, fontWeight: 700, color: rating.color, lineHeight: 1 }}>{score}</div>
        <div style={{ fontSize: 13, color: "#7A9CC0", marginTop: 4 }}>Score de análisis</div>
        <div style={{ fontSize: 16, color: rating.color, fontWeight: 600, marginTop: 8 }}>{recommendation}</div>
        <div style={{ fontSize: 12, color: "#4A6080", marginTop: 4 }}>Confianza: {confidence}% • {time} CT • {game.venue?.name}</div>
      </div>

      {/* Teams */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        {/* Away */}
        <div style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 6 }}>VISITANTE</div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{game.teams.away.team.name}</div>
          <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 8 }}>🔴 {awayPitcher.name}</div>
          {awayPitcher.stats ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <StatBox label="ERA" value={awayPitcher.stats.era} />
              <StatBox label="WHIP" value={awayPitcher.stats.whip} />
              <StatBox label="K" value={awayPitcher.stats.strikeOuts} />
              <StatBox label="BB" value={awayPitcher.stats.baseOnBalls} />
            </div>
          ) : <div style={{ fontSize: 12, color: "#4A6080" }}>Stats no disponibles</div>}
          {awayTeamStats && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1A2535" }}>
              <div style={{ fontSize: 10, color: "#4A6080", marginBottom: 6 }}>OFENSIVA</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <StatBox label="AVG" value={awayTeamStats.avg} />
                <StatBox label="OPS" value={awayTeamStats.ops} />
              </div>
            </div>
          )}
        </div>

        {/* Home */}
        <div style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 6 }}>LOCAL</div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>{game.teams.home.team.name}</div>
          <div style={{ fontSize: 11, color: "#7A9CC0", marginBottom: 8 }}>🏠 {homePitcher.name}</div>
          {homePitcher.stats ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <StatBox label="ERA" value={homePitcher.stats.era} />
              <StatBox label="WHIP" value={homePitcher.stats.whip} />
              <StatBox label="K" value={homePitcher.stats.strikeOuts} />
              <StatBox label="BB" value={homePitcher.stats.baseOnBalls} />
            </div>
          ) : <div style={{ fontSize: 12, color: "#4A6080" }}>Stats no disponibles</div>}
          {homeTeamStats && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #1A2535" }}>
              <div style={{ fontSize: 10, color: "#4A6080", marginBottom: 6 }}>OFENSIVA</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <StatBox label="AVG" value={homeTeamStats.avg} />
                <StatBox label="OPS" value={homeTeamStats.ops} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ background: "#0D1520", border: "1px solid #1A2535", borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 10, color: "#4A6080", letterSpacing: "0.1em", marginBottom: 10 }}>CÓMO LEER EL SCORE</div>
        {[
          { range: "65–80", label: "FUERTE", color: "#00E096", desc: "Ventaja clara del local, buen pitcher" },
          { range: "58–64", label: "BUENO", color: "#7DF9A6", desc: "Ligera ventaja, vale la apuesta" },
          { range: "45–57", label: "NEUTRO", color: "#FFD84D", desc: "Partido parejo, evitar o apostar poco" },
          { range: "35–44", label: "DÉBIL", color: "#FF9F43", desc: "Ventaja del visitante" },
          { range: "20–34", label: "EVITAR", color: "#FF6B6B", desc: "No apostar al local" },
        ].map(r => (
          <div key={r.range} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: r.color, flexShrink: 0 }} />
            <div style={{ fontSize: 11, color: r.color, width: 50 }}>{r.range}</div>
            <div style={{ fontSize: 11, color: r.color, fontWeight: 600, width: 55 }}>{r.label}</div>
            <div style={{ fontSize: 11, color: "#4A6080" }}>{r.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
