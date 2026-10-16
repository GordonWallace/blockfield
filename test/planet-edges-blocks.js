// @ci integration suite=items timeout=360
// Chests and furnaces used across a face edge on the planet (generator 4, r14-25 parity gap). The player's raycast reaches a block across
// an edge through the margin address; block entities are keyed by the canonical cell. At an edge of face 4 (no turn) and one that turns
// (face 0 to face 2), with real right and left clicks: a chest placed across the edge is the chest opened from its own face after
// walking over (one record, at the canonical cell, with what was put in it); a furnace opened across the edge is its canonical furnace;
// breaking the chest from across the edge spills its canonical record.
// node test/run.js /tmp/pw test/planet-edges-blocks.js
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); BF.player.gameMode = "creative"; BF.mobs.spawning = false; });
  await pg.waitForTimeout(2500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const click = button => pg.evaluate(button => {
    const cv = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const o = { bubbles: true, cancelable: true, clientX: innerWidth / 2, clientY: innerHeight / 2, button, buttons: button === 2 ? 2 : 1 };
    cv.dispatchEvent(new MouseEvent("mousedown", o));
    if (button === 2) cv.dispatchEvent(new MouseEvent("contextmenu", o));
    // a left click breaks in the frame loop while held: hold it a moment
    return new Promise(r => setTimeout(() => { window.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0 }))); r(); }, button === 0 ? 400 : 0));
  }, button);
  // look at point p (atlas coordinates in the player's own frame)
  const look = p => pg.evaluate(p => {
    const e = BF.player.eyePos(), tx = p[0] - e.x, ty = p[1] - e.y, tz = p[2] - e.z;
    BF.player.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz)));
  }, p);

  for (const [f, s] of [[4, 1], [0, 2]]) {
    const setup = await pg.evaluate(async ([f, s]) => {
      const P = BF.planet, N = P.N, W = BF.world, h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const at = (k, j) => {   // the atlas address (through face A's margin for k >= 0) of the cell k across the edge, j along it
        const o = (h[0] || h[1]) < 0 ? -1 - k : N + k, a = N / 2 + j;
        return h[0] ? P.atlas(f, o, a) : P.atlas(f, a, o);
      };
      window.__at = at;
      const sp = at(-4, 0);
      BF.player.spawn(sp.x + 0.5, Math.max(BF.worldgen.heightAt(sp.x, sp.z), BF.SEA) + 30, sp.z + 0.5);
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 250));
        let ok = true;
        for (const [k, j] of [[-8, -6], [-8, 6], [8, -6], [8, 6], [0, 0]]) { const a = at(k, j), c = W.chunkAt(a.x, a.z); if (!c || c.mesh === undefined) ok = false; }
        if (ok) break;
      }
      let top = BF.SEA;
      for (let k = -6; k <= 6; k++) for (let j = -4; j <= 4; j++) { const a = at(k, j); top = Math.max(top, W.heightAt(a.x, a.z)); }
      const y = top + 2;
      for (let k = -6; k <= 6; k++) for (let j = -4; j <= 4; j++) {
        const a = at(k, j);
        for (let yy = y - 1; yy < y + 12; yy++) { const want = yy === y - 1 ? BF.B.stone : 0; if (W.getBlock(a.x, yy, a.z) !== want) W.setBlock(a.x, yy, a.z, want); }
      }
      BF.inventory.clear();
      BF.inventory.setSlot(0, { id: BF.B.chest, count: 1 }); BF.inventory.setSlot(1, { id: BF.B.furnace, count: 1 });
      BF.inventory.select(0);
      const me = at(-3, 0);
      BF.player.teleport(me.x + 0.5, y + 0.01, me.z + 0.5);
      const e = P.EDGE[f][s], a1 = at(1, 0), c1 = P.canonCell(a1.x, a1.z, {});
      return { y, g: e.g, turn: e.turn, chestM: [a1.x, a1.z], chestC: [c1.x, c1.z], faceC: c1.f };
    }, [f, s]);
    const tag = `face ${f} edge ${s} (to face ${setup.g}, turn ${setup.turn})`;
    const y = setup.y, [mx, mz] = setup.chestM, [cx, cz] = setup.chestC;
    check(setup.faceC === setup.g && (mx !== cx || mz !== cz), `${tag}: the cell one past the edge is on face ${setup.g}, reached through face ${f}'s margin`);
    await pg.waitForTimeout(400);

    // place the chest across the edge: aim at the top of the floor there
    await look([mx + 0.5, y - 0.05, mz + 0.5]); await pg.waitForTimeout(150); await click(2); await pg.waitForTimeout(300);
    const placed = await pg.evaluate(([mx, mz, cx, cz, y]) => ({ m: BF.isChest(BF.world.getBlock(mx, y, mz)), c: BF.isChest(BF.world.getBlock(cx, y, cz)) }), [mx, mz, cx, cz, y]);
    check(placed.m && placed.c, `${tag}: a chest placed across the edge stands at its canonical cell ${JSON.stringify(placed)}`);

    // open it from across the edge, put something in, close
    await look([mx + 0.5, y + 0.5, mz + 0.5]); await pg.waitForTimeout(150); await click(2); await pg.waitForTimeout(300);
    const o1 = await pg.evaluate(([mx, mz, cx, cz, y]) => {
      const I = BF.inventory, r = { open: I.isOpen(), canon: !!I.chestState(cx, y, cz), margin: !!I.chestState(mx, y, mz) };
      I.chestAdd(cx, y, cz, BF.I.stick, 5); I.close();
      return r;
    }, [mx, mz, cx, cz, y]);
    check(o1.open && o1.canon && !o1.margin, `${tag}: opened from across the edge, it is the chest at its canonical cell ${JSON.stringify(o1)}`);

    // walk over to the chest's own face and open it from there
    await pg.evaluate(([y]) => { const a = window.__at(3, 0); BF.player.teleport(a.x + 0.5, y + 0.01, a.z + 0.5); }, [y]);
    await pg.waitForTimeout(600);
    const here = await pg.evaluate(() => { const p = BF.player.position; return { f: BF.planet.canon(p.x, p.z, {}).f, x: p.x, z: p.z }; });
    await look([cx + 0.5, y + 0.5, cz + 0.5]); await pg.waitForTimeout(150); await click(2); await pg.waitForTimeout(300);
    const o2 = await pg.evaluate(([mx, mz, cx, cz, y]) => {
      const I = BF.inventory, c = I.chestState(cx, y, cz);
      const r = { open: I.isOpen(), sticks: c ? c.slots.filter(Boolean).filter(st => st.id === BF.I.stick).reduce((n, st) => n + st.count, 0) : -1, margin: !!I.chestState(mx, y, mz) };
      I.close();
      return r;
    }, [mx, mz, cx, cz, y]);
    check(here.f === setup.g && o2.open && o2.sticks === 5 && !o2.margin, `${tag}: from face ${setup.g} it is the same chest, with the 5 sticks ${JSON.stringify({ face: here.f, ...o2 })}`);

    // back on face A: a furnace placed and opened across the edge is the canonical furnace
    await pg.evaluate(([y]) => { const a = window.__at(-3, 0); BF.player.teleport(a.x + 0.5, y + 0.01, a.z + 0.5); BF.inventory.select(1); }, [y]);
    await pg.waitForTimeout(600);
    const fm = await pg.evaluate(() => { const a = window.__at(1, 2), c = BF.planet.canonCell(a.x, a.z, {}); return [a.x, a.z, c.x, c.z]; });
    await look([fm[0] + 0.5, y - 0.05, fm[1] + 0.5]); await pg.waitForTimeout(150); await click(2); await pg.waitForTimeout(300);
    await look([fm[0] + 0.5, y + 0.5, fm[1] + 0.5]); await pg.waitForTimeout(150); await click(2); await pg.waitForTimeout(300);
    const fo = await pg.evaluate(([fm, y]) => {
      const I = BF.inventory, r = { block: BF.isFurnace(BF.world.getBlock(fm[2], y, fm[3])), open: I.isOpen(), canon: !!I.furnaceState(fm[2], y, fm[3]), margin: !!I.furnaceState(fm[0], y, fm[1]) };
      I.close();
      return r;
    }, [fm, y]);
    check(fo.block && fo.open && fo.canon && !fo.margin, `${tag}: a furnace placed and opened across the edge is the furnace at its canonical cell ${JSON.stringify(fo)}`);

    // break the chest from across the edge: its canonical record goes (its sticks spill)
    await look([mx + 0.5, y + 0.5, mz + 0.5]); await pg.waitForTimeout(150); await click(0); await pg.waitForTimeout(400);
    const br = await pg.evaluate(([mx, mz, cx, cz, y]) => ({ gone: !BF.isChest(BF.world.getBlock(cx, y, cz)), canon: !!BF.inventory.chestState(cx, y, cz), margin: !!BF.inventory.chestState(mx, y, mz) }), [mx, mz, cx, cz, y]);
    check(br.gone && !br.canon && !br.margin, `${tag}: breaking it from across the edge removes the canonical chest ${JSON.stringify(br)}`);
  }

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? `FAILED ${bad}` : "all ok");
};
