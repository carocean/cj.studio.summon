import { ContractError } from './canonical.js';
// Trusted local host only. No serialization, remote authentication or plugin sandbox.
export class HostIdentity {
  #handles = new WeakMap(); #epochs = new Map();
  authenticate(principalId) {
    if (typeof principalId !== 'string' || !/^[A-Za-z][A-Za-z0-9.-]{0,99}$/.test(principalId)) throw new ContractError('invalid_principal');
    const handle = Object.freeze({});
    this.#handles.set(handle, { principalId, epoch: this.#epochs.get(principalId) ?? 0 });
    return handle;
  }
  resolve(handle) {
    const identity = this.#handles.get(handle);
    if (!identity || identity.epoch !== (this.#epochs.get(identity.principalId) ?? 0)) throw new ContractError('unauthenticated');
    return identity.principalId;
  }
  revoke(principalId) { this.#epochs.set(principalId, (this.#epochs.get(principalId) ?? 0) + 1); }
}
