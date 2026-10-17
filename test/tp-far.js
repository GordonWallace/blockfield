// Commands can't send the player past the world border: /tp x z and /spawnpoint refuse it like /tp x y z does, and a
// spawn point or saved position past the border (older saves) falls back to the world spawn. /spawnpoint keeps its y.
// node test/run.js /tmp/tf test/tp-far.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); });
  await pg.waitForTimeout(1500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  const x = c => pg.evaluate(c => { const r = BF.commands.execute(c), p = BF.player.position; return { ok: r.ok, msg: r.msg, pos: [p.x, p.y, p.z], sp: BF.spawnPoint }; }, c);
  for (const c of ["/tp 99999999999 0", "/tp 2147483700 0", "/tp 0 -30000001", "/spawnpoint 99999999999 64 0", "/spawnpoint 0 -100000 0"]) {
    const r = await x(c);
    check(!r.ok && /Invalid position/.test(r.msg) && Math.abs(r.pos[0]) < 1e4, `${c} refused (${r.msg})`);
  }
  check((await x("/tp 30000 0")).ok, "/tp 30000 0 still works");
  await pg.waitForTimeout(3000);
  // /spawnpoint with a y below the surface: respawn there, not on the surface
  await x("/tp 8 8");
  await pg.waitForTimeout(2000);
  const cave = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, bx = Math.floor(p.x), bz = Math.floor(p.z), h = W.heightAt(bx, bz), y = h - 12;
    for (let dy = 0; dy < 3; dy++) W.setBlock(bx, y + dy, bz, 0);        // a 1x3 pocket underground
    W.setBlock(bx, y - 1, bz, BF.B.stone);
    return { h, y, msg: BF.commands.execute(`/spawnpoint ${bx} ${y} ${bz}`).msg };
  });
  await pg.evaluate(() => BF.player.kill());
  await pg.waitForTimeout(500);
  await pg.evaluate(() => document.querySelector('[data-act="respawn"]').click());
  await pg.waitForTimeout(2500);
  const after = await pg.evaluate(() => BF.player.position.y);
  check(Math.abs(after - cave.y) < 1.1, `respawn at the /spawnpoint y (${cave.msg}; surface ${cave.h}, now y ${after.toFixed(2)})`);
  // a saved spawn point and position past the border (an older save) go back to the world spawn
  const saved = await pg.evaluate(async () => {
    BF.spawnPoint = { x: 99999999999.5, y: 64, z: 0.5 };
    BF.player.deserialize({ x: 99999999999.5, y: -57, z: 0.5, health: 20 });
    await new Promise(r => setTimeout(r, 3000));
    const p = BF.player.position;
    return { pos: [p.x, p.y, p.z], sp: BF.spawnPoint };
  });
  check(Math.abs(saved.pos[0]) < 1e4 && Math.abs(saved.sp.x) < 1e4, "a saved position past the border loads at the world spawn " + JSON.stringify(saved));
  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL tp-far" : "PASS tp-far");
};
