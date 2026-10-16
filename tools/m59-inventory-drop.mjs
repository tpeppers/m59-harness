// One explicit operator drop, never a sale/intent or an automatic retry.
import {randomUUID} from 'node:crypto';
import {readIntent} from './m59-inventory-intent.mjs';
import {dropSpec} from './m59-parse.mjs';
const need=(ok,message)=>{if(!ok)throw Error(message);};
const fresh=(at,now)=>Number.isSafeInteger(at)&&at<=now+1000&&now-at<=6000;
const positive=n=>Number.isSafeInteger(n)&&n>0&&n<=0x7fffffff;
export function checkedDrop(plans,body,identity,{dir,now=Date.now()}={}) {
  need(body?.state==='drop'&&body.location==='pack'&&body.source==='operator'&&
    body.fleet===identity.fleet&&body.broker_pid===identity.broker_pid&&fresh(body.clicked_at,now),'stale or invalid drop confirmation');
  need(positive(body.amount)&&positive(body.expected_amount)&&body.amount<=body.expected_amount,'invalid drop quantity');
  const p=plans.find(p=>p.agent===body.agent&&p.identity.character===body.character&&p.identity.player_id===body.player_id);
  need(p&&!p.paused&&fresh(p.at,now)&&Number.isSafeInteger(p.room)&&p.room>0,'character unavailable or possessed');
  const item=p.items.find(i=>i.id===body.item_id&&i.name===body.item_name);
  need(item&&item.amount===body.expected_amount,'item or stack changed');
  const doc=readIntent(p.identity,{dir});
  need(Number.isSafeInteger(body.revision)&&doc.revision===body.revision&&p.revision===body.revision,'inventory decisions changed');
  return {plan:p,item,amount:body.amount,clicked_at:body.clicked_at};
}
export async function dropOnce(target,identity,{rpc,currentPlan,now=Date.now}) {
  const {plan:p,item,amount}=target;
  const endpoint=/^([a-z0-9.-]+):(\d+)$/.exec(p.identity.server);need(endpoint,'unsupported game endpoint');
  const base={fleet:identity.fleet,broker_pid:identity.broker_pid,server_host:endpoint[1],server_port:Number(endpoint[2]),
    agents:[{agent:p.agent,character:p.identity.character}]};
  need(fresh(target.clicked_at,now()),'drop confirmation expired');
  const lease=await rpc('commander_lease',{...base,action:'acquire',owner:'C&C confirmed item drop',lease_ms:15000});
  need(typeof lease.lease_token==='string'&&lease.lease_token.length>0,'character busy or control unavailable');
  try {
    const latest=currentPlan();
    need(fresh(target.clicked_at,now())&&latest&&!latest.paused&&fresh(latest.at,now())&&latest.room===p.room&&
      latest.identity.player_id===p.identity.player_id&&latest.identity.character===p.identity.character&&latest.revision===p.revision&&
      latest.items.some(i=>i.id===item.id&&i.name===item.name&&i.amount===item.amount),'character or stack changed before drop');
    // The broker and keeper both recheck exact stack size at the paced packet.
    // An unknown response MUST NOT be retried: the server may already have dropped it.
    try {
      const result=await rpc('inventory_drop',{agent:p.agent,room:p.room,player_id:p.identity.player_id,
        fleet:identity.fleet,broker_pid:identity.broker_pid,character:p.identity.character,
        item:item.id,expected_item_name:item.name,expected_amount:item.amount,amount,
        deadline_at:target.clicked_at+6000,control_token:randomUUID(),lease_token:lease.lease_token,
        server_host:base.server_host,server_port:base.server_port});
      return {ok:true,dropped:result?.requested===true&&result?.confirmed===true,requested:result?.requested===true,item:item.name,amount};
    }catch {return {ok:true,dropped:false,requested:null,item:item.name,amount};}
  }finally {
    try{await rpc('commander_lease',{...base,action:'release',lease_token:lease.lease_token});}
    catch{process.stderr.write('Drop lease release unconfirmed; the bounded lease will expire.\n');}
  }
}

// Shared by direct sessions and the last keeper packet boundary. Raw Meridian
// objects distinguish non-stacks (amount 0) from number-tagged stacks of ONE.
export function exactDrop(c,args,{now=Date.now(),prior=null}={}) {
  need(Number.isSafeInteger(args.deadline_at)&&args.deadline_at>=now&&args.deadline_at<=now+7000,'drop confirmation expired');
  need(positive(args.item)&&args.item<=0x0fffffff&&positive(args.player_id)&&c.selfId===args.player_id,'drop player/item identity changed');
  need(positive(args.amount)&&positive(args.expected_amount)&&args.amount<=args.expected_amount,'invalid drop quantity');
  const item=c.inventory?.find(i=>i.id===args.item),name=item?c.rsc?.get(item.nameRsc):null;
  need(item&&name===args.expected_item_name&&typeof name==='string'&&name.length>0,'exact carried item changed');
  const count=item.amount>0?item.amount:1;
  need(count===args.expected_amount,'stack quantity changed');
  need(!prior||(prior.nameRsc===item.nameRsc&&prior.iconRsc===item.iconRsc&&prior.tag===item.tag&&prior.translation===item.translation),'item identity changed');
  const wire=dropSpec(item,args.amount);
  need(typeof wire==='object'||args.amount===1,'non-stacked item quantity must be one');
  return {wire,identity:{nameRsc:item.nameRsc,iconRsc:item.iconRsc,tag:item.tag,translation:item.translation}};
}
const consumed=new WeakMap();
export async function executeExactDrop(session,args,{authority,now=Date.now,wait}={}) {
  need(!session.job||session.job.done,'character has an active order');
  const c=authority(),initial=exactDrop(c,args,{now:now()});
  need(typeof args.control_token==='string'&&/^[A-Za-z0-9._:-]{8,160}$/.test(args.control_token),'drop confirmation token required');
  let receipts=consumed.get(session);if(!receipts){receipts=new Map();consumed.set(session,receipts);}
  for(const [token,at] of receipts)if(now()-at>15000)receipts.delete(token);
  need(!receipts.has(args.control_token)&&receipts.size<256,'drop confirmation already consumed');
  receipts.set(args.control_token,now());let sent=false;
  const before=c.evSeq;
  await session.pacer.submit('drop',()=>{
    need(!sent,'drop packet already sent');
    const live=authority();need(live===c&&(!session.job||session.job.done),'character control changed before drop');
    const current=exactDrop(live,args,{now:now(),prior:initial.identity});
    sent=true;
    return live.drop([current.wire]);
  });
  // Wait only for pushed observations. No inventory/equipment request is sent.
  try {await (wait?wait(c,before):c.waitFor({since:before,kinds:['inventory','message'],timeoutMs:2000}));}catch{}
  const current=c.inventory?.find(i=>i.id===args.item),remaining=args.expected_amount-args.amount;
  let stillBound=false;try{stillBound=authority()===c&&c.selfId===args.player_id;}catch{}
  const confirmed=stillBound&&(remaining===0?!current:!!current&&c.rsc?.get(current.nameRsc)===args.expected_item_name&&current.amount===remaining);
  return {requested:true,confirmed,item:args.item,amount:args.amount};
}
