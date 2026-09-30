#!/usr/bin/env node
// THE LEVER PUZZLE IN ROOM 2600, WORKED BY THE KEEPER. Offline, no server, safe any time:
//
//   node tools/m59-leverpuzzle-test.mjs
//
// Operator, 2026-09-30: travel to Marion crypt 2 (2601) has to be "basically automatic", and the
// two levers in 2600 "will always be in the way". This pins the parts that decide whether two
// keepers that never talk to each other open that door, and whether one alone says so instead of
// looking wedged:
//
//   * the declaration agrees with the kod AND with the committed ceiling-door bake;
//   * the claim book: first free lever, the other to the second arrival, none to a third, a claim
//     nobody refreshes expires, a race is settled by reading back, a corrupt book is not overwritten;
//   * the beat: two keepers deciding apart aim at the same instant, inside the 2 s window;
//   * the door is judged from inside the room only — the 2026-09-30 errand trusted a height read
//     in Marion and sent six characters at a shut door — and never latched;
//   * the final area counts what CountInFinal counts, and a player is never a foe;
//   * the lone traveller waits at its lever and its status says "waiting for a second lever puller";
//   * two fake keepers pull on the same beat, both inside SLAM_TIME, and the door is what they read;
//   * a journey hands the body over in 2600 and nowhere else, and a character below never comes up.
import './m59-test-ledger.mjs';        // FIRST — the ledger goes to a scratch file
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'm59-leverpuzzle-'));
const FILE = join(dir, 'lever-claims-test.json');
process.env.M59_LEVER_CLAIMS_FILE = FILE;

const L = await import('./m59-leverpuzzle.mjs');
const { Autopilot, HANDLED, CONTINUE } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const here = dirname(fileURLToPath(import.meta.url));
const P = L.LEVER_PUZZLES[2600];
const T0 = 1_700_000_000_000;

try {
  // ------------------------------------------------------------------ the declaration
  console.log('\nthe declaration');
  ok('2600 is declared, and leads to 2601', P && P.room === 2600 && P.to === 2601);
  ok('the levers are at r27c4 and r27c9 (CreateLevers)',
     P.levers[0].lever.row === 27 && P.levers[0].lever.col === 4 &&
     P.levers[1].lever.row === 27 && P.levers[1].lever.col === 9);
  ok('each stand square is within GUESTLEVER_RANGE (1) of its lever and outside the final area',
     P.levers.every((l, ix) => L.chebyshev(l.stand, l.lever) <= 1 && L.atLever(l.stand, P, ix)));
  ok('the window is SLAM_TIME (2000) and FightTimer is 10 s', P.windowMs === 2000 && P.fightTimerMs === 10000);
  const baked = JSON.parse(readFileSync(join(here, '..', 'substrate', 'm59-ceiling-doors.json'), 'utf8')).rooms['2600'];
  const bakedDoor = id => baked?.doors?.find(d => d.id === id);
  ok('SECTOR_DOOR matches the committed ceiling-door bake (3: shut 84, open 172)',
     bakedDoor(3)?.closed === P.door.shut && bakedDoor(3)?.open === P.door.open);
  ok('the well sectors match the bake (6: 200->273, 7: 88->161)',
     P.well.sectors.every(s => bakedDoor(s.sector)?.closed === s.shut && bakedDoor(s.sector)?.open === s.open));
  ok('the bake has a mask for every state the puzzle passes through (door open; well open)',
     '172,200,88' in (baked.states ?? {}) && '84,273,161' in (baked.states ?? {}));
  const map = JSON.parse(readFileSync(join(here, '..', 'substrate', 'm59-map.json'), 'utf8')).rooms['2600'];
  const wellExits = (map?.goExits ?? []).filter(e => e.to === 2601).map(e => `r${e.row}c${e.col}`).sort();
  ok('the well exits are the map\'s go-exits to 2601 (r38c6, r38c7)',
     JSON.stringify(wellExits) === JSON.stringify(P.well.exits.map(e => `r${e.row}c${e.col}`).sort()), wellExits.join(','));
  ok('the well exits are inside the final box', P.well.exits.every(e => L.inFinalBox(e, P)));
  ok('the entry square is inside the final box, the stage square is not',
     L.inFinalBox(P.enterAt, P) && !L.inFinalBox(P.stage, P) && L.inHall(P.stage, P));

  // ------------------------------------------------------------------ who is bound
  console.log('\nwhich journeys the puzzle catches');
  ok('2600 -> 2601 is worked, not walked', L.puzzleBlocksJourney(2600, 2601));
  ok('a character already below (2601) is never sent back up', !L.puzzleBlocksJourney(2601, 2601) && !L.puzzleBlocksJourney(2601, 2600));
  ok('Marion -> 2601 is walked (the hand-off happens on arrival in 2600)', !L.puzzleBlocksJourney(200, 2601));
  ok('2600 -> Marion is an ordinary walk out', !L.puzzleBlocksJourney(2600, 200));

  // ------------------------------------------------------------------ the claim book
  console.log('\nthe claim book');
  {
    const b = L.emptyBook();
    const a = L.claimLever(b, { puzzle: P, agent: 'A', now: T0, pos: { row: 25, col: 9 } });
    ok('the first arrival takes the NEAREST free lever', a === 1, String(a));
    const bb = L.claimLever(b, { puzzle: P, agent: 'B', now: T0 + 100, pos: { row: 25, col: 9 } });
    ok('the second takes the other one', bb === 0, String(bb));
    const c = L.claimLever(b, { puzzle: P, agent: 'C', now: T0 + 200 });
    ok('a third gets none', c === null);
    ok('re-claiming refreshes rather than moving', L.claimLever(b, { puzzle: P, agent: 'A', now: T0 + 5000 }) === 1
       && b.rooms['2600'].levers[1].seen === T0 + 5000);
    ok('a held lever is reported to its holder', L.heldLever(b, 2600, 'B', T0 + 1000) === 0);
    const late = T0 + 100 + L.CLAIM_TTL_MS + 1;
    ok('a claim nobody refreshed expires', L.heldLever(b, 2600, 'B', late) === null);
    ok('...and the third character can then take it',
       L.claimLever(b, { puzzle: P, agent: 'C', now: late }) === 0 && b.rooms['2600'].levers[0].agent === 'C');
    ok('the refreshed claim survived the prune', b.rooms['2600'].levers[1]?.agent === 'A');
    ok('release frees only this agent\'s lever',
       L.releaseLevers(b, { room: 2600, agent: 'A' }) && !b.rooms['2600'].levers[1] && b.rooms['2600'].levers[0].agent === 'C');
  }

  console.log('\nready, and the partner rule');
  {
    const b = L.emptyBook();
    L.claimLever(b, { puzzle: P, agent: 'A', now: T0 });
    ok('one holder alone is never ready to pull', L.markReady(b, { room: 2600, agent: 'A', now: T0 })
       && !L.partnerReady(b, { room: 2600, agent: 'A', now: T0 }));
    L.claimLever(b, { puzzle: P, agent: 'B', now: T0 });
    ok('two holders, one not at its lever: not ready', !L.partnerReady(b, { room: 2600, agent: 'A', now: T0 + 10 }));
    L.markReady(b, { room: 2600, agent: 'B', now: T0 + 20 });
    ok('both at their levers: ready, for either of them',
       L.partnerReady(b, { room: 2600, agent: 'A', now: T0 + 30 }) && L.partnerReady(b, { room: 2600, agent: 'B', now: T0 + 30 }));
    ok('...but not for a third character, who pulls nothing', !L.partnerReady(b, { room: 2600, agent: 'C', now: T0 + 30 }));
    ok('a ready mark older than READY_FRESH_MS is not believed',
       !L.partnerReady(b, { room: 2600, agent: 'A', now: T0 + L.READY_FRESH_MS + 1 }));
    const same = L.emptyBook();
    same.rooms['2600'] = { levers: { 0: { agent: 'A', seen: T0, ready: T0 }, 1: { agent: 'A', seen: T0, ready: T0 } } };
    ok('one character holding both levers is not two pullers', !L.partnerReady(same, { room: 2600, agent: 'A', now: T0 }));
  }

  console.log('\nthe book on disk');
  {
    const got = L.claimLeverOnDisk({ puzzle: P, agent: 'A', file: FILE, now: T0, pos: { row: 26, col: 4 } });
    ok('a claim through the file reads back as held', got === 0);
    // THE RACE: both read the same empty book and both write lever 0. The last rename wins; the
    // loser finds out by reading, which is what claimLeverOnDisk returns.
    const stale = L.emptyBook();
    L.claimLever(stale, { puzzle: P, agent: 'B', now: T0 + 1, pos: { row: 26, col: 4 } });
    writeFileSync(FILE, JSON.stringify(stale));               // B's write lands over A's
    ok('the loser of a race learns it by reading back', L.heldLever(L.readClaims({ file: FILE }), 2600, 'A', T0 + 2) === null
       && L.heldLever(L.readClaims({ file: FILE }), 2600, 'B', T0 + 2) === 0);
    ok('...and its next claim takes the lever that is left',
       L.claimLeverOnDisk({ puzzle: P, agent: 'A', file: FILE, now: T0 + 3 }) === 1);
    writeFileSync(FILE, '{"format": "m59-lever-claims/1", "rooms": {');   // half-written
    let threw = false;
    try { L.updateClaims(b => L.claimLever(b, { puzzle: P, agent: 'C', now: T0 }), { file: FILE }); }
    catch { threw = true; }
    ok('a book that will not parse is refused by a writer, not overwritten',
       threw && readFileSync(FILE, 'utf8').endsWith('"rooms": {'));
    ok('...and a plain reader sees an empty book rather than throwing',
       JSON.stringify(L.readClaims({ file: FILE }).rooms) === '{}');
    writeFileSync(FILE, JSON.stringify(L.emptyBook()));
  }

  // ------------------------------------------------------------------ the beat
  console.log('\nthe beat');
  {
    const base = 1000 * L.PULL_BEAT_MS;                       // a boundary
    const b1 = L.nextPullBeat(base + 1000), b2 = L.nextPullBeat(base + 1300);
    ok('two keepers deciding 300 ms apart aim at the same beat', b1 === b2 && L.beatStart(b1) === base + L.PULL_BEAT_MS);
    ok('a decision closer than PULL_LEAD_MS to a boundary aims at the one after',
       L.nextPullBeat(base + L.PULL_BEAT_MS - 100) === 1000 + 2);
    ok('beatOf is the wall clock divided by the period (the wand volley\'s rule)',
       L.beatOf(base + 4999) === 1000 && L.beatOf(base + 5000) === 1001);
    const bk = L.emptyBook();
    // A decides just before the lead line; B's pass runs 600 ms later — past it, on its own rule.
    const a = L.agreeBeat(bk, { room: 2600, now: base + L.PULL_BEAT_MS - L.PULL_LEAD_MS - 50 });
    const bOwn = L.nextPullBeat(base + L.PULL_BEAT_MS - L.PULL_LEAD_MS + 550);
    const b = L.agreeBeat(bk, { room: 2600, now: base + L.PULL_BEAT_MS - L.PULL_LEAD_MS + 550 });
    ok('without the book those two would have disagreed', bOwn !== a.beat);
    ok('with it, the partner ADOPTS the proposed beat while it is still ahead', b.adopted && b.fireAt === a.fireAt);
    ok('both fire inside SLAM_TIME of each other', Math.abs(a.fireAt - b.fireAt) < P.windowMs);
    const c = L.agreeBeat(bk, { room: 2600, now: a.fireAt + 10 });
    ok('a beat that has passed is not adopted; a new one is proposed', !c.adopted && c.fireAt > a.fireAt);
  }

  // ------------------------------------------------------------------ the doors
  console.log('\nthe doors, judged from inside the room only');
  {
    const open = new Map([[3, { height: 172, at: T0 }]]);
    ok('heights read in Marion (200) are NOT trusted, even when they say open',
       L.trustedDoorHeights({ roomNum: 200, puzzle: P, sectorHeights: open }) === null
       && L.doorState(L.trustedDoorHeights({ roomNum: 200, puzzle: P, sectorHeights: open }), P.door) === 'unknown');
    const h = L.trustedDoorHeights({ roomNum: 2600, puzzle: P, sectorHeights: open });
    ok('in 2600, sector 3 at 172 is open', L.doorState(h, P.door) === 'open');
    ok('in 2600, a door that has not moved this visit is shut (the shipped height)',
       L.doorState(L.trustedDoorHeights({ roomNum: 2600, puzzle: P, sectorHeights: new Map() }), P.door) === 'shut');
    ok('one lever alone reads ajar (128), which is not open',
       L.doorState({ 3: 128 }, P.door) === 'ajar');
    ok('the well is open on either exit sector', L.wellState({ 6: 273 }, P.well) === 'open'
       && L.wellState({ 7: 161 }, P.well) === 'open' && L.wellState({ 6: 200, 7: 88 }, P.well) === 'shut');
    ok('the decision in Marion is not_here, whatever a stale height says',
       L.decideLeverStep({ puzzle: P, roomNum: 200, pos: { row: 80, col: 15 }, heights: { 3: 172 },
                           book: L.emptyBook(), agent: 'A', now: T0 }).kind === 'not_here');
    // NOT LATCHED: the same keeper, a moment later, with the door shut again, is back to the levers.
    const inHall = { row: 26, col: 4 };
    const bk = L.emptyBook(); L.claimLever(bk, { puzzle: P, agent: 'A', now: T0 });
    const first = L.decideLeverStep({ puzzle: P, roomNum: 2600, pos: inHall, heights: { 3: 172 }, book: bk, agent: 'A', now: T0 });
    const then = L.decideLeverStep({ puzzle: P, roomNum: 2600, pos: inHall, heights: { 3: 84 }, book: bk, agent: 'A', now: T0 + 1 });
    ok('open -> enter; shut again a moment later -> back at the lever, nothing latched',
       first.kind === 'enter_final' && then.kind === 'wait_partner', `${first.kind} then ${then.kind}`);
  }

  // ------------------------------------------------------------------ the final area
  console.log('\nthe final area');
  {
    ok('r28c1 and r38c10 are inside, r27c6 and r28c11 are not',
       L.inFinalBox({ row: 28, col: 1 }, P) && L.inFinalBox({ row: 38, col: 10 }, P)
       && !L.inFinalBox({ row: 27, col: 6 }, P) && !L.inFinalBox({ row: 28, col: 11 }, P));
    ok('CountInFinal also counts west of col 3 below row 15', L.inFinalZone({ row: 20, col: 2 }, P)
       && !L.inFinalZone({ row: 20, col: 3 }, P) && !L.inFinalZone({ row: 15, col: 1 }, P));
    const objs = [
      { id: 1, name: 'spectral mummy', row: 30, col: 5, attackable: true },
      { id: 2, name: 'statue', row: 32, col: 7, attackable: false },          // dormant
      { id: 3, name: 'spectral mummy', row: 20, col: 20, attackable: true },  // in the hall, not counted
      { id: 4, name: 'statue', row: 33, col: 6, attackable: true, player: true },
      { id: 5, name: 'Kermit', row: 31, col: 6, attackable: true, player: true },
      { id: 6, name: 'lever', row: 27, col: 4, attackable: false },
    ];
    const foes = L.finalFoes(objs, P).map(o => o.id).sort();
    ok('foes are the monsters inside, including the dormant statue', JSON.stringify(foes) === '[1,2]', JSON.stringify(foes));
    ok('a player is never a foe, whatever it is called', !foes.includes(4) && !foes.includes(5));
  }

  // ------------------------------------------------------------------ the decision
  console.log('\nthe decision, one pass at a time');
  {
    const d = (pos, { heights = {}, book = L.emptyBook(), agent = 'A', foes = [] } = {}) =>
      L.decideLeverStep({ puzzle: P, roomNum: 2600, pos, heights, book, agent, now: T0, foes }).kind;
    ok('at the entrance with the door shut: walk to the lever hall', d({ row: 11, col: 17 }) === 'approach');
    ok('in the hall, nothing held: claim', d({ row: 25, col: 8 }) === 'claim');
    const full = L.emptyBook();
    L.claimLever(full, { puzzle: P, agent: 'B', now: T0 }); L.claimLever(full, { puzzle: P, agent: 'C', now: T0 });
    ok('in the hall, both held by others: wait by the door', d({ row: 25, col: 8 }, { book: full }) === 'wait_hall');
    const one = L.emptyBook(); L.claimLever(one, { puzzle: P, agent: 'A', now: T0, pos: { row: 26, col: 9 } });
    ok('holding a lever, not at it: walk to it', d({ row: 25, col: 6 }, { book: one }) === 'go_to_lever');
    const lone = L.decideLeverStep({ puzzle: P, roomNum: 2600, pos: { row: 26, col: 9 }, heights: {}, book: one, agent: 'A', now: T0 });
    ok('at it, alone: wait for a partner — and the status says so',
       lone.kind === 'wait_partner' && lone.status === 'waiting for a second lever puller', lone.status);
    L.markReady(one, { room: 2600, agent: 'A', now: T0 });
    L.claimLever(one, { puzzle: P, agent: 'B', now: T0 }); L.markReady(one, { room: 2600, agent: 'B', now: T0 });
    ok('at it, partner at the other: pull', d({ row: 26, col: 9 }, { book: one }) === 'pull');
    ok('door open, outside: go in', d({ row: 26, col: 9 }, { book: one, heights: { 3: 172 } }) === 'enter_final');
    const mummy = { id: 1, name: 'spectral mummy', row: 31, col: 5, attackable: true };
    const statue = { id: 2, name: 'statue', row: 32, col: 7, attackable: false };
    ok('inside, a monster awake: fight', d({ row: 30, col: 6 }, { foes: [mummy, statue] }) === 'fight');
    ok('inside, only the dormant statue: wake it', d({ row: 30, col: 6 }, { foes: [statue] }) === 'wake');
    ok('inside, nothing left: hold the area for the well', d({ row: 30, col: 6 }) === 'hold_final');
    const down = L.decideLeverStep({ puzzle: P, roomNum: 2600, pos: { row: 36, col: 6 }, heights: { 3: 84, 6: 273, 7: 161 },
                                     book: L.emptyBook(), agent: 'A', now: T0 });
    ok('inside, the well open: descend at the nearest go-square', down.kind === 'descend'
       && down.exit.row === 38 && (down.exit.col === 6 || down.exit.col === 7));
    ok('outside in the hall with the well open (door shut behind the fighters): wait for the cycle',
       d({ row: 26, col: 6 }, { heights: { 3: 84, 6: 273 } }) === 'wait_cycle');
  }

  console.log('\nthe approach legs');
  {
    const from = L.nextApproachLeg({ row: 11, col: 17 }, P);
    ok('from the entrance, one of the first legs', from.index <= 1, JSON.stringify(from));
    const jump = L.nextApproachLeg({ row: 32, col: 30 }, P);
    ok('standing at r32c30, the next leg is the running fall to r35c30', jump.to.row === 35 && jump.to.col === 30);
    const past = L.nextApproachLeg({ row: 35, col: 30 }, P);
    ok('landed at r35c30, the next leg is west along row 37', past.to.row === 37 && past.to.col === 20);
    ok('a remembered index wins over the nearest square', L.nextApproachLeg({ row: 11, col: 17 }, P, { index: 5 }).index === 5);
    ok('the last leg ends in the lever hall', L.inHall(P.approach[P.approach.length - 1], P));
  }

  // ------------------------------------------------------------------ the keeper
  console.log('\nthe keeper: a lone traveller');
  // A keeper with exactly the surface passLeverPuzzle reads. Walks arrive instantly; the client
  // records every activate, and a fake room turns two activations inside 2 s into door 3 at 172.
  const room2600 = { activations: [], sectorHeights: new Map() };
  function keeper(name, pos, { policy = { assignedRoom: 2601 }, roomNum = 2600, movementLeased = false,
                               shared = room2600, health = 40 } = {}) {
    const k = Object.create(Autopilot.prototype);
    const objects = new Map([[9001, { id: 9001, nameRsc: 'lever', row: 27, col: 4, flags: 0 }],
                             [9002, { id: 9002, nameRsc: 'lever', row: 27, col: 9, flags: 0 }]]);
    const c = {
      selfId: 1, self: { ...pos }, evSeq: 0, events: [],
      room: { id: 777, objects, get sectorHeights() { return shared.sectorHeights; } },
      rsc: { get: r => r },
      vitals: () => ({ health: { value: health, max: 40 } }),
      eventsSince: () => [],
      rest: () => { k.rested = (k.rested || 0) + 1; },
      activate: (id) => {
        const at = Date.now();
        shared.activations.push({ who: name, id, at });
        const recent = shared.activations.filter(a => at - a.at <= P.windowMs);
        if (new Set(recent.map(a => a.who)).size >= 2) shared.sectorHeights.set(3, { height: 172, at });
      },
    };
    Object.assign(k, {
      policy: { ...policy }, tally: { kills: 0 }, killTimes: [], notes: [], progressed: [], ledger: [],
      passes: 1, doing: null, suspendedJourney: null, leverPuzzleBound: null,
      s: { name, live: true, client: c,
           world: { room: { num: roomNum, name: 'The crypt in Marion' }, exits: () => [] },
           pacer: { submit: async (_k, fn) => fn() },
           standBeforeGo: async () => {},
           walkTo: async (col, row) => { c.self = { row, col }; return { arrived: true }; } },
      who: () => name,
      note: (what, d) => k.notes.push({ what, ...d }),
      progress: m => k.progressed.push(m), noProgress: m => k.progressed.push('! ' + m),
      ledgerEvent: (kind, d) => k.ledger.push({ kind, ...d }),
      facultyHeld: f => movementLeased && f === 'movement',
      safety: () => ({ fleeAt: 0.4 }), bannedWeaponsNow: () => null, countLoot: () => {},
      fightNow: async () => ({ fought: false }),
    });
    return k;
  }
  writeFileSync(FILE, JSON.stringify(L.emptyBook()));
  {
    const k = keeper('Loner', { row: 25, col: 8 }, { health: 30 });
    const r1 = await k.passLeverPuzzle({});
    const held = L.heldLever(L.readClaims({ file: FILE }), 2600, 'Loner', Date.now());
    ok('first pass in the hall: takes a lever and walks onto its square', r1 === HANDLED && held != null
       && L.atLever(k.s.client.self, P, held), JSON.stringify(k.s.client.self));
    const r2 = await k.passLeverPuzzle({});
    ok('second pass, alone: HANDLED, and nothing is pulled', r2 === HANDLED && room2600.activations.length === 0);
    ok('the keeper\'s doing reads "waiting for a second lever puller"', k.doing === 'waiting for a second lever puller', k.doing);
    const lp = k.leverPuzzleStatus();
    ok('status().lever_puzzle says waiting, with the lever and since when',
       lp?.waiting === 'waiting for a second lever puller' && lp.lever === held && lp.waiting_since != null, JSON.stringify(lp));
    ok('it said so once in the journal, with the reason', k.notes.filter(n => n.what === 'waiting for a second lever puller').length === 1);
    await k.passLeverPuzzle({});
    ok('...and not again on the next pass', k.notes.filter(n => n.what === 'waiting for a second lever puller').length === 1);
    ok('it rests while it waits and nothing is near', (k.rested || 0) >= 1);
    ok('its ready mark is in the book for a partner to find',
       L.readClaims({ file: FILE }).rooms['2600'].levers[held].ready != null);
    ok('no journey was blinked or re-issued — it did not move', k.s.client.self.row === P.levers[held].stand.row
       && k.s.client.self.col === P.levers[held].stand.col);

    // It never fights a player: a player standing beside the waiter is not swung at.
    const kp = keeper('Guard', { row: 26, col: 4 });
    const fights = [];
    kp.fightNow = async (o) => { fights.push(o); return { fought: false }; };
    kp.s.client.room.objects.set(5, { id: 5, nameRsc: 'Enemy', row: 26, col: 5, flags: OF.PLAYER | OF.ATTACKABLE });
    await kp.leverIdle(P);
    ok('a PLAYER beside a waiting character is not fought', fights.length === 0);
    kp.s.client.room.objects.set(6, { id: 6, nameRsc: 'spectral mummy', row: 26, col: 3, flags: OF.ATTACKABLE });
    await kp.leverIdle(P);
    ok('a monster beside it is, creature-only and from where it stands',
       fights.length === 1 && fights[0].includePlayers === false && fights[0].holdPosition === true
       && fights[0].avoid({ flags: OF.PLAYER, row: 26, col: 5 }) === true);
    k.leaveLeverPuzzle(2600, 'test over');
    ok('leaving releases the lever', L.heldLever(L.readClaims({ file: FILE }), 2600, 'Loner', Date.now()) === null);
  }

  console.log('\nthe keeper: who is bound, and who is not');
  {
    const below = keeper('Below', { row: 3, col: 26 }, { roomNum: 2601 });
    ok('a character already in 2601 with the assignment does nothing here',
       await below.passLeverPuzzle({}) === CONTINUE && !L.heldLever(L.readClaims({ file: FILE }), 2600, 'Below', Date.now()));
    const marion = keeper('Walker', { row: 80, col: 15 }, { roomNum: 200 });
    room2600.sectorHeights.set(3, { height: 172, at: Date.now() });   // a stale "open" from a past visit
    ok('in Marion with a stale open door in the client, nothing is decided here',
       await marion.passLeverPuzzle({}) === CONTINUE && marion.doing === null);
    room2600.sectorHeights.clear();
    const unbound = keeper('Farmer', { row: 25, col: 8 }, { policy: { assignedRoom: 2600 } });
    ok('a character assigned to 2600 itself is not bound through it', await unbound.passLeverPuzzle({}) === CONTINUE);
    const idle = keeper('Idler', { row: 25, col: 8 });
    idle.mode = 'idle';
    ok('an assignment does not walk an IDLE keeper into the puzzle', await idle.passLeverPuzzle({}) === CONTINUE);
    const leased = keeper('Leased', { row: 25, col: 8 }, { movementLeased: true });
    ok('an assignment yields to a movement lease', await leased.passLeverPuzzle({}) === CONTINUE);
    const ordered = keeper('Ordered', { row: 25, col: 8 }, { policy: {}, movementLeased: true });
    const h = ordered.leverPuzzleHandoff(2600, 2601);
    ok('a journey to 2601 arriving in 2600 is handed off, not failed', h?.handed_off === true && h.arrived === false
       && ordered.leverPuzzleBound?.to === 2601);
    ok('...and an ORDERED journey is worked even under a movement lease (the order is the lease\'s)',
       await ordered.passLeverPuzzle({}) === HANDLED);
    ok('no hand-off anywhere else', ordered.leverPuzzleHandoff(200, 2601) === null
       && ordered.leverPuzzleHandoff(2601, 2601) === null);
    const rebound = keeper('Reordered', { row: 25, col: 8 }, { policy: {} });
    rebound.leverPuzzleHandoff(2600, 2601);
    rebound.eatBeforeTravel = async () => { throw new Error('stop here: the journey began'); };
    await rebound.travel(200).catch(() => null);
    ok('a new journey elsewhere ends the binding', rebound.leverPuzzleBound === null);
    ordered.leaveLeverPuzzle(2601, 'down');
    ok('arriving below clears the binding', ordered.leverPuzzleBound === null && ordered.leverPuzzleState === null);
    writeFileSync(FILE, JSON.stringify(L.emptyBook()));
  }

  console.log('\nthe keeper: two pullers on one beat');
  {
    room2600.activations.length = 0; room2600.sectorHeights.clear();
    const a = keeper('Bunsen', { row: 26, col: 4 });
    const b = keeper('Beaker', { row: 26, col: 9 });
    // Each takes its lever and marks itself ready on its own passes, as two keepers would.
    await a.passLeverPuzzle({}); await b.passLeverPuzzle({});
    await a.passLeverPuzzle({}); await b.passLeverPuzzle({});
    ok('both are at their levers and neither has pulled yet', room2600.activations.length === 0
       && a.doing === 'waiting for a second lever puller');
    // Now both passes run, a few hundred ms apart, and neither calls the other.
    const t0 = Date.now();
    const pa = a.passLeverPuzzle({});
    await new Promise(r => setTimeout(r, 300));
    const pb = b.passLeverPuzzle({});
    await Promise.all([pa, pb]);
    const acts = room2600.activations;
    ok('each pulled exactly once', acts.filter(x => x.who === 'Bunsen').length === 1
       && acts.filter(x => x.who === 'Beaker').length === 1, JSON.stringify(acts.map(x => x.who)));
    const spread = acts.length === 2 ? Math.abs(acts[0].at - acts[1].at) : Infinity;
    ok('the two pulls land inside SLAM_TIME (2 s)', spread < P.windowMs, `${spread} ms apart`);
    ok('...on a beat boundary, not whenever each pass happened to run',
       acts.every(x => x.at % L.PULL_BEAT_MS < 400), acts.map(x => x.at % L.PULL_BEAT_MS).join(','));
    ok('both judged success by the door (sector 3 at 172) and walked in',
       L.inFinalBox(a.s.client.self, P) && L.inFinalBox(b.s.client.self, P));
    ok('both released their levers once the door stood open',
       Object.keys(L.readClaims({ file: FILE }).rooms['2600']?.levers ?? {}).length === 0);
    ok('the pulls are in the ledger with the beat', a.ledger.some(e => e.kind === 'lever_pull' && e.opened === true));
    ok('the whole thing took about one beat', Date.now() - t0 < 2 * L.PULL_BEAT_MS + 3000);
  }

  // ------------------------------------------------------------------ the wiring
  console.log('\nthe wiring');
  {
    const ap = readFileSync(join(here, 'm59-autopilot.mjs'), 'utf8');
    const game = readFileSync(join(here, 'm59-game.mjs'), 'utf8');
    const errand = ap.slice(ap.indexOf('  async passErrand(ctx) {'));
    ok('passErrand gives the puzzle its turn before the errands and the journey stand-down',
       errand.indexOf('this.passLeverPuzzle(ctx)') > 0
       && errand.indexOf('this.passLeverPuzzle(ctx)') < errand.indexOf('errands stand down while there is a road to walk'));
    const travel = ap.slice(ap.indexOf('  async travel(room, opts) {'), ap.indexOf('  async travel(room, opts) {') + 60000);
    ok('the keeper\'s travel hands off before it eats or walks',
       travel.indexOf('this.leverPuzzleHandoff?.(') > 0 && travel.indexOf('this.leverPuzzleHandoff?.(') < travel.indexOf('await this.eatBeforeTravel(room);'));
    ok('...and tells the Session\'s hop loop where to stop', /handOffAt: \(here, to\) => puzzleBlocksJourney\(here, to\)/.test(travel));
    const st = game.slice(game.indexOf('  async travel(toRoomNum, {'));
    ok('Session.travel honours handOffAt before planning a route',
       st.indexOf('handOffAt(Number(here.num), Number(toRoomNum))') > 0
       && st.indexOf('handOffAt(Number(here.num), Number(toRoomNum))') < st.indexOf('const route = this.world.route(toRoomNum'));
    ok('a relocation that was handed off is not counted as a miss',
       /if \(r0\.handed_off\) \{[\s\S]{0,200}return HANDLED;/.test(ap));
    ok('the lever claims book is gitignored', readFileSync(join(here, '..', '.gitignore'), 'utf8').includes('/substrate/lever-claims*.json'));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
