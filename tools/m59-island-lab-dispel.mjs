// Permitted artificial Dispel for the isolated shadow server only.
// Timer deletion needs administrator mode, not the maintenance socket.
import {M59Client} from './m59-client.mjs';
import {dm,sendMsg,rejections} from './m59-dm.mjs';
import {resolveRoom} from './m59-scene.mjs';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
class DispelAdmin extends M59Client{
  reqGame(){this.send(5);}
  onMessage(payload){
    if(payload[0]===26&&this.state!=='game'){this.state='admin';this.buf=Buffer.alloc(0);return;}
    super.onMessage(payload);
  }
  onData(chunk){
    if(this.state==='admin')this.adminText=(this.adminText??'')+chunk.toString('latin1');
    else super.onData(chunk);
  }
  async command(text){
    if(this.state!=='admin')throw Error('dispel_admin_disconnected');
    this.adminText='';this.sock.write(text+'\rshow status\r');
    const deadline=Date.now()+10000;
    while(!/System Status[\s\S]*Interpreted/.test(this.adminText??'')){
      if(Date.now()>deadline||this.state!=='admin')throw Error('dispel_admin_reply_unconfirmed');
      await pause(20);
    }
    const reply=this.adminText;
    if(rejections(reply).length||/do not have access/i.test(reply))throw Error('dispel_admin_command_refused');
    return reply;
  }
}
let adminPromise,queue=Promise.resolve();
let users=0,recast;
let selectedFleet='shadow',selectedState=null,selectedGamePort=15959,selectedAdminPort=19998;
export function shadowDispelIdentityMatches(health,{fleet='shadow',stateFile=null,gamePort=15959,adminPort=19998}={},env=process.env){
  const norm=p=>String(p??'').replaceAll('\\','/').toLowerCase();
  const localPort=p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535;
  const custom=gamePort!==15959||adminPort!==19998;
  return localPort(gamePort)&&localPort(adminPort)&&gamePort!==5959&&gamePort!==adminPort&&
    (!custom||typeof stateFile==='string'&&stateFile.length>0&&Number(env.M59_PORT)===gamePort)&&
    typeof fleet==='string'&&fleet.length>0&&fleet!=='prod'&&
    (fleet==='shadow'||typeof stateFile==='string'&&stateFile.length>0)&&
    health.fleet===fleet&&env.M59_FLEET===fleet&&
    health.game_server?.host==='127.0.0.1'&&health.game_server?.port===gamePort&&
    Number(env.M59_ADMIN_PORT)===adminPort&&(!stateFile||norm(health.state)===norm(resolve(stateFile)));
}
export function shadowDispelResetTimers(reply,room){
  if(!Number.isInteger(room)||room<=0)throw Error('dispel_room_unconfirmed');
  return [...String(reply).matchAll(/^\s*(\d+)\s+\d+\s+(\d+)\s+ReplaceIllusions\s*$/gim)]
    .filter(m=>Number(m[2])===room).map(m=>Number(m[1]));
}
async function administrator(){
  if(!adminPromise)adminPromise=(async()=>{
    const health=await(await fetch(process.env.M59_CONTROL_URL+'health')).json();
    if(!shadowDispelIdentityMatches(health,{fleet:selectedFleet,stateFile:selectedState,gamePort:selectedGamePort,adminPort:selectedAdminPort}))
      throw Error('dispel_requires_isolated_shadow_server');
    const account='disp'+randomBytes(6).toString('hex'),password=randomBytes(20).toString('hex');
    const reply=await dm('create account admin '+account+' '+password);
    if(!/created account/i.test(reply)||rejections(reply).length)throw Error('dispel_admin_creation_unconfirmed');
    const folder=resolve('substrate/island-admin');mkdirSync(folder,{recursive:true});
    writeFileSync(resolve(folder,account+'.json'),JSON.stringify({account,password,at:new Date().toISOString(),_owner:'Codex island lab Dispel'},null,2));
    const c=new DispelAdmin({host:'127.0.0.1',port:selectedGamePort,verbose:false});
    c.user=account;c.pass=password;await c.connect();
    const deadline=Date.now()+15000;
    while(c.state!=='admin'){
      if(c.error||Date.now()>deadline)throw Error('dispel_admin_login_failed');
      await pause(40);
    }
    return c;
  })().catch(e=>{adminPromise=null;throw e;});
  return adminPromise;
}
export function openShadowIslandCave(){
  const next=queue.catch(()=>{}).then(async()=>{
    const c=await administrator(),room=await resolveRoom(27);
    const timers=await c.command('show timers');
    const resets=shadowDispelResetTimers(timers,room);
    for(const timer of resets){
      const reply=await c.command('delete timer '+timer);
      if(!/This timer has been deleted/i.test(reply))throw Error('dispel_timer_deletion_unconfirmed');
    }
    const reply=await c.command(sendMsg(room,'DispelIllusions'));
    if(!/return/i.test(reply))throw Error('dispel_cast_unconfirmed');
    return {room,deleted_reset_timers:resets.length};
  });queue=next;return next;
}
export async function closeShadowIslandDispel(){
  await queue.catch(()=>{});
  const c=await adminPromise?.catch(()=>null);c?.sock?.destroy();adminPromise=null;
}
export async function retainShadowIslandDispel({fleet='shadow',stateFile=null,gamePort=15959,adminPort=19998}={}){
  if(users&&(fleet!==selectedFleet||stateFile!==selectedState||gamePort!==selectedGamePort||adminPort!==selectedAdminPort))throw Error('dispel_lab_selection_busy');
  if(!users){selectedFleet=fleet;selectedState=stateFile;selectedGamePort=gamePort;selectedAdminPort=adminPort;}
  users++;
  try{
    await openShadowIslandCave();
    if(!recast){recast=setInterval(()=>openShadowIslandCave().catch(()=>{}),20000);recast.unref();}
  }catch(e){if(--users===0)await closeShadowIslandDispel();throw e;}
  let released=false;
  return async()=>{
    if(released)return;released=true;
    if(--users===0){clearInterval(recast);recast=null;await closeShadowIslandDispel();}
  };
}
