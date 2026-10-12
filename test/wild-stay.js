// @ci integration suite=world soak timeout=1500
// No spontaneous animals (idea-037): the player stands still for 3 game days at the start spot; every wild animal that appears after the
// first-generation roll must be a newborn (wild breeding), never a grown animal out of nowhere. Also reports births and the animal count.
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/ws test/wild-stay.js
module.exports = async (pg) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await pg.waitForTimeout(6000);
  const r = await pg.evaluate(async () => {
    const M = BF.mobs, S = BF.sky, W = BF.world, p = BF.player.position;
    for (let i = 0; i < 300; i++) { W.update(p.x, p.z, 40); if (i % 50 === 0) await new Promise(r => setTimeout(r, 0)); }
    const animal = m => !m.dead && !m.removed && !m.hostile && m.type !== "villager" && !(m.def && (m.def.golem || m.def.village));
    for (let i = 0; i < 200; i++) M.update(0.05);   // the first-generation rolls of the loaded chunks
    const seen = new Set(M.list.filter(animal)), start = seen.size, chunks0 = W.chunks.size;
    const grown = [], born = [];
    const steps = Math.round(3 * 1200 / 0.05);
    for (let i = 0; i < steps; i++) {
      S.update(0.05); M.update(0.05);
      if (i % 50 === 0) W.update(p.x, p.z, 4);
      if (i % 200 === 0) {
        for (const m of M.list) if (animal(m) && !seen.has(m)) {
          seen.add(m);
          const st = m.sheep || m.hen || m.cow || m.pig;
          if (st && st.growAt != null) born.push(m.type); else grown.push([m.type, Math.round(m.position.x), Math.round(m.position.z)]);
        }
        await new Promise(r => setTimeout(r, 0));
      }
    }
    return { start, end: M.list.filter(animal).length, born: born.length, grown: grown.slice(0, 10), grownN: grown.length, chunks: [chunks0, W.chunks.size] };
  });
  ok("over 3 game days standing still, no grown animal appears out of nowhere (only newborns)", r.grownN === 0, r);
  ok("the chunks stayed the same (nothing loaded or unloaded)", r.chunks[0] === r.chunks[1], r.chunks);
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
