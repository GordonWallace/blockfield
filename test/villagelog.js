// Village action log test: node test/run.js /tmp/vl test/villagelog.js
module.exports = async (pg) => {
  await pg.evaluate(() => {
    const v = BF.worldgen.nearestVillage(0, 0);
    window.__v = v;
    BF.player.spawn(v.x + 0.5, (v.y || BF.world.heightAt(v.x, v.z)) + 3, v.z + 0.5);
  });
  await pg.waitForTimeout(9000);
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
    const L = BF.vlog, p = BF.player.position, rec = L.villageAt(p.x, p.z);
    ok("player is inside a village", !!rec);
    const vs = BF.mobs.list.filter(m => m.type === "villager" && m.village === rec && !m.child);
    ok("villagers spawned", vs.length >= 3);
    ok("names are stable and distinct-ish", L.nameOf(vs[0]) === L.nameOf(vs[0]) && new Set(vs.map(L.nameOf)).size > vs.length / 2);
    const before = L.entries(rec.key).length;
    // profession
    const u = vs.find(m => m.profession !== "unemployed" && m.profession !== "nitwit") || vs[0];
    BF.jobs.release(u);
    const x = Math.floor(p.x) + 2, z = Math.floor(p.z) + 2; let y = 100; while (y > 0 && !BF.world.getBlock(x, y, z)) y--; y++;
    BF.world.setBlock(x, y, z, BF.B.composter); BF.emit("blockPlaced", x, y, z, BF.B.composter);
    BF.jobs.hire(u, BF.jobs.sites.get(x + "," + y + "," + z));
    // player bed
    const bx = Math.floor(p.x) - 3, bz = Math.floor(p.z);
    BF.world.setBlock(bx, y, bz, BF.bedId(0, 0)); BF.world.setBlock(bx + 1, y, bz, BF.bedId(0, 1));
    BF.emit("blockPlaced", bx, y, bz, BF.bedId(0, 0)); BF.emit("blockPlaced", bx + 1, y, bz, BF.bedId(0, 1));
    // player trade
    const tv = vs.find(m => m.trades && m.trades.length && !BF.trades.blockReason(m, m.trades[0])) || vs[1];
    BF.emit("villagerTrade", tv, tv.trades[0]);
    // tents: a player's, then an explorer's (logged under its name)
    const tz = Math.floor(p.z) + 6, tx = Math.floor(p.x) - 6; let ty = 100; while (ty > 0 && !BF.world.getBlock(tx, ty, tz)) ty--; ty++;
    const site = BF.tents.findSite(tx, tz, 6);
    ok("tent site", !!site);
    BF.tents.place(site.x, site.y, site.z, site.f);
    const ex = BF.mobs.spawn("villager", p.x + 3, y, p.z + 3, "explorer", 0); ex.village = rec;
    const s2 = BF.tents.findSite(p.x + 8, p.z - 8, 6);
    BF.vlog.actor = ex; BF.tents.place(s2.x, s2.y, s2.z, s2.f); BF.vlog.actor = null;
    // birth
    const a = vs[0], b = vs[1];
    for (const m of [a, b]) BF.trades.inv.add(m.inv, BF.I.bread, 20);
    const kid = BF.breeding.forceBirth(a, b);
    ok("birth happened", !!kid);
    // deaths: a zombie's hit, an explosion, the player
    const d1 = vs[2], d2 = vs[3], d3 = vs[4];
    BF.mobs.hurt(d1, 999, "a zombie"); BF.mobs.hurt(d2, 999, "an explosion");
    ok("cause logged", L.entries(rec.key).some(e => e[1] === "death" && /killed by a zombie/.test(e[2])) && L.entries(rec.key).some(e => /killed by an explosion/.test(e[2])));
    BF.mobs.hit(d3, 999, null);
    ok("player kill logged", L.entries(rec.key).some(e => e[1] === "death" && /killed by the player/.test(e[2])));
    // tally in the panel
    BF.vlog.update(1, true);
    const html = document.getElementById("vlog").innerHTML;
    ok("panel shows occupations and unclaimed job blocks", /Occupations:/.test(html) && /unclaimed job blocks/.test(html));
    BF.vlog.update(1, true);
    const a2 = L.entries(rec.key);
    ok("log grew by 4+", a2.length - before >= 4);
    for (const k of ["job", "bed", "trade", "birth"]) ok("has " + k, a2.some(e => e[1] === k));
    ok("bed + two tent entries, head/other tent cells not logged", a2.filter(e => e[1] === "bed").length === 3 && a2.filter(e => /tent/.test(e[2])).length === 2 && a2.some(e => /Explorer\)? placed a tent/.test(e[2])));
    const ser = JSON.parse(JSON.stringify(L.serialize()));
    L.reset(); ok("reset empties", L.entries(rec.key).length === 0);
    L.deserialize(ser); ok("round trips", L.entries(rec.key).length === a2.length);
    ok("tally", L.tally(rec).villagers > 0 && L.tally(rec).beds > 0);
    return out.concat(L.entries(rec.key).map(e => L.stamp(e[0]) + " " + e[2]));
  });
  console.log(res.join("\n"));
  // run.js presses F3 afterwards (debug on); hide the title screen and let the panel and name tags render
  await pg.evaluate(() => { for (const e of document.querySelectorAll("#ui > *")) e.style.display = "none"; BF.player.setLook && BF.player.setLook(0.8, -0.1); });
  await pg.waitForTimeout(1500);
};
