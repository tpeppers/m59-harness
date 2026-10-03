#!/usr/bin/env node
// DID THE PURCHASE ARRIVE? Offline, no socket, no roster:
//
//   node tools/m59-shop-arrival-test.mjs
//
// 2026-10-03, prod, keeper-backed t2 at Morrigan's counter: `shop` with
// buy_ids [{id:338, amount:120}] answered "nothing arrived and nothing was said" with
// `got: []` and `chunks: 3`, and the pack held 50 herbs three seconds later. Two defects:
// the pack was counted off the snapshot literal the tool started with (so it never moved),
// and the loop stopped at chunk 1 on that false "nothing" — 120 asked, one chunk of 50
// delivered, the other two never sent, and the reply said none had come.
//
// The fake keeper here does what the real one does: the buy returns no `got` frame, and the
// items land in the pack a few reads LATER, sometimes in two pieces.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyInChunks, settleCounts, countByKey, itemKey } from './m59-shop-arrival.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

// A clock the test owns, so "late" is measured in reads and nothing really sleeps.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

// A keeper: a pack, a counter, and a delivery that lands `lagReads` reads after the buy,
// split into `pieces`. `limit` is what the counter will actually hand over per buy (the
// purse running out, say); `refuseAfter` makes every buy after the Nth bring nothing.
function fakeKeeper({ pack = {}, lagReads = 3, pieces = 1, limit = Infinity, refuseAfter = Infinity,
                      said = '' } = {}) {
  const inv = new Map(Object.entries(pack));
  const pending = [];
  let buys = 0, reads = 0;
  return {
    reads: () => reads,
    buys: () => buys,
    send: async (line) => {
      buys++;
      const n = buys > refuseAfter ? 0 : Math.min(line.amount, limit);
      const per = Math.ceil(n / pieces);
      for (let i = 0, left = n; left > 0; i++, left -= per)
        pending.push({ at: reads + lagReads + i, name: 'herb', amount: Math.min(per, left) });
      return { got: [], said: buys > refuseAfter ? said : '' };   // no `got` frame, like prod
    },
    read: async () => {
      reads++;
      for (const p of pending.filter(p => p.at <= reads)) {
        inv.set(p.name, (inv.get(p.name) ?? 0) + p.amount);
        pending.splice(pending.indexOf(p), 1);
      }
      const keys = new Set(['herb']);
      return countByKey([...inv.entries()].map(([name, amount]) => ({ name, amount })), o => o.name, keys);
    },
  };
}

const nameOf = id => (id === 338 ? 'herb' : null);
const chunks = (id, total, per = 50) => {
  const out = [];
  for (let left = total; left > 0; left -= per) out.push({ id, amount: Math.min(per, left) });
  return out;
};

console.log('names meet across the offer and the pack');
ok('herb and herbs are one item', itemKey('herb') === itemKey('Herbs'));
ok('punctuation and case fold', itemKey('Red Mushroom') === itemKey('redmushroom'));

console.log('\nthe pack is polled until it settles, not read once');
{
  const clk = fakeClock();
  const k = fakeKeeper({ lagReads: 3 });
  const base = await k.read();
  await k.send({ id: 338, amount: 50 });
  const after = await settleCounts(k.read, base, { ...clk, deadlineMs: 6000, pollMs: 400 });
  ok('a delivery that lands three reads late is seen', after?.get('herb') === 50, JSON.stringify([...after ?? []]));
  ok('and the poll stopped once it held still, well before the deadline', clk.now() < 6000, `t=${clk.now()}`);
}
{
  const clk = fakeClock();
  const k = fakeKeeper();
  const base = await k.read();
  const after = await settleCounts(k.read, base, { ...clk, deadlineMs: 3000, pollMs: 500 });
  ok('a pack that never moves is polled to the deadline and reported unchanged',
     clk.now() >= 3000 && (after?.get('herb') ?? 0) === 0);
}

console.log('\nTHE PROD CASE: 120 herbs, three chunks, no `got` frame, late arrivals');
{
  const clk = fakeClock();
  const k = fakeKeeper({ lagReads: 2, pieces: 2 });
  const run = await buyInChunks({ rounds: chunks(338, 120), nameOf, send: k.send, read: k.read, settle: clk });
  ok('all three chunks were sent, not one', run.chunks_sent === 3, `sent ${run.chunks_sent}`);
  ok('all 120 arrived and were counted', run.received[0]?.arrived === 120, JSON.stringify(run.received));
  ok('nothing is reported short', !run.received[0]?.short);
  ok('no `got` frame was needed to say so', run.got.length === 0 && run.total_arrived === 120);
  ok('and the run did not stop early', run.refused_after === null);
}

console.log('\na partial delivery is reported as partial, with what stopped it');
{
  const clk = fakeClock();
  // The counter hands over 50 then refuses — what the purse running out looks like.
  const k = fakeKeeper({ lagReads: 2, refuseAfter: 1 });
  const run = await buyInChunks({ rounds: chunks(338, 120), nameOf, send: k.send, read: k.read, settle: clk });
  ok('50 arrived and are counted', run.received[0]?.arrived === 50, JSON.stringify(run.received));
  ok('the shortfall is stated: asked 120, short 70',
     run.received[0]?.asked === 120 && run.received[0]?.short === 70);
  ok('the loop stopped at the chunk that brought nothing, not before',
     run.chunks_sent === 2 && /chunk 2 of 3 brought nothing/.test(run.refused_after ?? ''), run.refused_after);
}
{
  const clk = fakeClock();
  // A counter that hands over 30 of every 50 asked: each short chunk is said, and kept going.
  const k = fakeKeeper({ lagReads: 1, limit: 30 });
  const run = await buyInChunks({ rounds: chunks(338, 100), nameOf, send: k.send, read: k.read, settle: clk });
  ok('a chunk that brought SOME is not treated as refused', run.chunks_sent === 2 && run.refused_after === null);
  ok('the total arrived is what the pack says (60 of 100)', run.received[0]?.arrived === 60 && run.received[0]?.short === 40);
  ok('each short chunk is named', run.messages.filter(m => /asked 50, 30 arrived/.test(m)).length === 2,
     JSON.stringify(run.messages));
}
{
  const clk = fakeClock();
  const k = fakeKeeper({ refuseAfter: 0, said: 'You cannot afford that.' });
  const run = await buyInChunks({ rounds: chunks(338, 20), nameOf, send: k.send, read: k.read, settle: clk });
  ok('a refused first chunk arrives nothing and carries the merchant\'s sentence',
     run.total_arrived === 0 && /cannot afford/.test(run.refused_after ?? ''));
}

console.log('\nan unreadable pack falls back to `got` frames, and never invents an arrival');
{
  const clk = fakeClock();
  const run = await buyInChunks({ rounds: chunks(338, 10), nameOf, settle: clk,
    send: async () => ({ got: [{ id: 9001, amount: 10 }] }), read: async () => null });
  ok('a framed arrival is counted', run.total_arrived === 10 && run.pack_readable === false);
  const none = await buyInChunks({ rounds: chunks(338, 10), nameOf, settle: clk,
    send: async () => ({ got: [] }), read: async () => null });
  ok('no frame and no pack is zero, not success', none.total_arrived === 0 && !!none.refused_after);
}

console.log('\nthe broker\'s shop tool uses this, and reads the pack off the CURRENT client');
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  const i = broker.indexOf("name: 'shop',");
  const shopTool = i === -1 ? '' : broker.slice(i, broker.indexOf("name: 'trade',", i));
  ok('the shop tool was found', shopTool.length > 0);
  ok('it hands the chunk loop to buyInChunks', /await buyInChunks\(\{/.test(shopTool));
  ok('on a keeper it counts proxied.client after a fresh /state, never the starting literal',
     /_refreshState\(\{ fresh: true \}\)/.test(shopTool) && /const cur = st \? proxied\.client : null/.test(shopTool));
  ok('the old frozen-picture counter is gone', !/const countOwn = async/.test(shopTool));
  ok('it reports what was received per item, and the shortfall',
     /received: run\.received/.test(shopTool) && /shortfall/.test(shopTool));
  ok('it records the shop it opened for the merchant lookup', /recordShopSeen\(/.test(shopTool));
  const j = broker.indexOf("name: 'merchants',");
  const merch = j === -1 ? '' : broker.slice(j, j + 9000);
  ok('merchants {show} looks up by name through findMerchants', /findMerchants\(all, a\.show\)/.test(merch));
  ok('merchants {here} maps each live object by its own name', /merchantForObject\(inRoom, live\)/.test(merch) &&
     !/\|\| inRoom\[0\]/.test(merch));
  ok('merchants consults the shops seen live', /withShopsSeen\(merchantCatalogue\.merchants/.test(merch));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
