// Claude villager sight (js/claudesight.js; experimental): NODE_PATH=$(npm root -g) node test/claude-sight.js
// @ci skip experimental branch (exp-llm-villager)
// Builds a test ground in the open sky above the spawn, then checks look_around from a stand-in villager: a sheep 50 blocks off across
// open ground is seen, one 20 blocks off behind a stone wall isn't (and is once the wall goes), glass doesn't block, leaves do; flowers,
// a composter, wheat on farmland and a tree are listed with directions; the dark shortens the view; where() names the biome and climate.
// Also a tool round trip through debug/server.js with a mock API: the server hands look_around back to the page and the answer goes
// to the model in the next round.
const path = require('path'), http = require('http'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..');
const GAME = 8750, DBG = 8751, MOCK = 8752;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let reqs = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b || '{}'); reqs.push(body);
    const msgs = body.messages, end = msgs[msgs.length - 1];
    const result = Array.isArray(end.content) && end.content.find(c => c.type === 'tool_result');
    const event = typeof end.content === 'string' && /^\(World event/.test(end.content);
    const content = event ? [{ type: 'text', text: 'News: ' + end.content.slice(0, 120) }] : result ? [{ type: 'text', text: 'I see: ' + result.content.slice(0, 200) }]
      : [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_look', name: 'look_around', input: {} }];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model,
      stop_reason: result || event ? 'end_turn' : 'tool_use', stop_sequence: null, content, usage: { input_tokens: 500, output_tokens: 20 } }));
  });
}).listen(MOCK);

(async () => {
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 900) : '')); if (!c) fails.push(n); };
  const srv = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-sight-alerts.json')],
    { env: Object.assign({}, process.env, { ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: `http://localhost:${MOCK}` }) });
  process.on('exit', () => srv.kill());
  for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${GAME}/claude/status`); break; } catch (e) { await sleep(200); } }
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  const errs = []; pg.on('pageerror', e => { errs.push(e.message); console.log('PAGEERROR', e.message); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto(`http://localhost:${GAME}/?nolod#seed123`);
  await pg.waitForTimeout(4000);
  await require('./lib').ready(pg);
  await pg.waitForFunction(() => BF.claudeVillager && BF.claudeVillager.mob() && !BF.claudeVillager.mob().removed, null, { timeout: 90000, polling: 300 });

  // the test ground: a stone deck 40 blocks above the highest ground around, 130 x 31, the stand-in villager in the middle
  const setup = await pg.evaluate(() => {
    const W = BF.world, B = BF.B, p = BF.player.position, x0 = Math.floor(p.x), z0 = Math.floor(p.z);
    let top = 0; for (let dx = -70; dx <= 70; dx += 5) for (let dz = -20; dz <= 20; dz += 5) top = Math.max(top, W.heightAt(x0 + dx, z0 + dz));
    const y = top + 40;
    for (let dx = -65; dx <= 65; dx++) for (let dz = -15; dz <= 15; dz++) W.setBlock(x0 + dx, y, z0 + dz, B.stone);
    BF.player.spawn(x0 + 0.5, y + 1, z0 + 0.5); BF.player.flying = true;
    return { x0, z0, y, loaded: W.isLoaded(x0 + 65, z0) && W.isLoaded(x0 - 65, z0) };
  });
  ok('the test ground is loaded', setup.loaded, setup);
  const look = () => pg.evaluate(({ x0, z0, y }) => {
    const me = { position: { x: x0 + 0.5, y: y + 1, z: z0 + 0.5 }, height: 1.95, type: 'villager' };
    const o = BF.claudeSight.look(me);
    return { text: o.text, mobs: o.mobs.map(m => ({ type: m.type, d: m.d, dir: m.dir })), ms: o.ms, rays: o.rays, range: o.range };
  }, setup);
  const place = (list) => pg.evaluate(({ s, list }) => { for (const [dx, dy, dz, name] of list) BF.world.setBlock(s.x0 + dx, s.y + dy, s.z0 + dz, BF.B[name] || 0); }, { s: setup, list });
  // two sheep: one 50 blocks east in the open, one 20 west behind a wall; pinned in place so they don't wander off during the test
  await pg.evaluate(({ x0, z0, y }) => {
    window._sheep = [BF.mobs.spawn('sheep', x0 + 50.5, y + 1, z0 + 0.5), BF.mobs.spawn('sheep', x0 - 19.5, y + 1, z0 + 0.5)];
    for (const s of _sheep) { s.tag = 'sight-test'; s._pin = [s.position.x, s.position.y, s.position.z]; }
    window._pin = setInterval(() => { for (const s of _sheep) if (s && s._pin) { s.position.set(...s._pin); if (s.vel) s.vel.set(0, 0, 0); } }, 30);
  }, setup);
  const wall = []; for (let dz = -6; dz <= 6; dz++) for (let dy = 1; dy <= 4; dy++) wall.push([-15, dy, dz, 'stone']);
  await place(wall);
  await pg.waitForTimeout(500);
  let o = await look();
  const dir = (d) => { const x = o.mobs.find(m => m.type === 'sheep' && Math.abs(m.d - d) <= 2); return x; };
  const east = dir(50), west = dir(20);
  ok('a sheep 50 blocks off across open ground is seen', !!east, o.mobs);
  ok('a sheep 20 blocks off behind a wall is not', !west, o.mobs);
  ok('the player standing next to it is seen too', o.mobs.some(m => m.type === 'player'), o.mobs);
  ok('directions are compass points', east && /^(north|south|east|west)/.test(east.dir), east);
  ok('the text names the sheep with direction and distance', /Animals: a sheep, [a-z-]+, (49|50|51) blocks/.test(o.text), o.text);
  console.log('look_around took ' + o.ms + ' ms for ' + o.rays + ' rays');
  // glass in place of the wall: seen through
  await place(wall.map(([a, b, c]) => [a, b, c, 'glass']));
  o = await look();
  ok('through glass it is seen', !!dir(20), o.mobs);
  // leaves block
  await place(wall.map(([a, b, c]) => [a, b, c, 'oak_leaves']));
  o = await look();
  ok('leaves hide it', !dir(20), o.mobs);
  await place(wall.map(([a, b, c]) => [a, b, c, null]));
  o = await look();
  ok('with the wall gone it is seen', !!dir(20), o.mobs);
  // blocks: flowers, a composter, wheat on farmland, a tree, a door; one flower hidden in a stone box
  await place([[0, 1, 8, 'poppy'], [1, 1, 8, 'poppy'], [2, 1, 9, 'dandelion'], [6, 0, -6, 'farmland'], [6, 1, -6, 'wheat'], [7, 0, -6, 'farmland'], [7, 1, -6, 'wheat_young'],
    [-8, 1, -8, 'composter'], [10, 1, 10, 'oak_log'], [10, 2, 10, 'oak_log'], [10, 3, 10, 'oak_log'], [10, 4, 10, 'oak_leaves'], [9, 4, 10, 'oak_leaves'],
    [-30, 1, 12, 'cornflower'], [-31, 1, 12, 'stone'], [-29, 1, 12, 'stone'], [-30, 1, 11, 'stone'], [-30, 1, 13, 'stone'], [-30, 2, 12, 'stone']]);
  o = await look();
  ok('flowers are listed with counts, distance and direction', /Flowers: .*2 poppies \(nearest 8 blocks, [a-z-]+/.test(o.text) && /dandelion/.test(o.text), o.text);
  ok('a flower boxed in stone is not', !/cornflower/.test(o.text), o.text);
  ok('the composter is a farmer\'s workstation', /composter \(a farmer's workstation\)/.test(o.text), o.text);
  ok('ripe and young wheat and farmland', /wheat \(ripe\)/.test(o.text) && /young wheat/.test(o.text) && /farmland/.test(o.text), o.text);
  ok('the tree is counted as one oak tree', /1 oak tree \(/.test(o.text), o.text);
  ok('the land is described round the compass', /The land around you: north: .*; north-east: /.test(o.text) && /open as far as you can see/.test(o.text), o.text);
  // night: the sheep 50 blocks away is out of sight, the near one isn't
  await pg.evaluate(() => { window._light = BF.sky.light; Object.defineProperty(BF.sky, 'light', { configurable: true, get: () => 0.05, set: () => {} }); });
  o = await look();
  ok('in the dark the far sheep is out of sight, the view is short', !dir(50) && o.range <= 20 && /It is dark/.test(o.text), { mobs: o.mobs, range: o.range });
  await pg.evaluate(() => { delete BF.sky.light; BF.sky.light = window._light; });
  // where(): biome, climate band, height, nearest village
  const where = await pg.evaluate(() => BF.claudeSight.where(BF.claudeVillager.mob()));
  ok('where() names the biome, the climate band and the nearest village', /biome\./.test(where) && /(tropical|subtropical|temperate|subarctic|arctic) lands/.test(where) && /sea level/.test(where) && /village/.test(where), where);
  console.log('where: ' + where);

  // the tool round trip: the server hands look_around back to the page, the page answers, the model gets it next round
  const r = await pg.evaluate(async () => {
    const m = BF.claudeVillager.mob();
    BF.mobs.interact(m);
    const ta = document.querySelector('.bfcv-page.on textarea');
    ta.value = 'What can you see?';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (let i = 0; i < 200 && BF.claudeVillager.history().length < 2; i++) await new Promise(r => setTimeout(r, 100));
    return { h: BF.claudeVillager.history(), log: BF.glog.recent(200).filter(e => e.k === 'claude').map(e => e.x) };
  });
  const second = reqs[1], tr = second && second.messages[second.messages.length - 1];
  ok('look_around goes to the game and its answer back to the model', reqs.length === 2 && tr.content[0].type === 'tool_result' && tr.content[0].tool_use_id === 'toolu_look'
    && /You live in|It is light|It is dark|Animals|The land around you/.test(tr.content[0].content), tr);
  ok('the first request carries where the Sage is in the system prompt and offers both tools', /Where you are:\n- You live in/.test(reqs[0].system) && reqs[0].tools.map(t => t.name).join() === 'check_inventory,look_around,move_to', reqs[0].tools && reqs[0].tools.map(t => t.name));
  ok('the reply shows and the look is logged', r.h.length === 2 && /^I see:/.test(r.h[1].content) && r.log.some(x => /^Sage looked around: \d+ creatures and people/.test(x)), r);
  const calls = await (await fetch(`http://localhost:${DBG}/claude-calls`)).json();
  ok('the debug screen record holds the tool call and the game\'s answer', calls.length === 1 && calls[0].rounds.length === 2 && calls[0].status === 'ok'
    && calls[0].messages.some(m => Array.isArray(m.content) && m.content[0].type === 'tool_result'), calls.map(c => [c.status, c.rounds.length]));

  // ---- move_to: the Sage walks round a wall to the traveller, the arrival comes back as a world event, the reply shows in the game chat
  const mv = await pg.evaluate(({ x0, z0, y }) => {
    BF.inventory.close();
    clearInterval(window._pin);
    const m = BF.claudeVillager.mob(), W = BF.world, B = BF.B;
    for (let dz = -12; dz <= 12; dz++) for (let dy = 1; dy <= 3; dy++) W.setBlock(x0 - 20, y + dy, z0 + dz, B.stone);   // a wall to go round
    m.position.set(x0 - 34.5, y + 1, z0 + 0.5); m.claudeHome = { x: m.position.x, z: m.position.z }; m.ai.route = null;
    BF.player.spawn(x0 + 0.5, y + 1, z0 + 0.5); BF.player.flying = false;
    return BF.claudeVillager.runTool('move_to', m, { target: 'traveller', reason: 'test' });
  }, setup);
  ok('move_to answers at once: setting off, about 35 blocks', /^You set off for the traveller, about 3[4-6] blocks away/.test(mv), mv);
  const n0 = reqs.length;
  const arrived = await pg.waitForFunction(() => !BF.claudeVillager.errand() && BF.claudeVillager.history().length >= 4, null, { timeout: 240000, polling: 500 }).then(() => true, () => false);
  const st = await pg.evaluate(() => { const m = BF.claudeVillager.mob(), p = BF.player.position; return { d: Math.hypot(m.position.x - p.x, m.position.z - p.z), h: BF.claudeVillager.history().slice(-2),
    chat: [...document.querySelectorAll('.bfc-line')].map(e => e.textContent).slice(-3), log: BF.glog.recent(300).filter(e => e.k === 'claude').map(e => e.l + ' ' + e.x).slice(-4) }; });
  ok('it walks round the wall to the traveller', arrived && st.d < 4.5, st);
  ok('the arrival is told to the model as a world event, with where the traveller is', reqs.length > n0 && /^\(World event, not the traveller speaking\) You have arrived at the traveller\. The traveller is about \d+ blocks/.test(reqs[reqs.length - 1].messages.slice(-1)[0].content), reqs.length > n0 && reqs[reqs.length - 1].messages.slice(-1)[0]);
  ok('its reply shows in the game chat (the panel is closed)', st.chat.some(t => /^<Sage> News:/.test(t)), st.chat);
  ok('setting off and arriving are logged', st.log.some(x => /^INFO Sage set off for the traveller \(about \d+ blocks\): test/.test(x)) && st.log.some(x => /^INFO Sage arrived at the traveller after \d+ s/.test(x)), st.log);
  // a place it can't reach (off the edge of the deck): the failure comes back as a world event too
  const fail = await pg.evaluate(() => {
    const m = BF.claudeVillager.mob(), P = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    let best = null, bz = 0;
    for (let k = 0; k < 8; k += 2) { const yaw = BF.coords.yawFor(k * 45, m.position.x, m.position.z, 0), dz = Math.abs(Math.cos(yaw)); if (dz > bz) { bz = dz; best = P[k]; } }
    return BF.claudeVillager.runTool('move_to', m, { target: 'direction', direction: best, distance: 40 });
  });
  ok('a direction and distance sets off too', /^You set off for a spot about \d+ blocks/.test(fail), fail);
  const failed = await pg.waitForFunction(() => !BF.claudeVillager.errand() && BF.claudeVillager.history().length >= 6, null, { timeout: 240000, polling: 500 }).then(() => true, () => false);
  const fl = reqs[reqs.length - 1].messages.slice(-1)[0].content;
  ok('somewhere it can\'t reach comes back as "didn\'t make it"', failed && /^\(World event, not the traveller speaking\) You didn't make it to a spot about \d+ blocks/.test(fl), fl);
  ok('move_to is offered with its targets', reqs[0].tools.some(t => t.name === 'move_to' && t.input_schema.properties.target.enum.includes('traveller')));
  ok('no page errors', !errs.length, errs);
  await b.close(); srv.kill(); mock.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
