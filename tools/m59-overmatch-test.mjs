#!/usr/bin/env node
// OVERMATCH (m59-overmatch.mjs), offline: the policy's normal form and its refusals, the verdict table, and then the
// wiring -- the one predicate asked by the combat wall (holdWorthwhile), the health lines (safety / healthLines), the
// rest gate (passFleeAndRest's `hurt`), the survival dispatcher, the fight floor and the wall release -- on fake
// keepers standing in Castle Victoria (38: level-75 skeletons, level-55 zombies). No broker, keeper process, server or
// roster.
//
//   node tools/m59-overmatch-test.mjs
import './m59-test-ledger.mjs';        // FIRST: the keeper records events; see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import { normOvermatch, normOvermatchForStrategy, overmatchVerdict, OVERMATCH_DEFAULTS, OVERMATCH_VIGOR_MARGIN }
  from './m59-overmatch.mjs';

// ------------------------------------------------------------------ the policy's normal form

test('normal form: auto by default; booleans, strings and objects in either spelling; an object without a mode is auto', () => {
  assert.deepEqual(normOvermatch(undefined), { ...OVERMATCH_DEFAULTS });
  assert.deepEqual(normOvermatch(null), { ...OVERMATCH_DEFAULTS });
  assert.equal(OVERMATCH_DEFAULTS.mode, 'auto');
  assert.equal(OVERMATCH_DEFAULTS.preyRatio, 1.8);
  assert.equal(normOvermatch(true).mode, 'on');
  assert.equal(normOvermatch('on').mode, 'on');
  assert.equal(normOvermatch(false).mode, 'off');
  assert.equal(normOvermatch('off').mode, 'off');
  assert.equal(normOvermatch('auto').mode, 'auto');
  assert.deepEqual(normOvermatch({ prey_ratio: 2.5, rest_below: 0.4, resume_above: 0.8, flee_below: 0.3, wall_at_attackers: 4 }),
    { mode: 'auto', preyRatio: 2.5, restBelow: 0.4, resumeAbove: 0.8, fleeBelow: 0.3, wallAtAttackers: 4 });
  assert.deepEqual(normOvermatch({ mode: 'on', preyRatio: 3, restBelow: 0.5 }),
    { ...OVERMATCH_DEFAULTS, mode: 'on', preyRatio: 3, restBelow: 0.5 });
  assert.equal(normOvermatch({ mode: false }).mode, 'off');
  assert.equal(normOvermatch({ wall_at_attackers: null }).wallAtAttackers, null);
});

test('normal form: nonsense is refused, with the reason, so a push is refused rather than misread', () => {
  const bad = [
    ['sometimes', /overmatch must be/],
    [7, /overmatch must be/],
    [[1], /overmatch must be/],
    [{ mode: 'maybe' }, /mode must be auto, on or off/],
    [{ walls: true }, /unrecognised key\(s\) walls/],
    [{ prey_ratio: 0.5 }, /prey_ratio must be a number from 1 to 20/],
    [{ prey_ratio: '2' }, /prey_ratio/],
    [{ rest_below: 0 }, /rest_below must be a fraction/],
    [{ rest_below: 34 }, /rest_below must be a fraction/],
    [{ flee_below: 0.5 }, /flee_below \(0\.5\) must be under rest_below \(0\.34\)/],
    [{ flee_below: 0.34 }, /flee_below/],                       // equal is not under
    [{ rest_below: 0.7 }, /rest_below \(0\.7\) must be under resume_above \(0\.67\)/],
    [{ rest_below: 0.5, resume_above: 0.5 }, /rest_below/],
    [{ resume_above: 1.2 }, /resume_above must be a fraction/],
    [{ wall_at_attackers: 0 }, /wall_at_attackers/],
    [{ wall_at_attackers: 2.5 }, /wall_at_attackers/],
    [{ wall_at_attackers: 'two' }, /wall_at_attackers/],
    [{ prey_ratio: 2, preyRatio: 3 }, /both preyRatio and prey_ratio/],
  ];
  for (const [value, why] of bad) assert.throws(() => normOvermatch(value), why, JSON.stringify(value));
});

test('a strategy file may say mode, ratio and the crowd wall; the health lines are refused there', () => {
  for (const fine of ['auto', 'on', 'off', true, false, { prey_ratio: 2 }, { mode: 'off' }, { wall_at_attackers: 3 }])
    assert.doesNotThrow(() => normOvermatchForStrategy(fine), JSON.stringify(fine));
  assert.equal(normOvermatchForStrategy('off'), 'off', 'stored as written');
  for (const survival of [{ rest_below: 0.2 }, { fleeBelow: 0.1 }, { resume_above: 0.5 }])
    assert.throws(() => normOvermatchForStrategy(survival), /is survival and stays with the keeper/, JSON.stringify(survival));
  assert.throws(() => normOvermatchForStrategy('sometimes'), /overmatch must be/);
});

// ------------------------------------------------------------------ the verdict

const CV = [75, 55];                       // room 38: skeleton, zombie
const cv = (over = {}) => overmatchVerdict({ policy: 'auto', farming: true, maxHealth: 143, roomLevels: CV,
  visibleLevels: [75, 55, 75], ...over });

test('verdict: Kermit (143) against Castle Victoria (level 75) is overmatched at 1.8, and carries the lines', () => {
  const v = cv();
  assert.equal(v.active, true, v.why);
  assert.equal(v.mode, 'auto'); assert.equal(v.ratio, 1.91); assert.equal(v.prey_level, 75);
  assert.equal(v.prey_ratio_wanted, 1.8);
  assert.equal(v.rest_below, 0.34); assert.equal(v.resume_above, 0.67); assert.equal(v.flee_below, 0.25);
  assert.equal(v.wall_at_attackers, null);
  assert.match(v.why, /143 health over the strongest thing here \(level 75\) is 1\.91, at least 1\.8/);
  for (const hp of [146, 148, 149, 150]) assert.equal(cv({ maxHealth: hp }).active, true, `${hp}`);
  // The strict 2 of second-wind farming excludes all four of them: that is why this is 1.8.
  assert.equal(cv({ policy: { prey_ratio: 2 } }).active, false);
  assert.equal(cv({ policy: { prey_ratio: 2 }, maxHealth: 150 }).active, true);
});

test('verdict: the comparison is exact, never the rounded ratio', () => {
  // 134.9 / 75 rounds to 1.8 and is under it.
  const v = cv({ maxHealth: 134.9 });
  assert.equal(v.ratio, 1.8); assert.equal(v.active, false);
  assert.equal(cv({ maxHealth: 135 }).active, true);
});

test('verdict: what can STAND in the room decides, not what is hunted', () => {
  // 150 against trolls (90) and the stone troll (120); 150 in the sewers with a level-105 lupogg; 40 against level 50.
  for (const [maxHealth, roomLevels] of [[150, [90]], [150, [120, 90]], [150, [30, 105]], [40, [50]], [99, [75, 55]]]) {
    const v = overmatchVerdict({ policy: 'auto', farming: true, maxHealth, roomLevels });
    assert.equal(v.active, false, `${maxHealth} vs ${roomLevels}`);
    assert.match(v.why, /not overmatched: .* under 1\.8/);
  }
  // A stronger creature that walked in counts while it is in sight, whatever the table says.
  const troll = cv({ maxHealth: 150, visibleLevels: [75, 90] });
  assert.equal(troll.active, false); assert.equal(troll.prey_level, 90);
  assert.equal(cv({ maxHealth: 150, visibleLevels: [75] }).active, true);
});

test('verdict: every inactive answer says why in one sentence', () => {
  const cases = [
    [{ policy: 'off' }, /overmatch is off for this character/],
    [{ policy: false }, /overmatch is off/],
    [{ farming: false }, /^not farming$/],
    [{ held: 'travelling to 106' }, /^travelling to 106$/],
    [{ maxHealth: null }, /own maximum health unknown/],
    [{ maxHealth: 0 }, /own maximum health unknown/],
    [{ recovering: true }, /recovering from a death/],
    [{ ailing: 'poison' }, /^poison: the ordinary ladder shelters and mends it first$/],
    [{ ailing: true }, /^poisoned or diseased: /],
    [{ roomUnknown: ['shadow mummy'] }, /this room can spawn a creature of unknown level \(shadow mummy\)/],
    [{ pvp: true }, /player-versus-player/],
    [{ pvp: 'a player attacked this character 12 s ago' }, /a player attacked this character 12 s ago/],
    [{ roomLevels: [] }, /nothing known about what this room spawns/],
    [{ roomLevels: null }, /nothing known about what this room spawns/],
    [{ visibleUnknown: ['Varuka the wanderer'] }, /a creature of unknown level is in sight \(Varuka the wanderer\)/],
    [{ policy: 'sometimes' }, /unreadable/],
  ];
  for (const [over, why] of cases) {
    const v = cv(over);
    assert.equal(v.active, false, JSON.stringify(over));
    assert.match(v.why, why, JSON.stringify(over));
    assert.ok(!/\n/.test(v.why));
  }
  assert.equal(cv({ policy: 'sometimes' }).mode, 'invalid');
});

test("verdict: 'on' needs only farming, a known bar, no recovery and no PvP; 'off' is off whatever the prey", () => {
  const on = over => overmatchVerdict({ policy: 'on', farming: true, maxHealth: 60, roomLevels: [120], ...over });
  assert.equal(on().active, true);
  assert.equal(on({ roomLevels: null, visibleUnknown: ['thing'] }).active, true, 'on does not ask about the room');
  assert.equal(on({ farming: false }).active, false);
  assert.equal(on({ maxHealth: undefined }).active, false);
  assert.equal(on({ recovering: true }).active, false);
  assert.equal(on({ ailing: 'poison' }).active, false);
  assert.equal(on({ pvp: true }).active, false);
  assert.equal(on({ held: 'on an errand' }).active, false);
  assert.equal(overmatchVerdict({ policy: 'off', farming: true, maxHealth: 500, roomLevels: [10] }).active, false);
  assert.equal(overmatchVerdict({ farming: true, maxHealth: 500, roomLevels: [10] }).active, true, 'no policy at all is auto');
  // The lines travel with the verdict either way, so status can show what WOULD apply.
  const lines = overmatchVerdict({ policy: { rest_below: 0.5, resume_above: 0.9, flee_below: 0.3 }, farming: false });
  assert.deepEqual([lines.rest_below, lines.resume_above, lines.flee_below], [0.5, 0.9, 0.3]);
});

test('the vigor margin clears the Second Wind trigger', () => {
  assert.ok(20 + OVERMATCH_VIGOR_MARGIN > 25, 'a body released from a spent rest is above the trigger it then fights down to');
});

// ================================================================== THE WIRING
//
// One fake keeper, standing in Castle Victoria (38) -- or wherever a case puts it -- built on Autopilot.prototype so
// every faculty under test is the real method, with only the parts that would walk, cast or log off replaced.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const HEALING = mkdtempSync(join(tmpdir(), 'm59-overmatch-healing-'));
process.env.M59_HEALING_DIR = HEALING;                    // read at call time (m59-healing-session.mjs)
process.on('exit', () => { try { rmSync(HEALING, { recursive: true, force: true }); } catch {} });

const { Autopilot, CONTINUE, HANDLED, MIN_FIGHT_VIGOR, ORDINARY_VIGOR_FLOOR } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const skills = await import('./m59-skills.mjs');

const NAMES = new Map([[1, 'skeleton'], [2, 'zombie'], [3, 'troll'], [4, 'Varuka the wanderer'], [5, 'giant rat'],
                       [9, 'second wind'], [10, 'parry']]);
const PROD = { hunt: ['skeleton', 'zombie'], restBelow: 0.6, fleeBelow: 0.4, holdResumeAbove: 0.9, pullToSafeWall: false,
               requireSafeWall: false, wallAtAttackers: 2, fightAboveVigor: 80, assignedRoom: 38 };

function keeper({ maxHealth = 150, health = maxHealth, vigor = 70, restThreshold = 80, room = 38, mode = 'farm',
                  policy = {}, monsters = [], secondWind = false, ability = 40 } = {}) {
  const objects = new Map();
  const state = { health, vigor, restThreshold, rests: 0, reads: 0, onRead: null };
  const c = {
    selfId: 99, state: 'game', combatReady: true, inventoryAt: 1, items: [], inventory: [], evSeq: 0, events: [],
    rsc: { get: n => NAMES.get(n) },
    room: { id: 5000 + room, objects },
    skills: [{ nameRsc: secondWind ? 9 : 10 }],
    abilityOf: n => (secondWind && n === 'second wind' ? ability : null),
    vitals: () => ({ health: { value: state.health, max: maxHealth }, mana: { value: 20, max: 20 },
                     vigor: { value: state.vigor, scale_max: 200, rest_threshold: state.restThreshold } }),
    ailments: () => [],
    equipment: () => ({ known: true, equipped: [{ name: 'long sword' }] }),
    stats: () => { state.reads++; state.onRead?.(state); }, waitFor: async () => {},
    rest: () => { state.rests++; }, stand: () => {},
    get self() { return objects.get(99); },
  };
  objects.set(99, { id: 99, col: 20, row: 20, x: 20 * 64 + 32, y: 20 * 64 + 32, flags: 0 });
  monsters.forEach((m, i) => objects.set(100 + i, { id: 100 + i, nameRsc: m.rsc ?? 1, col: 20 + (m.dcol ?? 1),
                                                   row: 20 + (m.drow ?? 0), flags: OF.ATTACKABLE }));
  const notes = [], walls = [];
  const s = { name: 'omtest', live: true, client: c, need: () => c, pacer: { submit: async (_k, fn) => fn() },
              world: { room: { num: room, name: 'Castle Victoria' }, geometry: null, exits: () => [] } };
  const ap = Object.assign(Object.create(Autopilot.prototype), {
    mode, s, policy: { ...PROD, ...policy }, vigor: { starved_passes: 0 }, claims: new Map(), tally: { rests: 0 },
    journal: [], notes, walls, hold: null,
    note(what, detail) { notes.push({ what, detail }); },
    progress() {}, noProgress() {},
    // The parts of the survival stage that would move the body, cast or log off: counted, never performed.
    operatorSurvivalStandDown: () => false, farmBuffPass: async () => false,
    escapeIfWedgedAndHurt: async () => false, tradeInPlaceIfWedged: async () => false, defensiveAnswer: async () => false,
    tryOceanCooperativeEscape: async () => false, leaveForCasters: async () => false,
    playDead: async why => { walls.push(['logoff', why]); return false; },
    settle: async () => {}, eatToFloor: async () => null, healObservedFleetmate: async () => false,
    isRoomEnchantPost: () => false, travelInterrupted: () => false, tooTiredToTravel: () => false,
    currentRecoveryWall() { return this.hold; },
    adoptRecoveryWall() { walls.push(['adopt']); return !!this.hold; },
    takeRecoverySpot: async why => { walls.push(['recovery', why]); return { took: false, why: 'fixture: no wall' }; },
    takeSafeSpot: async why => { walls.push(['voluntary', why]); return { took: false, why: 'fixture: no wall' }; },
    recordHealUse() {}, restBroken: async () => { walls.push(['rest broken']); },
    breakOut: async () => ({ did: false }), provision: async () => false, declareInterest() {},
    leaveHold: async function (why) { walls.push(['leave', why]); this.hold = null; return { left: true }; },
    releaseHold(why) { walls.push(['release', why]); this.hold = null; this.pendingPull = null; },
  });
  const pass = () => ap.passFleeAndRest({ s, c, room: s.world.room, v: c.vitals(), hp: state.health / maxHealth });
  return { ap, c, s, state, objects, notes, walls, pass };
}
const said = (k, what) => k.notes.filter(n => n.what === what);
const two = [{ rsc: 1, dcol: 1 }, { rsc: 2, dcol: 0, drow: 1 }];          // a skeleton and a zombie inside melee reach
const ON = 'overmatch on: fighting in the open, resting only when badly hurt';
const WALL_FIRST = 'hurt in a room that spawns monsters — a wall before a rest';

test('keeper: the verdict is gathered from the room it stands in, and says why it is off', () => {
  const on = keeper({ maxHealth: 143, monsters: two });
  const v = on.ap.overmatch();
  assert.equal(v.active, true, v.why); assert.equal(v.prey_level, 75); assert.equal(v.ratio, 1.91);
  const why = (over, pattern) => {
    const k = keeper({ maxHealth: 150, monsters: two, ...over });
    over.arrange?.(k);
    const got = k.ap.overmatch();
    assert.equal(got.active, false, JSON.stringify(got));
    assert.match(got.why, pattern);
  };
  why({ monsters: [...two, { rsc: 3, dcol: 6 }] }, /not overmatched: 150 health over the strongest thing here \(level 90\)/);   // a troll walked in
  why({ monsters: [...two, { rsc: 4, dcol: 9 }] }, /a creature of unknown level is in sight \(varuka the wanderer\)/);
  why({ room: 377, policy: { hunt: 'giant rat', assignedRoom: 377 }, monsters: [{ rsc: 5 }] }, /level 105/);   // the lupogg's room
  why({ room: 599, policy: { hunt: 'troll', assignedRoom: 599 } }, /level 120/);                               // trolls and the stone troll
  why({ room: 99999 }, /nothing known about what this room spawns/);
  why({ maxHealth: 99 }, /not overmatched: 99 health/);
  why({ mode: 'survive' }, /^not farming$/);
  why({ policy: { hunt: null } }, /^not farming$/);
  why({ policy: { neverAttack: true } }, /^not farming$/);
  why({ policy: { overmatch: 'off' } }, /overmatch is off/);
  why({ policy: { overmatch: 'sometimes' } }, /unreadable/);
  why({ arrange: k => { k.ap.inert = { travelling: true, to: 106 }; } }, /travelling: a journey keeps its own lines/);
  why({ arrange: k => { k.ap.inert = { why: 'selling' }; } }, /on an errand/);
  why({ arrange: k => { k.ap.suspendedJourney = { to: 38 }; } }, /suspended journey/);
  why({ arrange: k => { k.ap.stopping = true; } }, /stopping/);
  why({ arrange: k => { k.ap.claims.set('work', { owner: 'dum', until: Date.now() + 60_000 }); } }, /the work faculty is held by dum/);
  why({ arrange: k => { k.ap.recoverUntilWhole = true; } }, /recovering from a death/);
  why({ arrange: k => { k.c.ailments = () => [{ name: 'Poison' }]; } }, /^poison: the ordinary ladder shelters/);
  // The Mausoleum can spawn a shadow mummy whose level nobody wrote down: that is not a room to be confident in.
  why({ maxHealth: 400, room: 1006, policy: { hunt: 'mummy', assignedRoom: 1006 }, monsters: [] }, /this room can spawn a creature of unknown level/);
  why({ arrange: k => { k.ap.playerAttacks = [{ at: Date.now() - 20_000, name: 'Morpheus' }]; } }, /Morpheus attacked this character 20 s ago/);
  why({ arrange: k => { k.s.combat = { active: { id: 'k1', pvp: true } }; } }, /faculty is held by combat:k1|player-versus-player/);
  // A townsperson the room creates is not a creature of unknown level: the Badlands' priestess does not veto the
  // verdict, and its level-100 groundworm decides it.
  assert.equal(keeper({ maxHealth: 200, room: 45, policy: { hunt: 'ant', assignedRoom: 45 } }).ap.overmatch().active, true);
  assert.match(keeper({ maxHealth: 150, room: 45, policy: { hunt: 'ant', assignedRoom: 45 } }).ap.overmatch().why, /level 100/);
  // A player's blow long ago is not an episode any more.
  const calm = keeper({ monsters: two }); calm.ap.playerAttacks = [{ at: Date.now() - 6 * 60_000, name: 'Morpheus' }];
  assert.equal(calm.ap.overmatch().active, true);
  // Other PLAYERS in the room are not hostile creatures: a fleet-mate standing here changes nothing.
  const crowd = keeper({ monsters: two });
  crowd.objects.set(500, { id: 500, nameRsc: 4, col: 21, row: 21, flags: OF.ATTACKABLE | OF.PLAYER });
  assert.equal(crowd.ap.overmatch().active, true);
});

test('keeper: one journal note on each edge, never one a question', () => {
  const k = keeper({ maxHealth: 150, monsters: two });
  for (let i = 0; i < 25; i++) k.ap.overmatch();
  assert.equal(said(k, ON).length, 1);
  k.objects.set(300, { id: 300, nameRsc: 3, col: 28, row: 20, flags: OF.ATTACKABLE });        // a troll walks in
  for (let i = 0; i < 25; i++) k.ap.overmatch();
  const off = said(k, 'overmatch off: back to the ordinary lines and walls');
  assert.equal(off.length, 1); assert.match(off[0].detail.why, /level 90/);
  k.objects.delete(300);
  k.ap.overmatch();
  assert.equal(said(k, ON).length, 2);
  // Between connections there is no body to read: off, and NOT an edge (a play-dead logoff is not news about the lines).
  const client = k.s.client; k.s.client = null;
  assert.equal(k.ap.overmatch().active, false); assert.match(k.ap.overmatch().why, /no connection/);
  k.s.client = client; k.ap.overmatch();
  assert.equal(said(k, ON).length, 2);
  assert.equal(said(k, 'overmatch off: back to the ordinary lines and walls').length, 1);
  // A keeper that was never overmatched says nothing at all.
  const weak = keeper({ maxHealth: 80, monsters: two });
  for (let i = 0; i < 5; i++) weak.ap.overmatch();
  assert.equal(weak.notes.length, 0);
});

test("health lines: the verdict's while overmatched; exactly the old arithmetic otherwise", () => {
  const on = keeper({ maxHealth: 150, monsters: two });
  assert.deepEqual(on.ap.safety(), { maxHit: 30, fleeAt: 0.25, engageAt: 0.34, overmatch: true });
  assert.deepEqual(on.ap.healthLines(), { overmatch: true, rest: 0.34, resume: 0.67, engage: 0.34, flee: 0.25, fleeBelow: 0.25 });
  // An operator's own lines travel through the same accessor.
  const tuned = keeper({ monsters: two, policy: { overmatch: { rest_below: 0.5, resume_above: 0.8, flee_below: 0.3 } } });
  assert.deepEqual([tuned.ap.safety().engageAt, tuned.ap.safety().fleeAt, tuned.ap.healthLines().resume], [0.5, 0.3, 0.8]);
  // NOT overmatched: byte for byte what skills.safetyFor says, and the raw policy numbers.
  for (const k of [keeper({ maxHealth: 99, monsters: two }), keeper({ policy: { overmatch: 'off' }, monsters: two }),
                   keeper({ room: 599, policy: { hunt: 'troll' } }), keeper({ maxHealth: 25, monsters: two }), keeper({ mode: 'survive' })]) {
    assert.deepEqual(k.ap.safety(), skills.safetyFor(k.c, k.ap.policy));
    const lines = k.ap.healthLines();
    assert.equal(lines.overmatch, false);
    assert.deepEqual([lines.rest, lines.resume, lines.fleeBelow], [0.6, 0.9, 0.4]);
    assert.deepEqual([lines.engage, lines.flee], [k.ap.safety().engageAt, k.ap.safety().fleeAt]);
  }
  assert.equal(keeper({ policy: { overmatch: 'off' } }).ap.safety().engageAt, 0.75, 'the line no policy could lower');
});

test('combat wall: an overmatched farmer takes none, whatever the crowd and whatever pull_to_safe_wall says', () => {
  const three = [...two, { rsc: 1, dcol: -1 }];
  const k = keeper({ maxHealth: 150, monsters: three });
  const v = k.ap.holdWorthwhile(['skeleton', 'zombie']);
  assert.equal(v.hold, false); assert.equal(v.attackers, 3); assert.equal(v.overmatch, true);
  assert.match(v.why, /^overmatched \(150 health over the strongest thing here \(level 75\) is 2, at least 1\.8\)/);
  assert.equal(k.ap.fightOpensFromWall(), false);
  // Kermit, t21, t4 and t12 carry pull_to_safe_wall true in the roster (it was the default): they are the farmers the
  // order names, so the posture does not outrank the predicate.
  for (const posture of [{ pullToSafeWall: true }, { requireSafeWall: true, pullToSafeWall: undefined }]) {
    const pulled = keeper({ maxHealth: 143, monsters: three, policy: posture });
    assert.equal(pulled.ap.holdWorthwhile(['skeleton']).hold, false, JSON.stringify(posture));
    assert.equal(pulled.ap.fightOpensFromWall(), false, JSON.stringify(posture));
  }
  // The one way back to a crowd wall is the verdict's own bar.
  const barred = keeper({ monsters: three, policy: { overmatch: { wall_at_attackers: 3 } } });
  const b = barred.ap.holdWorthwhile(['skeleton']);
  assert.equal(b.hold, true); assert.equal(b.bar, 3); assert.match(b.why, /overmatch\.wall_at_attackers of 3/);
  assert.equal(keeper({ monsters: two, policy: { overmatch: { wall_at_attackers: 3 } } }).ap.holdWorthwhile(['skeleton']).hold, false);
});

test('combat wall: a farmer that is NOT overmatched answers exactly as before', () => {
  const same = (a, b, names) => {
    const x = a.ap.holdWorthwhile(names), y = b.ap.holdWorthwhile(names);
    assert.equal(x.overmatch, undefined);
    assert.deepEqual(x, y);
    return x;
  };
  // 99 health in Castle Victoria under 'auto' against the same body with overmatch switched off: two in reach is a wall.
  const crowd = same(keeper({ maxHealth: 99, monsters: two }), keeper({ maxHealth: 99, monsters: two, policy: { overmatch: 'off' } }), ['skeleton']);
  assert.equal(crowd.hold, true); assert.equal(crowd.bar, 2);
  // And 150 health with overmatch off is the body the fleet has today: the wall at two attackers.
  const today = keeper({ maxHealth: 150, monsters: two, policy: { overmatch: 'off' } }).ap;
  assert.equal(today.holdWorthwhile(['skeleton']).hold, true);
  assert.equal(today.fightOpensFromWall(), false);
  // Trolls: the pull posture stands, and the old outclass arithmetic still answers (level 90 against 150).
  const pull = keeper({ maxHealth: 150, monsters: [{ rsc: 3, dcol: 2 }], room: 599, policy: { hunt: 'troll', pullToSafeWall: true } }).ap;
  assert.equal(pull.fightOpensFromWall(), true);
  assert.equal(pull.holdWorthwhile(['troll']).hold, false);
  assert.equal(keeper({ maxHealth: 80, monsters: two, policy: { pullToSafeWall: true } }).ap.fightOpensFromWall(), true);
});

test('fight floor: the ordinary floor while overmatched, 0 with Second Wind, the old floor otherwise', () => {
  assert.equal(keeper({ monsters: two }).ap.fightFloor(), ORDINARY_VIGOR_FLOOR);
  assert.equal(keeper({ monsters: two, policy: { ordinaryVigorFloor: 30 } }).ap.fightFloor(), 30);
  assert.equal(keeper({ monsters: two, secondWind: true }).ap.fightFloor(), 0);
  for (const k of [keeper({ maxHealth: 99, monsters: two }), keeper({ monsters: two, policy: { overmatch: 'off' } }),
                   keeper({ room: 599, policy: { hunt: 'troll' } })])
    assert.ok(k.ap.fightFloor() >= Math.min(MIN_FIGHT_VIGOR, 70), `the old floor: ${k.ap.fightFloor()}`);
});

test('second wind: auto asks the overmatch predicate; a written ratio keeps its older meaning', () => {
  const strong = keeper({ maxHealth: 143, monsters: two, secondWind: true });
  const sw = strong.ap.secondWindFarming();
  assert.equal(sw.active, true); assert.equal(sw.by, 'overmatch'); assert.match(sw.why, /^overmatched: 143 health/);
  // 143 over level 75 is 1.91: under second wind's own 2, over overmatch's 1.8. A WRITTEN ratio of 2 still refuses.
  const written = { secondWindFarming: { prey_ratio: 2 } };
  assert.equal(keeper({ maxHealth: 143, monsters: two, secondWind: true, policy: written }).ap.secondWindFarming().active, false);
  assert.equal(keeper({ maxHealth: 150, monsters: two, secondWind: true, policy: written }).ap.secondWindFarming().active, true);
  // Not overmatched, no skill, or either switched off: the old floor and the old meals.
  for (const k of [keeper({ maxHealth: 99, monsters: two, secondWind: true }), keeper({ monsters: two }),
                   keeper({ monsters: two, secondWind: true, policy: { overmatch: 'off' } }),
                   keeper({ monsters: two, secondWind: true, policy: { secondWindFarming: 'off' } })])
    assert.equal(k.ap.secondWindFarming().active, false);
  // The memo follows the predicate: a troll walking in ends it on the next question, not thirty seconds later.
  assert.equal(strong.ap.secondWindFarming().active, true);
  strong.objects.set(300, { id: 300, nameRsc: 3, col: 27, row: 20, flags: OF.ATTACKABLE });
  assert.equal(strong.ap.secondWindFarming().active, false);
});

test('THE CASE THE A/B FOUND: 60% health and 70 vigor is not hurt, takes no wall, and will engage', async () => {
  for (const posture of [{}, { pullToSafeWall: true, requireSafeWall: true, restBelow: 0.8, fleeBelow: 0.45 }]) {
    const k = keeper({ maxHealth: 143, health: 86, vigor: 70, monsters: two, policy: posture });
    assert.equal(await k.pass(), CONTINUE, 'the survival stage has nothing to do');
    assert.deepEqual(k.walls, [], 'no wall, no logoff');
    assert.equal(k.ap.hold, null);
    assert.ok(86 / 143 >= k.ap.safety().engageAt, 'above the line a fight is opened at');
    assert.ok(k.state.vigor >= k.ap.fightFloor(), 'above the vigor a fight is opened at');
    assert.equal(k.ap.holdWorthwhile(['skeleton', 'zombie']).hold, false);
    assert.equal(k.ap.fightOpensFromWall(), false);
    assert.equal(k.state.rests, 0);
  }
  // The same body with overmatch switched off is the farmer on the board today: under engageAt 0.75, it goes for a wall.
  const today = keeper({ maxHealth: 143, health: 86, vigor: 70, monsters: two, policy: { overmatch: 'off' } });
  assert.equal(await today.pass(), CONTINUE);
  assert.deepEqual(today.walls, [['recovery', WALL_FIRST]]);
  // And so does a body that is not overmatched at all: 99 health against level 75.
  const weak = keeper({ maxHealth: 99, health: 60, vigor: 70, monsters: two });
  await weak.pass();
  assert.deepEqual(weak.walls, [['recovery', WALL_FIRST]]);
});

test('vigor: under the resting cap is not hurt; only spent is, and that is a voluntary stop with no logoff', async () => {
  // 79 of 200 at 95% health: the oscillation. Overmatched, nothing happens.
  const k = keeper({ maxHealth: 150, health: 143, vigor: 79, monsters: two });
  assert.equal(await k.pass(), CONTINUE); assert.deepEqual(k.walls, []);
  // With overmatch off, the same reading is "hurt" and a wall.
  const today = keeper({ maxHealth: 150, health: 143, vigor: 79, monsters: two, policy: { overmatch: 'off' } });
  await today.pass();
  assert.deepEqual(today.walls, [['recovery', WALL_FIRST]]);
  // Spent: under the ordinary floor. A wall, the voluntary way.
  const spent = keeper({ maxHealth: 150, health: 143, vigor: 15, monsters: two });
  await spent.pass();
  assert.deepEqual(spent.walls, [['voluntary', 'low vigor — a wall before a rest']]);
  assert.ok(spent.ap.spentRestSince > 0);
});

test('health: below a third is hurt and goes for a wall; a hair above it is not', async () => {
  const k = keeper({ maxHealth: 150, health: 50, vigor: 120, monsters: [{ rsc: 1, dcol: 6 }] });      // 33%, nothing adjacent
  assert.equal(await k.pass(), HANDLED);
  assert.deepEqual(k.walls[0], ['voluntary', 'hurt, and far stronger than this room — a wall before a rest']);
  // No wall to be had in this fixture, so the room-retreat rung speaks -- on the overmatch rest line, not the policy's 60%.
  assert.equal(said(k, 'leaving the room to recover safely')[0].detail.retreat_below, '34%');
  const fine = keeper({ maxHealth: 150, health: 52, vigor: 120, monsters: [{ rsc: 1, dcol: 6 }] });   // 34.7%
  assert.equal(await fine.pass(), CONTINUE); assert.deepEqual(fine.walls, []);
});

test('a rest begun spent runs to its bar: the resting cap, or just clear of the floor when Second Wind is the supply', async () => {
  const plain = keeper({ maxHealth: 150, health: 150, vigor: 15, monsters: two });
  assert.deepEqual(plain.ap.overmatchVigor(), { floor: 20, ceiling: 80, rest: 80, second_wind: false, raw: 15, blocked: false });
  await plain.pass();                                   // sits down spent
  plain.state.vigor = 45; plain.walls.length = 0; plain.ap.wallTriedAt = 0;
  await plain.pass();                                   // 45: no longer spent, still resting to the cap
  assert.equal(plain.walls[0]?.[0], 'voluntary', 'still asking for its wall at 45');
  plain.state.vigor = 80; plain.walls.length = 0; plain.ap.wallTriedAt = 0;
  assert.equal(await plain.pass(), CONTINUE); assert.deepEqual(plain.walls, []); assert.equal(plain.ap.spentRestSince, null);
  // Second Wind: the bar is floor + margin, above the trigger at 25.
  const sw = keeper({ maxHealth: 150, health: 150, vigor: 15, monsters: two, secondWind: true });
  assert.equal(sw.ap.overmatchVigor().rest, 20 + OVERMATCH_VIGOR_MARGIN);
  await sw.pass();
  sw.state.vigor = 31; sw.walls.length = 0; sw.ap.wallTriedAt = 0;
  assert.equal(await sw.pass(), CONTINUE); assert.deepEqual(sw.walls, []);
  // A ceiling the keeper did not model never parks a body that is no longer spent: sitting can earn nothing more.
  const capped = keeper({ maxHealth: 150, health: 150, vigor: 15, monsters: two });
  await capped.pass();
  capped.state.vigor = 40; capped.state.restThreshold = 40; capped.walls.length = 0; capped.ap.wallTriedAt = 0;
  assert.equal(capped.ap.overmatchVigor().blocked, true);
  assert.equal(await capped.pass(), CONTINUE); assert.deepEqual(capped.walls, []);
});

test('spent while Second Wind runs: it waits on its wall, on its feet, and says so once', async () => {
  const k = keeper({ maxHealth: 150, health: 150, vigor: 15, restThreshold: 10, monsters: two, secondWind: true });
  k.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
  assert.equal(k.ap.overmatchVigor().blocked, true);
  for (let i = 0; i < 3; i++) assert.equal(await k.pass(), HANDLED);
  assert.equal(k.state.rests, 0, 'never sat down: a rest here earns nothing');
  assert.equal(k.ap.doing, 'waiting');
  assert.equal(said(k, 'spent, and resting cannot pay yet — waiting it out').length, 1);
  assert.ok(!k.walls.some(w => ['rest broken', 'logoff', 'release', 'leave', 'recovery'].includes(w[0])), JSON.stringify(k.walls));
  assert.ok(k.ap.hold, 'the wall is kept');
  // The skill ends: the threshold returns, and the rest is taken (to 30, which this body has by the first read).
  k.state.restThreshold = 90; k.state.onRead = st => { st.vigor = 31; };
  assert.equal(await k.pass(), HANDLED);
  assert.equal(said(k, 'rested').at(-1).detail.why, 'already recovered');
});

test('a health rest ends just above the resume line, and the wall is given back there', async () => {
  // Sheltered at 50%: resting. The first read finds 70% -- over the resume line -- and the rest is over at once.
  const k = keeper({ maxHealth: 150, health: 75, vigor: 60, monsters: [{ rsc: 1, dcol: 6 }] });
  k.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
  k.state.onRead = st => { st.health = 105; };
  assert.equal(await k.pass(), HANDLED);
  assert.equal(k.state.rests, 0, 'did not sit on for nine tenths');
  assert.equal(said(k, 'rested').at(-1).detail.why, 'already recovered');
  // Next pass: 70%, nothing in reach. The rested hold is left -- at 0.67, not 0.9.
  assert.equal(await k.pass(), CONTINUE);
  assert.deepEqual(k.walls.filter(w => w[0] === 'leave'), [['leave', 'rested to the ceiling — back on the road']]);
  assert.equal(said(k, 'leaving the wall — rested to the overmatch lines').length, 1);
});

test('releaseRestedHold: the resume line and the vigor bar while overmatched; nine tenths and the cap otherwise', async () => {
  const held = (over, arrange = null) => {
    const k = keeper({ monsters: [{ rsc: 1, dcol: 6 }], ...over });
    k.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
    arrange?.(k);
    return k.ap.releaseRestedHold();
  };
  const satDownSpent = k => { k.ap.spentRestSince = Date.now() - 30_000; };
  assert.equal(await held({ health: 105, vigor: 70 }), true);                                    // 70%
  assert.equal(await held({ health: 96, vigor: 70 }), false);                                    // 64%: under the line
  assert.equal(await held({ health: 105, vigor: 15 }), false);                                   // spent
  assert.equal(await held({ health: 105, vigor: 25 }), true);                                    // a health rest: vigor is no reason to stay
  assert.equal(await held({ health: 105, vigor: 25 }, satDownSpent), false);                     // a rest begun spent runs to its bar (80)
  assert.equal(await held({ health: 105, vigor: 80 }, satDownSpent), true);
  assert.equal(await held({ health: 105, vigor: 31, secondWind: true }, satDownSpent), true);    // ...which is 30 on Second Wind
  assert.equal(await held({ health: 105, vigor: 25, restThreshold: 10 }, satDownSpent), true);   // ...or wherever sitting stops paying
  // The pull posture does not hold an overmatched farmer on its wall.
  assert.equal(await held({ health: 105, vigor: 70, policy: { pullToSafeWall: true } }), true);
  // Something in reach: the wall is still doing its job for this pass (the farm stage gives it back).
  assert.equal(await held({ health: 105, vigor: 70, monsters: two }), false);
  // NOT overmatched: exactly the old bars.
  assert.equal(await held({ health: 105, vigor: 80, policy: { overmatch: 'off' } }), false);     // 70% < 0.9
  assert.equal(await held({ health: 140, vigor: 79, policy: { overmatch: 'off' } }), false);     // vigor under the cap
  assert.equal(await held({ health: 140, vigor: 80, policy: { overmatch: 'off' } }), true);
  assert.equal(await held({ health: 140, vigor: 80, policy: { overmatch: 'off', pullToSafeWall: true } }), false);
  assert.equal(await held({ maxHealth: 99, health: 80, vigor: 80 }), false);                     // 81% < 0.9, not overmatched
});

test('death recovery and a journey keep the old lines: nothing here outranks them', async () => {
  const dead = keeper({ maxHealth: 150, health: 120, vigor: 80, monsters: two });       // 80%, back from the Underworld
  dead.ap.recoverUntilWhole = true; dead.ap.recoverSince = Date.now();
  assert.equal(dead.ap.safety().engageAt, 0.75);
  await dead.pass();
  assert.equal(dead.walls[0]?.[0], 'recovery', 'rests to whole: 80% is hurt while recovering');
  const road = keeper({ maxHealth: 150, health: 60, monsters: two }); road.ap.inert = { travelling: true, to: 106 };
  assert.deepEqual(road.ap.safety(), skills.safetyFor(road.c, road.ap.policy), 'the travel guard reads the old flee line');
  // A suspended journey rests to full on its wall, as it always did.
  const paused = keeper({ maxHealth: 150, health: 140, vigor: 80, monsters: [{ rsc: 1, dcol: 6 }] });
  paused.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
  paused.ap.suspendedJourney = { to: 106, origin: {} };
  assert.equal(await paused.ap.releaseRestedHold(), false);
});

test('the policy defaults are auto, for both keys', () => {
  const fresh = new Autopilot({ need() {}, client: null }, {});
  assert.equal(fresh.policy.overmatch, 'auto');
  assert.equal(fresh.policy.secondWindFarming, 'auto');
});

test('plumbing: the strategy-file key validates, refuses the health lines, and yields with `work`', async () => {
  const { validateStrategy, KEY_FACULTY, ARG_KEYS, PROTECTED_NAMES } = await import('./m59-strategy-schema.mjs');
  const file = extra => validateStrategy({ name: 'cv-test', hunt: ['skeleton'], ...extra });
  for (const value of ['auto', 'on', 'off', { prey_ratio: 2.5 }, { mode: 'off' }, { wall_at_attackers: 4 }]) {
    const r = file({ overmatch: value });
    assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.deepEqual(r.unrecognised, []);
    assert.deepEqual(r.strategy.desired.overmatch, value);
  }
  for (const value of ['sometimes', { rest_below: 0.2 }, { flee_below: 0.1 }, { resumeAbove: 0.5 }, { walls: 1 }]) {
    const r = file({ overmatch: value });
    assert.equal(r.ok, false, JSON.stringify(value));
    assert.equal(r.problems[0].path, 'overmatch');
  }
  assert.match(file({ overmatch: { rest_below: 0.2 } }).problems[0].why, /is survival and stays with the keeper/);
  assert.equal(KEY_FACULTY.overmatch, 'work');
  assert.deepEqual(ARG_KEYS.overmatch, ['overmatch']);
  assert.ok(PROTECTED_NAMES.restBelow && PROTECTED_NAMES.fleeBelow, 'the survival names are still refused at the top of a file');
});

// ------------------------------------------------------------------ the logoff, the session and the dispatcher

test('the logoff belongs to the flee line: above it a hurt overmatched farmer takes its wall the voluntary way', async () => {
  // 30%: under the rest line, over the flee line, two things adjacent, and a roster that says doomed_in_spot_below 0.35.
  // The wall is there to be taken (this fixture's default has none, and with none the open-floor rungs below are the
  // ones the ladder always had).
  const k = keeper({ maxHealth: 150, health: 45, vigor: 120, monsters: two, policy: { doomedInSpotBelow: 0.35 } });
  k.ap.takeSafeSpot = async function (why) {
    k.walls.push(['voluntary', why]);
    this.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
    return { took: true };
  };
  k.state.onRead = st => { st.health = 105; };            // the rest it then takes is over at the first read
  assert.equal(await k.pass(), HANDLED);
  assert.deepEqual(k.walls[0], ['voluntary', 'hurt, and far stronger than this room — a wall before a rest']);
  assert.ok(!k.walls.some(w => w[0] === 'logoff' || w[0] === 'recovery'), JSON.stringify(k.walls));
  assert.equal(said(k, 'took a wall before resting').length, 1);
  // 24%: under the flee line with something adjacent. The doomed rung's wall rush, and the logoff, as ever.
  const low = keeper({ maxHealth: 150, health: 36, vigor: 120, monsters: two });
  await low.pass();
  assert.match(low.walls[0][1], /^doomed at 36\/150 with 2 adjacent/);
  assert.ok(low.walls.some(w => w[0] === 'logoff'), JSON.stringify(low.walls));
  // With overmatch off the same 30% body IS doomed, on the policy's own threshold (0.3): nothing moved for it.
  const today = keeper({ maxHealth: 150, health: 45, vigor: 120, monsters: two, policy: { overmatch: 'off' } });
  await today.pass();
  assert.match(today.walls[0][1], /^doomed at 45\/150/);
  assert.ok(today.walls.some(w => w[0] === 'logoff'));
  // And on a held wall the roster's 0.35 does not outrank the verdict's rest line: 34.7% with something adjacent is a
  // farmer resting, not a farmer about to die.
  const onWall = keeper({ maxHealth: 150, health: 52, vigor: 120, monsters: two, policy: { doomedInSpotBelow: 0.35 } });
  onWall.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
  onWall.state.onRead = st => { st.health = 105; };
  await onWall.pass();
  assert.ok(!onWall.walls.some(w => w[0] === 'logoff'), JSON.stringify(onWall.walls));
});

test('a body that has spent its logoff heals as it always did: the old resume line until the healing session closes', async () => {
  const { noteLogoff } = await import('./m59-healing-session.mjs');
  const k = keeper({ maxHealth: 150, health: 105, vigor: 70, monsters: [{ rsc: 1, dcol: 6 }] });
  assert.equal(k.ap.healthLines().resume, 0.67);
  assert.equal(k.ap.overmatchRested(), true);
  noteLogoff('omtest', { why: 'fixture', room: 38 });
  try {
    const lines = k.ap.healthLines();
    assert.equal(lines.resume, 0.9, 'hold_resume_above, as before');
    assert.equal(lines.rest, 0.34, 'the rest line does not move');
    assert.equal(lines.healing_session, true);
    assert.equal(k.ap.overmatchRested(), false, '70% is not rested inside a spent session');
    k.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
    assert.equal(await k.ap.releaseRestedHold(), false);
    k.state.health = 136;
    assert.equal(await k.ap.releaseRestedHold(), true, '91% is');
  } finally { rmSync(join(HEALING, 'omtest.json'), { force: true }); }
  assert.equal(k.ap.healthLines().resume, 0.67);
});

test('the survival dispatcher ends an overmatched recovery at the same lines, and never one that is poisoned', async () => {
  const { chooseSurvivalDecision, currentSurvivalDecision } = await import('./m59-survival-decision.mjs');
  const resting = over => {
    const k = keeper({ monsters: [{ rsc: 1, dcol: 6 }], ...over });
    k.ap.hold = { room: 38, col: 20, row: 20, takenAt: Date.now(), proven: true };
    chooseSurvivalDecision(k.s, { strategy: 'rest_safe', status: 'recovering', reason: 'fixture', chosen_refuge: { room: 38, row: 20, col: 20 } });
    return k;
  };
  // 70% and 60 vigor: over the resume line, not spent. The recovery is over; the ladder gets the pass.
  const done = resting({ health: 105, vigor: 60 });
  assert.equal(await done.ap.continueSurvivalDecisionStep(), false);
  assert.equal(currentSurvivalDecision(done.s), null);
  // The same reading with overmatch off is a recovery still running: it rests to FULL health and the resting cap.
  const today = resting({ health: 105, vigor: 60, policy: { overmatch: 'off' } });
  assert.equal(today.ap.overmatchRested(), false);
  assert.ok(currentSurvivalDecision(today.s));
  // 60%: under the resume line. Still recovering, overmatched or not.
  assert.equal(resting({ health: 90, vigor: 60 }).ap.overmatchRested(), false);
  // Spent: still recovering, whatever the health.
  assert.equal(resting({ health: 150, vigor: 15 }).ap.overmatchRested(), false);
  // POISONED: the verdict is off, so the old rule holds the wall until the poison ends.
  const sick = resting({ health: 140, vigor: 80 });
  sick.c.ailments = () => [{ name: 'poison' }];
  assert.equal(sick.ap.overmatch().active, false);
  assert.match(sick.ap.overmatch().why, /poison/);
  assert.equal(sick.ap.overmatchRested(), false);
  assert.equal(sick.ap.safety().engageAt, 0.75);
});

test('a crowd wall asked for by name keeps its hysteresis; the default gives a wall back at once', () => {
  const src = Autopilot.prototype.passFarm.toString();
  // The release an overmatched farmer makes: at once when no crowd wall is configured, and with the floor clear when
  // overmatch.wall_at_attackers put one back (or the wall would be re-taken on the next pass, the thrash the bar is for).
  assert.match(src, /worth\.overmatch && this\.hold && !worth\.hold/);
  assert.match(src, /worth\.bar == null \|\| \(!this\.pendingPull && !\(this\.inReachOfUs\(\)\?\.length\)\)/);
  // And the release every other farmer makes is untouched (m59-safespot-test pins its shape too).
  assert.match(src, /!opensFightFromWall\(this\.policy\) && this\.hold && !worth\.hold\s*\n\s*&& !this\.pendingPull && !\(this\.inReachOfUs\(\)\?\.length\)/);
  assert.match(src, /this\.fightOpensFromWall\(\) && !this\.hold && room\?\.num != null/);
});

test('a death record says whether the body was fighting on the overmatch lines', () => {
  const k = keeper({ maxHealth: 150, monsters: two });
  k.ap.overmatch();
  assert.ok(k.ap.overmatchLast.at > 0);
  assert.deepEqual({ ...k.ap.overmatchLast, at: 0 }, { at: 0, room: 38, ratio: 2, prey_level: 75, rest_below: 0.34, flee_below: 0.25 });
  const never = keeper({ maxHealth: 80, monsters: two });
  never.ap.overmatch();
  assert.equal(never.ap.overmatchLast, undefined);
});
