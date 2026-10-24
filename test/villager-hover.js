// @ci integration suite=ui hosts=worker,server
// Villager hover card: node test/run.js /tmp/vh test/villager-hover.js [--host page|worker|server]
// Looking at a villager shows its name, occupation and activity at the top of the screen (survival and creative), a block in
// between hides it, and the trade screen and its inventory panel carry the villager's name.
// The villager and the blocks are the simulation's (lib.sim, spec r15-43); the player, the card and the screens are the page's.
const lib = require('./lib');
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; });
  await lib.sim(pg, () => BF.sky.setTime(0.2));
  await lib.toVillage(pg);
  const frames = n => pg.evaluate(k => new Promise(res => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  // freeze the villagers and stand 4 blocks in front of one, looking at its chest
  const pick = await lib.sim(pg, () => {
    BF.mobs.spawning = false;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.child && m.profession !== "nitwit");
    globalThis.__v = v;
    BF.state.paused = true;   // hold everyone still (the hover card still updates every frame)
    if (BF.proto) BF.proto.flush();
    return { name: BF.vlog.nameOf(v), prof: v.profession, id: BF.ids.idOf(v) };
  });
  // the villager's feet and height, where the simulation is
  const vpos = () => lib.sim(pg, () => { const v = globalThis.__v, p = v.position; v.velocity && v.velocity.set(0, 0, 0); return { x: p.x, y: p.y, z: p.z, h: v.height }; });
  const aim = async () => pg.evaluate(p => {
    BF.player.teleport(p.x + 4, p.y, p.z);
    const e = BF.player.eyePos(), tx = p.x, ty = p.y + p.h * 0.6, tz = p.z;
    const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    BF.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, await vpos());
  const card = () => pg.evaluate(id => {
    const el = document.querySelector(".bfv-hover");
    return el ? { shown: getComputedStyle(el).display !== "none", text: [...el.children].filter(c => c.style.display !== "none").map(c => c.textContent).join(" | "), mob: (s => !!s && s.sid === id)(BF.villagerHover.shown()) } : null;   // (the card's mob is its entity in the client's mirror, r15-37)
  }, pick.id);
  // blocks set where the simulation is reach the page's copy of the world with the next flush
  const setCells = async (cells) => { await lib.sim(pg, cs => { for (const [dx, dy, b] of cs) { const p = globalThis.__v.position; BF.world.setBlock(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z), b === "stone" ? BF.B.stone : 0); } if (BF.proto) BF.proto.flush(); }, cells); await pg.waitForTimeout(300); };
  // Aims at the villager until the card shows it, up to ~20 tries: on a slow runner the player can still be settling after the
  // teleport (lifted out of the ground a few frames later), which moves the eye after the look was set. Returns the last card.
  const aimUntilShown = async () => {
    let c = null;
    for (let i = 0; i < 20; i++) {
      await aim(); await frames(5);
      c = await card();
      if (c && c.shown && c.mob) { if (i) console.log(`(card shown after ${i + 1} aims)`); break; }
    }
    return c;
  };
  const r = { pick };
  // clear any blocks between the player and the villager (villages sit on uneven ground)
  { const cs = []; for (let dx = 1; dx <= 4; dx++) for (let dy = 0; dy < 3; dy++) cs.push([dx, dy, 0]); await setCells(cs); }
  await aim(); await frames(10);
  r.survival = await aimUntilShown();
  await pg.screenshot({ path: out + '-survival.png' });
  // a wall between hides it
  await setCells([0, 1, 2].map(dy => [2, dy, "stone"]));
  await aim(); await frames(5);
  r.behindWall = await card();
  await setCells([0, 1, 2].map(dy => [2, dy, 0]));
  // looking away hides it
  await pg.evaluate(() => BF.player.setLook(BF.player.yaw + Math.PI, 0)); await frames(5);
  r.lookAway = await card();
  // creative
  await pg.evaluate(() => { BF.player.gameMode = "creative"; });
  r.creative = await aimUntilShown();
  // trade screen: name in the title and the inventory panel; the hover card hides behind the screen
  await pg.evaluate(() => { BF.player.gameMode = "survival"; });
  await lib.sim(pg, () => { BF.state.paused = false; const v = globalThis.__v; v.sleeping = false; BF.mobs.interact(v); if (BF.proto) BF.proto.flush(); });   // (the simulation opens the screen; the page follows)
  await pg.waitForFunction(() => BF.inventory.isOpen(), null, { timeout: 10000 }).catch(() => {});
  await pg.waitForTimeout(500);   // (the trade screen's offers and the villager's name come with the trades query)
  r.screen = await pg.evaluate(name => {
    const texts = [...document.querySelectorAll("h2, h3, h4, .bf-inv *")].filter(e => e.childElementCount === 0).map(e => e.textContent).filter(t => t && t.includes(name));
    return { open: BF.inventory.isOpen(), texts };
  }, pick.name);
  await frames(3);
  r.cardWhileOpen = await card();
  await pg.screenshot({ path: out + '-trade.png' });
  await pg.evaluate(() => BF.inventory.close());
  const ok = (c, why) => console.log((c ? "PASS " : "FAIL ") + why);
  const has = c => c && c.text.includes(pick.name) && c.text.toLowerCase().includes(pick.prof.replace(/_/g, " "));
  ok(r.survival && r.survival.shown && r.survival.mob && has(r.survival) && r.survival.text.split(" | ").length >= 3, "survival card shows name, job and activity: " + (r.survival && r.survival.text));
  ok(r.behindWall && !r.behindWall.shown, "card hidden when a block is in the way");
  ok(r.lookAway && !r.lookAway.shown, "card hidden when looking away");
  ok(r.creative && r.creative.shown && has(r.creative), "creative card shows name and job: " + (r.creative && r.creative.text));
  ok(r.screen.open && r.screen.texts.length >= 2 && r.screen.texts.some(t => /Inventory/.test(t)), "trade screen title and inventory panel name the villager: " + JSON.stringify(r.screen.texts));
  ok(r.cardWhileOpen && !r.cardWhileOpen.shown, "card hidden while the trade screen is open");
  console.log(JSON.stringify(r, null, 1));
};
