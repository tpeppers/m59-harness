#!/usr/bin/env node
// THE DOORS THAT ARE FLOORS — offline, no server, no kod required for the pure parts.
//
//   node tools/m59-varsectors-test.mjs
//
// What this pins, in order of how expensive being wrong would be:
//
//   * a sector that crosses MAX_STEP_HEIGHT is a DOOR and is marked as one — that is the
//     whole difference between "the bake is a bit stale" and "there is a wall here that
//     does not exist and nothing downstream can tell";
//   * a sector that only ever moves below the limit is NOT marked, so the list stays short
//     enough to act on — 109 sectors move in this world and only 12 gate anybody;
//   * a sector named by a constant keeps its name, because `FEAST_DOOR_CLOSED` says what
//     the number is for and `3` does not;
//   * `#height` is found even though the animation argument sits between it and `#sector`.

import { sectorsInSource, gatesMovement, MAX_STEP_HEIGHT } from './m59-varsectors.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('\na sector is a door when it crosses the step limit, and scenery when it does not');
{
  ok('the step limit is the client-unit one the walker enforces', MAX_STEP_HEIGHT === 384);
  ok('356 -> 420 is a door: one either side of 384',
     gatesMovement([356, 420]) === true);
  ok('208 -> 300 is not: a character can climb both',
     gatesMovement([208, 300]) === false);
  ok('and neither is a floor that never moves at all',
     gatesMovement([270]) === false);
  // EXACTLY 384 IS THE CLOSED SIDE. `MAX_STEP_HEIGHT` is the largest step that is allowed,
  // so a floor AT it is still climbable — but a sector that reaches it from below has
  // crossed into the range where one more unit stops a character, and this list exists to
  // be looked at rather than to be exactly right about a boundary nobody builds on.
  ok('a sector that reaches the limit from below counts as gating',
     gatesMovement([100, 384]) === true);
}

console.log('\nthe kod is read for what it says, not for what a door usually looks like');
{
  const src = `
   constants:
      FEAST_DOOR_CLOSED = 3
      FEAST_DOOR_OPEN = 4
   messages:
      Open()
      {
         Send(self,@SetSector,#sector=FEAST_DOOR_CLOSED,
              #animation=ANIMATE_FLOOR_LIFT,#height=356,#speed=0);
         Send(self,@SetSector,#sector=FEAST_DOOR_OPEN,
              #animation=ANIMATE_FLOOR_LIFT,#height=419,#speed=0);
         return;
      }
      Close()
      {
         Send(self,@SetSector,#sector=FEAST_DOOR_CLOSED,
              #animation=ANIMATE_FLOOR_LIFT,#height=420,#speed=0);
         return;
      }
`;
  const found = sectorsInSource(src);
  const closed = found.find(s => s.sector === 3);
  ok('a sector named by a constant is resolved to its number', !!closed, JSON.stringify(found));
  ok('and keeps the name, which is the half that says what it is for',
     closed?.name === 'FEAST_DOOR_CLOSED');
  ok('every height it is ever set to is collected, sorted',
     JSON.stringify(closed?.heights) === JSON.stringify([356, 420]),
     JSON.stringify(closed?.heights));
  ok('so the door is recognised across two different messages',
     gatesMovement(closed.heights) === true);
  ok('the animation argument between #sector and #height does not hide it',
     found.find(s => s.sector === 4)?.heights?.includes(419) === true);
  ok('it cites the lines, because a table of doors nobody can check is a rumour',
     Array.isArray(closed?.cite_lines) && closed.cite_lines.length > 0);
}

console.log('\nan unresolvable sector is dropped rather than guessed at');
{
  // A `#sector=SOMETHING_FROM_ANOTHER_FILE` we cannot resolve must not become sector NaN
  // and must not become sector 0 — sector 0 is a real sector.
  const found = sectorsInSource(`
      Send(self,@SetSector,#sector=SOMETHING_ELSEWHERE,#animation=4,#height=400);
      Send(self,@SetSector,#sector=7,#animation=4,#height=400);
  `);
  ok('the unresolvable one is not reported', !found.some(s => Number.isNaN(s.sector)));
  ok('and the literal one still is',
     found.length === 1 && found[0].sector === 7, JSON.stringify(found));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
