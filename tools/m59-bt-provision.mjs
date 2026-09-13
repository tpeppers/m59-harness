// Behavior-tree decomposition of provision() — the food and vigor management loop.
//
// The original provision() is a ~80-line sequential method that:
// 1. Checks the larder (food in the pack)
// 2. If empty, tries to cook (cast create food)
// 3. If can't cook, checks money
// 4. If no money, withdraws from the bank
// 5. If still no money, continues farming to fight for loot
// 6. If has money, buys food in town
// 7. Eats the food
//
// This module decomposes that into atomic, testable nodes that can be
// reordered and composed in a behavior tree.

import {
  Selector, Sequence, Condition, Action,
  SUCCESS, FAILURE, RUNNING,
} from './m59-bt.mjs';

// AsyncAction: wraps an async function into a BT Action node.
// The async tick() on the tree handles the awaiting.
class AsyncAction {
  constructor(fn, opts = {}) {
    this.fn = fn;
    this.key = opts.key || `aa_${Math.random().toString(36).slice(2, 10)}`;
    this._name = opts.name || 'AsyncAction';
  }
  // Synchronous tick: starts the promise, returns RUNNING.
  tick(bb) {
    if (!bb._bt) bb._bt = {};
    const slot = bb._bt[this.key];
    if (slot && slot.done) { delete bb._bt[this.key]; return slot.result; }
    if (slot && slot.promise) return RUNNING;
    const p = this.fn(bb, {});
    if (p && typeof p.then === 'function') {
      p.then(
        (r) => { bb._bt[this.key] = { done: true, result: r }; },
        (e) => { bb._bt[this.key] = { done: true, result: FAILURE, error: e }; }
      );
      return RUNNING;
    }
    return p || SUCCESS;
  }
}

// === 1. checkLarderNode ===
// Check if there's food in the pack. Returns SUCCESS if food is found, FAILURE if not.
export function checkLarderNode(keeper) {
  return new Action((bb) => {
    const larder = keeper.larder(keeper.s.client);
    bb.larder = larder;
    bb.hasFood = larder.length > 0;
    bb.bestFood = larder[0]?.food ?? null;
    bb.smallestFood = larder.reduce((m, x) => (!m || x.food.filling < m.filling ? x.food : m), null);
    return bb.hasFood ? SUCCESS : FAILURE;
  }, { name: 'checkLarder' });
}

// === 2. castNode ===
// Cast a spell. Generalized to cast any spell, not just create food.
// Parameters:
// - spellName: the name of the spell to cast (e.g., 'create food')
// - target: optional target for the spell
//   - null: no target (self-cast or no-target spell)
//   - 'self': cast on yourself
//   - { rsc: '...', name: '...' }: cast on a specific entity (player, monster, NPC)
// Returns SUCCESS if the spell was cast, FAILURE if not.
export function castNode(keeper, spellName, target = null) {
  return new AsyncAction(async (bb) => {
    const { s } = keeper;
    // Check if the character knows the spell
    const spells = keeper.s.client.spells ?? [];
    const spell = spells.find(sp => sp.name === spellName);
    if (!spell) {
      bb.castResult = { success: false, reason: 'does not know spell' };
      return FAILURE;
    }
    
    // Resolve the target
    let targetRsc = null;
    let targetName = null;
    if (target === 'self') {
      // Cast on yourself
      targetRsc = keeper.s.client.me?.rsc;
      targetName = keeper.s.client.me?.name;
    } else if (target && typeof target === 'object') {
      // Cast on a specific entity
      targetRsc = target.rsc;
      targetName = target.name;
    }
    // If target is null, the spell is self-cast or has no target
    
    // Cast the spell
    try {
      const result = await s.pacer.submit('cast', () => 
        keeper.s.client.cast(spellName, targetRsc)
      );
      bb.castResult = { success: true, result, spell: spellName, target: targetName };
      keeper.note('cast spell', { spell: spellName, target: targetName, result });
      return SUCCESS;
    } catch (err) {
      bb.castResult = { success: false, reason: err.message, spell: spellName, target: targetName };
      return FAILURE;
    }
  }, { name: `cast_${spellName}` });
}

// === 3. checkMoneyNode ===
// Check if the character has enough money to buy food.
// Parameters:
// - minAmount: minimum amount of money required
// Returns SUCCESS if the character has enough money, FAILURE if not.
export function checkMoneyNode(keeper, minAmount = 400) {
  return new Action((bb) => {
    bb.purse = keeper.purse();
    bb.hasMoney = bb.purse >= minAmount;
    return bb.hasMoney ? SUCCESS : FAILURE;
  }, { name: 'checkMoney' });
}

// === 4. withdrawFromBankNode ===
// Withdraw money from the bank.
// Returns SUCCESS only when the posted purchase is funded, including cash already held.
export function withdrawFromBankNode(keeper) {
  return new AsyncAction(async (bb) => {
    try {
      const before = keeper.purse?.() ?? keeper.purseNow?.() ?? 0;
      const result = await keeper.withdrawForFood();
      bb.purchaseFunding = keeper.purchaseFunding ?? result;
      bb.withdrewMoney = (keeper.purse?.() ?? keeper.purseNow?.() ?? 0) > before;
      return result?.ready === true ? SUCCESS : FAILURE;
    } catch (err) {
      bb.withdrewMoney = false;
      return FAILURE;
    }
  }, { name: 'withdrawFromBank' });
}

// === 5. buyFoodNode ===
// Buy food in town.
// Returns SUCCESS if food was bought, FAILURE if not.
export function buyFoodNode(keeper) {
  return new AsyncAction(async (bb) => {
    try {
      await keeper.buyFoodInTown();
      // Check if we got food
      const newLarder = keeper.larder(keeper.s.client);
      bb.boughtFood = newLarder.length > 0;
      if (bb.boughtFood) {
        keeper.note('bought food in town', { items: newLarder.length });
      }
      return bb.boughtFood ? SUCCESS : FAILURE;
    } catch (err) {
      bb.boughtFood = false;
      return FAILURE;
    }
  }, { name: 'buyFood' });
}

// === 6. eatNode ===
// Eat food from the larder.
// Returns SUCCESS if food was eaten, FAILURE if not.
export function eatNode(keeper) {
  return new AsyncAction(async (bb) => {
    const { s } = keeper;
    try {
      const result = await s.pacer.submit('eat', () => 
        keeper.s.client.eat({ 
          upToVigor: keeper.policy.vigorCeiling || 200 
        })
      );
      bb.ate = result.ate?.length > 0;
      if (bb.ate) {
        keeper.note('ate food', { 
          ate: result.ate, 
          vigor: result.vigor 
        });
      }
      return bb.ate ? SUCCESS : FAILURE;
    } catch (err) {
      bb.ate = false;
      return FAILURE;
    }
  }, { name: 'eat' });
}

// === 7. provisionTree ===
// The complete provision tree that manages food and vigor.
// Structure:
// Selector (fallback):
//   1. Sequence:
//      - CheckLarder
//      - EatNode (if we have food)
//   2. Sequence:
//      - CastNode (create food)
//      - EatNode
//   3. Sequence:
//      - FundPurchase (withdraw the shortfall when needed)
//      - BuyFood
//      - EatNode

export function provisionTree(keeper) {
  return new Selector([
    // If we have food, eat it
    new Sequence([
      checkLarderNode(keeper),
      eatNode(keeper)
    ]),
    // If we don't have food, try to cook
    new Sequence([
      castNode(keeper, 'create food'),
      eatNode(keeper)
    ]),
    // Purchase funding is a prerequisite, including when money is already in hand.
    new Sequence([
      withdrawFromBankNode(keeper),
      buyFoodNode(keeper),
      eatNode(keeper)
    ])
  ]);
}
