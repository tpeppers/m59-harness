#!/usr/bin/env node
// SPECTATE: run a character's keeper on the connection a PERSON's dev client holds, so they can
// watch it play.
//
//   node tools/m59-spectate-keeper.mjs --fleet prod --agent t15 --attach-port 8932 --player 4464
//
// Started by the plan desk when someone picks "Relinquish control to Keeper" on the PLAN tab
// (tools/plans/control.mjs), and stopped when they take control back. Not by hand, normally.
//
// IT IS THE SAME KEEPER. The same Session (m59-game.mjs) and the same Autopilot
// (m59-autopilot.mjs) the keeper process runs, with the roster's standing orders (mode and
// policy) -- only the client underneath is attached instead of logged in (M59_KEEPER_ATTACH,
// m59-client.mjs connectAttached). Its frames reach the server only while the proxy's control
// gate is held by `keeper:<agent>` (m59-proxy-attach.mjs); the person's own client is locked
// out for exactly that time and watches the moves arrive.
//
// IT IS NOW LITERALLY THE KEEPER PROCESS. This file used to build its own Session and Autopilot and
// served no HTTP API, so the broker -- which marks the character piloted -- went on reading the
// character's NORMAL keeper process, offline and frozen, and sent every order there. Measured
// 2026-11-01 on t17 (Zoot): `fleet` put him in room 566 while he walked the East Tower (2013), and
// autopilot start, travel, cast and supply all went to a process with no socket. So this is now a
// launcher: it scrubs the roster, sets the attachment, and runs m59-keeper-process.mjs IN THIS
// PROCESS (same pid) in SPECTATE mode, on an ephemeral loopback port it publishes in the heartbeat.
// The broker's KeeperProxy routes reads and orders here while that heartbeat is live and the port's
// `/live` names this agent, character and pid (tools/m59-spectate-route.mjs); when this exits,
// everything falls back to the normal keeper. The broker still sees the character as piloted, and
// still keeps the normal keeper from logging in while this holds the body.
//
// WHY NOT THE BROKER'S KEEPER PROCESS ITSELF. The server allows one connection per character and the
// person's client holds it, so the broker's keeper (which logs in) has nothing to log in to. This
// process never logs in, holds no fleet or account claim, and is not spawned by the broker.
//
// IT NEVER WRITES THE LIVE ROSTER. Session may record a learned character name back into the
// roster file, and the roster is the only copy of the account passwords. So it runs against a
// scrubbed copy (passwords removed) under substrate/spectate/, and an attached client never
// needs a password anyway.
//
// It exits when the attachment has been gone for 15s (the person's client went away, or the proxy
// did), and on SIGTERM from the desk. Its heartbeat is substrate/spectate/<agent>.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';
import { spectateDir, writeSpectateBeat } from './m59-spectate-route.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const agent = arg('agent'), port = Number(arg('attach-port')), player = Number(arg('player'));
if (!/^[a-z0-9_-]{1,40}$/.test(agent ?? '') || !(port > 0) || !(player > 0)) {
  console.error('usage: m59-spectate-keeper.mjs --fleet <name> --agent <agent> --attach-port <port> --player <objId>');
  process.exit(2);
}
const resolved = resolveFleet(argv);
const { stateFile } = resolved;
const live = JSON.parse(readFileSync(stateFile, 'utf8'));
const entry = live[agent];
if (!entry?.credentials) { console.error(`no roster entry for ${agent} in ${stateFile}`); process.exit(2); }

// The scrubbed roster. Every entry is kept (fleetmates are recognised by name), no password survives.
// The heartbeat directory follows THIS checkout (or M59_SPECTATE_DIR), where the broker looks for it.
const dir = spectateDir();
mkdirSync(dir, { recursive: true });
const scrubbed = Object.fromEntries(Object.entries(live).map(([k, v]) =>
  [k, v?.credentials ? { ...v, credentials: { ...v.credentials, password: undefined } } : v]));
const rosterCopy = join(dir, `${agent}-roster.json`);
writeFileSync(rosterCopy, JSON.stringify(scrubbed, null, 1));
const beat = join(dir, `${agent}.json`);
// Before the keeper binds its port: alive, not yet routable (no http_port), so the desk sees it start.
writeSpectateBeat(beat, { pid: process.pid, at: Date.now(), agent, player, port, attach_port: port,
                          http_port: null, roster: resolve(stateFile), fleet: resolved.fleet, state: 'starting' });

process.env.M59_STATE_FILE = rosterCopy;
process.env.M59_KEEPER_ATTACH = JSON.stringify({ port, agent, player });
process.env.M59_KEEPER_SPECTATE = JSON.stringify({ beat, roster: resolve(stateFile), player, attach_port: port });
// WALL CLAIMS ARE SHARED WITH THE FLEET. The keeper scopes them by roster path, and its roster here is
// the scrubbed copy; without this it would claim walls in a namespace of its own and stand on a
// fleetmate's. Scoped exactly as the real keeper would scope it, from the LIVE roster path.
if (!process.env.M59_SPOT_CLAIMS_NAMESPACE) {
  const { spotClaimNamespace } = await import('./m59-spotclaims.mjs');
  process.env.M59_SPOT_CLAIMS_NAMESPACE = spotClaimNamespace({ fleetPath: stateFile,
    host: entry.credentials.host || process.env.M59_HOST || '127.0.0.1',
    port: entry.credentials.port || process.env.M59_PORT || 8899 });
}

// The keeper reads its arguments from process.argv, and its modules read M59_STATE_FILE when they load,
// so both are set first and the keeper is imported only now. `--port 0`: the OS picks; the keeper
// publishes what it bound.
process.argv = [process.argv[0], join(HERE, 'm59-keeper-process.mjs'), '--agent', agent, '--port', '0',
                '--fleet', resolved.fleet === '' ? '-' : resolved.fleet];
console.error(`[spectate] ${agent} running the keeper process attached to player ${player} via proxy port ${port}`);
await import('./m59-keeper-process.mjs');
