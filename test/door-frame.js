// @ci integration suite=items
// bug-059: a door stands in a narrow frame (a 1/16 jamb of its wood's planks down each side, inside its own cell), so glass panes beside it
// meet the frame instead of leaving a gap and floating hinges; panes in line with the door reach across to it. The frame is drawn only:
// the collision box is unchanged, so the player and villagers still walk through an open door (and not a closed one).
// Usage: node test/run.js /tmp/df test/door-frame.js   (also saves <out>-door.png and <out>-door-open.png)
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const W = BF.world, B = BF.B;
    // 1. every door state: the leaf between two jambs, the collision box as before
    let bad = [];
    for (const b of BF.blocks) {
      if (!b || !b.door) continue;
      const jambs = b.boxes.filter(q => q.length > 6 && /planks$/.test(q[6]));
      const leaf = b.boxes.find(q => q.length <= 6);
      const thin = jambs.every(q => Math.min(q[3] - q[0], q[5] - q[2]) === 1 && q[4] - q[1] === 16 && Math.max(q[3] - q[0], q[5] - q[2]) === 16);
      const cb = b.box, wide = b.door.open ? Math.min(cb[3] - cb[0], cb[5] - cb[2]) === 3 : Math.max(cb[3] - cb[0], cb[5] - cb[2]) === 16;
      if (jambs.length !== 2 || !thin || !leaf || !wide || !(jambs[0][6] === (b.door.wood === "oak" ? "planks" : b.door.wood + "_planks"))) bad.push(b.name);
    }
    ok("every door state has two 1/16 jambs of its planks, a leaf, and the old collision box", bad.length === 0, bad.slice(0, 4));
    const d = BF.blocks[BF.doorId(2, 0, 0, "oak")], leaf = d.boxes.find(q => q.length <= 6);
    ok("the closed leaf fits between the jambs", leaf[0] === 1 && leaf[3] === 15, leaf);
    // 2. a wall with a door between two panes
    const P = BF.player, px = Math.floor(P.position.x) + 4, pz = Math.floor(P.position.z) + 4;
    for (let i = 0; i < 100; i++) W.update(px, pz, 8);
    const y = Math.max(W.heightAt(px, pz), 0) + 20, X = px, Z = pz;
    for (let x = X - 6; x <= X + 6; x++) for (let z = Z - 6; z <= Z + 6; z++) { W.setBlock(x, y - 1, z, B.stone); for (let k = 0; k < 4; k++) W.setBlock(x, y + k, z, 0); }
    for (let x = X - 3; x <= X + 3; x++) for (let k = 0; k < 3; k++) W.setBlock(x, y + k, Z, B.planks);
    W.setBlock(X, y, Z, BF.doorId(2, 0, 0, "oak")); W.setBlock(X, y + 1, Z, BF.doorId(2, 1, 0, "oak"));
    W.setBlock(X - 1, y + 1, Z, B.glass_pane); W.setBlock(X + 1, y + 1, Z, B.glass_pane);
    const get = (a, b, c) => W.getBlock(a, b, c);
    const arms = (x, yy, z) => BF.DYNBOXES[B.glass_pane](get, x, yy, z).map(q => q.map(v => Math.round(v * 16)));
    const L = arms(X - 1, y + 1, Z), Rr = arms(X + 1, y + 1, Z);
    ok("the pane west of the door reaches across to its frame", L.some(q => q[3] === 16 && q[2] === 7), L);
    ok("the pane east of the door reaches across to its frame", Rr.some(q => q[0] === 0 && q[2] === 7), Rr);
    W.setBlock(X, y + 1, Z + 1, B.glass_pane);
    const F = arms(X, y + 1, Z + 1);
    ok("a pane in front of the door does not join it", !F.some(q => q[2] === 0 && q[5] === 7) || F.length === 5, F);
    W.setBlock(X, y + 1, Z + 1, 0);
    // 3. walking through: the player
    const walk = (hw, h) => {
      const pos = { x: X + 0.5, y, z: Z - 1.5 }, vel = { x: 0, y: 0, z: 0 };
      for (let t = 0; t < 3; t += 0.05) { vel.x = 0; vel.z = 3; vel.y = Math.max(vel.y - 20 * 0.05, -10); W.moveBox(pos, vel, hw, h, 0.05, { stepUp: 0.6 }); }
      return +pos.z.toFixed(2);
    };
    ok("the player can't walk through the closed door", walk(0.3, 1.8) < Z + 1, walk(0.3, 1.8));
    W.setDoor(X, y, Z, true);
    ok("the player walks through the open door", walk(0.3, 1.8) > Z + 1.5, walk(0.3, 1.8));
    const vdef = BF.mobs.spawn("villager", X + 0.5, y, Z - 2.5, "farmer");
    ok("a villager's body walks through the open door", walk(vdef.halfWidth, vdef.height) > Z + 1.5, { hw: vdef.halfWidth, h: vdef.height, z: walk(vdef.halfWidth, vdef.height) });
    const N = BF.mobs.nav;
    const path = N.findPath(X, y, Z - 2, { x: X, z: Z + 2, at: (a, b, c) => a === X && c === Z + 2 }, 3000);
    ok("villagers plan a path through the door", !!path && path.some(p => (p.x != null ? p.x === X && p.z === Z : p[0] === X && p[2] === Z)), path && path.length);
    vdef.position.x += 60; vdef.position.y = W.heightAt(Math.floor(vdef.position.x), Math.floor(vdef.position.z)) + 1;   // out of the picture
    W.setDoor(X, y, Z, false);
    // a camera on the door for the screenshots
    P.spawn(X + 0.5, y, Z - 3.2);
    P.setLook(Math.PI, 0.05);
    R.at = [X, y, Z];
    return R;
  });
  for (const l of res.lines) console.log(l);
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.mobs.spawning = false; BF.sky.setTime && BF.sky.setTime(0.25); });
  await pg.evaluate(a => { BF.player.spawn(a[0] + 0.5, a[1], a[2] - 3.2); BF.player.setLook(Math.PI, 0.05); }, res.at);
  for (let i = 0; i < 20; i++) { await pg.evaluate(() => { BF.world.update(BF.player.position.x, BF.player.position.z, 8); }); await pg.waitForTimeout(100); }
  await pg.evaluate(() => BF.player.setLook(Math.PI, 0.05)); await pg.waitForTimeout(400);
  await pg.screenshot({ path: out + '-door.png' });
  await pg.evaluate(a => BF.world.setDoor(a[0], a[1], a[2], true), res.at);
  await pg.evaluate(() => BF.player.setLook(Math.PI, 0.05)); await pg.waitForTimeout(800);
  await pg.screenshot({ path: out + '-door-open.png' });
};
