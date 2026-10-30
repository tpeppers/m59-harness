// THE MUSTER: FROM A COLD FLEET TO ONE READY TO SET OUT TOGETHER — decided here, done by FleetScript.
//
//   import { unitFromState, assess, planHandovers, readinessReport } from './m59-muster-lib.mjs';
//
// Pure. No socket, no broker, no file written: every function takes what was read and returns what to do,
// so a launch can be planned, printed and tested before a body moves, and the same plan runs on the shadow
// copy and on prod. The doing is FleetScript's (`supply`, `rest`, `act`) and the job board's.
//
// WHY THIS EXISTS. Operator, 2026-10-29: the Avar Village launch has to go smoothly on PROD, rehearsed on the
// shadow clone first, from the fleet's real cold state — and that state is not "standing in an inn":
//
//   * every body locked to a no-combat room by an operator lockdown (`inn-lock`), whose saved "before" is the
//     FARM order, so a plain release sends each one off alone (avar-village.md, "the release hazard");
//   * ten `second-wind-drill` jobs running, each turning survival and resting OFF on a loop, which is why
//     half the fleet sat at 35-60 vigor with survival off and fight_above_vigor 0;
//   * jobs PAUSED by a tripwire (`buy-sapphires`, `walk-legs`) over would-be participants, which the
//     tripwire's own release would restart mid-launch — the errand shape that killed Lew and Zoot;
//   * ten bodies with no food against "about ten meals per body per hour", and two with sapphires.
//
// The first shadow run of `avar-village` from that state lost five of twenty at the inn door (survival off:
// the broker refused their walk, correctly), and one on the road: Janice, at 78% in an avar room, was
// refused a walk out by the 100% travel floor and died there. Readiness is the half of a launch that no
// script had; this is it, as data.
//
// A GAP NAMES ITS REMEDY. `assess` never just says "not ready": every gap carries the remedy kind a
// launch script executes, and a hazard id when the remedy is an act the operator has to say out loud.
import { foodValue } from './m59-items.mjs';
import { survivalOffOf, isNoCombatRoom } from './m59-hazards.mjs';

export const LIVE_JOB_STATES = Object.freeze(['running', 'paused', 'resumed', 'orphaned']);

/** What "ready to set out" means unless a launch says otherwise. The Avar Village plan's own numbers:
 *  0.9 health, 80 vigor (the keeper will not leave a safe room below its rest cap), 4 meals, a fight floor of 60. */
export const DEFAULT_TARGET = Object.freeze({ health: 0.9, vigor: 80, meals: 4, fightAboveVigor: 60, items: {} });

const lc = s => String(s ?? '').toLowerCase().trim();
const amountOf = i => Math.max(1, Number(i?.amount) || 1);

/** Meals carried: the game's own Food tree (m59-items foodValue), never a hand list. */
export const mealsOf = (items = [], isFood = n => !!foodValue(n)) =>
  items.filter(i => isFood(String(i?.name ?? ''))).reduce((n, i) => n + amountOf(i), 0);

/** Count of one named item (singular or plural, exact otherwise). */
export function countOf(items = [], name) {
  const want = lc(name), plural = want.endsWith('s') ? want : `${want}s`, single = want.replace(/s$/, '');
  return items.filter(i => [want, plural, single].includes(lc(i?.name))).reduce((n, i) => n + amountOf(i), 0);
}

/**
 * One character, as a launch reads it: a keeper's cached `/state`, its fleet row, the live jobs over it and
 * the active postures over it. `isFood` is injectable for the offline test.
 */
export function unitFromState(state, { row = null, jobs = [], postures = [], isFood, now = Date.now() } = {}) {
  const policy = state?.autopilot_status?.policy ?? {};
  const items = Array.isArray(state?.items) ? state.items : [];
  return {
    agent: state?.agent ?? row?.agent ?? null, character: state?.character ?? row?.character ?? null,
    room: Number(state?.room?.num) || null, inGame: !!state?.in_game, piloted: !!row?.piloted,
    hp: Number(state?.hp?.value) || 0, hpMax: Number(state?.hp?.max) || 1,
    vigor: Number(state?.vigor?.value ?? state?.vigor) || 0,
    items, meals: mealsOf(items, isFood),
    policy, survivalOff: survivalOffOf(policy, now),
    jobs: jobs.filter(j => LIVE_JOB_STATES.includes(j?.state) && (j.agents ?? []).includes(state?.agent))
      .map(j => ({ id: j.id, name: j.name ?? j.kind ?? 'job', state: j.state, why: j.paused_why ?? j.why ?? null })),
    postures: [...postures],
  };
}

/**
 * The gaps between one character and `target`, each with its remedy. `exclude` is set when no remedy this
 * module knows can make the character a participant (offline, piloted, outside the launch's start rooms).
 *
 *   kind          remedy             what a launch does
 *   job           cancel_job         kill a running job / retire a paused one, so nothing resumes it mid-launch
 *   posture       release_to_hold    release THIS character from the posture to a hold where it stands
 *                                    (hazard release_lockdown: the operator ordered that lockdown)
 *   survival_off  survival_on        survival_enabled: true
 *   fight_floor   fight_floor        fight_above_vigor back to target (a drill leaves 0)
 *   unsafe_room   (exclude)          preparing means standing still; only in a NO_COMBAT room
 *   hurt          rest               rest in place
 *   hungry        receive_food       hand-overs from same-room donors (planHandovers)
 *   tired         eat | rest         eat if it carries food, else rest (resting stops at the rest cap)
 *   item_short    receive_item       hand-overs of a named item (target.items: { sapphire: 6 })
 */
export function assess(u, target = DEFAULT_TARGET, { startRooms = null, roleItems = null } = {}) {
  const t = { ...DEFAULT_TARGET, ...target };
  const gaps = [];
  let exclude = null;
  if (!u.inGame) exclude = 'not in game';
  else if (u.piloted) exclude = 'a person is at the controls';
  else if (startRooms && !startRooms.includes(u.room)) exclude = `in room ${u.room}, not one of the launch's start rooms`;
  else if (!isNoCombatRoom(u.room) && !(target.safeRooms ?? []).includes(u.room))
    exclude = `in room ${u.room}, which is not a no-combat room — preparing means standing still`;
  for (const j of u.jobs) gaps.push({ kind: 'job', remedy: 'cancel_job', id: j.id, why: `${j.name} is ${j.state}${j.why ? ` (${j.why})` : ''}` });
  for (const p of u.postures) gaps.push({ kind: 'posture', remedy: 'release_to_hold', posture: p, hazard: 'release_lockdown', why: `${p} is on over it` });
  if (u.survivalOff) gaps.push({ kind: 'survival_off', remedy: 'survival_on', why: 'survival is off' });
  const fav = Number(u.policy?.fightAboveVigor);
  if (Number.isFinite(fav) && fav < t.fightAboveVigor) gaps.push({ kind: 'fight_floor', remedy: 'fight_floor', why: `fight_above_vigor ${fav}`, to: t.fightAboveVigor });
  if (u.hp / u.hpMax < t.health) gaps.push({ kind: 'hurt', remedy: 'rest', why: `${u.hp}/${u.hpMax}` });
  if (u.meals < t.meals) gaps.push({ kind: 'hungry', remedy: 'receive_food', short: t.meals - u.meals, why: `${u.meals} of ${t.meals} meals` });
  if (u.vigor < t.vigor) gaps.push({ kind: 'tired', remedy: u.meals > 0 ? 'eat' : 'rest', why: `vigor ${u.vigor} of ${t.vigor}` });
  const items = { ...(t.items ?? {}), ...((roleItems && roleItems(u)) ?? {}) };
  for (const [name, min] of Object.entries(items)) {
    const have = countOf(u.items, name);
    if (have < min) gaps.push({ kind: 'item_short', remedy: 'receive_item', item: name, short: min - have, why: `${have} of ${min} ${name}` });
  }
  return { agent: u.agent, character: u.character, room: u.room, exclude, gaps, ready: !exclude && !gaps.length };
}

/**
 * Who hands what to whom, in ONE room at a time (a hand-over is a handshake; nobody walks for it).
 * `short(u)` is how many a character needs; `spare(u)` how many it can give and keep its own target.
 * Largest spare to largest need, so the fewest hand-overs cover the most. Returns
 *   { handovers: [{ room, from, to, amount }], unmet: [{ agent, room, short }] }
 */
export function planHandovers(units, { short, spare }) {
  const handovers = [], unmet = [];
  const rooms = new Map();
  for (const u of units) { if (!rooms.has(u.room)) rooms.set(u.room, []); rooms.get(u.room).push(u); }
  for (const [room, us] of rooms) {
    const donors = us.map(u => ({ u, left: Math.max(0, Math.floor(spare(u))) })).filter(d => d.left > 0).sort((a, b) => b.left - a.left);
    const needs = us.map(u => ({ u, need: Math.max(0, Math.ceil(short(u))) })).filter(n => n.need > 0).sort((a, b) => b.need - a.need);
    for (const n of needs) {
      for (const d of donors) {
        if (!n.need) break;
        if (!d.left || d.u.agent === n.u.agent) continue;
        const amount = Math.min(d.left, n.need);
        handovers.push({ room, from: d.u.agent, to: n.u.agent, amount });
        d.left -= amount; n.need -= amount;
      }
      if (n.need) unmet.push({ agent: n.u.agent, room, short: n.need });
    }
  }
  return { handovers, unmet };
}

/** Food hand-overs: every participant to `target.meals`; a donor keeps its own target plus `keep`. */
export const planFood = (units, { meals = DEFAULT_TARGET.meals, keep = 0 } = {}) =>
  planHandovers(units, { short: u => meals - u.meals, spare: u => u.meals - meals - keep });

/** Named-item hand-overs (sapphires for a lifter): `need(u)` per character, a donor keeps `keep(u)`. */
export const planItem = (units, name, { need, keep = () => 0 }) =>
  planHandovers(units, { short: u => need(u) - countOf(u.items, name), spare: u => countOf(u.items, name) - need(u) - keep(u) });

/** One line per character, worst first — the survey a launch prints before it does anything. */
export function readinessReport(assessments) {
  const rank = a => (a.exclude ? 2 : a.ready ? 0 : 1);
  return [...assessments].sort((a, b) => rank(b) - rank(a) || b.gaps.length - a.gaps.length).map(a =>
    `${String(a.agent).padEnd(9)}${String(a.character ?? '').slice(0, 12).padEnd(13)}${String(a.room ?? '?').padEnd(6)}` +
    (a.exclude ? `OUT: ${a.exclude}` : a.ready ? 'ready' : a.gaps.map(g => `${g.kind}(${g.why})`).join('; ')));
}
