#!/usr/bin/env node
// HUNT PRIORITY — offline, no socket, no roster.
//
//   node tools/m59-hunt-priority-test.mjs
//
// Operator, 2026-10-02: Kermit (t1) farms living trees in Faronath (537) and "should probably
// actually prioritize spiders when farming ... since all the Qor casters can't/won't kill them
// because of the karma effect". huntPriority: ['spider', 'living tree'] over hunt: ['spider',
// 'living tree']. What this pins:
//   * a spider is chosen over a NEARER tree;
//   * with no engageable spider (none present, or every spider removed by the keeper's own
//     filters — avoid, confinement, cooling) the tree is chosen;
//   * the safety gates still apply: the ordering only reorders the list those filters built,
//     never adds to it, the wounded foe stays first, and in the farm pass the hook sits after
//     every filter and before every engage gate;
//   * a priority name outside `hunt` is reported, never acted on;
//   * a malformed order is refused with a reason, never coerced to "off";
//   * BOTH new policy keys (huntPriority, lootOnly) are keys of the default policy object,
//     round-trip through the keeper's POST /policy merge (JSON on the wire), and the broker
//     declares, validates and sets them.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'm59-hunt-priority-test-'));
process.env.M59_LEDGER_DIR = join(dir, 'ledger');
process.env.M59_PVP_HOLD_DIR = join(dir, 'holds');
const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};

let hp = null, Autopilot = null, spawns = null, lf = null;
try {
  hp = await import('./m59-hunt-priority.mjs');
  lf = await import('./m59-loot-filter.mjs');
  ({ Autopilot } = await import('./m59-autopilot.mjs'));
  spawns = await import('./m59-spawns.mjs');
} catch (e) {
  ok('the hunt priority module loads', false, e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const SPAWNS = spawns.loadSpawns(join(HERE, '..', 'substrate', 'm59-spawns.json'));
const matcherFor = w => spawns.huntMatcher(SPAWNS, w);
const HUNT = ['spider', 'living tree'];
const ORDER = ['spider', 'living tree'];
const nameOf = o => o.name;
// Candidates as the keeper hands them over: already filtered, already ranked nearest-first.
const tree = { id: 101, name: 'living tree', d: 2 };
const tree2 = { id: 102, name: 'living tree', d: 4 };
const spider = { id: 201, name: 'spider', d: 9 };
const black = { id: 301, name: 'black spider', d: 1 };

// ------------------------------------------------------------------ the order
console.log('the order');
{
  const found = [tree, tree2, spider];
  const out = hp.orderByHuntPriority(found, ORDER, { nameOf, matcherFor });
  ok('a spider is chosen over a NEARER tree', out[0] === spider, out.map(o => o.name).join(','));
  ok('the trees keep their nearest-first order behind it', out[1] === tree && out[2] === tree2);
  ok('the input list is not mutated', found[0] === tree);

  const none = hp.orderByHuntPriority([tree, tree2], ORDER, { nameOf, matcherFor });
  ok('no spider present: the nearest tree, as before', none[0] === tree);

  // The keeper's filters (proved-unreachable avoid set, confinement, pull cooling, the island
  // bridge) run BEFORE the ordering, so an unengageable spider never reaches it.
  const avoid = o => o.id === spider.id;
  const engageable = [tree, tree2, spider].filter(o => !avoid(o));
  ok('every spider filtered out as unengageable: falls back to the tree',
     hp.orderByHuntPriority(engageable, ORDER, { nameOf, matcherFor })[0] === tree);

  const two = hp.orderByHuntPriority([tree, spider, { id: 202, name: 'spider', d: 12 }], ORDER, { nameOf, matcherFor });
  ok('among several spiders the keeper\'s own ranking still decides', two[0] === spider && two[1].id === 202);

  ok('null and [] leave the list exactly as ranked',
     hp.orderByHuntPriority([tree, spider], null, { nameOf, matcherFor })[0] === tree &&
     hp.orderByHuntPriority([tree, spider], [], { nameOf, matcherFor })[0] === tree);
}

// ------------------------------------------------------------------ the safety gates
console.log('the safety gates');
{
  const found = [tree, spider];
  const out = hp.orderByHuntPriority(found, ['black spider', ...ORDER], { nameOf, matcherFor });
  ok('the ordering never ADDS a creature: a black spider not in the list is never chosen',
     out.length === 2 && !out.includes(black));
  ok('"spider" does not match the black spider (matched like hunt)',
     hp.orderByHuntPriority([black, tree], ORDER, { nameOf, matcherFor })[0] === tree);
  const wounded = hp.orderByHuntPriority([tree, spider], ORDER, { nameOf, matcherFor, preferId: tree.id });
  ok('the wounded / pulled foe stays first (a kill pays only its damager)', wounded[0] === tree);

  // Where the hook sits in the farm pass: after every filter that decides engageability,
  // before the claim, and before every engage gate. If somebody moves it above a filter, a
  // priority could pick a creature the keeper had already ruled out.
  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  const at = s => src.indexOf(s);
  const hook = at('if (this.policy.huntPriority) found = this.huntPriorityOrder(found, preferId);');
  ok('the farm pass calls the hook', hook > 0);
  ok('...after the confinement filter', hook > at('found = found.filter(target => quarryPermittedByConfinement({'));
  ok('...after the proved-unreachable avoid filter', hook > at('const avoidPrey = this.preyAvoid(room?.num ?? null);'));
  ok('...after the pull-cooling filter', hook > at('const cooling = this.pullTargetCooling(room?.num, o.id);'));
  ok('...after rankQuarries, and before the claim on found[0]',
     hook > at('found = rankQuarries(this.s.name, room?.num, found, { preferId });') &&
     hook < src.indexOf('claimQuarry(this.s.name, room?.num, found[0]?.id);', hook));
  ok('...and before the engage-health, vigor and wall gates',
     hook < at('if (hp !== null && hp < safe.engageAt) {') &&
     hook < at('const vigorFloor = this.fightFloor();') &&
     hook < at('const worth = this.holdWorthwhile('));
}

// ------------------------------------------------------------------ validation and problems
console.log('validation');
{
  const refuses = v => { try { hp.huntPrioritySpec(v); return false; } catch (e) { return e.message; } };
  ok('null and [] are off', hp.huntPrioritySpec(null) === null && hp.huntPrioritySpec([]) === null);
  ok('an order normalises, de-duplicated by identity',
     JSON.stringify(hp.huntPrioritySpec([' spider ', 'Living Tree', 'SPIDER'])) === '["spider","Living Tree"]');
  ok('a single string is refused, with a reason', /ordered LIST/.test(refuses('spider')));
  ok('an object is refused', !!refuses({ spider: 1 }));
  ok('a non-string entry is refused', !!refuses(['spider', 7]));
  ok('an empty name is refused', !!refuses(['spider', '  ']));
  const probs = hp.huntPriorityProblems(['spider', 'queen spider', 'living tree'], HUNT, { matcherFor });
  ok('a priority name outside hunt is reported', probs.length === 1 && probs[0].name === 'queen spider',
     JSON.stringify(probs));
  ok('no hunt at all: every entry is reported', hp.huntPriorityProblems(ORDER, null).length === 2);
}

// ------------------------------------------------------------------ the keeper
console.log('the keeper');
{
  const names = new Map([[1, 'living tree'], [2, 'spider'], [3, 'black spider']]);
  const client = { rsc: { get: id => names.get(id) ?? '' } };
  const ap = new Autopilot({ name: 't1', client, world: { room: { num: 537 } } },
    { mode: 'farm', policy: { hunt: HUNT, huntPriority: ORDER } });
  const t = { id: 11, nameRsc: 1 }, sp = { id: 12, nameRsc: 2 };
  const out = ap.huntPriorityOrder([t, sp], null);
  ok('Autopilot.huntPriorityOrder puts the spider first through the keeper\'s own matcher', out[0] === sp);
  const st = ap.status();
  ok('autopilot status reports hunt_priority with the last choice',
     st.hunt_priority?.order?.[0] === 'spider' && st.hunt_priority?.last_choice?.target === 'spider' &&
     st.hunt_priority?.last_choice?.rank === 0, JSON.stringify(st.hunt_priority));
  ap.policy.huntPriority = ['queen spider', 'spider'];
  ok('status names a priority entry hunt never produces',
     ap.status().hunt_priority?.ignored?.[0]?.name === 'queen spider');
  ap.policy.huntPriority = null;
  ok('unset: hunt_priority is null in status', ap.status().hunt_priority === null);
  ok('loot_only is null in status when unset', ap.status().loot_only === null);
  ap.policy.lootOnly = { spider: ['purple mushroom'] };
  ok('loot_only is reported in status when set', ap.status().loot_only?.rules?.spider?.[0] === 'purple mushroom');
}

// ------------------------------------------------------------------ the policy surfaces (both keys)
console.log('the policy surfaces');
{
  const fresh = new Autopilot({ name: 'x', client: null, world: { room: null } }, { mode: 'farm' });
  ok('huntPriority is a key of the default policy object (so a push is reflected)',
     Object.hasOwn(fresh.policy, 'huntPriority') && fresh.policy.huntPriority === null);
  ok('lootOnly is a key of the default policy object (so a push is reflected)',
     Object.hasOwn(fresh.policy, 'lootOnly') && fresh.policy.lootOnly === null);
  // The broker pushes JSON; the keeper's POST /policy is Object.assign(autopilot.policy, fields).
  const body = JSON.parse(JSON.stringify({ agent: 't1', mode: 'farm', by: 'test',
    huntPriority: hp.huntPrioritySpec(ORDER), lootOnly: lf.lootOnlySpec({ spider: ['purple mushroom'] }) }));
  const { agent: _a, character: _c, keeper_pid: _k, mode: _m, by: _b, ...fields } = body;
  Object.assign(fresh.policy, fields);
  ok('a pushed huntPriority round-trips', JSON.stringify(fresh.policy.huntPriority) === JSON.stringify(ORDER));
  ok('a pushed lootOnly round-trips', fresh.policy.lootOnly?.spider?.[0] === 'purple mushroom');
  Object.assign(fresh.policy, JSON.parse(JSON.stringify({ huntPriority: null, lootOnly: null })));
  ok('and null switches both off again', fresh.policy.huntPriority === null && fresh.policy.lootOnly === null);

  const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  ok('the keeper merges pushed fields into autopilot.policy', /Object\.assign\(autopilot\.policy, fields\)/.test(keeper));

  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  ok('the autopilot schema declares hunt_priority', /hunt_priority: \{ type: \['array', 'null'\]/.test(broker));
  ok('the autopilot schema declares loot_only', /loot_only: \{ type: \['object', 'null'\]/.test(broker));
  ok('the setter validates and writes p.policy.huntPriority',
     /p\.policy\.huntPriority = huntPrioritySpec\(a\.hunt_priority\)/.test(broker));
  ok('the setter validates (against the item table) and writes p.policy.lootOnly',
     /p\.policy\.lootOnly = lootOnlySpec\(a\.loot_only, \{ resolveItem: n => resolveItemName\(n\) \}\)/.test(broker));
  ok('a refused shape returns started:false with the reason',
     /huntPrioritySpec\(a\.hunt_priority\); \}\s*catch \(e\) \{ return \{ started: false, reason: e\.message \}; \}/.test(broker) &&
     /resolveItemName\(n\) \}\); \}\s*catch \(e\) \{ return \{ started: false, reason: e\.message \}; \}/.test(broker));
  const { reflectPolicy } = await import('./m59-policy-controls.mjs');
  const fakeTool = { schema: { properties: { hunt_priority: { type: ['array', 'null'] }, loot_only: { type: ['object', 'null'] } } },
                     run: () => 'p.policy.huntPriority = x; p.policy.lootOnly = y' };
  const specs = reflectPolicy(fakeTool, [fresh.policy]);
  ok('policy_control reflects both onto their policy keys',
     specs.find(s => s.id === 'hunt_priority')?.policy === 'huntPriority' &&
     specs.find(s => s.id === 'loot_only')?.policy === 'lootOnly');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
