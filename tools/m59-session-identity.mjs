// WHICH OBJECT ID IS THIS SESSION'S CHARACTER — the one question, asked in one place.
//
// This is a safety boundary, not a convenience. `prod` is a shared server with real players
// on it, and an invitation, an exile and a promotion are all addressed to somebody. Every
// guild action therefore decides "is this one of ours?" by OBJECT ID against this broker's
// own live sessions, never by name: names are chosen by their owners and two can be made
// confusingly alike, whereas the object id of a live session is the server's own answer.
//
// WHAT IT COST TO HAVE THE RULE IN TWO PLACES AND ONLY ONE OF THEM RIGHT, 2026-09-10.
//
// The broker reads this two ways. `liveSessionIdentity` asks `client.selfId`; the whole guild
// tool asks `client.me.id`. For an in-process Session both exist and agree. For a KEEPER
// PROXY — which is every character on this fleet since the session driver moved into the
// keeper processes — `client.me` was built as `{ name }` and nothing else
// (m59-broker.mjs, `get me()`), so `me.id` was `undefined` for all twenty-three of them while
// `selfId` was correct and `/health` published the right ids the whole time.
//
// So `oursById` was EMPTY, and the guild tool could not see a single one of its own
// characters. `guild action=spread` answered `in_guild: 0 of 23` and listed Fozzie and Gonzo
// among the characters still out — moments after `guild action=status` had read a fresh
// roster naming them both as members, one of them the MASTER. It found zero inviters inside
// a guild it had just read. `induct` and `promote` read the same field and were blind in the
// same way, which is the whole of `spread-guild.mjs`.
//
// It failed the way everything in this game fails: in silence, with a plausible number. The
// symptom was written down the same day as "its membership read went stale across a broker
// restart" (spread-guild.mjs, notes) — and that is neither stale nor about a restart. The
// roster read is fresh and correct; the intersection with our own sessions is what fails. A
// wrong diagnosis about a silent failure is worse than none, because it gets reasoned from.
//
// Hence a pure function with a test rather than a third copy of the rule: a decision that
// cannot be asked a question offline is how a keeper hold went on being a no-op for as long
// as it did.

// AN ID IS AN ID ONLY IF IT COULD BE ONE. `selfId` is `s.you ? (s.you.id ?? -1) : null` on a
// keeper proxy, so `-1` is its way of saying "in game, but I do not know who I am yet" — and
// `0`, `null` and `undefined` all mean nothing at all. None of them may ever end up as a key
// in a map that decides who is safe to invite, because a lookup that matches on a junk id
// matches a stranger. Positive safe integers only.
export const isObjectId = id => Number.isSafeInteger(id) && id > 0;

// The character's object id, or null. `me.id` first because that is the in-process Session's
// own answer and the richer object; `selfId` second because it is the only one a keeper proxy
// has. Reading both is the point — either source alone has been wrong for a whole fleet.
export function sessionObjectId(client) {
  if (!client) return null;
  const fromMe = client.me?.id;
  if (isObjectId(fromMe)) return fromMe;
  const fromSelf = client.selfId;
  if (isObjectId(fromSelf)) return fromSelf;
  return null;
}

// IN GAME IS PART OF THE ANSWER. A Session that is still joining has no character to address
// and must not look like one: a configured credential mid-login is exactly the thing that
// should not appear in a list of characters this broker is driving.
export const sessionIsLive = client => client?.state === 'game';

// EVERY CHARACTER THIS BROKER IS DRIVING, KEYED BY THE ID THE SERVER GAVE IT.
//
// Built fresh on every call by its callers, never cached, because a rejoin changes the id and
// a stale map could carry one that now belongs to somebody else entirely.
export function ourSessionsById(sessions) {
  const out = new Map();
  for (const [agent, session] of sessions) {
    const client = session?.client;
    if (!sessionIsLive(client)) continue;
    const id = sessionObjectId(client);
    if (id !== null) out.set(id, { agent, session });
  }
  return out;
}


// A SNAPSHOT THAT FORGOT WHO YOU ARE IS NOT A CHARACTER THAT LEFT.
//
// The id above resolves from the keeper's state snapshot (`you.id`). Snapshots sometimes land
// WITHOUT `you` — and when one does, every reader concludes the session has no character:
// `/health` drops the agent out of session_object_ids, `ourSessionsById` stops seeing it, and
// anything gating on "is this agent in game" gets a false negative.
//
// MEASURED 2026-09-11 on a healthy fleet: 150 samples at 2s, TEN of twenty-two agents dropped
// and returned, twenty-four transitions in five minutes, always in pairs two to three seconds
// apart. Asked directly, the keepers had never moved — t9 "left and rejoined" three times
// while its connection sat at revision 1 with the same pid and uptime running straight
// through. Not one of the twenty-four happened.
//
// THE CONNECTION REVISION IS THE RIGHT KEY, and it is the only one. An object id changes when
// a character genuinely rejoins, and a genuine rejoin is exactly what moves
// `connection_revision` — so holding the last known id while that counter is unchanged is not
// a guess, it is the statement "nothing has happened that could have changed this". The
// moment the counter moves the cache is worthless and is dropped, because THAT is when the id
// really is different and serving the old one would address a character that no longer exists
// under that number. On a shared server that is the mistake that matters.
//
// An UNKNOWN revision is treated as a rejoin, not as a match. A snapshot too degraded to say
// which connection it describes cannot vouch for an id either.
export function rememberObjectId(cache, observed = {}) {
  const id = observed.id;
  const revision = observed.revision;
  const known = revision !== null && revision !== undefined;

  if (isObjectId(id))
    return { id, cache: known ? { id, revision } : null, remembered: false };

  // No id in this snapshot. The cache stands only if we can prove the connection is the same
  // one it was taken from.
  if (cache && known && cache.revision === revision && isObjectId(cache.id))
    return { id: cache.id, cache, remembered: true };

  return { id: null, cache: null, remembered: false };
}
