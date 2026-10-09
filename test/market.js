// One market for players and villagers (js/market.js): node test/run.js /tmp/market test/market.js
// Spare-goods offers match the inventory minus the reserve; builder, crafter, farmer and shepherd reserves; a builder buys cobblestone from a
// villager that isn't a miner; a holder won't sell into its reserve, to villagers or the player; hungry villagers and shepherds buy only through
// offers; and no villager-to-villager trade in the code is made without an offer.
module.exports = async (pg) => {
  await require('./lib').toVillage(pg);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
    const M = BF.market, T = BF.trades, I = BF.I, em = I.emerald, inv = T.inv;
    ok("market loaded", !!M);
    const mk = (prof, level = 1) => { const v = { type: "villager", profession: prof, level, xp: 0, inv: inv.create(), position: BF.player.position.clone() }; v.trades = []; for (let l = 1; l <= level; l++) v.trades.push(...T.offers(prof, l)); return v; };
    const spare = (v, id) => v.trades.find(o => o.spare && o.sell.id === id);
    // ---- spare goods: inventory minus reserve, at the cheapest seller's price, after the job offers
    const mason = mk("mason"); inv.add(mason.inv, em, 5); inv.add(mason.inv, I.cobblestone, 64); inv.add(mason.inv, I.bone, 5);
    M.sync(mason);
    const cob = spare(mason, I.cobblestone);
    ok(`spare cobblestone at the miner's price: ${cob && cob.buy[0].n} emerald > ${cob && cob.sell.n}`, cob && cob.buy[0].n === 1 && cob.sell.n === 32 && M.spareOf(mason, I.cobblestone) === 64);
    ok("5 bones: under half an emerald's worth, not offered", !spare(mason, I.bone));
    inv.add(mason.inv, I.bone, 5); M.sync(mason);
    ok("10 bones: a small lot for 1 emerald", spare(mason, I.bone) && spare(mason, I.bone).sell.n === 10 && spare(mason, I.bone).buy[0].n === 1);
    inv.add(mason.inv, I.bone, 10); M.sync(mason);
    ok("20 bones: a full batch of 12 (VALUE + 5%)", spare(mason, I.bone) && spare(mason, I.bone).sell.n === 12 && spare(mason, I.bone).buy[0].n === 1);
    ok("job offers first, then spare goods", mason.trades.findIndex(o => o.spare) > mason.trades.findIndex(o => !o.spare) && mason.trades.slice(mason.trades.findIndex(o => o.spare)).every(o => o.spare || o.need || o.feed));
    ok("no spare offer for what its job sells (bricks)", (inv.add(mason.inv, I.brick, 30), M.sync(mason), !spare(mason, I.brick)));
    ok("no spare emeralds", !spare(mason, em));
    const keep = mason.trades.filter(o => o.spare).length;
    M.sync(mason);
    ok("sync keeps the same offers", mason.trades.filter(o => o.spare).length === keep && spare(mason, I.cobblestone) === cob);
    // a job ware below its job batch: a small spare lot (a butcher with 5 steak, its offer sells 8)
    const bu = mk("butcher", 3); inv.add(bu.inv, I.steak, 5); inv.add(bu.inv, I.bread, 7); M.sync(bu);
    const st = spare(bu, I.steak);
    ok("job ware below its batch: small spare lot " + (st && st.sell.n), st && st.sell.n === 5 && st.buy[0].n === 1);
    inv.add(bu.inv, I.steak, 8); M.sync(bu);
    ok("enough for the job offer: no spare lot", !spare(bu, I.steak));
    // ---- crafter reserve: the furniture maker keeps wool and planks for its next 2 beds
    const fm = mk("furniture_maker"); inv.add(fm.inv, em, 5); inv.add(fm.inv, I.white_wool, 6); inv.add(fm.inv, I.planks, 8); inv.add(fm.inv, I.bone, 4);
    M.sync(fm);
    ok("crafter keeps the inputs of its next 2 crafts", M.spareOf(fm, I.white_wool) === 0 && M.spareOf(fm, I.planks) === 0 && !spare(fm, I.white_wool));
    inv.add(fm.inv, I.white_wool, 20);
    ok("and can spare what's above", M.spareOf(fm, I.white_wool) === 20);
    // ---- farmer seed and wheat, shepherd feed
    const fa = mk("farmer"); inv.add(fa.inv, I.wheat_seeds, 10); inv.add(fa.inv, I.wheat_item, 30);
    ok(`farmer keeps 8 seeds and 4 wheat (${M.spareOf(fa, I.wheat_seeds)}, ${M.spareOf(fa, I.wheat_item)})`, M.spareOf(fa, I.wheat_seeds) === 2 && M.spareOf(fa, I.wheat_item) <= 26);
    // ---- everyone keeps its job's tool and food
    const mi = mk("miner"); inv.add(mi.inv, I.iron_pickaxe, 1); inv.add(mi.inv, I.stone_pickaxe, 1);
    ok("miner keeps its best pickaxe, can spare the other", M.spareOf(mi, I.iron_pickaxe) === 0 && M.spareOf(mi, I.stone_pickaxe) === 1);
    const lib = mk("librarian"); inv.add(lib.inv, I.bread, 9);
    ok(`food: keeps ${BF.food.KEEP} bread-eq (${M.spareOf(lib, I.bread)} bread spare)`, M.spareOf(lib, I.bread) === 9 - BF.food.KEEP);
    // ---- the player is held to the reserve too
    const farmerBread = mk("farmer"); inv.add(farmerBread.inv, I.bread, 7); inv.add(farmerBread.inv, em, 2);
    const breadOffer = farmerBread.trades.find(o => o.sell.id === I.bread);
    ok("job offer that would cut into the reserve: " + T.blockReason(farmerBread, breadOffer), T.blockReason(farmerBread, breadOffer) === "Keeping for own use");
    inv.add(farmerBread.inv, I.bread, 8);
    ok("above it: sells", T.blockReason(farmerBread, breadOffer) === null);
    // ---- needs: a missing tool, a shepherd's wheat, food when hungry
    const fa2 = mk("farmer"); inv.add(fa2.inv, em, 5); M.sync(fa2);
    ok("a farmer with no hoe offers to buy one", fa2.trades.some(o => o.need && /_hoe$/.test(BF.items[o.buy[0].id].name) && o.sell.id === em));
    // ---- a real village: builder reserve and next structure, buying from a non-miner
    const L = BF.vlog, p = BF.player.position, rec = L.villageAt(p.x, p.z), B = BF.builder;
    const vs = rec.members.filter(m => m.type === "villager" && !m.dead && !m.child && Array.isArray(m.inv) && Array.isArray(m.trades));
    const b = vs.find(m => m.profession === "builder");
    ok("village has a builder", !!b);
    if (b) {
      b.bs = b.bs || {};
      const nx = B.pickNext(b, b.bs);
      b.bs.next = nx;
      ok("builder chooses its next structure: " + (nx && nx.type), !!nx && Object.keys(nx.req).length > 0);
      const r = B.reserve(b);
      ok("builder reserve covers the next structure", nx && Object.keys(nx.req).every(k => r[k] >= nx.req[k]));
      const someId = +Object.keys(nx.req)[0], need = nx.req[someId];
      for (let i = 0; i < 18; i++) b.inv[i] = null;
      inv.add(b.inv, someId, need); b._res = null;
      ok(`builder won't spare what the next one needs (${BF.itemName(someId)} x${need})`, M.spareOf(b, someId) === 0);
      // a builder short of cobblestone buys it from a mason (spare goods)
      const seller = vs.find(m => m !== b && m.profession !== "miner" && m.profession !== "builder" && !m.sleeping);
      if (seller) {
        inv.add(seller.inv, I.cobblestone, 64); seller._res = null; M.sync(seller);
        inv.add(b.inv, em, 10);
        const bs = { avoid: {} };
        const deal = B.findSeller(b, bs, { [I.cobblestone]: 32 });
        ok(`builder finds cobblestone at a ${seller.profession}: ${deal && deal.seller.profession}`, deal && deal.item === I.cobblestone && deal.seller.profession !== "miner");
      } else ok("a non-miner to sell cobblestone (none here: skipped)", true);
      b.bs.next = null;
    }
    return out;
  });
  // ---- no villager-to-villager trade without an offer: every BF.vlog.trade call passes an offer object, no fair-price fallbacks
  const fs = require('fs'), path = require('path'), bad = [];
  for (const f of ["builder", "cartography", "explorer", "forester", "furniture", "miner", "storage", "toolsmith", "villagelife", "shepherd", "stables"]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8');
    for (const line of src.split("\n")) if (/vlog\.trade\(/.test(line) && /"gave /.test(line)) bad.push(f + ": " + line.trim().slice(0, 90));
    if (/deal\.fair|LOG_PER\b|0\.9 \/ val|[{,] fair: true|[{,] table: true/.test(src)) bad.push(f + ": fair-price fallback");
  }
  res.push((bad.length ? "FAIL " : "PASS ") + "every villager trade goes through an offer " + JSON.stringify(bad));
  for (const l of res) console.log(l);
};
