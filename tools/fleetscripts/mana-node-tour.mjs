import {act,verify} from '../m59-fleetscript.mjs';
import {runTour} from '../m59-node-tour.mjs';
export const script={name:'mana-node-tour',describe:'Room 2 → upstairs Victoria → Sentinel → Ancient → Badlands → Icky Cave → room 2',
  params:{agents:{type:'agents',required:true},railFile:{type:'string',default:'substrate/node-rails.json'},
    evidenceDir:{type:'string',default:'substrate/node-tours'},minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20}},
  async steps(params){return [act('cancel_movement',{}),act('autopilot',{action:'busy',kind:'fleetscript',label:'mana-node-tour',lease_ms:120000}),
    act('rest',{stand:true}),verify(ctx=>runTour(ctx,params),'node tour stopped; inspect its receipt'),
    {...act('cancel_movement',{}),always:true}];}
};
