// Versioned, presentation-safe state contract for RTS-style clients.
//
// The broker remains the authority and session owner. This module only reduces
// its fleet and cached look responses into a stable snapshot that a renderer can
// consume without learning account credentials or depending on MCP envelopes.
//
// COORDINATE CONTRACT. Snapshot squares use named 1-based KOD `col` and `row`
// fields (JSON property order has no tuple meaning). Fine positions use named `x`
// and `y` in protocol/KOD units (64 per square). Positional native AGENT, ENTITY,
// and EXIT records preserve col before row as part of their versioned wire contract.


export const RTS_SCHEMA = 'm59-rts/v1';
export const RTS_NATIVE_VERSION = 7;
export const RTS_INVENTORY_MAX_ITEMS = 512;

const RTS_INVENTORY_ROLES = new Set(['weapon', 'armor', 'shield', 'helmet', 'food', 'other']);
const RTS_INVENTORY_ACTIONS = new Set(['use', 'unuse', 'eat']);

const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integer = value => Number.isInteger(value) ? value : null;
const text = (value, max = 240) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, max)
  : null;
const bool = value => typeof value === 'boolean' ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const iconResource = value => {
  const resolved = text(value, 200);
  return resolved && !/^<(?:rsc|dynamic)\s+\d+>$/.test(resolved) ? resolved : null;
};

function stringList(value, max = 32) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => text(item, 80)).filter(Boolean))].slice(0, max);
}

function normalizeVitals(value) {
  const row = object(value);
  return {
    value: finite(row.value),
    max: finite(row.max ?? row.scale_max),
    pct: finite(row.pct),
  };
}

function normalizeEquipment(value) {
  const row = object(value);
  const freshMs = finite(row.fresh_ms);
  return {
    known: bool(row.known),
    fresh_ms: freshMs === null ? null : Math.max(0, Math.trunc(freshMs)),
    equipped: stringList((Array.isArray(row.equipped) ? row.equipped : []).map(item =>
      typeof item === 'string' ? item : object(item).name)),
  };
}

function normalizeSpell(value) {
  const row = object(value);
  const id = integer(row.id);
  const name = text(row.name, 160);
  const targets = integer(row.targets);
  // THE SPELL ALLOWLIST WAS RETIRED 2026-09-19 — see the header of m59-rts-safety.mjs. This
  // filter used to drop every spell but create food, create weapon and blink, so an RTS spell
  // list showed three entries however many the character really knew. It now reports them all,
  // and only a malformed row is dropped.
  if (id === null || !name || !Number.isSafeInteger(targets) || targets < 0) return null;
  return {
    id,
    name,
    targets,
    school: integer(row.school),
  };
}

function normalizeSpells(value) {
  if (!Array.isArray(value)) return [];
  // Preserve the server's order: it is the same order the native client presents,
  // and unlike a set of labels it may be meaningful to a UI grouping the spellbook.
  // BP_SPELLS carries a u16 count; the aggregate endpoint's 8 MiB response ceiling
  // remains the tighter fail-closed bound for pathological payloads.
  return value.slice(0, 0xFFFF).map(normalizeSpell).filter(Boolean);
}

function normalizeInventoryItem(value) {
  const row = object(value);
  const id = integer(row.id);
  const name = text(row.name, 160);
  if (id === null || !name) return null;
  const amount = integer(row.amount);
  const roleValue = text(row.role, 20);
  const role = roleValue && RTS_INVENTORY_ROLES.has(roleValue) ? roleValue : 'other';
  const equipped = bool(row.equipped);
  const offeredActions = new Set(stringList(row.safe_actions, 3)
    .filter(action => RTS_INVENTORY_ACTIONS.has(action)));
  const safeActions = [];
  if (role === 'food' && offeredActions.has('eat')) safeActions.push('eat');
  else if (['weapon', 'armor', 'shield', 'helmet'].includes(role)) {
    if (equipped === true && offeredActions.has('unuse')) safeActions.push('unuse');
    if (equipped === false && offeredActions.has('use')) safeActions.push('use');
  }
  return {
    id,
    name,
    amount: amount !== null && amount >= 1 ? amount : 1,
    // The use-list is not guaranteed to have arrived after login. Null is
    // deliberately distinct from a server-observed "not equipped".
    equipped,
    role,
    safe_actions: safeActions,
  };
}

function normalizeInventory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, RTS_INVENTORY_MAX_ITEMS)
    .map(normalizeInventoryItem).filter(Boolean);
}

function normalizeCommander(value) {
  const row = object(value);
  const heartbeat = integer(row.heartbeat_default_ms ?? row.heartbeat_ms);
  return {
    enabled: bool(row.enabled) === true,
    authority: text(row.authority, 120),
    heartbeat_ms: heartbeat !== null && heartbeat >= 0 ? heartbeat : null,
  };
}

function normalizeControl(value) {
  const row = object(value);
  const expiresAt = integer(row.expires_at_ms);
  const expiresIn = integer(row.expires_in_ms);
  return {
    lease_state: text(row.lease_state, 40) || 'unavailable',
    lease_id: text(row.lease_id, 120),
    owner: text(row.owner, 120),
    expires_at_ms: expiresAt !== null && expiresAt >= 0 ? expiresAt : null,
    expires_in_ms: expiresIn !== null && expiresIn >= 0 ? expiresIn : null,
    faculties: stringList(row.leased_faculties, 16),
    keeper_state: text(row.keeper_state, 40),
    blocked_reason: text(row.blocked_reason, 240),
  };
}

function normalizeCommerceIdentity(value) {
  const row = object(value);
  const id = integer(row.id);
  const name = text(row.name, 160);
  return id !== null && id > 0 && name ? { id, name } : null;
}

function normalizeCommerceItems(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const items = [];
  for (const raw of value.slice(0, RTS_INVENTORY_MAX_ITEMS)) {
    const row = object(raw);
    const identity = normalizeCommerceIdentity(row);
    const quantity = integer(row.quantity);
    if (!identity || quantity === null || quantity < 1 || seen.has(identity.id)) continue;
    seen.add(identity.id);
    items.push({ ...identity, quantity });
  }
  return items.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
}

function normalizeCommerceCatalogue(value, observedAtMs) {
  const row = object(value);
  const merchant = normalizeCommerceIdentity(row.merchant);
  if (!merchant) return null;
  const items = [];
  const seen = new Set();
  for (const raw of (Array.isArray(row.items) ? row.items : []).slice(0, RTS_INVENTORY_MAX_ITEMS)) {
    const item = object(raw);
    const identity = normalizeCommerceIdentity(item);
    const available = integer(item.available_quantity);
    const max = integer(item.max_quantity);
    const unitPrice = integer(item.unit_price);
    const currency = text(item.currency, 40);
    if (!identity || seen.has(identity.id) || unitPrice === null || unitPrice < 0) continue;
    seen.add(identity.id);
    items.push({
      ...identity,
      available_quantity: available !== null && available >= 0 ? available : null,
      max_quantity: max !== null && max >= 0 ? max : null,
      unit_price: unitPrice,
      currency,
    });
  }
  return {
    merchant,
    observed_at_ms: observedAtMs,
    items: items.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name)),
  };
}

function normalizeCommerceTrade(value) {
  const row = object(value);
  if (!Object.keys(row).length) return null;
  const revision = integer(row.revision);
  if (revision === null || revision < 0) return null;
  const updatedAt = integer(row.updated_at_ms);
  return {
    revision,
    role: text(row.role, 40),
    counterparty: normalizeCommerceIdentity(row.counterparty),
    ours: normalizeCommerceItems(row.ours),
    theirs: normalizeCommerceItems(row.theirs),
    may_accept: bool(row.may_accept) === true,
    updated_at_ms: updatedAt !== null && updatedAt >= 0 ? updatedAt : null,
  };
}

function normalizeCommerce(value) {
  const row = object(value);
  if (text(row.error, 240)) return { error: text(row.error, 240) };
  const purse = object(row.purse);
  const amount = integer(purse.amount);
  const observedAt = integer(row.observed_at_ms);
  const affordances = object(row.affordances);
  const targets = kind => {
    const seen = new Set();
    return (Array.isArray(affordances[kind]) ? affordances[kind] : [])
      .map(normalizeCommerceIdentity).filter(identity => {
        if (!identity || seen.has(identity.id)) return false;
        seen.add(identity.id);
        return true;
      }).sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
  };
  const observedAtMs = observedAt !== null && observedAt >= 0 ? observedAt : null;
  return {
    purse: {
      amount: amount !== null && amount >= 0 ? amount : null,
      currency: text(purse.currency, 40),
    },
    affordances: {
      buy: targets('buy'),
      sell: targets('sell'),
      offer: targets('offer'),
    },
    catalog: normalizeCommerceCatalogue(row.catalog, observedAtMs),
    trade: normalizeCommerceTrade(row.trade),
    observed_at_ms: observedAtMs,
    refresh: text(row.refresh, 80),
  };
}

function normalizeAnimation(value) {
  const row = object(value);
  const type = integer(row.type ?? row.animation);
  if (type === null) return null;
  return {
    type,
    group: integer(row.group),
    period: integer(row.period),
    group_low: integer(row.group_low ?? row.groupLow),
    group_high: integer(row.group_high ?? row.groupHigh),
    group_final: integer(row.group_final ?? row.groupFinal),
  };
}

function normalizeOverlay(value) {
  const row = object(value);
  const iconRsc = integer(row.icon_rsc ?? row.iconRsc);
  const resource = iconResource(row.icon_resource);
  if (iconRsc === null && resource === null) return null;
  return {
    icon_rsc: iconRsc,
    icon_resource: resource,
    hotspot: integer(row.hotspot),
    translation: integer(row.translation),
    effect: integer(row.effect),
    animation: normalizeAnimation(row.animation ?? row.animate),
  };
}

function normalizeLayer(value) {
  const row = object(value);
  if (!Object.keys(row).length) return null;
  return {
    translation: integer(row.translation),
    effect: integer(row.effect),
    animation: normalizeAnimation(row.animation ?? row.animate),
    // Overlay count is a u8 on the wire. Preserve order and duplicates because both
    // participate in hotspot composition; unlike a list of names, this is not a set.
    overlays: (Array.isArray(row.overlays) ? row.overlays : [])
      .slice(0, 255).map(normalizeOverlay).filter(Boolean),
  };
}

function normalizeLight(value) {
  const row = object(value);
  if (!Object.keys(row).length) return null;
  return {
    flags: integer(row.flags),
    intensity: integer(row.intensity),
    color: integer(row.color),
  };
}

function normalizeAppearance(value) {
  const row = object(value);
  if (!Object.keys(row).length) return null;
  return {
    icon_rsc: integer(row.icon_rsc ?? row.iconRsc),
    // This is the exact RSC-resolved filename, normally a .bgf. Do not fabricate a
    // filename from the numeric id: dynamic/unknown resources must stay visibly unknown.
    icon_resource: iconResource(row.icon_resource),
    flags: integer(row.flags),
    rarity: integer(row.rarity),
    light: normalizeLight(row.light),
    translation: integer(row.translation),
    effect: integer(row.effect),
    animation: normalizeAnimation(row.animation ?? row.animate),
    overlays: (Array.isArray(row.overlays) ? row.overlays : [])
      .slice(0, 255).map(normalizeOverlay).filter(Boolean),
    motion: normalizeLayer(row.motion),
  };
}

function normalizeFleetUnit(value) {
  const row = object(value);
  const agent = text(row.agent, 64);
  const character = text(row.character, 100);
  if (!agent || !character) return null;
  const autopilot = object(row.autopilot);
  return {
    agent,
    character,
    room_num: integer(row.room_num),
    room: text(row.room, 160),
    level: finite(row.level),
    activity: text(row.activity, 120),
    busy: text(row.busy, 120),
    last_action: text(row.last_action, 160),
    took_s: finite(row.took_s),
    ok: bool(row.ok),
    cancelled: bool(row.cancelled),
    failed: text(row.failed, 240),
    stalled: typeof row.stalled === 'boolean' || typeof row.stalled === 'string'
      ? row.stalled
      : null,
    needs_operator: typeof row.needs_operator === 'boolean' || typeof row.needs_operator === 'string'
      ? row.needs_operator
      : null,
    autopilot: Object.keys(autopilot).length ? {
      running: bool(autopilot.running),
      mode: text(autopilot.mode, 40),
    } : null,
  };
}

function normalizeEntity(value, agent) {
  const row = object(value);
  const id = integer(row.id);
  const name = text(row.name, 160);
  if (id === null || !name) return null;
  const standOn = object(row.stand_on);
  const can = stringList(row.can);
  return {
    id,
    name,
    col: finite(row.col),
    row: finite(row.row),
    x: integer(row.x),
    y: integer(row.y),
    angle: integer(row.angle),
    appearance_revision: integer(row.appearance_revision ?? row.appearanceRevision),
    distance: finite(row.distance),
    facing: text(row.facing, 40),
    facing_degrees: finite(row.facing_degrees),
    appearance: normalizeAppearance(row.appearance),
    is_player: bool(row.is_player),
    relation: text(row.relation, 40),
    safety_on: bool(row.safety_on),
    reachable: bool(row.reachable),
    steps_to_reach: finite(row.steps_to_reach),
    stand_on: finite(standOn.col) !== null && finite(standOn.row) !== null
      ? { col: finite(standOn.col), row: finite(standOn.row) }
      : null,
    can,
    seen_by: [agent],
    // Affordances can be observer-relative (notably player relationships and
    // safety). Never let a merged room entity transfer one character's permission
    // to another character merely because both can see the same object id.
    attackable_by: can.includes('attack') ? [agent] : [],
  };
}

function normalizeExit(value, agent) {
  const row = object(value);
  const kind = text(row.kind, 40);
  const standOn = object(row.stand_on);
  if (!kind) return null;
  return {
    kind,
    to: integer(row.to),
    to_name: text(row.to_name, 160),
    stand_on: finite(standOn.col) !== null && finite(standOn.row) !== null
      ? { col: finite(standOn.col), row: finite(standOn.row) }
      : null,
    steps_away: finite(row.steps_away),
    reachable: bool(row.reachable),
    how: text(row.how, 240),
    trigger: text(row.trigger, 160),
    seen_by: [agent],
  };
}

function mergeSeen(target, incoming) {
  target.seen_by = [...new Set([...target.seen_by, ...incoming.seen_by])].sort();
  target.attackable_by = [...new Set([
    ...(target.attackable_by || []), ...(incoming.attackable_by || []),
  ])].sort();
  return target;
}

function roomKey(roomNum) {
  return String(roomNum);
}

function exitKey(exit) {
  return [exit.kind, exit.to ?? '', exit.stand_on?.col ?? '', exit.stand_on?.row ?? ''].join(':');
}

export function buildRtsSnapshot({ health, fleetPayload, looks, equipment, spells, inventory,
                                   commander, control, commerce, observedAt, sequence }) {
  const broker = object(health);
  const fleet = object(fleetPayload);
  const rows = Array.isArray(fleet.fleet) ? fleet.fleet : [];
  const fleetByAgent = new Map(rows.map(normalizeFleetUnit).filter(Boolean).map(row => [row.agent, row]));
  const lookEntries = looks instanceof Map ? [...looks.entries()] : Object.entries(object(looks));
  const equipmentByAgent = equipment instanceof Map ? equipment : new Map(Object.entries(object(equipment)));
  const spellsByAgent = spells instanceof Map ? spells : new Map(Object.entries(object(spells)));
  const inventoryByAgent = inventory instanceof Map
    ? inventory : new Map(Object.entries(object(inventory)));
  const controlByAgent = control instanceof Map ? control : new Map(Object.entries(object(control)));
  const commerceByAgent = commerce instanceof Map ? commerce : new Map(Object.entries(object(commerce)));
  const rooms = new Map();
  const agents = [];
  const errors = [];

  for (const [agent, result] of lookEntries) {
    const fleetUnit = fleetByAgent.get(agent);
    if (!fleetUnit) {
      errors.push({ agent, code: 'not-in-fleet', message: 'agent is not present in the broker fleet snapshot' });
      continue;
    }
    if (result instanceof Error || result?.error) {
      errors.push({
        agent,
        code: 'look-failed',
        message: text(result instanceof Error ? result.message : result.error, 240) || 'look failed',
      });
      continue;
    }

    const look = object(result);
    const equipmentResult = equipmentByAgent.get(agent);
    const equipmentFailed = equipmentResult instanceof Error || equipmentResult?.error;
    if (equipmentFailed) {
      errors.push({
        agent,
        code: 'equipment-failed',
        message: text(equipmentResult instanceof Error ? equipmentResult.message : equipmentResult.error, 240) ||
          'equipment read failed',
      });
    }
    const room = object(look.room);
    const you = object(look.you);
    const vitals = object(look.vitals);
    const roomNum = integer(room.num);
    if (roomNum === null || finite(you.col) === null || finite(you.row) === null) {
      errors.push({ agent, code: 'incomplete-look', message: 'look did not include a room and player position' });
      continue;
    }

    const key = roomKey(roomNum);
    if (!rooms.has(key)) {
      const size = object(room.size);
      rooms.set(key, {
        num: roomNum,
        name: text(room.name, 160) || fleetUnit.room || `Room ${roomNum}`,
        resource: text(room.resource, 160),
        rows: integer(size.rows),
        cols: integer(size.cols),
        observed_by: [],
        entities: new Map(),
        exits: new Map(),
      });
    }
    const roomOut = rooms.get(key);
    roomOut.observed_by.push(agent);

    for (const raw of Array.isArray(look.objects) ? look.objects : []) {
      const entity = normalizeEntity(raw, agent);
      if (!entity) continue;
      const known = roomOut.entities.get(entity.id);
      roomOut.entities.set(entity.id, known ? mergeSeen(known, entity) : entity);
    }
    for (const raw of Array.isArray(look.exits) ? look.exits : []) {
      const exit = normalizeExit(raw, agent);
      if (!exit) continue;
      const eKey = exitKey(exit);
      const known = roomOut.exits.get(eKey);
      roomOut.exits.set(eKey, known ? mergeSeen(known, exit) : exit);
    }

    agents.push({
      ...fleetUnit,
      room_num: roomNum,
      room: roomOut.name,
      room_resource: roomOut.resource,
      object_id: integer(you.object_id),
      col: finite(you.col),
      row: finite(you.row),
      x: integer(you.x),
      y: integer(you.y),
      angle: integer(you.angle),
      appearance_revision: integer(you.appearance_revision ?? you.appearanceRevision),
      facing: text(you.facing, 40),
      facing_degrees: finite(you.facing_degrees),
      appearance: normalizeAppearance(you.appearance),
      on_walkable: bool(you.on_walkable),
      health: normalizeVitals(vitals.health),
      mana: normalizeVitals(vitals.mana),
      vigor: normalizeVitals(vitals.vigor),
      equipment: normalizeEquipment(equipmentFailed ? null : equipmentResult),
      spells: normalizeSpells(spellsByAgent.get(agent)),
      inventory: normalizeInventory(inventoryByAgent.get(agent)),
    });
  }

  const roomList = [...rooms.values()].map(room => ({
    ...room,
    observed_by: [...new Set(room.observed_by)].sort(),
    entities: [...room.entities.values()].sort((a, b) => a.id - b.id),
    exits: [...room.exits.values()].sort((a, b) =>
      (a.to ?? Number.MAX_SAFE_INTEGER) - (b.to ?? Number.MAX_SAFE_INTEGER) || a.kind.localeCompare(b.kind)),
  })).sort((a, b) => a.num - b.num);

  const controlOut = Object.create(null);
  const commerceOut = Object.create(null);
  for (const agent of agents) {
    controlOut[agent.agent] = normalizeControl(controlByAgent.get(agent.agent));
    commerceOut[agent.agent] = normalizeCommerce(commerceByAgent.get(agent.agent));
  }

  return {
    schema: RTS_SCHEMA,
    sequence: text(sequence, 100) || String(Date.now()),
    observed_at: text(observedAt, 80) || new Date().toISOString(),
    source: {
      authority: 'meridian59-broker',
      perception: 'controlled-characters-only',
      fleet: text(broker.fleet, 64),
      broker_pid: integer(broker.pid),
    },
    commander: normalizeCommander(commander),
    control: controlOut,
    commerce: commerceOut,
    agents: agents.sort((a, b) => a.agent.localeCompare(b.agent)),
    rooms: roomList,
    errors: errors.sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

function encodeField(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return encodeURIComponent(String(value));
}

function encodeList(values) {
  return (values || []).map(encodeField).join(',');
}

function animationFields(value) {
  return [value?.type, value?.group, value?.period, value?.group_low,
          value?.group_high, value?.group_final];
}

export function toNativeSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== RTS_SCHEMA) throw new Error(`expected ${RTS_SCHEMA} snapshot`);
  const lines = [];
  const line = (...fields) => lines.push(fields.map(encodeField).join('\t'));
  const appearances = new Set();
  // Native v3 keeps AGENT/ENTITY at their prior field counts and adds records:
  // APPEARANCE room object revision x y angle degrees icon_rsc icon_resource
  //   flags rarity light_flags light_intensity light_color translation effect
  //   <base animation x6> motion_translation motion_effect <motion animation x6>
  // OVERLAY room object base|motion index icon_rsc icon_resource hotspot
  //   translation effect <animation x6>
  // Animation fields are type, group, period_ms, group_low, group_high, group_final.
  // Native v4 appends attackable_by to ENTITY. It is intentionally distinct from
  // seen_by because affordances can be observer-relative.
  // Native v5 adds one SPELL record per cached known spell immediately after its
  // AGENT. It does not change the fixed AGENT or ENTITY field counts.
  // Native v6 follows those spells with cached ITEM records and an optional recent
  // ACTION outcome. Native v7 adds token-free commander, lease, commerce catalog,
  // and exact two-sided trade telemetry. Older fixed record shapes remain unchanged.
  const appearance = (room, objectId, value) => {
    if (room === null || room === undefined || objectId === null || objectId === undefined) return;
    const visual = value?.appearance;
    // v3 does not invent a blank appearance record for legacy/incomplete input. A
    // later observer of this same object may have the complete wire appearance.
    if (!visual) return;
    const key = `${room}:${objectId}`;
    if (appearances.has(key)) return;
    appearances.add(key);
    const motion = visual?.motion;
    line('APPEARANCE', room, objectId, value?.appearance_revision,
         value?.x, value?.y, value?.angle, value?.facing_degrees,
         visual?.icon_rsc, visual?.icon_resource,
         visual?.flags, visual?.rarity, visual?.light?.flags,
         visual?.light?.intensity, visual?.light?.color,
         visual?.translation, visual?.effect, ...animationFields(visual?.animation),
         motion?.translation, motion?.effect, ...animationFields(motion?.animation));
    for (const [source, overlays] of [['base', visual?.overlays], ['motion', motion?.overlays]]) {
      for (const [index, overlay] of (overlays || []).entries()) {
        line('OVERLAY', room, objectId, source, index, overlay.icon_rsc,
             overlay.icon_resource, overlay.hotspot, overlay.translation, overlay.effect,
             ...animationFields(overlay.animation));
      }
    }
  };
  line('M59RTS', RTS_NATIVE_VERSION, snapshot.sequence, snapshot.observed_at,
       snapshot.source?.fleet, snapshot.source?.broker_pid);
  line('COMMANDER', snapshot.commander?.enabled, snapshot.commander?.authority,
       snapshot.commander?.heartbeat_ms);
  for (const agent of snapshot.agents || []) {
    line('AGENT', agent.agent, agent.character, agent.room_num, agent.room,
         agent.room_resource, agent.level, agent.object_id, agent.col, agent.row,
         agent.facing, agent.facing_degrees, agent.health?.value, agent.health?.max,
         agent.mana?.value, agent.mana?.max, agent.vigor?.value, agent.vigor?.max,
         agent.activity, agent.busy, agent.equipment?.known, agent.equipment?.fresh_ms,
         (agent.equipment?.equipped || []).join(','));
    for (const spell of agent.spells || [])
      line('SPELL', agent.agent, spell.id, spell.name, spell.targets, spell.school);
    for (const item of agent.inventory || [])
      line('ITEM', agent.agent, item.id, item.name, item.amount, item.equipped,
           item.role, encodeList(item.safe_actions));
    if (agent.last_action)
      line('ACTION', agent.agent, agent.last_action, agent.took_s, agent.ok,
           agent.cancelled, agent.failed);
    const control = snapshot.control?.[agent.agent];
    line('CONTROL', agent.agent, control?.lease_state, control?.lease_id, control?.owner,
         control?.expires_at_ms, control?.expires_in_ms, encodeList(control?.faculties),
         control?.keeper_state, control?.blocked_reason);
    const commerce = snapshot.commerce?.[agent.agent];
    line('COMMERCE', agent.agent, commerce?.purse?.amount, commerce?.purse?.currency);
    const targets = new Map();
    for (const kind of ['buy', 'sell', 'offer']) {
      for (const target of commerce?.affordances?.[kind] || []) {
        const key = `${target.id}\0${target.name}`;
        if (!targets.has(key)) targets.set(key,
          { ...target, buy: false, sell: false, offer: false });
        targets.get(key)[kind] = true;
      }
    }
    for (const target of targets.values())
      line('COMMERCE_TARGET', agent.agent, agent.room_num, target.id, target.name,
           target.buy, target.sell, target.offer);
    if (commerce?.catalog) {
      line('CATALOG', agent.agent, commerce.catalog.merchant?.id,
           commerce.catalog.merchant?.name, commerce.catalog.observed_at_ms);
      for (const item of commerce.catalog.items || [])
        line('CATALOG_ITEM', agent.agent, commerce.catalog.merchant?.id, item.id,
             item.name, item.available_quantity, item.max_quantity, item.unit_price,
             item.currency);
    }
    if (commerce?.trade) {
      const trade = commerce.trade;
      line('TRADE', agent.agent, trade.revision, trade.role, trade.counterparty?.id,
           trade.counterparty?.name, trade.may_accept, trade.updated_at_ms);
      for (const item of trade.ours || [])
        line('TRADE_ITEM', agent.agent, 'ours', item.id, item.name, item.quantity);
      for (const item of trade.theirs || [])
        line('TRADE_ITEM', agent.agent, 'theirs', item.id, item.name, item.quantity);
    }
    appearance(agent.room_num, agent.object_id, agent);
  }
  for (const room of snapshot.rooms || []) {
    line('ROOM', room.num, room.name, room.resource, room.rows, room.cols,
         encodeList(room.observed_by));
    for (const entity of room.entities || []) {
      line('ENTITY', room.num, entity.id, entity.name, entity.col, entity.row,
           entity.distance, entity.facing, entity.is_player, entity.relation,
           entity.safety_on, entity.reachable, entity.steps_to_reach,
           entity.stand_on?.col, entity.stand_on?.row, encodeList(entity.can),
           encodeList(entity.seen_by), encodeList(entity.attackable_by));
      appearance(room.num, entity.id, entity);
    }
    for (const exit of room.exits || []) {
      line('EXIT', room.num, exit.kind, exit.to, exit.to_name, exit.stand_on?.col,
           exit.stand_on?.row, exit.reachable, exit.steps_away, exit.how,
           exit.trigger, encodeList(exit.seen_by));
    }
  }
  for (const error of snapshot.errors || []) line('ERROR', error.agent, error.code, error.message);
  line('END');
  return lines.join('\n') + '\n';
}
