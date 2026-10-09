// @ci integration suite=ui
// Block, item, time and game-mode names that are built-in object properties (constructor, toString, __proto__)
// are unknown names: /setblock must not write a function into the world's edits, /gamemode must not claim a change (bug-044).
// node test/run.js /tmp/cpa test/cmd-proto-args.js
module.exports = async (pg) => {
  await pg.evaluate(() => { BF.player.start(); BF.player.setGameMode("survival"); });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(() => {
    const W = BF.world, p = BF.player.position, x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z);
    const out = { fails: [] }, run = c => BF.commands.execute(c);
    W.setBlock(x, y, z, BF.B.stone);
    for (const nm of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const s = run(`/setblock ${x} ${y} ${z} ${nm}`);
      if (s.ok !== false || !/Unknown block/.test(s.msg)) out.fails.push(`setblock ${nm}: ${JSON.stringify(s)}`);
      const f = run(`/fill ${x} ${y + 1} ${z} ${x + 1} ${y + 1} ${z} ${nm}`);
      if (f.ok !== false) out.fails.push(`fill ${nm}: ${JSON.stringify(f)}`);
      const g = run(`/give @s ${nm}`);
      if (g.ok !== false) out.fails.push(`give ${nm}: ${JSON.stringify(g)}`);
      const m = run(`/gamemode ${nm}`);
      if (m.ok !== false || !/Unknown game mode/.test(m.msg)) out.fails.push(`gamemode ${nm}: ${JSON.stringify(m)}`);
      if (BF.player.gameMode !== "survival") out.fails.push(`gamemode ${nm} changed mode to ${String(BF.player.gameMode).slice(0, 30)}`);
      const t = run(`/time set ${nm}`);
      if (t.ok !== false) out.fails.push(`time set ${nm}: ${JSON.stringify(t)}`);
    }
    if (W.getBlock(x, y, z) !== BF.B.stone) out.fails.push(`block changed to ${W.getBlock(x, y, z)}`);
    for (const [, m] of W.edits) for (const [, v] of m) if (typeof v !== "number") out.fails.push(`non-numeric edit ${typeof v}`);
    // the normal names still work
    const ok = [run(`/setblock ${x} ${y} ${z} oak_planks`), run(`/setblock ${x} ${y} ${z} minecraft:stone`), run(`/gamemode c`), run(`/gamemode survival`), run(`/time set noon`), run(`/give @s torch 2`)];
    ok.forEach((s, i) => { if (s.ok === false) out.fails.push(`valid command ${i} failed: ${s.msg}`); });
    if (W.getBlock(x, y, z) !== BF.B.stone) out.fails.push("setblock stone did not take");
    return out;
  });
  if (r.fails.length) r.fails.forEach(f => console.log("FAIL " + f));
  else console.log("PASS cmd-proto-args");
};
