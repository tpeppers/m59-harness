#!/usr/bin/env node
// AN ISLAND DEATH TAKES THE RIP HOME. Offline: no socket, no roster, nothing written.
//
//   node tools/m59-kocatan-rip-test.mjs
//
// Operator, 2026-10-27: "have deaths on the island by default immediately use the rip-in-space
// portal that returns them to the 'aerie guest house' because going slower or taking a side
// portal guarantees getting stuck at the mainland and having to travel back to the island as a
// special trip, which is devastating to their farming". That day all three island deaths came
// out on the mainland: Beaker (2115) at Familiars, Scooter (2115) at the Limping Toad, and
// Scooter (2125, mid-journey) at Cibilo Creek four seconds after dying — a journey's own escape,
// which was never told where it died and took the nearest portal.
//
// The fake Underworld below models the server and nothing else: the five pentagram portals on
// their real squares (uworld.kod:649-662), the HellPortal on r10c6 (uworld.kod:631), and
// PFLAG2_KOCATAN_DEATH as hellport.kod uses it — a flagged viewer's LOOK shows "the sturdy,
// island fortress of Ko'catan", a flagged player stepping on it lands in RID_KOC_INN 2001 and
// the flag clears; anyone else reads and reaches the rip's current mainland inn.
//
// What this pins:
//   1. which deaths count — the server's GetRegion rule, not a guess;
//   2. where the death room comes from — caller, then the session's record of THIS visit;
//   3. a Ko'catan death walks to the rip (no archway), LOOKs first, and lands in 2001;
//   4. a mainland death keeps exactly the old choice;
//   5. a rip that no longer names Ko'catan (flag gone) falls back, without a minute of polling;
//   6. a rip that reads the island but cannot be reached holds out (keeper-bounded), then out is out;
//   7. the real keeper rung (Autopilot.passUnderworld) and the real session observer.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

delete process.env.M59_KOCATAN_DEATH_RIP;
const UW = await import('./m59-underworld.mjs');
const { escapeUnderworld } = await import('./m59-skills.mjs');
const { MOVEON } = await import('./m59-parse.mjs');

const HELL = { row: 10, col: 6 };
const RIP_SAYS = {
  island: "Gazing through the anomaly, you can see the sturdy, island fortress of Ko'catan.",
  Tos: 'Gazing through the anomaly, you can see the bustling bar of Familiars.',
  Jasper: 'Gazing through the anomaly, you can see the quiet Yonder Inn of Jasper.',
};
const CORPSE_DESC = "This rip in space leads back to someone's body.  The rip will only work for the former " +
                    'inhabitant of that body.';
const KOC_INN = { num: 2001, name: 'The Aerie Guest House' };

// ------------------------------------------------------------------ the fake Underworld
//
// The body starts at r4c24, beside the Cornoth portal, so a nearest-portal escape comes out at
// Cibilo Creek — what Scooter's journey escape did at 16:20:10 — and the rip is the far door.
function underworld({ flagged = false, ripPointsAt = 'Tos', self = { col: 24, row: 4 },
                      unwalkable = [], unlit = [], corpsePortal = null, deaf = false,
                      lastDeathRoom = undefined } = {}) {
  const log = [];
  const names = new Map([[900, 'The Underworld']]);
  const objects = new Map();
  const table = [];
  let id = 100;
  const add = (o) => {
    const oid = ++id;
    names.set(oid, o.name);
    const obj = { id: oid, flags: MOVEON.TELEPORTER, col: o.col, row: o.row,
                  x: o.col * 64 + 32, y: o.row * 64 + 32, nameRsc: oid };
    objects.set(oid, obj);
    table.push({ ...o, id: oid, obj });
    return obj;
  };
  for (const p of UW.UNDERWORLD_PORTALS)
    add({ kind: 'fixed', city: p.city, name: 'portal', col: p.objectCol, row: p.objectRow,
          desc: p.desc, dest: { num: p.inn, name: p.innName }, live: !unlit.includes(p.city) });
  // A Portal of Life's CorpsePortal can stand in the Underworld too, under the same name.
  if (corpsePortal)
    add({ kind: 'corpse', name: 'rip in space', col: corpsePortal.col, row: corpsePortal.row,
          desc: CORPSE_DESC, dest: { num: 2115, name: 'Outside the Guard Tower' }, live: true });
  const rip = add({ kind: 'rip', name: 'rip in space', col: HELL.col, row: HELL.row, live: true });

  const ripDest = () => flagged ? KOC_INN
    : { num: UW.CITY_INNS[ripPointsAt].inn, name: UW.CITY_INNS[ripPointsAt].innName };
  const descOf = (oid) => {
    const t = table.find(x => x.id === oid);
    if (!t) return '';
    if (t.kind === 'rip') return flagged ? RIP_SAYS.island : RIP_SAYS[ripPointsAt];
    return t.desc;
  };

  const c = {
    room: { id: 6, objects }, roomNameRsc: 900,
    rsc: { get: r => names.get(r) ?? '?' },
    evSeq: 0, events: [], self: { ...self },
    emit(kind, data) { const ev = { seq: ++c.evSeq, kind, ...data }; c.events.push(ev); return ev; },
    async waitFor({ since = 0, kinds = null } = {}) {
      const want = kinds && new Set([].concat(kinds));
      return { events: c.events.filter(e => e.seq > since && (!want || want.has(e.kind))), timedOut: false };
    },
    roomContents() { c.emit('room-contents', { room: c.room.id }); },
    stand() { log.push('stand'); },
    look(oid) { log.push(`look ${oid}`); if (!deaf) c.emit('look', { id: oid, description: descOf(oid) }); },
    moveToSquare(col, row) { step(col, row); },
    face() { return true; },
  };

  const s = {
    need: () => c,
    pacer: { submit: async (_kind, fn) => fn() },
    world: {
      room: { num: 1, name: 'The Underworld' },
      reach: (col, row) => ({ reachable: true,
        steps: Math.round(Math.hypot(col - c.self.col, row - c.self.row)) }),
      approachSquare: (col, row) => ({ col: col + 1, row, steps: Math.max(1,
        Math.round(Math.hypot(col + 1 - c.self.col, row - c.self.row))) }),
    },
    ...(lastDeathRoom !== undefined ? { lastDeathRoom } : {}),
    async walkTo(col, row) {
      const wasIn = c.room.id;
      step(col, row);
      if (c.room.id !== wasIn) return { arrived: false, left_room: true, note: 'a step crossed the room edge' };
      if (c.self.col === col && c.self.row === row) return { arrived: true, position: { col, row } };
      return { arrived: false, reason: 'blocked — every heading refused, at every reach tried' };
    },
    async step(col, row) {
      const wasIn = c.room.id, before = { ...c.self };
      step(col, row);
      return { moved: c.room.id !== wasIn || c.self.col !== before.col || c.self.row !== before.row,
               left_room: c.room.id !== wasIn, position: { ...c.self } };
    },
    async stepFine(x, y) { return this.step(Math.floor(x / 64), Math.floor(y / 64)); },
  };

  const landed = [];
  function step(col, row) {
    log.push(`move ${col},${row}`);
    if (c.room.id !== 6) return;                         // already out
    if (unwalkable.some(u => u.col === col && u.row === row)) return;
    c.self = { col, row };
    const t = table.find(x => x.col === col && x.row === row);
    if (!t || !t.live) return;
    let dest;
    if (t.kind === 'rip') {
      dest = ripDest();
      if (flagged) flagged = false;                       // hellport.kod TeleportSomething clears it
    } else dest = t.dest;
    landed.push({ via: t.kind === 'fixed' ? `fixed ${t.city}` : t.kind, dest: dest.num });
    names.set(902, dest.name);
    c.room = { id: 5000 + dest.num, objects: new Map() };
    c.roomNameRsc = 902;
    s.world.room = { num: dest.num, name: dest.name };
    c.emit('room-entered', { room: c.room.id, roomName: dest.name });
  }

  const fixedSquares = UW.UNDERWORLD_PORTALS.map(p => `${p.objectCol},${p.objectRow}`);
  const steppedOnFixed = () => log.some(l => l.startsWith('move ') && fixedSquares.includes(l.slice(5)));
  const looks = () => log.filter(l => l.startsWith('look ')).map(l => Number(l.slice(5)));
  return { s, c, log, rip, landed, table, steppedOnFixed, looks,
           get flagged() { return flagged; } };
}

// ================================================================== 1. which deaths count
console.log('which deaths count — the server\'s GetRegion rule (room.kod:928, guildh12/13)');
{
  for (const n of [2000, 2001, 2005, 2013, 2115, 2125, 2499, 705, 713, '2115'])
    ok(`room ${n} is a Ko'catan death`, UW.diedInKocatan(n) === true);
  for (const n of [2500, 2599, 1999, 1, 584, 568, 599, 52, null, undefined, NaN, 'the island'])
    ok(`room ${String(n)} is not`, UW.diedInKocatan(n) === false);
  ok('the rip lands in the Aerie Guest House, 2001', UW.KOCATAN_RIP_LANDING === 2001);
  ok("Ko'catan is spelled several ways and is one city",
     ["Ko'catan", 'kocatan', 'Ko’catan', ' KO\'CATAN '].every(UW.isKocatanCity) && !UW.isKocatanCity('Tos'));
  ok('on by default', UW.kocatanDeathRipEnabled({}) === true);
  ok('M59_KOCATAN_DEATH_RIP=0 turns it off', UW.kocatanDeathRipEnabled({ M59_KOCATAN_DEATH_RIP: '0' }) === false
     && UW.kocatanDeathRipEnabled({ M59_KOCATAN_DEATH_RIP: 'off' }) === false);
}

// ================================================================== 2. where the death room comes from
console.log('\nwhere the death room comes from');
{
  const now = 1_800_000_000_000;
  const fatal = (room, at) => ({ at, kind: 'stat', name: 'health', value: 0, room });
  const said = (room, at) => ({ at, kind: 'message', room,
    text: 'You are dead, poor soul.  Go now, and take revenge on a dragonfly!' });
  const hit = UW.deathRoomOnEntry({ evidence: { records: [{ id: 'a', events: [fatal(2115, now - 2000)] }] },
                                   previous: { num: 2013 }, at: now });
  ok('the fatal socket evidence names the room (the post-mortem\'s own source)',
     hit.num === 2115 && hit.source === 'socket_fatal_health', JSON.stringify(hit));
  const prev = UW.deathRoomOnEntry({ evidence: { records: [] }, previous: { num: 2125 }, at: now });
  ok('no evidence: the room observed before the Underworld, labelled as such',
     prev.num === 2125 && /before the Underworld/.test(prev.source), JSON.stringify(prev));
  ok('a previous room of the Underworld itself is no answer',
     UW.deathRoomOnEntry({ previous: { num: 1 }, at: now }).num === null);
  ok('nothing at all is null, never a default',
     UW.deathRoomOnEntry({ at: now }).num === null);
  const old = UW.deathRoomOnEntry({ evidence: { records: [{ id: 'a', events: [fatal(2115, now - 600_000)] }] }, at: now });
  ok('an old death outside the window is not this one', old.num === null, JSON.stringify(old));
  const torn = UW.deathRoomOnEntry({ evidence: { records: [{ id: 'a', events: [fatal(2115, now - 3000)] },
                                                           { id: 'b', events: [fatal(584, now - 2000)] }] },
                                     previous: { num: 2125 }, at: now });
  ok('evidence naming two rooms is not trusted (falls to the observed room)', torn.num === 2125, JSON.stringify(torn));
  ok('a fatal row in room 1 is ignored', UW.deathRoomOnEntry({
    evidence: { records: [{ id: 'a', events: [fatal(1, now - 1000)] }] }, at: now }).num === null);
  ok('the snapshot shape (sessions) reads the same',
     UW.deathRoomOnEntry({ evidence: { sessions: [{ id: 'a', events: [said(2125, now - 500)] }] }, at: now }).num === 2125);

  const s = { lastDeathRoom: { num: 2125, source: 'socket_personal_death' } };
  ok('an explicit diedIn wins', UW.underworldDeathRoom(s, { diedIn: 584, nearestTo: 2115 }).num === 584);
  ok('then nearest_to, which every caller fills with where it died',
     UW.underworldDeathRoom(s, { nearestTo: 2115 }).num === 2115);
  const fromSession = UW.underworldDeathRoom(s, {});
  ok('then the session\'s own record of this visit', fromSession.num === 2125 && /^session/.test(fromSession.source));
  ok('and nothing is null', UW.underworldDeathRoom({}, {}).num === null);
}

// ================================================================== the rip, not its namesake
console.log('\nwhich "rip in space" is the HellPortal');
{
  const nameOf = o => o.name;
  const corpse = { name: 'rip in space', row: 14, col: 12 };
  const hell = { name: 'rip in space', row: 10, col: 6 };
  const portal = { name: 'portal', row: 3, col: 7 };
  ok('the one on r10c6 (uworld.kod:631), whatever order they arrive in',
     UW.pickRip([portal, corpse, hell], nameOf) === hell && UW.pickRip([hell, corpse], nameOf) === hell);
  ok('a lone rip anywhere is still the rip (custom scenes)', UW.pickRip([portal, corpse], nameOf) === corpse);
  ok('no rip is null', UW.pickRip([portal], nameOf) === null);
}

// ================================================================== 3. a Ko'catan death
console.log('\na Ko\'catan death walks to the rip and lands in 2001');
{
  const u = underworld({ flagged: true });
  const r = await escapeUnderworld(u.s, { nearestTo: 2115, maxSeconds: 60 });
  ok('out', r.left === true, JSON.stringify(r));
  ok('through the rip', r.via === 'the rip in space' && u.landed[0]?.via === 'rip', JSON.stringify(u.landed));
  ok('landing in the Aerie Guest House, 2001', u.landed[0]?.dest === 2001 && r.arrived_in === KOC_INN.name);
  ok('which it reports as Ko\'catan, wanted and got', r.city === "Ko'catan" && r.got_what_was_wanted === true);
  ok('no pentagram portal was ever stepped on', !u.steppedOnFixed(), JSON.stringify(u.log));
  ok('the first thing it LOOKED at was the rip — no portal identified first',
     u.looks()[0] === u.rip.id && u.looks().every(id => id === u.rip.id), JSON.stringify(u.looks()));
  ok('it stood next to the rip before stepping on (never across the room)',
     u.log.includes(`move ${HELL.col + 1},${HELL.row}`) && u.log.at(-1) === `move ${HELL.col},${HELL.row}`,
     JSON.stringify(u.log));
  ok('the record says why', /died in Ko'catan \(room 2115\)/.test(r.chosen_because)
     && r.kocatan?.verdict === 'took_it' && r.kocatan?.died_in_room === 2115, JSON.stringify(r.kocatan));
  ok('and the server cleared the flag on the way through', u.flagged === false);
}
{
  // Scooter, 16:20:06: a journey died on the road and escaped on its own — `skills.escapeUnderworld
  // (this, {})` from Session.travel's leaveTheUnderworld, with nothing passed. The session's own
  // record of this visit is what tells it.
  const u = underworld({ flagged: true, lastDeathRoom: { num: 2125, source: 'socket_personal_death' } });
  const r = await escapeUnderworld(u.s, {});
  ok('a journey\'s bare escape, after a death in 2125, still takes the rip to 2001',
     r.left && u.landed[0]?.via === 'rip' && u.landed[0]?.dest === 2001, JSON.stringify(u.landed));
  ok('and says where the death room came from', /^session/.test(r.kocatan?.death_room_from ?? ''), JSON.stringify(r.kocatan));

  const was = underworld({ flagged: true, lastDeathRoom: { num: 2125, source: 'socket_personal_death' } });
  const old = await escapeUnderworld(was.s, { kocatanRip: false });
  ok('(the old code, on the same body: the nearest portal, a mainland inn — what Scooter got)',
     old.left && was.landed[0]?.via !== 'rip' && was.landed[0]?.dest !== 2001, JSON.stringify(was.landed));
}
{
  // The guild halls the server counts as island (guildh12.kod, guildh13.kod).
  const u = underworld({ flagged: true });
  const r = await escapeUnderworld(u.s, { diedIn: 713 });
  ok('a death in guild hall 713 (region Ko\'catan) takes the rip too', r.left && u.landed[0]?.dest === 2001);
}
{
  // A Portal of Life's CorpsePortal, nearer than the HellPortal, under the same name.
  const u = underworld({ flagged: true, corpsePortal: { col: 22, row: 5 } });
  const r = await escapeUnderworld(u.s, { nearestTo: 2115 });
  ok('with a CorpsePortal beside us, it reads and takes the HellPortal, not the corpse rip',
     r.left && u.landed[0]?.via === 'rip' && u.landed[0]?.dest === 2001
     && u.looks().every(id => id === u.rip.id), JSON.stringify({ landed: u.landed, looks: u.looks() }));
}
{
  // An explicit order for another city outranks the default.
  const u = underworld({ flagged: true });
  const r = await escapeUnderworld(u.s, { city: 'Jasper', nearestTo: 2115 });
  ok('an explicit city (Jasper) is obeyed, and the rip is not even read',
     r.left && u.landed[0]?.via === 'fixed Jasper' && !u.looks().includes(u.rip.id), JSON.stringify(u.landed));
  const v = underworld({ flagged: true });
  await escapeUnderworld(v.s, { nearestTo: 2115, allowRip: false });
  ok('allowRip:false skips the island branch (the rip is never read)', !v.looks().includes(v.rip.id),
     JSON.stringify(v.looks()));
}
{
  const prior = process.env.M59_KOCATAN_DEATH_RIP;
  process.env.M59_KOCATAN_DEATH_RIP = '0';
  const u = underworld({ flagged: true, lastDeathRoom: { num: 2115, source: 'x' } });
  const r = await escapeUnderworld(u.s, {});
  ok('M59_KOCATAN_DEATH_RIP=0 restores the old nearest-portal choice', r.left && u.landed[0]?.via !== 'rip',
     JSON.stringify(u.landed));
  if (prior === undefined) delete process.env.M59_KOCATAN_DEATH_RIP; else process.env.M59_KOCATAN_DEATH_RIP = prior;
}

// ================================================================== 4. a mainland death
console.log('\na mainland death keeps the old choice');
{
  // 568 is nearest Jasper (m59-escape-test.mjs). The flag is SET here on purpose: by body.kod as
  // written a decayed corpse never clears it, so a mainland death after an island one can see the
  // island on the rip. The death room gates the look, so it must not matter.
  const run = async (opts) => {
    const u = underworld({ flagged: true });
    const r = await escapeUnderworld(u.s, { nearestTo: 568, maxSeconds: 5, ...opts });
    return { u, r };
  };
  const now = await run({});
  const then = await run({ kocatanRip: false });
  ok('it comes out at the fixed Jasper portal, nearest to where it died',
     now.r.left && now.u.landed[0]?.via === 'fixed Jasper', JSON.stringify(now.u.landed));
  ok('exactly as the old code chose', JSON.stringify(now.u.landed) === JSON.stringify(then.u.landed)
     && now.r.via === then.r.via, JSON.stringify({ now: now.u.landed, then: then.u.landed }));
  ok('and it never looked at the rip, so a lingering island flag cannot pull it to Ko\'catan',
     !now.u.looks().includes(now.u.rip.id), JSON.stringify(now.u.looks()));
  ok('no Ko\'catan record on a mainland death', now.r.kocatan === undefined);

  const bare = underworld({ flagged: false, lastDeathRoom: { num: 584, source: 'socket_fatal_health' } });
  const bareOld = underworld({ flagged: false, lastDeathRoom: { num: 584, source: 'socket_fatal_health' } });
  const a = await escapeUnderworld(bare.s, {});
  const b = await escapeUnderworld(bareOld.s, { kocatanRip: false });
  ok('a journey\'s bare escape after a mainland death: the same nearest portal as before',
     a.left && JSON.stringify(bare.landed) === JSON.stringify(bareOld.landed) && bare.landed[0]?.via !== 'rip',
     JSON.stringify({ now: bare.landed, then: bareOld.landed }));
  ok('and nothing was looked at that was not looked at before', JSON.stringify(bare.looks()) === JSON.stringify(bareOld.looks()));

  const unknown = underworld({ flagged: true });
  const c = await escapeUnderworld(unknown.s, {});
  ok('an unknown death room is not an island death (the old nearest portal)',
     c.left && unknown.landed[0]?.via !== 'rip' && !unknown.looks().includes(unknown.rip.id), JSON.stringify(unknown.landed));
}

// ================================================================== 5. the flag is gone
console.log('\na rip that no longer names Ko\'catan falls back');
{
  const u = underworld({ flagged: false, ripPointsAt: 'Jasper' });
  const t0 = Date.now();
  const r = await escapeUnderworld(u.s, { nearestTo: 2115, maxSeconds: 60 });
  const took = Date.now() - t0;
  ok('out', r.left === true, JSON.stringify(r));
  ok('through a pentagram portal, not the rip (it would have gone to Jasper anyway, by luck)',
     /^fixed /.test(u.landed[0]?.via ?? ''), JSON.stringify(u.landed));
  ok('it read the rip exactly once and did not poll it for a minute',
     u.looks().filter(id => id === u.rip.id).length === 1 && took < 5000, `${took}ms ${JSON.stringify(u.looks())}`);
  const rec = (r.could_not_use ?? []).find(a => /Ko'catan death/.test(a.portal));
  ok('and records why: the rip showed a mainland inn', rec?.verdict === 'not_flagged' && rec?.saw === 'Jasper',
     JSON.stringify(r.could_not_use));
  ok('reported honestly as not what was wanted', r.wanted === "Ko'catan" && r.got_what_was_wanted === false);

  const v = underworld({ flagged: false, ripPointsAt: 'Tos', lastDeathRoom: { num: 2115, source: 'x' } });
  const w = underworld({ flagged: false, ripPointsAt: 'Tos', lastDeathRoom: { num: 2115, source: 'x' } });
  const nowR = await escapeUnderworld(v.s, {});
  await escapeUnderworld(w.s, { kocatanRip: false });
  ok('a bare journey escape whose rip shows the mainland: the same portal the old code took',
     nowR.left && JSON.stringify(v.landed) === JSON.stringify(w.landed), JSON.stringify({ now: v.landed, then: w.landed }));
}
{
  // No description comes back at all: not evidence either way, so the old behaviour (which keeps
  // reading the rip for Ko'catan) runs, and it gets out.
  const u = underworld({ flagged: true, deaf: true });
  const r = await escapeUnderworld(u.s, { nearestTo: 2115, maxSeconds: 1 });
  ok('an unreadable rip: three looks, then the old path, and out', r.left === true
     && u.looks().filter(id => id === u.rip.id).length >= 3, JSON.stringify({ r, looks: u.looks() }));
  const rec = (r.could_not_use ?? []).find(a => /Ko'catan death/.test(a.portal));
  ok('recorded as unread, not as a mainland reading', rec?.verdict === 'unread', JSON.stringify(r.could_not_use));
}

// ================================================================== 6. read the island, cannot reach it
console.log('\nthe rip reads the island but cannot be reached');
{
  const blocked = [{ col: HELL.col + 1, row: HELL.row }, { col: HELL.col, row: HELL.row }];
  const u = underworld({ flagged: true, unwalkable: blocked });
  const r = await escapeUnderworld(u.s, { nearestTo: 2115, maxSeconds: 60 });
  ok('it holds out: not out, and no mainland portal taken', r.left === false && u.landed.length === 0
     && !u.steppedOnFixed(), JSON.stringify({ r, log: u.log }));
  ok('saying so', r.reason === 'kocatan_rip_not_reached' && r.kocatan?.verdict === 'failed', JSON.stringify(r));
  const v = underworld({ flagged: true, unwalkable: blocked });
  const r2 = await escapeUnderworld(v.s, { nearestTo: 2115, maxSeconds: 60, kocatanHoldOut: false });
  ok('once the caller stops holding out, out is out — a pentagram portal',
     r2.left === true && /^fixed /.test(v.landed[0]?.via ?? ''), JSON.stringify(v.landed));
  ok('without a minute of rip polling first', v.looks().filter(id => id === v.rip.id).length === 1,
     JSON.stringify(v.looks()));
}

// ================================================================== 7. the real keeper rung
console.log('\nAutopilot.passUnderworld, the keeper\'s mortality rung');
const { Autopilot, HANDLED } = await import('./m59-autopilot.mjs');
const { KOCATAN_RIP_HOLD_ATTEMPTS } = await import('./autopilot/death.mjs');
function keeper(u, diedIn) {
  const notes = [];
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: u.s, policy: { agent: 't21' }, tally: { deaths: 1, rooms_moved: 0 }, passes: 1,
    lastPostMortem: { where: { num: diedIn } },
    observeDeath: async () => {}, answerWhere: async () => {},
    note: (what, detail) => notes.push({ what, detail }),
    progress: () => {}, noProgress: () => {},
  });
  return { k, notes };
}
const quiet = async (fn) => {
  const was = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = was; }
};
{
  const u = underworld({ flagged: true });
  const { k, notes } = keeper(u, 2115);
  const verdict = await quiet(() => k.passUnderworld({ s: u.s, c: u.c, room: { num: 1, name: 'The Underworld' } }));
  const out = notes.find(n => n.what === 'escaped the underworld');
  ok('the rung handles it', verdict === HANDLED);
  ok('Beaker\'s death in 2115, through the keeper: the rip, into 2001',
     u.landed[0]?.via === 'rip' && u.landed[0]?.dest === 2001 && out?.detail?.to === KOC_INN.name,
     JSON.stringify({ landed: u.landed, out }));
  ok('the note carries the Ko\'catan record', out?.detail?.kocatan?.verdict === 'took_it'
     && out?.detail?.died_in_room === 2115, JSON.stringify(out?.detail));
  ok('and recovery is armed as for any death (rest in the inn until whole)',
     k.recoverUntilWhole === true && k.needsRecovery === true && k.underworldTries === 0);
}
{
  const u = underworld({ flagged: true });
  const { k } = keeper(u, 584);
  await quiet(() => k.passUnderworld({ s: u.s, c: u.c, room: { num: 1, name: 'The Underworld' } }));
  const v = underworld({ flagged: true });
  await quiet(() => escapeUnderworld(v.s, { maxSeconds: 60, nearestTo: 584, kocatanRip: false }));
  ok('a mainland death (584) through the keeper: the old choice, never the rip',
     u.landed[0]?.via !== 'rip' && JSON.stringify(u.landed) === JSON.stringify(v.landed),
     JSON.stringify({ now: u.landed, then: v.landed }));
}
{
  const blocked = [{ col: HELL.col + 1, row: HELL.row }, { col: HELL.col, row: HELL.row }];
  const u = underworld({ flagged: true, unwalkable: blocked });
  const { k, notes } = keeper(u, 2115);
  const room = { num: 1, name: 'The Underworld' };
  const outcomes = [];
  for (let attempt = 1; attempt <= KOCATAN_RIP_HOLD_ATTEMPTS + 1 && !u.landed.length; attempt++) {
    await quiet(() => k.passUnderworld({ s: u.s, c: u.c, room }));
    outcomes.push(u.landed.length ? u.landed[0].via : 'held');
  }
  ok(`an unreachable island rip is held out for ${KOCATAN_RIP_HOLD_ATTEMPTS} attempts, then any portal`,
     outcomes.length === KOCATAN_RIP_HOLD_ATTEMPTS + 1
     && outcomes.slice(0, -1).every(o => o === 'held') && /^fixed /.test(outcomes.at(-1)),
     JSON.stringify(outcomes));
  ok('each held attempt says why', notes.filter(n => n.what === 'could not escape — will keep trying')
     .every(n => n.detail?.why === 'kocatan_rip_not_reached' && n.detail?.kocatan?.verdict === 'failed'));
}

// ================================================================== the session's record of this visit
console.log('\nthe session observer records where this life ended (m59-game.mjs joinOnce)');
{
  const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('      if (ev.kind === \'room-entered\' && this.client === c) {');
  const end = source.indexOf('        if (/underworld/i.test(ev.roomName ?? \'\'))', start);
  ok('the production room observer is found', start > 0 && end > start);
  const observe = new Function('c', 'ev', 'recordEvent', 'deathRoomOnEntry', source.slice(start, end) + '}');
  const now = Date.now();
  const sess = {
    world: { room: { num: 2125, name: 'Into the Jungle' } }, travelObservedRoom: null,
    sessionEvidence: { records: [{ id: 'a', events: [] }] },
    noteTravelMethod() {}, name: 't21',
  };
  const c = { me: { name: 'Scooter' } }; sess.client = c;
  const rec = () => {};
  observe.call(sess, c, { kind: 'room-entered' }, rec, UW.deathRoomOnEntry);
  ok('walking about records nothing', sess.lastDeathRoom === undefined);
  sess.sessionEvidence.records[0].events.push({ at: now, kind: 'stat', name: 'health', value: 0, room: 2125 });
  sess.world.room = { num: 1, name: 'The Underworld' };
  observe.call(sess, c, { kind: 'room-entered' }, rec, UW.deathRoomOnEntry);
  ok('entering the Underworld records the death room from the socket evidence',
     sess.lastDeathRoom?.num === 2125, JSON.stringify(sess.lastDeathRoom));
  ok('which is exactly what a bare escape then reads', UW.underworldDeathRoom(sess, {}).num === 2125);
  sess.world.room = KOC_INN;
  observe.call(sess, c, { kind: 'room-entered' }, rec, UW.deathRoomOnEntry);
  ok('leaving does not erase it, and the next death overwrites it',
     sess.lastDeathRoom?.num === 2125);
  sess.sessionEvidence.records[0].events.push({ at: now + 1, kind: 'stat', name: 'health', value: 0, room: 584 });
  sess.sessionEvidence.records[0].events = sess.sessionEvidence.records[0].events.filter(e => e.room !== 2125);
  sess.world.room = { num: 1, name: 'The Underworld' };
  observe.call(sess, c, { kind: 'room-entered' }, rec, UW.deathRoomOnEntry);
  ok('a later mainland death replaces it', sess.lastDeathRoom?.num === 584, JSON.stringify(sess.lastDeathRoom));
  const boom = { ...sess, world: { room: { num: 2001 } }, travelObservedRoom: { num: 2001 } };
  boom.world.room = { num: 1 };
  observe.call(boom, c, { kind: 'room-entered' }, rec, () => { throw new Error('no'); });
  ok('a failure to read it is null, never a thrown event callback', boom.lastDeathRoom === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
