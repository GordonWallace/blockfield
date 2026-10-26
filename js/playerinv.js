// The player's items and every screen's state, on the simulation's side (spec r15-44, split from the old js/inventory.js): the 36 slots
// (9 hotbar + 27 main), the crafting grid and its result, the stack held by the pointer (cursor), the trade payment slots and chosen
// offer, the chests and furnaces of the world, recipes, smelting and fuel, and which screen is open (mode, target). No DOM: it runs in
// the page, in the simulation worker (r15-38) and headless. The page's side, js/invscreen.js, draws the hotbar and the screens from
// the protocol's self messages (inv, cursor, screen) and its chest, trades and furnace queries, and sends every click, drag, offer,
// trash, open and close as a player request (js/requests.js), which the handlers below apply. Toasts, the trade screen's level-up and
// the hotbar's item name come back as protocol events (BF.emit "invToast", "villagerLevelUp", "invFlashName").
// Game log: WARN "inventory" when a screen request is refused (no such screen, the chest, furnace or villager is gone).
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const HOTBAR = 9, SIZE = 36, COOK_TIME = 10;
const slots = new Array(SIZE).fill(null);    // {id, count} | null; 0..8 hotbar, 9..35 main
let grid = [], gw = 2;                        // crafting grid (gw x gw)
let result = null;                            // current crafting output
let cursor = null;                            // stack held by the pointer
let open_ = false, mode = "inventory";
let selected = 0;                             // the hotbar slot: the page's choice (its player messages and each request's data.slot)
let furnace = null;                           // furnace state shown on the furnace screen
let chest = null;                             // chest state shown on the chest screen
let villager = null, pay = [null, null], offerSel = -1, tradeOffer = null, tradeResult = null;

const stackOf = id => (BF.items[id] && BF.items[id].stack) || 64;
// a toast (+n of an item) at the page, through the protocol's events
const showToast = (id, n) => { if (n > 0 && BF.emit) BF.emit("invToast", id, n); };
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
// Takes up to n of id as one stack (main first, then hotbar), wear included: only stacks with the same wear as the first one
// found (or as `wear`, when given) are taken together. Returns the stack, or null.
function takeStack(id, n, wear) {
  let got = 0;
  for (let i = SIZE - 1; i >= 0 && got < n; i--) {
    const s = slots[i];
    if (!s || s.id !== id) continue;
    if (wear === undefined) wear = s.wear || 0; else if ((s.wear || 0) !== wear) continue;
    const m = Math.min(s.count, n - got);
    s.count -= m; got += m;
    if (s.count <= 0) slots[i] = null;
  }
  return got ? mk(id, got, wear) : null;
}
function giveBack(stack) { // into inventory; what doesn't fit drops in front of the player
  if (!stack) return;
  const left = addTo(stack.id, stack.count, ORDER_ALL, stack.wear);
  if (left > 0) dropOverflow(stack.id, left, stack.wear);
}
function dropOverflow(id, n, wear) {
  if (BF.drops && BF.drops.atPlayer && BF.drops.atPlayer(id, n, wear)) return;
  BF.emit && BF.emit("itemDropped", id, n);
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
  const r = reservedFor(c);
  if (r && r.key !== owner) return false;   // paid for by a villager (bug-037): stays theirs to claim
  c.owner = owner; c.ownerName = name || ""; c.emptySince = chestEmpty(c) ? dayNow() : null; c.reserved = null;
  BF.emit && BF.emit("chestClaimed", c, mob || null);
  return true;
}
// A furniture maker just delivered this unowned chest to the villager who paid for it: {key, until, name} until that runs out, else null.
const reservedFor = c => (c && !c.owner && c.reserved && c.reserved.until > dayNow() ? c.reserved : null);
// The chest is free again (why: "empty" | "owner died" | ...).
function chestRelease(c, why) {
  if (!c || !c.owner) return false;
  const was = { owner: c.owner, name: c.ownerName };
  c.owner = null; c.ownerName = ""; c.emptySince = null;
  BF.emit && BF.emit("chestReleased", c, why, was);
  return true;
}
// Survival: the chest on screen belongs to someone else (or was just paid for by a villager), so it can be looked at but not changed.
const chestLocked = () => mode === "chest" && !!chest && ((!!chest.owner && chest.owner !== "player") || !!reservedFor(chest)) && !isCreative();
// After every player action on the chest screen: did the contents change? (claims an unowned chest for the player)
function chestCheck() {
  if (!open_ || mode !== "chest" || !chest) return;
  const sig = chestSig(chest);
  if (sig === chest.sig) return;
  chestUsed(chest, "player", "you");
}
// Who owns the chest, as shown on its screen.
function ownerLabel(c) {
  const r = reservedFor(c);
  if (r) return "Reserved for " + (r.name || "a villager");
  if (!c || !c.owner) return "Unclaimed";
  if (c.owner === "player") return "Yours";
  let job = "";
  if (BF.mobs && BF.regions) {   // (the owner's village's own villagers, r15-32)
    const i = c.owner.lastIndexOf("#"), o = i > 0 ? BF.regions.villageMobs(BF.mobs.villages.get(c.owner.slice(0, i)), m => m.type === "villager" && !m.dead && m.slot && m.village.key + "#" + m.slot.idx === c.owner)[0] : null;
    if (o) job = o.profession;
  }
  const pretty = s => String(s).replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
  return "Owned by " + (c.ownerName || "a villager") + (job ? " (" + pretty(job) + ")" : "");
}
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
// fill arr with `stack`: top up matching stacks first, then empty slots; returns what is left
// wear: a worn tool keeps it and never merges (as addTo).
function addToArr(arr, id, count, wear) {
  const max = stackOf(id);
  for (const s of arr) if (count > 0 && s && s.id === id && s.count < max && !(wear > 0) && !(s.wear > 0)) { const m = Math.min(max - s.count, count); s.count += m; count -= m; }
  for (let i = 0; i < arr.length && count > 0; i++) if (!arr[i]) { const m = Math.min(max, count); arr[i] = mk(id, m, wear); count -= m; }
  return count;
}
// The chest block at x,y,z is gone (broken, exploded, replaced): close its screen and spill what it held on the ground.
function chestRemoved(x, y, z) {
  const key = `${x},${y},${z}`, c = chests.get(key);
  if (!c) return;
  if (chest === c) closeScreen();
  chests.delete(key);
  if (c.owner && BF.emit) BF.emit("chestBroken", c);
  for (const s of c.slots) {
    if (!s) continue;
    if (BF.drops && BF.drops.spawn) BF.drops.spawn(s.id, s.count, x + 0.5, y + 0.4, z + 0.5, s.wear > 0 ? { wear: s.wear } : undefined);
    else { const left = addTo(s.id, s.count, ORDER_ALL, s.wear); if (left) dropOverflow(s.id, left, s.wear); }
  }
  emitChange();
}

// The furnace block at x,y,z is gone (world.js calls furnaceRemoved from setBlock): close its screen, stop it cooking and empty it.
// Mined by the player, the contents go to the inventory: player.js emits blockBroken straight after setBlock, in the same task, and
// that claims them. Removed any other way (explosion, /setblock, /fill) they drop on the ground a microtask later. The record leaves
// the furnace map at once, so a furnace placed in the cell again starts empty.
const removedFurnaces = new Map();   // "x,y,z" -> furnace state waiting to be emptied
function furnaceRemoved(x, y, z) {
  const key = `${x},${y},${z}`, f = furnaces.get(key);
  if (!f) return;
  if (furnace === f) closeScreen();
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
    const w = s.wear > 0 ? { wear: s.wear } : undefined;   // a worn wooden tool used as fuel keeps its wear
    if (!toPlayer && BF.drops && BF.drops.spawn) { BF.drops.spawn(s.id, s.count, x + 0.5, y + 0.4, z + 0.5, w); continue; }
    const left = addTo(s.id, s.count, ORDER_ALL, s.wear); if (left < s.count) showToast(s.id, s.count - left);
    if (left) { if (BF.drops && BF.drops.spawn) BF.drops.spawn(s.id, left, x + 0.5, y + 0.4, z + 0.5, w); else BF.emit("itemDropped", s.id, left); }   // no room: drops where the furnace stood
  }
  emitChange();
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
    tradeResult = mk(tradeOffer.sell.id, tradeOffer.sell.n, BF.trades.inv.bestWear(villager.inv, tradeOffer.sell.id));   // a worn tool is sold worn
    return;
  }
}
function autoFill(o) { // return payment to the inventory, then pull this offer's costs from it
  for (let k = 0; k < 2; k++) { giveBack(pay[k]); pay[k] = null; }
  o.buy.forEach((b, k) => { pay[k] = takeStack(b.id, stackOf(b.id)); });
}
function topUp(o) { // after a trade, refill the payment slots from the inventory
  o.buy.forEach((b, k) => {
    let i = pay.findIndex(s => s && s.id === b.id);
    if (i < 0) { i = pay.findIndex(s => !s); if (i < 0) return; }
    const have = pay[i] ? pay[i].count : 0, want = stackOf(b.id) - have;
    const got = want > 0 ? takeStack(b.id, want, pay[i] ? pay[i].wear || 0 : undefined) : null;
    if (got) pay[i] = mk(b.id, have + got.count, got.wear);
  });
}
// One lot of o as a transaction (js/trading.js playerBuy, spec r15-21): the payment leaves its slots, the goods come back, or the
// payment does when the villager refuses.
function performTrade(o) {
  const idx = offerFits(o);
  if (!idx) return [];
  const given = o.buy.map((b, k) => mk(b.id, b.n, pay[idx[k]].wear || 0));
  o.buy.forEach((b, k) => { const s = pay[idx[k]]; s.count -= b.n; if (s.count <= 0) pay[idx[k]] = null; });
  const r = BF.trades.playerBuy(villager, o, given);
  for (const s of r.left) giveBack(s);
  if (!r.done) return [];
  if (r.levels) { BF.emit("villagerLevelUp", villager, villager.level); }
  BF.emit("villagerTrade", villager, o);
  if (BF.prices) BF.prices.filled(villager, o, 1);
  return r.sold;
}
function clickTrade(shift) {
  if (!tradeOffer) return;
  const o = tradeOffer, out = o.sell;
  if (o.horse) { performTrade(o); topUp(o); recomputeTrade(); return; }   // a stable's horse (js/stables.js): it walks out to the player, nothing goes into a slot
  if (shift) {
    let got = 0;
    for (let g = 0; g < 64 && tradeOffer === o; g++) {
      if (!fits(out.id, out.n)) break;
      for (const st of performTrade(o)) addTo(st.id, st.count, ORDER_ALL, st.wear);
      got += out.n;
      topUp(o); recomputeTrade();
    }
    if (got) showToast(out.id, got);
    return;
  }
  const w = BF.trades.inv.bestWear(villager.inv, out.id);
  if (cursor && (cursor.id !== out.id || cursor.count + out.n > stackOf(out.id) || w > 0 || cursor.wear > 0)) return;
  performTrade(o);
  if (cursor) cursor.count += out.n; else cursor = mk(out.id, out.n, w);
  topUp(o); recomputeTrade();
}

// ---------------------------------------------------------------- what the screens hold, by container and index
// Containers: "inv" (the 36 slots), "grid" (crafting), "result", "furn" (input, fuel, output), "chest", "pay" (trade payment), "tres" (the
// trade's result), "vinv" (the villager's inventory, creative only), "pal" (a creative palette item: i is its id), "trash".
const vinvEditable = () => isCreative() && !!(villager && villager.inv);   // creative mode: the villager's inventory can be edited
function arrFor(c) {
  if (c === "vinv") return vinvEditable() ? villager.inv : null;
  return c === "inv" ? slots : c === "grid" ? grid : c === "furn" ? (furnace && furnace.slots) : c === "chest" ? (chest && chest.slots) : c === "pay" ? pay : null;
}
function stackIn(c, i) {
  if (c === "result") return result;
  if (c === "tres") return tradeResult;
  if (c === "pal") return { id: i, count: 1 };
  if (c === "trash") return null;
  const arr = arrFor(c);
  return arr ? arr[i] : null;
}

// ---------------------------------------------------------------- drag splitting
// d.els: the slots dragged over as [container, index] pairs (a request's data); the page draws the same plan while the drag goes on.
// The page only offers slots its canDrop() accepts, but its copy of the slots can be a round trip behind (a shift-click just moved a
// stack there), so the sim checks each slot again against its own slots and splits the cursor over the ones that still take it.
function canDrop(c, i) {
  if (!cursor) return false;
  if (!(c === "inv" || c === "grid" || c === "pay" || (c === "chest" && !chestLocked()) || (c === "vinv" && vinvEditable()) || (c === "furn" && (i === 0 || (i === 1 && FUEL.has(cursor.id)))))) return false;
  const arr = arrFor(c);
  if (!arr || !Number.isInteger(i) || i < 0 || i >= arr.length) return false;
  const s = arr[i];
  return !s || (s.id === cursor.id && s.count < stackOf(s.id));
}
function dragSlots(d) {
  const seen = new Set(), els = [];
  for (const el of d.els) {
    if (!Array.isArray(el)) continue;
    const key = el[0] + ":" + el[1];
    if (seen.has(key) || !canDrop(el[0], el[1])) continue;
    seen.add(key); els.push(el);
  }
  return els;
}
function dragPlan(d) {
  const add = new Map();
  let left = cursor.count;
  const per = d.button === 0 ? Math.floor(cursor.count / d.els.length) : 1;
  for (const el of d.els) {
    const [c, i] = el, s = stackIn(c, i), room = stackOf(cursor.id) - (s ? s.count : 0);
    const m = Math.max(0, Math.min(per, room, left));
    add.set(el, m); left -= m;
  }
  return { add, left };
}
function applyDrag(d) {
  if (!cursor || !d || !Array.isArray(d.els)) return;
  const els = dragSlots(d);
  if (els.length < d.els.length && BF.glog) BF.glog.log("INFO", "inventory", "A drag over " + d.els.length + " slots was split over the " + els.length + " that still take the held " + BF.items[cursor.id].name);
  if (!els.length) return;
  const { add, left } = dragPlan({ els, button: d.button }), id = cursor.id;
  for (const [el, m] of add) {
    if (!m) continue;
    const [c, i] = el, arr = arrFor(c);
    if (arr[i]) arr[i].count += m; else arr[i] = mk(id, m, cursor.wear);
  }
  cursor.count = left;
  if (cursor.count <= 0) cursor = null;
  recompute(); recomputeTrade();
}

// ---------------------------------------------------------------- slot interactions
function clickSlot(c, i, button, shift, tab) {   // tab: the creative menu's tab, as the page shows it
  if (c === "vinv" && !vinvEditable()) return;
  if (c === "chest" && chestLocked()) return;
  if (c === "result") clickResult(shift);
  else if (c === "tres") clickTrade(shift);
  else if (c === "pal") clickPalette(i, button, shift);
  else if (c === "trash") {
    if (cursor && button === 2) { if (--cursor.count <= 0) cursor = null; }   // right-click: destroy one
    else if (cursor) cursor = null;
    else if (shift) for (let k = 0, n = tab === "inventory" ? SIZE : HOTBAR; k < n; k++) slots[k] = null;   // the slots you can see
  }
  else if (c === "furn" && i === 2) takeOutput(button, shift);
  else if (shift && button === 0) shiftMove(c, i, tab);
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
  emitChange();
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
function shiftMove(c, i, tab) {
  if (c === "inv") {
    const s = slots[i]; if (!s) return;
    if (mode === "creative") { if (tab !== "inventory") return; }
    let st = mk(s.id, s.count, s.wear);
    if (mode === "furnace" && furnace) {
      const target = SMELT.has(s.id) ? 0 : FUEL.has(s.id) ? 1 : -1;
      if (target >= 0) st.count = mergeInto(furnace.slots, target, st);
    } else if (mode === "chest" && chest && !chestLocked()) {
      st.count = addToArr(chest.slots, s.id, s.count, s.wear);
    } else if (mode === "trade" && villager) {
      const o = villager.trades[offerSel];
      const wanted = o ? o.buy.map(b => b.id) : villager.trades.flatMap(t => t.buy.map(b => b.id));
      if (wanted.includes(s.id)) {
        let k = pay.findIndex(p => p && p.id === s.id);
        if (k < 0 && o) { const bi = o.buy.findIndex(b => b.id === s.id); if (!pay[bi]) k = bi; }
        if (k < 0) k = pay.findIndex(p => !p);
        if (k >= 0) st.count = mergeInto(pay, k, st);
        recomputeTrade();
      } else if (vinvEditable()) st.count = BF.trades.inv.add(villager.inv, st.id, st.count, st.wear);   // creative: shift-click gives it to the villager
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
function trash(d) {   // i: the inventory slot to empty, or -1 for the held stack
  if (d.i < 0) cursor = null; else slots[d.i] = null;
  emitChange();
}
function chooseOffer(i) {
  if (!villager || !villager.trades[i]) return;
  offerSel = i;
  autoFill(villager.trades[i]);
  recomputeTrade();
  if (!tradeOffer) offerSel = i;
  emitChange();
}

// ---------------------------------------------------------------- open / close
// The screen's state opens here; the page shows it (js/invscreen.js). Closing gives the grid, the payment and the cursor back to the
// inventory, and drops what doesn't fit in front of the player.
function openScreen(m) {
  if (open_) closeScreen();
  mode = m;
  gw = m === "crafting" ? 3 : 2;
  grid = new Array(gw * gw).fill(null);
  recompute();
  open_ = true;
  if (m === "chest" && chest) { chest.sig = chestSig(chest); BF.emit && BF.emit("chestOpened", chest.pos.x, chest.pos.y, chest.pos.z); }
  emitChange();
}
function closeScreen() {
  if (!open_) return;
  open_ = false;
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
  emitChange();
}
function openFor(m, pos) {
  if (m === "furnace") { if (open_) closeScreen(); furnace = furnaceAt(pos); openScreen("furnace"); return; }
  if (m === "chest" && pos) { if (open_) closeScreen(); chest = chestAt(pos); openScreen("chest"); return; }
  if (m === "creative" || (m === "inventory" && isCreative())) { openScreen("creative"); return; }
  openScreen(m === "crafting" ? "crafting" : "inventory");
}
function openTrade(v) {
  if (open_) closeScreen();
  ensureTrades(v);
  BF.trades.restock(v);
  if (BF.prices) BF.prices.tick(v);   // prices follow demand (js/prices.js)
  villager = v; offerSel = -1; pay = [null, null];
  recomputeTrade();
  openScreen("trade");
  try { if (v.position && BF.mobs && BF.mobs.setTrading) BF.mobs.setTrading(v, true); } catch (e) { console.error(e); }
}
// The open screen as the protocol's self message carries it (js/protocol.js): null when closed, else {mode, target ({x, y, z} of a chest
// or furnace, {id} of a villager, null), grid, result, pay, offer (the chosen offer's index), tradeResult}.
const copyStack = s => (s ? (s.wear > 0 ? { id: s.id, count: s.count, wear: s.wear } : { id: s.id, count: s.count }) : null);
function screenView() {
  if (!open_) return null;
  const target = mode === "chest" && chest ? Object.assign({}, chest.pos) : mode === "furnace" && furnace ? (furnace.pos ? Object.assign({}, furnace.pos) : null)
    : mode === "trade" && villager ? { id: BF.ids ? BF.ids.idOf(villager) : null } : null;
  return { mode, target, grid: grid.map(copyStack), result: copyStack(result), pay: pay.map(copyStack), offer: offerSel, tradeResult: copyStack(tradeResult) };
}

// ---------------------------------------------------------------- the player's screen actions as requests (spec r15-20)
// Opening and closing a screen, slot clicks, drags, choosing an offer and the trash key move items between the player, the crafting
// grid, chests, furnaces and villagers (trades): each is a request from the player (js/requests.js player()), naming its slots by
// container and index so a recorded session replays them. The page sends them (js/invscreen.js); in the page they apply at once, in a
// worker or on a server when they arrive. While a screen is open the game is paused, so all of a screen's requests share one tick boundary.
// Refused (WARN "inventory" in the game log): a screen that doesn't exist, a chest or furnace whose block is gone, a villager who is gone.
const refuse = (what, why) => { if (BF.glog) BF.glog.log("WARN", "inventory", "The " + what + " screen was refused: " + why); return { ok: false, why: why === "no such screen" ? "unknown" : "gone" }; };
const SCREENS = ["inventory", "crafting", "furnace", "chest", "creative"];
const blockThere = (pos, test) => { const W = BF.world; if (!W || !pos) return true; const id = W.getBlock(pos.x, pos.y, pos.z); return id == null || test(id); };   // (unloaded: allowed)
// The trade screen, opened by the simulation (js/mobs.js interact, within the player's request): a nested player.screen request.
function act(kind, data) {
  if (BF.req && BF.req.player) BF.req.player(kind, null, data);
  else if (HANDLERS[kind]) HANDLERS[kind](data);
}
const HANDLERS = {
  "player.screen"(d) {
    if (d.close) { closeScreen(); return; }
    if (d.trade != null) {
      const v = BF.ids && BF.ids.get(d.trade);
      if (!v || v.dead || v.removed) return refuse("trade", "the villager is gone");
      openTrade(v); return;
    }
    const m = d.open || "inventory";
    if (!SCREENS.includes(m)) return refuse(String(m), "no such screen");
    if (m === "chest" && d.pos && !blockThere(d.pos, BF.isChest)) return refuse("chest", "the chest at " + [d.pos.x, d.pos.y, d.pos.z].join(" ") + " is gone");
    if (m === "furnace" && d.pos && !blockThere(d.pos, BF.isFurnace)) return refuse("furnace", "the furnace at " + [d.pos.x, d.pos.y, d.pos.z].join(" ") + " is gone");
    openFor(m, d.pos);
  },
  "player.click"(d) { clickSlot(d.c, d.i, d.button, d.shift, d.tab); },
  "player.drag"(d) { applyDrag(d); emitChange(); },
  "player.offer"(d) { chooseOffer(d.i); },
  "player.trash"(d) { trash(d); },
};
if (BF.req) for (const k in HANDLERS) BF.req.on(k, req => HANDLERS[k](req.data || {}) || { ok: true });

// ---------------------------------------------------------------- what the chest, trade and furnace screens show (specs r15-37, r15-44)
// The answers to the protocol's "chest", "trades" and "furnace" queries, worked out here on the simulation's side.
function chestView(a) {
  const key = `${a.x},${a.y},${a.z}`, c = chests.get(key);
  if (!BF.isChest(BF.world.getBlock(a.x, a.y, a.z))) return { ok: false, why: "gone" };
  const slots = c ? c.slots.map(copyStack) : new Array(CHEST_SIZE).fill(null);
  return { ok: true, key, slots, label: ownerLabel(c || null), locked: !!c && ((!!c.owner && c.owner !== "player") || !!reservedFor(c)) && !isCreative() };
}
function tradeView(a) {
  const v = a.id != null && BF.ids ? BF.ids.get(a.id) : null;
  if (!v || v.dead || v.removed || !v.trades) return { ok: false, why: "gone" };
  return { ok: true, id: a.id, level: v.level || 1, xp: v.xp || 0, profession: v.profession || null,
    name: BF.vlog ? BF.vlog.nameOf(v) : "", status: BF.villagerStatus ? BF.villagerStatus.text(v) : "",
    inv: v.inv ? v.inv.map(copyStack) : null, editable: isCreative() && !!v.inv,
    trades: v.trades.map(o => ({ buy: o.buy.map(b => ({ id: b.id, n: b.n })), sell: { id: o.sell.id, n: o.sell.n }, reason: BF.trades.blockReason(v, o) || null,
      stock: v.inv ? BF.trades.inv.count(v.inv, o.sell.id) : 0, spare: !!o.spare, need: !!o.need, feed: !!o.feed, off: o.off || null, note: o.note || null })) };   // off: set aside (js/market.js oneSide)
}
// a furnace ({x, y, z}, or {} for the open screen's): its slots, how much of the fuel's burn is left, and the item's cooking time; can:
// whether it can smelt what is on top now. Gone when the block is.
function furnaceView(a) {
  const f = a && a.x != null ? furnaces.get(`${a.x},${a.y},${a.z}`) || (BF.isFurnace(BF.world.getBlock(a.x, a.y, a.z)) ? furnaceAt(a) : null) : furnace;
  if (!f || (f.pos && !BF.isFurnace(BF.world.getBlock(f.pos.x, f.pos.y, f.pos.z)))) return { ok: false, why: "gone" };
  return { ok: true, slots: f.slots.map(copyStack), burn: f.burn, burnMax: f.burnMax, cook: f.cook, can: canSmelt(f) };
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
let inited = false;
const api = {
  get selectedIndex() { return selected; },
  set selectedIndex(i) { api.select(i); },
  get mode() { return open_ ? mode : null; },
  get cursor() { return cursor; },
  slots,            // read-only view for other modules (0..8 hotbar)
  recipes: RECIPES,
  smelting: SMELT,  // input id -> output id
  smeltList: SMELT_LIST,   // [{ins, out}] and [{label, secs}]: the recipe book's lists (js/invscreen.js)
  fuelList: FUEL_LIST,
  fuel: FUEL,       // item id -> burn seconds
  COOK_TIME,        // seconds one item takes in a furnace
  furnaces,         // "x,y,z" -> furnace state
  chests,           // "x,y,z" -> chest contents {pos, slots[27]}
  CHEST_SIZE,
  SIZE, HOTBAR,
  VILLAGER_SLOTS: BF.trades.SLOTS,   // a villager's inventory slots (the trade screen)
  trades: TRADES,
  levelNames: LEVELS,
  levelXP: LEVEL_XP,
  isCreative,
  // The recipes and fuels, and the hooks: a new world empties everything, a furnace the player mines gives its contents to the
  // inventory. Once, wherever the simulation runs (js/boot.js headless and in the worker; js/invscreen.js init in the page).
  initSim() {
    if (inited) return;
    inited = true;
    buildRecipes();
    if (!BF.on) return;
    BF.on("newWorld", () => { closeScreen(); api.clear(); api.select(0); furnaces.clear(); removedFurnaces.clear(); chests.clear(); });
    BF.on("blockBroken", (x, y, z, id) => { if (BF.isFurnace(id)) { furnaceRemoved(x, y, z); furnaceEmpty(`${x},${y},${z}`, true); } });
  },
  init() { api.initSim(); },
  // Each real frame, wherever the simulation runs (js/main.js in the page, the worker's loop): a furnace cooks in real time while its
  // screen is open in the pause (otherwise furnaces cook in game time, simTick), and the trade screen closes when its villager is gone.
  simFrame(dt) {
    if (!open_) return;
    if (BF.state && BF.state.paused && mode === "furnace" && furnace && tickFurnace(furnace, dt)) emitChange();
    if (mode === "trade" && villager && (villager.dead || villager.removed)) {
      if (BF.glog) BF.glog.log("INFO", "inventory", "The trade screen closed: the villager is gone");
      closeScreen();
    }
  },
  dropOverflow(itemId, count, wear) { dropOverflow(itemId, count, wear); },   // items with no room: dropped in front of the player
  add(itemId, count = 1, wear = 0) {   // wear: uses already spent on a tool (a worn tool picked up again)
    if (itemId === undefined || itemId === null || itemId === 0 || !BF.items[itemId] || !(count > 0)) return count || 0;
    const left = addTo(itemId, count, ORDER_ALL, wear);
    if (left !== count) { showToast(itemId, count - left); emitChange(); }
    return left;
  },
  remove(itemId, count = 1) {
    const removed = takeFromInv(itemId, count);
    if (removed) { emitChange(); }
    return removed;
  },
  // Direct slot write (creative pick-block). stack = {id, count} | null
  setSlot(i, stack) {
    if (!(i >= 0 && i < SIZE)) return;
    slots[i] = stack && BF.items[stack.id] && stack.id !== 0 && stack.count > 0
      ? mk(stack.id, Math.min(Math.floor(stack.count), stackOf(stack.id)), stack.wear) : null;
    emitChange();
    if (i === selected && BF.emit) BF.emit("invFlashName");   // the page shows the item's name over the hotbar
  },
  count(itemId) { let n = 0; for (const s of slots) if (s && s.id === itemId) n += s.count; return n; },
  selected() { return slots[selected]; },
  select(i) {
    i = ((Math.floor(i) % HOTBAR) + HOTBAR) % HOTBAR;
    const changed = i !== selected;
    selected = i;
    if (changed) BF.emit && BF.emit("selectChanged", i);   // (the page's hotbar and item name, js/invscreen.js)
  },
  // Wears the selected tool by n uses (survival only). When it is used up it breaks: the slot empties and "toolBroken" is emitted.
  // Returns "broken", true (worn) or false (not a tool with a lifespan, or creative).
  wearSelected(n = 1) {
    const s = slots[selected];
    if (!s || isCreative()) return false;
    const r = BF.wearStack(s, n);
    if (r === "broken") { slots[selected] = null; BF.emit && BF.emit("toolBroken", s.id); }
    if (r) emitChange();
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
    emitChange();
    return m;
  },
  clear() {
    slots.fill(null); cursor = null; grid = grid.map(() => null); result = null; pay = [null, null];
    emitChange();
  },
  isOpen() { return open_; },
  // Opening and closing a screen as the simulation's own player requests (the trade screen: js/mobs.js interact; tests). The page's
  // js/invscreen.js puts its own open, openTrade and close in their place: they show the screen and send the same requests.
  // mode: "inventory" (creative menu in creative mode) | "crafting" | "furnace" / "chest" (pos = {x,y,z} of the block) | "creative"
  open(m = "inventory", pos) { act("player.screen", { open: m, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null }); },
  // Villager trade screen. Offers live on the mob: villager.trades / level / xp (generated on first open).
  openTrade(v) { if (v) act("player.screen", { trade: BF.ids ? BF.ids.idOf(v) : null }); },
  ensureTrades,
  close() { act("player.screen", { close: true }); },
  furnaceState(x, y, z) { return furnaces.get(`${x},${y},${z}`) || null; },
  furnaceRecord(x, y, z) { return furnaceAt({ x, y, z }); },   // creates the furnace's state when it has none yet (villagers: js/toolsmith.js)
  // One simulation step for every furnace (main.js runs it with the world, so it follows the fast-forward).
  // During a tick's think (BF.simStep) the step waits for the block-tick phase (spec r15-22), after the tick's "chest" and "furnace"
  // requests have applied, so loading and emptying come first in a fixed order; called outside a tick (tests) it runs at once.
  simTick(h) {
    if (BF.req && BF.req.phase === "think" && BF.world.onBlockTick) { furnaceDue += h; return; }
    furnaceStep(h);
  },
  chestState(x, y, z) { return chests.get(`${x},${y},${z}`) || null; },
  // r15-37, r15-44: the answers to the protocol's "chest" ({x, y, z}), "trades" ({id}) and "furnace" ({x, y, z}) queries, worked out here
  chestView, tradeView, furnaceView,
  // r15-44: the open screen and the held stack as self messages carry them (js/protocol.js)
  screenView, cursorView: () => copyStack(cursor),
  // Puts items into the chest at x,y,z (creating its contents); returns how many did not fit. For villagers, commands and tests.
  chestAdd(x, y, z, itemId, count = 1, wear = 0) {   // wear: uses spent on a worn tool
    if (!BF.items[itemId] || itemId === 0 || !(count > 0)) return count || 0;
    return addToArr(chestAt({ x, y, z }).slots, itemId, Math.floor(count), wear);
  },
  // Takes up to n of itemId out of the chest at x,y,z (last slots first); returns how many came out. For villagers and tests.
  chestTake(x, y, z, itemId, n = 1) { let got = 0; for (const s of this.chestTakeStacks(x, y, z, itemId, n)) got += s.count; return got; },
  // The same, returning what came out as stacks with their wear ([{id, count, wear?}]).
  chestTakeStacks(x, y, z, itemId, n = 1) {
    const c = chests.get(`${x},${y},${z}`);
    if (!c) return [];
    return BF.trades.inv.take(c.slots, itemId, n);
  },
  // Ownership (see "chests" above). chestUsed(x, y, z, owner, name, mob): call after changing a chest's contents for someone.
  chestUsed(x, y, z, owner, name, mob) { const c = chests.get(`${x},${y},${z}`); return c ? chestUsed(c, owner, name, mob) : false; },
  chestRelease,
  chestEmpty,
  chestRecord(x, y, z) { return chestAt({ x, y, z }); },   // creates the (empty, unowned) record of a chest that was never used
  ownerLabel,
  chestRemoved,
  furnaceRemoved,

  // The player's own slots as saved, and setting them from that: the simulation's copy sent to the page in self messages (js/protocol.js;
  // with the simulation in a worker, r15-38, the page's own copy of this module keeps them for the code that reads the held item)
  own() { return slots.map(toSave); },
  setOwn(list) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < SIZE; i++) slots[i] = fromSave(list[i]);
    emitChange();
  },
  serialize() {
    return {
      v: 1,
      slots: slots.map(toSave),
      selected,
      // items out of the inventory while a screen is open (crafting grid, trade payment, cursor): the tab can close
      // mid-screen, so they are saved and go back into the inventory on load
      held: open_ ? [...grid, ...pay, cursor].filter(Boolean).map(toSave) : undefined,
      furnaces: [...furnaces.values()].filter(f => f.pos).map(f => ({
        pos: [f.pos.x, f.pos.y, f.pos.z], slots: f.slots.map(toSave), burn: f.burn, burnMax: f.burnMax, cook: f.cook,
      })),
      chests: [...chests.values()].filter(c => c.slots.some(Boolean) || c.owner || reservedFor(c)).map(c => ({ pos: [c.pos.x, c.pos.y, c.pos.z], slots: c.slots.map(toSave),
        owner: c.owner || undefined, on: c.owner ? c.ownerName : undefined, es: c.emptySince != null ? +c.emptySince.toFixed(4) : undefined,
        rs: reservedFor(c) ? { k: c.reserved.key, u: +c.reserved.until.toFixed(4), n: c.reserved.name || "" } : undefined })),
    };
  },
  deserialize(o) {
    if (!o || typeof o !== "object") return;
    if (open_) closeScreen();
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
      else if (cs.rs && typeof cs.rs.k === "string" && Number.isFinite(cs.rs.u)) c.reserved = { key: cs.rs.k, until: cs.rs.u, name: typeof cs.rs.n === "string" ? cs.rs.n : "" };
    }
    if (Array.isArray(o.held)) for (const h of o.held) {
      const st = fromSave(h);
      if (!st) continue;
      const left = addTo(st.id, st.count, ORDER_ALL, st.wear);
      const p = BF.player && BF.player.position;
      if (left > 0 && p && BF.drops && BF.drops.spawn) BF.drops.spawn(st.id, left, p.x, p.y + 0.5, p.z, { wear: st.wear });
    }
    selected = 0;
    api.select(+o.selected || 0);
    emitChange();
  },
};
BF.inventory = api;

// ---------------------------------------------------------------- furnaces' step as a block tick (spec r15-22)
let furnaceDue = 0;
function furnaceStep(h) {
  for (const f of furnaces.values()) tickFurnace(f, h);
  if (BF.baker) BF.baker.simTick(h);   // bakers' ovens bake on the same clock (js/baker.js)
}
if (BF.world && BF.world.onBlockTick) BF.world.onBlockTick(() => { if (furnaceDue > 0) { const h = furnaceDue; furnaceDue = 0; furnaceStep(h); } });

// ---------------------------------------------------------------- "chest" requests (spec r15-22)
// Items into and out of a chest go through the request queue (js/requests.js), so two villagers, or a villager and the player, can't
// take the same stack in one tick: requests apply in requester order and each sees what the ones before it left.
// target "x,y,z", data {take: [{id, n}], put: [{id, n}], owner?, name?}, from a villager (its inventory) or "player" (the player's).
// Takes first (only what the chest holds, as far as the requester has room), then puts (only what the requester holds, as far as the
// chest has room). owner: the villager key the chest must be usable by (unowned, its own, not reserved for another), and who claims an
// unowned chest by using it (chestUsed). Result {ok, took: [{id, n}], put: [{id, n}]}, ok when anything moved; refused ({ok: false, why})
// when the chest is gone (broken in flight: its items already dropped, as for any broken chest), owned by someone else, or the requester
// is gone. The player's chest screen still edits the slots between ticks (r15-20 turns player actions into requests).
// A worn tool keeps its wear both ways.
function holderOf(from) {
  if (from === "player") return {
    add: (id, n, wear) => api.add(id, n, wear),
    take(id, n) { const out = []; let left = n; while (left > 0) { const s = takeStack(id, left); if (!s) break; out.push(s); left -= s.count; } if (out.length) { emitChange(); } return out; },
  };
  const m = from != null && BF.ids ? BF.ids.get(from) : null;
  if (!m || m.removed || m.dead || !Array.isArray(m.inv)) return null;
  const T = BF.trades.inv;
  return { add: (id, n, wear) => T.add(m.inv, id, n, wear), take: (id, n) => T.take(m.inv, id, n), mob: m };
}
api.holderOf = holderOf;
// Game log: INFO "requests" when two asked for the same chest and one lost out (it was broken first, or claimed first).
const who = from => { const m = from && from !== "player" && BF.ids ? BF.ids.get(from) : null; return from === "player" ? "The player" : m && BF.vlog ? BF.vlog.nameOf(m) : "A villager"; };
function conflict(req, what, why) { if (BF.glog) BF.glog.log("INFO", "requests", who(req.from) + "'s " + what + " at " + req.target + " was refused: " + why, { at: String(req.target).split(",").map(Number) }); }
if (BF.req) BF.req.on("chest", req => { const r = chestReq(req); if (r.why === "gone" || r.why === "owned") conflict(req, "use of a chest", r.why === "gone" ? "the chest is gone" : "someone else owns it now"); return r; });
function chestReq(req) {
  const [x, y, z] = String(req.target).split(",").map(Number), d = req.data || {};
  if (!BF.isChest(BF.world.getBlock(x, y, z))) return { ok: false, why: "gone" };
  const h = holderOf(req.from);
  if (!h) return { ok: false, why: "requester gone" };
  const c0 = chests.get(`${x},${y},${z}`);
  if (d.owner && c0 && (c0.owner ? c0.owner !== d.owner : !!(reservedFor(c0) && c0.reserved.key !== d.owner))) return { ok: false, why: "owned", owner: c0.owner || c0.reserved.key };
  if (req.from === "player" && c0 && ((c0.owner && c0.owner !== "player") || reservedFor(c0)) && !isCreative()) return { ok: false, why: "owned", owner: c0.owner || c0.reserved.key };   // as the chest screen (chestLocked)
  const c = chestAt({ x, y, z }), took = [], put = [];
  const note = (list, id, n) => { if (n <= 0) return; const e = list.find(e => e.id === id); if (e) e.n += n; else list.push({ id, n }); };
  for (const e of d.take || []) {
    if (!e || !(e.n > 0)) continue;
    for (const s of BF.trades.inv.take(c.slots, e.id, e.n)) {
      const left = h.add(s.id, s.count, s.wear);
      if (left) addToArr(c.slots, s.id, left, s.wear);   // no room: back where it was
      note(took, s.id, s.count - left);
    }
  }
  for (const e of d.put || []) {
    if (!e || !(e.n > 0)) continue;
    for (const s of h.take(e.id, e.n)) {
      const left = addToArr(c.slots, s.id, s.count, s.wear);
      if (left) h.add(s.id, left, s.wear);
      note(put, s.id, s.count - left);
    }
  }
  if (!took.length && !put.length) return { ok: false, why: "nothing", took, put };
  const owner = req.from === "player" ? "player" : d.owner;
  if (owner) chestUsed(c, owner, req.from === "player" ? "you" : d.name, h.mob);   // the first to use an unowned chest becomes its owner
  return { ok: true, took, put };
}
})();
