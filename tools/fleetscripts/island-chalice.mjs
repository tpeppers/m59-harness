import {act,verify} from '../m59-fleetscript.mjs';
import {rideIslandCup} from '../m59-island-chalice.mjs';
export const script={name:'island-chalice',describe:'Full chalice to Ko\'catan: two landings, jungle refill, reclaim contraband',
  params:{agents:{type:'agents',required:true},keepItems:{type:'boolean',default:true},fragileBelow:{type:'number',default:20},minHealth:{type:'number',default:1}},
  async steps(p){return [act('cancel_movement',{}),verify(ctx=>rideIslandCup(ctx,p),'Island chalice ride incomplete; preserve its pending receipt')];}
};
