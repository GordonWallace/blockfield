// @ci integration suite=ui hosts=worker,server
// /tp x z lands on the top of the column (bug-068): on the water over the sea and lakes, on sea ice, on a tree or a build, and
// says the y it put the player at, also when the chunk there isn't loaded yet. The command runs where the simulation is (lib.sim);
// the player and the blocks it stands on are read in the page. node test/run.js /tmp/ts test/tp-surface.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  // spots by biome, as offsets from the player found from the generator without loading anything (/tp ~dx ~dz: the same frame on
  // a round planet, where plain numbers are u v on the player's face)
  const find = k => pg.evaluate(k => {
    const G = BF.worldgen, p = BF.player.position, want = { ocean: null, frozen: null, land: null };
    for (let i = 1; i < 6000 && !want[k]; i++) {
      const dx = Math.round(Math.cos(i * 2.39996) * (400 + i * 40)), dz = Math.round(Math.sin(i * 2.39996) * (400 + i * 40));
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
      if (BF.world.isLoaded(x, z) || (BF.world.canonXZ && !BF.world.canonXZ(x, z))) continue;
      const n = G.biomeAt(x, z).name;
      if (/Frozen Ocean/.test(n)) want.frozen = want.frozen || [dx, dz, n];
      else if (/Ocean/.test(n)) want.ocean = want.ocean || [dx, dz, n];
      else if (G.heightAt(x, z) > BF.SEA + 4 && !/River|Beach/.test(n)) want.land = want.land || [dx, dz, n];
    }
    return want[k];
  }, k);
  const near = (y, top, wet) => y > top + (wet ? -1.5 : 0.85) && y < top + 1.02;   // feet on the top block (a frame of physics settles them; water lets them sink a little)
  const tp = async (x, z) => {
    // the command runs where the simulation is; its teleport reaches the page's player with the next self message
    const before = await pg.evaluate(() => [BF.player.position.x, BF.player.position.z]);
    const r = await lib.sim(pg, c => { const r = BF.commands.execute(c); if (BF.proto) BF.proto.flush(); return r; }, `/tp ${x} ${z}`);   // x, z: numbers or ~offsets
    await pg.waitForFunction(b => { const p = BF.player.position; return (p.x !== b[0] || p.z !== b[1]) && BF.world.isLoaded(p.x, p.z); }, before, { timeout: 15000 }).catch(() => {});
    await pg.waitForTimeout(100);
    const at = await pg.evaluate(() => {
      const p = BF.player.position, bx = Math.floor(p.x), bz = Math.floor(p.z), by = Math.floor(p.y), W = BF.world;
      return { y: p.y, below: W.getBlock(bx, by - 1, bz), feet: W.getBlock(bx, by, bz), head: W.getBlock(bx, by + 1, bz), top: W.topAt(bx, bz), solid: W.heightAt(bx, bz) };
    });
    const said = r.msg && +((/to [-\d.]+, ([-\d.]+),/.exec(r.msg) || /\by ([-\d.,]+)$/.exec(r.msg) || [])[1] || "").replace(/,/g, "");
    return { r, at, said };
  };
  const WATER = await pg.evaluate(() => BF.B.water), SOLID = await pg.evaluate(() => Array.from(BF.SOLID));
  for (const k of ["ocean", "frozen", "land"]) {
    const s = await find(k);   // from where the player is now: ~ offsets are relative
    check(!!s, `found a ${k} spot ${JSON.stringify(s)}`);
    if (!s) continue;
    const { r, at, said } = await tp("~" + s[0], "~" + s[1]);
    check(r.ok, `/tp ~${s[0]} ~${s[1]} (${s[2]}): ${r.msg}`);
    check(near(at.y, at.top, at.below === WATER || at.feet === WATER) && Math.abs(said - (at.top + 1.01)) < 0.01, `stands on the top of the column (y ${at.y.toFixed(2)}, said ${said}, top ${at.top}, solid ${at.solid})`);
    check(!BF_SOLID(at.feet) && !BF_SOLID(at.head), "feet and head are clear");
    if (k === "ocean") check(at.below === WATER && at.top >= -1 && at.top > at.solid + 2, `on the water over the sea (block below ${at.below}, top ${at.top}, sea floor ${at.solid})`);
    if (k === "frozen") check(at.top >= -1 && at.top > at.solid + 2 || at.top === at.solid && at.below !== WATER && at.top >= -1, `on the sea ice or water, not the floor under it (block below ${at.below}, top ${at.top}, solid ${at.solid})`);
    await pg.waitForTimeout(1500);
  }
  function BF_SOLID(id) { return SOLID[id]; }
  // a tree: put the player next to a loaded tall tree and /tp onto its column
  const tree = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, L = BF.B;
    for (let r = 0; r < 40; r++) for (let dx = -r; dx <= r; dx++) for (const dz of [-r, r]) {
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz, h = W.heightAt(x, z), b = BF.blocks[W.getBlock(x, h, z)];
      if (b && /leaves/.test(b.name)) return [x, z, h];
    }
    return null;
  });
  if (tree) {
    const { at } = await tp(tree[0], tree[1]);
    check(near(at.y, tree[2]), `on top of the tree's leaves at ${JSON.stringify(tree)} (y ${at.y})`);
  } else console.log("no tree near the last spot; skipped");
  // relative coordinates and the @s form still work
  const before = await pg.evaluate(() => [BF.player.position.x, BF.player.position.z]);
  const rel = await tp("~5", "~-5");
  check(rel.r.ok && near(rel.at.y, rel.at.top, rel.at.below === WATER || rel.at.feet === WATER), "relative /tp ~5 ~-5 lands on the top too: " + rel.r.msg);
  const at = await pg.evaluate(() => [BF.player.position.x, BF.player.position.z]);
  check(Math.abs(at[0] - before[0] - 5) < 1e-6 && Math.abs(at[1] - before[1] + 5) < 1e-6, "relative /tp moved by 5, -5");
  const log = await lib.sim(pg, () => BF.glog.recent(200).filter(e => /\/tp to the surface/.test(JSON.stringify(e))).length);   // logged where the command ran
  check(log >= 3, `game log has the surface teleports (${log})`);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL tp-surface" : "PASS tp-surface");
};
