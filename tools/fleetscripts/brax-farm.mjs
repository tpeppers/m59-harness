import {verify,walk} from '../m59-fleetscript.mjs';
import {script as migration} from './walk-to-brax.mjs';
import {braxFarmPlan,prepareBraxInitialization,assignBraxFarm,finishBraxInitialization,resolveBraxFarmAgents} from '../m59-brax-farm.mjs';
const routes=new Map(),routeKey=plan=>JSON.stringify(plan.farmers);
function migrationSteps(plan){
 const key=routeKey(plan);
 if(!routes.has(key))routes.set(key,migration.steps({agents:plan.farmers}).catch(error=>{routes.delete(key);throw error;}));
 return routes.get(key);
}
export const script={
 name:'brax-farm',mode:'errand',
 describe:'Initialize Brax farming and optional ArcherPlus training: provision, migrate, confine the upper party and start two mainland ledge couriers.',
 recipe:{run:'brax-farm agents=<farmers> couriers=<two mainland agents> runner=<one farmer>',
  effect:'Farmers remain upstairs; hammer farmers target worms or daemon skeletons, bow trainees run private ArcherPlus. Ledge-only courier resupply.',
  needs:['same deployed checkout and local broker','1..25 automated farmers plus2 explicit mainland couriers','ordinary shopping funds and carrying room'],
  cost:{time:'ordinary provisioning plus the complete walk-to-brax route',risk:'normal road, lift, cavern and farming encounters'},
  notes:['This is a finite initialization. Keepers farm afterward; the managed courier worker survives the REPL.',
   'No actor is chosen implicitly. Runner is one of the farmers; the two couriers never take the lift.',
   'A partial migration is a failure, with individual receipts; it never starts duplicate supply workers.']},
 params:{agents:{type:'agents',required:true},couriers:{type:'agents',required:true},runner:{type:'string',required:true},
  archers:{type:'string',default:'auto',describe:'auto detects existing bow training intent; or an explicit comma-separated subset of farmers'},
  archer_arrows:{type:'number',default:160},archer_hours:{type:'number',default:4},
  archer_mode:{type:'string',default:'snipe',options:['snipe','both','assist']},
  minHealth:{type:'number',default:.9},fragileBelow:{type:'number',default:1}},
 async resolveAgents(p){
  const resolved=await resolveBraxFarmAgents(p),plan=braxFarmPlan(p);
  // Static geometry can take tens of seconds on an unbaked checkout. Compile
  // once before acquiring any body, never once per held actor on the same loop.
  routes.delete(routeKey(plan));await migrationSteps(plan);return resolved;
 },
 async steps(p){const plan=braxFarmPlan(p),farmer=plan.farmers.includes(p.agent);
  return[verify(ctx=>prepareBraxInitialization(ctx,plan),'Brax group preparation failed'),
   ...(farmer?await migrationSteps(plan):[walk(350)]),
   verify(ctx=>assignBraxFarm(ctx,plan),'Brax standing farming assignment failed')];
 },
 afterRun:finishBraxInitialization,
};
