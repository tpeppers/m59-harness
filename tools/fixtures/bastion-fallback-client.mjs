// Socketless test client. Collision, routing, walks and exit selection are real;
// room replies/confirmations model declared KOD crossings, not a native server.
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

export async function bastionHarness(root=fileURLToPath(new URL('../../',import.meta.url))) {
  const scratch=fs.mkdtempSync(path.join(tmpdir(),'m59-bastion-'));
  process.env.M59_FLEET='offline-bastion';
  process.env.M59_RUNTIME_PROFILE='lab';
  process.env.M59_EXIT_FALLBACK='0';
  process.env.M59_EXIT_DEBUG='0';
  for(const [key,name]of Object.entries({M59_LEDGER_DIR:'ledger',M59_TACTICS_DIR:'tactics',M59_TRAILS_DIR:'trails',M59_SPOT_CLAIMS_DIR:'claims',M59_SHELTER_DIR:'shelter',M59_CROSSINGS_LEARNED:'crossings.json'}))process.env[key]=path.join(scratch,name);
  const imp=file=>import(pathToFileURL(path.join(root,'tools',file)));
  const {Session}=await imp('m59-game.mjs'),{World}=await imp('m59-world.mjs');
  const {bodyAuthority}=await imp('m59-body-command.mjs');
  const {geometryFor}=await imp('m59-safespots.mjs');
  const {attachStepMasks}=await imp('m59-routes.mjs');
  const {selectedEdgeAt,codeExits}=await imp('m59-map.mjs');
  const {inRegion}=await imp('m59-codeexits.mjs');
  const {configureSpotClaimStore}=await imp('m59-spotclaims.mjs');
  configureSpotClaimStore({enabled:false});
  const map=JSON.parse(fs.readFileSync(path.join(root,'substrate/m59-map.json'),'utf8'));
  const attached=attachStepMasks(map);
  if(!attached.ok)throw Error('Bastion tests require the collision routing table');

  function fixture(entry,{bodies=false,maxPackets=512,maxMs=30000}={}) {
    const deadline=Date.now()+maxMs;
    let room=entry.from.room,pending=null;
    const packets=[],crossings=[],events=[],asks=[];
    const c={selfId:1,evSeq:0,rsc:new Map(),roomContentsRequested:0,roomContentsReceived:0,state:'game',
      room:{id:10000+room,flags:0,objects:new Map()},
      get self(){return this.room.objects.get(this.selfId);},
      vitals:()=>({health:{value:100,max:100},vigor:{value:200,max:200}}),
      face(){},stand(){return true;},rest(){return true;},
      predictSelf(p){this.room.objects.set(1,{...this.self,...p,predicted:true});},
      moveTo(x,y){
        if(packets.length>=maxPackets)throw Error('offline bastion packet budget exhausted');
        const r=map.rooms[room],row=Math.floor(y/64),col=Math.floor(x/64);
        packets.push({room,x,y,row,col});
        this.predictSelf({x,y,row,col});
        const direction=row<1?'north':row>r.rows?'south':col<1?'west':col>r.cols?'east':null;
        const edge=direction?selectedEdgeAt(r,direction,{row,col}):null;
        const trigger=direction?null:codeExits(room).find(e=>inRegion(e.when,row,col));
        if(edge||trigger)pending={from:room,exit:edge??trigger};
      },
      go(){const me=this.self,e=map.rooms[room].goExits.find(e=>!e.locked&&e.row===me?.row&&e.col===me?.col);if(e)pending={from:room,exit:e};},
      roomContents(){applyPending();this.roomContentsRequested++;this.roomContentsReceived++;if(this.self)this.self.predicted=false;return this.roomContentsRequested;},
      async waitFor({since=0,kinds=[]}={}){applyPending();return {events:events.filter(e=>e.seq>since&&(!kinds.length||kinds.includes(e.kind)))};},
      eventsSince(since=0){return events.filter(e=>e.seq>since);},
    };
    function enter(n,p) {
      const r=map.rooms[n],geo=geometryFor(r);
      room=n;c.roomNameRsc=r.nameRsc;c.roomRsc=r.roomRsc;c.room={id:10000+n,security:geo.security,flags:0,objects:new Map()};
      c.room.objects.set(1,{id:1,flags:4,...p,row:Math.floor(p.y/64),col:Math.floor(p.x/64),predicted:false});
    }
    function applyPending(){
      if(!pending)return;
      const {from,exit}=pending;pending=null;
      if(!Number.isFinite(exit.arriveRow)||!Number.isFinite(exit.arriveCol))throw Error('offline crossing has no declared landing');
      enter(Number(exit.to),{x:exit.arriveCol*64+32,y:exit.arriveRow*64+32});
      crossings.push({from,to:room,row:c.self.row,col:c.self.col});
      events.push({seq:++c.evSeq,kind:'room-entered',room:c.room.id});
      events.push({seq:++c.evSeq,kind:'room-contents',room:c.room.id});
    }
    enter(room,entry.from);
    if(bodies)for(const body of entry.bodies??[])c.room.objects.set(body.id,{...body});
    const s=Object.assign(Object.create(Session.prototype),{client:c,movementGeneration:0,name:'offline-bastion',
      cancelledMovementTokens:new Set(),movementCancellationChecks:new Map(),
      need:()=>c,moveSpeed:()=>18,movementWasCancelled:(g,t)=>Session.prototype.movementWasCancelled.call(s,g,t)||packets.length>=maxPackets||Date.now()>deadline,
      pacer:{async submit(_kind,run){applyPending();bodyAuthority(s).guard();return run();},wake(){}},
      async confirmPosition(){c.roomContents();return c.self;},
      async refreshRoomIdentity(){c.roomContents();return {confirmed:true,room:s.world.room};},
      async _askStrategies(){return null;},_blinkPointHere:()=>null,
      noteTransit(){},planSameRoomDoors:()=>null,
    });
    Object.defineProperty(s,'live',{value:true});
    s.world=new World(c,map);s.threatsHere=()=>[];
    const leave=s.leaveVia;
    s.leaveVia=async function(exit,options){const at=packets.length,r=await leave.call(this,exit,options);asks.push({room:map.rooms[room].num,to:exit.to,stage:exit.stand_on,reason:r.reason,left:r.left,packets:packets.length-at,position:{...c.self}});return r;};
    return {s,c,packets,crossings,asks,applyPending};
  }
  return {fixture,map,Session,imp};
}
