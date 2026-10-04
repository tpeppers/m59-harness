#!/usr/bin/env node
// ASK ONE CHARACTER'S KEEPER SOMETHING, AND BE SURE IT IS THAT CHARACTER'S KEEPER ANSWERING.
//
//   node tools/m59-keeper.mjs Beaker                          # GET /state?fresh=1, checked
//   node tools/m59-keeper.mjs t6 /grid                        # any GET path
//   node tools/m59-keeper.mjs t6 /findpath c=32 r=8           # extra query args as k=v
//   node tools/m59-keeper.mjs t6 --pick autopilot_status.did  # one field of the reply
//   node tools/m59-keeper.mjs t6 --port                       # just where it is right now
//   node tools/m59-keeper.mjs --list                          # every keeper on this fleet's band
//
// READ-ONLY. Every request is a GET; orders go through the broker or a fleetscript.
//
// WHY THIS EXISTS. Keeper ports MOVE: the standard restart brings each replacement up on a free
// port in the band, so a port remembered from ten minutes ago belongs to whoever landed on it.
// 2026-10-04: after a broker restart, three `/state` reads sent to Bunsen's, Beaker's and Robin's
// old ports came back as Lew, Statler and Gonzo, and were read as the farmers' -- `/state` names
// its owner in the reply, but nothing made the reader look. The tools were already safe (the
// fleetscript scans `/live`, and every write must carry the full identity); hand-run reads were
// not. This is the hand-run read, made the same shape as the tools':
//
//   1. FIND: scan `/live` across the fleet's keeper band (about 1 ms a port, all in parallel) and
//      take the port whose keeper names this agent or character -- never a remembered port;
//   2. ADDRESS: send agent, character and keeper pid in the query, so a keeper that is not the
//      one found (restarted in between) refuses with 409 rather than answering;
//   3. CHECK: the reply's identity headers (x-m59-agent, -character, -keeper-pid) or, from an older
//      keeper, the body's own `agent`, must be the one asked for. A mismatch exits 3, loudly.
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const LIVE_TIMEOUT_MS = 700;

/** Scan the band. Map agent -> { port, agent, character, pid, in_game }. */
export async function scanKeepers({ fleet, band = null, fetchImpl = fetch, timeoutMs = LIVE_TIMEOUT_MS } = {}) {
  if (!band) {
    const { lookupKeeperBand } = await import('./runtime/keeper-bands.mjs');
    band = lookupKeeperBand(fleet, { registryPath: process.env.M59_KEEPER_BAND_REGISTRY || undefined });
  }
  const found = new Map();
  if (!band) return found;
  const probes = [];
  for (let port = band.base; port <= band.end; port++)
    probes.push(fetchImpl(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(timeoutMs) })
      .then(r => r.ok ? r.json() : null)
      .then(v => { if (v?.agent) found.set(String(v.agent), { port, agent: String(v.agent),
        character: v.character ?? null, pid: v.pid ?? null, in_game: v.in_game ?? null }); })
      .catch(() => {}));
  await Promise.all(probes);
  return found;
}

/** The keeper for `who` — an agent id (t6) or a character name (Beaker), case-insensitive. */
export function pickKeeper(keepers, who) {
  const w = String(who ?? '').trim().toLowerCase();
  for (const k of keepers.values())
    if (k.agent.toLowerCase() === w || String(k.character ?? '').toLowerCase() === w) return k;
  return null;
}

/** Who answered: the identity headers when present, else the body's own fields. */
export function identityOf(headers, body) {
  const h = name => { const v = headers?.get?.(name) ?? headers?.[name]; return v == null ? null : decodeURIComponent(String(v)); };
  const agent = h('x-m59-agent') ?? (body && typeof body === 'object' ? body.agent ?? null : null);
  return { agent: agent == null ? null : String(agent),
           character: h('x-m59-character') ?? (body?.character ?? null),
           pid: h('x-m59-keeper-pid') ?? (body?.pid ?? null),
           from: h('x-m59-agent') != null ? 'headers' : agent != null ? 'body' : null };
}

/** null when the reply is from the keeper asked for, else the reason it is not. */
export function identityMismatch(expected, got) {
  if (!got?.agent) return null;   // a body that does not name itself; the keeper's own 409 covers addressed paths
  if (got.agent !== expected.agent) return `answered by ${got.agent}${got.character ? ` (${got.character})` : ''}, not ${expected.agent}`;
  if (expected.character && got.character && String(got.character) !== String(expected.character))
    return `answered by character ${got.character}, not ${expected.character}`;
  if (expected.pid != null && got.pid != null && String(got.pid) !== String(expected.pid))
    return `answered by keeper pid ${got.pid}, not ${expected.pid} -- the keeper restarted; ask again`;
  return null;
}

export function pick(obj, path) {
  return String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);
}

async function main(argv) {
  const flags = new Set(argv.filter(a => /^--(list|port|raw)$/.test(a)));
  const pickAt = argv.indexOf('--pick');
  const pickPath = pickAt >= 0 ? argv[pickAt + 1] : null;
  const fleetAt = argv.indexOf('--fleet');
  const rest = argv.filter((a, i) => !a.startsWith('--') && i !== pickAt + 1 && i !== fleetAt + 1);
  const fleet = fleetName(argv);
  const keepers = await scanKeepers({ fleet });

  if (flags.has('--list')) {
    if (!keepers.size) {
      console.error(`no keeper answered on fleet "${fleet || '(unnamed)'}"'s band. The band comes from THIS checkout's ` +
                    'substrate/keeper-bands.json; from another checkout, run from the one holding the fleet or set ' +
                    'M59_KEEPER_BAND_REGISTRY to its keeper-bands.json');
      return 2;
    }
    for (const k of [...keepers.values()].sort((a, b) => a.agent.localeCompare(b.agent, undefined, { numeric: true })))
      console.log(`${k.agent.padEnd(5)} ${String(k.character ?? '?').padEnd(12)} port ${k.port}  pid ${k.pid}  ${k.in_game ? 'in game' : 'NOT in game'}`);
    return 0;
  }

  const [who, rawPath = '/state', ...kv] = rest;
  if (!who) { console.error('usage: m59-keeper.mjs <agent|character> [/path] [k=v ...] [--pick a.b] [--port] [--fleet name] | --list'); return 1; }
  const k = pickKeeper(keepers, who);
  if (!k) {
    console.error(`no keeper on fleet "${fleet || '(unnamed)'}" answers as "${who}" (${keepers.size} keeper(s) answered: ` +
                  `${[...keepers.values()].map(x => `${x.agent}/${x.character}`).join(', ')})`);
    return 2;
  }
  if (flags.has('--port')) { console.log(k.port); return 0; }

  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const url = new URL(`http://127.0.0.1:${k.port}${path}`);
  if (path === '/state' && !url.searchParams.has('fresh')) url.searchParams.set('fresh', '1');
  for (const p of kv) { const i = p.indexOf('='); if (i > 0) url.searchParams.set(p.slice(0, i), p.slice(i + 1)); }
  url.searchParams.set('agent', k.agent);
  if (k.character) url.searchParams.set('character', k.character);
  if (k.pid != null) url.searchParams.set('keeper_pid', String(k.pid));

  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  const why = identityMismatch(k, identityOf(r.headers, body));
  if (why) { console.error(`REFUSED TO TRUST THE REPLY: port ${k.port} ${why}`); return 3; }
  if (r.status === 409) { console.error(`the keeper refused the address: ${body?.error ?? text} -- it restarted; ask again`); return 3; }
  if (!r.ok) { console.error(`${r.status}: ${text.slice(0, 500)}`); return 1; }
  const out = pickPath ? pick(body, pickPath) : (body ?? text);
  console.error(`[${k.agent} ${k.character ?? '?'} port ${k.port} pid ${k.pid}]`);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, flags.has('--raw') ? 0 : 1));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    e => { console.error(e?.message ?? e); process.exitCode = 1; });
