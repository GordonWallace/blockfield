// @ci baseline suite=world timeout=480
// The realistic look's felled trees and items on the ground (js/real/fell.js, docs/REALISTIC_CONTRACT.md section 4): with the look
// off the module is not there. With it on, chopping a log of a tree makes its model fall (one falling tree, cut at the cut), hides
// the items the tree dropped until it has landed, and leaves the logs below the cut as a drawn stump (a flora record of kind 5 from
// the mesher, which the placer never sees) that goes when its last log is chopped. Items lying on natural ground are drawn on the
// smooth surface, and items fall through leaves (js/drops.js) instead of hanging in a crown.
// node test/run.js /tmp/rf test/real-fell.js
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what, got) => { if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + what + (got !== undefined ? ": " + JSON.stringify(got) : "")); };
  const errors = [];
  pg.on("pageerror", e => errors.push(e.message));
  pg.on("console", m => { if (m.type() === "error" && /BF\.real|shader|program/i.test(m.text())) errors.push(m.text()); });
  check(await pg.evaluate(() => !(BF.real && BF.real.on) && !(BF.real && BF.real.fell)), "look off by default: no felling module");

  await pg.evaluate(() => localStorage.setItem("bf.look", "real"));
  await pg.reload();
  await pg.waitForFunction(() => window.BF && BF.real && BF.real.on && BF.real.fell && BF.world && BF.world.meshedCount && BF.world.meshedCount() >= 30 && !BF.preparing, null, { timeout: 240000 });
  await pg.waitForTimeout(3000);
  await pg.evaluate(() => BF.player.start());

  // the nearest trees to the player
  const trees = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, F = BF.forester, out = [];
    for (let r = 2; r < 110 && out.length < 2; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
      if (!W.isLoaded(x, z)) continue;
      for (let y = 0; y < 120; y++) { const t = F.treeAt(x, y, z); if (t && t.logs.length >= 3) { out.push({ x, y, z, logs: t.logs.length }); break; } }
    }
    return out;
  });
  check(trees.length === 2, "two trees stand near the spawn", trees);
  if (trees.length < 2) return;
  const T = trees[0];
  await pg.evaluate(T => { BF.player.teleport(T.x - 5.5, T.y + 0.1, T.z + 0.5); BF.player.setLook(-Math.PI / 2, 0.2); }, T);
  await pg.waitForTimeout(2500);
  const before = await pg.evaluate(() => BF.real.fell.stats());
  check(before.trees > 0 && before.falls === 0 && before.stumps === 0, "trees are tracked, none falling, no stumps", before);

  // chop the second log
  const cut = await pg.evaluate(T => { const id = BF.world.getBlock(T.x, T.y + 1, T.z); return { id, r: BF.req.player("player.break", T.x + "," + (T.y + 1) + "," + T.z, { id, harvest: true }).result }; }, T);
  check(cut.r && cut.r.ok, "the log is chopped", cut);
  await pg.waitForFunction(() => BF.real.fell.stats().falls === 1, null, { timeout: 60000, polling: 100 }).catch(() => {});
  const during = await pg.evaluate(T => {
    const f = BF.real.fell, M = BF.client.world, fall = f._test.falls[0];
    let drops = 0, hidden = 0, shown = 0;
    for (const e of M.entities.values()) if (e.kind === "drop") { drops++; if (f.hides(e)) hidden++; const sp = BF.entityView.viewOf(e.n); if (sp && sp.visible) shown++; }
    const col = []; for (let y = T.y; y < T.y + T.logs; y++) col.push(BF.world.getBlock(T.x, y, T.z));
    return { st: f.stats(), drops, hidden, shown, col, cutAt: fall && fall.cut, parts: fall ? fall.root.children.length : 0, inScene: !!(fall && fall.root.parent === BF.scene),
      at: fall ? [fall.root.position.x, fall.root.position.y, fall.root.position.z] : null };
  }, T);
  check(during.st.falls === 1 && during.inScene && during.parts >= 2, "the tree is falling: its model is in the scene, cut off its stump", during.st);
  check(during.cutAt === 1 && during.at && during.at[0] === T.x + 0.5 && during.at[1] === T.y + 1 && during.at[2] === T.z + 0.5, "it turns about the cut, one log up", during.at);
  check(during.col[0] === cut.id && during.col.slice(1).every(b => b === 0), "the world: the log below the cut stays, the rest is gone", during.col);
  check(during.drops > 0 && during.hidden === during.drops, "its items are hidden while it comes down", { drops: during.drops, hidden: during.hidden });
  check(during.st.stumps === 1, "the log left standing is drawn as a stump", during.st);
  await pg.waitForTimeout(600);
  check(await pg.evaluate(() => { let n = 0; for (const e of BF.client.world.entities.values()) if (e.kind === "drop") { const sp = BF.entityView.viewOf(e.n); if (sp && sp.visible) n++; } return n; }) === 0, "no item of the tree is drawn yet");
  await pg.screenshot({ path: out + "-falling.png" });

  await pg.waitForFunction(() => BF.real.fell.stats().falls === 0, null, { timeout: 180000, polling: 250 }).catch(() => {});
  await pg.waitForTimeout(2500);   // (the items come to rest and their sprites settle on the surface)
  const after = await pg.evaluate(T => {
    const f = BF.real.fell, M = BF.client.world;
    let drops = 0, hidden = 0, shown = 0, logs = 0, off = 0, onGround = 0;
    for (const e of M.entities.values()) if (e.kind === "drop") {
      drops++; if (f.hides(e)) hidden++;
      const sp = BF.entityView.viewOf(e.n); if (sp && sp.visible) shown++;
      if (BF.items[e.item] && BF.items[e.item].name === "oak_log" || /_log$/.test((BF.items[e.item] || {}).name || "")) logs += e.count;
      // (only an item at rest on natural ground is drawn on the surface: one that came down on the stump lies on the stump's log)
      const under = (BF.blocks[BF.world.getBlock(Math.floor(e.x), Math.round(e.y) - 1, Math.floor(e.z))] || {}).name || "";
      const rests = Math.abs(e.y - Math.round(e.y)) < 0.02 && under && !/_log$/.test(under);
      const sy = rests ? f.surfaceY(e.x, e.y, e.z) : null; if (sy != null && sp) { off = Math.max(off, Math.abs(sp.position.y - sy)); onGround++; }
    }
    // the stump's cubes are not in the chunk's block mesh: the flora list holds a record of kind 5 instead, and the placer was not given it
    const c = BF.world.chunkAt(T.x, T.z);
    return { st: f.stats(), drops, hidden, shown, logs, off: +off.toFixed(2), onGround, meshes: c && c.meshes ? c.meshes.length : 0 };
  }, T);
  check(after.st.falls === 0 && after.st.felled === 1, "the fall ends and its model is gone", after.st);
  check(after.drops > 0 && after.hidden === 0 && after.shown === after.drops, "the items show once it has landed", after);
  check(after.logs === T.logs - 1, "the logs above the cut lie as items (" + (T.logs - 1) + ")", after.logs);
  check(after.onGround > 0 && after.off < 0.35, "items on natural ground are drawn on the smooth surface (bobbing within 0.35 of it)", after.off);
  check(after.st.stumps === 1, "the stump stays", after.st);
  await pg.screenshot({ path: out + "-landed.png" });

  // the stump's last log
  const st = await pg.evaluate(T => { const id = BF.world.getBlock(T.x, T.y, T.z); return BF.req.player("player.break", T.x + "," + T.y + "," + T.z, { id, harvest: true }).result; }, T);
  await pg.waitForFunction(() => BF.real.fell.stats().stumps === 0, null, { timeout: 60000, polling: 100 }).catch(() => {});
  const gone = await pg.evaluate(() => BF.real.fell.stats());
  check(st && st.ok && gone.stumps === 0 && gone.falls === 0, "chopping the stump removes it, and nothing falls", gone);

  // a log standing alone that carries something is a post, not a stump; a row of logs is a wall
  const post = await pg.evaluate(async T => {
    const W = BF.world, L = BF.B.oak_log, x = T.x + 3, z = T.z + 3;
    let y = T.y + 6; while (y > 0 && !BF.SOLID[W.getBlock(x, y - 1, z)]) y--;
    W.setBlock(x, y, z, L); W.setBlock(x, y + 1, z, BF.B.cobblestone);
    await new Promise(r => setTimeout(r, 1500));
    const a = BF.real.fell.stats().stumps;
    W.setBlock(x, y + 1, z, 0);
    await new Promise(r => setTimeout(r, 1500));
    const b = BF.real.fell.stats().stumps;
    W.setBlock(x, y, z, 0);
    await new Promise(r => setTimeout(r, 1500));
    return { a, b, c: BF.real.fell.stats().stumps };
  }, T);
  check(post.a === 0 && post.b === 1 && post.c === 0, "a log under a block stays a cube; alone on the ground it is a stump", post);

  // items fall through leaves: dropped over the second tree's crown they come to rest on the ground, not in the crown
  const leaf = await pg.evaluate(async T => {
    const W = BF.world, top = T.y + T.logs + 4, made = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { if (!dx && !dz) continue; made.push(BF.drops.spawn(BF.I.stick, 1, T.x + dx + 0.5, top, T.z + dz + 0.5, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 999 })); }
    let leaves = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = T.y; y < top; y++) if (/_leaves$/.test((BF.blocks[W.getBlock(T.x + dx, y, T.z + dz)] || {}).name || "")) leaves++;
    await new Promise(r => setTimeout(r, 6000));
    let onLeaves = 0, high = 0;
    for (const d of made) {
      if (!d) continue;
      const under = W.getBlock(Math.floor(d.pos.x), Math.floor(d.pos.y - 0.05), Math.floor(d.pos.z));
      if (/_leaves$/.test((BF.blocks[under] || {}).name || "")) onLeaves++;
      if (d.pos.y > T.y + 1.5) high++;
    }
    return { leaves, n: made.filter(Boolean).length, onLeaves, high };
  }, trees[1]);
  check(leaf.leaves > 10 && leaf.n === 24 && leaf.onLeaves === 0 && leaf.high === 0, "items dropped over a crown fall through its leaves to the ground", leaf);

  // cutting a model: the part above keeps no triangle below the cut, and the other way round
  const geo = await pg.evaluate(() => {
    const g = new THREE.CylinderGeometry(0.3, 0.4, 8, 8, 8); g.translate(0, 4, 0);
    const ring = { band: 0.7, reach: 1.6 }, up = BF.real.fell._test.cutGeo(g, 2, true, ring), down = BF.real.fell._test.cutGeo(g, 2, false, null);
    const span = h => { h.computeBoundingBox(); return [+h.boundingBox.min.y.toFixed(2), +h.boundingBox.max.y.toFixed(2), h.index.count]; };
    return { up: span(up), down: span(down), all: g.index.count, r: +ring.r.toFixed(2) };
  });
  check(geo.up[0] === 2 && geo.up[1] === 8 && geo.down[0] === 0 && geo.down[1] === 2 && geo.up[2] < geo.all && geo.down[2] < geo.up[2] && geo.r > 0.3 && geo.r < 0.42,
    "a model is cut level at the cut, with the trunk's radius there", geo);

  check(errors.length === 0, "no page or shader errors", errors.slice(0, 3));
  await pg.evaluate(() => localStorage.setItem("bf.look", "blocks"));
  console.log(fails ? "real-fell FAIL " + fails : "real-fell PASS");
};
