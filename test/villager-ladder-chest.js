// Villagers reach upstairs chests: node test/run.js /tmp/vlc test/villager-ladder-chest.js
// A villager whose bed is in a two-storey house (house2) and whose only usable chest is the one on the upper floor fills up,
// climbs the ladder through the hatch, stores its surplus in that chest (from the top rungs or the floor) and comes back down.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await require('./lib').toVillage(pg);
  const step = (t0, t1, secs, k, fill) => pg.evaluate(async ([t0, t1, secs, k, fill]) => {
    const dt = 0.05, n = Math.round(secs / dt), m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k);
    let top = -1e9;
    for (let i = 0; i < n; i++) { BF.sky.setTime(t0 + (t1 - t0) * i / n); BF.mobs.update(dt); if (m && fill && i % 20 === 0 && !(m.store && m.store.stage)) for (let j = 0; j < m.inv.length; j++) if (!m.inv[j]) m.inv[j] = { id: j % 3 ? BF.I.rotten_flesh : BF.I.cobblestone, count: 64 };   // meals and breeding use up food: keep it full until it sets off
      if (m) top = Math.max(top, m.position.y); if (m && window.__dbg && i % 20 === 0) console.log("[t]", (i * dt).toFixed(0), m.store && m.store.stage, m.ai.routeKind, m.ai.route && m.ai.ri + "/" + m.ai.route.length, m.position.y.toFixed(2), BF.villagerStatus.text(m)); if (i % 400 === 0) await new Promise(r => setTimeout(r, 0)); }
    return top;
  }, [t0, t1, secs, k, fill]);
  if (process.env.DEBUG) { await pg.evaluate(() => { window.__dbg = true; }); pg.on('console', msg => { if (/^\[t\]/.test(msg.text())) console.log(msg.text()); }); }
  const ok = (cond, what) => console.log((cond ? "PASS " : "FAIL ") + what);

  const v = await pg.evaluate(() => {
    BF.mobs.spawning = false; BF.sky.day = 1; BF.sky.setTime(0.1);
    const S = BF.storage;
    for (const m of BF.mobs.list.filter(m => m.type === "villager" && !m.dead && !m.child && m.inv && S.bedHouse(m))) {
      const b = m.bed, cs = S.chestsIn(S.bedHouse(m), b).filter(p => S.usable(p, S.keyOf(m)));
      const up = cs.filter(p => p.y >= b.y + 3);
      if (up.length && up.length === cs.length) return { key: S.keyOf(m), chest: up[0], bedY: b.y, prof: m.profession };
    }
    return null;
  });
  console.log("villager with only an upstairs chest:", JSON.stringify(v));
  if (!v) { ok(false, "found a villager in a two-storey house"); return; }
  await pg.evaluate(k => {
    const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), I = BF.I;
    m.store = null;
    for (let i = 0; i < m.inv.length; i++) if (!m.inv[i]) m.inv[i] = { id: i % 3 ? I.rotten_flesh : I.cobblestone, count: 64 };
  }, v.key);
  let top = -1e9;
  for (let k = 0; k < 6 && !(await pg.evaluate(p => { const c = BF.inventory.chestState(p.x, p.y, p.z); return !!(c && c.owner); }, v.chest)); k++)
    top = Math.max(top, await step(0.1 + k * 0.03, 0.13 + k * 0.03, 30, v.key, true));
  top = Math.max(top, await step(0.3, 0.33, 30, v.key));   // time to come back down
  const r = await pg.evaluate(([k, p]) => {
    const m = BF.mobs.list.find(m => BF.storage.keyOf(m) === k), c = BF.inventory.chestState(p.x, p.y, p.z);
    return { owner: c && c.owner, chest: c ? c.slots.filter(Boolean).map(s => BF.itemName(s.id) + " x" + s.count) : [], y: m.position.y, hp: m.hp, maxHp: m.maxHp,
      status: BF.villagerStatus.text(m), log: BF.vlog.entries(m.village.key).filter(e => e[1] === "chest").slice(-3).map(e => e[2]) };
  }, [v.key, v.chest]);
  console.log(JSON.stringify(r, null, 1), "highest feet y", top.toFixed(2), "(ground floor feet at", v.bedY, ", upper floor at", v.bedY + 4, ")");
  ok(r.owner === v.key && r.chest.some(s => /Rotten Flesh|Cobblestone/.test(s)), "villager climbed to the upstairs chest and stored its surplus");
  ok(top >= v.bedY + 2.9, "it climbed the ladder up to the chest");
  ok(r.hp === r.maxHp, "no damage on the way");
};
