// @ci integration suite=world soak timeout=2400
// Region-scoped tick (spec r15-33): mobs think region by region and each region's requests apply together (js/regiontick.js), and the
// world comes out exactly as with the single-list tick of r15-17. Seed 3 (planet, village generator 10) boots in four fresh pages at the
// village nearest the spawn, and each runs one game day (24,000 steps of 0.05 s, BF.simStep) with a tick order:
//   list     the single-list tick (BF.rtick.order "list": mobs in list order, one sorted apply list);
//   list2    the same again, the control: a part that differs between list and list2 isn't deterministic to begin with (r15-24), so the
//            order comparisons can't see it;
//   region   regions in key order (the default);
//   reverse  regions visited and applied in reverse key order.
// The state hash (js/statehash.js, r15-24) and its parts are compared every eighth of a day. A part that differs between list and region
// or reverse, and not between list and list2, is a hidden order dependency: the test fails and prints where that part's text differs.
// Chunks round the village are loaded before the day starts and not during it, so that chunk streaming (time-budgeted) can't make the
// pages differ. Also checked: the region tick actually visited regions in region order, a blast is split into one request per region,
// and the region index's self-check finds nothing after the day.
// Usage: NODE_PATH=$(npm root -g) node test/region-tick.js [seed=3] [days=1]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 3), days = +(process.argv[3] || 1);
const CHECKS = Math.max(1, Math.round(8 * days));
const ORDERS = ['list', 'list', 'region', 'reverse'], NAMES = ['list', 'list2', 'region', 'reverse'];
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

async function boot(b, n) {
  const pg = await (await b.newContext({ viewport: { width: 320, height: 200 } })).newPage();
  pg.on('pageerror', e => console.log(`PAGEERROR [${NAMES[n]}]`, (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { Math.random = () => 0.4999; });   // visual-only randomness (r15-14), the same in every page and every order
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed' + seed + 'gen4v10');
  await require('./lib').ready(pg);
  await pg.evaluate(order => {
    BF.rtick.order = order;
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    if (BF.player.setCreative) BF.player.setCreative(true);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 1e9); };
    // which regions the mob loop visited in its last tick, in order (to check the order really was used)
    const plan = BF.rtick.plan;
    window.__visit = [];
    BF.rtick.plan = list => { const out = plan(list), seen = []; for (const m of out) { const k = BF.regions.regionOf(m); if (k != null && seen[seen.length - 1] !== k) seen.push(k); } window.__visit = seen; return out; };
    window.__blasts = { parts: 0, late: 0 };
    const send = BF.req.send;
    BF.req.send = function (kind, target, data, from) { if (kind === 'explode' && data && data.region != null) { window.__blasts.parts++; if (data.late) window.__blasts.late++; } return send.apply(this, arguments); };
  }, ORDERS[n]);
  // the chunks round the village: load until the count stops growing (a planet's chunk generation is partly asynchronous)
  let last = -1;
  for (let i = 0; i < 80; i++) {
    const c = await pg.evaluate(() => { window.__load(4); return BF.world.chunks.size + BF.world.queueLength * 1e6; });
    if (c === last && i > 5) break;
    last = c; await pg.waitForTimeout(250);
  }
  return pg;
}
const advance = (pg, steps) => pg.evaluate(k => { for (let i = 0; i < k; i++) BF.simStep(0.05); return BF.stateHash.full(); }, steps);

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t0 = Date.now();
  const pages = await Promise.all(ORDERS.map((o, i) => boot(b, i)));
  const chunks = await Promise.all(pages.map(pg => pg.evaluate(() => BF.world.chunks.size)));
  console.log(`booted seed ${seed} four times in ${((Date.now() - t0) / 1000).toFixed(0)} s (chunks ${chunks.join(' / ')})`);

  const noise = {}, hidden = {}, shown = {};
  const diffParts = (a, c) => Object.keys(a.parts).filter(k => a.parts[k] !== c.parts[k]);
  const show = async (k, i, label) => {
    if (shown[k + i]) return;
    shown[k + i] = true;
    const [x, y] = await Promise.all([pages[0], pages[i]].map(pg => pg.evaluate(k => BF.stateHash.text(k), k)));
    let j = 0; while (j < x.length && x[j] === y[j]) j++;
    const cut = t => JSON.stringify(t.slice(Math.max(0, j - 200), j + 160));
    console.log(`  ${k} first differs (${label}) at character ${j} of ${x.length} / ${y.length}:\n    list ${cut(x)}\n    ${NAMES[i]} ${cut(y)}`);
  };
  const compare = async (label, r) => {
    const ctl = new Set(diffParts(r[0], r[1]));
    for (const k of ctl) noise[k] = noise[k] || label;
    const line = [];
    for (const i of [2, 3]) {
      const d = diffParts(r[0], r[i]), real = d.filter(k => !ctl.has(k));
      line.push(`${NAMES[i]} ${r[i].hash === r[0].hash ? 'same' : 'differs in ' + d.join(', ')}`);
      for (const k of real) { if (!hidden[k]) hidden[k] = `${label}, ${NAMES[i]}`; await show(k, i, label); }
    }
    console.log(`${label}: list ${r[0].hash}; list2 ${ctl.size ? 'differs in ' + [...ctl].join(', ') : 'same'}; ${line.join('; ')}`);
  };
  await compare('start', await Promise.all(pages.map(pg => pg.evaluate(() => BF.stateHash.full()))));
  const steps = Math.round(1200 / 0.05 / 8);   // an eighth of a day (js/sky.js dayLength 1200 s)
  for (let c = 1; c <= CHECKS; c++) {
    const r = await Promise.all(pages.map(pg => advance(pg, steps)));
    await compare(`day ${(c / 8).toFixed(3)}`, r);
  }

  const info = await Promise.all(pages.map(pg => pg.evaluate(() => ({
    mobs: BF.mobs.list.length, visit: window.__visit, blasts: window.__blasts, st: BF.rtick.stats(), idx: BF.regions.check(),
  }))));
  console.log(`mobs at the end: ${info.map(x => x.mobs).join(' / ')}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (let i = 0; i < 4; i++) {
    const s = info[i].st;
    console.log(`  ${NAMES[i]}: ${s.regions} regions, ${s.mobs} mobs; ms a tick think ${s.ms.think.toFixed(2)}, apply ${s.ms.apply.toFixed(2)}, blocks ${s.ms.blocks.toFixed(2)}, deliver ${s.ms.deliver.toFixed(2)}; ` +
      `${s.regionApplies} region inboxes applied, ${s.inactive} refused as inactive; blasts ${info[i].blasts.parts} parts (${info[i].blasts.late} late)`);
  }
  // a blast across a region border: on the list, region and reverse pages alike, a creeper one block east of the border of the player's
  // region with a zombie on each side; a tick whose think sets it off. The region pages split it into one request per region.
  const blast = await Promise.all([0, 2, 3].map(i => pages[i].evaluate(() => {
    const M = BF.mobs, G = BF.regions, W = BF.world, p = BF.player.position, k = G.keyOf(p.x, 0, p.z), b = G.bounds(k);
    const x = b.x0 + 1, z = Math.floor(p.z);
    let y = BF.H - 1; while (y > BF.MIN_Y && !W.getBlock(x, y, z)) y--;
    for (const [dx, dz] of [[-4, 0], [0, 0], [3, 0]]) for (let h = 1; h <= 3; h++) W.setBlock(x + dx, y + h, z + dz, 0);
    const cr = M.spawn("creeper", x + 0.5, y + 1, z + 0.5), z1 = M.spawn("zombie", x - 3.5, y + 1, z + 0.5), z2 = M.spawn("zombie", x + 3.5, y + 1, z + 0.5);
    BF.regions.tick();
    const cells = [];
    for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) cells.push([x + dx, y + dy, z + dz]);
    const before = cells.map(c => W.getBlock(...c)), parts0 = window.__blasts.parts, late0 = window.__blasts.late;
    const up = M.update;
    M.update = function () { M.update = up; const r = up.apply(this, arguments); M.explode(cr); return r; };
    try { BF.simStep(0.05); } finally { M.update = up; }
    const broke = cells.filter((c, i) => before[i] && !W.getBlock(...c));
    const west = broke.filter(c => G.keyOf(c[0], c[1], c[2]) !== k).length, east = broke.length - west;
    const r = { parts: window.__blasts.parts - parts0, late: window.__blasts.late - late0, west, east, hp: [z1.hp, z2.hp], exploded: !!cr.exploded, removed: !!cr.removed };
    for (const m of [z1, z2]) M.discard(m);
    return r;
  })));
  console.log('blast across a border (list, region, reverse): ' + blast.map(r => JSON.stringify(r)).join(' '));
  check(blast[1].parts > 1 && blast[1].late === blast[1].parts - 1, `the blast is one request per region it reaches (${blast[1].parts}, ${blast[1].late} of them late)`);
  check(blast[1].west > 0 && blast[1].east > 0 && blast[1].hp.every(h => h < 20) && blast[1].exploded && blast[1].removed, 'it breaks blocks and hurts zombies on both sides of the border, and the creeper is gone');
  check(JSON.stringify(blast[0]).replace(/"parts":\d+,"late":\d+,/, '') === JSON.stringify(blast[1]).replace(/"parts":\d+,"late":\d+,/, '') &&
    JSON.stringify(blast[2]) === JSON.stringify(blast[1]), 'and does the same in all three orders');
  const v = info[2].visit, w = info[3].visit;
  check(v.length > 1 && v.every((k, i) => !i || v[i - 1] < k), `region order visits regions in key order (${v.length} regions)`);
  check(w.length > 1 && w.every((k, i) => !i || w[i - 1] > k), `reverse order visits them in reverse (${w.length} regions)`);
  check(info.every(x => x.idx.ok), 'the region index self-check finds nothing after the day' + (info.some(x => !x.idx.ok) ? ': ' + info.map(x => x.idx.diffs.slice(0, 2).join('; ')).join(' | ') : ''));
  if (Object.keys(noise).length) console.log('not deterministic between two list runs (r15-24), so not compared from then on: ' + Object.keys(noise).map(k => `${k} (from ${noise[k]})`).join(', '));
  check(!Object.keys(hidden).length, 'region and reverse order give the same world as the single-list tick' +
    (Object.keys(hidden).length ? ': hidden order dependencies in ' + Object.keys(hidden).map(k => `${k} (${hidden[k]})`).join(', ') : ''));
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('ok   all checks passed');
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
