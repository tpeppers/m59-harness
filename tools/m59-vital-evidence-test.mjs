import assert from'node:assert/strict';import{M59Client}from'./m59-client.mjs';
const body={statsById:new Map([['health',{value:0,currentMax:78}],['mana',{value:41,currentMax:19}]])};
const v=M59Client.prototype.vitals.call(body);assert.deepEqual(v.mana,{value:41,max:19,pct:216});assert.equal(v.health.value,0);assert.match(v.mana_over_max,/cause is unestablished/);assert.doesNotMatch(v.mana_over_max,/was granted|rather than earned/);
body.statsById.get('mana').value=10;assert.equal(M59Client.prototype.vitals.call(body).mana_over_max,undefined);
console.log('asynchronous post-death ceiling changes retain raw values and uncertainty; no unsupported grant attribution');
