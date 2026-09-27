#!/usr/bin/env node
// WHAT A CHARACTER'S PRACTICE COST AND WHAT IT BOUGHT — read from the training ledger.
//
//   node tools/m59-training-report.mjs --agent t3                  everything recorded
//   node tools/m59-training-report.mjs --agent t2 --school shalille --since 24h
//   node tools/m59-training-report.mjs --agent t2 --json           for comparing runs by machine
//
// The ledger is written by the practice tools (m59-keep-training.mjs, m59-shalille-train.mjs and
// the drill FleetScripts) through m59-training-ledger.mjs; this only reads it. The aggregate is
// summarizeTraining(), the same pure function its test pins. Read-only: no lease, no socket to a
// keeper, one /health read to find the file.
import { brokerHealth, trainingPath, readTraining, summarizeTraining } from './m59-training-ledger.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = arg('agent') || (console.error('--agent is required'), process.exit(2));
const since = (() => {
  const s = arg('since'); if (!s) return 0;
  const m = /^(\d+)([hd])$/.exec(s); if (!m) return Date.parse(s) || 0;
  return Date.now() - Number(m[1]) * (m[2] === 'd' ? 86_400_000 : 3_600_000);
})();

const h = await brokerHealth();
const path = arg('file') || trainingPath({ root: h.root, fleet: h.fleet, agent: AGENT });
const events = await readTraining(path);
const s = summarizeTraining(events, { school: arg('school'), since });
const character = events.find(e => e.character)?.character ?? h?.session_characters?.[AGENT] ?? AGENT;

if (argv.includes('--json')) { console.log(JSON.stringify({ agent: AGENT, character, path, ...s }, null, 2)); process.exit(0); }

const hms = t => `${Math.floor(t / 3600)}h ${Math.floor(t % 3600 / 60)}m`;
console.log(`${character} (${AGENT})  —  ${path}`);
if (!events.length) { console.log('  no training recorded yet'); process.exit(0); }
console.log(`  runs ${s.runs}, practising ${hms(s.wall_clock_s)}, rooms travelled ${s.rooms_travelled}`);
console.log(`  casts: ${s.totals.success} succeeded, ${s.totals.fizzle} fizzled, ${s.totals.refused} refused, ${s.totals.unknown} unknown`);
for (const [spell, c] of Object.entries(s.casts)) {
  const tried = c.success + c.fizzle;
  console.log(`    ${spell.padEnd(16)} ${String(c.success).padStart(5)} ok ${String(c.fizzle).padStart(5)} fizzled` +
              (tried ? `  (${Math.round(100 * c.success / tried)}% success)` : ''));
}
console.log('  improves:');
for (const [spell, i] of Object.entries(s.improves))
  console.log(`    ${spell.padEnd(16)} +${i.improves}  (${i.from} -> ${i.to})`);
if (s.ability_span) console.log(`  ability span (first to last snapshot): ${JSON.stringify(s.ability_span)}`);
console.log(`  reagents & money (bought total ${s.money_spent_bought} shillings):`);
for (const r of s.restock)
  console.log(`    ${String(r.item).padEnd(18)} ${String(r.qty).padStart(5)} from ${r.source}` +
              (r.source === 'bought' ? ` for ${r.costKnown ? r.cost : `${r.cost}+ (some costs unread)`}` : r.source === 'bank' ? ` withdrawn` : ''));
console.log(`  code: ${s.code.join(', ') || 'unrecorded'}`);
