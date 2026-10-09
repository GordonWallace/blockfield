// @ci integration suite=world
// Upgrading a map again picks up what the smaller map explored since the last upgrade (bug-031): seeing the crafting
// result used to merge the small map in once per session and never again.
// Usage: node test/run.js /tmp/mua test/map-upgrade-again.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const res = await pg.evaluate(() => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const I = BF.I, inv = BF.inventory, M = BF.maps;
    const P = BF.player.position, x0 = P.x, z0 = P.z;
    const zx = M.zoneOf(x0), zz = M.zoneOf(z0), b = M.bounds(1, zx, zz);
    // two loaded points in the zone, about 50 blocks apart
    const ax = Math.max(b.x0 + 5, Math.min(b.x1 - 55, x0 - 25)), bx = ax + 50, z = Math.max(b.z0 + 5, Math.min(b.z1 - 5, z0));
    P.set(ax, P.y, z);
    inv.clear(); inv.add(I.blank_map_1, 1); inv.select(0);
    M.use(inv.selected(), BF.items[inv.selected().id]);
    const id1 = inv.selected().id, d1 = M.dataOfItem(BF.items[id1]);
    for (let k = 0; k < 20; k++) M.explore(d1, ax, z, 900);
    const n = d => d.px.reduce((a, v) => a + (v ? 1 : 0), 0);
    const grid = id => [0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => ({ id: k === 4 ? id : I.paper, count: 1 }));
    const up = M.craftHook(grid(id1), 3), d2 = M.dataOfItem(BF.items[up.id]);
    const big1 = n(d2), small1 = n(d1);
    for (let k = 0; k < 20; k++) M.explore(d1, bx, z, 900);
    const small2 = n(d1);
    M.craftHook(grid(id1), 3);
    const big2 = n(d2);
    ok("the small map explored more after the first upgrade", small2 > small1, { small1, small2 });
    ok("upgrading again adds what it explored since", big2 > big1, { big1, big2 });
    // the same as a fresh session would give
    const ser = M.serialize(); M.deserialize(ser);
    const d2b = M.getData(2, zx, zz);
    M.craftHook(grid(id1), 3);
    ok("matches what a reload then upgrade gives", n(d2b) === big2, { reloaded: n(d2b), big2 });
    const v = d2b.ver; M.craftHook(grid(id1), 3);
    ok("an upgrade with nothing new changes nothing", d2b.ver === v);
    inv.clear();
    return R;
  });
  for (const l of res.lines) console.log(l);
};
