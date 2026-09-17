#!/usr/bin/env node
// Offline. Opens no socket, touches no roster, writes into no fleet's history.
//
//   node tools/m59-savelog-test.mjs
//
// WHAT THIS PINS, AND WHY IT EXISTS AT ALL.
//
// `m59-savelog.mjs` is a reader, and a reader's failure mode is not a crash — it is a number
// that is wrong while everything around it still adds up. The first draft of it counted
// `k.what ?? k.target ?? k.name` for a kill against a ledger whose field is `creature`: every
// total correct, every breakdown empty, and nothing anywhere saying so. Two death splits were
// invented outright.
//
// So every case below is a shape that would otherwise read as a healthy fleet:
//
//   1  twenty-three keepers announcing one save are one boundary, not twenty-three
//   2  two saves further apart than the tolerance are two boundaries
//   3  a kill is attributed to `creature` — the exact bug above, pinned
//   4  a kind nothing counts is NAMED rather than dropped
//   5  a death nobody classified makes the travel rate `null`, never 0.0
//   6  a death that WAS classified produces a real rate
//   7  PVP shown and PVP guessed never merge
//   8  a window takes its own events and not the next window's
import assert from 'node:assert/strict';
import { boundaries, window, COUNTED, COLLAPSE_MS } from './m59-savelog.mjs';

let n = 0;
const ok = (c, why) => { n++; assert.ok(c, why); };
const eq = (a, b, why) => { n++; assert.deepEqual(a, b, why); };

const T = Date.parse('2026-09-17T12:00:00Z');
const row = (t, kind, extra = {}) => ({ t, type: 'event', kind, character: 'Alpha', ...extra });

// ---------------------------------------------------------------- 1, 2  the boundary
{
  // Twenty-three keepers each write the marker within a couple of seconds of each other.
  const burst = [];
  for (let i = 0; i < 23; i++)
    burst.push({ ...row(T + i * 300, 'server_save', { phase: 'begin' }), character: `C${i}` });
  // ...and the next save, well past the tolerance.
  const later = T + COLLAPSE_MS * 4;
  for (let i = 0; i < 23; i++)
    burst.push({ ...row(later + i * 300, 'server_save', { phase: 'begin' }), character: `C${i}` });

  const marks = boundaries(burst);
  eq(marks.length, 2, 'twenty-three keepers announcing two saves are two boundaries');
  eq(marks[0].saw, 23, 'the boundary remembers how many keepers saw it');
  eq(marks[0].at, T, 'the boundary is the FIRST marker, not the last — the save began then');

  // A marker exactly at the tolerance is a new save. This is the edge that decides whether a
  // slow keeper's late UNWAIT invents a zero-length window, so it is pinned rather than left
  // to whichever way the comparison happens to fall.
  const edge = boundaries([row(T, 'server_save', { phase: 'begin' }),
                           row(T + COLLAPSE_MS, 'server_save', { phase: 'begin' })]);
  eq(edge.length, 2, 'a marker at exactly the tolerance opens a new window');

  // `end` rows are not boundaries. Both phases are recorded, and counting the pair would
  // double every window in the file.
  eq(boundaries([row(T, 'server_save', { phase: 'end' })]).length, 0,
     'BP_UNWAIT closes a save; it does not open a window');
}

// ---------------------------------------------------------------- 3  the field-name bug
{
  const rows = [
    row(T + 1, 'killed', { creature: 'zombie', room_num: 39 }),
    row(T + 2, 'killed', { creature: 'zombie', room_num: 39 }),
    row(T + 3, 'killed', { creature: 'battered skeleton', room_num: 38 }),
  ];
  const w = window(rows, T, T + 1000);
  eq(w.kills, 3, 'three kills');
  eq(w.kills_by_quarry, { zombie: 2, 'battered skeleton': 1 },
     'kills are attributed to `creature` — the field the ledger actually writes');
  ok(!('unnamed' in w.kills_by_quarry),
     'THE REGRESSION: reading the wrong field files every kill as "unnamed" while the total '
     + 'stays correct, which is invisible in any summary that only prints the total');
  eq(w.kills_by_room, { 39: 2, 38: 1 }, 'and to the room they happened in');
}

// ---------------------------------------------------------------- 4  nothing goes uncounted
{
  const w = window([row(T + 1, 'killed', { creature: 'rat' }),
                    row(T + 2, 'a_kind_nobody_taught_this_reader')], T, T + 1000);
  eq(w.unaccounted, ['a_kind_nobody_taught_this_reader'],
     'an unknown kind is NAMED. Silently ignoring it is how a renamed event turns into a '
     + 'quieter fleet that nobody can account for');
  eq(window([row(T + 1, 'killed', { creature: 'rat' })], T, T + 1000).unaccounted, [],
     'and a window of known kinds reports nothing, so the line means something when it appears');
  for (const k of COUNTED)
    ok(!window([row(T + 1, k)], T, T + 1000).unaccounted.includes(k),
       `COUNTED lists ${k}, so the reader must not report it as unaccounted`);
}

// ---------------------------------------------------------------- 5, 6, 7  the death splits
{
  // Nine deaths, none of them classified — the shape of every row written before
  // `was_travelling` was added to the ledger.
  const old = [];
  for (let i = 0; i < 9; i++) old.push(row(T + i, 'died', { killed_by: 'spider' }));
  for (let i = 0; i < 100; i++) old.push(row(T + 100 + i, 'travel_journey', { arrived: true, ms: 1000 }));
  const w = window(old, T, T + 1000);
  eq(w.deaths, 9, 'nine deaths');
  eq(w.deaths_unclassified, 9, 'and all nine are unclassified, not "not travelling"');
  eq(w.deaths_travelling, 0, 'so none can be claimed as travel deaths');
  eq(w.deaths_per_1000_journeys, null,
     'AND THE RATE IS null, NEVER 0. "0.0 travel deaths per thousand journeys" from a window '
     + 'where nothing was classified is exactly the false green this file exists to refuse');

  // One classified travel death among a hundred journeys is a real rate.
  const live = [row(T, 'died', { killed_by: 'spider', was_travelling: true }),
                row(T + 1, 'died', { killed_by: 'zombie', was_travelling: false })];
  for (let i = 0; i < 100; i++) live.push(row(T + 100 + i, 'travel_journey', { arrived: true, ms: 1000 }));
  const v = window(live, T, T + 1000);
  eq(v.deaths_travelling, 1, 'the classified travel death is counted');
  eq(v.deaths_unclassified, 0, 'and nothing is left unclassified');
  eq(v.deaths_per_1000_journeys, 10, '1 travel death in 100 journeys is 10 per thousand');

  // PVP: shown and guessed are different claims and never merge. Reading one as the other is
  // how six trolls became a PVP death.
  const pvp = window([
    row(T, 'died', { was_killed_by_player: true, killed_by_player_is_a_guess: false }),
    row(T + 1, 'died', { was_killed_by_player: true, killed_by_player_is_a_guess: true }),
    row(T + 2, 'died', { was_killed_by_player: false, killed_by_player_is_a_guess: false }),
  ], T, T + 1000);
  eq(pvp.deaths_pvp_shown, 1, 'a shown PVP death is one that was NOT a guess');
  eq(pvp.deaths_pvp_guessed, 1, 'a guessed one stays labelled as a guess');
  eq(pvp.deaths, 3, 'and the total is still every death');

  // A death at a wall we promised was safe. `false` means it was asked and the answer was no;
  // only a real object counts, so a `null` (nobody asked) can never inflate this.
  const wall = window([
    row(T, 'died', { at_a_safe_wall: { at: { col: 1, row: 2 }, held_for_s: 30 } }),
    row(T + 1, 'died', { at_a_safe_wall: false }),
    row(T + 2, 'died', { at_a_safe_wall: null }),
  ], T, T + 1000);
  eq(wall.deaths_at_a_safe_wall, 1,
     'only a death actually ON a safe wall counts — the falsifiable claim is that it is PVP');
}

// ---------------------------------------------------------------- 8  windows do not bleed
{
  const rows = [
    row(T + 10, 'killed', { creature: 'rat' }),
    row(T + 5000, 'killed', { creature: 'bat' }),
  ];
  const a = window(rows, T, T + 1000);
  const b = window(rows, T + 1000, T + 9000);
  eq(a.kills, 1, 'the first window takes its own kill');
  eq(b.kills, 1, 'and the second takes the other');
  eq(a.kills_by_quarry, { rat: 1 }, 'and does not reach forward into the next window');
  eq(b.kills_by_quarry, { bat: 1 }, 'nor back into the last');
  // `from` inclusive, `to` exclusive — so two adjacent windows partition rather than overlap.
  // An event landing in both would be counted twice across a day of them.
  eq(window(rows, T + 10, T + 5000).kills, 1, 'from is inclusive, to is exclusive');
}

// ---------------------------------------------------------------- journeys as a denominator
{
  const rows = [];
  for (let i = 0; i < 10; i++)
    rows.push(row(T + i, 'travel_journey',
                  { arrived: i < 7, ms: (i + 1) * 1000, stumbles: i,
                    legs: i === 9 ? 5 : 3, planned_legs: 3, hp_start: 50, hp_end: 50 - i }));
  const w = window(rows, T, T + 1000);
  eq(w.journeys, 10, 'ten journeys');
  eq(w.journeys_arrived, 7, 'seven arrived');
  eq(w.arrival_rate_pct, 70, 'which is the rate two builds get compared on');
  eq(w.journey_ms_p50, 4000, 'p50 over the ARRIVED journeys only — an abandoned one has no duration');
  eq(w.journey_stumbles, 45, 'stumbles sum across every journey, arrived or not');
  eq(w.journeys_over_plan, 1, 'a journey that took more legs than it planned is a route that was wrong');
  eq(w.journey_hp_lost, 45, 'and the health it cost to get there');
}

console.log(`m59-savelog-test: ${n} assertions passed`);
