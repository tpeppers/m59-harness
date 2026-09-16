// Offline cash-return accounting, persistence and keeper/UI integration.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-town-income-'));
process.env.M59_LEDGER_DIR = join(root, 'history');
process.env.M59_BANK_DIR = join(root, 'banks');
process.env.M59_EVIDENCE_DIR = root;
const { completeTownIncome, lastTownIncome, recordTownTrade, cashSnapshot, calculateTownIncome } =
  await import('./m59-town-income.mjs');
const account = balance => [{ account: 'jasper-tos-barloque', balance, at: 100, observed: true }];
const originalNow = Date.now;
const start = originalNow() - 3 * 3600000;
try {
  assert.equal(lastTownIncome('Nobody'), null);
  const first = completeTownIncome('Farmer', { trip_started_at: start - 60000,
    completed_at: start, purse: 400, accounts: account(10000) });
  assert.equal(first.shillings_per_hour, null, 'first trip cannot time pre-existing loot');
  assert.match(first.unavailable, /full cycle/);
  recordTownTrade('Farmer', { earned: 6000 });
  recordTownTrade('Farmer', { earned: 1000, spent: 1400 });
  recordTownTrade('Farmer', { banked: 10000 });
  const next = completeTownIncome('Farmer', { trip_started_at: start + 6600000,
    completed_at: start + 7200000, purse: 400, accounts: account(16000) });
  assert.equal(next.shillings_per_hour, 3000);
  assert.equal(next.net_shillings, 6000);
  assert.equal(next.elapsed_s, 7200);
  assert.equal(next.vendor_sales, 7000, 'merchant legs accumulate');
  assert.equal(next.purchases, 1400);
  assert.equal(next.other_cash_change, 400);
  // A new module instance reloads the same completed result, independent of uptime.
  const restarted = await import('./m59-town-income.mjs?restart');
  assert.deepEqual(restarted.lastTownIncome('Farmer'), next);
  assert.equal(completeTownIncome('Farmer', { trip_started_at: next.trip_started_at,
    completed_at: next.completed_at + 100 }), null, 'duplicate completion is inert');
  const neutral = completeTownIncome('Farmer', { trip_started_at: start + 8000000,
    completed_at: start + 10800000, purse: 5400, accounts: account(11000) });
  assert.equal(neutral.shillings_per_hour, 0, 'withdrawals are not earnings');
  assert.equal(neutral.vendor_sales, 0, 'receipts reset at the completed boundary');
  const loss = completeTownIncome('Farmer', { trip_started_at: start + 11000000,
    completed_at: start + 14400000, purse: 400, accounts: account(11000) });
  assert.equal(loss.shillings_per_hour, -5000, 'lost cash is a loss, not clipped to zero');
  const boundary = (cash, t = 10) => ({ cash, completed_at: t });
  const snapshot = cashSnapshot({ purse: 1, accounts: account(0) });
  for (const missing of [cashSnapshot({ purse: 0 }), cashSnapshot({ purse: null, accounts: account(0) }),
    cashSnapshot({ purse: 0, accounts: account(null) })]) {
    assert.equal(calculateTownIncome(boundary(missing), boundary(snapshot, 20)).shillings_per_hour, null);
  }
  const newAccount = cashSnapshot({ purse: 1, accounts: [...account(0), { account: 'kocatan', balance: 9000 }] });
  assert.match(calculateTownIncome(boundary(snapshot), boundary(newAccount, 20)).unavailable, /coverage changed/);
  assert.equal(calculateTownIncome(boundary(snapshot), boundary(snapshot, 10)).shillings_per_hour, null);
  // Same name on another fleet/evidence directory has an independent record.
  process.env.M59_LEDGER_DIR = join(root, 'shadow');
  assert.equal(lastTownIncome('Farmer'), null);
  process.env.M59_LEDGER_DIR = join(root, 'history');

  // Real service-loop integration: a paused trip leaves the previous result intact;
  // only the final service closes a cycle and emits its durable ledger receipt.
  const { Autopilot } = await import('./m59-autopilot.mjs');
  const bank = await import('./m59-bank.mjs');
  const book = bank.emptyBook('Keeper');
  bank.noteBankerLine(book, 'Skivlat tells you, "You have no money to withdraw!"');
  bank.saveBook(book);
  completeTownIncome('Keeper', { trip_started_at: start - 1, completed_at: start,
    purse: 400, accounts: account(0) });
  let purse = 400, paused = true;
  const events = [];
  const k = Object.assign(Object.create(Autopilot.prototype), {
    s: { client: { me: { name: 'Keeper' }, inventory: [] }, world: { room: { num: 104 } } },
    policy: {}, townTrip: { startedAt: start + 1800000, target: { room: 104 },
      nextService: 1, marketStops: [{ room: 104 }] },
    travelInterrupted: () => false, purseNow: () => purse, progress() {},
    shoppingPlan: () => ({}), ledgerEvent: (kind, detail) => events.push({ kind, detail }),
    async sellMarketCircuit() {
      if (paused) { paused = false; return { pending: true }; }
      purse += 3000; this.tradeFact({ earned: 3000 }); return { total_received: 3000 };
    },
    guildTitheFromSale: async () => {}, bankSurplus: async () => {},
    ensurePurchaseFunds: async () => ({ ready: true }), restockInTown: async () => {},
    buyFoodInTown: async () => {},
    async buyReagentsInTown() { purse -= 600; this.tradeFact({ spent: 600 }); },
    buyFarmDeliveryCargo: async () => {}, vaultRunIfPassing: async () => {},
  });
  Date.now = () => start + 3500000;
  await k.continueTownTrip();
  assert.equal(lastTownIncome('Keeper').completed_at, start);
  assert.equal(events.length, 0);
  Date.now = () => start + 3600000;
  await k.continueTownTrip();
  assert.equal(lastTownIncome('Keeper').shillings_per_hour, 2400);
  assert.equal(events[0].kind, 'town_trip_completed');
  assert.equal(events.length, 1);
  assert.equal(k.townTrip, null);
  assert.equal(await k.continueTownTrip(), false);
  Date.now = originalNow;

  // The report uses the saved completion even outside its history time filter,
  // scopes it to the fleet roster and renders the denominator and missing-data state.
  const { economy } = await import('./m59-economy.mjs');
  const live = [{ character: 'Keeper', purse: 2800 }, { character: 'Nobody', purse: 1 }];
  assert.equal(economy({ sinceMs: 1, live }).rows.find(r => r.character === 'Keeper')
    .last_town_trip.shillings_per_hour, 2400);
  assert.equal(economy({ sinceMs: 1, live, characters: new Set(['Nobody']) }).rows.length, 1);
  const { renderEconomy } = await import('./m59-economy-page.mjs');
  const html = renderEconomy({ hours: 0.001, live });
  assert.match(html, /farming shillings\/hr/);
  assert.match(html, /2,400 shillings\/hr/);
  assert.match(html, /1\.00 hours/);
  assert.match(html, /Awaiting a completed town trip/);
  assert.match(html, /colspan="11"/);
  if (process.env.M59_TEST_PREVIEW) writeFileSync(process.env.M59_TEST_PREVIEW, html);
  console.log('town income accounting, persistence, keeper and page tests passed');
} finally {
  Date.now = originalNow;
  rmSync(root, { recursive: true, force: true });
}
