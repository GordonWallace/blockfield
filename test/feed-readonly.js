// @ci integration suite=world timeout=1500
// The debug screen only reads (2026-10-30): every read the debug screen and F3 make of the simulation must leave the world exactly as it
// was. test/feed-pure.js compares two whole worlds, which only catches a read whose write later changes an outcome; this test catches the
// write itself: at each check it hashes the world (js/statehash.js, every part, the random streams' counters included), makes every read
// the debug screen makes, and hashes again, with no tick in between. Reads made at each check:
//   the page's whole snapshot (js/debugfeed.js snapshot: F3's debugInfo/debugText and the simulation's part, the Mobs map included)
//   the simulation's part as the world server or Web Worker makes it, with a villager picked (its day timeline), a village on show and
//   screens open (the other villages' light details too)
//   the protocol's f3 query (the simulation's F3 figures) and every loaded village's panel (js/villagelog.js panelData, F3's panel)
// A second, stricter look walks every loaded mob and village record, own keys and hidden ones (non-enumerable, "_" caches the hash
// skips), and lists any key a read added or changed: those are caches, which are allowed, but are printed so the audit can check each.
// Usage: NODE_PATH=$(npm root -g) node test/feed-readonly.js [seeds=3,7,11] [days=1] [checks a day=24]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seeds = (process.argv[2] || '3,7,11').split(',').map(Number), days = +(process.argv[3] || 1), perDay = +(process.argv[4] || 24);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

async function boot(b, seed) {
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  // a feed address nothing listens on: the feed module loads and its sends fail quietly
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=http://127.0.0.1:9#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);
  await pg.evaluate(() => {
    window.__step = () => BF.simStep(BF.warp.TICK);
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
  });
  let last = -1;
  for (let i = 0; i < 240; i++) {
    const c = await pg.evaluate(() => { window.__load(20); return { n: BF.world.chunks.size, q: BF.world.queueLength }; });
    if (c.n === last && c.q === 0 && i > 5) break;
    last = c.n; await pg.waitForTimeout(250);
  }
  return pg;
}

// k ticks, then one check: the hash, every read, the hash again (and the hidden-key walk around the reads)
const step = (pg, k, pick) => pg.evaluate(([k, pick]) => {
  for (let i = 0; i < k; i++) { window.__step(); if (i % 50 === 0) window.__load(4); }
  // every own key of every loaded mob and village record, hidden ones too, one level down (a key's value as short canonical text)
  const C = v => { try { return BF.stateHash.canon(v); } catch (e) { return '?'; } };
  const walk = () => {
    const out = new Map(), seen = new Set();
    const put = (tag, o) => {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      for (const k of Object.getOwnPropertyNames(o)) {
        if (/^(mesh|meshes|model|root|def|prevPos|prevYaw|lerp|walkPhase|walkAmt|headYaw|headPitch|label|sprite|badgeMesh|wg)$/.test(k)) continue;
        const v = o[k];
        out.set(tag + '.' + k, typeof v === 'function' ? 'fn' : C(v).slice(0, 400));
        if (v && typeof v === 'object' && !Array.isArray(v) && !v.isVector3 && !v.isObject3D && !v.members && !(v.def && v.ai)) put(tag + '.' + k, v);
      }
    };
    for (const m of BF.mobs.list) if (!m.dead && !m.removed) put((m.type === 'villager' ? m.profession : m.type) + '(' + (m.name || m.id) + ')', m);
    for (const [key, rec] of BF.mobs.villages || new Map()) put('village ' + key, rec);
    return out;
  };
  const vs = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed && m.position);
  const profs = [...new Set(vs.map(m => m.profession))].sort();
  // the state hash is one of the screen's reads too (every 10 s): hashed twice in a row it must give the same
  const hz = BF.stateHash.full(), hw = BF.stateHash.full(), hashParts = Object.keys(hz.parts).filter(p => hz.parts[p] !== hw.parts[p]);
  const w0 = walk(), h0 = BF.stateHash.full();
  const walkParts = Object.keys(hw.parts).filter(p => hw.parts[p] !== h0.parts[p]);   // (the walk's own reads, getters: told apart from the screen's)
  const texts = {};
  for (const p of h0 && Object.keys(h0.parts)) texts[p] = BF.stateHash.text(p);
  // a screen showing one village: the others get light details between their full ones (js/debugfeed.js lite)
  const vk = [...(BF.mobs.villages || new Map()).keys()][0];
  if (vk) BF.debugFeed.simPart({ view: [vk], vv: 'v' + vk }, true);
  // the reads: Date.now moved on so the once-a-second Mobs map and the once-a-minute state hash are made at every check
  const now0 = Date.now; let skew = 0; Date.now = () => now0() + (skew += 20000);
  try {
    const F = BF.debugFeed;
    F.snapshot();   // the page's snapshot: F3 (debugInfo, debugText) and the simulation's part
    const v = pick ? vs[Math.floor((window.__picks = (window.__picks || 0) + 1) * 7919) % Math.max(1, vs.length)] : null;
    const key = v && BF.dayTimeline ? BF.dayTimeline.keyOf(v) : null;
    F.simPart({ screens: 1, pick: key, pv: window.__picks || 0 });   // as the worker / world server answer the feed query, a villager picked
    F.simPart(null, true);   // a copy's read (what region workers used to replay)
    if (BF.proto && BF.proto.queries && BF.proto.queries.f3) { const p = BF.player.position; BF.proto.queries.f3({ x: p.x, y: p.y, z: p.z, shown: true }); }
    for (const rec of (BF.mobs.villages || new Map()).values()) BF.vlog.panelData(rec);
    if (BF.vlog.villageAt) { const p = BF.player.position; const r = BF.vlog.villageAt(p.x, p.z); if (r) BF.vlog.panelData(r); }
  } finally { Date.now = now0; }
  const h1 = BF.stateHash.full(), w1 = walk();
  const parts = Object.keys(h0.parts).filter(p => h0.parts[p] !== h1.parts[p]);
  const diffs = parts.map(p => {
    const x = texts[p], y = BF.stateHash.text(p);
    let i = 0; while (i < x.length && x[i] === y[i]) i++;
    return p + ' @' + i + ':\n      before ' + JSON.stringify(x.slice(Math.max(0, i - 200), i + 100)) + '\n      after  ' + JSON.stringify(y.slice(Math.max(0, i - 200), i + 100));
  });
  const hidden = [];
  for (const [k, v] of w1) { const was = w0.get(k); if (was === undefined) hidden.push('+ ' + k); else if (was !== v) hidden.push('~ ' + k); }
  for (const k of w0.keys()) if (!w1.has(k)) hidden.push('- ' + k);
  return { day: +(BF.sky.day + BF.sky.time).toFixed(3), parts, diffs, hidden, villagers: vs.length, profs, walkParts, hashParts };
}, [k, pick]);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const hiddenAll = new Map();
  for (const seed of seeds) {
    const t0 = Date.now(), pg = await boot(b, seed);
    const checks = Math.max(1, Math.round(days * perDay)), k = Math.round(1200 / 0.05 / perDay);
    const bad = [], profs = new Set();
    let villagers = 0;
    // the first checks come right after the boot, before most villagers have thought once (state made lazily is made then, and a read
    // that makes it is caught only in that window), then evenly spaced
    const ks = [0, 1, 3, 10, 30, ...new Array(checks).fill(k)];
    for (const kk of ks) {
      const r = await step(pg, kk, true);
      if (r.hashParts.length) { bad.push(r); console.log(`  day ${r.day}: hashing the world changed ${r.hashParts.join(', ')}`); }
      if (r.walkParts.length) console.log(`  day ${r.day}: (the test's own walk changed ${r.walkParts.join(', ')})`);
      villagers = Math.max(villagers, r.villagers); r.profs.forEach(p => profs.add(p));
      if (r.parts.length) { bad.push(r); console.log(`  day ${r.day}: reads changed ${r.parts.join(', ')}\n    ${r.diffs.join('\n    ')}`); }
      for (const h of r.hidden) { const g = h.replace(/\([^)]*\)/g, '()').replace(/village [-\d,]+/, 'village K'); hiddenAll.set(g, (hiddenAll.get(g) || 0) + 1); }
    }
    check(!bad.length, `seed ${seed}: ${ks.length} checks over ${days} game days, ${villagers} villagers (${[...profs].join(' ')}): the debug screen's reads changed nothing the world hashes` +
      (bad.length ? ` (changed at ${bad.length} checks: ${[...new Set(bad.flatMap(r => r.parts.concat(r.hashParts)))].join(', ')})` : '') + ` (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    await pg.context().close();
  }
  if (hiddenAll.size) {
    console.log('info: keys the reads added or changed that the hash leaves out (caches; times seen):');
    for (const [k, n] of [...hiddenAll].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x ${k}`);
  }
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('PASS feed-readonly');
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
