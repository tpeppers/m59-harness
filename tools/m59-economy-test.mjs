#!/usr/bin/env node
// THE TWO NEW BOARDS' ARITHMETIC, OFFLINE. No server, no broker, safe any time:
//
//   node tools/m59-economy-test.mjs
//
// Both pages exist because a number with no provenance gets read as fact, and every case
// here is one of the ways that goes wrong:
//
//   * AN OFFLINE SAMPLE IS EVERY FIELD NULL, and it arrives every thirty seconds for a
//     character that is not in game. Letting one overwrite the last real reading would
//     empty the fleet's purse on the board the moment it logged out — and the page would
//     be reporting a fleet that is broke rather than one nobody can see.
//   * A BANK BALANCE OF NULL IS NOT ZERO. Null means nobody has taken this character to a
//     counter. Rendering it as 0 turns "we have not asked" into "it has nothing".
//   * ATROPHY MUST NOT BE NETTED AGAINST ADVANCEMENT. A fleet that gained 40 points and
//     lost 38 is standing still, and one number cannot say so — which matters because on
//     the real fleet the two are within 15% of each other and nothing announces the loss.
//   * POINTS, NOT EVENTS. Three +1s and one +3 are the same progress; counting rows would
//     rank a skill that crawls above one that jumps.
//
// Everything runs against scratch directories via M59_LEDGER_DIR / M59_BANK_DIR /
// M59_ABILITY_DIR, so it never reads or writes a real fleet's record.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-economy-test-'));
const ledgerDir = join(root, 'history');
const bankDir = join(root, 'banks');
const abilityDir = join(root, 'abilities');
for (const d of [ledgerDir, bankDir, abilityDir]) mkdirSync(d, { recursive: true });
process.env.M59_LEDGER_DIR = ledgerDir;
process.env.M59_BANK_DIR = bankDir;
process.env.M59_ABILITY_DIR = abilityDir;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const NOW = Date.now();
const mins = (n) => NOW - n * 60_000;

// The ledger reads at most the last three day files and filters on `t`, so the fixture is
// written into the file for the day each line belongs to.
const lines = [];
const sample = (t, character, fields) =>
  lines.push({ t, type: 'sample', character, ...fields });
const event = (t, character, kind, fields = {}) =>
  lines.push({ t, iso: new Date(t).toISOString(), ...fields, type: 'event', character, kind });

// ---------------------------------------------------------------- the fixture
//
// Kermit: sampled with money and reagents, then goes offline (every field null).
sample(mins(40), 'Kermit', { level: 30, purse: 400, elderberry: 24, herbs: 70 });
sample(mins(20), 'Kermit', { level: 30, purse: 512, elderberry: 20, herbs: 66 });
sample(mins(5), 'Kermit', { level: null, purse: null, elderberry: null, herbs: null,
                            stalled: 'not in game' });
// Gonzo: never sampled with a purse, but has been casting all along — so the reagent
// count has a source and the purse honestly has none.
event(mins(30), 'Gonzo', 'cast', { spell: 'create food', ok: true,
                                   reagents_before: { elderberry: 45, herbs: 184 } });
event(mins(3), 'Gonzo', 'cast_declined', { spell: 'create food', why: 'not enough mana',
                                           have_reagents: { elderberry: 41, herbs: 176 } });
// Rizzo: sampled, and short of elderberry — cannot cast its way out of an empty larder.
sample(mins(10), 'Rizzo', { level: 22, purse: 12, elderberry: 2, herbs: 30 });
// What was bought, and what was refused.
event(mins(50), 'Kermit', 'bought', { item_kind: 'elderberry', cost: 120 });
event(mins(49), 'Kermit', 'bought', { item_kind: 'herb', cost: 30 });
event(mins(48), 'Rizzo', 'bought', { item_kind: 'elderberry', cost: 80 });
event(mins(47), 'Rizzo', 'buy_declined', { why: 'purse is down to the walking float' });

const byDay = new Map();
for (const l of lines) {
  const f = 'fleet-' + new Date(l.t).toISOString().slice(0, 10) + '.jsonl';
  byDay.set(f, (byDay.get(f) || '') + JSON.stringify(l) + '\n');
}
for (const [f, body] of byDay) writeFileSync(join(ledgerDir, f), body);

// The bank books. Beaker has an account with nothing in it; Statler has never been seen
// at a counter at all; Kermit holds two accounts, which is legal — Ko'catan is bank 2.
const bank = await import('./m59-bank.mjs');
const kermitBook = bank.emptyBook('Kermit');
bank.noteBankerLine(kermitBook, 'Yevitan tells you, "You have 122 shillings in your account."',
                    { at: mins(90) });
bank.noteBankerLine(kermitBook, 'Huital ko\'Nosak tells you, "You have 40 shillings in your account."',
                    { at: mins(80) });
writeFileSync(join(bankDir, 'Kermit.json'), JSON.stringify(kermitBook));
const beakerBook = bank.emptyBook('Beaker');
bank.noteBankerLine(beakerBook, 'Skivlat tells you, "You have no money to withdraw!"', { at: mins(70) });
writeFileSync(join(bankDir, 'Beaker.json'), JSON.stringify(beakerBook));

const { economy, series, CASTS_FROM } = await import('./m59-economy.mjs');
const e = economy({ sinceMs: 6 * 3600 * 1000 });
const row = (n) => e.rows.find(r => r.character === n);

// ---------------------------------------------------------------- the readings

console.log('\nwhich reading wins, and how old it is');
{
  const k = row('Kermit');
  ok('the newest real sample is the purse, not the offline one after it',
     k?.purse === 512, JSON.stringify({ purse: k?.purse }));
  ok('and the reading is dated from that sample, not from the null one',
     Math.abs(k.purse_at - mins(20)) < 1000);
  ok('a sample is marked as a sample', k.purse_from === 'sample');
}
{
  // THE CASE THAT MAKES THE PAGE USEFUL BEFORE THE SAMPLE CARRIES ANYTHING. Every cast
  // and every refusal states the caster's stock; it is older and it is honest.
  const g = row('Gonzo');
  ok('a character with no purse sample reports no purse rather than zero',
     g?.purse === null, JSON.stringify({ purse: g?.purse }));
  ok('but its reagents come from what it said while casting', g.elderberry === 41 && g.herbs === 176,
     JSON.stringify({ e: g.elderberry, h: g.herbs }));
  ok('and that source is named on the row', g.reagents_from === 'cast');
  ok('the cast reading takes the NEWEST of the two forms',
     Math.abs(g.reagents_at - mins(3)) < 1000);
}
{
  // A live row beats every record: the broker has the real inventory in hand.
  const withLive = economy({ sinceMs: 6 * 3600 * 1000,
                             live: [{ character: 'Gonzo', purse: 999,
                                      reagents: { elderberry: 3, herbs: 4 } }] });
  const g = withLive.rows.find(r => r.character === 'Gonzo');
  ok('a live row wins over the record', g.purse === 999 && g.elderberry === 3);
  ok('and says so, so nothing reads it as a five-minute-old figure',
     g.purse_from === 'live' && g.reagents_from === 'live');
  const k = withLive.rows.find(r => r.character === 'Kermit');
  ok('a character missing from the live rows keeps its recorded reading',
     k.purse === 512 && k.purse_from === 'sample');
}

console.log('\nthe bank, where null is not zero');
{
  const k = row('Kermit');
  ok('two accounts are summed, because Ko\'catan is a separate bank', k.banked === 162,
     JSON.stringify(k.accounts));
  ok('and both are listed', k.accounts.length === 2);
  ok('a balance a banker stated is marked observed', k.banked_observed === true);
}
{
  const b = row('Beaker');
  ok('"you have no money to withdraw" is a stated balance of zero', b?.banked === 0);
}
{
  const g = row('Gonzo');
  ok('a character nobody has taken to a counter is null, NOT zero', g.banked === null,
     JSON.stringify({ banked: g.banked }));
  ok('and it does not silently become part of the total',
     e.totals.banked === 162, JSON.stringify({ banked: e.totals.banked }));
  ok('how many characters have a balance at all is stated separately',
     e.totals.banked_known === 2);
}

console.log('\nwhat the reagents are actually for');
{
  ok('create food costs 2 and 2, so 41/176 is twenty castings',
     CASTS_FROM({ elderberry: 41, herbs: 176 }) === 20);
  ok('and the scarce half is the binding one',
     CASTS_FROM({ elderberry: 2, herbs: 176 }) === 1);
  const r = row('Rizzo');
  ok('a character under the short threshold is flagged', r.short === true);
  ok('and its castable meals are counted from its own pack', r.casts_possible === 1);
  const g = row('Gonzo');
  ok('a well-stocked character is not flagged', g.short === false);
}
{
  // A character with no reading at all must not be reported as short — "we have not
  // looked" is not "it has nothing", the same distinction the bank column makes.
  const withNobody = economy({ sinceMs: 1 });
  ok('a character with no reagent reading is not counted as short',
     withNobody.totals.short === 0, JSON.stringify(withNobody.totals));
}

console.log('\nwhat the money bought');
{
  const s = e.spend;
  ok('purchases are summed by item_kind, not by kind', s.total === 230,
     JSON.stringify(s.by_kind));
  ok('elderberry is the largest line', s.by_kind[0]?.name === 'elderberry' && s.by_kind[0].value === 200);
  ok('and it drills down to who spent it', s.by_kind[0].children.length === 2);
  ok('a refusal is counted with its reason', s.declined[0]?.times === 1 &&
     /walking float/.test(s.declined[0]?.why));
}

console.log('\nthe trend');
{
  const pts = series([
    { t: 1000, character: 'A', purse: 10, elderberry: 1, herbs: 1 },
    { t: 2000, character: 'A', purse: 90, elderberry: 1, herbs: 1 },   // later in the same bucket
    { t: 1000, character: 'B', purse: 5, elderberry: 0, herbs: 0 },
  ], { buckets: 1 });
  ok('a bucket takes the LAST reading per character, not a mean', pts[0]?.purse === 95,
     JSON.stringify(pts));
  ok('and counts how many characters it is a total of', pts[0]?.characters === 2);
}

// ------------------------------------------------------------------ the abilities

console.log('\nskills and spells: gained and lost, never netted');

const abilities = await import('./m59-abilities.mjs');
const book = (character, gains) => {
  const b = abilities.emptyBook(character);
  b.first_seen = mins(600);
  b.read_at = { skills: mins(30), spells: mins(30) };
  for (const g of gains) {
    const into = g.kind === 'spell' ? (b.spells ??= {}) : (b.skills ??= {});
    into[g.name] = { ability: g.ability, id: g.id ?? null, first: mins(600),
                     at: mins(10), best: g.best ?? g.ability };
    for (const c of g.history || [])
      b.history.push({ kind: g.kind, name: g.name, from: c.to - c.by, to: c.to,
                       by: c.by, at: c.at, why: 'advanced', pushed: true });
  }
  writeFileSync(join(abilityDir, character + '.json'), JSON.stringify(b));
};

book('Fozzie', [
  // Practised: one +3 and nothing else, so points and events disagree by design.
  { kind: 'skill', name: 'mace fighting', ability: 50,
    history: [{ to: 50, by: 3, at: mins(15) }] },
  // Rotting: never practised, decayed twice, and standing well below its own peak.
  { kind: 'spell', name: 'relay', ability: 7, best: 15,
    history: [{ to: 9, by: -3, at: mins(120) }, { to: 7, by: -2, at: mins(60) }] },
  // Learned before the window: present, but nothing moved in it.
  { kind: 'skill', name: 'block', ability: 27 },
]);
book('Beaker', [
  { kind: 'skill', name: 'mace fighting', ability: 12,
    history: [{ to: 12, by: 1, at: mins(45) }, { to: 11, by: 1, at: mins(44) },
              { to: 10, by: 1, at: mins(43) },
              // Older than the window asked for below — must not be counted.
              { to: 9, by: 5, at: NOW - 40 * 3600_000 }] },
  { kind: 'spell', name: 'relay', ability: 4, best: 4 },
]);

const f = abilities.fleetAbilities({ sinceMs: 6 * 3600 * 1000 });
const ab = (n) => f.abilities.find(a => a.name === n);
{
  ok('both books are read', f.characters === 2);
  ok('skills and spells are counted apart', f.skills === 2 && f.spells === 1,
     JSON.stringify({ skills: f.skills, spells: f.spells }));
}
{
  const m = ab('mace fighting');
  ok('points are summed, not events — one +3 and three +1s is 6', m.advanced === 6,
     JSON.stringify({ advanced: m.advanced }));
  ok('a change older than the window is left out', m.advanced !== 11);
  ok('the best holder is named, not just the number', m.best === 50 && m.best_character === 'Fozzie');
  ok('and the spread keeps every character\'s number', JSON.stringify(m.values) === '[50,12]');
  ok('the mean is over the characters that hold it', m.mean === 31);
}
{
  const r = ab('relay');
  ok('atrophy is counted as a loss', r.atrophied === 5, JSON.stringify({ atrophied: r.atrophied }));
  ok('and NOT netted against a gain — this one gained nothing', r.advanced === 0);
  ok('a character standing below its own peak is counted', r.decayed === 1,
     JSON.stringify({ decayed: r.decayed }));
  ok('a character at its own peak is not', r.held.find(h => h.character === 'Beaker').decayed === false);
}
{
  ok('the fleet total separates the two halves', f.advanced === 6 && f.atrophied === 5,
     JSON.stringify({ advanced: f.advanced, atrophied: f.atrophied }));
  ok('and the net is offered as well, but only as well', f.net === 1);
}
{
  const b = ab('block');
  ok('an ability nothing has done to it still appears, with zeroes',
     b && b.advanced === 0 && b.atrophied === 0 && b.characters === 1);
}
{
  // The facets the treemap draws. A facet keyed by ability drills down to characters and
  // vice versa; a facet that drilled into itself would render an empty map on the click.
  const gained = f.by_ability_gained.find(x => x.name === 'mace fighting');
  ok('the gained facet is keyed by ability and splits by character',
     gained?.value === 6 && gained.children.map(c => c.name).sort().join() === 'Beaker,Fozzie');
  const who = f.by_character_gained.find(x => x.name === 'Fozzie');
  ok('the who facet is keyed by character and splits by ability',
     who?.value === 3 && who.children[0].name === 'mace fighting');
  const lost = f.by_ability_lost.find(x => x.name === 'relay');
  ok('the lost facet holds only losses, as positive magnitudes', lost?.value === 5);
  ok('and an ability that only gained is absent from it',
     !f.by_ability_lost.some(x => x.name === 'mace fighting'));
}
{
  ok('the change list is newest first', f.recent[0].at >= f.recent[f.recent.length - 1].at);
  ok('and every entry names the character it belongs to',
     f.recent.every(c => c.character === 'Fozzie' || c.character === 'Beaker'));
}
{
  const perChar = f.by_character.find(c => c.character === 'Fozzie');
  ok('per-character totals add up the same way', perChar.advanced === 3 && perChar.atrophied === 5);
  ok('and count what each holds', perChar.skills === 2 && perChar.spells === 1);
}

// ------------------------------------------------------------------ the pages render

console.log('\nboth boards render against this fixture');
{
  const { renderEconomy } = await import('./m59-economy-page.mjs');
  const { renderSkills } = await import('./m59-skills-page.mjs');
  const html = renderEconomy({ hours: 6 });
  ok('the economy page renders', html.startsWith('<!doctype html>') && html.length > 2000);
  ok('and says "never asked" rather than 0 for a character nobody has banked',
     /never asked/.test(html));
  ok('and carries the tab bar, including its own tab', /class="tabs"/.test(html) &&
     /href="\/skills"/.test(html));
  const sk = renderSkills({ hours: 6 });
  ok('the skills page renders', sk.startsWith('<!doctype html>') && sk.length > 2000);
  ok('and shows the two halves apart', /\+6/.test(sk) && /−5/.test(sk));
  // A page with nothing to show must SAY so rather than render a blank panel — the
  // failure the Tougher page shipped with, white text on a white background.
  const empty = abilities.fleetAbilities({ sinceMs: 1 });
  ok('an empty window still lists every ability, with nothing moved',
     empty.abilities.length === 3 && empty.advanced === 0 && empty.atrophied === 0);

  // THE PACK DRILL-IN NAMES WHAT IS IN THE PACK, not only how full it is.
  //
  // A meter at 94% is a question; the list is the answer to it, and it comes off the
  // fleet row the broker already builds from the client's cached inventory, so the page
  // sends nothing. The two empty cases are the point: an EMPTY pack and an UNHELD
  // character must not render alike, the same rule the hatched meter follows.
  const withPack = renderEconomy({ hours: 6, live: [
    { character: 'Gonzo', purse: 999, reagents: { elderberry: 3, herbs: 4 },
      carrying: 3, pack: { percent: 41, weight: 700, bulk: 300, max: 1700,
                           binding: 'weight', exact: true },
      pack_items: [{ name: 'Herbs', amount: 176 }, { name: 'ElderBerry', amount: 41 },
                   { name: 'battle axe', amount: 1 }] },
    { character: 'Beaker', carrying: 0, pack_items: [] },
  ] });
  ok('the pack drill-in lists the items, with the amount on a stack',
     /Herbs <span class="dim">x176<\/span>/.test(withPack) && /battle axe/.test(withPack));
  ok('and an item with one of it carries no xN', !/battle axe <span class="dim">x/.test(withPack));
  ok('an empty pack says it is empty', /nothing in the pack/.test(withPack));
  ok('and a character nobody is holding says no list rather than an empty one',
     /no item list/.test(withPack));
  // The third absence, which is the one that will actually be seen first: the page is
  // new and the broker serving it is not. A row with no `pack_items` field at all is an
  // OLD BROKER, not an empty pack, and saying "nothing in the pack" about a character
  // carrying a full load is the kind of confident wrong answer this page exists to avoid.
  const oldBroker = renderEconomy({ hours: 6, live: [{ character: 'Gonzo', purse: 999, carrying: 3 }] });
  ok('a broker too old to report the list says so instead of claiming an empty pack',
     /does not report the item list/.test(oldBroker) && !/nothing in the pack/.test(oldBroker));
}

// ------------------------------------------------------------------ the tab bar
//
// The whole reason m59-page-chrome.mjs exists: nine boards carrying nine copies of one
// list would inevitably leave a newly added page invisible from one of the others.
console.log('\nthe inventory board marks magic, and only where it knows');

{
  const { renderInventory } = await import('./m59-inventory-page.mjs');

  // THE ROW SHAPE IS THE CONTRACT, and it is the half that broke. `pack_items` is grouped by
  // name in the broker's fleet tool, and that grouping used to emit `{name, amount}` only — so
  // the markers rendered ZERO times on a live fleet holding three cursed items and thirteen
  // unidentified ones. The page was right, `magicOf` was right, and the producer had dropped the
  // only two fields either could use. This pins the page's half: given the fields, it marks.
  const live = [{
    character: 'Rizzo', carrying: 4,
    pack: { percent: 42, binding: 'weight', bulk: 10, weight: 20, max: 2000, exact: true },
    pack_items: [
      { name: 'ring of lethargy', amount: 1, rarity: 200, tag: 0 },
      { name: 'scroll', amount: 1, rarity: 100, tag: 0 },
      { name: 'shilling', amount: 4000, rarity: 0, tag: 1 },
      { name: 'long sword', amount: 1, rarity: 0, tag: 0 },
    ],
  }];
  const html = renderInventory({ live, characters: new Set(['Rizzo']) });

  ok('a cursed item is marked, and named as cursed rather than merely magic',
     html.includes('(cursed)') && /class="magic cursed"/.test(html));
  ok('an unidentified item is marked as unread — a backlog, not a property',
     html.includes('(magic, unread)') && /class="magic unread"/.test(html));
  // A STACK IS NEVER MAGIC, and the test is the TAG rather than the amount. Money, reagents,
  // arrows and food carry no attribute, and an identified-per-stack model does not exist.
  ok('money is not marked', !/shilling[^<]*<span class="magic/.test(html));
  // AND NOTHING IS ASSERTED ABOUT WHAT NOBODY HAS READ. A plain long sword with no description
  // is "nothing is known", never "it is ordinary" — so it gets no marker and no claim.
  ok('an item with nothing read carries no marker rather than a claim that it is mundane',
     !/long sword[^<]*<span class="magic/.test(html));

  ok('the description is IN the tooltip, which is what was asked for',
     /title="[^"]*never be unequipped once worn/.test(html));

  // The truncation this page exists to stop doing.
  ok('nothing is truncated', !/and \d+ more/.test(html));

  // A row from an older broker has no grades at all. That must read as "nothing known" for
  // every item rather than as a fleet holding nothing magical.
  const old = renderInventory({
    live: [{ character: 'Rizzo', carrying: 2,
             pack_items: [{ name: 'ring of lethargy', amount: 1 }] }],
    characters: new Set(['Rizzo']) });
  ok('a broker too old to send grades marks nothing, rather than claiming the pack is mundane',
     !/class="magic/.test(old) && old.includes('ring of lethargy'));
}

console.log('\none tab bar, ten boards');
{
  const { NAV, TABS } = await import('./m59-page-chrome.mjs');
  ok('every board has a tab', TABS.length === 10);
  // SIX BOARDS SHARE THIS BAR BECAUSE A SEVENTH WRITTEN BY HAND WAS INVISIBLE from
  // whichever copy nobody edited. Inventory was split out of Economy on 2026-09-17, so it
  // is NAMED here rather than only counted: a bumped number proves somebody changed the
  // length, never that the new page can be reached.
  ok('Inventory is one of them, and is its own page rather than an anchor on Economy',
     TABS.some(t => t.key === 'inventory' && t.href === '/inventory'));
  ok('...and Economy is still beside it', TABS.some(t => t.href === '/economy'));
  ok('and Players is one of them', TABS.some(t => t.key === 'players' && t.href === '/players'));
  const nav = NAV('economy');
  ok('the current page is the only one marked', (nav.match(/class="on"/g) || []).length === 1);
  ok('and it is the right one', /href="\/economy" class="on"/.test(nav));
  ok('a page that names no tab still gets a working nav',
     !/class="on"/.test(NAV('nonesuch')) && /href="\/deaths"/.test(NAV('nonesuch')));
}

// ------------------------------------------------------------------ automation boards

console.log('\nthe DUM and Harness boards');
{
  const { keeperActivity, renderDumBoard, renderHarnessBoard } =
    await import('./m59-observability-page.mjs');
  const metrics = { since: NOW - 60_000, through: NOW, interventions_triggered: 7,
    interventions_applied: 5, interventions_no_change: 2, verification_failures: 1,
    findings: 3, errors: 1, by_rule: [{ name: 'vault-policy', count: 4 }],
    by_kind: [{ name: 'orders', count: 5 }] };
  const dum = renderDumBoard({ metrics, hours: 2, details: {
    crate: { checks: 1, finds: 1, rewards: 2, records: [{ at: NOW, agent: 'a', found: true,
      reached: true, reward: [{ name: 'Rose', amount: 2 }], transcript: ['found'] }] },
    create_food: { attempts: 1, produced: 1, blocked: 1,
      blocked_by: [{ name: 'herbs', count: 1 }], records: [{ at: NOW, agent: 'b', event: 'blocked',
        readiness: { meals: 0, mana: 10, reagents: { elderberry: 2, herbs: 0 }, blocked_by: ['herbs'] } }] },
  } });
  ok('the DUM board renders its own selected tab and counters',
     /href="\/dum" class="on"/.test(dum) && /vault-policy/.test(dum) && />7<\/div>/.test(dum));
  ok('crate and food records drill in without a client-side API',
     /<details class="record">/.test(dum) && /2× Rose/.test(dum) && /blocked by herbs/.test(dum));
  const fleet = [
    { agent: 'a', character: 'Alpha', activity: 'hunting',
      time: { fighting_s: 90, zoning_s: 10, travelling_s: 20, active_s: 120 } },
    { agent: 'b', character: 'Beta', activity: 'recovering',
      time: { recovering_s: 60, stalled_s: 5, active_s: 65 } },
  ];
  const activity = keeperActivity(fleet);
  ok('keeper activity totals every category across the fleet',
     activity.totals.fighting_s === 90 && activity.totals.recovering_s === 60 &&
     activity.totals.zoning_s === 10 && activity.totals.travelling_s === 20 &&
     activity.totals.active_s === 185);
  const harness = renderHarnessBoard({ fleet, details: {
    travel: { trips: 1, duration_ms: 12_000, damage: 4, safe_spot_stops: 1, records: [{
      at: NOW, character: 'Alpha', arrived: true, to: 39, duration_ms: 12_000, damage: 4,
      safe_spot_stops: 1, maps: [{ room: 38, name: 'Castle Victoria', duration_ms: 8000, damage: 4 }] }] },
    fighting: { sessions: 1, duration_ms: 10_000, damage: 2, safe_spot_pct: 75, records: [] },
    trading: { sessions: 1, earned: 90, spent: 10, banked: 50, records: [] },
    vault: { deposits: 1, items_deposited: 3, latest: [{ at: NOW, character: 'Beta',
      items: [{ name: 'Inky Cap Mushroom', amount: 12 }] }] },
  } });
  ok('the Harness board renders its own selected tab and per-unit clocks',
     /href="\/harness" class="on"/.test(harness) && /Alpha/.test(harness) && /1m 30s/.test(harness));
  ok('keeper drill-ins carry map numbers, exact damage, trade income, and cached vault contents',
     /Castle Victoria \(38\)/.test(harness) && /earned<\/div><div class="v">90/.test(harness) &&
     /12× Inky Cap Mushroom/.test(harness));
  ok('a missing DUM process is a visible page rather than a failed route',
     /DUM observability is unavailable/.test(renderDumBoard({ error: 'connection refused' })));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
