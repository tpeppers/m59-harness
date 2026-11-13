import {protocolToClient} from './m59-finepos.mjs';
import {isFleetmate} from './m59-party.mjs';
import {crossingAdmissionConflict} from './m59-crossing-queue.mjs';
import {lineQueuePredecessor,planStraightQueueAdvance} from './m59-rail-traffic.mjs';
// #movement: admit one body to a connected narrow passage, in either direction.
// Geometry identifies candidates; collision remains the packet proof.
import {reserveFilePassages, releaseFilePassage, retagOwnFilePassage,confirmFilePassageEntry,filePassageSnapshot} from './m59-spotclaims.mjs';
import {OF} from './m59-parse.mjs';
import {fineChokesFor} from './m59-pocket-rails.mjs';
const cache = new WeakMap(), local = new Map();
const key = (row, col) => row + ',' + col;
export function narrowPassages(geo) {
  const previous = cache.get(geo);
  if (previous && previous.mask === geo._stepMask) return previous.zones;
  const thin = new Set(), zones = new Map(), fineChokes=fineChokesFor(geo);
  const open = (r,c) => r >= 1 && c >= 1 && r <= geo.rows && c <= geo.cols && geo.walkable(r,c);
  for (let r = 1; r <= geo.rows; r++) for (let c = 1; c <= geo.cols; c++) {
    if (!open(r,c)) continue;
    let wide = false;
    for (const dr of [-1,1]) for (const dc of [-1,1])
      if (open(r+dr,c) && open(r,c+dc) && open(r+dr,c+dc)) wide = true;
    if (!wide) thin.add(key(r,c));
  }
  while (thin.size) {
    const seed = thin.values().next().value, cells = new Set([seed]), queue = [seed];
    thin.delete(seed);
    for (let i = 0; i < queue.length; i++) {
      const [r,c] = queue[i].split(',').map(Number);
      for (const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const k = key(r+dr,c+dc);
        if (thin.delete(k)) { cells.add(k); queue.push(k); }
      }
    }
    // A one-cell neck between two openings still needs admission. A one-ended
    // wall pocket is a destination, not a crossing, and keeps its old behavior.
    if(cells.size<2){
      const [r,c]=seed.split(',').map(Number),center=geo.standPointWire?.(r,c);
      // A published fine neck already owns its immediate approach. Adding a
      // second coarse ticket with less than one body-width between them can
      // make an incumbent unable to confirm one exit before entering the other.
      if(fineChokes.some(p=>Math.hypot(Math.max(0,c*64-(p.x+32),(p.x-32)-(c+1)*64),Math.max(0,r*64-(p.y+32),(p.y-32)-(r+1)*64))<32))continue;
      if(!center||!geo.traceFineMoveClient)continue;
      const a=protocolToClient(center),mouths=[[1,0],[-1,0],[0,1],[0,-1]].filter(([dr,dc])=>{
        if(!open(r+dr,c+dc))return false;const p=geo.standPointWire(r+dr,c+dc);if(!p)return false;const b=protocolToClient(p);
        const forward=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false}),back=geo.traceFineMoveClient(b.x,b.y,a.x,a.y,{slide:false});
        return forward?.arrived===true&&!forward.blocked&&back?.arrived===true&&!back.blocked;
      });
      if(mouths.length<2)continue;
    }
    const zone = {id:[...cells].sort()[0], cells};
    for (const k of cells) zones.set(k, zone);
  }
  // Some mountain necks lie inside cells the coarse grid calls wide open.
  // Only published, clearance-checked fine necks receive this extra admission.
  for(const p of fineChokes){
    const cells=new Set();
    for(let r=Math.floor((p.y-32)/64);r<=Math.floor((p.y+32)/64);r++)
      for(let c=Math.floor((p.x-32)/64);c<=Math.floor((p.x+32)/64);c++)cells.add(key(r,c));
    const zone={id:`fine:${p.x}:${p.y}`,cells,fine:p};
    for(const k of cells)if(!zones.has(k))zones.set(k,zone);
  }
  cache.set(geo, {mask:geo._stepMask, zones});
  return zones;
}
const cellOf = p => key(Math.floor(p.y/64), Math.floor(p.x/64));
export function passageAlong(geo, from, target) {
  const zones = narrowPassages(geo), n = Math.max(1, Math.ceil(Math.hypot(target.x-from.x,target.y-from.y)/16));
  for (let i = 1; i <= n; i++) {
    const z = zoneAt(zones,{x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n});
    if (z&&contains(z,{x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n})) return z;
  }
  return null;
}
const namespace = s => JSON.stringify([s.client?.host ?? s.host ?? '',s.client?.port ?? s.port ?? '',s.world?.room?.num]);
// Admission follows the body's footprint, not only the square containing its
// feet. A curved neck can briefly cross a wide cell without clearing the
// original passage; releasing there strands its leader behind its own convoy.
export const containsPassageBody=(zone,p)=>{
 if(zone.fine)return Math.abs(p.x-zone.fine.x)<=48&&Math.abs(p.y-zone.fine.y)<=48;
 const row=Math.floor(p.y/64),col=Math.floor(p.x/64);
 for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
  const r=row+dr,c=col+dc;if(!zone.cells.has(key(r,c)))continue;
  const dx=Math.max(c*64-p.x,0,p.x-(c+1)*64),dy=Math.max(r*64-p.y,0,p.y-(r+1)*64);
  if(Math.hypot(dx,dy)<=16)return true;
 }return false;
};
const contains=containsPassageBody;
const zoneAt=(zones,p)=>{
 const own=zones.get(cellOf(p));if(own&&contains(own,p))return own;
 const row=Math.floor(p.y/64),col=Math.floor(p.x/64);
 for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const z=zones.get(key(row+dr,col+dc));if(z&&contains(z,p))return z;}
 return null;
};
// Collect every zone touched by the body along the chord. Choosing the first
// sampled zone can miss a second overlapping neck on a coalesced move.
const segmentHitsRect=(a,b,minX,minY,maxX,maxY)=>{
 let enter=0,exit=1;
 for(const [origin,delta,low,high] of [[a.x,b.x-a.x,minX,maxX],[a.y,b.y-a.y,minY,maxY]]){
  if(!delta){if(origin<low||origin>high)return false;continue;}
  const u=(low-origin)/delta,v=(high-origin)/delta;
  enter=Math.max(enter,Math.min(u,v));exit=Math.min(exit,Math.max(u,v));if(enter>exit)return false;
 }return true;
};
const pointSegmentDistance2=(p,a,b)=>{
 const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;
 return (p.x-a.x-dx*t)**2+(p.y-a.y-dy*t)**2;
};
const segmentNearCell=(a,b,row,col)=>{
 const x=col*64,y=row*64;
 if(segmentHitsRect(a,b,x,y,x+64,y+64))return true;
 const pointRect=p=>Math.max(x-p.x,0,p.x-x-64)**2+Math.max(y-p.y,0,p.y-y-64)**2;
 return Math.min(pointRect(a),pointRect(b),...[[x,y],[x+64,y],[x,y+64],[x+64,y+64]].map(([x,y])=>pointSegmentDistance2({x,y},a,b)))<=16*16;
};
export function passagesAlong(geo,from,target){
 const zones=narrowPassages(geo),candidates=new Set(),n=Math.max(1,Math.ceil(Math.hypot(target.x-from.x,target.y-from.y)/16));
 for(let i=0;i<=n;i++){
  const row=Math.floor((from.y+(target.y-from.y)*i/n)/64),col=Math.floor((from.x+(target.x-from.x)*i/n)/64);
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const zone=zones.get(key(row+dr,col+dc));if(zone)candidates.add(zone);}
 }
 return [...candidates].filter(zone=>zone.fine
  ?segmentHitsRect(from,target,zone.fine.x-48,zone.fine.y-48,zone.fine.x+48,zone.fine.y+48)
  :[...zone.cells].some(cell=>{const [row,col]=cell.split(',').map(Number);return segmentNearCell(from,target,row,col);}));
}
const displayName=(c,o)=>typeof o?.name==='string'?o.name:c?.rsc?.get?.(o?.nameRsc);
const selfName=s=>s.client?.me?.name??displayName(s.client,s.client?.self);
const member=(session,name)=>!!name&&(session.passageConvoy?.characters?.some(n=>String(n).trim().toLowerCase()===String(name).trim().toLowerCase())||isFleetmate(selfName(session))&&isFleetmate(name));
// Partition the cells just outside a narrow zone into entrance mouths. This
// works for curved passages as well as straight ones, without a map-number rule.
export function passageEntryKey(geo,zone,from,target){
 if(!zone||contains(zone,from))return null;
 if(zone.fine){const dx=from.x-zone.fine.x,dy=from.y-zone.fine.y;return Math.abs(dx)>=Math.abs(dy)?'x:'+Math.sign(dx):'y:'+Math.sign(dy);}
 if(!zone.entryPorts){
  const ring=new Set(),ports=new Map();
  for(const cell of zone.cells){const [row,col]=cell.split(',').map(Number);for(const [dr,dc]of [[1,0],[-1,0],[0,1],[0,-1]]){const r=row+dr,c=col+dc,k=key(r,c);if(!zone.cells.has(k)&&r>=1&&c>=1&&r<=geo.rows&&c<=geo.cols&&geo.walkable(r,c))ring.add(k);}}
  while(ring.size){const seed=[...ring].sort()[0],queue=[seed];ring.delete(seed);for(let i=0;i<queue.length;i++){const cell=queue[i];ports.set(cell,seed);const [row,col]=cell.split(',').map(Number);for(const [dr,dc]of [[1,0],[-1,0],[0,1],[0,-1]]){const k=key(row+dr,col+dc);if(ring.delete(k))queue.push(k);}}}
  zone.entryPorts=ports;
 }
 let last=from;const n=Math.max(1,Math.ceil(Math.hypot(target.x-from.x,target.y-from.y)/8));
 for(let i=1;i<=n;i++){const p={x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n};if(contains(zone,p))return zone.entryPorts.get(cellOf(last))??null;last=p;}
 return null;
}
// Used by ordinary fine and square walks, not just a named FleetScript. A
// convoy stays on its line through a narrow passage; open-ground detours remain.
export function passageQueueAdvance(session,target){
 const c=session.client,me=c?.self,geo=session.world?.geometry;
 if(!geo?.collisionReady||!me)return null;
 const dx=target.x-me.x,dy=target.y-me.y,length=Math.hypot(dx,dy);if(!Number.isFinite(length)||!length)return null;
 const horizon=Math.min(1,128/length),near={x:me.x+dx*horizon,y:me.y+dy*horizon};
 const zones=narrowPassages(geo),here=zones.get(cellOf(me)),zone=here&&contains(here,me)?here:passageAlong(geo,me,near);
 if(!zone)return null;
 const predecessor=lineQueuePredecessor(me,target,{objects:c.room?.objects,selfId:c.selfId,isConvoy:name=>member(session,name),nameOf:o=>displayName(c,o)});
 if(!predecessor)return null;
 return {queued:true,predecessor:predecessor.id,zone:zone.id,...planStraightQueueAdvance(geo,me,target,{objects:c.room.objects,selfId:c.selfId,maxAdvance:96,maxRise:384,maxDrop:384})};
}
// The most recently acquired admission remains the public primary. Earlier
// overlapping zones stay owned until a fresh body observation clears each one.
const heldPassages=session=>session._passage?[...(session._passage.previous??[]),session._passage]:[];
const containsHeld=(held,point)=>(held.physicalZones??[held.zone]).some(zone=>contains(zone,point));
function retainPhysicalZone(held,zone){
 const shapes=held.physicalZones??[held.zone];
 const same=(a,b)=>a===b||(a.fine||b.fine
  ?a.fine?.x===b.fine?.x&&a.fine?.y===b.fine?.y
  :a.cells.size===b.cells.size&&[...a.cells].every(cell=>b.cells.has(cell)));
 if(!shapes.some(old=>same(old,zone)))held.physicalZones=[...shapes,zone];
}

function setHeldPassages(session,held){
 for(const h of held)delete h.previous;
 session._passage=held.at(-1)??null;
 if(held.length>1)session._passage.previous=held.slice(0,-1);
}
export function releaseConfirmedPassage(session) {
  const me=session.client?.self;
  if(!me||me.predicted)return false;
  const heldSet=heldPassages(session),geo=session.world?.geometry;
  if(heldSet.length&&geo?.collisionReady){
    const current=new Map([...new Set(narrowPassages(geo).values())].map(zone=>[zone.id,zone]));
    for(const held of heldSet)if(session.client.room?.id===held.roomId){const zone=current.get(held.zone.id);if(zone)retainPhysicalZone(held,zone);}
  }
  const retained=[];let released=false;
  for(const held of heldSet){
    if(session.client.room?.id===held.roomId&&containsHeld(held,me)){
      if(held.entryPending){
        const confirmed=!held.file||confirmFilePassageEntry(held.agent,held.roomNum??Number(session.world.room.num),held.zone.id);
        if(confirmed){
          if(!held.file){const record=local.get(held.key)?.get(session);if(record)record.entryPending=false;}
          held.entryPending=false;
        }
      }
      retained.push(held);continue;
    }
    if(held.file)releaseFilePassage(held.agent,{room:held.roomNum??null,zone:held.zone.id});
    else {const members=local.get(held.key);members?.delete(session);if(members?.size===0)local.delete(held.key);}
    released=true;
  }
  setHeldPassages(session,retained);
  return released;
}
export function adoptPassageConvoy(session){
 const held=session._passage,c=session.client,me=c?.self,convoy=session.passageConvoy;
 if(!held||!convoy?.flow)return{adopted:false,reason:'no_owned_passage_or_convoy'};
 if(heldPassages(session).length>1)return{adopted:false,reason:'overlapping_passage_handoff_pending'};
 const name=c.me?.name??me?.name??c.rsc?.get?.(me?.nameRsc);
 if(!me||me.predicted||c.room?.id!==held.roomId||!containsHeld(held,me)||!convoy.characters?.includes(name))return{adopted:false,reason:'incumbent_body_or_membership_unconfirmed'};
 if(held.file){const reply=retagOwnFilePassage(held.agent,Number(session.world.room.num),held.zone.id,convoy.flow);if(!reply?.ok)return{adopted:false,reason:reply?.reason??'claim_unavailable'};}else{const members=local.get(held.key);if(!members?.has(session))return{adopted:false,reason:'local_claim_not_held'};members.set(session,{...members.get(session),flow:convoy.flow});}
 held.flow=convoy.flow;return{adopted:true,zone:held.zone.id,flow:convoy.flow};
}
export function passageExitNeedsConfirmation(session, target) {
  return heldPassages(session).some(held=>held.entryPending||!containsHeld(held,target));
}
export function claimPassageMove(session, target) {
  releaseConfirmedPassage(session);
  const c=session.client,me=c?.self,geo=session.world?.geometry;
  if(!me||!geo?.collisionReady)return null;
  const held=heldPassages(session);
  const crossed=passagesAlong(geo,me,target);
  // A same-room geometry refresh recreates zone objects. Ownership follows the
  // resource ID, while both old and new physical masks remain protected until
  // an observed body has left their union; no duplicate ticket can be released
  // underneath a retained one.
  for(const zone of crossed){const own=held.find(h=>h.zone.id===zone.id&&h.roomId===c.room.id);if(own)retainPhysicalZone(own,zone);}
  const entering=crossed.filter(zone=>!contains(zone,me)&&!held.some(h=>h.zone.id===zone.id&&h.roomId===c.room.id));
  if(!entering.length)return null; // incumbents can leave their own zones
  const refusal=(zone,extra)=>({available:true,moved:false,blocked:true,reason:'object_blocked',
    traffic:'passage_admission',zone:zone.id,...extra});
  // The confirmed body can straddle adjacent expanded necks. Reserve all newly
  // entered zones atomically and retain the old set until its observed exit.
  const handoff=held.length&&held.every(h=>h.roomId===c.room.id&&!h.entryPending&&!me.predicted&&containsHeld(h,me));
  if(held.length&&!handoff)return refusal(entering[0],{note:'the previous passage exit is not confirmed',held_zone:session._passage.zone.id,held_entry_pending:session._passage.entryPending,held_room:session._passage.roomId});
  const agent=String(session.name??c.selfId),roomNum=Number(session.world.room.num),snapshot=filePassageSnapshot();
  const declared=name=>session.passageConvoy?.characters?.some(n=>String(n).trim().toLowerCase()===String(name).trim().toLowerCase());
  const admissions=[];
  for(const zone of entering){
    const resource=namespace(session)+'|'+zone.id,entry=passageEntryKey(geo,zone,me,target);
    const flow=session.passageConvoy?.flow??(entry&&isFleetmate(selfName(session))?'fleet-entry:'+entry:null);
    const peers=snapshot?.filter(p=>p.room===roomNum&&p.zone===zone.id)??[...(local.get(resource)?.values()??[])];
    const convoyOccupant=name=>declared(name)||member(session,name)&&peers.some(p=>p.flow===flow&&p.entry===entry&&!p.entryPending&&String(p.character??'').toLowerCase()===String(name).toLowerCase());
    for(const o of c.room?.objects?.values?.()??[])
      if(o.id!==c.selfId&&(o.flags&OF.PLAYER)&&contains(zone,o)&&!convoyOccupant(displayName(c,o)))
        return refusal(zone,{objectId:o.id,note:'another player has no confirmed matching convoy admission'});
    const members=local.get(resource);
    if(!snapshot&&[...(members??[])].some(([owner,old])=>owner!==session&&crossingAdmissionConflict({...old,agent:owner},{agent:session,flow,entry})))
      return refusal(zone,{note:'another session holds passage admission'});
    admissions.push({zone,agent,key:resource,roomId:c.room.id,roomNum,flow,entry,entryPending:true});
  }
  const file=reserveFilePassages(agent,roomNum,admissions.map(h=>({zone:h.zone.id,flow:h.flow,entryPending:true,entry:h.entry,character:selfName(session)})),
    {handoffFrom:handoff?held.map(h=>({room:h.roomNum??roomNum,zone:h.zone.id})):null});
  if(file&&!file.ok)return refusal(entering.find(z=>z.id===file.zone)??entering[0],{note:'another keeper holds passage admission',holder:file.agent,admission_reason:file.reason??'conflicting_flow'});
  for(const h of admissions){
    h.file=!!file;
    if(!file){const members=local.get(h.key)??new Map();members.set(session,{agent,flow:h.flow,entry:h.entry,character:selfName(session),entryPending:true});local.set(h.key,members);}
  }
  setHeldPassages(session,[...held,...admissions]);
  return null;
}
