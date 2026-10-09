// Day/night and monster spawn timing: NODE_PATH=$(npm root -g) node test/run.js /tmp/night test/night-spawn.js
// Day and night are equal halves, dusk/dawn darken and lighten gradually, monsters need half an in-game hour of darkness
// (also after a torch is broken), and villagers are in bed before the first monsters can spawn.
module.exports = async (pg, out) => {
  await pg.evaluate(() => BF.player.start());
  await pg.waitForTimeout(4000);
  const fails = [];
  const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };

  const a = await pg.evaluate(() => {
    const S = BF.sky, L = t => +S.lightAt(t).toFixed(3), H = S.HOUR, r = {};
    r.noon = L(0.25); r.beforeSunset = L(0.5 - 0.001); r.sunset = L(0.5); r.dusk1h = L(0.5 + H); r.full = L(0.5 + 1.5 * H); r.midnight = L(0.75);
    r.dawn = L(1 - H); r.sunrise = L(0.999);
    r.monotoneDusk = true; for (let t = 0.5; t < 0.75; t += 0.001) if (S.lightAt(t + 0.001) > S.lightAt(t) + 1e-9) r.monotoneDusk = false;
    r.symmetric = [0.01, 0.03, 0.06, 0.1].every(d => Math.abs(S.lightAt(0.5 + d) - S.lightAt(1 - d)) < 1e-9);
    const night = t => { S.time = t; return S.isNight(); };
    r.nightHalf = [night(0.49), night(0.5), night(0.99), night(0.001)];
    let n = 0; for (let i = 0; i < 1000; i++) if (night(i / 1000)) n++; r.nightShare = n / 1000;
    // first and last moment an open-sky spot qualifies for spawning (no local changes)
    const p = BF.player.position, ok = t => { S.time = t; return BF.mobs.darkLongEnough(p.x, p.z, 1); };
    r.first = null; r.last = null;
    for (let t = 0.5; t < 1; t += 0.0005) { if (ok(t)) { if (r.first == null) r.first = +t.toFixed(4); r.last = +t.toFixed(4); } }
    r.noonOK = ok(0.25);
    r.caveNoon = (S.time = 0.25, BF.mobs.darkLongEnough(p.x, p.z, 0));
    return r;
  });
  console.log(JSON.stringify(a));
  check(a.noon === 1 && a.sunset > 0.8 && a.sunset < 0.9, "full day, a little dimmer at sunset");
  check(a.dusk1h > a.full && a.dusk1h < a.sunset && a.full < 0.19, "dusk darkens gradually to full night 1.5 h after sunset");
  check(a.monotoneDusk && a.symmetric, "dusk only darkens, dawn mirrors it");
  check(a.nightHalf.join() === "false,true,true,false" && a.nightShare === 0.5, "night is exactly the half with the sun down");
  check(a.first > 0.56 && a.first < 0.59, "open-sky spawns from about 1.5-2 h after sunset (" + a.first + ")");
  check(a.last > 0.94 && a.last < 0.97 && !a.noonOK, "no new open-sky spawns from about 1 h before sunrise (" + a.last + ")");
  const spread = await pg.evaluate(() => {   // over many cells, the first eligible time spreads over half an hour
    const S = BF.sky, firsts = [];
    for (let k = 0; k < 40; k++) for (let t = 0.55; t < 0.62; t += 0.0005) { S.time = t; if (BF.mobs.darkLongEnough(k * 8 * 7 + 3, 5, 1)) { firsts.push(t); break; } }
    return [Math.min(...firsts), Math.max(...firsts)].map(v => +v.toFixed(4));
  });
  console.log("cell first-spawn range", JSON.stringify(spread));
  check(spread[0] >= 0.5645 && spread[1] - spread[0] > 0.012, "cells open up over the half hour after the minimum wait");
  check(a.caveNoon, "deep cover still counts as dark at noon");

  // a torch broken at midnight: the spot waits half an hour
  const b = await pg.evaluate(() => {
    const S = BF.sky, W = BF.world, p = BF.player.position, x = Math.floor(p.x) + 3, z = Math.floor(p.z), y = W.heightAt(x, z) + 1, r = {};
    S.day = 5; S.time = 0.75;
    r.before = BF.mobs.darkLongEnough(x, z, 1);
    W.setBlock(x, y, z, BF.B.torch); W.setBlock(x, y, z, 0);
    r.justBroken = BF.mobs.darkLongEnough(x, z, 1);
    r.neighbourCell = BF.mobs.darkLongEnough(x + 16, z, 1);
    r.farCell = BF.mobs.darkLongEnough(x + 64, z, 1);
    S.time = 0.75 + 0.45 * S.HOUR; r.after24min = BF.mobs.darkLongEnough(x, z, 1);
    S.time = 0.75 + 1.01 * S.HOUR; r.after33min = BF.mobs.darkLongEnough(x, z, 1);
    S.time = 0.75; W.setBlock(x, y + 3, z, BF.B.stone); r.roof = BF.mobs.darkLongEnough(x, z, 1); W.setBlock(x, y + 3, z, 0);
    S.time = 0.6; r.timeSetBack = BF.mobs.darkLongEnough(x, z, 1);
    return r;
  });
  console.log(JSON.stringify(b));
  check(b.before && !b.justBroken && !b.neighbourCell && b.farCell, "breaking a torch restarts the wait around it");
  check(!b.after24min && b.after33min, "...for half an hour to an hour");
  check(!b.roof, "a new roof restarts the wait under it");
  check(b.timeSetBack, "setting the time back clears the wait");

  // live run in the open: no monster on the surface before the first spawn time
  const c = await pg.evaluate(async () => {
    const S = BF.sky, M = BF.mobs, p = BF.player.position;
    for (const m of M.list.slice()) if (m.hostile) m.dead = true;
    const surf = () => M.list.filter(m => m.hostile && !m.dead && !m.removed && m.position.y >= BF.world.heightAt(m.position.x, m.position.z) + 0.5);
    const seen = new Set(M.list.filter(m => m.hostile));
    // only monsters that spawned on the surface: one that spawned in a dark cave may walk out into the open at any time
    const born = new Map(), onTop = m => m.position.y >= BF.world.heightAt(m.position.x, m.position.z) + 0.5;
    let firstAt = null, dt = 0.05, counts = {};
    S.day = 9; S.time = 0.5;
    for (let i = 0; S.time < 0.62; i++) {
      S.time += dt / S.dayLength; M.update(dt);
      for (const m of M.list) if (m.hostile && !seen.has(m) && !born.has(m)) born.set(m, onTop(m));
      const s = surf().filter(m => !seen.has(m) && born.get(m));
      if (s.length && firstAt == null) firstAt = +S.time.toFixed(4);
      const k = (Math.floor(S.time * 100) / 100).toFixed(2); counts[k] = s.length;
      if (i % 500 === 0) await new Promise(r => setTimeout(r, 0));
    }
    return { firstAt, counts, player: [p.x | 0, p.y | 0, p.z | 0] };
  });
  console.log(JSON.stringify(c));
  check(c.firstAt == null || c.firstAt >= 0.56, "no surface monster before the wait is over (first " + c.firstAt + ")");

  // villagers: in bed (or a tent) by the time monsters can start spawning
  await require('./lib').toVillage(pg);
  const d = await pg.evaluate(async () => {
    const S = BF.sky, M = BF.mobs;
    M.spawning = false;
    for (const m of M.list.slice()) if (m.hostile) m.dead = true;
    S.day = 12; S.time = 0.44;
    const dt = 0.05;
    for (let i = 0; S.time < 0.565; i++) { S.time += dt / S.dayLength; M.update(dt); if (i % 200 === 0) await new Promise(r => setTimeout(r, 0)); }
    const vs = M.list.filter(m => m.type === "villager" && !m.dead && !m.removed && m.bed);
    const out = vs.filter(m => !m.sleeping).map(m => ({ prof: m.profession || m.variant, d: Math.round(Math.hypot(m.position.x - m.bed.x, m.position.z - m.bed.z)), tent: !!m.bed.tent }));
    M.spawning = true;
    return { villagers: vs.length, asleep: vs.length - out.length, awake: out };
  });
  console.log(JSON.stringify(d));
  check(d.villagers > 0 && d.awake.length <= Math.max(1, Math.floor(d.villagers * 0.1)), "villagers in bed before monsters can spawn (" + d.asleep + "/" + d.villagers + ")");

  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
