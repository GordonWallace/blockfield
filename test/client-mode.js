// @ci integration suite=ui timeout=600
// Client render mode (spec r15-37): the page draws from the protocol's mirror and queries, and everything looks as before. On a stone
// stage high above the spawn, facing a stone wall, the test photographs the HUD (hotbar, hearts, hunger), the villager hover card, a
// villager's trade screen, a chest screen and a map's full-screen view, and compares each (half size, a JPEG) with the baseline in
// test/baselines/client-mode/, taken on release-1-5 before this spec; the F3 overlay's text is compared too (without the figures that
// change from run to run: fps, chunk counts, draw calls, the meter and request lines). The warp is frozen and the villager held still
// (a stand-in rider, as test/mob-render-split.js). Then, on this branch only:
//   - the chest screen updates live while open (a villager's chest request moves an item: the screen shows it within a second);
//   - a slow answer: with the client's query delayed by 500 ms, the trade screen says "Waiting for the world" and then shows the offers;
//   - sounds come from the protocol's events (a block broken and a chest opened reach js/audio.js as sound entries).
// Record new baselines (on release-1-5): CLIENT_MODE_RECORD=1 NODE_PATH=$(npm root -g) node test/run.js /tmp/cm test/client-mode.js
// Usage: NODE_PATH=$(npm root -g) node test/run.js /tmp/cm test/client-mode.js
const fs = require("fs"), path = require("path");
const DIR = path.join(__dirname, "baselines", "client-mode");
const RECORD = !!process.env.CLIENT_MODE_RECORD;
// a pixel differs when a channel is off by more than PIX; a photo fails when more than FRAC of its pixels differ
const PIX = 32, FRAC = 0.002;
module.exports = async (pg, out) => {
  const fails = [];
  const ok = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + "  " + JSON.stringify(extra === undefined ? "" : extra)); if (!cond) fails.push(name); };
  await require("./lib").ready(pg);
  // the same fonts on every computer: CI downloads the page's Google Fonts, a sandbox without the network falls back to the system's
  await pg.evaluate(() => { const r = document.documentElement.style; r.setProperty("--display", '"DejaVu Sans Mono", monospace'); r.setProperty("--mono", '"DejaVu Sans Mono", monospace'); });
  const frames = n => pg.evaluate(k => new Promise(res => { let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

  // ---- the stage: floor, a wall to face, a chest, a villager held still ----
  const st = await pg.evaluate(() => {
    BF.player.start && BF.player.start();
    if (BF.player.setGameMode) BF.player.setGameMode("survival"); else BF.player.gameMode = "survival";
    BF.warp.freeze();
    BF.mobs.spawning = false;
    if (BF.weather && BF.weather.set) BF.weather.set("clear", 1e6);
    BF.sky.setTime(0.25);
    for (const m of BF.mobs.list.slice()) BF.mobs.discard(m);
    const sp = BFT.spawn(), W = BF.world, B = BF.B;
    const y0 = Math.min(BF.H - 30, BF.worldgen.heightAt(sp.x, sp.z) + 30);
    for (let x = sp.x - 24; x <= sp.x + 24; x++) for (let z = sp.z - 8; z <= sp.z + 8; z++) W.setBlock(x, y0 - 1, z, B.stone);
    for (let x = sp.x - 24; x <= sp.x + 24; x++) for (let y = y0; y < y0 + 22; y++) W.setBlock(x, y, sp.z - 8, B.stone);
    W.setBlock(sp.x + 3, y0, sp.z - 3, B.chest);
    return { x: sp.x, y: y0, z: sp.z, chest: { x: sp.x + 3, y: y0, z: sp.z - 3 } };
  });
  await pg.waitForTimeout(3000);   // remesh
  const place = () => pg.evaluate(({ st }) => {
    BF.player.position.set(st.x + 0.5, st.y, st.z + 2.5);
    BF.player.setLook(0, 0);
    BF.sky.setTime(0.25);
  }, { st });
  const shoot = async (name, clip) => {
    await pg.waitForTimeout(500);
    const buf = await pg.screenshot(clip ? { clip } : {});
    const base = RECORD || !fs.existsSync(path.join(DIR, name + ".jpg")) ? null : fs.readFileSync(path.join(DIR, name + ".jpg")).toString("base64");
    const r = await pg.evaluate(async ({ b64, base, PIX }) => {
      const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
      const im = await load("data:image/png;base64," + b64);
      const c = document.createElement("canvas"); c.width = im.width / 2; c.height = im.height / 2;
      const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, c.width, c.height);
      const png = c.toDataURL("image/jpeg", 0.9).split(",")[1];
      if (!base) return { png };
      const ci = await load("data:image/jpeg;base64," + png);   // both through the same JPEG: an unchanged picture compares exactly equal
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
    if (RECORD) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, name + ".jpg"), Buffer.from(r.png, "base64")); console.log("recorded " + name); return; }
    fs.writeFileSync(out + "-" + name + ".jpg", Buffer.from(r.png, "base64"));
    if (r.frac == null) { ok(name + ": has a baseline", false); return; }
    if (r.frac > FRAC) fs.writeFileSync(out + "-" + name + "-diff.png", Buffer.from(r.diffPng, "base64"));
    ok(`${name}: looks as before (${(r.frac * 100).toFixed(2)}% of pixels differ, mean ${r.mean.toFixed(2)})`, r.frac <= FRAC);
  };

  // ---- 1. the HUD ----
  await pg.evaluate(() => {
    const I = BF.I, inv = BF.inventory;
    const items = ["iron_pickaxe", "oak_planks", "torch", "bread", "stone", "chest", "wheat", "bow", "arrow"];
    items.forEach((n, i) => inv.setSlot(i, I[n] != null ? { id: I[n], count: n.endsWith("pickaxe") || n === "bow" ? 1 : 10 + i } : null));
    inv.select(2);
    for (const e of document.querySelectorAll(".bfp-start, .bfp-title")) e.style.display = "none";
  });
  await place(); await frames(10);
  await shoot("hud");

  // ---- 2. the villager hover card ----
  await pg.evaluate(({ st }) => {
    const M = BF.mobs, v = M.spawn("villager", st.x + 0.5, st.y, st.z - 1.5, "toolsmith", "plains");
    v.rider = {}; v.yaw = 0; v.headYaw = 0; v.headPitch = 0; v.walkPhase = 0; v.walkAmt = 0;
    v.vname = "Test Villager";   // (a fixed name: a villager without a village is named in the order names are asked for)
    v.level = 2; v.xp = 15;
    v.trades = [1, 2, 3].flatMap(l => BF.trades.offers("toolsmith", l));
    window.__v = v;
    for (let i = 0; i < 20; i++) { BF.sky.setTime(0.25); M.update(0.05); }
    v.age = 1;
  }, { st });
  await place();
  await pg.evaluate(() => { const v = window.__v, e = BF.player.eyePos(), dx = v.position.x - e.x, dy = v.position.y + 1.2 - e.y, dz = v.position.z - e.z; BF.player.setLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))); });
  await frames(20);
  const card = await pg.evaluate(() => { const el = document.querySelector(".bfv-hover"); return el && getComputedStyle(el).display !== "none" ? el.textContent : null; });
  ok("the hover card shows", !!card, card);
  await shoot("hover", { x: 340, y: 0, width: 600, height: 120 });

  // ---- 3. the trade screen ----
  await pg.evaluate(() => { BF.inventory.openTrade(window.__v); });
  await frames(5);
  await shoot("trade");
  await pg.evaluate(() => BF.inventory.close());
  await frames(3);

  // ---- 4. a chest ----
  await pg.evaluate(({ st }) => {
    const c = st.chest, I = BF.I;
    for (const [n, k] of [["cobblestone", 40], ["oak_log", 12], ["iron_ingot", 5], ["bread", 7], ["torch", 30]]) if (I[n] != null) BF.inventory.chestAdd(c.x, c.y, c.z, I[n], k);
    BF.inventory.open("chest", c);
  }, { st });
  await frames(5);
  await shoot("chest");

  // live updates while open (r15-37): a villager's chest request takes the bread; the screen shows it within a second
  if (!RECORD) {
    const live = await pg.evaluate(async ({ st }) => {
      const c = st.chest, I = BF.I, v = window.__v;
      const before = BF.inventory.views ? JSON.stringify(BF.inventory.views().chest && BF.inventory.views().chest.slots) : null;
      BF.req.send("chest", c.x + "," + c.y + "," + c.z, { take: [{ id: I.bread, n: 7 }] }, v);
      BF.req.apply(); BF.req.deliver();
      await new Promise(r => setTimeout(r, 1000));
      const now = BF.inventory.views().chest;
      return { before: before && before.includes(String(I.bread)), after: !!now && !now.slots.some(s => s && s.id === I.bread), drawn: [...document.querySelectorAll(".bf-chest .bf-slot img")].length };
    }, { st }).catch(e => ({ error: String(e) }));
    ok("the chest screen updates live while open (a villager took the bread)", live.before && live.after, live);
  }
  await pg.evaluate(() => BF.inventory.close());
  await frames(3);

  // ---- 5. a map ----
  await pg.evaluate(() => {
    const p = BF.player.position, id = BF.maps.filledIdAt(1, p.x, p.z), it = BF.items[id], d = BF.maps.dataOfItem(it);
    for (let i = 0; i < 400; i++) BF.maps.explore(d, p.x, p.z, 1e6);
    BF.inventory.setSlot(8, { id, count: 1 });
    window.__map = it;
    BF.mapview.open(it);
  });
  await frames(10);
  await shoot("map");
  await pg.evaluate(() => BF.mapview.close());
  await frames(3);

  // ---- 6. the F3 overlay, as text ----
  await place();
  await pg.keyboard.press("F3");
  await frames(10);
  const f3 = await pg.evaluate(() => document.getElementById("debug").textContent.split("\n")
    .filter(l => !/^(Blockfield|Chunks|Sim |Requests|Shared memory)/.test(l))
    .map(l => l.replace(/Calls \d+/, "Calls -").replace(/Mobs \d+/, "Mobs -").replace(/\d+ sim villages?, \d+ kept chunks/, "sims").replace(/[\d.]+ms$/, "ms")).join("\n"));
  await pg.keyboard.press("F3");
  const f3File = path.join(DIR, "f3.txt");
  if (RECORD) fs.writeFileSync(f3File, f3);
  else {
    const base = fs.existsSync(f3File) ? fs.readFileSync(f3File, "utf8") : null;
    ok("F3 shows the same as before", base === f3, { now: f3, before: base });
  }

  // ---- 7. r15-44: the inventory, crafting table, furnace and creative screens, with items moved by the player's requests ----
  const click = (c, i, button, shift) => pg.evaluate(a => BF.req.player("player.click", null, a), { c, i, button: button || 0, shift: !!shift });
  await place();
  await pg.evaluate(() => BF.inventory.open("inventory"));
  await frames(3);
  await click("inv", 1); await click("grid", 0, 2); await click("grid", 2, 2); await click("inv", 1);   // two planks stacked: sticks
  await frames(5);
  await shoot("inventory");
  await pg.evaluate(() => BF.inventory.close());
  await frames(3);
  await pg.evaluate(() => BF.inventory.open("crafting"));
  await frames(3);
  await click("inv", 1); for (const g of [0, 1, 3, 4]) await click("grid", g, 2); await click("inv", 1);   // 2x2 planks: a crafting table
  await frames(5);
  await shoot("crafting");
  await pg.evaluate(() => BF.inventory.close());
  await frames(3);
  const fpos = await pg.evaluate(({ st }) => {
    const p = { x: st.x - 3, y: st.y, z: st.z + 6 }, I = BF.I;   // behind the player
    BF.world.setBlock(p.x, p.y, p.z, BF.B.furnace);
    const f = BF.inventory.furnaceRecord(p.x, p.y, p.z);
    f.slots = [{ id: I.raw_beef, count: 5 }, null, { id: I.steak, count: 3 }]; f.burn = 0; f.burnMax = 0; f.cook = 0;
    BF.inventory.open("furnace", p);
    return p;
  }, { st });
  await frames(5);
  await shoot("furnace");
  await pg.evaluate(() => BF.inventory.close());
  await frames(3);
  await pg.evaluate(() => { BF.player.setGameMode("creative"); BF.inventory.open("inventory"); });
  await frames(5);
  await shoot("creative");
  await pg.evaluate(() => { BF.inventory.close(); BF.player.setGameMode("survival"); });
  await frames(3);
  if (RECORD) { console.log("RECORDED"); return; }

  // ---- a slow answer: the screen waits, then shows the offers ----
  const slow = await pg.evaluate(async () => {
    const C = BF.client, q = C.query;
    // answers 2 s late; the page checks its wait once a frame, and CI's software rendering draws only a few frames a second
    C.query = (what, args, fn) => q(what, args, r => setTimeout(() => fn(r), 2000));
    try {
      BF.inventory.openTrade(window.__v);
      const t0 = performance.now(), sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitEl = () => document.querySelector(".bf-wait"), shown = () => { const e = waitEl(); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; };
      let waiting = false, early = false, offers0 = 0;
      while (performance.now() - t0 < 1800) {
        if (shown()) { waiting = true; early = performance.now() - t0 < 300; offers0 = document.querySelectorAll(".bf-offer").length; break; }
        await sleep(25);
      }
      while (performance.now() - t0 < 5000 && !document.querySelectorAll(".bf-offer").length) await sleep(50);
      await sleep(300);
      const offers1 = document.querySelectorAll(".bf-offer").length, after = !shown();
      return { waiting: waiting && !early, offers0, offers1, after };
    } finally { C.query = q; BF.inventory.close(); }
  });
  ok("a slow trade answer: \"Waiting for the world\" after 300 ms, then the offers", slow.waiting && slow.offers0 === 0 && slow.offers1 > 0 && slow.after, slow);

  // ---- sounds come from the protocol's events ----
  const snd = await pg.evaluate(({ st }) => {
    const got = [];
    BF.proto.listen(list => { for (const e of list) if (e.kind === "sound") got.push(e.ev); });
    BF.emit("blockBroken", st.x, st.y - 1, st.z, BF.B.stone);
    BF.emit("chestOpened", st.chest.x, st.chest.y, st.chest.z);
    BF.proto.flush(true);
    return got;
  }, { st });
  ok("sounds reach the client as events", snd.includes("blockBroken") && snd.includes("chestOpened"), snd);

  console.log(fails.length ? "FAILED: " + fails.length : "ALL PASS");
};
