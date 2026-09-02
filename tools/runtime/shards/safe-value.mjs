import { immutableStateValue } from '../state/json-value.mjs';

export const REDACTED_IPC_VALUE = '[redacted]';

const SENSITIVE_KEY_PARTS = Object.freeze([
  'password', 'passwd', 'credential', 'secret', 'token', 'authorization',
  'cookie', 'apikey', 'accesskey', 'privatekey', 'sessionkey',
]);

function sensitiveKey(key) {
  const folded = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_PARTS.some(part => folded.includes(part));
}

function sanitizedString(value) {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(password|passwd|credential|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      (_whole, label) => `${label}=[redacted]`)
    .replace(/:\/\/([^/:@\s]+):([^/@\s]+)@/g, '://[redacted]:[redacted]@');
}

function sanitize(value, seen, depth) {
  if (depth > 48) throw new RangeError('IPC value nesting is too deep');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizedString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('IPC numbers must be finite');
    return value;
  }
  if (typeof value !== 'object')
    throw new TypeError(`IPC values must be JSON-shaped, got ${typeof value}`);
  if (seen.has(value)) throw new TypeError('IPC values must not contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => sanitize(item, seen, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('IPC objects must be plain records');
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('IPC keys must be strings');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!Object.hasOwn(descriptor, 'value'))
        throw new TypeError(`IPC accessors are not allowed: ${key}`);
      Object.defineProperty(out, key, {
        value: sensitiveKey(key)
          ? REDACTED_IPC_VALUE
          : sanitize(descriptor.value, seen, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// Every caller-controlled state/payload value passes through this projection before it
// can enter a frame or a parent snapshot. Credential-shaped keys are replaced rather
// than copied, and common labelled/URL secret forms are scrubbed from strings.
export function safeIpcValue(value) {
  return immutableStateValue(sanitize(value, new Set(), 0));
}

// Initialization references must be useful as supplied, so silently replacing one of
// their fields would be dangerous. Reject any reference which would require redaction.
export function credentialFreeIpcValue(value) {
  const original = immutableStateValue(value);
  const projected = safeIpcValue(value);
  if (JSON.stringify(original) !== JSON.stringify(projected)) {
    const error = new TypeError('IPC initialization reference contains credential-like material');
    error.code = 'M59_SHARD_INIT_NOT_PUBLIC';
    throw error;
  }
  return projected;
}

export function safeIpcString(value, { label = 'value', maximum = 512 } = {}) {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${label} must be a non-empty string`);
  const result = sanitizedString(value.trim());
  if (result.length > maximum) throw new RangeError(`${label} is too long`);
  return result;
}

// Error messages are deliberately not transported. They are an easy accidental route
// for login failures, URLs, or command text containing secrets. Stable name/code/origin
// is enough to classify a shard failure without copying arbitrary exception text.
export function safeErrorDetails(error, { origin = 'runtime' } = {}) {
  const name = typeof error?.name === 'string' && error.name.trim()
    ? safeIpcString(error.name, { label: 'error name', maximum: 80 })
    : 'Error';
  const rawCode = error?.code;
  const code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode)
    ? rawCode
    : typeof rawCode === 'string' && rawCode.trim()
      ? safeIpcString(rawCode, { label: 'error code', maximum: 80 })
      : undefined;
  return safeIpcValue({
    name,
    origin: safeIpcString(String(origin), { label: 'error origin', maximum: 80 }),
    ...(code === undefined ? {} : { code }),
  });
}

export function assertFrameBytes(value, maximum, label = 'IPC frame') {
  const body = JSON.stringify(value);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > maximum) {
    const error = new RangeError(`${label} exceeds ${maximum} bytes`);
    error.code = 'M59_SHARD_FRAME_TOO_LARGE';
    error.bytes = bytes;
    error.limit = maximum;
    throw error;
  }
  return bytes;
}
