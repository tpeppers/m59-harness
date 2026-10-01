// A KEEPER WHOSE ATTRIBUTE BLOCK HAS GONE MISSING ASKS FOR IT AGAIN.
//
// Stat group 2 -- might, intellect, stamina, agility, mysticism, aim, and karma -- is sent only in
// reply to a request naming that group (user.kod:2679-2692). Session.join asks on every login and
// the keeper asks once more 1.5s after joining. Nothing asks after that.
//
// Measured on prod, 2026-10-01: t9 (Camilla) lost it mid-session TWICE in six hours. Her keeper's
// status read `attributes: {}` / intellect 0 and no karma, and every qor-drill run refused with
// "karma ?" until a keeper restart re-logged her in. The cause is not established. Every login asks
// for the group, so it is not simply a reconnect; a login read cut off partway, or an update
// that clears the values, are both possible. So this does two things: it heals (one packet, at most
// once a minute, only while the block is incomplete), and it LOGS WHAT THE BLOCK LOOKED LIKE WHEN IT
// WAS FOUND WRONG, including when each stat was last observed, which is the evidence the next
// session needs to find the cause.
//
// "Incomplete" is deliberately narrow, so a healthy keeper never sends anything:
//   * no karma stat at all (karma can legitimately be 0, so its VALUE is never judged);
//   * intellect missing, or 0 -- every character is created with at least 1 in every attribute,
//     so 0 is not a value, it is an absence the reader filled in.

// MEASURED ON -20, 2026-10-01: every drop is the WHOLE block, and every one follows a fresh LOGIN
// inside the keeper (a relog, not a restart: t10 logged in five times in three hours, each with a
// different `joined` time and every attribute null). Session.joinOnce asks for group 2 on every
// login, and yet the block is absent afterwards while the re-ask a minute later lands. So the check
// runs every ATTR_HEAL_TICK_MS, and right after a login it re-asks on that tick for
// ATTR_HEAL_FAST_FOR_MS; after that, at most once a minute.
export const ATTR_HEAL_TICK_MS = 10_000;
export const ATTR_HEAL_FAST_FOR_MS = 120_000;
export const ATTR_HEAL_EVERY_MS = 60_000;

/** Is a re-ask due now? Fast right after a login, then once a minute. */
export function attrHealDue({ now, loggedInAt = null, lastAskAt = 0 }) {
  const fresh = Number.isFinite(loggedInAt) && now - loggedInAt < ATTR_HEAL_FAST_FOR_MS;
  return now - lastAskAt >= (fresh ? ATTR_HEAL_TICK_MS : ATTR_HEAL_EVERY_MS);
}

/** The client's recently DROPPED stat messages (M59Client.check): did the reply arrive and fail to parse? */
export const droppedStatMessages = (client, limit = 3) =>
  (client?.parseErrors ?? []).filter(e => /^STAT/.test(String(e?.what ?? ''))).slice(-limit)
    .map(e => ({ what: e.what, why: e.why, at: e.at ? new Date(e.at).toISOString() : null }));

const statOf = (statsById, k) => statsById?.get?.(k) ?? statsById?.get?.(k[0].toUpperCase() + k.slice(1)) ?? null;

/** null when the block is fine; otherwise a short reason and a snapshot for the log. */
export function attributesIncomplete(statsById) {
  if (!statsById?.get) return null;
  const karma = statOf(statsById, 'karma'), intel = statOf(statsById, 'intellect');
  const why = [];
  if (!karma) why.push('karma missing');
  if (!intel) why.push('intellect missing');
  else if (!(Number(intel.value) > 0)) why.push(`intellect ${intel.value}`);
  if (!why.length) return null;
  const snap = {};
  for (const k of ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim', 'karma']) {
    const s = statOf(statsById, k);
    snap[k] = s ? { value: s.value ?? null, observed_at: s.observed_at ?? null } : null;
  }
  return { why: why.join(', '), snapshot: snap };
}
