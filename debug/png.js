// A small PNG reader and writer for the sandbox texture studio (spec idea-052), Node's built-in zlib only.
//   encode(w, h, rgba) -> Buffer (8-bit RGBA, no interlace)
//   decode(buf) -> {w, h, rgba} for 8-bit greyscale, grey + alpha, RGB, RGBA and palette images (with tRNS), no interlace; throws otherwise
//   resize(src, sw, sh, dw, dh) -> rgba: area-average downscale (or nearest upscale)
"use strict";
const zlib = require("zlib");

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0, plte = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString("ascii", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
    else if (t === "PLTE") plte = d;
    else if (t === "tRNS") trns = d;
    else if (t === "IDAT") idat.push(d);
    else if (t === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || inter) throw new Error("only 8-bit, non-interlaced PNGs are read (depth " + depth + ", interlace " + inter + ")");
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch || w <= 0 || h <= 0 || w * h > 16e6) throw new Error("unsupported PNG (colour type " + type + ", " + w + "x" + h + ")");
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0, b = y ? out[o - stride + x] : 0, c = x >= ch && y ? out[o - stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[o + x] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch, o = i * 4;
    if (type === 6) { rgba[o] = out[s]; rgba[o + 1] = out[s + 1]; rgba[o + 2] = out[s + 2]; rgba[o + 3] = out[s + 3]; }
    else if (type === 2) { rgba[o] = out[s]; rgba[o + 1] = out[s + 1]; rgba[o + 2] = out[s + 2]; rgba[o + 3] = 255; }
    else if (type === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = out[s]; rgba[o + 3] = 255; }
    else if (type === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = out[s]; rgba[o + 3] = out[s + 1]; }
    else { const k = out[s]; rgba[o] = plte[k * 3]; rgba[o + 1] = plte[k * 3 + 1]; rgba[o + 2] = plte[k * 3 + 2]; rgba[o + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { w, h, rgba };
}
function resize(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = Math.floor(x * sw / dw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw)), y0 = Math.floor(y * sh / dh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * sw + xx) * 4, al = src[i + 3]; r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++; }
    const o = (y * dw + x) * 4;
    if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
    out[o + 3] = a / n;
  }
  return out;
}
module.exports = { encode, decode, resize, crc32 };
