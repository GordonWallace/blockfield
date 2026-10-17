// Grass spreading (idea-044): exposed dirt next to grass turns into grass after a while, as in vanilla. A dirt block becomes grass when it
// has sky light of at least MIN_LIGHT above it, no opaque block on top, and a grass block among its 26 neighbours (beside it, diagonally, one
// level up or down). Farmland, dirt paths and coarse dirt never change.
// Random ticks: every sim step a few columns of loaded chunks are picked at random (SAMPLES_PER_S on the sim clock, so fast-forward speeds it
// up too), and the top solid block of each is looked at; dirt that qualifies turns at once. With a few hundred chunks loaded a column comes up
// about once a game day, so bare dirt beside grass greens over within a day or two, at random.
// API: BF.grass = { tick(), check(x, y, z), spreads(x, y, z), SAMPLES_PER_S, MIN_LIGHT, stats() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const SAMPLES_PER_S = 120;   // random columns looked at per sim second, across all loaded chunks
const MIN_LIGHT = 9;         // sky light above the dirt (vanilla's grass rule)
const MAX_PER_TICK = 600;    // columns per sim step at most (a long step catches up over the next ones)

let last = null, carry = 0, turned = 0, looked = 0, list = [], listAt = -1;

// Would the dirt at (x, y, z) turn into grass now? (dirt, open to the sky light, not covered, grass beside it)
function spreads(x, y, z) {
  const W = BF.world, B = BF.B;
  if (W.getBlock(x, y, z) !== B.dirt) return false;
  if (BF.OPAQUE[W.getBlock(x, y + 1, z)] || BF.FLUID[W.getBlock(x, y + 1, z)]) return false;
  const L = BF.skyLight && BF.skyLight.get ? BF.skyLight.get(x, y + 1, z) : 15;
  if (L < MIN_LIGHT) return false;
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if ((dx || dy || dz) && W.getBlock(x + dx, y + dy, z + dz) === B.grass) return true;
  }
  return false;
}
// Looks at one block: turns it into grass when it qualifies. Returns true when it turned.
function check(x, y, z) {
  if (!spreads(x, y, z)) return false;
  BF.world.setBlock(x, y, z, BF.B.grass);
  turned++;
  return true;
}
function chunks() {
  const W = BF.world, n = W.chunks.size;
  if (listAt !== n) { list = [...W.chunks.values()]; listAt = n; }   // rebuilt when chunks load or unload
  return list;
}
function tick() {
  const W = BF.world;
  if (!W || !W.chunks || BF.B.dirt == null || BF.B.grass == null) return;
  const now = BF.simNow ? BF.simNow() : 0;
  if (last == null) { last = now; return; }
  const dt = Math.max(0, Math.min(30, now - last));
  last = now;
  carry += dt * SAMPLES_PER_S;
  let n = Math.min(MAX_PER_TICK, Math.floor(carry));
  carry -= n;
  if (carry > MAX_PER_TICK * 4) carry = MAX_PER_TICK * 4;
  const cs = chunks(), CS = BF.CS;
  if (!cs.length) return;
  for (; n > 0; n--) {
    const c = cs[(Math.random() * cs.length) | 0];
    if (!c || !W.chunks.has(c.cx + "," + c.cz)) { listAt = -1; continue; }
    const x = c.cx * CS + ((Math.random() * CS) | 0), z = c.cz * CS + ((Math.random() * CS) | 0);
    const y = W.heightAt(x, z);
    looked++;
    check(x, y, z);
  }
}

BF.grass = { tick, check, spreads, SAMPLES_PER_S, MIN_LIGHT, stats: () => ({ turned, looked }) };
{
  const world = BF.world;
  if (world && world.tickSim) { const prev = world.tickSim; world.tickSim = () => { prev(); tick(); }; }
}
})();
