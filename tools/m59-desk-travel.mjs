// THE CHALICE DESK AS A WAY TO GET SOMEWHERE. Operator, 2026-10-20: "If we issue an order to get from one map
// to another across the world and rescue or the chalice of the rain is available, will the unit(s) that have
// access to them actually do so? We need that rescue/chalice usage baked in to our movement, so that the order
// 'Get to Tos' can mean 'rescue to barloque and walk to Tos, if the ETA is quicker'."
//
// A unit's OWN teleports -- a carried cup, a learned Rescue -- are already planned inside Session.travel
// (m59-rescue-travel.mjs, opt-in through the private `rescueTravel` policy). What no journey ever considered is
// the fleet's SHARED cup: the desk at the station, which only a town trip or an explicit ride-now used. This adds
// it, at the keeper's single journey gate (`Autopilot.travel`), because the ride is a keeper errand -- it walks to
// the station through `Autopilot.travel` itself and runs the existing ride stage machine (m59-chalice-ride.mjs).
//
// WHEN: the same private policy says `desk: true`. Silence is the old behaviour. Then, before setting out, the
// journey is priced three ways with the one planner the /arrivals page uses (m59-arrival-model.mjs): walking, the
// unit's own Rescue chains, and walk-to-station + served + sip + walk on from the landing. The desk is taken only
// when its p90 beats every option without it by `deskMarginMs` (default 60 s): a queue at the desk is the part
// the model knows least about, so a near tie walks.
//
// WHAT IT REFUSES: everything `rideChaliceNow` refuses (no desk, the holder, the PvP teleport lockout, hurt below
// the flee line, a ride already in flight), a confinement that does not hold the station and landing, an exact
// arrival square or a puzzle hand-off (a map teleport cannot honour either), and a station further than
// `deskMaxHops` (default 6). A refused or failed ride backs that destination off for 10 minutes and the journey
// walks from wherever the body now is. After a landing the journey continues through the ordinary gate.
//
// `m59-desk-travel-test.mjs` pins the decision offline.
import { arrivalOptions } from './m59-arrival-model.mjs';
import { rescueTravelPolicy, verifiedRescueContext, rescueTravelCapabilities, currentEdges } from './m59-rescue-travel.mjs';
import { rideNowCheck, rideChaliceNow } from './m59-chalice-ride.mjs';
import { recordEvent } from './m59-ledger.mjs';

export const DESK_DEFAULTS = Object.freeze({
  serve_ms: 60_000,      // walk-in to sip at the desk, per rider ahead of us included; an assumption until measured
  margin_ms: 60_000,     // the desk must beat everything else at p90 by this much
  max_approach_hops: 6,  // how far a journey will walk to reach the station
  backoff_ms: 10 * 60_000,
  context_ms: 60_000,    // how long a verified guild/hometown reading is reused
});
const PVP_LOCKOUT_MS = 600_000;
const hasDesk = o => o.legs.some(l => l.kind === 'desk');

/**
 * Pure. Walk, own Rescue, or the desk? Returns {ride:true, plan, alt, saves_ms, approach_hops, landing}
 * or {ride:false, why, best?, alt?}.
 */
export function chooseDeskRide({ map, from, to, station, guildHall = null, homeRoom = null, own = [], edges = new Map(),
                                 blocked = [], confine = [], fallbackMs = 20_000, serveMs = DESK_DEFAULTS.serve_ms,
                                 marginMs = DESK_DEFAULTS.margin_ms, maxApproachHops = DESK_DEFAULTS.max_approach_hops,
                                 queued = 0, maxRescues = 1 }) {
  if (!Number.isInteger(station)) return { ride: false, why: 'no chalice station' };
  if (from === to) return { ride: false, why: 'already there' };
  const desk = { kind: 'desk', station, uses: 1, serve_ms: serveMs * (1 + Math.max(0, Number(queued) || 0)) };
  const options = arrivalOptions({ map, from, to, guildHall, homeRoom, methods: [desk, ...own], maxRescues,
                                   blocked, confine, edges, fallbackMs });
  const best = options[0];
  if (!best) return { ride: false, why: 'no route by any means' };
  const alt = options.find(o => !hasDesk(o)) ?? null;
  if (!hasDesk(best)) return { ride: false, why: `${best.label} is quicker than the desk`, best, alt };
  const approach = best.legs[0], approachHops = approach.kind === 'walk' ? approach.hops.length : 0;
  if (approachHops > maxApproachHops)
    return { ride: false, why: `the station is ${approachHops} rooms away (limit ${maxApproachHops})`, best, alt };
  const saves = alt ? alt.p90_ms - best.p90_ms : Infinity;
  if (saves < marginMs)
    return { ride: false, why: `the desk saves ${Math.round(saves / 1000)}s at p90, under the ${Math.round(marginMs / 1000)}s margin`, best, alt };
  return { ride: true, plan: best, alt, saves_ms: saves, approach_hops: approachHops,
           landing: best.legs.find(l => l.kind === 'desk').to };
}

/**
 * Keeper glue, called from `Autopilot.travel` before the body sets out. Returns null when the desk is not in
 * play (silence = walk as before), {rode:false, ...} when it was considered and declined or refused, and
 * {rode:true, landed:true, room} after a landing.
 */
export async function deskRideFirst(ap, to, opts = {}) {
  const s = ap?.s, c = s?.client;
  to = Number(to);
  if (!s?.live || !c || !s.world?.map || !Number.isInteger(to)) return null;
  if (opts.arriveNear || opts.handOffAt || s.combat?.active || ap._rideNow) return null;
  const from = Number(s.world.room?.num);
  if (!Number.isInteger(from) || from === to || from === 1) return null;
  const back = ap._deskBackoff;
  if (back && back.to === to && Date.now() < back.until) return null;
  const policy = await rescueTravelPolicy({ agent: s.name, character: s.credentials?.character,
    spells: (c.spells ?? []).map(sp => c.rsc?.get(sp.nameRsc)), to });
  if (!policy?.enabled || policy.desk !== true) return null;
  if (Date.now() - (s.lastPlayerAttackAt ?? 0) < PVP_LOCKOUT_MS) return null;
  const maxApproachHops = Number(policy.deskMaxHops) || DESK_DEFAULTS.max_approach_hops;
  const { cfg, pre } = await rideNowCheck(ap, { max_hops: maxApproachHops });
  if (!cfg || !pre?.ok) return { rode: false, why: pre?.why ?? 'no desk', code: pre?.code ?? 'off' };
  let ctx = ap._deskContext;
  if (!ctx || Date.now() - ctx.at > DESK_DEFAULTS.context_ms) {
    const v = await verifiedRescueContext(s, policy);
    if (!v) return { rode: false, why: 'guild destination not verified' };
    ctx = ap._deskContext = { ...v, at: Date.now() };
  }
  const own = (await rescueTravelCapabilities(s).catch(() => []))
    .map(cap => ({ ...cap, uses: policy.double ? cap.uses : Math.min(1, cap.uses) }));
  const live = Array.isArray(ap.policy?.confineRooms) ? ap.policy.confineRooms.map(Number) : [];
  const d = chooseDeskRide({
    map: s.world.map, from, to, station: Number(cfg.station_room), guildHall: ctx.guildHall, homeRoom: ctx.homeRoom, own,
    edges: currentEdges(), blocked: [...(s.barredRooms ?? []), ...(opts.avoid ?? []), ...(policy.blocked ?? [])],
    confine: live.length ? live : (policy.confine ?? []), fallbackMs: policy.fallbackMs ?? 20_000,
    serveMs: Number(policy.deskServeMs) || DESK_DEFAULTS.serve_ms, marginMs: Number(policy.deskMarginMs) || DESK_DEFAULTS.margin_ms,
    maxApproachHops, queued: pre.queued ?? 0, maxRescues: policy.double === true ? 2 : 1,
  });
  const brief = { from, to, best: d.best?.label ?? d.plan?.label ?? null, best_p90_s: Math.round((d.best ?? d.plan)?.p90_ms / 1000) || null,
                  alt: d.alt?.label ?? null, alt_p90_s: Math.round(d.alt?.p90_ms / 1000) || null };
  if (!d.ride) {
    const key = `${from}>${to}:${d.why}`;
    if (ap._deskNoted !== key) { ap._deskNoted = key; ap.note?.('walking: the chalice desk is not the quicker way', { ...brief, why: d.why }); }
    return { rode: false, why: d.why, decision: d };
  }
  ap.note?.('taking the chalice desk on the way', { ...brief, landing: d.landing, saves_s: Math.round(d.saves_ms / 1000) || null });
  try { recordEvent(ap.who(), 'desk_travel', { what: 'chosen', ...brief, landing: d.landing, plan: d.plan.label }); } catch {}
  const r = await rideChaliceNow(ap, { max_hops: d.approach_hops, queue: true, why: `journey to ${to}` });
  try { recordEvent(ap.who(), 'desk_travel', { what: r.landed ? 'landed' : 'refused', from, to, landed_in: r.room ?? null,
                                              code: r.refused ?? null, why: r.why ?? null, total_ms: r.total_ms ?? null }); } catch {}
  if (!r.landed) {
    ap._deskBackoff = { to, until: Date.now() + DESK_DEFAULTS.backoff_ms };
    ap.note?.('the chalice desk did not land us; walking', { to, code: r.refused ?? null, why: r.why ?? null });
    return { rode: false, refused: r.refused ?? 'skipped', why: r.why ?? null, decision: d };
  }
  return { rode: true, landed: true, room: r.room, decision: d, ride: r };
}
