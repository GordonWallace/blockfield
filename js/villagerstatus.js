// Villager status line for the trade screen ("Farmer — Harvesting Wheat"). Every villager has one: the specialised modules
// (food, farming and shepherds, builders, explorers, foresters, furniture makers, miners) speak first, then this falls back on what the villager's everyday AI is doing.
// API: BF.villagerStatus = { text(m) }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});
const WORK_START = 0.04, WORK_END = 0.45;   // js/jobs.js: the daytime window for jobsite visits
const skyT = () => (BF.sky && typeof BF.sky.time === "number" ? BF.sky.time : 0.3);
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : "";
const blockName = id => { const b = BF.blocks && BF.blocks[id]; return b && b.name ? b.name.replace(/_/g, " ") : "jobsite"; };

// What the villager is up to in its everyday routine.
function routine(m) {
  const ai = m.ai || {}, was = ai.was || {}, nav = BF.mobs && BF.mobs.nav, t = skyT();
  if (m.sleeping) return "Sleeping";
  if (was.flee || ai.fleeT > 0) return "Running from a zombie";
  if (m.love) return "In love";
  if (nav && nav.bedtime()) {
    if (m.bed && m.bed.tent) return "Camping for the night";
    return m.bed && nav.bedOK(m.bed) ? "Heading to bed" : "Has no bed to sleep in";
  }
  if (ai.leaving) return "Heading out for the day";
  if (m.cshop && m.cshop.stage && m.cshop.deal) return "Buying " + BF.itemName(m.cshop.deal.item);   // cartographer ingredients (js/cartography.js)
  const J = m.job;
  if (m.jobsite && J && t >= WORK_START && t <= WORK_END) {
    if (J.mode === "go") return "Walking to the " + blockName(BF.world.getBlock(m.jobsite.x, m.jobsite.y, m.jobsite.z));
    if (J.mode === "work") return "Working at the " + blockName(BF.world.getBlock(m.jobsite.x, m.jobsite.y, m.jobsite.z));
  }
  if (m.profession === "unemployed") return m.seek && m.seek.site ? "Going to take a job at a " + blockName(m.seek.site.id) : "Looking for work";
  if (m.profession === "nitwit") return (was.mode || ai.mode) === "walk" ? "Wandering about" : "Loafing";
  if (t > WORK_END) return "Winding down for the evening";
  return (was.mode || ai.mode) === "walk" ? "Strolling around the village" : "Relaxing";
}

function text(m) {
  if (!m || m.type !== "villager") return "";
  const s = (BF.villageLife && BF.villageLife.statusText(m))                    // hunger, buying food, farm work (js/villagelife.js)
    || (BF.builder && BF.builder.statusText ? BF.builder.statusText(m) : "")   // building, fetching materials (js/builder.js)
    || (BF.explorer ? BF.explorer.statusText(m) : "")                          // mapping (js/explorer.js)
    || (BF.forester ? BF.forester.statusText(m) : "")                          // felling, planting, sawing (js/forester.js)
    || (BF.furniture ? BF.furniture.statusText(m) : "")                        // making beds (js/furniture.js)
    || (BF.miner ? BF.miner.statusText(m) : "")                                // quarrying, digging the mineshaft, selling stone (js/miner.js)
    || (BF.toolsmith ? BF.toolsmith.statusText(m) : "")                        // making tools, buying materials, smelting (js/toolsmith.js)
    || (BF.storage ? BF.storage.statusText(m) : "")                            // storing in / fetching from its chest (js/storage.js)
    || (BF.stables ? BF.stables.statusText(m) : "")                            // catching, feeding and penning horses (js/stables.js)
    || routine(m);
  return cap(s);
}

BF.villagerStatus = { text, routine };
})();
