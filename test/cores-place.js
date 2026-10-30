// @ci baseline suite=world
// Where the world server's threads run (server/cores.js place, Gordon's laptop 2026-10-30: the simulation thread on a fast core and the
// region workers on the slow ones was the fastest of the placements measured). Plain node, a stand-in /sys/devices/system/cpu:
//   - the laptop's layout (Ryzen AI 9 HX 370: CPUs 0-3 and 12-15 at 5.16 GHz, 4-11 and 16-23 at 3.29 GHz, SMT pairs n and n + 12): the
//     leader gets 0-3,12-15; 8 workers' 7 followers get the slow CPUs (8 slow physical cores), 10 workers' 9 followers don't;
//   - every CPU the same top clock, no cpufreq (a container), a single CPU: nothing is placed;
//   - pin() on Linux pins only the calling thread (a worker_thread pins itself to its first allowed CPU; the main thread is unchanged).
// Usage: node test/cores-place.js
const fs = require('fs'), os = require('os'), path = require('path');
const { Worker } = require('worker_threads');
const cores = require('../server/cores.js');
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cpu-'));
function sys(name, n, mhz, sib) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'online'), '0-' + (n - 1) + '\n');
  for (let c = 0; c < n; c++) {
    const f = mhz(c);
    if (f != null) { fs.mkdirSync(path.join(d, 'cpu' + c, 'cpufreq'), { recursive: true }); fs.writeFileSync(path.join(d, 'cpu' + c, 'cpufreq', 'cpuinfo_max_freq'), (f * 1000) + '\n'); }
    fs.mkdirSync(path.join(d, 'cpu' + c, 'topology'), { recursive: true });
    fs.writeFileSync(path.join(d, 'cpu' + c, 'topology', 'thread_siblings_list'), sib(c) + '\n');
  }
  return d;
}
(async () => {
  const linux = process.platform === 'linux';
  const fastSlow = c => ((c % 12) < 4 ? 5160 - (c % 4) * 30 : 3290);   // (the fast cores' top clocks differ a little: preferred-core ranking)
  const laptop = sys('laptop', 24, fastSlow, c => (c % 12) + ',' + ((c % 12) + 12));
  if (linux) {
    const s = cores.speeds(laptop);
    check(s && cores.cpuText(s.fast) === '0-3,12-15' && cores.cpuText(s.slow) === '4-11,16-23', `the laptop's fast and slow CPUs (${s && cores.cpuText(s.fast)} / ${s && cores.cpuText(s.slow)})`);
    const p8 = cores.place(8, laptop), p10 = cores.place(10, laptop), p1 = cores.place(1, laptop);
    check(p8 && cores.cpuText(p8.leader) === '0-3,12-15' && p8.followers && cores.cpuText(p8.followers) === '4-11,16-23', '8 workers: the leader on the fast CPUs, 7 followers on the slow ones');
    check(p10 && p10.leader.length === 8 && p10.followers === null, '10 workers: 9 followers, 8 slow cores: followers left where the system puts them');
    check(p1 && p1.followers === null, 'one worker: only the leader is placed');
    check(cores.place(8, sys('same', 8, () => 4000, c => String(c))) === null, 'every CPU the same top clock: nothing placed');
    check(cores.place(8, sys('nofreq', 8, () => null, c => String(c))) === null, 'no cpufreq (a container): nothing placed');
    check(cores.place(8, sys('one', 1, () => 4000, () => '0')) === null, 'one CPU: nothing placed');
  } else check(cores.speeds() === null, 'not Linux: nothing placed');
  check(cores.cpuText([0, 1, 2, 3, 12, 13, 14, 15]) === '0-3,12-15' && cores.cpuText([4, 6, 7]) === '4,6-7', 'CPU lists as text');
  if (linux && fs.existsSync('/proc/thread-self')) {
    const allowed = () => fs.readFileSync('/proc/thread-self/status', 'utf8').match(/Cpus_allowed_list:\s*(\S+)/)[1];
    const before = allowed(), first = cores.cpuList(before)[0];
    const r = await new Promise((ok, no) => {
      const w = new Worker(`const { parentPort } = require('worker_threads'); const c = require(${JSON.stringify(path.resolve(__dirname, '../server/cores.js'))});
        const ok = c.pin([${first}]); parentPort.postMessage({ ok, now: require('fs').readFileSync('/proc/thread-self/status', 'utf8').match(/Cpus_allowed_list:\\s*(\\S+)/)[1] });`, { eval: true });
      w.on('message', ok); w.on('error', no);
    });
    if (!r.ok) console.log('     (no taskset here: pin() said no, as it should, and changed nothing)');
    check(!r.ok || r.now === String(first), `a worker_thread pins itself (${r.ok ? 'to ' + r.now : 'taskset not available'})`);
    check(allowed() === before, `the main thread is unchanged (${allowed()})`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `FAIL: ${fails} check(s) failed` : 'PASS: threads are placed by core speed');
  process.exit(fails ? 1 : 0);
})();
