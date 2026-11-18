import { createHash } from 'node:crypto';
import { types } from 'node:util';
export class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = () => { throw new ContractError('invalid_c1_value'); };
const validScalarString = value => {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};
export function canonical(value) {
  const parts = [], ancestors = new Set(); let bytes = 0;
  function push(text) {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 65536) throw new ContractError('c1_record_limit');
    parts.push(text);
  }
  function visit(item, depth) {
    if (depth > 32) throw new ContractError('c1_depth_limit');
    if (item === null || typeof item === 'boolean') return push(String(item));
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail();
      return push(String(item));
    }
    if (typeof item === 'string') {
      if (!validScalarString(item) || Buffer.byteLength(item, 'utf8') > 16384) fail();
      return push(JSON.stringify(item));
    }
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fail();
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== 'string')) fail();
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || item.length > 256 || keys.length !== item.length + 1) fail();
        push('[');
        for (let i = 0; i < item.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
          if (i) push(','); visit(descriptor.value, depth + 1);
        }
        return push(']');
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || keys.length > 256) fail();
      keys.sort(); push('{');
      keys.forEach((key, index) => {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype'].includes(key)) fail();
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        if (index) push(','); push(JSON.stringify(key)); push(':'); visit(descriptor.value, depth + 1);
      });
      push('}');
    } finally { ancestors.delete(item); }
  }
  visit(value, 0); return parts.join('');
}
function digestCanonical(kind, bytes) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(kind)) throw new ContractError('invalid_record_kind');
  return 'sha256:' + createHash('sha256').update(`cj.summon.c1\0${kind}\0`, 'utf8').update(bytes, 'utf8').digest('hex');
}
export function digest(kind, value) { return digestCanonical(kind, canonical(value)); }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function snapshot(kind, value) {
  const bytes = canonical(value);
  return Object.freeze({ kind, bytes, digest: digestCanonical(kind, bytes), value: freeze(JSON.parse(bytes)) });
}
