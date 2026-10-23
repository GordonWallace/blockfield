// @ci integration suite=ui timeout=600
// Entities look the same with their drawing in js/entityview.js (spec r15-12). On a stone stage high above the spawn: item drops lying on
// the floor, player arrows stuck in the back wall, boats of every wood (one with a villager in it, one with a pig), bees flying and landed,
// and horses on leads (to a fence post, to a villager, to the player). Each line-up is photographed and compared (scaled to half size, a
// JPEG) with the baseline in test/baselines/entity-render/, taken on release-1-5 before the split. The warp is frozen and the test steps
// what it needs itself.
// The effects (eating crumbs, a mob's death puff, breeding hearts) are random and move, so they are compared as data instead: Math.random
// is swapped for a seeded stream while one is made, and the new scene objects (kind, position, size, colour) are compared with
// test/baselines/entity-render/effects.json.
// Also: the simulation modules make no scene calls (THREE.Mesh, THREE.Sprite, THREE.Line, THREE.InstancedMesh, THREE.Group, scene.add,
// scene.remove); a drop picked up is gone from the scene on the next frame; effect events from the builder and villagers are drawn.
// Record new baselines: ENTITY_RENDER_RECORD=1 NODE_PATH=$(npm root -g) node test/run.js /tmp/er test/entity-render-split.js
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/er test/entity-render-split.js
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "baselines", "entity-render");
const RECORD = !!process.env.ENTITY_RENDER_RECORD;
// a pixel differs when a channel is off by more than PIX; a photo fails when more than FRAC of its pixels differ
const PIX = 32, FRAC = 0.0003;
const SIM = ["drops", "boats", "bees", "horses", "mobs", "breeding", "villagelife", "builder"];
module.exports = async (pg, out) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await require("./lib").ready(pg);
  const split = fs.existsSync(path.join(__dirname, "..", "js", "entityview.js"));

  // ---- the sim makes no scene calls ----
  if (split) {
    const bad = [];
    for (const f of SIM) {
      const src = fs.readFileSync(path.join(__dirname, "..", "js", f + ".js"), "utf8").split("\n");
      src.forEach((l, i) => { if (/THREE\.(Mesh|Sprite|Line|LineSegments|Points|InstancedMesh|Group)\b|scene\.(add|remove)\b/.test(l)) bad.push(f + ":" + (i + 1)); });
    }
    ok("the simulation modules make no scene calls (" + SIM.join(", ") + ")", bad.length === 0, bad.slice(0, 20));
  }

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

  // clears the stage of mobs, drops, arrows, boats and fake bees; puts the camera D blocks in front of it
  const CLEAR = `(() => {
    const M = BF.mobs;
    for (const m of M.list.slice()) M.discard(m);
    BF.drops.clear(); BF.boats.clear();
    for (const a of M.playerArrows()) a.life = 0;
    M.update(0.001);
    BF.bees.list.length = 0;
  })()`;
  const shots = [
    { name: "drops", setup: ({ st }) => {
      const I = BF.I, ids = ["diamond", "apple", "bread", "iron_pickaxe", "torch", "oak_log", "emerald", "wheat_item", "bow", "cobblestone", "red_flower", "egg"];
      const made = ids.filter(n => I[n] != null).map((n, i) => {
        const d = BF.drops.spawn(I[n], 1 + i, st.x + 0.5 - 6 + i * 1.1, st.y + 0.01, st.z - 3 + 0.5, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 1e9 });
        d.phase = i * 0.5;
        return d;
      });
      for (let i = 0; i < 30; i++) BF.drops.update(0.05);
      for (const d of made) d.age = 2;
      BF.drops.update(1e-6);
      return { n: made.length, D: 7 };
    } },
    { name: "arrows", setup: ({ st }) => {
      const M = BF.mobs, made = [];
      for (let i = 0; i < 9; i++) {
        // a block from the wall: each sticks in its first step, so it points the way it was shot (before the split a stuck arrow
        // kept the way it pointed when last drawn)
        const from = new THREE.Vector3(st.x + 0.5 - 6 + i * 1.5, st.y + 0.8 + (i % 3) * 0.6, st.z - 5.9);
        const vel = new THREE.Vector3((i - 4) * 1.5, 2 - (i % 3) * 2, -30);
        made.push(M.shootArrow(from, vel, { damage: 2, pickup: 0 }));
      }
      for (let i = 0; i < 20; i++) M.update(0.05);
      return { n: made.filter(a => a.stuck).length, D: 4.5 };
    } },
    { name: "boats", setup: ({ st }) => {
      const woods = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"].filter(w => BF.I[w + "_boat"] != null);
      const made = woods.map((w, i) => BF.boats.spawn(w, st.x + 0.5 - (woods.length - 1) * 1.1 + i * 2.2, st.y, st.z - 3.5, 0.3 * (i - 3)));
      const v = BF.mobs.spawn("villager", made[1].pos.x, st.y, made[1].pos.z, "farmer", "plains"), pig = BF.mobs.spawn("pig", made[4].pos.x, st.y, made[4].pos.z);
      for (const [b, m] of [[made[1], v], [made[4], pig]]) { m.rider = {}; m.walkPhase = 0; m.walkAmt = 0; m.headYaw = 0; m.headPitch = 0; m.age = 1; b.mob = m; m.riding = b; }
      for (let i = 0; i < 60; i++) BF.boats.update(0.001);
      for (let i = 0; i < 20; i++) BF.mobs.update(0.05);
      for (let i = 0; i < 60; i++) BF.boats.update(0.001);
      return { n: made.length, D: Math.max(7, (made.length * 2.2 + 2) / 2.2) };
    } },
    { name: "bees", setup: ({ st }) => {
      const L = BF.bees.list;
      BF.warp.advance(1000 - (BF.warp.renderNow ? BF.warp.renderNow() : BF.simNow()));   // the wings flap with the drawn game time
      for (let i = 0; i < 10; i++) {
        const b = { x: st.x + 0.5 - 3 + i * 0.7, y: st.y + 0.8 + (i % 3) * 0.4, z: st.z - 3 + 0.5, yaw: i * 0.7, phase: i * 1.3, mode: "fly", land: null, landYaw: 0 };
        if (i >= 7) { b.mode = "land"; b.land = i === 9 ? { nx: 0, ny: 0, nz: 1 } : { nx: 0, ny: 1, nz: 0 }; b.landYaw = i * 0.9; b.y = i === 9 ? st.y + 1.5 : st.y; if (i === 9) b.z = st.z - 7 + 1.02; }
        L.push(b);
      }
      const mesh = BF.scene.getObjectByName("bees");
      if (mesh) mesh.position.x += 1;   // (before the split: makes the bee mesh redraw)
      return { n: L.length, D: 5 };
    } },
    { name: "leads", setup: ({ st }) => {
      const W = BF.world, B = BF.B, H = BF.horses, fence = B.oak_fence != null ? B.oak_fence : B.fence;
      W.setBlock(st.x - 4, st.y, st.z - 4, fence);
      const a = H.spawn(st.x - 1.5, st.y, st.z - 3.5, { coat: "brown", mark: "none", tamed: true });
      const b = H.spawn(st.x + 3.5, st.y, st.z - 3.5, { coat: "white", mark: "none", tamed: true });
      const c = H.spawn(st.x + 0.5, st.y, st.z - 1.5, { coat: "black", mark: "none", tamed: true });
      const v = BF.mobs.spawn("villager", st.x + 6.5, st.y, st.z - 2.5, "stable_hand", "plains");
      for (const m of [a, b, c, v]) { m.rider = {}; m.yaw = 0; m.walkPhase = 0; m.walkAmt = 0; m.headYaw = 0; m.headPitch = 0; }
      H.leash(a, { x: st.x - 4, y: st.y, z: st.z - 4 });
      H.leash(b, v);
      H.leash(c, "player");
      for (let i = 0; i < 20; i++) BF.mobs.update(0.05);
      for (const m of [a, b, c, v]) m.age = 1;
      BF.mobs.update(0.001);
      return { n: 3, D: 8 };
    } },
  ];

  if (RECORD) fs.mkdirSync(DIR, { recursive: true });
  const results = [];
  for (const shot of shots) {
    await pg.evaluate(CLEAR);
    const info = await pg.evaluate(`(${shot.setup})(${JSON.stringify({ st: stage })})`);
    await pg.evaluate(({ st, D }) => {
      BF.sky.setTime(0.25);
      BF.player.position.set(st.x + 0.5, st.y + 0.6, st.z - 3 + 0.5 + D);
      BF.player.setLook(0, -0.12);
    }, { st: stage, D: info.D });
    await pg.waitForTimeout(600);
    const buf = await pg.screenshot({ clip: { x: 0, y: 220, width: 1280, height: 380 } });
    const r = await compare(pg, buf, RECORD || !fs.existsSync(path.join(DIR, shot.name + ".jpg")) ? null : fs.readFileSync(path.join(DIR, shot.name + ".jpg")).toString("base64"));
    if (RECORD) { fs.writeFileSync(path.join(DIR, shot.name + ".jpg"), Buffer.from(r.png, "base64")); console.log("recorded " + shot.name + " " + JSON.stringify(info)); continue; }
    fs.writeFileSync(out + "-" + shot.name + ".jpg", Buffer.from(r.png, "base64"));
    if (r.frac == null) { ok(shot.name + ": has a baseline", false); continue; }
    if (r.frac > FRAC) fs.writeFileSync(out + "-" + shot.name + "-diff.png", Buffer.from(r.diffPng, "base64"));
    results.push({ name: shot.name, frac: +r.frac.toFixed(5), mean: +r.mean.toFixed(3) });
    ok(`${shot.name}: looks as before (${(r.frac * 100).toFixed(2)}% of pixels differ, mean ${r.mean.toFixed(2)})`, r.frac <= FRAC, info);
  }

  // ---- effects, as data ----
  await pg.evaluate(CLEAR);
  const effects = {};
  const EFFECTS = {
    crumbs: ({ st }) => { BF.villageLife.particles(st.x + 0.5, st.y + 1.4, st.z - 3, "#b98a3a", 6, 0.25); BF.villageLife.particles(st.x + 2.5, st.y + 1.0, st.z - 3, "#2fd06a", 5, 0.4); },
    puff: ({ st }) => {
      const pig = BF.mobs.spawn("pig", st.x + 0.5, st.y, st.z - 3);
      BF.mobs.hurt(pig, 100, "a test");   // not by the player: no drops
      pig.deathT = 1.0;
      BF.mobs.update(1e-4);   // past 1 s dead: it goes in a puff
    },
  };
  for (const [name, fn] of Object.entries(EFFECTS)) {
    // in one go, so nothing else draws from the seeded stream: the effect is made, and (after the split) played at once
    await pg.evaluate(`(() => {
      window.__before = new WeakSet();   // (by the objects themselves: Three.js makes uuids with Math.random, seeded here)
      BF.scene.traverse(o => window.__before.add(o));
      let s = 12345;
      const rand = Math.random;
      Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
      try {
        (${fn})(${JSON.stringify({ st: stage })});
        if (BF.entityView) BF.entityView.render(0, 0);
      } finally { Math.random = rand; }
    })()`);
    await pg.waitForTimeout(400);
    effects[name] = await pg.evaluate(() => {
      const r = v => Math.round(v * 1000) / 1000, a = [];
      BF.scene.traverse(o => {
        if (window.__before.has(o) || !(o.isMesh || o.isSprite) || o.name === "bees") return;
        const g = o.geometry && o.geometry.parameters, c = o.material && o.material.color;
        a.push({ kind: o.isSprite ? "sprite" : "mesh", at: [r(o.position.x), r(o.position.y), r(o.position.z)], size: g && g.width ? r(g.width) : null,
          color: c ? c.getHexString() : null, scale: r(o.scale.x) });
      });
      return a;
    });
  }
  const effFile = path.join(DIR, "effects.json");
  if (RECORD) { fs.writeFileSync(effFile, JSON.stringify(effects, null, 1)); console.log("RECORDED " + shots.length + " shots and " + Object.keys(effects).length + " effects"); return; }
  const base = fs.existsSync(effFile) ? JSON.parse(fs.readFileSync(effFile, "utf8")) : {};
  for (const [name, a] of Object.entries(effects)) {
    const b = base[name] || [];
    // the same particles, where they were and as big; a puff's scale is left out (before the split a puff shrank in the step that made it)
    const same = a.length === b.length && a.every((e, i) => e.kind === b[i].kind && e.size === b[i].size && e.color === b[i].color &&
      e.at.every((v, k) => Math.abs(v - b[i].at[k]) < 0.01) && (name === "puff" || Math.abs(e.scale - b[i].scale) < 0.001));
    ok(`${name}: the same ${b.length} particles as before`, b.length > 0 && same, { now: a.slice(0, 3), before: b.slice(0, 3), n: [a.length, b.length] });
  }

  if (split) {
    // ---- a drop picked up is gone on the next frame ----
    const gone = await pg.evaluate(async ({ st }) => {
      const d = BF.drops.spawn(BF.I.diamond, 1, st.x + 0.5, st.y + 0.01, st.z - 3, { vel: new THREE.Vector3(0, 0, 0), pickupDelay: 1e9 });
      await new Promise(r => setTimeout(r, 400));
      const before = !!BF.entityView.viewOf(d);
      BF.drops.remove(d);
      await new Promise(r => setTimeout(r, 400));
      return { before, after: !!BF.entityView.viewOf(d) };
    }, { st: stage });
    ok("a drop's sprite is drawn, and gone the frame after it is picked up", gone.before && !gone.after, gone);
    // ---- effect events: builder dust and hearts are drawn ----
    const fx = await pg.evaluate(async ({ st }) => {
      const n0 = BF.entityView.count().effects;
      BF.fx.emit({ kind: "dust", x: st.x, y: st.y, z: st.z - 3, block: BF.B.oak_planks });
      BF.fx.emit({ kind: "heart", x: st.x + 0.5, y: st.y + 2, z: st.z - 3 });
      await new Promise(r => setTimeout(r, 400));
      return { n0, n1: BF.entityView.count().effects };
    }, { st: stage });
    ok("builder dust (5 bits) and a heart are drawn from their events", fx.n1 - fx.n0 === 6, fx);
  }
  console.log("RESULTS " + JSON.stringify(results));
  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASSED");
};

// Half size, through a JPEG; compared with the baseline (a JPEG, base64) in the page. Both go through the same JPEG, so an unchanged
// picture compares exactly equal.
async function compare(pg, buf, base) {
  return pg.evaluate(async ({ b64, base, PIX }) => {
    const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
    const im = await load("data:image/png;base64," + b64);
    const c = document.createElement("canvas"); c.width = im.width / 2; c.height = im.height / 2;
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, c.width, c.height);
    const png = c.toDataURL("image/jpeg", 0.9).split(",")[1];
    if (!base) return { png };
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
  }, { b64: buf.toString("base64"), base, PIX });
}
