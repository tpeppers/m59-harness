#!/usr/bin/env node
// Offline contract for the ally-buff service. Opens no socket and joins nobody.
//
// The behaviour under test: a posted caster with an ally in the room casts super strength
// and bless on them, because that helps the ally AND is the only way the spell improves.
// The parts worth pinning are the refusals -- a cast that cannot pay its reagents is
// refused server-side and, from the client, looks exactly like a cast that landed on
// somebody who was already enchanted. Guessing there wastes reagents silently.

import { Autopilot } from './m59-autopilot.mjs';
import { publishFleetHealth } from './m59-fleet-health.mjs';
import { Session } from './m59-game.mjs';
import { OF } from './m59-parse.mjs';
import * as party from './m59-party.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// THE ALLY IN THIS SUITE IS ONE OF OURS, AND IT HAS TO SAY SO. Since 2026-10-03 a buff goes only
// to an ally by m59-ally.mjs's rule -- a fleet-mate or a named friend, never a stranger -- after
// Beaker blessed Morpheus. So "Ally" is installed as a fleet-mate here, and the three books the
// rule reads are pointed at an empty scratch directory so this checkout's own books cannot
// change the answer. The hostile cases are in m59-ally-test.mjs.
const BOOKS = mkdtempSync(join(tmpdir(), 'm59-buff-'));
process.env.M59_GRUDGE_FILE = join(BOOKS, 'grudges.json');
process.env.M59_WAR_FILE = join(BOOKS, 'war.json');
process.env.M59_PVP_HOLD_DIR = join(BOOKS, 'holds');
process.env.M59_FLEET_HEALTH_DIR = join(BOOKS, 'health');
party.setRosterSource(() => new Set(['Ally']));

let passed = 0, failed = 0;
const ok = (what, cond) => {
  if (cond) { passed++; console.log('  ok  ', what); }
  else { failed++; console.log('  FAIL', what); }
};

const SS = Autopilot.BUFFS.find(b => b.name === 'super strength');
const BLESS = Autopilot.BUFFS.find(b => b.name === 'bless');

// A client stub shaped like the real one where buffAllies touches it.
const makeAp = ({ pack = [], spells = [], others = 1, mana = 30, ability = 20,
                  cfg = { enabled: true }, paid = true } = {}) => {
  const names = new Map();
  const inv = pack.map(([name, amount], i) => { names.set(2000 + i, name);
                                                return { id: 500 + i, nameRsc: 2000 + i, amount }; });
  const spl = spells.map(([name, id], i) => { names.set(3000 + i, name);
                                              return { id, nameRsc: 3000 + i }; });
  const objs = new Map();
  for (let i = 0; i < others; i++) objs.set(90 + i, { id: 90 + i, flags: OF.PLAYER, nameRsc: 4000, row: 1, col: 2 });
  names.set(4000, 'Ally');
  objs.set(1, { id: 1, flags: OF.PLAYER, nameRsc: 4000 });          // us
  const abilities = new Map(spl.map(sp => [sp.id, { ability }]));
  const client = {
    selfId: 1, self: { row: 1, col: 1 }, inventory: inv, spells: spl, abilities,
    rsc: { get: r => names.get(r) ?? '' },
    room: { objects: objs },
    vitals: () => ({ mana: { value: mana } }),
    cast: async (id, [target]) => {
      client.casts++;
      client.targets.push(target);
      const name = spells.find(([, spellId]) => spellId === id)[0];
      if (paid) for (const [reagent, cost] of Autopilot.BUFFS.find(b => b.name === name).reagents) {
        const item = inv.find(o => names.get(o.nameRsc) === reagent);
        item.amount -= cost;
        if (!item.amount) inv.splice(inv.indexOf(item), 1);
      }
      return true;
    },
    waitFor: async () => ({ events: [] }),
  };
  client.casts = 0;
  client.targets = [];
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { buffAllies: cfg };
  ap.tally = {};
  ap.declined = [];
  ap.notes = [];
  ap.s = { client, need: () => client, pacer: { submit: async (_k, fn) => fn() } };
  ap.declinedCast = (what, why, detail) => { ap.declined.push({ what, why, detail }); };
  ap.receipts = [];
  ap.recordCast = (spell, result) => ap.receipts.push({ spell, ...result });
  ap.note = (what, detail) => { ap.notes.push({ what, detail }); };
  ap.progress = () => {};
  return ap;
};

const FULL = [['mushroom', 20], ['orc tooth', 10], ['sapphire', 10]];
const BOTH = [['super strength', 11], ['bless', 12]];

console.log('\nthe guaranteed duration is the HALF, never the roll');
{
  const ap = Object.create(Autopilot.prototype);
  // Random(d/2, d) promises only d/2, so a recast timer may assume no more than that.
  ok('super strength at ability 20 (power 10) holds at least 180s',
     ap.buffFloorMs(SS, 20) === ((300 + 60) * 1000) / 2);
  ok('bless at ability 20 holds at least 50s',
     ap.buffFloorMs(BLESS, 20) === ((40 + 60) * 1000) / 2);
  ok('a mature super strength holds at least 300s',
     ap.buffFloorMs(SS, 100) === ((300 + 300) * 1000) / 2);
  ok('ability 0 still yields the base', ap.buffFloorMs(SS, 0) === (300 * 1000) / 2);
}

console.log('\nreagents are counted before the cast, not inferred from its failure');
{
  const ap = makeAp({ pack: [['mushroom', 5], ['orc tooth', 0]], spells: BOTH });
  ok('a partial stack counts', ap.reagentOnHand('mushroom') === 5);
  ok('an absent reagent is zero', ap.reagentOnHand('sapphire') === 0);
  ok('names match on substring, as the server varies them',
     makeAp({ pack: [['blue mushroom', 3]] }).reagentOnHand('mushroom') === 3);
}

console.log('\nan inert policy does nothing at all');
{
  // Set on the policy directly rather than through makeAp's parameter: a destructuring
  // default fires on `undefined`, so passing it in would silently test { enabled: true }.
  for (const cfg of [null, undefined, { enabled: false }]) {
    const ap = makeAp({ pack: FULL, spells: BOTH });
    ap.policy.buffAllies = cfg;
    await ap.buffAllies();
    ok(`policy ${JSON.stringify(cfg) ?? 'undefined'} casts nothing`, ap.s.client.casts === 0);
  }
}

console.log('\nwith an ally, reagents and mana, it casts super strength first');
{
  const ap = makeAp({ pack: FULL, spells: BOTH });
  await ap.buffAllies();
  ok('one cast went out', ap.s.client.casts === 1);
  ok('and it was super strength, the long one',
     ap.notes.at(-1)?.detail?.spell === 'super strength');
  ok('the note says how long it is good for',
     ap.notes.at(-1)?.detail?.holds_for_s === 180);
}

console.log('\nrefusals are named rather than silent');
{
  const noOne = makeAp({ pack: FULL, spells: BOTH, others: 0 });
  await noOne.buffAllies();
  ok('nobody to buff is said out loud', noOne.declined.at(-1)?.why === 'nobody else in the room to buff');
  ok('and nothing was cast', noOne.s.client.casts === 0);

  const broke = makeAp({ pack: [['mushroom', 20]], spells: BOTH });
  await broke.buffAllies();
  ok('a missing reagent is named, not guessed at',
     broke.declined.some(d => d.why === 'out of reagents'));
  ok('and it names which one is short',
     JSON.stringify(broke.declined).includes('orc tooth'));
  ok('nothing was cast without its reagents', broke.s.client.casts === 0);

  const dry = makeAp({ pack: FULL, spells: BOTH, mana: 2 });
  await dry.buffAllies();
  ok('low mana is a named refusal', dry.declined.at(-1)?.why === 'not enough mana');
}

console.log('\nit falls through to bless when super strength cannot be paid for');
{
  const ap = makeAp({ pack: [['mushroom', 20], ['sapphire', 10]], spells: BOTH });
  await ap.buffAllies();
  ok('bless went out instead', ap.notes.at(-1)?.detail?.spell === 'bless');
  ok('and the super strength shortfall was still recorded',
     ap.declined.some(d => d.why === 'out of reagents'));
}

{
  const ap = makeAp({ pack: FULL, spells: BOTH, mana: 12 });
  await ap.buffAllies();
  ok('bless remains available below the strength mana floor', ap.receipts[0]?.spell === 'bless');
}

{
  const ap = makeAp({ pack: FULL, spells: BOTH, others: 2, paid: false });
  await ap.buffAllies();
  ok('a silent refusal is not counted as coverage', ap.receipts[0]?.ok === false && !ap.tally.buffs_given);
  ap.lastBuffAt = 0;
  await ap.buffAllies();
  ok('an unconfirmed recipient does not block another ally', ap.s.client.targets[1] === 91);
}

{
  const ap = makeAp({ pack: FULL, spells: BOTH, others: 2 });
  await ap.buffAllies();
  ap.lastBuffAt = 0;
  await ap.buffAllies();
  for (const entry of ap._buffedAt.values()) entry.retryAt = 0;
  ap.lastBuffAt = 0;
  await ap.buffAllies();
  ok('due strength renewals do not starve allies never given bless', ap.receipts[2]?.spell === 'bless');
}

console.log('\nreserved reagents leave the next payable buff eligible');
{
  const ap = makeAp({ pack: [['mushroom', 20], ['orc tooth', 2], ['sapphire', 10]], spells: BOTH });
  ap.s.client.castVeto = id => {
    if (id !== 11) return false;
    ap.s.lastReserveVeto = { at: Date.now(), spell: 'super strength', reagent: 'orc tooth', have: 2, need: 1, floor: 2 };
    return true;
  };
  await ap.buffAllies();
  ok('protected teeth are identified before gearing up or casting', ap.declined.some(d =>
    d.what === 'super strength' && d.why === 'reagent reserve' && d.detail.floor === 2));
  ok('the same turn goes to payable Bless', ap.s.client.casts === 1 && ap.receipts[0]?.spell === 'bless');
}
{
  const ap = makeAp({ pack: FULL, spells: BOTH });
  let waited = false;
  ap.s.client.waitFor = async () => { waited = true; return { events: [] }; };
  ap.s.client.cast = async () => {
    ap.s.lastReserveVeto = { at: Date.now(), spell: 'super strength', reagent: 'orc tooth', have: 2, need: 1, floor: 2 };
    return false;
  };
  await ap.buffAllies();
  ok('a late reserve refusal is named without waiting for a server reply', !waited &&
    !ap.receipts.length && ap.declined.at(-1)?.why === 'reagent reserve');
}

console.log('\na target inside the guaranteed window is not re-buffed');
{
  const ap = makeAp({ pack: FULL, spells: BOTH });
  await ap.buffAllies();
  ok('first cast lands', ap.s.client.casts === 1);
  ap.lastBuffAt = 0;                                  // let the pass gap through
  await ap.buffAllies();
  // super strength is still up, so the second pass moves to bless rather than wasting it
  ok('the second pass does not repeat super strength',
     ap.notes.at(-1)?.detail?.spell === 'bless');
  ap.lastBuffAt = 0;
  await ap.buffAllies();
  ok('and with both up it casts nothing', ap.s.client.casts === 2);
}

console.log('\na caster who does not know the spell simply skips it');
{
  const ap = makeAp({ pack: FULL, spells: [['bless', 12]] });
  await ap.buffAllies();
  ok('bless is cast', ap.notes.at(-1)?.detail?.spell === 'bless');
  ok('and super strength was never attempted',
     !ap.declined.some(d => d.what === 'super strength'));
}

console.log('\nthe spell list can be narrowed by the doctrine');
{
  const ap = makeAp({ pack: FULL, spells: BOTH, cfg: { enabled: true, spells: ['bless'] } });
  await ap.buffAllies();
  ok('only the named spell is cast', ap.notes.at(-1)?.detail?.spell === 'bless');
}

console.log('\nmagic shield (Kraanan level 3): its whole duration is promised, and its reagents are counted exactly');
{
  const MS = Autopilot.BUFFS.find(b => b.name === 'magic shield');
  ok('magic shield is in the table', !!MS && MS.mana === 9);
  const ap0 = Object.create(Autopilot.prototype);
  // mshield.kod GetDuration: (1 + (power + 5) / 10) minutes, no Random(). Ability 40 -> power 20 -> 1 + 2 = 3 minutes.
  ok('ability 40 holds the full 3 minutes', ap0.buffFloorMs(MS, 40) === 3 * 60_000);
  ok('ability 0 still holds 1 minute', ap0.buffFloorMs(MS, 0) === 60_000);
  ok('bless keeps its halved floor', ap0.buffFloorMs(BLESS, 20) === ((40 + 60) * 1000) / 2);
  const SHIELD_ONLY = [['magic shield', 13]];
  // Two red mushrooms and no plain ones: a substring count would read 2 "mushroom" and cast into a refusal.
  const apRed = makeAp({ pack: [['red mushroom', 2]], spells: SHIELD_ONLY });
  await apRed.buffAllies();
  ok('red mushrooms do not pass for the two plain ones', apRed.s.client.casts === 0
     && apRed.declined.some(d => d.what === 'magic shield' && d.why === 'out of reagents'));
  const apOk = makeAp({ pack: [['mushroom', 2], ['red mushroom', 1]], spells: SHIELD_ONLY });
  await apOk.buffAllies();
  ok('with 2 mushroom + 1 red mushroom it is cast on the ally', apOk.s.client.casts === 1
     && apOk.notes.at(-1)?.detail?.spell === 'magic shield');
  apOk.lastBuffAt = 0;
  await apOk.buffAllies();
  ok('and not cast again on the same ally inside its window', apOk.s.client.casts === 1);
}

console.log('\nopted-in Great Ocean Magic Shield responds to fresh damage on the same ally');
{
  let port = 5800;
  const fixture = ({ spells = [['magic shield', 13]], room = 552, optedIn = true, paid = true } = {}) => {
    const ap = makeAp({ pack: [...FULL, ['red mushroom', 5]], spells, paid });
    ap.mode = 'farm';
    ap.policy.molluskCoverRecovery = optedIn;
    ap.s.world = { room: { num: room } };
    ap.s.credentials = { host: 'ocean.test', port: ++port };
    const ally = { world: { room: { num: 552 } }, credentials: ap.s.credentials, hitBook: () => null };
    let health = 120, effects = [];
    ally.client = {
      combatReady: true, state: 'game', selfId: 90, self: {}, me: { name: 'Ally' }, room: { id: 5520 },
      enchantments: () => effects, vitals: () => ({ health: { value: health, max: 120 } }),
    };
    const at = Date.now();
    const observe = (hp, at) => {
      health = hp;
      Session.prototype.noteHealth.call(ally, { value: hp, max: 120, at });
    };
    observe(120, at - 100);
    const report = ({ damageAt, publishedAt = Date.now(), bodyId = 90, shielded = false } = {}) => {
      if (damageAt != null) observe(113, damageAt);
      ally.client.selfId = bodyId;
      effects = shielded ? [{ type: 1, name: 'Magic Shield' }] : [];
      publishFleetHealth(ally, { now: publishedAt });
    };
    return { ap, ally, report, at };
  };
  const hit = fixture({ spells: [...BOTH, ['magic shield', 13]] });
  hit.report({ damageAt: hit.at });
  await hit.ap.buffAllies();
  ok('fresh health loss gives Magic Shield priority over the routine buffs', hit.ap.receipts[0]?.spell === 'magic shield');

  const quiet = fixture({ spells: [...BOTH, ['magic shield', 13]] });
  quiet.report();
  await quiet.ap.buffAllies();
  quiet.ap.lastBuffAt = 0;
  await quiet.ap.buffAllies();
  ok('quiet allies still receive Strength and Bless in their usual order',
     quiet.ap.receipts.map(r => r.spell).join(',') === 'super strength,bless');

  for (const [label, report] of [
    ['missing report', null], ['quiet ally', {}],
    ['stale health report', { damageAt: -6_000, publishedAt: -5_500 }],
    ['old damage in a fresh report', { damageAt: -6_000 }],
    ['already shielded', { damageAt: 0, shielded: true }],
    ['wrong body', { damageAt: 0, bodyId: 91 }],
  ]) {
    const { ap, report: publish, at } = fixture();
    if (report) publish({ ...report, damageAt: report.damageAt == null ? undefined : at + report.damageAt,
      publishedAt: report.publishedAt == null ? undefined : at + report.publishedAt });
    await ap.buffAllies();
    ok(`no reactive cast with ${label}`, ap.s.client.casts === 0);
  }

  const moved = fixture();
  moved.report({ damageAt: moved.at });
  moved.ally.client.room.id++;
  moved.report();
  await moved.ap.buffAllies();
  ok('damage from a different room identity cannot trigger a cast', moved.ap.s.client.casts === 0);

  const coveredWhileQueued = fixture();
  coveredWhileQueued.report({ damageAt: coveredWhileQueued.at });
  coveredWhileQueued.ap.s.pacer.submit = async (kind, send) => {
    if (kind === 'cast') coveredWhileQueued.report({ shielded: true });
    return send();
  };
  await coveredWhileQueued.ap.buffAllies();
  ok('a shield added while the cast was queued withholds the packet', coveredWhileQueued.ap.s.client.casts === 0);

  const already = fixture({ paid: false });
  already.report({ damageAt: already.at });
  already.ap.s.client.waitFor = async () => ({ events: [{ text: 'Ally is already affected by that magic.' }] });
  await already.ap.buffAllies();
  ok('an already-in-effect receipt backs off the same target', already.ap.receipts[0]?.outcome === 'already' &&
     already.ap._buffedAt.get('90:4000:magic shield')?.retryAt >= already.at + 30_000);

  for (const [label, options] of [['outside 552', { room: 553 }], ['without opt-in', { optedIn: false }]]) {
    const { ap } = fixture(options);
    await ap.buffAllies();
    ok(`routine Magic Shield remains available ${label}`, ap.s.client.casts === 1);
  }
}

console.log('\nally buff facing and queued packet guards');
{
  const fixture = ({ distant = true, paid = true } = {}) => {
    const ap = makeAp({ pack: FULL, spells: BOTH, paid });
    const { s } = ap, c = s.client, aim = c.room.objects.get(90), actions = [];
    c.room.id = 552;
    if (distant) { c.self = { row: 3, col: 6 }; aim.row = 3; }
    s.faceToward = Session.prototype.faceToward;
    c.face = degrees => actions.push(['turn', degrees]);
    const cast = c.cast;
    c.cast = (id, ids) => { actions.push(['cast', ids[0]]); return cast(id, ids); };
    return { ap, s, c, aim, actions };
  };
  const distant = fixture();
  await distant.ap.buffAllies();
  ok('face a distant ally in place before sending the cast',
     JSON.stringify(distant.actions) === JSON.stringify([['turn', 180], ['cast', 90]]) &&
     distant.ap.receipts[0]?.ok === true);
  const close = fixture({ distant: false });
  await close.ap.buffAllies();
  ok('an adjacent ally needs no turn packet',
     JSON.stringify(close.actions) === JSON.stringify([['cast', 90]]));

  const leftBeforeTurn = fixture();
  leftBeforeTurn.s.pacer.submit = async (kind, send) => {
    if (kind === 'turn') leftBeforeTurn.c.room.objects.delete(90);
    return send();
  };
  await leftBeforeTurn.ap.buffAllies();
  ok('a departing ally cancels the queued turn and cast',
     leftBeforeTurn.actions.length === 0 && leftBeforeTurn.ap.receipts.length === 0);

  const movedBeforeCast = fixture();
  movedBeforeCast.s.pacer.submit = async (kind, send) => {
    if (kind === 'cast') movedBeforeCast.aim.row++;
    return send();
  };
  await movedBeforeCast.ap.buffAllies();
  ok('a changed bearing cancels the cast at its packet boundary',
     movedBeforeCast.actions.length === 1 && movedBeforeCast.ap.receipts.length === 0);

  const reused = fixture();
  reused.c.face = () => { reused.aim.nameRsc++; };
  await reused.ap.buffAllies();
  ok('an object ID reused after facing is no longer the intended ally', reused.c.casts === 0);

  const held = fixture();
  held.s.pacer.holdStatus = () => ({ active: held.actions.length > 0 });
  await held.ap.buffAllies();
  ok('a concentration hold that opens after facing suppresses the cast',
     held.actions.length === 1 && held.c.casts === 0);
  const travelling = fixture();
  travelling.s.moveOrder = { kind: 'travel', to: 202 };
  await travelling.ap.buffAllies();
  ok('an active movement order receives no buff turn or cast', travelling.actions.length === 0);

  const refused = fixture({ paid: false });
  refused.c.waitFor = async ({ match }) => {
    const message = { kind: 'message', text: "You can't see your selected target." };
    return { events: match(message) ? [message] : [] };
  };
  await refused.ap.buffAllies();
  ok('the server facing refusal is classified without waiting for reagent payment',
     refused.ap.receipts[0]?.outcome === 'not_in_view' && refused.ap.receipts[0].ok === false);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
