import {act,verify} from '../m59-fleetscript.mjs';
import {rideIslandCup} from '../m59-island-chalice.mjs';
import {resolve,give,relocate,heal} from '../m59-dm.mjs';
export const script={name:'island-chalice-shadow',describe:'Prepare an isolated production clone, then run the ordinary chalice workflow',
  params:{agents:{type:'agents',required:true},contraband:{type:'boolean',default:false},keepItems:{type:'boolean',default:true},fragileBelow:{type:'number',default:20},minHealth:{type:'number',default:1}},
  async steps(p){return [act('cancel_movement',{}),verify(async ctx=>{
    const h=await(await fetch(process.env.M59_CONTROL_URL+'health')).json();
    if(h.fleet!=='shadow'||h.game_server.host!=='127.0.0.1'||h.game_server.port!==15959)throw Error('wrong lab');
    const name=h.session_characters[ctx.agent];if(!name)throw Error('not in shadow fleet');
    const inv=await ctx.call('inventory',{agent:ctx.agent});
    if(!inv.items.some(i=>/chalice of the rain/i.test(i.name)))await give((await resolve(name))[name],{each:1,stacking:[],singles:['Chalice']});
    if(p.contraband)await give((await resolve(name))[name],{each:4,stacking:['NeruditeOreChunk'],singles:['LongSword']});
    await heal(name);await relocate(name,2500,{row:42,col:38,verify:true});
    return true;
  },'shadow setup failed'),act('rest',{stand:true}),verify(ctx=>rideIslandCup(ctx,p),'chalice workflow failed; retain cargo receipt')];}
};
