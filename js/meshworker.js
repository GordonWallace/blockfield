// A mesher worker (spec r15-03): builds chunk meshes' vertex arrays off the main thread with js/mesher.js, from the jobs and tables
// js/world.js sends (the tables first, and again when they change). It answers each job in order with the arrays, transferred.
importScripts("mesher.js" + self.location.search);   // (stamped like the worker: see BF.workerUrl in js/grid.js)
let tables = null;
onmessage = (e) => {
  const m = e.data;
  if (m.tables) { tables = m.tables; return; }
  const t0 = performance.now(), r = self.BF.mesher.build(m.job, tables);
  r.ms = performance.now() - t0;
  postMessage(r, self.BF.mesher.buffers(r));
};
