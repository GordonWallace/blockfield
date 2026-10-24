// Claude villager sight (experimental, branch exp-llm-villager): what the Sage can see from where it stands, for its look_around tool,
// and where it is, for its system prompt (js/claudevillager.js sends both; debug/claude.js defines the tool).
// Line of sight is a voxel walk like world.raycast (the DDA mobs use for hasLineOfSight), with its own rule for what blocks the view:
// opaque blocks and leaves do; air, glass, panes, fences, plants and crops don't; water lets a few blocks through. A ray stops at an
// unloaded chunk (nothing is known there).
// - Creatures: every mob within MOB_R (and the player) whose head or middle has a clear line from the Sage's eye.
// - Blocks: a sweep of rays all round (every YAW_STEP degrees, at PITCHES) out to BLOCK_R: the block each ray stops at, plus the plants,
//   crops and water it passes. Sorted into flowers, trees, crops, workstations (BF.jobs), houses (the villages' house plots) and so on.
// - Land: for each compass point, how far the view runs at eye level, what the ground is and whether it rises or falls.
// - Dark: with little daylight the range shrinks toward DARK_R, except to things standing in block light of 8 or more.
// Directions are compass points on the round planet (BF.planet.bearing), distances whole blocks. Everything is read live from the world.
// API: BF.claudeSight = { look(mob) -> { text, mobs, groups, sectors, range, rays, ms }, where(mob) -> text, clear(from, to, max?) -> bool }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const MOB_R = 96, BLOCK_R = 64, DARK_R = 16;
const YAW_STEP = 3, PITCHES = [-50, -32, -20, -12, -6, -2, 2, 6, 12, 22, 40];
const WATER_SEE = 6;     // blocks of water a ray goes through
const MAX_TEXT = 9000;

const blockName = id => { const b = BF.blocks && BF.blocks[id]; return b ? b.name : ""; };
const pretty = s => String(s).replace(/_/g, " ");
const isLeaves = id => /_leaves$/.test(blockName(id));
const isWater = id => BF.RENDER && BF.RENDER[id] === 3;
// Blocks the view: opaque cubes and leaves. Glass, panes, fences, doors, slabs, plants, torches: seen past.
const blocks = id => !!id && ((BF.OPAQUE && BF.OPAQUE[id]) || isLeaves(id));

// ---------------------------------------------------------------- rays
// Walks from o along unit d up to max blocks. pass(x, y, z, id, t) sees every non-air cell it goes through (may return true to stop).
// Returns { x, y, z, id, dist, prev: [x, y, z] } for the cell that stops it, { unloaded, dist } at an unloaded chunk, or null.
function walk(o, d, max, pass) {
  const W = BF.world, CS = BF.CS || 16;
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z), px = x, py = y, pz = z;
  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const tdx = d.x ? Math.abs(1 / d.x) : Infinity, tdy = d.y ? Math.abs(1 / d.y) : Infinity, tdz = d.z ? Math.abs(1 / d.z) : Infinity;
  let tx = d.x ? (sx > 0 ? x + 1 - o.x : o.x - x) * tdx : Infinity;
  let ty = d.y ? (sy > 0 ? y + 1 - o.y : o.y - y) * tdy : Infinity;
  let tz = d.z ? (sz > 0 ? z + 1 - o.z : o.z - z) * tdz : Infinity;
  let t = 0, cx = NaN, cz = NaN, water = 0;
  for (let i = 0; i < 400 && t <= max; i++) {
    const kx = Math.floor(x / CS), kz = Math.floor(z / CS);
    if (kx !== cx || kz !== cz) { cx = kx; cz = kz; if (!W.isLoaded(x, z)) return { unloaded: true, dist: t }; }
    const id = W.getBlock(x, y, z);
    if (id) {
      if (blocks(id)) return { x, y, z, id, dist: t, prev: [px, py, pz] };
      if (pass && pass(x, y, z, id, t)) return { x, y, z, id, dist: t, prev: [px, py, pz] };
      if (isWater(id) && ++water > WATER_SEE) return { x, y, z, id, dist: t, prev: [px, py, pz], murky: true };
    }
    px = x; py = y; pz = z;
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; } else if (ty < tz) { y += sy; t = ty; ty += tdy; } else { z += sz; t = tz; tz += tdz; }
  }
  return null;
}
// A clear line from `from` to `to` (both {x, y, z} in one frame)?
function clear(from, to, max) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, dist = Math.hypot(dx, dy, dz);
  if (dist < 0.5) return true;
  if (max != null && dist > max) return false;
  const hit = walk(from, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
  return !hit || (!hit.unloaded && hit.dist >= dist - 0.3);
}

// ---------------------------------------------------------------- directions and light
const ref = { x: 0, z: 0 }, tmp = {};
// Compass point of grid direction (dx, dz) seen from (x, z); "" at a pole or with no planet.
function compassOf(x, z, dx, dz) {
  const P = BF.planet;
  if (!P || !P.bearing) return P ? "" : ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][((Math.round((Math.atan2(dx, -dz) * 180 / Math.PI) / 45) % 8) + 8) % 8];
  const b = P.bearing(x, z, dx, dz);
  return b == null ? "" : P.compassPoint(b);
}
const sectorOf = (x, z, dx, dz) => { const P = BF.planet, b = P && P.bearing ? P.bearing(x, z, dx, dz) : (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360; return b == null ? -1 : ((Math.round(b / 45) % 8) + 8) % 8; };
const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
// A point seen from the eye's frame (across a face edge it is re-expressed; same face: unchanged).
function inEyeFrame(eye, p) {
  if (!BF.planet || !BF.planet.local) return { x: p.x, z: p.z };
  ref.x = eye.x; ref.z = eye.z;
  const o = BF.planet.local(ref, p, tmp);
  return { x: o.x, z: o.z };
}
// How far daylight lets the Sage see: BLOCK_R / MOB_R by day, shrinking toward DARK_R at night (sky light under a quarter).
function daylight() {
  const l = BF.sky && typeof BF.sky.light === "number" ? BF.sky.light : 1;
  return Math.max(0, Math.min(1, (l - 0.15) / 0.55));
}
const lit = (x, y, z) => { try { return (BF.world.getBlockLight(x, y, z) || 0) >= 8; } catch (e) { return false; } };

// ---------------------------------------------------------------- what things are
const HOSTILE = /^(zombie|skeleton|spider|creeper|witch|drowned|husk|stray|enderman|slime|phantom|pillager)/;
function mobLabel(m) {
  if (m.type === "villager") {
    const prof = m.child ? "child" : m.claudeTitle ? m.claudeTitle.toLowerCase() : m.profession === "unemployed" ? "villager without a trade" : pretty(m.profession || "villager");
    let name = null; try { name = m.vname || (BF.vlog && BF.vlog.nameOf(m)); } catch (e) { /* unnamed */ }
    let doing = null; try { doing = BF.villagerStatus && BF.villagerStatus.text(m); } catch (e) { /* no status */ }
    return { kind: "people", one: (name ? name + ", a " : "a ") + prof + (doing ? " (" + String(doing).toLowerCase() + ")" : ""), many: null };
  }
  const t = pretty(m.type || "creature");
  const baby = m.child || m.baby ? "baby " : "";
  return { kind: HOSTILE.test(m.type || "") ? "danger" : "creatures", one: "a " + baby + t, many: baby + plural(t), key: baby + t };
}
function plural(t) {
  if (/(sheep|fish|cod|salmon|deer)$/.test(t)) return t;
  if (/(ch|sh|s|x)$/.test(t)) return t + "es";
  if (/[^aeiou]y$/.test(t)) return t.slice(0, -1) + "ies";
  if (/wolf$/.test(t)) return t.slice(0, -1) + "ves";
  return t + "s";
}
// The group a seen block belongs to: [group, label] or null (plain terrain, handled by the land survey).
const CROP = /^(wheat|carrots|potatoes|beetroots)(_young)?$/;
function groupOf(id) {
  const n = blockName(id), b = BF.blocks[id] || {};
  if (!n) return null;
  let prof = null; try { prof = BF.jobs && BF.jobs.profOfBlock(id); } catch (e) { /* none */ }
  if (prof) return ["workstations", pretty(n) + " (a " + pretty(prof) + "'s workstation)"];
  const crop = CROP.exec(n);
  if (crop) return ["crops", (crop[2] ? "young " : "") + pretty(crop[1]) + (crop[2] ? "" : " (ripe)")];
  if (/^farmland/.test(n)) return ["crops", "farmland"];
  if (/_stem$/.test(n)) return ["crops", pretty(n)];
  if (/_log$|_wood$/.test(n)) return ["trees", pretty(n.replace(/_(log|wood)$/, "")) + " tree"];
  if (/_leaves$/.test(n)) return ["trees", "leaves"];
  if (/_sapling$/.test(n)) return ["plants", pretty(n)];
  if (b.render === "cross" || BF.RENDER[id] === 4) {
    if (/^(short_grass|fern|tall_grass|large_fern)$/.test(n)) return ["plants", "tall grass"];
    if (/mushroom/.test(n)) return ["plants", pretty(n)];
    if (/^(dead_bush|sugar_cane)$/.test(n)) return ["plants", pretty(n)];
    return ["flowers", pretty(n)];
  }
  if (b.door) return ["building", "door"];
  if (b.bed) return ["building", "bed"];
  if (/glass|pane/.test(n)) return ["building", "window glass"];
  if (/^(chest|furnace|crafting_table|barrel|bookshelf|bell|lantern|torch|wall_torch|hay_bale|anvil|campfire)/.test(n)) return ["building", pretty(n.replace(/^wall_torch.*/, "torch").replace(/_(north|east|south|west|n|e|s|w|lit|on)$/, ""))];
  if (/_fence|fence_gate|_wall$/.test(n)) return ["building", "fence"];
  if (/^dirt_path/.test(n)) return ["land", "path"];
  if (/^(lava)/.test(n)) return ["danger", "lava"];
  if (/beehive/.test(n)) return ["building", "beehive"];
  if (/pumpkin|melon|cactus|bee_nest/.test(n)) return ["plants", pretty(n)];
  return null;
}
// What the ground is, in a word.
function groundOf(id) {
  const n = blockName(id);
  if (isWater(id)) return "water";
  if (/^(grass|snow_grass)$/.test(n)) return n === "snow_grass" ? "snowy grass" : "grass";
  if (/sand$/.test(n) && !/stone/.test(n)) return "sand";
  if (/snow|ice/.test(n)) return "snow and ice";
  if (/^(cobblestone|mossy_cobblestone|stone_bricks?|smooth_stone)/.test(n) || /_stairs|_slab/.test(n)) return "buildings";
  if (/^(stone|andesite|diorite|granite|deepslate|gravel|tuff|calcite)/.test(n)) return "rock";
  if (/^(dirt|coarse_dirt|podzol|mud)/.test(n)) return "bare earth";
  if (/^farmland/.test(n)) return "fields";
  if (/^dirt_path/.test(n)) return "a path";
  if (/_leaves$|_log$/.test(n)) return "trees";
  if (/planks|bricks|terracotta|sandstone|wool|concrete/.test(n)) return "buildings";
  return n ? pretty(n) : "";
}

// ---------------------------------------------------------------- look around
function eyeOf(m) { return { x: m.position.x, y: m.position.y + (m.height || 1.95) * 0.85, z: m.position.z }; }
function look(m) {
  const t0 = performance.now(), W = BF.world, eye = eyeOf(m), day = daylight();
  const mobR = DARK_R + (MOB_R - DARK_R) * day, blockR = DARK_R + (BLOCK_R - DARK_R) * day;
  // creatures
  const seenMobs = [];
  const targets = (BF.mobs ? BF.mobs.list : []).filter(o => o !== m && !o.removed && !o.dead && o.position);
  if (BF.player && BF.player.position && !BF.player.dead) targets.push({ player: true, position: BF.player.position, height: 1.8 });
  for (const o of targets) {
    const p = inEyeFrame(eye, o.position), h = o.height || 1;
    const dx = p.x - eye.x, dz = p.z - eye.z, flat = Math.hypot(dx, dz);
    if (flat > MOB_R) continue;
    const far = flat > mobR && !lit(Math.floor(p.x), Math.floor(o.position.y + 0.5), Math.floor(p.z));
    if (far) continue;
    const head = { x: p.x, y: o.position.y + h * 0.85, z: p.z }, mid = { x: p.x, y: o.position.y + h * 0.5, z: p.z };
    if (!clear(eye, head) && !clear(eye, mid)) continue;
    const lab = o.player ? { kind: "people", one: "the traveller you are talking with" } : mobLabel(o);
    seenMobs.push({ kind: lab.kind, one: lab.one, many: lab.many, key: lab.key || lab.one, d: Math.round(flat), dir: compassOf(eye.x, eye.z, dx, dz), type: o.player ? "player" : o.type });
  }
  seenMobs.sort((a, b) => a.d - b.d);
  // blocks: the sweep
  const cells = new Map(), sectors = POINTS.map(() => ({ open: 0, rays: 0, block: new Map(), stop: [], ground: new Map(), hi: -Infinity, lo: Infinity, unloaded: 0 }));
  let rays = 0;
  const note = (x, y, z, id, t) => { const k = x + "," + y + "," + z; if (!cells.has(k)) cells.set(k, { x, y, z, id, d: t }); };
  for (let yaw = 0; yaw < 360; yaw += YAW_STEP) {
    const a = yaw * Math.PI / 180, gx = Math.sin(a), gz = -Math.cos(a), sec = sectors[sectorOf(eye.x, eye.z, gx, gz)] || null;
    for (const pitch of PITCHES) {
      const p = pitch * Math.PI / 180, d = { x: gx * Math.cos(p), y: Math.sin(p), z: gz * Math.cos(p) };
      rays++;
      let firstWater = null;
      const hit = walk(eye, d, BLOCK_R, (x, y, z, id, t) => {
        if (isWater(id)) { if (!firstWater) { firstWater = { x, y, z, id, t }; note(x, y, z, id, t); } return false; }
        if (groupOf(id)) note(x, y, z, id, t);
        return false;
      });
      if (hit && !hit.unloaded) {
        const show = hit.dist <= blockR || lit(hit.prev[0], hit.prev[1], hit.prev[2]);
        if (show) note(hit.x, hit.y, hit.z, hit.id, hit.dist);
      }
      if (!sec) continue;
      // the land: eye-level rays say how far the view runs; downward rays what the ground is and how high it lies
      if (Math.abs(pitch) <= 2) {
        sec.rays++;
        if (!hit) sec.open++;
        else if (hit.unloaded) { sec.unloaded++; sec.open++; }
        else { sec.stop.push(Math.round(hit.dist)); const g = groundOf(hit.id); sec.block.set(g, (sec.block.get(g) || 0) + 1); }
      }
      const g = firstWater && (!hit || hit.unloaded || firstWater.t <= hit.dist) ? firstWater : hit && !hit.unloaded ? { y: hit.y, id: hit.id, t: hit.dist } : null;
      if (g && pitch < 0 && g.t <= blockR) {
        const w = groundOf(g.id);
        sec.ground.set(w, (sec.ground.get(w) || 0) + 1);
        sec.hi = Math.max(sec.hi, g.y); sec.lo = Math.min(sec.lo, g.y);
      }
      if (g && pitch > 0 && hit && !hit.unloaded && hit.dist <= blockR) sec.hi = Math.max(sec.hi, hit.y);
    }
  }
  // sort the seen cells into groups: { group -> { label -> { n, d, dirs: Map(dir -> n), cols: Set } } }
  const groups = {};
  const houses = housesNear(eye);
  const housesSeen = new Map();
  for (const c of cells.values()) {
    const dx = c.x + 0.5 - eye.x, dz = c.z + 0.5 - eye.z, dir = compassOf(eye.x, eye.z, dx, dz), d = Math.round(Math.hypot(dx, dz));
    for (const h of houses) if (c.x >= h.x && c.x < h.x + h.w && c.z >= h.z && c.z < h.z + h.d && Math.abs(c.y - h.y) < 12) {
      const s = housesSeen.get(h) || { d: Infinity, dir: "" };
      if (d < s.d) { s.d = d; s.dir = dir; }
      housesSeen.set(h, s);
    }
    const gr = isWater(c.id) ? ["land", "water"] : groupOf(c.id);
    if (!gr) continue;
    const G = groups[gr[0]] || (groups[gr[0]] = new Map());
    const e = G.get(gr[1]) || { n: 0, d: Infinity, dirs: new Map(), cols: new Set() };
    e.n++; e.d = Math.min(e.d, d); e.dirs.set(dir, (e.dirs.get(dir) || 0) + 1); e.cols.add(c.x + "," + c.z);
    G.set(gr[1], e);
  }
  const out = { mobs: seenMobs, groups, sectors: [], houses: [], range: Math.round(blockR), rays, ms: 0 };
  for (const [h, s] of housesSeen) out.houses.push({ village: h.village, d: s.d, dir: s.dir });
  out.houses.sort((a, b) => a.d - b.d);
  // the land, per compass point. Walls close on (nearly) every side: indoors, and only the openings are worth saying.
  const closeWall = s => { if (!s.rays || s.open / s.rays >= 0.6) return false; s.stop.sort((a, b) => a - b); return s.stop[Math.floor(s.stop.length / 2)] <= 6 && top(s.block) === "buildings"; };
  out.indoors = sectors.filter(closeWall).length >= 6;
  if (out.indoors) {
    const gaps = sectors.map((s, i) => [s, i]).filter(([s]) => s.rays && !closeWall(s)).map(([s, i]) => POINTS[i]);
    out.sectors.push("you seem to be indoors, with walls close around you" + (gaps.length ? "; it opens to the " + gaps.join(" and ") + " (a door or window)" : ""));
  }
  if (!out.indoors) sectors.forEach((s, i) => {
    if (!s.rays) return;
    const parts = [];
    const openFrac = s.open / s.rays;
    if (s.unloaded && s.unloaded >= s.rays / 2) parts.push("beyond what you know (unexplored)");
    else if (openFrac >= 0.6) parts.push(day < 0.4 ? "open, into the dark" : "open as far as you can see");
    else {
      s.stop.sort((a, b) => a - b);
      const near = s.stop[Math.floor(s.stop.length / 2)], what = top(s.block);
      const by = !what ? "" : what === "trees" ? "trees" : what === "buildings" ? "a wall or building" : /^(rock|grass|bare earth|snowy grass|sand|snow and ice)$/.test(what) ? "rising ground (" + what + ")" : what;
      parts.push((near <= 2 ? "right in front of you" : "at about " + near + " blocks") + " your view is blocked" + (by ? " by " + by : ""));
    }
    const gnd = top(s.ground);
    if (gnd) parts.push(gnd === "water" ? "water there" : gnd + " underfoot");
    const eyeY = Math.floor(eye.y);
    if (s.hi > -Infinity && s.hi - eyeY >= 6) parts.push("the land rises about " + (s.hi - eyeY) + " blocks above you");
    else if (s.lo < Infinity && eyeY - s.lo >= 8) parts.push("the ground falls away about " + (eyeY - 1 - s.lo) + " blocks");
    out.sectors.push(POINTS[i] + ": " + parts.join(", "));
  });
  out.text = describe(out, day, eye);
  out.ms = Math.round(performance.now() - t0);
  return out;
}
const near = d => (d <= 1 ? "right beside you" : "nearest " + d + " blocks");
const top = map => { let best = "", n = 0; for (const [k, v] of map) if (k && v > n) { n = v; best = k; } return best; };
// The house plots of loaded villages near the eye, in the eye's frame: [{ x, z, w, d, y, village }]
function housesNear(eye) {
  const out = [];
  const vs = BF.mobs && BF.mobs.villages ? [...BF.mobs.villages.values()] : [];
  for (const v of vs) {
    const c = inEyeFrame(eye, v);
    if (Math.hypot(c.x - eye.x, c.z - eye.z) > BLOCK_R + 80) continue;
    let name = null; try { name = BF.signs && BF.signs.villageName(v.wg || v); } catch (e) { /* unnamed */ }
    for (const h of v.houses || []) {
      if (!h || !h.w) continue;
      const p = inEyeFrame(eye, h);
      out.push({ x: Math.floor(p.x), z: Math.floor(p.z), w: h.w, d: h.d || h.w, y: h.y != null ? h.y : v.y || eye.y, village: name });
    }
  }
  return out;
}
function dirsText(dirs) {
  const l = [...dirs].filter(([k]) => k).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return l.length >= 6 ? "all around" : l.slice(0, 3).join(", ");
}
function describe(o, day, eye) {
  const L = [];
  L.push(day >= 0.6 ? "It is light; you can see about " + o.range + " blocks." : day > 0.1 ? "The light is fading; you can see about " + o.range + " blocks, further to lit places."
    : "It is dark; you can make out only about " + o.range + " blocks, further where torches or lanterns are lit.");
  const mobs = (kind, title) => {
    const list = o.mobs.filter(m => m.kind === kind);
    if (!list.length) return;
    if (kind === "people") { L.push(title + ": " + list.slice(0, 12).map(m => m.one + ", " + m.d + " blocks " + (m.dir || "away")).join("; ") + (list.length > 12 ? "; and " + (list.length - 12) + " more" : "") + "."); return; }
    const by = new Map();
    for (const m of list) { const k = m.key + "|" + m.dir; const g = by.get(k) || { m, n: 0, lo: m.d, hi: m.d }; g.n++; g.hi = Math.max(g.hi, m.d); by.set(k, g); }
    L.push(title + ": " + [...by.values()].slice(0, 16).map(g => (g.n === 1 ? g.m.one : g.n + " " + g.m.many) + ", " + (g.m.dir || "nearby") + ", " + (g.lo === g.hi ? g.lo : g.lo + "-" + g.hi) + " blocks").join("; ") + ".");
  };
  mobs("danger", "Dangers");
  mobs("people", "People");
  mobs("creatures", "Animals");
  const grp = (key, title, count) => {
    const G = o.groups[key];
    if (!G || !G.size) return;
    const items = [...G].sort((a, b) => a[1].d - b[1].d).slice(0, 12).map(([label, e]) => {
      const n = count ? count(label, e) : null;
      const name = n > 1 ? label.replace(/^([^(]+?)( \(|$)/, (m, a, b) => plural(a) + b) : label;
      return (n ? n + " " : "") + name + " (" + near(e.d) + ", " + dirsText(e.dirs) + ")";
    });
    L.push(title + ": " + items.join("; ") + ".");
  };
  if (o.houses.length) {
    const byV = new Map();
    for (const h of o.houses) { const k = h.village || ""; const g = byV.get(k) || []; g.push(h); byV.set(k, g); }
    L.push("Houses: " + [...byV].map(([v, hs]) => hs.length + " house" + (hs.length === 1 ? "" : "s") + (v ? " of " + v : "") + (hs[0].d <= 1 ? ", and you are standing at one" : ", the nearest " + hs[0].d + " blocks " + (hs[0].dir || "away"))).join("; ") + ".");
  }
  grp("building", "Signs of people", (label, e) => (label === "door" ? Math.max(1, Math.round(e.n / 2)) : label === "bed" ? Math.max(1, Math.round(e.n / 2)) : null));
  grp("workstations", "Workstations", (label, e) => e.n);
  grp("crops", "Fields", null);
  grp("trees", "Trees", (label, e) => (label === "leaves" ? null : e.cols.size));
  grp("flowers", "Flowers", (label, e) => e.n);
  grp("plants", "Other plants", null);
  grp("land", "Water and paths", null);
  if (o.sectors.length) L.push((o.indoors ? "Around you: " : "The land around you: ") + o.sectors.join("; ") + ".");
  if (L.length === 1) L.push("Nothing much in sight.");
  let t = L.join("\n");
  if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT - 3) + "...";
  return t;
}

// ---------------------------------------------------------------- where it is (for the system prompt)
function where(m) {
  const p = m && m.position;
  if (!p) return "";
  const parts = [];
  try {
    const b = BF.worldgen && BF.worldgen.biomeAt(p.x, p.z);
    if (b && b.name) parts.push("You live in " + aOrAn(pretty(b.name).toLowerCase()) + " " + pretty(b.name).toLowerCase() + " biome.");
  } catch (e) { /* no biome */ }
  try {
    const ll = BF.planet && BF.planet.latLonAt(p.x, p.z, {});
    if (ll) {
      const a = Math.abs(ll.lat), band = a < 23 ? "tropical" : a < 35 ? "subtropical" : a < 55 ? "temperate" : a < 66 ? "subarctic" : "arctic";
      parts.push("It lies in the " + band + " lands, " + Math.round(a) + " degrees " + (ll.lat >= 0 ? "north" : "south") + " of the middle of the world (" + (a < 23 ? "warm all year" : a < 35 ? "warm" : a < 55 ? "mild" : a < 66 ? "cool, with long winters" : "cold and snowy") + ").");
    }
  } catch (e) { /* no planet */ }
  try { const up = Math.round(p.y - (BF.SEA || 0)); parts.push("You stand " + (up >= 0 ? up + " blocks above" : -up + " blocks below") + " sea level."); } catch (e) { /* ignore */ }
  try {
    const v = BF.worldgen && BF.worldgen.nearestVillage && BF.worldgen.nearestVillage(p.x, p.z);
    if (v) {
      const P = BF.planet, d = P ? P.distance(p, v) : Math.hypot(v.x - p.x, v.z - p.z);
      let name = null; try { name = BF.signs ? BF.signs.villageName(v) : v.name; } catch (e) { name = v.name || null; }
      const t = P ? P.toward(p, v, {}) : { x: v.x - p.x, z: v.z - p.z }, dir = compassOf(p.x, p.z, t.x, t.z);
      if (isFinite(d)) parts.push(d < 50 ? "You are in or beside the village" + (name ? " of " + name : "") + "." : "The nearest village" + (name ? ", " + name + "," : "") + " is about " + Math.round(d / 10) * 10 + " blocks " + (dir || "away") + ".");
    }
  } catch (e) { /* no villages */ }
  return parts.join(" ");
}
const aOrAn = w => (/^[aeiou]/.test(w) ? "an" : "a");

BF.claudeSight = { look, where, clear, walk, MOB_R, BLOCK_R, DARK_R };
})();
