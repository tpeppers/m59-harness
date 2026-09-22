#!/usr/bin/env node
// A WEAK CREATURE MUST NEVER INDEFINITELY BLOCK A FULLY BUILT CHARACTER.
//
//   node tools/m59-blockedpath-test.mjs
//
// Offline. Real geometry from substrate/m59-map.json, the real spawn table, the real mover
// and the real survival rung. No socket, no broker, no roster.
//
// ======================== THE CLAIM THIS SUITE EXISTS TO PIN ========================
//
// The southeast exit of The Flatlands (584) is a corridor walkable on ROW 35 ALONE for
// columns 27 through 34, pinching to exactly 64 fine units — one square — at columns 29 to
// 32. Everything leaving the room that way goes single file.
//
// `tools/fixtures/flatlands-584-row35.json` is eight seconds of that corridor captured off
// live keepers on 2026-09-02, and it is the whole problem in one file: an ANT at the west
// mouth (r35c27), a SPIDER at r35c32, and TWO OF OUR OWN CHARACTERS pinned between them. A
// level-40 ant and a level-50 spider, holding a corridor against characters built to fight
// far worse.
//
// THERE ARE ONLY TWO ACCEPTABLE ANSWERS and this suite requires one to be available:
//
//   1. THREAD PAST IT. A body is one exclusion zone of MIN_NOMOVEON, not a wall, and
//      m59-needle-test pins that a one-square corridor with bodies in it is usually passable
//      by routing WITHIN the squares. That is the preferred answer and it is checked first.
//   2. CLEAR IT. When the lanes are genuinely full, the survival ladder must be able to swing
//      at what is standing there. `tradeInPlaceIfWedged` is that rung.
//
// WHAT HAPPENS WHEN NEITHER IS AVAILABLE, measured over 3,665 postmortems: 3,057 of them —
// 83.4% of every death this fleet has recorded — died with `swinging: false`. Clifford, lv55,
// died in THIS ROOM on 2026-09-19 with six spiders and an ant inside melee reach, 36 wedges,
// zero gross squares over sixty seconds, at 1 of 55 health, having never swung. The rung that
// could have saved him was refused because `crowded()` sat above the wedge test.
//
// RUN THIS ON EVERY `#movement` COMMIT. It is cheap, it is offline, and the failure it guards
// is silent: nothing errors, the board reads `travelling`, and a character stands in a doorway
// until something kills it.
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry, KOD_FINENESS, CLIENT_FINENESS, MIN_NOMOVEON,
         protocolToClient } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
// THE SHIPPED METHODS, not paraphrases. m59-game.mjs and m59-autopilot.mjs both import without
// taking the fleet lock (unlike m59-broker.mjs), so the real prototypes are reachable.
import { Session, bodyWalkArrives } from './m59-game.mjs';
import { Autopilot, engagementRefusal } from './m59-autopilot.mjs';
import {OF} from './m59-parse.mjs';
import { loadSpawns, attackRating, FORGIVING_RATING } from './m59-spawns.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const ROOM = 584, ROW = 35;
const map = JSON.parse(readFileSync('substrate/m59-map.json', 'utf8'));
attachStepMasks(map);
const geo = sharedRoomGeometry(map.rooms[String(ROOM)]);
const fx = JSON.parse(readFileSync(new URL('./fixtures/flatlands-584-row35.json', import.meta.url), 'utf8'));
const spawns = loadSpawns('substrate/m59-spawns.json');
const CENTRE_Y = ROW * KOD_FINENESS + 32;

console.log('\nTHE CORRIDOR IS REAL, AND THE MAP STILL AGREES WITH THE CAPTURE');
{
  ok('the fixture is this room and this row',
     fx.room.num === ROOM && fx.region.r1 <= ROW && fx.region.r2 >= ROW);
  // Only row 35 is floor for the pinch columns — a fact about the COARSE grid, and the reason
  // everything goes single file.
  const singleFile = [27, 28, 29, 30, 31, 32, 33, 34]
    .every(c => geo.walkable(ROW, c) && !geo.walkable(ROW - 1, c) && !geo.walkable(ROW + 1, c));
  ok('columns 27-34 are walkable on row 35 and on no adjacent row', singleFile);
  // ...and a fact about the FINE grid, which is the one that decides passability.
  const pinch = [29, 30, 31, 32].map(c => fx.geometry.floor_y_by_col[String(c)]);
  ok('columns 29-32 are exactly one square tall in the capture',
     pinch.every(f => f && f.hi - f.lo === KOD_FINENESS), JSON.stringify(pinch[0]));
  // THE CROSS-CHECK THAT MAKES THE REST OF THIS SUITE MEAN ANYTHING. The fixture recorded the
  // floor off the BSP on a live server; substrate/m59-map.json is the bake the mover actually
  // walks. If they have drifted apart, every assertion below is about a room nobody is in.
  let agree = 0, checked = 0;
  for (const colStr of Object.keys(fx.geometry.floor_y_by_col)) {
    const c = Number(colStr);
    checked++;
    let w = false;
    try { w = geo.walkable(ROW, c); } catch { w = false; }
    if (w) agree++;
  }
  ok('every column the capture measured is still floor in the bake',
     checked > 0 && agree === checked, `${agree}/${checked} columns`);
}

// ---------------------------------------------------------------- the mover's half
const wallOk = (ax, ay, bx, by) => {
  try {
    return geo.traceFineMoveClient(protocolToClient(ax), protocolToClient(ay),
                                   protocolToClient(bx), protocolToClient(by),
                                   { slide: false }).arrived === true;
  } catch { return false; }
};
const session = (bodies) => ({
  world: { geometry: geo },
  bodiesInSquare: (row, col, spread = 0) =>
    bodies.filter(b => Math.abs(b.row - row) <= spread && Math.abs(b.col - col) <= spread)
          .map(b => ({ x: b.x, y: b.y, row: b.row, col: b.col })),
  aimInto: Session.prototype.aimInto,
  _wallOk: Session.prototype._wallOk,
  _fineLattice: Session.prototype._fineLattice,
  _legIsLegal: Session.prototype._legIsLegal,
  _canEnter: Session.prototype._canEnter,
});
// Walk the corridor west to east with the SHIPPED solver, checking every leg the way the
// client would send it. Returns the column it died on, or null for a clean crossing.
function crossing(bodies, { from = 26, to = 35 } = {}) {
  const s = session(bodies);
  let at = { x: from * KOD_FINENESS + 32, y: CENTRE_Y, row: ROW, col: from };
  const arrives = (a, b) => bodyWalkArrives(a.x, a.y, b.x, b.y, bodies, { wallOk });
  for (let c = from + 1; c <= to; c++) {
    let r;
    try { r = Session.prototype.threadInto.call(s, at, ROW, c); } catch { return c; }
    for (const via of r?.vias ?? []) {
      if (!arrives(at, via)) return c;
      at = { ...via, row: at.row, col: at.col };
    }
    const aim = r?.aim;
    if (!aim) return c;
    if (!arrives(at, aim)) return c;
    at = { x: aim.x, y: aim.y, row: ROW, col: c };
  }
  return null;
}
const monstersOnly = fx.static.filter(b => b.kind === 'monster')
  .map(b => ({ name: b.name, col: b.col, row: b.row, x: b.x, y: b.y }));

console.log('\nTHREADING IS THE FIRST ANSWER, AND WITH THE CAPTURED MONSTERS IT WORKS');
{
  ok('the capture really did hold an ant and a spider in the corridor',
     monstersOnly.length === 2 && monstersOnly.some(m => m.name === 'ant')
       && monstersOnly.some(m => m.name === 'spider'),
     monstersOnly.map(m => `${m.name}@r${m.row}c${m.col}`).join(' '));
  const died = crossing(monstersOnly);
  ok('a character crosses the corridor past both of them', died === null,
     died === null ? '' : 'blocked entering column ' + died);
}

console.log('\nTHREADING IS STRONGER THAN IT LOOKS, AND IT STILL HAS A LIMIT');
{
  // A BODY AT A SQUARE CENTRE IN EVERY PINCH COLUMN IS NOT ENOUGH TO SHUT IT.
  //
  // This assertion was written the other way round and the suite corrected it on its first
  // run. Four bodies dead centre in columns 29-32 -- the whole pinch, one each -- and the
  // crossing still succeeds, because the server models an obstacle as ONE exclusion zone of
  // MIN_NOMOVEON and `move.c` permits ending inside it while moving away, then SLIDES. That
  // is the needle property, and it is why "a monster is standing in the corridor" is usually
  // not a reason to stop.
  const centres = [29, 30, 31, 32].map(c => ({
    name: 'ant', col: c, row: ROW, x: c * KOD_FINENESS + 32, y: CENTRE_Y,
  }));
  ok('one body per pinch column does NOT shut the corridor', crossing(centres) === null);

  // TWO PER COLUMN DOES, AND THAT IS THE ROOM'S OWN SPAWN CAP.
  //
  // The pinch is four columns and the cap for 584 is 8, so "two in each" is not a
  // pathological arrangement invented to make a point -- it is a fully populated room. Placed
  // at plus and minus 16 fine units from the centre line, the two exclusion zones cover the
  // lane and the crossing fails.
  const twoEach = [29, 30, 31, 32].flatMap(c => [-16, 16].map(dy => ({
    name: 'ant', col: c, row: ROW, x: c * KOD_FINENESS + 32, y: CENTRE_Y + dy,
  })));
  const cap = (spawns.rooms?.[String(ROOM)] ?? []).map(e => e.cap).find(n => n != null) ?? null;
  ok('the room generates enough bodies to do that', cap != null && twoEach.length <= cap,
     twoEach.length + ' bodies against a cap of ' + cap);
  const died = crossing(twoEach);
  ok('two bodies per pinch column DOES shut the corridor', died !== null,
     died === null ? 'threaded anyway' : 'blocked entering column ' + died);
  // WHICH IS THE WHOLE JUSTIFICATION FOR THE RUNG BELOW. A character in that corridor cannot
  // walk out of it, so every movement-shaped rung in the ladder is a non-answer, and the only
  // thing that changes the situation is removing a body from it.
}

// ---------------------------------------------------------------- the ladder's half
const CEILING_FOR = (maxHealth) => Math.round(maxHealth * 1.5);   // threatCeiling's documented default
const infoFor = (name) => Object.values(spawns.creatures ?? {})
  .find(x => String(x.name).toLowerCase() === String(name).toLowerCase());
const refusalFor = (name, ceiling) => engagementRefusal(infoFor(name), { name, ceiling });

console.log('\nA FULLY BUILT CHARACTER MAY CLEAR EVERYTHING THAT SPAWNS HERE');
{
  const here = spawns.rooms?.[String(ROOM)] ?? spawns.rooms?.[ROOM] ?? [];
  ok('the spawn table knows what this room generates', here.length > 0,
     here.map(e => e.creature).join(', '));
  const ceiling = CEILING_FOR(55);   // a built character: 55 max health -> ceiling 82
  for (const e of here) {
    const r = refusalFor(e.creature, ceiling);
    ok(`a built character (ceiling ${ceiling}) may clear a ${e.creature} (level ${e.level})`,
       r === null, r ? r.why : '');
  }
  // The two creatures actually in the capture, by name, in case the room list ever drifts from
  // what is standing in it.
  for (const m of monstersOnly) {
    ok(`...and specifically the ${m.name} that was holding the corridor`,
       refusalFor(m.name, ceiling) === null);
  }
}

console.log('\nAND THE REASON THAT IS NOT AUTOMATIC: THESE ARE NOT "GENTLE" CREATURES');
{
  // `engagementRefusal` lets anything at or below FORGIVING_RATING through regardless of the
  // ceiling. Neither of these qualifies, so they pass ONLY on the level comparison — which is
  // exactly the thing a policy change can move.
  for (const n of ['ant', 'spider']) {
    const rating = attackRating(infoFor(n));
    ok(`${n} is above the forgiving band, so it passes on the CEILING and nothing else`,
       rating > FORGIVING_RATING, `rating ${rating} vs forgiving ${FORGIVING_RATING}`);
  }
  // THE TRAP THIS ROOM DOES NOT HAVE AND UKGOTH DOES. An unrecognised name is REFUSED, not
  // assumed harmless — correct, and it means the spawn table is load-bearing for whether a
  // blocker can ever be cleared at all. `Guardian of Zjiria` killed four characters on
  // 2026-09-19 and has no row in the creature table, so nothing would ever clear one out of a
  // doorway. If that name ever appears in a room list, this assertion is where it surfaces.
  ok('an unrecognised creature is refused rather than assumed harmless',
     engagementRefusal(undefined, { name: 'something nobody wrote down', ceiling: 999 }) !== null);
  const here = spawns.rooms?.[String(ROOM)] ?? [];
  const unknown = here.filter(e => !infoFor(e.creature));
  ok('every creature this room generates resolves in the creature table', unknown.length === 0,
     unknown.map(e => e.creature).join(', '));
}

console.log('\nEND TO END: WEDGED IN THAT CORRIDOR, IN A CROWD, THE RUNG SWINGS');
{
  const rig = (maxHealth, health) => {
    const calls = { fights: [], notes: [] };
    const ant = { id: 1, name: 'ant', col: 27, row: ROW, flags:OF.ATTACKABLE };
    const self = {
      policy: {}, hold: null, tally: {},
      s: { client: { self: { col: 28, row: ROW }, rsc: { get: () => null },
                     vitals: () => ({ health: { value: health, max: maxHealth } }) } },
      safety: () => ({ fleeAt: 0.7 }),
      holdWorks: () => false,
      armedForSure:()=>true,facultyHeld:()=>false,checkFreeze:()=>false,currentRecoveryWall:()=>null,
      weaponPriorityNow:()=>[],bannedWeaponsNow:()=>[],ledgerEvent:()=>{},
      planBlockerLure:()=>null,takeRecoverySpot:async()=>({took:false}),
      // The corridor jam the fixture captured, as the watchdog would report it.
      wedgedInPlace: () => ({ why: 'covered no ground for 25s', for_ms: 25000 }),
      threatCountHere: () => 8,                       // the room's own spawn cap
      travelStopMaxThreats: () => 6,
      crowded() { return this.threatCountHere() >= this.travelStopMaxThreats(); },
      // THE REAL BAND, off the shipped prototypes and the real spawn table.
      threatCeiling: Autopilot.prototype.threatCeiling,
      refuseEngagement: Autopilot.prototype.refuseEngagement,
      noteCrowdRefusal: () => {},
      note: (what, data) => calls.notes.push({ what, ...data }),
      progress: () => {},
      async fightNow(opts) { calls.fights.push(opts.target); return { fought:true,killed: true }; },
    };
    self.s.client.room={objects:new Map([[ant.id,ant]])};
    return { self, ant, calls, v: { health: { value: health, max: maxHealth } } };
  };
  // A BUILT CHARACTER, HEALTHY, WITH AN ANT IN THE WAY AND THE ROOM AT ITS CAP.
  {
    const { self, ant, calls, v } = rig(55, 55);
    const r = await Autopilot.prototype.tradeInPlaceIfWedged.call(self, { near: [ant], v });
    ok('it clears the ant rather than standing there', r === true, 'swung at ' + calls.fights.join(','));
    ok('the crowd did not veto it', calls.notes[0]?.crowd_overridden === true);
    ok('and it used the in-band rule, not desperation',
       calls.notes[0]?.mode === 'fight until clear', String(calls.notes[0]?.mode));
  }
  // THE SAME CHARACTER AT ONE HEALTH — the Clifford case, which must also swing.
  {
    const { self, ant, v } = rig(55, 1);
    const r = await Autopilot.prototype.tradeInPlaceIfWedged.call(self, { near: [ant], v });
    ok('and at 1 of 55, in a full room, it still swings instead of dying still', r === true);
  }
  // A 20-HEALTH SERVICE CHARACTER MUST NOT BE DRAGGED INTO THE FIGHT. Its ceiling is 30 and an
  // ant is level 40, so the band refuses — correct, and it is why the answer for those
  // characters is to keep them out of the corridor rather than to widen the band.
  {
    const { self, ant, calls, v } = rig(20, 20);
    const r = await Autopilot.prototype.tradeInPlaceIfWedged.call(self, { near: [ant], v });
    ok('a 20-health character is NOT sent to fight a level-40 ant', r === false);
    ok('and it says the band refused, rather than failing silently',
       /without a reachable refuge/.test(String(calls.notes[0]?.what)),
       String(calls.notes[0]?.what));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
