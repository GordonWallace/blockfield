// @ci integration suite=world timeout=900
// Clusters on several workers with things restored from a save (js/mobs.js thingBase): test/cluster-workers.js --restored with planned
// owners, so the first meeting gives every group to the first worker and the other runs no pass that interval. Items lying on the
// ground before the cluster tick starts must still be sent and replaced by their cluster at the meeting; until that fix each worker
// kept its own copy of them, and a run from a saved world came out different at every worker count.
// Usage: node test/cluster-restored.js [more test/cluster-workers.js arguments]
const { spawnSync } = require('child_process'), path = require('path');
const r = spawnSync(process.execPath, [path.join(__dirname, 'cluster-workers.js'), '--workers', '2', '--seconds', '10', '--partial', '--order', 'cluster', '--plan', '--restored',
  ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
