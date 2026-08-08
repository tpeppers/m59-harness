#!/usr/bin/env node
// THE DATA A CHARACTER PLANNER NEEDS, DERIVED FROM THE KOD RATHER THAN TYPED IN.
//
//   node tools/m59-planner-data.mjs            # write compendium/data/planner.json
//   node tools/m59-planner-data.mjs --print    # show what it found, write nothing
//
// Everything here comes from compendium/data/koddb.json (all 1232 kod classes) and
// substrate/m59-spells.json. Nothing is hand-entered, because a planner that disagrees
// with the server is worse than no planner — it produces confident wrong builds.
//
// WHAT THIS IS FOR. The compendium's bestiary already recalculates against a live
// character. A planner is the other direction: what could this character become, and
// what does each point of a stat buy. Three questions it has to answer, all of which
// need the same table:
//
//   * which skills key off which stat, so hovering a stat can highlight them
//   * which spells sit at which level of which school, so the INT table can name them
//   * what a new level costs, so the INT table means something
//
// THE REQUISITE STAT IS CASE-INSENSITIVE AND INHERITED, AND BOTH MATTER.
//
// Skills declare `GetRequisiteStat` returning @GetMight, @GetAim and so on — but the
// kod is inconsistently cased and brawling writes `@getmight` in lower case. A
// case-sensitive match silently falls through to the parent chain and lands on the base
// Skill class, which answers Agility. That produced a table saying brawling is an
// agility skill, which is wrong and reads perfectly plausibly: 18 agility skills, 3 aim,
// 1 stamina. The corrected table is 13 agility, 4 aim, 4 might, 1 stamina — and the four
// might skills are exactly the heavy-weapon ones you would expect.
//
// So: match case-insensitively, and walk the parent chain only when the class itself is
// silent.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PRINT_ONLY = !!arg('print', false);

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const KODDB = here('../compendium/data/koddb.json');
const SPELLS = here('../substrate/m59-spells.json');
const OUT = here('../compendium/data/planner.json');

const db = JSON.parse(readFileSync(KODDB, 'utf8'));
const classes = db.classes || {};
const spellFile = JSON.parse(readFileSync(SPELLS, 'utf8'));

// ---------------------------------------------------------------- stats

// The five a player rolls, plus the two derived ones the planner has to show. Named as
// the kod names them, because every lookup below keys off that spelling.
const STATS = {
  might:     { label: 'Might',     blurb: 'Melee damage, and what heavy weapons key off.' },
  intellect: { label: 'Intellect', blurb: 'How fast every skill and spell improves, and how many school levels a character can learn in its lifetime.' },
  stamina:   { label: 'Stamina',   blurb: 'Maximum health is 101 + stamina, fixed at creation and never moved.' },
  agility:   { label: 'Agility',   blurb: 'Avoiding blows, and what most combat skills key off.' },
  mysticism: { label: 'Mysticism', blurb: 'Mana pool and spellcasting.' },
  aim:       { label: 'Aim',       blurb: 'Ranged accuracy, and what the precision weapon skills key off.' },
};

// ------------------------------------------------- skills and their requisite stat

const lower = (s) => String(s || '').toLowerCase();

// Walk the chain, but only past classes that are SILENT on the question. A class that
// answers gets the answer — that is the whole point of the override.
function requisiteStat(className) {
  let c = classes[lower(className)];
  for (let hops = 0; c && hops < 12; hops++) {
    const m = (c.messages || []).find(x => lower(x.name) === 'getrequisitestat');
    if (m) {
      const g = String(m.body || '').match(/@get([a-z]+)/i);
      if (g) return lower(g[1]);
    }
    c = c.parent ? classes[lower(c.parent)] : null;
  }
  return null;
}

// The display name lives in a resource, not the class name: `maceproficiency` is shown
// as "mace fighting". Getting this wrong is the trap CLAUDE.md documents — seven of the
// eight weapon proficiencies were called something invented for a long time.
function displayName(key, c) {
  const rsc = c.resources || {};
  const named = rsc[`${key}_name_rsc`] || Object.entries(rsc).find(([k]) => /_name_rsc$/.test(k))?.[1];
  return named?.value || c.name || key;
}

const skills = [];
for (const [key, c] of Object.entries(classes)) {
  if (!/\/skill\//.test(c.file || '')) continue;
  if (lower(c.name) === 'skill') continue;               // the base class is not a skill
  const stat = requisiteStat(key);
  // A CLASS WITH CHILDREN IS A CATEGORY, NOT A SKILL. `proficiency` has eight children
  // and an icon of its own, and reads exactly like a learnable skill until you notice
  // every weapon proficiency inherits from it. Offering it in a planner would let
  // someone spend points on something no trainer teaches. Kept rather than dropped,
  // because the grouping is what the weapon skills hang off.
  const abstract = (c.children || []).length > 0;
  skills.push({
    key,
    name: displayName(key, c),
    requisite_stat: stat,
    abstract,
    learnable: !abstract,
    parent: c.parent || null,
    file: c.file || null,
    description: (c.resources || {})[`${key}_desc_rsc`]?.value
              || (c.resources || {})[`${key}_desc_text_rsc`]?.value || null,
  });
}
skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));

// ---------------------------------------------------------------- spells

// 175 rows in the file; the ones with a school and a level are the learnable ones. The
// rest are internals (TouchAttackSpell and friends) and DM commands.
const allSpells = spellFile.spells || [];
const spells = allSpells
  .filter(s => s.level != null && s.school_name && s.school_name !== 'none' && s.school_name !== 'DM command')
  .map(s => ({
    name: s.name,
    school: s.school_name,
    level: s.level,
    mana: s.mana ?? null,
    reagents: (s.reagents || []).map(r => ({ item: r.item, count: r.count })),
    prerequisites: s.prerequisites || [],
    required_karma: s.required_karma ?? 0,
    min_hit_points: s.min_hit_points ?? 0,
    // Casting keys off Mysticism for every school; the school itself does not change
    // that. Recorded per spell anyway so the planner never has to assume it.
    casting_stat: 'mysticism',
  }))
  .sort((a, b) => a.school.localeCompare(b.school) || a.level - b.level
                  || String(a.name).localeCompare(String(b.name)));

const schools = [...new Set(spells.map(s => s.school))].sort();

// -------------------------------------------------- what each stat is worth, both ways

// The index the planner's hovers read: for a stat, everything that keys off it.
const byStat = {};
for (const k of Object.keys(STATS)) byStat[k] = { skills: [], schools: [], spell_levels: [] };
// Only learnable skills go in the stat index — a hover that highlights a category
// nobody can train is noise.
for (const s of skills) if (s.learnable && s.requisite_stat && byStat[s.requisite_stat])
  byStat[s.requisite_stat].skills.push(s.name);
// Every school's spells cast off mysticism, so mysticism carries all of them. Stated as
// data rather than left implicit, because "which schools benefit from this stat" is a
// question the planner asks of every stat and the answer for five of them is "none".
byStat.mysticism.schools = schools.slice();
// Intellect is the exception that is easy to state wrongly: it is not a requisite stat
// for any single skill, and it benefits ALL of them, which is why it never appears in
// the per-skill table and must be described separately.
byStat.intellect.applies_to_everything =
  'Raises the improvement rate of every skill and every spell, and sets how many school '
  + 'levels can be learned over the character\'s lifetime. It is not the requisite stat '
  + 'of any individual skill, so it will never appear in the per-skill column.';

// ------------------------------------------------ what a level costs, and what INT buys

// From player.PlayerCanLearn:
//
//   iPoints = sum over the seven tracks (weapon skills + the six schools) of
//             GetLevelLearnPoints(highest level known in that track)
//   iNeed   = iPoints * POINTS_SLOPE
//           + (297 - MaxLearnPoints * POINTS_SLOPE)
//           - (RawIntellect * 2 * POINTS_SLOPE / 5)
//   iNeed   = bound(iNeed, MIN_NEEDED_TO_ADVANCE, $)
//
// so each point of intellect buys (2 * POINTS_SLOPE / 5) advancement points off the
// cost of the next level, and the cost rises with how much is already known.
const sys = classes['system'];
const levelPointsBody = (sys?.messages || []).map(m => String(m.body || ''))
  .find(b => /vlLevelPoints\s*=\s*\[/.test(b));
const levelPoints = levelPointsBody
  ? JSON.parse(levelPointsBody.match(/vlLevelPoints\s*=\s*(\[[^\]]*\])/)[1])
  : null;

// TWO CONSTANTS ARE NOT RESOLVABLE FROM THIS SNAPSHOT, AND SAYING SO IS THE POINT.
//
// POINTS_SLOPE and MIN_NEEDED_TO_ADVANCE are referenced inside PlayerCanLearn's body but
// are not captured in koddb's constant table — they live in a .khd include the builder
// did not fold in. M59_ROOT is unset here, so there is nothing local to read them from.
//
// A planner that guessed them would produce a cost curve that looks authoritative and is
// invented. So they are exported as nulls with the formula intact: whatever consumes
// this can show the level table and the shape of the relationship, and must refuse to
// draw exact numbers until these are filled in from the source tree.
const unresolved = ['POINTS_SLOPE', 'MIN_NEEDED_TO_ADVANCE'];

const out = {
  builtAt: null,          // stamped by the caller; kept null so reruns diff cleanly
  builtFrom: { koddb: db.builtFrom ?? null, spells: spellFile.builtAt ?? null },
  stats: STATS,
  by_stat: byStat,
  skills,
  spells,
  schools,
  learning: {
    level_points: levelPoints,                 // cost weight of each school level, 1..6
    max_school_level: levelPoints ? levelPoints.length : null,
    formula: 'iNeed = iPoints*POINTS_SLOPE + (297 - MaxLearnPoints*POINTS_SLOPE) '
           + '- (RawIntellect*2*POINTS_SLOPE/5), bounded below by MIN_NEEDED_TO_ADVANCE',
    intellect_effect: 'each point of intellect removes (2*POINTS_SLOPE/5) from the cost '
                    + 'of the next level',
    source: 'player.PlayerCanLearn',
    unresolved,
    note: unresolved.length
      ? 'POINTS_SLOPE and MIN_NEEDED_TO_ADVANCE are referenced by PlayerCanLearn but are '
        + 'not in this koddb snapshot. Set M59_ROOT and re-derive before showing exact '
        + 'advancement-point costs; the level table and the direction of the effect are '
        + 'safe to show without them.'
      : null,
  },
};

if (PRINT_ONLY) {
  console.log(`skills ${skills.length}, spells ${spells.length}, schools ${schools.length}`);
  console.log('\nskills by requisite stat:');
  for (const [k, v] of Object.entries(byStat)) {
    if (!v.skills.length) continue;
    console.log(`  ${k.padEnd(10)} (${String(v.skills.length).padStart(2)})  ${v.skills.join(', ')}`);
  }
  const noStat = skills.filter(s => !s.requisite_stat);
  if (noStat.length) console.log(`\n  no requisite stat found: ${noStat.map(s => s.name).join(', ')}`);
  console.log('\nspells per school and level:');
  for (const sc of schools) {
    const counts = [1, 2, 3, 4, 5, 6].map(l => spells.filter(s => s.school === sc && s.level === l).length);
    console.log(`  ${sc.padEnd(12)} ${counts.join('  ')}`);
  }
  console.log(`\nlevel points: ${JSON.stringify(levelPoints)}`);
  console.log(`unresolved constants: ${unresolved.join(', ') || 'none'}`);
} else {
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${OUT}`);
  console.log(`  ${skills.length} skills, ${spells.length} spells, ${schools.length} schools`);
  if (unresolved.length) console.log(`  UNRESOLVED: ${unresolved.join(', ')} — see learning.note`);
}
