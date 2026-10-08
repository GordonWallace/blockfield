// Second-screen debug feed. Sends what the F3 overlay and village panel show (plus the village's villagers, map and full log)
// to the debug server (debug/server.js), which relays it to the debug screen on its own port. Covers every village the world
// has loaded, not just the one the player is in.
// Always on, whatever F3 is doing: it streams to port 8001 on the game's host (or the address the debug server injects as
// window.BF_DEBUG_FEED, or ?debugfeed=<port or url>; ?debugfeed=off stops it). It never changes what the game shows.
// Snapshots go out 4 times a second as small POSTs; the village layout and the log are only re-sent when they change.
// While no debug server is listening it just retries quietly, every 4 s at first and then every 15 s.
// API: BF.debugFeed = { url (current address), urls (candidates), snapshot(), update() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

// Where to send: ?debugfeed=<port|url> or the address the debug server injected, else port 8001 on the game's own host, then
// on localhost and 127.0.0.1 (a game opened by a LAN address or a name like mymac.local still finds a server on this machine).
function feedUrls() {
  const q = new URLSearchParams(location.search).get("debugfeed");
  if (q === "off") return [];
  const port = u => /^\d+$/.test(u);
  const given = q || window.BF_DEBUG_FEED || "";
  if (given && !port(given)) return [given.replace(/\/+$/, "")];
  const p = given || "8001", h = location.hostname || "localhost";
  return [...new Set([h, "localhost", "127.0.0.1"].map(x => "http://" + (x.includes(":") && !x.startsWith("[") ? "[" + x + "]" : x) + ":" + p))];
}
const URLS = feedUrls();
if (!URLS.length) return;
let URL_ = URLS[0], urlIdx = 0, told = false;

const EVERY = 250, RETRY = 4000, RETRY_SLOW = 15000;
let misses = 0, nextT = 0, busy = false, sent = 0;

const r1 = v => Math.round(v * 10) / 10;
const box = o => [o.x0, o.z0, o.x1, o.z1];

function layout(rec) {
  const v = rec.wg || {};
  return {
    key: rec.key, x: rec.x, z: rec.z, name: BF.vlog.panelData(rec).name, biome: rec.biome,
    bounds: [v.minX, v.minZ, v.maxX, v.maxZ],
    roads: (v.roads || []).map(box), plaza: (v.pads || []).filter(p => p.path).map(box),
    buildings: (v.buildings || []).map(b => [b.x0, b.z0, b.x1, b.z1, b.type]),
    lamps: v.lamps || [],
  };
}

function status(m) {
  if (BF.villagerStatus) return BF.villagerStatus.text(m);   // trade-screen status line, when that module is loaded
  return (BF.villageLife && BF.villageLife.statusText(m)) || (BF.builder && BF.builder.statusText ? BF.builder.statusText(m) : "") ||
    (BF.explorer ? BF.explorer.statusText(m) : "") || (m.sleeping ? "Sleeping" : m.ai && m.ai.mode === "walk" ? "Walking" : "Idle");
}

// A village counts as loaded while it has live villagers in the world (its chunks are loaded and its roster spawned).
const isLoaded = rec => (rec.members || []).some(m => m.type === "villager" && !m.dead && !m.removed && m.position);
const nameOf = key => (BF.signs && BF.signs.villageName && BF.signs.villageName(key)) || "Village";

// Full detail for one loaded village: the panel's numbers, its villagers, golems and free job blocks.
function detail(rec) {
  const L = BF.vlog, d = L.panelData(rec);
  d.villagerList = [];
  d.golems = [];
  for (const m of rec.members || []) {
    if (m.dead || m.removed || !m.position) continue;
    if (m.type === "iron_golem") { d.golems.push({ x: r1(m.position.x), z: r1(m.position.z), hp: m.hp, maxHp: m.maxHp }); continue; }
    if (m.type !== "villager") continue;
    d.villagerList.push({
      name: L.nameOf(m), prof: m.child ? "Child" : L.pretty(m.profession), child: !!m.child,
      status: status(m) || "", x: r1(m.position.x), y: r1(m.position.y), z: r1(m.position.z),
      hp: Math.round(m.hp), maxHp: m.maxHp, bed: !!m.bed, sleeping: !!m.sleeping,
      job: m.jobsite ? [m.jobsite.x, m.jobsite.z] : null,
    });
  }
  d.villagerList.sort((a, b) => a.name.localeCompare(b.name));
  d.jobsites = BF.jobs && BF.jobs.unclaimed ? BF.jobs.unclaimed(rec).map(s => [s.x, s.z, L.pretty(s.prof)]) : [];
  d.clock = BF.vlog.stamp(BF.sky.day + BF.sky.time);   // when these numbers were taken, shown once the village unloads
  return d;
}

// Every village this world has loaded: the ones the mob system knows this session, plus any with a saved log (earlier
// sessions). Each snapshot carries the list with distances, full detail for the loaded ones, new layouts and changed logs.
function villages(pp) {
  const L = BF.vlog, recs = BF.mobs.villages || new Map(), out = { villages: [], detail: {}, layouts: {}, logs: {} };
  const keys = new Set(recs.keys());
  for (const k in L.serialize()) keys.add(k);
  for (const key of keys) {
    const rec = recs.get(key), [kx, kz] = key.split(",").map(Number);
    const x = rec ? rec.x : kx, z = rec ? rec.z : kz, loaded = !!rec && isLoaded(rec);
    out.villages.push({ key, name: nameOf(key), x: Math.round(x), z: Math.round(z), dist: Math.round(Math.hypot(x - pp.x, z - pp.z)), loaded });
    if (loaded) out.detail[key] = detail(rec);
    if (rec && rec.wg && !sentLayouts.has(key)) { out.layouts[key] = layout(rec); sentLayouts.add(key); }
    const a = L.entries(key), last = a[a.length - 1], sig = a.length + "|" + (last ? last[0] + last[2] : "");
    if (logSigs.get(key) !== sig) { out.logs[key] = { key, cap: L.CAP, entries: a }; logSigs.set(key, sig); }
  }
  out.villages.sort((a, b) => (b.loaded - a.loaded) || a.dist - b.dist);   // loaded first, then by distance
  const inside = L.villageAt(pp.x, pp.z);
  out.inside = inside ? inside.key : null;
  if (!out.villages.length) {   // nothing loaded yet: point the way to the nearest generated village
    const v = BF.worldgen.nearestVillage && BF.worldgen.nearestVillage(pp.x, pp.z);
    if (v) { const key = Math.round(v.x) + "," + Math.round(v.z); out.nearest = { key, name: nameOf(key), dist: Math.round(Math.hypot(v.x - pp.x, v.z - pp.z)), dx: Math.round(v.x - pp.x), dz: Math.round(v.z - pp.z) }; }
  }
  return out;
}
const sentLayouts = new Set(), logSigs = new Map();
const resync = () => { sentLayouts.clear(); logSigs.clear(); };
let hooked = false;

function snapshot() {
  const info = BF.debugInfo(), pp = BF.player.position;
  const mobs = {};
  for (const m of BF.mobs.list) if (!m.dead && !m.removed) mobs[m.type] = (mobs[m.type] || 0) + 1;
  return { t: Date.now(), n: ++sent, info, text: BF.debugText(info), mobs, paused: !!BF.state.paused, hidden: document.hidden,
    professions: (BF.mobs.professions || []).map(BF.vlog.pretty), ...villages(pp) };
}

function update() {
  const now = performance.now();
  if (!hooked && BF.on) { hooked = true; BF.on("newWorld", resync); }   // main.js (which defines BF.on) loads after this file
  if (busy || now < nextT || !BF.debugInfo) return;
  nextT = now + EVERY;
  let body;
  try { body = JSON.stringify(snapshot()); }
  catch (e) {   // tell the debug screen too, so it shows the error instead of waiting for the game
    console.warn("debug feed:", e); nextT = now + RETRY;
    body = JSON.stringify({ t: Date.now(), n: ++sent, error: String(e && e.stack || e).split("\n").slice(0, 3).join("\n") });
  }
  busy = true;
  // text/plain keeps it a "simple" cross-origin request (no CORS preflight)
  // gives up after 5 s, so a request that never gets an answer can't stop the feed for good
  const ctl = new AbortController(), stop = setTimeout(() => ctl.abort(), 5000);
  fetch(URL_ + "/push", { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: body.length < 60000, signal: ctl.signal })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(t => { if (t === "resync") resync(); })   // a restarted server asks for the layouts and logs again
    .then(() => { if (!told) { told = true; console.info("Blockfield debug feed: sending to " + URL_); } misses = 0; })
    .catch(() => {                                // server down or not at this address: try the next one, resend everything when it's back
      misses++;
      if (misses === URLS.length * 2 && !told) console.info("Blockfield debug feed: no debug server at " + URLS.join(" or ") + ". Start ./run.sh (or node debug/server.js) to use the debug screen; the game plays normally without it.");
      URL_ = URLS[urlIdx = (urlIdx + 1) % URLS.length];
      BF.debugFeed.url = URL_;
      nextT = performance.now() + (misses > 5 * URLS.length ? RETRY_SLOW : RETRY / URLS.length);
      told = false; resync();
    })
    .finally(() => { busy = false; clearTimeout(stop); });
}

BF.debugFeed = { url: URL_, urls: URLS, snapshot, update };
// The game loop (requestAnimationFrame) stops while the game's tab is in the background, e.g. when the debug screen is opened
// as another tab in the same window. A timer keeps the feed going then (browsers still run it about once a second), so the
// debug screen can say the game is in the background instead of waiting for it.
setInterval(() => { if (document.hidden) update(); }, 1000);
})();
