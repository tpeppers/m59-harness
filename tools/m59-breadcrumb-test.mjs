#!/usr/bin/env node
// THE WAY OUT OF A POCKET IS THE WAY IN, WALKED BACKWARDS — the contract test for the
// breadcrumb escape.
//
//   node tools/m59-breadcrumb-test.mjs
//
// Offline. The fault it exists against: a safe wall IS the coarse grid and the BSP
// disagreeing, the fleet seeks those squares out, and since the router plans on the
// collision view a character standing on one frequently cannot plan a route to its own
// room's exits. Room 587 is 68 regions with both exits in region 0; there are 17,402 such
// pockets world-wide. The character tries, is refused, replans, forever, and the board
// reports `travelling` while it twitches in a corner.
//
// The five properties, each of which is a way the escape could be wrong:
//
//   1. A CRUMB IS A MOVE THE VALIDATOR ACCEPTED, recorded at the one choke point every
//      move passes through, with the position the packet left from.
//   2. IT CANNOT INVENT AN IMPOSSIBLE TRAVERSAL. Every retreat step goes back through the
//      fine validator, so a refused reverse step stops the retreat rather than teleporting.
//      This is the whole safety argument for breadcrumbs over a coarse-grid escape hatch.
//   3. A BROKEN TRAIL IS DROPPED, NOT SKIPPED. A crumb that does not start where we are
//      standing means something else moved us; the ones below it are no better connected.
//   4. IT STOPS THE MOMENT THE ROUTE REAPPEARS. The goal is to leave the pocket, not to
//      undo the journey.
//   5. walkTo USES IT AND THEN RE-PLANS — and a genuine dead end still reports itself,
//      with the retreat named rather than swallowed.
import { readFileSync } from 'node:fs';
import { elideLoops } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}`); } };

// BORROW THE REAL IMPLEMENTATION, NEVER A COPY — `m59-broker.mjs` cannot be imported,
// importing it takes the fleet lock and starts rejoin timers, so the methods are lifted
// out of the source by BRACE MATCHING.
//
// AND IT HAS TO FOLLOW THE CODE. `Session` moved to m59-game.mjs in the keeper split and
// this file went on reading m59-broker.mjs, so every lift missed, `lift` returned
// undefined, and the suite died at the first CALL with "Cannot read properties of
// undefined (reading 'call')" — a hundred lines from the actual cause, with no counts
// printed at all. Read both, newest home first.
const SRC_FILES = process.env.M59_BROKER_SRC
  ? [new URL('file://' + process.env.M59_BROKER_SRC)]
  : [new URL('./m59-game.mjs', import.meta.url), new URL('./m59-broker.mjs', import.meta.url)];
const src = SRC_FILES.map(u => { try { return readFileSync(u, 'utf8'); } catch { return ''; } }).join('\n');
function lift(signature, name, deps = {}) {
  const start = src.indexOf('  ' + signature);
  // A GREP THAT CANNOT FIND ITS SUBJECT MUST STOP, NOT HAND BACK A HOLE. `ok(false)` alone
  // recorded the miss and carried on returning undefined, so the real error arrived later
  // and somewhere else — and a suite that dies mid-run prints no totals, which reads as an
  // infrastructure problem rather than as a broken test.
  if (start < 0)
    throw new Error(`lift: ${name} not found — looked for "${signature}" in ` +
                    SRC_FILES.map(u => u.pathname.split('/').pop()).join(' + ') +
                    '. If it moved, add its new home to SRC_FILES.');
  ok(`the ${name} method was located`, start >= 0);
  const opening = src.indexOf(') {', start);
  let depth = 0, end = -1;
  for (let at = opening + 2; at < src.length; at++) {
    if (src[at] === '{') depth++;
    else if (src[at] === '}') { depth--; if (depth === 0) { end = at + 1; break; } }
  }
  const method = src.slice(start, end);
  ok(`${name} is a whole method`, method.trim().endsWith('}'));
  return new Function(...Object.keys(deps), `return ({${method}}).${name}`)(...Object.values(deps));
}

const KOD_FINENESS = 64;
const queueValidatedMove = lift('async queueValidatedMove(x, y, {', 'queueValidatedMove',
  { MOVE_INTERVAL_MS: 0, CLIENT_FINENESS: 1024, noteGeometryDrift() {} });
// THE REAL `elideLoops`, not a stand-in: the retreat now trims cycles out of the trail
// before replaying it, and a hand-written imitation here would be testing the imitation.
const retreatAlongBreadcrumbs = lift('async retreatAlongBreadcrumbs({', 'retreatAlongBreadcrumbs',
  { KOD_FINENESS, elideLoops });
// Rung 1.5. Lifted, not copied, for the same reason as the rest: the value of this suite is
// that it fails when the SHIPPED method changes.
const retreatToRail = lift('async retreatToRail({', 'retreatToRail', { KOD_FINENESS });
// `provedSquares` turns a plan into the legs the string pull proved, so the coalescer can
// skip along them without tracing. These fixtures have no collision model at all, which is
// exactly the case where it must decline — so null here is the real answer, not a stub of
// one, and it keeps this suite testing the retreat rather than the pull.
// `OFF_PLAN_STEP_BUDGET` is the module constant that decides how many packets a planned
// square may cost — 3 in the broker, and 3 here so the fixtures measure what ships. Passing
// it explicitly is what makes the lift useful: a constant the method reads and this file
// does not name is a ReferenceError HERE, at test time, rather than mid-journey.
const walkTo = lift('async walkTo(col, row, {', 'walkTo',
  { KOD_FINENESS, MOVE_HOP_MAX_SQUARES: 8, PROVED_HOP_MAX_SQUARES: 13, OFF_PLAN_STEP_BUDGET: 3,
    isTerminalMovementReason: () => false, provedSquares: () => null });

// ---------------------------------------------------------------------------
// The smallest thing that can stand in for a Session. Movement is on square centres;
// `legal` decides which fine endpoints the validator will accept, which is how a pocket
// with a one-way way in is expressed.
// ---------------------------------------------------------------------------
const half = KOD_FINENESS >> 1;
const fineOf = (col, row) => ({ x: col * KOD_FINENESS + half, y: row * KOD_FINENESS + half });
const sq = fine => ({ col: Math.floor(fine.x / KOD_FINENESS), row: Math.floor(fine.y / KOD_FINENESS) });

function fakeSession({ at = { col: 5, row: 5 }, roomId = 587, legal = () => true,
                       routable = () => true } = {}) {
  const start = fineOf(at.col, at.row);
  const self = { ...start, ...at };
  const packets = [];
  const client = {
    // `self` is a GETTER here for the same reason it is one on the real client: it is
    // `room.objects.get(selfId)` there, so it goes undefined whenever our own object is
    // not in the room map. `missingSelf` is how a fixture stages that moment.
    missingSelf: false,
    get self() { return this.missingSelf ? undefined : self; },
    room: { id: roomId },
    moveTo(x, y) {
      packets.push({ x, y });
      Object.assign(self, { x, y, ...sq({ x, y }) });
    },
    predictSelf(next) { Object.assign(self, next); },
  };
  const found = (r, c) => routable({ row: r, col: c });
  const session = {
    client, packets,
    movementGeneration: 0,
    breadcrumbs: undefined,
    need() { return client; },
    // WHAT THE WALKER DOES WHEN IT LOSES ITSELF. `client.self` is undefined for a moment
    // after a room is rebuilt, and walkTo now ASKS rather than abandoning the journey.
    // `resyncs` counts the asks and `selfComesBack` decides whether the answer arrives, so
    // a fixture can express both "it was a transient gap" and "the server has gone quiet".
    resyncs: 0,
    selfComesBack: true,
    async selfOrResync() {
      session.resyncs++;
      if (session.selfComesBack && client.missingSelf) client.missingSelf = false;
      return client.self ?? null;
    },
    // A WALK DOES NOT GET TO MARK ITS OWN HOMEWORK. `arrived` is gated on
    // `confirmPosition` — a fresh room read, not the local prediction — because the
    // prediction is exactly what is wrong when a walk lands somewhere it did not plan, and
    // `arrived` is what a journey counts a leg by. A fixture without one made every walk in
    // this suite report `arrived: false` while standing on the requested square, which read
    // as a routing failure and is not one.
    //
    // `positionIsRead` stages the other answer: the real one returns null on a read that
    // times out, and callers must treat "I do not know where I am" as not-arrived.
    positionIsRead: true,
    async confirmPosition() { return session.positionIsRead ? client.self ?? null : null; },
    movementWasCancelled() { return false; },
    cancelledMovement(extra) { return { cancelled: true, ...extra }; },
    threatsHere() { return null; },
    async stepFine() { return { moved: true }; },
    // WHAT THE FINE WALKER CAN AND CANNOT DO IN THIS FIXTURE.
    //
    // `walkTo` delegates to `walkFine` when the coarse plan fails, so a fixture without one
    // throws where the real walker would simply try harder — which is what made this suite
    // error rather than fail after Session moved to m59-game.mjs.
    //
    // It is modelled as failing exactly where the coarse grid fails, and that is deliberate
    // rather than lazy. `routable` is this fixture's whole model of CONNECTEDNESS; the real
    // fine walker reads collision directly and can find lines the coarse grid cannot see,
    // but it cannot invent a connection that does not exist. Letting it succeed from a cut
    // off square would make the two breadcrumb cases below pass without the breadcrumbs
    // ever running, which is the one thing this suite exists to check.
    async walkFine(destX, destY) {
      const here = client.self;
      if (!here || !found(here.row, here.col))
        return { arrived: false, steps: 0, reason: 'fine walk found no route either' };
      const to = sq({ x: destX, y: destY });
      client.moveTo(destX, destY);
      return { arrived: true, steps: 1, position: { ...to, x: destX, y: destY } };
    },
    world: { geometry: {
      walkable: () => true,
      // walkTo asks `standable` now — the BSP question rather than the server grid's.
      // See RoomGeometry.standable. Modelled as true for the same reason `walkable` is:
      // this fixture is about the breadcrumb trail, not about floor.
      standable: () => true,
      nearestWalkable: () => null,
      // The router only ever offers a route out of a square it considers connected.
      path(fr, fc, tr, tc) {
        if (!found(fr, fc)) return { found: false, reason: 'no route', collision_view: true };
        const steps = [];
        let r = fr, c = fc;
        while (r !== tr || c !== tc) {
          r += Math.sign(tr - r); c += Math.sign(tc - c);
          steps.push({ row: r, col: c });
        }
        return { found: true, steps };
      },
    } },
    // Stands in for validateFineTarget: exact endpoints only, no sliding, so a refusal
    // is a refusal. `legal` is asked with both ends, which is how a one-way step is said.
    validateFineTarget(x, y) {
      const from = { x: self.x, y: self.y };
      if (!legal(sq(from), sq({ x, y })))
        return { available: true, moved: false, blocked: true, reason: 'geometry_blocked' };
      return { available: true, moved: true, blocked: false,
               target: { x: Math.round(x), y: Math.round(y) } };
    },
    pacer: { async submit(_kind, invoke) { return invoke(); } },
    async step(col, row) {
      const q = await queueValidatedMove.call(session, ...Object.values(fineOf(col, row)),
        { expectedRoomId: client.room.id });
      if (!q.sent) return { moved: false, reason: q.validation?.reason ?? 'geometry_blocked',
                            position: { ...sq(self) } };
      client.predictSelf({ ...q.target, ...sq(q.target) });
      return { moved: true, position: { ...sq(self) } };
    },
    queueValidatedMove, retreatAlongBreadcrumbs, walkTo,
  };
  return session;
}

const walk = async (s, cols) => { for (const c of cols) await s.step(c.col, c.row); };

// ---------------------------------------------------------------------------
console.log('a crumb is recorded for every accepted move, and names where it left from');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }]);
  ok('two moves, two crumbs', s.breadcrumbs.length === 2);
  ok('the first left the starting square', s.breadcrumbs[0].from.x === fineOf(5, 5).x);
  ok('and arrived at the second', s.breadcrumbs[0].to.x === fineOf(6, 5).x);
  ok('the trail is contiguous', s.breadcrumbs[0].to.x === s.breadcrumbs[1].from.x);
  ok('each crumb names its room', s.breadcrumbs.every(c => c.roomId === 587));
  ok('a refused move leaves no crumb', await (async () => {
    const t = fakeSession({ legal: () => false });
    await t.step(6, 5);
    return (t.breadcrumbs ?? []).length === 0;
  })());
}

// ---------------------------------------------------------------------------
console.log('the retreat undoes the trail in reverse, one accepted step at a time');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }, { col: 8, row: 5 }]);
  const out = await s.retreatAlongBreadcrumbs({});
  ok('it walked all three back', out.steps === 3);
  ok('and is standing where it started', s.client.self.col === 5 && s.client.self.row === 5);
  ok('the trail is spent rather than doubled back on', s.breadcrumbs.length === 0);
  ok('the retreat sent real, validated packets', s.packets.length === 6);
}

// ---------------------------------------------------------------------------
console.log('it cannot invent an impossible traversal — only undo one');
{
  // A one-way ledge: 5,5 -> 6,5 is legal, the reverse is not. This is the shape of the
  // thing the coarse-grid escape hatch was rejected for; the retreat must simply stop.
  const oneWay = (from, to) => !(from.col === 6 && to.col === 5);
  const s = fakeSession({ legal: oneWay });
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }]);
  const out = await s.retreatAlongBreadcrumbs({});
  ok('it undid what it could', out.steps === 1);
  ok('and stopped at the step the validator refuses', s.client.self.col === 6);
  ok('reporting why rather than forcing it', out.reason === 'geometry_blocked');
  ok('every packet sent was one the validator accepted',
    s.packets.every(p => p.x !== fineOf(5, 5).x));
}

// ---------------------------------------------------------------------------
console.log('a broken trail is dropped whole, never skipped');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }]);
  // Something else moved us — a teleport, a knockback, a room change.
  s.client.predictSelf({ ...fineOf(20, 20), col: 20, row: 20 });
  const out = await s.retreatAlongBreadcrumbs({});
  ok('nothing was replayed', out.steps === 0);
  ok('and it says the trail is broken', out.reason === 'breadcrumb_trail_broken');
  ok('the disconnected crumbs are gone rather than left to mislead', s.breadcrumbs.length === 0);
  // The same rule at the recording end: a move that does not start where the last one
  // ended begins a new trail rather than extending a fiction.
  await s.step(21, 20);
  ok('a fresh trail starts after a jump', s.breadcrumbs.length === 1);
}

// ---------------------------------------------------------------------------
console.log('it stops the moment the route reappears — the goal is out, not undone');
{
  const s = fakeSession();
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }, { col: 8, row: 5 }]);
  const out = await s.retreatAlongBreadcrumbs({ until: () => s.client.self.col === 7 });
  ok('one step was enough', out.steps === 1);
  ok('and the rest of the trail is kept', out.crumbs_left === 2);
}

// ---------------------------------------------------------------------------
console.log('walkTo escapes the pocket and then plans from where it lands');
{
  // The pocket: 8,5 has no route anywhere. Everything else does. The character walks in
  // — which is exactly how a safe spot is taken — and then is asked to leave.
  const s = fakeSession({ routable: p => !(p.col === 8 && p.row === 5) });
  await walk(s, [{ col: 6, row: 5 }, { col: 7, row: 5 }, { col: 8, row: 5 }]);
  ok('it really is cut off', s.world.geometry.path(5, 8, 5, 1).found === false);
  const r = await walkTo.call(s, 1, 5, {});
  ok('the walk still arrives', r.arrived === true);
  ok('at the square asked for', s.client.self.col === 1 && s.client.self.row === 5);
}

{
  // AND A GENUINE DEAD END STILL REPORTS ITSELF. Nothing is routable, so the retreat
  // cannot rescue the walk — it must say so rather than spin or claim success.
  const s = fakeSession({ routable: () => false });
  await walk(s, [{ col: 6, row: 5 }]);
  const r = await walkTo.call(s, 1, 5, {});
  ok('it does not claim to have arrived', r.arrived === false);
  ok('the retreat is named rather than swallowed', r.retreated >= 1);
  ok('and the note says the escape was tried', /breadcrumbs/.test(r.note ?? ''));
}

// ---------------------------------------------------------------------------
console.log('losing our own position is a question, not a verdict');
{
  // THE FAILURE THIS REPLACES, measured on a 21-character run to Castle Victoria with the
  // routes and anchors both since proven correct: 47 of 51 hop failures were
  // `own_position_unknown`, 17 of 21 characters ended their journey on one, and NOBODY
  // DIED. The fleet was not killed and was not walled in — it stopped knowing where it was
  // and gave up, one step into a room it had just entered.
  //
  // `client.self` is `room.objects.get(selfId)`, so it is undefined for a moment after a
  // room is rebuilt. `step` deliberately does not await that re-read. So the gap is the
  // ORDINARY state, and the cure is to ask.
  const s = fakeSession();
  s.client.missingSelf = true;                  // as if the room had just been rebuilt
  const r = await walkTo.call(s, 8, 5, {});
  ok('it asked the server where it was', s.resyncs >= 1);
  ok('and the walk went on to arrive', r.arrived === true);
  ok('rather than reporting own_position_unknown', r.reason !== 'own_position_unknown');
}

{
  // AND A SERVER THAT HAS GENUINELY GONE QUIET STILL ENDS THE WALK. The re-read is bounded
  // and answers null rather than throwing, so the old verdict survives — it is just no
  // longer reached prematurely. Without this half the fix would be a hang, which is worse
  // than the abandonment it replaces.
  const s = fakeSession();
  s.client.missingSelf = true;
  s.selfComesBack = false;                      // the read never brings it back
  const r = await walkTo.call(s, 8, 5, {});
  ok('it tried to re-read', s.resyncs >= 1);
  ok('it does not claim to have arrived', r.arrived !== true);
  ok('and it still reports own_position_unknown', r.reason === 'own_position_unknown');
  ok('with a note saying the re-read was tried', /re-read/.test(r.note ?? ''));
}

// ---------------------------------------------------------------------------
console.log('the re-identify itself — lifted whole, because a free variable is invisible');
{
  // WHY THE REAL METHOD AND NOT THE FIXTURE'S STUB. Every assertion above about losing our
  // own position drives `fakeSession.selfOrResync`, which is a hand-written stand-in — so
  // this suite passed perfectly while the REAL `Session.selfOrResync` could not run at all.
  // It sent `c.send(BP_SEND_PLAYER)` against an identifier that is bound NOWHERE in
  // m59-broker.mjs: the packet constants live on `BP` in m59-client.mjs and that module
  // never imports them. A free variable is a ReferenceError at the moment of use and
  // never before — and the moment of use here is a recovery path, so it could only fail
  // once the world had already gone wrong. `refreshRoomIdentity` had the same line, and
  // had had it since the initial commit.
  //
  // Measured live on the arena server, 2026-08-20: the server renumbered Aaaa from 7420
  // to 7400 during a save, `look` answered "not present in room contents yet" for four
  // minutes with the new id plainly in the room list, and the journey ended in
  // `own_position_unknown`.
  //
  // So this lifts the method out of the source and RUNS it against a client that
  // renumbers. A missing binding fails here, at `node tools/m59-breadcrumb-test.mjs`.
  const selfOrResync = lift('async selfOrResync({', 'selfOrResync', {});

  /** A client whose id the server has renumbered, exactly as a garbage collection does. */
  function renumberingClient({ answers = true } = {}) {
    const objects = new Map([[7400, { id: 7400, col: 1, row: 47 }]]);   // the NEW id is present
    const c = {
      selfId: 7420,                                                     // the cached one is not
      requestPlayerCalls: 0,
      get self() { return this.selfId ? objects.get(this.selfId) : undefined; },
      requestPlayer() {
        this.requestPlayerCalls++;
        // BP_PLAYER's handler re-assigns the id and re-requests the contents. Answering on
        // a timer is the real shape: the poll has to wait the reply out.
        if (answers) setTimeout(() => { c.selfId = 7400; }, 120);
      },
    };
    return c;
  }

  const session = (c) => ({
    need: () => c,
    pacer: { submit: (_kind, fn) => Promise.resolve(fn()) },
    confirms: 0,
    async confirmPosition() { this.confirms++; },
  });

  {
    const c = renumberingClient();
    const s = session(c);
    const me = await selfOrResync.call(s);
    ok('it sent the re-identify request', c.requestPlayerCalls >= 1);
    ok('and got our own object back under its new id', me?.id === 7400);
    ok('with the cached id replaced, not the room re-read against a stale key', c.selfId === 7400);
  }

  {
    // A server that never answers still ends bounded, and still answers null rather than
    // throwing — which is what keeps the old `own_position_unknown` verdict reachable
    // instead of turning half the fix into a hang.
    const c = renumberingClient({ answers: false });
    const s = session(c);
    const me = await selfOrResync.call(s, { tries: 1 });
    ok('a silent server gives null rather than throwing', me === null);
    ok('and the room was re-read as the second half of the attempt', s.confirms === 1);
  }

  {
    // THE OTHER CALL SITE, AND IT HAD THE SAME LINE FOR LONGER. `refreshRoomIdentity` is
    // what asks the server which room we are in after an admin teleport or a reconnect,
    // and it has sent the same unbound identifier since the initial commit — so that
    // recovery has never once run. It is covered here for the same reason: no fixture
    // reaches it by accident, and the failure only appears when something else is already
    // wrong.
    const refreshRoomIdentity = lift('async refreshRoomIdentity() {', 'refreshRoomIdentity', {});
    let asked = 0, waited = null;
    const c = { requestPlayer() { asked++; }, evSeq: 7,
                waitFor(opts) { waited = opts; return Promise.resolve({ kind: 'room-entered' }); } };
    await refreshRoomIdentity.call({ need: () => c, pacer: { submit: (_k, fn) => Promise.resolve(fn()) } });
    ok('refreshRoomIdentity sends the request rather than throwing', asked === 1);
    ok('and waits for the room it asked about', waited?.kinds?.includes('room-entered') === true);
    ok('from the event sequence it read before asking', waited?.since === 7);
  }
}

// ---------------------------------------------------------------------------
// RUNG 1.5 — BACK UP UNTIL THE RAIL IS UNDER FOOT AGAIN, THEN STOP.
//
// The rung exists because the trail and the route are different things. Walking the whole
// trail back returns a character to where the leg BEGAN, which on a long crossing throws
// away several minutes of progress and usually re-enters the room that wedged it. What is
// wanted is the nearest point where the baked route and the body agree, which is almost
// always a few squares back — so the stop condition is the rail, not the trail.
//
// NOTHING HERE CONSULTS A MODEL OF THE WORLD. Every square it steps onto is one the
// validator accepted on the way in, replayed backwards through that same validator. That is
// the whole reason this rung may run in a room the router has already given up on: it
// cannot be wrong about the geometry, because it never forms an opinion about the geometry.
console.log('rung 1.5 stops at the rail rather than unwinding the whole trail');
{
  // The rail runs through the square the walk started from; the body then wanders five
  // squares off it. `nearSquares` is 2, so squares 3..7 count as on it and 8..10 do not.
  const railed = (squares, extra = {}) => {
    const s = fakeSession(extra);
    s.retreatToRail = retreatToRail;
    s.railAcross = () => ({ from: { col: 5, row: 5 }, squares });
    return s;
  };
  const away = s => walk(s, [6, 7, 8, 9, 10].map(col => ({ col, row: 5 })));
  {
    const s = railed([{ col: 5, row: 5 }]);
    await away(s);
    const out = await s.retreatToRail({ toSquare: { col: 20, row: 5 } });
    ok('it backed up to the first square the rail reaches', out.steps === 3);
    ok('and stopped there rather than at the start of the leg', s.client.self.col === 7);
    ok('reporting that it rejoined', out.rejoined === true);
    ok('the rest of the trail is kept for the rungs above', out.crumbs_left === 2);
    ok('it names the rail it was aiming at', out.rail_squares === 1);
  }
  {
    // Already there: the rung must cost nothing rather than take a step to prove it.
    const s = railed([{ col: 5, row: 5 }]);
    const out = await s.retreatToRail({ toSquare: { col: 20, row: 5 } });
    ok('a body already on the rail does not move', out.moved === false && s.packets.length === 0);
    ok('and says so', out.reason === 'already on the rail');
  }
  {
    // No rail baked for this crossing — the rung declines and the ladder goes on to rung 2.
    const s = fakeSession();
    s.retreatToRail = retreatToRail;
    s.railAcross = () => null;
    await walk(s, [{ col: 6, row: 5 }]);
    const out = await s.retreatToRail({ toSquare: { col: 20, row: 5 } });
    ok('no rail means no retreat at all', out.moved === false);
    ok('and the trail is left whole for the rungs below', s.breadcrumbs.length === 1);
  }
  {
    // The rail is real but the trail cannot reach it: a one-way step in the way. The rung
    // gives up where the validator says so and reports honestly — it never forces the step.
    const s = railed([{ col: 5, row: 5 }], { legal: (f, t) => !(f.col === 8 && t.col === 7) });
    await away(s);
    const out = await s.retreatToRail({ toSquare: { col: 20, row: 5 } });
    ok('it undid what the validator allowed', out.steps === 2);
    ok('stopped at the refusal', s.client.self.col === 8);
    ok('and did not claim to have rejoined', out.rejoined === false);
    // Square 7 was walked THROUGH on the way out, legally, so its packet count is the
    // check: one on the way out and none on the way back is the refusal being respected
    // rather than a square that was simply never aimed at.
    ok('the refused square was never aimed at a second time',
       s.packets.filter(p => p.x === fineOf(7, 5).x).length === 1);
  }
  {
    // `nearSquares` is a tolerance, not a target: the rail is a lane of square centres and a
    // body walking it is rarely dead on one. Two squares of slack, and it has to actually
    // slacken — a rail well off the trail is not rejoined by standing vaguely near it.
    const s = railed([{ col: 4, row: 5 }]);
    await away(s);
    ok('a rail two squares further out is reached two steps later',
       (await s.retreatToRail({ toSquare: { col: 20, row: 5 } })).steps === 4);
    const t = railed([{ col: 1, row: 5 }]);
    await away(t);
    const far = await t.retreatToRail({ toSquare: { col: 20, row: 5 } });
    ok('a rail the whole trail never reaches is not rejoined', far.rejoined === false);
    ok('and the trail was spent trying', far.steps === 5);
    ok('with nothing left to try below', far.crumbs_left === 0);
  }
}

// ---------------------------------------------------------------------------
// AND THE ARRIVAL ITSELF IS A READ, NOT A BELIEF.
//
// This is pinned because its absence is invisible in the worst way: the walk works, the
// body is on the right square, and every walk in the suite quietly reports failure. In
// production the same gap reads as a journey leg that failed at its own destination —
// which is a retry, a wedge, and eventually a death, all at a square nothing was wrong with.
console.log('arrival is confirmed by a room read, never by the local prediction');
{
  const s = fakeSession();
  ok('a confirmed read on the requested square is an arrival',
     (await walkTo.call(s, 8, 5, {})).arrived === true);
  const t = fakeSession();
  t.positionIsRead = false;                     // the read timed out
  const r = await walkTo.call(t, 8, 5, {});
  ok('an unconfirmed one is not, even standing there', r.arrived === false);
  ok('and it still says where it believes it is', r.position?.col === 8);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
