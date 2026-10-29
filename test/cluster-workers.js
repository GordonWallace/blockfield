// @ci integration suite=world timeout=1200 args=--bees
// Clusters on several workers (spec r15-39b, item C7: js/cworkers.js). Each worker runs only the cluster groups it owns and the
// workers swap what their groups changed at each meeting; the world must come out the same as one worker running every group.
// One worker_thread runs the reference (the cluster tick on one worker) and n more run the same world as cluster workers, all booted
// the same way (tools/headless.js: seed 3 at the village nearest the spawn, the --extra nearest other villages simulated too) with the
// same systems (BF.ctick.only: --profile converted, the default and CI: the systems js/ctick.js SYSTEMS marks converted; or a list,
// "mobloop,builder,...", each run as converted for the test: how a C2-C6 thread tries its systems before flipping their lines).
// They run in lockstep, interval by interval (a meeting every BF.ctick.MEET ticks), loading
// chunks between intervals; after each interval every worker's state hash parts (js/statehash.js) and every mob's and village record's
// canonical text are compared with the reference's, and the first objects that differ are printed with where their text first differs.
// Owners: by default (and CI) by a hash of each group, never moving. --shuffle k: the groups change workers at every meeting (by a hash
// of k), so every hand-over is tried: module state left behind on the old worker shows up here (the C2-C6 bar once C3 has made the mob
// loop's tables owned). --plan: planned from the measured times (js/cworkers.js plan). --order cluster --pull (without --shuffle): nobody
// owns a group, each worker takes the next one when it is free (js/cworkers.js claim), so groups move between workers as with --shuffle.
// --partial: partial copies (js/cworkers.js CW.partial): each worker is compared with every mob's current copy gathered in (gathered).
// --bees: bee homes broken and placed in different groups' passes (seconds 3 and 6): every worker's records and loaded homes must follow
// the owner's (js/bees.js onReplayed and the bees table: a home broken on its group's worker used to stay in the others' records).
// --leave s: back to one at second s (js/cworkers.js leave, as js/rplay.js toSolo): every worker takes the whole world and goes on
// running every cluster on its own copy, as the leader does and its followers replaying it; the copies must stay the same as the
// reference (the plain tick read the copies' tables in their different orders and they drifted: Gordon's run, 2026-10-29).
// --drop s: at second s the fixed set of extra villages shrinks by 3 (BF.active fixed): the farthest leave and unload while split, their
// chunks' wild mobs stored (a chunk dropping fetched only the mobs some worker ran: one current everywhere was left out of the set, so no
// copy unloaded it and its owner stored it a tick later, where it had walked off to).
// --restored: items on the ground before the tick starts, as from a save (with --plan: see restoredDrops). --load file: boot from a save
// (tools/headless.js --save) instead of the seed.
// Usage: node test/cluster-workers.js [--workers 2] [--seed 3] [--extra 3] [--seconds 30] [--shuffle k | --plan] [--order tick|cluster] [--pull] [--partial] [--bees] [--restored] [--leave s] [--drop s] [--load save.json]
//                                    [--profile converted|a,b,c]
const path = require('path'), crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

if (!isMainThread) child();
else main().catch(e => { console.error(e); process.exit(1); });

// ---------------------------------------------------------------- a worker: one world
function child() {
  const { me, n, seed, extra, order, shuffle, fixed, profile, shared, pull, partial, bees, save, restored } = workerData;
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 50) errors.push(e.k + ': ' + e.x); });
  BF.boot.headless({ seed, save: save ? JSON.parse(require('fs').readFileSync(save, 'utf8')) : null, settings: { at: 'village', extra } });
  if (restored) restoredDrops(BF);
  const C = BF.ctick;
  C.only = profile === 'converted' ? C.converted() : profile.split(',');
  for (const k of C.only) if (C.SYSTEMS[k] === false) C.SYSTEMS[k] = true;   // (a system tried before it is marked converted)
  C.order = order;
  C.on = true;
  if (shared) {
    BF.cworkers.shuffle = shuffle;
    BF.cworkers.fixed = fixed;
    BF.cworkers.sizes = {};
    BF.cworkers.setup({ n, me, link: BF.rworkers.attach(shared, me, n), claims: shared.claims, pull, partial });
  }
  const homeEdits = bees ? beeEdits(BF) : null;
  const md5 = t => crypto.createHash('md5').update(t).digest('hex').slice(0, 16);
  const objs = () => {
    const o = {};
    for (const m of BF.mobs.list) if (!m.removed) o['mob ' + m.id] = md5(BF.stateHash.canon(m)) + ' in ' + m.cl;   // (and its cluster: the meetings place it alike)
    for (const [k, v] of BF.mobs.villages) o['village ' + k] = md5(BF.stateHash.canon(v));
    if (bees) o['bee homes'] = md5(BF.bees.loadedHomes().map(h => [h.x, h.y, h.z]).sort().join(';'));   // (loaded is not in the hash)
    return o;
  };
  // the bees that are out, by their cluster (js/bees.js beeGroup; not in the state hash; with partial copies only the worker running a group has its bees, so
  // the parent puts the workers' lists together)
  const beesOut = () => {
    const by = {};
    for (const b of (BF.bees && BF.bees.list) || []) { const k = String(b.cl !== undefined ? b.cl : b.home ? BF.clusters.ofRegion(BF.regions.keyOf(b.home.x, 0, b.home.z)) : 'none'); (by[k] || (by[k] = [])).push(JSON.stringify([b.x, b.y, b.z, b.mode, b.home ? [b.home.x, b.home.y, b.home.z] : null, b.trips])); }
    for (const k in by) by[k] = md5(by[k].sort().join(';'));
    return by;
  };
  const textOf = k => {
    const kind = k.slice(0, k.indexOf(' ')), id = k.slice(k.indexOf(' ') + 1);
    if (k === 'bee homes') return BF.bees.loadedHomes().map(h => [h.x, h.y, h.z].join(',')).sort().join(' ');
    const o = kind === 'mob' ? BF.ids.live(id) : BF.mobs.villages.get(id);
    return o ? (kind === 'mob' ? 'in ' + o.cl + ' ' : '') + BF.stateHash.canon(o) : null;
  };
  parentPort.on('message', msg => {
    try {
      const all = fn => (shared ? BF.cworkers.gathered(fn) : fn());   // (partial copies: every mob's current copy, from its worker)
      if (msg.do === 'interval') {
        BF.boot.stream();
        if (homeEdits) homeEdits(msg.s);
        if (msg.leave && shared) BF.cworkers.leave();   // (--leave: back to one at this interval's meeting)
        if (msg.drop != null) BF.active.set({ fixed: msg.drop }, true);   // (--drop: the farthest extras leave the simulated set and unload)
        C.interval(BF.warp.TICK);
        const s = C.stats();
        const [parts, os] = all(() => [BF.stateHash.parts(), objs()]);
        parentPort.postMessage({ parts, objs: os, beesOut: beesOut(), tick: BF.rand.tick, mobs: BF.mobs.list.length, groups: s.groups.length,
          errors: errors.splice(0), owners: shared ? [...BF.cworkers.owners] : null, text: shared ? BF.cworkers.text() : null });
      } else if (msg.do === 'text') parentPort.postMessage(all(() => ({ texts: msg.keys.map(textOf), parts: msg.parts.map(p => BF.stateHash.text(p)) })));
      else if (msg.do === 'stats') parentPort.postMessage({ stats: shared ? BF.cworkers.stats() : null, sizes: shared ? BF.cworkers.sizes : null });
      else if (msg.do === 'stop') process.exit(0);
    } catch (e) {
      try { if (BF.cworkers.link) BF.cworkers.link.stop(me); } catch (_) { /* already */ }
      parentPort.postMessage({ error: String(e && e.stack || e) });
    }
  });
  parentPort.postMessage({ booted: true });
}

// --restored: items lying on the ground before the cluster tick starts, as a save restores them (js/drops.js restore: no pass has worked
// out their cluster), a few round each village's centre, alike in every copy. With --plan the first meeting gives every group to the
// first worker (nothing measured yet), so the others run no pass that interval: they must still send and replace those items by
// their cluster at the meeting (js/mobs.js thingBase; until it they kept their own copies, and the worlds drifted apart).
function restoredDrops(BF) {
  const ids = ['oak_log', 'stick', 'apple', 'cobblestone'].map(k => BF.resolveItem(k)).filter(x => x != null);
  let i = 0;
  for (const k of [...BF.mobs.villages.keys()].sort()) {
    const [x, z] = k.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    for (let j = 0; j < 4; j++) {
      const px = x + 0.5 + (j % 2) * 2, pz = z + 0.5 + (j >> 1) * 2;
      if (!BF.world.isLoaded(px, pz)) continue;
      BF.drops.spawn(ids[i++ % ids.length], 1 + (j % 3), px, BF.worldgen.heightAt(Math.floor(px), Math.floor(pz)) + 2, pz, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 0 });
    }
  }
}

// --bees: at second 3 the first loaded home (by position) is broken in its group's pass, and a hive is placed above a home in each of two
// other groups (both in the same interval, on different workers when the owners differ); at second 6 the first placed hive is broken
// again. Picked alike in every copy, between intervals; done in the group's own pass (on its worker), mid-interval, as a villager would.
function beeEdits(BF) {
  const C = BF.ctick, W = BF.world, todo = [];
  const prev = BF.mobs.update;
  BF.mobs.update = function () {
    const t = BF.rand.tick;
    for (const e of todo) if (!e.done && C.cur && C.cur.key === e.g && t >= e.at) { e.done = true; W.setBlock(e.x, e.y, e.z, e.id); }
    return prev.apply(this, arguments);
  };
  let placed = null;
  return s => {
    const at = BF.rand.tick + 5;
    if (s === 3) {
      const homes = BF.bees.loadedHomes().slice().sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y), used = new Set();
      for (const h of homes) {
        const g = C.ofCell(h.x, h.z);
        if (used.has(g)) continue;
        if (!used.size) todo.push({ g, at, x: h.x, y: h.y, z: h.z, id: BF.B.air || 0 });
        else {
          let y = h.y + 1;
          while (y < h.y + 5 && W.getBlock(h.x, y, h.z) !== 0) y++;
          if (y >= h.y + 5) continue;
          const e = { g, at: at + used.size, x: h.x, y, z: h.z, id: BF.B.beehive };
          todo.push(e); if (!placed) placed = e;
        }
        used.add(g);
        if (used.size >= 3) break;
      }
      if (used.size < 3) throw new Error('--bees: loaded homes in only ' + used.size + ' groups');
    }
    if (s === 6 && placed) todo.push({ g: placed.g, at, x: placed.x, y: placed.y, z: placed.z, id: BF.B.air || 0 });
  };
}

// ---------------------------------------------------------------- the parent
async function main() {
  const n = +arg('workers', 2), seed = +arg('seed', 3), extra = +arg('extra', 3), seconds = +arg('seconds', 30);
  const leaveAt = +arg('leave', 0), dropAt = +arg('drop', 0);
  const partial = process.argv.includes('--partial'), bees = process.argv.includes('--bees'), save = arg('load', null), restored = process.argv.includes('--restored');
  const order = arg('order', 'tick'), pull = order === 'cluster' && process.argv.includes('--pull') && arg('shuffle') == null;
  const profile = arg('profile', 'converted'), plan = process.argv.includes('--plan'), fixed = !plan && !pull && arg('shuffle') == null;
  const shuffle = plan || pull ? 0 : +arg('shuffle', 1);
  const { load } = require('../tools/headless.js');
  const shared = load().BF.cworkers.makeShared(n);
  const spawn = data => {
    const w = new Worker(__filename, { workerData: Object.assign({ seed, extra, order, shuffle, fixed, profile, pull, partial, bees, save, restored }, data) });
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
  console.log(`booted the reference and ${n} cluster workers in ${((Date.now() - t0) / 1000).toFixed(1)} s (seed ${seed}, extra ${extra}, ${order} order${partial ? ', partial copies' : ''}${pull ? ', groups pulled' : shuffle ? (fixed ? ', fixed owners ' : ', shuffle ') + shuffle : ''}, profile ${profile})`);
  let fails = 0, errs = 0;
  const all = [ref, ...ws];
  for (let s = 1; s <= seconds; s++) {
    const out = await Promise.all(all.map(x => x.ask({ do: 'interval', s, leave: s === leaveAt, drop: s === dropAt ? Math.max(0, extra - 3) : null })));
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
    if (!(leaveAt > 0 && s >= leaveAt)) {   // the bees that are out: every worker's (full copies), or all of them put together (partial copies), as the reference's (back to one: every worker has them all)
      const lists = partial ? [Object.assign({}, ...out.slice(1).map(o => o.beesOut))] : out.slice(1).map(o => o.beesOut);
      if (partial) { const seen = new Set(); for (let w = 1; w < out.length; w++) for (const k in out[w].beesOut) { if (seen.has(k)) diffs.push({ w: w - 1, parts: ['bees out (two workers have cluster ' + k + "'s)"], objs: [] }); seen.add(k); } }
      lists.forEach((l, i) => {
        const ks = [...new Set([...Object.keys(r.beesOut), ...Object.keys(l)])].filter(k => r.beesOut[k] !== l[k]);
        if (ks.length) diffs.push({ w: partial ? 0 : i, parts: ['bees out (clusters ' + ks.slice(0, 4).join(', ') + ')'], objs: [] });
      });
    }
    if (s === 1 || s % 10 === 0 || diffs.length) console.log(`second ${s}: tick ${r.tick}, ${r.mobs} mobs, ${r.groups} groups; ${out[1].text}; owners ${out[1].owners.map(x => x.join('>')).join(' ')}`);
    if (diffs.length) {
      fails++;
      for (const d of diffs) {
        console.log(`  worker ${d.w} differs in ${d.parts.join(', ')}: ${d.objs.length} objects (${d.objs.slice(0, 6).join(', ')}${d.objs.length > 6 ? ', ...' : ''})`);
        const keys = d.objs.slice(0, 3), ps = d.parts.filter(p => p !== 'mobs' && p !== 'villages').slice(0, 2);
        const q = { do: 'text', keys, parts: ps };   // (partial copies: every worker gathers, so every worker is asked)
        const [a, ...bs] = await Promise.all([ref.ask(q), ...(partial ? ws : [ws[d.w]]).map(x => x.ask(q))]);
        const b = partial ? bs[d.w] : bs[0];
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
