#!/usr/bin/env node
// Offline tests for tools/fleetscripts/max-faction-shield.mjs — the rank line, the kills a band
// needs, which troops count for which shield, whose flagpole a room has, the search order, the
// guarded shield read (against a fake broker), and that the plan compiles with every room declared.
//
// When an M59_ROOT (or C:/code/Meridian59) tree is present the rank titles and army names are
// read from soldshld.kod and its three subclasses, so a reworded resource fails here rather than
// in a flag room.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARMIES, RANKS, shieldOf, enemiesOf, readRank, isMaxed, killsToMax, flagHolder,
         enemyHuntOrder, roomVerdict, readShield, script } from './fleetscripts/max-faction-shield.mjs';
import { trapCheck } from './m59-fleetscript.mjs';
import { WILDERNESS_FLAG_ROOMS } from './m59-factions.mjs';

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };
const okAsync = async (name, fn) => { try { await fn(); n++; } catch (e) { e.message = `${name}: ${e.message}`; throw e; } };

// ---------------------------------------------------------------- the kod, when it is here
const ROOT = process.env.M59_ROOT || 'C:/code/Meridian59';
const SHLD = join(ROOT, 'kod', 'object', 'item', 'passitem', 'defmod', 'shield');
const read = f => (existsSync(f) ? readFileSync(f, 'latin1') : null);
const base = read(join(SHLD, 'soldshld.kod'));
const rsc = (src, name) => src ? (new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(src)?.[1] ?? null) : null;

if (base) ok('rank titles match soldshld.kod', () => {
  for (let i = 1; i <= 5; i++) assert.equal(RANKS[i - 1].title, rsc(base, `SoldierShield_rank_name${i}`));
  assert.match(base, /MAX_RANK_FROM_MONSTERS = 10/);
});
if (base) ok('army names match the three subclasses', () => {
  const sub = { duke: ['dukeshld.kod', 'DukeShield'], princess: ['prinshld.kod', 'PrincessShield'],
                rebel: ['reblshld.kod', 'RebelShield'] };
  for (const [id, [file, cls]] of Object.entries(sub)) {
    const src = read(join(SHLD, 'soldshld', file));
    assert.equal(ARMIES[id].army, rsc(src, `${cls}_ArmyName`));
    assert.equal(ARMIES[id].shield, rsc(src, `${cls}_name_rsc`));
  }
});

// ---------------------------------------------------------------- the shield
const desc = (army, title) =>
  `Shields of this style show allegiance to a particular faction\n\nYour rank within ${army} is: ${title}.`;

ok('the rank line parses for every band', () => {
  for (const r of RANKS) {
    const got = readRank(desc('the ducal army', r.title));
    assert.deepEqual([got.title, got.min, got.max, got.army], [r.title, r.min, r.max, 'the ducal army']);
  }
  assert.equal(readRank('A sword.'), null);
  assert.equal(readRank(null), null);
  assert.equal(readRank(desc('the Royal army', 'a dancing bear')), null);   // an unknown title is not a guess
});

ok('only the top band is max, and the kills are a range', () => {
  const at = t => readRank(desc('the rebel militia', t));
  assert.equal(isMaxed(at('a supreme hero')), true);
  assert.equal(isMaxed(at('a great warrior')), false);
  assert.equal(isMaxed(null), false);
  assert.deepEqual(killsToMax(at('a lowly peon')), { min: 7, max: 8 });
  assert.deepEqual(killsToMax(at('an average soldier')), { min: 5, max: 6 });   // a fresh shield is rank 4
  assert.deepEqual(killsToMax(at('a great warrior')), { min: 1, max: 2 });
  assert.deepEqual(killsToMax(at('a supreme hero')), { min: 0, max: 0 });
});

ok('the shield names the faction, and nothing else does', () => {
  assert.equal(shieldOf([{ name: 'long sword' }, { name: "Shield of the Duke's army" }]).faction, 'duke');
  assert.equal(shieldOf([{ name: "shield of the Princess' army" }]).faction, 'princess');
  assert.equal(shieldOf(['shield of the rebel militia']).faction, 'rebel');
  assert.equal(shieldOf([{ name: "knight's shield" }, { name: "soldier's shield" }]), null);
  assert.equal(shieldOf([]), null);
});

ok('each army hunts the other two', () => {
  assert.deepEqual(enemiesOf('duke').map(a => a.troop), ['soldier of the Princess\' army', 'rebel soldier']);
  assert.deepEqual(enemiesOf('princess').map(a => a.troop), ["soldier of the Duke's army", 'rebel soldier']);
  assert.deepEqual(enemiesOf('rebel').map(a => a.troop), ["soldier of the Duke's army", "soldier of the Princess' army"]);
});

// ---------------------------------------------------------------- the rooms
ok('a flagpole says whose it is', () => {
  assert.equal(flagHolder('This flagpole flies the royal colors of Duke Akardius, protector of Tos.'), 'duke');
  assert.equal(flagHolder('This flagpole flies the royal colors of Princess Kateriina, rightful heir'), 'princess');
  assert.equal(flagHolder('This flagpole flies the colors of the rebel forces based in Jasper.'), 'rebel');
  assert.equal(flagHolder('This flagpole lies empty, unclaimed in the struggle between the factions'), 'none');
  assert.equal(flagHolder(''), null);
});

ok('a room is taken for enemy troops or an enemy pole, never for our own', () => {
  const objs = [{ name: 'rebel soldier' }, { name: 'dead rebel soldier' }, { name: 'flagpole' }];
  const v = roomVerdict('duke', objs, 'duke');
  assert.equal(v.take, true);
  assert.deepEqual(v.troops, [{ troop: 'rebel soldier', count: 1 }]);            // the corpse is not a troop
  assert.equal(roomVerdict('rebel', objs, 'duke').take, true);                    // empty of enemies, enemy pole
  assert.equal(roomVerdict('rebel', [{ name: 'rebel soldier' }], 'rebel').take, false);   // own troops: -1 a kill
  assert.equal(roomVerdict('princess', [], 'none').take, false);
  assert.equal(roomVerdict('princess', [], null).take, false);
});

ok('the search is the enemies\' homes first, nearest first, then the rest', () => {
  const eta = { 568: 9000, 557: 1000, 547: 5000, 593: 2000, 583: 8000, 603: 3000, 552: 500 };
  const order = enemyHuntOrder('duke', eta, { max: 40 });
  assert.deepEqual(order.slice(0, 6), [557, 593, 603, 547, 583, 568]);
  assert.equal(order[6], 552);                                                    // nearest of the rest
  assert.ok(!order.slice(0, 6).some(r => ARMIES.duke.rooms.includes(r)));        // never our own homes first
  assert.equal(new Set(order).size, order.length);
  assert.ok(order.every(r => WILDERNESS_FLAG_ROOMS.includes(r)));
  assert.deepEqual(enemyHuntOrder('duke', eta, { rooms: [568, 557], max: 8 }), [557, 568]);
  assert.equal(enemyHuntOrder('rebel', {}, { max: 3 }).length, 3);
});

// ---------------------------------------------------------------- the guarded read
const fakeCall = ({ items, looks = {}, byName = null }) => async (tool, args) => {
  if (tool === 'inventory') return { items };
  if (tool === 'look_at') {
    if (typeof args.target === 'string') return byName ? { description: byName } : { description: null };
    return looks[args.target] ?? { id: args.target, description: null };
  }
  throw new Error(`unexpected ${tool}`);
};

await okAsync('no shield reads as none', async () => {
  const s = await readShield(fakeCall({ items: [{ id: 5, name: 'long sword' }] }), 't5', { record: false });
  assert.equal(s.none, true);
});
await okAsync('a shield is read by its id, and the band comes back', async () => {
  const s = await readShield(fakeCall({ items: [{ id: 77, name: 'shield of the rebel militia', in_use: true }],
    looks: { 77: { id: 77, description: desc('the rebel militia', 'a notable fighter') } } }), 't5', { record: false });
  assert.deepEqual([s.faction, s.rank.title, s.in_use], ['rebel', 'a notable fighter', true]);
});
await okAsync('another object\'s description is refused, then the name is asked', async () => {
  const s = await readShield(fakeCall({ items: [{ id: 77, name: "shield of the Duke's army" }],
    looks: { 77: { id: 12, description: desc('the ducal army', 'a supreme hero') } },     // the wrong id
    byName: desc('the ducal army', 'a lowly peon') }), 't5', { record: false });
  assert.equal(s.rank.title, 'a lowly peon');
});
await okAsync('a negative id is not asked about', async () => {
  const s = await readShield(fakeCall({ items: [{ id: -1, name: "shield of the Princess' army" }],
    byName: desc('the Royal army', 'a great warrior') }), 't5', { record: false });
  assert.equal(s.rank.title, 'a great warrior');
});
await okAsync('an unreadable pack is an error, not "no shield"', async () => {
  const s = await readShield(async () => null, 't5');
  assert.ok(s.error && !s.none);
});

// ---------------------------------------------------------------- the plan
await okAsync('the plan compiles and declares every room it can walk to', async () => {
  const steps = await script.steps({ agents: ['t5'], agent: 't5' });
  assert.equal(trapCheck(steps), null);                     // null is "no trap"
  for (const s of steps.filter(x => x.do === 'walk' && typeof x.to === 'function' && !x.always))
    assert.ok(Array.isArray(s.candidates) && s.candidates.length, 'a run-time walk without candidates');
  const h = steps.find(x => x.do === 'harvest');
  assert.equal(typeof h.until, 'function');
  assert.deepEqual(h.quarry({ enemyTroops: ['rebel soldier'] }), ['rebel soldier']);
  assert.equal(h.room({ farmRoom: 557, here: 39 }), 557);
});

await okAsync('a maxed shield walks nowhere and farms nothing', async () => {
  const steps = await script.steps({ agents: ['t5'], agent: 't5', home: 50 });
  const st = { done: true, here: 39, results: {} };
  for (const s of steps.filter(x => x.do === 'walk' && typeof x.to === 'function'))
    assert.equal(s.to(st), 39);
  const h = steps.find(x => x.do === 'harvest');
  assert.equal((await h.until({ agent: 't5', call: async () => { throw new Error('no call expected'); }, state: st })).done, true);
});

await okAsync('a room override confines the search to it', async () => {
  const steps = await script.steps({ agents: ['t5'], agent: 't5', rooms: '568,557' });
  for (const s of steps.filter(x => x.do === 'walk' && Array.isArray(x.candidates) && !x.always))
    assert.deepEqual(s.candidates, [568, 557]);
});

await okAsync('a refusal without a shield does not walk home', async () => {
  const steps = await script.steps({ agents: ['t5'], agent: 't5', home: 50 });
  for (const s of steps.filter(x => x.do === 'walk' && x.always)) assert.equal(s.to({ here: 39, results: {} }), 39);
  for (const s of steps.filter(x => x.do === 'walk' && x.always)) assert.equal(s.to({ here: 557, order: [557], results: {} }), 50);
});

console.log(`max-faction-shield: ${n} groups passed${base ? ' (titles read from the kod)' : ' (no kod tree)'}`);
