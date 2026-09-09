#!/usr/bin/env node
// Offline contract for accepting reagent donations. Opens no socket and joins nobody.
//
// The behaviour: a service provider says yes to reagents a fleetmate pushes across, so the
// donor never has to agree a moment with anybody. The wire protocol makes that the easy
// half — an OFFER cannot complete until this side counteroffers, and the counteroffer may
// be EMPTY, so the provider's obligation is mechanical and needs no judgement.
//
// What is worth pinning is the refusals. This runs on a shared server, an open trade window
// blocks the other side, and a pack with no room accepts nothing while reporting nothing.

import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

// `isFleetmate` reads a roster source the keeper installs at boot (m59-party.mjs:151-168).
// Installing one here is the honest way to test the refusal: it exercises the real
// predicate rather than a stub of it.
const party = await import('./m59-party.mjs');
party.setRosterSource(() => new Set(['Ada', 'Bea', 'Cyd']));
const rosterWorks = party.isFleetmate('Ada') === true && party.isFleetmate('Nobody') === false;

const makeAp = ({ theirs = [{ name: 'orc tooth', amount: 10 }], from = 'Ada',
                  role = 'recipient', bulkFree = 500, pack = [['mushroom', 40]],
                  cfg = { enabled: true } } = {}) => {
  const names = new Map();
  const inv = pack.map(([name, amount], i) => { names.set(700 + i, name);
                                                return { id: 800 + i, nameRsc: 700 + i, amount }; });
  const client = {
    evSeq: 1, inventory: inv,
    rsc: { get: r => names.get(r) ?? '' },
    trade: theirs === null ? null : { revision: 7, role, withName: from, theirs, ours: [] },
    counterOffer: () => { client.countered++; },
    acceptOffer:  () => { client.accepted++; },
    cancelOffer:  () => { client.cancelled++; },
    drop:         () => { client.dropped++; },
    waitFor: async () => ({ events: [] }),
  };
  client.countered = client.accepted = client.cancelled = client.dropped = 0;
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { acceptDonations: cfg };
  ap.tally = {}; ap.notes = [];
  ap.s = { client, pacer: { submit: async (_k, fn) => fn() } };
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.progress = () => {};
  ap.bulkFree = () => bulkFree;               // the real one reads skills.carryCapacity
  return ap;
};

console.log('\nan inert policy never touches the trade');
{
  for (const cfg of [null, { enabled: false }]) {
    const ap = makeAp(); ap.policy.acceptDonations = cfg;
    await ap.acceptDonations();
    ok(`policy ${JSON.stringify(cfg)} does nothing`,
       ap.s.client.countered === 0 && ap.s.client.cancelled === 0);
  }
}

console.log('\na fleetmate offering wanted reagents is accepted, giving nothing back');
{
  const ap = makeAp();
  const r = await ap.acceptDonations();
  ok('accepted', r?.accepted === true);
  ok('countered exactly once — the empty reply is what unblocks the other side',
     ap.s.client.countered === 1);
  ok('and then accepted', ap.s.client.accepted === 1);
  ok('nothing was cancelled', ap.s.client.cancelled === 0);
  ok('the tally counts it', ap.tally.donations_taken === 1);
}

console.log('\nrefusals cancel rather than leave the window open');
{
  const empty = makeAp({ theirs: [] });
  await empty.acceptDonations();
  ok('an empty offer is refused', empty.s.client.cancelled === 1 && empty.s.client.accepted === 0);

  const junk = makeAp({ theirs: [{ name: 'orc tooth' }, { name: 'rusty armor' }] });
  await junk.acceptDonations();
  ok('a mixed pile is refused whole', junk.s.client.cancelled === 1);
  ok('and the unwanted item is named',
     JSON.stringify(junk.notes).includes('rusty armor'));

  if (rosterWorks) {
    const stranger = makeAp({ from: 'Nobody' });
    await stranger.acceptDonations();
    ok('a stranger on a shared server is refused', stranger.s.client.cancelled === 1);
    ok('and nothing was accepted from them', stranger.s.client.accepted === 0);
  } else {
    console.log('  skip   roster-backed fleetmate test (m59-party has no seedable roster here)');
  }
}

console.log('\nit only answers an offer made TO us');
{
  const ours = makeAp({ role: 'offerer' });
  await ours.acceptDonations();
  ok('our own outgoing offer is left alone',
     ours.s.client.countered === 0 && ours.s.client.cancelled === 0);
  const none = makeAp({ theirs: null });
  await none.acceptDonations();
  ok('no open trade at all is a no-op', none.s.client.countered === 0);
}

console.log('\none reply per offer, however many passes see it');
{
  const ap = makeAp();
  await ap.acceptDonations();
  await ap.acceptDonations();
  await ap.acceptDonations();
  ok('the same revision is answered once', ap.s.client.countered === 1);
}

console.log('\nroom is made before saying yes, not after');
{
  const tight = makeAp({ bulkFree: 5 });
  await tight.acceptDonations();
  ok('a nearly full pack sheds something', tight.s.client.dropped === 1);
  ok('and still accepts', tight.s.client.accepted === 1);
  ok('the note says what went down and that the floor is not a safe',
     JSON.stringify(tight.notes).includes('farm cleanup'));

  const roomy = makeAp({ bulkFree: 500 });
  await roomy.acceptDonations();
  ok('a pack with room drops nothing', roomy.s.client.dropped === 0);

  // carryCapacity withholds room_for when anything is unweighed. Unknown must not read as
  // full, or a character that cannot measure itself sheds its reagents for no reason.
  const unknown = makeAp({ bulkFree: 500 });
  unknown.bulkFree = () => null;
  await unknown.acceptDonations();
  ok('an unmeasurable pack sheds nothing and still accepts',
     unknown.s.client.dropped === 0 && unknown.s.client.accepted === 1);

  const nothingToShed = makeAp({ bulkFree: 5, pack: [['orc tooth', 3]] });
  await nothingToShed.acceptDonations();
  ok('a full pack with nothing sheddable still tries to accept',
     nothingToShed.s.client.dropped === 0 && nothingToShed.s.client.accepted === 1);
}

console.log('\nthe take list is configurable');
{
  const ap = makeAp({ theirs: [{ name: 'sapphire', amount: 4 }],
                      cfg: { enabled: true, reagents: ['orc tooth'] } });
  await ap.acceptDonations();
  ok('an item outside a narrowed list is refused', ap.s.client.cancelled === 1);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
