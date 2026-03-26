import { useState, useMemo, useEffect, useCallback } from "react";

const MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const MLB_PEOPLE_URL = "https://statsapi.mlb.com/api/v1/people";
const MLB_GAME_URL = "https://statsapi.mlb.com/api/v1.1/game";

const TEAM_ABBR = {
  "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
  "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
  "New York Yankees": "NYY", "Oakland Athletics": "OAK", "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
};

const PARK_FACTORS = {
  COL: 1.32, ARI: 1.08, BOS: 1.07, CIN: 1.06, TEX: 1.05, TOR: 1.04,
  CHC: 1.03, PHI: 1.02, ATL: 1.01, LAA: 1.01, MIL: 1.00, MIN: 1.00,
  NYY: 0.99, BAL: 0.99, DET: 0.98, SF: 0.98, CWS: 0.97, WSH: 0.97,
  KC: 0.97, HOU: 0.96, PIT: 0.96, STL: 0.96, CLE: 0.95, SD: 0.95,
  NYM: 0.95, LAD: 0.94, SEA: 0.93, TB: 0.93, MIA: 0.92, OAK: 0.92,
};

// Wind direction effect by park (degrees where wind blowing OUT helps HR)
// Simplified: parks with open outfield in certain directions
const WIND_PARK_SENSITIVITY = {
  CHC: 1.5, BOS: 1.2, CIN: 1.1, SF: 1.3, PIT: 1.0, CLE: 1.0,
  NYM: 0.9, NYY: 0.9, PHI: 0.8, COL: 0.7, // Coors already high base
};

const LG = {
  era: 4.20, whip: 1.27, k9: 8.0, bb9: 3.2, hr9: 1.20, scoringPct: 0.258,
  obp: 0.317, slg: 0.420, woba: 0.315, kPct: 0.224, bbPct: 0.083,
};

// =========================================================================
// PITCHER STATS (season + first-inning splits)
// =========================================================================

async function fetchPitcherStats(playerId) {
  try {
    const [seasonRes, splitRes] = await Promise.all([
      fetch(`${MLB_PEOPLE_URL}/${playerId}/stats?stats=season&group=pitching&sportId=1`),
      fetch(`${MLB_PEOPLE_URL}/${playerId}/stats?stats=statSplits&group=pitching&sportId=1&sitCodes=1i`),
    ]);
    const seasonData = await seasonRes.json();
    const splitData = await splitRes.json();

    const s = seasonData?.stats?.[0]?.splits?.[0]?.stat;
    const fi = splitData?.stats?.[0]?.splits?.[0]?.stat;

    const season = s ? {
      era: parseFloat(s.era) || LG.era,
      whip: parseFloat(s.whip) || LG.whip,
      k9: parseFloat(s.strikeoutsPer9Inn) || LG.k9,
      bb9: parseFloat(s.walksPer9Inn) || LG.bb9,
      hr9: parseFloat(s.homeRunsPer9) || LG.hr9,
      ip: parseFloat(s.inningsPitched) || 0,
    } : null;

    const firstInning = fi ? {
      era: parseFloat(fi.era) || null,
      whip: parseFloat(fi.whip) || null,
      k9: parseFloat(fi.strikeoutsPer9Inn) || null,
      bb9: parseFloat(fi.walksPer9Inn) || null,
      hr9: parseFloat(fi.homeRunsPer9) || null,
      ip: parseFloat(fi.inningsPitched) || 0,
      avg: parseFloat(fi.avg) || null,
      obp: parseFloat(fi.obp) || null,
    } : null;

    return { season, firstInning };
  } catch { return { season: null, firstInning: null }; }
}

// =========================================================================
// LINEUP DATA (top of the order batters)
// =========================================================================

async function fetchLineup(gameId, teamType) {
  try {
    const res = await fetch(`${MLB_GAME_URL}/${gameId}/feed/live`);
    const data = await res.json();
    const boxscore = data?.liveData?.boxscore;
    if (!boxscore) return null;

    const teamKey = teamType === "away" ? "away" : "home";
    const teamData = boxscore.teams?.[teamKey];
    if (!teamData) return null;

    const battingOrder = teamData.battingOrder || [];
    if (!battingOrder.length) return null;

    // Get top 4 batters (they bat in the 1st inning)
    const topBatters = battingOrder.slice(0, 4);
    const players = teamData.players || {};

    const batterStats = await Promise.all(topBatters.map(async (pid) => {
      const p = players[`ID${pid}`];
      const name = p?.person?.fullName || "Unknown";
      const hand = p?.person?.batSide?.code || "R";

      try {
        const r = await fetch(`${MLB_PEOPLE_URL}/${pid}/stats?stats=season&group=hitting&sportId=1`);
        const d = await r.json();
        const s = d?.stats?.[0]?.splits?.[0]?.stat;
        if (!s) return { name, hand, obp: LG.obp, slg: LG.slg, woba: LG.woba, kPct: LG.kPct, bbPct: LG.bbPct, ops: LG.obp + LG.slg };
        return {
          name, hand,
          obp: parseFloat(s.obp) || LG.obp,
          slg: parseFloat(s.slg) || LG.slg,
          woba: parseFloat(s.ops) ? (parseFloat(s.obp) * 0.7 + parseFloat(s.slg) * 0.3) : LG.woba, // approximate wOBA
          kPct: s.atBats > 0 ? (parseFloat(s.strikeOuts) / parseFloat(s.atBats)) : LG.kPct,
          bbPct: s.plateAppearances > 0 ? (parseFloat(s.baseOnBalls) / parseFloat(s.plateAppearances)) : LG.bbPct,
          ops: parseFloat(s.ops) || (LG.obp + LG.slg),
          avg: parseFloat(s.avg) || 0.250,
          pa: parseFloat(s.plateAppearances) || 0,
        };
      } catch { return { name, hand, obp: LG.obp, slg: LG.slg, woba: LG.woba, kPct: LG.kPct, bbPct: LG.bbPct }; }
    }));

    return batterStats;
  } catch { return null; }
}

// =========================================================================
// WEATHER
// =========================================================================

async function fetchWeather(gameId) {
  try {
    const res = await fetch(`${MLB_GAME_URL}/${gameId}/feed/live`);
    const data = await res.json();
    const weather = data?.gameData?.weather;
    if (!weather) return null;
    return {
      temp: parseInt(weather.temp) || null,
      wind: weather.wind || "",
      condition: weather.condition || "",
    };
  } catch { return null; }
}

function parseWind(windStr) {
  if (!windStr) return { speed: 0, direction: "" };
  const match = windStr.match(/(\d+)\s*mph/i);
  const speed = match ? parseInt(match[1]) : 0;
  const dirLower = windStr.toLowerCase();
  let direction = "calm";
  if (dirLower.includes("out")) direction = "out";
  else if (dirLower.includes("in")) direction = "in";
  else if (dirLower.includes("cross") || dirLower.includes("left") || dirLower.includes("right")) direction = "cross";
  return { speed, direction };
}

// =========================================================================
// ENHANCED MODEL
// =========================================================================

function estimatePZero(pitcher, parkFactor, isHomeBatting, lineup, weather, homeAbbr) {
  const baseP = 1 - LG.scoringPct;
  let lo = Math.log(baseP / (1 - baseP));

  // --- PITCHER STATS ---
  const fi = pitcher?.firstInning;
  const ss = pitcher?.season;

  if (fi && fi.ip >= 5) {
    // Use first-inning splits (strongest signal)
    const fiWeight = Math.min(fi.ip / 20, 0.7); // cap FI weight, blend with season
    const sWeight = ss ? Math.min(ss.ip / 80, 1) : 0;

    const era = fi.era != null ? (fi.era * fiWeight + (ss?.era || LG.era) * (1 - fiWeight)) : (ss?.era || LG.era);
    const whip = fi.whip != null ? (fi.whip * fiWeight + (ss?.whip || LG.whip) * (1 - fiWeight)) : (ss?.whip || LG.whip);
    const k9 = fi.k9 != null ? (fi.k9 * fiWeight + (ss?.k9 || LG.k9) * (1 - fiWeight)) : (ss?.k9 || LG.k9);
    const bb9 = fi.bb9 != null ? (fi.bb9 * fiWeight + (ss?.bb9 || LG.bb9) * (1 - fiWeight)) : (ss?.bb9 || LG.bb9);
    const hr9 = fi.hr9 != null ? (fi.hr9 * fiWeight + (ss?.hr9 || LG.hr9) * (1 - fiWeight)) : (ss?.hr9 || LG.hr9);

    // Regress toward league average based on total sample
    const regW = Math.min((fi.ip + (ss?.ip || 0)) / 100, 1);
    const rEra = era * regW + LG.era * (1 - regW);
    const rWhip = whip * regW + LG.whip * (1 - regW);
    const rK9 = k9 * regW + LG.k9 * (1 - regW);
    const rBb9 = bb9 * regW + LG.bb9 * (1 - regW);
    const rHr9 = hr9 * regW + LG.hr9 * (1 - regW);

    lo += (LG.era - rEra) * 0.18;
    lo += (LG.whip - rWhip) * 0.9;
    lo += (rK9 - LG.k9) * 0.05;
    lo += (LG.bb9 - rBb9) * 0.07;
    lo += (LG.hr9 - rHr9) * 0.12;
  } else if (ss && ss.ip > 0) {
    // Season stats only (no FI splits available)
    const weight = Math.min(ss.ip / 80, 1);
    const wEra = ss.era * weight + LG.era * (1 - weight);
    const wWhip = ss.whip * weight + LG.whip * (1 - weight);
    const wK9 = ss.k9 * weight + LG.k9 * (1 - weight);
    const wBb9 = ss.bb9 * weight + LG.bb9 * (1 - weight);
    const wHr9 = ss.hr9 * weight + LG.hr9 * (1 - weight);

    lo += (LG.era - wEra) * 0.15;
    lo += (LG.whip - wWhip) * 0.8;
    lo += (wK9 - LG.k9) * 0.04;
    lo += (LG.bb9 - wBb9) * 0.06;
    lo += (LG.hr9 - wHr9) * 0.10;
  }

  // --- LINEUP (top 4 batters) ---
  if (lineup && lineup.length >= 3) {
    const avgObp = lineup.reduce((s, b) => s + (b.obp || LG.obp), 0) / lineup.length;
    const avgSlg = lineup.reduce((s, b) => s + (b.slg || LG.slg), 0) / lineup.length;
    const avgKPct = lineup.reduce((s, b) => s + (b.kPct || LG.kPct), 0) / lineup.length;
    const avgBbPct = lineup.reduce((s, b) => s + (b.bbPct || LG.bbPct), 0) / lineup.length;

    // Better hitters = lower P(0 runs)
    lo -= (avgObp - LG.obp) * 3.5;
    lo -= (avgSlg - LG.slg) * 1.5;
    lo += (avgKPct - LG.kPct) * 0.8; // high-K lineup helps pitcher
    lo -= (avgBbPct - LG.bbPct) * 1.0;
  }

  // --- PARK FACTOR ---
  lo -= ((parkFactor || 1.0) - 1.0) * 1.5;

  // --- WEATHER ---
  if (weather) {
    // Temperature: warmer = ball carries further
    if (weather.temp != null) {
      const tempDiff = (weather.temp - 72) / 100; // baseline 72°F
      lo -= tempDiff * 0.3;
    }

    // Wind
    const wind = parseWind(weather.wind);
    const sensitivity = WIND_PARK_SENSITIVITY[homeAbbr] || 0.5;
    if (wind.direction === "out" && wind.speed > 5) {
      lo -= (wind.speed / 100) * sensitivity * 1.5; // wind out = more runs
    } else if (wind.direction === "in" && wind.speed > 5) {
      lo += (wind.speed / 100) * sensitivity * 1.0; // wind in = fewer runs
    }

    // Dome / indoor parks unaffected (weather usually not reported or shows 0 wind)
  }

  // --- HOME/AWAY ---
  if (isHomeBatting) lo -= 0.02;

  return Math.max(0.50, Math.min(0.93, 1 / (1 + Math.exp(-lo))));
}

// =========================================================================
// DATA FETCHING
// =========================================================================

async function fetchGames(dateStr) {
  const url = `${MLB_SCHEDULE_URL}?sportId=1&date=${dateStr}&hydrate=probablePitcher,linescore,weather`;
  const r = await fetch(url);
  const d = await r.json();
  return d?.dates?.[0]?.games || [];
}

function probToAmerican(p) {
  if (p <= 0 || p >= 1) return "N/A";
  if (p >= 0.5) return `${Math.round(-(p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

// =========================================================================
// UI COMPONENTS
// =========================================================================

function BarCell({ value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 100 }}>
      <div style={{ flex: 1, height: 8, background: "var(--bar-bg)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${value * 100}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.4s ease" }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: "right" }}>
        {(value * 100).toFixed(1)}%
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 80, gap: 16 }}>
      <div style={{ width: 36, height: 36, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <div style={{ color: "var(--muted)", fontSize: 14 }}>Loading games, pitcher splits, lineups & weather...</div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    Final: { bg: "rgba(34,197,94,0.15)", c: "#16a34a", t: "FINAL" },
    "In Progress": { bg: "rgba(59,130,246,0.2)", c: "#3b82f6", t: "LIVE" },
  };
  const s = map[status] || { bg: "rgba(148,163,184,0.15)", c: "#94a3b8", t: "SCHED" };
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: s.bg, color: s.c }}>{s.t}</span>;
}

function ActualBadge({ runs }) {
  if (runs == null) return null;
  const nrfi = runs === 0;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 5, marginLeft: 6,
      background: nrfi ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.12)",
      color: nrfi ? "#16a34a" : "#dc2626" }}>
      {nrfi ? "NRFI \u2713" : `YRFI (${runs}R)`}
    </span>
  );
}

function WeatherBadge({ weather }) {
  if (!weather) return <span style={{ color: "var(--muted)", fontSize: 11 }}>N/A</span>;
  const wind = parseWind(weather.wind);
  const tempColor = weather.temp > 85 ? "var(--red)" : weather.temp < 55 ? "var(--accent)" : "var(--muted)";
  const windIcon = wind.direction === "out" ? "\u2197" : wind.direction === "in" ? "\u2199" : "\u2194";
  const windColor = wind.direction === "out" && wind.speed > 10 ? "var(--red)" : wind.direction === "in" && wind.speed > 10 ? "var(--green)" : "var(--muted)";

  return (
    <div style={{ fontSize: 11, lineHeight: 1.5 }}>
      <span style={{ color: tempColor, fontWeight: 600 }}>{weather.temp}\u00B0F</span>
      {wind.speed > 0 && <>
        <span style={{ color: "var(--border)", margin: "0 3px" }}>|</span>
        <span style={{ color: windColor, fontWeight: 600 }}>{windIcon} {wind.speed}mph {wind.direction}</span>
      </>}
      {weather.condition && <div style={{ color: "var(--border)", fontSize: 10 }}>{weather.condition}</div>}
    </div>
  );
}

function LineupTooltip({ lineup }) {
  if (!lineup || !lineup.length) return <span style={{ color: "var(--muted)", fontSize: 11 }}>No lineup</span>;
  const avgObp = (lineup.reduce((s, b) => s + b.obp, 0) / lineup.length);
  const avgSlg = (lineup.reduce((s, b) => s + b.slg, 0) / lineup.length);
  return (
    <div style={{ fontSize: 11 }}>
      {lineup.map((b, i) => (
        <div key={i} style={{ display: "flex", gap: 6, color: "var(--muted)", lineHeight: 1.6 }}>
          <span style={{ color: "var(--border)", width: 12 }}>{i + 1}.</span>
          <span style={{ color: "var(--text)", fontWeight: 500, flex: 1 }}>{b.name}</span>
          <span>{b.obp?.toFixed(3)}</span>
          <span style={{ color: "var(--border)" }}>/</span>
          <span>{b.slg?.toFixed(3)}</span>
        </div>
      ))}
      <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4, fontWeight: 600, color: "var(--text)" }}>
        Avg: {avgObp.toFixed(3)} OBP / {avgSlg.toFixed(3)} SLG
      </div>
    </div>
  );
}

function FiSplitBadge({ fi }) {
  if (!fi || fi.ip < 2) return <span style={{ color: "var(--muted)", fontSize: 11 }}>No 1st inn data</span>;
  const eraColor = fi.era < 3.0 ? "var(--green)" : fi.era > 5.5 ? "var(--red)" : "var(--text)";
  return (
    <div style={{ fontSize: 11 }}>
      <span style={{ color: eraColor, fontWeight: 700 }}>{fi.era?.toFixed(2)} ERA</span>
      <span style={{ color: "var(--muted)", marginLeft: 6 }}>{fi.whip?.toFixed(2)} WHIP</span>
      <span style={{ color: "var(--muted)", marginLeft: 6 }}>{fi.ip?.toFixed(1)} IP</span>
    </div>
  );
}

// =========================================================================
// MAIN APP
// =========================================================================

export default function App() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState("nrfi");
  const [filter, setFilter] = useState("all");
  const [tab, setTab] = useState("slate");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [calOpen, setCalOpen] = useState(false);
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const loadGames = useCallback(async (dateStr) => {
    setLoading(true);
    setError(null);
    try {
      const raw = await fetchGames(dateStr);
      if (!raw.length) { setGames([]); setLoading(false); return; }

      const processed = await Promise.all(raw.map(async (g) => {
        const away = g.teams?.away?.team?.name || "TBD";
        const home = g.teams?.home?.team?.name || "TBD";
        const awayAbbr = TEAM_ABBR[away] || away.slice(0, 3).toUpperCase();
        const homeAbbr = TEAM_ABBR[home] || home.slice(0, 3).toUpperCase();
        const awayPitcherInfo = g.teams?.away?.probablePitcher;
        const homePitcherInfo = g.teams?.home?.probablePitcher;
        const awayPName = awayPitcherInfo ? awayPitcherInfo.fullName : "TBD";
        const homePName = homePitcherInfo ? homePitcherInfo.fullName : "TBD";

        // Fetch pitcher stats with first-inning splits
        let awayPitcher = { season: null, firstInning: null };
        let homePitcher = { season: null, firstInning: null };
        if (awayPitcherInfo?.id) awayPitcher = await fetchPitcherStats(awayPitcherInfo.id);
        if (homePitcherInfo?.id) homePitcher = await fetchPitcherStats(homePitcherInfo.id);

        // Fetch lineups (only available for started/completed games usually)
        let awayLineup = null, homeLineup = null;
        try {
          awayLineup = await fetchLineup(g.gamePk, "away");
          homeLineup = await fetchLineup(g.gamePk, "home");
        } catch {}

        // Fetch weather
        let weather = null;
        try {
          weather = await fetchWeather(g.gamePk);
        } catch {}
        // Also try inline weather from schedule
        if (!weather && g.weather) {
          weather = { temp: parseInt(g.weather.temp) || null, wind: g.weather.wind || "", condition: g.weather.condition || "" };
        }

        const parkFactor = PARK_FACTORS[homeAbbr] || 1.0;

        // Top of 1st: away batters vs home pitcher
        const topP = estimatePZero(homePitcher, parkFactor, false, awayLineup, weather, homeAbbr);
        // Bot of 1st: home batters vs away pitcher
        const botP = estimatePZero(awayPitcher, parkFactor, true, homeLineup, weather, homeAbbr);
        const pNrfi = topP * botP;

        const status = g.status?.detailedState || "Scheduled";
        const gameTime = g.gameDate ? new Date(g.gameDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "";

        let actual1stRuns = null;
        const innings = g.linescore?.innings;
        if (innings?.length > 0) {
          const topR = innings[0]?.away?.runs ?? null;
          const botR = innings[0]?.home?.runs ?? null;
          if (topR !== null && botR !== null) actual1stRuns = topR + botR;
          else if (topR !== null) actual1stRuns = topR;
        }

        return {
          away: awayAbbr, home: homeAbbr, awayP: awayPName, homeP: homePName,
          awayPitcher, homePitcher, awayLineup, homeLineup, weather,
          pNrfi, pYrfi: 1 - pNrfi, topP, botP, parkFactor,
          status, gameTime, actual1stRuns,
          hasPitchers: awayPName !== "TBD" && homePName !== "TBD",
          hasLineups: (awayLineup?.length > 0) && (homeLineup?.length > 0),
        };
      }));

      setGames(processed);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { loadGames(selectedDate); }, [selectedDate, loadGames]);

  const sorted = useMemo(() => {
    let d = [...games];
    if (filter === "pitchers") d = d.filter(g => g.hasPitchers);
    if (filter === "pre") d = d.filter(g => !["Final","In Progress"].includes(g.status));
    if (filter === "lineups") d = d.filter(g => g.hasLineups);
    if (sort === "nrfi") d.sort((a, b) => b.pNrfi - a.pNrfi);
    else if (sort === "yrfi") d.sort((a, b) => b.pYrfi - a.pYrfi);
    else if (sort === "time") d.sort((a, b) => a.gameTime.localeCompare(b.gameTime));
    else if (sort === "park") d.sort((a, b) => b.parkFactor - a.parkFactor);
    return d;
  }, [games, sort, filter]);

  const avgNrfi = games.length ? games.reduce((s, g) => s + g.pNrfi, 0) / games.length : 0;
  const withPitchers = games.filter(g => g.hasPitchers).length;
  const withLineups = games.filter(g => g.hasLineups).length;
  const finished = games.filter(g => g.actual1stRuns !== null);
  const actualRate = finished.length ? finished.filter(g => g.actual1stRuns === 0).length / finished.length : null;

  const changeDate = (delta) => {
    const d = new Date(selectedDate + "T12:00:00");
    d.setDate(d.getDate() + delta);
    setSelectedDate(d.toISOString().slice(0, 10));
  };
  const pickDate = (iso) => { setSelectedDate(iso); setCalOpen(false); };
  const calDays = useMemo(() => {
    const { year, month } = calMonth;
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const days = [];
    for (let i = 0; i < first.getDay(); i++) days.push(null);
    for (let d = 1; d <= last.getDate(); d++)
      days.push(`${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`);
    return days;
  }, [calMonth]);
  const shiftCalMonth = (delta) => {
    setCalMonth(p => {
      let m = p.month + delta, y = p.year;
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      return { year: y, month: m };
    });
  };
  const quickJump = (y, m, d) => {
    const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    setSelectedDate(iso);
    setCalMonth({ year: y, month: m - 1 });
    setCalOpen(false);
  };

  const displayDate = new Date(selectedDate + "T12:00:00")
    .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="dash">
      <div className="hdr">
        <div>
          <div className="title">NRFI / YRFI Model</div>
          <div className="sub">Live First-Inning Pricing &middot; Pitcher Splits + Lineups + Weather</div>
        </div>
        <div className="date-nav">
          <button onClick={() => changeDate(-1)}>&larr;</button>
          <button className="date-btn" onClick={() => {
            setCalOpen(!calOpen);
            setCalMonth({ year: parseInt(selectedDate.slice(0,4)), month: parseInt(selectedDate.slice(5,7))-1 });
          }}>&#128197; {displayDate}</button>
          <button onClick={() => changeDate(1)}>&rarr;</button>
          {calOpen && <>
            <div className="cal-overlay" onClick={() => setCalOpen(false)} />
            <div className="cal">
              <div className="cal-hdr">
                <button onClick={() => shiftCalMonth(-1)}>&larr;</button>
                <span>{new Date(calMonth.year, calMonth.month).toLocaleDateString("en-US",{month:"long",year:"numeric"})}</span>
                <button onClick={() => shiftCalMonth(1)}>&rarr;</button>
              </div>
              <div className="cal-grid">
                {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => <div key={d} className="cal-dow">{d}</div>)}
                {calDays.map((iso, i) => {
                  if (!iso) return <div key={`e${i}`} />;
                  const today = new Date().toISOString().slice(0,10);
                  return <button key={iso}
                    className={`cal-day ${iso===selectedDate?"selected":""} ${iso===today?"today":""}`}
                    onClick={() => pickDate(iso)}>{parseInt(iso.slice(8))}</button>;
                })}
              </div>
              <div className="quick-jumps">
                <button onClick={() => quickJump(2025,3,27)}>Opening Day '25</button>
                <button onClick={() => quickJump(2025,7,15)}>All-Star '25</button>
                <button onClick={() => quickJump(2025,10,1)}>Postseason '25</button>
                <button onClick={() => pickDate(new Date().toISOString().slice(0,10))}>Today</button>
              </div>
            </div>
          </>}
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="stat-label">Games</div><div className="stat-val">{games.length}</div></div>
        <div className="stat"><div className="stat-label">Pitchers</div><div className="stat-val">{withPitchers}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Lineups</div><div className="stat-val">{withLineups}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Avg NRFI</div><div className="stat-val">{games.length ? `${(avgNrfi*100).toFixed(1)}%` : "\u2014"}</div></div>
        <div className="stat"><div className="stat-label">Actual NRFI</div><div className="stat-val">{actualRate !== null ? `${(actualRate*100).toFixed(0)}%` : "\u2014"}</div>
          {finished.length > 0 && <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{finished.length} final</div>}
        </div>
      </div>

      <div className="tabs">
        {[["slate","Full Slate"],["half","Half-Inning"],["lineups","Lineups"],["pitchers","Pitcher Stats"],["weather","Weather"]].map(([k,l]) =>
          <div key={k} className={`tab ${tab===k?"active":""}`} onClick={() => setTab(k)}>{l}</div>
        )}
      </div>

      {loading ? <Spinner /> : error ? (
        <div style={{textAlign:"center",padding:60,color:"var(--red)"}}>Error: {error}</div>
      ) : games.length === 0 ? (
        <div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>No games scheduled for this date.</div>
      ) : <>

        {/* ========== FULL SLATE ========== */}
        {tab === "slate" && <>
          <div className="controls">
            <span style={{fontSize:12,color:"var(--muted)",marginRight:4}}>Sort:</span>
            {[["nrfi","NRFI%"],["yrfi","YRFI%"],["time","Time"],["park","Park"]].map(([k,l]) =>
              <button key={k} className={`btn ${sort===k?"active":""}`} onClick={() => setSort(k)}>{l}</button>
            )}
            <span style={{fontSize:12,color:"var(--muted)",marginLeft:12,marginRight:4}}>Show:</span>
            {[["all","All"],["pitchers","Pitchers"],["lineups","Lineups"],["pre","Upcoming"]].map(([k,l]) =>
              <button key={k} className={`btn ${filter===k?"active":""}`} onClick={() => setFilter(k)}>{l}</button>
            )}
          </div>
          <div className="card" style={{overflowX:"auto"}}>
            <table>
              <thead><tr>
                <th>Game</th><th>Time</th><th onClick={() => setSort("nrfi")}>P(NRFI)</th>
                <th onClick={() => setSort("yrfi")}>P(YRFI)</th><th>Fair NRFI</th><th>Fair YRFI</th>
                <th onClick={() => setSort("park")}>Park</th><th>Data</th><th>Status</th><th>Result</th>
              </tr></thead>
              <tbody>{sorted.map((g,i) => (
                <tr key={i}>
                  <td>
                    <div className="team">{g.away} @ {g.home}</div>
                    <div className="pitcher">{g.awayP} vs {g.homeP}</div>
                  </td>
                  <td style={{color:"var(--muted)",fontSize:12}}>{g.gameTime} ET</td>
                  <td><BarCell value={g.pNrfi} color="var(--accent)" /></td>
                  <td><BarCell value={g.pYrfi} color="var(--red)" /></td>
                  <td className="odds">{probToAmerican(g.pNrfi)}</td>
                  <td className="odds">{probToAmerican(g.pYrfi)}</td>
                  <td><span style={{color:g.parkFactor>1.03?"var(--red)":g.parkFactor<0.95?"var(--green)":"var(--muted)",fontWeight:600,fontSize:13}}>{g.parkFactor.toFixed(2)}</span></td>
                  <td>
                    <div style={{display:"flex",gap:4}}>
                      {g.hasPitchers && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(59,130,246,0.15)",color:"var(--accent)",fontWeight:600}}>P</span>}
                      {g.homePitcher?.firstInning?.ip > 2 && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(168,85,247,0.15)",color:"#a855f7",fontWeight:600}}>1st</span>}
                      {g.hasLineups && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(34,197,94,0.15)",color:"var(--green)",fontWeight:600}}>LU</span>}
                      {g.weather?.temp && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(234,179,8,0.15)",color:"#eab308",fontWeight:600}}>W</span>}
                    </div>
                  </td>
                  <td><StatusPill status={g.status} /></td>
                  <td><ActualBadge runs={g.actual1stRuns} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>}

        {/* ========== HALF-INNING ========== */}
        {tab === "half" && <div className="card" style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Game</th><th>Top 1st P(0R)</th><th>Bot 1st P(0R)</th><th>Combined</th><th>Weakest Half</th><th>Result</th></tr></thead>
            <tbody>{[...games].sort((a,b) => b.pNrfi - a.pNrfi).map((g,i) => {
              const weak = g.topP < g.botP ? "Top 1st" : "Bot 1st";
              const wv = Math.min(g.topP, g.botP);
              return (
                <tr key={i}>
                  <td><div className="team">{g.away} @ {g.home}</div><div className="pitcher">{g.awayP} vs {g.homeP}</div></td>
                  <td><BarCell value={g.topP} color="#8b5cf6" /><div className="pitcher">{g.away} bat vs {g.homeP}</div></td>
                  <td><BarCell value={g.botP} color="#06b6d4" /><div className="pitcher">{g.home} bat vs {g.awayP}</div></td>
                  <td><BarCell value={g.pNrfi} color="var(--accent)" /></td>
                  <td><span style={{color:wv<0.78?"var(--red)":"var(--muted)",fontWeight:600,fontSize:13}}>{weak} ({(wv*100).toFixed(1)}%)</span></td>
                  <td><ActualBadge runs={g.actual1stRuns} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>}

        {/* ========== LINEUPS ========== */}
        {tab === "lineups" && <div style={{display:"grid",gap:12}}>
          {games.map((g,i) => (
            <div key={i} className="card" style={{padding:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div>
                  <span className="team">{g.away} @ {g.home}</span>
                  <span className="pitcher" style={{marginLeft:8}}>{g.awayP} vs {g.homeP}</span>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:13,fontWeight:700,color:"var(--accent)"}}>{(g.pNrfi*100).toFixed(1)}% NRFI</span>
                  <ActualBadge runs={g.actual1stRuns} />
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--muted)",marginBottom:6}}>
                    {g.away} LINEUP (vs {g.homeP})
                  </div>
                  <LineupTooltip lineup={g.awayLineup} />
                </div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--muted)",marginBottom:6}}>
                    {g.home} LINEUP (vs {g.awayP})
                  </div>
                  <LineupTooltip lineup={g.homeLineup} />
                </div>
              </div>
            </div>
          ))}
        </div>}

        {/* ========== PITCHER STATS ========== */}
        {tab === "pitchers" && <div className="card" style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Game</th><th>Pitcher</th><th>ERA</th><th>WHIP</th><th>K/9</th><th>BB/9</th><th>HR/9</th><th>IP</th><th>1st Inning Splits</th></tr></thead>
            <tbody>{games.flatMap((g,i) => [
              <tr key={`a${i}`} style={{background:"rgba(139,92,246,0.04)"}}>
                <td rowSpan={2}><div className="team">{g.away} @ {g.home}</div></td>
                <td><div style={{fontWeight:600}}>{g.awayP}</div><div style={{fontSize:11,color:"var(--muted)"}}>Away</div></td>
                <td style={{fontWeight:600}}>{g.awayPitcher?.season?.era?.toFixed(2) ?? "\u2014"}</td>
                <td>{g.awayPitcher?.season?.whip?.toFixed(2) ?? "\u2014"}</td>
                <td>{g.awayPitcher?.season?.k9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.awayPitcher?.season?.bb9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.awayPitcher?.season?.hr9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.awayPitcher?.season?.ip?.toFixed(1) ?? "\u2014"}</td>
                <td><FiSplitBadge fi={g.awayPitcher?.firstInning} /></td>
              </tr>,
              <tr key={`h${i}`}>
                <td><div style={{fontWeight:600}}>{g.homeP}</div><div style={{fontSize:11,color:"var(--muted)"}}>Home</div></td>
                <td style={{fontWeight:600}}>{g.homePitcher?.season?.era?.toFixed(2) ?? "\u2014"}</td>
                <td>{g.homePitcher?.season?.whip?.toFixed(2) ?? "\u2014"}</td>
                <td>{g.homePitcher?.season?.k9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.homePitcher?.season?.bb9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.homePitcher?.season?.hr9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.homePitcher?.season?.ip?.toFixed(1) ?? "\u2014"}</td>
                <td><FiSplitBadge fi={g.homePitcher?.firstInning} /></td>
              </tr>
            ])}</tbody>
          </table>
        </div>}

        {/* ========== WEATHER ========== */}
        {tab === "weather" && <div className="card" style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Game</th><th>Weather</th><th>Park Factor</th><th>Wind Impact</th><th>P(NRFI)</th><th>Result</th></tr></thead>
            <tbody>{[...games].sort((a,b) => b.pNrfi - a.pNrfi).map((g,i) => {
              const wind = parseWind(g.weather?.wind);
              let impact = "Neutral";
              let impactColor = "var(--muted)";
              if (wind.direction === "out" && wind.speed > 10) { impact = "Favors YRFI"; impactColor = "var(--red)"; }
              else if (wind.direction === "in" && wind.speed > 10) { impact = "Favors NRFI"; impactColor = "var(--green)"; }
              else if (g.weather?.temp > 85) { impact = "Hot (more HR)"; impactColor = "var(--red)"; }
              else if (g.weather?.temp < 55) { impact = "Cold (less carry)"; impactColor = "var(--accent)"; }
              return (
                <tr key={i}>
                  <td><div className="team">{g.away} @ {g.home}</div><div className="pitcher">{g.awayP} vs {g.homeP}</div></td>
                  <td><WeatherBadge weather={g.weather} /></td>
                  <td><span style={{color:g.parkFactor>1.03?"var(--red)":g.parkFactor<0.95?"var(--green)":"var(--muted)",fontWeight:600}}>{g.parkFactor.toFixed(2)}</span></td>
                  <td><span style={{color:impactColor,fontWeight:600,fontSize:12}}>{impact}</span></td>
                  <td><BarCell value={g.pNrfi} color="var(--accent)" /></td>
                  <td><ActualBadge runs={g.actual1stRuns} /></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>}

      </>}

      <div style={{marginTop:20,padding:16,background:"var(--card)",borderRadius:10,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
        <strong style={{color:"var(--text)"}}>Model inputs:</strong> Pitcher season stats + first-inning splits (blended by IP),
        top-of-order lineup OBP/SLG/K%/BB%, park run factors, temperature, wind speed &amp; direction.
        Stats regressed toward league average based on sample size. P(NRFI) = P(0R top 1st) &times; P(0R bot 1st).
        Data badges: <span style={{color:"var(--accent)"}}>P</span> = pitchers listed,
        <span style={{color:"#a855f7)",marginLeft:2}}>1st</span> = first-inning splits available,
        <span style={{color:"var(--green)",marginLeft:2}}>LU</span> = lineups confirmed,
        <span style={{color:"#eab308",marginLeft:2}}>W</span> = weather data.
        Model output only &mdash; not financial advice.
      </div>
    </div>
  );
}
