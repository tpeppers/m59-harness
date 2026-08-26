// TACTICS CHANGE FASTER THAN CODE DOES, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
//
// Measured on one afternoon, 2026-08-19: the operator asked for player self-defence, then
// for chasing anywhere on the map, then for no chasing at all - three reversals inside two
// hours, each of them correct when it was made. Two of the three were shipped by EDITING
// `m59-autopilot.mjs` AND RESTARTING A BROKER THAT HOLDS TWENTY-ONE IRREPLACEABLE SESSIONS.
// That is the wrong cost for a decision somebody is entitled to change their mind about.
//
// So the tunables live in `substrate/tuning.json`, which is read live, validated, and layered
// over the profile. Editing it needs no restart and no code change: a human edits the file,
// or an agent runs `--set`, and the next `m59-profiles.mjs --apply` carries it.
//
// NOT TO BE CONFUSED WITH `m59-tactics.mjs`, which is the append-only LEDGER of which walker
// tactic fired and whether it worked. That one is evidence; this one is settings. The names
// are close enough that this file was once written straight over that one, which took the
// broker down - hence the note.
//
// FOUR PROPERTIES, EACH OF WHICH IS THE CHEAP MISTAKE - and they are deliberately the same
// four `m59-localpolicy.mjs` already argues for, because this is the same hazard wearing a
// different coat:
//
//   1. SILENCE MEANS THE PROFILE, NEVER AN EMPTY POLICY. An absent file, an empty one, or a
//      block this build has no name for all return the profile unchanged. Returning `{}`
//      would strip every flee threshold off a live fleet while looking like doing nothing.
//   2. A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE. It keeps the profile AND SAYS SO -
//      the operator who just edited it is the last person who would suspect their broken
//      JSON silently reverted the fleet.
//   3. AN UNUSABLE VALUE KEEPS THE PROFILE'S, never unsets it. `flee_below: 60` is somebody
//      typing a percentage; it must not become a threshold of 6000% and it must not quietly
//      remove the floor.
//   4. AN UNRECOGNISED KEY IS REPORTED, never applied and never dropped. A setting that
//      silently does nothing is how `purpose` stayed out of a schema for a year while every
//      keeper in the fleet ran with an audit switched off that everybody believed was on.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TUNING_FILE = () => process.env.M59_TUNING_FILE ??
  fileURLToPath(new URL('../substrate/tuning.json', import.meta.url));

// ---------------------------------------------------------------------------- the surface
//
// EVERY KEY HERE IS ONE SOMEBODY HAS ALREADY WANTED TO CHANGE MID-SESSION. `why` is printed
// by --explain, so the person flipping it can see what it costs without reading the keeper.
// `check` returns null for "unusable" - the value is then reported and the profile's kept.
const frac = v => (typeof v === 'number' && v > 0 && v <= 1) ? v : null;
const bool = v => (typeof v === 'boolean') ? v : null;
const posInt = v => (Number.isFinite(v) && v >= 0) ? Math.floor(v) : null;
const strList = v => (Array.isArray(v) && v.every(x => typeof x === 'string')) ? v.slice() : null;
const numList = v => (Array.isArray(v) && v.length && v.every(x => Number.isFinite(x))) ? v.slice() : null;

export const TUNABLES = {
  defend_against_players: { check: bool, why:
    'swing back at a flagged player who has attacked this fleet. Three interlocks still ' +
    'apply and are NOT settable: the grudge book, the live PF_KILLER/PF_OUTLAW flag, and ' +
    'our own PFLAG_SAFETY, which the server enforces' },
  defend_chase: { check: bool, why:
    'walk across the room to reach a flagged attacker instead of only swinging at what has ' +
    'already closed. Off is the original behaviour. On answers a group that hits and steps ' +
    'back out of melee reach; it also takes a character off its wall' },
  use_safe_spots: { check: bool, why:
    'fight from a wall the monsters cannot reach through. Turning this off gives up the ' +
    'largest survival advantage in the game and is almost never right' },
  flee_below: { check: frac, why:
    'the health fraction at which a character disengages. NOTE it is a FLOOR, not the ' +
    'answer: safety() takes Math.max(this, 2*maxHit/max), so on a 41-health character ' +
    'anything below about 0.68 is inert and the two-hits-of-margin rule wins' },
  rest_below: { check: frac, why: 'the health fraction at which it breaks off and rests' },
  hold_resume_above: { check: frac, why:
    'in a safe spot, top up to this fraction before swinging again. Stopping costs nothing ' +
    'there, so there is little reason to fight hurt' },
  fight_rounds: { check: posInt, why: 'rounds per engagement before it re-decides' },
  pull_within: { check: posInt, why:
    'how far it will walk to fetch a monster back to its wall. The default is eight because ' +
    'every extra step is more time exposed off the wall; zero explicitly removes the limit' },
  weapon_priority: { check: strList, why:
    'name fragments, best first. A PREFERENCE, not a filter - an unskilled weapon still ' +
    'beats bare hands. Rank by the character\'s own proficiency: a mace is worth far more ' +
    'to somebody with mace fighting 41 than a hammer they have no wielding skill for' },
  confine_rooms: { check: numList, why:
    'the rooms this character may be in AT ALL. Unlike assigned_room this is honoured by the ' +
    'SURVIVAL refuge, which is the largest hole in any confinement because it runs exactly ' +
    'when everything else has agreed to stay put - retreatToSafety walks rooms 38 and 39 to ' +
    'room 2, which is monster-free and NOT player-safe, and killed a character there twice in ' +
    'one evening. A refuge outside this list is refused and a local wall taken instead' },
  roam: { check: bool, why:
    'leave the assigned room looking for prey when it is cleared. Off is what keeps a ' +
    'confinement a confinement' },
  travel_hold_vigor: { check: posInt, why:
    'the vigor needed before it will stop mid-journey to heal at a wall. Default 80, the ' +
    'resting cap; at 100 it never fires for a fleet that cannot cook' },
  fight_above_vigor: { check: posInt, why:
    'the vigor floor for STARTING a fight. 100 is the lowest HONOURED value - fightFloor() ' +
    'is Math.max(MIN_FIGHT_VIGOR, ...), so anything lower reads as applied and changes nothing' },
  max_carry: { check: posInt, why: 'stacks before it wants a town trip' },
  bank_above: { check: posInt, why: 'purse before it walks to a bank. High means never' },
};

// ---------------------------------------------------------------------------- reading
const cache = { mtime: -1, value: null, path: null };

/** The raw file, plus how it was read. Never throws. */
export function loadTuning(file = TUNING_FILE()) {
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.path === file && cache.mtime === mtime) return cache.value;
  let value;
  if (!mtime) {
    value = { present: false, why: 'no tuning file - the profile stands as written',
              defaults: {}, profiles: {}, characters: {}, problems: [] };
  } else {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      value = { present: true, why: `read from ${file}`, problems: [],
                defaults: raw.defaults ?? {}, profiles: raw.profiles ?? {},
                characters: raw.characters ?? {}, raw };
    } catch (e) {
      // PROPERTY 2. Loud, and the profile is kept.
      value = { present: true, parsed: false,
                why: `tuning file will not parse (${e.message}) - KEEPING THE PROFILE ` +
                     'unchanged. This is not an empty tuning file',
                defaults: {}, profiles: {}, characters: {}, problems: [
                  { where: file, why: `not valid JSON: ${e.message}` }] };
    }
  }
  cache.path = file; cache.mtime = mtime; cache.value = value;
  return value;
}

/**
 * The overrides that apply to one character, already validated. Layered least specific
 * first, so a per-character line beats a per-profile one beats a global default.
 * Returns `{ overrides, problems, sources }` - never throws, never returns null.
 */
export function tuningFor({ profile = null, character = null, file = TUNING_FILE() } = {}) {
  const t = loadTuning(file);
  const problems = [...t.problems];
  const overrides = {}, sources = {};
  const layers = [
    ['defaults', t.defaults],
    [`profiles.${profile}`, profile ? (t.profiles?.[profile] ?? {}) : {}],
    [`characters.${character}`, character
      ? (t.characters?.[character] ?? t.characters?.[String(character).toLowerCase()] ?? {}) : {}],
  ];
  for (const [where, block] of layers) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [k, v] of Object.entries(block)) {
      const spec = TUNABLES[k];
      // PROPERTY 4. Reported, never applied, never dropped.
      if (!spec) {
        problems.push({ where: `${where}.${k}`, why:
          `not a tunable this build knows. Known: ${Object.keys(TUNABLES).join(', ')}` });
        continue;
      }
      const ok = spec.check(v);
      // PROPERTY 3. The profile's value is kept rather than being unset.
      if (ok === null) {
        problems.push({ where: `${where}.${k}`, why:
          `unusable value ${JSON.stringify(v)} - keeping the profile's, not unsetting it` });
        continue;
      }
      overrides[k] = ok; sources[k] = where;
    }
  }
  return { overrides, problems, sources, present: t.present, why: t.why };
}

// ---------------------------------------------------------------------------- writing
//
// `--set` exists so an agent can change tactics without hand-editing JSON and without
// getting the layering wrong. It validates BEFORE writing: a refused set leaves the file
// exactly as it was, because a half-applied tuning file is worse than an unchanged one.
export function setTuning({ key, value, character = null, profile = null,
                            file = TUNING_FILE() } = {}) {
  const spec = TUNABLES[key];
  if (!spec) return { ok: false, why: `no tunable called "${key}". Known: ${Object.keys(TUNABLES).join(', ')}` };
  const checked = spec.check(value);
  if (checked === null) return { ok: false, why: `unusable value for ${key}: ${JSON.stringify(value)}` };

  let raw = { defaults: {}, profiles: {}, characters: {} };
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { return { ok: false, why: `refusing to write over a tuning file that will not parse: ${e.message}` }; }
  }
  raw.defaults ??= {}; raw.profiles ??= {}; raw.characters ??= {};
  const where = character ? `characters.${character}` : profile ? `profiles.${profile}` : 'defaults';
  const bucket = character ? (raw.characters[character] ??= {})
               : profile   ? (raw.profiles[profile] ??= {})
               : raw.defaults;
  const before = bucket[key];
  bucket[key] = checked;
  raw.note = 'Tuning overlay for m59-profiles.mjs. Read live, no restart. ' +
             'Absent/empty/unparseable all mean "the profile stands as written".';
  writeFileSync(file, JSON.stringify(raw, null, 1));
  cache.mtime = -1;
  return { ok: true, where, key, from: before, to: checked, file };
}

export function unsetTuning({ key, character = null, profile = null, file = TUNING_FILE() } = {}) {
  if (!existsSync(file)) return { ok: false, why: 'no tuning file' };
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, why: `will not parse: ${e.message}` }; }
  const bucket = character ? raw.characters?.[character] : profile ? raw.profiles?.[profile] : raw.defaults;
  if (!bucket || !(key in bucket)) return { ok: false, why: `${key} is not set there` };
  delete bucket[key];
  writeFileSync(file, JSON.stringify(raw, null, 1));
  cache.mtime = -1;
  return { ok: true, key };
}

// ---------------------------------------------------------------------------- the CLI
const argv = process.argv.slice(2);
const has = f => argv.includes(`--${f}`);
const argOf = (f, d = null) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// "0.5" -> 0.5, "true" -> true, "mace,hammer" -> ['mace','hammer']
function parseValue(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.includes(',')) return s.split(',').map(x => x.trim()).filter(Boolean);
  const n = Number(s);
  if (s !== '' && Number.isFinite(n)) return n;
  return s;
}

function main() {
  const file = argOf('file', TUNING_FILE());
  const character = argOf('character', null);
  const profile = argOf('profile', null);

  if (has('explain')) {
    console.log(`tuning file: ${file}\n`);
    for (const [k, s] of Object.entries(TUNABLES)) console.log(`  ${k}\n      ${s.why}\n`);
    return;
  }
  if (has('set')) {
    const pair = argOf('set', '');
    const eq = pair.indexOf('=');
    if (eq < 0) { console.error('--set expects key=value'); process.exitCode = 1; return; }
    // A LIST-TYPED TUNABLE COULD NEVER BE SET FROM HERE, and it failed closed rather than
    // loudly: `parseValue` only builds a list when it sees a comma, and the parts it splits
    // out stay STRINGS, which `numList` rejects. So `--set confine_rooms=39` was refused as
    // an unusable value and `--set confine_rooms=39,40` was refused as well — the one
    // tunable that decides the rooms a character may be in AT ALL, unsettable by the tool
    // written so an agent would not have to hand-edit this file. Coerce here, where the key
    // is known and the intent is unambiguous; `parseValue` cannot know either.
    const key = pair.slice(0, eq);
    let value = parseValue(pair.slice(eq + 1));
    if (TUNABLES[key]?.check === numList) {
      const nums = (Array.isArray(value) ? value : [value]).map(Number);
      if (nums.length && nums.every(Number.isFinite)) value = nums;
    }
    const r = setTuning({ key, value, character, profile, file });
    console.log(r.ok ? `set ${r.where}.${r.key} = ${JSON.stringify(r.to)}` +
                       (r.from !== undefined ? ` (was ${JSON.stringify(r.from)})` : '')
                     : `REFUSED: ${r.why}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (has('unset')) {
    const r = unsetTuning({ key: argOf('unset', ''), character, profile, file });
    console.log(r.ok ? `unset ${r.key}` : `REFUSED: ${r.why}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  const t = loadTuning(file);
  console.log(`tuning file: ${file}`);
  console.log(`  ${t.why}\n`);
  const eff = tuningFor({ profile, character, file });
  const keys = Object.keys(eff.overrides);
  if (!keys.length) console.log('  no overrides in effect — the profile stands as written');
  for (const k of keys) console.log(`  ${k.padEnd(24)} = ${JSON.stringify(eff.overrides[k]).padEnd(12)} (${eff.sources[k]})`);
  if (eff.problems.length) {
    console.log('\nproblems — reported, never applied, never dropped:');
    for (const p of eff.problems) console.log(`  ! ${p.where}: ${p.why}`);
  }
  console.log('\n  --explain lists the surface   --set key=value   --character <name>   --profile <name>');
}

const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main();
