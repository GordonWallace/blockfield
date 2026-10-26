// @ci integration suite=village
// Sellers wait for their buyers (bug-054): node test/run.js /tmp/sw test/seller-waits.js
// Villagers were seen bunching up and walking in a line to some arbitrary spot, then scattering. Each was walking to buy from the one
// ahead of it, who was walking somewhere on its own errand (a builder after the furniture maker after the shepherd, two bakers after a
// farmer), so they all trailed the head of the line until it stopped. Now a buyer within 10 blocks calls its seller (BF.mobs.waitFor,
// from every buying walk) and the seller stops and faces it, for up to 8 s at a time.
// 1. A seller walking away stops while a buyer 6 blocks off calls it, and walks on once the calls stop.
// 2. Called for longer than 8 s, it carries on anyway, with an INFO line in the game log.
// 3. A buyer 15 blocks off does not stop it.
// 4. A seller on its way to buy from someone else keeps going; two villagers buying from each other both keep walking, to meet.


module.exports = async (pg) => {
  await pg.evaluate(() => BF.player.start());
  await require('./lib').toVillage(pg);
  const r = await pg.evaluate(() => {
    const M = BF.mobs, P = BF.player.position;
    const all = M.list.filter(v => v.type === "villager" && !v.child && !v.dead && v.village && v.village.members);
    if (all.length < 2) return { error: "not enough villagers" };
    const old = new Set(BF.glog ? BF.glog.recent(400) : []);
    let seller = null, buyer = null, start = null, dx = 1, dz = 0;
    // The seller's own work (its job, its errands) is put off for the test, so it only does the walk the test gives it.
    const hooks = [];
    for (const k of Object.keys(BF)) {
      const o = BF[k];
      if (o && typeof o === "object" && typeof o.ai === "function" && o !== M) { const f = o.ai; hooks.push([o, f]); o.ai = function (m) { return m === seller ? false : f.apply(this, arguments); }; }
    }
    const step = () => { BF.sky.setTime(0.3); M.update(0.05); P.set(seller.position.x + 4, seller.position.y + 30, seller.position.z + 4); };
    const walkOff = () => { const ai = seller.ai; ai.leaving = false; ai.mode = "walk"; ai.t = 5; ai.tx = seller.position.x + 10 * dx; ai.tz = seller.position.z + 10 * dz; ai.route = null; };
    const reset = () => { seller.position.copy(start); seller.vel.set(0, 0, 0); seller.ai.blockedT = 0; seller.ai.stuckT = 0; seller.ai.detour = null; };
    const place = dist => { buyer.position.set(seller.position.x - dist * dx, seller.position.y, seller.position.z - dist * dz); buyer.vel.set(0, 0, 0); };
    // A seller and a way for it to walk that is clear from where it stands (buildings would stop a walk one way). Each phase starts there.
    search: for (const s of all.slice(0, 10)) {
      const b = s.village.members.find(v => v !== s && v.type === "villager" && !v.child && !v.dead);   // a buyer calls a seller of its own village
      if (!b) continue;
      seller = s; buyer = b; start = s.position.clone();
      for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        dx = ex; dz = ez; reset();
        for (let i = 0; i < 120; i++) { walkOff(); place(6); step(); }   // (as far as any phase goes: 1 s under way, then up to 4 s more)
        if (Math.hypot(seller.position.x - start.x, seller.position.z - start.z) > 4.5) break search;
      }
      reset();
      seller = null;
    }
    if (!seller) { for (const [o, f] of hooks) o.ai = f; return { error: "no villager could walk off freely to test with" }; }
    const res = {};
    const moved = (n, call, dist) => {   // how far the seller walks in n steps while the buyer at `dist` calls it (or not)
      reset();
      for (let i = 0; i < 20; i++) { walkOff(); step(); }   // under way
      const x0 = seller.position.x, z0 = seller.position.z;
      for (let i = 0; i < n; i++) {
        walkOff();
        place(dist);
        if (call) M.waitFor(seller, buyer, dist);
        step();
      }
      return +Math.hypot(seller.position.x - x0, seller.position.z - z0).toFixed(2);
    };
    res.free = moved(80, false, 6);
    res.held = moved(60, true, 6);          // 3 s of calls
    res.after = moved(80, false, 6);        // calls stop: walks on
    res.long = moved(200, true, 6);         // 10 s of calls: stops for 8, then walks on
    res.far = moved(40, true, 15);
    // each buying from the other: only one of them stops
    for (let i = 0; i < 20; i++) { M.waitFor(seller, buyer, 5); M.waitFor(buyer, seller, 5); step(); }
    res.mutual = [seller.holdT > 0 && seller.holdFor === buyer, buyer.holdT > 0 && buyer.holdFor === seller];   // (either may also be held by another villager really buying from it)
    res.log = (BF.glog ? BF.glog.recent(400) : []).filter(e => e.k === "move" && !old.has(e) && /to come and trade/.test(e.x)).map(e => e.l + " " + e.x);
    for (const [o, f] of hooks) o.ai = f;
    return res;
  });
  console.log(JSON.stringify(r));
  let fails = 0;
  const fail = s => { console.log("FAIL " + s); fails++; };
  if (r.error) fail(r.error);
  else {
    if (r.free < 1) fail("the seller was not walking to begin with (" + r.free + ")");
    if (r.held > 0.3) fail("the seller kept walking (" + r.held + " blocks) while a buyer 6 blocks off called it");
    if (r.after < 1) fail("the seller did not walk on once the calls stopped (" + r.after + ")");
    if (r.long < 0.5) fail("the seller waited more than 8 s (" + r.long + ")");
    if (!r.log.some(t => /^INFO .*waited 8 s/.test(t))) fail("no INFO line for the seller that waited 8 s");
    if (r.mutual[0] || r.mutual[1]) fail("two villagers buying from each other: one stopped for the other");
    if (r.far < 1) fail("a buyer 15 blocks off stopped the seller (" + r.far + ")");
  }
  console.log(fails ? "seller-waits: " + fails + " failures" : "seller-waits: ok");
};
