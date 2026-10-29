// @ci integration suite=ui timeout=180
// The Cluster workers setting's world-server side (Gordon, 2026-10-28; server/cores.js, server/world.js, js/simhost.js workers):
//   - server/cores.js reads CPU lists ("0-3,8,10-11") and gives an Automatic count between 1 and the CPUs this process may use (at most 16);
//   - the world server's hello carries that count (cores) and, started with --workers, the fixed count (fixed);
//   - a page's {workers: {n}} sets the count for the worlds started from then on (the server says so), Automatic as its own count;
//   - with --workers on the command line the page's setting is not used.
// Usage: node test/cluster-workers-setting.js
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), net = require('net');
const root = path.resolve(__dirname, '..');
const { perfCores, cpuList, MAX } = require('../server/cores.js');
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + what + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!ok) fails++; };
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const until = async (fn, ms, step = 100) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, step)); } return null; };

async function server(args) {
  const saves = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cw-'));
  const game = await freePort(), debug = await freePort();
  const srv = cp.spawn(process.execPath, ['debug/server.js', '--game', String(game), '--debug', String(debug), '--saves', saves, '--alerts', path.join(saves, '.alerts.json'), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.out = '';
  srv.stdout.on('data', d => { srv.out += d; }); srv.stderr.on('data', d => { srv.out += d; });
  await until(() => /Ctrl\+C/.test(srv.out), 20000);
  const ws = new WebSocket('ws://localhost:' + game + '/sim');
  const hello = await new Promise((res, rej) => { ws.onmessage = ev => { if (typeof ev.data === 'string') { const d = JSON.parse(ev.data); if (d.hello) res(d.hello); } }; ws.onerror = () => rej(new Error('no socket')); setTimeout(() => rej(new Error('no hello')), 15000); });
  return { srv, ws, hello, stop: () => new Promise(r => { try { ws.close(); } catch (_) {} srv.once('exit', () => { fs.rmSync(saves, { recursive: true, force: true }); r(); }); srv.kill('SIGKILL'); }) };
}

(async () => {
  check(JSON.stringify(cpuList('0-3,8,10-11\n')) === '[0,1,2,3,8,10,11]' && cpuList('').length === 0, 'cpuList reads CPU ranges', cpuList('0-3,8,10-11'));
  const c = perfCores(), logical = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  check(c.n >= 1 && c.n <= Math.min(MAX, logical) && typeof c.how === 'string', 'the Automatic count is between 1 and the usable CPUs (at most ' + MAX + ')', c);

  const a = await server([]);
  check(a.hello.cores && a.hello.cores.n === c.n && a.hello.fixed == null && a.hello.threads === 1, 'the hello carries the Automatic count, no fixed count, one thread', a.hello);
  a.ws.send(JSON.stringify({ workers: { n: 'auto' } }));
  const autoLine = await until(() => (a.srv.out.match(/cluster workers for the next worlds: .*/) || [])[0], 10000);
  check(c.n === 1 ? !autoLine : autoLine === 'cluster workers for the next worlds: ' + c.n + ' (automatic: ' + c.n + ' ' + c.how + ')', 'Automatic sets the next worlds\' count to the server\'s own', autoLine);
  a.ws.send(JSON.stringify({ workers: { n: 3, changed: true } }));
  const three = await until(() => /cluster workers for the next worlds: 3\b/.test(a.srv.out), 10000);
  check(!!three, 'a number sets the next worlds\' count', a.srv.out.split('\n').filter(l => /cluster workers/.test(l)));
  a.ws.send(JSON.stringify({ workers: { n: 1, changed: true } }));
  const one = await until(() => /cluster workers for the next worlds: 1\b/.test(a.srv.out), 10000);
  check(!!one, 'back to 1 (clusters off)', a.srv.out.split('\n').filter(l => /cluster workers/.test(l)));
  check(!/Error|crash/i.test(a.srv.out.split('\n').filter(l => /\[world\]/.test(l)).join('\n')), 'the server reported no errors', a.srv.out.split('\n').filter(l => /\[world\]/.test(l)).slice(-5));
  await a.stop();

  const b = await server(['--workers', '2']);
  check(b.hello.fixed === 2 && b.hello.threads === 2, 'with --workers 2 the hello says the count is fixed', b.hello);
  b.ws.send(JSON.stringify({ workers: { n: 4, changed: true } }));
  await new Promise(r => setTimeout(r, 1500));
  check(!/cluster workers for the next worlds/.test(b.srv.out), '--workers wins over the page\'s setting', b.srv.out.split('\n').filter(l => /cluster workers/.test(l)));
  await b.stop();
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
