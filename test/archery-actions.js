// Player archery: NODE_PATH=$(npm root -g) node test/run.js /tmp/arch test/archery-actions.js
// Draw strength -> power and damage (short tap vs full draw), arrows hitting a mob, 1 arrow per shot (none in creative), 1 bow use per
// shot, arrows sticking in a block and picked up again by walking over them (a creative arrow gives nothing back, stuck ones despawn
// after 60 s), a shot villager angering its village's golems, and drawing with the right and the middle button (Ubuntu trackpads).
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; BF.mobs.spawning = false; });
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(async () => {
    const R = [], ok = (name, cond, extra) => R.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const P = BF.player, M = BF.mobs, W = BF.world, I = BF.I, inv = BF.inventory;
    BF.state.paused = true;
    P.invulnerable = true;
    BF.sky.setTime(0.25);
    for (const m of M.list.slice()) if (m.hostile) M.kill(m);
    const pins = [];   // [mob, x, y, z]: held in place every step
    const step = (n = 1, h = 0.05) => { for (let i = 0; i < n; i++) { for (const [m, x, y, z] of pins) { m.position.set(x, y, z); m.vel.set(0, 0, 0); if (m.ai) m.ai.fleeT = 0; } M.update(h); P.update(h); } };
    // a stone pad high above the village, open sky, a stone wall at the far end
    const pp = P.position, x0 = Math.floor(pp.x), z0 = Math.floor(pp.z), y0 = Math.floor(W.heightAt(x0, z0)) + 12;
    for (let dx = -3; dx <= 24; dx++) for (let dz = -4; dz <= 4; dz++) { W.setBlock(x0 + dx, y0 - 1, z0 + dz, BF.B.stone); for (let k = 0; k < 8; k++) W.setBlock(x0 + dx, y0 + k, z0 + dz, dx === 24 ? BF.B.stone : 0); }
    const home = () => { P.teleport(x0 + 0.5, y0 + 0.01, z0 + 0.5); step(4); };
    const aim = (x, y, z) => { const e = P.eyePos(), tx = x - e.x, ty = y - e.y, tz = z - e.z; P.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz))); };
    const kit = (arrows = 16) => { inv.clear(); inv.setSlot(0, { id: I.bow, count: 1 }); if (arrows) inv.setSlot(1, { id: I.arrow, count: arrows }); inv.select(0); };
    const hold = sec => { P.setMouse(false, true); step(Math.round(sec / 0.05)); };
    const release = () => { P.setMouse(false, false); step(1); };
    const hits = []; BF.on("arrowHitMob", (m, dmg, crit) => hits.push({ type: m.type, dmg, crit }));
    home(); kit();

    // ---- power / damage mapping (vanilla: (t^2 + 2t) / 3, ceil(6 f))
    const B = P.bow;
    ok("a 0.1 s tap is too weak to fire", B.power(0.1) < 0.1, +B.power(0.1).toFixed(3));
    ok("power builds over about a second", B.power(0.5) > 0.3 && B.power(0.5) < 0.6 && B.power(1) === 1, [+B.power(0.5).toFixed(3), B.power(1)]);
    ok("damage: 0.25 s draw does 1-2, full draw 6 (crits up to 9)", B.damage(B.power(0.25)) <= 2 && B.damage(1) === 6, [B.damage(B.power(0.25)), B.damage(1)]);
    aim(x0 + 10.5, y0 + 1.6, z0 + 0.5);
    P.lastShot = null; hold(0.05); release();
    ok("a quick tap fires nothing and uses no arrow", !P.lastShot && inv.count(I.arrow) === 16, P.lastShot);
    P.lastShot = null; hold(0.3); release();
    const tap = P.lastShot;
    hold(1.2);
    const fullStage = B.stage, vmFull = P.viewModel(), fov = BF.camera.fov;
    release();
    const full = P.lastShot;
    ok("short draw fires a weak, slow arrow", tap && tap.power < 0.5 && tap.damage <= 3 && !tap.crit, tap);
    ok("full draw: power 1, damage 6, speed 60", full && full.power === 1 && full.damage === 6 && full.speed === 60, full);
    ok("fully drawn bow shows the last pulling stage", fullStage === 2 && vmFull && vmFull.bow === 2, [fullStage, vmFull]);
    ok("drawing zooms in (FOV narrows)", fov < 72, +fov.toFixed(1));
    step(4);
    ok("released bow goes back to the resting sprite", P.viewModel().bow === -1 && Math.abs(BF.camera.fov - 75) < 3, [P.viewModel(), +BF.camera.fov.toFixed(1)]);
    // crit chance at full draw (fired straight up 40 times: none at all is 0.8^40, about 1 in 7500)
    let crits = 0, shots = 0; aim(x0 + 0.5, y0 + 50, z0 + 0.5);
    for (let k = 0; k < 40; k++) { inv.setSlot(1, { id: I.arrow, count: 16 }); hold(1.05); release(); shots++; if (P.lastShot.crit) crits++; }
    ok("full draws are sometimes critical, not always", crits > 0 && crits < shots, [crits, shots]);
    for (const a of M.playerArrows()) a.life = 0; step(1);

    // ---- arrows hit and damage a mob
    kit(); home();
    const pig = M.spawn("pig", x0 + 8.5, y0, z0 + 0.5); pig.hp = 100; pins.push([pig, x0 + 8.5, y0, z0 + 0.5]);
    aim(x0 + 8.5, y0 + 0.6, z0 + 0.5);
    hits.length = 0; hold(1.1); release(); step(20);
    ok("full-draw arrow hits the pig 8 blocks away", hits.length === 1 && hits[0].type === "pig" && hits[0].dmg >= 6 && hits[0].dmg <= 9, hits);
    ok("pig lost that much health", 100 - pig.hp === (hits[0] || {}).dmg, pig.hp);
    const hpFull = pig.hp; pig.invuln = 0;
    pins[0][1] = x0 + 4.5; step(2); aim(x0 + 4.5, y0 + 0.6, z0 + 0.5);
    hits.length = 0; hold(0.4); release(); step(20);
    ok("a weak draw hits for less", hits.length === 1 && hits[0].dmg < 6 && hpFull - pig.hp === hits[0].dmg, [hits, hpFull - pig.hp]);
    M.kill(pig); pins.length = 0; step(30);

    // ---- arrows used and bow wear, survival vs creative
    kit(10); home(); aim(x0 + 0.5, y0 + 50, z0 + 0.5);
    for (let k = 0; k < 3; k++) { hold(1); release(); }
    ok("survival: 3 shots use 3 arrows", inv.count(I.arrow) === 7, inv.count(I.arrow));
    ok("survival: 3 shots wear the bow 3 of its 384 uses", inv.slots[0] && inv.slots[0].wear === 3 && BF.durability(I.bow) === 384, inv.slots[0]);
    P.gameMode = "creative"; step(1);
    for (let k = 0; k < 2; k++) { hold(1); release(); }
    ok("creative: shots use no arrows and no bow wear", inv.count(I.arrow) === 7 && inv.slots[0].wear === 3, [inv.count(I.arrow), inv.slots[0].wear]);
    inv.setSlot(1, null); P.lastShot = null; hold(1); release();
    ok("creative: fires without any arrows", !!P.lastShot && P.lastShot.power === 1);
    P.gameMode = "survival"; step(1);
    P.lastShot = null; hold(1); release();
    ok("survival without arrows: no draw, no shot", !P.lastShot && B.drawing === 0, P.lastShot);
    for (const a of M.playerArrows()) a.life = 0; step(1);

    // ---- stuck arrows: stick, picked up by walking over (1 arrow back), creative ones give nothing, despawn after 60 s
    kit(5); home(); aim(x0 + 24, y0 + 3, z0 + 0.5);
    hold(1.1); release(); step(20);
    let arr = M.playerArrows();
    const st = arr[0];
    ok("arrow sticks in the wall", arr.length === 1 && st.stuck && st.cell && st.cell[0] === x0 + 24, st && { stuck: st.stuck, cell: st.cell, pos: [st.pos.x - x0, st.pos.y - y0, st.pos.z - z0].map(v => +v.toFixed(2)) });
    step(40);
    ok("stuck arrow stays put", st.stuck && M.playerArrows().length === 1);
    ok("arrow count went down by one", inv.count(I.arrow) === 4, inv.count(I.arrow));
    P.teleport(x0 + 23.5, y0 + 0.01, z0 + 0.5); step(6);
    ok("walking over the stuck arrow picks it up", M.playerArrows().length === 0 && inv.count(I.arrow) === 5, [M.playerArrows().length, inv.count(I.arrow)]);
    // breaking the block frees the arrow, which falls
    home(); aim(x0 + 24, y0 + 5, z0 + 0.5); hold(1.1); release(); step(20);
    const st2 = M.playerArrows()[0];
    const y2 = st2 && st2.pos.y;
    if (st2 && st2.cell) W.setBlock(st2.cell[0], st2.cell[1], st2.cell[2], 0);
    step(30);
    ok("arrow falls when its block is broken, and sticks in the floor", st2 && st2.pos.y < y2 - 0.5 && st2.stuck && st2.cell[1] === y0 - 1, st2 && [+(y2 - y0).toFixed(2), +(st2.pos.y - y0).toFixed(2), st2.cell[0] - x0, st2.cell[1] - y0]);
    for (const a of M.playerArrows()) a.life = 0; step(1);
    // creative-fired arrow: picked up but gives nothing back
    P.gameMode = "creative"; home(); aim(x0 + 24, y0 + 3, z0 + 2.5); hold(1.1); release(); step(20);
    const n0 = inv.count(I.arrow), stc = M.playerArrows()[0];
    ok("creative arrow sticks", stc && stc.stuck && stc.pickup === 2);
    P.teleport(x0 + 23.5, y0 + 0.01, z0 + 2.5); step(6);
    ok("creative arrow is removed on walking over it, no arrow given", M.playerArrows().length === 0 && inv.count(I.arrow) === n0, [M.playerArrows().length, inv.count(I.arrow), n0]);
    P.gameMode = "survival"; step(1);
    // despawn after 60 s
    home(); aim(x0 + 24, y0 + 3, z0 - 2.5); hold(1.1); release(); step(20);
    const sd = M.playerArrows()[0];
    step(Math.round(50 / 0.05));
    const at50 = M.playerArrows().length;
    step(Math.round(11 / 0.05));
    ok("stuck arrow despawns after about 60 s", sd && sd.stuck && at50 === 1 && M.playerArrows().length === 0, [at50, M.playerArrows().length]);

    // ---- shooting a villager angers its village's golems (as a melee hit does)
    const vil = M.list.find(m => m.type === "villager" && !m.dead && !m.child && m.village && M.list.some(g => g.def.golem && g.village === m.village && !g.dead));
    ok("found a villager with golems in its village", !!vil);
    if (vil) {
      const golems = M.list.filter(g => g.def.golem && g.village === vil.village && !g.dead);
      for (const g of golems) g.ai.provoked = 0;
      vil.village.angryT = 0;
      if (vil.sleeping) vil.sleeping = false;
      kit(); home(); pins.push([vil, x0 + 7.5, y0, z0 + 0.5]); step(2);
      const hp0 = vil.hp; vil.invuln = 0;
      aim(x0 + 7.5, y0 + 1.2, z0 + 0.5);
      hits.length = 0; hold(1.1); release(); step(20);
      ok("arrow hits the villager", hits.length === 1 && hits[0].type === "villager" && vil.hp < hp0, [hits, hp0, vil.hp]);
      ok("the village's golems are angry with the player", golems.every(g => g.ai.provoked > 0) && vil.village.angryT > 0, golems.map(g => g.ai.provoked));
      ok("villager logs the player as the cause", vil.lastHurt === "the player", vil.lastHurt);
      pins.length = 0;
    }

    // ---- mouse buttons: right (2) and middle (1, Ubuntu trackpads) both hold to draw and release to fire, and the shot logs in F3
    kit(); home(); aim(x0 + 0.5, y0 + 50, z0 + 0.5);
    const cv = BF.renderer.domElement;
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
    // aimed at the pad with the bow: drawing places nothing
    aim(x0 + 2.5, y0 - 0.5, z0 + 0.5);
    const before = W.getBlock(x0 + 2, y0, z0);
    hold(0.5); release();
    ok("right click with a bow on a block places nothing", W.getBlock(x0 + 2, y0, z0) === before && inv.slots[0] && inv.slots[0].id === I.bow);
    return R;
  });
  for (const l of res) console.log(l);
  console.log(res.some(l => l.startsWith("FAIL")) ? "archery: FAIL" : "archery: all PASS");
};
