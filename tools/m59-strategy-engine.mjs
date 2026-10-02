#!/usr/bin/env node
// FARMING STRATEGY FILES: THE ENGINE. GENERIC; THE FILES ARE NOT.
//
//   node tools/m59-strategy-engine.mjs                 what this machine has, and whether each one loads
//   node tools/m59-strategy-engine.mjs check <name>    one file: what it would set, and under which faculty
//   node tools/m59-strategy-engine.mjs --example       the committed examples, by name
//
//   autopilot action=start agent=t9 mode=farm farm_strategy=qor-acid-touch-trees
//
// The operator, 2026-10-02, in order: autopilot should execute a "farming strategy" file naming
// the weapons, the quarry and its priority, the loot, the maps; "generic" only from the keeper's
// side — the files are highly specialised; no "if using acid touch ..." in the keeper; and the
// generic touch-spell support stays central. So:
//
//   THE KEEPER (m59-autopilot.mjs) binds this engine in three places and reads nothing of a file:
//   `applyFarmStrategy` at the top of every pass and after every policy push or rejoin,
//   `farmStrategyHook` at the swing and the kill, and `farmStrategyStatus` in status.
//   THE ENGINE (this file) loads a file by name, validates it (m59-strategy-schema.mjs), lays its
//   keys over `autopilot.policy` while the keeper owns their faculty, runs its hooks isolated, and
//   reports what it did and why. It knows no spell, creature, item or room.
//   THE FILE (substrate/farm-strategies/<name>.mjs) is the task: declarations first, hooks for
//   the logic that cannot be declared.
//
// NOT `substrate/strategies/`. That directory is the TRAVEL strategy system (m59-strategies.mjs:
// blink-escape, convoy, town stops, chalice) — fleet-wide hook modules that every keeper asks on
// a stuck walk or at a counter, switched by their own `enabled`. A farming strategy is a different
// unit: ASSIGNED to one character by name, declarative, re-applied every pass, hot-reloaded. One
// loader for both would have to give the travel files an assignment they do not have, or give
// these an `enabled` that would make one file every character's orders. So it is a sibling
// directory, and this loader reads exactly one file in it — `<name>.mjs` — and never enumerates
// the travel directory; the travel loader enumerates only its own directory and never this one.
//
// THE RULES (docs/m59-strategies.md argues each):
//
//  1. TWO WRITERS IS THE FAILURE. A key is applied only while the keeper owns its faculty
//     (`facultyOwner` = 'keeper', or the keeper's own combat). While a bot or a lease holds it,
//     the engine writes NOTHING to that key and says so (`yielded_to`). When the lease ends the
//     file's value returns — one transition per lease change, never a fight per pass.
//  2. NEVER THE PROTECTED FOUR, NOR THE WAR PATHS. The schema refuses a file that names one;
//     hooks can set only the same directional keys (`ctx.set`), through the same validators.
//  3. ONE ANSWER PER KEY. Every write is credited in the policy source book; `farm_strategy.keys`
//     shows, per key, the file's value, the effective value, and the value it is shadowing.
//  4. FILES ARE ORDERS, SO THEY ARE THIS MACHINE'S, and SILENCE IS THE OLD BEHAVIOUR. A missing or
//     unparseable file is refused and reported, and the character keeps the posture it has: the
//     previous good version of the same file if there was one, otherwise whatever it had before.
//  5. THE CARRY. Only the ASSIGNMENT travels (`farmStrategy`, a policy key pushed over /policy,
//     carried across a keeper restart like any push). The file's own keys are written straight into
//     `autopilot.policy` and NEVER into the keeper's order copy, the roster or the carry: they are
//     re-derived from the file on the first pass of every process. A carried copy would be a
//     second, stale source for the same key — and would read as a live push.
//
// HOOKS are synchronous, timed and isolated. A hook that throws or rejects is DISABLED and noted,
// never rethrown; one over its time budget three times is disabled too. They run only while the
// keeper owns `work`: a bot driving the hunt does not also get a strategy's opinion every line.
// This is isolation, not a security sandbox — a strategy file is code this machine chose to run,
// like a playbook; what the engine guarantees is that a bad one cannot take the keeper down.
//
// What a hook gets (`ctx`): strategy, agent, now, room (number), vitals and policy (frozen copies),
// touch (the central touch-spell state, read-only), memory (a per-file scratch object, reset on
// reload), note(what, data), set(path, value) — a schema path such as 'huntPriority' or
// 'weapons.touchSpell', validated, faculty-gated, credited 'strategy:<name>' with hook —
// pack() (the pack by name and amount, a copy), contents() (the room: name, kind player/monster/
// object, square, distance, spared/fleetmate -- a copy; ids are temporary handles), and
// requestTouchRecast(why), which marks the
// central touch state stale so the keeper recasts at the next opportunity under its own rate limit.

import { statSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateStrategy, fieldFor, fieldForKey, mergeOver, STRATEGY_NAME, STRATEGY_HOOKS } from './m59-strategy-schema.mjs';
import { sameValue } from './m59-policy-sources.mjs';
import { classifyCombatLine } from './m59-combatlog.mjs';
import { OF } from './m59-parse.mjs';
import { isSpared } from './m59-spare.mjs';
import * as party from './m59-party.mjs';

/**
 * A hook's view of the room: every object but ourselves, as data. kind is 'player', 'monster'
 * (attackable, not a player) or 'object' (items, ghosts, furniture). Players carry `fleetmate`
 * (m59-party.mjs, the same answer the grudge book and the war response use); monsters carry
 * `spared` (policy.spareCreatures). Sorted nearest first, like findCreature.
 */
export function roomContents(c, host = {}) {
  if (!c?.room?.objects) return deepFreeze([]);
  const me = c.self;
  const spare = host.policy?.spareCreatures ?? null;
  const out = [];
  for (const o of c.room.objects.values()) {
    if (o.id === c.selfId) continue;
    const name = c.rsc?.get?.(o.nameRsc) || o.name || '';
    const player = !!(o.flags & OF.PLAYER);
    const kind = player ? 'player' : (o.flags & OF.ATTACKABLE) ? 'monster' : 'object';
    const row = Number.isFinite(o.row) ? o.row : null, col = Number.isFinite(o.col) ? o.col : null;
    const entry = { id: o.id, name, kind, row, col,
      distance: me && row != null && col != null ? Math.hypot(row - me.row, col - me.col) : null };
    if (kind === 'monster') entry.spared = !!(spare?.length && isSpared(c, o, spare));
    if (player) { try { entry.fleetmate = !!party.isFleetmate(name); } catch {} }
    out.push(entry);
  }
  out.sort((x, y) => (x.distance ?? 1e9) - (y.distance ?? 1e9));
  return deepFreeze(out);
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const FARM_STRATEGY_DIR = process.env.M59_FARM_STRATEGY_DIR
  || join(HERE, '..', 'substrate', 'farm-strategies');
// BESIDE the directory, never inside it: an example inside is an assignable order nobody gave.
export const FARM_STRATEGY_EXAMPLES = join(HERE, '..', 'substrate', 'farm-strategies.example');

export const HOOK_BUDGET_MS = Number(process.env.M59_STRATEGY_HOOK_MS || 25);
export const HOOK_STRIKES = 3;
export const MAX_LINES_PER_PUMP = 200;
const NOTE_EVERY_MS = 60_000;

const clone = v => v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) {
  Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

/** The file for a name, or a thrown reason. Never a path the name could escape through. */
export function strategyFile(name, dir = FARM_STRATEGY_DIR) {
  if (typeof name !== 'string' || !STRATEGY_NAME.test(name))
    throw new Error(`farm_strategy must be a strategy name (${STRATEGY_NAME}), not ${JSON.stringify(name)}`);
  return join(dir, `${name}.mjs`);
}

function mtimeOf(path) { try { return statSync(path).mtimeMs; } catch { return null; } }

let defaultResolveItem;
async function itemResolver() {
  if (defaultResolveItem !== undefined) return defaultResolveItem;
  try { defaultResolveItem = (await import('./m59-items.mjs')).resolveItemName; }
  catch { defaultResolveItem = null; }
  return defaultResolveItem;
}

/**
 * Load and validate one strategy file. Never throws.
 *   -> { ok, name, file, mtime, why, problems, unrecognised, strategy }
 * A changed file is re-imported under a fresh URL (`?v=<mtime>`), which is what makes a hot
 * reload real: Node's module cache would otherwise hand back the first version for ever.
 */
export async function loadFarmStrategy(name, { dir = FARM_STRATEGY_DIR, resolveItem } = {}) {
  let file;
  try { file = strategyFile(name, dir); }
  catch (e) { return { ok: false, name, file: null, mtime: null, why: e.message, problems: [], unrecognised: [] }; }
  const mtime = mtimeOf(file);
  if (mtime == null)
    return { ok: false, name, file, mtime: null, problems: [], unrecognised: [],
             why: `no such farming strategy: ${file} does not exist. Strategies are this machine's ` +
                  `(gitignored); start from substrate/farm-strategies.example/` };
  let mod;
  try { mod = await import(`${pathToFileURL(resolve(file)).href}?v=${mtime}`); }
  catch (e) {
    return { ok: false, name, file, mtime, problems: [], unrecognised: [],
             why: `did not load: ${e.message}` };
  }
  const r = validateStrategy(mod?.default, { file, resolveItem: resolveItem === undefined ? await itemResolver() : resolveItem });
  const extraExports = Object.keys(mod ?? {}).filter(k => k !== 'default');
  return { ok: r.ok, name, file, mtime, why: r.why, problems: r.problems,
           unrecognised: [...r.unrecognised, ...extraExports.map(k => `export ${k}`)], strategy: r.strategy };
}

/** Every strategy this machine has (CLI). Leading-underscore files are helpers, as in the travel dir. */
export async function listFarmStrategies({ dir = FARM_STRATEGY_DIR, resolveItem } = {}) {
  if (!existsSync(dir)) return { dir, present: false, strategies: [] };
  const names = readdirSync(dir).filter(n => n.endsWith('.mjs') && !n.startsWith('_')).map(n => n.slice(0, -4)).sort();
  const strategies = [];
  for (const n of names) strategies.push(await loadFarmStrategy(n, { dir, resolveItem }));
  return { dir, present: true, strategies };
}

/**
 * The adapter between the engine and whatever it is laid over. An Autopilot satisfies it as is;
 * the tests hand in a plain object with the same members.
 *   policy, facultyOwner(f), note(what, data), policySources (PolicySourceBook),
 *   s.client (eventsSince, evSeq, vitals), s.world.room.num, s.name, touchState()
 */
export class FarmStrategyEngine {
  constructor(host, { dir = FARM_STRATEGY_DIR, resolveItem, budgetMs = HOOK_BUDGET_MS, now = () => Date.now() } = {}) {
    this.host = host;
    this.dir = dir;
    this.resolveItem = resolveItem;
    this.budgetMs = budgetMs;
    this.now = now;
    this.assigned = null;     // the name in policy.farmStrategy we are serving
    this.loaded = null;       // the last GOOD load of that name
    this.refused = null;      // the last failed load, while it is the newest attempt
    this.triedMtime = undefined;
    this.wrote = new Map();   // policy key -> the value we last wrote (ours while it still reads so)
    this.base = new Map();    // policy key -> { value, source } that the file is shadowing
    this.yielded = {};
    this.overrides = {};      // hook-set keys, laid over the file's declarations
    this.memory = {};
    this.hooks = {};          // hook -> { calls, strikes, disabled, last_ms }
    this.reloads = 0;
    this.reasserts = 0;
    this.cursor = null; this.client = null;
    this.lastNoteAt = new Map();
    this.appliedAt = null;
  }

  name() { return this.loaded?.strategy?.name ?? null; }

  noteOnce(key, what, data, { every = NOTE_EVERY_MS } = {}) {
    const t = this.now();
    if (every && t - (this.lastNoteAt.get(key) ?? -Infinity) < every) return;
    this.lastNoteAt.set(key, t);
    try { this.host.note?.(what, data); } catch {}
  }

  /** Who holds a faculty, or null while the keeper does (its own combat is the keeper). */
  heldBy(faculty) {
    let owner = 'keeper';
    try { owner = this.host.facultyOwner?.(faculty) ?? 'keeper'; } catch {}
    if (owner === 'keeper' || String(owner).startsWith('combat:')) return null;
    return owner;
  }

  /**
   * Bring the policy into line with the assignment and the file. Called at the top of every pass
   * and after every push or rejoin. Cheap when nothing changed: one stat, no import, no await.
   */
  async converge(reason = 'pass') {
    const policy = this.host.policy;
    const want = typeof policy?.farmStrategy === 'string' && policy.farmStrategy.trim()
      ? policy.farmStrategy.trim() : null;
    if (want !== this.assigned) {
      if (this.assigned) this.release(want ? `reassigned to ${want}` : 'unassigned');
      this.assigned = want;
      this.loaded = null; this.refused = null; this.triedMtime = undefined;
    }
    if (!want) return this.status();

    let file = null;
    try { file = strategyFile(want, this.dir); } catch (e) {
      this.refused = { why: e.message, problems: [], at: this.now(), mtime: null };
      this.noteOnce('refused', 'farm strategy refused', { strategy: want, why: e.message,
        keeping: this.loaded ? 'the previous version' : 'the existing posture' });
      return this.status();
    }
    const mtime = mtimeOf(file);
    const stale = !this.loaded || mtime !== this.loaded.mtime;
    if (stale && mtime !== this.triedMtime) {
      this.triedMtime = mtime;
      const r = await loadFarmStrategy(want, { dir: this.dir, resolveItem: this.resolveItem });
      if (this.assigned !== want) return this.status();   // reassigned while we awaited
      if (r.ok) {
        const reload = !!this.loaded;
        this.loaded = r; this.refused = null;
        this.overrides = {}; this.memory = {}; this.hooks = {};
        if (reload) this.reloads++;
        this.noteOnce(`loaded:${r.mtime}`, reload ? 'farm strategy reloaded' : 'farm strategy loaded', {
          strategy: want, file: r.file, keys: Object.keys(r.strategy.desired),
          hooks: Object.keys(r.strategy.hooks), unrecognised: r.unrecognised.length ? r.unrecognised : undefined,
          why: reload ? 'the file changed on disk; no keeper restart' : reason }, { every: 0 });
      } else {
        this.refused = { why: r.why, problems: r.problems, at: this.now(), mtime: r.mtime };
        this.noteOnce(`refused:${r.mtime}`, 'farm strategy refused', { strategy: want, why: r.why,
          keeping: this.loaded ? `the previous version (loaded ${new Date(this.loaded.mtime).toISOString()})`
                               : 'the existing posture — nothing from the file is applied' }, { every: 0 });
      }
    }
    if (!this.loaded?.ok) return this.status();
    this.apply(reason);
    if (reason === 'pass') { this.pumpLines(); this.dispatch('onPass', { reason }); }
    return this.status();
  }

  /** Lay the file (and hook overrides) over the policy, faculty by faculty. Synchronous. */
  apply(reason = 'pass') {
    const policy = this.host.policy, book = this.host.policySources;
    const strat = this.loaded.strategy;
    const desired = { ...strat.desired, ...this.overrides };
    const tag = `strategy:${strat.name}`;
    const yielded = {}, changed = [], reasserted = [];
    // A key the file no longer declares (edited out) goes back to what it was shadowing.
    for (const k of [...this.wrote.keys()]) if (!Object.hasOwn(desired, k)) this.releaseKey(k);
    for (const [key, declared] of Object.entries(desired)) {
      const faculty = strat.faculties[key] ?? fieldForKey(key)?.faculty ?? 'work';
      const cur = policy[key];
      const mine = this.wrote.has(key) && sameValue(cur, this.wrote.get(key));
      if (!mine) {
        // Somebody else's value — the roster, a push, a bot, the loadout — or our first sight.
        // It is what the file is now shadowing, and what an unassignment gives back.
        if (this.wrote.has(key)) reasserted.push(key);
        this.base.set(key, { value: clone(cur), source: book?.sourceOf?.(key)?.source ?? 'default' });
        this.wrote.delete(key);
      }
      // A replacing key is the file's value; an additive one (protect) is the file's items laid
      // over whatever the other writer had, so a strategy never unprotects the roster's reagents.
      const value = mergeOver(fieldForKey(key), this.base.get(key)?.value, declared);
      const holder = this.heldBy(faculty);
      if (holder) { yielded[key] = { faculty, holder }; continue; }
      const writes = !sameValue(cur, value);
      if (writes) { policy[key] = clone(value); if (!reasserted.includes(key)) changed.push(key); }
      if (!mine || writes) book?.mark?.(key, tag, Object.hasOwn(this.overrides, key) ? { hook: true, faculty } : { faculty });
      this.wrote.set(key, clone(value));
    }
    const newlyYielded = Object.keys(yielded).filter(k => !this.yielded[k]);
    const resumed = Object.keys(this.yielded).filter(k => !yielded[k]);
    this.yielded = yielded;
    if (changed.length || resumed.length) this.appliedAt = this.now();
    if (changed.length)
      this.noteOnce(`applied:${changed.join(',')}`, 'farm strategy applied', { strategy: strat.name, keys: changed,
        reason }, { every: 0 });
    if (reasserted.length) {
      this.reasserts++;
      this.noteOnce('reasserted', 'farm strategy re-applied over another writer', { strategy: strat.name,
        keys: reasserted, reason, why: 'the keeper owns these faculties, and while a strategy is assigned ' +
          'its file is the answer for its keys; unassign it (farm_strategy=null) or edit the file to change them' });
    }
    if (newlyYielded.length)
      this.noteOnce(`yield:${newlyYielded.join(',')}`, 'farm strategy yielding to the faculty holder', {
        strategy: strat.name, keys: newlyYielded,
        holders: [...new Set(newlyYielded.map(k => yielded[k].holder))],
        why: 'two writers is the known failure: while a bot or lease holds a faculty the file writes nothing under it' },
        { every: 0 });
    if (resumed.length)
      this.noteOnce(`resume:${resumed.join(',')}`, 'farm strategy resumed its keys', { strategy: strat.name,
        keys: resumed, why: 'the keeper owns the faculty again' }, { every: 0 });
  }

  /** Give a key back to what it was shadowing — only if it is still ours and the keeper owns it. */
  releaseKey(key) {
    const policy = this.host.policy, book = this.host.policySources;
    const was = this.base.get(key);
    const ours = this.wrote.has(key) && sameValue(policy[key], this.wrote.get(key));
    const faculty = this.loaded?.strategy?.faculties?.[key] ?? fieldForKey(key)?.faculty ?? 'work';
    if (ours && was && !this.heldBy(faculty)) {
      policy[key] = clone(was.value);
      book?.mark?.(key, was.source, { restored_from: `strategy:${this.name() ?? this.assigned}` });
    }
    this.wrote.delete(key); this.base.delete(key); delete this.overrides[key];
  }

  /** Unassign: every key the file wrote goes back, unless something else has written it since. */
  release(why = 'unassigned') {
    const keys = [...this.wrote.keys()];
    for (const k of keys) this.releaseKey(k);
    if (keys.length || this.loaded)
      this.noteOnce(`release:${this.assigned}`, 'farm strategy released', { strategy: this.assigned, why,
        restored: keys }, { every: 0 });
    this.wrote.clear(); this.base.clear(); this.overrides = {}; this.yielded = {};
    this.memory = {}; this.hooks = {}; this.cursor = null; this.client = null;
  }

  /** The policy as the ORDERS say it, without the file's overlay — for anything that persists. */
  ordersView(policy = this.host.policy) {
    const out = { ...policy };
    for (const [k, v] of this.wrote) if (sameValue(out[k], v) && this.base.has(k)) out[k] = clone(this.base.get(k).value);
    return out;
  }

  // ------------------------------------------------------------------------------- hooks
  ctx() {
    const h = this.host, c = h.s?.client;
    let vitals = null;
    try { const v = c?.vitals?.(); if (v) vitals = clone(v); } catch {}
    let touch = null;
    try { touch = h.touchState?.()?.snapshot?.() ?? null; } catch {}
    const strategy = this.name();
    return {
      strategy, agent: h.s?.name ?? null, now: this.now(),
      room: h.s?.world?.room?.num ?? null,
      vitals: deepFreeze(vitals), policy: deepFreeze(clone(h.policy ?? {})), touch: deepFreeze(touch),
      memory: this.memory,
      // The pack, by name, read on demand (a copy: nothing here can move an item).
      pack: () => deepFreeze((c?.inventory ?? []).map(o => ({
        name: c?.rsc?.get?.(o.nameRsc) || o.name || '',
        amount: Number.isFinite(Number(o.amount)) && o.amount != null ? Number(o.amount) : 1 }))),
      // THE ROOM, read on demand (operator, 2026-10-02: "pass room contents into the farm strategy
      // hook ... there will probably be more unique strategies like this"). A copy: names, kinds and
      // squares, never a handle a hook could act on. `id` is a TEMPORARY HANDLE (renumbered on every
      // save, recycled within hours) -- count and compare by name.
      contents: () => roomContents(c, h),
      note: (what, data) => this.noteOnce(`hooknote:${what}`, `farm strategy ${strategy}: ${String(what)}`,
        data, { every: 10_000 }),
      set: (path, value) => this.hookSet(path, value),
      requestTouchRecast: (why = 'a strategy hook asked') => {
        const st = h.touchState?.();
        if (!st) return false;
        if (this.heldBy('work')) return false;
        st.active = false;
        this.noteOnce('touch-recast', `farm strategy ${strategy}: touch recast requested`, { why });
        return true;
      },
    };
  }

  /** `ctx.set`: a directional key, validated and faculty-gated like the file's own. Throws on a bad one. */
  hookSet(path, value) {
    const f = fieldFor(path);
    if (!f) throw new Error(`ctx.set: ${JSON.stringify(path)} is not a strategy field — a hook can set only ` +
                            'what a strategy file can declare');
    const v = f.normalize(value, { resolveItem: this.resolveItem });
    const holder = this.heldBy(f.faculty);
    if (holder) return { applied: false, yielded_to: holder, faculty: f.faculty };
    for (const k of f.keys) {
      this.overrides[k] = v;
      // A hook override is a new desire, not somebody else's write: it must not become the base.
      if (this.wrote.has(k)) this.wrote.set(k, clone(this.host.policy[k]));
    }
    if (this.loaded?.ok) this.apply('hook');
    return { applied: true, keys: f.keys };
  }

  hookState(name) { return (this.hooks[name] ??= { calls: 0, strikes: 0, disabled: null, last_ms: null, skipped_held: 0 }); }

  disable(name, why) {
    const st = this.hookState(name);
    if (st.disabled) return;
    st.disabled = why;
    // A SILENTLY DISABLED HOOK IS A SETTING THAT DOES NOTHING. Say it at error level, once.
    console.error(`[strategy] farm strategy "${this.name()}" hook ${name} DISABLED: ${why} ` +
      '(the rest of the strategy still applies; editing the file re-enables it)');
    this.noteOnce(`disabled:${name}`, 'farm strategy hook disabled', { strategy: this.name(), hook: name, why,
      keeper: 'carries on; the rest of the strategy still applies, and an edit to the file re-enables it' },
      { every: 0 });
  }

  /** Run one hook. Never throws, never awaits, never blocks longer than the hook itself. */
  dispatch(name, payload = {}) {
    const fn = this.loaded?.ok ? this.loaded.strategy.hooks[name] : null;
    if (!fn) return undefined;
    const st = this.hookState(name);
    if (st.disabled) return undefined;
    if (this.heldBy('work')) { st.skipped_held++; return undefined; }
    const t0 = performance.now();
    let r;
    try { r = fn(this.ctx(), deepFreeze(clone(payload))); }
    catch (e) { this.disable(name, `threw: ${e?.message ?? e}`); return undefined; }
    const ms = performance.now() - t0;
    st.calls++; st.last_ms = Math.round(ms * 10) / 10;
    if (r && typeof r.then === 'function') {
      r.then(null, e => this.disable(name, `rejected: ${e?.message ?? e}`));
      r = undefined;
    }
    if (ms > this.budgetMs && ++st.strikes >= HOOK_STRIKES)
      this.disable(name, `over its ${this.budgetMs}ms budget ${HOOK_STRIKES} times (last ${st.last_ms}ms) — ` +
                         'a hook runs on the keeper\'s own loop');
    return r;
  }

  /** Feed new server lines to onCombatLine / onServerMessage. History before attaching is skipped. */
  pumpLines() {
    const hooks = this.loaded?.strategy?.hooks ?? {};
    if (!hooks.onCombatLine && !hooks.onServerMessage) return 0;
    const c = this.host.s?.client;
    if (!c || typeof c.eventsSince !== 'function') return 0;
    if (c !== this.client || this.cursor == null) {
      this.client = c; this.cursor = Number.isFinite(c.evSeq) ? c.evSeq : 0;
      return 0;
    }
    let evs = [];
    try { evs = c.eventsSince(this.cursor) ?? []; } catch { return 0; }
    let n = 0;
    for (const e of evs) {
      if (Number.isFinite(e?.seq)) this.cursor = Math.max(this.cursor, e.seq);
      if (e?.kind !== 'message' || typeof e.text !== 'string') continue;
      if (++n > MAX_LINES_PER_PUMP) break;
      let parsed = null;
      try { parsed = classifyCombatLine(e.text); } catch {}
      if (parsed && hooks.onCombatLine) this.dispatch('onCombatLine', { text: e.text, parsed });
      else if (!parsed && hooks.onServerMessage) this.dispatch('onServerMessage', { text: e.text });
    }
    if (Number.isFinite(c.evSeq)) this.cursor = Math.max(this.cursor, c.evSeq);
    return n;
  }

  // ------------------------------------------------------------------------------ status
  status() {
    if (!this.assigned) return null;
    const policy = this.host.policy ?? {};
    const strat = this.loaded?.strategy;
    const keys = {};
    if (strat) {
      const desired = { ...strat.desired, ...this.overrides };
      for (const [k, v] of Object.entries(desired)) {
        const base = this.base.get(k);
        keys[k] = {
          faculty: strat.faculties[k] ?? fieldForKey(k)?.faculty ?? 'work',
          file: v, effective: policy[k] ?? null,
          applied: this.wrote.has(k) && sameValue(policy[k], this.wrote.get(k)),
          yielded_to: this.yielded[k]?.holder ?? null,
          ...(Object.hasOwn(this.overrides, k) ? { set_by_hook: true } : {}),
          shadowing: base ? { value: base.value, source: base.source } : null,
        };
      }
    }
    const yieldedKeys = Object.keys(this.yielded);
    const state = !this.loaded ? 'refused'
      : yieldedKeys.length && yieldedKeys.length === Object.keys(keys).length ? 'yielding'
      : yieldedKeys.length ? 'partly yielded' : 'applied';
    return {
      assigned: this.assigned, state, file: this.loaded?.file ?? this.refused?.file ?? null,
      describe: strat?.describe ?? null,
      loaded_mtime: this.loaded?.mtime ?? null, reloads: this.reloads, reasserts: this.reasserts,
      refused: this.refused ? { ...this.refused,
        keeping: this.loaded ? 'the previous version of this file' : 'the existing posture — nothing from the file is applied' } : null,
      unrecognised: this.loaded?.unrecognised?.length ? this.loaded.unrecognised : [],
      keys,
      hooks: strat ? Object.fromEntries(Object.keys(strat.hooks).map(h => [h, { ...this.hookState(h) }])) : {},
      carry: 'only the assignment (policy.farmStrategy) is pushed and carried; the file\'s keys are ' +
             're-derived from the file by each keeper process and never written to the roster',
    };
  }
}

// ------------------------------------------------------------------------------------ cli
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const show = (r) => {
    console.log(`  ${r.ok ? 'ok     ' : 'REFUSED'} ${r.name}${r.ok ? '' : ` — ${r.why}`}`);
    if (r.ok) {
      for (const f of r.strategy.fields)
        console.log(`           ${f.path.padEnd(26)} -> ${f.keys.join(', ').padEnd(28)} [${f.faculty}]`);
      const hooks = Object.keys(r.strategy.hooks);
      if (hooks.length) console.log(`           hooks: ${hooks.join(', ')}`);
    }
    if (r.unrecognised?.length) console.log(`           unrecognised, NOT applied: ${r.unrecognised.join(', ')}`);
  };
  if (args[0] === '--example') {
    const r = await listFarmStrategies({ dir: FARM_STRATEGY_EXAMPLES });
    console.log(`\nexamples in ${FARM_STRATEGY_EXAMPLES} (copy one into ${FARM_STRATEGY_DIR} to use it):\n`);
    for (const s of r.strategies) show(s);
    console.log('');
    process.exit(r.strategies.every(s => s.ok) ? 0 : 1);
  }
  if (args[0] === 'check' && args[1]) {
    const dir = args.includes('--examples') ? FARM_STRATEGY_EXAMPLES : FARM_STRATEGY_DIR;
    const r = await loadFarmStrategy(args[1], { dir });
    show(r);
    process.exit(r.ok ? 0 : 1);
  }
  const r = await listFarmStrategies();
  if (!r.present) {
    console.log(`\nno ${r.dir}\n\n  Not an error and not an empty policy: no character has a farming strategy, and every`);
    console.log('  keeper farms exactly as its roster and pushes say. To add one: mkdir substrate/farm-strategies,');
    console.log('  copy a file from substrate/farm-strategies.example/, then');
    console.log('  autopilot action=start agent=<a> mode=farm farm_strategy=<name>\n');
    process.exit(0);
  }
  console.log(`\nfarming strategies in ${r.dir}:\n`);
  for (const s of r.strategies) show(s);
  console.log('');
  process.exit(r.strategies.every(s => s.ok) ? 0 : 1);
}

export { STRATEGY_HOOKS };
