// WHO SET THIS POLICY KEY — one answer per key.
//
//   import { PolicySourceBook, sourceForPush, sameValue } from './m59-policy-sources.mjs';
//
// "Why is t1 hunting spiders" had five possible answers and no way to tell them apart: the
// roster, a live `autopilot` push, the loadout file's policy block, a bot holding the faculty,
// and now a farming strategy file. Every one of them writes the same `autopilot.policy` object,
// and the object remembers values, not writers. So each writer marks what it CHANGED here, and
// `autopilot status` reports the book as `policy_sources`.
//
// The sources, as they appear in status:
//   default            the Autopilot default policy object; nothing has written it
//   roster             the roster entry this keeper booted with
//   carry              a live push the previous keeper process carried across its restart
//   policy             a live push (the broker `autopilot` tool); `by` names the writer
//   bot:<owner>        a live push that landed while <owner> held the key's faculty
//   loadout            substrate/loadouts/<character>.json's policy block
//   strategy:<name>    a farming strategy file (m59-strategy-engine.mjs); `hook` if a hook set it
//
// ONLY CHANGED KEYS ARE MARKED. The broker pushes the WHOLE policy on every `autopilot` call, so
// marking every key it sent would credit the latest caller with fifty keys it never touched.
// `markChanged` compares values, and an unchanged key keeps the writer that last changed it.

/** Value equality for policy values (JSON-shaped: strings, numbers, lists, plain objects). */
export function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

export class PolicySourceBook {
  constructor() { this.entries = new Map(); }

  /** Credit these keys to one source. `detail` rides along (by, hook, faculty, holder). */
  mark(keys, source, detail = {}, at = Date.now()) {
    for (const k of [].concat(keys ?? [])) if (k) this.entries.set(k, { source, at, ...detail });
  }

  /**
   * Credit the keys whose value differs between `before` and `after`. `source` may be a function
   * of the key, for a writer that is several sources at once (a rejoin re-imposes roster and
   * carried values together). Returns the keys marked.
   */
  markChanged(before = {}, after = {}, source, detail = {}, at = Date.now()) {
    const changed = [];
    for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      if (sameValue(before?.[k], after?.[k])) continue;
      const src = typeof source === 'function' ? source(k) : source;
      const d = typeof detail === 'function' ? detail(k) : detail;
      this.entries.set(k, { source: src, at, ...d });
      changed.push(k);
    }
    return changed;
  }

  sourceOf(key) { return this.entries.get(key) ?? { source: 'default', at: null }; }

  /** For status: every key some writer has changed, plus `default` for the rest left implicit. */
  snapshot() {
    const out = {};
    for (const [k, e] of [...this.entries.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) out[k] = { ...e };
    return out;
  }
}

/**
 * The source to credit a live push with. A push that changes a key while some bot or lease holds
 * that key's faculty is that holder's — the broker cannot say so itself (every push is signed
 * "broker pid N"), but the keeper knows who holds what at the moment it lands.
 *
 *   facultyOf(key) -> 'work' | 'movement' | 'economy' | null
 *   ownerOf(faculty) -> 'keeper' | 'combat:<id>' | 'inert...' | '<bot name>'
 */
export function sourceForPush(key, { facultyOf = () => null, ownerOf = () => 'keeper' } = {}) {
  const f = facultyOf(key);
  if (!f) return 'policy';
  const owner = ownerOf(f);
  if (!owner || owner === 'keeper' || String(owner).startsWith('combat:') || String(owner).startsWith('inert'))
    return 'policy';
  return `bot:${owner}`;
}
