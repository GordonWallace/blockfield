// Village action logs and villager names. The F3 village panel and the names floating over villagers are drawn by js/villagepanel.js
// (spec r15-37) from the protocol: the villagers' names in the client's mirror and the "vpanel" query (panelData here).
// Every village keeps a timestamped log of births, beds placed (and by whom), trades (villager <-> villager and
// villager <-> player) and professions gained, capped at CAP entries (oldest dropped) and saved with the world.
// Entries are [t, kind, text, [x, y, z]?]: the location of the event (block coordinates) when it has one, from the `where` given
// to log() (a mob or a point) or else the first "at x, y, z" in the text. Every logged entry also goes to BF.alertSim (js/alertsim.js).
// Villager names are generated deterministically from the villager's persistence key, so they need no saving.
// Builders log what they start, take over and finish building (kind "build", js/builder.js).
// Explorers' tents are logged with the beds (the tally still counts only real beds).
// API: BF.vlog = { nameOf(m), log(rec, kind, text, where?), posOf(where, text) -> [x, y, z]|null, trade(buyer, seller, offerOrText), bed(m, x, y, z), profession(m, from, to),
//                  entries(key), villageAt(x, z) -> rec|null, tally(rec), panelData(rec), serialize(), deserialize(o), reset(), init(), update() }
(() => {
"use strict";
const BF = (globalThis.BF = globalThis.BF || {});

const CAP = 300;          // entries kept per village
const MARGIN = 8;         // blocks beyond the village box that still count as "within the village"

const FIRST = ["Aroha", "Hemi", "Mere", "Tane", "Ngaio", "Rawiri", "Kiri", "Wiremu", "Anika", "Tama", "Hine", "Manu", "Ruby", "Jack", "Olive", "Finn", "Maia", "Niko", "Isla", "Cooper", "Pania", "Rangi", "Tui", "Koa", "Lucy", "Ben", "Aria", "Hugo", "Sione", "Leilani", "Matiu", "Kahu", "Ivy", "Rua", "Mika", "Zoe", "Eru", "Awhina", "Noah", "Piper", "Tipene", "Huia", "Ella", "Arlo", "Wai", "Nikau", "Sadie", "Toby", "Rewi", "Amy", "Kauri", "Hana", "Liam", "Tilly", "Rata", "Oscar", "Moana", "Stella", "Tomas", "Ariki"];
const LAST = ["Parata", "Tane", "Reid", "Whittle", "Hohepa", "Smith", "Ngata", "Mackay", "Takerei", "Brown", "Kereama", "Wilson", "Rewi", "Cooper", "Walker", "Piripi", "Henare", "Scott", "Moana", "Stewart", "Tawhiri", "Murray", "Eruera", "Fraser", "Poata", "Cameron", "Karaka", "Hunter", "Te Rangi", "Baker", "Matene", "Ross", "Waaka", "Gray", "Manihera", "Clarke", "Rangi", "Dunn", "Tamihana", "Fisher", "Hape", "Mason", "Nikora", "Webb", "Pere", "Holt", "Rata", "Bell"];

const logs = new Map();       // village key -> [[t, kind, text]]
let hooked = false;

const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const pretty = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
function stamp(t) {
  const d = Math.floor(t), h = (((t - d) * 24 + 6) % 24 + 24) % 24;
  return "Day " + (d + 1) + " " + String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.floor((h % 1) * 60)).padStart(2, "0");
}
function hash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; return (h ^ (h >>> 13)) >>> 0; }

// ---------------------------------------------------------------- names
let anon = 0;
function nameOf(m) {
  if (!m) return "Someone";
  if (m.vname) return m.vname;
  // (with the cluster tick on, by its id: a counter shared by every cluster would number them in the order clusters run, js/ctick.js)
  const k = m.village && m.slot && m.slot.idx != null ? m.village.key + "#" + m.slot.idx : "anon" + (m.vanon || (m.vanon = BF.ctick && BF.ctick.on && m.id ? +m.id.slice(1) : ++anon));
  const h = hash((BF.state ? BF.state.seed : 0) + ":" + k);
  return (m.vname = FIRST[h % FIRST.length] + " " + LAST[(h >>> 8) % LAST.length]);
}

// ---------------------------------------------------------------- logging
// where: a mob (its position), {x, y, z} or [x, y, z]; without one, the first "at x, y, z" in the text
function posOf(where, text) {
  const p = where && where.position ? where.position : where;
  if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) return p.map(Math.floor);
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
  const m = / at (-?\d+), ?(-?\d+), ?(-?\d+)/.exec(text || "");
  return m ? [+m[1], +m[2], +m[3]] : null;
}
// several workers (clusters, js/cworkers.js): a village's log is its cluster's; only the logs that grew since the last meeting go
BF.onLoad(() => {
  const C = BF.ctick;
  if (!C || !C.ownedMap) return;
  C.ownedMap("villagelog.logs", logs, k => C.ofVillage(k), null, null, (k, a) => a.length + "|" + (a.length ? a[a.length - 1][0] + "|" + a[a.length - 1][2] : ""));
});
function log(rec, kind, text, where) {
  if (!rec || !rec.key) return;
  let a = logs.get(rec.key);
  if (!a) logs.set(rec.key, a = []);
  const e = [+dayNow().toFixed(4), kind, text], at = posOf(where, text);
  if (at) e.push(at);
  a.push(e);
  if (a.length > CAP) a.splice(0, a.length - CAP);
  if (BF.happiness) BF.happiness.note(rec.key, kind);   // its weekly counts outlive the capped log (js/happiness.js)
  if (BF.alertSim) BF.alertSim.check(rec, e);   // debug screen alerts (js/alertsim.js)
  if (BF.glog) BF.glog.village(rec, e);   // the game log keeps every entry, not just the newest CAP (js/gamelog.js)
}
const stacks = list => (list || []).map(b => b.n + " " + BF.itemName(b.id)).join(" + ");
const who = m => nameOf(m) + " (" + pretty(m.profession) + ")";
const recOf = m => m && m.village;

// buyer/seller: villager mobs, or buyer === "player". what: an offer {buy, sell} (times = repeats) or a ready-made string.
function trade(buyer, seller, what, times) {
  if (BF.perf) BF.perf.count.trades++;   // trades per villager-second (js/perf.js activity, spec r15-60)
  if (BF.econ) BF.econ.trade(buyer, seller, what, times);   // the Economy view's tallies (js/economy.js)
  if (BF.prices && what && typeof what === "object") for (const m of [seller, buyer]) BF.prices.filled(m, what, times);   // eases its price at the next tick (js/prices.js)
  const rec = recOf(seller) || recOf(buyer);
  if (!rec) return;
  let text;
  if (typeof what === "string") text = what;
  else {
    const n = times || 1;
    text = "gave " + stacks(what.buy.map(b => ({ id: b.id, n: b.n * n }))) + ", got " + stacks([{ id: what.sell.id, n: what.sell.n * n }]);
  }
  const a = buyer === "player" ? "Player" : who(buyer), line = a + " traded with " + who(seller) + ": " + text;
  log(rec, "trade", line, seller && seller.position ? seller : buyer && buyer.position ? buyer : null);
  if (BF.dayTimeline) for (const m of [buyer, seller]) if (m && m !== "player") BF.dayTimeline.event(m, "trade", line);   // the villager's day (js/daytimeline.js)
}
function bed(m, x, y, z, what) {
  const rec = (m && m.village) || villageAt(x, z);
  if (rec) log(rec, "bed", (m ? who(m) : "Player") + " placed a " + (what || "bed") + " at " + x + ", " + y + ", " + z, [x, y, z]);
  if (m && BF.dayTimeline) BF.dayTimeline.event(m, "bed", "Placed a " + (what || "bed") + " at " + x + ", " + y + ", " + z, [x, y, z]);
}
function profession(m, from, to) {
  if (!m || !m.village || !to || to === "unemployed" || to === "nitwit" || to === "child") return;
  const text = nameOf(m) + " became a " + pretty(to) + (from && from !== "unemployed" ? " (was " + pretty(from) + ")" : "");
  log(m.village, "job", text, m);
  if (BF.dayTimeline) BF.dayTimeline.event(m, "job", text);
}

// ---------------------------------------------------------------- where is a point / the player
function villageAt(x, z) {
  if (!BF.mobs || !BF.mobs.villages) return null;
  for (const rec of BF.mobs.villages.values()) {
    const v = rec.wg;
    if (v && v.minX != null && x >= v.minX - MARGIN && x <= v.maxX + MARGIN && z >= v.minZ - MARGIN && z <= v.maxZ + MARGIN) return rec;
  }
  return null;
}
function tally(rec) {
  const B = BF.breeding;
  return { villagers: rec && B ? B.villagerCount(rec) : 0, beds: rec && B ? B.bedCount(rec) : 0 };
}
const entries = key => logs.get(key) || [];

// ---------------------------------------------------------------- panel (F3)
// The panel's numbers as data, for the second-screen debug feed (js/debugfeed.js) and the protocol's "vpanel" query, which the F3 panel
// (js/villagepanel.js, spec r15-37) draws from.
const byName = (x, y) => (x[0] === "Child") - (y[0] === "Child") || x[0].localeCompare(y[0]);   // alphabetical, children last
function panelData(rec) {
  const t = tally(rec), name = (BF.signs && BF.signs.villageName && BF.signs.villageName(rec.key)) || "Village";
  const prof = {};
  for (const m of rec.members || []) if (m.type === "villager" && !m.dead && !m.removed) { const p = m.child ? "Child" : pretty(m.profession); prof[p] = (prof[p] || 0) + 1; }
  const un = BF.jobs && BF.jobs.unclaimed ? BF.jobs.unclaimed(rec) : [], uc = {};
  for (const s of un) { const p = pretty(s.prof); uc[p] = (uc[p] || 0) + 1; }
  return { key: rec.key, name, villagers: t.villagers, beds: t.beds, unclaimed: un.length,
    occupations: Object.entries(prof).sort(byName), free: Object.entries(uc).sort(byName),
    loaded: Object.values(prof).reduce((x, y) => x + y, 0) };
}
function hook() {
  if (hooked || typeof BF.on !== "function") return;
  hooked = true;
  if (BF.happiness) BF.happiness.hook();
  BF.on("newWorld", reset);
  BF.on("villagerBorn", (m, a, b) => {
    if (m.village) log(m.village, "birth", nameOf(m) + " was born to " + nameOf(a) + " and " + nameOf(b), m);
  });
  BF.on("mobKilled", m => {
    if (m && m.type === "villager" && m.village) log(m.village, "death", who(m) + " died: killed by " + (m.lastHurt || "unknown causes"), m);
  });
  BF.on("villagerTrade", (v, o) => trade("player", v, o));
  BF.on("blockPlaced", (x, y, z, id) => {      // beds placed by the player (villagers log their own: js/builder.js)
    const b = BF.blocks[id];
    if (b && b.bed && !b.bed.head) bed(BF.vlog.actor, x, y, z);
    else if (b && b.tent && b.tent.r === 0 && b.tent.l === 1 && !b.tent.up) bed(BF.vlog.actor, x, y, z, "tent");   // its foot centre
  });
}

function reset() { logs.clear(); }

BF.vlog = {
  actor: null,      // set around block placements made by a villager that goes through blockPlaced (explorer tents)
  CAP, nameOf, log, posOf, trade, bed, profession, entries, villageAt, tally, stamp, pretty, panelData,
  serialize() { const o = {}; for (const [k, a] of logs) if (a.length) o[k] = a; return o; },
  deserialize(o) {
    logs.clear();
    if (!o || typeof o !== "object") return;
    for (const k in o) if (Array.isArray(o[k])) logs.set(k, o[k].filter(e => Array.isArray(e) && typeof e[2] === "string").slice(-CAP));   // older saves: no locations
  },
  reset,
  init() {
    hook();
    // the population history and the Economy view's scans run on the game step, so they see the same moments at any speed (spec r15-16)
    const W = BF.world;
    if (W && W.onThink) W.onThink(() => { if (BF.vstats) BF.vstats.update(); if (BF.econ) BF.econ.update(); }, "vstats");   // (js/world.js tickSim)
  },
  update() { hook(); },   // (the floating names and the F3 panel are drawn by js/villagepanel.js)
};
})();
