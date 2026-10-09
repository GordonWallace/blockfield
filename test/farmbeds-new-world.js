// @ci integration suite=farming
// A new world starts with no farm-bed projects (bug-038): projects saved for villages of the last world loaded, not yet
// visited that session, used to carry over into a world created next and be saved into it.
// Usage: node test/run.js /tmp/fnw test/farmbeds-new-world.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const openDb = () => new Promise(r => { const q = indexedDB.open("blockfield", 1); q.onsuccess = () => r(q.result); });
    const getData = async id => { const db = await openDb(); const d = await new Promise(r => { const g = db.transaction(["data"], "readonly").objectStore("data").get(id); g.onsuccess = () => r(g.result); }); db.close(); return d; };
    const putData = async (id, d) => { const db = await openDb(); await new Promise(r => { const t = db.transaction(["data"], "readwrite"); t.objectStore("data").put(d, id); t.oncomplete = r; }); db.close(); };
    const projects = () => Object.keys(BF.villageLife.exportAll({})).filter(k => k.startsWith("farmbeds:"));
    BF.player.start();
    // world A, saved with a farm-bed project for a village far from the player
    const A = await BF.save.create({ name: "A", seed: "1337", gameMode: "creative" });
    const proj = { id: "pX", kind: "new", dir: null, L: { x0: 500, z0: 500, x1: 503, z1: 504, y: 70, ax: "x", ch: [501] }, old: null, owner: 3, fails: 0 };
    const data = await getData(A.id);
    data.villagers = Object.assign(BF.mobs.exportVillagers(), { "farmbeds:9999,9999": [proj] });
    await putData(A.id, data);
    await BF.save.load(A.id);
    ok("world A has its saved project after loading", projects().includes("farmbeds:9999,9999"), projects());
    // Save and Quit to Title, then create world B
    BF.save.current = null;
    const B = await BF.save.create({ name: "B", seed: "4242", gameMode: "creative" });
    ok("the new world has no projects from world A", !projects().includes("farmbeds:9999,9999"), projects());
    await BF.save.saveNow();
    const saved = Object.keys((await getData(B.id)).villagers || {}).filter(k => k.startsWith("farmbeds:9999"));
    ok("nothing from world A is saved into the new world", saved.length === 0, saved);
    // loading A again still finds its project
    await BF.save.load(A.id);
    ok("world A keeps its project", projects().includes("farmbeds:9999,9999"), projects());
    await BF.save.remove(A.id); await BF.save.remove(B.id);
    return R;
  });
  for (const l of res.lines) console.log(l);
};
