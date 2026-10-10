// #movement: independently planned cave return, then ordinary travel home to Tos.
import {verify,walk} from '../m59-fleetscript.mjs';
import {walkIsland} from '../m59-island-route.mjs';
export const script={name:'island-home',describe:'Return from Ko\'catan through the caves, then to Tos',
  params:{agents:{type:'agents',required:true},home:{type:'number',default:52},
    budgetMs:{type:'number',default:800000},requireSafeLegs:{type:'boolean',default:true},
    minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20},minVigor:{type:'number',default:120}},
  async steps(p){return [verify(ctx=>walkIsland(ctx,{...p,direction:'back'}),'Island return stopped; read the crossing receipt'),walk(p.home,{avoid:[5,587],runErrands:false})];}
};
