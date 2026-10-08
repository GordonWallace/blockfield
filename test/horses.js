// @ci baseline
// Horses (js/horses.js): recipes, vanilla stat ranges and prices, foal inheritance, taming by riding (food helps), saddles, riding speed
// and jumping, fall damage going to the horse, leads and fence posts, and saving tamed horses (they never despawn).
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/horses test/horses.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => { const l = (cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""); R.lines.push(l); console.warn(l); };
    const tick = () => new Promise(r => setTimeout(r, 10));
    const load = async (x, z) => {
      for (let i = 0; i < 600 && !BF.world.isLoaded(x, z); i++) { BF.world.update(x, z, 8); await tick(); }
      for (let i = 0; i < 600; i++) { BF.world.update(x, z, 8); await tick(); if (BF.world.queueLength === 0) break; }
    };
    const W = BF.world, B = BF.B, I = BF.I, P = BF.player, H = BF.horses;
    BF.state.paused = true;
    BF.newWorld(5, { gen: 3, gameMode: "survival" });
    BF.mobs.spawning = false;
    W.setViewDist(8);
    await load(8, 8);

    // ---- recipes and items ----
    const recipes = BF.inventory.recipes;
    const sad = recipes.find(r => r.out === I.saddle), lead = recipes.find(r => r.out === I.lead);
    ok("recipe: 3 leather over 1 iron make a saddle", !!sad && sad.pattern.join("|") === "LLL| I " && sad.key.L[0] === I.leather && sad.key.I[0] === I.iron_ingot, sad && sad.pattern);
    ok("recipe: 4 string and 1 leather make leads", !!lead && lead.n === 2 && lead.key.S[0] === I.string && lead.key.L[0] === I.leather, lead && lead.pattern);
    ok("saddles are one per stack", BF.items[I.saddle].stack === 1);
    ok("creative has a horse spawn egg", !!I.horse_spawn_egg && !!BF.items[I.horse_spawn_egg].creativeTab);

    // ---- stats ----
    let lo = { hp: 99, speed: 99, jump: 99 }, hi = { hp: 0, speed: 0, jump: 0 }, inRange = true;
    for (let i = 0; i < 2000; i++) {
      const s = H.rollStats(), j = H.jumpHeight ? H.jumpHeight(s) : s.jump;
      for (const k of ["hp", "speed", "jump"]) { lo[k] = Math.min(lo[k], s[k]); hi[k] = Math.max(hi[k], s[k]); }
      if (s.hp < 15 || s.hp > 30 || s.speed < 4.8 || s.speed > 14.2 || s.jump < 1.1 || s.jump > 5.3 || !Number.isInteger(s.hp)) inRange = false;
    }
    ok("rolled stats stay inside vanilla's ranges (health 15-30, speed 4.8-14.2, jump 1.1-5.3)", inRange, { lo, hi });
    ok("rolled stats spread across the ranges", hi.hp - lo.hp >= 10 && hi.speed - lo.speed >= 5 && hi.jump - lo.jump >= 2.5, { lo, hi });
    const pMin = H.price({ maxHp: 15, speed: 4.8, jump: 1.1 }), pMax = H.price({ maxHp: 30, speed: 14.2, jump: 5.3 });
    ok("horse prices run from 8 to 24 emeralds by stats", pMin === 8 && pMax === 24, { pMin, pMax });

    // ---- foals ----
    const a = { maxHp: 28, speed: 13, jump: 5 }, b = { maxHp: 24, speed: 11, jump: 4 };
    let foalOk = true, sum = { hp: 0, speed: 0, jump: 0 };
    for (let i = 0; i < 500; i++) {
      const f = H.foalStats(a, b);
      if (Math.abs(f.hp - 26) > 26 * 0.05 + 1 || Math.abs(f.speed - 12) > 12 * 0.05 + 1e-9 || Math.abs(f.jump - 4.5) > 4.5 * 0.05 + 1e-9) foalOk = false;
      sum.hp += f.hp; sum.speed += f.speed; sum.jump += f.jump;
    }
    ok("a foal's stats are its parents' average, varied by up to 5%", foalOk, { avg: { hp: sum.hp / 500, speed: sum.speed / 500, jump: sum.jump / 500 } });
    const top = H.foalStats({ maxHp: 30, speed: 14.2, jump: 5.3 }, { maxHp: 30, speed: 14.2, jump: 5.3 });
    ok("a foal of two perfect parents stays inside the ranges", top.hp <= 30 && top.speed <= 14.2 && top.jump <= 5.3, top);

    // ---- a flat test field high above the spawn ----
    const x0 = 8, z0 = 8, y0 = BF.worldgen.heightAt(x0, z0) + 30;
    const fill = (xa, xb, y, za, zb, id) => { for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) W.setBlock(x, y, z, id); };
    fill(x0 - 6, x0 + 6, y0, z0 - 60, z0 + 6, B.stone);
    const settle = async m => { for (let i = 0; i < 40; i++) { BF.mobs.update(0.05); if (i % 10 === 0) await tick(); } };

    // ---- taming by riding ----
    let tries = 0, throws = 0, tamedAt = -1;
    const wild = H.spawn(x0 + 0.5, y0 + 1, z0 + 0.5, { stats: { hp: 20, speed: 9, jump: 3 } });
    await settle(wild);
    ok("a wild horse spawns untamed with no owner", !!wild && !wild.horse.tamed && !wild.horse.owner);
    const use0 = H.playerUse(wild, { id: I.saddle, n: 1 }, false);
    ok("a saddle won't go on an untamed horse", use0 && !use0.consume && !!use0.msg, use0);
    for (; tries < 60 && !wild.horse.tamed; tries++) {
      P.teleport(wild.position.x, wild.position.y, wild.position.z + 2);
      wild.position.x = x0 + 0.5; wild.position.z = z0 + 0.5; wild.vel.x = wild.vel.z = 0;
      P.mount(wild);
      for (let t = 0; t < 5 && P.vehicle === wild && !wild.horse.tamed; t += 0.05) P.ride(0, 0, 0.05);
      if (P.vehicle !== wild && !wild.horse.tamed) throws++;
      if (wild.horse.tamed) tamedAt = tries;
      P.dismount();
    }
    ok("riding a wild horse ends in it throwing the rider, then taming", throws >= 1 && wild.horse.tamed && wild.horse.owner === "player", { throws, tries, temper: wild.horse.temper });
    // food raises the chance: a fed horse's temper starts higher
    const w2 = H.spawn(x0 + 3.5, y0 + 1, z0 + 0.5, {});
    await settle(w2);
    const t0 = w2.horse.temper, ateWheat = H.feed(w2, "wheat_item", "player"), t1 = w2.horse.temper;
    const ateApple = H.feed(w2, "apple", "player"), t2 = w2.horse.temper;
    ok("wheat and apples make an untamed horse easier to tame", ateWheat && ateApple && t1 > t0 && t2 > t1, { t0, t1, t2 });
    ok("horses won't eat dirt", !H.feed(w2, "dirt", "player"));

    // ---- saddle and riding ----
    const useS = H.playerUse(wild, { id: I.saddle, n: 1 }, false);
    ok("a saddle goes on a tamed horse and is used up", useS && useS.consume === 1 && wild.horse.saddle, useS);
    wild.position.x = x0 + 0.5; wild.position.z = z0 + 0.5; wild.position.y = y0 + 1; wild.vel.x = wild.vel.z = wild.vel.y = 0;
    P.teleport(x0 + 2.5, y0 + 1, z0 + 0.5); P.setLook(0, 0);
    P.mount(wild);
    ok("the player mounts the saddled horse", P.vehicle === wild);
    for (let t = 0; t < 0.5; t += 0.05) P.ride(0, 0, 0.05);
    const zStart = wild.position.z;
    for (let t = 0; t < 2; t += 0.05) P.ride(1, 0, 0.05);
    const v = Math.hypot(wild.vel.x, wild.vel.z), moved = zStart - wild.position.z;
    ok("W rides the horse the way the player looks at its own speed", Math.abs(v - 9) < 0.6 && moved > 13, { v: +v.toFixed(2), moved: +moved.toFixed(2) });
    ok("the rider sits on the horse", Math.abs(P.position.x - wild.position.x) < 0.01 && P.position.y > wild.position.y + 0.5);
    ok("the HUD shows the horse's health while riding", P.vehicle.ctl.hud && P.vehicle.ctl.hud(wild).max === 20);
    // jump: a full charge clears close to the horse's jump height
    for (let t = 0; t < 0.5; t += 0.05) P.ride(0, 0, 0.05);
    const yG = wild.position.y;
    for (let t = 0; t < 1.1; t += 0.05) P.ride(0, 0, 0.05, true);
    let peak = yG;
    for (let t = 0; t < 1.5; t += 0.02) { P.ride(0, 0, 0.02, false); peak = Math.max(peak, wild.position.y); }
    ok("holding Space and letting go jumps about the horse's jump height", peak - yG > 2.7 && peak - yG < 3.6, { jump: +(peak - yG).toFixed(2) });
    const tapY = wild.position.y;
    P.ride(0, 0, 0.05, true);
    let tapPeak = tapY;
    for (let t = 0; t < 1.5; t += 0.02) { P.ride(0, 0, 0.02, false); tapPeak = Math.max(tapPeak, wild.position.y); }
    ok("a tap jumps lower than a full charge", tapPeak - tapY > 0.5 && tapPeak - tapY < peak - yG - 0.8, { tap: +(tapPeak - tapY).toFixed(2) });
    // fall damage goes to the horse, reduced
    const hpP = P.health, hpH = wild.hp;
    wild.position.y = y0 + 15; wild.vel.y = 0; wild.fallStart = null; wild.onGround = false;
    for (let t = 0; t < 3; t += 0.05) P.ride(0, 0, 0.05);
    ok("a 14-block fall hurts the horse (4 hearts' worth less than on foot) and not the rider", wild.hp === hpH - 4 && P.health === hpP, { horse: [hpH, wild.hp], player: [hpP, P.health] });
    // Shift gets off
    P.dismount();
    ok("dismounting puts the player beside the horse", !P.vehicle && Math.hypot(P.position.x - wild.position.x, P.position.z - wild.position.z) > 0.8);

    // ---- leads ----
    const useL = H.playerUse(wild, { id: I.lead, n: 1 }, false);
    ok("a lead goes on the horse", useL && useL.consume === 1 && wild.horse.lead && wild.horse.lead.kind === "player", useL);
    P.teleport(x0 + 0.5, y0 + 1, z0 - 12.5);
    for (let i = 0; i < 160; i++) { BF.mobs.update(0.05); if (i % 20 === 0) await tick(); }
    const dLead = Math.hypot(P.position.x - wild.position.x, P.position.z - wild.position.z);
    ok("a led horse follows the player", dLead < 5, { d: +dLead.toFixed(2) });
    W.setBlock(x0 + 2, y0 + 1, z0 - 12, B.oak_fence || B.fence);
    ok("right clicking a fence ties the led horse to it", H.tieToPost(x0 + 2, y0 + 1, z0 - 12) && wild.horse.lead.kind === "post");
    P.teleport(x0 + 0.5, y0 + 1, z0 - 40.5);
    for (let i = 0; i < 200; i++) { BF.mobs.update(0.05); if (i % 20 === 0) await tick(); }
    const dPost = Math.hypot(x0 + 2.5 - wild.position.x, z0 - 11.5 - wild.position.z);
    ok("a tied horse stays by its post", dPost < 4.5, { d: +dPost.toFixed(2) });

    // ---- saving ----
    const hid = wild.horse.hid, st = { hp: wild.maxHp, speed: wild.horse.speed, jump: wild.horse.jump, coat: wild.horse.coat, mark: wild.horse.mark };
    const data = JSON.parse(JSON.stringify(H.serialize()));
    H.deserialize(data);
    for (let i = 0; i < 20; i++) { BF.mobs.update(0.05); if (i % 10 === 0) await tick(); }
    const back = [...H.records.values()].find(r => r.hid === hid);
    ok("a tamed horse is saved with its stats, coat, saddle, owner and post", !!back && back.tamed && back.owner === "player" && back.saddle && back.maxHp === st.hp &&
      Math.abs(back.speed - st.speed) < 0.01 && back.coat === st.coat && back.mark === st.mark && back.lead && back.lead.kind === "post", back && { tamed: back.tamed, saddle: back.saddle, lead: back.lead });
    ok("the saved horse is back in the world", !!(back && back.mob && BF.mobs.list.includes(back.mob)));
    // never despawns: far away and unloaded, it waits as a record and comes back
    const m2 = back.mob;
    P.teleport(x0 + 0.5, y0 + 1, z0 + 2000.5);
    await load(x0, z0 + 2000);
    for (let i = 0; i < 60; i++) { BF.mobs.update(0.5); if (i % 10 === 0) await tick(); }
    ok("far from the player the tamed horse is kept, not despawned", H.records.has(hid), { mobGone: !BF.mobs.list.includes(m2) });
    P.teleport(x0 + 0.5, y0 + 1, z0 - 10.5);
    await load(x0, z0 - 10);
    for (let i = 0; i < 60; i++) { BF.mobs.update(0.1); if (i % 10 === 0) await tick(); }
    const r3 = H.records.get(hid);
    ok("coming back, the tamed horse is there again", !!(r3 && r3.mob && BF.mobs.list.includes(r3.mob)), r3 && { x: r3.x, z: r3.z });
    // old saves without horses
    H.deserialize(undefined);
    ok("an old save without horses loads with none", H.records.size === 0);

    // ---- herds ----
    const sizes = [];
    for (let k = 0; k < 12; k++) {
      H.reset();
      fill(x0 - 6, x0 + 6, y0, z0 - 6, z0 + 6, B.grass); fill(x0 - 6, x0 + 6, y0 + 1, z0 - 6, z0 + 6, B.air);
      const hd = H.spawnHerdAt(x0, z0);
      sizes.push(hd ? [...H.records.values()].filter(r => r.herd === hd.id).length : 0);
    }
    ok("wild herds come in 2 to 6", sizes.every(n => n >= 2 && n <= 6) && new Set(sizes).size >= 2, sizes);
    ok("herd horses are wild", [...H.records.values()].every(r => !r.tamed && !r.owner));
    ok("horse biomes are plains, savanna and meadow", [...H.HORSE_BIOMES].length === 3);
    H.reset();
    return R;
  });
  for (const l of res.lines) console.log(l);
  const fails = res.lines.filter(l => l.startsWith("FAIL")).length;
  console.log(fails ? "horses FAIL " + fails : "horses PASS");
};
