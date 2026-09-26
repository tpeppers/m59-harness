// PRACTISE AT THE DESK — and never spend what the next customer is owed.
//
// Operator, 2026-09-25: "a practice-while-running-a-service-desk setup for building spells. It
// keeps enough mana in reserve for 2x casts of its most expensive service."
//
// A service character spends most of its life standing at its post waiting for a ticket. Casting
// is the only way a spell improves, so that idle time is the cheapest practice this fleet has —
// but a desk that drilled itself down to empty mana would answer the next Reveal with a cast the
// server refuses in silence (`cast: true, mana_spent: 0`), which is the one failure a service
// must not have. So the reserve is not a number somebody picks. It is DERIVED from the desk:
//
//     reserve = reserve_casts (2) x the mana of ONE cast of the dearest service this desk
//               both OFFERS and KNOWS
//
// On a Shal'ille desk offering all three that is reveal, 30 mana (reveal.kod), so 60. A desk
// with reveal switched off (`chalice.reveal: false`) falls to forces of light, 12, so 24 — the
// reserve follows the menu rather than a constant that goes stale the day the menu changes.
// "Knows" matters for the same reason: a holder that has not learned reveal cannot serve it, and
// reserving 60 mana for a spell it cannot cast would idle the drill for nothing.
//
// REAGENTS GET THE SAME PROTECTION. The ask was mana, but mana is the half that comes back on its
// own: an emerald spent on `purify` practice is an emerald the next Remove Curse does not have,
// and it does not regenerate at the post. So practice also keeps back `reserve_casts` casts'
// worth of every offered service's reagents, ON TOP OF the holder's Rescue emeralds
// (`rescue_emeralds`, m59-chalice.mjs `reagentFloor`) — summed across services, because two
// services that both spend emeralds each need their own.
//
// THIS FILE IS PURE. It decides and explains; `Autopilot.practiceAtDesk` (m59-autopilot.mjs)
// stands the character up, casts, and reads the mana back. `m59-deskpractice-test.mjs` pins it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// WHAT EACH DESK SERVICE CASTS. `per_service` is how many casts one ticket spends — the keeper
// casts remove curse three times a ticket (`chaliceServeTicket`) and reveal once per item — kept
// for the report; the reserve is counted in CASTS, as asked. `ride` casts nothing: the traveller
// drinks from the cup, so it costs the desk no mana at all and is not in this table.
export const SERVICE_SPELLS = Object.freeze({
  uncurse: Object.freeze({ spell: 'remove curse', per_service: 3 }),
  reveal: Object.freeze({ spell: 'reveal', per_service: 1 }),
  fol: Object.freeze({ spell: 'forces of light', per_service: 1 }),
});

/** The services a desk OFFERS, from its chalice config — the same switches `deskMenu` reads. */
export function offeredServices(chalice) {
  if (!chalice || chalice.enabled === false) return [];
  const out = [];
  if (chalice.uncurse !== false) out.push('uncurse');
  if (chalice.reveal !== false) out.push('reveal');
  if (chalice.fol_room != null) out.push('fol');
  return out;
}

// ------------------------------------------------------------------------------ the catalogue
//
// Mana and reagents come from the kod, via `m59-spells.mjs build` -> substrate/m59-spells.json.
// The protocol carries a spell's name and target count and nothing else, so a hand-typed cost
// table here would be a second opinion about the kod that nobody re-checks.

const HERE = dirname(fileURLToPath(import.meta.url));
let _catalogue = null;
export function loadCatalogue(file = process.env.M59_SPELLS || join(HERE, '..', 'substrate', 'm59-spells.json')) {
  if (_catalogue) return _catalogue;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    _catalogue = new Map((d.spells ?? []).map(s => [String(s.name).toLowerCase(), s]));
  } catch { _catalogue = new Map(); }
  return _catalogue;
}

// THE KOD SPELLS REAGENTS AS CLASS NAMES, THE PACK SPELLS THEM AS ITEM NAMES. `ElderBerry` is
// the elderberry in the pack and `Herbs` is matched by `herb` (reagentOnHand matches by
// substring, the same way the chalice code asks for 'orc tooth' and 'emerald').
const REAGENT_NAMES = { elderberry: 'elderberry', herbs: 'herb' };
export function reagentName(cls) {
  const flat = String(cls ?? '').toLowerCase();
  if (REAGENT_NAMES[flat]) return REAGENT_NAMES[flat];
  return String(cls ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
}

/** `{ name, mana, reagents: [[item, n], ...] }` for a spell, or null when the kod has no such spell. */
export function spellCost(name, catalogue = loadCatalogue()) {
  const s = catalogue.get(String(name ?? '').toLowerCase());
  if (!s || !Number.isFinite(Number(s.mana))) return null;
  return { name: s.name, mana: Number(s.mana),
           reagents: (s.reagents ?? []).map(r => [reagentName(r.item), Number(r.count) || 1]) };
}

// ------------------------------------------------------------------------------ the config
export const PRACTICE_DEFAULTS = Object.freeze({
  enabled: true,
  // What to drill, tried in order. A string or `{ name, target: 'self' | 'none' }`. Without a
  // target the spell's own target count decides: none takes none, one or more is cast on self.
  spells: Object.freeze([]),
  // THE OPERATOR'S NUMBER. Casts of the dearest offered service kept back in mana (and reagents).
  reserve_casts: 2,
  // An absolute mana floor under the derived one — for a character with no desk, or a desk
  // somebody wants to keep deeper than two casts. The larger of the two wins.
  mana_floor: 0,
  // One practice cast per this long. ADVANCEMENT_LIMIT is 10 improvements per random 15-22
  // minute window, spells and skills together (player.kod:66-68), and a spell improves on
  // roughly one cast in six, so casting much faster than this raises nothing and spends
  // reagents for it.
  gap_ms: 20_000,
  // A cast the mana says never happened (the server refused it in silence — a room already lit,
  // a heal on somebody whole) puts THAT spell aside for this long, so the next pass tries the
  // next one instead of re-sending the same refusal every twenty seconds.
  refused_ms: 300_000,
  // Where practice is allowed. Empty means the desk's own rooms: the post, the station, and the
  // keeper's assigned room. A practice caster that has walked off to town does not practise there.
  rooms: Object.freeze([]),
  // Sit for a few seconds after a cast to win the mana back, but only on a held wall — resting in
  // the open is what the keeper's survival rung exists to prevent, and it is not this pass's call.
  rest_seconds: 5,
});

const NUMBERS = { reserve_casts: [0, 20], mana_floor: [0, 1000], gap_ms: [2000, 3_600_000],
                  refused_ms: [10_000, 3_600_000], rest_seconds: [0, 60] };

/**
 * Normalise what DUM (or an operator) pushed. Unknown keys and unusable values are REPORTED,
 * and an unusable value keeps the default rather than unsetting it (docs/m59-policy.md).
 * Returns null when practice is off — `null` and `{enabled: false}` are the same answer.
 */
export function normalizePractice(cfg) {
  if (cfg == null || cfg === false) return null;
  if (typeof cfg !== 'object' || Array.isArray(cfg))
    return { ...PRACTICE_DEFAULTS, enabled: false, problems: ['practice must be an object or null'] };
  if (cfg.enabled === false) return null;
  const out = { ...PRACTICE_DEFAULTS, problems: [] };
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'enabled' || k === 'problems') continue;
    if (!Object.hasOwn(PRACTICE_DEFAULTS, k)) { out.problems.push(`unrecognised key ${k}, not applied`); continue; }
    if (k === 'spells') {
      const list = [];
      for (const s of [].concat(v ?? [])) {
        const name = String(typeof s === 'string' ? s : s?.name ?? '').trim().toLowerCase();
        if (!name) { out.problems.push('spells has an unnamed entry'); continue; }
        const target = typeof s === 'object' && s?.target != null ? String(s.target).toLowerCase() : null;
        if (target != null && target !== 'self' && target !== 'none') {
          out.problems.push(`spells.${name}.target must be "self" or "none"`); continue;
        }
        list.push({ name, ...(target ? { target } : {}) });
      }
      out.spells = list;
      continue;
    }
    if (k === 'rooms') {
      const rooms = [].concat(v ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (rooms.length !== [].concat(v ?? []).length) out.problems.push('rooms must be room numbers');
      out.rooms = rooms;
      continue;
    }
    const [lo, hi] = NUMBERS[k];
    const n = Number(v);
    if (Number.isFinite(n) && n >= lo && n <= hi) out[k] = n;
    else out.problems.push(`${k} must be a number in [${lo}, ${hi}]; kept ${PRACTICE_DEFAULTS[k]}`);
  }
  if (!out.spells.length) out.problems.push('no spells to practise');
  return out;
}

// ------------------------------------------------------------------------------ the reserve

/**
 * What practice must leave untouched.
 *
 * @param practice  normalised practice config
 * @param services  the desk's offered services (`offeredServices(chalice)`)
 * @param known     spell names this character can cast, lower-case
 * @param keep      reagents already kept back for other reasons (the Rescue emeralds)
 * @returns { mana, reagents, dearest, why }
 */
export function deskReserve({ practice = PRACTICE_DEFAULTS, services = [], known = [],
                              keep = {}, catalogue = loadCatalogue() } = {}) {
  const knows = new Set(known.map(k => String(k).toLowerCase()));
  const casts = Number(practice.reserve_casts ?? PRACTICE_DEFAULTS.reserve_casts);
  const priced = [];
  const unpriced = [];
  for (const kind of services) {
    const svc = SERVICE_SPELLS[kind];
    if (!svc || !knows.has(svc.spell)) continue;
    const cost = spellCost(svc.spell, catalogue);
    if (!cost) { unpriced.push(svc.spell); continue; }
    priced.push({ kind, ...cost, per_service: svc.per_service });
  }
  const dearest = priced.reduce((a, b) => (b.mana > (a?.mana ?? -1) ? b : a), null);
  const derived = dearest ? casts * dearest.mana : 0;
  const floor = Number(practice.mana_floor) || 0;
  const mana = Math.max(derived, floor);

  const reagents = { ...Object.fromEntries(Object.entries(keep).map(([k, v]) => [k, Number(v) || 0])) };
  for (const p of priced)
    for (const [item, n] of p.reagents) reagents[item] = (reagents[item] || 0) + casts * n;

  const why = dearest
    ? `${casts} x ${dearest.name} (${dearest.mana} mana), the dearest service this desk offers and knows` +
      (floor > derived ? `; mana_floor ${floor} is higher and wins` : '')
    : (floor > 0 ? `no service this character can cast; mana_floor ${floor}`
                 : 'no service this character can cast, and no mana_floor: nothing kept back');
  return { mana, reagents, dearest: dearest ? { kind: dearest.kind, spell: dearest.name, mana: dearest.mana } : null,
           services: priced.map(p => p.kind), unpriced, why };
}

// ------------------------------------------------------------------------------ the choice

/**
 * The spell to practise now, or why not. Pure: everything it needs is passed in.
 *
 * @param spells    what the character can cast: `[{ name, targets }]`, names lower-case
 * @param mana      `{ value, max }`
 * @param have      `(item) => count` on hand
 * @param reserve   `deskReserve(...)`
 * @param refusedUntil  Map spell -> epoch ms it is set aside until
 * @returns { cast: { name, target: 'self'|'none', mana }, why } | { cast: null, why, blocked }
 */
export function choosePractice({ practice, spells = [], mana = null, have = () => 0,
                                 reserve, refusedUntil = new Map(), now = 0,
                                 catalogue = loadCatalogue() } = {}) {
  if (!practice) return { cast: null, why: 'practice is off', blocked: 'off' };
  if (!(mana && Number.isFinite(mana.value)))
    return { cast: null, why: 'mana is unreadable, so the reserve cannot be honoured', blocked: 'unreadable' };
  if (Number.isFinite(mana.max) && reserve.mana >= mana.max)
    return { cast: null, blocked: 'reserve_exceeds_max',
             why: `the reserve (${reserve.mana}: ${reserve.why}) is not below max mana ${mana.max} — ` +
                  'practice could never spend anything without eating into it' };
  const byName = new Map(spells.map(s => [String(s.name).toLowerCase(), s]));
  const tried = [];
  for (const want of practice.spells) {
    const s = byName.get(want.name);
    if (!s) { tried.push(`${want.name}: not known`); continue; }
    if ((refusedUntil.get(want.name) ?? 0) > now) { tried.push(`${want.name}: refused recently`); continue; }
    const cost = spellCost(want.name, catalogue);
    if (!cost) { tried.push(`${want.name}: no cost in the spell catalogue`); continue; }
    if (mana.value - cost.mana < reserve.mana) {
      tried.push(`${want.name}: ${cost.mana} mana would leave ${mana.value - cost.mana}, under the ${reserve.mana} reserve`);
      continue;
    }
    const short = cost.reagents.filter(([item, n]) => have(item) - (reserve.reagents[item] || 0) < n);
    if (short.length) {
      tried.push(`${want.name}: short ${short.map(([item, n]) =>
        `${item} (${have(item)} on hand, ${reserve.reagents[item] || 0} kept, needs ${n})`).join(', ')}`);
      continue;
    }
    const target = want.target ?? ((Number(s.targets) || 0) > 0 ? 'self' : 'none');
    return { cast: { name: want.name, target, mana: cost.mana },
             why: `practice ${want.name} (${cost.mana} mana, ${mana.value} on hand, ${reserve.mana} kept for the desk)` };
  }
  const manaOnly = tried.length && tried.every(t => /under the \d+ reserve|refused recently|not known/.test(t))
    && tried.some(t => /reserve/.test(t));
  return { cast: null, why: tried.join('; ') || 'nothing to practise', blocked: manaOnly ? 'mana' : 'none' };
}
