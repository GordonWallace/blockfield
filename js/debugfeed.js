// Second-screen debug feed. Sends what the F3 overlay and village panel show (plus the village's villagers, map and full log)
// to the debug server (debug/server.js), which relays it to the debug screen on its own port. Covers every village the world
// has loaded, not just the one the player is in.
// Always on, whatever F3 is doing: it streams to port 8001 on the game's host (or the address the debug server injects as
// window.BF_DEBUG_FEED, or ?debugfeed=<port or url>; ?debugfeed=off stops it). It never changes what the game shows.
// Snapshots go out 4 times a second as small POSTs; the village layout, the log and the economy tallies are only re-sent when they change.
// The server's answer carries the alerts set up on the debug screen whenever the game's copy is out of date (js/alerts.js), and
// the villager picked there; while one is picked, snapshots carry its day timeline (js/daytimeline.js) whenever it changes.
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
// Emeralds and food (bread-equivalent) a villager holds: its inventory plus every chest it owns.
function holdings(chestsOf, m) {
  const em = BF.I && BF.I.emerald, F = BF.food, cs = chestsOf.get(BF.storage && BF.storage.keyOf ? BF.storage.keyOf(m) : null) || [];
  const emIn = a => (a || []).reduce((n, st) => n + (st && st.id === em ? st.count : 0), 0), food = a => F ? F.breadEq(a || []) : 0;
  let ce = 0, cf = 0;
  for (const c of cs) { ce += emIn(c.slots); cf += food(c.slots); }
  return { em: emIn(m.inv), emChests: ce, food: r1(food(m.inv)), foodChests: r1(cf), chests: cs.length };
}
// A villager's inventory slots, compact: 0 for empty, [id, count] or [id, count, durability left 0-1] for a worn tool.
// Icons for item ids not sent yet go out once (snapshot.icons), like layouts.
function invOf(inv) {
  if (!inv) return null;
  return inv.map(s => {
    if (!s || !s.count) return 0;
    if (!sentIcons.has(s.id)) newIcons.add(s.id);
    const max = s.wear > 0 && BF.durability ? BF.durability(s.id) : 0;
    return max ? [s.id, s.count, Math.round(Math.max(0, 1 - s.wear / max) * 100) / 100] : [s.id, s.count];
  });
}
// A poultry keeper's flock (js/poultry.js), a cowherd's herd (js/cowherd.js) or a shepherd's (js/shepherd.js): {kind, n (all of them, unloaded ones too), young, eggs (in the nest)}.
function flockOf(m) {
  try {
    if (m.profession === "poultry_keeper" && BF.poultry) {
      const T = BF.poultry.tended(m), c = T.coop;
      return { kind: "chickens", n: T.size, young: T.flock.filter(o => o.chick).length, eggs: c ? c.eggs | 0 : null, coop: !!c };
    }
    if (m.profession === "cowherd" && BF.cowherd) return BF.cowherd.holdings(m);   // {kind: "cows", n, young, milked (today), culls, limit, coop: has a pasture} (js/cowherd.js)
    if (m.profession === "shepherd" && BF.shepherd) { const T = BF.shepherd.tended(m); return { kind: "sheep", n: T.pen && T.pen.sheep ? T.pen.sheep.length : T.flock.length, young: T.flock.filter(o => o.lamb).length, eggs: null, coop: !!T.pen }; }
  } catch (e) { /* not loaded yet */ }
  return null;
}
function icons() {
  const out = {};
  for (const id of newIcons) {
    let url = null;
    try { url = BF.inventory && BF.inventory.iconURL ? BF.inventory.iconURL(id) : BF.textures.icon(id); } catch (e) { url = null; }
    out[id] = { url, name: (BF.itemName ? BF.itemName(id) : (BF.items[id] || {}).name || "Item " + id).replace(/ Item$/, "") };
    sentIcons.add(id);
  }
  newIcons.clear();
  return out;
}
// The tool each job works with (js/miner.js, forester.js, villagelife.js, shepherd.js): a villager without one can't do its job.
const JOB_TOOL = { miner: /_pickaxe$/, forester: /(^|_)axe$/, farmer: /_hoe$/, shepherd: /^shears$/ };
function detail(rec) {
  const L = BF.vlog, d = L.panelData(rec);
  const chestsOf = new Map();   // owner key -> chests
  if (BF.inventory && BF.inventory.chests) for (const c of BF.inventory.chests.values()) if (c.owner) { const l = chestsOf.get(c.owner) || []; l.push(c); chestsOf.set(c.owner, l); }
  d.villagerList = [];
  d.golems = [];
  for (const m of rec.members || []) {
    if (m.dead || m.removed || !m.position) continue;
    if (m.type === "iron_golem") { d.golems.push({ x: r1(m.position.x), z: r1(m.position.z), hp: m.hp, maxHp: m.maxHp }); continue; }
    if (m.type !== "villager") continue;
    d.villagerList.push({
      id: BF.dayTimeline ? BF.dayTimeline.keyOf(m) : null,   // village key#slot: how the debug screen names the villager it picked (js/daytimeline.js)
      name: L.nameOf(m), prof: m.child ? "Child" : L.pretty(m.profession), child: !!m.child,
      status: status(m) || "", x: r1(m.position.x), y: r1(m.position.y), z: r1(m.position.z),
      hp: Math.round(m.hp), maxHp: m.maxHp, bed: !!(m.bed && !m.bed.tent ? m.bed : m.homeBed), tent: !!(m.bed && m.bed.tent), sleeping: !!m.sleeping,   // an explorer's pitched tent is not a bed: its own bed (homeBed) is
      job: m.jobsite ? [m.jobsite.x, m.jobsite.z] : null, starving: !!m.starving, ...holdings(chestsOf, m),
      age: m.life ? Math.round((m.life.lived || 0) * 10) / 10 : null,   // game days it has been loaded and active
      inv: invOf(m.inv),
      flock: flockOf(m),
      horses: BF.stables ? BF.stables.holdings(m) : null,   // a stable hand's paddock horses (js/stables.js)
      bakes: m.profession === "baker" && BF.baker ? BF.baker.holdings(m) : null,   // a baker's ingredients, baked goods and oven (js/baker.js)
    });
  }
  d.villagerList.sort((a, b) => a.name.localeCompare(b.name));
  d.jobsites = BF.jobs && BF.jobs.unclaimed ? BF.jobs.unclaimed(rec).map(s => [s.x, s.z, L.pretty(s.prof)]) : [];
  // structures the village's builders planned (js/builder.js rec.built): [x0, z0, x1, z1, type, finished 0|1]
  d.built = (rec.built || []).filter(e => e.state !== "abandoned" && e.w && e.d).map(e => [e.ox, e.oz, e.ox + e.w - 1, e.oz + e.d - 1, e.type, e.state === "done" ? 1 : 0]);
  // villagers who have died here (js/mobs.js rec.deadInfo, saved): name, job, cause, game day, age in days loaded and active
  d.dead = (rec.deadInfo || []).map(e => ({ name: e.name || "Someone", prof: L.pretty(e.prof || "unknown"), cause: e.cause || null, day: e.day, age: e.age == null ? null : Math.round(e.age * 10) / 10 }));
  d.clock = BF.vlog.stamp(BF.sky.day + BF.sky.time);   // when these numbers were taken, shown once the village unloads
  d.day = +(BF.sky.day + BF.sky.time).toFixed(3);
  // for the comparison table: last week's events (js/happiness.js), the population change (js/villagestats.js), tool coverage
  const H = BF.happiness, wk = k => H && H.week ? H.week(rec.key, k) : null;
  d.week = { trade: wk("trade"), birth: wk("birth"), death: wk("death") };
  d.pop7 = BF.vstats ? BF.vstats.popChange(rec.key) : null;
  const toolJobs = d.villagerList.length ? (rec.members || []).filter(m => m.type === "villager" && !m.dead && !m.removed && m.position && !m.child && JOB_TOOL[m.profession]) : [];
  d.noTools = [toolJobs.filter(m => !(m.inv || []).some(s => s && BF.items[s.id] && JOB_TOOL[m.profession].test(BF.items[s.id].name))).length, toolJobs.length];
  return d;
}

// Every village this world has loaded: the ones the mob system knows this session, plus any with a saved log (earlier
// sessions). Each snapshot carries the list with distances, full detail for the loaded ones, new layouts and changed logs.
function villages(pp) {
  const L = BF.vlog, E = BF.econ, recs = BF.mobs.villages || new Map(), out = { villages: [], detail: {}, layouts: {}, logs: {}, econ: {} };
  const keys = new Set(recs.keys());
  for (const k in L.serialize()) keys.add(k);
  if (E) for (const k of E.keys()) keys.add(k);
  for (const key of keys) {
    const rec = recs.get(key), [kx, kz] = key.split(",").map(Number);
    const x = rec ? rec.x : kx, z = rec ? rec.z : kz, loaded = !!rec && isLoaded(rec);
    const va = BF.villageLife && BF.villageLife.villageAge ? BF.villageLife.villageAge(key) : null;   // game days loaded and active
    const H = BF.happiness, happy = H ? (loaded ? H.score(rec) : H.last(key)) : null;   // js/happiness.js; an unloaded village keeps its last score
    out.villages.push({ key, name: nameOf(key), x: Math.round(x), z: Math.round(z), dist: Math.round(Math.hypot(x - pp.x, z - pp.z)), loaded, age: va == null ? null : Math.round(va * 10) / 10, happy });
    if (loaded) out.detail[key] = detail(rec);
    if (rec && rec.wg && !sentLayouts.has(key)) { out.layouts[key] = layout(rec); sentLayouts.add(key); }
    const a = L.entries(key), last = a[a.length - 1], sig = a.length + "|" + (last ? last[0] + last[2] : "");
    if (logSigs.get(key) !== sig) { out.logs[key] = { key, cap: L.CAP, entries: a }; logSigs.set(key, sig); }
    // the Economy view's tallies (js/economy.js), like the log: only when they changed (or a new day dropped the oldest)
    const es = E ? E.version(key) + "|" + Math.floor(BF.sky.day + BF.sky.time) : "";
    if (E && econSigs.get(key) !== es) { out.econ[key] = E.view(key); econSigs.set(key, es); }
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
const sentLayouts = new Set(), logSigs = new Map(), econSigs = new Map(), sentIcons = new Set(), newIcons = new Set();
let daySig = null;   // the picked villager's day timeline as last sent: "key|version"
const resync = () => { sentLayouts.clear(); logSigs.clear(); econSigs.clear(); sentIcons.clear(); daySig = null; };
// The day timeline of the villager picked on the debug screen (js/daytimeline.js), only when it changed; null once nothing is picked.
// undefined (left out) when nothing changed, so the feed stays as light as before while nobody is picked.
function dayline() {
  const D = BF.dayTimeline;
  if (!D) return undefined;
  const k = D.picked, sig = k ? k + "|" + D.version(k) : "";
  if (sig === daySig) return undefined;
  daySig = sig;
  return k ? D.view(k) || { key: k, none: true } : null;
}
let hooked = false;

function snapshot() {
  const info = BF.debugInfo(), pp = BF.player.position;
  const mobs = {};
  for (const m of BF.mobs.list) if (!m.dead && !m.removed) { const k = m.type === "chicken" ? (m.coop ? "chicken (coop)" : "chicken (wild)") : m.type === "cow" ? (m.pasture ? "cow (pasture)" : "cow (wild)") : m.type; mobs[k] = (mobs[k] || 0) + 1; }   // chickens: penned and wild (js/poultry.js)
  if (BF.boats) Object.assign(mobs, BF.boats.counts());   // boats by wood ("oak_boat": n) next to the mob types
  return { t: Date.now(), n: ++sent, info, text: BF.debugText(info), mobs, paused: !!BF.state.paused, hidden: document.hidden,
    professions: (BF.mobs.professions || []).map(BF.vlog.pretty), ...villages(pp), icons: icons(),
    gt: +(BF.sky.day + BF.sky.time).toFixed(5),   // game time now (days), for the day timeline's "now" edge
    pick: BF.dayTimeline ? { pv: BF.dayTimeline.pv, key: BF.dayTimeline.picked } : null, day: dayline(),
    routes: BF.merchant ? BF.merchant.routes().map(r => Object.assign(r, { an: nameOf(r.a), bn: nameOf(r.b) })) : null,   // caravan routes (js/merchant.js)
    // alerts (js/alerts.js): which set the game holds (the server answers with a newer one) and how often each has fired
    alerts: BF.alerts ? { av: BF.alerts.av, hits: BF.alerts.hits, active: BF.alerts.active ? BF.alerts.active.alert.id : null } : null };
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
    .then(t => {
      if (t.charAt(0) === "{") {   // {resync?, alerts?, av?, pick?, pv?}: the server's alerts / picked villager, when the game's copy is out of date
        const o = JSON.parse(t);
        if (o.alerts && BF.alerts) BF.alerts.set(o.alerts, o.av);
        if ("pick" in o && BF.dayTimeline) BF.dayTimeline.pick(o.pick, o.pv);
        t = o.resync ? "resync" : "ok";
      }
      if (t === "resync") resync();   // a restarted server asks for the layouts and logs again
    })
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
