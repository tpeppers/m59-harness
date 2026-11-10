import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bodyAuthority, withBodyCommand } from './m59-body-command.mjs';
import { withCastRite } from './m59-castrite.mjs';
import { Pacer } from './m59-game.mjs';
import { minorHealBlockedByKarma } from './m59-spells.mjs';

const source = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
const start = source.indexOf("case 'cast': {");
const end = source.indexOf("case 'rest':", start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const dispatch = new AsyncFunction('session', 'args', 'minorHealBlockedByKarma', 'withCastRite',
  `let result; switch ('cast') { ${source.slice(start, end)} } return result;`);
const run = session => withBodyCommand(session, () => dispatch(session,
  { spell: 'enchant weapon', target: 13543, holdMs: 100 }, minorHealBlockedByKarma, withCastRite));

function fixture({ standing = true, veto = false } = {}) {
  const pacer = new Pacer();
  const packets = [];
  const loop = { _frozen: false };
  const c = {
    room: { id: 321 }, save: 100, evSeq: 12,
    spells: [{ id: 3610, name: 'enchant weapon' }], stat: () => 10,
    idsAsOf() { return { last_save_at: this.save }; },
    lastPostureCommand: { verb: standing ? 'stand' : 'rest', room_object_id: 321 },
    stand() {
      packets.push(['stand', pacer.lastSent]);
      this.lastPostureCommand = { verb: 'stand', room_object_id: this.room.id };
      this.queuedRest = pacer.submit('rest', () => packets.push(['rest', pacer.lastSent]));
    },
    cast(id, targets) {
      assert(pacer.holdStatus().active);
      assert(loop._frozen);
      packets.push(['cast', pacer.lastSent, id, targets]);
      return veto ? false : undefined;
    },
    async waitFor({ since, timeoutMs }) {
      assert.equal(since, this.evSeq);
      assert.equal(timeoutMs, 100);
      assert(pacer.holdStatus().active);
      assert(loop._frozen);
      return { events: [{ kind: 'message', text: 'Your axe is now dedicated to Kraanan.' }] };
    },
  };
  const session = { client: c, pacer, _tickLoop: loop };
  pacer.authority = () => bodyAuthority(session);
  return { session, c, packets, pacer, loop };
}

test('a broker stand is reused and the exact cast still gets a paced slot', async () => {
  const { session, packets, pacer, loop } = fixture();
  await pacer.submit('read', () => packets.push(['read', pacer.lastSent]));
  const result = await run(session);
  assert.equal(result.sent, true);
  assert.deepEqual(packets.map(packet => packet[0]), ['read', 'cast']);
  assert(packets[1][1] - packets[0][1] >= pacer.minGapMs);
  assert.deepEqual(packets[1].slice(2), [3610, [13543]]);
  assert.equal(pacer.holdStatus().active, false);
  assert.equal(loop._frozen, false);
});

test('a resting caster stands on a separate paced slot and queued rest stays blocked', async () => {
  const { session, c, packets, pacer } = fixture({ standing: false });
  const result = await run(session);
  assert.equal(result.sent, true);
  assert.deepEqual(packets.map(packet => packet[0]), ['stand', 'cast']);
  assert(packets[1][1] - packets[0][1] >= pacer.minGapMs);
  assert.equal((await c.queuedRest).held, true);
});

test('an existing concentration hold is preserved', async () => {
  const { session, packets, pacer } = fixture();
  const previous = pacer.holdForCast(5000, 'existing survival cast');
  assert.match((await run(session)).error, /hold changed/);
  assert.equal(pacer.holdUntil, previous);
  assert.deepEqual(packets, []);
});

test('a server save during the pacing wait rejects the old handles', async () => {
  const { session, c, packets, pacer } = fixture();
  await pacer.submit('read', () => {});
  const attempt = run(session);
  c.save++;
  assert.match((await attempt).error, /conditions changed/);
  assert.deepEqual(packets, []);
  assert.equal(pacer.holdStatus().active, false);
});

test('a newer combat order preempts the paced cast at the actual send', async () => {
  const { session, packets, pacer } = fixture();
  await pacer.submit('read', () => {});
  const attempt = run(session);
  session.combatEpoch = 1;
  await assert.rejects(attempt, { code: 'COMBAT_PREEMPTED' });
  assert.deepEqual(packets, []);
  assert.equal(pacer.holdStatus().active, false);
});

test('a native veto releases its hold and preserves an earlier tick freeze', async () => {
  const { session, pacer, loop } = fixture({ veto: true });
  loop._frozen = true;
  assert.match((await run(session)).error, /vetoed/);
  assert.equal(pacer.holdStatus().active, false);
  assert.equal(loop._frozen, true);
});
