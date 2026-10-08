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
const EXPLORER_EM_CAP = 100, EXPLORER_EM_DAY = 6; // the explorer buys blank maps up to 64 emeralds each: a bigger purse
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
  string: .1, feather: .07, bone: .08, rotten_flesh: .05, gunpowder: .2, arrow: .04, white_wool: .12, leather: .15,
  raw_porkchop: .08, raw_beef: .08, raw_mutton: .07, raw_chicken: .06, cooked_porkchop: .12, steak: .12, cooked_mutton: .1,
  cooked_chicken: .1, raw_cod: .07, cooked_cod: .1,
  paper: .05, book: .35, lantern: 2.2, bell: 6, chest: .26, red_bed: .42, bow: .42,
  iron_pickaxe: 1.58, iron_axe: 1.58, iron_shovel: .57, iron_sword: 1.07, iron_hoe: 1.07, shears: 1.0, bucket: 1.6,   // shears: 2 iron ingots, bucket: 3
  golden_pickaxe: 3.68, golden_axe: 3.68, golden_shovel: 1.28, golden_sword: 2.44, golden_hoe: 2.48,   // gold ingots + sticks
  diamond_pickaxe: 10.6, diamond_axe: 10.6, diamond_shovel: 3.57, diamond_sword: 7.05, diamond_hoe: 7.07,
  compass: 3.2, blank_map_1: 3.6, blank_map_2: 7.2, blank_map_3: 14.4, blank_map_4: 28.8, blank_map_5: 57.6,                                  // cartographer goods: 4 iron + 1 gold ingot; + 8 paper (js/cartography.js)
  raw_iron: .45, raw_gold: 1.05, iron_ore: .45, gold_ore: 1.05,    // miner goods: raw ore (or the ore block) smelts into one ingot
  wooden_pickaxe: .13, wooden_axe: .13, wooden_hoe: .1, stone_pickaxe: .13, stone_axe: .13, stone_hoe: .1,   // toolsmith goods (js/toolsmith.js)
  furnace: .3,                                                       // 8 cobblestone (js/furniture.js)
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
    ["16 beetroot > 1 emerald", "8 pumpkin > 1 emerald", "1 emerald > 10 baked_potato"],
    ["28 sugar_cane > 1 emerald", "3 emerald > 4 hay_bale", "2 hay_bale > 1 emerald"],
    ["1 emerald > 14 wheat_item", "12 baked_potato > 1 emerald"],   // farmers sell only crops and food baked from them (Gordon, 1.1): no hoes, no apples
    ["1 emerald > 16 carrot", "1 emerald > 16 potato"],
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
    ["1 gold_ingot > 1 emerald"],                                     // weapons only: axes come from the toolsmith (js/toolsmith.js)
    ["1 diamond > 3 emerald", "4 emerald > 1 diamond"],
    ["7 emerald > 1 diamond_sword"],
    ["6 emerald + 1 iron_sword > 1 diamond_sword", "1 diamond_sword > 6 emerald"],
  ],
  // The toolsmith (js/toolsmith.js) sells only the tools it has made from materials it bought, so every tool it sells is offered from
  // level 1 and its stock is the limit ("Out of stock"); levels only add the materials it buys from the player. Prices: at least the cost
  // of the materials at village prices (3 raw iron from the miner = 1.5 emeralds, 3 diamonds = 12), 1 emerald at the least.
  toolsmith: [
    ["9 coal > 1 emerald", "40 cobblestone > 1 emerald",
      "1 emerald > 1 wooden_pickaxe", "1 emerald > 1 wooden_axe", "1 emerald > 1 wooden_hoe",
      "2 emerald > 1 stone_pickaxe", "2 emerald > 1 stone_axe", "2 emerald > 1 stone_hoe",
      "2 emerald > 1 iron_pickaxe", "2 emerald > 1 iron_axe", "2 emerald > 1 iron_hoe", "2 emerald > 1 shears", "2 emerald > 1 bucket",
      "4 emerald > 1 golden_pickaxe", "4 emerald > 1 golden_axe", "3 emerald > 1 golden_hoe",
      "15 emerald > 1 diamond_pickaxe", "15 emerald > 1 diamond_axe", "15 emerald > 1 diamond_hoe"],
    ["5 iron_ingot > 2 emerald", "32 stick > 1 emerald"],
    ["1 diamond > 3 emerald", "1 gold_ingot > 1 emerald"],
    ["6 raw_iron > 2 emerald", "16 planks > 1 emerald"],
    ["2 raw_gold > 1 emerald", "2 diamond > 6 emerald"],
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
    ["11 white_wool > 1 emerald", "1 emerald > 8 white_wool", "11 string > 1 emerald"],   // white wool sells from level 1: it is what the shepherd shears (js/shepherd.js)
    ["10 white_wool > 1 emerald"],
    ["16 raw_mutton > 1 emerald", "1 emerald > 9 cooked_mutton"],
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
    ["2 emerald > 22 glass", "2 emerald > 36 paper", "4 emerald > 1 blank_map_1", "8 emerald > 1 blank_map_2"],
    ["7 emerald > 3 lantern", "16 emerald > 1 blank_map_3", "32 emerald > 1 blank_map_4", "64 emerald > 1 blank_map_5"],
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
  // The forester buys oak saplings from the player at 1 emerald each, as in the villager-planter mod. It only pays while it holds emeralds
  // ("Out of emeralds" otherwise), which is what the mod's trade stock does too. Nothing else to sell: its logs and apples are its own.
  // It also sells the wood it has harvested (js/forester.js): planks it sawed from its own logs, and the logs. Prices 104-111% of VALUE (30 planks
  // = 0.9 emerald, 8 logs = 1 emerald); only what it actually holds can be bought ("Out of stock"), nothing is restocked or part of its starting pack.
  // The furniture maker and the builder buy these. Sticks (104% of VALUE) it makes from its planks and keeps in stock (js/forester.js sticks), for
  // the toolsmith, the miner and the player.
  forester: [["1 oak_sapling > 1 emerald", "1 emerald > 48 stick", "1 emerald > 30 planks", "1 emerald > 30 birch_planks", "1 emerald > 30 spruce_planks", "1 emerald > 30 jungle_planks", "1 emerald > 30 acacia_planks", "1 emerald > 30 dark_oak_planks", "1 emerald > 30 cherry_planks"], ["1 emerald > 8 oak_log", "1 emerald > 8 birch_log", "1 emerald > 8 spruce_log", "1 emerald > 8 jungle_log", "1 emerald > 8 acacia_log", "1 emerald > 8 dark_oak_log", "1 emerald > 8 cherry_log"], [], [], []],
  // The miner (js/miner.js) sells what it digs out of the ground: cobblestone first (the builders' foundations), then coal and ores. Prices
  // 104-114% of VALUE (32 cobblestone = 0.96 emerald). Only what it actually holds can be bought: nothing is restocked or part of its starting pack.
  miner: [
    ["1 emerald > 32 cobblestone", "1 emerald > 8 coal", "1 emerald > 2 raw_iron"],      // raw iron from the start: the toolsmith's iron (shears, iron tools)
    ["2 emerald > 64 cobblestone", "1 emerald > 1 raw_gold"],                            // an apprentice digs deep enough for gold
    ["4 emerald > 1 diamond"],                                                           // a journeyman deep enough for diamonds
    ["2 emerald > 16 coal"],
    ["3 emerald > 3 raw_gold"],
  ],
  // The furniture maker (js/furniture.js) buys wool and boards (planks, or logs it saws into planks) and sells the beds it makes from them
  // (3 wool + 3 planks each). It is the only villager that sells beds; builders buy them at the same offer. It also makes furnaces from 8
  // cobblestone bought from the miner, keeping one in stock for the toolsmith.
  furniture_maker: [
    ["10 white_wool > 1 emerald", "40 planks > 1 emerald", "1 emerald > 2 red_bed", "1 emerald > 1 furnace"],
    ["10 oak_log > 1 emerald", "40 cobblestone > 1 emerald"],
    ["40 spruce_planks > 1 emerald", "40 birch_planks > 1 emerald", "10 spruce_log > 1 emerald", "10 birch_log > 1 emerald"],
    ["3 emerald > 7 red_bed"],
    ["40 dark_oak_planks > 1 emerald", "40 acacia_planks > 1 emerald", "10 dark_oak_log > 1 emerald"],
  ],
};

// Wares a profession can plausibly make itself; only these are topped up by the daily restock.
const PRODUCE = {
  farmer: [],          // food is never created by the restock: farmers harvest and bake it (js/villagelife.js), see TRADE_AUDIT.md
  librarian: ["paper", "book", "glass"],
  cleric: [],
  armorer: [],          // no free iron any more: it sells only the ingots it holds (Gordon, 1.1)
  weaponsmith: ["iron_sword"],
  toolsmith: [],        // makes every tool from materials it buys (js/toolsmith.js)
  butcher: [],         // cooks raw meat it holds instead (js/villagelife.js)
  fisherman: [],       // cooks raw cod it holds instead (js/villagelife.js)
  shepherd: ["white_wool", "hay_bale"],
  fletcher: ["arrow"],
  mason: ["brick", "bricks", "stone", "terracotta", "orange_terracotta", "yellow_terracotta", "red_terracotta",
    "white_terracotta", "brown_terracotta", "sandstone_bricks"],
  leatherworker: ["leather"],
  cartographer: ["paper", "glass"],
  nitwit: [],
  unemployed: [],
  builder: [],
  explorer: [],
  forester: [],
  miner: [],          // everything it sells is dug out of the ground (js/miner.js)
  furniture_maker: [], // beds are only ever made from wool and planks it holds (js/furniture.js)
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
  clone: a => a.map(s => s && (s.wear > 0 ? { id: s.id, count: s.count, wear: s.wear } : { id: s.id, count: s.count })),   // wear: uses spent on a tool (BF.wearStack)
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
// Starting tools (Gordon's 1.1 list): villagers alive when their village is generated start with a rudimentary tool of their trade. Whoever takes
// up one of these trades later gets no tools, only the emeralds to buy them (hireKit). These four never start with any other tool among their wares.
const STARTER_TOOLS = { farmer: ["wooden_hoe", "bucket"], forester: ["wooden_axe"], miner: ["wooden_pickaxe"], shepherd: ["shears"] };
// What a newly hired villager of these trades must buy to start work (any one of each group), and what else it is given.
const HIRE_NEEDS = { farmer: [/_hoe$/, /^(water_)?bucket$/], forester: [/_axe$/], miner: [/_pickaxe$/], shepherd: [/^shears$/, /^wheat_item$/] };
const isToolItem = id => { const it = BF.items[id]; return !!(it && ((it.tool && typeof it.tool === "object") || it.name === "shears")); };   // blocks carry tool: "axe" etc. (the tool that mines them)
function stockFor(prof, v) {
  if (prof === "builder" && BF.builder && BF.builder.startStock) return BF.builder.startStock(v);   // materials for the first house, see js/builder.js
  const a = inv.create(), I = BF.I, em = I.emerald;
  const entries = [];
  const noStart = new Set([I.compass, ...[1, 2, 3, 4, 5].map(n => I["blank_map_" + n])]);   // crafted, never part of the starting stock (js/cartography.js)
  if (STARTER_TOOLS[prof]) for (const pool of table(prof)) for (const o of pool) if (isToolItem(o.sell.id)) noStart.add(o.sell.id);   // their one tool is the starter below
  if (prof === "miner") for (const n of ["cobblestone", "coal", "raw_iron", "raw_gold", "diamond"]) noStart.add(I[n]);   // mined, never given
  if (prof === "toolsmith") for (const id of profile(prof).caps.keys()) noStart.add(id);   // made, never given (js/toolsmith.js)
  if (prof === "forester") for (const sp of ["oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "cherry"]) { noStart.add(I[sp + "_log"]); noStart.add(I[sp === "oak" ? "planks" : sp + "_planks"]); } if (prof === "forester") noStart.add(I.stick);   // harvested (sticks made from them), never given
  if (prof === "nitwit" || prof === "unemployed") {
    const junk = ["bread", "bone", "wheat_seeds", "stick", "apple", "rotten_flesh"].map(n => I[n]).filter(x => x !== undefined);
    for (let k = rndInt(2, 3); k > 0 && junk.length; k--) entries.push({ id: junk.splice(rndInt(0, junk.length - 1), 1)[0], n: rndInt(2, 6) });
    entries.push({ id: em, n: rndInt(1, 6) });
  } else {
    const { caps, wants } = profile(prof);
    const sells = new Map();
    table(prof).forEach(pool => pool.forEach(o => { if (o.sell.id !== em) sells.set(o.sell.id, Math.max(sells.get(o.sell.id) || 0, o.sell.n)); }));
    for (const [id, cap] of caps) if (!noStart.has(id)) entries.push({ id, n: Math.min(cap, Math.max(sells.get(id), Math.round(cap * rnd(.5, 1)))) });
    // the furniture maker gets none of what it buys (wool, boards): it has to buy them from the shepherd and the forester (js/furniture.js seed gives one bed's worth);
    // nor does the toolsmith (ore, ingots, diamonds): it buys them from the miner (js/toolsmith.js)
    if (prof !== "furniture_maker" && prof !== "toolsmith") for (const [id, n] of wants) if (!caps.has(id) && !noStart.has(id) && Math.random() < .4) entries.push({ id, n: Math.min(stackOf(id), Math.max(1, Math.round(n * rnd(.3, 1)))), want: true });
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
  if (prof === "explorer" && I.tent !== undefined) inv.add(a, I.tent, 1);   // pitches it when night falls far from a bed (js/explorer.js)
  if (prof === "cartographer" && BF.cartography) BF.cartography.seed(a);   // ingredients for a compass, for a map about half the time
  if (prof === "furniture_maker" && BF.furniture) BF.furniture.seed(a);    // two beds and one bed's worth of wool and planks
  if (prof === "miner" && BF.miner) BF.miner.seed(a);                      // torches for the shaft
  if (prof === "toolsmith" && BF.toolsmith) BF.toolsmith.seed(a);          // no tools (it makes them), planks and sticks for its first ones
  for (const n of STARTER_TOOLS[prof] || []) if (I[n] != null && !a.some(s => s && s.id === I[n])) inv.add(a, I[n], 1);
  if (prof === "shepherd" && I.wheat_item != null) inv.add(a, I.wheat_item, 8);   // feed for the first days (it buys more when it runs low)
  return a;
}
// Emeralds' worth of the cheapest offer in any trade table selling an item `ok(name)` accepts (per piece), or null when nobody sells one.
function cheapest(ok) {
  let best = null;
  for (const prof in TRADES) for (const pool of table(prof)) for (const o of pool) {
    const it = BF.items[o.sell.id];
    if (!it || !ok(it.name) || o.buy.length !== 1 || o.buy[0].id !== BF.I.emerald) continue;
    const p = o.buy[0].n / o.sell.n;
    if (best == null || p < best) best = p;
  }
  return best;
}
// A villager takes up farming, forestry, mining or shepherding after its village was generated: no tools, just enough emeralds on top of its
// own to buy them (the cheapest seller's price of each tool it lacks, 2 when nobody sells one yet), and a new miner its 30-40 torches.
function hireKit(m, prof) {
  const I = BF.I, needs = HIRE_NEEDS[prof];
  if (!m || !Array.isArray(m.inv) || !needs) return 0;
  let want = 0;
  for (const re of needs) {
    if (m.inv.some(s => s && re.test(BF.items[s.id].name))) continue;
    const p = cheapest(n => re.test(n));
    want += re.source === "^wheat_item$" ? 1 : Math.max(1, Math.ceil(p == null ? 2 : p));
  }
  const have = inv.count(m.inv, I.emerald), add = Math.max(0, want - have);
  if (add) inv.add(m.inv, I.emerald, add);
  if (prof === "miner" && I.torch != null) inv.add(m.inv, I.torch, rndInt(30, 40));
  return add;
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
  const exp = v.profession === "explorer";
  const emCap = bld ? BUILDER_EM_CAP : exp ? EXPLORER_EM_CAP : EM_CAP, emDay = bld ? BUILDER_EM_DAY : exp ? EXPLORER_EM_DAY : EM_DAY;
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
  syncFeed(v);
  return v;
}
// ---------------------------------------------------------------- feeding hungry unemployed villagers
// An unemployed villager with less than a day's food buys food from the player while the trade screen is open: 1 emerald for ~88% of
// its worth in one of these foods (the same rule as the trade tables). It keeps buying until it holds 3 days of food (SHOP_DAYS in js/villagelife.js).
const FEED = ["bread", "baked_potato", "carrot", "potato", "apple", "steak", "cooked_porkchop", "cooked_chicken", "cooked_mutton", "cooked_cod"];
const FEED_PAY = 0.88, FEED_DAYS = 3;
const needsFood = v => !!(BF.food && v && Array.isArray(v.inv) && !v.child && (v.starving || BF.food.available(v) < BF.food.rate(v)));
function feedOffers() {
  const em = BF.I.emerald, out = [];
  for (const name of FEED) {
    const id = BF.I[name], val = VALUE[name];
    if (id === undefined || !val) continue;
    out.push({ buy: [{ id, n: Math.min(stackOf(id), Math.ceil(1 / (FEED_PAY * val))) }], sell: { id: em, n: 1 }, level: 1, xp: 0, feed: true });
  }
  return out;
}
// Adds the food offers to a hungry unemployed villager (or takes them away again). Called when the trade screen opens and closes.
function syncFeed(v, open = true) {
  if (!v || !Array.isArray(v.trades)) return v;
  v.trades = v.trades.filter(o => !o.feed);
  if (open && v.profession === "unemployed" && needsFood(v)) v.trades.push(...feedOffers());
  return v;
}

// Why the villager cannot do this offer right now, or null.
function blockReason(v, o) {
  if (!v || !v.inv || !o) return "Unavailable";
  if (o.feed && BF.food && !v.starving && BF.food.available(v) >= FEED_DAYS * BF.food.rate(v)) return "Has enough food";
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
function claimedBed(v) {
  const b = v.homeBed !== undefined ? v.homeBed : v.bed;   // an explorer camping in its tent keeps its bed at home
  return b && b.claimed && !b.tent ? [b.x, b.y, b.z, b.f] : undefined;
}
function pack(v) {
  return {
    inv: v.inv.map(s => s && BF.items[s.id] ? (s.wear > 0 ? { n: BF.items[s.id].name, c: s.count, w: s.wear } : { n: BF.items[s.id].name, c: s.count }) : null),
    level: v.level, xp: v.xp, day: v.restockDay,
    prof: v.profession, job: v.jobsite ? [v.jobsite.x, v.jobsite.y, v.jobsite.z] : null, st: v.jobStocked ? 1 : 0, mem: v.jobMem ? [v.jobMem.prof, v.jobMem.t] : undefined,   // jobsites (js/jobs.js); missing in older saves
    life: BF.food ? BF.food.pack(v) : undefined,   // food state (js/villagelife.js); missing in older saves
    ex: BF.explorer && v.profession === "explorer" ? BF.explorer.pack(v) : undefined,   // explorer state (js/explorer.js)
    mi: BF.miner && v.profession === "miner" ? BF.miner.pack(v) : undefined,          // the miner's mineshaft (js/miner.js)
    ts: BF.toolsmith && v.profession === "toolsmith" ? BF.toolsmith.pack(v) : undefined,   // the tool on the toolsmith's table, its furnace (js/toolsmith.js)
    bed: claimedBed(v),   // a bed it claimed for itself (js/mobs.js claimBed); the beds of the village layout are not saved
  };
}
function unpack(v, o) {
  if (!v || !o || typeof o !== "object") return v;
  if (Array.isArray(o.inv)) {
    const a = inv.create();
    o.inv.slice(0, SLOTS).forEach((s, i) => {
      const id = s && typeof s.n === "string" ? (BF.resolveItem ? BF.resolveItem(s.n) : BF.I[s.n]) : undefined, c = s && Math.floor(s.c);
      if (id !== undefined && BF.items[id] && id !== 0 && c > 0) a[i] = { id, count: Math.min(c, stackOf(id)) };
      if (a[i] && s.w > 0 && BF.durability(id)) a[i].wear = Math.min(Math.floor(s.w), BF.durability(id) - 1);   // a worn tool
    });
    v.inv = a;
  }
  const lv = Math.floor(+o.level);
  if (lv >= 1 && lv <= 5) { v.level = lv; v.trades = buildTrades(v.profession, lv); }
  if (+o.xp >= 0) v.xp = +o.xp;
  if (Number.isFinite(+o.day)) v.restockDay = +o.day;
  if (BF.food) BF.food.unpack(v, o.life);   // no o.life = save from before villager food: starting food is added
  if (BF.explorer && o.ex) BF.explorer.unpack(v, o.ex);
  if (BF.miner && o.mi) BF.miner.unpack(v, o.mi);
  if (BF.toolsmith && o.ts) BF.toolsmith.unpack(v, o.ts);
  if (Array.isArray(o.bed) && o.bed.length === 4 && o.bed.every(Number.isFinite)) v.bed = { x: o.bed[0], y: o.bed[1], z: o.bed[2], f: o.bed[3] & 3, claimed: true };
  return v;
}

BF.trades = {
  SLOTS, EM_CAP, EM_DAY, BUILDER_EM_CAP, BUILDER_EM_DAY, LEVELS, LEVEL_XP, TRADE_XP, CAP_K, VALUE, TRADES, PRODUCE, inv,
  parseTrade, offers: genOffers, table, profile, stockFor, STARTER_TOOLS, hireKit, restock, init, blockReason, FEED, feedOffers, syncFeed, needsFood, exchange, addXp, pack, unpack,
};
})();
