#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attributeDeath,applyDeathAttribution,parseDeathBroadcast} from './m59-death-attribution.mjs';
import {causeGroups,facets} from './m59-postmortems.mjs';
import {killerOf,travelCandidates,monsterNames} from './m59-critic.mjs';
import {backfill} from './m59-death-attribution-backfill.mjs';
const at=1789426846158;
const message=(text,time=at,kind='message')=>({at:time,kind,text});
const murder=()=>({at,reason:'died',character:'Fozzie',was:{doing:'travelling'},
  summary:{at,killed_by:[],was_nearby:['fungus beast','fungus beast']},
  threats:{players_present:[],present_at_the_end:['fungus beast']},
  killed_by_broadcast:{...parseDeathBroadcast('### Fozzie has been murdered in cold blood.'),at:at-1},
  text:[message('You are dead, poor soul.  Go now, and take revenge on Morpheus!',at-2)]});
const m=murder(), raw=structuredClone(m);
let a=attributeDeath(m);
assert.equal(a.killer,'Morpheus');assert.equal(a.kind,'player_murder');
assert.equal(a.observed,true);assert.equal(a.was_killed_by_player,true);
assert.equal(a.killed_by_player_is_a_guess,false);assert.equal(a.evidence.length,2);
applyDeathAttribution(m);
assert.deepEqual(m.summary.killed_by,['Morpheus']);assert.equal(m.summary.killed_by_is_a_guess,false);
assert.deepEqual(m.text,raw.text);assert.deepEqual(m.killed_by_broadcast,raw.killed_by_broadcast);
assert.deepEqual(m.summary.was_nearby,raw.summary.was_nearby);
assert.deepEqual(applyDeathAttribution(structuredClone(m)),m,'repair is idempotent');
for (const text of [[],[message(raw.text[0].text,at-20000)],[message(raw.text[0].text,at,'said')]]) {
  const p={...murder(),text,threats:{players_present:['Morpheus'],present_at_the_end:['fungus beast']}};
  a=attributeDeath(p);assert.equal(a.killer,null,'no guess from nearby monsters/players or stale/chat evidence');
  assert.equal(a.kind,'player_murder');assert.equal(a.cause_observed,true);
}
for (const [line,kind] of [['### Fozzie met an untimely end.','environment'],
  ['### Fozzie was just slain by his own folly.','self_inflicted']]) {
  a=attributeDeath({...murder(),text:[],killed_by_broadcast:{...parseDeathBroadcast(line),at}});
  assert.equal(a.killer,null);assert.equal(a.kind,kind);assert.equal(a.was_killed_by_player,false);
}
const monster={...murder(),text:[message('You are dead, poor soul.  Go now, and take revenge on a troll!')],
  killed_by_broadcast:{...parseDeathBroadcast('### Fozzie was just killed by a troll.'),at}};
assert.equal(attributeDeath(monster).killer,'troll');
assert.equal(attributeDeath(monster).was_killed_by_player,false);
const other=murder();other.killed_by_broadcast=null;
other.text=[message('### Beaker has been murdered in cold blood.')];
assert.equal(attributeDeath(other).cause_observed,false,'other victims do not supply cause');
const newer=murder();newer.text.unshift(message('You are dead, poor soul.  Go now, and take revenge on Oldkiller!',at-60000));
assert.equal(attributeDeath(newer).killer,'Morpheus');
const morphed={...monster,text:raw.text};
assert.equal(attributeDeath(morphed).killer,'Morpheus','victim receives true identity of morphed killer');
assert.equal(attributeDeath(morphed).broadcast_identity_differs,true);
const fromText={...murder(),killed_by_broadcast:null,text:[...raw.text,message(raw.killed_by_broadcast.text)]};
assert.equal(attributeDeath(fromText).killer,'Morpheus');
assert.equal(attributeDeath(fromText).kind,'player_murder');
const table=monsterNames([{_res:{a:['Morpheus',1],b:['troll',2]}}]);
assert.equal(killerOf(m,table).is_monster,false,'confirmed player is not a monster even if names collide');
assert.equal(travelCandidates([m],{monsters:table,fleet:new Set()})[0].pvp,true,'murder needs no player in final visibility');
const nameless={...murder(),text:[]};
const p2=murder();p2.text=[message('You are dead, poor soul.  Go now, and take revenge on Anotherplayer!')];
const unknown={...murder(),killed_by_broadcast:null,text:[]};
const rows=[m,p2,nameless,monster,unknown].map(p=>({character:p.character,cause:attributeDeath(p),where:{trusted:false}}));
assert.equal(facets(rows).cause.total,4,'nameless murder is a confirmed cause');
assert.equal(facets(rows).cause.inferred_total,1);
const individual=causeGroups(rows);assert.equal(individual.children.some(x=>x.name==='Morpheus'),true);
const grouped=causeGroups(rows,'all-players');
assert.equal(grouped.children.find(x=>x.name==='All players').value,3);
const pvp=causeGroups(rows,'pvp-pve');
assert.deepEqual(Object.fromEntries(pvp.children.map(c=>[c.name,c.value])),{PvP:3,PvE:1,Unknown:1});
assert.equal(pvp.total,5);
const scratch=mkdtempSync(join(tmpdir(),'m59-attribution-'));
try {
  const dir=join(scratch,'postmortems'); const {mkdirSync}=await import('node:fs');mkdirSync(dir);
  const file=join(dir,'Fozzie.json'), bytes=JSON.stringify(raw);writeFileSync(file,bytes);
  const preview=backfill({dir,killer:'Morpheus'});assert.equal(preview.changed,1);
  assert.equal(readFileSync(file,'utf8'),bytes,'preview never writes');
  const repaired=backfill({dir,killer:'Morpheus',apply:true});
  assert.equal(readFileSync(join(repaired.backup,'Fozzie.json'),'utf8'),bytes,'backup is byte-identical');
  assert.equal(JSON.parse(readFileSync(file)).summary.killed_by[0],'Morpheus');
  assert.equal(backfill({dir,killer:'Morpheus',apply:true}).changed,0);
  assert.equal(readdirSync(dir).length,1,'no temporary files left');
} finally {rmSync(scratch,{recursive:true,force:true});}
console.log('Death attribution, murder evidence, cause grouping, critic and historical repair passed');

