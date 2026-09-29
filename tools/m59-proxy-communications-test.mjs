#!/usr/bin/env node
// Offline proxy communication receipt, login, reconnect, wire preservation and privacy regressions.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProxyCommunications,attachProxyCommunications,proxyCommunicationsConfig } from './m59-proxy-communications.mjs';
import { ProxySession } from './m59-proxy.mjs';
import { CommunicationsArchive,readCommunications,communicationsDirFor } from './m59-communications.mjs';
const root=mkdtempSync(join(tmpdir(),'m59-proxy-comms-')),stateFile=join(root,'prod.json'),env={M59_EVIDENCE_DIR:root};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const bytes=(...xs)=>Buffer.concat(xs.map(x=>typeof x==='number'?Buffer.from([x]):x));
const str=s=>bytes(u16(Buffer.byteLength(s,'latin1')),Buffer.from(s,'latin1'));
const said=(id,name,type=9,fmt=100)=>bytes(206,u32(id),u32(name),type,u32(fmt));
const at=Date.parse('2026-09-29T02:00:00Z'),day='2026-09-29';
let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
try {
  writeFileSync(stateFile,JSON.stringify({t1:{credentials:{host:'example.test',port:5959,character:'Fleet One',account:'SECRET_ACCOUNT',password:'SECRET_PASSWORD'}}}));
  const config=proxyCommunicationsConfig({stateFile,host:'example.test',port:5959});
  assert.throws(()=>proxyCommunicationsConfig({stateFile,host:'other.test',port:5959}),/upstream/);checks++;
  eq(JSON.stringify([...config.characters]).includes('SECRET'),false);
  const opts={...config,env,now:()=>at,resources:new Map([[100,'Hello!'],[101,'NPC greeting'],[9,'Shopkeeper']])};
  const p=new ProxyCommunications(opts);
  p.clientPacket(bytes(2,str('SECRET_ACCOUNT'),str('SECRET_PASSWORD')));
  p.serverPacket(bytes(34,str('Welcome before character selection')));
  p.serverPacket(bytes(25));
  p.serverPacket(bytes(139,u16(1),u32(1),str('Fleet One'),0));
  p.clientPacket(bytes(46,u32(1)));
  p.serverPacket(bytes(32,u32(100))); // arrives before BP_PLAYER
  p.serverPacket(bytes(30,u32(8),str('Visitor')));
  p.serverPacket(said(2,8));
  p.serverPacket(said(2,8)); // repeats survive
  p.serverPacket(bytes(30,u32(7),str('Fleet One')));
  p.serverPacket(said(1,7)); // own echo omitted
  p.serverPacket(bytes(30,u32(10),str('Fleet One')));
  p.serverPacket(said(999,10)); // roster membership, not a potentially recycled handle
  const roster=JSON.parse((await import('node:fs')).readFileSync(stateFile,'utf8'));
  roster.t2={credentials:{character:'Offline Fleet Member',host:'example.test',port:5959}};
  writeFileSync(stateFile,JSON.stringify(roster));
  p.serverPacket(bytes(30,u32(11),str('offline fleet member')));
  p.serverPacket(said(123,11)); // full roster excludes absent/human members too
  p.c.room.objects.set(3,{id:3,nameRsc:9,flags:0});
  p.serverPacket(said(3,9,5,101));
  p.serverPacket(said(4,9,5,999)); // NPC resource speech excluded
  p.serverPacket(bytes(206,1)); // malformed/unidentified speech excluded
  p.serverPacket(bytes(32,1)); // malformed prose excluded
  p.serverPacket(bytes(149));p.serverPacket(bytes(32,u32(100))); // no stale character identity
  const dir=communicationsDirFor(stateFile,env);
  let report=await readCommunications({dir,day});
  eq(report.total,2);
  eq(report.rows.filter(r=>r.recipient==='Fleet One').length,2);
  eq(report.rows.filter(r=>r.source==='npc').length,0);
  eq(report.rows.filter(r=>r.sender==='Visitor').length,2);
  eq(report.rows.every(r=>r.transport==='proxy'),true);
  eq(report.rows.some(r=>r.packet_hex),false);
  eq(JSON.stringify(report).includes('SECRET'),false);
  eq(report.rows.some(r=>r.packet_hex===bytes(206,1).toString('hex')),false);
  eq(report.rows.filter(r=>r.decoded===false).length,0);
  eq(report.rows.some(r=>r.text==='Welcome before character selection'),false);
  const p2=new ProxyCommunications(opts);p2.serverPacket(bytes(25));
  p2.serverPacket(bytes(139,u16(1),u32(1),str('Fleet One'),0));p2.clientPacket(bytes(46,u32(1)));p2.serverPacket(said(2,8));
  eq(p2.lookup(8),undefined); // per-connection resources don't leak
  const bot=new CommunicationsArchive({stateFile,agent:'t1',env});
  bot.record({kind:'said',speaker:2,name:'Visitor',type:'say',text:'Bot resumed',at},{me:{name:'Fleet One'}});
  report=await readCommunications({dir,day,recipient:'Fleet One'});eq(report.total,4);
  eq(new Set(report.rows.map(r=>r.id)).size,report.total);

  // Exercise actual proxy forwarding methods without creating a game connection.
  const session=Object.assign(new EventEmitter(),{stats:{fromClient:0,fromServer:0,injected:0},inGame:false,stream:{},log:()=>{}});
  const writes=[];session.client={write:b=>writes.push(['client',Buffer.from(b)])};session.server={write:b=>writes.push(['server',Buffer.from(b)])};
  const tap=attachProxyCommunications(session,opts);
  const login=bytes(34,str('Forwarded login message')),frame=bytes(7,6,5,login),saved=Buffer.from(frame);
  ProxySession.prototype.fromServer.call(session,login,0,frame);
  eq(writes[0],['client',saved]);eq(frame,saved);
  tap.serverPacket(bytes(25));tap.serverPacket(bytes(139,u16(1),u32(1),str('Fleet One'),0));
  const select=bytes(46,u32(1)),clientFrame=bytes(6,7,8,select);
  ProxySession.prototype.fromClient.call(session,select,0,clientFrame);
  eq(tap.c.me.name,'Fleet One');eq(writes[1],['server',clientFrame]);eq(writes.length,2);
  session.emit('closed');eq(session.listenerCount('received-server-packet'),0);eq(session.listenerCount('received-client-packet'),0);
  console.log(`PASS ${checks} proxy communications assertions`);
} finally {rmSync(root,{recursive:true,force:true});}
