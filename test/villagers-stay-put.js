// @ci integration
// Villagers are where you left them: after Save and Quit to Title (the title screen keeps the world running behind it) and Play,
// and after walking away from a village and coming back, each roster villager comes back on the spot where it stood.
// Usage: node test/run.js /tmp/vs test/villagers-stay-put.js
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
    const X = 30, Z = 43;
    const settle = async (n = 60) => { for (let k = 0; k < n; k++) { BF.world.update(X, Z, 8); run(0.5); await new Promise(r => setTimeout(r, 0)); } };
    // after a load: tick in tiny steps only until the whole roster is back, so the first ones back have had little time to walk
    const arrive = async (want) => {
      for (let k = 0; k < 400; k++) { BF.world.update(X, Z, 8); run(0.05, 0.05); await new Promise(r => setTimeout(r, 5)); if (roster().length >= want) break; }
    };
    let KEY = null;
    const roster = () => BF.mobs.list.filter(m => m.type === "villager" && !m.dead && !m.removed && !m.bred && m.village && (!KEY || m.village.key === KEY));
    const spots = () => { const o = {}; for (const m of roster()) o[m.slot.idx] = [m.position.x, m.position.y, m.position.z]; return o; };
    // a villager mid-hop when saved lands, so up to a block lower
    const far = (a, b) => Object.keys(a).filter(k => !b[k] || Math.hypot(a[k][0] - b[k][0], a[k][2] - b[k][2]) > 0.6 || Math.abs(a[k][1] - b[k][1]) > 1.01);
    BF.state.paused = true;
    const meta = await BF.save.create({ name: "stay put", seed: 1, gameMode: "creative" });
    BF.mobs.spawning = false;
    BF.sky.setTime(0.1);
    await load(X, Z); await settle();
    const counts = {}; for (const m of roster()) counts[m.village.key] = (counts[m.village.key] || 0) + 1;
    KEY = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const n0 = roster().length;
    ok("village loaded with villagers", n0 >= 4, { KEY, n0 });
    await settle(20);   // they wander off from their houses
    const before = spots();
    const moved = Object.keys(before).filter(k => { const m = roster().find(v => String(v.slot.idx) === k), H = m.home; return !H || Math.hypot(H.x + (H.w || 1) / 2 - before[k][0], H.z + (H.d || 1) / 2 - before[k][2]) > 3; });
    ok("some villagers are away from their houses before saving", moved.length >= 2, moved.length);
    // Save and Quit to Title: save, then the title screen keeps running the world (unsaved) behind it
    await BF.save.saveNow();
    BF.save.current = null;
    await settle(30);
    const title = spots();
    ok("on the title screen the world behind it runs on (villagers move)", far(before, title).length >= 2, far(before, title).length);
    // Play: load the save
    await BF.save.load(meta.id);
    BF.mobs.spawning = false;
    BF.player.teleport(X + 0.5, BF.worldgen.heightAt(X, Z) + 2, Z + 0.5);
    await arrive(n0);
    const after = spots();
    ok("after loading: the whole roster is back", Object.keys(after).length === n0, [Object.keys(after).length, n0]);
    ok("after loading: every villager is where it was when saved", far(before, after).length === 0, far(before, after).map(k => ({ k, before: before[k], after: after[k] })));
    // walk away (the village unloads) and come back: they are where they were when it unloaded
    await settle(10);
    const left = spots();
    await load(1500, 1500); for (let k = 0; k < 20; k++) { BF.world.update(1500, 1500, 8); run(0.5); await new Promise(r => setTimeout(r, 0)); }
    ok("villagers unloaded while away", roster().length === 0, roster().length);
    BF.player.teleport(X + 0.5, BF.worldgen.heightAt(X, Z) + 2, Z + 0.5);
    await load(X, Z); await arrive(n0);
    const back = spots();
    ok("after coming back: every villager is where it was when it unloaded", Object.keys(back).length === n0 && far(left, back).length === 0, far(left, back).map(k => ({ k, left: left[k], back: back[k] })));
    // older saves (no spot saved): villagers start at their houses as before
    const old = JSON.parse(JSON.stringify(BF.mobs.exportVillagers()));
    for (const k in old) if (old[k] && old[k].pos) delete old[k].pos;
    BF.newWorld(1, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    BF.mobs.importVillagers(old);
    BF.sky.setTime(0.1);
    await load(X, Z); await arrive(n0);
    ok("older saves without spots still load every villager", roster().length === n0, [roster().length, n0]);
    await BF.save.remove(meta.id);
    return R;
  });
  for (const l of res.lines) console.log(l);
};
