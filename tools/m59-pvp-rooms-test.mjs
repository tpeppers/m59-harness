#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// m59-pvp-rooms-test.mjs — WHERE A CHARACTER MAY FIGHT A PLAYER AT ALL (`pvp_rooms`).
//
//   node tools/m59-pvp-rooms-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster: the war book, the alarm file,
// the grudge book and the PvP log all live in a scratch directory set before the first import.
//
// The order, operator 2026-10-11: "stop people from fighting back outside of 599/2/38
// (Ukgoth <-> Castle Victoria)". What this pins (tools/m59-pvp-rooms.mjs has the argument):
//   - silence is the old behaviour: unset / null / [] allows every room;
//   - [599, 2, 38] allows 599 and refuses 576 — and an unknown room is not a listed one;
//   - the broker refuses a non-integer room, naming the key, and clears on null / [];
//   - outside the list a war enemy is NOT engaged but the sighting alarm STILL goes out;
//   - outside the list a player hit is NOT answered, the body is not taken, a combat line and a
//     durable `pvp_attacked_outside_rooms` row are written, and the attacked alarm still goes out;
//   - a fight that leaves the list ends with "outside pvp_rooms", never the suspension text;
//   - inside the list nothing changes;
//   - every keeper gate (defendAgainstPlayers, engagePlayerTarget, respondToConflict,
//     passFightBack's player rows) asks the one function, and status reports it.

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOOKS = mkdtempSync(join(tmpdir(), 'm59-pvp-rooms-'));
process.env.M59_WAR_FILE = join(BOOKS, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(BOOKS, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(BOOKS, 'grudges.json');
process.env.M59_PVP_HOLD_DIR = join(BOOKS, 'holds');
process.env.M59_PVP_DIR = join(BOOKS, 'pvp');

const rooms = await import('./m59-pvp-rooms.mjs');
const war = await import('./m59-war.mjs');
const pvplog = await import('./m59-pvp.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const { bodyAuthority } = await import('./m59-body-command.mjs');
const { bindPacketScope } = await import('./m59-packet-scope.mjs');

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? ' -- ' + extra : '')); }
};
const throwsLike = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const ORDER = [599, 2, 38];

// ------------------------------------------------------------------ the one decision

console.log('the decision');
ok('unset policy: allowed everywhere', rooms.pvpAllowedHere({}, 576) && rooms.pvpAllowedHere(undefined, 576));
ok('null and [] are silence too', rooms.pvpAllowedHere({ pvpRooms: null }, 576) && rooms.pvpAllowedHere({ pvpRooms: [] }, 576));
ok('silence allows even an unknown room', rooms.pvpAllowedHere({}, undefined));
ok('[599,2,38] allows 599', rooms.pvpAllowedHere({ pvpRooms: ORDER }, 599));
ok('[599,2,38] allows 2 and 38', rooms.pvpAllowedHere({ pvpRooms: ORDER }, 2) && rooms.pvpAllowedHere({ pvpRooms: ORDER }, 38));
ok('[599,2,38] refuses 576', !rooms.pvpAllowedHere({ pvpRooms: ORDER }, 576));
ok('[599,2,38] refuses 39 (Castle Victoria upstairs is not in the order)', !rooms.pvpAllowedHere({ pvpRooms: ORDER }, 39));
ok('an unknown room is not a listed one', !rooms.pvpAllowedHere({ pvpRooms: ORDER }, undefined));
ok('a room number given as a string still matches', rooms.pvpAllowedHere({ pvpRooms: ['599'] }, '599'));
const refusal = rooms.pvpRoomsRefusal({ pvpRooms: ORDER }, 576);
ok('the refusal names the room and the list', refusal?.room === 576 && refusal.rooms.join() === '599,2,38'
  && refusal.reason === 'outside pvp_rooms', JSON.stringify(refusal));
ok('no refusal inside the list', rooms.pvpRoomsRefusal({ pvpRooms: ORDER }, 38) === null);

// ------------------------------------------------------------------ the broker validator

console.log('the broker validator');
ok('null clears', rooms.validatePvpRooms(null) === null);
ok('[] clears', rooms.validatePvpRooms([]) === null);
ok('[599,2,38] is kept as numbers', JSON.stringify(rooms.validatePvpRooms([599, '2', 38])) === '[599,2,38]');
ok('a fraction is refused, naming the key', throwsLike(() => rooms.validatePvpRooms([599, 2.5]), /pvp_rooms/));
ok('a word is refused, naming the key', throwsLike(() => rooms.validatePvpRooms(['ukgoth']), /pvp_rooms/));
ok('zero and negatives are refused', throwsLike(() => rooms.validatePvpRooms([0]), /pvp_rooms/)
  && throwsLike(() => rooms.validatePvpRooms([-2]), /pvp_rooms/));
ok('a bare number is refused (not an array)', throwsLike(() => rooms.validatePvpRooms(599), /pvp_rooms/));
ok('a boolean is refused', throwsLike(() => rooms.validatePvpRooms([true]), /pvp_rooms/));

const broker = readToolSource(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
ok('the broker schema declares pvp_rooms (an undeclared key is only reported)', /\n\s+pvp_rooms: \{ type: \['array', 'null'\]/.test(broker));
ok('the broker validates through validatePvpRooms and stores policy.pvpRooms',
  /if \(a\.pvp_rooms !== undefined\) p\.policy\.pvpRooms = validatePvpRooms\(a\.pvp_rooms\);/.test(broker));
ok('the broker imports the validator from m59-pvp-rooms.mjs',
  /import \{ validatePvpRooms \} from '\.\/m59-pvp-rooms\.mjs';/.test(broker));

// ------------------------------------------------------------------ the war scan's choice

console.log('the war scan');
const H = { name: 'Morpheus' };
ok('allowed, war on: engage', rooms.warScanAction({ hostile: H, warEnabled: true, leashed: false, pvpAllowed: true }) === 'engage');
ok('outside pvp_rooms: sighted, never silent', rooms.warScanAction({ hostile: H, warEnabled: true, leashed: false, pvpAllowed: false }) === 'sighted');
ok('leashed: sighted, as before', rooms.warScanAction({ hostile: H, warEnabled: true, leashed: true, pvpAllowed: true }) === 'sighted');
ok('sentinel only: sighted, as before', rooms.warScanAction({ hostile: H, warEnabled: false, leashed: false, pvpAllowed: true }) === 'sighted');
ok('nothing hostile: nothing', rooms.warScanAction({ hostile: null, warEnabled: true, leashed: false, pvpAllowed: false }) === null);
ok('the stop reason is its own, not the suspension text',
  /outside pvp_rooms/.test(rooms.pvpRoomsStopReason(refusal)) && !/suspended/.test(rooms.pvpRoomsStopReason(refusal)));

// ------------------------------------------------------------------ CombatMode, end to end

const P = OF.PLAYER | OF.ATTACKABLE;
const OURS = new Set(['us', 'statler', 'gonzo']);
const reset = () => {
  writeFileSync(process.env.M59_WAR_FILE, JSON.stringify({ format: 'm59-war/1', enemy_guilds: {}, members: {} }));
  writeFileSync(process.env.M59_WAR_ALARM_FILE, ''); writeFileSync(process.env.M59_GRUDGE_FILE, '{}');
};
function fixture({ room = 576, pvpRooms = ORDER } = {}) {
  let clock = Date.now();
  const sent = [], lines = [], timers = new Map(); let timerId = 0;
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, 'Us'], [2, 'Morpheus']]), spells: [], hp: 100,
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    look(id) { sent.push(`look:${id}`); },
    safety(on) { sent.push('safety:' + on); this.self.flags = on ? OF.SAFETY : 0; } };
  const s = { name: 'Us', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    job: null, need: () => c, recorder: { line: (kind, row) => lines.push({ kind, ...row }) },
    world: { room: { num: room }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async step(col, row) { return this.pacer.submit('move', () => { sent.push(`move:r${row}c${col}`); c.self.row = row; c.self.col = col; }); } };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.4, pvpRooms }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock,
    schedule(fn) { const id = ++timerId; timers.set(id, fn); return id; }, unschedule: id => timers.delete(id) });
  mode.character = () => 'Us';
  mode.fleetmate = n => OURS.has(String(n).toLowerCase());
  mode.warEligibility = () => true;
  return { s, c, sent, lines, keeper, mode, advance(ms) { clock += ms; } };
}
const put = (f, id, flags) => f.c.room.objects.set(id, { id, nameRsc: id, row: 5, col: 6, flags });
const hitBy = f => f.mode.event({ kind: 'message', text: "Morpheus's scimitar cleaves you." });

console.log('combat mode: war on sight');
{
  reset(); const f = fixture({ room: 576 });
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  ok('outside: a war enemy in the room is not engaged', !f.mode.active && !f.sent.some(x => x.startsWith('attack')), f.sent.join());
  const alarms = war.readAlarms();
  ok('outside: the sighting alarm still goes out', alarms.length === 1 && alarms[0].enemy === 'Morpheus'
    && alarms[0].basis === 'sighted' && alarms[0].room === 576, JSON.stringify(alarms));
  ok('outside: a combat line says why it was skipped',
    f.lines.some(l => l.event === 'war_skipped_outside_pvp_rooms' && l.room === 576 && l.target === 'Morpheus'));
  ok('outside: a fleetmate\'s attacked alarm does not pull it in either',
    f.mode.onWarAlarm({ at: Date.now(), room: 576, reporter: 'Statler', enemy: 'Morpheus', basis: 'attacked' }) === false
    && !f.mode.active);
}
{
  reset(); const f = fixture({ room: 599 });
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  ok('inside 599: the war enemy is engaged exactly as before', !!f.mode.active?.pvp && f.sent.includes('attack:2'), f.sent.join());
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 576, pvpRooms: null });
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick();
  ok('unset: the war enemy in 576 is engaged, the behaviour before the key', !!f.mode.active?.pvp && f.sent.includes('attack:2'));
  f.mode.stop('test');
}

console.log('combat mode: return fire');
{
  reset(); const f = fixture({ room: 576 });
  f.mode.pvpLogging = () => true;                                 // a real keeper has a Recorder
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('outside: a player hit is not answered and the body is not taken',
    !f.mode.active && !f.sent.some(x => x.startsWith('attack')) && f.s.movementGeneration === 0, f.sent.join());
  const line = f.lines.find(l => l.event === 'pvp_outside_rooms');
  ok('outside: a pvp_outside_rooms combat line carries target, room and who owns survival',
    line?.target === 'Morpheus' && line.room === 576 && /keeper ladder/.test(line.survival ?? ''), JSON.stringify(line));
  const rows = pvplog.readPvpLog({ since: 0 });
  const row = rows.find(r => r.event === 'pvp_attacked_outside_rooms');
  ok('outside: the durable PvP log gets pvp_attacked_outside_rooms with observer, room, attacker, at',
    row?.observer === 'Us' && row.room === 576 && row.attacker === 'Morpheus' && Number.isFinite(row.at), JSON.stringify(rows));
  const events = pvplog.collectEvents({ log: rows, isOurs: n => OURS.has(String(n).toLowerCase()) });
  const ev = events.find(e => e.event === 'pvp_attacked_outside_rooms');
  ok('outside: the battle reader counts it as hostile contact with Morpheus as the enemy',
    ev?.hostile === true && ev.enemies?.includes('Morpheus') && pvplog.groupBattles(events).length === 1,
    JSON.stringify(ev));
  ok('outside: the attacked alarm still goes out for fleet-mates in allowed rooms',
    war.readAlarms().some(a => a.enemy === 'Morpheus' && a.basis === 'attacked' && a.room === 576));
  hitBy(f);
  ok('a repeated hit writes one combat line, not one per blow',
    f.lines.filter(l => l.event === 'pvp_outside_rooms').length === 1);
}
{
  reset(); const f = fixture({ room: 38 });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('inside 38: return fire exactly as before', !!f.mode.active?.pvp && f.sent.includes('attack:2'), f.sent.join());
  // Carried out of the list mid-fight: the fight ends with its own reason.
  f.s.world.room.num = 576;
  await f.mode.tick();
  ok('leaving the list ends the fight', !f.mode.active?.pvp);
  const end = f.mode.lastPvP?.end_reason ?? '';
  const fin = f.lines.find(l => l.event === 'finished')?.reason ?? '';
  ok('syncPvP says "outside pvp_rooms", never "operator suspended connection"',
    /outside pvp_rooms \(room 576/.test(end) && /outside pvp_rooms/.test(fin)
    && !/operator suspended connection/.test(end + fin), `${end} | ${fin}`);
}
{
  reset(); const f = fixture({ room: 38 });
  f.mode.pvpEligibility = () => false;
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('inside the list, the suspension seam still refuses as before', !f.mode.active && !f.sent.length);
}

// ------------------------------------------------------------------ the keeper's own gates

console.log('the keeper');
{
  reset();
  const notes = [];
  const fake = { policy: { defendAgainstPlayers: true, pvpRooms: ORDER },
    s: { world: { room: { num: 576 } }, client: { selfId: 1, self: { id: 1, row: 5, col: 5 },
      room: { objects: new Map([[2, { id: 2, nameRsc: 2, row: 5, col: 6, flags: P | OF.ENEMY }]]) },
      rsc: new Map([[2, 'Morpheus']]) } },
    note: (what, data) => notes.push({ what, ...data }) };
  const out = await Autopilot.prototype.defendAgainstPlayers.call(fake);
  ok('defendAgainstPlayers outside the list does not swing', out?.engaged === null && out.why === 'outside pvp_rooms', JSON.stringify(out));
  ok('...and says so in the journal', notes.some(n => /outside pvp_rooms/.test(n.what)));
}
const auto = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
const body = name => {
  const i = auto.indexOf(`  async ${name}(`);
  return i < 0 ? '' : auto.slice(i, auto.indexOf('\n  }\n', i));
};
ok('defendAgainstPlayers asks pvpRoomsRefusal', /pvpRoomsRefusal\(this\.policy/.test(body('defendAgainstPlayers')));
ok('engagePlayerTarget asks pvpAllowedHere', /pvpAllowedHere\(this\.policy/.test(body('engagePlayerTarget')));
ok('respondToConflict will not converge on a room outside the list', /pvpAllowedHere\(this\.policy, cf\.room\)/.test(body('respondToConflict')));
ok('passFightBack refuses PLAYER rows outside the list (monsters untouched)',
  /\(o\.flags & OF\.PLAYER\) && !pvpAllowedHere\(this\.policy/.test(body('passFightBack')));
ok('the policy default names pvpRooms (a pushed order lands on a named key)', /\n\s+pvpRooms: null,/.test(auto));
ok('status reports pvp_rooms with allowed_here', /pvp_rooms: \{ rooms: pvpRoomsOf\(this\.policy\)/.test(auto)
  && /allowed_here: pvpAllowedHere\(/.test(auto));
const schema = await import('./m59-strategy-schema.mjs');
ok('a farming strategy cannot set pvpRooms (it is a war/PvP path)', !!schema.PROTECTED_NAMES.pvpRooms);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
