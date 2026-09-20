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
    self_fund: { type: 'boolean', description: 'Opt in to the self-funding fallback: when the chest fails this character, buy the shortfall in town ONCE instead of waiting for the next retry. Off by default. Two triggers, recorded separately — chest_unreachable (three consecutive failed visits) and chest_empty (the chest was read and did not hold what was wanted).' },
  },
};

export function coopConfig(raw) {
  if (raw == null || raw.enabled === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.enabled !== true) throw new Error('reagent_coop needs enabled:true or null');
  for (const key of Object.keys(raw)) if (!(key in REAGENT_COOP_SCHEMA.properties)) throw new Error(`unknown reagent_coop option: ${key}`);
  const c = { enabled: true, bulk_fraction: 0.9, reagents: [...COOP_REAGENTS], shilling_tithe_pct: 20,
    shilling_cap: 75000, hall_room: BOOKMAKERS_HALL_ROOM, chest_keys: [...BOOKMAKERS_CHEST_SQUARES], retry_ms: 300000,
    self_fund: false, ...raw };
  // OFF BY DEFAULT AND STRICTLY BOOLEAN. A truthy string here would enable a fallback that
  // SPENDS MONEY, so `"false"` must not read as yes — the coercion `!!raw.self_fund` would.
  if (typeof c.self_fund !== 'boolean') throw new Error('invalid reagent_coop.self_fund');
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

// ------------------------------------------------- the self-funding fallback, and its ledger
//
// THE ERRAND IT EXISTS FOR. A character stationed at the hall to draw reagents has exactly one
// supply line, and when it fails it fails SILENTLY — `took: []` with a reason nobody reads, and
// the drill it was feeding simply stops. The fallback is: buy the shortfall in town once, on
// this character's own money, rather than wait out `retry_ms` forever.
//
// TWO TRIGGERS, DELIBERATELY COUNTED APART, AND THAT SEPARATION IS THE WHOLE POINT.
//
//   chest_unreachable   three consecutive visits that could not USE the chest — a door that
//                       would not cross, a hall not reached, a transfer that threw. This is
//                       the one a code fix makes go away.
//   chest_empty         the chest was read successfully and did not hold what was wanted.
//                       No code fix touches this; it means the fleet has not stocked it.
//
// Measured 2026-09-20: Camilla's two supply visits returned `guild door 59 could not be crossed`
// and `guild door 55 trigger not reached` with 543 elderberry sitting in the chest. Both were
// `chest_unreachable`. If those two classes were summed into one "supply failed" number, the
// ledger could never show whether the door fix worked — the count would keep moving for the
// other reason. Rolled together, this instrument would be unable to answer the only question
// it was built to answer.
//
// ONE-OFF MEANS ONE TRIP PER EPISODE, NOT ONE TRIP EVER, AND THE DIFFERENCE IS STARVATION.
//
// A fallback that re-fires every visit is a character that walks to town for ever, spending
// money each lap and reporting success each lap — the shape CLAUDE.md already names ("a trip
// that cannot fix the thing that opened it will run for ever"). But suppressing it until the
// next SUCCESSFUL draw is the opposite failure and it is worse: while the chest stays broken
// there is never another success, so the character funds itself once and then starves with the
// instrument reading normal.
//
// So the run resets at the later of the last success and the last fallback. After a fallback
// fires it takes a FRESH episode — another `chest_empty`, or another three unreachable visits —
// to fire again. At the default `retry_ms` of five minutes that bounds the unreachable trigger
// to about one trip per quarter hour, which is a supply line rather than a treadmill.
//
// THE COUNT LIVES IN THE NDJSON, NOT ON THE KEEPER. Keepers restart about once a minute, so an
// in-memory counter would never reach three — it would read 0 or 1 for ever and the
// unreachable trigger could not fire at all. The coop already appends receipts to
// `<fleet>.coop.ndjson`; these rows go beside them, which also means the evidence survives the
// restart that would have destroyed the counter.
export const COOP_FALLBACK_ATTEMPTS = 3;

/** Classify ONE supply visit. Pure: takes what the visit returned, returns what it means. */
export function coopSupplyOutcome({ reason = null, took = [], plan = null, reagents = [],
                                    room_for = null } = {}) {
  const names = new Set((reagents.length ? reagents : COOP_REAGENTS).map(coopKey));
  const lines = [...(plan?.lines ?? []), ...(plan?.unpriced ?? [])]
    .filter(l => names.has(coopKey(l.item)) && Number(l.amount) > 0);
  const short = lines.reduce((n, l) => n + Number(l.amount), 0);
  const gained = took.reduce((n, t) => n + Math.max(0, Number(t.amount) || 0), 0);
  // A REASON IS THE VISIT'S OWN VERDICT AND OUTRANKS THE ARITHMETIC. When the hall was never
  // reached there is nothing to say about what the chest held — reading `took: []` as "the
  // chest was empty" would blame the stock for a door.
  if (reason) return { outcome: 'chest_unreachable', why: String(reason), short, took_units: gained };
  if (short > 0) {
    // A FULL PACK IS NOT AN EMPTY CHEST, AND THE FALLBACK MUST NEVER FIRE ON IT.
    //
    // Found live 2026-09-20, the first draw after the door fix landed. Camilla took 307
    // elderberry and 58 herb out of a chest still holding ~236 more, and stopped because her
    // pack was at 1810 of 2000 bulk. The plan still wanted 569, so this classified as
    // `chest_empty` — a SUCCESSFUL draw filed as a stock failure, which with `self_fund` on
    // would have sent her to buy 569 elderberry for 15,932 shillings she does not have.
    //
    // And buying could not have helped even if she could pay: the constraint is what she can
    // CARRY. A trip whose whole purpose is to acquire something there is no room for is the
    // shape CLAUDE.md already names — "a trip that cannot fix the thing that opened it will
    // run for ever, and every lap reports success". So this is not merely mislabelled, it is
    // the one outcome that must never reach the fallback.
    const fits = lines.some(l => {
      const unit = weighItem(coopKey(l.item));
      if (!unit || !room_for) return true;           // unknown capacity is not a refusal
      return (room_for.weight ?? Infinity) >= unit.weight && (room_for.bulk ?? Infinity) >= unit.bulk;
    });
    if (!fits) return { outcome: 'pack_full', short, took_units: gained,
      why: `carried ${gained} away and is ${short} short, but has no room for another unit` };
    return { outcome: 'chest_empty', why: gained
      ? `the chest held ${gained} but is ${short} short of what was wanted`
      : 'the chest held none of what was wanted', short, took_units: gained };
  }
  return { outcome: 'ok', why: null, short: 0, took_units: gained };
}

/**
 * Should this character fund itself now? Reads the coop ledger rows for ONE agent, oldest
 * first, and answers from the run since its last successful draw.
 */
export function coopFallbackDecision({ rows = [], agent = null, attempts = COOP_FALLBACK_ATTEMPTS } = {}) {
  const mine = rows.filter(r => r && (agent == null || r.agent === agent) &&
                           ['coop_supply_outcome', 'coop_self_funding'].includes(r.kind));
  // THE EPISODE IS WHAT COUNTS, and it begins at the later of the last success and the last
  // fallback. Everything before that has been answered — either the chest worked, or a trip was
  // already made for it — so carrying those rows forward would fire on history.
  // `pack_full` closes an episode exactly as a success does. The chest WAS usable and it did
  // hand over everything the character could carry — the limit was the pack, and no trip fixes
  // that. Letting it sit in the run instead would leave a stale failure that fires later.
  let start = 0;
  mine.forEach((r, i) => {
    if (r.kind === 'coop_self_funding' || r.outcome === 'ok' || r.outcome === 'pack_full') start = i + 1;
  });
  const run = mine.slice(start).filter(r => r.kind === 'coop_supply_outcome');
  const empty = run.find(r => r.outcome === 'chest_empty');
  const unreachable = run.filter(r => r.outcome === 'chest_unreachable').length;
  if (!run.length)
    return { fund: false, trigger: null, consecutive: 0, why: 'nothing has failed since the last draw or trip' };
  // EMPTY OUTRANKS UNREACHABLE AND DOES NOT WAIT. Retrying a chest that was read and did not
  // hold the item cannot produce a different answer; retrying a door can.
  if (empty)
    return { fund: true, trigger: 'chest_empty', consecutive: run.length, short: empty.short ?? null,
             why: 'the chest was readable and did not hold it, so retrying changes nothing' };
  if (unreachable >= attempts)
    return { fund: true, trigger: 'chest_unreachable', consecutive: unreachable,
             short: run[run.length - 1]?.short ?? null,
             why: `${unreachable} consecutive visits could not use the chest` };
  return { fund: false, trigger: null, consecutive: unreachable,
           why: `${unreachable} of ${attempts} consecutive failures` };
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
