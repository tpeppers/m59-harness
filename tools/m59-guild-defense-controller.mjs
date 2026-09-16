// Lab composition of existing keeper behavior; no new movement/damage authority.
import {installDoorObserver,applyCeilingDoors} from './m59-ceiling-doors.mjs';
import {resumeReplayJourney} from './m59-replay-journey.mjs';

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
