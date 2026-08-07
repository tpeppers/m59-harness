#!/usr/bin/env node
// FEED THE CHARACTERS THAT CANNOT FEED THEMSELVES.
//
//   node tools/m59-feed.mjs --dry-run        # who needs it and where they would go
//   node tools/m59-feed.mjs                  # do it
//   node tools/m59-feed.mjs --agents t18,t19
//   node tools/m59-feed.mjs --want 6         # how many meals to come away with
//
// WHY THIS EXISTS, AND WHY EVERY OTHER ROUTE FAILED.
//
// Resting stops awarding vigor at 80 of 200, so everything above that has to be EATEN.
// A character at 80 fights badly, earns little, and therefore cannot buy the food that
// would fix it — the loop closes on itself and nothing inside the wilderness opens it.
// Twelve of twenty-one sat in it all night.
//
// Handing them food from a richer character was tried five ways and failed five ways:
// the trade API wants a character name rather than an agent id; the receiver's keeper
// cancels the exchange by acting; a half-finished trade swallows the goods so the next
// delivery finds an empty pack; the donor arrives to find the recipient has walked off;
// and `supply` would not travel at all until it was made to. Each of those is now
// fixed, and the approach is still wrong, because it needs two characters to be in one
// place at one time and this fleet is never still.
//
// THE CHARACTER DOES NOT NEED A DONOR. It needs a shop. Innkeepers sell bread and buy
// anything (buys_anything in the merchant table), so one trip both funds itself and
// spends the money: sell the mushrooms and pelts nobody wants, buy the loaf. No second
// character, no meeting, no trade protocol.
//
// The keeper is stopped for the errand and restored on EVERY path out, including a
// throw — the same invariant deploy() and outfitPair() needed, learned the same way,
// which is by finding characters standing in towns with nothing driving them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// foodValue knows what a name is actually worth — and, just as importantly, that plain,
// blue, red and purple mushrooms are not food. isFood agrees; the fleet's pack contents
// did not.
import { foodValue as items_foodValue } from './m59-items.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const ONLY = arg('agents', null);
const WANT = Number(arg('want', 6));
// Below this a character is worth a trip. Above it, resting and the odd loaf keep up.
const HUNGRY_BELOW = Number(arg('below', 150));
// How many times to re-ask travel for one shop. Four was the observed cost of a five-hop
// walk; eight leaves room for a worse one without walking for ever.
const TRAVEL_TRIES = Number(arg('travel-tries', 8));

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ITEMS = (() => {
  try {
    return JSON.parse(readFileSync(
      fileURLToPath(new URL('../substrate/m59-items.json', import.meta.url)), 'utf8'));
  } catch { return null; }
})();
const foodValue = (n) => ITEMS?.food?.[String(n || '').trim().toLowerCase()] || null;
const isFood = (n) => !!foodValue(n);
const vigorOf = (n) => foodValue(n)?.nutrition ?? 0;

// Never sell these. Money, the reagents the creation spells need, and anything being
// worn — sell_all's own keep list covers equipment, but naming the reagents matters
// because they are the OTHER route to food.
//
// GEMS USED TO BE ON THIS LIST AND ARE NOT ANY MORE. They were held back as "worth more
// than the trip", which had it backwards: a gem is worth more than the trip precisely
// because a merchant will pay for it, and holding it back is what stopped that from
// ever happening. Nothing else in the fleet turns a gem into anything — they are not
// eaten, not worn, not swung — so the effect was a one-way ratchet. Fozzie was carrying
// fifty-six sapphires and thirty-six emeralds and could not buy an apple.
//
// A gem IS a reagent, and an unremarkable one: emerald is used by twelve spells,
// sapphire by eight, ruby by seven, diamond by five — against elderberry's fifteen and
// twelve for herbs. There is no reason to call them out that would not also apply to
// mushrooms, orc teeth and fairy wings, none of which are named here either. What the
// fleet actually casts is `create food`, which needs elderberry and herbs, and those
// two are the ones on the list. Everything else goes to the counter with the rest of
// the loot, and what a crewmate is short of is held back by sell_all's own interest
// board rather than by a name typed in here.
const KEEP = ['shilling', 'elderberry', 'herb',
              'armor', 'armour', 'shield', 'helm', 'mace', 'sword', 'axe', 'hammer'];

const purseOf = items => (items || []).filter(i => /shilling/i.test(i.name))
                                      .reduce((t, i) => t + (i.amount || 1), 0);
const foodIn = items => (items || []).filter(i => isFood(i.name))
                                     .reduce((t, i) => t + (i.amount || 1), 0);
// What the pack is worth in vigor, which is the number that actually matters. Six water
// skins and six wheels of cheese are both "6 meals" and are 18 vigor against 180.
const vigorIn = items => (items || []).filter(i => isFood(i.name))
                                      .reduce((t, i) => t + vigorOf(i.name) * (i.amount || 1), 0);

// Rooms with someone who sells food, nearest first. Asked per character because
// "nearest" is a property of where it is standing.
async function foodShopsFor(agent) {
  const seen = new Map();
  // The catalogue has no "food" category — the items are called bread, apple, pie. So
  // ask for the things themselves, which is also how this was missed for so long.
  for (const what of ['bread', 'apple', 'meat pie', 'cheese']) {
    const m = await call('merchants', { agent, sells: what }).catch(() => ({ matches: [] }));
    for (const x of m.matches || []) if (x.room != null) seen.set(x.room, x);
  }
  const priced = [];
  for (const m of seen.values()) {
    const rt = await call('map', { agent, to: m.room }).catch(() => null);
    if (rt?.route?.found) priced.push({ room: m.room, hops: rt.route.hops.length });
  }
  return priced.sort((a, b) => a.hops - b.hops).map(p => p.room);
}

// FIND SOMEONE WHO CAN LEND IT THE PRICE OF A MEAL.
//
// Selling only works for a character that still has something to sell, and the ones that
// need this most have been stripped by repeated deaths — Gonzo, Rizzo and Lew were
// carrying nothing but their weapon. The fleet is not poor, though: three characters were
// holding 3,259 shillings between them while ten had none. It is a distribution problem.
//
// Nearest by ROUTE, not by room number, because the donor has to walk it. supply() holds
// both keepers, travels, and verifies the money arrived in the receiver's pack.
const DONOR_RESERVE = Number(arg('donor-reserve', 200));
// The price of one apple. Below this a loan cannot buy anything, so it is not worth a walk.
const MIN_WORTH_LENDING = Number(arg('min-loan', 60));
async function fundFrom(row, need) {
  const f = await call('fleet', {}).catch(() => null);
  if (!f) return null;
  const donors = [];
  for (const c of f.fleet || []) {
    if (c.agent === row.agent) continue;
    const inv = await call('inventory', { agent: c.agent }).catch(() => ({ items: [] }));
    const sh = (inv.items || []).find(i => /shilling/i.test(i.name));
    // Leave the donor something, but do not price the loan out of existence. The reserve
    // was 400 against a 600 loan, which asks for a donor holding a thousand — the whole
    // fleet's richest character had 904, so nothing qualified and every destitute
    // character stayed destitute while the fleet sat on 4,473 shillings. A donor at high
    // vigor with loot in its pack can rebuild a small reserve; a character at zero and
    // vigor 80 cannot rebuild anything.
    // LEND WHAT THERE IS, NOT ONLY THE FULL AMOUNT.
    //
    // This required a donor holding the whole loan plus the reserve, and refused
    // otherwise. The fleet is now poor enough that nothing qualifies: total wealth is
    // about 910 shillings across twenty-one characters, the richest holds 416, and a
    // 500-shilling ask therefore found nobody. Four characters walked to a counter, stood
    // there with nothing, and came home hungry — which is the worst of both, the walk
    // spent and no food bought.
    //
    // An apple is 45 shillings and ten vigor. Half a loan buys half the vigor, and half
    // the vigor is the difference between the resting cap and clear of it. So take the
    // best offer available above the price of a single meal.
    const spare = (sh?.amount || 0) - DONOR_RESERVE;
    if (spare >= MIN_WORTH_LENDING)
      donors.push({ agent: c.agent, name: c.character, id: sh.id, sh: sh.amount,
                    canLend: Math.min(need, spare), room: c.room_num });
  }
  if (!donors.length) return null;
  const routed = [];
  for (const d of donors) {
    if (d.room === row.room_num) { routed.push({ ...d, hops: 0 }); continue; }
    const m = await call('map', { agent: d.agent, to: row.room_num }).catch(() => null);
    if (m?.route?.found) routed.push({ ...d, hops: m.route.hops.length });
  }
  if (!routed.length) return null;
  // Nearest first, but prefer one that can cover the whole ask when the walk is similar.
  routed.sort((a, b) => a.hops - b.hops || b.canLend - a.canLend);
  const d = routed[0];
  // Lend the price of several meals, not the whole purse. The donor is earning and
  // needs to keep eating; taking everything just moves the destitution along the line.
  // HERE THE LENDER WALKS, AND THAT IS THE OPPOSITE OF THE RULE IN m59-rearm.mjs.
  //
  // Both rules are right for their own errand. A reagent transfer sends the RECIPIENT,
  // because the donor is usually holding a safe spot and walking it out is how the fleet
  // loses its capital. A shop trip is the reverse: the borrower is STANDING AT A COUNTER
  // it just walked to, and the merchant it is about to buy from is in that room. Send the
  // borrower away to collect the loan and it comes back — or rather does not — to a buy
  // aimed at a seller in a room it has left, and Buy (monster.kod:3690) refuses a distant
  // buyer with a silent FALSE.
  //
  // That is why the fleet still could not buy after both the quantity fix and the
  // room-agreement check: the errand was walking the character off the spot it had just
  // verified. Three characters in a row, each funded, each reporting "the server said
  // NOTHING AT ALL" from a shop they were no longer in.
  const r = await call('supply', { from: d.agent, to: row.agent,
                                   what: [{ id: d.id, amount: d.canLend }], who_travels: 'from' })
                  .catch(e => ({ supplied: false, reason: e.message }));
  return r?.supplied
    ? `${d.name} (${d.hops} hops, ${d.canLend}sh of ${d.sh}` +
      `${d.canLend < need ? `, all it could spare — ${need} was wanted` : ''})`
    : null;
}

async function feed(row) {
  const who = row.character || row.agent;
  const was = await call('autopilot', { agent: row.agent, action: 'status' }).catch(() => null);
  if (DRY) {
    const shops = await foodShopsFor(row.agent);
    return `${who}: vigor ${row.vigor}, would go to ${shops.length ? `room ${shops[0]}` : 'NOWHERE — no reachable food shop'}`;
  }
  await call('autopilot', { agent: row.agent, action: 'stop' }).catch(() => {});
  try {
    const shops = await foodShopsFor(row.agent);
    if (!shops.length) return `${who}: no reachable food shop`;

    // TRAVEL IS RESUMABLE, SO KEEP ASKING — AND JUDGE IT ON WHETHER THE ROOM CHANGED.
    //
    // Three attempts per shop across three shops sounds like nine chances and is not: a
    // walk that stops halfway has made progress, and starting again on a different shop
    // throws that progress away. Clifford took FOUR attempts to reach room 103, moving
    // 552 -> 544 -> 554 -> 574 -> 574 -> 103, and every one of the first three returned
    // arrived:false while getting closer. On three tries it would have been abandoned as
    // unreachable, which is exactly what "could not reach a food shop (tried 52, 151,
    // 103)" meant after an hour of trying.
    //
    // Rooms are not adjacent in the way the map suggests — an edge you can route through
    // is not an edge you can necessarily step through from the square the router picked
    // — so a failed hop is normal and the honest test is movement, not success. Give up
    // on a shop only when two attempts running leave the character in the same room.
    const whereNow = async () => {
      const st = await call('status', { agent: row.agent, brief: true }).catch(() => null);
      return st?.where?.num ?? null;
    };
    // AN EMPTY COUNTER IS A REASON TO WALK ON, NOT A REASON TO STOP.
    //
    // `merchants` answers what a shop SELLS; stock is a live thing that runs out and is
    // restocked on the server's own schedule. So the catalogue can send a character five
    // hops to The Bhrama & Falcon and have it arrive at a counter holding nothing —
    // which happened to Sweetums at room 103 (0 items) and Gonzo at 202 (5 items, none
    // of them food) in the same run. Both walked, both gave up, both came home hungry.
    //
    // The shop candidates are already ranked by route, so the next one is the next
    // cheapest thing to try. Arriving at an empty counter now costs the walk, not the
    // errand.
    let arrived = false, tried = [], why = [];
    let seller = null;
    for (const room of shops.slice(0, 4)) {
      let got = false, stuck = 0, was = await whereNow();
      for (let i = 0; i < TRAVEL_TRIES && !got && stuck < 2; i++) {
        const t = await call('travel', { agent: row.agent, to: room, max_hops: 20 })
                        .catch(e => ({ arrived: false, why: e.message }));
        const now = await whereNow();
        if (t.arrived || now === room) { got = true; break; }
        if (now === was) stuck++; else { stuck = 0; was = now; }
        await sleep(1200);
      }
      if (!got) { tried.push(room); why.push(`${room}: could not get there`); continue; }

      // ASK TWICE BEFORE DECIDING A SHOP IS EMPTY OF PEOPLE.
      //
      // Room contents arrive after the move, not with it, so a `look` taken the instant a
      // walk finishes can answer about the room just left — or about nothing at all. That
      // is how this reported "103: nobody here trades" about The Bhrama & Falcon while
      // Meidei was standing in it offering bread, meat pie and cheese, and sent the
      // character away from the one shop that was going to work.
      // AND CHECK THE LOOK IS ABOUT THE ROOM WE ARE STANDING IN.
      //
      // This is the whole reason the fleet could never buy anything. `look` answers from
      // a room picture that lags the character, so it happily names a merchant from a
      // room already left — and `Buy` (monster.kod:3690) rejects a buyer whose owner is
      // not the seller's room with a Debug() line and a silent FALSE. No message, no
      // purchase, nothing to diagnose from.
      //
      // Proved by holding a keeper and checking the rooms agree before trading: Waldorf
      // sold a mushroom for 32 and then BOUGHT, purse 154 -> 84, at the same counter that
      // had been silently refusing the fleet for its entire recorded history.
      let here = null;
      for (let look = 0; look < 4 && !here; look++) {
        if (look) await sleep(1500);
        const whoWhere = await call('status', { agent: row.agent, brief: true }).catch(() => null);
        const seen = await call('look', { agent: row.agent }).catch(() => ({ objects: [] }));
        if (seen.room?.num == null || seen.room.num !== whoWhere?.where?.num) continue;
        here = (seen.objects || []).find(o => (o.can || []).includes('buy'));
      }
      if (!here) { tried.push(room); why.push(`${room}: nobody here trades (asked three times)`); continue; }
      // Ask what is ON THE SHELF, not what the catalogue believes.
      const peek = await call('shop', { agent: row.agent, seller: here.id }).catch(() => null);
      const stocked = (peek?.items || []).some(i => isFood(i.name) && (i.cost ?? 0) > 0);
      if (!stocked) {
        tried.push(room);
        why.push(`${room}: counter has ${(peek?.items || []).length} item(s), no food on the shelf`);
        continue;
      }
      arrived = room; seller = here; break;
    }
    if (!arrived) return `${who}: no food to be had — ${why.join('; ')}`;

    // FUND IT FROM THE PACK. This is the whole trick: the character is broke because it
    // cannot fight, and it is carrying loot it cannot eat. One counter solves both.
    let inv = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    const before = purseOf(inv);
    if (before < 200) {
      await call('sell_all', { agent: row.agent, merchant: seller.id, keep: KEEP, min_price: 1 })
        .catch(() => null);
      await sleep(800);
      inv = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    }
    let purse = purseOf(inv);
    // Still broke after selling everything it had? Then it had nothing, and no amount of
    // shopping fixes that. Borrow from whoever is nearest and can spare it.
    //
    // BORROW WHAT THE GAP COSTS, not a flat sum against a flat trigger. A character
    // holding 200 shillings did not qualify for help and could buy one cheese, so it
    // walked to the shop, closed a fifth of its deficit, and was back at the resting cap
    // an hour later. Cheese runs about 4 shillings a vigor point, which is the rate to
    // budget against; the shop's own prices decide the rest.
    let lender = null;
    const gap = Math.max(0, (row.vigor_target ?? 180) - (row.vigor ?? 0));
    const wantPurse = Math.min(900, Math.max(200, gap * 5));
    if (purse < wantPurse) {
      lender = await fundFrom(row, Math.min(900, wantPurse - purse));
      if (lender) {
        await sleep(1000);
        inv = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
        purse = purseOf(inv);
      }
    }

    // A FAILED SHOP CALL IS NOT AN EMPTY SHOP, and reporting it as one sent me looking
    // at the wrong thing: room 103 plainly sells bread at 108 and apples at 45, and the
    // message said it sold no food.
    // FIND THE MERCHANT AGAIN, IMMEDIATELY BEFORE BUYING.
    //
    // `seller` was found when the character arrived, and everything since — selling,
    // borrowing, walking to a lender — has had time to move it or to move us. Buy
    // (monster.kod:3690) refuses a buyer who is not in the merchant's room and says
    // nothing about it, so a seller id that has gone stale looks exactly like a shop that
    // will not trade.
    //
    // The one purchase that has ever worked in this fleet did a SELL first and the sell
    // succeeded — which is positive proof of standing in the room, not an inference from
    // a cached picture. This is the cheap version of that proof: ask again, now.
    for (let again = 0; again < 3; again++) {
      const whoWhere = await call('status', { agent: row.agent, brief: true }).catch(() => null);
      const seen = await call('look', { agent: row.agent }).catch(() => ({ objects: [] }));
      if (seen.room?.num != null && seen.room.num === whoWhere?.where?.num) {
        const still = (seen.objects || []).find(o => (o.can || []).includes('buy'));
        if (still) { seller = still; break; }
      }
      if (again === 2)
        return `${who}: reached ${arrived} but the merchant is not in the room any more — ` +
               'nothing to buy from';
      await sleep(1500);
    }

    let shop = null, shopErr = null;
    try { shop = await call('shop', { agent: row.agent, seller: seller.id }); }
    catch (e) { shopErr = e.message; }
    if (!shop) return `${who}: could not open the shop at ${arrived} — ${shopErr ?? 'no reply'}`;
    // BUY VIGOR, NOT ITEMS. viNutrition is vigor one-for-one (player.kod:1277), and it
    // ranges from 3 for a water skin to 30 for a cheese. Sorting on price and taking the
    // cheapest — which is what this did — always chose the water skin, so a character
    // sent to close a 100-vigor gap came back with six of them and eighteen vigor, and
    // the errand reported success. Rank on vigor per shilling; money is the constraint,
    // not the stomach, because food keeps in the pack and the stomach drains in a
    // quarter of an hour (FOOD_USE_RATE 12).
    const menu = (shop.items || []).filter(i => isFood(i.name) && (i.cost ?? 0) > 0)
                                   .map(i => ({ ...i, vigor: vigorOf(i.name) }))
                                   .filter(i => i.vigor > 0)
                                   .sort((a, b) => (b.vigor / b.cost) - (a.vigor / a.cost)
                                                || b.vigor - a.vigor);
    if (!menu.length)
      return `${who}: room ${arrived} stocks ${(shop.items || []).length} item(s), none of them food`;

    // How much vigor this character is actually short. WANT survives as a floor for the
    // case where the board did not say.
    const short = Math.max(0, (row.vigor_target ?? 180) - (row.vigor ?? 0));
    const target = Math.max(short, WANT * 10);

    // COUNT WHAT THE PURSE LOST, NOT WHAT WE MEANT TO BUY.
    //
    // This incremented spent/gained/bought on every request whether or not the purchase
    // happened, so the errand reported "bought apple x7, water skin x2 (351sh, +76
    // vigor)" about a character that still had every shilling and no food. Rowlf's meat
    // pie was the same. Two characters were walked to a shop, funded by a lender that
    // gave up its own reserve to do it, and came away with nothing while the log said
    // otherwise — which is worse than failing, because nobody goes back for them.
    //
    // The purse is the receipt. If it did not fall, the purchase did not happen; stop
    // rather than spend the rest of the loop making the same request forty times.
    const purseNow = async () => purseOf((await call('inventory', { agent: row.agent })
                                            .catch(() => ({ items: [] }))).items || []);
    let spent = 0, gained = 0, bought = [], refused = null;
    let held = await purseNow();
    for (let n = 0; n < 40 && gained < target; n++) {
      const pick = menu.find(i => i.cost <= held);
      if (!pick) break;
      // KEEP WHAT THE SERVER SAID. `shop` returns the messages it sent in reply to the
      // buy, and nothing has ever read them — which is why "the counter took nothing" was
      // as far as any diagnosis got. There are ZERO successful purchases in the entire
      // recorded history of this fleet, so whatever it is saying, it has been saying it
      // for days into a void.
      const res = await call('shop', { agent: row.agent, seller: seller.id, buy_ids: [pick.id] })
                        .catch(e => ({ messages: [`the request itself failed: ${e.message}`] }));
      await sleep(700);
      const after = await purseNow();
      if (after >= held) {
        const said = (res?.messages || []).filter(Boolean);
        refused = `the counter took nothing for a ${pick.name} at ${pick.cost}sh — ` +
                  `purse stayed at ${held}. ` +
                  (said.length ? `The server said: ${said.slice(0, 3).map(t => JSON.stringify(t)).join(' | ')}`
                               : 'The server said NOTHING AT ALL, which is its own answer — ' +
                                 'the request is not reaching a merchant that considers itself asked.');
        break;
      }
      spent += held - after; gained += pick.vigor; bought.push(pick.name);
      held = after;
    }
    const after = (await call('inventory', { agent: row.agent }).catch(() => ({ items: [] }))).items || [];
    if (!bought.length && purse < (menu[0]?.cost ?? 0))
      return `${who}: at the counter with ${purse}sh and the cheapest food is ${menu[0].cost}sh — ` +
             'it has nothing left to sell. Selling cannot fund a character that has already ' +
             'lost everything; this one needs a hand-out';
    const tally = [...new Set(bought)].map(n => {
      const c = bought.filter(x => x === n).length;
      return c > 1 ? `${n} x${c}` : n;
    }).join(', ');
    if (refused && !bought.length)
      return `${who}: purse ${before}->${purse}${lender ? ` (funded by ${lender})` : ''} — ${refused}`;
    // `held` is what is left AFTER the buying loop; `purse` was only ever the figure it
    // started shopping with. Reporting the latter as the outcome made a successful
    // purchase read as "purse 500->500", which is the kind of line that has hidden every
    // other failure in this errand.
    return `${who}: purse ${before}->${held}${lender ? ` (funded by ${lender})` : ''}, ` +
           `bought ${bought.length ? tally : 'NOTHING'} (${spent}sh, +${gained} vigor` +
           `${gained < target ? ` of ${target} wanted` : ''}) — ` +
           `pack now holds ${vigorIn(after)} vigor in ${foodIn(after)} item(s)`;
  } finally {
    // The invariant. An errand may never leave a character unattended, whatever went
    // wrong — this file exists partly because three other errands did exactly that.
    if (!DRY) {
      const back = await call('autopilot', {
        agent: row.agent, action: 'start', mode: was?.mode || 'farm',
        hunt: was?.policy?.hunt, assigned_room: was?.policy?.assignedRoom ?? null,
      }).catch(() => null);
      if (!back) console.log(`  ${who}: COULD NOT RESTART ITS KEEPER`);
    }
  }
}

// The fleet read can fail transiently while a session is mid-rejoin — the broker walks
// every session and one of them briefly has no client. Worth one retry rather than
// aborting the whole errand over a race that resolves itself in a second.
let f = null;
for (let i = 0; i < 3 && !f; i++) {
  f = await call('fleet', {}).catch(async (e) => {
    console.log(`  (fleet read failed: ${e.message.slice(0, 60)} — retrying)`);
    await sleep(2500); return null;
  });
}
if (!f) { console.error('could not read the fleet'); process.exit(1); }
const only = ONLY && ONLY !== true ? String(ONLY).split(',').map(s => s.trim()) : null;

// "HAS FOOD" IS A BOOLEAN, AND THE QUESTION IS A QUANTITY.
//
// This selected on `!r.has_food`, which is true the moment a character picks up one
// edible mushroom — five nutrition, against a resting cap of 80 and a target of 200. Nine
// characters sat at exactly 80 for hours holding token food and were skipped by every
// feed run: Floyd's entire larder was three edible mushrooms (15 vigor all told), and
// Janice carried thirty-four blue, red and purple mushrooms, which are not food at all.
// A run over the whole fleet considered two characters and reported success.
//
// So ask what the pack is WORTH. Carrying is not eating, and carrying a trifle is not
// being fed.
const CARRIED_VIGOR_FLOOR = Number(arg('carrying_under', 40));

async function carriedFoodVigor(agent) {
  const inv = await call('inventory', { agent }).catch(() => null);
  const items = inv?.inventory || inv?.items || [];
  let total = 0;
  for (const o of items) {
    const v = items_foodValue(String(o.name || ''));
    if (v?.nutrition > 0) total += v.nutrition * (o.amount > 0 ? o.amount : 1);
  }
  return total;
}

const candidates = (f.fleet || [])
  .filter(r => r.in_game !== false)
  .filter(r => (only ? only.includes(r.agent) : (r.vigor ?? 200) < HUNGRY_BELOW));

// SAY WHAT IS HAPPENING WHILE IT HAPPENS. Weighing a pack is a round trip per character,
// so this stage costs one call each before it can decide anything — and printing only the
// verdict at the end made a working run indistinguishable from a hung one for minutes.
// The old filter was free (a field on the fleet row) and printed its count immediately;
// this is the price of asking a better question, and it should be visible rather than
// silent.
console.log(`weighing the pack of ${candidates.length} character(s) under ${HUNGRY_BELOW} vigor…`);
const rows = [];
for (const r of candidates) {
  if (only) { rows.push(r); continue; }
  const worth = await carriedFoodVigor(r.agent);
  const short = worth < CARRIED_VIGOR_FLOOR;
  console.log(`  ${String(r.character).padEnd(9)} vigor ${String(r.vigor).padStart(3)} — pack holds ` +
              `${String(worth).padStart(3)} vigor of food${short ? '  <- feeding' : '  (enough)'}`);
  if (short) rows.push({ ...r, carried_food_vigor: worth });
}

console.log(`${rows.length} of ${candidates.length} carrying under ${CARRIED_VIGOR_FLOOR} ` +
            `vigor of food${DRY ? ' (dry run)' : ''}`);
for (const row of rows) {
  try { console.log('  ' + await feed(row)); }
  catch (e) { console.log(`  ${row.character || row.agent}: ${e.message}`); }
}
