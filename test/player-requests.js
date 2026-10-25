// @ci integration suite=items,ui timeout=900
// Player and command actions as tick-stamped requests (spec r15-20, js/requests.js player()). Two fresh pages of seed 123, the frame
// loop held, moved to the village nearest the spawn:
// - page 1 plays a scripted two-minute session (2,400 ticks of the main loop's sim step) while recording its input: walking, breaking
//   and placing blocks through the player's own code (creative), /fill and /give, a chest filled and emptied through its screen, a
//   trade on a villager's screen, a door. Each action must go through the request queue (counted by kind), leave no direct writes from
//   the player's modules, and change the world at once.
// - page 2 replays the recording from the same start, and the two world state hashes (js/statehash.js) are compared at the end.
// - then on page 1: the player sorts before villagers, a villager's request for a block the player has just broken is refused, and at
//   0x (frozen) the player's edits still apply.
// Usage: NODE_PATH=$(npm root -g) node test/player-requests.js [steps=2400]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const STEPS = +(process.argv[2] || 2400);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

async function boot(b, n) {
  const pg = await (await b.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  pg.on('pageerror', e => console.log(`PAGEERROR [page ${n}]`, (e.stack || e.message).slice(0, 500)));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.__halt = true; window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { const v = document.getElementById('view'); if (v) v.requestPointerLock = null; }));
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto('file://' + path.join(root, 'index.html') + '?debugfeed=off#seed123gen4v10');
  await require('./lib').ready(pg);
  await pg.evaluate(() => {
    BF.player.start(); BF.player.setGameMode('creative'); BF.player.setFlying(true);
    const P = BF.planet, p = BF.player.position;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
    window.__load = k => { const p = BF.player.position; for (let i = 0; i < k; i++) BF.world.update(p.x, p.z, 8); };
  });
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const c = await pg.evaluate(() => { window.__load(20); return BF.world.chunks.size; });
    if (c === last && i > 5) break;
    last = c; await pg.waitForTimeout(250);
  }
  return pg;
}

// The scripted session, in the page: `steps` ticks of BF.simStep, and at set ticks something the player does at the tick boundary that
// follows. Returns what it saw along the way. No chunks are streamed during the session (in either page): a planet's chunk generation
// is partly asynchronous, so streaming would make the two pages differ whatever the player does (r15-24's report).
function session(steps) {
  const W = BF.world, P = BF.player, I = BF.inventory, R = BF.req, out = { log: [], fails: [] };
  const say = (ok, what) => { if (!ok) out.fails.push(what); else out.log.push(what); };
  const sent = k => (R.stats().byKind[k] || { applied: 0 }).applied;
  const settle = () => { P.setMouse(false, false); for (let i = 0; i < 6; i++) P.update(0.05); };
  // aim at a block's centre, or (top) its top face
  const aim = (x, y, z, top) => { const e = P.eyePos(), tx = x + 0.5 - e.x, ty = y + (top ? 0.98 : 0.5) - e.y, tz = z + 0.5 - e.z; P.setLook(Math.atan2(-tx, -tz), Math.atan2(ty, Math.hypot(tx, tz))); P.update(0.016); };
  const slot = (c, i) => document.querySelector(`.bf-slot[data-c="${c}"][data-i="${i}"]`);
  const press = (el, shift) => {
    const r = el.getBoundingClientRect(), o = { bubbles: true, button: 0, pointerType: 'mouse', shiftKey: !!shift, clientX: r.x + 4, clientY: r.y + 4 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o));
  };
  const cmd = t => BF.commands.execute(t);
  const rc = (x, y, z) => { const p = P.position; return `~${x - Math.floor(p.x)} ~${y - Math.floor(p.y)} ~${z - Math.floor(p.z)}`; };   // a cell in the command's terms
  // the work spot: out of the village (villagers and golems wander into a click), the nearest loaded spot 24 or more blocks east
  const p0 = P.position.clone(), Z = Math.floor(p0.z);
  let X = Math.floor(p0.x) + 24;
  while (!W.isLoaded(X + 6, Z + 4) && X > p0.x + 8) X--;
  const gy = W.heightAt(X + 3, Z);
  let n = 0, chest = null;
  const home = () => { P.teleport(X + 3.5, gy + 3.2, Z + 0.5); P.setFlying(true); settle(); };   // hovering over the platform, everything in reach
  const acts = {
    20: () => {   // a platform by command, then break one of its blocks with the player's own breaking
      cmd(`/fill ${rc(X + 1, gy + 1, Z - 3)} ${rc(X + 5, gy + 6, Z + 3)} air`);   // room to work in
      const before = sent('command');
      cmd(`/fill ${rc(X + 2, gy + 1, Z - 1)} ${rc(X + 4, gy + 1, Z + 1)} stone`);
      say(sent('command') === before + 1 && W.getBlock(X + 3, gy + 1, Z) === BF.B.stone, '/fill is one command request and fills at once');
      home();
      aim(X + 3, gy + 1, Z); const b = sent('player.break');
      P.setMouse(true, false); P.update(0.016); P.setMouse(false, false);
      say(sent('player.break') === b + 1 && W.getBlock(X + 3, gy + 1, Z) === 0, 'breaking (creative) is a player.break request and the block is gone at once');
    },
    200: () => {   // cobblestone on top of the platform
      home();
      cmd('/give cobblestone 16'); I.select(I.slots.findIndex(s => s && s.id === BF.B.cobblestone)); settle();
      aim(X + 4, gy + 1, Z + 1, true); const b = sent('player.place'), t = P.target, tw = t ? [t.x - X, t.y - gy, t.z - Z, t.id].join(' ') : 'none';
      P.setMouse(false, true); P.setMouse(false, false);
      say(sent('player.place') === b + 1 && W.getBlock(X + 4, gy + 2, Z + 1) === BF.B.cobblestone, `placing is a player.place request and the block is there at once (aimed at ${tw}, got ${W.getBlock(X + 4, gy + 2, Z + 1)}, held ${JSON.stringify(I.slots[I.selectedIndex])}, mobs near ${BF.mobs.list.filter(m => m.position && Math.hypot(m.position.x - X - 4.5, m.position.z - Z - 1.5) < 3).map(m => m.type + '@' + [m.position.x - X, m.position.y - gy, m.position.z - Z].map(v => v.toFixed(1))).join(' ')}, mouse ${JSON.stringify(P.clickLog().slice(-2))})`);
    },
    400: () => {   // a chest: placed, filled through its screen, half emptied again
      home();
      cmd('/give chest 1'); cmd('/give oak_log 20'); I.select(I.slots.findIndex(s => s && s.id === BF.B.chest)); settle();
      aim(X + 2, gy + 1, Z + 1, true);
      P.setMouse(false, true); P.setMouse(false, false);
      const c = [X + 2, gy + 2, Z + 1];
      say(BF.isChest(W.getBlock(...c)), 'the chest is placed');
      settle(); aim(...c);
      const b = sent('player.screen');
      P.setMouse(false, true); P.setMouse(false, false);
      say(I.mode === 'chest' && sent('player.screen') === b + 1, 'opening the chest is a player.screen request');
      const k = I.slots.findIndex(s => s && s.id === BF.B.oak_log), clicks = sent('player.click');
      if (k >= 0 && slot('inv', k)) press(slot('inv', k), true);
      const st = I.chestState(...c), inChest = st ? st.slots.reduce((a, s) => a + (s && s.id === BF.B.oak_log ? s.count : 0), 0) : 0;
      say(inChest === 20 && sent('player.click') === clicks + 1, `shift-clicking the logs into the chest is a player.click request (${inChest} in the chest)`);
      const ci = st ? st.slots.findIndex(s => s && s.id === BF.B.oak_log) : -1;
      if (ci >= 0 && slot('chest', ci)) { press(slot('chest', ci)); if (slot('inv', 30)) press(slot('inv', 30)); }   // pick up, put down
      I.close();
      say(I.mode == null, 'the chest screen closes');
      chest = c;
    },
    700: () => {   // a trade: the nearest villager's screen, its first offer that can be done, shift-clicked
      const vs = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && m.position).sort((a, b) => a.position.distanceTo(P.position) - b.position.distanceTo(P.position));
      let v = null, i = -1;
      for (const m of vs) {
        I.openTrade(m);
        i = m.trades.findIndex(o => !BF.trades.blockReason(m, o) && !o.horse);
        if (i >= 0) { v = m; break; }
        I.close();
      }
      if (!v) { say(false, `a villager with an offer to take (${vs.length} villagers)`); return; }
      const o = v.trades[i];
      for (const b of o.buy) cmd(`/give ${BF.items[b.id].name} ${b.n * 2}`);
      const row = document.querySelector(`.bf-offer[data-i="${i}"]`);
      const before = I.slots.reduce((a, s) => a + (s && s.id === o.sell.id ? s.count : 0), 0), offers = sent('player.offer'), clicks = sent('player.click');
      if (row) row.click();
      if (slot('tres', 0)) press(slot('tres', 0), true);
      I.close();
      const after = I.slots.reduce((a, s) => a + (s && s.id === o.sell.id ? s.count : 0), 0);
      say(after > before && sent('player.offer') === offers + 1 && sent('player.click') >= clicks + 1, `the trade (${BF.items[o.sell.id].name}) went through as player.offer and player.click requests (${before} -> ${after})`);
    },
    1000: () => {   // a door, placed and opened
      home();
      cmd('/give oak_door 1'); I.select(I.slots.findIndex(s => s && s.id === BF.I.oak_door)); settle();
      aim(X + 4, gy + 1, Z - 1);
      P.setMouse(false, true); P.setMouse(false, false);
      const d = W.getBlock(X + 4, gy + 2, Z - 1), b = sent('player.door');
      settle(); aim(X + 4, gy + 2, Z - 1);
      P.setMouse(false, true); P.setMouse(false, false);
      say(BF.blocks[d] && BF.blocks[d].door && W.getBlock(X + 4, gy + 2, Z - 1) !== d && sent('player.door') === b + 1, 'a door placed and opened by player requests');
    },
    1300: () => { cmd(`/setblock ${rc(X + 2, gy + 2, Z - 1)} glass`); cmd('/time add 600'); cmd('/weather rain'); },
    1600: () => {   // more mining: three blocks of the platform
      home();
      for (const dz of [-1, 0, 1]) { settle(); aim(X + 3, gy + 1, Z + dz); P.setMouse(true, false); P.update(0.016); P.setMouse(false, false); }
    },
  };
  for (let i = 0; i < steps; i++) {
    BF.simStep(BF.warp.TICK);
    if (i % 40 === 0 && i > 0) { P.position.z += n % 2 ? -0.25 : 0.25; n++; }   // stepping back and forth (the pose is in the log)
    if (acts[i]) { try { acts[i](); } catch (e) { out.fails.push('step ' + i + ': ' + (e.stack || e)); } }
  }
  out.walked = n;
  out.chest = chest;
  return out;
}

(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t0 = Date.now();
  const pages = await Promise.all([boot(b, 1), boot(b, 2)]);
  const ticks = await Promise.all(pages.map(pg => pg.evaluate(() => BF.rand.tick)));
  console.log(`booted seed 123 twice in ${((Date.now() - t0) / 1000).toFixed(0)} s, at ticks ${ticks.join(' / ')}`);
  const h0 = await Promise.all(pages.map(pg => pg.evaluate(() => BF.stateHash.full().hash)));
  check(h0[0] === h0[1], `the two fresh pages start with the same hash (${h0.join(' / ')})`);

  // 1. the recorded session on page 1
  const [A, B] = pages;
  await A.evaluate(() => { BF.req.resetStats(); BF.req.record(); });
  const s = await A.evaluate(session, STEPS);
  for (const l of s.log) check(true, l);
  for (const f of s.fails) check(false, f);
  const rec = await A.evaluate(() => BF.req.record(false));
  const kinds = {};
  for (const e of rec) if (e.kind) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log(`recorded ${rec.length} entries over ${STEPS} ticks: ${Object.entries(kinds).map(([k, n]) => k + ' ' + n).join(', ')}; ${rec.filter(e => !e.kind).length} poses`);
  check(rec.length > 0 && JSON.parse(JSON.stringify(rec)).length === rec.length, 'the input log is plain data');
  const direct = await A.evaluate(() => BF.req.stats().direct);
  console.log('direct writes during the session: ' + JSON.stringify(direct));
  check(!direct.player && !direct.commands && !direct.inventory && !direct.signs, 'no direct world writes from the player, commands, inventory or signs');

  // 2. the replay on page 2, from the same start
  await B.evaluate(r => { BF.req.resetStats(); BF.req.replay(r); }, rec);
  await B.evaluate(steps => { for (let i = 0; i < steps; i++) BF.simStep(BF.warp.TICK); return BF.req.replayFlush(); }, STEPS);
  const rk = await B.evaluate(() => BF.req.stats().byKind);
  const same = Object.keys(kinds).every(k => rk[k] && rk[k].applied >= kinds[k]);
  check(same, `the replay applied every recorded request (${Object.keys(kinds).map(k => k + ' ' + (rk[k] ? rk[k].applied : 0)).join(', ')})`);
  // (the professions' visual arm swings, ai.swingT, and the mobs' sound timers, _snd*, are drawn or heard only: js/statehash.js leaves them out)
  const [ha, hb] = await Promise.all(pages.map(pg => pg.evaluate(() => BF.stateHash.full())));
  const differ = Object.keys(ha.parts).filter(k => ha.parts[k] !== hb.parts[k]);
  for (const k of differ) {
    const [x, y] = await Promise.all(pages.map(pg => pg.evaluate(k => BF.stateHash.text(k), k)));
    let i = 0; while (i < x.length && x[i] === y[i]) i++;
    const cut = t => JSON.stringify(t.slice(Math.max(0, i - 160), i + 120));
    console.log(`  ${k} first differs at character ${i} of ${x.length} / ${y.length}:\n    recorded ${cut(x)}\n    replayed ${cut(y)}`);
  }
  check(ha.hash === hb.hash, `the replay gives the same world state hash (${ha.hash} / ${hb.hash}${differ.length ? ', parts differing: ' + differ.join(', ') : ''})`);
  const chestSame = await Promise.all(pages.map(pg => pg.evaluate(c => JSON.stringify(c && BF.inventory.chestState(...c)), s.chest)));
  check(chestSame[0] === chestSame[1] && chestSame[0] !== 'null', 'the chest holds the same in both');

  // 3. ordering and conflicts, on page 1
  const o = await A.evaluate(() => {
    const W = BF.world, R = BF.req, P = BF.player, r = {};
    r.order = R.order({ from: 'player', seq: 9 }, { from: 'e1', seq: 1 }) < 0 && R.order({ from: 'e1', seq: 1 }, { from: 'player', seq: 9 }) > 0;
    // a villager asked for a block (queued for the next tick's apply), then the player breaks it at this boundary: the villager is refused
    const v = BF.mobs.list.find(m => m.type === 'villager' && !m.dead && BF.ids.idOf(m));
    const p = P.position, x = Math.floor(p.x) + 1, z = Math.floor(p.z), y = W.heightAt(x, z) + 1;
    W.setBlock(x, y, z, BF.B.stone);
    const vr = R.send('setBlock', x + ',' + y + ',' + z, { id: 0, expect: BF.B.stone, drop: true }, v);
    r.player = R.player('player.break', x + ',' + y + ',' + z, { id: BF.B.stone, harvest: false, slot: BF.inventory.selectedIndex }).result;
    BF.simStep(BF.warp.TICK);
    r.villager = vr.result;
    // frozen: no ticks run, and a player edit still applies at once
    BF.warp.freeze();
    W.setBlock(x, y, z, BF.B.dirt);
    const t = BF.rand.tick;
    r.frozen = R.player('player.break', x + ',' + y + ',' + z, { id: BF.B.dirt, harvest: false, slot: BF.inventory.selectedIndex }).result.ok && W.getBlock(x, y, z) === 0 && BF.rand.tick === t;
    BF.warp.set(0);
    // a request for a block that has changed is refused, and logged
    r.stale = R.player('player.break', x + ',' + y + ',' + z, { id: BF.B.stone, harvest: false }).result;
    r.logged = BF.glog && BF.glog.recent ? BF.glog.recent(50).some(e => /Player request player\.break .* refused \(changed\)/.test(e.text || e.t || JSON.stringify(e))) : null;
    return r;
  });
  check(o.order, 'the player sorts before every villager in the same tick');
  check(o.player && o.player.ok, 'the player breaks the block at the tick boundary');
  check(o.villager && !o.villager.ok && o.villager.why === 'changed', `a villager's request for the same block in the next tick is refused (${JSON.stringify(o.villager)})`);
  check(o.frozen, 'at 0x the player\'s edit applies at once and no tick runs');
  check(o.stale && !o.stale.ok && o.stale.why === 'changed', 'a player request for a block that changed is refused');
  if (o.logged !== null) check(o.logged, 'the refusal is in the game log (INFO, Request queue)');
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await b.close();
  if (fails) { console.log(`FAIL ${fails} check(s)`); process.exit(1); }
  console.log('player-requests: all ok');
})().catch(e => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
