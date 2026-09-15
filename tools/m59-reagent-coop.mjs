// Reagent coop arithmetic. Quantities are units; reservations are BULK per chest.
import { itemNameKey, weighItem, weighPack } from './m59-items.mjs';
import { CHEST_BULK_MAX, BOOKMAKERS_HALL_ROOM, BOOKMAKERS_CHEST_SQUARES } from './m59-storage.mjs';

// Spell.ResetReagents in compendium/data/koddb.json. The test checks this catalog
// against the game data, including edible mushroom and the non-stackable heartstone.
export const COOP_REAGENTS = Object.freeze([
  'blue dragon scale', 'blue mushroom', 'dark angel feather', 'diamond', 'dragonfly eye',
  'edible mushroom', 'elderberry', 'emerald', 'entroot berry', 'fairy wing', 'firesand',
  'heartstone', 'herb', 'kriipa claw', 'mushroom', 'orc tooth', 'polished seraphym',
  'purple mushroom', 'rainbow fern', 'red mushroom', 'ruby', 'sapphire', 'shaman blood',
  'uncut seraphym', 'vial of solagh', 'web moss', 'yrxl sap',
]);
export const coopKey = value => itemNameKey(value);
export const coopCount = (items, name) => items.filter(i => coopKey(i.name ?? i.item) === coopKey(name))
  .reduce((n, i) => n + Math.max(0, Number(i.amount ?? 1) || 0), 0);

export const REAGENT_COOP_SCHEMA = {
  type: ['object', 'null'], additionalProperties: false, required: ['enabled'],
  description: 'Reagent coop: contribute otherwise-sellable surplus, reserve equal bulk per reagent type, source supplies before buying, and share bank-bound shillings. Null disables it. Personal supplies and protected items are retained.',
  properties: {
    enabled: { type: 'boolean', description: 'Enable the reagent coop on this bot.' },
    bulk_fraction: { type: 'number', minimum: 0, maximum: 1, description: 'Fraction of each chest reserved equally across reagent types. Default 0.90.' },
    reagents: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Reagent types sharing that bulk. Default: all 27 reagent types in the game data.' },
    shilling_tithe_pct: { type: 'number', minimum: 0, maximum: 100, description: 'Minimum percentage of bank-bound surplus contributed per town trip, after retaining shopping money. Default 20.' },
    shilling_cap: { type: 'integer', minimum: 0, maximum: 75000, description: 'Maximum total shillings across all guild chests. Default 75000; money uses no bulk.' },
    hall_room: { type: 'integer', minimum: 1, description: 'Guild hall map number. Default 714, Bookmaker’s Guild House.' },
    chest_keys: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' }, description: 'Chest squares to read before transfers, such as r18c2. All must be readable for the shared shilling cap.' },
    retry_ms: { type: 'integer', minimum: 10000, maximum: 3600000, description: 'Delay before retrying an unavailable coop within the same shopping trip. Default 300000.' },
  },
};

export function coopConfig(raw) {
  if (raw == null || raw.enabled === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.enabled !== true) throw new Error('reagent_coop needs enabled:true or null');
  for (const key of Object.keys(raw)) if (!(key in REAGENT_COOP_SCHEMA.properties)) throw new Error(`unknown reagent_coop option: ${key}`);
  const c = { enabled: true, bulk_fraction: 0.9, reagents: [...COOP_REAGENTS], shilling_tithe_pct: 20,
    shilling_cap: 75000, hall_room: BOOKMAKERS_HALL_ROOM, chest_keys: [...BOOKMAKERS_CHEST_SQUARES], retry_ms: 300000, ...raw };
  for (const key of ['bulk_fraction', 'shilling_tithe_pct', 'shilling_cap', 'hall_room', 'retry_ms']) {
    const spec = REAGENT_COOP_SCHEMA.properties[key], n = c[key];
    if (!Number.isFinite(n) || n < spec.minimum || n > (spec.maximum ?? Infinity)
        || (spec.type === 'integer' && !Number.isSafeInteger(n))) throw new Error(`invalid reagent_coop.${key}`);
  }
  if (!Array.isArray(c.reagents) || !c.reagents.length || c.reagents.length > 100) throw new Error('reagent_coop.reagents must be a nonempty list');
  c.reagents = [...new Set(c.reagents.map(coopKey))];
  if (c.reagents.some(n => !COOP_REAGENTS.includes(n) || !(weighItem(n)?.bulk > 0))) throw new Error('reagent_coop contains an unknown or unweighable reagent');
  if (!Array.isArray(c.chest_keys) || !c.chest_keys.length || c.chest_keys.length > 4
      || c.chest_keys.some(k => !/^r\d+c\d+$/.test(k))) throw new Error('invalid reagent_coop.chest_keys');
  c.chest_keys = [...new Set(c.chest_keys)];
  return c;
}

export function coopDepositPlan({ config, chests, pack, saleItems, keepFloor = () => 0 }) {
  const names = new Set(config.reagents), spare = new Map();
  for (const item of saleItems) {
    const key = coopKey(item.name);
    if (names.has(key)) spare.set(key, (spare.get(key) ?? 0) + item.amount);
  }
  for (const [key, amount] of spare) spare.set(key,
    Math.max(0, Math.min(amount, coopCount(pack, key) - Math.max(0, keepFloor(key)))));
  const plan = [], perTypeBulk = CHEST_BULK_MAX * config.bulk_fraction / names.size;
  for (const chest of chests) {
    if (!config.chest_keys.includes(chest.slot) || !Array.isArray(chest.items) || chest.never_opened) continue;
    const load = weighPack(chest.items);
    if (!load.exact) continue; // Unknown bulk cannot be treated as free capacity.
    let free = Math.max(0, CHEST_BULK_MAX - load.bulk);
    for (const [item, available] of spare) {
      const bulk = weighItem(item).bulk, target = Math.floor(perTypeBulk / bulk);
      const amount = Math.max(0, Math.min(available, target - coopCount(chest.items, item), Math.floor(free / bulk)));
      if (!amount) continue;
      plan.push({ slot: chest.slot, item, amount, target, reserved_bulk: perTypeBulk });
      spare.set(item, available - amount); free -= amount * bulk;
    }
  }
  return { plan, per_type_bulk: perTypeBulk, overflow: [...spare].filter(([, n]) => n > 0).map(([item, amount]) => ({ item, amount })) };
}

export function coopTithePlan({ bankable, stored, config, target = null, paid = 0 }) {
  const base = Math.max(0, Math.floor(bankable));
  const wanted = target ?? Math.ceil(base * config.shilling_tithe_pct / 100);
  return { target: wanted, amount: Math.max(0, Math.min(base, wanted - paid, config.shilling_cap - stored)) };
}

export function coopFundingAmount(plan, purse, config) {
  const cost = plan.lines.filter(l => config.reagents.includes(coopKey(l.item)))
    .reduce((sum, l) => sum + l.cost, 0);
  return Math.max(0, Math.floor(Math.min(cost, plan.required_purse - purse)));
}

export function coopRemainingPlan(plan, took = []) {
  const remaining = new Map();
  for (const item of took) remaining.set(coopKey(item.item), (remaining.get(coopKey(item.item)) ?? 0) + item.amount);
  const subtract = line => {
    const key = coopKey(line.item), used = Math.min(line.amount ?? 0, remaining.get(key) ?? 0);
    remaining.set(key, (remaining.get(key) ?? 0) - used);
    return { ...line, amount: line.amount - used };
  };
  const lines = plan.lines.map(subtract).filter(l => l.amount > 0).map(l => ({ ...l, cost: l.amount * l.unit_cost }));
  const unpriced = plan.unpriced.map(l => l.amount == null ? l : subtract(l)).filter(l => l.amount == null || l.amount > 0);
  const known_cost = lines.reduce((n, l) => n + l.cost, 0);
  return { ...plan, lines, unpriced, known_cost, expected_cost: unpriced.length ? null : known_cost,
    required_purse: known_cost + plan.reserve };
}
