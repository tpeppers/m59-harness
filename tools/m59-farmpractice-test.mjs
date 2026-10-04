// Offline guard for tools/m59-farmpractice.mjs and the practice-while-farming fleetscript.
// Opens no socket, touches no roster.
//
//   node tools/m59-farmpractice-test.mjs
import assert from 'node:assert/strict';
import { planFarmPractice, practiceMatches, SELF_SAFE_PARENTS } from './m59-farmpractice.mjs';
import { script } from './fleetscripts/practice-while-farming.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

// Beaker (t6), 2026-10-04, as the abilities tool and the autopilot status reported him.
const beaker = [
  { name: 'cloak', ability: 30, school: 'Qor', mana: 5, targets: 1 },
  { name: 'darkness', ability: 18, school: 'Qor', mana: 8, targets: 0 },
  { name: 'detect good', ability: 14, school: 'Qor', mana: 10, targets: 1 },
  { name: 'super strength', ability: 32, school: 'Kraanan', mana: 10, targets: 1 },
  { name: 'bless', ability: 70, school: 'Kraanan', mana: 6, targets: 1 },
  { name: 'relay', ability: 50, school: 'Kraanan', mana: 1, targets: 1 },
];
const farming = { assignedRoom: 537, confineRooms: null, touchSpell: null,
  buffAllies: { enabled: true, spells: ['super strength', 'bless'], gap_ms: 20000 },
  practiceSpells: { spells: [{ name: 'relay', target: 'fleetmate', min_vigor: 150 }, { name: 'create food' }], rooms: [2] } };
const pack = { 'entroot berry': 46 };
const plan = (over = {}) => planFarmPractice({ school: 'qor', known: beaker, policy: farming, maxMana: 25,
  pack: i => pack[i] ?? 0, ...over });

ok('weakest first, so practice drills the spell with most to learn', () => {
  const p = plan();
  assert.equal(p.ok, true, p.why);
  assert.deepEqual(p.order, ['detect good', 'darkness', 'cloak']);
});
ok('the mana floor keeps the dearest buff castable: super strength 10 + 4 = 14', () => {
  assert.equal(plan().practice.mana_floor, 14);
  assert.equal(plan({ floor: 20 }).practice.mana_floor, 20, 'a floor given raises it');
  assert.equal(plan({ floor: 5 }).practice.mana_floor, 14, 'and never lowers it');
  const touch = plan({ policy: { ...farming, touchSpell: 'acid touch' } });
  assert.equal(touch.practice.mana_floor, 14, 'acid touch 10 + 4 ties super strength');
  const noBuffs = plan({ policy: { ...farming, buffAllies: null } });
  assert.equal(noBuffs.practice.mana_floor, 0, 'nothing else casts, so all mana is spare');
});
ok('a buff the character does not know does not raise the floor', () => {
  const p = plan({ policy: { ...farming, buffAllies: { enabled: true, spells: ['magic shield'] } } });
  assert.equal(p.practice.mana_floor, 0);
});
ok('self-target spells are cast on self; a room enchantment on nothing', () => {
  const s = plan().practice.spells;
  assert.deepEqual(s.slice(0, 3), [{ name: 'detect good', target: 'self' }, { name: 'darkness' }, { name: 'cloak', target: 'self' }]);
});
ok('other schools\' practice is kept after this school\'s, with its rooms', () => {
  const p = plan().practice;
  assert.deepEqual(p.spells.slice(3).map(e => e.name), ['relay', 'create food']);
  assert.deepEqual([...p.rooms].sort((a, b) => a - b), [2, 537]);
  const alone = plan({ keepOthers: false }).practice;
  assert.equal(alone.spells.length, 3);
  assert.deepEqual(alone.rooms, [537]);
});
ok('a curse or a hold is never practised: it would land on our own character', () => {
  const p = plan({ known: [...beaker, { name: "kataholl's curse", ability: 5, school: 'Qor', mana: 10, targets: 1 },
                                     { name: 'hold', ability: 3, school: 'Qor', mana: 15, targets: 1 }] });
  assert.ok(!p.order.includes('hold'), 'hold (a creature-target Spell) is left out');
  assert.ok(p.report.some(r => /^hold: a Spell/.test(r)), 'and the report says why');
  assert.ok(SELF_SAFE_PARENTS.has('TouchAttackSpell') && !SELF_SAFE_PARENTS.has('WallSpell'));
});
ok('acid touch (a touch buff) IS practised, on self', () => {
  const p = plan({ known: [...beaker, { name: 'acid touch', ability: 9, school: 'Qor', mana: 10, targets: 1 }] });
  assert.equal(p.order[0], 'acid touch');
  assert.deepEqual(p.practice.spells[0], { name: 'acid touch', target: 'self' });
});
ok('a maxed spell is left out', () => {
  const p = plan({ known: beaker.map(s => s.name === 'cloak' ? { ...s, ability: 99 } : s) });
  assert.ok(!p.order.includes('cloak'));
});
ok('a short reagent is reported, not hidden: Beaker carries no fairy wings', () => {
  const r = plan().report.join(' | ');
  assert.match(r, /detect good 14%: 10 mana -- SHORT fairy wing \(needs 1, has 0\)/);
  assert.match(r, /cloak 30%: 5 mana(?! -- SHORT)/);
});
ok('refuses what could never fire, and says the arithmetic', () => {
  const p = plan({ maxMana: 15 });
  assert.equal(p.ok, false);
  assert.match(p.why, /max mana 15 less the 14 floor leaves 1, and the cheapest qor spell costs 5/);
});
ok('refuses a school the character does not know, and no farming room', () => {
  assert.match(plan({ school: 'faren' }).why, /knows no faren spells/);
  assert.match(plan({ policy: { ...farming, assignedRoom: null } }).why, /no farming room/);
  assert.deepEqual(plan({ policy: { ...farming, assignedRoom: null, confineRooms: [39, 38] } }).practice.rooms.slice(0, 2), [39, 38]);
});
ok("only= limits the list, and the apostrophe in shal'ille is ignored", () => {
  assert.deepEqual(plan({ only: ['cloak'] }).order, ['cloak']);
  const sh = planFarmPractice({ school: "shal'ille", known: [{ name: 'bless', ability: 1, school: 'Shal’ille', mana: 6, targets: 1 }],
    policy: { assignedRoom: 2 }, maxMana: 30 });
  assert.equal(sh.ok, true, sh.why);
});
ok('practiceMatches reads back names in order, floor, gap and rooms', () => {
  const p = plan().practice;
  assert.equal(practiceMatches(JSON.parse(JSON.stringify(p)), p), true);
  assert.equal(practiceMatches({ ...p, mana_floor: 0 }, p), false);
  assert.equal(practiceMatches({ ...p, spells: [...p.spells].reverse() }, p), false);
  assert.equal(practiceMatches(null, p), false);
});
ok('the fleetscript: a posture that waives only the keeper lease, with a reason, and reads back', () => {
  assert.deepEqual(script.unsafe.waives, ['keeperLease']);
  assert.ok(script.unsafe.reason.length > 20);
  assert.equal(script.params.school.required, true);
  const steps = script.steps({ agents: 't6', school: 'qor', gap_s: 60 });
  assert.deepEqual(steps.map(s => s.do), ['verify', 'verify'], 'no walk, no act: nothing moves');
});

console.log(`\n${n} passed`);
