import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { setRosterSource } from './m59-party.mjs';
import { publishFleetHealth, readFleetHealth } from './m59-fleet-health.mjs';
import { claimFleetAid, claimFleetHeal } from './m59-heal-claims.mjs';
import { relayFarmPeerEvidence, relayFarmVigor, relayRestCap, roomDropsRelayMushrooms, tryFarmRelay } from './m59-relay-farming.mjs';

const instant = 500_000;
const live = (name, id, vigor = 75, restCap = 80) => {
  const vitals = { health: { value: 100, max: 100 }, mana: { value: 25, max: 40 },
    vigor: { value: vigor, rest_threshold: restCap } };
  const c = { state: 'game', combatReady: true, me: { name }, selfId: id,
    self: { row: 4, col: 4 }, room: { id: 10552, objects: new Map() }, rsc: { get: x => x },
    spells: [{ id: 10, nameRsc: 'relay' }], inventoryAt: instant,
    inventory: [{ nameRsc: 'edible mushroom', amount: 2 }], vitals: () => vitals,
    stand() { this.lastPostureCommand = { verb: 'stand', room_object_id: this.room.id }; },
    cast(spell, targets) { sent.push({ spell, targets }); },
    waitFor: async () => ({ events: [{ text: 'You give part of your vigor to Peer.' }] }),
  };
  const sent = [], notes = [];
  const s = { live: true, client: c, fleetStateFile: 'fixture/prod.json', world: { room: { num: 552 } },
    credentials: { host: 'relay.test.invalid', port: 5959 }, pacer: { submit: async (_, fn) => fn() },
    faceToward: async (_, { beforePacket }) => beforePacket() };
  const pilot = { s, mode: 'farm', running: true, policy: { relayBeforeRest: true, assignedRoom: 552 },
    note: (...args) => notes.push(args), threat: () => ({ landing: 0 }) };
  s.relayFarmEvidence = v => relayFarmPeerEvidence(pilot, v);
  return { s, c, pilot, vitals, sent, notes };
};

const fixture = (run) => {
  const directory = mkdtempSync(join(tmpdir(), 'm59-relay-'));
  const donor = live('Donor', 1), peer = live('Peer', 2, 115, 96);
  const object = { id: 2, nameRsc: 'Peer', flags: OF.PLAYER, row: 5, col: 5 };
  donor.c.room.objects.set(2, object);
  const now = () => instant + 20;
  const read = (id, opts) => readFleetHealth(id, { ...opts, directory });
  const claim = (id, opts) => claimFleetAid(id, { ...opts, directory: join(directory, 'claims') });
  const profile = () => relayFarmVigor(donor.pilot, {}, { now: now(), read });
  const send = () => tryFarmRelay(donor.pilot, {}, profile(), { now, read, claim });
  const publish = () => publishFleetHealth(peer.s, { directory, now: instant });
  setRosterSource(() => new Set(['Peer', 'Third']));
  return Promise.resolve().then(() => run({ donor, peer, object, now, read, claim, profile, send, publish, directory }))
    .finally(() => {
      setRosterSource(null);
      rmSync(directory, { recursive: true, force: true });
    });
};

test('only maps whose huntable spawns drop the exact Snack qualify', () => {
  assert.equal(roomDropsRelayMushrooms(552), true);
  assert.equal(roomDropsRelayMushrooms(202), false);
  assert.equal(roomDropsRelayMushrooms(99, {
    creatures: { Frogman: { cls: 'Frogman', loot: { items: [{ item: 'InkyCap', per_roll_percent: 4 }] } } },
    rooms: { 99: [{ cls: 'Frogman', huntable: true }] },
  }), false);
  assert.equal(relayRestCap({ vigor: { rest_threshold: 96 } }), 96);
  assert.equal(relayRestCap({ vigor: { rest_threshold: 60 } }), 60);
  assert.equal(relayRestCap({ vigor: { rest_threshold: null } }), null);
});

test('a below-cap farmer can give once, then a confirmed rest cap resets its cycle', () => fixture(async ({ donor, publish, profile, send }) => {
  assert(publish());
  assert.equal(profile().active, true);
  assert.equal(profile().belowCap, true);
  assert.equal(await send(), true);
  assert.deepEqual(donor.sent, [{ spell: 10, targets: [2] }]);
  assert.equal(await send(), false);
  donor.vitals.vigor.value = 80;
  assert.equal(profile().belowCap, false);
  relayFarmVigor(donor.pilot, {}, { read: () => { throw Error('above-cap profile read a peer'); } });
  donor.vitals.vigor.value = 75;
  assert.equal(profile().cycle.sent, false);
}));

test('surplus Relay can put a rested peer back on the fight floor and keeps a donor reserve', () =>
  fixture(async ({ donor, peer, publish, profile, now, read, claim }) => {
    donor.vitals.vigor.value = 191;
    peer.vitals.vigor.value = 115;
    peer.pilot.policy.vigorFloor = 140;
    assert(publish());
    assert.equal(profile().active, false, 'surplus is never offered in the recovery path');
    const surplus = relayFarmVigor(donor.pilot, {}, { now: now(), read, surplus: true });
    assert.equal(surplus.reserve, 150);
    assert.equal(await tryFarmRelay(donor.pilot, {}, surplus, { now, read, claim }), true);
    assert.deepEqual(donor.sent, [{ spell: 10, targets: [2] }]);
    assert.equal(await tryFarmRelay(donor.pilot, {}, surplus, { now, read, claim }), false);
  }));

test('surplus Relay declines when the live headroom would take the donor below its reserve', () =>
  fixture(async ({ donor, peer, publish, now, read, claim }) => {
    donor.vitals.vigor.value = 190;
    peer.vitals.vigor.value = 109;
    assert(publish());
    const surplus = relayFarmVigor(donor.pilot, {}, { now: now(), read, surplus: true });
    assert(surplus.active);
    assert.equal(await tryFarmRelay(donor.pilot, {}, surplus, { now, read, claim }), false);
    assert.deepEqual(donor.sent, []);
  }));

test('fresh peer evidence is scoped to fleet, room object, name, body and opt-in policy', () => fixture(async ({ donor, peer, object, now, read, profile, publish }) => {
  assert(publish());
  assert(profile().active);
  peer.s.fleetStateFile = 'fixture/other.json';
  assert(publish());
  assert.equal(profile().active, false);
  peer.s.fleetStateFile = donor.s.fleetStateFile;
  peer.c.room.id += 1;
  assert(publish());
  assert.equal(profile().active, false);
  peer.c.room.id -= 1;
  peer.pilot.policy.relayBeforeRest = false;
  assert(publish());
  assert.equal(profile().active, false);
  peer.pilot.policy.relayBeforeRest = true;
  assert(publish());
  assert.equal(relayFarmVigor(donor.pilot, {}, { now: now() + 4000, read }).active, false);
  object.nameRsc = 'Stranger';
  assert.equal(profile().active, false);
}));

test('no cast for wrong reagent, missing mana, active danger or incoming Second Wind', () => fixture(async ({ donor, peer, publish, send }) => {
  assert(publish());
  for (const name of ['mushroom', 'Inky-cap mushroom', 'loaf of bread']) {
    donor.c.inventory[0].nameRsc = name;
    assert.equal(await send(), false);
  }
  donor.c.inventory[0].nameRsc = 'edible mushrooms';
  donor.vitals.mana.value = 8;
  assert.equal(await send(), false);
  donor.vitals.mana.value = 25;
  donor.pilot.threat = () => ({ landing: 1 });
  assert.equal(await send(), false);
  donor.pilot.threat = () => ({ landing: 0 });
  peer.c.enchantments = () => [{ name: 'second wind' }];
  assert(publish());
  assert.equal(await send(), false);
  assert.equal(donor.sent.length, 0);
  assert.equal(relayFarmPeerEvidence(peer.pilot).knows_relay, true);
  assert.equal(relayFarmPeerEvidence(peer.pilot).can_receive, false);
}));

test('three opted-in farmers qualify only when every fresh cohort member knows Relay', () => fixture(async ({ donor, profile, send, directory, publish }) => {
  const third = live('Third', 3, 128);
  donor.c.room.objects.set(3, { id: 3, nameRsc: 'Third', flags: OF.PLAYER, row: 8, col: 8 });
  third.c.spells = [{ id: 11, nameRsc: 'bless' }];
  assert(publish());
  assert(publishFleetHealth(third.s, { directory, now: instant }));
  assert.equal(profile().active, false);
  assert.equal(await send(), false);
  third.c.spells.push({ id: 10, nameRsc: 'relay' });
  assert(publishFleetHealth(third.s, { directory, now: instant }));
  assert.equal(profile().active, true);
}));

test('a visible opt-out farmer contributes stable capability, can veto, and never receives', () => fixture(async ({ donor, directory, profile, send, publish }) => {
  const third = live('Third', 3, 132);
  const object = { id: 3, nameRsc: 'Third', flags: OF.PLAYER, row: 8, col: 8 };
  donor.c.room.objects.set(3, object);
  third.pilot.policy.relayBeforeRest = false;
  third.c.spells = [{ id: 11, nameRsc: 'bless' }];
  assert(publish());
  assert(publishFleetHealth(third.s, { directory, now: instant }));
  assert.equal(profile().active, false);
  assert.equal(await send(), false);
  const capability = relayFarmPeerEvidence(third.pilot);
  assert.equal(capability.knows_relay, false);
  assert.equal(capability.opted_in, false);
  assert.equal(Object.hasOwn(capability, 'vigor'), false);
  third.vitals.vigor.value = 139;
  assert.equal(publishFleetHealth(third.s, { directory, now: instant + 1 }), false, 'opt-out vigor does not change the report');
  third.pilot.mode = 'survive';
  assert(publishFleetHealth(third.s, { directory, now: instant + 2 }));
  assert.equal(profile().active, true, 'nonfarm bodies do not veto the cohort');
  third.pilot.mode = 'farm';
  third.pilot.inert = { why: 'piloted' };
  assert.equal(relayFarmPeerEvidence(third.pilot), null, 'manual bodies report no farming capability');
  third.pilot.inert = null;
  third.c.spells.push({ id: 10, nameRsc: 'relay' });
  assert(publishFleetHealth(third.s, { directory, now: instant + 3 }));
  assert.equal(profile().active, true);
  assert.equal(await send(), true);
  assert.deepEqual(donor.sent[0].targets, [2], 'only the opted-in peer receives');
}));

test('recipient nearest its fight floor ranks before one further from it', () => fixture(async ({ donor, peer, directory, publish, send }) => {
  const third = live('Third', 3, 132);
  third.pilot.policy.fightAboveVigor = 140;
  peer.pilot.policy.fightAboveVigor = 140;
  donor.c.room.objects.set(3, { id: 3, nameRsc: 'Third', flags: OF.PLAYER, row: 8, col: 8 });
  assert(publish());
  assert(publishFleetHealth(third.s, { directory, now: instant }));
  assert.equal(await send(), true);
  assert.deepEqual(donor.sent[0].targets, [3]);
}));

test('spends no vigor if a peer is below its free rest cap, nearly full, or no longer the exact target', () => fixture(async ({ donor, peer, object, publish, profile, send, read }) => {
  peer.vitals.vigor.value = 95;
  assert(publish());
  assert.equal(await send(), false);
  peer.vitals.vigor.value = 149;
  peer.pilot.policy.fightAboveVigor = 140;
  assert(publish());
  assert.equal(await send(), false);
  peer.vitals.vigor.value = 115;
  assert(publish());
  const before = profile();
  donor.s.pacer.submit = async (kind, fn) => {
    if (kind === 'cast') object.nameRsc = 'Someone else';
    return fn();
  };
  assert.equal(await tryFarmRelay(donor.pilot, {}, before, {
    now: () => instant + 20,
    read,
    claim: () => true,
  }), false);
  assert.equal(donor.sent.length, 0);
}));

test('support claims isolate spell purposes and roster scopes and cover a bucket boundary', () => fixture(({ directory }) => {
  const identity = { host: 'relay.test.invalid', port: 5959, character: 'Peer' };
  const opts = { directory, room: 552, bodyId: 2 };
  assert(claimFleetAid(identity, { ...opts, kind: 'relay', scope: 'fleet-a', cooldownMs: 4000, now: 7999 }));
  assert.equal(claimFleetAid(identity, { ...opts, kind: 'relay', scope: 'fleet-a', cooldownMs: 4000, now: 8000 }), false);
  assert(claimFleetAid(identity, { ...opts, kind: 'relay', scope: 'fleet-b', cooldownMs: 4000, now: 8000 }));
  assert(claimFleetHeal(identity, { ...opts, now: 8000 }));
}));
