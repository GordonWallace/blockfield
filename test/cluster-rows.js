// @ci integration suite=world,village timeout=1200
// Saves and copy checks from rows (js/cworkers.js gathered(fn, use)). With partial copies a save (js/save.js) and the copy check (the
// state hash) used to have every worker send its mobs whole; now each worker sends only the rows it works out of the mobs it runs
// (BF.mobRows), and the modules read every mob through BF.cworkers.row. Three cluster workers (partial copies, as in play) run seed 3 and
// seed 5 at their village nearest the spawn with --extra more villages; at a few points every worker takes the save and the hash both
// ways, and they must be the same:
//   - the save from rows is the save from the mobs sent whole, on every worker, but for drawing-only fields (a walk's phase, a head's
//     turn), which the whole mobs never carried: the rows have the runner's, the old way kept the stale copy's;
//   - the hash from rows is the hash from whole mobs, and the same on every worker;
//   - with two bred villagers in the world (a child and a grown one: js/breeding.js reads their place and profession);
//   - while the rows' fn runs, every stale copy here is overwritten with junk (and put back after): a module reading a mob another
//     worker runs without row() would read the junk, so the save or hash would come out different.
// Usage: node test/cluster-rows.js [--workers 3] [--extra 4] [--seconds 6] [--seeds 3,5]
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const md5 = t => crypto.createHash('md5').update(t).digest('hex').slice(0, 16);
// fields drawn only (js/rworkers.js SKIP): never sent whole, so the old way's are the stale copy's own
const DRAWN = new Set(['walkPhase', 'walkAmt', 'headYaw', 'headPitch', 'prevPos', 'prevYaw', 'lerp', '_res']);
const strip = v => JSON.stringify(v, (k, x) => (DRAWN.has(k) || k.startsWith('_snd') ? undefined : x));

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
  // two bred villagers (js/breeding.js), alike on every worker: a child and one grown up and unemployed. Their village's save part reads
  // their place and profession (metaOf), so it must read them through the "bred" row (their stale copies here had an old profession)
  BF.mobs.list.filter(m => m.type === 'villager' && !m.removed && !m.dead && m.village && !m.bred).slice(0, 2).forEach((m, i) => {
    BF.breeding.makeChild(m, ['farmer', 'farmer']);
    if (i) { m.child = false; m.profession = 'unemployed'; }
  });
  const C = BF.ctick, CW = BF.cworkers;
  C.only = C.converted(); C.order = 'tick'; C.on = true;
  CW.shuffle = 1; CW.fixed = true; CW.sizes = {};
  CW.setup({ n, me, link: BF.rworkers.attach(shared, me, n), claims: shared.claims, partial: true });
  // fn with every copy of a mob another worker runs overwritten with junk, put back after
  const poisoned = fn => () => {
    const keep = [];
    for (const m of BF.mobs.list) {
      if (m.removed || CW.current(m)) continue;
      const o = {};
      for (const k of Object.keys(m)) o[k] = m[k];
      keep.push([m, o]);
      for (const k of Object.keys(m)) {
        if (k === 'id' || k === 'def' || k === 'type' || k === 'removed') continue;
        const v = m[k];
        m[k] = typeof v === 'number' ? -77777 : typeof v === 'string' ? 'junk' : typeof v === 'boolean' ? !v : v && v.isVector3 ? new THREE.Vector3(-7, -7, -7) : Array.isArray(v) ? ['junk'] : v && typeof v === 'object' ? { junk: 1 } : v;
      }
    }
    try { return fn(); } finally { for (const [m, o] of keep) { for (const k of Object.keys(m)) delete m[k]; Object.assign(m, o); } }
  };
  parentPort.on('message', msg => {
    try {
      if (msg.do === 'interval') { BF.boot.stream(); C.interval(BF.warp.TICK); parentPort.postMessage({ mobs: BF.mobs.list.length, errors: errors.splice(0) }); }
      else if (msg.do === 'compare') {
        const save = () => BF.save.snapshot({ quiet: true }), hash = () => BF.stateHash.full().hash;
        let stale = 0;
        for (const m of BF.mobs.list) if (!m.removed && !CW.current(m)) stale++;
        // (a save stores each loaded horse's place in its record, js/horses.js store, after the mobs' rows have read it: a stable hand's
        // task holds the record. So the records go back as they were before the second save.)
        const recs = [...BF.horses.records.values()].map(r => [r, r.x, r.y, r.z, r.yaw, r.hp]);
        const sRows = strip(CW.gathered(poisoned(save), 'save'));
        for (const [r, x, y, z, yaw, hp] of recs) Object.assign(r, { x, y, z, yaw, hp });
        const sWhole = strip(CW.gathered(save));
        const hRows = CW.gathered(poisoned(hash), 'hash'), hWhole = CW.gathered(hash);
        let where = null;
        if (sRows !== sWhole) { let i = 0; while (sRows[i] === sWhole[i]) i++; where = sWhole.slice(Math.max(0, i - 120), i + 80) + '\n   rows: ' + sRows.slice(Math.max(0, i - 120), i + 80); }
        parentPort.postMessage({ stale, save: sRows === sWhole, saveMd5: md5(sRows), where, hRows, hWhole, errors: errors.splice(0) });
      } else if (msg.do === 'stop') process.exit(0);
    } catch (e) { parentPort.postMessage({ error: String(e && e.stack || e) }); }
  });
  parentPort.postMessage({ booted: true });
}

async function main() {
  const n = +arg('workers', 3), extra = +arg('extra', 4), seconds = +arg('seconds', 6), seeds = arg('seeds', '3,5').split(',').map(Number);
  const { BF } = require('../tools/headless.js').load();
  let fails = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
  for (const seed of seeds) {
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
    let errs = 0;
    for (let s = 1; s <= seconds; s++) {
      const o = await ask({ do: 'interval' });
      for (const x of o) errs += x.errors.length;
      if (s % 3 && s !== seconds) continue;
      const c = await ask({ do: 'compare' });
      const stale = c.reduce((a, x) => a + x.stale, 0);
      console.log(`seed ${seed}, second ${s}: ${o[0].mobs} mobs, ${stale} stale copies over ${n} workers`);
      check(stale > 0, `seed ${seed} s ${s}: some copies are stale (else the test shows nothing)`);
      for (let w = 0; w < n; w++) {
        check(c[w].save, `seed ${seed} s ${s}: worker ${w}'s save from rows is its save from whole mobs`);
        if (c[w].where) console.log('   whole: ' + c[w].where);
      }
      check(c.every(x => x.hRows === x.hWhole), `seed ${seed} s ${s}: the hash from rows is the hash from whole mobs on every worker (${c.map(x => x.hRows).join(' ')})`);
      check(c.every(x => x.hRows === c[0].hRows), `seed ${seed} s ${s}: every worker's hash is the same`);
      for (const x of c) errs += x.errors.length;
    }
    check(errs === 0, `seed ${seed}: no ERROR in the workers' game log`);
    await Promise.all(ws.map(x => x.w.terminate()));
  }
  console.log(fails ? `FAIL: ${fails} check(s) failed` : 'PASS: saves and copy checks from rows match the whole mobs');
  process.exit(fails ? 1 : 0);
}
