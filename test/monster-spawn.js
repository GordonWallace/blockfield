// @ci integration suite=village timeout=600
// Monsters spawn in any loaded chunk, not around the player (js/mobs.js spawnMonsters, js/wildlife.js mayHostile; idea-037): with the player
// 300 blocks from a running village at night, zombies appear in the village's dark spots and none on lit ground; no area holds more than its
// cap (10 per 28 chunks) and nothing spawns within 12 blocks of the player, a villager or an iron golem.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/ms test/monster-spawn.js
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  // a village with a spot 300 blocks off that no other village is near; the village kept running by a pin (as a caravan trip does)
  const setup = await pg.evaluate(() => {
    const vs = (BF.worldgen.villagesNear(0, 0, 3000) || []).filter(v => v && v.minX != null && v.pop >= 6).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    for (const v of vs) for (let a = 0; a < 8; a++) {
      const x = Math.round(v.x + Math.cos(a * 0.785) * 300), z = Math.round(v.z + Math.sin(a * 0.785) * 300);
      const near = (BF.worldgen.villagesNear(x, z, 600) || []).filter(o => o.minX != null && Math.hypot(o.x - x, o.z - z) < 260);
      if (near.length) continue;
      // the clock goes to day 6 (as the night below wants) before the pin: js/merchant.js tick drops a pin no merchant's trip has held for a
      // game day, so a jump of 6 days after pinning lost the pin at the night's first tick and the village unloaded (300 blocks is past DROP)
      BF.sky.day = 6;
      BF.villageSim.pin("test", v, v, []);
      BF.player.spawn(x + 0.5, BF.worldgen.heightAt(x, z) + 2, z + 0.5);
      return { v: [v.x, v.z], key: Math.round(v.x) + "," + Math.round(v.z), at: [x, z] };
    }
    return null;
  });
  ok("found a village with a spot 300 blocks away", !!setup, setup);
  if (!setup) { console.log("FAILED: 1"); return; }
  // The village sim's frame-time guard (js/villagesim.js overLimit "AI time", LIMITS.aiMs) stops villages beyond ALWAYS of the player, pinned
  // ones too, when villager AI averages over 6 ms a frame. A headless software-rendered runner gets there with this village's 44 villagers, so
  // the village (and its villagers) dropped out before or during the night and no monster could spawn in it. The guard is not what this
  // test checks (test/force-unload.js does), so it is lifted here and put back at the end.
  const aiMs = await pg.evaluate(() => { const L = BF.villageSim.LIMITS, was = L.aiMs; L.aiMs = Infinity; return was; });
  await pg.waitForFunction(k => BF.villageSim.isActive(k) && BF.mobs.villages.get(k) && (BF.mobs.villages.get(k).members || []).some(m => m.type === "villager"), setup.key, { timeout: 90000 }).catch(() => {});
  await pg.waitForTimeout(4000);
  const r = await pg.evaluate(async ([key, aiMs]) => {
    const W = BF.world, L = BF.wildlife, M = BF.mobs, S = BF.sky, rec = M.villages.get(key);
    for (const m of M.list.slice()) if (m.hostile) m.dead = true;
    S.day = 6; S.setTime(0.56);
    const spawns = [], orig = L.spawned;
    L.spawned = m => {
      const p = m.position, A = L.areaOf(p.x, p.z);
      let near = Infinity;
      for (const o of M.list) if (o !== m && !o.dead && (o.type === "villager" || (o.def && o.def.golem))) near = Math.min(near, Math.hypot(o.position.x - p.x, o.position.y - p.y, o.position.z - p.z));
      const pp = BF.player.position;
      spawns.push({ type: m.type, x: p.x, z: p.z, light: W.getBlockLight(p.x, p.y, p.z), player: Math.hypot(pp.x - p.x, pp.y - p.y, pp.z - p.z), near,
        area: A ? A.kind + ":" + A.key : "?", h: A ? A.h : null, cap: A ? A.cap : null, inVillage: !!(BF.vlog.villageAt(p.x, p.z) === rec) });
      orig(m);
    };
    let over = [];
    for (let i = 0; i < 3600; i++) {
      S.update(0.05); M.update(0.05);
      if (i % 20 === 0) for (const A of L.areas()) {   // a second's worth: count again, as the areas are rebuilt
        let h = 0; for (const m of M.list) if (m.hostile && !m.dead && !m.removed && L.areaOf(m.position.x, m.position.z) === A) h++;
        if (h > A.cap + 2) over.push([A.kind, h, A.cap]);
      }
      if (i % 200 === 0) await new Promise(r => setTimeout(r, 0));
    }
    const active = BF.villageSim.isActive(key);   // (still running at the end: the pin held)
    L.spawned = orig;
    BF.villageSim.unpin("test");
    BF.villageSim.LIMITS.aiMs = aiMs;
    return {
      n: spawns.length, inVillage: spawns.filter(s => s.inVillage).length, zombiesInVillage: spawns.filter(s => s.inVillage && s.type === "zombie").length,
      lit: spawns.filter(s => s.light > 7).length, atCap: spawns.filter(s => s.h >= s.cap).length, close: spawns.filter(s => s.player < 12 || s.near < 12).map(s => [s.player, s.near].map(Math.round)),
      areas: [...new Set(spawns.map(s => s.area))].length, over: over.slice(0, 5), overN: over.length, minPlayer: Math.round(Math.min(...spawns.map(s => s.player))), active
    };
  }, [setup.key, aiMs]);
  ok("monsters spawn with the player 300 blocks away", r.n > 0, r);
  ok("zombies appear in the running village", r.active && r.zombiesInVillage >= 1, r);
  ok("nothing spawns on lit ground (block light over 7)", r.lit === 0, r);
  ok("no spawn into an area already at its cap", r.atCap === 0, r);
  ok("no area holds more hostiles than its cap (2 of slack for ones walking in)", r.overN === 0, r.over);
  ok("nothing spawns within 12 blocks of the player, a villager or a golem", r.close.length === 0, r.close.slice(0, 5));
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
