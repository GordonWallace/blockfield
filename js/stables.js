// Stables and stable hands (BF.stables). Loaded after js/horses.js; hooks live in mobs.js (villagerAI, pickWander, interact, update, clear),
// jobs.js (who may take a tack rack, work at the rack), trading.js (horse offers), inventory.js (a horse offer gives no item), builder.js /
// blueprints.js (the "stable" structure) and villagerstatus.js. See CONTRACT.md "Stables".
//
// A stable is a builder structure (blueprints.js "stable": an open shelter with the tack rack, and a fenced paddock with a double gate), built only
// in villages on horse land (plains, savanna, meadow: BF.horses.isHorseBiome). Its tack rack is a jobsite, so a jobless villager takes it and
// becomes the village's one stable hand. The stable starts empty. The stable hand:
//  - catches wild horses while the paddock holds fewer than 2: walks to the nearest wild one within 128 blocks of the rack, feeds it wheat or hay
//    from its own pack until it accepts it (each mouthful raises its temper; then a temper% roll, the rider's rule), leads it home and pens it.
//    With no wild horse in range it waits until the next morning.
//  - breeds them with 2 or more: feeds wheat or hay to a pair of ready adults (horses.js has willing same-owner adults meet and foal), keeping
//    the paddock at 2-4 horses, never more than 4 (foals count). Foals take their parents' average stats (horses.js).
//  - sells adult horses to the player (one trade offer per paddock horse beyond the 2 it keeps, priced by BF.horses.price, 8-24 emeralds; the
//    horse walks out on the player's lead when it has one to give, else it is left untied beside the player), and buys them: the player leading
//    a tamed adult of its own right-clicks the stable hand, which pays the price when it has the emeralds and leads the horse home.
//  - makes saddles (3 leather + 1 iron ingot) and leads (4 string + 1 leather -> 2) at its tack rack and sells them; buys horse feed from the player.
// Nothing comes from nowhere: every wheat, hay bale, leather, iron ingot and string it uses is bought from a villager of its village through
// one of that villager's sell offers (its job's or its spare goods, js/market.js: one market); saddles and leads exist only once made from those. Horses are owned "stable:<village key>".
// Far villages (js/villagesim.js): horses only exist as mobs near the player, so catching and breeding pause there; shopping goes on.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const PROF = "stable_hand";
const MIN_HORSES = 2, MAX_HORSES = 4;   // catch until 2, breed up to 4
const CATCH_R = 128;                    // wild horses this far from the tack rack are worth the walk
const WORK_START = 0.03, WORK_END = 0.47;
const TASK_MAX = { catch: 240, home: 240, fetch: 90, feed: 60, shop: 70 };
const FEED_DAYS = 1;                    // a fed adult stays willing this long (js/horses.js FEED_DAYS)
const TAME_EVERY = 1.1;                 // seconds between mouthfuls while taming
const WHEAT_LOW = 8, WHEAT_TO = 24;     // buys feed under 8 wheat, up to 24
const WHEAT_SELF = 4;                   // a farmer keeps this much wheat (js/villagelife.js sells down to the same)
const SADDLE_STOCK = 1, LEAD_STOCK = 4; // tack it keeps made up for sale
const CRAFT_SECS = 6;                   // at the rack: one saddle or two leads every 6 s
const TRADE_PAUSE = 1.6;
const KEEP = { wheat_item: WHEAT_SELF };
const LOG = [];

const live = o => !!(o && !o.dead && !o.removed);
const rnd = (a, b) => a + Math.random() * (b - a);
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.25);
const now = () => (BF.sky ? BF.sky.day || 0 : 0) + skyT();
const TR = () => BF.trades;
const I = n => BF.I[n];
const cnt = (m, id) => (id == null || !m || !m.inv ? 0 : TR().inv.count(m.inv, id));
const who = m => BF.vlog ? BF.vlog.nameOf(m) + " (" + BF.vlog.pretty(m.profession) + ")" : m.profession;
const isFoal = r => r.growAt != null;
const ownerOf = rec => "stable:" + rec.key;
function log(kind, m, data) {
  LOG.push(Object.assign({ kind, day: +now().toFixed(3), village: m && m.village ? m.village.key : null }, data));
  if (LOG.length > 300) LOG.shift();
}
// "speed 9.3 blocks/s, jump 2.4 blocks, health 22"
const stats = r => "speed " + r.speed.toFixed(1) + " blocks/s, jump " + r.jump.toFixed(1) + " blocks, health " + r.maxHp;

// ---------------------------------------------------------------- the stable of a village
const villageOK = R => !!(R && BF.horses && BF.horses.isHorseBiome(R.x, R.z));
// The village's finished stable: {e (builder entry), rec, owner, box (paddock inside, cells inclusive), gates [[x, z]], out [[x, z]] (in front of
// the gate), y (floor level = the fence's level), rack {x, y, z}} or null. Read from the blueprint's marks (blueprints.js "stable").
function stableOf(R) {
  if (!R || !BF.builder) return null;
  const e = (R.built || BF.builder.builtOf(R) || []).find(x => x.type === "stable" && x.state === "done");
  if (!e) return null;
  const k = e.ox + "," + e.oy + "," + e.oz + "," + e.rot;
  if (e._st && e._stKey === k) { e._st.rec = R; return e._st; }
  const bp = BF.builder.bpOf(e), M = bp.marks || {};
  if (!M.paddock || !M.gate || !M.out) return null;
  const at = ([x, z]) => [e.ox + x, e.oz + z], P = M.paddock.map(at), rk = M.rack ? at(M.rack[0]) : [e.ox, e.oz];
  const st = { e, rec: R, owner: ownerOf(R), y: e.oy, box: { x0: Math.min(P[0][0], P[1][0]), z0: Math.min(P[0][1], P[1][1]), x1: Math.max(P[0][0], P[1][0]), z1: Math.max(P[0][1], P[1][1]) },
    gates: M.gate.map(at), out: M.out.map(at), rack: { x: rk[0], y: e.oy + 1, z: rk[1] } };
  st.box.fp = { x0: e.ox, z0: e.oz, x1: e.ox + bp.w, z1: e.oz + bp.d };   // the whole building: horses walk round it, not at its fence
  st.box.gx = st.gates.reduce((a, g) => a + g[0], 0) / st.gates.length + 0.5;   // the gate's middle: a penned horse outside lines up on it to walk in
  st.box.gz = st.gates.reduce((a, g) => a + g[1], 0) / st.gates.length + 0.5;
  Object.defineProperty(e, "_st", { value: st, writable: true, enumerable: false, configurable: true });   // "_" keys are dropped from the save too (builder.js clean)
  e._stKey = k;
  return st;
}
const inBox = (b, x, z, m = 0) => x > b.x0 - m && x < b.x1 + 1 + m && z > b.z0 - m && z < b.z1 + 1 + m;
const horsesOf = st => (st && BF.horses ? BF.horses.horsesOf(st.owner) : []);
// The village of a horse record owned by a stable, or null.
function recOfOwner(owner) {
  if (typeof owner !== "string" || owner.slice(0, 7) !== "stable:" || !BF.mobs) return null;
  return BF.mobs.villages.get(owner.slice(7)) || null;
}

// ---------------------------------------------------------------- who may work the tack rack (js/jobs.js)
// Only a villager of a village on horse land, and only while no other villager of that village is the stable hand (one per village, loaded or not).
function mayHire(m, s) {
  const R = m && m.village;
  if (!villageOK(R)) return false;
  for (const o of R.members || []) if (o !== m && o.type === "villager" && live(o) && o.profession === PROF) return false;
  const J = BF.jobs, mine = m.slot ? R.key + "#" + m.slot.idx : null;
  if (J) for (const [k, c] of J.claims) {
    if (!c || !c.key || c.key === mine || c.key.indexOf(R.key + "#") !== 0) continue;
    const site = J.sites.get(k);
    if ((site && site.prof === PROF) || (c.mob && c.mob.profession === PROF)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- paddock horses (mobs.js pickWander)
function pickPenTarget(m) {
  const b = m.horse && m.horse.pen;
  if (!b) return false;
  m.ai.tx = b.x0 + 0.8 + Math.random() * Math.max(0.1, b.x1 + 1 - b.x0 - 1.6);
  m.ai.tz = b.z0 + 0.8 + Math.random() * Math.max(0.1, b.z1 + 1 - b.z0 - 1.6);
  return true;
}

// ---------------------------------------------------------------- buying from other villagers
// The deal for `want` of item id from seller v2: one of its sell offers (its job's, or spare goods, js/market.js), at that offer's price. The
// seller's stock above its reserve (blockReason) and room, and the buyer's emeralds and room, set how many times.
function offerFor(v2, id) {
  const T = TR(), em = I("emerald");
  for (const o of v2.trades || []) if (o.sell.id === id && o.buy.length === 1 && o.buy[0].id === em && !o.horse && !T.blockReason(v2, o)) return o;
  return null;
}
function dealWith(m, v2, id, want) {
  const T = TR(), em = I("emerald"), o = offerFor(v2, id);
  if (!o || T.blockReason(v2, o)) return null;
  const keep = (v2.profession === "farmer" && KEEP[BF.items[id].name]) || 0;
  let k = Math.min(Math.ceil(want / o.sell.n), Math.floor((cnt(v2, id) - keep) / o.sell.n), Math.floor(cnt(m, em) / o.buy[0].n), 4);
  while (k > 0 && !T.inv.canFit(m.inv, [{ id, n: o.sell.n * k }], [{ id: em, n: o.buy[0].n * k }])) k--;
  return k > 0 ? { seller: v2, offer: o, times: k, item: id, keep } : null;
}
// What it wants to buy now, most needed first: [{id, n}]. Feed first; tack only with a few emeralds to spare.
function wants(m, st) {
  const out = [], em = cnt(m, I("emerald"));
  if (em < 1) return out;
  const wheat = cnt(m, I("wheat_item")), hay = cnt(m, I("hay_bale"));
  if (st && wheat + hay * 9 < WHEAT_LOW) { out.push({ id: I("wheat_item"), n: WHEAT_TO - wheat }); out.push({ id: I("hay_bale"), n: 2 }); }
  if (em < 3) return out;
  const saddles = cnt(m, I("saddle")), leads = cnt(m, I("lead")), leather = cnt(m, I("leather")), iron = cnt(m, I("iron_ingot")), string = cnt(m, I("string"));
  const needL = (saddles < SADDLE_STOCK ? 3 : 0) + (leads < LEAD_STOCK ? 1 : 0);
  if (leather < needL) out.push({ id: I("leather"), n: needL - leather });
  if (saddles < SADDLE_STOCK && iron < 1) out.push({ id: I("iron_ingot"), n: 1 });
  if (leads < LEAD_STOCK && string < 4) out.push({ id: I("string"), n: 4 - string });
  return out.filter(w => w.id != null && w.n > 0);
}
function findDeal(m, st, S) {
  const R = m.village;
  if (!R) return null;
  const t = now();
  for (const w of wants(m, st)) {
    if ((S.noSeller[w.id] || 0) > t) continue;
    let best = null, bd = Infinity;
    for (const v2 of R.members || []) {
      if (v2 === m || !BF.villageLife.canSell(v2) || v2.child || (S.avoid[v2.slot ? v2.slot.idx : -1] || 0) > t) continue;
      const d = dealWith(m, v2, w.id, w.n);
      if (!d) continue;
      const dist = v2.position.distanceTo(m.position);
      if (dist < bd) { bd = dist; best = d; }
    }
    if (best) return best;
    S.noSeller[w.id] = t + 0.1;   // nobody has it: look again in a couple of game hours
  }
  return null;
}
function doDeal(m, deal) {
  const T = TR(), v2 = deal.seller, o = deal.offer, em = I("emerald");
  let done = 0;
  for (let i = 0; i < deal.times; i++) {
    if (!BF.villageLife.canSell(v2) || cnt(v2, o.sell.id) - o.sell.n < deal.keep || cnt(m, em) < o.buy[0].n) break;
    if (!T.inv.canFit(m.inv, [{ id: o.sell.id, n: o.sell.n }], o.buy)) break;
    const sold = T.exchange(v2, o);                    // the seller's stock and room, as for a player trade
    if (!sold) break;
    T.inv.remove(m.inv, em, o.buy[0].n);
    T.inv.addStacks(m.inv, sold);
    T.addXp(v2, o);
    done++;
  }
  if (done) {
    if (BF.vlog) BF.vlog.trade(m, v2, o, done);
    log("buy", m, { from: v2.profession, got: done * o.sell.n + " " + BF.items[o.sell.id].name, paid: done * o.buy[0].n + " emerald", how: o.spare ? "spare" : "offer" });
  }
  return done;
}

// ---------------------------------------------------------------- tack: saddles and leads at the rack (jobs.js work)
function craftOne(m) {
  const T = TR().inv, inv = m.inv, c = n => cnt(m, I(n));
  if (!inv || I("saddle") == null) return null;
  if (c("saddle") < SADDLE_STOCK && c("leather") >= 3 && c("iron_ingot") >= 1 && T.canFit(inv, [{ id: I("saddle"), n: 1 }], [{ id: I("leather"), n: 3 }, { id: I("iron_ingot"), n: 1 }])) {
    T.remove(inv, I("leather"), 3); T.remove(inv, I("iron_ingot"), 1); T.add(inv, I("saddle"), 1);
    return "saddle";
  }
  const saddleFirst = c("saddle") < SADDLE_STOCK && c("iron_ingot") >= 1 && c("leather") < 4;   // the last leather waits for the saddle
  if (c("lead") < LEAD_STOCK && c("string") >= 4 && c("leather") >= 1 && !saddleFirst && T.canFit(inv, [{ id: I("lead"), n: 2 }], [{ id: I("string"), n: 4 }, { id: I("leather"), n: 1 }])) {
    T.remove(inv, I("string"), 4); T.remove(inv, I("leather"), 1); T.add(inv, I("lead"), 2);
    return "lead";
  }
  return null;
}
const canCraft = m => {
  const c = n => cnt(m, I(n));
  return (c("saddle") < SADDLE_STOCK && c("leather") >= 3 && c("iron_ingot") >= 1) || (c("lead") < LEAD_STOCK && c("string") >= 4 && c("leather") >= 1);
};
function work(m, J, dt) {
  const S = stb(m);
  if ((S.craftT = (S.craftT || 0) + dt) < CRAFT_SECS) return;
  S.craftT = 0;
  const made = craftOne(m);
  if (!made) return;
  log("craft", m, { made });
  if (BF.vlog && m.village) BF.vlog.log(m.village, "craft", who(m) + " made " + (made === "saddle" ? "a Saddle" : "2 Leads") + " at the tack rack", m.jobsite || m);
}

// ---------------------------------------------------------------- the stable hand's day
const stb = m => m.stb || (m.stb = { task: null, stage: null, t: 0, cd: rnd(1, 3), navFail: 0, avoid: {}, noSeller: {}, waitWild: 0, exit: null, gx: null, gz: null });
const food = m => (cnt(m, I("wheat_item")) > 0 ? "wheat_item" : cnt(m, I("hay_bale")) > 0 ? "hay_bale" : null);
const ready = (r, t) => r.tamed && !isFoal(r) && t >= r.cd && (r.fed == null || t - r.fed >= FEED_DAYS);
// The paddock adult to feed so a pair breeds, or null: never past 4 horses (a pair makes one foal), never a third willing one.
function breedTarget(m, st, mine) {
  const t = now();
  const adults = mine.filter(r => r.mob && live(r.mob) && r.pen && !isFoal(r) && !r.lead);
  const willing = adults.filter(r => BF.horses.willing(r.mob)).length;
  if (willing >= 2 || mine.length + Math.floor((willing + 1) / 2) > MAX_HORSES) return null;
  const cand = adults.filter(r => ready(r, t) && !BF.horses.willing(r.mob));
  if (cand.length + willing < 2) return null;
  let best = null, bd = Infinity;
  for (const r of cand) { const d = r.mob.position.distanceTo(m.position); if (d < bd) { bd = d; best = r.mob; } }
  return best;
}
function pickTask(m, S) {
  const st = stableOf(m.village), mine = horsesOf(st), t = now();
  if (st) {
    for (const r of mine) if (r.lead && r.lead.kind === "mob" && r.lead.mob === m && r.mob && live(r.mob)) return { kind: "home", r };
    for (const r of mine) if (r.mob && live(r.mob) && !r.lead && !r.mob.rider && (!r.pen || !inBox(r.pen, r.mob.position.x, r.mob.position.z, 1))) return { kind: "fetch", r };   // a horse that lost its lead or got left outside the paddock
    if (mine.length < MIN_HORSES && t >= S.waitWild && food(m)) {
      const h = BF.horses.wildNear(st.rack.x + 0.5, st.rack.z + 0.5, CATCH_R);
      if (h && !((S.avoid["h" + h.horse.hid] || 0) > t)) return { kind: "catch", mob: h, r: h.horse };
      if (!h) { S.waitWild = Math.floor(t) + 1 + WORK_START; log("nowild", m, {}); }   // nothing in range: tomorrow
    }
    if (mine.length >= MIN_HORSES && mine.length < MAX_HORSES && food(m)) { const h = breedTarget(m, st, mine); if (h) return { kind: "feed", mob: h, r: h.horse }; }
  }
  const deal = findDeal(m, st, S);
  if (deal) return { kind: "shop", deal };
  return null;
}
function endTask(m, S, ok) {
  const tk = S.task;
  if (tk && !ok) { if (tk.r) S.avoid["h" + tk.r.hid] = now() + 0.05; if (tk.deal && tk.deal.seller.slot) S.avoid[tk.deal.seller.slot.idx] = now() + 0.05; }
  if (tk && tk.gatesOpen) setGates(tk.st, false);
  if (tk && tk.r && tk.r.mob) BF.horses.setAvoid(tk.r.mob, null);
  S.task = null; S.stage = null; S.gx = null; m.ai.route = null;
}
function setGates(st, open) {
  if (!st || !BF.world.setGate) return;
  for (const [x, z] of st.gates) if (BF.world.isLoaded(x, z)) BF.world.setGate(x, st.y, z, open);
}
const groundY = (x, z) => { const g = BF.world.heightAt(x, z); return g == null ? null : g + 1; };
// Walks to a mob (re-planning when it moved off). Returns "near" | "going" | "failed".
function toMob(m, S, dt, out, o, reach) {
  const d = Math.hypot(o.position.x - m.position.x, o.position.z - m.position.z);
  if (d <= reach && Math.abs(o.position.y - m.position.y) < 2) { m.ai.route = null; return "near"; }
  const g = { x: Math.floor(o.position.x), y: Math.floor(o.position.y + 0.01), z: Math.floor(o.position.z) };
  if (S.gx != null && Math.hypot(S.gx - g.x, S.gz - g.z) > 2) m.ai.route = null;   // it moved: plan again
  S.gx = g.x; S.gz = g.z;
  const s = BF.villageLife.travel(m, S, dt, out, g.x, g.y, g.z, m.def.speed * 1.25);
  if (s === "arrived") { m.ai.route = null; return d <= reach + 1.2 ? "near" : "going"; }
  return s === "failed" ? "failed" : "going";
}
function taskStep(m, S, dt, out) {
  const tk = S.task, H = BF.horses, ai = m.ai;
  ai.mode = "idle"; ai.t = 2;
  if (tk.kind === "shop") return shopStep(m, S, dt, out, tk);
  const st = stableOf(m.village);
  if (!st && tk.kind !== "catch") return endTask(m, S, false), false;
  const h = tk.kind === "home" || tk.kind === "fetch" ? tk.r.mob : tk.mob;
  if (!live(h) || !h.horse) return endTask(m, S, false), false;
  const r = h.horse;
  if (tk.kind === "catch") {
    if (r.tamed) return endTask(m, S, false), false;   // somebody else got it
    if (S.stage !== "tame") {
      const s = toMob(m, S, dt, out, h, 2.4);
      if (s === "failed") return endTask(m, S, false), false;
      if (s === "near") { S.stage = "tame"; S.tameT = 0.4; }
      return true;
    }
    if (Math.hypot(h.position.x - m.position.x, h.position.z - m.position.z) > 4) { S.stage = "walk"; return true; }
    out.faceX = h.position.x; out.faceZ = h.position.z; m.lookAt = h;
    if ((S.tameT -= dt) > 0) return true;
    S.tameT = TAME_EVERY; ai.swingT = 0.35;
    const f = food(m);
    if (!f) return endTask(m, S, true), false;          // out of feed: buys more, then comes back
    TR().inv.remove(m.inv, I(f), 1);
    const used = H.feed(h, f, m);
    if (!used) TR().inv.add(m.inv, I(f), 1);            // it wanted nothing (calm and fed): it is as tame as it gets
    if (!used || Math.random() * 100 < r.temper) {
      H.tame(h, st.owner); H.leash(h, m);
      r.caught = 1;
      log("tamed", m, { hid: r.hid, temper: r.temper });
      endTask(m, S, true);
    }
    return true;
  }
  if (tk.kind === "fetch") {
    if (r.lead || (r.pen && inBox(r.pen, h.position.x, h.position.z, 1)) || r.owner !== st.owner) return endTask(m, S, true), false;
    const s = toMob(m, S, dt, out, h, 2.4);
    if (s === "failed") return endTask(m, S, false), false;
    if (s === "near") { H.setPen(h, null); H.leash(h, m); ai.swingT = 0.35; endTask(m, S, true); }   // then it is led home again
    return true;
  }
  if (tk.kind === "feed") {
    if (r.owner !== st.owner || !ready(r, now()) || !food(m)) return endTask(m, S, true), false;
    const s = toMob(m, S, dt, out, h, 2.8);
    if (s === "failed") return endTask(m, S, false), false;
    if (s !== "near") return true;
    out.faceX = h.position.x; out.faceZ = h.position.z; m.lookAt = h; ai.swingT = 0.35;
    const f = food(m);
    TR().inv.remove(m.inv, I(f), 1);
    if (!H.feed(h, f, m)) TR().inv.add(m.inv, I(f), 1);
    else log("fed", m, { hid: r.hid, food: f });
    endTask(m, S, true);
    return true;
  }
  // home: lead it to the gate, open up, let it walk into the paddock, shut the gate behind it
  if (!r.lead || r.lead.kind !== "mob" || r.lead.mob !== m) { if (S.stage !== "pen") return endTask(m, S, true), false; }
  if (S.stage !== "pen") {
    const [ox, oz] = st.out[0], oy = groundY(ox, oz);
    if (oy == null) return true;
    H.setAvoid(h, st.box);                                // the led horse walks round the paddock's fence, not at it
    const s = BF.villageLife.travel(m, S, dt, out, ox, oy, oz, m.def.speed * 1.1);
    if (s === "failed") return endTask(m, S, false), false;
    if (s !== "arrived") return true;
    // wait at the gate until the horse has caught up (it follows more slowly round the fence), then open up
    if (Math.hypot(h.position.x - m.position.x, h.position.z - m.position.z) > 5 && (S.hw = (S.hw || 0) + dt) < 30) return true;
    S.hw = 0; S.stage = "pen"; S.penT = 0; tk.st = st; tk.gatesOpen = true;
    setGates(st, true);
    H.setPen(h, st.box); H.setAvoid(h, null); H.leash(h, null);
    return true;
  }
  out.faceX = (st.box.x0 + st.box.x1 + 1) / 2; out.faceZ = (st.box.z0 + st.box.z1 + 1) / 2;
  S.penT += dt;
  if (S.penT > 25 && !inBox(st.box, h.position.x, h.position.z, 0) && (tk.retry = (tk.retry || 0) + 1) <= 2) {
    H.setPen(h, null); H.leash(h, m); S.stage = null;     // it never got in: lead it to the gate again
    return true;
  }
  if (inBox(st.box, h.position.x, h.position.z, -0.3) || S.penT > 20) {
    if (BF.vlog && m.village) BF.vlog.log(m.village, "horse", who(m) + (r.caught ? " brought a wild horse home to the stable at " : " led a horse into the paddock at ") +
      st.rack.x + ", " + st.rack.y + ", " + st.rack.z + " (" + stats(r) + ")", [st.rack.x, st.rack.y, st.rack.z]);
    log("penned", m, { hid: r.hid, caught: !!r.caught, inside: inBox(st.box, h.position.x, h.position.z, 0) });
    r.caught = 0;
    endTask(m, S, true);
  }
  return true;
}
function shopStep(m, S, dt, out, tk) {
  const deal = tk.deal, v2 = deal.seller, ai = m.ai;
  if (!BF.villageLife.canSell(v2)) return endTask(m, S, false), false;
  const d = Math.hypot(v2.position.x - m.position.x, v2.position.z - m.position.z);
  if (S.stage !== "trade") {
    if (d <= 2.1 && Math.abs(v2.position.y - m.position.y) < 1.6) { S.stage = "trade"; S.tt = TRADE_PAUSE; ai.route = null; return true; }
    const s = toMob(m, S, dt, out, v2, 2.1);
    if (s === "failed") return endTask(m, S, false), false;
    return true;
  }
  if (d > 3.6) { S.stage = "walk"; return true; }
  out.faceX = v2.position.x; out.faceZ = v2.position.z; m.lookAt = v2;
  if (S.tt > TRADE_PAUSE - 0.4 && Math.random() < dt * 4) ai.swingT = 0.2;
  if ((S.tt -= dt) > 0) return true;
  const done = doDeal(m, deal);
  if (done && BF.villageLife.particles) BF.villageLife.particles(m.position.x, m.position.y + 1.5, m.position.z, "#2fd06a", 5, 0.4);
  endTask(m, S, done > 0);
  return true;
}
// Inside the paddock (after feeding) with nothing to do: out through the gate to the cell in front of it, so it never loiters among the horses.
function leave(m, S, dt, out) {
  const st = stableOf(m.village), p = m.position;
  if (!st) { S.exit = null; return false; }
  if (!S.exit) {
    if (!inBox(st.box, p.x, p.z, 0.2) || Math.abs(p.y - st.y) > 2.5) return false;
    S.exit = { t: 0 }; m.ai.route = null; S.navFail = 0;
  }
  S.exit.t += dt;
  const [ox, oz] = st.out[0], oy = groundY(ox, oz);
  const s = oy == null ? "failed" : BF.villageLife.travel(m, S, dt, out, ox, oy, oz, m.def.speed);
  if (s === "going" && S.exit.t < 30) { m.ai.mode = "idle"; m.ai.t = 2; return true; }
  S.exit = null;
  return false;
}
function ai(m, dt, out) {
  if (!m.inv || m.dead || m.child || m.tradingWith || m.sleeping || !BF.mobs.nav || !BF.villageLife || !BF.horses || !m.village) return false;
  const S = stb(m), t = skyT();
  if (t >= WORK_END || t < WORK_START) { if (S.task) endTask(m, S, true); return t >= WORK_END && leave(m, S, dt, out); }
  if (!S.task && leave(m, S, dt, out)) return true;
  if (!S.task) {
    if ((S.cd -= dt) > 0) return false;
    S.cd = rnd(1.5, 3);
    let tk = null;
    try { tk = pickTask(m, S); } catch (e) { console.error(e); }
    if (!tk) return false;
    S.task = tk; S.stage = null; S.t = 0; S.navFail = 0; S.gx = null; m.ai.route = null;
  }
  S.t += dt;
  if (S.t > (TASK_MAX[S.task.kind] || 60)) { endTask(m, S, false); return false; }
  try { return taskStep(m, S, dt, out); } catch (e) { console.error(e); endTask(m, S, false); return false; }
}
function statusText(m) {
  if (!m || m.profession !== PROF) return "";
  const S = m.stb, tk = S && S.task;
  if (!tk) {
    if (S && S.waitWild > now() && skyT() < WORK_END) { const st = stableOf(m.village); if (st && horsesOf(st).length < MIN_HORSES) return "Waiting for wild horses to come by"; }
    return "";
  }
  if (tk.kind === "catch") return S.stage === "tame" ? "Taming a wild horse" : "Going to catch a wild horse";
  if (tk.kind === "home") return S.stage === "pen" ? "Putting a horse in the paddock" : "Leading a horse home";
  if (tk.kind === "fetch") return "Fetching a loose horse";
  if (tk.kind === "feed") return "Feeding the horses";
  if (tk.kind === "shop") return "Buying " + BF.itemName(tk.deal.item);
  return "";
}
const wantsJob = m => canCraft(m);

// ---------------------------------------------------------------- trading with the player
// One offer per paddock adult it may sell (not one it is leading, not a foal), priced by its stats; refreshed when the trade screen opens.
function syncOffers(v) {
  if (!v || !Array.isArray(v.trades)) return v;
  v.trades = v.trades.filter(o => !o.horse);
  const st = v.profession === PROF ? stableOf(v.village) : null;
  if (!st || !BF.horses) return v;
  const em = I("emerald"), tk = I("tamed_horse");
  if (tk == null) return v;
  for (const r of horsesOf(st)) {
    if (!r.mob || !live(r.mob) || isFoal(r) || !r.pen || r.lead) continue;
    v.trades.push({ buy: [{ id: em, n: BF.horses.price(r) }], sell: { id: tk, n: 1 }, level: 1, xp: TR().TRADE_XP[1], horse: r.hid, dyn: 1, note: stats(r) });
  }
  return v;
}
function horseReason(v, o) {
  const r = BF.horses && BF.horses.records.get(o.horse), st = stableOf(v.village);
  if (!r || !st || r.owner !== st.owner || !r.mob || !live(r.mob) || isFoal(r) || r.lead) return "Not for sale any more";
  if (horsesOf(st).length <= MIN_HORSES) return "The stable keeps two horses for breeding";
  if (!TR().inv.canFit(v.inv, o.buy, [])) return "Villager has no room";
  return null;
}
// The trade went through (trading.js exchange has put the emeralds in its pack): the horse becomes the player's, on the player's lead
// when the stable hand has a lead to hand over with it (leads are only ever made from string and leather), else untied beside the player.
function handOver(v, o) {
  const H = BF.horses, r = H.records.get(o.horse), h = r && r.mob, P = BF.player;
  if (!h) return;
  H.tame(h, "player"); H.setPen(h, null);
  const paid = o.buy[0] ? o.buy[0].n : H.price(r);
  if (BF.vlog && v.village) BF.vlog.log(v.village, "horse", who(v) + " sold a horse to the player for " + paid + " emerald" + (paid === 1 ? "" : "s") + " (" + stats(r) + ")", v);
  log("sold", v, { hid: r.hid, price: paid });
  if (TR().inv.remove(v.inv, I("lead"), 1) === 1) H.leash(h, "player");
  else {
    H.leash(h, null);
    const yaw = P.yaw || 0, W = BF.world;
    for (const [a, d] of [[1.6, 2.5], [-1.6, 2.5], [Math.PI, 2.5], [0.8, 3.5], [-0.8, 3.5], [0, 3]]) {   // beside the player, out of the way
      const x = P.position.x - Math.sin(yaw + a) * d, z = P.position.z - Math.cos(yaw + a) * d;
      if (!W.isLoaded(x, z)) continue;
      const y = Math.floor(P.position.y);
      for (const dy of [0, 1, -1]) if (!W.boxCollides(x, y + dy, z, h.halfWidth, h.height) && W.boxCollides(x, y + dy - 0.5, z, h.halfWidth, 0.4)) { h.position.set(x, y + dy, z); h.vel.set(0, 0, 0); return; }
    }
  }
  syncOffers(v);
}
// The player right-clicked the stable hand while leading tamed horses of its own: it buys the nearest adult. Returns a message, or null to open
// the trade screen as usual (nothing on the player's lead).
function playerSells(v) {
  const H = BF.horses, P = BF.player;
  if (!H || !v || !v.village || !P) return null;
  const led = [...H.records.values()].filter(r => r.mob && live(r.mob) && r.lead && r.lead.kind === "player" && r.tamed && r.owner === "player" &&
    r.mob.position.distanceTo(v.position) < 12);
  if (!led.length) return null;
  const st = stableOf(v.village);
  if (!st) return "The stable hand has no paddock to keep a horse in";
  const adults = led.filter(r => !isFoal(r)).sort((a, b) => a.mob.position.distanceTo(v.position) - b.mob.position.distanceTo(v.position));
  if (!adults.length) return "The stable hand doesn't buy foals";
  if (horsesOf(st).length >= MAX_HORSES) return "The paddock is full";
  const r = adults[0], h = r.mob, price = H.price(r), em = I("emerald"), T = TR();
  if (cnt(v, em) < price) return "The stable hand can't afford that horse (" + price + " emeralds)";
  T.inv.remove(v.inv, em, price);
  const give = (id, n) => { const left = BF.inventory ? BF.inventory.add(id, n) : n; if (left > 0 && BF.drops) BF.drops.spawn(id, left, P.position.x, P.position.y + 1, P.position.z); };
  give(em, price);
  give(I("lead"), 1);                                   // the player's lead comes back off the horse
  if (r.saddle) { r.saddle = false; if (BF.mobs.showPart) BF.mobs.showPart(h, "saddle", false); give(I("saddle"), 1); }   // and so does its saddle
  H.tame(h, st.owner); H.leash(h, v);
  if (BF.vlog) BF.vlog.log(v.village, "trade", "Player traded with " + who(v) + ": gave a horse (" + stats(r) + "), got " + price + " Emerald", v);
  log("boughtHorse", v, { hid: r.hid, price });
  if (BF.audio && BF.audio.play) try { BF.audio.play("villager_trade", { x: v.position.x, y: v.position.y + 1.5, z: v.position.z, group: "mobs" }); } catch (_) {}
  return "Sold the horse for " + price + " emerald" + (price === 1 ? "" : "s");
}

// ---------------------------------------------------------------- global tick: foal log lines, offers
let hooked = false, offT = 0;
function hook() {
  if (hooked || !BF.on) return;
  hooked = true;
  BF.on("horseBred", foal => {
    const r = foal && foal.horse, R = r && recOfOwner(r.owner);
    if (!R || !BF.vlog) return;
    const st = stableOf(R), hand = (R.members || []).find(o => o.type === "villager" && live(o) && o.profession === PROF);
    const at = st ? st.rack : { x: Math.floor(foal.position.x), y: Math.floor(foal.position.y), z: Math.floor(foal.position.z) };
    BF.vlog.log(R, "horse", (hand ? who(hand) + " bred two horses" : "Two horses bred") + " at the stable at " + at.x + ", " + at.y + ", " + at.z +
      ": a foal with " + stats(r) + " (worth " + BF.horses.price(r) + " emeralds grown)", [at.x, at.y, at.z]);
    log("bred", hand || null, { hid: r.hid, price: BF.horses.price(r) });
  });
}
function tick(dt) {
  hook();
  if ((offT -= dt) > 0 || !BF.mobs) return;
  offT = 2;
  for (const m of BF.mobs.list) if (m.type === "villager" && m.profession === PROF && live(m) && !m.tradingWith) syncOffers(m);
}
// What a villager holds besides its pack, for the debug screen (js/debugfeed.js): a stable hand's paddock horses.
function holdings(m) {
  if (!m || m.profession !== PROF) return null;
  const st = stableOf(m.village);
  if (!st) return { horses: [], paddock: false };
  return { paddock: true, horses: horsesOf(st).map(r => ({ coat: r.coat, foal: isFoal(r) ? 1 : 0, speed: +r.speed.toFixed(1), jump: +r.jump.toFixed(1), hp: r.maxHp,
    price: BF.horses.price(r), penned: r.pen ? 1 : 0, led: r.lead ? 1 : 0, here: r.mob && live(r.mob) ? 1 : 0 })) };
}
function reset() { LOG.length = 0; offT = 0; }

// ---------------------------------------------------------------- the tamed horse icon (trade offers only)
if (BF.texKit) {
  const { SPRITES, put, mul, mix, WHITE, hex } = BF.texKit;
  SPRITES.tamed_horse = (G, m) => {   // a horse's head in profile with a halter
    const hi = mix(m, WHITE, 0.18), lo = mul(m, 0.7), mane = hex("#3a2414"), eye = hex("#141414"), strap = hex("#c8a040");
    for (let y = 2; y <= 13; y++) for (let x = 3; x <= 13; x++) {
      const neck = x >= 9 && x <= 13 && y >= 5, head = y >= 2 && y <= 8 && x >= 3 + Math.max(0, 6 - y) && x <= 12, muzzle = y >= 6 && y <= 9 && x >= 2 && x <= 7;
      if (neck || head || muzzle) put(G, x, y, y <= 3 ? hi : x <= 4 ? lo : m);
    }
    for (let y = 2; y <= 12; y++) put(G, 13, y, mane), put(G, 14, y + 1, mane);
    put(G, 11, 1, m); put(G, 12, 1, lo);                 // ears
    put(G, 7, 4, eye); put(G, 3, 7, lo);                 // eye, nostril
    for (let x = 4; x <= 9; x++) put(G, x, 6, strap);    // halter noseband
    for (let y = 3; y <= 6; y++) put(G, 9, y, strap);    // and cheek strap
  };
}

BF.stables = {
  PROF, MIN_HORSES, MAX_HORSES, CATCH_R, LOG,
  villageOK, stableOf, mayHire, pickPenTarget, ai, work, wantsJob, statusText, syncOffers, horseReason, handOver, playerSells, tick, holdings, reset,
  craftOne, findDeal, wants, breedTarget, horsesOf,
};
})();
