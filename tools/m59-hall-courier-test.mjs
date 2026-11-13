// Offline guard for tools/fleetscripts/hall-courier.mjs: what is cargo, who is collected from, that a hand-over is
// believed only off the courier's pack, and that the deposit goes BY ID and skips the walk when nothing is carried.
// A fake broker; no socket, no roster.
//
//   node tools/m59-hall-courier-test.mjs
import assert from 'node:assert/strict';
import { hallCargo, collectFrom, collectOne, parseSelector, countByName, script } from './fleetscripts/hall-courier.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const noWeigh = () => ({ bulk: 50 });

await ok('cargo: unidentified and magic weapons only; never worn, never the amulet, never a stack or a mundane one', async () => {
  const inv = { equipped: ['mace'], items: [
    { id: 11, name: 'long sword', rarity: 100 },          // unidentified: hall-bound
    { id: 12, name: 'mace', rarity: 100 },                // worn (by name): never
    { id: 13, name: 'short sword', rarity: 0 },           // mundane: never
    { id: 14, name: 'axe', rarity: 200 },                 // graded cursed: never
    { id: 15, name: 'Amulet of Shadows', rarity: 200 },   // the practice engine: never
    { id: 16, name: 'scimitar', rarity: 2 },              // rare magic: hall-bound
    { id: 17, name: 'arrow', rarity: 100, amount: 40 },   // a stack: never
    { id: 18, name: 'emerald', amount: 5 },               // not a weapon
  ] };
  assert.deepEqual(hallCargo(inv, { weigh: noWeigh }).map(x => x.id), [11, 16]);
});
await ok('cargo: named substrings replace the weapon rule, and the amulet is still refused', async () => {
  const inv = { items: [{ id: 1, name: 'diamond', amount: 3 }, { id: 2, name: 'Amulet of Shadows' }, { id: 3, name: 'magical ring' }] };
  assert.deepEqual(hallCargo(inv, { names: parseSelector('Diamond, ring, amulet'), weigh: noWeigh }),
    [{ id: 1, amount: 3, name: 'diamond' }, { id: 3, amount: 1, name: 'magical ring' }]);
});
await ok('cargo: the item and bulk caps hold', async () => {
  const inv = { items: [1, 2, 3, 4].map(id => ({ id, name: 'long sword', rarity: 100 })) };
  assert.equal(hallCargo(inv, { maxItems: 2, weigh: noWeigh }).length, 2);
  assert.equal(hallCargo(inv, { maxBulk: 120, weigh: noWeigh }).length, 2, 'two of 50 bulk fit in 120');
  assert.equal(hallCargo({ items: [{ id: -1, name: 'long sword', rarity: 100 }] }, { weigh: noWeigh }).length, 0,
    'a synthetic negative id names nothing');
});
await ok('who is collected from: the room, or named farmers who are actually here; never the courier, a piloted or absent body', async () => {
  const rows = [{ agent: 't2', room_num: 552 }, { agent: 't4', room_num: 552 }, { agent: 't5', room_num: 552, piloted: true },
                { agent: 't6', room_num: 552, in_game: false }, { agent: 't7', room_num: 38 }];
  assert.deepEqual(collectFrom(rows, { from: 'room', courier: 't2', room: 552 }), ['t4']);
  assert.deepEqual(collectFrom(rows, { from: 't4,t7,t2', courier: 't2', room: 552 }), ['t4']);
});

// A fake broker: packs by agent, supply moves the named ids from one to the other (or not, when `lies`).
function broker(packs, { lies = false, equipped = {} } = {}) {
  const calls = [];
  const call = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'inventory') return { items: (packs[args.agent] ?? []).map(o => ({ ...o })), equipped: equipped[args.agent] ?? [], ids_as_of: { save: 1 } };
    if (tool === 'supply') {
      if (!lies) for (const w of args.what) {
        const i = packs[args.from].findIndex(o => o.id === w.id);
        if (i >= 0) packs[args.to].push(packs[args.from].splice(i, 1)[0]);
      }
      return { supplied: true };
    }
    if (tool === 'status') return { room: { num: 552 } };
    if (tool === 'fleet') return { fleet: Object.keys(packs).map(agent => ({ agent, room_num: 552 })) };
    if (tool === 'hall_withdraw') {
      const ids = new Set(args.deposit.map(d => Number(/^id:(\d+)$/.exec(d)?.[1])));
      packs[args.agent] = packs[args.agent].filter(o => !ids.has(o.id));
      return { ok: true };
    }
    throw new Error(`unexpected ${tool}`);
  };
  return { call, calls };
}

await ok('a hand-over is believed only off the courier\'s pack, by id and amount', async () => {
  const b = broker({ t2: [], t4: [{ id: 21, name: 'long sword', rarity: 100 }, { id: 22, name: 'dagger', rarity: 0 }] });
  const r = await collectOne(b.call, { courier: 't2', farmer: 't4' });
  assert.deepEqual([r.asked, r.arrived, r.why], [1, 1, null]);
  const sup = b.calls.find(c => c.tool === 'supply').args;
  assert.deepEqual(sup.what, [{ id: 21, amount: 1, name: 'long sword' }]);
  assert.equal(sup.who_travels, 'neither'); assert.deepEqual(sup.ids_as_of, { save: 1 });
  const lying = broker({ t2: [], t4: [{ id: 21, name: 'long sword', rarity: 100 }] }, { lies: true });
  const l = await collectOne(lying.call, { courier: 't2', farmer: 't4' });
  assert.deepEqual([l.asked, l.arrived], [1, 0]); assert.match(l.why, /nothing arrived/);
});
await ok('the script: collect, walk to the hall, deposit BY ID, home always', async () => {
  const steps = await script.steps({ agent: 't2', from: 'room', hall: 714, home: 0, items: '', maxItems: 8, maxBulk: 600, minCargo: 1 },
                                   { startRoom: 552 });
  assert.deepEqual(steps.map(s => s.do), ['verify', 'walk', 'verify', 'walk']);
  assert.equal(steps[3].to, 552); assert.equal(steps[3].always, true);
  assert.deepEqual(steps[1].candidates, [714]);
  const b = broker({ t2: [{ id: 5, name: 'mace', rarity: 0 }], t4: [{ id: 21, name: 'long sword', rarity: 100 }],
                     t9: [{ id: 31, name: 'scimitar', rarity: 1 }, { id: 32, name: 'Amulet of Shadows', rarity: 200 }] });
  const state = {};
  const quiet = console.log; console.log = () => {};
  try {
    assert.equal(await steps[0].fn({ call: b.call, state, agent: 't2' }), true);
    assert.equal(state.cargo, 2);
    assert.equal(steps[1].to(state), 714);
    assert.equal(await steps[2].fn({ call: b.call, state, agent: 't2' }), true);
  } finally { console.log = quiet; }
  const dep = b.calls.find(c => c.tool === 'hall_withdraw').args.deposit;
  assert.deepEqual(dep.sort(), ['id:21', 'id:31']);
  assert.deepEqual([...countByName({ items: (await b.call('inventory', { agent: 't2' })).items }).keys()], ['mace'],
    'the courier\'s own mace stays');
  assert.ok((await b.call('inventory', { agent: 't9' })).items.some(o => /amulet/i.test(o.name)), 'the amulet never moved');
});
await ok('nothing to carry: the hall walk is to where the courier stands, and nothing is deposited', async () => {
  const steps = await script.steps({ agent: 't2', from: 'room', hall: 714, home: 0, items: '', maxItems: 8, maxBulk: 600, minCargo: 1 }, {});
  assert.equal(steps.length, 3, 'no start room known: no home step to guess at');
  const b = broker({ t2: [], t4: [{ id: 22, name: 'dagger', rarity: 0 }] });
  const state = {};
  const quiet = console.log; console.log = () => {};
  try { await steps[0].fn({ call: b.call, state, agent: 't2' }); await steps[2].fn({ call: b.call, state, agent: 't2' }); }
  finally { console.log = quiet; }
  assert.equal(steps[1].to(state), 552);
  assert.ok(!b.calls.some(c => c.tool === 'supply' || c.tool === 'hall_withdraw'));
});
await ok('the script is declared like a public one: provenance, params with defaults', async () => {
  assert.ok(script.provenance?.pinned && script.provenance.touches.includes('tools/m59-hall-access.mjs'));
  for (const [k, v] of Object.entries(script.params)) assert.ok(v.required || 'default' in v, `${k} has a default`);
});

console.log(`\n${n} passed`);
