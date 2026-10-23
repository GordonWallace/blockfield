// Self time by function and by file from a CPU profile (perfmobs.js PROFILE=<hour>, or DevTools): node tools/perf/profsum.js file.cpuprofile [top=40]
const p = JSON.parse(require('fs').readFileSync(process.argv[2]));
const top = +(process.argv[3] || 40);
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map();
const dts = p.timeDeltas; let total = 0;
for (let i = 0; i < p.samples.length; i++) { const n = byId.get(p.samples[i]); const cf = n.callFrame; const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (dts[i] || 0)); total += dts[i] || 0; }
const byFile = new Map(); for (const [k, v] of self) { const f = k.split(' ').pop().split(':')[0] || '(native)'; byFile.set(f, (byFile.get(f) || 0) + v); }
console.log('total ms', (total / 1000).toFixed(0));
console.log('BY FILE:'); [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log((100 * v / total).toFixed(1).padStart(6) + '%  ' + k));
console.log('TOP FUNCTIONS (self):'); [...self].sort((a, b) => b[1] - a[1]).slice(0, top).forEach(([k, v]) => console.log((100 * v / total).toFixed(1).padStart(6) + '%  ' + k));
