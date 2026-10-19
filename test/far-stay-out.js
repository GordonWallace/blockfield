// @ci integration suite=village
// Out on purpose: node test/run.js /tmp/out test/far-stay-out.js
// Villagers more than 40 blocks from their village walk back (mobs.js villagerAI). An explorer with a map still to fill and a merchant on a trip
// are out there on purpose: in the minutes before the working day starts (and between an explorer's patches) they stay put instead of losing
// the ground they covered. With nothing to do out there (an explorer with no map) they still walk home.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  let bad = 0;
  for (const kind of ["explorer", "merchant", "explorer without a map"]) {
    const r = await pg.evaluate(kind => {
      const P = BF.player.position, W = BF.world, prof = kind.split(" ")[0];
      const m = BF.mobs.list.find(v => v.type === "villager" && !v.child && v.village && !v.dead && v.profession === prof);
      if (!m) return { kind, error: "no " + prof };
      const V = m.village, x = Math.floor(V.x) + 70, z = Math.floor(V.z) + 0.5;
      if (!W.isLoaded(x, z)) return { kind, error: "not loaded" };
      const saved = { ex: m.ex, mc: m.mc, inv: m.inv };
      m.ex = undefined; m.mc = undefined; m.inv = BF.trades.inv.create();
      if (kind === "merchant") m.mc = { stage: "at", trip: { id: "test", home: V.key, dest: "0,0" }, last: -1e9, cd: 99, nav: {} };
      m.position.set(x + 0.5, W.heightAt(x, z) + 1, z); m.vel.set(0, 0, 0); m.ai.route = null; m.ai.mode = "idle"; m.ai.t = 0;
      if (kind === "explorer") { BF.trades.inv.add(m.inv, BF.I.blank_map_1, 1); if (!BF.explorer.useBlank(m) || !BF.explorer.carried(m).some(c => !c.done)) return { kind, error: "no map to fill" }; }
      const x0 = m.position.x, z0 = m.position.z, d0 = Math.hypot(x0 - V.x, z0 - V.z);
      for (let T = 0; T < 25; T += 0.05) { BF.sky.setTime(0.01); BF.mobs.update(0.05); P.set(x0 + 4, m.position.y + 1, z0); }
      const d1 = Math.hypot(m.position.x - V.x, m.position.z - V.z), moved = Math.hypot(m.position.x - x0, m.position.z - z0);
      m.ex = saved.ex; m.mc = saved.mc; m.inv = saved.inv;
      return { kind, d0: Math.round(d0), d1: Math.round(d1), moved: +moved.toFixed(1) };
    }, kind);
    console.log(JSON.stringify(r));
    if (r.error) { console.log("FAIL " + kind + ": " + r.error); bad++; continue; }
    const homeward = r.d0 - r.d1;
    if (kind === "explorer without a map") { if (homeward < 20) { console.log("FAIL an explorer with nothing to do out there did not walk home (" + homeward + " blocks)"); bad++; } }
    else if (homeward > 15) {   // it wanders about where it is (walks of up to 8 blocks)
      console.log("FAIL the " + kind + " walked " + homeward + " blocks back towards its village before the working day"); bad++; }
  }
  console.log(bad ? "far-stay-out: " + bad + " failures" : "far-stay-out: ok");
};
