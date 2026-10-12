// Offline: buy-by-name against a seller's offer. Opens no socket.
//
//   node tools/m59-shop-names-test.mjs
import { resolveBuyNames } from './m59-shop-names.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log(`  ok   ${what}`); } else { failed++; console.log(`  FAIL ${what}`); } };

// Zhieu B'hob's counter in Jasper (jsmerch.kod SetForSale), as the shop tool reads it.
const offer = [{ id: 501, name: 'elderberry' }, { id: 502, name: 'herbs' }, { id: 503, name: 'purple mushroom' },
               { id: 504, name: 'blue mushroom' }, { id: 505, name: 'mushroom' }];

const a = resolveBuyNames(offer, [{ name: 'elderberry', amount: 60 }]);
ok('an exact name becomes one buy line with its amount', a.buy_ids.length === 1 && a.buy_ids[0].id === 501 && a.buy_ids[0].amount === 60);
ok('plural asked, singular offered', resolveBuyNames(offer, [{ name: 'elderberries', amount: 3 }]).buy_ids[0]?.id === 501);
ok('singular asked, plural offered', resolveBuyNames(offer, [{ name: 'herb', amount: 3 }]).buy_ids[0]?.id === 502);
ok('a longer name is never matched by a shorter one', resolveBuyNames(offer, [{ name: 'mushroom' }]).buy_ids[0]?.id === 505);
const miss = resolveBuyNames(offer, [{ name: 'orc tooth', amount: 5 }, { name: 'elderberry', amount: 2 }]);
ok('a name the seller does not sell is reported, not guessed', miss.unmatched.join() === 'orc tooth' && miss.buy_ids.length === 1);
ok('no amount means one', resolveBuyNames(offer, [{ name: 'elderberry' }]).buy_ids[0].amount === 1);
ok('an empty name matches nothing', resolveBuyNames(offer, [{ name: '' }]).buy_ids.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
