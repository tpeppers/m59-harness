#!/usr/bin/env node
// IS THIS ORDER ADDRESSED TO THIS KEEPER — AND IF NOT, WHICH PART IS WRONG.
//
// A keeper refuses any write that is not addressed to its exact agent/character/PID tuple.
// That refusal is load-bearing: it is what stops a broker that has lost a port from
// commanding whoever happens to answer on it. But the refusal could fail for FOUR distinct
// reasons and reported only ONE of them, so three of the four printed a sentence that says
// nothing at all:
//
//     could not cancel the journey: this keeper is "t14", not "t14"
//
// Both names are "t14" because the AGENT matched and the PID did not. Observed on prod
// 2026-09-13 during a fleet move, on every character, where it meant journeys silently were
// not cancelled — `refuseMisaddressed` was handed `identity.agent` and printed it against our
// own agent, which are equal in exactly the cases the reader most needs distinguished.
//
// m59-keeperaddress-test.mjs already documents the cost of this shape from the other end: a
// caller that omits one part gets a refusal that reads as the QUESTION failing rather than the
// ADDRESS failing. `routeTrapAhead` omitted the agent, the 409 surfaced as "router gave no
// hops", and two sessions went looking at the routing table. That test lints the call sites;
// this module makes the refusal itself say what is actually wrong.
//
// IT LIVES HERE RATHER THAN IN THE KEEPER because the keeper starts a server on import — no
// main guard — so a predicate defined inside it cannot be tested without opening a socket.
// Same reason `readHealth` was lifted out of rideTrack: move the logic to where it can be
// asked a question, rather than building a harness to reach it where it sits.

/** A part counts as supplied when it is neither absent nor empty. Zero is a real PID-shaped value. */
export const presentIdentityPart = value => value !== undefined && value !== null && value !== '';

/**
 * Characters are compared case- and width-insensitively: the same name can arrive NFC or NFKC
 * depending on who serialized it, and "Loial the Ogier" must not fail to match itself.
 */
export const normalizedKeeperCharacter = value => typeof value === 'string'
  ? value.normalize('NFKC').trim().toLocaleLowerCase('en-US') : null;

/**
 * WHY an order is not ours, or null when it IS ours.
 *
 * `claimed` is what the caller asserts; `us` is this keeper. Returns `{ part, ours, theirs }`
 * where `part` is one of 'unaddressed' | 'incomplete' | 'agent' | 'character' | 'keeper_pid'.
 * The order of the checks is deliberate and unchanged from the original: a caller that gets
 * the agent wrong should hear about the agent, not about the PID that is wrong as a result.
 */
export function addressMismatch(claimed, us, { required = true } = {}) {
  const parts = [claimed?.agent, claimed?.character, claimed?.keeperPid];
  if (!parts.some(presentIdentityPart))
    return required ? { part: 'unaddressed', ours: us?.agent ?? null, theirs: null } : null;
  if (!parts.every(presentIdentityPart)) {
    const missing = ['agent', 'character', 'keeperPid']
      .filter((_, i) => !presentIdentityPart(parts[i]));
    return { part: 'incomplete', ours: us?.agent ?? null, theirs: null, missing };
  }
  if (String(claimed.agent) !== String(us?.agent))
    return { part: 'agent', ours: us?.agent ?? null, theirs: claimed.agent };
  if (normalizedKeeperCharacter(claimed.character) !== normalizedKeeperCharacter(us?.character))
    return { part: 'character', ours: us?.character ?? null, theirs: claimed.character };
  if (Number(claimed.keeperPid) !== Number(us?.keeperPid))
    return { part: 'keeper_pid', ours: us?.keeperPid ?? null, theirs: claimed.keeperPid };
  return null;
}

/** The original boolean, unchanged in meaning. */
export const isAddressedTo = (claimed, us, opts) => addressMismatch(claimed, us, opts) === null;

/**
 * The sentence a human reads. It NAMES THE PART, because the whole defect was a message that
 * could not tell the reader which of four things had gone wrong.
 */
export function describeMismatch(mismatch) {
  if (!mismatch) return 'addressed to this keeper';
  const { part, ours, theirs, missing } = mismatch;
  switch (part) {
    case 'unaddressed':
      return `this order carries no keeper identity; writes to "${ours}" must name agent, character and keeper_pid`;
    case 'incomplete':
      return `this order is addressed to "${ours}" but omits ${missing.join(' and ')}; ` +
             `all of agent, character and keeper_pid are required`;
    case 'agent':
      return `this keeper is agent "${ours}", not "${theirs}"`;
    case 'character':
      return `this keeper holds character "${ours}", not "${theirs}" (the agent name matches, ` +
             `so this is the right port for the wrong character)`;
    case 'keeper_pid':
      // THE ONE THE OLD MESSAGE HID. Agent and character both matched; only the PID did not,
      // which means the caller is addressing a keeper that has since been restarted.
      return `this keeper is pid ${ours}, not ${theirs} — the order is addressed to a keeper ` +
             `process that has been replaced (agent and character both match)`;
    default:
      return `this order is not addressed to this keeper (${part})`;
  }
}
