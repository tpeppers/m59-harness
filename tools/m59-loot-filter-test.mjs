#!/usr/bin/env node
// PER-CREATURE LOOT FILTER — offline, no socket, no roster.
//
//   node tools/m59-loot-filter-test.mjs
//
// Operator, 2026-10-02: Kermit (t1) kills spiders in Faronath (537) as well as living trees,
// "but not bother with their loot except purple mushrooms". lootOnly: {spider: ['purple
// mushroom']}. What this pins:
//   * the shape is validated and a malformed one is REFUSED with a reason, never switched off;
//   * item names compare whole ("purple mushroom" is not "mushroom"), creatures like `hunt`;
//   * through the REAL Session.lootFloor, against a fake client: after a spider kill only the
//     purple mushroom is picked up; after a tree kill the wand and berries are, and the spider
//     junk left earlier is not walked over and taken by the tree's ordinary loot;
//   * attribution by novelty: an item already on the floor when the spider fight began loots
//     as before;
//   * silence is the old behaviour: no policy, everything is taken;
//   * the fight() hook hands lootFloor the kill and the floor snapshot.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'm59-loot-filter-test-'));
process.env.M59_LEDGER_DIR = join(dir, 'ledger');
const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};

let lf = null, Session = null, OF = null, spawns = null, items = null;
try {
  lf = await import('./m59-loot-filter.mjs');
  ({ Session } = await import('./m59-game.mjs'));
  ({ OF } = await import('./m59-parse.mjs'));
  spawns = await import('./m59-spawns.mjs');
  items = await import('./m59-items.mjs');
} catch (e) {
  ok('the loot filter module loads', false, e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const SPAWNS = spawns.loadSpawns(join(HERE, '..', 'substrate', 'm59-spawns.json'));
const matcherFor = k => spawns.huntMatcher(SPAWNS, k);
const KERMIT = { spider: ['purple mushroom'] };

// ------------------------------------------------------------------ the shape
console.log('the shape');
{
  ok('null and {} are inert', lf.lootOnlySpec(null) === null && lf.lootOnlySpec({}) === null);
  ok('Kermit\'s order normalises unchanged',
     JSON.stringify(lf.lootOnlySpec(KERMIT)) === JSON.stringify(KERMIT));
  const refuses = v => { try { lf.lootOnlySpec(v); return false; } catch (e) { return e.message; } };
  ok('a list is refused, with a reason', /object of creature name/.test(refuses(['purple mushroom'])));
  ok('a bare string is refused', !!refuses('spider'));
  ok('a creature with a string instead of a list is refused', /non-empty LIST/.test(refuses({ spider: 'purple mushroom' })));
  ok('an empty list is refused (it would mean "take nothing" by typo)', !!refuses({ spider: [] }));
  ok('a non-string item is refused', !!refuses({ spider: [3] }));
  ok('a duplicate creature is refused', !!refuses({ spider: ['emerald'], ' Spider ': ['emerald'] }));
  ok('an unknown item is refused through the item table, with a suggestion',
     /does not resolve/.test((() => {
       try { lf.lootOnlySpec({ spider: ['purpel mushroom'] }, { resolveItem: items.resolveItemName }); return ''; }
       catch (e) { return e.message; } })()));
  ok('a real item resolves to its canonical spelling',
     lf.lootOnlySpec({ spider: ['Purple Mushrooms'] }, { resolveItem: items.resolveItemName }).spider[0] === 'purple mushroom');
}

// ------------------------------------------------------------------ matching
console.log('matching');
{
  ok('purple mushroom is allowed', lf.itemAllowed('purple mushroom', ['purple mushroom']));
  ok('mushroom is NOT purple mushroom', !lf.itemAllowed('mushroom', ['purple mushroom']));
  ok('purple mushroom is NOT mushroom', !lf.itemAllowed('purple mushroom', ['mushroom']));
  ok('the rule names the spider', lf.lootOnlyRule(KERMIT, 'spider', { matcherFor })?.creature === 'spider');
  ok('...not the black spider (matched like hunt)', lf.lootOnlyRule(KERMIT, 'black spider', { matcherFor }) === null);
  ok('...and not the living tree', lf.lootOnlyRule(KERMIT, 'living tree', { matcherFor }) === null);
}

// ------------------------------------------------------------------ through Session.lootFloor
function world(floor) {
  let evSeq = 0;
  const events = [];
  const names = new Map();
  const objects = new Map();
  let rsc = 1000;
  for (const f of floor) {
    const nameRsc = ++rsc;
    names.set(nameRsc, f.name);
    objects.set(f.id, { id: f.id, nameRsc, col: 10, row: 10, flags: OF.GETTABLE, amount: 1 });
  }
  const gets = [];
  const c = {
    selfId: 1, self: { col: 10, row: 11 }, room: { objects }, inventory: [],
    rsc: { get: id => names.get(id) ?? '' },
    get evSeq() { return evSeq; },
    roomContents() {}, requestInventory() {},
    equipment() { return { known: true, equipped: [] }; },
    async waitFor({ since = 0, kinds = [] } = {}) {
      return { events: events.filter(e => e.seq > since && kinds.includes(e.kind)) };
    },
    get(id) {
      gets.push(names.get(objects.get(id)?.nameRsc));
      objects.delete(id);
      events.push({ seq: ++evSeq, kind: 'got', id });
    },
  };
  const s = new Session('t1');
  s.client = c;
  s.need = () => c;
  s.pacer = { submit: async (_k, fn) => fn() };
  s.world = { room: { num: 537, name: 'Faronath' } };
  const drop = (id, name) => {
    const nameRsc = ++rsc; names.set(nameRsc, name);
    objects.set(id, { id, nameRsc, col: 10, row: 10, flags: OF.GETTABLE, amount: 1 });
  };
  return { s, c, gets, drop, snapshot: () => lf.floorSnapshot(objects.values(), o => o.flags & OF.GETTABLE) };
}

console.log('through Session.lootFloor');
{
  // Spider kill on a clean floor.
  const w = world([]);
  w.s.setLootOnly(KERMIT, { matcherFor });
  const before = w.snapshot();
  w.drop(21, 'purple mushroom'); w.drop(22, 'spider eye'); w.drop(23, 'emerald'); w.drop(24, 'mushroom');
  const r = await w.s.lootFloor({ kill: { name: 'spider', before } });
  ok('after a spider kill ONLY the purple mushroom is picked up',
     w.gets.length === 1 && w.gets[0] === 'purple mushroom', JSON.stringify(w.gets));
  ok('the rest is refused with a LOOT_ONLY reason',
     (r.refused ?? []).filter(x => /LOOT_ONLY/.test(x.why)).length === 3, JSON.stringify(r.refused));
  ok('"mushroom" was left (whole-name match)', !w.gets.includes('mushroom'));

  // Then a tree dies beside the junk.
  const before2 = w.snapshot();
  w.drop(31, 'wand'); w.drop(32, 'entroot berry'); w.drop(33, 'entroot berry');
  const r2 = await w.s.lootFloor({ kill: { name: 'living tree', before: before2 } });
  ok('after a tree kill the wand and both berries are picked up',
     ['wand', 'entroot berry', 'entroot berry'].every(n => w.gets.includes(n)) && w.gets.length === 4,
     JSON.stringify(w.gets));
  ok('...and the spider junk left earlier is NOT taken by the tree\'s ordinary loot',
     !w.gets.includes('spider eye') && !w.gets.includes('emerald'), JSON.stringify(r2.refused));

  // A clean-up sweep / the loot tool (no kill) also respects what was left.
  const r3 = await w.s.lootFloor({});
  ok('a later sweep with no kill does not take the remembered junk either',
     w.gets.length === 4 && (r3.refused ?? []).some(x => /left earlier after a spider kill/.test(x.why)));
  // But an explicit id request is the caller overriding us on purpose.
  await w.s.lootFloor({ ids: [22], maxItems: 1 });
  ok('an explicit id request is never second-guessed', w.gets.includes('spider eye'));
}
{
  // Attribution: a tree drop already on the floor when the spider fight began.
  const w = world([{ id: 11, name: 'entroot berry' }]);
  w.s.setLootOnly(KERMIT, { matcherFor });
  const before = w.snapshot();
  w.drop(21, 'purple mushroom'); w.drop(22, 'spider eye');
  await w.s.lootFloor({ kill: { name: 'spider', before } });
  ok('an item that predates the spider fight loots as before (attribution by novelty)',
     w.gets.includes('entroot berry') && w.gets.includes('purple mushroom') && !w.gets.includes('spider eye'),
     JSON.stringify(w.gets));
}
{
  // No snapshot: falls back to "the last kill was a spider" over the whole floor.
  const w = world([{ id: 11, name: 'entroot berry' }]);
  w.s.setLootOnly(KERMIT, { matcherFor });
  w.drop(21, 'purple mushroom');
  await w.s.lootFloor({ kill: { name: 'spider' } });
  ok('with no floor snapshot the whole floor is filtered (the documented fallback)',
     w.gets.length === 1 && w.gets[0] === 'purple mushroom', JSON.stringify(w.gets));
}
{
  // Silence is the old behaviour.
  const w = world([]);
  w.s.setLootOnly(null);
  const before = w.snapshot();
  w.drop(21, 'purple mushroom'); w.drop(22, 'spider eye'); w.drop(23, 'emerald');
  await w.s.lootFloor({ kill: { name: 'spider', before } });
  ok('with no loot_only policy a spider kill loots everything, as before', w.gets.length === 3);
}
{
  // Memory expiry and room scoping.
  const mem = lf.newLootOnlyMemory();
  const spec = lf.lootOnlySpec(KERMIT);
  lf.planLootOnly({ spec, kill: { name: 'spider', before: [] }, floor: [{ id: 5, name: 'emerald' }],
                    memory: mem, room: 537, now: 0, matcherFor });
  const later = lf.planLootOnly({ spec, floor: [{ id: 5, name: 'emerald' }], memory: mem, room: 537,
                                  now: lf.LOOT_ONLY_MEMORY_MS + 1, matcherFor });
  ok('what was left is forgotten after ten minutes', later.leave.length === 0);
  lf.planLootOnly({ spec, kill: { name: 'spider', before: [] }, floor: [{ id: 5, name: 'emerald' }],
                    memory: mem, room: 537, now: 0, matcherFor });
  const recycled = lf.planLootOnly({ spec, floor: [{ id: 5, name: 'wand' }], memory: mem, room: 537, now: 1, matcherFor });
  ok('a recycled id naming a different item is not on the list', recycled.leave.length === 0);
  const moved = lf.planLootOnly({ spec, floor: [{ id: 5, name: 'emerald' }], memory: mem, room: 536, now: 2, matcherFor });
  ok('a different room clears the memory', moved.leave.length === 0);
  ok('status reports the rules and the counts',
     lf.lootOnlyStatus(spec, mem)?.rules?.spider?.[0] === 'purple mushroom' && lf.lootOnlyStatus(null) === null);
}

// ------------------------------------------------------------------ the hooks
console.log('the hooks');
{
  const skillsSrc = readFileSync(join(HERE, 'm59-skills.mjs'), 'utf8');
  ok('fight() snapshots the floor when it chooses its foe',
     /const floorBefore = floorSnapshot\(c\.room\?\.objects\?\.values\?\.\(\), o => o\.flags & OF\.GETTABLE\)/.test(skillsSrc));
  ok('...and hands the kill to lootFloor',
     /s\.lootFloor\(\{ stayPut: holdPosition, kill: \{ name: foeName, before: floorBefore \} \}\)/.test(skillsSrc));
  const apSrc = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  ok('the autopilot installs the policy on the session every pass',
     /s\.setLootOnly\?\.\(this\.policy\.lootOnly \?\? null, \{ matcherFor: k => this\.huntMatch\(k\) \}\)/.test(apSrc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
