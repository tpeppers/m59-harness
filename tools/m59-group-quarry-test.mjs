import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OF } from './m59-parse.mjs';
import { publishGroupQuarry, spreadGroupQuarries } from './m59-group-quarry.mjs';

const now = 100_000;
function fixture() {
  const prey = (id, name = 'mollusk creature') => ({ id, name, flags: OF.ATTACKABLE });
  const first = prey(10), second = prey(11), frog = prey(12, 'frogman');
  const mate = (id, name) => ({ id, name, flags: OF.PLAYER });
  const c = {
    state: 'game', combatReady: true, me: { name: 'Keeper' }, selfId: 1,
    room: { id: 1416, objects: new Map([mate(2, 'One'), mate(3, 'Two'), first, second, frog].map(o => [o.id, o])) },
    idsAsOf: () => ({ saving: false, last_save_began_at: now - 5000 }),
  };
  const pilot = {
    s: { name: 't1', live: true, client: c, world: { room: { num: 552 } } },
    mode: 'farm', policy: { assignedRoom: 552, gangUp: { mollusk: { fightInPlace: true } } },
    gangUpPlayersHere: () => [],
    gangUpVerdict: o => o.name === first.name ? { fightInPlace: true, met: true, min: 2 } : null,
  };
  const claim = (body, character, overrides = {}) => ({ agent: `t${body}`, body, character, target: first.id,
    quarry: first.name, at: now - 1000, room: 552, roomId: 1416, ...overrides });
  const walks = new Map([[first.id, { found: true, length: 4 }], [second.id, { found: true, length: 7 }]]);
  const order = (claims, prefer = null) => spreadGroupQuarries(pilot, [first, frog, second], prefer,
    { now, walks, store: () => ({ list: () => claims }) }).map(o => o.id);
  return { pilot, first, claim, order, walks };
}

test('an existing pair spreads new keepers but preserves the preferred quarry and non-group ordering', () => {
  const { claim, order } = fixture();
  const one = claim(2, 'one'), two = claim(3, 'two');
  assert.deepEqual(order([one]), [10, 12, 11]);
  assert.deepEqual(order([one, two]), [11, 12, 10]);
  assert.deepEqual(order([one, two], 10), [10, 12, 11]);
});

test('room, save, fresh body and quarry identities must all match', () => {
  const { claim, order } = fixture();
  const one = claim(2, 'one');
  for (const wrong of [
    claim(3, 'wrong player'), claim(3, 'two', { roomId: 1 }), claim(3, 'two', { room: 544 }),
    claim(3, 'two', { at: now - 8001 }), claim(3, 'two', { at: now - 5001 }),
    claim(3, 'two', { at: now + 1 }), claim(3, 'two', { quarry: 'frogman' }),
    claim(9, 'absent'), claim(2, 'one', { agent: 't99' }),
  ]) assert.deepEqual(order([one, wrong]), [10, 12, 11]);
});

test('a saturated quarry does not send a keeper on a long or unverified detour', () => {
  const { claim, order, walks } = fixture();
  const claimed = [claim(2, 'one'), claim(3, 'two')];
  for (const plan of [{ found: true, length: 11 }, { found: false }, { found: true, length: 4, goal_exempt: true }]) {
    walks.set(11, plan);
    assert.deepEqual(order(claimed), [10, 12, 11]);
  }
});

test('only the assigned in-place group hunt publishes a scoped claim', () => {
  const { pilot, first } = fixture();
  const writes = [];
  const store = () => ({ write: (...args) => writes.push(args) });
  publishGroupQuarry(pilot, first, { now, store });
  assert.deepEqual(writes, [['group-quarry', 't1', { at: now, agent: 't1', body: 1, room: 552,
    roomId: 1416, target: 10, character: 'keeper', quarry: 'mollusk creature' }]]);
  pilot.policy.assignedRoom = 544;
  publishGroupQuarry(pilot, first, { now, store });
  assert.equal(writes.length, 1);
});

test('independent keeper publishers share claims only on the same roster and endpoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm59-group-quarry-'));
  try {
    const { pilot, first, walks } = fixture();
    const session = pilot.s;
    session.fleetStateFile = join(directory, 'prod.json');
    session.cooperativeLogoffDirectory = directory;
    session.credentials = { host: 'fixture.invalid', port: 5959 };
    for (const [id, name] of [[2, 'One'], [3, 'Two']]) {
      const peer = { ...pilot, s: { ...session, name: `t${id}`, client: { ...session.client, selfId: id, me: { name } } } };
      publishGroupQuarry(peer, first, { now: now - 1000 });
    }
    const candidates = [first, session.client.room.objects.get(11)];
    assert.deepEqual(spreadGroupQuarries(pilot, candidates, null, { now, walks }).map(o => o.id), [11, 10]);
    session.fleetStateFile = join(directory, 'lab.json');
    assert.deepEqual(spreadGroupQuarries(pilot, candidates, null, { now, walks }).map(o => o.id), [10, 11]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
