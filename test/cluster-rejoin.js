// @ci integration suite=world timeout=1200
// Clusters split again after back to one (js/rplay.js toSolo then startSplit, which the automatic split does after every trial that
// doesn't pay): test/cluster-workers.js with partial copies and planned owners, compared with one worker every second.
// 1. 3 workers, back to one at second 20 and split again at second 40, to 60. Before the first swap after a split sent the change-only
//    tables whole, the farmland stamps an owner dropped in the first interval stayed on the other workers.
// 2. 4 workers, back to one and split again every 15 seconds, to 80. Before a worker dropped the chunks waiting to bring their stored
//    wild mobs back when their group's worker had, the third time back on one the copies brought them back in different orders and
//    five cows took one another's ids (Gordon's "worker 1 ran mob ..., which this worker doesn't have", 2026-10-29).
// Usage: node test/cluster-rejoin.js
const cp = require('child_process'), path = require('path');
const runs = [
  ['--workers', '3', '--partial', '--plan', '--extra', '8', '--seconds', '60', '--leave', '20', '--rejoin', '40'],
  ['--workers', '4', '--partial', '--plan', '--extra', '12', '--seconds', '80', '--cycle', '15'],
];
for (const args of runs) {
  console.log('cluster-workers ' + args.join(' '));
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'cluster-workers.js'), ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
}
