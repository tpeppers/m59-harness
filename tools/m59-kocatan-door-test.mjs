#!/usr/bin/env node
// THE KO'CATAN EAST TOWER DOOR (2013 -> 2115), WITH ITS GUARD, AND WHAT A SECOND WALKER DOES TO IT.
//
//   node tools/m59-kocatan-door-test.mjs
//
// Offline and socketless. The walk, the collision, the router, `leaveVia` and the doorway
// confirmation are the real Session code on the committed 2013 geometry; only the server is a
// model -- of exactly the kod that decides this door:
//
//   * koctower.kod CreateStandardExits: the way out to RID_KA5 (2115) is a GO exit on r2c40,
//     r2c41 and r3c41, landing at r44c24.
//   * koctower.kod SomethingTryGo: on those three squares the guard captain is asked `CanPass`
//     (kocatwn.kod); a pack that passes hears the captain SAY "You may pass." -- a room
//     broadcast, so every body in the tower hears it -- and the go propagates to the standard
//     exit handling.
//   * user.kod UserGo: anywhere else the room answers nothing and the user is told "You are
//     unable to go anywhere." -- the server judges the square it holds (piRow/piCol), never the
//     one the client believes.
//
// PROD 2026-10-27. Islanders' journeys 2013 -> 2115 ended `route_progressing_exits_exhausted`
// for minutes at a time with refusals `doorway_position_not_confirmed` at r2c40/r2c41/r3c41,
// `geometry_blocked`, and "You are unable to go anywhere.; Cital ko'Manca says, "You may pass."".
// The walker was NOT sending go blind: it confirms the server square before every go (case 1
// pins that: every go the server judged was on a doorway square). 69 of the 74 failures toward
// 2115/2125 that day (to 15:30Z) overlapped a second keeper journey on the same body -- a town
// trip leaving by the SW door to 2000 -- and the movement-incident rows show its fine walker
// pulling the body off the doorway between the walker's correction, its confirm and its go.
// Case 2 replays that interference and gets the same refusals, square for square; the fix is
// that the keeper no longer runs two journeys on one body (m59-in-flight-hold-test.mjs pins the
// ladder). The "You may pass." in the live refusal was the captain waving a FLEET-MATE through:
// a broadcast heard by everyone in the tower.
import assert from 'node:assert/strict';
import { bastionHarness } from './fixtures/bastion-fallback-client.mjs';

const h = await bastionHarness();
const { Session, map } = h;
const { World } = await h.imp('m59-world.mjs');
const { bodyAuthority } = await h.imp('m59-body-command.mjs');
const { releaseConfirmedPassage } = await h.imp('m59-passage-admission.mjs');
const { geometryFor } = await h.imp('m59-safespots.mjs');

const TOWER = 2013, JUNGLE = 2115;
const DOORWAY = [{ row: 2, col: 40 }, { row: 2, col: 41 }, { row: 3, col: 41 }];
const onDoorway = (row, col) => DOORWAY.some(d => d.row === row && d.col === col);
const MAY_PASS = 'Cital ko\'Manca says, "You may pass."';
const CANT_GO = 'You are unable to go anywhere.';

let n = 0;
const ok = (cond, why) => { n++; assert.ok(cond, why); };

// The East Tower, served by a model of its kod. `intruder` is a second walker sharing the body:
// called with the server's square, it may move the body there and then, exactly as another
// journey's packet would -- after each of this walker's packets (`when: 'packet'`), or only in
// the window between the walker's last confirm and its go (`when: 'go'`). `mate` puts a
// fleet-mate at the door who is waved through as this walker's go is judged.
function tower({ from, intruder = null, when = 'packet', mate = false, maxPackets = 400 } = {}) {
  let room = TOWER, pending = null;
  const events = [], packets = [], gos = [], crossings = [];
  const server = { x: from.x, y: from.y };            // where the server holds the body
  const c = {
    selfId: 77, evSeq: 0, rsc: new Map(), roomContentsRequested: 0, roomContentsReceived: 0, state: 'game',
    room: { id: 10000 + room, flags: 0, objects: new Map() },
    get self() { return this.room.objects.get(this.selfId); },
    vitals: () => ({ health: { value: 90, max: 90 }, vigor: { value: 190, max: 200 } }),
    face() {}, stand() { return true; }, rest() { return true; },
    predictSelf(p) { this.room.objects.set(this.selfId, { ...this.self, ...p, predicted: true }); },
    moveTo(x, y) {
      if (packets.length >= maxPackets) throw Error('offline tower packet budget exhausted');
      packets.push({ room, x, y });
      if (room === TOWER) { server.x = x; server.y = y; }
      this.predictSelf({ x, y, row: Math.floor(y / 64), col: Math.floor(x / 64) });
      if (when === 'packet') interfere(this);
    },
    go() {
      if (room !== TOWER) return;
      if (when === 'go') interfere(this);
      const row = Math.floor(server.y / 64), col = Math.floor(server.x / 64);
      gos.push({ row, col });
      // koctower.kod SomethingTryGo -> kocatwn.kod CanPass: this body carries a legal pack.
      if (onDoorway(row, col)) {
        say(MAY_PASS);
        const exit = map.rooms[TOWER].goExits.find(e => e.row === row && e.col === col);
        pending = { from: TOWER, exit };
        return;
      }
      // Room.SomethingTryGo found no exit at the SERVER's square: user.kod UserGo.
      say(CANT_GO);
      // The captain's `say` is a room broadcast: a fleet-mate passing is heard by this body too.
      if (mate) say(MAY_PASS);
    },
    roomContents() {
      apply();
      this.roomContentsRequested++; this.roomContentsReceived++;
      // The reply carries the server's position, which supersedes any prediction.
      if (room === TOWER && this.self)
        this.room.objects.set(this.selfId, { ...this.self, x: server.x, y: server.y,
          row: Math.floor(server.y / 64), col: Math.floor(server.x / 64), predicted: false });
      if (when === 'packet') interfere(this);
      return this.roomContentsRequested;
    },
    async waitFor({ since = 0, kinds = [] } = {}) {
      apply();
      return { events: events.filter(e => e.seq > since && (!kinds.length || kinds.includes(e.kind))) };
    },
    eventsSince(since = 0) { return events.filter(e => e.seq > since); },
  };
  function say(text) { events.push({ seq: ++c.evSeq, kind: 'message', text }); }
  function interfere(client) {
    if (!intruder || room !== TOWER) return;
    const moved = intruder({ x: server.x, y: server.y, row: Math.floor(server.y / 64), col: Math.floor(server.x / 64) });
    if (!moved) return;
    server.x = moved.x; server.y = moved.y;
    // The other walker predicts on the same client object, so the body's own view moves too.
    client.predictSelf({ x: moved.x, y: moved.y, row: Math.floor(moved.y / 64), col: Math.floor(moved.x / 64) });
  }
  function enter(num, p) {
    const r = map.rooms[num], geo = geometryFor(r);
    room = num; c.roomNameRsc = r.nameRsc; c.roomRsc = r.roomRsc;
    c.room = { id: 10000 + num, security: geo.security, flags: 0, objects: new Map() };
    c.room.objects.set(c.selfId, { id: c.selfId, flags: 4, ...p, row: Math.floor(p.y / 64), col: Math.floor(p.x / 64), predicted: false });
  }
  function apply() {
    if (!pending) return;
    const { from: was, exit } = pending; pending = null;
    enter(Number(exit.to), { x: exit.arriveCol * 64 + 32, y: exit.arriveRow * 64 + 32 });
    crossings.push({ from: was, to: room });
    events.push({ seq: ++c.evSeq, kind: 'room-entered', room: c.room.id });
    events.push({ seq: ++c.evSeq, kind: 'room-contents', room: c.room.id });
  }
  enter(TOWER, from);
  const s = Object.assign(Object.create(Session.prototype), { client: c, movementGeneration: 0, name: 'offline-tower',
    cancelledMovementTokens: new Set(), movementCancellationChecks: new Map(),
    need: () => c, moveSpeed: () => 18,
    movementWasCancelled: (g, t) => Session.prototype.movementWasCancelled.call(s, g, t) || packets.length >= maxPackets,
    pacer: { async submit(_kind, run) { apply(); bodyAuthority(s).guard(); return run(); }, wake() {} },
    async confirmPosition() { c.roomContents(); releaseConfirmedPassage(s); return c.self ? { col: c.self.col, row: c.self.row } : null; },
    async refreshRoomIdentity() { c.roomContents(); return { confirmed: true, room: s.world.room }; },
    async _askStrategies() { return null; }, _blinkPointHere: () => null,
    noteTransit() {}, planSameRoomDoors: () => null,
  });
  Object.defineProperty(s, 'live', { value: true });
  s.world = new World(c, map); s.threatsHere = () => [];
  return { s, c, server, packets, gos, crossings, said: () => events.filter(e => e.kind === 'message').map(e => e.text) };
}

// Arriving from the town square (2000) puts a body at r36c5, the far corner of the tower. The
// walk from there spends most of its packets around r7c35-r9c37 before the fine fallback finds
// the way north; that is a separate inefficiency, and the budget below covers it.
const FROM_TOWN = { x: 5 * 64 + 32, y: 36 * 64 + 32 };
// Inside the doorway hall, two squares from the door: where the live failures were.
const AT_THE_DOOR = { x: 37 * 64 + 32, y: 5 * 64 + 32 };

// ------------------------------------------------------------- 1. one walker owns the body
{
  const t = tower({ from: FROM_TOWN, maxPackets: 1500 });
  const r = await t.s.travel(JUNGLE, { maxHops: 4, maxStumbles: 2, allowRescue: false });
  ok(r.arrived === true, `one walker crosses the East Tower door: ${JSON.stringify({ r, gos: t.gos, said: t.said() })}`);
  ok(t.s.world.room.num === JUNGLE, 'and the body is in 2115');
  ok(t.crossings.length === 1 && t.crossings[0].to === JUNGLE, 'by the declared 2013 -> 2115 exit');
  ok(t.gos.length >= 1 && t.gos.every(g => onDoorway(g.row, g.col)),
     `every go the server judged was on one of the three doorway squares: ${JSON.stringify(t.gos)}`);
  ok(t.said().includes(MAY_PASS), 'the captain waved it through');
  ok(!t.said().includes(CANT_GO), 'and nobody was told they could not go anywhere');
}

// ------------------------------------------------------------- 2. a second walker on the same body
//
// What the ladder allowed until this fix: a town trip's walker, bound for the SW door to 2000,
// still running while the hunt relocation walks to 2115. Measured live, its `fine` moves came
// ~400ms after the doorway walker's step, from a stale position, 80 units at 136 degrees --
// toward r37c4 -- e.g. r2c41 (2640,176) -> (2582,231). Modelled here as: whenever the body
// stands on a doorway square, the other walker's packet takes it 80 units that way.
const pull = p => onDoorway(p.row, p.col)
  ? { x: Math.round(p.x - 80 * Math.SQRT1_2), y: Math.round(p.y + 80 * Math.SQRT1_2) } : null;
const triedOf = r => (r.log ?? []).flatMap(l => l.also_tried ?? []);
{
  // After every packet: the doorway correction is undone before its confirm reads it back.
  // Lew, 13:01:34Z: r3c41 and r2c40 `doorway_position_not_confirmed`, r2c41 `geometry_blocked`
  // twice, `route_progressing_exits_exhausted` -- this sequence, square for square.
  const t = tower({ from: AT_THE_DOOR, intruder: pull, when: 'packet', maxPackets: 600 });
  const r = await t.s.travel(JUNGLE, { maxHops: 4, maxStumbles: 2, allowRescue: false });
  const tried = triedOf(r).map(x => `r${x.stand_on.row}c${x.stand_on.col} ${x.why}`);
  ok(r.arrived !== true && t.crossings.length === 0 && r.reason === 'route_progressing_exits_exhausted',
     `with a second walker on the body the door never opens: ${JSON.stringify({ reason: r.reason, tried })}`);
  ok(tried[0] === 'r3c41 doorway_position_not_confirmed' && tried[1] === 'r2c40 doorway_position_not_confirmed'
     && tried.slice(2).every(x => x === 'r2c41 geometry_blocked'),
     `and the refusals are the live ones, square for square: ${JSON.stringify(tried)}`);
  ok(t.gos.length === 0, 'no go was sent from a square the server did not confirm');
}
{
  // Between the confirm and the go: the server judges a square the walker had confirmed a
  // packet earlier, and a fleet-mate being waved through at the same moment is heard too.
  // Lew, 13:16:28Z: r3c41 sent, "You are unable to go anywhere.; Cital ko'Manca says, "You may pass."".
  const t = tower({ from: AT_THE_DOOR, intruder: pull, when: 'go', mate: true, maxPackets: 600 });
  const r = await t.s.travel(JUNGLE, { maxHops: 4, maxStumbles: 2, allowRescue: false });
  const sent = triedOf(r).filter(x => x.crossing_packet_sent === true);
  ok(r.arrived !== true && t.crossings.length === 0,
     `the door never opens: ${JSON.stringify({ reason: r.reason, tried: triedOf(r) })}`);
  ok(sent.length >= 1 && sent.every(x => x.why === `${CANT_GO}; ${MAY_PASS}`),
     `the go went out and came back as the live refusal: ${JSON.stringify(sent)}`);
  ok(t.gos.length >= 1 && t.gos.every(g => !onDoorway(g.row, g.col)),
     `every go was judged on the square the other walker had moved the body to: ${JSON.stringify(t.gos)}`);
}

console.log(`m59-kocatan-door-test: ${n} assertions passed`);
