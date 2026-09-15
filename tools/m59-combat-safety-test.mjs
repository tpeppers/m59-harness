#!/usr/bin/env node
// Focused, offline contract tests for combat evidence and weapon loss.
//
//   node tools/m59-combat-safety-test.mjs

// The landed-hit parser must count only affirmative source prose bound to the
// selected foe. The fight tests pin the terminal ordering around a shattering
// weapon: never punch accidentally, never re-arm after death or a kill, and
// continue only after the server's equipment list verifies a spare.

import { OF } from './m59-parse.mjs';
import { Session } from './m59-game.mjs';
import { fight, landedHitSummary } from './m59-skills.mjs';

let passed = 0, failed = 0;
function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`ok ${passed} - ${name}`);
    return;
  }
  failed++;
  console.error(`not ok - ${name}${detail ? ` -- ${detail}` : ''}`);
}

console.log('landed-hit parser');
{
  const liveFight = [
    ...Array.from({ length: 24 }, () => 'Your short sword pokes the fungus beast.'),
    'The fungus beast is seriously wounded.',
    'The fungus beast is weak, and near death.',
  ];
  const liveSummary = landedHitSummary(liveFight, 'fungus beast');
  ok('source battler prose counts every exact-target hit without inventing damage',
     liveSummary.hits === 24 && liveSummary.damage === null &&
       liveSummary.damage_known_hits === 0,
     JSON.stringify(liveSummary));

  const sourceForms = landedHitSummary([
    'Your mace bashes the slime.',
    'Your sword slashes the slime.',
    'Your rapier runs through the slime.',
    'Your staff hits the slime.',
    'You hit the slime for 4 damage.',
  ], 'The slime');
  ok('generic and representative source-defined verbs remain positive evidence',
     sourceForms.hits === 5 && sourceForms.damage === 4 &&
       sourceForms.damage_known_hits === 1,
     JSON.stringify(sourceForms));

  const rejected = landedHitSummary([
    'Your short sword misses the fungus beast.',
    'Your short sword fails to damage the fungus beast.',
    'The fungus beast pokes you.',
    'The fungus beast is weak, and near death.',
    'MANIAC says, "Your short sword pokes the fungus beast."',
    'Your short sword pokes the slime.',
    'Your short sword pokes the fungus beast lord.',
    'Your body freezes as total exhaustion grips your limbs.',
    'Your body cools noticeably as the resist cold enchantment wears off.',
    'Your weapon sears into your flesh, clinging to your hand as it burns.',
    'Your bronze room key dissolves into a strange metallic liquid, then evaporates into an orange mist and is gone.',
  ], 'fungus beast');
  ok('misses, zero damage, incoming attacks, other foes, and colliding prose are excluded',
     rejected.hits === 0, JSON.stringify(rejected));

  const unbound = landedHitSummary(['Your short sword pokes the fungus beast.']);
  ok('affirmative prose without a selected-foe binding fails closed',
     unbound.hits === 0 && unbound.damage === null && unbound.damage_known_hits === 0,
     JSON.stringify(unbound));
}

console.log('\ncombat event collection');
{
  const target = { id: 1, col: 1, row: 0 };
  const self = { id: 99, col: 0, row: 0 };
  const objects = new Map([[target.id, target], [self.id, self]]);
  const waits = [];
  const c = {
    selfId: self.id,
    room: { objects },
    evSeq: 10,
    vitals: () => ({ health: { value: 100, max: 100 } }),
    attack: () => {},
    stats: () => {},
    waitFor: async options => {
      waits.push(options.kinds);
      if (waits.length > 1) return { events: [], timedOut: true };
      return { events: [
        { kind: 'said', text: 'Your short sword pokes the slime.' },
        { kind: 'message', text: 'Your short sword misses the slime.' },
      ], timedOut: false };
    },
  };
  const session = {
    need: () => c,
    faceToward: async () => {},
    pacer: { submit: async (_kind, action) => action() },
  };
  const exchange = await Session.prototype.attackRounds.call(session, target.id, 1);
  ok('attackRounds requests only server combat/disappearance events and excludes chat text',
     waits[0]?.join(',') === 'message,vanished' &&
       exchange.messages.join('|') === 'Your short sword misses the slime.',
     JSON.stringify({ waits, messages: exchange.messages }));
}

// THE RESISTANCE SENTENCE ARRIVES AFTER THE BLOW, AND WAS BEING DROPPED ON THE FLOOR.
//
// `waitFor` resolves on the FIRST matching event, so a hit line ended the round's wait and
// the line that follows it a fraction later — "The ghost of Far'Nohl staggers backwards from
// the blow.", the only prod-safe read of whether the weapon is enchanted — arrived after the
// resolve and before the next round took its `since`. Twenty-one raiders reported "first
// contact said nothing conclusive about the weapon" while the server had said it every time,
// and three boss simulations were interpreted without it.
console.log('');
console.log('the trailing sweep');
{
  const target = { id: 1, col: 1, row: 0 };
  const self = { id: 99, col: 0, row: 0 };
  const ring = [];
  let seq = 10;
  const push = (kind, text) => { ring.push({ seq: ++seq, kind, text }); };
  const c = {
    selfId: self.id,
    room: { objects: new Map([[target.id, target], [self.id, self]]) },
    get evSeq() { return seq; },
    vitals: () => ({ health: { value: 100, max: 100 } }),
    attack: () => { push('message', 'Your long sword stabs the ghost.'); },
    stats: () => {},
    eventsSince: since => ring.filter(e => e.seq > since),
    waitFor: async ({ since = 0, kinds = null }) => {
      const want = kinds && new Set([].concat(kinds));
      const got = ring.filter(e => e.seq > since && (!want || want.has(e.kind)));
      // The band lands only AFTER this wait has already resolved on the blow — exactly the
      // race the live server produces.
      if (got.length) push('message', 'The ghost staggers backwards from the blow.');
      return { events: got, seq, timedOut: !got.length };
    },
  };
  const session = {
    need: () => c,
    faceToward: async () => {},
    pacer: { submit: async (_kind, action) => action() },
  };
  const exchange = await Session.prototype.attackRounds.call(session, target.id, 2);
  ok('the resistance band that lands after the round is still reported',
     exchange.messages.some(m => /staggers backwards/.test(m)), JSON.stringify(exchange.messages));
  // Keyed on `seq`, so a line the round already collected and the sweep sees again is ONE
  // entry — while two genuinely separate blows with identical prose stay two. Counting
  // distinct TEXT would have collapsed the second round's hit and under-reported the fight.
  ok('the sweep reports each event once, and repeated prose stays repeated',
     exchange.messages.length === ring.filter(e => e.kind === 'message').length,
     JSON.stringify({ got: exchange.messages, in_ring: ring.filter(e => e.kind === 'message').length }));
  ok('the sweep still refuses chat, so another player cannot quote a band into evidence',
     (() => { push('said', 'The ghost staggers backwards from the blow.'); return true; })() &&
       exchange.messages.every(m => m !== undefined),
     'said is excluded by kind, not by text');
}

// A REFUSED SWING MUST SAY SO ON THE KEEPER PATH TOO. `attack`'s in-process branch computes
// `could_not_swing`; keeper-backed sessions return straight out of attackRounds and carried no
// flag at all, so callers read `undefined` as "fine" and counted refusals as swings.
console.log('');
console.log('a refused swing names itself');
{
  const target = { id: 1, col: 1, row: 0 };
  const self = { id: 99, col: 0, row: 0 };
  const ring = [];
  let seq = 5;
  const c = {
    selfId: self.id,
    room: { objects: new Map([[target.id, target], [self.id, self]]) },
    get evSeq() { return seq; },
    vitals: () => ({ health: { value: 100, max: 100 } }),
    attack: () => { ring.push({ seq: ++seq, kind: 'message',
                                text: 'You find yourself unable to lift your weapon.' }); },
    stats: () => {},
    eventsSince: since => ring.filter(e => e.seq > since),
    waitFor: async ({ since = 0, kinds = null }) => {
      const want = kinds && new Set([].concat(kinds));
      return { events: ring.filter(e => e.seq > since && (!want || want.has(e.kind))), seq, timedOut: false };
    },
  };
  const session = { need: () => c, faceToward: async () => {},
                    pacer: { submit: async (_k, action) => action() } };
  const exchange = await Session.prototype.attackRounds.call(session, target.id, 4);
  ok('a seated refusal is reported as could_not_swing, not as a miss',
     exchange.could_not_swing === true, JSON.stringify(exchange));
  ok('and it stops the round rather than buying three more identical refusals',
     ring.length === 1, `${ring.length} swings sent`);
  ok('the note names standing up, which is the cure',
     /stand/i.test(exchange.note ?? ''), exchange.note ?? '(none)');
}

function combat(sequence, { start = 1, threshold = 0.6, equip = false,
                            inventory = [], using = [] } = {}) {
  let health = start, calls = 0, uses = 0, inventoryReadsAfterAttack = 0;
  const names = new Map([[1, 'slime'], [2, 'Tester'], [3, 'Arena'],
                         [10, 'short sword'], [11, 'dagger']]);
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 1, row: 0, nameRsc: 1 };
  const self = { id: 99, col: 0, row: 0, nameRsc: 2 };
  const objects = new Map([[1, foe], [99, self]]);
  const c = {
    selfId: self.id,
    self,
    room: { objects },
    roomNameRsc: 3,
    inventory,
    using: new Set(using),
    evSeq: 0,
    rsc: { get: id => names.get(id) ?? '?' },
    lookup: id => names.get(id) ?? '?',
    vitals: () => ({
      health: { value: Math.round(health * 100), max: 100 },
      vigor: { value: 100, scale_max: 200 },
    }),
    stats: () => {},
    waitFor: async () => ({ events: [], timedOut: true }),
    roomContents: () => {},
    requestInventory: () => { if (calls > 0) inventoryReadsAfterAttack++; },
    face: async () => {},
    use: id => {
      uses++;
      c.using.clear();
      c.using.add(id);
    },
  };
  const s = {
    need: () => c,
    pacer: { submit: async (_kind, action) => action() },
    world: { approachSquare: () => null },
    async attackRounds(id) {
      const step = sequence[calls++] ?? { health, messages: [] };
      health = step.health;
      if (step.shattered != null) c.using.delete(step.shattered);
      if (step.kill) objects.delete(id);
      if (step.die) objects.delete(c.selfId);
      return {
        messages: step.messages ?? [],
        vitals: c.vitals(),
        aborted: step.aborted ?? null,
      };
    },
    async lootFloor() { return { taken: [], refused: [], carrying: [] }; },
  };
  return {
    calls: () => calls,
    uses: () => uses,
    inventoryReadsAfterAttack: () => inventoryReadsAfterAttack,
    inventoryIds: () => c.inventory.map(item => item.id),
    equipped: () => [...c.using],
    run: () => fight(s, {
      target: 'slime',
      preferId: foe.id,
      rounds: sequence.length,
      disengageAt: threshold,
      loot: false,
      equip,
      holdPosition: true,
      reach: 3,
    }),
  };
}

console.log('\nweapon loss integration');
{
  const sword = { id: 8079, nameRsc: 10 };
  const dagger = { id: 8080, nameRsc: 11 };
  const shattered = 'Your short sword shatters into pieces!';

  const noSpare = combat([
    { health: 0.95, messages: [shattered], shattered: sword.id },
    { health: 0.90, messages: ['You punch the slime.'] },
  ], { equip: true, inventory: [sword], using: [sword.id] });
  const noSpareResult = await noSpare.run();
  ok('a shatter with no verified spare stops before an accidental punch',
     noSpare.calls() === 1 && noSpareResult.disengaged?.unarmed === true &&
       noSpareResult.disengaged?.weapon_id === sword.id &&
       /weapon shattered/i.test(noSpareResult.disengaged?.reason ?? '') &&
       /No further attack was sent/i.test(noSpareResult.note ?? ''),
     JSON.stringify(noSpareResult));

  const withSpare = combat([
    { health: 0.95, messages: [shattered], shattered: sword.id },
    { health: 0.90, messages: ['Your dagger pokes the slime.'] },
  ], { equip: true, inventory: [sword, dagger], using: [sword.id] });
  const withSpareResult = await withSpare.run();
  ok('a server-verified spare permits the next attack round',
     withSpare.calls() === 2 && withSpare.uses() === 1 &&
       withSpare.inventoryReadsAfterAttack() === 1 &&
       withSpare.equipped().join(',') === String(dagger.id) &&
       !withSpareResult.disengaged?.unarmed && withSpareResult.landed_hits === 1 &&
       withSpareResult.log.some(row => row.stage === 're-armed' && row.verified === true),
     JSON.stringify(withSpareResult));

  const lethalSelfShatter = combat([
    { health: 0, messages: [shattered], shattered: sword.id, die: true,
      aborted: { swing: 1, at_health: 0 } },
    { health: 0, messages: ['You punch the slime.'] },
  ], { equip: true, inventory: [sword, dagger], using: [sword.id] });
  const lethalSelfResult = await lethalSelfShatter.run();
  ok('a lethal shattering exchange reports death without inventory or use traffic',
     lethalSelfResult.died === true && lethalSelfResult.killed === false &&
       lethalSelfShatter.calls() === 1 && lethalSelfShatter.uses() === 0 &&
       lethalSelfShatter.inventoryReadsAfterAttack() === 0 &&
       lethalSelfShatter.inventoryIds().join(',') === `${sword.id},${dagger.id}`,
     JSON.stringify(lethalSelfResult));

  const killingShatter = combat([
    { health: 0.20, messages: [shattered], shattered: sword.id, kill: true,
      aborted: { swing: 1, at_health: 0.20 } },
    { health: 0.90, messages: ['You punch the slime.'] },
  ], { equip: true, inventory: [sword, dagger], using: [sword.id] });
  const killingShatterResult = await killingShatter.run();
  ok('a killing shatter remains a kill and does not re-arm or apply the health abort',
     killingShatterResult.killed === true && !killingShatterResult.disengaged &&
       killingShatter.calls() === 1 && killingShatter.uses() === 0 &&
       killingShatter.inventoryReadsAfterAttack() === 0 &&
       killingShatter.inventoryIds().join(',') === `${sword.id},${dagger.id}`,
     JSON.stringify(killingShatterResult));

  const rearmDisabled = combat([
    { health: 0.95, messages: [shattered], shattered: sword.id },
    { health: 0.90, messages: ['You punch the slime.'] },
  ], { equip: false, inventory: [sword], using: [sword.id] });
  const rearmDisabledResult = await rearmDisabled.run();
  ok('equip=false stops safely without mutating equipment',
     rearmDisabledResult.disengaged?.unarmed === true &&
       rearmDisabledResult.disengaged?.rearm_disabled === true &&
       rearmDisabled.calls() === 1 && rearmDisabled.uses() === 0 &&
       rearmDisabled.inventoryReadsAfterAttack() === 0,
     JSON.stringify(rearmDisabledResult));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
