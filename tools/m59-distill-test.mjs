#!/usr/bin/env node
// THE GOAP DISTILLER, OFFLINE. Pins tools/m59-distill.mjs (the decision core) and the DRY contract of
// tools/m59-distill-run.mjs against a fake broker on loopback. Opens no socket to a real broker, touches no roster;
// reads only the committed spawn index, merchant catalogue and spell catalogue.
//
//   node tools/m59-distill-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, observation, config, farmSource, farmKarmaOk, karmaWant, trainingQuarry, historyGate,
         practiceFor, roomHasCreatures, sameDrill, formatDecision, buySource } from './m59-distill.mjs';
import { loadSpawns } from './m59-spawns.mjs';
import { loadSourcingData } from './m59-sourcing-lib.mjs';
import { loadCatalogue, spellCost } from './m59-deskpractice.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const spawns = loadSpawns(join(REPO, 'substrate', 'm59-spawns.json'));
const sourcing = loadSourcingData();
const catalogue = loadCatalogue();
const DATA = { spawns, sourcing, catalogue, chests: [] };
const HOME = 50;   // no generator list: practice_creatures is given explicitly where it matters

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// ------------------------------------------------------------------------------------------- fixtures

// A Kraanan caster at level 2, planning night vision (Kraanan 3) and 41 points short of it.
const KRAANAN = [
  { name: 'bless', school: 'Kraanan', ability: 60 },
  { name: 'super strength', school: 'Kraanan', ability: 45 },
  { name: 'haste', school: 'Kraanan', ability: 20 },
];
const gatedLearning = (over = {}) => ({
  progress: { target: 'Kraanan', current_level: 2, next_level: 3, points: 41 },
  planned: { configured: 1, active_stage: 0, next: null,
             active: [{ name: 'night vision', kind: 'spell', level: 3, remaining_required: 41, expected_buyable: false }],
             abilities: [{ name: 'night vision', kind: 'spell', level: 3, remaining_required: 41 }] },
  ...over,
});
const buyableLearning = (teacher = { name: 'Rook', room: 154 }, price = 1000) => ({
  progress: { target: 'weaponcraft', current_level: 1, next_level: 2, points: 0 },
  planned: { configured: 1, active_stage: 0,
             next: { name: 'parry', kind: 'skill', level: 2, price, teacher, expected_buyable: true },
             active: [{ name: 'parry', kind: 'skill', level: 2, remaining_required: 0, expected_buyable: true, price, teacher }],
             abilities: [] },
});
const row = (agent, over = {}) => ({
  agent, character: agent.toUpperCase(), in_roster: true, room_num: HOME, health: '60/60', mana: '50/50', vigor: 120,
  purse: 2000, banked: { balance: 10000, account: 'Tos' }, pack: { percent: 40 }, has_weapon: true,
  pack_items: [{ name: 'mushroom', amount: 60 }, { name: 'sapphire', amount: 40 }, { name: 'orc tooth', amount: 30 },
               { name: 'edible mushroom', amount: 100 }],
  policy: {}, learning: gatedLearning(), ...over,
});
const obs = (r, extra = {}) => observation(r, { spells: KRAANAN, karma: 10, ...extra });
const run = (characters, cfg = {}, history = [], data = DATA) =>
  decide({ characters, config: { home: HOME, practice_creatures: false, ...cfg }, data, history, now: 1_000_000_000_000 });
const of = (out, agent) => out.decisions.find(d => d.agent === agent);
const kind = (out, agent) => of(out, agent)?.action?.kind ?? null;
// The live practice_spells a character would hold after the distiller pushed for it (for idempotence).
const pushed = (o, cfg = {}) => practiceFor(o, config({ home: HOME, ...cfg }), catalogue, { creatures: cfg.practice_creatures ?? false }).practice;

// ------------------------------------------------------------------------------------------- (a) skips

await ok('(a) excluded, not in roster, not in game, piloted, dead, hurt, committed, ordered, no plan: no action', () => {
  const chars = [
    obs(row('ex')), obs(row('nr', { in_roster: false })), obs(row('og', { room_num: null, in_game: false })),
    obs(row('pi', { piloted: { pid: 1 } })), obs(row('hh', { human_held: true })), obs(row('de', { health: '0/60' })),
    obs(row('hu', { health: '40/60' })), obs(row('co', { committed: { kind: 'loot run', takeable: false } })),
    obs(row('mo', { ordered_by: 'fleetscript:raid' })), obs(row('np', { learning: null })),
  ];
  const out = run(chars, { exclude: ['ex'] });
  for (const d of out.decisions) assert.equal(d.action, null, `${d.agent}: ${d.why}`);
  assert.match(of(out, 'ex').why, /excluded/);
  assert.match(of(out, 'pi').why, /piloted/);
  assert.match(of(out, 'hh').why, /piloted/);
  assert.match(of(out, 'de').why, /dead/);
  assert.match(of(out, 'hu').why, /hurt/);
  assert.match(of(out, 'co').why, /mid-errand/);
  assert.match(of(out, 'mo').why, /mid-errand/);
  assert.match(of(out, 'np').why, /no character plan/);
});

await ok('(a) a takeable commitment and a keeper-ordered move do not count as mid-errand', () => {
  const out = run([obs(row('t1', { committed: { kind: 'idle post', takeable: true }, ordered_by: 'keeper:farm' }))]);
  assert.equal(kind(out, 't1'), 'practice');
});

await ok('(a) an action of ours still in flight holds the character; a stale one does not', () => {
  const now = 1_000_000_000_000;
  const start = { at: now - 60_000, id: 'p1-t1-buy', agent: 't1', kind: 'buy', key: 'herb', phase: 'start' };
  assert.match(of(run([obs(row('t1'))], {}, [start]), 't1').why, /in flight/);
  const old = { ...start, at: now - 3 * 3600_000 };
  assert.equal(kind(run([obs(row('t1'))], {}, [old]), 't1'), 'practice');
});

// ------------------------------------------------------------------------------------------- (b) learn

await ok('(b) a buyable planned ability with a reachable teacher and the money: learn', () => {
  const out = run([obs(row('t1', { learning: buyableLearning() }))]);
  const a = of(out, 't1').action;
  assert.equal(a.kind, 'learn');
  assert.equal(a.skill, 'parry'); assert.equal(a.price, 1000); assert.equal(a.room, 154);
  assert.equal(out.away.granted, 1, 'a learn errand is a road action and takes an away slot');
});

await ok('(b) purse + bank counts; short of both is not a learn', () => {
  assert.equal(kind(run([obs(row('t1', { learning: buyableLearning(undefined, 1000), purse: 100, banked: { balance: 950 } }))]), 't1'), 'learn');
  const out = run([obs(row('t1', { learning: buyableLearning(undefined, 5000), purse: 100, banked: { balance: 950 } }))]);
  assert.notEqual(kind(out, 't1'), 'learn');
  assert.ok(of(out, 't1').notes.some(x => /cannot afford/.test(x)));
});

await ok('(b) an island teacher, a trap teacher and a listed-unreachable teacher are skipped, with the reason', () => {
  for (const [room, rx, cfg] of [[2005, /island/, {}], [599, /trap/, {}], [154, /listed unreachable/, { unreachable_rooms: [154] }]]) {
    const out = run([obs(row('t1', { learning: buyableLearning({ name: 'X', room }) }))], cfg);
    assert.notEqual(kind(out, 't1'), 'learn', `room ${room}`);
    assert.ok(of(out, 't1').notes.some(x => rx.test(x)), `${room}: ${of(out, 't1').notes}`);
  }
});

await ok('(b) a fragile body never takes the road, but still gets in-place actions', () => {
  const out = run([obs(row('t1', { health: '20/20', learning: { ...buyableLearning(), planned: { ...buyableLearning().planned } } }))]);
  assert.notEqual(kind(out, 't1'), 'learn');
  assert.ok(of(out, 't1').notes.some(x => /fragile/.test(x)));
  // The same body, gated by school points, is still given its (in-place) practice.
  assert.equal(kind(run([obs(row('t2', { health: '20/20' }))]), 't2'), 'practice');
});

await ok('(b) a route through the Cragged Mountains or the Ancient Place is refused for a light body only', () => {
  const route = (from, to) => [from, 578, to];
  const data = { ...DATA, route };
  const light = run([obs(row('t1', { health: '30/30', learning: buyableLearning() }))], {}, [], data);
  assert.notEqual(kind(light, 't1'), 'learn');
  assert.ok(of(light, 't1').notes.some(x => /crosses 578/.test(x)));
  assert.equal(kind(run([obs(row('t1', { health: '75/75', learning: buyableLearning() }))], {}, [], data), 't1'), 'learn');
  const none = run([obs(row('t1', { learning: buyableLearning() }))], {}, [], { ...DATA, route: () => null });
  assert.ok(of(none, 't1').notes.some(x => /no route/.test(x)), 'a destination the room graph cannot reach is refused');
});

await ok('(b) only from home, and never outside a confinement unless told to ignore it', () => {
  const away = run([obs(row('t1', { room_num: 27, learning: buyableLearning() }))]);
  assert.ok(of(away, 't1').notes.some(x => /not at home/.test(x)));
  const confined = run([obs(row('t1', { policy: { confineRooms: [50] }, learning: buyableLearning() }))]);
  assert.ok(of(confined, 't1').notes.some(x => /confined/.test(x)));
  assert.equal(kind(run([obs(row('t1', { policy: { confineRooms: [50] }, learning: buyableLearning() }))], { respect_confine: false }), 't1'), 'learn');
});

await ok('(b) a learn that may have spent money is barred; a refused one cools down, then is tried again', () => {
  const now = 1_000_000_000_000;
  const burnt = [{ at: now - 86_400_000, agent: 't1', kind: 'learn', key: 'parry', phase: 'outcome', ok: false, code: 1 }];
  const out = run([obs(row('t1', { learning: buyableLearning() }))], {}, burnt);
  assert.notEqual(kind(out, 't1'), 'learn');
  assert.ok(of(out, 't1').notes.some(x => /may have spent money/.test(x)));
  const refused = [{ at: now - 60_000, agent: 't1', kind: 'learn', key: 'parry', phase: 'outcome', ok: false, why: 'lock' }];
  assert.notEqual(kind(run([obs(row('t1', { learning: buyableLearning() }))], {}, refused), 't1'), 'learn');
  const later = [{ ...refused[0], at: now - 31 * 60_000 }];
  assert.equal(kind(run([obs(row('t1', { learning: buyableLearning() }))], {}, later), 't1'), 'learn');
  assert.equal(historyGate([], { agent: 't1', kind: 'learn', key: 'parry' }, config(), now), null);
});

// ------------------------------------------------------------------------------------------- away_limit

await ok('away_limit: three buyers at home and a limit of 1 send one; one already away sends none', () => {
  const three = ['t1', 't2', 't3'].map(a => obs(row(a, { learning: buyableLearning() })));
  const out = run(three, { away_limit: 1 });
  assert.equal(out.decisions.filter(d => d.action?.kind === 'learn').length, 1);
  assert.ok(out.decisions.filter(d => d.action?.kind !== 'learn').every(d => d.notes.some(x => /away limit/.test(x))));
  assert.equal(run(three, { away_limit: 2 }).decisions.filter(d => d.action?.kind === 'learn').length, 2);
  const out2 = run([...three, obs(row('t9', { room_num: 27 }))], { away_limit: 1 });
  assert.equal(out2.decisions.filter(d => d.action?.kind === 'learn').length, 0, 'the one already away fills the slot');
  assert.equal(out2.away.now, 1);
});

// ------------------------------------------------------------------------------------------- (c) practice

await ok('(c) gated by school points: practice, in the home room, gate spells weakest first', () => {
  const out = run([obs(row('t1'))]);
  const a = of(out, 't1').action;
  assert.equal(a.kind, 'practice');
  assert.deepEqual(a.rooms, [HOME]);
  assert.equal(a.spells[0], 'haste', 'the weakest of the best three heads the list');
  assert.ok(a.practice.enabled && a.practice.spells.length === a.spells.length);
});

await ok('(c) idempotent: the drill already in force is not pushed again, and a re-order of the same set is not a change', () => {
  const o = obs(row('t1'));
  const live = pushed(o);
  assert.notEqual(kind(run([obs(row('t1', { policy: { practiceSpells: live } }))]), 't1'), 'practice');
  const shuffled = { ...live, spells: [...live.spells].reverse() };
  assert.ok(sameDrill(shuffled, live));
  assert.notEqual(kind(run([obs(row('t1', { policy: { practiceSpells: shuffled } }))]), 't1'), 'practice');
  assert.ok(!sameDrill({ ...live, mana_floor: 9 }, live), 'a different floor is a change');
  assert.ok(!sameDrill({ ...live, enabled: false }, live), 'practice switched off is a change');
});

// A Faren caster: zap (creature-target, weakest) and light, planning resist fire.
const FAREN = [{ name: 'zap', school: 'Faren', ability: 20 }, { name: 'light', school: 'Faren', ability: 30 }];
const farenLearning = gatedLearning({
  progress: { target: 'Faren', current_level: 1, next_level: 2, points: 50 },
  planned: { configured: 1, next: null, active: [{ name: 'resist fire', kind: 'spell', level: 2, remaining_required: 50 }],
             abilities: [{ name: 'resist fire', kind: 'spell', level: 2, remaining_required: 50 }] },
});

await ok('(c) PROD 2026-11-13: in a room with no creatures (an inn) a creature-target spell is never on the list', () => {
  assert.equal(roomHasCreatures(spawns, 153), false, 'the inn at 153 has only its innkeeper');
  assert.equal(roomHasCreatures(spawns, 27), true);
  const f = row('t1', { room_num: 153, learning: farenLearning, policy: { hunt: ['orc'],
    practiceSpells: { enabled: true, rooms: [153], spells: [{ name: 'zap', target: 'creature', on: ['orc'] }, 'light'], mana_floor: 0 } } });
  const out = decide({ characters: [observation(f, { spells: FAREN, karma: 0 })], config: { home: 153 }, data: DATA, now: 1e12 });
  const a = of(out, 't1').action;
  assert.equal(a.kind, 'practice');
  assert.ok(!a.spells.includes('zap'), `zap must not be listed in an inn: ${a.spells}`);
  assert.ok(a.practice.spells.every(e => e?.target !== 'creature'));
  assert.equal(a.creatures, false);
});

await ok('(c) where creatures exist, a creature-target spell is drilled but never heads the list', () => {
  const f = row('t1', { room_num: 27, learning: farenLearning, policy: { hunt: ['orc'] } });
  const out = decide({ characters: [observation(f, { spells: FAREN, karma: 0 })], config: { home: 27 }, data: DATA, now: 1e12 });
  const a = of(out, 't1').action;
  assert.ok(a.spells.includes('zap'));
  assert.equal(a.spells[a.spells.length - 1], 'zap', `creature spells go last: ${a.spells}`);
  assert.notEqual(a.spells[0], 'zap');
});

await ok('(c) PROD 2026-11-13: the mana floor never leaves no room, and is 0 where nothing can be fought', () => {
  // An enchant-weapon knower with 21 max mana: practice-plan keeps a 17 floor, and a 10-mana spell never fits.
  const known = [...KRAANAN, { name: 'enchant weapon', school: 'Kraanan', ability: 50 }];
  const r = row('t1', { mana: '21/21', room_num: 27 });
  const inField = decide({ characters: [observation(r, { spells: known, karma: 0 })], config: { home: 27, practice_creatures: true }, data: DATA, now: 1e12 });
  const a = of(inField, 't1').action;
  assert.equal(a.kind, 'practice');
  const dearest = Math.max(...a.spells.map(s => spellCost(s, catalogue)?.mana ?? 0), 0);
  assert.ok(dearest > 4, 'the fixture lists a spell dearer than 21 - 17');
  assert.ok(a.floor <= 21 - dearest, `floor ${a.floor} must leave room for the dearest spell (${dearest})`);
  assert.ok(a.floor < 17, `the enchanter floor of 17 is capped: ${a.floor}`);
  const inn = decide({ characters: [observation({ ...r, room_num: 153 }, { spells: known, karma: 0 })], config: { home: 153 }, data: DATA, now: 1e12 });
  assert.equal(of(inn, 't1').action.floor, 0, 'an inn has nothing to fight: floor 0');
});

await ok('--only practice: a buyer is given its practice instead of the learn', () => {
  const both = { ...gatedLearning(), planned: { ...gatedLearning().planned, next: buyableLearning().planned.next } };
  assert.equal(kind(run([obs(row('t1', { learning: both }))]), 't1'), 'learn');
  assert.equal(kind(run([obs(row('t1', { learning: both }))], { only: ['practice'] }), 't1'), 'practice');
  assert.equal(kind(run([obs(row('t1', { learning: both }))], { only: ['supply'] }), 't1'), null);
});

await ok('REGRESSION deploy-2026-11-13-3: --only filters kinds and never changes the practice decision itself', () => {
  // The runner normalises its config with config() and decide() normalises it again; a Set run through
  // `[].concat` became "[object set]" and --only practice answered "nothing to do" for characters the
  // unrestricted pass was practising.
  const chars = () => [obs(row('t1')), obs(row('t17'))];
  const base = { home: HOME, practice_creatures: false };
  const plain = decide({ characters: chars(), config: config(base), data: DATA, now: 1e12 });
  for (const only of [['practice'], ['practice', 'supply']]) {
    for (const cfg of [{ ...base, only }, config({ ...base, only })]) {   // raw, and pre-normalised as the runner passes it
      const out = decide({ characters: chars(), config: cfg, data: DATA, now: 1e12 });
      for (const agent of ['t1', 't17']) {
        assert.equal(kind(out, agent), 'practice', `${only} ${cfg.only instanceof Set ? 'normalised' : 'raw'} ${agent}: ${of(out, agent).why}`);
        assert.deepEqual(of(out, agent).action, of(plain, agent).action, 'the same practice action with and without --only');
      }
    }
  }
  assert.deepEqual([...config(config({ only: ['Practice', 'supply'] })).only], ['practice', 'supply'], 'config() is idempotent');
});

// ------------------------------------------------------------------------------------------- (d) supply

// A receiver whose drill is in force and who carries no mushrooms (bless and super strength need 2 each).
const hungry = (agent, over = {}) => {
  const base = row(agent, { pack_items: [{ name: 'sapphire', amount: 40 }, { name: 'orc tooth', amount: 30 }], ...over });
  return obs({ ...base, policy: { ...(over.policy ?? {}), practiceSpells: pushed(obs(base)) } });
};

await ok('(d) a same-room donor with spare gives first; the donor keeps its own want plus max(10, 25%)', () => {
  const donor = obs(row('t9', { learning: null, pack_items: [{ name: 'mushroom', amount: 200 }] }));
  const out = run([hungry('t1'), donor]);
  const a = of(out, 't1').action;
  assert.equal(a.kind, 'supply');
  assert.equal(a.from, 't9'); assert.equal(a.item, 'mushroom');
  assert.ok(a.keep >= 50, `donor keeps at least 25% of 200: ${a.keep}`);
  assert.ok(a.amount > 0 && a.amount <= 150);
  assert.equal(of(out, 't9').action, null, 'never two actions: the donor gets none of its own this pass');
});

await ok('(d) a piloted, excluded or different-room fleet-mate is never a donor', () => {
  for (const d of [row('t9', { learning: null, piloted: { pid: 9 } }), row('t9', { learning: null, room_num: 27 })]) {
    const out = run([hungry('t1'), obs({ ...d, pack_items: [{ name: 'mushroom', amount: 200 }] })], { hall_room: null });
    assert.notEqual(of(out, 't1').action?.kind, 'supply');
  }
  const out = run([hungry('t1'), obs(row('t9', { learning: null, pack_items: [{ name: 'mushroom', amount: 200 }] }))], { exclude: ['t9'] });
  assert.notEqual(of(out, 't1').action?.kind, 'supply');
});

await ok('(d) PROD: a full receiver makes space first; once make-space has failed, a deposit is proposed', () => {
  const full = hungry('t1', { pack: { percent: 99 } });
  const donor = obs(row('t9', { learning: null, pack_items: [{ name: 'mushroom', amount: 200 }] }));
  const out = run([full, donor]);
  assert.equal(of(out, 't1').action.kind, 'make_space');
  assert.equal(of(out, 't9').action, null);
  const failed = [{ at: 1e12 - 60_000, agent: 't1', kind: 'make_space', key: 'pack', phase: 'outcome', ok: false, why: 'short_by 120' }];
  const out2 = run([full, donor], {}, failed);
  assert.equal(of(out2, 't1').action, null);
  assert.ok(of(out2, 't1').proposals.some(p => p.kind === 'deposit'));
});

await ok('(d) no donor: the hall chests, as a road action from home', () => {
  const chests = [{ room: 714, items: [{ name: 'mushroom', amount: 500 }] }, { room: 703, items: [{ name: 'mushroom', amount: 9 }] }];
  const out = run([hungry('t1')], { hall_room: 714 }, [], { ...DATA, chests });
  const a = of(out, 't1').action;
  assert.equal(a.kind, 'hall_draw'); assert.equal(a.hall, 714); assert.equal(a.item, 'mushroom');
  assert.ok(a.amount > 0 && a.amount <= 500);
  // Two receivers, a chest that covers one: the second does not draw what the first took.
  const small = [{ room: 714, items: [{ name: 'mushroom', amount: 20 }] }];
  const two = run([hungry('t1'), hungry('t2')], { hall_room: 714, away_limit: 2 }, [], { ...DATA, chests: small });
  const draws = two.decisions.filter(d => d.action?.kind === 'hall_draw').reduce((t, d) => t + d.action.amount, 0);
  assert.ok(draws <= 20, `drew ${draws} from a chest of 20`);
});

await ok('(d) no donor, no hall: an unapproved farm is a PROPOSAL and the buy goes ahead; approved, the farm runs', () => {
  const out = run([hungry('t1')]);
  const d = of(out, 't1');
  assert.equal(d.action.kind, 'buy');
  assert.equal(d.action.item, 'mushroom');
  assert.ok(d.action.room < 2000);
  assert.ok(d.proposals.some(p => p.kind === 'farm' && p.executable === false));
  const src = d.proposals.find(p => p.kind === 'farm');
  const out2 = run([hungry('t1')], { farm_allow: [{ creature: src.creature, room: src.room }] });
  assert.equal(of(out2, 't1').action.kind, 'farm');
  assert.equal(of(out2, 't1').action.creature, src.creature);
  // With buying held behind an unapproved farm, the proposal is the answer.
  const out3 = run([hungry('t1')], { buy_when_farm_unapproved: false });
  assert.equal(of(out3, 't1').action.kind, 'farm');
  assert.equal(of(out3, 't1').action.executable, false);
  assert.equal(out3.away.granted, 0, 'a proposal takes no away slot');
});

await ok('(d) PROD: a loadout pinning buy_reagents false is never sent to buy', () => {
  const base = row('t1', { pack_items: [{ name: 'sapphire', amount: 40 }, { name: 'orc tooth', amount: 30 }] });
  const o = observation({ ...base, policy: { practiceSpells: pushed(obs(base)) } }, { spells: KRAANAN, karma: 10, loadout: { buy_reagents: false } });
  const out = run([o]);
  assert.notEqual(of(out, 't1').action?.kind, 'buy');
  assert.ok(of(out, 't1').notes.some(x => /buy_reagents false/.test(x)));
  const viaPolicy = obs({ ...base, policy: { buyReagents: false, practiceSpells: pushed(obs(base)) } });
  assert.notEqual(of(run([viaPolicy]), 't1').action?.kind, 'buy');
});

await ok('(d) a fragile body may receive from a donor, but never walks to the hall, a farm or a counter', () => {
  const frail = hungry('t1', { health: '20/20' });
  assert.equal(of(run([frail, obs(row('t9', { learning: null, pack_items: [{ name: 'mushroom', amount: 200 }] }))]), 't1').action.kind, 'supply');
  const alone = run([frail], { hall_room: 714 }, [], { ...DATA, chests: [{ room: 714, items: [{ name: 'mushroom', amount: 500 }] }] });
  assert.equal(of(alone, 't1').action, null);
});

await ok('buy sources: the island and wandering sellers are never chosen', () => {
  const c = config();
  assert.equal(buySource(sourcing, 'web moss', c).best, null, 'web moss is sold only on the island');
  const herb = buySource(sourcing, 'herb', c).best;
  assert.ok(herb && herb.room < 2000);
});

// ------------------------------------------------------------------------------------------- karma

await ok('karma: a Shal\'ille character is never sent to farm what lowers its karma (living trees for entroot)', () => {
  const shal = obs(row('t1'), { spells: [{ name: 'minor heal', school: 'Shal’ille', ability: 50 }] });
  assert.equal(karmaWant(shal), 'good');
  const src = farmSource(spawns, 'entroot berry', shal, config());
  assert.ok(src.candidates.length, 'there is a safe source');
  assert.ok(src.candidates.every(s => s.karma <= 0), `no positive-karma quarry: ${src.candidates.map(s => s.creature)}`);
  assert.ok(!src.candidates.some(s => s.creature === 'living tree'));
  // Whatever the item, a good character's farm list never holds a creature whose kill pushes it evil.
  for (const item of ['herb', 'mushroom', 'elderberry', 'sapphire', 'purple mushroom'])
    assert.ok(farmSource(spawns, item, shal, config()).candidates.every(s => s.karma <= 0), item);
});

await ok('karma: a Qor character may farm living trees; karma_strict only takes what moves karma the right way', () => {
  const qor = obs(row('t1', { health: '75/75' }), { spells: [{ name: 'cloak', school: 'Qor', ability: 50 }] });
  assert.equal(karmaWant(qor), 'evil');
  const src = farmSource(spawns, 'entroot berry', qor, config());
  assert.equal(src.best?.creature, 'living tree');
  assert.ok(src.candidates.every(s => s.karma >= 0));
  const strict = obs(row('t1', { health: '75/75', policy: { karma: 'evil', karmaStrict: true } }), { spells: [] });
  for (const item of ['herb', 'mushroom', 'entroot berry'])
    assert.ok(farmSource(spawns, item, strict, config()).candidates.every(s => s.karma > 0), `strict ${item}`);
  assert.equal(farmKarmaOk(null, 'good'), false, 'unknown karma is not assigned when a direction is protected');
  assert.equal(farmKarmaOk(null, null), true);
  assert.equal(farmKarmaOk(0, 'good'), true);
  assert.equal(farmKarmaOk(0, 'good', true), false, 'strict refuses a karma-neutral kill too (the keeper would)');
});

await ok('farm safety: smallest creature first, and nothing in the room above the band', () => {
  const small = obs(row('t1', { health: '30/30' }), { spells: [] });
  const src = farmSource(spawns, 'herb', small, config());
  assert.ok(src.best);
  assert.equal(src.best.creature, 'baby spider', 'the softest herb dropper');
  assert.ok(src.candidates.every(s => s.room_worst <= 30 && s.level <= 30));
  assert.ok(src.candidates.every(s => s.room < 2000 && s.room !== 599));
  assert.ok(!src.candidates.some(s => s.room === 534), '534 also generates level-50 living trees');
  for (let i = 1; i < src.candidates.length; i++) assert.ok(src.candidates[i - 1].level <= src.candidates[i].level);
});

// ------------------------------------------------------------------------------------------- (e) train

await ok('(e) a weaponcraft skill short of points: a training proposal, karma-safe and in band, taking no slot', () => {
  const learning = { progress: { target: 'weaponcraft', points: 30 },
    planned: { configured: 1, next: null, active: [{ name: 'parry', kind: 'skill', level: 2, remaining_required: 30 }], abilities: [] } };
  const out = run([obs(row('t1', { learning }), { spells: [{ name: 'minor heal', school: 'Shal’ille', ability: 50 }] })]);
  const a = of(out, 't1').action;
  assert.equal(a.kind, 'train'); assert.equal(a.executable, false);
  assert.ok(a.level <= 45 && a.level <= 60);
  assert.ok(a.quarry);
  assert.equal(out.away.granted, 0);
  const q = trainingQuarry(spawns, obs(row('t1'), { spells: [{ name: 'minor heal', school: 'Shal’ille', ability: 50 }] }), config());
  assert.ok(farmKarmaOk(q.best.karma, 'good'));
});

await ok('formatDecision names the action, and a skip names its reason', () => {
  const out = run([obs(row('t1', { learning: buyableLearning() })), obs(row('t2', { health: '10/60' }))]);
  assert.match(formatDecision(of(out, 't1')), /DO learn parry for 1000 at Rook \(154\)/);
  assert.match(formatDecision(of(out, 't2')), /hurt/);
});

// ------------------------------------------------------------------------------------------- the runner, DRY

await ok('runner: --fleet is required', async () => {
  const r = await node([join(HERE, 'm59-distill-run.mjs'), '--home', '50', '--once'], {});
  assert.equal(r.code, 2);
  assert.match(r.err, /--fleet/);
});

await ok('runner DRY: reads only (fleet, abilities, status), prints the plan, writes no ledger', async () => {
  const calls = [];
  const fleet = [row('t1'), row('t2', { learning: buyableLearning() }), row('t3', { piloted: { pid: 5 } })];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const { id, params } = JSON.parse(body || '{}');
      calls.push(params?.name);
      const reply = params?.name === 'fleet' ? { fleet }
        : params?.name === 'abilities' ? { spells: KRAANAN }
        : params?.name === 'status' ? { karma: { value: 10 } }
        : { error: `the DRY runner must not call ${params?.name}` };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const fleetName = `distilltest${process.pid}`;
  const ledger = join(REPO, 'substrate', `distill-${fleetName}.jsonl`);
  const tmp = mkdtempSync(join(tmpdir(), 'distill-'));
  try {
    const r = await node([join(HERE, 'm59-distill-run.mjs'), '--fleet', fleetName, '--home', '50', '--once'], {
      M59_CONTROL_URL: `http://127.0.0.1:${server.address().port}/`, M59_LOADOUT_DIR: tmp, M59_MAP_FILE: join(tmp, 'none.json') });
    assert.equal(r.code, 0, r.err || r.out);
    assert.match(r.out, /DRY pass/);
    assert.match(r.out, /t1 \(T1\): DO practice/);
    assert.match(r.out, /t2 \(T2\): DO learn parry/);
    assert.match(r.out, /t3 \(T3\): -- piloted/);
    const mutating = calls.filter(c => !['fleet', 'abilities', 'status'].includes(c));
    assert.deepEqual(mutating, [], `only reads: ${calls}`);
    assert.ok(!calls.includes('abilities') || calls.filter(c => c === 'abilities').length === 2, 'a piloted character is not even read');
    assert.equal(existsSync(ledger), false, 'a DRY pass writes no ledger');
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(ledger)) rmSync(ledger);
  }
});

function node(args, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, cwd: REPO });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const t = setTimeout(() => p.kill(), 120_000);
    p.on('exit', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

console.log(`\n${n} passed`);
