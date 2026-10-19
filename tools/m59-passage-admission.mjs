import {protocolToClient} from './m59-finepos.mjs';
import {isFleetmate} from './m59-party.mjs';
import {crossingAdmissionConflict} from './m59-crossing-queue.mjs';
import {lineQueuePredecessor,planStraightQueueAdvance} from './m59-rail-traffic.mjs';
// #movement: admit one body to a connected narrow passage, in either direction.
// Geometry identifies candidates; collision remains the packet proof.
import {reserveFilePassage, releaseFilePassage, retagOwnFilePassage,confirmFilePassageEntry,filePassageSnapshot} from './m59-spotclaims.mjs';
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
    const z = zones.get(cellOf({x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n}));
    if (z&&contains(z,{x:from.x+(target.x-from.x)*i/n,y:from.y+(target.y-from.y)*i/n})) return z;
  }
  return null;
}
const namespace = s => JSON.stringify([s.client?.host ?? s.host ?? '',s.client?.port ?? s.port ?? '',s.world?.room?.num]);
const contains=(zone,p)=>zone.fine?Math.abs(p.x-zone.fine.x)<=32&&Math.abs(p.y-zone.fine.y)<=32:zone.cells.has(cellOf(p));
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
export function releaseConfirmedPassage(session) {
  const held = session._passage, me = session.client?.self;
  if (!held || !me || me.predicted) return false;
  if (session.client.room?.id === held.roomId && contains(held.zone,me)) {
    if(held.entryPending){
      if(held.file&&!confirmFilePassageEntry(held.agent,Number(session.world.room.num),held.zone.id))return false;
      if(!held.file){const record=local.get(held.key)?.get(session);if(record)record.entryPending=false;}
      held.entryPending=false;
    }
    return false;
  }
  if (held.file) releaseFilePassage(held.agent);
  else {const members=local.get(held.key);members?.delete(session);if(members?.size===0)local.delete(held.key);}
  session._passage = null;
  return true;
}
export function adoptPassageConvoy(session){
 const held=session._passage,c=session.client,me=c?.self,convoy=session.passageConvoy;
 if(!held||!convoy?.flow)return{adopted:false,reason:'no_owned_passage_or_convoy'};
 const name=c.me?.name??me?.name??c.rsc?.get?.(me?.nameRsc);
 if(!me||me.predicted||c.room?.id!==held.roomId||!contains(held.zone,me)||!convoy.characters?.includes(name))return{adopted:false,reason:'incumbent_body_or_membership_unconfirmed'};
 if(held.file){const reply=retagOwnFilePassage(held.agent,Number(session.world.room.num),held.zone.id,convoy.flow);if(!reply?.ok)return{adopted:false,reason:reply?.reason??'claim_unavailable'};}else{const members=local.get(held.key);if(!members?.has(session))return{adopted:false,reason:'local_claim_not_held'};members.set(session,{...members.get(session),flow:convoy.flow});}
 held.flow=convoy.flow;return{adopted:true,zone:held.zone.id,flow:convoy.flow};
}
export function passageExitNeedsConfirmation(session, target) {
  return !!session._passage && (session._passage.entryPending||!contains(session._passage.zone,target));
}
export function claimPassageMove(session, target) {
  releaseConfirmedPassage(session);
  const c = session.client, me = c?.self, geo = session.world?.geometry;
  if (!me || !geo?.collisionReady) return null;
  const zone = passageAlong(geo,me,target);
  if (!zone || contains(zone,me)) return null; // incumbents can leave
  const refusal = extra => ({available:true,moved:false,blocked:true,reason:'object_blocked',
    traffic:'passage_admission',zone:zone.id,...extra});
  if (session._passage) return refusal({note:'the previous passage exit is not confirmed',held_zone:session._passage.zone.id,held_entry_pending:session._passage.entryPending,held_room:session._passage.roomId});
  const agent=String(session.name??c.selfId),resource=namespace(session)+'|'+zone.id;
  const entry=passageEntryKey(geo,zone,me,target),flow=session.passageConvoy?.flow??(entry&&isFleetmate(selfName(session))?'fleet-entry:'+entry:null);
  const declared=name=>session.passageConvoy?.characters?.some(n=>String(n).trim().toLowerCase()===String(name).trim().toLowerCase());
  const peers=filePassageSnapshot()?.filter(p=>p.room===Number(session.world.room.num)&&p.zone===zone.id)??[...(local.get(resource)?.values()??[])];
  const convoyOccupant=name=>declared(name)||member(session,name)&&peers.some(p=>p.flow===flow&&p.entry===entry&&!p.entryPending&&String(p.character??'').toLowerCase()===String(name).toLowerCase());
  for(const o of c.room?.objects?.values?.()??[])
    if(o.id!==c.selfId&&(o.flags&OF.PLAYER)&&contains(zone,o)&&!convoyOccupant(displayName(c,o)))
      return refusal({objectId:o.id,note:'another player has no confirmed matching convoy admission'});
  const file = reserveFilePassage(agent, Number(session.world.room.num), zone.id,{flow,entryPending:true,entry,character:selfName(session)});
  if (file && !file.ok) return refusal({note:'another keeper holds passage admission',holder:file.agent,admission_reason:file.reason??'conflicting_flow'});
  if (!file) {
    const members=local.get(resource)??new Map();
    if([...members].some(([owner,held])=>owner!==session&&crossingAdmissionConflict({...held,agent:owner},{agent:session,flow,entry})))return refusal({note:'another session holds passage admission'});
    members.set(session,{agent,flow,entry,character:selfName(session),entryPending:true});local.set(resource,members);
  }
  session._passage = {zone,agent,file:!!file,key:resource,roomId:c.room.id,flow,entry,entryPending:true};
  return null;
}
