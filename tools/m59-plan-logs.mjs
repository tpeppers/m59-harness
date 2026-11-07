// Bounded, per-viewer tail of the watched keeper's existing log. Never sends game chat.
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// At most nine percent-encoded bytes per UTF-16 unit, below the client's 16 KiB field cap.
const READ_BYTES = 32768, MAX_LAG = 131072, MAX_LINE = 1800, MAX_ROWS = 64;
const wholeUnicode = s => s.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '');
export function createKeeperLogTail() {
  let file = null, identity = null, offset = 0, pending = '', decoder = new StringDecoder('utf8');
  let enabled = false, initial = true, sequence = 0;
  const reset = () => { pending = ''; decoder = new StringDecoder('utf8'); };
  const row = text => ({ seq: sequence = Math.max(sequence + 1, Date.now() * 1000), text });
  function read(path, { fromEnd = false } = {}) {
    if (!enabled || !path) return [];
    let fd;
    try {
      fd = openSync(path, 'r');
      const s = fstatSync(fd), id = `${s.dev}:${s.ino}:${s.birthtimeMs}`;
      if (file !== path || identity !== id || s.size < offset) {
        const first = initial;
        file = path; identity = id; offset = first || fromEnd ? s.size : 0; initial = false; reset();
      }
      const rows = [];
      if (s.size - offset > MAX_LAG) {
        offset = s.size - READ_BYTES; reset();
        rows.push(row('[log stream skipped older output to keep up]'));
      }
      const bytes = Math.min(READ_BYTES, s.size - offset);
      if (bytes <= 0) return rows;
      const b = Buffer.alloc(bytes), n = readSync(fd, b, 0, bytes, offset); offset += n;
      const text = pending + decoder.write(b.subarray(0, n));
      const parts = text.split('\n'); pending = wholeUnicode(parts.pop().slice(-MAX_LINE));
      for (const part of parts) {
        const clean = part.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trimEnd();
        if (clean) rows.push(row(wholeUnicode(clean.slice(0, MAX_LINE))));
      }
      return rows.slice(-MAX_ROWS);
    } catch { return []; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return {
    setEnabled(value, path) {
      if (enabled === value) return;
      enabled = value; file = null; identity = null; offset = 0; initial = true; reset();
      if (enabled && path) { read(path, { fromEnd: true }); initial = false; }
    },
    get enabled() { return enabled; },
    read,
  };
}
