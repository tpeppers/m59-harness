// THE FLEET'S SERVICE BOARD: "somebody purge Foeman", "somebody take my curse off".
//
// The chalice desk and the mend desk already work this way for one service each: a character that needs
// something says so, a character that can provide it serves it. This is the same shape as a file every
// keeper on the machine can read, so any pak can ASK for a service without knowing who provides it, and
// any pak can RUN a desk without knowing who asked.
//
//   substrate/requests-<fleet>.jsonl, append-only, one row per event:
//     { ev: 'request', id, service, target, from, room, at, ttl_ms, why, pak }
//     { ev: 'claim',   id, by, at }      a provider is on it (a claim lapses after CLAIM_MS)
//     { ev: 'done',    id, by, at, outcome }
//     { ev: 'cancel',  id, by, at, why }
//
// A request is OPEN while it is younger than its ttl and not done or cancelled. Asking again for the same
// service on the same target while one is open refreshes it instead of adding a second, so a pak that asks
// on every blow posts once a fight, not once a second.
//
// Nothing here casts, walks or speaks. It is a list of wants; the desk that serves one is the place that
// decides whether it is safe and allowed (a purge is an OUTLAW act, purge.kod viOutlaw).
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const SUBSTRATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'substrate');
export const CLAIM_MS = 60_000;
export const requestsFile = (fleet, env = process.env) => env.M59_REQUESTS_FILE
  || join(SUBSTRATE, fleet && fleet !== 'default' ? `requests-${fleet}.jsonl` : 'requests.jsonl');

function rows(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn line */ } }
  return out;
}

/** Every request with its current state, newest first. */
export function board({ fleet = null, file = requestsFile(fleet), now = Date.now() } = {}) {
  const byId = new Map();
  for (const r of rows(file)) {
    if (r.ev === 'request') byId.set(r.id, { ...r, state: 'open', claimed_by: null, claimed_at: null });
    const q = byId.get(r.id);
    if (!q) continue;
    if (r.ev === 'refresh') { q.at = r.at; q.ttl_ms = r.ttl_ms ?? q.ttl_ms; }
    if (r.ev === 'claim') { q.claimed_by = r.by; q.claimed_at = r.at; }
    if (r.ev === 'done') { q.state = 'done'; q.outcome = r.outcome ?? null; q.by = r.by; }
    if (r.ev === 'cancel') { q.state = 'cancelled'; q.cancel_why = r.why ?? null; }
  }
  for (const q of byId.values()) {
    if (q.state === 'open' && now - q.at > q.ttl_ms) q.state = 'expired';
    if (q.claimed_by && now - q.claimed_at > CLAIM_MS) { q.claimed_by = null; q.claimed_at = null; }
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

export function openRequests({ service = null, fleet = null, file, now = Date.now(), unclaimed = false } = {}) {
  return board({ fleet, file, now }).filter(q => q.state === 'open' && (!service || q.service === service)
    && (!unclaimed || !q.claimed_by));
}

/** Ask for a service. Returns the request (refreshed if one was already open). */
export function postRequest({ service, target = null, from = null, room = null, ttl_ms = 5 * 60_000, why = null, pak = null,
                              fleet = null, file = requestsFile(fleet), now = Date.now() } = {}) {
  if (!service) throw new Error('a request names a service');
  const same = openRequests({ service, file, now }).find(q => String(q.target ?? '').toLowerCase() === String(target ?? '').toLowerCase());
  mkdirSync(dirname(file), { recursive: true });
  if (same) {
    appendFileSync(file, JSON.stringify({ ev: 'refresh', id: same.id, at: now, ttl_ms }) + '\n');
    return { ...same, at: now, ttl_ms, refreshed: true };
  }
  const row = { ev: 'request', id: randomUUID(), service: String(service).toLowerCase(), target, from, room, at: now, ttl_ms, why, pak };
  appendFileSync(file, JSON.stringify(row) + '\n');
  return { ...row, state: 'open' };
}

const mark = ev => ({ id, by = null, fleet = null, file = requestsFile(fleet), now = Date.now(), ...rest } = {}) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ev, id, by, at: now, ...rest }) + '\n');
};
export const claimRequest = mark('claim');
export const finishRequest = mark('done');
export const cancelRequest = mark('cancel');
