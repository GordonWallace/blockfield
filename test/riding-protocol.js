// @ci integration suite=world,items timeout=1800 hosts=worker,server
// Riding over the protocol (spec r15-44 part 2): getting on and off a boat or horse are player requests, whoever steers moves the vehicle
// (the page rows a boat and rides a saddled, tamed horse with its own copy and reports where it is; the simulation drives an untamed
// horse and the page sits the player on the mirror's), and what the simulation does to the ride comes back in self. Served over http and
// run with the simulation on each host asked for (BF_HOST, as test/ci.js sets it; else the worker, the world server and the page):
//   - a boat placed by a request; player.mount gets the player in (self.mount); W rows it and the simulation's boat follows the page's;
//     Shift gets out (player.dismount), onto a spot beside it;
//   - the save keeps the player in the boat: saved, loaded again, they're back in it (self.mount from the simulation's save);
//   - the boat broken under the player puts them off (a forced dismount from the simulation);
//   - a horse from a spawn egg; riding it untamed, the horse carries the player (the simulation drives it) and throws them off;
//     ridden again until tamed, then saddled (a request with the saddle held) and ridden with W: the simulation's horse follows the page's;
//     the HUD shows the horse's health;
//   - a lead on the horse: the player walks off and the horse follows (the simulation reads the player from the player message).
// Usage: NODE_PATH=$(npm root -g) node test/riding-protocol.js [modes=worker,server,page]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const lib = require('./lib');
const MODES = (process.argv[2] || process.env.BF_HOST || 'worker,server,page').split(',');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); if (!ok) fails++; };

async function run(b, url, mode) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { console.log('PAGEERROR', (e.stack || e.message).slice(0, 600)); fails++; });
  pg.on('console', m => { if (m.type() === 'error' && !/GL Driver|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) console.log('console.error:', m.text().slice(0, 400)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.goto(url + '?sim=' + mode);
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await pg.waitForFunction(() => !BF.preparing && BF.client, null, { timeout: 600000 });
  check(await pg.evaluate(() => BF.simHost.mode) === (mode === 'page' ? 'in page' : mode), `${mode}: the simulation runs ${{ worker: 'in the worker', server: 'on the world server', page: 'in the page' }[mode]}`);
  const tag = s => mode + ': ' + s;

  // ---- helpers
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query('stats', {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const query = (w, a) => pg.evaluate(([w, a]) => new Promise(r => BF.client.query(w, a, r)), [w, a]);
  const req = (kind, target, data) => pg.evaluate(([k, t, d]) => new Promise(r => BF.req.player(k, t, d).then(r)), [kind, target, data || {}]);
  const until = async (fn, arg, ms = 15000) => { try { await pg.waitForFunction(fn, arg, { timeout: ms, polling: 100 }); return true; } catch (_) { return false; } };
  const riding = () => pg.evaluate(() => { const v = BF.player.vehicle; return v ? { kind: v.kind, local: !!v.local, sid: v.sid != null ? v.sid : null } : null; });
  const me = () => pg.evaluate(() => { const p = BF.player.position; return { x: p.x, y: p.y, z: p.z }; });
  const hold = async (key, ms) => { await pg.keyboard.down(key); await pg.waitForTimeout(ms); await pg.keyboard.up(key); };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const slotOf = name => pg.evaluate(n => (BF.client.self.inv || []).findIndex(o => o && o.n === n), name);

  // ---- the world: a new creative world on flat ground near the spawn, walking (not flying)
  await pg.evaluate(async () => {
    BF.player.start();
    await BF.save.create({ name: "riding", seed: "3", gameMode: "creative", villages: 10 });
  });
  await pg.waitForTimeout(8000);
  await pg.evaluate(() => { BF.renderer.render = () => {}; });   // drawing off: the software renderer would make every frame slow
  // a flat stone floor 13 x 13 here with room above, put down by a player request (as the game does a placed block)
  const ground = await pg.evaluate(() => {
    const P = BF.player, p = P.position, W = BF.world;
    P.setFlying(false);
    const x = Math.floor(p.x), z = Math.floor(p.z), y = Math.max(W.heightAt(x, z), 1), cells = [];
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
      for (let k = -1; k <= 0; k++) cells.push([x + dx, y + k, z + dz, BF.B.stone, W.getBlock(x + dx, y + k, z + dz)]);
      for (let k = 1; k <= 4; k++) { const b = W.getBlock(x + dx, y + k, z + dz); if (b) cells.push([x + dx, y + k, z + dz, 0, b]); }
    }
    BF.req.player("player.place", x + "," + y + "," + z, { cells, consume: 0 });
    P.teleport(x + 0.5, y + 1.01, z + 0.5); P.setLook(0, 0);
    return { x, y: y + 1, z };
  });
  check(!!ground, tag('flat ground to ride on'), ground);
  if (!ground) { await ctx.close(); return; }
  await pg.waitForTimeout(1500); await settle();

  // ---- a boat: placed by a request, got into, rowed, got out of
  await req('player.boat', null, { boat: 'oak', eye: [ground.x + 0.5, ground.y + 1.6, ground.z - 2.5], dir: [0, -1, 0], yaw: 0, slot: 0 });
  await settle();
  const boatId = await pg.evaluate(g => { const e = [...BF.client.world.entities.values()].find(e => e.kind === 'boat' && Math.abs(e.x - g.x - 0.5) < 1 && Math.abs(e.z - g.z + 2.5) < 1.5); return e ? e.sid : null; }, ground);
  check(boatId != null, tag('a boat placed by a request, in the mirror with its id'), boatId);
  if (boatId != null) {
    const got = await req('player.mount', null, { id: boatId });
    await until(() => !!BF.player.vehicle);
    const r = await riding(), s1 = await query('entity', { id: boatId });
    check(got.ok && got.r === undefined ? true : got.ok, tag('player.mount is accepted'), got);
    check(r && r.kind === 'boat' && r.local === (mode !== 'page') && s1.ridden, tag('the player sits in the boat (self.mount off the page: the page rows its copy)'), { r, sim: s1 });
    const a0 = await query('entity', { id: boatId });
    await hold('KeyW', 2500); await settle(); await pg.waitForTimeout(300); await settle();
    const a1 = await query('entity', { id: boatId }), p1 = await me();
    const page = await pg.evaluate(() => { const v = BF.player.vehicle; const p = v && (v.pos || v.position); return p ? { x: p.x, z: p.z } : null; });
    check(dist(a0, a1) > 0.2, tag('W rows the boat: the simulation\'s boat moved'), { moved: +dist(a0, a1).toFixed(2) });
    check(page && dist(a1, page) < 0.3 && dist(p1, a1) < 1, tag('the simulation\'s boat is where the page\'s is, the player in it'), { sim: a1, page, me: p1 });
    // Shift: out (a request), beside the boat
    await hold('ShiftLeft', 200); await settle(); await pg.waitForTimeout(300); await settle();
    const out = await riding(), s2 = await query('entity', { id: boatId }), p2 = await me();
    check(!out && !s2.ridden && dist(p2, s2) > 0.4 && dist(p2, s2) < 3, tag('Shift gets out, beside the boat'), { riding: out, sim: s2.ridden, d: +dist(p2, s2).toFixed(2) });

    // the save keeps the player in the boat
    await req('player.mount', null, { id: boatId });
    await until(() => !!BF.player.vehicle);
    const id = await pg.evaluate(async () => { await BF.save.saveNow(); return BF.save.current && BF.save.current.id; });
    await pg.evaluate(async id => { await BF.save.load(id); }, id);
    await pg.waitForTimeout(3000); await settle();
    const back = await until(() => BF.player.vehicle && BF.player.vehicle.kind === 'boat', null, 20000);
    const nb = await pg.evaluate(() => { const e = [...BF.client.world.entities.values()].find(e => e.kind === 'boat' && e.rider); return e ? e.sid : null; });
    check(back && nb != null, tag('after saving and loading, the player is back in the boat'), { back, boat: nb });
    // the boat broken under the player puts them off (the simulation dismounts them)
    if (nb != null) {
      await req('player.hitBoat', null, { boat: nb, creative: true });
      const off = await until(() => !BF.player.vehicle, null, 10000);
      const gone = await query('entity', { id: nb });
      check(off && !gone.ok, tag('the boat broken under the player puts them off'), { off, boat: gone });
    }
  }

  // ---- a horse: untamed, the simulation drives it and throws the player; tamed, saddled, the page rides it
  await pg.evaluate(() => { const P = BF.player; P.setFlying(false); });
  const g2 = await me();
  const cell = Math.floor(g2.x) + ',' + (Math.floor(g2.y) - 1) + ',' + (Math.floor(g2.z) - 3);
  await req('player.horseEgg', cell, { slot: 0 });
  await settle(); await pg.waitForTimeout(500); await settle();
  const horseId = await pg.evaluate(p => { const e = [...BF.client.world.entities.values()].filter(e => e.kind === 'mob' && e.type === 'horse' && !e.dead).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0]; return e ? e.sid : null; }, g2);
  check(horseId != null, tag('a horse from a spawn egg'), horseId);
  if (horseId != null) {
    let h = await query('entity', { id: horseId });
    const mounted = await req('player.mount', null, { id: horseId });
    await until(() => !!BF.player.vehicle, null, 5000);
    const r = await riding();
    check(mounted.ok && r && r.kind === 'horse' && (mode === 'page' || r.local), tag('on the untamed horse (off the page: seated on the mirror\'s horse)'), { mounted, r });
    // carried, then thrown (or tamed at once)
    const t0 = Date.now();
    let followed = true, thrown = false, rodeFor = 0;
    while (Date.now() - t0 < 20000) {
      await pg.waitForTimeout(250);
      const [hv, pv, rv] = [await query('entity', { id: horseId }), await me(), await riding()];
      if (!rv) { thrown = true; break; }
      rodeFor = (Date.now() - t0) / 1000;
      if (hv.ok && dist(hv, pv) > 1.2) followed = false;
      if (hv.horse && hv.horse.tamed) break;
    }
    h = await query('entity', { id: horseId });
    check(followed && (thrown || h.horse.tamed), tag('the horse carries the player (the simulation drives it) and throws them or is tamed'), { thrown, tamed: h.horse.tamed, rodeFor });
    // ridden until it is tamed
    for (let i = 0; i < 60 && !h.horse.tamed; i++) {
      if (!(await riding())) await req('player.mount', null, { id: horseId });
      await pg.waitForTimeout(1000);
      h = await query('entity', { id: horseId });
    }
    check(h.horse.tamed, tag('ridden until tamed'), h.horse);
    if (await riding()) { await hold('ShiftLeft', 200); await settle(); await until(() => !BF.player.vehicle, null, 5000); }
    // a saddle: given, then used on the horse (a request with the saddle held)
    await pg.evaluate(() => BF.commands.execute('/give saddle 1'));
    await until(() => (BF.client.self.inv || []).some(o => o && o.n === 'saddle'), null, 5000);
    const ss = await slotOf('saddle');
    const sr = await req('player.mob', null, { mob: horseId, what: 'horse', slot: ss });
    h = await query('entity', { id: horseId });
    check(h.horse.saddle, tag('saddled by a request with the saddle held'), { r: sr, horse: h.horse });
    // ride it: the page steers its copy, the simulation's horse follows
    // (a CI flake had riding() null here: on a failure, the mount's answer and both sides' state say why)
    const asked = await req('player.mount', null, { id: horseId });
    await until(() => !!BF.player.vehicle, null, 5000);
    const r2 = await riding();
    check(r2 && r2.kind === 'horse' && (mode === 'page' || r2.local), tag('on the saddled horse (off the page: the page rides its copy)'),
      r2 ? r2 : { r2, asked, horse: await query('entity', { id: horseId }), me: await me(), vehicle: await pg.evaluate(() => !!BF.player.vehicle) });
    const hud = await pg.evaluate(() => { const v = BF.player.vehicle; return v && v.ctl.hud ? v.ctl.hud(v) : null; });
    check(hud && hud.hp > 0 && hud.max >= hud.hp, tag('the HUD has the horse\'s health'), hud);
    const b0 = await query('entity', { id: horseId });
    // facing the floor's middle: the untamed rides may have left the horse at its edge, facing the hill beyond (a flake in CI)
    const yaw0 = Math.atan2(-(ground.x + 0.5 - b0.x), -(ground.z + 0.5 - b0.z));
    await pg.evaluate(y => BF.player.setLook(y, 0), yaw0);
    // (a second of W, more while it hasn't gone a block: on a slow runner the page's frames, and so its horse, can lag. The untamed rides
    // can also leave the horse off the floor, wedged in a corner of the hill beyond, where W towards the middle goes nowhere (a CI flake:
    // moved 0.68): after two tries it turns a quarter each try, so some way out is open)
    let b1, p3, from = b0, best = 0;
    for (let t = 0; t < 6; t++) {
      if (t >= 2) { from = b1; await pg.evaluate(y => BF.player.setLook(y, 0), yaw0 + (t - 1) * Math.PI / 2); }
      await hold('KeyW', t ? 500 : 1000); await settle(); await pg.waitForTimeout(300); await settle();
      b1 = await query('entity', { id: horseId }); p3 = await me();
      best = Math.max(best, dist(from, b1));
      if (best > 1) break;
    }
    check(best > 1, tag('W rides the horse: the simulation\'s horse moved'), { moved: +best.toFixed(2), at: [b1.x, b1.y, b1.z], floor: ground });
    check(dist(p3, b1) < 0.6, tag('the simulation\'s horse is under the player'), { horse: b1, me: p3 });
    await hold('ShiftLeft', 200); await settle();
    check(await until(() => !BF.player.vehicle, null, 5000), tag('Shift gets off the horse'));
    // a lead: the player walks off and the horse follows
    await pg.evaluate(() => BF.commands.execute('/give lead 1'));
    await until(() => (BF.client.self.inv || []).some(o => o && o.n === 'lead'), null, 5000);
    const ls = await slotOf('lead');
    await req('player.mob', null, { mob: horseId, what: 'horse', slot: ls });
    h = await query('entity', { id: horseId });
    check(h.horse.lead === 'player', tag('the horse on the player\'s lead'), h.horse);
    const c0 = await query('entity', { id: horseId });
    await pg.evaluate(c => { const P = BF.player, p = P.position; const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz) || 1; P.teleport(p.x + dx / d * 6, p.y + 1, p.z + dz / d * 6); }, c0);
    await pg.waitForTimeout(5000); await settle();
    const c1 = await query('entity', { id: horseId }), p4 = await me();
    check(dist(c1, p4) < dist(c0, p4) - 1.5, tag('the led horse follows the player'), { before: +dist(c0, p4).toFixed(2), after: +dist(c1, p4).toFixed(2) });
  }
  const errs = await pg.evaluate(() => (BF.client.world.log || []).filter(e => e.l === "ERROR").map(e => e.x).slice(0, 5));
  check(!errs.length, tag('no ERROR in the game log'), errs);
  await ctx.close();
}

(async () => {
  const srv = await lib.serve(), url = srv.url;   // (with the world server; ?sim=worker and ?sim=page leave it idle)
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    for (const m of MODES) await run(b, url, m);
  } catch (e) { console.log('FAIL ' + (e.stack || e)); fails++; }
  await b.close(); await srv.stop();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
