#!/usr/bin/env node
// DOES A SCOUT REPORT WHAT IT SAW, AND DOES SILENCE READ AS SILENCE?
//
//   node tools/m59-vanguard-test.mjs
//
// Offline and behavioural — assessRoom is pure and the board is a file, so this runs both
// for real against a temp file. Opens no socket and touches no character.
//
// WHY THIS FILE EXISTS. On 2026-08-30 a three-ship convoy carrying 11,561 shillings set out
// for Tos and none of the three arrived. All three discovered the same obstruction
// independently: room 578, the Cragged Mountains, where a keeper reported
// `stuck: "room capped by creatures we will not fight"` with eight trolls and four black
// spiders in a 43-object room. It is also the fleet's second deadliest room. One scout would
// have learned that once instead of three times.
//
// THE TWO ASSERTIONS THAT MATTER MOST ARE ABOUT ABSENCE:
//   * no report is NOT "clear" — a convoy that reads silence as safety has replaced a
//     vanguard with a delay, which is strictly worse than having neither;
//   * a stale report is marked stale rather than quietly served, because bodies move and a
//     four-minute-old "clear" is a rumour about a room that has since filled up.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-scout-'));
process.env.M59_SCOUT_FILE = join(dir, 'scout-board.json');
const { assessRoom, postScout, readScout, scoutBoard } = await import('./m59-vanguard.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

// The real room 578 snapshot, trimmed: our own Janice, a stranger, trolls and spiders.
const OF_PLAYER = 0x400;                 // include/proto.h — the bit assessRoom's helper needs
const snap = {
  room: { num: 578, name: 'The Cragged Mountains' },
  hp: { value: 48, max: 48 },
  stuck: { why: 'room capped by creatures we will not fight', seconds: 134 },
  exits: [{ to: 826, direction: 'east' }, { to: 579, direction: 'south' },
          { to: 576, direction: 'north' }, { to: 568, direction: 'west' }],
  objects: [
    { id: 4469, name: 'Janice', is_player: true, flags: OF_PLAYER },
    { id: 3292, name: 'Tendrath', is_player: true, flags: OF_PLAYER },
    ...Array.from({ length: 8 }, (_, i) => ({ id: 8080 + i, name: 'troll', is_player: false, flags: 9 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: 8090 + i, name: 'black spider', is_player: false, flags: 9 })),
  ],
};
const mine = new Set(['Janice']);
const isFleetmate = (n) => mine.has(n);

console.log('a scout reports what it saw');
{
  const a = assessRoom(snap, { isFleetmate, toward: 576 });
  ok('it counts creatures by name', a.creature_total === 12 &&
     a.creatures[0].name === 'troll' && a.creatures[0].n === 8);
  ok('it separates fleetmates from strangers', !a.strangers.includes('Janice') &&
     a.strangers.includes('Tendrath'));
  // The keeper's own verdict is the cheapest true hazard signal in the snapshot and the one
  // that actually stopped the convoy. Forwarding it costs nothing.
  ok('it forwards the keeper\'s own reason', /capped by creatures/.test(a.stuck_why));
  ok('it names the exit the convoy wanted', a.exit_wanted?.to === 576 && !a.exit_missing);
  ok('and says so when that exit is not there',
     assessRoom(snap, { isFleetmate, toward: 999 }).exit_missing === true);
}

console.log('\nbut a stranger is not an enemy');
{
  const a = assessRoom(snap, { isFleetmate, toward: 576 });
  // Most people on a shared server are just people. Treating every stranger as a hazard makes
  // the fleet useless and rude; only the SERVER's own killer/outlaw class counts.
  ok('an ordinary stranger is not an aggressor', a.strangers.length === 1 && a.aggressors.length === 0);
  // PF_* is an ENUM, not a bitmask (m59-parse.mjs:72) — PF.DM is exactly KILLER|OUTLAW, so a
  // bit test flags every Dungeon Master. assessRoom must go through flaggedAggressor.
  ok('and the flag test is not a bit test', (() => {
    const dm = { ...snap, objects: [{ id: 1, name: 'AnAdmin', is_player: true, flags: OF_PLAYER | 0xC000 }] };
    return assessRoom(dm, { isFleetmate: () => false }).aggressors.length === 0;
  })(), 'a Dungeon Master is being reported as an aggressor');
}

console.log('\nthe board crosses processes, and absence is absence');
{
  // m59-party.report() is per-process memory and every keeper is its own process, so a scout
  // using it would report into a void. This is a file for exactly that reason.
  ok('nothing is known before anyone looks', readScout(578) === null);
  postScout('t20', assessRoom(snap, { isFleetmate, toward: 576 }));
  const w = readScout(578);
  ok('a posted report reads back', !!w && w.room === 578 && w.by === 't20');
  ok('it is marked fresh', w.stale === false && w.age_ms < 5000);
  // THE ASSERTION THE WHOLE DESIGN TURNS ON.
  ok('a room nobody scouted answers null, NOT clear', readScout(999) === null);
  const old = readScout(578, { staleMs: 1, now: Date.now() + 10_000 });
  ok('and an old report is served marked stale rather than quietly', old.stale === true);
  ok('the board lists what is known, newest first', scoutBoard().length === 1);
}

console.log('\nit describes, it does not command');
{
  const a = assessRoom(snap, { isFleetmate, toward: 576 });
  // A scout that returns HOLD bakes one fleet's risk appetite into a shared tool. The next
  // caller with a 20-health mule wants a different answer from the same facts.
  ok('no verdict field is produced', a.verdict === undefined && a.hold === undefined);
  ok('only observations are', ['creatures', 'strangers', 'aggressors', 'stuck_why', 'exits']
     .every(k => k in a));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
