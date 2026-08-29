#!/usr/bin/env node
// CAN A KEEPER-BACKED CHARACTER OPEN A SHOP?
//
//   node tools/m59-shop-test.mjs
//
// Offline. Reads source; opens no socket, starts no broker.
//
// WHY THIS FILE EXISTS. Every character in this fleet is keeper-backed, and for all of them
// `shop` died on its first line:
//
//     shop -> error: c.find is not a function
//
// `resolveTarget` turns a name into an id with `c.find(name)`, and on a keeper-backed
// session `c` is KeeperProxy's emulated client — rebuilt from a /state snapshot, "a picture,
// not a wire". It had no `find`. Measured 2026-08-29: two characters were walked across the
// map on a resupply run to a shop that could not be opened when they arrived.
//
// THE FIX IS NOT TO FAKE `buy` ON THE PICTURE. KeeperProxy's own note draws the line — reads
// may be answered from the snapshot, mutations go over /action, and "the wire is still only
// ever touched by the process that owns it". So this pins the split:
//
//   * `find` is a READ over room objects the keeper already publishes, and belongs on the
//     emulated client where every name-taking tool can reach it.
//   * `buy` and `buyItems` are WIRE CALLS and belong in the keeper, behind /action.
//   * the purse, weight and bulk arithmetic is pure computation and stays in the tool,
//     because duplicating it into the keeper is how two copies of a rule start disagreeing.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

console.log('the emulated client can turn a name into an id');
{
  ok('it has a find()', /^      find\(needle\) \{/m.test(broker));
  ok('which reads the room objects the keeper publishes',
     /\[\.\.\.this\.room\.objects\.values\(\)\]/.test(broker));
  // The real client matches on substring, case-insensitively, over the room's own names.
  // A stricter emulation would answer "nothing here matches" about things standing in view.
  ok('case-insensitively, by substring, like the real client',
     /String\(needle\)\.toLowerCase\(\)/.test(broker) &&
     /\.toLowerCase\(\)\.includes\(n\)/.test(broker));
}

console.log('\nbut it does NOT fake the wire');
{
  const clientBlock = (() => {
    const i = broker.indexOf('get client() {');
    return i === -1 ? '' : broker.slice(i, i + 22000);
  })();
  ok('the emulated client block was found', clientBlock.length > 0);
  // If these ever appear on the snapshot, a purchase can be reported that never left the
  // building — the exact failure the trade path was fixed for.
  ok('no buy() on the snapshot', !/^\s+buy\(/m.test(clientBlock), 'buy() is being emulated');
  ok('no buyItems() on the snapshot', !/buyItems\s*[:(]/.test(clientBlock));
}

console.log('\nthe wire half lives in the keeper, behind /action');
{
  ok("the keeper has a 'shop' action", /case 'shop': \{/.test(keeper));
  ok('with a list op that opens the shop', /if \(op === 'list'\)/.test(keeper) &&
     /c\.buy\(seller\)/.test(keeper));
  ok('and a buy op that sends the purchase', /if \(op === 'buy'\)/.test(keeper) &&
     /c\.buyItems\(seller, wanted\)/.test(keeper));
  // A BARE ID CARRIES NO QUANTITY. encodeIdList writes it as four plain bytes with no tag
  // nibble, so the server's number_list arrives empty and nothing is bought — silently.
  // That is why the fleet had zero successful purchases while selling always worked.
  ok('and preserves {id, amount} rather than flattening to a bare id',
     /\{ id: Number\(i\.id\), amount: Number\(i\.amount\) \}/.test(
       keeper.slice(keeper.indexOf("case 'shop': {"), keeper.indexOf("case 'shop': {") + 4000)));
  ok('both ops are paced like every other wire call',
     /session\.pacer\.submit\('buy'/.test(keeper));
}

console.log('\nand the proxy forwards rather than pretending');
{
  ok('shopList forwards to the keeper', /async shopList\(sellerId, opts = \{\}\) \{[\s\S]{0,240}?keeperAction\(this\.name, this\._index, 'shop'/.test(broker));
  ok('shopBuy forwards to the keeper', /async shopBuy\(sellerId, items, opts = \{\}\) \{[\s\S]{0,240}?keeperAction\(this\.name, this\._index, 'shop'/.test(broker));
}

console.log('\nthe tool branches on the session, and keeps the arithmetic');
{
  const tool = (() => {
    const i = broker.indexOf("name: 'shop',");
    return i === -1 ? '' : broker.slice(i, i + 22000);
  })();
  ok('the shop tool was found', tool.length > 0);
  ok('it detects a keeper-backed session', /const proxied = s instanceof KeeperProxy \? s : null;/.test(tool));
  ok('and uses the forwarded list', /await proxied\.shopList\(t\.id\)/.test(tool));
  // One chunk per call, not the whole order — see the SHOP_MAX_PER_BUY split below.
  ok('and the forwarded buy, one chunk at a time',
     /await proxied\.shopBuy\(shop\.sellerId, \[line\]\)/.test(tool));
  // The clamping is the part that must NOT be duplicated into the keeper: three ceilings
  // (purse, weight, bulk) that all look alike from outside when a buy comes back empty.
  // The keeper DOES call carryCapacity — once, to publish `carry` in /state, which is the
  // single number the tool then reads back through the snapshot. That is the right
  // arrangement and not a duplicate. What must not be duplicated is the DECISION: the
  // cutting of each line against purse, weight and bulk, and the `clamped` report that
  // says what was cut. Three ceilings that all look alike from outside when a buy comes
  // back empty, so there must be exactly one place that distinguishes them.
  const keeperShop = (() => {
    const i = keeper.indexOf("case 'shop': {");
    return i === -1 ? '' : keeper.slice(i, i + 4000);
  })();
  ok('the tool does the clamping', /carryCapacity\(c\)/.test(tool) && /clamped/.test(tool));
  ok('and the keeper does none of it',
     !/clamped/.test(keeperShop) && !/carryCapacity/.test(keeperShop),
     'the clamping rule has grown a second home in the keeper');
  // WHAT ARRIVED IS NOT WHAT WAS ASKED FOR, and a purchase must never report the order back
  // as the outcome. Measured 2026-08-29 with a penniless character: a buy of 4 herbs came
  // back `bought: [{id:521, amount:4}]` and moved nothing, because a merchant that refuses
  // says so in a sentence to the room — or says nothing — and the packet succeeds either way.
  ok('the keeper reports `got` (what arrived) separately from `asked`',
     /got: evs\.filter\(e => e\.kind === 'got'\)/.test(keeper) && /asked: wanted/.test(keeper));
  // `bought` IS `got`, not the order. They were the same field once and that is precisely
  // how an empty purchase read as a full one.
  ok('and the tool reports an empty purchase as empty',
     /bought: got,/.test(tool) && /asked: wanted, got, bought: got,/.test(tool));
  ok('and says which kind of silence it was',
     /nothing arrived — the merchant said so/.test(tool) &&
     /nothing arrived and nothing was said/.test(tool));

  // AN OFFER'S `amount` IS A SUGGESTED QUANTITY, NOT STOCK. Every apothecary lists
  // "Herbs x4" and none of them runs out. Read as stock it says the fleet can never buy
  // more than four herbs from anyone — which is exactly the conclusion drawn on 2026-08-29,
  // over the fleet's own loot log showing characters carrying seventy at a time.
  ok('the clamping never treats the offered amount as stock',
     !/o\?\.amount|offer.*\.amount\s*<|limits\.push\('stock'\)/.test(tool),
     'a stock ceiling has crept into the clamping');
  ok('and the three real ceilings are the only ones', /limited_by: limits/.test(tool) &&
     /limits\.push\('purse'\)/.test(tool) && /limits\.push\('weight'\)/.test(tool) &&
     /limits\.push\('bulk'\)/.test(tool));

  // What IS real is the per-transaction ceiling. An oversized line is not refused — it goes
  // out and buys nothing, the same silence a malformed id list produces.
  ok('a large order is split into chunks', /Math\.min\(left, SHOP_MAX_PER_BUY\)/.test(tool));
  ok('the cap is a named, overridable constant',
     /const SHOP_MAX_PER_BUY = Number\(process\.env\.M59_SHOP_MAX_PER_BUY \|\| 50\);/.test(broker));
  // Hammering a counter that has already said no is how a town trip runs for ever.
  ok('and it stops at the first chunk that brings nothing',
     /if \(!arrived\.length\) \{/.test(tool) && /brought nothing/.test(tool));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
