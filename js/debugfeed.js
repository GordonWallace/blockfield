// Second-screen debug feed. Sends what the F3 overlay and village panel show (plus the village's villagers, map and full log)
// to the debug server (debug/server.js), which relays it to the debug screen on its own port.
// Always on, whatever F3 is doing: it streams to port 8001 on the game's host (or the address the debug server injects as
// window.BF_DEBUG_FEED, or ?debugfeed=<port or url>; ?debugfeed=off stops it). It never changes what the game shows.
// Snapshots go out 4 times a second as small POSTs; the village layout and the log are only re-sent when they change.
// While no debug server is listening it just retries quietly, every 4 s at first and then every 15 s.
// API: BF.debugFeed = { url, snapshot(), update() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

function feedUrl() {
  const q = new URLSearchParams(location.search).get("debugfeed");
  if (q === "off") return "";
  let u = q || window.BF_DEBUG_FEED || "8001";   // always on: the default debug port on the game's own host
  if (/^\d+$/.test(u)) u = "http://" + (location.hostname || "localhost") + ":" + u;
  return u.replace(/\/+$/, "");
}
const URL_ = feedUrl();
if (!URL_) return;

const EVERY = 250, RETRY = 4000, RETRY_SLOW = 15000;
let misses = 0, nextT = 0, busy = false, layoutKey = null, logSig = "", sent = 0;

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

function village(pp) {
  const L = BF.vlog, rec = L.villageAt(pp.x, pp.z);
  if (!rec) {
    const v = BF.worldgen.nearestVillage && BF.worldgen.nearestVillage(pp.x, pp.z);
    if (!v) return { here: null };
    const key = Math.round(v.x) + "," + Math.round(v.z);
    return { here: null, nearest: { key, name: (BF.signs && BF.signs.villageName && BF.signs.villageName(key)) || "Village",
      dist: Math.round(Math.hypot(v.x - pp.x, v.z - pp.z)), dx: Math.round(v.x - pp.x), dz: Math.round(v.z - pp.z) } };
  }
  const d = L.panelData(rec), out = { here: d };
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
  if (layoutKey !== rec.key) { out.layout = layout(rec); layoutKey = rec.key; logSig = ""; }
  const a = L.entries(rec.key), last = a[a.length - 1], sig = rec.key + "|" + a.length + "|" + (last ? last[0] + last[2] : "");
  if (sig !== logSig) { out.log = { key: rec.key, cap: L.CAP, entries: a }; logSig = sig; }
  return out;
}

function snapshot() {
  const info = BF.debugInfo(), pp = BF.player.position;
  const mobs = {};
  for (const m of BF.mobs.list) if (!m.dead && !m.removed) mobs[m.type] = (mobs[m.type] || 0) + 1;
  const v = village(pp);
  if (!v.here) layoutKey = null;
  return { t: Date.now(), n: ++sent, info, text: BF.debugText(info), mobs, paused: !!BF.state.paused, ...v };
}

function update() {
  const now = performance.now();
  if (busy || now < nextT || !BF.debugInfo) return;
  nextT = now + EVERY;
  let body;
  try { body = JSON.stringify(snapshot()); } catch (e) { console.warn("debug feed:", e); nextT = now + RETRY; return; }
  busy = true;
  // text/plain keeps it a "simple" cross-origin request (no CORS preflight)
  fetch(URL_ + "/push", { method: "POST", body, headers: { "Content-Type": "text/plain" }, keepalive: body.length < 60000 })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(t => { if (t === "resync") { layoutKey = null; logSig = ""; } })   // a restarted server asks for the layout and log again
    .then(() => { misses = 0; })
    .catch(() => { nextT = performance.now() + (++misses > 5 ? RETRY_SLOW : RETRY); layoutKey = null; logSig = ""; })   // server down: resend everything when it's back
    .finally(() => { busy = false; });
}

BF.debugFeed = { url: URL_, snapshot, update };
})();
