// @ci integration suite=world,ui hosts=worker,server timeout=420
// The sandbox structure designer in the game (spec idea-051), with a stand-in for Claude (BF.designer.api answers claude/* here; the
// live model is never called): a design request gives a version with a blueprint; Build here stamps every cell at the expected spot,
// its front 3 blocks ahead of the player and the door facing the player, for each of the four ways the player can face; building
// into something already there asks first; Rebuild replaces it with the next version in the same spot; Capture after a hand edit gives
// a design holding that edit, and the request after it sends that design; Clear puts the plain back; with the page served by the
// local server, Save then the library lists it and a scene's structure entry builds it.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/designer test/sandbox-designer.js [--host page|worker|server]
const fs = require('fs'), path = require('path');
const lib = require('./lib');
module.exports = async (pg, out) => {
  let fails = 0;
  const check = (ok, what) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
  const simReady = async () => {
    if (!(await pg.evaluate(() => BF.simHost.worker))) return;
    await pg.waitForFunction(() => BF.client && BF.client.world.clock && BF.client.world.clock.tick > 40, null, { timeout: 300000, polling: 250 });
    const seed = await pg.evaluate(() => BF.state.seed >>> 0);
    for (let i = 0; i < 600 && !(await lib.sim(pg, s => BF.state.seed >>> 0 === s && BF.rand.tick > 20, seed)); i++) await pg.waitForTimeout(500);
  };
  await pg.evaluate(async () => { BF.player.start(); return BF.save.create({ name: "designer-test", seed: "91", gameMode: "creative", world: "flat" }); });
  await simReady();
  await pg.waitForFunction(() => BF.world.isLoaded(BF.worldSpawn.x, BF.worldSpawn.z), null, { timeout: 60000 });

  // the stand-in: v1 a 5x5 hut with its door on the south edge; a revision answers v2, one layer taller
  await pg.evaluate(() => {
    const rows = (n, s) => Array(n).fill(s);
    const hut = (h) => ({ name: "Test hut", summary: "A hut.", notes: "", width: 5, depth: 5,
      legend: [{ symbol: "P", block: "oak_planks" }, { symbol: "D", block: "oak_door" }, { symbol: "G", block: "glass_pane" }, { symbol: "S", block: "stone_bricks" }],
      layers: [{ label: "floor", rows: rows(5, "SSSSS") }, { label: "walls", rows: ["PPPPP", "P...P", "P...P", "P...P", "PPDPP"] }, { label: "windows", rows: ["PPGPP", "P...P", "G...G", "P...P", "PP.PP"] }]
        .concat(Array.from({ length: h - 4 }, () => ({ label: "wall", rows: ["PPPPP", "P...P", "P...P", "P...P", "PPPPP"] }))).concat([{ label: "roof", rows: rows(5, "SSSSS") }]) });
    window.__sent = [];
    const real = BF.designer.api;
    BF.designer.api = (p, body) => {
      if (p === "claude/status") return Promise.resolve({ configured: true, sdk: true, model: "claude-haiku-5-5", models: ["claude-haiku-5-5"], hour: 0, hourCap: 1 });
      if (p === "claude/blueprint") { window.__sent.push(JSON.parse(JSON.stringify(body))); return Promise.resolve({ design: hut(body.previous ? 5 : 4), attempts: 1, problems: [], cost: 0.001, model: "claude-haiku-5-5" }); }
      return real(p, body);
    };
  });
  const opened = await pg.evaluate(() => BF.designer.open());
  check(opened, 'G panel opens in a sandbox world');
  const v1 = await pg.evaluate(async () => { const v = await BF.designer.request("a small hut"); return v && { n: v.n, cells: v.r && v.r.cells.length, door: v.r && v.r.bp.door, err: v.error }; });
  check(v1 && v1.n === 1 && v1.cells > 50 && v1.door, `a request gives v1 with a blueprint (${JSON.stringify(v1)})`);

  // world block reads in the simulation; cells is [[x, y, z, id]]
  const simCells = cells => lib.sim(pg, cs => cs.map(c => BF.world.getBlock(c[0], c[1], c[2])), cells);
  const F = await pg.evaluate(() => ({ TOP: BF.flatgen.TOP }));
  // each way of facing: build, check, clear
  for (const [dir, yaw] of [[0, 0], [1, -Math.PI / 2], [2, Math.PI], [3, Math.PI / 2]]) {
    const r = await pg.evaluate(async ([yaw]) => {
      const s = BF.worldSpawn;
      BF.player.teleport(Math.floor(s.x) + 0.5, BF.flatgen.TOP + 1, Math.floor(s.z) + 0.5);
      BF.player.setLook(yaw, 0);
      const res = await BF.designer.build();
      const st = BF.designer.state.stamp, p = BF.player.position;
      return { res, cells: st && st.cells, T: st && st.T, px: Math.floor(p.x), pz: Math.floor(p.z) };
    }, [yaw]);
    check(r.res.ok && r.cells && r.cells.length === v1.cells, `facing ${'NESW'[dir]}: Build here placed ${r.res.cells} blocks`);
    if (!r.cells) continue;
    await pg.waitForTimeout(300);
    const got = await simCells(r.cells);
    const wrong = r.cells.filter((c, i) => got[i] !== c[3]).length;
    check(wrong === 0, `facing ${'NESW'[dir]}: every cell holds its block in the simulation (${wrong} wrong)`);
    const info = await pg.evaluate(([cells, px, pz, dir]) => {
      const D = [[0, -1], [1, 0], [0, 1], [-1, 0]][dir];
      let near = Infinity, door = null;
      for (const c of cells) {
        near = Math.min(near, (c[0] - px) * D[0] + (c[2] - pz) * D[1]);
        const b = BF.blocks[c[3]]; if (b.door && !b.door.upper) door = { f: b.door.f, a: (c[0] - px) * D[0] + (c[2] - pz) * D[1], l: (c[0] - px) * -D[1] + (c[2] - pz) * D[0] };
      }
      return { near, door, minY: Math.min(...cells.map(c => c[1])) };
    }, [r.cells, r.px, r.pz, dir]);
    check(info.near === 3, `facing ${'NESW'[dir]}: its front is 3 blocks ahead (${info.near})`);
    check(info.door && info.door.f === ((dir + 2) & 3) && info.door.a === 3 && info.door.l === 0, `facing ${'NESW'[dir]}: the door faces the player, straight ahead (${JSON.stringify(info.door)})`);
    check(info.minY === F.TOP, `facing ${'NESW'[dir]}: its ground layer takes the grass's place (y ${info.minY})`);
    if (dir < 3) {
      const c = await pg.evaluate(() => BF.designer.clear());
      check(c.ok, `facing ${'NESW'[dir]}: Clear`);
      await pg.waitForTimeout(300);
      const back = await lib.sim(pg, cs => cs.filter(c => BF.world.getBlock(c[0], c[1], c[2]) !== BF.flatgen.plainAt(c[1])).length, r.cells);
      check(back === 0, `facing ${'NESW'[dir]}: Clear puts the plain back (${back} cells not)`);
    }
  }

  // building into the last build (facing west, still there) asks first
  const conflict = await pg.evaluate(async () => { const s = BF.designer.state.stamp; const res = await BF.designer.build(); return { res, pending: !!BF.designer.state.pending, same: BF.designer.state.stamp === s }; });
  check(conflict.res.conflict > 0 && conflict.pending && conflict.same, `a build into something already there asks first (${conflict.res.conflict} blocks)`);

  // Rebuild with v2 (one layer taller) in the same spot
  const v2 = await pg.evaluate(async () => { BF.designer.state.pending = null; const v = await BF.designer.request("one layer taller"); return v && { n: v.n, hgt: v.r.bp.hgt }; });
  const before = await pg.evaluate(() => ({ T: BF.designer.state.stamp.T, cells: BF.designer.state.stamp.cells }));
  const rb = await pg.evaluate(async () => { const r = await BF.designer.rebuild(); const s = BF.designer.state.stamp; return { r, T: s.T, cells: s.cells, v: s.v }; });
  check(v2 && v2.n === 2 && rb.r.ok && rb.v === 2, `Rebuild places v2 (${JSON.stringify(rb.r)})`);
  check(JSON.stringify(rb.T) === JSON.stringify(before.T), 'in the same spot and facing');
  await pg.waitForTimeout(300);
  const gotB = await simCells(rb.cells), wrongB = rb.cells.filter((c, i) => gotB[i] !== c[3]).length;
  const newKeys = new Set(rb.cells.map(c => c.slice(0, 3).join())), gone = before.cells.filter(c => !newKeys.has(c.slice(0, 3).join()));
  const left = await lib.sim(pg, cs => cs.filter(c => BF.world.getBlock(c[0], c[1], c[2]) !== BF.flatgen.plainAt(c[1])).length, gone);
  check(wrongB === 0 && left === 0 && Math.max(...rb.cells.map(c => c[1])) - F.TOP + 1 === v2.hgt, `v2 stands there whole, nothing of v1 left over (${wrongB} wrong, ${left} left)`);

  // a hand edit, then Capture: the design holds it, and the next request sends it
  const top = Math.max(...rb.cells.map(c => c[1]));
  const edit = rb.cells.find(c => c[1] === top);
  await pg.evaluate(([x, y, z]) => { const c = BF.planet.canonCell(x, z, {}); return BF.commands.execute(`/setblock ${c.u} ${y + 1} ${c.v} gold_block`); }, edit);   // (commands take face coordinates)
  await pg.waitForFunction(([x, y, z]) => BF.world.getBlock(x, y + 1, z) === BF.B.gold_block, edit, { timeout: 20000 });
  const cap = await pg.evaluate(() => { const v = BF.designer.capture(); return v && { n: v.n, legend: v.design.legend, warnings: v.warnings, hgt: v.r.bp.hgt, gold: v.r.cells.filter(c => c[3] === BF.B.gold_block).length }; });
  check(cap && cap.gold === 1 && cap.legend.some(e => e.block === 'gold_block'), `Capture holds the hand-placed gold block (${JSON.stringify(cap && cap.legend)})`);
  check(cap && cap.warnings.some(w => /gold_block/.test(w)), 'and flags it as outside the palette');
  const sentCap = await pg.evaluate(async () => { await BF.designer.request("keep the gold"); const b = window.__sent[window.__sent.length - 1]; return { prev: !!b.previous && b.previous.legend.some(e => e.block === "gold_block"), pal: b.palette.some(p => p.name === "gold_block") }; });
  check(sentCap.prev && sentCap.pal, 'the next request sends the captured design (and offers its gold block)');
  // the capture rebuilt where it was taken: the gold block stays put
  const rc = await pg.evaluate(async () => { BF.designer.showVersion(BF.designer.state.versions.length - 1); const r = await BF.designer.rebuild(true); return { r, gold: BF.designer.state.stamp.cells.filter(c => c[3] === BF.B.gold_block) }; });
  check(rc.r.ok && rc.gold.length === 1 && rc.gold[0].join() === [edit[0], edit[1] + 1, edit[2], rc.gold[0][3]].join(), `the capture rebuilt in place keeps the edit where it was (${JSON.stringify(rc.gold)})`);

  // Clear: the plain back over the whole build
  const cl = await pg.evaluate(async () => { const cells = BF.designer.state.stamp.cells; const r = await BF.designer.clear(); return { r, cells }; });
  await pg.waitForTimeout(300);
  const notPlain = await lib.sim(pg, cs => cs.filter(c => BF.world.getBlock(c[0], c[1], c[2]) !== BF.flatgen.plainAt(c[1])).length, cl.cells);
  check(cl.r.ok && notPlain === 0, `Clear puts the plain back (${notPlain} cells not)`);

  // Save and the library, with the page served by the local server (worker and server hosts)
  const http = await pg.evaluate(() => /^https?:/.test(location.protocol));
  if (http) {
    const name = 'ci-designer-' + Date.now(), file = path.join(__dirname, '..', 'sandbox', 'structures', name + '.json');
    try {
      const sv = await pg.evaluate(async n => { const r = await BF.designer.save(n); return { r, lib: BF.designer.state.lib }; }, name);
      check(sv.r.ok && fs.existsSync(file) && sv.lib.includes(name), `Save writes sandbox/structures/${name}.json and the library lists it`);
      const sc = await pg.evaluate(async n => {
        BF.sandbox.structures = {};   // as a fresh page: the scene loads it
        const s = BF.worldSpawn;
        const r = await BF.sandbox.place({ entries: [{ structure: n, at: [0, 0, -40] }] }, { name: "designer-test", origin: { x: s.x, y: 0, z: s.z } });
        return { ok: r.ok, placed: r.placed, errors: r.errors };
      }, name);
      check(sc.ok && sc.placed > 50 && !sc.errors.length, `a scene's structure entry builds it (${JSON.stringify(sc)})`);
      const ld = await pg.evaluate(async n => { const v = await BF.designer.loadLibrary(n); return v && v.r && v.r.cells.length; }, name);
      check(ld > 50, 'Load from the library gives a buildable version');
    } finally { try { fs.unlinkSync(file); } catch (e) { /* not written */ } }
  } else console.log('(page opened as a file: Save and the library need the local server, checked on the worker and server hosts)');

  const errs = await pg.evaluate(() => BF.glog.recent(5000).filter(e => e.l === 'ERROR' && /designer|sandbox/.test(e.k)).map(e => e.x));
  check(errs.length === 0, `no designer or sandbox ERROR lines (${errs.slice(0, 3).join(' | ')})`);
  const info = await pg.evaluate(() => BF.glog.recent(5000).filter(e => e.k === "designer" && e.l === "INFO" && /^(Built|Rebuilt|Cleared|Captured|Design v)/.test(e.x)).length);
  check(info >= 6, `INFO lines for designs, builds, rebuilds, clears and captures (${info})`);
  await pg.evaluate(() => BF.designer.close());
  return fails ? `FAIL ${fails} check(s)` : 'PASS';
};
