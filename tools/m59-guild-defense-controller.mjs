// Lab composition of existing keeper behavior; no new movement/damage authority.
import {installDoorObserver,applyCeilingDoors} from './m59-ceiling-doors.mjs';
import {resumeReplayJourney} from './m59-replay-journey.mjs';
import {guildSection,guildPassage} from './m59-guild-passage.mjs';

// A short, explicit lever objective owns this simulated body. Incoming attacks
// still cause native damage; only automatic retaliation is deferred. Restoring
// the exact prior eligibility policy prevents this from becoming a combat mute.
export async function withHallObjective(session,operation){
  const combat=session.combat,prior=Object.getOwnPropertyDescriptor(combat,'pvpEligibility');
  combat.pvpEligibility=()=>false;
  try{
    combat.issue({action:'stop'});
    return await operation();
  }finally{
    if(prior)Object.defineProperty(combat,'pvpEligibility',prior);
    else delete combat.pvpEligibility;
  }
}

export function observedHallSection(session){
  const body=session.client?.self;
  // ROOM can arrive before the room's player object. Unknown is not a position.
  if(session.world?.room?.num!==714||!Number.isFinite(body?.row)||!Number.isFinite(body?.col))return null;
  return guildSection(body.row,body.col);
}

export function defenseAssemblyPoint(index){
  if(!Number.isInteger(index)||index<0||index>=20)throw Error('assembly index must be 0..19');
  return {row:16-Math.floor(index/5),col:8+2*(index%5)};
}

export async function recoverGuildPassage(keeper,destination,{stopped=()=>false,onEvent=()=>{},
  maxAttempts=6,timeoutMs=90000,retryMs=1000,passage=guildPassage}={}){
  const until=Date.now()+timeoutMs,interrupted=()=>stopped()||Date.now()>=until;
  let error;
  for(let attempt=1;attempt<=maxAttempts&&!interrupted();attempt++){
    try{
      await passage(keeper,destination,interrupted);
      onEvent('passage_completed',{destination,attempt});
      return {arrived:true,attempts:attempt};
    }catch(e){
      error=e;
      const body=keeper.s.client?.self;
      onEvent('passage_retry',{destination,attempt,error:e.message,
        at:body?{row:body.row,col:body.col}:null,section:observedHallSection(keeper.s)});
      if(!interrupted()&&attempt<maxAttempts)
        await new Promise(resolve=>setTimeout(resolve,retryMs));
    }
  }
  if(stopped())throw Error('guild response stopped');
  throw Error('guild passage retry budget exhausted: '+(error?.message??'deadline'));
}

const attached=new WeakMap();
export function ensureReplayHallDoors(session) {
  const client=session.client,world=session.world;
  if(!client||!world?.map||attached.get(session)===client)return false;
  // Real keepers have separate processes. Give each lab client its own mutable
  // hall geometry so another actor's arrival replay cannot close its open door.
  const base=world.map,room=base.rooms[714];
  if(!room?.roo)throw Error('hall geometry missing');
  world.map={...base,rooms:{...base.rooms,714:{...room,roo:{...room.roo}}}};
  applyCeilingDoors(world.map,714,world.room?.num===714?client.room.sectorHeights??new Map():new Map());
  installDoorObserver(client,world.map,()=>world.room?.num);
  attached.set(session,client);return true;
}

export async function respondWithRecovery(keeper,destination,{alive,stopped,onEvent=()=>{},handled,continueStage}={}) {
  const terminal=()=>stopped()||!alive()||keeper.stopping;
  if(terminal())return {arrived:false,reason:'response stopped before dispatch'};
  let outcome=await resumeReplayJourney(keeper,destination,'guild defense response');
  onEvent('journey_result',{result:outcome});
  if(outcome?.arrived||terminal()||outcome?.refused)return outcome;
  // A paused route is still a job. Run the real pass loop, which drains survival
  // decisions and maintains watchdog/pass accounting, until arrival or retirement.
  const names=['pass','passFarm','passErrand','passPlaybook','passFollow'];
  const original=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(keeper,name)]));
  const pass=keeper.pass;
  let arrived=false;
  const finish=()=>{
    arrived=Number(keeper.s.world?.room?.num)===Number(destination);
    if(arrived||terminal()){keeper.stopping=true;return true;}
    return false;
  };
  keeper.pass=async function(){
    if(finish())return;
    await pass.call(this);
    onEvent('recovery_pass',{passes:this.passes,room:this.s.world?.room?.num,
      doing:this.doing,journey:this.suspendedJourney??null,holding:!!this.hold});
    finish();
  };
  keeper.passFarm=async function(ctx){await this.resumeSuspendedJourney(ctx);return handled;};
  // Survival and fight-back stages remain intact. This scenario has a fixed
  // response objective and prepared gear, with no farming, shopping or follow job.
  for(const name of ['passErrand','passPlaybook','passFollow'])keeper[name]=async()=>continueStage;
  onEvent('recovery_started',{room:keeper.s.world?.room?.num});
  try{await keeper.loop();}
  finally{
    for(const [name,descriptor]of original)if(descriptor)Object.defineProperty(keeper,name,descriptor);else delete keeper[name];
    if(arrived&&!stopped()&&alive())keeper.stopping=false;
  }
  return {arrived,reason:arrived?'arrived after recovery':'response stopped',initial:outcome};
}
