// Offline guard for PvP-only gear and the synchronized wand volley (m59-pvp-gear.mjs and
// CombatMode.pvpGearOn / pvpGearOff / wandVolley). Opens no socket, touches no roster.
//
//   node tools/m59-pvp-gear-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OF } from './m59-parse.mjs';
import { bodyAuthority } from './m59-body-command.mjs';
import { bindPacketScope } from './m59-packet-scope.mjs';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-gear-test-'));
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
process.env.M59_PVP_GEAR_FILE = join(dir, 'pvp-gear.json');
writeFileSync(process.env.M59_PVP_GEAR_FILE, JSON.stringify({ format: 'm59-pvp-gear/1',
  items: ['shield of the rebel militia', 'plate armor'],
  wands: [{ match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }], volley_ms: 2000 }));

const gear = await import('./m59-pvp-gear.mjs');
const skills = await import('./m59-skills.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const P = OF.PLAYER | OF.ATTACKABLE;

function fixture({ name = 'Kermit', items = [], clock0 = 1_000_000 } = {}) {
  let clock = clock0;
  const sent = [];
  const names = new Map([[1, name], [2, 'Morpheus']]);
  let nid = 100;
  const inventory = items.map(n => { const id = nid++; names.set(id, n); return { id, nameRsc: id }; });
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() }, rsc: names, spells: [], hp: 100, inventory, using: new Set(),
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    use(id) { sent.push(`use:${names.get(id)}`); this.using.add(id); },
    unuse(id) { sent.push(`unuse:${names.get(id)}`); this.using.delete(id); },
    apply(id, on) { sent.push(`apply:${names.get(id)}->${on}`); },
    look() {}, safety(on) { sent.push('safety:' + on); } };
  const s = { name, client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0, job: null, need: () => c,
    world: { room: { num: 38 }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async step() {} };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.4 }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock, schedule: () => 0, unschedule: () => {} });
  mode.character = () => name; mode.fleetmate = () => false; mode.warEligibility = () => true;
  // No private strategies: this machine's substrate/strategies/ must not change these results.
  mode.wandStrategies = { strategies: [], problems: [] };
  c.room.objects.set(2, { id: 2, nameRsc: 2, row: 5, col: 6, flags: P | OF.ENEMY });
  return { s, c, sent, mode, advance(ms) { clock += ms; }, at(ms) { clock = ms; }, get clock() { return clock; } };
}

await test('a PvP-only piece is invisible to farming and visible in a PvP fight', () => {
  const f = fixture({ items: ['plate armor', 'leather armor'] });
  const names = () => Object.values(skills.armourOf(f.c)).flat().map(r => r.name);
  assert.ok(!names().includes('plate armor'), 'farming never considers the PvP plate');
  assert.ok(names().includes('leather armor'));
  f.c.pvpGearActive = true;
  assert.ok(names().includes('plate armor'), 'in a PvP fight it is wearable');
});

await test('a PvP-only weapon is never a farming weapon', () => {
  const f = fixture({ items: ['plate armor'] });
  assert.equal(gear.isPvpOnly('Plate Armor of Doom'), true);
  assert.equal(gear.isPvpOnly('leather armor'), false);
  assert.equal(gear.isPvpOnly('long sword'), false);
});

await test('a PvP fight puts the PvP gear on and the end of it takes it off', async () => {
  const f = fixture({ items: ['shield of the rebel militia', 'plate armor', 'leather armor'] });
  f.mode.event({ kind: 'appeared', id: 2 });              // a war-marked enemy: engage
  assert.ok(f.mode.active?.pvp);
  await f.mode.tick();
  assert.ok(f.sent.includes('use:shield of the rebel militia') && f.sent.includes('use:plate armor'), `sent ${f.sent}`);
  assert.ok(!f.sent.includes('use:leather armor'));
  assert.equal(f.c.pvpGearActive, true);
  f.mode.stop('test');
  await new Promise(r => setTimeout(r, 50));
  assert.ok(f.sent.includes('unuse:shield of the rebel militia') && f.sent.includes('unuse:plate armor'),
    `sent ${f.sent}; error ${f.mode.pvpGearError}`);
  assert.equal(f.c.pvpGearActive, false);
});

await test('a lightning wand fires on the beat, faces the target, and holds the swing between beats', async () => {
  const f = fixture({ items: ['lightning wand'] });
  f.at(2_000_000);                                       // exactly on a beat boundary
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.includes('apply:lightning wand->2'), `sent ${f.sent}`);
  assert.ok(f.sent.includes('face'));
  assert.ok(!f.sent.some(x => x.startsWith('attack:')), 'no melee: it would take the attack timer');
  const zaps = () => f.sent.filter(x => x.startsWith('apply:')).length;
  f.advance(900); await f.mode.tick();
  assert.equal(zaps(), 1, 'same beat: no second zap');
  assert.ok(!f.sent.some(x => x.startsWith('attack:')));
  f.advance(1200); await f.mode.tick();                   // next beat
  assert.equal(zaps(), 2);
  f.mode.stop('test');
});

await test('a vampiric wand fires on the beat and melee continues between beats', async () => {
  const f = fixture({ items: ['wand of vampiric shock'] });
  f.at(4_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.includes('apply:wand of vampiric shock->2'), `sent ${f.sent}`);
  assert.ok(f.sent.some(x => x.startsWith('attack:')), 'no attack timer: it swings as well');
  f.mode.stop('test');
});

await test('two keepers in the fight fire on the SAME beat', async () => {
  const a = fixture({ name: 'Kermit', items: ['lightning wand'] }), b = fixture({ name: 'Gonzo', items: ['lightning wand'] });
  a.at(6_000_300); b.at(6_001_700);                        // 1.4s apart, same 2s beat
  a.mode.event({ kind: 'appeared', id: 2 }); b.mode.event({ kind: 'appeared', id: 2 });
  await a.mode.tick(); await b.mode.tick();
  assert.equal(gear.beatOf(a.clock), gear.beatOf(b.clock));
  assert.ok(a.sent.includes('apply:lightning wand->2') && b.sent.includes('apply:lightning wand->2'));
  a.mode.stop('test'); b.mode.stop('test');
});

await test('a broken wand is never picked again; an unidentified "wand" never matches', async () => {
  const f = fixture({ items: ['wand of vampiric shock', 'wand'] });
  f.at(8_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  f.mode.event({ kind: 'message', text: 'Your wand of vampiric shock is broken.' });
  f.advance(2100); await f.mode.tick();
  assert.equal(f.sent.filter(x => x.startsWith('apply:')).length, 1, `sent ${f.sent}`);
  assert.ok(!f.sent.includes('apply:wand->2'));
  f.mode.stop('test');
});

await test('no wands, no config: the fight is exactly the melee it was', async () => {
  const f = fixture({ items: [] });
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.some(x => x.startsWith('attack:')));
  assert.ok(!f.sent.some(x => x.startsWith('apply:') || x.startsWith('use:')));
  f.mode.stop('test');
});

// ------------------------------------------------------------------ b8cf6d1..fae8bd3
//
// THE UNIDENTIFIED YELLOW WAND. Every Wand subclass is called "wand" until identified; the palette
// translation the server sends per object is what tells them apart (m59-pvp-gear.mjs effectiveName).

const YELLOW = gear.XLAT_TO_YELLOW, BLUE = 0x06;

await test('effectiveName: a bare yellow "wand" is a lightning wand; blue, other names and no translation are not', () => {
  assert.equal(YELLOW, 0x08);
  const c = { rsc: new Map([[1, 'wand'], [2, 'Wand '], [3, 'wand of identification'], [4, 'lightning wand']]) };
  assert.equal(gear.effectiveName(c, { nameRsc: 1, translation: YELLOW }), 'lightning wand');
  assert.equal(gear.effectiveName(c, { nameRsc: 2, translation: YELLOW }), 'lightning wand', 'case and whitespace do not matter');
  assert.equal(gear.effectiveName(c, { nameRsc: 1, translation: BLUE }), 'wand', 'blue is the wand of identification');
  assert.equal(gear.effectiveName(c, { nameRsc: 1 }), 'wand', 'no translation on the wire: stays a plain wand');
  assert.equal(gear.effectiveName(c, { nameRsc: 1, translation: 0 }), 'wand');
  assert.equal(gear.effectiveName(c, { nameRsc: 3, translation: YELLOW }), 'wand of identification',
    'only the BARE name "wand" is re-read; an identified name is its own');
  assert.equal(gear.effectiveName(c, { nameRsc: 4, translation: 0 }), 'lightning wand');
  // No resource table: the row's own name is used (the trade window's rows carry `name`).
  assert.equal(gear.effectiveName({}, { name: 'wand', translation: YELLOW }), 'lightning wand');
  assert.equal(gear.effectiveName({}, { name: 'wand', translation: BLUE }), 'wand');
});

await test('volleyWandsIn: an unidentified yellow wand is a volley wand, a blue one is not', () => {
  const names = new Map([[100, 'wand'], [101, 'wand'], [102, 'wand of vampiric shock']]);
  const c = { rsc: names, inventory: [{ id: 100, nameRsc: 100, translation: BLUE },
    { id: 101, nameRsc: 101, translation: YELLOW }, { id: 102, nameRsc: 102 }] };
  const got = gear.volleyWandsIn(c);
  assert.deepEqual(got.map(w => [w.o.id, w.name, w.timer]),
    [[101, 'lightning wand', true], [102, 'wand of vampiric shock', false]], 'config order: lightning first');
  assert.deepEqual(gear.volleyWandsIn(c, { spent: new Set([101]) }).map(w => w.o.id), [102], 'a spent one is skipped');
});

await test('an unidentified yellow wand fires on the beat like a lightning wand (and holds the swing)', async () => {
  const f = fixture({ items: ['wand', 'wand'] });
  f.c.inventory[0].translation = BLUE;                  // wand of identification: never zapped
  f.c.inventory[1].translation = YELLOW;
  const yellowId = f.c.inventory[1].id;
  const applied = [];
  const apply = f.c.apply.bind(f.c);
  f.c.apply = (id, on) => { applied.push([id, on]); apply(id, on); };
  f.at(10_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.deepEqual(applied, [[yellowId, 2]], `sent ${f.sent}`);
  assert.ok(!f.sent.some(x => x.startsWith('attack:')), 'timer wand: no melee between beats');
  f.advance(2100); await f.mode.tick();
  assert.deepEqual(applied, [[yellowId, 2], [yellowId, 2]], 'next beat: the yellow one again, never the blue');
  f.mode.stop('test');
});

await test('isPvpOnly: substring and case-insensitive against config items; empty/null is never PvP-only', () => {
  assert.equal(gear.isPvpOnly('Shield of the Rebel Militia'), true);
  assert.equal(gear.isPvpOnly(''), false);
  assert.equal(gear.isPvpOnly(null), false);
  assert.equal(gear.isPvpOnly('lightning wand'), false, 'wands are volley wands, not PvP-only items');
  assert.equal(gear.isPvpOnly('plate armor', { items: [] }), false, 'an explicit empty config has none');
});

// EXPECTED INCOMING: what a character takes without asking.
const CFG = Object.freeze({ items: ['shield of the rebel militia', 'plate armor'],
  wands: [{ match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }],
  expect_incoming: ['elixir of speed'], accept_if_missing: ['shield'] });
const carrying = (...rows) => {
  const rsc = new Map(); let id = 500;
  const inventory = rows.map(r => { const o = typeof r === 'string' ? { name: r } : r; rsc.set(++id, o.name);
    return { id, nameRsc: id, translation: o.translation }; });
  return { rsc, inventory };
};

await test('expectedIncoming: every PvP item and wand not carried, accept_if_missing when missing, expect_incoming always', () => {
  assert.deepEqual(gear.expectedIncoming(carrying(), { cfg: CFG }).sort(),
    ['elixir of speed', 'lightning wand', 'plate armor', 'shield', 'shield of the rebel militia', 'vampiric shock'].sort());
  const some = gear.expectedIncoming(carrying('Plate Armor', 'wand of vampiric shock', 'elixir of speed'), { cfg: CFG });
  assert.ok(!some.includes('plate armor') && !some.includes('vampiric shock'), 'carried: not expected again');
  assert.ok(some.includes('elixir of speed'), 'expect_incoming is expected even when carried');
  assert.ok(some.includes('lightning wand') && some.includes('shield of the rebel militia') && some.includes('shield'));
});

await test('expectedIncoming: a carried yellow "wand" satisfies the lightning wand; a blue one does not', () => {
  assert.ok(!gear.expectedIncoming(carrying({ name: 'wand', translation: YELLOW }), { cfg: CFG }).includes('lightning wand'));
  assert.ok(gear.expectedIncoming(carrying({ name: 'wand', translation: BLUE }), { cfg: CFG }).includes('lightning wand'));
});

await test('accept_if_missing: a shield is expected only while the character carries no shield of any kind', () => {
  assert.ok(gear.expectedIncoming(carrying('long sword'), { cfg: CFG }).includes('shield'));
  assert.ok(!gear.expectedIncoming(carrying('wooden shield'), { cfg: CFG }).includes('shield'));
  // The PvP shield also has "shield" in its name, so carrying it satisfies accept_if_missing too.
  const withPvpShield = gear.expectedIncoming(carrying('shield of the rebel militia'), { cfg: CFG });
  assert.ok(!withPvpShield.includes('shield') && !withPvpShield.includes('shield of the rebel militia'));
  // ...but a plain shield does NOT satisfy the PvP shield (the pattern is the longer name).
  assert.ok(gear.expectedIncoming(carrying('wooden shield'), { cfg: CFG }).includes('shield of the rebel militia'));
});

await test('offerIsExpected: all expected -> true; empty, mixed or unexpected -> false', () => {
  const none = carrying();
  assert.equal(gear.offerIsExpected(none, [], { cfg: CFG }), false, 'an empty offer is not a delivery');
  assert.equal(gear.offerIsExpected(none, null, { cfg: CFG }), false);
  assert.equal(gear.offerIsExpected(none, [{ name: 'plate armor' }, { name: 'lightning wand' }], { cfg: CFG }), true);
  assert.equal(gear.offerIsExpected(none, [{ name: 'Wooden Shield' }], { cfg: CFG }), true, 'accept_if_missing');
  assert.equal(gear.offerIsExpected(none, [{ name: 'elixir of speed' }], { cfg: CFG }), true, 'expect_incoming');
  assert.equal(gear.offerIsExpected(none, [{ name: 'plate armor' }, { name: 'long sword' }], { cfg: CFG }), false, 'mixed');
  assert.equal(gear.offerIsExpected(none, [{ name: 'long sword' }], { cfg: CFG }), false);
  assert.equal(gear.offerIsExpected(none, [{ name: 'wand', translation: YELLOW }], { cfg: CFG }), true, 'yellow wand');
  assert.equal(gear.offerIsExpected(none, [{ name: 'wand', translation: BLUE }], { cfg: CFG }), false, 'blue wand');
  assert.equal(gear.offerIsExpected(none, [{ name: 'wand' }], { cfg: CFG }), false, 'untranslated wand');
  const armed = carrying('plate armor', 'wooden shield');
  assert.equal(gear.offerIsExpected(armed, [{ name: 'plate armor' }], { cfg: CFG }), false, 'already carried');
  assert.equal(gear.offerIsExpected(armed, [{ name: 'iron shield' }], { cfg: CFG }), false, 'already has a shield');
});

await test('pvpGearConfig parses expect_incoming and accept_if_missing, and defaults both to []', () => {
  const saved = process.env.M59_PVP_GEAR_FILE;
  try {
    const f2 = join(dir, 'pvp-gear-2.json');
    writeFileSync(f2, JSON.stringify({ items: ['plate armor'], expect_incoming: ['elixir', '', 7], accept_if_missing: 'shield' }));
    process.env.M59_PVP_GEAR_FILE = f2;
    const cfg = gear.pvpGearConfig();
    assert.deepEqual(cfg.expect_incoming, ['elixir', '7'], 'strings, empties dropped');
    assert.deepEqual(cfg.accept_if_missing, [], 'a non-array is ignored, not split');
    process.env.M59_PVP_GEAR_FILE = join(dir, 'absent.json');
    assert.deepEqual(gear.pvpGearConfig().expect_incoming, []);
    assert.deepEqual(gear.pvpGearConfig().accept_if_missing, []);
    assert.deepEqual(gear.DEFAULT_PVP_GEAR.expect_incoming, []);
  } finally { process.env.M59_PVP_GEAR_FILE = saved; }
  assert.deepEqual(gear.pvpGearConfig().items, ['shield of the rebel militia', 'plate armor'], 'back on the suite config');
});

// THE TRADE WINDOW CARRIES `translation` (m59-client.mjs BP.OFFER / BP.COUNTEROFFER), so
// offerIsExpected can see the yellow wand. Driven through the real parser and onGameMessage.
{
  const { M59Client, BP } = await import('./m59-client.mjs');
  const { ANIMATE, LIGHT_FLAG_NONE } = await import('./m59-parse.mjs');
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  // extractObject: id, icon, name, flags, rarity, lighting, [palette], animation, overlays.
  const obj = (id, nameRsc, translation) => Buffer.concat([u32(id), u32(9000), u32(nameRsc), u32(0), u32(0),
    u16(LIGHT_FLAG_NONE), translation == null ? Buffer.alloc(0) : Buffer.from([ANIMATE.TRANSLATION, translation]),
    Buffer.from([ANIMATE.NONE]), u16(0), Buffer.from([0])]);
  const client = () => {
    const c = Object.create(M59Client.prototype);
    Object.assign(c, { rsc: new Map([[1, 'Morpheus'], [2, 'wand'], [3, 'plate armor']]), tradeRevision: 0,
      evSeq: 0, events: [], waiters: [], maxEvents: 100, parseErrors: [], log() {} });
    return c;
  };

  await test('BP.OFFER: their items carry the palette translation (0 when the wire sends none)', () => {
    const c = client();
    c.onGameMessage(BP.OFFER, Buffer.concat([obj(77, 1), u16(2), obj(301, 2, YELLOW), obj(302, 3)]));
    assert.deepEqual(c.parseErrors, []);
    assert.equal(c.trade.withName, 'Morpheus');
    assert.deepEqual(c.trade.theirs.map(i => [i.id, i.name, i.translation]), [[301, 'wand', YELLOW], [302, 'plate armor', 0]]);
    assert.equal(gear.offerIsExpected({ inventory: [] }, c.trade.theirs), true, 'a yellow wand and plate armor are expected kit');
  });

  await test('BP.COUNTEROFFER: their items carry the palette translation too', () => {
    const c = client();
    c.onGameMessage(BP.COUNTEROFFER, Buffer.concat([u16(1), obj(303, 2, BLUE)]));
    assert.deepEqual(c.parseErrors, []);
    assert.deepEqual(c.trade.theirs.map(i => [i.id, i.name, i.translation]), [[303, 'wand', BLUE]]);
    assert.equal(c.trade.mayAccept, true);
  });
}

// ACCEPTING EXPECTED KIT (m59-autopilot.mjs acceptDonations). Built without a constructor, as
// m59-social-silence-test.mjs and m59-donation-test.mjs do.
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const party = await import('./m59-party.mjs');
  party.setRosterSource(() => new Set(['Kermit', 'Gonzo']));
  const donation = ({ from = 'Morpheus', theirs, pack = [] } = {}) => {
    const names = new Map(pack.map((n, i) => [700 + i, n]));
    const c = { evSeq: 1, inventory: pack.map((n, i) => ({ id: 800 + i, nameRsc: 700 + i })), rsc: names,
      trade: { revision: 3, role: 'recipient', withName: from, theirs, ours: [] },
      countered: 0, accepted: 0, cancelled: 0,
      counterOffer() { this.countered++; }, acceptOffer() { this.accepted++; }, cancelOffer() { this.cancelled++; },
      waitFor: async () => ({ events: [] }) };
    const ap = Object.create(Autopilot.prototype);
    Object.assign(ap, { policy: { acceptDonations: { enabled: true } }, tally: {}, notes: [],
      s: { client: c, pacer: { submit: async (_k, fn) => fn() } }, progress() {}, bulkFree: () => 500 });
    ap.note = (what, detail) => ap.notes.push({ what, detail });
    return { ap, c };
  };

  await test('acceptDonations: expected PvP kit from a NON-fleetmate, off the take list, is accepted', async () => {
    assert.equal(party.isFleetmate('Morpheus'), false);
    const { ap, c } = donation({ theirs: [{ id: 1, name: 'plate armor' }, { id: 2, name: 'wand', translation: YELLOW }] });
    const r = await ap.acceptDonations();
    assert.equal(r?.accepted, true, JSON.stringify(ap.notes));
    assert.deepEqual([c.countered, c.accepted, c.cancelled], [1, 1, 0]);
  });

  await test('acceptDonations: a fleetmate handing expected kit that is not on the take list is accepted', async () => {
    const { ap, c } = donation({ from: 'Gonzo', theirs: [{ id: 1, name: 'shield of the rebel militia' }] });
    assert.equal((await ap.acceptDonations())?.accepted, true);
    assert.equal(c.accepted, 1);
  });

  await test('acceptDonations: a MIXED offer from a stranger is refused as a stranger', async () => {
    const { ap, c } = donation({ theirs: [{ id: 1, name: 'plate armor' }, { id: 2, name: 'long sword' }] });
    const r = await ap.acceptDonations();
    assert.equal(r?.accepted, false);
    assert.match(r.why, /not on the fleet roster/);
    assert.deepEqual([c.accepted, c.cancelled], [0, 1]);
  });

  await test('acceptDonations: a mixed offer from a fleetmate is refused by the take list', async () => {
    const { ap, c } = donation({ from: 'Gonzo', theirs: [{ id: 1, name: 'plate armor' }, { id: 2, name: 'long sword' }] });
    const r = await ap.acceptDonations();
    assert.equal(r?.accepted, false);
    assert.match(r.why, /not on the take list: plate armor, long sword/);
    assert.equal(c.cancelled, 1);
  });

  await test('acceptDonations: kit the character already carries is no longer expected -> stranger refused', async () => {
    const { ap, c } = donation({ theirs: [{ id: 1, name: 'plate armor' }], pack: ['plate armor'] });
    const r = await ap.acceptDonations();
    assert.equal(r?.accepted, false);
    assert.match(r.why, /not on the fleet roster/);
    assert.equal(c.accepted, 0);
  });

  await test('acceptDonations: an unidentified BLUE wand from a stranger is refused', async () => {
    const { ap, c } = donation({ theirs: [{ id: 1, name: 'wand', translation: BLUE }] });
    assert.equal((await ap.acceptDonations())?.accepted, false);
    assert.equal(c.accepted, 0);
  });

  await test('acceptDonations: the policy still gates it -- disabled means the trade is not touched', async () => {
    const { ap, c } = donation({ theirs: [{ id: 1, name: 'plate armor' }] });
    ap.policy.acceptDonations = { enabled: false };
    assert.equal(await ap.acceptDonations(), undefined);
    assert.deepEqual([c.countered, c.accepted, c.cancelled], [0, 0, 0]);
  });

  // THE GEAR ROUTINES STAND DOWN WHILE PVP GEAR IS ON. The client is a Proxy that records every
  // property read: with pvpGearActive the routine must read that flag and nothing else.
  const watched = (active) => {
    const reads = [];
    const client = new Proxy({ pvpGearActive: active }, { get(t, k) { if (typeof k === 'string') reads.push(k); return t[k]; } });
    const ap = Object.create(Autopilot.prototype);
    Object.assign(ap, { s: { client }, policy: {}, facultyHeld: () => false, note() {} });
    return { ap, reads };
  };
  for (const routine of ['armSelf', 'wearIntoEmptySlots', 'wearArmourIfNeeded']) {
    await test(`${routine} returns false and touches nothing else while pvpGearActive`, async () => {
      const { ap, reads } = watched(true);
      assert.equal(await ap[routine](), false);
      assert.deepEqual([...new Set(reads)], ['pvpGearActive'], `read ${reads}`);
    });
  }
  await test('with pvpGearActive false the routines go past the gate (they read more of the client)', async () => {
    for (const routine of ['armSelf', 'wearIntoEmptySlots', 'wearArmourIfNeeded']) {
      const { ap, reads } = watched(false);
      await ap[routine]().catch(() => {});
      assert.ok(reads.some(k => k !== 'pvpGearActive'), `${routine} read only ${reads}`);
    }
  });
}

// THROUGH A SAME-ROOM DOOR (m59-combat-mode.mjs crossDoorToward), against the REAL bake.
{
  const { loadMap } = await import('./m59-map.mjs');
  const { RoomGeometry } = await import('./m59-roo.mjs');
  const { safeCombatStep } = await import('./m59-combat-mode.mjs');
  const map = loadMap();
  const geo38 = RoomGeometry.fromJSON(map.rooms['38'].roo);
  // The live client's self carries kod fine x/y; sameRoomDoorPlan plans on the FINE geometry
  // only when it has them (liveFine). With bare squares it asks the coarse grid, which joins
  // Castle Victoria's chambers to the hall and plans no door at all (see below).
  const body = p => ({ ...p, x: p.col * 64 + 32, y: p.row * 64 + 32 });
  const doorFixture = ({ roomNum = 38, geo = geo38, self = body({ row: 7, col: 26 }) } = {}) => {
    const f = fixture();
    const crossed = [];
    f.s.world = { map, room: { num: roomNum }, geometry: geo };
    f.c.self = { ...f.c.self, ...self };
    f.s.crossSameRoomDoor = async (door, opts) => { crossed.push({ door, opts }); return { crossed: true }; };
    const o = { id: 'o1', client: f.c, order: { target: 'Morpheus', action: 'kill' }, phase: 'engaging' };
    return { ...f, crossed, o };
  };

  await test('crossDoorToward: chamber r7c26 -> hall r12c26 in Castle Victoria crosses the r8c26 door south', async () => {
    const f = doorFixture();
    assert.equal(await f.mode.crossDoorToward(f.o, { row: 12, col: 26 }), true);
    assert.equal(f.crossed.length, 1);
    const { door, opts } = f.crossed[0];
    assert.equal(door.to, 38, 'a door back into the same room');
    assert.ok(door.arriveRow > 8, `lands south, got r${door.arriveRow}c${door.arriveCol}`);
    assert.deepEqual([door.row, door.col, door.arriveRow, door.arriveCol], [8, 26, 10, 26]);
    assert.equal(opts.movementGeneration, f.s.movementGeneration);
    assert.ok(f.sent.includes('stand'), 'stands before the door');
    assert.deepEqual(f.o.lastDoor.stand_on, { row: 8, col: 26 });
    assert.deepEqual(f.o.lastDoor.lands, { row: 10, col: 26 });
    assert.equal(f.o.lastDoor.crossed, true);
  });

  await test('crossDoorToward: a refused crossing is still "tried" and records why', async () => {
    const f = doorFixture();
    f.s.crossSameRoomDoor = async () => { throw new Error('go_did_nothing'); };
    assert.equal(await f.mode.crossDoorToward(f.o, { row: 12, col: 26 }), true);
    assert.equal(f.o.lastDoor.crossed, false);
    assert.equal(f.o.lastDoor.why, 'go_did_nothing');
  });

  await test('crossDoorToward: false in room 2 (no internal doors), without crossSameRoomDoor, or without a map', async () => {
    const r2 = RoomGeometry.fromJSON(map.rooms['2'].roo);
    const a = doorFixture({ roomNum: 2, geo: r2, self: body({ row: 5, col: 5 }) });
    assert.equal(await a.mode.crossDoorToward(a.o, { row: 10, col: 10 }), false);
    assert.equal(a.crossed.length, 0);
    const b = doorFixture(); delete b.s.crossSameRoomDoor;
    assert.equal(await b.mode.crossDoorToward(b.o, { row: 12, col: 26 }), false);
    const d = doorFixture(); d.s.world.map = null;
    assert.equal(await d.mode.crossDoorToward(d.o, { row: 12, col: 26 }), false);
    assert.ok(!a.sent.includes('stand') && !b.sent.includes('stand'), 'no packet when there is no door');
  });

  await test('crossDoorToward: bare-square self (no x/y) plans on the coarse grid, finds it walkable, crosses nothing', async () => {
    const f = doorFixture({ self: { row: 7, col: 26, x: undefined, y: undefined } });
    assert.equal(await f.mode.crossDoorToward(f.o, { row: 12, col: 26 }), false);
    assert.equal(f.crossed.length, 0);
  });

  // DOCUMENTED, NOT ENDORSED: on the real bake the COARSE approach from the chamber is not null,
  // so advance() takes safeCombatStep's step and never reaches crossDoorToward for this pair. The
  // door fallback only fires when safeCombatStep returns null. Pinned so a change is noticed.
  await test('real bake: safeCombatStep from r7c26 toward r12c26 is NOT null (door fallback not reached here)', () => {
    const next = safeCombatStep({ client: { self: { row: 7, col: 26 }, room: { objects: new Map() } },
      world: { geometry: geo38 } }, { row: 12, col: 26 });
    assert.ok(next, 'coarse grid has a path out of the chamber');
  });

  await test('advance(): a PvP approach with no floor step crosses a door instead of failing', async () => {
    const f = fixture();
    f.s.world.geometry.standable = () => false;         // safeCombatStep -> null
    f.c.room.objects.get(2).row = 20;                    // far away: approach needed
    let tried = 0;
    f.mode.crossDoorToward = async () => { tried++; return true; };
    f.mode.event({ kind: 'appeared', id: 2 });
    await f.mode.tick();
    assert.equal(tried, 1);
    assert.ok(!f.sent.some(x => x.startsWith('attack:')), `sent ${f.sent}`);
    assert.ok(f.mode.active?.pvp, 'the fight is still on');
    f.mode.stop('test');
  });

  await test('advance(): no floor step and no door -> "no safe approach to player"', async () => {
    const f = fixture();
    f.s.world.geometry.standable = () => false;
    f.c.room.objects.get(2).row = 20;
    let tried = 0;
    f.mode.crossDoorToward = async () => { tried++; return false; };
    const lines = [];
    f.s.recorder = { line: (k, v) => lines.push(v) };
    f.mode.event({ kind: 'appeared', id: 2 });
    let thrown = null;
    await f.mode.tick().catch(e => { thrown = e.message; });
    assert.equal(tried, 1);
    assert.ok(String(thrown).includes('no safe approach') || JSON.stringify(lines).includes('no safe approach'),
      `thrown ${thrown}; lines ${JSON.stringify(lines)}`);
    f.mode.stop('test');
  });
}

// ------------------------------------------------------------------ the pvpWand seam
//
// The volley decision is a fleet's bet, so a private `pvpWand` strategy answers it first and
// gear.chooseWandVolley is the fallback. These pin both halves and every way back to built-in.

const strategy = (pvpWand, { name = 'private-volley', enabled = true } = {}) =>
  ({ strategies: [{ name, kind: 'combat', enabled, pvpWand }], problems: [] });

await test('chooseWandVolley: nothing, holding, fired-this-beat and on-the-beat', () => {
  assert.deepEqual(gear.chooseWandVolley({ wands: [] }), { fire: null, hold: false, face: false, why: 'no volley wand' });
  const wands = [{ id: 7, name: 'lightning wand', timer: true }, { id: 8, name: 'wand of vampiric shock', timer: false }];
  assert.deepEqual(gear.chooseWandVolley({ wands, beat: 5, lastVolleyBeat: 4 }),
    { fire: 7, hold: true, face: true, why: 'on the beat' });
  assert.deepEqual(gear.chooseWandVolley({ wands, beat: 5, lastVolleyBeat: 5 }),
    { fire: null, hold: true, face: false, why: 'this beat already fired' });
  assert.deepEqual(gear.chooseWandVolley({ wands: [wands[1]], beat: 5, lastVolleyBeat: 4 }),
    { fire: 8, hold: false, face: false, why: 'on the beat' });
});

await test('checkWandAnswer: a wand the character does not hold, or a non-boolean, is refused', () => {
  const ctx = { wands: [{ id: 7, name: 'lightning wand', timer: true }] };
  assert.deepEqual(gear.checkWandAnswer({ fire: 7, hold: true }, ctx), { fire: 7, hold: true, face: false, why: null });
  assert.deepEqual(gear.checkWandAnswer({ hold: false }, ctx), { fire: null, hold: false, face: false, why: null });
  assert.ok(gear.checkWandAnswer({ fire: 99 }, ctx).invalid);
  assert.ok(gear.checkWandAnswer({ fire: 7, hold: 'yes' }, ctx).invalid);
  assert.ok(gear.checkWandAnswer('fire', ctx).invalid);
});

await test('a private strategy decides: no zap and no hold means the character swings', async () => {
  const f = fixture({ items: ['lightning wand'] });
  const asked = [];
  f.mode.wandStrategies = strategy(ctx => { asked.push(ctx); return { fire: null, hold: false }; });
  f.at(12_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(!f.sent.some(x => x.startsWith('apply:')), `sent ${f.sent}`);
  assert.ok(f.sent.some(x => x.startsWith('attack:')), 'not holding: melee runs');
  const ctx = asked[0];
  assert.equal(ctx.character, 'Kermit');
  assert.deepEqual(ctx.wands.map(w => [w.name, w.timer]), [['lightning wand', true]]);
  assert.equal(ctx.target.id, 2); assert.equal(ctx.target.player, true); assert.equal(ctx.target.dist, 1);
  assert.deepEqual(ctx.me, { row: 5, col: 5, hp: 100, max_hp: 100 });
  assert.equal(ctx.beat, gear.beatOf(12_000_000, 2000)); assert.equal(ctx.pvp, true);
  f.mode.stop('test');
});

await test('a private strategy picks the wand: the vampiric one, not the lightning one listed first', async () => {
  const f = fixture({ items: ['lightning wand', 'wand of vampiric shock'] });
  f.mode.wandStrategies = strategy(ctx => ({ fire: ctx.wands.find(w => !w.timer).id, hold: false }));
  f.at(14_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(f.sent.includes('apply:wand of vampiric shock->2'), `sent ${f.sent}`);
  assert.ok(!f.sent.includes('apply:lightning wand->2'));
  assert.ok(!f.sent.includes('face') || f.sent.indexOf('face') > f.sent.indexOf('apply:wand of vampiric shock->2'),
    'face was not asked for before the zap');
  assert.equal(f.mode.active.pvp.wand_strategy, 'private-volley');
  f.mode.stop('test');
});

for (const [why, wandStrategies] of [
  ['declines (null)', strategy(() => null)],
  ['is disabled', strategy(() => ({ fire: null, hold: false }), { enabled: false })],
  ['throws', strategy(() => { throw new Error('boom'); })],
  ['names a wand it does not hold', strategy(() => ({ fire: 4242, hold: false }))],
]) {
  await test(`a strategy that ${why} leaves the built-in volley firing`, async () => {
    const f = fixture({ items: ['lightning wand'] });
    f.mode.wandStrategies = wandStrategies;
    const errors = [], err = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      f.at(16_000_000);
      f.mode.event({ kind: 'appeared', id: 2 });
      await f.mode.tick();
      f.advance(2100); await f.mode.tick();
    } finally { console.error = err; }
    assert.equal(f.sent.filter(x => x === 'apply:lightning wand->2').length, 2, `sent ${f.sent}`);
    assert.ok(!f.sent.some(x => x.startsWith('attack:')), 'built-in: a lightning wand holds the swing');
    assert.equal(f.mode.active.pvp.wand_strategy, 'builtin');
    const faulty = /throws|does not hold/.test(why);
    assert.equal(errors.length, faulty ? 1 : 0, `a fault is reported once per fight, a decline never: ${errors}`);
    f.mode.stop('test');
  });
}

await test('a refusal is marked on the shot it answers, and the next ask sees it', async () => {
  const f = fixture({ items: ['lightning wand'] });
  const asked = [];
  f.mode.wandStrategies = strategy(ctx => { asked.push(ctx); return null; });
  f.at(18_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  f.mode.event({ kind: 'message', text: 'You point your wand but nothing happens.' });
  f.advance(2100); await f.mode.tick();
  assert.deepEqual(asked.at(-1).shots.map(x => [x.wand, x.refused]), [['lightning wand', true]]);
  assert.deepEqual(f.mode.active.wandShots.map(x => x.refused), [true, false], 'the second shot stands unrefused');
  f.mode.stop('test');
});

await test('a no-combat room is checked before any strategy is asked', async () => {
  const f = fixture({ items: ['lightning wand'] });
  let asked = 0;
  f.mode.wandStrategies = strategy(ctx => { asked++; return { fire: ctx.wands[0].id, hold: true }; });
  f.mode.pvpForbiddenHere = () => true;
  const o = { client: f.c, targetId: 2 };
  assert.equal(await f.mode.wandVolley(o), null);
  assert.equal(asked, 0);
  assert.ok(!f.sent.some(x => x.startsWith('apply:')));
});

// ------------------------------------------------------------------ the decoded tint, offered privately
//
// The wire carries XLAT_BASE_VALUE 0x87 + 11*viColor + label (util.kod:271): a lightning wand is
// 223, a wand of identification 201 (measured on prod 2026-10-06). effectiveName still compares
// the raw byte with 8 -- deliberately unchanged -- and the decoded reading goes to a private
// pvpWand strategy as ctx.unidentified, so the rollout is the operator's.
const WIRE_YELLOW = 0x87 + 11 * gear.XLAT_TO_YELLOW, WIRE_BLUE = 0x87 + 11 * 0x06;

await test('decodePrimaryColour: the encoded pair, as util.kod DecodePrimaryColor', () => {
  assert.equal(WIRE_YELLOW, 223); assert.equal(WIRE_BLUE, 201);
  assert.equal(gear.decodePrimaryColour(223), 8);
  assert.equal(gear.decodePrimaryColour(201), 6);
  assert.equal(gear.decodePrimaryColour(223 + 5), 8, 'a label colour does not change the primary');
  assert.equal(gear.decodePrimaryColour(0), null); assert.equal(gear.decodePrimaryColour(undefined), null);
  assert.equal(gear.decodePrimaryColour(8), null, 'a raw 8 is not an encoding the server sends');
  assert.equal(gear.decodePrimaryColour(122), 0x0B); assert.equal(gear.decodePrimaryColour(126), 0x0C);
});

await test('effectiveName is unchanged: a real yellow wand (223) is still just "wand" in public code', () => {
  assert.equal(gear.effectiveName({}, { name: 'wand', translation: WIRE_YELLOW }), 'wand');
});

await test('unidentifiedWandsIn: bare "wand" rows with their decoded colour; a spent one is skipped', () => {
  const names = new Map([[100, 'wand'], [101, 'Wand '], [102, 'lightning wand'], [103, 'herb']]);
  const c = { rsc: names, inventory: [{ id: 100, nameRsc: 100, translation: WIRE_YELLOW },
    { id: 101, nameRsc: 101, translation: WIRE_BLUE }, { id: 102, nameRsc: 102 }, { id: 103, nameRsc: 103 }] };
  assert.deepEqual(gear.unidentifiedWandsIn(c).map(u => [u.id, u.colour]), [[100, 8], [101, 6]]);
  assert.deepEqual(gear.unidentifiedWandsIn(c, { spent: new Set([100]) }).map(u => u.id), [101]);
});

const yellowPack = () => {
  const f = fixture({ items: ['wand', 'wand'] });
  f.c.inventory[0].translation = WIRE_BLUE; f.c.inventory[1].translation = WIRE_YELLOW;
  return { f, blue: f.c.inventory[0].id, yellow: f.c.inventory[1].id };
};

await test('no strategy: an unidentified yellow wand is never fired and melee runs, exactly as before', async () => {
  const { f } = yellowPack();
  f.at(20_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.ok(!f.sent.some(x => x.startsWith('apply:')), `sent ${f.sent}`);
  assert.ok(f.sent.some(x => x.startsWith('attack:')), 'the built-in never holds for an unidentified wand');
  f.mode.stop('test');
});

await test('a strategy sees ctx.unidentified (decoded) and max health, and may fire the yellow one', async () => {
  const { f, blue, yellow } = yellowPack();
  const asked = [];
  f.mode.wandStrategies = strategy(ctx => {
    asked.push(ctx);
    const y = ctx.unidentified.find(u => u.colour === 8);
    return ctx.beat === ctx.lastVolleyBeat ? { fire: null, hold: true } : { fire: y.id, hold: true, face: true };
  });
  f.at(22_000_000);
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.deepEqual(asked[0].unidentified.map(u => [u.id, u.colour]), [[blue, 6], [yellow, 8]]);
  assert.deepEqual(asked[0].wands, [], 'public effectiveName did not promote it to a volley wand');
  assert.equal(asked[0].me.max_hp, 100); assert.equal(asked[0].me.hp, 100);
  assert.ok(f.sent.includes('apply:wand->2') && f.sent.includes('face'), `sent ${f.sent}`);
  assert.ok(!f.sent.some(x => x.startsWith('attack:')), 'holding: no melee');
  assert.equal(f.mode.active.pvp.last_wand, 'wand');
  f.mode.stop('test');
});

await test('checkWandAnswer accepts an unidentified wand the character holds, and still refuses a stranger id', () => {
  const ctx = { wands: [], unidentified: [{ id: 9, translation: 223, colour: 8 }] };
  assert.equal(gear.checkWandAnswer({ fire: 9, hold: true }, ctx).fire, 9);
  assert.ok(gear.checkWandAnswer({ fire: 10 }, ctx).invalid);
});

// ------------------------------------------------------------------ the pvpOpener seam
//
// A private strategy may open a fight with a spell at the target the fight already chose, before
// the gear, the volley and the swing; `wait` holds the beat without falling through to the chase.
// It never picks a target, and every way it can fail leaves the fight exactly as it was.

const opener = (pvpOpener, { name = 'private-opener', enabled = true } = {}) =>
  ({ strategies: [{ name, kind: 'combat', enabled, pvpOpener }], problems: [] });
const withSpell = f => {
  f.c.rsc.set(900, 'stun');
  f.c.spells = [{ id: 900, nameRsc: 900 }];
  f.c.cast = (id, targets) => f.sent.push(`cast:${f.c.rsc.get(id)}->${targets.join(',')}`);
  return f;
};

await test('an opener casts at the fight\'s own target before the gear goes on and before any swing', async () => {
  const f = withSpell(fixture({ items: ['plate armor'] }));
  f.c.inventory.push({ id: 950, nameRsc: 950, amount: 4 }); f.c.rsc.set(950, 'purple mushroom');
  const asked = [];
  f.mode.wandStrategies = opener(ctx => { asked.push(ctx); return { cast: 'stun' }; });
  f.mode.agentId = 't7';
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick();
  assert.deepEqual(f.sent.filter(x => x !== 'stand'), ['cast:stun->2'], `sent ${f.sent}`);
  assert.equal(asked[0].agent, 't7'); assert.equal(asked[0].target.id, 2); assert.equal(asked[0].target.player, true);
  assert.deepEqual(asked[0].spells, ['stun']); assert.equal(asked[0].pack['purple mushroom'], 4);
  assert.equal(asked[0].last_cast_at, null);
  assert.equal(f.mode.active.pvp.opener_casts, 1);
  f.advance(1100); await f.mode.tick();
  assert.ok(f.sent.includes('use:plate armor'), `the gear goes on after the first cast: ${f.sent}`);
  assert.equal(f.sent.filter(x => x === 'cast:stun->2').length, 2, 'and the opener keeps the beat after it');
  assert.ok(!f.sent.some(x => x.startsWith('attack:')));
  assert.ok(asked.at(-1).last_cast_at != null && asked.at(-1).last_spell === 'stun');
  f.mode.stop('test');
});

await test('wait sends nothing and does not fall through to the swing', async () => {
  const f = withSpell(fixture());
  f.mode.wandStrategies = opener(() => ({ wait: true }));
  f.mode.event({ kind: 'appeared', id: 2 });
  await f.mode.tick(); f.advance(1100); await f.mode.tick();
  assert.ok(!f.sent.some(x => /^(cast|attack|apply):/.test(x)), `sent ${f.sent}`);
  f.mode.stop('test');
});

for (const [why, strategies, faulty] of [
  ['declines (null)', opener(() => null), false],
  ['is disabled', opener(() => ({ cast: 'stun' }), { enabled: false }), false],
  ['throws', opener(() => { throw new Error('boom'); }), true],
  ['names a spell the character does not know', opener(() => ({ cast: 'fireball' })), true],
  ['answers neither cast nor wait', opener(() => ({ maybe: true })), true],
]) {
  await test(`an opener that ${why} leaves the fight swinging as before`, async () => {
    const f = withSpell(fixture());
    f.mode.wandStrategies = strategies;
    const errors = [], err = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try { f.mode.event({ kind: 'appeared', id: 2 }); await f.mode.tick(); f.advance(1100); await f.mode.tick(); }
    finally { console.error = err; }
    assert.ok(!f.sent.some(x => x.startsWith('cast:')), `sent ${f.sent}`);
    assert.ok(f.sent.some(x => x.startsWith('attack:')), 'the fight goes on: it swings');
    assert.equal(errors.length, faulty ? 1 : 0, `a fault is reported once per fight, a decline never: ${errors}`);
    f.mode.stop('test');
  });
}

await test('an opener is never asked in a room that forbids the fight', async () => {
  const f = withSpell(fixture());
  let asked = 0;
  f.mode.wandStrategies = opener(() => { asked++; return { cast: 'stun' }; });
  f.mode.pvpForbiddenHere = () => true;
  assert.equal(await f.mode.pvpOpener({ client: f.c, targetId: 2 }, f.c.room.objects.get(2)), false);
  assert.equal(asked, 0);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
