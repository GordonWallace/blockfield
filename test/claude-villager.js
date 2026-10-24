// Claude villager (js/claudevillager.js, debug/claude.js; experimental): NODE_PATH=$(npm root -g) node test/claude-villager.js [outPrefix]
// @ci skip experimental branch: needs `npm install` in debug/ (the Anthropic SDK); talks to a mock Claude API, never the real one
// Starts a mock Messages API and debug/server.js pointed at it with a fake key, then checks: /claude/status, the guards (wrong origin,
// non-JSON, bad conversation), that the Sage appears beside the world spawn, right-click opens its trade screen (no offers) with the
// Chat / House designer panel to the right, a message round-trips with the prompt file's system prompt and the right model, the
// inventory tool, errors in the panel and the game log; the house designer: the structured-output request, a flawed draft sent back
// with its problems, the blueprint built in the builders' format (door and bed facing, materials), a revision; Escape closes it all.
// Without a key the server reports configured: false and no Sage appears.
const path = require('path'), http = require('http'), { spawn } = require('child_process');
const { chromium } = require(process.env.PW || 'playwright');
const root = path.resolve(__dirname, '..'), out = process.argv[2] || '/tmp/claude-villager';
const GAME = 8740, DBG = 8741, MOCK = 8742;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// mock Claude API: remembers the last request, answers or fails on demand
let last = null, failNext = false;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    last = { url: req.url, hdr: req.headers, key: req.headers['x-api-key'], body: JSON.parse(b || '{}') };
    if (failNext) { failNext = false; res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); return; }
    if (last.body.output_config && last.body.output_config.format) { designReply(res); return; }
    // "what are you carrying?" -> a check_inventory call, then an answer quoting the tool result
    const msgs = last.body.messages, end = msgs[msgs.length - 1], rounds = msgs.filter(m => m.role === 'assistant' && Array.isArray(m.content)).length;
    const result = Array.isArray(end.content) && end.content.find(c => c.type === 'tool_result');
    let content, stop = 'end_turn';
    if (result) content = [{ type: 'text', text: 'Let me see... ' + result.content }];
    else if (/carrying/.test(end.content) && !rounds) { content = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'check_inventory', input: {} }]; stop = 'tool_use'; }
    else content = [{ type: 'text', text: 'Well met, traveller. Mind the creepers.' }];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: last.body.model, stop_reason: stop, stop_sequence: null,
      content, usage: { input_tokens: 321, output_tokens: 12 },
    }));
  });
}).listen(MOCK, '127.0.0.1');

// the house designer's drafts: the first has no door (the server should send it back), then a good one
const GOOD = { name: 'Stone cottage', summary: 'A snug stone cottage.', notes: '', width: 7, depth: 5,
  legend: [{ symbol: 'S', block: 'stone_bricks' }, { symbol: 'D', block: 'oak_door' }, { symbol: 'B', block: 'red_bed' }, { symbol: 'F', block: 'furnace' },
    { symbol: 't', block: 'torch' }, { symbol: 'G', block: 'glass_pane' }, { symbol: 's', block: 'oak_slab' }],
  layers: [{ label: 'floor', rows: ['SSSSSSS', 'SSSSSSS', 'SSSSSSS', 'SSSSSSS', 'SSSSSSS'] },
    { label: 'walls', rows: ['SSSDSSS', 'S.....S', 'SBB.F.S', 'S.t...S', 'SSSSSSS'] },
    { label: 'windows', rows: ['SSS.SSS', 'G.....G', 'S.....S', 'G.....G', 'SSSSSSS'] },
    { label: 'roof', rows: ['sssssss', 'sssssss', 'sssssss', 'sssssss', 'sssssss'] }] };
const NODOOR = JSON.parse(JSON.stringify(GOOD)); NODOOR.layers[1].rows[0] = 'SSSSSSS';
let designCalls = [];
function designReply(res) {
  designCalls.push(last.body);
  const revise = /drew earlier/.test(last.body.messages[0].content), retry = last.body.messages.length > 1;
  const d = revise ? Object.assign(JSON.parse(JSON.stringify(GOOD)), { name: 'Stone cottage with a chimney' }) : retry ? GOOD : NODOOR;
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'msg_d', type: 'message', role: 'assistant', model: last.body.model,
    stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(d) }], usage: { input_tokens: 2000, output_tokens: 900 } }));
}

const start = async env => {
  const p = spawn(process.execPath, [path.join(root, 'debug/server.js'), '--game', GAME, '--debug', DBG, '--alerts', path.join(require('os').tmpdir(), 'bf-claude-alerts.json')],
    { env: Object.assign({}, process.env, { ANTHROPIC_API_KEY: '', BF_CLAUDE_KEY_FILE: '/nonexistent' }, env) });
  p.stderr.on('data', d => process.stderr.write('SERVER ' + d));
  process.on('exit', () => p.kill());
  for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${GAME}/claude/status`); return p; } catch (e) { await sleep(200); } }
  throw new Error('server did not start');
};

(async () => {
  const fails = [], ok = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : '')); if (!c) fails.push(n); };
  const G = `http://localhost:${GAME}`;

  // ---- no key: off
  let srv = await start({});
  let st = await (await fetch(G + '/claude/status')).json();
  ok('no key: status says not configured', st.configured === false, st);
  ok('no key: chat is refused', (await fetch(G + '/claude/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 503);
  srv.kill(); await sleep(500);

  // ---- with a (fake) key, against the mock API
  srv = await start({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK}` });
  st = await (await fetch(G + '/claude/status')).json();
  ok('key: status configured, SDK present, Haiku 5.5', st.configured && st.sdk && st.model === 'claude-haiku-5-5', st);
  ok('the key is never in the status', !JSON.stringify(st).includes('sk-ant'));
  const post = (body, headers) => fetch(G + '/claude/chat', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
  ok('another site\'s page is refused', (await post({ messages: [{ role: 'user', content: 'hi' }] }, { Origin: 'https://evil.example' })).status === 403);
  ok('non-JSON is refused', (await fetch(G + '/claude/chat', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status === 415);
  ok('a conversation ending with the villager is refused', (await post({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).status === 400);
  ok('a file starting with a dot is never served', (await fetch(G + '/.anthropic-key')).status === 404);

  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const pg = await (await b.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
  const errs = []; pg.on('pageerror', e => { errs.push(e.message); console.log('PAGEERROR', e.message); });
  await pg.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await pg.route('https://fonts.**', r => r.abort());
  await pg.goto(`${G}/?nolod#seed123`);
  await pg.waitForTimeout(4000);
  await require('./lib').ready(pg);
  const until = (fn, arg, t = 60000) => pg.waitForFunction(fn, arg, { timeout: t, polling: 200 }).then(() => true, () => false);
  ok('the Sage appears', await until(() => BF.claudeVillager.mob() && !BF.claudeVillager.mob().removed));
  const where = await pg.evaluate(() => { const m = BF.claudeVillager.mob(), w = BF.worldSpawn; return { d: Math.hypot(m.position.x - w.x, m.position.z - w.z), name: BF.vlog.nameOf(m), n: BF.mobs.list.filter(x => x.claude).length }; });
  ok('beside the world spawn, named Sage, only one', where.d < 14 && where.name === 'Sage' && where.n === 1, where);
  const inv = await pg.evaluate(() => ({ start: BF.claudeVillager.startingInventory(), now: BF.claudeVillager.inventory(), prof: BF.claudeVillager.mob().profession }));
  ok('no profession; carries 3-6 kinds of thing', inv.prof === 'unemployed' && inv.start.length >= 3 && inv.start.length <= 6 && JSON.stringify(inv.start) === JSON.stringify(inv.now), inv);
  const startText = inv.start.map(e => e.count + ' ' + e.item).join(', ');

  await pg.evaluate(() => BF.player.start());
  const opened = await pg.evaluate(() => { const r = BF.mobs.interact(BF.claudeVillager.mob()); return { r, chat: BF.claudeVillager.isOpen(), trade: BF.inventory.isOpen(), paused: BF.state.paused }; });
  ok('right-click opens the trade screen and the Sage\'s panel', opened.r === null && opened.chat && opened.trade && opened.paused, opened);
  const lay = await pg.evaluate(() => { const a = document.querySelector('.bf-inv').getBoundingClientRect(), b = document.querySelector('.bfcv-panel').getBoundingClientRect();
    return { invRight: a.right, panelLeft: b.left, panelRight: b.right, vw: innerWidth, title: document.querySelector('.bf-thead h2').textContent,
      offers: document.querySelector('.bf-offers').textContent, vinv: [...document.querySelectorAll('.bf-vgrid .bf-slot')].filter(e => e.querySelector('img')).length }; });
  ok('the panel sits right of the trade screen, both on screen', lay.panelLeft >= lay.invRight && lay.panelRight <= lay.vw, lay);
  ok('no offers; the title and its inventory show', /^Sage, Wanderer — Here to talk/.test(lay.title) && /nothing to trade/.test(lay.offers) && lay.vinv >= 3, lay);
  await pg.keyboard.type('What should I do on my first night?');
  await pg.keyboard.press('Enter');
  ok('the reply shows in the panel', await until(() => /Mind the creepers/.test(document.querySelector('.bfcv-log').textContent), null, 15000), await pg.evaluate(() => document.querySelector('.bfcv-log').textContent));
  const req = last && last.body;
  ok('the request: Haiku 5.5, the player\'s words, the API key from the server', req && req.model === 'claude-haiku-5-5' && (last.key === 'sk-ant-test-key' || last.hdr.authorization === 'Bearer sk-ant-test-key')
    && req.messages.length === 1 && req.messages[0].content === 'What should I do on my first night?', last);
  ok('the system prompt comes from prompts/villager-system.md, filled in', req && /You are Sage, a villager in Blockfield/.test(req.system) && /no trade/.test(req.system)
    && /Right now: day 1/.test(req.system) && req.system.includes('you were carrying: ' + startText + '.') && !/\{\{/.test(req.system) && !/<!--/.test(req.system), req && req.system);
  ok('effort low, no sampling params, check_inventory and look_around offered', req && req.output_config && req.output_config.effort === 'low' && req.temperature === undefined
    && req.tools && req.tools.map(t => t.name).join() === 'check_inventory,look_around' && req.tool_choice.type === 'auto', req && req.tools);
  const logged = await pg.evaluate(() => BF.glog.recent(500).filter(e => e.k === 'claude').map(e => e.l + ' ' + e.x));
  ok('the exchange is logged as INFO without the words', logged.some(l => /^INFO Chat with Sage: 35 characters in, 39 out, 321\/12 tokens/.test(l)) && !logged.some(l => /first night/.test(l)), logged);

  // second turn carries the history; an API error shows and is logged
  failNext = true;
  await pg.keyboard.type('And the second?');
  await pg.keyboard.press('Enter');
  ok('an API error shows in the panel', await until(() => /API key was rejected/.test(document.querySelector('.bfcv-log').textContent), null, 15000));
  const after = await pg.evaluate(() => ({ h: BF.claudeVillager.history().length, ta: document.querySelector('.bfcv-row textarea').value,
    err: BF.glog.recent(500).some(e => e.k === 'claude' && e.l === 'ERROR' && /rejected/.test(e.x)) }));
  ok('the failed message goes back in the box and out of the history; ERROR logged', after.h === 2 && after.ta === 'And the second?' && after.err, after);
  await pg.keyboard.press('Enter');
  ok('retry works and sends the whole conversation', await until(() => BF.claudeVillager.history().length === 4, null, 15000) && last.body.messages.length === 3, last && last.body.messages);
  // the inventory check: the Sage's bag changes after it appears, and the tool reads the bag as it is now
  await pg.evaluate(() => { const m = BF.claudeVillager.mob(); BF.trades.inv.add(m.inv, BF.I.diamond, 2); });
  await pg.keyboard.type('What are you carrying?');
  await pg.keyboard.press('Enter');
  ok('asked what it carries, it checks its inventory and sees the current bag', await until(() => /Let me see\.\.\. You are carrying: .*2 Diamond/.test(document.querySelector('.bfcv-log').textContent), null, 15000),
    await pg.evaluate(() => document.querySelector('.bfcv-log').textContent));
  const tr = last.body.messages.slice(-2);
  ok('the tool call goes back unchanged (thinking too), then its result', tr[0].role === 'assistant' && tr[0].content[0].type === 'thinking' && tr[0].content[1].type === 'tool_use'
    && tr[1].content[0].type === 'tool_result' && tr[1].content[0].tool_use_id === 'toolu_1', tr);
  ok('the check is logged', await pg.evaluate(() => BF.glog.recent(500).some(e => e.k === 'claude' && /^Sage checked its inventory \(.*2 Diamond/.test(e.x))));
  ok('the history keeps only the words', await pg.evaluate(() => BF.claudeVillager.history().every(m => typeof m.content === 'string')));
  await pg.screenshot({ path: out + '-chat.png' });

  // ---- house designer
  // (in slow headless runs Playwright's hit test sometimes sees the trade screen's backdrop over this tab for a while: try a few times)
  for (let i = 0; ; i++) { try { await pg.click('.bfcv-tabs button:nth-child(2)', { timeout: 5000 }); break; } catch (e) { console.log('CLICKFAIL', await pg.evaluate(() => { const b = document.querySelector('.bfcv-tabs button:nth-child(2)'), r = b.getBoundingClientRect(); return JSON.stringify({ r, at: document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).map(x => x.tagName + '.' + x.className).slice(0, 4), panel: document.querySelector('.bfcv-panel').getBoundingClientRect(), inv: document.querySelector('.bf-inv').getBoundingClientRect() }); })); if (i >= 3) throw e; } }
  await pg.keyboard.type('stone with a wood roof, one bed, furnace');
  await pg.keyboard.press('Enter');
  ok('a design comes back and shows', await until(() => !!BF.claudeVillager.design() && document.querySelector('.bfcv-dout').classList.contains('on'), null, 20000),
    await pg.evaluate(() => document.querySelector('.bfcv-dstat').textContent));
  const dq = designCalls[0] || {};
  const sch = dq.output_config && dq.output_config.format && dq.output_config.format.schema;
  const names = sch ? sch.properties.legend.items.properties.block.enum : [];
  ok('the design request: Haiku 5.5, a JSON schema with the palette, the designer prompt', dq.model === 'claude-haiku-5-5' && dq.output_config.format.type === 'json_schema'
    && ['oak_slab', 'red_bed', 'oak_door', 'stone_bricks', 'oak_stairs_up_north'].every(n => names.includes(n)) && /gift for designing houses/.test(dq.system)
    && /- oak_stairs_up_north: oak planks stairs rising toward the north/.test(dq.system) && /The traveller wants: stone with a wood roof/.test(dq.messages[0].content), { names: names.length, sys: (dq.system || '').slice(0, 200) });
  const rq = designCalls[1] || {};
  ok('the doorless draft goes back with its problems', designCalls.length === 2 && rq.messages.length === 3 && rq.messages[1].content[0].type === 'thinking' && /there is no door/.test(rq.messages[2].content), rq.messages);
  const bpi = await pg.evaluate(() => { const c = BF.claudeVillager.design(), bp = c.bp, B = BF.blocks;
    const at = (x, y, z) => bp.cells.find(q => q.x === x && q.y === y && q.z === z);
    const fur = at(4, 1, 2), bed = bp.cells.filter(q => B[q.id].bed);
    return { type: bp.type, w: bp.w, d: bp.d, h: bp.hgt, n: bp.n, door: bp.door, beds: bp.beds, bedHead: bed.map(q => [q.x, q.z, B[q.id].bed.head, B[q.id].bed.f]),
      furnace: B[fur.id].name, phases: bp.cells.map(q => q.ph), first: bp.cells[0], upper: !!at(3, 2, 0) && B[at(3, 2, 0).id].door.upper,
      wallTorch: B[at(2, 1, 3).id].name, mats: c.materials.map(m => m.count + ' ' + m.name), shown: document.querySelectorAll('.bfcv-mats > div').length,
      name: document.querySelector('.bfcv-dname').textContent };
  });
  ok('builder blueprint: custom type, size, door facing out (north) with its upper half', bpi.type === 'custom' && bpi.w === 7 && bpi.d === 5 && bpi.h === 4 && bpi.door && bpi.door.f === 0 && bpi.door.x === 3 && bpi.upper, bpi);
  ok('the bed: foot and head, head against the west wall', bpi.beds.length === 1 && JSON.stringify(bpi.bedHead.sort()) === JSON.stringify([[1, 2, true, 3], [2, 2, false, 3]]), bpi.bedHead);
  ok('the furnace faces the room, the torch stands on the floor', /^furnace/.test(bpi.furnace) && bpi.wallTorch === 'torch', bpi);
  ok('cells in build order: floor first, phases never go back', bpi.first.y === 0 && bpi.phases.every((p, i) => !i || p >= bpi.phases[i - 1]), bpi.phases.join(''));
  ok('materials: one door and one bed (two cells each), 35 slabs, listed in the panel', bpi.mats.includes('1 Oak Door') && bpi.mats.includes('1 Red Bed') && bpi.mats.includes('35 Oak Slab')
    && bpi.shown === bpi.mats.length && /^Stone cottage/.test(bpi.name), bpi.mats);
  ok('the design is logged', await pg.evaluate(() => BF.glog.recent(500).some(e => e.k === 'claude' && e.l === 'INFO' && /^Sage designed "Stone cottage" \(7x5, 4 high, \d+ blocks, 1 beds; 2 drafts, 4000\/1800 tokens/.test(e.x))));
  await pg.evaluate(() => { const r = document.querySelector('.bfcv-cut input'); r.value = 2; r.dispatchEvent(new Event('input')); });
  await pg.screenshot({ path: out + '-design.png' });
  // a revision sends the earlier blueprint
  await pg.fill('.bfcv-dreq', 'add a chimney');
  await pg.click('.bfcv-page.on .bfcv-row button:nth-child(2)');
  ok('Revise sends the earlier blueprint and shows the new one', await until(() => /chimney/.test(document.querySelector('.bfcv-dname').textContent), null, 20000)
    && /blueprint you drew earlier:\n\{"name":"Stone cottage"/.test(designCalls[2].messages[0].content) && /changes: add a chimney/.test(designCalls[2].messages[0].content));
  // the 3D view: bigger in the panel, Enlarge takes most of the screen, Escape brings it back; dragging right turns it the other way now
  const small = await pg.evaluate(() => document.querySelector('.bfcv-view').getBoundingClientRect().height);
  const yaw0 = await pg.evaluate(() => { const c = document.querySelector('.bfcv-view canvas').getBoundingClientRect(); return [c.x + c.width / 2, c.y + c.height / 2]; });
  const y0 = await pg.evaluate(() => BF.claudeVillager.preview().yaw);
  await pg.mouse.move(yaw0[0], yaw0[1]); await pg.mouse.down(); await pg.mouse.move(yaw0[0] + 40, yaw0[1], { steps: 4 }); await pg.mouse.up();
  ok('dragging right turns the view the new way (yaw goes up)', Math.abs(await pg.evaluate(() => BF.claudeVillager.preview().yaw) - y0 - 0.4) < 0.05);
  await pg.click('.bfcv-big');
  const big = await pg.evaluate(() => ({ h: document.querySelector('.bfcv-view').getBoundingClientRect().height, w: document.querySelector('.bfcv-view').getBoundingClientRect().width, vw: innerWidth, vh: innerHeight }));
  ok('the 3D view is bigger, and Enlarge spreads it across the screen', small >= 260 && big.w > big.vw * 0.8 && big.h > big.vh * 0.7, { small, big });
  if (process.env.SHOTS) await pg.screenshot({ path: process.env.SHOTS + '/enlarged.png' });
  await pg.keyboard.press('Escape');
  const back = await pg.evaluate(() => ({ big: document.querySelector('.bfcv-stage').classList.contains('big'), open: BF.claudeVillager.isOpen() }));
  ok('Escape shrinks it back and leaves the trade screen open', !back.big && back.open, back);
  await pg.click('.bfcv-dreq');
  await pg.keyboard.press('Escape');
  const closed = await pg.evaluate(() => ({ chat: BF.claudeVillager.isOpen(), trade: BF.inventory.isOpen(), paused: BF.state.paused }));
  ok('Escape closes the panel and the trade screen, and unpauses', !closed.chat && !closed.trade && !closed.paused, closed);
  // closing the trade screen some other way takes the panel with it
  await pg.evaluate(() => BF.mobs.interact(BF.claudeVillager.mob()));
  await pg.evaluate(() => BF.inventory.close());
  ok('the panel goes when the trade screen does', await until(() => !BF.claudeVillager.isOpen() && !document.querySelector('.bfcv-panel').classList.contains('open'), null, 3000));
  ok('no page errors', !errs.length, errs);

  // ---- the debug screen's API calls panel
  const calls = await (await fetch(`http://localhost:${DBG}/claude-calls`)).json();
  const chats = calls.filter(c => c.kind === 'chat'), designs = calls.filter(c => c.kind === 'design');
  ok('every call is recorded (chats, the failed one, designs), never the key', chats.length >= 4 && designs.length === 2 && chats.some(c => c.status === 'error' && /rejected/.test(c.error))
    && !JSON.stringify(calls).includes('sk-ant'), calls.map(c => [c.kind, c.status, c.rounds.length]));
  ok('a call record has the filled system prompt, the settings and the messages', /You are Sage, a villager in Blockfield/.test(chats[0].system) && chats[0].params.effort === 'low'
    && chats[0].params.tools[0].name === 'check_inventory' && chats[0].messages[0].content === 'What should I do on my first night?' && chats[0].status === 'ok', chats[0]);
  const ic = chats.find(c => c.rounds.length === 2);
  ok('the inventory check shows as two rounds: tool call, result, reply', ic && ic.messages.slice(ic.earlier).map(m => m.role + (Array.isArray(m.content) ? ':' + m.content.map(b => b.type).join('+') : '')).join(' ')
    === 'user assistant:thinking+tool_use user:tool_result assistant:text', ic && ic.messages);
  ok('a design record: the schema, both drafts and the server\'s check between', designs[0].params.format.type === 'json_schema' && designs[0].rounds.length === 2
    && /there is no door/.test(designs[0].messages[2].content) && designs[0].status === 'ok', designs[0] && designs[0].messages.map(m => m.role));
  const dp = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  dp.on('pageerror', e => errs.push('debug: ' + e.message));
  await dp.goto(`http://localhost:${DBG}/`);
  ok('the header counts the calls', await dp.waitForFunction(n => document.getElementById('api-n').textContent === String(n), calls.length, { timeout: 10000 }).then(() => true, () => false));
  await dp.evaluate(() => { document.getElementById('waiting').style.display = 'none'; document.getElementById('api-open').click(); });
  const shown = await dp.evaluate(() => ({ items: document.querySelectorAll('#api-list .aitem').length, sel: document.querySelector('#api-list .aitem.sel b').textContent,
    detail: document.getElementById('api-detail').textContent }));
  ok('the panel lists every call and follows the newest (the revised design)', shown.items === calls.length && shown.sel === 'House design' && /chimney/.test(shown.detail) && /System prompt/.test(shown.detail), shown.items + ' ' + shown.sel);
  await dp.click(`#api-list .aitem[data-id="${ic.id}"]`);
  const det = await dp.evaluate(() => document.getElementById('api-detail').textContent);
  ok('picking a chat call shows its system prompt, history, tool call and result', /You are Sage, a villager in Blockfield/.test(det) && /Earlier in the chat/.test(det)
    && /tool call: check_inventory/.test(det) && /You are carrying: .*2 Diamond/.test(det) && /round 2/.test(det), det.slice(0, 600));
  ok('each call costs its tokens at Haiku 5.5 prices', Math.abs(chats[0].cost - (321 * 0.10 + 12 * 0.50) / 1e6) < 1e-12 && Math.abs(designs[0].cost - 2 * (2000 * 0.10 + 900 * 0.50) / 1e6) < 1e-12, [chats[0].cost, designs[0].cost]);
  ok('the panel shows the cost per call, per round and since the server started', /\$0\.000/.test(det) && /since the server started/.test(await dp.evaluate(() => document.getElementById('api-count').textContent)));
  if (process.env.SHOTS) await dp.screenshot({ path: process.env.SHOTS + '/api-calls.png' });
  ok('no debug screen errors', !errs.length, errs);

  await b.close(); srv.kill(); mock.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
