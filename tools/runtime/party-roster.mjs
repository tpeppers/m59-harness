// Validate and install Autopilot partner relationships for one selected runtime cohort.
//
// The legacy broker rebuilds m59-party's in-memory register when it resumes keepers.
// A shared-process runtime must do the same, but only for actors it actually owns: pairing
// a selected actor with an omitted one creates a relationship whose other half can never
// report. Build the complete plan before mutating the register so a bad roster cannot
// leave a half-installed set of relationships behind.

import * as defaultParty from '../m59-party.mjs';

function partnerOf(entry) {
  const value = entry?.autopilot?.policy?.partner;
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`actor ${entry?.id ?? '<unknown>'} has an invalid partner id`);
  return value.trim();
}

export function configuredPartyPlan(entries) {
  if (!Array.isArray(entries)) throw new TypeError('configuredPartyPlan requires actor entries');

  const byId = new Map();
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id) throw new Error('every selected party actor needs an id');
    if (byId.has(id)) throw new Error(`selected party actor id ${id} is duplicated`);
    byId.set(id, entry);
  }

  const requested = new Map();
  for (const [id, entry] of byId) {
    const partner = partnerOf(entry);
    if (!partner) continue;
    if (partner === id) throw new Error(`actor ${id} cannot partner with itself`);
    if (!byId.has(partner))
      throw new Error(`actor ${id} requests partner ${partner}, which is not selected`);
    requested.set(id, partner);
  }

  const claimed = new Map();
  const pairs = [];
  for (const [id, partner] of requested) {
    const reverse = requested.get(partner);
    if (reverse && reverse !== id) {
      throw new Error(
        `conflicting partner configuration: ${id} requests ${partner}, ` +
        `but ${partner} requests ${reverse}`,
      );
    }
    const priorForId = claimed.get(id);
    const priorForPartner = claimed.get(partner);
    if ((priorForId && priorForId !== partner) || (priorForPartner && priorForPartner !== id)) {
      const occupied = priorForId ? id : partner;
      const prior = priorForId ?? priorForPartner;
      throw new Error(
        `conflicting partner configuration: ${occupied} is requested by both ${prior} ` +
        `and ${priorForId ? partner : id}`,
      );
    }
    claimed.set(id, partner);
    claimed.set(partner, id);
    if (!pairs.some(([a, b]) => (a === id && b === partner) || (a === partner && b === id)))
      pairs.push(Object.freeze([id, partner]));
  }

  return Object.freeze({
    actorIds: Object.freeze([...byId.keys()]),
    pairs: Object.freeze(pairs),
  });
}

export function installConfiguredParties(entries, party = defaultParty) {
  if (typeof party?.pair !== 'function' || typeof party?.unpair !== 'function')
    throw new TypeError('party register must provide pair() and unpair()');
  const plan = configuredPartyPlan(entries);
  // Validation above is deliberately complete before the first register mutation.
  for (const id of plan.actorIds) party.unpair(id);
  for (const [left, right] of plan.pairs) party.pair(left, right);
  return plan;
}
