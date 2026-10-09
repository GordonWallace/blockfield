// One market for players and villagers (release 1.3): every trade a villager makes is an offer on its trade screen, any villager can buy
// from any other, and villagers keep what their next few moves need.
// - Reserve: what a villager keeps for itself. Everyone keeps KEEP bread-eq of food (js/villagelife.js) and the tools of its job; farmers
//   their seed, shepherds their feed, builders the materials left on the structure they are building plus the next one they have chosen
//   (BF.builder.reserve), crafters the inputs of their next 2 crafts (CRAFT_KEEP). Nothing in the reserve is sold, to villagers or the player
//   (trading.js blockReason: "Keeping for own use").
// - Spare goods: anything a villager holds above its reserve that its job's offers don't already sell gets a sell offer ("spare": 1) after
//   its job offers, at the cheapest base price any villager's table charges for it, else its VALUE plus 5%, in batches of about an emerald.
// - Needs: buy offers ("need": 1) for what it lacks right now: food when it is down to less than a day's worth (trading.js needsFood and
//   feedOffers, until then only for the unemployed), wheat for a shepherd short of feed, a tool of its job it has none of, and materials a builder is short of that its
//   own table doesn't buy. Villagers fill each other's needs by buying through sell offers; the player can fill them directly.
// Offers are rebuilt from the inventory (sync) with the daily restock pass (every 2 s) and when the trade screen opens; an offer that stays keeps
// its object, so its demand price (js/prices.js) carries on. Nothing new is saved: old saves get their offers on the first sync.
// API: BF.market = { reserve(v) -> [{ids, n}], spareOf(v, id), keeps(v, o) -> reason | null, sync(v), JOB_TOOLS, CRAFT_KEEP }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SELL_UP = 1.05, BUY_AT = 0.88;     // spare goods sell at VALUE x 1.05 when no table sells them; needs pay VALUE x 0.88 (the feed rule)
const JOB_TOOLS = { miner: [/_pickaxe$/], forester: [/(^|_)axe$/], farmer: [/_hoe$/, /^(water_)?bucket$/], shepherd: [/^shears$/], builder: [/^(water_)?bucket$/] };
const PLANKS = /(^|_)planks$/, LOGS = /_log$/;
// Inputs of the next 2 crafts, by job: [item name or pattern, count].
const CRAFT_KEEP = {
  furniture_maker: [["white_wool", 6], [PLANKS, 8], [LOGS, 2], ["cobblestone", 8]],                       // 2 beds, a chest's boards, a furnace
  toolsmith: [["iron_ingot", 6], ["raw_iron", 6], ["gold_ingot", 6], ["raw_gold", 6], ["diamond", 6], ["cobblestone", 6], [PLANKS, 6], ["stick", 4], ["coal", 4]],
  cartographer: [["iron_ingot", 8], ["gold_ingot", 2], ["paper", 16], ["compass", 2]],                       // 2 compasses, 2 maps
  miner: [["torch", 64]],                                                                                  // lights its shaft
  explorer: [["tent", 1], ["compass", 1], [/^blank_map_\d$/, 2]],                                         // the map it is filling
  farmer: [[LOGS, 8], ["wheat_item", 4]],                                                                   // a bed's edging, wheat for bread
};

const T = () => BF.trades;
const F = () => BF.food;
const em = () => BF.I.emerald;
const nameOf = id => (BF.items[id] && BF.items[id].name) || "";
const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const count = (v, id) => T().inv.count(v.inv, id);
const idsMatching = pat => { const out = []; for (const k in BF.I) if (typeof pat === "string" ? k === pat : pat.test(k)) out.push(BF.I[k]); return out; };
const patIds = new Map();
const idsOf = pat => { const k = String(pat); if (!patIds.has(k)) patIds.set(k, new Set(idsMatching(pat))); return patIds.get(k); };
const rank = id => (BF.toolWear && BF.toolWear.rank ? BF.toolWear.rank(id) : 0);

// ---------------------------------------------------------------- reserve
// [{ids: Set, n}]: of the items in ids together it keeps n.
function reserve(v) {
  const now = BF.state ? BF.state.time : 0;
  if (v._res && v._res.t === now) return v._res.list;
  const list = [];
  const add = (ids, n) => { if (n > 0 && ids.size) list.push({ ids, n }); };
  // the tools of its job: the best one it holds of each kind
  for (const re of JOB_TOOLS[v.profession] || []) {
    let best = null;
    for (const s of v.inv) if (s && re.test(nameOf(s.id)) && (best == null || rank(s.id) > rank(best))) best = s.id;
    if (best != null) add(new Set([best]), 1);
  }
  for (const [pat, n] of CRAFT_KEEP[v.profession] || []) add(idsOf(pat), n);
  if (v.profession === "farmer" && F()) for (const s of v.inv) if (s && BF.items[s.id].plants != null) add(new Set([s.id]), F().SEED_KEEP);
  if (v.profession === "shepherd" && BF.shepherd && BF.I.wheat_item != null) add(new Set([BF.I.wheat_item]), count(v, BF.I.wheat_item) + BF.shepherd.wheatWanted(v));
  if (v.profession === "builder" && BF.builder && BF.builder.reserve) { const r = BF.builder.reserve(v); for (const k in r) add(new Set([+k]), r[k]); }
  if (v.profession === "merchant" && BF.merchant) { const r = BF.merchant.reserve(v); for (const k in r) add(new Set([+k]), r[k]); }   // its tent, and its cargo on a trip
  v._res = { t: now, list };
  return list;
}
// How many of item id the villager can spare (food: also keeping KEEP bread-eq).
function spareOf(v, id) {
  if (!v || !Array.isArray(v.inv)) return 0;
  let n = count(v, id);
  for (const r of reserve(v)) {
    if (!r.ids.has(id)) continue;
    let held = 0; for (const x of r.ids) held += count(v, x);
    n = Math.min(n, held - r.n);
  }
  const f = F();
  if (f && f.isFood(id)) {
    const e = f.breadEq(id);
    n = Math.min(n, Math.floor(f.surplus(v) / e + 1e-9));
  }
  return Math.max(0, n);
}
// Why the villager won't do sell offer o (it would cut into its reserve), or null.
function keeps(v, o) {
  if (!v || !o || !o.sell || o.sell.id === em() || v.child) return null;
  if (!Array.isArray(v.inv) || count(v, o.sell.id) < o.sell.n) return null;   // out of stock says so itself
  return spareOf(v, o.sell.id) < o.sell.n ? "Keeping for own use" : null;
}

// ---------------------------------------------------------------- offers
// Emeralds per item for a spare item: the cheapest table seller's base price, else VALUE x 1.05; null when it has no value.
function sellUnit(id) {
  const c = BF.prices ? BF.prices.cheapest(id) : null;
  if (c != null) return c;
  const val = T().VALUE[nameOf(id)];
  return val ? val * SELL_UP : null;
}
// An offer of about one emerald for unit price u: [emeralds, items].
function batch(id, u) {
  if (u < 1) return [1, Math.max(1, Math.min(stackOf(id), Math.round(1 / u)))];
  return [Math.max(1, Math.min(64, Math.round(u))), 1];
}
// A lot smaller than a batch still sells for 1 emerald when it is worth at least SMALL_LOT of one (a few steaks, a half stack of cobblestone):
// whole emeralds are coarse, and stock that never fills a batch would otherwise never sell.
const SMALL_LOT = 0.5;
function spareOffers(v) {
  const sold = new Map(), out = [], seen = new Set(), e = em();   // its job's wares -> the smallest batch its job offers sell
  for (const o of v.trades) if (!o.spare && !o.need && o.sell.id !== e) sold.set(o.sell.id, Math.min(sold.get(o.sell.id) || Infinity, o.sell.n));
  for (const s of v.inv) {
    if (!s || s.id === e || seen.has(s.id)) continue;
    seen.add(s.id);
    if (v.profession === "explorer" && /^(filled_)?map/.test(nameOf(s.id))) continue;   // its maps are its job offers (js/explorer.js)
    const u = sellUnit(s.id);
    if (u == null) continue;
    let [ems, n] = batch(s.id, u);
    const sp = spareOf(v, s.id), job = sold.get(s.id);
    if (job != null) { if (sp >= job) continue; n = Math.min(n, job); }   // its job offers sell it: only a lot too small for them
    if (sp < n) { if (ems !== 1 || sp * u < SMALL_LOT) continue; n = sp; }
    out.push({ buy: [{ id: e, n: ems }], sell: { id: s.id, n }, level: 1, xp: 0, spare: 1 });
  }
  return out;
}
// The tool of a kind it would buy: the matching tool worth nearest an emerald.
function toolFor(re) {
  let best = null, bd = Infinity;
  for (const name in T().VALUE) {
    if (!re.test(name) || BF.I[name] == null) continue;
    const d = Math.abs(Math.log(T().VALUE[name]));
    if (d < bd) { bd = d; best = BF.I[name]; }
  }
  return best;
}
function needOffers(v) {
  const out = [], e = em(), V = T().VALUE, have = new Set();
  for (const o of v.trades) if (!o.need && !o.feed && o.sell.id === e) for (const b of o.buy) have.add(b.id);   // its job already buys these
  const want = id => {
    if (id == null || have.has(id)) return;
    have.add(id);
    const val = V[nameOf(id)];
    if (!val) return;
    const u = val * BUY_AT;
    const [ems, k] = u < 1 ? [1, Math.max(1, Math.min(stackOf(id), Math.ceil(1 / u)))] : [Math.max(1, Math.floor(u)), 1];
    out.push({ buy: [{ id, n: k }], sell: { id: e, n: ems }, level: 1, xp: 0, need: 1 });
  };
  for (const re of JOB_TOOLS[v.profession] || []) if (!v.inv.some(s => s && re.test(nameOf(s.id)))) want(toolFor(re));
  if (v.profession === "shepherd" && BF.shepherd && BF.shepherd.wheatWanted(v) > 0) want(BF.I.wheat_item);
  if (v.profession === "builder" && BF.builder && BF.builder.shortfall) { const s = BF.builder.shortfall(v); for (const k in s) want(+k); }
  return out;
}
// Rebuilds the villager's spare-goods, needs and food offers, keeping the objects of offers that stay (and so their prices).
function sync(v) {
  if (!v || !Array.isArray(v.trades) || !Array.isArray(v.inv) || v.type !== "villager") return v;
  const old = new Map();
  const key = o => (o.spare ? "s" : o.need ? "n" : "f") + o.buy.map(b => b.id).join("+") + ">" + o.sell.id;
  for (const o of v.trades) if (o.spare || o.need || o.feed) old.set(key(o), o);
  const job = v.trades.filter(o => !o.spare && !o.need && !o.feed);
  v.trades = job;
  if (v.child || v.dead) return v;
  const fresh = [];
  if (T().needsFood(v)) fresh.push(...T().feedOffers());
  fresh.push(...needOffers(v), ...spareOffers(v));
  const same = (p, o) => { const b = p.base || [p.buy[0].n, p.sell.n]; return b[0] === o.buy[0].n && b[1] === o.sell.n; };   // same base amounts
  for (const o of fresh) { const prev = old.get(key(o)); v.trades.push(prev && same(prev, o) ? prev : o); }
  return v;
}

BF.market = { reserve, spareOf, keeps, sync, sellUnit, JOB_TOOLS, CRAFT_KEEP };
})();
