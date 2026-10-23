// Claude villager (js/claudevillager.js, debug/claude.js; experimental): NODE_PATH=$(npm root -g) node test/claude-villager.js [outPrefix]
// @ci skip experimental branch: needs `npm install` in debug/ (the Anthropic SDK); talks to a mock Claude API, never the real one
// Starts a mock Messages API and debug/server.js pointed at it with a fake key, then checks: /claude/status, the guards (wrong origin,
// non-JSON, bad conversation), that the Sage appears beside the world spawn, right-click opens the chat panel (not the trade screen),
// a message round-trips with the prompt file's system prompt and the right model, errors show in the panel and the game log, and
// Escape closes it. Without a key the server reports configured: false and no Sage appears.
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
  ok('right-click opens the chat, not the trade screen', opened.r === null && opened.chat && !opened.trade && opened.paused, opened);
  await pg.keyboard.type('What should I do on my first night?');
  await pg.keyboard.press('Enter');
  ok('the reply shows in the panel', await until(() => /Mind the creepers/.test(document.querySelector('.bfcv-log').textContent), null, 15000), await pg.evaluate(() => document.querySelector('.bfcv-log').textContent));
  const req = last && last.body;
  ok('the request: Haiku 5.5, the player\'s words, the API key from the server', req && req.model === 'claude-haiku-5-5' && (last.key === 'sk-ant-test-key' || last.hdr.authorization === 'Bearer sk-ant-test-key')
    && req.messages.length === 1 && req.messages[0].content === 'What should I do on my first night?', last);
  ok('the system prompt comes from prompts/villager-system.md, filled in', req && /You are Sage, a villager in Blockfield/.test(req.system) && /no trade/.test(req.system)
    && /Right now: day 1/.test(req.system) && req.system.includes('you were carrying: ' + startText + '.') && !/\{\{/.test(req.system) && !/<!--/.test(req.system), req && req.system);
  ok('effort low, no sampling params, the check_inventory tool offered', req && req.output_config && req.output_config.effort === 'low' && req.temperature === undefined
    && req.tools && req.tools.length === 1 && req.tools[0].name === 'check_inventory' && req.tool_choice.type === 'auto', req && req.tools);
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
  await pg.keyboard.press('Escape');
  const closed = await pg.evaluate(() => ({ chat: BF.claudeVillager.isOpen(), paused: BF.state.paused }));
  ok('Escape closes the chat and unpauses', !closed.chat && !closed.paused, closed);
  ok('no page errors', !errs.length, errs);

  await b.close(); srv.kill(); mock.close();
  console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
