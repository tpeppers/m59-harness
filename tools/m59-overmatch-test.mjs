#!/usr/bin/env node
// OVERMATCH (m59-overmatch.mjs), offline: the policy's normal form and its refusals, the verdict table, and then the
// wiring -- the one predicate asked by the combat wall (holdWorthwhile), the health lines (safety / healthLines), the
// rest gate (passFleeAndRest's `hurt`), the fight floor and the wall release -- on fake keepers standing in Castle
// Victoria (38: level-75 skeletons, level-55 zombies). No broker, keeper process, server or roster.
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
