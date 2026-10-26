// The debug screen's History panel: village numbers over game time, from the village history the game records and saves with the
// world (js/villagestats.js, spec r15-69), passed on by the debug server (debug/vhist.js, "vhist" events on /events). Kept out of debug/index.html, which only gives it a panel (#hpanel), its
// event stream (BFHist.attach) and each snapshot with the village on show (BFHist.snap).
//   Metrics: population, food stock, deaths and trades (each over the last 7 game days), unemployment (% of adults), happiness.
//   Scope: the village on show, the loaded villages, or every village this world has loaded.
//   One village: any number of metrics at once, each on its own vertical axis; "Hide unloaded time" leaves out the time it sat unloaded.
//   Several villages: one metric, a thin line per village (dotted and flat at its last value while it was unloaded) and a bold line
//   for their total, or their average where a total means nothing (unemployment pools every adult; happiness is the mean).
// API: window.BFHist = { attach(es, {pick(key)}), snap(snapshot, viewKey), data(), METRICS, series(key, metric), aggregate(keys, metric, t), render() }
(() => {
"use strict";
const SAMPLE = { t: 0, pop: 1, food: 2, deaths: 3, trades: 4, unemp: 5, adults: 6, happy: 7 };
const unempOf = x => x[6] > 0 && x[5] != null ? x[5] / x[6] * 100 : null;
// key, button, axis title, value(sample), how villages combine (and what the chart calls it), colour
const METRICS = [
  { k: "pop", b: "Population", h: "Villagers", v: x => x[1], agg: "total", color: "var(--info)" },
  { k: "food", b: "Food", h: "Food (bread)", v: x => x[2], agg: "total", color: "var(--chest)", t: "Bread-equivalent held by its villagers and in their chests" },
  { k: "deaths", b: "Deaths", h: "Deaths, last 7 days", v: x => x[3], agg: "total", color: "var(--death)", t: "Villagers who died in the 7 game days before each point" },
  { k: "trades", b: "Trades", h: "Trades, last 7 days", v: x => x[4], agg: "total", color: "var(--trade)", t: "Trades in the 7 game days before each point" },
  { k: "unemp", b: "Unemployment", h: "Unemployed adults %", v: unempOf, agg: "average", unit: "%", color: "var(--build)", t: "Unemployed adults as a share of the village's adults (children don't count)" },
  { k: "happy", b: "Happiness", h: "Happiness", v: x => x[7], agg: "average", color: "var(--accent)", t: "The happiness score (js/happiness.js), 0 to 100" },
];
const MK = Object.fromEntries(METRICS.map(m => [m.k, m]));
const RANGES = [{ v: 1, b: "Day" }, { v: 7, b: "Week" }, { v: 30, b: "30 days" }, { v: 0, b: "All" }];
const STORE = "bf-debug-vhist";
let opt = { scope: "one", metric: "pop", metrics: ["pop"], range: 7, hide: false };
try { Object.assign(opt, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (e) { /* defaults */ }
opt.metrics = (opt.metrics || []).filter(k => MK[k]); if (!opt.metrics.length) opt.metrics = ["pop"]; if (!MK[opt.metric]) opt.metric = "pop";
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(opt)); } catch (e) {} };

let data = null, viewKey = null, loaded = [], picker = null, dirty = true, hover = null;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const stamp = t => { const d = Math.floor(t), h = (((t - d) * 24 + 6) % 24 + 24) % 24; return "Day " + (d + 1) + " " + String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.floor((h % 1) * 60)).padStart(2, "0"); };
const num = (n, m) => n == null ? "-" : (Math.abs(n) >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toString()) + (m && m.unit || "");

// ---------------------------------------------------------------- the numbers
// The sample in force at game day t (the last one taken at or before it), or null before the village was first sampled.
function at(r, t) {
  const s = r.s;
  if (!s.length || s[0][0] > t) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid][0] <= t) lo = mid; else hi = mid - 1; }
  return s[lo];
}
// Villages combined at game day t, each at its value then (carried on from its last sample while unloaded): the total, or the
// average; unemployment pools the adults of every village. null when none of them had been sampled yet.
function aggregate(keys, mk, t) {
  const m = MK[mk];
  let sum = 0, n = 0, un = 0, ad = 0;
  for (const k of keys) {
    const r = data && data.v[k], x = r && at(r, t);
    if (!x) continue;
    if (m.k === "unemp") { if (x[6] > 0 && x[5] != null) { un += x[5]; ad += x[6]; n++; } continue; }
    const v = m.v(x); if (v == null) continue;
    sum += v; n++;
  }
  if (!n) return null;
  return m.k === "unemp" ? (ad ? un / ad * 100 : null) : m.agg === "average" ? sum / n : sum;
}
// A village's line for one metric: solid pieces while loaded ([[t, v], ...] each), and dotted pieces for the time between (flat at
// the last value, then up or down to where it was next seen), up to `end` when it is unloaded now.
function series(key, mk, end) {
  const r = data && data.v[key], m = MK[mk], solid = [], dotted = [];
  if (!r) return { solid, dotted };
  const sp = r.spans || [];
  let si = 0;
  for (let i = 0; i < sp.length; i++) {
    const [a, b] = sp[i], pts = [];
    while (si < r.s.length && r.s[si][0] < a - 1e-6) si++;
    for (; si < r.s.length && r.s[si][0] <= b + 1e-6; si++) { const v = m.v(r.s[si]); if (v != null) pts.push([r.s[si][0], v]); }
    if (!pts.length) { const x = at(r, a); const v = x && m.v(x); if (v != null) pts.push([a, v]); }
    if (!pts.length) continue;
    if (pts[pts.length - 1][0] < b) pts.push([b, pts[pts.length - 1][1]]);   // it held that value until it was last seen
    solid.push(pts);
    const last = pts[pts.length - 1][1], next = sp[i + 1];
    if (next) {
      const nx = r.s.find(x => x[0] >= next[0] - 1e-6), nv = nx ? m.v(nx) : null;
      dotted.push(nv != null ? [[b, last], [next[0], last], [next[0], nv]] : [[b, last], [next[0], last]]);
    } else if (end != null && end > b) dotted.push([[b, last], [end, last]]);
  }
  return { solid, dotted };
}

// ---------------------------------------------------------------- the panel
const css = `
  #hpanel .hbar { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--edge); }
  #hpanel .seg button.on { background: rgba(127, 191, 77, 0.16); color: var(--accent2); }
  #hpanel .hm button i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; opacity: .35; }
  #hpanel .hm button.on i { opacity: 1; }
  #hpanel label.hhide { color: var(--muted); font-size: 12px; display: inline-flex; gap: 5px; align-items: center; cursor: pointer; white-space: nowrap; }
  #hpanel .hwrap { position: relative; padding: 6px 8px 4px; }
  #hpanel svg { display: block; width: 100%; height: 280px; }
  #hpanel svg text { font: 10.5px var(--mono); fill: var(--muted); }
  #hpanel svg .grid { stroke: rgba(230, 240, 225, 0.07); }
  #hpanel svg .axis { stroke: rgba(230, 240, 225, 0.18); }
  #hpanel svg .brk { stroke: rgba(230, 240, 225, 0.28); stroke-dasharray: 2 3; }
  #hpanel svg .vl { fill: none; stroke-width: 1.2; stroke-linejoin: round; opacity: .55; }
  #hpanel svg .vl.d { stroke-dasharray: 1.5 3; opacity: .45; }
  #hpanel svg .vl.sel { opacity: 1; stroke-width: 1.8; }
  #hpanel svg .agg { fill: none; stroke: var(--ink); stroke-width: 3; stroke-linejoin: round; }
  #hpanel svg .agg2 { fill: none; stroke: var(--bg); stroke-width: 6; stroke-linejoin: round; opacity: .8; }
  #hpanel svg .ml { fill: none; stroke-width: 2; stroke-linejoin: round; }
  #hpanel svg .ml.d { stroke-dasharray: 1.5 3.5; stroke-width: 1.6; }
  #hpanel svg .cross { stroke: rgba(230, 240, 225, 0.35); }
  #hpanel .htip { position: absolute; pointer-events: none; background: rgba(11, 15, 13, 0.94); border: 1px solid var(--edge2); border-radius: 6px; padding: 6px 9px; font-size: 12px; white-space: nowrap; z-index: 3; }
  #hpanel .htip .sw { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: 3px; }
  #hpanel .hnote { padding: 0 16px 12px; color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  #hpanel .hnote .sw { display: inline-block; width: 16px; height: 0; border-top: 3px solid var(--ink); margin-right: 6px; vertical-align: 3px; }
  #hpanel .hnote .sw.v { border-top: 1.5px solid var(--info); opacity: .7; } #hpanel .hnote .sw.d { border-top: 1.5px dotted var(--info); }
  #hpanel .empty { padding: 30px 16px; color: var(--faint); text-align: center; }
`;
let el = null;
function build() {
  el = document.getElementById("hpanel");
  if (!el) return false;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  el.innerHTML = `<div class="ph"><h2>History</h2><span class="sub" id="h-sub"></span></div>
    <div class="hbar">
      <div class="seg" id="h-scope"><button data-v="one" title="The village on show above, one or more metrics">This village</button><button data-v="loaded" title="Every village loaded now, a line each, plus their total or average">Loaded villages</button><button data-v="all" title="Every village this world has loaded, recorded by the game and saved with the world">All villages ever loaded</button></div>
      <div class="seg" id="h-range" title="How much game time to show">${RANGES.map(r => `<button data-v="${r.v}">${r.b}</button>`).join("")}</div>
      <label class="hhide" id="h-hidel" title="Leave out the time this village was unloaded (the joins are marked)"><input type="checkbox" id="h-hide"> Hide unloaded time</label>
    </div>
    <div class="hbar"><div class="seg hm" id="h-metric">${METRICS.map(m => `<button data-v="${m.k}"${m.t ? ` title="${esc(m.t)}"` : ""}><i style="background:${m.color}"></i>${m.b}</button>`).join("")}</div></div>
    <div class="hwrap" id="h-wrap"><svg id="h-svg"></svg><div class="htip" id="h-tip" hidden></div></div>
    <div class="hnote" id="h-note"></div>`;
  const $ = id => document.getElementById(id);
  $("h-scope").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; opt.scope = b.dataset.v; save(); render(); });
  $("h-range").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; opt.range = +b.dataset.v; save(); render(); });
  $("h-hide").addEventListener("change", e => { opt.hide = e.target.checked; save(); render(); });
  $("h-metric").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    const k = b.dataset.v;
    if (opt.scope === "one") {   // one village: each button toggles (at least one stays on)
      const i = opt.metrics.indexOf(k);
      if (i >= 0) { if (opt.metrics.length > 1) opt.metrics.splice(i, 1); } else opt.metrics.push(k);
      opt.metrics = METRICS.map(m => m.k).filter(x => opt.metrics.includes(x));
      opt.metric = k;
    } else opt.metric = k;
    save(); render();
  });
  const svg = $("h-svg");
  svg.addEventListener("mousemove", e => { const r = svg.getBoundingClientRect(); hover = { x: e.clientX - r.left, y: e.clientY - r.top }; drawHover(); });
  svg.addEventListener("mouseleave", () => { hover = null; drawHover(); });
  svg.addEventListener("click", () => { if (geo && geo.near && picker && opt.scope !== "one") picker(geo.near); });
  addEventListener("resize", () => { dirty = true; render(); });
  return true;
}

// ---------------------------------------------------------------- drawing
let geo = null;   // the last chart's layout, for the hover layer
const W = () => Math.max(320, (document.getElementById("h-svg").getBoundingClientRect().width | 0) || 640), H = 280;
function niceTicks(lo, hi, n) {
  if (!(hi > lo)) { hi = lo + 1; }
  const step0 = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(step0))), f = step0 / p, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}
// Game-day ticks between t0 and t1: whole days, or hours on short ranges.
function timeTicks(t0, t1, px) {
  const span = t1 - t0, want = Math.max(2, Math.floor(px / 90));
  const steps = [1 / 24, 2 / 24, 3 / 24, 6 / 24, 12 / 24, 1, 2, 5, 7, 10, 14, 30, 60, 100, 200, 500];
  const step = steps.find(s => span / s <= want) || steps[steps.length - 1];
  const out = [], off = 0;   // (game day 0 starts at 06:00: whole-day ticks fall on a new day)
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1 + 1e-9; t += step) out.push(t);
  return { ticks: out, step };
}
const tLabel = (t, step) => { const s = stamp(t); return step >= 1 ? s.replace(/ \d\d:\d\d$/, "") : s.replace(/^Day /, "D"); };
function scopeKeys() {
  if (!data) return [];
  if (opt.scope === "one") return viewKey && data.v[viewKey] ? [viewKey] : [];
  if (opt.scope === "loaded") return loaded.filter(k => data.v[k]);
  return Object.keys(data.v);
}
// x positions: plain game time, or (one village, hiding unloaded time) loaded time only, its spans placed end to end.
function xMap(keys, t0, t1, x0, x1) {
  if (!(opt.scope === "one" && opt.hide && keys.length === 1)) {
    const k = (x1 - x0) / Math.max(1e-6, t1 - t0);
    return { x: t => x0 + (t - t0) * k, t: x => t0 + (x - x0) / k, breaks: [], segs: [[t0, t1]] };
  }
  const r = data.v[keys[0]], segs = [];
  for (const [a, b] of r.spans) { const A = Math.max(a, t0), B = Math.min(b, t1); if (B > A) segs.push([A, B]); }
  if (!segs.length) segs.push([t0, t1]);
  const total = segs.reduce((n, s) => n + s[1] - s[0], 0) || 1, k = (x1 - x0) / total, starts = [];
  let acc = 0; for (const s of segs) { starts.push(acc); acc += s[1] - s[0]; }
  const x = t => { let i = segs.length - 1; while (i > 0 && t < segs[i][0]) i--; return x0 + (starts[i] + Math.min(Math.max(t, segs[i][0]), segs[i][1]) - segs[i][0]) * k; };
  const tAt = px => { const lt = (px - x0) / k; let i = 0; while (i < segs.length - 1 && lt > starts[i + 1]) i++; return segs[i][0] + Math.min(lt - starts[i], segs[i][1] - segs[i][0]); };
  const breaks = segs.slice(1).map((s, i) => ({ x: x0 + starts[i + 1] * k, gap: s[0] - segs[i][1] }));
  return { x, t: tAt, breaks, segs, hidden: true };
}
// Clip a polyline to [t0, t1] and drop points closer than a pixel apart.
function path(pts, X, Y, t0, t1, keepGaps) {
  let d = "", lastX = -1e9;
  for (let i = 0; i < pts.length; i++) {
    const [t, v] = pts[i];
    if (t < t0) { if (pts[i + 1] && pts[i + 1][0] > t0) { d += `M${X(t0).toFixed(1)},${Y(v).toFixed(1)}`; lastX = X(t0); } continue; }
    if (t > t1) { if (d) d += `L${X(t1).toFixed(1)},${Y(pts[i - 1] ? pts[i - 1][1] : v).toFixed(1)}`; break; }
    const x = X(t);
    if (d && x - lastX < 0.8 && i < pts.length - 1 && !keepGaps) continue;
    d += (d ? "L" : "M") + x.toFixed(1) + "," + Y(v).toFixed(1); lastX = x;
  }
  return d;
}
function render() {
  if (!el && !build()) return;
  const $ = id => document.getElementById(id);
  for (const b of $("h-scope").children) b.classList.toggle("on", b.dataset.v === opt.scope);
  for (const b of $("h-range").children) b.classList.toggle("on", +b.dataset.v === opt.range);
  const one = opt.scope === "one", on = one ? opt.metrics : [opt.metric];
  for (const b of $("h-metric").children) b.classList.toggle("on", on.includes(b.dataset.v));
  $("h-metric").title = one ? "Pick one or more metrics" : "Pick a metric";
  $("h-hidel").hidden = !one; $("h-hide").checked = opt.hide;
  const svg = $("h-svg"), note = $("h-note"), keys = scopeKeys();
  const nAll = data ? Object.keys(data.v).length : 0;
  $("h-sub").textContent = data ? `${nAll} village${nAll === 1 ? "" : "s"} recorded` + (data.name ? ` in "${data.name}"` : "") : "";
  geo = null; $("h-tip").hidden = true;
  if (!keys.length) {
    svg.innerHTML = ""; svg.style.display = "none";
    note.innerHTML = `<div class="empty" style="width:100%">${!data ? "No history yet: it starts once a saved world is open and a village loads." : one ? (viewKey ? "No history for this village yet: it is recorded while the village is loaded." : "No village on show.") : opt.scope === "loaded" ? "No village is loaded." : "No village has been loaded yet."}</div>`;
    return;
  }
  svg.style.display = "";
  const now = data.now, first = Math.min(...keys.map(k => { const r = data.v[k]; return r.spans.length ? r.spans[0][0] : r.s.length ? r.s[0][0] : now; }));
  let t1 = now, t0 = opt.range ? Math.max(first, now - opt.range) : first;
  if (t1 - t0 < 1 / 24) t0 = t1 - 1 / 24;
  const isLoaded = new Set(loaded);
  const w = W(), metrics = on.map(k => MK[k]);
  // axes: one village with several metrics gets one per metric, alternating left and right
  const AX = 46, nL = one ? Math.ceil(metrics.length / 2) : 1, nR = one ? Math.floor(metrics.length / 2) : 0;
  const x0 = 8 + nL * AX, x1 = w - 10 - nR * AX, y0 = 14, y1 = H - 26;
  const X = xMap(keys, t0, t1, x0, x1);
  let svgs = "";
  const lines = [];   // for the hover layer: {key, m, solid, dotted}
  const scales = metrics.map((m, i) => {
    let lo = Infinity, hi = -Infinity;
    const consider = v => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (const k of keys) {
      const sr = series(k, m.k, isLoaded.has(k) ? null : now);
      for (const p of sr.solid.concat(sr.dotted)) for (const q of p) if (q[0] >= t0 - 1 && q[0] <= t1) consider(q[1]);
      lines.push({ key: k, m, ...sr });
    }
    let aggPts = null;
    if (!one) {
      aggPts = [];
      const n = Math.min(400, Math.max(60, (x1 - x0) / 3 | 0));
      for (let j = 0; j <= n; j++) { const t = t0 + (t1 - t0) * j / n, v = aggregate(keys, m.k, t); if (v != null) { aggPts.push([t, v]); consider(v); } }
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    if (m.k === "unemp") { lo = 0; hi = Math.max(hi, 10); } else if (m.k === "happy") { lo = Math.min(lo, 0); hi = Math.max(hi, 100); } else lo = Math.min(lo, 0);
    const ticks = niceTicks(lo, hi, 4), a = ticks[0], b = ticks[ticks.length - 1];
    return { m, ticks, Y: v => y1 - (v - a) / ((b - a) || 1) * (y1 - y0), aggPts, side: i % 2 ? "R" : "L", slot: Math.floor(i / 2) };
  });
  // grid (from the first axis) and the time axis
  const g = scales[0];
  for (const v of g.ticks) svgs += `<line class="grid" x1="${x0}" x2="${x1}" y1="${g.Y(v).toFixed(1)}" y2="${g.Y(v).toFixed(1)}"/>`;
  svgs += `<line class="axis" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/>`;
  if (X.hidden) {
    const tk = [];
    for (const [a, b] of X.segs) { tk.push(a); if (X.x(b) - X.x(a) > 160) tk.push((a + b) / 2); }
    const step = (t1 - t0) > 3 ? 1 : 0.1;
    let lastX = -1e9;
    for (const t of tk) { const x = X.x(t); if (x - lastX < 80) continue; lastX = x; svgs += `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="${x < x0 + 30 ? "start" : "middle"}">${esc(tLabel(t, step))}</text>`; }
    for (const br of X.breaks) svgs += `<line class="brk" x1="${br.x.toFixed(1)}" x2="${br.x.toFixed(1)}" y1="${y0}" y2="${y1}"><title>unloaded for ${num(br.gap * 24)} game hours</title></line>`;
  } else {
    const { ticks, step } = timeTicks(t0, t1, x1 - x0);
    for (const t of ticks) { const x = X.x(t); svgs += `<line class="grid" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y0}" y2="${y1}"/><text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="${x > x1 - 40 ? "end" : x < x0 + 30 ? "start" : "middle"}">${esc(tLabel(t, step))}</text>`; }
  }
  // vertical axes, coloured by metric when there are several
  for (const s of scales) {
    const ax = s.side === "L" ? x0 - s.slot * AX : x1 + s.slot * AX, dir = s.side === "L" ? -1 : 1, col = one && metrics.length > 1 ? s.m.color : "var(--muted)";
    svgs += `<line class="axis" x1="${ax}" x2="${ax}" y1="${y0}" y2="${y1}" style="stroke:${col};opacity:.6"/>`;
    for (const v of s.ticks) svgs += `<text x="${ax + dir * 4}" y="${(s.Y(v) + 3.5).toFixed(1)}" text-anchor="${dir < 0 ? "end" : "start"}" style="fill:${col}">${esc(num(v, s.m))}</text>`;
  }
  // the lines
  for (const s of scales) {
    const mine = lines.filter(l => l.m === s.m);
    if (one) {
      for (const l of mine) {
        if (!X.hidden) for (const p of l.dotted) svgs += `<path class="ml d" style="stroke:${s.m.color}" d="${path(p, X.x, s.Y, t0, t1, true)}"/>`;
        for (const p of l.solid) svgs += `<path class="ml" style="stroke:${s.m.color}" d="${path(p, X.x, s.Y, t0, t1)}"/>`;
      }
    } else {
      for (const l of mine) {
        const sel = l.key === viewKey ? " sel" : "";
        for (const p of l.dotted) svgs += `<path class="vl d${sel}" style="stroke:${s.m.color}" d="${path(p, X.x, s.Y, t0, t1, true)}"/>`;
        for (const p of l.solid) svgs += `<path class="vl${sel}" style="stroke:${s.m.color}" d="${path(p, X.x, s.Y, t0, t1)}"/>`;
      }
      const d = path(s.aggPts, X.x, s.Y, t0, t1);
      svgs += `<path class="agg2" d="${d}"/><path class="agg" d="${d}"/>`;
    }
  }
  svgs += `<line class="cross" id="h-cross" x1="0" x2="0" y1="${y0}" y2="${y1}" style="display:none"/><g id="h-dots"></g>`;
  svg.setAttribute("viewBox", `0 0 ${w} ${H}`); svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = svgs;
  geo = { keys, scales, X, t0, t1, x0, x1, y0, y1, one, lines, now, isLoaded };
  // the key under the chart
  if (one) {
    const r = data.v[keys[0]];
    note.innerHTML = `<span>${esc(r.name)}</span>` + (metrics.length > 1 ? metrics.map(m => `<span><i class="sw" style="border-top-color:${m.color};width:12px;border-top-width:2px"></i>${esc(m.h)}</span>`).join("") : `<span>${esc(metrics[0].h)}</span>`) +
      (X.hidden ? `<span>unloaded time left out (dashed marks)</span>` : `<span><i class="sw d"></i>dotted: unloaded, last value</span>`);
  } else {
    const m = metrics[0], what = m.k === "unemp" ? "average over all their adults pooled" : m.agg === "average" ? "average" : "total";
    note.innerHTML = `<span><i class="sw"></i><b>${esc(m.h)}: ${what}</b> of ${keys.length} village${keys.length === 1 ? "" : "s"}</span><span><i class="sw v" style="border-top-color:${m.color}"></i>each village</span>` +
      (viewKey && keys.includes(viewKey) ? `<span><i class="sw" style="border-top:2px solid ${m.color}"></i>${esc(data.v[viewKey].name)} (on show above)</span>` : "") +
      `<span><i class="sw d" style="border-top-color:${m.color}"></i>dotted: unloaded, last value</span><span>click a line to show that village</span>`;
  }
  drawHover();
}
// Crosshair and tooltip: the game time under the mouse, the total or average and the nearest village (several villages), or every
// metric's value (one village).
function drawHover() {
  const tip = document.getElementById("h-tip"), cross = document.getElementById("h-cross"), dots = document.getElementById("h-dots");
  if (!geo || !hover || !cross || hover.x < geo.x0 || hover.x > geo.x1) { if (tip) tip.hidden = true; if (cross) cross.style.display = "none"; if (dots) dots.innerHTML = ""; if (geo) geo.near = null; return; }
  const svg = document.getElementById("h-svg"), sx = svg.getBoundingClientRect().width / (W() || 1);
  const t = geo.X.t(hover.x), x = geo.X.x(t);
  cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.style.display = "";
  let html = `<div class="sub">${esc(stamp(t))}</div>`, dh = "";
  if (geo.one) {
    const r = data.v[geo.keys[0]], s0 = at(r, t), inSpan = r.spans.some(p => t >= p[0] - 1e-6 && t <= p[1] + 1e-6);
    for (const s of geo.scales) {
      const v = s0 ? s.m.v(s0) : null;
      html += `<div><i class="sw" style="background:${s.m.color}"></i>${esc(s.m.h)} <b>${esc(num(v, s.m))}</b></div>`;
      if (v != null) dh += `<circle cx="${x}" cy="${s.Y(v).toFixed(1)}" r="3.5" style="fill:${s.m.color};stroke:var(--bg);stroke-width:2"/>`;
    }
    if (!inSpan) html += `<div class="sub">unloaded: its last value</div>`;
    geo.near = null;
  } else {
    const s = geo.scales[0], agg = aggregate(geo.keys, s.m.k, t);
    html += `<div><i class="sw" style="background:var(--ink)"></i>${s.m.k === "unemp" ? "All adults" : s.m.agg === "average" ? "Average" : "Total"} <b>${esc(num(agg, s.m))}</b></div>`;
    // the village whose line is nearest the mouse
    let best = null, bd = 14;
    for (const k of geo.keys) {
      const x0 = at(data.v[k], t), v = x0 ? s.m.v(x0) : null; if (v == null) continue;
      const dy = Math.abs(s.Y(v) - hover.y); if (dy < bd) { bd = dy; best = { k, v }; }
    }
    if (agg != null) dh += `<circle cx="${x}" cy="${s.Y(agg).toFixed(1)}" r="4" style="fill:var(--ink);stroke:var(--bg);stroke-width:2"/>`;
    if (best) {
      const r = data.v[best.k], unl = !r.spans.some(p => t >= p[0] - 1e-6 && t <= p[1] + 1e-6);
      html += `<div><i class="sw" style="background:${s.m.color}"></i>${esc(r.name)} <b>${esc(num(best.v, s.m))}</b>${unl ? ` <span class="sub">(unloaded)</span>` : ""}</div>`;
      dh += `<circle cx="${x}" cy="${s.Y(best.v).toFixed(1)}" r="3.5" style="fill:${s.m.color};stroke:var(--bg);stroke-width:2"/>`;
    }
    geo.near = best ? best.k : null;
    svg.style.cursor = best ? "pointer" : "";
  }
  dots.innerHTML = dh;
  tip.innerHTML = html; tip.hidden = false;
  const wrap = document.getElementById("h-wrap").getBoundingClientRect(), px = x * sx;
  tip.style.top = Math.max(0, hover.y - 10) + "px";
  tip.style.left = (px + 16 + tip.offsetWidth > wrap.width ? px - tip.offsetWidth - 8 : px + 16) + "px";
}

// ---------------------------------------------------------------- data in
function onEvent(o) {
  if (!o) return;
  if (o.reset) { data = o.data || null; dirty = true; return; }
  if (!data || data.wid !== o.wid) return;   // a change for a world we haven't been given yet: the reset comes first
  data.now = o.now;
  for (const k in o.v || {}) {
    const c = o.v[k], r = data.v[k] || (data.v[k] = { name: c.name, s: [], spans: [] });
    r.name = c.name || r.name;
    if (c.s) r.s = c.s.slice(); else if (c.add) r.s.push(...c.add);
    if (c.spans) r.spans = c.spans;
  }
  dirty = true;
}
let lastDraw = 0, timer = null;
function maybeRender() {
  if (!dirty) return;
  const wait = 1000 - (Date.now() - lastDraw);   // at most once a second: the chart is game hours wide
  if (wait > 0) { if (!timer) timer = setTimeout(() => { timer = null; maybeRender(); }, wait); return; }
  dirty = false; lastDraw = Date.now(); render();
}
window.BFHist = {
  attach(es, o = {}) { picker = o.pick || null; es.addEventListener("vhist", e => { try { onEvent(JSON.parse(e.data)); maybeRender(); } catch (err) { console.error(err); } }); if (!el) build(); render(); },
  snap(s, key) {
    const l = (s.villages || []).filter(v => v.loaded).map(v => v.key);
    if (key !== viewKey || l.join() !== loaded.join()) dirty = true;
    viewKey = key; loaded = l; maybeRender();
  },
  load(d) { data = d; dirty = true; render(); },   // (tests: fixed history)
  data: () => data, opt: () => opt, METRICS: METRICS.map(m => m.k), series, aggregate, render, at,
  set(o) { Object.assign(opt, o); save(); render(); },
};
})();
