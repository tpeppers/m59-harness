#!/usr/bin/env node
// WHAT THE FLEET IS WORTH, AND WHETHER THAT NUMBER IS MOVING.
//
//   node tools/m59-economy.mjs              every character: purse, bank, reagents
//   node tools/m59-economy.mjs --json       the same, as JSON
//   node tools/m59-economy.mjs --hours 72   a longer window for the trend
//
// WHY THIS IS ONE PAGE AND NOT THREE COLUMNS SOMEWHERE.
//
// The fleet's whole supply loop is a chain of conversions, and it only has to break in
// one place to stop the thing this fleet exists for:
//
//   loot  ->  shillings  ->  elderberry + herbs  ->  `create food`  ->  vigor  ->  kills
//
// Vigor is the binding constraint. Resting stops paying at 80 of 200 and everything
// above that has to be EATEN, so a character at 80 fights badly and earns little. The
// fleet's answer is to make its own meals — 2 ElderBerry and 2 Herbs a cast — which
// means an empty purse becomes an empty pack becomes a fleet fighting at 40% vigor,
// several hours later and with nothing in between that looks like a failure. `create
// food` REFUSES SILENTLY without its reagents; the keeper journals a cast that produced
// nothing and carries on.
//
// So the three quantities belong on one page: they are the same number at three stages
// of the same conversion.
//
// THE THREE HAVE THREE DIFFERENT KINDS OF EVIDENCE BEHIND THEM, AND THE PAGE HAS TO SAY
// WHICH. This is the same discipline the postmortems needed and for the same reason — a
// figure whose provenance is invisible gets read as fact.
//
//   BANKED     prose from an NPC's mouth, written down when it went past
//              (substrate/banks/, see m59-bank.mjs). It does not decay, but it also does
//              not update while the character is out in the woods, so it carries an age.
//              Null means NOBODY HAS SEEN THIS CHARACTER AT A COUNTER — not zero.
//   PURSE      the inventory, right now. No other record exists: a purse is not
//              announced, and until the ledger started sampling it there was nothing to
//              read but a live `inventory` call per character.
//   REAGENTS   the inventory too — with a fallback, because the fleet was casting for
//              months before the sample carried the count. Every `cast` and
//              `cast_declined` event in the ledger already states the caster's stock at
//              the moment it tried (`reagents_before` / `have_reagents`), so a character
//              with no sample yet still has an honest, timestamped reading. It is marked
//              `cast` rather than `sample` and it is older; both facts are on the row.
//
// A LIVE ROW BEATS ALL OF IT. When the broker renders this page it has the real
// inventory in hand, so it passes the fleet rows in and they win — the record is what
// answers when nothing is running.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from './m59-ledger.mjs';
import { lastTownIncome } from './m59-town-income.mjs';
import { foodValue } from './m59-items.mjs';
import { listCharacters as bankedCharacters, balancesFor, accountRegion } from './m59-bank.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const NEED_PER_CAST = 2;          // create food: 2 ElderBerry + 2 Herbs, from the caster
export const CASTS_FROM = (r) => Math.min(Math.floor((r.elderberry ?? 0) / NEED_PER_CAST),
                                          Math.floor((r.herbs ?? 0) / NEED_PER_CAST));

// Below this a character cannot cast its way out of an empty larder, which is the state
// the whole loop exists to prevent. Three castings, the same figure restockReagents buys
// towards.
export const SHORT_BELOW = Number(process.env.M59_REAGENTS_SHORT || 6);

const newer = (a, b) => (a?.at ?? -1) >= (b?.at ?? -1) ? a : b;

// ------------------------------------------------------------------ the readings

// Newest non-null reading of a field per character, and when it was taken. A sample of a
// character that is not in game has every field null — that is honest rather than
// informative, and must not overwrite the last real reading.
function fromSamples(samples) {
  const purse = new Map(), reagents = new Map();
  for (const s of samples) {
    if (!s.character) continue;
    if (s.purse != null)
      purse.set(s.character, newer({ value: s.purse, at: s.t, from: 'sample' }, purse.get(s.character)));
    if (s.elderberry != null || s.herbs != null)
      reagents.set(s.character, newer({ elderberry: s.elderberry ?? 0, herbs: s.herbs ?? 0,
                                        at: s.t, from: 'sample' }, reagents.get(s.character)));
  }
  return { purse, reagents };
}

// The fallback described in the header: what a caster said it was holding, at the moment
// it tried to cast. `reagents_before` rides on `cast`, `have_reagents` on `cast_declined`.
function fromCasts(events) {
  const out = new Map();
  for (const e of events) {
    if (!e.character) continue;
    const r = e.reagents_before || e.have_reagents;
    if (!r || typeof r !== 'object') continue;
    out.set(e.character, newer({ elderberry: r.elderberry ?? 0, herbs: r.herbs ?? 0,
                                 at: e.t, from: 'cast' }, out.get(e.character)));
  }
  return out;
}

// Live fleet rows, when the broker is the one rendering. Same shape as the readings
// above so the merge below does not care which it got.
function fromLive(live) {
  const purse = new Map(), reagents = new Map(), at = Date.now();
  for (const r of live || []) {
    if (!r?.character) continue;
    if (r.purse != null) purse.set(r.character, { value: r.purse, at, from: 'live' });
    if (r.reagents) reagents.set(r.character, { elderberry: r.reagents.elderberry ?? 0,
                                                herbs: r.reagents.herbs ?? 0, at, from: 'live' });
  }
  return { purse, reagents };
}

// ------------------------------------------------------------------ the two banks
//
// TWO BANKS, TWO ACCOUNTS, AND A CHARACTER CAN HOLD BOTH. Jasper and Tos pay into one account
// (`jasper-tos-barloque`); Ko'catan's Hungry Vaults keep another (`kocatan`), and a deposit on
// one side of the sea cannot be drawn on the other. Summing the two into one "banked" figure is
// the right answer to "what is the fleet worth" and the wrong one to "what can this character
// draw where it is standing", so every row carries the two sides apart and the page chooses.
//
// TWO RECORDS SAY WHAT IS IN THEM. The bank book (substrate/banks/, m59-bank.mjs) is written the
// moment a banker speaks; every `town_trip_completed` row in the ledger carries a copy of that
// book as `cash.accounts`, each account with its own `at` and `observed`. The book is the
// machine's and unwindowed; the ledger copy is this fleet's and survives the book being absent
// (another checkout, a restored machine). Per account the newer reading wins, the book on a tie.
// A legacy row whose cash names no account (`cash.bank`) is skipped: a balance that cannot be
// attributed to a bank would be added to the wrong one.
function fromTrips(events) {
  const out = new Map();                       // character -> Map(account -> reading)
  for (const e of events) {
    if (e.kind !== 'town_trip_completed' || !e.character) continue;
    for (const a of e.cash?.accounts ?? []) {
      if (!a?.account || typeof a.balance !== 'number' || !Number.isFinite(a.balance)) continue;
      const reading = { account: a.account, balance: a.balance,
                        at: Number.isFinite(a.at) ? a.at : null,
                        observed: a.observed ?? null, from: 'trip' };
      const mine = out.get(e.character) ?? (out.set(e.character, new Map()), out.get(e.character));
      const was = mine.get(a.account);
      if (!was || (reading.at ?? -1) > (was.at ?? -1)) mine.set(a.account, reading);
    }
  }
  return out;
}

// One character's accounts from both records, newest per account, newest account first.
function accountsFor(character, trips) {
  const merged = new Map(balancesFor(character).map(b => [b.account,
    { account: b.account, balance: b.balance, at: b.at ?? null, observed: b.observed ?? null,
      from: 'bank' }]));
  for (const [account, t] of trips.get(character) ?? []) {
    const was = merged.get(account);
    if (!was || (t.at ?? -1) > (was.at ?? -1)) merged.set(account, t);
  }
  return [...merged.values()].map(a => ({ ...a, region: accountRegion(a.account) }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// One side of the sea, as a reading: null when no account on that side has ever been read.
// Its age is the age of its STALEST account — a sum is only as fresh as its oldest part.
function side(accounts) {
  if (!accounts.length) return null;
  const ats = accounts.map(a => a.at).filter(Number.isFinite);
  return {
    balance: accounts.reduce((t, a) => t + (a.balance || 0), 0),
    at: ats.length ? Math.min(...ats) : null,
    observed: accounts.every(a => a.observed === true),
  };
}

// ------------------------------------------------------------------ which bank the page shows
//
// The page's toggle, `?view=`. MAINLAND IS THE DEFAULT because it is the page as it was built:
// one bank column, the account Jasper and Tos share. ISLAND is the Ko'catan account alone.
// COMBINED is both, side by side, with their sum — which is what the old single column was
// quietly showing for anybody who had banked on the island.
export const BANK_VIEWS = ['mainland', 'island', 'combined'];
export const normaliseView = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return BANK_VIEWS.includes(s) ? s : 'mainland';
};

// What one view says about each character and about the fleet. `banked` is null — never 0 —
// for a character with no reading on the side(s) the view covers, and the totals say how many
// characters the sum is actually made of.
export function bankView(e, view) {
  view = normaliseView(view);
  const pick = (r) => view === 'mainland'
    ? { banked: r.mainland_banked, at: r.mainland_at, observed: r.mainland_observed }
    : view === 'island'
    ? { banked: r.island_banked, at: r.island_at, observed: r.island_observed }
    : { banked: r.banked, at: r.banked_at, observed: r.banked_observed };
  const rows = e.rows.map(r => ({ character: r.character, ...pick(r),
                                  mainland: r.mainland_banked, island: r.island_banked }));
  const known = rows.filter(r => r.banked != null);
  return {
    view,
    rows,
    totals: {
      banked: known.reduce((t, r) => t + r.banked, 0),
      known: known.length,
      characters: rows.length,
      mainland: e.totals.mainland_banked, mainland_known: e.totals.mainland_known,
      island: e.totals.island_banked, island_known: e.totals.island_known,
    },
  };
}

// ------------------------------------------------------------------ what there is to eat
//
// EVERY MEAL THE FLEET IS CARRYING, BY KIND.
//
// This is the one stock on the page that is not money and not a reagent, and it is the one
// the fleet actually runs out of. Resting stops awarding vigor at 80 of 200; everything above
// that has to be EATEN, so a fleet with no food fights at a fraction of its strength however
// rich it is. "Reagents held" answers what could be COOKED and needs the right pockets;
// this answers what could be eaten right now.
//
// WHAT COUNTS AS FOOD IS NOT THIS FILE'S OPINION. `foodValue` reads the table built from the
// game's own Food class tree, so the answer is right by construction and cannot miss one -
// which matters here more than anywhere, because four of this world's five mushrooms are
// casting reagents and only two are edible. A hand-written list would have got that wrong in
// whichever direction its author happened to be thinking about.
//
// It reads `pack_items`, which the fleet row already carries, so this costs no packet.
// A character whose pack has not been read contributes nothing and is counted as unknown
// rather than as zero: an unread pack and an empty one are different facts, and reporting
// the fleet as starving because nobody looked is the failure this whole page exists to avoid.
// WHAT THE OPERATOR PUT THERE BY HAND, so it cannot be mistaken for what the fleet earned.
//
// substrate/food-baseline.json, gitignored: `{ "<item>": <count> }`. It is this machine's
// answer about this week and nothing about the game, which is exactly the split the rest of
// this repository draws between committed shape and local fact.
//
// IT EXISTS BECAUSE THE OBVIOUS DISCRIMINATOR DOES NOT WORK. "Did it come from the Duke's
// tables" sounds like the right question and answers the wrong one: `platter of raw spider
// eyes` IS one of the hall's seven dispensers (feast-hall.mjs), so an operator walking a
// character in by hand and one driven there by a bot come home carrying the same item from
// the same platter. Only the person who did it knows which, so the person who did it writes
// it down.
//
// The page then reports both halves and never nets them into one number: a total that has
// quietly had 350 subtracted from it is a number nobody can check.
// "all" MEANS EVERY ONE OF THIS KIND, HOWEVER MANY THERE ARE, and it exists because a number
// goes stale the moment the operator picks up one more. It did, within ten minutes: a
// baseline of 362 spider eyes was written and the count was 632 at the next reading, so the
// page reported 270 "earned" that no bot had touched — precisely what the baseline was added
// to prevent. A number is for a haul that has finished; "all" is for one still going.
//
// THE SENTINEL BELONGS TO THE FORMAT, NOT TO THE FILE READER. It lived in `foodBaseline` for
// one commit and a caller passing a baseline object directly — every test, and any future
// board — got `Number('all')`, NaN, and silently no baseline at all. Normalising here means
// there is one definition of what a baseline value may say, wherever it came from.
export function normaliseBaseline(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, n] of Object.entries(raw)) {
    if (String(k).startsWith('//')) continue;       // a comment key, by this repo's convention
    const key = String(k).trim().toLowerCase();
    if (String(n).trim().toLowerCase() === 'all') { out[key] = Infinity; continue; }
    const amount = Number(n);
    if (Number.isFinite(amount) && amount > 0) out[key] = amount;
  }
  return out;
}

export function foodBaseline(file = null) {
  const path = file ?? join(HERE, '..', 'substrate', 'food-baseline.json');
  try {
    if (!existsSync(path)) return {};
    return normaliseBaseline(JSON.parse(readFileSync(path, 'utf8')));
  } catch { return {}; }          // a baseline that will not parse is no baseline, not a crash
}

export function foodHeld(live, { baseline = null } = {}) {
  const byName = new Map();
  let unread = 0, characters = 0;
  for (const r of live || []) {
    if (!r?.character) continue;
    characters++;
    const items = Array.isArray(r.pack_items) ? r.pack_items : null;
    if (!items) { unread++; continue; }
    for (const it of items) {
      const name = String(it?.name ?? '').trim();
      if (!name) continue;
      const food = foodValue(name);
      if (!food) continue;
      const amount = Number(it.amount) || 0;
      if (amount <= 0) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key)
        ?? { name: key, value: 0, nutrition: Number(food.nutrition) || 0, holders: 0 };
      prev.value += amount;
      prev.holders += 1;
      byName.set(key, prev);
    }
  }
  // Split each kind into what the operator declared and what is over and above it. Clamped
  // at zero per kind: a baseline larger than what is carried means some of it has been eaten
  // or lost, which is ordinary, and must not turn into a negative "earned".
  const base = baseline ? normaliseBaseline(baseline) : foodBaseline();
  for (const k of byName.values()) {
    k.baseline = Math.min(k.value, Number(base[k.name]) || 0);
    k.earned = Math.max(0, k.value - k.baseline);
  }
  const kinds = [...byName.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const total = kinds.reduce((n, k) => n + k.value, 0);
  return {
    total,
    // Reported side by side and never netted: a total that has quietly had a number
    // subtracted from it is one nobody can check.
    baseline: kinds.reduce((n, k) => n + (k.baseline || 0), 0),
    earned: kinds.reduce((n, k) => n + (k.earned || 0), 0),
    kinds,
    // The stomach admits 100 at a sitting and drains about 7.2 a minute, so this is not
    // "vigor the fleet has" - it is vigor the fleet could eat its way to, given time.
    nutrition: kinds.reduce((n, k) => n + k.value * k.nutrition, 0),
    characters, unread,
    // Characters holding at least one of anything edible. The number that says whether the
    // food is SPREAD or sitting in one pack, which is the difference between a fed fleet and
    // one character with a larder.
    fed: (live || []).filter(r => Array.isArray(r?.pack_items) &&
      r.pack_items.some(it => Number(it?.amount) > 0 && foodValue(String(it?.name ?? '')))).length,
  };
}

// ------------------------------------------------------------------ the money spent
//
// `bought` events, which carry `item_kind` rather than `kind` — see recordEvent, where a
// detail field called `kind` used to overwrite the event's own and file every purchase as
// something else entirely.
function spending(events) {
  const byKind = new Map(), byCharacter = new Map();
  let total = 0, items = 0;
  for (const e of events) {
    if (e.kind !== 'bought') continue;
    const cost = Number(e.cost) || 0;
    total += cost; items++;
    const k = e.item_kind || 'other';
    const v = byKind.get(k) || { name: k, value: 0, items: 0, children: new Map() };
    v.value += cost; v.items++;
    v.children.set(e.character, (v.children.get(e.character) || 0) + cost);
    byKind.set(k, v);
    byCharacter.set(e.character, (byCharacter.get(e.character) || 0) + cost);
  }
  const declined = events.filter(e => e.kind === 'buy_declined');
  return {
    total, items,
    by_kind: [...byKind.values()].map(v => ({
      name: v.name, value: v.value, items: v.items,
      children: [...v.children].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    })).sort((a, b) => b.value - a.value),
    by_character: [...byCharacter].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    // Why a purchase did NOT happen, which no log of purchases can tell you. The
    // commonest by far is the walking float — a keeper refuses to spend below it.
    declined: Object.entries(declined.reduce((t, e) => {
      const w = e.why || 'unspecified'; t[w] = (t[w] || 0) + 1; return t;
    }, {})).sort((a, b) => b[1] - a[1]).map(([why, times]) => ({ why, times })),
  };
}

// ------------------------------------------------------------------ the trend
//
// Is the fleet getting richer? A stock with no history cannot say, and this is the one
// question the operator actually asks of an economy. Buckets are hourly, and a bucket is
// the LAST sample in it rather than a mean: these are stocks, not rates, and averaging a
// balance across an hour describes nothing that ever existed.
export function series(samples, { buckets = 48 } = {}) {
  if (!samples.length) return [];
  const times = samples.map(s => s.t);
  const from = Math.min(...times), to = Math.max(...times);
  const width = Math.max(60_000, Math.ceil((to - from) / buckets));
  const slots = new Map();
  for (const s of samples) {
    if (!s.character) continue;
    if (s.purse == null && s.elderberry == null && s.herbs == null) continue;
    const b = Math.floor((s.t - from) / width);
    const slot = slots.get(b) || (slots.set(b, new Map()), slots.get(b));
    // Last reading per character in the bucket.
    const was = slot.get(s.character);
    if (!was || s.t >= was.t) slot.set(s.character, s);
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([b, per]) => {
    const rows = [...per.values()];
    return {
      at: from + b * width,
      characters: rows.length,
      purse: rows.reduce((t, s) => t + (s.purse ?? 0), 0),
      elderberry: rows.reduce((t, s) => t + (s.elderberry ?? 0), 0),
      herbs: rows.reduce((t, s) => t + (s.herbs ?? 0), 0),
    };
  });
}

// ------------------------------------------------------------------ the whole picture

// `characters` scopes this to one fleet. The LEDGER is already per-fleet (see
// ledgerDirFor) but `bankedCharacters()` reads `substrate/banks/`, which every fleet on
// this machine writes into — so without this a second fleet's balances would be summed
// into the fleet total. That directory happens to be clean today; the bug is one local
// test server away, and the boards next to this one were already wrong the same way.
export function economy({ sinceMs = 24 * 3600 * 1000, live = null, characters = null } = {}) {
  const { samples, events } = readLedger({ sinceMs });
  const sampled = fromSamples(samples);
  const cast = fromCasts(events);
  const liveRows = fromLive(live);
  const trips = fromTrips(events);

  // Every character anybody has heard of, from any of the five records. A character with
  // a bank balance and no sample this window is still a character with money.
  let names = new Set([
    ...sampled.purse.keys(), ...sampled.reagents.keys(), ...cast.keys(),
    ...liveRows.purse.keys(), ...liveRows.reagents.keys(), ...bankedCharacters(),
    ...trips.keys(),
  ]);
  if (characters) names = new Set([...names].filter(n => characters.has(n)));

  const rows = [...names].map(character => {
    const p = liveRows.purse.get(character) ?? sampled.purse.get(character) ?? null;
    // Live, then the sample, then what a cast said it was holding. Deliberately not
    // "whichever is newest": a cast event can be seconds old and a sample five minutes,
    // and the sample is a reading of the whole pack while the cast is a reading taken by
    // the thing about to spend it.
    const r = liveRows.reagents.get(character) ?? sampled.reagents.get(character)
              ?? cast.get(character) ?? null;
    const accounts = accountsFor(character, trips);
    const bank = accounts[0] ?? null;
    const banked = accounts.reduce((t, a) => t + (a.balance || 0), 0);
    const mainland = side(accounts.filter(a => a.region === 'mainland'));
    const island = side(accounts.filter(a => a.region === 'island'));
    const row = {
      character,
      last_town_trip: lastTownIncome(character),
      purse: p?.value ?? null, purse_at: p?.at ?? null, purse_from: p?.from ?? null,
      elderberry: r?.elderberry ?? null, herbs: r?.herbs ?? null,
      reagents_at: r?.at ?? null, reagents_from: r?.from ?? null,
      // Null, not zero: nobody has seen this one at a counter. Summed across accounts
      // because Ko'catan is a separate bank and a character can hold both — the combined
      // figure. The two sides follow, apart, each with its own age.
      banked: accounts.length ? banked : null,
      banked_at: bank?.at ?? null,
      banked_observed: accounts.length ? accounts.every(a => a.observed) : null,
      // The mainland account (Jasper / Tos) and the island one (Ko'catan's Hungry Vaults).
      // Null on a side means no reading from that side's counter — never a balance of zero.
      mainland_banked: mainland?.balance ?? null, mainland_at: mainland?.at ?? null,
      mainland_observed: mainland?.observed ?? null,
      island_banked: island?.balance ?? null, island_at: island?.at ?? null,
      island_observed: island?.observed ?? null,
      accounts: accounts.map(a => ({ account: a.account, region: a.region, balance: a.balance,
                                     at: a.at, observed: a.observed, from: a.from })),
    };
    // WEALTH IS A SUM AND THE TWO HALVES ARE NOT INTERCHANGEABLE. A purse is what death
    // takes and a balance is what it cannot, so the total is a convenience for sorting
    // and the two columns beside it are the ones to read.
    row.wealth = (row.purse ?? 0) + (row.banked ?? 0);
    row.casts_possible = CASTS_FROM(row);
    row.short = row.reagents_at != null &&
                ((row.elderberry ?? 0) < SHORT_BELOW || (row.herbs ?? 0) < SHORT_BELOW);
    return row;
  }).sort((a, b) => b.wealth - a.wealth);

  const sum = (k) => rows.reduce((t, r) => t + (r[k] ?? 0), 0);
  const known = (k) => rows.filter(r => r[k] != null).length;

  const facet = (value, filter = () => true) => rows.filter(filter)
    .map(r => ({ name: r.character, value: value(r) }))
    .filter(x => x.value > 0)
    .sort((a, b) => b.value - a.value);

  return {
    window_hours: +(sinceMs / 3600000).toFixed(1),
    characters: rows.length,
    totals: {
      purse: sum('purse'), banked: sum('banked'), wealth: sum('wealth'),
      mainland_banked: sum('mainland_banked'), island_banked: sum('island_banked'),
      elderberry: sum('elderberry'), herbs: sum('herbs'),
      casts_possible: sum('casts_possible'),
      // How much of each total is actually backed by a reading, so a total that is small
      // because nobody has looked cannot be read as a fleet that is broke.
      purse_known: known('purse'), banked_known: known('banked'),
      mainland_known: known('mainland_banked'), island_known: known('island_banked'),
      reagents_known: rows.filter(r => r.reagents_at != null).length,
      short: rows.filter(r => r.short).length,
    },
    rows,
    by_wealth: facet(r => r.wealth),
    by_purse: facet(r => r.purse ?? 0),
    by_banked: facet(r => r.banked ?? 0),
    by_island: facet(r => r.island_banked ?? 0),
    by_reagents: facet(r => (r.elderberry ?? 0) + (r.herbs ?? 0)),
    spend: spending(events),
    series: series(samples),
    read_this_way:
      'banked is prose a banker said out loud and never repeats, so it carries an age and ' +
      'null means nobody has taken this character to a counter — not that the account is ' +
      'empty. banked is two accounts: the mainland one Jasper and Tos share, and ' +
      'Ko\'catan\'s, which is separate — money banked on the island cannot be drawn on the ' +
      'mainland or the other way round — so each carries its own age, and the page\'s ' +
      'view toggle picks one or both. purse and reagents are the inventory: live when the broker rendered the ' +
      'page, otherwise the newest ledger sample, otherwise what a caster stated it was ' +
      'holding when it last cast. casts_possible is the number of `create food` this ' +
      'character could cast right now, which is the only thing the reagents are for.',
  };
}

// ---------------------------------------------------------------------- the CLI

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
    .replace(/file:\/\/([A-Za-z]:)/, 'file:///$1');

if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf('--' + n);
                          return i < 0 ? d : (argv[i + 1] ?? true); };
  // Scoped to the fleet the broker is holding, so a second fleet's balances are not summed
  // into this one's total. --all-fleets puts it back. See m59-fleetscope.mjs.
  const { fleetScope, scopeLine } = await import('./m59-fleetscope.mjs');
  const scope = await fleetScope({ argv, allFleets: argv.includes('--all-fleets') });
  const e = economy({ sinceMs: Number(arg('hours', 24)) * 3600 * 1000,
                      characters: scope.characters });
  if (argv.includes('--json')) { console.log(JSON.stringify({ ...e, scope: { fleet: scope.fleet, from: scope.from } }, null, 2)); process.exit(0); }
  console.log(scopeLine(scope));
  console.log();

  const age = (t) => (t ? `${Math.round((Date.now() - t) / 60000)}m` : '—');
  console.log('character     purse  mainland   island  read      elder  herbs  casts  seen');
  for (const r of e.rows)
    console.log(String(r.character).padEnd(13),
                String(r.purse ?? '—').padStart(6),
                String(r.mainland_banked ?? '—').padStart(9),
                String(r.island_banked ?? '—').padStart(8),
                (r.banked == null ? 'never' : r.banked_observed ? 'observed' : 'derived').padEnd(9),
                String(r.elderberry ?? '—').padStart(5),
                String(r.herbs ?? '—').padStart(6),
                String(r.casts_possible).padStart(6) + (r.short ? ' SHORT' : ''),
                ' ' + age(r.reagents_at) + (r.reagents_from === 'cast' ? ' (cast)' : ''));
  const t = e.totals;
  console.log(`\n${t.wealth} shillings in all — ${t.purse} in purses (lost on death), ` +
              `${t.banked} banked (not): ${t.mainland_banked} on the mainland across ` +
              `${t.mainland_known} character(s), ${t.island_banked} in Ko'catan's separate account ` +
              `across ${t.island_known}`);
  console.log(`${t.elderberry} elderberry and ${t.herbs} herbs: ${t.casts_possible} meals' worth, ` +
              `${t.short} character(s) under ${SHORT_BELOW} of something`);
  if (t.purse_known < e.characters)
    console.log(`\n${e.characters - t.purse_known} character(s) have no purse reading in this ` +
                `window. The purse is only sampled while the broker is running this code.`);
}
