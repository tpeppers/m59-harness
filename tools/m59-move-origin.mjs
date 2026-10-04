// m59-move-origin.mjs — WHO ORDERED THIS MOVE, AND WHO CANCELLED IT.
//
// Every travel, walk and journey carries an ORIGIN: which issuer asked for it. Every cancel
// carries the canceller's origin too, and records the order it pre-empted, so the two sides
// of a preemption are written down at the one place they meet (`Session.cancelMovement`).
//
//   origin = { source: 'fleetscript'|'keeper'|'operator'|'bot'|'mcp'|'unattributed',
//              name,       // script name, keeper subsystem ('shelter', 'town_trip', 'chalice'), tool
//              run_id?,    // a fleetscript run, a bot's lease holder
//              session?,   // the agent session that issued it, when there is one
//              why?,       // a few words, for a cancel
//              at }        // when the order was given
//
// THE INCIDENT, prod 2026-10-04, t9 Camilla. A fleetscript errand (buy-spell) walked her to the
// guild hall 714 three times and three times reported "did not reach 714 in three attempts". The
// journeys were not refused by geometry: they were CANCELLED by other issuers — the errand's own
// clear-the-way cancel, and the keeper's survive-mode shelter logic ("chosen shelter approach
// interrupted: route uses the fallback walker") steering her back toward her assigned room 48.
// The ledger said `cancelled_by: <free text>`; nothing told the operator or the errand that the
// walk had been taken from under it, or by whom. This module is how both sides now say so.
//
// Pure and process-neutral: no broker, no session import, so it is exercised offline
// (m59-move-origin-test.mjs) and shared by the keeper, the broker and FleetScript.
//
// SILENCE IS NOT EMPTY. A caller that passes no origin is recorded as `unattributed`, never as
// nothing and never as a guess — a guessed attribution is worse than an admitted gap
// (the same rule `cancelMovement`'s `why` default has always followed).

export const MOVE_SOURCES = Object.freeze(['fleetscript', 'keeper', 'operator', 'bot', 'mcp', 'unattributed']);

const clip = (v, n = 80) => String(v).trim().slice(0, n);

/**
 * Normalise anything a caller hands over into an origin. Accepts an origin object, a
 * `"source:name"` string, or nothing (then `fallback`, then `unattributed`). An unknown source
 * is kept as `claimed_source` and filed under `unattributed` rather than invented into the enum.
 */
export function moveOrigin(input, fallback = null) {
  if (input == null || input === '') {
    if (fallback != null && fallback !== input) return moveOrigin(fallback, null);
    return Object.freeze({ source: 'unattributed', name: 'unattributed', at: Date.now() });
  }
  let o = input;
  if (typeof input === 'string') {
    const i = input.indexOf(':');
    o = i > 0 ? { source: input.slice(0, i), name: input.slice(i + 1) } : { source: input, name: null };
  }
  if (typeof o !== 'object') return moveOrigin(null, fallback);
  const raw = typeof o.source === 'string' ? o.source.trim().toLowerCase() : '';
  const known = MOVE_SOURCES.includes(raw);
  const name = typeof o.name === 'string' && o.name.trim() ? clip(o.name) : 'unattributed';
  const out = { source: known ? raw : 'unattributed', name };
  if (!known && raw) out.claimed_source = clip(raw, 40);
  for (const k of ['run_id', 'session', 'agent', 'why', 'resumed_by'])
    if (o[k] != null && String(o[k]).trim()) out[k] = clip(o[k], k === 'why' ? 160 : 80);
  out.at = Number.isFinite(Number(o.at)) && Number(o.at) > 0 ? Number(o.at) : Date.now();
  return Object.freeze(out);
}

/** A keeper subsystem's origin: `keeperOrigin('shelter')`. */
export const keeperOrigin = (name, extra = {}) => moveOrigin({ ...extra, source: 'keeper', name });

/**
 * A claimant's `by` string as an origin. Claims are named `fleetscript:<script>` by FleetScript
 * and anything else (`dum/prod two bands@pid-11220`) by a bot, so an unknown prefix is a BOT
 * rather than an unattributed stranger: whoever holds a lease is, by definition, a driver.
 */
export function claimantOrigin(by, extra = {}) {
  const text = typeof by === 'string' ? by.trim() : '';
  if (!text) return moveOrigin(null);
  const i = text.indexOf(':');
  const head = i > 0 ? text.slice(0, i).toLowerCase() : '';
  if (MOVE_SOURCES.includes(head) && head !== 'unattributed')
    return moveOrigin({ ...extra, source: head, name: text.slice(i + 1) });
  return moveOrigin({ ...extra, source: 'bot', name: text });
}

/** `keeper:shelter`, `fleetscript:buy-spell#r7k2`. */
export function originLabel(o) {
  if (!o) return 'unattributed';
  return `${o.source ?? 'unattributed'}:${o.name ?? 'unattributed'}${o.run_id ? `#${o.run_id}` : ''}`;
}

/**
 * Same issuer: same source and name, and the same run when BOTH name one. A script cancelling its
 * own earlier walk is not a preemption. A claim's `by` (`fleetscript:buy-spell`) carries no run id,
 * so it matches the run that holds it rather than reading as a stranger taking that run's walk.
 */
export function sameIssuer(a, b) {
  if (!a || !b) return false;
  return a.source === b.source && a.name === b.name &&
    (a.run_id == null || b.run_id == null || a.run_id === b.run_id);
}

/** The order currently steering this session, or null. Generation-scoped: a cancel ends it. */
export function liveMoveOrder(s) {
  const o = s?.moveOrder;
  if (!o || o.ended_at) return null;
  if (o.generation != null && s.movementGeneration != null && o.generation !== s.movementGeneration) return null;
  return o;
}

const orderView = (o, now = Date.now()) => o ? {
  kind: o.kind ?? 'travel', to: o.to ?? null, origin: o.origin, ordered_by: originLabel(o.origin),
  since_s: Math.max(0, Math.round((now - (o.at ?? now)) / 1000)),
} : null;

/**
 * Run `fn` as a MOVE ORDER on session `s`. Registers `s.moveOrder` for the duration so a cancel
 * can name what it pre-empted, and restores the outer order afterwards.
 *
 * NESTING IS THE COMMON CASE. `travelJob` -> `Autopilot.travel` -> `Session.travel` is one order
 * seen three times; an inner call with no origin of its own, or the same issuer to the same
 * room, INHERITS the outer one rather than replacing it. An inner call with a different origin
 * (a keeper rung walking a hurt body to shelter inside a journey) is its own order.
 */
export async function withMoveOrder(s, { kind = 'travel', to = null, origin = null, generation = null } = {}, fn) {
  if (!s || typeof s !== 'object') return fn();
  const outer = liveMoveOrder(s);
  if (outer && origin == null) return fn();
  const mine = { kind, to: to ?? null,
                 origin: moveOrigin(origin, outer?.origin ?? null),
                 at: Date.now(), generation: generation ?? s.movementGeneration ?? null };
  if (outer && sameIssuer(outer.origin, mine.origin) && Number(outer.to) === Number(mine.to)) return fn();
  s.moveOrder = mine;
  try { return await fn(); }
  finally {
    if (s.moveOrder === mine) {
      mine.ended_at = Date.now();
      s.lastMoveOrder = mine;
      s.moveOrder = outer && !outer.ended_at ? outer : null;
    }
  }
}

/**
 * WRAP A PROTOTYPE'S MOVE METHODS, the way `installIntentObservers` wraps the walkers: the method
 * bodies (and the source-shape tests that read them) are untouched, and every call of
 * `travel(to, opts)` becomes a move order carrying `opts.origin`.
 *
 *   sessionOf(this)   the session the order is registered on (an Autopilot's is `this.s`)
 *   defaultOrigin     used ONLY when the caller named none AND no order is live to inherit —
 *                     an honest `keeper:unattributed` from inside the keeper, never a guess
 */
export function installMoveOrders(prototype, { methods = { travel: 'travel' }, sessionOf = x => x,
                                               defaultOrigin = null } = {}) {
  for (const [name, kind] of Object.entries(methods)) {
    const original = prototype[name];
    if (typeof original !== 'function' || original.__moveOrder) continue;
    const wrapped = function (to, opts, ...rest) {
      const s = sessionOf(this);
      let origin = opts?.origin ?? null;
      if (origin == null && !liveMoveOrder(s) && defaultOrigin)
        origin = typeof defaultOrigin === 'function' ? defaultOrigin(this) : defaultOrigin;
      return withMoveOrder(s, { kind, to, origin, generation: opts?.movementGeneration ?? null },
                           () => original.call(this, to, opts, ...rest));
    };
    Object.defineProperty(wrapped, '__moveOrder', { value: original });
    Object.defineProperty(prototype, name, { value: wrapped, writable: true, configurable: true, enumerable: false });
  }
}

/**
 * The record a cancel leaves behind. Called by `Session.cancelMovement` BEFORE the generation
 * is bumped, so the order it is ending is still live and can be named.
 *
 *   { why, at, room, by, by_label, preempted: {kind,to,origin,ordered_by}|null, self_cancel }
 *
 * A preemption by a DIFFERENT issuer is also kept on `s.lastPreempted` and in `s.preemptions`
 * (the last few), which is what `status`, `fleet` and a FleetScript walk read.
 */
export function recordMovementCancel(s, { why = 'unattributed', origin = null, job = null, now = Date.now() } = {}) {
  const by = moveOrigin(origin, null);
  const live = liveMoveOrder(s);
  const preempted = live ? orderView(live, now)
    : job && !job.done ? { kind: job.kind ?? null, to: job.to ?? null, label: job.label ?? null,
                           origin: job.origin ?? null, ordered_by: job.origin ? originLabel(job.origin) : null }
    : null;
  const self = !!(preempted?.origin && sameIssuer(preempted.origin, by));
  const rec = { why, at: now, room: s?.world?.room?.num ?? null, by, by_label: originLabel(by),
                preempted, self_cancel: self };
  if (live) live.cancelled = rec;
  if (preempted && !self && s && typeof s === 'object') {
    s.lastPreempted = rec;
    s.preemptions = [...(Array.isArray(s.preemptions) ? s.preemptions : []), rec].slice(-6);
  }
  return rec;
}

const hhmmss = t => new Date(t).toISOString().slice(11, 19) + 'Z';

/** "travel to 714 (fleetscript:buy-spell#r1) cancelled by keeper:shelter (chosen shelter…) at 22:03:22Z" */
export function describePreemption(rec) {
  if (!rec) return null;
  const p = rec.preempted;
  const what = p ? `${p.kind === 'travel' || p.kind == null ? 'walk' : p.kind}` +
                   `${p.to != null ? ` to ${p.to}` : p.label ? ` (${p.label})` : ''}` +
                   `${p.ordered_by ? ` ordered by ${p.ordered_by}` : ''}`
                 : 'movement';
  return `${what} cancelled by ${rec.by_label ?? originLabel(rec.by)}` +
         `${rec.why ? ` (${String(rec.why).slice(0, 120)})` : ''} at ${hhmmss(rec.at)}`;
}

const cancelView = (rec, now) => rec ? {
  why: rec.why ?? null, at: rec.at ?? null,
  ago_s: rec.at ? Math.max(0, Math.round((now - rec.at) / 1000)) : null,
  by: rec.by ?? null, by_label: rec.by_label ?? (rec.by ? originLabel(rec.by) : 'unattributed'),
  preempted: rec.preempted ?? null, self_cancel: !!rec.self_cancel,
  summary: describePreemption(rec),
} : null;

/**
 * WHAT `status`, `fleet` AND `autopilot status` SHOW: the order steering the body now, the last
 * cancel of any kind, and the last time another issuer took a move away from its orderer.
 */
export function movementReport(s, now = Date.now()) {
  if (!s) return null;
  return {
    order: orderView(liveMoveOrder(s), now),
    last_cancel: cancelView(s.lastMovementCancel?.by ? s.lastMovementCancel : null, now),
    last_preempted: cancelView(s.lastPreempted, now),
    preemptions: (Array.isArray(s.preemptions) ? s.preemptions : []).map(r => cancelView(r, now)),
  };
}

/**
 * The journey ledger's half: this journey's own origin, and the canceller's provenance — but only
 * a cancel that happened DURING this journey. The row used to carry whatever the last cancel had
 * been, so an arrived journey could name the clear-the-way cancel that preceded it.
 */
export function journeyProvenance({ origin = null, cancel = null, startedAt = 0 } = {}) {
  const within = cancel && Number(cancel.at) >= Number(startedAt || 0);
  return {
    origin: origin ? moveOrigin(origin) : moveOrigin(null),
    ordered_by: originLabel(origin),
    ...(within && cancel.by ? { cancelled_by_origin: cancel.by, cancelled_by_label: originLabel(cancel.by),
                                ...(cancel.self_cancel ? { self_cancel: true } : {}) } : {}),
  };
}

/**
 * The preemptions of ONE order, out of a movement report: those after `since` whose pre-empted
 * order is `mine` (same issuer) — or, for an older keeper that does not report the pre-empted
 * order's origin, any non-self preemption of a walk to `to`.
 */
export function preemptionsOf(report, { mine = null, to = null, since = 0 } = {}) {
  const all = [...(report?.preemptions ?? []), report?.last_preempted].filter(Boolean);
  const seen = new Set(), out = [];
  for (const r of all) {
    if (!(Number(r.at) >= since) || r.self_cancel) continue;
    const key = `${r.at}|${r.by_label}`;
    if (seen.has(key)) continue;
    const p = r.preempted;
    const ours = p?.origin && mine ? sameIssuer(p.origin, mine)
      : to != null && p?.to != null && Number(p.to) === Number(to);
    if (!ours || (mine && sameIssuer(r.by, mine))) continue;
    seen.add(key); out.push(r);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * WILL THIS KEEPER'S POSTURE FIGHT THE WALK? A character in `survive` (or farm) mode with an
 * assigned room that is not the destination has a keeper that will steer it home whenever a
 * survival rung hands the body back mid-walk. A claim takes work and movement, not survival, so
 * this is a WARNING and a recorded cause, never a silent change of orders. Returns a sentence or null.
 */
export function postureConflict(status, to) {
  const st = status?.autopilot_status ?? status;
  if (!st || to == null) return null;
  const pol = st.policy ?? {};
  const assigned = pol.assignedRoom ?? st.assigned_room ?? null;
  const confine = Array.isArray(pol.confineRooms) ? pol.confineRooms.map(Number) : null;
  const mode = st.mode ?? null;
  const bits = [];
  if (assigned != null && Number(assigned) !== Number(to))
    bits.push(`its assigned room is ${assigned}${mode ? ` (mode ${mode})` : ''}, so a survival rung that ` +
              'hands the body back mid-walk steers it toward that room, not this one');
  if (confine?.length && !confine.includes(Number(to)))
    bits.push(`it is confined to ${confine.join('/')}, which does not include ${to}`);
  return bits.length ? `the keeper's posture will fight a walk to ${to}: ${bits.join('; ')}` : null;
}
