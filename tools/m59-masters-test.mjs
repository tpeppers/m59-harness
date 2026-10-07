// OFFLINE. Pins m59-masters' pass: masters rebalance first, donors only in the same room, keeps
// respected, small hand-overs skipped, and the remainder is the demand. `node tools/m59-masters-test.mjs`.
import { planMasters } from './m59-masters.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };

const masters = { t5: { 'entroot berry': 120, 'fairy wing': 60 }, t7: { 'fairy wing': 60, 'purple mushroom': 120 } };
const holdings = {
  t5: { room: 38, items: { 'entroot berry': 9, 'fairy wing': 130, 'purple mushroom': 0 } },
  t7: { room: 38, items: { 'entroot berry': 0, 'fairy wing': 0, 'purple mushroom': 40 } },
  t1: { room: 38, items: { 'entroot berry': 56, 'fairy wing': 0, 'purple mushroom': 20 } },
  t18: { room: 2, items: { 'entroot berry': 300, 'fairy wing': 0, 'purple mushroom': 50 } },
  t4: { room: 38, items: { 'entroot berry': 0, 'fairy wing': 0, 'purple mushroom': 3 } },
};
const r = planMasters({ holdings, masters, donors: ['t1', 't18', 't4'], donorKeep: { 'entroot berry': 6 } });
const mv = (f, t, i) => r.moves.find(m => m.from === f && m.to === t && m.item === i);
ok(mv('t5', 't7', 'fairy wing')?.amount === 60, 'a master gives its surplus above its own target to a master short of it');
ok(mv('t1', 't5', 'entroot berry')?.amount === 50, 'a same-room donor gives, keeping donor_keep (56-6)');
ok(!r.moves.some(m => m.from === 't18'), 'a donor in another room is never asked (nobody walks)');
ok(mv('t1', 't7', 'purple mushroom')?.amount === 20, 'purple mushrooms from the donor beside her');
ok(!mv('t4', 't7', 'purple mushroom'), 'a hand-over under min_transfer is skipped');
ok(r.demand.t5['entroot berry'] === 61 && r.demand.t7['purple mushroom'] === 60, `the rest is the demand (${JSON.stringify(r.demand)})`);
ok(!r.demand.t7['fairy wing'], 'a need met in this pass is not demanded');
const capped = planMasters({ holdings, masters, donors: ['t1'], maxTransfers: 1 });
ok(capped.moves.length === 1, 'max_transfers bounds a pass');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
