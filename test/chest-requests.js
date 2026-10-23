// @ci integration suite=items timeout=300
// Chests, furnaces and item pickup as requests (spec r15-22): NODE_PATH=$(npm root -g) node test/run.js /tmp/cr test/chest-requests.js
// Requests sent in one tick, in the opposite of requester order, apply in order (lower villager id first; the player after villagers
// for chests, before them for pickups), each seeing what the ones before it left. In every case the items are conserved.
// - chest takes: two villagers and the player ask for 6 coal each from a chest of 10: 6, 4, then the player is refused;
// - chest puts: two villagers put a stack into a chest with one free slot: the first fills it, the second keeps its stack;
// - a chest broken with a request in flight: the request is refused and the contents lie on the ground as drops;
// - furnace load race: two villagers load different inputs into one furnace: the first loads (with the 1 coal its 5 ore need), the second is refused;
// - furnace empty race: two villagers empty one furnace: the first gets the output and fuel, the second nothing;
// - pickup races: a villager with room for 3 takes 3 of 10, the next takes the 7 left; the player gets an item before a villager.
module.exports = async (pg, out) => {
  await pg.evaluate(() => { document.getElementById("view").requestPointerLock = null; BF.player.start(); });
  await pg.waitForTimeout(3000);
  const fails = [];
  const check = (ok, what, info) => { console.log((ok ? "ok   " : "FAIL ") + what + (info !== undefined ? "  " + JSON.stringify(info) : "")); if (!ok) fails.push(what); };

  const r = await pg.evaluate(() => {
    BF.state.paused = true;   // ticks by hand
    const W = BF.world, I = BF.I, T = BF.trades.inv, INV = BF.inventory, R = BF.req, FU = BF.furnaceUse, P = BF.player.position;
    const step = () => BF.simStep(BF.warp.TICK);
    const res = {};
    // a spot on the ground near the player, out of the player's pickup reach
    const spot = dx => {
      const x = Math.floor(P.x) + dx, z = Math.floor(P.z) + 6;
      let y = Math.floor(P.y) + 8; while (y > P.y - 20 && !BF.SOLID[W.getBlock(x, y - 1, z)]) y--;
      W.setBlock(x, y + 1, z, 0); W.setBlock(x, y + 2, z, 0);
      return { x, y, z };
    };
    const mob = (p, dx) => { const m = BF.mobs.spawn("villager", p.x + dx + 0.5, p.y, p.z + 1.5); m.inv = T.create(); m.ai = m.ai || {}; return m; };
    const n = s => +String(s).slice(1);
    const playerCount = id => INV.count(id);
    const dropCount = id => BF.drops.list.filter(d => d.id === id).reduce((a, d) => a + d.count, 0);

    // ---- chest takes
    {
      const p = spot(4);
      W.setBlock(p.x, p.y, p.z, BF.chestId ? BF.chestId(0) : BF.B.chest);
      INV.chestAdd(p.x, p.y, p.z, I.coal, 10);
      let a = mob(p, 1), b = mob(p, -1);
      if (n(a.id) > n(b.id)) [a, b] = [b, a];
      const pBefore = playerCount(I.coal), total = () => INV.chestState(p.x, p.y, p.z).slots.filter(s => s && s.id === I.coal).reduce((x, s) => x + s.count, 0) + T.count(a.inv, I.coal) + T.count(b.inv, I.coal) + playerCount(I.coal);
      const t0 = total(), key = p.x + "," + p.y + "," + p.z, got = {};
      // sent in the opposite of the order they apply in
      R.send("chest", key, { take: [{ id: I.coal, n: 6 }] }, "player").then(x => { got.player = x; });
      R.send("chest", key, { take: [{ id: I.coal, n: 6 }] }, b).then(x => { got.b = x; });
      R.send("chest", key, { take: [{ id: I.coal, n: 6 }] }, a).then(x => { got.a = x; });
      step();
      res.take = { a: T.count(a.inv, I.coal), b: T.count(b.inv, I.coal), player: playerCount(I.coal) - pBefore, playerResult: got.player, conserved: total() === t0, aRes: got.a, bRes: got.b };
      // ---- chest puts: one free slot left
      const c = INV.chestState(p.x, p.y, p.z);
      for (let i = 0; i < c.slots.length; i++) c.slots[i] = null;
      for (let i = 0; i < c.slots.length - 1; i++) c.slots[i] = { id: I.dirt, count: 64 };
      T.add(a.inv, I.cobblestone, 64); T.add(b.inv, I.cobblestone, 64);
      const cob = () => c.slots.filter(s => s && s.id === I.cobblestone).reduce((x, s) => x + s.count, 0) + T.count(a.inv, I.cobblestone) + T.count(b.inv, I.cobblestone);
      const c0 = cob(), got2 = {};
      R.send("chest", key, { put: [{ id: I.cobblestone, n: 64 }] }, b).then(x => { got2.b = x; });
      R.send("chest", key, { put: [{ id: I.cobblestone, n: 64 }] }, a).then(x => { got2.a = x; });
      step();
      res.put = { aLeft: T.count(a.inv, I.cobblestone), bLeft: T.count(b.inv, I.cobblestone), inChest: c.slots.filter(s => s && s.id === I.cobblestone).reduce((x, s) => x + s.count, 0), conserved: cob() === c0, bWhy: got2.b && got2.b.why };
      // ---- broken while a request is in flight
      for (let i = 0; i < c.slots.length; i++) c.slots[i] = null;
      INV.chestAdd(p.x, p.y, p.z, I.stick, 9);
      const sticksOnGround = dropCount(I.stick), got3 = {};
      R.send("chest", key, { take: [{ id: I.stick, n: 9 }] }, a).then(x => { got3.a = x; });
      W.setBlock(p.x, p.y, p.z, 0);   // broken between the ask and the apply: it spills
      step();
      res.broken = { why: got3.a && got3.a.why, inInv: T.count(a.inv, I.stick), dropped: dropCount(I.stick) - sticksOnGround };
      BF.drops.list.filter(d => d.id === I.stick || d.id === I.dirt).forEach(d => BF.drops.remove(d));
      BF.mobs.discard(a); BF.mobs.discard(b);
    }

    // ---- furnace load race and empty race
    {
      const p = spot(-4), key = p.x + "," + p.y + "," + p.z;
      W.setBlock(p.x, p.y, p.z, BF.B.furnace); BF.emit("blockPlaced", p.x, p.y, p.z, BF.B.furnace);
      let a = mob(p, 1), b = mob(p, -1);
      if (n(a.id) > n(b.id)) [a, b] = [b, a];
      const raw = I.raw_iron != null ? I.raw_iron : I.iron_ore;
      T.add(a.inv, raw, 5); T.add(a.inv, I.coal, 2); T.add(b.inv, I.egg, 5); T.add(b.inv, I.coal, 2);
      const st = () => INV.furnaceState(p.x, p.y, p.z);
      const sumAll = id => T.count(a.inv, id) + T.count(b.inv, id) + (st() ? st().slots.filter(s => s && s.id === id).reduce((x, s) => x + s.count, 0) : 0);
      const ids = [raw, I.egg, I.coal], before = ids.map(sumAll);
      const ja = { furnace: { x: p.x, y: p.y, z: p.z }, rawId: raw, outId: I.iron_ingot }, jb = { furnace: { x: p.x, y: p.y, z: p.z }, rawId: I.egg, outId: I.cooked_egg != null ? I.cooked_egg : I.iron_ingot };
      const sendB = FU.load(b, jb, 5), sendA = FU.load(a, ja, 5);   // both see a free furnace
      step();
      const nb = FU.load(b, jb, 5), na = FU.load(a, ja, 5);
      res.load = { sent: [sendA, sendB], na, nb, input: st() && st().slots[0], fuel: st() && st().slots[1], aLoaded: ja.loaded, aOwnFuel: ja.ownFuel, burning: !!(st() && st().burn > 0),
        conserved: ids.map(sumAll).every((v, i) => v + (ids[i] === I.coal && st() && st().burn > 0 ? 1 : 0) === before[i]) };   // a coal already burning
      // the empty race: output and fuel in, both ask to empty
      const f = st();
      f.slots[0] = null; f.slots[2] = { id: I.iron_ingot, count: 5 }; f.slots[1] = { id: I.coal, count: 3 }; f.burn = 0;
      const ing = () => T.count(a.inv, I.iron_ingot) + T.count(b.inv, I.iron_ingot) + (f.slots[2] && f.slots[2].id === I.iron_ingot ? f.slots[2].count : 0);
      const coal = () => sumAll(I.coal), i0 = ing(), k0 = coal(), got = {};
      FU.empty(b, jb, false, g => { got.b = g; });
      FU.empty(a, ja, false, g => { got.a = g; });
      step();
      res.empty = { a: got.a, b: got.b, aIngots: T.count(a.inv, I.iron_ingot), bIngots: T.count(b.inv, I.iron_ingot), conserved: ing() === i0 && coal() === k0 };
      W.setBlock(p.x, p.y, p.z, 0);
      BF.mobs.discard(a); BF.mobs.discard(b);
    }

    // ---- pickup races
    {
      const p = spot(8);
      let a = mob(p, 1), b = mob(p, -1);
      if (n(a.id) > n(b.id)) [a, b] = [b, a];
      for (let i = 0; i < a.inv.length; i++) a.inv[i] = { id: I.dirt, count: 64 };
      a.inv[0] = { id: I.stick, count: 61 };   // room for 3 sticks
      const d = BF.drops.spawn(I.stick, 10, p.x + 0.5, p.y + 0.3, p.z + 0.5, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 99 });
      const got = {};
      BF.drops.ask(d, b).then(x => { got.b = x; });
      BF.drops.ask(d, a).then(x => { got.a = x; });
      step();
      res.pick = { a: T.count(a.inv, I.stick) - 61, b: T.count(b.inv, I.stick), gone: !BF.drops.list.includes(d), aRes: got.a, bRes: got.b };
      // the player before a villager
      const pBefore = playerCount(I.apple), d2 = BF.drops.spawn(I.apple, 5, p.x + 0.5, p.y + 0.3, p.z + 0.5, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 99 });
      const got2 = {};
      BF.drops.ask(d2, b).then(x => { got2.b = x; });
      BF.drops.ask(d2, "player").then(x => { got2.player = x; });
      step();
      res.player = { player: playerCount(I.apple) - pBefore, b: T.count(b.inv, I.apple), bWhy: got2.b && got2.b.why, gone: !BF.drops.list.includes(d2) };
      INV.remove(I.apple, 5);
      BF.mobs.discard(a); BF.mobs.discard(b);
    }
    res.byKind = R.stats().byKind;
    BF.state.paused = false;
    return res;
  });
  console.log(JSON.stringify(r));
  const t = r.take;
  check(t.a === 6 && t.b === 4 && t.player === 0, "chest takes in requester order: lower id 6, next 4, the player none", t);
  check(t.playerResult && t.playerResult.ok === false, "the player's take is refused when nothing is left", t.playerResult);
  check(t.conserved, "chest takes conserve the coal");
  check(r.put.aLeft === 0 && r.put.bLeft === 64 && r.put.inChest === 64, "chest puts: the first fills the last slot, the second keeps its stack", r.put);
  check(r.put.conserved, "chest puts conserve the cobblestone");
  check(r.broken.why === "gone" && r.broken.inInv === 0 && r.broken.dropped === 9, "a chest broken in flight: refused, its 9 sticks on the ground", r.broken);
  check(r.load.sent[0] === null && r.load.sent[1] === null, "furnace loads wait for their request", r.load.sent);
  check(r.load.na === 5 && r.load.nb === 0 && r.load.aLoaded === 5 && r.load.input && r.load.input.count === 5, "furnace load race: the lower id loads, the other is refused", r.load);
  check(r.load.aOwnFuel === 1 && (r.load.fuel ? r.load.fuel.count : 0) + (r.load.burning ? 1 : 0) === 1, "the load adds the loader's fuel (and the furnace lights in the same tick's block step)", r.load);
  check(r.load.conserved, "furnace loads conserve items");
  check(r.empty.aIngots === 5 && r.empty.bIngots === 0 && r.empty.conserved, "furnace empty race: the first gets the ingots, items conserved", r.empty);
  check(r.pick.a === 3 && r.pick.b === 7 && r.pick.gone, "pickup race: lower id takes what fits (3), the next the 7 left", r.pick);
  check(r.player.player === 5 && r.player.b === 0 && r.player.bWhy === "gone" && r.player.gone, "pickup: the player before a villager", r.player);
  if (fails.length) { console.log("FAILED: " + fails.length); process.exitCode = 1; }
};
