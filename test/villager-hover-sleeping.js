// Sleeping villager hover card (bug-058): a villager lying on its bed is picked by the crosshair on its body, where the model is, not
// by an upright box standing over its feet. Covers the hover card and the player's own mob ray (js/mobs.js raycast).
// node test/run.js /tmp/vhs test/villager-hover-sleeping.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const frames = n => pg.evaluate(k => new Promise(res => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  // lay a villager with a bed down on it, as js/mobs.js sleepPose does, and hold the game still
  const setup = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.child && m.bed && !m.bed.tent);
    if (!v) return null;
    window.__v = v;
    const b = v.bed, [fx, fz] = BF.DIRS[b.f];
    v.sleeping = true;
    v.position.set(b.x + 0.5 - fx * 0.5, b.y + 0.5625 + 0.22, b.z + 0.5 - fz * 0.5);
    v.model.rotation.order = "YXZ";
    v.model.rotation.set(-Math.PI / 2, Math.atan2(-fx, -fz), 0);
    v.root.updateMatrixWorld(true);
    BF.state.paused = true;
    // the model's real extent, for comparison with the ray box
    const bx = new THREE.Box3().setFromObject(v.model), c = bx.getCenter(new THREE.Vector3());
    // clear the room above the bed so the player can look straight down at it
    for (let dy = 1; dy <= 4; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) BF.world.setBlock(b.x + dx, b.y + dy, b.z + dz, 0);
    return { d: BF.DIRS[b.f], f: b.f, center: [c.x, c.y, c.z], min: bx.min.toArray(), max: bx.max.toArray(), feet: v.position.toArray(), h: v.height };
  });
  check(!!setup, "found a villager with a bed");
  if (!setup) { console.log("FAIL villager-hover-sleeping"); return; }
  console.log("model box", JSON.stringify(setup));
  const card = () => pg.evaluate(() => { const el = document.querySelector(".bfv-hover"); return !!el && getComputedStyle(el).display !== "none" && BF.villagerHover.shown() === window.__v; });
  // look from above (the player hovering 3 blocks over the point) straight down at a point; the mob ray and the hover card
  const lookDown = async (x, y, z) => {
    await pg.evaluate(([x, y, z]) => {
      BF.player.teleport(x, y + 3 - 1.62, z);
      BF.player.setLook(0, -Math.PI / 2 + 1e-4);
    }, [x, y, z]);
    await frames(4);
    const ray = await pg.evaluate(() => { const h = BF.mobs.raycast(BF.player.eyePos(), BF.player.lookDir(), 8); return !!h && h.mob === window.__v; });
    return { ray, card: await card() };
  };
  // the middle of the body, the chest and the head: all show the card
  const [cx, cy, cz] = setup.center, [fx, fz] = setup.d;
  for (const [k, name] of [[0, "middle of the body"], [0.3, "chest"], [-0.3, "legs"]]) {
    const r = await lookDown(cx + fx * k * setup.h, cy, cz + fz * k * setup.h);
    check(r.ray && r.card, `pointing at the ${name} picks the sleeping villager (ray ${r.ray}, card ${r.card})`);
  }
  await pg.screenshot({ path: out + '-body.png' });
  // a block beyond the head and beside the bed: nothing
  const head = await lookDown(setup.feet[0] + fx * (setup.h + 0.8), cy, setup.feet[2] + fz * (setup.h + 0.8));
  check(!head.ray && !head.card, "a block past the head picks nothing");
  const side = await lookDown(cx + (fx ? 0 : 1.2), cy, cz + (fz ? 0 : 1.2));
  check(!side.ray && !side.card, "beside the bed picks nothing");
  // the ray box fits the model: its ends within a few tenths of a block of the model's
  const box = await pg.evaluate(() => {
    const v = window.__v, b = v.bed, [fx, fz] = BF.DIRS[b.f], p = v.position;
    return { a: [p.x, p.z], b: [p.x + fx * v.height, p.z + fz * v.height] };
  });
  const lo = [Math.min(box.a[0], box.b[0]), Math.min(box.a[1], box.b[1])], hi = [Math.max(box.a[0], box.b[0]), Math.max(box.a[1], box.b[1])];
  const axis = fx ? 0 : 2, ai = fx ? 0 : 1;
  check(Math.abs(lo[ai] - setup.min[axis]) < 0.35 && Math.abs(hi[ai] - setup.max[axis]) < 0.35, `ray box along the bed ${lo[ai].toFixed(2)}..${hi[ai].toFixed(2)} matches the model ${setup.min[axis].toFixed(2)}..${setup.max[axis].toFixed(2)}`);
  // awake again: the upright box is back
  await pg.evaluate(() => { const v = window.__v; v.sleeping = false; });
  const up = await pg.evaluate(() => {
    const v = window.__v, p = v.position, e = { x: p.x + 3, y: p.y + v.height * 0.6, z: p.z }, h = BF.mobs.raycast(e, { x: -1, y: 0, z: 0 }, 8);
    return !!h && h.mob === v;
  });
  check(up, "an awake villager is still picked standing up");
  console.log(bad ? "FAIL villager-hover-sleeping" : "PASS villager-hover-sleeping");
};
