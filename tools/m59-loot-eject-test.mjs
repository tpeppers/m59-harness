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
const { normalizeLootEject, normalizeTradeGoods, ejectTarget, ejectBatch, tradeGoodsFit, BACKOFF_MS } = await import('./m59-loot-eject.mjs');

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

console.log('the offer');
const weigh = n => ({ 'long sword': { weight: 150, bulk: 100 }, 'small round shield': { weight: 90, bulk: 90 }, ruby: { weight: 1, bulk: 1 } })[n] ?? null;
const plan = [
  { id: 1, name: 'ruby', amount: 5, sale_amount: 5, state: 'sell' },
  { id: 2, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell' },
  { id: 3, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell', equipped: true },
  { id: 4, name: 'small round shield', amount: 1, sale_amount: 1, state: 'sell' },
  { id: 5, name: 'herbs', amount: 40, sale_amount: 0, state: 'keep' },
  { id: -1, name: 'long sword', amount: 1, sale_amount: 1, state: 'sell' },
  { id: 6, name: 'ruby', amount: 9, sale_amount: 4, state: 'sell' },
];
const b = ejectBatch(plan, { batch: 6, weigh });
ok('only sell rows, never equipped, never a synthetic id', b.every(r => [1, 2, 4, 6].includes(r.id)) && b.length === 4, JSON.stringify(b));
ok('heaviest first', b[0].id === 2 && b[1].id === 4, b.map(r => r.id).join());
ok('a partial stack is offered by amount', b.find(r => r.id === 6)?.whole === false && b.find(r => r.id === 6)?.amount === 4);
ok('batch caps it', ejectBatch(plan, { batch: 2, weigh }).length === 2);

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
  const { fieldFor } = await import('./m59-strategy-schema.mjs');
  ok('a farm strategy may carry lootEject, under economy', fieldFor('lootEject')?.faculty === 'economy');
  const broker = readToolSource(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker takes loot_eject and trade_goods', /loot_eject: \{ type:/.test(broker) && /trade_goods: \{ type:/.test(broker));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
