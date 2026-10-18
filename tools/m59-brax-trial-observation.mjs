// Read-only trial accounting from positive route receipts; admission is not a ride.
const stamp=value=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'?Date.parse(value):NaN;
const percentile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
export function braxTrialObservation({agents,startedAt,controllerStartedAt=startedAt,endedAt=null,results=null,eventsByAgent}){
 if(!Array.isArray(agents)||!agents.length||agents.length>25||new Set(agents).size!==agents.length||!Number.isFinite(startedAt)||!Number.isFinite(controllerStartedAt)||controllerStartedAt>startedAt)throw Error('invalid Brax trial identity/clocks');
 if(endedAt!=null&&(!Number.isFinite(endedAt)||endedAt<startedAt))throw Error('invalid Brax trial end');
 const arrivals=[],groups=new Map(),failures=[];
 const group=id=>{if(!groups.has(id))groups.set(id,{id,admitted:new Map(),aboard:new Map(),validated:new Map(),failed:new Map(),raisedAt:null});return groups.get(id);};
 for(const agent of agents){
  let activeBatch=null,arrived=null;
  for(const e of [...(eventsByAgent[agent]??[])].sort((a,b)=>stamp(a.at)-stamp(b.at))){
   const at=stamp(e.at);if(!Number.isFinite(at)||at<startedAt||endedAt!=null&&at>endedAt)continue;
   if(e.event==='admitted'&&typeof e.batch==='string'){activeBatch=e.batch;group(e.batch).admitted.set(agent,at);}
   if(e.event==='aboard'&&typeof e.batch==='string'){activeBatch=e.batch;group(e.batch).aboard.set(agent,at);}
   if(e.event==='failure'){failures.push({agent,at,reason:e.reason??null,batch:activeBatch});if(activeBatch)group(activeBatch).failed.set(agent,at);}
   if(['lift-raised','lift-validated'].includes(e.event)&&typeof e.batch==='string'){
    const g=group(e.batch),raisedAt=stamp(e.raisedAt);if(Number.isFinite(raisedAt)&&raisedAt>=startedAt&&raisedAt<=at)g.raisedAt=g.raisedAt==null?raisedAt:Math.min(g.raisedAt,raisedAt);
    if(e.event==='lift-validated'&&e.observed?.[3]===800&&e.observed?.[4]===510)g.validated.set(agent,at);
   }
   if(e.event==='objective'&&e.success===true&&e.room?.num===827&&e.hp?.value>0&&arrived==null)arrived=at;
  }
  if(arrived!=null)arrivals.push({agent,at:arrived,travelMs:arrived-startedAt,orderToArrivalMs:arrived-controllerStartedAt});
 }
 const lifts=[...groups.values()].map(g=>({id:g.id,raisedAt:g.raisedAt,admitted:[...g.admitted.keys()],boardedBeforeLaunch:[...g.aboard].filter(([a,t])=>g.raisedAt!=null&&t<=g.raisedAt&&!(g.failed.get(a)>=t&&g.failed.get(a)<=g.raisedAt)).map(([a])=>a),heightValidated:[...g.validated].filter(([a,t])=>g.raisedAt!=null&&g.aboard.get(a)<=g.raisedAt&&t>=g.raisedAt&&!(g.failed.get(a)>=g.aboard.get(a)&&g.failed.get(a)<=t)).map(([a])=>a)}));
 const allArrived=arrivals.length===agents.length,travel=arrivals.map(a=>a.travelMs),ordered=arrivals.map(a=>a.orderToArrivalMs);
 const allActorsSucceeded=results==null?null:agents.every(a=>results[a]?.ok===true),resultFailures=results==null?[]:agents.filter(a=>results[a]?.ok===false).map(agent=>({agent,reason:results[agent].why??null}));
 return{expected:agents.length,windowEndedAt:endedAt,arrivalCount:arrivals.length,allArrived,allActorsSucceeded,qualified:!allArrived?false:allActorsSucceeded,resultFailures,preparationMs:startedAt-controllerStartedAt,arrivals,holdouts:agents.filter(a=>!arrivals.some(r=>r.agent===a)),failures,liftTrips:lifts.filter(g=>g.raisedAt!=null).length,lifts,p50Ms:allArrived?percentile(travel,.5):null,p90Ms:allArrived?percentile(travel,.9):null,orderToArrivalP90Ms:allArrived?percentile(ordered,.9):null,arrivedSubsetP90Ms:percentile(travel,.9),note:'Full-roster percentiles require every requested arrival. Boarded-before-launch and personal height validation are separate positive observations; admission alone is never a ride.'};
}


// Positive receipt intervals expose queues without guessing time inside a native walk.
// A missing milestone stays null; subset distributions never become a full-fleet p90.
export function braxTrialStages({agents,startedAt,endedAt=null,eventsByAgent}){
 if(!Array.isArray(agents)||!agents.length||new Set(agents).size!==agents.length||!Number.isFinite(startedAt)||endedAt!=null&&(!Number.isFinite(endedAt)||endedAt<startedAt))throw Error('invalid Brax stage identity/clocks');
 const names=['departure','city_out','ancient_entry','south_queue','aboard','launch','height_validated','north_landing','cragged_entry','caverns_entry','graveyard'];
 const actors=agents.map(agent=>{
  const milestones={departure:startedAt},events=[...(eventsByAgent[agent]??[])].filter(e=>Number.isFinite(stamp(e.at))&&stamp(e.at)>=startedAt&&(endedAt==null||stamp(e.at)<=endedAt)).sort((a,b)=>stamp(a.at)-stamp(b.at));
  let batch=null;
  for(const e of events){
   const at=stamp(e.at),mark=name=>{if(milestones[name]==null)milestones[name]=at;};
   if(e.event==='queued-city-exit'&&e.from===2&&e.to===599&&e.reply?.arrived===true)mark('city_out');
   if(e.event==='queued-entry'&&e.to===579&&e.reply?.arrived===true)mark('ancient_entry');
   if(e.event==='south-queue-ready')mark('south_queue');
   if(e.event==='aboard'&&typeof e.batch==='string'&&batch==null){batch=e.batch;mark('aboard');}
   if(e.event==='lift-validated'&&e.batch===batch&&e.observed?.[3]===800&&e.observed?.[4]===510){
    const raised=stamp(e.raisedAt);if(Number.isFinite(raised)&&raised>=milestones.aboard&&raised<=at){milestones.launch??=raised;mark('height_validated');}
   }
   if(e.event==='landing'&&e.floor_client===8160)mark('north_landing');
   if(e.event==='north-egress'&&e.reply?.arrived===true)mark('cragged_entry');
   if(e.event==='queued-onward'&&e.to===826&&e.reply?.arrived===true)mark('caverns_entry');
   if(e.event==='objective'&&e.success===true&&e.room?.num===827&&e.hp?.value>0)mark('graveyard');
  }
  const intervals={};for(let i=1;i<names.length;i++){const from=names[i-1],to=names[i],a=milestones[from],b=milestones[to];intervals[from+'_to_'+to]=Number.isFinite(a)&&Number.isFinite(b)&&b>=a?b-a:null;}
  return{agent,milestonesMs:Object.fromEntries(names.map(n=>[n,Number.isFinite(milestones[n])?milestones[n]-startedAt:null])),intervals};
 });
 const intervals=Object.fromEntries(names.slice(1).map((to,i)=>{const key=names[i]+'_to_'+to,values=actors.map(a=>a.intervals[key]).filter(Number.isFinite);return[key,{observed:values.length,expected:agents.length,allObserved:values.length===agents.length,observedSubsetP50Ms:percentile(values,.5),observedSubsetP90Ms:percentile(values,.9),maxObservedMs:values.length?Math.max(...values):null}];}));
 return{actors,intervals,note:'Intervals are bounded by positive route receipts. They include planning, walking, queue and recovery time between milestones; they do not infer the cause of time inside a native operation. Percentiles explicitly describe only observed intervals.'};
}
