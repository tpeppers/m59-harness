#!/usr/bin/env node
// WHO IS LOGGED IN RIGHT NOW, ASKED THE SAME WAY ON BOTH SIDES OF THE KEEPER SPLIT.
//
//   imported by m59-broker.mjs (the `who` tool) and m59-keeper-process.mjs (`/action who`)
//
// The `who` tool used to call `c.players()` on whatever `s.need()` returned. On a keeper-backed
// character -- every character on prod -- that is KeeperProxy's emulated client, a picture
// rebuilt from the keeper's /state snapshot with no wire, so the tool answered
// `error: c.players is not a function` and the one question the operator needed answered on
// 2026-10-03 ("is Morpheus online right now?") had no answer. The socket is in the keeper, so
// the request has to be made there; this module is the one implementation both the keeper's
// `who` op and the broker's in-process path run, so the reply has ONE shape whichever side
// produced it.
//
// READ-ONLY, AND THAT IS PART OF THE CONTRACT. The only packet this sends is BP_SEND_PLAYERS
// (`c.players()`, m59-client.mjs). It never says, tells or sends anything to anybody -- the
// keeper's `say` case also refreshes the list, but only on its way to a tell, and asking who is
// online must never be the first half of speaking to them. m59-who-test.mjs pins it.
//
// FRESHNESS IS REPORTED, NOT ASSUMED. `playersOnline` is also maintained incrementally by
// BP_PLAYER_ADD / BP_PLAYER_REMOVE, so a reply that did not arrive in time still leaves a
// usable list -- but a usable list is not a fresh one. `refreshed` says whether THIS call got
// a full list back, and `last_refreshed_ms` is the age of the last full list this client saw
// (null when it has never seen one).

import { OF } from './m59-parse.mjs';

const fold = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Refresh the online list on a LIVE client and return the reply.
 * @param {object} c  a live M59Client (players, playersOnline, room, rsc, waitFor, evSeq)
 * @param {object} o  { pacer, timeoutMs, now }
 */
export async function readWho(c, { pacer = null, timeoutMs = 3000, now = () => Date.now() } = {}) {
  if (!c || typeof c.players !== 'function')
    throw new Error('who needs a live client; this one has no players() (a keeper-backed picture?)');
  const since = c.evSeq;
  if (pacer?.submit) await pacer.submit('read', () => c.players());
  else c.players();
  const w = await c.waitFor({ since, kinds: ['who'], timeoutMs }).catch(() => ({ events: [] }));
  const refreshed = (w?.events ?? []).some(e => e.kind === 'who');
  if (refreshed) c._whoRefreshedAt = now();
  const at = Number.isFinite(c._whoRefreshedAt) ? c._whoRefreshedAt : null;
  const players = [...(c.playersOnline?.values?.() ?? [])]
    .map(p => ({ id: p.id, name: p.name ?? null }));
  const here = [...(c.room?.objects?.values?.() ?? [])]
    .filter(o => o && (o.flags & OF.PLAYER))
    .map(o => ({ id: o.id, name: c.rsc?.get?.(o.nameRsc) || c.playersOnline?.get?.(o.id)?.name || null,
                 ...(o.id === c.selfId ? { self: true } : {}) }));
  return {
    players, here,
    refreshed,
    last_refreshed_ms: at == null ? null : Math.max(0, now() - at),
    refreshed_at: at == null ? null : new Date(at).toISOString(),
    ...(refreshed ? {} : { note: `no full player list came back within ${timeoutMs}ms; ` +
                                 'players is the incrementally maintained list and may be stale' }),
  };
}

/**
 * Normalise a reply from either path and, given a name, answer "is X online / here".
 * A keeper error (unreachable, unknown action, no client) is THROWN, never returned as an
 * empty list -- "nobody is online" is the one answer a failure must not be able to give.
 */
export function whoReply(raw, { name = null } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('who: no reply');
  if (raw.error) throw new Error(`who: ${raw.error}`);
  if (!Array.isArray(raw.players) || !Array.isArray(raw.here))
    throw new Error('who: the reply carried no player list');
  const out = {
    players: raw.players.map(p => ({ id: p.id, name: p.name ?? null })),
    here: raw.here.map(p => ({ id: p.id, name: p.name ?? null, ...(p.self ? { self: true } : {}) })),
    refreshed: !!raw.refreshed,
    last_refreshed_ms: Number.isFinite(raw.last_refreshed_ms) ? raw.last_refreshed_ms : null,
    refreshed_at: raw.refreshed_at ?? null,
    ...(raw.note ? { note: raw.note } : {}),
  };
  if (name != null && String(name).trim()) {
    const key = fold(name);
    const exact = out.players.filter(p => fold(p.name) === key);
    const partial = exact.length ? [] : out.players.filter(p => fold(p.name).includes(key));
    out.query = {
      name: String(name),
      online: exact.length > 0,
      in_room: out.here.some(p => fold(p.name) === key),
      matches: exact.length ? exact : partial,
      ...(exact.length ? {} : partial.length ? { note: 'no exact match; matches are partial' } : {}),
    };
  }
  return out;
}

/**
 * The broker tool's whole body, minus the session lookup. `keeper` is the KeeperProxy when the
 * character is keeper-backed (the proxy's `who()` crosses to the keeper's `/action who`), else
 * null and the in-process client is asked directly.
 */
export async function runWho({ keeper = null, client = null, pacer = null, name = null } = {}) {
  if (keeper) return whoReply(await keeper.who({}), { name });
  return whoReply(await readWho(client, { pacer }), { name });
}
