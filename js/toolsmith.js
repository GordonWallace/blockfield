// Toolsmiths (BF.toolsmith): the toolsmith makes the tools it sells from materials it buys from the other villagers of its village.
// Nothing appears from the daily restock any more (trading.js PRODUCE).
// - Tools: wooden, stone, iron, golden and diamond pickaxes, axes and hoes, shears and buckets, with the vanilla recipes (3 head + 2 sticks for a
//   pickaxe or an axe, 2 + 2 for a hoe, 2 iron ingots for shears, 3 for a bucket: the farmers' water). Head material: any planks, cobblestone (or cobbled deepslate), iron
//   ingots, gold ingots, diamonds. A tool whose item does not exist (golden tools before they were added) is skipped.
// - What to make: the category (pickaxe, axe, hoe, shears) it holds fewest of, so the stock stays even: it makes a tool while it holds fewer
//   than TOOL_CAP of that category in that material or better (so 2 wooden pickaxes do not stop a stone one), never past TOOL_MAX (1 of each for hoes, shears and buckets). Shears come
//   first while it has none and holds the iron for them, and the other iron tools leave 2 ingots for shears while it has none. Within a
//   category it makes the best material it can get, in CALIBER order (diamond, gold, iron, stone, wood, the order BF.toolWear ranks tools in):
//   what it holds, or what a villager of its village sells and it can pay for. It buys for the better tool even when it already holds the
//   materials for a lesser one; when a better material is sold here but not right now (the miner is out of cobblestone or down the shaft)
//   it waits up to WAIT_BETTER (6 game hours) before making the lesser tool, but only while it has one of that kind on the shelf already or the lesser tool would be wooden.
// - Crafting: at its smithing table (BF.jobs "work" state), CRAFT_SECS (2 game hours) per tool. Materials are taken when it starts; the tool
//   is finished on later visits if the day ends first (the craft in progress is saved). Sticks are cut from 2 planks when it is short.
// - Buying: it walks to the seller and trades at the seller's own offer (stock and room rules of trading.js), like the furniture maker. It
//   buys from anyone in the village except wares that seller gets from the daily restock (the armorer's ingots appear from nothing).
// - Smelting: with a furnace it can use in the village, it buys raw iron / raw gold (or the ore blocks) from the miner instead of ingots,
//   and fuel (coal, charcoal, logs, planks). At the furnace it loads the ore, burns what fuel is already in the furnace first, adds its own
//   only when that runs out, waits for the ingots and finally takes out all the fuel left in the furnace (its own or not). A furnace is
//   usable when its input and output slots are empty (or hold the same ore / ingot) and no other villager is using it.
// - No furnace: when it needs to smelt (it holds ore or a miner sells it) it buys one from a furniture maker (js/furniture.js) and puts it
//   down inside the house of its bed (BF.storage.chestSpot), or just outside it when there is no room, as close as it can.
// See CONTRACT.md "Toolsmiths".
(() => {
"use strict";
const BF = window.BF;
const TR = () => BF.trades;
const INV = () => BF.inventory;
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const dayNow = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const dayLen = () => (BF.sky && BF.sky.dayLength) || 1200;

const CRAFT_HOURS = 2;                         // one tool takes 2 game hours at the smithing table
const CRAFT_SECS = () => dayLen() * CRAFT_HOURS / 24;
const TOOL_CAP = 2;                            // it makes a tool while it holds fewer than this many of that category in that material or better
const TOOL_MAX = 4;                            // and never holds more than this many of one category (lesser ones wait to be sold)
const ONE_OF = { hoe: 1, shears: 1, bucket: 1 }; // these wear slowly or not at all and sell rarely, so it keeps just one of each
const capOf = c => ONE_OF[c] || TOOL_CAP, maxOf = c => ONE_OF[c] || TOOL_MAX;
const WAIT_BETTER = 0.25;                      // days it waits for a better material that is sold here but not right now before making a lesser tool
const CATS = ["pickaxe", "axe", "hoe", "shears", "bucket"];   // a bucket is no tool, but it is made the same way (3 iron ingots) and kept in stock like one
const CALIBER = ["diamond", "gold", "iron", "stone", "wood"];   // best first, as BF.toolWear ranks them (tier, then speed): gold between iron and diamond
const PREFIX = { wood: "wooden", stone: "stone", iron: "iron", gold: "golden", diamond: "diamond" };
const HEAD = { pickaxe: 3, axe: 3, hoe: 2, shears: 2, bucket: 3 }, STICKS = { pickaxe: 2, axe: 2, hoe: 2, shears: 0, bucket: 0 };
const SHEARS_IRON = 2;                         // iron kept back for shears while it has none
const RESERVE = 2;                             // emeralds it keeps after buying gold or diamonds
const WORK_END = 0.45, TRADE_PAUSE = 1.6, FURNACE_SPAN = 6;
const PER_COAL = 8, PER_WOOD = 1.5;            // items one coal / one log or plank smelts (inventory.js fuel: 80 s, 15 s; 10 s an item)
const LOG = [];

const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const I = n => BF.I[n];
const isPlanks = id => { const n = nameOf(id); return n === "planks" || /_planks$/.test(n); };
const isLog = id => { const n = nameOf(id); return /_log$/.test(n) && !/^stripped_/.test(n); };
// What counts as each material (the head of a tool), raw ore that smelts into it, fuel.
const MAT = {
  wood: isPlanks,
  stone: id => id === I("cobblestone") || id === I("cobbled_deepslate"),
  iron: id => id === I("iron_ingot"),
  gold: id => id === I("gold_ingot"),
  diamond: id => id === I("diamond"),
};
const RAW = {
  iron: id => /^(raw_iron|iron_ore|deepslate_iron_ore)$/.test(nameOf(id)),
  gold: id => /^(raw_gold|gold_ore|deepslate_gold_ore)$/.test(nameOf(id)),
};
const INGOT = { iron: "iron_ingot", gold: "gold_ingot" };
const isCoal = id => id === I("coal") || id === I("charcoal");
const isFuel = id => isCoal(id) || isLog(id) || isPlanks(id);
const fuelWorth = id => (isCoal(id) ? PER_COAL : isLog(id) || isPlanks(id) ? PER_WOOD : 0);
const isStick = id => id === I("stick");
const IRON_ONLY = c => c === "shears" || c === "bucket";
const catOf = id => { const it = BF.items[id]; if (it && it.name === "bucket") return "bucket"; if (!it || !it.tool) return null; return CATS.includes(it.tool.type) ? it.tool.type : null; };
const toolId = (cat, mat) => I(IRON_ONLY(cat) ? cat : PREFIX[mat] + "_" + cat);
const sum = (m, f) => { let n = 0; for (const s of m.inv) if (s && f(s.id)) n += s.count; return n; };
const count = (m, id) => TR().inv.count(m.inv, id);
const ems = m => count(m, I("emerald"));
const log = (kind, m, data) => { LOG.push(Object.assign({ kind, day: +dayNow().toFixed(3), who: "toolsmith" + (m.slot ? "#" + m.slot.idx : "") }, data)); if (LOG.length > 200) LOG.shift(); };
// Takes n items matching f, the biggest stacks first. Returns [{id, n}] taken.
function take(m, f, n) {
  const got = [];
  while (n > 0) {
    let best = null;
    for (const s of m.inv) if (s && f(s.id) && (!best || s.count > best.count)) best = s;
    if (!best) break;
    const id = best.id, k = TR().inv.remove(m.inv, id, Math.min(n, best.count));
    n -= k; const g = got.find(e => e.id === id); if (g) g.n += k; else got.push({ id, n: k });
  }
  return got;
}
const state = m => m.tsm || (m.tsm = { stage: null, deal: null, checkT: rnd(1, 5), avoid: {}, cd: 0, craft: null, furnace: null });
const vlog = (m, kind, text) => { if (BF.vlog && m.village) BF.vlog.log(m.village, kind, (BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Toolsmith") + " (Toolsmith) " + text, / at -?\d+, ?-?\d+, ?-?\d+/.test(text) ? null : m); };
const avoided = (S, k) => (S.avoid[k] || 0) > dayNow();

// ---------------------------------------------------------------- furnaces in the world
// Every loaded furnace block, by position (scanned as chunks load, kept up to date on block events; checked again before use).
const furnaces = new Map(), inUse = new Map();   // "x,y,z" -> {x,y,z}; "x,y,z" -> villager using it
const pk = (x, y, z) => x + "," + y + "," + z;
let hooked = false, FLAG = null;
function hook() {
  if (hooked || !BF.world || !BF.on || BF.B.furnace == null) return;
  hooked = true;
  FLAG = new Uint8Array((BF.MAX_BLOCK || 4095) + 1); for (const b of BF.blocks) if (b && BF.isFurnace(b.id)) FLAG[b.id] = 1;
  const scan = (cx, cz, c) => { const CS = BF.CS; BF.world.scanFlagged(c, FLAG, (lx, y, lz) => furnaces.set(pk(cx * CS + lx, y, cz * CS + lz), { x: cx * CS + lx, y, z: cz * CS + lz })); };
  BF.world.onChunkLoad(scan);
  if (BF.world.onChunkUnload) BF.world.onChunkUnload((cx, cz) => { const CS = BF.CS; for (const [k, f] of furnaces) if (Math.floor(f.x / CS) === cx && Math.floor(f.z / CS) === cz) furnaces.delete(k); });
  for (const c of BF.world.chunks.values()) scan(c.cx, c.cz, c);
  BF.on("blockPlaced", (x, y, z, id) => { if (BF.isFurnace(id)) furnaces.set(pk(x, y, z), { x, y, z }); });
  BF.on("blockBroken", (x, y, z) => furnaces.delete(pk(x, y, z)));
  BF.on("newWorld", () => { furnaces.clear(); inUse.clear(); });
}
const reachOf = R => Math.max(48, (R && R.wg && R.wg.reach) || 0);
// Can m use the furnace at f for raw ore `rawId` now? (still a furnace, input / output free or holding the same, nobody else at it)
function usable(m, f, rawId) {
  if (!f || !BF.isFurnace(BF.world.getBlock(f.x, f.y, f.z))) return false;
  const u = inUse.get(pk(f.x, f.y, f.z));
  if (u && u !== m && !u.dead && !u.removed && u.tsm && u.tsm.stage === "smelt") return false;
  const st = INV().furnaceState(f.x, f.y, f.z);
  if (!st) return true;
  const a = st.slots[0], o = st.slots[2];
  if (a && (rawId == null || a.id !== rawId)) return false;
  if (o && (rawId == null || o.id !== smeltsTo(rawId))) return false;
  return true;
}
const smeltsTo = rawId => (RAW.iron(rawId) ? I("iron_ingot") : RAW.gold(rawId) ? I("gold_ingot") : null);
// The furnaces of m's village it may use (its own first, then the nearest), or [] when there is none.
function furnacesFor(m, rawId) {
  hook();
  const R = m.village, S = state(m), out = [];
  if (!R) return out;
  const reach = reachOf(R) + 8;
  for (const f of furnaces.values()) {
    if (Math.hypot(f.x + 0.5 - R.x, f.z + 0.5 - R.z) > reach || avoided(S, "f:" + pk(f.x, f.y, f.z))) continue;
    if (usable(m, f, rawId)) out.push(f);
  }
  const own = S.furnace, d = f => (own && f.x === own.x && f.y === own.y && f.z === own.z ? -1e6 : 0) + Math.hypot(f.x - m.position.x, f.z - m.position.z) + Math.abs(f.y - m.position.y) * 2;
  return out.sort((a, b) => d(a) - d(b));
}
const hasFurnace = m => furnacesFor(m).length > 0 || count(m, BF.B.furnace) > 0;

// ---------------------------------------------------------------- what to make
// Tools of cat it holds that are mat or better (CALIBER order).
const stockAtLeast = (m, cat, mat) => { let n = 0; const top = CALIBER.indexOf(mat); for (const st of m.inv) { if (!st || catOf(st.id) !== cat) continue; const nm = nameOf(st.id), k = CALIBER.findIndex(x => IRON_ONLY(cat) || nm.startsWith(PREFIX[x] + "_")); if (k >= 0 && k <= top) n += st.count; } return n; };
const stockOf = m => { const s = { pickaxe: 0, axe: 0, hoe: 0, shears: 0, bucket: 0 }; for (const st of m.inv) { const c = st && catOf(st.id); if (c) s[c] += st.count; } return s; };
const matsFor = cat => (IRON_ONLY(cat) ? ["iron"] : CALIBER).filter(mat => toolId(cat, mat) != null);
// Head material in hand for mat (iron / gold: ingots, plus ore it could smelt when allowed).
function headInHand(m, mat, withRaw) { return sum(m, MAT[mat]) + (withRaw && RAW[mat] ? sum(m, RAW[mat]) : 0); }
// Sticks in hand, counting what its spare planks would make (2 planks -> 4 sticks), leaving `keepPlanks` planks.
const sticksPossible = (m, keepPlanks) => count(m, I("stick")) + 4 * Math.floor(Math.max(0, sum(m, isPlanks) - keepPlanks) / 2);
// Can it make (cat, mat) from what it holds right now (ingots, not ore)?
function canMake(m, cat, mat, stock) {
  const id = toolId(cat, mat);
  if (id == null) return false;
  let head = HEAD[cat], have = sum(m, MAT[mat]);
  if (mat === "iron" && cat !== "shears" && stock.shears === 0 && toolId("shears", "iron") != null) have -= SHEARS_IRON;   // iron kept for shears
  if (have < head) return false;
  return sticksPossible(m, mat === "wood" ? head : 0) >= STICKS[cat];
}
// The categories it should make next, the one it holds fewest of first (shears first while it has none and holds the iron).
function catOrder(m) {
  const stock = stockOf(m);
  const cats = CATS.filter(c => stock[c] < maxOf(c) && matsFor(c).length);
  const pri = c => (c === "shears" && stock.shears === 0 && sum(m, MAT.iron) >= SHEARS_IRON ? -1 : stock[c]);
  return { stock, cats: cats.sort((a, b) => pri(a) - pri(b) || CATS.indexOf(a) - CATS.indexOf(b)) };
}

// ---------------------------------------------------------------- sellers
// loose: also sellers who cannot trade right now (asleep, busy, down a mineshaft, out of stock) and ones it gave up on for a while: "sold here at all"
const canSell = (m, v2, loose) => v2 && v2 !== m && v2.type === "villager" && !v2.dead && !v2.removed && !v2.child && Array.isArray(v2.inv) && Array.isArray(v2.trades)
  && (loose || (!v2.sleeping && !v2.tradingWith && v2.position && v2.position.y > m.position.y - 6));   // not deep in a mineshaft
const restocked = (v2, id) => ((TR().PRODUCE[v2.profession] || []).includes(nameOf(id)));
// Offers of m's village that sell an item matching f, which m can pay for: [{v2, o, max}] (max = how many times), the nearest first.
function offersFor(m, f, loose) {
  const R = m.village, T = TR(), S = state(m), out = [];
  if (!R) return out;
  for (const v2 of R.members || []) {
    if (!canSell(m, v2, loose)) continue;
    for (const o of v2.trades) {
      if (o.feed || !f(o.sell.id) || restocked(v2, o.sell.id) || (!loose && T.blockReason(v2, o))) continue;
      if (!loose && avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id)) continue;
      let k = loose ? Infinity : Math.floor(T.inv.count(v2.inv, o.sell.id) / o.sell.n);   // loose: it sells this, even if it has none in hand right now
      for (const b of o.buy) k = Math.min(k, Math.floor(T.inv.count(m.inv, b.id) / b.n));
      if (k < 1) continue;
      out.push({ v2, o, max: k, d: v2.position ? v2.position.distanceTo(m.position) : Infinity });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
// Emeralds needed to buy n items matching f (cheapest offers first), or Infinity when the village does not sell that many.
function priceOf(m, f, n, loose) {
  const list = offersFor(m, f, loose).filter(e => e.o.buy.every(b => b.id === I("emerald")))
    .sort((a, b) => a.o.buy[0].n / a.o.sell.n - b.o.buy[0].n / b.o.sell.n);
  let cost = 0;
  for (const e of list) {
    if (n <= 0) break;
    const k = Math.min(e.max, Math.ceil(n / e.o.sell.n));
    cost += k * e.o.buy[0].n; n -= k * e.o.sell.n;
  }
  return n > 0 ? Infinity : cost;
}

// ---------------------------------------------------------------- the plan
// What it is after: {cat, mat, ready} (ready = materials in hand: go craft), or {cat, mat, need: {what, f, n}} (a thing to get first,
// what = "head" | "raw" | "stick" | "fuel" | "furnace"), or {smelt: rawId} (ore in hand to smelt), or null when there is nothing to do.
function plan(m) {
  if (!m || !m.inv) return null;
  const S = state(m);
  if (S.craft) return { crafting: true };
  const { stock, cats } = catOrder(m);
  if (!cats.length) return null;
  const furnaceOK = hasFurnace(m), budget = ems(m);
  if (!S.waitBetter) S.waitBetter = {};
  for (const cat of cats) {
    let later = null;    // a better material sold here, just not right now (seller asleep, busy, underground, or it gave up on them a while)
    for (const mat of matsFor(cat)) {
      if (stockAtLeast(m, cat, mat) >= capOf(cat)) break;   // enough of this or better: lesser ones would not help
      if (canMake(m, cat, mat, stock)) {
        if (later && (stock[cat] > 0 || mat === "wood")) {   // wait for the better one a while (only with one of these already on the shelf, or before falling back to wood); the wait ends when the lesser tool is started (startCraft)
          const w = S.waitBetter[cat] || (S.waitBetter[cat] = { since: dayNow(), mat: later });
          if (dayNow() - w.since < WAIT_BETTER) break;
          return { cat, mat, ready: true };
        }
        delete S.waitBetter[cat];
        return { cat, mat, ready: true };
      }
      const head = HEAD[cat] + (mat === "iron" && cat !== "shears" && stock.shears === 0 && toolId("shears", "iron") != null ? SHEARS_IRON : 0);
      const ingots = sum(m, MAT[mat]), raw = RAW[mat] ? sum(m, RAW[mat]) : 0;
      // ore in hand that would close the gap: smelt it first
      if (RAW[mat] && raw > 0 && ingots < head) {
        const r = smeltPlan(m, mat);
        if (r) return Object.assign(r, { cat, mat });
      }
      let short = head - ingots - (RAW[mat] && furnaceOK ? raw : 0);
      if (short > 0) {
        // buy ingots / diamonds / cobblestone / planks, or ore when it can smelt it
        let cost = priceOf(m, MAT[mat], short), what = "head", f = MAT[mat];
        if (RAW[mat]) {
          const viaRaw = priceOf(m, RAW[mat], short);
          if (viaRaw < Infinity && (furnaceOK || priceOf(m, id => id === BF.B.furnace, 1) < Infinity) && (cost === Infinity || viaRaw <= cost)) {
            if (!furnaceOK) { cost = viaRaw + priceOf(m, id => id === BF.B.furnace, 1); what = "furnace"; f = id => id === BF.B.furnace; short = 1; }
            else { cost = viaRaw; what = "raw"; f = RAW[mat]; }
          }
        }
        const keep = mat === "diamond" || mat === "gold" ? RESERVE : 0;
        if (cost === Infinity || cost > budget - keep) {   // cannot get it now: try the next material
          if (mat !== "wood" && Math.min(priceOf(m, MAT[mat], short, true), RAW[mat] ? priceOf(m, RAW[mat], short, true) : Infinity) <= budget - keep) later = later || mat;
          continue;
        }
        delete S.waitBetter[cat];
        return { cat, mat, need: { what, f, n: short } };
      }
      // head material is there: sticks
      const st = STICKS[cat] - sticksPossible(m, mat === "wood" ? HEAD[cat] : 0);
      if (st > 0) {
        if (priceOf(m, isStick, st) <= budget) return { cat, mat, need: { what: "stick", f: isStick, n: st } };
        if (priceOf(m, isPlanks, 2) <= budget) return { cat, mat, need: { what: "stick", f: isPlanks, n: 2 } };
        continue;
      }
    }
  }
  return null;
}
// Ore of mat in hand: {smelt: rawId} when it can smelt now (a usable furnace, fuel in hand or in the furnace), {need: fuel} when it only
// lacks fuel, {need: furnace} when there is no furnace but one is for sale. null when it cannot.
function smeltPlan(m, mat) {
  const raws = m.inv.filter(s => s && RAW[mat](s.id));
  if (!raws.length) return null;
  const rawId = raws.sort((a, b) => b.count - a.count)[0].id;
  const fs = furnacesFor(m, rawId);
  if (!fs.length) {
    if (count(m, BF.B.furnace) > 0) return { place: true };
    if (priceOf(m, id => id === BF.B.furnace, 1) <= ems(m)) return { need: { what: "furnace", f: id => id === BF.B.furnace, n: 1 } };
    return null;
  }
  const f = fs[0], st = INV().furnaceState(f.x, f.y, f.z);
  const inFurnace = st ? (st.burn > 0 ? 1 : 0) + (st.slots[1] ? st.slots[1].count * fuelWorth(st.slots[1].id) : 0) : 0;
  const n = sum(m, RAW[mat]);
  if (inFurnace > 0 || fuelFor(m, Math.min(n, 64)).length) return { smelt: rawId, furnace: f };
  const fuelCost = priceOf(m, isCoal, 1);
  if (fuelCost <= ems(m)) return { need: { what: "fuel", f: isCoal, n: Math.ceil(n / PER_COAL) } };
  if (priceOf(m, isLog, 1) <= ems(m)) return { need: { what: "fuel", f: isLog, n: Math.ceil(n / PER_WOOD) } };
  return null;
}
// Fuel from its pack enough to smelt n items: [{id, n}] (coal first, then logs, then planks it does not need), [] when it has too little.
function fuelFor(m, n) {
  const out = [];
  let left = n;
  const plankSpare = Math.max(0, sum(m, isPlanks) - 3);
  for (const pass of [isCoal, isLog, isPlanks]) {
    for (const s of m.inv) {
      if (left <= 0) break;
      if (!s || !pass(s.id)) continue;
      const already = out.filter(e => e.id === s.id).reduce((a, e) => a + e.n, 0);
      let avail = s.count - already;
      if (pass === isPlanks) avail = Math.min(avail, plankSpare - out.filter(e => isPlanks(e.id)).reduce((a, e) => a + e.n, 0));
      if (avail <= 0) continue;
      const k = Math.min(avail, Math.ceil(left / fuelWorth(s.id)));
      out.push({ id: s.id, n: k }); left -= k * fuelWorth(s.id);
    }
  }
  return left > 0 ? [] : out;
}

// ---------------------------------------------------------------- crafting at the smithing table
// Starts the tool of plan p: takes the materials (cuts sticks from planks first when short). Returns the craft record or null.
function startCraft(m, p) {
  const T = TR().inv, S = state(m), id = toolId(p.cat, p.mat);
  if (id == null || !canMake(m, p.cat, p.mat, stockOf(m))) return null;
  if (STICKS[p.cat] > count(m, I("stick"))) {
    const cuts = Math.ceil((STICKS[p.cat] - count(m, I("stick"))) / 4);
    if (!T.canFit(m.inv, [{ id: I("stick"), n: 4 * cuts }], [])) return null;
    take(m, isPlanks, 2 * cuts); T.add(m.inv, I("stick"), 4 * cuts);
  }
  const mats = take(m, MAT[p.mat], HEAD[p.cat]).concat(STICKS[p.cat] ? take(m, isStick, STICKS[p.cat]) : []);
  S.craft = { id, t: CRAFT_SECS(), mats };
  if (S.waitBetter) delete S.waitBetter[p.cat];
  log("start", m, { tool: nameOf(id) });
  return S.craft;
}
// Finishes the craft in progress when its time is up and the tool fits. Returns true when the tool was made.
function finishCraft(m) {
  const S = state(m), c = S.craft;
  if (!c || c.t > 0) return false;
  if (!TR().inv.canFit(m.inv, [{ id: c.id, n: 1 }], [])) return false;
  TR().inv.add(m.inv, c.id, 1);
  S.craft = null;
  log("craft", m, { made: nameOf(c.id) });
  vlog(m, "craft", "made " + BF.itemName(c.id));
  return true;
}
// Called by jobs.js while the toolsmith stands at its smithing table: works on the tool in hand, starts the next one.
function work(m, J, dt) {
  const S = state(m);
  if (!S.craft) {
    const p = plan(m);
    if (p && p.ready) startCraft(m, p);
  }
  if (S.craft) {
    S.craft.t -= dt;
    if (m.ai && Math.random() < dt * 1.5) m.ai.swingT = 0.3;   // hammering
    if (S.craft.t <= 0) finishCraft(m);
    if (J && J.t < 3 && (S.craft || (plan(m) || {}).ready)) J.t = 3;   // stays while there is work at the table
  }
}
// jobs.js asks this to bring the next visit to the table forward.
const wantsJob = m => { if (!m || m.profession !== "toolsmith") return false; const S = state(m); return !!S.craft || !!(plan(m) || {}).ready; };

// ---------------------------------------------------------------- trips
function travel(m, st, dt, out, tx, ty, tz, speed, near) {
  const ai = m.ai, N = BF.mobs.nav, px = m.position.x, pz = m.position.z;
  if (near ? near(...N.feetCell(m)) : Math.hypot(tx + 0.5 - px, tz + 0.5 - pz) <= 1.75 && Math.abs(ty - m.position.y) < 1.6) { ai.route = null; return "arrived"; }
  if (!ai.route || ai.routeKind !== "tsm") {
    ai.route = null;
    if (st.navWait > 0) { st.navWait -= dt; return "going"; }
    if (!N.takePlan()) return "going";
    const [fx, fy, fz] = N.feetCell(m);
    const d = Math.hypot(tx + 0.5 - px, tz + 0.5 - pz);
    const hop = d > 22 ? [Math.floor(px + (tx + 0.5 - px) * 20 / d), Math.floor(pz + (tz + 0.5 - pz) * 20 / d)] : null;
    const goal = hop ? { x: hop[0], z: hop[1], at: (x, y, z) => Math.abs(x - hop[0]) + Math.abs(z - hop[1]) <= 2 }
      : { x: tx, z: tz, at: near || ((x, y, z) => Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1 && Math.abs(y - ty) <= 1) };
    const path = N.findPath(fx, fy, fz, goal, 2500);
    if (path && path.length) { ai.route = path; ai.ri = 0; ai.stuckT = 0; ai.routeKind = "tsm"; st.navFail = 0; }
    else { st.navFail = (st.navFail || 0) + 1; st.navWait = 0.6; if (st.navFail >= (hop ? 5 : 2)) { st.navFail = 0; return "failed"; } }
    return "going";
  }
  const r = N.followRoute(m, dt, out, speed);
  if (r === "stuck") { ai.route = null; st.navFail = (st.navFail || 0) + 1; if (st.navFail >= 3) { st.navFail = 0; return "failed"; } }
  else if (r === "done") ai.route = null;
  return "going";
}
// A buying deal for need {f, n}: {kind: "buy", other, offer, times, item}, the nearest seller (cheapest for the head material).
function findDeal(m, need) {
  const T = TR();
  for (const e of offersFor(m, need.f)) {
    let k = Math.min(e.max, Math.ceil(need.n / e.o.sell.n), 4);
    while (k > 0 && !T.inv.canFit(m.inv, [{ id: e.o.sell.id, n: e.o.sell.n * k }], e.o.buy.map(b => ({ id: b.id, n: b.n * k })))) k--;
    if (k > 0) return { kind: "buy", other: e.v2, offer: e.o, times: k, item: e.o.sell.id, what: need.what };
  }
  return null;
}
function doBuy(m, deal) {
  const T = TR(), v2 = deal.other, o = deal.offer;
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!canSell(m, v2) || T.blockReason(v2, o)) break;
    if (!o.buy.every(b => T.inv.count(m.inv, b.id) >= b.n)) break;
    if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
    if (!T.exchange(v2, o)) break;
    for (const b of o.buy) T.inv.remove(m.inv, b.id, b.n);
    T.inv.add(m.inv, o.sell.id, o.sell.n);
    T.addXp(v2, o);
    done++;
  }
  if (done && BF.vlog) BF.vlog.trade(m, v2, o, done);
  if (done) log("buy", m, { from: v2.profession, got: done * o.sell.n + " " + BF.itemName(o.sell.id), paid: o.buy.map(b => b.n * done + " " + BF.itemName(b.id)).join(" + ") });
  return done;
}

// ---------------------------------------------------------------- the furnace: loading, waiting, emptying
// Puts ore and (when the furnace has none left) fuel in. Returns false when the furnace cannot be used.
function loadFurnace(m, job) {
  const f = job.furnace, st = INV().furnaceRecord(f.x, f.y, f.z), T = TR().inv;
  if (!usable(m, f, job.rawId)) return false;
  inUse.set(pk(f.x, f.y, f.z), m);
  const room = 64 - (st.slots[0] ? st.slots[0].count : 0), outRoom = 64 - (st.slots[2] ? st.slots[2].count : 0);
  const n = Math.min(count(m, job.rawId), room, outRoom);
  if (n <= 0) return false;
  T.remove(m.inv, job.rawId, n);
  if (st.slots[0]) st.slots[0].count += n; else st.slots[0] = { id: job.rawId, count: n };
  job.loaded = (job.loaded || 0) + n;
  topUpFuel(m, job, st);
  log("smelt", m, { ore: n + " " + BF.itemName(job.rawId), at: pk(f.x, f.y, f.z), fuelThere: !!(st.burn > 0 || st.slots[1]) });
  vlog(m, "furnace", "put " + n + " " + BF.itemName(job.rawId) + " in the furnace at " + pk(f.x, f.y, f.z) + (job.ownFuel ? " with " + job.ownFuel + " " + BF.itemName(st.slots[1] ? st.slots[1].id : I("coal")) : " (burning the fuel already in it)"));
  return true;
}
// Adds its own fuel only once the furnace has burnt what was in it: enough for the ore still in the input slot.
function topUpFuel(m, job, st) {
  if (st.burn > 0 || st.slots[1] || !st.slots[0]) return;
  const need = st.slots[0].count - (st.cook > 0 ? st.cook / 10 : 0);
  let fuel = fuelFor(m, need);
  if (!fuel.length) { const any = m.inv.find(s => s && isFuel(s.id)); if (any) fuel = [{ id: any.id, n: Math.min(any.count, 64) }]; }   // part of the ore
  if (!fuel.length) return;
  const f = fuel[0];   // one fuel kind fits the slot
  TR().inv.remove(m.inv, f.id, f.n);
  st.slots[1] = { id: f.id, count: f.n };
  job.ownFuel = (job.ownFuel || 0) + f.n;
}
// Takes the ingots out, and all the fuel left in the furnace (its own or not); also ore that did not get smelted when it gives up.
function emptyFurnace(m, job, all) {
  const f = job.furnace, st = INV().furnaceState(f.x, f.y, f.z), T = TR().inv;
  inUse.delete(pk(f.x, f.y, f.z));
  if (!st) return;
  const got = [];
  const grab = i => { const s = st.slots[i]; if (!s) return; const left = T.add(m.inv, s.id, s.count); if (left < s.count) got.push((s.count - left) + " " + BF.itemName(s.id)); if (left > 0) s.count = left; else st.slots[i] = null; };
  grab(2); grab(1);
  if (all && st.slots[0] && st.slots[0].id === job.rawId) grab(0);
  log("collect", m, { got: got.join(", ") || "nothing", at: pk(f.x, f.y, f.z) });
  vlog(m, "furnace", "took " + (got.join(" + ") || "nothing") + " out of the furnace at " + pk(f.x, f.y, f.z));
}

// ---------------------------------------------------------------- placing a furnace it bought
// A spot for a new furnace: a free floor cell inside the house of its bed (as for chests), else the nearest free ground cell just outside
// that house (or near its jobsite when it has no house). {x, y, z} or null.
function furnaceSpot(m) {
  if (BF.storage && BF.storage.chestSpot) { const s = BF.storage.chestSpot(m); if (s) return s; }
  const W = BF.world, S = BF.SOLID, B = BF.blocks;
  const H = BF.storage && BF.storage.bedHouse ? BF.storage.bedHouse(m) : null;
  const b = m.homeBed !== undefined ? m.homeBed : m.bed;
  const c = H ? { x: H.x + H.w / 2, z: H.z + H.d / 2, y: b ? b.y : Math.floor(m.position.y) } : m.jobsite ? { x: m.jobsite.x + 0.5, z: m.jobsite.z + 0.5, y: m.jobsite.y } : null;
  if (!c) return null;
  const inside = (x, z) => H && x >= H.x && x < H.x + H.w && z >= H.z && z < H.z + H.d;
  let best = null, bd = Infinity;
  for (let r = 1; r <= 8 && !best; r++) {
    const x0 = H ? H.x - r : Math.floor(c.x) - r, x1 = H ? H.x + H.w - 1 + r : Math.floor(c.x) + r;
    const z0 = H ? H.z - r : Math.floor(c.z) - r, z1 = H ? H.z + H.d - 1 + r : Math.floor(c.z) + r;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue;   // the ring at distance r
      if (inside(x, z) || !W.isLoaded(x, z)) continue;
      if (H && Math.abs(x - H.doorX) + Math.abs(z - H.doorZ) <= 2) continue;   // keep the door free
      for (let y = c.y + 2; y >= c.y - 3; y--) {
        const g = W.getBlock(x, y - 1, z), here = W.getBlock(x, y, z);
        if (!S[g] || here !== 0 || W.getBlock(x, y + 1, z) !== 0) continue;
        if (B[g] && (B[g].name === "dirt_path" || B[g].name === "farmland" || B[g].name === "farmland_dry" || B[g].fluid)) break;   // not on paths or fields
        if (BF.mobs.list.some(o => !o.removed && Math.floor(o.position.x) === x && Math.floor(o.position.z) === z && Math.abs(o.position.y - y) < 2)) break;
        const d = Math.hypot(x + 0.5 - c.x, z + 0.5 - c.z) + Math.abs(y - c.y);
        if (d < bd) { bd = d; best = { x, y, z }; }
        break;
      }
    }
  }
  return best;
}
function placeFurnace(m, spot) {
  const W = BF.world;
  if (count(m, BF.B.furnace) < 1 || W.getBlock(spot.x, spot.y, spot.z) !== 0) return false;
  const inCell = o => o && o.position && Math.abs(o.position.x - spot.x - 0.5) < 0.8 && Math.abs(o.position.z - spot.z - 0.5) < 0.8 && o.position.y < spot.y + 1 && o.position.y + 1.8 > spot.y;
  if (BF.mobs.list.some(o => !o.removed && !o.dead && inCell(o)) || inCell(BF.player)) return false;
  const id = BF.furnaceId(BF.openFacing(spot, m.position));
  if (!W.setBlock(spot.x, spot.y, spot.z, id)) return false;
  TR().inv.remove(m.inv, BF.B.furnace, 1);
  hook();
  furnaces.set(pk(spot.x, spot.y, spot.z), { x: spot.x, y: spot.y, z: spot.z });
  state(m).furnace = { x: spot.x, y: spot.y, z: spot.z };
  if (BF.emit) BF.emit("blockPlaced", spot.x, spot.y, spot.z, id);
  log("place", m, { furnace: pk(spot.x, spot.y, spot.z) });
  vlog(m, "furnace", "put a furnace down at " + spot.x + ", " + spot.y + ", " + spot.z);
  return true;
}

// ---------------------------------------------------------------- AI
// The next trip: {kind: "buy" | "smelt" | "place", ...} or null.
function nextTrip(m) {
  const p = plan(m), J = m.jobsite;
  // a tool to make but far from its table (jobs.js only sends villagers within 40 blocks to their jobsite): walk back first
  if (p && (p.ready || p.crafting) && J && Math.hypot(J.x + 0.5 - m.position.x, J.z + 0.5 - m.position.z) > 24) return { kind: "table", spot: { x: J.x, y: J.y, z: J.z } };
  if (!p || p.ready || p.crafting) return null;
  if (p.place) { const spot = furnaceSpot(m); return spot ? { kind: "place", spot } : null; }
  if (p.smelt != null) return { kind: "smelt", rawId: p.smelt, furnace: p.furnace };
  if (p.need) return findDeal(m, p.need);
  return null;
}
// Villager AI step (mobs.js villagerAI, daytime): trips to buy materials, to smelt ore, to put a furnace down. Returns true while it steers.
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.profession !== "toolsmith" || !BF.mobs || !BF.mobs.nav || !m.village) return false;
  const S = state(m), a = m.ai;
  if (skyT() >= WORK_END || m.tradingWith) {
    if (S.stage) { if (S.deal && S.deal.kind === "smelt" && S.deal.loaded) emptyFurnace(m, S.deal, true); S.stage = null; S.deal = null; a.route = null; }
    return false;
  }
  if (!S.stage) {
    S.checkT -= dt;
    if (S.checkT > 0) return false;
    S.checkT = 4;
    if (S.cd > dayNow()) return false;
    const deal = nextTrip(m);
    if (!deal) { S.cd = dayNow() + 0.03; return false; }
    S.deal = deal; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
  }
  const deal = S.deal;
  const giveUp = (why, key) => {
    log("giveup", m, { kind: deal.kind, item: deal.item != null ? BF.itemName(deal.item) : deal.kind, why });
    if (key) S.avoid[key] = dayNow() + 0.05;
    if (deal.kind === "smelt" && deal.loaded) emptyFurnace(m, deal, true);
    S.stage = null; S.deal = null; a.route = null; S.checkT = 0.5; return false;
  };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  if (deal.kind === "table") {   // back to the smithing table; jobs.js takes over from there
    const s = deal.spot;
    if (S.walkT > 90) return giveUp("timeout");
    const st = travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, (x, y, z) => Math.abs(x - s.x) + Math.abs(z - s.z) <= 3 && Math.abs(y - s.y) <= 2);
    if (st === "failed") return giveUp("no path");
    if (st === "arrived") { S.stage = null; S.deal = null; S.checkT = 2; if (m.job && m.job.mode === "off") m.job.t = Math.min(m.job.t, 0.5); }
    return true;
  }
  if (deal.kind === "place" || deal.kind === "smelt") {
    const s = deal.kind === "place" ? deal.spot : deal.furnace, fkey = "f:" + pk(s.x, s.y, s.z);
    if (S.stage === "walk") {
      if (S.walkT > 90) return giveUp("timeout", fkey);
      if (deal.kind === "smelt" && !usable(m, s, deal.rawId)) return giveUp("furnace busy", fkey);
      const st = travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, (x, y, z) => Math.abs(x - s.x) + Math.abs(z - s.z) === 1 && Math.abs(y - s.y) <= 1);
      if (st === "failed") return giveUp("no path", fkey);
      if (st === "arrived") { S.stage = "work"; S.tt = TRADE_PAUSE; S.waitT = 0; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.4 };
    if ((S.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
    if (deal.kind === "place") {
      const ok = placeFurnace(m, s);
      S.stage = null; S.deal = null; S.checkT = 1;
      if (!ok) S.avoid[fkey] = dayNow() + 0.05;
      return true;
    }
    // smelting: load, wait beside it (adding fuel when the furnace runs dry), then empty it
    if (!deal.loaded) { if (!loadFurnace(m, deal)) return giveUp("furnace busy", fkey); S.stage = "smelt"; return true; }
    const st = INV().furnaceState(s.x, s.y, s.z);
    if (!st || !BF.isFurnace(BF.world.getBlock(s.x, s.y, s.z))) { inUse.delete(pk(s.x, s.y, s.z)); return giveUp("furnace gone", fkey); }
    S.waitT += dt;
    if (!st.slots[0] || st.slots[0].id !== deal.rawId) { emptyFurnace(m, deal, false); S.stage = null; S.deal = null; S.checkT = 0.5; return true; }   // done
    topUpFuel(m, deal, st);
    if (S.waitT > 15 * deal.loaded + 40 || (st.burn <= 0 && !st.slots[1] && S.waitT > 3)) return giveUp(st.burn <= 0 && !st.slots[1] ? "out of fuel" : "too slow");
    if (Math.random() < dt * 0.5) a.swingT = 0.2;
    return true;
  }
  // buying
  const v2 = deal.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + deal.item;
  if (!canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage === "walk") {
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "tsm") a.route = null; S.gx = g.x; S.gz = g.z; }
    const st = travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3);
    if (st === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const done = doBuy(m, deal);
    S.stage = null; S.deal = null; S.gx = null; S.checkT = 0.5;
    if (!done) { S.avoid[key] = dayNow() + 0.05; log("giveup", m, { kind: "buy", item: BF.itemName(deal.item), why: "trade refused" }); }
  }
  return true;
}

// Trade screen / debug status: what it is doing right now, or "".
function statusText(m) {
  if (!m || m.profession !== "toolsmith") return "";
  const S = m.tsm;
  if (S && S.stage && S.deal) {
    const k = S.deal.kind;
    if (k === "place") return "Putting a furnace down";
    if (k === "table") return "Going back to the smithing table";
    if (k === "smelt") return S.stage === "smelt" ? "Smelting " + BF.itemName(smeltsTo(S.deal.rawId)).toLowerCase() + "s" : "Taking ore to a furnace";
    return "Buying " + (S.deal.what === "fuel" ? "fuel" : S.deal.what === "furnace" ? "a furnace" : BF.itemName(S.deal.item).toLowerCase());
  }
  const w = S && S.waitBetter && Object.entries(S.waitBetter).find(([, x]) => dayNow() - x.since < WAIT_BETTER);
  if (w && !S.craft) return "Waiting for " + { diamond: "diamonds", iron: "iron", gold: "gold", stone: "cobblestone" }[w[1].mat] + " for a better " + w[0];
  if (S && S.craft) return (m.job && m.job.mode === "work" ? "Making " : "Will finish ") + BF.itemName(S.craft.id).toLowerCase().replace(/^(?!.*s$)(.*)$/, "a $1").replace(/^a ([aeiou])/, "an $1");
  return "";
}

// ---------------------------------------------------------------- persistence (trading.js pack / unpack, key "ts")
function pack(m) {
  const S = m.tsm;
  if (!S || (!S.craft && !S.furnace)) return undefined;
  const o = {};
  if (S.craft && BF.items[S.craft.id]) o.c = [nameOf(S.craft.id), Math.max(0, Math.round(S.craft.t)), S.craft.mats.map(e => [nameOf(e.id), e.n])];
  if (S.furnace) o.f = [S.furnace.x, S.furnace.y, S.furnace.z];
  return o;
}
function unpack(m, o) {
  if (!o || typeof o !== "object") return;
  const S = state(m);
  if (Array.isArray(o.f) && o.f.length === 3 && o.f.every(Number.isFinite)) S.furnace = { x: o.f[0], y: o.f[1], z: o.f[2] };
  if (Array.isArray(o.c)) {
    const id = I(o.c[0]), mats = (Array.isArray(o.c[2]) ? o.c[2] : []).map(e => ({ id: I(e[0]), n: Math.floor(e[1]) })).filter(e => e.id != null && e.n > 0);
    if (id != null) S.craft = { id, t: Math.max(0, +o.c[1] || 0), mats };
    else for (const e of mats) TR().inv.add(m.inv, e.id, e.n);   // the tool no longer exists: the materials come back
  }
}

// Starting pack (trading.js stockFor): no tools for sale (it makes them), some planks and sticks for its first wooden tools.
function seed(a) {
  const T = TR().inv;
  for (const s of a.slice()) if (s && catOf(s.id)) T.remove(a, s.id, s.count);
  if (I("planks") != null && T.count(a, I("planks")) < 6) T.add(a, I("planks"), 6);
  if (I("stick") != null && T.count(a, I("stick")) < 4) T.add(a, I("stick"), 4);
}

BF.toolsmith = {
  CRAFT_HOURS, CRAFT_SECS, TOOL_CAP, CATS, CALIBER, HEAD, STICKS, SHEARS_IRON,
  hook, furnaces, furnacesFor, usable, plan, smeltPlan, fuelFor, canMake, stockOf, catOrder, toolId, startCraft, finishCraft, work, wantsJob,
  offersFor, priceOf, findDeal, doBuy, loadFurnace, emptyFurnace, furnaceSpot, placeFurnace, nextTrip, ai, statusText, pack, unpack, seed, LOG,
};
})();
