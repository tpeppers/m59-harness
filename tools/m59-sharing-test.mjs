#!/usr/bin/env node
// Offline contract for DEFAULT REAGENT SHARING. Opens no socket; writes only to a temp directory.
//
// Operator, 2026-10-16: spare reagents go to allies — service desks first — as a default action,
// "straight from the first time Loial runs out of reagents to being fully supplied by anyone else in
// the map/area that doesn't need their reagents without requiring any intervention". Pinned:
//   - the fleet board is SHARED ACROSS KEEPER PROCESSES (it was one Map per process, so every
//     reader saw only its own character);
//   - a reagent refusal names its spell, and the kod catalogue turns it into a need;
//   - a gift goes to a desk first, walks only for a desk and never out of Ukgoth, never gives what
//     the giver keeps, needs or protects, and caps at the asked amount;
//   - one giver per (needer, kind), and a dead giver's claim expires;
//   - receiving needs no policy, and the default path never cancels an offer it does not want.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInterestStore, writeDeclaration, readDeclarations, claimGift, releaseGift,
         _clearInterestCache } from './m59-interest-store.mjs';
import { interest } from './m59-skills.mjs';
import { reagentRefusalSpell, shortfallTargets, planGift, normalizeShare, SHARE_DEFAULTS,
         SHORTFALL_CASTS } from './m59-sharing.mjs';
import { spellCost } from './m59-deskpractice.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import * as party from './m59-party.mjs';
// The real fleetmate predicate, fed a roster the way the keeper installs one at boot.
party.setRosterSource(() => new Set(['Mate']));

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const dir = mkdtempSync(join(tmpdir(), 'm59-share-'));
const store = configureInterestStore({ directory: dir, namespace: 'test-fleet' });

try {
// ------------------------------------------------------------------------------ the board
await ok('a declaration written by ANOTHER keeper process is on this process\'s board', () => {
  interest.byAgent.clear();
  // What another process leaves behind: its own file, nothing in our Map.
  writeDeclaration('hk1', { character: 'Desk', room: 2, farming: false, service: true,
    wants: ['emerald'], needs: { emerald: 10 }, spare: {} });
  _clearInterestCache();
  const rec = interest.records().get('hk1');
  assert.ok(rec, 'the other keeper is visible');
  assert.equal(rec.needs.get('emerald'), 10);
  assert.equal(rec.service, true);
  assert.deepEqual(interest.wantedBy('emerald'), ['hk1'], 'and the sell path\'s hold sees it');
});

await ok('this process\'s own declaration also reaches the shared directory', () => {
  interest.declare('t11', { character: 'Farmer', room: 38, farming: true, spare: { emerald: 40 } });
  _clearInterestCache();
  const disk = readDeclarations().find(r => r.agent === 't11');
  assert.equal(disk?.spare?.emerald, 40);
});

await ok('a stale declaration is dropped, not trusted', () => {
  writeDeclaration('ghost', { character: 'Ghost', room: 2, needs: { herb: 5 }, at: Date.now() - 10 * 60_000 });
  _clearInterestCache();
  assert.ok(!readDeclarations().some(r => r.agent === 'ghost'));
});

await ok('demandsNear: farm delivery still sees farmers only; sharing sees the desk', () => {
  _clearInterestCache();
  const rooms = new Map([[2, 1], [38, 0]]);
  assert.ok(!interest.demandsNear(rooms).some(d => d.agent === 'hk1'), 'farmingOnly by default');
  const d = interest.demandsNear(rooms, { farmingOnly: false }).find(x => x.agent === 'hk1');
  assert.equal(d?.service, true); assert.equal(d?.hops, 1); assert.equal(d?.needs.emerald, 10);
});

// ------------------------------------------------------------------------------ need
await ok('the server\'s reagent refusal names the spell, either apostrophe', () => {
  assert.equal(reagentRefusalSpell("You don't have the reagents to cast remove curse!"), 'remove curse');
  assert.equal(reagentRefusalSpell('You don’t have the reagents to cast Forces of Light!'), 'forces of light');
  assert.equal(reagentRefusalSpell('You hit the troll.'), null);
});

await ok('the kod catalogue turns it into a need: remove curse -> ten casts of emerald', () => {
  const cost = spellCost('remove curse');
  assert.deepEqual(cost.reagents, [['emerald', 1]]);
  const t = shortfallTargets(cost, new Map(), { now: 5 });
  assert.equal(t.get('emerald').target, SHORTFALL_CASTS);
  const bigger = shortfallTargets({ reagents: [['emerald', 3]] }, t, { now: 9 });
  assert.equal(bigger.get('emerald').target, 3 * SHORTFALL_CASTS, 'the larger ask stands');
  assert.equal(bigger.get('emerald').since, 5, 'and keeps its age');
});

await ok('the keeper learns it from the refusal and puts it on the board', () => {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = {}; ap.notes = []; ap.note = (w, d) => ap.notes.push({ w, ...d });
  ap.ledgerEvent = () => {}; ap.s = { world: { room: { num: 2 } } };
  ap.declareInterest = () => { ap.declared = true; };
  const asked = ap.noteReagentRefusal('remove curse');
  assert.deepEqual(asked, { emerald: SHORTFALL_CASTS });
  assert.ok(ap.declared, 'declared at once, not on the next pass');
  assert.equal(ap.noteReagentRefusal('no such spell'), null);
});

// ------------------------------------------------------------------------------ give
const desk = { agent: 'hk1', character: 'Desk', room: 2, hops: 1, service: true, needs: { emerald: 10 } };
const mate = { agent: 't4', character: 'Mate', room: 38, hops: 0, service: false, needs: { herb: 30 } };
const far = { agent: 't9', character: 'Far', room: 579, hops: 1, service: false, needs: { emerald: 5 } };

await ok('a desk first, and the giver walks one room for it', () => {
  const { gift } = planGift({ demands: [mate, desk], have: { emerald: 48, herb: 90 }, keep: {}, here: 38 });
  assert.equal(gift.needer, 'hk1'); assert.deepEqual(gift.give, { emerald: 10 }); assert.equal(gift.walk, true);
});

await ok('an ordinary needer is served only in the giver\'s own room', () => {
  const { gift } = planGift({ demands: [far], have: { emerald: 48 }, here: 38 });
  assert.equal(gift, null);
  const here = planGift({ demands: [{ ...far, room: 38, hops: 0 }], have: { emerald: 48 }, here: 38 }).gift;
  assert.deepEqual(here.give, { emerald: 5 });
});

await ok('never walks out of Ukgoth for a gift, never past the radius', () => {
  assert.equal(planGift({ demands: [desk], have: { emerald: 48 }, here: 599 }).gift, null);
  assert.equal(planGift({ demands: [{ ...desk, hops: 2 }], have: { emerald: 48 }, here: 38 }).gift, null);
});

await ok('spare is what the giver would SELL: its floor, its own needs and its protected names stay', () => {
  assert.equal(planGift({ demands: [desk], have: { emerald: 12 }, keep: { emerald: 12 }, here: 38 }).gift, null,
    'everything kept');
  assert.deepEqual(planGift({ demands: [desk], have: { emerald: 15 }, keep: { emerald: 12 }, here: 38 }).gift.give,
    { emerald: 3 }, 'only what is above the keep');
  assert.equal(planGift({ demands: [desk], have: { emerald: 99 }, protectedNames: ['Emerald'], here: 38 }).gift, null,
    'a protected reagent is not spare');
});

await ok('never more than asked, never more than the cap', () => {
  const big = { ...desk, needs: { emerald: 500 } };
  assert.equal(planGift({ demands: [big], have: { emerald: 999 }, here: 38 }).gift.give.emerald,
    SHARE_DEFAULTS.per_gift_cap);
});

await ok('a needer that just failed is left alone for the backoff', () => {
  const backoff = new Map([['hk1', 10_000]]);
  assert.equal(planGift({ demands: [desk], have: { emerald: 48 }, here: 38, backoff, now: 5_000 }).gift, null);
  assert.ok(planGift({ demands: [desk], have: { emerald: 48 }, here: 38, backoff, now: 20_000 }).gift);
});

await ok('shareSpare: false switches it off; an object overrides the defaults', () => {
  assert.equal(normalizeShare(false).enabled, false);
  assert.equal(normalizeShare(undefined).enabled, true, 'on by default');
  assert.equal(normalizeShare({ radius: 0 }).radius, 0);
});

// ------------------------------------------------------------------------------ claims
await ok('one giver per (needer, kind); the holder may renew; release frees it', () => {
  assert.equal(claimGift('t4', 'hk1', 'emerald', { now: 1000 }), true);
  assert.equal(claimGift('t12', 'hk1', 'emerald', { now: 2000 }), false, 'a second giver is refused');
  assert.equal(claimGift('t12', 'hk1', 'herb', { now: 2000 }), true, 'another kind is free');
  assert.equal(claimGift('t4', 'hk1', 'emerald', { now: 3000 }), true, 'the holder renews');
  assert.equal(releaseGift('t12', 'hk1', 'emerald'), false, 'only the holder releases');
  assert.equal(releaseGift('t4', 'hk1', 'emerald'), true);
  assert.equal(claimGift('t12', 'hk1', 'emerald', { now: 4000 }), true, 'now it is free');
  releaseGift('t12', 'hk1', 'emerald'); releaseGift('t12', 'hk1', 'herb');
});

await ok('a dead giver\'s claim expires', () => {
  assert.equal(claimGift('dead', 'hk1', 'emerald', { now: 0 }), true);
  assert.equal(claimGift('alive', 'hk1', 'emerald', { now: 11 * 60_000 }), true);
  releaseGift('alive', 'hk1', 'emerald');
});

// ------------------------------------------------------------------------------ accept
function recipient(offered, { needs = ['emerald'], policy = {} } = {}) {
  const calls = [];
  const c = { trade: { role: 'recipient', revision: 1, withName: 'Mate', theirs: offered.map(name => ({ name })) },
    evSeq: 0, cancelOffer: () => calls.push('cancel'), counterOffer: () => calls.push('counter'),
    acceptOffer: () => calls.push('accept'), waitFor: async () => ({ events: [] }) };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = policy; ap.notes = []; ap.note = (w, d) => ap.notes.push({ w, ...d });
  ap.tally = {}; ap.progress = () => {}; ap.bulkFree = () => null;
  ap.offerWouldDoubleChalice = () => false;
  ap._needsNow = new Map(needs.map(k => [k, 10]));
  ap.s = { client: c, pacer: { submit: async (k, f) => f() } };
  return { ap, calls };
}

await ok('a fleetmate\'s offer of what we need is accepted with no acceptDonations policy', async () => {
  const { ap, calls } = recipient(['emerald']);
  const r = await ap.acceptNeededGift();
  assert.equal(r?.accepted, true, JSON.stringify(r));
  assert.deepEqual(calls, ['counter', 'accept']);
});

await ok('the default path never cancels an offer it does not want — another flow may own it', async () => {
  const { ap, calls } = recipient(['long sword']);
  const r = await ap.acceptNeededGift();
  assert.equal(r?.accepted, false); assert.equal(r?.left_open, true);
  assert.deepEqual(calls, [], 'no cancel, no accept');
});

await ok('an explicit acceptDonations list also takes whatever is needed right now', async () => {
  const { ap, calls } = recipient(['herb'], { needs: ['herb'],
    policy: { acceptDonations: { enabled: true, reagents: ['emerald'], drop_for_space: [] } } });
  const r = await ap.acceptNeededGift();
  assert.equal(r?.accepted, true, JSON.stringify(r)); assert.ok(calls.includes('accept'));
});

await ok('the keeper wires all three halves into every pass, the game hook and the shared store', () => {
  const ap = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'latin1');
  assert.ok(ap.includes('await this.acceptNeededGift()'));
  assert.ok(ap.includes('if (await this.shareSpareReagents()'));
  const game = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'latin1');
  assert.ok(game.includes('this.noteReagentRefusal(ev);'));
  const kp = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'latin1');
  assert.ok(kp.includes('configureInterestStore({'));
});
} finally {
  configureInterestStore({ enabled: false });
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
