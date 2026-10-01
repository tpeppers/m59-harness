#!/usr/bin/env node
// Offline: leaving The Wryn's Keep (room 704) from deep inside the hall, through an entrance that
// is THREE sectors raised one after another.
//
//   node tools/m59-wrynkeep-exit-test.mjs
//
// PROD, 2026-10-01. Janice (t7) stood at r39c24 and later r42c28 in 704 and every journey out
// failed — "did not reach 376 in three attempts", six times in a row — while Camilla (t9), at
// r50c27 just outside the entrance, left in thirty seconds. Operator: "wrynns keep guild hall
// doors require a similar ~3-5s delay for entry/exit as other guild halls".
//
// guildh4.kod's entrance is `OpenEntranceDoor`: `piPos2 = piPos2 + 1` then
// `SetSector #sector=piPos2 #height=196 #speed=16`, re-armed on NEXT_TIME (1s) until piPos2 is
// 3 — so sectors 1, 2 and 3 rise one second apart, each taking 68/16 = 4.25s, and the passage is
// open about 6.4s after the press. Three defects, each sufficient:
//
//   1. substrate/m59-doors.json named the entrance SECTOR 0. `#sector=piPos2` was resolved
//      through a constant parser that also reads `properties:`, where `piPos2 = 0`. Sector 0
//      never moves, so the wait for it could only time out.
//   2. substrate/m59-ceiling-doors.json had no sectors 1-3 at all (the variable-sector scan
//      resolved only upper-case constants), so even an entrance the server opened stayed shut in
//      the mover's geometry and the route out stayed "no route".
//   3. waitForDoorOpen waited 1.5s for the event — but the event that means "open" is the THIRD
//      sector's, which the server sends 2s after the press.
//
// The mover here is honest the way the live one is: a step lands only if `moverStepLands` says
// so, and the geometry changes only when the ceiling table applies the heights the server sent.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { applyCeilingDoors } from './m59-ceiling-doors.mjs';
// Absent before the door-chain planner; a checkout without it must FAIL, not refuse to load.
const { planDoorChain } = await import('./m59-ceiling-doors.mjs');
import { doorsFor, loadDoors } from './m59-doorplan.mjs';
import { waitForDoorOpen, refusedToGo } from './m59-door-wait.mjs';
import { doorsFor as kodDoorsFor } from './m59-doors.mjs';
import { groundEffectSquares } from './m59-ground-effects.mjs';
// Imported by namespace so a checkout without the counter scan FAILS its assertions rather than
// refusing to load — the travel cases below are the ones that say what that costs.
const counterSectorsInSource = (await import('./m59-varsectors.mjs')).counterSectorsInSource ?? (() => []);

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? ' — ' + detail : '')); }
};

// The entrance half of guildh4.kod, verbatim in the parts the scanners read (lines 172-250).
const GUILDH4 = `
GuildHall4 is GuildHall
constants:
   include blakston.khd
   WESTDOOR = 4
   RESET_TIME = 10000
   NEXT_TIME = 1000
   RESET_TIME_LONG = 20000
properties:
   piRoom_num = RID_GUILDH4
   piPos1 = 0
   piPos2 = 0
   ptEntrance = $
messages:
   OpenEntranceDoor()
   {
      if ptEntrance = $
      {
         if piPos2 > 2
         {
            return;
         }
         piPos2 = piPos2 + 1;
         send(self,@SetSector,#sector=piPos2,#animation=ANIMATE_CEILING_LIFT,
              #height=196,#speed=16);
         if piPos2 < 3
         {
            ptEntrance = CreateTimer(self,@ResetEntranceTimer,NEXT_TIME);
         }
         if piPos2 = 3
         {
            ptEntrance = CreateTimer(self,@ResetEntranceTimer,RESET_TIME);
         }
      }
      return;
   }
   CloseEntranceDoorTimer()
   {
      local iSectorID;
      if piPos2 < 2
      {
         return;
      }
      piPos2 = piPos2 + 1;
      iSectorID = piPos2 - 3;
      send(self,@SetSector,#sector=iSectorID,#animation=ANIMATE_CEILING_LIFT,
           #height=128,#speed=16);
      return;
   }
   SomethingTryGo(what = $,row = $,col = $)
   {
      if (row = 29) AND (col < 24)
      {
         send(self,@SetSector,#sector=WESTDOOR,#animation=ANIMATE_CEILING_LIFT,
              #height=204,#speed=16);
         ptReset = CreateTimer(self,@ResetTimer,RESET_TIME_LONG);
         return TRUE;
      }
      if row = 43 AND (col < 26 AND col > 23)
      {
         if send(self,@ReqLegalEntry,#who=what)
         {
            send(self,@OpenEntranceDoor);
            return TRUE;
         }
      }
      propagate;
   }
end
`;

console.log('\nthe kod: a sector named by a counter is a run of sectors');
{
  const [seq, ...more] = counterSectorsInSource(GUILDH4);
  ok('one counter-driven door is found', !!seq && !more.length, JSON.stringify(counterSectorsInSource(GUILDH4)));
  ok('it is sectors 1, 2 and 3 — not the counter\'s initial value 0',
     JSON.stringify(seq?.sectors) === '[1,2,3]', JSON.stringify(seq?.sectors));
  ok('raised to 196 and lowered to 128', seq?.open === 196 && seq?.closed === 128, `${seq?.open}/${seq?.closed}`);
  ok('one NEXT_TIME apart, held RESET_TIME', seq?.step_ms === 1000 && seq?.hold_ms === 10000,
     `${seq?.step_ms}/${seq?.hold_ms}`);
  const entrance = kodDoorsFor(GUILDH4).find(d => d.gate === 'ReqLegalEntry');
  ok('the door table names the run, starting at sector 1',
     entrance?.sector === 1 && JSON.stringify(entrance?.sectors) === '[1,2,3]', JSON.stringify(entrance));
  ok('with the 2s sequence and a 12s window from the press',
     entrance?.sequence_ms === 2000 && entrance?.delay_ms === 12000, JSON.stringify(entrance));
  // An ordinary constant-named door is untouched.
  const west = kodDoorsFor(GUILDH4).find(d => d.sector_name === 'WESTDOOR');
  ok('a constant-named door is still one sector', west?.sector === 4 && !west?.sectors, JSON.stringify(west));
}

console.log('\nthe shipped tables');
{
  const entrance = loadDoors()?.rooms?.['704']?.doors?.find(d => d.gate === 'ReqLegalEntry');
  ok('m59-doors.json: the 704 entrance is sectors 1+2+3',
     entrance?.sector === 1 && JSON.stringify(entrance?.sectors) === '[1,2,3]', JSON.stringify(entrance));
  const ceil = JSON.parse(readFileSync(new URL('../substrate/m59-ceiling-doors.json', import.meta.url))).rooms[704];
  const run = ceil?.doors?.find(d => JSON.stringify(d.ids) === '[1,2,3]');
  ok('m59-ceiling-doors.json: 704 carries the entrance as ONE door of three sectors',
     !!run && run.open === 196 && run.closed === 128, JSON.stringify(ceil?.doors?.map(d => d.ids ?? d.id)));
  ok('and stays a full table (32 states), so "entrance open, inner doors at rest" exists',
     ceil && !ceil.partial && Object.keys(ceil.states).length === 32 && !!ceil.states['196,128,128,128,128'],
     ceil && `${Object.keys(ceil.states).length} partial=${ceil.partial}`);
}

// ---------------------------------------------------------------------------------------------
// A body in 704 with a server that runs guildh4's entrance on a clock.
const OPEN = 196, SHUT = 128, SPEED = 16, STEP = 1000;
function hall(start, { plates = false } = {}) {
  const map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url)));
  attachStepMasks(map);
  const g = sharedRoomGeometry(map.rooms[704]);
  const observed = new Map();
  let clock = 0, pos = { ...start }, evSeq = 0;
  const pending = [], seen = { go: 0, walks: [], pressedAt: [] };
  applyCeilingDoors(map, 704, observed, null, { now: clock });
  const deliver = () => {
    const due = [];
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= clock) {
      const e = pending.shift();
      e.seq = ++evSeq;
      observed.set(e.sector, { type: 5, height: e.height, speed: e.speed });
      applyCeilingDoors(map, 704, observed, e, { now: clock });   // installDoorObserver's job
      due.push(e);
    }
    return due;
  };
  const sleep = async ms => { clock += ms; deliver(); };
  const c = {
    get self() { return pos; },
    get evSeq() { return evSeq; },
    room: { id: 4704, sectorHeights: observed, objects: new Map() },
    // The room resource, as the live client resolves it, so the ground-effect classifier knows
    // which hall it is in.
    roomRsc: 7704, rsc: new Map([[7704, 'guildh4.roo']]),
    eventsSince: () => [],
    // SomethingTryGo receives the body's OWN square (user.kod:5669).
    go: async () => {
      seen.go++;
      // The four inner doors (guildh4.kod:299-335): up to 204 at speed 16, down 20s later.
      // MASTERDOOR's kod test is `(row > 35) OR (row < 39)` -- any row -- on col 33.
      const inner = (pos.row === 29 && pos.col < 24) ? 4 : (pos.row === 29 && pos.col > 25) ? 5
        : pos.col === 33 ? 6 : (pos.row === 33 && (pos.col === 35 || pos.col === 36)) ? 7 : null;
      if (inner != null) {
        seen.pressedAt.push(clock); (seen.inner ??= []).push(inner);
        pending.push({ kind: 'sector-height', type: 5, room: 4704, sector: inner, height: 204,
                       speed: SPEED, at: clock });
        pending.push({ kind: 'sector-height', type: 5, room: 4704, sector: inner, height: SHUT,
                       speed: SPEED, at: clock + 20000 });
        return;
      }
      if (pos.row === 43 && pos.col > 23 && pos.col < 26) {
        (seen.entranceAt ??= []).push(clock);
        seen.pressedAt.push(clock);
        for (const [i, sector] of [1, 2, 3].entries())
          pending.push({ kind: 'sector-height', type: 5, room: 4704, sector, height: OPEN,
                         speed: SPEED, at: clock + i * STEP });
        for (const [i, sector] of [1, 2, 3].entries())
          pending.push({ kind: 'sector-height', type: 5, room: 4704, sector, height: SHUT,
                         speed: SPEED, at: clock + 2 * STEP + 10000 + i * STEP });   // RESET_TIME after the last, then one a second
      }
    },
    waitFor: async ({ timeoutMs, match }) => {
      clock += timeoutMs;
      return { events: deliver().filter(e => !match || match(e)) };
    },
  };
  // THE LIVE ROOM'S OBJECTS (keeper-t7.json, prod 2026-10-01): guildh4's twelve entry
  // hotplates, `something`, blank.bgf, flags LOOK_NO|MOVEON_NOTIFY, on rows 42-43 cols 22-27.
  if (plates) {
    let id = 2342;
    for (const row of [43, 42]) for (const col of [22, 23, 24, 25, 26, 27])
      c.room.objects.set(id, { id: id++, name: 'something', icon_file: 'blank.bgf',
                               flags: 0x40 | 0x03, row, col });
  }
  // The avoid set walkTo plans with: `hazardSquares()` is `groundEffectSquares(this.client)`
  // (m59-game.mjs), the real classifier, over the live objects.
  const walk = async (row, col) => {
    const avoid = groundEffectSquares(c);
    let path = g.path(pos.row, pos.col, row, col, { avoid });
    if (!path.found && path.collision_view) path = g.path(pos.row, pos.col, row, col, { avoid, collision: false });
    if (!path.found) return { arrived: false, reason: 'coarse grid failed (no route through the geometry)' };
    for (const next of path.steps) {
      if (!g.moverStepLands(pos.row, pos.col, next.row, next.col))
        return { arrived: false, reason: 'no_ground_gained', at: { ...pos } };
      pos = { row: next.row, col: next.col };
      await sleep(250);                      // a quarter-second a square
    }
    return { arrived: true };
  };
  // The live door opener, lifted out of m59-session-walk.mjs by name (see m59-dooropen-test).
  const source = readFileSync(new URL('./m59-session-walk.mjs', import.meta.url), 'utf8');
  const a = source.indexOf('  async openOperableDoor('), b = source.indexOf('\n  // WHICH INTERNAL DOOR', a);
  assert.ok(a >= 0 && b > a, 'openOperableDoor moved — this test is stale');
  const Session = new Function('doorsFor', 'setTimeout', 'Date', 'waitForDoorOpen', 'refusedToGo',
    'planDoorChain', `return class { ${source.slice(a, b)} }`)(
      doorsFor, (fn, ms) => { clock += ms; deliver(); fn(); }, { now: () => clock },
      (cl, p, opts) => waitForDoorOpen(cl, p, { ...opts, now: () => clock, sleep }), refusedToGo,
      planDoorChain);
  const s = new Session();
  s.movementGeneration = 1;
  s.world = { room: { num: 704 }, geometry: g, map };
  s.movementWasCancelled = () => false;
  s.pacer = { submit: async (_k, fn) => fn() };
  s.need = () => c;
  s.confirmPosition = async () => ({ ...pos });
  s.walkTo = async (col, row) => { seen.walks.push({ row, col }); return walk(row, col); };
  return { s, g, c, map, seen, walk, observed, where: () => pos, now: () => clock };
}

// A STAND-IN FOR TRAVEL, testing the door opener alone: plan to the exit; when there is no
// way, work a door once and re-plan. It passed on 7769305 while prod still failed — the real
// `travel` never reached the opener — so the section after these drives the REAL `travel`.
async function travelOut(h) {
  const EXIT = { row: 50, col: 27 };       // the south edge -> room 350; where t9 left from
  const log = [];
  let doorTried = false;
  for (let i = 0; i < 4; i++) {
    const walked = await h.walk(EXIT.row, EXIT.col);
    log.push({ walked, at: { ...h.where() }, t: h.now() });
    if (walked.arrived) return { arrived: true, log };
    if (doorTried) return { arrived: false, log };
    doorTried = true;
    const opened = await h.s.openOperableDoor();
    log.push({ opened, t: h.now() });
    if (!opened.opened) return { arrived: false, log, opened };
  }
  return { arrived: false, log };
}

for (const start of [{ row: 42, col: 28 }, { row: 39, col: 24 }]) {
  console.log(`\nleaving 704 from r${start.row}c${start.col}`);
  const h = hall(start);
  ok('the resting hall has no way from here to the south edge (the entrance is shut)',
     !h.g.path(start.row, start.col, 50, 27).found);
  const r = await travelOut(h);
  const opened = r.log.find(x => x.opened)?.opened;
  ok('the door it works is the entrance — sector 1 of the run 1+2+3',
     opened?.sector === 1, JSON.stringify(opened));
  ok('it presses from the entrance trigger on row 43', h.seen.pressedAt.length === 1 &&
     h.seen.walks[0]?.row === 43 && [24, 25].includes(h.seen.walks[0]?.col), JSON.stringify(h.seen.walks));
  ok('the opening is confirmed, not assumed', opened?.opened === true, JSON.stringify(opened));
  // ~6.4s: the third sector starts 2s after the press and takes 68/16 = 4.25s.
  const settled = r.log.find(x => x.opened)?.t;
  ok('it waited for the LAST sector to finish rising — over 6s after the press, inside the 12s window',
     opened?.opened && h.seen.pressedAt[0] != null && (settled - h.seen.pressedAt[0]) >= 6000 &&
     (settled - h.seen.pressedAt[0]) < 12000,
     `${h.seen.pressedAt[0]} -> ${settled}`);
  ok('and the body walks out to the south edge', r.arrived === true && h.where().row === 50,
     JSON.stringify(r.log.map(x => x.walked ?? x.opened)));
}

console.log('\npart-way through the run the entrance is still shut');
{
  const h = hall({ row: 43, col: 25 });
  await h.c.go();
  await h.c.waitFor({ timeoutMs: 1100 });     // sectors 1 and 2 have been sent, 3 has not
  ok('two sectors of three up: still no way through',
     h.observed.size === 2 && !h.g.path(43, 25, 50, 27).found, `${h.observed.size} sectors seen`);
  await h.c.waitFor({ timeoutMs: 1000 });
  ok('the third one: the way through exists', h.g.path(43, 25, 50, 27).found);
}

// ---------------------------------------------------------------------------------------------
// THE REAL `travel`, lifted out of m59-game.mjs by brace matching (as m59-travel-test does),
// run on the 704 body above. Prod 2026-10-01 after 7769305: Janice at r42c28, `come-home
// home=350` failed three times and her keeper log held only
//   [walkTo] t7 coarse grid failed (no route through the geometry) ... requested square r51c26
// for r51c26, r50c26 and r50c27 — never a press. The exit walker here is honest in the same
// way: it walks the mover's geometry to a candidate square and crosses the south edge from it,
// or fails with that sentence. It does not report `exit_candidates_exhausted`, because a
// grinding walkTo does not get that far inside a job's budget — which is why the router-level
// door branch never fired.
const gameSrc = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const tAt = gameSrc.indexOf('  async travel(toRoomNum, {');
const SIG_END = '} = {}) {';
const tSig = gameSrc.indexOf(SIG_END, tAt);
assert.ok(tAt > 0 && tSig > tAt, 'travel is not in m59-game.mjs — this test is stale');
let tDepth = 0, tEnd = -1;
for (let i = tSig + SIG_END.length - 1; i < gameSrc.length; i++) {
  if (gameSrc[i] === '{') tDepth++;
  else if (gameSrc[i] === '}') { tDepth--; if (tDepth === 0) { tEnd = i + 1; break; } }
}
const { operableDoorsBlocking } = await import('./m59-doorplan.mjs');
const { readHealth } = await import('./m59-parse.mjs');
const realTravel = new Function('orderExits', 'BARRED_ON_ENTRY', 'readHealth', 'nearestSafeSpot',
  'operableDoorsBlocking', `return ({ ${gameSrc.slice(tAt, tEnd)} }).travel`)(
    c => c, /guardian angel holds you back/i, readHealth, () => null, operableDoorsBlocking);

function travelling(start, opts = {}) {
  const h = hall(start, opts);
  const s = h.s;
  let room = 704;
  const exitWalks = [];
  s.name = 't7';
  s.noteTransit = () => {};
  s.client = h.c;
  h.c.roomContents = async () => {};
  s.world = {
    geometry: h.g,
    map: h.map,
    get room() { return { num: room, name: room === 704 ? "The Wryn's Keep" : 'room 350' }; },
    get self() { return h.c.self; },
    route: to => room === to ? { found: true, hops: [] }
      : { found: true, hops: [{ from: room, to: 350, to_name: 'room 350', kind: 'edge' }] },
    exits: () => room !== 704 ? [] : [26, 27].map(col =>
      ({ to: 350, kind: 'edge', direction: 'south', stand_on: { row: 50, col } })),
  };
  s.cancelledMovement = ({ log }) => ({ arrived: false, cancelled: true, log });
  s.rideTrack = async () => ({ rode: false, why: 'no track in this fixture' });
  s.planSameRoomDoors = () => null;
  s.leaveViaAny = async candidates => {
    const tried = [];
    for (const e of candidates) {
      exitWalks.push({ from: { ...h.where() }, to: e.stand_on, t: h.now() });
      const walked = await h.walk(e.stand_on.row, e.stand_on.col);
      if (walked.arrived) { room = 350; return { left: true, used_exit: e }; }
      tried.push({ stand_on: e.stand_on, stage: 'walk', crossing_packet_sent: false, why: walked.reason });
    }
    return { left: false, tried, reason: tried[0]?.why ?? 'no candidate' };
  };
  return { ...h, exitWalks, room: () => room };
}

for (const start of [{ row: 42, col: 28 }, { row: 39, col: 24 }]) {
  console.log(`\nthe REAL travel, 704 -> 350 from r${start.row}c${start.col}`);
  const t = travelling(start);
  const r = await realTravel.call(t.s, 350, {});
  const door = (r.log ?? []).find(l => l.outcome === 'operated_a_door');
  ok('travel works the entrance before walking at the exit',
     door?.sector === 1 && t.seen.pressedAt.length === 1,
     JSON.stringify((r.log ?? []).slice(0, 4)).slice(0, 400));
  ok('no exit walk was spent against the shut entrance',
     t.exitWalks.length > 0 && t.exitWalks[0].t > (t.seen.pressedAt[0] ?? Infinity),
     JSON.stringify(t.exitWalks.slice(0, 3)));
  ok('the first exit walk starts after the run has finished rising (>= 6s after the press)',
     t.exitWalks[0] && t.seen.pressedAt[0] != null && t.exitWalks[0].t - t.seen.pressedAt[0] >= 6000,
     `${t.seen.pressedAt[0]} -> ${t.exitWalks[0]?.t}`);
  ok('and the journey arrives in 350', r.arrived === true && t.room() === 350,
     JSON.stringify({ arrived: r.arrived, reason: r.reason, room: t.room() }));
}

// THE LIVE CONDITIONS, prod 2026-10-01 after 1b5629a: Janice's keeper reported her at r39c26
// with doors.applied "128,128,128,128,128" (the entrance run and all four inner doors shut)
// and the twelve hotplates in the room -- and logged only "coarse grid failed ... requested
// square r43c24 / r43c25": the walk to the press square itself was refused, because the
// hotplates were filed as unknown ground effects and their squares were in the walk's avoid set.
// The east-wing start is the inner-door case: behind MASTERDOOR, so the chain is 6 then 1+2+3.
for (const start of [{ row: 39, col: 26 }, { row: 42, col: 28 }, { row: 42, col: 33 }]) {
  console.log(`\nthe REAL travel, live conditions (hotplates, every door shut) from r${start.row}c${start.col}`);
  const t = travelling(start, { plates: true });
  ok('the hotplates are in the room and the run and inner doors are all shut',
     t.c.room.objects.size === 12 && t.observed.size === 0);
  const r = await realTravel.call(t.s, 350, {});
  ok('the entrance is pressed', (t.seen.entranceAt?.length ?? 0) >= 1,
     JSON.stringify((r.log ?? []).filter(l => l.outcome).slice(0, 4)).slice(0, 500));
  ok('and the journey arrives in 350', r.arrived === true && t.room() === 350,
     JSON.stringify({ arrived: r.arrived, reason: r.reason, at: t.where(), inner: t.seen.inner ?? [] }));
  if (start.col === 33)
    ok('the inner door (MASTERDOOR, 6) is opened first, then the entrance',
       JSON.stringify(t.seen.inner ?? []) === '[6]' &&
       t.seen.pressedAt[0] < (t.seen.entranceAt?.[0] ?? -1), JSON.stringify(t.seen));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
