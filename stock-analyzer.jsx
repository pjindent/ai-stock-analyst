import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Your local Python server address. Change port if you edited PORT in server.py
const SERVER = "http://localhost:7823";

// ─── CLAUDE RECOMMENDATION (~300 tokens, NO web search) ──────────────────────
// Server provides all data. Claude only writes the recommendation JSON.
const RECO_SYSTEM = `You are a stock analyst. You receive pre-fetched market data and must return ONLY a JSON object — no markdown, no backticks, no preamble.

Based on the data provided, return exactly:
{"rating":"STRONG BUY|BUY|HOLD|SELL|STRONG SELL","entryPrice":0,"priceTarget":0,"stopLoss":0,"upside":0,"confidence":"High|Medium|Low","bullCase":["",""],"bearCase":["",""],"summary":"2 sentences max","zacksRank":0,"zacksEstimate":"improving|stable|deteriorating"}

Rules: 2 bull/bear points max. priceTarget = realistic 12-month. stopLoss = key support. upside = % from current to target. zacksRank 1-5 estimate from EPS data (1=Strong Buy). No web search needed — all data is provided.`;

function buildRecoPrompt(d) {
  const p = d.price, v = d.valuation, t = d.technicals;
  return `${d.ticker} (${d.companyName}) | ${d.sector}
Price: $${p.current} | Chg: ${p.changePct}% | Cap: ${p.marketCap||"N/A"}
52wk: $${p.week52Low}–$${p.week52High} (${p.week52Pos}% from low)
P/E: ${v.peRatio} | FwdPE: ${v.forwardPE} | PEG: ${v.pegRatio} | P/B: ${v.pbRatio}
EPS: ${v.epsTrailing} | EPS Fwd: ${v.epsForward} | Beta: ${v.beta}
ROE: ${v.roe} | RevGrowth: ${v.revenueGrowth} | Margins: ${v.grossMargins}
MA50: $${t.ma50} (${t.priceVsMa50}) | MA200: $${t.ma200} (${t.priceVsMa200})
RSI: ${t.rsi} (${t.rsiSignal}) | MACD: ${t.macd} hist:${t.macdHist} | OBV: ${t.obv}
Overall: ${t.overallTechnical}
News: ${(d.news||[]).slice(0,3).map(n=>`"${n.title}" [${n.time}]`).join(" | ")}`;
}

async function fetchRecommendation(stockData) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: RECO_SYSTEM,
      // NO tools: web_search — all data already provided
      messages: [{ role: "user", content: buildRecoPrompt(stockData) }]
    })
  });
  const result = await res.json();
  if (result.error) throw new Error(result.error.message);
  const text = (result.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s===-1||e===-1) throw new Error("No JSON from Claude");
  return JSON.parse(text.slice(s, e+1));
}

// ─── PERSISTENT STORAGE ───────────────────────────────────────────────────────
const stor = {
  get: async (k, fb) => {
    try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : fb; }
    catch { return fb; }
  },
  set: async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch {} }
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const getRatingColor = (r="") => {
  const u = r.toUpperCase();
  if (u.includes("STRONG BUY"))  return "#10b981";
  if (u.includes("BUY"))         return "#34d399";
  if (u.includes("HOLD"))        return "#f59e0b";
  if (u.includes("STRONG SELL")) return "#ef4444";
  if (u.includes("SELL"))        return "#f87171";
  return "#64748b";
};
const getTechColor  = s => s==="bullish"?"#10b981":s==="bearish"?"#ef4444":"#f59e0b";
const getRsiColor   = v => !v?"#64748b":v>70?"#ef4444":v<30?"#10b981":"#60a5fa";
const getZacksColor = r => ({1:"#10b981",2:"#34d399",3:"#f59e0b",4:"#f87171",5:"#ef4444"}[r]||"#64748b");
const fmt  = (n,d=2) => (n!=null&&!isNaN(n)) ? Number(n).toFixed(d) : "—";
const fmtAge = ts => { const m=Math.floor((Date.now()-ts)/60000); return m<60?`${m}m ago`:`${Math.floor(m/60)}h ago`; };
const parseTickers = s => [...new Set(s.toUpperCase().split(/[\s,]+/).map(t=>t.trim()).filter(Boolean))].slice(0,6);
const RATING_ORDER = ["STRONG BUY","BUY","HOLD","SELL","STRONG SELL"];

// ─── UI ATOMS ─────────────────────────────────────────────────────────────────
const Badge = ({ children, color="#64748b", small }) => (
  <span style={{ background:`${color}20`, color, border:`1px solid ${color}40`,
    borderRadius:4, padding:small?"1px 6px":"2px 8px",
    fontSize:small?9:11, fontWeight:700, letterSpacing:"0.05em", whiteSpace:"nowrap" }}>
    {children}
  </span>
);

const KV = ({ label, value, color }) => (
  <div style={{ background:"#0b1120", border:"1px solid #162032", borderRadius:7, padding:"10px 12px" }}>
    <div style={{ color:"#2d4a6a", fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:3 }}>{label}</div>
    <div style={{ color:color||"#b8cce0", fontSize:16, fontWeight:700, fontFamily:"'JetBrains Mono',monospace" }}>{value??""||"—"}</div>
  </div>
);

const Divider = ({ label }) => (
  <div style={{ display:"flex", alignItems:"center", gap:10, margin:"16px 0 10px" }}>
    <div style={{ flex:1, height:1, background:"#162032" }} />
    <span style={{ color:"#2d4a6a", fontSize:9, textTransform:"uppercase", letterSpacing:"0.12em" }}>{label}</span>
    <div style={{ flex:1, height:1, background:"#162032" }} />
  </div>
);

const Spinner = ({ msg }) => (
  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14, padding:"48px 0" }}>
    <div style={{ position:"relative", width:40, height:40 }}>
      <div style={{ position:"absolute", inset:0, border:"2px solid #162032", borderRadius:"50%" }} />
      <div style={{ position:"absolute", inset:0, border:"2px solid transparent",
        borderTopColor:"#38bdf8", borderRadius:"50%", animation:"spin 0.75s linear infinite" }} />
    </div>
    <p style={{ color:"#2d4a6a", fontSize:10, letterSpacing:"0.14em",
      textTransform:"uppercase", margin:0, maxWidth:340, textAlign:"center" }}>{msg}</p>
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>
);

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
const Sparkline = ({ data, color="#38bdf8", width=500, height=40 }) => {
  if (!data?.length) return null;
  const valid = data.filter(Boolean);
  const min = Math.min(...valid), max = Math.max(...valid), range = max-min||1;
  const pts = valid.map((v,i)=>
    `${(i/(valid.length-1))*width},${height-((v-min)/range)*(height-4)-2}`
  ).join(" ");
  return (
    <svg width={width} height={height} style={{ display:"block", overflow:"visible" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
};

// ─── RANGE BAR ────────────────────────────────────────────────────────────────
const RangeBar = ({ low, high, current, pos }) => (
  <div style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:9, padding:"12px 14px" }}>
    <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
      <span style={{ color:"#2d4a6a", fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em" }}>52-Week Range</span>
      <span style={{ color:"#5a88b0", fontSize:9, fontFamily:"'JetBrains Mono',monospace" }}>{pos}% from low</span>
    </div>
    <div style={{ background:"#162032", borderRadius:4, height:5, position:"relative" }}>
      <div style={{ width:`${pos}%`, height:"100%", background:"linear-gradient(90deg,#ef4444,#f59e0b,#10b981)", borderRadius:4 }} />
      <div style={{ position:"absolute", left:`${pos}%`, top:-5, transform:"translateX(-50%)" }}>
        <div style={{ width:15, height:15, borderRadius:"50%", background:"#38bdf8",
          border:"2px solid #04080f", boxShadow:"0 0 8px #38bdf860" }} />
      </div>
    </div>
    <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
      <span style={{ color:"#ef4444", fontSize:9, fontFamily:"'JetBrains Mono',monospace" }}>${fmt(low)}</span>
      <span style={{ color:"#b8cce0", fontSize:9, background:"#0b1120", padding:"1px 6px", borderRadius:3,
        fontFamily:"'JetBrains Mono',monospace" }}>${fmt(current)}</span>
      <span style={{ color:"#10b981", fontSize:9, fontFamily:"'JetBrains Mono',monospace" }}>${fmt(high)}</span>
    </div>
  </div>
);

// ─── QUICK CARD ───────────────────────────────────────────────────────────────
const QuickCard = ({ s, onFullReport, loadingFull }) => {
  const rec = s.recommendation || {};
  const rc  = getRatingColor(rec.rating);
  const tc  = getTechColor(s.technicals?.overallTechnical);
  const isLoading = loadingFull === s.ticker;

  return (
    <div style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:12,
      padding:18, display:"flex", flexDirection:"column", gap:11 }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div>
          <div style={{ color:"#38bdf8", fontFamily:"'JetBrains Mono',monospace",
            fontWeight:800, fontSize:20 }}>{s.ticker}</div>
          <div style={{ color:"#2d4a6a", fontSize:10, marginTop:1 }}>{s.companyName}</div>
          {s.sector && <div style={{ color:"#1e3050", fontSize:9 }}>{s.sector}</div>}
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:800,
            fontSize:18, color:"#e0f0ff" }}>${fmt(s.price?.current)}</div>
          <div style={{ color:s.price?.changePct>=0?"#34d399":"#f87171",
            fontSize:11, fontFamily:"'JetBrains Mono',monospace" }}>
            {s.price?.changePct>=0?"▲":"▼"} {fmt(Math.abs(s.price?.changePct))}%
          </div>
          {s.price?.marketCap && (
            <div style={{ color:"#1e3050", fontSize:9 }}>Cap {s.price.marketCap}</div>
          )}
        </div>
      </div>

      {/* Mini range bar */}
      {s.price?.week52Pos != null && (
        <div style={{ background:"#0b1120", borderRadius:4, height:4, position:"relative" }}>
          <div style={{ width:`${s.price.week52Pos}%`, height:"100%",
            background:"linear-gradient(90deg,#ef4444,#f59e0b,#10b981)", borderRadius:4 }} />
          <div style={{ position:"absolute", left:`${s.price.week52Pos}%`, top:-3, transform:"translateX(-50%)" }}>
            <div style={{ width:10, height:10, borderRadius:"50%", background:"#38bdf8", border:"1px solid #04080f" }} />
          </div>
        </div>
      )}

      {/* Metrics grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5 }}>
        {[
          ["P/E",     fmt(s.valuation?.peRatio),          "#b8cce0"],
          ["Fwd P/E", fmt(s.valuation?.forwardPE),         "#b8cce0"],
          ["RSI",     fmt(s.technicals?.rsi,1),            getRsiColor(s.technicals?.rsi)],
          ["Signal",  (s.technicals?.overallTechnical||"").toUpperCase(), tc],
        ].map(([l,v,c]) => (
          <div key={l} style={{ background:"#0b1120", borderRadius:5, padding:"5px 7px", textAlign:"center" }}>
            <div style={{ color:"#2d4a6a", fontSize:8, textTransform:"uppercase", letterSpacing:"0.06em" }}>{l}</div>
            <div style={{ color:c, fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:12 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Rating row */}
      {rec.rating ? (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:7 }}>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
            <Badge color={rc}>{rec.rating}</Badge>
            <Badge color={rec.confidence==="High"?"#10b981":rec.confidence==="Medium"?"#f59e0b":"#ef4444"} small>
              {rec.confidence}
            </Badge>
          </div>
          <div style={{ display:"flex", gap:12 }}>
            {[["Target",`$${fmt(rec.priceTarget)}`,"#34d399"],
              ["Upside",`+${fmt(rec.upside)}%`,"#34d399"],
              ["Stop",`$${fmt(rec.stopLoss)}`,"#f87171"]
            ].map(([l,v,c]) => (
              <div key={l} style={{ textAlign:"center" }}>
                <div style={{ color:"#2d4a6a", fontSize:8, textTransform:"uppercase", letterSpacing:"0.06em" }}>{l}</div>
                <div style={{ color:c, fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:12 }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ color:"#1e3050", fontSize:10, fontStyle:"italic" }}>No recommendation yet — click Full Report</div>
      )}

      {/* Source badge */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Badge color="#2d4a6a" small>
          {s.source === "yfinance" ? "📊 yfinance" : s.source === "finnhub" ? "📡 Finnhub" : "data"} · 0 tokens
        </Badge>
        {s.asOf && <span style={{ color:"#1e3050", fontSize:8 }}>{s.asOf}</span>}
      </div>

      {/* Full report button */}
      <button onClick={() => onFullReport(s.ticker)} disabled={isLoading}
        style={{ background:"transparent", border:"1px solid #1e3a5f",
          borderRadius:7, color:"#38bdf8", fontSize:11, fontWeight:600,
          padding:"8px 0", cursor:isLoading?"default":"pointer",
          letterSpacing:"0.06em", display:"flex", alignItems:"center",
          justifyContent:"center", gap:6, transition:"border-color 0.2s" }}>
        {isLoading
          ? <><span style={{ width:12, height:12, border:"1.5px solid #38bdf830",
              borderTopColor:"#38bdf8", borderRadius:"50%", display:"inline-block",
              animation:"spin 0.7s linear infinite" }} /> Getting AI recommendation…</>
          : rec.rating
            ? "🔄 Refresh Recommendation →"
            : "⚡ Get AI Recommendation (~300 tokens) →"}
      </button>
    </div>
  );
};

// ─── FULL DETAIL ──────────────────────────────────────────────────────────────
const FullDetail = ({ data, onBack }) => {
  const rec=data.recommendation||{}, p=data.price||{}, val=data.valuation||{}, tech=data.technicals||{};
  const rc=getRatingColor(rec.rating), tc=getTechColor(tech.overallTechnical);
  return (
    <div className="fade-in">
      <button onClick={onBack} style={{ background:"none", border:"1px solid #162032",
        borderRadius:6, color:"#5a88b0", fontSize:10, padding:"5px 12px",
        cursor:"pointer", marginBottom:16, letterSpacing:"0.06em" }}>← Back</button>

      {/* Header */}
      <div style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:14,
        padding:20, marginBottom:10, display:"flex", justifyContent:"space-between",
        alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:5, flexWrap:"wrap" }}>
            <span style={{ color:"#38bdf8", fontFamily:"'JetBrains Mono',monospace",
              fontWeight:800, fontSize:24 }}>{data.ticker}</span>
            <span style={{ color:"#1e3050" }}>·</span>
            <span style={{ color:"#5a88b0", fontSize:14 }}>{data.companyName}</span>
          </div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:4 }}>
            {data.sector   && <Badge color="#5a88b0" small>{data.sector}</Badge>}
            {data.industry && <Badge color="#2d4a6a" small>{data.industry}</Badge>}
            <Badge color="#2d4a6a" small>
              {data.source==="yfinance"?"📊 yfinance":"📡 Finnhub"} · 0 data tokens
            </Badge>
          </div>
          <div style={{ color:"#1e3050", fontSize:9 }}>{data.asOf}</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:30,
            fontWeight:800, color:"#e0f0ff" }}>${fmt(p.current)}</div>
          <div style={{ color:p.change>=0?"#34d399":"#f87171", fontSize:13,
            fontFamily:"'JetBrains Mono',monospace" }}>
            {p.change>=0?"▲":"▼"} ${fmt(Math.abs(p.change))} ({p.change>=0?"+":""}{fmt(p.changePct)}%)
          </div>
          <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:3, flexWrap:"wrap" }}>
            {p.marketCap && <span style={{ color:"#2d4a6a", fontSize:9 }}>Cap {p.marketCap}</span>}
            {p.volume    && <span style={{ color:"#2d4a6a", fontSize:9 }}>Vol {p.volume}</span>}
          </div>
        </div>
      </div>

      {/* Sparkline */}
      {tech.sparkline?.length > 0 && (
        <div style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:9,
          padding:"10px 14px", marginBottom:10, display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ color:"#2d4a6a", fontSize:9, textTransform:"uppercase",
            letterSpacing:"0.1em", whiteSpace:"nowrap" }}>60-Day</span>
          <div style={{ flex:1 }}>
            <Sparkline data={tech.sparkline} color={getRatingColor(rec.rating)} width={600} height={40} />
          </div>
        </div>
      )}

      {/* Recommendation */}
      <div style={{ background:`${rc}12`, border:`1px solid ${rc}35`, borderRadius:12,
        padding:"14px 18px", marginBottom:10, display:"flex",
        justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span style={{ background:rc, color:"#000", fontWeight:800, fontSize:12,
            padding:"5px 14px", borderRadius:6, letterSpacing:"0.08em" }}>{rec.rating}</span>
          <Badge color={rec.confidence==="High"?"#10b981":rec.confidence==="Medium"?"#f59e0b":"#ef4444"}>
            {rec.confidence} confidence
          </Badge>
          <span style={{ color:"#1e3050", fontSize:9 }}>~300 AI tokens</span>
        </div>
        <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
          {[["Entry",`$${fmt(rec.entryPrice)}`,"#b8cce0"],
            ["Target",`$${fmt(rec.priceTarget)}`,"#34d399"],
            ["Stop",`$${fmt(rec.stopLoss)}`,"#f87171"],
            ["Upside",`+${fmt(rec.upside)}%`,"#34d399"]
          ].map(([l,v,c]) => (
            <div key={l} style={{ textAlign:"center" }}>
              <div style={{ color:"#2d4a6a", fontSize:8, textTransform:"uppercase", letterSpacing:"0.1em" }}>{l}</div>
              <div style={{ color:c, fontFamily:"'JetBrains Mono',monospace", fontWeight:700, fontSize:14 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {p.week52Pos != null && (
        <div style={{ marginBottom:10 }}>
          <RangeBar low={p.week52Low} high={p.week52High} current={p.current} pos={p.week52Pos} />
        </div>
      )}

      <Divider label="Valuation" />
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(115px,1fr))", gap:7, marginBottom:4 }}>
        <KV label="P/E TTM"     value={fmt(val.peRatio)} />
        <KV label="Forward P/E" value={fmt(val.forwardPE)} />
        <KV label="PEG"         value={fmt(val.pegRatio)}
          color={val.pegRatio<1?"#10b981":val.pegRatio>2?"#f87171":"#b8cce0"} />
        <KV label="P/B"         value={fmt(val.pbRatio)} />
        <KV label="EPS TTM"     value={val.epsTrailing?`$${fmt(val.epsTrailing)}`:"—"} />
        <KV label="EPS Fwd"     value={val.epsForward?`$${fmt(val.epsForward)}`:"—"} />
        <KV label="Div Yield"   value={val.divYield||"None"} color="#f59e0b" />
        <KV label="Beta"        value={fmt(val.beta)}
          color={val.beta>1.5?"#f87171":val.beta<0.7?"#34d399":"#b8cce0"} />
        <KV label="ROE"         value={val.roe||"—"} />
        <KV label="Rev Growth"  value={val.revenueGrowth||"—"}
          color={parseFloat(val.revenueGrowth)>0?"#34d399":"#f87171"} />
        <KV label="Margins"     value={val.grossMargins||"—"} />
      </div>

      <Divider label="Technical Indicators" />
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:7, marginBottom:4 }}>
        <KV label="50-Day MA"    value={tech.ma50?`$${fmt(tech.ma50)}`:"—"} color={tech.priceVsMa50==="above"?"#34d399":"#f87171"} />
        <KV label="200-Day MA"   value={tech.ma200?`$${fmt(tech.ma200)}`:"—"} color={tech.priceVsMa200==="above"?"#34d399":"#f87171"} />
        <KV label="MA50 Signal"  value={tech.priceVsMa50?.toUpperCase()||"—"} color={tech.priceVsMa50==="above"?"#34d399":"#f87171"} />
        <KV label="MA200 Signal" value={tech.priceVsMa200?.toUpperCase()||"—"} color={tech.priceVsMa200==="above"?"#34d399":"#f87171"} />
        <KV label="RSI (14)"     value={tech.rsi?fmt(tech.rsi,1):"—"} color={getRsiColor(tech.rsi)} />
        <KV label="RSI Signal"   value={tech.rsiSignal?.toUpperCase()||"—"}
          color={tech.rsiSignal==="overbought"?"#ef4444":tech.rsiSignal==="oversold"?"#10b981":"#f59e0b"} />
        <KV label="MACD"         value={tech.macd?.toUpperCase()||"—"} color={tech.macd==="bullish"?"#34d399":"#f87171"} />
        <KV label="MACD Hist"    value={tech.macdHist?fmt(tech.macdHist,4):"—"} color={tech.macdHist>0?"#34d399":"#f87171"} />
        <KV label="OBV"          value={tech.obv?.toUpperCase()||"—"} color={tech.obv==="rising"?"#34d399":"#f87171"} />
        <KV label="Overall"      value={tech.overallTechnical?.toUpperCase()||"—"} color={tc} />
      </div>

      <Divider label="Recent News" />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, marginBottom:4 }}>
        {(data.news||[]).slice(0,6).map((n,i) => (
          <div key={i} style={{ borderLeft:"2px solid #162032", paddingLeft:10 }}>
            <p style={{ color:"#7a9cc8", fontSize:11, margin:"0 0 2px", lineHeight:1.4 }}>{n.title}</p>
            <p style={{ color:"#2d4a6a", fontSize:9, margin:0 }}>{n.publisher} · {n.time}</p>
          </div>
        ))}
      </div>

      <Divider label="AI Recommendation" />
      <div style={{ display:"grid", gridTemplateColumns:"80px 1fr 1fr", gap:9, marginBottom:10 }}>
        <div style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:10,
          padding:12, display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", gap:5 }}>
          <span style={{ color:"#2d4a6a", fontSize:8, textTransform:"uppercase", letterSpacing:"0.1em" }}>Zacks Est.</span>
          <span style={{ background:getZacksColor(rec.zacksRank), color:"#000", fontWeight:800,
            fontSize:20, width:40, height:40, borderRadius:8, display:"flex",
            alignItems:"center", justifyContent:"center", fontFamily:"'JetBrains Mono',monospace" }}>
            {rec.zacksRank||"?"}
          </span>
          <span style={{ color:"#2d4a6a", fontSize:8, textAlign:"center" }}>{rec.zacksEstimate}</span>
        </div>
        {[["Bull Case",rec.bullCase,"#10b981","✓"],["Bear Case",rec.bearCase,"#ef4444","✗"]].map(([title,items,color,icon])=>(
          <div key={title} style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:10, padding:13 }}>
            <div style={{ color, fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:8 }}>{title}</div>
            {items?.map((item,i) => (
              <div key={i} style={{ display:"flex", gap:7, marginBottom:6 }}>
                <span style={{ color, fontSize:11, flexShrink:0 }}>{icon}</span>
                <span style={{ color:"#5a88b0", fontSize:11, lineHeight:1.5 }}>{item}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ background:"#04080f", border:"1px solid #162032", borderLeft:"3px solid #38bdf8",
        borderRadius:9, padding:14, marginBottom:20 }}>
        <div style={{ color:"#38bdf8", fontSize:8, textTransform:"uppercase",
          letterSpacing:"0.15em", marginBottom:6, fontWeight:700 }}>Summary · ~300 tokens</div>
        <p style={{ color:"#5a88b0", fontSize:13, lineHeight:1.75, margin:0 }}>{rec.summary}</p>
      </div>
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [serverOk,    setServerOk]    = useState(null); // null=checking, true=ok, false=down
  const [input,       setInput]       = useState("");
  const [fetching,    setFetching]    = useState(false);
  const [fetchMsg,    setFetchMsg]    = useState("");
  const [loadingReco, setLoadingReco] = useState(null);
  const [stocks,      setStocks]      = useState({});    // { [ticker]: stockData }
  const [stockTs,     setStockTs]     = useState({});
  const [selected,    setSelected]    = useState(null);
  const [watchlist,   setWatchlist]   = useState([]);
  const [error,       setError]       = useState("");
  const inputRef = useRef(null);

  // ── Load persistent state & check server ─────────────────────────────────
  useEffect(() => {
    (async () => {
      const [wl, sd, st] = await Promise.all([
        stor.get("sa-wl-v5",      []),
        stor.get("sa-stocks-v5",  {}),
        stor.get("sa-stockts-v5", {}),
      ]);
      setWatchlist(wl);
      setStocks(sd);
      setStockTs(st);
      checkServer();
    })();
    inputRef.current?.focus();
  }, []);

  const checkServer = async () => {
    try {
      const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      setServerOk(j.status === "ok");
    } catch {
      setServerOk(false);
    }
  };

  const persistStocks = useCallback(async (sd, st) => {
    await Promise.all([stor.set("sa-stocks-v5", sd), stor.set("sa-stockts-v5", st)]);
  }, []);

  // ── Fetch stock data from LOCAL SERVER ───────────────────────────────────
  const fetchStocks = async (overrideTickers) => {
    const tickers = parseTickers(overrideTickers || input);
    if (!tickers.length) return;

    const now    = Date.now();
    const maxAge = 5 * 60 * 1000; // 5-min cache (data is live, refresh often)
    const stale  = tickers.filter(t => !stockTs[t] || (now - stockTs[t]) >= maxAge);
    const fresh  = tickers.filter(t => !stale.includes(t));

    if (!stale.length) {
      setError("");
      return;
    }

    setFetching(true);
    setError("");
    setFetchMsg(`Fetching ${stale.length} ticker${stale.length>1?"s":""} from local server… (0 tokens)`);

    try {
      const url = `${SERVER}/batch?tickers=${stale.join(",")}`;
      const res = await fetch(url);
      const json = await res.json();

      if (json.error) throw new Error(json.error);

      const newStocks = { ...stocks };
      const newTs     = { ...stockTs };
      (json.results || []).forEach(s => {
        newStocks[s.ticker] = s;
        newTs[s.ticker]     = Date.now();
      });

      setStocks(newStocks);
      setStockTs(newTs);
      await persistStocks(newStocks, newTs);

      if (json.errors?.length) {
        setError(json.errors.join("\n"));
      }
    } catch (e) {
      setError(`Server error: ${e.message}\n\nMake sure your local server is running:\n  python server.py`);
    } finally {
      setFetching(false);
    }
  };

  // ── Get AI recommendation for one ticker (NO web search) ─────────────────
  const getRecommendation = async (ticker) => {
    const stockData = stocks[ticker];
    if (!stockData) return;

    setLoadingReco(ticker);
    setError("");

    try {
      const rec = await fetchRecommendation(stockData);
      const newStocks = { ...stocks, [ticker]: { ...stockData, recommendation: rec } };
      setStocks(newStocks);
      await persistStocks(newStocks, stockTs);
    } catch (e) {
      setError(`Recommendation failed for ${ticker}: ${e.message}`);
    } finally {
      setLoadingReco(null);
    }
  };

  // ── Watchlist ─────────────────────────────────────────────────────────────
  const addWatch    = async t => { if (watchlist.includes(t)) return; const u=[...watchlist,t]; setWatchlist(u); await stor.set("sa-wl-v5",u); };
  const removeWatch = async t => { const u=watchlist.filter(x=>x!==t); setWatchlist(u); await stor.set("sa-wl-v5",u); };
  const clearCache  = async t => { const ns={...stocks},nt={...stockTs}; delete ns[t]; delete nt[t]; setStocks(ns); setStockTs(nt); await persistStocks(ns,nt); };

  const tickers     = parseTickers(input);
  const now         = Date.now();
  const maxAge      = 5 * 60 * 1000;
  const displayList = tickers.length > 0
    ? tickers.filter(t => stocks[t]).map(t => stocks[t])
    : Object.values(stocks).sort((a,b) => (b.price?.current||0)-(a.price?.current||0)).slice(0,12);

  const sorted = [...displayList].sort((a,b) => {
    const ra = RATING_ORDER.indexOf(a.recommendation?.rating?.toUpperCase());
    const rb = RATING_ORDER.indexOf(b.recommendation?.rating?.toUpperCase());
    if (ra === -1 && rb === -1) return 0;
    if (ra === -1) return 1;
    if (rb === -1) return -1;
    return ra - rb;
  });

  const selectedData = selected ? stocks[selected] : null;

  return (
    <div style={{ minHeight:"100vh", background:"#04080f",
      fontFamily:"'Segoe UI','Helvetica Neue',sans-serif", color:"#b8cce0", padding:"20px 16px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap');
        *{box-sizing:border-box}
        input::placeholder{color:#162032}
        input:focus{outline:none;border-color:#38bdf8!important}
        .fade-in{animation:fadeIn 0.3s ease forwards}
        @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        button:disabled{opacity:0.3;cursor:default!important}
      `}</style>

      <div style={{ maxWidth:980, margin:"0 auto" }}>

        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between",
          alignItems:"flex-start", flexWrap:"wrap", gap:10, marginBottom:18 }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:2 }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"#38bdf8",
                boxShadow:"0 0 10px #38bdf8aa" }} />
              <span style={{ color:"#38bdf8", fontSize:8, letterSpacing:"0.2em",
                textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace", fontWeight:700 }}>
                AI Stock Analyst
              </span>
            </div>
            <h1 style={{ margin:0, fontSize:21, fontWeight:800,
              letterSpacing:"-0.03em", color:"#e0f0ff" }}>Market Intelligence</h1>
            <p style={{ margin:"2px 0 0", color:"#1e3050", fontSize:10 }}>
              Local server (0 tokens) · Claude AI synthesis (~300 tokens/ticker)
            </p>
          </div>

          {/* Server status */}
          <div style={{ background:"#080f1c", border:"1px solid #162032",
            borderRadius:8, padding:"8px 14px", textAlign:"center", minWidth:130 }}>
            <div style={{ color:"#2d4a6a", fontSize:8, textTransform:"uppercase",
              letterSpacing:"0.1em", marginBottom:4 }}>Local Server</div>
            {serverOk === null && <div style={{ color:"#f59e0b", fontSize:11 }}>checking…</div>}
            {serverOk === true  && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:"#10b981",
                  boxShadow:"0 0 6px #10b981" }} />
                <span style={{ color:"#10b981", fontSize:11, fontWeight:700 }}>Online · 0 tokens</span>
              </div>
            )}
            {serverOk === false && (
              <div>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:5, marginBottom:3 }}>
                  <div style={{ width:7, height:7, borderRadius:"50%", background:"#ef4444" }} />
                  <span style={{ color:"#ef4444", fontSize:11, fontWeight:700 }}>Offline</span>
                </div>
                <button onClick={checkServer}
                  style={{ background:"none", border:"1px solid #162032", borderRadius:4,
                    color:"#5a88b0", fontSize:8, padding:"2px 7px", cursor:"pointer" }}>
                  retry
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Server offline banner */}
        {serverOk === false && (
          <div style={{ background:"#1c0a0a", border:"1px solid #7f1d1d", borderRadius:10,
            padding:"14px 16px", marginBottom:16 }}>
            <div style={{ color:"#f87171", fontWeight:700, fontSize:12, marginBottom:6 }}>
              ⚠ Local server not running
            </div>
            <div style={{ color:"#9a4a4a", fontSize:11, lineHeight:1.7, fontFamily:"'JetBrains Mono',monospace" }}>
              1. Install: <span style={{ color:"#fca5a5" }}>pip install yfinance flask flask-cors</span><br/>
              2. Run:     <span style={{ color:"#fca5a5" }}>python server.py</span><br/>
              3. Server starts on <span style={{ color:"#fca5a5" }}>http://localhost:7823</span>
            </div>
          </div>
        )}

        {/* Watchlist */}
        {watchlist.length > 0 && (
          <div style={{ background:"#080f1c", border:"1px solid #162032", borderRadius:10,
            padding:"8px 12px", marginBottom:12, display:"flex",
            alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ color:"#2d4a6a", fontSize:8, textTransform:"uppercase",
              letterSpacing:"0.12em" }}>Watchlist</span>
            {watchlist.map(t => (
              <div key={t} style={{ display:"flex", alignItems:"center", gap:4,
                background:"#04080f", border:"1px solid #162032",
                borderRadius:5, padding:"2px 7px" }}>
                <span style={{ color:"#38bdf8", fontFamily:"'JetBrains Mono',monospace",
                  fontWeight:700, fontSize:11 }}>{t}</span>
                {stockTs[t] && <span style={{ color:"#1e3050", fontSize:8 }}>· {fmtAge(stockTs[t])}</span>}
                <button onClick={()=>removeWatch(t)} style={{ background:"none", border:"none",
                  color:"#2d4a6a", cursor:"pointer", fontSize:13, padding:"0 0 0 2px", lineHeight:1 }}>×</button>
              </div>
            ))}
            <button onClick={() => { setInput(watchlist.join(",")); fetchStocks(watchlist.join(",")); }}
              disabled={fetching || serverOk === false}
              style={{ marginLeft:"auto", background:"#0c2034", border:"1px solid #38bdf8",
                borderRadius:6, color:"#38bdf8", fontSize:9, fontWeight:700,
                padding:"3px 10px", cursor:"pointer", letterSpacing:"0.08em" }}>
              ⚡ FETCH ALL
            </button>
          </div>
        )}

        {/* Input */}
        <div style={{ display:"flex", gap:10, marginBottom:8 }}>
          <input ref={inputRef} value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key==="Enter" && fetchStocks()}
            placeholder="AAPL, NVDA, TSLA  (up to 6 tickers)"
            disabled={fetching}
            style={{ flex:1, background:"#080f1c", border:"1px solid #162032",
              borderRadius:8, padding:"11px 14px", color:"#e0f0ff",
              fontSize:14, fontFamily:"'JetBrains Mono',monospace",
              letterSpacing:"0.04em", transition:"border-color 0.2s" }} />
          <button onClick={() => fetchStocks()} disabled={fetching||!input.trim()||serverOk===false}
            style={{ background:fetching?"#0c2034":"#0369a1", border:"none",
              borderRadius:8, padding:"11px 18px", color:"#fff",
              fontSize:12, fontWeight:700, cursor:"pointer",
              letterSpacing:"0.04em", whiteSpace:"nowrap" }}>
            {fetching ? "Fetching…" : "Fetch Data →"}
          </button>
        </div>

        {/* Ticker chips */}
        {tickers.length > 0 && !fetching && (
          <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
            {tickers.map(t => {
              const isCached = !!stocks[t];
              return (
                <div key={t} style={{ display:"flex", alignItems:"center", gap:5,
                  background:"#080f1c", border:`1px solid ${isCached?"#166534":"#162032"}`,
                  borderRadius:6, padding:"3px 8px" }}>
                  <span style={{ color:isCached?"#34d399":"#38bdf8", fontSize:11,
                    fontFamily:"'JetBrains Mono',monospace", fontWeight:700 }}>{t}</span>
                  {isCached
                    ? <span style={{ color:"#1a5c2e", fontSize:8 }}>
                        ⚡ {fmtAge(stockTs[t])} ·{" "}
                        <button onClick={() => clearCache(t)} style={{ background:"none",
                          border:"none", color:"#60a5fa", cursor:"pointer", fontSize:8, padding:0 }}>
                          refresh
                        </button>
                      </span>
                    : <span style={{ color:"#1e3050", fontSize:8 }}>0 tokens</span>}
                  {!watchlist.includes(t) && (
                    <button onClick={() => addWatch(t)} style={{ background:"none", border:"none",
                      color:"#2d4a6a", cursor:"pointer", fontSize:8, padding:"0 0 0 2px" }}>
                      +watch
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {fetching && <Spinner msg={fetchMsg} />}

        {error && (
          <div style={{ background:"#110508", border:"1px solid #7f1d1d", borderRadius:8,
            padding:12, color:"#fca5a5", fontSize:11, marginBottom:12,
            whiteSpace:"pre-wrap", fontFamily:"'JetBrains Mono',monospace" }}>
            {error.trim()}
          </div>
        )}

        {/* Results */}
        {!fetching && (
          selectedData
            ? <div className="fade-in">
                <FullDetail data={selectedData} onBack={() => setSelected(null)} />
              </div>
            : sorted.length > 0 && (
              <div className="fade-in">
                <div style={{ color:"#2d4a6a", fontSize:9, marginBottom:10,
                  textTransform:"uppercase", letterSpacing:"0.08em" }}>
                  {sorted.length} ticker{sorted.length>1?"s":""} ·{" "}
                  {sorted.filter(s=>s.recommendation).length} with AI recommendations
                </div>
                <div style={{ display:"grid",
                  gridTemplateColumns: sorted.length===1 ? "minmax(300px,460px)" : "repeat(auto-fill,minmax(270px,1fr))",
                  gap:12 }}>
                  {sorted.map(s => (
                    <div key={s.ticker}>
                      <QuickCard
                        s={s}
                        onFullReport={getRecommendation}
                        loadingFull={loadingReco}
                      />
                      {s.recommendation && (
                        <button onClick={() => setSelected(s.ticker)}
                          style={{ width:"100%", background:"none", border:"1px solid #162032",
                            borderTop:"none", borderRadius:"0 0 12px 12px", color:"#5a88b0",
                            fontSize:10, padding:"6px 0", cursor:"pointer", letterSpacing:"0.06em" }}>
                          View Full Detail →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
        )}

        <div style={{ color:"#0e1e30", fontSize:8, textAlign:"center", marginTop:20, letterSpacing:"0.05em" }}>
          DATA: LOCAL SERVER (YFINANCE/FINNHUB) · 0 TOKENS · AI SYNTHESIS: ~300 TOKENS · NOT FINANCIAL ADVICE
        </div>
      </div>
    </div>
  );
}
