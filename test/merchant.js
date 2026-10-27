// Merchants and trading caravans (js/merchant.js): node test/run.js /tmp/merchant test/merchant.js
// The merchant's counter (block, jobsite, recipe), merchants in a new village's roster (one per 20 villagers), the hiring cap, surplus and
// lack read from prices, trip pins (at most 2, unpinning, saved), path wear (20 crossings, never farmland), the cargo reserve, and saving a trip.
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c, x) => out.push((c ? "PASS " : "FAIL ") + n + (x !== undefined ? "  " + JSON.stringify(x) : ""));
    const M = BF.merchant, T = BF.trades, I = BF.I, B = BF.B, P = BF.prices, VS = BF.villageSim;
    ok("merchant loaded", !!M);
    // ---- the counter
    ok("merchant_counter block is the merchant's jobsite", B.merchant_counter != null && BF.blocks[B.merchant_counter].jobsite === "merchant");
    ok("market stall blueprint holds a counter", BF.blueprints && BF.blueprints.get ? BF.blueprints.get("market_stall", 0, 0).cells.some(c => c.id === B.merchant_counter) : true);
    // ---- roster: one per 20 villagers in a new village of 8 or more
    const rec = BF.vlog.villageAt(BF.player.position.x, BF.player.position.z);
    const want = rec.pop >= 8 ? Math.max(1, Math.floor(rec.pop / 20)) : 0;
    const slots = rec.roster.filter(s => s.prof === "merchant");
    ok(`roster has ${want} merchant(s) for ${rec.pop} villagers`, slots.length === want && slots.every(s => s.idx >= 1600 && s.idx < 1700), slots.map(s => s.idx));
    const ms = rec.members.filter(m => m.type === "villager" && m.profession === "merchant" && !m.dead);
    ok("merchants spawn with a tent and emeralds, no wares", ms.length === want && ms.every(m => T.inv.count(m.inv, I.tent) === 1 && T.inv.count(m.inv, I.emerald) > 0), ms.map(m => m.inv.filter(Boolean).map(s => BF.items[s.id].name)));
    // ---- hiring cap
    const other = rec.members.find(m => m.type === "villager" && m.profession !== "merchant" && !m.dead);
    ok("no more merchants than the cap", !M.mayHire(other, { prof: "merchant" }));
    // ---- surplus and lack from prices
    const mk = (prof, offers) => { const v = { type: "villager", profession: prof, level: 1, xp: 0, inv: T.inv.create(), position: BF.player.position.clone(), trades: offers }; T.inv.add(v.inv, I.emerald, 30); return v; };
    const sellCob = { buy: [{ id: I.emerald, n: 1 }], sell: { id: I.cobblestone, n: 32 }, level: 1, xp: 1 };
    const buyCob = { buy: [{ id: I.cobblestone, n: 48 }], sell: { id: I.emerald, n: 1 }, level: 1, xp: 1 };
    const s1 = mk("mason", [sellCob]); T.inv.add(s1.inv, I.cobblestone, 64);
    const b1 = mk("builder", [buyCob]);
    const A = { key: "a", members: [s1] }, Bv = { key: "b", members: [b1] };
    const merch = mk("merchant", []);
    let g = M.goods(A, Bv, merch, 10);
    ok("base prices: nothing worth carrying", g.list.length === 0, g);
    P.reprice ? (sellCob.step = -20, buyCob.step = 20, P.reprice(s1, sellCob), P.reprice(b1, buyCob)) : 0;
    g = M.goods(A, Bv, merch, 10);
    ok(`marked down here, risen there: carry cobblestone (${g.list.map(x => x.n + " at " + x.buy.toFixed(3) + " -> " + x.sell.toFixed(3))})`, g.list.length === 1 && g.list[0].id === I.cobblestone && g.profit > 0, g);
    ok("not the other way", M.goods(Bv, A, merch, 10).list.length === 0);
    // ---- pins
    VS.reset();
    const v0 = { x: 0, z: 0, minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, v1 = { x: 160, z: 40, minX: 150, maxX: 170, minZ: 30, maxZ: 50 }, v2 = { x: -100, z: 100, minX: -110, maxX: -90, minZ: 90, maxZ: 110 };
    const cor = VS.corridor(v0, v1);
    ok("corridor covers the walk and one chunk either side", cor.includes("0,0") && cor.includes("10,2") && cor.includes("5,2") && cor.length < 70, cor.length);
    ok("pin 1", VS.pin("t1", v0, v1)); ok("pin 2", VS.pin("t2", v0, v2)); ok("a third trip waits", !VS.pin("t3", v1, v2));
    VS.update(5000, 5000);
    ok("pinned villages are simulated far from the player", VS.isActive("0,0") && VS.isActive("160,40") && VS.isActive("-100,100"));
    ok("corridor chunks are kept", cor.every(k => VS.keepKeys.has(k)));
    const sv = {}; VS.exportSeen(sv);
    ok("pins are saved", sv["pin:t1"] && sv["pin:t1"].a === "0,0" && sv["pin:t1"].b === "160,40");
    VS.unpin("t1"); VS.unpin("t2"); VS.update(5000, 5000);
    ok("unpinned: nothing kept out here", !VS.isActive("160,40") && !VS.keepKeys.has("5,2"));
    VS.reset();
    // ---- path wear: 20 crossings of grass make a dirt path; farmland never changes
    const saved = new Map(BF.mobs.villages); BF.mobs.villages.clear();   // away from every village box
    try {
      const px = Math.floor(BF.player.position.x) + 3, pz = Math.floor(BF.player.position.z) + 3, gy = BF.world.heightAt(px, pz);
      const W = BF.world;
      W.setBlock(px, gy, pz, B.grass); W.setBlock(px, gy + 1, pz, 0); W.setBlock(px, gy + 2, pz, 0);
      const fake = { position: { x: px + 0.5, y: gy + 1, z: pz + 0.5 }, onGround: true };
      const walk = n => { for (let i = 0; i < n; i++) { const st = {}; M.step(fake, st); } };
      walk(19);
      ok("19 crossings: still grass", W.getBlock(px, gy, pz) === B.grass, W.getBlock(px, gy, pz));
      walk(1);
      ok("20 crossings: a dirt path", W.getBlock(px, gy, pz) === B.dirt_path, W.getBlock(px, gy, pz));
      W.setBlock(px, gy, pz, B.farmland);
      walk(40);
      ok("farmland never changes", W.getBlock(px, gy, pz) === B.farmland);
      W.setBlock(px, gy, pz, B.grass);
    } finally { for (const [k, v] of saved) BF.mobs.villages.set(k, v); }
    // ---- reserve and save
    const mm = ms[0];
    if (mm) {
      T.inv.add(mm.inv, I.cobblestone, 40);
      const st = M._state(mm);
      st.trip = { id: "x", home: rec.key, dest: "1,1", dx: 1, dz: 1, day0: BF.sky.day, out: [{ id: I.cobblestone, n: 40, buy: 0.03, sell: 0.05 }], back: [], soldN: 0, soldE: 0 }; st.stage = "go"; st.cargo = [{ id: I.cobblestone, n: 40 }]; mm._res = null;
      ok("cargo on a trip is not for sale", BF.market.spareOf(mm, I.cobblestone) === 0);
      const pk = JSON.parse(JSON.stringify(T.pack(mm)));
      const copy = { type: "villager", profession: "merchant", inv: T.inv.create(), trades: [] };
      T.unpack(copy, pk);
      ok("a trip is saved and loaded", copy.mc && copy.mc.trip && copy.mc.trip.dest === "1,1" && copy.mc.stage === "go" && copy.mc.trip.dx === 1, copy.mc && copy.mc.trip);
      st.trip = null; st.stage = null; mm._res = null;
      ok("home again: it can sell what's left", BF.market.spareOf(mm, I.cobblestone) === 40);
    }
    return out;
  });
  for (const l of res) console.log(l);
};
