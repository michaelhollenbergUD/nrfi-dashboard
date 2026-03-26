import { useState, useMemo, useEffect, useCallback, useRef } from "react";

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

const WIND_PARK_SENSITIVITY = {
  CHC: 1.5, BOS: 1.2, CIN: 1.1, SF: 1.3, PIT: 1.0, CLE: 1.0,
  NYM: 0.9, NYY: 0.9, PHI: 0.8, COL: 0.7,
};

const LG = {
  era: 4.20, whip: 1.27, k9: 8.0, bb9: 3.2, hr9: 1.20, scoringPct: 0.258,
  fip: 4.15, obp: 0.317, slg: 0.420, woba: 0.315, kPct: 0.224, bbPct: 0.083,
};

// =========================================================================
// FANGRAPHS CSV PARSER
// =========================================================================

function parseFangraphsCSV(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return {};

  // Parse header — handle quoted headers
  const rawHeader = lines[0];
  const headers = parseCSVLine(rawHeader).map(h => h.trim().toLowerCase());

  // Find column indices — FanGraphs uses various column names
  const findCol = (...names) => {
    for (const n of names) {
      const idx = headers.indexOf(n.toLowerCase());
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const nameIdx = findCol("name", "playername", "player");
  const eraIdx = findCol("era");
  const fipIdx = findCol("fip");
  const whipIdx = findCol("whip");
  const k9Idx = findCol("k/9", "k9", "so9");
  const bb9Idx = findCol("bb/9", "bb9");
  const hr9Idx = findCol("hr/9", "hr9");
  const ipIdx = findCol("ip", "innings");
  const kPctIdx = findCol("k%", "kpct", "k_pct");
  const bbPctIdx = findCol("bb%", "bbpct", "bb_pct");
  const sieraIdx = findCol("siera");
  const xfipIdx = findCol("xfip");
  const warIdx = findCol("war", "fwar");

  if (nameIdx < 0) return {};

  const projections = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length <= nameIdx) continue;

    const rawName = cols[nameIdx]?.trim();
    if (!rawName) continue;

    // Create lookup keys: full name, last name, normalized
    const name = rawName.replace(/['"]/g, "").trim();
    const normalized = normalizeName(name);
    const lastName = name.split(" ").pop().toLowerCase();

    const getNum = (idx) => {
      if (idx < 0 || idx >= cols.length) return null;
      const val = cols[idx]?.trim().replace("%", "");
      const n = parseFloat(val);
      return isNaN(n) ? null : n;
    };

    const proj = {
      name,
      era: getNum(eraIdx),
      fip: getNum(fipIdx),
      whip: getNum(whipIdx),
      k9: getNum(k9Idx),
      bb9: getNum(bb9Idx),
      hr9: getNum(hr9Idx),
      ip: getNum(ipIdx),
      kPct: getNum(kPctIdx),
      bbPct: getNum(bbPctIdx),
      siera: getNum(sieraIdx),
      xfip: getNum(xfipIdx),
      war: getNum(warIdx),
    };

    // Convert K% and BB% from whole numbers to decimals if needed
    if (proj.kPct && proj.kPct > 1) proj.kPct = proj.kPct / 100;
    if (proj.bbPct && proj.bbPct > 1) proj.bbPct = proj.bbPct / 100;

    projections[normalized] = proj;
    projections[lastName] = proj; // fallback by last name
  }

  return projections;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function lookupProjection(projections, pitcherName) {
  if (!projections || !pitcherName || pitcherName === "TBD") return null;

  const normalized = normalizeName(pitcherName);
  if (projections[normalized]) return projections[normalized];

  // Try last name only
  const lastName = pitcherName.split(" ").pop().toLowerCase();
  if (projections[lastName]) return projections[lastName];

  // Fuzzy: check if any key contains the last name
  for (const [key, val] of Object.entries(projections)) {
    if (key.includes(lastName)) return val;
  }

  return null;
}

// =========================================================================
// LIVE PITCHER STATS FALLBACK (when no FanGraphs projection)
// =========================================================================

async function fetchLivePitcherStats(playerId, season) {
  try {
    const seasonParam = season ? `&season=${season}` : "";
    const r = await fetch(`${MLB_PEOPLE_URL}/${playerId}/stats?stats=season&group=pitching&sportId=1${seasonParam}`);
    const d = await r.json();
    const s = d?.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    return {
      era: parseFloat(s.era) || LG.era,
      fip: null,
      whip: parseFloat(s.whip) || LG.whip,
      k9: parseFloat(s.strikeoutsPer9Inn) || LG.k9,
      bb9: parseFloat(s.walksPer9Inn) || LG.bb9,
      hr9: parseFloat(s.homeRunsPer9) || LG.hr9,
      ip: parseFloat(s.inningsPitched) || 0,
      source: "mlb-live",
    };
  } catch { return null; }
}

// =========================================================================
// LINEUP DATA
// =========================================================================

async function fetchLineup(gameId, teamType) {
  try {
    const res = await fetch(`${MLB_GAME_URL}/${gameId}/feed/live`);
    const data = await res.json();
    const teamData = data?.liveData?.boxscore?.teams?.[teamType];
    if (!teamData) return null;
    const battingOrder = teamData.battingOrder || [];
    if (!battingOrder.length) return null;
    const topBatters = battingOrder.slice(0, 4);
    const players = teamData.players || {};

    return topBatters.map(pid => {
      const p = players[`ID${pid}`];
      const stats = p?.seasonStats?.batting;
      return {
        name: p?.person?.fullName || "Unknown",
        hand: p?.person?.batSide?.code || "R",
        obp: parseFloat(stats?.obp) || LG.obp,
        slg: parseFloat(stats?.slg) || LG.slg,
        kPct: LG.kPct,
        bbPct: LG.bbPct,
      };
    });
  } catch { return null; }
}

// =========================================================================
// WEATHER
// =========================================================================

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
// MODEL — uses FanGraphs projections when available
// =========================================================================

function estimatePZero(proj, parkFactor, isHomeBatting, lineup, weather, homeAbbr, f5Total) {
  const baseP = 1 - LG.scoringPct;
  let lo = Math.log(baseP / (1 - baseP));

  // --- F5 TOTAL (strongest anchor for market making) ---
  // Average F5 total is ~4.5 runs. Higher = more run-friendly environment.
  // This captures pitching matchup, park, weather, lineups as priced by the market.
  if (f5Total != null && f5Total > 0) {
    const f5Avg = 4.5;
    const f5Diff = f5Total - f5Avg;
    // Each 0.5 run above/below average shifts first-inning scoring expectation
    lo -= f5Diff * 0.18;
  }

  // --- PITCHER (FanGraphs projections or live MLB stats) ---
  if (proj) {
    const hasProjections = proj.source !== "mlb-live" && proj.fip != null;
    const ip = proj.ip || 0;

    if (hasProjections) {
      // FanGraphs projections: FIP is primary
      const fip = proj.fip ?? LG.fip;
      const era = proj.era ?? LG.era;
      const whip = proj.whip ?? LG.whip;
      const k9 = proj.k9 ?? LG.k9;
      const bb9 = proj.bb9 ?? LG.bb9;
      const hr9 = proj.hr9 ?? LG.hr9;

      lo += (LG.fip - fip) * 0.15;
      lo += (LG.era - era) * 0.06;
      lo += (LG.whip - whip) * 0.45;
      lo += (k9 - LG.k9) * 0.03;
      lo += (LG.bb9 - bb9) * 0.05;
      lo += (LG.hr9 - hr9) * 0.08;

      if (proj.xfip) lo += (LG.fip - proj.xfip) * 0.03;
      if (proj.siera) lo += (LG.era - proj.siera) * 0.03;
    } else {
      // Live MLB stats: regress toward league average based on IP
      const weight = Math.min(ip / 80, 1);
      const era = proj.era ?? LG.era;
      const whip = proj.whip ?? LG.whip;
      const k9 = proj.k9 ?? LG.k9;
      const bb9 = proj.bb9 ?? LG.bb9;
      const hr9 = proj.hr9 ?? LG.hr9;

      const wEra = era * weight + LG.era * (1 - weight);
      const wWhip = whip * weight + LG.whip * (1 - weight);
      const wK9 = k9 * weight + LG.k9 * (1 - weight);
      const wBb9 = bb9 * weight + LG.bb9 * (1 - weight);
      const wHr9 = hr9 * weight + LG.hr9 * (1 - weight);

      lo += (LG.era - wEra) * 0.10;
      lo += (LG.whip - wWhip) * 0.50;
      lo += (wK9 - LG.k9) * 0.03;
      lo += (LG.bb9 - wBb9) * 0.05;
      lo += (LG.hr9 - wHr9) * 0.08;
    }
  }

  // --- LINEUP (top 4 batters) ---
  if (lineup && lineup.length >= 3) {
    const avgObp = lineup.reduce((s, b) => s + (b.obp || LG.obp), 0) / lineup.length;
    const avgSlg = lineup.reduce((s, b) => s + (b.slg || LG.slg), 0) / lineup.length;
    const avgKPct = lineup.reduce((s, b) => s + (b.kPct || LG.kPct), 0) / lineup.length;
    const avgBbPct = lineup.reduce((s, b) => s + (b.bbPct || LG.bbPct), 0) / lineup.length;

    lo -= (avgObp - LG.obp) * 2.5;
    lo -= (avgSlg - LG.slg) * 1.0;
    lo += (avgKPct - LG.kPct) * 0.6;
    lo -= (avgBbPct - LG.bbPct) * 0.7;
  }

  // --- PARK FACTOR ---
  lo -= ((parkFactor || 1.0) - 1.0) * 1.1;

  // --- WEATHER ---
  if (weather) {
    if (weather.temp != null) {
      lo -= ((weather.temp - 72) / 100) * 0.2;
    }
    const wind = parseWind(weather.wind);
    const sensitivity = WIND_PARK_SENSITIVITY[homeAbbr] || 0.5;
    if (wind.direction === "out" && wind.speed > 5) {
      lo -= (wind.speed / 100) * sensitivity * 1.1;
    } else if (wind.direction === "in" && wind.speed > 5) {
      lo += (wind.speed / 100) * sensitivity * 0.7;
    }
  }

  // --- HOME/AWAY ---
  if (isHomeBatting) lo -= 0.02;

  return Math.max(0.50, Math.min(0.93, 1 / (1 + Math.exp(-lo))));
}

// =========================================================================
// SCHEDULE
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
      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: "right" }}>{(value * 100).toFixed(1)}%</span>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 80, gap: 16 }}>
      <div style={{ width: 36, height: 36, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <div style={{ color: "var(--muted)", fontSize: 14 }}>Loading games, lineups & weather...</div>
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
  const avgObp = lineup.reduce((s, b) => s + b.obp, 0) / lineup.length;
  const avgSlg = lineup.reduce((s, b) => s + b.slg, 0) / lineup.length;
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

function ProjBadge({ proj, name }) {
  if (!proj) return <span style={{ color: "var(--red)", fontSize: 11 }}>No projection for {name}</span>;
  const fipColor = proj.fip < 3.2 ? "var(--green)" : proj.fip > 4.5 ? "var(--red)" : "var(--text)";
  return (
    <div style={{ fontSize: 11 }}>
      {proj.fip != null && <span style={{ color: fipColor, fontWeight: 700 }}>{proj.fip.toFixed(2)} FIP</span>}
      {proj.era != null && <span style={{ color: "var(--muted)", marginLeft: 6 }}>{proj.era.toFixed(2)} ERA</span>}
      {proj.whip != null && <span style={{ color: "var(--muted)", marginLeft: 6 }}>{proj.whip.toFixed(2)} WHIP</span>}
      {proj.ip != null && <span style={{ color: "var(--border)", marginLeft: 6 }}>{proj.ip.toFixed(0)} IP proj</span>}
    </div>
  );
}

// =========================================================================
// CSV UPLOAD COMPONENT
// =========================================================================

function CSVUploader({ onUpload, projCount }) {
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const projections = parseFangraphsCSV(text);
      const count = Object.keys(projections).length;
      onUpload(projections, count);
    };
    reader.readAsText(file);
  };

  return (
    <div style={{
      background: "var(--card)", borderRadius: 12, padding: 16, marginBottom: 18,
      border: dragOver ? "2px dashed var(--accent)" : "2px dashed var(--border)",
      transition: "border 0.2s",
    }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>FanGraphs Projections</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {projCount > 0
              ? <span style={{ color: "var(--green)" }}>{"\u2713"} {projCount} pitchers loaded</span>
              : "Upload a CSV from FanGraphs Projections Leaderboard"
            }
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            {projCount > 0 ? "Replace CSV" : "Upload CSV"}
          </button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }}
            onChange={(e) => handleFile(e.target.files[0])} />
        </div>
      </div>
      {projCount === 0 && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10, lineHeight: 1.6 }}>
          <strong>How to get the CSV:</strong> Go to{" "}
          <span style={{ color: "var(--accent)" }}>fangraphs.com &rarr; Projections &rarr; Pitchers</span>{" "}
          &rarr; Select Steamer or ZiPS &rarr; Click "Export Data" button. Make sure the CSV includes columns
          for Name, ERA, FIP, WHIP, K/9, BB/9, HR/9, IP.
          Optional: xFIP, SIERA. Drag &amp; drop the file here or click Upload.
        </div>
      )}
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

  // FanGraphs projections state
  const [projections, setProjections] = useState({});
  const [projCount, setProjCount] = useState(0);
  const [unmatchedPitchers, setUnmatchedPitchers] = useState([]);

  // F5 totals (keyed by "away@home")
  const [f5Totals, setF5Totals] = useState({});

  const setF5 = (key, val) => {
    setF5Totals(prev => ({ ...prev, [key]: val }));
  };

  const handleProjectionUpload = (projs, count) => {
    setProjections(projs);
    setProjCount(Math.floor(count / 2)); // each pitcher stored under 2 keys (full name + last name)
  };

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

        // Look up FanGraphs projections, fall back to live MLB stats
        let awayProj = lookupProjection(projections, awayPName);
        let homeProj = lookupProjection(projections, homePName);
        let awaySource = awayProj ? "fangraphs" : "none";
        let homeSource = homeProj ? "fangraphs" : "none";

        // If no projection, pull live stats from MLB API (try current year, then prior year)
        const selectedYear = parseInt(dateStr.slice(0, 4));
        if (!awayProj && awayPitcherInfo?.id) {
          let live = await fetchLivePitcherStats(awayPitcherInfo.id, selectedYear);
          if (!live || live.ip === 0) live = await fetchLivePitcherStats(awayPitcherInfo.id, selectedYear - 1);
          if (live && live.ip > 0) { awayProj = live; awaySource = "mlb-live"; }
        }
        if (!homeProj && homePitcherInfo?.id) {
          let live = await fetchLivePitcherStats(homePitcherInfo.id, selectedYear);
          if (!live || live.ip === 0) live = await fetchLivePitcherStats(homePitcherInfo.id, selectedYear - 1);
          if (live && live.ip > 0) { homeProj = live; homeSource = "mlb-live"; }
        }

        // Fetch lineups
        let awayLineup = null, homeLineup = null;
        try {
          awayLineup = await fetchLineup(g.gamePk, "away");
          homeLineup = await fetchLineup(g.gamePk, "home");
        } catch {}

        // Weather
        let weather = null;
        if (g.weather) {
          weather = { temp: parseInt(g.weather.temp) || null, wind: g.weather.wind || "", condition: g.weather.condition || "" };
        }

        const parkFactor = PARK_FACTORS[homeAbbr] || 1.0;
        const gameKey = `${awayAbbr}@${homeAbbr}`;
        const f5 = f5Totals[gameKey] || null;

        // Top of 1st: away batters vs home pitcher
        const topP = estimatePZero(homeProj, parkFactor, false, awayLineup, weather, homeAbbr, f5);
        // Bot of 1st: home batters vs away pitcher
        const botP = estimatePZero(awayProj, parkFactor, true, homeLineup, weather, homeAbbr, f5);
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
          awayProj, homeProj, awaySource, homeSource, awayLineup, homeLineup, weather,
          pNrfi, pYrfi: 1 - pNrfi, topP, botP, parkFactor,
          status, gameTime, actual1stRuns, gameKey,
          hasPitchers: awayPName !== "TBD" && homePName !== "TBD",
          hasLineups: (awayLineup?.length > 0) && (homeLineup?.length > 0),
          hasProj: awayProj != null && homeProj != null,
        };
      }));

      // Track unmatched pitchers
      const unmatched = [];
      processed.forEach(g => {
        if (g.awayP !== "TBD" && !g.awayProj && projCount > 0) unmatched.push(g.awayP);
        if (g.homeP !== "TBD" && !g.homeProj && projCount > 0) unmatched.push(g.homeP);
      });
      setUnmatchedPitchers([...new Set(unmatched)]);

      setGames(processed);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [projections, projCount, f5Totals]);

  useEffect(() => { loadGames(selectedDate); }, [selectedDate, loadGames]);

  const sorted = useMemo(() => {
    let d = [...games];
    if (filter === "pitchers") d = d.filter(g => g.hasPitchers);
    if (filter === "pre") d = d.filter(g => !["Final","In Progress"].includes(g.status));
    if (filter === "lineups") d = d.filter(g => g.hasLineups);
    if (filter === "proj") d = d.filter(g => g.hasProj);
    if (sort === "nrfi") d.sort((a, b) => b.pNrfi - a.pNrfi);
    else if (sort === "yrfi") d.sort((a, b) => b.pYrfi - a.pYrfi);
    else if (sort === "time") d.sort((a, b) => a.gameTime.localeCompare(b.gameTime));
    else if (sort === "park") d.sort((a, b) => b.parkFactor - a.parkFactor);
    return d;
  }, [games, sort, filter]);

  const avgNrfi = games.length ? games.reduce((s, g) => s + g.pNrfi, 0) / games.length : 0;
  const withPitchers = games.filter(g => g.hasPitchers).length;
  const withLineups = games.filter(g => g.hasLineups).length;
  const withProj = games.filter(g => g.hasProj).length;
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
          <div className="sub">FanGraphs Projections + Lineups + Weather</div>
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

      {/* CSV Upload */}
      <CSVUploader onUpload={handleProjectionUpload} projCount={projCount} />

      {/* Unmatched pitcher warning */}
      {unmatchedPitchers.length > 0 && (
        <div style={{ background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12 }}>
          <span style={{ color: "#eab308", fontWeight: 700 }}>{"\u26A0"} Unmatched pitchers:</span>
          <span style={{ color: "var(--muted)", marginLeft: 6 }}>{unmatchedPitchers.join(", ")}</span>
          <div style={{ color: "var(--muted)", marginTop: 4, fontSize: 11 }}>
            These pitchers weren't found in your CSV. They'll use league-average projections. Check that names match exactly.
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="stats">
        <div className="stat"><div className="stat-label">Games</div><div className="stat-val">{games.length}</div></div>
        <div className="stat"><div className="stat-label">Proj Matched</div><div className="stat-val" style={{color: withProj === games.length && games.length > 0 ? "var(--green)" : "var(--text)"}}>{withProj}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Lineups</div><div className="stat-val">{withLineups}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Avg NRFI</div><div className="stat-val">{games.length ? `${(avgNrfi*100).toFixed(1)}%` : "\u2014"}</div></div>
        <div className="stat"><div className="stat-label">Actual NRFI</div><div className="stat-val">{actualRate !== null ? `${(actualRate*100).toFixed(0)}%` : "\u2014"}</div>
          {finished.length > 0 && <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{finished.length} final</div>}
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {[["slate","Full Slate"],["half","Half-Inning"],["lineups","Lineups"],["projections","Projections"],["weather","Weather"]].map(([k,l]) =>
          <div key={k} className={`tab ${tab===k?"active":""}`} onClick={() => setTab(k)}>{l}</div>
        )}
      </div>

      {loading ? <Spinner /> : error ? (
        <div style={{textAlign:"center",padding:60,color:"var(--red)"}}>Error: {error}</div>
      ) : games.length === 0 ? (
        <div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>No games scheduled for this date.</div>
      ) : <>

        {/* FULL SLATE */}
        {tab === "slate" && <>
          <div className="controls">
            <span style={{fontSize:12,color:"var(--muted)",marginRight:4}}>Sort:</span>
            {[["nrfi","NRFI%"],["yrfi","YRFI%"],["time","Time"],["park","Park"]].map(([k,l]) =>
              <button key={k} className={`btn ${sort===k?"active":""}`} onClick={() => setSort(k)}>{l}</button>
            )}
            <span style={{fontSize:12,color:"var(--muted)",marginLeft:12,marginRight:4}}>Show:</span>
            {[["all","All"],["proj","Has Proj"],["lineups","Lineups"],["pre","Upcoming"]].map(([k,l]) =>
              <button key={k} className={`btn ${filter===k?"active":""}`} onClick={() => setFilter(k)}>{l}</button>
            )}
          </div>
          <div className="card" style={{overflowX:"auto"}}>
            <table>
              <thead><tr>
                <th>Game</th><th>Time</th><th>F5 Total</th><th onClick={() => setSort("nrfi")}>P(NRFI)</th>
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
                  <td>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="15"
                      placeholder="F5"
                      value={f5Totals[g.gameKey] ?? ""}
                      onChange={(e) => setF5(g.gameKey, e.target.value ? parseFloat(e.target.value) : null)}
                      style={{
                        width: 58, padding: "4px 6px", fontSize: 13, fontWeight: 600,
                        background: "var(--card2)", border: "1px solid var(--border)", borderRadius: 6,
                        color: f5Totals[g.gameKey] ? "var(--text)" : "var(--muted)", textAlign: "center",
                        outline: "none",
                      }}
                    />
                  </td>
                  <td><BarCell value={g.pNrfi} color="var(--accent)" /></td>
                  <td><BarCell value={g.pYrfi} color="var(--red)" /></td>
                  <td className="odds">{probToAmerican(g.pNrfi)}</td>
                  <td className="odds">{probToAmerican(g.pYrfi)}</td>
                  <td><span style={{color:g.parkFactor>1.03?"var(--red)":g.parkFactor<0.95?"var(--green)":"var(--muted)",fontWeight:600,fontSize:13}}>{g.parkFactor.toFixed(2)}</span></td>
                  <td>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                      {g.awaySource === "fangraphs" && g.homeSource === "fangraphs" && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(168,85,247,0.15)",color:"#a855f7",fontWeight:600}}>FG</span>}
                      {(g.awaySource === "mlb-live" || g.homeSource === "mlb-live") && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(59,130,246,0.15)",color:"var(--accent)",fontWeight:600}}>LIVE</span>}
                      {(g.awaySource === "fangraphs" && g.homeSource === "mlb-live") || (g.awaySource === "mlb-live" && g.homeSource === "fangraphs") ? <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(234,179,8,0.15)",color:"#eab308",fontWeight:600}}>MIX</span> : null}
                      {g.hasLineups && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(34,197,94,0.15)",color:"var(--green)",fontWeight:600}}>LU</span>}
                      {g.weather?.temp && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(234,179,8,0.15)",color:"#eab308",fontWeight:600}}>W</span>}
                      {g.awaySource === "none" && g.homeSource === "none" && g.hasPitchers && <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(239,68,68,0.12)",color:"var(--red)",fontWeight:600}}>NO DATA</span>}
                    </div>
                  </td>
                  <td><StatusPill status={g.status} /></td>
                  <td><ActualBadge runs={g.actual1stRuns} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>}

        {/* HALF-INNING */}
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

        {/* LINEUPS */}
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
                  <div style={{fontSize:12,fontWeight:700,color:"var(--muted)",marginBottom:6}}>{g.away} LINEUP (vs {g.homeP})</div>
                  <LineupTooltip lineup={g.awayLineup} />
                </div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"var(--muted)",marginBottom:6}}>{g.home} LINEUP (vs {g.awayP})</div>
                  <LineupTooltip lineup={g.homeLineup} />
                </div>
              </div>
            </div>
          ))}
        </div>}

        {/* PROJECTIONS */}
        {tab === "projections" && <div className="card" style={{overflowX:"auto"}}>
          {projCount === 0 ? (
            <div style={{textAlign:"center",padding:40,color:"var(--muted)"}}>
              <div>No FanGraphs CSV uploaded yet. Using live MLB stats as the data source.</div>
              <div style={{marginTop:8,fontSize:11}}>Upload a CSV above for projection-based pricing.</div>
            </div>
          ) : null}
            <table>
              <thead><tr><th>Game</th><th>Pitcher</th><th>Source</th><th>FIP</th><th>ERA</th><th>WHIP</th><th>K/9</th><th>BB/9</th><th>HR/9</th><th>IP</th></tr></thead>
              <tbody>{games.flatMap((g,i) => {
                const srcBadge = (src) => {
                  if (src === "fangraphs") return <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(168,85,247,0.15)",color:"#a855f7",fontWeight:600}}>FanGraphs</span>;
                  if (src === "mlb-live") return <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(59,130,246,0.15)",color:"var(--accent)",fontWeight:600}}>MLB Live</span>;
                  return <span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(239,68,68,0.12)",color:"var(--red)",fontWeight:600}}>League Avg</span>;
                };
                return [
                <tr key={`a${i}`} style={{background:"rgba(139,92,246,0.04)"}}>
                  <td rowSpan={2}><div className="team">{g.away} @ {g.home}</div></td>
                  <td><div style={{fontWeight:600}}>{g.awayP}</div></td>
                  <td>{srcBadge(g.awaySource)}</td>
                  <td style={{fontWeight:700,color:g.awayProj?.fip < 3.2 ? "var(--green)" : g.awayProj?.fip > 4.5 ? "var(--red)" : "var(--text)"}}>{g.awayProj?.fip?.toFixed(2) ?? "\u2014"}</td>
                  <td>{g.awayProj?.era?.toFixed(2) ?? "\u2014"}</td>
                  <td>{g.awayProj?.whip?.toFixed(2) ?? "\u2014"}</td>
                  <td>{g.awayProj?.k9?.toFixed(1) ?? "\u2014"}</td>
                  <td>{g.awayProj?.bb9?.toFixed(1) ?? "\u2014"}</td>
                  <td>{g.awayProj?.hr9?.toFixed(1) ?? "\u2014"}</td>
                  <td>{g.awayProj?.ip?.toFixed(0) ?? "\u2014"}</td>
                </tr>,
                <tr key={`h${i}`}>
                  <td><div style={{fontWeight:600}}>{g.homeP}</div></td>
                  <td>{srcBadge(g.homeSource)}</td>
                  <td style={{fontWeight:700,color:g.homeProj?.fip < 3.2 ? "var(--green)" : g.homeProj?.fip > 4.5 ? "var(--red)" : "var(--text)"}}>{g.homeProj?.fip?.toFixed(2) ?? "\u2014"}</td>
                  <td>{g.homeProj?.era?.toFixed(2) ?? "\u2014"}</td>
                  <td>{g.homeProj?.whip?.toFixed(2) ?? "\u2014"}</td>
                  <td>{g.homeProj?.k9?.toFixed(1) ?? "\u2014"}</td>
                  <td>{g.homeProj?.bb9?.toFixed(1) ?? "\u2014"}</td>
                  <td>{g.homeProj?.hr9?.toFixed(1) ?? "\u2014"}</td>
                  <td>{g.homeProj?.ip?.toFixed(0) ?? "\u2014"}</td>
                </tr>
              ];})}</tbody>
            </table>
        </div>}

        {/* WEATHER */}
        {tab === "weather" && <div className="card" style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Game</th><th>Weather</th><th>Park Factor</th><th>Wind Impact</th><th>P(NRFI)</th><th>Result</th></tr></thead>
            <tbody>{[...games].sort((a,b) => b.pNrfi - a.pNrfi).map((g,i) => {
              const wind = parseWind(g.weather?.wind);
              let impact = "Neutral", impactColor = "var(--muted)";
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
        <strong style={{color:"var(--text)"}}>Model inputs:</strong> First 5 innings total (manual input, anchors to game environment),
        FanGraphs pitcher projections when available (FIP primary), falling back to live MLB season stats.
        Also uses top-of-order lineup OBP/SLG, park run factors, temperature, wind.
        P(NRFI) = P(0R top 1st) &times; P(0R bot 1st).
        Data badges: <span style={{color:"#a855f7"}}>FG</span> = FanGraphs projection,
        <span style={{color:"var(--accent)",marginLeft:2}}>LIVE</span> = MLB season stats,
        <span style={{color:"var(--green)",marginLeft:2}}>LU</span> = lineups confirmed,
        <span style={{color:"#eab308",marginLeft:2}}>W</span> = weather data.
        Model output only &mdash; not financial advice.
      </div>
    </div>
  );
}
