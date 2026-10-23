// @ci integration suite=world timeout=900
// Chunk block data in shared memory (spec r15-35): NODE_PATH=$(npm root -g) node test/shared-blocks.js [outPrefix]
// Served by debug/server.js (as ./run.sh does), the page is cross-origin isolated and every section array (blocks, block light, sky
// light) sits on a SharedArrayBuffer; served with --no-isolate, and opened as a file, they are ordinary ArrayBuffers and the game plays.
// In both: F3 and the game log say which, an edit survives a save and load, and (isolated) a 2,000-block walk and back leaves the
// loaded chunks' section memory near where it started (unloaded chunks release their buffers).
const path = require('path'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/shared-blocks';
const GAME = 8730, DBG = 8731;
const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!c) fails.push(n); };
const start = async (extra) => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-shared-alerts.json'), ...extra]);
  let gone = false; p.on('exit', () => { gone = true; }); p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  for (let i = 0; i < 100 && !gone; i++) { try { await fetch(`http://localhost:${DBG}/state`); await new Promise(r => setTimeout(r, 300)); if (!gone) return p; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('debug server did not start');
};
const stop = p => new Promise(r => { p.once('exit', r); p.kill(); });

// In the page: section array kinds, F3 and log lines, a save / load round trip, and (walk) the memory check.
async function inPage({ walk }) {
  const R = {}, wait = ms => new Promise(r => setTimeout(r, ms));
  const settle = async (x, z) => {
    BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
    for (let i = 0; i < 600 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await wait(10); }
    for (let i = 0; i < 600; i++) { BF.world.update(x, z, 8); await wait(10); if (BF.world.queueLength === 0) break; }
  };
  const kinds = () => {
    const k = { shared: 0, plain: 0 };
    for (const c of BF.world.chunks.values()) for (const list of [c.secs, c.light, c.sky]) if (list) for (const a of list) if (a && typeof a === 'object')
      k[a.buffer instanceof ArrayBuffer ? 'plain' : typeof SharedArrayBuffer === 'function' && a.buffer instanceof SharedArrayBuffer ? 'shared' : 'other']++;
    return k;
  };
  R.isolated = self.crossOriginIsolated === true;
  R.mode = { on: BF.shared.on, text: BF.shared.text };
  BF.state.paused = true;
  const meta = await BF.save.create({ name: 'shared-blocks', seed: 123, gameMode: 'creative', villages: 10, gen: 4 });
  BF.mobs.spawning = false;
  const px = Math.floor(BF.spawnPoint.x), pz = Math.floor(BF.spawnPoint.z);
  await settle(px, pz);
  R.kinds = kinds();
  R.f3 = BF.debugText(BF.debugInfo());
  // the mesher workers (r15-03) get copies of the (shared or plain) sections: what they built equals the page's own mesher
  R.mesh = (() => {
    const W = BF.world, st = W.meshStats ? W.meshStats() : null;
    if (!st) return { none: true };
    const keys = ['pos', 'uv', 'col', 'sky', 'bl', 'ind'];
    const same = (a, b) => { if (!a || !b) return a === b; for (const k of keys) { const x = a[k], y = b[k]; if (!x || !y) { if (x !== y) return false; continue; } if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; } return true; };
    const cs = [...W.chunks.values()].filter(c => c.mesh === true && c.meshBy === 'worker' && !W._dirty.has(c.key)).slice(0, 20);
    let bad = 0; for (const c of cs) { const a = W.shownArrays(c), b = W.meshArrays(c); if (!same(a.S, b.S) || !same(a.L, b.L)) bad++; }
    return { workers: st.workers, inline: !!st.inline, checked: cs.length, bad };
  })();
  R.logged = BF.glog.entries().some(e => e.k === 'game' && e.x.startsWith(BF.shared.text));
  // an edit (a block plus a torch for block light) through IndexedDB
  const gy = BF.worldgen.heightAt(px + 3, pz + 3) + 1;
  BF.world.setBlock(px + 3, gy, pz + 3, BF.B.gold_block || BF.B.stone);
  BF.world.setBlock(px + 4, gy, pz + 3, BF.B.torch);
  const want = [BF.world.getBlock(px + 3, gy, pz + 3), BF.world.getBlock(px + 4, gy, pz + 3)];
  R.lightAfterEdit = kinds();
  await BF.save.saveNow();
  await BF.save.load(meta.id);
  BF.state.paused = true; BF.mobs.spawning = false;
  await settle(px, pz);
  R.roundTrip = { want, got: [BF.world.getBlock(px + 3, gy, pz + 3), BF.world.getBlock(px + 4, gy, pz + 3)] };
  R.kindsAfterLoad = kinds();
  if (walk) {
    const gcNow = async () => { for (let i = 0; i < 3; i++) { if (typeof gc === 'function') gc(); await wait(100); } };
    const mem = () => ({ ...BF.shared.usage(), chunks: BF.world.chunks.size });
    R.before = mem();
    // weak references to every section array loaded at the start: once those chunks unload, their buffers must be collectable
    // (built in a plain function: an async function's suspended frame can keep its loop's last chunk alive, which would read as a leak)
    const refs = (() => { const r = []; for (const c of BF.world.chunks.values()) for (const list of [c.secs, c.light, c.sky]) if (list) for (const a of list) if (a && typeof a === 'object') r.push([c.key, new WeakRef(a)]); return r; })();
    for (let d = 100; d <= 2000; d += 100) await settle(px + d, pz);
    for (let i = 0; i < 100; i++) { BF.world.update(px + 2000, pz, 8); await wait(10); }
    R.far = mem();
    const gone = refs.filter(([k]) => !BF.world.chunks.has(k)), alive = () => gone.filter(([, w]) => w.deref() !== undefined);
    // a chunk can stay referenced for a moment after it unloads (a queued job finishing): give it a few seconds of play between collections
    for (let i = 0; i < 6; i++) { await gcNow(); if (!alive().length) break; for (let k = 0; k < 50; k++) { BF.world.update(px + 2000, pz, 8); await wait(20); } }
    R.refs = { tracked: refs.length, unloaded: gone.length, stillAlive: alive().length, aliveKeys: [...new Set(alive().map(([k]) => k))], gc: typeof gc === 'function' };
    for (let d = 1900; d >= 0; d -= 100) await settle(px + d, pz);
    for (let i = 0; i < 300; i++) { BF.world.update(px, pz, 8); await wait(10); }   // unload what's left of the walk
    R.after = mem();
  }
  await BF.save.remove(meta.id);
  return R;
}

async function check(b, label, url, { isolated, walk }) {
  const pg = await b.newPage({ viewport: { width: 1280, height: 760 } });
  const errs = [];
  pg.on('pageerror', e => { errs.push(e.message); console.log(label + ' PAGEERROR', e.message); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto(url);
  await pg.waitForFunction(() => window.BF && BF.state && BF.save && !BF.preparing, null, { timeout: 180000, polling: 200 });
  await pg.waitForTimeout(3000);
  const R = await pg.evaluate(inPage, { walk });
  const want = isolated ? 'shared' : 'plain';
  ok(`${label}: crossOriginIsolated is ${isolated}`, R.isolated === isolated, R.mode);
  ok(`${label}: BF.shared.on is ${isolated}`, R.mode.on === isolated);
  ok(`${label}: every section array is ${want}`, R.kinds[want] > 0 && Object.keys(R.kinds).every(k => k === want || !R.kinds[k]), R.kinds);
  ok(`${label}: block light arrays too, after a torch`, R.lightAfterEdit[want] > R.kinds[want] - 1 && Object.keys(R.lightAfterEdit).every(k => k === want || !R.lightAfterEdit[k]), R.lightAfterEdit);
  ok(`${label}: F3 says "${R.mode.text}"`, R.f3.includes(R.mode.text) && (isolated ? /Shared memory: on/ : /Shared memory: off: page not isolated/).test(R.f3));
  ok(`${label}: the game log says it`, R.logged);
  if (!R.mesh.none && label !== 'file') ok(`${label}: mesher workers build the same meshes as the page`, R.mesh.workers > 0 && !R.mesh.inline && R.mesh.checked >= 10 && R.mesh.bad === 0, R.mesh);
  ok(`${label}: save and load round-trip the edits`, R.roundTrip.want.every((id, i) => id && id === R.roundTrip.got[i]), R.roundTrip);
  ok(`${label}: section arrays after loading are ${want}`, R.kindsAfterLoad[want] > 0 && Object.keys(R.kindsAfterLoad).every(k => k === want || !R.kindsAfterLoad[k]), R.kindsAfterLoad);
  if (walk) {
    console.log(`${label}: memory before ${JSON.stringify(R.before)}, 2,000 blocks out ${JSON.stringify(R.far)}, back ${JSON.stringify(R.after)}`);
    ok(`${label}: the walk loaded new chunks`, R.far.arrays > 0 && R.before.arrays > 0);
    ok(`${label}: the start's chunks unloaded 2,000 blocks out`, R.refs.unloaded > 0.9 * R.refs.tracked, R.refs);
    ok(`${label}: their section buffers were released (garbage collected)`, R.refs.gc && R.refs.stillAlive === 0, R.refs);
    // back at the start the loaded set can differ a little (the walk came back from the other side): compare per loaded chunk
    const per = m => m.bytes / m.chunks;
    ok(`${label}: section memory back near its start (per loaded chunk, within 25%)`, Math.abs(per(R.after) - per(R.before)) <= 0.25 * per(R.before), { before: R.before, after: R.after });
  }
  ok(`${label}: no page errors`, errs.length === 0, errs);
  if (out) await pg.screenshot({ path: `${out}-${label}.png` });
  await pg.close();
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--expose-gc'] });
  try {
    let srv = await start([]);
    // the headers themselves: on the page and the scripts, not on the wiki
    const h = await fetch(`http://localhost:${GAME}/`), hj = await fetch(`http://localhost:${GAME}/js/world.js`), hw = await fetch(`http://localhost:${GAME}/wiki/`);
    ok('COOP / COEP on the page', h.headers.get('cross-origin-opener-policy') === 'same-origin' && h.headers.get('cross-origin-embedder-policy') === 'credentialless');
    ok('COOP / COEP on the scripts', hj.headers.get('cross-origin-embedder-policy') === 'credentialless');
    ok('not on the wiki', !hw.headers.get('cross-origin-embedder-policy'));
    await check(b, 'served', `http://localhost:${GAME}/?nolod#seed123gen4v10`, { isolated: true, walk: true });
    await stop(srv);
    srv = await start(['--no-isolate']);
    await check(b, 'no-headers', `http://localhost:${GAME}/?nolod#seed123gen4v10`, { isolated: false, walk: false });
    await stop(srv);
    await check(b, 'file', 'file://' + path.join(root, 'index.html') + '?nolod#seed123gen4v10', { isolated: false, walk: false });
  } finally { await b.close(); }
  console.log(fails.length ? `FAILED ${fails.length}: ${fails.join('; ')}` : 'all passed');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.log('FAILED', e.stack || e.message); process.exit(1); });
