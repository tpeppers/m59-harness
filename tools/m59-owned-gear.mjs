// Ordinary carried-weapon preparation under the caller's existing public work lease.
import{isWeaponName}from'./m59-items.mjs';
import{islandReadOwner,checkIslandCancellation}from'./m59-island-observation.mjs';
import{isActiveRecoveryDecision}from'./m59-survival-decision.mjs';
export async function equipOwnedCarriedWeapon(ctx,{name,read,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=30000}={}){
 if(!isWeaponName(name)||typeof read!=='function')throw Error('a known carried weapon and native reader are required');
 const deadline=Date.now()+timeoutMs,initial=await read();
 const body=(s,{allowRecovery=false}={})=>{checkIslandCancellation(ctx,s);if(!islandReadOwner(ctx,s)||s.pid!==initial.pid||s.character!==initial.character||s.room.num!==initial.room.num||s.room.num===1||!Number.isInteger(s.room.num)||!(s.hp.value>0))throw Error('owned gear body or authority changed');if(!allowRecovery&&(s.autopilot_status?.recovery_travel||isActiveRecoveryDecision(s.autopilot_status?.survival_decisions?.current)))throw Error('survival owns gear preparation');};
 let s=initial;body(s,{allowRecovery:true});
 if(!s.autopilot_status?.cast_rite?.active&&s.equipment_items?.some(i=>i.name===name))return{ok:true,alreadyEquipped:true,weapon:name};
 body(s);
 while(s.autopilot_status?.cast_rite?.active||s.job?.busy||s.movement?.order||(s.autopilot_status?.ladder?.in_flight??[]).some(x=>['passErrand','passFarm','passBuddy'].includes(x.stage))){if(Date.now()>deadline)throw Error('prior cast/work has not settled');await wait(250);s=await read();body(s);}
 if(s.equipment_items?.some(i=>i.name===name))return{ok:true,alreadyEquipped:true,weapon:name};
 await ctx.call('rest',{agent:ctx.agent,stand:true});
 // Let the old cast rite restore its own costume before selecting the new fighting weapon.
 const displaced=(s.equipment_items??[]).filter(i=>isWeaponName(i.name)&&i.name!==name);
 for(const item of displaced){const reply=await ctx.call('act',{agent:ctx.agent,verb:'unuse',target:item.id});s=await read();body(s);if(s.equipment_items?.some(i=>i.id===item.id))throw Object.assign(Error('existing weapon could not be unwielded'),{reply});}
 const p=await ctx.call('inventory',{agent:ctx.agent}),item=p.items?.find(i=>i.name===name&&!i.broken);if(!item)throw Error('selected carried weapon absent');
 const reply=await ctx.call('act',{agent:ctx.agent,verb:'use',target:item.id});await ctx.call('equipment',{agent:ctx.agent,refresh:true});s=await read();body(s,{allowRecovery:true});while(s.autopilot_status?.cast_rite?.active){if(Date.now()>deadline)throw Error('post-use cast has not settled');await wait(250);s=await read();body(s,{allowRecovery:true});}if(!s.equipment_items?.some(i=>i.name===name))throw Object.assign(Error('selected carried weapon not actually equipped'),{reply});return{ok:true,weapon:name,reply};
}
