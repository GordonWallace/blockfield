// Villager economy: trade tables per profession, the value table they are balanced against, villager inventories
// (18 slots), starting stock, daily restock, trade rules (stock + room) and the save format. UI lives in inventory.js.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SLOTS = 18;                              // villager inventory size
const EM_CAP = 12, EM_DAY = 2;                 // emerald allowance: +2 per day up to 12
const LEVELS = ["Novice", "Apprentice", "Journeyman", "Expert", "Master"];
const LEVEL_XP = [0, 10, 70, 150, 250];        // xp needed to reach level 1..5
const TRADE_XP = [2, 5, 10, 15, 30];           // villager xp per trade, by offer level
const CAP_K = [6, 5, 4, 3, 2];                 // per-ware stock cap = sell.n * CAP_K[offer level - 1] (max 2 stacks)
const STOCK_VALUE = 6;                         // ... and at most this many emeralds worth of one ware
const BUILDER_EM_CAP = 80, BUILDER_EM_DAY = 4; // the builder's village budget: +4 emeralds per day up to 80 (see TRADE_AUDIT.md)

// Effort value of every traded item in emerald equivalents (1 emerald = 1). See TRADE_AUDIT.md for the reasoning.
const VALUE = {
  emerald: 1,
  wheat_seeds: .025, beetroot_seeds: .03, wheat_item: .07, potato: .06, carrot: .06, beetroot: .07, baked_potato: .09, bread: .24,
  apple: .15, pumpkin: .14, hay_bale: .65, sugar_cane: .04,
  stick: .02, cobblestone: .03, stone: .05, sand: .03, gravel: .03, clay_ball: .06, brick: .15, bricks: .62, glass: .08,
  sandstone: .08, sandstone_bricks: .09, mossy_cobblestone: .15, calcite: .12, terracotta: .15, orange_terracotta: .18,
  yellow_terracotta: .18, red_terracotta: .18, white_terracotta: .18, brown_terracotta: .18,
  flint: .06, coal: .12, charcoal: .1, iron_ingot: .5, gold_ingot: 1.2, diamond: 3.5,
  string: .1, feather: .07, bone: .08, rotten_flesh: .05, gunpowder: .2, arrow: .04, wool: .1, white_wool: .12, leather: .15,
  raw_porkchop: .08, raw_beef: .08, raw_mutton: .07, raw_chicken: .06, cooked_porkchop: .12, steak: .12, cooked_mutton: .1,
  cooked_chicken: .1, raw_cod: .07, cooked_cod: .1,
  paper: .05, book: .35, lantern: 2.2, bell: 6, chest: .26, red_bed: .42, bow: .42,
  iron_pickaxe: 1.58, iron_axe: 1.58, iron_shovel: .57, iron_sword: 1.07, iron_hoe: 1.07,
  diamond_pickaxe: 10.6, diamond_axe: 10.6, diamond_shovel: 3.57, diamond_sword: 7.05, diamond_hoe: 7.07,
  compass: 3.2, blank_map_1: 3.6,                                  // cartographer goods: 4 iron + 1 gold ingot; + 8 paper (js/cartography.js)
  oak_door: .07, torch: .04, oak_fence: .05,                       // builder goods (door 6 planks -> 3, torch coal + stick -> 4, fence 5 planks -> 3)
};
for (const sp of ["", "spruce_", "birch_", "jungle_", "acacia_", "dark_oak_", "mangrove_", "cherry_"]) { // building wood: log 0.12 = 4 planks at 0.03
  VALUE[sp + "planks"] = .03; VALUE[(sp || "oak_") + "log"] = .12;
}

// "<n> <item> [+ <n> <item>] > <n> <item>", five pools (levels 1..5); every offer of the pools up to the villager's
// level is offered. Rule: selling goods to a villager pays 75-92% of their value, buying wares costs 88-115%.
const TRADES = {
  farmer: [
    ["16 wheat_item > 1 emerald", "18 potato > 1 emerald", "18 carrot > 1 emerald", "1 emerald > 4 bread"],
    ["16 beetroot > 1 emerald", "8 pumpkin > 1 emerald", "1 emerald > 6 apple", "1 emerald > 10 baked_potato"],
    ["28 sugar_cane > 1 emerald", "3 emerald > 4 hay_bale", "2 hay_bale > 1 emerald"],
    ["1 emerald > 1 iron_hoe", "12 baked_potato > 1 emerald"],
    ["6 emerald + 1 iron_hoe > 1 diamond_hoe"],
  ],
  librarian: [
    ["22 paper > 1 emerald", "16 feather > 1 emerald", "1 emerald > 11 glass"],
    ["7 book > 2 emerald", "2 emerald > 5 book"],
    ["14 glass > 1 emerald", "5 emerald > 2 lantern"],
    ["1 emerald > 18 paper", "1 lantern > 2 emerald"],
    ["5 emerald > 14 book"],
  ],
  cleric: [
    ["22 rotten_flesh > 1 emerald", "14 bone > 1 emerald", "5 emerald > 2 lantern"],
    ["1 gold_ingot > 1 emerald", "6 gunpowder > 1 emerald"],
    ["3 emerald > 2 gold_ingot", "2 lantern > 4 emerald"],
    ["4 emerald > 1 diamond", "1 diamond > 3 emerald"],
    ["7 emerald > 1 bell"],
  ],
  armorer: [
    ["9 coal > 1 emerald", "1 emerald > 2 iron_ingot", "5 iron_ingot > 2 emerald"],
    ["5 emerald > 2 lantern", "1 lantern > 2 emerald"],
    ["1 diamond > 3 emerald", "4 emerald > 1 diamond"],
    ["1 gold_ingot > 1 emerald", "3 emerald > 2 gold_ingot"],
    ["8 emerald > 3 lantern", "4 emerald > 8 iron_ingot"],
  ],
  weaponsmith: [
    ["9 coal > 1 emerald", "1 emerald > 1 iron_sword", "5 iron_ingot > 2 emerald"],
    ["2 emerald > 1 iron_axe", "1 gold_ingot > 1 emerald"],
    ["1 diamond > 3 emerald", "4 emerald > 1 diamond"],
    ["7 emerald > 1 diamond_sword"],
    ["10 emerald > 1 diamond_axe", "6 emerald + 1 iron_sword > 1 diamond_sword", "1 diamond_sword > 6 emerald"],
  ],
  toolsmith: [
    ["9 coal > 1 emerald", "40 cobblestone > 1 emerald", "1 emerald > 1 iron_hoe"],
    ["2 emerald > 1 iron_pickaxe", "5 iron_ingot > 2 emerald"],
    ["2 emerald > 1 iron_axe", "1 diamond > 3 emerald", "4 emerald > 1 diamond_shovel"],
    ["7 emerald > 1 diamond_hoe"],
    ["11 emerald > 1 diamond_pickaxe", "10 emerald > 1 diamond_axe", "9 emerald + 1 iron_pickaxe > 1 diamond_pickaxe"],
  ],
  butcher: [
    ["18 raw_chicken > 1 emerald", "14 raw_porkchop > 1 emerald", "1 emerald > 9 cooked_chicken"],
    ["14 raw_beef > 1 emerald", "9 coal > 1 emerald", "1 emerald > 8 cooked_porkchop"],
    ["16 raw_mutton > 1 emerald", "1 emerald > 8 steak"],
    ["1 emerald > 9 cooked_mutton", "8 leather > 1 emerald"],
    ["2 emerald > 18 steak"],
  ],
  fisherman: [
    ["11 string > 1 emerald", "9 coal > 1 emerald", "1 emerald > 12 raw_cod"],
    ["1 emerald > 9 cooked_cod", "56 stick > 1 emerald"],
    ["5 emerald > 2 lantern", "16 feather > 1 emerald"],
    ["2 emerald > 18 cooked_cod"],
    ["2 emerald > 24 raw_cod"],
  ],
  shepherd: [
    ["11 wool > 1 emerald", "1 emerald > 8 white_wool", "11 string > 1 emerald"],
    ["10 white_wool > 1 emerald", "1 emerald > 2 red_bed"],
    ["1 emerald > 9 wool", "16 raw_mutton > 1 emerald"],
    ["3 emerald > 4 hay_bale"],
    ["2 emerald > 16 white_wool"],
  ],
  fletcher: [
    ["54 stick > 1 emerald", "1 emerald > 22 arrow", "18 flint > 1 emerald"],
    ["16 feather > 1 emerald", "11 string > 1 emerald"],
    ["1 emerald > 15 flint", "1 emerald > 13 feather"],
    ["1 emerald > 9 string", "2 emerald > 44 arrow"],
    ["3 emerald > 64 arrow"],
  ],
  mason: [
    ["18 clay_ball > 1 emerald", "1 emerald > 6 brick", "40 cobblestone > 1 emerald"],
    ["22 stone > 1 emerald", "1 emerald > 6 mossy_cobblestone", "1 emerald > 6 terracotta", "3 emerald > 4 bricks"],
    ["14 sandstone > 1 emerald", "9 calcite > 1 emerald", "1 emerald > 11 sandstone_bricks"],
    ["1 emerald > 5 orange_terracotta", "1 emerald > 5 yellow_terracotta", "1 emerald > 5 red_terracotta"],
    ["1 emerald > 5 white_terracotta", "1 emerald > 5 brown_terracotta", "1 emerald > 8 calcite"],
  ],
  leatherworker: [
    ["8 leather > 1 emerald", "14 raw_beef > 1 emerald", "18 flint > 1 emerald"],
    ["1 emerald > 6 leather", "11 string > 1 emerald"],
    ["2 emerald > 5 book", "22 rotten_flesh > 1 emerald"],
    ["2 emerald > 12 leather"],
    ["3 emerald > 18 leather"],
  ],
  cartographer: [
    ["22 paper > 1 emerald", "1 emerald > 11 glass", "28 sugar_cane > 1 emerald", "5 iron_ingot > 2 emerald"],
    ["14 glass > 1 emerald", "1 emerald > 18 paper", "1 gold_ingot > 1 emerald"],
    ["5 emerald > 2 lantern", "1 lantern > 2 emerald", "3 emerald > 1 compass", "2 compass > 5 emerald"],
    ["2 emerald > 22 glass", "2 emerald > 36 paper", "4 emerald > 1 blank_map_1"],
    ["7 emerald > 3 lantern"],
  ],
  // The builder BUYS building materials from the player (rho 0.79-0.83 against VALUE) and sells a few finished goods it may hold.
  // Every unit price paid stays below the cheapest price any villager charges for the same item (glass, bricks, beds, sandstone_bricks, terracotta).
  builder: [
    ["40 cobblestone > 1 emerald", "40 planks > 1 emerald", "10 oak_log > 1 emerald", "40 spruce_planks > 1 emerald", "10 spruce_log > 1 emerald"],
    ["40 birch_planks > 1 emerald", "10 birch_log > 1 emerald", "40 acacia_planks > 1 emerald", "10 acacia_log > 1 emerald", "14 glass > 1 emerald"],
    ["40 jungle_planks > 1 emerald", "10 jungle_log > 1 emerald", "40 dark_oak_planks > 1 emerald", "10 dark_oak_log > 1 emerald", "22 stone > 1 emerald", "16 oak_door > 1 emerald"],
    ["40 mangrove_planks > 1 emerald", "10 mangrove_log > 1 emerald", "40 cherry_planks > 1 emerald", "10 cherry_log > 1 emerald", "4 bricks > 2 emerald", "3 red_bed > 1 emerald"],
    ["14 sandstone > 1 emerald", "14 sandstone_bricks > 1 emerald", "7 orange_terracotta > 1 emerald", "28 torch > 1 emerald", "1 emerald > 14 oak_door", "1 emerald > 24 torch"],
  ],
  nitwit: [[], [], [], [], []],
  unemployed: [[], [], [], [], []],   // no jobsite yet (js/jobs.js): no offers
  explorer: [[], [], [], [], []],     // no fixed offers: it sells the maps it has filled, built on the fly (js/explorer.js syncOffers)
};

// Wares a profession can plausibly make itself; only these are topped up by the daily restock.
const PRODUCE = {
  farmer: [],          // food is never created by the restock: farmers harvest and bake it (js/villagelife.js), see TRADE_AUDIT.md
  librarian: ["paper", "book", "glass"],
  cleric: [],
  armorer: ["iron_ingot"],
  weaponsmith: ["iron_sword", "iron_axe"],
  toolsmith: ["iron_hoe", "iron_pickaxe", "iron_axe"],
  butcher: [],         // cooks raw meat it holds instead (js/villagelife.js)
  fisherman: [],       // cooks raw cod it holds instead (js/villagelife.js)
  shepherd: ["wool", "white_wool", "red_bed", "hay_bale"],
  fletcher: ["arrow"],
  mason: ["brick", "bricks", "stone", "terracotta", "orange_terracotta", "yellow_terracotta", "red_terracotta",
    "white_terracotta", "brown_terracotta", "sandstone_bricks"],
  leatherworker: ["leather"],
  cartographer: ["paper", "glass"],
  nitwit: [],
  unemployed: [],
  builder: [],
  explorer: [],
};

const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));

// ---------------------------------------------------------------- inventory helpers (array of {id,count}|null)
const inv = {
  create: () => new Array(SLOTS).fill(null),
  count(a, id) { let n = 0; for (const s of a) if (s && s.id === id) n += s.count; return n; },
  // Adds into existing stacks first, then empty slots. Returns the leftover that did not fit.
  add(a, id, n) {
    const max = stackOf(id);
    for (let i = 0; i < a.length && n > 0; i++) {
      const s = a[i];
      if (s && s.id === id && s.count < max) { const m = Math.min(n, max - s.count); s.count += m; n -= m; }
    }
    for (let i = 0; i < a.length && n > 0; i++) if (!a[i]) { const m = Math.min(n, max); a[i] = { id, count: m }; n -= m; }
    return n;
  },
  // Removes up to n (from the last slots first). Returns how many were removed.
  remove(a, id, n) {
    let got = 0;
    for (let i = a.length - 1; i >= 0 && got < n; i--) {
      const s = a[i];
      if (!s || s.id !== id) continue;
      const m = Math.min(n - got, s.count); s.count -= m; got += m;
      if (s.count <= 0) a[i] = null;
    }
    return got;
  },
  // Could `adds` ([{id,n}]) be stored once `removes` ([{id,n}]) have been taken out?
  canFit(a, adds, removes) {
    const sim = a.map(s => s && { id: s.id, count: s.count });
    for (const r of removes || []) inv.remove(sim, r.id, r.n);
    for (const x of adds) if (inv.add(sim, x.id, x.n) > 0) return false;
    return true;
  },
  clone: a => a.map(s => s && { id: s.id, count: s.count }),
};

// ---------------------------------------------------------------- tables
function parseTrade(str) {
  const [l, r] = str.split(">");
  const part = p => { const [n, name] = p.trim().split(/\s+/); return { id: BF.I[name], n: +n }; };
  const buy = l.split("+").map(part), sell = part(r);
  if (buy.some(b => b.id === undefined) || sell.id === undefined) return null;
  return { buy, sell };
}
const parsed = {};
function table(prof) { // five arrays of {buy, sell}
  if (!TRADES[prof]) prof = "farmer";
  return parsed[prof] || (parsed[prof] = TRADES[prof].map(pool => pool.map(parseTrade).filter(Boolean)));
}
function genOffers(prof, level) {
  return (table(prof)[level - 1] || []).map(o => ({
    buy: o.buy.map(b => ({ id: b.id, n: b.n })), sell: { id: o.sell.id, n: o.sell.n }, level, xp: TRADE_XP[level - 1],
  }));
}
function buildTrades(prof, level) {
  const out = [];
  for (let l = 1; l <= level; l++) out.push(...genOffers(prof, l));
  return out;
}
// Per-ware stock cap {id -> n} and wanted goods {id -> n per trade}, over all five levels.
function profile(prof) {
  const caps = new Map(), wants = new Map(), em = BF.I.emerald;
  table(prof).forEach((pool, li) => pool.forEach(o => {
    if (o.sell.id !== em) {
      const id = o.sell.id, worth = VALUE[BF.items[id].name] || 1;
      let c = Math.min(o.sell.n * CAP_K[li], stackOf(id) * 2);
      if (stackOf(id) === 1) c = Math.min(c, li >= 3 ? 1 : 2);                       // gear: 1-2 pieces
      c = Math.min(c, Math.max(o.sell.n, Math.floor(STOCK_VALUE / worth)));        // never more than ~6 emeralds' worth
      caps.set(id, Math.max(caps.get(id) || 0, c));
    }
    for (const b of o.buy) if (b.id !== em) wants.set(b.id, Math.max(wants.get(b.id) || 0, b.n));
  }));
  return { caps, wants };
}

// ---------------------------------------------------------------- stock and restock
function stockFor(prof, v) {
  if (prof === "builder" && BF.builder && BF.builder.startStock) return BF.builder.startStock(v);   // materials for the first house, see js/builder.js
  const a = inv.create(), I = BF.I, em = I.emerald;
  const entries = [];
  const noStart = new Set([I.compass, ...[1, 2, 3, 4, 5].map(n => I["blank_map_" + n])]);   // crafted, never part of the starting stock (js/cartography.js)
  if (prof === "nitwit" || prof === "unemployed") {
    const junk = ["bread", "bone", "wheat_seeds", "stick", "apple", "rotten_flesh"].map(n => I[n]).filter(x => x !== undefined);
    for (let k = rndInt(2, 3); k > 0 && junk.length; k--) entries.push({ id: junk.splice(rndInt(0, junk.length - 1), 1)[0], n: rndInt(2, 6) });
    entries.push({ id: em, n: rndInt(1, 6) });
  } else {
    const { caps, wants } = profile(prof);
    const sells = new Map();
    table(prof).forEach(pool => pool.forEach(o => { if (o.sell.id !== em) sells.set(o.sell.id, Math.max(sells.get(o.sell.id) || 0, o.sell.n)); }));
    for (const [id, cap] of caps) if (!noStart.has(id)) entries.push({ id, n: Math.min(cap, Math.max(sells.get(id), Math.round(cap * rnd(.5, 1)))) });
    for (const [id, n] of wants) if (!caps.has(id) && !noStart.has(id) && Math.random() < .4) entries.push({ id, n: Math.min(stackOf(id), Math.max(1, Math.round(n * rnd(.3, 1)))), want: true });
    entries.push({ id: em, n: rndInt(6, 24) });
  }
  const stacks = e => Math.ceil(e.n / stackOf(e.id));
  let total = entries.reduce((s, e) => s + stacks(e), 0);
  while (total > SLOTS - 5) { // leave room to receive goods: drop wanted goods first, then trim the biggest wares
    const w = entries.findIndex(e => e.want);
    if (w >= 0) { total -= stacks(entries[w]); entries.splice(w, 1); continue; }
    const big = entries.filter(e => e.id !== em).sort((x, y) => stacks(y) - stacks(x))[0];
    if (!big || stacks(big) <= 1) break;
    big.n -= stackOf(big.id); total--;
  }
  for (const e of entries) if (e.n > 0) inv.add(a, e.id, e.n);
  if (prof === "cartographer" && BF.cartography) BF.cartography.seed(a);   // ingredients for a compass, for a map about half the time
  return a;
}
// Daily production: wares of the profession's own make rise by ~25% of their cap (min 1) up to the cap; emeralds +2 up to 12.
function restock(v, day) {
  if (!v || !v.inv) return false;
  if (day == null) day = BF.sky ? BF.sky.day : 0;
  if (v.restockDay == null || day < v.restockDay) { v.restockDay = day; return false; }
  const d = day - v.restockDay;
  if (d <= 0) return false;
  v.restockDay = day;
  const caps = profile(v.profession).caps, mk = new Set((PRODUCE[v.profession] || []).map(n => BF.I[n]));
  const em = BF.I.emerald, bld = v.profession === "builder";
  const emCap = bld ? BUILDER_EM_CAP : EM_CAP, emDay = bld ? BUILDER_EM_DAY : EM_DAY;
  for (let k = Math.min(d, 4); k > 0; k--) {
    for (const [id, cap] of caps) {
      if (!mk.has(id)) continue;
      const have = inv.count(v.inv, id);
      if (have < cap) inv.add(v.inv, id, Math.min(cap - have, Math.max(1, Math.ceil(cap * .25))));
    }
    const e = inv.count(v.inv, em);
    if (e < emCap) inv.add(v.inv, em, Math.min(emDay, emCap - e));
  }
  return true;
}

// ---------------------------------------------------------------- villager state
// Gives a villager mob its trading state: level, xp, offers, inventory. Safe to call again (fills in what is missing).
function init(v) {
  if (!v) return v;
  if (!v.level) v.level = 1;
  if (!v.xp) v.xp = 0;
  if (!Array.isArray(v.trades)) v.trades = buildTrades(v.profession, v.level);
  if (!Array.isArray(v.inv)) { v.inv = stockFor(v.profession, v); if (BF.food) BF.food.startFood(v); }   // + starting food (js/villagelife.js)
  if (v.restockDay == null) v.restockDay = BF.sky ? BF.sky.day : 0;
  if (v.profession === "explorer" && BF.explorer) BF.explorer.syncOffers(v);   // its filled maps are the offers
  return v;
}
// Why the villager cannot do this offer right now, or null.
function blockReason(v, o) {
  if (!v || !v.inv || !o) return "Unavailable";
  const hungry = BF.food && BF.food.blockReason(v, o);   // starving villagers only trade food (js/villagelife.js)
  if (hungry) return hungry;
  if (inv.count(v.inv, o.sell.id) < o.sell.n) return o.sell.id === BF.I.emerald ? "Out of emeralds" : "Out of stock";
  if (!inv.canFit(v.inv, o.buy, [o.sell])) return "Villager has no room";
  return null;
}
// Moves the goods: the sold items leave the villager, the payment arrives. Returns false (and changes nothing) when blocked.
function exchange(v, o) {
  if (blockReason(v, o)) return false;
  inv.remove(v.inv, o.sell.id, o.sell.n);
  for (const b of o.buy) inv.add(v.inv, b.id, b.n);
  return true;
}
// Villager xp for a completed offer; returns the number of levels gained and appends their offers.
function addXp(v, o) {
  v.xp = (v.xp || 0) + o.xp;
  let up = 0;
  while (v.level < 5 && v.xp >= LEVEL_XP[v.level]) { v.level++; v.trades.push(...genOffers(v.profession, v.level)); up++; }
  return up;
}

// ---------------------------------------------------------------- persistence
function pack(v) {
  return {
    inv: v.inv.map(s => s && BF.items[s.id] ? { n: BF.items[s.id].name, c: s.count } : null),
    level: v.level, xp: v.xp, day: v.restockDay,
    prof: v.profession, job: v.jobsite ? [v.jobsite.x, v.jobsite.y, v.jobsite.z] : null, st: v.jobStocked ? 1 : 0, mem: v.jobMem ? [v.jobMem.prof, v.jobMem.t] : undefined,   // jobsites (js/jobs.js); missing in older saves
    life: BF.food ? BF.food.pack(v) : undefined,   // food state (js/villagelife.js); missing in older saves
    ex: BF.explorer && v.profession === "explorer" ? BF.explorer.pack(v) : undefined,   // explorer state (js/explorer.js)
  };
}
function unpack(v, o) {
  if (!v || !o || typeof o !== "object") return v;
  if (Array.isArray(o.inv)) {
    const a = inv.create();
    o.inv.slice(0, SLOTS).forEach((s, i) => {
      const id = s && typeof s.n === "string" ? (BF.resolveItem ? BF.resolveItem(s.n) : BF.I[s.n]) : undefined, c = s && Math.floor(s.c);
      if (id !== undefined && BF.items[id] && id !== 0 && c > 0) a[i] = { id, count: Math.min(c, stackOf(id)) };
    });
    v.inv = a;
  }
  const lv = Math.floor(+o.level);
  if (lv >= 1 && lv <= 5) { v.level = lv; v.trades = buildTrades(v.profession, lv); }
  if (+o.xp >= 0) v.xp = +o.xp;
  if (Number.isFinite(+o.day)) v.restockDay = +o.day;
  if (BF.food) BF.food.unpack(v, o.life);   // no o.life = save from before villager food: starting food is added
  if (BF.explorer && o.ex) BF.explorer.unpack(v, o.ex);
  return v;
}

BF.trades = {
  SLOTS, EM_CAP, EM_DAY, BUILDER_EM_CAP, BUILDER_EM_DAY, LEVELS, LEVEL_XP, TRADE_XP, CAP_K, VALUE, TRADES, PRODUCE, inv,
  parseTrade, offers: genOffers, table, profile, stockFor, restock, init, blockReason, exchange, addXp, pack, unpack,
};
})();
