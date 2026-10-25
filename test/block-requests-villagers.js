// @ci integration suite=village timeout=600
// Villager block edits as requests (spec r15-18), on seed 3 at the village nearest the spawn (tools/perf/lib.js):
// - two miners break one iron ore block in the same tick: it applies in requester-id order, so the lower id gets the raw iron and its
//   pickaxe wears, the other is refused ("changed") with nothing in its pack and an unworn pickaxe, and both move on to the next block;
// - two foresters fell one tree in the same tick: the tree comes down once (its logs drop once), the winner sweeps up, the loser gives the
//   task up and thinks again;
// - two farmers fill their buckets from one lone water source: exactly one full bucket, the other keeps its empty one;
// - then the village runs for a few game hours: no direct world writes from the converted modules (forester, miner, builder, villagelife,
//   farmland) on the request queue's counter (BF.req.stats().direct), and block requests were applied.
// Usage: NODE_PATH=$(npm root -g) node test/block-requests-villagers.js [hours=2]   (24 for the spec's one-day soak)
const path = require('path');
const H = require('../tools/perf/lib');
const HOURS = +(process.argv[2] || 2);
const MODS = ['forester', 'miner', 'builder', 'villagelife', 'farmland'];
let fails = 0;
const check = (ok, what, info) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (info !== undefined ? '  ' + JSON.stringify(info) : '')); if (!ok) fails++; };

(async () => {
  const { b, pg } = await H.boot(path.join(__dirname, '..'), { seed: 3 });
  try {
    const where = await H.toVillage(pg);
    const r = await pg.evaluate(where => {
      const W = BF.world, B = BF.B, I = BF.I, T = BF.trades.inv, BR = BF.blockReq, res = {};
      const n = m => +String(m.id).slice(1);
      // two adult villagers of the village with a jobsite, lower id first; their own state is put back afterwards
      const vs = BF.mobs.list.filter(m => m.type === 'villager' && !m.dead && !m.removed && !m.child && m.village && m.jobsite && Array.isArray(m.inv)).sort((a, b) => n(a) - n(b));
      res.villagers = vs.length;
      if (vs.length < 2) return res;
      const [A, Bv] = [vs[0], vs[1]];
      const saved = [A, Bv].map(m => ({ m, prof: m.profession, inv: m.inv, pos: m.position.clone(), mi: m.mi, fo: m.fo }));
      res.order = n(A) < n(Bv);
      // ---- 1. two miners, one iron ore block
      const ox = Math.floor(where.x) + 7, oz = Math.floor(where.z) + 5, oy = W.heightAt(ox, oz) + 4;
      W.setBlock(ox, oy, oz, B.iron_ore);
      for (const m of [A, Bv]) { m.inv = T.create(); T.add(m.inv, I.iron_pickaxe, 1); m.mi = undefined; m.position.set(ox + 0.5, oy - 1, oz + 1.5); }
      const MT = BF.miner._test, QA = MT.state(A), QB = MT.state(Bv), done = {};
      MT.digBlocks(Bv, QB, [[ox, oy, oz]], 99, () => { done.b = true; });   // the higher id asks first
      MT.digBlocks(A, QA, [[ox, oy, oz]], 99, () => { done.a = true; });
      res.minerQueued = BF.req.queued();
      BR.flush();   // the apply phase (and the results, before the next think)
      const pick = m => m.inv.find(s => s && s.id === I.iron_pickaxe);
      res.miner = { block: W.getBlock(ox, oy, oz), ironA: T.count(A.inv, I.raw_iron), ironB: T.count(Bv.inv, I.raw_iron), resA: BR.result(A), resB: BR.result(Bv),
        wearA: (pick(A) || {}).wear || 0, wearB: (pick(Bv) || {}).wear || 0, doneBefore: !!(done.a || done.b) };
      MT.digBlocks(Bv, QB, [[ox, oy, oz]], 0.05, () => { done.b = true; });   // next think: the cell is open for both
      MT.digBlocks(A, QA, [[ox, oy, oz]], 0.05, () => { done.a = true; });
      res.miner.doneAfter = !!(done.a && done.b);
      // ---- 2. two foresters, one tree
      const F = BF.forester;
      let tree = null;
      for (let rr = 8; rr < 30 && !tree; rr++) for (let a = 0; a < 6.28 && !tree; a += 0.25) {
        const x = Math.floor(where.x + Math.cos(a) * rr), z = Math.floor(where.z + Math.sin(a) * rr), y = W.heightAt(x, z);
        if (!W.isLoaded(x, z) || W.getBlock(x, y, z) !== B.grass || ![1, 2, 3, 4, 5, 6, 7, 8, 9].every(k => W.getBlock(x, y + k, z) === 0)) continue;
        W.setBlock(x, y + 1, z, B.oak_sapling);
        if (F.growTree(x, y + 1, z)) tree = F.treeAt(x, y + 1, z); else W.setBlock(x, y + 1, z, 0);
      }
      res.tree = !!tree;
      if (tree) {
        const [bx, by, bz] = tree.base, logId = W.getBlock(bx, by, bz), logs = tree.logs.length, item = BF.rollDrops(logId)[0].id;
        const near = () => BF.drops.list.filter(d => d.id === item && Math.hypot(d.pos.x - bx - 0.5, d.pos.z - bz - 0.5) < 8).reduce((s, d) => s + d.count, 0);
        const dropsBefore = near();
        BF.sky.setTime(0.1);
        for (const [m, dx] of [[A, 1.5], [Bv, -0.5]]) {
          m.profession = 'forester'; m.inv = T.create(); T.add(m.inv, I.stone_axe, 1); m.fo = undefined;
          m.position.set(bx + dx, by, bz + 1.5);
          const S = F._test.state(m), t = F.treeAt(bx, by, bz);
          S.task = { kind: 'cut', tree: t, x: bx, y: by, z: bz, max: 999, claim: bx + ',' + by + ',' + bz, done: t.logs.length };
          S.t = 0; S.thinkT = 0;
        }
        F.ai(Bv, 0.05, {}); F.ai(A, 0.05, {});   // both finish chopping in the same think, the higher id first
        res.foresterQueued = BF.req.queued();
        BR.flush();
        const SA = F._test.state(A), SB = F._test.state(Bv);
        res.forester = { logs, logsLeft: tree.logs.filter(([x, y, z]) => W.getBlock(x, y, z) === logId).length, dropped: near() - dropsBefore,
          resA: BR.result(A), resB: BR.result(Bv), taskA: SA.task && SA.task.kind, taskB: SB.task && SB.task.kind, sweepA: !!SA.sweep, sweepB: !!SB.sweep };
      }
      // ---- 3. two farmers, one lone water source
      const wx = ox + 3, wz = oz + 3, wy = W.heightAt(wx, wz);
      W.setBlock(wx, wy, wz, B.water);
      for (const m of [A, Bv]) { m.profession = 'farmer'; m.inv = T.create(); T.add(m.inv, I.bucket, 1); }
      const VL = BF.villageLife, qb = VL.fillBucket(Bv, wx, wy, wz), qa = VL.fillBucket(A, wx, wy, wz);
      BR.flush();
      res.bucket = { sent: !!qa && !!qb, fullA: T.count(A.inv, I.water_bucket), fullB: T.count(Bv.inv, I.water_bucket), emptyB: T.count(Bv.inv, I.bucket),
        source: BF.FLUID[W.getBlock(wx, wy, wz)] === 8, whyB: qb && qb.result && qb.result.why };
      for (const s of saved) { s.m.profession = s.prof; s.m.inv = s.inv; s.m.position.copy(s.pos); s.m.mi = s.mi; s.m.fo = s.fo; }
      BF.req.resetStats();
      return res;
    }, where);
    console.log(JSON.stringify(r));
    check(r.villagers >= 2 && r.order, 'two villagers of the seed 3 village, lower id first', r.villagers);
    const M = r.miner || {};
    check(r.minerQueued === 2, 'two miners ask for the same ore block in one tick', r.minerQueued);
    check(M.block === 0 && M.ironA === 1 && M.ironB === 0, 'the ore is mined once: the lower id has the raw iron, the other nothing', M);
    check(M.resA && M.resA.ok && M.resB && !M.resB.ok && M.resB.why === 'changed', 'the other miner is refused: changed', [M.resA, M.resB]);
    check(M.wearA === 1 && M.wearB === 0, 'only the winner\'s pickaxe wears', [M.wearA, M.wearB]);
    check(!M.doneBefore && M.doneAfter, 'both miners move on at their next think (the loser re-plans)', [M.doneBefore, M.doneAfter]);
    check(r.tree, 'a tree grown for the foresters');
    if (r.tree) {
      const Fo = r.forester;
      check(r.foresterQueued === 2, 'two foresters fell the same tree in one tick', r.foresterQueued);
      check(Fo.logsLeft === 0 && Fo.dropped === Fo.logs, 'the tree comes down once: each log drops one item', Fo);
      check(Fo.resA.ok && !Fo.resB.ok && Fo.resB.why === 'changed', 'the lower id fells it, the other is refused', [Fo.resA.ok, Fo.resB]);
      check(!Fo.taskA && Fo.sweepA && !Fo.taskB && !Fo.sweepB, 'the winner sweeps up, the loser gives the task up and thinks again', Fo);
    }
    const Bk = r.bucket || {};
    check(Bk.sent && Bk.fullA === 1 && Bk.fullB === 0 && Bk.emptyB === 1 && !Bk.source && Bk.whyB === 'changed', 'one lone source fills exactly one bucket', Bk);
    // ---- 4. the village runs: no direct writes from the converted modules
    for (let h = 0; h < HOURS; h++) await H.run(pg, 1000);   // a game hour each
    const s = await pg.evaluate(() => BF.req.stats());
    const left = MODS.filter(m => s.direct[m]);
    const blk = s.byKind.block || { applied: 0, refused: 0 };
    console.log(`${HOURS} game hours: block requests ${blk.applied} applied, ${blk.refused} refused; direct writes ${s.directTotal} ${JSON.stringify(s.direct)}`);
    check(blk.applied > 0, 'villagers changed blocks through block requests', blk);
    check(!left.length, 'no direct writes from ' + MODS.join(', '), s.direct);
  } catch (e) { console.log('FAIL ' + (e.stack || e.message)); fails++; }
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'block-requests-villagers: all ok');
  process.exit(fails ? 1 : 0);
})();
