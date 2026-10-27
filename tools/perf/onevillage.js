// One village on several cores (spec r15-65): measurements that decide whether one village's simulation can be split over cores.
//   collide  every request of every tick grouped by target: how often two requests (from two requesters) aim at the same block, mob,
//            chest or drop in the same tick, and how many of those were refused (the only case where apply order changes the outcome).
//   access   on sampled ticks, every mob's and village record's own fields are traced: which fields a thinking mob reads or writes on
//            another mob or on a village record, and what the village systems after the mob loop read and write. This is the state a
//            core that thinks some of a village's mobs would need from the cores that own the rest.
//   changes  on sampled ticks, what each mob's thinking changed on itself (js/rworkers.js diff): numbers changed in place, flags, and
//            objects or lists made anew; the data another core would need after every tick.
//   split    whole tick against the mob loop (the part cores could share), each mob's think time, the best split of those over n cores,
//            and what a shared-memory mirror of the mobs' numeric fields costs to write and read back every tick (real mobs).
//   barrier  (no world) two or four worker_threads meeting at an Atomics barrier: the cost of one meeting, twice a tick.
//   shuffle  each region's mobs think in a seeded random order every tick (not id order): the world hash must match the run in id order
//            if a mob's thinking reads only start-of-tick state of the others (spec r15-33).
// Usage: node tools/perf/onevillage.js --mode collide|access|changes|split|barrier|shuffle [--seed 3] [--seconds 1200] [--warm 30] [--every 20] [--extra n] [--out f.json]
// Measurement only: nothing here changes what the game does (access mode's tracing is checked against an untraced run's hash).
const fs = require('fs');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if (!m) throw new Error('unknown argument ' + argv[i]);
    a[m[1]] = argv[++i];
  }
  return a;
}

function boot(seed, extra, warm) {
  const { load } = require('../headless.js');
  const { BF } = load();
  const h = BF.boot.headless({ seed, settings: { at: 'village', extra: extra > 0 ? extra : undefined } });
  if (warm > 0) h.tick(Math.round(warm / BF.warp.TICK));
  return { BF, h };
}
const villagers = BF => BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed).length;

// ---------------------------------------------------------------- collide
function collide({ seed, seconds, warm, extra }) {
  const { BF, h } = boot(seed, extra, warm);
  const R = BF.req, ticks = Math.round(seconds / BF.warp.TICK);
  let cur = [];
  const prevTap = R.tap;
  R.tap = req => { cur.push(req); if (prevTap) prevTap(req); };
  const out = { requests: 0, byKind: {}, refused: {}, ticksWithRequests: 0, ticksWith2: 0, sameTarget: { groups: 0, requests: 0, byKind: {}, sameRequester: 0, refused: 0, refusedWhy: {}, examples: [] }, maxPerTick: 0 };
  const key = req => {
    const t = req.target;
    if (t == null) return null;
    if (typeof t === 'object') return t.x != null ? Math.floor(t.x) + ',' + Math.floor(t.y) + ',' + Math.floor(t.z) : (BF.ids.idOf(t) || JSON.stringify(t));
    return String(t).replace(/^[a-z]+:/, '');
  };
  const close = tick => {
    // (a request sent during apply or deliver, a chain effect, applies next tick: it waits for that tick's group)
    const L = cur.filter(r => r.result !== undefined); cur = cur.filter(r => r.result === undefined);
    if (!L.length) return;
    out.requests += L.length; out.ticksWithRequests++;
    if (L.length > 1) out.ticksWith2++;
    if (L.length > out.maxPerTick) out.maxPerTick = L.length;
    const g = new Map();
    for (const r of L) {
      out.byKind[r.kind] = (out.byKind[r.kind] || 0) + 1;
      if (r.result && !r.result.ok) { const w = r.kind + ':' + (r.result.why || '?'); out.refused[w] = (out.refused[w] || 0) + 1; }
      const k = key(r);
      if (k == null) continue;
      let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(r);
    }
    for (const [k, a] of g) {
      if (a.length < 2) continue;
      const from = new Set(a.map(r => r.from));
      if (from.size < 2) { out.sameTarget.sameRequester++; continue; }   // one mob's own two requests: never a race between cores
      const S = out.sameTarget;
      S.groups++; S.requests += a.length;
      const kinds = [...new Set(a.map(r => r.kind))].sort().join('+');
      S.byKind[kinds] = (S.byKind[kinds] || 0) + 1;
      const ref = a.filter(r => r.result && !r.result.ok);
      if (ref.length) { S.refused++; for (const r of ref) { const w = r.kind + ':' + (r.result.why || '?'); S.refusedWhy[w] = (S.refusedWhy[w] || 0) + 1; } }
      if (S.examples.length < 12) S.examples.push({ tick, target: k, reqs: a.map(r => ({ kind: r.kind, from: r.from, ok: r.result ? r.result.ok : null, why: r.result && r.result.why })) });
    }
  };
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) { h.tick(1); close(BF.rand.tick); }
  R.tap = prevTap;
  out.seed = seed; out.extra = extra; out.seconds = seconds; out.ticks = ticks; out.villagers = villagers(BF); out.mobs = BF.mobs.list.length;
  out.real = +((performance.now() - t0) / 1000).toFixed(1);
  out.perVillagerSecond = +(out.requests / Math.max(1, out.villagers) / seconds).toFixed(4);
  out.hash = h.stateHash().hash;
  return out;
}

// ---------------------------------------------------------------- access
// Each own data field of each traced object becomes an accessor for one tick, then goes back to a plain field (same value).
function access({ seed, seconds, warm, extra, every }) {
  const { BF, h } = boot(seed, extra, warm);
  const ticks = Math.round(seconds / BF.warp.TICK);
  const C = { mob: { r: {}, w: {} }, rec: { r: {}, w: {} }, recOther: { r: {}, w: {} }, sysMob: { r: {}, w: {} }, sysRec: { r: {}, w: {} }, applyMob: { r: {}, w: {} } };
  const tally = { sampled: 0, thinks: 0, crossR: 0, crossW: 0, thinkersReading: 0, thinkersWriting: 0, readFar: 0, distR: [] };
  const bump = (o, f) => { o[f] = (o[f] || 0) + 1; };
  const recOf = new Map();   // village record -> key
  const hazards = {}, wrote = new Map();
  let touchedR = null, touchedW = null;
  let busy = false;   // (note's own reads of traced fields aren't counted)
  const note = (owner, isMob, field, w) => {
    if (busy) return;
    busy = true;
    try { note1(owner, isMob, field, w); } finally { busy = false; }
  };
  const note1 = (owner, isMob, field, w) => {
    const R = BF.req, th = BF.rand.thinker;
    // read-after-write hazards: a thinker reads a field another mob already changed while thinking this tick (that mob thought first),
    // so the value read depends on the order mobs think in
    if (th && th === owner && w) { let f = wrote.get(owner); if (!f) wrote.set(owner, (f = new Set())); f.add(field); }
    else if (th && th !== owner && !w && wrote.has(owner) && wrote.get(owner).has(field)) {
      const key = (owner.type || 'record') + '.' + field;
      const e = hazards[key] || (hazards[key] = { n: 0, by: {}, at: {} });
      e.n++; bump(e.by, th.type);
      const st = new Error().stack.split('\n').slice(4, 9).map(l => l.trim().replace(/^at /, '').replace(/\(?\/home\/[^ ]*\/js\//, '').replace(/\)$/, '')).filter(l => !l.includes('onevillage')).slice(0, 3).join(' < ');
      if (Object.keys(e.at).length < 4 || e.at[st]) bump(e.at, st);
    }
    if (th) {
      if (th === owner) return;
      if (isMob) {
        bump(w ? C.mob.w : C.mob.r, field);
        if (w) { tally.crossW++; touchedW.add(owner); } else { tally.crossR++; touchedR.add(owner); }
        if (!w && th.position && owner.position && field !== 'position') {
          const dx = th.position.x - owner.position.x, dz = th.position.z - owner.position.z;
          if (dx * dx + dz * dz > 32 * 32) tally.readFar++;
        }
      } else {
        const mine = th.villageId === recOf.get(owner) || th.penVillageId === recOf.get(owner);
        const o = mine ? C.rec : C.recOther;
        bump(w ? o.w : o.r, field);
      }
    } else if (R.phase === 'apply' || R.phase === 'deliver') { if (isMob) bump(w ? C.applyMob.w : C.applyMob.r, field); }
    else bump(isMob ? (w ? C.sysMob.w : C.sysMob.r) : (w ? C.sysRec.w : C.sysRec.r), field);
  };
  const wrap = (o, isMob, owner, prefix, depth, undo) => {
    for (const k of Object.keys(o)) {
      const d = Object.getOwnPropertyDescriptor(o, k);
      if (!d || !d.configurable || !('value' in d)) continue;
      if (isMob && (k === 'prev' || k === 'mesh' || k === 'parts' || k === 'def')) continue;   // drawing state and the type's shared definition
      let v = d.value;
      const f = prefix + k;
      if (depth === 0 && v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || k === 'position' || k === 'vel') && k !== 'prev')
        wrap(v, isMob, owner, k + '.', 1, undo);
      Object.defineProperty(o, k, { configurable: true, enumerable: d.enumerable,
        get() { note(owner, isMob, f, false); return v; },
        set(x) { note(owner, isMob, f, true); v = x; } });
      undo.push(() => Object.defineProperty(o, k, { value: v, writable: d.writable, enumerable: d.enumerable, configurable: true }));
    }
  };
  // the mob loop: who thinks, and what each touched
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    if (i % every) { h.tick(1); continue; }
    tally.sampled++;
    recOf.clear();
    for (const [k, rec] of BF.mobs.villages) recOf.set(rec, k);
    wrote.clear();
    const undo = [];
    for (const m of BF.mobs.list) wrap(m, true, m, '', 0, undo);
    for (const rec of BF.mobs.villages.values()) wrap(rec, false, rec, '', 1, undo);
    // per thinker sets: wrap updateMob through the thinker changes (BF.rand.thinker is set around each update)
    const R = BF.rand;
    const desc = Object.getOwnPropertyDescriptor(R, 'thinker');
    let thv = R.thinker;
    Object.defineProperty(R, 'thinker', { configurable: true, enumerable: true, get() { return thv; }, set(x) {
      if (thv && touchedR) { tally.thinks++; if (touchedR.size) tally.thinkersReading++; if (touchedW.size) tally.thinkersWriting++; tally.distR.push(touchedR.size); }
      thv = x; touchedR = new Set(); touchedW = new Set(); } });
    try { h.tick(1); }
    finally {
      Object.defineProperty(R, 'thinker', desc || { value: thv, writable: true, enumerable: true, configurable: true });
      R.thinker = thv;
      for (let j = undo.length - 1; j >= 0; j--) undo[j]();
    }
  }
  const top = (o, n = 40) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
  const per = n => +(n / Math.max(1, tally.sampled)).toFixed(2);
  const sumObj = o => Object.values(o).reduce((s, x) => s + x, 0);
  const d = tally.distR.sort((a, b) => a - b), q = p => d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : 0;
  return {
    seed, extra, seconds, ticks, every, sampled: tally.sampled, villagers: villagers(BF), mobs: BF.mobs.list.length, real: +((performance.now() - t0) / 1000).toFixed(1),
    perTick: {
      thinks: per(tally.thinks), thinkersReadingOthers: per(tally.thinkersReading), thinkersWritingOthers: per(tally.thinkersWriting),
      crossMobReads: per(tally.crossR), crossMobWrites: per(tally.crossW), crossMobReadsFarther32: per(tally.readFar),
      ownVillageRecordReads: per(sumObj(C.rec.r)), ownVillageRecordWrites: per(sumObj(C.rec.w)),
      otherVillageRecordReads: per(sumObj(C.recOther.r)), otherVillageRecordWrites: per(sumObj(C.recOther.w)),
      systemsMobReads: per(sumObj(C.sysMob.r)), systemsMobWrites: per(sumObj(C.sysMob.w)), systemsRecordReads: per(sumObj(C.sysRec.r)), systemsRecordWrites: per(sumObj(C.sysRec.w)),
      applyMobReads: per(sumObj(C.applyMob.r)), applyMobWrites: per(sumObj(C.applyMob.w)),
    },
    hazards,
    othersReadPerThink: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: d.length ? d[d.length - 1] : 0 },
    fields: {
      mobReads: top(C.mob.r), mobWrites: top(C.mob.w), recordReads: top(C.rec.r), recordWrites: top(C.rec.w),
      otherRecordReads: top(C.recOther.r, 15), otherRecordWrites: top(C.recOther.w, 15),
      systemsMobReads: top(C.sysMob.r, 25), systemsMobWrites: top(C.sysMob.w, 25), systemsRecordWrites: top(C.sysRec.w, 25), applyMobWrites: top(C.applyMob.w, 25),
    },
    hash: h.stateHash().hash,
  };
}

// ---------------------------------------------------------------- changes
// What one mob's thinking changes on itself, as js/rworkers.js diffs it (the data another core would need after each tick): leaf ops
// by kind on sampled ticks. num: a number changed in place; flag: a boolean, string or null; struct: an object or list made or rebuilt.
function changes({ seed, seconds, warm, extra, every }) {
  const { BF, h } = boot(seed, extra, warm);
  const W = BF.rworkers, ticks = Math.round(seconds / BF.warp.TICK);
  const T = { sampled: 0, thinks: 0, changed: 0, ops: { num: 0, flag: 0, struct: 0 }, onlyNum: 0, bytes: 0, fields: {}, thinkMs: 0, snapMs: 0 };
  const walk = (ops, path) => {
    const out = { num: 0, flag: 0, struct: 0 };
    for (const op of ops) {
      const [k, t, v] = op, p = path ? path + '.' + (typeof k === 'number' ? '#' : k) : String(k);
      if (t === 1 || t === 4 || t === 3) { const sub = walk(t === 3 ? op[3] || [] : v || [], p); out.num += sub.num; out.flag += sub.flag; out.struct += sub.struct + (t === 4 ? 1 : 0); continue; }
      const kind = t === 0 && typeof v === 'number' ? 'num' : t === 0 && (v === null || typeof v !== 'object' || v.u || v.n) ? 'flag' : 'struct';
      out[kind]++;
      T.fields[p] = (T.fields[p] || 0) + 1;
    }
    return out;
  };
  const R = BF.rand;
  let thv = null, sh = null, t0 = 0;
  for (let i = 0; i < ticks; i++) {
    if (i % every) { h.tick(1); continue; }
    T.sampled++;
    const desc = Object.getOwnPropertyDescriptor(R, 'thinker');
    // refsOn: the codec's entity sets (rworkers diff writes entity references as ids)
    W.refsOn();
    Object.defineProperty(R, 'thinker', { configurable: true, enumerable: true, get() { return thv; }, set(x) {
      const t = performance.now();
      if (thv && sh) {
        T.thinkMs += t - t0;
        const ops = W.diff(thv, sh);
        T.thinks++;
        if (ops) {
          T.changed++;
          const o = walk(ops, '');
          T.ops.num += o.num; T.ops.flag += o.flag; T.ops.struct += o.struct;
          if (!o.flag && !o.struct) T.onlyNum++;
          T.bytes += JSON.stringify(ops).length;
        }
      }
      thv = x; sh = x ? W.snap(x) : null;
      t0 = performance.now(); T.snapMs += t0 - t;
    } });
    try { h.tick(1); }
    finally { Object.defineProperty(R, 'thinker', desc || { value: thv, writable: true, enumerable: true, configurable: true }); R.thinker = thv; }
  }
  const per = n => +(n / Math.max(1, T.sampled)).toFixed(2);
  return { seed, extra, seconds, every, sampled: T.sampled, villagers: villagers(BF),
    perTick: { thinks: per(T.thinks), changed: per(T.changed), onlyNumbers: per(T.onlyNum), numOps: per(T.ops.num), flagOps: per(T.ops.flag), structOps: per(T.ops.struct), jsonBytes: per(T.bytes), thinkMs: +(T.thinkMs / T.sampled).toFixed(3), snapDiffMs: +(T.snapMs / T.sampled).toFixed(3) },
    fields: Object.fromEntries(Object.entries(T.fields).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, v]) => [k, per(v)])) };
}

// ---------------------------------------------------------------- split
// The numeric fields a mob's thinking changes (changes mode, seed 9: these cover ~99% of numeric ops), as paths
const MIRROR = ['age', 'hurtT', 'invuln', 'knockT', 'yaw', 'idleT', 'rng', 'fallStart', 'buyFromAt', 'holdT', 'mateT', 'position.x', 'position.y', 'position.z',
  'vel.x', 'vel.y', 'vel.z', 'ai.swingT', 'ai.t', 'ai.lookT', 'ai.wanderAt', 'ai.zScanT', 'ai.stuckT', 'ai.losT', 'ai.golemFoeT', 'ai.gScanT', 'ai.vScanT',
  'ai.hScanT', 'ai.tx', 'ai.tz', 'ai.blockedT', 'ai.ri', 'ai.held.gap', 'ai.held.t', 'store.checkT', 'fshop.checkT', 'eggc.checkT', 'job.t', 'farm.t',
  'bkr.walkT', 'seek.cd', 'seek.t', 'mc.cd', 'farm.thinkT', 'cshop.walkT', 'flt.walkT', 'tsm.walkT', 'fo.plantCd', 'fo.cutCd', 'fo.gatherCd', 'fo.t',
  'flt.checkT', 'cshop.checkT', 'pkp.cd', 'pkp.t', 'farm.breakT'].map(p => p.split('.'));
function split({ seed, seconds, warm, extra, every }) {
  const { BF, h } = boot(seed, extra, warm);
  const ticks = Math.round(seconds / BF.warp.TICK), R = BF.rand;
  let thv = null, t0 = 0, lo = 0, hi = 0;
  const cost = new Map();   // mob -> ms thinking this tick
  Object.defineProperty(R, 'thinker', { configurable: true, enumerable: true, get() { return thv; }, set(x) {
    const t = performance.now();
    if (thv) cost.set(thv, (cost.get(thv) || 0) + t - t0);
    if (x) { if (!lo) lo = t; t0 = t; } else if (thv) hi = t;
    thv = x;
  } });
  const ns = [2, 3, 4, 8];
  const T = { tick: 0, loop: 0, byId: {}, lpt: {}, mirrorW: 0, mirrorR: 0, fastW: 0, fastR: 0, mirrorN: 0, mirrored: 0, fields: 0 };
  for (const n of ns) { T.byId[n] = 0; T.lpt[n] = 0; }
  let buf = new Float64Array(1);
  // the same mirror as straight-line code (one function for all the fields, direct property reads): the fastest a copy into the
  // existing mob objects can be
  const objs = [...new Set(MIRROR.filter(p => p.length > 1).map(p => p.slice(0, -1).join('.')))];
  const ref = p => p.length > 1 ? 'o_' + p.slice(0, -1).join('_') + '.' + p[p.length - 1] : 'm.' + p[0];
  const head = objs.map(o => 'const o_' + o.replace(/\./g, '_') + ' = ' + (o.includes('.') ? '(m.' + o.split('.')[0] + ' && m.' + o + ')' : 'm.' + o) + ' || Z;').join(' ');
  const wr = new Function('m', 'b', 'k', 'Z', head + MIRROR.map((p, j) => 'b[k + ' + j + '] = +' + ref(p) + ';').join(' '));
  const rd = new Function('m', 'b', 'k', 'Z', head + MIRROR.map((p, j) => '{ const v = b[k + ' + j + ']; if (v === v && ' + ref(p) + ' !== v) ' + ref(p) + ' = v; }').join(' '));
  const Z = {};   // (a missing object: its reads come out NaN, its writes go nowhere)
  for (let i = 0; i < ticks; i++) {
    cost.clear(); lo = hi = 0;
    const a = performance.now();
    h.tick(1);
    T.tick += performance.now() - a; T.loop += hi > lo ? hi - lo : 0;
    // the best a split of this tick's thinking over n cores could do: mob id mod n (any fixed split), and longest-first onto the least loaded
    const L = [...cost];
    for (const n of ns) {
      const w = new Array(n).fill(0);
      for (const [m, ms] of L) w[(+String(m.id).slice(1) | 0) % n] += ms;
      T.byId[n] += Math.max(...w);
      const v = new Array(n).fill(0);
      for (const [, ms] of L.sort((x, y) => y[1] - x[1])) { let b = 0; for (let j = 1; j < n; j++) if (v[j] < v[b]) b = j; v[b] += ms; }
      T.lpt[n] += Math.max(...v);
    }
    if (i % every) continue;
    // the mirror: every mob's numeric fields written to one shared array (the owner's side) and read back into the objects (a reader's side)
    const mobs = BF.mobs.list, need = mobs.length * MIRROR.length;
    if (buf.length < need) buf = new Float64Array(new SharedArrayBuffer(need * 8));
    let w0 = performance.now(), k = 0, f = 0;
    for (const m of mobs) for (const p of MIRROR) {
      let o = m;
      for (let j = 0; j < p.length - 1 && o; j++) o = o[p[j]];
      const v = o ? o[p[p.length - 1]] : undefined;
      buf[k++] = typeof v === 'number' ? v : NaN;
    }
    const w1 = performance.now();
    k = 0;
    for (const m of mobs) for (const p of MIRROR) {
      let o = m;
      for (let j = 0; j < p.length - 1 && o; j++) o = o[p[j]];
      const v = buf[k++];
      if (o && v === v && o[p[p.length - 1]] !== v) o[p[p.length - 1]] = v;   // (the same values: nothing changes, but every field is visited)
      if (v === v) f++;
    }
    const w2 = performance.now();
    T.mirrorW += w1 - w0; T.mirrorR += w2 - w1; T.mirrorN++; T.mirrored += mobs.length; T.fields += f;
    const g0 = performance.now();
    k = 0; for (const m of mobs) { wr(m, buf, k, Z); k += MIRROR.length; }
    const g1 = performance.now();
    k = 0; for (const m of mobs) { rd(m, buf, k, Z); k += MIRROR.length; }
    for (const key of Object.keys(Z)) delete Z[key];
    T.fastW += g1 - g0; T.fastR += performance.now() - g1;
  }
  const r3 = x => +x.toFixed(3);
  const out = { seed, extra, seconds, ticks, villagers: villagers(BF), mobs: BF.mobs.list.length,
    msPerTick: { tick: r3(T.tick / ticks), loop: r3(T.loop / ticks), rest: r3((T.tick - T.loop) / ticks) },
    loopShare: r3(T.loop / T.tick),
    loopOnNCores: { byId: {}, best: {} },
    mirror: { mobs: Math.round(T.mirrored / T.mirrorN), fields: Math.round(T.fields / T.mirrorN), writeMs: r3(T.mirrorW / T.mirrorN), readMs: r3(T.mirrorR / T.mirrorN), fastWriteMs: r3(T.fastW / T.mirrorN), fastReadMs: r3(T.fastR / T.mirrorN) },
    hash: h.stateHash().hash };
  for (const n of ns) { out.loopOnNCores.byId[n] = r3(T.byId[n] / ticks); out.loopOnNCores.best[n] = r3(T.lpt[n] / ticks); }
  return out;
}

// ---------------------------------------------------------------- barrier
// n threads meet `rounds` times at an Atomics barrier (a generation counter); µs per meeting, as the leader sees it.
async function barrier({ n = 2, rounds = 20000 }) {
  const { Worker } = require('worker_threads');
  const sab = new SharedArrayBuffer(16), I = new Int32Array(sab);
  const code = `const { workerData: { sab, n, rounds } } = require('worker_threads'); const I = new Int32Array(sab);
    for (let r = 0; r < rounds; r++) { const g = Atomics.load(I, 1); if (Atomics.add(I, 0, 1) === n - 1) { Atomics.store(I, 0, 0); Atomics.add(I, 1, 1); Atomics.notify(I, 1); }
      else { let s = 0; while (Atomics.load(I, 1) === g) { if (++s > 2000) Atomics.wait(I, 1, g, 1); } } }`;
  const ws = [];
  for (let i = 1; i < n; i++) ws.push(new Worker(code, { eval: true, workerData: { sab, n, rounds } }));
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) {
    const g = Atomics.load(I, 1);
    if (Atomics.add(I, 0, 1) === n - 1) { Atomics.store(I, 0, 0); Atomics.add(I, 1, 1); Atomics.notify(I, 1); }
    else { let s = 0; while (Atomics.load(I, 1) === g) { if (++s > 2000) Atomics.wait(I, 1, g, 1); } }
  }
  const us = (performance.now() - t0) * 1000 / rounds;
  await Promise.all(ws.map(w => w.terminate()));
  return { n, rounds, usPerMeeting: +us.toFixed(2) };
}

// ---------------------------------------------------------------- shuffle
function shuffle({ seed, seconds, warm, extra, k, every, dump }) {
  const { BF, h } = boot(seed, extra, warm);
  const ticks = Math.round(seconds / BF.warp.TICK);
  let s = (k * 2654435761) >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const plan = BF.rtick.plan;
  if (k) BF.rtick.plan = list => {
    const out = plan(list);
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out;
  };
  const hashes = [];
  for (let i = 1; i <= ticks; i++) { h.tick(1); if (i % every === 0) hashes.push(h.stateHash().hash); }
  const H = h.stateHash();
  if (dump) fs.writeFileSync(dump, BF.stateHash.text('mobs'));
  return { seed, extra, seconds, k, villagers: villagers(BF), hashes, hash: H.hash, parts: H.parts };
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  const o = { seed: +(a.seed || 3), seconds: +(a.seconds || 1200), warm: +(a.warm || 30), extra: +(a.extra || 0), every: +(a.every || 20), k: +(a.k || 0), dump: a.dump };
  if (a.mode === 'barrier') { barrier({ n: +(a.n || 2), rounds: +(a.rounds || 20000) }).then(r => { console.log(JSON.stringify(r)); process.exit(0); }); return; }
  const r = a.mode === 'access' ? access(o) : a.mode === 'shuffle' ? shuffle(o) : a.mode === 'changes' ? changes(o) : a.mode === 'split' ? split(o) : collide(o);
  const s = JSON.stringify(r, null, 1);
  if (a.out) fs.writeFileSync(a.out, s);
  console.log(s);
  process.exit(0);
}
module.exports = { collide, access, shuffle, changes, split, barrier };
