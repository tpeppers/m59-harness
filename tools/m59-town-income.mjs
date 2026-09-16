// Realized farming return, bounded by completed keeper town trips. Cash wealth
// (purse + known bank accounts) makes deposits/withdrawals neutral and includes
// purchases, cash lost on death and guild cash contributions. Unsold inventory
// has no invented price. Gifts/manual transfers can also change this cash return.
// One small per-character file survives keeper restarts and dashboard time filters;
// completed summaries are also written to the long ledger by the caller.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

const directory = () => join(ledgerDirFor(fleetName()), 'town-income');
const fileFor = character => join(directory(), encodeURIComponent(character.toLowerCase()) + '.json');
const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const emptyReceipts = () => ({ sales: 0, purchases: 0 });

function readBook(character) {
  if (!character) return null;
  try {
    const book = JSON.parse(readFileSync(fileFor(character), 'utf8'));
    return book.version === 1 && book.character?.toLowerCase() === character.toLowerCase() ? book : null;
  } catch { return null; }
}

function saveBook(character, book) {
  // Match the ledger's test isolation: an offline keeper fixture cannot seed prod.
  if (/[\\/]m59-[a-z-]+-test\.mjs$/.test(process.argv[1] || '') && !process.env.M59_LEDGER_DIR)
    return false;
  try {
    mkdirSync(directory(), { recursive: true });
    const file = fileFor(character), tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(book) + '\n');
    renameSync(tmp, file);
    return true;
  } catch { return false; } // Accounting must not interrupt survival or shopping.
}

export function cashSnapshot({ purse, accounts = [] } = {}) {
  const bank = accounts.map(a => ({ account: a.account, balance: a.balance, at: a.at ?? null,
    observed: a.observed ?? null })).sort((a, b) => String(a.account).localeCompare(String(b.account)));
  const known = money(purse) && bank.length > 0 && bank.every(a => a.account && money(a.balance)) &&
    new Set(bank.map(a => a.account)).size === bank.length;
  return { purse: money(purse) ? purse : null, accounts: bank,
    wealth: known ? purse + bank.reduce((n, a) => n + a.balance, 0) : null };
}

export function calculateTownIncome(previous, current, receipts = emptyReceipts()) {
  const elapsed = previous ? current.completed_at - previous.completed_at : null;
  const unavailable = !previous ? 'Awaiting a full cycle between completed town trips' :
    !money(previous.cash?.wealth) || !money(current.cash?.wealth)
      ? 'Purse or bank balance was unknown at a trip boundary' :
    JSON.stringify(previous.cash.accounts.map(a => a.account)) !==
      JSON.stringify(current.cash.accounts.map(a => a.account))
      ? 'Bank account coverage changed; this trip establishes a new baseline' :
    !(elapsed > 0) ? 'No positive elapsed time between town trips' : null;
  const net = unavailable ? null : current.cash.wealth - previous.cash.wealth;
  return { ...current, cycle_started_at: previous?.completed_at ?? null,
    elapsed_s: elapsed > 0 ? elapsed / 1000 : null, cash_before: previous?.cash ?? null,
    net_shillings: net, shillings_per_hour: net == null ? null : net * 3600000 / elapsed,
    vendor_sales: receipts.sales, purchases: receipts.purchases,
    other_cash_change: net == null ? null : net - receipts.sales + receipts.purchases,
    unavailable, basis: 'cash_change_per_elapsed_hour' };
}

// Called only on confirmed transactions, independently of optional strategy stats.
// Banking is intentionally absent. Receipts are supporting detail, not the numerator.
export function recordTownTrade(character, fact = {}) {
  if (!character || (!money(fact.earned) && !money(fact.spent))) return;
  const book = readBook(character);
  if (!book?.boundary) return;
  book.receipts.sales += money(fact.earned) ? fact.earned : 0;
  book.receipts.purchases += money(fact.spent) ? fact.spent : 0;
  saveBook(character, book);
}

export function completeTownIncome(character, { trip_started_at, completed_at = Date.now(),
  purse, accounts, room = null } = {}) {
  if (!character || !Number.isFinite(completed_at) || !Number.isFinite(trip_started_at)) return null;
  const book = readBook(character);
  // Retrying a completion or an old callback cannot reset the next cycle.
  if (book?.boundary && (trip_started_at === book.boundary.trip_started_at ||
      completed_at <= book.boundary.completed_at)) return null;
  const boundary = { trip_started_at, completed_at, room, cash: cashSnapshot({ purse, accounts }) };
  const last_trip = calculateTownIncome(book?.boundary, boundary, book?.receipts ?? emptyReceipts());
  if (!saveBook(character, { version: 1, character, boundary, receipts: emptyReceipts(), last_trip })) return null;
  return last_trip;
}

export function lastTownIncome(character) { return readBook(character)?.last_trip ?? null; }
