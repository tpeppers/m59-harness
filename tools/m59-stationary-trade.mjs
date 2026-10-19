// Short directional hold: protected survival runs before the hold rung and preempts it.
import {randomUUID} from 'node:crypto';
import {BP} from './m59-client.mjs';
import {bodyAuthority} from './m59-body-command.mjs';
const survivalStages=new Set(['passUnderworld','passArm','passPlaybook','passFightBack','passFleeAndRest']);
export function stationaryTradeReport(s){const h=s.stationaryTrade;return h?{token:h.token,why:h.why,expiresAt:h.expiresAt,active:stationaryTradeActive(s)}:null;}
export function stationaryTradeActive(s){const h=s?.stationaryTrade,v=s?.client?.vitals?.()?.health;return !!(h&&h.client===s.client&&h.life===(s.lifeBoundary??0)&&h.expiresAt>Date.now()&&v?.value>0&&v.value>=h.health&&s.world?.room?.num===h.room);}
export function holdStationaryTrade(s,why,maxMs=20000,token=null){
 if(s._tickLoop)return{held:false,reason:'stationary survival hold requires GOAP driver'};
 const old=s.stationaryTrade;if(old&&stationaryTradeActive(s)&&old.token!==token)return{held:false,reason:'another stationary exchange owns this body'};
 const health=s.client?.vitals?.()?.health;if(!Number.isInteger(s.world?.room?.num)||!s.client?.combatReady||!health?.max||health.value/health.max<.9||s.job?.busy||s.combat?.active)return{held:false,reason:'body is not ready for a stationary exchange'};
 if(old&&token&&old.token!==token)return{held:false,reason:'stationary exchange token changed'};
 const h={token:old?.token===token?token:randomUUID(),why,client:s.client,life:s.lifeBoundary??0,health:health.value,room:s.world?.room?.num,expiresAt:Date.now()+Math.max(1000,Math.min(30000,maxMs))};
 s.stationaryTrade=h;s.stationaryTradeRequired=true;return{held:true,hold:stationaryTradeReport(s)};
}
export function releaseStationaryTrade(s,token){if(s.stationaryTrade?.token!==token)return{released:false,reason:'not this exchange'};s.stationaryTrade=null;s.stationaryTradeRequired=false;return{released:true};}
export function requireStationaryTrade(s,token){if(!stationaryTradeActive(s)||s.stationaryTrade.token!==token)throw Object.assign(Error('stationary exchange expired or preempted by survival'),{code:'STATIONARY_TRADE_PREEMPTED'});}
export function observeStationaryMutation(s,op){
 if(s.stationaryTrade&&Date.now()>=s.stationaryTrade.expiresAt){s.stationaryTrade=null;s.stationaryTradeRequired=false;}
 if([BP.REQ_OFFER,BP.REQ_COUNTEROFFER,BP.ACCEPT_OFFER].includes(op)&&s.stationaryTradeRequired){requireStationaryTrade(s,s.stationaryTrade?.token);return;}
 if([BP.ACTION,BP.REQ_TURN,BP.REQ_MOVE,BP.REQ_GO,BP.REQ_ATTACK,BP.REQ_SHOOT,BP.REQ_CAST,BP.REQ_USE,BP.REQ_APPLY,BP.REQ_ACTIVATE].includes(op)&&s.stationaryTrade){
  const authority=bodyAuthority(s);if(stationaryTradeActive(s)&&authority.stage&&!survivalStages.has(authority.stage)&&authority.priority===0){s.stationaryTrade.lastWorkRefusal={at:Date.now(),stage:authority.stage,op};throw Object.assign(Error('ordinary work paused by stationary exchange'),{code:'STATIONARY_WORK_HELD'});}
  s.stationaryTrade.expiresAt=0;s.stationaryTrade.preemptedAt=Date.now();s.stationaryTrade.preemptedByStage=authority.stage;
 }
}
