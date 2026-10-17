// Recovery spells need standing posture just as ordinary explicit casts do.
// Both packets remain paced; urgent ordering keeps background rest out of the
// stand-to-cast gap. Every actual send rechecks the original ownership fence.
export async function sendRecoverySpell(s,c,spell,targets,valid){
 let stood=false,sent=false,postureAtSend=null;
 const standing=()=>c.lastPostureCommand?.verb==='stand'&&c.lastPostureCommand.room_object_id===c.room?.id;
 if(!valid())return{sent,stood,reason:'recovery cast ownership changed'};
 if(!standing()){
  if(typeof c.stand!=='function')return{sent,stood,reason:'recovery cast cannot establish standing posture'};
  await s.pacer.submit('stand',()=>{if(!valid())return;c.stand();stood=true;},0,{urgent:true});
 }
 if(!valid()||!standing())return{sent,stood,reason:'recovery cast posture or ownership changed'};
 await s.pacer.submit('cast',()=>{if(!valid()||!standing())return;postureAtSend={...c.lastPostureCommand};c.cast(spell.id,targets);sent=true;},1050,{urgent:true});
 return{sent,stood,posture_at_send:postureAtSend,reason:sent?null:'recovery cast conditions changed before send'};
}
