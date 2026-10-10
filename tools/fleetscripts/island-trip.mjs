// Compose within one driver/lease; no nested runner or production DM actions.
import {verify} from '../m59-fleetscript.mjs';
import {loadFleetScripts,applyDefaults,checkParams} from '../m59-fleetlib.mjs';
import {rideIslandCup} from '../m59-island-chalice.mjs';
import {walkIsland} from '../m59-island-route.mjs';
import {script as home} from './island-home.mjs';

export async function islandTaskSteps(p,{scripts}={}){
  if(!p.task)return [];
  scripts??=(await loadFleetScripts()).scripts;
  const task=scripts.get(p.task);
  if(!task||['island-trip','island-home','island-walk','island-chalice'].includes(p.task))throw Error('invalid island task');
  if(task.unsafe)throw Error('island task may not waive expedition guarantees');
  const supplied=JSON.parse(p.taskParams??'{}');
  if(!supplied||Array.isArray(supplied)||typeof supplied!=='object')throw Error('taskParams must be a JSON object');
  // The parent owns exactly these bodies and retains its health floors.
  const args=applyDefaults(task,{...supplied,agents:p.agents,agent:p.agent,minHealth:p.minHealth,fragileBelow:p.fragileBelow});
  const bad=checkParams(task,args);if(bad.length)throw Error(bad.join('; '));
  return task.steps(args);
}
export const script={name:'island-trip',describe:'Go to the Island, refill after a chalice ride, run a named FleetScript, and return to Tos',
  params:{agents:{type:'agents',required:true},outbound:{type:'string',default:'chalice'},task:{type:'string',default:''},taskParams:{type:'string',default:'{}'},
    home:{type:'number',default:52},budgetMs:{type:'number',default:800000},requireSafeLegs:{type:'boolean',default:true},
    keepItems:{type:'boolean',default:true},minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20},minVigor:{type:'number',default:120}},
  async steps(p){
    if(!['chalice','walk'].includes(p.outbound))throw Error('outbound must be chalice or walk');
    const task=await islandTaskSteps(p); // compile every stage before movement
    return [verify(ctx=>p.outbound==='chalice'?rideIslandCup(ctx,p):walkIsland(ctx,{...p,direction:'out'}),
      'Island departure incomplete; preserve its receipt'),...task,...await home.steps(p)];
  }
};
