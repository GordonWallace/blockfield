// @ci integration suite=ui timeout=600
// Positions on the planet (generator 4, spec r14-18): F3 shows face / u / v / y, latitude / longitude and a compass facing (never atlas
// x / z); /tp takes u y v on the current face (with ~, and past an edge into the margin, landing canonical), and the planet forms face,
// lat / lon, corner, up and ground; /setblock and /summon across an edge land on the right canonical cell; the world border is the
// face square; /locate prints planet distance, direction and a /tp; the teleport panel (P) is creative only and runs /tp; the planet
// view opens with M, turns, zooms, switches to the local map and back, and travels on click in creative; auto maps stop at one face.
// node test/run.js /tmp/pc test/planet-coords.js
module.exports = async (pg, out) => {
  let bad = 0;
  const check = (ok, what) => { console.log((ok ? "ok " : "FAIL ") + what); if (!ok) bad++; };
  await pg.evaluate(async () => {
    window.__errs = []; addEventListener("error", e => window.__errs.push(e.message));
    window.settle = async (min) => {
      await new Promise(r => setTimeout(r, min || 1000));
      for (let i = 0; i < 120 && BF.world.queueLength > 0; i++) await new Promise(r => setTimeout(r, 250));
      await new Promise(r => setTimeout(r, 300));
    };
    window.tp = s => BF.commands.execute(s);
    BF.newWorld(1337, { gen: 4 }); BF.world.viewDist = 3; BF.player.start(); BF.player.setGameMode("creative");
  });
  await pg.evaluate(() => { const p = BF.player.position; window.__start = { x: p.x, y: p.y, z: p.z }; return settle(2500); });
  const N = await pg.evaluate(() => BF.planet.N);

  // ---- F3: face / u / v / y, lat / lon, facing; no atlas x / z
  const f3 = await pg.evaluate(async () => {
    const r = tp("/tp face 4 81920 81920");
    BF.player.setLook(0, 0);
    await settle(800);
    const d = BF.debugInfo(), t = BF.debugText(d);
    return { r, t, d: d.planet, x: Math.floor(BF.player.position.x) };
  });
  console.log("F3: " + f3.t.split("\n").slice(1, 4).join(" | "));
  check(f3.r.ok && /^Face 4 {2}u 81,920\.\d {2}v 81,920\.\d {2}y /m.test(f3.t), "F3 shows the face, u, v and y");
  check(/0\.00°N 0\.00°E {2}Facing /.test(f3.t) && f3.d && Math.abs(f3.d.lat) < 0.01 && Math.abs(f3.d.lon) < 0.01, "F3 shows latitude / longitude (face 4's centre is 0°N 0°E)");
  check(!f3.t.includes("XYZ") && !f3.t.includes(f3.x.toLocaleString("en-US")) && !f3.t.includes(String(f3.x)), "atlas x / z are not shown");
  // facing: face 4's centre is (0, 0, 1); the pole is +y. The grid's -v direction there should be north or south, and +u east or west.
  const facing = await pg.evaluate(() => {
    const C = BF.coords, p = BF.player.position, out = {};
    for (const [nm, yaw] of [["yaw0", 0], ["yaw90", Math.PI / 2], ["yaw180", Math.PI], ["yaw270", -Math.PI / 2]]) out[nm] = C.facing(yaw, p.x, p.z);
    out.north = C.bearing(0, -1, p.x, p.z); out.east = C.bearing(1, 0, p.x, p.z);
    // an east step really raises the longitude, a north step the latitude
    const ll0 = BF.planet.latLonAt(p.x, p.z), dE = C.bearing(1, 0, p.x, p.z) < 180 ? 1 : -1;
    const llE = BF.planet.latLonAt(p.x + 100 * dE, p.z);
    const dN = Math.abs(C.bearing(0, -1, p.x, p.z)) < 1 || Math.abs(C.bearing(0, -1, p.x, p.z) - 360) < 1 ? -1 : 1;
    const llN = BF.planet.latLonAt(p.x, p.z + 100 * dN);
    // BF.planet.north points along bearing 0, also through a turned margin address; compassPoint names
    const n = BF.planet.north(p.x, p.z);
    out.northVec = Math.abs(BF.planet.bearing(p.x, p.z, n[0], n[1])) < 1e-6 || Math.abs(BF.planet.bearing(p.x, p.z, n[0], n[1]) - 360) < 1e-6;
    const mx = BF.planet.W * 4 + BF.planet.N + BF.planet.N + 50, mz = BF.planet.N + 9000, nm = BF.planet.north(mx, mz), bm = BF.planet.bearing(mx, mz, nm[0], nm[1]);
    out.northMargin = bm < 1e-6 || 360 - bm < 1e-6;
    out.points = [BF.planet.compassPoint(44), BF.planet.compassPoint(46, true), BF.planet.compassPoint(359)].join();
    out.eastOk = llE.lon > ll0.lon && Math.abs(llE.lat - ll0.lat) < 1e-3;
    out.northOk = llN.lat > ll0.lat && Math.abs(llN.lon - ll0.lon) < 1e-3;
    return out;
  });
  console.log("facing " + JSON.stringify(facing));
  check(facing.eastOk && facing.northOk, "compass bearings agree with latitude and longitude");
  check(facing.northVec && facing.northMargin && facing.points === "north-east,NE,north", "BF.planet.north / bearing / compassPoint agree (also at a margin address)");
  check(new Set([facing.yaw0, facing.yaw90, facing.yaw180, facing.yaw270].map(s => s.split(" ")[0])).size === 4, "four quarter turns give four compass facings");

  // ---- /tp forms
  const forms = await pg.evaluate(async (N) => {
    const r = {}, P = BF.planet, here = () => P.canon(BF.player.position.x, BF.player.position.z, {});
    tp("/tp face 2 1000 2000"); r.face = Object.assign({}, here()); r.faceY = BF.player.position.y;
    r.faceGround = Math.abs(BF.player.position.y - BF.mapview.surfaceAt(Math.floor(BF.player.position.x), Math.floor(BF.player.position.z))) < 1.5;
    tp("/tp face 2 1000 2000 1500"); r.faceY2 = BF.player.position.y;
    r.uyv = tp("/tp 5000 900 6000"); r.uyvAt = Object.assign({}, here()); r.uyvY = BF.player.position.y;
    r.rel = tp("/tp ~10 ~ ~-20"); r.relAt = Object.assign({}, here());
    r.uv = tp("/tp 7000 8000"); r.uvAt = Object.assign({}, here());
    r.ll = tp("/tp 35.26N 45E"); const ll = P.latLonAt(BF.player.position.x, BF.player.position.z); r.llAt = [ll.lat, ll.lon];
    r.llS = tp("/tp 10.5S 120.25W 2000"); const l2 = P.latLonAt(BF.player.position.x, BF.player.position.z); r.llSAt = [l2.lat, l2.lon, BF.player.position.y];
    r.llBad = tp("/tp 95N 10E");
    r.corner = tp("/tp corner 3"); const c3 = BF.coords.corner(3, 0), h3 = here();
    r.cornerAt = { f: h3.f, du: Math.abs(h3.u - c3.u), dv: Math.abs(h3.v - c3.v), flying: BF.player.flying };
    // facing the corner: the forward vector points toward the corner point
    const yaw = BF.player.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), tx = c3.u - h3.u, tz = c3.v - h3.v;
    r.cornerFacing = (fx * tx + fz * tz) / Math.hypot(tx, tz);
    tp("/tp face 4 81920 81920"); await settle(500);
    const g0 = BF.mapview.surfaceAt(Math.floor(BF.player.position.x), Math.floor(BF.player.position.z)) - 1.01;   // the ground, or the water over it
    r.up = tp("/tp up 5000"); r.upY = BF.player.position.y - g0; r.upFly = BF.player.flying;
    r.ground = tp("/tp ground"); r.groundY = BF.player.position.y - g0;
    r.big = tp("/tp up 25000"); r.bigY = BF.player.position.y - g0;
    tp("/tp ground");
    r.border = tp(`/tp ${2 * N + 5} 800 100`);
    r.borderOk = tp(`/tp ${N + 300} 900 100`); r.borderAt = Object.assign({}, here());
    return r;
  }, N);
  console.log("tp " + JSON.stringify({ face: [forms.face.f, forms.face.u, forms.face.v], uyv: forms.uyv.msg, rel: forms.rel.msg, ll: forms.llAt, llS: forms.llSAt, corner: forms.cornerAt, cf: forms.cornerFacing, up: forms.upY, ground: forms.groundY, border: forms.border.msg, borderAt: [forms.borderAt.f, forms.borderAt.u, forms.borderAt.v] }));
  check(forms.face.f === 2 && Math.abs(forms.face.u - 1000.5) < 1e-6 && Math.abs(forms.face.v - 2000.5) < 1e-6 && forms.faceGround, "/tp face 2 1000 2000 lands on the surface there");
  check(Math.abs(forms.faceY2 - 1500) < 1e-6, "/tp face f u v y takes the layer");
  check(forms.uyv.ok && forms.uyvAt.f === 2 && Math.abs(forms.uyvAt.u - 5000.5) < 1e-6 && Math.abs(forms.uyvAt.v - 6000.5) < 1e-6 && forms.uyvY === 900 && /face 2 {2}u 5,000\.5 {2}v 6,000\.5 {2}y 900/.test(forms.uyv.msg), "/tp u y v works on the current face and reports face / u / v / y");
  check(forms.rel.ok && Math.abs(forms.relAt.u - 5010.5) < 1e-6 && Math.abs(forms.relAt.v - 5980.5) < 1e-6, "/tp ~10 ~ ~-20 is relative on the face");
  check(forms.uv.ok && forms.uvAt.f === 2 && Math.abs(forms.uvAt.u - 7000.5) < 1e-6, "/tp u v goes to the surface on the current face");
  check(forms.ll.ok && Math.abs(forms.llAt[0] - 35.26) < 0.01 && Math.abs(forms.llAt[1] - 45) < 0.01, "/tp 35.26N 45E lands at that latitude / longitude");
  check(forms.llS.ok && Math.abs(forms.llSAt[0] + 10.5) < 0.01 && Math.abs(forms.llSAt[1] + 120.25) < 0.01 && forms.llSAt[2] === 2000, "/tp 10.5S 120.25W 2000 takes S / W and a layer");
  check(!forms.llBad.ok, "a latitude past 90 is refused");
  check(forms.corner.ok && forms.cornerAt.du <= 41 && forms.cornerAt.dv <= 41 && forms.cornerAt.du >= 39 && forms.cornerAt.flying && forms.cornerFacing > 0.99, "/tp corner 3 lands 40 blocks in from the corner, flying, facing it");
  check(forms.up.ok && Math.abs(forms.upY - 5000) < 2 && forms.upFly, "/tp up 5000 goes 5,000 blocks above the ground, flying");
  check(forms.ground.ok && forms.groundY > 0 && forms.groundY < 3, "/tp ground comes back down");
  check(forms.big.ok && Math.abs(forms.bigY - 25000) < 2, "/tp up 25000 reaches off-planet height");
  check(!forms.border.ok && /off the planet/.test(forms.border.msg), "past the face's margin is off the planet");
  check(forms.borderOk.ok && forms.borderAt.f !== 4 && forms.borderAt.u >= 0 && forms.borderAt.u < N, "a /tp into the margin lands on the neighbouring face (canonical)");

  // ---- a margin teleport keeps the view the same way round (yaw turned with the edge); wedge lands on the nearest point
  const edge = await pg.evaluate(async (N) => {
    const P = BF.planet, r = {};
    // face 2 (the north pole face) touches face 4 at a turned edge; find a face whose +v margin is a turned edge
    let best = null;
    for (let f = 0; f < 6 && !best; f++) for (const [mu, mv] of [[N / 2, N + 100], [N / 2, -100], [N + 100, N / 2], [-100, N / 2]]) {
      const c = P.canon(P.W * f + N + mu, N + mv, {});
      if (c.turn) { best = { f, mu, mv }; break; }
    }
    r.best = best;
    tp(`/tp face ${best.f} ${N / 2} ${N / 2} 1500`);
    BF.player.setLook(0.3, 0);
    const b0 = BF.coords.bearing(-Math.sin(0.3), -Math.cos(0.3), BF.player.position.x, BF.player.position.z);
    // the same spot just across the edge, typed as margin coordinates: the compass facing should be (nearly) unchanged
    const near = [best.mu === N / 2 ? N / 2 : best.mu < 0 ? -1 : N, best.mv === N / 2 ? N / 2 : best.mv < 0 ? -1 : N];
    tp(`/tp face ${best.f} ${Math.min(N - 1, Math.max(0, near[0]))} ${Math.min(N - 1, Math.max(0, near[1]))} 1500`);
    const bA = BF.coords.bearing(-Math.sin(BF.player.yaw), -Math.cos(BF.player.yaw), BF.player.position.x, BF.player.position.z);
    const res = tp(`/tp ${near[0] + (best.mu === N / 2 ? 0 : best.mu < 0 ? -2 : 2)} 1500 ${near[1] + (best.mv === N / 2 ? 0 : best.mv < 0 ? -2 : 2)}`);
    const c = P.canon(BF.player.position.x, BF.player.position.z, {});
    const bB = BF.coords.bearing(-Math.sin(BF.player.yaw), -Math.cos(BF.player.yaw), BF.player.position.x, BF.player.position.z);
    r.res = res; r.canonical = c.x === BF.player.position.x && c.z === BF.player.position.z && c.f !== best.f;
    r.dBearing = Math.abs(((bB - bA + 540) % 360) - 180); r.b0 = b0;
    // wedge: past two edges at once
    tp(`/tp face 4 10 10 1500`);
    r.wedge = tp(`/tp -50 1500 -50`);
    const w = P.canon(BF.player.position.x, BF.player.position.z, {});
    r.wedgeAt = { canon: w.x === BF.player.position.x && w.z === BF.player.position.z, wedge: w.wedge, off: w.off, f: w.f };
    return r;
  }, N);
  console.log("edge " + JSON.stringify(edge));
  check(edge.res.ok && edge.canonical && edge.dBearing < 2, "a /tp across a turned edge lands canonical and keeps the compass facing");
  check(edge.wedge.ok && edge.wedgeAt.canon && !edge.wedgeAt.wedge && !edge.wedgeAt.off, "a /tp into a corner wedge lands on the nearest point on a face");

  // ---- far teleports keep the compass facing
  const far = await pg.evaluate(() => {
    tp("/tp face 4 81920 81920 1500"); BF.player.setLook(0.8, 0);
    const p = BF.player.position, b0 = BF.coords.bearing(-Math.sin(0.8), -Math.cos(0.8), p.x, p.z);
    tp("/tp face 2 40000 90000 1500");
    const q = BF.player.position, b1 = BF.coords.bearing(-Math.sin(BF.player.yaw), -Math.cos(BF.player.yaw), q.x, q.z);
    return { b0, b1 };
  });
  check(Math.abs(((far.b1 - far.b0 + 540) % 360) - 180) < 0.5, `a far /tp keeps the compass facing (${far.b0.toFixed(1)} -> ${far.b1.toFixed(1)})`);

  // ---- /setblock and /summon across an edge
  const sb = await pg.evaluate(async (N) => {
    const P = BF.planet, r = {};
    tp(`/tp face 4 ${N - 6} 81920`); await settle(1500);
    const y = Math.floor(BF.player.position.y) + 3;
    r.set = tp(`/setblock ${N + 2} ${y} 81920 glass`);
    const c = P.canonCell(P.W * 4 + N + N + 2, N + 81920, {});
    r.cell = [c.f, c.u, c.v];
    r.got = BF.world.getBlock(c.x, y, c.z) === BF.B.glass;
    r.viaMargin = BF.world.getBlock(P.W * 4 + N + N + 2, y, N + 81920) === BF.B.glass;
    r.sum = tp(`/summon pig ${N + 3} ${y + 1} 81920`);
    const pig = BF.mobs.list.filter(m => m.type === "pig").pop();
    const pc = pig ? P.canon(pig.position.x, pig.position.z, {}) : null;
    r.pig = pc ? { f: pc.f, canonical: pc.x === pig.position.x } : null;
    r.fill = tp(`/fill ${N - 2} ${y + 5} 81918 ${N + 2} ${y + 5} 81922 stone`);
    // stand 300 blocks from a village near spawn (the nearest is 835 blocks out on seed 1337, past /locate's 1.5-region reach)
    const v0 = BF.worldgen.villagesNear(__start.x, __start.z, 4000)[0];
    r.v0 = !!v0;
    if (v0) BF.player.teleport(v0.x + 300, 1500, v0.z + 120);
    const here = { x: BF.player.position.x, z: BF.player.position.z };
    r.loc = tp("/locate village");
    const v = BF.worldgen.nearestVillage(here.x, here.z), m = /(\/tp face \d \d+ \d+)/.exec(r.loc.msg || "");
    if (v && m) {
      const t = BF.planet.toward(here, v, {}), dir = BF.planet.compassPoint(BF.planet.bearing(here.x, here.z, t.x, t.z));
      r.locDir = r.loc.msg.includes("to the " + dir + ",");
      tp(m[1]); r.locArrive = BF.planet.distance(BF.player.position, v) < 2;
    }
    return r;
  }, N);
  console.log("setblock " + JSON.stringify(sb));
  check(sb.set.ok && sb.got && sb.viaMargin && sb.cell[0] !== 4 && /face \d {2}u [\d,]+ {2}v [\d,]+ {2}y \d+/.test(sb.set.msg), "/setblock past the edge writes the neighbouring face's canonical cell");
  check(sb.sum.ok && sb.pig && sb.pig.f !== 4 && sb.pig.canonical, "/summon past the edge puts the mob at its canonical point");
  check(sb.fill.ok && /25 blocks/.test(sb.fill.msg), "/fill across the edge fills both sides");
  check(sb.loc.ok && /blocks away to the (north|south|east|west|north-east|north-west|south-east|south-west), at face \d {2}u [\d,]+ {2}v [\d,]+\. \/tp face \d \d+ \d+ goes there\./.test(sb.loc.msg) && sb.locDir && sb.locArrive, "/locate village prints planet distance, direction and a /tp face that goes there");
  console.log("locate: " + sb.loc.msg);

  // ---- the teleport panel: creative only, runs /tp
  const panel = await pg.evaluate(async () => {
    const r = {};
    BF.player.setGameMode("survival");
    r.survival = BF.coords.panel.open();
    BF.player.setGameMode("creative");
    tp("/tp face 4 81920 81920");
    r.creative = BF.coords.panel.open();
    r.screen = BF.player.screenOpen();
    const el = document.querySelector(".bft-wrap.open");
    r.buttons = el ? el.querySelectorAll("button").length : 0;
    el.querySelectorAll('[data-a="corners"] button')[4].click();
    r.closedAfterCorner = !BF.coords.panel.isOpen();
    const c5 = BF.coords.corner(5, 0), h = BF.planet.canon(BF.player.position.x, BF.player.position.z, {});
    r.atCorner = h.f === c5.f && Math.abs(h.u - c5.u) < 45 && Math.abs(h.v - c5.v) < 45;
    BF.coords.panel.open();
    r.bad = BF.coords.panel.go("nowhere special");
    r.stillOpen = BF.coords.panel.isOpen();
    r.msg = document.querySelector(".bft-msg").textContent;
    BF.coords.panel.go("face 1 100 200");
    const h2 = BF.planet.canon(BF.player.position.x, BF.player.position.z, {});
    r.typed = h2.f === 1 && Math.floor(h2.u) === 100 && Math.floor(h2.v) === 200 && !BF.coords.panel.isOpen();
    return r;
  });
  console.log("panel " + JSON.stringify(panel));
  check(!panel.survival && panel.creative && panel.screen && panel.buttons >= 14, "the teleport panel opens in creative only, as a screen, with corner and height buttons");
  check(panel.closedAfterCorner && panel.atCorner, "a corner button teleports to that corner and closes the panel");
  check(!panel.bad && panel.stillOpen && /Usage|Invalid|Expected|Unknown|coordinate/i.test(panel.msg) && panel.typed, "typed text runs as /tp (errors stay in the panel)");
  // the P key opens it (and Escape closes it)
  await pg.evaluate(() => { BF.coords.panel.close(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await pg.keyboard.press("p");
  const pKey = await pg.evaluate(() => BF.coords.panel.isOpen());
  await pg.keyboard.press("Escape");
  const escClosed = await pg.evaluate(() => !BF.coords.panel.isOpen());
  check(pKey && escClosed, "P opens the teleport panel and Escape closes it");

  // ---- the planet view
  const gv = await pg.evaluate(async () => {
    const r = {}, M = BF.mapview, G = M.planet;
    BF.coords.panel.close();
    tp("/tp face 4 81920 81920");
    r.open = G.open();
    r.screen = BF.player.screenOpen();
    const t0 = performance.now(); G.finishBase(); r.baseMs = Math.round(performance.now() - t0);
    G.draw();
    const S = G.state.S, cv = document.querySelector(".bfm-wrap.open canvas"), g = cv.getContext("2d");
    const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
    r.centre = px(S / 2 - 30, S / 2 - 30); r.corner = px(2, 2);
    // the player is in the middle: what is under the centre is face 4's centre
    const h = G.pick(S / 2, S / 2); r.pick = h && [h.f, h.lat, h.lon];
    // turning: a drag of a quarter of the disc moves the centre east / west by about that angle
    G.turn(0.46 * S * 0.5, 0); const h2 = G.pick(S / 2, S / 2); r.turned = h2 && [h2.lat, h2.lon];
    G.lookAt(BF.planet.dir(4, 81920, 81920, [0, 0, 0]));
    for (let i = 0; i < 30; i++) G.zoomBy(1.25);
    r.zoom = G.state.zoom;
    G.zoomBy(1.25);   // past the closest zoom: the local map
    r.local = M._view.open && !G.isOpen() && !!(M._view.it && M._view.it.fromGlobe);
    r.localTitle = document.querySelector(".bfm-title") && Array.from(document.querySelectorAll(".bfm-wrap.open .bfm-title")).map(e => e.textContent).join();
    r.screen2 = BF.player.screenOpen();
    // scroll out of it: back to the globe
    const vcv = document.querySelector(".bfm-wrap.open canvas");
    vcv.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
    r.back = G.isOpen() && !M._view.open && Math.abs(G.state.zoom - 24) < 1e-6;
    // zoomed in, the detail pass sharpens the view
    for (let i = 0; i < 400 && !(G.state.det && G.state.det.done); i++) { M.tick(); await new Promise(r => setTimeout(r, 0)); }
    r.detail = !!(G.state.det && G.state.det.done);
    // click to travel (creative)
    G.state.zoom = 1; G.lookAt(BF.planet.dir(0, 81920, 81920, [0, 0, 0])); G.draw();
    const target = G.pick(S / 2, S / 2);
    r.travel = G.clickAt(S / 2, S / 2);
    const c = BF.planet.canon(BF.player.position.x, BF.player.position.z, {});
    r.travelAt = [c.f, Math.floor(c.u), Math.floor(c.v)]; r.target = [target.f, target.u, target.v];
    r.closed = !G.isOpen() && !BF.player.screenOpen();
    // survival: opens, click selects but does not travel
    BF.player.setGameMode("survival");
    G.open(); const before = BF.player.position.x;
    r.survClick = G.clickAt(S / 2, S / 2); r.survStayed = BF.player.position.x === before && G.isOpen();
    G.close(); BF.player.setGameMode("creative");
    return r;
  });
  console.log("globe " + JSON.stringify(gv));
  check(gv.open && gv.screen && gv.baseMs < 15000, `the planet view opens as a screen (whole-planet colours in ${gv.baseMs} ms)`);
  check(gv.centre[2] > 0 && gv.centre.join() !== gv.corner.join() && gv.corner[0] < 20 && gv.corner[2] < 30, "the globe is drawn on a dark background");
  check(gv.pick && gv.pick[0] === 4 && Math.abs(gv.pick[1]) < 0.5 && Math.abs(gv.pick[2]) < 0.5, "it opens centred on the player");
  check(gv.turned && Math.abs(Math.abs(gv.turned[1]) - 28.6) < 3 && Math.abs(gv.turned[0]) < 1, "dragging turns the globe");
  check(gv.zoom === 24 && gv.local && gv.screen2 && /local map/.test(gv.localTitle), "zooming in all the way switches to the local auto map");
  check(gv.back, "scrolling out of the local map returns to the globe");
  check(gv.detail, "zoomed in, the view sharpens");
  check(gv.travel && gv.travelAt.join() === gv.target.join() && gv.closed, "clicking travels there in creative and closes the view");
  check(!gv.survClick && gv.survStayed, "in survival a click selects but does not travel");

  // M opens / closes it
  await pg.keyboard.press("m");
  const mOpen = await pg.evaluate(() => BF.mapview.planet.isOpen());
  if (out) await pg.screenshot({ path: `${out}-globe.png` });
  await pg.keyboard.press("m");
  const mClosed = await pg.evaluate(() => !BF.mapview.planet.isOpen());
  check(mOpen && mClosed, "M opens and closes the planet view");

  // ---- auto maps: at most one face wide; the corner wedges stay empty
  const am = await pg.evaluate(() => {
    const M = BF.mapview, r = {};
    r.maxK = M.zonesFor(1e9);
    tp("/tp face 4 300 300");
    const p = BF.player.position, d = M.getAuto(64, Math.floor(p.x / 128), Math.floor(p.z / 128));
    M.finish(d);
    let empty = 0, n = 0;
    for (let j = 0; j < d.N; j++) for (let i = 0; i < d.N; i++) {
      const x = Math.floor(d.x0 + (i + 0.5) * d.scale), z = Math.floor(d.z0 + (j + 0.5) * d.scale);
      if (!BF.world.canonXZ(x, z)) { n++; if (d.bio[j * d.N + i] === 255) empty++; }
    }
    r.wedge = [empty, n];
    return r;
  });
  console.log("automap " + JSON.stringify(am));
  check(am.maxK === N / 128, "an auto map on the planet is at most one face wide");
  check(am.wedge[1] > 0 && am.wedge[0] === am.wedge[1], "the corner wedge on an auto map is left empty");

  const errs = await pg.evaluate(() => window.__errs);
  check(!errs.length, "no page errors" + (errs.length ? ": " + errs.join("; ") : ""));
  console.log(bad ? `FAILED ${bad}` : "all ok");
};
