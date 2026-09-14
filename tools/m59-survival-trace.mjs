// Cached evidence only. Never consulted by a gameplay decision, never sends a packet.
import { AsyncLocalStorage } from 'node:async_hooks';
import { OF } from './m59-parse.mjs';
import { currentSurvivalDecision, survivalDecisionSnapshot } from './m59-survival-decision.mjs';

export const SURVIVAL_TRACE_LIMITS = Object.freeze({ events: 192, damage: 64,
  age_ms: 30 * 60_000, active: 24, nearby: 24, objects_scanned: 2048,
  string_chars: 400, detail_depth: 5, detail_array: 32, detail_keys: 48, throttle_keys: 32 });
const traces = new WeakMap();
const operations = new AsyncLocalStorage();
const policyKeys = ['fleeBelow', 'restBelow', 'blindWalkWatchdog', 'panicLogoff',
  'useSafeSpots', 'requireSafeWall', 'wallAtAttackers', 'doomedInOpenBelow',
  'doomedInSpotBelow', 'freezeMs', 'breakOutViaLogoff', 'breakOutAbove', 'pull',
  'travelGuard', 'travelFleeFrom', 'travelHold', 'travelHoldBelow', 'travelWallBelow',
  'travelWallBelowOutranked', 'travelDivertBelow', 'travelDivertBelowOutranked', 'travelStopMaxThreats'];
const noteKeys = ['why', 'reason', 'to', 'from', 'where', 'at', 'health', 'flee_at',
  'held_by', 'interrupted', 'pass_blocked_for_s', 'steps_away', 'detour', 'quarry',
  'seconds', 'crowd', 'still_ms', 'source', 'via', 'collisions'];

// Call sites project explicit fields. This is a second bound, not a credential scrubber
// for arbitrary objects: never pass a roster, request, control token or inventory here.
function copy(v, depth = 0) {
  if (v == null || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 400);
  if (depth >= 5) return '[depth limit]';
  if (Array.isArray(v)) return v.slice(0, 32).map(x => copy(x, depth + 1));
  if (typeof v !== 'object') return null;
  return Object.fromEntries(Object.entries(v).slice(0, 48)
    .filter(([k]) => k === 'token_present' || !/password|secret|token|credential/i.test(k))
    .map(([k, x]) => [k, copy(x, depth + 1)]));
}
function pick(v, keys) {
  if (!v) return null;
  return Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, copy(v[k])]));
}
export function tracePoint(v) { return pick(v, ['row', 'col', 'x', 'y', 'predicted']); }
export function traceBody(v) { return v ? { ...tracePoint(v), ...pick(v, ['id', 'name', 'flags']) } : null; }
export function traceRefuge(v) {
  return v ? { ...tracePoint(v), ...pick(v, ['kind', 'room', 'steps_away', 'detour',
    'proven', 'trusted', 'fine', 'score', 'quarry_prediction']) } : null;
}
function state(s) {
  let t = traces.get(s);
  if (!t) {
    t = { started_at: Date.now(), sequence: 0, operation: 0, events: [], damage: [],
      active: new Map(), suppressed: new Map(), suppressed_count: 0,
      dropped: { events: 0, damage: 0, active: 0 }, context_errors: 0, keeper: null, pass: null };
    traces.set(s, t);
  }
  return t;
}
function trim(t, lane, now) {
  const rows = t[lane];
  while (rows.length && (rows.length > SURVIVAL_TRACE_LIMITS[lane]
      || rows[0].at < now - SURVIVAL_TRACE_LIMITS.age_ms)) {
    rows.shift(); t.dropped[lane]++;
  }
}
export function attachSurvivalTrace(s, keeper) {
  try { state(s).keeper = keeper; } catch { /* diagnostics cannot break play */ }
}
export function tracePassContext(s, ctx) {
  try { state(s).pass = { at: Date.now(), room: ctx?.room?.num ?? null,
    health_fraction: ctx?.hp ?? null, health: copy(ctx?.v?.health) }; } catch {}
}
function context(s, t, now) {
  const k = t.keeper, c = s.client, me = c?.self;
  const v = c?.vitals?.(); // M59Client.vitals reads the stat cache only.
  const raw = k?.claims?.get('movement');
  const claim = raw ? { ...pick(raw, ['owner', 'until', 'why']), active: raw.until > now } : null;
  const configured = pick(k?.policy, policyKeys);
  const guard = k?.travelGuard?.();
  const nearby = [];
  let scanned = 0, matching = 0;
  const objects = c?.room?.objects;
  for (const o of objects?.values?.() ?? []) {
    if (scanned >= SURVIVAL_TRACE_LIMITS.objects_scanned) break;
    scanned++;
    if (o.id === c?.selfId || !(o.flags & (OF.ATTACKABLE | OF.PLAYER))) continue;
    matching++;
    const distance = me && Number.isFinite(o.row) && Number.isFinite(o.col)
      ? Math.max(Math.abs(o.row - me.row), Math.abs(o.col - me.col)) : Infinity;
    nearby.push({ body: traceBody(o), distance });
    nearby.sort((a, b) => a.distance - b.distance);
    if (nearby.length > SURVIVAL_TRACE_LIMITS.nearby) nearby.pop();
  }
  return {
    room: s.world?.room?.num ?? null, room_name: s.world?.room?.name ?? null,
    client_room_object_id: c?.room?.id ?? null,
    position: tracePoint(me), client_state: c?.state ?? null,
    health: copy(v?.health), vigor: copy(v?.vigor), movement_generation: s.movementGeneration ?? null,
    doing: k?.doing ?? k?.lastDoing ?? null, mode: k?.mode ?? null,
    pass: k?.passes ?? null, stage: k?.passStage ?? null,
    pass_started_at: k?.passStartedAt ?? null,
    stage_age_ms: k?.passStageAt ? now - k.passStageAt : null,
    pass_observation: t.pass ? { ...t.pass, age_ms: now - t.pass.at } : null,
    last_resync_at: k?.lastResyncAt ?? null,
    hold: traceRefuge(k?.hold), frozen: { until: k?.frozenUntil ?? null,
      sample: pick(k?.freezeSample, ['health', 'room', 'col', 'row']) },
    job: pick(s.job, ['kind', 'label', 'done', 'cancelled', 'cancelRequestedAt']),
    inert: pick(k?.inert, ['why', 'at', 'maxMs', 'travelling', 'to', 'guard']),
    busy: k?.busy ? { ...pick(k.busy, ['by', 'kind', 'label', 'at', 'until']), active: k.busy.until > now } : null,
    movement_claim: claim, suspended_journey: pick(k?.suspendedJourney, ['to', 'why', 'at', 'attempts']),
    route_shelter: s.activeShelter ? { at_step: s.activeShelter.atStep ?? null,
      spots_count: s.activeShelter.spots?.length ?? null, max_detour: s.activeShelter.maxDetour ?? null } : null,
    policies: { configured, flee_at: k?.safety?.()?.fleeAt ?? null,
      blind_walk_watchdog_enabled: k?.policy?.blindWalkWatchdog === true,
      configured_journey_guard: copy(guard), current_travel_allowed: guard ?
        Object.fromEntries(Object.keys(guard).map(key => [key, k.travelAllows?.(key) ?? null])) : null,
      shelter_callback_installed: !!s.shelterPolicy },
    nearby: { source: 'cached room objects; flags do not establish who is attacking',
      objects_total: objects?.size ?? null, objects_scanned: scanned, matching_scanned: matching,
      omitted_matching: matching - nearby.length, scan_truncated: (objects?.size ?? scanned) > scanned,
      bodies: nearby.map(x => ({ ...x.body, squares_away: Number.isFinite(x.distance) ? x.distance : null })) },
    active_operations: [...t.active.keys()],
    survival_decision: (() => { const d = currentSurvivalDecision(s); return d ?
      { id:d.id, strategy:d.strategy, reason:d.reason, chosen_at:d.chosen_at,
        age_ms:now-d.chosen_at, status:d.status, chosen_refuge:d.chosen_refuge,
        previous_decision_id:d.previous_decision_id } : null; })(),
  };
}
function cachedContext(s, t, now) {
  try { return context(s, t, now); }
  catch { t.context_errors++; return { unavailable: true }; }
}
export function traceSurvival(s, kind, detail = {}, { lane = 'events', throttle_ms = 0 } = {}) {
  try {
    const t = state(s), now = Date.now();
    if (lane !== 'events' && lane !== 'damage') return;
    if (throttle_ms) {
      const key = kind + ':' + (detail.what ?? '');
      if (now - (t.suppressed.get(key) ?? -Infinity) < throttle_ms) { t.suppressed_count++; return; }
      t.suppressed.delete(key); t.suppressed.set(key, now);
      if (t.suppressed.size > 32) t.suppressed.delete(t.suppressed.keys().next().value);
    }
    const scope = operations.getStore();
    t[lane].push({ sequence: ++t.sequence, at: now, kind,
      operation_id: scope?.session === s ? scope.id : null,
      detail: copy(detail), context: cachedContext(s, t, now) });
    trim(t, lane, now);
  } catch { /* evidence is never an action dependency */ }
}
export function traceSurvivalNote(s, what, detail) {
  try {
    if (/^frozen\b|NOT MOVING/i.test(what)) return;
    if (!/\bwall\b|safe spot|shelter|watchdog|freez|unfroz|playing dead|reviv|journey|movement|island|wedg|crowd|too hurt|taking.*route|travelling|standing down/i.test(what)) return;
    traceSurvival(s, 'decision', { what, detail: pick(detail, noteKeys) }, { throttle_ms: 5000 });
  } catch {}
}
// AsyncLocalStorage links nested operations without mistaking an unrelated watchdog
// task for their child. Pending operations remain visible even if the await never ends.
export async function traceSurvivalOperation(s, kind, detail, run) {
  let t, op;
  try {
    t = state(s);
    const parent = operations.getStore();
    op = { id: ++t.operation, parent_id: parent?.session === s ? parent.id : null,
      kind, at: Date.now(), movement_generation: s.movementGeneration ?? null, detail: copy(detail) };
    if (t.active.size >= SURVIVAL_TRACE_LIMITS.active) {
      t.active.delete(t.active.keys().next().value); t.dropped.active++;
    }
    t.active.set(op.id, op);
  } catch { return run(); }
  return operations.run({ session: s, id: op.id }, async () => {
    traceSurvival(s, 'operation_begin', op);
    try {
      const result = await run();
      traceSurvival(s, 'operation_end', { id: op.id, kind, elapsed_ms: Date.now() - op.at,
        started_generation: op.movement_generation,
        result: pick(result, ['took', 'arrived', 'already', 'cancelled', 'why', 'reason',
          'crossed', 'crossed_from', 'room', 'via', 'off_by', 'position', 'fine_tried',
          'unreachable_terrain', 'exit_refused']) });
      return result;
    } catch (e) {
      traceSurvival(s, 'operation_error', { id: op.id, kind, elapsed_ms: Date.now() - op.at,
        started_generation: op.movement_generation, error: e?.message ?? String(e) });
      throw e;
    } finally { t.active.delete(op.id); }
  });
}
export function survivalTraceSummary(s) {
  try {
    const t = state(s), now = Date.now();
    trim(t, 'events', now); trim(t, 'damage', now);
    return { version: 1, collector_pid: process.pid, started_at: t.started_at,
      events: t.events.length, damage: t.damage.length, active: t.active.size,
      dropped: { ...t.dropped }, suppressed: t.suppressed_count, context_errors: t.context_errors };
  } catch { return { version: 1, unavailable: true }; }
}
export function survivalTraceSnapshot(s) {
  try {
    const summary = survivalTraceSummary(s), t = state(s), now = Date.now();
    // Detached from live state: completing an await after death cannot rewrite this record.
    const current = cachedContext(s, t, now);
    return structuredClone({ ...summary, captured_at: now, limits: SURVIVAL_TRACE_LIMITS,
      context_errors: t.context_errors, current, active_operations: [...t.active.values()],
      events: t.events, damage: t.damage, survival_decisions: survivalDecisionSnapshot(s) });
  } catch { return { version: 1, unavailable: true }; }
}
