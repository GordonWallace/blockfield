// @ci baseline suite=world timeout=900
// One mob layout (r15-50 follow-up, js/mobs.js MOB_FIELDS / AI_FIELDS): every mob and its ai table are made with all their fields at
// once and must stay in V8's fast-property mode with exactly those fields. A field some system sets on a mob that is missing from the
// lists adds a property later: the mob changes layout and, with enough of them, drops into the slow dictionary mode that made the mob
// loop ~25% slower before. Headless (tools/headless.js load), seed 3 at the village nearest the spawn:
//   - every monster and animal type spawned next to the player and a villager child set growing up, then the village run for some game seconds;
//   - every live mob and ai table has fast properties (%HasFastProperties);
//   - no mob or ai table has a field outside the lists (named, with the mob type, so the fix is to add it there).
// Usage: node test/mob-shape.js [seed=3] [seconds=300]
const path = require('path');
require('v8').setFlagsFromString('--allow-natives-syntax');
const hasFast = new Function('o', 'return %HasFastProperties(o)');
const { load } = require(path.join(__dirname, '..', 'tools', 'headless.js'));
const seed = +(process.argv[2] || 3), seconds = +(process.argv[3] || 300);
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

const { BF } = load();
const t0 = Date.now();
const h = BF.boot.headless({ seed, settings: { at: 'village' } });
console.log(`booted seed ${seed} in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${BF.mobs.list.length} mobs`);
const M = BF.mobs, MOB = new Set(M.MOB_FIELDS), AI = new Set(M.AI_FIELDS);
check(MOB.size === M.MOB_FIELDS.length && AI.size === M.AI_FIELDS.length, 'the field lists have no duplicates');

// every type once, a few blocks from the player (on the ground: spawn at the surface)
const p = BF.player.position;
let made = 0;
for (const t of M.types) {
  const x = Math.floor(p.x) + 4 + (made % 5) * 2, z = Math.floor(p.z) + 4 + Math.floor(made / 5) * 2;
  let y = Math.floor(p.y) + 8;
  while (y > p.y - 20 && !BF.SOLID[BF.world.getBlock(x, y - 1, z)]) y--;
  if (M.spawn(t, x + 0.5, y, z + 0.5)) made++;
}
check(made === M.types.length, `spawned ${made} of ${M.types.length} types`);
// a villager child that grows up during the run (bug-080: growUp set a field outside the lists, and no child grew up in a plain run)
const kid = M.spawn('villager', Math.floor(p.x) + 2.5, Math.floor(p.y) + 1, Math.floor(p.z) + 2.5);
const madeKid = !!(kid && BF.breeding.makeChild(kid));
check(madeKid && kid.child && BF.breeding.growUp(kid), 'a villager child made and set growing up');

const extra = new Map(), extraAi = new Map();
let seen = 0, slow = [], slowAi = [];
const scan = () => {
  for (const m of M.list) {
    if (m.removed) continue;
    seen++;
    for (const k of Object.keys(m)) if (!MOB.has(k)) extra.set(k, m.type + (m.profession ? '/' + m.profession : ''));
    if (m.ai) for (const k of Object.keys(m.ai)) if (!AI.has(k)) extraAi.set(k, m.type);
    if (!hasFast(m)) slow.push(m.type);
    if (m.ai && !hasFast(m.ai)) slowAi.push(m.type);
  }
};
const t1 = Date.now(), n = Math.round(seconds / BF.warp.TICK);
for (let i = 0; i < n; i += 200) { h.tick(Math.min(200, n - i)); scan(); }
check(madeKid && !kid.child, 'the child grew up during the run');
console.log(`ran ${seconds} game s in ${((Date.now() - t1) / 1000).toFixed(0)} s; ${M.list.length} mobs now, ${seen} mob checks`);
check(!extra.size, `no mob fields outside MOB_FIELDS` + (extra.size ? ': ' + JSON.stringify([...extra]) : ''));
check(!extraAi.size, `no ai fields outside AI_FIELDS` + (extraAi.size ? ': ' + JSON.stringify([...extraAi]) : ''));
check(!slow.length, `every mob has fast properties` + (slow.length ? ` (${slow.length} slow: ${[...new Set(slow)].join(', ')})` : ''));
check(!slowAi.length, `every ai table has fast properties` + (slowAi.length ? ` (${slowAi.length} slow: ${[...new Set(slowAi)].join(', ')})` : ''));
const shapes = new Set(M.list.map(m => Object.keys(m).join()));
check(shapes.size === 1, `one mob layout (${shapes.size})`);

console.log(fails ? `FAIL mob-shape (${fails})` : 'PASS mob-shape');
require('process').exit(fails ? 1 : 0);
