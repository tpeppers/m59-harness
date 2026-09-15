#!/usr/bin/env node
// Run ordinary broker/tools with a named lab's isolated writable evidence.
// Example (then use the same prefix for pilgrimage, DM and service stop):
// node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 -- tools/m59-service.mjs start --http 8981 --dashboard 8982 --no-ui
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {stateFileFor} from './m59-fleetpath.mjs';
import {configureLabEnvironment} from './runtime/lab-environment.mjs';

export function parseLabCommand(argv) {
  const split=argv.indexOf('--'),opts=split<0?argv:argv.slice(0,split),command=split<0?[]:argv.slice(split+1);
  const config={command};
  for(let i=0;i<opts.length;i++) {
    const key=opts[i];
    if(key==='--check'){config.check=true;continue;}
    if(!['--fleet','--game-port','--admin-port','--receipt','--scope'].includes(key)||!opts[i+1]||opts[i+1].startsWith('--'))
      throw Error('expected --fleet NAME --game-port N --admin-port N [--check] [--receipt FILE] -- TOOL.mjs [ARGS]');
    if(config[key.slice(2)]!=null)throw Error('duplicate option '+key);
    config[key.slice(2)]=opts[++i];
  }
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config.fleet??'')||config.fleet.toLowerCase()==='prod')throw Error('explicit non-production fleet required');
  for(const key of ['game-port','admin-port']) {
    config[key]=Number(config[key]);
    if(!Number.isInteger(config[key])||config[key]<1024||config[key]>65535||[5959,9998].includes(config[key]))throw Error('explicit non-default lab ports required');
  }
  if(config['game-port']===config['admin-port'])throw Error('game and maintenance ports must differ');
  if(config.scope!=null&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.scope))throw Error('invalid lab scope');
  if(!config.check&&(!command[0]?.endsWith('.mjs')))throw Error('supply a Node .mjs tool after --');
  for(let i=0;i<command.length;i++)if(command[i]==='--fleet'&&command[i+1]!==config.fleet)throw Error('child fleet conflicts with lab fleet');
  return config;
}

export function validateLabRoster(roster,port) {
  const rows=Object.values(roster??{});
  if(!rows.length||Array.isArray(roster))throw Error('lab roster is empty or malformed');
  if(rows.some(r=>!['127.0.0.1','localhost','::1'].includes(r?.credentials?.host)||Number(r.credentials.port)!==port))
    throw Error('every roster account must use the explicit loopback lab game port');
  return rows.length;
}

export function prepareLabCommand(config,baseEnv=process.env) {
  // Explicit fleet wins over a shell inherited from another checkout.
  const stateFile=resolve(stateFileFor(config.fleet,{}));
  const count=validateLabRoster(JSON.parse(readFileSync(stateFile,'utf8')),config['game-port']);
  const env={...baseEnv};
  const runtime=configureLabEnvironment({fleet:config.fleet,stateFile},env,{scope:config.scope??null});
  // This wraps the ordinary broker's child keepers, not the optional shared actor runtime.
  delete env.M59_RUNTIME_PROFILE;delete env.M59_KEEPER;
  Object.assign(env,{M59_HOST:'127.0.0.1',M59_PORT:String(config['game-port']),
    M59_ADMIN_HOST:'127.0.0.1',M59_ADMIN_PORT:String(config['admin-port']),
    M59_REPLAY_DIR:join(runtime.runtimeDir,'replays'),M59_SURVIVAL_DECISION_DIR:join(runtime.runtimeDir,'decisions')});
  return {env,receipt:{schema:'m59-lab-command/v1',at:new Date().toISOString(),fleet:config.fleet,
    state_file:stateFile,actors:count,game_port:config['game-port'],admin_port:config['admin-port'],runtime}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config=parseLabCommand(process.argv.slice(2)),{env,receipt}=prepareLabCommand(config);
    if(config.receipt)writeFileSync(resolve(config.receipt),JSON.stringify(receipt,null,2),{flag:'wx'});
    console.error(JSON.stringify(receipt));
    if(!config.check) {
      const child=spawn(process.execPath,config.command,{env,stdio:'inherit',windowsHide:true});
      child.on('error',error=>{console.error(error.message);process.exitCode=1;});
      child.on('exit',code=>{process.exitCode=code??1;});
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
