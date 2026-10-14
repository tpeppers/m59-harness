import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const broker=readFileSync(new URL('./m59-broker.mjs',import.meta.url),'utf8');
const keeper=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
const calls=[];
class KeeperProxy{
 async walkFine(x,y,options){calls.push({kind:'fine',x,y,options});return {arrived:true};}
 async walkTo(col,row,options){calls.push({kind:'square',col,row,options});return {arrived:true};}
}
const session=new KeeperProxy();
const block=broker.slice(broker.indexOf("name: 'walk_to'"),broker.indexOf("name: 'movement_mode'"));
const first=block.indexOf('run: ')+5,last=block.lastIndexOf('\n    },');
const run=runInNewContext('('+block.slice(first,last)+'\n    })',{
 KeeperProxy,Set,session:()=>session,num:(value,fallback)=>value==null?fallback:Number(value),KOD_FINENESS:64,
 mcpOrigin:()=>({source:'mcp',name:'test'}),WALK_ORDERS_REGISTERED:new WeakSet(),withMoveOrder:(_s,_o,fn)=>fn()
});
for(const request of [{x:2152,y:1392},{col:33,row:21,fine:true},{col:33,row:21,fine:false}]){
 await run({agent:'fixture',...request,avoid_squares:[{row:1,col:41}]});
 assert(calls.at(-1).options.avoidSquares.has('1,41'));
}
function proxyMethod(name){
 const from=broker.indexOf('  async '+name+'('),to=broker.indexOf('\n  }',from)+4;
 assert(from>=0&&to>from);
 return runInNewContext('({'+broker.slice(from,to)+'})',{
  Set,keeperAction:(_name,_index,kind,args)=>{calls.push({kind,args:JSON.parse(JSON.stringify(args))});return args;}
 });
}
for(const name of ['walkFine','walkTo']){
 const proxy=proxyMethod(name);proxy.name='fixture';proxy._index=0;
 await proxy[name](33,21,{avoidSquares:new Set(['1,41'])});
 assert.deepEqual(calls.at(-1).args.avoidSquares,['1,41'],'the JSON boundary must preserve the constraint');
}
for(const kind of ['walk','walk_fine']){
 const from=keeper.indexOf("          case '"+kind+"': {"),to=keeper.indexOf('\n          }',from)+12;
 assert(from>=0&&to>from);
 let seen;
 const execute=runInNewContext('(async function(args){switch('+JSON.stringify(kind)+'){'+keeper.slice(from,to)+'}})',{
  Set,currentSurvivalDecision:()=>null,session:{walkTo:async(_c,_r,options)=>{seen=options;return {};},walkFine:async(_x,_y,options)=>{seen=options;return {};}},
  asWalkOrder:(_args,_label,fn)=>fn(),json:()=>{}
 });
 await execute({col:33,row:21,x:2152,y:1392,avoidSquares:['1,41']});
 assert(seen.avoidSquares.has('1,41'),'the keeper reconstructs the forbidden-square set');
}
{
 const from=keeper.indexOf("          case 'walk_fine': {"),to=keeper.indexOf('\n          }',from)+12;
 let dispatched=false,response;
 const execute=runInNewContext('(async function(args){switch("walk_fine"){'+keeper.slice(from,to)+'}})',{
  Set,currentSurvivalDecision:()=>({id:'owned-recovery',source:'keeper',strategy:'nearest_refuge',status:'approaching',ended_at:null}),
  session:{client:{vitals:()=>({health:{value:14,max:20}})},walkFine:async()=>{dispatched=true;return {};}},
  asWalkOrder:(_args,_label,fn)=>fn(),json:r=>{response=r;}
 });
 await execute({x:2152,y:1392,origin:{source:'fleetscript',name:'courier'}});
 assert.equal(dispatched,false);assert.equal(response.reason,'keeper_recovery_active');
}
console.log('Forbidden squares survive fine/square dispatch, proxy JSON and keeper execution.');
