#!/usr/bin/env node
// ONE TRAVEL CALL IS THE WHOLE JOURNEY — the contract test for the resume loop.
//
//   node tools/m59-travel-test.mjs
//
// Offline. It drives the real `Session.travel` loop against a fake world and a fake
// walker, because the thing under test is the CONTROL FLOW — when a failed hop is retried,
// when it is given up on, and what the budgets mean — and that needs a room graph that can
// be told to fail on demand, not a live server two towns away.
//
// The four properties, each of which is a real failure this replaces:
//
//   1. A TRANSIENT HOP FAILURE IS RETRIED, not returned. Every caller used to need its own
//      retry loop; one that forgot got a character stranded halfway across the world with
//      the trip reported as finished.
//   2. A STUMBLE IS NOT A HOP. Re-settling in one sticky doorway must not consume the
//      budget for crossing rooms.
//   3. PATIENCE IS BOUNDED. A room that will never let us out has to end the journey
//      rather than spin.
//   4. A REAL DEAD END STILL REPORTS ITSELF. Retrying must not turn "no route" into
//      silence — the reason survives to the caller.
import { strict as assert } from 'node:assert';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a Session: a chain of rooms 1..N, a
// scripted list of hop outcomes, and the two helpers travel() reaches for.
// ---------------------------------------------------------------------------
function fakeSession({ rooms = [1, 2, 3, 4], script = [], startAt = 0,
                      detour = null, barred = null } = {}) {
  const s = {
    name: 'test',
    at: startAt,
    routeAvoids: [],
    movementGeneration: 0,
    reads: 0,
    noteTransit: () => {},
    pacer: { submit: async (_k, fn) => fn() },
    client: {
      roomContents: async () => { s.reads++; },
      waitFor: async () => {},
    },
    movementWasCancelled: () => false,
    cancelledMovement: ({ log }) => ({ arrived: false, cancelled: true, log }),
    world: {
      get room() {
        const n = rooms[s.at];
        return n == null ? null : { num: n, name: `room ${n}` };
      },
      route(to, { avoid } = {}) {
        s.routeAvoids.push(avoid ? [...avoid] : null);
        const here = rooms[s.at];
        if (here == null) return { found: false, reason: 'start is outside the room grid' };
        const idx = rooms.indexOf(to);
        if (idx < 0) return { found: false, reason: 'no route' };
        if (idx === s.at) return { found: true, hops: [] };
        let next = rooms[s.at + (idx > s.at ? 1 : -1)];
        // A detour that exists only when the direct neighbour is barred, so the test can
        // tell "routed around it" from "gave up on it".
        if (avoid?.has(Number(next)) && detour != null) next = detour;
        return { found: true, hops: [{ to: next, to_name: `room ${next}` }] };
      },
      exits: () => {
        const next = rooms[s.at + 1];
        return next == null ? [] : [{ to: next, kind: 'edge', stand_on: { col: 1, row: 1 } }];
      },
    },
    // NO TRACK MEANS PLAN IT THE WAY YOU ALWAYS DID, AND THAT IS THE SAFETY PROPERTY.
    //
    // `travel` consults the learned track book before walking a hop. The book is mostly one
    // observation per crossing, so it must never be able to make travel worse than not
    // having it — every refusal falls straight through to the ordinary exit walk. This fake
    // rides nothing, which means every assertion in this file is about the planner path and
    // stays exactly as true as it was before the monorail existed.
    async rideTrack() { return { rode: false, why: 'no track in this fixture' }; },
    // Each call consumes one scripted outcome; `true` moves us on, `false` refuses.
    async leaveViaAny(candidates) {
      // A room the server will not let this character into answers the same way every
      // time, whatever we do first — which is the point of the barring.
      const to = candidates?.[0]?.to;
      if (barred && barred.has(Number(to)))
        return { left: false,
                 reason: 'Your guardian angel holds you back and prevents you from entering here.' };
      const outcome = script.length ? script.shift() : true;
      if (outcome === 'vanish') { s.at = null; return { left: false, reason: 'coordinates went off grid' }; }
      // A CROSSING THAT LANDS SOMEWHERE ELSE, which is an ordinary outcome rather than an
      // exotic one: a boundary carrying two exits puts a character in a neighbouring room
      // without asking. `overshoot` lands on the LAST room in the fixture — so the hop did
      // not go where it aimed, and where it went happens to be the destination.
      if (outcome === 'overshoot') { s.at = rooms.length - 1; return { left: true, used_exit: { stand_on: { col: 1, row: 1 } } }; }
      // DIED ON THE WAY. The server puts the dead in room 1, and from the journey's point of
      // view that is a room change to somewhere it did not ask for — indistinguishable, on
      // the wire, from a boundary that carries two exits.
      if (outcome === 'died') { s.at = rooms.indexOf(1); return { left: true, used_exit: { stand_on: { col: 1, row: 1 } } }; }
      if (outcome) { s.at += 1; return { left: true, used_exit: { stand_on: { col: 1, row: 1 } } }; }
      return { left: false, reason: 'no floor anywhere on the north boundary' };
    },
  };
  return s;
}

// BORROW THE REAL IMPLEMENTATION, NEVER A COPY. A test against a reimplementation of this
// loop tests the reimplementation. `m59-broker.mjs` cannot be imported — importing it takes
// the fleet lock and starts rejoin timers — so the method is lifted out of the source by
// BRACE MATCHING, which is exact, rather than by hunting for a closing line that also
// appears inside the body.
const src = await import('node:fs').then(m =>
  m.readFileSync('tools/m59-broker.mjs', 'utf8') + '\n' +
  m.readFileSync('tools/m59-game.mjs', 'utf8'));
const start = src.indexOf('  async travel(toRoomNum, {');
ok('the travel method was located', start > 0);
// Start matching at the BODY brace, not at the destructured options object in the
// signature — that one balances on its own and closes the match before the loop begins.
const SIG_END = '} = {}) {';
const sigAt = src.indexOf(SIG_END, start);
ok('the signature end was located', sigAt > start);
let depth = 0, i = sigAt + SIG_END.length - 1, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const travelSrc = src.slice(start, end);
ok('it is the version with the resume loop', travelSrc.includes('maxStumbles'));
ok('and it is a whole method', travelSrc.trim().endsWith('}'));
// THE LIFTED METHOD'S FREE IDENTIFIERS HAVE TO BE HANDED IN, exactly as
// m59-collision-test does for validateFineTarget: a module-scope symbol that is fine in
// the broker is a ReferenceError here, which is the good direction — it says the harness
// has fallen behind rather than quietly testing something else. `BARRED_ON_ENTRY` is the
// real regex, not a stub, because what it matches IS the behaviour under test.
const BARRED_ON_ENTRY = /guardian angel holds you back/i;
const UNREACHABLE_EXIT =
  /every square for that exit refused|no floor anywhere on the \w+ boundary|no BSP-valid crossing/i;
const travel = new Function('orderExits', 'BARRED_ON_ENTRY', 'UNREACHABLE_EXIT',
  `return ({ ${travelSrc} }).travel`)((c) => c, BARRED_ON_ENTRY, UNREACHABLE_EXIT);


// ---------------------------------------------------------------------------
console.log('a clean journey arrives, and counts its hops');
{
  const s = fakeSession({ rooms: [1, 2, 3, 4] });
  const r = await travel.call(s, 4, {});
  ok('arrived', r.arrived === true);
  ok('three hops', r.hops === 3);
  ok('no stumbles', r.stumbles === 0);
  ok('already there is instant', (await travel.call(fakeSession({ startAt: 3 }), 4, {})).hops === 0);
}

// ---------------------------------------------------------------------------
console.log('a transient hop failure is retried rather than returned');
{
  // Refuse the first doorway twice, then let it through. This is the case that used to
  // return arrived:false and strand the character in room 1.
  const s = fakeSession({ rooms: [1, 2, 3], script: [false, false, true, true] });
  const r = await travel.call(s, 3, {});
  ok('the journey still completes', r.arrived === true);
  ok('and says how much it stumbled', r.stumbles >= 1);
  ok('the room was re-read before retrying', s.reads > 0);
  ok('the stumbles are in the log', r.log.some(l => l.stumble));
}

{
  // The classic: coordinates read as off-grid for an instant. `world.room` is null and
  // `route` reports "start is outside the room grid" — both must be survivable.
  const s = fakeSession({ rooms: [1, 2], script: ['vanish'] });
  s.at = 0;
  const r = await travel.call(s, 2, { maxStumbles: 3 });
  ok('an off-grid instant does not end the journey by itself', r.log.some(l => l.stumble));
}

// ---------------------------------------------------------------------------
console.log('a stumble is not a hop');
{
  // One sticky doorway, then a clean run. With stumbles counted as hops, a maxHops of 3
  // would run out before crossing three rooms.
  const s = fakeSession({ rooms: [1, 2, 3, 4], script: [false, false, true, true, true] });
  const r = await travel.call(s, 4, { maxHops: 3 });
  ok('the hop budget still buys three rooms', r.arrived === true);
  ok('and the hops counted are rooms crossed, not attempts', r.hops === 3);
}

// ---------------------------------------------------------------------------
console.log('patience is bounded, and the reason survives');
{
  const s = fakeSession({ rooms: [1, 2], script: [false, false, false, false, false, false, false, false, false] });
  const r = await travel.call(s, 2, { maxStumbles: 3 });
  ok('a doorway that never opens ends the journey', r.arrived === false);
  ok('it does not spin past its patience', r.stumbles === 4);
  ok('and it still says WHY, not just that it failed',
     /no floor anywhere on the north boundary/.test(r.reason));
}

{
  const s = fakeSession({ rooms: [1, 2, 3] });
  const r = await travel.call(s, 99, { maxStumbles: 2 });
  ok('a destination not in the graph is refused', r.arrived === false);
  ok('and reports no route rather than a doorway problem', /no route/.test(r.reason));
}

{
  const s = fakeSession({ rooms: [1, 2, 3, 4, 5, 6] });
  const r = await travel.call(s, 6, { maxHops: 2 });
  ok('the hop budget is still honoured', r.arrived === false);
  ok('and says so plainly', /gave up after 2 hops/.test(r.reason));
}

// ---------------------------------------------------------------------------
console.log('cancellation still wins, because it is the survival path');
{
  const s = fakeSession({ rooms: [1, 2, 3] });
  s.movementWasCancelled = () => true;
  const r = await travel.call(s, 3, {});
  ok('a cancelled movement stops the journey', r.cancelled === true);
  ok('and it does not report arrival', r.arrived !== true);
}

// ---------------------------------------------------------------------------
// A DOOR THAT WILL NEVER OPEN IS NOT A STICKY DOORWAY.
//
// `Player.CanEnterRoom` refuses a GuildHall outright to anyone without
// PFLAG_PKILL_ENABLE (player.kod, resource `player_no_enter`). That is a fact about the
// CHARACTER, not about the moment, so the ordinary re-settle-and-retry reproduces it
// exactly and spends the whole patience budget doing so. Measured on the arena fleet:
// Delta spent two attempts and 43 seconds being refused by The Old Dwarven Hall with a
// baby spider chewing on it, and the journey then failed with the hall still the only
// route it would consider.
console.log('a room the server bars is routed around, not retried');
{
  // room 3 is a guild hall this character may not enter; 9 is the way round.
  const s = fakeSession({ rooms: [1, 2, 3, 4], detour: 9, barred: new Set([3]) });
  // Once barred, the fake offers 9 instead of 3 and the journey completes through it.
  const rooms9 = [1, 2, 9, 4];
  const s2 = fakeSession({ rooms: rooms9, detour: null });
  const r = await travel.call(s, 4, {});
  ok('the barred room is recorded on the journey log',
     (r.log || []).some(e => e.barred === 3), JSON.stringify(r.log));
  ok('and the very next plan is asked to avoid it',
     s.routeAvoids.some(a => a && a.includes(3)), JSON.stringify(s.routeAvoids));
  // The barring itself must not be charged to patience — asserted against the LOG rather
  // than the final count, because anything the journey does afterwards has its own budget
  // and would make this assertion about the fixture instead of about the refusal.
  ok('the refusal is never recorded as a stumble',
     !(r.log || []).some(e => e.stumble && BARRED_ON_ENTRY.test(e.reason ?? '')),
     JSON.stringify((r.log || []).filter(e => e.stumble)));
  ok('and it is barred BEFORE any patience is spent',
     (() => { const b = (r.log || []).findIndex(e => e.barred === 3);
              const f = (r.log || []).findIndex(e => e.stumble);
              return b >= 0 && (f < 0 || b < f); })(),
     JSON.stringify(r.log));
  ok('a journey that still cannot get there says which rooms were barred',
     r.arrived === true || (Array.isArray(r.barred_rooms) && r.barred_rooms.includes(3)),
     JSON.stringify({ arrived: r.arrived, barred_rooms: r.barred_rooms }));

  // AND IT MUST NOT BAR THE DESTINATION ITSELF: asked to walk INTO a hall it cannot
  // enter, the honest answer is to fail, not to route around the place it was sent to.
  const dest = fakeSession({ rooms: [1, 2, 3], barred: new Set([3]) });
  const rd = await travel.call(dest, 3, {});
  ok('being sent INTO a barred room fails rather than barring the destination',
     rd.arrived !== true && !(dest.barredRooms?.has?.(3)),
     JSON.stringify({ arrived: rd.arrived, barred: [...(dest.barredRooms ?? [])] }));
}

// ---------------------------------------------------------------------------
// A DOOR YOU CANNOT REACH FROM THIS SIDE OF THE ROOM IS NOT A DOOR YOU RETRY.
//
// `findPath` plans over ROOMS, so a hop A -> B -> C assumes B can be crossed from the door
// A left you at to the door C wants. Measured in West Merchant Way: entering from Marion
// at 20,1 or 24,1, the exit to Deep Forest of Farol at 49,70 is unreachable — the only
// route between them needs a 1280-unit climb in one step against a limit of 384. The room
// graph is right that 545 connects to 556; it just does not connect FROM THERE.
console.log('a doorway this side of the room cannot reach is replanned around');
{
  // Every attempt on the 2 -> 3 doorway reports the walk never got there.
  const s = fakeSession({ rooms: [1, 2, 3, 4] });
  s.leaveViaAny = async (candidates) => {
    if (Number(candidates?.[0]?.to) === 3)
      return { left: false, reason: 'every square for that exit refused (4 tried)' };
    s.at += 1; return { left: true, used_exit: { stand_on: { col: 1, row: 1 } } };
  };
  const r = await travel.call(s, 4, {});
  ok('the unreachable doorway is named on the log',
     (r.log || []).some(e => e.unreachable_exit === 3), JSON.stringify(r.log).slice(0, 300));
  ok('and the next plan is asked to avoid it',
     s.routeAvoids.some(a => a && a.includes(3)), JSON.stringify(s.routeAvoids));
  ok('it is recorded once, not once per attempt',
     (r.log || []).filter(e => e.unreachable_exit === 3).length === 1,
     JSON.stringify((r.log || []).filter(e => e.unreachable_exit)));

  // AND IT IS PER JOURNEY, NEVER PER SESSION. "I cannot reach that door from where I am
  // standing" stops being true the moment the character stands somewhere else; remembering
  // it for the session would delete a good door from the map for ever.
  ok('the session keeps no memory of it',
     !s.barredRooms || !s.barredRooms.has(3),
     JSON.stringify([...(s.barredRooms ?? [])]));

  // The destination itself is never avoided — asked to walk INTO a room whose doorway we
  // cannot reach, the honest answer is to fail rather than to route around the target.
  const dest = fakeSession({ rooms: [1, 2, 3] });
  dest.leaveViaAny = async () => ({ left: false, reason: 'every square for that exit refused (4 tried)' });
  const rd = await travel.call(dest, 3, {});
  ok('being sent to a room whose doorway is unreachable fails honestly',
     rd.arrived !== true && !dest.routeAvoids.some(a => a && a.includes(3)),
     JSON.stringify({ arrived: rd.arrived, avoids: dest.routeAvoids }));
}


// ---------------------------------------------------------------------------
console.log('THE ARRIVAL GUARD: ask whether we are there before reporting that we are not');
{
  // The destination test lives at the TOP of the loop, so every early return between one
  // top and the next reports failure without asking where the body is standing. A check
  // after the loop was added for the max-hops case — "a journey whose final hop is also its
  // last permitted hop leaves the loop standing in the right room and reported gave up" —
  // and the same hole was open on all six of the others.
  //
  // It is not hypothetical any more. Where a hop LANDS is not always where it aimed: a
  // boundary carrying two exits puts a character in a neighbouring room without asking, and
  // sometimes the neighbour is the destination. A journey that has arrived is finished,
  // whatever reason it was about to give for stopping.

  // THE REAL SHAPE. The first hop aims at room 2 and lands in room 4, which is where the
  // journey was going. Without the guard this returns the wrong-room failure — "crossed into
  // 4 instead of 2" — about a character standing in its own destination.
  const s = fakeSession({ rooms: [1, 2, 3, 4], script: ['overshoot'] });
  const r = await travel.call(s, 4, {});
  ok('a hop that lands somewhere else, which IS the destination, arrives',
     r.arrived === true, JSON.stringify(r));

  // ...AND WITH NO PATIENCE LEFT TO SPEND. With stumbles available the loop simply comes
  // round and the check at its top notices; the guard is what covers the case where the
  // budget is gone and the function is on its way out the door. That is the case this
  // whole thing exists for, and it is the one that used to report a failure about a
  // character standing in its own destination.
  const spent = fakeSession({ rooms: [1, 2, 3, 4], script: ['overshoot'] });
  const g = await travel.call(spent, 4, { maxStumbles: 0 });
  ok('and with the stumble budget already spent, the guard is what notices',
     g.arrived === true, JSON.stringify(g));
  ok('and it says so, rather than silently rewriting a failure',
     /noticed while giving up/.test(g.note ?? ''), JSON.stringify(g.note));

  // AND THE UNDERWORLD IS A DEATH, NOT A DOORWAY. Every other unplanned landing is a
  // boundary carrying more than one exit; this one is the character having died on the way,
  // and it read "crossed into 1 instead of 599 — that boundary carries more than one exit",
  // which would send the next person hunting a shared edge in Ukgoth that does not exist.
  const dead = fakeSession({ rooms: [1, 2, 3, 4], startAt: 1, script: ['died'] });
  const d = await travel.call(dead, 4, { maxStumbles: 0 });
  ok('dying in transit is reported as a death rather than a wrong doorway',
     /Underworld/.test(d.reason ?? ''), JSON.stringify(d.reason));
  ok('and the hop it died on is NOT learned as a bad crossing',
     !(d.log ?? []).some(e => e.blocked_hop), JSON.stringify(d.log?.slice(-2)));

  // The cheap case too: already standing there when asked.
  const already = fakeSession({ rooms: [7] });
  ok('already standing in the destination arrives rather than failing',
     (await travel.call(already, 7, {})).arrived === true);

  // AND THE GUARD MUST NOT INVENT AN ARRIVAL. Standing somewhere else, the same failure is
  // still a failure — otherwise it would turn every give-up into a false success, which is
  // the exact bug the wrong-room check was added to stop.
  const elsewhere = fakeSession({ rooms: [1, 2] });
  const no = await travel.call(elsewhere, 99, {});
  ok('but a journey that has NOT arrived still reports the failure',
     no.arrived !== true && !!no.reason, JSON.stringify(no));
}

// ---------------------------------------------------------------------------
// THE SAFE-WALL POCKET, FOR THE FIRST HOP. A character parked on a safe wall is standing in
// a collision pocket the router cannot plan out of to its own room's exits — the first hop
// fails "no route" though the room graph is fine and the character walked in. walkTo already
// retreats along the breadcrumbs when a FINE target is cut off; travel's ROOM-level route
// fails before any walkTo runs, so it must run the same escape here or a safe-wall hunter can
// never set off for town: travel acks started, stumbles six times, and hands the body back.
console.log('a first-hop route failure retreats off the safe wall instead of giving up');
{
  const s = fakeSession({ rooms: [1, 2, 3] });
  s.pocketed = true;
  let retreats = 0, sawUntil = false;
  const realRoute = s.world.route.bind(s.world);
  s.world.route = (to, opts) => s.pocketed
    ? { found: false, reason: 'no route the mover can walk through this geometry' }
    : realRoute(to, opts);
  s.retreatAlongBreadcrumbs = async ({ until } = {}) => {
    retreats++;
    if (typeof until === 'function') sawUntil = true;
    s.pocketed = false;                 // stepped back into the main region; the route reappears
    return { moved: true, steps: 3 };
  };
  const r = await travel.call(s, 3, {});
  ok('the pocketed journey still arrives', r.arrived === true);
  ok('by retreating along the breadcrumbs exactly once', retreats === 1);
  ok('and the retreat was asked to stop when the route reappeared', sawUntil);
  ok('and the escape is on the log', (r.log || []).some(e => e.pocket_escape));
}

{
  // A pocket with no breadcrumb trail out (a character teleported in, or the trail is stale)
  // must still end honestly rather than spin: the escape is tried once, comes back empty, and
  // the ordinary stumble takes over and gives up with the real reason.
  const s = fakeSession({ rooms: [1, 2] });
  s.world.route = () => ({ found: false, reason: 'no route the mover can walk through this geometry' });
  let tries = 0;
  s.retreatAlongBreadcrumbs = async () => { tries++; return { moved: false, steps: 0 }; };
  const r = await travel.call(s, 2, { maxStumbles: 2 });
  ok('a pocket it cannot retreat out of does not spin forever', r.arrived === false);
  ok('the escape is attempted once, then not again', tries === 1);
  ok('and the real reason survives', /no route/.test(r.reason));
}

console.log(`\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
