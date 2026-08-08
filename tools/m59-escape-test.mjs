#!/usr/bin/env node
// A CHARACTER THAT IS STILL SITTING DOWN CAN NEITHER LEAVE NOR SWING. Offline, no
// server, safe to run any time:
//
//   node tools/m59-escape-test.mjs
//
// Resting sets PFLAG_NO_MOVE and PFLAG_NO_FIGHT together (player.kod:1162), and nothing
// clears resting except standing up or logging off — not death, not being attacked. So a
// character killed mid-rest, or one a keeper sat down in a safe spot and never got back
// up, is stuck in a way that looks like something else entirely:
//
//   * escaping the Underworld — the move is bounced SILENTLY (user.kod:2988), so every
//     portal in the pentagram reads as unlit and the report blamed the braziers.
//   * fighting — the swing is refused OUT LOUD (user.kod:4679, "unable to lift your
//     weapon"), so the combat lines read as a fight going badly rather than as a fight
//     not happening.
//
// Two different refusals, so two different fixes: movement has to be pre-empted by
// standing up first, and attacking can simply be believed and recovered from.
//
// The fakes below model those server behaviours and nothing else.

import { escapeUnderworld, standUp, fight } from './m59-skills.mjs';
import { MOVEON, OF } from './m59-parse.mjs';
import { readPortalSign, UNDERWORLD_PORTALS, nearestCity } from './m59-underworld.mjs';
import { boundedSilentGo, retrySilentGo } from './m59-world.mjs';

function underworld({ resting = false, deaf = false, portals = [], unwalkable = [] } = {}) {
  const log = [];
  const names = new Map([[900, 'The Underworld'], [901, 'The Blue Sow']]);
  const objects = new Map();
  portals.forEach((p, i) => {
    const id = i + 1;
    names.set(id, p.name);
    objects.set(id, { id, flags: MOVEON.TELEPORTER, col: p.col, row: p.row, nameRsc: id });
  });
  // Each portal may carry its own sign and its own destination, which is what makes the
  // five fixed ones tellable apart at all. The defaults keep the older cases below
  // reading exactly as they did.
  const descOf = (id) => portals[id - 1]?.desc
    ?? 'Through it you glimpse the bustling bar of Familiars.';

  const c = {
    room: { id: 10, objects },
    roomNameRsc: 900,
    rsc: { get: r => names.get(r) ?? '?' },
    evSeq: 0,
    events: [],
    self: { col: 1, row: 1 },
    emit(kind, data) { const ev = { seq: ++c.evSeq, kind, ...data }; c.events.push(ev); return ev; },
    // Enough of the long poll to be honest about ordering: an event emitted DURING a
    // walk is still there afterwards, and only a cursor taken beforehand can see it.
    async waitFor({ since = 0, kinds = null } = {}) {
      const want = kinds && new Set([].concat(kinds));
      return { events: c.events.filter(e => e.seq > since && (!want || want.has(e.kind))), timedOut: false };
    },
    roomContents() { c.emit('room-contents', { room: c.room.id }); },
    // `deaf` is a character that cannot stand up however politely asked — held, webbed,
    // or a stand that got dropped. The report must stay honest about that too.
    stand() { log.push('stand'); if (!deaf) resting = false; },
    look(id) { log.push(`look ${id}`); c.emit('look', { id, description: descOf(id) }); },
    moveToSquare(col, row) { step(col, row); },
  };

  function step(col, row) {
    log.push(`move ${col},${row}`);
    if (resting) return;                      // bounced back onto the square we are on
    if (unwalkable.some(u => u.col === col && u.row === row)) return;
    c.self = { col, row };
    const p = portals.find(p => p.col === col && p.row === row);
    if (p?.live) {
      const room = p.arriveRoom ?? 20;
      const name = p.arriveName ?? 'The Blue Sow';
      names.set(902, name);
      c.room = { id: room, objects: new Map() };
      c.roomNameRsc = 902;
      c.emit('room-entered', { room, roomName: name });
    }
  }

  const s = {
    need: () => c,
    pacer: { submit: async (_kind, fn) => fn() },
    world: {
      room: { name: 'The Underworld' },
      reach: () => ({ reachable: true, steps: 3 }),
      approachSquare: (col, row) => ({ col: col - 1, row, steps: 1 }),
    },
    // The real one: a step onto a live portal leaves the room, so it returns
    // arrived:false with left_room set, having done exactly what was wanted.
    async walkTo(col, row) {
      const wasIn = c.room.id;
      step(col, row);
      if (c.room.id !== wasIn) return { arrived: false, left_room: true, note: 'a step crossed the room edge' };
      if (c.self.col === col && c.self.row === row) return { arrived: true, position: { col, row } };
      return { arrived: false, reason: 'blocked — every heading refused, at every reach tried' };
    },
  };
  return { s, log };
}

import { spreadEdges } from './m59-world.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// Died sitting down. This is the whole bug: without the stand, not one of these moves
// lands and every portal in the pentagram reads as dead.
{
  const { s, log } = underworld({ resting: true, portals: [{ name: 'portal', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s);
  ok('a resting character still gets out', r.left === true, JSON.stringify(r));
  ok('stands up before it moves a step', log[0] === 'stand', JSON.stringify(log));
  ok('says so, so the caller can rule posture out', r.stood_up === true);
  ok('names where it came out', r.arrived_in === 'The Blue Sow', r.arrived_in);
}

// The portal fires on the last step of the walk, so walkTo reports it as a walk that
// never arrived. Believing that is how a working portal gets logged as a broken one.
{
  const { s } = underworld({ portals: [{ name: 'rip in space', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s);
  ok('a portal that fires mid-walk counts as leaving', r.left === true, JSON.stringify(r));
  ok('and says which one did it', r.via === 'rip in space', r.via);
}

// A real unlit portal: we get onto its square and nothing happens. This diagnosis is
// correct and must survive.
{
  const { s } = underworld({ portals: [{ name: 'portal', col: 5, row: 5, live: false }] });
  const r = await escapeUnderworld(s);
  ok('a dead portal is still called dead', r.left === false && /none of the teleporters/.test(r.reason));
  ok('and still blames the brazier', /brazier/.test(r.tried[0].why), r.tried[0].why);
}

// Never got there. Whatever is wrong, it is not the brazier — and saying it is sends the
// caller hunting for something to activate that was never the problem.
{
  const { s } = underworld({ portals: [{ name: 'portal', col: 5, row: 5, live: true }],
                             unwalkable: [{ col: 5, row: 5 }] });
  const r = await escapeUnderworld(s);
  ok('an unreached portal is not reported as unlit', !/brazier/.test(r.tried[0].why), r.tried[0].why);
  ok('it says it never got onto the square', /never got onto its square/.test(r.tried[0].why));
  ok('and the note does not blame the pentagram', !/dead until their brazier/.test(r.note), r.note);
}

// A character that cannot stand up at all — held, webbed, or a stand that went missing.
// The answer must not become "the portals are dead".
{
  const { s, log } = underworld({ resting: true, deaf: true,
                                  portals: [{ name: 'portal', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s);
  ok('a character that cannot move does not blame the portals', !/brazier/.test(r.tried[0].why), r.tried[0].why);
  ok('and we did try to stand it up', log.includes('stand'));
}

// Waiting by the shifting portal for a named city, from a sitting start.
{
  const { s, log } = underworld({ resting: true, portals: [{ name: 'rip in space', col: 5, row: 5, live: true }] });
  const r = await escapeUnderworld(s, { city: 'Tos', maxSeconds: 10 });
  ok('the city wait stands up too', log[0] === 'stand', JSON.stringify(log));
  ok('and steps on when it reads right', r.left === true, JSON.stringify(r));
}

// Nothing to walk onto. The stand still happens — it is the cheapest thing in the room
// and the answer is more trustworthy for it.
{
  const { s, log } = underworld({ resting: true, portals: [] });
  const r = await escapeUnderworld(s);
  ok('an empty room still reports honestly', r.left === false && /no teleporter/.test(r.reason));
  ok('having stood up anyway', log[0] === 'stand' && r.stood_up === true);
}

// The helper on its own, since anything else that has to move may want it.
{
  const { s, log } = underworld({ resting: true });
  await standUp(s);
  ok('standUp sends exactly one stand', log.filter(x => x === 'stand').length === 1, JSON.stringify(log));
}

// ------------------------------------------------------ which door, and to where
//
// The Underworld has six exits and they are not interchangeable. Everything you were
// carrying is on the floor where you died, so coming out at the wrong end of the world
// is the expensive half of dying. These check that a named city takes the portal that
// goes there — rather than standing at the anomaly hoping, which is what it used to do.

// The real signs, verbatim from uworld.kod:31-35 and hellport.kod:23-33.
const SIGN = {
  tos:      'Looking in the portal, you see the bustling bar of Familiars.',
  jasper:   'The quiet Yonder Inn of Jasper lies through this portal.',
  cornoth:  'A lazy inn next to a quiet creek rests on the other side of this portal.',
  barloque: 'Gazing into the portal, you see an expensive inn in a bustling city.',
  marion:   'Through the portal, you see the laid-back atmosphere of the Limping Toad.',
  ripJasper:  'Gazing through the anomaly, you can see the quiet Yonder Inn of Jasper.',
  ripBarloque: 'Gazing through the anomaly, you can see the fine Brownstone Inn in a bustling Barloque.',
};
const INN = { Jasper: 'Yonder Inn of Jasper', Tos: 'Familiars', Barloque: 'Brownestone Inn' };

console.log('\nreading a portal sign');
{
  ok('a fixed Tos portal reads as Tos', readPortalSign(SIGN.tos).city === 'Tos');
  ok('and is marked stable, not shifting', readPortalSign(SIGN.tos).stable === true);
  // The two the old table could not read at all. Its regexes were the RIP's wording,
  // and these two portals word the same destination completely differently.
  ok('the fixed Cornoth portal reads as Cornoth', readPortalSign(SIGN.cornoth).city === 'Cornoth',
     JSON.stringify(readPortalSign(SIGN.cornoth)));
  ok('the fixed Barloque portal reads as Barloque', readPortalSign(SIGN.barloque).city === 'Barloque',
     JSON.stringify(readPortalSign(SIGN.barloque)));
  ok('the rip reads its city too', readPortalSign(SIGN.ripBarloque).city === 'Barloque');
  ok('but is marked shifting, because the answer expires',
     readPortalSign(SIGN.ripBarloque).shifting === true && readPortalSign(SIGN.ripBarloque).stable === false);
  ok('an unreadable sign is null, not a guess', readPortalSign('a plain grey arch').city === null);
}

console.log('\nthe five fixed portals');
{
  ok('there are five', UNDERWORLD_PORTALS.length === 5);
  ok('each names a real destination room',
     UNDERWORLD_PORTALS.every(p => Number.isFinite(p.inn)));
  ok('Ko\'catan is NOT among them, because it is not in the pentagram',
     !UNDERWORLD_PORTALS.some(p => /ko/i.test(p.city)));
  // kod is 1-based and the client is 0-based; getting this backwards would put every
  // portal one square from where it is.
  const tos = UNDERWORLD_PORTALS.find(p => p.city === 'Tos');
  ok('kod coordinates are converted for the client', tos.kodCol === 7 && tos.clientCol === 6);
}

console.log('\nasking for a city takes that city\'s own portal');
{
  const { s, log } = underworld({ portals: [
    { name: 'portal', col: 6, row: 2, live: true, desc: SIGN.tos,
      arriveRoom: 52, arriveName: INN.Tos },
    { name: 'portal', col: 1, row: 20, live: true, desc: SIGN.jasper,
      arriveRoom: 370, arriveName: INN.Jasper },
    { name: 'rip in space', col: 9, row: 9, live: true, desc: SIGN.ripBarloque },
  ] });
  const r = await escapeUnderworld(s, { city: 'Jasper' });
  ok('it gets out', r.left === true, JSON.stringify(r));
  ok('in the city that was asked for', r.city === 'Jasper', JSON.stringify(r));
  ok('by the fixed portal, not the rip', /fixed Jasper/.test(r.via || ''), r.via);
  ok('and lands in that city\'s inn', r.arrived_in === INN.Jasper);
  // The whole point. The old code polled the anomaly for up to three minutes for this.
  ok('the rip was never polled at all', !log.includes('look 3'), JSON.stringify(log));
  ok('and it says the result is repeatable rather than lucky', /repeatable/.test(r.note || ''), r.note);
}

console.log('\nthe wanted city\'s portal is one of the unlit ones');
{
  const { s } = underworld({ portals: [
    { name: 'portal', col: 1, row: 20, live: false, desc: SIGN.jasper },
    { name: 'portal', col: 6, row: 2, live: true, desc: SIGN.tos,
      arriveRoom: 52, arriveName: INN.Tos },
  ] });
  const r = await escapeUnderworld(s, { city: 'Jasper' });
  ok('it still gets the character out', r.left === true, JSON.stringify(r));
  ok('rather than leaving it in the Underworld to be right', r.city === 'Tos');
  ok('and says plainly that this is not what was asked for',
     r.got_what_was_wanted === false && r.wanted === 'Jasper', JSON.stringify(r));
  ok('naming the corpse problem, which is the reason anyone cares',
     /corpse/.test(r.note || ''), r.note);
  ok('and why the wanted portal could not be used',
     /unlit/.test(JSON.stringify(r.could_not_use)), JSON.stringify(r.could_not_use));
}

console.log('\nwhere it died picks the city on its own');
{
  // Room 568, the Lake of Jala's Song — three rooms from Jasper and eleven from
  // Barloque. Nobody should have to know that; that is what the room graph is for.
  ok('the graph knows which city that is', nearestCity(568).city === 'Jasper',
     JSON.stringify(nearestCity(568)));
  const { s } = underworld({ portals: [
    { name: 'portal', col: 1, row: 20, live: true, desc: SIGN.jasper,
      arriveRoom: 370, arriveName: INN.Jasper },
    { name: 'portal', col: 20, row: 29, live: true, desc: SIGN.barloque,
      arriveRoom: 106, arriveName: INN.Barloque },
  ] });
  const r = await escapeUnderworld(s, { nearestTo: 568 });
  ok('it comes out nearest to where it died', r.city === 'Jasper', JSON.stringify(r));
  ok('and says that is why', /nearest to where it died/.test(r.chosen_because || ''), r.chosen_because);
  ok('carrying the distance, so the walk back is known before setting off',
     r.hops_from_death === 3, JSON.stringify(r));
}

console.log('\na room with no city, and a city with no portal');
{
  // Raza is one-way — the museum portal goes out and nothing comes back — so no path
  // exists and none should be invented.
  const raza = nearestCity(1012);
  ok('an unreachable room gets null, not a default', raza.city === null, JSON.stringify(raza));
  ok('and explains itself', /one-way|no path/.test(raza.why || ''), raza.why);

  const { s } = underworld({ portals: [
    { name: 'portal', col: 6, row: 2, live: true, desc: SIGN.tos, arriveRoom: 52, arriveName: INN.Tos },
  ] });
  const r = await escapeUnderworld(s, { city: "Ko'catan" });
  ok('asking for Ko\'catan still gets you out', r.left === true, JSON.stringify(r));
  ok('and explains that it is death-only, not merely absent today',
     /died in Ko'catan/.test(JSON.stringify(r.could_not_use)), JSON.stringify(r.could_not_use));
}

console.log('\nno city asked for still behaves exactly as it did');
{
  const { s, log } = underworld({ portals: [
    { name: 'portal', col: 5, row: 5, live: true, desc: SIGN.tos },
  ] });
  const r = await escapeUnderworld(s);
  ok('it takes the nearest working portal', r.left === true, JSON.stringify(r));
  ok('without looking at anything first — no city, no question to answer',
     !log.some(l => l.startsWith('look')), JSON.stringify(log));
}

// ------------------------------------------------------------------------ fighting
//
// The same posture, the other half of the flag. A monster standing next to us, a
// character sitting down, and a server that answers every swing with the same line.

const REFUSED = 'You find yourself unable to lift your weapon.';

function safeSpot({ resting = false, deaf = false, hits = 3 } = {}) {
  const log = [];
  const names = new Map([[500, 'The Ledge'], [1, 'mummy']]);
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 4, row: 5, x: 288, y: 352, nameRsc: 1 };
  const objects = new Map([[1, foe], [99, { id: 99, flags: 0, col: 5, row: 5, nameRsc: 1 }]]);

  const c = {
    selfId: 99,
    self: { col: 5, row: 5 },
    room: { id: 30, objects },
    roomNameRsc: 500,
    rsc: { get: r => names.get(r) ?? '?' },
    lookup: r => names.get(r) ?? '?',
    inventory: [],
    evSeq: 0,
    vitals: () => ({ health: { value: 40, max: 40 }, vigor: { value: 200, max: 200, scale_max: 200 } }),
    stats: async () => {},
    async waitFor() { return { events: [], timedOut: true }; },
    roomContents() {},
    stand() { log.push('stand'); if (!deaf) resting = false; },
  };

  const s = {
    need: () => c,
    pacer: { submit: async (_kind, fn) => fn() },
    world: { approachSquare: () => null },
    // The one rule: a resting character's swings are refused, and the server says so.
    async attackRounds(id, swings) {
      log.push(`swing x${swings}`);
      if (resting) return { messages: [REFUSED], vitals: c.vitals() };
      if (--hits <= 0) objects.delete(id);
      return { messages: ['You hit the mummy.'], vitals: c.vitals() };
    },
    async lootFloor() { return { taken: [], refused: [], carrying: [] }; },
  };
  return { s, log };
}

// Sat down in a safe spot, told to fight. The refusals are not misses.
{
  const { s, log } = safeSpot({ resting: true });
  const r = await fight(s, { holdPosition: true, equip: false, loot: false, rounds: 12 });
  ok('a refused swing gets us back on our feet', log.includes('stand'), JSON.stringify(log));
  ok('and the fight then actually happens', r.killed === true, JSON.stringify(r));
  ok('it says a round went to standing up', /resting/.test(r.stood_up || ''), r.stood_up);
  ok('the stand comes after the round that was refused', log.indexOf('stand') === 1, JSON.stringify(log));
}

// Standing did not help: Hold, Dazzle, Blind, a DM freeze. Swinging eleven more times
// is eleven more refusals — stop and name what it might be.
{
  const { s, log } = safeSpot({ resting: true, deaf: true });
  const r = await fight(s, { holdPosition: true, equip: false, loot: false, rounds: 12 });
  ok('a flag standing cannot clear stops the fight', r.could_not_swing === true, JSON.stringify(r));
  ok('it does not spend the whole leash on it', r.rounds === 2, 'rounds=' + r.rounds);
  ok('and it names the other causes', /Hold, Dazzle, Blind/.test(r.note || ''), r.note);
  ok('having tried standing exactly once', log.filter(x => x === 'stand').length === 1, JSON.stringify(log));
}

// Nothing wrong with us. The recovery must not fire, and must not cost a round.
{
  const { s, log } = safeSpot();
  const r = await fight(s, { holdPosition: true, equip: false, loot: false, rounds: 12 });
  ok('an ordinary fight sends no stand at all', !log.includes('stand'), JSON.stringify(log));
  ok('and takes exactly the rounds it needed', r.killed === true && r.rounds === 3, 'rounds=' + r.rounds);
  ok('and claims no stand it did not do', r.stood_up === undefined);
}


console.log('\na silent go request gets one bounded retry');
{
  ok('the first silent request is retried',
     retrySilentGo({ attempt: 1, entered: false, messages: [] }) === true);
  ok('silence after the second request is final',
     retrySilentGo({ attempt: 2, entered: false, messages: [] }) === false);
  ok('a room transition is never repeated',
     retrySilentGo({ attempt: 1, entered: true, messages: [] }) === false);
  ok('a spoken refusal is authoritative and is not repeated',
     retrySilentGo({ attempt: 1, entered: false, messages: ['The door is locked.'] }) === false);
}


console.log('\nthe bounded go sequence preserves room and control evidence');
{
  const silentThenEntry = async () => {
    let sequence = 0, sends = 0;
    const result = await boundedSilentGo({
      sequence: () => sequence,
      eventsSince: () => [],
      send: async () => { sends++; },
      waitForEntry: async () => sends === 2
        ? { kind: 'room-entered', roomName: 'Beyond the door' }
        : null,
    });
    return { result, sends };
  };
  const retried = await silentThenEntry();
  ok('one silent request is retried and the second entry is returned',
     retried.sends === 2 && retried.result.entered?.roomName === 'Beyond the door',
     JSON.stringify(retried));

  let lateSequence = 0, lateSends = 0;
  const lateEvents = [];
  const late = await boundedSilentGo({
    sequence: () => lateSequence,
    eventsSince: since => lateEvents.filter(event => event.sequence > since),
    send: async () => { lateSends++; },
    waitForEntry: async () => {
      lateEvents.push({ kind: 'room-entered', roomName: 'Late room', sequence: ++lateSequence });
      return null; // model a packet arriving just after the wait reports timeout
    },
  });
  ok('a late room entry prevents the second request',
     lateSends === 1 && late.entered?.roomName === 'Late room', JSON.stringify(late));

  let refusalSequence = 0, refusalSends = 0;
  const refusalEvents = [];
  const refused = await boundedSilentGo({
    sequence: () => refusalSequence,
    eventsSince: since => refusalEvents.filter(event => event.sequence > since),
    send: async () => { refusalSends++; },
    waitForEntry: async () => {
      refusalEvents.push({ text: 'The door is locked.', sequence: ++refusalSequence });
      return null;
    },
  });
  ok('a spoken refusal prevents the second request and is returned',
     refusalSends === 1 && refused.messages[0] === 'The door is locked.', JSON.stringify(refused));

  let cancelled = false, cancelledSends = 0;
  const stopped = await boundedSilentGo({
    sequence: () => 0,
    eventsSince: () => [],
    cancelled: () => cancelled,
    send: async () => { cancelledSends++; },
    waitForEntry: async () => { cancelled = true; return null; },
  });
  ok('control cancellation between attempts prevents the retry',
     cancelledSends === 1 && stopped.cancelled === true, JSON.stringify(stopped));
}


// A WIDE BOUNDARY IS ONE EXIT, NOT ONE SQUARE.
//
// StandardLeaveDir fires wherever the condition lets you step past the edge, so every
// standable square on that wall crosses it. exits() used to find them all and then keep
// only the nearest, so "every square for that exit refused (2 tried)" was being reported
// about boundaries fifty squares wide — and that one line killed the outfitting trip,
// four money transfers and the reagent bridging in a single afternoon.
console.log('\nan edge is a wall, and every square on it crosses');
{
  const edge = {
    kind: 'edge', direction: 'west', to: 564, stand_on: { col: 1, row: 29 }, steps_away: 11,
    alternates: [{ col: 1, row: 12, steps: 20 }, { col: 1, row: 40, steps: 18 }],
  };
  const spread = spreadEdges([edge]);
  ok('the nearest square is still tried first', spread[0].stand_on.row === 29);
  ok('and every alternate becomes a candidate of its own', spread.length === 3,
     JSON.stringify(spread.map(e => e.stand_on)));
  ok('each carries its own step count, so the walk budget scales with it',
     spread[1].steps_away === 20 && spread[2].steps_away === 18);
  ok('alternates are marked, so a caller can tell them from a declared exit',
     spread[1].from_alternate === true && spread[0].from_alternate === undefined);
  ok('and they carry no alternates of their own, which would expand for ever',
     spread[1].alternates === undefined);
  ok('everything else about the exit survives the copy',
     spread[1].to === 564 && spread[1].direction === 'west' && spread[1].kind === 'edge');
  const plain = { kind: 'go', to: 200, stand_on: { col: 5, row: 5 } };
  ok('an exit with no alternates is passed through unchanged', spreadEdges([plain]).length === 1);
  ok('and several exits all still appear', spreadEdges([edge, plain]).length === 4);
  ok('empty and missing input do not throw',
     spreadEdges([]).length === 0 && spreadEdges(undefined).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
