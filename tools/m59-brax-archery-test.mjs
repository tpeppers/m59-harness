// Offline: run the courier's real sale through the native keeper dispatcher.
// Spare bows must survive even when the one-weapon equipment planner ranks them
// as excess. Arrows are cargo, not a way to fund the next mainland shopping trip.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BraxSupplyService} from './m59-brax-supply.mjs';
import {Session} from './m59-game.mjs';
import * as skills from './m59-skills.mjs';
import {saleBlocked} from './m59-inventory-intent.mjs';
const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8'),start=source.indexOf("case 'sell_all': {"),end=source.indexOf('// APPLY IS NOT USE',start);
const dispatch=new (Object.getPrototypeOf(async function(){}).constructor)('session','args','skills','autopilot','setTimeout','saleBlocked',`let result; switch ('sell_all') { ${source.slice(start,end)} } return result;`);
const cargo=['hammer','practice bow','practice bow','long bow','battle bow','nerudite bow','magic bow','arrows','silver arrows','nerudite arrows','fire arrows','diamond','shilling'];
const c={using:new Set([1]),inventory:cargo.map((name,i)=>({id:i+1,nameRsc:i+1,amount:/arrows|diamond|shilling/.test(name)?20:0})),rsc:new Map(cargo.map((n,i)=>[i+1,n])),
 equipment:()=>({known:true,equipped:[{id:1,name:'hammer'}]}),room:{objects:new Map([[99,{id:99}]])},evSeq:1,offered:[],
 requestInventory(){},cancelOffer(){},waitFor:async()=>({events:[{kind:'countered'}]}),
 offer(_,items){this.pending=items[0];this.offered.push(this.pending.id??this.pending);this.trade={theirs:[{amount:5}]};},
 acceptOffer(){const id=this.pending.id??this.pending;this.inventory=this.inventory.filter(o=>o.id!==id);}};
const session={client:c,need:()=>c,movementGeneration:0,startJob:Session.prototype.startJob,runCommand:Session.prototype.runCommand,pacer:{submit:async(_,fn)=>fn()}};
const service=new BraxSupplyService({actors:[{shadow_account:'runner',role:'farmer'}],runner:'runner',couriers:['a','b'],runLeg(){},read(){},
 call:async(name,args)=>name==='inventory'?{items:c.inventory.map(o=>({...o,name:c.rsc.get(o.nameRsc)}))}:
  dispatch(session,args,skills,{protectedItemNames:()=>[],policy:{}},fn=>fn(),saleBlocked)});
service.townTravel=async()=>{};
const receipt=await service.sell('a',374,99);assert.equal(receipt.error,undefined,JSON.stringify(receipt));
assert.deepEqual(c.offered,[cargo.indexOf('diamond')+1],'ordinary gems still sell; no imported bow or ammunition is offered');
assert.deepEqual(c.inventory.map(o=>c.rsc.get(o.nameRsc)),cargo.filter(n=>n!=='diamond'));
console.log('PASS actual courier/native sale retains spare bows and all arrow stacks while selling ordinary loot');
