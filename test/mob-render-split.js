// @ci integration suite=ui timeout=600
// Mobs look the same with their drawing in js/mobview.js (spec r15-11). One of every mob type and variant (every profession in every
// village style, every horse coat and marking, shorn sheep, golem crack stages, young animals, level badges, held tools, the hurt flash)
// stands in a row on a stone stage high above the spawn and is photographed; each photo is compared (scaled to half size, a JPEG) with the
// baseline in test/baselines/mob-render/, taken on release-1-5 before the split. The mobs are held still for the photos: the warp is
// frozen, each is given a stand-in rider (js/mobs.js updateMob: a ridden mob neither thinks nor moves) and the test steps BF.mobs itself.
// Also: js/mobs.js makes no scene calls (THREE.Mesh, THREE.Group, scene.add, .root., .meshes) outside the arrow and puff lines that
// r15-12 moves; zombies in the sun get their fire; nothing is drawn for a mob too far away.
// Record new baselines: MOB_RENDER_RECORD=1 NODE_PATH=$(npm root -g) node test/run.js /tmp/mr test/mob-render-split.js
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/mr test/mob-render-split.js
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "baselines", "mob-render");
const RECORD = !!process.env.MOB_RENDER_RECORD;
// a pixel differs when a channel is off by more than PIX; a photo fails when more than FRAC of its pixels differ
const PIX = 32, FRAC = 0.0003;
module.exports = async (pg, out) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await require("./lib").ready(pg);

  // ---- the sim makes no scene calls ----
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "mobs.js"), "utf8").split("\n");
  const bad = [];
  src.forEach((l, i) => { if (/THREE\.Mesh\b|THREE\.Group\b|scene\.add|\.root\.|\.meshes\b/.test(l) && !/r15-12/.test(l)) bad.push(i + 1); });
  if (fs.existsSync(path.join(__dirname, "..", "js", "mobview.js"))) ok("js/mobs.js makes no scene calls (outside the arrow and puff lines left to r15-12)", bad.length === 0, bad.slice(0, 20));

  // ---- the stage ----
  const stage = await pg.evaluate(() => {
    BF.player.start && BF.player.start();
    if (BF.player.setGameMode) BF.player.setGameMode("creative");
    BF.player.setFlying(true);
    BF.warp.freeze();
    BF.mobs.spawning = false;
    if (BF.weather && BF.weather.set) BF.weather.set("clear", 1e6);
    BF.sky.setTime(0.25);
    const sp = BFT.spawn(), W = BF.world, B = BF.B;
    const y0 = Math.min(BF.H - 16, BF.worldgen.heightAt(sp.x, sp.z) + 30);
    // floor x0-16..x0+16, z0-7..z0+2; back wall at z0-7, 7 high
    for (let x = sp.x - 16; x <= sp.x + 16; x++) for (let z = sp.z - 7; z <= sp.z + 2; z++) W.setBlock(x, y0 - 1, z, B.stone);
    for (let x = sp.x - 16; x <= sp.x + 16; x++) for (let y = y0; y < y0 + 8; y++) W.setBlock(x, y, sp.z - 7, B.stone);
    BF.player.position.set(sp.x + 0.5, y0 + 2, sp.z + 12);
    return { x: sp.x, y: y0, z: sp.z };
  });
  console.log("stage " + JSON.stringify(stage));
  await pg.waitForTimeout(3000);   // remesh

  // ---- the line-ups ----
  const PROFS = await pg.evaluate(() => BF.mobs.professions.slice());
  const STYLES = ["plains", "desert", "snowy", "savanna", "taiga"];
  const COATS = ["white", "creamy", "chestnut", "brown", "black", "gray", "dark_brown"], MARKS = ["none", "white", "white_field", "white_dots", "black_dots"];
  const shots = [];
  for (let s = 0; s < STYLES.length; s++) for (let k = 0; k < PROFS.length; k += 14) shots.push({ name: `villagers-${STYLES[s]}-${k / 14 + 1}`, gap: 1.15, mobs: PROFS.slice(k, k + 14).map(p => ({ type: "villager", variant: p, style: STYLES[s] })) });
  const horses = [];
  for (const c of COATS) for (const m of MARKS) horses.push({ type: "horse", look: c + "/" + m, saddle: m === "none" });
  for (let k = 0; k < horses.length; k += 9) shots.push({ name: `horses-${k / 9 + 1}`, gap: 1.8, mobs: horses.slice(k, k + 9) });
  shots.push({ name: "animals-monsters", gap: 1.7, mobs: [
    { type: "pig" }, { type: "cow" }, { type: "sheep" }, { type: "sheep", shorn: true }, { type: "chicken" },
    { type: "zombie" }, { type: "skeleton" }, { type: "creeper" }, { type: "spider" },
  ] });
  shots.push({ name: "golems", gap: 2.0, mobs: [100, 70, 45, 20].map(hp => ({ type: "iron_golem", hp })) });
  shots.push({ name: "young-and-hurt", gap: 1.5, mobs: [
    { type: "sheep", young: 0 }, { type: "chicken", young: 0 }, { type: "cow", young: 0 }, { type: "pig", young: 0 }, { type: "horse", look: "brown/none", young: 0 },
    { type: "villager", variant: "farmer", style: "plains", hurt: true }, { type: "zombie", hurt: true }, { type: "pig", hurt: true },
  ] });
  shots.push({ name: "badges-tools", gap: 1.15, mobs: [
    ...[1, 2, 3, 4, 5].map(level => ({ type: "villager", variant: "librarian", style: "plains", level })),
    ...["wooden_axe", "stone_axe", "iron_axe", "golden_axe", "diamond_axe"].map(axe => ({ type: "villager", variant: "forester", style: "plains", axe })),
    { type: "villager", variant: "miner", style: "plains" }, { type: "villager", variant: "builder", style: "plains" },
  ] });

  if (RECORD) fs.mkdirSync(DIR, { recursive: true });
  const results = [];
  for (const shot of shots) {
    const info = await pg.evaluate(({ shot, st }) => {
      const M = BF.mobs, I = BF.I;
      for (const m of M.list.slice()) M.discard(m);   // nothing else on the stage
      const n = shot.mobs.length, width = (n - 1) * shot.gap;
      const made = shot.mobs.map((d, i) => {
        const x = st.x + 0.5 - width / 2 + i * shot.gap, z = st.z - 3 + 0.5;
        const m = M.spawn(d.type, x, st.y, z, d.variant, d.style);
        m.rider = {};   // held still: no AI, no physics (updateMob)
        m.yaw = 0; m.walkPhase = 0; m.walkAmt = 0; m.headYaw = 0; m.headPitch = 0;
        if (m.def.burns) m.inWater = true;   // no burning in the sun (the fire is random)
        if (d.look) M.setLook(m, d.look);
        if (d.saddle) M.showPart(m, "saddle", true);
        if (d.shorn) M.setSheepLook(m, true);
        if (d.hp) m.hp = d.hp;
        if (d.level) m.level = d.level;
        if (d.axe) { m.inv = BF.trades.inv.create(); BF.trades.inv.add(m.inv, I[d.axe], 1); }
        if (d.young === 0) {
          if (d.type === "sheep") M.setSheepSize(m, 0); else if (d.type === "chicken") M.setChickenSize(m, 0); else if (d.type === "cow") M.setCowSize(m, 0);
          else M.setYoungSize(m, 0, 1.35);
        }
        return m;
      });
      for (let i = 0; i < 40; i++) { BF.sky.setTime(0.25); M.update(0.05); }
      for (let i = 0; i < made.length; i++) {
        const m = made[i], d = shot.mobs[i];
        m.age = 1;
        if (d.hurt) m.hurtT = 100;
      }
      M.update(0.001);
      const D = Math.max(6, (width + 2.5) / 2.2);
      BF.player.position.set(st.x + 0.5, st.y + 0.4, st.z - 3 + 0.5 + D);
      BF.player.setLook(0, -0.08);
      return { n, D: +D.toFixed(2), alive: made.filter(m => !m.removed && !m.dead).length };
    }, { shot, st: stage });
    await pg.waitForTimeout(400);
    const buf = await pg.screenshot({ clip: { x: 0, y: 250, width: 1280, height: 320 } });
    // half size, drawn in the page; then compared with the baseline there
    const r = await pg.evaluate(async ({ shot, b64, base, PIX }) => {
      const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
      const im = await load("data:image/png;base64," + b64);
      const c = document.createElement("canvas"); c.width = im.width / 2; c.height = im.height / 2;
      const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, c.width, c.height);
      const png = c.toDataURL("image/jpeg", 0.9).split(",")[1];
      if (!base) return { png };
      // both through the same JPEG: an unchanged picture compares exactly equal
      const ci = await load("data:image/jpeg;base64," + png);
      g.drawImage(ci, 0, 0);
      const bi = await load("data:image/jpeg;base64," + base);
      const c2 = document.createElement("canvas"); c2.width = c.width; c2.height = c.height;
      const g2 = c2.getContext("2d"); g2.drawImage(bi, 0, 0);
      const a = g.getImageData(0, 0, c.width, c.height).data, b = g2.getImageData(0, 0, c.width, c.height).data;
      let diff = 0, sum = 0;
      const vis = new Uint8ClampedArray(a.length);
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        sum += d;
        if (d > PIX) { diff++; vis[i] = 255; vis[i + 3] = 255; } else { vis[i] = vis[i + 1] = vis[i + 2] = a[i] * 0.3; vis[i + 3] = 255; }
      }
      g2.putImageData(new ImageData(vis, c.width, c.height), 0, 0);
      return { png, frac: diff / (a.length / 4), mean: sum / (a.length / 4), diffPng: c2.toDataURL("image/png").split(",")[1] };
    }, { shot: shot.name, b64: buf.toString("base64"), base: RECORD || !fs.existsSync(path.join(DIR, shot.name + ".jpg")) ? null : fs.readFileSync(path.join(DIR, shot.name + ".jpg")).toString("base64"), PIX });
    if (RECORD) { fs.writeFileSync(path.join(DIR, shot.name + ".jpg"), Buffer.from(r.png, "base64")); console.log("recorded " + shot.name + " " + JSON.stringify(info)); continue; }
    fs.writeFileSync(out + "-" + shot.name + ".jpg", Buffer.from(r.png, "base64"));
    if (r.frac == null) { ok(shot.name + ": has a baseline", false); continue; }
    if (r.frac > FRAC) fs.writeFileSync(out + "-" + shot.name + "-diff.png", Buffer.from(r.diffPng, "base64"));
    results.push({ name: shot.name, frac: +r.frac.toFixed(5), mean: +r.mean.toFixed(3) });
    ok(`${shot.name}: looks as before (${(r.frac * 100).toFixed(2)}% of pixels differ, mean ${r.mean.toFixed(2)})`, r.frac <= FRAC && info.alive === info.n, info);
  }
  if (RECORD) { console.log("RECORDED " + shots.length); return; }

  // ---- fire, and nothing drawn far away ----
  const fire = await pg.evaluate(({ st }) => {
    const M = BF.mobs;
    for (const m of M.list.slice()) M.discard(m);
    BF.sky.setTime(0.25);
    const z = M.spawn("zombie", st.x + 0.5, st.y, st.z - 2.5);
    z.rider = {};
    for (let i = 0; i < 10; i++) { BF.sky.setTime(0.25); M.update(0.05); }
    return { onFire: !!z.onFire, hp: z.hp };
  }, { st: stage });
  await pg.waitForTimeout(300);
  const drawn = await pg.evaluate(() => {
    const z = BF.mobs.list.find(m => m.type === "zombie"), V = BF.mobView;
    if (!V) return { skip: true };
    const v = V.viewOf(z);
    return { built: !!v, fire: !!(v && v.fire && v.fire.visible && v.fire.children.length) };
  });
  if (!drawn.skip) ok("a zombie in the sun burns, and its fire is drawn", fire.onFire && drawn.built && drawn.fire, { fire, drawn });
  const far = await pg.evaluate(() => {
    const M = BF.mobs, V = BF.mobView;
    if (!V) return { skip: true };
    const p = BF.player.position, d = (BF.world.viewDist + 3) * BF.CS;
    const pig = M.spawn("pig", p.x + d, p.y, p.z);
    pig.rider = {};
    return { id: M.list.indexOf(pig) };
  });
  if (!far.skip) {
    await pg.waitForTimeout(300);
    const v = await pg.evaluate(() => { const pig = BF.mobs.list.find(m => m.type === "pig"); return { built: !!BF.mobView.viewOf(pig) }; });
    ok("no model is built for a mob too far away to draw", !v.built, v);
  }
  console.log("RESULTS " + JSON.stringify(results));
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};
