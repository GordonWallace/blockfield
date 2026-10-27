// @ci integration suite=world timeout=1200
// Clusters on several workers (spec r15-39b, item C7: js/cworkers.js). Each worker runs only the cluster groups it owns and the
// workers swap what their groups changed at each meeting; the world must come out the same as one worker running every group.
// One worker_thread runs the reference (the cluster tick on one worker) and n more run the same world as cluster workers, all booted
// the same way (tools/headless.js: seed 3 at the village nearest the spawn, the --extra nearest other villages simulated too) with the
// same systems (BF.ctick.only: --profile converted, the default and CI: the systems js/ctick.js SYSTEMS marks converted; or a list,
// "mobloop,builder,...", each run as converted for the test: how a C2-C6 thread tries its systems before flipping their lines).
// They run in lockstep, interval by interval (a meeting every 20 ticks), loading
// chunks between intervals; after each interval every worker's state hash parts (js/statehash.js) and every mob's and village record's
// canonical text are compared with the reference's, and the first objects that differ are printed with where their text first differs.
// Owners: by default (and CI) by a hash of each group, never moving. --shuffle k: the groups change workers at every meeting (by a hash
// of k), so every hand-over is tried: module state left behind on the old worker shows up here (the C2-C6 bar once C3 has made the mob
// loop's tables owned). --plan: planned from the measured times (js/cworkers.js plan). --order cluster (without --shuffle): nobody owns
// a group, each worker takes the next one when it is free (js/cworkers.js claim), so groups move between workers as with --shuffle.
// Usage: node test/cluster-workers.js [--workers 2] [--seed 3] [--extra 3] [--seconds 30] [--shuffle k | --plan] [--order tick|cluster]
//                                    [--profile converted|a,b,c]
const path = require('path'), crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (!isMainThread) child();
else main().catch(e => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------- a worker: one world
function child() {
  const { me, n, seed, extra, order, shuffle, fixed, profile, shared } = workerData;
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 50) errors.push(e.k + ': ' + e.x); });
  BF.boot.headless({ seed, settings: { at: 'village', extra } });
  const C = BF.ctick;
  C.only = profile === 'converted' ? C.converted() : profile.split(',');
  for (const k of C.only) if (C.SYSTEMS[k] === false) C.SYSTEMS[k] = true;   // (a system tried before it is marked converted)
  C.order = order;
  C.on = true;
  if (shared) {
    BF.cworkers.shuffle = shuffle;
    BF.cworkers.fixed = fixed;
    BF.cworkers.sizes = {};
    BF.cworkers.setup({ n, me, link: BF.rworkers.attach(shared, me, n), claims: shared.claims, shm: shared.shm });
  }
  const md5 = t => crypto.createHash('md5').update(t).digest('hex').slice(0, 16);
  const objs = () => {
    const o = {};
    for (const m of BF.mobs.list) if (!m.removed) o['mob ' + m.id] = md5(BF.stateHash.canon(m));
    for (const [k, v] of BF.mobs.villages) o['village ' + k] = md5(BF.stateHash.canon(v));
    return o;
  };
  const textOf = k => {
    const kind = k.slice(0, k.indexOf(' ')), id = k.slice(k.indexOf(' ') + 1);
    const o = kind === 'mob' ? BF.ids.live(id) : BF.mobs.villages.get(id);
    return o ? BF.stateHash.canon(o) : null;
  };
  parentPort.on('message', msg => {
    try {
      if (msg.do === 'interval') {
        BF.boot.stream();
        C.interval(BF.warp.TICK);
        const s = C.stats();
        parentPort.postMessage({ parts: BF.stateHash.parts(), objs: objs(), tick: BF.rand.tick, mobs: BF.mobs.list.length, groups: s.groups.length,
          errors: errors.splice(0), owners: shared ? [...BF.cworkers.owners] : null, text: shared ? BF.cworkers.text() : null });
      } else if (msg.do === 'text') parentPort.postMessage({ texts: msg.keys.map(textOf), parts: msg.parts.map(p => BF.stateHash.text(p)) });
      else if (msg.do === 'stats') parentPort.postMessage({ stats: shared ? BF.cworkers.stats() : null, sizes: shared ? BF.cworkers.sizes : null });
      else if (msg.do === 'stop') process.exit(0);
    } catch (e) {
      try { if (BF.cworkers.link) BF.cworkers.link.stop(me); } catch (_) { /* already */ }
      parentPort.postMessage({ error: String(e && e.stack || e) });
    }
  });
  parentPort.postMessage({ booted: true });
}

// ---------------------------------------------------------------- the parent
async function main() {
  const n = +arg('workers', 2), seed = +arg('seed', 3), extra = +arg('extra', 3), seconds = +arg('seconds', 30);
  const order = arg('order', 'tick'), pull = order === 'cluster' && arg('shuffle') == null;
  const profile = arg('profile', 'converted'), plan = process.argv.includes('--plan'), fixed = !plan && !pull && arg('shuffle') == null;
  const shuffle = plan || pull ? 0 : +arg('shuffle', 1);
  const { load } = require('../tools/headless.js');
  const shared = load().BF.cworkers.makeShared(n, 0, process.argv.includes('--shm'));   // (--shm: the shared-memory prototype, js/shm.js)
  const spawn = data => {
    const w = new Worker(__filename, { workerData: Object.assign({ seed, extra, order, shuffle, fixed, profile }, data) });
    const waiting = [];
    w.on('message', m => { const f = waiting.shift(); if (f) f(m); });
    w.on('error', e => { console.error(e); process.exit(1); });
    return { w, next: () => new Promise(ok => waiting.push(ok)), ask(msg) { const p = this.next(); w.postMessage(msg); return p; } };
  };
  const t0 = Date.now();
  const ref = spawn({ me: 0, n: 1, shared: null });
  const ws = [];
  for (let me = 0; me < n; me++) ws.push(spawn({ me, n, shared }));
  await Promise.all([ref, ...ws].map(x => x.next()));
  console.log(`booted the reference and ${n} cluster workers in ${((Date.now() - t0) / 1000).toFixed(1)} s (seed ${seed}, extra ${extra}, ${order} order${pull ? ', groups pulled' : shuffle ? (fixed ? ', fixed owners ' : ', shuffle ') + shuffle : ''}, profile ${profile})`);
  let fails = 0, errs = 0;
  const all = [ref, ...ws];
  for (let s = 1; s <= seconds; s++) {
    const out = await Promise.all(all.map(x => x.ask({ do: 'interval' })));
    const bad = out.find(o => o.error);
    if (bad) { console.error('a worker failed:\n' + bad.error); process.exit(1); }
    const r = out[0];
    for (let w = 1; w < out.length; w++) for (const e of out[w].errors) { errs++; if (errs <= 20) console.log(`  worker ${w - 1} ERROR ${e}`); }
    for (const e of r.errors) { if (errs++ <= 20) console.log(`  reference ERROR ${e}`); }
    const diffs = [];
    for (let w = 1; w < out.length; w++) {
      const o = out[w];
      const parts = Object.keys(r.parts).filter(k => r.parts[k] !== o.parts[k]);
      if (!parts.length) continue;
      const keys = new Set([...Object.keys(r.objs), ...Object.keys(o.objs)]);
      const objs = [...keys].filter(k => r.objs[k] !== o.objs[k]).sort();
      diffs.push({ w: w - 1, parts, objs });
    }
    if (s === 1 || s % 10 === 0 || diffs.length) console.log(`second ${s}: tick ${r.tick}, ${r.mobs} mobs, ${r.groups} groups; ${out[1].text}; owners ${out[1].owners.map(x => x.join('>')).join(' ')}`);
    if (diffs.length) {
      fails++;
      for (const d of diffs) {
        console.log(`  worker ${d.w} differs in ${d.parts.join(', ')}: ${d.objs.length} objects (${d.objs.slice(0, 6).join(', ')}${d.objs.length > 6 ? ', ...' : ''})`);
        const keys = d.objs.slice(0, 3), ps = d.parts.filter(p => p !== 'mobs' && p !== 'villages').slice(0, 2);
        const [a, b] = await Promise.all([ref.ask({ do: 'text', keys, parts: ps }), ws[d.w].ask({ do: 'text', keys, parts: ps })]);
        const show = (label, p, q) => {
          if (p == null || q == null) { console.log(`    ${label}: ${p == null ? 'missing in the reference' : 'missing on the worker'}`); return; }
          let i = 0; while (i < p.length && p[i] === q[i]) i++;
          console.log(`    ${label} from character ${i}:\n      reference ...${p.slice(Math.max(0, i - 160), i + 120)}\n      worker    ...${q.slice(Math.max(0, i - 160), i + 120)}`);
        };
        keys.forEach((k, i) => show(k, a.texts[i], b.texts[i]));
        ps.forEach((k, i) => show(k, a.parts[i], b.parts[i]));
      }
      if (fails >= 2) break;
    }
  }
  const st = await Promise.all(ws.map(x => x.ask({ do: 'stats' })));
  const f2 = v => v.toFixed(2);
  for (const [w, o] of st.entries()) { const p = o.stats.perMeeting; console.log(`worker ${w}: ms a meeting: run ${f2(p.run)}, collect ${f2(p.collect)}, exchange ${f2(p.exchange)}, adopt ${f2(p.adopt)}, shadows ${f2(p.snap)}; ${f2(o.stats.kbPerMeeting)} KB sent a meeting (` +
    Object.entries(o.sizes).filter(e => e[1] > 200 * o.stats.meetings).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + f2(v / o.stats.meetings / 1024)).join(', ') + ')'); }
  for (const x of all) x.w.postMessage({ do: 'stop' });
  const ok = !fails;
  console.log(ok ? `PASS: ${n} cluster workers match one worker for ${seconds} s` : 'FAIL: the cluster workers\' world differs from one worker\'s');
  process.exit(ok ? 0 : 1);
}
