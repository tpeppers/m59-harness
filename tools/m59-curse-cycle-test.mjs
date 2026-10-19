// OFFLINE. The curse cycle (m59-curse-cycle.mjs): a curse-breaker may pick up unidentified rings,
// and a ring that curses it is uncursed and dropped. Pins the gate (never the last emeralds, never
// without the spell or the karma), the one-ring-per-sweep rule, the refusal of amulets, that the
// default -- no strategy answering -- picks up nothing, and the keeper's stage against a stub body.
//
// `node tools/m59-curse-cycle-test.mjs`
import { readFileSync } from 'node:fs';
import { normalizeCurseCycle, curseCycleGate, uncurseAffordable, cycleMayLoot, restrictPlan,
         CURSE_CYCLE_DEFAULTS } from './m59-curse-cycle.mjs';
const { Autopilot, HANDLED, CONTINUE } = await import('./m59-autopilot.mjs');

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = s => console.log(`\n${s}`);

section('reading the answer');
{
  eq(normalizeCurseCycle(null).cfg, null, 'no answer is "not this character"');
  eq(normalizeCurseCycle({}).cfg, null, 'an answer with nothing to do is the same');
  const { cfg, problems } = normalizeCurseCycle({ pickup: ['Magical Ring', 'amulet', 'magical ring'] });
  eq(cfg.pickup, ['magical ring'], 'names are lower-cased, de-duplicated, and an amulet is dropped');
  ok(problems.length === 1 && /amulet/.test(problems[0]), 'and the dropped amulet is named, not swallowed');
  eq([cfg.reserve, cfg.karma_min, cfg.mana_min, cfg.hall_min],
     [CURSE_CYCLE_DEFAULTS.reserve, 20, 9, 1], 'silence takes the defaults');
  const low = normalizeCurseCycle({ pickup: ['magical ring'], karma_min: 5, mana_min: 1, reserve: -3 }).cfg;
  eq([low.karma_min, low.mana_min, low.reserve], [20, 9, 0],
     'karma and mana cannot be set below what remove curse needs, and a reserve cannot go negative');
  const keepOnly = normalizeCurseCycle({ keep: ['magical ring'], hall: ['magical ring'] }).cfg;
  ok(keepOnly && keepOnly.pickup.length === 0, 'a keep-and-carry answer is valid without any pickup');
}

const cfg = normalizeCurseCycle({ pickup: ['magical ring'], reserve: 3 }).cfg;
const able = { knowsSpell: true, karma: 40, mana: 20, emeralds: 5, floor: 0, cursedWorn: 0 };

section('the gate');
{
  ok(curseCycleGate(cfg, able).open, 'a caster with the spell, the karma, mana and a spare emerald may cycle');
  eq(curseCycleGate(cfg, able).spare, 2, 'spare is what is held over the reserve');
  ok(!curseCycleGate(cfg, { ...able, knowsSpell: false }).open, 'shut without remove curse');
  ok(!curseCycleGate(cfg, { ...able, karma: 19 }).open, 'shut below +20 karma (level 2 x 10)');
  ok(!curseCycleGate(cfg, { ...able, karma: null }).open, 'shut when karma is unknown');
  ok(!curseCycleGate(cfg, { ...able, emeralds: 3 }).open, 'shut when every emerald is the reserve');
  ok(curseCycleGate(cfg, { ...able, emeralds: 4 }).open, 'open with exactly one over the reserve');
  ok(!curseCycleGate(cfg, { ...able, emeralds: 5, floor: 5 }).open,
     'the loadout floor raises the reserve when it is larger');
  ok(!curseCycleGate(cfg, { ...able, mana: 8 }).open, 'shut below 9 mana');
  ok(curseCycleGate(cfg, { ...able, cursedWorn: 1 }).open,
     'a cursed item worn on purpose does not shut it: the curse is on the wearer and goes back on');
  ok(!curseCycleGate(normalizeCurseCycle({ keep: ['magical ring'] }).cfg, able).open,
     'a keep-only answer never opens the pickup');
  ok(uncurseAffordable(cfg, able).ok, 'the uncurse is payable on the same body');
  ok(!uncurseAffordable(cfg, { ...able, emeralds: 3 }).ok, 'and the reserve still holds for it');
}

section('one ring per sweep');
{
  const gate = { open: true, pickup: ['magical ring'] };
  const taken = new Set();
  ok(cycleMayLoot('magical ring', gate, taken), 'the first unidentified ring is taken');
  ok(!cycleMayLoot('magical ring', gate, taken), 'the second in the same sweep is not');
  ok(!cycleMayLoot('magical ring', null, new Set()), 'no gate takes nothing (the default)');
  ok(!cycleMayLoot('magical ring', { open: false, pickup: ['magical ring'] }, new Set()), 'a shut gate takes nothing');
  ok(!cycleMayLoot('amulet', { open: true, pickup: ['amulet'] }, new Set()), 'an amulet is refused even if listed');
  ok(!cycleMayLoot('magical amulet', gate, new Set()), 'a name not listed is not taken');
}

section('the hall plan, narrowed');
{
  const plan = { chests: new Map([['r18c2', [{ item: 'magical ring', target: 200 }, { item: 'orc tooth', target: 238 }]],
                                  ['r18c6', [{ item: 'lightning wand', target: 20, also: ['wand'] }]]]) };
  const r = restrictPlan(plan, ['magical ring']);
  eq(r.chests.get('r18c2').map(e => e.item), ['magical ring'], 'only the cycle names stay');
  eq(r.chests.get('r18c6'), [], 'other chests keep no lines');
  eq(plan.chests.get('r18c2').length, 2, 'the cached plan is not mutated');
}

section('the wiring');
{
  const game = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  const ap = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const lf = game.slice(game.indexOf('const takenCursed = new Set();'), game.indexOf('const emptyWandsSkipped'));
  ok(lf.indexOf('CURSED_ITEMS.test(n)') >= 0 && lf.indexOf('CURSED_ITEMS.test(n)') < lf.indexOf('cycleMayLoot('),
     'the name ban runs first, so a revealed ring of lethargy on the floor is never cycled');
  ok(/UNREVEALED_JEWELLERY\.test\(n\) && skills\.isUnrevealed\(o\)\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(cycleMayLoot\(n, this\._curseCycle, takenCycle\)\)/.test(lf),
     'the exception lives inside the unidentified-jewellery refusal and nowhere else');
  ok(/setCursedPickup\?\.\(this\.policy\.pickupCursed \?\? \[\]\);\s*await this\.applyCurseCycle\(\);/.test(ap),
     'the gate is installed every pass, beside the cursed pickup list');
  ok(/const hallOnly = cfg\?\.enabled \? null : this\.curseCycleHall\(\);/.test(ap) &&
     /if \(hallOnly\) plan = restrictPlan\(plan, hallOnly\);/.test(ap),
     'the hall run with guild_wants off is narrowed to the cycle names');
}

// ------------------------------------------------------------------ the stage, against a stub body
function body({ worn = [], pack = [], emeralds = 5, karma = 40, mana = 20, landing = 0, castWorks = true } = {}) {
  const names = new Map();
  let nextId = 100;
  const mk = (name, extra = {}) => { const id = nextId++; names.set(id, name); return { id, nameRsc: id, amount: 1, ...extra }; };
  const inventory = [...worn.map(w => mk(w.name, w)), ...pack.map(p => mk(p.name, p)),
                     mk('emerald', { amount: emeralds })];
  let equipped = inventory.slice(0, worn.length).map(o => ({ id: o.id }));
  const calls = { casts: 0, drops: [], uses: [] };
  const c = {
    inventory, spells: [{ id: 1, nameRsc: 'rc' }],
    rsc: { get: k => (k === 'rc' ? 'remove curse' : names.get(k)) },
    stat: k => (k === 'karma' ? karma : null),
    vitals: () => ({ mana: { value: mana } }),
    equipment: () => ({ known: true, equipped }),
    requestInventory: async () => {}, waitFor: async () => ({ events: [] }),
    use: id => { calls.uses.push(id); equipped = [...equipped, { id }]; },
    drop: async specs => { for (const sp of specs) {
      const id = sp?.id ?? sp; calls.drops.push(names.get(id));
      const i = c.inventory.findIndex(o => o.id === id); if (i >= 0) c.inventory.splice(i, 1); } },
  };
  const s = { client: c, pacer: { submit: async (_k, fn) => fn() }, world: { room: { num: 599 } } };
  const ap = Object.create(Autopilot.prototype);
  Object.assign(ap, { s, policy: {}, tally: {}, notes: [], ledger: [] });
  ap.note = (what, d) => ap.notes.push({ what, d });
  ap.ledgerEvent = (k, d) => ap.ledger.push({ k, d });
  ap.progress = () => {};
  ap.threat = () => ({ landing });
  ap.loadout = () => null;
  ap.castSelfSpell = async () => { calls.casts++; if (castWorks) equipped = []; return { landed: castWorks }; };
  ap._curseCycleCfg = cfg;
  return { ap, c, calls };
}

section('the stage');
{
  const { ap, calls } = body({ worn: [{ name: 'ring of lethargy', rarity: 200 }], pack: [{ name: 'magical ring', rarity: 100 }] });
  const v = await ap.passCurseCycle({});
  ok(v === HANDLED, 'a cursed ring worn is handled');
  eq(calls.casts, 1, 'remove curse is cast once');
  eq(calls.drops, ['ring of lethargy'], 'the cursed ring is dropped, and only it');
  ok(ap.s.client.inventory.some(o => ap.s.client.rsc.get(o.nameRsc) === 'magical ring'), 'the uncursed ring is kept');
  ok(ap.ledger.some(r => r.k === 'curse_cycle'), 'and the ledger has the row');
}
{
  const { ap, calls } = body({ worn: [{ name: 'ring of lethargy', rarity: 200 }], emeralds: 3 });
  eq(await ap.passCurseCycle({}), CONTINUE, 'with only the reserve left, nothing is spent');
  eq(calls.casts + calls.drops.length, 0, 'no cast and no drop');
}
{
  const { ap, calls } = body({ worn: [{ name: 'amulet of shadows', rarity: 200 }, { name: 'ring of lethargy', rarity: 200 }] });
  eq(await ap.passCurseCycle({}), HANDLED, 'a ring cursed beside a worn amulet is still handled');
  eq(calls.drops, ['ring of lethargy'], 'only the ring is dropped');
  eq(calls.uses, [ap.s.client.inventory.find(o => ap.s.client.rsc.get(o.nameRsc) === 'amulet of shadows').id],
     'and the amulet the cast took off is put back on');
}
{
  const { ap, calls } = body({ worn: [{ name: 'amulet of shadows', rarity: 200 }] });
  eq(await ap.passCurseCycle({}), CONTINUE, 'a cursed amulet is not this cycle\'s (a trainee may wear one on purpose)');
  eq(calls.casts + calls.drops.length, 0, 'and it is neither uncursed nor dropped');
}
{
  const { ap, calls } = body({ worn: [{ name: 'ring of lethargy', rarity: 200 }], landing: 2 });
  eq(await ap.passCurseCycle({}), CONTINUE, 'not while something is hitting us');
  eq(calls.casts, 0, 'no cast mid-fight');
}
{
  const { ap, calls } = body({ worn: [{ name: 'ring of lethargy', rarity: 200 }], castWorks: false });
  await ap.passCurseCycle({});
  eq(calls.drops, [], 'a worn ring is never dropped while it is still worn (the drop would torture the owner)');
}
{
  const { ap, calls } = body({ pack: [{ name: 'ring of lethargy', rarity: 200 }] });
  eq(await ap.passCurseCycle({}), HANDLED, 'a loose cursed ring needs no cast');
  eq([calls.casts, calls.drops], [0, ['ring of lethargy']], 'it is only dropped');
}
{
  const { ap, calls } = body({ worn: [{ name: 'ring of lethargy', rarity: 200 }] });
  ap._curseCycleCfg = null;
  eq(await ap.passCurseCycle({}), CONTINUE, 'with no strategy answering the stage is inert');
  eq(calls.casts, 0, 'and does nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
