// Emergency evacuation v3: guarded refills, conservative charges, parallel trades.
// Codex, October 2026. Uses only ordinary player tools; no production code reload.
import {chargePossibilities} from './m59-rescue.mjs';
import {sipVerdict,REFILL_ROOMS} from './m59-chalice.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const isCup=o=>/^chalice of the rain$/i.test(o?.name??'');
const point=l=>({row:l.you.row,col:l.you.col});
const distance=(a,b)=>Math.max(Math.abs(a.row-b.row),Math.abs(a.col-b.col));
export const remainingFloor=possibilities=>possibilities.length?Math.min(...possibilities.map(p=>p.remaining)):0;
// Native UserGet rejects |delta row| + |delta col| > 7, not a four-square circle.
export const PICKUP_RANGE=7,REFILL_MOVEMENT_BUFFER=4;
export function refillSafety(l,trustedNames=new Set()){
  if(!REFILL_ROOMS.has(l.room?.num))return {ok:false,why:'room cannot refill chalices'};
  if(l.ids_stale||!Array.isArray(l.objects)||!Number.isFinite(l.you?.row)||!Number.isFinite(l.you?.col))return {ok:false,why:'room/player projection unconfirmed'};
  for(const o of l.objects){
    if(!o.is_player||o.id===l.you.object_id)continue;
    // Exact selected roster names survive ID renumbering. Enemy relation always wins.
    if(o.relation!=='enemy'&&trustedNames.has(String(o.name??'').toLowerCase()))continue;
    if(!Number.isFinite(o.row)||!Number.isFinite(o.col))return {ok:false,why:'untrusted player position unknown',player:o.name};
    const distance=Math.abs(o.row-l.you.row)+Math.abs(o.col-l.you.col);
    if(distance<=PICKUP_RANGE+REFILL_MOVEMENT_BUFFER)return {ok:false,why:'untrusted player inside pickup/movement buffer',player:o.name,distance};
  }
  return {ok:true};
}

// Reserve one charge AND the owner's escape before allocating borrower rides.
export function allocateDesks(holders,borrowers,positions={}){
  const lanes=holders.map(h=>({...h,riders:[],slots:h.renewable?borrowers.length:Math.max(0,remainingFloor(h.possibilities)-2)}));
  const unserved=[];
  for(const a of borrowers){
    const cost=lane=>positions[lane.agent]&&positions[a]?distance(positions[lane.agent],positions[a]):0;
    const choices=lanes.filter(l=>l.slots>l.riders.length).sort((a,b)=>a.riders.length-b.riders.length||cost(a)-cost(b));
    const lane=choices[0];if(lane)lane.riders.push(a);else unserved.push(a);
  }
  return {lanes,unserved};
}

function exitMask(l){
  const points=(l.exits??[]).flatMap(e=>[e.stand_on,...(e.trigger_targets??[]).map(t=>t.stand_on),...(e.alternates??[]).map(t=>t.stand_on??t)]).filter(p=>Number.isFinite(p?.row)&&Number.isFinite(p?.col));
  const {rows,cols}=l.room?.size??{};
  if(rows>0&&cols>0){for(let row=1;row<=rows;row++)points.push({row,col:1},{row,col:cols});for(let col=1;col<=cols;col++)points.push({row:1,col},{row:rows,col});}
  return points;
}

export async function panicChalice({call,agents,destination=2001,gatherMs=30000,budgetMs=120000,log=console.log,save=()=>{},now=Date.now,sleep=wait}){
  if(!agents?.length||new Set(agents).size!==agents.length)throw Error('Select unique agents');
  if(!Number.isSafeInteger(destination)||destination<=1||!Number.isFinite(gatherMs)||gatherMs<0||gatherMs>30000||!Number.isFinite(budgetMs)||budgetMs<60000||budgetMs>120000)throw Error('Invalid panic budget/destination');
  const started=now(),deadline=started+budgetMs,startCutoff=deadline-35000;
  const receipt={version:3,started_at:new Date(started).toISOString(),destination,budget_ms:budgetMs,guarded_refills:true,pickup_range:PICKUP_RANGE,refill_movement_buffer:REFILL_MOVEMENT_BUFFER,reserve_charges:1,agents:{},cups:[],events:[]};
  const landings=new Map(),failures=[];
  const event=(kind,data={})=>{const e={at:now(),kind,...data};receipt.events.push(e);log(JSON.stringify(e));save(receipt);};
  const alert=(a,why)=>{const failure={agent:a,why};failures.push(failure);receipt.agents[a]??={};receipt.agents[a].failure=why;event('ALERT',failure);};
  const guard=async(a,fn)=>{try{return await fn();}catch(e){alert(a,e.message);return null;}};
  const ask=async(name,args,ms=6000)=>{
    if(now()>=deadline)throw Error('Panic deadline reached; MANUAL HELP');
    // A timed-out mutation is UNKNOWN, never retried. Hanging up an RPC is not
    // cancellation of a game action; that cup is frozen and requires review.
    return call(name,args,Math.min(ms,Math.max(1,deadline-now())));
  };
  const pack=async a=>{const p=await ask('inventory',{agent:a});if(!Array.isArray(p.items))throw Error(a+': inventory unreadable');return p;};
  const cup=async a=>{const p=await pack(a),cups=p.items.filter(isCup);if(cups.length>1)throw Error(a+': multiple cups; merge risk');return {item:cups[0],ids_as_of:p.ids_as_of};};
  const look=async a=>{const l=await ask('look',{agent:a});const r=receipt.agents[a];
    if(!l.room?.num||!l.you||!Number.isFinite(l.hp?.value)||!(l.hp.max>0))throw Error(a+': body unreadable');
    if(l.room.num===1||l.hp.value<=0||r&&l.hp.max<r.initial_max)throw Error(a+': death/max-health loss; MANUAL HELP');
    return l;};
  const source=async(a,room)=>{const l=await look(a);if(l.room.num!==room)throw Error(a+': no longer in source room '+room);return l;};
  const inspect=async(a,state=null)=>{
    const held=await cup(a);if(!held.item)throw Error(a+': cup missing');
    const d=await ask('look_at',{agent:a,target:held.item.id});
    if(d.id!==held.item.id||d.ids_stale)throw Error(a+': charge description identity unconfirmed');
    let possibilities=chargePossibilities(d.description??'');
    if(state){
      // A new description may narrow our ledger, never resurrect spent charges.
      possibilities=possibilities.filter(p=>state.possibilities.some(q=>p.capacity===q.capacity&&p.remaining===q.remaining));
    }
    if(!possibilities.length)throw Error(a+': unknown/contradictory charge condition; sip refused');
    if(state){state.possibilities=possibilities;state.holder=a;state.item_id=held.item.id;}
    return state??{owner:a,holder:a,item_id:held.item.id,possibilities};
  };
  let trustedNamesPromise;
  const trustedNames=()=>trustedNamesPromise??=(async()=>{
    try{const roster=await ask('fleet',{});return new Set((roster.fleet??[]).filter(r=>agents.includes(r.agent)&&r.in_roster!==false).map(r=>String(r.character??'').toLowerCase()).filter(Boolean));}
    catch{return new Set();} // No roster proof: treat other players as untrusted.
  })();
  // Serialize public floor exposure within a room, while independent trades continue.
  const refillQueues=new Map(),blockedRefillRooms=new Set();
  const refresh=async(a,state,room)=>{
    const previous=refillQueues.get(room)??Promise.resolve();let unlock;
    const lock=new Promise(resolve=>{unlock=resolve;});refillQueues.set(room,lock);
    await previous;
    try{
      if(state.command_uncertain||state.floor_pending)throw Error(a+': unresolved prior cup command/refill');
      if(blockedRefillRooms.has(room)){event('refill_skipped',{agent:a,why:'another refill in this room has unresolved recovery'});return false;}
      if(!REFILL_ROOMS.has(room)){event('refill_skipped',{agent:a,why:'room cannot refill chalices'});return false;}
      if(now()+12000>startCutoff){event('refill_skipped',{agent:a,why:'insufficient refill/escape budget'});return false;}
      const [held,names]=await Promise.all([cup(a),trustedNames()]);
      if(held.item?.id!==state.item_id)throw Error(a+': cup changed before refill');
      // Last read before the drop: never rely on the gathering snapshot or fleet cache.
      const l=await source(a,room),safe=refillSafety(l,names);
      if(!safe.ok){event('refill_skipped',{agent:a,...safe});return false;}
      state.floor_pending={agent:a,item_id:held.item.id,room,position:point(l),at:now()};save(receipt);
      try{
        await ask('act',{agent:a,verb:'drop',target:held.item.id},8000);
        // No reads, charge checks, sleeps or other work between drop and reclaim.
        await ask('act',{agent:a,verb:'get',target:held.item.id},8000);
        const recovered=await cup(a);
        if(recovered.item?.id!==held.item.id)throw Error('exact cup recovery unconfirmed');
        const full=await inspect(a);
        if(!full.possibilities.every(p=>p.remaining===p.capacity))throw Error('recovered cup is not confirmed full');
        const capacities=new Set(state.possibilities.map(p=>p.capacity));
        const possibilities=full.possibilities.filter(p=>!capacities.size||capacities.has(p.capacity));
        if(!possibilities.length)throw Error('refill capacity contradicts cup ledger');
        Object.assign(state,{holder:a,item_id:full.item_id,possibilities});delete state.floor_pending;
        event('refilled',{agent:a,cup:state.item_id,room,minimum_charges:remainingFloor(possibilities)});return true;
      }catch(e){
        blockedRefillRooms.add(room);
        state.command_uncertain=true;state.uncertain_agents=[a];
        throw Error(a+': refill recovery/command unconfirmed; no movement or retry; MANUAL HELP: '+e.message);
      }
    }finally{unlock();if(refillQueues.get(room)===lock)refillQueues.delete(room);}
  };
  const park=async a=>{await ask('autopilot',{agent:a,action:'start',mode:'idle',assigned_room:destination,confine_rooms:[destination],roam:false});};
  const land=async(a,room)=>{
    const until=Math.min(deadline,receipt.agents[a].sip_at+45000);
    for(;;){const l=await look(a);
      if(l.room.num===destination){await park(a);Object.assign(receipt.agents[a],{arrived:true,pending:false,hp:l.hp});event('arrived',{agent:a,hp:l.hp});return;}
      if(l.room.num!==room)throw Error(a+': unexpected landing '+l.room.num+'; MANUAL HELP');
      if(now()>=until)throw Error(a+': landing not confirmed by deadline; MANUAL HELP');
      await sleep(Math.min(1000,until-now()));
    }
  };
  const watch=(a,room)=>{if(!landings.has(a))landings.set(a,guard(a,()=>land(a,room)));};
  const sip=async(a,state,room,{deferWatch=false}={})=>{
    if(state.command_uncertain)throw Error(a+': earlier command may still be in flight; further cup mutations refused');
    if(receipt.agents[a].sip_attempted)throw Error(a+': sip already attempted; never repeat');
    if(now()>startCutoff)throw Error(a+': too late to start another rescue; MANUAL HELP');
    await source(a,room);await ask('rest',{agent:a,stand:true});
    await inspect(a,state);
    if(remainingFloor(state.possibilities)<2&&!await refresh(a,state,room))throw Error(a+': final/uncertain last charge protected; guarded refill unavailable; MANUAL HELP');
    const held=await cup(a);if(held.item?.id!==state.item_id)throw Error(a+': cup changed before sip');
    if(now()>startCutoff)throw Error(a+': charge checks exhausted rescue-start budget; MANUAL HELP');
    Object.assign(receipt.agents[a],{sip_at:now(),sip_attempted:true,pending:true});
    // Persist BEFORE send: a transport failure cannot make a retry safe.
    save(receipt);
    let reply;
    try{reply=await ask('act',{agent:a,verb:'use',target:state.item_id},10000);}
    catch(e){state.possibilities=state.possibilities.map(p=>({...p,remaining:p.remaining-1}));state.command_uncertain=true;state.uncertain_agents=[a,state.owner];alert(a,'Sip reply lost: command may still be in flight; keep cup with borrower, no retry');event('sip_unknown',{agent:a,why:e.message});if(!deferWatch)watch(a,room);return;}
    const verdict=sipVerdict(reply.messages??[]);event('sip',{agent:a,verdict,messages:reply.messages??[]});
    if(verdict==='refused_pvp'){receipt.agents[a].pending=false;throw Error(a+': PvP teleport lockout; MANUAL HELP');}
    state.possibilities=state.possibilities.map(p=>({...p,remaining:p.remaining-1}));
    if((reply.messages??[]).some(m=>/crumbles to dust/i.test(String(m))))throw Error(a+': CUP DESTROYED contrary to reserved condition; MANUAL HELP');
    if(!deferWatch)watch(a,room);
  };
  const transfer=async(from,to,state,room)=>{
    if(state.command_uncertain)throw Error('Earlier cup command may still be in flight; no new trade');
    const [fl,tl,held,receiving]=await Promise.all([source(from,room),source(to,room),cup(from),cup(to)]);
    if(!held.item||held.item.id!==state.item_id||receiving.item)throw Error('Unsafe transfer '+from+' -> '+to+': changed/absent cup or merge risk');
    if(distance(point(fl),point(tl))>2)throw Error('Transfer outside handoff range');
    if(now()+20000>deadline)throw Error('Insufficient time for bounded trade');
    // Peer-to-peer exchange: cup never becomes a public floor object. Supply
    // verifies both inventories and uses a short survival-preemptible hold.
    let reply,error;
    try{reply=await ask('supply',{from,to,what:[held.item.id],ids_as_of:held.ids_as_of,who_travels:'neither',stationary:true},22000);}
    catch(e){error=e.message;}
    const [afterFrom,afterTo]=await Promise.all([cup(from),cup(to)]);
    if(!afterFrom.item&&afterTo.item){state.holder=to;state.item_id=afterTo.item.id;}
    if(error){state.command_uncertain=true;state.uncertain_agents=[from,to];throw Error('Trade reply lost: '+from+' -> '+to+' may still be in flight; no further cup mutations');}
    if(!afterFrom.item&&afterTo.item){event('traded',{from,to,cup:state.item_id,reply_ok:reply?.supplied??null});return;}
    throw Error('Trade unconfirmed '+from+' -> '+to+(error?': '+error:''));
  };
  const move=async(a,target,room,until)=>{
    const l=await source(a,room);if(distance(point(l),target)<=1)return;
    if(now()>=until)throw Error('Local move budget expired');
    let settled=false,error;
    const moving=ask('walk_to',{agent:a,...target,max_steps:30,avoid_squares:exitMask(l)},Math.min(35000,deadline-now())).catch(e=>{error=e;}).finally(()=>{settled=true;});
    await Promise.race([moving,sleep(Math.max(0,until-now()))]);
    if(!settled){await ask('cancel_movement',{agent:a,why:'panic rendezvous deadline'},6000);await moving;}
    if(error)throw error;
    await source(a,room);
  };
  const rendezvous=async(members,desk,room)=>{
    const anchor=point(await source(desk,room)),until=started+gatherMs;
    const together=async()=>{const ls=await Promise.all(members.map(a=>source(a,room)));return ls.every(l=>distance(point(l),anchor)<=2);};
    if(await together())return;
    await Promise.all(members.map(a=>move(a,anchor,room,until).catch(e=>event('gather_refused',{agent:a,why:e.message}))));
    if(await together())return;
    await sleep(Math.max(0,until-now()));event('blink_fallback',{room,after_ms:now()-started});
    await Promise.all(members.map(a=>guard(a,async()=>{
      const until=Math.min(started+65000,startCutoff-15000);
      const spots=await ask('safe_spots',{agent:a,reachable_only:true,limit:4096});
      const safe=(spots.spots??[]).filter(s=>s.can_reach_you===0&&!s.rim).sort((a,b)=>a.distance-b.distance)[0];
      if(!safe)throw Error(a+': no proved safe spot for Blink');
      await move(a,{row:safe.row,col:safe.col},room,until);
      const l=await source(a,room);if(distance(point(l),safe)>0)throw Error(a+': safe spot arrival not proved');
      await ask('rest',{agent:a,stand:true});let relocated=false;
      for(let n=0;n<2&&now()<until&&!relocated;n++){
        const r=await ask('cast',{agent:a,spell:'blink'},12000);relocated=!!r.keeper_said?.relocated;
      }
      if(!relocated)throw Error(a+': Blink did not relocate before fallback deadline');
      await source(a,room);
    })));
  };

  // No game mutation occurs before each selected body and its carried cup is read.
  const initial=await Promise.all(agents.map(async a=>{
    const l=await look(a);receipt.agents[a]={source:l.room.num,initial_max:l.hp.max,initial_hp:l.hp.value};
    return {agent:a,l};
  }));
  const groups=new Map();for(const {agent,l} of initial){
    if(l.room.num===destination){await guard(agent,async()=>{await park(agent);receipt.agents[agent].arrived=true;});continue;}
    const group=groups.get(l.room.num)??[];group.push(agent);groups.set(l.room.num,group);
  }
  await Promise.all([...groups].map(async([room,members])=>{
    try{
      const readings=await Promise.all(members.map(async a=>{
        try{const held=await cup(a);if(!held.item)return {agent:a};
          const state=await inspect(a);receipt.cups.push(state);return {agent:a,state};
        }catch(e){alert(a,e.message);return {agent:a,blocked:true};}
      }));
      const holders=readings.filter(r=>r.state).map(r=>({agent:r.agent,...r.state,renewable:REFILL_ROOMS.has(room)}));
      const borrowers=readings.filter(r=>!r.state&&!r.blocked).map(r=>r.agent);
      const positions=Object.fromEntries(initial.map(r=>[r.agent,point(r.l)]));
      const {lanes,unserved}=allocateDesks(holders,borrowers,positions);
      for(const a of unserved)alert(a,'Insufficient safe charges: preserve final charge and owner escape; MANUAL HELP');
      // Keep receipt and lanes on the same mutable charge ledger.
      for(const lane of lanes){const i=receipt.cups.findIndex(c=>c.owner===lane.owner);receipt.cups[i]=lane;}
      event('plan',{room,desks:lanes.filter(l=>l.riders.length).map(l=>({agent:l.agent,riders:l.riders})),unserved});
      const independent=lanes.filter(l=>!l.riders.length).map(l=>guard(l.agent,()=>sip(l.agent,l,room)));
      const serving=lanes.filter(l=>l.riders.length),needMeet=serving.flatMap(l=>[l.agent,...l.riders]);
      if(needMeet.length)await rendezvous(needMeet,serving[0].agent,room);
      await Promise.all(serving.map(l=>guard(l.agent,async()=>{
        if(!receipt.agents[l.agent].failure){
          for(const a of l.riders){
            if(receipt.agents[a].failure)continue;
            if(now()+30000>startCutoff){alert(a,'Too late to safely start another borrower exchange; MANUAL HELP');continue;}
            await guard(a,async()=>{
              // Preserve a final charge AND the desk's escape before each loan.
              await inspect(l.agent,l);
              if(remainingFloor(l.possibilities)<3&&!await refresh(l.agent,l,room))throw Error(a+': no safe refill for another loan; owner escape/final charge reserved');
              await transfer(l.agent,a,l,room);
              try{await sip(a,l,room,{deferWatch:true});}
              finally{
                try{await transfer(a,l.agent,l,room);}
                finally{if(receipt.agents[a].pending)watch(a,room);}
              }
            });
            if(l.holder!==l.agent)break; // Cup stays with its last proved custodian.
          }
        }
        if(l.holder===l.agent)await sip(l.agent,l,room);
        else throw Error(l.agent+': shared cup not returned; retained by '+l.holder+'; MANUAL HELP');
      })));
      await Promise.all(independent);
    }catch(e){for(const a of members.filter(a=>!receipt.agents[a].arrived&&!receipt.agents[a].pending))alert(a,e.message);}
  }));
  // Sip timers overlap desk work; no sleeping through another character's delay.
  await Promise.all([...landings.values()]);
  receipt.ok=agents.every(a=>receipt.agents[a].arrived);receipt.failures=failures;
  receipt.manual_help=agents.filter(a=>!receipt.agents[a].arrived);
  receipt.finished_at=new Date(now()).toISOString();receipt.elapsed_ms=now()-started;
  const sips=Object.values(receipt.agents).filter(a=>a.sip_attempted).map(a=>a.sip_at);
  receipt.sip_spread_ms=sips.length?Math.max(...sips)-Math.min(...sips):0;
  save(receipt);return receipt;
}
