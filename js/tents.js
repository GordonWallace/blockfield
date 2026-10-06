// Tents (BF.tents): a bed that is 3 blocks wide, 2 long and 2 high at the ridge, and that monsters cannot see through. Block states live in blocks.js (tentDefs, `tent: {f, r, l}`),
// the item is `tent`, the recipe is in js/recipes-jobs.js, players place and sleep in them from player.js, explorers pitch them (js/explorer.js).
// Geometry: the cell the tent is placed from is its foot centre `origin` (row 0, lateral 1). Facing f runs foot -> head like beds (DIRS[f]); lateral index l
// (0..2) steps along DIRS[(f + 3) % 4], the direction local +x of the drawn boxes points to for facing f.
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const lat = f => BF.DIRS[(f + 3) % 4];
// The twelve cells of a tent with origin (x, y, z) and facing f, six on the ground and the six above them (the ridge is two blocks high):
// [{x, y, z, r, l, up, id}].
function cells(x, y, z, f) {
  const [dx, dz] = BF.DIRS[f], [lx, lz] = lat(f), out = [];
  for (let up = 0; up < 2; up++) for (let r = 0; r < 2; r++) for (let l = 0; l < 3; l++)
    out.push({ x: x + r * dx + (l - 1) * lx, y: y + up, z: z + r * dz + (l - 1) * lz, r, l, up: !!up, id: BF.tentId(f, r, l, up) });
  return out;
}
const isTent = id => !!(BF.blocks[id] && BF.blocks[id].tent);
// Origin and facing of the tent that the tent block at (x, y, z) belongs to.
function originOf(x, y, z, id) {
  const t = BF.blocks[id == null ? BF.world.getBlock(x, y, z) : id].tent, [dx, dz] = BF.DIRS[t.f], [lx, lz] = lat(t.f);
  return { x: x - t.r * dx - (t.l - 1) * lx, y: y - (t.up ? 1 : 0), z: z - t.r * dz - (t.l - 1) * lz, f: t.f };
}
// Can a tent stand here: every cell free (air / plants / replaceable), the ground ones with a solid block below, all loaded, no mob or player inside.
function canPlace(x, y, z, f, blocked) {
  const W = BF.world, free = id => id === 0 || BF.RENDER[id] === 3 || !!BF.REPLACEABLE[id];
  return cells(x, y, z, f).every(c => y > 0 && c.y < BF.H && W.isLoaded(c.x, c.z) && free(W.getBlock(c.x, c.y, c.z)) &&
    (c.up || (BF.SOLID[W.getBlock(c.x, c.y - 1, c.z)] && !BF.FLUID[W.getBlock(c.x, c.y - 1, c.z)])) && !(blocked && blocked(c.x, c.y, c.z)));
}
function place(x, y, z, f, blocked) {
  if (!canPlace(x, y, z, f, blocked)) return false;
  for (const c of cells(x, y, z, f)) { BF.world.setBlock(c.x, c.y, c.z, c.id); if (BF.emit) BF.emit("blockPlaced", c.x, c.y, c.z, c.id); }
  return true;
}
// Takes the other parts away (no drops) after one part was broken or the whole tent is struck. Returns true when a tent was removed.
function remove(x, y, z, id) {
  if (!isTent(id)) return false;
  const o = originOf(x, y, z, id);
  for (const c of cells(o.x, o.y, o.z, o.f)) if (BF.world.getBlock(c.x, c.y, c.z) === c.id) BF.world.setBlock(c.x, c.y, c.z, 0);
  return true;
}
// Is mob m asleep in a tent? (monsters ignore it, see mobs.js)
const hidden = m => !!(m && m.sleeping && m.bed && m.bed.tent);
// A flat 3x2 site (with two free blocks of headroom) close to (px, pz): the nearest origin within `radius` whose six cells share one ground height. Returns {x, y, z, f} or null.
function findSite(px, pz, radius, blocked) {
  const W = BF.world;
  let best = null, bd = Infinity;
  for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
    const x = Math.floor(px) + dx, z = Math.floor(pz) + dz, d = Math.hypot(dx, dz);
    if (d >= bd || !W.isLoaded(x, z)) continue;
    const y = W.heightAt(x, z) + 1;
    for (const f of [0, 1, 2, 3]) if (canPlace(x, y, z, f, blocked)) { best = { x, y, z, f }; bd = d; break; }
  }
  return best;
}
BF.tents = { cells, originOf, canPlace, place, remove, isTent, hidden, findSite };
})();
