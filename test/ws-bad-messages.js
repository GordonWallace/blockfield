// @ci integration suite=world timeout=600
// bug-078: malformed messages from a page don't stop the world server's simulation. A world server started as players run it (no
// --test), a raw WebSocket page on /sim playing seed 3; then, on the same connection: a clientLog whose list isn't a list, a view asking
// for a 1e9-chunk view distance with null coordinates, a request with garbage, a query with null args and {test: "crash"}. After
// each the simulation still answers a stats query, no crash message comes, and the server process is still running.
// Usage: NODE_PATH=$(npm root -g) node test/ws-bad-messages.js
const net = require('net'), crypto = require('crypto');
const lib = require('./lib.js');
function client(port) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0), up = false;
    const msgs = [];
    s.on('error', rej);
    s.on('connect', () => s.write('GET /sim HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!up) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; up = true; buf = buf.subarray(i + 4); res(c); }
      for (;;) {
        if (buf.length < 2) return;
        let n = buf[1] & 0x7f, at = 2;
        if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + n) return;
        const op = buf[0] & 15, p = buf.subarray(at, at + n); buf = buf.subarray(at + n);
        msgs.push({ op, text: op === 1 ? p.toString() : null, bin: op === 2 ? p : null });
      }
    });
    const raw = (op, payload, opts = {}) => {
      const n = payload.length, mask = crypto.randomBytes(4);
      const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
      const p = Buffer.from(payload); for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
      s.write(Buffer.concat([head, mask, p]));
    };
    const packet = (h, b) => { const hb = Buffer.from(h), out = Buffer.alloc(5 + hb.length + (b ? b.length : 0)); out.writeUInt32LE(hb.length, 0); out[4] = b ? 1 : 0; hb.copy(out, 5); if (b) b.copy(out, 5 + hb.length); raw(2, out); };
    const c = { s, msgs, raw, text: t => raw(1, Buffer.from(t)), packet, close: () => s.destroy() };
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, what, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); if (!ok) fails++; };
const CASES = [
  ['a clientLog whose list is not a list', c => c.packet(JSON.stringify({ t: 'clientLog', list: 5 }))],
  ['a view with null coordinates and a 1e9 distance', c => c.packet(JSON.stringify({ t: 'view', x: null, z: null, dist: 1e9 }))],
  ['a request with garbage', c => c.packet(JSON.stringify({ t: 'request', rid: 7, kind: 'place', target: 'abc', data: { id: 1e9 } }))],
  ['a query with null args', c => c.packet(JSON.stringify({ t: 'query', qid: 8, what: 'villager', args: null }))],
  ['{test: "crash"} without --test', c => c.text(JSON.stringify({ test: 'crash' }))],
];
(async () => {
  const srv = await lib.serve({ world: true, test: false });
  const hdr = m => m.bin ? m.bin.toString('utf8', 5, 5 + m.bin.readUInt32LE(0)) : '';
  const until = async (f, ms) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await wait(100); } return true; };
  try {
    const c = await client(srv.game);
    await until(() => c.msgs.some(m => m.text && /hello/.test(m.text)), 10000);
    c.text(JSON.stringify({ boot: { three: null } }));
    await until(() => c.msgs.some(m => m.text && /"ready"/.test(m.text)), 120000);
    c.packet(JSON.stringify({ t: 'world', wid: 1, op: 'demo', args: { seed: 3, opts: {} } }));
    check(await until(() => c.msgs.some(m => /"wid":1\b/.test(hdr(m))), 300000), 'the world started');
    c.packet(JSON.stringify({ t: 'speed', speed: 1, pause: false }));
    let qid = 100;
    for (const [name, fn] of CASES) {
      fn(c);
      await wait(1500);
      const q = ++qid;
      c.packet(JSON.stringify({ t: 'query', qid: q, what: 'stats', args: {} }));
      const answered = await until(() => c.msgs.some(m => new RegExp('"qid":' + q + '\\b').test(hdr(m)) || (m.text && new RegExp('"qid":' + q + '\\b').test(m.text))), 20000);
      const crash = c.msgs.find(m => m.text && /"crash"/.test(m.text));
      check(answered && !crash && srv.srv.exitCode == null, 'after ' + name + ' the simulation still answers', crash ? crash.text.slice(0, 200) : undefined);
    }
    const req = c.msgs.some(m => /"rid":7\b/.test(hdr(m)));
    check(req, 'the garbage request still got a result');
    c.close();
  } catch (e) { check(false, 'the test ran: ' + (e && e.stack || e)); }
  await srv.stop();
  console.log(fails ? fails + ' FAILED' : 'all ok');
  process.exit(fails ? 1 : 0);
})();
