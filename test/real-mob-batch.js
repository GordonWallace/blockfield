// @ci baseline suite=world timeout=600
// One draw call per mob (js/mobview.js batchOf, Gordon 2026-11-13: 15 fps with the page thread busy, about half of the realistic look's
// draw calls were mobs' body parts). In both looks a mob's parts are one joined mesh, drawn once, its vertex shader moving each part by
// its matrix; the part meshes stay (animation, eyelids, held tools, tests) but off the camera's layer. Checks: one draw for a pig whose
// parts were 6, the joined mesh's bounds hold the posed parts, a hidden part (a shorn sheep's wool) is folded away, and the F3 screen
// shows the GPU and the frame's steps.
// node test/run.js /tmp/rmb test/real-mob-batch.js
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what, got) => { if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); };
  const frames = n => pg.evaluate(n => new Promise(res => { const f = () => (n-- > 0 ? requestAnimationFrame(f) : res()); f(); }), n);
  for (const look of ["blocks", "real"]) {
  if (look === "real") {
    await pg.evaluate(() => localStorage.setItem("bf.look", "real"));
    await pg.reload();
    await pg.waitForFunction(() => window.BF && BF.real && BF.real.on && BF.world && BF.world.chunks.size > 0 && !BF.preparing, null, { timeout: 180000 });
    await pg.waitForTimeout(3000);
  }
  console.log("-- the " + look + " look");
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  const spawned = await pg.evaluate(() => {
    const p = BF.player.position;
    window.__pig = BF.mobs.spawn("pig", p.x + 3.5, p.y, p.z + 0.5);
    window.__sheep = BF.mobs.spawn("sheep", p.x - 3.5, p.y, p.z + 0.5);
    return !!(window.__pig && window.__sheep);
  });
  check(spawned, "spawned a pig and a sheep");
  await pg.waitForFunction(() => BF.mobView.viewOf(window.__pig) && BF.mobView.viewOf(window.__sheep), null, { timeout: 30000 });
  await frames(4);
  const r = await pg.evaluate(() => {
    const v = BF.mobView.viewOf(window.__pig), parts = Object.values(v.meshes), B = v.batch;
    const cam = BF.camera.layers, drawnParts = parts.filter(m => m.layers.test(cam)).length;
    // the joined mesh's bounds in the world against the posed parts'
    v.root.updateMatrixWorld(true);
    const sph = B.geometry.boundingSphere.clone().applyMatrix4(B.matrixWorld), box = new THREE.Box3();
    for (const m of parts) box.expandByObject(m);
    const corners = [box.min, box.max].every(c => sph.distanceToPoint(c) <= 0.01);
    // a hidden part: zero scale
    const sv = BF.mobView.viewOf(window.__sheep), wool = sv.meshes.wool || sv.meshes.fleece, i = wool ? sv.partList.indexOf(wool) : -1;
    let folded = null;
    if (wool) { wool.visible = false; BF.mobView.render(0); folded = sv.batch.material.userData.parts.value[i].determinant() === 0; wool.visible = true; }
    return { batch: !!B, parts: parts.length, drawnParts, onCam: !!B && B.layers.test(cam), bfPart: !!(B && B.geometry.attributes.bfPart), corners, folded, wool: !!wool,
      real: !!(BF.real && BF.real.on), lit: !!(B && B.material.userData.cell === v.mat.userData.cell), col: !!(B && B.material.color === v.mat.color) };
  });
  check(r.batch && r.onCam && r.bfPart, "a mob has one joined mesh the camera draws", r);
  check(r.parts >= 6 && r.drawnParts === 0, "its " + r.parts + " part meshes are off the camera's layer", r.drawnParts);
  check(r.corners, "the joined mesh's bounds hold the posed parts");
  check(r.col, "the joined mesh shares the mob's colour (light, hurt flash)");
  if (r.real) check(r.lit, "the joined mesh shares the mob's cell light");
  if (r.wool) check(r.folded, "a hidden part is folded away");
  // draw calls: the two mobs cost two draws, not their parts
  const calls = await pg.evaluate(async () => {
    const R = BF.renderer, rbd = R.renderBufferDirect;
    const roots = [BF.mobView.viewOf(window.__pig).root, BF.mobView.viewOf(window.__sheep).root], blobs = roots.map(r => r.children.filter(c => c !== r.children[0]));
    for (const r of roots) r.traverse(o => { o.frustumCulled = false; });   // (wherever they stand in the view)
    let mob = 0;
    R.renderBufferDirect = function (c, s, g, m, o) {
      let p = o;
      while (p && !roots.includes(p)) p = p.parent;
      if (p && !blobs.some(b => b.includes(o))) mob++;   // (a mob's contact shadow, js/real/mobs.js, is its own draw)
      return rbd.apply(this, arguments);
    };
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    R.renderBufferDirect = rbd;
    for (const r of roots) r.traverse(o => { o.frustumCulled = true; });
    return mob;
  });
  check(calls === 4, "the mobs' bodies take one draw each (" + calls + " in two frames for two mobs)");
  // round two (2026-11-13): chunk meshes of a face share a material while the view is flat; a mob behind the camera has its model
  // hidden (and shown again in front); in the realistic look the contact shadows are one mesh
  const two = await pg.evaluate(async () => {
    const next = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const mats = new Set(), meshes = [];
    for (const c of BF.world.chunks.values()) for (const m of c.meshes || []) { meshes.push(m); mats.add(m.material); }
    const shared = meshes.every(m => m.material === m.userData.flat && m.material.userData.shared);
    const v = BF.mobView.viewOf(window.__pig), d = new THREE.Vector3(), p = BF.player.position;
    BF.camera.getWorldDirection(d); d.y = 0; d.normalize();
    const put = k => { const e = window.__pig; e.position.set(p.x + d.x * k, p.y, p.z + d.z * k); if (e.vel) e.vel.set(0, 0, 0); if (e.prev) { e.prev.x = e.position.x; e.prev.z = e.position.z; } };
    put(-12); await next(); await next();
    const behind = { vis: v.model.visible, culled: !!v.model.userData.culled, root: v.root.visible };
    put(6); await next(); await next();
    const front = { vis: v.model.visible, culled: !!v.model.userData.culled };
    const B = BF.real && BF.real.on ? BF.real.mobs.blobs : null;
    return { meshes: meshes.length, mats: mats.size, shared, behind, front, k: BF.view.state.k,
      blobs: B ? { mesh: !!(B.mesh && B.mesh.parent), drawn: B.drawn, perMob: BF.scene.children.filter(o => o.isGroup && o.children.some(c => c.isMesh && c.geometry.type === "PlaneGeometry")).length } : null };
  });
  check(two.k === 0 && two.shared && two.mats <= 8 && two.meshes >= 2 && two.mats < two.meshes, "flat view: " + two.meshes + " chunk meshes share " + two.mats + " materials");
  check(!two.behind.vis && two.behind.culled && two.behind.root, "a mob behind the camera has its model hidden", two.behind);
  check(two.front.vis && !two.front.culled, "and shown again in front of it", two.front);
  if (two.blobs) check(two.blobs.mesh && two.blobs.drawn >= 1 && two.blobs.perMob === 0, "the contact shadows are one mesh", two.blobs);
  await pg.keyboard.press("F3");
  await frames(70);
  await pg.waitForTimeout(1200);
  const f3 = await pg.evaluate(() => document.getElementById("debug").textContent);
  check(/\nGPU .+/.test(f3), "F3 names the GPU", (f3.match(/GPU .*/) || [""])[0]);
  check(/Frame ms: .*drawing \d/.test(f3), "F3 shows the frame's steps", (f3.match(/Frame ms: .*/) || [""])[0]);
  check(/\nDraws \d+: .*(ground|blocks) \d+/.test(f3) && /mobs \d+/.test(f3), "F3 counts the draw calls by kind", (f3.match(/Draws .*/) || [""])[0]);
  check(/\nChunks .* queued, view distance \d+\n/.test(f3), "F3 shows the view distance", (f3.match(/Chunks .*/) || [""])[0]);
  await pg.keyboard.press("F3");
  await frames(3);
  check(await pg.evaluate(() => !BF.drawTally.on && BF.drawTally.last === null), "the count stops when F3 closes");
  await pg.screenshot({ path: out + "-" + look + ".png" });
  }
  await pg.evaluate(() => localStorage.removeItem("bf.look"));
  if (fails) console.log("FAIL real-mob-batch: " + fails + " checks");
};
