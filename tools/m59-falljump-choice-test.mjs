import assert from 'node:assert/strict';import{selectDeclaredFall}from'./m59-falljump.mjs';
const left={from:{row:32,col:55},to:{row:25,col:55}},right={from:{row:32,col:56},to:{row:25,col:56}};
assert.equal(selectDeclaredFall([left,right],{from:right.from,to:right.to}),right);
assert.equal(selectDeclaredFall([right,left],{from:left.from,to:left.to}),left);
assert.equal(selectDeclaredFall([left],{from:{row:32,col:56},to:{row:25,col:56}}),left,'existing nearby variation still selects an eligible declaration');
assert.equal(selectDeclaredFall([],{from:right.from,to:right.to}),null);
const remote={from:{row:31,col:56},to:right.to};assert.equal(selectDeclaredFall([remote,right],{from:right.from,to:right.to}),right);
console.log('declared fall selection: exact adjacent lanes and guarded fallback passed');
