#!/usr/bin/env node
// THE GUILD CHEST BOARD, THE SELL BOOK AND THE COURIER RANKING, offline. Never reads the real
// plan or chests, never starts a broker, never touches the network:
//
//   node tools/m59-guild-sale-test.mjs
//
// Pinned here: a chest's four parts add up and reserve is room that is not free; a sell line for
// the purse itself is refused; one sale runs at a time and a scheduled one is not started early;
// a courier the guardian angel keeps out, or one somebody else is driving, is never chosen; and
// one already carrying guild wants is preferred over an equally near one that is not.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-guild-sale-test-'));
const FILE = join(root, 'guild-sales.json');
const S = await import('./m59-guild-sale.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

console.log('chestBoard');
{
  const plan = { chests: new Map([['r18c2', [{ item: 'herb', target: 100 }, { item: 'lightning wand', target: 3, also: ['wand'] },
                                            { item: 'ruby', target: 50 }]]]) };
  const chests = [{ slot: 'r18c2', room: 714, observed_at: 1, opened_by: 'Statler',
    items: [{ name: 'herb', amount: 140 }, { name: 'wand', amount: 2 }, { name: 'lightning wand', amount: 1 },
            { name: 'mace', amount: 1 }, { name: 'shilling', amount: 9000 }] }];
  const bulk = n => ({ herb: 1, wand: 20, 'lightning wand': 20, ruby: 5, mace: 50, shilling: 0 })[n] ?? null;
  const [c] = S.chestBoard({ chests, plan, bulk, worth: () => 1, sellAt: n => n === 'mace' ? { merchant: 'Tomas', room: 103 } : null });
  const herb = c.planned.find(r => r.item === 'herb'), wand = c.planned.find(r => r.item === 'lightning wand');
  ok('surplus is held above target', herb.held === 140 && herb.surplus === 40 && herb.short === 0);
  ok('an `also` name counts toward its line, as the keeper counts it', wand.held === 3 && wand.short === 0);
  ok('stock no line names is unplanned, and shillings are marked never-evict',
     c.unplanned.map(u => u.item).sort().join() === 'mace,shilling' && c.unplanned.find(u => u.item === 'shilling').never_evict);
  ok('the parts are in bulk: kept, surplus, unplanned, reserve',
     c.parts.kept === 100 + 60 && c.parts.surplus === 40 && c.parts.unplanned === 50 && c.parts.reserve === 250,
     JSON.stringify(c.parts));
  ok('planned bulk is every target at its size', c.planned_bulk === 100 + 60 + 250);
  ok('evictions come from the shared ranking, with where each is sold',
     c.evictions.length > 0 && c.evictions.every(e => e.name !== 'shilling') && c.evictions.find(e => e.name === 'mace')?.sell_at?.merchant === 'Tomas');
  ok('raw counts ride along for the page to re-read an edited plan', c.counts.herb === 140 && c.counts.wand === 2);
  const [none] = S.chestBoard({ chests: [], plan });
  ok('a planned chest never read is drawn unseen, whole target short', none.seen === false && none.planned[0].short === 100);
}

console.log('\nnormaliseSellPlan');
{
  const sp = S.normaliseSellPlan({ items: [{ item: 'Mace', amount: 2 }, { item: 'mace', amount: 1 }, { item: 'shilling', amount: 5 },
                                          { item: '', amount: 1 }, { item: 'herb', amount: 0 }],
                                  proceeds: { mode: 'give' } });
  ok('names are folded and duplicates added', sp.items.length === 1 && sp.items[0].item === 'mace' && sp.items[0].amount === 3);
  ok('the purse itself is refused', sp.problems.some(p => /shilling/.test(p)));
  ok('a hand-over with nobody named is reported', sp.problems.some(p => /none is named/.test(p)));
  ok('an unknown mode falls back to the courier banking it',
     S.normaliseSellPlan({ proceeds: { mode: 'burn it' } }).proceeds.mode === 'courier');
  ok('hall proceeds keep their sub-mode', S.normaliseSellPlan({ proceeds: { mode: 'hall', hall: 'rent' } }).proceeds.hall === 'rent');
}

console.log('\nthe job book');
{
  const now = 1_000_000;
  const a = S.addJob({ items: [{ item: 'mace', amount: 1 }], proceeds: { mode: 'courier' } }, FILE, now).job;
  const b = S.addJob({ at: now + 3600_000, items: [{ item: 'herb', amount: 10 }], proceeds: { mode: 'hall' } }, FILE, now).job;
  ok('ids are sequential and a now-job is due now', a.id === 'gs-1' && b.id === 'gs-2' && a.at === now);
  ok('a later job is not due yet', S.nextDue(S.readSales(FILE), now)?.id === 'gs-1');
  S.updateJob('gs-1', { status: 'running' }, FILE);
  ok('nothing else starts while one runs', S.nextDue(S.readSales(FILE), now + 7200_000) === null);
  S.updateJob('gs-1', { status: 'done' }, FILE);
  ok('the later one is due at its time', S.nextDue(S.readSales(FILE), now + 3600_000)?.id === 'gs-2');
  ok('a running or finished job cannot be cancelled', (() => { try { S.cancelJob('gs-1', FILE); return false; } catch { return true; } })());
  ok('a scheduled one can', S.cancelJob('gs-2', FILE).status === 'cancelled' && S.nextDue(S.readSales(FILE), now + 9e9) === null);
  ok('an empty sale is refused', (() => { try { S.addJob({ items: [] }, FILE, now); return false; } catch { return true; } })());
  ok('a hand-over to nobody is refused',
     (() => { try { S.addJob({ items: [{ item: 'mace', amount: 1 }], proceeds: { mode: 'give' } }, FILE, now); return false; } catch { return true; } })());
  const sp = S.saveSellPlan({ items: [{ item: 'ruby', amount: 4 }], proceeds: { mode: 'give', to: 'Kermit', bank: 'jasper' } }, FILE);
  ok('the sell plan saves beside the jobs without disturbing them',
     sp.sell_plan.proceeds.to === 'Kermit' && S.readSales(FILE).jobs.length === 2);
}

console.log('\nrankCouriers');
{
  const pack = (bulk, max = 2400) => ({ weight: 100, bulk, max, exact: true });
  const rows = [
    { agent: 't1', character: 'Near', room_num: 101, health: '80/80', pack: pack(400) },
    { agent: 't2', character: 'NearWithDrop', room_num: 102, health: '80/80', pack: pack(400) },
    { agent: 't3', character: 'Small', room_num: 101, health: '20/20', pack: pack(0) },
    { agent: 't4', character: 'Driven', room_num: 101, health: '80/80', pack: pack(0), committed: { label: 'dum steering' } },
    { agent: 't5', character: 'Stranger', room_num: 101, health: '80/80', pack: pack(0) },
    { agent: 't6', character: 'Desk', room_num: 714, health: '80/80', pack: pack(0) },
    { agent: 't7', character: 'Full', room_num: 714, health: '80/80', pack: pack(2390) },
  ];
  const access = new Set(['t1', 'nearwithdrop', 'small', 'driven', 'desk', 't7']);
  const eta = new Map([['t1', 120_000], ['t2', 120_000], ['t3', 60_000], ['t4', 60_000], ['t5', 60_000], ['t6', 0], ['t7', 0]]);
  const dropoff = new Map([['t2', { bulk: 300, items: ['herb'] }]]);
  const r = S.rankCouriers({ rows, saleBulk: 1500, access, cfg: { manager: 't6', go_between: 't9' }, desk: { at: 1 }, eta, dropoff });
  const by = Object.fromEntries(r.map(x => [x.agent, x]));
  ok('under 30 max health is refused', !by.t3.ok && by.t3.why.some(w => /guardian angel/.test(w)));
  ok('a character something else is driving is refused', !by.t4.ok && by.t4.why.some(w => /committed/.test(w)));
  ok('one never seen opening the chests, with no recorded rank, is refused', !by.t5.ok && by.t5.why.some(w => /never seen/.test(w)));
  ok('desk staff are refused while the desk is open', !by.t6.ok && by.t6.why.some(w => /desk/.test(w)));
  ok('a full pack that would need more than six trips is refused', !by.t7.ok && by.t7.why.some(w => /trips|no room/.test(w)));
  ok('the one already carrying guild wants beats an equally near one', r[0].agent === 't2' && r[1].agent === 't1' && r[0].ok && r[1].ok);
  ok('a rank below sir refuses even a known opener',
     !S.rankCouriers({ rows: [rows[0]], access, cfg: { ranks: { t1: 1 } }, eta })[0].ok);
}

console.log('\nsalePlan');
{
  const { plan, unsellable } = S.salePlan([{ item: 'mace', amount: 2 }, { item: 'rose', amount: 1 }],
    n => n === 'mace' ? { merchant: 'Tomas', room: 103 } : null);
  ok('lines with a merchant become runEviction rows', plan.total.length === 1 && plan.total[0].sell_at.merchant === 'Tomas' && plan.moves.length === 0);
  ok('lines nobody buys are reported and left in the chests', unsellable.join() === 'rose');
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
