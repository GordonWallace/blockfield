// @ci integration suite=village
// Where villagers appear when their village loads again (village loading plan, scenario 2): a short absence (under a game hour, no bedtime in
// between) brings everyone back exactly where they stood; a longer one by day puts them at random spots within the leash of their bed; at bedtime
// they are in their beds; an explorer comes back at its saved spot; a villager without a bed goes indoors at night.
// Usage: node test/run.js /tmp/rp test/return-placement.js
module.exports = async (pg) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ok = (name, cond, extra) => console.log((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  await require('./lib').toVillage(pg);
  await pg.waitForFunction(() => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.slot).length >= 6, null, { timeout: 60000 });
  const info = await pg.evaluate(() => {
    BF.mobs.spawning = false;
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z), v = rec.wg;
    return { key: rec.key, x: rec.x, z: rec.z, minX: v.minX, maxX: v.maxX, minZ: v.minZ, maxZ: v.maxZ };
  });
  const tp = (x, z) => pg.evaluate(([x, z]) => { BF.player.spawn(x, BF.worldgen.heightAt(x, z) + 3, z); }, [x, z]);
  const wait = (fn, arg, t = 40000) => pg.waitForFunction(fn, arg, { timeout: t }).then(() => true, () => false);
  const snapshot = () => pg.evaluate(k => Object.fromEntries(BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === k && m.slot && !m.dead).map(m => [m.slot.idx, [m.position.x, m.position.z, m.profession]])), info.key);
  const leave = async () => {   // away, then the clock jumps past the countdown (headless frames are slow) so the village unloads at once
    await tp(info.x + 900, info.z);
    for (let i = 0; i < 4; i++) {
      if (await wait(k => !BF.villageSim.isActive(k) && !BF.mobs.list.some(m => m.village && m.village.key === k), info.key, 8000)) return true;
      await pg.evaluate(() => { BF.sky.time += 0.03; });
    }
    return false;
  };
  const back = async () => { await tp(info.x, info.z); await wait(k => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === k).length >= 4, info.key, 60000); await sleep(300); };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const setTime = t => pg.evaluate(t => { BF.sky.setTime(t); }, t);
  // 1. a short absence by day: exact
  await setTime(0.3);
  await sleep(1500);
  const before = await snapshot();
  ok("villagers are loaded to start with", Object.keys(before).length >= 6, Object.keys(before).length);
  ok("the village unloads when the player leaves", await leave());
  await back();
  const after1 = await snapshot();
  const same = Object.keys(before).filter(k => after1[k] && dist(before[k], after1[k]) < 4).length;
  ok("after a short absence the villagers are where they stood", Object.keys(after1).length >= 20 && same >= Math.floor(Object.keys(after1).length * 0.8), { same, present: Object.keys(after1).length, of: Object.keys(before).length });
  // 2. a longer absence by day: scattered within the leash
  await setTime(0.2);
  const before2 = await snapshot();
  await leave();
  await pg.evaluate(() => { BF.sky.time = 0.3; BF.sky.day += 1; });   // a day later, mid-morning
  await back();
  const info2 = await pg.evaluate(k => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === k && m.slot && !m.dead && m.profession !== "explorer").map(m => { const b = m.slot.bed, c = b ? [b.x, b.z] : [m.village.x, m.village.z]; return { d: Math.hypot(m.position.x - c[0], m.position.z - c[1]), inside: m.position.x >= m.village.wg.minX - 2 && m.position.x <= m.village.wg.maxX + 2 && m.position.z >= m.village.wg.minZ - 2 && m.position.z <= m.village.wg.maxZ + 2, x: m.position.x, z: m.position.z, idx: m.slot.idx }; }), info.key);
  const moved = info2.filter(e => before2[e.idx] && dist(before2[e.idx], [e.x, e.z]) > 4).length;
  ok("after a longer absence the villagers are within the leash of their beds and inside the village", info2.length >= 4 && info2.every(e => e.d <= 46 && e.inside), info2.slice(0, 4));
  ok("they are not back on their old spots", moved >= Math.floor(info2.length / 2), { moved, of: info2.length });
  const ex = Object.keys(before2).filter(k => before2[k][2] === "explorer");
  if (ex.length) {
    const nowPos = await snapshot();
    ok("an explorer comes back at the spot it was at, however long it was away", ex.every(k => nowPos[k] && dist(before2[k], nowPos[k]) < 6), ex.map(k => [before2[k], nowPos[k]]));
  }
  // 3. back at bedtime: in bed
  await leave();
  await pg.evaluate(() => { BF.sky.time = 0.75; BF.sky.day += 1; });
  await back();
  const bed = await pg.evaluate(k => BF.mobs.list.filter(m => m.type === "villager" && m.village && m.village.key === k && m.slot && m.slot.bed && !m.dead).map(m => Math.hypot(m.position.x - m.slot.bed.x, m.position.z - m.slot.bed.z)), info.key);
  ok("at bedtime villagers with a bed are in it", bed.length >= 3 && bed.filter(d => d < 4).length >= Math.floor(bed.length * 0.8), bed.map(d => Math.round(d)));
  // 4. a villager without a bed goes indoors at night
  const night = await pg.evaluate(k => {
    const m = BF.mobs.list.find(x => x.type === "villager" && x.village && x.village.key === k && x.slot && !x.dead && x.profession !== "explorer" && x.profession !== "merchant" && x.home);
    if (!m) return null;
    m.bed = null; m.slot.bed = null; m.homeBed = null;
    const H = m.home;
    m.position.set(H.outX + 0.5 + (H.outX - H.doorX) * 8, m.position.y, H.outZ + 0.5 + (H.outZ - H.doorZ) * 8);
    window.__bedless = m;
    return true;
  }, info.key);
  await wait(() => { const m = window.__bedless, H = m && m.home; return !!H && m.position.x >= H.x && m.position.x <= H.x + H.w && m.position.z >= H.z && m.position.z <= H.z + H.d; }, null, 150000);
  const inside = await pg.evaluate(() => { const m = window.__bedless, H = m && m.home; const ins = !!H && m.position.x >= H.x && m.position.x <= H.x + H.w && m.position.z >= H.z && m.position.z <= H.z + H.d; window.__why = { pos: [Math.round(m.position.x), Math.round(m.position.z)], H: H && [H.x, H.z, H.w, H.d], night: m.ai.night && { f: m.ai.night.fails, sf: m.ai.night.sFail, sh: !!m.ai.night.shelter }, rk: m.ai.routeKind, route: m.ai.route && m.ai.route.length, bed: !!m.bed, mode: m.ai.mode, bt: BF.mobs.nav.bedtime(), sleeping: !!m.sleeping, hb: m.homeBed }; return ins; });
  ok("a villager without a bed goes indoors at night", night && inside, { night, inside, why: await pg.evaluate(() => window.__why) });
};
