// @ci integration suite=ui timeout=900
// bug-075: commands that print lines while they run (/help, /help <command>, /say) show them in the chat with the simulation off the
// page too: off the page the lines go back with the command's result. Seed 3, once per host (default page,worker): the chat lines
// (without the echoed command) of /help give, /say hi and /help are the same on every host, with their colours.
// Usage: NODE_PATH=$(npm root -g) node test/cmd-print-hosts.js [hosts=page,worker]
const path = require('path');
const { chromium } = require(process.env.PW || 'playwright');
const lib = require('./lib.js');
const root = path.resolve(__dirname, '..');
const HOSTS = (process.argv[2] || 'page,worker').split(',');
const CMDS = ['/help give', '/say hi', '/help'];
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 400))); if (!ok) fails++; };
async function run(b, srv, host) {
  const ctx = await b.newContext({ viewport: { width: 900, height: 700 } });
  await ctx.route('**/three.min.js', r => r.fulfill({ path: path.join(root, '.three-test.min.js'), contentType: 'text/javascript' }));
  await ctx.route('https://fonts.**', r => r.abort());
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { console.log('PAGEERROR', (e.stack || e.message).slice(0, 300)); fails++; });
  await lib.install(pg);
  await pg.goto(srv.url + '?nolod&sim=' + host + '#seed=3');
  await pg.waitForFunction(() => window.BF && BF.simHost && (BF.simHost.worker || BF.simHost.why), null, { timeout: 120000 });
  await lib.ready(pg); await lib.simReady(pg);
  const out = {};
  for (const c of CMDS) {
    out[c] = await pg.evaluate(async c => {
      const lines = () => [...document.querySelectorAll('.bfc-line')].map(e => e.className.replace('bfc-line ', '') + ': ' + e.textContent);
      const n0 = lines().length;
      const r = BF.commands.execute(c); if (r.done) await r.done;
      await new Promise(r => setTimeout(r, 300));
      return lines().slice(n0).filter(l => !l.startsWith('dim: /'));
    }, c);
  }
  await ctx.close();
  return out;
}
(async () => {
  const srv = await lib.serve({ world: false });
  const b = await chromium.launch();
  const res = {};
  for (const h of HOSTS) res[h] = await run(b, srv, h);
  for (const h of HOSTS) {
    check(res[h]['/say hi'].length === 1 && /hi$/.test(res[h]['/say hi'][0]), h + ': /say prints its line', res[h]['/say hi']);
    check(res[h]['/help give'].length >= 2 && res[h]['/help give'][0].startsWith('gold: /give'), h + ': /help give prints the usage', res[h]['/help give']);
    check(res[h]['/help'].length > 10, h + ': /help lists the commands', res[h]['/help'].length);
    if (h !== HOSTS[0]) check(JSON.stringify(res[h]) === JSON.stringify(res[HOSTS[0]]), h + ': the same chat lines as ' + HOSTS[0]);
  }
  await b.close(); await srv.stop();
  console.log(fails ? fails + ' FAILED' : 'all ok');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
