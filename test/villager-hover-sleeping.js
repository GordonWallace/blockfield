// @ci integration suite=ui hosts=worker,server
// Sleeping villager hover card (bug-058): a villager lying on its bed is picked by the crosshair on its body, where it is drawn, not
// by an upright box standing over its feet. Covers the hover card (the client's mirror, js/mobview.js rayBoxOf), the player's aim
// (BF.player.aimedMob: the mirror off-page, BF.mobs.raycast in the page) and BF.mobs.raycast where the simulation is.
// node test/run.js /tmp/vhs test/villager-hover-sleeping.js [--host page|worker|server]
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await lib.sim(pg, () => BF.sky.setTime(0.2));
  await lib.toVillage(pg);
  const frames = n => pg.evaluate(k => new Promise(res => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  // lay a villager with a bed down on it, as js/mobs.js sleepPose does, and hold the game still
  const setup = await lib.sim(pg, () => {
    BF.mobs.spawning = false;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.child && m.bed && !m.bed.tent);
    if (!v) return null;
    globalThis.__v = v;
    const b = v.bed, [fx, fz] = BF.DIRS[b.f];
    v.sleeping = true;
    v.position.set(b.x + 0.5 - fx * 0.5, b.y + 0.5625 + 0.22, b.z + 0.5 - fz * 0.5);
    if (v.vel) v.vel.set(0, 0, 0);
    BF.state.paused = true;
    if (BF.regions && BF.regions.tick) BF.regions.tick();   // file it in the region it now lies in, as the end of a step would (paused: no step runs)
    // clear the room above the bed so the player can look straight down at it
    for (let dy = 1; dy <= 4; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) BF.world.setBlock(b.x + dx, b.y + dy, b.z + dz, 0);
    if (BF.proto) BF.proto.flush();
    return { d: [fx, fz], feet: [v.position.x, v.position.y, v.position.z], h: v.height, id: BF.ids.idOf(v) };
  });
  check(!!setup, "found a villager with a bed");
  if (!setup) { console.log("FAIL villager-hover-sleeping"); return; }
  await pg.waitForTimeout(500); await frames(5);
  // the drawn model's extent (the page's view of the mirror entity)
  const model = await pg.evaluate(id => {
    const e = [...BF.client.world.entities.values()].find(e => e.sid === id);
    const v = e && BF.mobView.viewOf(e);
    if (!v) return null;
    v.root.updateMatrixWorld(true);
    const bx = new THREE.Box3().setFromObject(v.model), c = bx.getCenter(new THREE.Vector3());
    return { sleeping: !!e.sleeping, bedF: e.bedF, center: [c.x, c.y, c.z], min: bx.min.toArray(), max: bx.max.toArray() };
  }, setup.id);
  check(model && model.sleeping && model.bedF != null, "the mirror has the villager asleep on its bed " + JSON.stringify(model && { s: model.sleeping, f: model.bedF }));
  if (!model) { console.log("FAIL villager-hover-sleeping"); return; }
  const card = () => pg.evaluate(id => { const el = document.querySelector(".bfv-hover"), s = BF.villagerHover.shown(); return !!el && getComputedStyle(el).display !== "none" && !!s && s.sid === id; }, setup.id);
  // look from above (eyes 2.2 blocks over the point) straight down at it: the card, the player's aim and the simulation's ray
  const lookDown = async (x, y, z) => {
    await pg.evaluate(([x, y, z]) => { BF.player.teleport(x, y + 2.2 - 1.62, z); BF.player.setLook(0, -Math.PI / 2 + 1e-4); }, [x, y, z]);
    await frames(4);
    const eye = await pg.evaluate(() => { const e = BF.player.eyePos(), d = BF.player.lookDir(); return { e: [e.x, e.y, e.z], d: [d.x, d.y, d.z] }; });
    const aimed = await pg.evaluate(id => { const a = BF.player.aimedMob(); return !!a && a.id === id; }, setup.id);
    const ray = await lib.sim(pg, ({ e, d }) => { const h = BF.mobs.raycast({ x: e[0], y: e[1], z: e[2] }, { x: d[0], y: d[1], z: d[2] }, 8); return !!h && h.mob === globalThis.__v; }, eye);
    return { ray, aimed, card: await card() };
  };
  const [cx, cy, cz] = model.center, [fx, fz] = setup.d;
  for (const [k, name] of [[0, "middle of the body"], [0.3, "chest"], [-0.3, "legs"]]) {
    const r = await lookDown(cx + fx * k * setup.h, cy, cz + fz * k * setup.h);
    check(r.ray && r.aimed && r.card, `pointing at the ${name} picks the sleeping villager (ray ${r.ray}, aim ${r.aimed}, card ${r.card})`);
  }
  await pg.screenshot({ path: out + '-body.png' });
  const head = await lookDown(setup.feet[0] + fx * (setup.h + 0.8), cy, setup.feet[2] + fz * (setup.h + 0.8));
  check(!head.ray && !head.aimed && !head.card, "a block past the head picks nothing");
  const side = await lookDown(cx + (fx ? 0 : 1.2), cy, cz + (fz ? 0 : 1.2));
  check(!side.ray && !side.aimed && !side.card, "beside the bed picks nothing");
  // the ray box fits the drawn model: its ends within a few tenths of a block of the model's
  const a = fx ? 0 : 2, f0 = setup.feet[a], f1 = f0 + (fx || fz) * setup.h, lo = Math.min(f0, f1), hi = Math.max(f0, f1);
  check(Math.abs(lo - model.min[a]) < 0.35 && Math.abs(hi - model.max[a]) < 0.35, `ray box along the bed ${lo.toFixed(2)}..${hi.toFixed(2)} matches the model ${model.min[a].toFixed(2)}..${model.max[a].toFixed(2)}`);
  // awake again: the upright box is back
  const up = await lib.sim(pg, () => {
    const v = globalThis.__v; v.sleeping = false;
    const p = v.position, h = BF.mobs.raycast({ x: p.x + 3, y: p.y + v.height * 0.6, z: p.z }, { x: -1, y: 0, z: 0 }, 8);
    return !!h && h.mob === v;
  });
  check(up, "an awake villager is still picked standing up");
  await lib.sim(pg, () => { BF.state.paused = false; });
  console.log(bad ? "FAIL villager-hover-sleeping" : "PASS villager-hover-sleeping");
};
