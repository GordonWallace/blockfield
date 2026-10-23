// @ci integration suite=world timeout=420
// Mobs, items and vehicles across face edges on the planet (generator 4, spec r14-13). At an edge of face 4 (no turn) and one that turns
// (face 0 to face 2), in a cleared, floored box that straddles the edge (k < 0 on face A, k >= 0 across it on face B; j along the edge): cows
// follow the player holding wheat across and end up on face B's square, while a cow that belongs to a place on face A stays in A's frame;
// a zombie chases the player across; a dropped item slides across; a boat and a ridden horse cross with their riders and keep heading the
// same way; an arrow flies across; a route planned across the edge is straight, and a villager walks to a target across the edge.
// node test/run.js /tmp/pw test/planet-edges-mobs.js
module.exports = async (pg) => {
  await pg.evaluate(() => { window.__errs = []; addEventListener("error", e => window.__errs.push(e.message)); BF.newWorld(1337, { gen: 4 }); BF.player.start(); });
  await pg.waitForTimeout(2500);
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };

  for (const [f, s] of [[4, 1], [0, 2]]) {
    const setup = await pg.evaluate(async ([f, s]) => {
      const P = BF.planet, N = P.N, W = BF.world, h = [[-1, 0], [1, 0], [0, -1], [0, 1]][s];
      const at = (k, j) => {   // atlas address (through A's margin for k >= 0) of the cell k across the edge, j along it
        const o = (h[0] || h[1]) < 0 ? -1 - k : N + k, a = N / 2 + j;
        return h[0] ? P.atlas(f, o, a) : P.atlas(f, a, o);
      };
      const cc = (k, j) => { const a = at(k, j), c = P.canonCell(a.x, a.z); return { x: c.x + 0.5, z: c.z + 0.5 }; };   // canonical cell centre
      const c0 = { x: at(0, 0).x + 0.5, z: at(0, 0).z + 0.5 };
      // k of any point (any frame), measured in A's frame; on B: canonical on face g; dirB: the +k direction in B's canonical frame
      const kOf = p => { const q = P.local(c0, p); return (q.x - c0.x) * h[0] + (q.z - c0.z) * h[1]; };
      const g = P.EDGE[f][s].g;
      const onB = p => { const c = P.canon(p.x, p.z); return c.f === g && c.x === p.x && c.z === p.z; };
      const b5 = cc(5, 0), b6 = cc(6, 0), dirB = [b6.x - b5.x, b6.z - b5.z];
      Object.assign(window, { __at: at, __cc: cc, __kOf: kOf, __onB: onB, __dirB: dirB, __h: h });
      const sp = at(-8, 0);
      BF.player.setGameMode && BF.player.setGameMode("survival");
      BF.player.teleport(sp.x + 0.5, Math.max(BF.worldgen.heightAt(sp.x, sp.z), BF.SEA) + 30, sp.z + 0.5); BF.player.setFlying(true);
      for (let i = 0; i < 160; i++) {
        await new Promise(r => setTimeout(r, 250));
        let ok = true;
        for (const [k, j] of [[-16, -10], [-16, 10], [16, -10], [16, 10], [0, 0]]) { const a = at(k, j), c = W.chunkAt(a.x, a.z); if (!c || c.mesh === undefined) ok = false; }
        if (ok) break;
      }
      let top = BF.SEA;
      for (let k = -14; k <= 14; k++) for (let j = -9; j <= 9; j++) { const a = at(k, j); top = Math.max(top, W.heightAt(a.x, a.z)); }
      const y = top + 3;
      for (let k = -15; k <= 15; k++) for (let j = -10; j <= 10; j++) {
        const a = at(k, j), edge = Math.abs(k) > 14 || Math.abs(j) > 9;
        for (let yy = y - 2; yy < y + 30; yy++) {
          let want = 0;
          if (!edge && yy === y - 1) want = j <= -5 && j >= -8 && Math.abs(k) <= 12 ? BF.B.water : BF.B.stone;   // the floor, with a water channel at j = -8..-5
          if (!edge && yy === y - 2 && j <= -5 && j >= -8) want = BF.B.stone;
          if (edge && yy < y) continue;
          if (yy === y - 2 && (j > -5 || j < -8)) continue;
          if (W.getBlock(a.x, yy, a.z) !== want) W.setBlock(a.x, yy, a.z, want);
        }
      }
      window.__clearMobs = () => { for (const m of BF.mobs.list.slice()) { const q = P.local(c0, m.position); if (Math.hypot(q.x - c0.x, q.z - c0.z) < 40) BF.mobs.kill(m); } for (let i = 0; i < 30; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver()); };
      window.__clearMobs();
      BF.mobs.spawning = false;
      const p = cc(-8, 8);
      BF.player.teleport(p.x, y, p.z); BF.player.setFlying(false);
      return { y, g, turn: P.EDGE[f][s].turn };
    }, [f, s]);
    const tag = `face ${f} edge ${s} (to face ${setup.g}, turn ${setup.turn})`;
    const y = setup.y;

    // cows follow the player holding wheat across the edge; one belonging to a place on face A stays in A's frame
    const cows = await pg.evaluate(async ([y, f]) => {
      const P = BF.planet, at = window.__at, cc = window.__cc, kOf = window.__kOf, onB = window.__onB, PL = BF.player, I = BF.I;
      BF.inventory.setSlot(0, { id: I.wheat_item, count: 8 }); BF.inventory.select(0);
      const list = [];
      for (const j of [-1, 0, 1, 2]) { const c = cc(-6, j); list.push(BF.mobs.spawn("cow", c.x, y, c.z)); }
      const anchor = at(-12, 0);
      list[3].penVillage = { x: anchor.x, z: anchor.z, key: "test-edge" };   // as a village's own animal: kept in face A's frame
      for (let k = -3; k <= 7; k++) {
        const c = cc(k, 0); PL.teleport(c.x, y, c.z);
        for (let i = 0; i < 12; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
        await new Promise(r => setTimeout(r, 20));
      }
      for (let i = 0; i < 160; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      const pp = PL.position;
      const out = list.map(m => ({ k: +kOf(m.position).toFixed(1), onB: onB(m.position), d: +P.distance(m.position, pp).toFixed(1), face: P.face(m.position.x, m.position.z) }));
      for (const m of list) BF.mobs.kill(m);
      for (let i = 0; i < 30; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      BF.inventory.setSlot(0, null);
      return { cows: out, f };
    }, [y, f]);
    const wild = cows.cows.slice(0, 3), anch = cows.cows[3];
    check(wild.every(c => c.onB && c.k > 2 && c.d < 5), `${tag}: cows follow the player with wheat across the edge onto face B's square ${JSON.stringify(cows.cows)}`);
    check(anch.k > 2 && anch.d < 5 && anch.face === f && !anch.onB, `${tag}: a cow that belongs to a place on face A follows across but stays in A's frame`);

    // a zombie chases the player across the edge
    const zombie = await pg.evaluate(async ([y]) => {
      const P = BF.planet, cc = window.__cc, kOf = window.__kOf, onB = window.__onB, PL = BF.player;
      const p = cc(4, 3); PL.teleport(p.x, y, p.z);
      PL.health = 20;
      const z0 = cc(-5, 3), z = BF.mobs.spawn("zombie", z0.x, y, z0.z);
      const hp0 = PL.health;
      let close = false;
      for (let i = 0; i < 200 && !close; i++) { (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver()); PL.teleport(p.x, y, p.z); if (P.distance(z.position, PL.position) < 1.6) close = true; if (i % 20 === 0) await new Promise(r => setTimeout(r, 10)); }
      const out = { close, onB: onB(z.position), k: +kOf(z.position).toFixed(1), d: +P.distance(z.position, PL.position).toFixed(1), hurt: PL.health < hp0 };
      BF.mobs.kill(z); for (let i = 0; i < 30; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      PL.health = 20;
      return out;
    }, [y]);
    check(zombie.close && zombie.onB && zombie.k > 2, `${tag}: a zombie chases the player across the edge ${JSON.stringify(zombie)}`);

    // a dropped item slides across, and the player picks it up there
    const item = await pg.evaluate(async ([y]) => {
      const cc = window.__cc, kOf = window.__kOf, onB = window.__onB, h = window.__h, PL = BF.player;
      const p = cc(8, 8); PL.teleport(p.x, y, p.z);
      const c = cc(-2, 3);
      const d = BF.drops.spawn(BF.I.cobblestone, 1, c.x, y + 0.2, c.z, { vel: new THREE.Vector3(h[0] * 9, 1, h[1] * 9), pickupDelay: 0 });
      for (let i = 0; i < 40; i++) BF.drops.update(0.05);
      const out = { onB: onB(d.pos), k: +kOf(d.pos).toFixed(1) };
      PL.teleport(d.pos.x, y, d.pos.z);
      const n0 = BF.inventory.count ? BF.inventory.count(BF.I.cobblestone) : null;
      for (let i = 0; i < 20; i++) { BF.drops.update(0.05); BF.req.apply(); BF.req.deliver(); }   // picking up is a "pickup" request (spec r15-22): applied here, as a tick would
      out.picked = !BF.drops.list.includes(d);
      return out;
    }, [y]);
    check(item.onB && item.k > 0.5 && item.picked, `${tag}: a dropped item slides across the edge and is picked up there ${JSON.stringify(item)}`);

    // a boat rowed across the edge, then a ridden horse
    const ride = await pg.evaluate(async ([y]) => {
      const P = BF.planet, cc = window.__cc, kOf = window.__kOf, onB = window.__onB, h = window.__h, dirB = window.__dirB, PL = BF.player;
      const yaw0 = Math.atan2(-h[0], -h[1]);   // facing +k (forward is (-sin yaw, -cos yaw))
      const fwdDot = yw => (-Math.sin(yw) * dirB[0] - Math.cos(yw) * dirB[1]) / Math.hypot(dirB[0], dirB[1]);
      const out = {};
      const b0 = cc(-5, -6), boat = BF.boats.spawn("oak", b0.x, y - 0.4, b0.z, yaw0);
      PL.teleport(b0.x, y + 0.5, b0.z); PL.setLook(yaw0, 0);
      out.boarded = PL.mount(boat) !== false && PL.vehicle === boat;
      for (let t = 0; t < 4 && kOf(boat.pos) < 4; t += 0.05) PL.ride(1, 0, 0.05);
      out.boat = { onB: onB(boat.pos), k: +kOf(boat.pos).toFixed(1), fwd: +fwdDot(boat.yaw).toFixed(3), look: +fwdDot(PL.yaw).toFixed(3), riderOnB: onB(PL.position), seated: Math.hypot(PL.position.x - boat.pos.x, PL.position.z - boat.pos.z) < 1 };
      PL.dismount();
      const h0 = cc(-6, 3), horse = BF.horses.spawn(h0.x, y, h0.z, { tamed: true, stats: { hp: 20, speed: 9, jump: 3 } });
      horse.horse.saddle = true;
      for (let i = 0; i < 20; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      PL.teleport(h0.x + 1, y, h0.z); PL.setLook(yaw0, 0);
      PL.mount(horse);
      out.mounted = PL.vehicle === horse;
      for (let t = 0; t < 3 && kOf(horse.position) < 5; t += 0.05) { PL.ride(1, 0, 0.05); (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver()); }
      out.horse = { onB: onB(horse.position), k: +kOf(horse.position).toFixed(1), fwd: +fwdDot(PL.yaw).toFixed(3), riderOnB: onB(PL.position), seated: Math.hypot(PL.position.x - horse.position.x, PL.position.z - horse.position.z) < 0.5 };
      PL.dismount();
      BF.mobs.kill(horse); for (let i = 0; i < 30; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      return out;
    }, [y]);
    const bt = ride.boat || {}, hs = ride.horse || {};
    check(ride.boarded && bt.onB && bt.k > 1 && bt.fwd > 0.95 && bt.look > 0.95 && bt.riderOnB && bt.seated, `${tag}: a rowed boat crosses the edge with its rider, still heading the same way ${JSON.stringify(ride.boat)}`);
    check(ride.mounted && hs.onB && hs.k > 1 && hs.fwd > 0.95 && hs.riderOnB && hs.seated, `${tag}: a ridden horse crosses the edge with its rider, still heading the same way ${JSON.stringify(ride.horse)}`);

    // an arrow flies across the edge
    const arrow = await pg.evaluate(async ([y]) => {
      const cc = window.__cc, kOf = window.__kOf, onB = window.__onB, h = window.__h, dirB = window.__dirB, PL = BF.player;
      const p = cc(8, -9); PL.teleport(p.x, y, p.z);
      const c = cc(-3, 6), a = BF.mobs.shootArrow(new THREE.Vector3(c.x, y + 2, c.z), new THREE.Vector3(h[0] * 25, 3, h[1] * 25), { damage: 1, pickup: 0 });
      for (let i = 0; i < 12 && !a.stuck; i++) (BF.mobs.update(0.025), BF.req.apply(), BF.req.deliver());
      const v = Math.hypot(a.vel.x, a.vel.z);
      return { onB: onB(a.pos), k: +kOf(a.pos).toFixed(1), dir: +((a.vel.x * dirB[0] + a.vel.z * dirB[1]) / v / Math.hypot(dirB[0], dirB[1])).toFixed(3), stuck: a.stuck };
    }, [y]);
    check(arrow.onB && arrow.k > 2 && arrow.dir > 0.95, `${tag}: an arrow flies across the edge, turned with it ${JSON.stringify(arrow)}`);

    // a route planned across the edge is straight; a villager walks to a target across the edge
    const walk = await pg.evaluate(async ([y]) => {
      const P = BF.planet, at = window.__at, cc = window.__cc, kOf = window.__kOf, onB = window.__onB, h = window.__h;
      const s0 = at(-5, 3), g0 = at(5, 3);
      const route = BF.mobs.findPath(s0.x, y, s0.z, { x: g0.x, z: g0.z, at: (x, yy, z) => x === g0.x && z === g0.z });
      const straight = !!route && route.length === 10 && route.every(c => (h[0] ? c[2] === s0.z : c[0] === s0.x));
      const c = cc(-5, 3), v = BF.mobs.spawn("villager", c.x, y, c.z, "farmer");
      const tgt = { x: g0.x + 0.5, z: g0.z + 0.5 };   // in v's frame (face A's margin)
      let got = false;
      for (let i = 0; i < 400 && !got; i++) {
        if (v.ai.mode !== "walk") { const q = P.local(v.position, P.canon(tgt.x, tgt.z)); v.ai.mode = "walk"; v.ai.tx = q.x; v.ai.tz = q.z; }   // (re-expressed by the mob itself when it crosses)
        v.ai.t = 30;
        (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
        if (P.distance(v.position, P.canon(tgt.x, tgt.z)) < 0.8) got = true;
        if (i % 40 === 0) await new Promise(r => setTimeout(r, 10));
      }
      const out = { straight, len: route && route.length, got, onB: onB(v.position), k: +kOf(v.position).toFixed(1) };
      BF.mobs.kill(v); for (let i = 0; i < 30; i++) (BF.mobs.update(0.05), BF.req.apply(), BF.req.deliver());
      return out;
    }, [y]);
    check(walk.straight, `${tag}: a route planned across the edge is straight (${walk.len} cells)`);
    check(walk.got && walk.onB, `${tag}: a villager walks to a target across the edge ${JSON.stringify(walk)}`);
  }

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors " + JSON.stringify(errs.slice(0, 3)));
  console.log(bad ? "FAIL planet-edges-mobs" : "PASS planet-edges-mobs");
};
