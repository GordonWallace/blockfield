// A minimal WebSocket server (RFC 6455) for the world server (spec r15-41): the repo has no npm packages, so this is the handshake and
// the framing the game needs, no more: text and binary messages of any size (fragmented or not), ping/pong and close. No extensions
// (no compression), no subprotocols. Frames from the browser are masked (a frame that isn't is refused, as the RFC says); ours aren't.
// API: attach(server, path, onSocket(ws, req)) hooks an http server's upgrade requests for path; accept(req, socket, head) -> ws or null.
//   ws: an EventEmitter. send(string | Buffer | ArrayBuffer | typed array) (text for a string, binary otherwise), close(code?, reason?),
//   ping(), open (bool), bufferedAmount; events "message" (data: Buffer, binary: bool), "close" (code, reason), "error" (err).
// Limits: one message may be up to MAX bytes (256 MB): a bigger one closes the socket with 1009.
"use strict";
const crypto = require("crypto"), EventEmitter = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", MAX = 256 * 1024 * 1024;
const OP = { cont: 0, text: 1, bin: 2, close: 8, ping: 9, pong: 10 };

const acceptKey = key => crypto.createHash("sha1").update(key + GUID).digest("base64");

// One frame: FIN set, unmasked (server to client)
function frame(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | op;
  if (n < 126) head[1] = n;
  else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return [head, payload];
}

class WebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket; this.open = true;
    this.q = []; this.qn = 0; this.need = 0; this.parts = []; this.partOp = 0; this.partLen = 0; this.closeSent = false;
    socket.setNoDelay(true);
    socket.on("data", d => { try { this.data(d); } catch (e) { this.fail(1002, e.message); } });
    socket.on("close", () => this.gone(1006, ""));
    socket.on("error", e => { this.emit("error", e); this.gone(1006, e.message); });
  }
  get bufferedAmount() { return this.socket.writableLength; }
  // the bytes that came: as many whole frames as they hold
  // (chunks wait in q until there are enough for the next frame, so a big message isn't copied again with every chunk)
  data(d) {
    this.q.push(d); this.qn += d.length;
    if (this.qn < this.need) return;
    let b = this.q.length === 1 ? this.q[0] : Buffer.concat(this.q, this.qn);
    this.q = []; this.qn = 0; this.need = 0;
    const wait = need => { if (b.length) { this.q.push(b); this.qn = b.length; } this.need = need; };
    for (;;) {
      if (b.length < 2) { wait(2); return; }
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      if (b[0] & 0x70) throw new Error("reserved bits set (no extensions here)");
      let n = b[1] & 0x7f, at = 2;
      if (n === 126) { if (b.length < 4) { wait(4); return; } n = b.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (b.length < 10) { wait(10); return; } const big = b.readBigUInt64BE(2); if (big > BigInt(MAX)) { this.fail(1009, "message too big"); return; } n = Number(big); at = 10; }
      if (!masked) throw new Error("an unmasked frame from the client");
      if (n > MAX || this.partLen + n > MAX) { this.fail(1009, "message too big"); return; }
      if (b.length < at + 4 + n) { wait(at + 4 + n); return; }
      const mask = b.subarray(at, at + 4), p = Buffer.from(b.subarray(at + 4, at + 4 + n));
      for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
      b = b.subarray(at + 4 + n);
      this.frame(fin, op, p);
      if (!this.open) return;
    }
  }
  frame(fin, op, p) {
    if (op >= 8) {   // control frames: never fragmented, at most 125 bytes
      if (!fin || p.length > 125) throw new Error("a bad control frame");
      if (op === OP.ping) this.write(OP.pong, p);
      else if (op === OP.close) {
        const code = p.length >= 2 ? p.readUInt16BE(0) : 1005, reason = p.length > 2 ? p.subarray(2).toString("utf8") : "";
        if (!this.closeSent) { this.closeSent = true; this.write(OP.close, p.length >= 2 ? p.subarray(0, 2) : Buffer.alloc(0)); }
        this.socket.end();
        this.gone(code, reason);
      } else if (op !== OP.pong) throw new Error("unknown control opcode " + op);
      return;
    }
    if (op === OP.cont) { if (!this.partOp) throw new Error("a continuation with nothing to continue"); }
    else if (op === OP.text || op === OP.bin) { if (this.partOp) throw new Error("a new message inside a fragmented one"); this.partOp = op; }
    else throw new Error("unknown opcode " + op);
    this.parts.push(p); this.partLen += p.length;
    if (!fin) return;
    const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partLen), binary = this.partOp === OP.bin;
    this.parts = []; this.partOp = 0; this.partLen = 0;
    this.emit("message", whole, binary);
  }
  write(op, payload) { if (!this.socket.destroyed) for (const x of frame(op, payload)) this.socket.write(x); }
  send(data) {
    if (!this.open || this.closeSent) return false;
    if (typeof data === "string") this.write(OP.text, Buffer.from(data, "utf8"));
    else this.write(OP.bin, Buffer.isBuffer(data) ? data : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data));
    return true;
  }
  ping() { if (this.open) this.write(OP.ping, Buffer.alloc(0)); }
  close(code = 1000, reason = "") {
    if (!this.open || this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(String(reason).slice(0, 120), "utf8"), p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.write(OP.close, p);
    // the client answers with its own close; if it doesn't within 2 s the connection goes anyway
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }
  fail(code, why) { this.emit("error", new Error(why)); this.close(code, why); this.socket.end(); this.gone(code, why); }
  gone(code, reason) { if (!this.open) return; this.open = false; this.emit("close", code, reason); }
}

// The handshake: a valid upgrade request becomes a WebSocket; anything else gets a 400 and null
function accept(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (req.method !== "GET" || String(req.headers.upgrade || "").toLowerCase() !== "websocket" || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nSec-WebSocket-Version: 13\r\n\r\n");
    return null;
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n");
  const ws = new WebSocket(socket);
  if (head && head.length) ws.data(head);
  return ws;
}

function attach(server, path, onSocket) {
  server.on("upgrade", (req, socket, head) => {
    let p;
    try { p = new URL(req.url, "http://x").pathname; } catch (e) { p = ""; }
    if (p !== path) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
    const ws = accept(req, socket, head);
    if (ws) onSocket(ws, req);
  });
}

module.exports = { attach, accept, acceptKey, frame, WebSocket, MAX };
