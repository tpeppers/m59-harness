#!/usr/bin/env node
// THE ISLAND BANK ON THE ECONOMY PAGE, OFFLINE. No server, no broker, safe any time:
//
//   node tools/m59-economy-island-test.mjs
//
// Ko'catan keeps its own bank (Huital ko'Nosak, The Hungry Vaults, room 2005), and a deposit
// there cannot be drawn in Jasper or Tos. The economy page used to sum the two accounts into
// one "banked" column without saying so; it now carries them apart and lets the reader pick
// with `?view=mainland|island|combined`. What this pins:
//
//   * WHICH ACCOUNT IS THE ISLAND'S is one key, `kocatan`, the same key the banker parser files
//     Huital's sentences under and the purchase planner names for room 2005.
//   * TWO RECORDS, NEWEST WINS. A balance comes from the bank book (substrate/banks/) or from
//     the copy on a `town_trip_completed` ledger row (`cash.accounts`), per account, whichever
//     was read later — the book on a tie. A legacy row that names no account is not guessed at.
//   * EACH VIEW'S PER-CHARACTER FIGURE AND TOTAL, and that mainland + island = combined.
//   * NO SAMPLE IS NOT ZERO. A character nobody has heard at Ko'catan's counter is null in the
//     data and "no island sample" on the page — while a stated zero stays a zero.
//
// Everything runs against scratch directories via M59_LEDGER_DIR / M59_BANK_DIR, so it never
// reads or writes a real fleet's record.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-economy-island-test-'));
const ledgerDir = join(root, 'history');
const bankDir = join(root, 'banks');
for (const d of [ledgerDir, bankDir]) mkdirSync(d, { recursive: true });
process.env.M59_LEDGER_DIR = ledgerDir;
process.env.M59_BANK_DIR = bankDir;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const NOW = Date.now();
const mins = (n) => NOW - n * 60_000;
const MAIN = 'jasper-tos-barloque', ISLE = 'kocatan';

// ---------------------------------------------------------------- the fixture
const lines = [];
const sample = (t, character, fields) => lines.push({ t, type: 'sample', character, ...fields });
const trip = (t, character, cash) => lines.push({ t, iso: new Date(t).toISOString(), type: 'event',
  kind: 'town_trip_completed', agent: 'tx', character, trip_started_at: t - 60_000,
  completed_at: t, room: 2005, cash });
const acct = (account, balance, at, observed = true) => ({ account, balance, at, observed });

// Kermit: the book holds a mainland balance and a STALE island one; the newer trip row carries
// the island balance read since. An even older trip must not win either.
trip(mins(500), 'Kermit', { purse: 900, accounts: [acct(ISLE, 100, mins(505))] });
trip(mins(10), 'Kermit', { purse: 500, accounts: [acct(MAIN, 2073, mins(300)), acct(ISLE, 26430, mins(11))] });
sample(mins(5), 'Kermit', { purse: 500 });
// Lew: the book is NEWER than the trip row on the island side, so the book wins there; the
// mainland figure is arithmetic after a withdrawal (observed false).
trip(mins(120), 'Lew', { purse: 15796, accounts: [acct(MAIN, 33252, mins(200), false), acct(ISLE, 6300, mins(121))] });
// Statler: mainland only. Nobody has heard him at Ko'catan's counter — the case the page must
// show as no sample, never as 0.
sample(mins(6), 'Statler', { purse: 1000 });
// Sweetums: no bank book at all, only the trip row. Her mainland account is a STATED zero.
trip(mins(50), 'Sweetums', { purse: 200, accounts: [acct(MAIN, 0, mins(400)), acct(ISLE, 638, mins(51))] });
sample(mins(4), 'Sweetums', { purse: 200 });
// Gonzo: island only, no purse reading.
trip(mins(30), 'Gonzo', { purse: null, accounts: [acct(ISLE, 500, mins(31))] });
// Rizzo: a purse and no bank anywhere — plus a LEGACY trip row whose cash names no account,
// which must not be attributed to either bank.
sample(mins(3), 'Rizzo', { purse: 12 });
trip(mins(20), 'Rizzo', { purse: 12, bank: 300 });

const byDay = new Map();
for (const l of lines) {
  const f = 'fleet-' + new Date(l.t).toISOString().slice(0, 10) + '.jsonl';
  byDay.set(f, (byDay.get(f) || '') + JSON.stringify(l) + '\n');
}
for (const [f, body] of byDay) writeFileSync(join(ledgerDir, f), body);

const bank = await import('./m59-bank.mjs');
const book = (name, said) => {
  const b = bank.emptyBook(name);
  for (const [text, at] of said) bank.noteBankerLine(b, text, { at });
  writeFileSync(join(bankDir, name + '.json'), JSON.stringify(b));
};
book('Kermit', [['Yevitan tells you, "You have 2073 shillings in your account."', mins(300)],
                ['Huital ko\'Nosak tells you, "You have 40 shillings in your account."', mins(90)]]);
book('Lew', [['Huital ko\'Nosak tells you, "Thank you for your deposit.  You now have 15300 shillings in your account."', mins(60)]]);
book('Statler', [['Yevitan tells you, "You have 39889 shillings in your account."', mins(100)]]);

const { economy, bankView, normaliseView, BANK_VIEWS } = await import('./m59-economy.mjs');
const e = economy({ sinceMs: 24 * 3600 * 1000 });
const row = (n) => e.rows.find(r => r.character === n);

// ---------------------------------------------------------------- which account is the island's

console.log('\nwhich account is the island\'s');
{
  ok('the island account is "kocatan"', bank.ISLAND_ACCOUNT === 'kocatan');
  ok('the mainland account is not the island\'s',
     bank.accountRegion(MAIN) === 'mainland' && bank.accountRegion(ISLE) === 'island');
  const b = bank.emptyBook('X');
  const entry = bank.noteBankerLine(b, 'Huital ko\'Nosak tells you, "You have 5 shillings in your account."');
  ok('Huital\'s sentence is filed under that same account', entry?.account === bank.ISLAND_ACCOUNT);
  const viaRoom = bank.noteBankerLine(b, 'You have 6 shillings in your account.', { roomName: 'The Hungry Vaults' });
  ok('and so is a balance heard in The Hungry Vaults with no speaker named',
     viaRoom?.account === bank.ISLAND_ACCOUNT);
  const { PURCHASE_BANKS } = await import('./m59-purchase-plan.mjs');
  ok('the purchase planner names room 2005\'s account the same way',
     PURCHASE_BANKS.find(p => p.room === 2005)?.account === bank.ISLAND_ACCOUNT);
}

// ---------------------------------------------------------------- the readings

console.log('\nthe two sides, per character, newest reading first');
{
  const k = row('Kermit');
  ok('a newer trip-row reading beats a staler book entry', k.island_banked === 26430,
     JSON.stringify(k.accounts));
  ok('and says it came from the trip row, with the time it was read',
     k.accounts.find(a => a.account === ISLE)?.from === 'trip' && Math.abs(k.island_at - mins(11)) < 1000);
  ok('the mainland side is the book\'s', k.mainland_banked === 2073);
  ok('combined is their sum', k.banked === 2073 + 26430);
}
{
  const l = row('Lew');
  ok('a newer book entry beats an older trip row', l.island_banked === 15300,
     JSON.stringify(l.accounts));
  ok('a derived mainland balance stays derived', l.mainland_observed === false);
  ok('each side keeps its own age', Math.abs(l.mainland_at - mins(200)) < 1000 &&
     Math.abs(l.island_at - mins(60)) < 1000);
}
{
  const s = row('Statler');
  ok('a character never heard at Ko\'catan\'s counter has NO island reading — null, not 0',
     s.island_banked === null && s.island_at === null, JSON.stringify(s));
  ok('and his combined figure is his mainland one', s.banked === 39889);
}
{
  const w = row('Sweetums');
  ok('a character known only from the ledger still has both accounts', w != null &&
     w.island_banked === 638);
  ok('and a STATED zero on the mainland stays zero, not null', w.mainland_banked === 0);
}
{
  const g = row('Gonzo');
  ok('an island-only character has no mainland reading', g.mainland_banked === null &&
     g.island_banked === 500 && g.banked === 500);
}
{
  const r = row('Rizzo');
  ok('a legacy trip row that names no account is not guessed into a bank',
     r.banked === null && r.mainland_banked === null && r.island_banked === null,
     JSON.stringify(r.accounts));
}

// ---------------------------------------------------------------- the three views

console.log('\neach view: per character, and the totals');
const expect = {
  mainland: { Kermit: 2073, Lew: 33252, Statler: 39889, Sweetums: 0, Gonzo: null, Rizzo: null },
  island:   { Kermit: 26430, Lew: 15300, Statler: null, Sweetums: 638, Gonzo: 500, Rizzo: null },
  combined: { Kermit: 28503, Lew: 48552, Statler: 39889, Sweetums: 638, Gonzo: 500, Rizzo: null },
};
const totals = { mainland: [75214, 4], island: [42868, 4], combined: [118082, 5] };
for (const view of BANK_VIEWS) {
  const v = bankView(e, view);
  const got = Object.fromEntries(v.rows.map(r => [r.character, r.banked]));
  ok(`${view}: every character's figure`,
     Object.entries(expect[view]).every(([c, n]) => got[c] === n), JSON.stringify(got));
  ok(`${view}: the total is ${totals[view][0]} across ${totals[view][1]} character(s) with a reading`,
     v.totals.banked === totals[view][0] && v.totals.known === totals[view][1],
     JSON.stringify(v.totals));
}
{
  const t = e.totals;
  ok('mainland + island = combined, in the fleet totals',
     t.mainland_banked + t.island_banked === t.banked && t.banked === 118082,
     JSON.stringify({ m: t.mainland_banked, i: t.island_banked, c: t.banked }));
  ok('the island total counts only characters with an island reading', t.island_known === 4);
  ok('worth, all in, is still purse + every account', t.wealth === 1712 + 118082,
     JSON.stringify({ purse: t.purse, wealth: t.wealth }));
}
{
  ok('the default view is mainland', normaliseView(undefined) === 'mainland' &&
     normaliseView(null) === 'mainland' && normaliseView('') === 'mainland');
  ok('an unknown view falls back to mainland rather than failing', normaliseView('atlantis') === 'mainland');
  ok('case and spaces do not matter', normaliseView(' ISLAND ') === 'island');
}

// ---------------------------------------------------------------- the page

console.log('\nthe page, in each view');
const { renderEconomy } = await import('./m59-economy-page.mjs');
const cell = (html, character, col) => {
  const tr = new RegExp(`<tr data-character="${character}"[^>]*>([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? '';
  return new RegExp(`data-col="${col}">([\\s\\S]*?)</td>`).exec(tr)?.[1] ?? null;
};
const foot = (html, col) =>
  new RegExp(`<tfoot>[\\s\\S]*?data-col="${col}">([\\s\\S]*?)</td>`).exec(html)?.[1] ?? null;
const facetTotal = (html) => {
  const m = /var FACETS = (\{[\s\S]*?\});\n/.exec(html);
  try { return JSON.parse(m[1]).wealth.total; } catch { return null; }
};
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

{
  const html = renderEconomy({ hours: 24 });
  ok('with no view asked for, the mainland view is the one marked',
     /<a href="\?view=mainland&amp;hours=24" class="on"/.test(html));
  ok('the toggle offers all three, keeping the window', BANK_VIEWS.every(v =>
     html.includes(`href="?view=${v}&amp;hours=24"`)));
  ok('mainland: Statler shows his mainland balance', strip(cell(html, 'Statler', 'mainland')) === '39,889',
     cell(html, 'Statler', 'mainland'));
  ok('mainland: Kermit shows only his mainland account, not the island money',
     strip(cell(html, 'Kermit', 'mainland')) === '2,073', cell(html, 'Kermit', 'mainland'));
  ok('mainland: a character never at a mainland counter says "never asked"',
     /never asked/.test(cell(html, 'Gonzo', 'mainland') ?? ''));
  ok('mainland: a stated zero renders as 0', strip(cell(html, 'Sweetums', 'mainland')) === '0');
  ok('mainland: the table total', strip(foot(html, 'mainland')) === '75,214', foot(html, 'mainland'));
  ok('mainland: the money map is purses plus the mainland bank', facetTotal(html) === 1712 + 75214);
  ok('the note says the island account is separate', /separate account/.test(html) &&
     /cannot be drawn on the other/.test(html));
  ok('and worth, all in, still says how much of it is on the island',
     /42,868 of it in Ko&#39;catan&#39;s bank|42,868 of it in Ko'catan's bank/.test(html));
}
{
  const html = renderEconomy({ hours: 24, view: 'island' });
  ok('island: the island view is the one marked',
     /<a href="\?view=island&amp;hours=24" class="on"/.test(html) &&
     !/<a href="\?view=mainland&amp;hours=24" class="on"/.test(html));
  ok('island: Kermit shows his Ko\'catan balance', strip(cell(html, 'Kermit', 'island')) === '26,430');
  ok('island: Statler is NO SAMPLE, not 0', /no island sample/.test(cell(html, 'Statler', 'island') ?? '') &&
     strip(cell(html, 'Statler', 'island')) !== '0', cell(html, 'Statler', 'island'));
  ok('island: the table total', strip(foot(html, 'island')) === '42,868', foot(html, 'island'));
  ok('island: the money map is the island bank alone', facetTotal(html) === 42868);
  ok('island: the island holders come first',
     html.indexOf('data-character="Kermit"') < html.indexOf('data-character="Statler"') &&
     html.indexOf('data-character="Gonzo"') < html.indexOf('data-character="Rizzo"'));
  ok('island: the note is here too', /separate account/.test(html));
}
{
  const html = renderEconomy({ hours: 24, view: 'combined' });
  ok('combined: the combined view is the one marked', /<a href="\?view=combined&amp;hours=24" class="on"/.test(html));
  ok('combined: Kermit carries both sides and their sum',
     strip(cell(html, 'Kermit', 'mainland')).startsWith('2,073') &&
     strip(cell(html, 'Kermit', 'island')).startsWith('26,430') &&
     strip(cell(html, 'Kermit', 'combined')) === '28,503');
  ok('combined: Statler\'s island side is no sample, and his sum says mainland only',
     /no sample/.test(cell(html, 'Statler', 'island') ?? '') &&
     strip(cell(html, 'Statler', 'combined')) === '39,889 mainland only', cell(html, 'Statler', 'combined'));
  ok('combined: Gonzo\'s sum says island only', strip(cell(html, 'Gonzo', 'combined')) === '500 island only');
  ok('combined: a derived balance is marked as such', /derived/.test(cell(html, 'Lew', 'mainland') ?? ''));
  ok('combined: the table totals, all three',
     strip(foot(html, 'mainland')) === '75,214' && strip(foot(html, 'island')) === '42,868' &&
     strip(foot(html, 'combined')) === '118,082',
     JSON.stringify([foot(html, 'mainland'), foot(html, 'island'), foot(html, 'combined')]));
  ok('combined: the money map is purses plus both banks', facetTotal(html) === 1712 + 118082);
}
{
  const html = renderEconomy({ hours: 24, view: 'nonsense' });
  ok('an unknown ?view= renders the mainland view', /<a href="\?view=mainland&amp;hours=24" class="on"/.test(html));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
