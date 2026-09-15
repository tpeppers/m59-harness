#!/usr/bin/env node
// WHERE THE FLEET GRINDS AGAINST WALLS, AND FOR HOW LONG — grouped by square, worst first.
//
//   node tools/m59-grinds.mjs                  every grinding square, last 24h
//   node tools/m59-grinds.mjs --hours 3        a shorter window
//   node tools/m59-grinds.mjs --room 578       one room
//   node tools/m59-grinds.mjs --kind shuffle   only the oscillations
//   node tools/m59-grinds.mjs --roll           append the roll-up to the permanent record
//   node tools/m59-grinds.mjs --json           for a script
//
// THE SISTER OF `m59-stucks.mjs`, AND THE DIFFERENCE IS THE ONLY REASON IT EXISTS. That one
// groups `stuck_backed_up` firings — how OFTEN a square needed the back-up workaround. This one
// groups EPISODES — how LONG a character spent against a wall or bouncing between two squares.
//
// The operator asked the question that separates them, 2026-09-11: *"are units just grinding
// against walls for hours?"* Forty bounces in a minute and forty minutes of unbroken contact
// produce the same count and want completely different fixes — a rail that needs moving versus
// a character that has been in a corner since before lunch.
//
// SORTED BY TOTAL TIME, NOT BY COUNT, for the same reason the roll-up keeps p50 and p90 rather
// than a mean: hundreds of two-second bounces and one forty-minute grind average to something
// unremarkable, and the forty-minute one is the entire finding. Count is shown; it is not the
// order.
//
// READ THE `worst` COLUMN FIRST. A square with a big total and a small worst is friction —
// everybody scrapes past it, nobody is trapped. A square whose worst is most of its total is a
// TRAP: one character went in and did not come out, and the rest of the number is noise around
// it. Those are different bugs and the column is what tells them apart at a glance.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregate } from './m59-wallgrind.mjs';
import { epochFor } from './m59-epoch.mjs';
import { roll, rollWatermark } from './m59-scratch.mjs';
import { ledgerDirFor, fleetName } from './m59-fleetpath.mjs';

// THE LEDGER LIVES UNDER THE FLEET, AND READING ONE LEVEL TOO HIGH IS A SILENT ALL-CLEAR.
//
// Rows are written to `substrate/history/<fleet>/fleet-YYYY-MM-DD.jsonl`. A reader that globs
// `substrate/history/*.jsonl` finds NOTHING -- not an error, not an empty directory warning,
// just zero rows -- and then prints its own cheerful "none found" line.
//
// Measured 2026-09-11: `m59-stucks.mjs` answered "no back-ups in the last 72h. That is the good
// answer." while the same window held 354 back-ups at 186 squares. It had been reassuring
// everybody who ran it. `ledgerDirFor(fleetName())` is the ledger's own resolution and the only
// one that can be right for both fleets on this machine.
const DIR = process.env.M59_LEDGER_DIR || ledgerDirFor(fleetName());
const KINDS = new Set(['wall_contact', 'shuffle']);

/** Every episode event in the window. Cheap string test before the JSON parse, as m59-stucks does. */
export function readEpisodes({ since = 0, room = null, kind = null, dir = DIR } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return out; }
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || (!line.includes('wall_contact') && !line.includes('shuffle'))) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!KINDS.has(o.kind)) continue;
      if (kind && o.kind !== kind) continue;
      if ((o.t ?? 0) < since) continue;
      if (room !== null && Number(o.room) !== Number(room)) continue;
      out.push(o);
    }
  }
  return out;
}

const ms = v => (v >= 3600_000 ? `${(v / 3600_000).toFixed(1)}h`
              : v >= 60_000 ? `${Math.round(v / 60_000)}m` : `${Math.round(v / 1000)}s`);

function main(argv) {
  const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const has = n => argv.includes('--' + n);
  const hours = Number(arg('hours', 24));
  const room = arg('room') != null ? Number(arg('room')) : null;
  const kind = arg('kind');
  const since = Date.now() - hours * 3600_000;

  const eps = readEpisodes({ since, room, kind });
  const ep = epochFor('movement');
  const rolled = aggregate(eps, { epoch: ep?.ref ?? null });

  // A ROLL-UP THAT CAN BE RUN TWICE IS NOT A RECORD, IT IS A RUMOUR. `--roll` appends, so
  // running it twice over overlapping windows counts the same episodes again -- and the thing
  // being corrupted is the half that is kept for ever and compared across versions of the
  // mover. The watermark is the timestamp of the newest episode already rolled; only episodes
  // strictly after it are eligible.
  const mark = rollWatermark();
  const fresh = eps.filter(e => (e.t ?? 0) > mark);

  if (has('json')) { console.log(JSON.stringify({ hours, epoch: ep?.ref ?? null, buckets: rolled }, null, 2)); return 0; }

  if (!rolled.length) {
    console.log(`no wall-grinding recorded in the last ${hours}h` +
                (room !== null ? ` in room ${room}` : '') +
                (kind ? ` of kind ${kind}` : '') + '.');
    // AN EMPTY REPORT HAS TWO CAUSES AND THEY ARE NOT THE SAME NEWS. Saying so here is the
    // difference between "the fleet is walking cleanly" and "nothing is writing these events",
    // which is precisely the confusion that let `purpose` sit out of a schema for a year with
    // every keeper's audit switched off.
    console.log('\nThat is either a clean fleet or an instrument that is not running. The events' +
                '\nare written by the keeper pulse — if this is always empty, check that the' +
                '\ntracker is wired in rather than concluding the roads are fine.');
    return 0;
  }

  console.log(`${eps.length} episode(s) at ${rolled.length} square(s), last ${hours}h` +
              (room !== null ? `, room ${room}` : '') +
              `\nmovement epoch ${ep?.ref ? String(ep.ref).slice(0, 9) : 'unknown'}` +
              `${ep?.dirty ? ' (DIRTY — uncommitted movement code)' : ''}\n`);
  console.log('  total    worst    n   p90     kind          where            reason');
  for (const b of rolled.slice(0, Number(arg('limit', 30)))) {
    const trap = b.ms_max > b.ms_total * 0.6 && b.count > 1 ? ' <- one long one' : '';
    console.log(`  ${ms(b.ms_total).padStart(7)}  ${ms(b.ms_max).padStart(6)} ${String(b.count).padStart(4)}  ` +
                `${ms(b.ms_p90).padStart(6)}  ${b.kind.padEnd(13)} ` +
                `${String(b.room + ' r' + b.row + 'c' + b.col).padEnd(16)} ` +
                `${String(b.reason ?? '').slice(0, 22)}${trap}`);
  }

  if (has('roll')) {
    const rollable = aggregate(fresh, { epoch: ep?.ref ?? null });
    if (!rollable.length) {
      console.log(`\nnothing new to roll — all ${eps.length} episode(s) in this window are ` +
                  `already in the permanent record (watermark ` +
                  `${mark ? new Date(mark).toISOString().slice(0, 16) : 'none'}).`);
      return 0;
    }
    const r = roll(rollable, { watermark: Math.max(...fresh.map(e => e.t ?? 0)) });
    console.log(`\nrolled ${r.written} bucket(s) from ${fresh.length} new episode(s) into the ` +
                `permanent record, keyed to epoch ` +
                `${ep?.ref ? String(ep.ref).slice(0, 9) : 'unknown'}.` +
                '\nFine episodes still expire; these do not. `m59-scratch.mjs epochs` compares versions.');
  } else {
    console.log('\n`--roll` appends this to the permanent, epoch-keyed record. Without it, this ' +
                'reading\nexpires with the ledger it was read from.');
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  process.exit(main(process.argv.slice(2)));
