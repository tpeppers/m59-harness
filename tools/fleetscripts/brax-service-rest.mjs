import {rest,verify} from '../m59-fleetscript.mjs';
import {createRailObserver} from '../m59-rail-observer.mjs';
export const script={name:'brax-service-rest',describe:'Meet an explicit service health goal through ordinary verified safe-wall rest; survival remains protected.',mode:'errand',params:{agents:{type:'agents',required:true},health:{type:'number',default:1}},
 async steps(p){p={health:1,...p};if(!Number.isFinite(p.health)||p.health<=0||p.health>1)throw Error('health must be a fraction in (0,1]');return[rest({health:p.health}),verify(async ctx=>{const s=await createRailObserver({fleet:ctx.fleet,agent:ctx.agent}).cached();return s.in_game===true&&s.connected===true&&s.hp?.max>0&&s.hp.value/s.hp.max>=p.health;},'native service health goal not reached')];}};
