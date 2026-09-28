#!/usr/bin/env node
// Offline: making room in the guild chests (m59-chest-evict). Operator, 2026-09-28: "Free room by
// evicting low overstock first, with an absolute preference for overstock that can be rebought in
// [Barloque] first (whatever town the guild chest is in)".
//
//   node tools/m59-chest-evict-test.mjs
import { planEviction, sellersByItem, CHEST_BULK } from './m59-chest-evict.mjs';
import { runEviction } from './m59-chest-evict-run.mjs';
import { townOfRoom } from './m59-profiles.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };

console.log('the town of a guild chest');
ok('the Bookmaker\'s hall (714) is in Barloque', townOfRoom(714)?.key === 'barloque');
ok('the Outskirts (583) are not', townOfRoom(583) === null);

console.log('\nwho sells what, by name, blocked merchants left out');
{
  const s = sellersByItem({
    merchants: [{ name: 'Joguer', room: 104, sells: [{ cls: 'Herbs' }] }, { name: 'Meidei', room: 103, sells: [{ cls: 'Bread' }] },
                { name: 'Faraway', room: 50, sells: [{ cls: 'Axe' }] }],
    items: { herb: { name: 'herb', cls: 'Herbs' }, bread: { name: 'loaf of bread', cls: 'Bread' }, axe: { name: 'axe', cls: 'Axe' } },
    blocked: ['Meidei'] });
  ok('herb from Joguer at 104', s.get('herb')?.[0]?.merchant === 'Joguer');
  ok('a blocked merchant sells nothing', !s.has('loaf of bread'));
  ok('a seller in another town is kept', s.get('axe')?.[0]?.room === 50);
}

console.log('\nthe order: rebuyable here, then elsewhere; least value per bulk first; never under target');
const BULK = { herb: 4, axe: 90, diamond: 1, 'long sword': 60, 'mystic sword': 60, emerald: 1 };
const WORTH = { herb: 7, axe: 420, diamond: 70, 'long sword': 560, 'mystic sword': 5000, emerald: 21 };
const sellers = new Map([['herb', [{ merchant: 'Joguer', room: 104 }]], ['emerald', [{ merchant: 'Herbutte', room: 109 }]],
                         ['axe', [{ merchant: 'Faraway', room: 50 }]], ['long sword', [{ merchant: 'Faraway', room: 50 }]]]);
const base = { sellers, townRooms: [101, 104, 109], worth: n => WORTH[n] ?? null, bulk: n => BULK[n] ?? null, capacity: 10_000, fill: 0.8 };
{
  const p = planEviction({ ...base, chests: [{ slot: 'r18c6', items: [
    { name: 'herb', amount: 500 },            // 2000 bulk, rebuyable here
    { name: 'emerald', amount: 800 },         // 800 bulk, rebuyable here, target 700
    { name: 'axe', amount: 50 },              // 4500 bulk, rebuyable elsewhere
    { name: 'long sword', amount: 30 },       // 1800 bulk, elsewhere
    { name: 'mystic sword', amount: 5 },      // nobody sells it
    { name: 'diamond', amount: 900 } ] }],    // no seller at all; 900 bulk
    targets: new Map([['r18c6', new Map([['emerald', 700]])]]) });
  const c = p.chests[0];
  ok('a chest over 80% is brought down to it', c.need === c.bulk - 8000 && c.short === 0, JSON.stringify(c));
  const order = c.evict.map(e => e.item);
  ok('herb (here, 1.75/bulk) before emerald (here, 21/bulk)', order.indexOf('herb') < order.indexOf('emerald'), order.join(','));
  ok('everything rebuyable here goes before anything elsewhere', order.indexOf('emerald') < order.indexOf('axe') || !order.includes('axe'), order.join(','));
  const em = c.evict.find(e => e.item === 'emerald');
  ok('only the overstock above the plan\'s target', !em || em.amount <= 100, JSON.stringify(em));
  ok('nobody-sells-it is never planned by default', !order.includes('mystic sword') && !order.includes('diamond'), order.join(','));
  ok('no more than needed', c.freed >= c.need && c.freed - c.need < 90, `${c.freed} vs ${c.need}`);
}
{
  const p = planEviction({ ...base, chests: [{ slot: 'x', items: [{ name: 'herb', amount: 100 }] }] });
  ok('a chest under its goal is left alone', p.chests[0].evict.length === 0 && p.chests[0].need === 0);
}
{
  const p = planEviction({ ...base, protect: ['herb'], chests: [{ slot: 'x', items: [{ name: 'herb', amount: 2400 }] }] });
  ok('a protected name is never evicted, and the shortfall is said', p.chests[0].evict.length === 0 && p.chests[0].short > 0);
}
ok('the capacity is the kod\'s', CHEST_BULK === 24_000);

console.log('\nthe run: draw what fits, sell where it is sold, on the ledger');
{
  const W = { room: 101, pack: [], chests: { herb: 300 }, sales: [] };
  const call = async (tool, a) => {
    if (tool === 'fleet') return { fleet: [{ agent: 't9', room_num: W.room, pack: { weight: 0, bulk: 0, max: 2400, exact: true } }] };
    if (tool === 'inventory') return { items: W.pack.map(o => ({ ...o })) };
    if (tool === 'travel') { W.room = a.to; return { arrived: true }; }
    if (tool === 'hall_withdraw') { const w = a.wants[0]; const n = Math.min(w.amount, W.chests.herb); W.chests.herb -= n; W.pack.push({ id: 1, name: 'herb', amount: n }); return { ok: true, took: { herb: n }, short: {} }; }
    if (tool === 'sell') { W.sales.push({ to: a.to, room: W.room, items: a.items }); W.pack = []; return { received: 700 }; }
    throw new Error(tool);
  };
  const plan = { total: [{ item: 'herb', amount: 250, tier: 'here', sell_at: { merchant: 'Joguer', room: 104 } }] };
  const r = await runEviction({ plan, agent: 't9', call, log: () => {}, ledgerFile: `${process.env.TEMP ?? '/tmp'}/chest-evict-test.jsonl` });
  ok('drawn from the chests and sold to Joguer in his room', W.sales[0]?.to === 'Joguer' && W.sales[0]?.room === 104 && W.chests.herb === 50, JSON.stringify(W));
  ok('exactly the planned amount', r.sold.herb === 250, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
