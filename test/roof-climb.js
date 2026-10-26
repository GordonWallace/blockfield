// @ci integration suite=village
// Roofs (bug-063, bug-064): node test/run.js /tmp/roof test/roof-climb.js
// Villagers and horses used to climb onto village roofs: up a hay bale onto a low eave, or straight across from a hillside level with the
// roof. On a test floor, a villager, a horse and a cow walk towards an eave from a hay bale, then from a hill of dirt
// level with a roof; none of them may end up on the roof. A two-high stack of hay (solid to the ground) is no roof: they may still climb it.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); });
  await require('./lib').toVillage(pg);
  const A = await pg.evaluate(() => {
    const V = BF.mobs.villages.values().next().value;
    if (!V) return null;
    const X0 = Math.floor(V.x) + 60, Z0 = Math.floor(V.z) - 12;
    BF.player.position.set(X0 + 10, BF.player.position.y, Z0 + 10);
    return { X0, Z0 };
  });
  for (let i = 0; A && i < 90; i++) {
    if (await pg.evaluate(A => [[-4, -4], [-4, 24], [24, -4], [24, 24]].every(([x, z]) => BF.world.isLoaded(A.X0 + x, A.Z0 + z)), A)) break;
    await pg.waitForTimeout(1000);
  }
  let bad = 0;
  for (const kind of ["villager", "horse", "cow"]) for (const scene of ["hay", "hill", "stack"]) {
    const r = await pg.evaluate(([kind, scene, A]) => {
      const W = BF.world, P = BF.player.position, B = BF.B, { X0, Z0 } = A;
      if (!W.isLoaded(X0 - 4, Z0 - 4) || !W.isLoaded(X0 + 24, Z0 + 24)) return { error: "test floor not loaded" };
      const N = 20;
      let Y0 = -1e9;
      for (let x = -2; x < N + 2; x++) for (let z = -2; z < N + 2; z++) Y0 = Math.max(Y0, BF.worldgen.heightAt(X0 + x, Z0 + z) + 1);
      // a stone floor on the natural ground (filled in solid down to it, as the roof rule measures from the natural ground), walled in
      for (let x = -2; x < N + 2; x++) for (let z = -2; z < N + 2; z++) {
        const g = BF.worldgen.heightAt(X0 + x, Z0 + z), wall = x < 0 || z < 0 || x >= N || z >= N;
        for (let y = g + 1; y < Y0 + 14; y++) W.setBlock(X0 + x, y, Z0 + z, y <= Y0 - 1 || (wall && y < Y0 + 6) ? B.stone : 0);
      }
      let start, roofX;
      if (scene === "hay") {   // a hay bale on the floor, an eave one higher beside it with nothing under it (x >= 8)
        for (let z = 4; z <= 14; z++) { W.setBlock(X0 + 7, Y0, Z0 + z, B.hay_bale); for (let x = 8; x <= 14; x++) W.setBlock(X0 + x, Y0 + 1, Z0 + z, B.planks); }
        start = [X0 + 7.5, Y0 + 1, Z0 + 9.5]; roofX = X0 + 8;
      } else if (scene === "hill") {   // two blocks of dirt (x < 8), a roof level with its top beside it (x >= 8), room under the roof
        for (let z = 4; z <= 14; z++) { for (let x = 2; x < 8; x++) { W.setBlock(X0 + x, Y0, Z0 + z, B.dirt); W.setBlock(X0 + x, Y0 + 1, Z0 + z, B.grass); } for (let x = 8; x <= 14; x++) W.setBlock(X0 + x, Y0 + 1, Z0 + z, B.planks); }
        start = [X0 + 5.5, Y0 + 2, Z0 + 9.5]; roofX = X0 + 8;
      } else {   // hay two high, solid to the floor: not a roof
        for (let z = 4; z <= 14; z++) { W.setBlock(X0 + 7, Y0, Z0 + z, B.hay_bale); for (let x = 8; x <= 14; x++) { W.setBlock(X0 + x, Y0, Z0 + z, B.hay_bale); W.setBlock(X0 + x, Y0 + 1, Z0 + z, B.hay_bale); } }
        start = [X0 + 7.5, Y0 + 1, Z0 + 9.5]; roofX = X0 + 8;
      }
      const m = kind === "horse" ? BF.horses.spawn(start[0], start[1], start[2]) : BF.mobs.spawn(kind, start[0], start[1], start[2]);
      if (!m) return { error: "no " + kind };
      m.position.set(start[0], start[1], start[2]); m.vel.set(0, 0, 0);
      let T = 0, up = false, maxX = -1e9;
      for (; T < 25; T += 0.05) {
        m.ai.mode = "walk"; m.ai.tx = X0 + 16.5; m.ai.tz = Z0 + 9.5; m.ai.t = 5; m.ai.target = false; m.ai.detour = null;
        BF.sky.setTime(0.1); BF.mobs.update(0.05); BF.req.apply(); BF.req.deliver(); P.set(X0 + 10, Y0 + 15, Z0 + 10);
        maxX = Math.max(maxX, m.position.x);
        if (m.position.x >= roofX + 0.2 && m.position.y >= Y0 + 2 - 0.01 && m.onGround) up = true;
      }
      const res = { kind, scene, up, maxX: +(maxX - X0).toFixed(2), at: [m.position.x - X0, m.position.y - Y0, m.position.z - Z0].map(v => +v.toFixed(2)) };
      m.position.set(X0 - 50, -500, Z0); m.dead = true;   // out of the way of the next one
      return res;
    }, [kind, scene, A]);
    console.log(JSON.stringify(r));
    if (r.error) { console.log("FAIL " + r.error); bad++; continue; }
    if (scene !== "stack" && r.up) { console.log("FAIL " + kind + " got onto the roof (" + scene + ")"); bad++; }
    if (scene === "stack" && !r.up) { console.log("FAIL " + kind + " did not climb a two-high hay stack (no roof)"); bad++; }
  }
  console.log(bad ? "roof-climb: " + bad + " failures" : "roof-climb: ok");
};
