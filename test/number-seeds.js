// @ci integration suite=world
// Different number seeds give different worlds; seeds 1..4294967295 and saved worlds are unchanged (bug-021):
// NODE_PATH=$(npm root -g) node test/run.js /tmp/ns test/number-seeds.js
module.exports = async (pg, out) => {
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
  const r = await pg.evaluate(() => {
    const ns = BF.save.numberSeed, r = {};
    const typed = ["0", "1", "2", "-1", "4294967295", "4294967296", "4294967297", "-4294967295", "12345678901234567890", "98765432109876543210", "-0", "007"];
    r.seeds = {}; for (const t of typed) r.seeds[t] = ns(t);
    const sig = seed => { BF.newWorld(seed); const a = []; for (let x = -2000; x <= 2000; x += 500) for (let z = -2000; z <= 2000; z += 1000) a.push(BF.worldgen.heightAt(x, z)); return a.join(","); };
    r.t1 = sig(ns("1")); r.t0 = sig(ns("0")); r.tBig = sig(ns("4294967297")); r.tNeg = sig(ns("-1")); r.tMax = sig(ns("4294967295"));
    r.saved0 = sig(0); r.saved1 = sig(1);          // a world saved with seed 0 before this fix (restored through BF.newWorld)
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
  check(r.saved0 === r.saved1, "a world saved with seed 0 keeps the terrain it had");
  if (fails.length) console.log("FAIL " + fails.length + " check(s)");
};
