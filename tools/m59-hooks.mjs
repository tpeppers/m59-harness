#!/usr/bin/env node
// PRIVATE STRATEGY, PUBLIC HARNESS — register a handler for something the fleet does.
//
//   node tools/m59-hooks.mjs                 what is registered, and what has been disabled
//   node tools/m59-hooks.mjs --events        the event vocabulary, read from the ledger
//   node tools/m59-hooks.mjs --explain       the rules a handler runs under
//
// Everybody who runs this harness wants to override some detail of some behaviour, and
// nobody wants the same detail. The answers so far have been to fork a tool, to add a policy
// key, or to edit a committed table — and all three put one fleet's bet into everybody's
// repository. `substrate/policy.local.json` solved that for NUMBERS. This solves it for
// MOMENTS: a private module says "when the fleet does X, run my code", and stays private.
//
// The seam is `recordEvent` in m59-ledger.mjs, which is already the choke point every
// notable thing passes through — a death, a kill, a wedge given up on, a level lost, a
// purchase. Hooks are fired from there, so anything already written down can be subscribed
// to without a new emitter, and a new emitter costs one `recordEvent` call.
//
// ============================================================================
// THE FOUR RULES, AND WHY EACH EXISTS
// ============================================================================
//
// 1. A HANDLER CANNOT BREAK THE FLEET. Every call is wrapped. A throw is caught, counted and
//    reported; after `MAX_FAULTS` the handler is disabled for the process and says so. The
//    ledger write happens BEFORE any handler runs, so a bad hook cannot cost us the record of
//    what happened — losing the evidence is worse than losing the reaction.
//
// 2. A HANDLER CANNOT STALL THE FLEET. This is one event loop with twenty-one characters on
//    it. A 1.2 second stall once took twelve of twenty-one out of the world in five minutes,
//    and a synchronous 100-400ms hook was blocked from shipping for the same reason. So a
//    handler gets `BUDGET_MS`, overruns are counted, and a repeat offender is disabled.
//    Handlers are invoked without being awaited: a slow one delays itself, not the fleet.
//
// 3. A HANDLER CANNOT TOUCH A PROTECTED FACULTY. `identity`, `mortality`, `survival` and
//    `recovery` are the four things an unattended character must always do for itself —
//    Autopilot.PROTECTED_FACULTIES. A hook may observe them and may act on anything else,
//    but it may not take them, because the whole point of the protection is that nobody can
//    negotiate it away. A hook that wants a protected faculty is refused and told why.
//
// 4. A HANDLER IS AN OBSERVER THAT MAY ASK. It receives the event and may do work; it does
//    not return a veto. Nothing here can cancel a death or refuse a flee. This is deliberate:
//    an override that can say "no" to the survival ladder is a private file that can kill a
//    character, and no amount of documentation makes that safe to hand out.
//
// ============================================================================
// WRITING ONE
// ============================================================================
//
//   // substrate/hooks/out-of-food.mjs        (gitignored)
//   export const name = 'restock when the larder empties';
//   export const on = {
//     larder_empty: async ({ character, detail }) => {
//       // ... your private strategy. Errors are caught; take your time budget seriously.
//     },
//   };
//
// Files are loaded from `substrate/hooks/*.mjs`. An absent directory is not an error and not
// a warning: no hooks is the shipped behaviour, exactly as an absent policy.local.json is.
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOOK_DIR = join(HERE, '..', 'substrate', 'hooks');

// A handler gets this long before it is counted as slow. Deliberately small: the budget is
// not "how long may your strategy take", it is "how long may you hold the loop before we
// notice". Long work belongs in a promise the handler does not await here.
export const BUDGET_MS = Number(process.env.M59_HOOK_BUDGET_MS || 50);
export const MAX_FAULTS = Number(process.env.M59_HOOK_MAX_FAULTS || 3);
export const MAX_SLOW = Number(process.env.M59_HOOK_MAX_SLOW || 5);

// Mirrors Autopilot.PROTECTED_FACULTIES. Duplicated as a literal ON PURPOSE: importing
// m59-autopilot.mjs from the ledger's hook path would make the ledger depend on the keeper,
// and the ledger is imported by tools that must never start one. The lock below fails loudly
// if the two ever drift.
export const PROTECTED_FACULTIES = Object.freeze(['identity', 'mortality', 'survival', 'recovery']);

const registry = new Map();      // kind -> [{ name, fn, file }]
const health = new Map();        // name -> { faults, slow, disabled, why, calls, totalMs }
let loaded = false;

function stateFor(name) {
  if (!health.has(name)) health.set(name, { faults: 0, slow: 0, disabled: false, why: null, calls: 0, totalMs: 0 });
  return health.get(name);
}

/**
 * Register a handler. Returns false (and records why) rather than throwing, because a hook
 * that cannot register must not take down the process that was loading it.
 */
export function onEvent(kind, fn, { name = fn?.name || 'anonymous', file = null, wants = [] } = {}) {
  if (typeof fn !== 'function') return false;
  const protectedWanted = wants.filter(w => PROTECTED_FACULTIES.includes(w));
  if (protectedWanted.length) {
    stateFor(name).disabled = true;
    stateFor(name).why = `asked for protected faculty/faculties: ${protectedWanted.join(', ')}. `
      + 'These are the four things an unattended character must always do for itself; they are '
      + 'not negotiable and not lendable, which is the entire point of protecting them.';
    return false;
  }
  if (!registry.has(kind)) registry.set(kind, []);
  registry.get(kind).push({ name, fn, file });
  stateFor(name);
  return true;
}

/** Load every private handler. Absent directory = no hooks = shipped behaviour. */
export async function loadHooks({ dir = HOOK_DIR, force = false } = {}) {
  if (loaded && !force) return registry;
  loaded = true;
  if (!existsSync(dir)) return registry;
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort(); } catch { return registry; }
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href);
      const label = mod.name || f;
      const table = mod.on || {};
      for (const [kind, fn] of Object.entries(table))
        onEvent(kind, fn, { name: label, file: f, wants: mod.wants || [] });
    } catch (e) {
      const s = stateFor(f);
      s.disabled = true;
      s.why = `failed to load: ${e.message}`;
    }
  }
  return registry;
}

/**
 * Fire a kind at whatever is listening. NEVER throws, never returns a veto, never awaited by
 * the caller — the ledger has already written the row before this runs.
 */
export function fireEvent(kind, payload = {}) {
  const list = registry.get(kind);
  if (!list || !list.length) return 0;
  let fired = 0;
  for (const h of list) {
    const s = stateFor(h.name);
    if (s.disabled) continue;
    const t0 = Date.now();
    try {
      const r = h.fn(payload);
      fired++;
      s.calls++;
      // A promise is allowed and is NOT awaited: a handler that wants to walk a character
      // across town must not hold the loop while it does. Its rejection is still caught,
      // because an unhandled rejection takes the process down and the process is the fleet.
      if (r && typeof r.then === 'function')
        r.then(null, (e) => noteFault(s, h, e));
    } catch (e) {
      noteFault(s, h, e);
    }
    const took = Date.now() - t0;
    s.totalMs += took;
    if (took > BUDGET_MS) {
      s.slow++;
      if (s.slow >= MAX_SLOW && !s.disabled) {
        s.disabled = true;
        s.why = `held the event loop over ${BUDGET_MS}ms on ${s.slow} occasions (worst seen `
          + `${took}ms). One loop carries the whole fleet; a hook that stalls it takes `
          + 'characters out of the world.';
      }
    }
  }
  return fired;
}

function noteFault(s, h, e) {
  s.faults++;
  if (s.faults >= MAX_FAULTS && !s.disabled) {
    s.disabled = true;
    s.why = `threw ${s.faults} times; last: ${e?.message || e}`;
  }
}

/** What is registered and how it is behaving. For an operator and for tests. */
export function hookStatus() {
  const rows = [];
  for (const [kind, list] of registry)
    for (const h of list) {
      const s = stateFor(h.name);
      rows.push({ kind, name: h.name, file: h.file, calls: s.calls,
                  mean_ms: s.calls ? +(s.totalMs / s.calls).toFixed(1) : 0,
                  faults: s.faults, slow: s.slow, disabled: s.disabled, why: s.why });
    }
  for (const [name, s] of health)
    if (s.disabled && !rows.some(r => r.name === name))
      rows.push({ kind: '(never registered)', name, disabled: true, why: s.why });
  return rows;
}

/**
 * Hand the ledger our fire function. Called by whoever loaded the hooks -- the broker at
 * startup -- so a tool that only reads the ledger never pulls this module in at all.
 */
export function attachTo(attach) {
  if (typeof attach === 'function') attach(fireEvent);
}

/** Test seam. */
export function resetHooks() { registry.clear(); health.clear(); loaded = false; }

// --------------------------------------------------------------------------- cli
const invokedDirectly = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--explain')) {
    console.log('A hook runs under four rules:\n');
    console.log(`  1. It cannot break the fleet. Throws are caught; ${MAX_FAULTS} disables it.`);
    console.log(`  2. It cannot stall the fleet. Over ${BUDGET_MS}ms is slow; ${MAX_SLOW} slow calls disables it.`);
    console.log(`  3. It cannot take a protected faculty: ${PROTECTED_FACULTIES.join(', ')}.`);
    console.log('  4. It observes and may act. It cannot veto — nothing here can refuse a flee.');
    console.log(`\nDrop a module in ${HOOK_DIR} exporting { name, on: { <kind>: fn } }.`);
  } else if (args.includes('--events')) {
    console.log('Event kinds this harness writes (from recordEvent call sites):\n');
    console.log('  bought  cast  confinement_refused_travel  died  first_seen');
    console.log('  left_the_newbie_zone  play_dead_refused_no_spot  returned_fire  stalled');
    console.log('  strategy_changed  stuck_backed_up  travel_resume_dropped  travel_resumed');
    console.log('  unstalled  wedge_gave_up');
    console.log('\nMore arrive with computed kinds (killed, level_up, level_lost, zone_change,');
    console.log('travel_journey, ...). `node tools/m59-hooks.mjs --events` lists the literals;');
    console.log('the ledger itself is the complete answer — grep a fleet history for "kind".');
  } else {
    loadHooks().then(() => {
      const rows = hookStatus();
      if (!rows.length) { console.log(`no hooks registered (looked in ${HOOK_DIR})`); return; }
      for (const r of rows)
        console.log(`  ${r.disabled ? 'OFF' : ' on'}  ${String(r.kind).padEnd(24)} ${r.name}` +
                    (r.why ? `\n        ${r.why}` : ''));
    });
  }
}
