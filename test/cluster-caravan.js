// @ci integration suite=village timeout=900
// A caravan between two clusters (spec r15-39b, item C5: js/merchant.js, js/sharedtable.js). With the cluster tick on, a merchant walking or
// dealing away belongs to the cluster of the ground it stands on (js/clusters.js baseOf), so it is handed over to the other village's
// cluster at the meeting after it gets there, deals there, and goes back to its home's cluster at the meeting after it comes home.
// Two child processes boot the same world headless (tools/headless.js: seed 3 at the village nearest the spawn, the 3 nearest other
// villages simulated too) with the cluster tick on, one in each order ("tick" and "cluster", as test/cluster-isolation.js), and run in
// lockstep, interval by interval. In both, the same trip is set up by hand between two villages that are not the player's (the closest
// pair where one has a merchant: they are farther apart than a caravan plans, 600 blocks): a cargo the other village's villagers buy,
// both villages and the road pinned, the merchant just outside the other village; once it heads home it is put just outside home.
// Checked, in both orders: it arrives, waits for the handover, deals there in the other village's cluster, heads home, unloads in its
// home's cluster and the trip ends, with its pin dropped at the meeting; the goods are conserved (the merchant's inventory changed by
// exactly what its deals moved, and every deal moved as much out of one side as into the other); the shared table's rows are stamped
// with the meeting's tick; and both orders give the same world at every interval (the state hash's parts) and the same deals. Then three
// merchants of different villages ask for a pin in the same interval: the meeting grants MAX_PINS (2) in merchant id order and the
// third gives its trip up, the same in both orders, and pins whose trip ended in a cluster's pass are dropped at the next meeting.
// Usage: node test/cluster-caravan.js [--seed 3] [--seconds 600]
const crypto = require('crypto'), { fork } = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (process.argv[2] === '--child') child();
else parent();

function child() {
  const order = process.argv[3], seed = +arg('seed', 3);
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  const infos = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 50) errors.push(e.k + ': ' + e.x); if (e.l === 'INFO' && e.k === 'merchant' && infos.length < 50) infos.push(e.x); });
  BF.boot.headless({ seed, settings: { at: 'village', extra: 3 } });
  const C = BF.ctick, M = BF.merchant, P = BF.planet, T = BF.trades.inv;
  C.only = C.converted();
  C.order = order;
  C.on = true;
  // the merchant's deals (js/trading.js finish -> js/villagelog.js trade): [buyer, seller, gave [[id, n]], got [id, n]]
  const deals = [];
  const trade0 = BF.vlog.trade;
  BF.vlog.trade = (buyer, seller, o, times) => {
    if (buyer && buyer.profession === 'merchant' && o && o.buy) deals.push([buyer.id, seller.id, o.buy.map(b => [b.id, b.n * times]), [o.sell.id, o.sell.n * times]]);
    return trade0(buyer, seller, o, times);
  };
  let m = null, A = null, B = null, inv0 = null, tripId = null, homed = false;
  const counts = inv => { const o = {}; for (const s of inv) if (s && s.count > 0) o[s.id] = (o[s.id] || 0) + s.count; return o; };
  const stand = (from, to, past) => {   // a standing point `past` blocks beyond village `from`'s edge, toward `to`
    const v = from.wg, t = P.local(from, { x: to.x, z: to.z }, {}), L = Math.hypot(t.x - from.x, t.z - from.z), ux = (t.x - from.x) / L, uz = (t.z - from.z) / L;
    const half = v && v.minX != null ? Math.max(v.maxX - v.minX, v.maxZ - v.minZ) / 2 : 24;
    const x = Math.floor(from.x + ux * (half + past)), z = Math.floor(from.z + uz * (half + past));
    // the highest ground with room to stand (village terraces and houses are above the generated height)
    const W = BF.world, h = BF.worldgen.heightAt(x, z);
    for (let y = h + 40; y > h - 40; y--) if (W.getBlock(x, y, z) && BF.RENDER[W.getBlock(x, y, z)] !== 3 && !W.getBlock(x, y + 1, z) && !W.getBlock(x, y + 2, z)) return { x: x + 0.5, y: y + 1.05, z: z + 0.5 };
    return { x: x + 0.5, y: h + 1.1, z: z + 0.5 };
  };
  const put = p => { m.position.set(p.x, p.y, p.z); m.vel.set(0, 0, 0); m.fallStart = p.y; m.ai.route = null; M._state(m).nav = {}; };
  function setup() {
    const recs = [...BF.mobs.villages.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    const pk = C.groups().find(g => g.player);
    const player = pk ? pk.bases : [];
    let best = null;
    for (const a of recs) for (const b of recs) {
      if (a === b || player.includes('v:' + a.key) || player.includes('v:' + b.key)) continue;
      const mm = a.members.find(o => o.type === 'villager' && o.profession === 'merchant' && !o.dead && o.slot);
      if (!mm) continue;
      const d = P.distance(a, b);
      if (!best || d < best.d) best = { a, b, m: mm, d };
    }
    if (!best) return { ok: false };
    ({ a: A, b: B, m } = best);
    // a cargo the other village buys: the buy offer that can pay for the most
    const bk = M.book(B, m);
    let pick = null;
    for (const [id, xs] of bk.buys) for (const x of xs) {
      const can = Math.floor(T.count(x.v.inv, BF.I.emerald) / x.o.sell.n) * x.o.buy[0].n;
      const lot = x.o.buy[0].n;
      if (can >= lot && lot <= 64 && (!pick || can > pick.can)) pick = { id, can, u: x.u, lot };
    }
    if (!pick) return { ok: false, why: 'nobody there buys anything' };
    const n = pick.lot * Math.min(2, Math.floor(pick.can / pick.lot));   // (whole lots)
    T.add(m.inv, pick.id, n);
    const st = M._state(m);
    tripId = A.key + '#' + m.slot.idx;
    st.trip = { id: tripId, home: A.key, dest: B.key, dx: B.x, dz: B.z, day0: BF.sky.day + BF.sky.time, out: [{ id: pick.id, n, buy: 0, sell: pick.u }], back: [], soldN: 0, soldE: 0, boughtN: 0 };
    st.destWg = B.wg; st.cargo = [{ id: pick.id, n, cost: 0 }]; st.want = new Map(); st.stage = 'go'; st.errands = null;
    const pinned = BF.villageSim.pin(tripId, A.wg, B.wg);
    BF.sky.setTime(0.05);
    put(stand(B, A, 8));
    inv0 = counts(m.inv);
    return { ok: true, pinned, home: A.key, dest: B.key, d: Math.round(best.d), merchant: m.id, cargo: n + ' ' + BF.itemName(pick.id) };
  }
  process.on('message', msg => {
    if (msg.do === 'setup') { BF.boot.stream(); process.send(setup()); }
    else if (msg.do === 'interval') {
      BF.boot.stream();
      if (!m) { C.interval(BF.warp.TICK); process.send({ parts: BF.stateHash.parts(), errors: errors.splice(0) }); return; }   // (before the trip: a meeting first)
      if (BF.sky.time > 0.4) BF.sky.setTime(0.05);   // (it deals and walks by day)
      const st = M._state(m);
      // heading home: put just outside home (the walk itself is the plain caravan's, test/merchant.js)
      if (st.trip && st.stage === 'back' && !homed && C.groups().length && BF.clusters.groupOf(m.cl) === BF.clusters.groupOf('v:' + B.key) && P.distance(m.position, B) > 20) { homed = true; put(stand(A, B, 6)); }
      C.interval(BF.warp.TICK);
      const g = BF.clusters.groupOf(m.cl);
      const rows = BF.sharedTable.rows();
      process.send({ parts: BF.stateHash.parts(), tick: BF.rand.tick, stage: st.trip ? st.stage : null, cl: m.cl, inA: g === BF.clusters.groupOf('v:' + A.key), inB: g === BF.clusters.groupOf('v:' + B.key),
        dead: !!m.dead, pinned: BF.villageSim.pins().has(tripId), rows: rows.length, stamps: rows.every(r => r.tick === BF.sharedTable.tick), tableAt: BF.sharedTable.tick,
        sold: st.trip ? st.trip.soldN : null, errors: errors.splice(0) });
    } else if (msg.do === 'asks') {
      // three merchants of different villages plan a trip in the same interval (as js/merchant.js start does with the cluster tick on):
      // their pins are asked for and the meeting grants MAX_PINS of them, in merchant id order
      const recs = [...BF.mobs.villages.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), picked = [];
      for (const r of recs) {
        const mm = r.members.find(o => o.type === 'villager' && o.profession === 'merchant' && !o.dead && o.slot && !(o.mc && o.mc.trip));
        if (!mm || picked.length >= 3) continue;
        const to = recs.filter(o => o !== r).sort((a, b) => P.distance(r, a) - P.distance(r, b))[0];
        const st = M._state(mm);
        st.trip = { id: r.key + '#' + mm.slot.idx, home: r.key, dest: to.key, dx: to.x, dz: to.z, day0: BF.sky.day + BF.sky.time, out: [], back: [], soldN: 0, soldE: 0, boughtN: 0, pin: 'ask' };
        st.destWg = to.wg; st.stage = 'pin';
        picked.push(mm);
      }
      const VS = BF.villageSim, pin0 = VS.pin, granted = [];
      VS.pin = (id, a, b, k) => { const ok = pin0(id, a, b, k); if (ok) granted.push(id); return ok; };
      const trips = picked.map(o => o.mc.trip.id);
      C.interval(BF.warp.TICK);
      VS.pin = pin0;
      // (a granted trip with nothing to carry ends at once, "nothing to carry": what counts is what the meeting granted)
      const res = picked.map((o, i) => ({ id: o.id, trip: o.mc.trip ? o.mc.trip.id : null, stage: o.mc.stage, pinned: granted.includes(trips[i]) }));
      // the granted trips end without unpinning (as a trip that ends in a cluster's pass): the next meeting drops their pins
      for (const o of picked) if (o.mc.trip) { o.mc.trip = null; o.mc.stage = null; }
      C.interval(BF.warp.TICK);
      process.send({ res, log: infos.splice(0), max: BF.villageSim.MAX_PINS, left: BF.villageSim.pins().size, parts: BF.stateHash.parts() });
    } else if (msg.do === 'end') {
      const now = counts(m.inv), moved = {};
      for (const d of deals) { for (const [id, n] of d[2]) moved[id] = (moved[id] || 0) - n; moved[d[3][0]] = (moved[d[3][0]] || 0) + d[3][1]; }
      const ids = new Set([...Object.keys(now), ...Object.keys(inv0), ...Object.keys(moved)]);
      const off = [...ids].filter(id => (now[id] || 0) - (inv0[id] || 0) !== (moved[id] || 0)).map(id => BF.itemName(+id) + ' ' + ((now[id] || 0) - (inv0[id] || 0)) + ' vs ' + (moved[id] || 0));
      const at = { A: 0, B: 0 };
      for (const d of deals) { const v = BF.ids.live(d[1]); if (v && v.village === A) at.A++; else if (v && v.village === B) at.B++; }
      process.send({ deals, off, at, routes: M.routes().map(r => r.a + '|' + r.b + ' ' + r.trips), log: M.LOG.filter(l => l.who === tripId).map(l => l.kind),
        census: crypto.createHash('md5').update(JSON.stringify(BF.perf.census())).digest('hex').slice(0, 16) }, () => process.exit(0));
    }
  });
  process.send({ ready: true });
}

async function parent() {
  const seconds = +arg('seconds', 600);
  let fails = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
  const t0 = Date.now();
  const ORDERS = ['tick', 'cluster'];
  const kids = ORDERS.map(o => fork(__filename, ['--child', o, '--seed', arg('seed', 3)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  const waits = kids.map(k => { const q = []; let res = null; k.on('message', m => { if (res) { const r = res; res = null; r(m); } else q.push(m); }); return () => q.length ? Promise.resolve(q.shift()) : new Promise(r => { res = r; }); });
  const ask = (i, msg) => { kids[i].send(msg); return waits[i](); };
  await Promise.all(kids.map((k, i) => waits[i]()));
  // a meeting first, so the clusters are worked out
  await Promise.all(kids.map((k, i) => ask(i, { do: 'interval' })));
  const set = await Promise.all(kids.map((k, i) => ask(i, { do: 'setup' })));
  check(set[0].ok && set[0].pinned, `the trip is set up: ${set[0].merchant} from ${set[0].home} to ${set[0].dest} (${set[0].d} blocks), carrying ${set[0].cargo}` + (set[0].why ? ' (' + set[0].why + ')' : ''));
  check(JSON.stringify(set[0]) === JSON.stringify(set[1]), 'the same trip in both orders');
  if (!set[0].ok) { kids.forEach(k => k.kill()); console.log('FAIL cluster-caravan'); process.exit(1); }
  const seen = ORDERS.map(() => ({ stages: [], sellInB: null, unloadInA: null, waited: 0, ended: null, unpinned: null, stamps: true, rows: 0 }));
  let differ = null;
  for (let n = 1; n <= seconds; n++) {
    const r = await Promise.all(kids.map((k, i) => ask(i, { do: 'interval' })));
    for (const x of r) for (const e of x.errors) console.log(`  game log ERROR: ${e}`);
    const parts = Object.keys(r[0].parts).filter(k => r[0].parts[k] !== r[1].parts[k]);
    if (parts.length && !differ) { differ = `second ${n}: ${parts.join(', ')}`; console.log(`  the orders differ from ${differ}`); }
    r.forEach((x, i) => {
      const s = seen[i];
      if (s.stages[s.stages.length - 1] !== x.stage) s.stages.push(x.stage);
      if (x.stage === 'go' && !x.inB) s.waited++;
      if (x.stage === 'sell' && s.sellInB === null) s.sellInB = x.inB;
      if ((x.stage === 'unload' || x.stage === null) && s.unloadInA === null) s.unloadInA = x.inA;   // (the unloading round is often over within the interval)
      if (x.stage === null && s.ended === null) s.ended = n;
      if (s.ended !== null && s.unpinned === null && !x.pinned) s.unpinned = n;
      if (!x.stamps || x.tableAt !== x.tick - 20 && x.tableAt !== x.tick) s.stamps = false;
      s.rows = x.rows;
    });
    if (r.every(x => x.stage === null || x.dead) && seen.every(s => s.unpinned !== null)) break;
  }
  // pin asks at a meeting
  const asks = await Promise.all(kids.map((k, i) => ask(i, { do: 'asks' })));
  ORDERS.forEach((o, i) => {
    const a = asks[i], got = a.res.filter(x => x.pinned).map(x => x.id), ids = a.res.map(x => x.id).sort((p, q) => +p.slice(1) - +q.slice(1));
    console.log(`${o} order: pins asked by ${a.res.map(x => x.id + (x.pinned ? ' (granted, ' + x.stage + ')' : ' (' + (x.trip ? x.stage : 'refused') + ')')).join(', ')}`);
    check(a.res.length === 3 && got.length === a.max && got.join() === ids.slice(0, a.max).join(), `${o} order: the meeting granted ${a.max} of ${a.res.length} pin asks, the lowest merchant ids first`);
    check(a.res.filter(x => !x.pinned).every(x => x.trip === null), `${o} order: the refused trip was given up`);
    check(a.log.some(l => /waits: 2 trips/.test(l)) && a.log.filter(l => /may set out/.test(l)).length === a.max, `${o} order: the game log says who may set out and who waits`);
    check(a.left === 0, `${o} order: the next meeting dropped the pins of trips that ended in a pass (${a.left} left)`);
  });
  check(JSON.stringify(asks[0]) === JSON.stringify(asks[1]), 'the pin asks went the same way in both orders');
  const end = await Promise.all(kids.map((k, i) => ask(i, { do: 'end' })));
  ORDERS.forEach((o, i) => {
    const s = seen[i], e = end[i];
    console.log(`${o} order: stages ${s.stages.map(x => x || 'done').join(' > ')}; deals ${e.deals.length} (${e.at.B} there, ${e.at.A} at home); log ${e.log.join(', ')}`);
    check(s.stages.includes('sell') && s.sellInB === true, `${o} order: it dealt in the other village's cluster (handed over at a meeting; ${s.waited} s at the edge of it first)`);
    check(e.at.B > 0, `${o} order: it sold there (${e.at.B} deals)`);
    check(s.stages.includes('back'), `${o} order: it headed home`);
    check(e.log.includes('home') && s.unloadInA === true, `${o} order: it came home and ended the trip in its home's cluster`);
    check(s.ended !== null, `${o} order: the trip ended (second ${s.ended})`);
    check(s.unpinned !== null, `${o} order: its pin was dropped at a meeting (second ${s.unpinned})`);
    check(!e.off.length, `${o} order: goods conserved: the merchant's inventory changed by exactly what its deals moved` + (e.off.length ? ' (' + e.off.join('; ') + ')' : ''));
    check(s.stamps && s.rows >= 4, `${o} order: the shared table had a row for every village (${s.rows}), each stamped with the meeting's tick`);
  });
  check(!differ, 'the tick and cluster orders give the same world at every interval' + (differ ? ` (differ from ${differ})` : ''));
  check(JSON.stringify(end[0].deals) === JSON.stringify(end[1].deals) && end[0].census === end[1].census, 'the same deals and the same items in the world in both orders');
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(fails ? `FAIL cluster-caravan (${fails})` : 'PASS cluster-caravan');
  kids.forEach(k => k.kill());
  process.exit(fails ? 1 : 0);
}
