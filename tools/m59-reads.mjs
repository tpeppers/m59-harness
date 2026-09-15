#!/usr/bin/env node
// #unreliable — THE READS THAT LIE, AND THE CHECK THAT CATCHES EACH ONE.
//
//   node tools/m59-reads.mjs            list every known-unreliable read and its incident
//
// Every accessor in this file replaces one that gave a CONFIDENT WRONG ANSWER during the boss
// raid of 2026-09-11/12. None of them errored. That is the whole point: a read that throws is
// a bug you fix in a minute, and a read that answers about nothing is a bug you report to the
// operator as a finding.
//
// THE RULE THEY ALL FOLLOW, in three parts:
//
//   1. THREE VALUES, NEVER TWO. true / false / null, and null means "I could not look". A
//      coerced null is how you get confident wrong answers in BOTH directions: `inEffect` for
//      a weapon coerced to false re-casts and burns reagents every pass, coerced to true walks
//      a fleet at a boss unarmed.
//   2. AN UNKNOWN CARRIES ITS OWN CAUSE, never a borrowed one. An unknown that misattributes
//      itself is worse than one with no reason, because it sends the reader to a fix that
//      cannot work.
//   3. ASSERT THE SHAPE AT THE BOUNDARY. Neither of the two worst bugs was an empty result —
//      both were wrongly TYPED results that formatted perfectly. `String(undefined)` succeeds.
//      So an accessor says which shape it expects and refuses one it does not recognise.
//
// Each entry below carries `unreliable`: what the naive read is, what it answered, and what it
// cost. They are marked so that `node tools/m59-reads.mjs` can print the list — a hazard
// nobody can enumerate is one that gets rediscovered.
import { call } from './m59-fleetscript.mjs';

export const UNRELIABLE = Object.freeze([
  {
    read: 'spells / abilities',
    naive: "call('spells', {agent}) right after granting or learning one",
    lied: 'answered false for a spell the character HAD. Ability levels are PUSHED by the ' +
          'server, so a client-side list is whatever arrived last — it read "4 of 21 know ' +
          'enchant weapon" immediately after a grant and "21 of 21" a minute later.',
    cost: 'three separate wrong conclusions in one session, including "spell-granting is not ' +
          'the shortcut" — which was false, and cost an hour of building a different one.',
    check: 're-read after a settle, and treat a single false as UNKNOWN rather than no',
  },
  {
    read: 'status.wielding',
    naive: 'status(agent).wielding',
    lied: 'THE FIELD DOES NOT EXIST. status carries `equipment: ["long sword"]`; `wielding` is ' +
          'on the FLEET row. String(undefined) is "undefined", which matched no item in any ' +
          'pack, so every raider looked mundane.',
    cost: 'the arming gate passed the whole fleet for the wrong reason, silently, in a commit ' +
          'whose message was about verifying things properly.',
    check: 'read equipment[] for self and the fleet row for others; never mix them',
  },
  {
    read: 'equipment[] as an identity',
    naive: 'matching a pack item by the wielded NAME',
    lied: 'names are not unique. Two "long sword"s, one dedicated and one not, are ' +
          'indistinguishable — equipment() carries no object id.',
    cost: 'a raider went in swinging the mundane twin of the sword we had just enchanted, and ' +
          'the ghost "laughed off your pitiful blow".',
    check: 'ambiguity is UNKNOWN, not false. One match answers; two answer null',
  },
  {
    read: 'object ids',
    naive: 'storing an id between steps',
    lied: 'ids recycle within hours. 7605 stopped being one character\'s scimitar and became ' +
          "another's short sword mid-session; 7397 became a Lupogg.",
    cost: 'a ground-truth check that read the wrong object and reported the wrong weapon state.',
    check: 're-resolve at the moment of use and re-validate the class before trusting it',
  },
  {
    read: "the cast tool's own reply",
    naive: 'reply.mana_spent / reply.cast',
    lied: 'the broker reads vitals before the server has processed the cast — it reported ' +
          'mana_spent 0 for a cast that spent 17, and cast:true for casts that fizzled.',
    cost: 'three reported enchantments, zero enchanted weapons, and a raid that set out at a ' +
          'boss resisting mundane weapons 90% believing it was armed.',
    check: 'castVerified: listen first, wait out the spell\'s own trance, classify the SENTENCE',
  },
  {
    read: "the fight tool's own reply",
    naive: "act('fight', ...) returning ok",
    lied: 'returns ok and a full combat transcript while doing nothing. It runs in the BROKER ' +
          'against a snapshot, so a keeper-backed character trips stale_identity after one ' +
          'round — and its approach, which is the part that matters, never runs.',
    cost: 'seventeen raiders "completed the action phase" against a boss on 233 of 233.',
    check: 'close and swing in a loop, and read the boss\'s health, not the reply',
  },
  {
    read: 'a tool reporting its own plan',
    naive: 'printing what was asked for as if it happened',
    lied: 'm59-clearroom printed "removed: TuskedSkeleton x8" twice having removed nothing, ' +
          'because `delete object` is not an admin command and the no-op was never checked.',
    cost: 'two raids fought an escort I believed I had deleted, and I blamed the generator.',
    check: 're-read the world afterwards and report what it says, not what was intended',
  },
]);

// ---------------------------------------------------------------------------------------
// The accessors. Each returns { value, why } with value true/false/null, or a named shape.
// ---------------------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Does this character know the spell? #unreliable — abilities are PUSHED.
 * A single `false` is not an answer, so a false is re-read once after a settle before it is
 * believed; still false after that is a real no.
 */
export async function knowsSpell(agent, name, { settleMs = 4000 } = {}) {
  const want = String(name).toLowerCase();
  const ask = async () => {
    const sp = await call('spells', { agent }, 30_000).catch(() => null);
    if (!sp || !Array.isArray(sp.spells)) return null;           // could not look
    return sp.spells.some(x => String(x.name ?? '').toLowerCase() === want);
  };
  const first = await ask();
  if (first !== false) return { value: first, why: first === null ? 'no spell list came back' : 'listed' };
  await sleep(settleMs);
  const second = await ask();
  return second === true
    ? { value: true, why: 'listed on the second read — the first was a stale pushed list' }
    : { value: second, why: second === null ? 'no spell list came back' : 'absent from two reads' };
}

/**
 * What is actually in this character's hand? #unreliable — `status` has no `wielding`, and a
 * NAME is not an identity when the pack holds two of them.
 *
 * Returns { name, id, why } where `id` is null when the name is ambiguous — deliberately, so a
 * caller cannot accidentally act on the wrong one of two same-named weapons.
 */
export async function wielded(agent, { fleetRow = null } = {}) {
  const st = await call('status', { agent, brief: false }, 40_000).catch(() => null);
  if (!st) return { name: null, id: null, why: 'status did not answer' };
  // SHAPE ASSERTION. If `equipment` is not an array this is not the status shape we know, and
  // guessing which other shape it is has already cost a session.
  if (!Array.isArray(st.equipment))
    return { name: null, id: null, why: `status.equipment is ${typeof st.equipment}, not an array — unknown shape` };
  const name = fleetRow?.wielding
    ?? st.equipment.find(e => !/shield|helm|armor|armour|ring|amulet|cloak/i.test(String(e)))
    ?? null;
  if (!name) return { name: null, id: null, why: 'nothing wielded' };
  const inv = await call('inventory', { agent }, 40_000).catch(() => null);
  const same = (inv?.items ?? []).filter(i => String(i.name).toLowerCase() === String(name).toLowerCase());
  if (same.length === 1) return { name, id: same[0].id, why: 'one of that name in the pack' };
  return { name, id: null,
           why: same.length === 0 ? 'wielded name is not in the pack'
                                  : `${same.length} items share that name — the name cannot say which is in hand` };
}

/**
 * The target to use for a self-cast. #unreliable — `status.you` is null and no status field
 * carries the self object id, so an id-based self-target silently passes nothing.
 */
export async function selfTarget(agent) {
  const st = await call('status', { agent, brief: false }, 40_000).catch(() => null);
  const name = st?.character ?? null;
  return { value: name, why: name ? 'the character name; status.you is null' : 'status did not answer' };
}

/**
 * Re-validate an id before acting on it. #unreliable — ids recycle within hours.
 * Loopback only; answers null off it rather than pretending.
 */
export async function stillIs(id, expectedClass) {
  let dm = null;
  try {
    const mod = await import('./m59-dm.mjs');
    if (mod.isLoopbackHost?.(process.env.M59_HOST ?? '127.0.0.1')) dm = mod;
  } catch { /* not available */ }
  if (!dm) return { value: null, why: 'no maintenance socket — an id cannot be revalidated here' };
  const out = String(await dm.dm([`show object ${id}`]));
  const cls = (out.match(/OBJECT \d+ is CLASS (\w+)/) ?? [])[1] ?? null;
  if (!cls) return { value: null, why: `object ${id} did not report a class` };
  return { value: cls.toLowerCase() === String(expectedClass).toLowerCase(),
           why: `object ${id} is a ${cls}` };
}

if (process.argv[1] && process.argv[1].endsWith('m59-reads.mjs')) {
  console.log('#unreliable — reads that answered confidently about nothing\n');
  for (const u of UNRELIABLE) {
    console.log(`  ${u.read}`);
    console.log(`    naive:  ${u.naive}`);
    console.log(`    lied:   ${u.lied.replace(/\s+/g, ' ')}`);
    console.log(`    cost:   ${u.cost.replace(/\s+/g, ' ')}`);
    console.log(`    check:  ${u.check}\n`);
  }
  console.log(`${UNRELIABLE.length} known-unreliable reads. None of them errored.`);
}
