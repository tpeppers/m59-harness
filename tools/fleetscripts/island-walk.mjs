// #movement: mainland cave <-> Ko'catan, with independently planned directions.
import {act,verify} from '../m59-fleetscript.mjs';
import {walkIsland,reportIslandOutbound,waitIslandOutbound,releaseIslandWave,ISLAND_CONVOY_WAIT_MS} from '../m59-island-route.mjs';
export const script={name:'island-walk',describe:'Walk the cave route to or from Ko\'catan and record each crossing',
  params:{agents:{type:'agents',required:true},direction:{type:'string',default:'out'},roundtrip:{type:'boolean',default:false},
    budgetMs:{type:'number',default:180000},departSpacingMs:{type:'number',default:20000},waveBudgetMs:{type:'number',default:ISLAND_CONVOY_WAIT_MS},queueBudgetMs:{type:'number',default:ISLAND_CONVOY_WAIT_MS},fragileBelow:{type:'number',default:20},minHealth:{type:'number',default:1},minVigor:{type:'number',default:80},requireSafeLegs:{type:'boolean',default:false}},
  async steps(p){if(!['out','back'].includes(p.direction))throw Error('direction must be out or back');
    if(!Number.isSafeInteger(p.departSpacingMs)||p.departSpacingMs<0||
      ![p.waveBudgetMs,p.queueBudgetMs].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('invalid Island convoy timing');
    return [act('cancel_movement',{}),act('rest',{stand:true}),verify(async ctx=>{
      let first;
      try{
        if(p.roundtrip){
          ctx.state.islandCancelFence=Date.now();
          await waitIslandOutbound(ctx,p.agents,{phase:'out',room:p.direction==='out'?27:2000,budgetMs:p.waveBudgetMs,spacingMs:p.departSpacingMs});
        }
        first=await walkIsland(ctx,p);
      }
      finally{if(p.roundtrip){ctx.state.islandOutboundComplete=first?.ok===true;if(first?.ok)reportIslandOutbound(ctx,p.agents,true);}}
      if(!first.ok||!p.roundtrip)return first;
      await waitIslandOutbound(ctx,p.agents,{room:p.direction==='out'?2000:27,budgetMs:p.waveBudgetMs,spacingMs:p.departSpacingMs});
      return walkIsland(ctx,{...p,direction:p.direction==='out'?'back':'out'});
    },'Island walk failed; read its receipt'),
    {...verify(ctx=>{if(p.roundtrip)releaseIslandWave(ctx,p.agents);return true;},'Island wave cleanup failed'),always:true}];}
};
