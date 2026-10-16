import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{World}from'./m59-world.mjs';
const me={row:1,col:1,x:96,y:96},room={num:123,roo:'fixture'};const world=Object.create(World.prototype);world.map={rooms:{123:room}};
Object.defineProperties(world,{room:{get:()=>room},geometry:{get:()=>({})},self:{get:()=>me}});world.origin=()=>({row:me.row,col:me.col});world._dynamicPortalExits=()=>[];
let plans=0;world._computeExits=()=>{plans++;return[{to:124,direction:'east'}]};
assert.equal(world.exits({cachedOnly:true}),null);assert.equal(plans,0,'status must not perform a cold route search');
assert.equal(world.exits()[0].to,124);assert.equal(plans,1);
assert.equal(world.exits({cachedOnly:true})[0].to,124);assert.equal(plans,1);
me.x+=8;assert.equal(world.exits({cachedOnly:true}),null,'fine body motion invalidates the old answer');assert.equal(plans,1);
assert.equal(world.exits()[0].to,124);assert.equal(plans,2,'a real movement caller still computes its new origin');
const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');assert(source.includes('exits?.({cachedOnly:true})'),'keeper state must request cached exits');
console.log('Cached exit status: cold reads do not route; exact-origin cache hits and movement searches retained');

world.origin=()=>null;assert.equal(world.exits({cachedOnly:true}),null);assert.equal(plans,2,'an unknown origin cannot trigger status routing');
