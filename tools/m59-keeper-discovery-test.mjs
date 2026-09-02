#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverKeeperStates,
  keeperBandPorts,
  resolveKeeperBand,
} from './runtime/keeper-discovery.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'm59-keeper-discovery-'));
try {
  const registryPath = join(temporary, 'bands.json');
  writeFileSync(registryPath, JSON.stringify({ alpha: 12001 }));
  const band = resolveKeeperBand('alpha', { registryPath });
  assert.deepEqual(band, { base: 12001, end: 12100, width: 100 });
  assert.equal(keeperBandPorts(band).length, 100);
  assert.throws(() => resolveKeeperBand('missing', { registryPath }), /no keeper port band/);
  assert.equal(resolveKeeperBand('missing', { registryPath, missing: 'null' }), null);
  assert.throws(() => resolveKeeperBand('alpha', { override: 65437 }), /complete 100-port range/);
  assert.deepEqual(resolveKeeperBand('alpha', { override: '65436' }),
                   { base: 65436, end: 65535, width: 100 });

  const calls = [];
  const response = (value, status = 200) => new Response(
    value == null ? '' : JSON.stringify(value),
    { status, headers: { 'content-type': 'application/json' } },
  );
  const live = new Map([
    [12003, { agent: 'a', character: 'Alice', pid: 303, in_game: true, connected: true }],
    [12007, { agent: 'b', character: 'Bob', pid: 707, in_game: false, connected: false }],
    [12008, { agent: 'c', character: 'Carol', pid: 808, in_game: true, connected: true }],
    [12009, { agent: 'stranger', character: 'Mallory', pid: 909,
              in_game: true, connected: true }],
  ]);
  const states = new Map([
    [12003, { ...live.get(12003), room: { num: 1 }, as_of_ms: 10 }],
    [12007, { ...live.get(12007), room: { num: 2 }, as_of_ms: 20 }],
    [12008, { ...live.get(12008), room: { num: 4 }, as_of_ms: 30 }],
    [12009, { ...live.get(12009), room: { num: 3 }, as_of_ms: 40 }],
  ]);
  const fetchImpl = async url => {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    calls.push({ port, path: parsed.pathname });
    if (parsed.pathname === '/live') {
      if (port === 12008) return response(null, 404);
      if (live.has(port)) return response(live.get(port));
      throw new TypeError('connection refused');
    }
    if (parsed.pathname === '/health')
      return port === 12008 ? response(live.get(port)) : response(null, 404);
    if (parsed.pathname === '/state')
      return states.has(port) ? response(states.get(port)) : response(null, 404);
    return response(null, 404);
  };

  const found = await discoverKeeperStates({
    band,
    expectedAgents: ['a', 'b', 'c'],
    fetchImpl,
  });
  assert.deepEqual([...found.states.keys()].sort(), ['a', 'c']);
  assert.equal(found.states.has('b'), false, 'an explicitly offline keeper is not discovered');
  assert.equal(calls.filter(call => call.path === '/live').length, 100);
  assert.equal(calls.filter(call => call.path === '/health').length, 1,
               'legacy health is attempted only after a definite /live 404');
  assert.equal(calls.filter(call => call.path === '/state').length, 2,
               'rich state is fetched only for expected live identities');
  assert.equal(calls.some(call => call.path === '/state' && call.port === 12009), false,
               'a stranger in the band never receives a rich state request');

  calls.length = 0;
  states.set(12008, { ...states.get(12008), as_of_ms: 2501 });
  const stale = await discoverKeeperStates({
    band,
    expectedAgents: ['c'],
    ports: [12008],
    fetchImpl,
  });
  assert.equal(stale.states.has('c'), false, 'state older than the hard ceiling is rejected');
  states.set(12008, { ...states.get(12008), as_of_ms: 30 });

  calls.length = 0;
  states.set(12003, { ...states.get(12003), connected: false });
  const disconnected = await discoverKeeperStates({
    band,
    expectedAgents: ['a'],
    ports: [12003],
    fetchImpl,
  });
  assert.equal(disconnected.states.has('a'), false,
               'a process that disconnects between /live and /state is rejected');
  states.set(12003, { ...states.get(12003), connected: true });

  calls.length = 0;
  live.set(12004, { ...live.get(12003) });
  states.set(12004, { ...states.get(12003) });
  const duplicate = await discoverKeeperStates({ band, expectedAgents: ['a'], fetchImpl });
  assert.equal(duplicate.states.has('a'), false);
  assert.equal(duplicate.duplicateAgents.has('a'), true);
  assert.equal(calls.filter(call => call.path === '/state').length, 0,
               'ambiguous duplicate keepers fail before any rich read');

  console.log('m59 keeper discovery: PASS');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
