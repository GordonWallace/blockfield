// @ci integration suite=world timeout=1200
// Clusters split again after back to one (js/rplay.js toSolo then startSplit, which the automatic split does after every trial that
// doesn't pay): test/cluster-workers.js with 3 workers, partial copies and planned owners, back to one at second 20 and split again at
// second 40, compared with one worker every second to 60. Before the change-only tables started from what every worker has at setup,
// the farmland stamps an owner dropped in the first interval stayed on the other workers.
// Usage: node test/cluster-rejoin.js
const cp = require('child_process'), path = require('path');
const args = ['--workers', '3', '--partial', '--plan', '--extra', '8', '--seconds', '60', '--leave', '20', '--rejoin', '40'];
const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'cluster-workers.js'), ...args], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
