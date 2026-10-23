// @ci integration suite=jobs timeout=300
// Trades as transactions with escrow (spec r15-21): NODE_PATH=$(npm root -g) node test/run.js /tmp/te test/trade-escrow.js
// Scripted villagers ask for trades during a tick's think (BF.trades.buy from inside BF.mobs.update), as the job modules do:
// - two buyers for a seller's last diamond in one tick: the lower buyer id gets it, though the other is first in the list and asks
//   first; the other's emerald comes back;
// - a buyer with exactly one emerald asks two sellers in one tick: the first ask takes the emerald into escrow, so the second can't be
//   paid and is answered 0 at once; one diamond, no emerald;
// - a seller killed after the ask, and one unloaded (removed) after it: refused, the escrow goes back to the buyer;
// - an answer is null during the sending tick's think and the lot count at the next; a refusal logs an INFO "trades" line;
// - emeralds and diamonds are counted before and after each case (inventories, escrow, items in the world): nothing made or lost.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

  const r = await pg.evaluate(() => {
    BF.state.paused = true;   // ticks by hand (BF.simStep), no frames' ticks in between
    const T = BF.trades, I = BF.I, em = I.emerald, dia = I.diamond, P = BF.player.position, step = () => BF.simStep(BF.warp.TICK);
    const all = [];
    const vill = (dx, dz) => {
      const x = Math.floor(P.x) + dx, z = Math.floor(P.z) + dz, y = BF.world.heightAt(x, z) + 1;
      const v = BF.mobs.spawn("villager", x + 0.5, y, z + 0.5);
      v.profession = "nitwit"; v.inv = T.inv.create(); v.trades = [];
      T.inv.add(v.inv, I.bread, 16);   // not hungry: hungry villagers trade only food
      all.push(v);
      return v;
    };
    const sellOne = v => { T.inv.add(v.inv, dia, 1); const o = { buy: [{ id: em, n: 1 }], sell: { id: dia, n: 1 }, level: 1, xp: 2 }; v.trades.push(o); return o; };
    const total = id => {   // in every test villager's inventory and escrow, and lying in the world
      let n = 0;
      for (const v of all) { n += T.inv.count(v.inv, id); for (const s of T.escrowed(v)) if (s.id === id) n += s.count; }
      for (const d of BF.drops.list) if (d.id === id) n += d.count;
      return n;
    };
    // runs fn during the next tick's think (after the mobs' own update), then steps one more tick
    const inThink = fn => {
      const up = BF.mobs.update;
      let ret;
      BF.mobs.update = function () { BF.mobs.update = up; const x = up.apply(this, arguments); ret = fn(); return x; };
      try { step(); } finally { BF.mobs.update = up; }
      return ret;
    };
    const n = m => +String(m.id).slice(1);
    const res = {};

    // 1. two buyers, one diamond
    const s1 = vill(4, 4), a = vill(6, 4), b = vill(4, 6);
    const o1 = sellOne(s1);
    T.inv.add(a.inv, em, 3); T.inv.add(b.inv, em, 3);
    const [lo, hi] = n(a) < n(b) ? [a, b] : [b, a];
    const L = BF.mobs.list;
    L.splice(L.indexOf(lo), 1); L.splice(L.indexOf(hi), 1); L.push(hi, lo);   // the higher id first in the list
    let e0 = total(em), d0 = total(dia);
    const asked = inThink(() => ({ hi: T.buy(hi, s1, o1, 1), lo: T.buy(lo, s1, o1, 1), hiEsc: T.escrowed(hi).length, inFlight: BF.req.queued() }));
    const later = { hi: T.buy(hi, s1, o1, 1), lo: T.buy(lo, s1, o1, 1) };   // between ticks: the answers of the tick before
    res.one = { asked, later, loDia: T.inv.count(lo.inv, dia), hiDia: T.inv.count(hi.inv, dia), hiEm: T.inv.count(hi.inv, em), loEm: T.inv.count(lo.inv, em),
      sellerEm: T.inv.count(s1.inv, em), escrow: T.escrowed(hi).length + T.escrowed(lo).length, em: [e0, total(em)], dia: [d0, total(dia)] };
    res.one.logged = BF.glog.recent(100).some(e => /could not buy 1 Diamond/.test(JSON.stringify(e)));

    // 2. one emerald, two sellers
    const s2 = vill(-4, 4), s3 = vill(-6, 4), c = vill(-4, 6);
    const o2 = sellOne(s2), o3 = sellOne(s3);
    T.inv.add(c.inv, em, 1);
    e0 = total(em); d0 = total(dia);
    const asked2 = inThink(() => ({ first: T.buy(c, s2, o2, 1), second: T.buy(c, s3, o3, 1), held: T.inv.count(c.inv, em) }));
    res.two = { asked2, got: T.buy(c, s2, o2, 1), dia: T.inv.count(c.inv, dia), em: T.inv.count(c.inv, em), s2em: T.inv.count(s2.inv, em), s3dia: T.inv.count(s3.inv, dia),
      totals: { em: [e0, total(em)], dia: [d0, total(dia)] } };

    // 3. the seller killed, or unloaded, between the ask and the apply phase
    const s4 = vill(4, -4), s5 = vill(6, -4), d = vill(4, -6), f = vill(6, -6);
    const o4 = sellOne(s4), o5 = sellOne(s5);
    T.inv.add(d.inv, em, 2); T.inv.add(f.inv, em, 2);
    inThink(() => { T.buy(d, s4, o4, 1); T.buy(f, s5, o5, 1); BF.mobs.kill(s4); BF.mobs.discard(s5); });
    res.three = { d: T.buy(d, s4, o4, 1), f: T.buy(f, s5, o5, 1), dEm: T.inv.count(d.inv, em), fEm: T.inv.count(f.inv, em), dDia: T.inv.count(d.inv, dia), fDia: T.inv.count(f.inv, dia),
      escrow: T.escrowed(d).length + T.escrowed(f).length, sellersDia: T.inv.count(s4.inv, dia) + T.inv.count(s5.inv, dia) };

    for (const v of all) if (!v.removed) BF.mobs.discard(v);
    res.stats = T.tradeStats();
    BF.state.paused = false;
    return res;
  });
  console.log(JSON.stringify(r));
  const one = r.one;
  check(one.asked.hi === null && one.asked.lo === null && one.asked.inFlight >= 2, "both asks are in flight during the tick's think (null)");
  check(one.asked.hiEsc === 1, "the asking buyer's emerald is in escrow");
  check(one.later.lo === 1 && one.later.hi === 0, "the lower buyer id gets the last diamond, though the other came first in the list and asked first");
  check(one.loDia === 1 && one.hiDia === 0 && one.hiEm === 3 && one.loEm === 2 && one.sellerEm === 1, "goods and payment moved once; the refused buyer has its emerald back");
  check(one.escrow === 0, "no escrow left after the tick");
  check(one.em[0] === one.em[1] && one.dia[0] === one.dia[1], "emeralds and diamonds conserved (" + one.em.join(" -> ") + ", " + one.dia.join(" -> ") + ")");
  check(one.logged, "the refused trade logs an INFO trades line");
  const two = r.two;
  check(two.asked2.first === null && two.asked2.second === 0 && two.asked2.held === 0, "one emerald, two asks: the first takes it into escrow, the second can't be paid (0 at once)");
  check(two.got === 1 && two.dia === 1 && two.em === 0 && two.s2em === 1 && two.s3dia === 1, "the first trade goes through, the second seller keeps its diamond");
  check(two.totals.em[0] === two.totals.em[1] && two.totals.dia[0] === two.totals.dia[1], "emeralds and diamonds conserved (" + two.totals.em.join(" -> ") + ", " + two.totals.dia.join(" -> ") + ")");
  const three = r.three;
  check(three.d === 0 && three.f === 0, "a killed seller and an unloaded seller: both trades refused");
  check(three.dEm === 2 && three.fEm === 2 && three.dDia === 0 && three.fDia === 0 && three.escrow === 0, "both buyers have their emeralds back, nothing in escrow");
  check(three.sellersDia === 2, "the sellers still hold their diamonds");
  await pg.screenshot({ path: out + "-end.png" });
  console.log(fails.length ? "FAILED " + fails.length + ": " + fails.join("; ") : "trade-escrow: all ok");
  if (fails.length) throw new Error(fails.join("; "));
};
