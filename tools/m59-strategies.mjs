#!/usr/bin/env node
// PRIVATE TRAVEL STRATEGIES: THE LOADER, WHICH IS SHARED. THE STRATEGIES ARE NOT.
//
//   node tools/m59-strategies.mjs              what this machine has, and whether it parses
//   node tools/m59-strategies.mjs --example    print the shape to start from
//
// `substrate/strategies/*.mjs` is gitignored and holds executable strategies this fleet
// runs. Everything else private in this repository is a NUMBER with its shape committed;
// this is a step further and hides the code, because a travel strategy is an instruction to
// a character that the keeper imports and runs. A file that parses is a file the fleet
// obeys, and one arriving from somebody else's afternoon should not be.
//
// So this file — the loader, the contract, and the refusals — is committed and tested, and
// `substrate/strategies.example.mjs` is the shape. The example lives BESIDE the directory
// and never inside it: `load()` enumerates every `.mjs` in there, so an example in there is
// a strategy nobody asked for. That mistake has already been made once in this repository
// with `substrate/loadouts/`.
//
// THE FOUR RULES ARE THE POLICY RULES, because a strategy is policy that happens to be code
// (docs/m59-policy.md argues each):
//
//   - SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE. No strategies directory, or an
//     empty one, is a fleet that travels exactly as it did before. It is never an empty
//     policy and never paralysis.
//   - A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE. It is reported, loudly, by name and
//     with the error, and the others still load. Swallowing it would silently return the
//     fleet to default behaviour while the operator believed a strategy was running.
//   - AN UNUSABLE STRATEGY KEEPS THE COMMITTED BEHAVIOUR rather than unsetting it.
//   - AN UNRECOGNISED EXPORT IS REPORTED, never applied and never dropped, because a
//     setting that silently does nothing is how `purpose` stayed out of a schema for a year
//     with every keeper's audit switched off.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const STRATEGY_DIR = join(HERE, '..', 'substrate', 'strategies');
export const EXAMPLE = join(HERE, '..', 'substrate', 'strategies.example.mjs');

// THE CONTRACT. A strategy is a module with a default export shaped like this. Anything
// else it exports is reported as unrecognised rather than ignored.
//
//   export default {
//     name: 'blink-escape',           // required, unique; how it appears in the ledger
//     kind: 'travel',                 // required; 'travel', 'town' or 'convoy'
//     enabled: false,                 // required, and FALSE is the honest default
//     // TRAVEL hooks --------------------------------------------------------------
//     // Asked when a walk has run out of ordinary answers. Return null to decline —
//     // declining is the common case and must stay cheap.
//     async whenStuck(ctx) { return null; },
//     // Asked before a crossing starts, for strategies that do not wait for trouble.
//     async beforeCrossing(ctx) { return null; },
//     // TOWN hooks ----------------------------------------------------------------
//     // Asked when a character is standing at a counter and something has to decide what
//     // to hand over. Return null to decline; return a plan to have it obeyed.
//     //   ctx = { loadout, items, equipped, room, merchant, purse }
//     // The answer is m59-townstop.planTownStop's shape: { sell, buy, keep_fragments, ... }.
//     async atTownStop(ctx) { return null; },
//     // CONVOY strategies use beforeCrossing too, but are asked a group question — "should
//     // we all go now" rather than "how do I get through". See substrate/strategies.example.mjs.
//   }
export const REQUIRED = ['name', 'kind', 'enabled'];
export const HOOKS = ['whenStuck', 'beforeCrossing', 'atTownStop'];
// 'town' was added when the sell/buy filter moved out of m59-sellrun.mjs's private copy.
// A KIND IS NOT A HOOK: the kind says what a strategy is about and the hook says when it is
// asked, and keeping them separate is what lets a town strategy be listed, enabled and
// audited by the same loader without the travel path ever calling it.
// 'convoy' is travel too, but it is about a GROUP and it is asked on a different question:
// not 'how do I get through' but 'should we all go now'. Keeping it a separate kind is what
// lets a convoy strategy be listed, enabled and audited without the solo mover consulting it.
export const KINDS = ['travel', 'town', 'convoy'];
const KNOWN = new Set([...REQUIRED, ...HOOKS, 'describe', 'settings']);

/**
 * Everything this machine has, with the ones that could not be loaded named rather than
 * dropped. Never throws: a broken strategy must not take the keeper down with it.
 */
export async function load({ dir = STRATEGY_DIR } = {}) {
  const out = { dir, strategies: [], problems: [], present: false };
  try { if (!existsSync(dir) || !statSync(dir).isDirectory()) return out; }
  catch { return out; }
  out.present = true;

  // A LEADING UNDERSCORE IS A HELPER, NOT A STRATEGY. The recorder that measures
  // `blink_race_to_<exit>` has to live in this directory -- it is as private as the strategy
  // that reads it -- but it answers no hook, so enumerating it would report a problem every
  // load for a file that is working perfectly. `_name.mjs` is imported by the strategies
  // that want it and never loaded as one.
  let names = [];
  try {
    names = readdirSync(dir)
      .filter(n => n.endsWith('.mjs') && !n.startsWith('_'))
      .sort();
  }
  catch (e) { out.problems.push({ file: dir, why: 'could not be read: ' + e.message }); return out; }

  for (const name of names) {
    const path = join(dir, name);
    let mod;
    try { mod = await import(pathToFileURL(resolve(path)).href); }
    catch (e) {
      // NAMED, NOT SWALLOWED. See the header: a file that will not parse is not an empty
      // file, and reporting it as one returns the fleet to default behaviour in silence.
      out.problems.push({ file: name, why: 'did not load: ' + e.message });
      continue;
    }
    const s = mod?.default;
    if (!s || typeof s !== 'object') {
      out.problems.push({ file: name, why: 'has no default export shaped like a strategy' });
      continue;
    }
    const missing = REQUIRED.filter(k => s[k] === undefined);
    if (missing.length) {
      out.problems.push({ file: name, why: 'is missing ' + missing.join(', ') });
      continue;
    }
    if (!KINDS.includes(s.kind)) {
      out.problems.push({ file: name, why: `kind "${s.kind}" is not one of ${KINDS.join(', ')}` });
      continue;
    }
    if (out.strategies.some(x => x.name === s.name)) {
      out.problems.push({ file: name, why: `another strategy is already called "${s.name}"` });
      continue;
    }
    const hooks = HOOKS.filter(h => typeof s[h] === 'function');
    if (!hooks.length) {
      out.problems.push({ file: name, why: 'declares no hook — one of ' + HOOKS.join(', ') });
      continue;
    }
    // REPORTED, NEVER APPLIED AND NEVER DROPPED.
    const unknown = Object.keys(s).filter(k => !KNOWN.has(k));
    if (unknown.length)
      out.problems.push({ file: name, why: 'exports nothing that reads: ' + unknown.join(', '),
                          unrecognised: true });
    out.strategies.push({ ...s, file: name, hooks, unrecognised: unknown });
  }
  return out;
}

/** The enabled ones that answer a given hook, in load order. */
export function activeFor(loaded, hook) {
  return (loaded?.strategies ?? [])
    .filter(s => s.enabled && typeof s[hook] === 'function');
}

/**
 * Ask each enabled strategy in turn and take the FIRST that offers something.
 *
 * A strategy that throws is reported and skipped, never fatal — see the header. It is asked
 * on a stuck walk, which is already the unhappy path, and an exception there must not turn a
 * slow crossing into a dead character.
 */
export async function firstAnswer(loaded, hook, ctx, { onError = null } = {}) {
  for (const s of activeFor(loaded, hook)) {
    try {
      const answer = await s[hook](ctx);
      if (answer) return { strategy: s.name, answer };
    } catch (e) {
      onError?.({ strategy: s.name, why: e.message });
    }
  }
  return null;
}

// ------------------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-strategies.mjs')) {
  if (process.argv.includes('--example')) {
    if (!existsSync(EXAMPLE)) { console.error('substrate/strategies.example.mjs is missing'); process.exit(2); }
    const { readFileSync } = await import('node:fs');
    process.stdout.write(readFileSync(EXAMPLE, 'utf8'));
    process.exit(0);
  }
  const loaded = await load();
  if (!loaded.present) {
    console.log(`\nno ${STRATEGY_DIR}\n`);
    console.log('  That is not an error and not an empty policy — the fleet travels exactly as');
    console.log('  it did before. To add one: mkdir substrate/strategies, then start from');
    console.log('  node tools/m59-strategies.mjs --example\n');
    process.exit(0);
  }
  console.log(`\n${loaded.strategies.length} strategy(s) in ${loaded.dir}\n`);
  for (const s of loaded.strategies)
    console.log(`  ${s.enabled ? 'ON ' : 'off'}  ${String(s.name).padEnd(18)} ${s.kind.padEnd(8)} ` +
                `${s.hooks.join(', ')}${s.describe ? '  — ' + s.describe : ''}`);
  if (loaded.problems.length) {
    console.log('\n  problems — reported rather than dropped:');
    for (const p of loaded.problems) console.log(`    ${p.file}: ${p.why}`);
  }
  console.log('');
}
