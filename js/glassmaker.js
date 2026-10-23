// Glassmakers (BF.glassmaker): profession "glassmaker", jobsite the glass kiln (blocks.js "glassmaker pack"). Loaded after js/baker.js; hooks
// live in jobs.js (jobsite, hire kit), mobs.js (outfit, roster, jobsAI), trading.js (offers), market.js (reserve), villagelife.js (status),
// villagesim.js (forced stop), storage.js, worldgen.js (sandNear, pane windows), builder.js / blueprints.js (the glassworks). See CONTRACT.md
// "Glassmakers".
// During work hours the glassmaker:
// - digs sand: the top layer of natural sand open to the sky within DIG_R blocks of its village or its kiln (beaches, river banks, desert), never
//   a placed block, nothing under or beside water, nothing on the village's buildings, plots, roads, farm beds or built structures; one layer
//   only (the cell above must be natural air, so a dug spot is never dug deeper) and at most DIG_DAY a day, with a shovel when it has one;
// - buys sand from anyone in the village who has spare (and from the player, its table), at the seller's own offer;
// - smelts its sand into glass in a furnace of its village (the shared furnace routine, js/furnaceuse.js: the one beside its kiln first), with
//   fuel it holds or buys (coal or charcoal first, then logs and planks);
// - crafts glass into bottles (3 -> 3) and panes (6 -> 16) at its kiln: bottles enough for every cowherd's empties gap, panes for the builders'
//   current and next structures, the rest stays glass.
// It sells glass, panes and bottles (trading.js), keeping back its sand and fuel (reserve). Nothing is restocked: every glass item comes from sand
// it dug or bought, smelted with real fuel.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PROF = "glassmaker";
const DIG_R = 64;                 // sand it digs lies within this many blocks of its village centre or its kiln
const DIG_DAY = 64;               // a stack a day at most, so beaches don't vanish
const DIG_TRIP = 16;              // blocks one digging trip takes
const DIG_T = 0.8, DIG_T_HAND = 2.0;   // seconds a block takes with a shovel / by hand
const SAND_WANT = 24;             // it gathers sand while it holds less than this ...
const SAND_MAX = 64;              // ... and never holds more than this
const SMELT_MIN = 8, SMELT_MAX = 20;   // a furnace load: at least 8 sand (fewer late in the day), at most 20 (200 s of fire)
const GLASS_CAP = 48;             // it stops making glass while it holds this much (in glass: panes 6/16, bottles 1 each)
const BOTTLE_STOCK = 9, PANE_STOCK = 16, BOTTLE_GAP_MAX = 27;
const DAY_SECS = 1200, WORK_START = 0.02, WORK_END = 0.45, LATE = 0.36, CHECK = 3, TRADE_PAUSE = 1.6, CRAFT_T = 2.5;

const RS = e => BF.rand.of(e);   // seeded random streams (js/rand.js)
const rnd = (r, a, b) => r.range(a, b);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const FU = () => BF.furnaceUse;
const W = () => BF.world;
const I = n => BF.I[n];
const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const cnt = (m, id) => (id == null || !m || !Array.isArray(m.inv) ? 0 : TR().inv.count(m.inv, id));
const pk = (x, y, z) => x + "," + y + "," + z;
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
const LOG = [];
const log = (kind, data) => { LOG.push(BF.glog.job("glassmaker", Object.assign({ kind, day: +now().toFixed(3) }, data))); if (LOG.length > 300) LOG.shift(); };
const who = m => (BF.vlog && BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Villager") + " (Glassmaker)";
const vlog = (m, kind, text, where) => { if (BF.vlog && m && m.village) BF.vlog.log(m.village, kind, who(m) + " " + text, where || m); };
const isKiln = id => id != null && id === BF.B.glass_kiln;
const kilnOf = m => (m.jobsite && W().isLoaded(m.jobsite.x, m.jobsite.z) && isKiln(W().getBlock(m.jobsite.x, m.jobsite.y, m.jobsite.z)) ? m.jobsite : null);
// Glass it holds, counting panes (16 from 6 glass) and bottles (3 from 3).
const glassEq = m => cnt(m, I("glass")) + cnt(m, I("glass_pane")) * 6 / 16 + cnt(m, I("glass_bottle"));

// ---------------------------------------------------------------- sand in the ground
const SAND = () => BF.B.sand;
// Was the block at (x, y, z) placed or removed by someone (a world edit), rather than generated?
function edited(x, y, z) {
  const CS = BF.CS, cx = Math.floor(x / CS), cz = Math.floor(z / CS), e = W().edits.get(cx + "," + cz);
  if (!e) return false;
  const lx = x - cx * CS, lz = z - cz * CS;
  return e.has(((y - BF.MIN_Y) * CS + lz) * CS + lx);
}
const inR = (r, x, z, mg) => x >= r[0] - mg && x <= r[2] + mg && z >= r[1] - mg && z <= r[3] + mg;
// The village's own ground (buildings, plots, roads, lamps, farm beds, built structures): rects [x0, z0, x1, z1] with a margin.
function keepOut(R) {
  const now0 = BF.simNow ? BF.simNow() : 0;
  if (R._glassKeep && R._glassKeep.t > now0) return R._glassKeep.v;
  const out = [], wg = R.wg;
  if (wg) {
    for (const b of wg.buildings || []) out.push([b.x0 - 2, b.z0 - 2, b.x1 + 2, b.z1 + 2]);
    for (const p of wg.pads || []) out.push([p.x0 - 1, p.z0 - 1, p.x1 + 1, p.z1 + 1]);
    for (const r of wg.roads || []) out.push([r.x0 - 1, r.z0 - 1, r.x1 + 1, r.z1 + 1]);
    for (const l of wg.lamps || []) out.push([l[0] - 1, l[1] - 1, l[0] + 1, l[1] + 1]);
  }
  if (BF.builder && BF.builder.builtOf) for (const e of BF.builder.builtOf(R)) if (e.state !== "abandoned") out.push([e.ox - 2, e.oz - 2, e.ox + e.w + 1, e.oz + e.d + 1]);
  if (BF.villageLife && BF.villageLife.bedRects) for (const r of BF.villageLife.bedRects(R)) out.push([r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1]);
  R._glassKeep = { t: now0 + 30, v: out };
  return out;
}
// Can the glassmaker dig the sand at the top of column (x, z)? Returns its y, or null.
function digY(R, x, z, keep) {
  const w = W();
  if (!w.isLoaded(x, z)) return null;
  const y = w.heightAt(x, z);
  if (w.getBlock(x, y, z) !== SAND() || w.getBlock(x, y + 1, z) !== 0) return null;
  if (!BF.SOLID[w.getBlock(x, y - 1, z)]) return null;                       // the ground stays: one layer, and nothing falls
  if (edited(x, y, z) || edited(x, y + 1, z)) return null;                    // placed sand, or a spot already dug (its air is an edit)
  for (const [dx, dz] of BF.DIRS) for (const dy of [0, 1]) if (BF.FLUID[w.getBlock(x + dx, y + dy, z + dz)]) return null;   // beside water: it would flood
  if ((keep || keepOut(R)).some(r => inR(r, x, z, 0))) return null;
  return y;
}
const inDigRange = (R, m, x, z) => Math.hypot(x - R.x, z - R.z) <= DIG_R || (m.jobsite && Math.hypot(x - m.jobsite.x, z - m.jobsite.z) <= DIG_R);
// Up to n spots to dig near (x0, z0) (a square of radius r around it), nearest first: [{x, y, z}].
function spotsAround(m, x0, z0, r, n) {
  const R = m.village, keep = keepOut(R), out = [];
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.floor(x0) + dx, z = Math.floor(z0) + dz;
    if (!inDigRange(R, m, x, z)) continue;
    const y = digY(R, x, z, keep);
    if (y != null) out.push({ x, y, z, d: Math.hypot(dx, dz) });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, n);
}
// Where to dig next: around the last spot it dug when sand is left there, else the nearest of a random sample around the village. null: none.
function findDig(m) {
  const S = st(m), R = m.village;
  if (!R) return null;
  if (S.last) { const near = spotsAround(m, S.last.x, S.last.z, 4, DIG_TRIP); if (near.length) return near; }
  if (S.noSand > now()) return null;
  const keep = keepOut(R), cands = [];
  const cx = m.jobsite ? (m.jobsite.x + R.x) / 2 : R.x, cz = m.jobsite ? (m.jobsite.z + R.z) / 2 : R.z;
  for (let i = 0; i < 500 && cands.length < 24; i++) {
    const a = RS(m).next() * Math.PI * 2, d = Math.sqrt(RS(m).next()) * DIG_R;
    const x = Math.floor(cx + Math.cos(a) * d), z = Math.floor(cz + Math.sin(a) * d);
    if (!inDigRange(R, m, x, z)) continue;
    const y = digY(R, x, z, keep);
    if (y != null) cands.push({ x, y, z, d: Math.hypot(x - m.position.x, z - m.position.z) });
  }
  if (!cands.length) { S.noSand = now() + 0.08; return null; }   // nothing found: look again in a while
  cands.sort((a, b) => a.d - b.d);
  const near = spotsAround(m, cands[0].x, cands[0].z, 4, DIG_TRIP);
  return near.length ? near : null;
}

// ---------------------------------------------------------------- what it makes
// Bottles it keeps in stock: a few for sale and every cowherd's empties gap (js/cowherd.js bottleWanted).
function bottleTarget(m) {
  let gap = 0;
  for (const v of (m.village && m.village.members) || []) if (live(v) && v.profession === "cowherd" && BF.cowherd && BF.cowherd.bottleWanted) gap += BF.cowherd.bottleWanted(v);
  return BOTTLE_STOCK + Math.min(gap, BOTTLE_GAP_MAX);
}
// Panes it keeps in stock: a few for sale and what the builders still lack for their current and next structures (js/builder.js reserve).
function paneTarget(m) {
  const P = I("glass_pane");
  let need = 0;
  for (const v of (m.village && m.village.members) || []) {
    if (!live(v) || v.profession !== "builder" || !BF.builder || !BF.builder.reserve || !Array.isArray(v.inv)) continue;
    const r = BF.builder.reserve(v) || {};
    need += Math.max(0, (r[P] || 0) - cnt(v, P));
  }
  return PANE_STOCK + Math.min(need, 64);
}
// The next craft: {what: "bottles" | "panes", times} or null.
// When both are short it takes turns (the glass of one load goes half to each), so neither the cowherds nor the builders wait on the other.
function craftPlan(m) {
  const g = cnt(m, I("glass")), T = TR().inv, S = st(m), plans = [];
  const bWant = I("glass_bottle") != null ? bottleTarget(m) - cnt(m, I("glass_bottle")) : 0, pWant = I("glass_pane") != null ? paneTarget(m) - cnt(m, I("glass_pane")) : 0;
  const both = bWant > 0 && pWant > 0 && g >= 9;
  if (bWant > 0 && g >= 3) {
    let k = Math.min(Math.floor((both ? Math.max(3, g - 6) : g) / 3), Math.ceil(bWant / 3));
    if (both) k = Math.min(k, Math.max(1, Math.floor(g / 6)));
    while (k > 0 && !T.canFit(m.inv, [{ id: I("glass_bottle"), n: 3 * k }], [{ id: I("glass"), n: 3 * k }])) k--;
    if (k > 0) plans.push({ what: "bottles", times: k });
  }
  if (pWant > 0 && g >= 6) {
    let k = Math.min(Math.floor(g / 6), Math.ceil(pWant / 16));
    if (both) k = Math.min(k, Math.max(1, Math.floor(g / 12)));
    while (k > 0 && !T.canFit(m.inv, [{ id: I("glass_pane"), n: 16 * k }], [{ id: I("glass"), n: 6 * k }])) k--;
    if (k > 0) plans.push({ what: "panes", times: k });
  }
  if (plans.length > 1 && S.lastCraft === plans[0].what) plans.reverse();
  return plans[0] || null;
}
function craft(m, plan) {
  const T = TR().inv;
  const [out, per, use] = plan.what === "bottles" ? [I("glass_bottle"), 3, 3] : [I("glass_pane"), 16, 6];
  let done = 0;
  for (let i = 0; i < plan.times; i++) {
    if (cnt(m, I("glass")) < use || !T.canFit(m.inv, [{ id: out, n: per }], [{ id: I("glass"), n: use }])) break;
    T.remove(m.inv, I("glass"), use); T.add(m.inv, out, per); done++;
  }
  if (done) {
    const S = st(m); S.made = S.made || { glass: 0, panes: 0, bottles: 0 };
    S.made[plan.what] += done * per; S.lastCraft = plan.what;
    log("craft", { what: plan.what, n: done * per });
    vlog(m, "glass", "made " + plural(done * per, plan.what === "bottles" ? "glass bottle" : "glass pane") + " at the glass kiln", m.jobsite || m);
  }
  return done;
}

// ---------------------------------------------------------------- fuel and furnaces
const fuelOk = m => id => FU().isFuel(id) && !(m.trades || []).some(o => o && !o.spare && !o.need && o.sell && o.sell.id === id);   // any fuel but a ware of its own (none)
const avoided = (S, k) => (S.avoid[k] || 0) > now();
const skipFurnace = S => f => avoided(S, "f:" + pk(f.x, f.y, f.z));
const skipOffer = S => (v2, o) => avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id);
// Its market reserve (js/market.js): the sand it holds and fuel for a few loads. Its glass, panes and bottles are for sale.
function reserve(m) {
  const out = [];
  if (!m || m.profession !== PROF || !Array.isArray(m.inv)) return out;
  if (cnt(m, SAND()) > 0) out.push({ ids: new Set([SAND()]), n: cnt(m, SAND()) });
  const fuel = new Set(); for (const s of m.inv) if (s && FU() && FU().isFuel(s.id)) fuel.add(s.id);
  if (fuel.size) out.push({ ids: fuel, n: 16 });
  return out;
}
// How it would smelt n sand: {furnace} or {need: {f, n, what}} (fuel to buy first), or null (no furnace, no fuel to be had).
function smeltPlan(m, n) {
  const F = FU(), S = st(m), sand = SAND(), glass = I("glass");
  const fs = F.near(m, sand, glass, skipFurnace(S), kilnOf(m));
  if (!fs.length) { S.wait = "furnace"; return null; }
  const f = fs[0], ok = fuelOk(m);
  if (F.fuelIn(f) >= n || F.fuelFor(m, Math.max(0, n - F.fuelIn(f)), ok).length) return { furnace: f };
  const em = cnt(m, I("emerald")), coal = Math.ceil(n / F.PER_COAL);
  if (F.priceOf(m, F.isCoal, coal, false, skipOffer(S)) <= em) { const d = F.findDeal(m, { what: "fuel", f: F.isCoal, n: coal }, skipOffer(S)); if (d) return { need: d }; }
  const wood = id => (F.isLog(id) || F.isPlanks(id)) && ok(id), w = Math.ceil(n / F.PER_WOOD);
  const d = F.findDeal(m, { what: "fuel", f: wood, n: w }, skipOffer(S));
  if (d) return { need: d };
  // part of a load with the fuel it has
  let have = 0; for (const s of m.inv) if (s && ok(s.id)) have += s.count * F.fuelWorth(s.id);
  if (have + F.fuelIn(f) >= 1) return { furnace: f, n: Math.max(1, Math.floor(have + F.fuelIn(f))) };
  S.wait = "fuel";
  return null;
}

// ---------------------------------------------------------------- the glassmaker's day
const st = m => m.gls || (m.gls = { stage: null, job: null, checkT: rnd(RS(m), 1, 4), avoid: {}, cd: 0, day: -1, dug: 0, wait: "" });
function nextJob(m) {
  const S = st(m), sand = cnt(m, SAND()), late = skyT() > LATE;
  S.wait = "";
  if (Math.floor(now()) !== S.day) { S.day = Math.floor(now()); S.dug = 0; }
  // crafting: glass into the bottles and panes the village needs
  const cp = craftPlan(m);
  if (cp) return { kind: "craft", at: kilnOf(m), plan: cp };
  // smelting: a load of sand (fewer late in the day)
  if (glassEq(m) < GLASS_CAP && (sand >= SMELT_MIN || (late && sand > 0))) {
    const n = Math.min(sand, SMELT_MAX), p = smeltPlan(m, n);
    if (p && p.need) return p.need;
    if (p) return { kind: "smelt", furnace: p.furnace, rawId: SAND(), outId: I("glass"), n: p.n ? Math.min(n, p.n) : n, fuelOk: fuelOk(m) };
  }
  // sand: dig it, else buy it
  if (sand < SAND_WANT && glassEq(m) < GLASS_CAP && !late) {
    if (S.dug < DIG_DAY && TR().inv.canFit(m.inv, [{ id: SAND(), n: 8 }], [])) {
      const spots = findDig(m);
      if (spots) return { kind: "dig", spots: spots.slice(0, Math.min(DIG_TRIP, DIG_DAY - S.dug, SAND_MAX - sand)) };
    }
    if (!avoided(S, "want:sand")) {
      const d = FU().findDeal(m, { what: "sand", f: id => id === SAND(), n: SAND_WANT - sand }, skipOffer(S));
      if (d) return d;
      S.avoid["want:sand"] = now() + 0.05;
    }
    if (!S.wait && sand < SMELT_MIN) S.wait = "sand";
  }
  return null;
}
const vdone = m => { if (BF.villageSim && BF.villageSim.done) BF.villageSim.done(m); };
function finishSmelt(m, job, all) {
  FU().empty(m, job, all, got => {   // when the "furnace" request applies (js/furnaceuse.js)
    const glass = got.filter(e => e.id === I("glass")).reduce((a, e) => a + e.n, 0), back = got.filter(e => e.id === SAND()).reduce((a, e) => a + e.n, 0);
    const S = st(m); S.made = S.made || { glass: 0, panes: 0, bottles: 0 }; S.made.glass += glass;
    log("collect", { glass, loaded: job.loaded || 0, all: !!all, back });
    if (glass > 0) vlog(m, "furnace", "smelted " + glass + " glass from sand in the furnace at " + pk(job.furnace.x, job.furnace.y, job.furnace.z), job.furnace);
  });
}
function estimate(m, job) {
  const VS = BF.villageSim;
  const to = job.kind === "dig" ? [job.spots[0].x + 0.5, job.spots[0].z + 0.5] : job.kind === "smelt" ? [job.furnace.x + 0.5, job.furnace.z + 0.5]
    : job.kind === "craft" ? (job.at ? [job.at.x + 0.5, job.at.z + 0.5] : null) : job.other && job.other.position ? [job.other.position.x, job.other.position.z] : null;
  const walk = to && VS && VS.walkSecs ? VS.walkSecs(m, [to]) : 0;
  const work = job.kind === "dig" ? job.spots.length * (DIG_T + 1) : job.kind === "smelt" ? TRADE_PAUSE + FU().COOK * job.n : job.kind === "craft" ? CRAFT_T : TRADE_PAUSE;
  return walk + work;
}
const label = job => job.kind === "dig" ? "Digging sand" : job.kind === "smelt" ? "Smelting glass" : job.kind === "craft" ? (job.plan.what === "bottles" ? "Making bottles" : "Making panes")
  : job.what === "sand" ? "Buying sand" : "Buying fuel";
// Villager AI step (mobs.js jobsAI: early with cont = true to carry on what it started, and after the other trades with cont = false).
function ai(m, dt, out, cont) {
  if (m.profession !== PROF) return false;
  if (cont && !(m.gls && m.gls.stage)) return false;
  if (!m.inv || m.dead || m.child || m.type !== "villager" || !BF.mobs || !BF.mobs.nav || !m.village || !FU() || m.sleeping || SAND() == null) return false;
  const F = FU(), S = st(m), a = m.ai, t = skyT();
  if (t >= WORK_END || t < WORK_START || m.tradingWith) {
    if (S.stage) { if (S.job && S.job.kind === "smelt" && S.job.loaded) finishSmelt(m, S.job, true); S.stage = null; S.job = null; vdone(m); a.route = null; }
    return false;
  }
  if (!S.stage) {
    if (cont) return false;
    S.checkT -= dt;
    if (S.checkT > 0) return false;
    S.checkT = CHECK;
    if (S.cd > now()) return false;
    const job = nextJob(m);
    if (!job) { S.cd = now() + 0.02; return false; }
    // only work that ends before the working day does: a smelt takes fewer sand, anything else waits for tomorrow
    const left = (WORK_END - t) * DAY_SECS;
    if (job.kind === "smelt" && estimate(m, job) > left) job.n = Math.floor((left - (estimate(m, job) - FU().COOK * job.n)) / FU().COOK);
    if ((job.kind === "smelt" && job.n < 1) || estimate(m, job) > left) { S.cd = now() + 0.02; return false; }
    const VS = BF.villageSim;
    if (VS && VS.begin && !VS.begin(m, estimate(m, job), label(job))) return false;
    S.job = job; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; S.si = 0; a.route = null;
    if (job.kind === "dig") S.trip = 0;
  }
  const job = S.job;
  const giveUp = (why, key) => {
    log("giveup", { kind: job.kind, why });
    if (key) S.avoid[key] = now() + 0.05;
    if (job.kind === "smelt" && job.loaded) finishSmelt(m, job, true);
    S.stage = null; S.job = null; vdone(m); a.route = null; S.checkT = 0.5; return false;
  };
  const done = () => { S.stage = null; S.job = null; vdone(m); a.route = null; S.checkT = 0.5; return true; };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  // ---- digging sand: one spot after another, standing beside each
  if (job.kind === "dig") {
    while (S.si < job.spots.length && digY(m.village, job.spots[S.si].x, job.spots[S.si].z) !== job.spots[S.si].y) S.si++;   // gone meanwhile
    if (S.si >= job.spots.length || !TR().inv.canFit(m.inv, [{ id: SAND(), n: 1 }], [])) {
      if (S.trip) { vlog(m, "glass", "dug " + plural(S.trip, "block") + " of sand at " + pk(S.last.x, S.last.y, S.last.z), [S.last.x, S.last.y, S.last.z]); log("dig", { n: S.trip, at: [S.last.x, S.last.y, S.last.z] }); }
      return done();
    }
    const s = job.spots[S.si];
    const near = (x, y, z) => Math.max(Math.abs(x - s.x), Math.abs(z - s.z)) <= 1 && !(x === s.x && z === s.z) && Math.abs(y - (s.y + 1)) <= 1;
    if (S.stage === "walk") {
      if (S.walkT > 60) { S.si++; S.walkT = 0; a.route = null; return true; }
      const r = F.travel(m, S, dt, out, s.x, s.y + 1, s.z, m.def.speed * 1.2, near, "glass");
      if (r === "failed") { S.si++; S.walkT = 0; return true; }
      if (r === "arrived") { S.stage = "dig"; S.tt = BF.toolWear && BF.toolWear.best(m, "shovel") ? DIG_T : DIG_T_HAND; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { position: { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5 }, height: 0 };
    if (Math.random() < dt * 4) a.swingT = 0.25;   // visual
    if ((S.tt -= dt) > 0) return true;
    const [fx, fy, fz] = BF.mobs.nav.feetCell(m);
    if (!(fx === s.x && fz === s.z) && W().getBlock(s.x, s.y, s.z) === SAND()) {
      // a request (spec r15-19, js/blockreqs.js): the sand leaves the ground and goes into the pack in the apply phase; counted at once
      // (the day's quota) and taken back if someone else had the block first
      S.dug++; S.trip++; S.last = { x: s.x, y: s.y, z: s.z };
      BF.blockReq.cells(m, [{ x: s.x, y: s.y, z: s.z, id: 0, expect: SAND() }], { give: [{ id: SAND(), n: 1 }] }).then(r => {
        if (!r.ok) { S.dug--; S.trip = Math.max(0, S.trip - 1); log("refused", { at: [s.x, s.y, s.z], why: r.why }); return; }
        if (BF.toolWear) { const sh = BF.toolWear.best(m, "shovel"); if (sh) BF.toolWear.use(m, sh, 1); }
      });
    }
    S.si++; S.walkT = 0; S.stage = "walk";
    if (S.dug >= DIG_DAY) S.si = job.spots.length;
    return true;
  }
  // ---- crafting at the kiln
  if (job.kind === "craft") {
    const k = job.at && kilnOf(m);
    if (k && S.stage === "walk") {
      if (S.walkT > 60) return giveUp("timeout");
      const r = F.travel(m, S, dt, out, k.x, k.y, k.z, m.def.speed * 1.2, F.beside(k), "glass");
      if (r === "failed") return giveUp("no path");
      if (r !== "arrived") return true;
      S.stage = "work"; S.tt = CRAFT_T;
    } else if (S.stage === "walk") { S.stage = "work"; S.tt = CRAFT_T; }
    if (k) { out.faceX = k.x + 0.5; out.faceZ = k.z + 0.5; }
    if (Math.random() < dt * 3) a.swingT = 0.2;   // visual
    if ((S.tt -= dt) > 0) return true;
    craft(m, job.plan);
    return done();
  }
  // ---- smelting sand in a furnace
  if (job.kind === "smelt") {
    const s = job.furnace, fkey = "f:" + pk(s.x, s.y, s.z);
    const go = () => F.travel(m, S, dt, out, s.x, s.y, s.z, m.def.speed * 1.2, F.beside(s), "glass");
    if (S.stage === "walk") {
      if (S.walkT > 90) return giveUp("timeout", fkey);
      if (!F.usable(m, s, job.rawId, job.outId)) return giveUp("furnace busy", fkey);
      const r = go();
      if (r === "failed") return giveUp("no path", fkey);
      if (r === "arrived") { S.stage = "work"; S.tt = TRADE_PAUSE; S.waitT = 0; }
      return true;
    }
    if (S.stage === "cook" && Math.hypot(s.x + 0.5 - m.position.x, s.z + 0.5 - m.position.z) > 3) {
      if (go() === "failed") { F.inUse.delete(pk(s.x, s.y, s.z)); log("giveup", { kind: "smelt", why: "cannot get back", left: job.loaded }); S.stage = null; S.job = null; a.route = null; vdone(m); return false; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { yaw: 0, pitch: -0.4 };
    if (S.stage === "work") {
      if ((S.tt -= dt) > 0) { if (Math.random() < dt * 3) a.swingT = 0.2; return true; }   // visual
      const n = F.load(m, job, job.n);
      if (n === null) return true;   // the load request is in flight
      if (!n) return giveUp("furnace busy", fkey);
      S.stage = "cook";
      log("load", { sand: n, at: pk(s.x, s.y, s.z), ownFuel: job.ownFuel || 0 });
      return true;
    }
    const fs = BF.inventory.furnaceState(s.x, s.y, s.z);
    if (!fs || !BF.isFurnace(W().getBlock(s.x, s.y, s.z))) { F.inUse.delete(pk(s.x, s.y, s.z)); return giveUp("furnace gone", fkey); }
    S.waitT += dt;
    if (!fs.slots[0] || fs.slots[0].id !== job.rawId) { finishSmelt(m, job, false); return done(); }   // all smelted
    const fueling = F.topUp(m, job, fs);
    if (S.waitT > F.COOK * 1.5 * job.loaded + 40 || (fs.burn <= 0 && !fs.slots[1] && !fueling && S.waitT > 3)) return giveUp(fs.burn <= 0 && !fs.slots[1] ? "out of fuel" : "too slow");
    if (Math.random() < dt * 0.5) a.swingT = 0.2;   // visual
    return true;
  }
  // ---- buying sand or fuel at the seller's own offer
  const v2 = job.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + job.item;
  if (!F.canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage === "walk") {
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "glass") a.route = null; S.gx = g.x; S.gz = g.z; }
    if (F.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.3, null, "glass") === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;   // visual
  if (S.tt <= 0) {
    const n = F.doBuy(m, job);
    if (n == null) return true;   // the trade is in flight (js/trading.js buy)
    S.gx = null;
    if (n) log("buy", { what: nameOf(job.item), n: n * job.offer.sell.n, from: v2.profession });
    else { S.avoid[key] = now() + 0.05; log("giveup", { kind: "buy", why: "trade refused" }); }
    return done();
  }
  return true;
}
if (BF.furnaceUse) BF.furnaceUse.busyWhen(u => !!(u.gls && u.gls.stage === "cook"));   // it holds the furnace while its sand smelts

// Status line (js/villagelife.js statusText): what it is doing, or what it waits for.
function statusText(m) {
  const S = m && m.gls;
  if (!S || m.sleeping) return "";
  if (S.stage && S.job) {
    if (S.job.kind === "smelt") return S.stage === "cook" ? "Smelting glass" : "Taking sand to a furnace";
    return label(S.job);
  }
  const t = skyT();
  if (t >= WORK_END || t < WORK_START) return "";
  return S.wait === "fuel" ? "Waiting for fuel" : S.wait === "sand" ? "Waiting for sand" : S.wait === "furnace" ? "Waiting for a furnace" : "";
}
// A forced stop (js/villagesim.js): takes its sand, the glass and the fuel out of the furnace. Returns what it did, or null.
function forceStop(m) {
  const S = m.gls;
  if (!S || !S.job) return null;
  const loaded = S.job.kind === "smelt" && S.job.loaded;
  if (loaded) finishSmelt(m, S.job, true);
  S.stage = null; S.job = null; m.ai.route = null; vdone(m);
  return loaded ? "emptied the furnace" : null;
}
// For tests and the debug screen: what it holds and has made.
function holdings(m) {
  const c = nm => cnt(m, I(nm));
  return { sand: c("sand"), glass: c("glass"), panes: c("glass_pane"), bottles: c("glass_bottle"), dugToday: m.gls ? m.gls.dug : 0,
    made: m.gls && m.gls.made ? Object.assign({}, m.gls.made) : { glass: 0, panes: 0, bottles: 0 } };
}

(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped }) => {
  const R = BF.I;
  if (R.glass_kiln != null && R.cobblestone != null && R.iron_ingot != null) addShaped(R.glass_kiln, 1, [" C ", "CIC", " C "], { C: R.cobblestone, I: R.iron_ingot }, "4 Cobblestone around 1 Iron Ingot → Glass Kiln (glassmaker)");
});

BF.glassmaker = {
  PROF, DIG_R, DIG_DAY, DIG_TRIP, SAND_WANT, GLASS_CAP, LOG,
  ai, nextJob, statusText, forceStop, reserve, holdings, craftPlan, craft, bottleTarget, paneTarget, digY, findDig, spotsAround, keepOut, edited, glassEq, smeltPlan,
};
})();
