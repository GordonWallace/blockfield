// /tp x z lands on the top of the column (bug-068): on the water over the sea and lakes, on sea ice, on a tree or a build, and
// says the y it put the player at, also when the chunk there isn't loaded yet. node test/run.js /tmp/ts test/tp-surface.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  // spots by biome along a line, found from the generator without loading anything
  const spots = await pg.evaluate(() => {
    const G = BF.worldgen, want = { ocean: null, frozen: null, land: null };
    for (let i = 0; i < 4000 && (!want.ocean || !want.frozen || !want.land); i++) {
      const x = 3000 + i * 97, z = -2000 + i * 61, n = G.biomeAt(x, z).name;
      if (BF.world.isLoaded(x, z)) continue;
      if (/Frozen Ocean/.test(n)) want.frozen = want.frozen || [x, z, n];
      else if (/Ocean/.test(n)) want.ocean = want.ocean || [x, z, n];
      else if (G.heightAt(x, z) > BF.SEA + 4) want.land = want.land || [x, z, n];
    }
    return want;
  });
  const near = (y, top) => y > top + 0.85 && y < top + 1.02;   // feet on the top block (a frame of physics settles them, or the water lets them sink a little)
  const tp = async (x, z) => {
    const r = await pg.evaluate(c => BF.commands.execute(c), `/tp ${x} ${z}`);
    const at = await pg.evaluate(() => {
      const p = BF.player.position, bx = Math.floor(p.x), bz = Math.floor(p.z), by = Math.floor(p.y), W = BF.world;
      return { y: p.y, below: W.getBlock(bx, by - 1, bz), feet: W.getBlock(bx, by, bz), head: W.getBlock(bx, by + 1, bz), top: W.topAt(bx, bz), solid: W.heightAt(bx, bz) };
    });
    const said = r.msg && +(/to [-\d.]+, ([-\d.]+),/.exec(r.msg) || [])[1];
    return { r, at, said };
  };
  const WATER = await pg.evaluate(() => BF.B.water), SOLID = await pg.evaluate(() => Array.from(BF.SOLID));
  for (const k of ["ocean", "frozen", "land"]) {
    const s = spots[k];
    check(!!s, `found a ${k} spot ${JSON.stringify(s)}`);
    if (!s) continue;
    const { r, at, said } = await tp(s[0], s[1]);
    check(r.ok, `/tp ${s[0]} ${s[1]} (${s[2]}): ${r.msg}`);
    check(near(at.y, at.top) && Math.abs(said - (at.top + 1.01)) < 0.01, `stands on the top of the column (y ${at.y.toFixed(2)}, said ${said}, top ${at.top}, solid ${at.solid})`);
    check(!BF_SOLID(at.feet) && !BF_SOLID(at.head), "feet and head are clear");
    if (k === "ocean") check(at.below === WATER && at.top >= -1 && at.top > at.solid + 2, `on the water over the sea (block below ${at.below}, top ${at.top}, sea floor ${at.solid})`);
    if (k === "frozen") check(at.below !== WATER && at.top >= -1, `on the sea ice, not the floor under it (block below ${at.below}, top ${at.top})`);
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
  check(rel.r.ok && near(rel.at.y, rel.at.top), "relative /tp ~5 ~-5 lands on the top too: " + rel.r.msg);
  const at = await pg.evaluate(() => [BF.player.position.x, BF.player.position.z]);
  check(Math.abs(at[0] - before[0] - 5) < 1e-6 && Math.abs(at[1] - before[1] + 5) < 1e-6, "relative /tp moved by 5, -5");
  const log = await pg.evaluate(() => BF.glog.recent(50).filter(e => /\/tp to the surface/.test(JSON.stringify(e))).length);
  check(log >= 3, `game log has the surface teleports (${log})`);
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL tp-surface" : "PASS tp-surface");
};
