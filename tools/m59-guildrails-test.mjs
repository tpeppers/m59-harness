#!/usr/bin/env node
// THE GUARD FOR m59-guildrails.mjs — offline, no socket, no keeper, no broker.
//
//   node tools/m59-guildrails-test.mjs
//
// It reads the committed map and ceiling-door states, which is the point: what is being pinned is
// that the BAKE still describes the hall on disk. A rail is evidence about a map and the map moves.
//
// The failure this whole file exists for, 2026-09-18: Zoot stood on door 59's outward trigger for
// an hour answering `no live path across the open door` every pass, two squares from the hall's
// only exit, while `come-home` gave up with route_progressing_exits_exhausted. The crossing was
// never impossible — cut against the state where door 59 is UP it is 32 legs and verifies — the
// live plan was simply being made against the SHUT hall, inside a 350ms wait for a sector-height
// event, in a five-second window.
//
// So: the crossing must cut, the baked file must still walk, the two copies of the hall's
// landmarks must agree, and the client-to-square conversion must not invent a step.
import { readFileSync, existsSync } from 'node:fs';
import {
  ANCHORS, DOOR_TABLE, CHESTS, EXIT, RAILS, ROOM,
  hallGeometry, cutLeg, plan, railFor, parseSquare, sq, centre, edgeOf,
} from './m59-guildrails.mjs';
import { anchors as passageAnchors, doors as passageDoors, bakedCrossing } from './m59-guild-passage.mjs';
import { verifyRail } from './m59-railcut.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('\n1. TWO COPIES OF THE HALL MUST AGREE, or a rail is a line to somewhere nobody stands');
{
  // m59-guildrails.mjs restates the passage's anchor and door tables rather than importing them,
  // so that the keeper does not pull the 21MB map loader in behind a constant. That is a
  // duplication, and a duplication nobody checks is how two spellings of one idea drift apart —
  // which this toolchain has paid for four times (see MIN_MOVER_STEP's four names).
  ok('the same number of anchors', ANCHORS.length === passageAnchors.length);
  ok('...and every one the same square',
     ANCHORS.every((a, i) => a[0] === passageAnchors[i][0] && a[1] === passageAnchors[i][1]),
     ANCHORS.map(sq).join(' '));
  ok('the same number of doors', DOOR_TABLE.length === passageDoors.length);
  for (let i = 0; i < DOOR_TABLE.length; i++) {
    const a = DOOR_TABLE[i], b = passageDoors[i];
    ok(`door ${a.sector}: same sector, same triggers, same crossings`,
       a.sector === b.sector &&
       JSON.stringify(a.inward) === JSON.stringify(b.inward) &&
       JSON.stringify(a.outward) === JSON.stringify(b.outward));
  }
  // One anchor per section, one door between each pair: four doors, five sections.
  ok('one more anchor than doors', ANCHORS.length === DOOR_TABLE.length + 1);
}

console.log('\n2. A MISSING CEILING STATE THROWS, rather than reading as a locked door');
{
  // The state key is the JOINED HEIGHTS. An absent key returning undefined would make every rail
  // across that hall come back "the flood did not reach the goal" — indistinguishable from a door
  // that cannot be opened, and a fact about the world nobody would question.
  // AND THIS IS THE CASE THAT CAUGHT A REAL HOLE. The first version only threw when the state KEY
  // was missing — but an unknown door id simply never matches, so `hallGeometry([9999])` handed
  // back the SHUT hall and every rail across it came back "the flood did not reach the goal".
  // A typo would have read as a door that cannot be opened.
  let threw = null;
  try { hallGeometry([9999]); } catch (e) { threw = e; }
  ok('an unknown door id throws', !!threw);
  ok('...and says which doors the hall actually has',
     threw && /has no door\(s\) 9999/.test(threw.message) && /it has 3, 53, 55, 58, 59/.test(threw.message),
     threw ? threw.message.slice(0, 100) : '');
  const shut = hallGeometry([]);
  ok('the all-shut hall resolves', !!shut.geo);
  ok('...to the closed heights', shut.key === '160,160,160,100,100', shut.key);
  const open59 = hallGeometry([59]);
  ok('door 59 open changes exactly one height', open59.key === '160,160,160,100,190', open59.key);
}

console.log('\n3. THE CROSSING THAT STRANDED ZOOT CUTS, and only with the door up');
{
  const [trigger, across] = DOOR_TABLE[0].outward;      // r4c28 -> r2c28, the way OUT
  const withDoor = cutLeg(trigger, across, { open: [59] });
  ok('r4c28 -> r2c28 with door 59 open: cut', withDoor.ok, withDoor.ok ? `${withDoor.legs} legs` : withDoor.why);
  ok('...and the mover\'s own trace verifies every leg', withDoor.verified === true);
  ok('...under the door-59-open state', withDoor.state_key === '160,160,160,100,190');

  const shut = cutLeg(trigger, across, { open: [] });
  ok('the SAME pair with the hall shut: NOT cut', !shut.ok,
     shut.ok ? `cut anyway in ${shut.legs} legs` : shut.why);
  // This is the whole diagnosis in one assertion. The live planner was asking the shut hall.
  ok('...which is exactly what the live planner was asking, and why it said "no live path"', !shut.ok);

  // AND THE ASSERTION THE FIRST DRAFT OF THIS TEST FAILED, which is why the edge is two tests.
  // `traceFineMoveClient` — the mover's own trace, and what every other rail here is cut with —
  // accepts this crossing with the ceiling on the floor. Only `geo.path`, which reads the step
  // mask the ceiling state rewrites, refuses it. An edge built the usual way cuts a rail straight
  // through a shut door and the rail VERIFIES, because verification uses the same blind test.
  const shutGeo = hallGeometry([]).geo;
  const fineOnly = (a, b) => {
    try { const t = shutGeo.traceFineMoveClient(a.x, a.y, b.x, b.y); return !!(t && (t.ok ?? t.moved ?? t.arrived)); }
    catch { return false; }
  };
  const a = centre(trigger), b = centre([3, 28]);   // r4c28 -> r3c28 IS the barrier
  ok('the fine trace alone accepts a step INTO the shut doorway', fineOnly(a, b));
  ok('...while the ceiling-aware edge refuses it', edgeOf(shutGeo)(a, b) === false);
  ok('...and both accept it once the ceiling is up', edgeOf(hallGeometry([59]).geo)(a, b) === true);
}

console.log('\n4. EVERY LEG THE HALL NEEDS IS IN THE PLAN');
{
  const p = plan();
  const kinds = p.reduce((a, l) => (a[l.kind] = (a[l.kind] ?? 0) + 1, a), {});
  ok('four doors x two directions x three legs', kinds.approach === 8 && kinds.crossing === 8 && kinds.landing === 8,
     JSON.stringify(kinds));
  ok('the exit, both ways', kinds.exit === 2);
  ok('every chest, both ways', kinds.chest === CHESTS.length * 2, `${CHESTS.length} chests`);
  ok('every crossing names exactly one open door', p.filter(l => l.kind === 'crossing').every(l => l.open.length === 1));
  ok('every approach and landing is cut on the SHUT hall',
     p.filter(l => l.kind !== 'crossing').every(l => l.open.length === 0));
  ok('the exit leg reaches the room\'s only `go` square', p.some(l => l.kind === 'exit' && l.to === EXIT));
}

console.log('\n5. THE BAKED FILE STILL WALKS ON THE MAP ON DISK');
{
  if (!existsSync(RAILS)) {
    ok('substrate/rail-714.json exists', false, 'run: node tools/m59-guildrails.mjs bake');
  } else {
    const baked = JSON.parse(readFileSync(RAILS, 'utf8'));
    ok('it is room 714', baked.room === ROOM);
    ok('every leg cut', baked.legs.every(l => l.ok), `${baked.legs.filter(l => !l.ok).length} failed`);
    const cache = new Map();
    let stale = 0;
    for (const l of baked.legs.filter(x => x.ok && x.waypoints?.length > 1)) {
      const id = (l.doors_open ?? []).join(',');
      if (!cache.has(id)) cache.set(id, hallGeometry(l.doors_open ?? []));
      const geo = cache.get(id).geo;
      // The CEILING-AWARE edge, deliberately: verifying a baked line with the blind one would
      // pass a rail that walks under a shut door, which is the exact thing being guarded against.
      const v = verifyRail(l.waypoints, { edge: edgeOf(geo), lattice: baked.lattice });
      if (v && v.ok === false) { stale++; console.log(`       stale: ${l.from} -> ${l.to}`); }
    }
    ok('no baked leg has gone stale against the current map', stale === 0, `${stale} stale`);
    ok('railFor finds the crossing by its squares', !!railFor(baked, 'r4c28', 'r2c28'));
    ok('...and answers null for a pair nobody baked', railFor(baked, 'r1c1', 'r2c2') === null);
  }
}

console.log('\n6. CLIENT WAYPOINTS BECOME SQUARES WITHOUT INVENTING A STEP');
{
  // The rail is cut on a 64-unit CLIENT lattice; `s.step` takes a square. Sixteen waypoints inside
  // one square are one square, and the square the body is already standing on is not a step.
  const first = bakedCrossing([4, 28], [2, 28], 59);
  if (!existsSync(RAILS)) {
    ok('bakedCrossing needs the bake', first === null, 'nothing baked, which is the honest answer');
  } else {
    ok('the door-59 crossing resolves to squares', Array.isArray(first) && first.length > 0,
       first ? JSON.stringify(first) : 'null');
    ok('...and does not start on the square we are standing on',
       !first.some((p, i) => i === 0 && p.row === 4 && p.col === 28));
    ok('...and ends on the far side', first[first.length - 1].row === 2 && first[first.length - 1].col === 28);
    ok('...with no square repeated back to back',
       first.every((p, i) => i === 0 || p.row !== first[i - 1].row || p.col !== first[i - 1].col));
    // Squares are adjacent or the same; a rail that skips one is a step the mover cannot take.
    ok('...and every hop is to a neighbouring square',
       first.every((p, i) => i === 0 ||
         (Math.abs(p.row - first[i - 1].row) <= 1 && Math.abs(p.col - first[i - 1].col) <= 1)));
    ok('a door nobody baked answers null', bakedCrossing([4, 28], [2, 28], 12345) === null);
    ok('a pair nobody baked answers null', bakedCrossing([1, 1], [2, 2], 59) === null);
  }
}

console.log('\n7. THE SPELLINGS ROUND-TRIP, because a coordinate carries its unit');
{
  ok('rNcM parses', JSON.stringify(parseSquare('r4c28')) === '[4,28]');
  ok('...case-insensitively', JSON.stringify(parseSquare('R18C2')) === '[18,2]');
  ok('...and round-trips', sq(parseSquare('r20c4')) === 'r20c4');
  let threw = null;
  try { parseSquare('28,4'); } catch (e) { threw = e; }
  ok('a bare pair is refused, because it cannot say which axis is first', !!threw);
  // CLIENT units: 1024 to a square, centre at half. r1c1 is the FIRST square, so it starts at 0.
  ok('r1c1 centres at (512,512) client', JSON.stringify(centre([1, 1])) === '{"x":512,"y":512}');
  ok('r2c33 centres at (33280,1536) client', JSON.stringify(centre(EXIT)) === '{"x":33280,"y":1536}',
     JSON.stringify(centre(EXIT)));
}

// EVERY DOOR IN THIS HALL IS SPOKEN, NOT PRESSED.
//
// Operator, 2026-09-20: "It's not a traditional 'press space' door, you have to say the guild
// hall password to open it (even to get out!)". Only sector 3 carried `secret: true`, so
// m59-guild-passage sent `c.go()` at 59, 55 and 53 — the branch is
// `if (door.secret) sayHallPassword() else c.go()`, i.e. pressing space at a door that answers
// only to a word. Three attempts, then `guild door 59 could not be crossed`, which reads as
// geometry and is a verb.
//
// Worth an assertion rather than a comment because of what hangs off it: `reagent_coop` is the
// ONLY caller of `getFromContainer` in this repository, its `approach()` crosses these doors to
// reach the 7-square range `user.kod UserGet` wants, and `transfer()` runs that same approach
// for BOTH directions. So one missing flag made the hall's 543 elderberry, 446 mushroom and
// 490 red mushroom unreachable AND silently disabled every deposit — the deposit half unnoticed
// because nothing had asked it to run.
{
  // CORRECTED: exactly ONE door is spoken, and asserting otherwise is worse than asserting
  // nothing. Operator, 2026-09-20: "not EVERY door is a secret door in the hall. The west-most
  // door in that hall is the secret door. The rest of the doors are normal doors but open slow:
  // all guild hall doors open slow, only the chest room requires the password."
  //
  // The all-secret assertion would have held a fleet saying its guild password aloud at three
  // ordinary doors on a shared server. It also contradicted the kod, which `m59-doors.mjs`
  // reads: 59, 55, 53 and 58 come from `SomethingTryGo`, sector 3 alone from `SomeoneSaid`
  // matching the guild password. Two independent sources said pressed and the assertion said
  // spoken.
  const spoken = passageDoors.filter(d => d.secret === true).map(d => d.sector);
  ok('exactly one door in the hall is opened by SAYING the password — the chest room\'s',
     spoken.length === 1 && spoken[0] === 3,
     `spoken door(s): ${spoken.join(', ') || 'none'} — expected exactly sector 3`);
  const pressed = passageDoors.filter(d => d.secret !== true);
  ok('and the rest are pressed — they are ordinary doors that merely open SLOWLY',
     pressed.length === passageDoors.length - 1,
     `pressed: ${pressed.map(d => d.sector).join(', ') || 'none'} of ` +
     `${passageDoors.length} doors — only the chest room's should speak`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
