import { useState, useMemo, useEffect, useCallback, useRef } from "react";

const MLB_SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule";
const MLB_PEOPLE_URL = "https://statsapi.mlb.com/api/v1/people";
const MLB_GAME_URL = "https://statsapi.mlb.com/api/v1.1/game";

const TEAM_ABBR = {
  "Arizona Diamondbacks":"ARI","Atlanta Braves":"ATL","Baltimore Orioles":"BAL",
  "Boston Red Sox":"BOS","Chicago Cubs":"CHC","Chicago White Sox":"CWS",
  "Cincinnati Reds":"CIN","Cleveland Guardians":"CLE","Colorado Rockies":"COL",
  "Detroit Tigers":"DET","Houston Astros":"HOU","Kansas City Royals":"KC",
  "Los Angeles Angels":"LAA","Los Angeles Dodgers":"LAD","Miami Marlins":"MIA",
  "Milwaukee Brewers":"MIL","Minnesota Twins":"MIN","New York Mets":"NYM",
  "New York Yankees":"NYY","Oakland Athletics":"OAK","Philadelphia Phillies":"PHI",
  "Pittsburgh Pirates":"PIT","San Diego Padres":"SD","San Francisco Giants":"SF",
  "Seattle Mariners":"SEA","St. Louis Cardinals":"STL","Tampa Bay Rays":"TB",
  "Texas Rangers":"TEX","Toronto Blue Jays":"TOR","Washington Nationals":"WSH",
};

const PARK_FACTORS = {
  COL:1.32,ARI:1.08,BOS:1.07,CIN:1.06,TEX:1.05,TOR:1.04,
  CHC:1.03,PHI:1.02,ATL:1.01,LAA:1.01,MIL:1.00,MIN:1.00,
  NYY:0.99,BAL:0.99,DET:0.98,SF:0.98,CWS:0.97,WSH:0.97,
  KC:0.97,HOU:0.96,PIT:0.96,STL:0.96,CLE:0.95,SD:0.95,
  NYM:0.95,LAD:0.94,SEA:0.93,TB:0.93,MIA:0.92,OAK:0.92,
};

const WIND_SENS = {CHC:1.5,BOS:1.2,CIN:1.1,SF:1.3,PIT:1.0,CLE:1.0,NYM:0.9,NYY:0.9,PHI:0.8,COL:0.7};

const LG = {era:4.20,whip:1.27,k9:8.0,bb9:3.2,hr9:1.20,scoringPct:0.258,fip:4.15,obp:0.317,slg:0.420,woba:0.315,kPct:0.224,bbPct:0.083};

/* ── CSV PARSER ── */
function parseCSVLine(line){const r=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"')q=!q;else if(ch===","&&!q){r.push(c);c="";}else c+=ch;}r.push(c);return r;}
function normalizeName(n){return n.toLowerCase().replace(/[^a-z\s]/g,"").replace(/\s+/g," ").trim();}

function parseFangraphsCSV(csv){
  const lines=csv.trim().split("\n");
  if(lines.length<2)return{};
  const h=parseCSVLine(lines[0]).map(x=>x.trim().toLowerCase());
  const f=(...ns)=>{for(const n of ns){const i=h.indexOf(n.toLowerCase());if(i>=0)return i;}return -1;};
  const nI=f("name","playername","player"),eI=f("era"),fI=f("fip"),wI=f("whip"),k9I=f("k/9","k9","so9"),b9I=f("bb/9","bb9"),h9I=f("hr/9","hr9"),ipI=f("ip","innings"),kpI=f("k%","kpct"),bpI=f("bb%","bbpct"),sI=f("siera"),xI=f("xfip");
  if(nI<0)return{};
  const p={};
  for(let i=1;i<lines.length;i++){
    const c=parseCSVLine(lines[i]);if(c.length<=nI)continue;
    const raw=c[nI]?.trim().replace(/['"]/g,"");if(!raw)continue;
    const gn=(idx)=>{if(idx<0||idx>=c.length)return null;const v=parseFloat(c[idx]?.trim().replace("%",""));return isNaN(v)?null:v;};
    const pr={name:raw,era:gn(eI),fip:gn(fI),whip:gn(wI),k9:gn(k9I),bb9:gn(b9I),hr9:gn(h9I),ip:gn(ipI),kPct:gn(kpI),bbPct:gn(bpI),siera:gn(sI),xfip:gn(xI)};
    if(pr.kPct&&pr.kPct>1)pr.kPct/=100;if(pr.bbPct&&pr.bbPct>1)pr.bbPct/=100;
    p[normalizeName(raw)]=pr;p[raw.split(" ").pop().toLowerCase()]=pr;
  }
  return p;
}

function lookupProjection(proj,name){
  if(!proj||!name||name==="TBD")return null;
  const n=normalizeName(name);if(proj[n])return proj[n];
  const ln=name.split(" ").pop().toLowerCase();if(proj[ln])return proj[ln];
  for(const[k,v]of Object.entries(proj)){if(k.includes(ln))return v;}
  return null;
}

/* ── LIVE PITCHER STATS FALLBACK ── */
async function fetchLivePitcherStats(pid,season){
  try{
    const sp=season?`&season=${season}`:"";
    const r=await fetch(`${MLB_PEOPLE_URL}/${pid}/stats?stats=season&group=pitching&sportId=1${sp}`);
    const d=await r.json();const s=d?.stats?.[0]?.splits?.[0]?.stat;
    if(!s)return null;
    return{era:parseFloat(s.era)||LG.era,fip:null,whip:parseFloat(s.whip)||LG.whip,k9:parseFloat(s.strikeoutsPer9Inn)||LG.k9,bb9:parseFloat(s.walksPer9Inn)||LG.bb9,hr9:parseFloat(s.homeRunsPer9)||LG.hr9,ip:parseFloat(s.inningsPitched)||0,source:"mlb-live"};
  }catch{return null;}
}

/* ── LINEUP ── */
async function fetchLineup(gameId,teamType){
  try{
    const res=await fetch(`${MLB_GAME_URL}/${gameId}/feed/live`);
    const data=await res.json();
    const td=data?.liveData?.boxscore?.teams?.[teamType];
    if(!td)return null;
    const bo=td.battingOrder||[];if(!bo.length)return null;
    const top5=bo.slice(0,5);
    const yr=parseInt(data?.gameData?.datetime?.officialDate?.slice(0,4))||new Date().getFullYear();
    const players=td.players||{};
    const stats=await Promise.all(top5.map(async(pid)=>{
      const p=players[`ID${pid}`];
      const nm=p?.person?.fullName||"Unknown";
      const hand=p?.person?.batSide?.code||"R";
      try{
        let r=await fetch(`${MLB_PEOPLE_URL}/${pid}/stats?stats=season&season=${yr}&group=hitting&sportId=1`);
        let d=await r.json();let s=d?.stats?.[0]?.splits?.[0]?.stat;
        if(!s||!parseFloat(s.plateAppearances)){
          r=await fetch(`${MLB_PEOPLE_URL}/${pid}/stats?stats=season&season=${yr-1}&group=hitting&sportId=1`);
          d=await r.json();s=d?.stats?.[0]?.splits?.[0]?.stat;
        }
        if(!s)return{name:nm,hand,obp:LG.obp,slg:LG.slg,kPct:LG.kPct,bbPct:LG.bbPct,avg:.250,pa:0};
        const pa=parseFloat(s.plateAppearances)||0,ab=parseFloat(s.atBats)||1;
        return{name:nm,hand,obp:parseFloat(s.obp)||LG.obp,slg:parseFloat(s.slg)||LG.slg,avg:parseFloat(s.avg)||.250,kPct:ab>0?(parseFloat(s.strikeOuts)/ab):LG.kPct,bbPct:pa>0?(parseFloat(s.baseOnBalls)/pa):LG.bbPct,pa};
      }catch{return{name:nm,hand,obp:LG.obp,slg:LG.slg,kPct:LG.kPct,bbPct:LG.bbPct,avg:.250,pa:0};}
    }));
    return stats;
  }catch{return null;}
}

/* ── WEATHER ── */
function parseWind(w){
  if(!w)return{speed:0,direction:""};
  const m=w.match(/(\d+)\s*mph/i);const sp=m?parseInt(m[1]):0;
  const l=w.toLowerCase();
  let dir="calm";if(l.includes("out"))dir="out";else if(l.includes("in"))dir="in";else if(l.includes("cross")||l.includes("left")||l.includes("right"))dir="cross";
  return{speed:sp,direction:dir};
}

/* ── MODEL ── */
function estimatePZero(proj,pf,isHome,lineup,weather,hAbbr,f5){
  const baseP=1-LG.scoringPct;
  let lo=Math.log(baseP/(1-baseP));

  // F5 total anchor
  if(f5!=null&&f5>0){
    lo-=(f5-4.5)*0.35;
  }

  // Pitcher
  const ps=(f5!=null&&f5>0)?0.20:1.0;
  if(proj){
    const hasFG=proj.source!=="mlb-live"&&proj.fip!=null;
    const ip=proj.ip||0;
    if(hasFG){
      lo+=(LG.fip-(proj.fip??LG.fip))*0.15*ps;
      lo+=(LG.era-(proj.era??LG.era))*0.06*ps;
      lo+=(LG.whip-(proj.whip??LG.whip))*0.45*ps;
      lo+=((proj.k9??LG.k9)-LG.k9)*0.03*ps;
      lo+=(LG.bb9-(proj.bb9??LG.bb9))*0.05*ps;
      lo+=(LG.hr9-(proj.hr9??LG.hr9))*0.08*ps;
      if(proj.xfip)lo+=(LG.fip-proj.xfip)*0.03*ps;
      if(proj.siera)lo+=(LG.era-proj.siera)*0.03*ps;
    }else{
      const w=Math.min(ip/80,1);
      const bl=(v,lg)=>v*w+lg*(1-w);
      lo+=(LG.era-bl(proj.era??LG.era,LG.era))*0.10*ps;
      lo+=(LG.whip-bl(proj.whip??LG.whip,LG.whip))*0.50*ps;
      lo+=(bl(proj.k9??LG.k9,LG.k9)-LG.k9)*0.03*ps;
      lo+=(LG.bb9-bl(proj.bb9??LG.bb9,LG.bb9))*0.05*ps;
      lo+=(LG.hr9-bl(proj.hr9??LG.hr9,LG.hr9))*0.08*ps;
    }
  }

  // Lineup
  const ls=(f5!=null&&f5>0)?0.25:1.0;
  if(lineup&&lineup.length>=3){
    const avg=(arr,key,fb)=>arr.reduce((s,b)=>s+(b[key]||fb),0)/arr.length;
    lo-=(avg(lineup,"obp",LG.obp)-LG.obp)*2.5*ls;
    lo-=(avg(lineup,"slg",LG.slg)-LG.slg)*1.0*ls;
    lo+=(avg(lineup,"kPct",LG.kPct)-LG.kPct)*0.6*ls;
    lo-=(avg(lineup,"bbPct",LG.bbPct)-LG.bbPct)*0.7*ls;
  }

  // Park
  const pks=(f5!=null&&f5>0)?0.15:1.0;
  lo-=((pf||1.0)-1.0)*1.1*pks;

  // Weather
  if(weather){
    if(weather.temp!=null)lo-=((weather.temp-72)/100)*0.2;
    const wind=parseWind(weather.wind);
    const sens=WIND_SENS[hAbbr]||0.5;
    if(wind.direction==="out"&&wind.speed>5)lo-=(wind.speed/100)*sens*1.1;
    else if(wind.direction==="in"&&wind.speed>5)lo+=(wind.speed/100)*sens*0.7;
  }

  if(isHome)lo-=0.02;
  return Math.max(0.50,Math.min(0.93,1/(1+Math.exp(-lo))));
}

/* ── SCHEDULE ── */
async function fetchGames(ds){
  const r=await fetch(`${MLB_SCHEDULE_URL}?sportId=1&date=${ds}&hydrate=probablePitcher,linescore,weather`);
  const d=await r.json();return d?.dates?.[0]?.games||[];
}
function probToAmerican(p){
  if(p<=0||p>=1)return"N/A";
  if(p>=0.5)return`${Math.round(-(p/(1-p))*100)}`;
  return`+${Math.round(((1-p)/p)*100)}`;
}

/* ── UI COMPONENTS ── */
function BarCell({value,color}){
  return(<div style={{display:"flex",alignItems:"center",gap:6,minWidth:100}}>
    <div style={{flex:1,height:8,background:"var(--bar-bg)",borderRadius:4,overflow:"hidden"}}>
      <div style={{width:`${value*100}%`,height:"100%",background:color,borderRadius:4,transition:"width 0.4s ease"}}/>
    </div>
    <span style={{fontSize:13,fontWeight:600,minWidth:44,textAlign:"right"}}>{(value*100).toFixed(1)}%</span>
  </div>);
}
function Spinner(){
  return(<div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:80,gap:16}}>
    <div style={{width:36,height:36,border:"3px solid var(--border)",borderTopColor:"var(--accent)",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
    <div style={{color:"var(--muted)",fontSize:14}}>Loading games, lineups & pitcher stats...</div>
  </div>);
}
function StatusPill({status}){
  const m={Final:{bg:"rgba(34,197,94,0.15)",c:"#16a34a",t:"FINAL"},"In Progress":{bg:"rgba(59,130,246,0.2)",c:"#3b82f6",t:"LIVE"}};
  const s=m[status]||{bg:"rgba(148,163,184,0.15)",c:"#94a3b8",t:"SCHED"};
  return <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,background:s.bg,color:s.c}}>{s.t}</span>;
}
function ActualBadge({runs}){
  if(runs==null)return null;const n=runs===0;
  return <span style={{fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:5,marginLeft:6,background:n?"rgba(34,197,94,0.15)":"rgba(239,68,68,0.12)",color:n?"#16a34a":"#dc2626"}}>{n?`NRFI \u2713`:`YRFI (${runs}R)`}</span>;
}
function WeatherBadge({weather}){
  if(!weather)return <span style={{color:"var(--muted)",fontSize:11}}>N/A</span>;
  const wind=parseWind(weather.wind);
  const tc=weather.temp>85?"var(--red)":weather.temp<55?"var(--accent)":"var(--muted)";
  const wi=wind.direction==="out"?"\u2197":wind.direction==="in"?"\u2199":"\u2194";
  const wc=wind.direction==="out"&&wind.speed>10?"var(--red)":wind.direction==="in"&&wind.speed>10?"var(--green)":"var(--muted)";
  return(<div style={{fontSize:11,lineHeight:1.5}}>
    <span style={{color:tc,fontWeight:600}}>{weather.temp}{"\u00B0"}F</span>
    {wind.speed>0&&<><span style={{color:"var(--border)",margin:"0 3px"}}>|</span><span style={{color:wc,fontWeight:600}}>{wi} {wind.speed}mph {wind.direction}</span></>}
    {weather.condition&&<div style={{color:"var(--border)",fontSize:10}}>{weather.condition}</div>}
  </div>);
}
function LineupTooltip({lineup}){
  if(!lineup||!lineup.length)return <span style={{color:"var(--muted)",fontSize:11}}>No lineup</span>;
  const ao=lineup.reduce((s,b)=>s+b.obp,0)/lineup.length;
  const as=lineup.reduce((s,b)=>s+b.slg,0)/lineup.length;
  return(<div style={{fontSize:11}}>
    {lineup.map((b,i)=><div key={i} style={{display:"flex",gap:6,color:"var(--muted)",lineHeight:1.6}}>
      <span style={{color:"var(--border)",width:12}}>{i+1}.</span>
      <span style={{color:"var(--text)",fontWeight:500,flex:1}}>{b.name}</span>
      <span>{b.obp?.toFixed(3)}</span><span style={{color:"var(--border)"}}>/</span><span>{b.slg?.toFixed(3)}</span>
    </div>)}
    <div style={{borderTop:"1px solid var(--border)",marginTop:4,paddingTop:4,fontWeight:600,color:"var(--text)"}}>Avg: {ao.toFixed(3)} OBP / {as.toFixed(3)} SLG</div>
  </div>);
}

function CSVUploader({onUpload,projCount}){
  const ref=useRef(null);const[drag,setDrag]=useState(false);
  const handle=(file)=>{if(!file)return;const r=new FileReader();r.onload=(e)=>{const p=parseFangraphsCSV(e.target.result);onUpload(p,Object.keys(p).length);};r.readAsText(file);};
  return(<div style={{background:"var(--card)",borderRadius:12,padding:16,marginBottom:18,border:drag?"2px dashed var(--accent)":"2px dashed var(--border)",transition:"border 0.2s"}}
    onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);handle(e.dataTransfer.files[0]);}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
      <div>
        <div style={{fontSize:14,fontWeight:700}}>FanGraphs Projections</div>
        <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>{projCount>0?<span style={{color:"var(--green)"}}>{"\u2713"} {projCount} pitchers loaded</span>:"Upload CSV from FanGraphs Projections Leaderboard"}</div>
      </div>
      <button className="btn" onClick={()=>ref.current?.click()}>{projCount>0?"Replace CSV":"Upload CSV"}</button>
      <input ref={ref} type="file" accept=".csv" style={{display:"none"}} onChange={e=>handle(e.target.files[0])}/>
    </div>
    {projCount===0&&<div style={{fontSize:11,color:"var(--muted)",marginTop:10,lineHeight:1.6}}>
      <strong>How:</strong> fangraphs.com &rarr; Projections &rarr; Pitchers &rarr; Steamer/ZiPS &rarr; Export Data. Needs: Name, ERA, FIP, WHIP, K/9, BB/9, HR/9, IP.
    </div>}
  </div>);
}

/* ── MAIN APP ── */
export default function App(){
  const[games,setGames]=useState([]);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState(null);
  const[sort,setSort]=useState("nrfi");
  const[filter,setFilter]=useState("all");
  const[tab,setTab]=useState("slate");
  const[selectedDate,setSelectedDate]=useState(()=>new Date().toISOString().slice(0,10));
  const[calOpen,setCalOpen]=useState(false);
  const[calMonth,setCalMonth]=useState(()=>{const d=new Date();return{year:d.getFullYear(),month:d.getMonth()};});
  const[projections,setProjections]=useState({});
  const[projCount,setProjCount]=useState(0);
  const[unmatchedPitchers,setUnmatchedPitchers]=useState([]);
  const[f5Totals,setF5Totals]=useState({});

  const setF5=(k,v)=>setF5Totals(p=>({...p,[k]:v}));
  const handleProjUpload=(p,c)=>{setProjections(p);setProjCount(Math.floor(c/2));};

  const loadGames=useCallback(async(dateStr)=>{
    setLoading(true);setError(null);
    try{
      const raw=await fetchGames(dateStr);
      if(!raw.length){setGames([]);setLoading(false);return;}
      const yr=parseInt(dateStr.slice(0,4));
      const processed=await Promise.all(raw.map(async g=>{
        const away=g.teams?.away?.team?.name||"TBD",home=g.teams?.home?.team?.name||"TBD";
        const aA=TEAM_ABBR[away]||away.slice(0,3).toUpperCase(),hA=TEAM_ABBR[home]||home.slice(0,3).toUpperCase();
        const aPI=g.teams?.away?.probablePitcher,hPI=g.teams?.home?.probablePitcher;
        const aPN=aPI?aPI.fullName:"TBD",hPN=hPI?hPI.fullName:"TBD";

        let aProj=lookupProjection(projections,aPN),hProj=lookupProjection(projections,hPN);
        let aSrc=aProj?"fangraphs":"none",hSrc=hProj?"fangraphs":"none";

        if(!aProj&&aPI?.id){
          let l=await fetchLivePitcherStats(aPI.id,yr);
          if(!l||l.ip===0)l=await fetchLivePitcherStats(aPI.id,yr-1);
          if(l&&l.ip>0){aProj=l;aSrc="mlb-live";}
        }
        if(!hProj&&hPI?.id){
          let l=await fetchLivePitcherStats(hPI.id,yr);
          if(!l||l.ip===0)l=await fetchLivePitcherStats(hPI.id,yr-1);
          if(l&&l.ip>0){hProj=l;hSrc="mlb-live";}
        }

        let aLU=null,hLU=null;
        try{aLU=await fetchLineup(g.gamePk,"away");hLU=await fetchLineup(g.gamePk,"home");}catch{}

        let wx=null;
        if(g.weather)wx={temp:parseInt(g.weather.temp)||null,wind:g.weather.wind||"",condition:g.weather.condition||""};

        const pf=PARK_FACTORS[hA]||1.0;
        const gk=`${aA}@${hA}`;
        const f5=f5Totals[gk]||null;

        const topP=estimatePZero(hProj,pf,false,aLU,wx,hA,f5);
        const botP=estimatePZero(aProj,pf,true,hLU,wx,hA,f5);
        const pN=topP*botP;

        const status=g.status?.detailedState||"Scheduled";
        const gt=g.gameDate?new Date(g.gameDate).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/New_York"}):"";

        let a1R=null;
        const inn=g.linescore?.innings;
        if(inn?.length>0){const tR=inn[0]?.away?.runs??null,bR=inn[0]?.home?.runs??null;if(tR!==null&&bR!==null)a1R=tR+bR;else if(tR!==null)a1R=tR;}

        return{away:aA,home:hA,awayP:aPN,homeP:hPN,awayProj:aProj,homeProj:hProj,awaySource:aSrc,homeSource:hSrc,awayLineup:aLU,homeLineup:hLU,weather:wx,pNrfi:pN,pYrfi:1-pN,topP,botP,parkFactor:pf,status,gameTime:gt,actual1stRuns:a1R,gameKey:gk,hasPitchers:aPN!=="TBD"&&hPN!=="TBD",hasLineups:(aLU?.length>0)&&(hLU?.length>0),hasProj:aProj!=null&&hProj!=null};
      }));

      const um=[];
      processed.forEach(g=>{if(g.awayP!=="TBD"&&!g.awayProj&&projCount>0)um.push(g.awayP);if(g.homeP!=="TBD"&&!g.homeProj&&projCount>0)um.push(g.homeP);});
      setUnmatchedPitchers([...new Set(um)]);
      setGames(processed);
    }catch(e){setError(e.message);}
    setLoading(false);
  },[projections,projCount,f5Totals]);

  useEffect(()=>{loadGames(selectedDate);},[selectedDate,loadGames]);

  const sorted=useMemo(()=>{
    let d=[...games];
    if(filter==="pitchers")d=d.filter(g=>g.hasPitchers);
    if(filter==="pre")d=d.filter(g=>!["Final","In Progress"].includes(g.status));
    if(filter==="lineups")d=d.filter(g=>g.hasLineups);
    if(filter==="proj")d=d.filter(g=>g.hasProj);
    if(sort==="nrfi")d.sort((a,b)=>b.pNrfi-a.pNrfi);
    else if(sort==="yrfi")d.sort((a,b)=>b.pYrfi-a.pYrfi);
    else if(sort==="time")d.sort((a,b)=>a.gameTime.localeCompare(b.gameTime));
    return d;
  },[games,sort,filter]);

  const avgN=games.length?games.reduce((s,g)=>s+g.pNrfi,0)/games.length:0;
  const wP=games.filter(g=>g.hasPitchers).length;
  const wL=games.filter(g=>g.hasLineups).length;
  const wPr=games.filter(g=>g.hasProj).length;
  const fin=games.filter(g=>g.actual1stRuns!==null);
  const aR=fin.length?fin.filter(g=>g.actual1stRuns===0).length/fin.length:null;

  const changeDate=d=>{const dt=new Date(selectedDate+"T12:00:00");dt.setDate(dt.getDate()+d);setSelectedDate(dt.toISOString().slice(0,10));};
  const pickDate=iso=>{setSelectedDate(iso);setCalOpen(false);};
  const calDays=useMemo(()=>{const{year,month}=calMonth;const f=new Date(year,month,1),l=new Date(year,month+1,0),d=[];for(let i=0;i<f.getDay();i++)d.push(null);for(let i=1;i<=l.getDate();i++)d.push(`${year}-${String(month+1).padStart(2,"0")}-${String(i).padStart(2,"0")}`);return d;},[calMonth]);
  const shiftCal=d=>setCalMonth(p=>{let m=p.month+d,y=p.year;if(m<0){m=11;y--;}if(m>11){m=0;y++;}return{year:y,month:m};});
  const quickJump=(y,m,d)=>{const iso=`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;setSelectedDate(iso);setCalMonth({year:y,month:m-1});setCalOpen(false);};
  const displayDate=new Date(selectedDate+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});

  return(
    <div className="dash">
      <div className="hdr">
        <div><div className="title">NRFI / YRFI Model</div><div className="sub">FanGraphs Projections + Lineups + Weather</div></div>
        <div className="date-nav">
          <button onClick={()=>changeDate(-1)}>&larr;</button>
          <button className="date-btn" onClick={()=>{setCalOpen(!calOpen);setCalMonth({year:parseInt(selectedDate.slice(0,4)),month:parseInt(selectedDate.slice(5,7))-1});}}>{"\uD83D\uDCC5"} {displayDate}</button>
          <button onClick={()=>changeDate(1)}>&rarr;</button>
          {calOpen&&<><div className="cal-overlay" onClick={()=>setCalOpen(false)}/><div className="cal">
            <div className="cal-hdr"><button onClick={()=>shiftCal(-1)}>&larr;</button><span>{new Date(calMonth.year,calMonth.month).toLocaleDateString("en-US",{month:"long",year:"numeric"})}</span><button onClick={()=>shiftCal(1)}>&rarr;</button></div>
            <div className="cal-grid">{["Su","Mo","Tu","We","Th","Fr","Sa"].map(d=><div key={d} className="cal-dow">{d}</div>)}{calDays.map((iso,i)=>{if(!iso)return<div key={`e${i}`}/>;const t=new Date().toISOString().slice(0,10);return<button key={iso} className={`cal-day ${iso===selectedDate?"selected":""} ${iso===t?"today":""}`} onClick={()=>pickDate(iso)}>{parseInt(iso.slice(8))}</button>;})}</div>
            <div className="quick-jumps"><button onClick={()=>quickJump(2025,3,27)}>Opening Day '25</button><button onClick={()=>quickJump(2025,7,15)}>All-Star '25</button><button onClick={()=>quickJump(2025,10,1)}>Postseason '25</button><button onClick={()=>pickDate(new Date().toISOString().slice(0,10))}>Today</button></div>
          </div></>}
        </div>
      </div>

      <CSVUploader onUpload={handleProjUpload} projCount={projCount}/>

      {unmatchedPitchers.length>0&&<div style={{background:"rgba(234,179,8,0.1)",border:"1px solid rgba(234,179,8,0.3)",borderRadius:8,padding:12,marginBottom:16,fontSize:12}}>
        <span style={{color:"#eab308",fontWeight:700}}>{"\u26A0"} Unmatched:</span><span style={{color:"var(--muted)",marginLeft:6}}>{unmatchedPitchers.join(", ")}</span>
      </div>}

      <div className="stats">
        <div className="stat"><div className="stat-label">Games</div><div className="stat-val">{games.length}</div></div>
        <div className="stat"><div className="stat-label">Proj Matched</div><div className="stat-val" style={{color:wPr===games.length&&games.length>0?"var(--green)":"var(--text)"}}>{wPr}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Lineups</div><div className="stat-val">{wL}/{games.length}</div></div>
        <div className="stat"><div className="stat-label">Avg NRFI</div><div className="stat-val">{games.length?`${(avgN*100).toFixed(1)}%`:"\u2014"}</div></div>
        <div className="stat"><div className="stat-label">Actual NRFI</div><div className="stat-val">{aR!==null?`${(aR*100).toFixed(0)}%`:"\u2014"}</div>{fin.length>0&&<div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{fin.length} final</div>}</div>
      </div>

      <div className="tabs">{[["slate","Full Slate"],["half","Half-Inning"],["lineups","Lineups"],["projections","Projections"],["environment","Park & Weather"]].map(([k,l])=><div key={k} className={`tab ${tab===k?"active":""}`} onClick={()=>setTab(k)}>{l}</div>)}</div>

      {loading?<Spinner/>:error?<div style={{textAlign:"center",padding:60,color:"var(--red)"}}>Error: {error}</div>:games.length===0?<div style={{textAlign:"center",padding:60,color:"var(--muted)"}}>No games scheduled for this date.</div>:<>

        {tab==="slate"&&<><div className="controls">
          <span style={{fontSize:12,color:"var(--muted)",marginRight:4}}>Sort:</span>
          {[["nrfi","NRFI%"],["yrfi","YRFI%"],["time","Time"]].map(([k,l])=><button key={k} className={`btn ${sort===k?"active":""}`} onClick={()=>setSort(k)}>{l}</button>)}
          <span style={{fontSize:12,color:"var(--muted)",marginLeft:12,marginRight:4}}>Show:</span>
          {[["all","All"],["proj","Has Proj"],["lineups","Lineups"],["pre","Upcoming"]].map(([k,l])=><button key={k} className={`btn ${filter===k?"active":""}`} onClick={()=>setFilter(k)}>{l}</button>)}
        </div>
        <div className="card" style={{overflowX:"auto"}}><table><thead><tr>
          <th>Game</th><th>Time</th><th>F5 Total</th><th onClick={()=>setSort("nrfi")}>P(NRFI)</th><th onClick={()=>setSort("yrfi")}>P(YRFI)</th><th>Fair NRFI</th><th>Fair YRFI</th><th>Data</th><th>Status</th><th>Result</th>
        </tr></thead><tbody>{sorted.map((g,i)=><tr key={i}>
          <td><div className="team">{g.away} @ {g.home}</div><div className="pitcher">{g.awayP} vs {g.homeP}</div></td>
          <td style={{color:"var(--muted)",fontSize:12}}>{g.gameTime} ET</td>
          <td><input type="number" step="0.5" min="0" max="15" placeholder="F5" value={f5Totals[g.gameKey]??""} onChange={e=>setF5(g.gameKey,e.target.value?parseFloat(e.target.value):null)} style={{width:58,padding:"4px 6px",fontSize:13,fontWeight:600,background:"var(--card2)",border:"1px solid var(--border)",borderRadius:6,color:f5Totals[g.gameKey]?"var(--text)":"var(--muted)",textAlign:"center",outline:"none"}}/></td>
          <td><BarCell value={g.pNrfi} color="var(--accent)"/></td>
          <td><BarCell value={g.pYrfi} color="var(--red)"/></td>
          <td className="odds">{probToAmerican(g.pNrfi)}</td>
          <td className="odds">{probToAmerican(g.pYrfi)}</td>
          <td><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {g.awaySource==="fangraphs"&&g.homeSource==="fangraphs"&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(168,85,247,0.15)",color:"#a855f7",fontWeight:600}}>FG</span>}
            {(g.awaySource==="mlb-live"||g.homeSource==="mlb-live")&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(59,130,246,0.15)",color:"var(--accent)",fontWeight:600}}>LIVE</span>}
            {g.hasLineups&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(34,197,94,0.15)",color:"var(--green)",fontWeight:600}}>LU</span>}
            {g.weather?.temp&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(234,179,8,0.15)",color:"#eab308",fontWeight:600}}>W</span>}
            {g.awaySource==="none"&&g.homeSource==="none"&&g.hasPitchers&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(239,68,68,0.12)",color:"var(--red)",fontWeight:600}}>NO DATA</span>}
          </div></td>
          <td><StatusPill status={g.status}/></td>
          <td><ActualBadge runs={g.actual1stRuns}/></td>
        </tr>)}</tbody></table></div></>}

        {tab==="half"&&<div className="card" style={{overflowX:"auto"}}><table><thead><tr><th>Game</th><th>Top 1st P(0R)</th><th>Bot 1st P(0R)</th><th>Combined</th><th>Weakest Half</th><th>Result</th></tr></thead><tbody>{[...games].sort((a,b)=>b.pNrfi-a.pNrfi).map((g,i)=>{const w=g.topP<g.botP?"Top 1st":"Bot 1st",wv=Math.min(g.topP,g.botP);return<tr key={i}><td><div className="team">{g.away} @ {g.home}</div><div className="pitcher">{g.awayP} vs {g.homeP}</div></td><td><BarCell value={g.topP} color="#8b5cf6"/><div className="pitcher">{g.away} bat vs {g.homeP}</div></td><td><BarCell value={g.botP} color="#06b6d4"/><div className="pitcher">{g.home} bat vs {g.awayP}</div></td><td><BarCell value={g.pNrfi} color="var(--accent)"/></td><td><span style={{color:wv<0.78?"var(--red)":"var(--muted)",fontWeight:600,fontSize:13}}>{w} ({(wv*100).toFixed(1)}%)</span></td><td><ActualBadge runs={g.actual1stRuns}/></td></tr>;})}</tbody></table></div>}

        {tab==="lineups"&&<div style={{display:"grid",gap:12}}>{games.map((g,i)=><div key={i} className="card" style={{padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div><span className="team">{g.away} @ {g.home}</span><span className="pitcher" style={{marginLeft:8}}>{g.awayP} vs {g.homeP}</span></div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:13,fontWeight:700,color:"var(--accent)"}}>{(g.pNrfi*100).toFixed(1)}% NRFI</span><ActualBadge runs={g.actual1stRuns}/></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div><div style={{fontSize:12,fontWeight:700,color:"var(--muted)",marginBottom:6}}>{g.away} LINEUP (vs {g.homeP})</div><LineupTooltip lineup={g.awayLineup}/></div>
            <div><div style={{fontSize:12,fontWeight:700,color:"var(--muted)",marginBottom:6}}>{g.home} LINEUP (vs {g.awayP})</div><LineupTooltip lineup={g.homeLineup}/></div>
          </div>
        </div>)}</div>}

        {tab==="projections"&&<div className="card" style={{overflowX:"auto"}}>
          {projCount===0&&<div style={{textAlign:"center",padding:40,color:"var(--muted)"}}><div>No FanGraphs CSV uploaded. Using live MLB stats.</div><div style={{marginTop:8,fontSize:11}}>Upload a CSV above for projection-based pricing.</div></div>}
          <table><thead><tr><th>Game</th><th>Pitcher</th><th>Source</th><th>FIP</th><th>ERA</th><th>WHIP</th><th>K/9</th><th>BB/9</th><th>HR/9</th><th>IP</th></tr></thead><tbody>{games.flatMap((g,i)=>{
            const sb=src=>{if(src==="fangraphs")return<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(168,85,247,0.15)",color:"#a855f7",fontWeight:600}}>FanGraphs</span>;if(src==="mlb-live")return<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(59,130,246,0.15)",color:"var(--accent)",fontWeight:600}}>MLB Live</span>;return<span style={{fontSize:10,padding:"1px 5px",borderRadius:4,background:"rgba(239,68,68,0.12)",color:"var(--red)",fontWeight:600}}>League Avg</span>;};
            return[
              <tr key={`a${i}`} style={{background:"rgba(139,92,246,0.04)"}}><td rowSpan={2}><div className="team">{g.away} @ {g.home}</div></td><td><div style={{fontWeight:600}}>{g.awayP}</div></td><td>{sb(g.awaySource)}</td><td style={{fontWeight:700,color:g.awayProj?.fip<3.2?"var(--green)":g.awayProj?.fip>4.5?"var(--red)":"var(--text)"}}>{g.awayProj?.fip?.toFixed(2)??"\u2014"}</td><td>{g.awayProj?.era?.toFixed(2)??"\u2014"}</td><td>{g.awayProj?.whip?.toFixed(2)??"\u2014"}</td><td>{g.awayProj?.k9?.toFixed(1)??"\u2014"}</td><td>{g.awayProj?.bb9?.toFixed(1)??"\u2014"}</td><td>{g.awayProj?.hr9?.toFixed(1)??"\u2014"}</td><td>{g.awayProj?.ip?.toFixed(0)??"\u2014"}</td></tr>,
              <tr key={`h${i}`}><td><div style={{fontWeight:600}}>{g.homeP}</div></td><td>{sb(g.homeSource)}</td><td style={{fontWeight:700,color:g.homeProj?.fip<3.2?"var(--green)":g.homeProj?.fip>4.5?"var(--red)":"var(--text)"}}>{g.homeProj?.fip?.toFixed(2)??"\u2014"}</td><td>{g.homeProj?.era?.toFixed(2)??"\u2014"}</td><td>{g.homeProj?.whip?.toFixed(2)??"\u2014"}</td><td>{g.homeProj?.k9?.toFixed(1)??"\u2014"}</td><td>{g.homeProj?.bb9?.toFixed(1)??"\u2014"}</td><td>{g.homeProj?.hr9?.toFixed(1)??"\u2014"}</td><td>{g.homeProj?.ip?.toFixed(0)??"\u2014"}</td></tr>
            ];})}</tbody></table>
        </div>}

        {tab==="environment"&&<div className="card" style={{overflowX:"auto"}}><table><thead><tr><th>Game</th><th>Park Factor</th><th>Weather</th><th>Wind Impact</th><th>P(NRFI)</th><th>Result</th></tr></thead><tbody>{[...games].sort((a,b)=>b.pNrfi-a.pNrfi).map((g,i)=>{
          const wind=parseWind(g.weather?.wind);let imp="Neutral",ic="var(--muted)";
          if(wind.direction==="out"&&wind.speed>10){imp="Favors YRFI";ic="var(--red)";}
          else if(wind.direction==="in"&&wind.speed>10){imp="Favors NRFI";ic="var(--green)";}
          else if(g.weather?.temp>85){imp="Hot (more HR)";ic="var(--red)";}
          else if(g.weather?.temp<55){imp="Cold (less carry)";ic="var(--accent)";}
          return<tr key={i}><td><div className="team">{g.away} @ {g.home}</div><div className="pitcher">{g.awayP} vs {g.homeP}</div></td><td><span style={{color:g.parkFactor>1.03?"var(--red)":g.parkFactor<0.95?"var(--green)":"var(--muted)",fontWeight:700,fontSize:14}}>{g.parkFactor.toFixed(2)}</span></td><td><WeatherBadge weather={g.weather}/></td><td><span style={{color:ic,fontWeight:600,fontSize:12}}>{imp}</span></td><td><BarCell value={g.pNrfi} color="var(--accent)"/></td><td><ActualBadge runs={g.actual1stRuns}/></td></tr>;
        })}</tbody></table></div>}

      </>}

      <div style={{marginTop:20,padding:16,background:"var(--card)",borderRadius:10,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
        <strong style={{color:"var(--text)"}}>Model inputs:</strong> F5 total (primary anchor), pitcher projections/stats, top-5 lineup OBP/SLG, park factors, weather. When F5 is entered, pitcher/lineup/park weights are reduced to avoid double-counting. P(NRFI) = P(0R top 1st) &times; P(0R bot 1st). Model output only &mdash; not financial advice.
      </div>
    </div>
  );
}
