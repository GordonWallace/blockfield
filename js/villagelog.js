// Village action logs, villager names and the F3 village panel.
// Every village keeps a timestamped log of births, beds placed (and by whom), trades (villager <-> villager and
// villager <-> player) and professions gained, capped at CAP entries (oldest dropped) and saved with the world.
// Villager names are generated deterministically from the villager's persistence key, so they need no saving.
// Explorers' tents are logged with the beds (the tally still counts only real beds).
// API: BF.vlog = { nameOf(m), log(rec, kind, text), trade(buyer, seller, offerOrText), bed(m, x, y, z), profession(m, from, to),
//                  entries(key), villageAt(x, z) -> rec|null, tally(rec), serialize(), deserialize(o), reset(), init(), update(dt, debugOn) }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const CAP = 300;          // entries kept per village
const MARGIN = 8;         // blocks beyond the village box that still count as "within the village"
const LABEL_R = 40;       // names float over villagers this close to the player
const SHOW = 26;          // log lines in the panel

const FIRST = ["Aroha", "Hemi", "Mere", "Tane", "Ngaio", "Rawiri", "Kiri", "Wiremu", "Anika", "Tama", "Hine", "Manu", "Ruby", "Jack", "Olive", "Finn", "Maia", "Niko", "Isla", "Cooper", "Pania", "Rangi", "Tui", "Koa", "Lucy", "Ben", "Aria", "Hugo", "Sione", "Leilani", "Matiu", "Kahu", "Ivy", "Rua", "Mika", "Zoe", "Eru", "Awhina", "Noah", "Piper", "Tipene", "Huia", "Ella", "Arlo", "Wai", "Nikau", "Sadie", "Toby", "Rewi", "Amy", "Kauri", "Hana", "Liam", "Tilly", "Rata", "Oscar", "Moana", "Stella", "Tomas", "Ariki"];
const LAST = ["Parata", "Tane", "Reid", "Whittle", "Hohepa", "Smith", "Ngata", "Mackay", "Takerei", "Brown", "Kereama", "Wilson", "Rewi", "Cooper", "Walker", "Piripi", "Henare", "Scott", "Moana", "Stewart", "Tawhiri", "Murray", "Eruera", "Fraser", "Poata", "Cameron", "Karaka", "Hunter", "Te Rangi", "Baker", "Matene", "Ross", "Waaka", "Gray", "Manihera", "Clarke", "Rangi", "Dunn", "Tamihana", "Fisher", "Hape", "Mason", "Nikora", "Webb", "Pere", "Holt", "Rata", "Bell"];

const logs = new Map();       // village key -> [[t, kind, text]]
const labels = new Map();     // mob -> { sp, key }
const texCache = new Map();
let hooked = false, panelT = 0, panelEl = null;

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
  const k = m.village && m.slot && m.slot.idx != null ? m.village.key + "#" + m.slot.idx : "anon" + (m.vanon || (m.vanon = ++anon));
  const h = hash((BF.state ? BF.state.seed : 0) + ":" + k);
  return (m.vname = FIRST[h % FIRST.length] + " " + LAST[(h >>> 8) % LAST.length]);
}

// ---------------------------------------------------------------- logging
function log(rec, kind, text) {
  if (!rec || !rec.key) return;
  let a = logs.get(rec.key);
  if (!a) logs.set(rec.key, a = []);
  a.push([+dayNow().toFixed(4), kind, text]);
  if (a.length > CAP) a.splice(0, a.length - CAP);
}
const stacks = list => (list || []).map(b => b.n + " " + BF.itemName(b.id)).join(" + ");
const who = m => nameOf(m) + " (" + pretty(m.profession) + ")";
const recOf = m => m && m.village;

// buyer/seller: villager mobs, or buyer === "player". what: an offer {buy, sell} (times = repeats) or a ready-made string.
function trade(buyer, seller, what, times) {
  const rec = recOf(seller) || recOf(buyer);
  if (!rec) return;
  let text;
  if (typeof what === "string") text = what;
  else {
    const n = times || 1;
    text = "gave " + stacks(what.buy.map(b => ({ id: b.id, n: b.n * n }))) + ", got " + stacks([{ id: what.sell.id, n: what.sell.n * n }]);
  }
  const a = buyer === "player" ? "Player" : who(buyer);
  log(rec, "trade", a + " traded with " + who(seller) + ": " + text);
}
function bed(m, x, y, z, what) {
  const rec = (m && m.village) || villageAt(x, z);
  if (rec) log(rec, "bed", (m ? who(m) : "Player") + " placed a " + (what || "bed") + " at " + x + ", " + y + ", " + z);
}
function profession(m, from, to) {
  if (!m || !m.village || !to || to === "unemployed" || to === "nitwit" || to === "child") return;
  log(m.village, "job", nameOf(m) + " became a " + pretty(to) + (from && from !== "unemployed" ? " (was " + pretty(from) + ")" : ""));
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

// ---------------------------------------------------------------- floating names (F3)
function labelTexture(name, prof) {
  const k = name + "|" + prof;
  let t = texCache.get(k);
  if (t) return t;
  const c = document.createElement("canvas"); c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "bold 26px sans-serif"; g.lineWidth = 5; g.strokeStyle = "#000a"; g.strokeText(name, 128, 22); g.fillStyle = "#fff"; g.fillText(name, 128, 22);
  g.font = "18px sans-serif"; g.strokeText(prof, 128, 47); g.fillStyle = "#cfe8b0"; g.fillText(prof, 128, 47);
  t = new THREE.CanvasTexture(c);
  texCache.set(k, t);
  if (texCache.size > 400) { const f = texCache.keys().next().value; texCache.get(f).dispose(); texCache.delete(f); }
  return t;
}
function dropLabel(m, l) { if (BF.scene) BF.scene.remove(l.sp); l.sp.material.dispose(); labels.delete(m); }
function updateLabels(on) {
  if (!BF.scene || typeof THREE === "undefined") return;
  const pp = BF.player && BF.player.position;
  if (!on || !pp) { for (const [m, l] of [...labels]) dropLabel(m, l); return; }
  const seen = new Set();
  for (const m of BF.mobs.list) {
    if (m.type !== "villager" || m.dead || m.removed || !m.position) continue;
    if (Math.hypot(m.position.x - pp.x, m.position.z - pp.z) > LABEL_R) continue;
    seen.add(m);
    const prof = m.child ? "Child" : pretty(m.profession), key = nameOf(m) + "|" + prof;
    let l = labels.get(m);
    if (!l) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(nameOf(m), prof), transparent: true, depthWrite: false }));
      sp.scale.set(1.6, 0.4, 1); sp.renderOrder = 10;
      BF.scene.add(sp); labels.set(m, l = { sp, key });
    } else if (l.key !== key) { l.sp.material.map = labelTexture(nameOf(m), prof); l.sp.material.needsUpdate = true; l.key = key; }
    l.sp.position.set(m.position.x, m.position.y + (m.height || 1.95) + 0.45, m.position.z);
  }
  for (const [m, l] of [...labels]) if (!seen.has(m)) dropLabel(m, l);
}

// ---------------------------------------------------------------- panel (F3)
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function renderPanel() {
  if (!panelEl) return;
  const pp = BF.player && BF.player.position, rec = pp ? villageAt(pp.x, pp.z) : null;
  if (!rec) { panelEl.hidden = true; return; }
  const t = tally(rec), a = entries(rec.key), name = (BF.signs && BF.signs.villageName && BF.signs.villageName(rec.key)) || "Village";
  const rows = a.slice(-SHOW).map(e => `<div class="vl-${e[1]}"><span>${stamp(e[0])}</span> ${esc(e[2])}</div>`).join("");
  panelEl.innerHTML = `<h4>${esc(name)}</h4><div class="vl-tally">${t.villagers} villagers &middot; ${t.beds} beds</div>` +
    (rows || `<div class="vl-none">No events yet.</div>`) + (a.length > SHOW ? `<div class="vl-none">${a.length - SHOW} older entries not shown</div>` : "");
  panelEl.hidden = false;
}

function hook() {
  if (hooked || typeof BF.on !== "function") return;
  hooked = true;
  BF.on("newWorld", reset);
  BF.on("villagerBorn", (m, a, b) => {
    if (m.village) log(m.village, "birth", nameOf(m) + " was born to " + nameOf(a) + " and " + nameOf(b));
  });
  BF.on("villagerTrade", (v, o) => trade("player", v, o));
  BF.on("blockPlaced", (x, y, z, id) => {      // beds placed by the player (villagers log their own: js/builder.js)
    const b = BF.blocks[id];
    if (b && b.bed && !b.bed.head) bed(BF.vlog.actor, x, y, z);
    else if (b && b.tent && b.tent.r === 0 && b.tent.l === 1) bed(BF.vlog.actor, x, y, z, "tent");   // its foot centre
  });
}

function reset() { logs.clear(); for (const [m, l] of [...labels]) dropLabel(m, l); }

BF.vlog = {
  actor: null,      // set around block placements made by a villager that goes through blockPlaced (explorer tents)
  CAP, nameOf, log, trade, bed, profession, entries, villageAt, tally, stamp,
  serialize() { const o = {}; for (const [k, a] of logs) if (a.length) o[k] = a; return o; },
  deserialize(o) {
    logs.clear();
    if (!o || typeof o !== "object") return;
    for (const k in o) if (Array.isArray(o[k])) logs.set(k, o[k].filter(e => Array.isArray(e) && typeof e[2] === "string").slice(-CAP));
  },
  reset,
  init() {
    panelEl = document.getElementById("vlog");
    hook();
  },
  update(dt, on) {
    hook();
    updateLabels(on);
    if (!panelEl) panelEl = document.getElementById("vlog");
    if (!on) { if (panelEl) panelEl.hidden = true; panelT = 0; return; }
    const t = performance.now();                  // wall clock: the game's dt is clamped at low frame rates
    if (t - panelT > 500) { panelT = t; renderPanel(); }
  },
};
})();
