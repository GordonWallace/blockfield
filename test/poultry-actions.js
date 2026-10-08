// Chickens, coops and the poultry keeper (js/poultry.js): a generated coop and its keeper, laying and collecting eggs, feeding and breeding,
// culling past 8, stocking an empty coop from wild chickens, the player's seeds, save and load, and a builder's coop. Usage:
//   NODE_PATH=$(npm root -g) node test/run.js /tmp/out test/poultry-actions.js
module.exports = async (pg, out) => {
  const res = await pg.evaluate(async () => {
    const R = { lines: [] }, ok = (name, cond, extra) => R.lines.push((cond ? "PASS " : "FAIL ") + name + (extra !== undefined ? "  " + JSON.stringify(extra) : ""));
    const step = (h = 0.05) => { const W = BF.warp; W.advance(h); BF.state.time += h; BF.sky.update(h); BF.mobs.update(h); BF.drops.update(h); BF.world.tickSim(); };
    const run = (sec, h = 0.05) => { for (let t = 0; t < sec; t += h) step(h); };
    const day = () => BF.sky.day + BF.sky.time;
    const P = BF.poultry, I = BF.I;
    BF.state.paused = true;
    BF.newWorld(1, { gen: 3, gameMode: "survival" });
    ok("new worlds use village generator 4", BF.state.villages === 4, BF.state.villages);
    BF.mobs.spawning = false;
    const V = { x: 26, z: 39 };   // seed 1: a village of 12 with a coop
    const wv = BF.worldgen.villagesNear(V.x, V.z, 40).find(v => Math.round(v.x) === V.x && Math.round(v.z) === V.z);
    const cb = wv && wv.buildings.find(b => b.type === "coop");
    ok("the village layout has a coop", !!cb, wv && wv.pop);
    BF.player.teleport(cb.doorX + 0.5, BF.worldgen.heightAt(cb.doorX, cb.doorZ) + 3, cb.doorZ - 3.5);
    const load = async () => { for (let i = 0; i < 400; i++) { BF.world.update(cb.doorX, cb.doorZ, 8); await new Promise(r => setTimeout(r, 10)); if (BF.world.queueLength === 0 && BF.world.isLoaded(cb.doorX, cb.doorZ)) break; } };
    await load();
    BF.player.invulnerable = true;
    BF.sky.setTime(0.05);
    run(4);
    const key = V.x + "," + V.z;
    for (let k = 0; k < 120 && !((BF.mobs.villages.get(key) || { members: [] }).members.some(m => m.profession === "poultry_keeper")); k++) { BF.world.update(V.x, V.z, 8); run(0.5); }
    const rec = BF.mobs.villages.get(key);
    const keeper = rec && rec.members.find(m => m.type === "villager" && m.profession === "poultry_keeper");
    ok("the village has a poultry keeper", !!keeper, rec && rec.members.filter(m => m.type === "villager").map(m => m.profession).join(","));
    if (!keeper) return R;
    const coop = P.coopOf(keeper);
    ok("its nesting box stands beside the coop", !!coop && BF.world.getBlock(keeper.jobsite.x, keeper.jobsite.y, keeper.jobsite.z) === BF.B.nesting_box, keeper.jobsite);
    if (!coop) return R;
    run(2);
    ok("a generated coop starts with 2-4 chickens", coop.hens.length >= 2 && coop.hens.length <= 4, coop.hens.length);
    ok("its chickens are spawned inside the run", coop.hens.every(s => s.mob && s.mob.position.x > coop.x0 && s.mob.position.x < coop.x1 && s.mob.position.z > coop.z0 && s.mob.position.z < coop.z1), coop.hens.map(s => s.mob && [s.mob.position.x.toFixed(1), s.mob.position.z.toFixed(1)]));
    const gateB = BF.blocks[BF.world.getBlock(coop.gate[0], coop.y + 1, coop.gate[1])];
    ok("the coop has a gate", !!(gateB && gateB.gate), gateB && gateB.name);
    const c = n => BF.trades.inv.count(keeper.inv, I[n]);
    ok("the keeper starts with seeds and no eggs, feathers or chicken", c("wheat_seeds") >= 12 && !c("egg") && !c("feather") && !c("raw_chicken"), { seeds: c("wheat_seeds"), egg: c("egg") });

    // ---- a morning: eggs are laid into the nest, the keeper feeds the flock and collects the eggs
    let fed = 0, born = 0;
    BF.on("chickenFed", (h, by) => { if (by === keeper) fed++; });
    BF.on("chickenBorn", () => born++);
    for (const s of coop.hens) s.layAt = day() + 0.01;   // lay soon
    const tasks = {};
    for (let i = 0; i < 8000; i++) { step(); if (i % 10 === 0 && keeper.pkp && keeper.pkp.task) tasks[keeper.pkp.task.kind] = (tasks[keeper.pkp.task.kind] || 0) + 1; }
    R.tasks = tasks;
    ok("the keeper fed the chickens", fed > 0, { fed, tasks });
    ok("the chickens laid eggs and the keeper collected them", c("egg") > 0, { eggs: c("egg"), nest: coop.eggs });
    ok("fed chickens bred: a chick hatched in the coop", born > 0 && coop.hens.some(s => s.growAt != null), { born, flock: coop.hens.length });
    const chick = coop.hens.find(s => s.growAt != null);
    ok("a chick is smaller", !!(chick && chick.mob && chick.mob.chick && chick.mob.model.scale.x < 0.9), chick && chick.mob && chick.mob.model.scale.x);
    for (let i = 0; i < 1200 && (keeper.position.x > coop.fx0 && keeper.position.x < coop.fx1 && keeper.position.z > coop.fz0 && keeper.position.z < coop.fz1); i++) step();
    R.keeperInv = keeper.inv.filter(Boolean).map(s => BF.items[s.id].name + ":" + s.count).join(",");

    // ---- overcrowding: culled back to 8, keeping the meat and feathers
    for (const s of coop.hens) s.cd = day() + 5;
    for (let i = 0; i < 8; i++) coop.hens.push({ fed: null, cd: day() + 5, growAt: null, layAt: day() + 1, x: coop.x0 + 0.7 + (i % 4), z: coop.z0 + 0.7 + (i >> 2), mob: null });
    BF.sky.setTime(0.08);
    run(3);
    const crowded = coop.hens.length, meat0 = c("raw_chicken"), fea0 = c("feather");
    ok("the coop is over 8", crowded > P.CULL_AT, crowded);
    for (let i = 0; i < 9000 && coop.hens.length > P.CULL_AT; i++) step();
    ok("the keeper culled the flock back to 8", coop.hens.length === P.CULL_AT, coop.hens.length);
    ok("it kept the raw chicken (one each)", c("raw_chicken") - meat0 === crowded - P.CULL_AT, [meat0, c("raw_chicken"), crowded]);
    ok("feathers: 0-2 per chicken culled", c("feather") - fea0 <= 2 * (crowded - P.CULL_AT), [fea0, c("feather")]);
    run(20);
    ok("no more culling once at 8", coop.hens.length === P.CULL_AT, coop.hens.length);
    const vl = (BF.vlog.entries ? BF.vlog.entries(rec) : []).map(e => e[2]);

    // ---- an empty coop: the keeper fetches wild chickens until it holds 2
    for (const s of coop.hens.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1);
    coop.hens.length = 0;
    const pkp = keeper.pkp; pkp.stockAt = 0;
    const wild = [];
    const spot = (dx, dz) => { const x = Math.floor(coop.out[0] + dx), z = Math.floor(coop.out[1] + dz), y = BF.world.heightAt(x, z) + 1; return [x + 0.5, y, z + 0.5]; };
    for (const [dx, dz] of [[-14, -10], [-16, -8]]) { const [x, y, z] = spot(dx, dz); const h = BF.mobs.spawn("chicken", x, y, z); if (h) wild.push(h); }
    ok("two wild chickens spawned outside the village coop", wild.length === 2 && wild.every(h => !h.coop), wild.map(h => [h.position.x.toFixed(0), h.position.z.toFixed(0)]));
    BF.sky.setTime(0.06);
    let fetches = 0;
    const seeds0 = c("wheat_seeds");
    for (let i = 0; i < 24000 && coop.hens.length < 2; i++) { step(); if (pkp.task && pkp.task.kind === "fetch" && pkp.stage !== "walk" && i % 20 === 0) fetches++; if (BF.sky.time > 0.45) BF.sky.setTime(0.06); }
    ok("the keeper led wild chickens into the empty coop until it held 2", coop.hens.length >= 2, { hens: coop.hens.length, wild: wild.map(h => !!h.coop), log: P.log.filter(e => /lead|stock|fetch/.test(e.kind)).slice(-6) });
    ok("it led them (it walked with a chicken behind it)", fetches > 0, fetches);
    ok("they are inside the run", wild.filter(h => h.coop === coop).every(h => h.position.x > coop.fx0 && h.position.x < coop.fx1 && h.position.z > coop.fz0 && h.position.z < coop.fz1));
    for (let i = 0; i < 600; i++) step();
    const gb = BF.blocks[BF.world.getBlock(coop.gate[0], coop.y + 1, coop.gate[1])];
    ok("the gate is shut again", !!(gb && gb.gate && !gb.gate.open), gb && gb.name);
    // none in range: it looks again the next day
    for (const s of coop.hens.slice()) if (s.mob) BF.mobs.hurt(s.mob, 999, "test");
    run(1); coop.hens.length = 0;
    for (const m of BF.mobs.list.slice()) if (m.type === "chicken" && !m.dead) BF.mobs.hurt(m, 999, "test");
    run(1);
    pkp.stockAt = 0;
    for (let i = 0; i < 600; i++) step();
    ok("no wild chicken in range: it tries again tomorrow", pkp.stockAt > day() && pkp.stockAt - day() < 1.05 && P.log.some(e => e.kind === "noWild"), { stockAt: pkp.stockAt, day: day() });

    // ---- the player: seeds feed a chicken, chickens follow a player holding seeds
    const hx = spot(-6, -6), hen = BF.mobs.spawn("chicken", hx[0], hx[1], hx[2]);
    BF.inventory.slots[0] = { id: I.wheat_seeds, count: 10 };
    BF.inventory.select(0);
    const sel = BF.inventory.selected();
    ok("the player holds wheat seeds", !!(sel && sel.id === I.wheat_seeds), sel);
    const r1 = P.playerUse(hen, sel);
    ok("right-clicking a chicken with seeds feeds it", r1 === true && P.willing(hen, day()), r1);
    BF.player.teleport(hen.position.x + 6, hen.position.y + 0.2, hen.position.z);
    const d0 = Math.hypot(hen.position.x - BF.player.position.x, hen.position.z - BF.player.position.z);
    run(4);
    const d1 = Math.hypot(hen.position.x - BF.player.position.x, hen.position.z - BF.player.position.z);
    ok("a chicken follows a player holding seeds", d1 < d0 - 2, [d0.toFixed(1), d1.toFixed(1)]);

    // ---- save and load keep the coop's chickens and eggs
    coop.eggs = 5;
    const o = {}; P.exportAll(o);
    const k = Object.keys(o).find(x => x === "coops:" + key);
    ok("the coop is saved", !!k && o[k].some(e => e.i === coop.idx && e.e === 5), k && o[k]);
    P.importAll(JSON.parse(JSON.stringify(o)));

    // ---- a builder's coop: fences around a run, a gap to walk in by, the nesting box beside it
    const bp = BF.blueprints.get("coop", 1, 0, 0.5, null, "spruce");
    ok("the coop blueprint has spruce fences, a nesting box and no gate", bp && bp.req[I.spruce_fence] > 20 && bp.req[I.nesting_box] === 1 && !bp.cells.some(x => BF.blocks[x.id].gate), bp && BF.blueprints.describe(bp.req));
    const e = { id: 77, type: "coop", rot: 1, style: 0, h: 0.5, wood: "spruce", ox: 100, oy: 1010, oz: 200, state: "done", w: bp.w, d: bp.d };
    const fake = { key: "test", wg: { buildings: [] }, built: [e] };
    const bc = P.coopsOf(fake)[0];
    ok("a finished builder's coop is a coop with a 5x5 run and a way in", !!bc && !bc.gen && bc.x1 - bc.x0 === 5 && bc.z1 - bc.z0 === 5 && !!bc.gate && !!bc.out, bc && [bc.x0, bc.z0, bc.x1, bc.z1, bc.gate, bc.out]);
    return R;
  });
  for (const l of res.lines) console.log(l);
  if (res.tasks) console.log("tasks", JSON.stringify(res.tasks));
  if (res.keeperInv) console.log("keeper", res.keeperInv);
};
