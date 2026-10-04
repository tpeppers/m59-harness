#!/usr/bin/env node
// Offline tests for m59-idgen.mjs — object-id generations across server saves.
//
// Pins: a save between a read and a use marks the read's ids stale in a stamped reply and is
// caught on the way in (re-resolved by name when exactly one thing carries it, refused with a
// sentence otherwise); twenty keepers reporting one save are ONE save; the cadence numbers; and
// the pack-level generation check the supply exchange uses when a save lands mid-walk.
//
//   node tools/m59-idgen-test.mjs
import {
  retireGeneration, closeGeneration, generationOf, idsCurrent, checkIds, refusalText,
  STALE_ID_REASON, SaveClock, collectIds, stampReply, IdRegistry, judgeArgs, reresolveRefs,
  rewriteArgs, ID_GENERATIONS_KEPT,
} from './m59-idgen.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ', m); } else { fail++; console.log('  FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (got ${JSON.stringify(a)})`);

const T0 = Date.parse('2026-10-04T22:00:00Z');
const MIN = 60_000;

console.log('generations');
{
  const pre = [{ id: 9461, name: 'shilling', amount: 1200 }, { id: 9462, name: 'herbs', amount: 40 },
               { id: 9463, name: 'long sword', amount: 0 }];
  let g = retireGeneration([], { began: T0 + 30 * MIN, items: pre, since: T0 });
  g = closeGeneration(g, T0 + 30 * MIN + 5000);
  eq(g.length, 1, 'one save retires one generation');
  eq(g[0].from, T0, 'the first generation opens at the client\'s tracking start');
  ok(generationOf(g, T0 + 10 * MIN) === g[0], 'a read before the save belongs to the retired generation');
  ok(generationOf(g, T0 + 30 * MIN + 2000) === g[0], 'a read DURING the save still belongs to it');
  eq(generationOf(g, T0 + 31 * MIN), 'current', 'a read after the save ended is current');
  eq(generationOf(g, T0 - MIN), 'unknown', 'a read before tracking began is unknown, not guessed');
  eq(generationOf(g, null), 'unknown', 'no time given is unknown');
  let many = [];
  for (let i = 0; i < 5; i++) {
    many = retireGeneration(many, { began: T0 + i * 10 * MIN, items: pre, since: T0 - MIN });
    many = closeGeneration(many, T0 + i * 10 * MIN + 1000);
  }
  eq(many.length, ID_GENERATIONS_KEPT, 'generations kept are bounded');
  eq(generationOf(many, T0 + 5 * MIN), 'unknown', 'a read older than the oldest kept window is unknown');
  ok(idsCurrent({ inventory_at: T0 + 2, last_save_at: T0 + 1 }), 'an inventory read after the save is current');
  ok(!idsCurrent({ inventory_at: T0, last_save_at: T0 + 1 }), 'an inventory read before the save is not');
  ok(!idsCurrent({ inventory_at: T0 + 2, last_save_at: T0 + 1, saving: true }), 'nothing is current mid-save');
  ok(!idsCurrent(null), 'an unknown generation is not current');
}

console.log('checkIds — a save between the read and the use');
{
  const pre = [{ id: 9461, name: 'shilling', amount: 1200 }, { id: 9462, name: 'herbs', amount: 40 },
               { id: 9463, name: 'long sword', amount: 0 }, { id: 9464, name: 'long sword', amount: 0 }];
  let gens = retireGeneration([], { began: T0 + 30 * MIN, items: pre, since: T0 });
  gens = closeGeneration(gens, T0 + 30 * MIN + 4000);
  const post = [{ id: 12345, name: 'shilling', amount: 1250 }, { id: 9461, name: 'sapphire', amount: 3 },
                { id: 12347, name: 'herbs', amount: 40 }, { id: 12348, name: 'long sword', amount: 0 },
                { id: 12349, name: 'long sword', amount: 0 }];
  const asOf = { inventory_at: T0 + 31 * MIN, last_save_at: T0 + 30 * MIN + 4000 };

  // The incident, with the caller saying when it read: the id is translated through its own
  // generation even though the same number now names a sapphire.
  let r = checkIds([{ id: 9461, amount: 600 }], { inventory: post, generations: gens, asOf, callerAsOf: T0 + 20 * MIN });
  ok(r.ok, 'a pre-save shilling id with ids_as_of is accepted');
  eq(r.items.map(i => [i.id, i.amount, i.how]), [[12345, 600, 'reresolved']], '...re-resolved to the new shilling stack, amount kept');
  ok(/predates the 22:30:04Z save/.test(r.reresolved[0].why), 'the re-resolve says which save');

  // Without a time, an id that now names something else is refused, never guessed.
  r = checkIds([9461], { inventory: post, generations: gens, asOf });
  ok(!r.ok, 'a recycled id with no time is refused');
  ok(/named shilling before the 22:30:04Z save and names sapphire now/.test(refusalText(r)), '...with both names in the sentence');

  // An id that is simply gone is re-resolved from the retired generation's name.
  r = checkIds([9462], { inventory: post, generations: gens, asOf });
  eq(r.items.map(i => [i.id, i.amount]), [[12347, 40]], 'a vanished pre-save id is re-resolved by name, the stack it saw');
  // Ambiguous: two long swords now.
  r = checkIds([9463], { inventory: post, generations: gens, asOf });
  ok(!r.ok && /now names 2 items \(ids 12348, 12349\)/.test(refusalText(r)), 'two carriers of the name: refused, naming both');
  ok(STALE_ID_REASON.test(refusalText(r)), 'the refusal is recognisable as a stale-id refusal');
  // A name hint settles the recycled case.
  r = checkIds([{ id: 9461, name: 'shilling', amount: 5 }], { inventory: post, generations: gens, asOf });
  eq(r.items.map(i => i.id), [12345], 'a {id, name} with a recycled id resolves by the name it carries');
  // Unchanged ids pass straight through.
  r = checkIds([{ id: 12345, amount: 10 }], { inventory: post, generations: gens, asOf });
  eq(r.items.map(i => [i.id, i.how]), [[12345, 'current']], 'a current id is current');
  // Two entries landing on one stack would cancel a trade.
  r = checkIds([9462, { id: 12347 }], { inventory: post, generations: gens, asOf });
  ok(!r.ok && /already names/.test(refusalText(r)), 'two entries resolving to one id are refused');
  // An absent id with no history is reported absent, for the caller to decide.
  r = checkIds([77777], { inventory: post, generations: gens, asOf });
  eq(r.absent, [77777], 'an id with no history and no carrier is absent');
  // An old id that now names a monster in the room.
  r = checkIds([9464], { inventory: post.slice(0, 3), generations: gens, asOf, elsewhere: new Set([9464]) });
  ok(!r.ok, 'a pre-save pack id that now names a room object is not passed through');
  // A read older than everything remembered, with no name: refused.
  r = checkIds([9461], { inventory: post, generations: gens, asOf, callerAsOf: T0 - 10 * MIN });
  ok(!r.ok && /older than every save/.test(refusalText(r)), 'an id older than every remembered save is refused');
}

console.log('SaveClock — one save seen by twenty keepers');
{
  const clock = new SaveClock();
  for (let k = 0; k < 20; k++) {
    clock.observe({ phase: 'begin', at: T0 + k * 40 }, `t${k}`);
    clock.observe({ phase: 'end', at: T0 + 3000 + k * 50 }, `t${k}`);
  }
  eq(clock.saves.length, 1, 'twenty keepers, one save');
  eq(clock.latest.began, T0, 'the earliest start is the start');
  eq(clock.latest.ended, T0 + 3000, 'the earliest end is the boundary');
  eq(clock.latest.sources.size, 20, 'every observer is counted');
  ok(clock.isStale(T0 + 2000), 'a read during the save is stale');
  ok(!clock.isStale(T0 + 3001), 'a read after the earliest end is not');
  // Snapshot-shaped reports of the same save (keepers' recent lists) do not add a save.
  clock.observeAll([{ began: T0 + 500, ended: T0 + 3500 }], 'snap');
  eq(clock.saves.length, 1, 'a keeper snapshot of the same save dedupes');
  // An end-only report (a keeper that logged in mid-save) belongs to the same save.
  clock.observe({ ended: T0 + 5000 }, 'late');
  eq(clock.saves.length, 1, 'an end-only report after a known start is the same save');
  // The cadence.
  clock.observeAll([{ began: T0 + 60 * MIN, ended: T0 + 60 * MIN + 3000 },
                    { began: T0 + 120 * MIN, ended: T0 + 120 * MIN + 4000 }], 'later');
  const sum = clock.summary(T0 + 121 * MIN);
  eq(sum.count, 3, 'three saves');
  eq(sum.interval_ms, 60 * MIN, 'the interval is the median gap between starts');
  eq(sum.next_expected_at, T0 + 180 * MIN, 'the next is one interval after the last start');
  eq(sum.last_at, T0 + 120 * MIN + 4000, 'last_at is the last save\'s end');
  eq(sum.held_ms, 4000, 'how long the last one held');
  const late = clock.summary(T0 + 400 * MIN);
  ok(late.next_expected_at > T0 + 300 * MIN, 'a prediction long past rolls forward rather than reading overdue for ever');
  const empty = new SaveClock().summary();
  eq([empty.count, empty.interval_ms, empty.next_expected_at], [0, null, null], 'no saves: nothing predicted');
  // In progress: everything read so far is stale.
  const prog = new SaveClock();
  prog.observe({ phase: 'begin', at: Date.now() - 1000 });
  ok(prog.isStale(Date.now()), 'while a save is running, nothing read is post-save yet');
}

console.log('the reply boundary — stamp, register, judge, re-resolve');
{
  const clock = new SaveClock();
  const registry = new IdRegistry();
  const readAt = T0 + 10 * MIN;
  const reply = { items: [{ id: 9461, name: 'shilling', amount: 1200 }, { id: 9462, name: 'herbs', amount: 40 }],
                  equipped: ['mace'], room: { objects: [{ id: 501, name: 'giant rat' }] } };
  let { ids } = stampReply(reply, { readAt, stale: false, clock });
  eq(ids.length, 3, 'every {id, name} in the reply is found, nested ones included');
  eq([reply.ids_as_of, reply.ids_stale], [readAt, false], 'a reply carrying ids is stamped');
  ok(!('id_stale' in reply.items[0]), 'fresh entries are not marked');
  registry.noteAll('t4', ids, readAt);
  eq(registry.get('t4', 9461).name, 'shilling', 'the registry remembers what it handed out');

  const plain = { ok: true, note: 'nothing here' };
  stampReply(plain, { readAt, stale: false, clock });
  ok(!('ids_as_of' in plain), 'a reply with no ids is left alone');

  // No save yet: nothing is stale, nothing is judged.
  eq(judgeArgs({ agent: 't4', what: [{ id: 9461, amount: 50 }] }, { tool: 'supply', agent: 't4', registry, clock }), [],
     'before any save, an issued id is not judged');

  // The save.
  clock.observe({ began: T0 + 30 * MIN, ended: T0 + 30 * MIN + 4000 });
  const staleReply = { items: [{ id: 9461, name: 'shilling', amount: 1200 }] };
  stampReply(staleReply, { readAt, stale: clock.isStale(readAt), clock });
  eq([staleReply.ids_stale, staleReply.items[0].id_stale], [true, true], 'a reply read before the save is marked stale, per entry too');
  ok(/22:30:04Z server save/.test(staleReply.ids_note), 'and says which save');

  const args = { agent: 't4', from: 'Kermit', what: [{ id: 9461, amount: 50 }, { id: 9462, amount: 2 }], target: '501' };
  const refs = judgeArgs(args, { keys: ['what', 'target'], agent: 't4', registry, clock });
  eq(refs.map(r => [r.path.join('.'), r.id, r.name]),
     [['what.0.id', 9461, 'shilling'], ['what.1.id', 9462, 'herbs'], ['target', 501, 'giant rat']],
     'every id handed out before the save is found in the arguments, at any depth');
  eq(judgeArgs({ agent: 't9', what: [9461] }, { tool: 'supply', agent: 't9', registry, clock }), [],
     'an id handed to a different agent is not this agent\'s to judge');

  const fresh = [{ id: 12345, name: 'shilling' }, { id: 9462, name: 'herbs' },
                 { id: 700, name: 'giant rat' }, { id: 701, name: 'giant rat' }];
  const rr = reresolveRefs(refs, { candidates: fresh, clock });
  eq(rr.subs.map(s => [s.from, s.to, s.how]), [[9461, 12345, 'reresolved'], [9462, 9462, 'unchanged']],
     'a renumbered stack is re-resolved; an id still naming the same thing is kept');
  ok(!rr.ok && /now names 2 things \(ids 700, 701\)/.test(rr.refused[0].why), 'two rats: refused, never guessed');
  ok(STALE_ID_REASON.test(rr.refused[0].why) || /renumbers every object id/.test(rr.refused[0].why), 'the refusal names the save');
  const out = rewriteArgs(args, rr.subs);
  eq(out.what, [{ id: 12345, amount: 50 }, { id: 9462, amount: 2 }], 'the call is rewritten to the new ids');
  eq(args.what[0].id, 9461, 'the caller\'s own arguments are not mutated');
  const strArgs = rewriteArgs({ target: '9461' }, [{ path: ['target'], from: 9461, to: 12345 }]);
  eq(strArgs.target, '12345', 'a string id stays a string');

  // Re-issued after the save: the registry's last issue wins and it is no longer stale.
  registry.note('t4', 12345, { name: 'shilling', at: T0 + 31 * MIN });
  eq(judgeArgs({ what: [12345] }, { tool: 'supply', agent: 't4', registry, clock }), [], 'an id handed out after the save is not judged');
  // Keys that are not object ids are not judged.
  registry.note('t4', 3, { name: 'x', at: readAt });
  eq(judgeArgs({ id: 3, amount: 3, rounds: 3 }, { tool: 'supply', agent: 't4', registry, clock }), [],
     'a bare `id`, `amount` or other number outside the id keys is never treated as an object id');
  eq(judgeArgs({ what: [{ id: 12345, amount: 3 }] }, { tool: 'supply', agent: 't4', registry, clock }), [],
     'an `amount` beside an id is not an object id, even when that number was once handed out');
  registry.note('t4', 39, { name: 'Upstairs', at: readAt });
  eq(judgeArgs({ to: 39 }, { tool: 'travel', agent: 't4', registry, clock }), [],
     'travel `to` is a ROOM NUMBER — a tool not in the table is never judged on the way in');
  eq(judgeArgs({ to: 39 }, { tool: 'trade', agent: 't4', registry, clock }).map(r => r.id), [39],
     'while trade `to` is a player id and is judged');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
