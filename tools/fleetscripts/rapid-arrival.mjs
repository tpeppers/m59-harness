import {walk} from '../m59-fleetscript.mjs';
export const script={
 name:'rapid-arrival',
 describe:'Travel to a destination using the private Rescue/chalice routing policy when enabled; retains ordinary movement and survival guards.',
 params:{agents:{type:'agents',required:true},to:{type:'number',required:true}},
 async steps(p){return [walk(p.to)];}
};
