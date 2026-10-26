// @ci integration suite=village timeout=900 args=0.2 hosts=worker,server
// Stable entity ids (spec r15-13): after a game day on seed 3 no mob or village record holds another mob, village record or boat
// directly (only ids); a save and reload brings every villager back under the same id (same name and slot); a villager killed and
// its slot respawned gets a new id under the same slot key. Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/ids test/entity-ids.js [days] [--host page|worker|server]
module.exports = async (pg) => {
  const days = +(process.argv[4] || 1);
  const lib = require('./lib');
  const ok = (n, c, extra) => console.log((c ? "PASS " : "FAIL ") + n + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  const setup = await pg.evaluate(async () => {
    BF.player.start();
    const meta = await BF.save.create({ name: "ids", seed: "3", gameMode: "creative", villages: 10 });
    return { id: meta.id };
  });
  // helpers where the simulation is (spec r15-43; again after the reload, which may start a new thread there): a fixed-step run with
  // the village kept loaded, and the reference audit
  const helpers = () => lib.sim(pg, () => {
    const step = (h = 0.05) => { BF.warp.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); if (BF.boats) BF.boats.update(h); BF.world.tickSim(); };
    globalThis.IDT = {
      run: sec => { for (let t = 0; t < sec; t += 0.05) step(); },
      load: async (x, z) => {
        BF.player.teleport(x + 0.5, BF.worldgen.heightAt(Math.floor(x), Math.floor(z)) + 2, z + 0.5);
        for (let i = 0; i < 400 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); }
        for (let i = 0; i < 300; i++) { BF.world.update(x, z, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0) break; }
      },
      // every own enumerable field of every mob and village record, walked through plain objects, arrays, Maps (keys too) and Sets:
      // paths that reach a mob, a village record or a boat other than the one walked from
      audit() {
        const mobs = new Set(BF.mobs.list), recs = new Set(BF.mobs.villages.values()), boats = new Set(BF.boats ? BF.boats.list || [] : []);
        const kind = o => mobs.has(o) || (o.def && o.position && o.type) ? "mob" : recs.has(o) ? "village" : boats.has(o) ? "boat" : null;
        const skip = o => o.isObject3D || o.isMaterial || o.isVector3 || o.isBufferGeometry || o.isColor || o.isTexture || o.isQuaternion || o.isEuler || o.isMatrix4;
        // (a mob's link caches, js/ids.js r15-61: the last answer of a lookup by id, never saved, sent to a worker or hashed)
        const caches = new Set(BF.ids.CACHE_FIELDS || []);
        const found = new Map();
        const walk = (root, label) => {
          const seen = new Set();
          const visit = (v, path, d) => {
            if (!v || typeof v !== "object" || skip(v)) return;
            if (v !== root) { const k = kind(v); if (k) { const p = label + path.replace(/\[\d+\]/g, "[]") + " -> " + k; found.set(p, (found.get(p) || 0) + 1); return; } }
            if (seen.has(v) || d > 8) return;
            seen.add(v);
            if (v instanceof Map) { for (const [k, x] of v) { visit(k, path + "{key}", d + 1); visit(x, path + "{}", d + 1); } return; }
            if (v instanceof Set) { for (const x of v) visit(x, path + "<>", d + 1); return; }
            if (Array.isArray(v)) { v.forEach((x, i) => visit(x, path + "[" + i + "]", d + 1)); return; }
            for (const k of Object.keys(v)) if (!caches.has(k)) visit(v[k], path + "." + k, d + 1);
          };
          visit(root, "", 0);
        };
        for (const m of mobs) walk(m, m.type);
        for (const r of recs) walk(r, "village");
        for (const b of boats) walk(b, "boat");
        return [...found];
      },
      roster: key => BF.mobs.list.filter(m => m.type === "villager" && !m.dead && !m.removed && m.villageId === key)
        .map(m => ({ id: m.id, name: BF.vlog.nameOf(m), slot: m.slotKey, ok: BF.ids.get(m.id) === m })),
    };
  });
  await lib.simReady(pg);
  await helpers();
  const s1 = await lib.sim(pg, async days => {
    BF.state.paused = true;
    // the village nearest the spawn (as BFT.village(): test/bft.js is the page's)
    const s = BF.spawnPoint || BF.player.position, v = BF.worldgen.villagesNear(s.x, s.z, 3000).sort((a, b) => BF.planet.distance(s, a) - BF.planet.distance(s, b))[0], key = Math.round(v.x) + "," + Math.round(v.z), X = Math.round(v.x) + 4, Z = Math.round(v.z) + 4;
    BF.sky.setTime(0.1);
    await IDT.load(X, Z);
    const t0 = performance.now();
    for (let k = 0; k < days * 1200 / 2; k++) { BF.world.update(X, Z, 8); IDT.run(2); if (k % 10 === 0) await new Promise(r => setTimeout(r, 0)); }
    const rec = BF.mobs.villages.get(key);
    const types = {};
    for (const m of BF.mobs.list) types[m.type] = (types[m.type] || 0) + 1;
    return { key, X, Z, secs: Math.round((performance.now() - t0) / 1000), types, members: rec ? rec.members.length : 0, audit: IDT.audit(),
      roster: IDT.roster(key), noIds: BF.mobs.list.filter(m => typeof m.id !== "string" || !/^e\d+$/.test(m.id)).length,
      dup: BF.mobs.list.length - new Set(BF.mobs.list.map(m => m.id)).size, collisions: BF.ids.stats.collisions, lastCollision: BF.ids.stats.last };
  }, days);
  console.log("ran " + days + " game day(s) in " + s1.secs + " s; mobs " + JSON.stringify(s1.types) + "; village members " + s1.members);
  ok("every mob has an e<n> id", s1.noIds === 0, s1.noIds);
  ok("no two mobs share an id", s1.dup === 0, s1.dup);
  ok("each id resolves to its mob", s1.roster.length > 0 && s1.roster.every(r => r.ok), s1.roster.filter(r => !r.ok));
  ok("no mob or village record holds another mob, village record or boat (only ids)", s1.audit.length === 0, s1.audit);
  ok("no two places took the same key", s1.collisions === 0, [s1.collisions, s1.lastCollision]);

  // save and reload: the same villagers under the same ids
  await pg.evaluate(async id => { await BF.save.saveNow(); await BF.save.load(id); BF.state.paused = true; }, setup.id);   // (the page pauses too: it sends that on)
  await helpers();
  const s2 = await lib.sim(pg, async o => {
    BF.state.paused = true;
    await IDT.load(o.X, o.Z);
    for (let k = 0; k < 40; k++) { BF.world.update(o.X, o.Z, 8); IDT.run(0.5); await new Promise(r => setTimeout(r, 0)); }
    return { roster: IDT.roster(o.key), audit: IDT.audit() };
  }, { id: setup.id, X: s1.X, Z: s1.Z, key: s1.key });
  const before = new Map(s1.roster.map(r => [r.id, r])), same = s2.roster.filter(r => before.has(r.id) && before.get(r.id).name === r.name && before.get(r.id).slot === r.slot);
  ok("after a reload the villagers are back", s2.roster.length >= s1.roster.length - 2, [s2.roster.length, s1.roster.length]);
  ok("after a reload every id resolves to the same villager (name and slot)", s2.roster.length > 0 && same.length === s2.roster.filter(r => [...before.values()].some(b => b.slot === r.slot)).length,
    s2.roster.filter(r => !same.includes(r)).slice(0, 5));
  ok("after a reload no mob or village record holds another directly", s2.audit.length === 0, s2.audit);

  // kill a villager, then let its slot respawn (a dead slot stays dead in play; the test clears it as a respawn would)
  const s3 = await lib.sim(pg, async o => {
    const rec = BF.mobs.villages.get(o.key);
    const v = BF.mobs.list.find(m => m.type === "villager" && !m.dead && !m.removed && m.villageId === o.key && m.slot && !m.slot.bred);
    if (!v) return { err: "no villager" };
    const id = v.id, slot = v.slotKey, idx = v.slot.idx;
    BF.mobs.hurt(v, 999, "a test");
    IDT.run(3);
    const gone = !BF.ids.live(id);
    rec.dead.delete(idx);
    for (let k = 0; k < 40; k++) { BF.world.update(o.X, o.Z, 8); IDT.run(0.5); await new Promise(r => setTimeout(r, 0)); if (BF.mobs.list.some(m => !m.dead && m.slotKey === slot && m.villageId === o.key)) break; }
    const n = BF.mobs.list.find(m => !m.dead && !m.removed && m.slotKey === slot && m.villageId === o.key);
    return { id, slot, gone, newId: n && n.id, newSlot: n && n.slotKey };
  }, { X: s1.X, Z: s1.Z, key: s1.key });
  if (s3.err) return ok("kill and respawn: " + s3.err, false);
  ok("a killed villager leaves the registry once removed", s3.gone, s3);
  ok("its slot respawns with a new id under the same slot key", !!s3.newId && s3.newId !== s3.id && s3.newSlot === s3.slot, s3);
  await pg.evaluate(id => BF.save.remove(id), setup.id);
};
