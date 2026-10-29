// The machine's performance cores (Gordon, 2026-10-28): the Cluster workers setting's Automatic count (js/simhost.js workers), worked out
// on the world server's machine, where the workers run. One worker a performance core: Gordon's laptop ran 8 workers well and 16 (its
// logical CPUs) slower than one thread, the hyper-threads and efficiency cores sharing the work's caches and memory.
//   macOS: sysctl hw.perflevel0.physicalcpu (Apple silicon's performance cores; hw.physicalcpu on an Intel Mac)
//   Linux: the physical cores (one per set of thread siblings) among the hybrid Intel's performance cores (/sys/devices/cpu_core/cpus),
//          else among every online CPU
//   else (Windows): half the logical CPUs (hyper-threading)
// Never more than the CPUs this process may use (os.availableParallelism: a container's limit), nor more than MAX.
// API: perfCores() -> { n, logical, how }
"use strict";
const os = require("os"), fs = require("fs"), cp = require("child_process");
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
module.exports = { perfCores, cpuList, MAX };
