// @ci integration suite=world,village timeout=900
// A caravan trip force-ended at a meeting with partial copies (bug-118, Gordon's run 2026-11-04): test/cluster-workers.js --trips on two
// workers with partial copies. Only the worker running the merchant knows its trip; at the meeting that forces the village off, every
// copy must end it (js/villagesim.js forceTrips fetches the merchants on trips first). Read from each copy as it stood, only that worker
// ended it and dropped its pin, the copies' decisions went apart, and at the next meeting one worker skipped an exchange: the others
// waited 120 s for it and the simulation stopped. Every exchange now also checks the workers are at the same one (js/cworkers.js xchange).
// Usage: node test/cluster-force-trips.js
const cp = require('child_process'), path = require('path');
const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'cluster-workers.js'), '--workers', '2', '--partial', '--trips', '3', '--seconds', '5'], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
