// Shared test helpers. toVillage: moves the player into the village nearest to where they are (spawn, on a fresh planet) and waits
// for it to load (where the simulation is: any host).
exports.toVillage = async pg => {
  await exports.ready(pg);
  await pg.evaluate(() => {
    const P = BF.planet, p = BF.player.position;
    // (0, 0) is off the atlas, so the village nearest the player (spawn), within 6 km round the planet
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  });
  await pg.waitForTimeout(9000);
  // the planet's chunks take longer to generate: wait (up to 40 s more) for the village's villagers to be out
  for (let i = 0; i < 40; i++) {
    if (await exports.sim(pg, () => { const r = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z); return !!(r && r.members && r.members.some(m => m.type === "villager")); })) break;
    await pg.waitForTimeout(1000);
  }
};
// ready: waits until a planet's river step (spec r14-10) is done, after a boot or a newWorld on a new seed.
exports.ready = pg => pg.waitForFunction(() => window.BF && !BF.preparing, null, { timeout: 180000, polling: 200 });
// install: puts window.BFT (test/bft.js, the in-page test helpers) into a page a node test made; call it before the page's goto.
exports.install = pg => pg.addInitScript({ path: require('path').join(__dirname, 'bft.js') });

// ---- the simulation's host (spec r15-43). BF_HOST=page|worker|server (test/ci.js --host, test/run.js) says where a test that supports
// it runs the game's simulation; unset, the page (as every test did before 1.5). A test opts in with `hosts=worker,server` in its
// // @ci header; tests that don't stay in the page whatever BF_HOST says (they read the page's own simulation modules).
// host(): the host asked for. q(): the address's query part for it ("sim=page"). sim(pg, fn, arg): runs fn(arg) where the simulation
// is (the page, the Web Worker or the world server's thread) and resolves its result (JSON); fn must not use anything outside itself.
exports.host = () => { const h = process.env.BF_HOST || 'page'; if (!['page', 'worker', 'server'].includes(h)) throw new Error('BF_HOST must be page, worker or server, not ' + h); return h; };
exports.q = () => 'sim=' + exports.host();
exports.sim = (pg, fn, arg) => pg.evaluate(([src, a]) => BF.simHost.eval(src, a), [String(fn), arg === undefined ? null : arg]);   // (= BFT.sim; a page without test/bft.js too)
// alone(pg, on): the page stops (on) or starts again (off) sending its player's body and speed to the simulation, for a test that drives
// the player where the simulation is (its own world, a boat ride) and must not have the page's body put back every frame
exports.alone = (pg, on) => pg.evaluate(on => {
  const H = BF.simHost;
  if (on && !H.heldFrame) { H.heldFrame = H.frame; H.frame = () => {}; } else if (!on && H.heldFrame) { H.frame = H.heldFrame; delete H.heldFrame; }
}, !!on);
// newWorld(pg, seed, opts): a new world (not saved) in the page and where the simulation is, as the title screen's world starts
// (js/main.js boot): its rivers first, the page's copy, then the simulation's; waits until the simulation runs it
exports.newWorld = async (pg, seed, opts) => {
  await pg.evaluate(async ([seed, opts]) => {
    await BF.prepareWorld(seed);
    BF.newWorld(seed, opts);
    if (BF.simHost.worker) { const r = await BF.simHost.demo(seed, opts); if (r && r.ok === false) throw new Error('the simulation could not start the world: ' + r.why); }
  }, [seed, opts || {}]);
  if (exports.host() !== 'page') await exports.sim(pg, async seed => { for (let i = 0; i < 600 && !(BF.state.seed === seed && BF.rand.tick > 20); i++) await new Promise(r => setTimeout(r, 100)); }, seed);
};
// give(pg, names, sel): the player's inventory emptied and filled with one of each item name, where the simulation is; the page selects
// hotbar slot sel (the selected slot is the page's) and waits until its hotbar shows them
exports.give = async (pg, names, sel = 0) => {
  await exports.sim(pg, names => { const inv = BF.inventory; inv.clear(); for (const n of names) inv.add(BF.I[n], 1); BF.proto.flush(); }, names);
  await pg.evaluate(sel => BF.inventory.select(sel), sel);
  await pg.waitForFunction(n => BF.inventory.slots.filter(Boolean).length === n, names.length, { timeout: 20000 });
};
// serve(opts): debug/server.js on free ports, for a test served over http: {url (the game's index.html), debugUrl, game, debug, srv,
// stop()}. The world server runs (with --test, so BFT.sim works there, and saves in a temp folder) unless opts.world is false;
// opts.args adds arguments (e.g. ['--alerts', file]).
exports.freePort = () => new Promise(res => { const s = require('net').createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
exports.serve = async (opts = {}) => {
  const path = require('path'), cp = require('child_process'), os = require('os'), fs = require('fs');
  const game = opts.game || await exports.freePort(), debug = opts.debug || await exports.freePort();
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-saves-'));
  const args = [path.join(__dirname, '..', 'debug/server.js'), '--game', String(game), '--debug', String(debug), '--saves', saves, '--test', ...(opts.world === false ? ['--no-world'] : []),
    ...((opts.args || []).includes('--alerts') ? [] : ['--alerts', path.join(saves, 'alerts.json')]), ...(opts.args || [])];   // (the debug screen's alerts: not debug/.alerts.json)
  const srv = cp.spawn(process.execPath, args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + out)), 20000);
    srv.stdout.on('data', d => { out += d; if (/Ctrl\+C/.test(out)) { clearTimeout(t); res(); } });
    srv.stderr.on('data', d => { out += d; });
    srv.on('exit', c => { clearTimeout(t); rej(new Error('debug/server.js exited ' + c + ': ' + out)); });
  });
  srv.stdout.on('data', d => { if (opts.verbose) process.stdout.write('SERVER ' + d); });
  srv.stderr.on('data', d => process.stdout.write('SERVER ' + d));
  return { srv, game, debug, url: 'http://localhost:' + game + '/index.html', debugUrl: 'http://localhost:' + debug + '/',
    stop: () => new Promise(res => { if (srv.exitCode != null) { res(); return; } srv.once('exit', () => { try { fs.rmSync(saves, { recursive: true, force: true }); } catch (e) {} res(); }); srv.kill('SIGKILL'); }) };
};
// where(pg): {host, mode, label} as the page reports it, to check the test runs where it asked
exports.where = pg => pg.evaluate(() => ({ mode: BF.simHost.mode, label: BF.simHost.label() }));
// simReady(pg): with the simulation off the page, waits until the world it plays has ticked a couple of seconds (the world server may
// first solve the planet's rivers), so a test's first BFT.sim sees the world the page shows
exports.simReady = pg => pg.waitForFunction(() => !BF.simHost.worker || (BF.client && BF.client.world.clock && BF.client.world.clock.tick > 40 && BF.client.world.entities.size > 0), null, { timeout: 300000, polling: 250 });
