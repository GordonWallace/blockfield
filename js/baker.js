// Bakers, cakes and pies (BF.baker). Loaded after js/cowherd.js; hooks live in blocks.js, world.js (cane growth), inventory.js (oven sim tick),
// player.js (cake, oven), mobs.js, jobs.js, trading.js, market.js, villagelife.js, eggcook.js, happiness.js, builder.js / blueprints.js,
// worldgen.js, debugfeed.js. See CONTRACT.md "Bakers (js/baker.js)".
//
// Items: sugar (1 sugar cane), pumpkin seeds (4 from a pumpkin; a stem on farmland grows into a pumpkin), pumpkin pie (pumpkin + sugar + egg),
//  cake (3 milk bottles or buckets, 2 sugar, 1 egg, 3 wheat; the bottles or buckets come back empty), cake slices (7 to a cake).
// The baker's oven (jobsite of "baker") bakes like a furnace: a cooking slot (the tray: the ingredients of n cakes or n pies), a fuel slot and an
//  output. With fuel burning it bakes one cake every BAKE_T.cake seconds (one pie every BAKE_T.pie) of game time (the furnace's sim tick, so
//  fast-forward too); each cake's empty milk bottles come out with it. Without fuel nothing bakes. Oven contents are saved ("ovens").
// The baker (at most one per 15 villagers): buys its ingredients through other villagers' offers (wheat and sugar cane, pumpkins from the
//  farmers, eggs from the poultry keeper or anyone selling them, milk bottles from the cowherd), and fuel (coal, charcoal, logs, planks); turns
//  cane into sugar; bakes in its own oven (load, fuel, wait beside it, take out the food and the fuel left); cuts cakes into slices; sells
//  slices, pies and whole cakes; its empty bottles are its spare goods, which the cowherd buys back. It never creates anything.
// Farmers (villagelife.js think/perform call farmTask/farmPerform): sugar cane on soil beside water in their beds (the pumpkin patch's edge,
//  or a farmland cell at a channel's end they turn back into dirt), cut down to the bottom block when grown; wild cane gathered for the first
//  plant; the pumpkin patches' pumpkins harvested, their cells tilled and replanted from seeds (a pumpkin is cut into 4 when it has none).
// Villagers buy a treat (cake slices or pies) at most every TREAT_EVERY days when they hold none and have 2 emeralds; they eat one a day at
//  most (a treat is eaten first when one is due). Eating one counts toward happiness ("treats") for TREAT_HAPPY days.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PROF = "baker";
const PER_VILLAGERS = 15;        // at most one baker per 15 villagers (at least one)
const BAKE_T = { cake: 20, pie: 10 };   // seconds of fire per cake / pie (a furnace item is 10 s)
const RECIPE = { cake: [["milk_bottle", 3], ["sugar", 2], ["egg", 1], ["wheat_item", 3]], pie: [["pumpkin", 1], ["sugar", 1], ["egg", 1]] };
const OUT = { cake: "cake", pie: "pumpkin_pie" };
const SLICES = 7;
const SLICE_CAP = 21;            // it bakes cakes while it holds fewer slices (cakes counted as 7) than this ...
const PIE_CAP = 9;               // ... and pies while it holds fewer than this
const BATCH = { cake: 2, pie: 4 };   // the most one oven load holds
const WANT = { wheat_item: 6, milk_bottle: 6, egg: 4, sugar: 4, pumpkin: 3 };   // ingredients it buys up to (sugar counts its cane)
const HOLD_MAX = { wheat_item: 16, milk_bottle: 14, egg: 16, sugar_cane: 32, pumpkin: 10 };   // it doesn't buy more while it holds this many
const WORK_START = 0.02, WORK_END = 0.45, CHECK = 3, TRADE_PAUSE = 1.6;
const TREAT_EVERY = 3;           // villagers buy a treat at most every 3 days ...
const TREAT_GAP = 1;             // ... and eat one at most once a day
const TREAT_HAPPY = 3;           // a treat eaten in the last 3 days counts toward happiness
const BUY_BY = 0.4;

const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const FU = () => BF.furnaceUse;
const I = n => BF.I[n];
const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const cnt = (m, id) => (id == null || !m || !Array.isArray(m.inv) ? 0 : TR().inv.count(m.inv, id));
const pk = (x, y, z) => x + "," + y + "," + z;
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
const LOG = [];
const log = (kind, data) => { LOG.push(Object.assign({ kind, day: +now().toFixed(3) }, data)); if (LOG.length > 300) LOG.shift(); };
const who = m => (BF.vlog && BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Villager") + " (" + String(m.profession || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + ")";
const vlog = (m, text, where) => { if (BF.vlog && m && m.village) BF.vlog.log(m.village, "bake", who(m) + " " + text, where || m); };

const isTreat = id => id != null && (id === I("cake_slice") || id === I("pumpkin_pie"));
const isOven = id => id != null && id === BF.B.bakers_oven;
const cakeBites = id => { const b = BF.blocks[id]; return !b ? -1 : b.name === "cake" ? 0 : b.cakeBites || -1; };
const isCake = id => cakeBites(id) >= 0;

// ---------------------------------------------------------------- the oven
// rec: {key, pos, kind ("cake" | "pie" | null), n (left to bake), tray [{id, count}], fuel {id, count} | null, out [{id, count}], burn, burnMax, cook, by}
const ovens = new Map();
function ovenAt(x, y, z) {
  const k = pk(x, y, z);
  let o = ovens.get(k);
  if (!o) { o = { key: k, pos: { x, y, z }, kind: null, n: 0, tray: [], fuel: null, out: [], burn: 0, burnMax: 0, cook: 0, lit: false }; ovens.set(k, o); }
  return o;
}
const ovenState = (x, y, z) => ovens.get(pk(x, y, z)) || null;
const addTo = (arr, id, n) => { if (n <= 0) return; const s = arr.find(e => e.id === id); if (s) s.count += n; else arr.push({ id, count: n }); };
const takeFrom = (arr, id, n) => { const s = arr.find(e => e.id === id); if (!s || s.count < n) return false; s.count -= n; if (!s.count) arr.splice(arr.indexOf(s), 1); return true; };
const has = (arr, id, n) => { const s = arr.find(e => e.id === id); return !!s && s.count >= n; };
const fuelSecs = id => (FU() ? FU().fuelWorth(id) * FU().COOK : 0);
const isFuel = id => !!(FU() && FU().isFuel(id));
const empty = o => !o.tray.length && !o.fuel && !o.out.length && !(o.n > 0);
// One batch's ingredients are in the tray.
function trayReady(o) {
  if (!o.kind || !(o.n > 0)) return false;
  return RECIPE[o.kind].every(([nm, k]) => I(nm) != null && has(o.tray, I(nm), k));
}
// A sim step of one oven (inventory.js simTick, so fast-forward too): burn fuel, bake, put the cake or pie (and the cake's empty bottles) out.
function tickOven(o, h) {
  if (o.burn > 0) o.burn = Math.max(0, o.burn - h);
  const ok = trayReady(o);
  if (ok && o.burn <= 0 && o.fuel && o.fuel.count > 0 && fuelSecs(o.fuel.id) > 0) {
    o.burn = o.burnMax = fuelSecs(o.fuel.id);
    if (--o.fuel.count <= 0) o.fuel = null;
  }
  if (ok && o.burn > 0) {
    o.cook += h;
    if (o.cook >= BAKE_T[o.kind]) {
      o.cook = 0;
      for (const [nm, k] of RECIPE[o.kind]) takeFrom(o.tray, I(nm), k);
      addTo(o.out, I(OUT[o.kind]), 1);
      if (o.kind === "cake" && I("glass_bottle") != null) addTo(o.out, I("glass_bottle"), 3);   // the milk is poured in: the bottles come back empty
      o.n--; o.baked = (o.baked || 0) + 1;
      if (BF.emit) BF.emit("ovenBaked", o.pos.x, o.pos.y, o.pos.z, o.kind);
      if (o.n <= 0) { o.n = 0; }
    }
  } else if (o.cook > 0) o.cook = Math.max(0, o.cook - h * 2);
  o.lit = o.burn > 0;
}
function simTick(h) { for (const o of ovens.values()) if (o.kind || o.burn > 0) tickOven(o, h); }

// Loads n batches of `kind` from m's pack into the oven at o: the tray, and fuel from its pack when nothing burns there. Returns n loaded.
function load(m, o, kind, n, fuelOk) {
  if (!o || (o.kind && o.kind !== kind && o.n > 0) || o.tray.length) return 0;
  const T = TR().inv;
  let k = Math.min(n, canMake(m, kind));
  if (k <= 0) return 0;
  for (const [nm, c] of RECIPE[kind]) { T.remove(m.inv, I(nm), c * k); addTo(o.tray, I(nm), c * k); }
  o.kind = kind; o.n = k; o.by = m; o.cook = 0;
  topUp(m, o, fuelOk);
  return k;
}
// Fuel for what is left in the tray beyond the fire burning now, from m's pack, into the empty fuel slot (one fuel kind fits it).
function topUp(m, o, fuelOk) {
  if (o.fuel || !trayReady(o)) return 0;
  const secs = BAKE_T[o.kind] * o.n - o.cook - o.burn + 0.5;   // fire still needed beyond what burns now (a little over: the last tick)
  if (secs <= 0) return 0;
  const need = Math.max(1, Math.ceil(secs / FU().COOK));
  let fuel = FU().fuelFor(m, need, fuelOk);
  if (!fuel.length) { const any = m.inv.find(s => s && isFuel(s.id) && (!fuelOk || fuelOk(s.id))); if (any) fuel = [{ id: any.id, n: Math.min(any.count, 64) }]; }
  if (!fuel.length) return 0;
  const f = fuel[0];
  TR().inv.remove(m.inv, f.id, f.n);
  o.fuel = { id: f.id, count: f.n };
  return f.n;
}
// Takes out what is done and all the fuel left (and, with `all`, the tray: it gives up). Returns {id: n} taken; what doesn't fit stays.
function unload(m, o, all) {
  const T = TR().inv, got = {};
  const grab = s => { const left = T.add(m.inv, s.id, s.count); const n = s.count - left; if (n > 0) got[s.id] = (got[s.id] || 0) + n; s.count = left; return left; };
  o.out = o.out.filter(s => grab(s) > 0);
  if (o.fuel && grab(o.fuel) <= 0) o.fuel = null;
  if (all) { o.tray = o.tray.filter(s => grab(s) > 0); if (!o.tray.length) { o.n = 0; o.kind = null; o.cook = 0; } }
  if (!(o.n > 0) && !o.tray.length) { o.kind = null; o.cook = 0; }
  if (empty(o)) o.by = null;
  return got;
}
function dropOven(x, y, z) {   // the oven block is gone (broken, exploded, /setblock): its contents spill
  const o = ovenState(x, y, z);
  if (!o) return;
  ovens.delete(o.key);
  if (!BF.drops) return;
  for (const s of o.tray.concat(o.out, o.fuel ? [o.fuel] : [])) if (s.count > 0) BF.drops.spawn(s.id, s.count, x + 0.5, y + 0.6, z + 0.5);
}
// For the player's right click on an oven: what it holds.
function ovenText(x, y, z) {
  const o = ovenState(x, y, z), nm = id => BF.itemName(id).toLowerCase();
  if (!o || empty(o)) return "Baker's oven: empty";
  const parts = [];
  if (o.kind && o.n > 0) parts.push((o.burn > 0 ? "baking " : "waiting for fuel to bake ") + plural(o.n, o.kind === "cake" ? "cake" : "pumpkin pie"));
  if (o.fuel) parts.push(o.fuel.count + " " + nm(o.fuel.id) + " to burn");
  for (const s of o.out) parts.push(s.count + " " + nm(s.id) + " ready");
  return "Baker's oven: " + parts.join(", ");
}

// ---------------------------------------------------------------- what the baker can make, needs and keeps
function canMake(m, kind) {
  let k = Infinity;
  for (const [nm, c] of RECIPE[kind]) { const id = I(nm); if (id == null) return 0; k = Math.min(k, Math.floor(cnt(m, id) / c)); }
  return k === Infinity ? 0 : k;
}
const slicesHeld = m => cnt(m, I("cake_slice")) + SLICES * cnt(m, I("cake"));
const wantCakes = m => slicesHeld(m) < SLICE_CAP;
const wantPies = m => cnt(m, I("pumpkin_pie")) < PIE_CAP;
// Its market reserve (js/market.js reserve): the ingredients it holds up to what it buys for, and its fuel. Its goods and empties are for sale.
function reserve(m) {
  const out = [];
  if (m.profession !== PROF || !Array.isArray(m.inv)) return out;
  for (const nm of ["wheat_item", "milk_bottle", "egg", "sugar", "sugar_cane", "pumpkin"]) { const id = I(nm); if (id != null && cnt(m, id) > 0) out.push({ ids: new Set([id]), n: cnt(m, id) }); }
  const fuel = new Set(); for (const s of m.inv) if (s && isFuel(s.id)) fuel.add(s.id);
  if (fuel.size) out.push({ ids: fuel, n: 16 });
  return out;
}
// A farmer's market reserve (js/market.js reserve): the canes it plants its cane spots with, and a pumpkin to cut into seeds while it has none.
function farmerReserve(m) {
  const out = [];
  if (!m || m.profession !== "farmer" || !Array.isArray(m.inv)) return out;
  if (I("sugar_cane") != null) out.push({ ids: new Set([I("sugar_cane")]), n: CANE_SPOTS });
  if (I("pumpkin") != null && cnt(m, I("pumpkin_seeds")) === 0) out.push({ ids: new Set([I("pumpkin")]), n: 1 });
  return out;
}
// It never eats its milk (villagelife.js reserveOf).
const keepsFood = (m, id) => m && m.profession === PROF && id === I("milk_bottle");
// Fuel it may burn: coal always, wood unless a job offer of its sells that kind (none does).
const fuelOk = m => id => FU().isCoal(id) || !(m.trades || []).some(o => o && !o.spare && !o.need && o.sell && o.sell.id === id);
// Fuel in its pack, in furnace items' worth.
const fuelHeld = m => { let n = 0; for (const s of m.inv) if (s && isFuel(s.id) && fuelOk(m)(s.id)) n += s.count * FU().fuelWorth(s.id); return n; };

// ---------------------------------------------------------------- jobs.js: who may work an oven
const capOf = R => Math.max(1, Math.floor((R.members || []).filter(o => live(o) && o.type === "villager").length / PER_VILLAGERS));
function mayHire(m, s) {
  const R = m && m.village;
  if (!R) return false;
  let n = 0;
  for (const o of R.members || []) if (o !== m && live(o) && o.profession === PROF) n++;
  const J = BF.jobs, mine = m.slot ? R.key + "#" + m.slot.idx : null;
  if (J) for (const [k, c] of J.claims) {
    if (!c || !c.key || c.key === mine || c.key.indexOf(R.key + "#") !== 0) continue;
    const site = J.sites.get(k);
    if (((site && site.prof === PROF) || (c.mob && c.mob.profession === PROF)) && !(c.mob && R.members.includes(c.mob))) n++;
  }
  return n < capOf(R);
}

// ---------------------------------------------------------------- the baker's day
const st = m => m.bkr || (m.bkr = { stage: null, job: null, checkT: rnd(1, 4), avoid: {}, cd: 0, noFuelDay: -1 });
const avoided = (S, k) => (S.avoid[k] || 0) > now();
const skipOffer = S => (v2, o) => avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id);
const ovenOf = m => (m.jobsite && isOven(BF.world.getBlock(m.jobsite.x, m.jobsite.y, m.jobsite.z)) ? m.jobsite : null);
// Turns sugar cane into sugar (the crafting recipe, done where it stands) while it holds less than its sugar wants.
function makeSugar(m) {
  const T = TR().inv, cane = I("sugar_cane"), sugar = I("sugar");
  if (cane == null || sugar == null) return 0;
  const want = Math.max(0, 2 * (BATCH.cake * 2) - cnt(m, sugar));
  const k = Math.min(cnt(m, cane), want);
  if (k <= 0 || !T.canFit(m.inv, [{ id: sugar, n: k }], [{ id: cane, n: k }])) return 0;
  T.remove(m.inv, cane, k); T.add(m.inv, sugar, k);
  return k;
}
// Cuts whole cakes into 7 slices each while it holds fewer than a cake's worth of slices (one cake stays whole for the player when it has two).
function slice(m) {
  const T = TR().inv, cake = I("cake"), sl = I("cake_slice");
  let k = 0;
  while (cnt(m, cake) > 0 && cnt(m, sl) < SLICES && T.canFit(m.inv, [{ id: sl, n: SLICES }], [{ id: cake, n: 1 }])) { T.remove(m.inv, cake, 1); T.add(m.inv, sl, SLICES); k++; }
  return k;
}
// Milk from the cowherd: its MILK_KEEP bottles are kept for the baker (js/cowherd.js reserve), so they are offered while a baker shops.
function withBaker(fn) {
  const C = BF.cowherd;
  if (!C) return fn();
  const was = C.forBaker; C.forBaker = true;
  try { return fn(); } finally { C.forBaker = was; }
}
const clearRes = () => { if (BF.mobs) for (const v of BF.mobs.list) if (v.profession === "cowherd") v._res = null; };
// What it should buy next: {f, n, what} or null. Fuel first when it could bake now, then the missing ingredient of the treat it is short of.
function shopping(m) {
  const S = st(m), out = [];
  const cakeOn = wantCakes(m), pieOn = wantPies(m);
  if (!cakeOn && !pieOn) return out;
  const need = (nm, n) => { const id = I(nm); if (id == null) return; const have = nm === "sugar" ? cnt(m, id) + cnt(m, I("sugar_cane")) : cnt(m, id); if (have < n) out.push({ nm, n: n - have }); };
  if ((cakeOn && canMake(m, "cake")) || (pieOn && canMake(m, "pie"))) { if (fuelHeld(m) < 2) out.push({ nm: "fuel", n: 4 }); }
  if (cakeOn) { need("milk_bottle", WANT.milk_bottle); need("wheat_item", WANT.wheat_item); need("egg", WANT.egg); need("sugar", WANT.sugar); }
  if (pieOn) { need("pumpkin", WANT.pumpkin); need("egg", WANT.egg); need("sugar", WANT.sugar); }
  const seen = new Set();
  return out.filter(e => !seen.has(e.nm) && seen.add(e.nm) && !(e.nm !== "fuel" && cnt(m, I(e.nm === "sugar" ? "sugar_cane" : e.nm)) >= (HOLD_MAX[e.nm === "sugar" ? "sugar_cane" : e.nm] || 64)) && !avoided(S, "want:" + e.nm));
}
function buyDeal(m, e) {
  const F = FU(), S = st(m), ok = fuelOk(m);
  if (e.nm === "fuel") {
    const nc = Math.ceil(e.n / F.PER_COAL), coal = { what: "fuel", f: F.isCoal, n: nc };   // e.n: furnace items' worth
    if (F.priceOf(m, F.isCoal, nc, false, skipOffer(S)) <= cnt(m, I("emerald"))) { const d = F.findDeal(m, coal, skipOffer(S)); if (d) return d; }
    const wood = id => (F.isLog(id) || F.isPlanks(id)) && ok(id);
    return F.findDeal(m, { what: "fuel", f: wood, n: Math.ceil(e.n / F.PER_WOOD) }, skipOffer(S));
  }
  const id = I(e.nm === "sugar" ? "sugar_cane" : e.nm);
  if (id == null) return null;
  const run = () => F.findDeal(m, { what: e.nm, f: x => x === id, n: e.nm === "sugar" ? e.n : e.n }, skipOffer(S));
  if (e.nm === "milk_bottle") { clearRes(); const d = withBaker(run); clearRes(); return d; }
  return run();
}
function nextJob(m) {
  const S = st(m), o = ovenOf(m);
  if (!o) return null;
  const rec = ovenState(o.x, o.y, o.z);
  if (rec && (rec.out.length || (rec.fuel && !rec.n) || (rec.tray.length && rec.by !== m))) return { kind: "collect", oven: o };   // left from before (a reload, a day's end)
  // bake: cakes while short of slices, pies while short of pies
  for (const kind of ["cake", "pie"]) {
    if (!(kind === "cake" ? wantCakes(m) : wantPies(m))) continue;
    let n = Math.min(canMake(m, kind), BATCH[kind]);
    if (kind === "cake") n = Math.min(n, Math.ceil((SLICE_CAP - slicesHeld(m)) / SLICES));
    else n = Math.min(n, PIE_CAP - cnt(m, I("pumpkin_pie")));
    if (n <= 0) continue;
    const per = BAKE_T[kind] / FU().COOK, fuelNeed = Math.ceil(per * n), held = fuelHeld(m);   // furnace items' worth of fuel
    if (held >= fuelNeed) return { kind: "bake", oven: o, what: kind, n };
    const d = buyDeal(m, { nm: "fuel", n: Math.max(fuelNeed, 4) });
    if (d) return d;
    if (held >= per) return { kind: "bake", oven: o, what: kind, n: Math.max(1, Math.floor(held / per)) };   // nobody sells fuel now: bake what it has fuel for
    if (S.noFuelDay !== Math.floor(now())) { S.noFuelDay = Math.floor(now()); log("noFuel", { who: m.slot ? m.slot.idx : null }); vlog(m, "has no fuel for the oven and nobody sells any: no baking today", o); }
    return null;
  }
  if (skyT() > BUY_BY) return null;
  for (const e of shopping(m)) {
    if (e.nm === "fuel") continue;
    const d = buyDeal(m, e);
    if (d) return d;
    S.avoid["want:" + e.nm] = now() + 0.1;   // nobody sells it now: look again in a while
  }
  return null;
}
function finish(m, S, all) {
  const job = S.job, o = job && job.oven && ovenState(job.oven.x, job.oven.y, job.oven.z);
  if (!o) return;
  const baked = o.baked || 0; o.baked = 0;
  const got = unload(m, o, all);
  const cakes = got[I("cake")] || 0, pies = got[I("pumpkin_pie")] || 0;
  log("collect", { cakes, pies, baked, all: !!all });
  if (cakes) vlog(m, "baked " + plural(cakes, "cake") + " in the oven", job.oven);
  if (pies) vlog(m, "baked " + plural(pies, "pumpkin pie") + " in the oven", job.oven);
  S.made = S.made || { cakes: 0, pies: 0 };
  S.made.cakes += cakes; S.made.pies += pies;
  slice(m);
}
// Villager AI step (mobs.js villagerAI: early with cont = true to carry on what it started, and after the other trades with cont = false).
function ai(m, dt, out, cont) {
  if (m.profession !== PROF) return false;
  if (cont && !(m.bkr && m.bkr.stage)) return false;
  if (!m.inv || m.dead || m.child || m.type !== "villager" || !BF.mobs || !BF.mobs.nav || !m.village || !FU() || m.sleeping) return false;
  const F = FU(), S = st(m), a = m.ai, t = skyT();
  if (t >= WORK_END || t < WORK_START || m.tradingWith) {
    if (S.stage) { if (S.job && S.job.oven && S.stage !== "walk") finish(m, S, true); S.stage = null; S.job = null; a.route = null; }
    return false;
  }
  if (!S.stage) {
    if (cont) return false;
    S.checkT -= dt;
    if (S.checkT > 0) return false;
    S.checkT = CHECK;
    const made = makeSugar(m), cut = slice(m);
    if (made) log("sugar", { n: made });
    if (cut) log("slice", { cakes: cut });
    if (S.cd > now()) return false;
    const job = nextJob(m);
    if (!job) { S.cd = now() + 0.02; return false; }
    S.job = job; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
  }
  const job = S.job;
  const giveUp = (why, key) => {
    log("giveup", { kind: job.kind, why });
    if (key) S.avoid[key] = now() + 0.05;
    if (job.oven && S.stage !== "walk") finish(m, S, true);
    S.stage = null; S.job = null; a.route = null; S.checkT = 0.5; return false;
  };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  if (job.kind === "bake" || job.kind === "collect") {
    const s = job.oven, near = F.beside(s);
    if (!isOven(BF.world.getBlock(s.x, s.y, s.z))) return giveUp("oven gone");
    const go = () => F.travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, near, "bake");
    if (S.stage === "walk") {
      if (S.walkT > 90) return giveUp("timeout");
      const r = go();
      if (r === "failed") return giveUp("no path");
      if (r === "arrived") { S.stage = "work"; S.tt = TRADE_PAUSE; S.waitT = 0; }
      return true;
    }
    if (Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) > 3) { if (go() === "failed") return giveUp("cannot get back"); return true; }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.3 };
    const o = ovenAt(s.x, s.y, s.z);
    if (S.stage === "work") {
      if ((S.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }
      if (job.kind === "collect") { finish(m, S, true); S.stage = null; S.job = null; S.checkT = 0.5; return true; }
      makeSugar(m);
      const n = load(m, o, job.what, job.n, fuelOk(m));
      if (!n) return giveUp("cannot load");
      S.stage = "bake";
      log("load", { what: job.what, n, fuel: o.fuel ? o.fuel.count + " " + nameOf(o.fuel.id) : null });
      return true;
    }
    // baking: wait beside it, add fuel when it runs dry, take everything out when it is done
    S.waitT += dt;
    if (!(o.n > 0)) { finish(m, S, false); S.stage = null; S.job = null; S.checkT = 0.5; return true; }
    topUp(m, o, fuelOk(m));
    if (S.waitT > BAKE_T[o.kind || "cake"] * 1.5 * (o.n + 1) + 40 || (o.burn <= 0 && !o.fuel && S.waitT > 3)) return giveUp(o.burn <= 0 && !o.fuel ? "out of fuel" : "too slow");
    if (Math.random() < dt * 0.5) a.swingT = 0.2;
    return true;
  }
  // buying (an ingredient or fuel) at the seller's own offer
  const v2 = job.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + job.item;
  if (!F.canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage === "walk") {
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "bake") a.route = null; S.gx = g.x; S.gz = g.z; }
    if (F.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3, null, "bake") === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const milk = job.item === I("milk_bottle");
    if (milk) clearRes();
    const done = milk ? withBaker(() => F.doBuy(m, job)) : F.doBuy(m, job);
    if (milk) clearRes();
    S.stage = null; S.job = null; S.gx = null; S.checkT = 0.5;
    if (done) {
      const n = done * job.offer.sell.n;
      log("buy", { what: nameOf(job.item), n, from: v2.profession });
      if (milk) vlog(m, "bought " + plural(n, "milk bottle") + " from " + who(v2) + " for cakes", v2);
    } else { S.avoid[key] = now() + 0.05; log("giveup", { kind: "buy", why: "trade refused" }); }
  }
  return true;
}

function statusText(m) {
  const S = m.bkr;
  if (!S || !S.stage || !S.job) return "";
  if (S.job.kind === "collect") return "Emptying the oven";
  if (S.job.kind === "bake") return S.stage === "bake" ? (S.job.what === "cake" ? "Baking cakes" : "Baking pumpkin pies") : "Going to the oven";
  return "Buying " + (S.job.what === "fuel" ? "fuel for the oven" : BF.itemName(S.job.item).toLowerCase());
}
// For the debug screen (js/debugfeed.js): what it holds to bake with, what it has baked, its oven.
function holdings(m) {
  const c = nm => cnt(m, I(nm)), o = ovenOf(m), rec = o && ovenState(o.x, o.y, o.z);
  return {
    ingredients: { wheat: c("wheat_item"), eggs: c("egg"), milk: c("milk_bottle"), sugar: c("sugar"), cane: c("sugar_cane"), pumpkins: c("pumpkin"), fuel: Math.floor(fuelHeld(m)) },
    goods: { cakes: c("cake"), slices: c("cake_slice"), pies: c("pumpkin_pie"), bottles: c("glass_bottle") },
    oven: rec ? { kind: rec.kind, n: rec.n, lit: rec.burn > 0, fuel: rec.fuel ? rec.fuel.count : 0, ready: rec.out.reduce((a, s) => a + (s.id === I("glass_bottle") ? 0 : s.count), 0) } : null,
    made: m.bkr && m.bkr.made ? Object.assign({}, m.bkr.made) : { cakes: 0, pies: 0 },
  };
}

// ---------------------------------------------------------------- treats for everyone (villagelife.js shopAI, BF.food eat)
const treatHeld = m => cnt(m, I("cake_slice")) + cnt(m, I("pumpkin_pie"));
const hasBaker = R => !!(R && (R.members || []).some(o => live(o) && o.profession === PROF));
// A villager wants a treat: it holds none, ate none and bought none for TREAT_EVERY days, and it has 2 emeralds (1 left for bread).
function treatWanted(m) {
  if (!m || m.child || m.profession === PROF || !m.village || !Array.isArray(m.inv) || skyT() > BUY_BY || !hasBaker(m.village)) return false;
  const L = BF.food && BF.food.life(m), t = now();
  if (!L) return false;
  if (L.tb == null) L.tb = t - Math.random() * TREAT_EVERY;   // first look: spread the village out
  return t - L.tb >= TREAT_EVERY && treatHeld(m) === 0 && cnt(m, I("emerald")) >= 2;
}
// The best treat offer of seller v2 (its job offer or anyone's spare treats): {seller, offer, times: 1, price, item, treat: true} or null.
function treatDeal(m, v2, want) {
  const T = TR(), em = I("emerald"), myEm = cnt(m, em);
  if (!v2 || v2 === m || !Array.isArray(v2.trades) || !Array.isArray(v2.inv) || myEm < 1) return null;
  let best = null;
  for (const o of v2.trades) {
    if (!o || o.feed || o.buy.length !== 1 || o.buy[0].id !== em || !isTreat(o.sell.id) || T.blockReason(v2, o) || o.buy[0].n > myEm - (want == null ? 1 : 0)) continue;
    if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], [{ id: em, n: o.buy[0].n }])) continue;
    const per = BF.food.breadEq(o.sell.id) * o.sell.n, price = o.buy[0].n / per;
    let k = 1;
    if (want != null) { k = Math.min(Math.ceil(want / per), Math.floor(myEm / o.buy[0].n), Math.floor(cnt(v2, o.sell.id) / o.sell.n), 2); while (k > 1 && !T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n * k }], [{ id: em, n: o.buy[0].n * k }])) k--; }
    if (k < 1) continue;
    if (!best || price < best.price) best = { seller: v2, offer: o, times: k, price, item: o.sell.id, treat: true };
  }
  return best;
}
function findTreatSeller(m) {
  const R = m.village, sh = m.fshop, t = now();
  if (!R) return null;
  let best = null, bs = Infinity;
  for (const v2 of R.members || []) {
    if (v2 === m || !live(v2) || v2.sleeping || v2.tradingWith || (sh && (sh.avoid[v2.slot ? v2.slot.idx : -1] || 0) > t)) continue;
    const d = treatDeal(m, v2);
    if (!d) continue;
    const s = v2.position.distanceTo(m.position);
    if (s < bs) { bs = s; best = d; }
  }
  return best;
}
// BF.food eat: the treat it may eat now (one a day), or null.
function treatDue(m) {
  const L = m && m.life;
  return !L || L.tt == null || now() - L.tt >= TREAT_GAP;
}
function ateTreat(m) { const L = BF.food && BF.food.life(m); if (L) L.tt = +now().toFixed(4); }
const treatCounts = m => !!(m && m.life && m.life.tt != null && now() - m.life.tt <= TREAT_HAPPY);

// ---------------------------------------------------------------- the player and cakes
// Right click on a cake: eat a slice (2 hunger, as vanilla), the cake shrinks; the 7th slice takes it. Returns a message or true.
function eatCake(x, y, z, P, creative) {
  const id = BF.world.getBlock(x, y, z), k = cakeBites(id);
  if (k < 0) return false;
  if (P && !creative && P.hunger >= P.maxHunger) return "You aren't hungry";
  if (P) P.hunger = Math.min(P.maxHunger, P.hunger + 2);
  const next = k + 1 >= SLICES ? 0 : BF.B["cake_bitten_" + (k + 1)];
  BF.world.setBlock(x, y, z, next);
  if (BF.emit) BF.emit("playerAteCake", x, y, z, k + 1);
  return true;
}

// ---------------------------------------------------------------- farmers: sugar cane and pumpkins (villagelife.js think / perform)
const CANE_SPOTS = 3;           // the cane plants a farmer keeps (beside water in its beds)
const CANE_CUT = 3;             // it cuts a plant once it is this tall
const WILD_R = 48;              // wild cane it fetches its first plant from, this far from its composter
const SOIL = new Set(["grass", "dirt", "coarse_dirt", "podzol", "snow_grass", "sand", "red_sand"]);
const TILL = new Set(["grass", "dirt", "coarse_dirt", "podzol", "snow_grass"]);
const bname = id => (BF.blocks[id] ? BF.blocks[id].name : "");
const getB = (x, y, z) => BF.world.getBlock(x, y, z);
const besideWater = (x, y, z) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => BF.FLUID[getB(x + dx, y, z + dz)]);
const isFarmland = id => id === BF.B.farmland || (BF.B.farmland_dry != null && id === BF.B.farmland_dry);
const pumpkinsOf = D => D.pumpkins || (D.pumpkins = new Set());
// Height of the cane on (x, y, z) (the soil): blocks of cane from y + 1 up.
function caneHeight(x, y, z) { const c = BF.B.sugar_cane; let h = 0; while (h < 6 && getB(x, y + 1 + h, z) === c) h++; return h; }
// The cells of a farmer's beds: [x, y, z, ground id, above id] for every interior cell.
function bedCells(m, D, H) {
  const out = [];
  for (const b of H.myBeds(m, D)) for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) {
    if (!BF.world.isLoaded(x, z)) continue;
    out.push([x, b.y, z, getB(x, b.y, z), getB(x, b.y + 1, z), b]);
  }
  return out;
}
// The next sugar cane or pumpkin task of farmer m, or null. H: helpers from villagelife.js {myBeds, ok(key), key3, hasHoe}.
function farmTask(m, fs, R, D, H) {
  if (!m.jobsite || BF.B.sugar_cane == null || BF.B.pumpkin == null) return null;
  const T = TR().inv, px = m.position.x, pz = m.position.z, pumpkin = BF.B.pumpkin, stem = BF.B.pumpkin_stem, cane = BF.B.sugar_cane;
  const dist = (x, z) => Math.hypot(x + 0.5 - px, z + 0.5 - pz);
  const P = pumpkinsOf(D), cells = bedCells(m, D, H);
  let best = null, bd = Infinity;
  const pick = (t, extra) => { const k = H.key3(t.x, t.y, t.z); if (!H.ok(k)) return; const d = dist(t.x, t.z) + (extra || 0); if (d < bd) { bd = d; best = Object.assign(t, { k }); } };
  let spots = 0;
  const seeds = cnt(m, I("pumpkin_seeds")) + 4 * cnt(m, I("pumpkin"));
  for (const [x, y, z, g, a] of cells) {
    const gn = bname(g), water = besideWater(x, y, z);
    if (a === pumpkin && T.canFit(m.inv, [{ id: I("pumpkin"), n: 1 }], [])) { pick({ kind: "pumpkin", x, y: y + 1, z, ty: y + 1, soil: y }); continue; }
    if (SOIL.has(gn) && water) {   // a cane spot
      spots++;
      const h = caneHeight(x, y, z);
      if (h >= CANE_CUT && T.canFit(m.inv, [{ id: cane, n: h - 1 }], [])) pick({ kind: "cane", x, y: y + 1, z, ty: y + 1, soil: y });
      else if (h === 0 && a === 0 && cnt(m, cane) > 0) pick({ kind: "caneplant", x, y: y + 1, z, ty: y + 1, soil: y }, 1);
      continue;
    }
    if (a === 0 && seeds > 0 && ((TILL.has(gn) && !water && H.hasHoe(m)) || (isFarmland(g) && P.has(H.key3(x, y, z))))) pick({ kind: "pumpkinplant", x, y: y + 1, z, ty: y + 1, soil: y }, 1);
  }
  if (best) return best;
  // fewer cane spots than it wants: a farmland cell at a channel's end goes back to dirt for cane
  if (spots < CANE_SPOTS && (cnt(m, cane) > 0 || spots > 0 || wildCane(m, D, H))) {
    for (const [x, y, z, g, a, b] of cells) {
      if (!isFarmland(g) || !besideWater(x, y, z) || P.has(H.key3(x, y, z))) continue;
      const end = x === b.x0 || x === b.x1 || z === b.z0 || z === b.z1;   // beside the ring: the channel's end
      if (!end || (a !== 0 && !(BF.blocks[a] && (BF.blocks[a].render === "cross")))) continue;
      pick({ kind: "canespot", x, y, z, ty: y + 1, soil: y });
    }
    if (best) return best;
  }
  // its first cane: from a wild plant near water
  if (spots > 0 && cnt(m, cane) === 0 && !cells.some(c => c[4] === cane)) { const w = wildCane(m, D, H); if (w) return Object.assign(w, { k: H.key3(w.x, w.y, w.z) }); }
  return null;
}
// The nearest wild sugar cane (a plant not in a bed of this village) within WILD_R of the composter: {kind: "canegather", x, y (its bottom), z, ty}.
function wildCane(m, D, H) {
  const s = m.jobsite, cane = BF.B.sugar_cane, now0 = BF.simNow();
  if (D.wildT && D.wildT.t > now0) return D.wildT.v;
  let best = null, bd = Infinity;
  const seen = new Set();
  for (const [wx, wy, wz] of D.water || []) {
    if (Math.abs(wx - s.x) > WILD_R || Math.abs(wz - s.z) > WILD_R) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = wx + dx, z = wz + dz;
      for (let y = wy; y <= wy + 2; y++) {
        if (getB(x, y, z) !== cane || getB(x, y - 1, z) === cane) continue;
        const k = H.key3(x, y, z);
        if (seen.has(k)) continue;
        seen.add(k);
        if ((D.beds || []).some(b => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && Math.abs(b.y + 1 - y) <= 1)) continue;   // a farmer's own plant
        if (!H.ok(k)) continue;
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < bd) { bd = d; best = { kind: "canegather", x, y, z, ty: y }; }
      }
    }
  }
  D.wildT = { t: now0 + 20, v: best };
  return best;
}
// Does a farmer's cane / pumpkin task. Returns false when the cell changed.
function farmPerform(m, t, D, H) {
  const T = TR().inv, W = BF.world, cane = BF.B.sugar_cane, P = pumpkinsOf(D);
  if (!W.isLoaded(t.x, t.z)) return false;
  const vl = (what) => { if (BF.vlog && m.village) { const seen = m.farm && (m.farm.bakeSeen || (m.farm.bakeSeen = {})), s = BF.simNow(); if (!seen || !(s - (seen[what] || -1e9) < 60)) { if (seen) seen[what] = s; BF.vlog.log(m.village, "farm", BF.vlog.nameOf(m) + " (Farmer) " + what + " at " + t.x + ", " + t.y + ", " + t.z, [t.x, t.y, t.z]); } } };
  if (t.kind === "cane" || t.kind === "canegather") {
    const base = t.kind === "cane" ? t.y : t.y;   // the bottom cane block
    let top = base; while (getB(t.x, top + 1, t.z) === cane) top++;
    if (getB(t.x, base, t.z) !== cane) return false;
    const keepBase = t.kind === "cane" || top > base;   // a wild plant keeps its bottom block when it is taller than one
    const lo = keepBase ? base + 1 : base, n = top - lo + 1;
    if (n <= 0 || !T.canFit(m.inv, [{ id: cane, n }], [])) return false;
    for (let y = top; y >= lo; y--) W.setBlock(t.x, y, t.z, 0);   // from the top down, so nothing above pops off
    T.add(m.inv, cane, n);
    log(t.kind === "cane" ? "caneCut" : "caneWild", { n, at: [t.x, t.y, t.z] });
    vl(t.kind === "cane" ? "cut sugar cane" : "gathered wild sugar cane");
    return true;
  }
  if (t.kind === "caneplant") {
    if (getB(t.x, t.y, t.z) !== 0 || !SOIL.has(bname(getB(t.x, t.soil, t.z))) || !besideWater(t.x, t.soil, t.z) || cnt(m, cane) < 1) return false;
    if (!W.setBlock(t.x, t.y, t.z, cane)) return false;
    T.remove(m.inv, cane, 1);
    log("canePlant", { at: [t.x, t.y, t.z] });
    vl("planted sugar cane");
    return true;
  }
  if (t.kind === "canespot") {   // farmland at a channel's end back to dirt (the crop on it comes up first)
    const g = getB(t.x, t.y, t.z), a = getB(t.x, t.y + 1, t.z);
    if (!isFarmland(g)) return false;
    if (a !== 0) { const drops = BF.rollDrops(a); if (!T.canFit(m.inv, drops.map(d => ({ id: d.id, n: d.count })), [])) return false; W.setBlock(t.x, t.y + 1, t.z, 0); for (const d of drops) T.add(m.inv, d.id, d.count); }
    if (!W.setBlock(t.x, t.y, t.z, BF.B.dirt)) return false;
    log("caneSpot", { at: [t.x, t.y, t.z] });
    return true;
  }
  if (t.kind === "pumpkin") {
    if (getB(t.x, t.y, t.z) !== BF.B.pumpkin || !T.canFit(m.inv, [{ id: I("pumpkin"), n: 1 }], [])) return false;
    if (!W.setBlock(t.x, t.y, t.z, 0)) return false;
    T.add(m.inv, I("pumpkin"), 1);
    log("pumpkin", { at: [t.x, t.y, t.z] });
    vl("harvested a pumpkin");
    if (!besideWater(t.x, t.soil, t.z)) { P.add(H.key3(t.x, t.soil, t.z)); if (m.farm) m.farm.next = { kind: "pumpkinplant", x: t.x, y: t.y, z: t.z, ty: t.y, soil: t.soil, k: t.k }; }   // replanted at once
    return true;
  }
  if (t.kind === "pumpkinplant") {
    const g = getB(t.x, t.soil, t.z);
    if (getB(t.x, t.y, t.z) !== 0 || BF.B.pumpkin_stem == null) return false;
    if (cnt(m, I("pumpkin_seeds")) < 1 && cnt(m, I("pumpkin")) > 0 && T.canFit(m.inv, [{ id: I("pumpkin_seeds"), n: 4 }], [{ id: I("pumpkin"), n: 1 }])) { T.remove(m.inv, I("pumpkin"), 1); T.add(m.inv, I("pumpkin_seeds"), 4); log("seeds", {}); }   // cut a pumpkin into seeds
    if (cnt(m, I("pumpkin_seeds")) < 1) return false;
    if (!isFarmland(g)) {
      if (!TILL.has(bname(g)) || !H.hasHoe(m)) return false;
      const fl = BF.farmland ? BF.farmland.tillId(t.x, t.soil, t.z) : BF.B.farmland;
      if (!W.setBlock(t.x, t.soil, t.z, fl)) return false;
      if (BF.toolWear) BF.toolWear.use(m, BF.toolWear.best(m, "hoe"), 1);
    }
    if (!W.setBlock(t.x, t.y, t.z, BF.B.pumpkin_stem)) return false;
    T.remove(m.inv, I("pumpkin_seeds"), 1);
    P.add(H.key3(t.x, t.soil, t.z));
    log("pumpkinPlant", { at: [t.x, t.y, t.z] });
    return true;
  }
  return false;
}
const FARM_KINDS = { cane: 0.6, canegather: 0.6, caneplant: 0.45, canespot: 0.9, pumpkin: 0.7, pumpkinplant: 0.6 };
const FARM_NAMES = { cane: "Cutting sugar cane", canegather: "Gathering sugar cane", caneplant: "Planting sugar cane", canespot: "Making room for sugar cane", pumpkin: "Harvesting pumpkins", pumpkinplant: "Planting pumpkins" };

// ---------------------------------------------------------------- persistence, hooks
function exportAll(out) {
  const arr = [];
  const pack = s => [nameOf(s.id), s.count];
  for (const o of ovens.values()) if (!empty(o)) arr.push({ p: [o.pos.x, o.pos.y, o.pos.z], k: o.kind, n: o.n, t: o.tray.map(pack), f: o.fuel ? pack(o.fuel) : null, o: o.out.map(pack), b: +o.burn.toFixed(2), bm: o.burnMax, c: +o.cook.toFixed(2) });
  if (arr.length) out.ovens = arr;
}
function importAll(o) {
  ovens.clear();
  if (!o || !Array.isArray(o.ovens)) return;
  const unpack = a => { const id = Array.isArray(a) ? BF.I[a[0]] : undefined; return id != null && a[1] > 0 ? { id, count: Math.floor(a[1]) } : null; };
  for (const e of o.ovens) {
    if (!e || !Array.isArray(e.p) || e.p.length !== 3) continue;
    const r = ovenAt(e.p[0] | 0, e.p[1] | 0, e.p[2] | 0);
    r.kind = e.k === "cake" || e.k === "pie" ? e.k : null; r.n = Math.max(0, e.n | 0);
    r.tray = (e.t || []).map(unpack).filter(Boolean); r.fuel = e.f ? unpack(e.f) : null; r.out = (e.o || []).map(unpack).filter(Boolean);
    r.burn = +e.b || 0; r.burnMax = +e.bm || 0; r.cook = +e.c || 0;
  }
}
let hooked = false;
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("blockBroken", (x, y, z, id) => { if (isOven(id)) dropOven(x, y, z); });
  BF.on("newWorld", () => { ovens.clear(); LOG.length = 0; });
  // a treat sold to a villager: the village log, and the buyer's last treat purchase
  BF.on("villagerFoodTrade", (buyer, seller, item, n) => {
    if (!isTreat(item) || !buyer) return;
    const L = BF.food && BF.food.life(buyer);
    if (L) L.tb = +now().toFixed(4);
    if (seller && seller.profession === PROF) { log("sold", { item: nameOf(item), n }); vlog(seller, "sold " + plural(n, item === I("cake_slice") ? "cake slice" : "pumpkin pie") + " to " + who(buyer), seller); }
  });
  BF.on("villagerTrade", (v, o) => { if (v && v.profession === PROF && o && o.sell && (isTreat(o.sell.id) || o.sell.id === I("cake"))) vlog(v, "sold " + plural(o.sell.n, BF.itemName(o.sell.id).toLowerCase()) + " to the player", v); });
}
function tick() { hook(); }
function reset() { ovens.clear(); LOG.length = 0; }

// ---------------------------------------------------------------- sprites and recipes
if (BF.texKit) {
  const { SPRITES, put, hex, mul, lighten } = BF.texKit;
  SPRITES.sugar = G => {   // a little heap of white crystals
    for (let y = 7; y < 15; y++) for (let x = 2; x < 14; x++) {
      const d = Math.hypot((x + 0.5 - 8) / 6, (y + 0.5 - 14) / 7);
      if (d > 1) continue;
      put(G, x, y, (x * 7 + y * 3) % 5 === 0 ? hex("#d8d8e0") : (x + y) % 4 === 0 ? hex("#ffffff") : hex("#eeeef2"));
    }
  };
  SPRITES.pumpkin_seeds = G => {
    for (const [cx, cy] of [[5, 5], [10, 4], [4, 10], [9, 9], [12, 12], [7, 13]]) for (let y = -2; y <= 2; y++) for (let x = -1; x <= 1; x++) {
      if (Math.abs(x) + Math.abs(y) > 2) continue;
      put(G, cx + x, cy + y, y === -2 || x === 1 ? hex("#c8b878") : hex("#eee2b0"));
    }
  };
  SPRITES.pumpkin_pie = G => {   // a round pie: crust rim, orange filling, a lattice line
    for (let y = 4; y < 14; y++) for (let x = 1; x < 15; x++) {
      const d = Math.hypot((x + 0.5 - 8) / 7, (y + 0.5 - 9) / 5);
      if (d > 1) continue;
      put(G, x, y, d > 0.78 ? (y > 10 ? hex("#9a5a22") : hex("#c88a42")) : (x + y) % 5 === 0 ? hex("#b8641a") : hex("#e0842a"));
    }
    for (let x = 4; x <= 11; x++) put(G, x, 8, hex("#d8a058"));
  };
  SPRITES.cake_slice = G => {   // a wedge: white icing, red dots, sponge below
    for (let y = 5; y < 14; y++) for (let x = 2; x < 14; x++) {
      if (x - 2 < (13 - y) * 0.3 && y < 9) continue;
      const top = y < 8;
      put(G, x, y, top ? ((x * 3 + y) % 7 === 0 ? hex("#d02a2a") : hex("#fbf8f2")) : y === 8 ? hex("#e8dcc8") : hex(y % 2 ? "#c88a4a" : "#d69a5a"));
    }
  };
}
(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, addShapeless }) => {
  const R = BF.I;
  if (R.sugar != null && R.sugar_cane != null) addShapeless(R.sugar, 1, [R.sugar_cane], "Sugar Cane → Sugar");
  if (R.pumpkin_seeds != null && R.pumpkin != null) addShapeless(R.pumpkin_seeds, 4, [R.pumpkin], "Pumpkin → 4 Pumpkin Seeds");
  if (R.pumpkin_pie != null && R.pumpkin != null && R.egg != null && R.sugar != null) addShapeless(R.pumpkin_pie, 1, [R.pumpkin, R.sugar, R.egg], "Pumpkin + Sugar + Egg → Pumpkin Pie");
  if (R.cake != null && R.sugar != null && R.egg != null && R.wheat_item != null && R.milk_bottle != null)
    addShaped(R.cake, 1, ["MMM", "SES", "WWW"], { M: [R.milk_bottle, R.milk_bucket], S: R.sugar, E: R.egg, W: R.wheat_item }, "3 Milk (bottles or buckets) over Sugar, Egg, Sugar over 3 Wheat → Cake (the bottles or buckets come back empty)");
  if (R.bakers_oven != null && R.cobblestone != null && R.iron_ingot != null) addShaped(R.bakers_oven, 1, ["CCC", "CIC", "CCC"], { C: R.cobblestone, I: R.iron_ingot }, "8 Cobblestone around 1 Iron Ingot → Baker's Oven (baker)");
});

BF.baker = {
  PROF, PER_VILLAGERS, BAKE_T, RECIPE, SLICES, SLICE_CAP, PIE_CAP, TREAT_EVERY, TREAT_GAP, TREAT_HAPPY, CANE_SPOTS, FARM_KINDS, FARM_NAMES,
  ovens, ovenAt, ovenState, tickOven, ovenRemoved: dropOven, simTick, load, topUp, unload, ovenText, isOven, isCake, cakeBites, eatCake, isTreat,
  canMake, reserve, farmerReserve, keepsFood, fuelOk, mayHire, makeSugar, slice, nextJob, shopping, ai, statusText, holdings,
  treatWanted, treatDeal, findTreatSeller, treatDue, ateTreat, treatCounts,
  farmTask, farmPerform, caneHeight, wildCane,
  exportAll, importAll, tick, reset, log: LOG,
};
})();
