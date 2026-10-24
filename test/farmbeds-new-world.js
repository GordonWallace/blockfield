// @ci integration suite=farming hosts=worker,server
// A new world starts with no farm-bed projects (bug-038): projects saved for villages of the last world loaded, not yet
// visited that session, used to carry over into a world created next and be saved into it.
// Usage: node test/run.js /tmp/fnw test/farmbeds-new-world.js [--host page|worker|server]
module.exports = async (pg, out) => {
  // the saves are made, loaded and removed through the page's BF.save (every host); the save data is read and written, and the projects
  // read, where the simulation is (spec r15-43): its storage and its villages
  const lib = require('./lib'), lines = [], ok = (name, cond, extra) => lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
  // (the save data where the simulation keeps it: its IndexedDB, or the world server's files; a world server may play a new world on a new
  // thread, so nothing is kept there between calls)
  const DB = `const openDb = () => new Promise(r => { const q = indexedDB.open("blockfield", 1); q.onsuccess = () => r(q.result); });
    const getData = async id => { const db = await openDb(); const d = await new Promise(r => { const g = db.transaction(["data"], "readonly").objectStore("data").get(id); g.onsuccess = () => r(g.result); }); db.close(); return d; };
    const putData = async (id, d) => { const db = await openDb(); await new Promise(r => { const t = db.transaction(["data"], "readwrite"); t.objectStore("data").put(d, id); t.oncomplete = r; }); db.close(); };`;
  const projects = () => lib.sim(pg, () => Object.keys(BF.villageLife.exportAll({})).filter(k => k.startsWith("farmbeds:")));
  await pg.evaluate(() => BF.player.start());
  // world A, saved with a farm-bed project for a village far from the player
  // both worlds on the boot seed: a page keeps one planet's river network, so other seeds would each be solved again (over a minute)
  const A = await pg.evaluate(() => BF.save.create({ name: "A", seed: "123", gameMode: "creative", villages: 9, gen: 4 }));
  await lib.sim(pg, async ([DB, id]) => {
    const { getData, putData } = new Function(DB + "; return { getData, putData };")();
    const proj = { id: "pX", kind: "new", dir: null, L: { x0: 500, z0: 500, x1: 503, z1: 504, y: 70, ax: "x", ch: [501] }, old: null, owner: 3, fails: 0 };
    const data = await getData(id);
    data.villagers = Object.assign(BF.mobs.exportVillagers(), { "farmbeds:9999,9999": [proj] });
    await putData(id, data);
  }, [DB, A.id]);
  await pg.evaluate(id => BF.save.load(id), A.id);
  let p = await projects();
  ok("world A has its saved project after loading", p.includes("farmbeds:9999,9999"), p);
  // Save and Quit to Title, then create world B
  const B = await pg.evaluate(() => { BF.save.current = null; return BF.save.create({ name: "B", seed: "123", gameMode: "creative", villages: 9, gen: 4 }); });
  p = await projects();
  ok("the new world has no projects from world A", !p.includes("farmbeds:9999,9999"), p);
  await pg.evaluate(() => BF.save.saveNow());
  const saved = await lib.sim(pg, async ([DB, id]) => {
    const { getData } = new Function(DB + "; return { getData };")();
    return Object.keys((await getData(id)).villagers || {}).filter(k => k.startsWith("farmbeds:9999"));
  }, [DB, B.id]);
  ok("nothing from world A is saved into the new world", saved.length === 0, saved);
  // loading A again still finds its project
  await pg.evaluate(id => BF.save.load(id), A.id);
  p = await projects();
  ok("world A keeps its project", p.includes("farmbeds:9999,9999"), p);
  await pg.evaluate(async ([a, b]) => { await BF.save.remove(a); await BF.save.remove(b); }, [A.id, B.id]);
  for (const l of lines) console.log(l);
};
