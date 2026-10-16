// m59-sharing.mjs — spare reagents go to the ally who needs them, by default.
//
// Operator, 2026-10-16: "dropping spare (planning to be sold) reagents off to allies (especially
// those running service desks) is a fully default action that doesn't require any special
// triggers. The flow should go straight from the first time Loial runs out of reagents to being
// fully supplied by anyone else in the map/area that doesn't need their reagents without requiring
// any intervention."
//
// THREE HALVES, and every one of them is on by default:
//
//   NEED    a keeper that hears "You don't have the reagents to cast <spell>!" (spell.kod:52) learns
//           that spell's reagents from the kod catalogue (m59-deskpractice.mjs spellCost) and
//           declares SHORTFALL_CASTS casts' worth as a need on the fleet board. Loial does not
//           have to be configured for anything: running out once is the trigger.
//   GIVE    every keeper, at a quiet moment, reads the board for needers in its room — and, for a
//           SERVICE character (a desk), the rooms around it — and hands over what it holds beyond
//           its own floor, its own needs, and everything its own sale plan protects. "Spare" means
//           what this character would otherwise sell.
//   ACCEPT  a fleetmate's offer made only of things this keeper currently needs is accepted without
//           any `acceptDonations` policy. Anything else is LEFT OPEN rather than cancelled: the
//           default path never refuses on another flow's behalf.
//
// THIS FILE IS PURE. It decides and explains; Autopilot.shareSpareReagents walks, offers and reads
// the pack back, and Autopilot.noteReagentRefusal / acceptNeededGift are the other two halves.
// m59-sharing-test.mjs pins it.

export const SHARE_DEFAULTS = Object.freeze({
  enabled: true,
  // How far a giver walks to a SERVICE needer. Ordinary needers are served only in the same room:
  // a farmer is not pulled off its station to top up another farmer's herbs.
  radius: 1,
  // At most this many of one kind per gift — a desk asks for ten casts, not the giver's whole pile.
  per_gift_cap: 20,
  // One look at the board per this long. The board itself is cached for 5s (m59-interest-store).
  every_ms: 45_000,
  // Who is worth a walk: 'service' (desks and posted casters), 'any', or 'none' (same room only).
  walk_for: 'service',
  // A giver never walks OUT of these rooms for a gift: leaving is itself the dangerous part.
  // Ukgoth (599) — the same reason m59-safelegs.mjs gives it its own crossing discipline.
  no_walk_from: Object.freeze([599]),
  // After a gift that moved nothing, or a walk that did not arrive, leave that needer alone this long.
  backoff_ms: 10 * 60_000,
});

/** How many casts of a spell a reagent refusal asks the fleet for. */
export const SHORTFALL_CASTS = 10;
/** How long a learned shortfall stands on the board unanswered before it is dropped. */
export const SHORTFALL_TTL_MS = 6 * 60 * 60_000;

/** The spell named in the server's reagent refusal, lower-cased, or null. */
export function reagentRefusalSpell(text) {
  const m = /you don['’]t have the reagents to cast\s+(.+?)\s*!?\s*$/i.exec(String(text ?? ''));
  return m ? m[1].trim().toLowerCase() : null;
}

/** Normalise a policy value: `false` switches sharing off, an object overrides the defaults. */
export function normalizeShare(policy) {
  if (policy === false) return { ...SHARE_DEFAULTS, enabled: false };
  if (!policy || typeof policy !== 'object') return { ...SHARE_DEFAULTS };
  return { ...SHARE_DEFAULTS, ...policy };
}

/**
 * The targets a reagent refusal adds: SHORTFALL_CASTS casts of every reagent the spell takes, kept
 * as the LARGER of what was already asked (two spells that both want emeralds keep the bigger ask).
 * `cost` is spellCost()'s `{ reagents: [[item, n], ...] }`.
 */
export function shortfallTargets(cost, existing = new Map(), { casts = SHORTFALL_CASTS, now = Date.now() } = {}) {
  const out = new Map(existing);
  for (const [item, n] of cost?.reagents ?? []) {
    const kind = String(item).toLowerCase();
    const want = Math.max(1, Number(n) || 1) * casts;
    const prev = out.get(kind);
    out.set(kind, { target: Math.max(prev?.target ?? 0, want), since: prev?.since ?? now });
  }
  return out;
}

const protectedKind = (kind, names = []) =>
  [].concat(names ?? []).some(n => String(n).toLowerCase() === String(kind).toLowerCase());

/**
 * Choose ONE gift: who, where, and how much of what.
 *
 *   demands   interest.demandsNear(..., { farmingOnly: false }) — `{agent, character, room, hops,
 *             service, needs: {kind: n}}`, nearest first
 *   have      {kind: count in this pack}
 *   keep      {kind: what this keeper keeps for itself — its floor plus its own declared need}
 *   protectedNames  this keeper's sale-protected names: what it never sells is not "spare"
 *   here      this keeper's room
 *   backoff   Map needer -> until (ms): needers recently failed are skipped
 *
 * Service needers first (a desk serves everybody), then nearest. A needer outside the walk rule is
 * served only if it is standing in this room.
 */
export function planGift({ demands = [], have = {}, keep = {}, protectedNames = [], here = null,
                           cfg = SHARE_DEFAULTS, backoff = new Map(), now = Date.now() } = {}) {
  const spareOf = kind => protectedKind(kind, protectedNames) ? 0
    : Math.max(0, (Number(have[kind]) || 0) - (Number(keep[kind]) || 0));
  const mayWalk = d => {
    if (d.room === here) return true;
    if (cfg.walk_for === 'none') return false;
    if ((cfg.no_walk_from ?? []).map(Number).includes(Number(here))) return false;
    if ((Number(d.hops) || 0) > (Number(cfg.radius) || 0)) return false;
    return cfg.walk_for === 'any' || (cfg.walk_for === 'service' && d.service === true);
  };
  const order = [...demands].sort((a, b) =>
    Number(!!b.service) - Number(!!a.service) || (Number(a.hops) || 0) - (Number(b.hops) || 0));
  const skipped = [];
  for (const d of order) {
    if ((backoff.get(d.agent) ?? 0) > now) { skipped.push({ agent: d.agent, why: 'backing off after a failed gift' }); continue; }
    if (!mayWalk(d)) { skipped.push({ agent: d.agent, why: 'not here, and not worth a walk' }); continue; }
    const give = {};
    for (const [kind, n] of Object.entries(d.needs ?? {})) {
      const amount = Math.min(Number(n) || 0, spareOf(kind), Number(cfg.per_gift_cap) || 0);
      if (amount > 0) give[kind] = amount;
    }
    if (!Object.keys(give).length) { skipped.push({ agent: d.agent, why: 'needs nothing this pack can spare' }); continue; }
    return { gift: { needer: d.agent, character: d.character, room: d.room, hops: Number(d.hops) || 0,
                     service: !!d.service, give, walk: d.room !== here }, skipped };
  }
  return { gift: null, skipped };
}
