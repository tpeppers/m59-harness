// CAST ONE PRACTICE SPELL, HERE, NOW — AND RETURN. The unit a host loop calls between other work.
//
//   import { practiceOnce, SHALILLE_DRILL } from './m59-practice-once.mjs';
//   const r = await practiceOnce({ call, agent: 't3' });    // { cast, spell, outcome, why, retryInMs }
//
// Operator, 2026-09-27, on the guild-hall vault brokers: "Both people managing the service desk are
// idly able to use their mana for disciple training, it restricts their movement, inventory, etc.,
// but requires no mana and both have guild chest access the whole time." So the DESK is the outer
// loop — it owns where the character stands and what its pack holds — and practice owns only the
// mana: one cast whenever no customer is waiting, never a walk, never a wait longer than one cast.
//
// WHAT IT DOES, IN ORDER, AND WHAT IT NEVER DOES:
//   * reads the pack, mana, vigor and the practice spells' abilities (one read each);
//   * eats on a CLOCK, not on a threshold — see FOOD below: the first food of `foods` it carries,
//     whenever the modelled stomach has room for it and the vigor would not overshoot 200;
//   * picks ONE spell: among those it has the reagent and the mana for, the LOWEST ability — the
//     gate sums the best three at a level and a low ability improves fastest — except that below
//     `thriftBelow` vigor it picks the CHEAPEST IN VIGOR, because then vigor is the bottleneck;
//   * stands (a seated character cannot cast, silently), casts, and judges the outcome by the
//     REAGENT: consumed = the spell ran; a failed roll consumes none and cannot improve anything
//     (spell.kod:1255); refused = the broker or the server said no;
//   * DOES NOT RETURN UNTIL THE CAST HAS RESOLVED — succeeded or fizzled — so nothing the host does
//     next (a move, a sit, a hand-over, another cast) can break the concentration. See TRANCE below;
//   * records a `cast` in the training ledger (m59-training-ledger.mjs) when given one;
//   * returns. It never walks, never rests, never waits for mana: when nothing is castable it says
//     why and how long until it probably is (`retryInMs`), and the host decides.
//
// TARGETS, measured 2026-09-26/27 on prod: holy symbol takes none; detect evil takes ONE — the
// caster — and a caster's own NAME does not resolve while `target: "me"` hits a stranger, so it is
// aimed at the caster's numeric object id, read fresh from /health (ids renumber every save).
// Detect evil is a personal enchantment: re-cast while it is still up, the server takes nothing and
// says little, which reads here as `unknown` rather than as a fizzle.

// TRANCE (operator, 2026-09-27: "shouldn't return before the spell is successfully cast or fizzles,
// so that outside methods don't accidentally break concentrations"). The ORDER in the kod is what
// makes this subtle: UserCast pays the costs FIRST (user.kod:4822 PayCosts — mana AND reagent, or
// "You were unsuccessful in casting %s" with no trance at all) and only THEN begins the trance
// (user.kod:4825). So a reagent that has left the pack means the trance has STARTED, not ended —
// the old check read it 2.5 s after the reply and called that success in the middle of detect
// evil's charge. The trance lasts viCast_time * (150 - spellpower) / 100 (spell.kod:1883-1901),
// at most 1.49x the cast time, and any run, rest, use or second cast inside it breaks it with
// "Your concentration is broken and the %s spell fizzles." So after a cast that got past PayCosts
// this waits until that break is heard OR the longest possible trance has elapsed since the cast
// was sent, and only then reads the pack and returns.
export const TRANCE_MARGIN_MS = 1500;
// A cast time of 0 is a spell with NO trance (spell.kod:1892: viCast_time = 0 returns 0) — darkness,
// for one — and must not be read as "unknown": that turned every darkness into a 15 s wait.
export const maxTranceMs = castMs => Math.ceil((castMs == null || !Number.isFinite(Number(castMs)) ? 15_000 : Number(castMs)) * 1.49)
  + TRANCE_MARGIN_MS;

// FOOD, AND WHY IT IS ON A CLOCK (operator, 2026-09-28: "Set the guildhall deskers to eat other food,
// not inky-caps. Bread or cheese ... they should be able to still reach 200 vigor by constantly eating
// the given foodstuff as hunger re-builds up again (can basically be timed/calculated ...)"). All of
// it is deterministic, player.kod:
//   * eating adds the food's nutrition to vigor at once (EatSomething :5734, exertion -10000*n),
//     clamped at viMax_vigor 200 (:740, NewVigor :1217) — so a bite that overshoots is wasted;
//   * and its FILLING to a stomach that refuses past 100 (ReqEatSomething :5703);
//   * the stomach empties at FOOD_USE_RATE 12 hundredths a second (:51, UpdateStomach :1347) —
//     833 s from full to empty, no randomness.
// So the most vigor a stomach can deliver is 0.12 * nutrition/filling a second: inky cap 14.4 a
// minute, cheese and turkey leg 5.4, meat pie 4.3, bread 3.6, pork 3.2. Eating is therefore a CLOCK:
// eat as soon as the modelled stomach has room, and never let a bite overshoot 200.
//
// WHAT CASTING COSTS IN VIGOR: viSpellExertion (spell.kod:1283, half on a failed roll :1166) — holy
// symbol 15 (holysymb.kod:47), detect evil 5 (detevil.kod:50). Mana regenerates in proportion to
// vigor (CalculateManaTime :5650): at 27 max mana and 30 mysticism, 11.2 mana a minute at 200 vigor.
// Alternating the two spells burns ~12.4 vigor a minute at 200 — more than bread or cheese can
// supply — so on ordinary food the steady state is ~58 (bread) or ~87 (cheese). Casting mostly the
// CHEAP spell burns ~5.6 at 200, which cheese very nearly holds. Hence `thriftBelow`.
export const FOOD = Object.freeze({
  'inky-cap mushroom': { nutrition: 50, filling: 25 },   // inkycap.kod
  'wheel of cheese': { nutrition: 30, filling: 40 },     // cheese.kod
  'turkey leg': { nutrition: 15, filling: 20 },          // turkyleg.kod
  'meat pie': { nutrition: 30, filling: 50 },            // meatpie.kod
  'bowl of stew': { nutrition: 15, filling: 25 },        // stew.kod
  'loaf of bread': { nutrition: 20, filling: 40 },       // bread.kod
  'slice of pork': { nutrition: 9, filling: 20 },        // pork.kod
});
// Best vigor per unit of stomach first. Inky caps are NOT on the default list: they are the fleet's
// scarce food (the chests held 2 on 2026-09-28) and a desk can run on bread.
export const DEFAULT_FOODS = Object.freeze(['wheel of cheese', 'turkey leg', 'meat pie', 'loaf of bread', 'slice of pork']);
export const VIGOR_MAX = 200;
export const STOMACH_EMPTY_PER_S = 0.12;

// THE STOMACH, MODELLED. The server does not send it, so it is integrated from what we ate: +filling
// per bite, -0.12 a second, starting empty. A bite that does not raise vigor was refused as too full,
// and resets the model to full — the only correction it ever needs.
export class Stomach {
  constructor(now = Date.now()) { this.level = 0; this.at = now; }
  current(now = Date.now()) { return Math.max(0, this.level - (now - this.at) / 1000 * STOMACH_EMPTY_PER_S); }
  ate(filling, now = Date.now()) { this.level = Math.min(100, this.current(now) + filling); this.at = now; }
  full(now = Date.now()) { this.level = 100; this.at = now; }
  /** Seconds until `filling` fits. */
  waitFor(filling, now = Date.now()) { return Math.max(0, (this.current(now) + filling - 100) / STOMACH_EMPTY_PER_S); }
}

const packHas = (pack, name) => (pack ?? []).some(i => String(i.name ?? '').toLowerCase() === name.toLowerCase());

/** Which food to eat now, if any. Pure: the first food of `foods` carried, if it fits and does not overshoot. */
export function chooseFood({ pack, vigor, stomach, foods = DEFAULT_FOODS, now = Date.now() }) {
  if (!Number.isFinite(vigor)) return { food: null, why: 'vigor unread' };
  const carried = foods.filter(n => FOOD[n.toLowerCase()] && packHas(pack, n));
  if (!carried.length) return { food: null, why: `carrying none of ${foods.join(', ')}`, restock: true };
  const name = carried[0], f = FOOD[name.toLowerCase()];
  if (vigor + f.nutrition > VIGOR_MAX) return { food: null, why: `${name} would overshoot ${VIGOR_MAX} (vigor ${vigor})` };
  const wait = stomach.waitFor(f.filling, now);
  if (wait > 0) return { food: null, why: `stomach full for ${Math.ceil(wait)} s more`, waitS: wait };
  return { food: name, ...f };
}

// A PRACTICE TABLE is data: spell, reagent (as the pack names it) and how many a cast takes, mana,
// and whether it targets the caster. The Shal'ille level-1 drill, read off the kod and the server:
export const SHALILLE_DRILL = Object.freeze([
  { spell: 'holy symbol', reagent: /^elderberry$/i, per: 3, mana: 8, vigor: 15, self: false, castMs: 2000, school: "Shal'ille" },  // holysymb.kod:47,49,61
  { spell: 'detect evil', reagent: /^fairy wing$/i, per: 1, mana: 10, vigor: 5, self: true, castMs: 3000, school: "Shal'ille" },   // persench/detevil.kod:50,52,66
]);

// THE QOR LEVEL-1 DRILL (operator, 2026-09-28: the Qor masters "stand there and spam-cast their
// spells ... running a variant of the other casters"). Read off the kod: darkness costs a fairy wing
// AND an entroot berry (roomench/darkness.kod:58-59, mana 8, no trance, default exertion 2); detect
// good a fairy wing (persench/detgood.kod:49-66, mana 10, exertion 5, 3 s); cloak two entroot berries
// (persench/cloak.kod:46-59, mana 5, 2 s). The two personal enchantments target the caster (by object
// id, like detect evil); darkness targets the room. Every cast is karma-checked (spell.kod:456-498):
// a Qor caster above -10 karma cannot cast any of these.
export const QOR_DRILL = Object.freeze([
  { spell: 'detect good', reagent: /^fairy wing$/i, per: 1, mana: 10, vigor: 5, self: true, castMs: 3000, school: 'Qor' },
  { spell: 'cloak', reagent: /^entroot berr/i, per: 2, mana: 5, vigor: 2, self: true, castMs: 2000, school: 'Qor' },
  { spell: 'darkness', reagent: /^fairy wing$/i, per: 1, also: [{ reagent: /^entroot berr/i, per: 1 }],
    mana: 8, vigor: 2, self: false, castMs: 0, school: 'Qor' },
]);

const count = (items, rx) => (items ?? []).filter(i => rx.test(i.name ?? '')).reduce((n, i) => n + (Number(i.amount) || 1), 0);

// THE CHOICE, as a pure function so it can be tested without a server: the castable spell with the
// lowest ability; null (with the reason) when none is castable.
export function choosePractice({ table, abilities, pack, mana, vigor = null, thriftBelow = 180 }) {
  const rows = table.map(t => ({ ...t, ability: abilities?.[t.spell] ?? null,
    // A SPELL WITH TWO REAGENTS (darkness) needs every one of them in the pack.
    haveReagent: count(pack, t.reagent) >= t.per && (t.also ?? []).every(a => count(pack, a.reagent) >= a.per) }));
  const known = rows.filter(r => r.ability != null);
  if (!known.length) return { pick: null, why: 'knows none of the practice spells' };
  const stocked = known.filter(r => r.haveReagent);
  if (!stocked.length) return { pick: null, why: `out of reagents for ${known.map(r => r.spell).join(', ')}`, restock: true };
  const affordable = stocked.filter(r => mana != null && mana >= r.mana);
  if (!affordable.length) {
    const need = Math.min(...stocked.map(r => r.mana));
    return { pick: null, why: `mana ${mana ?? '?'} under the ${need} the cheapest stocked spell costs`, manaShort: need - (mana ?? 0) };
  }
  // VIGOR IS THE BOTTLENECK BELOW thriftBelow: the cheapest-in-vigor spell, then the lowest ability.
  const thrift = Number.isFinite(vigor) && vigor < thriftBelow && affordable.every(r => Number.isFinite(r.vigor));
  if (thrift) {
    affordable.sort((a, b) => a.vigor - b.vigor || a.ability - b.ability);
    return { pick: affordable[0], why: `vigor ${vigor} < ${thriftBelow}: cheapest in vigor (${affordable.map(r => `${r.spell} ${r.vigor}`).join(', ')})` };
  }
  affordable.sort((a, b) => a.ability - b.ability || a.mana - b.mana);
  return { pick: affordable[0], why: `lowest ability of those castable (${affordable.map(r => `${r.spell} ${r.ability}`).join(', ')})` };
}

const STOMACHS = new Map();   // per agent, for the life of the host process

export async function practiceOnce({ call, agent, table = SHALILLE_DRILL, ledger = null,
                                     foods = DEFAULT_FOODS, thriftBelow = 180,
                                     controlUrl = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901' } = {}) {
  const [inv, st, ab] = await Promise.all([
    call('inventory', { agent }).catch(() => null),
    call('status', { agent }).catch(() => null),
    call('abilities', { agent, kind: 'spells' }).catch(() => null),
  ]);
  if (!Array.isArray(inv?.items) || !st) return { cast: false, why: 'pack or status unreadable', retryInMs: 15_000 };
  const pack = inv.items;
  const vigor = Number(st?.vigor?.value ?? st?.vitals?.vigor?.value ?? NaN);
  // EAT ON THE CLOCK. One bite a call at most; a bite that does not raise vigor was refused, and a
  // refusal means the stomach is full — the model's only correction.
  const stomach = STOMACHS.get(agent) ?? STOMACHS.set(agent, new Stomach()).get(agent);
  const meal = chooseFood({ pack, vigor, stomach, foods });
  let ate = null, vigorNow = vigor;
  if (meal.food) {
    await call('act', { agent, verb: 'eat', target: meal.food }).catch(() => null);
    const after = await call('status', { agent }).catch(() => null);
    const v2 = Number(after?.vigor?.value ?? after?.vitals?.vigor?.value ?? NaN);
    if (Number.isFinite(v2) && v2 > vigor) { stomach.ate(meal.filling); ate = meal.food; vigorNow = v2; }
    else stomach.full();
  }
  const mana = st?.mana?.value ?? st?.vitals?.mana?.value ?? null;
  const abilities = Object.fromEntries((ab?.spells ?? []).map(s => [String(s.name).toLowerCase(), s.ability ?? null]));
  const c = choosePractice({ table, abilities, pack, mana, vigor: vigorNow, thriftBelow });
  if (!c.pick) return { cast: false, why: c.why, restock: !!c.restock, ate, foodRestock: !!meal.restock,
                        retryInMs: c.manaShort ? Math.max(10_000, c.manaShort * 6_000) : 60_000 };
  const t = c.pick;
  let target = null;
  if (t.self) {
    try {
      const h = await (await fetch(`${controlUrl.replace(/\/?$/, '/')}health`, { signal: AbortSignal.timeout(15_000) })).json();
      const id = Number(h?.session_object_ids?.[agent]);
      target = Number.isInteger(id) && id > 0 ? id : null;
    } catch {}
    if (target == null) return { cast: false, spell: t.spell, why: 'own object id unreadable — a self-cast by name does not resolve', retryInMs: 15_000 };
  }
  const before = count(pack, t.reagent);
  await call('rest', { agent, stand: true }).catch(() => null);
  const sentAt = Date.now();
  const r = await call('cast', { agent, spell: t.spell, ...(target != null ? { target } : {}) }).catch(e => ({ error: e.message }));
  const said = [...(r?.messages ?? []), ...(r?.said ?? []), ...(r?.keeper_said?.said ?? [])].map(String);
  let outcome;
  // NO TRANCE: refused, or the chance roll failed inside PayCosts. Nothing is charging.
  if (r?.cast === false || r?.error) outcome = 'refused';
  else if (said.some(m => /unsuccessful in casting/i.test(m))) outcome = 'fizzle';
  else if (said.some(m => /concentration is broken/i.test(m))) outcome = 'broken';
  else {
    // A TRANCE MAY BE CHARGING. Sit it out to the longest it can last, measured from the send —
    // the reply may already have taken that long (the keeper holds still for the cast), in which
    // case this waits nothing.
    const left = sentAt + maxTranceMs(t.castMs) - Date.now();
    if (left > 0) await new Promise(res => setTimeout(res, left));
    const after = await call('inventory', { agent }).catch(() => null);
    outcome = Array.isArray(after?.items) ? (count(after.items, t.reagent) <= before - t.per ? 'success' : 'unknown') : 'unknown';
  }
  await ledger?.record({ kind: 'cast', spell: t.spell, school: t.school, outcome,
                         ...(outcome === 'refused' ? { why: r?.reason ?? r?.error ?? null } : {}) }).catch(() => {});
  return { cast: outcome !== 'refused', spell: t.spell, outcome, why: c.why, ate, foodRestock: !!meal.restock, resolvedMs: Date.now() - sentAt, retryInMs: 0 };
}
