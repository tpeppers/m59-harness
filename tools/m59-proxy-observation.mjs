// Passive, bounded decoded mirror for a native-client proxy connection.
// No socket, login, protocol client, game-send method, or disk write exists here.
// Raw credentials/login messages are neither decoded nor retained.
import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {parsePlayer,parseRoomContents,parseCreate,parseRemove,parseMove,parseTurn,
  parseChange,parseObjectList,parseInventoryAdd,parseUseList,parseStat,parseStatGroup} from './m59-parse.mjs';
import {perf} from './m59-perf.mjs';

// Numeric values from include/proto.h, also mirrored in m59-client.mjs.
const ROOM=new Set([130,134,200,201,217,218,219]);
const PACK=new Set([203,204,205,208,209,210,219]);
const STATS=new Set([131,132]);
const need=ok=>{if(!ok)throw Error('incomplete observation');};
function decoded(parse,body){const value=parse(body);need(value.exact===true);return value;}
function replaceBounded(items,max=2048){need(items.length<=max);const map=new Map();
  for(const item of items){need(item.id>0&&!map.has(item.id));map.set(item.id,item);}return map;}

export class ProxyObservation {
  constructor({now=Date.now,lookup=()=>undefined}={}) {
    this.now=now;this.lookup=lookup;this.connection_id=randomBytes(24).toString('hex');
    this.closed=false;this.sequence=0;this.room_generation=0;this.last_rx_at=0;this.reset();
  }
  reset(){this.player=null;this.objects=new Map();this.inventory=new Map();this.equipped=new Set();
    this.stats=new Map();this.room_ready=false;this.inventory_ready=false;this.equipment_ready=false;
    this.stats_ready=false;this.human_move=null;this.room_at=0;this.inventory_at=0;}
  serverPacket(packet,{inGame=false}={}) {
    if(this.closed||!inGame||!Buffer.isBuffer(packet)||packet.length<1)return;
    this.last_rx_at=this.now();perf('proxy.server_payload_bytes',packet.length);
    const op=packet[0];
    if(op===149||op===20){this.reset();this.sequence++;return;}
    if(!ROOM.has(op)&&!PACK.has(op)&&!STATS.has(op))return;
    const start=performance.now();
    try {
      need(packet.length<=65535);const body=packet.subarray(1);
      if(op===130){
        const p=decoded(parsePlayer,body);need(p.id>0&&p.roomId>0&&p.roomRsc>0);
        if(this.player?.id!==p.id)this.reset();
        this.room_generation++;
        this.player=p;this.objects.clear();this.room_ready=false;this.human_move=null;this.room_at=this.now();
      } else {
        need(this.player);
        if(op===134){const p=decoded(parseRoomContents,body);need(p.roomId===this.player.roomId);
          this.objects=replaceBounded(p.objects,8192);this.room_ready=true;this.room_at=this.now();}
        else if(op===208){this.inventory=replaceBounded(decoded(parseObjectList,body).objects);
          this.inventory_ready=true;this.inventory_at=this.now();}
        else if(op===205){const ids=decoded(parseUseList,body).ids;need(ids.length<=2048&&new Set(ids).size===ids.length);
          this.equipped=new Set(ids);this.equipment_ready=true;}
        else if(op===203||op===204){need(this.equipment_ready);const id=decoded(parseRemove,body).id;
          if(op===203){need(this.equipped.size<2048);this.equipped.add(id);}else this.equipped.delete(id);}
        else if(op===209){need(this.inventory_ready&&this.inventory.size<2048);const p=decoded(parseInventoryAdd,body);
          this.inventory.set(p.object.id,p.object);this.inventory_at=this.now();}
        else if(op===210){need(this.inventory_ready);const id=decoded(parseRemove,body).id;
          this.inventory.delete(id);this.equipped.delete(id);this.inventory_at=this.now();}
        else if(op===131||op===132){const p=decoded(op===131?b=>parseStat(b,this.lookup):b=>parseStatGroup(b,this.lookup),body);
          if(op===132)for(const [key,stat] of this.stats)if(stat.group===p.group)this.stats.delete(key);
          for(const stat of p.stats??[p.stat]){need(this.stats.size<256);this.stats.set(`${p.group}:${stat.num}`,{...stat,group:p.group});}
          this.stats_ready=true;}
        else if(op===219){const p=decoded(parseChange,body),id=p.object.id;
          if(this.room_ready&&this.objects.has(id)){this.objects.set(id,{...this.objects.get(id),...p.object});this.room_at=this.now();}
          if(this.inventory_ready&&this.inventory.has(id)){this.inventory.set(id,{...this.inventory.get(id),...p.object});this.inventory_at=this.now();}}
        else {
          need(this.room_ready);
          if(op===217){const p=decoded(parseCreate,body);need(this.objects.size<8192);this.objects.set(p.object.id,p.object);}
          else if(op===218)this.objects.delete(decoded(parseRemove,body).id);
          else if(op===200||op===201){const p=decoded(op===200?parseMove:parseTurn,body),o=this.objects.get(p.id);
            need(o);this.objects.set(p.id,{...o,...p});}
          this.room_at=this.now();
        }
      }
      this.sequence++;perf('proxy.observation_accepted');
    } catch {
      // A bad incremental update creates a gap until a complete observation
      // repairs that domain. It does not relabel retained state as current.
      if(ROOM.has(op))this.room_ready=false;
      if(op===130)this.reset();
      if(PACK.has(op)){this.inventory_ready=false;this.equipment_ready=false;}
      if(STATS.has(op))this.stats_ready=false;
      perf('proxy.observation_refused');
    } finally {perf('proxy.decode_ms',performance.now()-start);}
  }
  clientPacket(packet,{inGame=false}={}) {
    if(this.closed||!inGame||!Buffer.isBuffer(packet)||packet.length<1)return;
    perf('proxy.client_payload_bytes',packet.length);
    if(packet[0]!==100||packet.length!==10||!this.player)return;
    const room=packet.readUInt32LE(6)&0x0fffffff;if(room!==this.player.roomId)return;
    // This is a request from the HUMAN, not server-confirmed movement. Keep it
    // separate so consumers cannot silently turn intent into observed position.
    const y=packet.readUInt16LE(1),x=packet.readUInt16LE(3);
    this.human_move={room_object:room,row:Math.floor(y/64),col:Math.floor(x/64),x,y,at:this.now(),source:'client-request'};
  }
  snapshot() {
    const now=this.now();return structuredClone({schema:'m59-proxy-observation/1',connection_id:this.connection_id,
      sequence:this.sequence,observed_at:this.last_rx_at,connection_current:!this.closed&&this.last_rx_at>0&&now-this.last_rx_at<=6000,
      control:'human',player:this.player,room_generation:this.room_generation,room_ready:this.room_ready,room_at:this.room_at,objects:[...this.objects.values()],
      inventory_ready:this.inventory_ready,inventory_at:this.inventory_at,inventory:[...this.inventory.values()],
      equipment_ready:this.equipment_ready,equipped:[...this.equipped],stats_ready:this.stats_ready,stats:[...this.stats.values()],
      human_move:this.human_move});
  }
  close(){this.closed=true;this.reset();}
}

export function attachProxyObservation(session,options={}) {
  if(session?.observe!==true)throw Error('human guidance requires an observe-only proxy');
  const observer=new ProxyObservation(options);
  const server=p=>observer.serverPacket(p,{inGame:session.inGame===true});
  const client=p=>observer.clientPacket(p,{inGame:session.inGame===true});
  const close=()=>{observer.close();session.removeListener('server-packet',server);
    session.removeListener('client-packet',client);session.removeListener('closed',close);};
  session.on('server-packet',server);session.on('client-packet',client);session.on('closed',close);
  return {snapshot:()=>observer.snapshot(),close};
}
