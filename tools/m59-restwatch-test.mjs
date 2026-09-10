#!/usr/bin/env node
// The safe-wall verdict and the ledger that tests it. Offline: no broker, no socket, no fleet.
//
//   node tools/m59-restwatch-test.mjs
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeWallVerdict, standingVerdict, measureSquare,
         PREDICATES, PREDICATE_NAMES, SAFE_WALL_RULE } from './m59-safewall.mjs';
import { classify, summarise, recordRest, readRows, OUTCOMES,
         SETTLE_GRACE_MS } from './m59-restwatch.mjs';

let n = 0;
const ok = (what, cond, extra = '') => {
  n++;
  if (!cond) { console.error(`  FAIL ${what} ${extra}`); process.exitCode = 1; }
  else console.log(`  ok   ${what}`);
};

// A room with a pillar: a 9x9 of open floor with one blocked square, and a mover that
// refuses every step INTO r5c5 (so r5c5 is unreachable-by-approach but stands on floor).
function fakeGeo({ collisionReady = true, refuseInto = null, blocked = new Set() } = {}) {
  const walkable = (r, c) =>
    r >= 1 && r <= 9 && c >= 1 && c <= 9 && !blocked.has(`${r},${c}`);
  return {
    rows: 9, cols: 9, collisionReady, walkable,
    // What lineOfSight walks: sight is blocked by anything the coarse grid calls a wall.
    canMove: (fr, fc, tr, tc) => walkable(tr, tc),
    moverStepLands: (fr, fc, tr, tc) =>
      !(refuseInto && tr === refuseInto.row && tc === refuseInto.col),
  };
}

console.log('\nwhat a safe wall IS, asked of geometry and nothing else');
{
  // Open floor in the middle of an empty room: everything can see it.
  const open = fakeGeo();
  const v = safeWallVerdict(open, 5, 5);
  ok('open floor is not a wall', v.is_wall === false, JSON.stringify(v.why));
  ok('and it says how many squares can see it', v.measured.attackers > 0);
  ok('the rule in force is named on every verdict', v.rule === SAFE_WALL_RULE);

  // A square nothing can reach: wall it in completely, so no walkable square has sight.
  const walled = new Set();
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++)
    if (!(r === 5 && c === 5)) walled.add(`${r},${c}`);
  const sealed = fakeGeo({ blocked: walled });
  const s = safeWallVerdict(sealed, 5, 5);
  ok('a square nothing can stand near IS a wall under the rule in force', s.is_wall === true);
  ok('and no_line_of_sight is the predicate that says so',
     s.predicates.no_line_of_sight === true);
}

console.log('\nthe two mechanisms are recorded separately, because they are not the same one');
{
  // THE DISTINCTION THIS WHOLE MODULE EXISTS FOR. `no_line_of_sight` is about what can SEE
  // you (monster.kod:1782); `some_approach_refused` is about what can REACH you (the mover
  // refusing a step the coarse grid offers). A square can satisfy one and not the other, and
  // for a year this repository called both of them "safe wall".
  const g = fakeGeo({ refuseInto: { row: 5, col: 5 } });
  const v = safeWallVerdict(g, 5, 5);
  ok('a square every approach is refused into satisfies the operator definition',
     v.predicates.some_approach_refused === true);
  ok('and ALSO the strict reading, since every offered approach was refused',
     v.predicates.all_approaches_refused === true);
  ok('but it is NOT a wall under the rule in force, because things can still see it',
     v.is_wall === false, JSON.stringify(v.measured));
  ok('which is the whole reason both are recorded on every observation',
     v.predicates.no_line_of_sight !== v.predicates.some_approach_refused);

  ok('every predicate is answered on every verdict',
     PREDICATE_NAMES.every(k => k in v.predicates), JSON.stringify(Object.keys(v.predicates)));
}

console.log('\n"cannot tell" is not "false" — the failure mode this repository keeps finding');
{
  // moverStepLands answers TRUE for everything when collision is not baked. Reading that as
  // "no disagreement" scores every square in the world as ordinary floor and turns the
  // criterion off silently.
  const unbaked = fakeGeo({ collisionReady: false });
  const v = safeWallVerdict(unbaked, 5, 5);
  ok('an unbaked map answers null for the approach predicates, never false',
     v.predicates.some_approach_refused === null && v.predicates.all_approaches_refused === null,
     JSON.stringify(v.predicates));
  ok('and refused_approaches is null rather than 0',
     v.measured.refused_approaches === null);
  ok('a square with no geometry at all claims nothing',
     safeWallVerdict(null, 5, 5).is_wall === null);
  ok('and measureSquare refuses a non-integer coordinate',
     measureSquare(fakeGeo(), 5.5, 5) === null);
}

console.log('\nthe standing verdict keeps the old SHAPE and changes the SOURCE');
{
  // Every existing caller reads `{ at, works }`. The book used to fill it from `held > 0`,
  // which is why m59-friendly-reboot evacuated 21 characters to sound walls and reported
  // that none of them had reached safety.
  const walled = new Set();
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++)
    if (!(r === 5 && c === 5)) walled.add(`${r},${c}`);
  const sv = standingVerdict(fakeGeo({ blocked: walled }), { row: 5, col: 5 });
  ok('it answers the shape callers already read', sv && sv.at && 'works' in sv);
  ok('and works is TRUE for a sound wall nobody has ever stood on', sv.works === true);
  ok('a square with no coordinates is false, not a throw', standingVerdict(null, null) === false);
}

console.log('\nwhat disproves the definition — exactly one thing');
{
  ok('resting and taking nothing is clean', classify({ damage: 0 }) === 'clean');
  ok('taking damage while not swinging, after settling, IS the disproof',
     classify({ damage: 4, rested_ms: 60_000 }) === 'violation');

  // THE THREE CATEGORIES THE OLD BOOK COUNTED AS FAILURES AND SHOULD NOT HAVE. Together they
  // are 89% of its failure column.
  ok('damage after WE swung is the mechanic working, not the wall failing',
     classify({ damage: 40, swung: true, rested_ms: 60_000 }) === 'swung');
  ok('a poison tick goes through any wall ever built and is not evidence',
     classify({ damage: 4, ailing: true, rested_ms: 60_000 }) === 'ailing');
  ok('a blow already in flight when we sat down is attributed to the approach',
     classify({ damage: 4, rested_ms: SETTLE_GRACE_MS - 1 }) === 'settling');
  ok('and the same blow one second later is a violation',
     classify({ damage: 4, rested_ms: SETTLE_GRACE_MS + 1 }) === 'violation');

  // Order is the argument: swinging forfeits the claim whatever else was true.
  ok('swinging outranks ailing, which outranks settling',
     classify({ damage: 4, swung: true, ailing: true, rested_ms: 0 }) === 'swung');
  ok('every outcome classify can return is declared',
     OUTCOMES.includes(classify({ damage: 1, rested_ms: 99_999 })));
}

console.log('\nthe report counts, and refuses to average what cannot be averaged');
{
  const rows = [
    { outcome: 'clean',     predicates: { no_line_of_sight: true,  some_approach_refused: false } },
    { outcome: 'clean',     predicates: { no_line_of_sight: true,  some_approach_refused: true  } },
    { outcome: 'violation', predicates: { no_line_of_sight: false, some_approach_refused: true  } },
    // Clean WHERE THE PREDICATE SAID NO. This is the column that separates a correct rule
    // from a merely conservative one — a predicate true of every square in the world would
    // have zero violations and be worthless.
    { outcome: 'clean',     predicates: { no_line_of_sight: false, some_approach_refused: false } },
    // Noise the old book would have counted against both predicates:
    { outcome: 'swung',     predicates: { no_line_of_sight: true,  some_approach_refused: true  } },
    { outcome: 'ailing',    predicates: { no_line_of_sight: true,  some_approach_refused: true  } },
  ];
  const s = summarise(rows);
  ok('only clean and violation rows are decisive', s.usable === 4, `usable ${s.usable}`);
  ok('a predicate true on two clean rests and no violations reads perfect',
     s.predicates.no_line_of_sight.violations === 0
     && s.predicates.no_line_of_sight.clean === 2, JSON.stringify(s.predicates.no_line_of_sight));
  ok('a predicate that was true where we got hit carries the violation',
     s.predicates.some_approach_refused.violations === 1);
  ok('and clean_without is kept, so a rule true of everything cannot look perfect',
     s.predicates.no_line_of_sight.clean_without === 1);
  ok('the swung and ailing rows are counted but never scored',
     s.counts.swung === 1 && s.counts.ailing === 1);
  ok('and the violating rows come back whole, to be reproduced', s.violations.length === 1);
}

console.log('\nthe ledger writes, and never takes a character down');
{
  const file = join(tmpdir(), `restwatch-test-${process.pid}.jsonl`);
  if (existsSync(file)) rmSync(file);
  const walled = new Set();
  for (let r = 1; r <= 9; r++) for (let c = 1; c <= 9; c++)
    if (!(r === 5 && c === 5)) walled.add(`${r},${c}`);
  const v = safeWallVerdict(fakeGeo({ blocked: walled }), 5, 5);
  recordRest({ agent: 'a1', room: 39, verdict: v, damage: 0, rested_ms: 9000, file });
  recordRest({ agent: 'a1', room: 39, verdict: v, damage: 7, rested_ms: 9000, file });
  const back = readRows(file);
  ok('a row per rest', back.length === 2);
  ok('and it carries the epoch, so a definition change retires it',
     'epoch' in back[0]);
  ok('and every candidate predicate, because a rest cannot be re-run later',
     PREDICATE_NAMES.every(k => k in back[0].predicates));
  ok('the clean one and the violation are both kept',
     back[0].outcome === 'clean' && back[1].outcome === 'violation');
  appendFileSync(file, 'not json\n');
  ok('a malformed line is skipped rather than fatal', readRows(file).length === 2);
  ok('recording never throws, whatever it is handed',
     recordRest({ verdict: null, file: '/nonexistent-dir\0/x' }) === null);
  rmSync(file, { force: true });
}

console.log('\nWHERE A CHARACTER SITS DOWN — a wall by default, the open only on request');
{
  // Operator's rule, 2026-09-10: safe-wall behaviour is always the default, and stopping
  // somewhere that is not a safe wall must be something you deliberately asked for.
  //
  // The old default picked a CORNER off the coarse grid — two of four orthogonal
  // neighbours blocked — which is not a safe wall, and m59-safespots.mjs names that exact
  // error in its own header: a flat wall blocks three of eight neighbours and scores as a
  // 62% improvement while leaving twenty of the twenty-eight squares that can really reach
  // you wide open. That gap is how Waldorf died four times resting with in_safe_spot false.
  const { Autopilot } = await import('./m59-autopilot.mjs');

  // REAL GEOMETRY, NOT A FAKE ONE. A first attempt built a sealed pocket in a 9x9 fake and
  // every assertion failed — correctly: a perfectly sealed square is not WALKABLE TO, and
  // nearestSafeSpot rightly refuses to send a character somewhere it cannot go. A safe wall
  // has to be reachable and unreachable at once (by us and by them respectively), and that
  // is a property of real rooms rather than something convenient to fake.
  //
  // Room 39, Upstairs in Castle Victoria, measured 2026-09-09: 578 walkable squares, 185 of
  // them safe walls under the rule in force. The fleet's own home room, so if the default
  // does not find a wall HERE it will not find one anywhere.
  const { loadMap } = await import('./m59-map.mjs');
  const { geometryFor } = await import('./m59-safespots.mjs');
  const rooms = (() => { const m = loadMap(); const r = m.rooms ?? m;
                         return Array.isArray(r) ? r : Object.values(r); })();
  const room39 = rooms.find(r => r && (r.num === 39 || r.id === 39));
  const geo39 = room39 ? geometryFor(room39) : null;

  const build = (policy) => {
    const k = Object.create(Autopilot.prototype);
    // A square the fleet actually stands on in 39, and NOT itself a wall, so the default
    // has somewhere to walk to rather than trivially already being right.
    const me = { id: 0, col: 30, row: 8 };
    k.policy = policy;
    k.s = {
      client: { selfId: 0, self: me, room: { objects: new Map([[0, me]]) } },
      world: {
        room: { num: 39 }, geometry: geo39,
        reach: (col, r) => ({ reachable: true,
                              steps: Math.max(Math.abs(col - me.col), Math.abs(r - me.row)) }),
      },
    };
    return k;
  };

  if (!geo39) {
    // The map is a build artefact and a fresh clone may not have baked it. Skipping is
    // honest; pretending to pass is not.
    console.log('  --   substrate/m59-map.json has no room 39, so the sit-down cases were '
              + 'SKIPPED (run `node tools/setup.mjs routes`). This is not a pass.');
  } else {

  const def = build({});
  ok('with no policy set at all, it goes looking for a real safe wall',
     def.restingSquare()?.wall === true, JSON.stringify(def.restingSquare()));
  // THE PROPERTY, NOT THE COORDINATE. Asserting a particular square would pin this test to
  // one bake of one room and break the day the map is re-baked for an unrelated reason.
  // What matters is that nothing can reach the square it chose.
  const chosen = def.restingSquare();
  ok('and the square it picks is one nothing can reach — which is what a safe wall IS',
     chosen?.can_reach_you === 0, JSON.stringify(chosen));
  ok('and it is somewhere we can actually walk to, not merely somewhere unreachable',
     Number.isFinite(chosen?.steps) && chosen.steps >= 0, JSON.stringify(chosen));
  ok('and it says so, so the journal and the ledger need not infer it from the word corner',
     def.restingSquare()?.seat === 'a safe wall');

  // THE ESCAPE HATCH, AND IT HAS TO BE ASKED FOR BY NAME.
  const anywhere = build({ restAnywhere: true });
  const seat = anywhere.restingSquare();
  ok('restAnywhere: true is the deliberate order to take the old corner behaviour',
     seat && seat.wall === false, JSON.stringify(seat));

  // AN UNREADABLE SETTING MUST NOT BE THE THING THAT DECIDES TO SIT IN THE OPEN. A hard
  // `this.policy.restAnywhere` threw here, which m59-rest-test caught — it drives
  // restingSquare on a bare instance with no policy at all.
  const bare = Object.create(Autopilot.prototype);
  bare.s = def.s;
  ok('a missing policy object is the DEFAULT, not a crash and not the open floor',
     bare.restingSquare()?.wall === true, JSON.stringify(bare.restingSquare()));

  // Anything false-y other than an explicit true keeps the wall.
  for (const v of [false, undefined, null, 0, 'true'])
    ok(`restAnywhere: ${JSON.stringify(v)} still seeks a wall — only a literal true opts out`,
       build({ restAnywhere: v }).restingSquare()?.wall === true);
  }
}

console.log('\nTHE LEDGER MAY NOT BE READ BY ANYTHING THAT CHOOSES A SQUARE');
{
  // This is the guarantee the last book did not have, and losing it is exactly how that book
  // went from a record of what happened to an input to the thing it was measuring. Once it
  // was an input, its own errors fed back into the squares it was scoring.
  // WRITING IS FINE; READING IS THE THING THAT MAY NEVER HAPPEN. The keeper must record
  // outcomes or there is no experiment — `m59-autopilot.mjs` calls `recordRest` at both of
  // its rest outcomes. What is forbidden is a chooser READING rows back, because the moment
  // an outcome ledger feeds selection, its own errors feed back into the squares it scores.
  // That is not a hypothetical: it is the whole history of the file this replaces.
  const pickers = ['m59-safespots.mjs', 'm59-safewall.mjs', 'm59-autopilot.mjs',
                   'm59-broker.mjs', 'm59-fleetscript.mjs', 'm59-friendly-reboot.mjs'];
  for (const f of pickers) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    const reads = /\b(summarise|readRows)\s*\(/.test(src)
      || /import\s*\{[^}]*\b(summarise|readRows)\b[^}]*\}\s*from\s*['"]\.\/m59-restwatch/.test(src);
    ok(`${f} does not READ the ledger`, !reads, 'it calls readRows/summarise');
  }
  // And the geometry itself may not even write: a predicate that records its own outcomes is
  // one refactor away from consulting them.
  for (const f of ['m59-safespots.mjs', 'm59-safewall.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    // An IMPORT, not a mention: both files name the ledger in their comments on purpose, so
    // the next reader finds the experiment. Prose is not coupling.
    ok(`${f} does not import the ledger at all`,
       !/^\s*import[^;]*from\s*['"]\.\/m59-restwatch\.mjs['"]/m.test(src));
  }
  // And the reverse: the ledger may not import a chooser, so it cannot grow an opinion.
  const led = readFileSync(fileURLToPath(new URL('m59-restwatch.mjs', import.meta.url)), 'utf8');
  ok('and the ledger imports no chooser of its own',
     !/from\s+['"]\.\/m59-(autopilot|broker|game)\.mjs['"]/.test(led));
}

console.log(`\nrestwatch: ${n} assertions, ${process.exitCode ? 'FAILED' : 'PASS'}`);
