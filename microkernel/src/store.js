import { DatabaseSync } from 'node:sqlite';
import { dirname, basename, join, resolve } from 'node:path';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { types } from 'node:util';
import { ContractError, canonical, snapshot } from './canonical.js';
const validId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9.-]{0,99}$/.test(value);
const ensureId = id => { if (!validId(id)) throw new ContractError('invalid_id'); };
function invokeSync(callback, ...args) {
  if (typeof callback !== 'function' || types.isProxy(callback) || types.isAsyncFunction(callback)) throw new ContractError('async_transaction_forbidden');
  const result = callback(...args);
  if (types.isProxy(result)) throw new ContractError('invalid_c1_value');
  if (types.isPromise(result)) {
    // Observing a subclass/decorated Promise can invoke its constructor/species
    // accessor. Only observe an ordinary native Promise from the trusted host.
    if (Object.getPrototypeOf(result) !== Promise.prototype || Object.hasOwn(result, 'constructor')) throw new ContractError('invalid_c1_value');
    // The transaction will roll back; also observe later rejection from an
    // accidentally scheduled continuation using its now-expired tx handle.
    Promise.prototype.then.call(result, () => {}, () => {});
    throw new ContractError('async_transaction_forbidden');
  }
  // Do not read result.then: an invalid data object can expose an accessor.
  // C1 validation uses Node native Proxy detection before inspecting properties.
  if (result !== undefined) canonical(result);
  return result;
}

// Internal persistence primitive. It does NOT provide grants, authority or egress.
// Only the trusted host may invoke transaction callbacks.
export class SnapshotStore {
  #db; #lock; #inTransaction = false; #closed = false;
  constructor(path) {
    const requested = resolve(path); mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
    const file = join(realpathSync(dirname(requested)), basename(requested));
    for (const candidate of [file, file + '.lock.sqlite']) if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ContractError('store_alias_forbidden');
    try {
      this.#lock = new DatabaseSync(file + '.lock.sqlite', { allowExtension: false });
      this.#lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
    } catch {
      this.#lock?.close(); throw new ContractError('store_locked');
    }
    try {
      this.#db = new DatabaseSync(file, { allowExtension: false, enableForeignKeyConstraints: true });
      this.#db.enableDefensive(true);
      this.#db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;');
      for (const [name, expected] of Object.entries({journal_mode:'delete', synchronous:3, foreign_keys:1, trusted_schema:0})) {
        const result = this.#db.prepare(`PRAGMA ${name}`).get();
        if (Object.values(result)[0] !== expected) throw new ContractError('store_configuration_failed');
      }
      this.#db.exec(`CREATE TABLE IF NOT EXISTS resources (id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), kind TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS commands (principal TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, ack TEXT NOT NULL, PRIMARY KEY(principal,id));
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, body TEXT NOT NULL);`);
    } catch (error) { this.close(); throw error; }
  }
  close() {
    if (this.#closed) return;
    if (this.#inTransaction) throw new ContractError('transaction_active');
    this.#closed = true; this.#db?.close(); this.#lock?.close();
  }
  #available() { if (this.#closed) throw new ContractError('store_closed'); }
  #read(id, revision) {
    ensureId(id);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new ContractError('invalid_revision');
    const row = revision === undefined
      ? this.#db.prepare('SELECT * FROM resources WHERE id=? ORDER BY revision DESC LIMIT 1').get(id)
      : this.#db.prepare('SELECT * FROM resources WHERE id=? AND revision=?').get(id, revision);
    if (!row) return null;
    const sealed = snapshot(row.kind, JSON.parse(row.body));
    if (sealed.bytes !== row.body || sealed.digest !== row.digest) throw new ContractError('corrupt_snapshot');
    return Object.freeze({ id: row.id, revision: row.revision, ...sealed });
  }
  get(id, revision) { this.#available(); return this.#read(id, revision); }
  transaction(callback) {
    this.#available();
    if (typeof callback !== 'function' || types.isProxy(callback) || types.isAsyncFunction(callback)) throw new ContractError('async_transaction_forbidden');
    if (this.#inTransaction) throw new ContractError('nested_transaction');
    this.#inTransaction = true; let active = true;
    const check = () => { if (!active) throw new ContractError('transaction_ended'); };
    const tx = Object.freeze({
      get: (id, revision) => { check(); return this.#read(id, revision); },
      put: (id, kind, value, expectedRevision) => {
        check(); ensureId(id);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ContractError('invalid_revision');
        const prior = this.#read(id), current = prior?.revision ?? 0;
        if (current !== expectedRevision) throw new ContractError('revision_conflict');
        if (current === Number.MAX_SAFE_INTEGER) throw new ContractError('revision_exhausted');
        if (prior && prior.kind !== kind) throw new ContractError('resource_kind_immutable');
        const sealed = snapshot(kind, value), revision = current + 1;
        this.#db.prepare('INSERT INTO resources VALUES(?,?,?,?,?)').run(id, revision, kind, sealed.bytes, sealed.digest);
        return Object.freeze({ id, revision, ...sealed });
      },
      event: (kind, value) => {
        check(); const sealed = snapshot(kind, value);
        this.#db.prepare('INSERT INTO events(kind,body) VALUES(?,?)').run(kind, sealed.bytes);
      },
    });
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = invokeSync(callback, tx);
      this.#db.exec('COMMIT'); return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error;
    } finally { active = false; this.#inTransaction = false; }
  }
  command(principal, commandId, input, apply) {
    ensureId(principal); ensureId(commandId);
    const request = snapshot('command', input), inputDigest = request.digest;
    return this.transaction(tx => {
      const prior = this.#db.prepare('SELECT digest,ack FROM commands WHERE principal=? AND id=?').get(principal, commandId);
      if (prior) {
        if (prior.digest !== inputDigest) throw new ContractError('command_conflict');
        return { replayed: true, ack: snapshot('ack', JSON.parse(prior.ack)).value };
      }
      const ack = invokeSync(apply, tx, request.value);
      const body = canonical(ack);
      this.#db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(principal, commandId, inputDigest, body);
      return { replayed: false, ack: snapshot('ack', ack).value };
    });
  }
}
