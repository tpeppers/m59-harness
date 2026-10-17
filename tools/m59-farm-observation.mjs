import{isActiveRecoveryDecision}from'./m59-survival-decision.mjs';
const normalize=v=>String(v??'').trim().toLowerCase().replace(/^an? /,'').replace(/\s+/g,' ');
const requestedName=(name,targets)=>targets.some(t=>normalize(name)===normalize(t)||normalize(name)===normalize(t)+'s');
const leaseActive=v=>v&&typeof v==='object'&&v.expires_in_ms>0;
export function farmObservationDetails(s,{targets=['narthyl worm','daemon skeleton'],nearbyWithin=8,vigorThreshold=70}={}){
 const a=s.autopilot_status??{},me=s.you,positionUsable=!!me&&me.predicted!==true&&[me.x,me.y].every(Number.isFinite),positionPrediction=me?.predicted===true?'predicted':me?.predicted===false?'reported-unpredicted':'unreported';
 const requestedTargets=(s.objects??[]).filter(o=>(o.flags&8)&&!(o.flags&4)&&requestedName(o.name,targets)).map(o=>({id:o.id,name:o.name,flags:o.flags,row:o.row,col:o.col,x:o.x,y:o.y,distance:me&&[me.x,me.y,o.x,o.y].every(Number.isFinite)?Math.hypot(o.x-me.x,o.y-me.y)/64:null}));
 const near=requestedTargets.filter(o=>o.distance!=null&&o.distance<=nearbyWithin),fullHealth=s.hp?.max>0&&s.hp.value>=s.hp.max,fullMana=Number.isFinite(s.mana?.max)&&s.mana.max>=0&&Number.isFinite(s.mana?.value)&&s.mana.value>=s.mana.max,highVigor=Number.isFinite(s.vigor?.value)&&s.vigor.value>=vigorThreshold;
 const activity=typeof(a.activity??a.current)==='string'?(a.activity??a.current):null;
 const looksIdle=typeof activity==='string'&&/idle|rest|holding|waiting|looking|finding/i.test(activity);
 const busy=!!(s.job?.busy||s.movement?.order||s.combat?.active||a.cast_rite?.active||a.recovering_from_death||a.recovery_travel||isActiveRecoveryDecision(a.survival_decisions?.current)||leaseActive(a.faculties?.work)||leaseActive(a.faculties?.movement));
 const candidate=s.in_game===true&&s.connected!==false&&s.combat_ready===true&&s.room?.num===827&&a.mode==='farm'&&positionUsable&&looksIdle&&!busy&&fullHealth&&fullMana&&highVigor&&near.length>0;
 const recent=(a.recent??[]).filter(e=>/fight|hunt|heal|rest|vigor|weapon|spare|prey|target|cast|arm/i.test(String(e.what??''))).slice(-12).map(e=>Object.fromEntries(['at','pass','what','why','reason','target','spell'].filter(k=>typeof e[k]==='string'||typeof e[k]==='number'||typeof e[k]==='boolean').map(k=>[k,typeof e[k]==='string'?e[k].slice(0,600):e[k]])));
 return{observationKind:'native-cached-state',stateAgeMs:s.as_of_ms??null,connectionRevision:s.connection_revision??null,position:me?Object.fromEntries(['id','x','y','row','col','at','predicted'].filter(k=>me[k]!==undefined).map(k=>[k,me[k]])):null,positionPrediction,combatReady:s.combat_ready??null,combatActive:s.combat?.active??null,castRite:a.cast_rite??null,huntDecision:a.hunt_priority??null,requestedTargets,recentCombatDecisions:recent,idleCandidate:{candidate,activity,fullHealth,fullMana,highVigor,vigorThreshold,nearbyWithin,nearbyRequestedTargets:near.length,busy,note:'A sampled candidate from cached state only: position prediction status is retained; visibility and distance do not prove line of sight, a legal attack path, or engagement eligibility. Use the recorded hunt/recovery/ladder decisions before calling it a combat stall.'}};
}


// A missing first sample or reconnect breaks the ceiling-confirmation streak;
// it must never crash measurement or carry old-session certainty forward.
export function observeFarmHealthCeiling(history,row){
 if(!row?.agent)return null;
 if(row.error||!Number.isFinite(row.hp?.max)||row.hp.max<=0){history.delete(row.agent);return null;}
 const identity=JSON.stringify([row.pid??null,row.connectionRevision??null]),previous=history.get(row.agent);
 const next={max:row.hp.max,identity,count:previous&&previous.max===row.hp.max&&previous.identity===identity?previous.count+1:1};
 history.set(row.agent,next);return next;
}
