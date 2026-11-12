// @ci baseline suite=ui
// Which tests a pull request's baseline run takes (test/ci.js, test/ci.json "look"). Plain node, no browser: node test/ci-scope.js
//  - a pull request that only changes the realistic look's own files runs the look's set: every real-* test, the lints, the look-off
//    game tests, and none of the simulation's smoke tests;
//  - one changed file outside them (shared drawing code, the runner itself), no list of changed files, an empty list, or `full` on
//    the CI suites line runs the whole smoke set;
//  - suites named on the line are added to the look's set.
const cp = require('child_process'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const list = (changed, body) => {
  const env = { ...process.env, CI_DRY: '1', CI_HOST: 'page', PR_BODY: body || '' };
  for (const k of ['CI_CHANGED', 'CI_CHANGED_FROM', 'CI_SUITES', 'CI_SHARD', 'CI_PLAN', 'CI_OTHERS']) delete env[k];
  if (changed) env.CI_CHANGED = changed.join('\n');
  return cp.execFileSync(process.execPath, [path.join('test', 'ci.js'), 'baseline'], { cwd: root, env, encoding: 'utf8' }).trim().split(/\s+/);
};
let bad = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const real = fs.readdirSync(__dirname).filter(f => /^real-.*\.js$/.test(f)).map(f => f.replace(/\.js$/, ''));
const whole = list(null);
const look = list(['js/real/terrain.js', 'js/real/new.js', 'test/real-look.js', 'docs/REALISTIC_CONTRACT.md', 'README.md', 'index.html']);
check(whole.includes('farmer-dig') && whole.includes('planet-world') && whole.length > 40, `no list of changed files: the whole smoke set (${whole.length} tests)`);
check(real.length > 0 && real.every(n => look.includes(n)), `look-only: every real-* test runs (${real.length})`);
check(['client-lint', 'wallclock-lint', 'mining-vanilla', 'lod-off'].every(n => look.includes(n)), 'look-only: the lints and the look-off game tests run');
check(!look.includes('farmer-dig') && !look.includes('planet-world') && look.length < whole.length / 2, `look-only: the simulation's smoke tests do not (${look.length} tests)`);
for (const f of ['js/lod.js', 'js/sky.js', 'js/world.js', 'test/ci.js', 'test/ci.json', '.github/workflows/baseline.yml', 'js/realistic.js', 'test/lib.js'])
  check(list(['js/real/terrain.js', f]).length === whole.length, `a change to ${f} as well: the whole set`);
check(list([]).length === whole.length, 'an empty list of changed files: the whole set');
check(list(['js/real/terrain.js'], 'CI suites: full').length === whole.length, 'CI suites: full: the whole set');
const plus = list(['js/real/terrain.js'], 'CI suites: items');
check(look.every(n => plus.includes(n)) && plus.includes('creative-trash') && !plus.includes('farmer-dig'), 'CI suites: items on a look-only pull request adds that suite to the look\'s set');
process.exit(bad ? 1 : 0);
