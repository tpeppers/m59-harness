import {verify} from '../m59-fleetscript.mjs';
import {runBraxLedgeLeg} from '../m59-brax-logistics.mjs';
export const script={name:'brax-ledge-leg',describe:'Walk one side of the Brax supply handoff and return without crossing the ledge or using Ancient Place.',mode:'errand',
 params:{agents:{type:'agents',required:true},role:{type:'string',required:true},direction:{type:'string',default:'out'},minHealth:{type:'number',default:.9},fragileBelow:{type:'number',default:1}},
 async steps(p){if(!['farmer','courier'].includes(p.role)||!['out','back'].includes(p.direction))throw Error('role farmer/courier and direction out/back required');return[verify(ctx=>runBraxLedgeLeg(ctx,p),'Brax ledge service leg failed')];}};
