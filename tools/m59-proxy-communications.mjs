// Retain incoming human-proxy communications in the fleet local archive.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CommunicationsArchive } from './m59-communications.mjs';
import { loadResources } from './m59-rsc.mjs';
import { Reader, objId, parseSaid, parsePlayer, parsePlayers,
  parsePlayerAdd, parseChangeResource, parseRoomContents, parseCreate, parseChange, parseRemove } from './m59-parse.mjs';

const channels = {1:'say',2:'yell',3:'broadcast',4:'group',5:'resource',6:'emote',7:'message',8:'group-one',9:'dm',10:'guild'};

// Read only identity/endpoint fields; never retain credentials in the observer.
export function proxyCommunicationsConfig({stateFile,host,port}) {
  const roster = JSON.parse(readFileSync(stateFile, 'utf8'));
  const characters = new Map();
  for (const [agent, entry] of Object.entries(roster)) {
    const c = entry.credentials;
    if (c?.character && String(c.host).toLowerCase() === String(host).toLowerCase() && Number(c.port) === Number(port))
      characters.set(c.character.toLowerCase(), {agent, name:c.character});
  }
  if (!characters.size) throw Error('proxy communications: upstream does not match the selected fleet roster');
  return {stateFile,host,port,characters};
}

// A passive decoder: no sockets, no sends, and no decoding of client login packets.
// Character selection identifies the receiver before the first room snapshot.
// Login and game-system prose never enter the communication archive.
export class ProxyCommunications {
  constructor({stateFile,host,port,characters=new Map(),resources=loadResources(),env,now=Date.now}) {
    this.characters=characters; this.resources=resources; this.dynamic=new Map(); this.now=now;
    this.connection=randomUUID(); this.inGame=false; this.names=new Map();
    this.archive=new CommunicationsArchive({stateFile,agent:'proxy-'+this.connection,env});
    this.c={host,port,me:null,wantName:'Proxy login (unassigned)',selfId:null,
      rsc:{get:id=>this.lookup(id)},room:{objects:new Map()},playersOnline:new Map()};
  }
  lookup(id) { return this.dynamic.has(id)?this.dynamic.get(id):this.resources.has(id)?this.resources.get(id):undefined; }
  select(id,name=this.names.get(id)) {
    this.c.selfId=id;
    this.c.me=name?{name}:null;
    this.c.wantName=name??'Proxy character (unresolved)';
    this.archive.agent=name?(this.characters.get(name.toLowerCase())?.agent??'proxy:'+name):'proxy-'+this.connection;
  }
  clientPacket(packet) {
    // USE_CHARACTER is the sole client packet we inspect. In particular, never
    // decode, store or print AP_LOGIN/account/password bytes.
    if (!this.inGame || packet[0]!==46 || packet.length!==5) return;
    this.select(objId(packet.readUInt32LE(1)));
  }
  record(ev,packet) {
    this.archive.record({...ev,at:this.now(),transport:'proxy',connection_id:this.connection,
      // Only incoming communication packets, never arbitrary traffic/login data.
      packet_hex:packet.toString('hex')},this.c);
  }
  decode(parse,body) {
    let resolved=true;
    const p=parse(body,id=>{const value=this.lookup(id);if(value==null)resolved=false;return value;});
    return {...p,decoded:p.exact&&resolved};
  }
  serverPacket(packet) {
    const op=packet[0], body=packet.subarray(1);
    const communication=this.inGame && op===206 && [1,2,3,6,9].includes(body[8]);
    try {
      if (!this.inGame) {
        if(op===25)this.inGame=true;
        return;
      }
      if(op===20 || op===149) {
        this.c.room.objects.clear(); this.c.playersOnline.clear(); this.selfNameRsc=null; this.select(null);
        if(op===20){this.inGame=false;this.dynamic.clear();this.names.clear();}
        return;
      }
      if(op===139) {
        const r=new Reader(body), n=r.u16(); this.names.clear();
        for(let i=0;i<n;i++){const id=objId(r.id()),name=r.str();r.u8();this.names.set(id,name);}
      } else if(op===30) {
        const p=parseChangeResource(body);if(p.exact)this.dynamic.set(p.id,p.text);
        if(this.selfNameRsc===p.id && p.exact)this.select(this.c.selfId,p.text);
      } else if(op===130) {
        const p=parsePlayer(body);this.selfNameRsc=p.nameRsc;
        this.select(p.id,this.lookup(p.nameRsc)??this.names.get(p.id));this.c.room.objects.clear();
      } else if(op===136 || op===137) {
        const p=op===136?parsePlayers(body):parsePlayerAdd(body);
        if(p.exact){if(op===136)this.c.playersOnline.clear();for(const person of (p.players??[p])){
          this.dynamic.set(person.nameRsc,person.name);this.c.playersOnline.set(person.id,person);
        }}
      } else if(op===138) this.c.playersOnline.delete(parseRemove(body).id);
      else if(op===134) {
        const p=parseRoomContents(body);this.c.room.objects.clear();
        if(p.exact)for(const o of p.objects)this.c.room.objects.set(o.id,o);
      } else if(op===217 || op===219) {
        const p=(op===217?parseCreate:parseChange)(body);
        if(p.exact)this.c.room.objects.set(p.object.id,p.object);
      } else if(op===218)this.c.room.objects.delete(parseRemove(body).id);
      else if(communication) {
        const p=this.decode(parseSaid,body);
        this.record({kind:'said',speaker:p.speaker,name:this.lookup(p.nameRsc)??'<unresolved sender>',
          type:channels[p.sayType]??String(p.sayType),text:p.text||'[Undecoded speech; wire packet retained]',
          decoded:p.decoded},packet);
      }
    } catch {
      if(communication)this.record({kind:op===206?'said':'message',type:'unknown',
        text:'[Undecoded incoming communication; wire packet retained]',decoded:false},packet);
      // Incomplete world observations cannot justify a subsequent sender label.
      if([130,134,217,218,219].includes(op))this.c.room.objects.clear();
    }
  }
}

export function attachProxyCommunications(session,options) {
  const observer=new ProxyCommunications(options);
  const server=p=>observer.serverPacket(p),client=p=>observer.clientPacket(p);
  const close=()=>{session.removeListener('received-server-packet',server);session.removeListener('received-client-packet',client);session.removeListener('closed',close);};
  session.on('received-server-packet',server);session.on('received-client-packet',client);session.once('closed',close);
  return observer;
}
