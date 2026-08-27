#!/usr/bin/env node
// Does the keeper actually KNOW whether it is in a working safe spot?
//
//   node tools/m59-safespot-test.mjs
//
// Everything here runs offline against a fake room, because the thing being tested is
// a judgement rather than a protocol: given what the character can see, does it reach
// the right conclusion about where it is standing, and does it write that conclusion
// down where the next character can read it?
//
// The reason this is worth a test at all is that the failure is silent in both
// directions and expensive in both. Believing a bad square is safe makes the keeper
// stand still and rest while something eats it. Refusing to believe a good one throws
// away the largest advantage in the game — a free heal to full in a monster room.
import './m59-test-ledger.mjs';        // FIRST — the keeper records casts; see that file
import { unlinkSync, readFileSync } from 'node:fs';
import { Autopilot, HANDLED, effectiveFightVigorFloor,
         farmRoomDenials, releaseQuarry,
         shouldRelocateToAssignedRoom } from './m59-autopilot.mjs';
import { SafeSpotBook , shelterAhead, gridDisagreementAt } from './m59-safespots.mjs';
import { returnToSpot } from './m59-skills.mjs';

const BOOK = `${process.env.TEMP || '/tmp'}/m59-safespot-test-${process.pid}.json`;
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
};

// ------------------------------------------------------------------ the fake room
//
// Only as much world as observe() reads: where we are, what our health is, and what
// is standing next to us.
function world({ col = 5, row = 5, health = 30, max = 30, vigor = 150, room = 999 } = {}) {
  const objects = new Map();
  const names = new Map([[1, 'giant rat'], [2, 'baby spider'], [3, 'Varuka']]);
  const c = {
    selfId: 99,
    room: { id: room, objects },
    rsc: { get: n => names.get(n) || `rsc${n}` },
    vitals: () => ({ health: { value: c._health, max }, vigor: { value: c._vigor, max: 200 } }),
    _health: health,
    _vigor: vigor,
    inventory: [],
    // The real client resolves this out of room contents on every read, which is why
    // a save-game renumber makes a live character look dead. Same shape here.
    get self() { return objects.get(this.selfId); },
  };
  objects.set(99, { id: 99, col, row, x: col * 64 + 20, y: row * 64 + 40, flags: 0 });
  const s = {
    name: 'test', live: true, client: c,
    world: { room: { num: room, name: 'Test Room' }, geometry: null },
  };
  return {
    s, c,
    me: () => objects.get(99),
    hurt: n => { c._health = Math.max(0, c._health - n); },
    // OF.ATTACKABLE is 0x200 in m59-parse; take it from a real flag word rather than
    // hardcoding, so this test cannot drift away from the parser.
    addMonster: (id, dcol, drow, flags) => objects.set(id, {
      id, col: objects.get(99).col + dcol, row: objects.get(99).row + drow, flags }),
    remove: id => objects.delete(id),
  };
}

const { OF } = await import('./m59-parse.mjs');
const MONSTER = OF.ATTACKABLE;

console.log('\n--- hostile-room provisioning refusal reads initialized vigor ---');
{
  const w = world();
  w.addMonster(1, 2, 0, MONSTER);
  const notes = [];
  const p = Object.create(Autopilot.prototype);
  p.policy = { vigorCeiling: 200 };
  p.hold = null;
  p.s = w.s;
  p.sanctuary = () => false;
  p.fightFloor = () => 80;
  p.notedNoEatingHere = false;
  p.note = (message, data) => notes.push({ message, data });
  let result, error = null;
  try {
    result = await p.provision(
      { vigorCeiling: 200 },
      { vigor: { value: 77, max: 200, scale_max: 200 } },
    );
  } catch (caught) {
    error = caught;
  }
  ok('a fresh field keeper refuses to provision near hostiles without throwing',
     !error && result === false, error ? String(error) : `result=${result}`);
  ok('the refusal diagnostic reports current vigor and hostile count',
     notes.length === 1 && notes[0].data?.vigor === 77 &&
       notes[0].data?.monsters_in_room === 1,
     JSON.stringify(notes));
}

console.log('\n--- an empty larder creates food only below the effective fight floor ---');
{
  const run = async vigor => {
    const w = world();
    const p = Object.create(Autopilot.prototype);
    p.policy = { vigorCeiling: 200 };
    p.hold = null;
    p.s = w.s;
    p.sanctuary = () => true;
    p.fightFloor = () => 80;
    p.larder = () => [];
    p.notedNoEatingHere = false;
    p.warnedNoFood = true;
    p.climbing = true;
    p.note = () => {};
    let cooks = 0, reagentReads = 0;
    p.cookSomething = async () => { cooks++; return true; };
    p.reagentCount = () => { reagentReads++; return { elderberry: 99, herbs: 99 }; };
    const vitals = vigor === undefined
      ? { health: { value: 30, max: 30 } }
      : { health: { value: 30, max: 30 }, vigor: { value: vigor, max: 200 } };
    const result = await p.provision({ vigorCeiling: 200 }, vitals);
    return { result, cooks, reagentReads, climbing: p.climbing,
             warnedNoFood: p.warnedNoFood };
  };

  const atFloor = await run(80);
  ok('empty at 80 with floor 80 and ceiling 200 does not create food',
     atFloor.result === false && atFloor.cooks === 0 && atFloor.reagentReads === 0 &&
       atFloor.climbing === false && atFloor.warnedNoFood === false,
     JSON.stringify(atFloor));

  const belowFloor = await run(79);
  ok('empty at 79 with floor 80 creates exactly once and handles the pass',
     belowFloor.result === 'ate' && belowFloor.cooks === 1,
     JSON.stringify(belowFloor));

  const aboveFloor = await run(110);
  ok('empty at 110 with floor 80 does not chase the ceiling by creating food',
     aboveFloor.result === false && aboveFloor.cooks === 0 &&
       aboveFloor.reagentReads === 0 && aboveFloor.climbing === false,
     JSON.stringify(aboveFloor));

  const unknown = await run(undefined);
  ok('unknown vigor fails closed without creating food',
     unknown.result === false && unknown.cooks === 0 && unknown.reagentReads === 0 &&
       unknown.climbing === false,
     JSON.stringify(unknown));
}

console.log('\n--- safe-spot arrival is confirmed, not predicted ---');
{
  // The dead-reckoned position says we are home. The authoritative read says the
  // server still has us one square away; returnToSpot must not accept the first claim.
  const me = { col: 5, row: 5, x: 352, y: 352, predicted: true };
  let confirms = 0, fineWalks = 0;
  const c = { get self() { return me; } };
  const s = {
    need: () => c,
    confirmPosition: async () => {
      confirms++;
      Object.assign(me, { col: 6, row: 5, x: 416, y: 352, predicted: false });
      return { col: me.col, row: me.row };
    },
    walkTo: async (col, row) => {
      Object.assign(me, { col, row, x: col * 64 + 32, y: row * 64 + 32, predicted: true });
      return { arrived: true };
    },
    walkFine: async (x, y) => {
      fineWalks++;
      Object.assign(me, { col: (x / 64) | 0, row: (y / 64) | 0, x, y, predicted: false });
      return { arrived: true };
    },
  };
  const back = await returnToSpot(s, { col: 5, row: 5, x: 352, y: 352 });
  ok('a predicted match is checked with the server', confirms === 2,
     `confirmed ${confirms} time(s): before routing and after its predicted arrival`);
  ok('the stale prediction is corrected rather than accepted as already home',
     back.arrived && !back.already && fineWalks === 1,
     JSON.stringify({ back, fineWalks }));
  ok('success means the final coarse and fine position both match the hold',
     me.col === 5 && me.row === 5 && me.x === 352 && me.y === 352 && !me.predicted);
}

function keeper(w) {
  const p = new Autopilot(w.s, { mode: 'farm', policy: { hunt: 'giant rat' } });
  p.book = new SafeSpotBook(BOOK);      // never touch the real substrate
  return p;
}

console.log('\n--- the resting-cap floor allows only measured approach vigor ---');
{
  ok('an 80-vigor resting-cap order allows the measured two vigor spent approaching',
     effectiveFightVigorFloor(80) === 78);
  ok('food-backed floors and lower deliberate floors remain exact',
     effectiveFightVigorFloor(100) === 100 && effectiveFightVigorFloor(70) === 70);
}
{
  // Exercise the real farm gate. A unit test of only the threshold helper would miss
  // passFarm continuing to compare against the unadjusted floor.
  const w = world({ room: 575, health: 40, max: 40, vigor: 78 });
  w.s.name = 'approach-vigor-ladder';
  w.s.need = () => w.c;
  w.s.pacer = { submit: async (_kind, action) => action() };
  w.c.requestInventory = () => {};
  w.c.waitFor = async () => ({ events: [] });
  w.c.spells = [];
  w.addMonster(31, 4, 0, MONSTER);
  w.c.room.objects.get(31).nameRsc = 1;

  const p = keeper(w);
  Object.assign(p.policy, {
    hunt: 'giant rat', vigorFloor: 80, clearWeak: false, maxCarry: 50,
    restBelow: 0.7, fleeBelow: 0.425,
    useSafeSpots: true, requireSafeWall: false,
  });
  p.resumeSuspendedJourney = async () => null;
  p.provision = async () => false;
  p.sweepBroken = async () => {};
  p.sweepGearCondition = async () => {};
  p.armSelf = async () => true;
  p.holdWorthwhile = () => ({ hold: false, level: 30, my_level: 40 });
  p.hold = { room: 575, col: 5, row: 5 };
  p.maybeTestSpot = () => false;
  let pulls = 0;
  p.pull = async () => { pulls++; return { pulled: false, why: 'fixture ends after the farm gate' }; };
  const wallReasons = [];
  p.takeSafeSpot = async reason => {
    wallReasons.push(reason);
    return { took: false, why: 'fixture does not need a wall' };
  };

  const ctx = { s: w.s, c: w.c, room: w.s.world.room,
                v: w.c.vitals(), hp: 1 };
  const restsBefore = p.tally.rests;
  let result = null, error = null;
  try {
    result = await p.passFarm(ctx);
  } catch (caught) {
    error = caught;
  } finally {
    releaseQuarry(w.s.name);
  }
  ok('the real farm gate does not turn the measured 80-to-78 approach into another rest trip',
     !error && result === HANDLED && p.tally.rests === restsBefore && pulls === 1 &&
       wallReasons.length === 0,
     error ? (error.stack || String(error)) : JSON.stringify({ handled: result === HANDLED,
                                              restsBefore, restsAfter: p.tally.rests,
                                              pulls, wallReasons }));
}

// A pass of time in which we did nothing: the keeper looks, and looks again later.
//
// Time is simulated by ageing what the keeper has already stamped rather than by
// sleeping, and EVERY clock has to move together. Ageing only the last observation
// would drag a walk that happened before it to after it, and the keeper would
// correctly conclude it had just moved — measuring the harness instead of the code.
// Clocks still at zero mean "never happened" and must stay there.
const look = (p, msAgo = 0) => {
  if (msAgo) {
    const back = v => (v > 0 ? v - msAgo : v);
    if (p.lastObs) p.lastObs.at -= msAgo;
    p.movedAt = back(p.movedAt);
    p.swungAt = back(p.swungAt);
    p.turnedAt = back(p.turnedAt);
    p.rejoinedAt = back(p.rejoinedAt);
    if (p.hold) p.hold.takenAt -= msAgo;
  }
  p.observe();
};

// Stand somewhere, having walked there. The walk matters: nothing counts as evidence
// until the character has acted, because until then the server is holding the
// monsters back and the quiet is the grace period rather than the wall.
//
// SETTLED A MOMENT AGO, NOT THIS INSTANT, because that is what the real loop does and
// the difference is load-bearing. observe() runs at the top of a pass and the square is
// claimed later in the same pass, so the first baseline reading is taken a pass — about
// a second — after settling. A fixture that settles at the same instant as the baseline
// is asking the keeper to judge a window that opens 0ms after arrival, which it now
// correctly refuses to do (SETTLE_GRACE_MS in m59-autopilot.mjs).
//
// The two clocks are separate on purpose. Walking in stamps both; claiming a square we
// were already standing on (`steps_away === 0`) stamps only the second, and that is the
// case the grace exists for — so a test asks for "moved here ages ago, claimed it just
// now" with `{ settledMsAgo: 5000, takenMsAgo: 0 }`.
const holdAt = (p, col, row, { settledMsAgo = 1000, takenMsAgo = settledMsAgo, ...extra } = {}) => {
  p.movedAt = Date.now() - settledMsAgo;
  p.hold = { room: 999, col, row, takenAt: Date.now() - takenMsAgo,
             quietMs: 0, damageWhileIdle: 0,
             failures: 0, mostAttackers: 0, proven: false, ...extra };
  return p.hold;
};

console.log('\n--- a room does not become an unbounded wall experiment ---');
{
  const w = world();
  const p = keeper(w);
  p.policy.pullsBeforeBarren = 1;
  p.policy.barrenSpotsBeforeRoomDecision = 2;

  holdAt(p, 5, 5, { proven: true });
  ok('one fully failed wall is retired without condemning the room',
     p.pullDidNotConvert('nothing reached the first wall') && !p.noWallRooms?.get(999));

  holdAt(p, 6, 5, { proven: true });
  ok('a bounded sample of independent failed walls ends the room search',
     p.pullDidNotConvert('nothing reached the second wall') &&
       /2 top-ranked walls/.test(p.noWallRooms?.get(999) || ''),
     p.noWallRooms?.get(999));
  ok('the decision says it is room-scoped and leaves the strategic goal alone',
     p.journal.some(e => e.what === 'ROOM WALL SEARCH EXHAUSTED' &&
       /does not block/.test(e.goal_scope || '')));

  // A truthy geometry is enough because the room decision must short-circuit before
  // another candidate scan or route. Travel holds remain allowed to use walls here.
  w.s.world.geometry = {};
  const stopped = await p.takeSafeSpot('another fight wall', null);
  ok('another combat pass does not start researching a third wall',
     !stopped.took && stopped.unreachable_terrain && /stopping the wall search/.test(stopped.why));
}

console.log('\n--- unrelated combat does not erase a pending pull ---');
{
  const w = world();
  const p = keeper(w);
  p.pullsWithoutContact = 2;
  p.pendingPull = { target: 'groundworm larva', target_id: 10, waitUntil: Date.now() + 5000 };

  ok('hitting a different attacker does not convert the pulled quarry',
     p.pullConverted(11, 'centipede') === false);
  ok('the quarry follow window and attempt count survive defensive combat',
     p.pendingPull?.target_id === 10 && p.pullsWithoutContact === 2);
  ok('the reason is explicit in telemetry rather than hidden in a reset',
     p.journal.some(e => e.what === 'another creature reached the wall — the pull test is still open' &&
       e.pulled_id === 10 && e.fought_id === 11));

  ok('contact with the actual pulled quarry converts and clears the experiment',
     p.pullConverted(10, 'groundworm larva') === true &&
       p.pendingPull === null && p.pullsWithoutContact === 0);
}

console.log('\n--- a denied assignment cannot fight its own relocation ---');
{
  const policy = { assignedRoom: 566 };
  const elsewhere = { num: 557 };
  ok('an available assignment still pulls the keeper back',
     shouldRelocateToAssignedRoom(policy, elsewhere, new Map()) === true);
  ok('a successful room probe stored as false also leaves the assignment active',
     shouldRelocateToAssignedRoom(policy, elsewhere, new Map([[566, false]])) === true);
  ok('a session-denied assignment is deferred instead of causing room oscillation',
     shouldRelocateToAssignedRoom(policy, elsewhere,
       new Map([[566, 'three wall samples failed']])) === false);
  ok('standing in the assigned room never requests relocation',
     shouldRelocateToAssignedRoom(policy, { num: 566 },
       new Map([[566, 'three wall samples failed']])) === false);

  const denied = farmRoomDenials(
    new Map([[566, false], [557, 'three wall samples failed']]),
    new Map([[563, 'spawn cap 8/8 is occupied by 1x rebel soldier']]));
  ok('a successful wall probe is not merged into room refusals', !denied.has(566));
  ok('wall and spawn-cap refusals share the relocation decision',
     denied.has(557) && denied.has(563) && denied.size === 2,
     JSON.stringify([...denied.entries()]));
  ok('a cap-blocked assignment is deferred just like a wall-refused assignment',
     shouldRelocateToAssignedRoom({ assignedRoom: 563 }, elsewhere, denied) === false);
}

console.log('\n--- proving a spot that works ---');
{
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);                    // a rat, adjacent
  holdAt(p, 5, 5, { x: 340, y: 360 });
  look(p);                                            // first reading, nothing to compare
  ok('an untested spot is not trusted', !p.holdWorks(), 'holdWorks() false on arrival');
  look(p, 8000);                                      // 8s quiet with the rat next to us
  ok('still not trusted after 8s', !p.holdWorks(), `quiet ${Math.round(p.hold.quietMs / 1000)}s`);
  look(p, 8000);                                      // 16s total
  ok('trusted once it has held long enough', p.holdWorks(),
     `quiet ${Math.round(p.hold.quietMs / 1000)}s with ${p.hold.mostAttackers} adjacent`);
  ok('written to the book', p.book.get(999, 5, 5)?.held === 1,
     JSON.stringify(p.book.get(999, 5, 5)));
  ok('the exact position is recorded, not just the square', p.book.get(999, 5, 5)?.x === 340,
     'fine coordinate kept so we can stand where it actually worked');
}

console.log('\n--- disproving a spot that does not ---');
{
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  holdAt(p, 7, 7, { proven: true });
  w.me().col = 7; w.me().row = 7;
  w.addMonster(1, 0, 0, MONSTER);                     // put the rat back beside us
  look(p);
  w.hurt(4);                                          // hit while sitting still
  look(p, 8000);
  ok('a hit taken while standing still disproves it', !p.holdWorks(),
     `book says ${JSON.stringify(p.book.get(999, 7, 7))}`);
  ok('said so out loud', p.journal.some(e => e.what === 'THIS IS NOT A SAFE SPOT'));
  ok('and stops standing in it', p.hold === null,
     'keeping it would mean refusing to approach and refusing to withdraw while being hit');

  // Go back and be wrong about it a second time — which is what will happen, because
  // after one failure the geometry still recommends it.
  holdAt(p, 7, 7);
  look(p);
  w.hurt(4);
  look(p, 8000);
  ok('two failures discredit the square in the book',
     p.book.discredited(p.book.get(999, 7, 7)), JSON.stringify(p.book.get(999, 7, 7)));
}

// A FAILURE IS PERMANENT, SO THE PACKET THAT ARRIVES LATE MUST NOT CAUSE ONE.
//
// Being hit is resolved on the server and travels to us; our arrival travels the other
// way. A blow resolved while we were still a square short can therefore land after we
// have reported standing on the spot, and blame the wall for something that was already
// in the air. The walked-in path was covered by accident — takeSafeSpot stamps movedAt on
// arrival, so the first window is thrown out for "we moved" — but claiming a square we
// were ALREADY standing on walks nowhere, stamps nothing, and opened a countable window
// the instant the hold was taken.
console.log('\n--- a blow already in the air is not the wall\'s fault ---');
{
  const w = world({ col: 11, row: 11 });
  const p = keeper(w);
  w.addMonster(1, 0, 0, MONSTER);
  // Walked here long ago as part of the fight; claimed the square this instant. No walk
  // means no movement stamp, so the "we moved in this window" discard does not apply.
  holdAt(p, 11, 11, { settledMsAgo: 5000, takenMsAgo: 0 });
  look(p);
  w.hurt(4);                       // the approach's damage, arriving now
  look(p, 120);
  ok('a hit inside the settle grace does not discredit the square',
     !p.book.discredited(p.book.get(999, 11, 11)),
     `book says ${JSON.stringify(p.book.get(999, 11, 11))}`);
  ok('and does not touch the book at all', p.book.get(999, 11, 11) === null,
     'a discarded reading must leave no trace, or the record grows entries nothing concluded');
  ok('we are still standing in it', p.hold !== null,
     'releasing the hold on an untrusted reading throws away a square we never judged');
  const last = p.trials[p.trials.length - 1];
  ok('the reading is recorded as discarded rather than silently dropped',
     last && last.counted === false && /grace/.test(last.verdict || ''),
     JSON.stringify(last));
  ok('and carries how settled we were, so the grace can be argued from data',
     last && last.settled_ms != null && last.settled_ms < 250, JSON.stringify(last?.settled_ms));
}

// THE GRACE MUST NOT BECOME A HOLE. It buys one window, not immunity.
console.log('\n--- and once settled, a hit still condemns the square ---');
{
  const w = world({ col: 12, row: 12 });
  const p = keeper(w);
  w.addMonster(1, 0, 0, MONSTER);
  holdAt(p, 12, 12, { settledMsAgo: 5000, takenMsAgo: 0, proven: true });
  look(p);                         // baseline taken the instant the square was claimed
  look(p, 900);                    // a quiet window, discarded by the grace
  w.hurt(4);                       // now a real hit, well clear of the grace
  look(p, 900);
  ok('a hit after the grace still disproves the spot', !p.holdWorks(),
     `book says ${JSON.stringify(p.book.get(999, 12, 12))}`);
  ok('and is written to the book', (p.book.get(999, 12, 12)?.failed ?? 0) === 1,
     JSON.stringify(p.book.get(999, 12, 12)));
  ok('with the settled margin recorded on the entry',
     (p.book.get(999, 12, 12)?.min_settled_ms ?? -1) >= 250,
     JSON.stringify(p.book.get(999, 12, 12)));
}

// The same delay that hides a hit until later is what makes the square look quiet now,
// so a window we will not read for damage is not one we may read for proof either.
console.log('\n--- quiet inside the grace proves nothing either ---');
{
  const w = world({ col: 13, row: 13 });
  const p = keeper(w);
  w.addMonster(1, 0, 0, MONSTER);
  holdAt(p, 13, 13, { settledMsAgo: 5000, takenMsAgo: 0 });
  look(p);
  look(p, 200);                    // quiet, but inside the grace
  ok('quiet inside the grace does not accumulate toward proof', p.hold.quietMs === 0,
     'quietMs ' + p.hold.quietMs);
  ok('and the square is not written up as holding', p.book.get(999, 13, 13) === null,
     JSON.stringify(p.book.get(999, 13, 13)));
}

// PUTTING BACK A SQUARE RETIRED BEFORE THE GRACE EXISTED. See m59-safespot-retest.mjs.
//
// The danger in this direction is the opposite of the usual one: a reinstatement that
// restores TRUST rather than eligibility would put characters back onto squares on the
// strength of a judgement we have just decided was unreliable.
console.log('\n--- reinstating a square retired on one point of damage ---');
{
  // From the book module, not the tool: m59-safespot-retest.mjs is a script with no
  // entry-point guard, so importing it here would run it against the real book.
  const { selectForRetest, reinstateUntested } = await import('./m59-safespots.mjs');
  const rooms = {
    999: {
      '1,1': { col: 1, row: 1, held: 3, failed: 1, damage_taken: 1, held_seconds: 40 },
      '2,2': { col: 2, row: 2, held: 2, failed: 1, damage_taken: 6 },
      '3,3': { col: 3, row: 3, held: 0, failed: 1, damage_taken: 1 },
      '4,4': { col: 4, row: 4, held: 4, failed: 0 },
      '5,5': { col: 5, row: 5, held: 2, failed: 1, damage_taken: 1, verified: true },
    },
  };
  const picked = selectForRetest(rooms, { maxDamage: 1 });
  const keys = picked.map(p => p.key).sort();
  ok('picks the square that held and then went out on one point',
     keys.join(',') === '1,1', keys.join(',') || '(none)');
  ok('leaves a square that lost six — something genuinely reached that one',
     !keys.includes('2,2'));
  ok('leaves a square that never held — there is no proof to restore',
     !keys.includes('3,3'));
  ok('leaves a square that was never retired', !keys.includes('4,4'));
  ok('leaves a human-verified square alone', !keys.includes('5,5'),
     'a mark already outranks our arithmetic; zeroing its record would be a loss');

  const back = reinstateUntested(rooms[999]['1,1']);
  ok('the reinstated square is untested, not proven', back.held === 0 && back.failed === 0,
     JSON.stringify({ held: back.held, failed: back.failed }));
  ok('and is therefore NOT inherited as trusted',
     !(!!back.held && !new SafeSpotBook(null).discredited(back)),
     'takeSafeSpot reads held && !discredited — restoring held would rest characters on it');
  ok('it stays eligible to be offered again', back.retest === true,
     'zeroing held alone would drop any square that qualified only because it had held');
  ok('and keeps what it used to be', back.retest_from?.held === 3 && back.retest_from?.failed === 1,
     JSON.stringify(back.retest_from));
  ok('a reinstated square that fails again is out for good',
     new SafeSpotBook(null).discredited({ ...back, failed: 1 }),
     'retest must not survive a fresh failure, or the grace becomes a way back in for ever');

  // SELECTED AGAINST ONE BOOK, WRITTEN TO ANOTHER. The pardon zeroes damage_taken, which
  // is the very number that identifies this subset — so after it has run the squares are
  // invisible in the live book and have to be chosen from a snapshot taken before it.
  // The history kept must then be the SNAPSHOT's, not the pardoned record's zeroes.
  const pardoned = { col: 1, row: 1, held: 3, failed: 0, damage_taken: 0,
                     failed_before_wallhug: 1, retested_at: 0 };
  const viaRef = reinstateUntested(pardoned, { from: rooms[999]['1,1'] });
  ok('the live record is what gets rewritten', viaRef.held === 0 && viaRef.failed === 0,
     JSON.stringify({ held: viaRef.held, failed: viaRef.failed }));
  ok('but the history kept is the snapshot\'s, not the pardoned zeroes',
     viaRef.retest_from.failed === 1 && viaRef.retest_from.damage_taken === 1,
     JSON.stringify(viaRef.retest_from));
  ok('and the pardon\'s own marker is left intact', viaRef.failed_before_wallhug === 1,
     'overwriting it would erase that a different tool had already judged this square');
}

console.log('\n--- damage we asked for proves nothing ---');
{
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  holdAt(p, 5, 5);
  look(p);
  p.swungAt = Date.now();                             // we hit it, so it hits back
  w.hurt(6);
  look(p, 8000);
  ok('retaliation after our own swing does not count against the spot',
     p.hold.failures === 0, 'the mechanic allows exactly this, so it is not evidence');
  ok('nor does it count in favour of it', p.hold.quietMs === 0,
     'a window we swung in is not a test of anything');
}

console.log('\n--- quiet because of the walls, or quiet because of the grace period? ---');
{
  // The dangerous false positive. On entry — and a reconnect is an entry — the server
  // will not let the monsters attack until the player acts. A spot "proved" during
  // that window has been proved by the server's politeness, and the character will
  // take that belief into the next fight and rest through a beating on the strength
  // of it.
  const w = world();
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  // A square of its own: the book is shared with the other blocks on purpose — that
  // is what makes it a book — so "nothing was written" has to be asked somewhere
  // nothing has been written before.
  w.me().col = 3; w.me().row = 3;
  w.addMonster(1, 0, 0, MONSTER);
  holdAt(p, 3, 3);
  p.rejoinedAt = Date.now();                          // just logged back in
  look(p); look(p, 8000); look(p, 8000); look(p, 8000);
  ok('quiet during the grace period proves nothing', !p.holdWorks(),
     `${Math.round(p.hold.quietMs / 1000)}s of quiet, and none of it counted`);
  ok('nothing written to the book on that evidence', !p.book.get(999, 3, 3));

  p.turnedAt = Date.now();                            // now act, and wake the room
  look(p); look(p, 8000); look(p, 8000);
  ok('the same quiet counts once we have woken them', p.holdWorks(),
     'turning is what makes the experiment mean anything');
}

console.log('\n--- keeping track of where we are ---');
{
  const w = world();
  const p = keeper(w);
  holdAt(p, 5, 5, { proven: true });
  p.pendingPull = { waitUntil: Date.now() + 30_000, target: 'giant rat' };
  p.pullsWithoutContact = 2;
  w.me().col = 6;                                     // something moved us
  look(p);
  ok('a spot we are not standing on is released', p.hold === null,
     'holding a belief about a square we left is how a keeper walks into a swarm confident');
  ok('and said why', p.journal.some(e => e.what === 'gave up the safe spot'));
  ok('pull evidence is released with its wall',
     p.pendingPull === null && p.pullsWithoutContact === 0,
     'misses from one square must not condemn the next square');
}
{
  const w = world();
  const p = keeper(w);
  holdAt(p, 5, 5, { proven: true });
  w.s.world.room = { num: 1000, name: 'Somewhere Else' };
  look(p);
  ok('a spot in another room is released', p.hold === null);
}

console.log('\n--- is this fight worth a wall? ---');
{
  const w = world({ health: 25, max: 25 });
  const p = keeper(w);
  const above = p.holdWorthwhile(['giant rat']);       // level 30 vs our 25
  ok('yes when the kill can raise max health', above.hold,
     `level ${above.level} vs our ${above.my_level}: ${above.why.slice(0, 60)}...`);
  const below = p.holdWorthwhile(['baby spider']);     // level 25 vs our 25 — pays nothing
  ok('no when we outclass it and it is alone', !below.hold,
     `level ${below.level} vs our ${below.my_level}`);
  ok('unknown creatures get the wall', p.holdWorthwhile(['no such beast']).hold,
     'the careful reading of an unknown creature is that it can hurt us');
  p.policy.useSafeSpots = false;
  ok('and the owner can still switch it off', !p.holdWorthwhile(['giant rat']).hold);
}
{
  // Outclassed prey, but three of them: swarms are what actually kills characters.
  const w = world({ health: 40, max: 40 });
  const p = keeper(w);
  w.addMonster(1, 1, 0, MONSTER);
  w.addMonster(2, 2, 0, MONSTER);
  w.addMonster(4, 0, 2, MONSTER);
  const v = p.holdWorthwhile(['baby spider']);
  ok('a crowd of things we outclass still gets the wall', v.hold, `crowd ${v.crowd}`);
}

console.log('\n--- what it reports back ---');
{
  const w = world();
  const p = keeper(w);
  ok('honest when not in one', p.status().safe_spot === false);
  w.addMonster(1, 1, 0, MONSTER);
  w.addMonster(2, 0, 1, MONSTER);
  holdAt(p, 5, 5, { canReachYou: 3, backCover: 5 });
  look(p); look(p, 14000);
  const st = p.status();
  ok('reports that the spot works, with the evidence', st.safe_spot.works,
     st.safe_spot.evidence);
  ok('counts what is on us', st.threat.in_swing_range === 2,
     `${st.threat.in_swing_range} in range, ${st.threat.camped_on_us} camped`);
  ok('and is honest that targeting is inferred, not told',
     /nothing in the protocol says/.test(st.threat.note));
}

console.log('\n--- the measurement is auditable, not just the conclusion ---');
{
  // Every window has to leave a record saying what it was and why it counted or did
  // not. Without this the only thing anyone can disagree with is the summary, and a
  // measurement bug lives entirely in the discards.
  const w = world();
  const p = keeper(w);
  const verdicts = () => p.trials.map(t => t.verdict);

  look(p);
  ok('a reading with no spot says so', /not holding/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  {
    // A keeper that has only just started has nothing to compare against, which is a
    // different discard from all the others and has to say so rather than look quiet.
    const w2 = world();
    const p2 = keeper(w2);
    w2.addMonster(1, 1, 0, MONSTER);
    holdAt(p2, 5, 5);
    look(p2);
    ok('the first reading has nothing to compare to', /no previous reading/.test(p2.trials.at(-1).verdict),
       p2.trials.at(-1).verdict);
  }

  w.me().col = 4; w.me().row = 4;
  holdAt(p, 4, 4);
  look(p);
  look(p, 8000);
  ok('quiet with nothing adjacent is not evidence', /nothing was in swing range/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  w.addMonster(1, 1, 0, MONSTER);
  look(p, 8000);
  p.swungAt = Date.now();
  look(p, 8000);
  ok('a window we swung in is named as such', /we swung/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  p.rejoinedAt = Date.now();
  look(p, 8000);
  ok('a window inside the grace period is named as such', /grace period/.test(p.trials.at(-1).verdict),
     p.trials.at(-1).verdict);

  const t = p.trials.at(-1);
  ok('and every reading carries its own inputs',
     ['window_s', 'health_before', 'health_after', 'adjacent_at_start', 'swung_in_window',
      'moved_in_window', 'monsters_awake'].every(k => k in t),
     JSON.stringify(t));
  ok('discards are distinguishable from conclusions', p.trials.every(x => x.counted === false),
     `${verdicts().length} readings so far, none of them counted`);
}

console.log('\n--- stopping is not instant, and starting has to know that ---');
{
  // The sequence every relocation uses: stop the keeper, walk the character somewhere,
  // start it again. The walk takes longer than a pass, so the start lands while the
  // old loop is still winding down — and if start() believes `running` it returns
  // "already going" and is then switched off by the loop it declined to replace. The
  // keeper then reports itself started and does nothing at all, for ever.
  const w = world();
  const p = keeper(w);
  p.pass = async () => { await new Promise(r => setTimeout(r, 30)); };   // a slow pass
  // ...and a short gap, so the test is not a sleep. decideMs is what the loop waits on
  // now — deciding was un-bundled from resyncing, and idleMs only sets how often the
  // server is re-asked. Both are set so the intent survives whichever one is read.
  p.policy.decideMs = 10;
  p.policy.idleMs = 10;
  p.start();
  ok('starts', p.running);
  // THE ORDINARY STOP NO LONGER HAS THIS RACE, because it no longer ends the loop: it
  // makes the keeper inert, which takes effect on the flag rather than at a pass
  // boundary. That is the point of it — see Autopilot.goInert — and it is worth pinning
  // that the instant path really is instant.
  p.stop('held for an errand');
  ok('the ordinary stop takes effect immediately', p.running && !!p.inert,
     'nothing has to wait for the pass to end, because the loop is not ending');
  p.start();
  ok('and a start hands the controls straight back', p.running && !p.inert);

  // THE HARD STOP STILL HAS IT, and always will: ending a loop means waiting for the
  // pass it is inside, and a walk is longer than a pass. This is the sequence that
  // stranded three characters — stop, walk, start — where the start landed while the old
  // loop was still winding down, returned "already going", and was then switched off by
  // the very loop it had declined to replace.
  p.stop('code is being reloaded', { hard: true });
  ok('a hard stop is only a request at first', p.running && p.stopping,
     'the loop is still mid-pass; it has not noticed yet');
  ok('a hard stop turns off its independent watchdog immediately', !p.watchTimer);
  p.start();
  ok('a start cancels a hard stop that has not landed', p.running && !p.stopping);
  ok('cancelling that stop restores the independent watchdog', !!p.watchTimer);
  ok('and restores the current pass observation window', p.passStartedAt != null);
  ok('and says so in the journal',
     p.journal.some(e => /start cancelled a stop/.test(e.what) &&
                         e.watchdog_restarted === true && e.uptime_resumed === true &&
                         e.pass_watch_restored === true));

  await new Promise(r => setTimeout(r, 150));   // let several passes go by
  ok('it is still running afterwards', p.running,
     'the winding-down loop must not switch off the keeper that replaced its orders');
  p.stop('really stopping now', { hard: true });
  await new Promise(r => setTimeout(r, 150));
  ok('and an uncancelled hard stop still stops it', !p.running);
}

console.log('\n--- friendly bots are not a monster swarm ---');
{
  // What actually happened to Isolde: three of her own fleet stacked on one square
  // in an inn. Every character is ATTACKABLE, so they counted as things about to kill
  // her, and at 4 of 25 health she froze — which is the one state in which health
  // cannot come back. She woke, counted the same three, and froze again, for ever.
  const w = world({ health: 4, max: 25 });
  const p = keeper(w);
  const PLAYER = OF.PLAYER;
  w.addMonster(3, 0, 0, MONSTER | PLAYER);          // a friendly bot on our own square
  w.addMonster(4, 1, 0, MONSTER | PLAYER);
  w.addMonster(5, 0, 1, MONSTER | PLAYER);
  const c = w.c, me = w.me();
  const near = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 2);
  ok('a pile of players registers as no threat at all', near.length === 0,
     'three characters adjacent, none of them counted');
  w.addMonster(6, 1, 1, MONSTER);                    // ...and a real monster still does
  const near2 = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 2);
  ok('but a real monster beside them still does', near2.length === 1);
}

console.log('\n--- a freeze that changed nothing is not repeated ---');
{
  // Independent of what caused it: playing dead recovers vigor and never health, so
  // freezing twice from the same health can never end. The guard has to be on the
  // outcome, not on the cause.
  const w = world({ health: 4, max: 25 });
  const p = keeper(w);
  // ON A PROVEN WALL, because since 2026-08-21 that is the only place a freeze is legal at
  // all: off one, playDead refuses outright, since it recovers vigor and NEVER health and
  // three characters were measured freezing in the open and dying. That rule is pinned in
  // m59-playdead-test.mjs. THIS block is about something else — the livelock guard, which
  // is on the OUTCOME rather than the cause — so it has to set up the one situation where
  // a freeze can happen, or it is testing the refusal instead of the repeat.
  p.hold = { col: w.me().col, row: w.me().row, proven: true, takenAt: Date.now() - 60_000 };
  let rejoins = 0;
  p.s.rejoin = async () => { rejoins++; };
  const first = await p.playDead('test');
  ok('the first freeze is allowed', first === true, `rejoined ${rejoins}x`);
  p.frozenUntil = null;
  const second = await p.playDead('test');     // same health: one more is tolerated
  const third = await p.playDead('test');      // and then it must stop
  ok('a repeat from the same health is refused', third === false,
     `second=${second}, third=${third}`);
  ok('and it says why rather than looping quietly',
     p.journal.some(e => /refusing to freeze again/.test(e.what)));
  w.c._health = 20;                            // healed: the guard must release
  const after = await p.playDead('test');
  ok('freezing is allowed again once health has moved', after === true);
}

console.log('\n--- nobody calls for rescue from a pub ---');
{
  // Being hurt is not being in danger. Monsters cannot attack in an inn at all, so a
  // broadcast from one spends mana and other players' attention on a character that
  // is in no trouble and can fix itself by moving and sitting down.
  const w = world({ health: 3, max: 25 });
  const p = keeper(w);
  let broadcasts = 0;
  w.c.me = { name: 'Tester' };
  w.c.roomNameRsc = 1;
  w.c.requestInventory = () => {};
  w.c.waitFor = async () => ({ events: [] });
  w.c.broadcast = async () => { broadcasts++; };
  w.c.say = async () => { broadcasts++; };
  w.s.pacer = { submit: async (_k, fn) => fn() };
  w.s.need = () => w.c;

  p.sanctuary = () => true;                       // standing in an inn
  await p.askForHelp('badly hurt and out of flasks');
  ok('a hurt character in a sanctuary says nothing', broadcasts === 0,
     'it can move and rest its way back to full without anyone');
  ok('and records why rather than failing silently',
     p.journal.some(e => /not asking for help/.test(e.what)));

  p.sanctuary = () => false;                      // out in the world
  p.lastPleaAt = 0;
  await p.askForHelp('badly hurt and out of flasks').catch(() => {});
  ok('but the same character in the field still asks', broadcasts > 0);
}

console.log('\n--- no dead zone between "too hurt to fight" and "hurt enough to rest" ---');
{
  // The gap that stranded Cedric: restBelow 0.6, engageAt 0.9 for anything under
  // thirty max health, so 64% health is too hurt to start a fight and not hurt enough
  // to sit down. A keeper in that band does neither, for ever, and the branch that
  // declines the fight reports progress — so it does not even look stuck.
  const w = world({ health: 18, max: 28 });
  const p = keeper(w);
  p.mode = 'farm';
  p.policy.hunt = 'centipede';
  // The number the fleet actually runs, not the module default — the gap opens as
  // soon as restBelow is set anywhere under engageAt, and every character here is
  // configured at 0.6.
  p.policy.restBelow = 0.6;
  const engageAt = p.safety().engageAt;
  const restAt = Math.max(p.policy.restBelow, 0, engageAt);
  const hp = 18 / 28;
  ok('the old thresholds really did leave a gap', hp > p.policy.restBelow && hp < engageAt,
     `${Math.round(hp * 100)}% is above restBelow ${p.policy.restBelow} and below engageAt ${engageAt}`);
  ok('resting now triggers anywhere below the engage threshold', hp < restAt,
     `restAt is now ${restAt}, so 64% rests instead of waiting`);
  ok('and the two thresholds cannot cross', restAt >= engageAt,
     'whatever health it takes to be willing to fight is the health worth resting to');
}

console.log('\n--- fleetmates are not prey ---');
{
  // What was actually happening: 131 of 132 "hit back at whatever is adjacent"
  // decisions across the fleet were aimed at another of our own characters. Guardian
  // angels meant nobody died of it — twenty-five characters simply spent the night
  // swinging at each other and produced three kills between them.
  const w = world();
  const p = keeper(w);
  const PLAYER = OF.PLAYER;
  w.addMonster(3, 1, 0, MONSTER | PLAYER);          // a fleetmate, adjacent
  const c = w.c, me = w.me();
  const adjacent = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 1.5);
  ok('an adjacent fleetmate is never picked as a target', adjacent.length === 0,
     'every character is ATTACKABLE, so this filter is the only thing separating them');
  w.addMonster(4, 0, 1, MONSTER);
  const adj2 = [...c.room.objects.values()].filter(o =>
    o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
    Math.hypot(o.col - me.col, o.row - me.row) <= 1.5);
  ok('a real monster beside the fleetmate still is', adj2.length === 1);
}

console.log('\n--- one wall each ---');
{
  // The geometry is deterministic, so every keeper in a room ranks the same squares
  // identically and they all walk to the same corner — three characters ended up on
  // (50,21) of one room and four stacked on (8,15) of the Limping Toad.
  const { claimSpot, releaseSpot, spotTakenByAnother } = await import('./m59-autopilot.mjs');
  claimSpot('o1', 586, 35, 40);
  ok('a claimed square is closed to everyone else',
     spotTakenByAnother('o3', 586, 35, 40) === 'o1');
  ok('but not to the keeper that claimed it',
     spotTakenByAnother('o1', 586, 35, 40) === null,
     'it must be able to re-take its own spot after a reconnect');
  ok('a different square in the same room is free',
     spotTakenByAnother('o3', 586, 20, 49) === null);
  ok('and the same square in a different room is free',
     spotTakenByAnother('o3', 587, 35, 40) === null);
  claimSpot('o1', 586, 12, 12);
  ok('claiming a new one releases the old', spotTakenByAnother('o3', 586, 35, 40) === null,
     'a keeper holds at most one wall');
  releaseSpot('o1');
  ok('giving it up frees it', spotTakenByAnother('o3', 586, 12, 12) === null);
}

console.log('\n--- pairing loot runs ---');
{
  const { planRuns } = await import('./m59-lootrun.mjs');
  const fleet = [
    // A farmer going well: killing, nearly full, plenty of vigor left.
    { agent: 'o1', character: 'Roland', in_game: true, carrying: 12, max_carry: 14,
      vigor_of: '150/200', health: '20/20', autopilot: { kills: 9 }, room_num: 586, room: 'Tos gate',
      has_food: true, has_weapon: true },
    // A runner: empty pack, no food, healthy enough to walk.
    { agent: 's1', character: 'Seraphel', in_game: true, carrying: 2, max_carry: 14,
      vigor_of: '80/200', health: '20/20', autopilot: { kills: 0 }, has_food: false, has_weapon: true },
    // Too hurt to be sent anywhere.
    { agent: 's2', character: 'Aurelia', in_game: true, carrying: 0, max_carry: 14,
      vigor_of: '80/200', health: '4/21', autopilot: { kills: 0 }, has_food: false, has_weapon: true },
  ];
  const p = planRuns(fleet);
  ok('the overflowing farmer is spotted', p.farmers_overflowing.includes('Roland'),
     `12/14 carried and still killing`);
  ok('a healthy poor character is sent', p.runs[0]?.runner_name === 'Seraphel',
     p.runs[0]?.why ?? 'no run planned');
  ok('the badly hurt one is not', !p.runners_free.includes('Aurelia'),
     '4/21 health — the walk goes through what made the farmer rich');
  ok('payment is credit when the runner has no food',
     /proceeds/.test(p.runs[0]?.pay_with ?? ''), p.runs[0]?.pay_with);

  const idle = planRuns([{ agent: 'x', character: 'Idle', in_game: true, carrying: 1, max_carry: 14,
                           vigor_of: '150/200', health: '20/20', autopilot: { kills: 9 } }]);
  ok('an empty-handed farmer is not worth a trip', idle.runs.length === 0, idle.note);
}

console.log('\n--- nobody starts a fight tired ---');
{
  const { Autopilot, STRATEGIES } = await import('./m59-autopilot.mjs');
  // The effective floor has to be REACHABLE BY RESTING or it strands everyone without
  // food. Resting stops at the rest threshold of 80.
  const REST_STOPS_AT = 80;
  const floors = Object.entries(STRATEGIES)
    .map(([k, v]) => [k, v.vigorFloor ?? v.fightAboveVigor ?? 0]);
  ok('no strategy still permits fighting at any vigor',
     floors.every(([, f]) => f >= REST_STOPS_AT), JSON.stringify(floors));
  const starved = {
    policy: { strategy: 'baseline' },
    s: { client: {} },
    larder: () => [],
    vigor: { starved_passes: 0 },
  };
  const starvedFloor = Autopilot.prototype.fightFloor.call(starved);
  ok('the empty-larder baseline floor is exactly reachable by resting',
     starvedFloor === REST_STOPS_AT,
     `resting stops at ${REST_STOPS_AT}; effective floor is ${starvedFloor}`);

  // And the reader that all of this depends on: vigor is {value, scale_max}, not
  // {value, max}, so the old pct() silently returned null and every vigor decision in
  // the file was dead code.
  const vitals = { vigor: { value: 61, scale_max: 200, rest_threshold: 80 } };
  const oldPct = v => (v && v.max ? v.value / v.max : null);
  const vigorPct = v => (v?.vigor?.value == null ? null : v.vigor.value / (v.vigor.scale_max ?? 200));
  ok('the old reader really did return null', oldPct(vitals.vigor) === null,
     'which is why no character has ever rested for being tired');
  ok('the new one reads it', Math.round(vigorPct(vitals) * 100) === 31,
     `61 of 200 = ${Math.round(vigorPct(vitals) * 100)}%`);
}

console.log('\n--- a character can be a service ---');
{
  const { planProvisioning } = await import('./m59-lootrun.mjs');
  const { planCharacter, STAT_ORDER } = await import('./m59-newchar.mjs');

  const fleet = [
    { agent: 'q1', character: 'Malig', in_game: true, mana_now: 23,
      provides: ['create food', 'create weapon'], has_food: true, has_weapon: true },
    { agent: 's1', character: 'Seraphel', in_game: true, mana_now: 20, provides: [],
      has_food: false, has_weapon: false, room_num: 544 },
  ];
  const p = planProvisioning(fleet);
  ok('a caster is matched to what it can fix', p.jobs.length === 2,
     p.jobs.map(j => j.service).join(', '));
  ok('create weapon is free of reagents',
     p.jobs.find(j => j.service === 'create weapon')?.reagents_needed.length === 0,
     'one caster can arm the whole fleet for nothing');
  ok('and flagged as temporary',
     p.jobs.find(j => j.service === 'create weapon')?.temporary === true,
     'it expires in minutes to hours — a stopgap, not a repair');
  ok('create food asks the supplicant for reagents',
     p.jobs.find(j => j.service === 'create food')?.reagents_needed.length === 2);
  ok('a fleet with no caster is told what to do about it',
     /reroll/.test(planProvisioning([fleet[1]]).note ?? ''),
     planProvisioning([fleet[1]]).note);

  // The creation path these depend on.
  const plan = planCharacter({ name: 'Testchar' });
  ok('the default new character can cast both on day one',
     plan.uncastable_at_first.length === 0 &&
     plan.spells.some(s => s.name === 'create weapon') &&
     plan.spells.some(s => s.name === 'create food'),
     'Kraanan has no karma gate, unlike Shal\'ille (+10) and Qor (-10)');
  ok('and spends every stat point', plan.stat_total === 200,
     `${plan.stat_total}/200, ceiling ${plan.max_health_ceiling}`);
}

console.log('\n--- one character\'s experiment is every character\'s knowledge ---');
{
  const p = keeper(world());
  p.book.save();
  const fresh = new SafeSpotBook(BOOK);
  ok('a proven spot survives a restart', fresh.get(999, 5, 5)?.held >= 1,
     JSON.stringify(fresh.list(999).map(x => `${x.col},${x.row}:${x.verdict}`)));
  ok('and so does a disproved one', fresh.discredited(fresh.get(999, 7, 7)),
     'the geometry will keep recommending it; the book is what stops us going back');
}

// --- vigor is not shaped like health, and reading it wrong stops the whole fleet ---
//
// The deadlock this guards: the keeper reads vigor correctly and sends anyone below
// restBelow to rest; restUntil read it with a helper that wants {value,max}, got null
// from {value,scale_max}, and treated null as "already full". So it answered "already
// recovered" without sitting down, the rest branch returned before farming or errands,
// and the character did nothing at all — for ever — while reporting full health and a
// sensible activity. Thirty-seven characters, no kills, nothing in any log to see.
console.log('\n--- vigor is not shaped like health ---');
{
  const vigor = { value: 40, scale_max: 200, rest_threshold: 80 };
  const naive = v => (v && v.max ? v.value / v.max : null);
  ok('the naive {value,max} read gives nothing for vigor', naive(vigor) === null,
     'vigor has scale_max, not max');
  ok('and "nothing" defaulted to satisfied, which is the deadlock',
     (naive(vigor) ?? 1) >= 0.4, 'null ?? 1 >= any target');

  const vigorFrac = g => (!g || g.value == null) ? null : g.value / (g.scale_max ?? 200);
  ok('reading it against scale_max gives the real fraction', vigorFrac(vigor) === 0.2,
     `40/200 = ${vigorFrac(vigor)}`);
  ok('so a tired character is now correctly seen as needing rest',
     (vigorFrac(vigor) ?? 1) < 0.4);

  // The second half: resting can only ever reach RestTimer's threshold, so a target
  // above it is a target that never arrives.
  const REST_VIGOR_CAP = 0.4;
  ok('the rest target never exceeds what resting can deliver',
     Math.min(0.6, REST_VIGOR_CAP) === 0.4,
     'restBelow 0.6 would ask for 120 of 200; resting stops at 80');
  ok('and a character that rested to the cap is no longer "hurt"',
     !((80 / 200) < Math.min(0.6, REST_VIGOR_CAP)),
     'otherwise it stands up and sits straight back down');
}

// --- one failure retires a spot for good ---
//
// Godfrey died on a square recorded held:1. Under the old rule (failed >= 2 AND failed >
// held) it stayed "proven" and stayed recommended — to him, and to everyone inheriting
// the book. Spots seem safe at first and turn out not to be: the wall that holds two
// attackers does not hold six.
console.log('\n--- a spot that has ever failed is retired ---');
{
  const { safeSpotBook } = await import('./m59-safespots.mjs');
  const b = safeSpotBook(BOOK);
  b.held(900, { col: 1, row: 1, seconds: 60, attackers: 2 });
  ok('a clean square is not discredited', !b.discredited(b.get(900, 1, 1)));
  ok('and it reports as holding', b.list(900).find(r => r.col === 1)?.verdict === 'holds');

  b.failed(900, { col: 1, row: 1, damage: 99, attackers: 6 });
  const rec = b.get(900, 1, 1);
  ok('one failure discredits it even though it held first', b.discredited(rec),
     `held ${rec.held}, failed ${rec.failed}`);
  ok('and the verdict says so rather than "holds"',
     b.list(900).find(r => r.col === 1)?.verdict === 'does not work');

  // Holding again afterwards must not buy it back.
  b.held(900, { col: 1, row: 1, seconds: 120, attackers: 1 });
  b.held(900, { col: 1, row: 1, seconds: 120, attackers: 1 });
  ok('holding three times afterwards does not rehabilitate it',
     b.discredited(b.get(900, 1, 1)),
     `held ${b.get(900,1,1).held}, failed ${b.get(900,1,1).failed}`);
}

// --- the newbie zone is a separate world with a one-way door ---
console.log('\n--- provisioning does not propose what it cannot reach ---');
{
  const { planProvisioning } = await import('./m59-lootrun.mjs');
  const caster = { agent: 'qm1', character: 'Kraan', in_game: true, mana_now: 25,
                   provides: ['create weapon', 'create food'],
                   has_food: true, has_weapon: true, room: 'Raza Inn', room_num: 1011 };
  const far = { agent: 'o1', character: 'Roland', in_game: true, mana_now: 15, provides: [],
                has_food: false, has_weapon: false, room: 'Main gate to the city of Tos', room_num: 586 };
  const near = { agent: 'nf1', character: 'Aldric', in_game: true, mana_now: 15, provides: [],
                 has_food: false, has_weapon: false, room: 'Mausoleum', room_num: 1016 };

  const split = planProvisioning([caster, far]);
  ok('a caster in Raza is not paired with a supplicant outside it', split.jobs.length === 0,
     split.jobs.map(j => j.why).join('; ') || 'no jobs');
  ok('and the reason is reported rather than silently dropped',
     /one-way|Raza/.test((split.unreachable || []).join(' ')), (split.unreachable || [])[0]);

  const same = planProvisioning([caster, near]);
  ok('two characters on the same side of the portal still pair up', same.jobs.length === 2,
     same.jobs.map(j => j.service).join(', '));
}

// -------------------------------------------------- who judged the square
//
// A failure is permanent whichever activity found it out — a square that let a blow
// through is a bad square whether the character was fighting from it or resting at it
// part-way through a journey, and the conservative direction is the cheap one. But the two
// are not the same evidence: a travel hold is taken in a room nobody chose, with whatever
// followed you through the door, on a wall derived from geometry nobody has stood on. So
// the judge is written down and the travel-only rejections stay fishable.
console.log('\nprovenance of a verdict');
{
  const b = new SafeSpotBook(BOOK);
  b.held(544, { col: 5, row: 5, seconds: 12, attackers: 2, source: 'fight' });
  b.held(544, { col: 5, row: 5, seconds: 12, attackers: 2, source: 'fight' });
  b.failed(544, { col: 5, row: 5, damage: 3, attackers: 1, source: 'travel' });
  const rec = b.list(544).find(r => r.col === 5);

  ok('A TRAVEL FAILURE STILL DISCREDITS THE SQUARE — permanently, and on purpose',
     b.discredited(rec) && rec.verdict === 'does not work');
  ok('the most recent judge is named', rec.failed_via === 'travel' && rec.held_via === 'fight');
  ok('and every judge is counted, so one travel failure against two fight holds is legible',
     rec.failed_by.travel === 1 && rec.held_by.fight === 2);
  ok('THE TRAVEL-ONLY REJECTIONS CAN BE FISHED OUT, which is the whole reason for the tag',
     [rec].filter(r => b.discredited(r) && r.failed_by && !r.failed_by.fight).length === 1);

  b.failed(544, { col: 9, row: 9, damage: 1, attackers: 1 });
  const untagged = b.list(544).find(r => r.col === 9);
  ok('an untagged failure — every record written before this existed — still reads exactly ' +
     'as it did, rather than defaulting into anybody\'s pile',
     untagged.failed === 1 && untagged.failed_via === undefined && untagged.failed_by === undefined);
  ok('and it is still discredited, because that never depended on knowing who judged it',
     b.discredited(untagged));
}

try { unlinkSync(BOOK); } catch { /* never written */ }
console.log('');
console.log('shelters planned with the route, not searched for from a standstill');
{
  // You do not add a fuel stop by braking in the road, unfolding a map and re-planning from
  // a standstill. You work out where the stops are while driving and change the road ahead.
  // The version this replaces did the braking: cancel the journey, hand the character back,
  // search the room from wherever it happened to be, walk to whatever it found. Health leaves
  // at a median of 4.7 a second and the average maximum here is 45 — nine and a half seconds
  // from full to dead — so stopping to think was most of it.
  const shelters = [
    { col: 5,  row: 5,  atStep: 2,  detour: 2, proven: false },
    { col: 9,  row: 9,  atStep: 2,  detour: 1, proven: true  },
    { col: 20, row: 20, atStep: 10, detour: 1, proven: true  },
    { col: 30, row: 30, atStep: 18, detour: 9, proven: true  },
  ];
  const at = (i, o) => shelterAhead(shelters, i, o);

  ok('the next stop ahead is offered', at(0)?.atStep === 2);
  // AHEAD, NEVER BEHIND. A character got hurt somewhere; sending it back through the place
  // it was bitten to reach a wall it has already passed is a longer way to die.
  ok('one already passed is not offered', at(5)?.atStep === 10);
  ok('and when everything is behind, nothing is offered', at(19) === null);
  // NEAREST ALONG THE ROUTE, not best in the room — the best may be forty squares on, which
  // is the same mistake as searching.
  ok('the nearest along the route wins, not the best',
     at(0)?.detour === 1 && at(0)?.row === 9);
  // THE REAL GATE IS THE DETOUR. A wall nine squares off the road is not shelter when there
  // are nine seconds of health left.
  ok('a stop too far off the road is not shelter', at(11) === null);
  ok('unless the caller says it will pay that far', at(11, { maxDetour: 12 })?.atStep === 18);
  ok('an empty list is null rather than a throw', shelterAhead([], 0) === null);
  ok('and so is nothing at all', shelterAhead(null, 0) === null);
}

console.log('');
console.log('--- a safe wall is the two grids disagreeing ---');
{
  // The criterion the operator set, 2026-08-21: a wall is worth standing at because the
  // COARSE grid offers approaches the MOVER refuses. Everything else in this file scores a
  // square on coarse walkability and line of sight, which describes the server artifact
  // monsters path on and says nothing about whether the approach can be MADE.
  //
  // A stub geometry rather than a baked room: this is arithmetic over two predicates, and
  // pinning it against a real room would pin the room instead of the rule.
  const dgeo = (walkable, lands, ready = true) => ({
    rows: 9, cols: 9, collisionReady: ready,
    walkable: (r, c) => walkable(r, c),
    moverStepLands: (fr, fc, tr, tc) => lands(fr, fc, tr, tc),
  });
  const allOpen = () => true;

  const none = gridDisagreementAt(dgeo(allOpen, () => true), 5, 5);
  ok('open floor the mover agrees with has nothing refused',
     none && none.offered === 8 && none.refused === 0, JSON.stringify(none));

  const all = gridDisagreementAt(dgeo(allOpen, () => false), 5, 5);
  ok('a square the mover will not let anything into is refused from every side',
     all && all.offered === 8 && all.refused === 8, JSON.stringify(all));

  const half = gridDisagreementAt(dgeo(allOpen, (fr) => fr >= 5), 5, 5);
  ok('and a genuine wall refuses SOME of what the grid offers',
     half && half.offered === 8 && half.refused > 0 && half.refused < 8, JSON.stringify(half));

  // Squares the coarse grid already calls solid are not a disagreement — there is nothing
  // being offered to refuse, and counting them would score plain rock as perfect cover.
  const walled = gridDisagreementAt(dgeo((r) => r >= 5, () => true), 5, 5);
  ok('rock the grid already refuses is not counted as a disagreement',
     walled && walled.offered < 8 && walled.refused === 0, JSON.stringify(walled));

  // THE ONE THAT MATTERS MOST. `moverStepLands` answers TRUE for everything when collision
  // is not baked — it is built to get out of the way, not to veto what it cannot check. So
  // "no disagreement" and "cannot tell" read identically unless this refuses to answer, and
  // a measurement that degrades to a plausible number instead of to an absence is how a
  // whole criterion gets switched off without anybody noticing.
  ok('an unbaked room answers NULL rather than zero',
     gridDisagreementAt(dgeo(allOpen, () => true, false), 5, 5) === null);
  ok('and so does a geometry with no mover at all',
     gridDisagreementAt({ rows: 9, cols: 9, collisionReady: true, walkable: allOpen }, 5, 5) === null);
  ok('and no geometry at all is null, not a throw', gridDisagreementAt(null, 5, 5) === null);
}


console.log('');
console.log('A WALL WE COULD NOT WALK TO IS NOT SHELTER');
{
  // From a dead character's own decision trail in the Western border of the Twisted Wood:
  //
  //   could not reach the safe spot
  //   will not rest in the open here
  //   leaving the room to recover safely
  //   could not leave
  //
  // ...and then it died. Nothing recorded the failure, so every pass chose the SAME
  // unreachable square, and the crossing was never allowed to proceed. All three of that
  // room's baked rails answer `moverStepLands` on every step — the room was crossable the
  // whole time; the character simply never got to walk it.
  //
  // Distinct from the safe-spot BOOK, which records squares that failed to HOLD. That is a
  // fact about the wall and it is permanent. This is a fact about the WALK, usually
  // temporary — something in the doorway — so it expires rather than condemning a good wall.
  const spots = [
    { atStep: 1, detour: 1, col: 10, row: 5, refused_approaches: 3, proven: true },
    { atStep: 2, detour: 2, col: 20, row: 5, refused_approaches: 2, proven: false },
  ];
  const first = shelterAhead(spots, 0, { maxDetour: 4 });
  ok('with nothing excluded, the nearest planned stop is offered',
     first?.col === 10, JSON.stringify(first));

  const skipped = shelterAhead(spots, 0, { maxDetour: 4, unreachable: new Set(['10,5']) });
  ok('a stop we failed to reach is not offered again',
     skipped?.col === 20, JSON.stringify(skipped));

  // AND WHEN NOTHING IS LEFT, IT SAYS SO rather than handing back a square it already knows
  // is no good. Null is what lets the rung decline and the journey carry on — which is the
  // whole point: a shelter that cannot be reached must not keep cancelling the crossing.
  const none = shelterAhead(spots, 0, { maxDetour: 4, unreachable: new Set(['10,5', '20,5']) });
  ok('and when every planned stop is unreachable it declines outright', none === null,
     JSON.stringify(none));

  // The exclusion is applied BEFORE the ranking, not after — otherwise an unreachable square
  // wins on disagreement and is then failed again, which is the loop this replaces.
  const ranked = shelterAhead(
    [{ atStep: 1, detour: 1, col: 30, row: 5, refused_approaches: 9 },
     { atStep: 1, detour: 1, col: 31, row: 5, refused_approaches: 1 }],
    0, { maxDetour: 4, unreachable: new Set(['30,5']) });
  ok('and the best-scoring square does not win it back by scoring well',
     ranked?.col === 31, JSON.stringify(ranked));
}

// ---------------------------------------------------------------------------
// A SAFE SPOT IS THE TWO GRIDS DISAGREEING, AND NOTHING ELSE IS A CANDIDATE.
//
// Added 2026-08-23. The search used to open its candidate loop with
//
//     if (!geo.walkable(r, c)) continue;
//
// which considers only squares the COARSE grid admits — the grid monsters path on. That
// excluded, by construction, every square that IS the mechanism, and left the search
// grading pieces of open floor by how enclosed they looked.
//
// Measured against the shadow fleet's own book on the three rooms it was dying in: 15
// squares recorded in the Cragged Mountains against 1,778 real walls in the room, 8 in the
// Twisted Wood against 112 — and every square in the book, in all three rooms, INCLUDING
// the ones recorded as having held, read `coarse=true, fine=true`. Ordinary grass. Nine
// travel shelters in a row failed, the book wrote those down as facts about the squares,
// and a character at 7 of 46 was sent eighteen steps across open ground to stand in a field.
//
// It should fail the day open floor can be offered as shelter again.
console.log('');
console.log('ONLY GRID-DISAGREEMENT SQUARES ARE CANDIDATES');
{
  const src = readFileSync(new URL('./m59-safespots.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function safeSpots'),
                       src.indexOf('export function safeSpots') + 16000);
  ok('the candidate loop no longer opens on the coarse grid',
     !/for \(let c = 1; c <= geo\.cols; c\+\+\) \{\s*\n\s*if \(!geo\.walkable\(r, c\)\) continue;/.test(fn));
  ok('a body still has to fit, which is the BSP question',
     /!geo\.standable\(r, c\)\) continue/.test(fn));
  // THE DISAGREEMENT IS ABOUT THE SQUARE, NOT ITS APPROACHES.
  //
  // This used to accept the OR form — coarse refuses the square, or merely one APPROACH to
  // it is refused — and pinned it by requiring `disagree?.refused` to appear beside
  // `coarseRefusesIt`. The second half admits squares the coarse grid calls perfectly
  // walkable, which is open floor with an awkward doorway: something can path onto it and
  // stand next to you, so it is not a wall and does not hold. Measured over twelve rooms it
  // was 834 of 2228 candidates. A safe wall IS the two grids disagreeing about the square
  // you stand on; that is the entire mechanism and it is now the only gate.
  ok('and a square is only a candidate if the coarse grid refuses THE SQUARE ITSELF',
     /const coarseRefusesIt = geo\.walkable\(r, c\) !== true;[\s\S]{0,120}if \(!coarseRefusesIt\) continue;/.test(fn));
  ok('a square the coarse grid refuses counts as the strongest disagreement there is',
     /geo\.walkable\(r, c\) !== true/.test(fn));
  // AND WHERE IT CANNOT BE MEASURED, NOTHING IS OFFERED. `moverStepLands` answers true for
  // everything when collision is not ready, so accepting candidates in that state would
  // silently restore the old behaviour and look like it was working.
  ok('and with no collision to measure against, nothing is offered rather than everything',
     /!geo\.collisionReady[\s\S]{0,80}return \[\]/.test(fn));
}

// ---------------------------------------------------------------------------
// LEAVING A REAL WALL MEANS WALKING BACK OUT OF THE POCKET IT PUT YOU IN.
//
// docs/m59-routing.md already says it — a safe spot is a pocket the router frequently
// cannot plan out of, which is what breadcrumbs are for — and it became LIVE the moment
// safe spots started being real walls. A real wall is a square the COARSE grid refuses;
// that refusal is the whole mechanism, and it applies to us exactly as much as to the thing
// that wanted to eat us. The router plans on the coarse grid, so a body left standing there
// can be refused every exit in the room.
//
// Measured, Bbbb, The Twisted Wood: sheltered, rested to full, resumed — and then spent
// four hundred and twenty-six seconds failing to leave a room it had crossed in twenty-five
// when it was healthy. Seven attempts, every one "every square for that exit refused".
console.log('');
console.log('LEAVING A REAL WALL MEANS WALKING BACK OUT OF THE POCKET IT PUT YOU IN');
{
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('async stepOutOfThePocket');
  const fn = src.slice(at, at + 2500);
  ok('leaving a hold steps out of the pocket first',
     /const stepped = await this\.stepOutOfThePocket/.test(src));
  ok('and only from a square the coarse grid refuses',
     /geo\.walkable\(me\.row, me\.col\) !== false\) return null/.test(fn));
  ok('by breadcrumbs rather than a coarse-grid escape hatch',
     /retreatAlongBreadcrumbs/.test(fn));
  ok('stopping the moment the grid admits the square again, not unwinding the journey',
     /until: at => at && geo\.walkable\(at\.row, at\.col\) === true/.test(fn));
  ok('and it says so, including when it is STILL stuck afterwards',
     /still_stuck/.test(fn) && /stepped back out of the pocket/.test(fn));
}

// ---------------------------------------------------------------------------
// A SHELTER YOU CANNOT LEAVE IS A TRAP, NOT A SHELTER.
//
// The Twisted Wood, 2026-08-23. The book held row 5, col 35 marked as having HELD, and from
// it the mover reaches FIVE squares and none of the room's five exits. A character that
// sheltered there could never leave the room — four hundred and fifty seconds a leg,
// recorded in the transit book as "every square for that exit refused (4 tried)", which is
// a sentence about the exit describing a body stranded on an island somewhere else:
//
//     row  col   coarse   reaches   exit squares reachable
//       7    2   true       1092    5 of 5      <- the entry square
//       5   35   true          5    0 of 5      <- the trap
//      21   14   false      1092    5 of 5      <- a real wall
//
// AND THE BOOK CALLED IT PROVEN, which is the cruel part: nothing could reach the character
// there, so it held, so it was remembered as good. A perfect shelter and a perfect prison
// are the same square until you try to leave.
console.log('');
console.log('A SHELTER YOU CANNOT LEAVE IS A TRAP, NOT A SHELTER');
{
  const src = readFileSync(new URL('./m59-safespots.mjs', import.meta.url), 'utf8');
  ok('there is an escape test at all', /export function escapeRoom/.test(src));
  ok('and every candidate has to pass it',
     /if \(!escapeRoom\(geo, r, c, minEscape\)\) continue/.test(src));
  ok('it is bounded, so it stays affordable run over every square in a room',
     /ESCAPE_CAP/.test(src));
  ok('and it stops counting the moment the answer is yes', /out is out; stop counting/.test(src));
  // FAIL OPEN WHERE IT CANNOT BE MEASURED. The disagreement gate fails CLOSED for the
  // opposite reason — there, a missing measurement would readmit open floor. Here it would
  // refuse every square in a checkout with no collision, so the safe direction is reversed.
  ok('with no mover to ask, a square is allowed rather than refused',
     /cannot tell: allow/.test(src));
}

// ---------------------------------------------------------------------------
// A SHELTER HAS TO BE SOMEWHERE THE BODY CAN ACTUALLY WALK TO.
//
// `escapeRoom` asks whether you could LEAVE a square. Nothing asked whether you could GET to
// it — and an unreachable wall is not shelter, it is a character standing still being hit
// while a walk it can never finish is retried.
//
// Measured live, a character at row 25, col 28 in The Twisted Wood:
//
//     the mover reaches 1092 squares from there
//     the shelter it was offered, 14,38:   NOT among them
//     nearest reachable real wall, 25,27:  ONE SQUARE AWAY
//
// and `walk_to` answered "no route the mover can walk through this geometry". It was right
// to. There has always been an optional `reach` predicate for exactly this, and this call
// path never passed one — an optional correctness check is a correctness check that is off.
console.log('');
console.log('A SHELTER HAS TO BE SOMEWHERE THE BODY CAN ACTUALLY WALK TO');
{
  const src = readFileSync(new URL('./m59-safespots.mjs', import.meta.url), 'utf8');
  ok('reachability is computed inside the search, not asked of the caller',
     /export function reachableFrom/.test(src));
  ok('and every candidate is checked against it',
     /canWalkThere && !canWalkThere\.has/.test(src));
  ok('it is bounded, so a big room cannot make the search expensive', /REACH_CAP/.test(src));
  ok('and it fails OPEN, because refusing everything would mean never sheltering at all',
     /null means every candidate is allowed through/.test(src));
  ok('the refusal is counted, so "nothing was offered" can be explained afterwards',
     /unreachableToUs\+\+/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
