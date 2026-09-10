// Passive BP_PLAY_WAVE/MUSIC/MIDI capture. No sends, refreshes or behavior.
// Wire layout: clientd3d/server.c; volume/position: game.c + audio_openal.c.
import {randomUUID} from 'node:crypto';
import {perf} from './m59-perf.mjs';
export const AUDIO_SCHEMA='m59-audio-observations/1';
export function audioStem(value){return typeof value==='string'&&/^[a-z0-9_-]{1,64}\.(wav|ogg|mid|midi|mp3)$/i.test(value)?value.replace(/\.[^.]+$/,'').toLowerCase():null;}
export function parseAudio(op,b,rsc){
 if(![170,171,172].includes(op))return null;
 if(!Buffer.isBuffer(b)||b.length!==(op===170?25:4))throw Error('Invalid audio packet length');
 const resource=b.readUInt32LE(0),stem=resource?audioStem(rsc.get(resource)):'';
 if(resource&&!stem)return null; // Never turn a wire resource into an arbitrary path.
 if(op!==170)return {kind:'music',resource,stem};
 if(!resource)return null;
 return {kind:'sound',resource,stem,source:b.readUInt32LE(4)&0x0fffffff,flags:b[8],
  // Native GamePlaySound receives WORDs, despite 32-bit serialized fields.
  row:b.readInt32LE(9)&65535,col:b.readInt32LE(13)&65535,
  radius:b.readInt32LE(17)&65535,max_volume:b.readInt32LE(21)&65535};
}
export class AudioObservations {
 constructor({now=Date.now}={}){this.now=now;this.key='';this.reset();}
 reset(){this.epoch=randomUUID();this.sequence=0;this.music=null;this.loops=new Map();this.events=[];this.key='';}
 enter(player,room,rsc,security){const key=[player,room,rsc,security].join(':');if(key!==this.key){this.reset();this.key=key;}}
 receive(op,body,rsc){const e=parseAudio(op,body,rsc);if(!e||!this.key)return false;
  perf('audio.capture_packets');perf('audio.capture_payload_bytes',body.length);
  Object.assign(e,{seq:++this.sequence,at:this.now()});
  if(e.kind==='music')this.music=e;
  else if(e.flags&1){if(this.loops.has(e.stem)||this.loops.size<32)this.loops.set(e.stem,e);}
  else{this.events.push(e);if(this.events.length>128)this.events.shift();}
  return true;
 }
 snapshot(after=null){const now=this.now();return {schema:AUDIO_SCHEMA,epoch:this.epoch,sequence:this.sequence,at:now,
  music:this.music?{...this.music}:null,loops:[...this.loops.values()].map(e=>({...e})),
  events:after==null?[]:this.events.filter(e=>e.seq>after&&now-e.at<=2000).map(e=>({...e}))};}
}
// client/BSP grid has origin zero; harness KOD grid has origin one.
const point=o=>Number.isFinite(o?.x)&&Number.isFinite(o?.y)?{row:Math.floor(o.y/64)-1,col:Math.floor(o.x/64)-1}:null;
export function audioGain(e,c){
 const listener=point(c.self),source=e.source?point(c.room?.objects?.get(e.source)):null;
 const row=source?.row??e.row,col=source?.col??e.col,loop=!!(e.flags&1);
 const nonpos=!!(e.flags&4)||(loop&&row<=2&&col<=2)||!(row>0||col>0);
 const distance=listener?Math.hypot(listener.row-row,listener.col-col):0;
 const maximum=Math.min(50,e.max_volume||50)/50;
 let gain=maximum;
 if(!nonpos){if(loop||e.radius){const radius=e.radius||16;gain*=radius<=1?(distance<=1?1:0):Math.max(0,1-(Math.max(1,distance)-1)/(radius-1));}
  else gain*=distance<=2?1:2/distance;}
 else if(source&&listener)gain=distance<=2?1:2/distance;
 else if(listener&&(e.row||e.col))gain=maximum*Math.max(0,1-distance/(e.radius||16));
 return Math.max(0,Math.min(1,gain));
}
export function audioView(c,{agent,character,pid,room,connected},after){
 perf('audio.observation_reads');
 const v=c.audioObservations.snapshot(after);
 return {...v,agent,character,pid,room,connected:!!connected,player:c.selfId,room_object:c.room?.id,
  rsc:c.roomRsc,security:c.room?.security,
  loops:v.loops.map(e=>({...e,gain:audioGain(e,c)})),events:v.events.map(e=>({...e,gain:audioGain(e,c)}))};
}
