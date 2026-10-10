// PRACTISE A SCHOOL'S SPELLS ON SPARE MANA, WHILE THE CHARACTER GETS ON WITH FARMING.
//
// The decision half of tools/fleetscripts/practice-while-farming.mjs: pure, no socket, every
// input passed in, so the arithmetic is pinned offline (m59-farmpractice-test.mjs).
//
// Operator, 2026-10-04: the tree farmers in Faronath knew three Qor spells and were practising
// none of them -- "have the practice use spare mana". It was first set by hand, three policy
// pushes with a spell order and a mana floor worked out on paper; this is that, made repeatable,
// for any school and any character, and re-runnable after a level-up.
//
// WHAT IT DECIDES, AND WHY EACH RULE IS THERE:
//
//   WHICH SPELLS   the school's spells the character KNOWS that are safe to practise on itself:
//                  a PersonalEnchantment (cloak, detect good) or TouchAttackSpell (acid touch,
//                  zap) is cast on self, a RoomEnchantment (darkness) on nothing. Practice casts a
//                  one-target spell on the CASTER, so anything else -- a curse, hold, dazzle, a
//                  wall of fog -- would land on our own character or needs a creature to aim at,
//                  and is left out with the reason said. Spells at 99% have nothing left to learn.
//
//   WHICH ORDER    weakest first. Practice casts the FIRST listed spell it can afford
//                  (m59-deskpractice.mjs choosePractice), so the head of the list is what gets
//                  drilled; a spell it cannot cast (short a reagent, refused) falls to the next.
//
//   SPARE MANA     practice never casts below `mana_floor`. The floor is what the character's
//                  OTHER casting needs to stay affordable: each buff it is posted to cast
//                  (buffAllies refuses below cost + 4, or its own mana_floor) and its touch spell.
//                  Super strength (10) makes it 14 -- after any practice cast, super strength
//                  can still go. A gap longer than the buffs' leaves them first call on regen.
//
//   WHERE          the rooms the character farms (its assigned room and confinement), so the
//                  drill happens between kills, not on a road.
//
//   REAGENTS       spent freely (operator, 2026-10-04: "Spend freely"); what a spell needs and
//                  what is on hand is REPORTED, because a spell short of its reagent is silently
//                  skipped every time and the list then drills the next one down.
import { loadCatalogue, spellCost, catalogueEntry } from './m59-deskpractice.mjs';

// The kod parents a practice cast may target ON ITSELF (or on nothing). See the header.
export const SELF_SAFE_PARENTS = Object.freeze(new Set(['PersonalEnchantment', 'TouchAttackSpell', 'RoomEnchantment']));
export const MAXED = 99;
const NO_TARGET_PARENTS = new Set(['RoomEnchantment']);

const fold = s => String(s ?? '').toLowerCase().replace(/[’'`]/g, '').trim();

/**
 * The practice config for one character, or a refusal.
 *
 * @param school      "qor", "kraanan", "shal'ille", ... (apostrophes ignored)
 * @param known       the abilities tool's spells: [{ name, ability, school, mana, targets }]
 * @param policy      the character's current policy (buffAllies, touchSpell, assignedRoom,
 *                    confineRooms, practiceSpells)
 * @param maxMana     the character's max mana
 * @param pack        (item) => count on hand, for the reagent report
 * @param only        optional explicit spell names to limit to
 * @param floor       optional mana floor override (the larger of it and the derived floor wins)
 * @param rooms       optional practice rooms override
 * @param gapMs       one practice cast per this long
 * @param keepOthers  keep existing practice entries from OTHER schools (relay, create food ...)
 * @returns { ok: true, practice, report } | { ok: false, why }
 */
export function planFarmPractice({ school, known = [], policy = {}, maxMana = null, pack = () => 0,
                                   only = null, floor = null, rooms = null, gapMs = 60_000,
                                   keepOthers = true, catalogue = loadCatalogue() } = {}) {
  const want = fold(school);
  if (!want) return { ok: false, why: 'no school named' };
  const onlySet = only?.length ? new Set(only.map(fold)) : null;
  const report = [];

  const inSchool = known.filter(s => fold(s.school) === want);
  if (!inSchool.length) return { ok: false, why: `knows no ${school} spells` };

  const chosen = [];
  for (const s of inSchool) {
    const name = String(s.name).toLowerCase();
    if (onlySet && !onlySet.has(fold(name))) continue;
    const kod = catalogueEntry(name, catalogue);
    if (!kod) { report.push(`${name}: not in the kod spell catalogue, left out`); continue; }
    if (!SELF_SAFE_PARENTS.has(kod.parent)) {
      report.push(`${name}: a ${kod.parent} -- practice would cast it on our own character or needs a creature, left out`);
      continue;
    }
    if (Number(s.ability) >= MAXED) { report.push(`${name}: at ${s.ability}%, nothing left to learn`); continue; }
    chosen.push({ name, ability: Number(s.ability) || 0, mana: Number(kod.mana) || Number(s.mana) || 0,
                  target: NO_TARGET_PARENTS.has(kod.parent) ? null : 'self' });
  }
  if (onlySet) for (const n of onlySet)
    if (!inSchool.some(s => fold(s.name) === n)) report.push(`${n}: not a ${school} spell this character knows`);
  if (!chosen.length) return { ok: false, why: `no ${school} spell it knows is safe to practise on itself`, report };
  chosen.sort((a, b) => (a.ability - b.ability) || (a.mana - b.mana));

  // SPARE MANA: what the character's other casting needs to remain affordable after a drill.
  const needs = [];
  const buff = policy.buffAllies;
  if (buff && buff.enabled !== false) {
    const knownNames = new Set(known.map(s => String(s.name).toLowerCase()));
    for (const b of (buff.spells ?? [])) {
      const n = String(b).toLowerCase();
      if (!knownNames.has(n)) continue;
      const cost = spellCost(n, catalogue)?.mana;
      const f = Number.isFinite(Number(buff.mana_floor)) ? Number(buff.mana_floor) : Number.isFinite(cost) ? cost + 4 : null;
      if (Number.isFinite(f)) needs.push([`buff ${n}`, f]);
    }
  }
  if (policy.touchSpell) {
    const cost = spellCost(policy.touchSpell, catalogue)?.mana;
    if (Number.isFinite(cost)) needs.push([`touch spell ${policy.touchSpell}`, cost + 4]);
  }
  const derived = needs.reduce((m, [, f]) => Math.max(m, f), 0);
  const manaFloor = Math.max(derived, Number.isFinite(Number(floor)) ? Number(floor) : 0);
  const cheapest = Math.min(...chosen.map(c => c.mana));
  if (Number.isFinite(Number(maxMana)) && Number(maxMana) - manaFloor < cheapest)
    return { ok: false, why: `max mana ${maxMana} less the ${manaFloor} floor leaves ${Number(maxMana) - manaFloor}, ` +
                             `and the cheapest ${school} spell costs ${cheapest} -- practice could never fire`, report };

  const here = rooms?.length ? rooms
    : [policy.assignedRoom, ...(policy.confineRooms ?? [])];
  const practiceRooms = [...new Set(here.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!practiceRooms.length) return { ok: false, why: 'no farming room to practise in: no assigned room or confinement, and none given', report };

  // Other schools' entries the character already practises stay, after this school's, and so do
  // the rooms they were practised in (relay in room 2 keeps working).
  const prior = policy.practiceSpells?.spells ?? [];
  const schoolNames = new Set(inSchool.map(s => String(s.name).toLowerCase()));
  const others = keepOthers ? prior.filter(e => !schoolNames.has(String(e?.name ?? e).toLowerCase())) : [];
  const allRooms = keepOthers && others.length
    ? [...new Set([...practiceRooms, ...(policy.practiceSpells?.rooms ?? []).map(Number)])] : practiceRooms;

  for (const c of chosen) {
    const short = (spellCost(c.name, catalogue)?.reagents ?? [])
      .filter(([item, n]) => pack(item) < n).map(([item, n]) => `${item} (needs ${n}, has ${pack(item)})`);
    report.push(`${c.name} ${c.ability}%: ${c.mana} mana` + (short.length ? ` -- SHORT ${short.join(', ')}, skipped until carried` : ''));
  }
  report.push(`mana floor ${manaFloor}` + (needs.length ? ` (${needs.map(([w, f]) => `${w} needs ${f}`).join('; ')})` : ' (nothing else casts)'));

  return {
    ok: true,
    practice: {
      enabled: true,
      spells: [...chosen.map(c => c.target ? { name: c.name, target: c.target } : { name: c.name }), ...others],
      rooms: allRooms,
      mana_floor: manaFloor,
      gap_ms: gapMs,
      rest_seconds: 0,
    },
    order: chosen.map(c => c.name),
    report,
  };
}

/** Is `live` (the keeper's practiceSpells) the plan we applied? Names in order, floor, rooms, gap. */
export function practiceMatches(live, planned) {
  if (!live || !planned) return false;
  const names = x => (x.spells ?? []).map(e => String(e?.name ?? e).toLowerCase());
  return JSON.stringify(names(live)) === JSON.stringify(names(planned))
    && Number(live.mana_floor) === Number(planned.mana_floor)
    && Number(live.gap_ms) === Number(planned.gap_ms)
    && JSON.stringify([...(live.rooms ?? [])].map(Number).sort()) === JSON.stringify([...planned.rooms].map(Number).sort());
}

