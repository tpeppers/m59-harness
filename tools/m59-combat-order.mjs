#!/usr/bin/env node
// One RPC from chat to the socket owners. No fleet/look/preflight RPC or retry.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fleetName, stateFileFor, resolveControlUrl } from './m59-fleetpath.mjs';

export async function combatOrder(input, { fleet = fleetName(), url = resolveControlUrl().url, timeoutMs = 5000 } = {}) {
  if (!url) throw Error(resolveControlUrl().why ?? 'combat: control URL required');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'combat_order', arguments: { ...input, fleet_state: stateFileFor(fleet) } } }),
    signal: AbortSignal.timeout(timeoutMs) });
  const reply = await response.json();
  const content = reply.result?.content?.find(c => c.type === 'text')?.text;
  if (reply.error || reply.result?.isError) throw Error(content ?? reply.error?.message ?? 'combat order failed');
  if (!content) throw Error('combat: broker returned no receipt');
  return JSON.parse(content);
}

export function parseCombatCLI(argv) {
  const options = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') { options.action = 'ready'; continue; }
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (!['fleet', 'room', 'agents', 'command-id', 'ttl'].includes(key) ||
          options[key] != null || !argv[i + 1] || argv[i + 1].startsWith('--'))
        throw Error('combat: invalid option ' + argv[i]);
      options[key] = argv[++i];
    } else words.push(argv[i]);
  }
  const phrase = words.join(' ').trim(), match = /^(kill|attack) +(.+)$/i.exec(phrase);
  const action = options.action ?? match?.[1].toLowerCase() ?? phrase.toLowerCase();
  if (!['kill', 'attack', 'ready', 'status', 'stop'].includes(action) ||
      (options.action && phrase)) throw Error('usage: m59-combat-order.mjs "Kill Player" --fleet prod --room "Room Name" | --check | status|stop [--command-id ID]');
  return { action, ...(match ? { target: match[2] } : {}),
    ...(options.room ? { room: options.room } : {}),
    ...(options.agents ? { agents: options.agents.split(',') } : {}),
    ...(options['command-id'] ? { command_id: options['command-id'] } : {}),
    ...(options.ttl ? { ttl_ms: Number(options.ttl) } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await combatOrder(parseCombatCLI(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
