// Offline guard for tools/m59-practice-plan.mjs and the practice-plan fleetscript.
// Opens no socket, touches no roster; reads only the committed kod spell catalogue.
//
//   node tools/m59-practice-plan-test.mjs
import assert from 'node:assert/strict';
import { planPractice, categorise, courierRequestPlan, mergeCourierRequests, karmaAllows, schoolKey, itemKey,
         NEVER_DRILL, nameKey, REST_VIGOR_CAP, ENCHANT_FLOOR } from './m59-practice-plan.mjs';
import { normalizePractice } from './m59-deskpractice.mjs';
import { script, yes } from './fleetscripts/practice-plan.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

// A Kraanan/Shal'ille farmer in the shape the abilities tool returns, school names as the wire
// sends them (curly apostrophe), levels omitted so the catalogue supplies them.
const known = [
  { name: 'bless', school: 'Kraanan', ability: 60 },
  { name: 'super strength', school: 'Kraanan', ability: 45 },
  { name: 'haste', school: 'Kraanan', ability: 20 },
  { name: 'enchant weapon', school: 'Kraanan', ability: 70 },
  { name: 'relay', school: 'Kraanan', ability: 80 },
  { name: 'create food', school: 'Kraanan', ability: 50 },
  { name: 'minor heal', school: 'Shal’ille', ability: 99 },
  { name: 'detect evil', school: 'Shal’ille', ability: 40 },
  { name: 'holy symbol', school: 'Shal’ille', ability: 55 },
  { name: 'seance', school: 'Shal’ille', ability: 30 },
];
const pack = [{ name: 'mushroom', amount: 50 }, { name: 'orc tooth', amount: 2 }, { name: 'herbs', amount: 3 },
              { name: 'sapphire', amount: 40 }, { name: 'elderberry', amount: 60 }, { name: 'fairy wing', amount: 20 }];
const policy = { assignedRoom: 599, confineRooms: [579],
                 practiceSpells: { enabled: true, rooms: [599, 350], spells: ['glow', { name: 'create food' }], mana_floor: 5 } };
const planner = { planned: { abilities: [{ name: 'night vision', kind: 'spell', level: 3, remaining_required: 41 }] } };
const plan = (over = {}) => planPractice({ known, pack, maxMana: 60, vigor: 70, karma: 30, policy, planner, ...over });

ok("a school named with the wire's curly apostrophe is the same school as shal'ille", () => {
  assert.equal(schoolKey('Shal’ille'), 'shalille');
  assert.equal(schoolKey("Shal'ille"), schoolKey('shalille'));
  const p = plan({ options: { schools: ["shal'ille"] } });
  assert.deepEqual(p.gates.map(g => g.school_key), ['shalille'], 'the only gate is the one asked for, matched across apostrophes');
  assert.equal(p.gates[0].level, 1);
  assert.deepEqual(p.gates[0].drill, ['detect evil', 'holy symbol'], 'minor heal at 99 counts toward the gate and is not drilled');
});

ok('gate order: the best three at the top level, weakest first, planned school first, then the rest weakest first', () => {
  const p = plan();
  const k = p.gates.find(g => g.school_key === 'kraanan');
  assert.equal(k.level, 2); assert.equal(k.target_level, 3);
  assert.deepEqual(k.best_three.map(b => b.name), ['enchant weapon', 'bless', 'super strength']);
  assert.equal(k.have, 175);
  assert.equal(k.points_short, 41, "the planner's remaining_required for a planned level-3 Kraanan spell");
  assert.equal(k.planned, true);
  assert.deepEqual(p.order.slice(0, 4), ['super strength', 'bless', 'detect evil', 'holy symbol'],
    'Kraanan is planned, so its gate comes before the Shal\'ille gate; each weakest first');
  assert.deepEqual(p.order.slice(4), ['haste', 'seance', 'relay'], 'everything else drillable, weakest first');
  assert.equal(p.spells.find(s => s.name === 'super strength').role, 'gate');
  assert.equal(p.spells.find(s => s.name === 'haste').role, 'rest');
});

ok('among gates of equal standing, the one closest to opening comes first; an open one last', () => {
  const both = { planned: { abilities: [
    { name: 'night vision', kind: 'spell', level: 3, remaining_required: 41 },
    { name: 'resist acid', kind: 'spell', level: 2, remaining_required: 12 }] } };
  assert.deepEqual(plan({ planner: both }).order.slice(0, 4), ['detect evil', 'holy symbol', 'super strength', 'bless'],
    "Shal'ille is 12 short and Kraanan 41: Shal'ille's gate leads");
  const open = { planned: { abilities: [
    { name: 'night vision', kind: 'spell', level: 3, remaining_required: 41 },
    { name: 'resist acid', kind: 'spell', level: 2, remaining_required: 0 }] } };
  assert.deepEqual(plan({ planner: open }).order.slice(0, 2), ['super strength', 'bless'],
    "a gate already open is moved by a purchase, not a drill: it goes after the one still shut");
});

ok('a stuck best-three member is benched past only when nothing drillable is left in the best three', () => {
  const k = known.map(s => s.name === 'bless' || s.name === 'super strength' ? { ...s, ability: 99 } : s);
  const p = plan({ known: k });
  const g = p.gates.find(x => x.school_key === 'kraanan');
  assert.deepEqual(g.drill, []);
  assert.deepEqual(g.bench, ['haste'], 'haste counts the day it passes enchant weapon');
  assert.deepEqual(p.order.slice(0, 3), ['detect evil', 'holy symbol', 'haste'], 'the bench follows every gate');
});

ok('the never-drill set: hard ones are dropped even when listed, soft ones kept only when somebody listed them', () => {
  for (const s of ['blink', 'rescue', 'create food', 'poison fog', 'darkness', 'fade', 'enchant weapon', 'hospice', 'identify', 'animate'])
    assert.ok(NEVER_DRILL[nameKey(s)], `${s} is on the never list`);
  const p = plan();
  assert.ok(!p.order.includes('create food'), 'create food was listed and is still dropped (hard)');
  assert.ok(!p.order.includes('enchant weapon'), 'enchant weapon is not added');
  const listedEW = plan({ policy: { ...policy, practiceSpells: { ...policy.practiceSpells, spells: ['enchant weapon'] } } });
  assert.ok(listedEW.order.includes('enchant weapon'), 'a soft never somebody listed by hand stays');
  const listedBlink = plan({ known: [...known, { name: 'blink', school: 'Riija', ability: 10 }],
                             policy: { ...policy, practiceSpells: { ...policy.practiceSpells, spells: ['blink'] } } });
  assert.ok(!listedBlink.order.includes('blink'), 'a teleport is never drilled, listed or not');
  assert.equal(categorise({ name: 'poison fog' }).drillable, false);
  assert.equal(categorise({ name: 'resist acid' }).target, 'self');
  assert.equal(categorise({ name: 'holy touch' }).target, 'none');
  assert.equal(categorise({ name: "kara'hol's curse" }).drillable, false, 'a creature spell with no quarry is not drillable');
  assert.deepEqual(categorise({ name: "kara'hol's curse" }, { quarry: ['troll'] }).target, 'creature');
  assert.equal(categorise({ name: 'umbrella' }).target, 'self', 'an unlisted PersonalEnchantment falls back to self');
  assert.equal(categorise({ name: 'mark of dishonor' }).kind, 'unknown', 'a harmful spell with no proven target is left out');
});

ok('enchant weapon knowers keep a 17 mana floor; others keep the floor they had', () => {
  assert.equal(ENCHANT_FLOOR, 17);
  assert.equal(plan().mana.floor, 17);
  const noEW = plan({ known: known.filter(s => s.name !== 'enchant weapon') });
  assert.equal(noEW.mana.floor, 5, 'the floor already set');
  assert.equal(plan({ options: { floor: 25 } }).mana.floor, 25, 'a floor given above 17 wins');
  assert.equal(plan({ options: { floor: 3 } }).mana.floor, 17, 'and never takes it under enchant weapon');
  const buffs = plan({ known: known.filter(s => s.name !== 'enchant weapon'), options: { floor: 0 },
                       policy: { ...policy, buffAllies: { enabled: true, spells: ['super strength'] } } });
  assert.equal(buffs.mana.floor, 14, 'super strength 10 + 4, the buff floor m59-farmpractice derives');
});

ok('relay: min_vigor above the 80 rest cap, vigor short now, and a reagent that is food', () => {
  assert.equal(REST_VIGOR_CAP, 80);
  const p = plan();
  const relay = p.practice.spells.find(e => e.name === 'relay');
  assert.deepEqual(relay, { name: 'relay', target: 'fleetmate', min_vigor: 110 });
  const kinds = p.blockers.filter(b => b.spell === 'relay').map(b => b.kind);
  assert.ok(kinds.includes('min_vigor_above_rest_cap'));
  assert.ok(kinds.includes('vigor_short_now'), 'vigor 70 under 110');
  assert.ok(kinds.includes('reagent_is_food'), "relay's Snack is the edible mushroom");
  const low = plan({ vigor: 150, options: { relayMinVigor: 60 } });
  assert.ok(!low.blockers.some(b => b.kind === 'min_vigor_above_rest_cap' || b.kind === 'vigor_short_now'));
});

ok('reagent need: per cast, on hand across plural/spacing, kept, wanted for N casts, shortfall', () => {
  assert.equal(itemKey('orctooth'), itemKey('orc tooth'));
  assert.equal(itemKey('orc teeth'), itemKey('orc tooth'));
  assert.equal(itemKey('herbs'), itemKey('herb'));
  assert.notEqual(itemKey('mushroom'), itemKey('purple mushroom'));
  const p = plan({ options: { stockCasts: 10, restCasts: 2 } });
  const r = Object.fromEntries(p.reagents.map(x => [itemKey(x.item), x]));
  // super strength: 2 mushroom + 1 orc tooth (gate, 10 casts); bless: 2 mushroom + 2 sapphire (gate);
  // haste: 5 edible mushroom (rest, 2 casts); seance 2 herbs (rest); relay 1 edible mushroom (rest).
  assert.equal(r[itemKey('orc tooth')].per_cast, 1);
  assert.equal(r[itemKey('orc tooth')].on_hand, 2);
  assert.equal(r[itemKey('orc tooth')].wanted, 10);
  assert.equal(r[itemKey('orc tooth')].shortfall, 8);
  assert.equal(r[itemKey('mushroom')].wanted, 40, '2 x 10 for super strength + 2 x 10 for bless');
  assert.equal(r[itemKey('mushroom')].shortfall, 0, '50 on hand');
  assert.equal(r[itemKey('herb')].on_hand, 3, '"herbs" in the pack is the catalogue\'s Herbs');
  assert.equal(r[itemKey('edible mushroom')].wanted, 5 * 2 + 1 * 2);
  assert.deepEqual(r[itemKey('edible mushroom')].blocks.sort(), ['haste', 'relay']);
  const kept = plan({ options: { stockCasts: 10, restCasts: 2 },
                      policy: { ...policy, practiceSpells: { ...policy.practiceSpells, keep: { 'orc tooth': 2 } } } });
  const t = kept.reagents.find(x => itemKey(x.item) === itemKey('orc tooth'));
  assert.equal(t.kept, 2); assert.equal(t.wanted, 12); assert.deepEqual(t.blocks, ['super strength'], 'both teeth are kept back');
});

ok('reserve_leaves_no_room: max mana less the floor under the cheapest listed spell', () => {
  const p = plan({ maxMana: 20 });
  const b = p.blockers.find(x => x.kind === 'reserve_leaves_no_room');
  assert.ok(b, JSON.stringify(p.blockers));
  assert.match(b.why, /max mana 20 less the 17 reserve .* leaves 3/);
  const fine = plan({ maxMana: 25 });
  assert.ok(!fine.blockers.some(x => x.kind === 'reserve_leaves_no_room'));
  assert.ok(fine.blockers.some(x => x.kind === 'never_affordable' && x.spell === 'super strength'), '10 mana against 8 spare');
});

ok('karma: a Qor spell above its ceiling is refused with no mana spent, so it is not listed', () => {
  assert.equal(karmaAllows(-40, -30), false); assert.equal(karmaAllows(-40, -45), true);
  assert.equal(karmaAllows(20, 30), true); assert.equal(karmaAllows(-20, null), null);
  const qor = [{ name: 'cloak', school: 'Qor', ability: 50 }, { name: 'acid touch', school: 'Qor', ability: 30 },
               { name: 'hold', school: 'Qor', ability: 10 }];
  const p = planPractice({ known: qor, pack: [{ name: 'entroot berry', amount: 50 }, { name: 'purple mushroom', amount: 20 }],
                           maxMana: 60, karma: -30, policy: { assignedRoom: 599, hunt: 'troll' } });
  assert.ok(!p.order.includes('hold'), 'hold needs karma <= -40');
  assert.ok(p.blockers.some(b => b.kind === 'karma' && b.spell === 'hold'));
  const evil = planPractice({ known: qor, pack: [], maxMana: 60, karma: -45, policy: { assignedRoom: 599, hunt: 'troll' } });
  assert.equal(evil.order[0], 'hold', 'at -45 the level-4 gate spell leads');
  assert.deepEqual(evil.practice.spells[0], { name: 'hold', target: 'creature', on: ['troll'] }, 'quarry from the hunt');
});

ok('listed entries keep their own fields; unknown listed spells are dropped and said; the config passes normalizePractice', () => {
  const pol = { ...policy, practiceSpells: { enabled: true, rooms: [2], gap_ms: 30000, refused_ms: 120000,
    spells: [{ name: 'bless', target: 'self', room: 38, session_ms: 60000 }, 'glow'] } };
  const p = plan({ policy: pol });
  assert.deepEqual(p.practice.spells.find(e => e.name === 'bless'), { name: 'bless', target: 'self', room: 38, session_ms: 60000 });
  assert.deepEqual(p.practice.rooms, [2], 'rooms kept unless given');
  assert.equal(p.practice.gap_ms, 30000); assert.equal(p.practice.refused_ms, 120000);
  assert.ok(p.blockers.some(b => b.kind === 'not_known' && b.spell === 'glow'));
  assert.deepEqual(normalizePractice(p.practice).problems, []);
  assert.deepEqual(plan({ options: { rooms: [599, 579] } }).practice.rooms, [599, 579]);
  const noRooms = plan({ policy: { practiceSpells: null } });
  assert.equal(noRooms.ok, false); assert.match(noRooms.why, /no room/);
});

ok('courier requests: shopping lines only, never lowered; the rest is a wishlist', () => {
  const shopping = [{ item: 'herb' }, { item: 'orc tooth' }, { item: 'sapphire' }];
  const reagents = [{ item: 'herb', key: itemKey('herb'), wanted: 40, shortfall: 37 },
                    { item: 'orctooth', key: itemKey('orctooth'), wanted: 20, shortfall: 18 },
                    { item: 'sapphire', key: itemKey('sapphire'), wanted: 40, shortfall: 0 },
                    { item: 'edible mushroom', key: itemKey('edible mushroom'), wanted: 12, shortfall: 12 }];
  const existing = { t2: { herb: 140 }, t3: { emerald: 80 } };
  const c = courierRequestPlan({ agent: 't2', reagents, shopping, existing });
  assert.deepEqual(c.requests, [
    { item: 'herb', count: 140, was: 140, shortfall: 37, change: 'keep' },
    { item: 'orc tooth', count: 20, was: null, shortfall: 18, change: 'new' }]);
  assert.deepEqual(c.wishes, [{ item: 'edible mushroom', count: 12, shortfall: 12 }]);
  const m = mergeCourierRequests({ agent: 't2', plan: c, requests: existing, wishlist: {}, at: 1 });
  assert.deepEqual(m.requests, { t2: { herb: 140, 'orc tooth': 20 }, t3: { emerald: 80 } });
  assert.deepEqual(m.wishlist, { t2: { 'edible mushroom': { count: 12, at: 1, by: 'practice-plan' } } });
  assert.deepEqual(existing, { t2: { herb: 140 }, t3: { emerald: 80 } }, 'pure: the input is not mutated');
});

ok('the fleetscript: dry by default, waives only the keeper lease with a reason, and parses REPL booleans', () => {
  assert.equal(script.name, 'practice-plan');
  assert.equal(script.params.apply.default, false);
  assert.deepEqual(script.unsafe.waives, ['keeperLease']);
  assert.ok(script.unsafe.reason.length > 20);
  assert.equal(yes('false'), false); assert.equal(yes('true'), true); assert.equal(yes(true), true); assert.equal(yes(null), false);
  const steps = script.steps({ agents: ['t1'] });
  assert.equal(steps.length, 2); assert.ok(steps.every(s => s.do === 'verify'));
});

console.log(`\n${n} passed`);
