#!/usr/bin/env node
// IS THIS REFUSAL A DOOR? — offline, no fleet, no kod required for the pure parts.
//
//   node tools/m59-doorplan-test.mjs
//
// What this pins is the sentence the router now gets to say. "No exit progresses" was true
// and complete about the state the bake holds, and read as "this room has no way out" — for
// hours, with two characters standing on the button. The difference between those two
// readings is this module, so the cases below are the ones where being wrong puts a body back
// on that square: a trigger expanded one square off, a gate not reported, a room without
// doors given an opinion it should not have.
import { triggerSquares, pressPlan, doorsFor, operableDoorsBlocking, loadDoors } from './m59-doorplan.mjs';

let pass = 0, fail = 0, skip = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? ' — ' + detail : '')); }
};

const SIZE = { rows: 49, cols: 52 };
const MAIN = { sector: 59, sector_name: 'MAIN_DOOR', kind: 'ceiling', open: 190, closed: 100,
               delay_ms: 5000, gate: 'ReqLegalEntry',
               when: [{ axis: 'row', op: '==', value: 4 }, { axis: 'col', op: '==', value: 28 }] };
const HALL = { sector: 55, sector_name: 'HALL_DOOR', kind: 'ceiling', open: 230, closed: 160,
               delay_ms: 5000, gate: null,
               when: [{ axis: 'row', op: '==', values: [18, 19] }, { axis: 'col', op: '==', value: 10 }] };
const COUNTER = { sector: 58, sector_name: 'COUNTER_DOOR', kind: 'ceiling', open: 190, closed: 100,
                  delay_ms: 5000, gate: null,
                  when: [{ axis: 'row', op: '==', values: [2, 3] },
                         { axis: 'col', op: '>=', value: 19 }, { axis: 'col', op: '<=', value: 21 }] };
const TABLE = { rooms: { 714: { name: "The Bookmaker's Guild House", ...SIZE,
                                doors: [MAIN, HALL, COUNTER] } } };

console.log('\nexpanding a trigger predicate into squares');
{
  const one = triggerSquares(MAIN, SIZE);
  ok('a single square is a single square', one.length === 1);
  // ONE SQUARE OFF IS A BODY PRESSING NOTHING. This is the square Zoot and Statler stood on.
  ok('and it is r4c28 exactly', one[0].row === 4 && one[0].col === 28, JSON.stringify(one[0]));

  // SAME-AXIS EQUALITIES ARE ALTERNATIVES. Read as a conjunction this is `row == 18 AND
  // row == 19`, which is no square at all — the door would vanish rather than misfire.
  const two = triggerSquares(HALL, SIZE);
  ok('two alternative rows give two squares, not none',
     two.length === 2 && two.every(s => s.col === 10), JSON.stringify(two));

  const range = triggerSquares(COUNTER, SIZE);
  ok('a range on one axis crosses with alternatives on the other', range.length === 6,
     String(range.length));
  ok('and every square is inside the range', range.every(s => s.col >= 19 && s.col <= 21));

  // A predicate that leaves the room is clipped rather than inventing squares off the map.
  ok('a trigger outside the room bounds yields nothing',
     triggerSquares(MAIN, { rows: 2, cols: 2 }).length === 0);
  ok('and a room with no size is not guessed at',
     triggerSquares(MAIN, {}).length === 0);
}

console.log('\nthe three-step plan');
{
  const p = pressPlan(MAIN, SIZE);
  // THE WAIT IS AN EVENT, NOT A DURATION. A geometry read taken mid-swing sees a shut door,
  // which is the race that reads as "there is no way out of this room".
  ok('it waits for the server to say the sector moved', p.wait_for.event === 'sector-height');
  ok('and names the sector and the height it must reach',
     p.wait_for.sector === 59 && p.wait_for.reaches === 190);
  // The close timer starts at the PRESS, so the animation eats into the window.
  ok('the window is the door\'s own close delay', p.within_ms === 5000);
  ok('and a door that does not shut itself says so',
     pressPlan({ ...MAIN, delay_ms: null }, SIZE).shuts_itself === false);
  ok('the gate is carried, so an outsider is not sent at it', p.gate === 'ReqLegalEntry');
}

console.log('\nwhat a body standing somewhere can work');
{
  const on = doorsFor(714, { row: 4, col: 28 }, { table: TABLE });
  ok('a body ON a trigger is told which door it is standing on',
     on.on.length === 1 && on.on[0].sector === 59);
  ok('and the rest of the room\'s doors are still offered', on.others.length === 2);

  const off = doorsFor(714, { row: 20, col: 18 }, { table: TABLE });
  ok('a body elsewhere is standing on nothing', off.on.length === 0);
  ok('but the room\'s doors are all still there to walk to', off.others.length === 3);

  ok('the gated doors are named, whoever is asking', on.gated.some(g => g.sector === 59));
}

console.log('\nthe question the router asks');
{
  const standing = operableDoorsBlocking(714, { row: 4, col: 28 }, { table: TABLE });
  ok('a room with doors is never "no way out"', standing !== null);
  ok('and when the body is on the trigger it says so first',
     standing.standing_on.join() === '59', JSON.stringify(standing.standing_on));
  ok('in words a reader can act on rather than a verdict',
     /standing ON the trigger/.test(standing.why) && /are shut/.test(standing.why), standing.why);

  const elsewhere = operableDoorsBlocking(714, { row: 20, col: 18 }, { table: TABLE });
  ok('a body elsewhere in the same room still learns the room has doors',
     elsewhere !== null && elsewhere.standing_on.length === 0);
  ok('and is told the refusal is about the BAKED STATE, not the room',
     /fact about that state/.test(elsewhere.why), elsewhere.why);

  // THE IMPORTANT NEGATIVE. Every other room in the world must keep its existing verdict
  // untouched, or this turns one silent failure into a world of noisy ones.
  ok('a room with no doors gets no opinion at all',
     operableDoorsBlocking(39, { row: 1, col: 1 }, { table: TABLE }) === null);
  ok('and neither does a room the table has never heard of',
     operableDoorsBlocking(99999, null, { table: TABLE }) === null);
  // A missing table is an absence, not a crash: a fresh clone has no substrate.
  ok('no door table at all is simply no doors',
     operableDoorsBlocking(714, null, { table: null }) === null);
}

console.log('\nagainst the real derived table');
{
  const real = loadDoors();
  if (!real) { skip++; console.log('  --   substrate/m59-doors.json is not in this checkout'); }
  else {
    const d = operableDoorsBlocking(714, { row: 4, col: 28 });
    ok('714 is in the shipped table and knows its six doors',
       d !== null && d.doors.length === 6, String(d?.doors.length));
    ok('and a body on r4c28 is standing on MAIN_DOOR, the one the exit is behind',
       d.standing_on.join() === '59', JSON.stringify(d?.standing_on));
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
