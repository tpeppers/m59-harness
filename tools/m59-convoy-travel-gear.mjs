import{isWeaponName}from'./m59-items.mjs';
import{isActiveRecoveryDecision}from'./m59-survival-decision.mjs';
import{islandReadOwner,checkIslandCancellation}from'./m59-island-observation.mjs';
// Equip only stock already carried by this actor, before any shared staging wait.
export async function equipCarriedTravelWeapon(ctx,{read}={}){
 const initial=await read(ctx);checkIslandCancellation(ctx,initial);
 if(!islandReadOwner(ctx,initial))throw Error('travel_gear_owner_changed');
 if(initial.equipment_items?.some(i=>isWeaponName(i.name)))return{equipped:true,unchanged:true};
 if(!(initial.hp?.value>0)||initial.room?.num===1||initial.autopilot_status?.recovery_travel||isActiveRecoveryDecision(initial.autopilot_status?.survival_decisions?.current))return{equipped:false,held:true,reason:'recovery owns travel gear'};
 const stock=await ctx.call('inventory',{agent:ctx.agent}),weapon=stock.items.filter(i=>isWeaponName(i.name)).sort((a,b)=>Number(b.name==='hammer')-Number(a.name==='hammer'))[0];
 if(!weapon)return{equipped:false,reason:'no carried travel weapon'};
 const previous=initial.autopilot_status?.policy?.trainingWeaponOnly;
 if(weapon.name!=='hammer'&&previous===true)await ctx.call('autopilot',{agent:ctx.agent,action:'set',training_weapon_only:false});
 const actual=await read(ctx);checkIslandCancellation(ctx,actual);
 if(!islandReadOwner(ctx,actual)||actual.pid!==initial.pid||actual.you?.id!==initial.you?.id||actual.room?.num!==initial.room?.num||!(actual.hp?.value>0)||actual.autopilot_status?.recovery_travel||isActiveRecoveryDecision(actual.autopilot_status?.survival_decisions?.current))throw Error('travel_gear_body_or_recovery_changed');
 const fresh=await ctx.call('inventory',{agent:ctx.agent}),item=fresh.items.find(i=>i.name===weapon.name);if(!item)throw Error('travel_gear_inventory_changed');
 const reply=await ctx.call('act',{agent:ctx.agent,verb:'use',target:item.id}),after=await read(ctx);
 if(after.pid!==initial.pid||after.you?.id!==initial.you?.id||after.room?.num!==initial.room?.num||!(after.hp?.value>0)||!after.equipment_items?.some(i=>isWeaponName(i.name)))throw Error('travel_gear_equipment_not_confirmed');
 return{equipped:true,weapon:item.name,previousTrainingWeaponOnly:previous,relaxedTrainingWeaponOnly:weapon.name!=='hammer'&&previous===true,reply};
}
