// A background travel acknowledgement is deliberately not proof that a keeper started it.
// The broker can answer before the keeper rejects a still-busy job, so the pilgrimage
// confirms every handoff from a later fleet snapshot instead.

export const DISPATCH_CONFIRM_MS = 15_000;
export const DISPATCH_RETRY_MS = 5_000;
export const DISPATCH_MAX_ATTEMPTS = 3;

const ACTIVE = /travell?ing|\bwalk to\b|recovering|resting/i;

export function keeperOwnsMovement(row = {}) {
  const commitment = row.committed;
  const committed = !!commitment &&
    (typeof commitment !== 'object' ||
      (commitment.takeable !== true && commitment.kind !== 'partner'));
  return !!(row.busy || committed || row.suspended_journey || row.recovering_from_death ||
            ACTIVE.test(String(row.activity ?? '')));
}

export function keeperStatusVerificationFailure(status) {
  if (!status || typeof status !== 'object')
    return 'keeper status returned no structured result';
  if (status._error) return String(status._error);
  const note = String(status.note ?? '');
  if (status.keeper_backed === true && /keeper did not answer/i.test(note))
    return note || 'the keeper did not answer';
  return null;
}

export function keeperStatusOwnsMovement(status = {}) {
  const inert = status.inert;
  const inertText = inert && typeof inert === 'object'
    ? `${inert.state ?? ''} ${inert.why ?? ''}` : String(inert ?? '');
  return keeperOwnsMovement(status) || !!status.suspended_journey ||
    !!status.recovering_from_death || ACTIVE.test(inertText);
}

function sameLabel(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

function mentionsExpectedTravel(value, pending) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return false;
  if (pending.expected_name && text.includes(`travelling to ${pending.expected_name.toLowerCase()}`))
    return true;
  return new RegExp(`\\btravelling to ${Number(pending.to)}(?:\\b|\\s)`, 'i').test(text);
}

export function expectedTravelPublished(pending, row = {}) {
  if (!pending?.sent_at) return false;
  if (pending.expected_busy && sameLabel(row.busy, pending.expected_busy)) return true;
  return mentionsExpectedTravel(row.committed?.label, pending) ||
         mentionsExpectedTravel(row.activity, pending);
}

export function newPendingDispatch(to, source = 'cycle', now = Date.now()) {
  return {
    to: Number(to), source, attempts: 0, sent_at: null, retry_at: now,
    last_refusal: null,
  };
}

export function completeCycleArrival(out, ring, now = Date.now()) {
  const arrivedFrom = out.legFrom ?? out.inn;
  const arrivedAt = out.to;
  out.legs.push({
    from: arrivedFrom,
    to: arrivedAt,
    ms: now - out.legBegan,
    deaths: Number(out.deaths ?? 0) - Number(out.deathsAtLegStart ?? 0),
  });
  out.ring = (out.ring + 1) % ring.length;
  out.legFrom = arrivedAt;
  out.to = ring[(out.ring + 1) % ring.length].room;
  // Wall-clock checkpoint-to-checkpoint time deliberately includes handoff teardown and
  // bounded retries: this is a sustained-tour measurement, and it preserves the historical
  // metric. Dispatch telemetry separately exposes any retry cost.
  out.legBegan = now;
  out.deathsAtLegStart = Number(out.deaths ?? 0);
  out.pendingDispatch = newPendingDispatch(out.to, 'cycle', now);
  return out;
}

function reasonText(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function backgroundTravelRefusal(result) {
  if (!result || typeof result !== 'object') return 'background travel returned no structured result';
  const reported = reasonText(result._error ?? result.error ?? result.why ?? result.reason);
  if (reported) return reported;
  if (result.ok === false) return 'background travel returned ok:false';
  if (result.started === false) return 'background travel returned started:false';
  if (result.started !== true)
    return 'background travel did not acknowledge that it started';
  return null;
}

export function noteDispatchResult(pending, result, now = Date.now(), {
  confirmMs = DISPATCH_CONFIRM_MS,
  retryMs = DISPATCH_RETRY_MS,
} = {}) {
  const attempts = Number(pending?.attempts ?? 0) + 1;
  const refusal = backgroundTravelRefusal(result);
  const expectedName = refusal ? null : reasonText(result?.destination?.name);
  return {
    ...pending,
    attempts,
    sent_at: refusal ? null : now,
    retry_at: now + (refusal ? retryMs : confirmMs),
    last_refusal: refusal,
    expected_name: expectedName ?? pending.expected_name ?? null,
    expected_busy: expectedName ? `walk to ${expectedName}` : pending.expected_busy ?? null,
  };
}

export function dispatchDecision(pending, row = {}, now = Date.now(), {
  underworld = 1,
  maxAttempts = DISPATCH_MAX_ATTEMPTS,
} = {}) {
  if (!pending) return { action: 'none', pending: null };
  const room = Number(row.room_num ?? NaN);
  if (Number.isFinite(room) && room === Number(pending.to))
    return { action: 'arrived', pending: null };
  if (room === underworld)
    return { action: 'wait', pending, why: 'the character is in the Underworld' };

  const occupied = keeperOwnsMovement(row);
  if (expectedTravelPublished(pending, row))
    return { action: 'confirmed', pending: null };
  if (occupied)
    return { action: 'wait', pending, why: 'the keeper still owns movement or recovery' };
  if (now < Number(pending.retry_at ?? 0))
    return { action: 'wait', pending, why: 'waiting for the submitted job to appear' };
  if (Number(pending.attempts ?? 0) >= maxAttempts) {
    const why = pending.last_refusal
      ? `next travel was refused ${pending.attempts} time(s): ${pending.last_refusal}`
      : `next travel never appeared after ${pending.attempts} acknowledged request(s)`;
    return { action: 'exhausted', pending, why };
  }
  return { action: 'send', pending };
}
