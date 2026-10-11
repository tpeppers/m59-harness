// Offline guard for A SPARED CREATURE IN THE WAY (policy.spareBlockers, `lureSparedBlocker`,
// m59-spare.mjs grantProvoke/provokeExempt). Opens no socket.
//
//   node tools/m59-spare-blocker-test.mjs
//
// Operator, 2026-10-11: Qor casters must "walk the barloque sewers without fighting/killing its rats,
// even if they get stuck (... maybe sometimes you have to hit them once and then back up so they'll
// chase you to stop blocking you, etc.)". What is pinned:
//   * silence is the old behaviour: no spare_blockers, no lure;
//   * 'lure' backs off to the planned refuge and never swings;
//   * 'provoke' swings ONCE, and the spare veto is lifted for exactly that id and only during it;
//   * nothing is done while a fightable body is in reach (the trade's), below the flee line
//     (survival's), when not wedged, or past the per-room budget;
//   * the rungs that pick a target to swing at never pick a spared body.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OF } from './m59-parse.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { vetoSpared, provokeExempt, grantProvoke, endProvoke, spareBlockerMode, PROVOKE_WINDOW_MS } from './m59-spare.mjs';
import { findCreature } from './m59-skills.mjs';
import { validateStrategy, STRATEGY_FIELDS } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

const RAT = 2, LUPOGG = 3;
// A one-square pipe in the Barloque sewers (108 row 27): us at r27c38, a rat at r27c39 ahead.
function keeper({ mode = 'lure', spare = ['giant rat'], hp = 70, max = 70, fleeAt = 0.5, wedged = true,
                  bodies = [[10, RAT, 27, 39]], plan = true, took = true, beingHit = false } = {}) {
  const names = new Map([[RAT, 'giant rat'], [LUPOGG, 'lupogg']]);
  const objects = new Map(bodies.map(([id, rsc, row, col]) => [id, { id, nameRsc: rsc, flags: OF.ATTACKABLE, row, col }]));
  const self = { id: 1, row: 27, col: 38 };
  const c = { selfId: 1, self, rsc: { get: k => names.get(k) ?? '' }, room: { objects },
              vitals: () => ({ health: { value: hp, max } }) };
  const log = { notes: [], events: [], fights: [], spots: [], exemptDuringFight: [] };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { spareCreatures: spare, spareBlockers: mode };
  ap.tally = {};
  ap.hold = null;
  ap.holdWorks = () => false;
  ap.watch = { attack: beingHit ? { since: Date.now(), hits: 1 } : null };
  ap.safety = () => ({ fleeAt });
  ap.wedgedInPlace = () => (wedged ? { why: 'same square for 20s' } : null);
  ap.note = (what, detail) => log.notes.push({ what, detail });
  ap.progress = () => {};
  ap.blockerEvent = (phase, detail) => log.events.push({ phase, ...detail });
  ap.observeBlockerLure = () => {};
  ap.weaponPriorityNow = () => null;
  ap.bannedWeaponsNow = () => null;
  ap.planBlockerLure = () => (plan ? { spot: { row: 27, col: 30 }, filter: () => true } : null);
  ap.takeSafeSpot = async (why, _q, opts) => { log.spots.push({ why, opts }); return { took, spot: { row: 27, col: 30 } }; };
  ap.fightNow = async (o) => {
    log.fights.push(o);
    log.exemptDuringFight.push(provokeExempt(ap.s, o.exactTargetId));
    return { fought: true, landed_hits: 1, killed: false };
  };
  ap.s = { client: c, world: { room: { num: 108 } }, movementGeneration: 1, sparePatterns: () => ap.policy.spareCreatures };
  const near = [...objects.values()];
  return { ap, c, log, near };
}

await ok('spare_blockers normalises: null/off -> null, lure/provoke kept, anything else refused', () => {
  assert.equal(spareBlockerMode(null), null);
  assert.equal(spareBlockerMode('off'), null);
  assert.equal(spareBlockerMode('Lure'), 'lure');
  assert.equal(spareBlockerMode('provoke'), 'provoke');
  assert.throws(() => spareBlockerMode('kill'), /spare_blockers must be one of/);
});

await ok('silence is the old behaviour: no spare_blockers, no lure, no swing', async () => {
  const { ap, log, near } = keeper({ mode: null });
  assert.equal(await ap.lureSparedBlocker({ near }), false);
  assert.equal(log.spots.length + log.fights.length, 0);
});

await ok('lure: a spared rat alone in reach, wedged -> back off to the planned refuge, never swing', async () => {
  const { ap, log, near } = keeper();
  assert.equal(await ap.lureSparedBlocker({ near }), true);
  assert.equal(log.fights.length, 0, 'lure never swings');
  assert.equal(log.spots.length, 1);
  assert.equal(log.spots[0].opts.recovery, true);
  assert.equal(ap.pendingBlockerLure?.target_id, 10, 'the chase is watched by object id, not by name');
  assert.ok(log.events.some(e => e.phase === 'start' && e.mode === 'spared_lure'));
  assert.equal(ap.tally.spared_lures, 1);
});

await ok('provoke: ONE swing at exactly that id, the veto lifted only during it, then back off', async () => {
  const { ap, log, near } = keeper({ mode: 'provoke' });
  assert.equal(await ap.lureSparedBlocker({ near }), true);
  assert.equal(log.fights.length, 1);
  assert.equal(log.fights[0].rounds, 1);
  assert.equal(log.fights[0].exactTargetId, 10);
  assert.deepEqual(log.exemptDuringFight, [true], 'the spare filter lets this one id through for the swing');
  assert.equal(provokeExempt(ap.s, 10), false, '...and closes again straight after');
  assert.equal(log.spots.length, 1, 'then the retreat');
});

await ok('provoke does not swing when something is already hitting us: it is already drawn', async () => {
  const { ap, log, near } = keeper({ mode: 'provoke', beingHit: true });
  assert.equal(await ap.lureSparedBlocker({ near }), true);
  assert.equal(log.fights.length, 0);
  assert.equal(log.spots.length, 1);
});

await ok('a provoking swing that kills is reported loudly, not hidden', async () => {
  const { ap, log, near } = keeper({ mode: 'provoke' });
  ap.fightNow = async () => ({ fought: true, killed: true });
  assert.equal(await ap.lureSparedBlocker({ near }), true);
  assert.ok(log.notes.some(x => /SPARED BLOCKER DIED/.test(x.what)));
  assert.equal(ap.tally.spared_killed, 1);
});

await ok('not this rung: a fightable body in reach, below the flee line, not wedged, nothing spared', async () => {
  {
    const { ap, log, near } = keeper({ bodies: [[10, RAT, 27, 39], [11, LUPOGG, 26, 39]] });
    assert.equal(await ap.lureSparedBlocker({ near }), false, 'the lupogg is the trade\'s');
    assert.equal(log.spots.length, 0);
  }
  {
    const { ap, near } = keeper({ hp: 20 });
    assert.equal(await ap.lureSparedBlocker({ near }), false, 'below the flee line survival has the body');
  }
  {
    const { ap, near } = keeper({ wedged: false });
    assert.equal(await ap.lureSparedBlocker({ near }), false);
  }
  {
    const { ap, near } = keeper({ spare: null });
    assert.equal(await ap.lureSparedBlocker({ near }), false);
  }
  {
    const { ap, near } = keeper({ bodies: [[10, RAT, 27, 45]] });
    assert.equal(await ap.lureSparedBlocker({ near }), false, 'out of reach is not in the way');
  }
});

await ok('no refuge outside the needle: refused and recorded, nothing moved', async () => {
  const { ap, log, near } = keeper({ plan: false });
  assert.equal(await ap.lureSparedBlocker({ near }), false);
  assert.ok(log.events.some(e => e.phase === 'refusal'));
  assert.equal(log.spots.length, 0);
});

await ok('bounded: six lures per room per ten minutes, then the movement ladder has it', async () => {
  const { ap, log, near } = keeper();
  for (let i = 0; i < 6; i++) assert.equal(await ap.lureSparedBlocker({ near }), true);
  assert.equal(await ap.lureSparedBlocker({ near }), false);
  assert.ok(log.notes.some(x => /lure budget spent/.test(x.what)));
  ap.s.world.room.num = 111;
  assert.equal(await ap.lureSparedBlocker({ near }), true, 'another room has its own budget');
});

await ok('the provoke pass is one id and expires on its own', () => {
  const s = {};
  grantProvoke(s, 10, 1000);
  assert.equal(provokeExempt(s, 10, 1000 + PROVOKE_WINDOW_MS - 1), true);
  assert.equal(provokeExempt(s, 11, 1001), false);
  assert.equal(provokeExempt(s, 10, 1000 + PROVOKE_WINDOW_MS), false);
  endProvoke(s);
  assert.equal(provokeExempt(s, 10, 1001), false);
});

await ok('the veto and findCreature honour the pass, and only for that id', () => {
  const { ap, c } = keeper({ bodies: [[10, RAT, 27, 39], [12, RAT, 26, 39]] });
  const s = ap.s;
  s.need = () => c;
  assert.equal(vetoSpared(s, c, 10), true);
  grantProvoke(s, 10);
  assert.equal(vetoSpared(s, c, 10), false);
  assert.equal(vetoSpared(s, c, 12), true, 'its namesake is still spared');
  const found = findCreature(s, 'giant rat');
  assert.deepEqual(found.map(o => o.id), [10], JSON.stringify(found));
  endProvoke(s);
  assert.equal(findCreature(s, 'giant rat').length, 0);
});

await ok('the target-picking rungs skip spared bodies (source pins)', () => {
  const fb = AUTOPILOT.slice(AUTOPILOT.indexOf('  async passFightBack(ctx) {'));
  assert.ok(/this\.sparedHere\(o\) \? \{ why: 'spared \(spare_creatures\)' \}/.test(fb.slice(0, 4000)), 'passFightBack');
  const cp = AUTOPILOT.slice(AUTOPILOT.indexOf('  clearPathCheck(w, hp, now) {'));
  assert.ok(/inReachOfUs\?\.\(\) \?\? \[\]\)\.filter\(o => !this\.sparedHere\(o\)\)/.test(cp.slice(0, 7000)), 'clearPathCheck');
  const tr = AUTOPILOT.slice(AUTOPILOT.indexOf('  async tradeInPlaceIfWedged('));
  assert.ok(/!this\.karmaForbids\(nameOf\(o\)\) && !this\.sparedHere\(o\)/.test(tr.slice(0, 2000)), 'tradeInPlaceIfWedged candidates');
  assert.ok(/this\.lureSparedBlocker\(\{near,v\}\)/.test(tr.slice(0, 400)), 'the trade asks the lure first');
});

await ok('a strategy file may declare spareBlockers (movement faculty); a bad value is refused', () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'spareBlockers');
  assert.equal(f?.faculty, 'movement');
  assert.equal(f?.arg, 'spare_blockers');
  const good = validateStrategy({ name: 'x', hunt: ['lupogg'], spare: ['giant rat'], spareBlockers: 'provoke' }, { file: 'x.mjs' });
  assert.ok(good.ok !== false && !(good.problems?.length), JSON.stringify(good).slice(0, 300));
  let bad;
  try { bad = validateStrategy({ name: 'y', spareBlockers: 'murder' }, { file: 'y.mjs' }); } catch (e) { bad = { thrown: e.message }; }
  assert.ok(bad.thrown || bad.ok === false || bad.problems?.length || bad.refused?.length, JSON.stringify(bad).slice(0, 300));
});

console.log(`\n${n} passed`);
