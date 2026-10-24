// @ci integration suite=ui,items timeout=1800
// The inventory screens over the protocol (spec r15-44): js/invscreen.js draws from self messages (inv, cursor, screen) and the chest,
// trades and furnace queries, and sends every action as a player request; js/playerinv.js holds the items wherever the simulation runs.
// Served over http (debug/server.js on free ports), seed 3, a new world at the village nearest the spawn, once with the simulation in a
// worker (?sim=worker) and once forced into the page (?sim=page). With the real mouse and keys on the page's screens:
//   - creative: palette picks from the search tab (left: a stack, right: one), a palette shift-click, the trash;
//   - the inventory: left, right and shift clicks, a drag-split over the grid, crafting a stack with shift, closing with items on the
//     cursor and in the grid (they come back);
//   - the crafting table (a drag-split over four cells, a shift-craft), the furnace (shift-clicks load it, it cooks while open, the output
//     is taken), the chest (shift, left and right clicks, closing with the cursor), the chest broken while its screen is open (the screen
//     closes, the items drop), a villager's trade (an offer chosen, auto-filled, shift-traded);
//   - item totals (inventory, cursor, grid, payment, the chest and the furnace, all as the page sees them) after each step;
//   - the state hash's chests part and the inventory are the same in both modes;
//   - worker mode: the time from a click to the self message that redraws it (printed for the report).
// Usage: NODE_PATH=$(npm root -g) node test/screens-protocol.js [modes=worker,page]
const path = require('path'), cp = require('child_process'), net = require('net');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const MODES = (process.argv[2] || 'worker,page').split(',');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function server() {
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('debug/server.js did not start: ' + out)), 20000);
    srv.stdout.on('data', d => { out += d; if (/Ctrl\+C/.test(out)) { clearTimeout(t); res(); } });
    srv.on('exit', c => rej(new Error('debug/server.js exited ' + c + ': ' + out)));
  });
  return { srv, url: 'http://localhost:' + game + '/index.html' };
}

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
  check(await pg.evaluate(() => BF.simHost.mode) === (mode === 'worker' ? 'worker' : 'in page'), `${mode}: the simulation runs ${mode === 'worker' ? 'in the worker' : 'in the page'}`);
  const tag = s => mode + ': ' + s;

  // ---- helpers: a round trip (requests and queries are answered in order, so the self after the last request is in), frames
  const settle = () => pg.evaluate(() => new Promise(r => BF.client.query('stats', {}, () => requestAnimationFrame(() => requestAnimationFrame(r)))));
  const I = await pg.evaluate(() => { const o = {}; for (const n of ['planks', 'cobblestone', 'raw_beef', 'steak', 'coal', 'emerald', 'dirt', 'stick', 'crafting_table', 'chest', 'furnace']) o[n] = BF.I[n]; return o; });
  const box = async sel => { const r = await pg.$eval(sel, e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }; }); return r; };
  const slotSel = (c, i) => `.bf-inv-back.open [data-c="${c}"][data-i="${i}"]`;
  async function click(c, i, button = 'left', shift = false) {
    const p = await box(slotSel(c, i));
    if (shift) await pg.keyboard.down('Shift');
    await pg.mouse.move(p.x, p.y); await pg.mouse.down({ button }); await pg.mouse.up({ button });
    if (shift) await pg.keyboard.up('Shift');
    await settle();
  }
  async function dragOver(button, list) {   // list: [[c, i], ...]: down on the first, over the rest, up
    const ps = [];
    for (const [c, i] of list) ps.push(await box(slotSel(c, i)));
    await pg.mouse.move(ps[0].x, ps[0].y); await pg.mouse.down({ button });
    for (const p of ps.slice(1)) { await pg.mouse.move(p.x - 3, p.y - 3, { steps: 3 }); await pg.mouse.move(p.x, p.y, { steps: 2 }); }
    await pg.mouse.up({ button });
    await settle();
  }
  // what the page sees: the player's slots, the cursor and the open screen (self), and a chest / furnace (queries)
  const seen = (chest, furn) => pg.evaluate(async ({ chest, furn }) => {
    const q = (w, a) => new Promise(r => BF.client.query(w, a, r));
    const s = BF.client.self || {}, sc = s.screen || null;
    const inv = (s.inv || []).map(o => (o ? { id: BF.resolveItem ? BF.resolveItem(o.n) : BF.I[o.n], count: o.c } : null));
    const c = chest ? await q('chest', chest) : null, f = furn ? await q('furnace', furn) : null;
    return { inv, cursor: s.cursor || null, screen: sc, chest: c && c.ok ? c.slots : null, chestGone: !!(c && !c.ok), furnace: f && f.ok ? f : null, open: BF.inventory.isOpen(), pageMode: BF.inventory.mode };
  }, { chest, furn });
  const totals = v => {
    const t = {}, add = s => { if (s) t[s.id] = (t[s.id] || 0) + s.count; };
    v.inv.forEach(add); add(v.cursor);
    if (v.screen) { v.screen.grid.forEach(add); v.screen.pay.forEach(add); }
    if (v.chest) v.chest.forEach(add);
    if (v.furnace) v.furnace.slots.forEach(add);
    return t;
  };
  const same = (a, b) => JSON.stringify(Object.keys(Object.assign({}, a, b)).sort().map(k => [k, a[k] || 0])) === JSON.stringify(Object.keys(Object.assign({}, a, b)).sort().map(k => [k, b[k] || 0]));
  const count = (v, id) => totals(v)[id] || 0;

  // ---- the world: a new creative world at the village nearest the spawn; a chest and a furnace placed beside the player
  const w = await pg.evaluate(async () => {
    BF.player.start();
    await BF.save.create({ name: "screens", seed: "3", gameMode: "creative", villages: 10 });
    const p = BF.player.position, P = BF.planet;
    const v = BF.worldgen.villagesNear(p.x, p.z, 6000).sort((a, b) => P.distance(p, a) - P.distance(p, b))[0];
    if (v) { BF.player.setFlying(true); BF.player.teleport(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 12, v.z + 0.5); }
    return { village: !!v };
  });
  check(w.village, tag('at the village nearest the spawn'));
  await pg.waitForTimeout(8000);
  await pg.evaluate(() => { BF.renderer.render = () => {}; });   // drawing off: the software renderer would make every frame slow (the screens are DOM)
  // a chest and a furnace beside the player by player requests. A request names what the cell held as the page's copy of the world
  // has it; in the worker that copy can be a message behind (leaves, growth), and the simulation refuses it as changed: ask again.
  const spots = await pg.evaluate(() => {
    const p = BF.player.position, x = Math.floor(p.x), y = Math.floor(p.y) + 3, z = Math.floor(p.z);
    return { chest: { x: x + 2, y, z }, furn: { x: x - 2, y, z } };
  });
  const placed = s => BF.world.getBlock(s.chest.x, s.chest.y, s.chest.z) === BF.B.chest && BF.world.getBlock(s.furn.x, s.furn.y, s.furn.z) === BF.B.furnace;
  // The simulation refuses a block in a chunk it hasn't loaded yet: on a slow runner the worker can still be streaming the village's
  // chunks after the wait above. Wait until it has both cells' chunks (chunkHash answers with the keys it has), then place.
  await pg.waitForFunction(s => {
    const cs = [s.chest, s.furn].map(c => BF.world.chunkAt(c.x, c.z));
    if (!cs.every(Boolean)) return false;
    const keys = [...new Set(cs.map(c => c.key))];
    if (window.__ck && window.__ck.n === keys.length) return true;
    if (!window.__ckAsk) { window.__ckAsk = true; BF.client.query('chunkHash', { keys }, r => { window.__ckAsk = false; if (r && r.keys && r.keys.length === keys.length) window.__ck = { n: keys.length }; }); }
    return false;
  }, spots, { timeout: 120000, polling: 250 }).catch(() => {});
  let lastPlace = null;
  for (const t0 = Date.now(); Date.now() - t0 < 60000 && !(await pg.evaluate(placed, spots));) {
    lastPlace = await pg.evaluate(s => {
      const W = BF.world, out = [];
      const put = (c, id) => { if (W.getBlock(c.x, c.y, c.z) !== id) out.push(new Promise(r => BF.req.player("player.place", c.x + "," + c.y + "," + c.z, { cells: [[c.x, c.y, c.z, id, W.getBlock(c.x, c.y, c.z)]], consume: 0 }).then(r))); };
      put(s.chest, BF.B.chest); put(s.furn, BF.B.furnace);
      return Promise.all(out);
    }, spots);
    await settle(); await pg.waitForTimeout(500); await settle();
  }
  check(await pg.evaluate(placed, spots), tag('a chest and a furnace placed by player requests'), lastPlace);
  // click-to-redraw times: pointerdown (capture) to the next self message
  await pg.evaluate(() => {
    window.__lat = []; let t0 = null;
    addEventListener('pointerdown', () => { t0 = performance.now(); }, true);
    BF.proto.onSelf(m => { if (t0 != null && ('cursor' in m || m.inv || 'screen' in m)) { window.__lat.push(performance.now() - t0); t0 = null; } });
  });

  // ---- creative: the palette and the trash
  await pg.evaluate(() => BF.inventory.open("inventory"));
  await settle();
  check(await pg.evaluate(() => BF.inventory.mode === "creative" && !!document.querySelector(".bf-inv-back.open .bf-cre:not([hidden])")), tag('creative: the E screen is the creative menu'));
  const pick = async (id, button, shift) => {
    await pg.evaluate(id => {
      const b = document.querySelector('.bf-tab[data-tab="search"]'); b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      const s = document.querySelector('.bf-search'), e = BF.inventory.creativeItems().find(e => e.id === id);
      s.value = e.name; s.dispatchEvent(new Event("input"));
    }, id);
    await click('pal', id, button, shift);
  };
  await pick(I.planks, 'left'); await click('inv', 1);
  await pick(I.cobblestone, 'left'); await click('inv', 2);
  await pick(I.raw_beef, 'right'); await click('inv', 3);
  await pick(I.coal, 'right'); await click('inv', 4);
  await pick(I.emerald, 'left'); await click('inv', 5);
  await pick(I.stick, 'left', true);   // shift: a stack straight into the hotbar
  let v = await seen();
  check(count(v, I.planks) === 64 && count(v, I.cobblestone) === 64 && count(v, I.raw_beef) === 1 && count(v, I.coal) === 1 && count(v, I.emerald) === 64 && count(v, I.stick) === 64 && !v.cursor,
    tag('creative: palette picks (a stack, one, a shift-click) land where clicked'), totals(v));
  await pick(I.dirt, 'left'); await click('trash', 0);
  const st = v.inv.findIndex(s => s && s.id === I.stick);
  await click('inv', st); await click('trash', 0);
  v = await seen();
  check(!count(v, I.dirt) && !count(v, I.stick) && !v.cursor, tag('creative: the trash destroys the held stack'), totals(v));
  await pg.keyboard.press('Escape'); await settle();   // (E would type into the search box)
  v = await seen();
  check(!v.open && !v.screen, tag('Escape closes the creative menu (page and simulation)'));
  await pg.evaluate(() => BF.player.setGameMode("survival"));
  await settle(); await pg.waitForTimeout(300); await settle();

  // ---- the inventory: clicks, a drag-split, a shift-craft, closing with the cursor and grid full
  await pg.evaluate(() => BF.inventory.open("inventory"));
  await settle();
  v = await seen();
  check(v.open && v.screen && v.screen.mode === "inventory" && v.screen.grid.length === 4, tag('the inventory screen opens (2x2 grid)'), v.screen);
  let base = totals(v);
  await click('inv', 1); await click('inv', 9);   // the planks to the main inventory
  v = await seen();
  check(v.inv[9] && v.inv[9].id === I.planks && v.inv[9].count === 64 && !v.inv[1] && same(base, totals(v)), tag('left click: pick up a stack, put it down'));
  await click('inv', 9, 'right');   // half on the cursor
  v = await seen();
  check(v.cursor && v.cursor.count === 32 && v.inv[9].count === 32 && same(base, totals(v)), tag('right click: half a stack'), v.cursor);
  const shown = await pg.evaluate(() => { const h = document.querySelector('.bf-inv-back .bf-held'); return h.classList.contains('on') && h.querySelector('.bf-n').textContent; });
  check(shown === '32', tag('the held stack is drawn at the pointer'), shown);
  await dragOver('left', [['grid', 0], ['grid', 2]]);
  v = await seen();
  check(!v.cursor && v.screen.grid[0] && v.screen.grid[0].count === 16 && v.screen.grid[2].count === 16 && v.screen.result && v.screen.result.id === I.stick && same(base, totals(v)),
    tag('drag-split over two grid cells: 16 each, sticks to craft'), v.screen);
  await click('result', 0, 'left', true);
  v = await seen();
  check(count(v, I.stick) === 64 && count(v, I.planks) === 32 && v.screen.grid.every(s => !s), tag('shift-click on the result crafts a stack'), totals(v));
  base = totals(v);
  await click('inv', 2, 'left', true);   // shift: cobblestone hotbar -> main
  v = await seen();
  check(!v.inv[2] && v.inv.slice(9).some(s => s && s.id === I.cobblestone && s.count === 64) && same(base, totals(v)), tag('shift-click moves hotbar to main'));
  await click('inv', 9, 'right');   // 16 on the cursor
  await click('grid', 1);           // into the grid
  await click('inv', 9, 'right');   // 8 more on the cursor
  v = await seen();
  check(v.cursor && v.cursor.count === 8 && v.screen.grid[1].count === 16 && same(base, totals(v)), tag('items on the cursor and in the grid'), [v.cursor, v.screen.grid]);
  await pg.keyboard.press('KeyE'); await settle();
  v = await seen();
  check(!v.open && !v.screen && !v.cursor && count(v, I.planks) === 32 && same(base, totals(v)), tag('closing gives the cursor and grid back'), totals(v));

  // ---- the crafting table
  await pg.evaluate(() => BF.inventory.open("crafting"));
  await settle();
  v = await seen();
  check(v.screen && v.screen.mode === "crafting" && v.screen.grid.length === 9, tag('the crafting table opens (3x3)'));
  const pl = v.inv.findIndex(s => s && s.id === I.planks);
  await click('inv', pl);
  await dragOver('left', [['grid', 0], ['grid', 1], ['grid', 3], ['grid', 4]]);
  v = await seen();
  check(v.screen.result && v.screen.result.id === I.crafting_table && [0, 1, 3, 4].every(k => v.screen.grid[k] && v.screen.grid[k].count === 8), tag('drag-split over four cells: a crafting table to craft'), v.screen.grid);
  await click('result', 0, 'left', true);
  v = await seen();
  check(count(v, I.crafting_table) === 8 && !count(v, I.planks), tag('shift-craft: 8 crafting tables'), totals(v));
  await pg.keyboard.press('Escape'); await settle();

  // ---- the furnace: load with shift-clicks, it cooks while open, take the output
  await pg.evaluate(f => BF.inventory.open("furnace", f), spots.furn);
  await settle();
  v = await seen(null, spots.furn);
  check(v.open && v.screen && v.screen.mode === "furnace" && v.furnace, tag('the furnace opens'));
  base = totals(v);
  await click('inv', v.inv.findIndex(s => s && s.id === I.raw_beef), 'left', true);
  await click('inv', v.inv.findIndex(s => s && s.id === I.coal), 'left', true);
  v = await seen(null, spots.furn);
  // (one beef cooks in a few seconds, so by this query it may already be steak)
  const fs = v.furnace.slots;
  check(((fs[0] && fs[0].id === I.raw_beef) || (fs[2] && fs[2].id === I.steak)) && (fs[1] || v.furnace.burn > 0) && !v.inv.some(s => s && s.id === I.raw_beef), tag('shift-clicks load the input and the fuel'), v.furnace);
  const t0 = Date.now();
  let cooked = null;
  while (Date.now() - t0 < 30000) {
    const f = (await seen(null, spots.furn)).furnace;
    if (f && f.slots[2]) { cooked = f; break; }
    await pg.waitForTimeout(500);
  }
  check(cooked && cooked.slots[2].id === I.steak && !cooked.slots[0], tag('it cooks while the screen is open'), cooked && { secs: (Date.now() - t0) / 1000, out: cooked.slots[2] });
  // the page redraws from its next furnace answer (four a second, on its own frames)
  const drawn = await pg.waitForFunction(() => document.querySelector('.bf-inv-back [data-c="furn"][data-i="2"] img').hidden === false, null, { timeout: 15000 }).then(() => true, () => false);
  check(drawn, tag('the furnace output is drawn'));
  await click('furn', 2);
  await click('inv', 6);
  v = await seen(null, spots.furn);
  check(v.inv[6] && v.inv[6].id === I.steak && !v.cursor && !count(v, I.raw_beef), tag('the output taken into the inventory'), v.inv[6]);
  await pg.keyboard.press('KeyE'); await settle();

  // ---- the chest
  await pg.evaluate(c => BF.inventory.open("chest", c), spots.chest);
  await settle();
  v = await seen(spots.chest);
  check(v.open && v.screen && v.screen.mode === "chest" && v.chest, tag('the chest opens'));
  base = totals(v);
  const cob = v.inv.findIndex(s => s && s.id === I.cobblestone);
  await click('inv', cob, 'left', true);
  v = await seen(spots.chest);
  check(v.chest.some(s => s && s.id === I.cobblestone && s.count === 64) && !v.inv[cob] && same(base, totals(v)), tag('shift-click into the chest'));
  await click('chest', 0);              // all 64 on the cursor
  await click('chest', 1, 'right');     // one into the next slot
  await click('inv', cob);              // the rest back
  v = await seen(spots.chest);
  check(v.chest[1] && v.chest[1].count === 1 && v.inv[cob] && v.inv[cob].count === 63 && same(base, totals(v)), tag('left and right clicks in the chest'), [v.chest[1], v.inv[cob]]);
  await click('chest', 1);              // the one on the cursor, then close
  await pg.keyboard.press('KeyE'); await settle();
  v = await seen(spots.chest);
  check(!v.open && !v.screen && !v.cursor && count(v, I.cobblestone) === 64 && same(base, totals(v)), tag('closing the chest gives the cursor back'), totals(v));
  // the state the two modes must agree on: the chests (state hash part) and the player's slots
  await pg.evaluate(c => BF.inventory.open("chest", c), spots.chest);
  await settle();
  await click('inv', v.inv.findIndex(s => s && s.id === I.cobblestone), 'left', true);
  await click('inv', v.inv.findIndex(s => s && s.id === I.crafting_table), 'left', true);
  await pg.keyboard.press('KeyE'); await settle();
  const agree = await pg.evaluate(async () => {
    const h = await new Promise(r => BF.client.query('hash', {}, r));
    return { chests: h.parts.chests, inv: JSON.stringify(BF.client.self.inv) };
  });
  // the chest broken while its screen is open: the simulation closes it, the page follows, the items drop
  await pg.evaluate(c => BF.inventory.open("chest", c), spots.chest);
  await settle();
  await pg.evaluate(c => BF.req.player("player.break", c.x + "," + c.y + "," + c.z, { id: BF.B.chest, harvest: true }), spots.chest);
  await settle(); await settle();
  v = await seen(spots.chest);
  const drops = await pg.evaluate(() => [...BF.client.world.entities.values()].filter(e => e.kind === "drop").map(e => [e.item, e.count]));
  check(!v.open && !v.screen && v.chestGone, tag('the chest broken while open: the screen closes, the chest is gone'), { open: v.open, screen: v.screen });
  check(drops.some(d => d[0] === I.cobblestone) && drops.some(d => d[0] === I.crafting_table), tag('its items dropped'), drops.length);

  // ---- a villager's trade: an offer chosen (auto-fill from the inventory), shift-traded
  // The nearest villagers in turn until one's screen shows an emerald offer it can do now: stock, jobs and what they're doing differ
  // between runs, and an offer can stop being possible between a query and the screen's own answer.
  const ids = await pg.evaluate(() => {
    const p = BF.player.position;
    const list = [...BF.client.world.entities.values()].filter(e => e.kind === "mob" && e.type === "villager" && !e.child && !e.dead && !e.sleeping && e.sid != null);
    list.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    return list.map(e => e.sid);
  });
  check(ids.length > 0, tag('a villager in the mirror'));
  const canDo = (tv, em) => (tv ? tv.trades.findIndex(o => !o.reason && o.buy[0].id === em && !o.buy[1] && o.buy[0].n <= 16 && o.sell.id !== em) : -1);
  let tv = null, oi = -1, opened = false;
  for (const id of ids.slice(0, 16)) {
    await pg.evaluate(id => BF.inventory.openTrade(id), id);
    await pg.waitForFunction(id => { const t = BF.inventory.views().trade; return t && t.id === id; }, id, { timeout: 5000 }).catch(() => {});
    await settle();
    tv = await pg.evaluate(() => BF.inventory.views().trade);
    v = await seen();
    opened = opened || !!(v.open && v.screen && v.screen.mode === "trade" && tv);
    oi = canDo(tv, I.emerald);
    if (oi >= 0) break;
    await pg.keyboard.press('KeyE'); await settle();
  }
  if (ids.length) {
    check(opened, tag('the trade screen opens with the villager\'s offers'), tv && tv.trades.length);
    check(oi >= 0, tag('an emerald offer it can do now'), { oi, tried: Math.min(ids.length, 16) });
    if (oi >= 0) {
      const o = tv.trades[oi];
      base = totals(v);
      await pg.$eval(`.bf-inv-back .bf-offer[data-i="${oi}"]`, el => el.click());
      await settle();
      v = await seen();
      check(v.screen.offer === oi && v.screen.pay[0] && v.screen.pay[0].id === I.emerald && v.screen.tradeResult && v.screen.tradeResult.id === o.sell.id && same(base, totals(v)),
        tag('choosing the offer auto-fills the payment'), v.screen);
      await click('tres', 0, 'left', true);
      v = await seen();
      const paid = base[I.emerald] - count(v, I.emerald), got = count(v, o.sell.id) - (base[o.sell.id] || 0), lots = paid / o.buy[0].n;
      check(lots >= 1 && Number.isInteger(lots) && got === lots * o.sell.n, tag('shift-click on the result trades lots'), { paid, got, lots, offer: o });
      await pg.keyboard.press('KeyE'); await settle();
      v = await seen();
      check(!v.open && !v.screen && count(v, I.emerald) === base[I.emerald] - paid, tag('closing gives the payment back'), totals(v));
    }
  }
  const lat = await pg.evaluate(() => window.__lat.slice().sort((a, b) => a - b));
  const pct = q => lat.length ? +lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].toFixed(1) : null;
  console.log(`${mode}: click to self ${lat.length} clicks, median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms`);
  const errs = await pg.evaluate(() => (BF.client.world.log || []).filter(e => e.l === "ERROR").map(e => e.x).slice(0, 5));
  check(!errs.length, tag('no ERROR in the game log'), errs);
  await ctx.close();
  return { agree, lat: { median: pct(0.5), p95: pct(0.95), max: pct(1), n: lat.length } };
}

(async () => {
  const { srv, url } = await server();
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const res = {};
  try {
    for (const m of MODES) res[m] = await run(b, url, m);
    if (res.worker && res.page) {
      check(res.worker.agree.chests === res.page.agree.chests, 'both modes: the same chests (state hash part)', [res.worker.agree.chests, res.page.agree.chests]);
      check(res.worker.agree.inv === res.page.agree.inv, 'both modes: the same inventory');
    }
  } catch (e) { console.log('FAIL ' + (e.stack || e)); fails++; }
  await b.close(); srv.kill();
  console.log(fails ? 'FAILED: ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
