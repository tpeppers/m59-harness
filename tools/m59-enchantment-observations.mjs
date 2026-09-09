// Passive presentation metadata. Never requests the initial enchantment list,
// inspects an effect, or authorizes an action. Empty is NOT proof of no buffs.
const integer=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
export class EnchantmentObservations {
  constructor(){this.reset();}
  reset(){this.entries=new Map();this.player=null;this.room=null;this.at=0;this.asOf=0;this.truncated=false;}
  enter(player,room,at){
    if(this.player!==player)this.reset();
    // The native client clears room icons on every PLAYER/new-room message.
    for(const [key,e] of this.entries)if(e.type===2)this.entries.delete(key);
    this.player=player;this.room=room;this.at=at;
  }
  add(type,o,name,at){
    if(![1,2].includes(type)||!integer(o?.id,1,0x0fffffff)||!integer(at,1,Number.MAX_SAFE_INTEGER))return;
    const key=type+':'+o.id;
    if(!this.entries.has(key)&&this.entries.size>=256){this.truncated=true;return;}
    const old=this.entries.get(key),a=o.animate||{};
    const animate={animation:a.animation,group:a.group??0,period:a.period??0,
      groupLow:a.groupLow??0,groupHigh:a.groupHigh??0,groupFinal:a.groupFinal??0};
    const appearance={icon_rsc:o.iconRsc,translation:o.translation??0,effect:o.effect??0,
      overlays:(o.overlays||[]).length,animate};
    const same=old&&JSON.stringify(old.appearance)===JSON.stringify(appearance);
    this.entries.set(key,{id:o.id,type,name:String(name||'Effect '+o.id).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,256),
      first_seen_at:old?.first_seen_at??at,last_seen_at:at,animation_at:same?old.animation_at:at,appearance});
    this.at=at;
  }
  remove(type,id,at){if(![1,2].includes(type))return;this.entries.delete(type+':'+id);this.at=at;}
  invalidate(at){this.entries.clear();this.truncated=false;this.at=at;}
  snapshot(connected,now){
    this.asOf=Math.max(this.asOf,this.at,connected?now:0);
    return {schema:'m59-enchantment-observations/1',coverage:'observed-only',
      player_id:this.player,room_object_id:this.room,as_of:this.asOf,
      connected:!!connected,truncated:this.truncated,entries:[...this.entries.values()].map(e=>structuredClone(e))};
  }
}
