// Test-only transcription of g9.kod message order, not a game control interface.
// Source: Meridian59/kod/object/active/holder/room/monsroom/g9.kod
// ReturnPuzzleToInitialState, ResetLeverStates, SomethingChanged, Touched,
// PuzzleSolved, ActivateLevers, DeleteTimers. Running g9.bof SHA256:
// caac3436d26c3599442593d049e8aa4b1ffcd95c50fc0122493d356ad49a731c
export function liftServerModel(){
 const s={now:0,seq:0,timers:[],lever:[2,2,2,2,2],light:[true,true,true,true,true],stuck:[false,false,false,false,false],outer:[true,true,true,true],floors:{2:800,3:250,4:540,5:340,6:340,7:340,8:340,9:510},events:[]};
 const create=(method,delay)=>{const t={id:++s.seq,at:s.now+delay,method};s.timers.push(t);return t;};
 const drop=t=>{if(t)t.cancelled=true;};
 const touched=()=>{drop(s.reset);s.reset=create('reset',300000);};
 const solve=()=>{
  drop(s.reset);s.reset=null;drop(s.activate);s.activate=null;
  s.reset=create('reset',120000);s.stuck.fill(true);s.light.fill(false);s.outer.fill(false);
  Object.assign(s.floors,{2:800,3:800,4:510,5:200,6:200,7:200,8:200,9:540});
  s.events.push({at:s.now,kind:'solved'});
 };
 const changed=i=>{
  s.light[i]=!s.light[i];
  if(i===0){s.floors[2]=800;s.outer=s.outer.map(x=>!x);s.stuck=[s.stuck[0],...Array(4).fill(s.lever[0]===1)];for(let n=0;n<4;n++)s.floors[5+n]=s.outer[n]?340:200;}
  touched();if(s.light.every(Boolean)&&s.outer.every(Boolean))solve();
 };
 const flip=i=>{s.lever[i]=s.lever[i]===1?2:1;changed(i);};
 const reset=()=>{
  s.reset=null;for(let i=0;i<5;i++)if(s.lever[i]===2)flip(i);
  s.activate=create('activate',120000);s.light.fill(false);s.outer.fill(false);
  Object.assign(s.floors,{2:250,3:250,4:540,5:200,6:200,7:200,8:200,9:510});
  s.events.push({at:s.now,kind:'reset'});
 };
 const activate=()=>{s.activate=null;s.stuck=[false,true,true,true,true];s.events.push({at:s.now,kind:'activate'});};
 return {state:s,solve,advance(to){for(;;){const t=s.timers.filter(t=>!t.cancelled&&t.at<=to).sort((a,b)=>a.at-b.at||a.id-b.id)[0];if(!t)break;t.cancelled=true;s.now=t.at;(t.method==='reset'?reset:activate)();}s.now=to;},pull(i){if(s.stuck[i])return false;flip(i);return true;}};
}
