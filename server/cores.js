// The machine's performance cores (Gordon, 2026-10-28): the Cluster workers setting's Automatic count (js/simhost.js workers), worked out
// on the world server's machine, where the workers run. One worker a performance core: Gordon's laptop ran 8 workers well and 16 (its
// logical CPUs) slower than one thread, the hyper-threads and efficiency cores sharing the work's caches and memory.
//   macOS: sysctl hw.perflevel0.physicalcpu (Apple silicon's performance cores; hw.physicalcpu on an Intel Mac)
//   Linux: the physical cores (one per set of thread siblings) among the hybrid Intel's performance cores (/sys/devices/cpu_core/cpus),
//          else among every online CPU
//   else (Windows): half the logical CPUs (hyper-threading)
// Never more than the CPUs this process may use (os.availableParallelism: a container's limit), nor more than MAX.
// Where the world server's threads run (Gordon's laptop, 2026-10-30: a Ryzen AI 9 HX 370, four fast Zen 5 cores and eight slower Zen 5c;
// test4, 8 cluster workers at 10x: the simulation thread pinned to a fast core and the region workers to the slow ones 117 ticks a second,
// unpinned 108, everything on the slow cores 93, 4 workers on the fast cores 111): place(n) on Linux with CPUs of two top clocks
// (cpufreq cpuinfo_max_freq: AMD's Zen 5 and Zen 5c, Intel's P and E cores) puts the simulation thread (the leader: it serves the page,
// journals and runs its own share) on the fast CPUs, and its n - 1 region workers on the others when they have a physical core each.
// Elsewhere (one top clock, macOS, Windows, no cpufreq in a container) nothing is pinned. pin(cpus) is taskset on the calling thread's
// own id (/proc/thread-self), so a worker_thread pins only itself.
// API: perfCores() -> { n, logical, how }, speeds(sys?) -> { fast, slow } (CPU numbers) | null, place(n, sys?) -> { leader, followers } | null,
//      pin(cpus) -> true when pinned, cpuText(cpus) -> "0-3,12-15"
"use strict";
const os = require("os"), fs = require("fs"), path = require("path"), cp = require("child_process");
const MAX = 16;

// "0-3,8,10-11" -> [0, 1, 2, 3, 8, 10, 11]
function cpuList(text) {
  const out = [];
  for (const part of String(text).trim().split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (m) for (let i = +m[1]; i <= +(m[2] || m[1]); i++) out.push(i);
  }
  return out;
}
const read = f => { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } };
function detect() {
  if (process.platform === "darwin") {
    for (const key of ["hw.perflevel0.physicalcpu", "hw.physicalcpu"]) {
      try { const n = +cp.execFileSync("sysctl", ["-n", key], { encoding: "utf8", timeout: 2000 }).trim(); if (n > 0) return { n, how: key === "hw.physicalcpu" ? "physical cores" : "performance cores" }; } catch (_) { /* next */ }
    }
  }
  if (process.platform === "linux") {
    const pc = read("/sys/devices/cpu_core/cpus"), all = read("/sys/devices/system/cpu/online");
    const cpus = cpuList(pc || all || "");
    if (cpus.length) {
      const cores = new Set();
      for (const c of cpus) cores.add((read("/sys/devices/system/cpu/cpu" + c + "/topology/thread_siblings_list") || String(c)).trim());
      return { n: cores.size, how: pc ? "performance cores" : "physical cores" };
    }
  }
  return null;
}
let known = null;
function perfCores() {
  if (known) return known;
  const logical = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  const d = detect() || { n: Math.max(1, Math.floor(logical / 2)), how: "half the logical CPUs" };
  return (known = { n: Math.max(1, Math.min(MAX, logical, d.n)), logical, how: d.how });
}
// The online CPUs by top clock: within 5% of the fastest, and the rest; null when they all have one top clock or it can't be read.
const SYS = "/sys/devices/system/cpu";   // (tests: another folder laid out the same)
function speeds(sys = SYS) {
  if (process.platform !== "linux") return null;
  const cpus = cpuList(read(sys + "/online") || "");
  const f = cpus.map(c => +(read(sys + "/cpu" + c + "/cpufreq/cpuinfo_max_freq") || 0));
  if (cpus.length < 2 || f.some(x => !(x > 0))) return null;
  const top = Math.max(...f), fast = cpus.filter((c, i) => f[i] >= top * 0.95), slow = cpus.filter((c, i) => f[i] < top * 0.95);
  return slow.length ? { fast, slow } : null;
}
const physical = (cpus, sys) => new Set(cpus.map(c => (read(sys + "/cpu" + c + "/topology/thread_siblings_list") || String(c)).trim())).size;
function place(n, sys = SYS) {
  const s = speeds(sys);
  if (!s) return null;
  return { leader: s.fast, followers: n > 1 && physical(s.slow, sys) >= n - 1 ? s.slow : null };
}
function pin(cpus) {
  if (process.platform !== "linux" || !cpus || !cpus.length) return false;
  try {
    const tid = path.basename(fs.readlinkSync("/proc/thread-self"));
    cp.execFileSync("taskset", ["-cp", cpus.join(","), tid], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch (_) { return false; }
}
// [0, 1, 2, 3, 12, 13] -> "0-3,12-13"
function cpuText(cpus) {
  const out = [];
  for (let i = 0; i < cpus.length;) { let j = i; while (j + 1 < cpus.length && cpus[j + 1] === cpus[j] + 1) j++; out.push(j > i ? cpus[i] + "-" + cpus[j] : String(cpus[i])); i = j + 1; }
  return out.join(",");
}
module.exports = { perfCores, cpuList, MAX, speeds, place, pin, cpuText };
