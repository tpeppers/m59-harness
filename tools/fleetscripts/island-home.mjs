// #movement: independently planned cave return, then ordinary travel home to Tos.
import {verify,walk} from '../m59-fleetscript.mjs';
import {walkIsland,recoverIslandMainland,ISLAND,CAVE} from '../m59-island-route.mjs';
// One cast of blink at a time until the keeper says it relocated us; a no-op outside the cave.
export async function blinkOutOfCave(ctx,{tries=6}={}){
  for(let k=0;k<tries;k++){
    const l=await ctx.call('look',{agent:ctx.agent}).catch(()=>null);
    if(l?.room?.num!==CAVE)return true;
    await ctx.call('cancel_movement',{agent:ctx.agent}).catch(()=>null);
    const r=await ctx.call('cast',{agent:ctx.agent,spell:'blink'},40000).catch(()=>null);
    if(r?.keeper_said?.relocated)return true;
    await new Promise(z=>setTimeout(z,4000));
  }
  return {ok:false,why:'blink did not relocate in '+tries+' casts'};
}
export const script={name:'island-home',describe:'Return from Ko\'catan through the caves, then to Tos',
  params:{agents:{type:'agents',required:true},home:{type:'number',default:52},
    budgetMs:{type:'number',default:800000},requireSafeLegs:{type:'boolean',default:true},
    minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20},minVigor:{type:'number',default:120}},
  async steps(p){return [walk(ISLAND,{runErrands:false}),
    verify(ctx=>walkIsland(ctx,{...p,direction:'back'}),'Island return stopped; read the crossing receipt'),
    verify(ctx=>recoverIslandMainland(ctx),'Mainland cave recovery incomplete'),
    // OUT OF THE ICKY CAVE BY BLINK, NEVER BY DISPEL (operator 2026-10-26: "have people exiting the island tunnel always
    // blink out, never requiring a dispel"). The walk home from the cave failed three times in a row behind the illusion
    // (Waldorf, r56c48 in 27); one blink that relocated put him at r23c16 and the walk to 587 arrived in one hop. A cast can
    // fail its roll, so cast until the keeper reports a relocation (at most 6), then walk.
    {...verify(ctx=>blinkOutOfCave(ctx),'blink out of the Icky Cave'),optional:true},
    walk(p.home,{avoid:[5],runErrands:false})];}
};
