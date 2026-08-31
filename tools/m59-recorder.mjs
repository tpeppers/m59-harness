// Bounded per-session flight recorder.
//
// Recording is event-driven: an idle recorder owns no timer and performs no filesystem
// work. The first buffered line arms one one-shot flush, and manual flush/tail/stop cancels
// it. This matters in a hundred-actor process where a 2s interval per Session otherwise
// produces fifty empty callbacks per second even when recording is disabled immediately.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RECORD_DIR = process.env.M59_RECORD_DIR ||
  fileURLToPath(new URL('../substrate/recordings/', import.meta.url));
export const DEFAULT_RECORD_WINDOW_MS = Number(process.env.M59_RECORD_WINDOW_MS || 120_000);
export const DEFAULT_RECORD_KEEP = Number(process.env.M59_RECORD_KEEP || 15);
export const DEFAULT_RECORD_FLUSH_MS = Number(process.env.M59_RECORD_FLUSH_MS || 2_000);

function finitePositive(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0)
    throw new RangeError(`${label} must be positive`);
  return number;
}

export class Recorder {
  constructor(name, {
    directory = DEFAULT_RECORD_DIR,
    windowMs = DEFAULT_RECORD_WINDOW_MS,
    keep = DEFAULT_RECORD_KEEP,
    flushMs = DEFAULT_RECORD_FLUSH_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.name = String(name).replace(/[^A-Za-z0-9_-]/g, '_');
    this.directory = String(directory);
    this.windowMs = finitePositive(windowMs, DEFAULT_RECORD_WINDOW_MS, 'windowMs');
    this.keep = Math.max(1, Math.floor(finitePositive(keep, DEFAULT_RECORD_KEEP, 'keep')));
    this.flushMs = finitePositive(flushMs, DEFAULT_RECORD_FLUSH_MS, 'flushMs');
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.enabled = true;
    this.stopped = false;
    this.directoryReady = false;
    this.buf = [];
    this.window = null;
    this.file = null;
    this.written = 0;
    this.dropped = 0;
    this.timer = null;
  }

  line(kind, data) {
    if (!this.enabled || this.stopped) return;
    if (this.buf.length > 5000) { this.dropped++; return; }
    this.buf.push(JSON.stringify({ at: this.now(), kind, ...data }));
    this._armFlush();
  }

  _armFlush() {
    if (this.timer !== null || !this.enabled || this.stopped) return;
    const handle = this.setTimer(() => {
      if (this.timer !== handle) return;
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer = handle;
    handle?.unref?.();
  }

  _cancelFlush() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  _ensureDirectory() {
    if (this.directoryReady) return true;
    try {
      mkdirSync(this.directory, { recursive: true });
      this.directoryReady = true;
      return true;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  currentFile() {
    const window = Math.floor(this.now() / this.windowMs);
    if (window !== this.window) {
      this.window = window;
      this.file = join(this.directory, `${this.name}-${window}.jsonl`);
      this.prune();
    }
    return this.file;
  }

  prune() {
    if (!this._ensureDirectory()) return;
    try {
      const mine = readdirSync(this.directory)
        .filter(file => file.startsWith(this.name + '-') && file.endsWith('.jsonl'))
        .sort();
      for (const file of mine.slice(0, Math.max(0, mine.length - this.keep)))
        try { unlinkSync(join(this.directory, file)); } catch { /* raced with another prune */ }
    } catch { /* directory vanished; the next write recreates it */ }
  }

  flush() {
    this._cancelFlush();
    if (!this.enabled || !this.buf.length || !this._ensureDirectory()) return;
    const lines = this.buf.splice(0, this.buf.length).join('\n') + '\n';
    try {
      appendFileSync(this.currentFile(), lines);
      this.written += lines.length;
    } catch {
      this.enabled = false;
    }
  }

  stop() {
    if (this.stopped) return;
    this.flush();
    this.stopped = true;
    this._cancelFlush();
  }

  tail(limit = 200, kinds = null) {
    this.flush();
    const want = kinds?.length ? new Set(kinds) : null;
    const out = [];
    try {
      const mine = readdirSync(this.directory)
        .filter(file => file.startsWith(this.name + '-') && file.endsWith('.jsonl')).sort();
      for (const file of mine.slice(-4)) {
        for (const line of readFileSync(join(this.directory, file), 'utf8').split('\n')) {
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (!want || want.has(event.kind)) out.push(event);
          } catch { /* torn line */ }
        }
      }
    } catch { /* nothing recorded yet */ }
    return out.slice(-limit);
  }
}
