// @ci baseline suite=world timeout=300
// Wall torches (Gordon, 2026-11-13; js/mesher.js MODELS.torch, js/light.js torchPlace): a torch put on the side of a block is one of
// the four wall_torch_* blocks and is drawn leaning out from that wall with its foot against it. (The four blocks carry the model
// name "torch", and since chunk meshing moved to workers the lean was never drawn: they stood upright in mid-air.)
// Usage: node test/run.js /tmp/wt test/wall-torch.js
module.exports = async (pg) => {
  const ok = (what, c, d) => console.log((c ? "ok   " : "FAIL ") + what + (d !== undefined && !c ? " " + JSON.stringify(d) : ""));
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("creative"); BF.player.setFlying(true); BF.mobs.spawning = false; });
  await pg.waitForTimeout(1500);
  // the model: each wall torch's boxes lean away from its wall, the standing torch's do not
  const m = await pg.evaluate(() => {
    const boxes = id => BF.mesher.MODELS[BF.blocks[id].model](() => 0, 0, 0, 0, id);
    const out = { standing: boxes(BF.B.torch).map(b => b[9] || null), wall: [] };
    for (const n of ["north", "east", "south", "west"]) {
      const id = BF.B["wall_torch_" + n], f = BF.blocks[id].wallTorch.f, bx = boxes(id);
      // where the middle of the stick is, in 1/16 along the facing, at its foot and at its tip (0 = the wall, 16 = the far side)
      const at = y => 8 + bx[0][9].base + bx[0][9].k * y;
      out.wall.push({ n, dirs: bx.every(b => b[9] && b[9].dx === BF.DIRS[f][0] && b[9].dz === BF.DIRS[f][1]), foot: at(0), tip: at(10), glow: bx[1][8] });
    }
    return out;
  });
  ok("a standing torch is upright", m.standing.every(l => l === null), m.standing);
  ok("each wall torch leans the way it faces", m.wall.length === 4 && m.wall.every(w => w.dirs), m.wall);
  ok("its foot is against the wall and its flame out in the cell", m.wall.every(w => w.foot >= 1 && w.foot <= 2 && w.tip >= 4 && w.tip <= 8 && w.glow === 1), m.wall);
  // placing: a wall in the air, the player in front of it clicks its side, then its top; taking the wall away pops the torch
  const at = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y) + 8;
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy < 3; dy++) W.setBlock(x + dx, y + dy, z - 3, BF.B.cobblestone);
    W.setBlock(x, y - 1, z, BF.B.cobblestone);
    BF.player.teleport(x + 0.5, y + 0.01, z + 0.5);
    BF.inventory.setSlot(0, { id: BF.B.torch, count: 8 }); BF.inventory.select(0);
    return { x, y, z };
  });
  const click = async (tx, ty, tz) => {
    await pg.evaluate(([tx, ty, tz]) => {
      const e = BF.player.eyePos(), p = BF.player.position;
      const dx = tx - p.x, dy = ty - e.y, dz = tz - p.z;
      BF.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, [tx, ty, tz]);
    await pg.waitForTimeout(400);
    await pg.evaluate(() => BF.player.setMouse(false, true));
    await pg.waitForTimeout(300);
    await pg.evaluate(() => BF.player.setMouse(false, false));
    await pg.waitForTimeout(300);
  };
  const name = (x, y, z) => pg.evaluate(([x, y, z]) => BF.blocks[BF.world.getBlock(x, y, z)].name, [x, y, z]);
  await click(at.x + 0.5, at.y + 1.5, at.z - 2);                       // the wall's side, at eye height
  const side = await name(at.x, at.y + 1, at.z - 2);
  ok("clicking the side of a wall puts a wall torch on it, facing out", side === "wall_torch_south", side);
  await pg.evaluate(({ x, y, z }) => BF.world.setBlock(x, y + 1, z - 3, 0), at);
  await pg.waitForTimeout(300);
  const gone = await name(at.x, at.y + 1, at.z - 2);
  ok("it comes off when its wall is taken away", gone === "air", gone);
  await pg.evaluate(({ x, y, z }) => BF.world.setBlock(x, y - 1, z - 1, BF.B.cobblestone), at);
  await click(at.x + 0.5, at.y, at.z - 0.5);                           // the top of a floor block
  const top = await name(at.x, at.y, at.z - 1);
  ok("clicking the top of a block stands a torch on it", top === "torch", top);
};
