// Villager hover card: node test/run.js /tmp/vh test/villager-hover.js
// Looking at a villager shows its name, occupation and activity at the top of the screen (survival and creative), a block in
// between hides it, and the trade screen and its inventory panel carry the villager's name.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "survival"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const frames = n => pg.evaluate(k => new Promise(res => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
  // freeze the villagers and stand 4 blocks in front of one, looking at its chest
  const pick = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.child && m.profession !== "nitwit");
    window.__v = v;
    BF.state.paused = true;   // hold everyone still (the hover card still updates every frame)
    return { name: BF.vlog.nameOf(v), prof: v.profession };
  });
  const aim = async () => pg.evaluate(() => {
    const v = window.__v, p = v.position;
    v.velocity && v.velocity.set(0, 0, 0);
    BF.player.teleport(p.x + 4, p.y, p.z);
    const e = BF.player.eyePos(), tx = p.x, ty = p.y + v.height * 0.6, tz = p.z;
    const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    BF.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
  });
  const card = () => pg.evaluate(() => {
    const el = document.querySelector(".bfv-hover");
    return el ? { shown: getComputedStyle(el).display !== "none", text: [...el.children].filter(c => c.style.display !== "none").map(c => c.textContent).join(" | "), mob: BF.villagerHover.shown() === window.__v } : null;
  });
  const r = { pick };
  // clear any blocks between the player and the villager (villages sit on uneven ground)
  await pg.evaluate(() => { const p = window.__v.position; for (let dx = 1; dx <= 4; dx++) for (let dy = 0; dy < 3; dy++) BF.world.setBlock(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z), 0); });
  await aim(); await frames(10); await aim(); await frames(5);
  r.survival = await card();
  await pg.screenshot({ path: out + '-survival.png' });
  // a wall between hides it
  await pg.evaluate(() => { const p = window.__v.position; for (let dy = 0; dy < 3; dy++) BF.world.setBlock(Math.floor(p.x) + 2, Math.floor(p.y) + dy, Math.floor(p.z), BF.B ? BF.B.stone || 1 : 1); });
  await aim(); await frames(5);
  r.behindWall = await card();
  await pg.evaluate(() => { const p = window.__v.position; for (let dy = 0; dy < 3; dy++) BF.world.setBlock(Math.floor(p.x) + 2, Math.floor(p.y) + dy, Math.floor(p.z), 0); });
  // looking away hides it
  await pg.evaluate(() => BF.player.setLook(BF.player.yaw + Math.PI, 0)); await frames(5);
  r.lookAway = await card();
  // creative
  await pg.evaluate(() => { BF.player.gameMode = "creative"; });
  await aim(); await frames(5);
  r.creative = await card();
  // trade screen: name in the title and the inventory panel; the hover card hides behind the screen
  r.screen = await pg.evaluate(() => {
    BF.player.gameMode = "survival"; BF.state.paused = false;
    const v = window.__v; v.sleeping = false; BF.mobs.interact(v);
    const texts = [...document.querySelectorAll("h2, h3, h4, .bf-inv *")].filter(e => e.childElementCount === 0).map(e => e.textContent).filter(t => t && t.includes(BF.vlog.nameOf(v)));
    return { open: BF.inventory.isOpen(), texts };
  });
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
