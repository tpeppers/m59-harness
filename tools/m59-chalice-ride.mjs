// RIDE THE CHALICE NOW: the fleet's Chalice of the Rain on demand, outside a town trip.
//
// Operator, 2026-10-03: "Build the direct ride the chalice now for couriers bit and enable that."
// Until this, a ride happened only INSIDE a keeper town trip (`Autopilot.chaliceRide(trip)`, called
// from the town-trip flow when `shouldRide` says the station is on the way). A courier that wants
// to be in the Bookmaker's hall (714) — the mushroom courier fetching purple mushrooms for a caster
// in Castle Victoria — had to walk there instead, through everything between.
//
// THIS IS THE SAME RIDE, NOT A SECOND ONE. It builds a trip marked `onDemand` and drives the very
// stage machine a town trip drives — decide, to_station, room, wait, services, donate, tip, drink,
// landing — so the ticket in the ChaliceStore, the holder's side of the hand-off (`chaliceDuty`,
// which claims ANY open ride ticket), the registered hand-off and the refill are all the existing
// code. What differs is only what a town trip supplies and a demand does not:
//   * no town to compare the station with, so `shouldRide` is asked with no target, and the detour
//     limit is the caller's (`max_hops`), not `max_detour_hops`;
//   * no trip home afterwards, so the landing does not take on the holder's cargo or fund a
//     standing order (it still deposits money the desk handed on with the cup).
//
// WHAT IT REFUSES, BEFORE ANYTHING WALKS, each with a `refused` code and a sentence:
//   off            chalice farming is not configured on this keeper
//   holder         the caller IS the desk (holder, or alternate on duty)
//   carrying       the caller is holding the fleet's cup — it goes back to the desk first
//   pvp            attacked a player inside the server's teleport lockout (chalice.kod:168)
//   no_route       no route to the station
//   too_far        the station is more than `max_hops` away
//   no_holder      nobody is on chalice duty
//   holder_away    the desk's own last word puts it somewhere other than the station
//   busy           another rider has the cup and `queue: false` was asked
//   already_riding a ride is already in flight on this character
//   hurt / dead    survival owns the body; a ride is not started below the flee line
// and, once under way: not_served (nobody brought the cup in time), declined (a person said not
// now), pvp (the sip itself was refused — known from the server's sentence, not by waiting),
// no_landing (no Rescue arrived within `landing_ms`), budget, survival.
//
// SURVIVAL STAYS WITH THE KEEPER. This takes `work`, `movement` and `economy` only when nobody else
// holds them (a FleetScript errand already does), never the protected faculties, and every pass of
// the loop yields to `travelInterrupted()` — the survival ladder's own flag — and gives up before
// the cup is in hand if health falls under the flee line. Once the cup is in the pack the way out
// IS the sip, so a hurt rider drinks rather than walking off with the fleet's only cup.
//
// `m59-chalice-ride-test.mjs` pins it offline against a fake world, holder and store.
import { GUILD_HALL_ROOM, shouldRide, servingDesk, cupInUse, folRoomsOf, sameName } from './m59-chalice.mjs';

export const RIDE_NOW_DEFAULTS = Object.freeze({
  // How far the rider will walk to the station. The courier starts in Castle Victoria (38), one
  // door from the station (2).
  max_hops: 3,
  // Another rider's ride in flight: wait our turn (the store serves tickets oldest first), or say so.
  queue: true,
  // The whole errand: the walk, `wait_ms` for the hand-over, the services, the sip and the landing.
  budget_ms: 8 * 60_000,
});

const RIDE_FACULTIES = ['work', 'movement', 'economy'];
const UNDERWORLD = 1;
// Stages before the cup is in hand: giving up here costs nothing but a ticket.
const BEFORE_THE_CUP = new Set(['decide', 'to_station', 'room', 'wait']);
// How long a desk's "I am in room N" stays evidence.
const DESK_ROOM_FRESH_MS = 3 * 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Clamp the caller's options. Pure. */
export function rideNowOptions(opts = {}) {
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    maxHops: num(opts.max_hops ?? opts.maxHops, 0, 20, RIDE_NOW_DEFAULTS.max_hops),
    queue: (opts.queue ?? RIDE_NOW_DEFAULTS.queue) !== false,
    budgetMs: num(opts.budget_ms ?? opts.budgetMs, 30_000, 30 * 60_000, RIDE_NOW_DEFAULTS.budget_ms),
    pollMs: num(opts.poll_ms ?? opts.pollMs, 5, 5_000, 1_500),
    why: opts.why ? String(opts.why).slice(0, 200) : null,
  };
}

/**
 * MAY THIS CHARACTER RIDE NOW? Pure: the keeper supplies the facts. The decision is `shouldRide`'s,
 * asked with no town and the caller's hop limit; this adds only what a demand needs that a town
 * trip did not — who else has the cup, where the desk says it is, and the body's own state.
 *
 * Returns `{ok:true, server, human, queued}` or `{ok:false, code, why}`.
 */
export function rideNowPreflight({ cfg, role, stationHops = null, maxHops = RIDE_NOW_DEFAULTS.max_hops,
                                   carrying = false, lastPlayerAttackAt = null, duty = null, humans = null,
                                   state = null, me = null, health = null, fleeBelow = 0.4, dead = false,
                                   riding = false, queue = true, now = Date.now() } = {}) {
  if (!cfg?.enabled) return { ok: false, code: 'off', why: 'chalice farming is not configured on this keeper' };
  if (riding) return { ok: false, code: 'already_riding', why: 'a chalice ride is already in flight on this character' };
  if (dead) return { ok: false, code: 'dead', why: 'dead — survival owns the body' };
  if (Number.isFinite(health) && health < fleeBelow)
    return { ok: false, code: 'hurt', why: `health ${Math.round(health * 100)}% is under the flee line ` +
             `(${Math.round(fleeBelow * 100)}%) — survival first, no ride` };
  const d = shouldRide({ cfg: { ...cfg, max_detour_hops: maxHops }, role, stationHops, targetHops: null,
                         carrying, duty, humans, lastPlayerAttackAt, now });
  if (d.returning)
    return { ok: false, code: 'carrying', why: 'carrying the fleet\'s chalice outside a ride — it goes back to the desk first' };
  if (!d.ride) return { ok: false, code: d.code ?? 'declined', why: d.why, ...(d.wait_ms ? { wait_ms: d.wait_ms } : {}) };
  // WHERE THE DESK SAYS IT IS. Written by the server itself while it carries the cup (chaliceDuty),
  // and trusted only while fresh and only when it is the serving character's own word. A forces-of-
  // light visit is a step through a door and back, so a fol room is not "away".
  const desk = servingDesk(duty, cfg, now, humans);
  const at = Number(duty?.room);
  const home = new Set([cfg.station_room, cfg.post_room, ...folRoomsOf(cfg)].filter(n => n != null).map(Number));
  if (desk && !desk.human && Number.isFinite(at) && sameName(duty?.room_by, desk.server)
      && now - (Number(duty?.seen_at) || 0) < DESK_ROOM_FRESH_MS && !home.has(at))
    return { ok: false, code: 'holder_away', why: `${desk.server} is in room ${at}, not at the station (${cfg.station_room})` };
  const use = cupInUse(state, me, now, { servers: [cfg.holder, cfg.alternate].filter(Boolean) });
  if (use.busy && !queue) return { ok: false, code: 'busy', why: `the cup is busy: ${use.why}` };
  return { ok: true, server: d.server, human: !!d.human, queued: use.queued + (use.busy ? 1 : 0),
           ...(use.busy ? { behind: use.by } : {}) };
}

/** A stage machine's sentence, as a code, for the skips that carry none. Pure. */
export function refusalCode(why = '') {
  const w = String(why);
  if (/path of peace|attacked a player/i.test(w)) return 'pvp';
  if (/could not reach the station|no route/i.test(w)) return 'no_route';
  if (/said not now/i.test(w)) return 'declined';
  if (/nobody brought|did not hand the chalice|ticket was dropped/i.test(w)) return 'not_served';
  if (/no landing/i.test(w)) return 'no_landing';
  if (/no room for the chalice/i.test(w)) return 'pack_full';
  return 'skipped';
}

/**
 * Drive one ride to a landing or a refusal. `ap` is the rider's Autopilot. Returns
 *   {ok:true, landed:true, room, guild_hall, ms, total_ms, ticket, server}
 * or
 *   {ok:false, landed:false, refused, why, stage?, ticket?}
 */
export async function rideChaliceNow(ap, opts = {}) {
  const o = rideNowOptions(opts);
  const started = Date.now();
  const refuse = (code, why, extra = {}) => {
    try { ap.chaliceEvent?.('ride_now_refused', { code, why, ...extra }); } catch {}
    return { ok: false, landed: false, refused: code, why, ...extra };
  };
  let cfg = null;
  try { cfg = await ap.refreshChaliceConfig?.(); } catch {}
  cfg ??= ap.chaliceCfg;
  if (!cfg) return refuse('off', 'chalice farming is not configured on this keeper');
  const store = ap.chaliceStore();
  const me = ap.who();
  const vitalsNow = () => {
    const v = ap.s?.client?.vitals?.();
    const h = v?.health;
    return { health: h?.max > 0 ? h.value / h.max : null, dead: (h?.max > 0 && h.value <= 0) || ap.hereRoom() === UNDERWORLD };
  };
  const tripRide = ap.townTrip?.chalice;
  const riding = !!ap._rideNow || !!(tripRide && !['decide', 'off', 'done'].includes(tripRide.stage));
  const here = ap.hereRoom();
  const fleeBelow = Number(ap.policy?.fleeBelow ?? 0.4);
  let state = null;
  try { state = store.read(); } catch {}
  const pre = rideNowPreflight({
    cfg, role: ap.chaliceRole(), me, riding, queue: o.queue, maxHops: o.maxHops,
    stationHops: here === cfg.station_room ? 0 : ap.hopsTo(cfg.station_room),
    carrying: !!ap.chaliceInPack(), lastPlayerAttackAt: ap.lastPlayerSwingAt?.() ?? null,
    duty: state?.duty ?? null, humans: state?.human ?? null, state, fleeBelow, ...vitalsNow(),
  });
  if (!pre.ok) return refuse(pre.code, pre.why, pre.wait_ms ? { wait_ms: Math.round(pre.wait_ms) } : {});

  // THE DIRECTIONAL FACULTIES, only where the keeper still has them: a FleetScript errand that holds
  // them already is the driver, and its lease is not ours to take or to give back.
  const taken = RIDE_FACULTIES.filter(f => !ap.facultyHeld?.(f));
  if (taken.length && typeof ap.claimFaculties === 'function')
    ap.claimFaculties({ faculties: taken, by: 'chalice_ride', leaseMs: o.budgetMs + 60_000,
                        why: `riding the chalice to the guild hall${o.why ? ` (${o.why})` : ''}` });
  const trip = { onDemand: true, maxHops: o.maxHops, why: o.why, startedAt: started,
                 target: { room: GUILD_HALL_ROOM }, chalice: { stage: 'decide', at: started } };
  ap._rideNow = trip;
  try { ap.chaliceEvent?.('ride_now', { why: o.why, server: pre.server, queued: pre.queued, max_hops: o.maxHops }); } catch {}
  const deadline = started + o.budgetMs;
  const abandon = (code, why) => {
    const st = trip.chalice, stage = st.stage;
    if (st.ticket && BEFORE_THE_CUP.has(stage)) try { store.mark(st.ticket, 'abandoned', { note: why }); } catch {}
    st.stage = 'off';
    return refuse(code, why, { stage, ticket: st.ticket ?? null });
  };
  try {
    for (;;) {
      const st = trip.chalice;
      const body = vitalsNow();
      if (body.dead) return abandon('dead', 'died during the ride — survival owns the body');
      if (BEFORE_THE_CUP.has(st.stage) && Number.isFinite(body.health) && body.health < fleeBelow)
        return abandon('survival', `health fell to ${Math.round(body.health * 100)}% before the cup was in hand — ` +
                                   'the ride is given up to the survival ladder');
      // THE LADDER HAS THE BODY THIS PASS: a flee, a rest, a retreat. Wait it out.
      if (ap.travelInterrupted?.()) {
        if (Date.now() > deadline && BEFORE_THE_CUP.has(st.stage))
          return abandon('budget', `the survival ladder held the body past the ${Math.round(o.budgetMs / 1000)}s budget`);
        await sleep(o.pollMs);
        continue;
      }
      // A LANDING IS NEVER CUT SHORT: after the sip the only thing left is to wait `landing_ms`.
      if (Date.now() > deadline && !['drink', 'landing'].includes(st.stage) && !ap.chaliceInPack())
        return abandon('budget', `no landing within the ${Math.round(o.budgetMs / 1000)}s budget (stage ${st.stage})`);
      const r = await ap.chaliceRide(trip).catch(e => ({ skip: true, why: e?.message ?? String(e), code: 'error' }));
      if (r?.done) {
        const room = ap.hereRoom();
        try { ap.chaliceEvent?.('ride_now_landed', { room, ticket: st.ticket ?? null, total_ms: Date.now() - started }); } catch {}
        return { ok: true, landed: true, room, guild_hall: room === GUILD_HALL_ROOM,
                 ms: st.drankAt ? Date.now() - st.drankAt : null, total_ms: Date.now() - started,
                 ticket: st.ticket ?? null, server: st.server ?? pre.server ?? null };
      }
      if (r?.skip) return refuse(r.code ?? st.code ?? refusalCode(r.why), r.why ?? st.why ?? 'the ride stopped',
                                 { stage: st.stage, ticket: st.ticket ?? null });
      const wait = Math.max(5, Math.min((Number(trip.nextTryAt) || 0) - Date.now(), o.pollMs));
      await sleep(wait);
    }
  } finally {
    ap._rideNow = null;
    if (taken.length && typeof ap.releaseFaculties === 'function')
      try { ap.releaseFaculties({ faculties: taken, by: 'chalice_ride' }); } catch {}
  }
}
