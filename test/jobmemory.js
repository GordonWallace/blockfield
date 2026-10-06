// Jobsite memory test: node test/run.js /tmp/jm test/jobmemory.js
module.exports = async (pg) => {
  const res = await pg.evaluate(() => {
    const out = [], ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
    const J = BF.jobs, p = BF.player.pos || BF.player.position;
    const px = Math.floor(p.x), pz = Math.floor(p.z);
    let y = 60; for (let i = 120; i > 0; i--) if (BF.world.getBlock(px, i, pz)) { y = i + 1; break; }
    const mk = (dx, prof) => { const m = BF.mobs.spawn("villager", px + dx + 0.5, y, pz + 0.5, prof, 0); m.jobStocked = true; return m; };
    const place = (x, name) => { BF.world.setBlock(x, y, pz + 3, BF.B[name]); BF.emit("blockPlaced", x, y, pz + 3, BF.B[name]); };
    const brk = x => { BF.world.setBlock(x, y, pz + 3, 0); BF.emit("blockBroken", x, y, pz + 3); };
    const far = mk(-10, "farmer"), near = mk(18, "farmer"), other = mk(-3, "unemployed");
    for (const m of [far, near]) { m.xp = 20; m.level = 3; }
    place(px + 20, "composter"); place(px + 21, "composter");
    J.hire(near, J.sites.get((px + 20) + "," + y + "," + (pz + 3)));
    J.hire(far, J.sites.get((px + 21) + "," + y + "," + (pz + 3)));
    ok("hired", near.profession === "farmer" && far.profession === "farmer");
    brk(px + 20);
    ok("loses profession", near.profession === "unemployed" && !near.jobsite);
    ok("remembers farmer, level 3", near.jobMem && near.jobMem.prof === "farmer" && near.level === 3 && near.xp === 20);
    brk(px + 21);
    // other unemployed cannot take a reserved block; farmer-memory villagers reclaim, nearest first
    place(px + 22, "composter");
    ok("nearest remembering villager reclaims", near.jobsite && near.jobsite.x === px + 22 && !far.jobsite);
    ok("level kept on reclaim", near.profession === "farmer" && near.level === 3 && near.trades.length > 0);
    ok("other unaffected", other.profession === "unemployed");
    // reserved against non-remembering villagers
    brk(px + 22);
    const site = (place(px + 23, "lectern"), J.sites.get((px + 23) + "," + y + "," + (pz + 3)));
    ok("lectern not reserved (no librarian memory)", J.unclaimed(other, 48, other).includes(site));
    place(px + 24, "composter");
    ok("far reclaims after near lost it", far.jobsite || near.jobsite);
    // expiry
    brk(px + 24); brk(px + 22);
    for (const m of [far, near]) if (m.profession !== "unemployed") J.release(m);
    near.jobMem.t = BF.sky.day + BF.sky.time - 31;
    far.jobMem.t = BF.sky.day + BF.sky.time - 29;
    J.tick(5);
    ok("expired memory cleared", !near.jobMem && near.level === 1 && near.xp === 0);
    ok("unexpired memory kept", far.jobMem && far.level === 3);
    // save round trip
    const packed = BF.trades.pack(far);
    ok("pack has mem", Array.isArray(packed.mem) && packed.mem[0] === "farmer");
    return out;
  });
  console.log(res.join("\n"));
};
