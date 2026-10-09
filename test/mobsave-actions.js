// @ci integration suite=village
// Quit and reload takes no game time: villagers, village golems and wild mobs come back where they were, facing the same way, with their
// state (js/mobsave.js, village loading plan scenario 1). Usage: node test/run.js /tmp/ms test/mobsave-actions.js
module.exports = async (pg, out) => {
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra));
  const id = await pg.evaluate(async () => (await BF.save.create({ name: "mobsave", seed: 1337, gameMode: "creative" })).id);
  await require('./lib').toVillage(pg);
  await pg.waitForFunction(() => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.slot).length >= 4, null, { timeout: 60000 });
  const before = await pg.evaluate(async () => {
    BF.mobs.spawning = false;
    const p = BF.player.position;
    const cow = BF.mobs.spawn("cow", p.x + 6, p.y, p.z + 6); cow.marker = 77; cow.ai.mode = "walk"; cow.ai.tx = p.x + 20; cow.ai.tz = p.z;
    for (let i = 0; i < 120; i++) BF.mobs.update(0.05);
    const key = m => m.village.key + "#" + m.slot.idx;
    const vs = {}, gs = [];
    for (const m of BF.mobs.list) {
      if (m.type === "villager" && m.village && m.slot && !m.dead) vs[key(m)] = { p: [m.position.x, m.position.y, m.position.z], yaw: m.yaw, mode: m.ai.mode, tx: m.ai.tx, tz: m.ai.tz, hp: m.hp, inv: m.inv.filter(Boolean).length };
      if (m.type === "iron_golem" && m.village) gs.push([m.position.x, m.position.z]);
    }
    const c = BF.mobs.list.find(m => m.marker === 77);
    await BF.save.saveNow();
    return { vs, gs, cow: c && { p: [c.position.x, c.position.y, c.position.z], mode: c.ai.mode, tx: c.ai.tx } };
  });
  const n = Object.keys(before.vs).length;
  ok("villagers were loaded to save", n >= 4, { n });
  await pg.reload();
  await pg.waitForTimeout(6000);
  await pg.evaluate(async id => { await BF.save.load(id); BF.mobs.spawning = false; }, id);
  await pg.waitForFunction(() => BF.mobs.list.filter(m => m.restored && m.type === "villager").length >= 3, null, { timeout: 60000 }).catch(() => {});
  const after = await pg.evaluate(() => {
    const key = m => m.village.key + "#" + m.slot.idx, vs = {}, gs = [];
    for (const m of BF.mobs.list) {
      if (m.type === "villager" && m.village && m.slot && !m.dead) vs[key(m)] = { p: [m.position.x, m.position.y, m.position.z], yaw: m.yaw, mode: m.ai.mode, tx: m.ai.tx, restored: !!m.restored, hp: m.hp, inv: m.inv.filter(Boolean).length };
      if (m.type === "iron_golem" && m.village) gs.push([m.position.x, m.position.z, !!m.restored]);
    }
    const c = BF.mobs.list.find(m => m.marker === 77);
    return { vs, gs, cow: c && { p: [c.position.x, c.position.y, c.position.z], mode: c.ai.mode, tx: c.ai.tx, restored: !!c.restored } };
  });
  const rest = Object.keys(after.vs).filter(k => after.vs[k].restored && before.vs[k]);
  const far = rest.filter(k => Math.hypot(after.vs[k].p[0] - before.vs[k].p[0], after.vs[k].p[2] - before.vs[k].p[2]) > 3);
  ok("villagers come back exactly (within 3 blocks of where they stood)", rest.length >= 3 && far.length === 0, { restored: rest.length, far: far.map(k => [k, before.vs[k].p, after.vs[k].p]) });
  ok("their facing and inventories are kept", rest.every(k => Math.abs(after.vs[k].yaw - before.vs[k].yaw) < 1.2 && after.vs[k].inv === before.vs[k].inv), rest.slice(0, 3).map(k => [before.vs[k].yaw, after.vs[k].yaw]));
  ok("what they were doing is kept", rest.filter(k => after.vs[k].mode === before.vs[k].mode).length >= rest.length * 0.7, rest.slice(0, 5).map(k => [before.vs[k].mode, after.vs[k].mode]));
  ok("the wild cow comes back where it was", !!after.cow && after.cow.restored && Math.hypot(after.cow.p[0] - before.cow.p[0], after.cow.p[2] - before.cow.p[2]) < 6, { before: before.cow, after: after.cow });
  ok("village golems come back where they were", before.gs.length === 0 || after.gs.some(g => g[2] && before.gs.some(b => Math.hypot(b[0] - g[0], b[1] - g[1]) < 3)), { before: before.gs, after: after.gs });
  // a stale snapshot (game time passed) is not used
  const stale = await pg.evaluate(() => {
    BF.mobSave.deserialize({ t: BF.sky.day + BF.sky.time - 0.5, v: { "x#1": { p: [0, 0, 0], yaw: 0, hp: 20, s: {} } }, g: {}, w: [] });
    return BF.mobSave.peek("x#1");
  });
  ok("a snapshot older than the exact window is dropped", stale === null, { stale });
  await pg.evaluate(id => BF.save.remove(id), id);
};
