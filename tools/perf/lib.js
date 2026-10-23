// Shared harness for tools/perf/perfmobs.js and test/perf-soak.js: a headless game with its frame loop halted, the player hovering
// over the village nearest spawn, stepping the simulation itself (BF.simStep, 0.05 s steps as at 100x and 1000x) and reading the
// villager-seconds meter (js/perf.js, BF.perf) for V·s/s, ms per step and the split by subsystem.
// World variants (perfmobs.js) patch the sources only where the game has no switch: monsters stop with BF.mobs.spawning = false,
// but removing mobs, stopping wild animal rolls and skipping animation still patch js/mobs.js and js/wildlife.js as they're served.
const path = require('path'), fs = require('fs');
const { chromium } = require(process.env.PW || 'playwright');

const VARIANTS = ['all', 'nohostile', 'noanimals', 'nowild', 'noanim', 'nowild_noanim'];
const flagsOf = variant => ({
  __noHostile: /nohostile|nowild/.test(variant), __noAnimals: /noanimals|nowild/.test(variant), __noAnim: variant.split('_').includes('noanim'),
});

function patch(src, pairs, file) {
  for (const [a, b] of pairs) { if (!src.includes(a)) throw new Error(`patch miss in ${file}: ${a.slice(0, 60)}`); src = src.split(a).join(b); }
  return src;
}
const MOBS_PATCH = [
  ['  spawning: true,', '  spawning: true, __remove: m => removeMob(m),'],
  ['  if (!m.root.visible) return;   // the rest is how it looks', '  if (!m.root.visible || window.__noAnim) return;   // the rest is how it looks'],
];
const WILD_PATCH = [['      roll(k);\n', '      if (!window.__noAnimals) roll(k);\n'], ['try { wildBreeding(); }', 'try { if (!window.__noAnimals) wildBreeding(); }']];

// -> {b, pg}: Chromium with the game at file://<root>/index.html#seed<seed>, booted (rivers done), the frame loop halted
async function boot(root, { seed = 1, variant = 'all', size = [320, 200], log = console.log } = {}) {
  root = path.resolve(root);
  const opts = { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
  const b = await chromium.launch(opts).catch(() => chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium' }));
  const pg = await b.newPage({ viewport: { width: size[0], height: size[1] } });
  pg.on('pageerror', e => log('PAGEERROR', (e.stack || e.message).slice(0, 300)));
  await pg.addInitScript(f => {
    Object.assign(window, f);
    window.BF = window.BF || {}; window.BF.lodOff = true; window.BF_LOD_OFF = true;   // no distant rings: their workers would compete
    const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb));
  }, flagsOf(variant));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  if (variant !== 'all') {
    await pg.route('**/js/mobs.js', r => r.fulfill({ body: patch(fs.readFileSync(path.join(root, 'js/mobs.js'), 'utf8'), MOBS_PATCH, 'mobs.js'), contentType: 'text/javascript' }));
    await pg.route('**/js/wildlife.js', r => r.fulfill({ body: patch(fs.readFileSync(path.join(root, 'js/wildlife.js'), 'utf8'), WILD_PATCH, 'wildlife.js'), contentType: 'text/javascript' }));
  }
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed);
  await pg.waitForFunction(() => window.BF && BF.world && BF.mobs && BF.perf && !BF.preparing, null, { timeout: 300000, polling: 200 });
  await pg.waitForTimeout(3000);
  return { b, pg };
}

// Halts the frame loop, puts a creative player 40 blocks above the village nearest spawn, loads the area and runs 2,800 steps so the
// village is out. -> where {x, z}
async function toVillage(pg) {
  const where = await pg.evaluate(() => {
    window.__halt = true;
    if (BF.player.setGameMode) BF.player.setGameMode('creative');
    if (window.__noHostile) BF.mobs.spawning = false;
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    const y = (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3;
    BF.player.spawn(v.x + 0.5, y, v.z + 0.5);
    BF.player.position.y = y + 40;   // hover above so the player never lands inside terrain
    if (BF.player.setFlying) BF.player.setFlying(true);
    return { x: v.x, z: v.z };
  });
  await pg.evaluate(({ x, z }) => {
    const wild = m => BF.mobs.isWild(m) || (m.type === 'horse' && m.horse && !m.horse.owner && !m.horse.tamed);
    // the variants: remove what they leave out
    window.__cull = () => {
      if (!window.__noHostile && !window.__noAnimals) return;
      for (const m of BF.mobs.list.slice()) {
        if (m.dead || m.removed) continue;
        const h = m.hostile || (m.def && m.def.hostile);
        if ((window.__noHostile && h) || (window.__noAnimals && !h && m.type !== 'villager' && wild(m))) BF.mobs.__remove(m);
      }
    };
    // streaming as the frame loop does it, charged to the meter's streaming
    window.__stream = r => { BF.perf.mark(); BF.world.update(x, z, r); BF.perf.lap(BF.perf.C.stream); };
    for (let i = 0; i < 400; i++) { window.__stream(60); if (i % 4 === 0) BF.simStep(0.05); }
    for (let i = 0; i < 200; i++) { window.__stream(30); BF.simStep(0.05); }
    for (let i = 0; i < 2400; i++) { if (i % 10 === 0) window.__stream(30); BF.simStep(0.05); if (i % 20 === 0) window.__cull(); }
  }, where);
  return where;
}

// Runs n steps of 0.05 s with the meter on, streaming every 20 steps (3 chunks a call, as fast-forward does). -> one record:
// {steps, game, real, msPerStep, vss, mobss, split {category: ms per step}, counts, queue, chunks, day}
function run(pg, steps = 1000) {
  return pg.evaluate(n => {
    const P = BF.perf;
    P.ask(true); P.reset();
    for (let i = 0; i < n; i++) { if (i % 20 === 0) window.__stream(3); BF.simStep(0.05); if (i % 20 === 0) window.__cull(); }
    const t = P.totals();
    P.ask(false);
    const counts = { villager: 0, golem: 0, hostile: 0, wildAnimal: 0, villageAnimal: 0, total: 0 };
    const key = ['villager', 'hostile', 'wildAnimal', 'villageAnimal'];
    for (const m of BF.mobs.list) {
      if (m.dead || m.removed) continue;
      counts.total++;
      const c = P.mobCat(m);
      counts[m.def && m.def.golem ? 'golem' : key[[P.C.villagers, P.C.monsters, P.C.wild, P.C.vanimals].indexOf(c)]]++;
    }
    const split = {};
    for (const k in t.split) split[k] = t.split[k] / t.steps;
    return { steps: t.steps, game: t.game, real: t.real, msPerStep: Object.values(split).reduce((a, b) => a + b, 0), vss: t.vs / t.real, mobss: t.mobs / t.real,
      speed: t.game / t.real, split, counts, queue: BF.world.queueLength, chunks: BF.world.chunks.size, day: BF.sky.day + BF.sky.time };
  }, steps);
}

// averages of run() records (each weighted by its steps)
function average(hours) {
  const steps = hours.reduce((a, h) => a + h.steps, 0), real = hours.reduce((a, h) => a + h.real, 0);
  const split = {};
  for (const h of hours) for (const k in h.split) split[k] = (split[k] || 0) + h.split[k] * h.steps / steps;
  const counts = {};
  for (const h of hours) for (const k in h.counts) counts[k] = (counts[k] || 0) + h.counts[k] / hours.length;
  return { steps, real, game: hours.reduce((a, h) => a + h.game, 0), vss: hours.reduce((a, h) => a + h.vss * h.real, 0) / real,
    mobss: hours.reduce((a, h) => a + h.mobss * h.real, 0) / real, msPerStep: Object.values(split).reduce((a, b) => a + b, 0), split, counts };
}

const fmtSplit = s => Object.entries(s).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');

module.exports = { VARIANTS, boot, toVillage, run, average, fmtSplit };
