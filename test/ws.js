// @ci baseline suite=world
// The world server's WebSocket (spec r15-41, server/ws.js), no browser: an http server with it attached, talked to by Node's own
// WebSocket client and by hand-made frames on a raw socket. Checks the handshake (and refusing a bad one or another path), text and
// binary messages both ways, a large message (16 MB, a 64-bit length), a fragmented message, ping and pong, the close handshake both
// ways, and refusing an unmasked frame and a message over the size limit. Plain node: node test/ws.js
"use strict";
const http = require("http"), net = require("net"), crypto = require("crypto");
const WS = require("../server/ws.js");
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };

// a client frame by hand: masked, fin or not
function cframe(op, payload, fin = true, masked = true) {
  const n = payload.length, mask = crypto.randomBytes(4);
  const head = Buffer.alloc(2 + (n < 126 ? 0 : n < 65536 ? 2 : 8));
  head[0] = (fin ? 0x80 : 0) | op;
  if (n < 126) head[1] = n; else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); } else { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  if (masked) head[1] |= 0x80;
  const p = Buffer.from(payload);
  if (masked) for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
  return Buffer.concat(masked ? [head, mask, p] : [head, p]);
}
// a raw socket that has done the handshake; resolves {sock, frames (parsed server frames as they come), status}
function raw(port, path = "/sim", key = crypto.randomBytes(16).toString("base64")) {
  return new Promise(res => {
    const sock = net.connect(port, "127.0.0.1"), frames = [];
    let buf = Buffer.alloc(0), status = null, accept = null;
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      if (status === null) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        status = +head.split(" ")[1]; accept = (/Sec-WebSocket-Accept: (\S+)/i.exec(head) || [])[1];
        buf = buf.subarray(end + 4);
        res({ sock, frames, status, accept, key });
      }
      while (buf.length >= 2) {
        let n = buf[1] & 0x7f, at = 2;
        if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
        else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
        if (buf.length < at + n) return;
        frames.push({ fin: !!(buf[0] & 0x80), op: buf[0] & 15, masked: !!(buf[1] & 0x80), p: buf.subarray(at, at + n) });
        buf = buf.subarray(at + n);
      }
    });
    sock.on("error", () => {});
    sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
}
const until = (f, ms = 5000) => new Promise((res, rej) => { const t0 = Date.now(), i = setInterval(() => { const v = f(); if (v) { clearInterval(i); res(v); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error("timed out")); } }, 10); });

(async () => {
  const server = http.createServer((req, res) => res.end("plain http"));
  const got = [], closes = [];
  let last = null;
  WS.attach(server, "/sim", ws => {
    last = ws;
    ws.on("message", (d, binary) => {
      got.push({ d, binary });
      if (!binary && d.toString() === "echo-big") ws.send(Buffer.alloc(16 * 1024 * 1024, 7));
      else if (!binary && d.toString() === "bye") ws.close(4000, "server says bye");
      else ws.send(binary ? d : d.toString());   // echo, as it came
    });
    ws.on("close", (code, reason) => closes.push({ code, reason }));
    ws.on("error", () => {});
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    // the accept key: the RFC's own example
    check(WS.acceptKey("dGhlIHNhbXBsZSBub25jZQ==") === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "the handshake's accept key is the RFC 6455 example's");
    // ---- Node's own client
    const c = new WebSocket(`ws://127.0.0.1:${port}/sim`);
    c.binaryType = "arraybuffer";
    const back = [];
    c.onmessage = ev => back.push(ev.data);
    await new Promise((res, rej) => { c.onopen = res; c.onerror = rej; });
    check(true, "a browser-style client connects (the handshake)");
    c.send("hello ✓");
    c.send(new Uint8Array([1, 2, 3, 250]));
    await until(() => back.length >= 2);
    check(back[0] === "hello ✓", "a text message (UTF-8) goes both ways");
    check(back[1] instanceof ArrayBuffer && Buffer.from(back[1]).equals(Buffer.from([1, 2, 3, 250])), "a binary message goes both ways");
    const big = crypto.randomBytes(300000);
    c.send(big);
    await until(() => back.length >= 3);
    check(Buffer.from(back[2]).equals(big), "a 300 KB binary message (a 64-bit length) comes back the same");
    const huge = crypto.randomBytes(20 * 1024 * 1024);
    const tq = Date.now();
    c.send(huge);
    await until(() => back.length >= 4, 20000);
    check(Buffer.from(back[3]).equals(huge), `a 20 MB message to the server arrives whole and comes back (${Date.now() - tq} ms)`);
    c.send("echo-big");
    await until(() => back.length >= 5, 20000);
    check(back[4].byteLength === 16 * 1024 * 1024 && new Uint8Array(back[4])[12345678] === 7, "a 16 MB message from the server arrives whole");
    c.send("bye");
    const cc = await new Promise(res => { c.onclose = ev => res(ev); });
    check(cc.code === 4000 && cc.reason === "server says bye", `the server closes with a code and reason (${cc.code} "${cc.reason}")`);
    // ---- by hand
    const r = await raw(port);
    check(r.status === 101 && r.accept === WS.acceptKey(r.key), "a raw handshake gets 101 and the right accept key");
    r.sock.write(Buffer.concat([cframe(1, Buffer.from("frag"), false), cframe(9, Buffer.from("pp")), cframe(0, Buffer.from("men"), false), cframe(0, Buffer.from("ted"))]));
    await until(() => r.frames.length >= 2);
    const pong = r.frames.find(f => f.op === 10), echo = r.frames.find(f => f.op === 1);
    check(pong && pong.p.toString() === "pp", "a ping between fragments gets its pong");
    check(echo && echo.p.toString() === "fragmented" && got.some(g => g.d.toString() === "fragmented"), "a fragmented message is put back together");
    check(r.frames.every(f => !f.masked), "the server's frames are not masked");
    const nClose = closes.length;
    r.sock.write(cframe(8, Buffer.from([0x03, 0xe8])));
    await until(() => r.frames.some(f => f.op === 8));
    check(r.frames.find(f => f.op === 8).p.readUInt16BE(0) === 1000, "the client's close is answered with a close");
    await until(() => closes.length > nClose);
    check(closes[closes.length - 1].code === 1000, "and the server's socket reports it closed (1000)");
    // an unmasked frame: protocol error
    const u = await raw(port);
    u.sock.write(cframe(1, Buffer.from("x"), true, false));
    await until(() => u.frames.some(f => f.op === 8));
    check(u.frames.find(f => f.op === 8).p.readUInt16BE(0) === 1002, "an unmasked frame from the client closes with 1002");
    // too big: a length over the limit, before any of the data
    const t = await raw(port);
    const h = Buffer.alloc(14); h[0] = 0x82; h[1] = 0xff; h.writeBigUInt64BE(BigInt(WS.MAX) + 1n, 2);
    t.sock.write(h);
    await until(() => t.frames.some(f => f.op === 8));
    check(t.frames.find(f => f.op === 8).p.readUInt16BE(0) === 1009, "a message over the limit closes with 1009");
    // bad requests
    const other = await raw(port, "/other");
    check(other.status === 404, "another path is refused (404)");
    const bad = await raw(port, "/sim", "short");
    check(bad.status === 400, "a bad key is refused (400)");
    const plain = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    check(plain === "plain http", "plain http requests still go to the server");
    for (const s of [r, u, t, other, bad]) s.sock.destroy();
  } catch (e) {
    check(false, "the test ran: " + (e && e.stack || e));
  }
  server.close();
  console.log(fails ? `FAILED ${fails} check(s)` : "all checks passed");
  process.exit(fails ? 1 : 0);
})();
