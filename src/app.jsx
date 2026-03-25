import { useState, useMemo, useEffect, useCallback } from "react";

const MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const MLB_PEOPLE_URL = "https://statsapi.mlb.com/api/v1/people";

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

const LG = { era: 4.20, whip: 1.27, k9: 8.0, bb9: 3.2, hr9: 1.20, scoringPct: 0.258 };

function estimatePZero(pitcher, parkFactor, isHomeBatting) {
  const baseP = 1 - LG.scoringPct;
  let lo = Math.log(baseP / (1 - baseP));
  if (pitcher) {
    const era = pitcher.era ?? LG.era;
    const whip = pitcher.whip ?? LG.whip;
    const k9 = pitcher.k9 ?? LG.k9;
    const bb9 = pitcher.bb9 ?? LG.bb9;
    const hr9 = pitcher.hr9 ?? LG.hr9;
    const ip = pitcher.ip ?? 0;
    const weight = Math.min(ip / 80, 1);
    const wEra = era * weight + LG.era * (1 - weight);
    const wWhip = whip * weight + LG.whip * (1 - weight);
    const wK9 = k9 * weight + LG.k9 * (1 - weight);
    const wBb9 = bb9 * weight + LG.bb9 * (1 - weight);
    const wHr9 = hr9 * weight + LG.hr9 * (1 - weight);
    lo += (LG.era - wEra) * 0.15;
    lo += (LG.whip - wWhip) * 0.8;
    lo += (wK9 - LG.k9) * 0.04;
    lo += (LG.bb9 - wBb9) * 0.06;
    lo += (LG.hr9 - wHr9) * 0.10;
  }
  lo -= ((parkFactor || 1.0) - 1.0) * 1.5;
  if (isHomeBatting) lo -= 0.02;
  return Math.max(0.55, Math.min(0.92, 1 / (1 + Math.exp(-lo))));
}

function probToAmerican(p) {
  if (p <= 0 || p >= 1) return "N/A";
  if (p >= 0.5) return `${Math.round(-(p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

async function fetchPitcherStats(playerId) {
  try {
    const r = await fetch(
      `${MLB_PEOPLE_URL}/${playerId}/stats?stats=season&group=pitching&sportId=1`
    );
    const d = await r.json();
    const s = d?.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    return {
      era: parseFloat(s.era) || LG.era,
      whip: parseFloat(s.whip) || LG.whip,
      k9: parseFloat(s.strikeoutsPer9Inn) || LG.k9,
      bb9: parseFloat(s.walksPer9Inn) || LG.bb9,
      hr9: parseFloat(s.homeRunsPer9) || LG.hr9,
      ip: parseFloat(s.inningsPitched) || 0,
    };
  } catch { return null; }
}

async function fetchGames(dateStr) {
  const url = `${MLB_SCHEDULE_URL}?sportId=1&date=${dateStr}&hydrate=probablePitcher,linescore`;
  const r = await fetch(url);
  const d = await r.json();
  return d?.dates?.[0]?.games || [];
}

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
      <div style={{ color: "var(--muted)", fontSize: 14 }}>Loading MLB schedule & pitcher stats...</div>
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
        const awayPitcher = g.teams?.away?.probablePitcher;
        const homePitcher = g.teams?.home?.probablePitcher;
        const awayPName = awayPitcher ? awayPitcher.fullName : "TBD";
        const homePName = homePitcher ? homePitcher.fullName : "TBD";
        let awayStats = null, homeStats = null;
        if (awayPitcher?.id) awayStats = await fetchPitcherStats(awayPitcher.id);
        if (homePitcher?.id) homeStats = await fetchPitcherStats(homePitcher.id);
        const parkFactor = PARK_FACTORS[homeAbbr] || 1.0;
        const topP = estimatePZero(homeStats, parkFactor, false);
        const botP = estimatePZero(awayStats, parkFactor, true);
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
        return { away: awayAbbr, home: homeAbbr, awayP: awayPName, homeP: homePName,
          awayStats, homeStats, pNrfi, pYrfi: 1 - pNrfi, topP, botP, parkFactor,
          status, gameTime, actual1stRuns, hasPitchers: awayPName !== "TBD" && homePName !== "TBD" };
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
    if (sort === "nrfi") d.sort((a, b) => b.pNrfi - a.pNrfi);
    else if (sort === "yrfi") d.sort((a, b) => b.pYrfi - a.pYrfi);
    else if (sort === "time") d.sort((a, b) => a.gameTime.localeCompare(b.gameTime));
    else if (sort === "park") d.sort((a, b) => b.parkFactor - a.parkFactor);
    return d;
  }, [games, sort, filter]);

  const avgNrfi = games.length ? games.reduce((s, g) => s + g.pNrfi, 0) / games.length : 0;
  const withPitchers = games.filter(g => g.hasPitchers).length;
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
          <div className="sub">Live First-Inning Pricing &middot; MLB Stats API</div>
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
        <div className="stat"><div className="stat-label">Pitchers Listed</div><div className="stat-val">{withPitchers}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Avg Model NRFI</div><div className="stat-val">{games.length ? `${(avgNrfi*100).toFixed(1)}%` : "\u2014"}</div></div>
        <div className="stat"><div className="stat-label">Actual NRFI Rate</div><div className="stat-val">{actualRate !== null ? `${(actualRate*100).toFixed(0)}%` : "\u2014"}</div>
          {finished.length > 0 && <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{finished.length} games final</div>}
        </div>
      </div>

      <div className="tabs">
        {[["slate","Full Slate"],["half","Half-Inning Detail"],["pitchers","Pitcher Stats"]].map(([k,l]) =>
          <div key={k} className={`tab ${tab===k?"active":""}`} onClick={() => setTab(k)}>{l}</div>
        )}
      </div>

      {loading ? <Spinner /> : error ? (
        <div style={{textAlign:"center",padding:60,color:"var(--red)"}}>Error: {error}</div>
      ) : games.length === 0 ? (
        <div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>No games scheduled for this date.</div>
      ) : <>
        {tab === "slate" && <>
          <div className="controls">
            <span style={{fontSize:12,color:"var(--muted)",marginRight:4}}>Sort:</span>
            {[["nrfi","NRFI%"],["yrfi","YRFI%"],["time","Time"],["park","Park"]].map(([k,l]) =>
              <button key={k} className={`btn ${sort===k?"active":""}`} onClick={() => setSort(k)}>{l}</button>
            )}
            <span style={{fontSize:12,color:"var(--muted)",marginLeft:12,marginRight:4}}>Show:</span>
            {[["all","All"],["pitchers","With Pitchers"],["pre","Upcoming"]].map(([k,l]) =>
              <button key={k} className={`btn ${filter===k?"active":""}`} onClick={() => setFilter(k)}>{l}</button>
            )}
          </div>
          <div className="card" style={{overflowX:"auto"}}>
            <table>
              <thead><tr>
                <th>Game</th><th>Time</th><th onClick={() => setSort("nrfi")}>P(NRFI)</th>
                <th onClick={() => setSort("yrfi")}>P(YRFI)</th><th>Fair NRFI</th><th>Fair YRFI</th>
                <th onClick={() => setSort("park")}>Park</th><th>Status</th><th>Result</th>
              </tr></thead>
              <tbody>{sorted.map((g,i) => (
                <tr key={i}>
                  <td>
                    <div className="team">{g.away} @ {g.home}</div>
                    <div className="pitcher">{g.awayP} vs {g.homeP}
                      {!g.hasPitchers && <span style={{color:"#f59e0b",marginLeft:6,fontSize:11}}>{"\u26A0"} TBD</span>}
                    </div>
                  </td>
                  <td style={{color:"var(--muted)",fontSize:12}}>{g.gameTime} ET</td>
                  <td><BarCell value={g.pNrfi} color="var(--accent)" /></td>
                  <td><BarCell value={g.pYrfi} color="var(--red)" /></td>
                  <td className="odds">{probToAmerican(g.pNrfi)}</td>
                  <td className="odds">{probToAmerican(g.pYrfi)}</td>
                  <td><span style={{color:g.parkFactor>1.03?"var(--red)":g.parkFactor<0.95?"var(--green)":"var(--muted)",fontWeight:600,fontSize:13}}>{g.parkFactor.toFixed(2)}</span></td>
                  <td><StatusPill status={g.status} /></td>
                  <td><ActualBadge runs={g.actual1stRuns} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>}

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

        {tab === "pitchers" && <div className="card" style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Game</th><th>Pitcher</th><th>ERA</th><th>WHIP</th><th>K/9</th><th>BB/9</th><th>HR/9</th><th>IP</th></tr></thead>
            <tbody>{games.flatMap((g,i) => [
              <tr key={`a${i}`} style={{background:"rgba(139,92,246,0.04)"}}>
                <td rowSpan={2}><div className="team">{g.away} @ {g.home}</div></td>
                <td><div style={{fontWeight:600}}>{g.awayP}</div><div style={{fontSize:11,color:"var(--muted)"}}>Away</div></td>
                <td style={{fontWeight:600}}>{g.awayStats?.era?.toFixed(2) ?? "\u2014"}</td>
                <td>{g.awayStats?.whip?.toFixed(2) ?? "\u2014"}</td><td>{g.awayStats?.k9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.awayStats?.bb9?.toFixed(1) ?? "\u2014"}</td><td>{g.awayStats?.hr9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.awayStats?.ip?.toFixed(1) ?? "\u2014"}</td>
              </tr>,
              <tr key={`h${i}`}>
                <td><div style={{fontWeight:600}}>{g.homeP}</div><div style={{fontSize:11,color:"var(--muted)"}}>Home</div></td>
                <td style={{fontWeight:600}}>{g.homeStats?.era?.toFixed(2) ?? "\u2014"}</td>
                <td>{g.homeStats?.whip?.toFixed(2) ?? "\u2014"}</td><td>{g.homeStats?.k9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.homeStats?.bb9?.toFixed(1) ?? "\u2014"}</td><td>{g.homeStats?.hr9?.toFixed(1) ?? "\u2014"}</td>
                <td>{g.homeStats?.ip?.toFixed(1) ?? "\u2014"}</td>
              </tr>
            ])}</tbody>
          </table>
        </div>}
      </>}

      <div style={{marginTop:20,padding:16,background:"var(--card)",borderRadius:10,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
        <strong style={{color:"var(--text)"}}>Data source:</strong> MLB Stats API (statsapi.mlb.com).
        Pitcher stats are current-season totals regressed toward league average based on IP.
        Park factors are static estimates. P(NRFI) = P(0 runs top 1st) &times; P(0 runs bottom 1st).
        Fair odds assume no vig. For completed games, actual first-inning results shown from linescore.
        Model output only &mdash; not financial advice.
      </div>
    </div>
  );
}
