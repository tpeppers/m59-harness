import assert from 'node:assert/strict';
import { MERCHANT_TIERS, estimateItemSellValue as quote, itemSellValueRule, applySellValueRule } from './m59-item-value.mjs';
const values={'long sword':800,herb:3,free:0,"knight's shield":800};
for(const [merchant,markup] of Object.entries(MERCHANT_TIERS)){
  assert.equal(quote('long sword',{values,merchant}).sell_value,800*(100-10*markup)/100);
}
assert.equal(quote('herb',{values,quantity:3}).sell_value,6,'discount/truncate AFTER multiplying the stack');
assert.equal(quote('herb',{values,quantity:0}).sell_value,0);
assert.equal(quote('free',{values}).sell_value,1,'standard Offer clamps each offered object to one');
assert.equal(quote('missing',{values}).sell_value,null,'unknown is not worthless');
assert.equal(quote('cursed long sword',{values}).sell_value,null,'no guessed suffix/prefix stripping');
assert.equal(quote('  Knight’s   shield ',{values}).sell_value,560);
assert.equal(quote('long sword',{values,condition:{hits:80,maxHits:80,originalMaxHits:100}}).sell_value,358);
assert.equal(quote('long sword',{values,condition:{hits:0,maxHits:80,originalMaxHits:100}}).sell_value,7);
assert.equal(quote('unknown',{values,getValue:91,merchant:'bargain'}).sell_value,81);
assert.equal(quote('long sword',{values}).estimated,true);
assert.equal(quote('long sword',{values}).acceptance,'not-checked');
for(const opts of [{quantity:-1},{quantity:1.5},{quantity:NaN},{merchant:'robbery'},{merchant:6},{getValue:-1},
  {condition:{hits:101,maxHits:100,originalMaxHits:100}},{condition:{hits:1,maxHits:1,originalMaxHits:0}},
  {quantity:2,condition:{hits:1,maxHits:1,originalMaxHits:1}}])assert.throws(()=>quote('long sword',{values,...opts}));
for(const merchant of Object.keys(MERCHANT_TIERS))for(const name of Object.keys(values))for(const quantity of [0,1,2,3,25,10000])
  assert.equal(applySellValueRule(itemSellValueRule(name,{values,merchant}),quantity),quote(name,{values,merchant,quantity}).sell_value);
assert.throws(()=>quote('huge',{values:{huge:Number.MAX_SAFE_INTEGER},quantity:10}));
assert.equal(quote('long sword').sell_value,560,'real checked-in catalog');
console.log('item sell-value tests passed: all tiers, stack rounding, condition, unknowns, validation, portable rule parity');
