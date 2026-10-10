import {walk,shop} from '../m59-fleetscript.mjs';
export const script={name:'island-bows',describe:'Buy longbows and arrows at Hanla\'s counter, then return to Ko\'catan town',
  params:{agents:{type:'agents',required:true},bows:{type:'number',default:1},arrows:{type:'number',default:200},
    minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20}},
  async steps(p){
    for(const n of [p.bows,p.arrows])if(!Number.isSafeInteger(n)||n<0)throw Error('bow and arrow quantities must be nonnegative integers');
    if(!p.bows&&!p.arrows)throw Error('no island supplies requested');
    return [walk(2100),shop("Hanla zax'Ta",[
      ...(p.bows?[{match:/^longbow$/i,amount:p.bows}]:[]),
      ...(p.arrows?[{match:/^arrows?$/i,amount:p.arrows}]:[])]),walk(2000)];
  }
};
