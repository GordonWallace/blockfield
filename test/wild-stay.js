// @ci integration suite=world soak timeout=1500
// No spontaneous animals (idea-037): the player stands still for 3 game days at the start spot; every wild animal that appears after the
// first-generation roll (or mobs of a chunk coming back) must be a newborn (wild breeding), never a grown animal out of nowhere. Also reports births and the animal count.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/ws test/wild-stay.js
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await pg.waitForTimeout(6000);
  const r = await pg.evaluate(async () => {
    const M = BF.mobs, S = BF.sky, W = BF.world, p = BF.player.position;
    for (let i = 0; i < 3000 && (i < 300 || W.queueLength > 0); i++) { W.update(p.x, p.z, 40); if (i % 50 === 0) await new Promise(r => setTimeout(r, 0)); }
    const animal = m => !m.dead && !m.removed && !m.hostile && m.type !== "villager" && !(m.def && (m.def.golem || m.def.village));
    for (let i = 0; i < 200; i++) M.update(0.05);   // the first-generation rolls of the loaded chunks
    // where each new mob came from: a chunk's first-generation roll or stored mobs coming back (js/wildlife.js), a saved horse coming back,
    // or anything else (which, for a grown animal, is a spontaneous spawn)
    const sp = M.spawn;
    const sg = M.spawnGroup;
    M.spawnGroup = function () { const n0 = M.list.length, r = sg.apply(this, arguments); for (let i = n0; i < M.list.length; i++) M.list[i].__src = "wild"; return r; };
    M.spawn = function () { const m = sp.apply(this, arguments); if (m) { const st = new Error().stack; m.__src = m.__src || (/wildlife\.js/.test(st) ? "wild" : /embody|mobsave\.js/.test(st) ? "back" : "other"); } return m; };
    const seen = new Set(M.list.filter(animal)), start = seen.size, chunks0 = new Set(W.chunks.keys());
    const ck = m => Math.floor(m.position.x / BF.CS) + "," + Math.floor(m.position.z / BF.CS);
    const grown = [], born = [];
    let late = 0, back = 0;
    const steps = Math.round(3 * 1200 / 0.05);
    for (let i = 0; i < steps; i++) {
      S.update(0.05); M.update(0.05);
      if (i % 50 === 0) W.update(p.x, p.z, 4);
      if (i % 200 === 0) {
        for (const m of M.list) if (animal(m) && !seen.has(m)) {
          seen.add(m);
          if (m.pen || m.penVillage || m.coop || m.pasture || m.sty || m.village) continue;   // a village's kept animals (a shepherd's pen stocking itself) aren't wild
          const st = m.sheep || m.hen || m.cow || m.pig || m.horse;
          if (m.__src === "wild" || m.__src === "back") { if (!chunks0.has(ck(m))) late++; else back++; continue; }   // a late chunk's roll, or mobs of a chunk that unloaded and came back
          if (st && st.growAt != null) born.push(m.type); else grown.push([m.type, Math.round(m.position.x), Math.round(m.position.z)]);
        }
        await new Promise(r => setTimeout(r, 0));
      }
    }
    M.spawn = sp; M.spawnGroup = sg;
    return { late, back, start, end: M.list.filter(animal).length, born: born.length, grown: grown.slice(0, 10), grownN: grown.length, chunks: [chunks0.size, W.chunks.size, [...W.chunks.keys()].filter(k => !chunks0.has(k)).length] };
  });
  ok("over 3 game days standing still, no grown animal appears out of nowhere (only newborns)", r.grownN === 0, r);
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
