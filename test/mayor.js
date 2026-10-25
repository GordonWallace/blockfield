// Village mayor (js/mayor.js, builder orders in js/builder.js; experimental): NODE_PATH=$(npm root -g) node test/mayor.js [seed=1337]
// @ci skip experimental branch (exp-llm-villager)
// With a mock Claude API behind debug/server.js:
// - the builders' check (BF.builder.assess): a structure the builder holds everything for can be built; a stable with no wild horses can't, and says why;
// - orders only apply once told (BF.builder.direct): before that the builder rolls as usual; told mid-structure it keeps building it, and its
//   next choice is the ordered type; an order that can't be built is skipped as blocked; finishing a structure crosses its order off;
// - a review: the mayor is appointed for the village, wakes, the server sends prompts/mayor-system.md (cached) and a briefing with the
//   village's numbers and builders; check_structure and give_orders are answered live; the impossible stable is refused and only the rest queued;
// - the mayor walks to the builder and tells it (village log "(Mayor) told"), and only then does the builder follow;
// - records and orders are saved with the world; the hourly spend cap refuses the next review.
const path = require('path'), http = require('http'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const seed = +(process.argv[2] || 1337);
const GAME = 8760, DBG = 8761, MOCK = 8762;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const reqs = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b || '{}'); reqs.push(body);
    const end = body.messages[body.messages.length - 1];
    const results = Array.isArray(end.content) && end.content.filter(c => c.type === 'tool_result');
    const content = results && results.length ? [{ type: 'text', text: 'The village is short of a well; I ordered one.' }]
      : [{ type: 'thinking', thinking: '', signature: 'sig' },
         { type: 'tool_use', id: 'toolu_check', name: 'check_structure', input: { type: 'stable' } },
         { type: 'tool_use', id: 'toolu_orders', name: 'give_orders', input: { builder: 'all', build: [{ type: 'stable', why: 'horses' }, { type: 'well', why: 'water' }], avoid: ['lamp_posts'], reason: 'water first' } },
         { type: 'tool_use', id: 'toolu_goal', name: 'set_goal', input: { text: 'a well', metric: 'structures', structure: 'well', op: '>=', target: 1, by_day: 50 } },
         { type: 'tool_use', id: 'toolu_strat', name: 'update_strategy', input: { text: 'Water, then houses.' } }];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model,
      stop_reason: results && results.length ? 'end_turn' : 'tool_use', stop_sequence: null, content, usage: { input_tokens: 500, output_tokens: 20 } }));
  });
}).listen(MOCK);

(async () => {
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 1200) : '')); if (!c) fails.push(n); };
  // the cap: one two-round review costs 2 x (500 x 0.10 + 20 x 0.50) / 1e6 = $0.00012, so the next one is refused
  const srv = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-mayor-alerts.json')],
    { env: Object.assign({}, process.env, { ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: `http://localhost:${MOCK}`, BF_CLAUDE_PER_HOUR_USD: '0.0001' }) });
  process.on('exit', () => srv.kill());
  for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${GAME}/claude/status`); break; } catch (e) { await sleep(200); } }
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 320, height: 200 } });
  pg.on('pageerror', e => console.log('PAGEERROR', e.stack || e.message));
  await pg.addInitScript(() => { const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => (window.__halt ? 0 : raf(cb)); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await require('./lib').install(pg);
  await pg.goto(`http://localhost:${GAME}/?nolod&claude=1#seed${seed}`);
  await require('./lib').ready(pg);
  await pg.waitForTimeout(3000);

  // a village with a builder; the world spawn moved next to it so the mayor picks it; the clock held at mid-morning
  const vs = await pg.evaluate(() => {
    window.__halt = true;
    BF.player.setGameMode && BF.player.setGameMode('creative');
    window.__step = (h, n) => { for (let i = 0; i < n; i++) { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); } };
    return BFT.villages(3000).filter(v => v && v.pop && (v.buildings || []).length >= 6).slice(0, 8).map(v => ({ x: v.x, z: v.z, y: v.y }));
  });
  let vk = null;
  for (const c of vs) {
    const found = await pg.evaluate(v => {
      const key = Math.round(v.x) + "," + Math.round(v.z);
      BF.player.spawn(v.x + 0.5, (v.y || BF.worldgen.heightAt(v.x, v.z)) + 3, v.z + 0.5);
      for (let i = 0; i < 400; i++) { BF.world.update(v.x, v.z, 60); if (i % 4 === 0) window.__step(0.05, 1); }
      return BF.mobs.list.some(m => m.type === "villager" && m.village && m.village.key === key && !m.dead && m.profession === "builder");
    }, c);
    if (found) { vk = { ...c, key: Math.round(c.x) + "," + Math.round(c.z) }; break; }
  }
  ok('a village with a builder', !!vk);
  if (!vk) { await b.close(); process.exit(1); }

  // ---- the builders' side: assess and orders, no model involved
  const unit = await pg.evaluate(v => {
    const T = BF.trades.inv, Bd = BF.builder, R = BF.mobs.villages.get(v.key);
    const bl = R.members.find(m => m.type === "villager" && !m.dead && !m.removed && m.profession === "builder");
    for (const e of Bd.builtOf(R)) if (e.state === "building") e.state = "abandoned";
    for (let i = 0; i < bl.inv.length; i++) bl.inv[i] = null;
    for (const [n, c] of [['oak_planks', 192], ['oak_log', 64], ['cobblestone', 192], ['glass_pane', 32], ['torch', 16], ['oak_fence', 32], ['bucket', 1], ['red_bed', 4], ['glass', 16], ['lantern', 4], ['oak_door', 4], ['crafting_table', 2], ['chest', 2], ['furnace', 2]]) if (BF.I[n] != null) T.add(bl.inv, BF.I[n], c);
    const bs = bl.bs || (bl.bs = { mode: "idle", t: 0, cool: 0, fail: {}, avoid: {}, placeT: 0.6 });
    BF.sky.setTime(0.15);
    const well = Bd.assess(R, "well", bl, { site: true }), stable = Bd.assess(R, "stable", bl);
    const all = Bd.assess(R, "well");
    // a structure under way (its own choice), then the orders arrive
    let e = null;
    for (const t of ["small_house", "medium_house", "cottage", "workshop", "market_stall"]) if ((e = Bd.beginPlan(bl, bs, t, "oak"))) break;
    if (!e) return { started: false, why: Bd.assess(R, "small_house", bl, { site: true }) };
    if (e) Bd.startBuild(bl, bs, e, true);
    bs.next = { type: "lamp_posts", wood: "oak", req: {} };
    const before = Bd.ordersOf(bl);
    Bd.direct(bl, { id: 1, queue: [{ type: "stable" }, { type: "well" }], avoid: ["lamp_posts"], why: "test" });
    const o = Bd.ordersOf(bl);
    bs.mode = "idle";
    Bd.think(bl, bs);   // the small house is still under way: it carries on with it
    const keeps = bs.mode === "build" && bs.entry === e;
    const nextAfter = bs.next;
    const picked = Bd.pickType(bl, bs);
    const blocked = o.queue.find(q => q.type === "stable");
    // finish the small house, then a well for the order, and cross it off
    e.prog = e.n; e.state = "done";
    const w = Bd.beginPlan(bl, bs, "well", "oak");
    const linked = !!(w && w.directed === 1 && o.queue.find(q => q.type === "well").state === "building");
    if (w) { w.prog = w.n; Bd.startBuild(bl, bs, w, true); for (let i = 0; i < 5 && w.state !== "done"; i++) Bd.ai(bl, 0.05, { x: 0, z: 0 }); }
    const saved = Bd.exportAll({});
    // reset for the mayor's turn: no orders
    Bd.orderBook.clear();
    return { well: { ok: well.ok, why: well.why, site: well.site }, stable: { ok: stable.ok, why: stable.why }, all: { ok: all.ok, builders: (all.builders || []).length },
      started: !!e, before, keeps, nextAfter, picked, blocked: blocked && { state: blocked.state, why: blocked.blocked }, linked, wellDone: w && w.state,
      left: o.queue.map(q => q.type), done: o.done.map(x => x.type), saved: Object.keys(saved).filter(k => k.startsWith("orders:")), builder: BF.vlog.nameOf(bl), horses: Bd.wildCount(R, "horse") };
  }, vk);
  console.log('   ', JSON.stringify(unit));
  if (!unit.started) { ok('a structure under way', false, unit); await b.close(); process.exit(1); }
  ok('assess: a well the builder has everything for can be built, with room for it', unit.well.ok && unit.well.site === 'found', unit.well);
  ok('assess: a stable that can\'t go up (no wild horses, or one already) says why', !unit.stable.ok && unit.stable.why.length > 0, unit.stable);
  ok('assess without a builder looks at every builder', unit.all.builders >= 1, unit.all);
  ok('no orders before the mayor has talked to the builder', unit.started && unit.before === null);
  ok('told mid-structure, it keeps building the structure it is on', unit.keeps);
  ok('its own next choice (lamp posts) gives way to the orders', !unit.nextAfter || unit.nextAfter.type === 'well', unit.nextAfter);
  ok('its next choice follows the orders (the stable skipped)', unit.picked === 'well', unit.picked);
  ok('the impossible stable is marked blocked with the reason', unit.blocked && unit.blocked.state === 'blocked' && unit.blocked.why === unit.stable.why[0], unit.blocked);
  ok('a structure begun for an order is linked to it', unit.linked);
  ok('finishing it crosses the order off', unit.wellDone === 'done' && !unit.left.includes('well') && unit.done.includes('well'), unit);
  ok('orders are saved with the builders', unit.saved.length === 1, unit.saved);

  // ---- the mayor: appointed, a review, orders walked over
  await pg.evaluate(v => { BF.worldSpawn = { x: v.x + 0.5, z: v.z + 0.5 }; BF.sky.setTime(0.1); }, vk);
  await pg.waitForFunction(() => BF.mayor && BF.mayor.state() && BF.mayor.mob(), null, { timeout: 30000, polling: 300 }).catch(() => {});
  const appointed = await pg.evaluate(() => ({ S: BF.mayor.state(), mob: !!BF.mayor.mob() }));
  ok('a mayor is appointed for the village and appears', !!appointed.S && appointed.mob && appointed.S.key === vk.key, appointed.S && appointed.S.key);
  // its first review (appointed): keep the world ticking so the review's tools and the walk happen
  for (let i = 0; i < 40; i++) {
    await pg.evaluate(() => window.__step(0.05, 10));
    if (await pg.evaluate(() => BF.mayor.state().reviews > 0)) break;
    await sleep(500);
  }
  const rv = await pg.evaluate(() => ({ S: BF.mayor.state(), glog: BF.glog.entries ? BF.glog.entries().filter(e => e.kind === "mayor").map(e => e.level + " " + e.text) : [] }));
  ok('the first review ran', rv.S.reviews === 1, rv.glog);
  const first = reqs.find(r => r.tools && r.tools.some(t => t.name === 'give_orders'));
  ok('the server sends the mayor prompt, the mayor tools and asks for caching', !!first && /mayor of a village/.test(first.system) && !!first.cache_control && first.model === 'claude-haiku-5-5', first && { cc: first.cache_control, model: first.model });
  const brief = first ? first.messages[0].content : '';
  if (process.env.MAYOR_BRIEF_OUT) require('fs').writeFileSync(process.env.MAYOR_BRIEF_OUT, brief);   // an example briefing for docs/MAYOR.md
  ok('the briefing has the reason, the numbers, the builders and what can be built', /Why you were woken: you have just been appointed/.test(brief) && /THE VILLAGE NOW/.test(brief) && /Food held/.test(brief) && /BUILDERS/.test(brief) && brief.includes(unit.builder) && /CAN BE BUILT NOW/.test(brief), brief.slice(0, 600));
  const second = reqs.filter(r => r.tools && r.tools.some(t => t.name === 'give_orders'))[1];
  const res = second ? second.messages[second.messages.length - 1].content : [];
  const txt = id => ((res.find(c => c.tool_use_id === id) || {}).content || '');
  console.log('    check_structure:', txt('toolu_check').slice(0, 200));
  console.log('    give_orders:', txt('toolu_orders').slice(0, 300));
  ok('check_structure answers with the builders\' verdict', /stable: (CAN|can NOT) be built now/.test(txt('toolu_check')), txt('toolu_check'));
  ok('give_orders refuses what can\'t be built and queues the rest', /queued Well/i.test(txt('toolu_orders')) && /Refused: Stable/i.test(txt('toolu_orders')), txt('toolu_orders'));
  ok('a goal and a strategy are recorded', rv.S.goals.length === 1 && rv.S.goals[0].start >= 0 && rv.S.strategy === 'Water, then houses.', { goals: rv.S.goals, strategy: rv.S.strategy });
  ok('the summary is kept', /ordered one/.test(rv.S.last && rv.S.last.summary), rv.S.last);
  const untold = await pg.evaluate(v => { const R = BF.mobs.villages.get(v.key); return R.members.filter(m => m.profession === "builder" && !m.dead).map(m => BF.builder.ordersOf(m)); }, vk);
  const S1 = rv.S, pend = Object.values(S1.orders);
  ok('orders wait for the mayor to walk over', pend.length >= 1 && pend.every(o => o.told === null || o.told > 0) && (untold.every(o => o === null) || pend.some(o => o.told)), { pend, untold });

  // walk: step the world until every builder has been told
  let told = false;
  for (let i = 0; i < 120 && !told; i++) {
    told = await pg.evaluate(() => { window.__step(0.05, 40); BF.sky.setTime(0.15); return Object.values(BF.mayor.state().orders).every(o => o.told); });
    if (!told) await sleep(250);
  }
  const after = await pg.evaluate(v => {
    const R = BF.mobs.villages.get(v.key);
    return { orders: R.members.filter(m => m.profession === "builder" && !m.dead).map(m => BF.builder.ordersOf(m)), log: BF.vlog.entries(R.key).filter(e => e[1] === "mayor").map(e => e[2]),
      mob: BF.mayor.mob() && BF.mayor.mob().position, errand: BF.mayor.mob() && BF.mayor.mob().claudeErrand && Object.assign({}, BF.mayor.mob().claudeErrand, { goal: undefined }),
      orders0: BF.mayor.state().orders, bl: R.members.filter(m => m.profession === "builder" && !m.dead).map(m => ({ p: m.position, sl: m.sleeping, slot: m.slot.idx })), t: BF.sky.time };
  }, vk);
  ok('the mayor walked to the builders and told them', told && after.orders.every(o => o && o.queue.some(q => q.type === 'well') && o.avoid.includes('lamp_posts')), after);
  ok('the village log says so', after.log.some(s => /\(Mayor\) told .* \(Builder\) to build well; leave lamp posts alone/i.test(s)), after.log);

  // save: records and orders go into the world save and come back
  const sv = await pg.evaluate(() => { const o = JSON.parse(JSON.stringify(BF.mayor.serialize())); BF.mayor.deserialize(o); return { k: Object.keys(o), S: BF.mayor.state() }; });
  ok('the mayor\'s records survive a save and load', sv.k.length === 1 && sv.S.strategy === 'Water, then houses.' && sv.S.goals.length === 1 && sv.S.reviews === 1, sv);

  // the hourly cap: the next review is refused by the server
  const capped = await fetch(`http://localhost:${GAME}/claude/mayor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mayor: { name: 'x', village: 'y' }, wake: 'test', briefing: 'test' }) });
  const cj = await capped.json();
  ok('the hourly spend cap refuses the next review', capped.status === 429 && /Hourly Claude spend cap/.test(cj.error), cj);

  console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'ALL PASSED');
  await b.close(); mock.close(); srv.kill();
  process.exit(fails.length ? 1 : 0);
})();
