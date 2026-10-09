// CI test runner: runs a tier of the headless tests one after another and fails if any of them fails.
// Usage: NODE_PATH=$(npm root -g) node test/ci.js <baseline|integration|suites> [outDir=ci-out] [name ...]
// Tiers and per-test settings live in test/ci.json. A test file that is not listed there can declare its own tier with a comment
// line `// @ci baseline`, `// @ci integration` or `// @ci skip <reason>`; an unlisted, untagged test runs in integration.
// Tests run serially: several headless games at once starve each other and village loading gets flaky. To go faster, CI
// splits a tier across several runners (CI_SHARD below), one machine each.
// A test fails when it exits non-zero, times out, uses more memory than CI_MEM_LIMIT_MB (10 GB), throws in the page (PAGEERROR), or prints a line starting with FAIL / FAILED.
// Suites (test/ci.json "suites", or a test file's `// @ci ... suite=<name>` header) group the tests by game area. A baseline run adds every test of the suites named in CI_SUITES
// ("jobs ui", "all"), or in a "CI suites: jobs, ui" line of the pull request body (PR_BODY, set by the workflow). The long tests
// (ci.json "soak") run only when soak is named too ("jobs soak") or with all, so a suite stays a few minutes.
// `node test/ci.js suites` lists them.
// Writes <outDir>/<name>.log (+ screenshots) and a markdown table to $GITHUB_STEP_SUMMARY when set.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const tier = process.argv[2] || 'baseline';
const outDir = path.resolve(process.argv[3] || 'ci-out');
const only = process.argv.slice(4);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci.json'), 'utf8'));
const NOT_TESTS = new Set(['run.js', 'lib.js', 'ci.js']);

// A test file can carry its own settings in a header line, so adding a test needs no edit to the shared ci.json (parallel PRs
// kept conflicting there): `// @ci <baseline|integration|skip> [suite=<name>] [soak] [timeout=<s>] [args=<a,b,...>] [reason]`,
// e.g. `// @ci integration suite=farming timeout=600`. For a test listed in ci.json, ci.json wins where both say something.
const header = src => {
  const m = /^\/\/ @ci (baseline|integration|skip)\b(.*)$/m.exec(src);
  if (!m) return null;
  const h = { tier: m[1] }, rest = [];
  for (const w of m[2].trim().split(/\s+/).filter(Boolean)) {
    const kv = /^(suite|timeout|args)=(.+)$/.exec(w);
    if (kv) h[kv[1]] = kv[1] === 'timeout' ? +kv[2] : kv[1] === 'args' ? kv[2].split(',') : kv[2];
    else if (w === 'soak') h.soak = true;
    else rest.push(w);
  }
  h.why = rest.join(' ');
  return h;
};
// the full test list: manifest entries, then any other test/*.js
const tests = manifest.tests.map(t => ({ ...t }));
const listed = new Map(tests.map(t => [t.file, t]));
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !NOT_TESTS.has(f)).sort()) {
  const file = 'test/' + f;
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const h = header(src);
  const t = listed.get(file);
  if (t) { if (h) t.header = h; continue; }
  // a module that exports a function is an action script for test/run.js; anything else runs on its own
  const kind = /module\.exports\s*=/.test(src) ? 'actions' : 'node';
  tests.push({ name: f.replace(/\.js$/, ''), file, kind, tier: h ? h.tier : 'integration', why: h && h.why, timeout: h && h.timeout, args: h && h.args, header: h, discovered: true });
}
for (const t of tests) if (!fs.existsSync(path.join(root, t.file))) t.missing = true;

// suites: name -> tests; each test's suite (ci.json's suite lists, else the file's header)
const SUITES = manifest.suites || {};
for (const [k, s] of Object.entries(SUITES)) for (const n of s.tests) { const t = tests.find(t => t.name === n); if (t) t.suite = k; }
// soak: the long tests of every suite. A named suite runs without them unless soak is named too (or all); soak alone runs them all
const SOAK = manifest.soak || { tests: [] };
for (const n of SOAK.tests) { const t = tests.find(t => t.name === n); if (t) t.soak = true; }
const badSuite = [];
for (const t of tests) {
  const h = t.header;
  if (!h) continue;
  if (h.suite && !t.suite) { if (SUITES[h.suite]) t.suite = h.suite; else badSuite.push(`${t.name} (suite=${h.suite})`); }
  if (h.soak) t.soak = true;
  if (h.timeout && !t.timeout) t.timeout = h.timeout;
}
if (badSuite.length) { console.log(`FAIL unknown suite in a // @ci header: ${badSuite.join(', ')}. Suites: ${Object.keys(SUITES).join(', ')}`); process.exit(1); }
if (tier === 'suites') {
  const names = (k, soak) => tests.filter(t => t.suite === k && !t.missing && !!t.soak === soak).map(t => t.name).join(' ');
  for (const [k, s] of Object.entries(SUITES)) console.log(`${k}: ${s.about}\n  ${names(k, false)}\n  with soak: ${names(k, true) || '-'}\n`);
  console.log(`soak: ${SOAK.about}\n`);
  const none = tests.filter(t => !t.suite && !t.missing && t.tier !== 'skip');
  if (none.length) console.log('in no suite (give each a // @ci header with suite=<name>): ' + none.map(t => t.name).join(' '));
  process.exit(0);
}
const bodyLine = /^[\s>*_-]*CI suites?\s*:\s*(.*)$/im.exec(process.env.PR_BODY || '');
const picked = (process.env.CI_SUITES || (bodyLine ? bodyLine[1] : '')).toLowerCase().split(/[\s,]+/).map(s => s.replace(/[`*_.]/g, '')).filter(s => s && s !== 'none');
const withSoak = picked.includes('all') || picked.includes('soak');
let suites = picked.includes('all') ? Object.keys(SUITES) : picked.filter(s => s !== 'soak');
const unknown = suites.filter(s => !SUITES[s]);
if (unknown.length) { console.log(`FAIL unknown CI suite(s): ${unknown.join(', ')}. Suites: ${Object.keys(SUITES).join(', ')}, soak, all`); process.exit(1); }
if (withSoak && !suites.length) suites = Object.keys(SUITES);   // soak on its own: every suite's long tests (plus the suites)
const inTier = t => !t.missing && (tier === 'integration' ? t.tier === 'baseline' || t.tier === 'integration' : t.tier === tier || (t.tier !== 'skip' && suites.includes(t.suite) && (!t.soak || withSoak)));
let run = tests.filter(t => (only.length ? only.includes(t.name) : inTier(t)));
// CI_SHARD=k/n (1-based): this job runs only its share of the tests, so a workflow can spread one tier across n runners at
// once. Each runner is a machine of its own, so the games don't starve each other as they would side by side on one runner.
// Longest first, each to the share with the least expected time so far (soak tests count as long, others by their timeout).
const shardM = /^(\d+)\/(\d+)$/.exec(process.env.CI_SHARD || '');
const shard = shardM ? { k: +shardM[1], n: +shardM[2] } : null;
if (shard) {
  const weight = t => t.soak ? 600 : Math.min(t.timeout || 300, 900) / 5;
  const load = Array(shard.n).fill(0), mine = new Set();
  for (const t of [...run].sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name))) {
    const i = load.indexOf(Math.min(...load));
    load[i] += weight(t);
    if (i === shard.k - 1) mine.add(t);
  }
  run = run.filter(t => mine.has(t));
}
if (process.env.CI_DRY) { console.log(run.map(t => t.name).join(' ')); process.exit(0); }   // CI_DRY=1: list what would run, run nothing
fs.mkdirSync(outDir, { recursive: true });

// Memory cap per test (process tree RSS, MB). A browser that eats the whole machine gets the CI runner killed, which loses
// every result of the run; stopping the one test keeps the rest. CI_MEM_LIMIT_MB overrides.
const MEM_LIMIT_MB = +(process.env.CI_MEM_LIMIT_MB || 10240);
// the test's process and all its descendants (Playwright starts the browser in a session of its own, so walk parent links)
function tree(pid) {
  let rows;
  try { rows = cp.execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)); }
  catch (e) { return { pids: [pid], mb: 0 }; }
  const pids = new Set([pid]);
  for (let grew = true; grew;) { grew = false; for (const [p, pp] of rows) if (pids.has(pp) && !pids.has(p)) { pids.add(p); grew = true; } }
  return { pids: [...pids], mb: rows.reduce((a, [p, , rss]) => a + (pids.has(p) ? rss : 0), 0) / 1024 };
}
function spawnWatched(args, env, timeout, memMB) {
  return new Promise(resolve => {
    const ch = cp.spawn(process.execPath, args, { cwd: root, env });
    let out = '', killed = null, peakMB = 0;
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { out += d; });
    const seen = new Set();   // every process seen in the tree: one forked after the last look would otherwise be left orphaned
    const killTree = () => { for (const p of tree(ch.pid).pids) seen.add(p); for (const p of seen) try { process.kill(p, 'SIGKILL'); } catch (e) {} };
    const stop = why => { if (killed) return; killed = why; killTree(); };
    const timer = setTimeout(() => stop('time'), timeout);
    const poll = setInterval(() => { const tr = tree(ch.pid), mb = tr.mb; for (const p of tr.pids) seen.add(p); peakMB = Math.max(peakMB, mb); if (mb > memMB) stop('memory'); }, 2000);
    ch.on('error', error => { clearTimeout(timer); clearInterval(poll); resolve({ out, error, killed, peakMB }); });
    ch.on('close', status => { clearTimeout(timer); clearInterval(poll); resolve({ out, status, killed, peakMB }); });
  });
}

async function runOne(t) {
  const out = path.join(outDir, t.name);
  const args = t.kind === 'actions' ? [path.join('test', 'run.js'), out, t.file] : [t.file, ...(t.args || []).map(a => a.replace('{out}', out))];
  const timeout = (t.timeout || 300) * 1000;
  const t0 = Date.now();
  const r = await spawnWatched(args, { ...process.env, ...(t.env || {}) }, timeout, MEM_LIMIT_MB);
  const secs = (Date.now() - t0) / 1000;
  const log = r.out;
  fs.writeFileSync(out + '.log', log);
  const reasons = [];
  if (r.killed === 'time') reasons.push('timed out after ' + (t.timeout || 300) + 's');
  else if (r.killed === 'memory') reasons.push(`stopped after using ${(r.peakMB / 1024).toFixed(1)} GB of memory (limit ${(MEM_LIMIT_MB / 1024).toFixed(0)} GB)`);
  else if (r.error) reasons.push(r.error.message);
  else if (r.status !== 0) reasons.push('exit code ' + r.status);
  const lines = log.split('\n');
  const pageErr = lines.filter(l => l.startsWith('PAGEERROR'));
  if (pageErr.length && !t.allowPageErrors) reasons.push(pageErr.length + ' page error(s): ' + pageErr[0].slice(0, 200));
  const fails = lines.filter(l => /^\s*(FAIL|FAILED)\b/.test(l) || /\bFAIL(ED)?:/.test(l));
  if (fails.length) reasons.push(fails.length + ' FAIL line(s): ' + fails[0].trim().slice(0, 200));
  for (const re of t.mustPrint || []) if (!new RegExp(re, 'm').test(log)) reasons.push('expected output missing: /' + re + '/');
  return { t, secs, ok: !reasons.length, reasons, tail: lines.filter(Boolean).slice(-15).join('\n') };
}

(async () => {
const label = tier + (tier === 'baseline' && suites.length ? ' + suites ' + suites.join(', ') + (withSoak ? ' with soak' : '') : '') + (shard ? ` (part ${shard.k} of ${shard.n})` : '');
console.log(`tier ${label}: ${run.length} test(s)`);
const results = [];
for (const t of run) {
  process.stdout.write(`::group::${t.name}\n`);
  const r = await runOne(t);
  results.push(r);
  console.log(r.tail);
  process.stdout.write('::endgroup::\n');
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${t.name} (${r.secs.toFixed(0)}s)${r.ok ? '' : ': ' + r.reasons.join('; ')}`);
  if (!r.ok && process.env.GITHUB_ACTIONS) console.log(`::error title=${t.name}::${r.reasons.join('; ').replace(/\n/g, ' ')}`);
}

const failed = results.filter(r => !r.ok);
const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
let md = `## ${label} tests: ${results.length - failed.length}/${results.length} passed\n\n| Test | Result | Time | Notes |\n|---|---|---|---|\n`;
for (const r of results) md += `| ${r.t.name} | ${r.ok ? '✅ pass' : '❌ fail'} | ${r.secs.toFixed(0)}s | ${esc(r.ok ? r.t.what || '' : r.reasons.join('; '))} |\n`;
const notRun = tests.filter(t => !run.includes(t) && (t.tier === 'skip' || t.missing));
if (notRun.length && !only.length) {
  md += `\n**Not run in CI**\n\n| Test | Why |\n|---|---|\n`;
  for (const t of notRun) md += `| ${t.name} | ${esc(t.missing ? 'listed in test/ci.json but the file is not on this branch' : t.why || '')} |\n`;
}
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
fs.writeFileSync(path.join(outDir, 'summary.md'), md);
console.log(`\n${results.length - failed.length}/${results.length} passed` + (failed.length ? '; failed: ' + failed.map(r => r.t.name).join(', ') : ''));
process.exit(failed.length ? 1 : 0);
})();
