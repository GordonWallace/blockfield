// @ci baseline suite=world
// Seeded random streams (js/rand.js, spec r15-14): the streams look random (mean, buckets), BF.rand.at gives the same numbers for the same
// kind, cell and tick and different ones otherwise, a mob's stream carries on after a save and reload, the tick and creation counter are
// saved with the world, and no simulation code uses Math.random (the lint below).
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/rand test/rand.js
const fs = require('fs'), path = require('path');

// Files that may still use Math.random. Anywhere else a line needs a `// visual` mark (a particle, a wobble, a sound): nothing the simulation reads.
const ALLOWED = {
  'audio.js': 'sound', 'cracks.js': 'crack decals', 'rand.js': 'the API itself',
  'save.js': 'a new world\'s seed and save ids', 'player.js': 'player input (r15-20 makes it requests)',
  // the villager professions: r15-15 converts these and takes them off the list
  ...Object.fromEntries(['villagelife', 'forester', 'builder', 'glassmaker', 'pigfarmer', 'cowherd', 'beekeeper', 'toolsmith', 'stables', 'shepherd',
    'baker', 'miner', 'eggcook', 'poultry', 'furniture', 'fletcher', 'explorer', 'cartography', 'trading', 'storage', 'merchant', 'jobs', 'villagesim']
    .map(f => [f + '.js', 'r15-15'])),
};
function lint() {
  const dir = path.join(__dirname, '..', 'js'), bad = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    if (ALLOWED[f]) continue;
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((l, i) => {
      if (/Math\.random/.test(l) && !/\/\/ visual/.test(l)) bad.push(f + ':' + (i + 1) + '  ' + l.trim().slice(0, 120));
    });
  }
  return bad;
}

module.exports = async (pg) => {
  const ok = (name, cond, extra) => console.log((cond ? 'PASS ' : 'FAIL ') + name + '  ' + JSON.stringify(extra === undefined ? '' : extra));
  const bad = lint();
  ok('no Math.random in simulation code (outside the allowed files and // visual lines)', bad.length === 0, bad);

  const r = await pg.evaluate(async () => {
    const R = BF.rand, out = {};
    // distribution: mean and 10 buckets of an entity stream and of a hash stream
    const dist = s => { const b = new Array(10).fill(0); let sum = 0; const N = 200000; for (let i = 0; i < N; i++) { const x = s.next(); sum += x; b[Math.floor(x * 10)]++; } return { mean: sum / N, min: Math.min(...b) / N, max: Math.max(...b) / N }; };
    out.ent = dist(R.of({}));
    out.hash = dist(R.at('test', 3, 4, 5));
    // across cells: the first number of each of 100000 cells
    { const b = new Array(10).fill(0); let sum = 0; const N = 100000; for (let i = 0; i < N; i++) { const x = R.at('test', i % 317, Math.floor(i / 317), 9).next(); sum += x; b[Math.floor(x * 10)]++; } out.cells = { mean: sum / N, min: Math.min(...b) / N, max: Math.max(...b) / N }; }
    const s = R.of({});
    out.int = Array.from({ length: 2000 }, () => s.int(6)).every(v => Number.isInteger(v) && v >= 0 && v < 6);
    out.range = Array.from({ length: 2000 }, () => s.range(-2, 3)).every(v => v >= -2 && v < 3);
    out.pick = [s.pick(['a']), s.pick([])];
    // BF.rand.at: stable, and keyed by every part
    const a = (...k) => { const t = R.at(...k); return [t.next(), t.next()]; };
    out.stable = JSON.stringify(a('grow', 10, -20, 500, 64)) === JSON.stringify(a('grow', 10, -20, 500, 64));
    out.keyed = new Set([a('grow', 10, -20, 500, 64), a('grow', 11, -20, 500, 64), a('grow', 10, -19, 500, 64), a('grow', 10, -20, 501, 64), a('grow', 10, -20, 500, 65), a('cane', 10, -20, 500, 64)].map(v => v[0])).size === 6;
    const seed0 = BF.state.seed, v0 = R.at('grow', 1, 2, 3).next();
    BF.state.seed = seed0 + 1; const v1 = R.at('grow', 1, 2, 3).next(); BF.state.seed = seed0;
    out.seeded = v0 !== v1 && R.at('grow', 1, 2, 3).next() === v0;
    // the default tick is the simulation's
    const t0 = R.tick, d0 = R.at('x', 0, 0).next(); R.step(); const d1 = R.at('x', 0, 0).next(); R.tick = t0;
    out.repeat = R.at('rep', 1, 1).next() !== R.at('rep', 1, 1).next();   // asked again in the same tick: the key's next stream
    out.tick = d0 !== d1 && R.at('x', 0, 0).next() === d0 && R.at('x', 0, 0, t0).next() === d0;

    // a mob's stream through a save and reload (the wild mob path: js/wildlife.js stow / bring, js/mobsave.js snapshots)
    BF.state.paused = true;
    BF.mobs.spawning = false;
    const p = BF.player.position;
    const cow = BF.mobs.spawn('cow', p.x + 3, p.y, p.z + 3), cow2 = BF.mobs.spawn('cow', p.x + 5, p.y, p.z + 3);
    out.ownSeed = Number.isInteger(cow.rng) && cow.rng !== cow2.rng;
    for (let i = 0; i < 7; i++) R.of(cow).next();
    const e = JSON.parse(JSON.stringify(BF.mobSave.packWild(cow)));
    const expect = Array.from({ length: 5 }, () => R.of(cow).next());
    const back = BF.mobs.spawn('cow', p.x + 3, p.y, p.z + 3);
    BF.mobSave.apply(back, e.snap);
    out.mobBack = JSON.stringify(Array.from({ length: 5 }, () => R.of(back).next())) === JSON.stringify(expect);
    // a villager's (its trading save, js/trading.js pack / unpack)
    const v = BF.mobs.spawn('villager', p.x + 4, p.y, p.z - 3, 'farmer');
    for (let i = 0; i < 3; i++) R.of(v).next();
    const pk = JSON.parse(JSON.stringify(BF.trades.pack(v))), vexp = R.of(v).next();
    const v2 = BF.mobs.spawn('villager', p.x + 4, p.y, p.z - 3, 'farmer');
    BF.trades.unpack(v2, pk);
    out.villagerBack = R.of(v2).next() === vexp;
    // a villager seeded from its roster slot: the same slot gives the same stream, another slot or a death in the village another one
    const sl = k => { const o = {}; R.seed(o, k); return R.of(o).next(); };
    out.slot = sl('villager:0,0#3:0') === sl('villager:0,0#3:0') && sl('villager:0,0#3:0') !== sl('villager:0,0#4:0') && sl('villager:0,0#3:0') !== sl('villager:0,0#3:1');
    for (const m of [cow, cow2, back, v, v2]) BF.mobs.kill ? BF.mobs.kill(m) : (m.dead = true);

    // the tick and creation counter are saved with the world
    if (BF.save && BF.save.supported) {
      const id = (await BF.save.create({ name: 'rand', seed: 77, gameMode: 'creative', villages: 9, gen: 4 })).id;
      BF.state.paused = true;
      R.tick = 12345; for (let i = 0; i < 4; i++) R.of({}).next();
      const was = R.save();
      await BF.save.saveNow();
      R.reset();
      await BF.save.load(id);
      BF.state.paused = true;
      out.saved = { was, now: R.save() };
      await BF.save.remove(id);
    }
    return out;
  });
  const flat = d => d.mean > 0.497 && d.mean < 0.503 && d.min > 0.096 && d.max < 0.104;
  ok('an entity stream is uniform (mean, 10 buckets)', flat(r.ent), r.ent);
  ok('a world-event stream is uniform', flat(r.hash), r.hash);
  ok('the first numbers of neighbouring cells are uniform', r.cells.mean > 0.495 && r.cells.mean < 0.505 && r.cells.min > 0.094 && r.cells.max < 0.106, r.cells);
  ok('int, range and pick stay in range', r.int && r.range && r.pick[0] === 'a' && r.pick[1] === undefined, r.pick);
  ok('BF.rand.at is stable across calls', r.stable);
  ok('BF.rand.at differs by kind, cell, height and tick', r.keyed);
  ok('BF.rand.at depends on the world seed', r.seeded);
  ok('BF.rand.at defaults to the simulation tick', r.tick);
  ok('a key asked again within the same tick gets fresh numbers', r.repeat);
  ok('each new mob gets its own seeded stream', r.ownSeed);
  ok('a mob\'s stream carries on after a save and reload', r.mobBack);
  ok('a villager\'s stream carries on through its trading save', r.villagerBack);
  ok('a villager slot\'s stream: same slot same stream, a death moves it on', r.slot);
  ok('the tick and creation counter are saved with the world', r.saved && r.saved.now.tick === r.saved.was.tick && r.saved.now.made === r.saved.was.made, r.saved);
};
