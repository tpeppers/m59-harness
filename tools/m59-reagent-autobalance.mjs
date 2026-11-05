// THE REAGENT AUTOBALANCER -- HOW MANY CASTING REAGENTS A CHARACTER CARRIES OUT OF TOWN, LAP BY LAP.
//
// Operator, 2026-11-04: a "reagent autobalancer" that rides on top of farming -- the keeper's own town trips and any
// fleetscript farm loop -- and decides how many spellcasting reagents a character takes out from town or the guild chest,
// for one of two purposes:
//
//   practice     as many casts as the lap allows, limited by the mana it regenerates (casting for skill gain);
//   maintenance  the FEWEST casts that keep a required list of buffs live for the whole lap, re-cast as each wears off.
//
// And the scope extension the same evening: "THE OBJECTIVE IS A ZERO-DISCREPANCY LAP. The perfect amount is: the
// autobalanced reagents reach 0 exactly as the character kills the last monster that fills its pack to the town-trip
// trigger." So every lap is measured as a SIGNED discrepancy -- ran out N minutes before the pack filled (negative), or the
// pack filled with M casts' worth left over above the PvP floor (positive) -- and the learner drives it toward zero.
//
// ---------------------------------------------------------------------------------------------- the estimate
//
// LAP LENGTH. A lap is the time until the pack is full enough to trip the keeper's own trigger: the fuller of weight and
// bulk against `1700 + might*20` (player.kod:10456, :10461; skills.carryCapacity) reaching `sellAtLoad` (SELL_AT_LOAD 0.9,
// m59-autopilot.mjs; checkIfShouldSell in tools/autopilot/market.mjs). Loot per kill is the room's drop tables
// (substrate/m59-spawns.json, cited per row to kod/object/passive/trestype/*.kod) restricted to what the character
// actually picks up, weighed by substrate/m59-items.json, at `kills_per_minute` (operator: "30 kills per 30 minutes",
// default 1). ONE TREASURE ROLL PER KILL IS ASSUMED -- the kod rolls a count that varies with level and difficulty, and the
// spawn index does not carry it -- so the estimate is a starting point and the learner replaces it with what laps measure.
//
// THE REAGENTS RIDE IN THE SAME PACK. A carried reagent occupies room that loot would otherwise fill, and frees it as it is
// spent. If the lap's reagents equal the lap's use, they cancel exactly: load(T) = L0 + R0 - r*T + loot*T, and R0 = r*T,
// so the lap length is (F - L0)/loot whatever is carried. What they DO constrain is the departure: L0 + R0 must fit under
// the trigger, or the character leaves town already full. A plan that does not fit is cut down to fit and says so.
//
// MANA. Practice is limited by mana regenerated over the lap at `vigor` (operator: 100) plus the starting pool. The kod
// (player.kod CalculateManaTime, :5645-5662; BASE_REGEN_TIME 150000 at :48) gives milliseconds per mana point:
//     t = (150000 + (25 - mysticism) * 1000) * 200 / vigor / max_mana,  bounded 1000..60000
// so at 29 max mana, mysticism 23 and 100 vigor a point comes every 10.48 s -- 5.72 mana a minute. Faction regen bonus,
// Rejuvenate and Mana Focus are not modelled (they only shorten t, so the estimate errs low on mana and the learner raises).
//
// DURATION. Maintenance casts are 1 + ceil(lap / duration) per buff. Durations come from the kod via m59-buffs.mjs
// (persench/*.kod GetDuration). Every personal enchantment returns random(D/2, D) (haste.kod:86, strength.kod:83,
// respois.kod:84, bless.kod:93), and spell power is not readable over the wire, so the planning duration is the MEAN roll
// at the LOWEST power, 0.75 * D(0): haste 3.75 min, super strength 3.75, resist poison 11.25. A loop may name its own.
//
// COSTS are the kod's: m59-deskpractice.mjs spellCost (mana and reagents from substrate/m59-spells.json).
//
// ---------------------------------------------------------------------------------------------- the PvP floor
//
// Operator, 2026-11-04: a planned amount is N USABLE. The PvP reagent reserve (m59-reagent-reserve.mjs) is a separate
// locked box ADDED ON TOP, never counted as usable, and ALWAYS NAMED -- `mushroom: 14 planned + 10 PvP reserve = 24` -- so
// nobody forgets it. "Leftover" means leftover ABOVE that floor. A reagent the reserve holds in bulk (sapphires on prod,
// floor 100000: PvP and Discordance only) makes its spell UN-PLANNABLE: the cast veto would refuse every non-PvP cast, so
// planning reagents for it is planning to carry stock that can never be spent. Such a spell is refused with the reason.
//
// ---------------------------------------------------------------------------------------------- the learner
//
// Per character, per loop, the learner keeps two numbers the estimate guessed: how long the PACK takes to fill
// (`pack_minutes`) and how fast each reagent is SPENT (`use_per_minute`). Both are exponentially smoothed (alpha 0.5)
// toward what each lap measured, and each lap may move a rate by at most x2 / x0.5, so one strange lap cannot blow it up
// and the plan converges rather than oscillating. The next lap carries use_per_minute * pack_minutes -- reagent amount and
// lap length move together, which is the point: under trigger `first` or `reagents` the reagents END the lap, so a lap that
// ran out early is a SHORT lap, and its pack reading is extrapolated to full rather than believed.
//
// HAND EDITS WIN. Every knob of a loop can be set by a person (`m59-autobalance.mjs set`), each edit is recorded with who,
// when and why, and a pinned amount or a hand multiplier is honoured over the learner until it is cleared.
//
// ---------------------------------------------------------------------------------------------- couriers
//
// The same file balances a courier's recurring buy list. For each (courier, recipient, item) it counts deliveries that
// could not land -- receiver_full, refused, no counter -- and after `pause_after` in a row STOPS buying that item for that
// recipient until there is evidence they need it AND have room: their board says they are short (count below want) and
// their declared pack is under `room_below`. A delivery that lands clears the count.
//
// ---------------------------------------------------------------------------------------------- the files
//
// ORDERS (a person's, gitignored): substrate/reagent-autobalance-<fleet>.json, or M59_REAGENT_AUTOBALANCE_FILE. Shape in
// substrate/reagent-autobalance.example.json. Re-read when its mtime moves, at most every 2 s. A file that will not parse
// is NOT an empty file: the last good orders stand and the error is reported.
// LEARNED (this machine's bets, gitignored): substrate/reagent-autobalance/<fleet>/<character>.json, one file per character
// so keeper processes never write over each other; courier state in courier-<character>.json beside them.
//
// SILENCE MEANS THE BEHAVIOUR THAT WAS ALREADY THERE. No orders file, or no loop for this character: nothing plans, the
// keeper buys and sells exactly as before. `m59-reagent-autobalance-test.mjs` pins that, and everything above.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spellCost, loadCatalogue } from './m59-deskpractice.mjs';
import { floorsFor, reagentKey } from './m59-reagent-reserve.mjs';
import { loadItems, weighItem } from './m59-items.mjs';
import { buffCatalogue } from './m59-buffs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, '..', 'substrate');
const lc = s => String(s ?? '').trim().toLowerCase();

// ============================================================================================ constants
export const BASE_REGEN_TIME_MS = 150_000;          // player.kod:48
export const TRIGGERS = Object.freeze(['pack', 'first', 'reagents']);
export const MODES = Object.freeze(['practice', 'maintenance']);
// A reserve floor at least this large is "every unit": nothing above it is ever usable outside PvP.
export const UNPLANNABLE_FLOOR = 1000;
export const LEARN_ALPHA = 0.5;
export const LEARN_STEP_MAX = 2;                     // a lap moves a rate by at most x2 or x0.5
export const RECHECK_MS = 2000;
export const LAPS_KEPT = 20;

export const LOOP_DEFAULTS = Object.freeze({
  enabled: true,
  // 'keeper': the keeper's own town trips use this loop. 'script': only a fleetscript / supervisor calls planLap.
  driver: 'script',
  mode: 'practice',
  practice: Object.freeze([]),         // spell names, practised round-robin
  maintain: Object.freeze([]),         // buff names kept live
  // THE TOWN LAP (operator 2026-11-05: "do a full town lap at Barloque ... buy mushrooms at Joguer's herb shop"): what the
  // chest could not supply is BOUGHT, per item: { mushroom: { seller: 'Joguer' } }. Supervisor bank trips only.
  shops: Object.freeze({}),
  // WHEN THE HALL CHESTS HAVE TOO FEW SHILLINGS (operator 2026-11-05: "take out 25 rubies (sells for ~4K to Herbutte), which
  // doesn't require leaving Barloque"): { item: 'ruby', amount: 25, seller: 'Herbutte', room: 109 }. Herbutte refuses a stack
  // of more than 25 (bqmerch.kod ObjectDesired), so amount is capped there. null: no gem sale.
  fund_gem: null,
  // A CHARACTER CACHE BEFORE THE HALL (operator 2026-11-05: "Scooter returns to cave farming after dropping off, and continues
  // to only drop off locally at Raphael until Raphael's carry capacity is full, then Scooter goes back to resupplying the
  // Second Swines Bookmaker's guild hall"): { agent: 'hk3', room: 53, full_percent: 95, min_purse: 2000, shops: { item: seller } }.
  // A bank trip hands its deposit to `agent` standing in `room` instead of the hall while cacheVerdict says so; restocking
  // on such a trip buys at `shops` in that room with the purse it carries (no hall chests there). null: the hall, always.
  cache: null,
  kills_per_minute: 1,
  vigor: 100,
  sell_at_load: null,                  // null: the keeper's policy.sellAtLoad, else SELL_AT_LOAD 0.9
  trigger: 'pack',
  drop_priority: Object.freeze([]),    // under trigger 'reagents': overfarm's `avoid` list, dropped first
  cancel_on_empty: false,              // fleetscript loops: stop the loop when the autobalanced reagents run out
  room: null,                          // the farm room, for the drop-table estimate
  hunt: Object.freeze([]),             // creature names; empty = every creature the room generates
  loot_only: Object.freeze([]),        // item names it picks up; empty = everything the tables drop
  loot_per_kill: null,                 // { weight, bulk } -- overrides the drop-table estimate
  durations: Object.freeze({}),        // { spell: minutes } -- overrides the kod's planning duration
  gap_ms: 20_000,                      // practice: one cast per this long at most (PRACTICE_DEFAULTS.gap_ms)
  max_lap_minutes: 600,                // a lap estimate is never planned past this
  margin: 0,                           // extra fraction carried on top of the plan (0 = aim at zero discrepancy)
  pinned: Object.freeze({}),           // { item: usable amount } -- a person's number, over the learner
  multipliers: Object.freeze({}),      // { item: factor } -- a person's factor, replaces the learned one
  hall: null,                          // supervisor: the guild hall room it banks in
  deposit: Object.freeze([]),          // supervisor: items deposited whole at the hall (loot it keeps for the guild)
  farm: null,                          // supervisor: autopilot args it restores after each bank trip
  full_percent: 90,                    // supervisor: pack percent that ends the lap under 'pack' / 'first'
  edits: Object.freeze([]),            // the hand-edit log: [{ at, by, why, key, value }]
});

export const COURIER_DEFAULTS = Object.freeze({ enabled: true, pause_after: 2, room_below: 0.85, edits: Object.freeze([]) });

// ============================================================================================ files
export const ordersFile = (fleet, env = process.env) => env.M59_REAGENT_AUTOBALANCE_FILE
  || join(SUBSTRATE, fleet && fleet !== 'default' ? `reagent-autobalance-${fleet}.json` : 'reagent-autobalance.json');
export const learnedDir = (fleet, env = process.env) => env.M59_REAGENT_AUTOBALANCE_DIR
  || join(SUBSTRATE, 'reagent-autobalance', fleet || 'default');
const slug = s => String(s ?? '').replace(/[^A-Za-z0-9_'-]/g, '_');
export const learnedFile = (fleet, character, env = process.env) => join(learnedDir(fleet, env), `${slug(character)}.json`);
export const courierFile = (fleet, courier, env = process.env) => join(learnedDir(fleet, env), `courier-${slug(courier)}.json`);

const caches = new Map();
/** The orders book, or null. Never throws: a file that will not parse keeps the last good book and reports why. */
export function readOrders(file, now = Date.now()) {
  const c = caches.get(file);
  if (c && now - c.checked < RECHECK_MS) return c.book;
  let mtime = null;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : null; } catch { mtime = null; }
  if (c && c.mtime === mtime) { c.checked = now; return c.book; }
  let book = null, error = null;
  if (mtime != null) {
    try { book = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { error = `${file}: ${e.message} -- the last good orders stand`; book = c?.book ?? null; }
  }
  caches.set(file, { checked: now, mtime, book, error });
  return book;
}
export const ordersError = file => caches.get(file)?.error ?? null;
export const forgetOrders = () => caches.clear();

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
/** Learned state for one character: { loops: { <mode>: learned } }. A broken file reads as empty AND says so. */
export function readLearned(file) {
  if (!existsSync(file)) return { state: { format: 'm59-autobalance-learned/1', loops: {} }, error: null };
  try { return { state: JSON.parse(readFileSync(file, 'utf8')), error: null }; }
  catch (e) { return { state: { format: 'm59-autobalance-learned/1', loops: {} }, error: `${file}: ${e.message}` }; }
}
export const writeLearned = (file, state) => writeJsonAtomic(file, state);
export const writeOrders = (file, book) => { writeJsonAtomic(file, book); caches.delete(file); };

// ============================================================================================ normalising a loop
const NUMBERS = { kills_per_minute: [0.01, 60], vigor: [1, 200], sell_at_load: [0.05, 1], gap_ms: [0, 3_600_000],
                  max_lap_minutes: [1, 10_000], margin: [0, 2], room: [1, 100_000], full_percent: [1, 100], hall: [1, 100_000] };
const names = v => [...new Set([].concat(v ?? []).map(lc).filter(Boolean))];

/**
 * One loop's orders, normalised. Unknown keys are REPORTED and not applied; an unusable value keeps the default and is
 * reported (docs/m59-policy.md). Returns null for null / enabled:false -- the same answer: no loop.
 */
export function normalizeLoop(raw, problems = []) {
  if (raw == null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) { problems.push('a loop must be an object'); return null; }
  if (raw.enabled === false) return null;
  const out = { ...LOOP_DEFAULTS, practice: [], maintain: [], hunt: [], loot_only: [], drop_priority: [], deposit: [],
                durations: {}, pinned: {}, multipliers: {}, edits: [], shops: {} };
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'enabled' || k.startsWith('_') || k === 'why') continue;
    if (!Object.hasOwn(LOOP_DEFAULTS, k)) { problems.push(`unrecognised key ${k}, not applied`); continue; }
    if (['practice', 'maintain', 'hunt', 'loot_only', 'drop_priority', 'deposit'].includes(k)) { out[k] = names(v); continue; }
    if (k === 'driver') { if (['keeper', 'script'].includes(v)) out.driver = v; else problems.push('driver must be "keeper" or "script"'); continue; }
    if (k === 'mode') { if (MODES.includes(v)) out.mode = v; else problems.push(`mode must be ${MODES.join(' or ')}`); continue; }
    if (k === 'trigger') { if (TRIGGERS.includes(v)) out.trigger = v; else problems.push(`trigger must be ${TRIGGERS.join(', ')}; kept pack`); continue; }
    if (k === 'cancel_on_empty') { if (typeof v === 'boolean') out.cancel_on_empty = v; else problems.push('cancel_on_empty must be true or false'); continue; }
    if (k === 'farm') { out.farm = v && typeof v === 'object' && !Array.isArray(v) ? v : null; if (v != null && !out.farm) problems.push('farm must be an object of autopilot args'); continue; }
    if (k === 'edits') { out.edits = Array.isArray(v) ? v.slice(-200) : []; continue; }
    if (k === 'fund_gem') {
      if (v == null) { out.fund_gem = null; continue; }
      const item = typeof v?.item === 'string' ? v.item.trim() : '', seller = typeof v?.seller === 'string' ? v.seller.trim() : '';
      const amount = Math.min(25, Math.trunc(Number(v?.amount ?? 25))), room = Number(v?.room);
      if (!item || !seller || !(amount > 0) || !(room > 0)) { problems.push('fund_gem needs { item, amount (1..25), seller, room }, not applied'); continue; }
      out.fund_gem = { item, amount, seller, room };
      if (Number(v?.amount) > 25) problems.push('fund_gem.amount capped at 25: Herbutte refuses a larger stack');
      continue;
    }
    if (k === 'cache') {
      if (v == null) { out.cache = null; continue; }
      const agent = typeof v?.agent === 'string' ? v.agent.trim() : '', room = Number(v?.room);
      if (!agent || !(room > 0)) { problems.push('cache needs { agent, room }, not applied'); continue; }
      const full = Number(v?.full_percent ?? 95), minPurse = Number(v?.min_purse ?? 2000);
      const shops = {};
      for (const [item, spec] of Object.entries(v?.shops ?? {})) {
        const seller = typeof spec === 'string' ? spec : spec?.seller;
        // A shop may stand in another room than the cache (operator 2026-11-05: Raphael caches in the Icky Cave, 27; the farmers
        // restock at Frisconar's in Tos, 53): { seller, room }. No room: the cache room, as before.
        if (seller && typeof seller === 'string') shops[reagentKey(item)] = { seller: seller.trim(), ...(Number(spec?.room) > 0 ? { room: Number(spec.room) } : {}) };
        else problems.push(`cache.shops.${item}: needs a seller, not applied`);
      }
      out.cache = { agent, room, full_percent: full > 0 && full <= 100 ? full : 95, min_purse: minPurse >= 0 ? minPurse : 2000, shops };
      continue;
    }
    if (k === 'shops') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push('shops must be an object: { item: { seller } }'); continue; }
      for (const [item, spec] of Object.entries(v)) {
        const seller = typeof spec === 'string' ? spec : spec?.seller;
        if (!seller || typeof seller !== 'string') { problems.push(`shops.${item}: needs a seller, not applied`); continue; }
        // FUNDS FROM THE HALL (operator 2026-11-05: "it should withdraw the shillings from one of the guild hall chests to make
        // up the difference"): a purse under `withdraw` is topped up to it from the guild hall chests, in the hall, before
        // the walk to the shop. Scooter went out with 604 shillings.
        const fund = Number(spec?.withdraw) > 0 ? { withdraw: Number(spec.withdraw) } : {};
        if (spec?.withdraw != null && !fund.withdraw) problems.push(`shops.${item}: withdraw must be a positive number of shillings, not applied`);
        if (spec?.bank != null) problems.push(`shops.${item}: bank is not used -- shillings come from the guild hall chests`);
        out.shops[reagentKey(item)] = { seller: seller.trim(), ...(Number(spec?.room) > 0 ? { room: Number(spec.room) } : {}), ...fund };
      }
      continue;
    }
    if (k === 'loot_per_kill') {
      if (v == null) { out.loot_per_kill = null; continue; }
      const w = Number(v?.weight), b = Number(v?.bulk ?? v?.weight);
      if (w >= 0 && b >= 0 && Number.isFinite(w + b)) out.loot_per_kill = { weight: w, bulk: b };
      else problems.push('loot_per_kill must be { weight, bulk }');
      continue;
    }
    if (['durations', 'pinned', 'multipliers'].includes(k)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(`${k} must be an object`); continue; }
      for (const [item, n] of Object.entries(v)) {
        const x = Number(n);
        const ok = k === 'pinned' ? Number.isInteger(x) && x >= 0 && x <= 100_000 : x > 0 && x <= (k === 'durations' ? 1440 : 20);
        if (!ok) { problems.push(`${k}.${item}: ${JSON.stringify(n)} is not usable, not applied`); continue; }
        out[k][k === 'durations' ? lc(item) : reagentKey(item)] = x;
      }
      continue;
    }
    const [lo, hi] = NUMBERS[k];
    const n = Number(v);
    if (v === null && (k === 'sell_at_load' || k === 'room' || k === 'hall')) { out[k] = null; continue; }
    if (Number.isFinite(n) && n >= lo && n <= hi) out[k] = n;
    else problems.push(`${k} must be a number in [${lo}, ${hi}]; kept ${LOOP_DEFAULTS[k]}`);
  }
  if (out.mode === 'practice' && !out.practice.length) problems.push('practice mode with no practice spells');
  if (out.mode === 'maintenance' && !out.maintain.length) problems.push('maintenance mode with no buffs to maintain');
  return out;
}

const pick = (table, key) => {
  if (!table || typeof table !== 'object' || key == null) return undefined;
  const hit = Object.keys(table).find(k => lc(k) === lc(key));
  return hit === undefined ? undefined : table[hit];
};
/** This character's loop from the orders book: { loop, problems } (loop null when none). By character, then agent. */
export function loopFor(book, { character = null, agent = null } = {}) {
  const problems = [];
  const raw = pick(book?.loops, character) ?? pick(book?.loops, agent);
  return { loop: normalizeLoop(raw ?? null, problems), problems };
}
export function courierFor(book, courier) {
  const raw = pick(book?.couriers, courier);
  if (raw == null || raw === false || raw?.enabled === false) return null;
  const out = { ...COURIER_DEFAULTS };
  for (const k of ['pause_after', 'room_below']) if (Number.isFinite(Number(raw?.[k]))) out[k] = Number(raw[k]);
  return out;
}

// ============================================================================================ the game's numbers
/** Mana per minute (player.kod CalculateManaTime :5645-5662), with the kod's integer arithmetic and bounds. */
export function manaRegenPerMinute({ mysticism = 25, maxMana, vigor = 100 } = {}) {
  if (!(maxMana > 0)) return 0;
  let t = BASE_REGEN_TIME_MS + (25 - Math.max(1, Number(mysticism) || 1)) * 1000;
  t = Math.trunc(t * 200 / Math.max(1, Number(vigor) || 1));
  t = Math.trunc(t / Math.max(1, maxMana));
  t = Math.max(1000, Math.min(60000, t));
  return 60000 / t;
}

let buffRows = null;
/** The kod's buff table (m59-buffs.mjs), or [] when the kod tree is not here (M59_ROOT). Cached. */
export function buffTable() {
  if (buffRows) return buffRows;
  try { buffRows = buffCatalogue(); } catch { buffRows = []; }
  return buffRows;
}
/** Planning duration in minutes: the mean roll at the lowest power, 0.75 * D(0), or the loop's own. Null when unknown. */
export function planningDuration(spell, { durations = {}, buffs = buffTable() } = {}) {
  const own = durations[lc(spell)];
  if (own > 0) return { minutes: own, from: 'the loop' };
  const row = buffs.find(b => lc(b.name) === lc(spell));
  const d0 = Number(row?.duration_ms?.min);
  if (!(d0 > 0)) return null;
  return { minutes: (0.75 * d0) / 60000, from: `${row.file}: mean of random(D/2, D) at spell power 0, D = ${d0 / 60000} min` };
}

let classNames = null;
function nameOfClass(cls) {
  if (!classNames) {
    classNames = new Map();
    for (const [name, row] of Object.entries(loadItems()?.items ?? {})) if (row?.cls && !classNames.has(row.cls)) classNames.set(row.cls, name);
  }
  return classNames.get(cls) ?? String(cls).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * EXPECTED LOOT PER KILL in the room, from the drop tables, for what the character picks up. One roll per kill (see the
 * header). Creatures are weighted equally: the kill mix is not in the index. -> { weight, bulk, creatures, unweighed }
 */
export function lootPerKill({ spawns, room, hunt = [], lootOnly = [] } = {}) {
  const gen = spawns?.rooms?.[room] ?? [];
  const want = names(hunt);
  const take = new Set(names(lootOnly).map(reagentKey));
  const list = gen.filter(g => !want.length || want.some(w => lc(g.creature).includes(w)));
  const rows = [], unweighed = new Set();
  let weight = 0, bulk = 0;
  for (const g of list) {
    const c = Object.values(spawns.creatures ?? {}).find(x => x.name === g.creature) ?? null;
    let w = 0, b = 0;
    for (const it of c?.loot?.items ?? []) {
      if (it.item === 'Money') continue;
      const name = nameOfClass(it.item);
      if (take.size && !take.has(reagentKey(name))) continue;
      const kg = weighItem(name);
      if (!kg) { unweighed.add(name); continue; }
      const p = (Number(it.per_roll_percent) || 0) / 100 * (Number(it.count) || 1);
      w += p * kg.weight; b += p * kg.bulk;
    }
    rows.push({ creature: g.creature, weight: +w.toFixed(3), bulk: +b.toFixed(3) });
    weight += w; bulk += b;
  }
  const n = rows.length || 1;
  return { weight: weight / n, bulk: bulk / n, creatures: rows, unweighed: [...unweighed],
           assumption: 'one treasure roll per kill, creatures weighted equally' };
}

/** Minutes until the pack reaches the trigger, and which ceiling binds. */
export function lapMinutes({ capacity, load, sellAtLoad = 0.9, perKill, killsPerMinute = 1, maxMinutes = Infinity }) {
  const max = { weight: capacity?.weight_max, bulk: capacity?.bulk_max ?? capacity?.weight_max };
  const out = {};
  for (const d of ['weight', 'bulk']) {
    const room = sellAtLoad * max[d] - (Number(load?.[d]) || 0);
    const rate = (Number(perKill?.[d]) || 0) * killsPerMinute;
    out[d] = room <= 0 ? 0 : rate > 0 ? room / rate : Infinity;
  }
  const binding = out.weight <= out.bulk ? 'weight' : 'bulk';
  const minutes = Math.min(out[binding], maxMinutes);
  return { minutes, binding, capped: out[binding] > maxMinutes, by: out };
}

// ============================================================================================ planning
const usableOf = (have, floor) => Math.max(0, (Number(have) || 0) - (Number(floor) || 0));

/**
 * WHAT THIS LAP SHOULD CARRY. Pure: every input passed in.
 *
 * @param loop      normalizeLoop(...)
 * @param known     spell names the character can cast, lower-case or not; `abilities` { spell: 0..99 } optional
 * @param mana      { max } ; mysticism
 * @param reserve   resolveReserve(...) for this character (or null)
 * @param capacity  { weight_max, bulk_max }; startLoad { weight, bulk } -- the pack AT DEPARTURE, before the reagents
 * @param held      { item: count } now (to compute take / surplus); optional
 * @param learned   the learned state for this loop (or null)
 * @returns { ok, mode, trigger, lapMinutes, lap_source, casts, wants, pvp, totals, take, surplus, lines, unplannable, why }
 */
/**
 * DROP OFF WITH THE CACHE CHARACTER, OR BANK IN THE HALL? Pure: every input passed in.
 * @param cache   the loop's normalized cache ({ agent, room, full_percent, min_purse }) or null
 * @param row     the cache character's fleet row (room_num, piloted, human_held, activity, pack.percent), or null
 * @param purse   the depositor's purse now (restocking on a cache trip is paid from it)
 * @returns { use, why }
 */
export function cacheVerdict({ cache, row, purse = null }) {
  if (!cache) return { use: false, why: 'no cache: the hall' };
  if (!row) return { use: false, why: `${cache.agent} has no fleet row: the hall` };
  if (row.piloted || row.human_held) return { use: false, why: `${cache.agent} is piloted: the hall` };
  if (row.activity === 'NOT IN GAME') return { use: false, why: `${cache.agent} is not in the game: the hall` };
  if (Number(row.room_num) !== Number(cache.room)) return { use: false, why: `${cache.agent} is in ${row.room_num}, not ${cache.room}: the hall` };
  const pct = Number(row.pack?.percent);
  if (!Number.isFinite(pct)) return { use: false, why: `${cache.agent}'s pack is unread: the hall` };
  if (pct >= cache.full_percent) return { use: false, why: `${cache.agent} is full (${pct}% >= ${cache.full_percent}%): the hall` };
  if (purse != null && Number(purse) < cache.min_purse) return { use: false, why: `purse ${purse} under ${cache.min_purse}: the hall, to top it up` };
  return { use: true, why: `${cache.agent} in ${cache.room} at ${pct}% (< ${cache.full_percent}%)` };
}

/**
 * WHAT A CACHE DROP-OFF HANDS OVER (operator 2026-11-05: the cave farmers' edible mushrooms go to Raphael "so Waldorf can import
 * it", but a farmer practising haste needs its own snacks, and nobody in Tos sells them). Every deposit-list item, LESS what the
 * plan says this farmer carries out for the next lap. Pure.
 * @param inv     [{ name, amount }] the depositor's pack
 * @param keys    Set of reagent keys to hand over (plan wants + deposit list)
 * @param totals  plan.totals { key: amount } (what the next lap carries) or null
 * @returns { [name]: amount } -- only positive amounts
 */
export function cacheHandover(inv = [], keys = new Set(), totals = null) {
  const held = {}, nameOf = {};
  for (const i of inv) { const k = reagentKey(i.name); if (!keys.has(k)) continue; held[k] = (held[k] ?? 0) + (Number(i.amount) > 0 ? Number(i.amount) : 1); nameOf[k] ??= i.name; }
  const out = {};
  for (const [k, n] of Object.entries(held)) { const give = n - Math.max(0, Number(totals?.[k]) || 0); if (give > 0) out[nameOf[k]] = give; }
  return out;
}

export function planLap({ loop, known = [], abilities = {}, mana = {}, mysticism = 25, reserve = null, capacity = null,
                          startLoad = { weight: 0, bulk: 0 }, held = {}, learned = null, sellAtLoad = null,
                          spawns = null, buffs = null, catalogue = loadCatalogue() } = {}) {
  if (!loop) return { ok: false, why: 'no autobalance loop for this character: nothing planned, existing behaviour stands' };
  const knows = new Set(known.map(lc));
  const floors = floorsFor(reserve, [...knows]);
  const exempt = new Set((reserve?.exempt ?? []).map(lc));
  const at = Number(sellAtLoad ?? loop.sell_at_load) || 0.9;

  // ---- the lap
  const perKill = loop.loot_per_kill ?? (spawns && loop.room != null
    ? lootPerKill({ spawns, room: loop.room, hunt: loop.hunt, lootOnly: loop.loot_only }) : null);
  let lap = capacity && perKill
    ? lapMinutes({ capacity, load: startLoad, sellAtLoad: at, perKill, killsPerMinute: loop.kills_per_minute,
                   maxMinutes: loop.max_lap_minutes }) : null;
  let lapMin = lap?.minutes ?? null, lapSource = 'estimate';
  const lp = learned?.pack_minutes;
  if (Number.isFinite(lp) && lp > 0 && (learned?.laps_seen ?? 0) >= 1) { lapMin = lp; lapSource = 'learned'; }   // measured: max_lap_minutes caps only an estimate
  if (!(lapMin > 0)) return { ok: false, why: capacity ? 'the pack is already at the trigger, or nothing drops: no lap to plan'
                                              : 'pack capacity is unread (might unknown): no lap to plan', loop };

  // ---- which spells
  const listed = loop.mode === 'practice' ? loop.practice : loop.maintain;
  const unplannable = [], spells = [];
  for (const name of listed) {
    const cost = spellCost(name, catalogue);
    if (!cost) { unplannable.push({ spell: name, why: 'no cost in the spell catalogue (substrate/m59-spells.json)' }); continue; }
    if (!knows.has(lc(cost.name))) { unplannable.push({ spell: name, why: 'not a spell this character knows' }); continue; }
    if (loop.mode === 'practice' && Number(abilities[lc(name)]) >= 99) { unplannable.push({ spell: name, why: 'at 99: nothing left to learn' }); continue; }
    const locked = !exempt.has(lc(name)) && cost.reagents.find(([item]) => (floors.get(reagentKey(item)) ?? 0) >= UNPLANNABLE_FLOOR);
    if (locked) {
      unplannable.push({ spell: name, why: `the PvP reserve holds every ${reagentKey(locked[0])} (floor ${floors.get(reagentKey(locked[0]))}): ` +
        `a non-PvP cast is vetoed (m59-reagent-reserve.mjs reserveBreach), so nothing carried for it could be spent` });
      continue;
    }
    spells.push({ name: lc(name), cost });
  }
  if (!spells.length) return { ok: false, why: 'nothing plannable', unplannable, lapMinutes: lapMin, loop };

  // ---- casts
  const regen = manaRegenPerMinute({ mysticism, maxMana: mana.max, vigor: loop.vigor });
  const budget = (Number(mana.max) || 0) + regen * lapMin;
  const casts = {}, notes = [];
  if (loop.mode === 'practice') {
    const meanMana = spells.reduce((n, s) => n + s.cost.mana, 0) / spells.length;
    let total = Math.floor(budget / Math.max(1, meanMana));
    const byGap = loop.gap_ms > 0 ? Math.floor((lapMin * 60000) / loop.gap_ms) : Infinity;
    if (byGap < total) { notes.push(`gap ${loop.gap_ms} ms caps practice at ${byGap} casts`); total = byGap; }
    spells.forEach((s, i) => { casts[s.name] = Math.floor(total / spells.length) + (i < total % spells.length ? 1 : 0); });
    notes.push(`practice: ${Math.round(budget)} mana over the lap (${mana.max ?? 0} start + ${regen.toFixed(2)}/min x ` +
               `${lapMin.toFixed(1)} min at vigor ${loop.vigor}) / ${meanMana.toFixed(1)} mana a cast = ${total} casts, round-robin`);
  } else {
    let manaNeed = 0;
    for (const s of spells) {
      const d = planningDuration(s.name, { durations: loop.durations, buffs: buffs ?? buffTable() });
      if (!d) { unplannable.push({ spell: s.name, why: 'duration unknown: name it in the loop\'s durations' }); continue; }
      casts[s.name] = 1 + Math.ceil(lapMin / d.minutes);
      manaNeed += casts[s.name] * s.cost.mana;
      notes.push(`${s.name}: 1 + ceil(${lapMin.toFixed(1)} / ${d.minutes.toFixed(2)} min) = ${casts[s.name]} casts (${d.from})`);
    }
    if (manaNeed > budget) notes.push(`MANA SHORT: upkeep needs ${manaNeed} mana and the lap yields about ${Math.round(budget)}`);
  }

  // ---- reagents: estimate, learned rate, hand edits, departure fit
  const est = {}, why = {};
  for (const s of spells) for (const [item, n] of s.cost.reagents)
    est[reagentKey(item)] = (est[reagentKey(item)] ?? 0) + (casts[s.name] ?? 0) * n;
  const wants = {};
  for (const [item, n] of Object.entries(est)) {
    const estRate = n / lapMin;
    const learnedRate = learned?.use_per_minute?.[item];
    let rate = Number.isFinite(learnedRate) && learnedRate >= 0 ? learnedRate : estRate;
    let src = Number.isFinite(learnedRate) ? 'learned rate' : 'estimate';
    const mult = loop.multipliers[item];
    if (mult) { rate = estRate * mult; src = `hand multiplier x${mult}`; }
    let amount = Math.ceil(rate * lapMin * (1 + loop.margin));
    if (loop.pinned[item] != null) { amount = loop.pinned[item]; src = 'pinned by hand'; }
    wants[item] = amount; why[item] = src;
  }
  // Departure must fit under the trigger: cut every line in proportion, and say so.
  let fit = null;
  if (capacity) {
    const add = { weight: 0, bulk: 0 };
    for (const [item, n] of Object.entries(wants)) {
      const w = weighItem(item) ?? { weight: 0, bulk: 0 };
      const extra = Math.max(0, n + (floors.get(item) ?? 0) - (Number(held[item]) || 0));
      add.weight += extra * w.weight; add.bulk += extra * w.bulk;
    }
    const room = { weight: at * capacity.weight_max - (Number(startLoad.weight) || 0),
                   bulk: at * (capacity.bulk_max ?? capacity.weight_max) - (Number(startLoad.bulk) || 0) };
    const scale = Math.min(1, ...['weight', 'bulk'].map(d => add[d] > 0 ? Math.max(0, room[d]) / add[d] : 1));
    if (scale < 1) {
      for (const item of Object.keys(wants)) if (loop.pinned[item] == null) wants[item] = Math.floor(wants[item] * scale);
      fit = `the planned reagents do not fit under the ${Math.round(at * 100)}% trigger at departure; every line cut to ${Math.round(scale * 100)}%`;
      notes.push(fit);
    }
  }
  const pvp = {}, totals = {}, take = {}, surplus = {}, lines = [];
  for (const [item, n] of Object.entries(wants)) {
    pvp[item] = floors.get(item) ?? 0;
    totals[item] = n + pvp[item];
    const h = Number(held[item]) || 0;
    if (totals[item] > h) take[item] = totals[item] - h;
    if (h > totals[item]) surplus[item] = h - totals[item];
    lines.push(`${item}: ${n} planned + ${pvp[item]} PvP reserve = ${totals[item]} (${why[item]})`);
  }
  return { ok: true, mode: loop.mode, trigger: loop.trigger, lapMinutes: +lapMin.toFixed(2), lap_source: lapSource,
           lap_estimate: lap ? { minutes: +lap.minutes.toFixed(2), binding: lap.binding, capped: lap.capped } : null,
           loot_per_kill: perKill ? { weight: +perKill.weight.toFixed(3), bulk: +perKill.bulk.toFixed(3) } : null,
           mana_per_minute: +regen.toFixed(3), casts, wants, pvp, totals, take, surplus, lines, unplannable,
           cut_to_fit: fit, why: notes };
}

/** A pack as { item: count }, folded the reserve's way. */
export function countsOf(pack = []) {
  const out = {};
  for (const r of pack ?? []) { const k = reagentKey(r.name); out[k] = (out[k] ?? 0) + (Number(r.amount) > 0 ? Number(r.amount) : 1); }
  return out;
}

// ============================================================================================ watching a lap
/** A fresh lap record. `plan` is planLap's answer; `pack` the pack at departure. */
export function startLap({ plan, pack = [], at = Date.now(), fullness = null }) {
  return { started_at: at, plan: plan?.ok ? { casts: plan.casts, wants: plan.wants, pvp: plan.pvp, totals: plan.totals,
           lapMinutes: plan.lapMinutes, mode: plan.mode, trigger: plan.trigger } : null,
           start: countsOf(pack), fullness_start: fullness, short_at: {}, spell_short_at: {}, fullness_last: fullness, last_at: at };
}

/**
 * ONE OBSERVATION OF THE PACK DURING A LAP. Marks the first moment each planned reagent fell below one cast above the PvP
 * floor, and each planned spell became unaffordable. Mutates and returns the lap. Pure otherwise.
 */
export function observeLap(lap, { pack = [], at = Date.now(), fullness = null, catalogue = loadCatalogue() } = {}) {
  if (!lap?.plan) return lap;
  const counts = countsOf(pack);
  for (const spell of Object.keys(lap.plan.casts ?? {})) {
    const cost = spellCost(spell, catalogue);
    if (!cost) continue;
    let affordable = true;
    for (const [item, n] of cost.reagents) {
      const k = reagentKey(item);
      if (usableOf(counts[k], lap.plan.pvp?.[k]) < n) { affordable = false; lap.short_at[k] ??= at; }
    }
    if (!affordable) lap.spell_short_at[spell] ??= at;
  }
  if (fullness != null) lap.fullness_last = fullness;
  lap.last_at = at;
  return lap;
}

/**
 * IS THE LAP OVER, BY THE LOOP'S TRIGGER? -> { end, cancel, by, why }.
 *   practice: the reagents are "empty" when NO planned spell can be cast; maintenance: when ANY required buff cannot.
 */
export function lapVerdict({ loop, lap, fullness = null }) {
  const full = fullness != null && fullness * 100 >= (loop?.full_percent ?? 90);
  const spells = Object.keys(lap?.plan?.casts ?? {});
  const short = Object.keys(lap?.spell_short_at ?? {});
  const empty = spells.length > 0 && (loop?.mode === 'maintenance' ? short.length > 0 : short.length >= spells.length);
  const trig = loop?.trigger ?? 'pack';
  if (empty && loop?.cancel_on_empty)
    return { end: true, cancel: true, by: 'reagents', why: `autobalanced reagents ran out (${short.join(', ')}) and cancel_on_empty is set` };
  if (trig === 'pack') return full ? { end: true, by: 'pack', why: 'pack at the trigger' } : { end: false };
  if (trig === 'reagents') return empty ? { end: true, by: 'reagents', why: `reagents empty: ${short.join(', ')}` } : { end: false };
  if (empty) return { end: true, by: loop?.mode === 'maintenance' ? 'buff' : 'reagents',
                      why: loop?.mode === 'maintenance' ? `a required buff can no longer be kept up: ${short.join(', ')}` : 'reagents empty' };
  return full ? { end: true, by: 'pack', why: 'pack at the trigger' } : { end: false };
}

// ============================================================================================ learning
const clampStep = (next, prev) => (prev > 0 ? Math.min(prev * LEARN_STEP_MAX, Math.max(prev / LEARN_STEP_MAX, next)) : next);
const ema = (prev, obs) => (Number.isFinite(prev) ? prev + LEARN_ALPHA * (obs - prev) : obs);

/**
 * THE LAP'S DISCREPANCY, SIGNED, AND THE NEXT LAP'S LEARNED STATE.
 *
 * @param lap       startLap/observeLap record; `end` { item: count } at the lap's end; `ended_at`; `ended_by`
 *                  ('pack' | 'reagents' | 'buff' | 'other'); `fullness_end` (0..1) when known
 * @param learned   previous learned state for this loop (or null)
 * @param sellAtLoad  the pack trigger fraction, to extrapolate a lap the reagents ended early
 * @returns { discrepancy, learned, per_item }
 */
export const MIN_EXTRAPOLATE_MIN = 10;
export function recordLap({ lap, end = {}, endedAt = Date.now(), endedBy = 'pack', fullnessEnd = null, learned = null,
                            sellAtLoad = 0.9, catalogue = loadCatalogue() } = {}) {
  const prev = learned ?? { laps_seen: 0, use_per_minute: {}, pack_minutes: null, laps: [] };
  const plan = lap?.plan;
  if (!plan) return { discrepancy: null, learned: prev, why: 'no plan this lap: nothing to learn' };
  const minutes = Math.max(0.01, (endedAt - lap.started_at) / 60000);
  const endCounts = Array.isArray(end) ? countsOf(end) : end;

  // How long the PACK took (or would have taken) to fill.
  let packMin = null, packWhy;
  if (endedBy === 'pack') { packMin = minutes; packWhy = 'the pack ended this lap'; }
  // A SHORT LAP IS NOISE FOR THE PACK (Scooter's first lap, 2026-11-05: 53% -> 54% in 2 min extrapolated to a pack time and
  // halved the next plan). Only a lap of MIN_EXTRAPOLATE_MIN or more is extrapolated.
  else if (minutes >= MIN_EXTRAPOLATE_MIN && fullnessEnd != null && lap.fullness_start != null && fullnessEnd > lap.fullness_start) {
    packMin = minutes * Math.max(0, sellAtLoad - lap.fullness_start) / (fullnessEnd - lap.fullness_start);
    packWhy = `extrapolated: ${Math.round(lap.fullness_start * 100)}% -> ${Math.round(fullnessEnd * 100)}% in ${minutes.toFixed(1)} min`;
  } else packWhy = minutes < MIN_EXTRAPOLATE_MIN && endedBy !== 'pack' ? `a ${minutes.toFixed(1)} min lap is too short to extrapolate the pack` : 'no fullness reading: pack time not learned this lap';

  // Per item: used, leftover above the floor, when it ran out.
  const per = {};
  let firstShort = null;
  for (const item of Object.keys(plan.wants ?? {})) {
    const floor = plan.pvp?.[item] ?? 0;
    const startUsable = usableOf(lap.start?.[item], floor);
    const endUsable = usableOf(endCounts[item], floor);
    const used = Math.max(0, startUsable - endUsable);
    const shortAt = lap.short_at?.[item] ?? null;
    const shortMin = shortAt != null ? Math.max(0.01, (shortAt - lap.started_at) / 60000) : null;
    if (shortMin != null && (firstShort == null || shortMin < firstShort)) firstShort = shortMin;
    per[item] = { planned: plan.wants[item], start_usable: startUsable, end_usable: endUsable, used,
                  ran_out_at_min: shortMin != null ? +shortMin.toFixed(2) : null };
  }

  // The discrepancy against the moment the pack filled (or would have).
  const target = packMin ?? minutes;
  let discrepancy;
  if (firstShort != null && firstShort < target) {
    discrepancy = { minutes: -(+(target - firstShort).toFixed(2)), casts_left: 0,
                    verdict: `ran out ${(target - firstShort).toFixed(1)} min before the pack filled` };
  } else {
    // casts' worth left over above the floor, by the scarcest reagent of each spell
    let castsLeft = 0;
    for (const spell of Object.keys(plan.casts ?? {})) {
      const cost = spellCost(spell, catalogue);
      if (!cost?.reagents?.length) continue;
      castsLeft += Math.min(...cost.reagents.map(([item, n]) => Math.floor(usableOf(endCounts[reagentKey(item)], plan.pvp?.[reagentKey(item)]) / n)));
    }
    const rate = Object.values(plan.casts ?? {}).reduce((a, b) => a + b, 0) / Math.max(0.01, plan.lapMinutes ?? minutes);
    const left = rate > 0 ? castsLeft / rate : 0;
    discrepancy = { minutes: +left.toFixed(2), casts_left: castsLeft,
                    verdict: castsLeft ? `the pack filled with ${castsLeft} casts left over above the PvP floor (~${left.toFixed(1)} min)` : 'zero: reagents and pack ran out together' };
  }

  // A LAP THAT STARTED EMPTY MEASURES NOTHING (Scooter's first lap, 2026-11-05: start_usable 0 for every reagent, so "used 0"
  // read as a rate of 0 and the next plan was cut in half). An item with nothing usable at the start teaches no rate; a lap
  // where EVERY item started empty teaches nothing at all -- it is scored and recorded, and the learned state is unchanged.
  const measured = Object.entries(per).filter(([, r]) => r.start_usable > 0);
  if (!measured.length) {
    const row = { started_at: lap.started_at, ended_at: endedAt, ended_by: endedBy, minutes: +minutes.toFixed(2), pack_minutes: null,
                  pack_why: packWhy, discrepancy, per_item: per, learned: false, why: 'started with no usable practice reagents: nothing to learn' };
    return { discrepancy, learned: { ...prev, laps: [...(prev.laps ?? []), row].slice(-LAPS_KEPT), last: row }, per_item: per, pack_minutes: null,
             pack_why: packWhy, why: row.why };
  }
  // Learn: use per minute over the time it was being used, damped and bounded.
  const next = { ...prev, use_per_minute: { ...(prev.use_per_minute ?? {}) } };
  for (const [item, r] of measured) {
    const active = r.ran_out_at_min ?? minutes;
    let obs = r.used / active;
    // Ran dry with no moment recorded: the true rate is AT LEAST used/minutes; raise by the bounded step.
    if (r.end_usable === 0 && r.ran_out_at_min == null && r.used > 0) obs = (r.used / minutes) * 1.5;
    const old = prev.use_per_minute?.[item] ?? (plan.wants[item] / Math.max(0.01, plan.lapMinutes ?? minutes));
    next.use_per_minute[item] = +clampStep(ema(old, obs), old).toFixed(4);
  }
  if (packMin != null) next.pack_minutes = +clampStep(ema(prev.pack_minutes, packMin), prev.pack_minutes ?? packMin).toFixed(2);
  next.laps_seen = (prev.laps_seen ?? 0) + 1;
  const row = { started_at: lap.started_at, ended_at: endedAt, ended_by: endedBy, minutes: +minutes.toFixed(2),
                pack_minutes: packMin != null ? +packMin.toFixed(2) : null, pack_why: packWhy, discrepancy, per_item: per };
  next.laps = [...(prev.laps ?? []), row].slice(-LAPS_KEPT);
  next.last = row;
  return { discrepancy, learned: next, per_item: per, pack_minutes: packMin, pack_why: packWhy };
}

// ============================================================================================ the keeper's restock overlay
/** Purchase requests with the plan's totals laid over: an item the plan names asks for (total - held), else unchanged. */
export function overlayRequests(requests = [], plan, held = {}) {
  if (!plan?.ok) return requests;
  const out = new Map(requests.map(r => [reagentKey(r.item), r]));
  for (const [item, total] of Object.entries(plan.totals)) {
    const need = Math.max(0, total - (Number(held[item]) || 0));
    if (need > 0) out.set(item, { item, amount: need, autobalance: true });
    else out.delete(item);
  }
  return [...out.values()];
}

/** A loadout whose carry keeps at least the plan's totals (a sale must not sell what the lap is about to carry). */
export function overlayCarry(loadout, plan) {
  if (!plan?.ok) return loadout;
  const carry = [...(loadout?.carry ?? [])].map(r => ({ ...r }));
  for (const [item, total] of Object.entries(plan.totals)) {
    const row = carry.find(r => reagentKey(r.item) === item);
    if (row) { row.max = Math.max(Number(row.max) || 0, Number(row.min) || 0, total); }
    else carry.push({ item, min: 0, max: total, match: 'exact', kind: 'reagent', why: 'reagent autobalance: kept for this lap' });
  }
  return { ...(loadout ?? { keep: [], sell: [], gear: { weapon: [], slots: {} }, character: null }), carry };
}

// ============================================================================================ couriers
/**
 * SHOULD THE COURIER BUY `item` FOR `recipient`? -> { buy, why }.
 * `evidence`: { need } -- how many they are short (count below want); { pack } -- their declared fullness 0..1, if known.
 */
export function courierGate(state, { recipient, item, evidence = {}, cfg = COURIER_DEFAULTS }) {
  const row = state?.[lc(recipient)]?.[reagentKey(item)];
  if (!row?.paused) return { buy: true };
  const need = Number(evidence.need) || 0, pack = evidence.pack;
  if (need > 0 && Number.isFinite(pack) && pack < cfg.room_below)
    return { buy: true, resumed: true, why: `short ${need} and pack ${Math.round(pack * 100)}% under ${Math.round(cfg.room_below * 100)}%` };
  return { buy: false, why: `paused since ${new Date(row.since).toISOString()} after ${row.failures} deliveries that could not land ` +
    `(${row.last_why}); waits for evidence of need AND room (pack ${Number.isFinite(pack) ? Math.round(pack * 100) + '%' : 'unknown'}, short ${need})` };
}
const ROOM_FAILURE = /receiver_full|full|refus|did not counter|no requested item left|could not hold|weight|bulk/i;
/** Record one delivery outcome. Mutates and returns state. `outcome`: { delivered: n } or { why }. */
export function recordDelivery(state = {}, { recipient, item, delivered = 0, why = null, at = Date.now(), cfg = COURIER_DEFAULTS }) {
  const r = (state[lc(recipient)] ??= {});
  const k = reagentKey(item);
  const row = (r[k] ??= { failures: 0, paused: false, since: null, last_why: null, delivered: 0 });
  if (delivered > 0) { Object.assign(row, { failures: 0, paused: false, since: null, last_why: null }); row.delivered += delivered; row.last_ok = at; return state; }
  if (!why || !ROOM_FAILURE.test(String(why))) return state;   // a walk failure, a vanished farmer: not evidence about room
  row.failures += 1; row.last_why = String(why).slice(0, 120); row.last_fail = at;
  if (row.failures >= cfg.pause_after && !row.paused) { row.paused = true; row.since = at; }
  return state;
}
export function readCourierState(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}
export const writeCourierState = (file, state) => writeJsonAtomic(file, state);

// ============================================================================================ hand edits
/** Apply one hand edit to an orders book. `key` is a loop key or `pinned.<item>` / `multipliers.<item>`. */
export function editLoop(book, character, { key, value, by = 'operator', why = null, at = Date.now(), clear = false }) {
  const b = book && typeof book === 'object' ? book : {};
  b.loops ??= {};
  const name = Object.keys(b.loops).find(k => lc(k) === lc(character)) ?? character;
  const loop = (b.loops[name] ??= {});
  const [head, sub] = String(key).split('.');
  if (!Object.hasOwn(LOOP_DEFAULTS, head) || head === 'edits') throw new Error(`${key} is not a loop key (${Object.keys(LOOP_DEFAULTS).filter(k => k !== 'edits').join(', ')})`);
  if (sub != null) {
    if (!['pinned', 'multipliers', 'durations'].includes(head)) throw new Error(`${head} takes no sub-key`);
    loop[head] ??= {};
    if (clear) delete loop[head][sub]; else loop[head][sub] = value;
  } else if (clear) delete loop[head]; else loop[head] = value;
  const problems = [];
  normalizeLoop(loop, problems);
  loop.edits = [...(loop.edits ?? []), { at: new Date(at).toISOString(), by, why, key, value: clear ? null : value, cleared: clear || undefined }].slice(-200);
  return { book: b, problems };
}
