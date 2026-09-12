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
import { readdirSync, existsSync, statSync } from 'node:fs';
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

// A VERSION FOR A FILE, CHEAP ENOUGH TO ASK ON EVERY LOAD. Size as well as mtime because
// mtime alone is only as fine as the filesystem's clock, and two saves inside one tick of it
// would otherwise share a key and reload as the older one. An unreadable stat returns null
// and the import falls back to the bare URL: a file we cannot stat is about to fail to import
// anyway, and it must fail with ITS error rather than with one about versioning.
function stamp(file) {
  try { const st = statSync(file); return `${st.mtimeMs}-${st.size}`; } catch { return null; }
}

/**
 * Every script this machine can run, by name.
 *
 * Returns a Map of name -> { name, describe, params, steps, source, file, overrides }.
 * A module that does not export a usable `script` is REPORTED rather than skipped silently:
 * a script that is not there and a script that failed to load look identical from a menu,
 * and only one of them is the operator's fault.
 */
export async function loadFleetScripts({ publicDir = PUBLIC_DIR, localDir = LOCAL_DIR,
                                         dirs = null } = {}) {
  const found = new Map();
  const problems = [];

  // `dirs` IS FOR A CALLER WITH A DIFFERENT PAIR OF PLACES, not a third place for errands.
  // m59-fleetscratch.mjs passes [['pad', PAD_DIR]] so that a scratch pad gets this module's
  // import, its cache key, its `steps` check and its load-time waiver refusal rather than a
  // second copy of all four -- which is the failure this repository has an index to prevent.
  // It does NOT widen where `list` looks: the default is still the two committed places, and
  // a pad is invisible to anything that does not ask for it by name. That invisibility is the
  // strongest of the three things keeping a half-written pad away from a keeper.
  for (const [source, dir] of dirs ?? [['public', publicDir], ['local', localDir]]) {
    for (const file of listDir(dir)) {
      const path = join(dir, file);
      let mod;
      try {
        // pathToFileURL, NOT a bare path: on Windows the ESM loader reads `C:\...` as a URL
        // with scheme "c:" and refuses it, with an error that says nothing about scripts.
        //
        // AND A QUERY ON THE END, BECAUSE RELOAD DID NOT RELOAD. Measured 2026-09-11: the
        // ESM module cache is keyed on the URL, so re-importing an edited file returned the
        // module from the FIRST import. `reload` in m59-fleet-repl.mjs therefore picked up
        // NEW files and silently ignored every EDIT to an existing one -- so an author who
        // changed a step, typed `reload`, and saw the old steps render concluded the edit was
        // wrong. A tool that claims to reload and does not is worse than one that never
        // offered, because it makes the stale thing look freshly confirmed.
        //
        // Keyed on mtime and size rather than Date.now() for the reason m59-tuning.mjs is:
        // an UNCHANGED file must resolve to the cache it already has, so listing the scripts
        // ten times costs one import each and a quiet `reload` allocates nothing. Only a
        // file that actually moved gets a new key.
        //
        // THE INSTANCES THIS STRANDS ARE THE PRICE AND THEY ARE DELIBERATE. Node has no way
        // to evict a module, so every edit leaves its predecessor in the loader for the life
        // of the process. That is bounded by the number of edits in one sitting, which is the
        // right trade for an authoring loop and is why this must not be "tidied" back to a
        // bare href. A script is data until it is run (see the note above), so a stranded
        // module holds no fleet state and drives nothing.
        const v = stamp(path);
        mod = await import(pathToFileURL(path).href + (v ? `?v=${v}` : ''));
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
      // A LATER SOURCE OVERRIDES AN EARLIER ONE, whoever the sources are. This used to test
      // `source === 'local'`, which meant two files in the SAME directory exporting one name
      // had a silent winner -- the quietest form of the exact thing this field exists to
      // report. The winner is unchanged either way; only the reporting is.
      const overrides = found.has(name) ? found.get(name).file : null;
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
    // AND THE FRAGILE FLOOR, FOR THE SAME REASON AND WITH A SHARPER EDGE. `fragileBody`
    // refuses a journey for a body under a MAXIMUM-health floor, which is right on a road and
    // wrong for an errand that never leaves a town — the bank and the counter in Tos are two
    // hops apart inside a city, and the guarantee refused a 20-max-health caster walking
    // between them on 2026-09-12.
    //
    // Without this the only way out is `waives: ['fragileBody']`, which turns the floor off for
    // the WHOLE errand including any cross-country leg it might grow later. A floor that cannot
    // be lowered for a town trip is a floor that gets waived entirely, and then it is not a
    // floor. So a script states its own, the same way it states its health floor.
    fragileBelow: withDefaults.fragileBelow,
    // A script's waiver travels with the script. Passing it from here rather than letting
    // the caller supply one is the point: the exception belongs to the errand that needs
    // it, not to whoever happened to invoke the errand today.
    unsafe: script.unsafe ?? null,
    // AND SO DOES ITS PIN, for exactly the same reason. The generation an errand was last
    // seen working against is a property of the errand, not of the invocation — and a
    // `provenance` block that sat on a script and was never forwarded would be the quietest
    // possible failure: declared, greppable, and doing nothing at all.
    provenance: script.provenance ?? null,
  });
}
