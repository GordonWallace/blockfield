// @ci baseline
// Farmland hydration (js/farmland.js): water within 3 blocks or rain keeps farmland hydrated; without either it dries out
// between 1 and 3 days later; bare dehydrated farmland reverts to dirt between 1 and 14 days after drying, a crop keeps it;
// crops grow at a third of the speed on dehydrated farmland; hoes till dehydrated farmland away from water; clocks are saved.
// Usage: node test/run.js /tmp/fl test/farmland-actions.js
module.exports = async (pg) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const load = async (x, z) => {
      BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
      for (let i = 0; i < 400 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
      for (let i = 0; i < 300; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
    };
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "creative" });
    BF.mobs.spawning = false;
    const B = BF.B, W = BF.world, F = BF.farmland, WET = B.farmland, DRY = B.farmland_dry;
    ok("dehydrated farmland block exists", DRY != null && DRY !== WET && BF.blocks[DRY].drop === BF.blocks[WET].drop);
    BF.weather.set("clear", 1e7); BF.weather.intensity = 0;
    BF.sky.day = 10; BF.sky.time = 0.3;
    const day = () => BF.sky.day + BF.sky.time;
    const setDay = d => { BF.sky.day = Math.floor(d); BF.sky.time = d - Math.floor(d); };
    // a flat stone pad of 40 x 40 well above the ground, so no natural water is near; covered later where needed
    const px = 8, pz = 8;
    await load(px, pz);
    const y = Math.max(...[0, 10, 20, 30, 39].flatMap(a => [0, 39].map(b => BF.worldgen.heightAt(px + a, pz + b)))) + 6;
    for (let x = px - 2; x < px + 42; x++) for (let z = pz - 2; z < pz + 42; z++) { W.setBlock(x, y - 1, z, B.stone); W.setBlock(x, y, z, B.dirt); for (let yy = y + 1; yy < y + 4; yy++) W.setBlock(x, yy, z, 0); }
    const put = (x, z, id) => W.setBlock(px + x, y, pz + z, id);
    const at = (x, z) => W.getBlock(px + x, y, pz + z);
    const chk = (x, z) => F.check(px + x, y, pz + z);
    const stamp = (x, z, d) => F.setStamp(px + x, y, pz + z, d);
    ok("open rain sky over the pad", BF.weather.precipAt(px, pz, y + 1) === 1, BF.weather.precipAt(px, pz, y + 1));

    // --- tilling: hydrated next to water, dehydrated away from it
    put(0, 0, B.water);
    ok("tilling 3 blocks from water makes hydrated farmland", F.tillId(px + 3, y, pz) === WET);
    ok("tilling 4 blocks from water makes dehydrated farmland", F.tillId(px + 4, y, pz) === DRY);
    ok("diagonal 3 away counts", F.tillId(px + 3, y, pz + 3) === WET);

    // --- water within 3 keeps it hydrated for good
    put(3, 0, WET); put(4, 0, WET);
    stamp(3, 0, day()); stamp(4, 0, day());
    setDay(day() + 5); chk(3, 0); chk(4, 0);
    ok("water 3 blocks away keeps farmland hydrated", at(3, 0) === WET);
    ok("water 4 blocks away: dried after 5 days", at(4, 0) === DRY);
    put(0, 0, B.dirt); put(3, 0, B.dirt); put(4, 0, B.dirt);

    // --- drying: none before day 1, certain by day 3, roughly even between
    const G = [];
    for (let x = 0; x < 40; x += 2) for (let z = 4; z < 24; z += 2) G.push([x, z]);   // 200 cells, none near water
    const d0 = day();
    for (const [x, z] of G) { put(x, z, WET); stamp(x, z, d0); }
    const dried = d => { setDay(d0 + d); for (const [x, z] of G) chk(x, z); return G.filter(([x, z]) => at(x, z) !== WET).length; };   // dried (some of the first to dry may have reverted to dirt by day 3)
    const a1 = dried(0.95), a2 = dried(2), a3 = dried(3.01);
    ok("no farmland dries within the first day", a1 === 0, a1);
    ok("about half has dried by day 2", a2 > 70 && a2 < 130, a2);
    ok("all of it has dried by day 3", a3 === G.length, a3);

    // --- rain or water brings it back
    const rain = (on) => { BF.weather.set(on ? "rain" : "clear", 1e7); BF.weather.intensity = on ? 1 : 0; };
    put(0, 30, DRY); put(2, 30, DRY); W.setBlock(px + 2, y + 3, pz + 30, B.stone);   // the second one has a roof
    rain(true); chk(0, 30); chk(2, 30);
    ok("rain hydrates open farmland", at(0, 30) === WET);
    ok("rain does not reach roofed farmland", at(2, 30) === DRY);
    rain(false);
    put(5, 30, B.water); put(6, 30, DRY); chk(6, 30);
    ok("water placed nearby hydrates dehydrated farmland", at(6, 30) === WET);
    // rain while the block was not looked at (unloaded) counts from the last time it rained
    put(10, 30, WET); stamp(10, 30, day() - 2.9);
    F.lastRain = day() - 0.5;
    chk(10, 30);
    ok("recent rain (while away) keeps it hydrated", at(10, 30) === WET && Math.abs(F.stampOf(px + 10, y, pz + 30) - (day() - 0.5)) < 1e-6);
    F.lastRain = -1e9;
    for (const x of [0, 2, 5, 6, 10]) put(x, 30, B.dirt);
    W.setBlock(px + 2, y + 3, pz + 30, 0);

    // --- reverting to dirt: bare dehydrated farmland only, from day 1, certain by day 14 after drying
    const d1 = day();
    for (const [x, z] of G) { put(x, z, DRY); stamp(x, z, d1); }
    const crop = G.slice(0, 20);
    for (const [x, z] of crop) W.setBlock(px + x, y + 1, pz + z, B.wheat_young);
    const bare = G.slice(20);
    const dirt = d => { setDay(d1 + d); for (const [x, z] of G) chk(x, z); return bare.filter(([x, z]) => at(x, z) === B.dirt).length; };
    const r1 = dirt(0.95), r2 = dirt(7.5), r3 = dirt(14.01);
    ok("no bare dehydrated farmland reverts within a day", r1 === 0, r1);
    ok("about half has reverted after 7.5 days", r2 > 60 && r2 < 120, r2);
    ok("all bare dehydrated farmland is dirt after 14 days", r3 === bare.length, r3);
    ok("dehydrated farmland under a crop does not revert", crop.every(([x, z]) => at(x, z) === DRY));
    W.setBlock(px + crop[0][0], y + 1, pz + crop[0][1], 0); chk(crop[0][0], crop[0][1]);
    ok("once the crop is gone it can revert", at(crop[0][0], crop[0][1]) === B.dirt);

    // --- growth: a third of the speed on dehydrated farmland
    for (const [x, z] of G) { put(x, z, B.dirt); W.setBlock(px + x, y + 1, pz + z, 0); }
    const wetG = G.slice(0, 100), dryG = G.slice(100);
    for (const [x, z] of wetG) { put(x, z, WET); W.setBlock(px + x, y + 1, pz + z, B.wheat_young); }
    for (const [x, z] of dryG) { put(x, z, DRY); W.setBlock(px + x, y + 1, pz + z, B.wheat_young); }
    for (const [x, z] of G) stamp(x, z, day());
    for (let s = 0; s < 240; s++) { BF.warp.advance(1); W.tickSim(); }
    const grownW = wetG.filter(([x, z]) => W.getBlock(px + x, y + 1, pz + z) === B.wheat).length;
    const grownD = dryG.filter(([x, z]) => W.getBlock(px + x, y + 1, pz + z) === B.wheat).length;
    ok("crops on hydrated farmland grow at the usual rate (~63 of 100 in 240 s)", grownW > 45 && grownW < 80, grownW);
    ok("crops on dehydrated farmland grow at about a third (~28 of 100)", grownD > 12 && grownD < 44 && grownD < grownW, grownD);

    // --- save round trip
    put(30, 30, DRY); stamp(30, 30, 12.25);
    const saved = JSON.parse(JSON.stringify(F.serialize()));
    F.deserialize(saved.slice(0, 1));
    ok("deserialize replaces stamps", F.stampOf(px + 30, y, pz + 30) == null);
    F.deserialize(saved);
    ok("stamps survive a save", F.stampOf(px + 30, y, pz + 30) === 12.25);
    F.deserialize(undefined);
    ok("old saves load without stamps", F.stampOf(px + 30, y, pz + 30) == null);
    return R;
  });
  for (const l of res.lines) console.log(l);
};
