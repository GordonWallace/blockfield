// @ci integration suite=village,world timeout=400
// Village generator 10 (idea-044): node test/run.js /tmp/pd test/paddocks-gen10.js
// 1. The paddock plan (worldgen paddockPlan) for 200 village keys per biome: the mean count follows E = pop / 10 x (0.4 + 0.15 x native types)
//    (the 0.6-1.4 factor averages 1); where wild-horse land lies within 100 blocks (worldgen horseLand), native animals are drawn about 4x
//    as often as others at first, every type can be drawn (desert too), and a village never gets a second stable; elsewhere no stable.
// 2. Real villages of a few seeds: one keeper per paddock (roster keys #1970+k), a paddock plot for each keeper whose plot fitted, a jobsite
//    block for each keeper, no old fixed-rule keepers and no shepherd in the shuffle. (The spawn village, which only the flat generator 3
//    had, went with it in r14-24: every village is a region village, so there is no spawn village left to check for.)
// 3. Walks into a village with a generated stable: it starts with 2 tamed horses in its paddock.
module.exports = async (pg) => {
  const out = await pg.evaluate(() => {
    BF.newWorld(1, { gen: 4, villages: 10 });
    const WG = BF.worldgen, res = { fails: [], biomes: {} }, o0 = BFT.spawn();
    const BIOMES = { plains: 5, forest: 6, snowy: 19, desert: 12 };
    for (const [name, id] of Object.entries(BIOMES)) {
      const nat = WG.nativeAnimals(id), pop = 40;
      let n = 0, first = {}, all = {}, twoStables = 0, land = 0, strayHorse = 0;
      for (let k = 0; k < 200; k++) {
        // (keys on the spawn face; on the planet a stable is drawn only near wild-horse land, worldgen horseLand, so the odds are counted there)
        const c = BF.planet.canon(o0.x - 3000 + (k % 20) * 300 + 7, o0.z - 1500 + Math.floor(k / 20) * 300 + 11, {}), hl = WG.horseLand(c.x, c.z);
        const plan = WG.paddockPlan(c.x, c.z, pop, id);
        n += plan.length;
        if (!hl) { if (plan.includes("horse")) strayHorse++; continue; }
        land++;
        if (plan.length) first[plan[0]] = (first[plan[0]] || 0) + 1;
        for (const a of plan) all[a] = (all[a] || 0) + 1;
        if (plan.filter(a => a === "horse").length > 1) twoStables++;
      }
      if (strayHorse) res.fails.push(name + ": " + strayHorse + " villages with no wild-horse land within 100 blocks drew a stable");
      if (land < 40) res.fails.push(name + ": only " + land + " of 200 keys near wild-horse land");
      const E = pop / 10 * (0.4 + 0.15 * nat.length);
      res.biomes[name] = { native: nat, mean: +(n / 200).toFixed(2), E: +E.toFixed(2), first, all, twoStables, land };
      if (Math.abs(n / 200 - E) > 0.15 * E + 0.2) res.fails.push(name + ": mean " + (n / 200).toFixed(2) + " vs E " + E.toFixed(2));
      if (twoStables) res.fails.push(name + ": " + twoStables + " villages drew two stables");
      for (const a of WG.PADDOCK_ANIMALS) if (!all[a]) res.fails.push(name + ": never drew " + a);
      if (nat.length && nat.length < 5) {   // first paddock: a native type 4/(4n + (5 - n)) of the time, another 1/(...)
        const tot = Object.values(first).reduce((s, x) => s + x, 0), other = WG.PADDOCK_ANIMALS.filter(a => !nat.includes(a));
        const pn = nat.reduce((s, a) => s + (first[a] || 0), 0) / tot / nat.length, po = other.reduce((s, a) => s + (first[a] || 0), 0) / tot / other.length;
        res.biomes[name].ratio = +(pn / Math.max(po, 1e-9)).toFixed(2);
        if (pn / Math.max(po, 1e-9) < 2.2) res.fails.push(name + ": native/other first-roll ratio " + (pn / po).toFixed(2) + " (expected about 4)");
      }
    }
    // real villages
    const KEEP = { shepherd: "pen", cowherd: "pasture", poultry_keeper: "coop", pig_farmer: "sty", stable_hand: "stable" };
    const BLOCK = { shepherd: "loom", cowherd: "milk_churn", poultry_keeper: "nesting_box", pig_farmer: "feed_trough", stable_hand: "tack_rack" };
    res.villages = 0; res.keepers = 0; res.plots = 0; res.missingPlots = 0; res.stable = null;
    for (const seed of [1, 2, 3]) {
      BF.newWorld(seed, { gen: 4, villages: 10 });
      const seen = new Set(), o = BFT.spawn(), d = v => BF.planet.distance(o, v);   // sampled around the spawn
      for (let rz = -4; rz <= 4; rz++) for (let rx = -4; rx <= 4; rx++) for (const v of WG.villagesNear(o.x + rx * 600, o.z + rz * 600, 300)) {
        const key = Math.round(v.x) + "," + Math.round(v.z);
        if (seen.has(key) || !v.pop) continue;
        seen.add(key); res.villages++;
        const roster = BF.mobs.roster({ key, houses: v.houses || [], nb: v.nb0, pop: v.pop, ground: v.ground, biomeId: v.biomeId });
        const keepers = roster.filter(sl => sl.idx >= 1970 && sl.idx < 2000);
        const plan = WG.paddockPlan(v.x, v.z, v.pop, v.biomeId);
        if (keepers.length > plan.length) res.fails.push(key + ": " + keepers.length + " keepers for " + plan.length + " paddocks");
        if (roster.some(sl => sl.idx < 1000 && sl.prof === "shepherd")) res.fails.push(key + ": a shepherd in the shuffle");
        if (roster.some(sl => sl.idx === 1500 || sl.idx === 1700 || sl.idx === 1960)) res.fails.push(key + ": an old fixed-rule keeper");
        if (roster.length !== v.pop) res.fails.push(key + ": roster " + roster.length + " != pop " + v.pop);
        res.keepers += keepers.length;
        const plots = (v.buildings || []).filter(b => b.type === "pen" || b.type === "pasture" || b.type === "coop" || b.type === "sty" || b.type === "stable");
        res.plots += plots.length;
        for (const p in KEEP) {
          const nk = keepers.filter(sl => sl.prof === p).length, np = plots.filter(b => b.type === KEEP[p]).length;
          if (np > nk) res.fails.push(key + ": " + np + " " + KEEP[p] + " plots for " + nk + " " + p + "s");
          res.missingPlots += nk - np;
          const js = BF.jobs.planVillage(v).filter(j => j.prof === p && j.slot >= 1970).length;
          if (js !== nk) res.fails.push(key + ": " + js + " " + BLOCK[p] + " blocks for " + nk + " " + p + "s");
        }
        const st = plots.find(b => b.type === "stable");
        if (st && seed === 1 && (!res.stable || d(v) < res.stable.d)) res.stable = { x: v.x, y: v.y, z: v.z, key, d: d(v) };
      }
    }
    return res;
  });
  console.log(JSON.stringify(out.biomes, null, 1));
  console.log(`villages ${out.villages}, keepers ${out.keepers}, paddock plots ${out.plots}, keepers whose plot did not fit ${out.missingPlots}`);
  const fails = out.fails.slice();
  if (out.missingPlots > out.keepers * 0.1) fails.push("too many keepers without a plot: " + out.missingPlots + " of " + out.keepers);
  if (!out.stable) console.log("no generated stable near seed 1's spawn: stable stocking not checked");
  else {
    await pg.evaluate(v => { BF.newWorld(1, { gen: 4, villages: 10 }); BF.player.spawn(v.x + 0.5, v.y + 3, v.z + 0.5); }, out.stable);
    await pg.waitForTimeout(15000);
    const h = await pg.evaluate(key => {
      const R = BF.mobs.villages.get(key), st = R && BF.stables.stableOf(R);
      return st ? { horses: BF.stables.horsesOf(st).length, penned: BF.stables.horsesOf(st).filter(r => r.pen).length, gen: !!st.e.gen,
        rack: BF.world.getBlock(st.rack.x, st.rack.y, st.rack.z) === BF.B.tack_rack } : null;
    }, out.stable.key);
    console.log("generated stable:", JSON.stringify(h));
    if (!h || h.horses !== 2 || h.penned !== 2 || !h.gen || !h.rack) fails.push("generated stable: " + JSON.stringify(h));
  }
  for (const f of fails) console.log("FAIL", f);
  console.log(fails.length ? "FAILED" : "OK paddocks gen 10");
};
