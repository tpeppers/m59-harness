// Cheap primary state for the lab runtime.
//
// This module intentionally knows nothing about World.exits(), pathfinding, threat,
// journals, trials, or filesystem-backed books.  It reads only values the protocol client
// and controller already hold.  Expensive diagnostic projection belongs on an explicit
// cold path, never on a timer or state subscription.

import { projectPrimaryState } from './state/index.mjs';

export function meridianPrimarySource({ agent, session, controller } = {}) {
  const client = session?.client ?? null;
  const vitals = client?.vitals?.() ?? {};
  const self = client?.self ?? null;
  const roomName = client?.roomNameRsc != null
    ? client?.rsc?.get?.(client.roomNameRsc) ?? null
    : null;
  return projectPrimaryState({
    agent,
    character: client?.me?.name ?? session?.credentials?.character ?? null,
    connected: !!session?.live,
    in_game: !!session?.live,
    socket: {
      phase: client?.state ?? null,
      last_rx_at_ms: client?.lastRxAt || null,
    },
    room: {
      object_id: client?.room?.id ?? null,
      name: roomName,
    },
    you: self ? {
      id: self.id ?? null,
      col: Number.isFinite(self.col) ? self.col : null,
      row: Number.isFinite(self.row) ? self.row : null,
      x: Number.isFinite(self.x) ? self.x : null,
      y: Number.isFinite(self.y) ? self.y : null,
    } : null,
    vitals,
    activity: {
      driver: 'lab-runtime',
      mode: controller?.mode ?? null,
      running: !!controller?.running,
      action: controller?.doing ?? controller?.lastDoing ?? null,
      stalled_since_ms: controller?.stalledSince ?? null,
      stalled_why: controller?.stalledWhy ?? null,
    },
    // Deliberately omit the client's catch-all event sequence. It changes for every
    // packet-derived event and would turn an otherwise identical hot summary into a new
    // fleet revision. Domain-specific revisions can be added when a consumer needs them.
    revisions: {},
  });
}

export const SAFETY_EVENT_KINDS = Object.freeze(new Set([
  'death', 'disconnected', 'closed', 'attacked', 'damage',
]));

// These update already-cached observability but do not, by themselves, justify running
// the whole policy tree. A low-rate reconciliation still observes them. Everything not
// listed is conservatively decision-relevant.
export const OBSERVATION_ONLY_EVENT_KINDS = Object.freeze(new Set([
  'moved', 'player-moved', 'sky', 'who', 'logged-on', 'logged-off',
]));

const VITAL_NAMES = Object.freeze(new Set(['health', 'mana', 'vigor']));
const HEALTH_POLICY_FRACTIONS = Object.freeze([
  'fleeBelow', 'restBelow', 'holdResumeAbove', 'partyHealBelow',
  'doomedInSpotBelow', 'doomedInOpenBelow', 'travelHoldBelow',
  'travelStartHealth', 'travelWallBelow', 'travelWallBelowOutranked',
  'travelDivertBelow', 'travelDivertBelowOutranked',
  'travelHoldResumeAbove', 'travelShelterUnlimitedBelow', 'openFightHealth',
]);
const VIGOR_POLICY_VALUES = Object.freeze([
  'fightAboveVigor', 'vigorFloor', 'vigorCeiling', 'ordinaryVigorFloor',
  'travelVigorFloor', 'travelHoldVigor', 'inkyReserveFloor',
]);

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const thresholdNumber = value => value === null || value === undefined || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const uniqueThresholds = values => [...new Set(values
  .map(thresholdNumber).filter(value => value !== null && value >= 0))].sort((a, b) => a - b);

// A compact copy of the same three primitive bars primary state publishes. Vigor's
// display maximum is scale_max (normally 200); its protocol `max` is only the resting
// threshold and must not be used as the denominator.
export function primaryVitalSnapshot(vitals = {}) {
  const out = {};
  for (const name of VITAL_NAMES) {
    const row = vitals?.[name];
    if (!row || typeof row !== 'object') continue;
    const value = finite(row.value);
    const max = finite(name === 'vigor'
      ? (row.scale_max ?? row.scaleMax ?? row.max)
      : row.max);
    if (value === null && max === null) continue;
    out[name] = { value, max };
  }
  return out;
}

// Exact policy lines plus a deliberately small set of coarse buckets. The buckets cover
// decisions whose less-common threshold is not represented here, while still turning a
// full regeneration into a handful of passes rather than one pass per stat packet.
export function vitalDecisionThresholds(policy = {}) {
  const healthPolicy = HEALTH_POLICY_FRACTIONS.map(key => policy?.[key]);
  const vigorPolicy = VIGOR_POLICY_VALUES.map(key => policy?.[key]);
  const restBelow = thresholdNumber(policy?.restBelow);
  const travelStartVigor = thresholdNumber(policy?.travelStartVigor);
  return {
    health: {
      fractions: uniqueThresholds([
        0.25, 0.3, 0.35, 0.4, 0.5, 0.55, 0.7, 0.75, 0.9, 0.95, 1,
        ...healthPolicy,
      ]),
      values: [],
    },
    mana: {
      fractions: uniqueThresholds([0.25, 0.5, 0.75, 0.95, 1]),
      values: uniqueThresholds([10, 15]),
    },
    vigor: {
      fractions: uniqueThresholds([
        0.1, 0.2, 0.4, 0.7, 1,
        restBelow === null ? null : Math.min(restBelow, 0.4),
        travelStartVigor === null ? null : Math.min(travelStartVigor, 0.4),
      ]),
      values: uniqueThresholds([13, 20, 40, 80, 140, 200, ...vigorPolicy]),
    },
  };
}

function crossed(before, after, threshold) {
  return (before < threshold && after >= threshold) ||
    (before >= threshold && after < threshold);
}

function crossedVitalThreshold(name, before, after, thresholds) {
  if (before?.value === null || before?.value === undefined ||
      after?.value === null || after?.value === undefined) return false;
  for (const threshold of thresholds?.values ?? [])
    if (crossed(before.value, after.value, threshold)) return true;
  if (!(before.max > 0) || !(after.max > 0)) return false;
  const beforeFraction = before.value / before.max;
  const afterFraction = after.value / after.max;
  for (const threshold of thresholds?.fractions ?? [])
    if (crossed(beforeFraction, afterFraction, threshold)) return true;
  return false;
}

function nextVitals(previousVitals, currentVitals, event, name) {
  const prior = primaryVitalSnapshot(previousVitals);
  const current = primaryVitalSnapshot(currentVitals);
  const out = { ...prior, ...current };
  if (String(event?.kind ?? '') !== 'stat' || !VITAL_NAMES.has(name)) return out;
  const value = finite(event?.value);
  if (value === null) return out;
  const existing = out[name] ?? prior[name] ?? {};
  // A vigor stat packet's `max` is its rest threshold. Prefer the already-observed
  // scale maximum, and use the protocol's fixed display scale only as a final fallback.
  const eventMax = name === 'vigor' ? (existing.max ?? 200) : finite(event?.max);
  out[name] = { value, max: existing.max ?? eventMax ?? null };
  return out;
}

export function classifyClientEvent(event, previousHealth = null, {
  previousVitals = null,
  currentVitals = null,
  policy = null,
  thresholds = null,
} = {}) {
  const kind = String(event?.kind ?? 'event');
  const name = String(event?.name ?? '').trim().toLowerCase();
  const vitals = nextVitals(previousVitals, currentVitals, event, name);
  const priorHealth = finite(previousVitals?.health?.value) ?? finite(previousHealth);
  const health = finite(vitals.health?.value) ?? priorHealth;
  const eventHealth = kind === 'stat' && name === 'health' ? finite(event?.value) : null;
  const dropped = eventHealth !== null && priorHealth !== null && eventHealth < priorHealth;
  const isVitalStat = kind === 'stat' && VITAL_NAMES.has(name);
  let thresholdCrossed = false;
  if (isVitalStat) {
    const profile = thresholds ?? vitalDecisionThresholds(policy ?? {});
    thresholdCrossed = crossedVitalThreshold(
      name, primaryVitalSnapshot(previousVitals)[name], vitals[name], profile[name]);
  }
  const statDecision = kind === 'stat' ? thresholdCrossed : null;
  return {
    kind,
    reason: dropped ? 'health-decreased'
      : thresholdCrossed ? `vital-threshold-crossed:${name}`
      : `client:${kind}`,
    safety: dropped || SAFETY_EVENT_KINDS.has(kind),
    decision: dropped || SAFETY_EVENT_KINDS.has(kind) ||
      (statDecision ?? !OBSERVATION_ONLY_EVENT_KINDS.has(kind)),
    health,
    vitals,
    thresholdCrossed,
  };
}
