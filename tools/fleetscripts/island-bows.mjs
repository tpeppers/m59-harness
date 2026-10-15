import {walk,shop,verify} from '../m59-fleetscript.mjs';
import {buyCourierGoods} from '../m59-courier-purchases.mjs';
export const script={name:'island-bows',describe:'Buy practice bows at Kochtal and arrows at Hanla, then return to Ko\'catan town',
  params:{agents:{type:'agents',required:true},bows:{type:'number',default:1},arrows:{type:'number',default:200},bowType:{type:'string',default:'practice'},maxBows:{type:'boolean',default:false},
    minHealth:{type:'number',default:1},fragileBelow:{type:'number',default:20}},
  async steps(p){
    for(const n of [p.bows,p.arrows])if(!Number.isSafeInteger(n)||n<0)throw Error('bow and arrow quantities must be nonnegative integers');
    if(!p.maxBows&&!p.bows&&!p.arrows)throw Error('no island supplies requested');
    const type=p.bowType??'practice';
    if(!['practice','long'].includes(type))throw Error('bowType must be practice or long');
    if(p.maxBows){
      if(type!=='practice')throw Error('maxBows requires practice bows');
      const buy=options=>verify(async ctx=>{await buyCourierGoods(ctx,options);return true;},'Courier purchase receipt retained; continue home after a short or refused order');
      return [...(p.arrows?[walk(2100),buy({seller:"Hanla zax'Ta",item:'arrow',aliases:['arrows'],amount:p.arrows}),walk(2000)]:[]),
        walk(2014),buy({seller:"Kochtal ko'Tulca",item:'practice bow',maximize:true}),walk(2000)];
    }
    const steps=[];
    if(p.bows&&type==='practice')steps.push(walk(2014),shop("Kochtal ko'Tulca",[{match:/^practice bow$/i,amount:p.bows}]),walk(2000));
    if(p.arrows||p.bows&&type==='long')steps.push(walk(2100),shop("Hanla zax'Ta",[
      ...(p.bows&&type==='long'?[{match:/^longbow$/i,amount:p.bows}]:[]),
      ...(p.arrows?[{match:/^arrows?$/i,amount:p.arrows}]:[])]),walk(2000));
    return steps;
  }
};
