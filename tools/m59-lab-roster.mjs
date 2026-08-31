#!/usr/bin/env node
// Mark an already-created, explicitly local named roster as eligible for m59-lab-runner.
// This never creates accounts, changes credentials/endpoints, or prints roster contents.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateFileFor, lockFileFor } from './m59-fleetpath.mjs';
import { inspectFleetLock } from './runtime/fleet-lock.mjs';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function validateLabRoster(roster) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster))
    throw new Error('roster must be an object');
  const entries = Object.entries(roster);
  if (!entries.length) throw new Error('roster is empty');
  let endpoint = null;
  for (const [id, entry] of entries) {
    if (!SAFE_NAME.test(id)) throw new Error('roster contains an invalid actor id');
    const credentials = entry?.credentials;
    if (typeof credentials?.account !== 'string' || !credentials.account ||
        typeof credentials?.password !== 'string' || !credentials.password ||
        typeof credentials?.character !== 'string' || !credentials.character)
      throw new Error(`roster entry ${id} does not have complete credentials`);
    const host = String(credentials.host ?? '').trim().toLowerCase();
    const port = Number(credentials.port);
    if (!LOOPBACK.has(host))
      throw new Error(`roster entry ${id} is not explicitly loopback-only`);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 5959)
      throw new Error(`roster entry ${id} does not name a non-production local game port`);
    const key = `127.0.0.1:${port}`;
    if (endpoint && endpoint !== key) throw new Error('one lab roster cannot span server endpoints');
    endpoint = key;
  }
  return Object.freeze({ entries, endpoint });
}

export function markLabRoster(roster) {
  const checked = validateLabRoster(roster);
  const marked = Object.fromEntries(checked.entries.map(([id, entry]) => [id, {
    ...entry,
    credentials: { ...entry.credentials, lab_runtime: true },
  }]));
  return Object.freeze({ roster: marked, count: checked.entries.length, endpoint: checked.endpoint });
}

function parseArgs(argv) {
  let action = null;
  let fleet = null;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--check' || token === '--mark') {
      if (action && action !== token.slice(2)) throw new Error('--check and --mark are mutually exclusive');
      action = token.slice(2);
    } else if (token === '--fleet') {
      fleet = String(argv[++index] ?? '');
    } else if (token === '--help' || token === '-h') {
      return { help: true };
    } else throw new Error(`unknown option ${token}`);
  }
  action ??= 'check';
  if (!SAFE_NAME.test(fleet ?? '')) throw new Error('--fleet must name one explicit named roster');
  if (/prod|production|live/i.test(fleet))
    throw new Error(`production-like fleet ${JSON.stringify(fleet)} is refused`);
  return { action, fleet, help: false };
}

function readRoster(path) {
  if (!existsSync(path)) throw new Error(`roster does not exist: ${path}`);
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('roster is not valid JSON'); }
  return value;
}

function writeRoster(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.mark-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    console.log('usage: node tools/m59-lab-roster.mjs --fleet NAME [--check|--mark]');
    return 0;
  }
  const path = stateFileFor(config.fleet, {});
  const lock = inspectFleetLock(lockFileFor(config.fleet, {}));
  if (lock.state === 'live')
    throw new Error(`fleet is still owned by pid ${lock.lock?.pid ?? 'unknown'}; stop it before marking`);
  const source = readRoster(path);
  const checked = validateLabRoster(source);
  const already = checked.entries.filter(([, entry]) => entry.credentials.lab_runtime === true).length;
  if (config.action === 'mark') {
    const marked = markLabRoster(source);
    writeRoster(path, marked.roster);
    console.log(`marked ${marked.count} actor(s) in ${config.fleet} for lab runtime at ${marked.endpoint}`);
  } else {
    console.log(JSON.stringify({ fleet: config.fleet, actors: checked.entries.length,
      marked: already, endpoint: checked.endpoint, ready: already === checked.entries.length }, null, 2));
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`m59-lab-roster: ${error.message}`);
    process.exitCode = 1;
  });
}
