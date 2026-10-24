// A saved world as one file (spec r15-42), to move worlds between the browser and the world server, or to keep a copy: "Export" on
// the title screen downloads one, "Import" reads one back. The same file in every mode: the world server writes and reads it
// (server/world.js), and so does the page when it keeps its worlds in IndexedDB (a file or the Artifact; js/save.js).
// The file (.bfworld) is gzipped JSON: {blockfield: "world", format: 1, game (the version that wrote it), meta (the list entry), data
// (js/save.js snapshot), log: {head, lists} (the game log, js/gamelog.js: its head and each batch's entries in head.batches order)}.
// JSON can't hold everything a save holds, so some values are tagged: typed arrays {"$t": "Int32Array", "b": base64}, Maps
// {"$m": [[k, v]...]}, Sets {"$s": [...]}, NaN and the infinities {"$n": "NaN"}, and an object that has a key of these own {"$o": {...}}.
// A file that isn't gzipped is read as plain JSON (handy for looking at one by hand).
// API (BF.saveFile in the page, require("../js/savefile.js") in Node):
//   encode(rec) -> JSON text, decode(text) -> rec; pack(rec) -> Promise<Blob> (page) | packSync(rec) -> Buffer (Node);
//   unpack(bytes: ArrayBuffer | Uint8Array) -> Promise<rec>; unpackSync(buffer) (Node); fileName(name); EXT
(() => {
"use strict";
const FORMAT = 1, EXT = ".bfworld";
const TAGS = ["$t", "$m", "$s", "$n", "$o"];
const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
if (typeof BigInt64Array !== "undefined") { TYPED.BigInt64Array = BigInt64Array; TYPED.BigUint64Array = BigUint64Array; }
const isNode = typeof module !== "undefined" && module.exports && typeof process !== "undefined" && !!(process.versions && process.versions.node);

function b64(u8) {
  if (isNode) return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  if (isNode) { const b = Buffer.from(s, "base64"); return new Uint8Array(b.buffer, b.byteOffset, b.length); }
  const t = atob(s), u = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i);
  return u;
}
// a value -> something JSON holds
function wrap(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : { $n: String(v) };
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { $t: v.constructor.name, b: b64(u8.slice()) };
  }
  if (v instanceof ArrayBuffer) return { $t: "ArrayBuffer", b: b64(new Uint8Array(v)) };
  if (v instanceof Map) return { $m: [...v].map(([k, x]) => [wrap(k), wrap(x)]) };
  if (v instanceof Set) return { $s: [...v].map(wrap) };
  if (Array.isArray(v)) return v.map(wrap);
  const o = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = wrap(v[k]);
  return TAGS.some(t => t in o) ? { $o: o } : o;
}
function unwrap(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(unwrap);
  if ("$t" in v) {
    const u8 = unb64(v.b), buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    if (v.$t === "ArrayBuffer") return buf;
    const T = TYPED[v.$t];
    if (!T) throw new Error("unknown array type " + v.$t);
    return new T(buf);
  }
  if ("$m" in v) return new Map(v.$m.map(([k, x]) => [unwrap(k), unwrap(x)]));
  if ("$s" in v) return new Set(v.$s.map(unwrap));
  if ("$n" in v) return Number(v.$n);
  const src = "$o" in v ? v.$o : v, o = {};
  for (const k of Object.keys(src)) o[k] = unwrap(src[k]);
  return o;
}

const F = {
  FORMAT, EXT,
  encode(rec) {
    return JSON.stringify({ blockfield: "world", format: FORMAT, game: rec.game || null, meta: wrap(rec.meta), data: wrap(rec.data), log: wrap(rec.log || null) });
  },
  decode(text) {
    let o;
    try { o = JSON.parse(text); } catch (e) { throw new Error("That isn't a Blockfield world file"); }
    if (!o || o.blockfield !== "world" || !o.meta || !o.data) throw new Error("That isn't a Blockfield world file");
    if (o.format > FORMAT) throw new Error("That world file was written by a newer Blockfield (format " + o.format + ")");
    return { game: o.game || null, meta: unwrap(o.meta), data: unwrap(o.data), log: unwrap(o.log) };
  },
  fileName: name => (String(name || "world").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim() || "world") + EXT,
  isGzip: u8 => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b,
};
if (isNode) {
  const zlib = require("zlib");
  F.packSync = rec => zlib.gzipSync(Buffer.from(F.encode(rec), "utf8"), { level: 6 });
  F.unpackSync = buf => { const u8 = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.length != null ? buf.length : buf.byteLength); return F.decode((F.isGzip(u8) ? zlib.gunzipSync(u8) : Buffer.from(u8)).toString("utf8")); };
  F.unpack = bytes => Promise.resolve().then(() => F.unpackSync(Buffer.from(bytes)));
  module.exports = F;
} else {
  const gz = typeof CompressionStream !== "undefined";
  F.pack = rec => {
    const blob = new Blob([F.encode(rec)], { type: "application/json" });
    if (!gz) return Promise.resolve(blob);
    return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob().then(b => new Blob([b], { type: "application/gzip" }));
  };
  F.unpack = bytes => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!F.isGzip(u8)) return Promise.resolve().then(() => F.decode(new TextDecoder().decode(u8)));
    if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("This browser can't read compressed world files"));
    return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).text().then(F.decode);
  };
  const BF = (globalThis.BF = globalThis.BF || {});
  BF.saveFile = F;
}
})();
