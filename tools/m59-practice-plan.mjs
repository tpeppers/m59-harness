// PRACTISE TOWARD THE NEXT SCHOOL LEVEL, ON SPARE MANA, WHILE FARMING — the decision half.
//
// Operator, 2026-10-22: "practice while farming ... for their newest/highest level along their
// trainings. Ideally we can get some more people to level 3/4 in Shal'ille and level 3/4 in
// Kraanan soon." Then: "make gate-practice into something more robust/general. It should read
// skills out of the planner, categorize the skills (personal enchants, reagents required, etc.),
// autorequest/deliver the reagents, etc. We want it as a re-usable FleetScript."
//
// The prototype was two scratch scripts on the prod deploy (gate-practice.mjs, which reordered an
// existing list, and bard/ukgoth-practice.mjs, which built the lists). This is both of them as one
// pure function, pinned offline by m59-practice-plan-test.mjs; tools/fleetscripts/practice-plan.mjs
// applies it. Nothing here opens a socket or reads a roster.
//
// THE LEVER IS ORDER. Practice casts the FIRST listed spell it can afford
// (m59-deskpractice.mjs choosePractice), so the head of the list is what gets drilled, and a
// spell short of mana, a reagent or vigor falls through to the next.
//
// THE GATE. PlayerCanLearn (player.kod:10630; compendium/tools/learn.mjs) lets a character learn
// level L+1 of a school when the sum of its best THREE abilities at level L reaches a threshold.
// So for each school, the spells that move the next level are the best three at the character's
// highest known level, and the weakest of those is where a practice cast buys the most. They go to
// the head, weakest first; the planner's own `remaining_required` says how far is left. A school
// the planner (substrate/loadouts/<character>.json `plan`, via the broker's learningView) has
// queued spells in comes before one it has not, and among equals the gate closest to opening
// leads -- more characters across a level, not everyone a little nearer a far one.
//
// THE CATEGORIES, AND WHY EACH IS THERE:
//
//   self       cast on the caster: personal enchantments, resistances, touch attacks, heals.
//   none       cast with no target (holy touch).
//   creature   needs a monster to aim at, named by `on` (hold, dazzle, enfeeble, the curses).
//              Without a quarry to name it is not drillable -- "any monster" picks whatever is
//              nearest, which in a mixed room is not what anybody asked for.
//   fleetmate  relay: moves the CASTER's own vigor to a fleet-mate (relay.kod:121-151), so it is
//              only cast with `min_vigor` to spare. RESTING STOPS AT 80 VIGOR -- anything above it
//              must be EATEN -- so a min_vigor over 80 is a blocker the moment the larder is empty,
//              and relay's reagent (the Snack, an edible mushroom) is itself food.
//   never      practice would do harm or nothing: teleports (blink, rescue) move the farmer off its
//              farm, summons fill the room or the pack, area spells (poison fog, mana bomb,
//              darkness, defile) touch our own characters, fade/invisibility hides a fighter,
//              enchant weapon's mana is the dedications' (and its knowers keep a 17 floor), create
//              food is disabled fleet-wide, hospice is the keeper's own heal ladder, identify and
//              mend need an item. A HARD never is dropped even if somebody listed it; a soft one
//              already on a hand-made list is kept, because somebody chose it.
//   unknown    a spell with no proven practice target and no safe kod parent: left out, said so.
//
// THE BLOCKERS THAT STOP PRACTICE SILENTLY, each said out loud because each reads as "idle":
//   reserve_leaves_no_room   max mana less the floor/reserve is under the cheapest listed spell
//   never_affordable         one spell costs more than max mana less the floor
//   karma                    a spell whose karma requirement is not met is refused by the
//                            server with no mana spent (Qor L2 -20, L3 -30, L4 -40 per the kod)
//   min_vigor_above_rest_cap / vigor_short_now / reagent_is_food   the relay traps above
//   reagent_short            a listed spell cannot fire for want of a reagent, right now
//   not_known                a listed spell this character does not know (dropped)
//
// THE REAGENT NEED. Per reagent: what one cast takes, what is on hand, what is kept back (the
// practice `keep` map and any desk reserve), what stock N casts want, and the shortfall. The
// fleetscript turns shortfalls into standing courier requests (courierRequestPlan below).
import { loadCatalogue, spellCost, catalogueEntry, normalizePractice, deskReserve,
         offeredServices } from './m59-deskpractice.mjs';
import { otherCastingFloor } from './m59-farmpractice.mjs';

export const MAXED = 99;
export const TOP_LEVEL = 6;
// Resting climbs vigor to 80 and no further (the rest of the 200 is eaten). See the header.
export const REST_VIGOR_CAP = 80;
// Enchant weapon costs 17 (enchwp.kod); its knowers keep that much for the dedications.
export const ENCHANT_FLOOR = 17;
export const DEFAULT_RELAY_MIN_VIGOR = 110;

// Letters and digits only: "Shal’ille" (curly, as the wire sends it), "Shal'ille" and "shalille"
// are one school, and "kara'hol's curse" is the catalogue's "karahols curse".
export const nameKey = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export const schoolKey = nameKey;
// Pack and courier names: plural and spacing folded ("orctooth" / "orc tooth" / "orc teeth").
export const itemKey = s => nameKey(s).replace(/teeth$/, 'tooth').replace(/ies$/, 'y').replace(/(es|s)$/, '');

const set = (...names) => new Set(names.map(nameKey));
// Field-proven targets, from the 2026-10-21 Ukgoth posture (bard/ukgoth-practice.mjs).
export const SELF_SPELLS = set('bless', 'super strength', 'haste', 'resist poison', 'resist acid', 'glow', 'light',
  'free action', 'shroud', 'night vision', 'eagle eyes', 'magic shield', 'cloak', 'unholy weapon', 'holy weapon',
  'detect good', 'detect evil', 'holy symbol', 'dispel illusion', 'seance', 'minor heal', 'breath of life',
  'remove curse', 'cure poison', 'cure disease');
export const NONE_SPELLS = set('holy touch');
export const CREATURE_SPELLS = set('hold', 'enfeeble', "kara'hol's curse", 'vampiric drain', 'splash of acid', 'zap', 'dazzle');
export const FLEETMATE_SPELLS = set('relay');
// Parents whose spells are safe to cast on the caster when nothing above names them.
const SELF_PARENTS = new Set(['PersonalEnchantment', 'ResistanceEnchantment', 'TouchAttackSpell']);

const never = (why, hard = false) => ({ why, hard });
export const NEVER_DRILL = Object.freeze(Object.fromEntries(Object.entries({
  blink: never('teleports the caster off its farm', true),
  rescue: never('teleports the caster off its farm', true),
  elusion: never('teleports the caster off its farm', true),
  'create food': never('disabled fleet-wide', true),
  animate: never('summons a monster into the room'),
  'create weapon': never('summons a weapon into the pack'),
  'summon cow': never('summons a creature'),
  'poison fog': never('an area spell that touches our own characters'),
  'mana bomb': never('an area spell that touches our own characters'),
  darkness: never('an area spell that touches our own characters'),
  defile: never('an area spell that touches our own characters'),
  silence: never('an area spell that touches our own characters'),
  fade: never('hides the fighter (invisibility)'),
  invisibility: never('hides the fighter (invisibility)'),
  'enchant weapon': never('its mana is kept for dedications'),
  hospice: never("the keeper's own heal ladder casts it"),
  identify: never('needs an item to cast on'),
  mend: never('needs an item to cast on'),
  'forces of light': never('a desk service, practised at the desk'),
}).map(([k, v]) => [nameKey(k), Object.freeze(v)])));

const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const entryName = e => String(typeof e === 'string' ? e : e?.name ?? '').trim().toLowerCase();

/** Does `karma` satisfy a spell's kod `required_karma`? null when karma is unread. */
export function karmaAllows(required, karma) {
  const rk = Number(required) || 0;
  if (!rk) return true;
  if (num(karma) == null) return null;
  return rk < 0 ? Number(karma) <= rk : Number(karma) >= rk;
}

/**
 * How one known spell would be practised. Pure.
 * @returns { target: 'self'|'none'|'creature'|'fleetmate'|null, drillable, why, hard? }
 */
export function categorise(spell, { catalogue = loadCatalogue(), quarry = [] } = {}) {
  const k = nameKey(spell?.name);
  const kod = catalogueEntry(spell?.name, catalogue);
  const no = NEVER_DRILL[k];
  if (no) return { target: null, drillable: false, kind: 'never', why: no.why, hard: no.hard };
  if (FLEETMATE_SPELLS.has(k)) return { target: 'fleetmate', drillable: true, kind: 'fleetmate', why: 'gives vigor to a fleet-mate' };
  if (NONE_SPELLS.has(k)) return { target: 'none', drillable: true, kind: 'none', why: 'cast with no target' };
  if (CREATURE_SPELLS.has(k)) return quarry.length
    ? { target: 'creature', drillable: true, kind: 'creature', why: `cast on ${quarry.join('/')}` }
    : { target: 'creature', drillable: false, kind: 'creature', why: 'needs a creature to aim at, and no quarry is named' };
  if (SELF_SPELLS.has(k)) return { target: 'self', drillable: true, kind: 'self', why: 'cast on the caster' };
  if (kod && SELF_PARENTS.has(kod.parent) && !kod.harmful)
    return { target: 'self', drillable: true, kind: 'self', why: `a ${kod.parent}, cast on the caster` };
  return { target: null, drillable: false, kind: 'unknown',
           why: kod ? `no proven practice target (a ${kod.parent}${kod.harmful ? ', harmful' : ''})` : 'not in the kod spell catalogue' };
}

/**
 * The practice plan for one character. Pure: everything is passed in.
 *
 * @param known      the abilities tool's spells: [{ name, school, level?, ability }]
 * @param planner    the fleet row's `learning` ({ progress, planned: { abilities: [...] } }), or null
 * @param pack       [{ name, amount }] -- the inventory tool's items
 * @param maxMana    max mana
 * @param vigor      current vigor (for the relay check), or null
 * @param karma      current karma, or null
 * @param policy     the autopilot policy (practiceSpells, buffAllies, touchSpell, assignedRoom,
 *                   confineRooms, hunt, chalice)
 * @param options    { schools, quarry, rooms, floor, gapMs, stockCasts, restCasts, relayMinVigor,
 *                     enchantFloor, isFood }
 */
export function planPractice({ known = [], planner = null, pack = [], maxMana = null, vigor = null, karma = null,
                               policy = {}, options = {}, catalogue = loadCatalogue() } = {}) {
  const o = { stockCasts: 20, restCasts: 5, relayMinVigor: DEFAULT_RELAY_MIN_VIGOR, enchantFloor: ENCHANT_FLOOR,
              gapMs: null, isFood: n => itemKey(n) === itemKey('edible mushroom'), ...options };
  const report = [], blockers = [];
  const block = (kind, why, extra = {}) => { blockers.push({ kind, why, ...extra }); };
  const current = policy?.practiceSpells ?? null;
  const listed = new Map((current?.spells ?? []).map(e => [nameKey(entryName(e)), e]));

  // QUARRY for creature spells: named, else what the current list already aims at, else the hunt.
  const hunt = [].concat(policy?.hunt ?? []).map(String).filter(Boolean);
  const listedOn = [...listed.values()].flatMap(e => (typeof e === 'object' && e?.target === 'creature') ? [].concat(e.on ?? []) : []);
  const quarry = [...new Set((o.quarry?.length ? o.quarry : listedOn.length ? listedOn : hunt)
    .map(x => String(x).trim().toLowerCase()).filter(Boolean))];

  // THE SPELLS, joined to the catalogue and categorised.
  const spells = known.filter(s => s?.name).map(s => {
    const kod = catalogueEntry(s.name, catalogue);
    const cost = spellCost(s.name, catalogue);
    const cat = categorise(s, { catalogue, quarry });
    const ability = Number(s.ability) || 0;
    const row = { name: String(s.name).toLowerCase(), school: s.school ?? kod?.school_name ?? null,
                  school_key: schoolKey(s.school ?? kod?.school_name), level: num(s.level) ?? num(kod?.level),
                  ability, mana: cost?.mana ?? num(s.mana), reagents: cost?.reagents ?? [],
                  required_karma: Number(kod?.required_karma) || 0, ...cat };
    const k = nameKey(row.name);
    if (listed.has(k)) row.listed = true;
    // A SOFT never or an unknown that somebody already put on the list stays: they chose it.
    if (!row.drillable && row.listed && !row.hard && row.kind !== 'creature') {
      row.drillable = true; row.kept = true; row.why = `kept as listed (${row.why})`;
      row.target = typeof listed.get(k) === 'object' ? listed.get(k).target ?? null : null;
    }
    if (ability >= MAXED) { row.drillable = false; row.maxed = true; row.why = `at ${ability}, nothing left to learn`; }
    const kok = karmaAllows(row.required_karma, karma);
    if (row.drillable && kok === false) {
      row.drillable = false; row.karma_blocked = true;
      row.why = `karma ${karma} does not meet ${row.required_karma} -- the server refuses it with no mana spent`;
      block('karma', `${row.name}: ${row.why}`, { spell: row.name });
    }
    if (row.drillable && !cost) { row.drillable = false; row.why = 'no cost in the spell catalogue'; }
    return row;
  });
  const byKey = new Map(spells.map(s => [nameKey(s.name), s]));
  for (const [k, e] of listed) if (!byKey.has(k)) {
    report.push(`${entryName(e)}: listed but not known, dropped`);
    block('not_known', `${entryName(e)} is on the practice list and this character does not know it`, { spell: entryName(e) });
  }

  // THE GATES, one per school with something to gain.
  const plannedRows = (planner?.planned?.abilities ?? []).filter(r => r && r.kind !== 'skill');
  const wantSchools = o.schools?.length ? new Set(o.schools.map(schoolKey)) : null;
  const gates = [];
  for (const sk of [...new Set(spells.map(s => s.school_key).filter(Boolean))]) {
    if (wantSchools && !wantSchools.has(sk)) continue;
    const mine = spells.filter(s => s.school_key === sk && s.level != null);
    if (!mine.length) continue;
    const L = Math.max(...mine.map(s => s.level));
    if (!(L >= 1) || L >= TOP_LEVEL) continue;
    const atL = mine.filter(s => s.level === L).sort((a, b) => b.ability - a.ability);
    const top = atL.slice(0, 3);
    const planned = plannedRows.filter(r => {
      const kod = catalogueEntry(r.name, catalogue);
      return schoolKey(r.school ?? kod?.school_name) === sk && Number(r.level ?? kod?.level) === L + 1;
    });
    const shorts = planned.map(r => num(r.remaining_required)).filter(v => v != null);
    let pointsShort = shorts.length ? Math.min(...shorts) : null;
    const prog = planner?.progress;
    if (pointsShort == null && prog && schoolKey(prog.target) === sk && Number(prog.next_level) === L + 1)
      pointsShort = num(prog.points);
    const drill = top.filter(s => s.drillable).sort((a, b) => a.ability - b.ability);
    // A best-three member that cannot be drilled (enchant weapon, identify) can be OVERTAKEN: the
    // nearest drillable spell at the same level counts the day it passes it. Only worth it once
    // nothing drillable is left in the best three -- until then the weakest of those buys more.
    const stuck = top.filter(s => !s.drillable && !s.maxed);
    const bench = !drill.length && stuck.length ? atL.slice(3).filter(s => s.drillable) : [];
    const school = mine[0].school;
    gates.push({ school, school_key: sk, level: L, target_level: L + 1,
                 best_three: top.map(s => ({ name: s.name, ability: s.ability, drillable: s.drillable })),
                 have: top.reduce((t, s) => t + s.ability, 0), points_short: pointsShort,
                 planned: planned.length > 0, planned_spells: planned.map(r => r.name),
                 drill: drill.map(s => s.name), bench: bench.map(s => s.name),
                 note: !drill.length && !bench.length ? (top.every(s => s.maxed) ? 'best three are maxed' : 'nothing at this level can be drilled') : undefined });
    report.push(`${school} L${L}->${L + 1}: best three ${top.map(s => `${s.name} ${s.ability}${s.drillable ? '' : '*'}`).join(', ')}` +
                (pointsShort != null ? `; ${pointsShort} short (planner)` : '') + (planned.length ? '; planned' : ''));
  }

  // THE ORDER: gate spells first -- a planned school before an unplanned one, then the gate
  // CLOSEST to opening (fewest points short; unknown last, already-open last of all, since only a
  // purchase moves that one), each gate weakest first; then the bench; then everything else
  // drillable, weakest first. Closest first is the operator's aim in one rule: more characters
  // across the next level, rather than everybody a little nearer to a far one.
  const gateRank = new Map();
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  for (const g of gates) for (const n of g.drill) {
    const s = byKey.get(nameKey(n));
    const r = [g.planned ? 0 : 1, g.points_short === 0 ? 1 : 0, g.points_short ?? 1e9, s.ability];
    const was = gateRank.get(n);
    if (!was || cmp(r, was) < 0) gateRank.set(n, r);
  }
  const head = [...gateRank.entries()].sort(([, a], [, b]) => cmp(a, b)).map(([n]) => n);
  const benchNames = [...new Set(gates.flatMap(g => g.bench))].filter(n => !gateRank.has(n));
  const inHead = new Set([...head, ...benchNames]);
  const rest = spells.filter(s => s.drillable && !inHead.has(s.name)).sort((a, b) => a.ability - b.ability).map(s => s.name);
  const order = [...head, ...benchNames, ...rest];
  for (const s of spells) s.role = gateRank.has(s.name) ? 'gate' : benchNames.includes(s.name) ? 'bench' : s.drillable ? 'rest' : null;

  // THE ENTRIES: a listed entry is reused as written (its `on`, `fresh`, `room`, `min_vigor`).
  const entries = order.map(n => {
    const s = byKey.get(nameKey(n)), was = listed.get(nameKey(n));
    if (was && typeof was === 'object') return { ...was, name: was.name ?? n };
    if (was) return { name: n, ...(s.target ? { target: s.target } : {}) };
    if (s.target === 'fleetmate') return { name: n, target: 'fleetmate', min_vigor: o.relayMinVigor };
    if (s.target === 'creature') return { name: n, target: 'creature', on: quarry };
    return s.target ? { name: n, target: s.target } : { name: n };
  });

  // THE FLOOR: what the other casting needs, the floor already set (or the one given), and
  // enchant weapon's 17 for anybody who knows it.
  const knowsEnchant = spells.some(s => nameKey(s.name) === nameKey('enchant weapon'));
  const other = otherCastingFloor({ policy, known, catalogue });
  const given = num(o.floor);
  const kept = num(current?.mana_floor ?? current?.manaFloor) ?? 0;
  const manaFloor = Math.max(other.floor, given ?? kept, knowsEnchant ? o.enchantFloor : 0);
  const floorWhy = [other.needs.length ? other.needs.map(([w, f]) => `${w} needs ${f}`).join('; ') : null,
               given != null ? `floor ${given} given` : kept ? `floor ${kept} already set` : null,
               knowsEnchant ? `knows enchant weapon (${o.enchantFloor})` : null].filter(Boolean).join('; ') || 'nothing else casts';

  // THE ROOMS: given, else the ones practice already uses, else where it farms.
  const roomsFrom = o.rooms?.length ? o.rooms : current?.rooms?.length ? current.rooms
    : [policy?.assignedRoom, ...(policy?.confineRooms ?? [])];
  const rooms = [...new Set((roomsFrom ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0))];

  const practice = { enabled: true, rooms, spells: entries, mana_floor: manaFloor };
  for (const k of ['reserve_casts', 'reserve_services', 'refused_ms', 'rest_seconds', 'keep'])
    if (current?.[k] !== undefined) practice[k] = current[k];
  const gap = num(o.gapMs) ?? num(current?.gap_ms ?? current?.gapMs);
  if (gap != null) practice.gap_ms = gap;

  // THE RESERVE THE KEEPER WILL ACTUALLY HONOUR: the floor, or a desk's service reserve if larger.
  const norm = normalizePractice(practice);
  const services = offeredServices(policy?.chalice);
  const reserve = deskReserve({ practice: norm ?? practice, services, known: known.map(s => String(s.name).toLowerCase()),
                                keep: norm?.keep ?? {}, catalogue });
  const max = num(maxMana);
  const listedSpells = order.map(n => byKey.get(nameKey(n)));
  if (max != null && listedSpells.length) {
    const room = max - reserve.mana;
    const cheapest = Math.min(...listedSpells.map(s => s.mana ?? Infinity));
    if (cheapest > room)
      block('reserve_leaves_no_room', `max mana ${max} less the ${reserve.mana} reserve (${reserve.why}) leaves ${room}, ` +
            `and the cheapest listed spell costs ${cheapest} -- nothing can ever be practised`, { severity: 'stops' });
    else for (const s of listedSpells) if ((s.mana ?? 0) > room)
      block('never_affordable', `${s.name} costs ${s.mana} and max mana ${max} less the ${reserve.mana} reserve leaves ${room}`,
            { spell: s.name });
  }

  // THE RELAY TRAPS.
  for (const e of entries.filter(e => e.target === 'fleetmate')) {
    const mv = num(e.min_vigor) ?? 150;
    if (mv > REST_VIGOR_CAP)
      block('min_vigor_above_rest_cap', `${e.name} needs ${mv} vigor to spare, and resting stops at ${REST_VIGOR_CAP}: ` +
            'it fires only after eating, so a character with an empty larder never drills it', { spell: e.name });
    if (num(vigor) != null && Number(vigor) < mv)
      block('vigor_short_now', `${e.name}: vigor ${vigor} is under the ${mv} it may give from`, { spell: e.name });
    for (const [item] of byKey.get(nameKey(e.name))?.reagents ?? [])
      if (o.isFood(item)) block('reagent_is_food', `${e.name} spends ${item}, which is food: eating to climb past ` +
                                `${REST_VIGOR_CAP} vigor eats the reagent, and a food keep list holds it back from sale and supply`, { spell: e.name });
  }

  // THE REAGENT NEED.
  const onHand = new Map();
  for (const it of pack ?? []) { const k = itemKey(it?.name); if (k) onHand.set(k, (onHand.get(k) ?? 0) + (Number(it.amount) || 1)); }
  // reserve.reagents already holds the practice `keep` map (passed in above) plus any desk's reserve.
  const keepOf = k => Object.entries(reserve.reagents ?? {}).filter(([n]) => itemKey(n) === k).reduce((t, [, v]) => t + Number(v), 0);
  const needs = new Map();
  for (const s of listedSpells) {
    const casts = s.role === 'gate' || s.role === 'bench' ? o.stockCasts : o.restCasts;
    for (const [item, n] of s.reagents) {
      const k = itemKey(item);
      const r = needs.get(k) ?? { item, key: k, per_cast: 0, on_hand: onHand.get(k) ?? 0, kept: keepOf(k), wanted: 0, spells: [] };
      r.per_cast = Math.max(r.per_cast, n);
      r.wanted += n * casts;
      r.spells.push({ name: s.name, per_cast: n, casts, role: s.role });
      needs.set(k, r);
    }
  }
  const reagents = [...needs.values()].map(r => {
    r.wanted += r.kept;
    r.shortfall = Math.max(0, r.wanted - r.on_hand);
    r.blocks = r.spells.filter(x => r.on_hand - r.kept < x.per_cast).map(x => x.name);
    for (const sp of r.blocks)
      block('reagent_short', `${sp}: needs ${r.spells.find(x => x.name === sp).per_cast} ${r.item}, ${r.on_hand} on hand` +
            (r.kept ? `, ${r.kept} kept` : '') + ' -- skipped until carried', { spell: sp, item: r.item });
    return r;
  }).sort((a, b) => b.shortfall - a.shortfall || a.item.localeCompare(b.item));

  for (const s of spells.filter(s => !s.drillable)) report.push(`${s.name}: ${s.why}`);
  report.push(`order ${order.join(' > ') || '(none)'}; floor ${manaFloor} (${floorWhy})`);

  const fail = why => ({ ok: false, why, gates, spells, reagents, blockers, report, order,
                         mana: { max, floor: manaFloor, reserve: reserve.mana, why: floorWhy } });
  if (!order.length) return fail('no spell this character knows can be drilled');
  if (!rooms.length) return fail('no room to practise in: none given, none on the current list, and no assigned room or confinement');
  if (norm?.problems?.length) return fail(`the practice config would be refused: ${norm.problems.join('; ')}`);
  return { ok: true, practice, order, gates, spells, reagents, blockers, report,
           mana: { max, floor: manaFloor, reserve: reserve.mana, why: floorWhy } };
}

/**
 * STANDING COURIER REQUESTS for a plan's shortfalls, in the shape the courier lap already reads:
 * substrate/courier-requests.json = { agent: { "<SHOPPING item>": <count to top up to> } }, and
 * substrate/courier-wishlist.json for anything the lap has no shopping line for (tools/plans/courier.mjs).
 * A request is NEVER LOWERED: an operator's herb 140 stays 140 when practice wants 40.
 *
 * @param shopping  the lap's SHOPPING lines ({ item }), from tools/plans/courier.mjs lapState
 * @param existing  the current courier-requests.json
 * @returns { requests: [{ item, count, was, change }], wishes: [{ item, count }] }
 */
export function courierRequestPlan({ agent, reagents = [], shopping = [], existing = {} } = {}) {
  const lines = new Map(shopping.map(s => [itemKey(s.item), s.item]));
  const mine = existing?.[agent] ?? {};
  const requests = [], wishes = [];
  for (const r of reagents) {
    if (!(r.shortfall > 0)) continue;
    const line = lines.get(r.key ?? itemKey(r.item));
    if (!line) { wishes.push({ item: r.item, count: r.wanted, shortfall: r.shortfall }); continue; }
    const wasKey = Object.keys(mine).find(k => itemKey(k) === itemKey(line));
    const was = wasKey == null ? null : Number(mine[wasKey]) || 0;
    const count = Math.max(was ?? 0, r.wanted);
    requests.push({ item: line, count, was, shortfall: r.shortfall,
                    change: was == null ? 'new' : count > was ? 'raise' : 'keep' });
  }
  return { requests, wishes };
}

/** Apply a courierRequestPlan to the two files' contents. Pure: returns the new objects. */
export function mergeCourierRequests({ agent, plan, requests = {}, wishlist = {}, at = Date.now(), by = 'practice-plan' }) {
  const r = JSON.parse(JSON.stringify(requests ?? {})), w = JSON.parse(JSON.stringify(wishlist ?? {}));
  for (const q of plan.requests) if (q.change !== 'keep') (r[agent] ??= {})[q.item] = q.count;
  for (const q of plan.wishes) {
    const was = w[agent]?.[q.item]?.count ?? 0;
    if (q.count > was) (w[agent] ??= {})[q.item] = { count: q.count, at, by };
  }
  return { requests: r, wishlist: w };
}
