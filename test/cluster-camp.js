// @ci integration suite=world,village timeout=900
// An explorer's tent pitched in another cluster's land, on several cluster workers (js/cworkers.js, partial copies). The pitch is a
// "cells" request (js/blockreqs.js) to the site's cluster, so it waits for the meeting (js/ctick.js) and is applied and delivered there
// on every worker alike. Its result used to be a req.then callback, which runs only on the worker that sent it: the camp was made on that
// worker alone, and the copy check stopped the workers (Gordon's laptop, 2026-10-30: worker 1 had one more explorer camp than the others).
// Three workers run seed 3 at its village nearest the spawn with --extra more villages. One explorer, on whichever worker runs it, is moved
// beside a villager of another cluster and pitches there (as if it had walked there); two intervals later:
//   - the pitch went to the other cluster (waited for the meeting), and no request crossed with callbacks (BF.ctick stats closures);
//   - every worker has the same camp for it, it sleeps in the tent on every copy (its bed is the tent: the gathered state hashes);
//   - every worker's state hash is the same, and no ERROR in any worker's game log.
// Usage: node test/cluster-camp.js [--workers 3] [--extra 3] [--seed 3]
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (!isMainThread) child();
else main().catch(e => { console.error(e); process.exit(1); });

function child() {
  const { me, n, seed, extra, shared } = workerData;
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 50) errors.push(e.k + ': ' + e.x); });
  BF.boot.headless({ seed, settings: { at: 'village', extra } });
  const C = BF.ctick, CW = BF.cworkers;
  C.only = C.converted(); C.order = 'tick'; C.on = true;
  CW.shuffle = 1; CW.fixed = true;
  CW.setup({ n, me, link: BF.rworkers.attach(shared, me, n), claims: shared.claims, partial: true });
  const keyOf = m => m.village.key + '#' + m.slot.idx;
  let plan = null, fired = null, atMeet = null;
  // at the end of each meeting (after the requests that waited are delivered, as the copy check sees the world): the explorer's camp and
  // bed, the first time it has one
  C.onMeet(() => {
    if (!plan || atMeet || !BF.explorer.camps.has(plan.key)) return;
    const m = BF.ids.live(plan.id);
    atMeet = { tick: BF.rand.tick, camp: JSON.stringify(BF.explorer.camps.get(plan.key)), bed: m ? JSON.stringify(m.bed) : null };
  }, 'test camp', 'end');
  const ai = BF.explorer.ai;
  BF.explorer.ai = function (m, dt, out) {   // (runs only on the worker that runs the explorer, in its cluster's pass)
    if (plan && !fired && m.id === plan.id) {
      m.position.set(plan.x + 0.5, BF.world.heightAt(plan.x, plan.z) + 1, plan.z + 0.5);
      BF.trades.inv.add(m.inv, BF.I.tent, 1);
      const was = C.stats().deferred;
      const ok = BF.explorer.pitch(m);
      fired = { ok, crossed: C.stats().deferred > was, group: C.cur && C.cur.key };
      return true;
    }
    return ai.apply(this, arguments);
  };
  parentPort.on('message', msg => {
    try {
      if (msg.do === 'interval') { BF.boot.stream(); C.interval(BF.warp.TICK); parentPort.postMessage({ errors: errors.splice(0) }); }
      else if (msg.do === 'pick') {
        // an explorer awake at its village, and a villager of another cluster standing on natural ground
        const ex = BF.mobs.list.filter(m => m.profession === 'explorer' && !m.removed && !m.dead && m.village && m.slot && !m.sleeping);
        let out = null;
        for (const e of ex) {
          const g = C.ofMob(e);
          const v = BF.mobs.list.find(o => o.type === 'villager' && !o.removed && o.village && o.village !== e.village && C.ofMob(o) && C.ofMob(o) !== g);
          if (v) { out = { id: e.id, key: keyOf(e), x: Math.floor(v.position.x) + 3, z: Math.floor(v.position.z) + 3, from: g, to: C.ofMob(v) }; break; }
        }
        parentPort.postMessage({ plan: out });
      } else if (msg.do === 'arm') { plan = msg.plan; parentPort.postMessage({}); }
      else if (msg.do === 'compare') {
        const hash = CW.gathered(() => BF.stateHash.full(), 'hash');
        parentPort.postMessage({ fired, atMeet, closures: C.stats().closures, hash: hash.hash, villagers: hash.parts.villagers, errors: errors.splice(0) });
      } else if (msg.do === 'stop') process.exit(0);
    } catch (e) { parentPort.postMessage({ error: String(e && e.stack || e) }); }
  });
  parentPort.postMessage({ booted: true });
}

async function main() {
  const n = +arg('workers', 3), extra = +arg('extra', 3), seed = +arg('seed', 3);
  const { BF } = require('../tools/headless.js').load();
  let fails = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
  const shared = BF.cworkers.makeShared(n);
  const ws = [];
  for (let me = 0; me < n; me++) {
    const w = new Worker(__filename, { workerData: { me, n, seed, extra, shared } });
    const waiting = [];
    w.on('message', m => { const f = waiting.shift(); if (f) f(m); });
    w.on('error', e => { console.error(e); process.exit(1); });
    ws.push({ w, next: () => new Promise(ok => waiting.push(ok)), ask(msg) { const p = this.next(); w.postMessage(msg); return p; } });
  }
  await Promise.all(ws.map(x => x.next()));
  const ask = async msg => { const o = await Promise.all(ws.map(x => x.ask(msg))); const bad = o.find(x => x.error); if (bad) { console.error('a worker failed:\n' + bad.error); process.exit(1); } return o; };
  let errs = [];
  for (let i = 0; i < 2; i++) for (const x of await ask({ do: 'interval' })) errs.push(...x.errors);
  const plan = (await ask({ do: 'pick' }))[0].plan;
  check(!!plan, `an explorer and a villager of another cluster to pitch beside (${plan ? 'explorer ' + plan.key + ' of ' + plan.from + ', beside ' + plan.to : 'none'})`);
  if (!plan) process.exit(1);
  await ask({ do: 'arm', plan });
  let c = null;
  for (let i = 0; i < 6; i++) {
    for (const x of await ask({ do: 'interval' })) errs.push(...x.errors);
    c = await ask({ do: 'compare' });
    if (c.some(x => x.atMeet)) break;
  }
  const f = c.map(x => x.fired).filter(Boolean), at = c.map(x => x.atMeet && x.atMeet.tick);
  check(f.length === 1, `the explorer pitched on the one worker that runs it (${f.length})`);
  check(f.length === 1 && f[0].ok && f[0].crossed, `the pitch went to the other cluster, to wait for the meeting (${JSON.stringify(f[0])})`);
  check(c.every(x => x.closures === 0), `no request crossed with callbacks (${c.map(x => x.closures).join('/')})`);
  check(c.every(x => x.atMeet && x.atMeet.tick === c[0].atMeet.tick && x.atMeet.camp === c[0].atMeet.camp), `every worker has the explorer's camp from the same meeting (ticks ${at.join('/')}; ${c.map(x => x.atMeet && x.atMeet.camp).join(' | ')})`);
  check(c.every(x => x.atMeet && /"tent":true/.test(x.atMeet.bed)), `on every worker it sleeps in the tent (${c.map(x => x.atMeet && x.atMeet.bed).join(' | ')})`);
  check(c.every(x => x.hash === c[0].hash), `every worker's state hash is the same (${c.map(x => x.hash).join(' ')}; villagers ${c.map(x => x.villagers).join(' ')})`);
  for (const x of c) errs.push(...x.errors);
  check(!errs.length, `no ERROR in the workers' game log${errs.length ? ': ' + errs.slice(0, 3).join(' | ').slice(0, 600) : ''}`);
  await Promise.all(ws.map(x => x.w.terminate()));
  console.log(fails ? `FAIL: ${fails} check(s) failed` : 'PASS: a tent pitched in another cluster is the same camp on every worker');
  process.exit(fails ? 1 : 0);
}
