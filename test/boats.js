// @ci baseline
// Boats (js/boats.js): recipes for every wood, placing on water, speeds on water, ice and land, no clipping into a wall at speed,
// falling down a river step but not climbing one, mob passengers, getting out, breaking, and saving with the player and a mob aboard.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/boats test/boats.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => { const l = (cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""); R.lines.push(l); console.warn(l); };
    const tick = () => new Promise(r => setTimeout(r, 10));
    const load = async (x, z) => {
      for (let i = 0; i < 600 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await tick(); }
      for (let i = 0; i < 600; i++) { BF.world.update(x, z, 8); await tick(); if (BF.world.queueLength === 0) break; }
    };
    const W = BF.world, B = BF.B, I = BF.I, P = BF.player, boats = BF.boats;
    const fresh = async mode => {
      BF.state.paused = true;
      BF.newWorld(5, { gen: 3, gameMode: mode || "survival" });
      BF.mobs.spawning = false;
      W.setViewDist(8);
      await load(8, 8);
    };
    const runBoats = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) { BF.mobs.update(h); boats.update(h); } };

    // ---- recipes ----
    const recipes = BF.inventory.recipes;
    for (const sp of BF.WOOD_SPECIES) {
      const id = I[sp + "_boat"], pl = I[sp === "oak" ? "planks" : sp + "_planks"];
      const r = recipes.find(r => r.out === id);
      ok("recipe: 5 " + sp + " planks in a U make a " + sp + " boat", !!r && r.type === "shaped" && r.n === 1 && r.pattern.join("|") === "P P|PPP" && r.key.P.length === 1 && r.key.P[0] === pl,
        r ? { pattern: r.pattern, key: r.key } : null);
    }
    ok("boats are one per stack", BF.WOOD_SPECIES.every(sp => BF.items[I[sp + "_boat"]].stack === 1));

    // ---- a test course high above the spawn: a long water channel, an ice strip, a stone strip ----
    await fresh();
    const x0 = 8, z0 = 8, y0 = BF.worldgen.heightAt(x0, z0) + 24;
    const fill = (xa, xb, y, za, zb, id) => { for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) W.setBlock(x, y, z, id); };
    const LEN = 150;
    fill(x0 - 2, x0 + 2, y0, z0 - LEN, z0 + 10, B.stone);            // floor
    fill(x0 - 2, x0 + 2, y0 + 1, z0 - LEN, z0 + 10, B.water);        // water channel
    for (const x of [x0 - 3, x0 + 3]) fill(x, x, y0 + 1, z0 - LEN, z0 + 10, B.stone);   // banks
    fill(x0 - 2, x0 + 2, y0 + 1, z0 - LEN - 1, z0 - LEN - 1, B.stone);   // a wall across the end
    fill(x0 - 2, x0 + 2, y0 + 2, z0 - LEN - 1, z0 - LEN - 1, B.stone);
    await load(x0, z0 - LEN / 2);

    // place on the water from the bank, looking down at it, facing north (yaw 0)
    P.teleport(x0 + 0.5, y0 + 3, z0 + 6.5);
    P.setLook(0, -1.2);
    const eye = P.eyePos(), dir = P.lookDir();
    const b = boats.placeFromPlayer("oak", eye, dir, 0, 6);
    ok("a boat goes down on the water", !!b && Math.abs(b.pos.y - (y0 + 1 + 0.889 - 0.15)) < 0.01, b && { y: b.pos.y, want: y0 + 1.739 });
    runBoats(3);
    ok("it floats at the surface", b.inWater && Math.abs(b.pos.y - (y0 + 1.739)) < 0.05, { y: b.pos.y, medium: b.medium });

    // row: the player gets in and rows north for 6 s
    ok("the player gets in", P.mount(b) && P.boat === b);
    let maxV = 0, inSolid = false;
    for (let t = 0; t < 6; t += 0.02) { P.ride(1, 0, 0.02); maxV = Math.max(maxV, Math.hypot(b.vel.x, b.vel.z)); if (W.boxCollides(b.pos.x, b.pos.y, b.pos.z, boats.HW, 0.5)) inSolid = true; }
    ok("top speed on water is about 8 blocks a second", maxV > 7.2 && maxV < 8.6, { maxV });
    const eyeY = P.eyePos().y;
    ok("the player sits in the seat, eye just above the hull", Math.abs(P.position.x - b.pos.x) < 0.01 && Math.abs(P.position.y - b.pos.y) < 0.01, { p: P.position, b: b.pos, eyeY });
    // turning: A turns the boat left (yaw up) and the view with it
    const yawB = b.yaw, yawP = P.yaw;
    for (let t = 0; t < 0.5; t += 0.02) P.ride(1, 1, 0.02);
    ok("A turns the boat left, the view turns with it", b.yaw > yawB + 0.5 && Math.abs((P.yaw - yawP) - (b.yaw - yawB)) < 1e-6, { boat: b.yaw - yawB, view: P.yaw - yawP });
    for (let t = 0; t < 0.5; t += 0.02) P.ride(1, -1, 0.02);
    // full speed into the wall at the end: it stops at the wall, never inside it
    for (let t = 0; t < 30 && b.pos.z > z0 - LEN + 2; t += 0.02) { P.ride(1, (b.yaw > 0.02 ? -1 : b.yaw < -0.02 ? 1 : 0), 0.02); if (W.boxCollides(b.pos.x, b.pos.y, b.pos.z, boats.HW, 0.5)) inSolid = true; }
    for (let t = 0; t < 2; t += 0.02) { P.ride(1, 0, 0.02); if (W.boxCollides(b.pos.x, b.pos.y, b.pos.z, boats.HW, 1.5)) inSolid = true; }
    ok("crashing into the wall at speed: stops at it, never inside a block, boat intact", !inSolid && b.pos.z - boats.HW >= z0 - LEN - 0.01 && boats.list.includes(b), { z: b.pos.z, wall: z0 - LEN });

    // get out with Shift: onto the bank or into the water, never inside a block
    P.dismount();
    const pp = P.position;
    ok("Shift: out of the boat, not inside a block", !P.boat && !b.rider && !W.boxCollides(pp.x, pp.y, pp.z, 0.3, 1.8), { p: [pp.x, pp.y, pp.z] });

    // ---- ice: about 40 blocks a second ----
    const xi = x0 + 20;
    fill(xi - 2, xi + 2, y0, z0 - LEN, z0 + 10, B.stone);
    fill(xi - 2, xi + 2, y0 + 1, z0 - LEN, z0 + 10, B.ice);
    const bi = boats.spawn("spruce", xi + 0.5, y0 + 2, z0 + 8.5, 0);
    runBoats(1);
    ok("a boat on ice sits on it", bi.onGround && Math.abs(bi.pos.y - (y0 + 2)) < 0.01, { y: bi.pos.y, medium: bi.medium });
    P.teleport(xi + 0.5, y0 + 3, z0 + 8.5);
    P.mount(bi);
    let vIce = 0;
    for (let t = 0; t < 20 && bi.pos.z > z0 - LEN + 6; t += 0.02) { P.ride(1, 0, 0.02); vIce = Math.max(vIce, Math.hypot(bi.vel.x, bi.vel.z)); }
    ok("speed on ice climbs towards 40 blocks a second", vIce > 25 && vIce <= 40.01 && bi.medium === "ice", { vIce, travelled: z0 + 8.5 - bi.pos.z });
    P.dismount();

    // ---- land: slides slowly ----
    const xl = x0 + 30;
    fill(xl - 2, xl + 2, y0, z0 - 20, z0 + 10, B.stone);
    const bl = boats.spawn("birch", xl + 0.5, y0 + 1, z0 + 5.5, 0);
    P.teleport(xl + 0.5, y0 + 2, z0 + 5.5);
    P.mount(bl);
    let vLand = 0;
    for (let t = 0; t < 3; t += 0.02) { P.ride(1, 0, 0.02); vLand = Math.max(vLand, Math.hypot(bl.vel.x, bl.vel.z)); }
    ok("on land a boat only slides slowly", vLand > 0.1 && vLand < 1, { vLand, medium: bl.medium });
    P.dismount();

    // ---- river step: down it goes, up it doesn't ----
    const xs = x0 + 40, zs = z0 - 40;   // upper pool z in [zs-12, zs-1] at y0+2, lower pool z in [zs, zs+12] at y0+1
    fill(xs - 3, xs + 3, y0, zs - 13, zs + 13, B.stone);
    fill(xs - 3, xs + 3, y0 + 1, zs - 13, zs - 1, B.stone);
    fill(xs - 2, xs + 2, y0 + 2, zs - 12, zs - 1, B.water);
    fill(xs - 2, xs + 2, y0 + 1, zs, zs + 12, B.water);
    for (const x of [xs - 3, xs + 3]) { fill(x, x, y0 + 1, zs - 13, zs + 13, B.stone); fill(x, x, y0 + 2, zs - 13, zs + 13, B.stone); }
    runBoats(1);
    for (const z of [zs - 13, zs + 13]) { fill(xs - 3, xs + 3, y0 + 1, z, z, B.stone); fill(xs - 3, xs + 3, y0 + 2, z, z, B.stone); fill(xs - 3, xs + 3, y0 + 3, z, z, B.stone); }   // end walls
    const bd = boats.spawn("jungle", xs + 0.5, y0 + 2.739, zs - 8.5, Math.PI);   // facing south, downstream
    P.teleport(xs + 0.5, y0 + 4, zs - 8.5); P.mount(bd);
    for (let t = 0; t < 1.6; t += 0.02) P.ride(1, 0, 0.02);
    for (let t = 0; t < 2; t += 0.02) P.ride(0, 0, 0.02);
    ok("going downstream: over the step onto the lower water", bd.pos.z > zs + 0.7 && Math.abs(bd.pos.y - (y0 + 1.739)) < 0.1 && bd.inWater, { z: bd.pos.z, y: bd.pos.y, step: zs });
    bd.pos.z = zs + 8.5; bd.vel.set(0, 0, 0); bd.yaw = 0;   // turn round in the lower pool and row hard upstream
    for (let t = 0; t < 6; t += 0.02) P.ride(1, 0, 0.02);
    ok("going upstream: the step stops it", bd.pos.z - boats.HW > zs - 0.01 && Math.abs(bd.pos.y - (y0 + 1.739)) < 0.1, { z: bd.pos.z, y: bd.pos.y, step: zs });
    P.dismount();

    // ---- a mob that walks into a boat gets in; hitting the boat lets it out ----
    const bm = boats.spawn("acacia", x0 + 0.5, y0 + 1.739, z0 - 20.5, 0);
    const pig = BF.mobs.spawn("pig", x0 + 0.5, y0 + 1.8, z0 - 20.5);
    runBoats(0.5);
    ok("a pig in the boat's way gets in", bm.mob === pig && pig.riding === bm, { mob: bm.mob && bm.mob.type });
    runBoats(2);
    ok("it stays seated", Math.hypot(pig.position.x - bm.pos.x, pig.position.z - bm.pos.z) < 0.01, { pig: pig.position, boat: bm.pos });
    ok("hitting the boat lets it out, the boat is fine", boats.hit(bm, false) === "out" && !bm.mob && !pig.riding && boats.list.includes(bm));
    runBoats(1);
    ok("a let-out mob doesn't hop straight back in", !bm.mob);
    // the player and a mob together
    P.teleport(x0 + 0.5, y0 + 3, z0 - 20.5);
    P.mount(bm);
    pig.position.set(bm.pos.x, bm.pos.y + 0.1, bm.pos.z); pig.boatCd = 0;
    runBoats(0.2);
    const ps = boats.seatOf(bm, "player"), ms = boats.seatOf(bm, "mob");
    ok("a boat carries the player and one mob, one in front of the other", bm.mob === pig && P.boat === bm && Math.hypot(ps.x - ms.x, ps.z - ms.z) > 0.7, { ps, ms });
    const cow = BF.mobs.spawn("cow", x0 + 0.5, y0 + 1.8, z0 - 20.5);
    runBoats(0.3);
    ok("a second mob doesn't fit", bm.mob === pig && !cow.riding);

    // ---- saving: the player and the pig aboard ----
    const saved = JSON.parse(JSON.stringify(boats.serialize()));
    const row = saved.find(e => e[0] === "acacia");
    ok("the save has every boat with wood, place, facing, the player and the passenger", saved.length === boats.list.length && row && row[5] === 1 && row[6] && row[6].type === "pig", row);
    const where = { x: bm.pos.x, y: bm.pos.y, z: bm.pos.z, yaw: bm.yaw };
    await fresh();
    for (let z = z0 - 25; z <= z0 - 15; z++) for (let x = x0 - 2; x <= x0 + 2; x++) { W.setBlock(x, y0, z, B.stone); W.setBlock(x, y0 + 1, z, B.water); }
    ok("a new world has no boats", boats.list.length === 0);
    boats.deserialize(saved);
    const nb = boats.list.find(e => e.wood === "acacia");
    ok("loaded: boats back where they were, the player in theirs", boats.list.length === saved.length && nb && Math.abs(nb.pos.x - where.x) < 0.01 && Math.abs(nb.yaw - where.yaw) < 0.01 && P.boat === nb && nb.rider, nb && { pos: nb.pos, yaw: nb.yaw });
    runBoats(0.5);
    ok("loaded: the pig is back in its seat", nb.mob && nb.mob.type === "pig" && nb.mob.riding === nb, nb.mob && nb.mob.type);
    ok("old saves: no boats, no error", (() => { try { boats.deserialize(undefined); return true; } catch (_) { return false; } })());

    // ---- breaking: three quick hits drop the boat item; one hit in creative, no item ----
    P.dismount();
    runBoats(0.2);
    nb.mob && boats.hit(nb, false);
    const before = BF.drops.list.length;
    const r1 = boats.hit(nb, false), r2 = boats.hit(nb, false), r3 = boats.hit(nb, false);
    const dropped = BF.drops.list.slice(before).map(d => BF.items[d.id].name);
    ok("three hits break it into an acacia boat item", r1 === "hit" && r2 === "hit" && r3 === "broken" && !boats.list.includes(nb) && dropped.includes("acacia_boat"), { r1, r2, r3, dropped });
    const bc = boats.spawn("cherry", x0 + 0.5, y0 + 1.739, z0 - 18.5, 0), n0 = BF.drops.list.length;
    ok("creative: one hit, no item", boats.hit(bc, true) === "broken" && !boats.list.includes(bc) && BF.drops.list.length === n0);

    // ---- the real save, through IndexedDB ----
    const meta = await BF.save.create({ name: "boats", seed: 5, gameMode: "survival" });
    BF.mobs.spawning = false;
    W.setViewDist(8);
    await load(x0, z0 - 20);
    for (let z = z0 - 25; z <= z0 - 15; z++) for (let x = x0 - 2; x <= x0 + 2; x++) { W.setBlock(x, y0, z, B.stone); W.setBlock(x, y0 + 1, z, B.water); }
    const sb = boats.spawn("dark_oak", x0 + 0.5, y0 + 1.739, z0 - 20.5, 1.2);
    P.teleport(x0 + 0.5, y0 + 3, z0 - 20.5); P.mount(sb);
    await BF.save.saveNow();
    boats.clear();
    await BF.save.load(meta.id);
    const lb = boats.list.find(e => e.wood === "dark_oak");
    ok("saved and loaded through IndexedDB with the player aboard", !!lb && P.boat === lb && Math.abs(lb.yaw - 1.2) < 0.01, lb && { pos: lb.pos, yaw: lb.yaw });
    await BF.save.remove(meta.id);
    R.counts = boats.counts();
    return R;
  });
  for (const l of res.lines) console.log(l);
  console.log("boat counts (debug screen):", JSON.stringify(res.counts));
  const fails = res.lines.filter(l => l.startsWith("FAIL")).length;
  console.log(fails ? "boats FAIL " + fails : "boats PASS");
};
