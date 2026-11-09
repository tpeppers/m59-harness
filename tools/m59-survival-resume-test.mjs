#!/usr/bin/env node
// A KEEPER'S SURVIVAL RUNG PAUSES AN ORDER; IT NEVER DROPS ONE. Offline: no broker, no server,
// no socket -- a real Session and a real Autopilot with nothing joined, and a fake broker for the
// FleetScript half.
//
//   node tools/m59-survival-resume-test.mjs
//
// Operator, 2026-11-05: "We need to fix the m59-harness to no longer cancel orders for survival.
// It should never drop the order: if it stops to rest it should then continue the previous order
// when it finishes resting."
//
// The incident (prod, Robin/t8, 22:32-22:43Z): a FleetScript walk 2143 -> 713 on a 327s budget.
// At 22:33:38 keeper:play_dead ("rest at the safe wall instead of logging off") cancelled it. The
// keeper suspended the journey and later resumed it, but the walk's budget ran straight through
// the rest, counted the attempt as failed, cancelled the keeper's resume to re-issue its own, and
// after three attempts reported "did not reach 713" -- while the keeper went on walking the order
// the script had abandoned. And not every survival rung suspended at all: the play_dead rung built
// its note by hand with no origin and no options, others (watchdog, retreat, fight-back, clear_path)
// suspended nothing, and every resume walked with `to` alone, dropping the issuer's `avoid`.
//
// Pinned here:
//   (a) a keeper survival cancel of an external walk (play_dead / rest at the safe wall / shelter /
//       watchdog) suspends the ORDER -- destination, issuer, options -- and the resume walks the
//       same destination with the same options, still the issuer's order;
//   (b) a FleetScript walk waiting on that order does not burn an attempt or fail during the
//       pause, and completes when the resumed journey arrives;
//   (c) a genuine terminal end -- an operator cancel, a newer order from another issuer, death --
//       still ends the walk, with its reason, and is never re-issued over.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Nothing here may write a real ledger, take a real lock or reach a real port.
process.env.M59_LEDGER_DIR = mkdtempSync(join(tmpdir(), 'm59-sr-ledger-'));
process.env.M59_RUNLOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-sr-lock-'));
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';
process.env.M59_KEEPER_BEAT_MS = '15';
const BAND_DIR = mkdtempSync(join(tmpdir(), 'm59-sr-band-'));
writeFileSync(join(BAND_DIR, 'keeper-bands.json'), JSON.stringify({ testfleet: 19950 }));
process.env.M59_KEEPER_BAND_REGISTRY = join(BAND_DIR, 'keeper-bands.json');

const { Session } = await import('./m59-game.mjs');
const { autopilotFor, dropAutopilot } = await import('./m59-autopilot.mjs');
const { keeperOrigin, moveOrigin, sameIssuer, walkOrderState, journeyResumeOptions, originLabel } =
  await import('./m59-move-origin.mjs');
const { stateFileFor } = await import('./m59-fleetpath.mjs');
const { fleetScript, walk } = await import('./m59-fleetscript.mjs');
const { chooseSurvivalDecision } = await import('./m59-survival-decision.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const FS = moveOrigin({ source: 'fleetscript', name: 'tos-import-lap (local)', run_id: 'mw44evgd-57708' });
let n = 0;
const drop = s => { s.client = null; s.world = null; try { dropAutopilot(s.name); } catch {} };
// A keeper holding an external travel order, the way `Session.travelJob` leaves one: the journey
// hold (goTravelling with the issuer's options), the live move order, and the job slot.
function keeperWalking({ to = 713, origin = FS, options = { avoid: [599, 598], maxHops: 25 } } = {}) {
  const s = new Session(`sr${++n}`);
  const k = autopilotFor(s);
  k.note = () => {};
  k.goTravelling(`travelling to ${to}`, { to, origin, resume: options });
  s.moveOrder = { kind: 'travel', to, origin, at: Date.now(), generation: s.movementGeneration };
  s.job = { kind: 'travel', label: `walk to ${to}`, to, done: false, origin,
            generation: s.movementGeneration, resume: { to, where: `room ${to}`, ...options } };
  return { s, k };
}

console.log('(a) every keeper survival cancel of an external walk SUSPENDS the order, with its issuer and options');
for (const [rung, why] of [['play_dead', 'rest at the safe wall instead of logging off'],
                           ['shelter', 'shelter needed during fallback travel: geometry departure detour'],
                           ['watchdog', 'the watchdog pulling us out of a blind walk below the flee line'],
                           ['retreat', 'guarded retreat deadline']]) {
  const { s, k } = keeperWalking();
  const r = s.cancelMovement(null, why, { origin: keeperOrigin(rung) });
  const j = k.suspendedJourney;
  ok(`keeper:${rung} still cancels the movement at once (survival keeps the body)`, r.cancelled === true);
  ok(`keeper:${rung} leaves a suspended journey to the same destination`, j?.to === 713, JSON.stringify(j));
  ok(`keeper:${rung} keeps the ISSUER on it`, sameIssuer(j?.origin, FS), JSON.stringify(j?.origin));
  ok(`keeper:${rung} keeps the issuer's avoid and hop budget`,
     JSON.stringify(j?.resume?.avoid) === '[599,598]' && j?.resume?.maxHops === 25, JSON.stringify(j?.resume));
  ok(`keeper:${rung} names itself as the trigger`, j?.trigger === why, j?.trigger);
  drop(s);
}

{
  // The suspension must survive with no journey hold at all -- a survival cancel that lands
  // after the hold was revived still pauses the order the job slot was carrying.
  const { s, k } = keeperWalking();
  k.inert = null;
  s.cancelMovement(null, 'playing dead to avoid dying', { origin: keeperOrigin('play_dead') });
  ok('with no journey hold left, the order is still suspended from the job it belonged to',
     k.suspendedJourney?.to === 713 && sameIssuer(k.suspendedJourney?.origin, FS)
     && JSON.stringify(k.suspendedJourney?.resume?.avoid) === '[599,598]', JSON.stringify(k.suspendedJourney));
  drop(s);
}

console.log('(a) and the resume walks THAT order: same destination, same options, still the issuer\'s');
{
  const { s, k } = keeperWalking();
  s.cancelMovement(null, 'rest at the safe wall instead of logging off', { origin: keeperOrigin('play_dead') });
  k.revive('survival took the body');
  // Rested to full: health and vigor whole, no hold, nothing asked for.
  k.hold = null; k.wantsForwardShelter = null;
  k.releaseRestedHold = async () => {};
  const vitals = { health: { value: 121, max: 121 }, vigor: { value: 200, max: 200 } };
  s.client = { vitals: () => vitals, self: { row: 11, col: 47 }, room: { id: 1 } };
  s.world = { room: { num: 2124, name: 'Path to the Ruins' } };
  let asked = null;
  k.travel = async (to, opts) => { asked = { to, opts, inert: k.inert }; return { arrived: true }; };
  await k.resumeSuspendedJourney({ hp: 1, v: vitals, room: { num: 2124 } });
  ok('the keeper resumes the journey', asked?.to === 713, JSON.stringify(asked && { to: asked.to }));
  ok('with the issuer\'s avoid', JSON.stringify(asked?.opts?.avoid) === '[599,598]', JSON.stringify(asked?.opts));
  ok('with the issuer\'s hop budget, not a made-up one', asked?.opts?.maxHops === 25, asked?.opts?.maxHops);
  ok('and it is still the issuer\'s order, marked as resumed by the keeper',
     sameIssuer(asked?.opts?.origin, FS) && asked?.opts?.origin?.resumed_by === 'keeper:resume_journey',
     JSON.stringify(asked?.opts?.origin));
  ok('the resumed journey hold carries the options too, so a SECOND pause keeps them',
     JSON.stringify(asked?.inert?.resume?.avoid) === '[599,598]', JSON.stringify(asked?.inert?.resume));
  ok('errands are not re-run on a resume', asked?.opts?.runErrands === undefined);
  drop(s);
}

console.log('(c) what survival does NOT pause: an operator cancel, the keeper\'s own orders, a stop');
{
  const { s, k } = keeperWalking();
  s.cancelMovement(null, 'operator says stop', { origin: { source: 'operator', name: 'tim' } });
  ok('an operator cancel leaves nothing to resume', k.suspendedJourney == null, JSON.stringify(k.suspendedJourney));
  drop(s);
}
{
  const { s, k } = keeperWalking();
  k.suspendedJourney = { to: 713, origin: FS, at: Date.now(), attempts: 1, deaths_at: 0 };
  k.cancelJourney('the operator withdrew the walk', null, { source: 'operator', name: 'tim' });
  ok('an external cancel withdraws a suspension already held', k.suspendedJourney == null);
  ok('and a later survival rung cannot resurrect the order its issuer withdrew',
     k.suspendJourney('a late survival rung') === false && k.suspendedJourney == null);
  drop(s);
}
{
  const { s, k } = keeperWalking({ origin: keeperOrigin('town_trip') });
  k.suspendedJourney = null;
  s.cancelMovement(null, 'town trip dropped', { origin: keeperOrigin('town_trip_drop') });
  ok('the keeper cancelling its OWN order is not routed through the external-order pause',
     k.suspendPreemptedOrder({ by: keeperOrigin('play_dead'), preempted: { kind: 'travel', to: 713, origin: keeperOrigin('town_trip') } }) === false);
  drop(s);
}
{
  const { s, k } = keeperWalking();
  k.inert = null;
  s.cancelMovement(null, 'keeper stopped', { origin: keeperOrigin('keeper_stop') });
  ok('a keeper being STOPPED pauses nothing (a stopped keeper resumes nothing)', k.suspendedJourney == null);
  drop(s);
}
ok('options are sanitised: a hazard override never travels without its reason',
   journeyResumeOptions({ allowHazard: true }) === null
   && journeyResumeOptions({ allowHazard: true, hazardWhy: 'rescue' })?.hazardWhy === 'rescue');

console.log('pack-blocked release retires only the exact suspended route');
{
  const { s, k } = keeperWalking();
  const why = 'a travel guard rung taking the character back';
  s.cancelMovement(null, why, { origin: keeperOrigin('travel_guard') });
  k.revive(why);
  s.job.done = true;
  s.client = { stat: () => 20, inventory: [{ name: 'blue mushroom', amount: 420 }],
    vitals: () => ({ health: { value: 121, max: 121 } }), self: { row: 16, col: 16 },
    room: { objects: new Map() } };
  k.armed = () => false;
  const ownership = { faculties: ['work', 'movement', 'economy'], by: `fleetscript:${FS.name}` };
  k.claimFaculties(ownership);
  const held = k.suspendedJourney, generation = s.movementGeneration;
  const blocked = { stage: 'passArm', at: Date.now(), bulk_free: 0, needs: 70,
    what: 'unarmed and cannot hold what the spell would make' };
  k.lastDecision = blocked;
  const retire = () => k.retirePackBlockedJourney(713, FS, held.at);
  ok('the same script name from a different run cannot retire it',
     !k.retirePackBlockedJourney(713, { ...FS, run_id: 'foreign' }, held.at).retired && k.suspendedJourney === held);
  ok('an older walk from the same run cannot be retired on behalf of a newer walk',
     !k.retirePackBlockedJourney(713, FS, held.at + 1).retired && k.suspendedJourney === held);
  s.moveOrder = { kind: 'travel', to: 38, origin: { source: 'operator', name: 'tim' }, generation };
  ok('newer movement is untouched', !retire().retired && s.moveOrder.to === 38 && k.suspendedJourney === held);
  s.moveOrder = null;
  s.client.trade = {};
  ok('an open trade keeps the route', !retire().retired && k.suspendedJourney === held);
  s.client.trade = null;
  const decision = chooseSurvivalDecision(s, { strategy: 'rest', status: 'recovering' });
  ok('real recovery keeps the route', !retire().retired && k.suspendedJourney === held);
  decision.status = 'complete';
  s.client.inventory[0].amount = 405;
  ok('newly freed pack space keeps the route even with a fresh old blocker',
     !retire().retired && k.suspendedJourney === held);
  s.client.inventory[0].amount = 420;
  k.lastDecision = { ...blocked, at: blocked.at - 6_000 };
  ok('stale arming evidence cannot retire a journey', !retire().retired && k.suspendedJourney === held);
  k.lastDecision = blocked;
  const r = retire();
  ok('the exact current pack blocker retires the suspended route without another movement cancel',
     r.retired && k.suspendedJourney == null && s.movementGeneration === generation, JSON.stringify(r));
  drop(s);
}

console.log('walkOrderState: four answers, and only one of them is a failure');
{
  const label = originLabel(FS);
  const live = walkOrderState({ movement: { order: { kind: 'travel', to: 713, origin: { ...FS, resumed_by: 'keeper:resume_journey' }, ordered_by: label } } },
                              { mine: FS, to: 713 });
  ok('the keeper\'s resume of our order is OUR walk, live', live.state === 'live' && live.resumed === true, JSON.stringify(live));
  const paused = walkOrderState({ movement: { order: { kind: 'travel', to: 2124, origin: keeperOrigin('shelter'), ordered_by: 'keeper:shelter' } },
                                  autopilot: { suspended_journey: { to: 713, ordered_by: label, trigger: 'rest at the safe wall instead of logging off' } } },
                                { mine: FS, to: 713 });
  ok('a suspended journey ordered by us is PAUSED, even while the keeper walks to a wall', paused.state === 'paused', JSON.stringify(paused));
  const other = walkOrderState({ autopilot: { suspended_journey: { to: 713, ordered_by: 'fleetscript:other#x' } } }, { mine: FS, to: 713 });
  ok('somebody else\'s suspended journey to the same room is not ours', other.state === 'gone', JSON.stringify(other));
  const rec = { at: Date.now(), by: { source: 'operator', name: 'tim' }, by_label: 'operator:tim', why: 'stop',
                preempted: { kind: 'travel', to: 713, origin: FS, ordered_by: label }, self_cancel: false };
  const taken = walkOrderState({ movement: { order: null, last_preempted: rec, preemptions: [rec] } }, { mine: FS, to: 713, since: 0 });
  ok('an operator cancel of our order is TAKEN', taken.state === 'taken' && taken.by === 'operator:tim', JSON.stringify(taken));
  const keeperRec = { ...rec, by: keeperOrigin('play_dead'), by_label: 'keeper:play_dead' };
  ok('a keeper cancel is never TAKEN', walkOrderState({ movement: { last_preempted: keeperRec, preemptions: [keeperRec] } },
                                                      { mine: FS, to: 713 }).state === 'gone');
  const newer = walkOrderState({ movement: { order: { kind: 'travel', to: 39, origin: { source: 'bot', name: 'dum' }, ordered_by: 'bot:dum' } } },
                               { mine: FS, to: 713 });
  ok('a newer order from another issuer is TAKEN', newer.state === 'taken' && /bot:dum/.test(newer.why), JSON.stringify(newer));
}

// ---------------------------------------------------------------- the FleetScript half
//
// A minimal broker: `status` answers room/health/movement from the case's own clock, `autopilot
// status` answers the keeper's suspended journey, `travel` records and does NOT move the body --
// arriving is the case's decision, the way it is the world's.
function fakeBroker({ room, phase, health = () => ({ value: 121, max: 121 }), dead = () => false,
                      keeper = null }) {
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    if (keeper && String(url) === 'http://127.0.0.1:19950/live')
      return { ok: true, json: async () => ({ agent: 't8', character: 'Robin', pid: 110 }) };
    if (!opts || opts.method !== 'POST') return { json: async () => ({ ok: true, fleet: 'testfleet', state: stateFileFor('testfleet') }) };
    const body = JSON.parse(opts.body);
    if (!body.params) {
      if (!keeper) return { json: async () => ({}) };              // a keeper port: nobody home
      const name = body.name ?? 'cancel';
      sent.push({ name: `keeper:${name}`, ...body.args });
      const payload = await keeper(name, body.args ?? {}, sent);
      return { json: async () => payload };
    }
    const { name, arguments: a } = body.params;
    sent.push({ name, ...a, t: Date.now() });
    const travels = sent.filter(c => c.name === 'travel');
    const p = phase({ sent, travels, mine: travels.at(-1)?.origin ?? null });
    let payload = { ok: true };
    if (name === 'status')
      payload = { where: { num: room(), name: dead() ? 'The Underworld' : 'room' }, hp: health(), gold: null,
                  movement: p.movement ?? null };
    else if (name === 'autopilot' && a.action === 'status') payload = { mode: 'survive', policy: {}, ...(p.autopilot ?? {}) };
    else if (name === 'look') payload = { room: { num: room(), name: 'room' }, you: { col: 10, row: 10 }, objects: [] };
    else if (name === 'travel') payload = { started: true };
    else if (name === 'travel_estimate') payload = { ms: 1000, hops: 2 };
    else if (name === 'cancel_movement') payload = { cancelled: true };
    else if (name === 'pilot') payload = { piloted: [] };
    else if (name === 'jobs') payload = { jobs: [] };
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
  };
  return sent;
}
const label = o => o ? `${o.source}:${o.name}#${o.run_id}` : null;
const run = (sent, extra = {}) => fleetScript({ name: 'tos-import-lap', fleet: 'testfleet', agents: ['t8'],
  onLog: (...x) => (extra.logs ?? []).push(x.join(' ')), pollMs: 10, budgetFloorMs: 120, budgetCapMs: 120,
  steps: [walk(713)], ...extra });

console.log('(b) a FleetScript walk waits THROUGH a survival pause and completes on the resumed journey');
{
  // The budget is 120ms; the keeper rests for 600ms -- five budgets -- then resumes and arrives.
  let here = 2143, t0 = null;
  const sent = fakeBroker({
    room: () => here,
    phase: ({ travels, mine }) => {
      if (!travels.length) return {};
      t0 ??= Date.now();
      const dt = Date.now() - t0, ordered = label(mine);
      if (dt < 40) return { movement: { order: { kind: 'travel', to: 713, origin: mine, ordered_by: ordered } } };
      const rec = { at: t0 + 40, by: { source: 'keeper', name: 'play_dead' }, by_label: 'keeper:play_dead',
                    why: 'rest at the safe wall instead of logging off', self_cancel: false,
                    preempted: { kind: 'travel', to: 713, origin: mine, ordered_by: ordered } };
      rec.summary = `walk to 713 ordered by ${ordered} cancelled by keeper:play_dead (${rec.why}) at 22:33:38Z`;
      if (dt < 640) { here = 2124;
        return { movement: { order: null, last_preempted: rec, preemptions: [rec] },
                 autopilot: { suspended_journey: { to: 713, ordered_by: ordered, trigger: rec.why, attempts: 1 } } }; }
      if (dt < 700) return { movement: { order: { kind: 'travel', to: 713, ordered_by: ordered,
                                                  origin: { ...mine, resumed_by: 'keeper:resume_journey' } },
                                         last_preempted: rec, preemptions: [rec] } };
      here = 713;
      return { movement: { order: null, last_preempted: rec, preemptions: [rec] } };
    },
  });
  const logs = [];
  const r = await run(sent, { logs });
  const res = r.results?.t8 ?? {};
  ok('the walk succeeds', res.ok === true, JSON.stringify(res));
  ok('one travel was sent: the pause was not counted as an attempt and nothing was re-issued',
     sent.filter(c => c.name === 'travel').length === 1, String(sent.filter(c => c.name === 'travel').length));
  ok('and the keeper\'s resume was never cancelled to make way for a re-issue',
     sent.filter(c => c.name === 'cancel_movement').length === 1, String(sent.filter(c => c.name === 'cancel_movement').length));
  ok('the pause is logged as a PAUSE, waiting on the keeper', logs.some(l => /PAUSED the walk to 713 for survival/.test(l)), logs.join(' | '));
  ok('and the resume as a RESUME', logs.some(l => /RESUMED the walk to 713/.test(l)), logs.join(' | '));
}

{
  // BOUNDED. A pause the keeper never ends does not hold the walk for ever: past the allowance
  // the ordinary budget runs again and the walk ends with the ordinary verdict.
  const sent = fakeBroker({
    room: () => 2124,
    phase: ({ travels, mine }) => travels.length
      ? { autopilot: { suspended_journey: { to: 713, ordered_by: label(mine), trigger: 'rest at the safe wall instead of logging off' } } }
      : {},
  });
  const began = Date.now();
  const r = await run(sent, { survivalPauseMs: 150 });
  const res = r.results?.t8 ?? {};
  ok('a pause that outlasts the allowance still ends the walk', res.ok === false, JSON.stringify(res));
  ok('within the allowance plus the ordinary budgets, not for ever', Date.now() - began < 10_000, `${Date.now() - began}ms`);
}

console.log('a confirmed pack block ends the FleetScript and hands back its faculties');
{
  let retired = false, renewalFinished = false;
  const sent = fakeBroker({
    room: () => 48,
    keeper: async (name, args, calls) => {
      if (name === 'commander_claim') return { granted: ['work', 'movement', 'economy'] };
      if (name === 'commander_heartbeat') {
        await new Promise(resolve => setTimeout(resolve, 65));
        calls.push({ name: 'keeper:heartbeat_finished' });
        renewalFinished = true;
        return { renewed: [] };
      }
      if (name === 'retire_pack_blocked_journey' && args.to === 713 && args.origin?.run_id && Number.isFinite(args.since)) {
        retired = true;
        return { retired, bulk_free: 0, needs: 70 };
      }
      return {};
    },
    phase: ({ sent, travels, mine }) => travels.length && sent.some(c => c.name === 'keeper:commander_heartbeat')
      ? { autopilot: { suspended_journey: { to: 713, ordered_by: label(mine), trigger: 'unarmed' },
                       last_decision: { stage: 'passArm', bulk_free: 0, needs: 70 } } }
      : {},
  });
  const r = await run(sent);
  const res = r.results?.t8 ?? {};
  const names = sent.map(c => c.name);
  ok('one walk returns the explicit pack-block outcome', retired && res.outcome === 'travel_pack_blocked' &&
     names.filter(n => n === 'travel').length === 1, JSON.stringify(res));
  ok('the pending heartbeat settles before releasing, without another claim',
     renewalFinished && names.indexOf('keeper:heartbeat_finished') < names.indexOf('keeper:commander_release') &&
     names.filter(n => n === 'keeper:commander_claim').length === 1, JSON.stringify(names));
  ok('only the initial takeover and send clear movement, with no generic release on exit',
     names.filter(n => n === 'keeper:cancel').length === 1 &&
     names.filter(n => n === 'cancel_movement').length === 1 &&
     names.filter(n => n === 'keeper:release').length === 1, JSON.stringify(names));
}

console.log('(c) a genuine terminal end still ends the walk, with its reason, and is not re-issued');
{
  let t0 = null;
  const sent = fakeBroker({
    room: () => 2143,
    phase: ({ travels, mine }) => {
      if (!travels.length) return {};
      t0 ??= Date.now();
      const rec = { at: t0 + 20, by: { source: 'operator', name: 'tim' }, by_label: 'operator:tim', why: 'stop that',
                    self_cancel: false, preempted: { kind: 'travel', to: 713, origin: mine, ordered_by: label(mine) } };
      rec.summary = `walk to 713 ordered by ${label(mine)} cancelled by operator:tim (stop that) at 22:40:00Z`;
      return Date.now() - t0 < 20 ? { movement: { order: { kind: 'travel', to: 713, origin: mine, ordered_by: label(mine) } } }
                                  : { movement: { order: null, last_preempted: rec, preemptions: [rec] } };
    },
  });
  const r = await run(sent);
  const res = r.results?.t8 ?? {};
  const step = res.state?.['0:walk'] ?? {};
  ok('an operator cancel ends the walk, as terminal', res.ok === false && step.terminal === true, JSON.stringify(res));
  ok('naming who ended it', /ended by operator:tim/.test(res.why ?? '') && step.taken_by === 'operator:tim', res.why);
  ok('and it is not re-issued over them', sent.filter(c => c.name === 'travel').length === 1);
}
{
  let t0 = null;
  const sent = fakeBroker({
    room: () => 2143,
    phase: ({ travels, mine }) => {
      if (!travels.length) return {};
      t0 ??= Date.now();
      return Date.now() - t0 < 20 ? { movement: { order: { kind: 'travel', to: 713, origin: mine, ordered_by: label(mine) } } }
        : { movement: { order: { kind: 'travel', to: 39, origin: { source: 'bot', name: 'dum' }, ordered_by: 'bot:dum' } } };
    },
  });
  const r = await run(sent);
  const res = r.results?.t8 ?? {};
  ok('a newer order from another issuer ends the walk', res.ok === false && res.state?.['0:walk']?.taken_by === 'bot:dum'
     && /newer order from bot:dum/.test(res.why ?? ''), JSON.stringify(res));
  ok('and it is not re-issued over that order', sent.filter(c => c.name === 'travel').length === 1);
}
{
  let t0 = null, dead = false;
  const sent = fakeBroker({
    room: () => dead ? 1 : 2124, dead: () => dead,
    health: () => dead ? { value: 0, max: 121 } : { value: 60, max: 121 },
    phase: ({ travels, mine }) => {
      if (!travels.length) return {};
      t0 ??= Date.now();
      if (Date.now() - t0 > 60) dead = true;
      return { autopilot: { suspended_journey: { to: 713, ordered_by: label(mine), trigger: 'playing dead to avoid dying' } } };
    },
  });
  const r = await fleetScript({ name: 'tos-import-lap', fleet: 'testfleet', agents: ['t8'], onLog: () => {},
    pollMs: 10, budgetFloorMs: 120, budgetCapMs: 120, minHealth: 0.1, reviveMs: 50, steps: [walk(713)] });
  const res = r.results?.t8 ?? {};
  ok('death during a survival pause still ends the walk as a death', res.ok === false && /died/.test(res.why ?? ''), JSON.stringify(res));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
