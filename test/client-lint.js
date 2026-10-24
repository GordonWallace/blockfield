// @ci baseline suite=ui
// The page draws from the protocol, not the simulation (spec r15-37). Plain node, no browser: node test/client-lint.js
// The render and UI files below may read the client's mirror (BF.client.world), ask queries (BF.client.query) and listen to the
// protocol's events (BF.proto.listen), and read what the page keeps of its own: the player and camera, the world copy it meshes and
// collides with (BF.world, BF.skyLight: in the page the simulation's, in a worker the page's replica, r15-38), world generation from
// the seed, the planet's geometry, block and item tables, textures, the sky and weather it draws. They must not read the simulation's
// modules: mobs, drops, boats, bees, horses, villages, villagers' jobs and trades, chests, maps' pixels, logs. The test fails on any
// such read (outside comments), on a file in the list that no longer exists, and on an ALLOW entry no file uses any more, so the lists stay true.
const fs = require("fs"), path = require("path");
const JS = path.join(__dirname, "..", "js");

// The render and UI files (the page's side).
const FILES = ["mobview.js", "entityview.js", "mapview.js", "villagerhover.js", "villagepanel.js", "debugoverlay.js", "audio.js", "coords.js",
  "cracks.js", "globe.js", "lod.js", "faithful.js", "invscreen.js"];
// Left out, with why:
//   main.js       the page's boot: it starts the simulation in the page (BF.mobs.init and friends); r15-38 moves that into a worker
//   debugfeed.js  the debug screen's feed: produced on the simulation's side (the spec), so it reads the simulation
//   alerts.js     the debug screen's alerts: checked against village log entries as the simulation writes them
//   commands.js   slash commands act on the simulation (spawn, kill, give, weather); r15-38 sends them as requests
//   player.js, maps.js, signs.js, sky.js, weather.js, world.js, villagelog.js: simulation files that also draw or take input; their
//                 screens and overlays read the protocol where this spec moved them (the village panel and names: js/villagepanel.js)
// The inventory screens (r15-44) are js/invscreen.js, in the list; the items themselves are js/playerinv.js, a simulation file, which must
// not touch the page (document, window, performance.now, localStorage: checked below).

// The simulation's modules the page must not read.
const SIM = ["mobs", "drops", "boats", "bees", "horses", "ids", "villageSim", "villageLife", "jobs", "econ", "market", "trades", "prices",
  "storage", "vlog", "villagerStatus", "signs", "maps", "stables", "merchant", "explorer", "builder", "bridges", "breeding", "shepherd",
  "poultry", "cowherd", "pigFarmer", "baker", "beekeeper", "fletcher", "forester", "miner", "toolsmith", "furniture", "glassmaker",
  "wildlife", "happiness", "vstats", "dayTimeline", "regions", "stateHash", "req", "perf", "food", "durability", "active"];
// Reads of a simulation module that are allowed: constant tables and drawing helpers, not simulation state. [file, "module.property", why]
const ALLOW = [
  ["mobview.js", "mobs.outfits", "the professions' outfits: a constant table of js/mobs.js"],
  ["entityview.js", "bees.CAP", "how many bees are drawn at most: a constant"],
  ["entityview.js", "bees.BODY", "a bee's length: a constant"],
  ["entityview.js", "bees", "whether bees exist in this build (BF.bees ?)"],
  ["mapview.js", "maps.heldCanvas", "draws a map held in the hand (a drawing helper of js/maps.js)"],
  ["mapview.js", "maps", "whether maps exist in this build (BF.maps ?)"],
  ["invscreen.js", "req.player", "sends the player's screen actions as requests (js/requests.js player(): through BF.client)"],
  ["invscreen.js", "req", "whether the request queue is there (BF.req ?)"],
  ["invscreen.js", "durability", "an item's uses when new, for the durability bar (a constant of the item tables, js/toolwear.js)"],
];
// js/invscreen.js reaches the inventory module as SIM (BF.inventory: in the page the simulation's own, in a worker the page's copy). It may
// read only these from it: constant tables, and the hotbar slot, which is the page's (r15-44).
const INV_OK = ["HOTBAR", "SIZE", "CHEST_SIZE", "COOK_TIME", "VILLAGER_SLOTS", "recipes", "smelting", "smeltList", "fuel", "fuelList", "levelNames",
  "levelXP", "initSim", "select", "selectedIndex"];
// Properties of page-side modules that are simulation state.
const DENY = ["world.edits", "inventory.chests", "inventory.chestState", "inventory.chestView", "inventory.tradeView", "inventory.chestRecord",
  "inventory.furnaceState", "inventory.holderOf"];

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).split("\n").map(l => {
  // a // comment outside strings (good enough for this code base: no URLs in code lines of these files)
  let q = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "/" && l[i + 1] === "/") return l.slice(0, i);
  }
  return l;
});

const bad = [], used = new Set();
let ok = true;
for (const f of FILES) {
  const p = path.join(JS, f);
  if (!fs.existsSync(p)) { console.log("FAIL " + f + " is listed but missing"); ok = false; continue; }
  stripComments(fs.readFileSync(p, "utf8")).forEach((line, i) => {
    const re = /\bBF\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;
    let m;
    while ((m = re.exec(line))) {
      const mod = m[1], prop = m[2], full = prop ? mod + "." + prop : mod;
      if (DENY.includes(full)) { bad.push(`${f}:${i + 1}: BF.${full}`); continue; }
      if (!SIM.includes(mod)) continue;
      const a = ALLOW.find(e => e[0] === f && (e[1] === full || (!prop && e[1] === mod)));
      if (a) { used.add(a[0] + " " + a[1]); continue; }
      bad.push(`${f}:${i + 1}: BF.${full}`);
    }
  });
}
// invscreen.js: what it takes from the inventory module (SIM.x), and no BF.inventory reads beside the one that names it
stripComments(fs.readFileSync(path.join(JS, "invscreen.js"), "utf8")).forEach((line, i) => {
  const re = /\bSIM\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(line))) if (!INV_OK.includes(m[1])) bad.push(`invscreen.js:${i + 1}: SIM.${m[1]}`);
  if (/\bBF\.inventory\.[A-Za-z_$]/.test(line)) bad.push(`invscreen.js:${i + 1}: BF.inventory.<a property>`);
});
// playerinv.js: no page (it runs in the worker and headless too)
stripComments(fs.readFileSync(path.join(JS, "playerinv.js"), "utf8")).forEach((line, i) => {
  const m = /\b(document|window|localStorage|performance\.now)\b/.exec(line);
  if (m) bad.push(`playerinv.js:${i + 1}: ${m[1]}`);
});
for (const b of bad) console.log("FAIL reads the simulation: " + b);
for (const [f, k] of ALLOW) if (!used.has(f + " " + k)) { console.log("FAIL allowed read no longer used: " + f + " BF." + k); ok = false; }
if (bad.length) ok = false;
console.log((ok ? "PASS" : "FAIL") + " render and UI files read the protocol, not the simulation (" + FILES.length + " files, " + bad.length + " reads)");
process.exit(ok ? 0 : 1);
