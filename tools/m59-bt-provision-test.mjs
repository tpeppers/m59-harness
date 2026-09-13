// Tests for the behavior tree decomposition of provision()
//
//   node tools/m59-bt-provision-test.mjs

import { 
  checkLarderNode, castNode, checkMoneyNode, 
  withdrawFromBankNode, buyFoodNode, eatNode, provisionTree 
} from './m59-bt-provision.mjs';
import { SUCCESS, FAILURE } from './m59-bt.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

console.log('\ncheckLarderNode:');
{
  const keeper = {
    s: { client: {} },
    larder: () => [{ food: { filling: 50, nutrition: 10 } }]
  };
  const node = checkLarderNode(keeper);
  const bb = {};
  const result = node.tick(bb);
  check('returns SUCCESS when food is found', result === SUCCESS);
  check('sets bb.hasFood to true', bb.hasFood === true);
  check('sets bb.bestFood', bb.bestFood.filling === 50);
}
{
  const keeper = {
    s: { client: {} },
    larder: () => []
  };
  const node = checkLarderNode(keeper);
  const bb = {};
  const result = node.tick(bb);
  check('returns FAILURE when no food', result === FAILURE);
  check('sets bb.hasFood to false', bb.hasFood === false);
}

console.log('\ncastNode:');
{
  const keeper = {
    s: {
      client: {
        spells: [{ name: 'create food', level: 1, mana: 10 }],
        cast: async (spellName, targetRsc) => ({ success: true, spellName, targetRsc })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const node = castNode(keeper, 'create food');
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when spell is known and cast', result === SUCCESS);
  check('sets bb.castResult.success to true', bb.castResult?.success === true);
}
{
  const keeper = {
    s: {
      client: {
        spells: [],
        cast: async () => ({ success: true })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const node = castNode(keeper, 'create food');
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when spell is not known', result === FAILURE);
  check('sets bb.castResult.reason', bb.castResult?.reason === 'does not know spell');
}
console.log('\ncastNode with self target:');
{
  let castTarget = null;
  const keeper = {
    s: {
      client: {
        me: { rsc: 12345, name: 'TestChar' },
        spells: [{ name: 'heal', level: 1, mana: 15 }],
        cast: async (spellName, targetRsc) => {
          castTarget = targetRsc;
          return { success: true, spellName, targetRsc };
        }
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const node = castNode(keeper, 'heal', 'self');
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when casting on self', result === SUCCESS);
  check('sets bb.castResult.target to self', bb.castResult?.target === 'TestChar');
  check('passes self RSC to cast', castTarget === 12345);
}
console.log('\ncastNode with entity target:');
{
  let castTarget = null;
  const keeper = {
    s: {
      client: {
        spells: [{ name: 'zap', level: 1, mana: 20 }],
        cast: async (spellName, targetRsc) => {
          castTarget = targetRsc;
          return { success: true, spellName, targetRsc };
        }
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    note: () => {}
  };
  const target = { rsc: 99999, name: 'TestMonster' };
  const node = castNode(keeper, 'zap', target);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when casting on entity', result === SUCCESS);
  check('sets bb.castResult.target to entity name', bb.castResult?.target === 'TestMonster');
  check('passes entity RSC to cast', castTarget === 99999);
}

console.log('\ncheckMoneyNode:');
{
  const keeper = {
    purse: () => 500
  };
  const node = checkMoneyNode(keeper, 400);
  const bb = {};
  const result = node.tick(bb);
  check('returns SUCCESS when purse >= minAmount', result === SUCCESS);
  check('sets bb.hasMoney to true', bb.hasMoney === true);
}
{
  const keeper = {
    purse: () => 300
  };
  const node = checkMoneyNode(keeper, 400);
  const bb = {};
  const result = node.tick(bb);
  check('returns FAILURE when purse < minAmount', result === FAILURE);
  check('sets bb.hasMoney to false', bb.hasMoney === false);
}

console.log('\nwithdrawFromBankNode:');
{
  let cash = 50;
  const keeper = {
    purseNow: () => cash,
    withdrawForFood: async () => { cash = 1000; return { ready: true }; },
    note: () => {}
  };
  const node = withdrawFromBankNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when withdrawal succeeds', result === SUCCESS);
  check('sets bb.withdrewMoney to true', bb.withdrewMoney === true);
}
{
  const keeper = {
    withdrawForFood: async () => { throw new Error('no bank here'); },
    note: () => {}
  };
  const node = withdrawFromBankNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when withdrawal fails', result === FAILURE);
  check('sets bb.withdrewMoney to false', bb.withdrewMoney === false);
}
for (const response of [undefined, { ready: false, pending: true }]) {
  const node = withdrawFromBankNode({ withdrawForFood: async () => response, purseNow: () => 50 });
  const bb = {};
  node.tick(bb);
  await new Promise(resolve => setTimeout(resolve, 10));
  check('unfunded purchase cannot pass the banking prerequisite', node.tick(bb) === FAILURE);
}

console.log('\nbuyFoodNode:');
{
  let larderEmpty = true;
  const keeper = {
    s: { client: {} },  // Add s.client
    buyFoodInTown: async () => { larderEmpty = false; },  // Simulate buying food
    larder: () => larderEmpty ? [] : [{ food: { filling: 50 } }],
    note: () => {}
  };
  const node = buyFoodNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when food is bought', result === SUCCESS);
  check('sets bb.boughtFood to true', bb.boughtFood === true);
}
{
  const keeper = {
    buyFoodInTown: async () => {},
    larder: () => [],
    note: () => {}
  };
  const node = buyFoodNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when no food is bought', result === FAILURE);
  check('sets bb.boughtFood to false', bb.boughtFood === false);
}

console.log('\neatNode:');
{
  const keeper = {
    s: {
      client: {
        eat: async () => ({ ate: ['bread'], vigor: 150 })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    policy: { vigorCeiling: 200 },
    note: () => {}
  };
  const node = eatNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns SUCCESS when food is eaten', result === SUCCESS);
  check('sets bb.ate to true', bb.ate === true);
}
{
  const keeper = {
    s: {
      client: {
        eat: async () => ({ ate: [], vigor: 100 })
      },
      pacer: { submit: async (tag, fn) => fn() }
    },
    policy: { vigorCeiling: 200 },
    note: () => {}
  };
  const node = eatNode(keeper);
  const bb = {};
  // First tick starts the async operation
  let result = node.tick(bb);
  check('first tick returns RUNNING', result === 'RUNNING');
  // Wait for the promise to resolve
  await new Promise(r => setTimeout(r, 10));
  result = node.tick(bb);
  check('second tick returns FAILURE when no food is eaten', result === FAILURE);
  check('sets bb.ate to false', bb.ate === false);
}

console.log('\nprovisionTree:');
{
  const keeper = {
    s: { client: {} },
    larder: () => [{ food: { filling: 50, nutrition: 10 } }],
    purse: () => 500,
    withdrawForFood: async () => {},
    buyFoodInTown: async () => {},
    note: () => {},
    policy: { vigorCeiling: 200, walkingMoney: 400 }
  };
  const tree = provisionTree(keeper);
  check('provisionTree returns a tree', tree !== null && tree !== undefined);
  check('tree has a tick method', typeof tree.tick === 'function');
}

// ---------------------------------------------------------------------------
// provision() refill-low gate: a LOW larder (not just empty) in town should
// trigger the cook/buy/withdraw refill path, not wait until the larder is empty.
// The gate is the inTown + buyFood + foodNeededAboveCap>0 + larderVigor<threshold
// conjunction inside provision(). We test it by calling provision() on a mock
// keeper that is in a town, has a low larder, and a fight floor above the resting
// cap -- and assert it attempts to refill (cook/buy) rather than just eating.
//
// THE BUG THIS TEST GUARDS: provision()'s buy-food path called this.purse(), which
// is not a method on Autopilot -- the real method is purseNow(). A mock that set
// k.purse (matching the buggy code) masked the crash. Lee looped "too tired to start
// a fight" for ever because provision threw TypeError on this.purse before it could
// eat or buy. The mock must set purseNow, the method the real code calls.
// ---------------------------------------------------------------------------
console.log('\nprovision() refill-low gate:');
{
  // Minimal mock: the parts of provision() the refill-low path touches.
  const { Autopilot } = await import('./m59-autopilot.mjs');
  let cookCalled = 0, buyCalled = 0, withdrawCalled = 0;
  const k = Object.create(Autopilot.prototype);
  k.policy = { buyFood: true, walkingMoney: 400, vigorCeiling: 200, restVigorCap: 0.4 };
  k.s = { client: {}, world: { room: { name: 'Market square in the city of Tos' } } };
  k.larder = () => [{ food: { filling: 5, nutrition: 5, vigor: 5 } }];  // 1 mushroom, low
  k.fightFloor = () => 130;  // needs 130; resting cap 80 -> needs 50 above cap
  k.purseNow = () => 1;  // poor (purseNow, the real method name -- NOT purse)
  k.inTown = () => true;
  k.cookSomething = async () => { cookCalled++; return false; };
  k.buyFoodInTown = async () => { buyCalled++; return {}; };
  k.withdrawForFood = async () => { withdrawCalled++ };
  k.reagentCount = () => ({ elderberry: 1, herb: 1 });
  k.warnedNoFood = false;
  k.note = () => {};
  let threw = false, res;
  try { res = await k.provision({ vigorCeiling: 200 }, { vigor: { value: 80, max: 200 } }); } catch (e) { threw = true; res = e; }
  check('refill-low path does not throw (purseNow, not purse)', !threw, threw ? String(res) : '');
  check('low larder in town attempts a refill (cook)', cookCalled >= 1);
  check('low larder in town with no money attempts a withdraw', withdrawCalled >= 1);
}

// THE BUG THIS TEST GUARDS: larderVigor read x.food?.vigor, a field that does not
// exist (the food table has nutrition, not vigor), so larderVigor was always 0 and
// refillLow was always true whenever foodNeededAboveCap > 0. A character in town with
// a full larder of edible mushrooms (nutrition 5) would abandon the food, go to the
// bank/merchant, spend the pass on a failed buy, and loop "too tired to start a fight".
// The fix: larderVigor sums food.nutrition, so a larder that can bridge the floor does
// NOT trigger the refill path.
console.log('\nprovision() refill-low uses nutrition (not the nonexistent vigor field):');
{
  const { Autopilot } = await import('./m59-autopilot.mjs');
  let cookCalled = 0, buyCalled = 0;
  const k = Object.create(Autopilot.prototype);
  k.policy = { buyFood: true, walkingMoney: 400, vigorCeiling: 200, restVigorCap: 0.4 };
  k.s = { client: {}, world: { room: { name: 'Market square in the city of Tos' } } };
  // larder has one edible mushroom: nutrition 5, filling 15. NO 'vigor' field.
  // fightFloor 85, restCap 80 -> foodNeededAboveCap 5. larderVigor (nutrition) = 5.
  // 5 < 5 is false -> refillLow false -> does NOT enter the refill/buy path.
  k.larder = () => [{ food: { filling: 15, nutrition: 5 } }];
  k.fightFloor = () => 85;
  k.purseNow = () => 1;
  k.cookSomething = async () => { cookCalled++; return false; };
  k.buyFoodInTown = async () => { buyCalled++; return {}; };
  k.withdrawForFood = async () => {};
  k.reagentCount = () => ({ elderberry: 0, herb: 0 });
  k.warnedNoFood = false;
  k.note = () => {};
  k.stomach = { level: 0, roomFor: () => true, secondsUntilRoomFor: () => 0 };
  k.protectedItemNames = () => [];
  k.climbing = false;
  let threw = false, res;
  try { res = await k.provision({ vigorCeiling: 200 }, { vigor: { value: 83, max: 200 } }); } catch (e) { threw = true; res = e; }
  check('full larder (nutrition covers the floor) does not trigger refill', cookCalled === 0 && buyCalled === 0,
        `cook=${cookCalled} buy=${buyCalled} res=${res} err=${threw ? String(res) : 'none'}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
