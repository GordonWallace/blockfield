// Claimed beds: node test/run.js /tmp/beds test/beds-actions.js
// Runs a village through several nights and reports, per villager, the bed it slept in each night (and who slept nowhere).
module.exports = async (pg, out) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.gameMode = "creative"; });
  await require('./lib').toVillage(pg);
  const nights = +(process.env.NIGHTS || 3);
  const res = await pg.evaluate(async (nights) => {
    const M = BF.mobs;
    M.spawning = false;
    const key = m => (m.village ? m.village.key : "?") + "#" + (m.slot ? m.slot.idx : "?") + " " + m.profession;
    const seen = new Map();   // villager key -> [bed per night]
    const run = async (t0, t1, secs, dt = 0.05) => {
      const n = Math.round(secs / dt);
      for (let i = 0; i < n; i++) {
        BF.sky.setTime(t0 + (t1 - t0) * i / n);
        M.update(dt);
        if (i % 400 === 0) await new Promise(r => setTimeout(r, 0));
      }
    };
    for (let night = 0; night < nights; night++) {
      BF.sky.day = night + 1;
      await run(0.3, 0.5, 40);          // day: out and about
      await run(0.53, 0.62, 110);       // evening: walk home and lie down
      for (const m of M.list) {
        if (m.type !== "villager" || m.dead || m.removed) continue;
        const k = key(m);
        if (!seen.has(k)) seen.set(k, []);
        const b = m.sleeping && m.bed ? (m.bed.tent ? "tent" : m.bed.x + "," + m.bed.y + "," + m.bed.z) : (m.bed ? "awake(bed " + m.bed.x + "," + m.bed.y + "," + m.bed.z + ")" : "no bed");
        seen.get(k)[night] = b;
      }
      await run(0.99, 1.05, 20);        // morning: wake up
    }
    const rows = [...seen].map(([k, v]) => ({ k, v }));
    const sleptAll = rows.filter(r => r.v.every(b => b && !b.startsWith("awake") && b !== "no bed"));
    const same = sleptAll.filter(r => new Set(r.v).size === 1);
    const beds = new Map();
    for (const r of rows) r.v.forEach((b, i) => { if (b && /^-?\d/.test(b)) { const kk = i + "|" + b; beds.set(kk, (beds.get(kk) || 0) + 1); } });
    return { villagers: rows.length, sleptEveryNight: sleptAll.length, sameBedEveryNight: same.length, sharedBeds: [...beds].filter(([, n]) => n > 1).length,
      other: rows.filter(r => !same.includes(r)) };
  }, nights);
  console.log(JSON.stringify(res, null, 1));
};
