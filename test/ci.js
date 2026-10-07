// CI test runner: runs a tier of the headless tests one after another and fails if any of them fails.
// Usage: NODE_PATH=$(npm root -g) node test/ci.js <baseline|integration> [outDir=ci-out] [name ...]
// Tiers and per-test settings live in test/ci.json. A test file that is not listed there can declare its own tier with a comment
// line `// @ci baseline`, `// @ci integration` or `// @ci skip <reason>`; an unlisted, untagged test runs in integration.
// Tests run serially: several headless games at once starve each other and village loading gets flaky.
// A test fails when it exits non-zero, times out, throws in the page (PAGEERROR), or prints a line starting with FAIL / FAILED.
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

function runOne(t) {
  const out = path.join(outDir, t.name);
  const args = t.kind === 'actions' ? [path.join('test', 'run.js'), out, t.file] : [t.file, ...(t.args || []).map(a => a.replace('{out}', out))];
  const timeout = (t.timeout || 300) * 1000;
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...(t.env || {}) }, timeout, encoding: 'utf8', maxBuffer: 1 << 28 });
  const secs = (Date.now() - t0) / 1000;
  const log = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(out + '.log', log);
  const reasons = [];
  if (r.error && r.error.code === 'ETIMEDOUT') reasons.push('timed out after ' + (t.timeout || 300) + 's');
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

console.log(`tier ${tier}: ${run.length} test(s)`);
const results = [];
for (const t of run) {
  process.stdout.write(`::group::${t.name}\n`);
  const r = runOne(t);
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
