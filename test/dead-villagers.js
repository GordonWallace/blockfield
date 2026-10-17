// Killed villagers stay dead: through the village unloading and loading again (the living ones come back, not the dead ones)
// and through a save and load. Usage: node test/run.js /tmp/dv test/dead-villagers.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const load = async (x, z) => {
      BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
      for (let i = 0; i < 400 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 300; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    };
    const KEY = "26,39";
    const roster = () => BF.mobs.list.filter(m => m.type === "villager" && !m.dead && !m.removed && !m.bred && m.village && m.village.key === KEY);
    const settle = async () => { for (let k = 0; k < 60; k++) { BF.world.update(30, 43, 8); run(0.5); await new Promise(r => setTimeout(r, 0)); } };
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    BF.sky.setTime(0.1);
    await load(30, 43); await settle();
    const rec = BF.mobs.villages.get(KEY);
    const n0 = roster().length;
    ok("village loaded with its roster", !!rec && n0 === rec.roster.length, [n0, rec && rec.roster.length]);
    // kill the three villagers whose slots come first in the roster: an in-order respawn would bring exactly these back
    const victims = rec.roster.slice(0, 3).map(sl => roster().find(m => m.slot === sl)).filter(Boolean);
    const deadIdx = victims.map(m => m.slot.idx);
    for (const m of victims) BF.mobs.hurt(m, 999, "a zombie");
    run(3);
    const living = roster().map(m => m.slot.idx).sort((a, b) => a - b);
    ok("three villagers killed", victims.length === 3 && roster().length === n0 - 3, [victims.length, roster().length]);
    ok("their slots are recorded as dead", deadIdx.every(i => rec.dead && rec.dead.has(i)), rec.dead && [...rec.dead]);
    // walk away (the village unloads) and come back
    await load(1500, 1500); for (let k = 0; k < 20; k++) { BF.world.update(1500, 1500, 8); run(0.5); await new Promise(r => setTimeout(r, 0)); }
    ok("villagers unloaded while away", roster().length === 0, roster().length);
    await load(30, 43); await settle();
    const back = roster().map(m => m.slot.idx).sort((a, b) => a - b);
    ok("after coming back: same count", back.length === n0 - 3, [back.length, n0 - 3]);
    ok("after coming back: the living ones, none of the dead", JSON.stringify(back) === JSON.stringify(living) && !back.some(i => deadIdx.includes(i)), { back, living, deadIdx });
    // save and load
    const saved = JSON.parse(JSON.stringify(BF.mobs.exportVillagers()));
    ok("save lists the dead slots", saved["dead:" + KEY] && deadIdx.every(i => saved["dead:" + KEY].v.includes(i)), saved["dead:" + KEY]);
    ok("save drops the dead villagers' entries", deadIdx.every(i => !saved[KEY + "#" + i]));
    const info = saved["dead:" + KEY] && saved["dead:" + KEY].info || [];
    ok("save keeps who died (name, profession, cause, day)", deadIdx.every(i => info.some(e => e.i === i && e.name && e.prof && /zombie/.test(e.cause) && Number.isFinite(e.day))), info);
    const vc0 = BF.breeding.villagerCount(rec), vb0 = (rec.bred || []).reduce((k, e) => Math.max(k, e.k + 1), 0);
    BF.newWorld(1, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    BF.mobs.importVillagers(saved);
    BF.sky.setTime(0.1);
    await load(30, 43); await settle();
    const rec2 = BF.mobs.villages.get(KEY);
    const re = roster().map(m => m.slot.idx).sort((a, b) => a - b);
    ok("after reload: same count", re.length === n0 - 3, [re.length, n0 - 3]);
    ok("after reload: none of the dead", !re.some(i => deadIdx.includes(i)), { re, deadIdx });
    ok("after reload: who died is kept", rec2.deadInfo && rec2.deadInfo.length === 3 && JSON.stringify(rec2.deadInfo) === JSON.stringify(info), rec2.deadInfo);
    // a baby born while the village settles after the reload is a new villager, not one the reload made up
    const born = (rec2.bred || []).filter(e => e.k >= vb0 && !e.dead).length;
    ok("after reload: villager count unchanged", BF.breeding.villagerCount(rec2) - born === vc0, [BF.breeding.villagerCount(rec2), born, vc0]);
    return R;
  });
  for (const l of res.lines) console.log(l);
};
