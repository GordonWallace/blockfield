// Village statistics over game time, saved with the world: the one place the game keeps how each village is doing.
//  - Population once per game day for the last DAYS days (the debug screen's Compare table: popChange).
//  - History (spec r15-69): every game hour while a village is loaded, a sample of its numbers, and the spans of game time it was loaded.
//    The debug screen's History panel draws it (js/debugfeed.js sends it, debug/vhist-view.js); other code reads it here (latest,
//    series). Older history thins out: hourly for the last FINE_DAYS game days, every COARSE game days before that, at most CAP samples.
//    sample: [game day, villagers, food (bread-equivalent held by its villagers and in their chests), deaths in the last 7 days,
//             trades in the last 7 days, unemployed adults, adults, happiness]
//    spans: [[from, to], ...] game days it was loaded (to moves with the clock while it stays loaded)
// Births, deaths and trades per week come from js/happiness.js (BF.happiness.week). Old saves start with no history.
// Reporting only: nothing in the simulation reads it yet, so it is not part of the state hash (js/statehash.js). Code that makes
// decisions from it (a mayor, say) must add it there first; it is sampled on the game clock in the simulation step, so it is
// deterministic.
// API: BF.vstats = { DAYS, FIELDS, sample(rec), popChange(key) -> {change, from, days}|null, history(key) -> {s, spans, gen}|null, keys(),
//   latest(key) -> {t, pop, food, deaths, trades, unemployed, adults, unemployment, happy}|null, series(key, field, from?) -> [[t, v], ...],
//   ver, serialize(), deserialize(o), reset(), update() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const DAYS = 7;                // the change is measured against the oldest count within the last DAYS game days
const STEP = 1 / 24;           // history: a sample every game hour while loaded
const FINE_DAYS = 14, COARSE = 0.25, CAP = 3000;   // hourly for 14 days, then every 6 game hours; at most CAP samples a village
const FIELDS = ["t", "pop", "food", "deaths", "trades", "unemployed", "adults", "happy"];
const pops = new Map();        // village key -> {game day: population}
const hist = new Map();        // village key -> {s: [samples], spans: [[from, to]], open, gen (bumped when old samples are thinned)}
let ver = 0;                   // bumped when the whole history is replaced (a save loaded, a new world)
const now = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const today = () => Math.floor(now());
const r1 = x => Math.round(x * 10) / 10;

// Population as the village panel counts it (js/villagelog.js tally: its villagers, loaded or not).
function sample(rec) {
  if (!rec || !rec.key || !BF.breeding) return;
  const d = today();
  let p = pops.get(rec.key);
  if (!p) pops.set(rec.key, p = {});
  p[d] = BF.breeding.villagerCount(rec);
  for (const k in p) if (+k < d - DAYS) delete p[k];
}
// {change: now - then, from: then, days: how many days back "then" is}, or null with no earlier day on record.
function popChange(key) {
  const p = pops.get(key), d = today();
  if (!p || p[d] == null) return null;
  const old = Object.keys(p).map(Number).filter(k => k < d && k >= d - DAYS).sort((a, b) => a - b)[0];
  return old == null ? null : { change: p[d] - p[old], from: p[old], days: d - old };
}

// ---------------------------------------------------------------- history
// One village's numbers now. chestsOf: owner key -> chests (built once for all villages).
function numbers(rec, t, chestsOf) {
  const F = BF.food, food = a => (F ? F.breadEq(a || []) : 0), H = BF.happiness;
  let pop = 0, adults = 0, unemployed = 0, f = 0;
  for (const m of rec.members || []) {
    if (m.type !== "villager" || m.dead || m.removed || !m.position) continue;
    pop++;
    if (!m.child) { adults++; if (m.profession === "unemployed") unemployed++; }
    f += food(m.inv);
    const k = BF.storage && BF.storage.keyOf ? BF.storage.keyOf(m) : null;
    for (const c of (k && chestsOf.get(k)) || []) f += food(c.slots);
  }
  const wk = kind => (H && H.week ? H.week(rec.key, kind) : null), hs = H && H.score ? H.score(rec) : null;
  return [+t.toFixed(4), pop, r1(f), wk("death"), wk("trade"), unemployed, adults, hs ? hs.score : null];
}
// Thin a village's older samples: every COARSE days before the last FINE_DAYS (the first sample of each span stays), then halve if over CAP.
function thin(h, t) {
  const cut = t - FINE_DAYS, s = h.s;
  if (!s.length || s[0][0] >= cut) return;
  const starts = new Set(h.spans.map(p => p[0])), out = [];
  let last = -Infinity;
  for (const x of s) {
    if (x[0] >= cut || starts.has(x[0]) || x[0] - last >= COARSE - 1e-6) { out.push(x); last = x[0]; }
  }
  while (out.length > CAP) { const half = out.length >> 1; out.splice(0, half, ...out.slice(0, half).filter((x, i) => i % 2 === 0)); }
  if (out.length !== s.length) { h.s = out; h.gen = (h.gen || 0) + 1; }
}
function record(loadedRecs) {
  const t = now(), live = new Set();
  let chestsOf = null;
  for (const rec of loadedRecs) {
    live.add(rec.key);
    let h = hist.get(rec.key);
    if (!h) hist.set(rec.key, h = { s: [], spans: [], open: false, gen: 0 });
    const lp = h.spans[h.spans.length - 1], tt = +t.toFixed(4);
    if (!h.open && lp && tt - lp[1] <= 0.005) h.open = true;   // seen again within a few game seconds (a save loaded): the same span
    if (h.open && lp) lp[1] = tt;
    else { h.spans.push([tt, tt]); h.open = true; }
    const last = h.s[h.s.length - 1], cur = h.spans[h.spans.length - 1];
    if (last && last[0] >= cur[0] && Math.floor(t / STEP) === Math.floor(last[0] / STEP)) continue;   // sampled this hour already
    if (!chestsOf) {
      chestsOf = new Map();
      if (BF.inventory && BF.inventory.chests) for (const c of BF.inventory.chests.values()) if (c.owner) { const l = chestsOf.get(c.owner) || []; l.push(c); chestsOf.set(c.owner, l); }
    }
    h.s.push(numbers(rec, t, chestsOf));
    if (h.s.length % 24 === 0) thin(h, t);
  }
  for (const [k, h] of hist) if (h.open && !live.has(k)) h.open = false;   // unloaded: its span ends where it was last seen
}
function latest(key) {
  const h = hist.get(key), x = h && h.s[h.s.length - 1];
  if (!x) return null;
  const o = {};
  FIELDS.forEach((f, i) => { o[f] = x[i]; });
  o.unemployment = x[6] > 0 ? x[5] / x[6] * 100 : null;
  return o;
}
// [[t, value], ...] of one field ("unemployment": % of adults) since game day `from`.
function series(key, field, from = -Infinity) {
  const h = hist.get(key), i = FIELDS.indexOf(field);
  if (!h || (i < 1 && field !== "unemployment")) return [];
  return h.s.filter(x => x[0] >= from).map(x => [x[0], field === "unemployment" ? (x[6] > 0 ? x[5] / x[6] * 100 : null) : x[i]]);
}

let tickT = 0, hooked = false;
function update() {
  if (!hooked && typeof BF.on === "function") { hooked = true; BF.on("newWorld", reset); }
  const t = BF.simNow();   // every 2 game seconds, from the game step (js/villagelog.js init; spec r15-16)
  if ((t - tickT < 2 && t >= tickT) || !BF.mobs || !BF.mobs.villages) return;
  tickT = t;
  const loaded = [];
  for (const rec of BF.mobs.villages.values())
    if ((rec.members || []).some(m => m.type === "villager" && !m.dead && !m.removed && m.position)) { sample(rec); loaded.push(rec); }   // loaded villages only
  record(loaded);
}
function reset() { pops.clear(); hist.clear(); tickT = 0; ver++; }

const okSample = x => Array.isArray(x) && x.length === FIELDS.length && typeof x[0] === "number" && x.every(v => v === null || typeof v === "number");
BF.vstats = {
  DAYS, FIELDS, STEP, sample, popChange, reset, update, latest, series,
  get ver() { return ver; },
  history: key => hist.get(key) || null,
  keys: () => [...hist.keys()],
  serialize() {
    const p = {}, h = {};
    for (const [k, x] of pops) if (Object.keys(x).length) p[k] = x;
    for (const [k, x] of hist) h[k] = { s: x.s, spans: x.spans };
    return { v: 2, pops: p, hist: h };
  },
  deserialize(o) {   // old saves: none; saves before r15-69: populations only ({key: {day: n}})
    reset();
    if (!o || typeof o !== "object") return;
    const p = o.v === 2 ? o.pops || {} : o;
    for (const k in p) if (p[k] && typeof p[k] === "object") { const q = {}; for (const d in p[k]) if (typeof p[k][d] === "number") q[d] = p[k][d]; pops.set(k, q); }
    if (o.v === 2 && o.hist && typeof o.hist === "object") for (const k in o.hist) {
      const x = o.hist[k];
      if (!x || !Array.isArray(x.s) || !Array.isArray(x.spans)) continue;
      hist.set(k, { s: x.s.filter(okSample), spans: x.spans.filter(q => Array.isArray(q) && q.length === 2 && q.every(v => typeof v === "number")), open: false, gen: 0 });
    }
  },
};
})();
