#!/usr/bin/env node
// WHERE THE LOOT WENT. The two directions of the ledger, read against each other.
//
//   node tools/m59-itemflow.mjs                  # last 24h: in, out, and what nobody asked for
//   node tools/m59-itemflow.mjs --hours 6
//   node tools/m59-itemflow.mjs --unexplained    # only departures we did not request
//   node tools/m59-itemflow.mjs --character Robin
//   node tools/m59-itemflow.mjs --item sword     # trace one kind of thing, both directions
//   node tools/m59-itemflow.mjs --id 19204       # trace one object, arrival to departure
//   node tools/m59-itemflow.mjs --open           # looted, never seen leaving: should still be carried
//   node tools/m59-itemflow.mjs --json
//
// WHY THIS EXISTS.
//
// `looted` recorded an item arriving. Nothing recorded one leaving, so the fleet's history
// could answer "what did this character pick up" and not "and where did it go" — and when
// roughly two dozen magic items disappeared across 2026-09-07/08, including the entire
// 21-item identification queue, there was no row of any kind to read. `left_pack` is the
// missing half (m59-client BP_INVENTORY_REMOVE -> Session.noteLeftPack), and this reads the
// two together.
//
// THE COLUMN THAT MATTERS IS `after`. A departure carries what we had ASKED for in the
// moment before it: `drop`, `offer`, `deposit_items`, `cast`, and so on. A departure with
// nothing behind it — `after: null` — is an item that left while we were requesting nothing
// that could have moved it. That is the leak, and `--unexplained` is the whole tool.
//
// WHAT IT CANNOT TELL YOU, said plainly rather than implied:
//
//   * NOTHING BEFORE THE EVENT SHIPPED. There are no `left_pack` rows in the older history
//     and nothing can invent them, so an item that vanished on 2026-09-07 will show here as
//     `open` — looted and never seen leaving — which is indistinguishable from one still in
//     the pack. `--open --before <iso>` is honest about that; the fix is time, not code.
//   * WHY, only WHAT and WHEN and WHAT-WE-ASKED-FOR. A death drops everything and the
//     `died` row beside it is the corroboration; a sale leaves a purse trace. Read them
//     together — `--context` puts the neighbouring rows next to each departure.
//
// Reads only. Opens no socket, moves nobody, and never starts a broker.

import { readLedger } from './m59-ledger.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const HOURS = Number(opt('hours', 24)) || 24;
const WANT_CHAR = opt('character');
const WANT_ITEM = (opt('item') || '').toLowerCase();
const WANT_ID = opt('id') ? Number(opt('id')) : null;
const AS_JSON = flag('json');

const { events } = readLedger({ sinceMs: HOURS * 3600 * 1000 });

const matches = row => {
  if (WANT_CHAR && String(row.character).toLowerCase() !== WANT_CHAR.toLowerCase()) return false;
  if (!WANT_ITEM && WANT_ID === null) return true;
  const items = Array.isArray(row.items) ? row.items : [];
  if (WANT_ID !== null) return items.some(i => Number(i.id) === WANT_ID);
  return items.some(i => String(i.name ?? '').toLowerCase().includes(WANT_ITEM));
};

const arrivals   = events.filter(e => e.kind === 'looted' && matches(e));
const departures = events.filter(e => e.kind === 'left_pack' && matches(e));
// The rows that corroborate a departure. A death drops the pack; a vault trip empties it on
// purpose. Neither is read as an explanation here — they are printed beside the departure so
// a person can decide, which is the difference between evidence and a verdict.
const CORROBORATING = new Set(['died', 'vault_trip', 'sold', 'level_lost']);
const context = events.filter(e => CORROBORATING.has(e.kind)
  && (!WANT_CHAR || String(e.character).toLowerCase() === WANT_CHAR.toLowerCase()));

const when = t => new Date(t).toISOString().replace('T', ' ').slice(5, 19);
const itemsOf = row => (Array.isArray(row.items) ? row.items : []);
const nameOf = i => (i.amount > 1 ? `${i.name} x${i.amount}` : (i.name ?? `id ${i.id}`));

// ---------------------------------------------------------------- one object, both ways
//
// The narrowest and most useful view: an id names exactly one thing, and the two rows about
// it are the whole story. Object ids ARE renumbered by `save game`, so a trace that crosses
// a checkpoint can pick up a stranger — hence the elapsed time is printed, and a gap of days
// on a fleet that saves every few hours deserves suspicion rather than belief.
if (WANT_ID !== null && !AS_JSON) {
  const rows = [...arrivals, ...departures].sort((a, b) => a.t - b.t);
  if (!rows.length) {
    console.log(`nothing in the last ${HOURS}h mentions object ${WANT_ID}.`);
    console.log('Ledger rows are keyed by character name and kept per day; try --hours 72.');
    process.exit(0);
  }
  console.log(`object ${WANT_ID}, last ${HOURS}h\n`);
  for (const r of rows) {
    const it = itemsOf(r).find(i => Number(i.id) === WANT_ID) ?? {};
    if (r.kind === 'looted')
      console.log(`  ${when(r.t)}  ${r.character} PICKED UP  ${nameOf(it)}  in room ${r.room ?? '?'}`);
    else
      console.log(`  ${when(r.t)}  ${r.character} LOST       ${nameOf(it)}  in room ${r.room ?? '?'}`
                + `  after: ${r.after ?? 'NOTHING WE ASKED FOR'}`
                + (r.after && r.after_ms !== null ? ` (${r.after_ms}ms earlier)` : ''));
  }
  const last = rows.at(-1);
  if (last.kind === 'looted')
    console.log(`\n  still open: no departure recorded, so it should still be in ${last.character}'s pack.`);
  process.exit(0);
}

// ------------------------------------------------------------------------- the leak view
const unexplained = departures.filter(d => !d.after);

if (AS_JSON) {
  console.log(JSON.stringify({
    window_hours: HOURS, arrivals: arrivals.length, departures: departures.length,
    unexplained: unexplained.map(d => ({ at: d.iso, character: d.character, room: d.room,
                                         items: itemsOf(d), known: d.known })),
    by_verb: Object.fromEntries(tally(departures)),
  }, null, 2));
  process.exit(0);
}

function tally(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.after ?? '(nothing we asked for)',
                             (m.get(r.after ?? '(nothing we asked for)') ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

if (flag('unexplained')) {
  console.log(`departures with nothing behind them — last ${HOURS}h\n`);
  if (!departures.length) noRowsYet();
  else if (!unexplained.length)
    console.log('  none. Every item that left did so within a minute of a request we sent.');
  for (const d of unexplained) {
    const near = context.filter(c => c.character === d.character && Math.abs(c.t - d.t) < 120_000);
    console.log(`  ${when(d.t)}  ${d.character.padEnd(10)} ${itemsOf(d).map(nameOf).join(', ')}`
              + `  room ${d.room ?? '?'}`
              + (d.known === false ? '  [an id we were not holding]' : '')
              + (near.length ? `\n${' '.repeat(16)}beside: ${near.map(c => c.kind).join(', ')}` : ''));
  }
  process.exit(0);
}

if (flag('open')) {
  // Looted and never seen leaving. On a fleet whose departure event is younger than its
  // history this over-reports by exactly the age of the event, which is said out loud below
  // rather than left for someone to discover in a number.
  const gone = new Set(departures.flatMap(d => itemsOf(d).map(i => Number(i.id))));
  const open = [];
  for (const a of arrivals) for (const i of itemsOf(a))
    if (!gone.has(Number(i.id))) open.push({ ...i, character: a.character, t: a.t, room: a.room });
  console.log(`looted and not yet seen leaving — last ${HOURS}h  (${open.length} of `
            + `${arrivals.reduce((n, a) => n + itemsOf(a).length, 0)} arrivals)\n`);
  for (const o of open.slice(-60))
    console.log(`  ${when(o.t)}  ${o.character.padEnd(10)} ${nameOf(o)}  room ${o.room ?? '?'}  id ${o.id}`);
  if (open.length > 60) console.log(`  ... and ${open.length - 60} more`);
  console.log('\n  "Open" means no departure ROW, not "verified in the pack" — read a live'
            + '\n  inventory to confirm. Anything looted before left_pack shipped is open by'
            + '\n  construction: there is nothing that could have recorded it leaving.');
  process.exit(0);
}

// ------------------------------------------------------------------------------- summary
console.log(`item flow, last ${HOURS}h`
          + (WANT_CHAR ? ` — ${WANT_CHAR}` : '') + (WANT_ITEM ? ` — "${WANT_ITEM}"` : '') + '\n');
console.log(`  ${arrivals.reduce((n, a) => n + itemsOf(a).length, 0)} item(s) picked up over `
          + `${arrivals.length} looting(s)`);
console.log(`  ${departures.length} item(s) left a pack\n`);

if (!departures.length) { noRowsYet(); process.exit(0); }

console.log('  what we had asked for, in the minute before:');
for (const [verb, n] of tally(departures)) {
  const bar = '#'.repeat(Math.min(40, Math.round(40 * n / departures.length)));
  console.log(`    ${String(n).padStart(5)}  ${verb.padEnd(24)} ${bar}`);
}

if (unexplained.length) {
  console.log(`\n  ${unexplained.length} of those had nothing behind them. `
            + 'That is the set worth reading:');
  console.log('    node tools/m59-itemflow.mjs --unexplained' + (WANT_CHAR ? ` --character ${WANT_CHAR}` : ''));
  const who = new Map();
  for (const d of unexplained) who.set(d.character, (who.get(d.character) ?? 0) + 1);
  for (const [c, n] of [...who].sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`      ${String(n).padStart(4)}  ${c}`);
}

function noRowsYet() {
  console.log('  No `left_pack` rows in this window.\n');
  console.log('  That is not the same as nothing having left. The event ships in');
  console.log('  m59-client.mjs (BP_INVENTORY_REMOVE) and is recorded by Session.noteLeftPack,');
  console.log('  and a keeper only picks up new code when the keeper process itself restarts —');
  console.log('  POST /stop on its port, then the broker\'s 45s sweep respawns it from disk.');
  console.log('  Check with: node tools/m59-deploy.mjs --verify');
}
