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

import { sectorsInSource, groupsInSource, gatesMovement, headroomRisk,
         MAX_STEP_HEIGHT, PLAYER_HEIGHT } from './m59-varsectors.mjs';

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

console.log('\na moving CEILING is a question for the bake, not an answer from the kod');
{
  // The correction that made this list usable. A ceiling gates when `ceiling - floor` drops
  // under PLAYER_HEIGHT, and the kod does not say what the floor is — so judging a ceiling
  // with the floor's rule marked 59 of 109 sectors as doors, which nobody can act on.
  ok('the headroom a character needs is the figure the client itself uses', PLAYER_HEIGHT === 768);
  ok('a ceiling is never called a definite gate from the kod alone',
     gatesMovement([284, 348], 'ceiling') === false);
  ok('but a moving ceiling IS flagged for the bake to decide',
     headroomRisk([284, 348], 'ceiling') === true);
  ok('the Temple of Qor door is exactly that case — room 598, ANIMATE_CEILING_LIFT',
     gatesMovement([284, 348], 'ceiling') === false &&
     headroomRisk([284, 348], 'ceiling') === true);
  ok('a ceiling that never moves asks nothing', headroomRisk([348], 'ceiling') === false);
  ok('a sector moved as both floor and ceiling is judged by the floor rule AND flagged',
     gatesMovement([356, 420], 'both') === true && headroomRisk([356, 420], 'both') === true);
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
      Qor()
      {
         send(self,@setsector,#sector=9,#animation=ANIMATE_CEILING_LIFT,
                   #height = 348, #speed = 8);
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
  ok('the floor door is classified as a floor', closed?.kind === 'floor');

  // LOWERCASE `@setsector` AND A SPACED `#height = 348`. kod is not case-sensitive about
  // message names and i8.kod writes it in lower case — matching only `@SetSector` dropped
  // the Temple of Qor door silently, and an empty result reads as "no doors in this room".
  const qor = found.find(s => s.sector === 9);
  ok('a lowercase @setsector is still found', !!qor, JSON.stringify(found.map(f => f.sector)));
  ok('and a spaced `#height = 348` is read', qor?.heights?.includes(348) === true);
  ok('and it is classified as a CEILING, which is judged differently',
     qor?.kind === 'ceiling');
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

console.log('\nthe states this world sets TOGETHER, which are branches and not messages');
{
  // duke2.kod's shape, reduced: every door in ONE message, and the feast hall's two states
  // are the two halves of an if/else inside it. Grouping by message finds nothing here,
  // because every sector then has two heights and gets filtered as a sequence — which is
  // exactly what a first attempt did, reporting zero states in a file that has two.
  const src = `
   constants:
      FEAST_DOOR_CLOSED = 3
      FEAST_DOOR_OPEN = 4

   messages:

   SomethingTryGo(what = $,row = $,col = $)
   {
      % wood door to the west wing
      if row >= 9 AND row <= 10 AND col = 14
      {
         if NOT Send(hall,@IsLocked)
         {
            Send(self,@SetSector,#sector=FEAST_DOOR_OPEN,
                 #animation=ANIMATE_FLOOR_LIFT,#height=356,#speed=0);
            Send(self,@SetSector,#sector=FEAST_DOOR_CLOSED,
                 #animation=ANIMATE_FLOOR_LIFT,#height=420,#speed=0);
         }
         else
         {
            Send(self,@SetSector,#sector=FEAST_DOOR_CLOSED,
                 #animation=ANIMATE_FLOOR_LIFT,#height=356,#speed=0);
            Send(self,@SetSector,#sector=FEAST_DOOR_OPEN,
                 #animation=ANIMATE_FLOOR_LIFT,#height=419,#speed=0);
         }
      }
      propagate;
   }
`;
  const groups = groupsInSource(src);
  ok('both halves of the if/else are found, as two separate states',
     groups.length === 2, JSON.stringify(groups.map(g => g.states.map(s => `${s.sector}@${s.height}`))));
  const keys = groups.map(g => g.states.map(s => `${s.sector}@${s.height}`).join('+'));
  ok('the shut one is the pair the .roo ships', keys.includes('3@420+4@356'), keys.join(' | '));
  ok('and the open one is the pair that lets a character in', keys.includes('3@356+4@419'));

  // THE BUG THAT LOST THE ONE DOOR THIS WAS WRITTEN FOR. `FEAST_DOOR_OPEN = 4` is declared
  // in the file's header, and a block two hundred lines away cannot resolve it from its own
  // text. Reading constants per block found nothing and dropped room 951 in silence.
  ok('a sector named by a file-level constant still resolves inside a nested block',
     groups.every(g => g.states.every(s => Number.isInteger(s.sector))),
     JSON.stringify(groups));

  // Braces inside a kod comment must not nest the whole file, or every send ends up in one
  // enormous block and no state has a boundary.
  const commented = groupsInSource(`
   constants:
      A = 1
      B = 2
   Go()
   {
      % a comment with an unbalanced { in it
      if x
      {
         Send(self,@SetSector,#sector=A,#animation=ANIMATE_FLOOR_LIFT,#height=100,#speed=0);
         Send(self,@SetSector,#sector=B,#animation=ANIMATE_FLOOR_LIFT,#height=500,#speed=0);
      }
   }
`);
  ok('a brace inside a comment does not swallow the file',
     commented.length === 1 && commented[0].states.length === 2,
     JSON.stringify(commented));

  ok('a branch that moves only one sector is not a multi-sector state',
     groupsInSource(`
   Go()
   {
      Send(self,@SetSector,#sector=7,#animation=ANIMATE_FLOOR_LIFT,#height=100,#speed=0);
   }
`).length === 0);

  // A branch that sets the same sector twice is animating it, not holding a position.
  ok('a sector set twice in one branch is a sequence, not a state',
     groupsInSource(`
   Go()
   {
      Send(self,@SetSector,#sector=7,#animation=ANIMATE_FLOOR_LIFT,#height=100,#speed=0);
      Send(self,@SetSector,#sector=7,#animation=ANIMATE_FLOOR_LIFT,#height=500,#speed=0);
      Send(self,@SetSector,#sector=8,#animation=ANIMATE_FLOOR_LIFT,#height=100,#speed=0);
   }
`).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
