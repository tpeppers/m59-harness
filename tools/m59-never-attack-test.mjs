import assert from 'node:assert/strict';
import { Autopilot, CONTINUE } from './m59-autopilot.mjs';
import { BP, M59Client } from './m59-client.mjs';
import { CombatMode } from './m59-combat-mode.mjs';
import { guardNeverAttackPacket } from './m59-never-attack.mjs';

const policy = { neverAttack: true };
const wire = [];
const spells = ['Fireball', 'Acid Touch', 'Mystic Touch', 'Minor Heal', 'Relay', 'Melancholy',
  'Remove Curse', 'Bless', 'Super Strength', 'Magic Shield'];
const c = Object.assign(Object.create(M59Client.prototype), {
  state: 'game', sock: { write: b => wire.push(b) }, _outboundActivity() {},
  spells: [...spells.map((name, i) => ({ id: i + 1, name })), { id: 50, name: 'Uncatalogued Spell' }],
  inventory: [{ id: 101, name: 'wand', translation: 223 },
    { id: 102, name: 'wand of vampiric shock' }, { id: 103, name: 'scroll of fireball' },
    { id: 104, name: 'wand of minor heal' }, { id: 105, name: 'edible mushroom' },
    { id: 106, name: 'unidentified scroll' }, { id: 107, name: 'wand of healing' },
    { id: 108, name: 'blue potion' }, { id: 109, name: 'True Lute' }],
  room: { objects: new Map([[110, { id: 110, name: 'door lever' }]]) },
  beforeGameMutation(op, parts) { guardNeverAttackPacket(this, policy.neverAttack, op, parts); },
});

assert.throws(() => c.attack(87), /never_attack/);
assert.throws(() => c.send(BP.REQ_ATTACK, Buffer.alloc(5)), /never_attack/);
assert.throws(() => c.send(BP.REQ_SHOOT, Buffer.alloc(5)), /never_attack/);
assert.throws(() => c.cast(1, [87]), /fireball is offensive/);
assert.throws(() => c.send(BP.REQ_CAST, Buffer.from([2]), Buffer.from([0, 0, 0, 0, 0])), /acid touch is offensive/);
assert.throws(() => c.send(BP.REQ_CAST, Buffer.from([51, 0, 0, 0, 0, 0])), /benign effect for #51/);
assert.throws(() => c.cast(50, [87]), /benign effect for uncatalogued spell/);
assert.throws(() => c.apply(101, 87), /never_attack/);
assert.throws(() => c.apply(102, 87), /never_attack/);
assert.throws(() => c.activate(103), /never_attack/);
assert.throws(() => c.use(106), /never_attack/);
assert.throws(() => c.apply(111, 87), /benign effect for #111/);
assert.equal(wire.length, 0);

for (let id = 3; id <= spells.length; id++) c.cast(id, [87]);
c.send(BP.REQ_CAST, new Uint8Array([3, 0, 0, 0, 0, 0]));
c.apply(104, 87);
c.use(105);
c.apply(107, 87);
c.use(108);
c.use(109);
c.activate(110);
c.rest();
c.stand();
c.send(BP.REQ_MOVE, Buffer.alloc(9));
c.send(BP.REQ_INVENTORY);
assert.equal(wire.length, spells.length - 2 + 11);
policy.neverAttack = false;
c.attack(87);
c.cast(1, [87]);
assert.equal(wire.length, spells.length - 2 + 13);

policy.neverAttack = true;
const k = Object.assign(Object.create(Autopilot.prototype), {
  policy, fightBackDue: { reason: 'travel_hunt' },
});
assert.equal(await k.fightNow({ target: 'mollusk' }).then(r => r.reason), 'never_attack');
assert.equal(await k.passFightBack({}), CONTINUE);
assert.equal(k.fightBackDue, null);
assert.equal(k.fightBackCheck({}, 1, Date.now(), 4), null);
assert.equal(k.clearPathCheck({}, 1, Date.now()), null);
assert.equal(k.travelHuntCheck({}, 1, Date.now()), null);
assert.equal(await k.engagePlayerTarget(), false);
assert.equal(await k.respondToConflict(), false);
assert.equal(await k.defendAgainstPlayers(), null);
k.s = {};
k.lureSparedBlocker = async () => false;
assert.equal(await k.tradeInPlaceIfWedged(), false);

const s = {};
const combat = new CombatMode(s, { keeper: () => k });
assert.equal(combat.issue({ action: 'kill', target: 'Predator' }).accepted, false);
const startingCombat = new CombatMode({ neverAttackOrdered: () => true });
assert.equal(startingCombat.issue({ action: 'attack', target: 'Predator' }).accepted, false);
combat.active = { id: 'old-attack' };
combat.stop = reason => {
  assert.match(reason, /never_attack/);
  combat.active = null;
};
await combat.tick();
assert.equal(combat.active, null);
combat.active = { id: 'fleeing', flight: {} };
const safety = new Error('flight reached its own guard');
combat.guard = () => { throw safety; };
combat.combatFailure = (_order, reason) => assert.equal(reason, safety.message);
await combat.tick();
assert.equal(combat.active.id, 'fleeing');

console.log('PASS never_attack blocks native physical and known offensive packets, preserves support and flight, and skips offensive keeper work');
