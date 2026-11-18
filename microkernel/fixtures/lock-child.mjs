import { SnapshotStore } from '../src/store.js';
try {
  const store = new SnapshotStore(process.argv[2]);
  store.close(); process.exitCode = 1;
} catch (error) { process.exitCode = error.code === 'store_locked' ? 0 : 2; }
