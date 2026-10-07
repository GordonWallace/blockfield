// Village sizes (village generator 2): node test/run.js /tmp/vs test/village-sizes.js
// Samples the rosters of every village in a large area for several seeds and prints the size distribution and per-profession
// frequencies (VS_SEEDS, VS_R regions per side / 2, VS_GEN; VS_VG=1 for the classic villages), then walks into the biggest village of the
// last seed and checks its villagers spawn.
module.exports = async (pg) => {
  const seeds = (process.env.VS_SEEDS || "1,2,3,4,5,6,7,8").split(",").map(Number), R = +(process.env.VS_R || 14);
  const gen = +(process.env.VS_GEN || 2), vg = +(process.env.VS_VG || 2);
  const stats = await pg.evaluate(({ seeds, R, gen, vg }) => {
    const sizes = [], prof = {}, has = {}, slots = { explorer: 0, cart: 0 }, golems = [], jobs = [], fails = [];
    let villages = 0, total = 0, maxV = null;
    for (const seed of seeds) {
      BF.newWorld(seed, { gen, villages: vg });
      const seen = new Set();
      for (let rz = -R; rz < R; rz++) for (let rx = -R; rx < R; rx++) for (const v of BF.worldgen.villagesNear(rx * 384, rz * 384, 200)) {
        const key = Math.round(v.x) + "," + Math.round(v.z);
        if (seen.has(key)) continue;
        seen.add(key);
        const roster = BF.mobs.roster({ key, houses: v.houses || [], nb: (v.buildings || []).length, pop: v.pop || 0 });
        const beds = v.houses.reduce((a, h) => a + h.beds.length, 0);
        if (v.pop && roster.length !== v.pop) fails.push([seed, key, v.pop, roster.length]);
        villages++; total += roster.length; sizes.push(roster.length);
        const here = {};
        for (const sl of roster) { prof[sl.prof] = (prof[sl.prof] || 0) + 1; here[sl.prof] = 1; if (sl.prof === "cartographer") slots.cart++; if (sl.prof === "explorer") slots.explorer++; }
        for (const p in here) has[p] = (has[p] || 0) + 1;
        golems.push(v.pop ? Math.max(1, Math.round(v.pop / 15)) : v.houses.length >= 12 ? 2 : 1);
        const js = BF.jobs.planVillage(v);
        jobs.push([roster.filter(sl => sl.prof !== "nitwit").length, js.length]);
        if (seed === seeds[seeds.length - 1] && (!maxV || v.pop > maxV.pop)) maxV = { x: v.x, y: v.y, z: v.z, pop: v.pop, beds, nb: v.buildings.length, w: v.maxX - v.minX + 1, d: v.maxZ - v.minZ + 1 };
      }
    }
    return { villages, total, sizes, prof, has, slots, golems, jobs, fails, maxV };
  }, { seeds, R, gen, vg });
  const s = stats.sizes.slice().sort((a, b) => a - b), n = s.length, q = f => s[Math.min(n - 1, Math.floor(f * n))];
  console.log(`villages ${stats.villages}, villagers ${stats.total}; size min ${s[0]} p10 ${q(0.1)} median ${q(0.5)} mean ${(stats.total / n).toFixed(1)} p90 ${q(0.9)} max ${s[n - 1]}`);
  const bins = {};
  for (const x of s) { const b = x < 50 ? Math.floor(x / 5) * 5 : Math.floor(x / 10) * 10; bins[b] = (bins[b] || 0) + 1; }
  for (const b of Object.keys(bins).map(Number).sort((a, b) => a - b)) console.log(String(b).padStart(3), String(bins[b]).padStart(4), "#".repeat(Math.round(bins[b] / n * 200)));
  console.log("profession            share  in % of villages");
  for (const p of Object.keys(stats.prof).sort((a, b) => stats.prof[b] - stats.prof[a]))
    console.log(p.padEnd(18), (100 * stats.prof[p] / stats.total).toFixed(1).padStart(6) + "%", (100 * stats.has[p] / n).toFixed(1).padStart(6) + "%");
  console.log(`explorers per cartographer ${(stats.slots.explorer / Math.max(1, stats.slots.cart)).toFixed(3)} (${stats.slots.explorer}/${stats.slots.cart})`);
  const jr = stats.jobs.reduce((a, [w, j]) => a + j / Math.max(1, w), 0) / stats.jobs.length;
  console.log(`jobsite blocks per working villager ${jr.toFixed(2)}; golems mean ${(stats.golems.reduce((a, b) => a + b, 0) / n).toFixed(2)}`);
  console.log("roster != pop:", stats.fails.length, JSON.stringify(stats.fails.slice(0, 5)));
  console.log("biggest village of the last seed:", JSON.stringify(stats.maxV));
  if (process.env.VS_WALK === "0" || !stats.maxV) return;
  // walk into the biggest village: its villagers spawn as the player moves about it
  const v = stats.maxV;
  await pg.evaluate(v => { BF.player.spawn(v.x + 0.5, v.y + 3, v.z + 0.5); }, v);
  await pg.waitForTimeout(12000);
  const live = await pg.evaluate(v => {
    const key = Math.round(v.x) + "," + Math.round(v.z), rec = BF.mobs.villages.get(key);
    return { roster: rec && rec.roster.length, live: BF.mobs.list.filter(m => m.type === "villager" && m.village === rec && !m.dead).length,
      golems: BF.mobs.list.filter(m => m.type === "iron_golem" && m.village === rec).length };
  }, v);
  console.log("spawned in the biggest village:", JSON.stringify(live));
};
