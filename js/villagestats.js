// Village population history for the debug screen's village comparison table (debug/index.html): each village's
// population once per game day (the latest count seen that day), kept for the last DAYS days and saved with the world.
// Births, deaths and trades per week come from js/happiness.js (BF.happiness.week). Old saves start with no history.
// API: BF.vstats = { DAYS, sample(rec), popChange(key) -> {change, from, days}|null, serialize(), deserialize(o), reset(), update() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const DAYS = 7;                // the change is measured against the oldest count within the last DAYS game days
const pops = new Map();        // village key -> {game day: population}
const today = () => Math.floor(BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);

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

let tickT = 0, hooked = false;
function update() {
  if (!hooked && typeof BF.on === "function") { hooked = true; BF.on("newWorld", reset); }
  const t = performance.now();
  if (t - tickT < 2000 || !BF.mobs || !BF.mobs.villages) return;
  tickT = t;
  for (const rec of BF.mobs.villages.values())
    if ((rec.members || []).some(m => m.type === "villager" && !m.dead && !m.removed && m.position)) sample(rec);   // loaded villages only
}
function reset() { pops.clear(); }

BF.vstats = {
  DAYS, sample, popChange, reset, update,
  serialize() { const o = {}; for (const [k, p] of pops) if (Object.keys(p).length) o[k] = p; return o; },
  deserialize(o) {   // old saves: none
    reset();
    if (!o || typeof o !== "object") return;
    for (const k in o) if (o[k] && typeof o[k] === "object") { const p = {}; for (const d in o[k]) if (typeof o[k][d] === "number") p[d] = o[k][d]; pops.set(k, p); }
  },
};
})();
