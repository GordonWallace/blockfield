// Game options of a world (BF.gameOpts; Gordon, 2026-10-19): which monsters spawn, world by world. Set when creating a world, from the
// world list on the start screen (Options) and in game from the pause menu (Game options); saved in the world's list entry (js/save.js
// meta.monsters) so the start screen can change them without opening the world. A world with none (made before this) takes DEFAULTS.
//  - Each switchable monster is one boolean on its type, `spawns` (js/mobs.js TYPES; BF.mobs.spawnTypes() lists them). This module only
//    sets those booleans from the world's options and keeps the options in step with them.
//  - A monster turned off never spawns (js/mobs.js trySurface / tryCave drop a try that picked it, without picking again), and the ones
//    already in the world leave when it is turned off: loaded ones and ones stored with unloaded chunks (js/wildlife.js). Saved ones
//    don't come back when a world opens with it off (js/mobsave.js, js/wildlife.js restore skip them). /summon still makes one.
//  - The others spawn as often as before: each area's monster cap (js/wildlife.js) shrinks by the switched-off monsters' share of the
//    spawn weights (BF.mobs.spawnShare) and only monsters that are on count against it, so each one's numbers stay the same.
// API: BF.gameOpts = { DEFAULTS, NAMES, types(), name(type), monsters() -> {type: bool}, on(type), set(type, on), setAll(o), normalize(o), purgeStored() }
(() => {
"use strict";
const BF = (window.BF = window.BF || {});

const DEFAULTS = { zombie: true, skeleton: true, creeper: false, spider: false };   // a new world, and worlds saved before the options existed
const NAMES = { zombie: "Zombies", skeleton: "Skeletons", creeper: "Creepers", spider: "Spiders" };
const types = () => (BF.mobs && BF.mobs.spawnTypes ? BF.mobs.spawnTypes() : Object.keys(DEFAULTS));
const def = t => BF.mobs && BF.mobs.typeDef ? BF.mobs.typeDef(t) : null;
const name = t => NAMES[t] || t.charAt(0).toUpperCase() + t.slice(1) + "s";
const normalize = o => { const r = {}; for (const t of types()) r[t] = o && typeof o[t] === "boolean" ? o[t] : DEFAULTS[t] !== false; return r; };
const on = t => { const T = def(t); return !T || T.spawns !== false; };
const log = text => { if (BF.glog) BF.glog.log("INFO", "options", text); };

// Wild monsters of switched-off kinds stored with unloaded chunks are dropped (js/wildlife.js stored()).
function purgeStored() {
  const st = BF.wildlife && BF.wildlife.stored && BF.wildlife.stored();
  if (!st) return 0;
  let n = 0;
  for (const [k, a] of st) {
    const keep = a.filter(e => !(e && !on(e.type)));
    n += a.length - keep.length;
    if (!keep.length) st.delete(k); else if (keep.length !== a.length) st.set(k, keep);
  }
  return n;
}
// Loaded monsters of switched-off kinds leave quietly (no drops).
function sweep() {
  const M = BF.mobs;
  if (!M || !M.list || !M.discard) return;
  const gone = {};
  for (const m of M.list.slice()) {
    if (m.dead || m.removed || on(m.type)) continue;
    M.discard(m);
    gone[m.type] = (gone[m.type] || 0) + 1;
  }
  for (const t in gone) log(`${gone[t]} ${name(t).toLowerCase()} removed (spawning is off in this world)`);
}
function apply(o) { for (const t of types()) { const T = def(t); if (T) T.spawns = !!o[t]; } }

const api = BF.gameOpts = {
  DEFAULTS, NAMES, types, normalize, name,
  monsters() { const r = {}; for (const t of types()) r[t] = on(t); return r; },
  on,
  // One monster on or off in the world being played (logged; the save picks it up: js/save.js).
  set(type, v) {
    const T = def(type);
    if (!T || typeof T.spawns !== "boolean" || T.spawns === !!v) return;
    T.spawns = !!v;
    log(`${name(type)} spawning turned ${v ? "on" : "off"}`);
    if (!v) { const n = purgeStored(); sweep(); if (n) log(`${n} stored ${name(type).toLowerCase()} removed`); }
    if (BF.emit) BF.emit("gameOptsChanged", api.monsters());
  },
  // A world's options as it opens (js/main.js newWorld, js/save.js load). Missing ones take DEFAULTS.
  setAll(o) {
    const n = normalize(o);
    apply(n);
    log("Monster spawning: " + types().map(t => name(t) + " " + (n[t] ? "on" : "off")).join(", "));
  },
  purgeStored,
};
})();
