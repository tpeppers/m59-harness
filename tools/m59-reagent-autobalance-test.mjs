#!/usr/bin/env node
// THE REAGENT AUTOBALANCER, OFFLINE.   node tools/m59-reagent-autobalance-test.mjs
//
// Pins tools/m59-reagent-autobalance.mjs and its keeper wiring (tools/autopilot/town-trip.mjs, shopping.mjs,
// inventory.mjs, market.mjs, delivery.mjs): the kod's mana regeneration, practice and maintenance estimates with the real
// catalogue costs, the PvP floor ON TOP and named, a sapphire spell refused with its reason, the departure fit, the learner
// up after running out and down after leftovers (bounded, converging rather than oscillating), the signed lap
// discrepancy, the trip triggers, hand edits over the learner, the courier pause/resume, and -- first and last -- that NO
// ORDERS MEANS THE KEEPER IS UNCHANGED. Orders and learned state live in a temp directory; no socket, no roster.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-autobalance-'));
process.env.M59_REAGENT_AUTOBALANCE_FILE = join(dir, 'orders.json');
process.env.M59_REAGENT_AUTOBALANCE_DIR = join(dir, 'learned');
process.env.M59_REAGENT_RESERVE_FILE = join(dir, 'reserve.json');
const AB = await import('./m59-reagent-autobalance.mjs');
const { spellCost } = await import('./m59-deskpractice.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const skills = await import('./m59-skills.mjs');
const CLI = await import('./m59-autobalance.mjs');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok ${name}`); };
const writeOrders = book => { writeFileSync(process.env.M59_REAGENT_AUTOBALANCE_FILE, JSON.stringify(book)); AB.forgetOrders(); };
const KNOWN = ['haste', 'super strength', 'resist poison', 'bless'];
const PROD_RESERVE = { spells: { 'super strength': 2, bless: 3, 'magic shield': 4 }, items: { sapphire: 100000 }, exempt: ['discordance'] };
const BIG = { weight_max: 100000, bulk_max: 100000 };
const practiceLoop = (over = {}) => AB.normalizeLoop({ mode: 'practice', practice: ['haste', 'super strength', 'resist poison'],
  loot_per_kill: { weight: 1, bulk: 2 }, max_lap_minutes: 10000, ...over });

try {
  // ------------------------------------------------------------------ the game's numbers
  await test('mana regeneration is the kod formula (player.kod CalculateManaTime)', () => {
    // 29 max mana, mysticism 23, 100 vigor: (150000 + 2000) * 200/100 / 29 = 10482 ms a point -> 5.724 a minute
    assert.equal(+AB.manaRegenPerMinute({ mysticism: 23, maxMana: 29, vigor: 100 }).toFixed(3), 5.724);
    // the harness's own published figure (m59-practice-once.mjs): 27 max, mysticism 30, 200 vigor -> 11.2
    assert.equal(+AB.manaRegenPerMinute({ mysticism: 30, maxMana: 27, vigor: 200 }).toFixed(1), 11.2);
    assert.equal(AB.manaRegenPerMinute({ mysticism: 50, maxMana: 500, vigor: 200 }), 60, 'bounded at one point a second');
  });

  await test('the catalogue costs the planner uses are the kod\'s', () => {
    assert.deepEqual(spellCost('haste'), { name: 'haste', mana: 10, reagents: [['edible mushroom', 5]] });
    assert.deepEqual(spellCost('super strength').reagents, [['mushroom', 2], ['orc tooth', 1]]);
    assert.deepEqual(spellCost('resist poison').reagents, [['herb', 2], ['red mushroom', 1]]);
  });

  await test('lap length: the binding ceiling, at the trigger, at the kill rate', () => {
    const l = AB.lapMinutes({ capacity: { weight_max: 2200, bulk_max: 2200 }, load: { weight: 500, bulk: 600 },
      sellAtLoad: 0.9, perKill: { weight: 1, bulk: 2 }, killsPerMinute: 1 });
    assert.equal(l.binding, 'bulk');
    assert.equal(l.minutes, (1980 - 600) / 2);
    assert.equal(AB.lapMinutes({ capacity: { weight_max: 2200 }, load: { weight: 2000, bulk: 2000 }, perKill: { weight: 1, bulk: 1 } }).minutes, 0);
  });

  await test('loot per kill comes from the room\'s drop tables, restricted to what is looted', () => {
    const spawns = JSON.parse(readFileSync(new URL('../substrate/m59-spawns.json', import.meta.url), 'utf8'));
    const l = AB.lootPerKill({ spawns, room: 27, hunt: ['orc', 'spider'], lootOnly: ['purple mushroom', 'edible mushroom', 'mushroom', 'orc tooth'] });
    // orc: tooth 40% (3/3) + purple 20% (2/5) = 1.6 / 2.2; spider: edible 16% (2/3) + purple 15% (2/5) = 0.62 / 1.23
    assert.equal(+l.weight.toFixed(3), 1.11);
    assert.equal(+l.bulk.toFixed(3), 1.715);
  });

  // ------------------------------------------------------------------ the estimate
  await test('practice: casts are the lap\'s mana over the mean cast, round-robin, times the kod reagents', () => {
    const p = AB.planLap({ loop: practiceLoop(), known: KNOWN, mana: { max: 29 }, mysticism: 23, capacity: BIG,
      startLoad: { weight: 0, bulk: 0 }, sellAtLoad: 0.9 });
    const lap = (0.9 * 100000) / 2;   // 45000 min uncapped... capped by max_lap_minutes 10000
    assert.equal(p.lapMinutes, 10000);
    const total = Math.floor((29 + AB.manaRegenPerMinute({ mysticism: 23, maxMana: 29 }) * 10000) / 10);
    assert.equal(p.casts.haste + p.casts['super strength'] + p.casts['resist poison'], total);
    assert.equal(p.wants['edible mushroom'], p.casts.haste * 5);
    assert.equal(p.wants['orc tooth'], p.casts['super strength']);
    assert.equal(p.wants.mushroom, p.casts['super strength'] * 2);
    assert.equal(p.wants.herb, p.casts['resist poison'] * 2);
    assert.ok(lap > 10000);
  });

  await test('practice is capped by the cast gap when that binds first', () => {
    const p = AB.planLap({ loop: practiceLoop({ gap_ms: 600_000, max_lap_minutes: 60 }), known: KNOWN, mana: { max: 29 },
      mysticism: 50, capacity: BIG });
    assert.equal(Object.values(p.casts).reduce((a, b) => a + b, 0), 6, '60 min / 10 min gap');
  });

  await test('maintenance: 1 + ceil(lap / duration) per buff', () => {
    const loop = AB.normalizeLoop({ mode: 'maintenance', maintain: ['haste', 'resist poison'], loot_per_kill: { weight: 1, bulk: 1 },
      durations: { haste: 5, 'resist poison': 11.25 }, max_lap_minutes: 60 });
    const p = AB.planLap({ loop, known: KNOWN, mana: { max: 200 }, mysticism: 50, capacity: BIG });
    assert.equal(p.casts.haste, 1 + 12);
    assert.equal(p.casts['resist poison'], 1 + Math.ceil(60 / 11.25));
    assert.equal(p.wants['edible mushroom'], 13 * 5);
    const buffs = AB.buffTable();
    if (buffs.length) {
      const d = AB.planningDuration('haste');
      assert.equal(d.minutes, 3.75, 'haste.kod: random(D/2, D) at power 0, D = 5 min -> mean 3.75');
      assert.equal(AB.planningDuration('resist poison').minutes, 11.25);
    } else console.log('   (kod tree not found: kod-derived durations skipped)');
  });

  await test('the PvP floor is ON TOP of the plan, and every line names it', () => {
    const p = AB.planLap({ loop: practiceLoop({ max_lap_minutes: 60 }), known: KNOWN, mana: { max: 29 }, mysticism: 23,
      capacity: BIG, reserve: PROD_RESERVE });
    assert.equal(p.pvp.mushroom, 2 * 2 + 3 * 2, 'super strength 2 casts + bless 3 casts; magic shield not known');
    assert.equal(p.pvp['orc tooth'], 2);
    assert.equal(p.totals.mushroom, p.wants.mushroom + 10);
    assert.ok(p.lines.includes(`mushroom: ${p.wants.mushroom} planned + 10 PvP reserve = ${p.wants.mushroom + 10} (estimate)`), p.lines.join('\n'));
    assert.ok(p.lines.every(l => / PvP reserve = /.test(l)), 'a line with no reserve still says 0');
  });

  await test('a spell whose reagent the reserve holds in bulk is un-plannable, with the reason', () => {
    const p = AB.planLap({ loop: practiceLoop({ practice: ['bless', 'haste'], max_lap_minutes: 60 }), known: KNOWN,
      mana: { max: 29 }, mysticism: 23, capacity: BIG, reserve: PROD_RESERVE });
    const u = p.unplannable.find(x => x.spell === 'bless');
    assert.ok(u && /sapphire/.test(u.why) && /floor 100006/.test(u.why) && /vetoed/.test(u.why), JSON.stringify(p.unplannable));
    assert.equal(p.wants.sapphire, undefined, 'nothing carried for it');
    assert.ok(p.casts.haste > 0);
    const only = AB.planLap({ loop: practiceLoop({ practice: ['bless'] }), known: KNOWN, mana: { max: 29 }, capacity: BIG, reserve: PROD_RESERVE });
    assert.equal(only.ok, false);
    assert.match(only.why, /nothing plannable/);
  });

  await test('unknown and finished spells are refused with a reason', () => {
    const p = AB.planLap({ loop: practiceLoop({ practice: ['haste', 'deflect', 'resist poison'] }), known: KNOWN,
      abilities: { 'resist poison': 99 }, mana: { max: 29 }, capacity: BIG });
    assert.deepEqual(p.unplannable.map(u => u.spell).sort(), ['deflect', 'resist poison']);
  });

  await test('a plan that does not fit the pack at departure is cut to fit, and says so', () => {
    const p = AB.planLap({ loop: practiceLoop({ max_lap_minutes: 600 }), known: KNOWN, mana: { max: 29 }, mysticism: 23,
      capacity: { weight_max: 2200, bulk_max: 2200 }, startLoad: { weight: 500, bulk: 600 } });
    assert.ok(p.cut_to_fit, 'cut');
    let bulk = 0;
    for (const [item, n] of Object.entries(p.totals)) bulk += n * ({ 'edible mushroom': 3, mushroom: 5, 'orc tooth': 3, herb: 4, 'red mushroom': 5 })[item];
    assert.ok(bulk <= 0.9 * 2200 - 600, `fits: ${bulk}`);
  });

  // ------------------------------------------------------------------ hand edits
  await test('a pinned amount and a hand multiplier win over the learner', () => {
    const learned = { laps_seen: 3, pack_minutes: 60, use_per_minute: { mushroom: 100, herb: 100 } };
    const p = AB.planLap({ loop: practiceLoop({ pinned: { mushroom: 14 }, multipliers: { herb: 0.5 }, max_lap_minutes: 60 }),
      known: KNOWN, mana: { max: 29 }, mysticism: 23, capacity: BIG, learned, reserve: PROD_RESERVE });
    assert.equal(p.wants.mushroom, 14);
    assert.ok(p.lines.includes('mushroom: 14 planned + 10 PvP reserve = 24 (pinned by hand)'), p.lines.join('\n'));
    const est = AB.planLap({ loop: practiceLoop({ max_lap_minutes: 60 }), known: KNOWN, mana: { max: 29 }, mysticism: 23, capacity: BIG });
    assert.equal(p.wants.herb, Math.ceil(est.wants.herb * 0.5), 'the multiplier is on the estimate, not on the learned 100/min');
    assert.equal(p.lap_source, 'learned');
  });

  await test('editLoop records who, when and why, and clear undoes', () => {
    const book = {};
    AB.editLoop(book, 'Scooter', { key: 'pinned.mushroom', value: 14, by: 'tester', why: 'hand tune', at: 1000 });
    AB.editLoop(book, 'Scooter', { key: 'trigger', value: 'first', by: 'tester', why: 'try first', at: 2000 });
    assert.equal(book.loops.Scooter.pinned.mushroom, 14);
    assert.equal(book.loops.Scooter.edits.length, 2);
    assert.deepEqual({ by: book.loops.Scooter.edits[1].by, why: book.loops.Scooter.edits[1].why, key: 'trigger' },
                     { by: 'tester', why: 'try first', key: book.loops.Scooter.edits[1].key });
    AB.editLoop(book, 'scooter', { key: 'pinned.mushroom', clear: true, by: 'tester' });
    assert.equal(book.loops.Scooter.pinned.mushroom, undefined, 'case-insensitive character, cleared');
    assert.throws(() => AB.editLoop(book, 'Scooter', { key: 'nonsense', value: 1 }), /not a loop key/);
    assert.deepEqual(CLI.parseValue('practice', 'haste, bless'), ['haste', 'bless']);
    assert.equal(CLI.parseValue('kills_per_minute', '1.5'), 1.5);
  });

  await test('orders: unknown keys reported not applied; an unparseable file is not an empty file', () => {
    const problems = [];
    const loop = AB.normalizeLoop({ mode: 'practice', practice: ['haste'], frobnicate: 3, trigger: 'sometimes' }, problems);
    assert.ok(problems.some(p => /frobnicate/.test(p)) && problems.some(p => /trigger/.test(p)));
    assert.equal(loop.trigger, 'pack', 'an unusable trigger keeps the default');
    assert.equal(loop.frobnicate, undefined);
    writeOrders({ loops: { Scooter: { mode: 'practice', practice: ['haste'] } } });
    const f = process.env.M59_REAGENT_AUTOBALANCE_FILE;
    const good = AB.readOrders(f, 1);
    writeFileSync(f, '{ not json');
    const after = AB.readOrders(f, 1 + AB.RECHECK_MS + 5);
    assert.deepEqual(after, good, 'the last good orders stand');
    assert.match(AB.ordersError(f), /last good orders stand/);
    rmSync(f);
  });

  // ------------------------------------------------------------------ the learner
  const plan0 = () => AB.planLap({ loop: practiceLoop({ practice: ['haste'], max_lap_minutes: 60 }), known: KNOWN, mana: { max: 29 },
    mysticism: 23, capacity: BIG });
  await test('ran out early: the discrepancy is negative, in minutes, and the next lap carries more (at most x2)', () => {
    const p = plan0();
    const lap = AB.startLap({ plan: p, pack: [{ name: 'edible mushroom', amount: p.totals['edible mushroom'] }], at: 0, fullness: 0.3 });
    AB.observeLap(lap, { pack: [{ name: 'edible mushroom', amount: 2 }], at: 30 * 60000, fullness: 0.6 });
    assert.equal(lap.short_at['edible mushroom'], 30 * 60000);
    const r = AB.recordLap({ lap, end: [{ name: 'edible mushroom', amount: 2 }], endedAt: 60 * 60000, endedBy: 'pack' });
    assert.equal(r.discrepancy.minutes, -30);
    assert.match(r.discrepancy.verdict, /ran out 30.0 min before the pack filled/);
    const est = p.wants['edible mushroom'] / 60;
    assert.ok(r.learned.use_per_minute['edible mushroom'] > est && r.learned.use_per_minute['edible mushroom'] <= est * 2);
    const next = AB.planLap({ loop: practiceLoop({ practice: ['haste'], max_lap_minutes: 60 }), known: KNOWN, mana: { max: 29 },
      mysticism: 23, capacity: BIG, learned: r.learned });
    assert.ok(next.wants['edible mushroom'] > p.wants['edible mushroom']);
  });

  await test('leftovers above the PvP floor: positive discrepancy in casts and minutes, and the next lap carries less', () => {
    const p = AB.planLap({ loop: practiceLoop({ practice: ['super strength'], max_lap_minutes: 60 }), known: KNOWN,
      mana: { max: 29 }, mysticism: 23, capacity: BIG, reserve: PROD_RESERVE });
    const start = [{ name: 'mushroom', amount: p.totals.mushroom }, { name: 'orc tooth', amount: p.totals['orc tooth'] }];
    const lap = AB.startLap({ plan: p, pack: start, at: 0 });
    const half = Math.floor(p.wants['orc tooth'] / 2);
    const end = [{ name: 'mushroom', amount: p.totals.mushroom - 2 * half }, { name: 'orc tooth', amount: p.totals['orc tooth'] - half }];
    AB.observeLap(lap, { pack: end, at: 60 * 60000 });
    const r = AB.recordLap({ lap, end, endedAt: 60 * 60000, endedBy: 'pack' });
    assert.ok(r.discrepancy.minutes > 0 && r.discrepancy.casts_left === p.wants['orc tooth'] - half, JSON.stringify(r.discrepancy));
    assert.equal(r.per_item.mushroom.end_usable, p.wants.mushroom - 2 * half, 'leftover counted ABOVE the 10 PvP mushrooms');
    const next = AB.planLap({ loop: practiceLoop({ practice: ['super strength'], max_lap_minutes: 60 }), known: KNOWN,
      mana: { max: 29 }, mysticism: 23, capacity: BIG, reserve: PROD_RESERVE, learned: r.learned });
    assert.ok(next.wants['orc tooth'] < p.wants['orc tooth'] && next.wants['orc tooth'] >= half);
    assert.equal(next.pvp.mushroom, 10, 'the floor does not learn');
  });

  await test('the learner converges on the true rate and lap length: the discrepancy shrinks, nothing blows up', () => {
    // The world: the pack really fills in 90 minutes and practice really spends 1.2 edible mushrooms a minute.
    const TRUE_RATE = 1.2, TRUE_PACK = 90;
    const loop = practiceLoop({ practice: ['haste'], loot_per_kill: { weight: 1, bulk: 1 }, max_lap_minutes: 30 });
    let learned = null; const seen = [];
    for (let i = 0; i < 12; i++) {
      const p = AB.planLap({ loop, known: KNOWN, mana: { max: 29 }, mysticism: 23, capacity: BIG, learned });
      const carried = p.totals['edible mushroom'];
      const runOut = carried / TRUE_RATE;
      const lap = AB.startLap({ plan: p, pack: [{ name: 'edible mushroom', amount: carried }], at: 0, fullness: 0 });
      const endAt = TRUE_PACK;
      const left = Math.max(0, Math.round(carried - TRUE_RATE * endAt));
      if (runOut < endAt) AB.observeLap(lap, { pack: [{ name: 'edible mushroom', amount: 0 }], at: runOut * 60000 });
      const r = AB.recordLap({ lap, end: [{ name: 'edible mushroom', amount: left }], endedAt: endAt * 60000, endedBy: 'pack', learned });
      learned = r.learned; seen.push(r.discrepancy.minutes);
    }
    const first = Math.abs(seen[0]), last = Math.abs(seen.at(-1));
    assert.ok(last < 3, `converged: ${seen.join(', ')}`);
    assert.ok(last < first, 'smaller than it started');
    assert.ok(Math.abs(learned.pack_minutes - TRUE_PACK) < 1 && Math.abs(learned.use_per_minute['edible mushroom'] - TRUE_RATE) < 0.05,
      JSON.stringify(learned));
    assert.ok(seen.every(d => Math.abs(d) <= Math.max(first, 90)), 'bounded throughout');
  });

  await test('a lap the reagents ended early extrapolates the pack time instead of believing it', () => {
    const p = plan0();
    const lap = AB.startLap({ plan: p, pack: [{ name: 'edible mushroom', amount: p.totals['edible mushroom'] }], at: 0, fullness: 0.3 });
    const r = AB.recordLap({ lap, end: [], endedAt: 20 * 60000, endedBy: 'reagents', fullnessEnd: 0.5, sellAtLoad: 0.9 });
    assert.equal(+r.pack_minutes.toFixed(2), 60, '0.3 -> 0.5 in 20 min: 0.9 is 60 min');
  });

  // ------------------------------------------------------------------ the triggers
  await test('trip triggers: pack, first, reagents, and cancel_on_empty', () => {
    const p = AB.planLap({ loop: practiceLoop({ max_lap_minutes: 60 }), known: KNOWN, mana: { max: 29 }, mysticism: 23, capacity: BIG });
    const lap = AB.startLap({ plan: p, pack: [], at: 0 });
    AB.observeLap(lap, { pack: [{ name: 'edible mushroom', amount: 10 }], at: 1 });   // only haste affordable
    const L = t => AB.normalizeLoop({ mode: 'practice', practice: ['haste'], trigger: t });
    assert.equal(AB.lapVerdict({ loop: L('first'), lap }).end, false, 'one practice spell still castable: not empty');
    AB.observeLap(lap, { pack: [], at: 2 });
    assert.equal(AB.lapVerdict({ loop: L('pack'), lap, fullness: 0.5 }).end, false, 'pack: only a full pack ends it');
    assert.equal(AB.lapVerdict({ loop: L('pack'), lap, fullness: 0.95 }).by, 'pack');
    assert.equal(AB.lapVerdict({ loop: L('first'), lap, fullness: 0.5 }).by, 'reagents');
    assert.equal(AB.lapVerdict({ loop: L('reagents'), lap, fullness: 0.99 }).by, 'reagents');
    const fresh = AB.startLap({ plan: p, pack: [], at: 0 });
    assert.equal(AB.lapVerdict({ loop: L('reagents'), lap: fresh, fullness: 0.99 }).end, false, 'reagents: a full pack does not end it');
    const c = AB.lapVerdict({ loop: AB.normalizeLoop({ mode: 'practice', practice: ['haste'], trigger: 'pack', cancel_on_empty: true }), lap });
    assert.equal(c.cancel, true);
    const m = AB.planLap({ loop: AB.normalizeLoop({ mode: 'maintenance', maintain: ['haste', 'super strength'], durations: { haste: 5, 'super strength': 5 },
      loot_per_kill: { weight: 1, bulk: 1 }, max_lap_minutes: 30 }), known: KNOWN, mana: { max: 100 }, capacity: BIG });
    const ml = AB.startLap({ plan: m, pack: [], at: 0 });
    AB.observeLap(ml, { pack: [{ name: 'edible mushroom', amount: 50 }], at: 1 });
    assert.equal(AB.lapVerdict({ loop: AB.normalizeLoop({ mode: 'maintenance', maintain: ['haste'], trigger: 'first' }), lap: ml }).by, 'buff',
      'maintenance: ANY required buff that cannot be kept up ends it');
  });

  // ------------------------------------------------------------------ couriers
  await test('courier: two deliveries that could not land pause the item; need AND room resume it', () => {
    const st = {};
    AB.recordDelivery(st, { recipient: 'Robin', item: 'herb', why: 'receiver_full', at: 1 });
    assert.equal(AB.courierGate(st, { recipient: 'Robin', item: 'herb', evidence: { need: 5 } }).buy, true, 'one failure is not a pattern');
    AB.recordDelivery(st, { recipient: 'Robin', item: 'herbs', why: 'farmer did not counter the gift', at: 2 });
    AB.recordDelivery(st, { recipient: 'Robin', item: 'herb', why: 'could not reach room 27', at: 3 });
    assert.equal(st.robin.herb.failures, 2, 'a walk failure is not evidence about the recipient');
    assert.equal(AB.courierGate(st, { recipient: 'Robin', item: 'herb', evidence: { need: 5 } }).buy, false, 'need without room: paused');
    assert.equal(AB.courierGate(st, { recipient: 'Robin', item: 'herb', evidence: { need: 0, pack: 0.4 } }).buy, false, 'room without need: paused');
    const g = AB.courierGate(st, { recipient: 'Robin', item: 'herb', evidence: { need: 5, pack: 0.4 } });
    assert.ok(g.buy && g.resumed);
    AB.recordDelivery(st, { recipient: 'Robin', item: 'herb', delivered: 5, at: 4 });
    assert.equal(st.robin.herb.paused, false);
    assert.equal(st.robin.herb.failures, 0);
  });

  // ------------------------------------------------------------------ the keeper
  const items = (rows) => rows.map((r, i) => ({ id: i + 1, nameRsc: r.name, amount: r.amount ?? 1 }));
  const rig = ({ pack = [], policy = {}, who = { fleet: 'test', agent: 't21', character: 'Scooter' } } = {}) => {
    const events = [], notes = [];
    const k = Object.create(Autopilot.prototype);
    const client = { inventory: items(pack), rsc: { get: x => x }, me: { name: 'Scooter' },
      spells: KNOWN.map((n, i) => ({ id: 100 + i, nameRsc: n })), abilities: new Map(),
      stat: s => ({ might: 25, mysticism: 23 })[s] ?? null, vitals: () => ({ mana: { value: 29, max: 29 }, vigor: { value: 150, scale_max: 200 } }),
      equipment: () => ({ known: false }) };
    Object.assign(k, { policy: { strategy: 'fieldrest', ...policy }, money: { trips: 0, trips_failed: 0, why_not: [] },
      s: { client, reserveWho: who, world: { room: { num: 27 } }, need: () => client },
      ledgerEvent: (kind, data) => events.push({ kind, ...data }), note: (what, data) => notes.push({ what, ...data }),
      bansDestination: () => false, loadout: () => null, standingOrderUnstarted: () => null, overfarmHoldsTrip: () => null,
      supplyShortfall: () => ({ short: false }), saleRelief: () => null, guildStores: () => ({ plan: null }) });
    return { k, events, notes };
  };
  const strip = o => JSON.parse(JSON.stringify(o, (key, v) => (['startedAt', 'trip_started_at', 'client'].includes(key) ? undefined : v)));

  await test('NO ORDERS: the keeper is unchanged -- trip, purchase requests, sale loadout, trigger', () => {
    assert.equal(existsSync(process.env.M59_REAGENT_AUTOBALANCE_FILE), false);
    const pack = [{ name: 'shilling', amount: 500 }, { name: 'long sword' }, { name: 'herb', amount: 3 }];
    const a = rig({ pack }), b = rig({ pack, who: null });
    assert.equal(a.k.autobalanceLoop(), null);
    const ta = a.k.openTownTrip({ room: 104, name: 'Joguer' }, { sellCall: { trigger: 'load' } });
    const tb = b.k.openTownTrip({ room: 104, name: 'Joguer' }, { sellCall: { trigger: 'load' } });
    assert.equal('autobalance' in ta, false, 'no plan key on the trip at all');
    assert.deepEqual(strip(ta), strip(tb));
    assert.deepEqual(a.k.purchaseRequests(), b.k.purchaseRequests());
    assert.deepEqual(a.k.saleLoadout(), b.k.saleLoadout());
    assert.deepEqual(strip(a.k.checkIfShouldSell()), strip(b.k.checkIfShouldSell()));
    assert.equal(a.k.autobalanceTrigger(), null);
    assert.equal(a.k.autobalanceCouriers(), false, 'no courier orders: no pack fullness on the board');
    a.k.townTrip = ta; a.k.autobalanceObserve();
    assert.equal(a.k._abLap, undefined, 'no lap is opened');
  });

  await test('a "script" loop does not touch the keeper; a "keeper" loop plans the trip and overlays the restock', () => {
    writeOrders({ loops: { Scooter: { driver: 'script', mode: 'practice', practice: ['haste'] } } });
    assert.equal(rig().k.autobalanceLoop(), null, 'driver script: the keeper is unchanged');
    writeFileSync(process.env.M59_REAGENT_RESERVE_FILE, JSON.stringify({ default: PROD_RESERVE }));
    writeOrders({ loops: { Scooter: { driver: 'keeper', mode: 'practice', practice: ['haste', 'super strength'], loot_per_kill: { weight: 1, bulk: 2 },
      max_lap_minutes: 60 } } });
    const { k, events } = rig({ pack: [{ name: 'shilling', amount: 500 }, { name: 'orc tooth', amount: 4 }] });
    const trip = k.openTownTrip({ room: 104, name: 'Joguer' }, { sellCall: { trigger: 'load' } });
    assert.ok(trip.autobalance?.ok, JSON.stringify(trip.autobalance));
    assert.ok(events.some(e => e.kind === 'autobalance_plan' && e.lines.some(l => /mushroom: \d+ planned \+ 10 PvP reserve/.test(l))));
    k.townTrip = trip;
    const req = Object.fromEntries(k.purchaseRequests().map(r => [r.item, r.amount]));
    assert.equal(req['orc tooth'], trip.autobalance.totals['orc tooth'] - 4, 'asks for total less what is held');
    assert.equal(req.mushroom, trip.autobalance.totals.mushroom);
    const sale = k.saleLoadout();
    assert.equal(sale.carry.find(r => r.item === 'edible mushroom').max, trip.autobalance.totals['edible mushroom'], 'the sale keeps the lap');
  });

  await test('the trip boundary scores the lap, writes the learned file, and opens the next lap', () => {
    const { k, events } = rig({ pack: [{ name: 'shilling', amount: 500 }] });
    const t1 = k.openTownTrip({ room: 104 }, { sellCall: { trigger: 'load' } });
    k.autobalanceLapEnd(t1);
    assert.ok(k._abLap?.plan, 'first boundary: the lap opens with this trip\'s plan');
    k._abLap.started_at = Date.now() - 30 * 60000;
    k._abLap.start = AB.countsOf([{ name: 'edible mushroom', amount: 40 }, { name: 'mushroom', amount: 30 }, { name: 'orc tooth', amount: 12 }]);
    k.s.client.inventory = items([{ name: 'mushroom', amount: 10 }]);
    k.autobalanceObserve();
    const t2 = k.openTownTrip({ room: 104 }, { sellCall: { trigger: 'load' } });
    t2.startedAt += 20 * 60000;   // the pack fills twenty minutes after the reagents ran out
    k.autobalanceLapEnd(t2);
    const lapRow = events.find(e => e.kind === 'autobalance_lap');
    assert.ok(lapRow?.discrepancy && lapRow.discrepancy.minutes < 0, JSON.stringify(lapRow));
    const learned = JSON.parse(readFileSync(AB.learnedFile('test', 'Scooter'), 'utf8'));
    assert.equal(learned.loops.practice.laps_seen, 1);
    assert.ok(learned.loops.practice.start_load, 'the departure load is remembered for the next estimate');
  });

  await test('trigger "first" opens an autobalance trip when the reagents are gone; "reagents" holds a full pack only with overfarm', () => {
    writeOrders({ loops: { Scooter: { driver: 'keeper', mode: 'practice', practice: ['haste'], trigger: 'first', loot_per_kill: { weight: 1, bulk: 2 }, max_lap_minutes: 60 } } });
    const { k } = rig({ pack: [{ name: 'shilling', amount: 500 }] });
    k.autobalanceLapEnd(k.openTownTrip({ room: 104 }, { sellCall: { trigger: 'load' } }));
    k.lastTownServiceAt = 0;
    k.autobalanceObserve();
    const call = k.checkIfShouldSell();
    assert.equal(call.trigger, 'autobalance', JSON.stringify(call));
    k.lastTownServiceAt = Date.now();
    assert.notEqual(k.checkIfShouldSell().trigger, 'autobalance', 'not again inside the cooling window');
    writeOrders({ loops: { Scooter: { driver: 'keeper', mode: 'practice', practice: ['haste'], trigger: 'reagents', loot_per_kill: { weight: 1, bulk: 2 } } } });
    const full = [{ name: 'edible mushroom', amount: 50 }, { name: 'leather armor', amount: 1 }, ...Array.from({ length: 20 }, () => ({ name: 'scimitar' }))];
    const r2 = rig({ pack: full, policy: { minSellTripValue: 0 } });
    r2.k._abLap = AB.startLap({ plan: { ok: true, casts: { haste: 10 }, wants: { 'edible mushroom': 50 }, pvp: {}, totals: { 'edible mushroom': 50 }, lapMinutes: 60 }, pack: full });
    r2.k.saleRelief = () => ({ fixesLoad: () => true, fixesStacks: () => true, summary: {} });
    assert.equal(r2.k.autobalanceTrigger(), null, 'overfarm off: no hold, the pack goes to town as before');
    const before = r2.k.checkIfShouldSell();
    r2.k.policy.overfarm = { enabled: true };
    assert.deepEqual(r2.k.autobalanceTrigger(), { hold: true, autobalance: true });
    const held = r2.k.checkIfShouldSell();
    assert.ok(before.sell && ['load', 'stacks'].includes(before.trigger), JSON.stringify(before));
    assert.equal(held.sell, false, 'held while the reagents last');
  });

  await test('the courier gate is applied where the keeper courier decides what to buy (prepareFarmDelivery)', () => {
    writeOrders({ couriers: { Scooter: { pause_after: 2 } } });
    const { k } = rig({ policy: { farmDelivery: { enabled: true } } });
    k.mode = 'farm'; k.coordination = { delivery: { trips: 0, farmers_polled: 0, requested: {} } };
    k.deliveryNeighbourhood = () => new Map([[27, 0]]);
    assert.equal(k.autobalanceCouriers(), true);
    const b = k.courierBalance();
    AB.recordDelivery(b.state, { recipient: 'Robin', item: 'herb', why: 'receiver_full' });
    AB.recordDelivery(b.state, { recipient: 'Robin', item: 'herb', why: 'receiver_full' });
    k.courierBalanceSave(b);
    skills.interest.declare('t8', { needs: new Map([['herb', 10], ['elderberry', 4]]), room: 27, character: 'Robin', farming: true, pack: 0.97 });
    const p = k.prepareFarmDelivery(27);
    assert.equal(p.requested.herb, undefined, 'paused herb is not bought');
    assert.equal(p.requested.elderberry, 4, 'the other line is untouched');
    skills.interest.forget('t8');
  });

  await test('the CLI lists loops, learned state and the last lap', () => {
    writeOrders({ loops: { Scooter: { driver: 'keeper', mode: 'practice', practice: ['haste'], trigger: 'first', bogus: 1 } } });
    const st = CLI.statusRows('test');
    const row = st.rows.find(r => r.character === 'Scooter');
    assert.equal(row.trigger, 'first');
    assert.equal(row.learned.laps_seen, 1);
    assert.ok(row.last_lap?.discrepancy);
    assert.ok(row.problems.some(p => /bogus/.test(p)));
    const fa = CLI.farmArgs(AB.normalizeLoop({ mode: 'practice', practice: ['haste'], trigger: 'reagents', drop_priority: ['scimitar'], room: 27 }), 'x');
    assert.deepEqual(fa.overfarm, { enabled: true, overfarm_percent: 400, avoid: ['scimitar'] }, 'trigger reagents reuses overfarm');
    assert.equal(fa.practice_spells.spells[0].name, 'haste');
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
