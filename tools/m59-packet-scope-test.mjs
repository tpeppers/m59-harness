import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {withPacketScope,bindPacketScope} from './m59-packet-scope.mjs';
// Exercise the actual queue/pump body without importing a socket-owning Session.
const source=readFileSync(new URL('./m59-game.mjs',import.meta.url),'utf8');
const from=source.indexOf('class Pacer {'),to=source.indexOf('// ---------------------------------------------------------------- session',from);
assert.ok(from>0&&to>from);
const Pacer=Function('bindPacketScope','PACKETS_PER_SECOND','DOOR_SETTLE_MS','remainingDoorSettle',
 source.slice(from,to)+';return Pacer;')(bindPacketScope,100000,300,()=>0);
const pacer=new Pacer(),sent=[];let owned=true;
const guarded=withPacketScope(()=>{if(!owned)throw Error('lost lease');},
 ()=>pacer.submit('move',()=>sent.push('command')));
const survival=pacer.submit('rest',()=>{
 sent.push('survival');
 // Nested packet must inherit the SUBMITTER'S empty scope, not the pump's old one.
 return bindPacketScope('turn',()=>sent.push('ordinary nested'))();
});
owned=false;
await assert.rejects(guarded,/lost lease/);await survival;
assert.deepEqual(sent,['survival','ordinary nested']);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(pacer.running,false);
console.log('PASS real Pacer: delayed packet revocation, independent survival and nested scope isolation');
