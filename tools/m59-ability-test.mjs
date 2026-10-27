#!/usr/bin/env node
// ABILITY TRACKING — the cache, the pushes, and the record. Offline, no server,
// safe to run any time:
//
//   node tools/m59-ability-test.mjs
//
// Two halves, and the first is the one that was broken:
//
//   THE WIRE. Ability levels arrive in stat groups 3 (spells) and 4 (skills), which
//   are STATS_LIST and therefore carry the spell's or skill's OBJECT ID. They were
//   being filed in `statsById` under "4.7" and nothing else, because that map indexes
//   a stat by name only `if (s.name)` and `name` comes from STAT_NAMES, which covers
//   groups 1 and 2. So `abilityOf(c, 'axe wielding')` searched by name, found
//   nothing, and returned null — every time, for every character, since the beginning.
//   Nothing noticed, because null is also the honest "not read yet" answer and
//   weaponRanking falls back to a name score for it.
//
//   THE RECORD. Reading abilities costs four requests and 1.2s, so nothing read them
//   often, so nobody had a BEFORE to compare against. The server pushes every change
//   (ChangeSkillAbility -> DrawStatSkill, player.kod:7343), which means the delta can
//   be logged as it happens instead of reconstructed from two polls that never ran.

import { M59Client } from './m59-client.mjs';
import { abilityOf, weaponRanking } from './m59-skills.mjs';
import { emptyBook, mergeAbilities, noteAdvancement, isFresh,
         DEFAULT_MAX_AGE_MS } from './m59-abilities.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? `  ${extra}` : ''}`); }
};
const eq = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// include/proto.h
const BP_STAT = 131, BP_STAT_GROUP = 132, BP_SKILLS = 144, BP_SPELLS = 141;
const STATS_LIST = 2, STAT_GROUP_SPELLS = 3, STAT_GROUP_SKILLS = 4;

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
const u8 = n => Buffer.from([n & 0xff]);
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; };

// extractStatistic for a STATS_LIST entry: num, name rsc, type, then id/value/icon.
const statBody = (slot, id, value, nameRsc = 700) =>
  Buffer.concat([u8(slot), u32(nameRsc), u8(STATS_LIST), u32(id), i32(value), u32(0)]);
const oneStat = (group, slot, id, value) => Buffer.concat([u8(group), statBody(slot, id, value)]);
const statGroup = (group, rows) =>
  Buffer.concat([u8(group), u8(rows.length),
                 ...rows.map(([slot, id, value]) => statBody(slot, id, value))]);

// extractObject, the long form the skill and spell lists carry. Only the ids and name
// resources matter here; the rest is the shape the parser insists on — and it insists
// exactly, because a stream that does not land on the end is treated as a desync.
// Note the palette translation contributes NO bytes: it peeks one, and rewinds unless
// that byte is ANIMATE_TRANSLATION or ANIMATE_EFFECT, which the animation type here is
// not.
const objBody = (id, nameRsc) => Buffer.concat([
  u32(id), u32(0), u32(nameRsc), u32(0), i32(0),   // id, icon, name, flags, rarity
  u16(0),                                           // dlighting: LIGHT_FLAG_NONE, nothing follows
  u8(1), u16(0),                                    // animation: ANIMATE_NONE + group
  u8(0),                                            // overlays: a one-byte count of none
]);
const skillList = (rows) => Buffer.concat([u16(rows.length), ...rows.map(([id, n]) => objBody(id, n))]);
const spellList = (rows) => Buffer.concat([u16(rows.length),
  ...rows.map(([id, n]) => Buffer.concat([objBody(id, n), u8(1), u8(1)]))]);   // + numTargets, school

const RSC = new Map([
  [700, 'skillicon.bgf'],
  // The server's own names for these — see m59-skills.mjs WEAPON_PROFICIENCY. Using
  // the invented ones here would make weaponRanking's lookup miss and the test would
  // be pinning the wrong vocabulary as firmly as the code once did.
  [801, 'axe wielding'], [802, 'fencing'], [803, 'slash'],
  [901, 'create food'], [902, 'blast'],
]);
const client = () => new M59Client({ resources: RSC, verbose: false });

// ------------------------------------------------------------------- the wire

console.log('\nreading an ability off the wire');
{
  const c = client();
  c.onGameMessage(BP_SKILLS, skillList([[11, 801], [12, 802]]));
  c.onGameMessage(BP_STAT_GROUP, statGroup(STAT_GROUP_SKILLS, [[1, 11, 37], [2, 12, 62]]));
  eq('both abilities land', [...c.abilities.values()].map(a => [a.name, a.ability]),
     [['axe wielding', 37], ['fencing', 62]]);
  ok('and the group is marked read', c.abilitiesKnown().known.skills === true);
  ok('spells are NOT — they are a separate group and were never asked for',
     c.abilitiesKnown().known.spells === false);
}

// THE BUG. This is the assertion that fails against every version before this one.
console.log('\nasking how good we are, by name');
{
  const c = client();
  c.onGameMessage(BP_SKILLS, skillList([[11, 801], [12, 802]]));
  c.onGameMessage(BP_STAT_GROUP, statGroup(STAT_GROUP_SKILLS, [[1, 11, 37], [2, 12, 62]]));
  eq('the client answers by name', c.abilityOf('axe wielding'), 37);
  eq('and so does the skills-layer helper', abilityOf(c, 'fencing'), 62);
  eq('case does not matter', c.abilityOf('AXE Wielding'), 37);
  // The distinction that has to survive: a skill we do not have is null, not 0.
  eq('an unread skill is null, not zero', abilityOf(c, 'mace fighting'), null);
  // statsById still files it positionally, and that is exactly why the by-name search
  // of it never worked.
  ok('statsById has it only under its slot', c.statsById.has('4.1') && !c.statsById.has('axe wielding'));
}

// The consequence: proficiency-weighted weapon choice has never actually run.
console.log('\nproficiency ranking, which depended on that lookup');
{
  const c = client();
  c.inventory = [{ id: 1, nameRsc: 811 }, { id: 2, nameRsc: 812 }];
  c.rsc.set(811, 'battle axe'); c.rsc.set(812, 'long sword');
  c.onGameMessage(BP_SKILLS, skillList([[11, 801], [12, 802]]));
  c.onGameMessage(BP_STAT_GROUP, statGroup(STAT_GROUP_SKILLS, [[1, 11, 90], [2, 12, 11]]));
  const ranked = weaponRanking(c);
  // By raw weapon class the sword and axe are 8 and 7; by proficiency the axe wins by
  // a mile. Before the fix both abilities read as null and the class score decided.
  eq('the weapon we are good with leads', ranked[0].name, 'battle axe');
  eq('and the ranking carries the real number', ranked[0].ability, 90);
}

console.log('\na pushed advancement');
{
  const c = client();
  const seen = [];
  c.onEvent = ev => { if (ev.kind === 'ability') seen.push(ev); };
  c.onGameMessage(BP_SKILLS, skillList([[11, 801]]));
  c.onGameMessage(BP_STAT_GROUP, statGroup(STAT_GROUP_SKILLS, [[1, 11, 37]]));
  ok('the establishing read is not advancement', seen.length === 0, JSON.stringify(seen));

  // One BP_STAT for one slot: what DrawStatSkill sends the instant an ability moves.
  c.onGameMessage(BP_STAT, oneStat(STAT_GROUP_SKILLS, 1, 11, 38));
  ok('a change emits exactly one event', seen.length === 1, JSON.stringify(seen));
  eq('naming what moved and by how much',
     [seen[0].name, seen[0].from, seen[0].to, seen[0].by], ['axe wielding', 37, 38, 1]);
  ok('and marked as pushed, not as the answer to a question', seen[0].pushed === true);
  // The event's own discriminator survives its payload. emit() spreads the payload
  // over the event, so a payload field called `kind` REPLACES the event kind — which
  // it did, silently: the event went out as kind:'skill' and the broker, waiting for
  // kind:'ability', never recorded a single advancement. Nothing else caught it,
  // because the emit succeeded and the cache updated correctly; only the listener
  // starved.
  eq('the event kind is the event\'s, not the payload\'s', seen[0].kind, 'ability');
  eq('and which of the two rides alongside it', seen[0].what, 'skill');
  eq('the cache is updated', c.abilityOf('axe wielding'), 38);

  // A repeat of the same value is not a change.
  c.onGameMessage(BP_STAT, oneStat(STAT_GROUP_SKILLS, 1, 11, 38));
  ok('an unchanged push emits nothing', seen.length === 1);

  // A push does NOT make the group count as freshly read — it proves one number is
  // current and says nothing about the other forty.
  const before = c.abilitiesAt.skills;
  c.onGameMessage(BP_STAT, oneStat(STAT_GROUP_SKILLS, 1, 11, 39));
  ok('and does not reset the read age', c.abilitiesAt.skills === before);
}

console.log('\nwhen the stat arrives before the list that names it');
{
  const c = client();
  c.onGameMessage(BP_STAT_GROUP, statGroup(STAT_GROUP_SKILLS, [[1, 11, 37]]));
  ok('the number is kept even with no name for it', c.abilities.get(11)?.ability === 37);
  ok('and it is reported as unnamed rather than dropped', c.abilitiesKnown().unnamed === 1);
  c.onGameMessage(BP_SKILLS, skillList([[11, 801]]));
  eq('the list backfills the name', c.abilityOf('axe wielding'), 37);
  ok('and nothing is unnamed any more', c.abilitiesKnown().unnamed === 0);
}

console.log('\nspells are tracked the same way, in their own group');
{
  const c = client();
  c.onGameMessage(BP_SPELLS, spellList([[21, 901], [22, 902]]));
  c.onGameMessage(BP_STAT_GROUP, statGroup(STAT_GROUP_SPELLS, [[1, 21, 44], [2, 22, 9]]));
  eq('spell abilities land', c.abilityOf('create food'), 44);
  const k = c.abilitiesKnown();
  eq('and are filed as spells, not skills', k.spells.map(s => s.name), ['create food', 'blast']);
  eq('with skills left alone', k.skills, []);
}

// ------------------------------------------------------------------ the record

console.log('\nthe durable record');
{
  const b = emptyBook('Kermit');
  const t0 = 1_000_000;
  let moved = mergeAbilities(b, { skills: [{ name: 'axe wielding', id: 11, ability: 37 }] },
                             { why: 'read', at: t0 });
  // Otherwise a fresh character looks like it just learned everything it knows.
  eq('a first sighting is not logged as a gain', moved, []);
  eq('but it is stored', b.skills['axe wielding'].ability, 37);

  moved = mergeAbilities(b, { skills: [{ name: 'axe wielding', id: 11, ability: 40 }] },
                         { why: 'read', at: t0 + 1000 });
  eq('a rise is logged', moved.map(m => [m.name, m.from, m.to]), [['axe wielding', 37, 40]]);
  eq('and kept in the history', b.history.length, 1);

  // Atrophy. What you stop using decays when the advancement window rolls over, and a
  // record that only ever took the maximum would hide the one thing worth seeing.
  moved = mergeAbilities(b, { skills: [{ name: 'axe wielding', id: 11, ability: 36 }] },
                         { why: 'read', at: t0 + 2000 });
  eq('a fall is logged too, not discarded as noise', moved[0].by, -4);
  eq('the current value follows it down', b.skills['axe wielding'].ability, 36);
  eq('while the peak is remembered, which is what makes atrophy visible',
     b.skills['axe wielding'].best, 40);
}

console.log('\nwhat a partial read must not do');
{
  const b = emptyBook('Kermit');
  mergeAbilities(b, { skills: [{ name: 'slash', id: 13, ability: 20 }],
                      spells: [{ name: 'blast', id: 22, ability: 9 }] }, { why: 'read' });
  // Refreshing one group alone must not wipe the other. An absent entry means "not
  // read", never "zero" — a client asked only for skills sends nothing about spells.
  mergeAbilities(b, { skills: [{ name: 'slash', id: 13, ability: 21 }] }, { why: 'read' });
  eq('refreshing skills alone leaves spells intact', b.spells.blast.ability, 9);
  eq('and the skill still moved', b.skills.slash.ability, 21);
  ok('nothing was invented for the group that was not read',
     Object.keys(b.spells).length === 1, JSON.stringify(b.spells));
}

console.log('\na pushed advancement goes into the same record');
{
  const b = emptyBook('Kermit');
  mergeAbilities(b, { skills: [{ name: 'slash', id: 13, ability: 20 }] }, { why: 'read', at: 5000 });
  const readAt = b.read_at.skills;
  const moved = noteAdvancement(b, { what: 'skill', name: 'slash', id: 13, to: 21, pushed: true }, 6000);
  eq('it is logged as advancement', moved.map(m => [m.from, m.to, m.why]), [[20, 21, 'advanced']]);
  eq('and stored', b.skills.slash.ability, 21);
  // The safety-net sweep must not be postponed for ever by a busy character: a push
  // is evidence about ONE number, not about the group.
  eq('a push does not count as a fresh read of the group', b.read_at.skills, readAt);
}

console.log('\nfreshness');
{
  const now = Date.now();
  ok('never read is not fresh', !isFresh({ abilitiesAt: { skills: null, spells: null } }));
  ok('just read is fresh', isFresh({ abilitiesAt: { skills: now, spells: now } }));
  ok('long ago is not', !isFresh({ abilitiesAt: { skills: now - DEFAULT_MAX_AGE_MS - 1, spells: now } }));
  // The two groups are asked for separately, so one can be current while the other
  // has never been read at all.
  ok('one group current is not both current',
     !isFresh({ abilitiesAt: { skills: now, spells: null } }));
  ok('but asking only about that group is', isFresh({ abilitiesAt: { skills: now, spells: null } },
                                                    { kinds: 'skills' }));
}

{
  // UNREADABLE IS NOT EMPTY (prod 2026-10-27): a fresh keeper's empty spell list, with a record on disk that names
  // spells, is answered null with a reason -- an empty list turned practice off on six characters.
  const { readFileSync } = await import('node:fs');
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the abilities tool answers an unread spell list with null and a reason, not []',
     /if \(!b\.entries && keptSpells\) \{ out\.spells = null; out\.spells_unreadable =/.test(broker)
     && /if \(!b\.entries && keptSkills\) \{ out\.skills = null; out\.skills_unreadable =/.test(broker));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
