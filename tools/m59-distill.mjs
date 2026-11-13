// THE GOAP DISTILLER: ONE NEXT ACTION PER CHARACTER TOWARD ITS CHARACTER PLAN — the decision half. Pure.
//
// Operator, 2026-11-13: "build a GOAP-distiller that when looped will train the fleet to get everything they need
// to get their character plans accomplished (the character plans being whatever was assigned via the compendium's
// party planner for each character)." And the rules that come with it: resources are sourced USE WHAT WE HAVE ->
// FARM -> BUY, farming is SAFE (the smallest creature that drops the thing), at most one or two characters are away
// from the home room at a time, and everyone stays alive.
//
// THIS FILE DECIDES AND NEVER ACTS. tools/m59-distill-run.mjs observes (read-only), hands the observation here, and —
// only with --apply — executes what comes back through executors that already exist (the broker's own planned-learning
// errand, the practice-plan / hall-draw / buy fleetscripts, the fleetscript `supply` step). Nothing here opens a
// socket, reads a roster or writes a file; the data tables (spawns, merchants, spells) are passed in or loaded from
// the committed files, so the whole decision is pinned offline by m59-distill-test.mjs.
//
// WHAT A "PLAN" IS. The party planner writes substrate/loadouts/<character>.json `plan`; the broker's learningView
// turns it into the fleet row's `learning` = { progress, planned: { active[], next, abilities[] } } using the
// compendium's PlayerCanLearn arithmetic. `planned.next` is the first ability of the first unfinished queue stage
// that the server is expected to OFFER now; a row with `remaining_required > 0` is gated by school (or weaponcraft)
// points, which only practice moves. This file reads that view and does not recompute it.
//
// THE PRIORITY, per character, first match wins (one action per character per pass):
//
//   (a) SKIP     dead, not in game, piloted by a person, excluded, hurt (< hurt_below of max health), mid-errand
//                (an untakeable commitment, a move ordered by somebody else, an action of ours still in flight), or
//                cooling down after one of our actions failed. A FRAGILE body (max health < fragile_below) is never
//                given a road action; in-place actions still apply.
//   (b) LEARN    planned.next is expected_buyable, its teacher stands in a reachable room (not the island, not a
//                trap, not listed unreachable) and purse + bank covers the price. Executed by the broker's
//                buy_next_planned_skills, which re-preflights against fresh reads and keeps the burnt-purchase guard.
//   (c) PRACTICE an active planned SPELL is short of school points: the gate spells to drill (m59-practice-plan's
//                planPractice, rooms = [home]) — but ONLY when the drill set, rooms or floor differ from the
//                practice_spells already in force. A re-order inside the same set is not a re-push. In a room with
//                no creatures (an inn) creature-target spells are left out — the keeper declines a WHOLE pass when
//                one heads the list — and elsewhere they go last; the mana floor is capped at max mana less the
//                dearest listed spell, and is 0 where nothing can be fought (prod, 2026-11-13, room 153).
//   (d) SUPPLY   first, a pack at full_pct cannot receive anything: make space in place (the make-space fleetscript
//                drops only the keeper's own sale-plan rows), else propose a deposit of the shillings and gems.
//                Then a reagent the drill burns is under its low-water mark: from a same-room fleet-mate (supply, the
//                donor keeps its own want plus max(10, 25%)), then the guild hall's chests (hall-draw), then FARM
//                (the safest creature that drops it, within the character's band and karma; executed only when the
//                operator allow-listed that source, otherwise a PROPOSAL), then BUY (the cheapest reachable counter
//                that sells it, money permitting, never for a character whose loadout pins buy_reagents: false).
//   (e) TRAIN    an active planned SKILL is short of weaponcraft points: a safe training quarry, as a PROPOSAL only
//                in v1 (a skill improves fastest on prey up to level 45 — m59-spawns.mjs, "THE THREE RULES").
//
// THE SCHEDULER, over the whole fleet: a road action (anything that leaves the room) needs the character AT HOME, a
// destination off the island and out of the traps, a route (when the runner supplies one) that does not cross the
// Cragged Mountains / Ancient Place for a body at or under risky_hp, and a free away slot — `away_limit` counts in-scope characters already outside the home room, plus road actions this
// pass has granted. Never two actions on one character, and a character handing reagents over this pass is not
// given an action of its own. A failed action cools down for `cooldown_ms`; a learn that may have spent money
// (exit 1) is not retried at all (the broker's guard says the same until it restarts).
import { planPractice, itemKey, schoolKey } from './m59-practice-plan.mjs';
import { whoDrops, karmaSafe, DEAD_ROOMS } from './m59-spawns.mjs';
import { classOf, buySources } from './m59-sourcing-lib.mjs';
import { isTakeable } from './m59-commitment.mjs';
import { normalizePractice } from './m59-deskpractice.mjs';

export const DEFAULTS = Object.freeze({
  home: null,                 // the home room; road actions start and end here
  away_limit: 1,              // characters outside the home room at once (in-scope, observed + granted this pass)
  exclude: [],                // agents never touched (and never used as donors)
  only: null,                 // restrict to these action kinds; everything else falls through
  hurt_below: 0.8,            // health fraction under which a character is left to recover
  fragile_below: 25,          // max health under which no road action is given (fleetScript's fragileBody agrees)
  island_from: 2000,          // rooms at and above this are the island: unreachable without a ride
  trap_rooms: [599],          // KNOWN_TRAPS (the runner passes the fleetscript list): never a destination
  unreachable_rooms: [],      // anything else the operator rules out
  respect_confine: true,      // a character with confine_rooms is not sent outside them
  farm_band: 1.0,             // a farm creature, and every creature in its room, at most this x max health
  farm_allow: [],             // [{ creature, room, item? }] sources the operator approved for execution
  farm_count: 20,             // how many to farm in one trip
  farm_minutes: 20,           // the farming budget
  buy_when_farm_unapproved: true,   // a farm source that is only a proposal does not block buying
  stock_casts: 20,            // practice-plan: reagent stock per gate spell, in casts
  rest_casts: 5,              // practice-plan: reagent stock per other spell, in casts (its own default)
  practice_creatures: null,   // does the practice room hold creatures? null = ask the spawn index (an inn: no)
  risky_rooms: [578, 579],    // Cragged Mountains, the Ancient Place: no route through them for a light body
  risky_hp: 40,               // max health at or under which a route through risky_rooms is refused
  full_pct: 95,               // a pack this full cannot receive: make space first
  make_space_bulk: 200,       // free bulk asked of make-space (its own cap is 400)
  low_water: 0.25,            // supply when on hand (less kept) falls under this fraction of the want
  donor_keep_min: 10,         // a donor keeps its own want plus max(donor_keep_min, donor_keep_frac x held)
  donor_keep_frac: 0.25,
  hall_room: null,            // the guild hall the chests stand in; null = no hall source
  hall_keep: 0,               // left in the chests per item
  bank_room: 54,              // where a buy withdraws when the account is not recognised (buy.mjs: 54, 376, 2005)
  buy_avoid_rooms: [],
  buy_prefer_rooms: [],
  buy_margin: 50,             // shillings over the estimate when withdrawing
  cooldown_ms: 30 * 60_000,   // after a failure or refusal
  learn_repeat_ms: 6 * 3600_000,   // a learn that was sent and still is not held is not re-sent for this long
  inflight_max_ms: 2 * 3600_000,    // a start with no outcome older than this no longer marks the body busy
  train_level_cap: 45,        // skill improve chance saturates at prey level 45
});

const KINDS = Object.freeze(['learn', 'practice', 'make_space', 'supply', 'hall_draw', 'farm', 'buy', 'train']);
export const ROAD_KINDS = Object.freeze(new Set(['learn', 'hall_draw', 'farm', 'buy']));
export { KINDS };

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const lc = s => String(s ?? '').trim().toLowerCase();
const pair = s => { const m = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(String(s ?? '')); return m ? [Number(m[1]), Number(m[2])] : [null, null]; };

/** Merge a partial config over the defaults; lists are normalised to numbers/strings. */
export function config(over = {}) {
  const c = { ...DEFAULTS, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) };
  c.exclude = [].concat(c.exclude ?? []).map(String).filter(Boolean);
  // IDEMPOTENT, because the runner normalises once and decide() normalises again. `[].concat(aSet)` is `[aSet]`, and
  // its one element lower-cased is "[object set]": every kind was then "not allowed" and --only practice reported
  // "nothing to do" for characters the unrestricted pass was practising (prod, deploy-2026-11-13-3).
  const listOf = v => v instanceof Set || (v && typeof v !== 'string' && typeof v[Symbol.iterator] === 'function') ? [...v] : [].concat(v);
  c.only = c.only == null ? null : new Set(listOf(c.only).map(lc).filter(Boolean));
  for (const k of ['trap_rooms', 'unreachable_rooms', 'buy_avoid_rooms', 'buy_prefer_rooms', 'risky_rooms'])
    c[k] = [].concat(c[k] ?? []).map(Number).filter(Number.isFinite);
  c.home = num(c.home);
  c.away_limit = Math.max(0, Math.trunc(num(c.away_limit) ?? 1));
  return c;
}

// ------------------------------------------------------------------------------------------- observation

/**
 * One character as the decision needs it, from the fleet row plus the two per-character reads the row lacks.
 * @param row     the broker `fleet` row
 * @param spells  the `abilities` tool's spells ([{name, school, level?, ability}]) or null when unread
 * @param karma   the `status` karma value, or null when unread
 * @param loadout the character's loadout `policy` block (substrate/loadouts/<Name>.json), or null
 */
export function observation(row = {}, { spells = null, karma = null, loadout = null } = {}) {
  const [hp, hpMax] = pair(row.health), [mana, manaMax] = pair(row.mana);
  const pack = (row.pack_items ?? []).map(i => ({ name: String(i.name ?? ''), amount: Number(i.amount) || 1 }));
  return {
    agent: row.agent, character: row.character ?? null,
    in_game: row.in_game !== false && row.room_num != null,
    in_roster: row.in_roster !== false,
    piloted: typeof row.human_held === 'boolean' ? row.human_held : !!row.piloted,
    room: num(row.room_num), hp, hp_max: hpMax ?? num(row.level), mana, mana_max: manaMax,
    vigor: num(row.vigor), purse: num(row.purse) ?? 0, bank: num(row.banked?.balance) ?? 0,
    bank_account: row.banked?.account ?? null,
    pack, pack_percent: num(row.pack?.percent),
    committed: row.committed ?? null, busy: row.busy ?? null, ordered_by: row.ordered_by ?? null,
    activity: String(row.activity ?? ''), pvp_hold: row.pvp_return_hold ?? null,
    has_weapon: row.has_weapon !== false,
    policy: row.policy ?? {}, learning: row.learning ?? null,
    spells, karma: num(karma),
    // A loadout may pin buy_reagents:false for a character; the keeper's own policy key is buyReagents.
    buy_reagents: loadout?.buy_reagents === false || row.policy?.buyReagents === false ? false : true,
  };
}

const isDead = o => (o.hp != null && o.hp <= 0) || /\bdead\b|underworld/i.test(o.activity);
const healthFrac = o => (o.hp != null && o.hp_max > 0 ? o.hp / o.hp_max : null);
const onHand = (pack, name) => { const k = itemKey(name); return pack.filter(i => itemKey(i.name) === k).reduce((t, i) => t + i.amount, 0); };
const packName = (pack, name) => { const k = itemKey(name); return pack.filter(i => itemKey(i.name) === k).sort((a, b) => b.amount - a.amount)[0]?.name ?? null; };

/** WHICH WAY THIS CHARACTER'S KARMA MUST NOT MOVE: the policy's `karma`, else the schools it knows or plans.
 *  Shal'ille needs good karma and Qor evil (the kod's required_karma signs); both at once is no opinion. */
export function karmaWant(o) {
  const p = lc(o.policy?.karma);
  if (p === 'good' || p === 'evil' || p === 'neutral') return p;
  const schools = new Set([...(o.spells ?? []).map(s => schoolKey(s.school)),
    ...(o.learning?.planned?.abilities ?? []).map(r => schoolKey(r.school))].filter(Boolean));
  const good = schools.has('shalille'), evil = schools.has('qor');
  return good && !evil ? 'good' : evil && !good ? 'evil' : null;
}

/** May this character kill a creature of this karma for a FARM assignment? A strict character takes only what moves
 *  its karma the right way (the keeper's own karma_strict rule, karmaSafe); otherwise only the wrong direction is out.
 *  Unknown karma is refused whenever a direction is protected: an assignment is a choice, not a fight already on. */
export function farmKarmaOk(creatureKarma, want, strict = false) {
  if (!want) return true;
  if (creatureKarma == null) return false;
  if (strict) return karmaSafe(creatureKarma, want);
  if (want === 'good') return creatureKarma <= 0;
  if (want === 'evil') return creatureKarma >= 0;
  return true;
}

export function roomReachable(room, c) {
  const r = num(room);
  if (r == null) return { ok: false, why: 'no room on record' };
  if (r >= c.island_from) return { ok: false, why: `room ${r} is on the island (>= ${c.island_from})` };
  if (c.trap_rooms.includes(r)) return { ok: false, why: `room ${r} is a known trap` };
  if (c.unreachable_rooms.includes(r)) return { ok: false, why: `room ${r} is listed unreachable` };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------- history

/**
 * What the ledger says about an (agent, kind, key): busy (a start with no outcome, still young), cooling (a recent
 * failure), or barred (a learn that may have spent money). `history` rows: { at, agent, kind, key, phase, ok, code }.
 */
export function historyGate(history = [], { agent, kind, key = null }, c, now = Date.now()) {
  const mine = history.filter(h => h.agent === agent && (kind == null || h.kind === kind) && (key == null || lc(h.key) === lc(key)))
    .sort((a, b) => a.at - b.at);
  const last = mine[mine.length - 1];
  if (!last) return null;
  if (last.phase === 'start' && now - last.at < c.inflight_max_ms) return { busy: true, why: `our ${last.kind} ${last.key ?? ''} is still in flight (since ${new Date(last.at).toISOString()})` };
  const outcome = [...mine].reverse().find(h => h.phase === 'outcome');
  // A QUEUED LEARN IS NOT A LEARNED ONE. The errand may come back refused (spent nothing) and leave no record, and the
  // ability is still 'next' -- so without this the same wasted trip was re-sent every pass (2026-11-13: Piggy scimitar
  // wielding, Pepe spiritual hammer). If the ability had been learned it would no longer be next.
  if (kind === 'learn' && outcome?.ok && now - outcome.at < c.learn_repeat_ms)
    return { cooling: true, why: `${outcome.key} was sent ${Math.round((now - outcome.at) / 60000)} min ago and is still not held; not re-sent for ${Math.round(c.learn_repeat_ms / 3600000)} h` };
  if (!outcome || outcome.ok) return null;
  if (outcome.kind === 'learn' && outcome.code === 1) return { barred: true, why: `${outcome.key}: the last attempt may have spent money and did not deliver — not retried` };
  if (now - outcome.at < c.cooldown_ms) return { cooling: true, why: `${outcome.kind} ${outcome.key ?? ''} failed ${Math.round((now - outcome.at) / 60000)} min ago (${outcome.why ?? 'no reason'}); cooling down` };
  return null;
}

/** Any in-flight action of ours on this agent, whatever the kind. */
const inflight = (history, agent, c, now) => {
  const starts = new Map();
  for (const h of [...history].sort((a, b) => a.at - b.at).filter(h => h.agent === agent)) {
    const id = h.id ?? `${h.kind}:${h.key}`;
    if (h.phase === 'start') starts.set(id, h); else if (h.phase === 'outcome') starts.delete(id);
  }
  return [...starts.values()].find(h => now - h.at < c.inflight_max_ms) ?? null;
};

// ------------------------------------------------------------------------------------------- sources

/**
 * THE SAFEST PLACE TO FARM `item` FOR THIS CHARACTER. Every creature the drop index says rolls it, in every room it
 * generates in, kept only when the creature AND every huntable creature in that room is within farm_band x max
 * health, the room is reachable and not dead, and the creature's karma is allowed. Smallest creature first, then
 * the better drop rate. Returns { best, candidates, why }.
 */
export function farmSource(spawns, item, o, c) {
  const drops = whoDrops(spawns, item);
  if (!drops.length) return { best: null, candidates: [], why: `nothing in the drop index drops ${item}` };
  const ceiling = (o.hp_max ?? 0) * c.farm_band;
  const want = karmaWant(o), strict = !!o.policy?.karmaStrict;
  const out = [], refused = [];
  for (const d of drops) {
    const cr = Object.values(spawns.creatures ?? {}).find(x => x.name === d.creature);
    if (!(num(d.level) > 0)) { refused.push(`${d.creature}: level unknown`); continue; }
    if (d.level > ceiling) { refused.push(`${d.creature} L${d.level} is over the band (${ceiling})`); continue; }
    if (!farmKarmaOk(d.karma, want, strict)) { refused.push(`${d.creature} (karma ${d.karma}) moves a ${want}${strict ? ' strict' : ''} character's karma the wrong way`); continue; }
    for (const room of [...new Set((cr?.sites ?? []).map(s => Number(s.room)))]) {
      if (DEAD_ROOMS.has(room)) continue;
      const reach = roomReachable(room, c);
      if (!reach.ok) continue;
      // A room the index has no generator list for is UNLISTED: its worst is at least the creature itself, and it
      // sorts after a listed room of the same creature, because "nothing else known there" is not "nothing else there".
      const listed = Array.isArray(spawns.rooms?.[room]);
      const others = (spawns.rooms?.[room] ?? []).filter(g => g.huntable !== false);
      const worst = others.reduce((m, g) => Math.max(m, num(g.level) ?? 0), d.level);
      if (worst > ceiling) continue;
      const strangers = others.filter(g => !farmKarmaOk(g.karma, want, strict)).map(g => g.creature);
      out.push({ item, creature: d.creature, level: d.level, karma: d.karma, per_roll_percent: d.per_roll_percent,
                 room, room_worst: worst, unlisted: listed ? undefined : true,
                 karma_neighbours: strangers.length ? strangers : undefined });
    }
  }
  out.sort((a, b) => a.level - b.level || (b.per_roll_percent ?? 0) - (a.per_roll_percent ?? 0)
    || (a.unlisted ? 1 : 0) - (b.unlisted ? 1 : 0)
    || (a.karma_neighbours ? 1 : 0) - (b.karma_neighbours ? 1 : 0) || a.room_worst - b.room_worst || a.room - b.room);
  return { best: out[0] ?? null, candidates: out,
           why: out.length ? null : `no safe source for ${item}: ${refused.slice(0, 4).join('; ') || 'every room it lives in is over the band or unreachable'}` };
}

/** THE CHEAPEST REACHABLE COUNTER THAT SELLS `item`, from the merchant catalogue. Wanderers are left out (v1). */
export function buySource(sourcing, item, c) {
  const cls = classOf(sourcing, item);
  if (!cls) return { best: null, why: `${item} is not in the item table` };
  const wanders = new Set((sourcing.merchants ?? []).filter(m => m.wanders).map(m => `${m.name}@${m.room}`));
  const rows = buySources(sourcing, cls, item)
    .filter(b => !wanders.has(`${b.merchant}@${b.room}`) && roomReachable(b.room, c).ok && !c.buy_avoid_rooms.includes(Number(b.room)));
  rows.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9)
    || (c.buy_prefer_rooms.includes(b.room) ? 1 : 0) - (c.buy_prefer_rooms.includes(a.room) ? 1 : 0)
    || (a.room >= 1000 ? 1 : 0) - (b.room >= 1000 ? 1 : 0) || a.room - b.room);
  return { best: rows[0] ?? null, why: rows.length ? null : `nobody reachable sells ${item}` };
}

/** Which bank a buy withdraws at, from the account the bankbook last saw (buy.mjs knows 54, 376 and 2005). */
export function bankRoomFor(o, c) {
  const a = lc(o.bank_account);
  if (/tos/.test(a)) return 54;
  if (/jasper/.test(a)) return 376;
  if (/ko.?catan/.test(a)) return 2005;
  return c.bank_room;
}

/** Hall chest stock, by itemKey: { key: { name, amount } }, from chest cache files ({room, items}). */
export function hallStock(chests = [], hallRoom = null) {
  const out = {};
  for (const ch of chests) {
    if (hallRoom != null && ch.room != null && Number(ch.room) !== Number(hallRoom)) continue;
    for (const it of ch.items ?? []) {
      const k = itemKey(it.name);
      if (!k) continue;
      out[k] ??= { name: it.name, amount: 0 };
      out[k].amount += Number(it.amount) || 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- the decision

const SAME_DRILL = (live, want) => {
  if (!live || live.enabled === false) return false;
  const names = p => new Set((p?.spells ?? []).map(e => lc(e?.name ?? e)));
  const a = names(live), b = names(want);
  if (a.size !== b.size || [...b].some(n => !a.has(n))) return false;
  // The TARGET is part of the drill: a fleet-mate entry and a self entry of one spell are different drills.
  const targets = p => new Map((p?.spells ?? []).map(e => [lc(e?.name ?? e), e?.target ?? null]));
  const ta = targets(live), tb = targets(want);
  if ([...tb].some(([n, t]) => (ta.get(n) ?? null) !== t)) return false;
  if (Number(live.mana_floor ?? live.manaFloor ?? 0) !== Number(want.mana_floor ?? 0)) return false;
  const rooms = p => JSON.stringify([...(p?.rooms ?? [])].map(Number).sort((x, y) => x - y));
  return rooms(live) === rooms(want);
};
export { SAME_DRILL as sameDrill };

/** The reagents a character's drill burns that are under the low-water mark, most urgent first. */
export function reagentNeeds(plan, c) {
  return (plan?.reagents ?? []).filter(r => r.spells?.some(s => s.role === 'gate' || s.role === 'bench' || s.casts > 0))
    .map(r => ({ item: r.item, key: r.key ?? itemKey(r.item), per_cast: r.per_cast, on_hand: r.on_hand, kept: r.kept,
                 wanted: r.wanted, shortfall: r.shortfall, blocking: (r.blocks ?? []).length > 0,
                 gate: (r.spells ?? []).some(s => s.role === 'gate' || s.role === 'bench') }))
    .filter(r => r.wanted > 0 && (r.blocking || r.on_hand - r.kept < r.wanted * c.low_water))
    // The GATE's reagents first: they are what moves the plan; a rest spell's reagent only keeps the drill busy.
    .sort((a, b) => (b.gate ? 1 : 0) - (a.gate ? 1 : 0) || (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0)
      || b.shortfall - a.shortfall || a.item.localeCompare(b.item));
}

/** Does the practice room hold anything a creature-target spell can be aimed at? `practice_creatures` overrides;
 *  otherwise the spawn index decides, and a room it lists nothing huntable in (an inn) has none. */
export function roomHasCreatures(spawns, room, c = DEFAULTS) {
  if (c.practice_creatures === true || c.practice_creatures === false) return c.practice_creatures;
  return (spawns?.rooms?.[room] ?? []).some(g => g.huntable !== false);
}

const isCreatureEntry = e => typeof e === 'object' && e?.target === 'creature';

/**
 * The practice plan for one character (or null when it has nothing to practise toward), with the two corrections
 * prod taught on 2026-11-13 (sixteen characters drilling in an inn, room 153, nothing to aim at):
 *
 *   CREATURE-TARGET SPELLS. The keeper's desk practice declines the WHOLE pass ("not on a safe spot") when the head
 *   of the list is a creature-target spell with no creature to cast it on, so one zap at the head of an inn's list
 *   stopped all practice. In a room with no creatures they are not drillable at all (planned with no quarry, and
 *   any creature entry on the live list dropped); where creatures exist they go LAST, so they never head the list.
 *   THE MANA FLOOR. practice-plan keeps a 17 floor for enchant weapon's knowers; a 21-max-mana caster with 10-mana
 *   spells then read `reserve_leaves_no_room` for ever. The floor is capped at max mana less the dearest listed
 *   spell, and in a room with no creatures (nothing to fight, nobody to dedicate for in an inn) it is 0.
 */
export function practiceFor(o, c, catalogue, { creatures = true } = {}) {
  const learning = o.learning;
  const active = learning?.planned?.active ?? [];
  const gated = active.filter(r => r.kind === 'spell' && num(r.remaining_required) > 0);
  const progress = learning?.progress;
  const progressGated = progress && progress.target && lc(progress.target) !== 'weaponcraft' && num(progress.points) > 0
    && active.some(r => r.kind !== 'skill');
  if (!gated.length && !progressGated) return null;
  if (!o.spells) return { ok: false, why: 'spells unread', gated };
  // Every school the character knows is planned; planPractice puts the PLANNED school's gate at the head of the
  // list, and the other spells (rest_casts reagents each) follow, as the practice-plan fleetscript does.
  const live = o.policy?.practiceSpells ?? null;
  const policy = creatures ? o.policy
    : { ...o.policy, hunt: [], ...(live ? { practiceSpells: { ...live, spells: (live.spells ?? []).filter(e => !isCreatureEntry(e)) } } : {}) };
  const plan = planPractice({
    known: o.spells, planner: learning, pack: o.pack, maxMana: o.mana_max, vigor: o.vigor, karma: o.karma,
    policy, catalogue,
    options: { rooms: c.home != null ? [c.home] : o.room != null ? [o.room] : null,
               stockCasts: c.stock_casts, restCasts: c.rest_casts, ...(creatures ? {} : { quarry: [] }) },
  });
  if (!plan.ok) return { ...plan, gated };
  // Creature entries last (and in a creature-less room there are none: planPractice left them undrillable).
  let spells = [...plan.practice.spells.filter(e => !isCreatureEntry(e)), ...plan.practice.spells.filter(isCreatureEntry)];
  // IN A CREATURE-FREE ROOM (an inn) A FLEET-MATE TARGET IS REFUSED: measured 2026-11-13 at the Cibilo Creek Inn,
  // Zoot's free action on fleet-mates was refused 91 of 91, then 17 completed / 10 failed rolls of 28 on himself.
  // So there the drill casts on self.
  if (!creatures) spells = spells.map(e => (e && typeof e === 'object' && e.target === 'fleetmate') ? { ...e, target: 'self' } : e);
  const order = spells.map(e => lc(e?.name ?? e));
  // The floor: never above max mana less the dearest listed spell; 0 where there is nothing to fight.
  const cost = n => plan.spells.find(s => lc(s.name) === n)?.mana ?? 0;
  const dearest = order.reduce((m, n) => Math.max(m, cost(n)), 0);
  let floor = plan.mana.floor;
  const floorNotes = [];
  if (!creatures && floor > 0) { floorNotes.push(`floor ${floor} -> 0: no creatures in the practice room`); floor = 0; }
  if (o.mana_max != null && floor > Math.max(0, o.mana_max - dearest)) {
    const cap = Math.max(0, o.mana_max - dearest);
    floorNotes.push(`floor ${floor} -> ${cap}: max mana ${o.mana_max} less the dearest listed spell (${dearest})`);
    floor = cap;
  }
  const practice = { ...plan.practice, spells, mana_floor: floor };
  const problems = normalizePractice(practice)?.problems ?? [];
  if (problems.length) return { ...plan, ok: false, why: `the practice config would be refused: ${problems.join('; ')}`, gated };
  return { ...plan, practice, order, mana: { ...plan.mana, floor }, gated, creatures, floor_notes: floorNotes,
           blockers: floorNotes.length ? plan.blockers.filter(b => b.kind !== 'reserve_leaves_no_room' && b.kind !== 'never_affordable')
                                       : plan.blockers };
}

/**
 * DECIDE. Pure: everything is passed in.
 * @param characters  [observation(...)], one per fleet row
 * @param config      partial DEFAULTS
 * @param data        { spawns, sourcing, chests, catalogue? }
 * @param history     ledger rows (see historyGate)
 * @returns { decisions: [{ agent, character, action|null, why, notes[], proposals[] }], away: {...} }
 */
export function decide({ characters = [], config: over = {}, data = {}, history = [], now = Date.now() } = {}) {
  const c = config(over);
  const allowed = k => !c.only || c.only.has(k);
  const inScope = o => o.in_game && o.in_roster && !o.piloted && !c.exclude.includes(o.agent);
  const awayNow = c.home == null ? 0 : characters.filter(o => inScope(o) && o.room !== c.home).length;
  let awayGranted = 0;
  const touched = new Set();
  const hall = hallStock(data.chests ?? [], c.hall_room);

  // Phase 1: every character's practice plan, so a donor's own want is known before anybody gives.
  const plans = new Map();
  for (const o of characters) if (inScope(o)) {
    const creatures = roomHasCreatures(data.spawns, c.home ?? o.room, c);
    try { plans.set(o.agent, practiceFor(o, c, data.catalogue, { creatures })); } catch (e) { plans.set(o.agent, { ok: false, why: e.message }); }
  }
  const ownWant = (agent, key) => (plans.get(agent)?.reagents ?? []).filter(r => (r.key ?? itemKey(r.item)) === key)
    .reduce((t, r) => t + (r.wanted ?? 0), 0);
  const spare = new Map();   // agent -> key -> amount still givable this pass
  const spareOf = (d, key, name) => {
    const m = spare.get(d.agent) ?? new Map(); spare.set(d.agent, m);
    if (!m.has(key)) {
      const held = onHand(d.pack, name);
      const keep = ownWant(d.agent, key) + Math.max(c.donor_keep_min, Math.ceil(held * c.donor_keep_frac));
      m.set(key, Math.max(0, held - keep));
    }
    return m.get(key);
  };

  const decisions = [];
  const sorted = [...characters].sort((a, b) => String(a.agent).localeCompare(String(b.agent)));
  for (const o of sorted) {
    const d = { agent: o.agent, character: o.character, action: null, why: null, notes: [], proposals: [] };
    decisions.push(d);
    const skip = why => { d.why = why; };

    // (a) SAFETY AND SKIPS.
    if (c.exclude.includes(o.agent)) { skip('excluded'); continue; }
    if (!o.in_roster) { skip('not in the roster'); continue; }
    if (!o.in_game) { skip('not in game'); continue; }
    if (o.piloted) { skip('piloted by a person: hands off'); continue; }
    if (isDead(o)) { skip('dead'); continue; }
    if (touched.has(o.agent)) { skip('handing reagents over this pass'); continue; }
    const frac = healthFrac(o);
    if (frac == null) { skip('health unread'); continue; }
    if (frac < c.hurt_below) { skip(`hurt (${o.hp}/${o.hp_max} < ${Math.round(c.hurt_below * 100)}%): left to recover`); continue; }
    if (o.committed && !isTakeable(o.committed)) { skip(`mid-errand: committed to ${o.committed.kind ?? o.committed.what ?? 'something'}`); continue; }
    if (o.busy) { skip(`mid-errand: ${typeof o.busy === 'string' ? o.busy : o.busy.label ?? 'busy'}`); continue; }
    if (o.ordered_by && !/^keeper/i.test(String(o.ordered_by))) { skip(`mid-errand: a move ordered by ${o.ordered_by}`); continue; }
    const mine = inflight(history, o.agent, c, now);
    if (mine) { skip(`our ${mine.kind} ${mine.key ?? ''} is still in flight`); continue; }
    if (!o.learning?.planned?.configured) { skip('no character plan (the party planner has assigned nothing)'); continue; }

    const fragile = (o.hp_max ?? 0) < c.fragile_below;
    const confined = c.respect_confine && (o.policy?.confineRooms ?? []).length > 0;
    // May this character take to the road, to `room`? The reason is the answer when it may not.
    const roadBlock = (room) => {
      if (fragile) return `fragile body (${o.hp_max} max health < ${c.fragile_below}): no road actions`;
      if (o.pvp_hold) return 'a PvP return hold is in force';
      if (c.home == null) return 'no home room given';
      if (o.room !== c.home) return `not at home (in ${o.room}): road actions start from ${c.home}`;
      if (confined && !(o.policy.confineRooms ?? []).map(Number).includes(Number(room)))
        return `confined to ${(o.policy.confineRooms).join(',')}`;
      if (awayNow + awayGranted >= c.away_limit) return `away limit: ${awayNow + awayGranted} already away of ${c.away_limit}`;
      const reach = roomReachable(room, c);
      if (!reach.ok) return reach.why;
      // THE ROAD, NOT ONLY THE DESTINATION. A light body does not cross the Cragged Mountains or the Ancient Place;
      // `data.route(from, to)` is the room path (the runner's BFS over the baked room graph — fewest hops, an
      // approximation of the mover's route), and null means the baked graph knows no way at all.
      if (typeof data.route === 'function' && Number(room) !== o.room) {
        const path = data.route(o.room, Number(room));
        if (!path) return `no route from ${o.room} to ${room} in the baked room graph`;
        const risky = path.filter(r => c.risky_rooms.includes(Number(r)));
        if (risky.length && (o.hp_max ?? 0) <= c.risky_hp)
          return `the route to ${room} crosses ${[...new Set(risky)].join(',')}, unsafe at ${o.hp_max} max health (<= ${c.risky_hp})`;
      }
      return null;
    };
    const gate = (kind, key) => historyGate(history, { agent: o.agent, kind, key }, c, now);
    const take = (action, why) => {
      d.action = { agent: o.agent, character: o.character, ...action };
      d.why = why;
      if (ROAD_KINDS.has(action.kind) && action.executable !== false) awayGranted++;
    };

    // (b) LEARN.
    const next = o.learning.planned.next;
    if (next && allowed('learn')) {
      const money = o.purse + o.bank, price = num(next.price);
      const g = gate('learn', next.name);
      const block = !next.expected_buyable ? 'not expected to be offered'
        : g ? g.why
        : price == null ? 'no price on record'
        : money < price ? `cannot afford: ${price} against ${o.purse} purse + ${o.bank} bank`
        : roadBlock(next.teacher?.room);
      if (!block) {
        take({ kind: 'learn', skill: next.name, ability_kind: next.kind, level: next.level, price,
               teacher: next.teacher ?? null, room: num(next.teacher?.room), road: true },
             `${next.name} (${next.kind} L${next.level}) is buyable now from ${next.teacher?.name ?? '?'} in ${next.teacher?.room}`);
        continue;
      }
      d.notes.push(`learn ${next.name}: ${block}`);
    } else if (!next) {
      const first = (o.learning.planned.active ?? [])[0];
      if (first?.blocked_by?.length) d.notes.push(`${first.name}: ${first.blocked_by.join('; ')}`);
    }

    // (c) PRACTICE.
    const plan = plans.get(o.agent);
    if (plan && plan.ok === false) d.notes.push(`practice: ${plan.why}`);
    if (plan?.ok && allowed('practice')) {
      if (!SAME_DRILL(o.policy?.practiceSpells, plan.practice)) {
        const g = gate('practice', 'practice');
        if (!g) {
          take({ kind: 'practice', spells: plan.order, rooms: plan.practice.rooms, floor: plan.mana.floor,
                 practice: plan.practice, creatures: plan.creatures, floor_notes: plan.floor_notes?.length ? plan.floor_notes : undefined,
                 gates: plan.gates.map(x => `${x.school} L${x.level}->${x.target_level}${x.points_short != null ? ` (${x.points_short} short)` : ''}`) },
               `the drill toward ${plan.gated.map(r => r.name).join(', ') || 'the next school level'} differs from the one in force` +
               (plan.creatures === false ? ' (no creatures here: creature-target spells left out)' : ''));
          continue;
        }
        d.notes.push(`practice: ${g.why}`);
      }
    }

    // (d) SUPPLY the drill's reagents.
    const needs = plan?.ok ? reagentNeeds(plan, c) : [];
    let supplied = false;
    // A FULL PACK RECEIVES NOTHING: every source below would end in receiver_full. Make space in place first (the
    // keeper drops only its own sale-plan rows — make-space); when that has already been tried and failed, what is
    // left is a deposit of the shillings and gems filling it, which v1 proposes rather than walks.
    if (needs.length && o.pack_percent != null && o.pack_percent >= c.full_pct) {
      const g = gate('make_space', 'pack');
      if (allowed('make_space') && !g) {
        take({ kind: 'make_space', bulk: c.make_space_bulk, key: 'pack' },
             `pack at ${o.pack_percent}% cannot receive ${needs[0].item}: drop sale-plan items to make room`);
        continue;
      }
      d.proposals.push({ kind: 'deposit', executable: false, status: 'proposal', where: c.hall_room ?? 'a bank',
                         why: `pack at ${o.pack_percent}%${g ? ` and make-space did not help (${g.why})` : ''}: deposit shillings/gems before any supply` });
      d.notes.push(`receiver_full: pack at ${o.pack_percent}%`);
      needs.length = 0;
    }
    for (const need of needs) {
      const amount = Math.max(1, need.wanted - need.on_hand);
      // 1. A same-room fleet-mate with spare.
      if (allowed('supply') && !gate('supply', need.item)) {
        const donors = characters.filter(x => x.agent !== o.agent && inScope(x) && x.room === o.room && !touched.has(x.agent)
            && !decisions.some(y => y.agent === x.agent && y.action) && !isDead(x)
            && !(x.committed && !isTakeable(x.committed)))
          .map(x => ({ x, name: packName(x.pack, need.item), left: spareOf(x, need.key, need.item) }))
          .filter(r => r.name && r.left > 0).sort((a, b) => b.left - a.left || String(a.x.agent).localeCompare(String(b.x.agent)));
        if (donors.length) {
          const best = donors[0], give = Math.min(best.left, amount);
          spare.get(best.x.agent).set(need.key, best.left - give);
          touched.add(best.x.agent);
          take({ kind: 'supply', from: best.x.agent, from_character: best.x.character, item: best.name, amount: give,
                 keep: Math.max(0, onHand(best.x.pack, need.item) - best.left) },
               `${need.item} ${need.on_hand} on hand of ${need.wanted} wanted${need.blocking ? ' (blocking the drill)' : ''}; ${best.x.character ?? best.x.agent} has ${best.left} to spare here`);
          supplied = true; break;
        }
      }
      // 2. The guild hall's chests.
      const chest = hall[need.key];
      if (allowed('hall_draw') && c.hall_room != null && chest && chest.amount - c.hall_keep > 0 && !gate('hall_draw', need.item)) {
        const block = roadBlock(c.hall_room);
        if (!block) {
          const takeN = Math.min(amount, chest.amount - c.hall_keep);
          chest.amount -= takeN;
          take({ kind: 'hall_draw', item: chest.name, amount: takeN, hall: c.hall_room, home: c.home, road: true },
               `${need.item} short ${amount}; the hall chests hold ${chest.amount + takeN}`);
          supplied = true; break;
        }
        d.notes.push(`hall ${need.item}: ${block}`);
      }
      // 3. FARM the smallest creature that drops it.
      let farmProposal = null;
      if (allowed('farm') && data.spawns) {
        const src = farmSource(data.spawns, need.item, o, c);
        if (src.best) {
          const s = src.best;
          const approved = c.farm_allow.some(a => lc(a.creature) === lc(s.creature) && Number(a.room) === s.room && (!a.item || itemKey(a.item) === need.key));
          const block = !o.has_weapon ? 'unarmed' : roadBlock(s.room);
          const action = { kind: 'farm', item: need.item, amount: Math.min(amount, c.farm_count), creature: s.creature,
                           level: s.level, karma: s.karma, room: s.room, per_roll_percent: s.per_roll_percent,
                           minutes: c.farm_minutes, road: true };
          if (approved && !block && !gate('farm', need.item)) {
            take(action, `${need.item} short ${amount}; ${s.creature} (L${s.level}) in ${s.room} is the safest source, and it is allow-listed`);
            supplied = true; break;
          }
          farmProposal = { ...action, executable: false, status: 'proposal',
                           why: approved ? `allow-listed but ${block ?? 'cooling down'}` : 'not on the farm allow-list' };
          d.proposals.push(farmProposal);
        } else d.notes.push(`farm ${need.item}: ${src.why}`);
      }
      if (farmProposal && !c.buy_when_farm_unapproved) {
        take(farmProposal, `${need.item} short ${amount}: farm it (proposal — approve with farm_allow)`);
        supplied = true; break;
      }
      // 4. BUY at the cheapest reachable counter.
      if (allowed('buy') && !o.buy_reagents) d.notes.push(`buy ${need.item}: the loadout says buy_reagents false`);
      else if (allowed('buy') && data.sourcing && !gate('buy', need.item)) {
        const b = buySource(data.sourcing, need.item, c);
        if (b.best) {
          const cost = b.best.price != null ? b.best.price * amount : null;
          const money = o.purse + o.bank;
          const block = cost == null ? 'no price on record' : money < cost ? `cannot afford ${cost} (${money})` : roadBlock(b.best.room);
          if (!block) {
            const withdraw = o.purse >= cost ? 0 : Math.min(o.bank, cost - o.purse + c.buy_margin);
            take({ kind: 'buy', item: need.item, amount, merchant: b.best.merchant, room: b.best.room, price: b.best.price,
                   cost, approx: !!b.best.approx, withdraw, bank: withdraw > 0 ? bankRoomFor(o, c) : 0, home: c.home, road: true },
                 `${need.item} short ${amount}; nothing to draw on and no approved farm, so buy at ${b.best.merchant} (${b.best.room})`);
            supplied = true; break;
          }
          d.notes.push(`buy ${need.item}: ${block}`);
        } else d.notes.push(`buy ${need.item}: ${b.why}`);
      }
      if (farmProposal && !d.action) d.notes.push(`${need.item}: only a farm proposal is left`);
    }
    if (supplied) continue;

    // (e) TRAIN a weaponcraft skill short of points: a proposal.
    const skillGated = (o.learning.planned.active ?? []).filter(r => r.kind === 'skill' && num(r.remaining_required) > 0);
    if (skillGated.length && allowed('train') && data.spawns) {
      const q = trainingQuarry(data.spawns, o, c);
      const prop = { kind: 'train', skills: skillGated.map(r => r.name), points_short: Math.min(...skillGated.map(r => r.remaining_required)),
                     quarry: q.best?.creature ?? null, level: q.best?.level ?? null, room: q.best?.room ?? null,
                     executable: false, status: 'proposal', why: q.best ? null : q.why };
      take(prop, `${skillGated[0].name} needs ${prop.points_short} weaponcraft points: train on ${prop.quarry ?? 'nothing safe found'} (proposal)`);
      continue;
    }
    if (!d.why) d.why = d.notes.length ? 'nothing actionable this pass' : 'nothing to do: the plan has no gap this pass';
  }
  return { decisions, away: { now: awayNow, granted: awayGranted, limit: c.away_limit, home: c.home } };
}

/** A SAFE WEAPONCRAFT QUARRY: the highest-level huntable creature up to min(train_level_cap, band), karma allowed,
 *  in a reachable room no worse than the band. (A skill's improve chance rises with prey level to 45 and is flat
 *  in the character's own skill percent — m59-spawns.mjs THE THREE RULES.) */
export function trainingQuarry(spawns, o, c) {
  const ceiling = (o.hp_max ?? 0) * c.farm_band, cap = Math.min(ceiling, c.train_level_cap);
  const want = karmaWant(o), strict = !!o.policy?.karmaStrict;
  const out = [];
  for (const [room, list] of Object.entries(spawns?.rooms ?? {})) {
    const r = Number(room);
    if (DEAD_ROOMS.has(r) || !roomReachable(r, c).ok) continue;
    const hunt = (list ?? []).filter(g => g.huntable !== false);
    const worst = hunt.reduce((m, g) => Math.max(m, num(g.level) ?? 0), 0);
    if (!hunt.length || worst > ceiling) continue;
    for (const g of hunt) if (num(g.level) > 0 && g.level <= cap && farmKarmaOk(g.karma, want, strict))
      out.push({ creature: g.creature, level: g.level, karma: g.karma, room: r, room_worst: worst });
  }
  out.sort((a, b) => b.level - a.level || a.room_worst - b.room_worst || a.room - b.room);
  return { best: out[0] ?? null, why: out.length ? null : `no huntable creature at or under level ${cap} in a safe room` };
}

const proposalText = p => p.kind === 'farm' ? `farm ${p.item} off ${p.creature} in ${p.room}` : `${p.kind}: ${p.why ?? ''}`;

/** One line per decision, for the dry-run print. */
export function formatDecision(d) {
  const who = `${d.agent}${d.character ? ` (${d.character})` : ''}`;
  const a = d.action;
  if (!a) return `${who}: -- ${d.why}${d.proposals.length ? `  [proposals: ${d.proposals.map(proposalText).join('; ')}]` : ''}` +
    `${d.notes.length ? `  [${d.notes.join(' | ')}]` : ''}`;
  const tag = a.executable === false ? 'PROPOSE' : 'DO';
  const body = a.kind === 'learn' ? `learn ${a.skill} for ${a.price} at ${a.teacher?.name ?? '?'} (${a.room})`
    : a.kind === 'practice' ? `practice ${a.spells.slice(0, 4).join(' > ')}${a.spells.length > 4 ? ' ...' : ''} in ${a.rooms.join(',')}, floor ${a.floor}`
    : a.kind === 'make_space' ? `make-space bulk=${a.bulk}`
    : a.kind === 'supply' ? `supply ${a.amount} ${a.item} from ${a.from_character ?? a.from}`
    : a.kind === 'hall_draw' ? `hall-draw ${a.amount} ${a.item} from ${a.hall}`
    : a.kind === 'farm' ? `farm ${a.amount} ${a.item} off ${a.creature} (L${a.level}, karma ${a.karma}) in ${a.room}`
    : a.kind === 'buy' ? `buy ${a.amount} ${a.item} at ${a.merchant} (${a.room}) ~${a.cost}${a.withdraw ? `, withdraw ${a.withdraw} at ${a.bank}` : ''}`
    : a.kind === 'train' ? `train ${a.skills.join(', ')} on ${a.quarry ?? '?'}${a.room ? ` in ${a.room}` : ''}`
    : a.kind;
  return `${who}: ${tag} ${body} -- ${d.why}` +
    (d.proposals.length && a.kind !== 'farm' ? `  [proposals: ${d.proposals.map(proposalText).join('; ')}]` : '') +
    (d.notes.length ? `  [${d.notes.join(' | ')}]` : '');
}
