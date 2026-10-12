// @ci integration suite=world timeout=600
// Wild mobs live in the world (js/wildlife.js, idea-037): chunks roll their animals once by habitat (old saves too), a chunk that unloads
// keeps its wild mobs (back on the same spot within a game hour, nearby after that, an undead mob on open ground gone after daylight),
// quitting keeps every loaded wild mob (no 120 cap), wild animals breed on their own, and fed pigs breed.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/wild test/wild-mobs.js
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  const step = (n, dt = 0.05) => pg.evaluate(async ([n, dt]) => { for (let i = 0; i < n; i++) { BF.sky.update(dt); BF.mobs.update(dt); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); } }, [n, dt]);
  const goTo = async (x, z, wait = 7000) => { await pg.evaluate(([x, z]) => BF.player.spawn(x + 0.5, BF.worldgen.heightAt(x, z) + 2, z + 0.5), [x, z]); await pg.waitForTimeout(wait); };

  // ---- first generation: every loaded chunk rolls once, by habitat
  await pg.waitForTimeout(4000);
  const gen = await pg.evaluate(() => {
    const W = BF.world, L = BF.wildlife;
    const keys = [...W.chunks.keys()], rolled = keys.filter(k => L.isRolled(k)).length;
    const rolls = L.log.filter(e => e.kind === "rolled");
    const NONE = /Desert|Ocean|Beach|River|Swamp|Jungle|Badlands|Peaks|Mushroom|Shore/;
    const animals = BF.mobs.list.filter(m => BF.mobs.passiveTypes.includes(m.type) && BF.mobs.isWild(m));
    const onGrass = animals.filter(m => W.getBlock(Math.floor(m.position.x), Math.floor(m.position.y) - 1, Math.floor(m.position.z)) === BF.B.grass).length;
    return { chunks: keys.length, rolled, rolls: rolls.length, badBiome: rolls.filter(e => NONE.test(e.biome)).map(e => e.biome), biomes: [...new Set(rolls.map(e => e.biome))], animals: animals.length, onGrass };
  });
  ok("every loaded chunk had its first-generation roll", gen.rolled >= gen.chunks - 4, gen);
  ok("animals were placed by habitat, never in desert, ocean, beach or peaks", gen.rolls > 0 && gen.badBiome.length === 0, { rolls: gen.rolls, biomes: gen.biomes, bad: gen.badBiome });
  ok("first-generation animals stand on grass", gen.animals > 0 && gen.onGrass >= gen.animals * 0.8, gen);
  const reroll = await pg.evaluate(() => { const n = BF.wildlife.log.filter(e => e.kind === "rolled").length; for (let i = 0; i < 40; i++) BF.mobs.update(0.05); return [n, BF.wildlife.log.filter(e => e.kind === "rolled").length]; });
  ok("a chunk rolls only once", reroll[0] === reroll[1], reroll);

  // ---- chunk unload and reload, away from villages
  const Q = await pg.evaluate(() => {
    for (let x = 3000; x < 9000; x += 400) { const vs = (BF.worldgen.villagesNear(x, 0, 700) || []).filter(v => v.minX != null); if (!vs.some(v => Math.hypot(v.x - x, v.z) < 600)) return [x, 0]; }
    return [3000, 0];
  });
  await goTo(Q[0], Q[1], 9000);
  const placed = await pg.evaluate(([qx, qz]) => {
    BF.mobs.spawning = false;
    BF.sky.day = 4; BF.sky.setTime(0.8);
    for (const m of BF.mobs.list.slice()) if (m.hostile) m.dead = true;
    const put = (type, dx, dz, tag) => {
      const y = BF.worldgen.heightAt(qx + dx, qz + dz) + 1, at = BF.mobs.findStand(qx + dx, y, qz + dz, type);
      const m = at && BF.mobs.spawn(type, at[0], at[1], at[2]);
      if (m) m.tag = tag;
      return m ? [+m.position.x.toFixed(2), +m.position.y.toFixed(2), +m.position.z.toFixed(2)] : null;
    };
    const out = { cow: put("cow", 6, 4, "cow"), creeper: put("creeper", -5, 3, "creeper"), zombie: put("zombie", 3, -6, "zombie") };
    for (let i = 0; i < 3; i++) BF.mobs.update(0.05);
    return out;
  }, Q);
  ok("test mobs placed", placed.cow && placed.creeper && placed.zombie, placed);
  const tagged = () => pg.evaluate(() => { const o = {}; for (const m of BF.mobs.list) if (m.tag && !m.dead && !m.removed) o[m.tag] = [+m.position.x.toFixed(2), +m.position.y.toFixed(2), +m.position.z.toFixed(2)]; return o; });
  const leave = async () => {
    await goTo(Q[0] + 1600, Q[1], 2000);
    await pg.waitForFunction(q => !BF.world.isLoaded(q[0], q[1]), Q, { timeout: 60000 }).catch(() => {});
    return pg.evaluate(q => { const k = Math.floor(q[0] / 16) + "," + Math.floor(q[1] / 16), all = [...BF.wildlife.stored().values()].flat(); const at = {}; for (const e of all) if (e.snap.s.tag) at[e.snap.s.tag] = e.snap.p; return { unloaded: !BF.world.isLoaded(q[0], q[1]), tags: Object.keys(at).sort(), at, open: all.filter(e => e.snap.s.tag === "zombie").map(e => !!e.open) }; }, Q);
  };
  // back to Q with the mobs standing still (only js/wildlife.js runs), so what comes back is read before anything walks
  const back = async (hours) => {
    await pg.evaluate(h => {
      const t = BF.sky.day + BF.sky.time + h / 24; BF.sky.day = Math.floor(t); BF.sky.setTime(t - Math.floor(t));
      window.__upd = BF.mobs.update; BF.mobs.update = dt => BF.wildlife.update(dt);
    }, hours);
    await goTo(Q[0], Q[1], 9000);
    const got = await tagged();
    await pg.evaluate(() => { BF.mobs.update = window.__upd; });
    return got;
  };
  const d2 = (a, b) => a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : Infinity;
  let s = await leave();
  ok("the chunk unloaded and stored its wild mobs", s.unloaded && s.tags.join() === "cow,creeper,zombie", s);
  let t = await back(0.5);
  ok("back within a game hour: every mob on the spot where it was stored", d2(t.cow, s.at.cow) < 0.6 && d2(t.creeper, s.at.creeper) < 0.6 && d2(t.zombie, s.at.zombie) < 0.6, { stored: s.at, t });
  s = await leave();
  t = await back(3);
  ok("back after 3 game hours: still there, within 8 blocks", t.cow && t.creeper && t.zombie && d2(t.cow, s.at.cow) <= 8.8 && d2(t.creeper, s.at.creeper) <= 8.8 && d2(t.zombie, s.at.zombie) <= 8.8, { stored: s.at, t });
  s = await leave();
  ok("stored again before the day away", s.tags.join() === "cow,creeper,zombie", s);
  t = await back(24);
  ok("after a day away: the zombie on open ground burned, the creeper is back", s.open[0] === true ? !t.zombie && !!t.creeper && !!t.cow : !!t.creeper, { open: s.open, t });

  // ---- quit and rejoin with more than 120 wild mobs loaded
  const id = await pg.evaluate(async () => (await BF.save.create({ name: "wild", seed: 1337, gameMode: "creative" })).id);
  await pg.waitForTimeout(8000);
  const before = await pg.evaluate(async () => {
    BF.mobs.spawning = false;
    const p = BF.player.position;
    let n = 0;
    for (let i = 0; i < 400 && n < 150; i++) {
      const x = Math.floor(p.x) + ((i * 7) % 60) - 30, z = Math.floor(p.z) + Math.floor(i / 9) % 60 - 30, at = BF.mobs.findStand(x, BF.worldgen.heightAt(x, z) + 1, z, "chicken");
      if (!at) continue;
      const m = BF.mobs.spawn("chicken", at[0], at[1], at[2]); m.tag = "q" + n++;
    }
    for (let i = 0; i < 3; i++) BF.mobs.update(0.05);
    const wild = BF.mobs.list.filter(m => BF.mobs.isWild(m)).length;
    await BF.save.saveNow();
    return { tagged: n, wild };
  });
  await pg.reload();
  await pg.waitForTimeout(5000);
  await pg.evaluate(async id => { await BF.save.load(id); BF.mobs.spawning = false; }, id);
  await pg.waitForTimeout(9000);
  await step(4);
  const after = await pg.evaluate(() => ({ tagged: BF.mobs.list.filter(m => m.tag && /^q/.test(m.tag) && !m.dead).length, wild: BF.mobs.list.filter(m => BF.mobs.isWild(m)).length }));
  ok("quit and rejoin: all " + before.wild + " wild mobs come back (more than 120)", before.wild > 120 && after.tagged === before.tagged && after.wild >= before.wild, { before, after });

  // ---- an old save (no wildlife data): its chunks roll once
  await pg.evaluate(async id => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open("blockfield", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const t = db.transaction(["data"], "readwrite"), st = t.objectStore("data"), g = st.get(id); g.onsuccess = () => { const d = g.result; delete d.wildlife; delete d.mobs; st.put(d, id); }; t.oncomplete = res; t.onerror = () => rej(t.error); });
    BF.mobs.spawning = true;
    await BF.save.load(id);
  }, id);
  await pg.waitForTimeout(9000);
  const old = await pg.evaluate(() => { const keys = [...BF.world.chunks.keys()]; return { chunks: keys.length, rolled: keys.filter(k => BF.wildlife.isRolled(k)).length, animals: BF.mobs.list.filter(m => BF.mobs.passiveTypes.includes(m.type) && BF.mobs.isWild(m)).length }; });
  ok("an old save's chunks get their one-time roll", old.rolled >= old.chunks - 4 && old.animals > 0, old);
  await pg.evaluate(id => BF.save.remove(id), id);

  // ---- breeding: two wild cows on grass (chance raised so it happens now), crowded herds don't, fed pigs breed
  const spot = await pg.evaluate(() => {
    const p = BF.player.position, W = BF.world;
    for (let r = 0; r < 60; r++) for (let a = 0; a < 16; a++) {
      const x = Math.floor(p.x + Math.cos(a / 16 * 6.283) * r), z = Math.floor(p.z + Math.sin(a / 16 * 6.283) * r), y = W.heightAt(x, z);
      let flat = true;
      for (let dx = -3; dx <= 3 && flat; dx++) for (let dz = -3; dz <= 3 && flat; dz++) if (W.heightAt(x + dx, z + dz) !== y || W.getBlock(x + dx, y, z + dz) !== BF.B.grass || W.getBlock(x + dx, y + 1, z + dz) !== 0) flat = false;
      if (flat) return [x, y + 1, z];
    }
    return null;
  });
  ok("found flat grass for breeding", !!spot, spot);
  if (spot) {
    const br = await pg.evaluate(async ([x, y, z]) => {
      const L = BF.mobs.list;
      // by day with no monsters about: a young one killed or chased off at night isn't a breeding failure
      const calm = () => { if (BF.sky.time > 0.4) BF.sky.setTime(0.1); for (const m of L.slice()) if (m.hostile && Math.hypot(m.position.x - x, m.position.z - z) < 48) m.dead = true; };
      for (const m of L.slice()) if (BF.mobs.isWild(m) && Math.hypot(m.position.x - x, m.position.z - z) < 40) m.dead = true;
      calm();
      for (let i = 0; i < 30; i++) BF.mobs.update(0.05);
      BF.wildlife.tune.pairP = 1;
      const a = BF.mobs.spawn("cow", x + 0.5, y, z + 0.5), b = BF.mobs.spawn("cow", x + 2.5, y, z + 0.5);
      for (const m of [a, b]) { m.ai.t = 999; m.wildB = { next: 1e9 }; }
      for (let i = 0; i < 40; i++) BF.mobs.update(0.05);   // landed on the grass before their daily roll
      for (const m of [a, b]) m.wildB = { next: 0 };
      for (let i = 0; i < 1200; i++) { BF.sky.update(0.05); BF.mobs.update(0.05); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); }
      const calves = L.filter(m => m.type === "cow" && !m.dead && m.cow && m.cow.growAt != null && Math.hypot(m.position.x - x, m.position.z - z) < 40).length;
      const pairs = (BF.wildlife.log || []).filter(e => e.kind === "wildPair" && e.type === "cow").length, cows = [a, b].map(m => [m.dead ? "dead" : "", m.cow && m.cow.fed, +m.position.x.toFixed(1), +m.position.y.toFixed(1), +m.position.z.toFixed(1)]);
      // a crowd: 7 cows together never pair up on their own
      for (const m of L.slice()) if (m.type === "cow") m.dead = true;
      for (let i = 0; i < 30; i++) BF.mobs.update(0.05);
      const crowd = [];
      for (let i = 0; i < 7; i++) { const m = BF.mobs.spawn("cow", x + 0.5 + (i % 3), y, z + 0.5 + Math.floor(i / 3)); m.wildB = { next: 0 }; crowd.push(m); }
      for (let i = 0; i < 100; i++) BF.mobs.update(0.05);
      const willing = crowd.filter(m => m.cow && m.cow.fed != null).length;
      for (const m of crowd) m.dead = true;
      for (let i = 0; i < 30; i++) BF.mobs.update(0.05);
      // two wild horses breed on their own too, and their foal is wild
      calm();
      const h1 = BF.horses.spawn(x + 0.5, y, z + 0.5), h2 = BF.horses.spawn(x + 2.5, y, z + 0.5);
      for (const m of [h1, h2]) { m.ai.t = 999; m.wildB = { next: 1e9 }; }
      for (let i = 0; i < 40; i++) BF.mobs.update(0.05);
      for (const m of [h1, h2]) m.wildB = { next: 0 };
      for (let i = 0; i < 1200; i++) { BF.sky.update(0.05); BF.mobs.update(0.05); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); }
      const foals = L.filter(m => m.type === "horse" && !m.dead && m.horse && m.horse.growAt != null && Math.hypot(m.position.x - x, m.position.z - z) < 40).map(m => ({ tamed: m.horse.tamed, owner: m.horse.owner }));
      for (const m of L.slice()) if (m.type === "horse") m.dead = true;
      BF.wildlife.tune.pairP = 0.0513;
      // fed pigs
      const p1 = BF.mobs.spawn("pig", x + 0.5, y, z + 0.5), p2 = BF.mobs.spawn("pig", x + 2.5, y, z + 1.5);
      const fedOk = BF.pigs.feed(p1, "player") && BF.pigs.feed(p2, "player");
      for (let i = 0; i < 1200; i++) { BF.sky.update(0.05); BF.mobs.update(0.05); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); }
      const piglets = L.filter(m => m.type === "pig" && !m.dead && m.pig && m.pig.growAt != null).length;
      return { calves, pairs, cows, foals, willing, fedOk, piglets, pigScale: L.filter(m => m.type === "pig" && m.piglet).map(m => +m.model.scale.x.toFixed(2)) };
    }, spot);
    ok("two wild cows on grass breed on their own", br.calves >= 1, br);
    ok("two wild horses breed on their own and the foal is wild", br.foals.length >= 1 && br.foals.every(f => !f.tamed && !f.owner), br.foals);
    ok("no wild breeding with 6 or more of a kind within 24 blocks", br.willing === 0, br);
    ok("fed pigs breed and a piglet appears (smaller)", br.fedOk && br.piglets >= 1 && br.pigScale.every(s => s < 0.9), br);
  }
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
