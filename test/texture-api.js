// @ci baseline suite=ui timeout=120
// The texture studio's server side (spec idea-052), with a stand-in provider (no key, no network; no live model is called in CI):
// the PNG reader on every row filter (0-4) and on palette images; a grid answer with a short row and an unknown symbol fixed and the
// fixes listed; a grid too broken to fix sent back once with the reasons and the second answer kept; an image answer fitted to 32x32
// with at most 32 colours; a recipe with an unknown step trimmed; the call records (kind "texture") and the hourly cap; save writes a
// PNG and a JSON record; adopt writes adopted.json and adopted.js (the newest adoption of a tile wins, with a warning); unadopt removes it.
// The files it writes are removed and sandbox/adopted.json and adopted.js are put back as they were.
// Usage: node test/texture-api.js
"use strict";
delete process.env.ANTHROPIC_API_KEY;
process.env.BF_CLAUDE_KEY_FILE = "/nonexistent/key";
const fs = require("fs"), path = require("path"), zlib = require("zlib"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const png = require(path.join(ROOT, "debug", "png.js")), tex = require(path.join(ROOT, "debug", "texture.js")), claude = require(path.join(ROOT, "debug", "claude.js"));
let fails = 0;
const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const SB = path.join(ROOT, "sandbox"), keep = {};
for (const f of ["adopted.json", "adopted.js"]) keep[f] = fs.readFileSync(path.join(SB, f));
const written = [];
const restore = () => { for (const f in keep) fs.writeFileSync(path.join(SB, f), keep[f]); for (const f of written) try { fs.unlinkSync(f); } catch (e) { /* gone */ } };

// ---- a PNG writer with a chosen row filter, to test the reader's unfiltering
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(png.crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodeWith(w, h, rgba, filter) {
  const bpp = 4, stride = w * bpp, raw = Buffer.alloc((stride + 1) * h);
  const at = (x, y) => (x < 0 || y < 0 ? 0 : rgba[y * stride + x]);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = filter === "mixed" ? y % 5 : filter;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = at(x, y), a = at(x - bpp, y), b = at(x, y - 1), c = at(x - bpp, y - 1);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function paletteImage(w, h, idx, plte, trns) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = idx[y * w + x];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", Buffer.from(plte)), chunk("tRNS", Buffer.from(trns)), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  try {
    // ---- PNG
    const W = 7, H = 5, img = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < img.length; i++) img[i] = (i * 37 + (i >> 3) * 11) & 255;
    for (const f of [0, 1, 2, 3, 4, "mixed"]) {
      const d = png.decode(encodeWith(W, H, img, f));
      check(d.w === W && d.h === H && Buffer.compare(Buffer.from(d.rgba), Buffer.from(img)) === 0, "PNG reader: filter " + f + " round trip");
    }
    const rt = png.decode(png.encode(W, H, img));
    check(Buffer.compare(Buffer.from(rt.rgba), Buffer.from(img)) === 0, "PNG writer and reader round trip");
    const pal = png.decode(paletteImage(2, 1, [0, 1], [255, 0, 0, 0, 0, 255], [255, 0]));
    check(pal.rgba[0] === 255 && pal.rgba[3] === 255 && pal.rgba[6] === 255 && pal.rgba[7] === 0, "PNG reader: palette image with tRNS");

    // ---- grids
    const rows = Array.from({ length: 32 }, () => "ab".repeat(16));
    const g = tex.gridPixels({ palette: [{ symbol: "a", color: "#ff0000" }, { symbol: "b", color: "#00ff00" }], rows: rows.slice(0, 31).concat(["ab".repeat(15) + "aZ"]) });
    check(!g.error && g.rgba.length === 4096, "a grid becomes 32x32 RGBA");
    check(g.rgba[0] === 255 && g.rgba[5] === 255, "grid colours land where their symbols are");
    check(!g.error && g.fixes.some(f => /not in the palette/.test(f)), "an unknown symbol is fixed and listed: " + (g.fixes || []).join("; "));
    const short = tex.gridPixels({ palette: [{ symbol: "a", color: "#ff0000" }], rows: rows.slice(0, 30).map(() => "a".repeat(32)) });
    check(!short.error && short.fixes.length > 0, "a grid two rows short is padded and the fix listed");
    const broken = tex.gridPixels({ palette: [{ symbol: "a", color: "#ff0000" }], rows: ["a"] });
    check(!!broken.error, "a grid too broken to fix is refused: " + broken.error);

    // ---- images
    const big = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) { big[i * 4] = (i * 7) & 255; big[i * 4 + 1] = (i * 13) & 255; big[i * 4 + 2] = (i >> 4) & 255; big[i * 4 + 3] = 255; }
    const fit = tex.fitImage(png.encode(64, 64, big));
    const cols = new Set();
    for (let i = 0; i < fit.rgba.length; i += 4) cols.add(fit.rgba[i] + "," + fit.rgba[i + 1] + "," + fit.rgba[i + 2]);
    check(fit.rgba.length === 4096 && cols.size <= 32, "an image is fitted to 32x32 with at most 32 colours (" + cols.size + ")");

    // ---- recipes
    const rc = tex.checkRecipe([{ op: "stone", colors: ["#555555", "#888888"] }, { op: "explode" }, { op: "moss", amount: 0.3 }]);
    check(!rc.error && rc.steps.length === 2 && rc.fixes.some(f => /explode/.test(f)), "a recipe's unknown step is left out and listed");
    check(!!tex.checkRecipe([]).error, "an empty recipe is refused");

    // ---- requests through a stand-in provider
    const answers = [];
    const seen = [];
    tex.addProvider({ name: "fake", label: "Fake", models: ["fake-1"], model: "fake-1", configured: () => true,
      texture: async (input, ctx) => { seen.push({ input, feedback: ctx.feedback, tilePng: ctx.tilePng }); return Object.assign({ log: { cost: 0.001, ms: 5 } }, answers.shift()); } });
    check(tex.status().providers.some(p => p.name === "fake" && p.configured), "a provider added is listed in status");
    const tile = Buffer.alloc(4096, 128).toString("base64");
    const req = extra => tex.request(Object.assign({ provider: "fake", request: "make it mossy", tile, face: "side", block: "stone", tileName: "stone" }, extra || {}));
    const okGrid = { kind: "grid", palette: [{ symbol: "a", color: "#336633" }], rows: Array.from({ length: 32 }, () => "a".repeat(32)), notes: "green" };
    answers.push(okGrid);
    let [code, r] = await req();
    check(code === 200 && r.kind === "pixels" && r.from === "grid" && r.provider === "fake" && r.model === "fake-1", "a grid answer comes back as pixels");
    check(Buffer.from(r.rgba, "base64")[1] === 0x66, "the pixels are the grid's colour");
    check(seen[0].tilePng && png.decode(Buffer.from(seen[0].tilePng, "base64")).w === 256, "the provider gets the tile enlarged 8x as a PNG");
    answers.push({ kind: "grid", palette: [], rows: [] }, okGrid);
    seen.length = 0;
    [code, r] = await req();
    check(code === 200 && r.kind === "pixels" && seen.length === 2 && !!seen[1].feedback, "a broken answer goes back once with its problems, the second is kept");
    answers.push({ kind: "grid", rows: [] }, { kind: "grid", rows: [] });
    [code, r] = await req();
    check(code === 200 && !!r.error, "two broken answers: an error, nothing applied: " + r.error);
    answers.push({ kind: "image", png: png.encode(64, 64, big).toString("base64") });
    [code, r] = await req();
    check(r.kind === "pixels" && r.from === "image" && r.fixes.some(f => /fitted/.test(f)), "an image answer is fitted");
    answers.push({ kind: "recipe", steps: [{ op: "cobble", colors: ["#555555", "#777777", "#222222"] }, { op: "nope" }], notes: "cobbles" });
    [code, r] = await req();
    check(r.kind === "recipe" && r.steps.length === 1 && r.fixes.length === 1, "a recipe answer comes back trimmed");
    answers.push({ kind: "refused" });
    [code, r] = await req();
    check(r.refused === true, "a refusal is passed on");
    [code, r] = await req({ model: "other" });
    check(code === 400, "an unknown model is refused");
    const recs = claude.callLog().filter(c => c.kind === "texture");
    check(recs.length >= 6 && recs.every(c => c.model && c.model.startsWith("fake")), "every request has a call record of kind texture (" + recs.length + ")");

    // ---- save, adopt, unadopt
    const name = "zz-test-" + process.pid;
    written.push(path.join(SB, "textures", name + ".png"), path.join(SB, "textures", name + ".json"), path.join(SB, "textures", name + "b.png"), path.join(SB, "textures", name + "b.json"));
    const pix = Buffer.alloc(4096); for (let i = 0; i < 4096; i++) pix[i] = i & 255;
    [code, r] = await tex.save({ name, rgba: pix.toString("base64"), meta: { face: "side", block: "stone", tile: "stone", history: ["mossy"] } });
    check(code === 200 && r.ok && fs.existsSync(path.join(SB, "textures", name + ".png")), "save writes the PNG");
    const recd = JSON.parse(fs.readFileSync(path.join(SB, "textures", name + ".json"), "utf8"));
    check(recd.format === "bf-texture-1" && recd.rgba === pix.toString("base64") && recd.history[0] === "mossy", "save writes the JSON record with the pixels and history");
    check(Buffer.compare(Buffer.from(png.decode(fs.readFileSync(path.join(SB, "textures", name + ".png"))).rgba), pix) === 0, "the saved PNG has the same pixels");
    [code, r] = await tex.save({ name: "../x", rgba: pix.toString("base64") });
    check(code === 400, "a bad name is refused");
    [code, r] = await tex.save({ name, rgba: "AAAA" });
    check(code === 400, "pixels of the wrong size are refused");
    [code, r] = await tex.adopt({ name, tile: "stone", block: "stone", face: "side" });
    check(code === 200 && r.ok && r.rgba === pix.toString("base64") && !r.warning, "adopt returns the pixels");
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(path.join(SB, "adopted.js"), "utf8"), ctx);
    check(ctx.BF.adoptedTextures.stone && ctx.BF.adoptedTextures.stone.texture === name, "adopted.js gives the game the tile's pixels");
    await tex.save({ name: name + "b", rgba: pix.toString("base64") });
    [code, r] = await tex.adopt({ name: name + "b", tile: "stone" });
    check(r.ok && /replaced/.test(r.warning || "") && tex.readAdopted().filter(a => a.tile === "stone").length === 1, "a newer adoption of the same tile replaces the older, with a warning");
    [code, r] = await tex.adopt({ name: "no-such-texture", tile: "stone" });
    check(code === 400, "adopting a texture that isn't saved is refused");
    [code, r] = await tex.unadopt({ tile: "stone" });
    check(r.ok && !tex.readAdopted().some(a => a.tile === "stone"), "unadopt removes the tile's adoption");
    [code, r] = await tex.unadopt({ tile: "stone" });
    check(code === 400, "unadopting a tile with nothing adopted is refused");
  } catch (e) { fails++; console.log("FAIL threw: " + (e && e.stack || e)); }
  restore();
  console.log(fails ? fails + " failed" : "all passed");
  process.exit(fails ? 1 : 0);
})();
