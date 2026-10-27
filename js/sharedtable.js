// The shared table (spec r15-39b, item C5): each simulated village's public summary, published at every meeting of the cluster tick
// (js/ctick.js "start" hook, first: the villages as the interval left them, worked out at its last tick, collect, before the meeting
// changes anything; registered by js/villagesim.js init), and the one sanctioned way for a cluster to read another village. With partial copies (js/cworkers.js) each
// worker works out the rows of the villages it ran and sends them (given), since only its copies of their villagers are current.
// Between meetings everyone reads it as of the last meeting, so it reads the same in the tick order and the cluster order, and on every
// worker (each publishes it alike from the same synced state). Only with the cluster tick on; off, readers use the live records as before.
//   a row     {key, x, z, tick (the cluster tick it describes: BF.ctick.tickOf), pop (living villagers), traders (villagers a merchant can
//             deal with), trade (simulated, its centre loaded and someone to deal with: what a caravan may set out for), sum (its prices:
//             js/merchant.js summarize, {t, sells, buys}), and the columns other systems add}; readers keep the stamp (row.tick)
//   columns   column(name, rec -> plain JSON): another system's public field, worked out for every row at each publish
// Saved with the game and in the state hash (js/merchant.js exportAll "caravans".shared), only while the cluster tick is on: a game saved
// between meetings plays on from the table it had. Game log: INFO "clusters" once a game hour while the debug overlay or screen is on.
// API: BF.sharedTable = { row(key) -> row | undefined, rows() -> [rows] by key, column(name, fn), tick (the last publish's), publish(),
//                    serialize() -> {tick, rows}, restore(o), text(), reset(), rowOf(rec) -> its row now, collect(keep?) -> key -> row (the interval's
//                    end), given (set: key -> row, for the next publish) }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});
const HOUR = 1200 / 24;

let rows = new Map();          // village key -> row (the last meeting's, by key)
let tick = null;               // the tick the last publish described
const cols = [];               // [name, fn(rec)]
let hourAt = null, published = 0;
let given = null;              // key -> row: the rows other workers worked out (partial copies), used once by the next publish
let pre = null, preAt = null;  // key -> row: the rows worked out at the end of the interval (collect), for the meeting right after it

const live = o => o && o.type === "villager" && !o.dead && !o.removed;
function rowOf(rec) {
  const M = BF.merchant, VS = BF.villageSim, members = (rec.members || []).filter(live);
  const t = BF.ctick.tickOf("v:" + rec.key);
  const traders = M ? M.traders(rec, null).length : 0;
  const row = { key: rec.key, x: rec.x, z: rec.z, tick: t !== undefined ? t : BF.rand.tick, pop: members.length, traders,
    trade: !!(rec.wg && VS && VS.isActive(rec.key) && BF.world.isLoaded(rec.x, rec.z) && traders), sum: M && traders ? M.summarize(rec) : null };
  for (const [name, fn] of cols) {
    try { row[name] = fn(rec); }
    catch (e) { row[name] = null; if (BF.glog) BF.glog.log("ERROR", "clusters", "Shared table column " + name + " failed for the village at " + rec.key + ": " + (e && e.message || e)); }
  }
  return row;
}
// collect(keep?): the rows of the villages (keep(key) true: those this worker ran, partial copies), worked out at the interval's last tick
// before the workers swap (js/ctick.js), so every worker and one worker alike work them out at the same point (summarize fills caches
// on the villagers it reads, js/shepherd.js penOf); the meeting's publish takes them
function collect(keep) {
  pre = new Map(); preAt = BF.rand.tick;
  if (BF.mobs && BF.mobs.villages) for (const k of [...BF.mobs.villages.keys()].sort()) if (!keep || keep(k)) pre.set(k, rowOf(BF.mobs.villages.get(k)));
  return pre;
}
function publish() {
  const next = new Map(), mine = preAt === BF.rand.tick ? pre : null;
  if (BF.mobs && BF.mobs.villages) for (const k of [...BF.mobs.villages.keys()].sort()) next.set(k, given && given.has(k) ? given.get(k) : mine && mine.has(k) ? mine.get(k) : rowOf(BF.mobs.villages.get(k)));
  rows = next; given = null; pre = null;
  tick = BF.rand.tick;
  published++;
  hourly();
}
function hourly() {
  const now = BF.simNow ? BF.simNow() : 0;
  if (hourAt == null || now < hourAt) { hourAt = now; published = 0; return; }
  if (now - hourAt < HOUR) return;
  hourAt = now;
  const on = BF.debugOn || (BF.debugFeed && BF.debugFeed.live && BF.debugFeed.live());
  if (on && BF.glog) BF.glog.log("INFO", "clusters", "Shared table: " + published + " publishes in the last game hour, " + rows.size + " villages (" +
    [...rows.values()].map(r => r.key + " " + r.pop + (r.trade ? " trading" : "")).join(", ") + ")");
  published = 0;
}
function column(name, fn) {
  if (typeof name !== "string" || typeof fn !== "function") throw new Error("BF.sharedTable.column(name, rec => plain JSON)");
  const i = cols.findIndex(c => c[0] === name);
  if (i >= 0) cols[i] = [name, fn]; else cols.push([name, fn]);
}
function serialize() { return { tick, rows: [...rows.values()] }; }
function restore(o) {
  rows = new Map(); tick = null;
  if (!o || !Array.isArray(o.rows)) return;
  for (const r of o.rows) if (r && typeof r.key === "string") rows.set(r.key, r);
  tick = Number.isFinite(+o.tick) ? +o.tick : null;
}
const text = () => "Shared table" + (tick == null ? ": none yet" : " at tick " + tick + ": " + rows.size + " villages, " + [...rows.values()].filter(r => r.trade).length + " trading");
function reset() { rows = new Map(); tick = null; hourAt = null; published = 0; given = null; pre = null; }

BF.sharedTable = {
  row: key => rows.get(key), rows: () => [...rows.values()], column, collect, publish, serialize, restore, text, reset, rowOf,
  set given(m) { given = m; },
  get tick() { return tick; },
};
if (BF.on) BF.on("newWorld", reset);
})();
