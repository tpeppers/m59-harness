// Offline guard for SPARED CREATURES (tools/m59-spare.mjs, policy.spareCreatures, a farm strategy's
// `spare`) and for the room snapshot farm-strategy hooks read (ctx.contents()). Opens no socket.
//
//   node tools/m59-spare-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OF } from './m59-parse.mjs';
import { spareMatcher, isSpared, vetoSpared } from './m59-spare.mjs';
import { findCreature } from './m59-skills.mjs';
import { roomContents } from './m59-strategy-engine.mjs';
import { validateStrategy } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// The Icky Cave, measured shape: orcs and spiders, a fleetmate, a stranger, a mushroom.
const objs = [
  [2, 'orc', OF.ATTACKABLE, 5, 6], [3, 'spider', OF.ATTACKABLE, 5, 7], [4, 'giant spider', OF.ATTACKABLE, 9, 9],
  [5, 'Spiderman', OF.PLAYER | OF.ATTACKABLE, 6, 6], [6, 'purple mushroom', 0, 5, 5], [7, 'orc', OF.ATTACKABLE, 20, 20],
  [8, 'spiderweb mushroom', OF.ATTACKABLE, 7, 7],
];
function room({ spare = ['spider'] } = {}) {
  const names = new Map([[1, 'Kermit'], ...objs.map(([id, nm]) => [id, nm])]);
  const c = { selfId: 1, self: { id: 1, row: 5, col: 5 }, rsc: { get: k => names.get(k) },
    room: { objects: new Map(objs.map(([id, , flags, row, col]) => [id, { id, nameRsc: id, flags, row, col }])) } };
  const s = { need: () => c, client: c, sparePatterns: () => spare };
  return { s, c };
}

await ok('whole-word matching: spider and giant spider, never Spiderman or a spiderweb mushroom', () => {
  const m = spareMatcher(['spider']);
  assert.equal(m('spider'), true); assert.equal(m('giant spider'), true); assert.equal(m('Spider Queen'), true);
  assert.equal(m('spiderweb mushroom'), false);
  assert.equal(spareMatcher([]), null); assert.equal(spareMatcher(null), null);
});

await ok('a player is never spared, whatever his name', () => {
  const { c } = room();
  assert.equal(isSpared(c, c.room.objects.get(5), ['spider']), false, 'Spiderman is a player');
  assert.equal(isSpared(c, c.room.objects.get(3), ['spider']), true);
});

await ok('findCreature never offers a spared monster: hunting, fighting and fight-back all pick through it', () => {
  const { s } = room();
  assert.deepEqual(findCreature(s, '').map(o => o.id), [2, 8, 7], 'orcs and the mushroom-named monster, no spiders');
  assert.deepEqual(findCreature(s, 'spider').map(o => o.id), [8], 'asking for a spider by name finds none that is spared');
  const none = room({ spare: null });
  assert.ok(findCreature(none.s, 'spider').some(o => o.id === 3), 'with nothing spared the spiders are targets again');
});

await ok('the attack veto refuses the packet at a spared monster, and only at one', () => {
  const { s, c } = room();
  assert.equal(vetoSpared(s, c, 3), true);
  assert.equal(vetoSpared(s, c, 2), false, 'an orc is swung at');
  assert.equal(vetoSpared(s, c, 5), false, 'a player is never this veto\'s business');
  assert.equal(vetoSpared({ sparePatterns: () => null }, c, 3), false, 'nothing spared, nothing vetoed');
  const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('c.attackVeto = id => vetoAttack(this, c, id) || vetoSpared(this, c, id) || !!this.buddyVeto?.(id);'),
    'the session installs it on every client, so every path that reaches c.attack is covered');
});

await ok('ctx.contents(): the room as data -- kinds, squares, nearest first, spared and fleetmate marked', () => {
  const { c } = room();
  const list = roomContents(c, { policy: { spareCreatures: ['spider'] } });
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]), 'a copy nothing can act through');
  assert.equal(list.find(o => o.id === 6).kind, 'object');
  assert.equal(list.find(o => o.id === 5).kind, 'player');
  assert.equal(list.find(o => o.id === 3).spared, true);
  assert.equal(list.find(o => o.id === 2).spared, false);
  assert.ok(list[0].distance <= list.at(-1).distance);
  assert.equal(list.filter(o => o.kind === 'monster' && /\borc\b/.test(o.name)).length, 2);
});

await ok('a strategy file may say `spare`, and the Icky Cave example validates and runs its hook', async () => {
  const mod = await import('../substrate/farm-strategies.example/icky-cave-orc-clear.mjs');
  const v = validateStrategy(mod.default, { file: 'icky-cave-orc-clear.mjs' });
  assert.ok(v.ok !== false && !(v.refused?.length) && !(v.problems?.length), JSON.stringify(v).slice(0, 400));
  const notes = [];
  const fake = contents => ({ room: 27, memory: {}, contents: () => contents, note: (w, d) => notes.push(w) });
  const ctx = fake([{ kind: 'monster', name: 'orc' }, { kind: 'monster', name: 'spider' }]);
  mod.default.hooks.onPass(ctx);
  assert.match(notes.at(-1), /clearing orcs/);
  ctx.contents = () => Array.from({ length: 10 }, () => ({ kind: 'monster', name: 'spider' }));
  mod.default.hooks.onPass(ctx);
  assert.match(notes.at(-1), /^HELD/, 'ten spiders, no orc: the cap is full and the chalice is ready');
});

console.log(`\n${n} passed`);
