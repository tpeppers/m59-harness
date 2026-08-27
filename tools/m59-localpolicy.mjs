#!/usr/bin/env node
// THE NUMBERS THAT ARE THIS CHECKOUT'S OPINION, NOT THIS REPOSITORY'S.
//
//   node tools/m59-localpolicy.mjs              # what is overridden here, and what is not
//   node tools/m59-localpolicy.mjs --explain    # the same, with the mechanics behind each key
//   node tools/m59-localpolicy.mjs --example    # print a starter file to copy
//
// A committed default like `fight_above_vigor: 180` is two different claims wearing one
// coat. One is MECHANICS and belongs in git: resting stops awarding vigor at 80 of 200,
// so everything above that has to be eaten, and a floor over 80 is therefore a claim
// about the FOOD SUPPLY rather than about courage. The other is a BET this particular
// fleet is making on this particular server on this particular afternoon, and it does
// not survive being cloned by a stranger — their roster is smaller, their prey is
// different, and their apothecary is not ours.
//
// The two were the same literal, so tuning the bet meant editing a tracked file, and the
// history of this repository now carries an argument about a number that was only ever
// true here. Worse, it went the other way too: a value good for our fleet ships as advice
// to somebody whose fleet it will get killed.
//
// So: the committed default stays exactly as it was and remains what a fresh clone runs.
// This file lets THIS checkout say something different, in `substrate/policy.local.json`,
// which is gitignored. Nothing here is required. An absent file is not an empty policy —
// it is the committed behaviour, unchanged, which is the same rule loadouts and playbooks
// already follow and the only rule that makes an overlay safe to add.
//
// THE MECHANICS STAY HERE AND ARE NOT OVERRIDABLE. `REST_VIGOR_CAP` is not a preference;
// it is what `RestTimer` does. An override that contradicts a mechanic is not honoured
// quietly — it is reported, because a fleet configured to hold out for a vigor no amount
// of resting can deliver looks, on the board, exactly like a fleet that is working.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_POLICY_FILE = join(REPO, 'substrate', 'policy.local.json');

// ---------------------------------------------------------------------------
// MECHANICS. Facts about the game, with the source that settles each one. These are
// what the harness is entitled to be opinionated about, because they are not opinions.
// ---------------------------------------------------------------------------

// Vigor is out of 200 everywhere on the wire and in the client.
export const VIGOR_MAX = 200;

// RestTimer stops awarding vigor at 80. Sitting down longer buys nothing above it, so a
// floor above 80 is unreachable by any amount of resting and has to be EATEN to. This is
// the same number `REST_VIGOR_CAP` (0.4) expresses as a fraction in m59-autopilot.mjs.
export const REST_VIGOR_CAP = 80;

// The keeper's default when no tactical floor is supplied. Swinging costs about thirty
// vigor a minute and vigor sets how fast health comes back between fights, so the default
// is deliberately above the resting cap. An explicit `fight_above_vigor` is nevertheless
// authoritative: a bounded no-food farm may deliberately choose the reachable cap of 80.
export const MIN_FIGHT_VIGOR = 100;

// ---------------------------------------------------------------------------
// THE OVERRIDABLE SURFACE. A closed set, for the same reason the playbook verbs are:
// a typo must disable its own line and say so, never invent a key the fleet then runs on.
// ---------------------------------------------------------------------------

const KEYS = {
  fight_above_vigor: {
    type: 'number', min: 0, max: VIGOR_MAX,
    what: 'the vigor a character must have before it will START a fight',
    mechanics:
      `resting stops at ${REST_VIGOR_CAP} of ${VIGOR_MAX}, so anything above ` +
      `${REST_VIGOR_CAP} has to be eaten — a floor over the cap is a claim about the ` +
      `food supply, and with an empty larder the keeper falls back to what resting can ` +
      `deliver and counts it as a supply failure rather than idling for ever`,
    // This is not a refusal. Eating past the cap is the entire point of the `wellfed`
    // strategy, but an operator choosing a lower reachable floor is also a real order.
    warn: (v) => [
      v > REST_VIGOR_CAP &&
        `above the resting cap of ${REST_VIGOR_CAP}: reachable only by eating, so this ` +
        `is a bet on the food chain (create food costs 2 elderberry AND 2 herbs)`,
    ].filter(Boolean),
  },
  rest_below: {
    type: 'fraction',
    what: 'the health fraction at which a character breaks off and rests',
  },
  flee_below: {
    type: 'fraction',
    what: 'the health fraction at which a character disengages and runs',
  },
  max_carry: {
    type: 'number', min: 1, max: 100,
    what: 'how many STACKS the pack is allowed to reach before a town trip',
    mechanics: 'the pack holds about 14 stacks; 40 is unreachable, see sellInTown',
  },
  roam: {
    type: 'boolean',
    what: 'whether a character may leave its assigned room looking for prey',
    mechanics:
      'roaming is how characters end up in the twin room next door, which carries the ' +
      'same name and none of the prey',
  },
  use_safe_spots: {
    type: 'boolean',
    what: 'whether to hold a wall the monsters cannot reach through',
  },
  hold_resume_above: {
    type: 'fraction',
    what: 'the health fraction at which a character gives its safe spot back up',
  },
  max_threat_over: {
    type: 'number', min: 0, max: 200,
    what: 'legacy engagement band; recorded but no longer consulted',
    mechanics:
      'superseded by threat_ceiling, which is a PERCENTAGE of max health. Kept here ' +
      'only so a local file that still sets it is reported rather than silently ignored',
  },
  weapon_priority: {
    type: 'string[]',
    what: 'preference order for what to wield; a preference, not a filter',
  },
  strategy: {
    type: 'string',
    what: 'which STRATEGIES entry the keeper runs',
  },
};

export const OVERRIDABLE = Object.keys(KEYS);

// ---------------------------------------------------------------------------

function typeOk(spec, v) {
  switch (spec.type) {
    case 'number': return Number.isFinite(v) &&
      (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
    case 'fraction': return Number.isFinite(v) && v >= 0 && v <= 1;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string' && v.length > 0;
    case 'string[]': return Array.isArray(v) && v.every((s) => typeof s === 'string');
    default: return false;
  }
}

const expected = (spec) => spec.type === 'fraction' ? 'a fraction from 0 to 1'
  : spec.type === 'number' ? `a number from ${spec.min ?? 0} to ${spec.max ?? '∞'}`
  : spec.type === 'string[]' ? 'an array of strings'
  : `a ${spec.type}`;

// Cached on mtime, because the supervisor reads this every round and a stat() is the
// whole cost. Same arrangement as loadoutFor().
//
// KEYED BY PATH, and that is not defensive programming — a single-slot cache holding only
// (mtime, doc) returns the WRONG FILE's contents for any second file whose mtime lands in
// the same millisecond, which on a fast disk is most of them. The test suite caught it
// immediately by writing scratch files in a loop; a supervisor reading one path for ever
// would never have shown it, and the day somebody added a second policy file it would
// have served one fleet another fleet's floors.
const cache = new Map();

export function loadLocalPolicy(file = LOCAL_POLICY_FILE) {
  if (!existsSync(file)) { cache.delete(file); return null; }
  let mtime = -1;
  try { mtime = statSync(file).mtimeMs; } catch { /* raced with a write; re-read below */ }
  const hit = cache.get(file);
  if (hit && mtime === hit.mtime && mtime !== -1) return hit.doc;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY ONE. Returning {} here would silently
    // put the whole fleet back on the committed defaults, which is a real change of
    // behaviour dressed as no change at all — and the operator who just edited the file
    // is the last person who would suspect it.
    return { __error: `${file} will not parse: ${e.message}`, blocks: {} };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { __error: `${file} must contain a JSON object`, blocks: {} };
  }
  cache.set(file, { mtime, doc });
  return doc;
}

/**
 * Merge this checkout's opinion over a committed orders block.
 *
 * `committed` is returned UNTOUCHED when there is no local file, no block for this name,
 * or nothing in that block this build understands. Silence means the behaviour that was
 * already there — never an empty policy, and never paralysis.
 *
 * Returns { orders, applied, refused, warnings, source } and never throws: a bad local
 * file must not be able to stop a supervisor round, because the fleet it would stop
 * supervising is live.
 */
export function localise(block, committed, { file = LOCAL_POLICY_FILE, doc } = {}) {
  const out = {
    orders: committed, applied: [], refused: [], warnings: [], source: null,
  };
  const local = doc !== undefined ? doc : loadLocalPolicy(file);
  if (!local) return out;
  if (local.__error) { out.refused.push({ key: '*', why: local.__error }); return out; }

  const blocks = local.blocks && typeof local.blocks === 'object' ? local.blocks : local;
  const over = blocks[block];
  if (over === undefined) return out;
  if (!over || typeof over !== 'object' || Array.isArray(over)) {
    out.refused.push({ key: block, why: `block "${block}" must be a JSON object` });
    return out;
  }

  const orders = { ...committed };
  for (const [key, value] of Object.entries(over)) {
    const spec = KEYS[key];
    // AN UNRECOGNISED KEY IS REPORTED, NEVER APPLIED AND NEVER DROPPED. A typo that
    // silently does nothing is the failure this whole file is meant to stop happening
    // again — `purpose` was missing from a schema for a year and every keeper in the
    // fleet ran with an audit switched off that everyone believed was on.
    if (!spec) {
      out.refused.push({
        key, why: `not an overridable setting; known keys are ${OVERRIDABLE.join(', ')}`,
      });
      continue;
    }
    if (!typeOk(spec, value)) {
      // The committed value is KEPT. Falling back to the default is the safe direction;
      // falling back to "unset" would mean an unusable number silently removing a floor.
      out.refused.push({
        key, why: `${JSON.stringify(value)} is not ${expected(spec)} — keeping the ` +
                  `committed ${JSON.stringify(committed[key])}`,
      });
      continue;
    }
    for (const why of spec.warn?.(value) ?? []) out.warnings.push({ key, value, why });
    if (committed[key] !== undefined && committed[key] === value) {
      // Not applied, because nothing changed — worth distinguishing so `--explain` can
      // show an override that has quietly become a no-op after a default moved.
      out.applied.push({ key, from: committed[key], to: value, same: true });
    } else {
      out.applied.push({ key, from: committed[key], to: value, same: false });
    }
    orders[key] = value;
  }
  out.orders = orders;
  out.source = file;
  return out;
}

/** Every block name a local file defines, for reporting. */
export function localBlocks(file = LOCAL_POLICY_FILE) {
  const doc = loadLocalPolicy(file);
  if (!doc || doc.__error) return [];
  const blocks = doc.blocks && typeof doc.blocks === 'object' ? doc.blocks : doc;
  return Object.keys(blocks).filter((k) => k !== '__error' && k !== 'note');
}

export const EXAMPLE = {
  note: 'This checkout\'s opinions. Gitignored. See tools/m59-localpolicy.mjs.',
  blocks: {
    valley_orders: {
      fight_above_vigor: 180,
      rest_below: 0.75,
    },
    lowland_orders: {
      fight_above_vigor: 140,
    },
  },
};

// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const argv = process.argv.slice(2);
  if (argv.includes('--example')) {
    console.log(JSON.stringify(EXAMPLE, null, 2));
  } else {
    const doc = loadLocalPolicy();
    console.log(`local policy file: ${LOCAL_POLICY_FILE}`);
    if (!doc) {
      console.log('  absent — every committed default is in force, unchanged.');
      console.log('  `--example` prints a starter file.');
    } else if (doc.__error) {
      console.log(`  UNUSABLE: ${doc.__error}`);
      console.log('  every committed default is in force; nothing here is being applied.');
    } else {
      const blocks = localBlocks();
      console.log(`  ${blocks.length} block(s): ${blocks.join(', ') || '(none)'}`);
      for (const b of blocks) {
        const r = localise(b, {});
        console.log(`\n  [${b}]`);
        for (const a of r.applied) console.log(`    ${a.key} = ${JSON.stringify(a.to)}`);
        for (const w of r.warnings) console.log(`    ! ${w.key}: ${w.why}`);
        for (const x of r.refused) console.log(`    REFUSED ${x.key}: ${x.why}`);
      }
    }
    if (argv.includes('--explain')) {
      console.log('\nthe overridable surface, and the mechanics behind each:');
      for (const [k, s] of Object.entries(KEYS)) {
        console.log(`\n  ${k} — ${s.what}`);
        if (s.mechanics) console.log(`      ${s.mechanics}`);
      }
      console.log(`\nnot overridable, because they are not opinions:`);
      console.log(`  VIGOR_MAX=${VIGOR_MAX}  REST_VIGOR_CAP=${REST_VIGOR_CAP}  ` +
                  `MIN_FIGHT_VIGOR=${MIN_FIGHT_VIGOR}`);
    }
  }
}
