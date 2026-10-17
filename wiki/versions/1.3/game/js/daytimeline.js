// A villager's day timeline, for the debug screen's villager panel (debug/index.html "Day").
// Once a game minute every loaded villager's status line (js/villagerstatus.js, the text its trade screen shows) is read; when
// the text changes the current stretch closes and a new one opens. Stretches are sorted into categories by their text (CATS
// below, the one place to sort new status lines), so no job module needs to know about this. Point events sit on the same
// timeline: trades, beds placed and job changes (from the village log calls, js/villagelog.js) and meals (BF.food.onEat, js/villagelife.js).
// Times are game days (BF.sky.day + time), so fast-forwarded days look like normal ones. Gaps while a villager is unloaded are
// left empty and drawn as "Not loaded". Each villager keeps today and yesterday (at most MAX_S stretches, MAX_E events), saved
// with the world ("days", js/save.js); dropped when it dies. The clock going backwards (/time set) starts a fresh timeline.
//   stretch: [t0, t1, text, cat, x, z]      event: [t, kind ("trade" | "bed" | "job" | "meal"), text, x, z]
// Display only: nothing here changes behaviour.
// API: BF.dayTimeline = { CATS, catOf(text), keyOf(m), sample(m, now?), event(m, kind, text, where?), drop(m), get(key), view(key),
//                         version(key), pick(key, pv), picked, pv, update(), serialize(), deserialize(o), reset() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const MIN = 1 / 1440;    // a game minute, in days
const EVERY = MIN;       // sampling interval
const SHORT = 1.5 * MIN; // a stretch seen at only one sample (under about a game minute and a half) merges into the one before
const GAP = 5 * MIN;     // no sample for this long: the villager was unloaded
const MAX_S = 400, MAX_E = 200;

// Status text -> category, first match wins. Anything unmatched is Idle.
const CATS = [
  ["sleep", /^(sleeping|camping)/],
  ["wait", /^(waiting|looking for|has no|can't|cannot|needs|out of|running from|hungry|starving|too hungry|inventory full|no room)|\bwaiting for\b/],
  ["trade", /^(buying|selling|fetching things|putting things away|fetching:|delivering|taking \w[\w ]* to a builder)/],
  ["walk", /^(walking|heading|going|strolling|wandering|carrying goods|leading|climbing out|fetching a loose)/],
  ["work", /^(working|harvesting|felling|mining|smelting|building|making|baking|bottling|cooking|collecting|culling|digging|edging|feeding|filling|gathering|levelling|milking|moving a bed|planting|planning|quarrying|shearing|sifting|spinning|taming|tending|tilling|watering|taking \w[\w ]* to a furnace|putting a (furnace|horse)|fetching water|sawing|chopping|crafting|smithing|fletching|repairing|catching|cutting|shaping|clearing|replanting|laying|placing|mapping|exploring|surveying|drawing)/],
  ["idle", /^(relaxing|loafing|winding|resting|in love|admiring)/],
];
const catOf = text => { const s = String(text || "").toLowerCase(); for (const [c, re] of CATS) if (re.test(s)) return c; return "idle"; };

const lines = new Map();   // villager key -> {s: [], e: [], v (change counter), name}
let last = -1, picked = null, pv = "0";

const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const r5 = v => Math.round(v * 1e5) / 1e5, r1 = v => Math.round(v * 10) / 10;
const keyOf = m => m && m.village && m.slot && m.slot.idx != null ? m.village.key + "#" + m.slot.idx : null;
const statusOf = m => BF.villagerStatus ? BF.villagerStatus.text(m) : m.sleeping ? "Sleeping" : "Idle";

function lineOf(key, make) {
  let L = lines.get(key);
  if (!L && make) lines.set(key, L = { s: [], e: [], v: 0 });
  return L;
}
// Keeps today and yesterday, and the caps.
function trim(L, now) {
  const from = Math.floor(now) - 1;
  let i = 0;
  while (i < L.s.length && L.s[i][1] < from) i++;
  if (i) L.s.splice(0, i);
  if (L.s.length > MAX_S) L.s.splice(0, L.s.length - MAX_S);
  i = 0;
  while (i < L.e.length && L.e[i][0] < from) i++;
  if (i) L.e.splice(0, i);
  if (L.e.length > MAX_E) L.e.splice(0, L.e.length - MAX_E);
}
// One sample of a loaded villager.
function sample(m, now = dayNow()) {
  const key = keyOf(m);
  if (!key) return;
  const L = lineOf(key, true), text = statusOf(m) || "Idle", x = r1(m.position.x), z = r1(m.position.z);
  L.name = BF.vlog ? BF.vlog.nameOf(m) : L.name;
  let p = L.s[L.s.length - 1];
  if (p && now < p[1] - 1e-6) { L.s.length = 0; L.e.length = 0; p = null; L.v++; }   // the clock went backwards: a fresh timeline
  if (p && now - p[1] > GAP) p = null;                                              // unloaded in between: leave the gap
  if (p && p[2] === text) { p[1] = r5(now); return; }
  if (p) {
    p[1] = r5(now);
    const q = L.s[L.s.length - 2];
    if (p[1] - p[0] < SHORT && q && Math.abs(q[1] - p[0]) < 1e-6) {   // a flicker: fold it into the stretch before
      L.s.pop(); q[1] = p[1];
      if (q[2] === text) { L.v++; return; }
    }
  }
  L.s.push([r5(now), r5(now), text, catOf(text), x, z]);
  L.v++;
  trim(L, now);
}
// A point event for villager m (a mob; anything else is ignored).
function event(m, kind, text, where) {
  const key = keyOf(m);
  if (!key || m.type !== "villager") return;
  const L = lineOf(key, true), p = where && where.position ? where.position : where || m.position;
  const e = [r5(dayNow()), kind, String(text || "")];
  if (Array.isArray(p)) e.push(r1(p[0]), r1(p[2])); else if (p && Number.isFinite(p.x)) e.push(r1(p.x), r1(p.z));
  L.e.push(e);
  L.v++;
  trim(L, dayNow());
}
function drop(m) { const key = keyOf(m); if (key) lines.delete(key); }

// What the debug screen draws for one villager (null when it has no timeline).
function view(key) {
  const L = lines.get(key);
  if (!L) return null;
  return { key, name: L.name || null, v: L.v, s: L.s, e: L.e };
}

const itemsText = ids => {
  const n = new Map();
  for (const id of ids || []) n.set(id, (n.get(id) || 0) + 1);
  return [...n].map(([id, c]) => (c > 1 ? c + " " : "") + (BF.itemName ? BF.itemName(id) : "Item " + id)).join(", ");
};
let hooked = false;
function hook() {
  if (hooked) return;
  if (typeof BF.on === "function") BF.on("newWorld", reset);
  if (BF.food && BF.food.onEat) BF.food.onEat((m, got, ate) => { if (ate && ate.length) event(m, "meal", "Ate " + itemsText(ate)); });
  hooked = true;
}
// Called every simulation step (js/main.js); samples every loaded villager once a game minute.
function update() {
  hook();
  const now = dayNow();
  if (now < last) last = -1;                    // the clock went backwards
  if (last >= 0 && now - last < EVERY) return;
  last = now;
  if (!BF.mobs || !BF.mobs.list) return;
  for (const m of BF.mobs.list) if (m.type === "villager" && !m.dead && !m.removed && m.position) sample(m, now);
}
function reset() { lines.clear(); last = -1; }

BF.dayTimeline = {
  CATS, catOf, keyOf, sample, event, drop, view, reset, update,
  get: key => lines.get(key) || null,
  version: key => { const L = lines.get(key); return L ? L.v : -1; },
  keys: () => [...lines.keys()],
  // the debug screen's picked villager, relayed by the debug server (js/debugfeed.js): the feed adds its timeline to snapshots
  pick(key, v) { picked = typeof key === "string" && key ? key : null; pv = String(v || "0"); },
  get picked() { return picked; },
  get pv() { return pv; },
  // Saved compactly: each villager's texts once (x), stretches as [t0, length in 1e-5 days, text index, x, z]; categories are re-sorted on load.
  serialize() {
    const o = {}, now = dayNow();
    for (const [k, L] of lines) {
      trim(L, now);
      if (!L.s.length && !L.e.length) continue;
      const x = [], ix = new Map();
      const s = L.s.map(a => { let i = ix.get(a[2]); if (i == null) { ix.set(a[2], i = x.length); x.push(a[2]); } return [a[0], Math.round((a[1] - a[0]) * 1e5), i, a[4], a[5]]; });
      o[k] = { n: L.name || null, x, s, e: L.e };
    }
    return o;
  },
  deserialize(o) {   // old saves: none, start empty
    reset();
    if (!o || typeof o !== "object") return;
    const ok = a => Array.isArray(a) && a.every(x => Array.isArray(x) && Number.isFinite(x[0]));
    for (const k in o) {
      const L = o[k];
      if (!L || !ok(L.s) || !ok(L.e) || !Array.isArray(L.x)) continue;
      const s = L.s.slice(-MAX_S).map(a => { const t = String(L.x[a[2]] || "Idle"); return [a[0], r5(a[0] + (a[1] || 0) / 1e5), t, catOf(t), a[3], a[4]]; });
      lines.set(k, { s, e: L.e.slice(-MAX_E), v: 1, name: L.n || undefined });
    }
  },
};
})();
