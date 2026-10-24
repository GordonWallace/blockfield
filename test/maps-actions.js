// @ci integration hosts=worker,server
// Maps and compass checks: node test/run.js /tmp/maps test/maps-actions.js [--host page|worker|server]
// (Maps and the player's items are simulation state: the checks run where the simulation is, spec r15-43; the player is moved on the page.)
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  const r = await lib.sim(pg, async () => {
    const res = {}, I = BF.I, inv = BF.inventory;
    res.items = ["compass", "blank_map_1", "blank_map_5", "paper"].map(n => [n, I[n]]);
    res.recipes = inv.recipes.filter(r => r.out === I.compass || r.out === I.blank_map_1).map(r => r.desc);
    // zone rule: two chunks in the same 8x8 zone give the same bounds, a chunk in the next zone does not
    const bounds = x => { BF.player.position.set(x, BF.player.position.y, 40); inv.clear(); inv.add(I.blank_map_1, 1); inv.select(0); const sel = inv.selected(); BF.maps.use(sel, BF.items[sel.id]); const it = BF.items[inv.selected().id]; return [it.name, JSON.stringify(BF.maps.bounds(it.map.size, it.map.zx, it.map.zz))]; };
    res.zoneA = bounds(5); res.zoneB = bounds(100); res.zoneC = bounds(130); res.zoneD = bounds(-5);
    // explore around the player with a held map
    BF.player.position.set(40, BF.player.position.y, 40);
    inv.clear(); inv.add(I.blank_map_1, 1); inv.select(0);
    BF.maps.use(inv.selected(), BF.items[inv.selected().id]);
    const it = BF.items[inv.selected().id], d = BF.maps.dataOfItem(it);
    for (let k = 0; k < 8; k++) BF.maps.simFrame();   // (held: it fills in each frame where the simulation runs)
    res.explored = d.px.reduce((n, v) => n + (v ? 1 : 0), 0);
    // crafting hook: paper around a blank / used map
    const grid = id => [0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => ({ id: k === 4 ? id : I.paper, count: 1 }));
    res.up1 = BF.items[BF.maps.craftHook(grid(I.blank_map_1), 3).id].name;
    const up = BF.maps.craftHook(grid(inv.selected().id), 3);
    res.up2 = BF.items[up.id].name;
    res.up2Explored = BF.maps.dataOfItem(BF.items[up.id]).px.reduce((n, v) => n + (v ? 1 : 0), 0);
    res.up5 = BF.maps.craftHook(grid(I.blank_map_5), 3);
    // save round trip
    const ser = BF.maps.serialize(); BF.maps.deserialize(ser);
    res.saved = Object.keys(ser);
    res.afterLoad = BF.maps.dataOfItem(it).px.reduce((n, v) => n + (v ? 1 : 0), 0);
    inv.clear(); inv.add(up.id, 1); inv.select(0);
    BF.proto.flush();
    return res;
  });
  console.log(JSON.stringify(r, null, 1));
  await pg.evaluate(() => { BF.player.position.set(BF.player.position.x + 30, BF.player.position.y, BF.player.position.z); });
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: out + '-held.png' });
  await lib.give(pg, ['compass']);
  await pg.waitForTimeout(800);
  await pg.screenshot({ path: out + '-compass.png' });
};
