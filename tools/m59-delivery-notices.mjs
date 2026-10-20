// Structured broker-to-keeper pickup notices. These never execute speech or move a body.
import{mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,unlinkSync,existsSync}from'node:fs';
import{join}from'node:path';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';
const defaultDirectory=fileURLToPath(new URL('../substrate/delivery-notices/',import.meta.url));
const integer=x=>Number.isSafeInteger(x)&&x>0;
export function checkedDeliveryNotice(n,{now=Date.now()}={}){
 if(!n||typeof n.id!=='string'||!/^[a-zA-Z0-9._:-]{8,100}$/.test(n.id)||typeof n.recipient!=='string'||!n.recipient||n.recipient.length>100||typeof n.from!=='string'||!n.from||typeof n.item!=='string'||!n.item||n.item.length>100||!integer(n.quantity)||!integer(n.ground_id)||!integer(n.room)||!integer(n.row)||!integer(n.col)||!Number.isSafeInteger(n.createdAt)||n.createdAt>now+1000||now-n.createdAt>3600000||!Number.isSafeInteger(n.expiresAt)||n.expiresAt<=now||n.expiresAt>n.createdAt+3600000)throw Error('invalid or expired delivery notice');
 return{id:n.id,from:n.from,recipient:n.recipient,item:n.item,quantity:n.quantity,ground_id:n.ground_id,room:n.room,row:n.row,col:n.col,createdAt:n.createdAt,expiresAt:n.expiresAt,pickupRequired:false,status:n.status==='ignored'?'ignored':'available'};
}
export function receiveDeliveryNotice(session,notice,{now=Date.now()}={}){
 const n=checkedDeliveryNotice(notice,{now}),prior=(session.deliveryNotices??[]).filter(x=>x.expiresAt>now&&x.id!==n.id);session.deliveryNotices=[...prior,n].slice(-32);return{notified:true,id:n.id,pickupRequired:false};
}
export function deliveryNoticesOf(session,{now=Date.now()}={}){return(session.deliveryNotices??[]).filter(x=>x.expiresAt>now).slice(-32);}
export function createDeliveryNoticeTool({scope,lookup,ground,notify,directory=defaultDirectory,now=Date.now}={}){
 const verifiedGround=Symbol('one verified cache scene');
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const folder=agent=>join(directory,hash(String(scope())+'\0'+agent));
 const read=(agent,id)=>{try{return checkedDeliveryNotice(JSON.parse(readFileSync(join(folder(agent),hash(id)+'.json'),'utf8')),{now:now()});}catch{return null;}};
 const write=n=>{const dir=folder(n.recipient);mkdirSync(dir,{recursive:true});const files=readdirSync(dir).filter(f=>/^[0-9a-f]{64}\.json$/.test(f));let kept=0;for(const f of files){try{const old=JSON.parse(readFileSync(join(dir,f),'utf8'));if(old.recipient===n.recipient&&typeof old.id==='string'&&Number.isFinite(old.expiresAt)&&old.expiresAt<=now()){unlinkSync(join(dir,f));continue;}}catch{}kept++;}const file=join(dir,hash(n.id)+'.json');if(kept>=256&&!existsSync(file))throw Error('delivery notice queue full');const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(n));renameSync(tmp,file);};
 const tool={name:'delivery_notice',description:'Publish a verified ground-supply pickup notice through this broker, list available notices or ignore one. Notices are optional facts, never movement orders.',schema:{type:'object',properties:{action:{type:'string',enum:['publish','publish_many','list','ignore']},agent:{type:'string'},from:{type:'string'},recipients:{type:'array',maxItems:25,items:{type:'string'}},id:{type:'string'},item:{type:'string'},quantity:{type:'integer'},ground_id:{type:'integer'},room:{type:'integer'},row:{type:'integer'},col:{type:'integer'}},required:['action','agent']},run:async a=>{
  lookup(a.agent);const requestScope=String(scope());
  if(a.action==='publish_many'){
   if(!Array.isArray(a.recipients)||a.recipients.length>25)throw Error('bounded delivery recipients required');const recipients=[...new Set(a.recipients)];lookup(a.from);for(const agent of recipients)lookup(agent);
   const scene=await ground(a.from);if(String(scope())!==requestScope)throw Error('delivery fleet endpoint changed');
   const receipts=await Promise.all(recipients.map(async agent=>{try{return{agent,...await tool.run({...a,action:'publish',agent,[verifiedGround]:{scene,scope:requestScope}})};}catch(e){return{agent,stored:false,error:e.message};}}));return{receipts,pickupRequired:false};
  }
  if(a.action==='list'){let files=[];try{files=readdirSync(folder(a.agent)).filter(f=>/^[0-9a-f]{64}\.json$/.test(f));}catch{}const notices=files.flatMap(f=>{try{const n=checkedDeliveryNotice(JSON.parse(readFileSync(join(folder(a.agent),f),'utf8')),{now:now()});return n.status==='available'?[n]:[];}catch{return[];}}).sort((x,y)=>y.createdAt-x.createdAt).slice(0,32);return{notices,pickupRequired:false};}
  if(a.action==='ignore'){const n=read(a.agent,a.id);if(!n)return{ignored:false};n.status='ignored';write(n);try{await notify(a.agent,n);}catch{}return{ignored:true,id:n.id};}
  if(a.action!=='publish')throw Error('invalid delivery notice action');lookup(a.from);
  const n=checkedDeliveryNotice({...a,recipient:a.agent,createdAt:now(),expiresAt:now()+1800000},{now:now()});const prior=read(a.agent,n.id);
  if(prior){if(['from','item','quantity','ground_id','room','row','col'].some(k=>prior[k]!==n[k]))throw Error('delivery notice id already names different cargo');return{stored:true,id:prior.id,duplicate:true,pickupRequired:false};}
  const seen=a[verifiedGround]?.scope===requestScope?a[verifiedGround].scene:await ground(a.from);if(seen.answered!==true||seen.room!==n.room||!seen.objects?.some(o=>o.id===n.ground_id&&o.name===n.item&&(o.flags&16)&&o.row===n.row&&o.col===n.col&&(o.amount>0?o.amount:1)>=n.quantity))throw Error('delivery ground item no longer verified');
  if(String(scope())!==requestScope)throw Error('delivery fleet endpoint changed');
  const raced=read(a.agent,n.id);if(raced){if(['from','item','quantity','ground_id','room','row','col'].some(k=>raced[k]!==n[k]))throw Error('delivery notice id already names different cargo');return{stored:true,id:raced.id,duplicate:true,pickupRequired:false};}
  write(n);let delivered=false;try{delivered=(await notify(a.agent,n))?.notified===true;}catch{}return{stored:true,notified:delivered,id:n.id,pickupRequired:false};
 }};return tool;
}
