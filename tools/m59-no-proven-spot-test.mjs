#!/usr/bin/env node
// NO SAFE SPOT IS "PROVEN", AND A WALK-BLOCKED BODY DOES NOT STAND AND BLEED -- offline, no socket, no roster.
//
//   node tools/m59-no-proven-spot-test.mjs
//
// Operator, 2026-11-19: "there are certainly safe spots in the room, all room have safe spots, but a 'proven' safe spot
// sounds like a bug we're trying to remove - safe spots shouldn't be 'provable' in our code that's a bug", and "the
// 'held under fire' discriminator should be removed".
//
// THE INCIDENT. Beaker (t6), 2026-11-19 18:12:47Z, the Barloque sewers (111), 143 max health, a karma-strict Qor caster in
// a room of twenty-five monsters (mostly giant rats he spares): the healing session's one logoff spent, "could not reach
// the safe spot -- blocked, every heading refused", then every pass from 20% to 3% "leaving the room to recover safely ...
// there is no proven wall here", the confinement [108,111] refusing 112, the walk to 108 object_blocked three times, and
// "reconnecting to shed the crowd" with no reconnect ever made (breakOutViaLogoff false, session spent). 104 -> 0 on one
// square in twenty-five seconds.
//
// WHAT THIS PINS:
//   (a) a geometric spot is a safe spot without any proof: no keeper decision reads `.proven`; a hold that carries no
//       `proven` flag shelters the body (holdWorks) and stops the leave-to-recover rung; the leave rung asks for the
//       nearest spot in THIS room before it walks for a door, even when the wall rung's thirty-second budget is spent;
//   (b) the Beaker shape -- low health, spot unreachable, the permitted exit blocked, the other exit outside the
//       confinement -- ends in a logoff (the walk-blocked override, once, even in a spent session and with
//       breakOutViaLogoff off) and/or a permitted exit (the probationary survival edge pass at critical health), never
//       in standing still; and above the flee line nothing about the old behaviour changes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_HEALING_DIR = mkdtempSync(join(tmpdir(), 'm59-no-proven-healing-'));
process.env.M59_PVP_HOLD_DIR = mkdtempSync(join(tmpdir(), 'm59-no-proven-pvp-'));

const { readdirSync } = await import('node:fs');
const { readToolSource } = await import('./autopilot/source.mjs');
const { Autopilot, HANDLED } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const H = await import('./m59-healing-session.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// ------------------------------------------------------------------------------------------------ (a) the source
console.log('no keeper decision reads `.proven`');
{
  // Every `.proven` read left in the keeper is a TELEMETRY FIELD -- the value of a `proven:` key in a journal or status
  // row -- or the death tally named for it (kept so m59-death-tally's reports still read). Anything else is a decision
  // hinging on proof, which is the bug.
  const dir = new URL('./autopilot/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs')).map(f => ['autopilot/' + f, new URL(f, dir)]);
  files.push(['m59-autopilot.mjs', new URL('./m59-autopilot.mjs', import.meta.url)]);
  const offenders = [];
  for (const [name, url] of files) {
    const lines = readToolSource(url, 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, '');
      if (!/\.proven\b/.test(line)) return;
      const telemetry = /proven:\s*!?!?[\w$.?]+\.proven\b/.test(line) || /proven:\s*!!spot\.proven/.test(line);
      // death.mjs, read directly or spliced into the keeper's whole text by readToolSource
      const tally = /^\s*if \(diedHolding\.proven\)\s*$/.test(line);
      if (!telemetry && !tally) offenders.push(`${name}:${i + 1}: ${raw.trim()}`);
    });
  }
  ok('no `.proven` read outside a telemetry field', offenders.length === 0, '\n      ' + offenders.join('\n      '));
  const SURV = readToolSource(new URL('./autopilot/pass-survival.mjs', import.meta.url), 'utf8');
  ok('the `testing` experiment (rest on an "unproven" square only as a trial) is gone',
     !/\blet testing\b|\btesting\s*=/.test(SURV.replace(/\/\/.*$/gm, '')));
  ok('the rest leash no longer reads what the square was "proven against"', !/mostAttackers/.test(SURV.replace(/\/\/.*$/gm, '')));
  ok('"no proven wall here" is no longer the reason given for leaving', !/no proven wall here/.test(SURV.replace(/\/\/.*$/gm, '')));
  const SENSES = readToolSource(new URL('./autopilot/senses.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  ok('observe() no longer promotes or demotes a hold by proof', !/hold\.proven\s*=/.test(SENSES));
  const SPOTS = readToolSource(new URL('./autopilot/safe-spots.mjs', import.meta.url), 'utf8');
  ok('a failed recovery approach is recorded as walk-blocked (takeSafeSpot)',
     /rememberSurvivalJam\(\{failed:true\}\);this\.noteWalkBlocked\?\.\('spot'/.test(SPOTS));
  const COOP = readToolSource(new URL('./autopilot/cooperative.mjs', import.meta.url), 'utf8');
  ok('playDead takes the walk-blocked override in a spent session',
     /this\.poisonOverrideReason\?\.\(\)\?\?this\.walkBlockedOverrideReason\?\.\(\)/.test(COOP));
  ok('...and the open-floor refusal does not apply to a walk-blocked body',
     /if \(!atWall && !this\.playerThreatPresent\(\) && !walkBlocked\)/.test(COOP));
}

// ------------------------------------------------------------------------------------------- the pure decisions
console.log('walkBlockedVerdict: who may take the override');
{
  const now = 1_795_111_964_000, room = 111;
  const blocked = { room, spotAt: now - 3000, spotWhy: 'blocked — every heading refused', exitAt: now - 500, exitWhy: 'object_blocked' };
  const base = { blocked, room, now, frac: 0.2, fleeAt: 0.45, onWall: false, reached: true };
  ok('Beaker at 20%: granted', H.walkBlockedVerdict(base).grant === true, JSON.stringify(H.walkBlockedVerdict(base)));
  ok('above the flee line: not granted', !H.walkBlockedVerdict({ ...base, frac: 0.6 }).grant);
  ok('on a recovery wall: not granted (rest there)', !H.walkBlockedVerdict({ ...base, onWall: true }).grant);
  ok('nothing reaching the body: not granted', !H.walkBlockedVerdict({ ...base, reached: false }).grant);
  ok('only the spot failed: not granted', !H.walkBlockedVerdict({ ...base, blocked: { ...blocked, exitAt: null } }).grant);
  ok('only the exit failed: not granted', !H.walkBlockedVerdict({ ...base, blocked: { ...blocked, spotAt: null } }).grant);
  ok('a stale block (40 s): not granted', !H.walkBlockedVerdict({ ...base, now: now + 40_000 }).grant);
  ok('a block in another room: not granted', !H.walkBlockedVerdict({ ...base, room: 108 }).grant);
}
{
  const exits = [{ to: 112, steps_away: 3 }, { to: 108, steps_away: 10 }];
  ok('spentSessionExit, confined: only the permitted exit', H.spentSessionExit(exits, { here: 111, confine: [108, 111] })?.to === 108);
  ok('spentSessionExit, confined, with the critical edge pass for 112: the nearer exit',
     H.spentSessionExit(exits, { here: 111, confine: [108, 111], edge: to => to === 112 })?.to === 112);
}

// -------------------------------------------------------------------------------------------- the keeper itself
// The Beaker fixture, shaped like m59-retreat-refusal-test's: the real passFleeAndRest, breakOut, noteWalkBlocked,
// walkBlockedOverrideReason, criticalEdgeExits and belowFleeLine; every verb that does I/O replaced by a recorder.
const monster = (id, col, row) => ({ id, flags: OF.ATTACKABLE, col, row, nameRsc: 1 });
function beaker({ name, health = 29, max = 143, vigor = 80, spotTakes = false, leaves = [false, true],
                  policy = {}, spent = true, wallTriedAt = null } = {}) {
  const notes = [], progressed = [], stalled = [], order = [];
  const self = { id: 1, col: 47, row: 35 };
  const objects = new Map();
  objects.set(10, monster(10, 48, 35));            // the lupogg, biting
  for (let i = 0; i < 6; i++) objects.set(20 + i, monster(20 + i, 40 + i, 30));   // spared rats about the room
  const calls = { leaveViaAny: [], takeRecoverySpot: 0, reconnect: 0, takeSafeSpot: 0 };
  let leaveCall = 0;
  const k = Object.assign(Object.create(Autopilot.prototype), {
    journal: notes, notes, claims: new Map(), passes: 1, tally: {}, doing: null, hold: null, wallTriedAt,
    settledIn: null, book: { save: () => {} }, watch: { pulses: [], wedges: 0 },
    policy: { fleeBelow: 0.45, restBelow: 0.8, holdResumeAbove: 0.9, useSafeSpots: true, panicLogoff: true,
              hunt: 'lupogg', strategy: 'baseline', confineRooms: [108, 111], breakOutViaLogoff: false, ...policy },
    mode: 'farm',
    note: (what, detail) => notes.push({ what, detail }),
    progress: why => progressed.push(why),
    noProgress: why => stalled.push(why),
    who: () => null,                                  // no ledger rows from a test
    recordFrame: () => {}, ledgerEvent: () => {}, declareInterest: () => {},
    armed: () => true,
    safety: () => ({ engageAt: 0.9, fleeAt: 0.45 }),
    recovered: () => true, recoverUntilWhole: false,
    sanctuary: () => false, tooTiredToTravel: () => false,
    tradeInPlaceIfWedged: async () => false,
    townTripIfCornered: async () => false,
    playDead: async () => false,                      // the doomed/flee rungs' logoff: refused, as in a spent session
    settle: async () => {}, cookSomething: async () => {}, provision: async () => 'full',
    threat: () => ({ near: [...objects.values()].filter(o => Math.hypot(o.col - self.col, o.row - self.row) <= 2),
                     engaged: 1, names: ['lupogg'] }),
    reconnect: async () => { calls.reconnect++; order.push('reconnect'); return { ok: true }; },
    takeSafeSpot: async () => { calls.takeSafeSpot++; return { took: false, why: 'blocked — every heading refused' }; },
    // THE NEAREST SAFE SPOT IN THIS ROOM. The real one ends in takeSafeSpot, which records a failed approach as
    // walk-blocked; this stub does the same, and on success sets a hold carrying NO `proven` flag at all.
    takeRecoverySpot: async function (why) {
      calls.takeRecoverySpot++; order.push('spot');
      if (spotTakes) { this.hold = { room: 111, col: 50, row: 22, takenAt: Date.now(), quietMs: 0 }; return { took: true, spot: this.hold }; }
      this.noteWalkBlocked('spot', 'blocked — every heading refused');
      return { took: false, why: 'could not reach the safe spot: blocked — every heading refused' };
    },
    releaseRestedHold: () => {},
    s: {
      name,
      movementGeneration: 7, edgePass: null,
      leaveViaAny: async cands => {
        const left = leaves[Math.min(leaveCall++, leaves.length - 1)];
        calls.leaveViaAny.push({ to: cands.map(c => Number(c.to)), edgePass: k.s.edgePass ? { ...k.s.edgePass } : null });
        order.push('exit');
        return left ? { left: true, to: cands[0].to } : { left: false, reason: 'object_blocked', tried: [1, 2, 3] };
      },
      world: { room: { num: 111, name: 'The Sewers of Barloque' }, geometry: null,
               exits: () => [{ to: 112, to_name: 'The Sewers of Barloque', steps_away: 3 },
                             { to: 108, to_name: 'The Sewers of Barloque', steps_away: 9 }] },
      client: { selfId: 1, self, rsc: { get: () => 'giant rat' }, room: { objects }, ailments: () => [],
                vitals: () => ({ health: { value: health, max }, vigor: { value: vigor, max: 200 } }) },
    },
  });
  if (spent) H.noteLogoff(name, { why: 'under attack and not swinging — the fight-back edict', room: 111 });
  Object.assign(k, { calls, progressed, stalled, order });
  return k;
}
const ctxFor = k => { const v = k.s.client.vitals(); return { s: k.s, c: k.s.client, room: k.s.world.room, v,
  hp: v.health.max ? v.health.value / v.health.max : null }; };
const said = (k, what) => k.notes.some(n => n.what === what);

console.log('(a) the nearest geometric spot, without any proof, before any door');
{
  // The wall rung's thirty-second budget is spent (it asked a moment ago), which is the state Beaker was in for most of
  // his last twenty-five seconds: the leave rung must still ask for the spot before it walks for a door.
  const k = beaker({ name: 'spot-takes', spotTakes: true, wallTriedAt: Date.now() });
  const r = await k.passFleeAndRest(ctxFor(k)).catch(e => e);
  ok('the leave rung asked for the nearest spot in this room', k.calls.takeRecoverySpot === 1, JSON.stringify(k.calls));
  ok('...took it, and said so', said(k, 'took the nearest safe spot in this room instead of leaving'));
  ok('the hold it took carries no `proven` flag at all', k.hold && !('proven' in k.hold), JSON.stringify(k.hold));
  ok('...and it shelters the body all the same (holdWorks)', k.holdWorks() === true);
  ok('no door was walked for', k.calls.leaveViaAny.length === 0, JSON.stringify(k.calls.leaveViaAny));
  ok('no "leaving the room to recover" decision', !said(k, 'leaving the room to recover safely'));
  ok('the pass went on to recover at the spot', k.doing === 'recovering', `doing=${k.doing} r=${r?.message ?? r}`);
}

console.log('(b) the Beaker shape: low health, the spot unreachable, the exit blocked, confined');
{
  const k = beaker({ name: 'beaker-1', leaves: [false, true] });
  const r = await k.passFleeAndRest(ctxFor(k));
  ok('the spot was asked for before the door', k.order.indexOf('spot') >= 0 && k.order.indexOf('spot') < k.order.indexOf('exit'),
     k.order.join(' > '));
  ok('below the flee line the survival edge pass lets 112 out of the confinement [108,111]',
     k.calls.leaveViaAny[0]?.to.includes(112) && k.calls.leaveViaAny[0]?.to.includes(108), JSON.stringify(k.calls.leaveViaAny[0]));
  ok('...and the step guard is told, for exactly that room, on this movement generation',
     JSON.stringify(k.calls.leaveViaAny[0]?.edgePass?.rooms) === '[112]' && k.calls.leaveViaAny[0]?.edgePass?.generation === 7);
  ok('...and only while the walk runs', k.s.edgePass === null);
  ok('the blocked walk is recorded', k._walkBlocked?.exitWhy === 'object_blocked' && Number.isFinite(k._walkBlocked?.spotAt));
  ok('THE LOGOFF IS TAKEN: one reconnect, with breakOutViaLogoff off and the session spent', k.calls.reconnect === 1,
     JSON.stringify(k.calls));
  const s = H.readSession('beaker-1');
  ok('...as the session\'s one override, recorded with its reason', s?.logoffs === 2 && s?.overrides === 1 &&
     /walk-blocked/.test(s?.override_why ?? ''), JSON.stringify(s));
  ok('after the reconnect the spot is asked for again before the door', k.order.join(' > ') === 'spot > exit > reconnect > spot > exit',
     k.order.join(' > '));
  ok('and the body leaves: the pass ends on a permitted exit, not standing still', r === HANDLED &&
     k.progressed.some(p => /left a room/.test(p)), JSON.stringify(k.progressed));
  ok('nothing declared itself trapped', k.stalled.length === 0, JSON.stringify(k.stalled));
}
{
  // Every exit stays blocked and 112 is banned: no permitted exit works -- the logoff is still taken.
  const k = beaker({ name: 'beaker-2', leaves: [false], policy: { bannedDestinations: [112] } });
  await k.passFleeAndRest(ctxFor(k));
  ok('a banned room stays shut even at critical health', k.calls.leaveViaAny.every(c => !c.to.includes(112)),
     JSON.stringify(k.calls.leaveViaAny));
  ok('...and with every walk refused the body still gets the logoff, not a wait', k.calls.reconnect === 1);
  ok('a walk-blocked body below its flee line is offered the override for playDead too',
     /walk-blocked at 20%/.test(k.walkBlockedOverrideReason() ?? ''), String(k.walkBlockedOverrideReason()));
  H.noteLogoff('beaker-2', { why: 'x' });            // pretend a third were asked for
  const again = await k.breakOut('again', { critical: true });
  ok('NO LOOP: the override is spent, a further critical breakOut makes no reconnect', !again.did && k.calls.reconnect === 1,
     JSON.stringify(again));
}
{
  // Above the flee line (but under the 80% recovery line): nothing about the old rules changes.
  const k = beaker({ name: 'beaker-3', health: 90, leaves: [false] });
  await k.passFleeAndRest(ctxFor(k));
  ok('above the flee line the confinement still refuses 112', k.calls.leaveViaAny.every(c => !c.to.includes(112)),
     JSON.stringify(k.calls.leaveViaAny));
  ok('...no edge pass is opened', k.calls.leaveViaAny.every(c => c.edgePass === null));
  ok('...and breakOutViaLogoff:false still means no reconnect', k.calls.reconnect === 0);
}
{
  // An unspent session: the session's own logoff, no override.
  const k = beaker({ name: 'beaker-4', spent: false, leaves: [false, false] });
  await k.passFleeAndRest(ctxFor(k));
  const s = H.readSession('beaker-4');
  ok('an unspent session spends its own logoff, not an override', k.calls.reconnect === 1 && s?.logoffs === 1 && !s?.overrides,
     JSON.stringify(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
