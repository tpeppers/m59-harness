import { immutableStateValue } from './json-value.mjs';

export const PRIMARY_STATE_SCHEMA = 'm59-primary-state/v1';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

// Read an own data property without invoking a getter. Live actor methods and derived
// world services deliberately cannot participate in a primary-state projection.
function data(object, ...keys) {
  const row = record(object);
  if (!row) return undefined;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value !== undefined)
      return descriptor.value;
  }
  return undefined;
}

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = value => Number.isSafeInteger(value) ? value : null;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const text = (value, max = 160) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, max)
  : null;

function vital(value) {
  const row = record(value);
  return {
    value: finite(data(row, 'value')),
    max: finite(data(row, 'max', 'scale_max', 'scaleMax')),
  };
}

// This intentionally projects only primary, already-observed facts. It does not include
// room objects, exits, routes, threat assessment, inventory contents, elapsed counters, or
// anything else that would require a scan or make an unchanged actor look changed over time.
export function projectPrimaryState(source) {
  const root = record(source) ?? {};
  const connection = record(data(root, 'connection')) ?? {};
  const socket = record(data(root, 'socket')) ?? {};
  const room = record(data(root, 'room')) ?? {};
  const you = record(data(root, 'you', 'position')) ?? {};
  const vitals = record(data(root, 'vitals')) ?? {};
  const activity = record(data(root, 'activity')) ?? {};
  const revisions = record(data(root, 'revisions')) ?? {};

  return immutableStateValue({
    schema: PRIMARY_STATE_SCHEMA,
    agent: text(data(root, 'agent'), 64),
    character: text(data(root, 'character'), 100),
    connected: bool(data(root, 'connected') ?? data(connection, 'connected')),
    in_game: bool(data(root, 'in_game', 'inGame') ?? data(connection, 'in_game', 'inGame')),
    socket: {
      phase: text(data(socket, 'phase', 'state'), 40),
      last_rx_at_ms: timestamp(data(socket, 'last_rx_at_ms', 'lastRxAtMs')),
      last_tx_at_ms: timestamp(data(socket, 'last_tx_at_ms', 'lastTxAtMs')),
    },
    room: {
      num: integer(data(room, 'num')),
      name: text(data(room, 'name'), 160),
      object_id: integer(data(room, 'object_id', 'objectId')),
    },
    you: {
      id: integer(data(you, 'id', 'object_id', 'objectId')),
      col: finite(data(you, 'col')),
      row: finite(data(you, 'row')),
      x: integer(data(you, 'x')),
      y: integer(data(you, 'y')),
      facing: finite(data(you, 'facing')) ?? text(data(you, 'facing'), 40),
    },
    vitals: {
      health: vital(data(vitals, 'health') ?? data(root, 'hp', 'health')),
      mana: vital(data(vitals, 'mana') ?? data(root, 'mana')),
      vigor: vital(data(vitals, 'vigor') ?? data(root, 'vigor')),
    },
    gold: integer(data(root, 'gold')),
    activity: {
      driver: text(data(activity, 'driver'), 40),
      mode: text(data(activity, 'mode'), 40),
      running: bool(data(activity, 'running')),
      goal: text(data(activity, 'goal'), 120),
      action: text(data(activity, 'action'), 120),
      job: text(data(activity, 'job'), 120),
      held: bool(data(activity, 'held')),
      stalled_since_ms: timestamp(data(activity, 'stalled_since_ms', 'stalledSinceMs')),
      stalled_why: text(data(activity, 'stalled_why', 'stalledWhy'), 240),
      waiting_on: text(data(activity, 'waiting_on', 'waitingOn'), 240),
    },
    revisions: {
      events: integer(data(revisions, 'events', 'event')),
      room: integer(data(revisions, 'room')),
      inventory: integer(data(revisions, 'inventory')),
      equipment: integer(data(revisions, 'equipment')),
      trade: integer(data(revisions, 'trade')),
    },
  });
}
