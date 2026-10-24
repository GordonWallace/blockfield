// @ci integration hosts=worker,server
// Player archery: NODE_PATH=$(npm root -g) node test/run.js /tmp/arch test/archery-actions.js
// Draw strength -> power and damage (short tap vs full draw), arrows hitting a mob, 1 arrow per shot (none in creative), 1 bow use per
// shot, arrows sticking in a block and picked up again by walking over them (a creative arrow gives nothing back, stuck ones despawn
// after 60 s), a shot villager angering its village's golems, and drawing with the right and the middle button (Ubuntu trackpads).
// On every host (spec r15-43): the game is paused (the simulation pauses with the page) and stepped by hand. The page's player draws and
// fires (each shot a player.shoot request); the arrows, mobs and items are stepped and read where the simulation is.
module.exports = async (pg, out) => {
  const lib = require('./lib');
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; });
  await lib.sim(pg, () => { BF.mobs.spawning = false; });
  await lib.toVillage(pg);
  // the range below (the pad, x -3..24 and z -4..4 from the player, with the wall at x 24) is built and shot at by hand, so its chunks
  // must be loaded first: the planet's chunks may still be streaming in, and an unloaded chunk counts as solid (an arrow sticks at its
  // edge, and the wall placed in it is lost)
  for (let t0 = Date.now(); Date.now() - t0 < 120000; await pg.waitForTimeout(200)) {
    if (await lib.sim(pg, () => {
      const W = BF.world, p = BF.player.position, x0 = Math.floor(p.x), z0 = Math.floor(p.z);
      for (let dx = -3; dx <= 24; dx++) for (let dz = -4; dz <= 4; dz++) if (!W.isLoaded(x0 + dx, z0 + dz)) return false;
      return true;
    })) break;
  }
  const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  // a round trip: requests and queries are answered in order, so what was sent before has been applied (and its self is in)
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query("stats", {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const sim = (fn, arg) => lib.sim(pg, fn, arg);

  // a stone pad high above the village, open sky, a stone wall at the far end; mobs pinned in place every step (globalThis.__arch.pins)
  const o = await sim(() => {
    const P = BF.player, M = BF.mobs, W = BF.world;
    BF.state.paused = true;
    P.invulnerable = true;
    BF.sky.setTime(0.25);
    for (const m of M.list.slice()) if (m.hostile) M.kill(m);
    const pp = P.position, x0 = Math.floor(pp.x), z0 = Math.floor(pp.z), y0 = Math.floor(W.heightAt(x0, z0)) + 12;
    for (let dx = -3; dx <= 24; dx++) for (let dz = -4; dz <= 4; dz++) { W.setBlock(x0 + dx, y0 - 1, z0 + dz, BF.B.stone); for (let k = 0; k < 8; k++) W.setBlock(x0 + dx, y0 + k, z0 + dz, dx === 24 ? BF.B.stone : 0); }
    const A = globalThis.__arch = { x0, y0, z0, pins: [], hits: [] };
    BF.on("arrowHitMob", (m, dmg, crit) => { if (globalThis.__arch) globalThis.__arch.hits.push({ type: m.type, dmg, crit }); });
    BF.proto.flush();
    return { x0, y0, z0 };
  });
  await pg.evaluate(o => { window.__archAt = o; BF.state.paused = true; BF.player.invulnerable = true; }, o);   // (the frame loop leaves the player alone)
  await settle(); await pg.waitForTimeout(500); await settle();
  const { x0, y0, z0 } = o;
  // the simulation's step: pins, then the mobs (arrows among them)
  const step = (n = 1) => sim(n => { const A = globalThis.__arch, M = BF.mobs; for (let i = 0; i < n; i++) { for (const [m, x, y, z] of A.pins) { m.position.set(x, y, z); m.vel.set(0, 0, 0); if (m.ai) m.ai.fleeT = 0; } M.update(0.05); } }, n);
  // the page's player: home on the pad, aimed at a point (offsets from the pad's corner), a draw held for sec then released
  const home = async () => { await pg.evaluate(() => { const A = window.__archAt, P = BF.player; P.teleport(A.x0 + 0.5, A.y0 + 0.01, A.z0 + 0.5); for (let i = 0; i < 4; i++) P.update(0.05); }); await settle(); };
  const aim = (dx, dy, dz) => pg.evaluate(([dx, dy, dz]) => { const A = window.__archAt, P = BF.player, e = P.eyePos(), tx = A.x0 + dx - e.x, ty = A.y0 + dy - e.y, tz = A.z0 + dz - e.z; P.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz))); }, [dx, dy, dz]);
  const shoot = async sec => {
    const r = await pg.evaluate(sec => {
      const P = BF.player;
      P.lastShot = null;
      P.setMouse(false, true);
      for (let i = 0; i < Math.round(sec / 0.05); i++) P.update(0.05);
      const held = { stage: P.bow.stage, vm: P.viewModel(), fov: BF.camera.fov };
      P.setMouse(false, false); P.update(0.05);
      return Object.assign(held, { shot: P.lastShot });
    }, sec);
    await settle();
    return r;
  };
  const kit = async (arrows = 16) => {
    await sim(a => { const inv = BF.inventory; inv.clear(); inv.setSlot(0, { id: BF.I.bow, count: 1 }); if (a) inv.setSlot(1, { id: BF.I.arrow, count: a }); BF.proto.flush(); }, arrows);
    await pg.evaluate(() => BF.inventory.select(0)); await settle();
  };
  const items = () => sim(() => ({ arrows: BF.inventory.count(BF.I.arrow), bow: BF.inventory.slots[0], durability: BF.durability(BF.I.bow) }));
  const mode = async m => { await pg.evaluate(m => { BF.player.gameMode = m; }, m); await settle(); };   // (the page's: it reaches the simulation in its player messages)
  const clearArrows = async () => { await sim(() => { for (const a of BF.mobs.playerArrows()) a.life = 0; }); await step(1); };
  await home(); await kit();

  // ---- power / damage mapping (vanilla: (t^2 + 2t) / 3, ceil(6 f))
  const pw = await pg.evaluate(() => { const B = BF.player.bow; return { p01: B.power(0.1), p05: B.power(0.5), p1: B.power(1), d025: B.damage(B.power(0.25)), d1: B.damage(1) }; });
  ok("a 0.1 s tap is too weak to fire", pw.p01 < 0.1, +pw.p01.toFixed(3));
  ok("power builds over about a second", pw.p05 > 0.3 && pw.p05 < 0.6 && pw.p1 === 1, [+pw.p05.toFixed(3), pw.p1]);
  ok("damage: 0.25 s draw does 1-2, full draw 6 (crits up to 9)", pw.d025 <= 2 && pw.d1 === 6, [pw.d025, pw.d1]);
  await aim(10.5, 1.6, 0.5);
  const quick = (await shoot(0.05)).shot;
  ok("a quick tap fires nothing and uses no arrow", !quick && (await items()).arrows === 16, quick);
  const tap = (await shoot(0.3)).shot;
  const fullDraw = await shoot(1.2), full = fullDraw.shot;
  ok("short draw fires a weak, slow arrow", tap && tap.power < 0.5 && tap.damage <= 3 && !tap.crit, tap);
  ok("full draw: power 1, damage 6, speed 60", full && full.power === 1 && full.damage === 6 && full.speed === 60, full);
  ok("fully drawn bow shows the last pulling stage", fullDraw.stage === 2 && fullDraw.vm && fullDraw.vm.bow === 2, [fullDraw.stage, fullDraw.vm]);
  ok("drawing zooms in (FOV narrows)", fullDraw.fov < 72, +fullDraw.fov.toFixed(1));
  await step(4);
  const rest = await pg.evaluate(() => { for (let i = 0; i < 4; i++) BF.player.update(0.05); return { vm: BF.player.viewModel(), fov: BF.camera.fov }; });
  ok("released bow goes back to the resting sprite", rest.vm.bow === -1 && Math.abs(rest.fov - 75) < 3, [rest.vm, +rest.fov.toFixed(1)]);
  // crit chance at full draw (fired straight up 40 times: none at all is 0.8^40, about 1 in 7500)
  let crits = 0, shots = 0; await aim(0.5, 50, 0.5);
  for (let k = 0; k < 40; k++) {
    if (k % 10 === 0) await kit();
    const s = (await shoot(1.05)).shot; shots++; if (s && s.crit) crits++;
  }
  ok("full draws are sometimes critical, not always", crits > 0 && crits < shots, [crits, shots]);
  await clearArrows();

  // ---- arrows hit and damage a mob
  await kit(); await home();
  await sim(() => { const A = globalThis.__arch, pig = A.pig = BF.mobs.spawn("pig", A.x0 + 8.5, A.y0, A.z0 + 0.5); pig.hp = 100; A.pins.push([pig, A.x0 + 8.5, A.y0, A.z0 + 0.5]); A.hits.length = 0; });
  await aim(8.5, 0.6, 0.5);
  await shoot(1.1); await step(20);
  let h = await sim(() => { const A = globalThis.__arch; return { hits: A.hits, hp: A.pig.hp }; });
  ok("full-draw arrow hits the pig 8 blocks away", h.hits.length === 1 && h.hits[0].type === "pig" && h.hits[0].dmg >= 6 && h.hits[0].dmg <= 9, h.hits);
  ok("pig lost that much health", 100 - h.hp === (h.hits[0] || {}).dmg, h.hp);
  const hpFull = h.hp;
  await sim(() => { const A = globalThis.__arch; A.pig.invuln = 0; A.pins[0][1] = A.x0 + 4.5; });
  await step(2); await aim(4.5, 0.6, 0.5);
  await sim(() => { globalThis.__arch.hits.length = 0; });
  await shoot(0.4); await step(20);
  h = await sim(() => { const A = globalThis.__arch; return { hits: A.hits, hp: A.pig.hp }; });
  ok("a weak draw hits for less", h.hits.length === 1 && h.hits[0].dmg < 6 && hpFull - h.hp === h.hits[0].dmg, [h.hits, hpFull - h.hp]);
  await sim(() => { const A = globalThis.__arch; BF.mobs.kill(A.pig); A.pins.length = 0; }); await step(30);

  // ---- arrows used and bow wear, survival vs creative
  await kit(10); await home(); await aim(0.5, 50, 0.5);
  for (let k = 0; k < 3; k++) await shoot(1);
  let it = await items();
  ok("survival: 3 shots use 3 arrows", it.arrows === 7, it.arrows);
  ok("survival: 3 shots wear the bow 3 of its 384 uses", it.bow && it.bow.wear === 3 && it.durability === 384, it.bow);
  await mode("creative");
  for (let k = 0; k < 2; k++) await shoot(1);
  it = await items();
  ok("creative: shots use no arrows and no bow wear", it.arrows === 7 && it.bow.wear === 3, [it.arrows, it.bow.wear]);
  await sim(() => { BF.inventory.setSlot(1, null); BF.proto.flush(); }); await settle();
  const free = (await shoot(1)).shot;
  ok("creative: fires without any arrows", !!free && free.power === 1);
  await mode("survival");
  const none = (await shoot(1)).shot, drawing = await pg.evaluate(() => BF.player.bow.drawing);
  ok("survival without arrows: no draw, no shot", !none && drawing === 0, none);
  await clearArrows();

  // ---- stuck arrows: stick, picked up by walking over (1 arrow back), creative ones give nothing, despawn after 60 s
  const arrows = () => sim(() => { const A = globalThis.__arch; return BF.mobs.playerArrows().map(a => ({ stuck: a.stuck, cell: a.cell, pickup: a.pickup, pos: [a.pos.x - A.x0, a.pos.y - A.y0, a.pos.z - A.z0].map(v => +v.toFixed(2)) })); });
  const walkTo = async (dx, dz) => { await pg.evaluate(([dx, dz]) => { const A = window.__archAt; BF.player.teleport(A.x0 + dx, A.y0 + 0.01, A.z0 + dz); }, [dx, dz]); await settle(); };
  await kit(5); await home(); await aim(24, 3, 0.5);
  await shoot(1.1); await step(20);
  let arr = await arrows();
  const st = arr[0];
  ok("arrow sticks in the wall", arr.length === 1 && st.stuck && st.cell && st.cell[0] === x0 + 24, st);
  await step(40);
  arr = await arrows();
  ok("stuck arrow stays put", arr.length === 1 && arr[0].stuck);
  ok("arrow count went down by one", (await items()).arrows === 4, (await items()).arrows);
  await walkTo(23.5, 0.5); await step(6);
  arr = await arrows(); it = await items();
  ok("walking over the stuck arrow picks it up", arr.length === 0 && it.arrows === 5, [arr.length, it.arrows]);
  // breaking the block frees the arrow, which falls
  await home(); await aim(24, 5, 0.5); await shoot(1.1); await step(20);
  const st2 = (await arrows())[0];
  await sim(() => { const a = BF.mobs.playerArrows()[0]; if (a && a.cell) BF.world.setBlock(a.cell[0], a.cell[1], a.cell[2], 0); });
  await step(30);
  const st2b = (await arrows())[0];
  ok("arrow falls when its block is broken, and sticks in the floor", st2 && st2b && st2b.pos[1] < st2.pos[1] - 0.5 && st2b.stuck && st2b.cell[1] === y0 - 1, [st2, st2b]);
  await clearArrows();
  // creative-fired arrow: picked up but gives nothing back
  await mode("creative"); await home(); await aim(24, 3, 2.5); await shoot(1.1); await step(20);
  const n0 = (await items()).arrows, stc = (await arrows())[0];
  ok("creative arrow sticks", stc && stc.stuck && stc.pickup === 2);
  await walkTo(23.5, 2.5); await step(6);
  arr = await arrows(); it = await items();
  ok("creative arrow is removed on walking over it, no arrow given", arr.length === 0 && it.arrows === n0, [arr.length, it.arrows, n0]);
  await mode("survival");
  // despawn after 60 s
  await home(); await aim(24, 3, -2.5); await shoot(1.1); await step(20);
  const sd = (await arrows())[0];
  await step(Math.round(50 / 0.05));
  const at50 = (await arrows()).length;
  await step(Math.round(11 / 0.05));
  const at61 = (await arrows()).length;
  ok("stuck arrow despawns after about 60 s", sd && sd.stuck && at50 === 1 && at61 === 0, [at50, at61]);

  // ---- shooting a villager angers its village's golems (as a melee hit does)
  const found = await sim(() => {
    const M = BF.mobs, A = globalThis.__arch;
    const vil = M.list.find(m => m.type === "villager" && !m.dead && !m.child && m.village && M.list.some(g => g.def.golem && g.village === m.village && !g.dead));
    if (!vil) return false;
    A.vil = vil; A.golems = M.list.filter(g => g.def.golem && g.village === vil.village && !g.dead);
    for (const g of A.golems) g.ai.provoked = 0;
    vil.village.angryT = 0;
    if (vil.sleeping) vil.sleeping = false;
    return true;
  });
  ok("found a villager with golems in its village", found);
  if (found) {
    await kit(); await home();
    await sim(() => { const A = globalThis.__arch; A.pins.push([A.vil, A.x0 + 7.5, A.y0, A.z0 + 0.5]); });
    await step(2);
    const hp0 = await sim(() => { const A = globalThis.__arch; A.vil.invuln = 0; A.hits.length = 0; return A.vil.hp; });
    await aim(7.5, 1.2, 0.5);
    await shoot(1.1); await step(20);
    const v = await sim(() => { const A = globalThis.__arch; return { hits: A.hits, hp: A.vil.hp, provoked: A.golems.map(g => g.ai.provoked), angryT: A.vil.village.angryT, lastHurt: A.vil.lastHurt }; });
    ok("arrow hits the villager", v.hits.length === 1 && v.hits[0].type === "villager" && v.hp < hp0, [v.hits, hp0, v.hp]);
    ok("the village's golems are angry with the player", v.provoked.every(p => p > 0) && v.angryT > 0, v.provoked);
    ok("villager logs the player as the cause", v.lastHurt === "the player", v.lastHurt);
    await sim(() => { globalThis.__arch.pins.length = 0; });
  }

  // ---- mouse buttons: right (2) and middle (1, Ubuntu trackpads) both hold to draw and release to fire, and the shot logs in F3
  await kit(); await home(); await aim(0.5, 50, 0.5);
  R.push(...await pg.evaluate(() => {
    const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const P = BF.player, B = P.bow, cv = BF.renderer.domElement, step = n => { for (let i = 0; i < n; i++) P.update(0.05); };
    for (const btn of [2, 1]) {
      const o = { bubbles: true, cancelable: true, clientX: innerWidth / 2, clientY: innerHeight / 2, button: btn, buttons: btn === 2 ? 2 : 4 };
      P.lastShot = null;
      cv.dispatchEvent(new MouseEvent("mousedown", o));
      step(22);
      const drawing = B.drawing > 0.9;
      window.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, o, { buttons: 0 })));
      step(1);
      ok(`button ${btn}: hold draws, release fires a full shot`, drawing && P.lastShot && P.lastShot.power === 1, [drawing, P.lastShot]);
    }
    const clicks = (BF.debugInfo().clicks || []).join(" | ");
    ok("F3 click log shows draw and release", /draw bow/.test(clicks) && /release bow/.test(clicks), clicks);
    return R;
  }));
  // aimed at the pad with the bow: drawing places nothing
  await settle();
  await aim(2.5, -0.5, 0.5);
  const before = await sim(() => { const A = globalThis.__arch; return BF.world.getBlock(A.x0 + 2, A.y0, A.z0); });
  await shoot(0.5);
  const after = await sim(() => { const A = globalThis.__arch, s = BF.inventory.slots[0]; return { block: BF.world.getBlock(A.x0 + 2, A.y0, A.z0), bow: !!s && s.id === BF.I.bow }; });
  ok("right click with a bow on a block places nothing", after.block === before && after.bow);
  await sim(() => { delete globalThis.__arch; BF.state.paused = false; });
  await pg.evaluate(() => { BF.state.paused = false; });
  for (const l of R) console.log(l);
  console.log(R.some(l => l.startsWith("FAIL")) ? "archery: FAIL" : "archery: all PASS");
};
