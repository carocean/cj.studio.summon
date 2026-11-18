import { SnapshotStore } from '../src/store.js';
const [path, phase] = process.argv.slice(2);
const store = new SnapshotStore(path);
store.command('owner', 'create-one', {resource:'sample'}, tx => {
  tx.put('sample', 'context', {text:'committed only as one unit'}, 0);
  if (phase === 'before-commit') process.kill(process.pid, 'SIGKILL');
  return {resource:'sample',revision:1};
});
if (phase === 'after-commit') process.kill(process.pid, 'SIGKILL');
store.close();
