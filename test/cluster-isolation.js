// @ci integration suite=world timeout=1200
// Cluster isolation (spec r15-39b, item C1: js/ctick.js). Clusters must not affect each other between meetings: then running an
// interval tick by tick (every cluster each tick, the "tick" order) and cluster by cluster (each cluster's whole interval in turn, the
// clock rewound for each, the "cluster" order) gives the same world. A difference is a read across clusters or a shared counter, and
// on several workers (item C7) it would be a mismatch.
// Two child processes boot the same world headless (tools/headless.js: seed 3 at the village nearest the spawn, the 3 nearest other
// villages simulated too, js/active.js fixed set) with the cluster tick on, one in each order, and run in lockstep, interval by
// interval (a meeting every 20 ticks), loading chunks between intervals. After each interval the state hash's parts (js/statehash.js)
// and every mob's and village record's canonical text are compared; the first objects that differ are printed with where their text
// first differs, so the field names the system.
// Profiles (BF.ctick.only):
//   converted  the systems js/ctick.js SYSTEMS marks converted (the rest don't run, in either order): must match. The default, and CI.
//   full       every system, converted or not: shows what is left to convert (exit 0 whatever differs, unless --strict).
//   a list     "mobloop,builder,...": just those.
// Each cluster's own tick must be the meeting's at every meeting (one clock: no cluster runs behind yet).
// The cluster-order child also traces the reads of another cluster's mobs that were hidden (BF.ctick.trace), by system and line.
// Usage: node test/cluster-isolation.js [--seed 3] [--extra 3] [--seconds 60] [--profile converted|full|a,b,c] [--strict] [--control]
//   --control: a third child in the tick order too; a part that differs between the two tick-order children isn't deterministic to
//   begin with, and isn't counted against the cluster order.
const path = require('path'), crypto = require('crypto'), { fork } = require('child_process');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes('--' + k);

if (process.argv[2] === '--child') child();
else parent();

// ---------------------------------------------------------------- a child: one world, one order
function child() {
  const order = process.argv[3], seed = +arg('seed', 3), extra = +arg('extra', 3), profile = arg('profile', 'converted');
  for (const k of ['log', 'info', 'debug']) console[k] = () => {};   // (the villagers' own console chatter)
  Error.stackTraceLimit = 30;   // (the trace's calling line)
  const { load } = require('../tools/headless.js');
  const { BF } = load();
  const errors = [];
  BF.glog.setSink(e => { if (e.l === 'ERROR' && errors.length < 50) errors.push(e.k + ': ' + e.x); });
  BF.boot.headless({ seed, settings: { at: 'village', extra } });
  const C = BF.ctick;
  const names = Object.keys(C.SYSTEMS);
  C.only = profile === 'full' ? null : profile === 'converted' ? C.converted() : profile.split(',');
  C.order = order;
  C.on = true;
  if (order === 'cluster') C.trace = true;
  const md5 = t => crypto.createHash('md5').update(t).digest('hex').slice(0, 16);
  const objs = () => {
    const o = {};
    for (const m of BF.mobs.list) if (!m.removed) o['mob ' + m.id] = md5(BF.stateHash.canon(m));
    for (const [k, v] of BF.mobs.villages) o['village ' + k] = md5(BF.stateHash.canon(v));
    return o;
  };
  const textOf = k => {
    const [kind, id] = [k.slice(0, k.indexOf(' ')), k.slice(k.indexOf(' ') + 1)];
    const o = kind === 'mob' ? BF.ids.live(id) || BF.mobs.list.find(m => m.id === id) : BF.mobs.villages.get(id);
    return o ? BF.stateHash.canon(o) : null;
  };
  process.on('message', msg => {
    if (msg.do === 'interval') {
      BF.boot.stream();
      C.interval(BF.warp.TICK);
      const s = C.stats();
      process.send({ parts: BF.stateHash.parts(), objs: objs(), tick: BF.rand.tick, mobs: BF.mobs.list.length,
        groups: s.groups.map(g => g.key + (g.player ? '*' : '') + ' ' + g.mobs), waited: s.lastDeferred, errors: errors.splice(0),
        skew: [...C.clocks().values()].filter(t => t !== BF.rand.tick).length });
    } else if (msg.do === 'text') process.send({ texts: msg.keys.map(textOf) });
    else if (msg.do === 'probe') {
      // a request from the first cluster's pass to a mob of the last cluster: it must wait for the next meeting
      const out = { sentAt: null, appliedAt: null, appliedIn: undefined, delivered: null };
      const gs = C.groups(), target = BF.mobs.list.find(m => !m.removed && m.cl !== undefined && BF.clusters.groupOf(m.cl) === gs[gs.length - 1].key);
      BF.req.on('probe', () => { out.appliedAt = BF.rand.tick; out.appliedIn = C.cur ? C.cur.key : null; return { ok: true }; });
      let sent = false;
      BF.world.onThink(() => {
        if (sent || !target || !C.cur || C.cur !== C.groups()[0]) return;
        sent = true; out.sentAt = BF.rand.tick;
        const q = BF.req.send('probe', target.id, {}, null).then(r => { out.delivered = BF.rand.tick; });
        out.stamp = [q._at, q._due];
      }, 'probe');
      if (C.only) C.only = [...C.only, 'probe'];
      C.SYSTEMS.probe = false;
      for (let i = 0; i < 2; i++) { BF.boot.stream(); C.interval(BF.warp.TICK); }
      out.groups = gs.length; out.target = target ? target.id : null;
      process.send(out);
    }
    else if (msg.do === 'end') process.send({ traced: C.traced().slice(0, 40), only: C.only ? [...C.only] : names }, () => process.exit(0));
  });
  process.send({ ready: true, mobs: BF.mobs.list.length });
}

// The field path at character i of a canonical text (js/statehash.js canon: {key=value;...}, [a,b], M{...}): "farm.stats.total"
function pathAt(t, i) {
  const stack = [];
  let key = '', tok = '';
  for (let j = 0; j < i; j++) {
    const c = t[j];
    if (c === '"') { j++; while (j < i && t[j] !== '"') { if (t[j] === '\\') j++; j++; } tok = ''; continue; }
    if (c === '{' || c === '[') { stack.push(c === '[' ? key + '[]' : key); key = ''; tok = ''; }
    else if (c === '}' || c === ']') { stack.pop(); key = ''; tok = ''; }
    else if (c === '=') { key = tok; tok = ''; }
    else if (c === ';' || c === ',') tok = '';
    else tok += c;
  }
  return stack.filter(Boolean).concat(key ? [key] : []).join('.') || '?';
}

// ---------------------------------------------------------------- the parent: lockstep and compare
async function parent() {
  const seconds = +arg('seconds', 60), profile = arg('profile', 'converted'), strict = flag('strict') || profile !== 'full';
  const pass = ['--seed', arg('seed', 3), '--extra', arg('extra', 3), '--profile', profile];
  const ORDERS = flag('control') ? ['tick', 'cluster', 'tick'] : ['tick', 'cluster'];
  const NAMES = flag('control') ? ['tick', 'cluster', 'control'] : ['tick', 'cluster'];
  let fails = 0;
  const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
  const t0 = Date.now();
  const kids = ORDERS.map(o => fork(__filename, ['--child', o, ...pass], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  const waits = kids.map(k => { const q = []; let res = null; k.on('message', m => { if (res) { const r = res; res = null; r(m); } else q.push(m); }); return () => q.length ? Promise.resolve(q.shift()) : new Promise(r => { res = r; }); });
  const ask = (i, msg) => { kids[i].send(msg); return waits[i](); };
  const ready = await Promise.all(kids.map((k, i) => waits[i]()));
  console.log(`booted ${NAMES.length} worlds (seed ${arg('seed', 3)}, ${arg('extra', 3)} extra villages, profile ${profile}) in ${((Date.now() - t0) / 1000).toFixed(0)} s; mobs ${ready.map(r => r.mobs).join(' / ')}`);

  const noise = new Set(), firstDiff = {};
  let skewed = 0, shown = 0, intervals = Math.round(seconds), lastGroups = '';
  for (let n = 1; n <= intervals; n++) {
    const r = await Promise.all(kids.map((k, i) => ask(i, { do: 'interval' })));
    for (const x of r) for (const e of x.errors) console.log(`  game log ERROR: ${e}`);
    for (const x of r) if (x.skew) skewed++;
    const g = r[0].groups.join(', '), gk = r[0].groups.map(x => x.split(' ')[0]).join();
    if (gk !== lastGroups) { console.log(`  second ${n}: ${r[0].groups.length} clusters (mobs): ${g}`); lastGroups = gk; }
    if (r[2]) for (const k of Object.keys(r[0].parts)) if (r[0].parts[k] !== r[2].parts[k]) noise.add(k);
    const parts = Object.keys(r[0].parts).filter(k => r[0].parts[k] !== r[1].parts[k] && !noise.has(k));
    for (const k of parts) if (!firstDiff[k]) firstDiff[k] = n;
    if (!parts.length) { if (n % 10 === 0) console.log(`second ${n}: same (${r[0].mobs} mobs, ${r[0].waited} requests waited for the meeting)`); continue; }
    console.log(`second ${n}: the cluster order differs in ${parts.join(', ')}`);
    if (shown >= 3) continue;
    // the objects that differ, and where
    const a = r[0].objs, b = r[1].objs;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort().slice(0, 6);
    if (!keys.length) continue;
    shown++;
    const [ta, tb] = await Promise.all([0, 1].map(i => ask(i, { do: 'text', keys })));
    keys.forEach((k, j) => {
      const x = ta.texts[j], y = tb.texts[j];
      if (x == null || y == null) { console.log(`  ${k}: only in the ${x == null ? 'cluster' : 'tick'} order`); return; }
      let i = 0; while (i < x.length && x[i] === y[i]) i++;
      const field = pathAt(x, i);
      const cut = t => JSON.stringify(t.slice(Math.max(0, i - 120), i + 80));
      console.log(`  ${k} first differs at ${field} (character ${i}):\n    tick    ${cut(x)}\n    cluster ${cut(y)}`);
    });
  }
  // a request across clusters (sent in the first cluster's pass, to a mob of the last one)
  const pr = await Promise.all(kids.map((k, i) => ask(i, { do: 'probe' })));
  for (let i = 0; i < 2; i++) {
    const p = pr[i];
    check(p.groups > 1 && p.target != null && p.sentAt != null, `${NAMES[i]} order: a request sent from one cluster to a mob of another (${p.target}, tick ${p.sentAt})`);
    check(p.appliedAt != null && p.appliedAt % 20 === 0 && p.appliedAt > p.sentAt && p.appliedIn === null, `${NAMES[i]} order: it applied at the next meeting (tick ${p.appliedAt}, ${p.appliedIn === null ? 'between ticks' : 'in ' + p.appliedIn})`);
    check(p.delivered === p.appliedAt, `${NAMES[i]} order: its result was delivered at the meeting`);
    check(p.stamp && p.stamp[0] === p.sentAt && p.stamp[1] === p.appliedAt, `${NAMES[i]} order: it carried its sender's tick and its due tick (${p.stamp})`);
  }
  check(JSON.stringify(pr[0]) === JSON.stringify(pr[1]), 'the request went the same way in both orders');
  const end = await Promise.all(kids.map((k, i) => ask(i, { do: 'end' })));
  if (end[1].traced.length) {
    console.log(`reads of another cluster's mobs that were hidden (cluster order), by system and line:`);
    for (const [k, c] of end[1].traced) console.log(`  ${String(c).padStart(7)}  ${k}`);
  } else console.log('no reads of another cluster\'s mobs were hidden');
  console.log(`systems run: ${end[0].only.join(', ')}`);
  if (noise.size) console.log(`not deterministic to begin with (tick order twice): ${[...noise].join(', ')}`);
  const diffs = Object.keys(firstDiff);
  check(!skewed, 'every cluster kept one clock: its own tick was the meeting\'s at every meeting' + (skewed ? ` (${skewed} times not)` : ''));
  if (strict) check(!diffs.length, `the tick and cluster orders give the same world for ${intervals} s` + (diffs.length ? ` (differ: ${diffs.map(k => k + ' from second ' + firstDiff[k]).join(', ')})` : ''));
  else console.log(diffs.length ? `differs (profile ${profile}): ${diffs.map(k => k + ' from second ' + firstDiff[k]).join(', ')}` : `the same (profile ${profile})`);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(fails ? `FAIL cluster-isolation (${fails})` : 'PASS cluster-isolation');
  process.exit(fails ? 1 : 0);
}
