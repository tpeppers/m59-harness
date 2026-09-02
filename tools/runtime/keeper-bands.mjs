// Collision-free keeper port-band registry.
//
// The on-disk format intentionally remains the legacy, human-readable
// `{ "fleet-name": numericBase }` object.  A band is always 100 ports wide, so a
// base names exactly actor offsets 0..99 and its inclusive end is base + 99.
// Read-only consumers never create the registry.  The allocating path takes a
// short-lived, tokenized filesystem claim and replaces the registry atomically.

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimFleetLock, FLEET_LOCK_KIND } from './fleet-lock.mjs';

export const KEEPER_BAND_WIDTH = 100;
export const UNNAMED_KEEPER_BAND_BASE = 8911;
export const FIRST_NAMED_KEEPER_BAND_BASE =
  UNNAMED_KEEPER_BAND_BASE + KEEPER_BAND_WIDTH;
export const DEFAULT_KEEPER_BAND_REGISTRY = fileURLToPath(
  new URL('../../substrate/keeper-bands.json', import.meta.url),
);

const MAX_PORT = 65535;
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_FLEET_NAME_BYTES = 128;
const LOCK_SUFFIX = '.lock';
const LOCK_SUBJECT = 'keeper-band-registry';
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

export class KeeperBandRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KeeperBandRegistryError';
    this.code = code;
    Object.assign(this, details);
  }
}

function registryError(code, message, details = {}) {
  return new KeeperBandRegistryError(code, message, details);
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function registryPath(value) {
  if (value == null) return DEFAULT_KEEPER_BAND_REGISTRY;
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError('registryPath must be a non-empty path');
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function fleetName(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim() || !value ||
      Buffer.byteLength(value, 'utf8') > MAX_FLEET_NAME_BYTES ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(
      `fleet must be empty for the unnamed fleet or a trimmed 1-${MAX_FLEET_NAME_BYTES} byte name`,
    );
  }
  return value;
}

function band(base) {
  return Object.freeze({
    base,
    end: base + KEEPER_BAND_WIDTH - 1,
    width: KEEPER_BAND_WIDTH,
  });
}

function validBase(value) {
  return Number.isSafeInteger(value) && value >= 1 &&
    value + KEEPER_BAND_WIDTH - 1 <= MAX_PORT;
}

// JSON.parse intentionally keeps only the last duplicate object property.  That is unsafe
// for an ownership registry: two textual assignments for one fleet are ambiguous even when
// their final parsed value looks valid.  The JSON has already passed the native parser when
// this runs, so this small scanner only has to identify decoded keys of the top-level object.
function rejectDuplicateFleetKeys(raw, path) {
  const keys = new Set();
  const stack = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let expectingTopLevelKey = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        if (expectingTopLevelKey && stack.length === 1 && stack[0] === '{') {
          const key = JSON.parse(raw.slice(stringStart, index + 1));
          if (keys.has(key))
            throw registryError('REGISTRY_DUPLICATE_FLEET',
              `keeper band registry assigns ${JSON.stringify(key)} more than once`,
              { path, fleet: key });
          keys.add(key);
          expectingTopLevelKey = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      stringStart = index;
    } else if (character === '{' || character === '[') {
      stack.push(character);
      if (stack.length === 1 && character === '{') expectingTopLevelKey = true;
    } else if (character === '}' || character === ']') {
      stack.pop();
    } else if (character === ',' && stack.length === 1 && stack[0] === '{') {
      expectingTopLevelKey = true;
    }
  }
}

function readRegistryFile(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (missing(error)) return { entries: new Map(), exists: false };
    throw registryError('REGISTRY_METADATA_UNREADABLE',
      `keeper band registry metadata cannot be read: ${error.message}`, { path });
  }
  if (stat.isSymbolicLink())
    throw registryError('REGISTRY_NOT_REGULAR',
      'keeper band registry is a symbolic link and will not be followed', { path });
  if (!stat.isFile())
    throw registryError('REGISTRY_NOT_REGULAR',
      'keeper band registry is not a regular file', { path });
  if (stat.size > MAX_REGISTRY_BYTES)
    throw registryError('REGISTRY_TOO_LARGE',
      `keeper band registry exceeds ${MAX_REGISTRY_BYTES} bytes`, { path });

  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    throw registryError('REGISTRY_UNREADABLE',
      `keeper band registry cannot be read: ${error.message}`, { path });
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    throw registryError('REGISTRY_MALFORMED',
      'keeper band registry is not valid JSON', { path });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw registryError('REGISTRY_MALFORMED',
      'keeper band registry must be a JSON object of fleet names to numeric bases', { path });
  rejectDuplicateFleetKeys(raw, path);

  const entries = new Map();
  for (const [name, base] of Object.entries(parsed)) {
    try {
      if (name === '') throw new TypeError('the unnamed fleet is not stored in the registry');
      fleetName(name);
    }
    catch {
      throw registryError('REGISTRY_INVALID_FLEET',
        `keeper band registry contains an invalid fleet name ${JSON.stringify(name)}`, { path });
    }
    if (!validBase(base))
      throw registryError('REGISTRY_INVALID_BASE',
        `keeper band for ${JSON.stringify(name)} must be an integer base whose 100-port band is within 1-${MAX_PORT}`,
        { path, fleet: name });
    entries.set(name, base);
  }

  // The unnamed fleet owns its historical band even though it has no registry entry.
  // Including it in validation prevents a named fleet from being assigned a range that
  // can quietly address unnamed-fleet keepers.
  const ranges = [
    { name: '<unnamed>', ...band(UNNAMED_KEEPER_BAND_BASE) },
    ...[...entries].map(([name, base]) => ({ name, ...band(base) })),
  ].sort((left, right) => left.base - right.base ||
    (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.base <= previous.end) {
      throw registryError('REGISTRY_BANDS_OVERLAP',
        `keeper bands for ${JSON.stringify(previous.name)} (${previous.base}-${previous.end}) and ` +
        `${JSON.stringify(current.name)} (${current.base}-${current.end}) overlap`,
        { path, fleets: Object.freeze([previous.name, current.name]) });
    }
  }
  return { entries, exists: true, raw };
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(SLEEP_WORD, 0, 0, milliseconds);
}

function acquireRegistryClaim(path, { lockTimeoutMs, retryDelayMs }) {
  const lockPath = `${path}${LOCK_SUFFIX}`;
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    const claim = claimFleetLock(lockPath, {
      kind: FLEET_LOCK_KIND,
      subject: LOCK_SUBJECT,
    });
    if (claim.ok) return claim;
    if (claim.found?.unverifiable) {
      throw registryError('REGISTRY_LOCK_UNVERIFIABLE',
        `keeper band registry lock cannot be verified: ${claim.found.why ?? 'unknown lock state'}`,
        { path, lockPath });
    }
    if (claim.found?.mine) {
      throw registryError('REGISTRY_LOCK_REENTRANT',
        'keeper band registry is already locked by this process', { path, lockPath });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw registryError('REGISTRY_LOCK_TIMEOUT',
        `timed out waiting ${lockTimeoutMs}ms for keeper band registry lock`,
        { path, lockPath });
    }
    sleepSync(Math.min(retryDelayMs, remaining));
  }
}

function encodedRegistry(entries, path) {
  const sorted = [...entries].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  const object = Object.fromEntries(sorted);
  const output = `${JSON.stringify(object, null, 1)}\n`;
  if (Buffer.byteLength(output, 'utf8') > MAX_REGISTRY_BYTES)
    throw registryError('REGISTRY_TOO_LARGE',
      `updated keeper band registry exceeds ${MAX_REGISTRY_BYTES} bytes`, { path });
  return output;
}

function atomicReplaceRegistry(path, entries) {
  const output = Buffer.from(encodedRegistry(entries, path), 'utf8');
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    let written = 0;
    while (written < output.length)
      written += writeSync(descriptor, output, written, output.length - written, written);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    // Same-directory rename is the commit point.  Never unlink the authoritative path:
    // failure leaves the complete old registry in place and the temporary file is removed.
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    if (error instanceof KeeperBandRegistryError) throw error;
    throw registryError('REGISTRY_REPLACE_FAILED',
      `keeper band registry could not be atomically replaced: ${error.message}`,
      { path, errorCode: error?.code ?? null });
  }
}

function allocationOptions(options) {
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('options must be an object');
  const path = registryPath(options.registryPath);
  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 10;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 60000)
    throw new RangeError('lockTimeoutMs must be an integer between 0 and 60000');
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 1000)
    throw new RangeError('retryDelayMs must be an integer between 1 and 1000');
  return { path, lockTimeoutMs, retryDelayMs };
}

/**
 * Read and validate the complete registry, then return this fleet's immutable
 * `{base,end,width}`.  A missing named fleet returns null.  This function never writes.
 */
export function lookupKeeperBand(fleet, options = {}) {
  const name = fleetName(fleet);
  const { path } = allocationOptions(options);
  const registry = readRegistryFile(path);
  if (name === null) return band(UNNAMED_KEEPER_BAND_BASE);
  const base = registry.entries.get(name);
  return base === undefined ? null : band(base);
}

/**
 * Return an existing keeper band or atomically allocate the first free canonical
 * 100-port band for a named fleet.  The unnamed fleet is returned without writing.
 */
export function allocateKeeperBand(fleet, options = {}) {
  const name = fleetName(fleet);
  const normalized = allocationOptions(options);
  if (name === null) {
    // Still validate an existing registry: corruption or an overlap with the reserved
    // unnamed range must never be hidden by this compatibility path.
    readRegistryFile(normalized.path);
    return band(UNNAMED_KEEPER_BAND_BASE);
  }

  mkdirSync(dirname(normalized.path), { recursive: true });
  const claim = acquireRegistryClaim(normalized.path, normalized);
  let result;
  let operationError = null;
  try {
    const registry = readRegistryFile(normalized.path);
    const existing = registry.entries.get(name);
    if (existing !== undefined) {
      result = band(existing);
    } else {
      let selected = null;
      for (let base = FIRST_NAMED_KEEPER_BAND_BASE;
           base + KEEPER_BAND_WIDTH - 1 <= MAX_PORT;
           base += KEEPER_BAND_WIDTH) {
        const end = base + KEEPER_BAND_WIDTH - 1;
        const overlaps = [...registry.entries.values()].some(existingBase =>
          base <= existingBase + KEEPER_BAND_WIDTH - 1 && existingBase <= end);
        if (!overlaps) {
          selected = base;
          break;
        }
      }
      if (selected === null) {
        throw registryError('NO_AVAILABLE_KEEPER_BAND',
          `no complete ${KEEPER_BAND_WIDTH}-port keeper band remains within 1-${MAX_PORT}`,
          { path: normalized.path });
      }
      registry.entries.set(name, selected);
      // Current entries were fully validated above and the selected range was checked
      // against each of them; encode and atomically commit the extended legacy map.
      atomicReplaceRegistry(normalized.path, registry.entries);
      result = band(selected);
    }
  } catch (error) {
    operationError = error;
  }

  const released = claim.release();
  if (operationError) throw operationError;
  if (!released.released) {
    throw registryError('REGISTRY_LOCK_RELEASE_FAILED',
      `keeper band registry lock could not be released: ${released.reason ?? 'unknown reason'}`,
      { path: normalized.path, lockPath: claim.path, committed: true });
  }
  return result;
}
