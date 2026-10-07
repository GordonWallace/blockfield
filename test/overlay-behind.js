// Debug panels fade and sit behind in-game screens: node test/run.js /tmp/ob test/overlay-behind.js
module.exports = async (pg, out) => {
  await pg.evaluate(() => {
    BF.player.start();
    const v = BF.worldgen.nearestVillage(0, 0);
    BF.player.spawn(v.x + 0.5, (v.y || BF.world.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  });
  await pg.keyboard.press('F3');
  await pg.waitForTimeout(9000);
  const op = () => pg.evaluate(() => [getComputedStyle(debug).opacity, getComputedStyle(vlog).opacity, document.body.classList.contains("bf-screen-open")]);
  const before = await op();
  await pg.screenshot({ path: out + '-closed.png' });
  await pg.evaluate(() => {
    const p = BF.player.position;
    const v = BF.mobs.list.filter(m => m.type === "villager" && !m.child && m.profession !== "nitwit" && m.profession !== "unemployed")
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0];
    BF.inventory.openTrade(v);
  });
  await pg.waitForTimeout(500);
  const during = await op();
  // the trade screen must be the element on top where it overlaps the debug panel
  const top = await pg.evaluate(() => {
    const r = BF.inventory && document.querySelector(".bf-inv").getBoundingClientRect(), d = debug.getBoundingClientRect(), l = vlog.getBoundingClientRect();
    const hit = (a, b) => { const x = Math.max(a.left, b.left) + 4, y = Math.max(a.top, b.top) + 4; return x < Math.min(a.right, b.right) && y < Math.min(a.bottom, b.bottom) ? document.elementFromPoint(x, y) : null; };
    const name = e => e ? (e.id || e.className) + (debug.contains(e) || vlog.contains(e) ? " (debug!)" : "") : "no overlap";
    return [name(hit(r, d)), name(hit(r, l))];
  });
  await pg.screenshot({ path: out + '-open.png' });
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(500);
  const after = await op();
  const occ = await pg.evaluate(() => (vlog.innerHTML.match(/Occupations: ([^<]*)/) || [])[1]);
  console.log("closed", before, "open", during, "after", after, "top", top, "\nocc", occ);
};
