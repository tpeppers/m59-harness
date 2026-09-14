// Counterfactual inputs are material scene changes and always carry a receipt.
import {observed} from './m59-scene.mjs';
export function sceneWithOptions(input,{fullHp=false,vigor=null,noMonsters=false}={}) {
  if(vigor!=null&&(!Number.isInteger(vigor)||vigor<0||vigor>200))throw Error('player vigor must be an integer from 0 to 200');
  const scene=structuredClone(input),changes=[];
  if(noMonsters) {
    const removed=scene.actors.filter(a=>a.kind==='monster').map(a=>a.key??a.name);
    scene.actors=scene.actors.filter(a=>a.kind!=='monster');changes.push({kind:'remove_monsters',actors:removed});
    if(scene.controller?.start_actions) {
      const actions=scene.controller.start_actions.filter(a=>removed.includes(a.actor_key));
      scene.controller.start_actions=scene.controller.start_actions.filter(a=>!removed.includes(a.actor_key));
      if(actions.length)changes.push({kind:'remove_start_actions_for_removed_monsters',actions});
    }
  }
  for(const a of scene.actors.filter(a=>a.kind==='player')) {
    if(fullHp) {
      const hp=a.vitals?.hp?.v;
      if(!Number.isFinite(hp?.max))throw Error(`full HP requires a known maximum for ${a.name}`);
      changes.push({actor:a.key??a.name,field:'hp',before:hp.value,after:hp.max});hp.value=hp.max;
    }
    if(vigor!=null) {
      a.vitals??={};const previous=a.vitals.vigor?.v??{};
      changes.push({actor:a.key??a.name,field:'vigor',before:previous.value??null,after:vigor});
      a.vitals.vigor=observed({...previous,value:vigor});
    }
  }
  scene.reload={at:new Date().toISOString(),faithful:changes.length===0,changes,
    options:{fullHp,vigor,noMonsters}};
  return scene;
}
