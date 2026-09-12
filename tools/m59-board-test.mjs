#!/usr/bin/env node
// THE SCRATCHPAD CORK BOARD. Offline: no broker, no server, no fleet — a temp directory is the
// board.
//
//   node tools/m59-board-test.mjs
//
// The three things the board is for, in the order they were asked for, and each pinned here:
//
//   1. YOU CAN SEE WHAT IS DRIVING THE FLEET. A pad is invisible to the fleet REPL by design and
//      untracked by design; together that made scratchpads unobservable, and two sessions built
//      the same tool all night without seeing each other.
//   2. YOU CAN SEE WHEN YOU ARE LEANING ON THEM. A pad has no provenance pin, no recipe, no test.
//      One pinned for three weeks is production without production's guarantees.
//   3. THEY CAN COORDINATE. Collisions are reported and anybody may pin a note — the second half
//      is what makes it a cork board rather than a lock table.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard, writeBoard, post, note, strike, isPosted, checkBoard, formatBoard,
         boardDir, boardFile, ageDays, BOARD_SCHEMA, NUDGE_DAYS, STALE_DAYS } from './m59-board.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
const root = mkdtempSync(join(tmpdir(), 'm59-board-'));
const ENV = { M59_BOARD_DIR: root };
const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

console.log(NL + 'WHERE THE BOARD LIVES — and it follows the runlock rather than inventing a rule');
{
  ok('an explicit board directory wins',
     boardDir({ M59_BOARD_DIR: '/x', M59_RUNLOCK_DIR: '/y' }).dir === '/x');
  // THE POINT: a machine that already shares a lock directory gets a shared board for free, and
  // cannot end up with a shared lock and a private board.
  const fall = boardDir({ M59_RUNLOCK_DIR: '/y' });
  ok('otherwise it falls through to the shared runlock directory', fall.dir === '/y');
  ok('and says which rule chose it', fall.by === 'M59_RUNLOCK_DIR');
  const local = boardDir({});
  ok('with no env it is this checkout', /substrate/.test(local.dir));
  ok('and it SAYS that coordinates nothing outside it',
     /coordinates nothing outside it/.test(local.by), local.by);
  ok('the file is named for the fleet', boardFile('prod', ENV).path.endsWith('prod.scratchpads.json'));
}

console.log(NL + '1. A PIN CARRIES WHO, WHAT AND WHICH BODIES — or it is refused');
{
  let b = readBoard('prod', ENV);
  ok('an empty board is fresh, not broken', b.fresh === true && b.pads.length === 0);
  ok('and it knows its own path', b.path.endsWith('prod.scratchpads.json'));

  ok('a pin with no name is refused', /needs the pad name/.test(threw(() => post(b, { by: 'x', purpose: 'y' }))));
  ok('a pin with no author is refused',
     /which session or person/.test(threw(() => post(b, { name: 'p', purpose: 'y' }))));
  const why = threw(() => post(b, { name: 'p', by: 'x' }));
  ok('a pin with no purpose is refused', !!why);
  ok('and says why a purposeless pin is the problem, not a formality',
     /nobody can act on is the state the board exists to end/.test(why), why);

  b = post(b, { name: 'badlands-rail', by: 'Marco Polo', purpose: 'fine rail into 45',
                agents: ['hk2'], checkout: 'C:/a' });
  writeBoard(b, ENV);
  const back = readBoard('prod', ENV);
  ok('it survives a round trip', back.pads.length === 1 && back.pads[0].name === 'badlands-rail');
  ok('with the schema', back.schema === BOARD_SCHEMA);
  ok('and the agents that make collisions visible', back.pads[0].agents[0] === 'hk2');

  // Re-pinning replaces rather than duplicates, and keeps the notes somebody left you.
  let b2 = note(readBoard('prod', ENV), 'badlands-rail', { by: 'peer', text: 'walkFine is broker-side' });
  b2 = post(b2, { name: 'badlands-rail', by: 'Marco Polo', purpose: 'fine rail, take two',
                  agents: ['hk2'] });
  ok('re-pinning does not duplicate', b2.pads.filter(p => p.name === 'badlands-rail').length === 1);
  ok('and KEEPS the notes left on it', b2.pads[0].notes.length === 1, JSON.stringify(b2.pads[0].notes));
  ok('while taking the new purpose', /take two/.test(b2.pads[0].purpose));
}

console.log(NL + '3. ANYBODY MAY LEAVE A NOTE — the cork-board half');
{
  let b = post(readBoard('prod', ENV), { name: 'ghost-raid', by: 'shadow', purpose: 'boss raid',
                                         agents: ['t4'] });
  b = note(b, 'ghost-raid', { by: 'FleetScratch', text: 'fight runs in the broker snapshot' });
  b = note(b, 'ghost-raid', { by: 'Marco Polo', text: 'and hk2 is mine tonight' });
  const pad = b.pads.find(p => p.name === 'ghost-raid');
  ok('notes accumulate', pad.notes.length === 2);
  ok('each carries its author', pad.notes[0].by === 'FleetScratch' && pad.notes[1].by === 'Marco Polo');
  ok('and a timestamp', !!Date.parse(pad.notes[0].at));

  ok('a note on nothing is refused',
     /nothing named "ghosts" is on this board/.test(threw(() => note(b, 'ghosts', { by: 'x', text: 'y' }))));
  ok('and points at list', /check the name against/.test(threw(() => note(b, 'ghosts', { by: 'x', text: 'y' }))));
  ok('a note with no author is refused', /needs `by`/.test(threw(() => note(b, 'ghost-raid', { text: 'y' }))));
}

console.log(NL + '3b. A COLLISION IS REPORTED, NEVER DISCOVERED AFTERWARDS');
{
  let b = { schema: BOARD_SCHEMA, fleet: 'prod', pads: [] };
  b = post(b, { name: 'rail', by: 'a', purpose: 'x', agents: ['hk2', 't1'] });
  b = post(b, { name: 'raid', by: 'b', purpose: 'y', agents: ['hk2', 't4'] });
  const c = checkBoard(b);
  ok('the shared body is found', c.collisions.length === 1, JSON.stringify(c.collisions));
  ok('named', c.collisions[0].agent === 'hk2');
  ok('with both claimants', c.collisions[0].names.join(',') === 'rail,raid');
  ok('and a body claimed once is not a collision', !c.collisions.some(x => x.agent === 't1'));

  const text = formatBoard(b);
  ok('the render shouts it', /COLLISION  hk2 is claimed by rail and raid/.test(text), text);
  // NOT a refusal: an operator may genuinely want two views of one body.
  ok('but it does not stop anything — it is a report', isPosted(b, 'rail').ok === true);
}

console.log(NL + '2. STALENESS IS THE RELIANCE SIGNAL');
{
  const b = { schema: BOARD_SCHEMA, fleet: 'prod', pads: [
    { name: 'fresh', by: 'a', purpose: 'x', at: daysAgo(1), agents: [] },
    { name: 'aging', by: 'a', purpose: 'x', at: daysAgo(NUDGE_DAYS + 1), agents: [] },
    { name: 'ancient', by: 'a', purpose: 'x', at: daysAgo(STALE_DAYS + 5), agents: [] },
  ] };
  const c = checkBoard(b);
  ok('a day-old pad is neither', c.nudge.length === 1 && c.stale.length === 1);
  ok('the aging one is named', c.nudge[0].name === 'aging');
  ok('and the ancient one', c.stale[0].name === 'ancient');
  ok('ages are computed in days', c.pads.find(p => p.name === 'fresh').age === 1);

  const text = formatBoard(b);
  ok('the render marks them', /STALE ancient/.test(text) && /aging aging/.test(text), text);
  ok('and says what a stale pad actually IS',
     /production without production's guarantees/.test(text), text);
  ok('naming the three things a pad lacks',
     /no provenance pin, no recipe and no test/.test(text), text);
}

console.log(NL + 'THE GATE: posted or it does not drive');
{
  const b = post({ schema: BOARD_SCHEMA, fleet: 'prod', pads: [], path: '/board.json' },
                 { name: 'rail', by: 'a', purpose: 'x' });
  ok('a pinned pad passes', isPosted(b, 'rail').ok === true);

  const no = isPosted(b, 'wildcat');
  ok('an unpinned one does not', no.ok === false);
  ok('the refusal names the fleet and the board file',
     /fleet "prod"/.test(no.why) && /board.json/.test(no.why), no.why);
  ok('it gives all three reasons rather than just refusing',
     /what is driving the fleet/.test(no.why) &&
     /the same thing twice/.test(no.why) &&
     /leave you a note/.test(no.why), no.why);
  ok('AND THE EXACT COMMAND TO FIX IT',
     /m59-board\.mjs post wildcat --by/.test(no.why), no.why);
}

console.log(NL + 'AN UNREADABLE BOARD IS NOT AN EMPTY BOARD');
{
  writeFileSync(join(root, 'broken.scratchpads.json'), '{ not json');
  const b = readBoard('broken', ENV);
  ok('pads is null, not []', b.pads === null);
  ok('and it says UNREADABLE rather than empty', /UNREADABLE, not empty/.test(b.why), b.why);
  // The gate must fail CLOSED on an unreadable board: "I could not read the board" is not
  // permission, and the alternative is a board outage silently turning the gate off.
  const gate = isPosted(b, 'anything');
  ok('THE GATE FAILS CLOSED', gate.ok === false);
  ok('with the parse error as the reason', /will not parse/.test(gate.why), gate.why);
  ok('and the render says so too', /UNREADABLE/.test(formatBoard(b)));
}

console.log(NL + 'EMPTY HERE IS NOT EMPTY EVERYWHERE');
{
  const b = readBoard('nobody', ENV);
  const text = formatBoard(b);
  ok('it says nothing is pinned HERE', /nothing is pinned HERE/.test(text), text);
  ok('and that this is not the same as nothing being pinned',
     /not the same as nothing being pinned/.test(text));
  ok('and names how to share one across checkouts',
     /M59_BOARD_DIR/.test(text) && /M59_RUNLOCK_DIR/.test(text), text);
}

console.log(NL + 'TWO CHECKOUTS ON ONE BOARD IS THE BOARD WORKING — and it says what to watch');
{
  let b = { schema: BOARD_SCHEMA, fleet: 'prod', pads: [] };
  b = post(b, { name: 'a', by: 'x', purpose: 'p', checkout: 'C:/mindmap' });
  b = post(b, { name: 'b', by: 'y', purpose: 'q', checkout: 'C:/prod-deploy' });
  const c = checkBoard(b);
  ok('both checkouts are seen', c.checkouts.length === 2, JSON.stringify(c.checkouts));
  const text = formatBoard(b);
  ok('the render calls that the board working', /which is the board working/.test(text), text);
  ok('and warns that the imports have already diverged',
     /m59-fleetlib\.mjs has already diverged/.test(text), text);
  ok('and it shows which checkout each pad is in when they differ',
     /in C:\/mindmap/.test(text), text);
}

console.log(NL + 'striking is how a pad leaves, and it is remembered');
{
  let b = post({ schema: BOARD_SCHEMA, fleet: 'prod', pads: [] },
               { name: 'rail', by: 'a', purpose: 'x' });
  b = strike(b, 'rail', { why: 'promoted to tools/fleetscripts/' });
  ok('it is off the board', b.pads.length === 0);
  ok('the gate refuses it again', isPosted(b, 'rail').ok === false);
  ok('but the board remembers it was there', b.struck.length === 1);
  ok('and why it left', /promoted/.test(b.struck[0].why));
  ok('striking nothing is refused', /nothing named "ghost"/.test(threw(() => strike(b, 'ghost'))));
}

rmSync(root, { recursive: true, force: true });
console.log(NL + `${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
