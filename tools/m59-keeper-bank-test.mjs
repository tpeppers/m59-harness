import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBankerLine } from './m59-vaults.mjs';
const source=readFileSync(new URL('./m59-keeper-process.mjs',import.meta.url),'utf8');
const start=source.indexOf("case 'bank': {");
const end=source.indexOf('// THE VAULT COUNTER',start);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const dispatch=new AsyncFunction('session','args','isBankerLine',`let result; const json=v=>result=v;
  await (async()=>{switch('bank'){${source.slice(start,end)}}})(); return result;`);
for(const op of ['withdraw','deposit','balance']) {
  const message=op==='withdraw'?'Here are your 10 shillings. Thank you for your business.'
    :'You have 100 shillings in your account.';
  let requested=false;
  const c={evSeq:0,withdraw(){requested=true;},deposit(){requested=true;},balance(){requested=true;},
    async waitFor({kinds,match}) {
      assert.ok(requested);
      // The server first updates the inventory, then a guildmate's login hail lands, then the receipt (prod 2026-10-27).
      const packets=[{kind:'inventory'},{kind:'message',text:'Hail your guildmate Fozzie!'},{kind:'message',text:message}];
      return {events:[packets.find(e=>(!kinds || kinds.includes(e.kind)) && (!match || match(e)))]};
    }};
  const r=await dispatch({client:c,pacer:{submit:async(_kind,fn)=>fn()}},{op,amount:10},isBankerLine);
  assert.deepEqual(r.said,[message],op+' waits past the earlier inventory packet and the guild hail, for the banker\'s own line');
}
console.log('keeper bank receipts wait for banker prose after early inventory packets');
