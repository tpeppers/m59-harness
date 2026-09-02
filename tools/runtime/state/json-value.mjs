// Small, dependency-free helpers for state that crosses an isolate/process boundary.
// Only JSON-shaped own data properties are accepted. In particular, accessors are never
// invoked: runtime callers must capture primitive model data before entering this layer.

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertKey(key) {
  if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`unsafe state key: ${key}`);
}

function copy(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('state numbers must be finite');
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError(`state values must be JSON-shaped, got ${typeof value}`);
  if (seen.has(value)) throw new TypeError('state values must not contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => copy(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('state objects must be plain records');
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('state keys must be strings');
      assertKey(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!Object.hasOwn(descriptor, 'value'))
        throw new TypeError(`state accessor is not allowed: ${key}`);
      Object.defineProperty(out, key, {
        value: copy(descriptor.value, seen), enumerable: true,
        writable: true, configurable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function cloneStateValue(value) {
  return copy(value, new Set());
}

export function deepFreezeState(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeState(child);
  return Object.freeze(value);
}

export function immutableStateValue(value) {
  return deepFreezeState(cloneStateValue(value));
}

export function sameStateValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameStateValue(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key) && sameStateValue(left[key], right[key]));
}

function walkDiff(before, after, path, operations) {
  if (sameStateValue(before, after)) return;
  const records = before && after && typeof before === 'object' && typeof after === 'object' &&
    !Array.isArray(before) && !Array.isArray(after);
  if (!records) {
    operations.push({ op: 'set', path, value: cloneStateValue(after) });
    return;
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    assertKey(key);
    const childPath = [...path, key];
    if (!Object.hasOwn(after, key)) operations.push({ op: 'remove', path: childPath });
    else if (!Object.hasOwn(before, key))
      operations.push({ op: 'set', path: childPath, value: cloneStateValue(after[key]) });
    else walkDiff(before[key], after[key], childPath, operations);
  }
}

export function diffStateValues(before, after) {
  const operations = [];
  walkDiff(before, after, [], operations);
  return deepFreezeState(operations);
}

function validPath(path) {
  if (!Array.isArray(path) || path.length < 1 || path.some(key => typeof key !== 'string'))
    throw new TypeError('state operation path must be a non-empty string array');
  path.forEach(assertKey);
  return path;
}

export function applyStateOperations(base, operations) {
  const out = cloneStateValue(base);
  if (!Array.isArray(operations)) throw new TypeError('state operations must be an array');
  for (const operation of operations) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const path = validPath(op.path);
    let parent = out;
    for (const key of path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || Array.isArray(parent) ||
          !Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== 'object' ||
          Array.isArray(parent[key]))
        throw new TypeError(`state operation has no record parent at ${path.join('.')}`);
      parent = parent[key];
    }
    const key = path.at(-1);
    if (op.op === 'remove') {
      if (!Object.hasOwn(parent, key))
        throw new TypeError(`state remove target does not exist: ${path.join('.')}`);
      delete parent[key];
    } else if (op.op === 'set') {
      Object.defineProperty(parent, key, {
        value: cloneStateValue(op.value), enumerable: true,
        writable: true, configurable: true,
      });
    } else {
      throw new TypeError(`unknown state operation: ${op.op}`);
    }
  }
  return deepFreezeState(out);
}
