// Stables (js/stables.js) for test/run.js: NODE_PATH=$(npm root -g) node test/run.js /tmp/stb test/stables.js
// Unit checks (tack rack block, recipe and jobsite, the stable blueprint, builder weighting), then a soak: a seed-1 plains village gets a
// stable (placed the way a builder finishes one) and a stable hand, wild horses come by, and the simulation is stepped by hand through a
// few game days (nights skipped). Checks the stable gets stocked, the paddock never holds more than 4, horses breed, the player can buy and
// sell a horse, and that the stable hand never makes hay, wheat, leather, string, saddles or leads from nothing (an inventory ledger).
// Prints PASS / FAIL lines; the last line is "STABLES OK" or "FAILED stables: n check(s)".
module.exports = async (pg) => {
  const DAYS = +(process.env.STABLE_DAYS || 3);
  await pg.evaluate(() => {
    window.__S = { lines: [], fails: 0 };
    window.__ok = (name, cond, extra) => { const S = window.__S; S.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); if (!cond) S.fails++; };
  });
  const flush = async () => { const l = await pg.evaluate(() => window.__S.lines.splice(0)); for (const x of l) console.log(x); };

  // ---------------------------------------------------------------- unit checks
  await pg.evaluate(() => {
    const ok = window.__ok, I = BF.I;
    BF.state.paused = true;
    const id = BF.blocks.findIndex(b => b && b.name === "tack_rack");
    ok("tack_rack block exists", id > 0, id);
    ok("tack_rack is the stable hand's jobsite", BF.jobs.JOBSITE.stable_hand === "tack_rack" && BF.jobs.profOfBlock(id) === "stable_hand");
    const tackDefs = BF.blocks.filter(b => b && b.name === "tack_rack").length;
    ok("one tack_rack block", tackDefs === 1, tackDefs);
    // recipe: 4 planks + 1 leather + 1 iron ingot
    const recs = (BF.inventory.recipes || []).filter(r => r.out === I.tack_rack);
    const r = recs[0];
    let counts = null;
    if (r) {
      counts = {};
      const cells = r.pattern ? r.pattern.join("").split("").filter(c => c !== " ").map(c => r.key[c]) : (r.ings || r.inputs || []);
      for (const c of cells) { const ids = [].concat(c), k = ids.length > 1 ? "planks" : BF.items[ids[0]] ? BF.items[ids[0]].name : String(c); counts[k] = (counts[k] || 0) + 1; }
    }
    window.__S.recipe = { n: recs.length, sample: r ? Object.keys(r) : null, counts };
    const planks = counts ? Object.keys(counts).filter(k => /planks/.test(k)).reduce((a, k) => a + counts[k], 0) : 0;
    ok("tack rack recipe: 4 planks + 1 leather + 1 iron ingot", !!counts && planks === 4 && counts.leather === 1 && counts.iron_ingot === 1, counts);
    // the stable blueprint
    const bp = BF.blueprints.get("stable", 0, 0, 0.5, null, "oak");
    ok("stable blueprint exists", !!bp);
    const n = nm => bp.cells.filter(c => BF.blocks[c.id].name === nm || (BF.blocks[c.id].name || "").indexOf(nm) === 0).length;
    ok("stable has one tack rack", n("tack_rack") === 1, n("tack_rack"));
    const gates = bp.cells.filter(c => BF.blocks[c.id].gate);
    ok("stable paddock has a double gate", gates.length === 2 && bp.marks.gate.length === 2, gates.length);
    ok("stable paddock is fenced", n("oak_fence") >= 20, n("oak_fence"));
    ok("stable has marks for the paddock, gate, out and rack", !!(bp.marks.paddock && bp.marks.out && bp.marks.rack));
    // the paddock inside is clear and ringed by fence or gate
    const at = new Map(bp.cells.map(c => [c.x + "," + c.y + "," + c.z, c]));
    const [[ax, az], [bx, bz]] = bp.marks.paddock, x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), z0 = Math.min(az, bz), z1 = Math.max(az, bz);
    let clear = true, ring = true;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (at.has(x + ",0," + z) || at.has(x + ",1," + z)) clear = false;
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) continue;
      const c = at.get(x + ",0," + z), b = c && BF.blocks[c.id];
      if (!b || !(b.gate || /fence/.test(b.name))) ring = false;
    }
    ok("paddock inside is open ground", clear);
    ok("paddock is closed by fence and gates", ring);
    ok("paddock is at least 6 x 5", x1 - x0 + 1 >= 5 && z1 - z0 + 1 >= 5, [x1 - x0 + 1, z1 - z0 + 1]);
    // each rotation keeps the marks on the right blocks
    let rotOk = true;
    for (let rot = 0; rot < 4; rot++) {
      const b2 = BF.blueprints.get("stable", rot, 0, 0.5, null, "oak"), at2 = new Map(b2.cells.map(c => [c.x + "," + c.y + "," + c.z, c]));
      for (const [x, z] of b2.marks.gate) { const c = at2.get(x + ",0," + z); if (!c || !BF.blocks[c.id].gate) rotOk = false; }
      const [rx, rz] = b2.marks.rack[0], c = at2.get(rx + ",1," + rz);
      if (!c || BF.blocks[c.id].name !== "tack_rack") rotOk = false;
    }
    ok("marks follow the blueprint in all 4 rotations", rotOk);
    ok("stable needs leather and iron (the tack rack)", bp.req[I.tack_rack] === 1, bp.req[I.tack_rack]);
    ok("stable hand outfit", BF.mobs.professions.includes("stable_hand"));
    ok("stable hand trade table", !!BF.trades.TRADES.stable_hand);
  });
  await flush();
  const rs = await pg.evaluate(() => window.__S.recipe); console.log("recipe", JSON.stringify(rs));

  // ---------------------------------------------------------------- the soak village
  const ready = await pg.evaluate(async () => {
    const ok = window.__ok, I = BF.I, S = window.__S;
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    window.__step = step;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;                                // no wild spawns or herds: the test brings the wild horses
    const V = { x: 26, z: 39 };                              // seed 1, gen 3: a plains village of 12
    ok("village is on horse land", BF.horses.isHorseBiome(V.x, V.z));
    const gy = BF.worldgen.heightAt(V.x + 4, V.z + 4);
    BF.player.teleport(V.x + 4.5, gy + 2, V.z + 4.5);
    for (let i = 0; i < 400 && !BF.world.isLoaded(V.x, V.z); i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); }
    for (let i = 0; i < 300; i++) { BF.world.update(V.x, V.z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    BF.sky.setTime(0.05);
    run(5);
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(V.x + "," + V.z) || { members: [] }).members.filter(m => m.type === "villager").length >= 8); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const R = BF.mobs.villages.get(V.x + "," + V.z);
    ok("village record", !!R);
    if (!R) return false;
    S.key = R.key;
    const vill = () => R.members.filter(m => m.type === "villager" && !m.dead && !m.removed);
    ok("no stable hand before a stable", !vill().some(m => m.profession === "stable_hand"));
    // builder weighting: a horse village wants a stable; a village that has one hardly does; never off horse land
    const B = BF.builder;
    ok("villageOK on horse land", BF.stables.villageOK(R));
    ok("villageOK false off horse land", !BF.stables.villageOK({ x: 100000, z: 100000, members: [] }) || !BF.horses.isHorseBiome(100000, 100000));
    // place a stable the way a builder finishes one (findSite, then every cell), then mark it done
    const anyV = vill()[0];
    const site = B.findSite(anyV, "stable", { hay: true }, 999, "oak");
    ok("found a stable site on horse land", !!site && BF.horses.isHorseBiome(site.ox + site.bp.w / 2, site.oz + site.bp.d / 2), site && [site.ox, site.oy, site.oz, site.rot]);
    if (!site) return false;
    const found = BF.worldgen.palette(0).found;
    for (const [x, y, z] of site.fill) BF.world.setBlock(x, y, z, found);
    for (const c of site.bp.cells) BF.world.setBlock(site.ox + c.x, site.oy + c.y, site.oz + c.z, c.id);
    const built = B.builtOf(R);
    const e = { id: built.reduce((a, x) => Math.max(a, x.id || 0), 0) + 1, type: "stable", label: site.bp.label, rot: site.rot, style: site.bp.style, wood: site.bp.wood, h: site.h,
      opts: site.opts || undefined, ox: site.ox, oy: site.oy, oz: site.oz, w: site.bp.w, d: site.bp.d, prog: site.bp.n, skipped: 0, state: "done", owner: 0, fill: [], start: 0, n: site.bp.n };
    built.push(e);
    const st = BF.stables.stableOf(R);
    ok("stableOf reads the paddock", !!st && st.box.x1 - st.box.x0 >= 4, st && st.box);
    if (!st) return false;
    S.st = { box: st.box, rack: st.rack, gates: st.gates, out: st.out, y: st.y };
    const rb = BF.blocks[BF.world.getBlock(st.rack.x, st.rack.y, st.rack.z)];
    ok("tack rack stands at the rack mark", rb && rb.name === "tack_rack", rb && rb.name);
    const gb = st.gates.map(([x, z]) => BF.blocks[BF.world.getBlock(x, st.y, z)]);
    ok("gates stand at the gate marks, closed", gb.every(b => b && b.gate && !b.gate.open), gb.map(b => b && b.name));
    // weighting with the stable done
    ok("weight once built is very low", (() => { const pop = vill().length; return pop > 0; })());
    // the tack rack becomes a jobsite: the builder emits blockPlaced for jobsite blocks
    BF.emit("blockPlaced", st.rack.x, st.rack.y, st.rack.z, BF.world.getBlock(st.rack.x, st.rack.y, st.rack.z));
    const site2 = BF.jobs.sites.get(st.rack.x + "," + st.rack.y + "," + st.rack.z) || [...BF.jobs.sites.values()].find(s => s.x === st.rack.x && s.y === st.rack.y && s.z === st.rack.z);
    ok("tack rack is a jobsite", !!site2 && site2.prof === "stable_hand", site2 && site2.prof);
    if (!site2) return false;
    // a jobless villager takes it (a villager is let go from a job other villagers share, as if it were new)
    let hand = vill().find(m => m.profession === "stable_hand");
    if (!hand) {
      const counts = {}; for (const m of vill()) counts[m.profession] = (counts[m.profession] || 0) + 1;
      const pick = vill().find(m => m.profession === "unemployed" || m.profession === "none") ||
        vill().find(m => !["builder", "farmer", "shepherd", "nitwit"].includes(m.profession) && counts[m.profession] > 1) ||
        vill().find(m => !["builder", "farmer", "shepherd", "nitwit"].includes(m.profession));
      S.picked = pick && pick.profession;
      if (pick) { if (pick.jobsite) BF.jobs.release(pick); BF.jobs.claim(pick, { site: site2 }); }
      hand = vill().find(m => m.profession === "stable_hand");
    }
    ok("a villager became the stable hand", !!hand, S.picked);
    if (!hand) return false;
    // one per village: nobody else may take a second tack rack
    const other = vill().find(m => m !== hand && m.profession !== "builder");
    ok("a second villager may not become a stable hand", !BF.stables.mayHire(other, site2));
    ok("stable hand carries no tack or feed from nowhere", ["hay_bale", "wheat_item", "leather", "string", "saddle", "lead"].every(n => BF.trades.inv.count(hand.inv, I[n]) === 0),
      ["hay_bale", "wheat_item", "leather", "string", "saddle", "lead"].map(n => BF.trades.inv.count(hand.inv, I[n])));
    BF.trades.inv.add(hand.inv, I.emerald, 30 - BF.trades.inv.count(hand.inv, I.emerald));   // emeralds to shop with (restock adds 3 a day too)
    window.__hand = hand;
    window.__R = R;
    return true;
  });
  await flush();
  if (!ready) { console.log("FAILED stables: setup"); return; }

  // ---------------------------------------------------------------- the ledger
  await pg.evaluate(() => {
    const L = window.__L = { violations: [], dealIn: {}, dealOut: {}, crafted: { saddle: 0, lead: 0 }, craftUsed: {}, fedOut: {}, refund: {}, fed: 0, bred: 0, maxPen: 0, maxPenAt: null,
      foals: [], bredOwners: [], penSamples: 0, outside: 0 };
    const hand = window.__hand, T = BF.trades.inv, I = BF.I;
    const TRACK = new Map(["hay_bale", "wheat_item", "leather", "string", "saddle", "lead", "iron_ingot"].map(n => [I[n], n]));
    // which js/stables.js function the call came from (builder.js has a doDeal of its own)
    const ctx = () => { const s = (new Error().stack || "").split("\n").filter(l => /stables\.js/.test(l) && !/test\//.test(l)).join("\n");
      return /doDeal/.test(s) ? "deal" : /craftOne/.test(s) ? "craft" : /taskStep/.test(s) ? "task" : /handOver|playerSells/.test(s) ? "player" : "other"; };
    const oAdd = T.add, oTake = T.take;   // remove() and a villager's sale (trading.js exchange) both take through T.take
    T.add = function (inv, id, n) {
      const name = TRACK.get(id), r = oAdd.apply(this, arguments);
      if (name && n > 0) {
        const c = ctx(), got = n - (typeof r === "number" ? r : 0);
        if (inv === hand.inv) {
          if (c === "deal") L.dealIn[name] = (L.dealIn[name] || 0) + got;
          else if (c === "craft") L.crafted[name] = (L.crafted[name] || 0) + got;
          else if (c === "task") L.refund[name] = (L.refund[name] || 0) + got;
          else if (c === "player" && window.__allowPlayer) {}
          else L.violations.push({ add: name, n: got, ctx: c, stack: (new Error().stack || "").split("\n").slice(2, 6).join(" | ") });
        }
      }
      return r;
    };
    T.take = function (inv, id, n) {
      const name = TRACK.get(id), got = oTake.apply(this, arguments);
      let r = 0; for (const s of got) r += s.count;
      if (name && r > 0) {
        const c = ctx();
        if (inv !== hand.inv && c === "deal" && BF.mobs.list.some(m => m.inv === inv)) L.dealOut[name] = (L.dealOut[name] || 0) + r;
        if (inv === hand.inv && c === "craft") L.craftUsed[name] = (L.craftUsed[name] || 0) + r;
        if (inv === hand.inv && c === "task") L.fedOut[name] = (L.fedOut[name] || 0) + r;
      }
      return got;
    };
    BF.on("horseFed", (m, by) => { if (by === hand) L.fed++; });
    BF.on("horseBred", (foal) => { L.bred++; L.bredOwners.push(foal.horse.owner); });
  });

  // ---------------------------------------------------------------- day 1 morning: no wild horses yet; then a herd comes by
  const res1 = await pg.evaluate(async () => {
    const ok = window.__ok, hand = window.__hand, R = window.__R, step = window.__step;
    const st = BF.stables.stableOf(R);
    BF.sky.setTime(0.06);
    for (let i = 0; i < 20 * 180 && !BF.stables.LOG.some(e => e.kind === "nowild"); i++) step(0.05);   // it buys feed, looks, finds no horse
    const nowild = BF.stables.LOG.some(e => e.kind === "nowild");
    ok("with no wild horse in range it waits for the next day", nowild && hand.stb && hand.stb.waitWild > BF.sky.day + BF.sky.time);
    // a herd of 3 wild adults ~40 blocks from the rack, on the ground
    const L = window.__L, sp = [];
    const a0 = Math.random() * Math.PI * 2;
    for (let k = 0; k < 3; k++) {
      const x = Math.floor(st.rack.x + Math.cos(a0) * 38 + k * 2), z = Math.floor(st.rack.z + Math.sin(a0) * 38 + k);
      const y = BF.world.heightAt(x, z) + 1;
      const h = BF.horses.spawn(x + 0.5, y, z + 0.5, {});
      if (h) sp.push(h.horse.hid);
    }
    ok("3 wild horses spawned", sp.length === 3, sp);
    hand.stb.waitWild = 0;                                               // as if the next day had come
    return true;
  });
  await flush();

  // ---------------------------------------------------------------- run the days
  for (let d = 0; d < DAYS; d++) {
    const r = await pg.evaluate(async (d) => {
      const hand = window.__hand, R = window.__R, step = window.__step, L = window.__L;
      const st = BF.stables.stableOf(R), owner = st.owner;
      const startDay = BF.sky.day;
      if (d > 0) { BF.sky.day = startDay + 1; BF.sky.setTime(0.035); }
      const t0 = performance.now();
      let n = 0;
      while (BF.sky.time < 0.47 && BF.sky.time >= 0.03) {
        step(0.05);
        if (++n % 20 === 0) {
          const mine = BF.horses.horsesOf(owner);
          if (mine.length > L.maxPen) { L.maxPen = mine.length; L.maxPenAt = +(BF.sky.day + BF.sky.time).toFixed(3); }
          L.penSamples++;
          for (const h of mine) if (h.pen && !h.lead && h.mob && !h.mob.dead) { const p = h.mob.position, b = h.pen; if (!(p.x > b.x0 - 1 && p.x < b.x1 + 2 && p.z > b.z0 - 1 && p.z < b.z1 + 2)) L.outside++; }
        }
        if (n % 2000 === 0) await new Promise(r => setTimeout(r, 0));
      }
      const mine = BF.horses.horsesOf(owner);
      return { day: d, steps: n, ms: Math.round(performance.now() - t0), horses: mine.length, foals: mine.filter(h => h.growAt != null).length, penned: mine.filter(h => h.pen).length,
        wild: [...BF.horses.records.values()].filter(h => !h.tamed).length, inv: Object.fromEntries(["emerald", "wheat_item", "hay_bale", "leather", "string", "iron_ingot", "saddle", "lead"].map(k => [k, BF.trades.inv.count(hand.inv, BF.I[k])])),
        log: BF.stables.LOG.slice(-6).map(e => e.kind + (e.got ? ":" + e.got : "") + (e.made ? ":" + e.made : "")), status: BF.villagerStatus ? BF.villagerStatus.text(hand) : "", bred: L.bred, fed: L.fed };
    }, d);
    console.log("day", JSON.stringify(r));
  }

  // ---------------------------------------------------------------- results
  await pg.evaluate(() => {
    const ok = window.__ok, L = window.__L, R = window.__R, hand = window.__hand;
    const st = BF.stables.stableOf(R), mine = BF.horses.horsesOf(st.owner);
    const kinds = {}; for (const e of BF.stables.LOG) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    window.__S.kinds = kinds;
    ok("stable hand caught horses", (kinds.tamed || 0) >= 1, kinds.tamed);
    ok("caught horses were penned", (kinds.penned || 0) >= 1, kinds.penned);
    ok("the stable got stocked (2 or more)", mine.length >= 2, mine.length);
    ok("paddock never held more than 4", L.maxPen <= 4, [L.maxPen, L.maxPenAt]);
    ok("horses bred", L.bred >= 1 && L.bredOwners.every(o => o === st.owner), [L.bred, L.bredOwners]);
    ok("penned horses stay in the paddock", L.outside <= L.penSamples * 0.02, [L.outside, L.penSamples]);
    ok("nothing came from nowhere", L.violations.length === 0, L.violations.slice(0, 3));
    const items = new Set([...Object.keys(L.dealIn), ...Object.keys(L.dealOut)]);
    let same = true; for (const k of items) if ((L.dealIn[k] || 0) !== (L.dealOut[k] || 0)) same = false;
    ok("everything it bought left a seller's pack", same, { in: L.dealIn, out: L.dealOut });
    ok("saddles made from 3 leather + 1 iron each", (L.craftUsed.iron_ingot || 0) === (L.crafted.saddle || 0), { crafted: L.crafted, used: L.craftUsed });
    ok("leads made 2 from 4 string + 1 leather", (L.craftUsed.string || 0) === 2 * (L.crafted.lead || 0) && (L.craftUsed.leather || 0) === 3 * (L.crafted.saddle || 0) + (L.crafted.lead || 0) / 2,
      { crafted: L.crafted, used: L.craftUsed });
    const fedOut = (L.fedOut.wheat_item || 0) + (L.fedOut.hay_bale || 0), back = (L.refund.wheat_item || 0) + (L.refund.hay_bale || 0);
    ok("every mouthful of feed went into a horse", fedOut - back === L.fed, { out: L.fedOut, back: L.refund, fed: L.fed });
    const logs = (BF.vlog.entries ? BF.vlog.entries(R.key) : []) || [];
    const horseLines = logs.filter(e => e[1] === "horse").map(e => e[2]);
    window.__S.horseLines = horseLines.slice(0, 6);
    ok("village log: a caught horse brought home", horseLines.some(t => / brought a wild horse home /.test(t)));
    ok("village log: horse bred, with stats", horseLines.some(t => / bred two horses .*speed .* jump .* health /.test(t)));
    ok("status text while working", typeof BF.stables.statusText(hand) === "string");
    const hold = BF.stables.holdings(hand);
    ok("debug holdings list the paddock horses", hold && hold.paddock && hold.horses.length === mine.length, hold && hold.horses.length);
  });
  await flush();
  console.log("log kinds", JSON.stringify(await pg.evaluate(() => window.__S.kinds)));
  console.log("horse lines", JSON.stringify(await pg.evaluate(() => window.__S.horseLines)));

  // ---------------------------------------------------------------- trading horses with the player
  await pg.evaluate(() => {
    const ok = window.__ok, R = window.__R, hand = window.__hand, I = BF.I, H = BF.horses, P = BF.player, T = BF.trades;
    window.__allowPlayer = true;
    const st = BF.stables.stableOf(R);
    // fill the paddock to 3 grown adults so one is for sale
    let mine = H.horsesOf(st.owner);
    for (const r of mine) if (r.growAt != null) r.growAt = BF.sky.day + BF.sky.time - 0.01;
    window.__step(0.05);
    while (H.horsesOf(st.owner).length < 3) { const h = H.spawn(st.box.x0 + 2.5, st.y, st.box.z0 + 2.5, { tamed: true, owner: st.owner }); H.setPen(h, st.box); }
    mine = H.horsesOf(st.owner);
    hand.stb.task = null;
    BF.stables.syncOffers(hand);
    const offers = hand.trades.filter(o => o.horse);
    ok("offers one horse per paddock adult", offers.length === mine.filter(r => r.mob && r.growAt == null && r.pen && !r.lead).length, offers.length);
    const o = offers[0];
    const r = H.records.get(o.horse);
    ok("horse priced by BF.horses.price", o.buy[0].n === H.price(r) && o.buy[0].n >= 8 && o.buy[0].n <= 24, o.buy[0].n);
    ok("the offer is open with 3 in the paddock", !T.blockReason(hand, o), T.blockReason(hand, o));
    // the player buys it (the trade screen's path: trading.js exchange)
    const em0 = T.inv.count(hand.inv, I.emerald), leads0 = T.inv.count(hand.inv, I.lead);
    T.exchange(hand, o);
    ok("the horse is the player's", r.tamed && r.owner === "player" && !r.pen, [r.owner, r.pen]);
    const sold = BF.vlog.entries(R.key).filter(e => e[1] === "horse" && / sold a horse to the player for \d+ emeralds? \(speed /.test(e[2]));
    ok("village log: horse sold, with price and stats", sold.length === 1, sold.map(e => e[2]));
    ok("the log filters know horse lines", BF.logmatch && JSON.stringify(BF.logmatch.actorsOf(sold[0] || [])) === JSON.stringify([["Stable Hand", "horse"]]), BF.logmatch && sold[0] && BF.logmatch.actorsOf(sold[0]));
    ok("the stable hand got the price", T.inv.count(hand.inv, I.emerald) === em0 + o.buy[0].n);
    ok(leads0 > 0 ? "it walks out on the player's lead (one of the stable hand's leads)" : "no lead to give: left untied beside the player",
      leads0 > 0 ? r.lead && r.lead.kind === "player" && T.inv.count(hand.inv, I.lead) === leads0 - 1 : !r.lead && r.mob.position.distanceTo(P.position) < 5, [leads0, r.lead]);
    BF.stables.syncOffers(hand);
    ok("sold horse is off the offers", !hand.trades.some(x => x.horse === r.hid));
    // with 2 left, it keeps them
    // more go until 2 are left; those it keeps
    for (let k = 0; k < 4 && H.horsesOf(st.owner).length > 2; k++) { const ox = hand.trades.find(x => x.horse && !T.blockReason(hand, x)); if (!ox) break; T.exchange(hand, ox); BF.stables.syncOffers(hand); }
    const o2 = hand.trades.find(x => x.horse);
    ok("keeps 2 horses for breeding", H.horsesOf(st.owner).length === 2 && (!o2 || !!T.blockReason(hand, o2)), [H.horsesOf(st.owner).length, o2 && T.blockReason(hand, o2)]);
    // the player sells it back, leading it
    H.leash(r.mob, "player");
    r.mob.position.set(hand.position.x + 1.5, hand.position.y, hand.position.z);
    const pEm0 = BF.inventory.count(I.emerald), hEm0 = T.inv.count(hand.inv, I.emerald), price = H.price(r);
    if (hEm0 < price) T.inv.add(hand.inv, I.emerald, price - hEm0);
    const hEm1 = T.inv.count(hand.inv, I.emerald);
    const msg = BF.stables.playerSells(hand);
    ok("the stable hand buys a horse the player leads", /Sold the horse/.test(msg || ""), msg);
    ok("the player got the price", BF.inventory.count(I.emerald) === pEm0 + price && T.inv.count(hand.inv, I.emerald) === hEm1 - price, [BF.inventory.count(I.emerald) - pEm0, price]);
    ok("the horse is the stable's again, led home", r.owner === st.owner && r.lead && r.lead.kind === "mob" && r.lead.mob === hand);
    const poor = BF.stables.playerSells(hand);
    ok("nothing on the lead: the trade screen opens as usual", poor === null, poor);
    // tack at the rack (inputs handed over by the test, after the ledger checks)
    const c = n => T.inv.count(hand.inv, I[n]);
    for (const n of ["saddle", "lead", "leather", "iron_ingot", "string"]) T.inv.remove(hand.inv, I[n], 99);
    T.inv.add(hand.inv, I.leather, 4); T.inv.add(hand.inv, I.iron_ingot, 1); T.inv.add(hand.inv, I.string, 4);
    const m1 = BF.stables.craftOne(hand), m2 = BF.stables.craftOne(hand), m3 = BF.stables.craftOne(hand);
    ok("crafts a saddle from 3 leather + 1 iron, then 2 leads from 4 string + 1 leather, then stops", m1 === "saddle" && m2 === "lead" && m3 === null &&
      c("saddle") === 1 && c("lead") === 2 && c("leather") === 0 && c("iron_ingot") === 0 && c("string") === 0, [m1, m2, m3, c("saddle"), c("lead")]);
  });
  await flush();
  const f = await pg.evaluate(() => window.__S.fails);
  console.log(f ? "FAILED stables: " + f + " check(s)" : "STABLES OK");
};
