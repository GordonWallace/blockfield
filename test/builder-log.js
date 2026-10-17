// Builders write what they build to the village log: "Name (Builder) started building a spruce small house at x, y, z",
// "... took over building the ...", "... built a ... at x, y, z (n blocks)", kind "build", with the structure's corner as location.
// Usage: NODE_PATH=$(npm root -g) node test/builder-log.js [seed=1337]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 1337);
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto('file://' + path.join(root, 'index.html') + '#seed' + seed);
  await pg.waitForTimeout(3000);

  const vs = await pg.evaluate(() => {
    window.__halt = true;
    BF.player.setGameMode && BF.player.setGameMode('creative');
    const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop && (v.buildings || []).length >= 6).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    return vs.slice(0, 8).map(v => ({ x: v.x, z: v.z, y: v.y }));
  });
  let vk = null;
  for (const c of vs) {
    const ok = await pg.evaluate(v => {
      const key = Math.round(v.x) + "," + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      return BF.mobs.list.some(m => m.type === "villager" && m.village && m.village.key === key && !m.dead && m.profession === "builder");
    }, c);
    if (ok) { vk = { ...c, key: Math.round(c.x) + "," + Math.round(c.z) }; break; }
  }
  check(!!vk, 'village with a builder ' + (vk ? vk.key : '-'));
  if (!vk) { await b.close(); process.exit(1); }

  const r = await pg.evaluate(v => {
    const T = BF.trades.inv, L = BF.vlog;
    const bl = BF.mobs.list.find(m => m.type === "villager" && m.village && m.village.key === v.key && !m.dead && m.profession === "builder");
    const R = bl.village, built = BF.builder.builtOf(R);
    for (const e of built) if (e.state === "building") e.state = "abandoned";
    for (let i = 0; i < bl.inv.length; i++) bl.inv[i] = null;
    for (const [n, c] of [['spruce_planks', 128], ['spruce_log', 40], ['cobblestone', 128], ['glass_pane', 16], ['glass', 16], ['torch', 8], ['red_bed', 2], ['lantern', 4]]) if (BF.I[n] != null) T.add(bl.inv, BF.I[n], c);
    const n0 = L.entries(R.key).length;
    const bs = bl.bs || (bl.bs = { mode: "idle", t: 0, cool: 0, fail: {}, avoid: {}, placeT: 0.6 });
    let e = null;
    for (const t of ["small_house", "medium_house", "cottage", "workshop", "well", "market_stall"]) if ((e = BF.builder.beginPlan(bl, bs, t, "spruce"))) break;
    if (!e) return { planned: false };
    // its owner gone, the builder takes the half-built structure over
    e.owner = 99999; bs.mode = "idle"; bs.entry = null;
    BF.builder.think(bl, bs);
    // finish it: everything placed, one AI step
    e.prog = e.n; BF.builder.startBuild(bl, bs, e);
    BF.sky.setTime(0.2);
    for (let i = 0; i < 5 && e.state !== "done"; i++) BF.builder.ai(bl, 0.05, { x: 0, z: 0 });
    const lines = L.entries(R.key).slice(n0).filter(x => x[1] === "build");
    return { planned: true, label: e.label, at: [e.ox, e.oy, e.oz], n: e.n, state: e.state, name: L.nameOf(bl), lines };
  }, vk);
  console.log('   ', JSON.stringify(r));
  check(r.planned, 'builder planned a structure');
  if (r.planned) {
    const at = r.at.join(', '), who = r.name + ' (Builder)';
    const L = r.lines.map(x => x[2]);
    check(L.some(s => s === `${who} started building a spruce ${r.label} at ${at}`), 'start line: ' + L[0]);
    check(L.some(s => s === `${who} took over building the spruce ${r.label} at ${at}`), 'takeover line');
    check(r.state === 'done' && L.some(s => s === `${who} built a spruce ${r.label} at ${at} (${r.n} blocks)`), 'built line: ' + L[L.length - 1]);
    check(r.lines.every(x => x[1] === 'build'), 'kind is build');
  }
  console.log(fails ? `FAILED ${fails}` : 'ALL OK');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
