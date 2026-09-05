#!/usr/bin/env node
// WHERE THE FLEET HAS TO BACK UP TO GO FORWARD — grouped by square, worst first.
//
//   node tools/m59-stucks.mjs              # every square that needed a back-up, last 24h
//   node tools/m59-stucks.mjs --hours 3    # a shorter window
//   node tools/m59-stucks.mjs --room 578   # one room
//   node tools/m59-stucks.mjs --square 46,15 --room 578   # every occurrence at one square
//   node tools/m59-stucks.mjs --json       # for a script
//
// BACKING UP IS A WORKAROUND, AND THIS IS THE LIST OF PLACES IT IS PROPPING UP.
//
// `backUpToUnstick` gets a character out of somewhere the router cannot plan out of by
// walking it back to ground that was working — breadcrumbs, then the square it entered the
// room by, then the room next door. That is the right thing to do at 02:00 with a character
// dying, and it is the wrong thing to still be doing in a month: every firing is a place the
// routing should have handled and did not.
//
// So each one writes a `stuck_backed_up` event, and this reads them back. The question it is
// built to answer is not "how often are we stuck" — the fleet board already says that — but
// WHERE, and with what around it, because a square that needs the workaround forty times is a
// map or a rail that can actually be fixed, and one that needed it once is weather.
//
// The three fields to read first, in this order:
//
//   coarse_walkable  false means the ROUTER cannot plan from that square at all — it is a
//                    pocket, and the fix is the bake or a breadcrumb anchor, not tactics.
//                    true means the router planned and the WALK failed, which is a mover or
//                    a body problem and lives somewhere else entirely.
//   rung             1 means an ordinary bounce that the cheap retreat handled. 3 means
//                    nothing short of leaving the room worked, which is the real trap.
//   monsters         a square that is only ever stuck with something standing two squares
//                    away is a body problem wearing a geometry costume.
//
// It reads the same ledger everything else does and writes nothing.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.M59_LEDGER_DIR || join(HERE, '..', 'substrate', 'history');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
};
const has = name => process.argv.includes('--' + name);

const hours = Number(arg('hours', 24));
const roomWanted = arg('room') === null ? null : Number(arg('room'));
const squareWanted = arg('square');
const since = Date.now() - hours * 3600_000;

if (!existsSync(DIR)) {
  console.error(`no ledger directory at ${DIR}`);
  console.error('The broker writes it as it plays. If a fleet is running, this is the wrong');
  console.error('checkout — read the running broker\'s root from its /health.');
  process.exit(2);
}

const rows = [];
for (const f of readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  let text;
  try { text = readFileSync(join(DIR, f), 'utf8'); } catch { continue; }
  for (const line of text.split('\n')) {
    if (!line || !line.includes('stuck_backed_up')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.kind !== 'stuck_backed_up') continue;
    if (!(o.t >= since)) continue;
    if (roomWanted !== null && Number(o.room) !== roomWanted) continue;
    if (squareWanted && o.square !== squareWanted) continue;
    rows.push(o);
  }
}

if (has('json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

if (!rows.length) {
  console.log(`no back-ups in the last ${hours}h` +
              (roomWanted !== null ? ` in room ${roomWanted}` : '') + '.');
  console.log('\nThat is the good answer. This list is of places the routing needed rescuing.');
  process.exit(0);
}

// One occurrence, in full — for `--square`, where the question is what happened rather than
// how often.
if (squareWanted) {
  console.log(`${rows.length} back-up(s) at ${squareWanted}` +
              (roomWanted !== null ? ` in room ${roomWanted}` : '') + `, last ${hours}h\n`);
  for (const r of rows) {
    console.log(`${r.iso}  ${r.character}  room ${r.room}${r.room_name ? ` (${r.room_name})` : ''}`);
    console.log(`   wanted ${r.wanted ?? '?'}   doing: ${r.doing ?? '?'}   ` +
                `wedged ${Math.round((r.wedged_for_ms ?? 0) / 1000)}s over ${r.repeats ?? '?'} walks`);
    console.log(`   coarse_walkable: ${r.coarse_walkable}   health ${r.health ?? '?'}` +
                `/${r.max_health ?? '?'}` +
                `${r.health_pct != null ? ` (${r.health_pct}%)` : ''}   vigor ${r.vigor ?? '?'}`);
    if (r.entered_via)
      console.log(`   came in by ${r.entered_via.door.col},${r.entered_via.door.row} from room ${r.entered_via.from}`);
    for (const t of r.tried || [])
      console.log(`   rung ${t.rung} ${t.how}: ` +
                  (t.skipped ? `skipped — ${t.skipped}` :
                   `${t.worked ? 'MOVED' : 'no'}${t.reason ? ` (${t.reason})` : ''}`));
    if ((r.monsters || []).length)
      console.log('   monsters: ' + r.monsters.map(m => `${m.name ?? '?'}@${m.d}sq`).join(', '));
    console.log(`   => ${r.freed ? 'freed' : 'STILL STUCK'}` +
                (r.ended ? `, ended in room ${r.ended.room} at ${r.ended.square}` : '') +
                `, ${Math.round((r.took_ms ?? 0) / 1000)}s\n`);
  }
  process.exit(0);
}

// Grouped by square. A square is a place; a character is not.
const bySquare = new Map();
for (const r of rows) {
  const key = `${r.room}:${r.square}`;
  let g = bySquare.get(key);
  if (!g) bySquare.set(key, g = {
    room: r.room, room_name: r.room_name, square: r.square, n: 0,
    freed: 0, chars: new Set(), rungs: new Map(), pocket: 0, known: 0,
    monsters: 0, wanted: new Set(), doing: new Set(), secs: 0,
  });
  g.n++;
  if (r.freed) g.freed++;
  g.chars.add(r.character);
  const top = Math.max(0, ...(r.tried || []).filter(t => t.worked).map(t => t.rung));
  g.rungs.set(top || 'none', (g.rungs.get(top || 'none') || 0) + 1);
  if (r.coarse_walkable === false) g.pocket++;
  if (r.coarse_walkable !== null && r.coarse_walkable !== undefined) g.known++;
  if ((r.monsters || []).length) g.monsters++;
  if (r.wanted != null) g.wanted.add(r.wanted);
  if (r.doing) g.doing.add(r.doing);
  g.secs += (r.took_ms ?? 0) / 1000;
}

const groups = [...bySquare.values()].sort((a, b) => b.n - a.n);
console.log(`${rows.length} back-up(s) at ${groups.length} square(s), last ${hours}h` +
            (roomWanted !== null ? `, room ${roomWanted}` : '') + '\n');
console.log('  n  freed  square        room                       what freed it        why');
console.log('  ─  ─────  ────────────  ─────────────────────────  ───────────────────  ───');
for (const g of groups.slice(0, 40)) {
  const rung = [...g.rungs.entries()].sort((a, b) => b[1] - a[1])[0];
  const how = rung?.[0] === 1 ? 'breadcrumbs'
            : rung?.[0] === 2 ? 'the entry square'
            : rung?.[0] === 3 ? 'the previous room'
            : 'nothing did';
  // The diagnosis, in one word, from the one bit that separates the two different bugs.
  const why = g.known === 0 ? 'unknown'
            : g.pocket === g.known ? 'POCKET — the router cannot plan from it'
            : g.pocket === 0 ? (g.monsters ? 'bodies — the walk failed, not the plan'
                                           : 'the walk failed, not the plan')
            : `mixed (${g.pocket}/${g.known} pocket)`;
  console.log(`  ${String(g.n).padStart(2)}  ${String(g.freed).padStart(5)}  ` +
              `${(g.square ?? '?').padEnd(12)}  ` +
              `${String(g.room + (g.room_name ? ` ${g.room_name}` : '')).slice(0, 25).padEnd(25)}  ` +
              `${how.padEnd(19)}  ${why}`);
}

const stuck = groups.filter(g => g.freed < g.n);
if (stuck.length) {
  console.log(`\n${stuck.length} square(s) where a back-up did NOT free the character. ` +
              'These are the ones that cost a death:');
  for (const g of stuck.slice(0, 10))
    console.log(`  room ${g.room} at ${g.square} — ${g.n - g.freed} of ${g.n} failed`);
}

const worst = groups[0];
if (worst && worst.n > 2) {
  console.log(`\nStart with room ${worst.room} at ${worst.square}: ${worst.n} back-ups, ` +
              `${worst.chars.size} character(s), ${Math.round(worst.secs)}s spent.`);
  console.log(`  node tools/m59-stucks.mjs --room ${worst.room} --square ${worst.square}`);
  console.log(`  node tools/m59-roomview.mjs ${worst.room}      # what the mover sees there`);
}
