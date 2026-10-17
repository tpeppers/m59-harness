import{sendRecoverySpell}from'./m59-recovery-cast.mjs';
// Ordinary source-costed self cure: cpoison.kod (10 mana,2 herbs,1 elderberry).
import{withCastRite}from'./m59-castrite.mjs';
const poisoned=c=>(c?.ailments?.()??[]).some(e=>String(e.name??'').trim().toLowerCase()==='poison');
export function affordablePoisonCure(c){
 if(c?.state!=='game'||c.combatReady!==true||!poisoned(c)||!(c?.vitals?.()?.health?.value>0)||!(c.vitals()?.mana?.value>=11))return null;
 const spell=(c.spells??[]).find(s=>String(c.rsc?.get?.(s.nameRsc)??'').toLowerCase()==='cure poison');if(!spell)return null;
 const count=name=>(c.inventory??[]).filter(o=>name.test(String(c.rsc?.get?.(o.nameRsc)??''))).reduce((n,o)=>n+(Number(o.amount)||1),0);
 return count(/^herbs?$/i)>=2&&count(/^elderberr(?:y|ies)$/i)>=1?spell:null;
}
export async function castRecoveryCure(s,{shouldCancel=()=>false}={}){
 const c=s.client,spell=affordablePoisonCure(c),self=c?.selfId,room=c?.room?.id;if(!spell||!self||shouldCancel())return{cast:false,reason:'no affordable observed poison cure'};
 const mana=c.vitals().mana.value,seq=c.evSeq;let sent=false;
 const valid=()=>s.client===c&&c.selfId===self&&c.room?.id===room&&!shouldCancel()&&affordablePoisonCure(c)?.id===spell.id;
 const send=await withCastRite(s,{spell,targets:[self],why:'recovery cure poison'},()=>sendRecoverySpell(s,c,spell,[self],valid));sent=send.sent;
 if(!sent)return{cast:false,reason:'poison cure conditions changed before send'};
 if(poisoned(c)&&s.client===c)await c.waitFor({since:seq,kinds:['enchantment','stat','message'],timeoutMs:1500}).catch(()=>({}));
 const same=s.client===c&&c.selfId===self&&c.room?.id===room,spent=same?mana-c.vitals().mana.value:null,cleared=same&&!poisoned(c);
 const weakened=(c.eventsSince?.(seq)??[]).some(e=>e.kind==='message'&&e.text==="You feel the poison grow weaker.");
 return{cast:true,stood_before_cast:send.stood,posture_at_send:send.posture_at_send,spell:'cure poison',self:true,mana_spent:spent,paid:spent>0,poison_cleared:cleared,poison_weakened:weakened,confirmed:spent>0&&(cleared||weakened),note:'Confirmed means a paid cast followed by own observed removal or the exact server weakening message. A weakened poison may remain; no ally ailment is inferred.'};
}
