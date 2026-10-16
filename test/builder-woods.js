// Builders build each structure from one wood species, any species.
// Usage: NODE_PATH=$(npm root -g) node test/builder-woods.js [seed=1337]
// 1. Blueprints: every type x style x wood holds no wood but the chosen one (oak doors aside), and its requirement names only that wood.
// 2. A builder that holds only spruce builds a spruce structure, nothing else.
// 3. A builder with no wood but emeralds, in a village whose forester stocks birch, buys wood and builds only in the wood it bought.
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

  // ---- 1. blueprints
  const bp = await pg.evaluate(() => {
    window.__halt = true;
    const P = BF.blueprints, bad = [];
    let n = 0;
    for (const t of P.TYPES) for (let st = 0; st < 5; st++) for (const sp of P.woodsAvailable()) for (const h of [0.1, 0.9]) {
      const bp = P.get(t, 1, st, h, { lantern: 1, hay: 1 }, sp);
      n++;
      for (const c of bp.cells) { const w = P.woodOf(c.id); if (w && w[0] !== sp) bad.push(t + "/" + st + "/" + sp + ": " + BF.blocks[c.id].name); }
      for (const k in bp.req) { const w = P.woodOf(+k); if (w && w[0] !== sp) bad.push(t + "/" + st + "/" + sp + " req " + BF.itemName(+k)); }
    }
    const plainsOak = P.get("small_house", 0, 0, 0.5).wood, taiga = P.get("small_house", 0, 4, 0.5).wood;
    return { n, bad: bad.slice(0, 10), nbad: bad.length, woods: P.woodsAvailable(), plainsOak, taiga };
  });
  check(bp.nbad === 0, `${bp.n} blueprints, one wood each (${bp.woods.join(' ')}) ${bp.bad.join('; ')}`);
  check(bp.plainsOak === 'oak' && bp.taiga === 'spruce', `default wood: plains ${bp.plainsOak}, taiga ${bp.taiga}`);

  // ---- find a village with a builder and a forester, load it
  const v = await pg.evaluate(() => {
    BF.player.setGameMode && BF.player.setGameMode('creative');
    const vs = BF.worldgen.villagesNear(0, 0, 3000).filter(v => v && v.pop && (v.buildings || []).length >= 6).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    return vs.slice(0, 8).map(v => ({ x: v.x, z: v.z, y: v.y }));
  });
  let vk = null;
  for (const c of v) {
    const r = await pg.evaluate(v => {
      const key = Math.round(v.x) + "," + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      const step = h => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) step(0.05); }
      BF.sky.setTime(0.02);
      for (let i = 0; i < 200; i++) { BF.world.update(v.x, v.z, 30); step(0.05); }
      const mem = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === key && !m.dead);
      return { key, builder: mem.some(m => m.profession === "builder"), forester: mem.some(m => m.profession === "forester") };
    }, c);
    if (r.builder && r.forester) { vk = { ...c, key: r.key }; break; }
  }
  check(!!vk, 'village with a builder and a forester ' + (vk ? vk.key : '-'));
  if (!vk) { await b.close(); process.exit(1); }

  // Runs one scenario: set up the builder (and forester), step up to `days` days, report the woods placed in the structures it planned.
  const run = (setup, days) => pg.evaluate(([v, setup, days]) => {
    const key = v.key, T = BF.trades.inv, P = BF.blueprints;
    const mem = BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === key && !m.dead);
    const bl = mem.find(m => m.profession === "builder"), fo = mem.find(m => m.profession === "forester"), R = bl.village;
    for (const o of mem) if (o.profession === "builder" && o !== bl) o.bs = { mode: "idle", t: 1e9, cool: 1e9, fail: {}, avoid: {} };   // only one builder works
    const built = BF.builder.builtOf(R);
    for (const e of built) if (e.state === "building") e.state = "abandoned";
    const before = built.length;
    // wood out of every inventory but the forester's; the builder gets the scenario's stock
    const isWood = id => !!P.woodOf(id);
    for (const o of mem) if (o !== fo) for (let i = 0; i < o.inv.length; i++) if (o.inv[i] && isWood(o.inv[i].id)) o.inv[i] = null;
    for (let i = 0; i < bl.inv.length; i++) bl.inv[i] = null;
    for (const [n, c] of setup.builder) T.add(bl.inv, BF.I[n], c);
    if (setup.forester) { for (let i = 0; i < fo.inv.length; i++) if (fo.inv[i] && isWood(fo.inv[i].id)) fo.inv[i] = null; for (const [n, c] of setup.forester) T.add(fo.inv, BF.I[n], c); fo.level = Math.max(fo.level || 1, 2); if (BF.trades.refresh) BF.trades.refresh(fo); }
    bl.bs = null;
    BF.sky.setTime(0.03);
    const buys = [];
    const onLog = () => { for (const e of BF.builder.log.splice(0)) if (e.kind === "buy" || e.kind === "plan" || e.kind === "short") buys.push(e.kind + " " + JSON.stringify(e)); };
    BF.builder.log.length = 0;
    const h = 0.05;
    for (let i = 0; i < days * 1200 / h; i++) {
      BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim();
      if (i % 50 === 0) { BF.world.update(v.x, v.z, 4); onLog(); }
      if (built.length > before && built[before].state === "done") break;
    }
    onLog();
    const e = built[before];
    if (!e) return { planned: false, buys, status: BF.builder.statusText(bl), inv: bl.inv.filter(Boolean).map(s => BF.itemName(s.id) + "x" + s.count).join(" ") };
    const woods = {};
    for (let i = 0; i < e.prog; i++) { const c = BF.builder.cellOf(e, i), id = BF.world.getBlock(c.x, c.y, c.z), w = P.woodOf(id); if (w) woods[w[0]] = (woods[w[0]] || 0) + 1; }
    const woodNames = ["planks", "log"].map(k => P.woodItem(e.wood, k)).filter(id => id != null).map(id => BF.itemName(id));   // the item names of the wood it built from
    return { planned: true, type: e.type, wood: e.wood, state: e.state, prog: e.prog, n: e.n, woods, woodNames, buys: buys.slice(0, 12) };
  }, [vk, setup, days]);

  // ---- 2. spruce only
  const r2 = await run({ builder: [['spruce_planks', 128], ['spruce_log', 40], ['cobblestone', 64], ['glass_pane', 16], ['glass', 16], ['torch', 8], ['red_bed', 2], ['emerald', 40]] }, 2);
  console.log('   ', JSON.stringify(r2));
  check(r2.planned && r2.wood === 'spruce', `builder holding spruce plans a ${r2.type} in ${r2.wood}`);
  check(r2.planned && Object.keys(r2.woods).every(w => w === 'spruce') && (r2.woods.spruce || 0) > 0, `placed wood: ${JSON.stringify(r2.woods)} (${r2.state} ${r2.prog}/${r2.n})`);

  // ---- 3. no wood, forester stocks birch. A builder builds with whatever wood it legitimately acquires (Gordon, 2026-10-07): while it shops
  // the forester may fell and saw other trees, so the check is that it bought the wood it builds with, not that the wood is birch.
  const r3 = await run({ builder: [['cobblestone', 64], ['glass_pane', 16], ['glass', 16], ['torch', 8], ['red_bed', 2], ['emerald', 80]], forester: [['birch_planks', 128], ['birch_log', 30]] }, 3);
  console.log('   ', JSON.stringify(r3));
  const boughtNames = (r3.buys || []).filter(s => /^buy /.test(s)).map(s => { try { return JSON.parse(s.slice(4)).got || ''; } catch (e) { return ''; } });
  check(r3.planned && boughtNames.some(g => (r3.woodNames || []).includes(g.replace(/^\d+ /, ''))), `builder with no wood bought the wood it builds with: ${r3.wood} (${boughtNames.join(', ')})`);
  check(r3.planned && Object.keys(r3.woods).every(w => w === r3.wood) && (r3.woods[r3.wood] || 0) > 0, `placed only that wood: ${JSON.stringify(r3.woods)} (${r3.state} ${r3.prog}/${r3.n})`);

  console.log(fails ? `FAILED ${fails}` : 'ALL OK');
  await b.close();
  process.exit(fails ? 1 : 0);
})();
