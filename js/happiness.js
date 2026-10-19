// Village happiness: a score out of 100 per village, shown on the debug screen (debug/index.html).
// The score is BASE plus, for every term in TERMS, its count times its weight, clamped to 0..MAX. To change the
// formula, edit TERMS: change a weight, delete a line, or add a line with a count(v) built from the village facts
// below. Weekly terms count events from the last WINDOW game days; the rest count the village's loaded villagers now.
// Village facts handed to count(v):
//   v.week(kind)  events of that kind in the last WINDOW days: "death", "trade", "birth", "grown" (a child became an adult)
//   v.villagers   live loaded villagers (children included); v.adults the ones that are not children
//   v.emeralds(m) emeralds villager m carries plus those in the chests it owns
// API: BF.happiness = { TERMS, BASE, MAX, WINDOW, note(key, kind), score(rec) -> {score, raw, terms}, last(key), week(key, kind),
//                       serialize(), deserialize(o), reset(), hook() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const BASE = 100, MAX = 100;   // score = BASE + sum(count * weight), clamped to 0..MAX
const WINDOW = 7;              // game days counted by "last week" terms

const TERMS = [
  { id: "killed",     label: "villagers killed this week",        weight: -10, count: v => v.week("death") },
  { id: "starving",   label: "starving now",                      weight: -5,  count: v => v.villagers.filter(m => m.starving).length },
  { id: "trades",     label: "trades this week",                  weight: +1,  count: v => v.week("trade") },
  { id: "born",       label: "born this week",                    weight: +5,  count: v => v.week("birth") },
  { id: "grown",      label: "children grown up this week",       weight: +5,  count: v => v.week("grown") },
  { id: "unemployed", label: "unemployed",                        weight: -3,  count: v => v.adults.filter(m => m.profession === "unemployed").length },
  { id: "broke",      label: "with no emeralds",                  weight: -3,  count: v => v.adults.filter(m => v.emeralds(m) === 0).length },
  { id: "treats",     label: "ate a treat in the last 3 days",    weight: +1,  count: v => (BF.baker ? v.villagers.filter(m => BF.baker.treatCounts(m)).length : 0) },   // a cake slice or a pumpkin pie (js/baker.js)
];

const events = new Map();   // village key -> {kind: [game day, ...]} (only the last WINDOW days are kept)
const lastScore = new Map();   // village key -> the latest score(), kept for villages that have since unloaded
let hooked = false;

const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);

function note(key, kind) {
  if (!key) return;
  let e = events.get(key);
  if (!e) events.set(key, e = {});
  (e[kind] || (e[kind] = [])).push(+dayNow().toFixed(4));
}
function prune(key) {
  const e = events.get(key), cut = dayNow() - WINDOW;
  if (!e) return;
  for (const k in e) { const a = e[k]; let i = 0; while (i < a.length && a[i] < cut) i++; if (i) a.splice(0, i); }
}

function emeraldsOf(chestsOf) {
  const em = BF.I && BF.I.emerald;
  const inSlots = a => (a || []).reduce((n, st) => n + (st && st.id === em ? st.count : 0), 0);
  return m => {
    const cs = chestsOf.get(BF.storage && BF.storage.keyOf ? BF.storage.keyOf(m) : null) || [];
    return inSlots(m.inv) + cs.reduce((n, c) => n + inSlots(c.slots), 0);
  };
}

// The score of a loaded village from its live villagers and its last WINDOW days of events.
function score(rec) {
  hook();
  prune(rec.key);
  const e = events.get(rec.key) || {}, cut = dayNow() - WINDOW;
  const villagers = (rec.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed);
  const chestsOf = new Map();   // owner key -> chests
  if (BF.inventory && BF.inventory.chests) for (const c of BF.inventory.chests.values()) if (c.owner) { const l = chestsOf.get(c.owner) || []; l.push(c); chestsOf.set(c.owner, l); }
  const v = {
    week: kind => (e[kind] || []).filter(t => t >= cut).length,
    villagers, adults: villagers.filter(m => !m.child), emeralds: emeraldsOf(chestsOf),
  };
  let raw = BASE;
  const terms = TERMS.map(t => { const n = t.count(v), p = n * t.weight; raw += p; return { id: t.id, label: t.label, weight: t.weight, count: n, points: p }; });
  const out = { score: Math.max(0, Math.min(MAX, Math.round(raw))), raw: Math.round(raw), max: MAX, terms, day: +dayNow().toFixed(4) };
  lastScore.set(rec.key, out);
  return out;
}

function reset() { events.clear(); lastScore.clear(); }
function hook() {
  if (hooked || typeof BF.on !== "function") return;
  hooked = true;
  BF.on("newWorld", reset);
  BF.on("villagerGrewUp", m => { if (m && m.village) note(m.village.key, "grown"); });
}

BF.happiness = {
  TERMS, BASE, MAX, WINDOW, note, score, reset, hook,
  last: key => lastScore.get(key) || null,
  week(key, kind) { const a = (events.get(key) || {})[kind] || [], cut = dayNow() - WINDOW; return a.filter(t => t >= cut).length; },   // events of a kind in the last WINDOW days (the comparison table)
  serialize() {
    const o = {};
    for (const key of events.keys()) prune(key);
    for (const [k, e] of events) if (Object.values(e).some(a => a.length)) o[k] = e;
    return { events: o, last: Object.fromEntries(lastScore) };
  },
  deserialize(o) {
    reset();
    if (!o || typeof o !== "object") return;
    if (o.fromLog) {   // a save from before happiness: rebuild last week's events from the village logs
      for (const k in o.fromLog) for (const en of Array.isArray(o.fromLog[k]) ? o.fromLog[k] : []) if (Array.isArray(en) && typeof en[0] === "number") {
        let e = events.get(k);
        if (!e) events.set(k, e = {});
        (e[en[1]] || (e[en[1]] = [])).push(en[0]);
      }
      for (const k of events.keys()) prune(k);
      return;
    }
    for (const k in o.events || {}) {
      const e = {}, src = o.events[k];
      for (const kind in src) if (Array.isArray(src[kind])) e[kind] = src[kind].filter(t => typeof t === "number");
      events.set(k, e);
    }
    for (const k in o.last || {}) if (o.last[k] && typeof o.last[k].score === "number") lastScore.set(k, o.last[k]);
  },
};
})();
