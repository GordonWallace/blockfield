// @ci integration suite=world timeout=900 hosts=worker,server
// Game options: which monsters spawn, world by world (js/gameopts.js). New worlds and worlds without options have zombies and skeletons on,
// creepers and spiders off; the create form, the pause menu (Game options) and a world's Options on the start screen set them; a monster
// turned off never spawns and the loaded ones leave; the others spawn about as often as with every monster on (the area caps shrink by the
// switched-off share); the options are saved with the world and the start screen's changes apply when it opens.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/mo test/monster-options.js [--host page|worker|server]
// The screens are the page's; the options in force, the mobs and the game log are read where the simulation is (spec r15-43).
const lib = require('./lib');
module.exports = async (pg) => {
  const fails = [];
  const ok = (what, c, d) => { console.log((c ? "ok   " : "FAIL ") + what + (d !== undefined && !c ? " " + JSON.stringify(d) : "")); if (!c) fails.push(what); };
  const click = sel => pg.evaluate(s => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);

  // ---- defaults and the create form
  const d0 = await lib.sim(pg, () => ({ o: BF.gameOpts.monsters(), share: BF.mobs.spawnShare(), flag: BF.mobs.typeDef("creeper").spawns }));
  ok("a new world: zombies and skeletons on, creepers and spiders off", JSON.stringify(d0.o) === JSON.stringify({ zombie: true, skeleton: true, creeper: false, spider: false }), d0);
  ok("the option is the creeper type's own boolean", d0.flag === false, d0);
  ok("spawn share is zombie + skeleton weight (0.58)", Math.abs(d0.share - 0.58) < 1e-9, d0);
  await click('.bfp-start [data-act="show-create"]');
  const form = await pg.evaluate(() => [...document.querySelectorAll('.bfp-createopts [data-act="mon"]')].map(b => b.textContent));
  ok("the create form lists the four monsters with the defaults", form.join() === "Zombies: On,Skeletons: On,Creepers: Off,Spiders: Off", form);
  await click('.bfp-createopts [data-mon="spider"]');
  await pg.evaluate(() => { const f = document.querySelector(".bfp-view-create"); f.elements.name.value = "Monster options"; f.elements.seed.value = "123"; });
  await click('.bfp-view-create button[type="submit"]');
  await pg.waitForFunction(() => BF.save.current && BF.save.current.name === "Monster options" && !BF.preparing, null, { timeout: 180000 });
  await lib.simReady(pg);
  await pg.waitForTimeout(3000);
  const c1 = { meta: await pg.evaluate(() => BF.save.current.monsters), live: await lib.sim(pg, () => BF.gameOpts.monsters()) };
  ok("Create and play keeps the form's options (spiders turned on)", c1.meta.spider === true && c1.meta.creeper === false && c1.live.spider === true && c1.live.zombie === true, c1);

  // ---- in game: the pause menu
  await pg.evaluate(() => BF.player.setGameMode("creative"));
  await lib.sim(pg, () => { BF.mobs.spawning = false; });
  await click('.bfp-pause [data-act="opts"]');
  const p1 = await pg.evaluate(() => [...document.querySelectorAll('.bfp-pauseopts [data-act="mon"]')].map(b => b.textContent));
  ok("the pause menu's Game options show this world's options", p1.join() === "Zombies: On,Skeletons: On,Creepers: Off,Spiders: On", p1);
  const sp = await lib.sim(pg, () => { const p = BF.player.position, s = BF.mobs.spawn("spider", p.x + 3, p.y, p.z + 3); return !!s && !s.removed; });
  await click('.bfp-pauseopts [data-mon="spider"]');
  await pg.waitForTimeout(500);   // (the change reaches the simulation)
  const p2 = await lib.sim(pg, () => ({ on: BF.gameOpts.on("spider"), spiders: BF.mobs.list.filter(m => m.type === "spider" && !m.removed && !m.dead).length,
    log: BF.glog.recent(200).filter(e => e.l === "INFO" && e.k === "options").map(e => e.x) }));
  ok("turning spiders off in game removes the loaded ones", sp && !p2.on && p2.spiders === 0, p2);
  ok("the change is in the game log", p2.log.some(t => /Spiders spawning turned off/.test(t)), p2.log);
  await click('.bfp-pauseopts [data-mon="spider"]');
  await pg.waitForTimeout(500);
  ok("and back on", await lib.sim(pg, () => BF.gameOpts.on("spider") && BF.mobs.typeDef("spider").spawns === true));

  // ---- spawning: the others spawn about as often with creepers and spiders off
  const run = (opts) => lib.sim(pg, o => {
    for (const t in o) BF.gameOpts.set(t, o[t]);
    for (const m of BF.mobs.list.slice()) if (m.hostile) BF.mobs.discard(m);
    BF.mobs.spawning = true;
    // a fixed random sequence so the counts don't swing run to run (restored after)
    const rnd = Math.random; let a = 0x9e3779b9;
    Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const seen = new Set(BF.mobs.list), n = {}, caps = [];
    for (let i = 0; i < 8000; i++) {
      BF.sky.setTime(0.75);
      (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      if (i === 100) { const W = BF.wildlife, sh = BF.mobs.spawnShare(); caps.push(...W.areas().map(A => [A.cap, Math.max(1, Math.round(W.CAP * A.n / W.CAP_CHUNKS)) * sh, sh])); }
      for (const m of BF.mobs.list.slice()) if (!seen.has(m)) { seen.add(m); if (m.hostile) { n[m.type] = (n[m.type] || 0) + 1; BF.mobs.discard(m); } }   // counted and taken away, so the area caps never fill and the counts measure the spawn rate
    }
    BF.mobs.spawning = false;
    Math.random = rnd;
    return { n, caps };
  }, opts);
  const all = await run({ zombie: true, skeleton: true, creeper: true, spider: true });
  const two = await run({ creeper: false, spider: false });
  console.log(JSON.stringify({ all, two }));
  const zs = r => (r.n.zombie || 0) + (r.n.skeleton || 0);
  ok("with all four on, creepers and spiders spawn too", all.n.zombie && all.n.skeleton && (all.n.creeper || 0) + (all.n.spider || 0) > 0, all.n);
  ok("with creepers and spiders off, none of them spawn", !two.n.creeper && !two.n.spider, two.n);
  ok("zombies and skeletons spawn about as often either way (0.8x to 1.25x)", zs(all) >= 300 && zs(two) >= 0.8 * zs(all) && zs(two) <= 1.25 * zs(all), { all: zs(all), two: zs(two) });
  ok("area caps shrink by the switched-off share", all.caps.length && two.caps.length && all.caps.every(c => c[0] === c[1] && c[2] === 1) && two.caps.every(c => Math.abs(c[0] - c[1]) < 1e-9 && Math.abs(c[2] - 0.58) < 1e-9), { all: all.caps, two: two.caps });

  // ---- saved with the world; the start screen's Options apply when it opens
  await lib.sim(pg, () => { BF.gameOpts.set("spider", true); BF.gameOpts.set("skeleton", false); });
  const id = await pg.evaluate(async () => { await BF.save.saveNow(); return BF.save.current.id; });
  const saved = await pg.evaluate(async id => (await BF.save.list()).find(w => w.id === id).monsters, id);
  ok("the options are saved in the world's list entry", saved && saved.skeleton === false && saved.zombie === true && saved.creeper === false, saved);
  await pg.reload();
  // the boot world started (with the simulation off the page, once its host has), its rivers worked out
  await pg.waitForFunction(() => window.BF && BF.state && BF.state.seed && !BF.preparing, null, { timeout: 300000, polling: 250 });
  await lib.simReady(pg);
  await lib.ready(pg);
  await pg.waitForTimeout(3000);
  ok("another world opens with the defaults", await lib.sim(pg, () => !BF.gameOpts.on("creeper") && BF.gameOpts.on("skeleton")));
  const row = `.bfp-world[data-id="${id}"]`;
  await pg.waitForFunction(r => !!document.querySelector(r + ' [data-act="options"]'), row, { timeout: 30000 });
  await click(row + ' [data-act="options"]');
  const r1 = await pg.evaluate(r => [...document.querySelectorAll(r + ' [data-act="mon"]')].map(b => b.textContent), row);
  ok("a world's Options on the start screen show its saved options", r1.join() === "Zombies: On,Skeletons: Off,Creepers: Off,Spiders: On", r1);
  await click(row + ' [data-mon="creeper"]');
  await click(row + ' [data-act="options-ok"]');
  await pg.waitForTimeout(500);
  const s2 = await pg.evaluate(async id => (await BF.save.list()).find(w => w.id === id).monsters, id);
  ok("Save writes them to the world", s2 && s2.creeper === true && s2.skeleton === false, s2);
  await pg.evaluate(id => BF.save.load(id), id);
  await pg.waitForTimeout(2000);
  const l = await lib.sim(pg, () => BF.gameOpts.monsters());
  ok("the world opens with them", l.creeper === true && l.skeleton === false && l.zombie === true && l.spider === true, l);
  const old = await pg.evaluate(() => BF.gameOpts.normalize(undefined));
  ok("a world saved before the options takes the defaults", old.zombie && old.skeleton && !old.creeper && !old.spider, old);

  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
