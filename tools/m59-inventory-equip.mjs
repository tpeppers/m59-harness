// Narrow, operator-click-only equip action. No sales, travel, or vault transfers.
import {randomUUID} from 'node:crypto';
import {readIntent} from './m59-inventory-intent.mjs';
const need=(ok,why)=>{if(!ok)throw Error(why);};
export function checkedEquip(plans,body,identity,{dir,now=Date.now()}={}) {
  need(body?.state==='equip'&&body.location==='pack'&&body.source==='operator'&&
    body.fleet===identity.fleet&&body.broker_pid===identity.broker_pid&&
    Number.isFinite(body.clicked_at)&&body.clicked_at<=now+1000&&now-body.clicked_at<=6000,'stale or invalid equip click');
  const p=plans.find(p=>p.agent===body.agent&&p.identity.character===body.character&&p.identity.player_id===body.player_id);
  need(p&&!p.paused&&Number.isFinite(p.at)&&now-p.at<=6000&&p.at<=now+1000,'character unavailable or possessed');
  need(Number.isInteger(p.room)&&p.room>0,'current room is unknown');
  const item=p.items.find(i=>i.id===body.item_id&&i.name===body.item_name);
  need(item&&!item.equipped&&item.actions?.includes('use'),'item is not equipable');
  const doc=readIntent(p.identity,{dir}),mark=doc.intents[item.id];
  need(doc.revision===body.revision&&mark?.name===item.name&&mark.state==='keep'&&mark.purpose==='equipment','equipment intention changed');
  return {plan:p,item};
}
export async function equipOnce(target,identity,{rpc,currentPlan,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const {plan:p,item}=target;
  const endpoint=/^([a-z0-9.-]+):(\d+)$/.exec(p.identity.server);need(endpoint,'unsupported game endpoint');
  const base={fleet:identity.fleet,broker_pid:identity.broker_pid,server_host:endpoint[1],server_port:Number(endpoint[2]),
    agents:[{agent:p.agent,character:p.identity.character}]};
  // The existing broker checks real roster identity, occupancy, controllers and
  // keeper survival authority. Never steal an active lease or bypass a refusal.
  const lease=await rpc('commander_lease',{...base,action:'acquire',owner:'C&C item equip click',lease_ms:20000});
  need(typeof lease.lease_token==='string'&&lease.lease_token.length>0,'character is busy or control is unavailable');
  const context={agent:p.agent,room:p.room,lease_token:lease.lease_token,server_host:base.server_host,server_port:base.server_port};
  let released=false;
  try {
    // Meridian refuses equipment changes while seated. Stand in place first.
    const stand=await rpc('context_intent',{...context,action:'stand',control_token:randomUUID()});need(stand.accepted,'stand was refused');
    await sleep(500);
    const latest=currentPlan();need(latest&&!latest.paused&&latest.identity.player_id===p.identity.player_id&&latest.room===p.room&&
      latest.revision===p.revision&&latest.items.some(i=>i.id===item.id&&i.name===item.name&&!i.equipped&&i.purpose==='equipment'),'character or item changed before equip');
    const command=await rpc('context_intent',{...context,action:'item_use',item:item.id,expected_item_name:item.name,control_token:randomUUID()});
    need(command.accepted,'equip was refused');
    for(let i=0;i<12;i++){
      await sleep(400);const observed=currentPlan();
      if(observed&&!observed.paused&&observed.identity.player_id===p.identity.player_id&&
        observed.items.some(x=>x.id===item.id&&x.name===item.name&&x.equipped))return {ok:true,equipped:true,item:item.name};
    }
    return {ok:true,equipped:false,item:item.name};
  } finally {
    try {await rpc('commander_lease',{...base,action:'release',lease_token:lease.lease_token});released=true;}catch{}
    // A failed release never triggers another acquisition. The short lease
    // expires back to the keeper; no long-lived command capability is retained.
    if(!released)process.stderr.write('Inventory equip lease release was not confirmed; bounded lease will expire.\n');
  }
}
