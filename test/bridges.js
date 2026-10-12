// @ci integration suite=village
// Builders bridge rivers (idea-030, js/bridges.js). A river is carved through a village, crossings are counted, and the checks follow:
//  - the weights offer a bridge only with 12 or more crossings in the last 3 days and water 3 to 24 wide, at most 3 per village
//  - the builder builds it from materials it holds, with a 3-wide deck, rails, torch posts and room for a boat to pass under
//  - walks across the river go over the bridge instead of nowhere (swimming), and the crossing counts and the bridge survive a save
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/br test/bridges.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; BF.sky.setTime(0.2); });
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const M = BF.mobs, Bd = BF.builder, Br = BF.bridges, W = BF.world, B = BF.B, I = BF.I, T = BF.trades.inv;
    M.spawning = false;
    for (let i = 0; i < 100; i++) { BF.sky.setTime(0.2); M.update(0.05); }
    const bm = M.list.find(m => m.type === "villager" && m.profession === "builder" && !m.dead);
    if (!bm) { ok("setup: a builder", false); return R; }
    const rec = bm.village, key = rec.key;
    // ---- a river: x0 .. x0+wd-1 over z0-30 .. z0+30, banks flattened 8 blocks either side, water two blocks below the bank
    const wg = rec.wg, x0 = Math.floor(wg ? wg.maxX : rec.x) + 14, z0 = Math.floor(rec.z);
    const gref = W.heightAt(x0 - 9, z0);
    const carve = (x0, wd) => {
      for (let z = z0 - 30; z <= z0 + 30; z++) for (let x = x0 - 9; x < x0 + wd + 9; x++) {
        const inRiver = x >= x0 && x < x0 + wd, top = Math.max(W.heightAt(x, z), gref) + 6;
        for (let y = gref - 6; y <= top; y++) W.setBlock(x, y, z, y <= gref - 4 ? B.stone : inRiver ? (y <= gref - 1 ? B.water : 0) : y <= gref ? B.dirt : 0);
      }
    };
    carve(x0, 10);
    const ws = gref - 1;   // top water block: level with the bank, so each bank needs a ramp plank
    R.env = { x0, z0, gref, ws, probe: [W.getBlock(x0 + 3, ws, z0) === B.water, W.getBlock(x0 + 3, ws + 1, z0) === 0, W.heightAt(x0 - 2, z0) === gref] };
    ok("the carved river holds water between flat banks", R.env.probe.every(Boolean), R.env);
    // ---- crossings: below the threshold nothing is offered; at 12 a bridge is
    const cx = x0 + 4, cz = z0, gx = Math.floor(cx / Br.CELL), gz = Math.floor(cz / Br.CELL);
    const wBridge = () => { const w = {}; for (const [t, x] of Bd.weighTypes(bm, bm.bs || (bm.bs = { fail: {}, avoid: {} }))) w[t] = x; return w.bridge || 0; };
    for (let i = 0; i < 11; i++) { BF.sky.setTime(0.2 + i * 0.004); Br.record(cx, cz, rec); }
    rec._bridgePlan = null;
    ok("11 crossings are not enough for a bridge", wBridge() === 0, { n: Br.count(rec, gx, gz) });
    BF.sky.setTime(0.2 + 12 * 0.004); Br.record(cx, cz, rec); rec._bridgePlan = null;
    const p = Br.plan(rec, true);
    ok("12 crossings offer a bridge across the 10-wide river", !!p && p.span.b - p.span.a + 1 === 10 && p.opts.len === 10, p && { len: p.opts.len, r0: p.opts.r0, r1: p.opts.r1, dy: p.span.dy });
    ok("its deck is three blocks above the water, with a plank ramp to each low bank", !!p && p.span.dy === ws + 3 && p.opts.r0 === 1 && p.opts.r1 === 1, p && p.span);
    rec._bridgePlan = null;
    ok("the weight is 1.2 times the materials multiplier (the builder holds nothing)", wBridge() > 0 && wBridge() <= 1.2 * 3, wBridge());
    for (let i = 13; i < 31; i++) { BF.sky.setTime(0.2 + i * 0.004); Br.record(cx, cz, rec); }
    rec._bridgePlan = null;
    const busy = wBridge();
    ok("30 crossings make it likelier (weight 2 instead of 1.2)", Br.weight(rec) === 2, { busy, w: Br.weight(rec) });
    // ---- the span rules: too wide and too narrow water get no bridge
    const keep = Br.plan(rec, true);
    carve(x0, 30); rec._bridgePlan = null;
    ok("water 30 blocks wide gets no bridge", Br.plan(rec, true) === null);
    carve(x0, 2); rec._bridgePlan = null;
    ok("water 2 blocks wide gets no bridge", Br.plan(rec, true) === null);
    carve(x0, 10); rec._bridgePlan = null;
    ok("the 10-wide river offers one again", !!Br.plan(rec, true));
    // ---- ten walks from one bank to the other, before the bridge: each one swims (no route, or a route more than twice the straight way)
    const trips = () => {
      let swims = 0;
      for (let k = 0; k < 10; k++) {
        const w0 = [x0 - 7 - (k % 3), gref + 1, z0 - 12 + k * 2], g0 = [x0 + 11 + (k % 3), gref + 1, z0 + 12 - k * 2];
        const gl = { x: g0[0], z: g0[2], at: (x, y, z) => x === g0[0] && z === g0[2] };
        const pth = M.nav.findPath(w0[0], w0[1], w0[2], gl, 2500);
        if (!pth || pth.length > 2 * Math.hypot(g0[0] - w0[0], g0[2] - w0[2]) + 6) swims++;
      }
      return swims;
    };
    const before = Br.count(rec, gx, gz), swimsBefore = trips();
    ok("before the bridge every one of 10 walks across the river is a swim", swimsBefore === 10, swimsBefore);
    ok("and walks that find no way round count as crossings", Br.heat(rec).reduce((a, h) => a + h[2], 0) > before, { before, heat: Br.heat(rec) });
    // ---- the builder builds it from what it holds
    const bp = BF.blueprints.get("bridge", keep.rot, 0, 0.5, keep.opts, "oak");
    ok("a 10-wide bridge needs planks, fences, logs and torches", bp.req[I.oak_planks != null ? I.oak_planks : I.planks] >= 30 && bp.req[I.oak_fence] >= 20 && bp.req[I.oak_log] >= 4 && bp.req[I.torch] === 4, BF.blueprints.describe(bp.req));
    for (const k in bp.req) T.add(bm.inv, +k, bp.req[k] + 4);
    T.add(bm.inv, I.coal, 4); T.add(bm.inv, I.cobblestone, 40);
    bm.bs = bm.bs || {}; Object.assign(bm.bs, { mode: "idle", cool: 0, t: 0, fail: {}, avoid: {}, entry: null });
    const built = Bd.builtOf(rec);
    for (const o of M.list) if ((M.isWild(o) || o.hostile) && Math.hypot(o.position.x - x0, o.position.z - z0) < 40) o.dead = true;   // wild animals live round villages (idea-037): one standing on the span would hold the plan back
    M.update(0.05);
    const e = Bd.beginPlan(bm, bm.bs, "bridge", "oak");
    ok("the builder plans the bridge", !!e && e.type === "bridge" && !!e.span, e && { ox: e.ox, oy: e.oy, oz: e.oz, w: e.w, d: e.d, n: e.n });
    if (!e) return R;
    const said = [], vlog0 = BF.vlog.log;
    BF.vlog.log = function (r, k, t, ...rest) { said.push(t); return vlog0.call(this, r, k, t, ...rest); };
    Bd.startBuild(bm, bm.bs, e, true);
    BF.player.teleport(x0 - 6, gref + 3, z0 + 0.5);
    bm.position.set(x0 - 12, gref + 2, z0 + 0.5); bm.vel.set(0, 0, 0);
    for (let i = 0; i < 40; i++) { BF.sky.setTime(0.2); M.update(0.05); }
    let steps = 0;
    for (; steps < 9000 && e.state !== "done"; steps++) {
      BF.sky.setTime(0.2 + Math.min(0.2, steps * 0.00002)); M.update(0.1);
      if (bm.bs.mode === "idle" && e.state !== "done") { bm.bs.cool = 0; }
    }
    ok("it finished the bridge", e.state === "done", { state: e.state, prog: e.prog, n: e.n, skipped: e.skipped, steps, status: Bd.statusText(bm) });
    BF.vlog.log = vlog0;
    ok("the village log says the bridge is finished", said.some(t => /finished a bridge over the river/.test(t)), said.slice(-2));
    const s = e.span;
    const at = (p, q) => (s.axis === "x" ? [p, s.f + q] : [s.f + q, p]);
    let deck = 0, rails = 0, torches = 0, free = true;
    for (let p = s.a; p <= s.b; p++) for (let q = -1; q <= 1; q++) {
      const [x, z] = at(p, q);
      if (BF.blocks[W.getBlock(x, s.dy, z)].name.endsWith("planks")) deck++;
      if (q !== 0 && /fence/.test(BF.blocks[W.getBlock(x, s.dy + 1, z)].name)) rails++;
      if (W.getBlock(x, s.dy + 3, z) === B.torch) torches++;
      for (const dy of [-1, -2]) if (q === 0 && BF.SOLID[W.getBlock(x, s.dy + dy, z)]) free = false;   // under the middle lane: clear for a boat
    }
    ok("a 3-wide plank deck over the whole span", deck === 30, deck);
    ok("fence rails on both edges", rails === 20, rails);
    ok("four torch posts", torches === 4, torches);
    ok("room under the middle lane for a boat with a rider (2 clear blocks over the water)", free && !BF.SOLID[W.getBlock(at(s.a + 5, 0)[0], ws + 1, at(s.a + 5, 0)[1])] && !BF.SOLID[W.getBlock(at(s.a + 5, 0)[0], ws + 2, at(s.a + 5, 0)[1])]);
    ok("a second bridge within 32 blocks is not offered", Br.plan(rec, true) === null);
    R.done = e.state === "done";
    // ---- walking: a route across the river goes over the deck
    const N = M.nav, west = [x0 - 7, gref + 1, z0 + 12], east = [x0 + 17, gref + 1, z0 + 12];
    const goal = { x: east[0], z: east[2], at: (x, y, z) => x === east[0] && z === east[2] };
    const path = N.findPath(west[0], west[1], west[2], goal, 2500);
    ok("a walk across the river has a route", !!path && path.length > 0, path && path.length);
    const swimsAfter = trips();
    ok("with the bridge up, swimming crossings drop by at least 70% (" + swimsBefore + " -> " + swimsAfter + " of 10 walks)", swimsAfter <= 3, { swimsBefore, swimsAfter });
    // a boat with a rider (1.375 wide, 1.5 tall) drifts down the river under the middle of the deck
    const mid = (s.a + s.b) >> 1, pos = { x: s.axis === "x" ? mid + 0.5 : s.f - 7, y: ws + 0.95, z: s.axis === "x" ? s.f - 7 : mid + 0.5 }, vel = { x: 0, y: 0, z: 0 };
    let hit = false, crossed = false;
    for (let k = 0; k < 400 && !crossed; k++) {
      vel.x = s.axis === "x" ? 0 : 3; vel.z = s.axis === "x" ? 3 : 0; vel.y = 0;
      const rr = W.moveBox(pos, vel, 0.6875, 1.5, 0.05, { stepUp: 0 });
      if (rr.hitX || rr.hitZ) hit = true;
      crossed = (s.axis === "x" ? pos.z : pos.x) > s.f + 7;
    }
    ok("a boat with a rider passes under the deck", crossed && !hit, { hit, crossed });
    let contiguous = !!path, onDeck = 0;
    if (path) {
      let prev = west;
      for (const c of path) {
        if (Math.abs(c[0] - prev[0]) + Math.abs(c[2] - prev[2]) > 1 || Math.abs(c[1] - prev[1]) > 1) contiguous = false;
        if (c[1] === s.dy + 1 && c[0] >= s.a && c[0] <= s.b) onDeck++;
        prev = c;
      }
    }
    ok("the route is one step at a time and uses the deck", contiguous && onDeck >= 8, { onDeck, len: path && path.length });
    // ---- save and reload
    const out = M.exportVillagers();
    ok("the crossing counts and the bridge are saved", !!out["cross:" + key] && (out["built:" + key] || []).some(x => x.type === "bridge" && x.span && x.state === "done"));
    const heatBefore = JSON.stringify(Br.heat(rec));
    Br.reset(); ok("(reset empties the counts)", Br.heat(rec).length === 0);
    Br.importAll(out);
    ok("a reload brings the crossing counts back", JSON.stringify(Br.heat(rec)) === heatBefore, { before: heatBefore, after: JSON.stringify(Br.heat(rec)) });
    return R;
  });
  for (const l of res.lines) console.log(l);
  if (res.env) console.log(JSON.stringify(res.env));
};
