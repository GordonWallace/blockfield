// Villager tool wear (BF.toolWear): villagers' tools wear out at the player's rate, by the same Minecraft rules as js/player.js.
// - Breaking a block with hardness above 0 costs a tool 1 use (a sword 2); a block with no hardness (crops, grass, torches) costs nothing.
//   So felling a 10-log tree with an axe costs it 10 uses, as it would the player breaking those logs one by one.
// - Hitting a mob costs 2 uses (a sword 1). Tilling a block with a hoe, shearing a sheep and stripping a log cost 1.
// - Lifespans are the items' (js/blocks.js BF.durability): wood 59, stone 131, iron 250, gold 800, diamond 1561, shears 238.
// - A used-up tool leaves the villager's pack, with a clink, a line in the village log ("<name> (<job>)'s Iron Pickaxe broke") and a
//   record in BF.toolWear.LOG.
// - Who wears what: the miner's pickaxe (js/miner.js digging and fending off mobs), the farmer's hoe (js/villagelife.js tilling), the
//   shepherd's shears (js/shepherd.js shearing), the forester's axe (js/forester.js felling). Replacing a broken tool is each job's own business.
// API: BF.toolWear = { use(m, stack, n), forBlock(blockId, stack) -> uses, forHit(stack) -> uses, best(m, type) -> stack|null,
//                      has(m, type), rank(itemId), LOG }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const LOG = [];
const dayNow = () => (BF.sky ? (BF.sky.day || 0) + (BF.sky.time || 0) : 0);
const toolOf = s => { const it = s && BF.items[s.id]; return (it && it.tool) || null; };

// How good a tool is to work with: harvest tier first, then speed (so gold, tier 3 at speed 7, sits between iron and diamond).
const rank = id => { const t = BF.items[id] && BF.items[id].tool; return t ? (t.tier || 0) * 100 + (t.speed || 0) : -1; };
// The tool of `type` a villager works with: the best one, and of equals the most worn (used up first). The stack itself (its wear lives on it).
function best(m, type) {
  let b = null;
  for (const s of (m && m.inv) || []) {
    const t = toolOf(s);
    if (!t || t.type !== type) continue;
    if (!b || rank(s.id) > rank(b.id) || (rank(s.id) === rank(b.id) && (s.wear || 0) > (b.wear || 0))) b = s;
  }
  return b;
}
const has = (m, type) => !!best(m, type);
// Uses spent breaking block `blockId` while working with `stack` (the player's rule, js/player.js).
function forBlock(blockId, stack) {
  const b = BF.blocks[blockId], t = toolOf(stack);
  if (!b || !t || !(b.hardness > 0)) return 0;
  return t.type === "sword" ? 2 : 1;
}
const forHit = stack => { const t = toolOf(stack); return !t ? 0 : t.type === "sword" ? 1 : 2; };
// Wears villager m's tool stack `s` by n uses. Returns BF.wearStack's answer: "broken" (and the tool is gone from its pack), true, or false.
function use(m, s, n = 1) {
  if (!s || !(n > 0)) return false;
  const r = BF.wearStack(s, n);
  if (r !== "broken") return r;
  const i = m && m.inv ? m.inv.indexOf(s) : -1;
  if (i >= 0) m.inv[i] = null;
  const name = BF.itemName(s.id);
  LOG.push({ kind: "broke", day: +dayNow().toFixed(3), who: m ? m.profession : null, village: m && m.village ? m.village.key : null, tool: BF.items[s.id].name });
  if (LOG.length > 300) LOG.shift();
  if (BF.vlog && m && m.village) BF.vlog.log(m.village, "tool", BF.vlog.nameOf(m) + " (" + String(m.profession || "villager").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + ")'s " + name + " broke", m);
  if (BF.audio && m && m.position) { try { BF.audio.play("dig.metal", { x: m.position.x, y: m.position.y + 1, z: m.position.z, pitch: 1.5 }); } catch (e) { /* optional */ } }
  if (BF.emit) BF.emit("villagerToolBroke", m, s.id);
  return r;
}
BF.toolWear = { use, forBlock, forHit, best, has, rank, LOG };
})();
