// Village economy tallies for the debug screen's Economy view (debug/index.html): which goods moved between which professions,
// what villagers wanted and nobody sold, and what they hold for sale that isn't selling. Display only: nothing here changes behaviour.
// Kept per village and per game day (the last DAYS days), saved with the world next to the village log (js/save.js "econ").
// Every trade the village log records (BF.vlog.trade, js/villagelog.js) also lands here, by the professions the two parties had then.
//   flows:  "seller|buyer|item" -> [items, emeralds, trades]   (goods move seller -> buyer; "Player" for the player)
//   wanted: "buyer|item" -> hours a villager of that job waited for it (counted once per villager, item and game hour)
//   stuck:  once a game day, [name, profession, item, count, days unsold] for things villagers hold for sale that haven't sold in STUCK days
// An item is its id, or a label for something wanted in general ("Food", "Pickaxe"). The feed (js/debugfeed.js) sends names and groups.
// API: BF.econ = { DAYS, trade(buyer, seller, what, times), want(m, item), days(key) -> {day: {...}}, version(key), view(key) -> feed data,
//                  group(item), scan(rec), serialize(), deserialize(o), reset(), update() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const DAYS = 7;          // game days kept per village
const STUCK = 2;         // days unsold before an item held for sale counts as stuck
const CATCH_UP = 6;      // a wait seen again within this many game hours counts the hours between (villagers re-check every hour or two)

const tallies = new Map();   // village key -> Map(day -> {f: {}, w: {}, s: []})
const vers = new Map();      // village key -> change counter, so the feed only re-sends a village when it changed
const held = new Map();      // villager key -> {item id: game day it last sold (or was first seen held)}
const lastWant = new Map();  // "villager key|item" -> game hour it was last counted
const scanned = new Map();   // village key -> game day of its last stuck scan

const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const today = () => Math.floor(dayNow());
const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
const profOf = m => m === "player" ? "Player" : m && m.child ? "Child" : pretty((m && m.profession) || "unknown");
const vkey = m => m && m.village && m.slot && m.slot.idx != null ? m.village.key + "#" + m.slot.idx : null;
const em = () => BF.I && BF.I.emerald;

function bump(key) { vers.set(key, (vers.get(key) || 0) + 1); }
function dayOf(key, d) {
  let t = tallies.get(key);
  if (!t) tallies.set(key, t = new Map());
  let e = t.get(d);
  if (!e) {
    t.set(d, e = { f: {}, w: {}, s: [] });
    for (const k of [...t.keys()]) if (k <= d - DAYS) t.delete(k);   // keep the last DAYS game days
  }
  return e;
}

// ---------------------------------------------------------------- trades
// Item names back to ids, for trades the village log was given as text ("gave 3 Emerald, got 24 Wheat").
let byName = null;
function idOfName(name) {
  if (!byName) {
    byName = new Map();
    for (const id in BF.items || {}) {   // "Wheat" is both the crop block and wheat_item: the _item one is what changes hands
      const n = BF.itemName(+id);
      if (!byName.has(n) || /_item$/.test(BF.items[id].name)) byName.set(n, +id);
    }
  }
  return byName.has(name) ? byName.get(name) : name;
}
const parseStacks = s => s.split(" + ").map(x => /^(\d+) (.+)$/.exec(x.trim())).filter(Boolean).map(r => ({ id: idOfName(r[2]), n: +r[1] }));
// -> {gave: [{id, n}], got: [{id, n}]} from the buyer's side, totals for the whole deal; null when the text can't be read
function sides(what, times) {
  if (what && typeof what === "object" && what.sell) {
    const k = times || 1;
    return { gave: what.buy.map(b => ({ id: b.id, n: b.n * k })), got: [{ id: what.sell.id, n: what.sell.n * k }] };
  }
  const r = /gave (.+?), got (.+)$/.exec(String(what || ""));
  return r ? { gave: parseStacks(r[1]), got: parseStacks(r[2]) } : null;
}
// buyer / seller as for BF.vlog.trade: villager mobs, or buyer === "player". Goods the seller hands over flow seller -> buyer, goods the
// buyer hands over (a villager buying from the player, emeralds for wheat) flow buyer -> seller; the emeralds paid go with them.
function trade(buyer, seller, what, times) {
  const rec = (seller && seller.village) || (buyer && buyer.village);
  if (!rec || !rec.key) return;
  const s = sides(what, times);
  if (!s) return;
  const E = em(), isEm = x => x.id === E, n = times || 1;
  const B = profOf(buyer), S = profOf(seller), e = dayOf(rec.key, today());
  const move = (from, to, goods, paid) => {
    const total = goods.reduce((a, g) => a + g.n, 0);
    for (const g of goods) {
      const k = from + "|" + to + "|" + g.id, f = e.f[k] || (e.f[k] = [0, 0, 0]);
      f[0] += g.n; f[1] += total ? paid * g.n / total : 0; f[2] += n;
    }
  };
  const emGave = s.gave.filter(isEm).reduce((a, g) => a + g.n, 0), emGot = s.got.filter(isEm).reduce((a, g) => a + g.n, 0);
  move(S, B, s.got.filter(g => !isEm(g)), emGave);
  move(B, S, s.gave.filter(g => !isEm(g)), emGot);
  for (const [m, items] of [[seller, s.got], [buyer, s.gave]]) {   // whoever handed goods over sold them: their unsold clock restarts
    const k = m !== "player" && vkey(m);
    if (!k) continue;
    const h = held.get(k);
    if (h) for (const g of items) if (h[g.id] != null) h[g.id] = dayNow();
  }
  bump(rec.key);
}

// ---------------------------------------------------------------- wanted
// A villager tried to buy item and nobody in its village sells it or has it in stock. Counted once per villager, item and game hour.
function want(m, item) {
  const rec = m && m.village;
  if (!rec || !rec.key || item == null) return;
  const hour = Math.floor(dayNow() * 24), k = (vkey(m) || BF.vlog.nameOf(m)) + "|" + item, last = lastWant.get(k);
  if (last === hour) return;
  lastWant.set(k, hour);
  const hrs = last != null && hour > last && hour - last <= CATCH_UP ? hour - last : 1;
  const e = dayOf(rec.key, today()), w = profOf(m) + "|" + item;
  e.w[w] = (e.w[w] || 0) + hrs;
  bump(rec.key);
}

// ---------------------------------------------------------------- stuck
// What a villager holds for sale: items its own offers sell, in its pack, not food and not a tool it works with itself.
const SELLS_TOOLS = new Set(["toolsmith", "weaponsmith", "armorer"]);
const isTool = id => { const it = BF.items[id]; return !!(it && it.tool && typeof it.tool === "object"); };   // a block's tool is the one that mines it (a string)
function forSale(m) {
  const E = em(), out = new Map(), F = BF.food;
  for (const o of m.trades || []) {
    const id = o.sell && o.sell.id;
    if (id == null || id === E || out.has(id)) continue;
    if (F && F.isFood && F.isFood(id)) continue;
    const it = BF.items[id];
    if (isTool(id) && !SELLS_TOOLS.has(m.profession)) continue;
    const n = (m.inv || []).reduce((a, s) => a + (s && s.id === id ? s.count : 0), 0);
    if (n > 0) out.set(id, n);
  }
  return out;
}
// Once a game day per village: note every loaded villager's items held for sale that haven't sold in STUCK days.
function scan(rec) {
  const d = today(), now = dayNow(), list = [];
  for (const m of rec.members || []) {
    if (m.type !== "villager" || m.dead || m.removed || !m.position || !Array.isArray(m.inv)) continue;
    const k = vkey(m);
    if (!k) continue;
    const h = held.get(k) || {}, have = forSale(m), next = {};
    for (const [id, n] of have) {
      next[id] = h[id] != null ? h[id] : now;
      const age = now - next[id];
      if (age >= STUCK) list.push([BF.vlog.nameOf(m), profOf(m), id, n, Math.floor(age)]);
    }
    held.set(k, next);
  }
  dayOf(rec.key, d).s = list.sort((a, b) => b[4] - a[4] || b[3] - a[3]);
  scanned.set(rec.key, d);
  bump(rec.key);
}
let tickT = 0;
function update() {
  const t = performance.now();
  if (t - tickT < 1000 || !BF.mobs || !BF.mobs.villages) return;
  tickT = t;
  const d = today();
  for (const rec of BF.mobs.villages.values()) {
    if (scanned.get(rec.key) === d) continue;
    if (!(rec.members || []).some(m => m.type === "villager" && !m.dead && !m.removed && m.position)) continue;   // not loaded
    scan(rec);
  }
}

// ---------------------------------------------------------------- groups (band colours) and the feed's view
function group(item) {
  if (typeof item === "string") {
    if (/^(food|wheat|bread)/i.test(item)) return "food";
    if (/axe|hoe|shears|bucket|sword|shovel/i.test(item)) return "tools";
    if (/gold|iron|diamond|ingot|ore|coal/i.test(item)) return "ore";
    if (/cobble|stone/i.test(item)) return "stone";
    if (/wool|bed/i.test(item)) return "wool";
    if (/log|plank|stick|wood/i.test(item)) return "wood";
    return "other";
  }
  const it = BF.items[item], n = it ? it.name : "";
  if (isTool(item) || /shears|bucket|fishing_rod|flint_and_steel/.test(n)) return "tools";
  if (BF.food && BF.food.isFood && BF.food.isFood(item) || /wheat|seeds|sugar|cocoa/.test(n)) return "food";
  if (/wool|_bed$|^bed/.test(n)) return "wool";
  if (/_log$|_wood$|planks|stick|sapling|^log/.test(n)) return "wood";
  if (/_ore$|ingot|^raw_|diamond|coal|nugget|lapis|redstone|emerald/.test(n)) return "ore";
  if (/cobble|stone|andesite|diorite|granite|deepslate|gravel|^sand/.test(n)) return "stone";
  return "other";
}
const nameOfItem = item => typeof item === "string" && isNaN(+item) ? item : BF.itemName(+item).replace(/ Item$/, "");
const groupOf = item => group(typeof item === "string" && !isNaN(+item) ? +item : item);
// The feed's form: {today, days: {day: {f: [[seller, buyer, item name, group, items, emeralds, trades]], w: [[buyer, item, hours]],
// s: [[villager, job, item, count, days]]}}}
function view(key) {
  const t = tallies.get(key), out = { today: today(), days: {} };
  if (!t) return out;
  for (const [d, e] of t) {
    if (d <= out.today - DAYS) continue;   // older than the window (the village hasn't traded since): dropped when its next day starts
    out.days[d] = {
      f: Object.entries(e.f).map(([k, v]) => { const [s, b, it] = k.split("|"); return [s, b, nameOfItem(it), groupOf(it), v[0], Math.round(v[1] * 100) / 100, v[2]]; }),
      w: Object.entries(e.w).map(([k, h]) => { const [b, it] = k.split("|"); return [b, nameOfItem(it), h]; }),
      s: e.s.map(r => [r[0], r[1], nameOfItem(r[2]), r[3], r[4]]),
    };
  }
  return out;
}

function reset() { tallies.clear(); vers.clear(); held.clear(); lastWant.clear(); scanned.clear(); }
let hooked = false;
function hook() { if (!hooked && typeof BF.on === "function") { hooked = true; BF.on("newWorld", reset); } }

BF.econ = {
  DAYS, STUCK, trade, want, scan, group, view, reset,
  days: key => tallies.get(key) || new Map(),
  version: key => vers.get(key) || 0,
  keys: () => [...tallies.keys()],
  serialize() {
    const v = {};
    for (const [k, t] of tallies) { const o = {}; for (const [d, e] of t) if (d > today() - DAYS) o[d] = e; v[k] = o; }
    const h = {};
    for (const [k, x] of held) if (Object.keys(x).length) h[k] = x;
    return { v, h };
  },
  deserialize(o) {   // old saves: none, start empty
    reset();
    if (!o || typeof o !== "object") return;
    for (const k in o.v || {}) {
      const t = new Map();
      for (const d in o.v[k]) { const e = o.v[k][d]; if (e && typeof e === "object") t.set(+d, { f: e.f || {}, w: e.w || {}, s: Array.isArray(e.s) ? e.s : [] }); }
      tallies.set(k, t); bump(k);
    }
    for (const k in o.h || {}) if (o.h[k] && typeof o.h[k] === "object") held.set(k, o.h[k]);
  },
  update() { hook(); update(); },
};
})();
