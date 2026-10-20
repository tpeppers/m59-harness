#!/usr/bin/env node
// Construction-stage reconciliation only. Never run against an active trial.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {mirrorShadowLoginPositions} from './m59-shadow-fidelity.mjs';
import {dm,resolve} from './m59-dm.mjs';
import {rosterGameEndpoint} from './m59-fleetpath.mjs';
export function positionSetupRefusal({fleet,server,construction,apply}){
 const match=/^(127\.0\.0\.1|localhost):(\d+)$/.exec(server??'');
 if(!fleet||fleet==='prod'||!match||Number(match[2])===5959)return 'explicit local non-production construction fleet required';
 if(apply&&!construction)return 'saved login position changes require the construction stage';
 return null;
}
export async function main(argv=process.argv.slice(2)){
 const flag=name=>{const i=argv.indexOf('--'+name);return i<0?null:argv[i+1];};
 const apply=argv.includes('--apply'),why=positionSetupRefusal({fleet:flag('fleet'),server:flag('server'),construction:argv.includes('--construction'),apply});
 if(why)throw Error(why);
 const roster=flag('roster');if(!roster)throw Error('explicit construction roster required');
 const endpoint=rosterGameEndpoint(roster),[host,port]=flag('server').split(':');
 if(!endpoint||Number(endpoint.port)!==Number(port)||!['127.0.0.1','localhost'].includes(endpoint.host)||!['127.0.0.1','localhost'].includes(host))throw Error('construction roster game server mismatch');
 const snapshot=JSON.parse(readFileSync(flag('snapshot'),'utf8')),admin=flag('admin')?.split(':');
 if(!admin||!['127.0.0.1','localhost'].includes(admin[0])||!Number.isInteger(Number(admin[1])))throw Error('explicit loopback maintenance address required');
 const env={...process.env,M59_ADMIN_HOST:admin[0],M59_ADMIN_PORT:admin[1]};
 const report=await mirrorShadowLoginPositions(snapshot.characters,{apply,resolve:names=>resolve(names,{env}),dm:commands=>dm(commands,{env,timeoutMs:180000})});
 console.log('shadow login positions: '+report.verified+' verified, '+report.commands+' construction commands');
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
