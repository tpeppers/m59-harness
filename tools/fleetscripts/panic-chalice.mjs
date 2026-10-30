import {verify,call} from '../m59-fleetscript.mjs';
import {panicChalice} from '../m59-panic-chalice.mjs';
import {mkdirSync,writeFileSync,readdirSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
// runNamed calls steps separately for each agent, passing the same agents array.
// The rendezvous must belong to that run, rather than to one agent's step list.
const runs=new WeakMap();
export async function panicSteps(p,{execute=panicChalice}={}){
    const agents=Array.isArray(p.agents)?p.agents:String(p.agents).split(',').filter(Boolean);
    if(!agents.length||agents.includes('*'))throw Error('Select explicit automated agents for emergency control');
    let session=runs.get(agents);
    if(!session){session={ready:new Map()};runs.set(agents,session);}
    return [verify(async ctx=>{
      if(session.aborted)throw Error(session.aborted);
      session.ready.set(ctx.agent,ctx);
      const until=Date.now()+10000;
      while(session.ready.size<agents.length){
        if(Date.now()>until)session.aborted='Not every keeper was claimed; no maneuver started';
        if(session.aborted)throw Error(session.aborted);
        await new Promise(r=>setTimeout(r,100));
      }
      if(session.aborted)throw Error(session.aborted);
      if(!session.run){
        const dir=resolve('substrate/scratch/panic-chalice');mkdirSync(dir,{recursive:true});
        session.file=resolve(dir,Date.now()+'.json');
        session.run=execute({call:ctx.call,agents,destination:Number(p.destination??2001),gatherMs:Number(p.gatherMs??30000),budgetMs:Number(p.budgetMs??120000),save:r=>writeFileSync(session.file,JSON.stringify(r,null,2))}).finally(()=>runs.delete(agents));
      }
      const receipt=await session.run;return {ok:!!receipt.agents[ctx.agent]?.arrived,why:receipt.agents[ctx.agent]?.failure??'landing not confirmed',receipt:session.file};
    },'Emergency landing incomplete: read panic receipt')];
}
export const script={
  name:'panic-chalice',
  describe:'Parallel emergency chalice trades with guarded jungle/forest refills, last-charge protection, 30s gather/Blink fallback.',
  finishOnAlert:true,
  recipe:{effect:'Use parallel direct-trade desks; refill as needed only in eligible rooms with a fresh pickup-range safety check. Preserve the final charge and overlap rescue timers.',
    run:'panic-chalice agents=t3,t6,t7 destination=2001',
    needs:['Enough proven charges: reserve one final charge plus the owner escape before allocating borrowers','Native Rescue must land at the requested destination; this script never walks between rooms','Coordinate with other fleet controllers before starting'],
    notes:['Independent holders drink immediately; desks trade and serve in parallel. Ground drops are only for necessary, guarded refills.','Native pickup range is abs(delta row)+abs(delta col)<=7; refills exclude enemies/untrusted players within 11 using a four-square movement buffer. Unknown positions refuse a drop.','Default rendezvous deadline is 30 seconds. Unreachable groups cancel movement, seek local safe spots and Blink.','The 120-second budget reports failure when resources, PvP locks, trade preemption or geometry prevent escape. It cannot guarantee an impossible landing.','Arrivals remain confined at their destination. Unresolved pending sips or floor recovery in previous receipts block automatic reuse.']},
  params:{agents:{type:'agents',required:true},destination:{type:'room',default:2001},gatherMs:{type:'number',default:30000},budgetMs:{type:'number',default:120000}},
  async resolveAgents({agents,destination=2001}){
    const fleet=await call('fleet'),rows=new Map((fleet.fleet??[]).map(r=>[r.agent,r]));
    const selected=[],skipped=[];
    for(const a of agents){const row=rows.get(a);if(!row||row.piloted||row.in_roster===false)skipped.push({agent:a,why:!row?'not in live fleet':row.piloted?'human piloted':'not in roster'});else selected.push(a);}
    const dir=resolve('substrate/scratch/panic-chalice');
    if(existsSync(dir))for(const f of readdirSync(dir).filter(f=>f.endsWith('.json'))){
      const prior=JSON.parse(readFileSync(resolve(dir,f),'utf8'));
      for(const a of selected){
        if(prior.cups?.some(c=>c.floor_pending?.agent===a))throw Error(a+': unresolved floor cup recovery in '+f+'; recover/inspect before reuse');
        if(prior.cups?.some(c=>c.command_uncertain&&c.uncertain_agents?.includes(a)))throw Error(a+': ambiguous prior cup command in '+f+'; manual review required before reuse');
        if(prior.agents?.[a]?.pending){
        const l=await call('look',{agent:a});
        if(l.room?.num!==Number(destination))throw Error(a+': unresolved prior sip in '+f+'; inspect before retrying');
      }}
    }
    return {agents:selected,skipped};
  },
  steps:panicSteps,
};
