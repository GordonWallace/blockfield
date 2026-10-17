// Farmer bucket checks (1.2): node test/run.js /tmp/fb test/farmer-bucket.js
// Nothing from nothing: a villager's bucket is filled only by taking a water source block, as the player's bucket does. A lone
// source is used up; an infinite source (two source neighbours over solid ground) flows back in; a bed's own channel water that
// would not refill is never picked to fill from.
module.exports = async (pg) => {
  const r = await pg.evaluate(async () => {
    const out = [], ok = (name, c, info) => out.push((c ? "PASS " : "FAIL ") + name + (c || info === undefined ? "" : " " + JSON.stringify(info)));
    const B = BF.B, W = BF.world, VL = BF.villageLife, X = VL._test, inv = BF.trades.inv, I = BF.I;
    const px = Math.floor(BF.player.position.x) + 20, pz = Math.floor(BF.player.position.z) - 10;
    const y0 = W.heightAt(px, pz);
    for (let x = px - 8; x <= px + 24; x++) for (let z = pz - 8; z <= pz + 24; z++) {
      for (let y = y0 - 3; y <= y0 + 8; y++) W.setBlock(x, y, z, y < y0 ? B.dirt : y === y0 ? B.grass : 0);
    }
    const farmer = { type: "villager", profession: "farmer", inv: inv.create(), position: new THREE.Vector3(px + 0.5, y0 + 1, pz + 0.5), ai: {} };
    inv.add(farmer.inv, I.bucket, 1);
    const full = () => inv.count(farmer.inv, I.water_bucket), empty = () => inv.count(farmer.inv, I.bucket);
    const wait = ms => new Promise(res => setTimeout(res, ms));
    // 1. a lone source: the bucket takes it, and it is gone for good
    const lx = px + 2, lz = pz + 2;
    W.setBlock(lx, y0, lz, B.water);
    ok("fills from a lone source", VL.fillBucket(farmer, lx, y0, lz) && full() === 1 && empty() === 0);
    ok("the lone source is taken", BF.FLUID[W.getBlock(lx, y0, lz)] !== 8, W.getBlock(lx, y0, lz));
    await wait(1500);
    ok("the lone source does not come back", BF.FLUID[W.getBlock(lx, y0, lz)] !== 8, W.getBlock(lx, y0, lz));
    ok("no second bucket from the spot", !VL.fillBucket(farmer, lx, y0, lz));
    // 2. the bucket is poured into a bed channel cell and the farmer is left empty: refilling from that same single cell takes it back
    inv.remove(farmer.inv, I.water_bucket, 1); inv.add(farmer.inv, I.bucket, 1);
    W.setBlock(lx, y0, lz, B.water);
    ok("pour then refill from the same cell takes the water back", VL.fillBucket(farmer, lx, y0, lz) && BF.FLUID[W.getBlock(lx, y0, lz)] !== 8);
    // 3. an infinite source: a 3x3 pond; the middle cell flows back in after it is taken
    inv.remove(farmer.inv, I.water_bucket, 1); inv.add(farmer.inv, I.bucket, 1);
    const ox = px + 10, oz = pz + 10;
    for (let x = ox - 1; x <= ox + 1; x++) for (let z = oz - 1; z <= oz + 1; z++) W.setBlock(x, y0, z, B.water);
    ok("fills from a pond", VL.fillBucket(farmer, ox, y0, oz) && full() === 1);
    ok("the pond cell is taken at first", BF.FLUID[W.getBlock(ox, y0, oz)] !== 8);
    await wait(1500);
    ok("the pond cell flows back in", BF.FLUID[W.getBlock(ox, y0, oz)] === 8, W.getBlock(ox, y0, oz));
    // 4. findFill skips a bed's channel end (would not refill) but uses a lone pool out in the open
    inv.remove(farmer.inv, I.water_bucket, 1); inv.add(farmer.inv, I.bucket, 1);
    for (let x = ox - 1; x <= ox + 1; x++) for (let z = oz - 1; z <= oz + 1; z++) W.setBlock(x, y0, z, B.grass);
    const D = VL.vdata({ key: "buckettest" + Math.random(), wg: {} });
    const bx = px + 3, bz = pz + 3;                                  // a one-cell channel inside a bed by the farmer
    W.setBlock(bx, y0, bz, B.water);
    D.beds = [{ x0: bx - 1, z0: bz - 1, x1: bx + 1, z1: bz + 1 }];
    D.water = [[bx, y0, bz]];
    ok("a bed's lone channel water is not picked to fill from", !X.findFill(farmer, D, null), X.findFill(farmer, D, null));
    W.setBlock(px + 16, y0, pz + 16, B.water); D.water.push([px + 16, y0, pz + 16]);
    const f = X.findFill(farmer, D, null);
    ok("a lone pool outside the beds is picked", !!f && f.x === px + 16 && f.z === pz + 16, f);
    ok("the bed's channel is left alone", BF.FLUID[W.getBlock(bx, y0, bz)] === 8);
    return out;
  });
  console.log(r.join("\n"));
};
