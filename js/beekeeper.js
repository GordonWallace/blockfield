// Beekeepers (BF.beekeeper): profession "beekeeper", jobsite the honey extractor (blocks.js "bees pack"). Loaded after js/bees.js; hooks live
// in jobs.js (jobsite, hire kit, the generated apiary), mobs.js (outfit, roster, jobsAI), trading.js (offers), market.js (reserve), villagelife.js
// (status, honey as last-resort food, empty bottles bought back), villagesim.js (forced stop), storage.js, builder.js / blueprints.js (the apiary).
// See CONTRACT.md "Bees and beekeepers".
// Its hives are the beehives within HIVE_R blocks of its extractor. During work hours the beekeeper:
// - harvests its full hives at dawn or dusk (honey level 5, js/bees.js harvest), taking turns between shears (3 honeycomb) and a glass bottle
//   (1 honey bottle), so it has some of both;
// - picks wild flowers (never within reach of its own hives) and replants them around a hive with fewer than 6 flowers within reach;
// - with 3 honeycomb and 6 planks (planks bought at market) makes a beehive at its extractor and places it by the farms, up to HIVES_MAX;
// - leads wild bees home from nests within NEST_R blocks with a flower in hand into a hive with fewer than LEAD_BELOW bees;
// - makes candles from honeycomb and string at its extractor, buying the string at market.
// It sells honey bottles, honeycomb and candles and buys empty bottles back (trading.js, villagelife.js findBottleSeller), keeping back honeycomb
// for its next hive and bottles for its next harvest (reserve). Nothing comes from nowhere: honey and honeycomb only from full hives, flowers only
// from picking, hives from real honeycomb and planks, candles from honeycomb and string.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PROF = "beekeeper";
const HIVES_MAX = 4;              // hives per beekeeper
const HIVE_R = 24;                // its hives: beehives within this many blocks of its extractor
const LEAD_BELOW = 10;            // it leads wild bees into a hive with fewer than this many
const NEST_R = 64;                // wild nests it leads bees from lie within this many blocks of the hive
const PICK_R = 48;                // wild flowers it picks lie within this many blocks of its extractor
const FLOWERS_WANT = 6;           // flowers within reach each hive should have (js/bees.js GROW_FLOWERS)
const COMB_HIVE = 3, PLANKS_HIVE = 6;
const CANDLE_STOCK = 16;          // it stops making candles while it holds this many
const BOTTLES_LOW = 4, BOTTLES_TO = 12;
const KIT_BOTTLES = 16;
const DAY_SECS = 1200, WORK_START = 0.02, WORK_END = 0.45, DAWN_END = 0.1, DUSK_FROM = 0.37, CHECK = 3, TRADE_PAUSE = 1.6, CRAFT_T = 2.5, LEAD_WAIT = 20;

const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const live = o => !!(o && !o.dead && !o.removed);
const TR = () => BF.trades;
const FU = () => BF.furnaceUse;
const BE = () => BF.bees;
const W = () => BF.world;
const I = n => BF.I[n];
const nameOf = id => (BF.items[id] ? BF.items[id].name : "");
const cnt = (m, id) => (id == null || !m || !Array.isArray(m.inv) ? 0 : TR().inv.count(m.inv, id));
const sumOf = (m, f) => { let n = 0; for (const s of m.inv || []) if (s && f(s.id)) n += s.count; return n; };
const isPlanks = id => { const n = nameOf(id); return n === "planks" || /_planks$/.test(n); };
const isFlowerItem = id => !!(BE() && BE().isFlower(id));
const pk = (x, y, z) => x + "," + y + "," + z;
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
const LOG = [];
const log = (kind, data) => { LOG.push(BF.glog.job("beekeeper", Object.assign({ kind, day: +now().toFixed(3) }, data))); if (LOG.length > 300) LOG.shift(); };
const who = m => (BF.vlog && BF.vlog.nameOf ? BF.vlog.nameOf(m) : "Villager") + " (Beekeeper)";
const vlog = (m, kind, text, where) => { if (BF.vlog && m && m.village) BF.vlog.log(m.village, kind, who(m) + " " + text, where || m); };
const isExtractor = id => id != null && id === BF.B.honey_extractor;
const extractorOf = m => (m.jobsite && W().isLoaded(m.jobsite.x, m.jobsite.z) && isExtractor(W().getBlock(m.jobsite.x, m.jobsite.y, m.jobsite.z)) ? m.jobsite : null);

// ---------------------------------------------------------------- hire kit
// A pair of shears and KIT_BOTTLES glass bottles, whenever a villager first becomes a beekeeper (as the cowherd's bucket and bottles).
function kitInto(a, v) {
  if (!Array.isArray(a) || (v && v.beeKit)) return false;
  if (I("shears") != null) TR().inv.add(a, I("shears"), 1);
  if (I("glass_bottle") != null) TR().inv.add(a, I("glass_bottle"), KIT_BOTTLES);
  if (v && typeof v === "object") v.beeKit = true;
  log("kit", { who: v && v.slot ? v.slot.idx : null });
  return true;
}
const hireKit = m => !!(m && Array.isArray(m.inv) && kitInto(m.inv, m));

// ---------------------------------------------------------------- its hives and the ground around them
function hivesOf(m) {
  const j = m.jobsite;
  if (!j || !BE()) return [];
  return BE().loadedHomes().filter(h => h.kind === "hive" && Math.hypot(h.x - j.x, h.z - j.z) <= HIVE_R && Math.abs(h.y - j.y) <= 8);
}
function edited(x, y, z) {
  const CS = BF.CS, cx = Math.floor(x / CS), cz = Math.floor(z / CS), e = W().edits.get(cx + "," + cz);
  return !!(e && e.has(((y - BF.MIN_Y) * CS + (z - cz * CS)) * CS + (x - cx * CS)));
}
const inR = (r, x, z, mg) => x >= r[0] - mg && x <= r[2] + mg && z >= r[1] - mg && z <= r[3] + mg;
// The village's buildings, roads, lamps, farm beds and built structures: [x0, z0, x1, z1] rects, cached a while.
function keepOut(R) {
  const t = BF.simNow ? BF.simNow() : 0;
  if (R._beeKeep && R._beeKeep.t > t) return R._beeKeep.v;
  const out = [], wg = R.wg;
  if (wg) {
    for (const b of wg.buildings || []) out.push([b.x0, b.z0, b.x1, b.z1]);
    for (const r of wg.roads || []) out.push([r.x0, r.z0, r.x1, r.z1]);
    for (const l of wg.lamps || []) out.push([l[0], l[1], l[0], l[1]]);
  }
  if (BF.builder && BF.builder.builtOf) for (const e of BF.builder.builtOf(R)) if (e.state !== "abandoned") out.push([e.ox - 1, e.oz - 1, e.ox + e.w, e.oz + e.d]);
  if (BF.villageLife && BF.villageLife.bedRects) for (const r of BF.villageLife.bedRects(R)) out.push(r);
  R._beeKeep = { t: t + 30, v: out };
  return out;
}
const GROUND = /^(grass|dirt|podzol|coarse_dirt)$/;
// Is (x, y, z) open ground for a hive or a flower: grass or dirt under it, air in it (and above it for a hive), off the village's ground?
function openCell(R, x, y, z, tall, keep) {
  const w = W();
  if (!w.isLoaded(x, z) || w.getBlock(x, y, z) !== 0 || (tall && w.getBlock(x, y + 1, z) !== 0)) return false;
  if (!GROUND.test(nameOf(w.getBlock(x, y - 1, z)))) return false;
  for (const [dx, dz] of BF.DIRS) if (BF.FLUID[w.getBlock(x + dx, y, z + dz)]) return false;
  return !(keep || keepOut(R)).some(r => inR(r, x, z, 0));
}
// Where to put a new hive: by the village's farms (2-4 blocks off a farm's edge), else around its extractor; 3 apart from other homes.
function hiveSpot(m) {
  const R = m.village, j = m.jobsite, w = W();
  if (!R || !j) return null;
  const keep = keepOut(R), homes = BE().loadedHomes(), out = [];
  const farms = ((R.wg && R.wg.buildings) || []).filter(b => (b.type === "farm" || b.type === "bigfarm") && Math.hypot((b.x0 + b.x1) / 2 - j.x, (b.z0 + b.z1) / 2 - j.z) <= HIVE_R - 6);
  const consider = (x, z) => {
    if (Math.hypot(x - j.x, z - j.z) > HIVE_R - 2) return;
    const y = w.heightAt(x, z) + 1;
    if (Math.abs(y - j.y) > 4 || !openCell(R, x, y, z, true, keep)) return;
    if (homes.some(h => Math.hypot(h.x - x, h.z - z) < 3)) return;
    out.push({ x, y, z, d: Math.hypot(x - j.x, z - j.z) });
  };
  for (const b of farms) for (let z = b.z0 - 4; z <= b.z1 + 4; z++) for (let x = b.x0 - 4; x <= b.x1 + 4; x++) {
    const e = Math.max(b.x0 - x, x - b.x1, b.z0 - z, z - b.z1);
    if (e >= 2 && e <= 4) consider(x, z);
  }
  if (!out.length) for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) if (Math.max(Math.abs(dx), Math.abs(dz)) >= 2) consider(j.x + dx, j.z + dz);
  out.sort((a, b) => a.d - b.d);
  return out[0] || null;
}
// Where to plant a flower for hive h: open ground 2-5 blocks from it.
function plantSpot(m, h) {
  const R = m.village, keep = keepOut(R), w = W(), out = [];
  for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
    const d = Math.hypot(dx, dz);
    if (d < 2 || d > 5.5) continue;
    const x = h.x + dx, z = h.z + dz, y = w.heightAt(x, z) + 1;
    if (Math.abs(y - h.y) > 3 || !openCell(R, x, y, z, false, keep)) continue;
    out.push({ x, y, z, d: d + Math.random() });
  }
  out.sort((a, b) => a.d - b.d);
  return out[0] || null;
}
// A wild flower to pick: within PICK_R of the extractor, never within reach of one of its own hives (nor on a village flower bed by one).
function pickSpot(m) {
  const j = m.jobsite, S = st(m);
  if (!j || (S.noFlower || 0) > now()) return null;
  const hives = hivesOf(m), w = W(), best = [];
  for (let i = 0; i < 400 && best.length < 12; i++) {
    const a = Math.random() * Math.PI * 2, d = 6 + Math.sqrt(Math.random()) * (PICK_R - 6);
    const x = Math.floor(j.x + Math.cos(a) * d), z = Math.floor(j.z + Math.sin(a) * d);
    if (!w.isLoaded(x, z)) continue;
    const top = w.heightAt(x, z);
    for (let y = top + 1; y >= top - 6; y--) {
      if (!isFlowerItem(w.getBlock(x, y, z))) continue;
      if (hives.some(h => Math.hypot(h.x - x, h.z - z) <= BE().R + 1)) break;
      best.push({ x, y, z, d: Math.hypot(x - m.position.x, z - m.position.z) });
      break;
    }
  }
  if (!best.length) { S.noFlower = now() + 0.05; return null; }
  best.sort((a, b) => a.d - b.d);
  return best[0];
}
// A wild nest with bees out within NEST_R of hive h, nearest first.
function nestFor(h) {
  let best = null, bd = NEST_R;
  for (const o of BE().loadedHomes()) {
    if (o.kind !== "nest" || o.bees < 2) continue;
    const d = Math.hypot(o.x - h.x, o.z - h.z);
    if (d < bd && BE().out(o).length > 0) { bd = d; best = o; }
  }
  return best;
}

// ---------------------------------------------------------------- what it keeps and wants
const flowerCount = m => sumOf(m, isFlowerItem);
const combKeep = m => (hivesOf(m).length < HIVES_MAX ? COMB_HIVE : 0);
// Empty bottles it would buy back (js/villagelife.js findBottleSeller). Its unsold honey bottles count too: it fills each empty at once, so on
// empties alone it would stay a buyer while its honey piles up, and leave the cowherd none to milk into.
function bottleWanted(m) {
  if (!m || m.profession !== PROF || !m.inv || I("glass_bottle") == null) return 0;
  const have = cnt(m, I("glass_bottle")) + (I("honey_bottle") != null ? cnt(m, I("honey_bottle")) : 0);
  return have < BOTTLES_LOW ? BOTTLES_TO - have : 0;
}
// Its market reserve (js/market.js): its bottles (for the next harvest), shears, honeycomb for its next hive, string, planks and flowers.
function reserve(m) {
  const out = [], set = (...ids) => new Set(ids.filter(id => id != null));
  if (!m || m.profession !== PROF || !Array.isArray(m.inv)) return out;
  const gb = I("glass_bottle"), hc = I("honeycomb");
  if (cnt(m, gb) > 0) out.push({ ids: set(gb), n: cnt(m, gb) });
  if (cnt(m, I("shears")) > 0) out.push({ ids: set(I("shears")), n: 1 });
  if (combKeep(m) && cnt(m, hc) > 0) out.push({ ids: set(hc), n: combKeep(m) });
  if (cnt(m, I("string")) > 0) out.push({ ids: set(I("string")), n: cnt(m, I("string")) });
  const pl = new Set(), fl = new Set();
  for (const s of m.inv) if (s && isPlanks(s.id)) pl.add(s.id); else if (s && isFlowerItem(s.id)) fl.add(s.id);
  if (pl.size) out.push({ ids: pl, n: PLANKS_HIVE });
  if (fl.size) out.push({ ids: fl, n: 64 });
  return out;
}

// ---------------------------------------------------------------- the beekeeper's day
const st = m => m.bkp || (m.bkp = { stage: null, job: null, checkT: rnd(1, 4), avoid: {}, cd: 0, wait: "", next: "honey", made: { comb: 0, honey: 0, candles: 0, hives: 0, flowers: 0, led: 0, picked: 0 } });
const avoided = (S, k) => (S.avoid[k] || 0) > now();
const skipOffer = S => (v2, o) => avoided(S, (v2.slot ? v2.slot.idx : 0) + ":" + o.sell.id);
function nextJob(m) {
  const S = st(m), t = skyT(), hives = hivesOf(m), hc = I("honeycomb");
  S.wait = "";
  // harvesting full hives at dawn or dusk: bottles and shears in turn
  if (t < DAWN_END || t >= DUSK_FROM) {
    const full = hives.filter(h => h.honey >= BE().FULL);
    if (full.length) {
      const sh = cnt(m, I("shears")) > 0, gb = cnt(m, I("glass_bottle")) > 0 && TR().inv.canFit(m.inv, [{ id: I("honey_bottle"), n: 1 }], [{ id: I("glass_bottle"), n: 1 }]);
      const comb = sh && TR().inv.canFit(m.inv, [{ id: hc, n: 3 }], []);
      const how = S.next === "honey" ? (gb ? "bottle" : comb ? "shears" : null) : (comb ? "shears" : gb ? "bottle" : null);
      if (how) { full.sort((a, b) => Math.hypot(a.x - m.position.x, a.z - m.position.z) - Math.hypot(b.x - m.position.x, b.z - m.position.z)); return { kind: "harvest", hive: full[0], how }; }
    }
  }
  // a new hive: honeycomb and planks crafted at the extractor, placed by the farms
  if (cnt(m, I("beehive")) > 0 && hives.length < HIVES_MAX) { const s = hiveSpot(m); if (s) return { kind: "place", at: s }; }
  if (hives.length < HIVES_MAX && cnt(m, hc) >= COMB_HIVE && extractorOf(m) && hiveSpot(m)) {
    if (sumOf(m, isPlanks) >= PLANKS_HIVE) return { kind: "craft", what: "hive", times: 1, at: extractorOf(m) };
    if (!avoided(S, "want:planks")) {
      const d = FU().findDeal(m, { what: "planks", f: isPlanks, n: PLANKS_HIVE - sumOf(m, isPlanks) }, skipOffer(S));
      if (d) return d;
      S.avoid["want:planks"] = now() + 0.05;
    }
  }
  // flowers for a hive that has too few within reach: plant one it holds, else pick a wild one
  const bare = hives.filter(h => BE().flowersNear(h).length < FLOWERS_WANT);
  if (bare.length) {
    if (flowerCount(m) > (bare.length && hives.some(h => h.bees < LEAD_BELOW) ? 1 : 0)) {   // one flower stays in hand to lead bees with
      const h = bare[0], s = plantSpot(m, h);
      if (s) return { kind: "plant", at: s, hive: h };
    }
    if (flowerCount(m) < 8) { const p = pickSpot(m); if (p) return { kind: "pick", at: p }; }
    S.wait = "flowers";
  }
  // wild bees led home into a hive with room
  const thin = hives.filter(h => h.bees < LEAD_BELOW).sort((a, b) => a.bees - b.bees);
  if (thin.length && BE().canFly(thin[0]) && t < WORK_END - 0.08) {
    if (flowerCount(m) < 1) { const p = pickSpot(m); if (p) return { kind: "pick", at: p }; }
    else { const n = nestFor(thin[0]); if (n && !avoided(S, "nest:" + pk(n.x, n.y, n.z))) return { kind: "lead", nest: n, hive: thin[0] }; }
  }
  // candles from spare honeycomb and string
  const spare = cnt(m, hc) - combKeep(m), candles = cnt(m, I("candle"));
  if (spare >= 1 && candles < CANDLE_STOCK && I("candle") != null && extractorOf(m)) {
    const n = Math.min(spare, cnt(m, I("string")), CANDLE_STOCK - candles);
    if (n > 0 && TR().inv.canFit(m.inv, [{ id: I("candle"), n }], [{ id: hc, n }, { id: I("string"), n }])) return { kind: "craft", what: "candles", times: n, at: extractorOf(m) };
    if (cnt(m, I("string")) === 0 && spare >= 2 && !avoided(S, "want:string")) {
      const d = FU().findDeal(m, { what: "string", f: id => id === I("string"), n: Math.min(8, spare) }, skipOffer(S));
      if (d) return d;
      S.avoid["want:string"] = now() + 0.05;
    }
  }
  if (!S.wait && hives.length) S.wait = "honey";
  return null;
}
function craft(m, job) {
  const T = TR().inv, hc = I("honeycomb");
  if (job.what === "hive") {
    if (cnt(m, hc) < COMB_HIVE || sumOf(m, isPlanks) < PLANKS_HIVE || !T.canFit(m.inv, [{ id: I("beehive"), n: 1 }], [])) return 0;
    T.remove(m.inv, hc, COMB_HIVE);
    let left = PLANKS_HIVE;
    for (const s of [...m.inv]) { if (!left) break; if (s && isPlanks(s.id)) { const k = Math.min(left, s.count); T.remove(m.inv, s.id, k); left -= k; } }
    T.add(m.inv, I("beehive"), 1);
    st(m).made.hives++;
    vlog(m, "bees", "made a beehive from 3 honeycomb and 6 planks at the honey extractor", m.jobsite || m);
    log("craft", { what: "hive" });
    return 1;
  }
  let done = 0;
  for (let i = 0; i < job.times; i++) {
    if (cnt(m, hc) < 1 || cnt(m, I("string")) < 1) break;
    T.remove(m.inv, hc, 1); T.remove(m.inv, I("string"), 1); T.add(m.inv, I("candle"), 1); done++;
  }
  if (done) { st(m).made.candles += done; log("craft", { what: "candles", n: done }); vlog(m, "bees", "made " + plural(done, "candle") + " at the honey extractor", m.jobsite || m); }
  return done;
}
const vdone = m => { if (BF.villageSim && BF.villageSim.done) BF.villageSim.done(m); };
function estimate(m, job) {
  const VS = BF.villageSim;
  const p = job.kind === "harvest" ? job.hive : job.kind === "lead" ? job.nest : job.at || (job.other && job.other.position ? { x: job.other.position.x, z: job.other.position.z } : null);
  const walk = p && VS && VS.walkSecs ? VS.walkSecs(m, [[p.x + 0.5, p.z + 0.5]]) * (job.kind === "lead" || job.kind === "plant" || job.kind === "pick" ? 2 : 1) : 0;
  return walk + (job.kind === "lead" ? LEAD_WAIT * 2 : job.kind === "craft" ? CRAFT_T : TRADE_PAUSE);
}
const label = job => job.kind === "harvest" ? "Harvesting honey" : job.kind === "lead" ? "Leading bees home" : job.kind === "plant" || job.kind === "pick" ? "Planting flowers"
  : job.kind === "craft" ? (job.what === "candles" ? "Making candles" : "Making a beehive") : job.kind === "place" ? "Placing a beehive" : job.what === "string" ? "Buying string" : "Buying planks";
const lureOff = m => { if (BE()) BE().lure(m, false); };
// Villager AI step (mobs.js jobsAI: early with cont = true to carry on what it started, and after the other trades with cont = false).
function ai(m, dt, out, cont) {
  if (m.profession !== PROF) return false;
  if (cont && !(m.bkp && m.bkp.stage)) return false;
  if (!m.inv || m.dead || m.child || m.type !== "villager" || !BF.mobs || !BF.mobs.nav || !m.village || !FU() || !BE() || m.sleeping || BF.B.beehive == null) return false;
  const F = FU(), S = st(m), a = m.ai, t = skyT();
  if (t >= WORK_END || t < WORK_START || m.tradingWith) {
    if (S.stage) { S.stage = null; S.job = null; lureOff(m); vdone(m); a.route = null; }
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
    if (estimate(m, job) > (WORK_END - t) * DAY_SECS) { S.cd = now() + 0.02; return false; }   // only work that ends before its day does
    const VS = BF.villageSim;
    if (VS && VS.begin && !VS.begin(m, estimate(m, job), label(job))) return false;
    S.job = job; S.stage = "walk"; S.walkT = 0; S.navFail = 0; S.gx = null; a.route = null;
  }
  const job = S.job;
  const giveUp = (why, key) => {
    log("giveup", { kind: job.kind, why });
    if (key) S.avoid[key] = now() + 0.05;
    lureOff(m);
    S.stage = null; S.job = null; vdone(m); a.route = null; S.checkT = 0.5; return false;
  };
  const done = () => { lureOff(m); S.stage = null; S.job = null; vdone(m); a.route = null; S.checkT = 0.5; return true; };
  a.mode = "idle"; a.t = 2;
  S.walkT += dt;
  const go = (x, y, z, near, sp) => F.travel(m, S, dt, out, x, y, z, m.def.speed * (sp || 1.2), near, "bees");
  const nextTo = p => (x, y, z) => Math.max(Math.abs(x - p.x), Math.abs(z - p.z)) <= 1 && !(x === p.x && z === p.z) && Math.abs(y - p.y) <= 1;
  // ---- harvesting a full hive
  if (job.kind === "harvest") {
    const h = job.hive;
    if (BE().homeAt(h.x, h.y, h.z) !== h || h.honey < BE().FULL) return done();
    if (S.stage === "walk") {
      if (S.walkT > 60) return giveUp("timeout");
      const r = go(h.x, h.y, h.z, nextTo(h));
      if (r === "failed") return giveUp("no path");
      if (r === "arrived") { S.stage = "work"; S.tt = 1.5; }
      return true;
    }
    out.faceX = h.x + 0.5; out.faceZ = h.z + 0.5; m.lookAt = { position: { x: h.x + 0.5, y: h.y + 0.5, z: h.z + 0.5 }, height: 0 };
    if (Math.random() < dt * 3) a.swingT = 0.2;
    if ((S.tt -= dt) > 0) return true;
    const T = TR().inv;
    if (job.how === "bottle" && cnt(m, I("glass_bottle")) < 1) return giveUp("no bottle");
    const g = BE().harvest(h.x, h.y, h.z, job.how, m);
    if (g) {
      if (job.how === "bottle") T.remove(m.inv, I("glass_bottle"), 1);
      else if (BF.toolWear) { const sh = BF.toolWear.best(m, "shears"); if (sh) BF.toolWear.use(m, sh, 1); }
      const left = T.add(m.inv, g.id, g.n);
      if (left > 0 && BF.drops) BF.drops.spawn(g.id, left, m.position.x, m.position.y + 0.6, m.position.z);
      S.made[job.how === "bottle" ? "honey" : "comb"] += g.n; S.next = job.how === "bottle" ? "comb" : "honey";
      log("harvest", { how: job.how, at: pk(h.x, h.y, h.z) });
      vlog(m, "bees", "harvested " + (job.how === "bottle" ? "a honey bottle" : "3 honeycomb") + " from the beehive at " + pk(h.x, h.y, h.z), [h.x, h.y, h.z]);
    }
    return done();
  }
  // ---- crafting a hive or candles at the extractor
  if (job.kind === "craft") {
    const k = extractorOf(m);
    if (!k) return giveUp("no extractor");
    if (S.stage === "walk") {
      if (S.walkT > 60) return giveUp("timeout");
      const r = go(k.x, k.y, k.z, F.beside(k));
      if (r === "failed") return giveUp("no path");
      if (r !== "arrived") return true;
      S.stage = "work"; S.tt = CRAFT_T;
    }
    out.faceX = k.x + 0.5; out.faceZ = k.z + 0.5;
    if (Math.random() < dt * 3) a.swingT = 0.2;
    if ((S.tt -= dt) > 0) return true;
    craft(m, job);
    return done();
  }
  // ---- placing a hive it made
  if (job.kind === "place") {
    const s = job.at;
    if (cnt(m, I("beehive")) < 1) return done();
    if (S.stage === "walk") {
      if (S.walkT > 60) return giveUp("timeout");
      const r = go(s.x, s.y, s.z, nextTo(s));
      if (r === "failed") return giveUp("no path");
      if (r === "arrived") { S.stage = "work"; S.tt = 1; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5;
    if ((S.tt -= dt) > 0) return true;
    const [fx, , fz] = BF.mobs.nav.feetCell(m);
    if ((fx === s.x && fz === s.z) || !openCell(m.village, s.x, s.y, s.z, true)) return giveUp("spot taken");
    if (W().setBlock(s.x, s.y, s.z, BF.B.beehive)) {
      TR().inv.remove(m.inv, I("beehive"), 1); a.swingT = 0.25;
      log("place", { at: pk(s.x, s.y, s.z) });
      vlog(m, "bees", "put a new beehive by the farms at " + pk(s.x, s.y, s.z), [s.x, s.y, s.z]);
    }
    return done();
  }
  // ---- picking a wild flower, planting one by a hive
  if (job.kind === "pick" || job.kind === "plant") {
    const s = job.at;
    if (job.kind === "pick" && !isFlowerItem(W().getBlock(s.x, s.y, s.z))) return done();
    if (S.stage === "walk") {
      if (S.walkT > 60) return giveUp("timeout");
      const r = go(s.x, s.y, s.z, nextTo(s), 1.0);
      if (r === "failed") return giveUp("no path");
      if (r === "arrived") { S.stage = "work"; S.tt = 1.2; }
      return true;
    }
    out.faceX = s.x + 0.5; out.faceZ = s.z + 0.5; m.lookAt = { position: { x: s.x + 0.5, y: s.y + 0.2, z: s.z + 0.5 }, height: 0 };
    if ((S.tt -= dt) > 0) return true;
    a.swingT = 0.25;
    if (job.kind === "pick") {
      const id = W().getBlock(s.x, s.y, s.z);
      if (isFlowerItem(id) && TR().inv.canFit(m.inv, [{ id, n: 1 }], []) && W().setBlock(s.x, s.y, s.z, 0)) { TR().inv.add(m.inv, id, 1); S.made.picked++; log("pick", { at: pk(s.x, s.y, s.z) }); }
      return done();
    }
    const fl = (m.inv.find(x => x && isFlowerItem(x.id)) || {}).id;
    if (fl == null || !openCell(m.village, s.x, s.y, s.z, false)) return done();
    if (W().setBlock(s.x, s.y, s.z, fl)) { TR().inv.remove(m.inv, fl, 1); S.made.flowers++; log("plant", { at: pk(s.x, s.y, s.z) }); vlog(m, "bees", "planted a " + nameOf(fl) + " by a beehive", [s.x, s.y, s.z]); }
    return done();
  }
  // ---- leading wild bees home with a flower in hand
  if (job.kind === "lead") {
    const n = job.nest, h = job.hive, nk = "nest:" + pk(n.x, n.y, n.z);
    if (BE().homeAt(h.x, h.y, h.z) !== h) return giveUp("hive gone");
    if (flowerCount(m) < 1) return giveUp("no flower");
    if (!BE().canFly(h)) return giveUp("bees inside");
    const followers = () => BE().list.filter(b => b.follow && b.follow.who === m).length;
    if (S.stage === "walk") {
      if (S.walkT > 90) return giveUp("timeout", nk);
      const r = go(n.x, n.y, n.z, (x, y, z) => Math.hypot(x - n.x, z - n.z) <= 3, 1.2);
      if (Math.hypot(m.position.x - n.x, m.position.z - n.z) < 10) BE().lure(m, true);
      if (r === "failed") return giveUp("no path", nk);
      if (r === "arrived") { S.stage = "wait"; S.tt = LEAD_WAIT; }
      return true;
    }
    if (S.stage === "wait") {
      BE().lure(m, true);
      out.faceX = n.x + 0.5; out.faceZ = n.z + 0.5;
      S.tt -= dt;
      if (followers() >= 3 || (S.tt <= 0 && followers() > 0)) { S.stage = "back"; S.walkT = 0; S.movedIn = 0; a.route = null; return true; }
      if (S.tt <= 0) return giveUp("no bees came", nk);
      return true;
    }
    if (S.stage === "back") {
      BE().lure(m, true);
      if (S.walkT > 120) return giveUp("timeout");
      const r = go(h.x, h.y, h.z, nextTo(h), 0.8);   // slowly, so the bees keep up
      if (r === "failed") return giveUp("no path");
      if (r === "arrived") { S.stage = "home"; S.tt = 12; }
      return true;
    }
    BE().lure(m, true);
    out.faceX = h.x + 0.5; out.faceZ = h.z + 0.5;
    if ((S.tt -= dt) > 0 && followers() > 0) return true;
    if (S.movedIn) vlog(m, "bees", "led " + plural(S.movedIn, "wild bee") + " home to the beehive at " + pk(h.x, h.y, h.z), [h.x, h.y, h.z]);
    log("lead", { n: S.movedIn || 0, to: pk(h.x, h.y, h.z) });
    return done();
  }
  // ---- buying planks or string at the seller's own offer
  const v2 = job.other, key = (v2 && v2.slot ? v2.slot.idx : 0) + ":" + job.item;
  if (!F.canSell(m, v2)) return giveUp(v2 && v2.sleeping ? "asleep" : v2 && v2.tradingWith ? "busy" : "gone", key);
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (BF.mobs.waitFor) BF.mobs.waitFor(v2, m, d);   // the seller stops for its buyer (bug-054)
  if (S.stage === "walk") {
    if (S.walkT > 60) return giveUp("timeout", key);
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; a.route = null; return true; }
    const g = { x: Math.floor(v2.position.x), y: Math.floor(v2.position.y + 0.01), z: Math.floor(v2.position.z) };
    if (S.gx == null || Math.hypot(S.gx - g.x, S.gz - g.z) > 3) { if (a.routeKind === "bees") a.route = null; S.gx = g.x; S.gz = g.z; }
    if (go(g.x, g.y, g.z, null, 1.3) === "failed") return giveUp("no path", key);
    return true;
  }
  S.tt -= dt;
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) a.swingT = 0.2;
  if (S.tt <= 0) {
    const n = F.doBuy(m, job);
    S.gx = null;
    if (n) log("buy", { what: nameOf(job.item), n: n * job.offer.sell.n, from: v2.profession });
    else { S.avoid[key] = now() + 0.05; log("giveup", { kind: "buy", why: "trade refused" }); }
    return done();
  }
  return true;
}
if (BF.bees && BF.bees.onMoveIn) BF.bees.onMoveIn((o, h, by) => { if (by && by.bkp && by.bkp.job && by.bkp.job.kind === "lead") { by.bkp.movedIn = (by.bkp.movedIn || 0) + 1; by.bkp.made.led++; } });

// Status line (js/villagelife.js statusText): what it is doing, or what it waits for.
function statusText(m) {
  const S = m && m.bkp;
  if (!S || m.sleeping) return "";
  if (S.stage && S.job) return label(S.job);
  const t = skyT();
  if (t >= WORK_END || t < WORK_START) return "";
  return S.wait === "flowers" ? "Waiting for flowers" : S.wait === "honey" ? "Waiting for honey" : "";
}
// A forced stop (js/villagesim.js): drops its errand and lets any bees it was leading go. Returns what it did, or null.
function forceStop(m) {
  const S = m.bkp;
  if (!S || !S.job) return null;
  const leading = S.job.kind === "lead";
  lureOff(m);
  S.stage = null; S.job = null; m.ai.route = null; vdone(m);
  return leading ? "let the bees it was leading go" : null;
}
// For tests and the debug screen: what it holds and has made.
function holdings(m) {
  const c = nm => cnt(m, I(nm));
  return { honey: c("honey_bottle"), comb: c("honeycomb"), candles: c("candle"), bottles: c("glass_bottle"), flowers: flowerCount(m), hives: hivesOf(m).length,
    made: m.bkp ? Object.assign({}, m.bkp.made) : {} };
}

(BF.recipeHooks = BF.recipeHooks || []).push(({ addShaped, addShapeless }) => {
  const R = BF.I;
  if (R.beehive == null) return;
  const PL = BF.blocks.filter(b => b && !b.hidden && (b.name === "planks" || /_planks$/.test(b.name))).map(b => b.id);
  addShaped(R.beehive, 1, ["PPP", "HHH", "PPP"], { P: PL, H: R.honeycomb }, "6 Planks around 3 Honeycomb → Beehive");
  if (R.candle != null && R.string != null && addShapeless) addShapeless(R.candle, 1, [R.string, R.honeycomb], "String + Honeycomb → Candle");
  if (R.honey_extractor != null) addShaped(R.honey_extractor, 1, ["PIP", "P P"], { P: PL, I: R.iron_ingot }, "4 Planks around 1 Iron Ingot (an arch) → Honey Extractor (beekeeper)");
});

BF.beekeeper = {
  PROF, HIVES_MAX, HIVE_R, LEAD_BELOW, NEST_R, PICK_R, FLOWERS_WANT, CANDLE_STOCK, KIT_BOTTLES, LOG,
  ai, nextJob, statusText, forceStop, reserve, holdings, hivesOf, hiveSpot, plantSpot, pickSpot, nestFor, bottleWanted, kitInto, hireKit, craft, keepOut, openCell,
};
})();
