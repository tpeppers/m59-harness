#!/usr/bin/env node
// PREFARM — IS IT WORTH FARMING SOLDIERS FOR THIS LIST, AND WHO SHOULD GO? Read-only.
//
//   node tools/m59-prefarm.mjs --wants '{"chain armor":4,"long sword":4}' [--hall 714] [--top 6]
//                                [--faction princess] [--control http://127.0.0.1:8901]
//
// Prints the plan (kills, flagpole-hours, what it saves, the byproducts, and every warning —
// m59-prefarm-lib.mjs) against the fleet's REAL levels, picks the top N fighters by level, and
// prints the REPL line that runs it (tools/fleetscripts/prefarm-equipment.mjs). It never sends
// anything but reads: the run is a separate, deliberate step through the FleetScript compiler.
import { planPrefarm, describePrefarm } from './m59-prefarm-lib.mjs';

const argv = process.argv.slice(2);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const control = opt('--control', process.env.M59_CONTROL_URL ?? 'http://127.0.0.1:8901');
const wants = JSON.parse(opt('--wants', '{}'));
const hall = Number(opt('--hall', 714));
const top = Number(opt('--top', 6));

const rpc = async (name, args = {}) => {
  const r = await fetch(new URL('/rpc', control), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(60_000) });
  return JSON.parse((await r.json()).result.content[0].text);
};

const fleet = (await rpc('fleet', {}).catch(() => null))?.fleet ?? [];
const rows = [];
for (const f of fleet) {
  const s = await rpc('status', { agent: f.agent, brief: false }).catch(() => null);
  // LEVEL IS MAX HEALTH in this game (status's own level_note: "max_health 75 is what the game treats as your level").
  const level = Number(s?.hp?.max ?? s?.vitals?.health?.max ?? 0);
  const maxHp = Number(s?.hp?.max ?? s?.vitals?.health?.max ?? 0);
  if (level) rows.push({ agent: f.agent, character: f.character, level, maxHp });
}
rows.sort((a, b) => (b.level - a.level) || (b.maxHp - a.maxHp));
const pick = rows.filter(r => r.maxHp >= 30).slice(0, top);
const plan = planPrefarm({ wants, hall, faction: opt('--faction'), fleetLevels: pick.map(r => r.level) });
console.log(describePrefarm(plan));
console.log(`\n  fighters (top ${top} by level): ${pick.map(r => `${r.agent} ${r.character} L${r.level}`).join(', ') || 'NONE READ'}`);
console.log(`  ${plan.rooms.length} flag rooms, so ${Math.min(pick.length, plan.rooms.length * 2)} of them are useful (two per room keep a pole's output killed)`);
console.log(`\n  to run it (fleet REPL, node tools/m59-fleet-repl.mjs):\n    prefarm-equipment agents=${pick.map(r => r.agent).join(',')} ` +
            `wants='${JSON.stringify(wants)}' hall=${hall} minutes=${Math.max(30, Math.round((plan.hours ?? 1) * 60))}`);
