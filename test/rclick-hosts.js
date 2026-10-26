// @ci integration suite=items,ui timeout=900
// bug-086: right clicks whose answer the page used to read at once (act(...).ok / .r) do the same with the simulation off the page.
// Seed 3, survival, a stone floor with an oak fence, a beehive and a cake; holding cobblestone, once per host (default page,worker):
//   - the fence with no horse on the lead: the cobblestone is placed against it (no tie);
//   - the beehive: nothing placed, the action bar tells its bees and honey;
//   - the cake with full hunger: the cake stays, the action bar says "You aren't hungry".
// Usage: NODE_PATH=$(npm root -g) node test/rclick-hosts.js [modes=page,worker]
const path = require('path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require(root + '/test/lib');
const MODES = (process.argv[2] || 'page,worker').split(',');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); if (!ok) fails++; };
async function run(b, url, mode) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  await lib.install(pg);
  pg.on('pageerror', e => { console.log(mode, 'PAGEERROR', (e.stack || e.message).slice(0, 400)); fails++; });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto(url + '?sim=' + mode);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  console.log(mode, 'host:', await pg.evaluate(() => BF.simHost.mode));
  await pg.evaluate(async () => { BF.player.start(); await BF.save.create({ name: "rc", seed: "3", gameMode: "survival", villages: 10 }); });
  await pg.waitForTimeout(8000);
  await pg.evaluate(() => { BF.renderer.render = () => {}; });
  const g = await pg.evaluate(() => {
    const P = BF.player, p = P.position, W = BF.world;
    P.setFlying(false);
    const x = Math.floor(p.x), z = Math.floor(p.z), y = Math.max(W.heightAt(x, z), 1), cells = [];
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      for (let k = -1; k <= 0; k++) cells.push([x + dx, y + k, z + dz, BF.B.stone, W.getBlock(x + dx, y + k, z + dz)]);
      for (let k = 1; k <= 4; k++) { const b = W.getBlock(x + dx, y + k, z + dz); if (b) cells.push([x + dx, y + k, z + dz, 0, b]); }
    }
    cells.push([x, y + 1, z - 2, BF.B.oak_fence, 0]);         // a fence post 2 north
    cells.push([x + 3, y + 1, z - 2, BF.B.beehive, 0]);       // a beehive 2 north, 3 east
    cells.push([x - 3, y + 1, z - 2, BF.B.cake, 0]);          // a cake 2 north, 3 west
    BF.req.player("player.place", x + "," + y + "," + z, { cells, consume: 0 });
    P.teleport(x + 0.5, y + 1.01, z + 0.5); P.setLook(0, 0);
    return { x, y: y + 1, z };
  });
  await pg.waitForTimeout(2000);
  const blk = (x, y, z) => pg.evaluate(([x, y, z]) => { const id = BF.world.getBlock(x, y, z); return BF.blocks[id] ? BF.blocks[id].name : id; }, [x, y, z]);
  const simBlk = (x, y, z) => lib.sim(pg, ([x, y, z]) => { const id = BF.world.getBlock(x, y, z); return BF.blocks[id] ? BF.blocks[id].name : id; }, [x, y, z]);
  console.log(mode, 'setup', await blk(g.x, g.y, g.z - 2), await blk(g.x + 3, g.y, g.z - 2), await blk(g.x - 3, g.y, g.z - 2));
  await lib.give(pg, ['cobblestone'], 0);
  const rclick = async () => { await pg.evaluate(() => BF.player.setMouse(false, true)); await pg.waitForTimeout(120); await pg.evaluate(() => BF.player.setMouse(false, false)); await pg.waitForTimeout(1500); };
  const bar = () => pg.evaluate(() => { const e = [...document.querySelectorAll('#ui div')].find(d => /translateX\(-50%\)/.test(d.style.transform) && d.style.bottom.includes('150px')); return e ? { text: e.textContent, op: e.style.opacity } : null; });
  const aimAt = async (tx, ty, tz) => pg.evaluate(([tx, ty, tz]) => {   // look at the centre of the south face of cell (tx, ty, tz)
    const e = BF.player.eyePos(), dx = tx + 0.5 - e.x, dy = ty + 0.5 - e.y, dz = tz + 1 - e.z;
    BF.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, [tx, ty, tz]);
  const tgt = () => pg.evaluate(() => { const t = BF.player.target; return t ? { x: t.x, y: t.y, z: t.z, n: t.normal, id: BF.blocks[t.id].name } : null; });
  // 1. fence: cobblestone against its south face
  await aimAt(g.x, g.y, g.z - 2); await pg.waitForTimeout(300);
  console.log(mode, 'aim fence', JSON.stringify(await tgt()));
  await rclick();
  const fence = [await blk(g.x, g.y, g.z - 1), await simBlk(g.x, g.y, g.z - 1)];
  check(fence[0] === 'cobblestone' && fence[1] === 'cobblestone', mode + ': cobblestone placed against a fence with nothing to tie', fence);
  // 2. beehive with cobblestone held
  await pg.evaluate(p => BF.player.teleport(p.x + 3.5, p.y + 0.01, p.z + 0.5), g); await pg.waitForTimeout(500);
  await aimAt(g.x + 3, g.y, g.z - 2); await pg.waitForTimeout(300);
  console.log(mode, 'aim hive', JSON.stringify(await tgt()));
  await rclick();
  const hive = [await simBlk(g.x + 3, g.y, g.z - 1), await bar()];
  check(hive[0] === 'air' && hive[1] && /^Beehive: /.test(hive[1].text), mode + ': a beehive right click tells its honey and places nothing', hive);
  // 3. cake, not hungry
  await pg.evaluate(p => BF.player.teleport(p.x - 2.5, p.y + 0.01, p.z + 0.5), g); await pg.waitForTimeout(500);
  await lib.sim(pg, () => { BF.player.feed(); });
  await pg.evaluate(() => BF.player.feed());
  await aimAt(g.x - 3, g.y, g.z - 2); await pg.waitForTimeout(300);
  console.log(mode, 'aim cake', JSON.stringify(await tgt()));
  await rclick();
  const cake = [await simBlk(g.x - 3, g.y, g.z - 2), await bar()];
  check(cake[0] === 'cake' && cake[1] && cake[1].text === "You aren't hungry", mode + ': a cake with full hunger says so', cake);
  await ctx.close();
}
(async () => {
  const srv = await lib.serve({ world: true });
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const m of MODES) { try { await run(b, srv.url, m); } catch (e) { check(false, m + ': ran', e.message); } }
  await b.close(); await srv.stop();
  console.log(fails ? fails + ' FAILED' : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
