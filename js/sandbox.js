// Sandbox worlds and scenes (spec idea-050). A sandbox world is the planet with a grass plain for ground (js/flatgen.js; BF.state.world
// "flat"). A scene is sandbox/scenes/<name>.json: what to place around spawn (or round the player, /scene), so a thread can hand over a
// ready test world by name: localhost:8000/#sandbox=<name>.
//
// Scene file: { "description": "...", "entries": [ ... ] }. Each entry names its kind by one key, with an offset "at": [dx, dy, dz] from
// the origin (dy 0 = standing on the grass) and an optional "facing" ("north" | "east" | "south" | "west" or 0-3):
//   { "tree": "oak", "size": 5, "big": false, "red": true }   worldgen's own tree code (js/worldgen.js drawTree; kinds in TREE_KINDS)
//   { "structure": "house", "style": 0 }                      a saved design of the structure library (spec idea-051, BF.sandbox.structures)
//                                                             or a builder blueprint by type (js/blueprints.js); centred on at, door to facing
//   { "mob": "cow", "count": 3, "profession": "farmer", "child": true }   as /summon makes them
//   { "fill": "stone", "to": [dx, dy, dz] }                   a box of one block, at to to (both corners inclusive), as /fill
//   { "block": "oak_planks" }                                 one block, as /setblock
//   { "commands": ["/time set day", "/weather clear"] }      run in order after everything is placed
//   { "player": { "at": [0, 0, -8], "gameMode": "creative", "inventory": [["oak_log", 64]] } }
// A bad entry (unknown kind, block, tree or mob, out of the world) is skipped with an ERROR line naming the scene and the entry; the rest
// still places.
//
// Placing: the page works the scene out into cells and mobs and sends them to the simulation as one "stamp" player request (js/requests.js),
// so it is one block-change batch in every host (page, worker, world server) and a recorded session replays it. The simulation applies it
// only in a sandbox world. A stamp may also carry clear: {x, z, r}: the plain put back in that radius (/scene clear) and the mobs there removed.
// Game log ("sandbox"): INFO when a scene or stamp is placed or cleared, ERROR for a skipped entry, a missing scene or a refused stamp.
// API: BF.sandbox = { on(), list() -> Promise<[names]>, load(name) -> Promise<scene>, resolve(scene, origin, name) -> {cells, mobs, cmds, errors, box},
//        place(scene, {name, origin}) -> Promise<result>, open(name, opts) -> Promise<result>, clear(r, origin) -> Promise<result>,
//        stamp(data) -> Promise<result>, command(args) -> {ok, pending, done}, structures (name -> design, filled by idea-051), FACING }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const glog = (lvl, text) => { if (BF.glog) BF.glog.log(lvl, "sandbox", text); };
const on = () => !!(BF.state && BF.state.world === "flat");
const FACING = { north: 0, east: 1, south: 2, west: 3, n: 0, e: 1, s: 2, w: 3 };
const MAX_CELLS = 200000, CLEAR_R = 48, CLEAR_MAX = 128;

// ---------------------------------------------------------------- the simulation: the stamp request
function applyStamp(d) {
  if (!on()) return { ok: false, why: "not a sandbox world" };
  const W = BF.world, B = BF.B, cells = Array.isArray(d.cells) ? d.cells : [], label = String(d.label || "stamp").slice(0, 80);
  let placed = 0, same = 0, skipped = 0, cleared = 0, removed = 0, made = 0;
  if (d.clear) {
    const r = Math.max(1, Math.min(CLEAR_MAX, +d.clear.r || CLEAR_R)), cx = Math.floor(+d.clear.x), cz = Math.floor(+d.clear.z), F = BF.flatgen;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > r * r) continue;
      const x = cx + dx, z = cz + dz, c = W.loadAt(x, z);
      if (!c) continue;
      for (let y = F.TOP - 4; y < c.y1; y++) { const want = F.plainAt(y); if (W.getBlock(x, y, z) !== want && W.setBlock(x, y, z, want)) cleared++; }
    }
    if (BF.mobs && BF.mobs.list) for (const m of BF.mobs.list.slice()) {
      const p = m.position;
      if (!m.removed && p && (p.x - cx - 0.5) ** 2 + (p.z - cz - 0.5) ** 2 <= r * r) { BF.mobs.discard(m); removed++; }
    }
  }
  for (let i = 0; i + 3 < cells.length; i += 4) {
    const x = Math.floor(cells[i]), y = Math.floor(cells[i + 1]), z = Math.floor(cells[i + 2]), id = cells[i + 3] | 0;
    if (!(y >= BF.MIN_Y && y < BF.H) || !BF.blocks[id] && id !== 0 || !W.loadAt(x, z)) { skipped++; continue; }
    if (W.getBlock(x, y, z) === id) { same++; continue; }
    if (W.setBlock(x, y, z, id)) placed++; else skipped++;
  }
  for (const m of Array.isArray(d.mobs) ? d.mobs : []) {
    const n = Math.max(1, Math.min(64, m.count | 0 || 1));
    for (let k = 0; k < n; k++) {
      const x = +m.x + (n > 1 ? (k % 4) * 1.5 - 2.25 : 0), z = +m.z + (n > 1 ? Math.floor(k / 4) * 1.5 : 0);
      if (!W.loadAt(x, z)) continue;
      const mob = BF.mobs.spawn(m.type, x, +m.y, z, m.variant || undefined);
      if (!mob) continue;
      if (m.child && m.type === "villager" && BF.breeding) BF.breeding.makeChild(mob);
      made++;
    }
  }
  const bits = [placed + " blocks placed"];
  if (same) bits.push(same + " already so");
  if (skipped) bits.push(skipped + " skipped");
  if (made) bits.push(made + " mobs");
  if (d.clear) bits.push(cleared + " blocks cleared, " + removed + " mobs removed");
  glog(skipped ? "ERROR" : "INFO", "Stamp \"" + label + "\": " + bits.join(", "));
  return { ok: true, placed, same, skipped, mobs: made, cleared, removed };
}
if (BF.req) BF.req.on("stamp", req => applyStamp(req.data || {}));

// ---------------------------------------------------------------- the page: scenes
const off = (o, a) => [o.x + ((a && +a[0]) | 0), o.y + ((a && +a[1]) | 0), o.z + ((a && +a[2]) | 0)];
const blockId = name => {
  const n = String(name || "").toLowerCase().replace(/^minecraft:/, "");
  const id = BF.B[n];
  if (id == null) throw new Error("unknown block '" + name + "'");
  return id;
};
const facingOf = f => (f == null ? 0 : typeof f === "number" ? f & 3 : FACING[String(f).toLowerCase()] != null ? FACING[String(f).toLowerCase()] : 0);
// the design of a structure entry: the library's (idea-051) by name, else a builder blueprint by type; cells in the design's frame
// (x along the front, z away from it, door at z = 0 facing north)
function structureCells(e) {
  const lib = S.structures && S.structures[e.structure];
  if (lib && S.designCells) return S.designCells(lib);
  if (!BF.blueprints || !BF.blueprints.SPECS || !BF.blueprints.SPECS[e.structure]) throw new Error("unknown structure '" + e.structure + "'");
  const bp = BF.blueprints.get(e.structure, 0, e.style | 0);
  if (!bp) throw new Error("structure '" + e.structure + "' could not be drawn");
  return bp.cells.map(c => [c.x, c.y, c.z, c.id]);
}
// turns cells (design frame, door facing north) to facing f round the footprint's centre, its centre at (ox, oz), floor at oy
function placeTurned(cells, f, ox, oy, oz, out) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const c of cells) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); z0 = Math.min(z0, c[2]); z1 = Math.max(z1, c[2]); }
  const mx = Math.floor((x0 + x1) / 2), mz = Math.floor((z0 + z1) / 2);
  for (const c of cells) {
    let x = c[0] - mx, z = c[2] - mz;
    for (let i = 0; i < f; i++) { const t = x; x = -z; z = t; }
    out.push([ox + x, oy + c[1], oz + z, BF.blueprints ? BF.blueprints.rotId(c[3], f) : c[3]]);
  }
}
// scene -> { cells: [[x, y, z, id]...], mobs: [...], cmds: [...], errors: [...] }, origin {x, y (the grass's y), z}
function resolve(scene, origin, name) {
  name = name || "scene";
  const out = { cells: [], mobs: [], cmds: [], errors: [] };
  const entries = scene && Array.isArray(scene.entries) ? scene.entries : Array.isArray(scene) ? scene : null;
  if (!entries) { out.errors.push("the scene has no entries list"); return out; }
  const o = { x: Math.floor(origin.x), y: Math.floor(origin.y) + 1, z: Math.floor(origin.z) };   // dy 0: the block above the grass
  entries.forEach((e, i) => {
    const what = e && (["tree", "structure", "mob", "fill", "block", "commands", "player"].find(k => k in e));
    try {
      if (!e || typeof e !== "object") throw new Error("not an object");
      if (!what) throw new Error("unknown kind (" + Object.keys(e).join(", ") + ")");
      const [x, y, z] = off(o, e.at);
      if (what !== "commands" && what !== "player" && !(y >= BF.MIN_Y && y < BF.H)) throw new Error("out of the world (y " + y + ")");
      if (what === "tree") {
        for (const c of BF.worldgen.drawTree(String(e.tree), x, y, z, e.size, e)) out.cells.push(c);
      } else if (what === "structure") {
        placeTurned(structureCells(e), facingOf(e.facing), x, y - 1, z, out.cells);
      } else if (what === "mob") {
        const type = String(e.mob).toLowerCase();
        if (!BF.mobs || !(BF.mobs.types || []).includes(type)) throw new Error("unknown mob '" + e.mob + "'");
        if (e.profession && type === "villager" && !(BF.mobs.professions || []).includes(e.profession)) throw new Error("unknown profession '" + e.profession + "'");
        out.mobs.push({ type, x: x + 0.5, y, z: z + 0.5, count: Math.max(1, Math.min(64, e.count | 0 || 1)), variant: e.profession || e.variant || null, child: !!e.child });
      } else if (what === "fill") {
        const id = blockId(e.fill), [x2, y2, z2] = off(o, e.to || e.at);
        const ax = Math.min(x, x2), bx = Math.max(x, x2), ay = Math.min(y, y2), by = Math.max(y, y2), az = Math.min(z, z2), bz = Math.max(z, z2);
        if (ay < BF.MIN_Y || by >= BF.H) throw new Error("out of the world");
        if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > 65536) throw new Error("box too big (65536 blocks at most)");
        for (let yy = ay; yy <= by; yy++) for (let zz = az; zz <= bz; zz++) for (let xx = ax; xx <= bx; xx++) out.cells.push([xx, yy, zz, id]);
      } else if (what === "block") {
        out.cells.push([x, y, z, blockId(e.block)]);
      } else if (what === "commands") {
        for (const c of [].concat(e.commands)) out.cmds.push(String(c));
      } else if (what === "player") {
        const p = e.player || {}, [px, py, pz] = off(o, p.at);
        if (p.gameMode) out.cmds.push("/gamemode " + p.gameMode);
        if (p.at) { const c = BF.planet.canonCell(px, pz, {}); out.cmds.push("/tp face " + c.f + " " + c.u + " " + c.v + " " + py); }   // (the planet's /tp takes face coordinates)
        for (const it of p.inventory || []) out.cmds.push("/give " + [].concat(it)[0] + " " + (([].concat(it)[1] | 0) || 1));
      }
    } catch (err) {
      out.errors.push("entry " + (i + 1) + (what ? " (" + what + ")" : "") + ": " + (err && err.message || err));
    }
  });
  if (out.cells.length > MAX_CELLS) { out.errors.push("too many blocks (" + out.cells.length + "; " + MAX_CELLS + " at most): the rest left out"); out.cells.length = MAX_CELLS; }
  for (const m of out.errors) glog("ERROR", "Scene \"" + name + "\": " + m + " was skipped");
  return out;
}

// a player request as a promise of its result, in every host (the page answers at once, a worker or the world server later)
function ask(kind, data) {
  const req = BF.req.player(kind, null, data);
  if (req.delivered || !req.then) return Promise.resolve(req.result || { ok: false, why: "no answer" });
  return new Promise(res => req.then(r => res(r || { ok: false, why: "no answer" })));
}
function stamp(data) {
  return ask("stamp", data).then(r => { if (!r.ok) glog("ERROR", "Stamp \"" + (data.label || "stamp") + "\" refused: " + (r.why || "?")); return r; });
}
function runCommands(list) {
  let p = Promise.resolve();
  for (const c of list) p = p.then(() => {
    const r = BF.commands ? BF.commands.execute(c) : { ok: false };
    return r && r.pending ? r.done : r;
  });
  return p;
}
// the origin for a scene: the spawn's grass (a new world) or under the player (/scene)
function origin(at) {
  const p = at || BF.worldSpawn || BF.player.position, F = BF.flatgen;
  return { x: Math.floor(p.x), y: F ? F.TOP : BF.worldgen.heightAt(p.x, p.z), z: Math.floor(p.z) };
}
function place(scene, opts) {
  opts = opts || {};
  const name = opts.name || "scene";
  if (!on()) { glog("ERROR", "Scene \"" + name + "\" not placed: this isn't a sandbox world"); return Promise.resolve({ ok: false, why: "Scenes only work in sandbox worlds" }); }
  return preload(scene).then(() => placeLoaded(scene, opts, name));
}
function placeLoaded(scene, opts, name) {
  const o = origin(opts.origin), r = resolve(scene, o, name), flat = [];
  for (const c of r.cells) flat.push(c[0], c[1], c[2], c[3]);
  return stamp({ label: "scene " + name, cells: flat, mobs: r.mobs }).then(res => runCommands(r.cmds).then(() => {
    const out = Object.assign({}, res, { name, errors: r.errors, entries: (scene.entries || scene).length, commands: r.cmds.length });
    if (res.ok) glog("INFO", "Scene \"" + name + "\" placed at " + o.x + ", " + o.y + ", " + o.z + ": " + res.placed + " blocks, " + res.mobs + " mobs, " +
      r.cmds.length + " commands" + (r.errors.length ? ", " + r.errors.length + " entries skipped" : ""));
    BF.emit && BF.emit("scenePlaced", out);
    return out;
  }));
}
const base = () => (typeof location !== "undefined" && /^https?:/.test(location.protocol) ? "" : null);
function load(name) {
  if (!/^[\w-]{1,64}$/.test(String(name || ""))) return Promise.reject(new Error("bad scene name '" + name + "'"));
  if (typeof fetch === "undefined") return Promise.reject(new Error("no fetch here"));
  return fetch("sandbox/scenes/" + name + ".json", { cache: "no-cache" }).then(r => {
    if (!r.ok) throw new Error("no scene called '" + name + "'");
    return r.json();
  });
}
// the scene names: the run script's listing (debug/server.js), else the shipped index
function list() {
  if (base() == null) return Promise.resolve(["animals", "empty", "trees"]);
  return fetch("sandbox/api/list?dir=scenes", { cache: "no-cache" }).then(r => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(j => j.names || [], () => fetch("sandbox/scenes/index.json", { cache: "no-cache" }).then(r => r.json()).then(j => j.names || []).catch(() => []));
}
function toast(text) { if (BF.player && BF.player.actionBar) BF.player.actionBar(text); if (BF.commands) BF.commands.print(text, "err"); }
// the library designs a scene names (sandbox/structures/<name>.json, spec idea-051), fetched before it is worked out; a missing one is
// left for resolve() to report
function preload(scene) {
  const want = new Set();
  for (const e of (scene && (scene.entries || scene)) || []) if (e && typeof e.structure === "string" && /^[\w-]{1,64}$/.test(e.structure) && !S.structures[e.structure]) want.add(e.structure);
  if (!want.size || typeof fetch === "undefined") return Promise.resolve();
  return Promise.all([...want].map(n => fetch("sandbox/structures/" + n + ".json", { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)).then(d => { if (d && d.layers) S.structures[n] = d; }, () => {})));
}
function open(name, opts) {
  return load(name).then(sc => place(sc, Object.assign({ name }, opts || {})), e => {
    const m = "Scene \"" + name + "\" not found: " + (e && e.message || e);
    glog("ERROR", m);
    toast("No scene called " + name);
    return { ok: false, why: m };
  });
}
// places a scene once the world plays and the spawn's chunks are in (a new sandbox world from #sandbox=<name> or the New World screen)
function openWhenReady(name) {
  return new Promise(res => {
    let tries = 240;   // a minute of quarter seconds (counted, not timed: js/ reads no wall clock outside the files test/wallclock-lint.js lists)
    const go = () => {
      const p = BF.worldSpawn, W = BF.world;
      if (!p || !W || !W.isLoaded(p.x, p.z) || BF.preparing) { if (--tries > 0) return setTimeout(go, 250); }
      res(open(name));
    };
    setTimeout(go, 250);
  });
}
function clear(r, at) {
  if (!on()) return Promise.resolve({ ok: false, why: "Scenes only work in sandbox worlds" });
  const o = origin(at || BF.player.position);
  return stamp({ label: "clear r " + (r || CLEAR_R), cells: [], mobs: [], clear: { x: o.x, z: o.z, r: r || CLEAR_R } });
}
// /scene <name> | list | clear [radius]: worked out on the page (the scene files are the page's to fetch), placed by a stamp
function command(args) {
  const say = (t, k) => BF.commands && BF.commands.print(t, k || "ok");
  const sub = String(args[0] || "").toLowerCase();
  let done;
  if (!sub) { say("Usage: /scene <name> | /scene list | /scene clear [radius]", "err"); return { ok: false, msg: "" }; }
  if (sub === "list") done = list().then(n => { say(n.length ? "Scenes: " + n.join(", ") : "No scenes found"); return { ok: true, msg: "" }; });
  else if (!on()) { say("Scenes only work in sandbox worlds", "err"); return { ok: false, msg: "Scenes only work in sandbox worlds" }; }
  else if (sub === "clear") {
    const r = args[1] != null ? Math.floor(+args[1]) : CLEAR_R;
    if (!(r >= 1 && r <= CLEAR_MAX)) { say("The radius is 1 to " + CLEAR_MAX, "err"); return { ok: false, msg: "" }; }
    done = clear(r).then(x => { say(x.ok ? "Cleared " + x.cleared + " blocks and " + x.removed + " mobs within " + r : "Couldn't clear: " + x.why, x.ok ? "ok" : "err"); return { ok: !!x.ok, msg: "" }; });
  } else {
    const name = args[0];
    done = open(name, { origin: BF.player.position }).then(x => {
      if (x.ok) say("Placed scene " + name + ": " + x.placed + " blocks, " + x.mobs + " mobs" + (x.errors.length ? " (" + x.errors.length + " entries skipped, see the game log)" : ""));
      else if (!/not found/.test(x.why || "")) say("Couldn't place " + name + ": " + x.why, "err");
      return { ok: !!x.ok, msg: "" };
    });
  }
  return { ok: true, pending: true, msg: "", done };
}

const S = BF.sandbox = { on, list, load, resolve, place, open, openWhenReady, clear, stamp, command, applyStamp, structures: {}, designCells: null, FACING, CLEAR_R };
})();
