// Inventory: 36 slots (9 hotbar + 27 main), always-visible hotbar HUD and the container screens:
// inventory (2x2 crafting), crafting table (3x3), furnace (smelting), chest (27 slots of storage), villager trading and the creative menu.
// Minecraft-style mouse/touch stack handling incl. drag-splitting, shaped/shapeless recipes, save/load.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const HOTBAR = 9, SIZE = 36, COOK_TIME = 10;
const slots = new Array(SIZE).fill(null);    // {id, count} | null; 0..8 hotbar, 9..35 main
let grid = [], gw = 2;                        // crafting grid (gw x gw)
let result = null;                            // current crafting output
let cursor = null;                            // stack held by the pointer
let open_ = false, mode = "inventory", openedAt = 0;
let selected = 0;
let mouseX = innerWidth / 2, mouseY = innerHeight / 2;
let furnace = null;                           // furnace state shown on the furnace screen
let furnaceDirty = false;                     // the open furnace changed in a simulation step: redraw it
let chest = null;                             // chest state shown on the chest screen
let villager = null, pay = [null, null], offerSel = -1, tradeOffer = null, tradeResult = null, levelFlashT = 0;
let creTab = "building", creSearch = "";
let drag = null;                              // drag-split in progress {button, els:[], touch}

const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
const emitChange = () => { chestCheck(); BF.emit && BF.emit("inventoryChanged"); };
const nameOf = id => BF.itemName(id).replace(/ Item$/, "");
const isCreative = () => !!(BF.player && BF.player.gameMode === "creative");

// ---------------------------------------------------------------- recipes
// Shaped: pattern rows with keys -> id or [ids]. Any position in the grid, mirroring allowed.
// Shapeless: list of ingredients (id or [ids]). Recipes naming items missing from blocks.js are skipped.
const RECIPES = [], SMELT = new Map(), SMELT_LIST = [], FUEL = new Map(), FUEL_LIST = [];
let PLANKS = [], LOGS = [];
const idsOf = names => names.map(n => BF.I[n]).filter(v => v !== undefined);
function addShaped(out, n, pattern, key, desc) {
  const k = {};
  for (const c in key) k[c] = [].concat(key[c]).filter(v => v !== undefined);
  if (Object.values(k).some(v => !v.length) || out === undefined) return;
  RECIPES.push({ type: "shaped", out, n, pattern, key: k, w: Math.max(...pattern.map(r => r.length)), h: pattern.length, desc });
}
function addShapeless(out, n, ings, desc) {
  const list = ings.map(i => [].concat(i).filter(v => v !== undefined));
  if (list.some(v => !v.length) || out === undefined) return;
  const side = Math.ceil(Math.sqrt(list.length));
  RECIPES.push({ type: "shapeless", out, n, ings: list, w: side, h: side, desc });
}
function smelt(ins, out) {
  ins = [].concat(ins).filter(v => v !== undefined);
  if (!ins.length || out === undefined) return;
  for (const i of ins) SMELT.set(i, out);
  SMELT_LIST.push({ ins, out });
}
function fuel(list, secs, label) {
  list = [].concat(list).filter(v => v !== undefined);
  if (!list.length) return;
  for (const i of list) FUEL.set(i, secs);
  FUEL_LIST.push({ label: label || list.map(nameOf).join(", "), secs });
}
function buildRecipes() {
  const I = BF.I, names = Object.keys(I);
  LOGS = idsOf(names.filter(n => /_(log|wood)$/.test(n))); // logs, woods, stripped logs/woods
  PLANKS = idsOf(names.filter(n => n === "planks" || /_planks$/.test(n)));
  // logs -> their own planks when that block exists, else generic planks
  const groups = new Map();
  for (const n of names) if (/_(log|wood)$/.test(n)) {
    const sp = n.replace(/^stripped_/, "").replace(/_(log|wood)$/, ""); // species: oak, dark_oak, ...
    const own = sp === "oak" ? I.planks : I[sp + "_planks"], out = own !== undefined ? own : I.planks;
    if (!groups.has(out)) groups.set(out, []);
    groups.get(out).push(I[n]);
  }
  for (const [out, logs] of groups)
    addShapeless(out, 4, [logs], (nameOf(out).replace(/ ?Planks$/, "") || "Oak") + " Log / Wood (also stripped) \u2192 4 " + nameOf(out));
  const P = PLANKS, S = I.stick, C = I.cobblestone;
  addShaped(S, 4, ["P", "P"], { P }, "2 Planks (any wood, stacked) \u2192 4 Sticks");
  addShaped(I.crafting_table, 1, ["PP", "PP"], { P }, "4 Planks (2\u00d72) \u2192 Crafting Table");
  addShaped(I.chest, 1, ["PPP", "P P", "PPP"], { P }, "8 Planks in a ring \u2192 Chest");
  addShaped(I.oak_fence, 3, ["PSP", "PSP"], { P: I.planks, S }, "Oak Planks, Stick, Oak Planks \u00d7 2 rows \u2192 3 Oak Fence");
  addShaped(I.oak_door, 3, ["PP", "PP", "PP"], { P: I.planks }, "6 Planks of one wood (2\u00d73) \u2192 3 Doors of that wood");   // other woods: recipes-colour.js
  addShaped(I.red_bed, 1, ["WWW", "PPP"], { W: names.filter(n => /_wool$/.test(n)).map(n => I[n]), P }, "3 Wool (any colour) over 3 Planks \u2192 Red Bed");
  addShaped(I.furnace, 1, ["CCC", "C C", "CCC"], { C }, "8 Cobblestone in a ring \u2192 Furnace");
  const mats = [["wooden", P, "Planks"], ["stone", C, "Cobblestone"], ["iron", I.iron_ingot, "Iron Ingot"],
    ["golden", I.gold_ingot, "Gold Ingot"], ["diamond", I.diamond, "Diamond"]];
  const shapes = {
    pickaxe: [["MMM", " S ", " S "], "3 {m} across the top + 2 Sticks below"],
    axe: [["MM", "MS", " S"], "3 {m} + 2 Sticks (axe shape)"],
    shovel: [["M", "S", "S"], "1 {m} over 2 Sticks"],
    hoe: [["MM", " S", " S"], "2 {m} + 2 Sticks (hoe shape)"],
    sword: [["M", "M", "S"], "2 {m} over 1 Stick"],
  };
  for (const [tier, mat, matName] of mats) for (const tool in shapes) {
    const id = I[tier + "_" + tool];
    if (id === undefined || mat === undefined) continue;
    const [pat, d] = shapes[tool];
    addShaped(id, 1, pat, { M: mat, S }, nameOf(id) + ": " + d.replace("{m}", matName));
  }
  addShaped(I.bow, 1, [" SX", "S X", " SX"], { S, X: I.string }, "Bow: 3 Sticks + 3 String");
  addShaped(I.arrow, 4, ["F", "S", "E"], { F: I.flint, S, E: I.feather }, "Flint over Stick over Feather \u2192 4 Arrows");
  addShaped(I.bread, 1, ["WWW"], { W: I.wheat_item }, "3 Wheat in a row \u2192 Bread");
  addShaped(I.hay_bale, 1, ["WWW", "WWW", "WWW"], { W: I.wheat_item }, "9 Wheat \u2192 Hay Bale");
  addShapeless(I.wheat_item, 9, [I.hay_bale], "Hay Bale \u2192 9 Wheat");
  addShaped(I.sandstone, 1, ["SS", "SS"], { S: I.sand }, "4 Sand (2\u00d72) \u2192 Sandstone");
  addShaped(I.sandstone_bricks, 4, ["SS", "SS"], { S: I.cut_sandstone !== undefined ? I.cut_sandstone : I.sandstone }, I.cut_sandstone !== undefined ? "4 Cut Sandstone (2\u00d72) \u2192 4 Sandstone Bricks" : "4 Sandstone (2\u00d72) \u2192 4 Sandstone Bricks");
  addShaped(I.white_wool, 1, ["SS", "SS"], { S: I.string }, "4 String (2\u00d72) \u2192 White Wool");
  addShapeless(I.mossy_cobblestone, 1, [C, I.moss_block], "Cobblestone + Moss Block \u2192 Mossy Cobblestone");
  addShaped(I.coarse_dirt, 4, ["DG", "GD"], { D: I.dirt, G: I.gravel }, "2 Dirt + 2 Gravel (checkered) \u2192 4 Coarse Dirt");
  addShaped(I.lantern, 1, [" N ", "NCN", " N "], { N: I.iron_ingot, C: I.coal }, "4 Iron Ingots around Coal \u2192 Lantern");
  addShaped(I.packed_ice, 1, ["III", "III", "III"], { I: I.ice }, "9 Ice \u2192 Packed Ice");
  addShaped(I.bricks, 1, ["BB", "BB"], { B: I.brick }, "4 Brick (2\u00d72) \u2192 Bricks");
  addShapeless(I.paper, 3, [I.sugar_cane, I.sugar_cane, I.sugar_cane], "3 Sugar Cane \u2192 3 Paper");
  addShapeless(I.book, 1, [I.paper, I.paper, I.paper, I.leather], "3 Paper + Leather \u2192 Book");
  for (const f of BF.recipeHooks || []) f({ addShaped, addShapeless, smelt, fuel, nameOf }); // extra recipe packs (js/recipes-stone.js)
  for (const r of RECIPES) r.big = r.w > 2 || r.h > 2;

  // smelting
  smelt(I.raw_porkchop, I.cooked_porkchop); smelt(I.raw_beef, I.steak); smelt(I.raw_mutton, I.cooked_mutton);
  smelt(I.raw_chicken, I.cooked_chicken); smelt(I.potato, I.baked_potato);
  smelt(I.raw_cod, I.cooked_cod); if (I.egg !== undefined) smelt(I.egg, I.cooked_egg); smelt(I.raw_salmon, I.cooked_salmon);
  smelt([I.sand, I.red_sand], I.glass); smelt(C, I.stone);
  if (I.brick !== undefined && I.clay_ball !== undefined) { smelt(I.clay_ball, I.brick); smelt(I.clay, I.terracotta); }
  else smelt(I.clay, I.bricks);
  smelt(I.iron_ore, I.iron_ingot); smelt(I.gold_ore, I.gold_ingot);
  smelt(LOGS, I.charcoal !== undefined ? I.charcoal : I.coal);
  smelt(I.cactus, I.green_dye);
  // fuel (seconds of burn; one item takes 10 s to smelt)
  fuel([I.coal, I.charcoal], 80);
  fuel(LOGS, 15, "Any log"); fuel(PLANKS, 15, "Any planks");
  fuel(idsOf(["crafting_table", "chest", "oak_fence", "bow", "oak_door"]), 15);
  fuel(idsOf(names.filter(n => /^wooden_/.test(n))), 10, "Wooden tools");
  fuel(idsOf(["stick", "dead_bush", "white_wool"]), 5);
  fuel(I.coal_block, 800);
}

function matchRecipe() {
  let x0 = gw, y0 = gw, x1 = -1, y1 = -1;
  const filled = [];
  for (let y = 0; y < gw; y++) for (let x = 0; x < gw; x++) {
    const s = grid[y * gw + x];
    if (!s) continue;
    filled.push(s.id);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (!filled.length) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  for (const r of RECIPES) {
    if (r.type === "shapeless") {
      if (filled.length !== r.ings.length) continue;
      const left = r.ings.slice();
      let ok = true;
      for (const id of filled) {
        const k = left.findIndex(a => a.includes(id));
        if (k < 0) { ok = false; break; }
        left.splice(k, 1);
      }
      if (ok) return r;
      continue;
    }
    if (r.w !== bw || r.h !== bh) continue;
    for (const mirror of [false, true]) {
      let ok = true;
      for (let y = 0; y < bh && ok; y++) for (let x = 0; x < bw && ok; x++) {
        const ch = r.pattern[y].padEnd(r.w, " ")[mirror ? bw - 1 - x : x];
        const s = grid[(y0 + y) * gw + (x0 + x)];
        ok = ch === " " ? !s : !!s && r.key[ch].includes(s.id);
      }
      if (ok) return r;
    }
  }
  return null;
}
function recompute() {
  for (const hook of BF.craftHooks || []) { // computed results (js/maps.js: paper around a map); the grid is consumed as usual
    let special = null;
    try { special = hook(grid, gw); } catch (e) { console.error(e); }
    if (special && special.id !== undefined) { result = special; return; }
  }
  const r = matchRecipe();
  result = r ? { id: r.out, count: r.n } : null;
}
// Takes one of each grid ingredient. An ingredient with a container (a milk bucket, a milk bottle: blocks.js `container`) leaves it behind:
// in its grid slot when that empties, as in vanilla, else back in the inventory (js/cowherd.js).
function consumeGrid() {
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i];
    if (!s) continue;
    const it = BF.items[s.id], back = it && it.container && BF.I[it.container];
    if (--s.count <= 0) grid[i] = back != null ? { id: back, count: 1 } : null;
    else if (back != null) giveBack({ id: back, count: 1 });
  }
  recompute();
}

// ---------------------------------------------------------------- core inventory ops
const ORDER_ALL = [...Array(SIZE).keys()];
const ORDER_HOT = ORDER_ALL.slice(0, HOTBAR), ORDER_MAIN = ORDER_ALL.slice(HOTBAR);
// A new stack; a worn tool keeps its wear (BF.wearStack) wherever it goes.
const mk = (id, count, wear) => (wear > 0 ? { id, count, wear } : { id, count });
function addTo(id, count, order, wear) {
  const max = stackOf(id);
  for (const i of order) {
    const s = slots[i];
    if (count > 0 && s && s.id === id && s.count < max && !(wear > 0) && !(s.wear > 0)) { const m = Math.min(max - s.count, count); s.count += m; count -= m; }
  }
  for (const i of order) if (count > 0 && !slots[i]) { const m = Math.min(max, count); slots[i] = mk(id, m, wear); count -= m; }
  return count;
}
function fits(id, n) {
  const max = stackOf(id);
  let room = 0;
  for (const s of slots) { if (!s) room += max; else if (s.id === id) room += max - s.count; if (room >= n) return true; }
  return false;
}
function takeFromInv(id, n) { // main first, then hotbar
  let got = 0;
  for (let i = SIZE - 1; i >= 0 && got < n; i--) {
    const s = slots[i];
    if (!s || s.id !== id) continue;
    const m = Math.min(s.count, n - got);
    s.count -= m; got += m;
    if (s.count <= 0) slots[i] = null;
  }
  return got;
}
function giveBack(stack) { // into inventory; overflow is announced as a drop
  if (!stack) return;
  const left = addTo(stack.id, stack.count, ORDER_ALL, stack.wear);
  if (left > 0) BF.emit && BF.emit("itemDropped", stack.id, left);
}
// move as much of `stack` as fits into arr[i]; returns what is left
function mergeInto(arr, i, stack) {
  const s = arr[i], max = stackOf(stack.id);
  if (!s) { const m = Math.min(max, stack.count); arr[i] = mk(stack.id, m, stack.wear); return stack.count - m; }
  if (s.id !== stack.id) return stack.count;
  const m = Math.min(max - s.count, stack.count); s.count += m; return stack.count - m;
}

// ---------------------------------------------------------------- furnaces
const furnaces = new Map(); // "x,y,z" -> {key, pos, slots:[input, fuel, output], burn, burnMax, cook, lit}
function furnaceAt(pos) {
  const key = pos ? `${pos.x | 0},${pos.y | 0},${pos.z | 0}` : "portable";
  let f = furnaces.get(key);
  if (!f) { f = { key, pos: pos ? { x: pos.x | 0, y: pos.y | 0, z: pos.z | 0 } : null, slots: [null, null, null], burn: 0, burnMax: 0, cook: 0, lit: false }; furnaces.set(key, f); }
  return f;
}
function canSmelt(f) {
  const s = f.slots[0]; if (!s) return false;
  const out = SMELT.get(s.id); if (out === undefined) return false;
  const o = f.slots[2];
  return !o || (o.id === out && o.count < stackOf(out));
}
function tickFurnace(f, dt) {
  let changed = false;
  if (f.burn > 0) f.burn = Math.max(0, f.burn - dt);
  const ok = canSmelt(f);
  if (ok && f.burn <= 0 && f.slots[1] && FUEL.has(f.slots[1].id)) {
    f.burn = f.burnMax = FUEL.get(f.slots[1].id);
    if (--f.slots[1].count <= 0) f.slots[1] = null;
    changed = true;
  }
  if (ok && f.burn > 0) {
    f.cook += dt;
    if (f.cook >= COOK_TIME) {
      f.cook = 0;
      const out = SMELT.get(f.slots[0].id);
      if (--f.slots[0].count <= 0) f.slots[0] = null;
      if (f.slots[2]) f.slots[2].count++; else f.slots[2] = { id: out, count: 1 };
      changed = true;
    }
  } else if (f.cook > 0) f.cook = Math.max(0, f.cook - dt * 2);
  const lit = f.burn > 0;
  if (lit !== f.lit) { f.lit = lit; if (f.pos) BF.emit("furnaceLit", f.pos.x, f.pos.y, f.pos.z, lit); }
  return changed;
}

// ---------------------------------------------------------------- chests
// Contents live here by block position (like furnaces) and are saved with the inventory. A chest that was never opened has no entry.
// Ownership: a chest is unowned until something puts an item in it (or takes one out of an unowned chest that still holds items);
// whoever did becomes its owner: "player" or a villager's persistence key "<village key>#<slot>". In survival the player can look into
// a chest someone else owns but not change it; in creative any chest. js/storage.js gives chests back when they have been empty for a
// game day or their villager owner dies, and runs the villager side (claiming, storing surplus, taking things back).
const CHEST_SIZE = 27;
const chests = new Map(); // "x,y,z" -> {key, pos, slots:[27], owner, ownerName, emptySince, sig}
function chestAt(pos) {
  const key = `${pos.x | 0},${pos.y | 0},${pos.z | 0}`;
  let c = chests.get(key);
  if (!c) { c = { key, pos: { x: pos.x | 0, y: pos.y | 0, z: pos.z | 0 }, slots: new Array(CHEST_SIZE).fill(null), owner: null, ownerName: "", emptySince: null }; chests.set(key, c); }
  return c;
}
const chestEmpty = c => !c.slots.some(Boolean);
const chestSig = c => c.slots.map(s => s ? s.id + ":" + s.count : "").join(",");
// Something changed the contents of chest c on behalf of `owner` ("player" or a villager key; name = what the owner is called).
// An unowned chest becomes theirs. Returns true when this made them the owner.
function chestUsed(c, owner, name, mob) {
  c.sig = chestSig(c);
  c.emptySince = c.owner && chestEmpty(c) ? (c.emptySince != null ? c.emptySince : dayNow()) : null;
  if (c.owner || !owner) return false;
  c.owner = owner; c.ownerName = name || ""; c.emptySince = chestEmpty(c) ? dayNow() : null; c.reserved = null;
  BF.emit && BF.emit("chestClaimed", c, mob || null);
  return true;
}
// The chest is free again (why: "empty" | "owner died" | ...).
function chestRelease(c, why) {
  if (!c || !c.owner) return false;
  const was = { owner: c.owner, name: c.ownerName };
  c.owner = null; c.ownerName = ""; c.emptySince = null;
  BF.emit && BF.emit("chestReleased", c, why, was);
  if (open_ && chest === c) layoutFor(mode);
  return true;
}
// Survival: the chest on screen belongs to someone else, so it can be looked at but not changed.
const chestLocked = () => mode === "chest" && !!chest && !!chest.owner && chest.owner !== "player" && !isCreative();
// After every player action on the chest screen: did the contents change? (claims an unowned chest for the player)
function chestCheck() {
  if (!open_ || mode !== "chest" || !chest) return;
  const sig = chestSig(chest);
  if (sig === chest.sig) return;
  if (chestUsed(chest, "player", "you")) layoutFor(mode);
}
// Who owns the chest, as shown on its screen.
function ownerLabel(c) {
  if (!c || !c.owner) return "Unclaimed";
  if (c.owner === "player") return "Yours";
  let job = "";
  if (BF.mobs) for (const m of BF.mobs.list) if (m.type === "villager" && !m.dead && m.village && m.slot && m.village.key + "#" + m.slot.idx === c.owner) { job = m.profession; break; }
  const pretty = s => String(s).replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
  return "Owned by " + (c.ownerName || "a villager") + (job ? " (" + pretty(job) + ")" : "");
}
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
// fill arr with `stack`: top up matching stacks first, then empty slots; returns what is left
function addToArr(arr, id, count) {
  const max = stackOf(id);
  for (const s of arr) if (count > 0 && s && s.id === id && s.count < max) { const m = Math.min(max - s.count, count); s.count += m; count -= m; }
  for (let i = 0; i < arr.length && count > 0; i++) if (!arr[i]) { const m = Math.min(max, count); arr[i] = { id, count: m }; count -= m; }
  return count;
}
// The chest block at x,y,z is gone (broken, exploded, replaced): close its screen and spill what it held on the ground.
function chestRemoved(x, y, z) {
  const key = `${x},${y},${z}`, c = chests.get(key);
  if (!c) return;
  if (chest === c) closeScreen(false);
  chests.delete(key);
  if (c.owner && BF.emit) BF.emit("chestBroken", c);
  for (const s of c.slots) {
    if (!s) continue;
    if (BF.drops && BF.drops.spawn) BF.drops.spawn(s.id, s.count, x + 0.5, y + 0.4, z + 0.5);
    else { const left = addTo(s.id, s.count, ORDER_ALL); if (left) BF.emit("itemDropped", s.id, left); }
  }
  renderAll(); emitChange();
}

// The furnace block at x,y,z is gone (world.js calls furnaceRemoved from setBlock): close its screen, stop it cooking and empty it.
// Mined by the player, the contents go to the inventory: player.js emits blockBroken straight after setBlock, in the same task, and
// that claims them. Removed any other way (explosion, /setblock, /fill) they drop on the ground a microtask later. The record leaves
// the furnace map at once, so a furnace placed in the cell again starts empty.
const removedFurnaces = new Map();   // "x,y,z" -> furnace state waiting to be emptied
function furnaceRemoved(x, y, z) {
  const key = `${x},${y},${z}`, f = furnaces.get(key);
  if (!f) return;
  if (furnace === f) closeScreen(false);
  furnaces.delete(key);
  if (f.lit) { f.lit = false; BF.emit("furnaceLit", x, y, z, false); }
  removedFurnaces.set(key, f);
  queueMicrotask(() => furnaceEmpty(key, false));
}
function furnaceEmpty(key, toPlayer) {
  const f = removedFurnaces.get(key);
  if (!f) return;
  removedFurnaces.delete(key);
  const [x, y, z] = key.split(",").map(Number);
  for (const s of f.slots) {
    if (!s) continue;
    if (!toPlayer && BF.drops && BF.drops.spawn) { BF.drops.spawn(s.id, s.count, x + 0.5, y + 0.4, z + 0.5); continue; }
    const left = addTo(s.id, s.count, ORDER_ALL); if (left < s.count) showToast(s.id, s.count - left); if (left) BF.emit("itemDropped", s.id, left);
  }
  renderAll(); emitChange();
}

// ---------------------------------------------------------------- villager trading
// Tables, stock rules and villager inventories live in trading.js (BF.trades).
const LEVELS = BF.trades.LEVELS, LEVEL_XP = BF.trades.LEVEL_XP;
const TRADES = BF.trades.TRADES;
const ensureTrades = v => BF.trades.init(v);
const tradeReason = o => BF.trades.blockReason(villager, o); // null when the villager can do the offer now
function payIndex(id, n, exclude) {
  for (let k = 0; k < 2; k++) if (k !== exclude && pay[k] && pay[k].id === id && pay[k].count >= n) return k;
  return -1;
}
function offerFits(o) {
  if (!o || tradeReason(o)) return null;
  const a = payIndex(o.buy[0].id, o.buy[0].n, -1);
  if (a < 0) return null;
  if (!o.buy[1]) return [a];
  const b = payIndex(o.buy[1].id, o.buy[1].n, a);
  return b < 0 ? null : [a, b];
}
function recomputeTrade() {
  tradeOffer = null; tradeResult = null;
  if (!villager) return;
  const list = villager.trades;
  const order = offerSel >= 0 ? [offerSel] : [...list.keys()]; // a chosen offer never silently switches
  for (const i of order) if (offerFits(list[i])) {
    tradeOffer = list[i]; offerSel = i;
    tradeResult = { id: tradeOffer.sell.id, count: tradeOffer.sell.n };
    return;
  }
}
function autoFill(o) { // return payment to the inventory, then pull this offer's costs from it
  for (let k = 0; k < 2; k++) { giveBack(pay[k]); pay[k] = null; }
  o.buy.forEach((b, k) => { const got = takeFromInv(b.id, stackOf(b.id)); if (got) pay[k] = { id: b.id, count: got }; });
}
function topUp(o) { // after a trade, refill the payment slots from the inventory
  o.buy.forEach((b, k) => {
    let i = pay.findIndex(s => s && s.id === b.id);
    if (i < 0) { i = pay.findIndex(s => !s); if (i < 0) return; }
    const have = pay[i] ? pay[i].count : 0, want = stackOf(b.id) - have;
    const got = want > 0 ? takeFromInv(b.id, want) : 0;
    if (got) pay[i] = { id: b.id, count: have + got };
  });
}
function performTrade(o) {
  const idx = offerFits(o);
  o.buy.forEach((b, k) => { const s = pay[idx[k]]; s.count -= b.n; if (s.count <= 0) pay[idx[k]] = null; });
  BF.trades.exchange(villager, o);
  if (BF.trades.addXp(villager, o)) { levelFlashT = 2.5; BF.emit("villagerLevelUp", villager, villager.level); }
  BF.emit("villagerTrade", villager, o);
  if (BF.prices) BF.prices.filled(villager, o, 1);
}
function clickTrade(shift) {
  if (!tradeOffer) return;
  const o = tradeOffer, out = o.sell;
  if (o.horse) { performTrade(o); topUp(o); recomputeTrade(); return; }   // a stable's horse (js/stables.js): it walks out to the player, nothing goes into a slot
  if (shift) {
    let got = 0;
    for (let g = 0; g < 64 && tradeOffer === o; g++) {
      if (!fits(out.id, out.n)) break;
      performTrade(o); addTo(out.id, out.n, ORDER_ALL); got += out.n;
      topUp(o); recomputeTrade();
    }
    if (got) showToast(out.id, got);
    return;
  }
  if (cursor && (cursor.id !== out.id || cursor.count + out.n > stackOf(out.id))) return;
  performTrade(o);
  if (cursor) cursor.count += out.n; else cursor = { id: out.id, count: out.n };
  topUp(o); recomputeTrade();
}

// ---------------------------------------------------------------- creative menu
const CRE_TABS = [
  { key: "building", label: "Building Blocks", icon: "bricks" },
  { key: "colour", label: "Colored Blocks", icon: "red_wool" },
  { key: "natural", label: "Natural Blocks", icon: "grass" },
  { key: "functional", label: "Functional Blocks", icon: "crafting_table" },
  { key: "tools", label: "Tools & Combat", icon: "iron_pickaxe" },
  { key: "food", label: "Food & Ingredients", icon: "apple" },
  { key: "misc", label: "Miscellaneous", icon: "stick" },
  { key: "search", label: "Search Items", icon: "glass" },
  { key: "inventory", label: "Survival Inventory", icon: "chest" },
];
const COLOUR_RE = /(^|_)(wool|terracotta|concrete|concrete_powder|stained_glass|dye)$|^tinted_glass$/;
const COLOUR_FAMS = ["wool", "terracotta", "glazed_terracotta", "concrete", "concrete_powder", "stained_glass", "tinted_glass", "dye"];
function colourSortKey(name) { // family, then dye colour order (plain / white first)
  let fam = -1; COLOUR_FAMS.forEach((f, i) => { if ((name === f || name.endsWith("_" + f)) && (fam < 0 || f.length > COLOUR_FAMS[fam].length)) fam = i; });
  const base = fam < 0 ? "" : name.slice(0, Math.max(0, name.length - COLOUR_FAMS[fam].length - 1));
  const ci = BF.DYE_COLOURS ? BF.DYE_COLOURS.findIndex(c => c[0] === base) : -1;
  return (fam < 0 ? 99 : fam) * 100 + (ci < 0 ? -1 : ci);
}
const FUNCTIONAL = /^(crafting_table|furnace|chest|lantern|bell|torch|bed|bookshelf|ladder|.*door|.*trapdoor|jukebox|anvil)$/;
const NATURAL = /(^grass$|dirt|^sand$|red_sand|gravel|snow|ice|_log$|leaves|cactus|_ore$|^clay$|pumpkin|mycelium|podzol|mushroom|^mud$|calcite|moss_block|bedrock|farmland|sugar_cane|terracotta)/;
let creList = null;
function creativeItems() {
  if (creList) return creList;
  const growTargets = new Set(BF.blocks.filter(b => b && b.growsInto != null)
    .map(b => typeof b.growsInto === "number" ? (BF.blocks[b.growsInto] || {}).name : b.growsInto));
  creList = [];
  for (const it of BF.items) { // sparse: holes between block ids and ITEM_BASE iterate as undefined
    if (!it || it.id === 0 || it.hidden || it.internal || it.map || it.auto) continue;   // filled maps are made from blank ones, not picked
    if (it.isBlock && (it.render === "liquid" || it.fluidLevel || it.growsInto || growTargets.has(it.name))) continue;
    let cat;
    if (it.creativeTab) cat = it.creativeTab; // explicit tab on the block def
    else if (COLOUR_RE.test(it.name)) cat = "colour"; // wool, terracotta, glazed, concrete, powder, stained glass, dyes
    else if ((!it.isBlock && it.tool) || it.name === "arrow") cat = "tools";
    else if (it.food || /seeds$|^wheat_item$|^sugar_cane$/.test(it.name) && !it.isBlock) cat = "food";
    else if (!it.isBlock && !it.places) cat = "misc";
    else if (it.places || FUNCTIONAL.test(it.name)) cat = "functional";
    else if (NATURAL.test(it.name) || it.render === "cross") cat = "natural";
    else cat = "building";
    creList.push({ id: it.id, cat, name: (nameOf(it.id) + (it.search ? " " + it.search : "")).toLowerCase() });
  }
  // keep each 16-colour family together, in dye order (stable: ties keep id order)
  const col = creList.filter(e => e.cat === "colour").map(e => [colourSortKey(BF.items[e.id].name), e]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
  let ci = 0; creList = creList.map(e => (e.cat === "colour" ? col[ci++] : e));
  return creList;
}

// ---------------------------------------------------------------- pixel sprites (flame / arrow)
function sprite(w, h, fn) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const col = fn(x, y); if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); } }
  return c.toDataURL();
}
const FLAME = ["......#.......", ".....##.......", ".....###......", "....####..#...", "...######.##..", "...#########..",
  "..###########.", "..###########.", ".#############", ".#############", ".#############", "..###########.", "...#########..", "....#######..."];
const inFlame = (x, y) => FLAME[y][x] === "#";
const inArrow = (x, y) => (x < 14 && y >= 5 && y <= 9) || (x >= 13 && Math.abs(y - 7) <= 21 - x);
// creative trashcan, 16x16 (L lid, B body, D rib/shadow, E rim); the open can (lid lifted) shows while an item is held
const CAN = ["................", "......LLLL......", "......L..L......", ".LLLLLLLLLLLLLL.", ".LLLLLLLLLLLLLL."];
const CAN_OPEN = ["....LLLL........", "....L..L........", "LLLLLLLLLLLLLL..", "LLLLLLLLLLLLLL..", "................"];
const CAN_BODY = ["..EEEEEEEEEEEE..", ...Array(7).fill("..DBBBDBBDBBBD.."), "...DBBDBBDBBD...", "...DBBDBBDBBD...", "...EEEEEEEEEE..."];
const CAN_COL = { L: "#c9d1c4", B: "#a9b2a4", D: "#6d7569", E: "#8f988b" };
const trashCan = open => { const rows = (open ? CAN_OPEN : CAN).concat(CAN_BODY);
  return (x, y) => CAN_COL[(rows[y] || "")[x]] || null; };
let SPR = null;
function sprites() {
  if (SPR) return SPR;
  const fl = ["#ffe26a", "#ffd04a", "#ffb43a", "#ff9a2a", "#f47a22", "#e85a1c"];
  SPR = {
    flameOff: sprite(14, 14, (x, y) => inFlame(x, y) ? "#3b403d" : null),
    flameOn: sprite(14, 14, (x, y) => inFlame(x, y) ? fl[Math.max(0, Math.min(5, y >> 1) - ((x + y) % 5 === 0 ? 1 : 0))] : null),
    arrowOff: sprite(22, 15, (x, y) => inArrow(x, y) ? "#3b403d" : null),
    arrowOn: sprite(22, 15, (x, y) => inArrow(x, y) ? (y === 5 || y === 9 ? "#cfd8c8" : "#f4f7ef") : null),
    trash: sprite(16, 16, trashCan(false)),
    trashOpen: sprite(16, 16, trashCan(true)),
  };
  return SPR;
}

// ---------------------------------------------------------------- CSS
const HB = "min(44px, calc((100vw - 24px) / 9))";
const HB_BOTTOM = "calc(8px + env(safe-area-inset-bottom, 0px))";
const css = `
#ui > .bf-hotbar { position: fixed; left: 50%; transform: translateX(-50%); bottom: ${HB_BOTTOM};
  display: flex; padding: 3px; background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 3px; touch-action: none; }
.bf-hotbar .bf-slot { width: ${HB}; height: ${HB}; }
.bf-hotbar .bf-slot.sel { outline: 3px solid var(--ink); outline-offset: -2px; z-index: 1; background: rgba(127,191,77,.22); }
.bf-slot { position: relative; box-sizing: border-box; background: rgba(0,0,0,.38);
  box-shadow: inset 2px 2px 0 rgba(0,0,0,.6), inset -2px -2px 0 rgba(255,255,255,.09); display: grid; place-items: center; }
.bf-slot img { width: 76%; height: 76%; image-rendering: pixelated; image-rendering: crisp-edges; pointer-events: none; -webkit-user-drag: none; }
.bf-slot img[hidden] { display: none; }
.bf-slot .bf-n { position: absolute; right: 2px; bottom: 1px; font: 11px/1 var(--display); color: var(--ink);
  text-shadow: 1px 1px 0 #000, -1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000; pointer-events: none; }
.bf-hotbar .bf-n { font-size: 12px; }
.bf-slot .bf-wear { position: absolute; left: 12%; right: 12%; bottom: 9%; height: 3px; background: #000; pointer-events: none; }
.bf-slot .bf-wear::after { content: ""; position: absolute; left: 0; top: 0; height: 2px; width: var(--f); background: var(--c); }
.bf-slot .bf-wear[hidden] { display: none; }
.bf-slot.bf-ghost { background: rgba(127,191,77,.3); }
.bf-slot.bf-ghost img { opacity: .75; }
#ui > .bf-itemname { position: fixed; left: 50%; transform: translateX(-50%); pointer-events: none;
  bottom: calc(${HB_BOTTOM} + ${HB} + 8px + 44px);
  font: 13px/1 var(--display); color: var(--ink); text-shadow: 1px 1px 0 #000; padding: 4px 8px;
  background: rgba(18,22,20,.55); border-radius: 2px; opacity: 0; transition: opacity .25s; white-space: nowrap; }
#ui > .bf-itemname.show { opacity: 1; }
#ui > .bf-toasts { position: fixed; pointer-events: none; display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
  left: calc(50% + ${HB} * 4.5 + 16px); bottom: ${HB_BOTTOM}; }
@media (max-width: 760px) { #ui > .bf-toasts { left: auto; right: 12px; align-items: flex-end;
  bottom: calc(${HB_BOTTOM} + ${HB} + 8px + 44px + 30px); } }
.bf-toast { display: flex; align-items: center; gap: 6px; font: 12px/1 var(--display); color: var(--ink); text-shadow: 1px 1px 0 #000;
  background: var(--panel); border: 1px solid var(--panel-edge); padding: 3px 8px 3px 4px; border-radius: 2px; transition: opacity .4s; white-space: nowrap; }
.bf-toast img { width: 18px; height: 18px; image-rendering: pixelated; }
.bf-toast b { color: var(--accent); font-weight: normal; }
.bf-toast.out { opacity: 0; }

#ui > .bf-inv-back { position: fixed; inset: 0; background: rgba(6,9,7,.5); display: none; touch-action: none; z-index: 20; }
#ui > .bf-inv-back.open { display: block; }
.bf-inv [hidden] { display: none !important; }
.bf-inv { --s: min(40px, calc((100vw - 48px) / 10.4), calc((100vh - 100px) / 9.4)); position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%); background: rgba(18,22,20,.93); border: 1px solid var(--panel-edge); border-radius: 4px;
  padding: calc(var(--s) * .35); box-shadow: 0 10px 40px rgba(0,0,0,.5); color: var(--ink); display: flex; gap: calc(var(--s) * .35); }
.bf-inv.m-trade { --s: min(40px, calc((100vw - 56px) / 16.5), calc((100vh - 100px) / 9.4)); }
.bf-col { position: relative; }
.bf-inv h2 { margin: 0 0 6px; font: calc(var(--s) * .32) / 1 var(--display); color: var(--muted); font-weight: normal; letter-spacing: .5px; }
.bf-inv .bf-row { display: grid; grid-template-columns: repeat(9, var(--s)); }
.bf-inv .bf-slot { width: var(--s); height: var(--s); cursor: pointer; }
.bf-inv .bf-slot:hover { background: rgba(255,255,255,.13); }
.bf-inv .bf-n { font-size: calc(var(--s) * .28); }
.bf-craft, .bf-furn, .bf-trade { display: flex; align-items: center; gap: calc(var(--s) * .45); min-height: calc(var(--s) * 3);
  margin-bottom: calc(var(--s) * .3); padding-left: calc(var(--s) * .5); }
.bf-cgrid { display: grid; }
.bf-arrow { font: calc(var(--s) * .6) / 1 var(--display); color: var(--muted); }
.bf-inv .bf-big { width: calc(var(--s) * 1.3); height: calc(var(--s) * 1.3); }
.bf-inv .bf-big.has { box-shadow: inset 2px 2px 0 rgba(0,0,0,.6), inset -2px -2px 0 rgba(255,255,255,.09), 0 0 0 2px var(--accent); }
.bf-inv .bf-gap { height: calc(var(--s) * .25); }
.bf-hotwrap { display: flex; gap: calc(var(--s) * .3); align-items: center; }
.bf-inv .bf-slot.bf-trash { background-image: var(--can); background-repeat: no-repeat; background-position: center; background-size: 72%; image-rendering: pixelated; }
.bf-inv .bf-slot.bf-trash.armed { background-image: var(--can-open); }
.bf-inv .bf-slot.bf-trash.armed:hover { background-color: rgba(214,72,56,.45); box-shadow: inset 0 0 0 2px var(--danger); }
.bf-rbtn { position: absolute; right: 0; top: calc(var(--s) * .55); font: calc(var(--s) * .28) / 1 var(--display); color: var(--ink); background: rgba(255,255,255,.07);
  border: 1px solid var(--panel-edge); border-radius: 2px; padding: 5px 7px; cursor: pointer; z-index: 2; }
.bf-rbtn:hover, .bf-rbtn[aria-expanded="true"] { background: rgba(127,191,77,.28); }
.bf-recipes { position: absolute; right: 0; top: calc(var(--s) * 1.25); width: calc(var(--s) * 6.6); max-height: calc(var(--s) * 6.6); overflow: auto;
  background: rgba(10,13,11,.98); border: 1px solid var(--panel-edge); border-radius: 3px; padding: 6px 9px; z-index: 3; touch-action: pan-y;
  font: 11px/1.45 var(--mono); color: var(--ink); display: none; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
.bf-recipes.open { display: block; }
.bf-recipes div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.bf-recipes .big { color: var(--muted); }
.bf-recipes .big::after { content: " (table)"; color: var(--accent); font-size: 10px; }
.bf-recipes p { margin: 0 0 4px; color: var(--muted); font-size: 10px; }
.bf-recipes h3 { margin: 8px 0 3px; font: 11px/1 var(--display); color: var(--accent); font-weight: normal; }
.bf-inv .bf-chest { margin-bottom: calc(var(--s) * .3); }
.bf-fcol { display: flex; flex-direction: column; align-items: center; gap: calc(var(--s) * .12); }
.bf-prog { position: relative; display: block; image-rendering: pixelated; }
.bf-prog img { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; }
.bf-flame { width: calc(var(--s) * .7); height: calc(var(--s) * .7); }
.bf-parrow { width: calc(var(--s) * 1.1); height: calc(var(--s) * .75); }
.bf-fstat { font: 11px/1.4 var(--mono); color: var(--muted); max-width: calc(var(--s) * 3); }
.bf-tx { position: absolute; inset: 0; display: none; place-items: center; color: var(--danger); font: calc(var(--s) * .6) / 1 var(--display); }
.bf-tx.on { display: grid; }
.bf-thead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.bf-thead h2 { margin: 0; }
.bf-lvl { font: calc(var(--s) * .3) / 1 var(--display); color: var(--accent); }
.bf-lvl.flash { color: #ffe26a; }
.bf-xp { height: 5px; background: rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.12); width: calc(var(--s) * 5); margin-bottom: 4px; }
.bf-xp i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .3s; }
.bf-side { width: calc(var(--s) * 6); display: flex; flex-direction: column; }
.bf-offers { flex: 1; overflow-y: auto; max-height: calc(var(--s) * 4.7); touch-action: pan-y; display: flex; flex-direction: column; gap: 2px; }
.bf-offer { display: grid; grid-template-columns: 1fr 1fr calc(var(--s) * .5) 1fr; align-items: center; height: calc(var(--s) * .95);
  background: rgba(255,255,255,.05); border: 1px solid transparent; border-radius: 2px; padding: 0 4px; cursor: pointer; position: relative; color: var(--ink); font: inherit; }
.bf-offer:hover { background: rgba(255,255,255,.12); }
.bf-offer.sel { border-color: var(--accent); background: rgba(127,191,77,.18); }
.bf-offer.out { opacity: .45; }
.bf-offer.out .ar { color: var(--danger); }
.bf-offer .ar { color: var(--muted); font: calc(var(--s) * .35) / 1 var(--display); text-align: center; }
.bf-oc { position: relative; width: calc(var(--s) * .7); height: calc(var(--s) * .7); }
.bf-oc img { width: 100%; height: 100%; image-rendering: pixelated; }
.bf-oc b { position: absolute; right: -3px; bottom: -2px; font: calc(var(--s) * .24) / 1 var(--display); font-weight: normal; text-shadow: 1px 1px 0 #000, -1px 0 0 #000; }
.bf-vinv { margin-top: calc(var(--s) * .25); }
.bf-vinv h2 { margin-bottom: 4px; }
.bf-vgrid { display: grid; grid-template-columns: repeat(6, var(--s)); }
.bf-vgrid .bf-slot { opacity: .5; filter: grayscale(.85); cursor: default; }
.bf-vgrid .bf-slot:hover { background: none; }
.bf-vgrid.edit .bf-slot { opacity: 1; filter: none; cursor: pointer; }
.bf-vgrid.edit .bf-slot:hover { background: rgba(255,255,255,.12); }
.bf-none { color: var(--muted); font: 12px/1.5 var(--mono); padding: 8px 2px; }
.bf-osep { color: var(--muted); font: 11px/1.4 var(--mono); padding: 6px 2px 2px; border-top: 1px solid rgba(255,255,255,.12); margin-top: 4px; }
.bf-tabs { display: flex; gap: 2px; margin-bottom: 6px; }
.bf-tab { width: calc(var(--s) * 1.05); height: calc(var(--s) * .95); display: grid; place-items: center; background: rgba(255,255,255,.05);
  border: 1px solid var(--panel-edge); border-radius: 2px 2px 0 0; cursor: pointer; padding: 0; }
.bf-tab img { width: 62%; height: 62%; image-rendering: pixelated; pointer-events: none; }
.bf-tab.on { background: rgba(127,191,77,.25); border-color: var(--accent); }
.bf-search { width: calc(var(--s) * 9); box-sizing: border-box; margin-bottom: 6px; background: rgba(0,0,0,.45); color: var(--ink);
  border: 1px solid var(--panel-edge); border-radius: 2px; font: 13px var(--mono); padding: 5px 7px; }
.bf-search:focus { outline: 1px solid var(--accent); }
.bf-pal { display: grid; grid-template-columns: repeat(9, var(--s)); grid-auto-rows: var(--s); height: calc(var(--s) * 5); overflow-y: auto;
  touch-action: pan-y; align-content: start; margin-bottom: calc(var(--s) * .3); }
@media (max-width: 640px) {
  .bf-inv.m-trade { --s: min(40px, calc((100vw - 48px) / 10.4), calc((100vh - 100px) / 15.6)); flex-direction: column; }
  .bf-side { width: auto; }
  .bf-offers { max-height: calc(var(--s) * 3.1); }
  .bf-vgrid { grid-template-columns: repeat(9, var(--s)); }
}
.bf-inv-back .bf-held { position: fixed; left: 0; top: 0; pointer-events: none; width: 40px; height: 40px; z-index: 30; display: none;
  background: none; box-shadow: none; }
.bf-inv-back .bf-held.on { display: grid; }
.bf-tip { position: fixed; left: 0; top: 0; pointer-events: none; z-index: 31; font: 12px/1.3 var(--display); color: var(--ink);
  background: rgba(14,12,24,.96); border: 1px solid rgba(127,191,77,.55); padding: 5px 7px; border-radius: 2px; display: none; white-space: pre; }
.bf-tip.on { display: block; }
`;

// ---------------------------------------------------------------- DOM
let hotbarEl, nameEl, toastsEl, backEl, panelEl, heldEl, tipEl, recipesEl, rbtn, titleEl;
let craftEl, craftGridEl, resultEl, furnEl, fSlots = [], flameFill, arrowFill, fstatEl;
let vinvEl, vinvTitleEl, vSlotEls = [];
let chestEl, chestSlotEls = [];
let tradeEl, paySlots = [], tresEl, txEl, sideEl, offersEl, lvlEl, xpEl, theadEl;
let creEl, tabsEl, searchEl, palEl, invHeadEl, mainRowEl, gapEl, trashEl;
const hudSlots = [], invSlotEls = [];
let gridSlotEls = [];
const iconCache = new Map();

const isMapItem = id => { const it = BF.items[id]; return !!(it && (it.map || it.auto) && BF.mapIcon); };   // filled maps have a live thumbnail icon (js/mapview.js)
const mapIconVer = id => { const r = isMapItem(id) && BF.mapIcon(BF.items[id]); return r ? r.ver : 0; };
function iconURL(id) {
  if (!isMapItem(id) && iconCache.has(id)) return iconCache.get(id);
  let url = null;
  try { url = BF.textures && BF.textures.icon && BF.textures.icon(id); } catch (e) { url = null; }
  if (url) { if (!isMapItem(id)) iconCache.set(id, url); }
  else {
    const c = document.createElement("canvas"); c.width = c.height = 16;
    const g = c.getContext("2d"); g.fillStyle = (BF.items[id] && BF.items[id].color) || "#f0f"; g.fillRect(2, 2, 12, 12);
    url = c.toDataURL();
  }
  return url;
}
function makeSlot(cls, c, i) {
  const el = document.createElement("div");
  el.className = "bf-slot" + (cls ? " " + cls : "");
  const img = document.createElement("img"); img.alt = ""; img.draggable = false; img.hidden = true;
  const n = document.createElement("span"); n.className = "bf-n";
  const w = document.createElement("i"); w.className = "bf-wear"; w.hidden = true;
  el.append(img, n, w);
  el._img = img; el._n = n; el._w = w; el._id = -1;
  if (c) { el.dataset.c = c; el.dataset.i = i || 0; }
  return el;
}
function setSlot(el, s) {
  const id = s ? s.id : -1, iv = s ? mapIconVer(id) : 0;
  if (el._id !== id || el._iv !== iv) {
    el._id = id; el._iv = iv;
    if (s) { el._img.src = iconURL(s.id); el._img.hidden = false; } else { el._img.removeAttribute("src"); el._img.hidden = true; }
  }
  const t = s && s.count > 1 ? String(s.count) : "";
  if (el._n.textContent !== t) el._n.textContent = t;
  // durability bar of a worn tool, green to red, as Minecraft
  const max = s && s.wear > 0 ? BF.durability(s.id) : 0, f = max ? Math.max(0, 1 - s.wear / max) : -1;
  if (el._wf !== f) {
    el._wf = f; el._w.hidden = f < 0;
    if (f >= 0) { el._w.style.setProperty("--f", (f * 100).toFixed(1) + "%"); el._w.style.setProperty("--c", `hsl(${Math.round(f * 120)},90%,45%)`); }
  }
}
const div = (cls, parent) => { const d = document.createElement("div"); if (cls) d.className = cls; if (parent) parent.appendChild(d); return d; };
function progEl(cls, off, on) {
  const w = div("bf-prog " + cls);
  const a = document.createElement("img"), b = document.createElement("img");
  a.src = off; b.src = on; a.alt = b.alt = "";
  w.append(a, b);
  return [w, b];
}

function buildDOM() {
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const ui = document.getElementById("ui");
  const S = sprites();

  hotbarEl = div("bf-hotbar");
  for (let i = 0; i < HOTBAR; i++) { const el = makeSlot(); el.dataset.i = i; hudSlots.push(el); hotbarEl.appendChild(el); }
  hotbarEl.addEventListener("pointerdown", e => {
    const el = e.target.closest(".bf-slot"); if (!el) return;
    e.preventDefault(); e.stopPropagation(); api.select(+el.dataset.i);
  });
  nameEl = div("bf-itemname");
  toastsEl = div("bf-toasts");

  backEl = div("bf-inv-back");
  panelEl = div("bf-inv", backEl);
  panelEl.setAttribute("role", "dialog"); panelEl.setAttribute("aria-label", "Inventory");

  // trade offers column
  sideEl = div("bf-side", panelEl);
  const sh = document.createElement("h2"); sh.textContent = "Trades"; sideEl.appendChild(sh);
  offersEl = div("bf-offers", sideEl);
  offersEl.addEventListener("click", e => {
    const row = e.target.closest(".bf-offer"); if (!row) return;
    selectOffer(+row.dataset.i);
  });
  offersEl.addEventListener("pointerdown", e => e.stopPropagation());
  // the villager's own inventory: display only (greyed, no clicks, drags or shift-moves)
  vinvEl = div("bf-vinv", sideEl);
  vinvTitleEl = document.createElement("h2"); vinvEl.appendChild(vinvTitleEl);
  const vgrid = div("bf-vgrid", vinvEl);
  for (let i = 0; i < BF.trades.SLOTS; i++) { const el = makeSlot("", "vinv", i); vSlotEls.push(el); vgrid.appendChild(el); }

  const col = div("bf-col", panelEl);
  theadEl = div("bf-thead", col);
  titleEl = document.createElement("h2"); lvlEl = document.createElement("span"); lvlEl.className = "bf-lvl";
  theadEl.append(titleEl, lvlEl);
  xpEl = div("bf-xp", col); xpEl.appendChild(document.createElement("i"));

  rbtn = document.createElement("button"); rbtn.className = "bf-rbtn"; rbtn.type = "button"; rbtn.textContent = "Recipes";
  rbtn.setAttribute("aria-expanded", "false");
  recipesEl = div("bf-recipes");
  rbtn.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); toggleRecipes(); });
  recipesEl.addEventListener("pointerdown", e => e.stopPropagation());
  col.append(rbtn, recipesEl);

  // crafting
  craftEl = div("bf-craft", col);
  craftGridEl = div("bf-cgrid", craftEl);
  const arrow = div("bf-arrow", craftEl); arrow.textContent = "\u2192";
  resultEl = makeSlot("bf-big", "result"); craftEl.appendChild(resultEl);

  // furnace
  furnEl = div("bf-furn", col);
  const fcol = div("bf-fcol", furnEl);
  fSlots = [0, 1, 2].map(i => makeSlot(i === 2 ? "bf-big" : "", "furn", i));
  const [flame, ff] = progEl("bf-flame", S.flameOff, S.flameOn); flameFill = ff;
  fcol.append(fSlots[0], flame, fSlots[1]);
  const [parrow, af] = progEl("bf-parrow", S.arrowOff, S.arrowOn); arrowFill = af;
  furnEl.append(parrow, fSlots[2]);
  fstatEl = div("bf-fstat", furnEl);

  // chest: 3 rows of 9
  chestEl = div("bf-chest bf-row", col);
  for (let i = 0; i < CHEST_SIZE; i++) { const el = makeSlot("", "chest", i); chestSlotEls.push(el); chestEl.appendChild(el); }

  // trade payment
  tradeEl = div("bf-trade", col);
  paySlots = [0, 1].map(i => makeSlot("", "pay", i));
  const [tarrow] = progEl("bf-parrow", S.arrowOff, S.arrowOff);
  txEl = div("bf-tx", tarrow); txEl.textContent = "X";
  tresEl = makeSlot("bf-big", "tres");
  tradeEl.append(paySlots[0], paySlots[1], tarrow, tresEl);

  // creative
  creEl = div("bf-cre", col);
  tabsEl = div("bf-tabs", creEl);
  for (const t of CRE_TABS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "bf-tab"; b.dataset.tab = t.key;
    b.title = t.label; b.setAttribute("aria-label", t.label);
    const img = document.createElement("img"); img.alt = ""; b.appendChild(img);
    tabsEl.appendChild(b);
  }
  tabsEl.addEventListener("pointerdown", e => {
    const b = e.target.closest(".bf-tab"); if (!b) return;
    e.preventDefault(); e.stopPropagation(); setTab(b.dataset.tab);
  });
  searchEl = document.createElement("input"); searchEl.className = "bf-search"; searchEl.type = "search";
  searchEl.placeholder = "Search items"; searchEl.setAttribute("aria-label", "Search items");
  searchEl.addEventListener("input", () => { creSearch = searchEl.value.trim().toLowerCase(); buildPalette(); });
  searchEl.addEventListener("pointerdown", e => e.stopPropagation());
  creEl.appendChild(searchEl);
  palEl = div("bf-pal", creEl);

  invHeadEl = document.createElement("h2"); invHeadEl.textContent = "Inventory"; col.appendChild(invHeadEl);
  mainRowEl = div("bf-row", col);
  gapEl = div("bf-gap", col);
  const hotWrap = div("bf-hotwrap", col);
  const hot = div("bf-row", hotWrap);
  for (let i = 0; i < SIZE; i++) {
    const el = makeSlot("", "inv", i); invSlotEls[i] = el;
    (i < HOTBAR ? hot : mainRowEl).appendChild(el);
  }
  trashEl = makeSlot("bf-trash", "trash"); trashEl.setAttribute("aria-label", "Trash");
  trashEl.style.setProperty("--can", `url(${S.trash})`); trashEl.style.setProperty("--can-open", `url(${S.trashOpen})`);
  hotWrap.appendChild(trashEl);

  heldEl = makeSlot("bf-held");
  tipEl = div("bf-tip");
  backEl.append(heldEl, tipEl);
  ui.append(hotbarEl, nameEl, toastsEl, backEl);

  // ----- pointer handling
  let mpick = null;  // mouse: the slot a stack was just picked up from, so releasing it over the trash destroys it (drag to trash)
  let press = null; // touch: tap = left click, long-press = right click / start an even split while holding a stack
  backEl.addEventListener("contextmenu", e => e.preventDefault());
  backEl.addEventListener("pointermove", e => {
    mouseX = e.clientX; mouseY = e.clientY;
    if (drag) { dragOver(e.clientX, e.clientY); return; }
    if (e.pointerType === "mouse") hover(e.target);
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) { clearTimeout(press.timer); press.moved = true; }
  });
  backEl.addEventListener("pointerdown", e => {
    mouseX = e.clientX; mouseY = e.clientY;
    if (e.target === searchEl) return;
    const el = e.target.closest && e.target.closest(".bf-slot");
    if (!el || el === heldEl) {
      if (e.target === backEl && performance.now() - openedAt > 250) { e.preventDefault(); api.close(); }
      else if (recipesEl.classList.contains("open")) toggleRecipes(false);
      return;
    }
    e.preventDefault();
    if (el.dataset.c === "vinv" && !vinvEditable()) return;
    if (document.activeElement === searchEl && e.pointerType !== "mouse") searchEl.blur();
    if (e.pointerType === "touch" || e.pointerType === "pen") {
      const p = press = { el, fired: false, moved: false, x: e.clientX, y: e.clientY };
      p.timer = setTimeout(() => {
        if (press !== p || p.moved) return;
        p.fired = true;
        if (cursor && canDrop(el)) { drag = { button: 0, els: [el], touch: true, shift: false }; renderAll(); }
        else slotClick(el, 2, false, true);
      }, 420);
      return;
    }
    const button = e.button === 2 ? 2 : 0;
    if (cursor && (e.button === 0 || e.button === 2) && canDrop(el)) {
      drag = { button, els: [el], touch: false, shift: e.shiftKey };
      renderAll();
      return;
    }
    const had = !!cursor;
    slotClick(el, button, e.shiftKey, false);
    mpick = !had && cursor ? el : null;
  });
  const endPress = (e, cancel) => {
    if (mpick) {
      const from = mpick; mpick = null;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (!cancel && cursor && from !== trashEl && under && under.closest && under.closest(".bf-slot") === trashEl) { slotClick(trashEl, 0, false, false); return; }
    }
    if (drag) {
      const d = drag; drag = null;
      if (press) { clearTimeout(press.timer); press = null; }
      if (cancel) { renderAll(); return; }
      if (d.els.length > 1) { applyDrag(d); renderAll(); emitChange(); }
      else if (d.touch) slotClick(d.els[0], 2, false, true);
      else slotClick(d.els[0], d.button, d.shift, false);
      return;
    }
    if (!press) return;
    const p = press; press = null; clearTimeout(p.timer);
    if (cancel || p.fired) return;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = (p.moved && under && under.closest && under.closest(".bf-slot")) || p.el;
    if (p.moved && target === p.el) return;
    if (p.moved) { if (!cursor) slotClick(p.el, 0, false, true); slotClick(target, 0, false, true); }
    else slotClick(p.el, 0, false, true);
  };
  backEl.addEventListener("pointerup", e => endPress(e, false));
  backEl.addEventListener("pointercancel", e => endPress(e, true));
}

function toggleRecipes(force) {
  const on = recipesEl.classList.toggle("open", force);
  rbtn.setAttribute("aria-expanded", String(on));
}
function hover(target) {
  const row = target && target.closest && target.closest(".bf-offer");
  if (row && villager && !cursor) {
    const o = villager.trades[+row.dataset.i];
    if (o) {
      const cost = o.buy.map(b => b.n + " " + nameOf(b.id)).join(" + ");
      const why = tradeReason(o);
      showTipText(cost + " \u2192 " + o.sell.n + " " + nameOf(o.sell.id) + "\n" + (why || "In stock: " + BF.trades.inv.count(villager.inv, o.sell.id)), false);
      return;
    }
  }
  const el = target && target.closest && target.closest(".bf-slot, .bf-tab");
  if (el && el.classList.contains("bf-tab")) { if (!cursor) showTipText(CRE_TABS.find(t => t.key === el.dataset.tab).label, false); return; }
  if (el && el !== heldEl) showTip(el, false); else hideTip();
}
let tipUntil = 0;
const vinvEditable = () => isCreative() && !!(villager && villager.inv);   // creative mode: the villager's inventory can be edited
function arrFor(c) {
  if (c === "vinv") return vinvEditable() ? villager.inv : null;
  return c === "inv" ? slots : c === "grid" ? grid : c === "furn" ? (furnace && furnace.slots) : c === "chest" ? (chest && chest.slots) : c === "pay" ? pay : null;
}
function stackAt(el) {
  const c = el.dataset.c, i = +el.dataset.i;
  if (c === "result") return result;
  if (c === "tres") return tradeResult;
  if (c === "pal") return { id: i, count: 1 };
  if (c === "vinv") return villager && villager.inv ? villager.inv[i] : null;
  if (c === "trash") return null;
  const arr = arrFor(c);
  return arr ? arr[i] : null;
}
function showTip(el, timed) {
  if (el.dataset.c === "trash") {
    showTipText(cursor ? "Destroy " + nameOf(cursor.id) + (cursor.count > 1 ? " \u00d7" + cursor.count : "") + "\nRight-click: destroy one"
      : "Trash: drop an item here to destroy it\nDel: destroy the stack under the pointer\nShift-click: empty the " + (creTab === "inventory" ? "inventory" : "hotbar"), timed);
    return;
  }
  const s = stackAt(el);
  if (!s || cursor) { hideTip(); return; }
  let t = nameOf(s.id);
  if (el.dataset.c === "furn" && el.dataset.i === "1" && FUEL.has(s.id)) t += "\nBurns " + FUEL.get(s.id) + "s";
  const max = BF.durability(s.id);
  if (max && el.dataset.c !== "pal") t += "\nDurability: " + (max - (s.wear || 0)) + " / " + max;
  showTipText(t, timed);
}
function showTipText(text, timed) {
  tipEl.textContent = text;
  tipEl.classList.add("on");
  tipUntil = timed ? performance.now() + 1200 : Infinity;
  placeTip();
}
function placeTip() {
  const w = tipEl.offsetWidth;
  const x = Math.max(4, Math.min(innerWidth - w - 4, mouseX + 14)), y = Math.max(4, mouseY - 34);
  tipEl.style.transform = `translate(${x}px, ${y}px)`;
}
function hideTip() { tipEl && tipEl.classList.remove("on"); }

// ---------------------------------------------------------------- drag splitting
function canDrop(el) {
  if (!cursor || !el || !el.dataset) return false;
  const c = el.dataset.c, i = +el.dataset.i;
  if (!(c === "inv" || c === "grid" || c === "pay" || (c === "chest" && !chestLocked()) || (c === "vinv" && vinvEditable()) || (c === "furn" && (i === 0 || (i === 1 && FUEL.has(cursor.id)))))) return false;
  const arr = arrFor(c); if (!arr) return false;
  const s = arr[i];
  return !s || (s.id === cursor.id && s.count < stackOf(s.id));
}
function dragOver(x, y) {
  const under = document.elementFromPoint(x, y);
  const el = under && under.closest && under.closest(".bf-slot");
  if (!el || drag.els.includes(el) || !canDrop(el)) return;
  if (drag.els.length >= cursor.count) return;
  drag.els.push(el);
  renderAll();
}
function dragPlan(d) {
  const add = new Map();
  let left = cursor.count;
  const per = d.button === 0 ? Math.floor(cursor.count / d.els.length) : 1;
  for (const el of d.els) {
    const s = stackAt(el), room = stackOf(cursor.id) - (s ? s.count : 0);
    const m = Math.max(0, Math.min(per, room, left));
    add.set(el, m); left -= m;
  }
  return { add, left };
}
function applyDrag(d) {
  const { add, left } = dragPlan(d), id = cursor.id;
  for (const [el, m] of add) {
    if (!m) continue;
    const arr = arrFor(el.dataset.c), i = +el.dataset.i;
    if (arr[i]) arr[i].count += m; else arr[i] = mk(id, m, cursor.wear);
  }
  cursor.count = left;
  if (cursor.count <= 0) cursor = null;
  recompute(); recomputeTrade();
}

// ---------------------------------------------------------------- slot interactions
function slotClick(el, button, shift, touch) {
  const c = el.dataset.c, i = +el.dataset.i;
  if (c === "vinv" && !vinvEditable()) return;
  if (c === "chest" && chestLocked()) return;   // someone else's chest: look, don't touch
  if (c === "result") clickResult(shift);
  else if (c === "tres") clickTrade(shift);
  else if (c === "pal") clickPalette(i, button, shift);
  else if (c === "trash") {
    if (cursor && button === 2) { if (--cursor.count <= 0) cursor = null; }   // right-click: destroy one
    else if (cursor) cursor = null;
    else if (shift) for (let k = 0, n = creTab === "inventory" ? SIZE : HOTBAR; k < n; k++) slots[k] = null;   // the slots you can see
  }
  else if (c === "furn" && i === 2) takeOutput(button, shift);
  else if (shift && button === 0) shiftMove(c, i);
  else {
    const arr = arrFor(c);
    if (!arr) return;
    const s = arr[i];
    if (c === "furn" && i === 1 && cursor && !FUEL.has(cursor.id)) { /* only fuel goes in the fuel slot */ }
    else if (button === 0) {
      if (!cursor) { if (s) { cursor = s; arr[i] = null; } }
      else if (!s) { arr[i] = cursor; cursor = null; }
      else if (s.id === cursor.id) {
        const m = Math.min(cursor.count, stackOf(s.id) - s.count);
        if (m > 0) { s.count += m; cursor.count -= m; if (cursor.count <= 0) cursor = null; }
        else { arr[i] = cursor; cursor = s; }
      } else { arr[i] = cursor; cursor = s; }
    } else {
      if (!cursor) {
        if (s) { const take = Math.ceil(s.count / 2); cursor = mk(s.id, take, s.wear); s.count -= take; if (s.count <= 0) arr[i] = null; }
      } else if (!s) { arr[i] = mk(cursor.id, 1, cursor.wear); if (--cursor.count <= 0) cursor = null; }
      else if (s.id === cursor.id) { if (s.count < stackOf(s.id)) { s.count++; if (--cursor.count <= 0) cursor = null; } }
      else { arr[i] = cursor; cursor = s; }
    }
    if (c === "grid") recompute();
    if (c === "pay") recomputeTrade();
  }
  renderAll(); emitChange();
  if (cursor) hideTip(); else showTip(el, touch);
}
function takeOutput(button, shift) {
  const s = furnace && furnace.slots[2];
  if (!s) return;
  if (shift) { const left = addTo(s.id, s.count, ORDER_ALL); const got = s.count - left; if (left > 0) s.count = left; else furnace.slots[2] = null; if (got) showToast(s.id, got); return; }
  if (!cursor) {
    const take = button === 2 ? Math.ceil(s.count / 2) : s.count;
    cursor = { id: s.id, count: take }; s.count -= take;
  } else if (cursor.id === s.id) {
    const m = Math.min(s.count, stackOf(s.id) - cursor.count); cursor.count += m; s.count -= m;
  }
  if (s.count <= 0) furnace.slots[2] = null;
}
function shiftMove(c, i) {
  if (c === "inv") {
    const s = slots[i]; if (!s) return;
    if (mode === "creative") { if (creTab !== "inventory") return; }
    let st = mk(s.id, s.count, s.wear);
    if (mode === "furnace" && furnace) {
      const target = SMELT.has(s.id) ? 0 : FUEL.has(s.id) ? 1 : -1;
      if (target >= 0) st.count = mergeInto(furnace.slots, target, st);
    } else if (mode === "chest" && chest && !chestLocked()) {
      st.count = addToArr(chest.slots, s.id, s.count);
    } else if (mode === "trade" && villager) {
      const o = villager.trades[offerSel];
      const wanted = o ? o.buy.map(b => b.id) : villager.trades.flatMap(t => t.buy.map(b => b.id));
      if (wanted.includes(s.id)) {
        let k = pay.findIndex(p => p && p.id === s.id);
        if (k < 0 && o) { const bi = o.buy.findIndex(b => b.id === s.id); if (!pay[bi]) k = bi; }
        if (k < 0) k = pay.findIndex(p => !p);
        if (k >= 0) st.count = mergeInto(pay, k, st);
        recomputeTrade();
      } else if (vinvEditable()) st.count = BF.trades.inv.add(villager.inv, st.id, st.count);   // creative: shift-click gives it to the villager
    }
    if (st.count === s.count) { // not consumed by the container: hotbar <-> main
      slots[i] = null;
      const left = addTo(s.id, s.count, i < HOTBAR ? ORDER_MAIN : ORDER_HOT, s.wear);
      if (left > 0) slots[i] = mk(s.id, left, s.wear);
    } else if (st.count > 0) s.count = st.count;
    else slots[i] = null;
  } else {
    const arr = arrFor(c); if (!arr) return;
    const s = arr[i]; if (!s) return;
    arr[i] = null;
    const left = addTo(s.id, s.count, ORDER_ALL, s.wear);
    if (left > 0) arr[i] = mk(s.id, left, s.wear);
    if (c === "grid") recompute();
    if (c === "pay") recomputeTrade();
  }
}
function clickResult(shift) {
  if (!result) return;
  if (shift) {
    const id = result.id;
    let crafted = 0;
    for (let guard = 0; guard < 64 && result && result.id === id; guard++) {
      if (!fits(id, result.count)) break;
      addTo(id, result.count, ORDER_ALL); crafted += result.count;
      consumeGrid();
    }
    if (crafted) showToast(id, crafted);
    return;
  }
  if (!cursor) { cursor = { id: result.id, count: result.count }; consumeGrid(); }
  else if (cursor.id === result.id && cursor.count + result.count <= stackOf(cursor.id)) { cursor.count += result.count; consumeGrid(); }
}
function clickPalette(id, button, shift) {
  const max = stackOf(id);
  if (shift) { addTo(id, max, ORDER_HOT); return; }
  if (cursor && cursor.id !== id) { cursor = null; return; } // clicking the palette with another item deletes it (like MC)
  if (button === 2) { if (!cursor) cursor = { id, count: 1 }; else if (cursor.count < max) cursor.count++; }
  else cursor = { id, count: max };
}
// creative Del key: destroys the held stack, or else the inventory stack under the pointer
function trashKey() {
  if (cursor) { cursor = null; renderAll(); emitChange(); return; }
  const under = document.elementFromPoint(mouseX, mouseY);
  const el = under && under.closest && under.closest(".bf-slot");
  if (!el || el.dataset.c !== "inv" || !slots[+el.dataset.i]) return;
  slots[+el.dataset.i] = null;
  renderAll(); emitChange(); hideTip();
}
function selectOffer(i) {
  if (!villager || !villager.trades[i]) return;
  offerSel = i;
  autoFill(villager.trades[i]);
  recomputeTrade();
  if (!tradeOffer) offerSel = i;
  renderAll(); emitChange();
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  if (!hotbarEl) return;
  for (let i = 0; i < HOTBAR; i++) { setSlot(hudSlots[i], slots[i]); hudSlots[i].classList.toggle("sel", i === selected); }
  if (!open_) return;
  for (let i = 0; i < SIZE; i++) setSlot(invSlotEls[i], slots[i]);
  if (mode === "inventory" || mode === "crafting") {
    for (let i = 0; i < grid.length; i++) setSlot(gridSlotEls[i], grid[i]);
    setSlot(resultEl, result);
    resultEl.classList.toggle("has", !!result);
  } else if (mode === "furnace" && furnace) {
    for (let i = 0; i < 3; i++) setSlot(fSlots[i], furnace.slots[i]);
    renderFurnaceProgress();
  } else if (mode === "chest" && chest) {
    for (let i = 0; i < CHEST_SIZE; i++) setSlot(chestSlotEls[i], chest.slots[i]);
  } else if (mode === "trade") {
    setSlot(paySlots[0], pay[0]); setSlot(paySlots[1], pay[1]);
    const vi = villager && villager.inv;
    vSlotEls[0].parentNode.classList.toggle("edit", vinvEditable());
    for (let i = 0; i < vSlotEls.length; i++) setSlot(vSlotEls[i], vi ? vi[i] : null);
    setSlot(tresEl, tradeResult);
    tresEl.classList.toggle("has", !!tradeResult);
    const o = villager && villager.trades[offerSel];
    txEl.classList.toggle("on", !!(o && tradeReason(o)));
    renderOffers();
  }
  for (const el of backEl.querySelectorAll(".bf-ghost")) el.classList.remove("bf-ghost");
  let held = cursor;
  if (drag && cursor && drag.els.length > 1) {
    const { add, left } = dragPlan(drag);
    for (const [el, m] of add) {
      const s = stackAt(el);
      setSlot(el, mk(cursor.id, (s ? s.count : 0) + m, cursor.wear));
      el.classList.add("bf-ghost");
    }
    held = left > 0 ? mk(cursor.id, left, cursor.wear) : null;
  }
  setSlot(heldEl, held);
  heldEl.classList.toggle("on", !!held);
  trashEl.classList.toggle("armed", !!cursor);
  if (held) heldEl.style.transform = `translate(${mouseX - 20}px, ${mouseY - 20}px)`;
}
function renderFurnaceProgress() {
  const f = furnace;
  const burn = f.burnMax > 0 ? Math.max(0, Math.min(1, f.burn / f.burnMax)) : 0;
  flameFill.style.clipPath = `inset(${((1 - burn) * 100).toFixed(1)}% 0 0 0)`;
  arrowFill.style.clipPath = `inset(0 ${((1 - f.cook / COOK_TIME) * 100).toFixed(1)}% 0 0)`;
  let t;
  const ok = canSmelt(f);
  if (!f.slots[0]) t = "Put something to smelt on top";
  else if (!SMELT.has(f.slots[0].id)) t = nameOf(f.slots[0].id) + " can't be smelted";
  else if (!ok) t = "Output is full";
  else if (f.burn > 0) t = "Smelting \u2192 " + nameOf(SMELT.get(f.slots[0].id));
  else t = "Needs fuel below the flame";
  if (fstatEl.textContent !== t) fstatEl.textContent = t;
}
let offersKey = "";
function renderOffers() {
  const v = villager;
  const key = v ? v.trades.map(o => (tradeReason(o) || "") + o.buy.map(b => b.id + "x" + b.n).join("+") + ">" + o.sell.id + "x" + o.sell.n).join("|") + "#" + offerSel + "#" + v.level : "-";   // amounts too: prices move (js/prices.js)
  if (key !== offersKey) {
    offersKey = key;
    offersEl.textContent = "";
    if (!v || !v.trades.length) {
      const d = div("bf-none", offersEl); d.textContent = "This villager has nothing to trade.";
    } else v.trades.forEach((o, i) => {
      // spare goods and what it needs now (js/market.js) come after its job's offers
      const extra = x => !!(x.spare || x.need || x.feed);
      if (extra(o) && (i === 0 || !extra(v.trades[i - 1]))) { const d = div("bf-osep", offersEl); d.textContent = "Spare goods and needs"; }
      const row = document.createElement("button"); row.type = "button";
      row.className = "bf-offer" + (i === offerSel ? " sel" : "") + (tradeReason(o) ? " out" : "");
      row.dataset.i = i;
      const cell = st => {
        const c = div(st ? "bf-oc" : "");
        if (st) { const img = document.createElement("img"); img.alt = nameOf(st.id); img.src = iconURL(st.id); c.appendChild(img);
          if (st.n > 1) { const b = document.createElement("b"); b.textContent = st.n; c.appendChild(b); } }
        return c;
      };
      const ar = document.createElement("span"); ar.className = "ar"; ar.textContent = tradeReason(o) ? "X" : "\u2192";
      row.append(cell(o.buy[0]), cell(o.buy[1]), ar, cell(o.sell));
      row.setAttribute("aria-label", o.buy.map(b => b.n + " " + nameOf(b.id)).join(" + ") + " for " + o.sell.n + " " + nameOf(o.sell.id));
      if (o.note) row.title = o.note;   // e.g. a stable horse's stats (js/stables.js)
      offersEl.appendChild(row);
    });
  }
  if (v) {
    const lvl = v.level || 1;
    const prof = (v.profession || "villager").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const st = BF.villagerStatus ? BF.villagerStatus.text(v) : "";   // what the villager is doing (js/villagerstatus.js)
    const vn = BF.vlog ? BF.vlog.nameOf(v) : "";                      // villager names (js/villagelog.js)
    titleEl.textContent = (vn ? vn + ", " : "") + (st ? prof + " \u2014 " + st : prof);
    vinvTitleEl.textContent = vn ? vn + "'s Inventory" : prof + " Inventory";
    lvlEl.textContent = levelFlashT > 0 ? "Level up! " + LEVELS[lvl - 1] : LEVELS[lvl - 1];
    lvlEl.classList.toggle("flash", levelFlashT > 0);
    const frac = lvl >= 5 ? 1 : (v.xp - LEVEL_XP[lvl - 1]) / (LEVEL_XP[lvl] - LEVEL_XP[lvl - 1]);
    xpEl.firstChild.style.width = (Math.max(0, Math.min(1, frac)) * 100).toFixed(1) + "%";
    xpEl.title = lvl >= 5 ? "Master" : `${v.xp} / ${LEVEL_XP[lvl]} XP`;
  }
}
function buildGrid() {
  craftGridEl.textContent = "";
  craftGridEl.style.gridTemplateColumns = `repeat(${gw}, var(--s))`;
  gridSlotEls = [];
  for (let i = 0; i < gw * gw; i++) { const el = makeSlot("", "grid", i); gridSlotEls.push(el); craftGridEl.appendChild(el); }
}
function buildHelp() {
  recipesEl.textContent = "";
  const add = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; recipesEl.appendChild(e); };
  const craft = () => {
    add("h3", "Crafting");
    add("p", "Shaped recipes work anywhere in the grid, mirrored too." + (gw === 2 && mode !== "furnace" ? " Ones marked (table) need a crafting table." : ""));
    for (const r of RECIPES) if (r.desc) add("div", r.desc, r.big && gw === 2 && mode !== "furnace" ? "big" : "");
  };
  const smeltH = () => {
    add("h3", "Smelting (furnace)");
    add("p", "Item on top, fuel below. Each item takes " + COOK_TIME + "s.");
    for (const s of SMELT_LIST) add("div", s.ins.map(nameOf).join(" / ") + " \u2192 " + nameOf(s.out));
    add("h3", "Fuel");
    for (const f of FUEL_LIST) add("div", f.label + ": " + f.secs + "s (" + (f.secs / COOK_TIME) + " items)");
  };
  if (mode === "furnace") { smeltH(); craft(); } else { craft(); smeltH(); }
  toggleRecipes(false);
}
function setTab(key) {
  creTab = key;
  for (const b of tabsEl.children) b.classList.toggle("on", b.dataset.tab === key);
  const t = CRE_TABS.find(t => t.key === key);
  titleEl.textContent = t ? t.label : "";
  searchEl.hidden = key !== "search";
  const inv = key === "inventory";
  palEl.hidden = inv; mainRowEl.hidden = !inv; invHeadEl.hidden = !inv; gapEl.hidden = !inv;
  if (key === "search" && matchMedia("(pointer: fine)").matches) setTimeout(() => searchEl.focus(), 0);
  buildPalette();
  hideTip();
}
function buildPalette() {
  if (creTab === "inventory") return;
  const list = creativeItems().filter(e => creTab === "search" ? (!creSearch || creSearch.split(/\s+/).every(w => e.name.includes(w))) : e.cat === creTab);
  palEl.textContent = "";
  const frag = document.createDocumentFragment();
  for (const e of list) { const el = makeSlot("", "pal", e.id); setSlot(el, { id: e.id, count: 1 }); frag.appendChild(el); }
  const pad = Math.max(45, Math.ceil(list.length / 9) * 9) - list.length;
  for (let k = 0; k < pad; k++) { const el = makeSlot(); el.style.cursor = "default"; frag.appendChild(el); }
  palEl.appendChild(frag);
  palEl.scrollTop = 0;
}
function layoutFor(m) {
  panelEl.className = "bf-inv m-" + m;
  const cre = m === "creative", trade = m === "trade";
  sideEl.hidden = !trade;
  lvlEl.hidden = !trade; xpEl.hidden = !trade;
  craftEl.hidden = !(m === "inventory" || m === "crafting");
  furnEl.hidden = m !== "furnace";
  chestEl.hidden = m !== "chest";
  tradeEl.hidden = !trade;
  creEl.hidden = !cre;
  trashEl.hidden = !cre;
  rbtn.hidden = !(m === "inventory" || m === "crafting" || m === "furnace");
  invHeadEl.hidden = mainRowEl.hidden = gapEl.hidden = false;
  if (cre) {
    for (const b of tabsEl.children) { const t = CRE_TABS.find(t => t.key === b.dataset.tab); const id = BF.I[t.icon]; if (id !== undefined) b.firstChild.src = iconURL(id); }
    setTab(creTab);
  } else if (trade) {
    // title/level set in renderOffers
  } else if (m === "chest") titleEl.textContent = "Chest \u2014 " + ownerLabel(chest) + (chestLocked() ? " (look only)" : "");
  else titleEl.textContent = m === "crafting" ? "Crafting Table" : m === "furnace" ? "Furnace" : "Crafting";
}

// ---------------------------------------------------------------- toasts / name label
const toasts = [];
function showToast(id, n) {
  if (!toastsEl || !n) return;
  let t = toasts.find(t => t.id === id && t.t > 0.6);
  if (!t) {
    const el = div("bf-toast");
    const img = document.createElement("img"); img.alt = ""; img.src = iconURL(id);
    const b = document.createElement("b"), span = document.createElement("span");
    el.append(img, b, span);
    toastsEl.appendChild(el);
    t = { id, n: 0, el, b, span, t: 0 };
    toasts.push(t);
    while (toasts.length > 5) toasts.shift().el.remove();
  }
  t.n += n; t.t = 2.2;
  t.el.classList.remove("out");
  t.b.textContent = "+" + t.n;
  t.span.textContent = nameOf(id);
}
let nameT = 0;
function flashName() {
  const s = slots[selected];
  if (!s) { nameEl.classList.remove("show"); nameT = 0; return; }
  nameEl.textContent = nameOf(s.id);
  nameEl.classList.add("show");
  nameT = 1.8;
}

// ---------------------------------------------------------------- open / close
function openScreen(m) {
  if (open_) closeScreen(true);
  mode = m;
  gw = m === "crafting" ? 3 : 2;
  grid = new Array(gw * gw).fill(null);
  recompute();
  if (m === "inventory" || m === "crafting") buildGrid();
  layoutFor(m);
  if (m !== "creative" && m !== "trade" && m !== "chest") buildHelp();
  open_ = true; openedAt = performance.now();
  BF.state.paused = true;
  if (m === "chest" && chest) { chest.sig = chestSig(chest); BF.emit && BF.emit("chestOpened", chest.pos.x, chest.pos.y, chest.pos.z); }
  backEl.classList.add("open");
  hotbarEl.style.visibility = "hidden";
  nameEl.classList.remove("show");
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (_) {} }
  offersKey = "";
  renderAll();
}
function closeScreen(silent) {
  if (!open_) return;
  open_ = false; drag = null;
  for (let i = 0; i < grid.length; i++) { giveBack(grid[i]); grid[i] = null; }
  for (let k = 0; k < 2; k++) { giveBack(pay[k]); pay[k] = null; }
  giveBack(cursor); cursor = null; result = null;
  if (villager) {
    const v = villager; villager = null;
    BF.trades.syncFeed(v, false);   // food offers of a hungry villager, spare goods and needs (js/market.js)
    try { if (v.position && BF.mobs && BF.mobs.setTrading) BF.mobs.setTrading(v, false); } catch (e) { console.error(e); }
  }
  tradeOffer = tradeResult = null; offerSel = -1;
  furnace = null;
  if (chest) { const p = chest.pos; chest = null; BF.emit && BF.emit("chestClosed", p.x, p.y, p.z); }
  if (document.activeElement === searchEl) searchEl.blur();
  backEl.classList.remove("open");
  heldEl.classList.remove("on");
  hideTip();
  hotbarEl.style.visibility = "";
  BF.state.paused = false;
  renderAll(); emitChange();
  if (!silent) BF.emit && BF.emit("inventoryClosed");
}

// ---------------------------------------------------------------- save / load
const toSave = s => s ? (s.wear > 0 ? { n: BF.items[s.id] ? BF.items[s.id].name : null, c: s.count, w: s.wear } : { n: BF.items[s.id] ? BF.items[s.id].name : null, c: s.count }) : null;
function fromSave(o) {
  if (!o) return null;
  const id = typeof o.n === "string" ? (BF.resolveItem ? BF.resolveItem(o.n) : BF.I[o.n]) : typeof o.id === "number" ? o.id : undefined;
  const count = Math.floor(o.c != null ? o.c : o.count);
  if (id === undefined || !BF.items[id] || id === 0 || !(count > 0)) return null;
  const w = Math.floor(+o.w || 0), max = BF.durability(id);
  return mk(id, Math.min(count, stackOf(id)), max ? Math.min(w, max - 1) : 0);
}

// ---------------------------------------------------------------- public API
const api = {
  get selectedIndex() { return selected; },
  set selectedIndex(i) { api.select(i); },
  get mode() { return open_ ? mode : null; },
  get cursor() { return cursor; },
  slots,            // read-only view for other modules (0..8 hotbar)
  recipes: RECIPES,
  smelting: SMELT,  // input id -> output id
  fuel: FUEL,       // item id -> burn seconds
  furnaces,         // "x,y,z" -> furnace state
  chests,           // "x,y,z" -> chest contents {pos, slots[27]}
  CHEST_SIZE,
  trades: TRADES,
  levelNames: LEVELS,
  isCreative,
  iconURL,          // item id -> icon image URL, as the slots show it (js/debugfeed.js sends these to the debug screen)
  init() {
    buildRecipes();
    buildDOM();
    renderAll();
    // capture phase so an E press that closes the screen never reaches a toggle handler elsewhere
    addEventListener("keydown", e => {
      if (open_) {
        const typing = e.target === searchEl;
        if (e.code === "Escape" || (e.code === "KeyE" && !typing)) { e.preventDefault(); e.stopImmediatePropagation(); api.close(); }
        else if (e.code === "Delete" && !typing && mode === "creative") { e.preventDefault(); e.stopImmediatePropagation(); trashKey(); }
        else if (typing) e.stopImmediatePropagation();
        return;
      }
      if (/^Digit[1-9]$/.test(e.code) && !e.ctrlKey && !e.altKey && !e.metaKey && !(BF.state && BF.state.paused) && !(BF.player && BF.player.menu && BF.player.menu())) api.select(+e.code.slice(5) - 1);   // not on the title screen
    }, true);
    document.addEventListener("pointermove", e => { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
    BF.on("newWorld", () => { closeScreen(); api.clear(); api.select(0); furnaces.clear(); removedFurnaces.clear(); chests.clear(); });
    BF.on("gameModeChanged", () => { if (open_ && (mode === "creative" || mode === "inventory")) api.close(); });
    BF.on("blockBroken", (x, y, z, id) => { if (BF.isFurnace(id)) { furnaceRemoved(x, y, z); furnaceEmpty(`${x},${y},${z}`, true); } });
  },
  update(dt) {
    // furnaces cook in game time (simTick, so fast-forward speeds them up too), or in real time while you watch one in the pause
    if (BF.state.paused && open_ && mode === "furnace" && furnace) furnaceDirty = tickFurnace(furnace, dt) || furnaceDirty;
    if (open_ && mode === "furnace" && furnace) { if (furnaceDirty) renderAll(); else renderFurnaceProgress(); }
    furnaceDirty = false;
    if (open_) {
      if (mode === "trade" && villager) {
        if (villager.dead || villager.removed) { api.close(); return; }
        if (levelFlashT > 0) levelFlashT -= dt;
        renderOffers();
      }
      const held = !heldEl.classList.contains("on") ? null : true;
      if (held) heldEl.style.transform = `translate(${mouseX - 20}px, ${mouseY - 20}px)`;
      if (tipEl.classList.contains("on")) { if (performance.now() > tipUntil) hideTip(); else placeTip(); }
    }
    if (nameT > 0 && (nameT -= dt) <= 0) nameEl.classList.remove("show");
    for (let k = toasts.length - 1; k >= 0; k--) {
      const t = toasts[k];
      t.t -= dt;
      if (t.t < 0.4) t.el.classList.add("out");
      if (t.t <= 0) { t.el.remove(); toasts.splice(k, 1); }
    }
  },
  add(itemId, count = 1, wear = 0) {   // wear: uses already spent on a tool (a worn tool picked up again)
    if (itemId === undefined || itemId === null || itemId === 0 || !BF.items[itemId] || !(count > 0)) return count || 0;
    const left = addTo(itemId, count, ORDER_ALL, wear);
    if (left !== count) { showToast(itemId, count - left); renderAll(); emitChange(); }
    return left;
  },
  remove(itemId, count = 1) {
    const removed = takeFromInv(itemId, count);
    if (removed) { renderAll(); emitChange(); }
    return removed;
  },
  // Direct slot write (creative pick-block). stack = {id, count} | null
  setSlot(i, stack) {
    if (!(i >= 0 && i < SIZE)) return;
    slots[i] = stack && BF.items[stack.id] && stack.id !== 0 && stack.count > 0
      ? mk(stack.id, Math.min(Math.floor(stack.count), stackOf(stack.id)), stack.wear) : null;
    renderAll(); emitChange();
    if (i === selected) flashName();
  },
  count(itemId) { let n = 0; for (const s of slots) if (s && s.id === itemId) n += s.count; return n; },
  selected() { return slots[selected]; },
  refreshIcons() { renderAll(); },   // map thumbnails change while a map fills in (js/mapview.js)
  select(i) {
    i = ((Math.floor(i) % HOTBAR) + HOTBAR) % HOTBAR;
    const changed = i !== selected;
    selected = i;
    renderAll();
    if (changed) { flashName(); BF.emit && BF.emit("selectChanged", i); }
  },
  // Wears the selected tool by n uses (survival only). When it is used up it breaks: the slot empties and "toolBroken" is emitted.
  // Returns "broken", true (worn) or false (not a tool with a lifespan, or creative).
  wearSelected(n = 1) {
    const s = slots[selected];
    if (!s || isCreative()) return false;
    const r = BF.wearStack(s, n);
    if (r === "broken") { slots[selected] = null; BF.emit && BF.emit("toolBroken", s.id); }
    if (r) renderAll();
    if (r === "broken") emitChange();
    return r;
  },
  // Crafting grid for tests (headless): gridSet(stacks, w) fills a w x w grid; craftResult() is what it makes; craftTake() takes one craft
  // (as a click on the result slot) and returns it; gridGet() is the grid's contents.
  gridSet(stacks, w) { gw = w || 3; grid = Array.from({ length: gw * gw }, (_, i) => (stacks && stacks[i] ? { id: stacks[i].id, count: stacks[i].count || 1 } : null)); recompute(); return result; },
  craftResult() { return result ? { id: result.id, count: result.count } : null; },
  craftTake() { if (!result) return null; const r = { id: result.id, count: result.count }; addTo(r.id, r.count, ORDER_ALL); consumeGrid(); return r; },
  gridGet() { return grid.map(s => (s ? { id: s.id, count: s.count } : null)); },
  consumeSelected(n = 1) {
    const s = slots[selected];
    if (!s) return 0;
    if (isCreative()) return Math.min(n, s.count); // creative: infinite blocks
    const m = Math.min(n, s.count);
    s.count -= m;
    if (s.count <= 0) slots[selected] = null;
    renderAll(); emitChange();
    return m;
  },
  clear() {
    slots.fill(null); cursor = null; grid = grid.map(() => null); result = null; pay = [null, null];
    renderAll(); emitChange();
  },
  isOpen() { return open_; },
  // mode: "inventory" (creative menu in creative mode) | "crafting" | "furnace" / "chest" (pos = {x,y,z} of the block) | "creative"
  open(m = "inventory", pos) {
    if (!backEl) return;
    if (m === "furnace") { furnace = furnaceAt(pos); openScreen("furnace"); return; }
    if (m === "chest" && pos) { if (open_) closeScreen(true); chest = chestAt(pos); openScreen("chest"); return; }
    if (m === "creative" || (m === "inventory" && isCreative())) { openScreen("creative"); return; }
    openScreen(m === "crafting" ? "crafting" : "inventory");
  },
  // Villager trade screen. Offers live on the mob: villager.trades / level / xp (generated on first open).
  openTrade(v) {
    if (!backEl || !v) return;
    if (open_) closeScreen(true);
    ensureTrades(v);
    BF.trades.restock(v);
    if (BF.prices) BF.prices.tick(v);   // prices follow demand (js/prices.js)
    villager = v; offerSel = -1; pay = [null, null]; levelFlashT = 0;
    recomputeTrade();
    openScreen("trade");
    try { if (v.position && BF.mobs && BF.mobs.setTrading) BF.mobs.setTrading(v, true); } catch (e) { console.error(e); }
  },
  ensureTrades,
  close() { closeScreen(false); },
  furnaceState(x, y, z) { return furnaces.get(`${x},${y},${z}`) || null; },
  furnaceRecord(x, y, z) { return furnaceAt({ x, y, z }); },   // creates the furnace's state when it has none yet (villagers: js/toolsmith.js)
  // One simulation step for every furnace (main.js runs it with the world, so it follows the fast-forward).
  simTick(h) { for (const f of furnaces.values()) if (tickFurnace(f, h) && f === furnace) furnaceDirty = true; },
  chestState(x, y, z) { return chests.get(`${x},${y},${z}`) || null; },
  // Puts items into the chest at x,y,z (creating its contents); returns how many did not fit. For villagers, commands and tests.
  chestAdd(x, y, z, itemId, count = 1) {
    if (!BF.items[itemId] || itemId === 0 || !(count > 0)) return count || 0;
    const left = addToArr(chestAt({ x, y, z }).slots, itemId, Math.floor(count));
    if (open_ && chest && chest.key === `${x},${y},${z}`) renderAll();
    return left;
  },
  // Takes up to n of itemId out of the chest at x,y,z (last slots first); returns how many came out. For villagers and tests.
  chestTake(x, y, z, itemId, n = 1) {
    const c = chests.get(`${x},${y},${z}`);
    if (!c) return 0;
    let got = 0;
    for (let i = CHEST_SIZE - 1; i >= 0 && got < n; i--) {
      const s = c.slots[i];
      if (!s || s.id !== itemId) continue;
      const m = Math.min(n - got, s.count); s.count -= m; got += m;
      if (s.count <= 0) c.slots[i] = null;
    }
    if (open_ && chest === c) renderAll();
    return got;
  },
  // Ownership (see "chests" above). chestUsed(x, y, z, owner, name, mob): call after changing a chest's contents for someone.
  chestUsed(x, y, z, owner, name, mob) { const c = chests.get(`${x},${y},${z}`); return c ? chestUsed(c, owner, name, mob) : false; },
  chestRelease,
  chestEmpty,
  chestRecord(x, y, z) { return chestAt({ x, y, z }); },   // creates the (empty, unowned) record of a chest that was never used
  ownerLabel,
  chestRemoved,
  furnaceRemoved,

  serialize() {
    return {
      v: 1,
      slots: slots.map(toSave),
      selected,
      furnaces: [...furnaces.values()].filter(f => f.pos).map(f => ({
        pos: [f.pos.x, f.pos.y, f.pos.z], slots: f.slots.map(toSave), burn: f.burn, burnMax: f.burnMax, cook: f.cook,
      })),
      chests: [...chests.values()].filter(c => c.slots.some(Boolean) || c.owner).map(c => ({ pos: [c.pos.x, c.pos.y, c.pos.z], slots: c.slots.map(toSave),
        owner: c.owner || undefined, on: c.owner ? c.ownerName : undefined, es: c.emptySince != null ? +c.emptySince.toFixed(4) : undefined })),
    };
  },
  deserialize(o) {
    if (!o || typeof o !== "object") return;
    if (open_) closeScreen(true);
    slots.fill(null);
    if (Array.isArray(o.slots)) o.slots.slice(0, SIZE).forEach((s, i) => { slots[i] = fromSave(s); });
    furnaces.clear();
    if (Array.isArray(o.furnaces)) for (const fs of o.furnaces) {
      if (!fs || !Array.isArray(fs.pos)) continue;
      const f = furnaceAt({ x: fs.pos[0], y: fs.pos[1], z: fs.pos[2] });
      f.slots = [0, 1, 2].map(k => fromSave(fs.slots && fs.slots[k]));
      f.burn = +fs.burn || 0; f.burnMax = +fs.burnMax || 0; f.cook = +fs.cook || 0;
    }
    chests.clear();
    if (Array.isArray(o.chests)) for (const cs of o.chests) {
      if (!cs || !Array.isArray(cs.pos)) continue;
      const c = chestAt({ x: cs.pos[0], y: cs.pos[1], z: cs.pos[2] });
      for (let k = 0; k < CHEST_SIZE; k++) c.slots[k] = fromSave(cs.slots && cs.slots[k]);
      if (typeof cs.owner === "string" && cs.owner) { c.owner = cs.owner; c.ownerName = typeof cs.on === "string" ? cs.on : ""; c.emptySince = Number.isFinite(cs.es) ? cs.es : null; }
    }
    selected = 0;
    api.select(+o.selected || 0);
    renderAll(); emitChange();
  },
};
BF.inventory = api;
})();
