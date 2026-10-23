// @ci integration suite=village timeout=300
// Other block edits as requests (spec r15-19, js/blockreqs.js): NODE_PATH=$(npm root -g) node test/run.js /tmp/bro test/block-requests-other.js
// Scripted requesters (taken out of BF.mobs.list so their own AI sends nothing) ask in one tick's think, in the opposite of id order:
// - two villagers and one door: wanting the same state both succeed; wanting different states the lower id wins, the other is refused;
// - an explorer pitching a tent where a builder places a block: the lower id wins; the tent goes up whole or not at all, and the tent
//   item leaves the explorer's pack only when it does;
// - a zombie breaking a door while a villager shuts it: with the villager lower the door shuts and then breaks (one door drops); with
//   the zombie lower its break is refused (the door was open) and the villager shuts it;
// - villagers walking through a door open and shut it by request (no direct writes from js/mobs.js).
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

  const r = await pg.evaluate(() => {
    BF.state.paused = true;   // ticks by hand
    const W = BF.world, R = BF.req, P = BF.player.position, step = () => BF.simStep(BF.warp.TICK), res = {};
    const num = m => +String(m.id).slice(1);
    // mobs that exist (ids resolve) but don't run: out of the update list
    const spawn = (type, x, y, z) => { const m = BF.mobs.spawn(type, x, y, z); BF.mobs.list.splice(BF.mobs.list.indexOf(m), 1); return m; };
    const drop = ms => { for (const m of ms) { BF.mobs.list.push(m); BF.mobs.discard(m); } };
    // sends fn() during the next tick's think (after the mobs' update), then steps that tick
    const inThink = fn => { const up = BF.mobs.update; BF.mobs.update = function () { BF.mobs.update = up; const ret = up.apply(this, arguments); fn(); return ret; }; try { step(); } finally { BF.mobs.update = up; } };
    // a flat open patch: solid ground and air above, 6 x 6
    let gx = 0, gy = 0, gz = 0, found = false;
    for (let i = 0; i < 100 && !found; i++) {
      const x0 = Math.floor(P.x) - 30 + (i % 10) * 7, z0 = Math.floor(P.z) - 30 + Math.floor(i / 10) * 7, y0 = W.heightAt(x0, z0);
      let ok = W.isLoaded(x0 - 1, z0 - 1) && W.isLoaded(x0 + 6, z0 + 6) && y0 > BF.MIN_Y + 2 && Math.hypot(x0 + 2 - P.x, z0 + 2 - P.z) > 6;
      for (let dx = -1; dx < 6 && ok; dx++) for (let dz = -1; dz < 6 && ok; dz++) {
        const g = W.getBlock(x0 + dx, y0, z0 + dz);
        ok = W.heightAt(x0 + dx, z0 + dz) === y0 && BF.SOLID[g] && !BF.FLUID[g] && W.getBlock(x0 + dx, y0 + 1, z0 + dz) === 0 && W.getBlock(x0 + dx, y0 + 2, z0 + dz) === 0 && W.getBlock(x0 + dx, y0 + 3, z0 + dz) === 0;
      }
      if (ok) { gx = x0; gy = y0 + 1; gz = z0; found = true; }
    }
    res.site = [gx, gy, gz]; res.found = found;
    if (!found) return res;
    const putDoor = (x, y, z, open) => { W.setBlock(x, y, z, BF.doorId(0, 0, open)); W.setBlock(x, y + 1, z, BF.doorId(0, 1, open)); };
    const isOpen = (x, y, z) => { const b = BF.blocks[W.getBlock(x, y, z)]; return b && b.door ? !!b.door.open : null; };
    const dx = gx + 1, dz = gz + 1;

    // 1. two villagers, one door, one tick: same state, then opposite states (the higher id sends first)
    const a = spawn("villager", dx + 2.5, gy, dz + 0.5), b = spawn("villager", dx - 1.5, gy, dz + 0.5);
    res.ab = [a.id, b.id];
    putDoor(dx, gy, dz, false);
    const got = {};
    inThink(() => { for (const m of [b, a]) BF.blockReq.door(m, dx, gy + 1, dz, true).then(x => { got["same" + (m === a ? "A" : "B")] = x.ok; }); });
    res.same = { a: got.sameA, b: got.sameB, open: isOpen(dx, gy, dz) };
    putDoor(dx, gy, dz, false);
    inThink(() => { BF.blockReq.door(b, dx, gy, dz, false).then(x => { got.oppB = x; }); BF.blockReq.door(a, dx, gy, dz, true).then(x => { got.oppA = x; }); });
    res.opp = { a: got.oppA, b: got.oppB, open: isOpen(dx, gy, dz), upper: isOpen(dx, gy + 1, dz) };
    drop([a, b]);
    W.setBlock(dx, gy + 1, dz, 0); W.setBlock(dx, gy, dz, 0);   // out of the tent's way

    // 2. an explorer pitching a tent where a builder places a block, both orders
    const tentRun = explorerFirst => {
      const e0 = explorerFirst ? spawn("villager", gx + 4.5, gy, gz + 4.5) : null;
      const bd = spawn("villager", gx + 5.5, gy, gz + 4.5);
      const ex = e0 || spawn("villager", gx + 4.5, gy, gz + 4.5);
      ex.inv = BF.trades.inv.create(); BF.trades.inv.add(ex.inv, BF.I.tent, 1);
      const tx = gx + 1, tz = gz + 2, f = 1, cells = BF.tents.pitchCells(tx, gy, tz, f), c5 = cells[4];
      const o = {};
      inThink(() => {
        R.send("setBlock", c5.x + "," + c5.y + "," + c5.z, { id: BF.B.cobblestone, expect: 0 }, bd).then(x => { o.builder = x.ok; });
        BF.blockReq.cells(ex, cells, { take: [{ id: BF.I.tent, n: 1 }] }).then(x => { o.tent = x.ok; o.why = x.why; });
      });
      o.explorerLower = num(ex) < num(bd);
      o.tentCells = cells.filter(c => W.getBlock(c.x, c.y, c.z) === c.id).length;
      o.cobble = W.getBlock(c5.x, c5.y, c5.z) === BF.B.cobblestone;
      o.items = BF.trades.inv.count(ex.inv, BF.I.tent);
      for (const c of cells) W.setBlock(c.x, c.y, c.z, 0);   // clear for the next run
      drop([ex, bd]);
      return o;
    };
    res.tentFirst = tentRun(true);
    res.builderFirst = tentRun(false);

    // 3. a zombie breaking a door while a villager shuts it, both orders
    const doorItem = BF.rollDrops(BF.doorId(0, 0, false))[0].id;
    const doorDrops = () => BF.drops.list.filter(d => d.id === doorItem && Math.abs(d.pos.x - dx - 0.5) < 3 && Math.abs(d.pos.z - dz - 0.5) < 3).reduce((s, d) => s + d.count, 0);
    const breakRun = villagerFirst => {
      const v0 = villagerFirst ? spawn("villager", dx + 0.5, gy, dz + 2.5) : null;
      const z = spawn("zombie", dx + 0.5, gy, dz - 1.5);
      const v = v0 || spawn("villager", dx + 0.5, gy, dz + 2.5);
      for (const d of BF.drops.list.filter(d => d.id === doorItem)) d.count = 0;
      putDoor(dx, gy, dz, true);
      const o = { villagerLower: num(v) < num(z) };
      inThink(() => {
        R.send("doorBreak", dx + "," + gy + "," + dz, { expect: BF.doorId(0, 0, false) }, z).then(x => { o.brk = x.ok; });
        BF.blockReq.door(v, dx, gy, dz, false).then(x => { o.shut = x.ok; });
      });
      o.block = W.getBlock(dx, gy, dz); o.upper = W.getBlock(dx, gy + 1, dz); o.open = isOpen(dx, gy, dz);
      o.drops = doorDrops();
      drop([v, z]);
      return o;
    };
    res.villagerFirst = breakRun(true);
    res.zombieFirst = breakRun(false);

    // 4. a villager walking through a closed door: opened and shut by request, no direct writes from mobs.js
    W.setBlock(dx, gy, dz, 0); W.setBlock(dx, gy + 1, dz, 0);
    for (let x = gx - 1; x < gx + 6; x++) for (const y of [gy, gy + 1]) if (x !== dx) { W.setBlock(x, y, dz, BF.B.cobblestone); }
    putDoor(dx, gy, dz, false);
    const w = BF.mobs.spawn("villager", dx + 0.5, gy, dz - 2.5);
    const d0 = R.stats();
    const doorsBefore = (d0.byKind.door || { applied: 0 }).applied;
    const route = [[dx, gy, dz - 1], [dx, gy, dz], [dx, gy, dz + 1], [dx, gy, dz + 2], [dx, gy, dz + 3]];
    // js/mobs.js villagerDoors runs before the villager's AI each update: set its route and place before each tick
    const at = (z, ri) => { w.position.set(dx + 0.5, gy, z); w.vel.set(0, 0, 0); w.ai.route = route; w.ai.ri = ri; };
    at(dz - 0.5, 1); step();
    const wasOpen = isOpen(dx, gy, dz) === true;
    at(dz + 3.5, 4); step();
    const wasShutAfter = isOpen(dx, gy, dz) === false;
    const d1 = R.stats();
    res.walk = { wasOpen, wasShutAfter, doorReqs: (d1.byKind.door || { applied: 0 }).applied - doorsBefore, mobsDirect: (d1.direct.mobs || 0) - (d0.direct.mobs || 0), at: [w.position.x, w.position.z] };
    BF.mobs.discard(w);
    BF.state.paused = false;
    return res;
  });
  console.log(JSON.stringify(r));
  check(r.found, "found a flat patch (" + r.site + ")");
  if (!r.found) { console.log("FAILED: no site"); throw new Error("no site"); }
  check(r.same.a === true && r.same.b === true && r.same.open === true, "two villagers opening one door in the same tick both succeed: " + JSON.stringify(r.same));
  check(r.opp.a && r.opp.a.ok === true && r.opp.b && r.opp.b.ok === false && r.opp.b.why === "contended" && r.opp.open === true && r.opp.upper === true,
    "wanting opposite states, the lower id (" + r.ab[0] + ", open) wins though it sent second; the other is refused: " + JSON.stringify(r.opp));
  const tf = r.tentFirst, bf = r.builderFirst;
  check(tf.explorerLower && tf.tent === true && tf.builder === false && tf.tentCells === 12 && !tf.cobble && tf.items === 0,
    "explorer lower: the whole tent goes up, the builder is refused, the tent item is used: " + JSON.stringify(tf));
  check(!bf.explorerLower && bf.builder === true && bf.tent === false && bf.tentCells === 0 && bf.cobble && bf.items === 1,
    "builder lower: its block goes in, no tent cell is placed and the explorer keeps its tent: " + JSON.stringify(bf));
  const vf = r.villagerFirst, zf = r.zombieFirst;
  check(vf.villagerLower && vf.shut === true && vf.brk === true && vf.block === 0 && vf.upper === 0 && vf.drops === 1,
    "villager lower: the door shuts, then the zombie breaks it; one door drops: " + JSON.stringify(vf));
  check(!zf.villagerLower && zf.brk === false && zf.shut === true && zf.open === false && zf.drops === 0,
    "zombie lower: its break is refused (the door was open), the villager shuts it, nothing drops: " + JSON.stringify(zf));
  check(r.walk.wasOpen && r.walk.wasShutAfter && r.walk.doorReqs >= 2 && r.walk.mobsDirect === 0,
    "a villager walking through opens and shuts the door by request, with no direct writes from mobs.js: " + JSON.stringify(r.walk));
  await pg.screenshot({ path: out + "-end.png" });
  console.log(fails.length ? "FAILED " + fails.length + ": " + fails.join("; ") : "block-requests-other: all ok");
  if (fails.length) throw new Error(fails.join("; "));
};
