#!/usr/bin/env node
// TURN THE LOOT NOBODY EATS INTO THE TWO THINGS THAT KEEP VIGOR UP.
//
//   node tools/m59-reagents.mjs --dry-run     who would go where, and with what to sell
//   node tools/m59-reagents.mjs               do it
//   node tools/m59-reagents.mjs --want 20     elderberry to come away with, default 12
//   node tools/m59-reagents.mjs --agents t3,t7
//
// WHY. Vigor is the variable the whole fleet turns on: resting stops paying at 80 of 200
// and everything above that has to be EATEN, so a character at 80 fights badly, earns
// little, and cannot buy its way out. The fleet's own answer is `create food` — 2
// ElderBerry + 2 Herbs a cast — and it had run the stock down to 26 elderberry across
// twenty-one characters with the almoner reporting "nobody has a surplus, the fleet is
// genuinely short". Redistribution cannot fix a shortage.
//
// Meanwhile every character is carrying mushrooms, red mushrooms, blue mushrooms,
// emeralds and sapphires — things the fleet does not eat, wear or swing, and which exist
// only to be sold. That is the trade this errand makes.
//
// I TOLD THE OPERATOR THIS WAS IMPOSSIBLE. Asked where elderberry comes from, I answered
// that no merchant sells it and the fleet could only farm it. That was wrong twice over:
// m59-lore's `sells` matcher compared against a field the merchant file does not have, and
// I repeated its empty result as a finding. Seven shops sell ElderBerry — HazarApothecary
// (1014, 1004), BarloqueApothecary (104), JasperMerchant (373), CornothGrocer (151),
// MarionInnkeeper (202), TosApothecary (53) — and six of them sell Herbs.
//
// The keeper already banks above its threshold, so money flows one way; this spends what
// is IN HAND, which is what selling just produced.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const ONLY = arg('agents', null);
const WANT = Number(arg('want', 12));          // elderberry to come away with
const SHORT_BELOW = Number(arg('below', 6));   // who counts as short

let id = 0;
async function call(name, args = {}, ms = 120_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    const text = j.result?.content?.[0]?.text;
    if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
    if (j.result?.isError) throw new Error(`${name}: ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// NOBODY IS LEFT INERT, INCLUDING WHEN THIS PROCESS IS KILLED.
//
// A `finally` does not run through a hard kill. That is not a hypothetical: this errand
// was run under `timeout 520`, the timeout killed node mid-trip, the finally never
// executed, and a character sat inert — keeper alive and recording, but not moving,
// swinging or trading — until an operator noticed and cleared it by hand. outfitPair
// carries a comment about the identical failure with p.kill(); I reproduced it from the
// other side.
//
// So the set of characters this process has made inert is tracked, and reviving them is
// attached to every way out there is: the normal path, an unhandled throw, and SIGINT /
// SIGTERM. Reviving something already awake is free, so over-reviving costs nothing and
// under-reviving costs a character.
const madeInert = new Set();

async function reviveAll(why) {
  for (const agent of [...madeInert]) {
    try {
      await call('autopilot', { agent, action: 'revive', why }, 30_000);
      madeInert.delete(agent);
    } catch { /* keep trying the rest; a failure here must not stop the others */ }
  }
}

let bailing = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, async () => {
    if (bailing) return;
    bailing = true;
    console.log(`\n${sig} — reviving ${madeInert.size} keeper(s) before exit`);
    await reviveAll(`errand interrupted by ${sig}`);
    process.exit(130);
  });
}
process.on('uncaughtException', async (e) => {
  console.error('uncaught: ' + e.message);
  await reviveAll('errand threw');
  process.exit(1);
});

// NEVER SELL THESE. Money, the two reagents this errand exists to accumulate, and
// anything being worn or swung. Everything else is inventory the fleet cannot use.
//
// Gems are deliberately NOT protected. They are reagents for spells nobody here casts,
// they are not eaten, worn or swung, and holding them back is a one-way ratchet — one
// character was carrying fifty-six sapphires and thirty-six emeralds and could not buy an
// apple. A gem is worth more than the trip precisely because a merchant will pay for it.
const KEEP = ['shilling', 'elderberry', 'herb',
              'armor', 'armour', 'shield', 'helm', 'mace', 'sword', 'axe', 'hammer', 'bow',
              // A signet ring is 1500sh of somebody else's property and the fleet already
              // has a path for returning it to whoever is named on it.
              'signet'];

// FOOD IS NOT JUNK, AND A NAME LIST CANNOT TELL THE DIFFERENCE.
//
// The first version of KEEP was names only, and the dry run showed it would sell Fozzie's
// sixteen apples and eighteen loaves and Rowlf's edible mushrooms — the exact commodity
// this errand exists to buy the ingredients for. Substring matching cannot separate them
// either: "edible mushroom" is food at 5 nutrition and "blue mushroom" is not food at all,
// and both contain "mushroom".
//
// So ask the item table, which knows: anything with nutrition is kept, everything else on
// the mushroom-and-gem pile goes to the counter.
const FOOD = (() => {
  try {
    const j = JSON.parse(readFileSync(
      fileURLToPath(new URL('../substrate/m59-items.json', import.meta.url)), 'utf8'));
    return new Set(Object.values(j.food ?? {}).filter(f => (f.nutrition ?? 0) > 0)
                     .map(f => String(f.name).toLowerCase()));
  } catch { return new Set(); }
})();
const isFood = (name) => FOOD.has(String(name || '').trim().toLowerCase());

const norm = s => String(s || '').toLowerCase();
const countOf = (items, re) => (items || []).filter(i => re.test(norm(i.name)))
                                            .reduce((t, i) => t + (i.amount || 1), 0);
const purseOf = items => countOf(items, /shilling/);

// Rooms with a counter that sells ElderBerry, nearest by ROUTE. Asked per character
// because "nearest" is a fact about where it is standing, not about the map.
async function reagentShopsFor(agent) {
  const seen = new Map();
  for (const what of ['elderberry', 'herb']) {
    const m = await call('merchants', { agent, sells: what }, 60_000).catch(() => ({ matches: [] }));
    for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
  }
  const priced = [];
  for (const room of seen.keys()) {
    const rt = await call('map', { agent, to: room }, 60_000).catch(() => null);
    if (rt?.route?.found) priced.push({ room, hops: rt.route.hops.length });
  }
  return priced.sort((a, b) => a.hops - b.hops).map(p => p.room);
}

async function stockUp(row) {
  const who = row.character || row.agent;
  const inv0 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
  const eb0 = countOf(inv0.items, /elder/);
  const purse0 = purseOf(inv0.items);
  const sellable = (inv0.items || [])
    .filter(i => !isFood(i.name))
    .filter(i => !KEEP.some(k => norm(i.name).includes(k)));

  if (DRY) {
    const shops = await reagentShopsFor(row.agent);
    return `${who}: ${eb0} elderberry, ${purse0}sh, ${sellable.length} sellable ` +
           `(${sellable.slice(0, 4).map(i => i.name + (i.amount > 1 ? ` x${i.amount}` : '')).join(', ')})` +
           ` -> ${shops.length ? `room ${shops[0]}` : 'NO REACHABLE APOTHECARY'}`;
  }

  const shops = await reagentShopsFor(row.agent);
  if (!shops.length) return `${who}: no reachable shop that sells reagents`;

  // The keeper is stopped for the errand and restored on EVERY path out, including a
  // throw — the invariant deploy(), outfitPair() and feed() all needed and each learned
  // the same way, by finding characters standing in towns with nothing driving them.
  // INERT, NOT STOPPED. A stopped keeper is a character held still in whatever was
  // happening to it, and the uptime ledger charges any death in that window to the
  // strategy unless somebody writes down that it was deliberate. Inert is the state built
  // for exactly this: the keeper keeps looking and keeps recording — frames, observations,
  // the death record — and stops moving, swinging, speaking and trading, because something
  // else is driving. It is recorded as its own event, so this errand cannot pollute the
  // "died with nothing driving it" number the way stop/start does.
  //
  // It also means there is no policy to rebuild on the way out: revive puts back what was
  // already there, rather than me reconstructing assigned_room and hunt from a status read
  // and hoping I got the field names right.
  await call('autopilot', { agent: row.agent, action: 'inert',
                            why: 'reagent trip: selling junk to buy elderberry and herbs' })
              .catch(() => {});
  madeInert.add(row.agent);          // so every exit path can put it back
  try {
    const where = async () => {
      const st = await call('status', { agent: row.agent, brief: true }, 60_000).catch(() => null);
      return st?.where?.num ?? st?.room?.id ?? null;
    };
    let arrived = null;
    for (const room of shops.slice(0, 3)) {
      let at = await where(), stuck = 0;
      // Travel is resumable and a failed hop is normal here — judge it on whether the
      // room CHANGED, not on whether the call said it arrived.
      for (let i = 0; i < 8 && at !== room && stuck < 2; i++) {
        await call('travel', { agent: row.agent, to: room, max_hops: 20 }).catch(() => ({}));
        const now = await where();
        if (now === room) { at = now; break; }
        if (now === at) stuck++; else { stuck = 0; at = now; }
        await sleep(1200);
      }
      if (at === room) { arrived = room; break; }
    }
    if (arrived == null) return `${who}: could not reach any of ${shops.slice(0, 3).join(', ')}`;

    // FIND THE COUNTER FIRST — SELLING NEEDS TO KNOW WHO TO SELL TO.
    //
    // The first version called sell_all with {agent, keep, min_price} and no merchant.
    // That parameter is REQUIRED, so the call was rejected outright and nothing was sold:
    // Camilla walked to a shop carrying 148 mushrooms and came back with her purse
    // unchanged at 171sh and no elderberry, and the run reported no error I could see
    // because the trip's own output was cut off. A required argument omitted is not a
    // silent no-op — it is a rejection — but from outside it looked exactly like a
    // merchant that would not buy.
    const look = await call('look', { agent: row.agent }, 60_000).catch(() => ({ objects: [] }));
    const seller = (look.objects || []).find(o => (o.can || []).includes('buy'))
                ?? (look.objects || []).find(o => /apothecar|grocer|merchant|innkeep/i.test(o.name || ''));
    if (!seller) return `${who}: reached ${arrived} but found nobody at the counter`;

    // SELL, THEN BUY. The money to buy with is the money the selling just made — these
    // characters have been stripped by repeated deaths and carry almost nothing.
    let sold = null;
    if (sellable.length)
      sold = await call('sell_all', { agent: row.agent, merchant: seller.id,
                                      keep: KEEP, min_price: 1 }, 120_000)
                   .catch(e => ({ error: e.message }));

    const inv1 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
    const purse1 = purseOf(inv1.items);

    const stock = await call('shop', { agent: row.agent, seller: seller.id }, 60_000)
                        .catch(e => ({ error: e.message }));
    const offers = (stock?.items || stock?.for_sale || []);
    const wanted = offers.filter(o => /elder|herb/i.test(o.name || ''));
    if (!wanted.length)
      return `${who}: ${arrived} sells no elderberry or herbs after all (had ${purse1}sh)`;

    // Buy elderberry first — it is the scarce half of the recipe and the one the fleet
    // runs out of. Herbs are usually abundant and cheap.
    wanted.sort((a, b) => (/elder/i.test(a.name) ? 0 : 1) - (/elder/i.test(b.name) ? 0 : 1));
    const buyIds = [];
    const need = Math.max(0, WANT - eb0);
    for (let i = 0; i < need && i < 40; i++) for (const o of wanted) buyIds.push(o.id);
    const bought = await call('shop', { agent: row.agent, seller: seller.id, buy_ids: buyIds.slice(0, 60) },
                              180_000).catch(e => ({ error: e.message }));

    const inv2 = await call('inventory', { agent: row.agent }, 60_000).catch(() => ({ items: [] }));
    const eb2 = countOf(inv2.items, /elder/);
    const hb2 = countOf(inv2.items, /herb/);
    const purse2 = purseOf(inv2.items);
    // REPORT WHAT THE PURSE DID, not what the buy was asked to do. A purchase that does
    // not register is silent — the counter simply takes nothing — so the money is the
    // only honest witness.
    return `${who}: at ${arrived}, sold ${sellable.length} kind(s) ` +
           `(${purse0} -> ${purse1}sh), spent ${purse1 - purse2}sh, ` +
           `elderberry ${eb0} -> ${eb2}, herbs now ${hb2}` +
           (bought?.error ? ` [buy said: ${String(bought.error).slice(0, 50)}]` : '');
  } finally {
    // The same invariant every errand in this repo needed and each learned by finding
    // characters standing in towns with nothing driving them: whoever this stopped is
    // driving again before we return, on every path out including a throw.
    const ok = await call('autopilot', { agent: row.agent, action: 'revive',
                                         why: 'reagent trip finished' })
                     .then(() => true).catch(() => false);
    if (ok) madeInert.delete(row.agent);
    else console.log(`  ${who}: COULD NOT REVIVE ITS KEEPER after the reagent trip`);
  }
}

// ---------------------------------------------------------------- main

const f = await call('fleet', {}, 120_000).catch(() => null);
if (!f?.fleet) { console.error('could not read the fleet'); process.exit(1); }
const only = ONLY && ONLY !== true ? String(ONLY).split(',').map(s => s.trim()) : null;

const candidates = [];
for (const r of f.fleet.filter(x => x.character && x.room_num != null)) {
  if (only && !only.includes(r.agent)) continue;
  const eb = r.reagents?.elderberry ?? 0;
  if (!only && eb >= SHORT_BELOW) continue;
  candidates.push(r);
}

console.log(`${candidates.length} character(s) under ${SHORT_BELOW} elderberry` +
            `${DRY ? ' (dry run)' : ''}`);
for (const row of candidates) {
  try { console.log('  ' + await stockUp(row)); }
  catch (e) { console.log(`  ${row.character || row.agent}: ${e.message.slice(0, 90)}`); }
}

// The belt to the signal handlers' braces: whatever happened above, nothing this process
// made inert is still inert when it returns.
await reviveAll('errand finished');
if (madeInert.size) console.log(`WARNING: ${madeInert.size} keeper(s) could not be revived — ` +
  `run: node tools/m59-reagents.mjs --revive-only`);
