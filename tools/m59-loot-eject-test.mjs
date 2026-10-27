#!/usr/bin/env node
// LOOT EJECTION -- offline, no socket, no roster.
//
//   node tools/m59-loot-eject-test.mjs
//
// What this pins (tools/m59-loot-eject.mjs):
//   * lootEject and trade_goods validate, refuse a bad shape, and are OFF when absent (silence is the old behaviour);
//   * the target is the first of `to`, in order, standing in the room and not backed off: a station before a courier;
//   * the offer is the sale plan's 'sell' rows only, never an equipped row or a synthetic (negative) id, heaviest first,
//     at most `batch`, and a partial stack is offered by amount;
//   * a station takes trade goods only while its pack stays keep_free empty, and an unweighed pack or offer is a no;
//   * giveItems counts what LEFT THE PACK by id, so a handshake that moves nothing is not a delivery, and a receiver
//     that does not counter is cancelled;
//   * the keeper binds it: ejectLoot runs in the sharing pass, acceptDonations honours trade_goods, the policy key
//     defaults to null, the broker and a farm strategy can set it.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_TRADE_GOODS_DIR = mkdtempSync(join(tmpdir(), 'm59-trade-goods-'));
const { normalizeLootEject, normalizeTradeGoods, ejectTarget, ejectBatch, overflowDrops, tradeGoodsFit, BACKOFF_MS,
        noteReceived, noteGone, readReceived } = await import('./m59-loot-eject.mjs');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

console.log('validation');
ok('absent is off', normalizeLootEject(null) === null && normalizeLootEject({ enabled: false, to: ['x'] }) === null);
const cfg = normalizeLootEject({ to: ['Loial', 'Zheng He'] });
ok('defaults: every 90 s, batch 6, order kept', cfg.every_s === 90 && cfg.batch === 6 && cfg.to.join() === 'Loial,Zheng He', JSON.stringify(cfg));
ok('nobody to eject to is refused', /names nobody/.test(throws(() => normalizeLootEject({ to: [] })) ?? ''));
ok('an unknown key is refused', /not known/.test(throws(() => normalizeLootEject({ to: ['a'], too: 1 })) ?? ''));
ok('batch over 12 is refused', /1\.\.12/.test(throws(() => normalizeLootEject({ to: ['a'], batch: 50 })) ?? ''));
ok('trade_goods: true is keep_free 0.25 from anyone', JSON.stringify(normalizeTradeGoods(true)) === '{"enabled":true,"keep_free":0.25,"from":null}');
ok('trade_goods: from is lower-cased', normalizeTradeGoods({ from: ['Fozzie'] }).from[0] === 'fozzie');
ok('trade_goods absent is off', normalizeTradeGoods(undefined) === null && normalizeTradeGoods(false) === null);

console.log('the target');
const now = 1_000_000;
ok('a station before a courier', ejectTarget({ present: ['Zheng He', 'Loial'], to: cfg.to, now }) === 'Loial');
ok('the courier when the station is not here', ejectTarget({ present: ['zheng he', 'Fozzie'], to: cfg.to, now }) === 'Zheng He');
ok('nobody listed here: nothing', ejectTarget({ present: ['Fozzie'], to: cfg.to, now }) === null);
ok('a backed-off station is skipped for the courier',
   ejectTarget({ present: ['Loial', 'Zheng He'], to: cfg.to, backoff: new Map([['loial', now + BACKOFF_MS]]), now }) === 'Zheng He');

console.log('the offer: best value per unit of pack first');
const weigh = n => ({ 'long sword': { weight: 150, bulk: 100 }, 'small round shield': { weight: 90, bulk: 90 }, ruby: { weight: 1, bulk: 1 },
                      'knight\'s shield': { weight: 300, bulk: 300 }, diamond: { weight: 1, bulk: 1 } })[n] ?? null;
// shillings per unit of binding cost, as overfarm's scoreItem reports it
const PRICE = { 'long sword': 300, 'small round shield': 45, ruby: 40, 'knight\'s shield': 30, diamond: 200 };
const score = n => { const w = weigh(n), v = PRICE[n]; return w && v != null ? { rankable: true, score: v / Math.max(w.weight, w.bulk) } : { rankable: false }; };
const plan = [
  { id: 1, name: 'ruby', amount: 5, sale_amount: 5, state: 'sell' },
  { id: 2, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell' },
  { id: 3, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell', equipped: true },
  { id: 4, name: 'small round shield', amount: 1, sale_amount: 1, state: 'sell' },
  { id: 5, name: 'herbs', amount: 40, sale_amount: 0, state: 'keep' },
  { id: -1, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell' },
  { id: 6, name: 'ruby', amount: 9, sale_amount: 4, state: 'sell' },
  { id: 7, name: 'diamond', amount: 3, sale_amount: 0, state: 'keep' },
  { id: 8, name: 'knight\'s shield', amount: 1, sale_amount: 1, state: 'sell' },
];
const b = ejectBatch(plan, { batch: 6, weigh, score });
ok('only sell rows, never equipped, never a synthetic id, never a kept row', b.every(r => [1, 2, 4, 6, 8].includes(r.id)) && b.length === 5, JSON.stringify(b));
ok('rubies (40/unit) before long swords (2/unit) before shields (0.5, 0.1)', b[0].name === 'ruby' && b[2].id === 2 && b.at(-1).id === 8, b.map(r => r.id).join());
ok('a partial stack is offered by amount', b.find(r => r.id === 6)?.whole === false && b.find(r => r.id === 6)?.amount === 4);
ok('batch caps it', ejectBatch(plan, { batch: 2, weigh, score }).length === 2);
const withGems = ejectBatch(plan, { batch: 6, weigh, score, extra: ['diamond'] });
ok('`extra` ejects what the plan keeps (gems), and first: it is worth the most per unit', withGems[0].name === 'diamond' && withGems[0].amount === 3,
   JSON.stringify(withGems[0]));

console.log('overflow: drop the worst value per unit of pack');
{
  const d = overflowDrops(plan, { fullness: 0.99, capMax: 2700, overflowAt: 0.85, max: 4, weigh, score });
  ok('the knight\'s shield goes first, then the small shield', d[0]?.id === 8 && d[1]?.id === 4, JSON.stringify(d));
  ok('it stops once the pack is back under the line (0.99 - 0.11 - 0.03 < 0.85)', d.length === 2, `${d.length} drops`);
  ok('never a gem the operator kept, never a kept row', !d.some(r => [5, 7].includes(r.id)));
  ok('under the line: nothing dropped', overflowDrops(plan, { fullness: 0.8, capMax: 2700, overflowAt: 0.85, weigh, score }).length === 0);
  ok('off when overflow_at is not set', overflowDrops(plan, { fullness: 0.99, capMax: 2700, overflowAt: null, weigh, score }).length === 0);
  const unpriced = overflowDrops([{ id: 9, name: 'mystery', amount: 1, sale_amount: 1, state: 'sell' }],
    { fullness: 0.99, capMax: 2700, overflowAt: 0.85, weigh: () => ({ weight: 500, bulk: 500 }), score: () => ({ rankable: false }) });
  ok('an unpriced item is never dropped (unrankable is not worthless)', unpriced.length === 0);
  ok('overflow_at alone (no `to`) is a valid order', normalizeLootEject({ overflow_at: 0.85 }).overflow_at === 0.85);
}

console.log('a station passes on only what it was given');
{
  noteReceived('t-station', [{ name: 'long sword', amount: 0 }, { name: 'long sword' }, { name: 'ruby', amount: 4 }]);
  ok('received is counted by name', JSON.stringify(readReceived('t-station')) === '{"long sword":2,"ruby":4}');
  const pack = [{ id: 11, name: 'long sword', amount: 1, state: 'keep' }, { id: 12, name: 'long sword', amount: 1, state: 'keep' },
                { id: 13, name: 'long sword', amount: 1, state: 'keep' }, { id: 14, name: 'long sword', amount: 1, state: 'keep' },
                { id: 15, name: 'ruby', amount: 10, state: 'keep' }];
  const r = ejectBatch(pack, { batch: 12, weigh, score, received: readReceived('t-station') });
  ok('only two of its four long swords leave (its own armoury stays), and four of ten rubies',
     r.filter(x => x.name === 'long sword').length === 2 && r.find(x => x.name === 'ruby')?.amount === 4, JSON.stringify(r));
  noteGone('t-station', [{ name: 'long sword', amount: 2 }, { name: 'ruby', amount: 1 }]);
  ok('what left is taken off the count', JSON.stringify(readReceived('t-station')) === '{"ruby":3}');
}

console.log('a station keeps its spare space');
const cap = { known: true, weight_max: 2700, bulk_max: 2700, load: { weight: 1500, bulk: 600, exact: true } };
const wp = items => { let weight = 0, bulk = 0; const unknown = []; for (const i of items) { const w = weigh(i.name); if (!w) { unknown.push(i.name); continue; } weight += w.weight * (i.amount || 1); bulk += w.bulk * (i.amount || 1); } return { weight, bulk, unknown, exact: !unknown.length }; };
ok('fits under keep_free', tradeGoodsFit({ offered: [{ name: 'long sword' }], cap, keepFree: 0.25, weigh: wp }).fits === true);
const over = tradeGoodsFit({ offered: Array.from({ length: 4 }, () => ({ name: 'long sword' })), cap, keepFree: 0.25, weigh: wp });
ok('refused when it would eat the station\'s reserve, and says how full', over.fits === false && /over the 75%/.test(over.why), over.why);
ok('an unweighed pack is a no', tradeGoodsFit({ offered: [{ name: 'long sword' }], cap: { ...cap, load: { ...cap.load, exact: false } }, weigh: wp }).fits === false);
ok('an unweighed offer is a no', tradeGoodsFit({ offered: [{ name: 'mystery' }], cap, weigh: wp }).fits === false);

console.log('the hand-over counts what left the pack');
const { Autopilot } = await import('./m59-autopilot.mjs');
function fakeKeeper({ counter = true, moves = true } = {}) {
  const inv = [{ id: 2, nameRsc: 'long sword', amount: 0 }, { id: 6, nameRsc: 'ruby', amount: 9 }];
  const events = []; let seq = 0;
  const c = {
    get evSeq() { return seq; }, inventory: inv, selfId: 99,
    rsc: { get: k => k },
    room: { objects: new Map([[7, { id: 7, nameRsc: 'Loial', flags: 0x80 }]]) },
    offer: async () => { events.push({ seq: ++seq, kind: counter ? 'countered' : 'trade-ended' }); },
    cancelOffer: async () => { c.cancelled = true; },
    acceptOffer: async () => { if (moves) { inv.splice(inv.findIndex(i => i.id === 2), 1); inv.find(i => i.id === 6).amount = 5; }
                               events.push({ seq: ++seq, kind: 'trade-ended' }); },
    requestInventory: async () => { events.push({ seq: ++seq, kind: 'inventory' }); },
    waitFor: async ({ since = 0, kinds }) => ({ events: events.filter(e => e.seq > since && kinds.includes(e.kind)) }),
  };
  return { c, keeper: Object.assign(Object.create(Autopilot.prototype), { s: { need: () => c, client: c, pacer: { submit: (_k, f) => f() } } }) };
}
{
  const { OF } = await import('./m59-parse.mjs');
  const rows = [{ id: 2, name: 'long sword', amount: 1, whole: true }, { id: 6, name: 'ruby', amount: 4, whole: false }];
  let f = fakeKeeper();
  f.c.room.objects.get(7).flags = OF.PLAYER;
  let r = await f.keeper.giveItems('Loial', rows);
  ok('a counter and an accept move the goods, counted by id', r.moved.length === 2 && r.moved.find(m => m.name === 'ruby')?.amount === 4, JSON.stringify(r));
  f = fakeKeeper({ moves: false }); f.c.room.objects.get(7).flags = OF.PLAYER;
  r = await f.keeper.giveItems('Loial', rows);
  ok('a handshake that moves nothing is not a delivery', r.moved.length === 0 && /nothing left/.test(r.why), JSON.stringify(r));
  f = fakeKeeper({ counter: false }); f.c.room.objects.get(7).flags = OF.PLAYER;
  r = await f.keeper.giveItems('Loial', rows);
  ok('no counter: the offer is cancelled', r.moved.length === 0 && f.c.cancelled === true, JSON.stringify(r));
  f = fakeKeeper();
  r = await f.keeper.giveItems('Loial', rows);
  ok('a receiver not in the room is not offered anything', r.moved.length === 0 && /not in the room/.test(r.why));
}

console.log('the bindings');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('ejectLoot runs in the sharing pass', /withBodyStage\(s,'passSharing',\(\)=>this\.ejectLoot\(\)\)/.test(src));
  ok('lootEject defaults to null', /lootEject: null,/.test(src));
  ok('acceptDonations honours trade_goods before the take list', src.indexOf('tradeGoodsApply') > 0
     && src.indexOf('tradeGoodsApply') < src.indexOf("offered something not on the take list"));
  ok('a bot holding economy turns ejection off', /async ejectLoot\(\)[\s\S]{0,900}facultyHeld\('economy'\)/.test(src));
  ok('a station notes what it received as trade goods', /if \(tradeGoodsApply\) \{ try \{ noteReceived/.test(src));
  ok('a station never overflow-drops (it refuses instead)', /cfg\.overflow_at == null \|\| cfg\.only_received/.test(src));
  const { fieldFor } = await import('./m59-strategy-schema.mjs');
  ok('a farm strategy may carry lootEject, under economy', fieldFor('lootEject')?.faculty === 'economy');
  const broker = readToolSource(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker takes loot_eject and trade_goods', /loot_eject: \{ type:/.test(broker) && /trade_goods: \{ type:/.test(broker));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
