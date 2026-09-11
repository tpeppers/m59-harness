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
