#!/usr/bin/env node
// HUNT ON THE ROAD. Offline, no server, no socket, safe any time:
//
//   node tools/m59-travel-hunt-test.mjs
//
// Operator, 2026-11-07, of the Farol mollusk farmers: "Have the farmers also clear monsters they come across while
// traveling". Pins three things, against the pure decision and against the REAL keeper methods on a hand-built `this`:
//
//   * the GATES (m59-travel-hunt.mjs travelHuntDecision): off by default; only the keeper's own work journeys; never an
//     errand, never a fight in progress; below the flee line nothing; an unprovoked fight only at the engage line and the
//     vigor floor, one already on us between the flee line and the engage line; never a crowd; a budget per destination.
//   * the WATCHDOG half (Autopilot.travelHuntCheck): works UNDER a journey hold (clear_path's `this.inert` gate would have
//     made it dead code on every keeper road), never picks a player, cancels the walk and hands passFightBack a due.
//   * the PASS half (passFightBack, reason 'travel_hunt'): picks the watchdog's target beyond melee reach, stands down if
//     health fell under the engage line meanwhile, and records a road_hunt rather than a fought_back.
import './m59-test-ledger.mjs';        // FIRST — the ledger goes to a scratch file
import { Autopilot, CONTINUE, HANDLED } from './m59-autopilot.mjs';
import { readToolSource } from './autopilot/source.mjs';
import { OF } from './m59-parse.mjs';
import { normalizeTravelHunt, travelHuntDecision, travelHuntBudget, TRAVEL_HUNT_DEFAULTS, TRAVEL_HUNT_ORIGINS } from './m59-travel-hunt.mjs';
import { validateStrategy } from './m59-strategy-schema.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const throws = (f) => { try { f(); return false; } catch { return true; } };

console.log('\nthe setting');
{
  ok('absent, null and false are off', normalizeTravelHunt(undefined) === null && normalizeTravelHunt(null) === null
     && normalizeTravelHunt(false) === null);
  const on = normalizeTravelHunt(true);
  ok('true is the defaults', on && on.reach === 4 && on.maxThreats === 4 && on.maxPerJourney === 6 && on.skipRooms.includes(599));
  ok('an object overrides', normalizeTravelHunt({ reach: 3, maxPerJourney: 2 }).reach === 3);
  ok('enabled:false is off', normalizeTravelHunt({ enabled: false }) === null);
  ok('an unrecognised key is refused, never ignored', throws(() => normalizeTravelHunt({ reech: 3 })));
  ok('a reach past 8 is a detour, refused', throws(() => normalizeTravelHunt({ reach: 12 })));
  // UNCAPPED since 2026-11-07 (operator: "Uncap fights per trip"): road fights no longer spend a resumed journey's
  // attempts (roadHuntResume, m59-farm-hall-test.mjs), so the old ceiling of 11 under the resume cap is gone.
  ok('null / "unlimited" is no per-destination cap', normalizeTravelHunt({ maxPerJourney: null }).maxPerJourney === null
     && normalizeTravelHunt({ maxPerJourney: 'unlimited' }).maxPerJourney === null);
  ok('a number past the old resume-cap ceiling is accepted now', normalizeTravelHunt({ maxPerJourney: 40 }).maxPerJourney === 40);
  ok('zero, a fraction or a word is still refused', throws(() => normalizeTravelHunt({ maxPerJourney: 0 }))
     && throws(() => normalizeTravelHunt({ maxPerJourney: 2.5 })) && throws(() => normalizeTravelHunt({ maxPerJourney: 'lots' })));
  ok('origins must be keeper origin names', throws(() => normalizeTravelHunt({ origins: ['fleetscript:x'] })));
  ok('the default origins are work, and leave out survival, rescue and PvP',
     TRAVEL_HUNT_ORIGINS.includes('town_trip') && TRAVEL_HUNT_ORIGINS.includes('station_return') &&
     !['shelter', 'retreat', 'survival', 'survival_exit', 'recovery_detour', 'play_dead', 'underworld_escape',
       'conflict_response', 'resume_journey', 'follow', 'travel_guard', 'watchdog'].some(o => TRAVEL_HUNT_ORIGINS.includes(o)));
  const v = validateStrategy({ name: 'x', travelHunt: true });
  ok('a strategy may set it (work faculty), and it lands on policy.travelHunt',
     v.ok && v.strategy.desired.travelHunt?.reach === 4 && v.strategy.faculties.travelHunt === 'work', v.why);
  ok('a strategy cannot reach the travel guard through it', !validateStrategy({ name: 'x', travelGuard: { flee: false } }).ok);
}

console.log('\nthe decision');
{
  const cfg = normalizeTravelHunt(true);
  const journey = { travelling: true, errand: false, fighting: false, origin: { source: 'keeper', name: 'town_trip' }, to: 202, room: 546 };
  const health = { frac: 0.95, fleeAt: 0.4, engageAt: 0.75 };
  const vigor = { value: 150, floor: 120 };
  const spider = { id: 7, name: 'baby spider', d: 2.5, refused: null, attacking: false };
  const base = { cfg, journey, health, vigor, candidates: [spider], threats: 1, budget: { fights: 0, lastAt: 0 }, now: 1e9 };
  const d = travelHuntDecision(base);
  ok('a baby spider beside the road on a town trip is hunted', d.hunt && d.pick.id === 7, d.why);
  ok('off is off', !travelHuntDecision({ ...base, cfg: null }).hunt);
  ok('not on a journey: nothing', !travelHuntDecision({ ...base, journey: { ...journey, travelling: false } }).hunt);
  ok('an errand holds the body: nothing', !travelHuntDecision({ ...base, journey: { ...journey, errand: true } }).hunt);
  ok('already fighting: nothing', !travelHuntDecision({ ...base, journey: { ...journey, fighting: true } }).hunt);
  for (const origin of [{ source: 'fleetscript', name: 'island-move-in' }, { source: 'operator', name: 'travel' },
                        { source: 'keeper', name: 'shelter' }, { source: 'keeper', name: 'retreat' },
                        { source: 'bot', name: 'dum' }, null])
    ok(`never on ${origin ? `${origin.source}:${origin.name}` : 'an unattributed walk'}`,
       !travelHuntDecision({ ...base, journey: { ...journey, origin } }).hunt);
  ok('a custom origin list is honoured', travelHuntDecision({ ...base, cfg: { ...cfg, origins: ['station_return'] },
     journey: { ...journey, origin: { source: 'keeper', name: 'station_return' } } }).hunt);
  ok('Ukgoth is crossed wall to wall, never hunted', !travelHuntDecision({ ...base, journey: { ...journey, room: 599 } }).hunt);
  ok('BELOW THE FLEE LINE NOTHING, even with a monster on us',
     !travelHuntDecision({ ...base, health: { ...health, frac: 0.3 }, candidates: [{ ...spider, attacking: true }] }).hunt);
  ok('below the engage line no NEW fight', !travelHuntDecision({ ...base, health: { ...health, frac: 0.6 } }).hunt);
  ok('but one already on us is answered there', travelHuntDecision({ ...base, health: { ...health, frac: 0.6 },
     candidates: [{ ...spider, attacking: true }] }).hunt);
  ok('below the vigor floor no new fight', !travelHuntDecision({ ...base, vigor: { value: 90, floor: 120 } }).hunt);
  ok('no floor means any vigor', travelHuntDecision({ ...base, vigor: { value: 10, floor: 0 } }).hunt);
  ok('a crowd is walked, not hunted', !travelHuntDecision({ ...base, threats: 4 }).hunt);
  ok('a refused (out of band / spared / karma) monster is not quarry',
     !travelHuntDecision({ ...base, candidates: [{ ...spider, refused: { why: 'above the band' } }] }).hunt);
  ok('one beyond reach is not quarry', !travelHuntDecision({ ...base, candidates: [{ ...spider, d: 6 }] }).hunt);
  ok('the attacker outranks the nearer bystander', travelHuntDecision({ ...base, candidates: [
     { ...spider, id: 1, d: 1 }, { ...spider, id: 2, d: 3, attacking: true }] }).pick.id === 2);
  ok('the budget per destination stops it', !travelHuntDecision({ ...base, budget: { fights: 6, lastAt: 0 } }).hunt);
  ok('and so does a fight moments ago', !travelHuntDecision({ ...base, budget: { fights: 1, lastAt: 1e9 - 3000 } }).hunt);
  const b0 = travelHuntBudget(null, 202, 1000);
  ok('the budget resets on a new destination', travelHuntBudget({ ...b0, fights: 5 }, 546, 2000).fights === 0
     && travelHuntBudget({ ...b0, fights: 5 }, 202, 2000).fights === 5);
}

// ------------------------------------------------------------ the keeper halves, on the real prototype
const MONSTER = OF.ATTACKABLE, PLAYER = OF.ATTACKABLE | OF.PLAYER;
const thing = (id, name, col, row, flags = MONSTER) => ({ id, name, nameRsc: 'rsc' + id, col, row, flags });
function keeper({ policy = { travelHunt: normalizeTravelHunt(true) }, objects = [], health = 38, max = 40,
                  inert = { travelling: true, guard: {}, to: 202, origin: { source: 'keeper', name: 'town_trip' } },
                  doing = 'travelling', origin = { source: 'keeper', name: 'town_trip' }, room = 546, refused = () => null,
                  vigor = 150, floor = 120, fight = null } = {}) {
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, {
    policy: { ...policy }, watch: { lastHealth: null }, tally: { kills: 0 }, notes: [], cancels: [], ledger: [], fought: [],
    progressed: [], killTimes: [], doing, inert, hold: null, passes: 3, fightBackDue: null,
    s: { name: 't1', live: true, world: { room: { num: room, name: 'Deep in the Forest of Farol' } },
         moveOrder: origin ? { to: 202, origin } : null,
         cancelMovement: (g, why, o) => { k.cancels.push({ why, origin: o?.origin }); return { interrupted: true }; } },
    refuseEngagement: (name) => refused(name),
    safety: () => ({ fleeAt: 0.4, engageAt: 0.75 }),
    wantedFightFloor: () => floor, larder: () => [{ food: { nutrition: 20 } }],
    fightFloor: () => { throw new Error('fightFloor counts starved passes: the watchdog must not call it'); },
    note: (what, d) => k.notes.push({ what, ...d }),
    progress: (m) => k.progressed.push(m), noProgress: (m) => k.progressed.push('! ' + m),
    ledgerEvent: (kind, d) => k.ledger.push({ kind, ...d }),
    countLoot: () => {}, wearLootedArmour: async () => {}, who: () => 'Lew', weaponPriorityNow: () => null,
    bannedWeaponsNow: () => null, farmStrategyHook: () => {},
    fightNow: async (opts) => { k.fought.push(opts); return fight ? fight(opts) : { fought: true, killed: true, rounds: 4, target: opts.target, looted: [] }; },
  });
  k.s.client = { self: { col: 10, row: 10 }, selfId: 999, rsc: new Map(objects.map(o => [o.nameRsc, o.name])),
                 room: { objects: new Map(objects.map(o => [o.id, o])) },
                 equipment: () => ({ known: false }),
                 vitals: () => ({ health: { value: health, max }, vigor: { value: vigor } }) };
  return k;
}
const hp = (value, max = 40) => ({ value, max });

console.log('\nthe watchdog half');
{
  const off = keeper({ policy: {}, objects: [thing(1, 'baby spider', 12, 10)] });
  ok('off by default: nothing asked, nothing cancelled', off.travelHuntCheck(off.watch, hp(38), Date.now()) === null
     && off.cancels.length === 0 && !off.fightBackDue);

  const k = keeper({ objects: [thing(1, 'baby spider', 13, 10)] });
  const due = k.travelHuntCheck(k.watch, hp(38), Date.now());
  ok('UNDER A JOURNEY HOLD it arms (the hold is every keeper road)', !!due && due.reason === 'travel_hunt' && due.targetId === 1,
     JSON.stringify(k.notes.at(-1)));
  ok('and ends the WALK so the blind await returns', k.cancels.length === 1 && k.cancels[0].origin?.name === 'travel_hunt');
  ok('the road budget counts it', k.travelHuntRoad?.fights === 1 && k.tally.travel_hunts === 1);
  ok('once per pass', k.travelHuntCheck(k.watch, hp(38), Date.now()) === null);

  const people = keeper({ objects: [thing(1, 'Morpheus', 11, 10, PLAYER), thing(2, 'Raphael', 12, 10, PLAYER)] });
  ok('PLAYERS ARE NEVER QUARRY: two in reach arm nothing', people.travelHuntCheck(people.watch, hp(38), Date.now()) === null
     && people.cancels.length === 0);
  const mixed = keeper({ objects: [thing(1, 'Morpheus', 11, 10, PLAYER), thing(2, 'baby spider', 13, 10)] });
  ok('and with a monster beside them, the monster is the pick', mixed.travelHuntCheck(mixed.watch, hp(38), Date.now())?.targetId === 2);

  const errand = keeper({ inert: { why: 'outfit', at: Date.now(), maxMs: 60000 }, objects: [thing(1, 'baby spider', 12, 10)] });
  ok('AN ERRAND outranks it', errand.travelHuntCheck(errand.watch, hp(38), Date.now()) === null && errand.cancels.length === 0);

  const ordered = keeper({ origin: { source: 'fleetscript', name: 'recall-to-38' },
                           inert: { travelling: true, guard: {}, to: 38, origin: { source: 'fleetscript', name: 'recall-to-38' } },
                           objects: [thing(1, 'baby spider', 12, 10)] });
  ok("SOMEBODY ELSE'S ORDER (a recall) is walked, never hunted", ordered.travelHuntCheck(ordered.watch, hp(38), Date.now()) === null);

  const guarded = keeper({ inert: { travelling: true, guard: { clear_path: false }, to: 202, origin: { source: 'keeper', name: 'town_trip' } },
                           objects: [thing(1, 'baby spider', 12, 10)] });
  ok('travel_guard clear_path:false switches every road swing off, this one included',
     guarded.travelHuntCheck(guarded.watch, hp(38), Date.now()) === null);

  const hurt = keeper({ health: 14, objects: [thing(1, 'baby spider', 11, 10)] });
  hurt.watch.attack = { since: Date.now() - 3000, hits: 3, lost: 6, lastHitAt: Date.now() };
  ok('BELOW THE FLEE LINE, with a spider on us, nothing: survival owns it', hurt.travelHuntCheck(hurt.watch, hp(14), Date.now()) === null);

  const scratched = keeper({ health: 26, objects: [thing(1, 'baby spider', 11, 10)] });
  ok('between flee and engage, an unprovoked spider is left alone', scratched.travelHuntCheck(scratched.watch, hp(26), Date.now()) === null);
  const bitten = keeper({ health: 26, objects: [thing(1, 'baby spider', 11, 10)] });
  bitten.watch.attack = { since: Date.now() - 2000, hits: 2, lost: 4, lastHitAt: Date.now() };
  ok('but one biting us is answered', bitten.travelHuntCheck(bitten.watch, hp(26), Date.now())?.targetId === 1);

  const crowd = keeper({ objects: [1, 2, 3, 4].map(i => thing(i, 'spider', 10 + i, 12)) });
  ok('a crowd of four is walked through', crowd.travelHuntCheck(crowd.watch, hp(38), Date.now()) === null);

  const troll = keeper({ objects: [thing(1, 'troll', 12, 10)], refused: n => n === 'troll' ? { why: 'above the band' } : null });
  ok('the engagement band still decides (a troll is refused)', troll.travelHuntCheck(troll.watch, hp(38), Date.now()) === null);
  ok('and says why, once', troll.notes.some(n => n.what === 'road hunt declined'));

  const idle = keeper({ inert: null, doing: 'idle', objects: [thing(1, 'baby spider', 12, 10)] });
  ok('standing still at home is not a road', idle.travelHuntCheck(idle.watch, hp(38), Date.now()) === null);
}

console.log('\nthe pass half');
{
  const ctx = (k, frac = 0.95) => ({ s: k.s, c: k.s.client, room: { name: 'Forest', num: 546 }, v: {}, hp: frac });
  const k = keeper({ inert: null, objects: [thing(1, 'baby spider', 11, 10), thing(2, 'spider', 13, 10)] });
  k.fightBackDue = { since: Date.now(), hits: 0, lost: 0, at: Date.now(), reason: 'travel_hunt', targetId: 2, reach: 4 };
  const r = await k.passFightBack(ctx(k));
  ok('a travel_hunt due is answered with no fight-back edict set', r === HANDLED && k.fought.length === 1, String(r));
  ok("it fights the WATCHDOG'S pick, 3 squares off, not the nearer one", k.fought[0]?.exactTargetId === 2);
  ok('and disengages at the flee line', k.fought[0]?.disengageAt === 0.4);
  ok('it is a road hunt on the ledger, not a fought_back', k.ledger.some(e => e.kind === 'road_hunt') &&
     !k.ledger.some(e => e.kind === 'fought_back') && k.ledger.some(e => e.kind === 'killed' && e.road_hunt));

  const late = keeper({ inert: null, health: 26, objects: [thing(1, 'baby spider', 12, 10)] });
  late.fightBackDue = { since: Date.now(), hits: 0, lost: 0, at: Date.now(), reason: 'travel_hunt', targetId: 1, reach: 4 };
  ok('health fell under the engage line before the pass: it stands down', await late.passFightBack(ctx(late, 0.65)) === CONTINUE
     && late.fought.length === 0);

  const held = keeper({ objects: [thing(1, 'baby spider', 12, 10)] });
  held.fightBackDue = { since: Date.now(), hits: 0, lost: 0, at: Date.now(), reason: 'travel_hunt', targetId: 1, reach: 4 };
  ok('a body still under a hold is not fought from here (the walk unwinds first)', await held.passFightBack(ctx(held)) === CONTINUE
     && held.fought.length === 0);
}

console.log('\nwired in');
{
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the watchdog asks it, after clear_path', /this\.clearPathCheck\(w, hp, now\);[\s\S]{0,400}this\.travelHuntCheck\?\.\(w, hp, now\);/.test(src));
  ok('the policy key exists on the keeper (a pushed order applies only named fields)', /\n\s+travelHunt: null,/.test(src));
  ok('the defaults never reach Ukgoth', TRAVEL_HUNT_DEFAULTS.skipRooms.includes(599));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
