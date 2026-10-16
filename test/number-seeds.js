// @ci integration suite=world
// Different number seeds give different worlds; seeds 1..4294967295 are unchanged (bug-021). (The check that a world saved with seed 0
// before the fix keeps its terrain went with the flat generators, r14-24: only 1.3 and older worlds can have seed 0, and 1.4 opens none.)
// NODE_PATH=$(npm root -g) node test/run.js /tmp/ns test/number-seeds.js
module.exports = async (pg, out) => {
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const r = await pg.evaluate(() => {
    const ns = BF.save.numberSeed, r = {};
    const typed = ["0", "1", "2", "-1", "4294967295", "4294967296", "4294967297", "-4294967295", "12345678901234567890", "98765432109876543210", "-0", "007"];
    r.seeds = {}; for (const t of typed) r.seeds[t] = ns(t);
    // a world's terrain signature: continentalness and temperature on a 9 x 5 grid 20 km apart around 35 N 0 E (the planet's spawn
    // search start), from the terrain noise BF.newWorld makes for the seed (BF.makeNoise(seed >>> 0)). (Generator 3 read heights near the
    // origin; on the planet heights need each seed's river network solved, about 15 s a seed, and the slow fields show the seed as well.)
    const o = BF.planet.atlasOfLatLon(35, 0, {});
    const sig = seed => { BF.worldgen.init(BF.makeNoise(seed >>> 0), { villages: 9 }); const a = []; for (let i = -4; i <= 4; i++) for (let j = -2; j <= 2; j++) { const f = BF.worldgen._fields(o.x + i * 20000, o.z + j * 20000); a.push(f.c.toFixed(6), f.t.toFixed(6)); } return a.join(","); };
    r.t1 = sig(ns("1")); r.t0 = sig(ns("0")); r.tBig = sig(ns("4294967297")); r.tNeg = sig(ns("-1")); r.tMax = sig(ns("4294967295"));
    BF.worldgen.init(BF.noise, { biomeScale: BF.state.biomeScale, villages: BF.state.villages });   // back to the page's world
    return r;
  });
  console.log(JSON.stringify(r.seeds));
  const s = r.seeds;
  check(s["1"] === 1 && s["2"] === 2 && s["4294967295"] === 4294967295 && s["007"] === 7, "seeds 1..4294967295 keep their value (same worlds as before)");
  const vals = ["0", "1", "-1", "4294967295", "4294967296", "4294967297", "-4294967295", "12345678901234567890", "98765432109876543210"].map(k => s[k]);
  check(new Set(vals).size === vals.length, "0, negatives and large numbers each give their own seed");
  check(Object.values(s).every(v => Number.isInteger(v) && v >= 1 && v <= 4294967295), "every seed is a non-zero 32-bit number");
  check(s["-0"] === s["0"], "-0 is 0");
  check(r.t0 !== r.t1, "seed 0 terrain differs from seed 1");
  check(r.tBig !== r.t1, "seed 4294967297 terrain differs from seed 1");
  check(r.tNeg !== r.tMax, "seed -1 terrain differs from seed 4294967295");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
