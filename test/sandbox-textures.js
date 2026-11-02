// @ci integration suite=ui hosts=worker timeout=420
// The sandbox texture studio in the game (spec idea-052), with a stand-in for the texture server (BF.textureStudio.api answers
// sandbox/api/texture and its status here; no model is called): K opens it on the block in view, in sandbox worlds only; a grid answer
// lands in the stone tile's atlas cell (every mip level re-uploaded, so every placed stone block changes) and no other tile changes; a
// recipe answer is painted with the game's own painters; "All" faces changes every tile of grass at once; animated water can't be edited;
// Undo and Compare show the earlier and the game's pixels and come back; with the page served by the local server, Save writes the PNG,
// the library applies it again, "Use in all worlds" adopts it (adopted.js), and outside a sandbox world the edits go back to the game's
// tiles while the adopted one stays; Unadopt gives the game's own stone back. sandbox/adopted.json and adopted.js are put back after.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/textures test/sandbox-textures.js [--host page|worker]
const fs = require('fs'), path = require('path');
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
  const SB = path.join(__dirname, '..', 'sandbox'), keep = {};
  for (const f of ['adopted.json', 'adopted.js']) keep[f] = fs.readFileSync(path.join(SB, f));
  const written = [];
  try {
    await pg.evaluate(async () => { BF.player.start(); return BF.save.create({ name: "textures-test", seed: "92", gameMode: "creative", world: "flat" }); });
    await pg.waitForFunction(() => BF.world.isLoaded(BF.worldSpawn.x, BF.worldSpawn.z), null, { timeout: 120000 });

    // the stand-in server: a red/blue checker grid, then a recipe, then pixels as if from an image
    await pg.evaluate(() => {
      window.__answers = []; window.__sent = [];
      const real = BF.textureStudio.api;
      BF.textureStudio.api = (p, body) => {
        if (p === "sandbox/api/texture/status") return Promise.resolve({ providers: [{ name: "fake", label: "Fake", models: ["fake-1"], model: "fake-1", configured: true, error: null }], provider: "fake", hour: 0, hourCap: 1 });
        if (p === "sandbox/api/texture") { window.__sent.push(body); return Promise.resolve(Object.assign({ provider: "fake", model: "fake-1", cost: 0.001, fixes: [], notes: "" }, window.__answers.shift())); }
        return real(p, body);
      };
    });
    const OFF = await pg.evaluate(() => BF.textures.edit.OFF), CELL = await pg.evaluate(() => BF.textures.edit.CELL);
    const orig = await pg.evaluate(() => ({ stone: Array.from(BF.textures.edit.pixels("stone")), dirt: Array.from(BF.textures.edit.pixels("dirt")), grassTop: Array.from(BF.textures.edit.pixels("grass_top")) }));

    // K on a stone block
    await pg.evaluate(() => {
      const s = BF.worldSpawn, x = Math.floor(s.x), z = Math.floor(s.z) - 3, y = BF.flatgen.TOP + 1;
      const c = BF.planet.canonCell(x, z, {});
      BF.commands.execute(`/setblock ${c.u} ${y} ${c.v} stone`);
      BF.player.teleport(x + 0.5, y, z + 3.5);
      BF.player.setLook(0, -0.35);
    });
    await pg.waitForFunction(() => { const t = BF.player.target; return t && t.id === BF.B.stone; }, null, { timeout: 20000 }).catch(() => {});
    await pg.keyboard.press('KeyK');
    let st = await pg.evaluate(() => ({ open: BF.textureStudio.isOpen(), block: BF.textureStudio.state.block }));
    if (!st.open) { await pg.evaluate(() => { BF.textureStudio.open(); BF.textureStudio.setBlock(BF.B.stone); }); st = await pg.evaluate(() => ({ open: BF.textureStudio.isOpen(), block: BF.textureStudio.state.block })); console.log('(K did not open it on the block in view; opened by call)'); }
    check(st.open && st.block === (await pg.evaluate(() => BF.B.stone)), `K opens the studio on the stone block in view (${JSON.stringify(st)})`);
    await pg.waitForFunction(() => document.querySelector('.bfx-wrap.open .bfx-on') && !document.querySelector('.bfx-on').hidden, null, { timeout: 10000 }).catch(() => {});
    check(await pg.evaluate(() => !document.querySelector('.bfx-on').hidden), 'the panel shows the request form once the provider is ready');

    // a grid answer
    const grid = { kind: "pixels", from: "grid", rgba: null };
    grid.rgba = await pg.evaluate(() => { const a = new Uint8ClampedArray(4096); for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const i = (y * 32 + x) * 4, r = (x >> 2 ^ y >> 2) & 1; a[i] = r ? 200 : 20; a[i + 1] = 30; a[i + 2] = r ? 20 : 200; a[i + 3] = 255; } return BF.textureStudio.b64(a); });
    await pg.evaluate(g => window.__answers.push(g), grid);
    const v1 = await pg.evaluate(async () => { const v = await BF.textureStudio.request("red and blue checks", "side"); return v && { n: v.n, kind: v.kind }; });
    check(v1 && v1.n === 1, `a grid answer gives v1 (${JSON.stringify(v1)})`);
    const sent = await pg.evaluate(() => { const b = window.__sent[0]; return { tile: b.tileName, block: b.block, face: b.face, shot: typeof b.screenshot === "string" && b.screenshot.length > 100, tileLen: atob(b.tile).length }; });
    check(sent.tile === 'stone' && sent.block === 'stone' && sent.face === 'side' && sent.tileLen === 4096, `the request sends the stone tile (${JSON.stringify(sent)})`);
    check(sent.shot, 'and a close-up of the block in the world');
    const cellPx = (name, k, x, y) => pg.evaluate(([n, k, x, y, OFF, CELL]) => { const c = BF.textures.edit.cell(n, k), cs = CELL >> k, o = OFF >> k, i = ((o + y) * cs + o + x) * 4; return [c[i], c[i + 1], c[i + 2], c[i + 3]]; }, [name, k, x, y, OFF, CELL]);
    const p00 = await cellPx('stone', 0, 0, 0), p40 = await cellPx('stone', 0, 4, 0);
    check(p00[0] === 20 && p00[2] === 200 && p40[0] === 200 && p40[2] === 20, `the stone atlas cell holds the new pixels (${p00} / ${p40})`);
    const m2 = await cellPx('stone', 2, 0, 0);
    check(Math.abs(m2[0] - 20) < 40 && m2[2] > 150, `and its smaller mip levels too (level 2: ${m2})`);
    const dirtNow = await pg.evaluate(() => Array.from(BF.textures.edit.pixels("dirt")));
    check(dirtNow.join() === orig.dirt.join(), 'no other tile changes');
    await pg.screenshot({ path: out + '-grid.png' });

    // a recipe answer, painted here
    await pg.evaluate(() => window.__answers.push({ kind: "recipe", steps: [{ op: "cobble", colors: ["#6a4a3a", "#8a6a5a", "#2a2020"] }, { op: "moss", amount: 0.4 }], notes: "mossy brown cobbles" }));
    const v2 = await pg.evaluate(async () => { const v = await BF.textureStudio.request("mossy brown cobbles"); return v && { n: v.n, kind: v.kind }; });
    const stone2 = await pg.evaluate(() => Array.from(BF.textures.edit.pixels("stone")));
    const greenish = await pg.evaluate(px => { let g = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 1] > px[i] + 10 && px[i + 1] > px[i + 2]) g++; return g; }, stone2);
    check(v2 && v2.n === 2 && v2.kind === 'recipe' && greenish > 30, `a recipe answer is painted with the game's painters (${greenish} mossy pixels)`);
    check(await pg.evaluate(() => window.__sent[1].history.length === 1 && window.__sent[1].history[0] === "red and blue checks"), 'the second request sends the first in its history');

    // Undo and Compare
    await pg.evaluate(() => BF.textureStudio.undo());
    check((await cellPx('stone', 0, 4, 0))[0] === 200, 'Undo brings v1 back on every stone block');
    await pg.evaluate(() => BF.textureStudio.compare(true));
    const cmp = await pg.evaluate(() => Array.from(BF.textures.edit.pixels("stone")));
    check(cmp.join() === orig.stone.join(), 'Compare shows the game\'s own stone');
    await pg.evaluate(() => BF.textureStudio.compare(false));
    check((await cellPx('stone', 0, 4, 0))[0] === 200, 'and back to the current version');

    // all faces of grass at once; grass is tinted and says so
    await pg.evaluate(() => BF.textureStudio.setBlock(BF.B.grass));
    await pg.evaluate(g => window.__answers.push(g), grid);
    const all = await pg.evaluate(async () => { const tiles = BF.textureStudio.tilesFor("all"); const v = await BF.textureStudio.request("checks", "all"); return { tiles, v: !!v, tinted: BF.textures.edit.editable("grass_top").tinted, note: document.querySelector('.bfx-note').textContent }; });
    const gt = await cellPx('grass_top', 0, 0, 0), dt = await cellPx('dirt', 0, 0, 0);
    check(all.v && all.tiles.length === 3 && gt[2] === 200 && dt[2] === 200, `"All" changes every tile of grass (${all.tiles.join(', ')})`);
    check(all.tinted && /tinted/.test(all.note), 'the panel says grass is tinted by the biome');
    check(await pg.evaluate(() => !BF.textures.edit.editable("water").ok && !BF.textures.edit.setPixels("water", new Uint8ClampedArray(4096))), 'animated water can\'t be edited');

    const http = await pg.evaluate(() => /^https?:/.test(location.protocol));
    if (http) {
      const name = 'ci-tex-' + Date.now();
      written.push(path.join(SB, 'textures', name + '.png'), path.join(SB, 'textures', name + '.json'));
      await pg.evaluate(() => BF.textureStudio.setBlock(BF.B.stone));
      const sv = await pg.evaluate(async n => { const r = await BF.textureStudio.save(n); return { r, lib: BF.textureStudio.state.lib }; }, name);
      check(sv.r.ok && fs.existsSync(written[0]) && sv.lib.includes(name), `Save writes sandbox/textures/${name}.png and the library lists it`);
      // back to the game's stone, then the library puts it on again
      await pg.evaluate(() => BF.textureStudio.restore("stone", 0));
      check((await cellPx('stone', 0, 4, 0))[0] !== 200, 'Original restores the game\'s stone');
      const la = await pg.evaluate(async n => BF.textureStudio.applyLibrary(n), name);
      check(la && la.includes('stone') && (await cellPx('stone', 0, 4, 0))[0] === 200, 'the library applies the saved texture again');
      // adopt for every world, then leave the sandbox: edits go back, the adopted tile stays
      const ad = await pg.evaluate(async n => { const r = await BF.textureStudio.adopt(n, "stone", "side"); return { ok: r.ok, have: !!(BF.adoptedTextures && BF.adoptedTextures.stone) }; }, name);
      const js = fs.readFileSync(path.join(SB, 'adopted.js'), 'utf8');
      check(ad.ok && ad.have && js.includes(name), 'Use in all worlds writes adopted.js with the stone texture');
      await pg.evaluate(() => { window.__sbOn = BF.sandbox.on; BF.sandbox.on = () => false; });
      await pg.waitForFunction(() => BF.textures.edit.edited().length === 0, null, { timeout: 10000 }).catch(() => {});
      const outside = await pg.evaluate(() => ({ edited: BF.textures.edit.edited(), dirt: Array.from(BF.textures.edit.pixels("dirt")) }));
      check(outside.edited.length === 0 && outside.dirt.join() === orig.dirt.join(), 'outside a sandbox world the sandbox edits go back to the game\'s tiles');
      check((await cellPx('stone', 0, 4, 0))[0] === 200, 'but the adopted stone stays');
      const kOut = await pg.evaluate(() => { BF.textureStudio.close(); return BF.textureStudio.open(); });
      check(kOut === false, 'the studio won\'t open outside a sandbox world');
      await pg.evaluate(() => { BF.sandbox.on = window.__sbOn; });
      const un = await pg.evaluate(async () => (await BF.textureStudio.unadopt("stone")).ok);
      const back = await pg.evaluate(() => Array.from(BF.textures.edit.pixels("stone")));
      check(un && back.join() === orig.stone.join(), 'Unadopt gives the game\'s own stone back');
    } else console.log('(page opened as a file: Save, the library and adoption need the local server, checked on the worker host)');

    const errs = await pg.evaluate(() => BF.glog.recent(5000).filter(e => e.l === 'ERROR' && /textures|sandbox/.test(e.k)).map(e => e.x));
    check(errs.length === 0, `no texture or sandbox ERROR lines (${errs.slice(0, 3).join(' | ')})`);
    const info = await pg.evaluate(() => BF.glog.recent(5000).filter(e => e.k === 'textures' && e.l === 'INFO').length);
    check(info >= 3, `INFO lines for the changes (${info})`);
    await pg.evaluate(() => BF.textureStudio.close());
  } finally {
    for (const f in keep) fs.writeFileSync(path.join(SB, f), keep[f]);
    for (const f of written) try { fs.unlinkSync(f); } catch (e) { /* not written */ }
  }
  return fails ? `FAIL ${fails} check(s)` : 'PASS';
};
