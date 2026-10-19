// @ci integration suite=village
// Builders bridge rivers (idea-030, js/bridges.js). A river is carved through a village, crossings are counted, and the checks follow:
//  - the weights offer a bridge only with 12 or more crossings in the last 3 days and water 3 to 24 wide, at most 3 per village
//  - the builder builds it from materials it holds, with a 3-wide deck, rails, torch posts, log posts down to the bed (each built from the bed up
//    before the deck above it) and room for a boat to pass under between them
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
    // ---- a river: x0 .. x0+wd-1 over z0-30 .. z0+30, banks flattened 8 blocks either side, water 7 deep, its top level with the bank's top block
    const wg = rec.wg, x0 = Math.floor(wg ? wg.maxX : rec.x) + 14, z0 = Math.floor(rec.z);
    // the ground it carves (the widest river below: x0 - 9 .. x0 + 38) must be loaded first: setBlock drops edits to a chunk not yet
    // generated, and on a busy machine the chunks past the village were still queued, so part of a bank stayed missing (air) and the walk
    // across the river below found no route
    const CS = 16, areaLoaded = () => { for (let x = x0 - 9; x <= x0 + 38 + CS; x += CS) for (let z = z0 - 30; z <= z0 + 30 + CS; z += CS) if (!W.isLoaded(Math.min(x, x0 + 38), Math.min(z, z0 + 30))) return false; return true; };
    for (let i = 0; i < 1500 && !areaLoaded(); i++) { W.update(BF.player.position.x, BF.player.position.z, 30); await new Promise(r => setTimeout(r, 10)); }
    if (!areaLoaded()) { ok("setup: the ground for the river is loaded", false); return R; }
    const gref = W.heightAt(x0 - 9, z0);
    const carve = (x0, wd) => {
      for (let z = z0 - 30; z <= z0 + 30; z++) for (let x = x0 - 9; x < x0 + wd + 9; x++) {
        const inRiver = x >= x0 && x < x0 + wd, top = Math.max(W.heightAt(x, z), gref) + 6;
        for (let y = gref - 10; y <= top; y++) W.setBlock(x, y, z, y <= gref - 8 ? B.stone : inRiver ? (y <= gref - 1 ? B.water : 0) : y <= gref ? B.dirt : 0);
      }
    };
    carve(x0, 12);
    const ws = gref - 1;   // top water block: level with the bank, so each bank needs a ramp plank
    R.env = { x0, z0, gref, ws, probe: [W.getBlock(x0 + 3, ws, z0) === B.water, W.getBlock(x0 + 3, ws + 1, z0) === 0, W.heightAt(x0 - 2, z0) === gref] };
    ok("the carved river holds water between flat banks", R.env.probe.every(Boolean), R.env);
    // ---- crossings: below the threshold nothing is offered; at 12 a bridge is
    const cx = x0 + 5, cz = z0, gx = Math.floor(cx / Br.CELL), gz = Math.floor(cz / Br.CELL);
    const wBridge = () => { const w = {}; for (const [t, x] of Bd.weighTypes(bm, bm.bs || (bm.bs = { fail: {}, avoid: {} }))) w[t] = x; return w.bridge || 0; };
    for (let i = 0; i < 11; i++) { BF.sky.setTime(0.2 + i * 0.004); Br.record(cx, cz, rec); }
    rec._bridgePlan = null;
    ok("11 crossings are not enough for a bridge", wBridge() === 0, { n: Br.count(rec, gx, gz) });
    BF.sky.setTime(0.2 + 12 * 0.004); Br.record(cx, cz, rec); rec._bridgePlan = null;
    const p = Br.plan(rec, true);
    ok("12 crossings offer a bridge across the 12-wide river", !!p && p.span.b - p.span.a + 1 === 12 && p.opts.len === 12, p && { len: p.opts.len, r0: p.opts.r0, r1: p.opts.r1, dy: p.span.dy, posts: p.opts.posts });
    ok("its deck is three blocks above the water, with a plank ramp to each low bank", !!p && p.span.dy === ws + 3 && p.opts.r0 === 1 && p.opts.r1 === 1, p && p.span);
    ok("posts at both ends and one between, each 9 blocks deep to the bed", !!p && p.opts.posts === "0:9:9;6:9:9;11:9:9", p && p.opts.posts);
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
    carve(x0, 12); rec._bridgePlan = null;
    ok("the 12-wide river offers one again", !!Br.plan(rec, true));
    // ---- ten walks from one bank to the other, before the bridge: each one swims (no route, or a route more than twice the straight way)
    const trips = () => {
      let swims = 0;
      for (let k = 0; k < 10; k++) {
        const w0 = [x0 - 7 - (k % 3), gref + 1, z0 - 12 + k * 2], g0 = [x0 + 13 + (k % 3), gref + 1, z0 + 12 - k * 2];
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
    ok("a 12-wide bridge needs planks, fences, logs and torches (54 logs: 3 posts x 2 lanes x 9)", bp.req[I.oak_planks != null ? I.oak_planks : I.planks] >= 36 && bp.req[I.oak_fence] >= 24 && bp.req[I.oak_log] === 54 && bp.req[I.torch] === 4, BF.blueprints.describe(bp.req));
    // build order: in every post column the logs go in from the bed up, all before the deck plank above them
    let order = true;
    for (let i = 0; i < bp.cells.length; i++) {
      const c = bp.cells[i];
      if (c.y >= 0) continue;
      const deckAt = bp.cells.findIndex(d => d.x === c.x && d.z === c.z && d.y === 0), below = bp.cells.findIndex(d => d.x === c.x && d.z === c.z && d.y === c.y - 1);
      if (deckAt >= 0 && deckAt < i) order = false;
      if (below > i) order = false;
    }
    ok("each post is built from the bed up, before the deck above it", order);
    for (const k in bp.req) T.add(bm.inv, +k, bp.req[k] + 4);
    T.add(bm.inv, I.coal, 4); T.add(bm.inv, I.cobblestone, 40);
    bm.bs = bm.bs || {}; Object.assign(bm.bs, { mode: "idle", cool: 0, t: 0, fail: {}, avoid: {}, entry: null });
    const built = Bd.builtOf(rec);
    M.update(0.05);
    // nobody but the builder on or beside the span: a mob there holds the plan back (js/builder.js occupiedBox) and one standing where a post
    // goes gets that log skipped. Wild animals and monsters (idea-037) go; the village's own (villagers, golems, pen and stable animals) are
    // sent back to the village centre. Done again through the build.
    const near = o => o.position.x > x0 - 16 && o.position.x < x0 + 28 && Math.abs(o.position.z - z0) < 36;
    let cleared = [];
    const clearSpan = () => {
      for (const o of M.list) {
        if (o === bm || o.dead || o.removed || !near(o)) continue;
        cleared.push(o.type + (o.profession ? ":" + o.profession : ""));
        if (M.isWild(o) || o.hostile) { o.dead = true; continue; }
        o.position.set(rec.x + 0.5, W.heightAt(Math.floor(rec.x), Math.floor(rec.z)) + 1, rec.z + 0.5); if (o.vel) o.vel.set(0, 0, 0); if (o.ai) o.ai.route = null;
      }
    };
    clearSpan();
    const inBox = M.list.filter(o => o !== bm && !o.dead && !o.removed && near(o)).map(o => [o.type, o.profession || null, Math.round(o.position.x), Math.round(o.position.z)]);
    const e = Bd.beginPlan(bm, bm.bs, "bridge", "oak");
    ok("the builder plans the bridge", !!e && e.type === "bridge" && !!e.span, e ? { ox: e.ox, oy: e.oy, oz: e.oz, w: e.w, d: e.d, n: e.n } : { inBox, player: [Math.round(BF.player.position.x), Math.round(BF.player.position.z)], x0, z0 });
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
      if (steps % 20 === 0) clearSpan();
      if (bm.bs.mode === "idle" && e.state !== "done") { bm.bs.cool = 0; }
    }
    ok("it finished the bridge", e.state === "done", { state: e.state, prog: e.prog, n: e.n, skipped: e.skipped, steps, status: Bd.statusText(bm), cleared: cleared.slice(0, 12), nCleared: cleared.length });
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
    ok("a 3-wide plank deck over the whole span", deck === 36, deck);
    ok("fence rails on both edges", rails === 24, rails);
    let posts = 0, postsOk = true;
    for (const u of [0, 6, 11]) for (const q of [-1, 1]) {
      const [x, z] = at(s.a + u, q);
      let n = 0;
      for (let y = s.dy - 1; y > gref - 8; y--) if (/_log$/.test(BF.blocks[W.getBlock(x, y, z)].name)) n++;
      if (n === 9) posts++; else postsOk = false;
    }
    ok("six log posts run from under the deck to the river bed", postsOk && posts === 6, posts);
    ok("four torch posts", torches === 4, torches);
    ok("room under the middle lane for a boat with a rider (2 clear blocks over the water)", free && !BF.SOLID[W.getBlock(at(s.a + 5, 0)[0], ws + 1, at(s.a + 5, 0)[1])] && !BF.SOLID[W.getBlock(at(s.a + 5, 0)[0], ws + 2, at(s.a + 5, 0)[1])]);
    ok("a second bridge within 32 blocks is not offered", Br.plan(rec, true) === null);
    R.done = e.state === "done";
    // ---- walking: a route across the river goes over the deck
    const N = M.nav, west = [x0 - 7, gref + 1, z0 + 12], east = [x0 + 19, gref + 1, z0 + 12];
    const goal = { x: east[0], z: east[2], at: (x, y, z) => x === east[0] && z === east[2] };
    const path = N.findPath(west[0], west[1], west[2], goal, 2500);
    ok("a walk across the river has a route", !!path && path.length > 0, path && path.length);
    const swimsAfter = trips();
    ok("with the bridge up, swimming crossings drop by at least 70% (" + swimsBefore + " -> " + swimsAfter + " of 10 walks)", swimsAfter <= 3, { swimsBefore, swimsAfter });
    // a boat with a rider (1.375 wide, 1.5 tall) drifts down the river under the deck, through the 4-block gap between the last two posts
    const mid = s.a + 8, pos = { x: s.axis === "x" ? mid + 0.5 : s.f - 7, y: ws + 0.95, z: s.axis === "x" ? s.f - 7 : mid + 0.5 }, vel = { x: 0, y: 0, z: 0 };
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
