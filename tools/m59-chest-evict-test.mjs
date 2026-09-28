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

console.log('\nmove before selling: valuables into the unfull chests, cheap town stock sold');
{
  const p = planEviction({ ...base, chests: [
    { slot: 'full', items: [{ name: 'herb', amount: 1000 }, { name: 'long sword', amount: 60 }, { name: 'mystic sword', amount: 20 }] },   // 4000+3600+1200 = 8800
    { slot: 'roomy', items: [{ name: 'herb', amount: 250 }] } ] });                                                                          // 1000, room 7000 to 8000
  const f = p.chests.find(c => c.slot === 'full');
  const moved = f.moves.map(m => m.item), sold = f.evict.map(e => e.item);
  ok('the most valuable per bulk moves first (the mystic sword nobody sells)', moved[0] === 'mystic sword', JSON.stringify(f.moves));
  ok('valuables move rather than sell', !sold.includes('long sword') && !sold.includes('mystic sword'), JSON.stringify(f.evict));
  ok('cheap town stock is not moved into another chest', !moved.includes('herb'), JSON.stringify(f.moves));
  ok('the full chest reaches its goal', f.short === 0 && f.freed >= f.need, JSON.stringify(f));
  ok('moves go into the chest with room', f.moves.every(m => m.to === 'roomy'));
}
{
  // No room anywhere: cheap town stock sold first, then whatever still won't fit; irreplaceable never sold.
  const p = planEviction({ ...base, chests: [
    { slot: 'full', items: [{ name: 'herb', amount: 300 }, { name: 'long sword', amount: 120 }, { name: 'mystic sword', amount: 20 }] },
    { slot: 'also', items: [{ name: 'axe', amount: 100 }] } ] });
  const f = p.chests.find(c => c.slot === 'full');
  ok('herb (cheap, town) is sold before the long sword (only still-won\'t-fit)', f.evict[0]?.item === 'herb' && f.evict.some(e => e.item === 'long sword' && e.why === 'still would not fit'), JSON.stringify(f.evict));
  ok('the mystic sword is never sold', !f.evict.some(e => e.item === 'mystic sword'));
}

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
{
  const W = { room: 714, pack: [{ id: 5, name: 'herb', amount: 250 }, { id: 6, name: 'small round shield' }], chests: { herb: 300 }, sales: [], deposits: [], moves: [] };
  const call = async (tool, a) => {
    if (tool === 'fleet') return { fleet: [{ agent: 't3', room_num: W.room, pack: { weight: 0, bulk: 200, max: 2400, exact: true } }] };
    if (tool === 'inventory') return { items: W.pack.map(o => ({ ...o })) };
    if (tool === 'equipment') return { known: true, equipped: [{ id: 6 }] };
    if (tool === 'travel') { W.room = a.to; return { arrived: true }; }
    if (tool === 'hall_move') { W.moves.push(...a.moves); return { ok: true, moves: a.moves.map(m => ({ ...m, took: m.amount, moved: m.amount })) }; }
    if (tool === 'hall_withdraw') {
      if (a.deposit) { W.deposits.push(a.deposit); for (const n of a.deposit) { const o = W.pack.find(x => x.name === n && x.id !== 6); if (o) { W.chests[n] = (W.chests[n] ?? 0) + o.amount; W.pack = W.pack.filter(x => x !== o); } }
        for (const w of a.wants ?? []) { W.chests[w.item] -= w.amount; W.pack.push({ id: 7, name: w.item, amount: w.amount }); } return { ok: true }; }
      const w = a.wants[0]; W.chests[w.item] -= w.amount; W.pack.push({ id: 9, name: w.item, amount: w.amount }); return { ok: true, took: { [w.item]: w.amount }, short: {} };
    }
    if (tool === 'sell') { W.sales.push({ room: W.room, items: a.items }); for (const sp of a.items) { const o = W.pack.find(x => x.id === (sp.id ?? sp)); if (o) o.amount = (o.amount ?? 1) - (sp.amount ?? 1); } W.pack = W.pack.filter(o => (o.amount ?? 1) > 0 || o.amount === undefined); return {}; }
    throw new Error(tool);
  };
  const plan = { total: [{ item: 'herb', amount: 20, tier: 'here', sell_at: { merchant: 'Joguer', room: 104 } },
                         { item: 'small round shield', amount: 1, tier: 'here', sell_at: { merchant: 'Izzio', room: 593 } }],
                 moves: [{ item: 'long sword', amount: 5, from: 'r18c6', to: 'r18c2' }] };
  await runEviction({ plan, agent: 't3', call, log: () => {}, keep: { herb: 40 }, ledgerFile: `${process.env.TEMP ?? '/tmp'}/chest-evict-test.jsonl` });
  ok('the runner\'s own herbs go INTO the chests, with its 40 drawn back', W.deposits[0]?.includes('herb') && W.chests.herb >= 490, JSON.stringify({ d: W.deposits, c: W.chests }));
  ok('the worn shield is never deposited or offered', !W.deposits.flat().includes('small round shield') &&
     !W.sales.some(s => s.items.some(i => (i.id ?? i) === 6)), JSON.stringify({ d: W.deposits, s: W.sales }));
  ok('the moves are made chest to chest before selling', W.moves[0]?.item === 'long sword' && W.moves[0]?.to === 'r18c2', JSON.stringify(W.moves));
  ok('then the planned herbs are drawn and sold', W.sales.some(s => s.room === 104), JSON.stringify(W.sales));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
