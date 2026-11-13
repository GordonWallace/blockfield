// @ci integration suite=items hosts=worker,server
// Filled maps the simulation made are the same items in the page (Gordon, 2026-11-12: an explorer's maps on the trade screen, and a map
// held by the pointer, showed as a magenta "?"). With the simulation in a worker or on the world server, map items are made there with
// ids from its own counter; the page's own slots come by name, but the held stack, the villager's inventory, the screen's grid and drops
// carry ids. The simulation now sends the map items it made (self.dyn) and the page makes them under the same ids.
// Usage: node test/run.js /tmp/mip test/map-ids-page.js --host worker
module.exports = async (pg, out) => {
  const lib = require('./lib');
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(500);
  // an explorer's map the page never saw (made first, so the ids of the two sides no longer line up), then the player's own map
  const ids = await lib.sim(pg, () => {
    BF.mobs.spawning = false;
    const X = BF.resolveItem("filled_map_1_40_40"), Y = BF.resolveItem("filled_map_1_41_41");
    BF.inventory.clear(); BF.inventory.setSlot(0, { id: Y, count: 1 }); BF.proto.flush();
    return { X, Y };
  });
  await pg.waitForFunction(() => BF.inventory.slots[0], null, { timeout: 20000 });
  await settle();
  const page = await pg.evaluate(ids => ({ x: BF.items[ids.X] ? BF.items[ids.X].name : null, y: BF.items[ids.Y] ? BF.items[ids.Y].name : null,
    slot: BF.items[BF.inventory.slots[0].id].name }), ids);
  ok("the explorer's map is the same item in the page", page.x === "filled_map_1_40_40", page);
  ok("the player's map is the same item in the page", page.y === "filled_map_1_41_41" && page.slot === "filled_map_1_41_41", page);
  // pick the map up with the pointer: the held stack comes as an id
  await pg.evaluate(() => BF.inventory.open());
  await pg.waitForFunction(() => document.querySelector('.bf-slot[data-c="inv"][data-i="0"] img:not([hidden])'), null, { timeout: 15000 });
  await settle();
  const box = await pg.evaluate(() => { const r = document.querySelector('.bf-slot[data-c="inv"][data-i="0"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await pg.mouse.click(box[0], box[1]); await settle();
  await pg.mouse.move(box[0] + 60, box[1] - 40); await settle();
  const held = await pg.evaluate(() => { const c = BF.inventory.cursor; return c ? (BF.items[c.id] ? BF.items[c.id].name : "unknown id " + c.id) : null; });
  ok("the map held by the pointer is the player's map", held === "filled_map_1_41_41", held);
  await pg.screenshot({ path: out + '-held.png' });
  await pg.mouse.click(box[0], box[1]); await settle();
  await pg.evaluate(() => BF.inventory.close());
  for (const l of R) console.log(l);
};
