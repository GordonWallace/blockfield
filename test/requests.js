// @ci integration suite=world timeout=300
// Request queue and two-phase tick (spec r15-17): NODE_PATH=$(npm root -g) node test/run.js /tmp/rq test/requests.js
// - two scripted villagers ask to mine the same block in the same tick: the lower id gets it, the other is refused, and the world has
//   exactly one dropped item; requests apply in requester-id order whatever the order of BF.mobs.list;
// - results arrive one tick later: not during the tick's think, before the next tick's think (then() and the kind's onResult);
// - a requester removed before its result: the result is dropped, the block stays mined and its item stays in the world;
// - a request sent during apply goes into the next tick; a kind with no handler is refused and logged as an ERROR;
// - transition mode counts direct world writes by module; strict mode makes a direct write during think throw.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

  const r = await pg.evaluate(() => {
    BF.state.paused = true;   // ticks by hand (BF.simStep), no frames' ticks in between
    const W = BF.world, R = BF.req, P = BF.player.position, step = () => BF.simStep(BF.warp.TICK);
    const res = {};
    // a natural top block 8 blocks off, not air, with a drop
    let cx = 0, cy = 0, cz = 0, was = 0;
    for (let i = 0; i < 40 && !was; i++) {
      cx = Math.floor(P.x) + 8 + i; cz = Math.floor(P.z) + 8; cy = W.heightAt(cx, cz);
      const id = W.getBlock(cx, cy, cz), d = BF.rollDrops(id);
      if (id && !BF.FLUID[id] && d && d.length && d[0].count > 0) was = id;
    }
    res.was = was;
    const item = BF.rollDrops(was)[0].id, key = cx + "," + cy + "," + cz;
    const near = () => BF.drops.list.filter(d => d.id === item && Math.abs(d.pos.x - cx - 0.5) < 3 && Math.abs(d.pos.z - cz - 0.5) < 3).reduce((a, d) => a + d.count, 0);
    const before = near();
    const a = BF.mobs.spawn("villager", cx + 2.5, cy + 1, cz + 0.5), b = BF.mobs.spawn("villager", cx - 1.5, cy + 1, cz + 0.5);
    const n = s => +String(s).slice(1);
    res.ids = [a.id, b.id];
    res.lowerFirst = n(a.id) < n(b.id);
    // b ahead of a in the list (the opposite of id order), and the list shuffled around them
    const L = BF.mobs.list;
    L.splice(L.indexOf(a), 1); L.splice(L.indexOf(b), 1);
    for (let i = L.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [L[i], L[j]] = [L[j], L[i]]; }
    L.push(b, a);
    // scripted think: each villager asks for the block in list order, during the mobs' update
    const got = {}, seenInThink = [], up = BF.mobs.update;
    let tickNo = 0;
    BF.mobs.update = function () {
      const ret = up.apply(this, arguments);
      tickNo++;
      seenInThink.push({ tick: tickNo, a: !!got[a.id], b: !!got[b.id] });
      if (tickNo === 1) for (const m of BF.mobs.list) if (m === a || m === b) {
        R.send("setBlock", key, { id: 0, expect: was, drop: true }, m).then((result, req) => { got[req.from] = { ok: result.ok, why: result.why, phase: R.phase, tick: tickNo }; });
      }
      return ret;
    };
    try { step(); step(); } finally { BF.mobs.update = up; }
    res.got = got; res.seenInThink = seenInThink;
    res.aWon = got[a.id] && got[a.id].ok === true && got[b.id] && got[b.id].ok === false && got[b.id].why === "changed";
    res.blockNow = W.getBlock(cx, cy, cz);
    res.items = near() - before;
    BF.mobs.discard(a); BF.mobs.discard(b);

    // onResult for a live mob, and a requester removed before its result
    const echoed = [];
    R.on("test-echo", req => ({ ok: true, echo: req.data.v }), { onResult: (m, req, result) => echoed.push({ id: m.id, echo: result.echo }) });
    const c = BF.mobs.spawn("villager", cx + 3.5, cy + 1, cz + 3.5), d = BF.mobs.spawn("villager", cx + 4.5, cy + 1, cz + 3.5);
    R.send("test-echo", "x", { v: 7 }, c);
    step();
    res.echoed = echoed.slice();
    const cy2 = W.heightAt(cx, cz + 2), was2 = W.getBlock(cx, cy2, cz + 2), item2 = BF.rollDrops(was2)[0], b2 = BF.drops.list.length;
    let late = null;
    R.send("setBlock", cx + "," + cy2 + "," + (cz + 2), { id: 0, expect: was2, drop: true }, d).then(x => { late = x; });
    const up2 = BF.mobs.update;
    BF.mobs.update = function () { BF.mobs.update = up2; const ret = up2.apply(this, arguments); BF.mobs.discard(d); return ret; };   // removed in think, before apply
    step();
    BF.mobs.update = up2;
    res.removed = { late, block: W.getBlock(cx, cy2, cz + 2), was: was2, dropped: BF.drops.list.length - b2, hasItem: !!item2 };
    BF.mobs.discard(c);

    // chain: a request sent during apply goes into the next tick's apply
    const applied = [];
    R.on("test-chain", req => { applied.push({ v: req.data.v, tick: BF.rand.tick }); if (req.data.v === 1) R.send("test-chain", "x", { v: 2 }, "test"); return { ok: true }; });
    R.send("test-chain", "x", { v: 1 }, "test");
    step(); step();
    res.chain = applied;
    // a kind with no handler
    let none = null;
    R.send("test-nobody", "x", {}, "test").then(x => { none = x; });
    step();
    res.none = none;
    res.errLogged = BF.glog.recent(200).some(e => JSON.stringify(e).includes('Request kind \\"test-nobody\\" has no handler'));

    // transition mode: a direct write is counted under its module; strict mode throws during think
    const d0 = R.stats().direct.test || 0;
    W.setBlock(cx, cy2 + 6, cz + 2, BF.B.dirt); W.setBlock(cx, cy2 + 6, cz + 2, 0);
    res.direct = (R.stats().direct.test || 0) - d0;
    R.strict = true; R.beginTick();
    try { W.setBlock(cx, cy2 + 6, cz + 2, BF.B.dirt); res.strictThrew = false; } catch (e) { res.strictThrew = /during think/.test(e.message); }
    R.endTick(); R.strict = false;
    res.strictWrote = W.getBlock(cx, cy2 + 6, cz + 2);
    res.text = R.text();
    BF.state.paused = false;
    return res;
  });
  console.log(JSON.stringify(r));
  check(r.was > 0, "found a block to mine (" + r.was + ")");
  check(r.lowerFirst, "the first villager has the lower id (" + r.ids.join(" < ") + ")");
  check(r.aWon, "the lower id gets the block, the other is refused as changed, though it was first in the list and sent first");
  check(r.blockNow === 0, "the block is mined once");
  check(r.items === 1, "the world has exactly one dropped item from it (" + r.items + ")");
  const t1 = r.seenInThink.find(s => s.tick === 1), t2 = r.seenInThink.find(s => s.tick === 2);
  check(t1 && !t1.a && !t1.b && t2 && t2.a && t2.b, "results are not there during the tick's think and are there at the next tick's think");
  check(r.got[r.ids[0]] && r.got[r.ids[0]].tick === 1 && r.got[r.ids[0]].phase === "deliver", "they are delivered at the end of the sending tick, after apply");
  check(r.echoed.length === 1 && r.echoed[0].echo === 7, "the kind's onResult gets the live requester and its result");
  check(r.removed.late === null && r.removed.block === 0 && (!r.removed.hasItem || r.removed.dropped >= 1), "a removed requester gets no result; the block stays mined and its item stays in the world");
  check(r.chain.length === 2 && r.chain[1].tick === r.chain[0].tick + 1, "a request sent during apply applies in the next tick");
  check(r.none && r.none.ok === false && r.none.why === "no handler" && r.errLogged, "a kind with no handler is refused and logged as an ERROR");
  check(r.direct === 2, "transition mode counts direct writes by module (" + r.direct + ")");
  check(r.strictThrew && r.strictWrote === 0, "strict mode makes a direct write during think throw");
  await pg.screenshot({ path: out + "-end.png" });
  console.log(fails.length ? "FAILED " + fails.length + ": " + fails.join("; ") : "requests: all ok");
  if (fails.length) throw new Error(fails.join("; "));
};
