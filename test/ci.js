// CI test runner: runs a tier of the headless tests one after another and fails if any of them fails.
// Usage: NODE_PATH=$(npm root -g) node test/ci.js <baseline|integration> [outDir=ci-out] [name ...]
// Tiers and per-test settings live in test/ci.json. A test file that is not listed there can declare its own tier with a comment
// line `// @ci baseline`, `// @ci integration` or `// @ci skip <reason>`; an unlisted, untagged test runs in integration.
// Tests run serially: several headless games at once starve each other and village loading gets flaky.
// A test fails when it exits non-zero, times out, uses more memory than CI_MEM_LIMIT_MB (10 GB), throws in the page (PAGEERROR), or prints a line starting with FAIL / FAILED.
// Writes <outDir>/<name>.log (+ screenshots) and a markdown table to $GITHUB_STEP_SUMMARY when set.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
const tier = process.argv[2] || 'baseline';
const outDir = path.resolve(process.argv[3] || 'ci-out');
const only = process.argv.slice(4);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci.json'), 'utf8'));
const NOT_TESTS = new Set(['run.js', 'lib.js', 'ci.js']);

// the full test list: manifest entries, then any other test/*.js
const tests = manifest.tests.map(t => ({ ...t }));
const listed = new Set(tests.map(t => t.file));
for (const f of fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !NOT_TESTS.has(f)).sort()) {
  const file = 'test/' + f;
  if (listed.has(file)) continue;
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const tag = /^\/\/ @ci (baseline|integration|skip)\b(.*)$/m.exec(src);
  // a module that exports a function is an action script for test/run.js; anything else runs on its own
  const kind = /module\.exports\s*=/.test(src) ? 'actions' : 'node';
  tests.push({ name: f.replace(/\.js$/, ''), file, kind, tier: tag ? tag[1] : 'integration', why: tag && tag[2].trim(), discovered: true });
}
for (const t of tests) if (!fs.existsSync(path.join(root, t.file))) t.missing = true;

const inTier = t => !t.missing && (tier === 'integration' ? t.tier === 'baseline' || t.tier === 'integration' : t.tier === tier);
const run = tests.filter(t => (only.length ? only.includes(t.name) : inTier(t)));
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
console.log(`tier ${tier}: ${run.length} test(s)`);
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
let md = `## ${tier} tests: ${results.length - failed.length}/${results.length} passed\n\n| Test | Result | Time | Notes |\n|---|---|---|---|\n`;
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
