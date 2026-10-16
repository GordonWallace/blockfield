// In-page helpers for tests on the planet (spec r14-22), as window.BFT. test/run.js installs them in every action-script test; a
// node test calls require('./lib').install(page) before its goto. Not a test (test/ci.js skips it).
window.BFT = {
  // the world's spawn column (BF.newWorld puts the player there; on the planet it is on face 4, at least 5 km from any edge)
  spawn() { const s = BF.spawnPoint || BF.player.position; return { x: Math.floor(s.x), z: Math.floor(s.z) }; },
  // building type counts of village v, e.g. { house: 12, pen: 1, coop: 1 }
  kinds(v) { const k = {}; for (const b of v.buildings || []) k[b.type] = (k[b.type] || 0) + 1; return k; },
  // villages within r blocks of from (default the spawn), nearest first
  villages(r = 3000, from) {
    from = from || BFT.spawn();
    const d = v => BF.planet.distance(from, v);
    return BF.worldgen.villagesNear(from.x, from.z, r).sort((a, b) => d(a) - d(b));
  },
  // the nearest village for which test(v, kinds) holds, or null; replaces the generator 3 tests' fixed village positions
  village(test = () => true, r = 3000, from) {
    for (const v of BFT.villages(r, from)) if (test(v, BFT.kinds(v))) return v;
    return null;
  },
  // a block cell as typed into a command: relative to the player, as commands read u y v on the planet's faces (spec r14-18)
  cell(x, y, z) { const p = BF.player.position; return `~${x - Math.floor(p.x)} ~${y - Math.floor(p.y)} ~${z - Math.floor(p.z)}`; },
  // an exact position as typed into a command (/tp, /summon), relative to the player as above
  at(x, y, z) { const p = BF.player.position, f = n => +n.toFixed(4); return `~${f(x - p.x)} ~${f(y - p.y)} ~${f(z - p.z)}`; },
};
