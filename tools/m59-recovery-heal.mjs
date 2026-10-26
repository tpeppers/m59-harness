import{sendRecoverySpell}from'./m59-recovery-cast.mjs';
import{affordablePoisonCure}from'./m59-recovery-cure.mjs';
// Ordinary resource-checked healing, usable from recovery without a work-pass detour.
import{withCastRite}from'./m59-castrite.mjs';
import{healingFeedback}from'./m59-healing-feedback.mjs';
export function healingManaReserve(c){const h=c?.vitals?.()?.health;return h?.max>0&&h.value>0&&h.value/h.max<=0.4?0:1;}
// WHICH HEALS THIS CHARACTER MAY CAST (policy.healSpells, broker `heal_spells`). null means every heal it knows, as before.
// Operator 2026-10-26, Pepe practising hospice on himself: "make sure he's only practicing hospice" -- the keeper's own
// recovery heal always tried minor heal first and trained it a dozen times an hour with no way to say no.
export function healAllowed(name,allow){return !Array.isArray(allow)||allow.some(a=>String(a).toLowerCase()===String(name).toLowerCase());}
export const HEAL_COSTS=Object.freeze([{name:'minor heal',mana:3,herbs:1},{name:'hospice',mana:10,herbs:3},{name:'major heal',mana:20,herbs:5}]);
export function affordableHeal(c,{reserve=healingManaReserve(c),allow=null}={}){
 const mana=c?.vitals?.()?.mana?.value;if(!Number.isFinite(mana))return null;
 const herbs=(c.inventory??[]).filter(o=>/^herbs?$/i.test(c.rsc.get(o.nameRsc)??'')).reduce((n,o)=>n+(Number(o.amount)||1),0);
 for(const cost of HEAL_COSTS){if(!healAllowed(cost.name,allow))continue;const spell=(c.spells??[]).find(sp=>String(c.rsc.get(sp.nameRsc)??'').toLowerCase()===cost.name);if(spell&&mana>=cost.mana+reserve&&herbs>=cost.herbs)return{spell,...cost};}return null;
}
export async function castRecoveryHeal(s,{targetId=s.client?.selfId,shouldCancel=()=>false,targetHealth=null,allow=null}={}){
 const c=s.client,self=c?.selfId,room=c?.room?.id;if(!c||!self||shouldCancel())return{cast:false,reason:'healing ownership changed'};
 const choice=affordableHeal(c,{allow});if(!choice)return{cast:false,reason:'no affordable known heal'};
 const before=c.vitals(),seq=c.evSeq;let sent=false;
 const valid=()=>s.client===c&&c.selfId===self&&c.room?.id===room&&!shouldCancel()&&!!affordableHeal(c,{allow})&&(targetId!==self||c.vitals()?.health?.value<c.vitals()?.health?.max)&&!!(targetId===self||c.room.objects.has(targetId));
 const send=await withCastRite(s,{spell:choice.spell,targets:[targetId],why:'recovery heal'},()=>sendRecoverySpell(s,c,choice.spell,[targetId],()=>valid()&&affordableHeal(c,{allow})?.spell.id===choice.spell.id));sent=send.sent;
 if(!sent)return{cast:false,reason:send.reason??'healing conditions changed before send',stood_before_cast:send.stood};
 // Mana payment may precede the healing by the spell's cast time. Wait for
 // subsequent feedback within one bounded observation window; never resend here.
 const until=Date.now()+1500;let cursor=seq,outcome=null;
 for(;;){
  if(s.client!==c)break;
  const observed=c.eventsSince?.(seq)??[];
  outcome=observed.filter(e=>e.kind==='message').map(e=>healingFeedback(e.text,{self:targetId===self})).find(Boolean)??outcome;
  const current=c.vitals();if(outcome||targetId===self&&current.health.value>before.health.value||Date.now()>=until)break;
  const reply=await c.waitFor({since:cursor,kinds:['stat','message'],timeoutMs:Math.max(1,until-Date.now())}).catch(()=>({}));
  const events=reply.events??[];outcome=events.filter(e=>e.kind==='message').map(e=>healingFeedback(e.text,{self:targetId===self})).find(Boolean)??outcome;
  const next=Math.max(cursor,...events.map(e=>Number(e.seq)||0));if(!events.length||next<=cursor)break;cursor=next;
 }
 const after=s.client===c?c.vitals():null,manaSpent=Number.isFinite(before.mana?.value)&&Number.isFinite(after?.mana?.value)?before.mana.value-after.mana.value:null;
 const healthGain=targetId===self&&Number.isFinite(after?.health?.value)?after.health.value-before.health.value:null;
 return{cast:true,stood_before_cast:send.stood,posture_at_send:send.posture_at_send,spell:choice.name,targetId,self:targetId===self,mana_spent:manaSpent,paid:manaSpent>0,health_gain:healthGain,server_outcome:outcome?.state??null,server_message:outcome?.message??null,confirmed:manaSpent>0&&!['failed','unnecessary'].includes(outcome?.state)&&(outcome?.state==='succeeded'||targetId===self&&healthGain>0),target_health_before:targetHealth,note:'Mana spend confirms a paid cast, not the recipient HP gain; damage and regeneration may overlap.'};
}

export function healReadiness(c,{allow=null}={}){const known=(c?.spells??[]).map(sp=>String(c.rsc?.get?.(sp.nameRsc)??'').toLowerCase()).filter(name=>HEAL_COSTS.some(cost=>cost.name===name));const herbs=(c?.inventory??[]).filter(o=>/^herbs?$/i.test(c.rsc?.get?.(o.nameRsc)??'')).reduce((n,o)=>n+(Number(o.amount)||1),0),choice=affordableHeal(c,{allow});return{inventory_at:c?.inventoryAt??null,spells_at:c?.spellsAt??null,herbs:c?.inventoryAt==null?null:herbs,known_heals:c?.spellsAt==null?null:known,elderberries:c?.inventoryAt==null?null:(c.inventory??[]).filter(o=>/^elderberr(?:y|ies)$/i.test(c.rsc?.get?.(o.nameRsc)??'')).reduce((n,o)=>n+(Number(o.amount)||1),0),known_cure_poison:c?.spellsAt==null?null:(c.spells??[]).some(sp=>String(c.rsc?.get?.(sp.nameRsc)??'').toLowerCase()==='cure poison'),cure_affordable:affordablePoisonCure(c)?'cure poison':null,mana:c?.vitals?.()?.mana?.value??null,mana_reserve:healingManaReserve(c),affordable:choice?.name??null};}
