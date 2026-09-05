// WHERE FLEET SCRIPTS LIVE, AND WHOSE THEY ARE.
//
//   import { loadFleetScripts, runNamed } from './m59-fleetlib.mjs';
//
// A fleet script is a named, parameterised errand — "bulk resupply", "bring everyone home" —
// that an operator can invoke without writing the walking. This finds them in two places and
// the split is the same one the rest of this repository makes about ORDERS:
//
//   tools/fleetscripts/     PUBLIC. Committed. The shape of an errand, useful to anyone who
//                           cloned this. No character names, no room numbers that only mean
//                           something to one machine.
//   substrate/fleetscripts/ THIS MACHINE'S. Gitignored, like substrate/loadouts and
//                           substrate/tuning.json. An errand that names our characters, our
//                           farm room, our couriers.
//
// LOCAL WINS ON A NAME CLASH, and that is the point rather than a tie-break: the public
// `resupply` is the general shape and a machine that wants its own destinations overrides it
// by name without editing anything that git tracks. The override is REPORTED when it
// happens, because a script silently doing something other than the committed one is the
// same failure mode as a policy key that is accepted and never applied.
//
// A SCRIPT IS DATA UNTIL IT IS RUN. Loading one imports the module, so a script that does
// work at import time would drive the fleet merely by being listed — the trap this
// repository already documents for m59-broker.mjs and m59-supervise.mjs. So a module must
// export a `script` object and do nothing else; `steps` is a FUNCTION of its parameters,
// never a value computed on load.
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseUnsafe, UNSAFE_GUARANTEES, guaranteeText } from './m59-fleetscript.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

export const PUBLIC_DIR = process.env.M59_FLEETSCRIPTS_PUBLIC || join(HERE, 'fleetscripts');
export const LOCAL_DIR = process.env.M59_FLEETSCRIPTS_LOCAL ||
  join(REPO, 'substrate', 'fleetscripts');

function listDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.endsWith('-test.mjs'));
}

/**
 * Every script this machine can run, by name.
 *
 * Returns a Map of name -> { name, describe, params, steps, source, file, overrides }.
 * A module that does not export a usable `script` is REPORTED rather than skipped silently:
 * a script that is not there and a script that failed to load look identical from a menu,
 * and only one of them is the operator's fault.
 */
export async function loadFleetScripts({ publicDir = PUBLIC_DIR, localDir = LOCAL_DIR } = {}) {
  const found = new Map();
  const problems = [];

  for (const [source, dir] of [['public', publicDir], ['local', localDir]]) {
    for (const file of listDir(dir)) {
      const path = join(dir, file);
      let mod;
      try {
        // pathToFileURL, NOT a bare path: on Windows the ESM loader reads `C:\...` as a URL
        // with scheme "c:" and refuses it, with an error that says nothing about scripts.
        mod = await import(pathToFileURL(path).href);
      } catch (e) {
        problems.push({ file: path, why: `will not import: ${e.message}` });
        continue;
      }
      const script = mod.script ?? mod.default;
      if (!script || typeof script !== 'object') {
        problems.push({ file: path, why: 'exports no `script` object' });
        continue;
      }
      const name = String(script.name || basename(file, '.mjs'));
      if (typeof script.steps !== 'function') {
        problems.push({ file: path, why: `script "${name}" has no steps(params) function` });
        continue;
      }
      // A MALFORMED WAIVER IS REFUSED AT LOAD, not at run. The author of an unsafe block
      // believes some guarantee is off; if the block is wrong they find out with a
      // character already walking. `list` is where that should surface instead.
      try {
        parseUnsafe(script.unsafe, { scriptName: name });
      } catch (e) {
        problems.push({ file: path, why: e.message });
        continue;
      }
      const overrides = source === 'local' && found.has(name) ? found.get(name).file : null;
      found.set(name, { ...script, name, source, file: path, overrides });
    }
  }
  return { scripts: found, problems };
}

// EVERY PLACE THE CHECKING STOPPED. The counterpart to being allowed to waive a guarantee
// is that the waivers are countable — an escape hatch nobody can enumerate is just a hole.
// Sorted with the widest waivers first, because that is the order you want to read them in.
export function auditUnsafe(scripts) {
  const rows = [];
  for (const s of scripts.values()) {
    const u = parseUnsafe(s.unsafe, { scriptName: s.name });
    if (!u.waived.size) continue;
    rows.push({
      name: s.name,
      source: s.source,
      file: s.file,
      waives: [...u.waived],
      reason: u.reason,
      owner: u.owner,
      all: u.all,
    });
  }
  rows.sort((a, b) => b.waives.length - a.waives.length || a.name.localeCompare(b.name));
  return rows;
}

export function formatUnsafeAudit(rows, { total = 0 } = {}) {
  if (!rows.length)
    return `no script waives any guarantee (${total} loaded). ` +
      `Waivable: ${Object.keys(UNSAFE_GUARANTEES).join(', ')}.`;
  const out = [`${rows.length} of ${total} script(s) waive a guarantee:`, ''];
  for (const r of rows) {
    out.push(`  ${r.name} [${r.source}]${r.all ? '  ALL GUARANTEES OFF' : ''}`);
    out.push(`    waives: ${r.waives.join(', ')}`);
    out.push(`    reason: ${r.reason}`);
    if (r.owner) out.push(`    owner:  ${r.owner}`);
  }
  return out.join('\n');
}

/** Parameters a caller did not give, filled from the script's declared defaults. */
export function applyDefaults(script, params = {}) {
  const out = { ...params };
  for (const [key, spec] of Object.entries(script.params ?? {})) {
    if (out[key] === undefined && spec && 'default' in spec) out[key] = spec.default;
  }
  return out;
}

/**
 * What is missing or wrong, BEFORE anything walks.
 *
 * Checked up front for the same reason the fleet-plan interpreter validates a whole plan
 * before sending its first call: a typo in the fourth parameter must not be discovered by a
 * character standing in the wrong town.
 */
export function checkParams(script, params = {}) {
  const bad = [];
  for (const [key, spec] of Object.entries(script.params ?? {})) {
    const v = params[key];
    if (spec?.required && (v === undefined || v === null || v === ''))
      bad.push(`${key} is required — ${spec.describe ?? ''}`.trim());
    else if (v !== undefined && spec?.type === 'number' && !Number.isFinite(Number(v)))
      bad.push(`${key} must be a number, got ${JSON.stringify(v)}`);
    else if (v !== undefined && spec?.type === 'agents' && !String(v).trim())
      bad.push(`${key} must name at least one agent`);
  }
  return bad;
}

/** Agents as an array, however they were typed: "a,b", ["a","b"], "a b". */
export const asAgents = v =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean);

/**
 * Run one named script.
 *
 * `fleetScript` is passed in rather than imported here so this module stays pure and a test
 * can watch what a script would do without a broker. That is the same reason m59-atomics
 * takes a driver instead of reaching for fetch.
 */
export async function runNamed(name, params, { scripts, fleetScript, onLog = console.log } = {}) {
  const script = scripts.get(name);
  if (!script) return { ok: false, why: `no script named "${name}"` };

  const withDefaults = applyDefaults(script, params);
  const bad = checkParams(script, withDefaults);
  if (bad.length) return { ok: false, why: `bad parameters:\n  ${bad.join('\n  ')}` };

  if (script.overrides)
    onLog(`note: this machine's ${script.file} overrides the committed ${script.overrides}`);

  const agents = asAgents(withDefaults.agents);
  if (!agents.length) return { ok: false, why: 'no agents' };

  return fleetScript({
    name: `${name} (${script.source})`,
    agents,
    steps: agent => script.steps({ ...withDefaults, agent, agents }),
    minHealth: withDefaults.minHealth,
    // A script's waiver travels with the script. Passing it from here rather than letting
    // the caller supply one is the point: the exception belongs to the errand that needs
    // it, not to whoever happened to invoke the errand today.
    unsafe: script.unsafe ?? null,
  });
}
