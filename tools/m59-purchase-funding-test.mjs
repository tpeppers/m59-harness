// Offline integration tests: real shopping/funding methods, simulated banker and shop.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'm59-funding-'));
process.env.M59_EVIDENCE_DIR = dir;
process.env.M59_UPTIME_FILE = join(dir, 'uptime.jsonl');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { purchasePlan, accountBalance } = await import('./m59-purchase-plan.mjs');

const bill = purchasePlan({ requests: [{ item: 'herb', amount: 60 }],
  menu: [{ name: 'herbs', cost: 14 }], reserve: 100 });
assert.equal(bill.expected_cost, 840);
assert.equal(bill.required_purse, 940);
assert.equal(purchasePlan({ requests: [{ item: 'unknown', amount: 3 }], estimated: true }).expected_cost, null);
assert.equal(accountBalance({ account: 'kocatan', balance: 9000 }, 'jasper-tos-barloque'), null);
const foodBill = purchasePlan({ foodGap: 100, menu: [
  { name: 'loaf of bread', cost: 108 }, { name: 'wheel of cheese', cost: 144 }] });
assert.equal(foodBill.expected_cost, 576);
assert.equal(foodBill.lines[0].amount, 4, 'food quantity covers the nutrition gap at the best value');

function keeper({ cash = 50, balance = 5000, herbPrice = 14, refuse = false } = {}) {
  const names = new Map([[1, 'shillings'], [2, 'elderberry'], [3, 'herbs'], [99, 'Joguer']]);
  const k = Object.assign(Object.create(Autopilot.prototype), {
    policy: { buyFood: false, buyReagents: true, shopFloor: 100, walkingMoney: 400 },
    passes: 1, notes: [], actions: [], tally: {},
    money: { trips: 0, trips_failed: 0, why_not: [] },
    note(what, detail) { this.notes.push({ what, detail }); }, progress() {}, tradeFact() {},
    loadout: () => ({ carry: [{ item: 'elderberry', min: 6, max: 6 },
      { item: 'herb', min: 60, max: 60 }] }),
    larder: () => [], makeRoomToBuy: async () => {},
    leaveHold: async () => ({ left: true }), recordPurchase() {},
    contributeGuildWants: async () => {}, sellInTown: async () => null,
    guildTitheFromSale: async () => {}, buyFarmDeliveryCargo: async () => {}, vaultRunIfPassing: async () => {},
  });
  const c = {
    evSeq: 0, rsc: { get: id => names.get(id) },
    inventory: [{ id: 1, nameRsc: 1, amount: cash }], room: { objects: new Map() },
    vitals: () => ({ vigor: { value: 80, scale_max: 200 } }),
    requestInventory() {},
    balance() { k.actions.push(['balance', k.s.world.room.num]); this.reply = 'balance'; },
    withdraw(amount) {
      k.actions.push(['withdraw', amount]);
      assert.ok(amount <= k.balance, 'never ask for more than the confirmed balance');
      if (!refuse) { this.inventory[0].amount += amount; k.balance -= amount; }
      this.reply = 'withdraw';
    },
    deposit(amount) { k.actions.push(['deposit', amount]); this.inventory[0].amount -= amount; k.balance += amount; },
    buy() { this.reply = 'shop'; },
    buyItems(_seller, lines) {
      assert.equal(k.s.world.room.num, 104, 'never use a stale merchant quote at the bank');
      for (const line of lines) {
        const price = line.id === 2 ? 28 : herbPrice;
        assert.ok(this.inventory[0].amount >= price * line.amount + 100);
        k.actions.push(['buy', line.id, line.amount]);
        this.inventory[0].amount -= price * line.amount;
        const item = this.inventory.find(i => i.id === line.id);
        if (item) item.amount += line.amount;
        else this.inventory.push({ id: line.id, nameRsc: line.id, amount: line.amount });
      }
    },
    async waitFor({ kinds }) {
      if (kinds.includes('shop')) return { events: [{ kind: 'shop', sellerId: 99,
        items: [{ id: 2, name: 'elderberry', cost: 28 }, { id: 3, name: 'herbs', cost: herbPrice }] }] };
      if (kinds.includes('message')) return { events: [{ kind: 'message', text:
        this.reply === 'balance' ? `You have ${k.balance} shillings in your account.` : 'Thank you.' }] };
      return { events: [{ kind: 'inventory' }] };
    },
  };
  k.balance = balance;
  k.s = { client: c, need: () => c, world: { room: { num: 584 },
    route: room => ({ found: room !== 2005, hops: Array(room === 54 ? 1 : 3).fill({}) }) },
    bankKnown: () => ({ account: 'jasper-tos-barloque', balance: k.balance }),
    pacer: { submit: async (_lane, fn) => fn() } };
  k.purse = () => k.purseNow();
  k.packAsItems = () => c.inventory.map(i => ({ name: names.get(i.nameRsc), amount: i.amount }));
  k.reagentCount = () => ({ elderberry: c.inventory.find(i => i.id === 2)?.amount ?? 0,
    herbs: c.inventory.find(i => i.id === 3)?.amount ?? 0 });
  k.travel = async room => {
    assert.ok(k.notes.some(n => n.what === 'shopping cost posted'), 'bill posted before departure');
    k.actions.push(['travel', room]); k.s.world.room = { num: room, name: room === 54 ? 'Royal Bank of Tos' : 'shop' };
    return { arrived: true };
  };
  k.sellerHere = async () => k.s.world.room.num === 104 ? { seller: { id: 99, nameRsc: 99 } } : null;
  k.townTrip = { target: { room: 104 }, nextService: -1, startedAt: Date.now() };
  return k;
}

{
  const k = keeper();
  const plan = k.shoppingPlan();
  assert.equal(plan.expected_cost, 6 * 28 + 60 * 14);
  await k.continueTownTrip();
  assert.equal(k.townTrip, null);
  assert.deepEqual(k.actions.filter(a => a[0] === 'travel'), [['travel', 54], ['travel', 104]]);
  assert.deepEqual(k.actions.filter(a => a[0] === 'withdraw'), [['withdraw', 1058]]);
  assert.deepEqual(k.actions.filter(a => a[0] === 'buy'), [['buy', 2, 6], ['buy', 3, 50], ['buy', 3, 10]]);
  assert.equal(k.purseNow(), 100);
  assert.ok(!k.actions.some(a => a[0] === 'deposit'), 'banking preserves the posted purchase reserve');
}
{
  const k = keeper({ cash: 1108 });
  await k.continueTownTrip();
  assert.equal(k.townTrip, null);
  assert.ok(!k.actions.some(a => a[0] === 'balance' || a[0] === 'withdraw'));
  assert.deepEqual(k.actions.filter(a => a[0] === 'travel'), [['travel', 104]]);
}
for (const scenario of [{ balance: 500 }, { refuse: true }]) {
  const k = keeper(scenario);
  await k.continueTownTrip();
  assert.ok(k.townTrip, 'failed funding cannot complete shopping');
  assert.equal(k.townTrip.nextService, -1);
  assert.ok(!k.actions.some(a => a[0] === 'buy' || (a[0] === 'travel' && a[1] === 104)));
  assert.equal(k.purchaseFunding.pending, true);
}
{
  const k = keeper({ balance: 500 });
  await k.continueTownTrip();
  k.balance = 5000; k.townTrip.nextTryAt = 0;
  await k.continueTownTrip();
  assert.equal(k.townTrip, null, 'the original purchase resumes when funds become available');
}
{
  const k = keeper();
  const travel = k.travel;
  k.travel = async () => { k.survivalInterruptedPass = k.passes; k.suspendedJourney = { to: 54 };
    return { arrived: false, paused: true }; };
  await k.continueTownTrip();
  assert.equal(k.townTrip.target.room, 104);
  assert.ok(!k.actions.some(a => a[0] === 'withdraw' || a[0] === 'buy'));
  k.travel = travel; k.survivalInterruptedPass = null; k.suspendedJourney = null; k.townTrip.nextTryAt = 0;
  await k.continueTownTrip();
  assert.equal(k.townTrip, null);
}
{
  const k = keeper({ herbPrice: 20 });
  await k.continueTownTrip();
  assert.ok(k.townTrip, 'a price increase inserts additional funding without completing the purchase');
  assert.ok(!k.actions.some(a => a[0] === 'buy'));
  k.townTrip.nextTryAt = 0;
  await k.continueTownTrip();
  assert.equal(k.townTrip, null);
  assert.deepEqual(k.actions.filter(a => a[0] === 'withdraw'), [['withdraw', 1058], ['withdraw', 360]]);
  assert.equal(k.purseNow(), 100);
}
{
  const k = keeper({ balance: 500 });
  k.s.bankKnown = () => ({ account: 'kocatan', balance: 99999 });
  await k.continueTownTrip();
  assert.ok(!k.actions.some(a => a[0] === 'withdraw'), 'a different account cannot fund this bank');
  assert.ok(k.townTrip);
}
{
  const k = keeper({ cash: 2000 });
  k.s.world.room = { num: 54, name: 'Royal Bank of Tos' };
  k.postShoppingPlan(k.shoppingPlan());
  await k.bankSurplus();
  assert.equal(k.purseNow(), 1108, 'deposit preserves the entire shopping bill and reserve');
  assert.deepEqual(k.actions.filter(a => a[0] === 'deposit'), [['deposit', 892]]);
}
{
  const k = keeper({ cash: 0 });
  assert.equal(k.purseNow(), 0, 'an empty money stack is not one shilling');
  await k.continueTownTrip();
  assert.equal(k.townTrip, null);
  assert.deepEqual(k.actions.filter(a => a[0] === 'withdraw'), [['withdraw', 1108]]);
}
{
  const k = keeper({ balance: 500 });
  k.townTrip.nextService = 4;
  await k.continueTownTrip();
  assert.equal(k.townTrip.nextService, 4, 'bank failure cannot advance the service cursor');
  assert.ok(!k.actions.some(a => a[0] === 'buy'));
}
{
  const k = keeper();
  const wait = k.s.client.waitFor;
  k.s.client.waitFor = async options => options.kinds.includes('message')
    ? { events: [{ kind: 'message', text: 'A passerby says hello.' }] } : wait.call(k.s.client, options);
  await k.continueTownTrip();
  assert.equal(k.purchaseFunding.status, 'waiting for a confirmed bank balance');
  assert.ok(!k.actions.some(a => a[0] === 'withdraw' || a[0] === 'buy'));
}
{
  const k = keeper({ cash: 1108 });
  const travel = k.travel;
  k.townTrip.nextService = 7;
  k.travel = async () => ({ arrived: false, reason: 'door did not open' });
  await k.continueTownTrip();
  assert.equal(k.townTrip.nextService, 7, 'a failed merchant approach is still a shopping task');
  k.travel = travel; k.townTrip.nextTryAt = 0;
  await k.continueTownTrip();
  assert.equal(k.townTrip, null);
}
{
  const k = keeper({ cash: 1108 });
  k.policy.buyReagents = false;
  assert.equal(k.shoppingPlan().required_purse, 0, 'no purchase does not trigger a reserve-only bank trip');
}
console.log('purchase funding integration passed: posted bill, quantities, bank dependency, verified funds, pauses, prices, accounts');
