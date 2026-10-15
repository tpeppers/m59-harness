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
// WHY NOT THE BROKER'S KEEPER PROCESS. The server allows one connection per character and the
// person's client holds it, so the broker's keeper (which logs in) has nothing to log in to;
// the broker sees the character as piloted and leaves it alone, which is right. This process
// never registers with the broker and holds no claim of its own.
//
// IT NEVER WRITES THE LIVE ROSTER. Session may record a learned character name back into the
// roster file, and the roster is the only copy of the account passwords. So it runs against a
// scrubbed copy (passwords removed) under substrate/spectate/, and an attached client never
// needs a password anyway.
//
// It exits when the attachment closes (the person's client went away, or the proxy did), and on
// SIGTERM from the desk. Its heartbeat is substrate/spectate/<agent>.json.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const agent = arg('agent'), port = Number(arg('attach-port')), player = Number(arg('player'));
if (!/^[a-z0-9_-]{1,40}$/.test(agent ?? '') || !(port > 0) || !(player > 0)) {
  console.error('usage: m59-spectate-keeper.mjs --fleet <name> --agent <agent> --attach-port <port> --player <objId>');
  process.exit(2);
}
const { stateFile } = resolveFleet(argv);
const live = JSON.parse(readFileSync(stateFile, 'utf8'));
const entry = live[agent];
if (!entry?.credentials) { console.error(`no roster entry for ${agent} in ${stateFile}`); process.exit(2); }

// The scrubbed roster. Every entry is kept (fleetmates are recognised by name), no password survives.
const dir = resolve(HERE, '..', 'substrate', 'spectate');
mkdirSync(dir, { recursive: true });
const scrubbed = Object.fromEntries(Object.entries(live).map(([k, v]) =>
  [k, v?.credentials ? { ...v, credentials: { ...v.credentials, password: undefined } } : v]));
const rosterCopy = join(dir, `${agent}-roster.json`);
writeFileSync(rosterCopy, JSON.stringify(scrubbed, null, 1));
process.env.M59_STATE_FILE = rosterCopy;
process.env.M59_KEEPER_ATTACH = JSON.stringify({ port, agent, player });

const beat = join(dir, `${agent}.json`);
const heartbeat = state => { try { writeFileSync(beat + '.tmp', JSON.stringify({ pid: process.pid, at: Date.now(), agent, player, port, state })); renameSync(beat + '.tmp', beat); } catch {} };
heartbeat('starting');

// Imported only now: these modules read M59_STATE_FILE when they load.
const { Session } = await import('./m59-session.mjs');
const { autopilotFor } = await import('./m59-autopilot.mjs');

const session = new Session(agent, { communicationStateFile: rosterCopy });
let autopilot = null, stopping = false;
const stop = (why, code = 0) => {
  if (stopping) return; stopping = true;
  console.error(`[spectate] ${agent} stopping: ${why}`);
  try { autopilot?.stop?.(); } catch {}
  try { session.client?.sock?.destroy?.(); } catch {}
  heartbeat(`stopped: ${why}`);
  setTimeout(() => process.exit(code), 300);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(sig));

try {
  const { account, character, host, port: serverPort } = entry.credentials;
  await session.join({ account, password: '(attached; never sent)', character, host, port: serverPort });
  console.error(`[spectate] ${agent} attached as ${session.client?.me?.name ?? character} (self ${session.client?.selfId})`);
  autopilot = autopilotFor(session);
  autopilot.mode = entry.autopilot?.mode || 'goap';
  Object.assign(autopilot.policy, entry.autopilot?.policy || {});
  await autopilot.applyFarmStrategy?.('join');
  autopilot.start();
  console.error(`[spectate] ${agent} keeper driving (mode=${autopilot.mode}, hunt=${JSON.stringify(autopilot.policy.hunt ?? null)})`);
  heartbeat('driving');
} catch (e) {
  stop(`could not attach: ${e.message}`, 1);
}

// The attachment is the whole reason to exist: when it is gone for good, so is this. NOT on the first
// closed client: the Session reconnects by itself (a renumbered object id after `save game`, a stale
// stream), and in attached mode that reconnect is simply a fresh attach -- the proxy accepts it once
// the old one has detached. So it takes 15s without a live, attached client to stop.
let lastAttached = Date.now();
setInterval(() => {
  if (stopping) return;
  if (session.client && session.client.state === 'game' && !session.client.sock?.destroyed) lastAttached = Date.now();
  if (Date.now() - lastAttached > 15_000) return stop('attachment gone for 15s');
  heartbeat(Date.now() - lastAttached < 2500 ? 'driving' : 'reattaching');
}, 1000);
