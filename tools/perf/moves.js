// Move errors (r15-70): runs a seed headless (tools/headless.js) for N game days and counts the game log's `move` ERROR lines (stuck,
// fallen into a well) per 100 villager/golem game-days. Prints JSON: {seed, extra, days, mobDays, errors, per100, byType}; --out also
// writes every move line, each stuck one with a snapshot of the mob (snap). --progress 1: a line on stderr every 0.1 day.
// Usage: node tools/perf/moves.js [--seed 3] [--extra 8] [--days 2] [--warm 60] [--progress 1] [--out file.json]
const fs = require('fs');
const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const seed = +(a.seed || 3), extra = +(a.extra || 8), days = +(a.days || 2), warm = +(a.warm || 60);
const { load } = require('../headless.js');
const { BF } = load();
const lines = [];
const snapped = new WeakSet();
const bname = (x, y, z) => { const b = BF.blocks[BF.world.getBlock(x, y, z)]; return b ? b.name : '?'; };
// what the stuck mob was doing: its AI state, its route, the blocks round its feet and the mobs pressing on it
function snap(e) {
  let m = null;   // the one that just logged: logged, with the least time held (an ERROR that isn't a stuck one, the pit one: the mob nearest it)
  const at = !/stuck at/.test(e.x) && /at (-?\d+), (-?\d+), (-?\d+)/.exec(e.x);
  if (at) { let d = 4; for (const o of BF.mobs.list) { const q = o.position, k = Math.hypot(q.x - at[1], q.y - at[2], q.z - at[3]); if (!o.dead && k < d) { d = k; m = o; } } }
  else for (const o of BF.mobs.list) { const g = o.ai && o.ai.held; if (g && g.logged && (!m || g.t < m.ai.held.t)) m = o; }
  if (m) {
    const ai = m.ai;
    const p = m.position, fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z), ring = {};
    for (let dy = -1; dy <= 2; dy++) { const row = []; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) row.push(bname(fx + dx, fy + dy, fz + dz)); ring[dy] = row.join(' '); }
    const near = BF.mobs.list.filter(o => o !== m && !o.dead && Math.hypot(o.position.x - p.x, o.position.z - p.z) < 1.5 && Math.abs(o.position.y - p.y) < 2).map(o => o.type + (o.profession ? '/' + o.profession : ''));
    const st = {};
    for (const k of Object.keys(ai)) { const v = ai[k]; if (v == null || typeof v === 'function') continue; st[k] = typeof v === 'object' ? (Array.isArray(v) ? 'arr' + v.length : Object.keys(v).slice(0, 8).join(',')) : v; }
    const r = ai.route;
    return { type: m.type, prof: m.profession, pos: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], onGround: m.onGround, inWater: m.inWater, ladder: m.onLadder,
      route: r ? { kind: ai.routeKind, len: r.length, ri: ai.ri, next: r[ai.ri], last: r[r.length - 1] } : null, detour: ai.detour ? Object.keys(ai.detour).join(',') : null,
      tgt: ai.tx != null ? +Math.hypot(ai.tx - p.x, ai.tz - p.z).toFixed(1) : null, task: m.task || (m.job && m.job.state) || null, bsMode: m.bs ? m.bs.mode : undefined, bsEntry: m.bs && m.bs.entry ? { type: m.bs.entry.type, ox: m.bs.entry.ox, oy: m.bs.entry.oy, oz: m.bs.entry.oz } : undefined, fill: m.bs && m.bs.fill ? Object.keys(m.bs.fill).join(',') : undefined, ai: st, ring, near, bs: m.bs ? JSON.stringify(m.bs, (k, v) => (k === 'plan' || k === 'cells' || k === 'bp' || k === 'blocks') ? undefined : v).slice(0, 600) : undefined, hits: (hits.get(m.position) || []).map(e => Object.assign({}, e, { ago: TK - e.tick })) };
  }
  return null;
}
BF.glog.setSink(e => { if (e.k === 'move') lines.push({ t: BF.sky ? +(BF.sky.day + BF.sky.time).toFixed(4) : 0, l: e.l, x: e.x, v: e.v, snap: e.l === 'ERROR' ? snap(e) : undefined }); });
// the last hits of each mob (BF.world.moveBox wrapped): where, which way it pushed, and the blocks it pushed into
let TK = 0;
const hits = new WeakMap(), mb = BF.world.moveBox;
BF.world.moveBox = function (pos, vel, hw, h, dt, o) {
  const vx = vel.x, vz = vel.z, r = mb.apply(this, arguments);
  if (r && (r.hitX || r.hitZ) && Math.abs(vx) + Math.abs(vz) > 0.1) {
    const l = hits.get(pos) || []; if (l.length > 6) l.shift();
    const ax = r.hitX ? pos.x + Math.sign(vx) * (hw + 0.1) : pos.x, az = r.hitZ ? pos.z + Math.sign(vz) * (hw + 0.1) : pos.z, y = Math.floor(pos.y + 0.01);
    l.push({ tick: TK, x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2), v: [+vx.toFixed(2), +vz.toFixed(2)], hx: !!r.hitX, hz: !!r.hitZ, roof: !!r.roof, into: [bname(ax, y, az), bname(ax, y + 1, az), bname(ax, y + 2, az)] });
    hits.set(pos, l);
  }
  return r;
};
const h = BF.boot.headless({ seed, settings: { at: 'village', extra: extra > 0 ? extra : undefined } });
const TICK = BF.warp.TICK, DAY = BF.sky.dayLength;
h.tick(Math.round(warm / TICK));
lines.length = 0;
let mobSec = { villager: 0, iron_golem: 0 };
const ticks = Math.round(days * DAY / TICK), t0 = Date.now();
for (let i = 1; i <= ticks; i++) {
  h.tick(1); TK++;
  if (i % 20 === 0) for (const m of BF.mobs.list) if (!m.dead && !m.removed && (m.type === 'villager' || m.type === 'iron_golem')) mobSec[m.type] += 20 * TICK;
  if (a.progress && i % 2400 === 0) process.stderr.write(`${(i * TICK / DAY).toFixed(2)} days, ${lines.filter(l => l.l === 'ERROR').length} errors, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
}
const errs = lines.filter(l => l.l === 'ERROR');
const mobDays = (mobSec.villager + mobSec.iron_golem) / DAY;
const byType = { villager: errs.filter(e => !/^An iron golem/.test(e.x)).length, iron_golem: errs.filter(e => /^An iron golem/.test(e.x)).length };
const out = { seed, extra, days, real: (Date.now() - t0) / 1000, villagerDays: +(mobSec.villager / DAY).toFixed(1), golemDays: +(mobSec.iron_golem / DAY).toFixed(1),
  mobDays: +mobDays.toFixed(1), errors: errs.length, per100: +(errs.length / mobDays * 100).toFixed(2), byType, lines };
if (a.out) fs.writeFileSync(a.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify(Object.assign({}, out, { lines: undefined })));
process.exit(0);
