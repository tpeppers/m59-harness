// Passive player evidence. No requests, disk access, movement or combat orders.
import {OF} from './m59-parse.mjs';
import {parseDeathBroadcast} from './m59-death-attribution.mjs';
const norm=s=>String(s??'').trim().toLowerCase();
const esc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export const DEFENSE_IDS={dodge:401,parry:402,block:404};
export const WEAPON_MODELS=[
  [/^scimitar$/i,'Scimitar',453,421], [/^axe$/i,'Axe',455,421],
  [/^short sword$/i,'ShortSword',457,421], [/^long sword$/i,'Longsword',451,421],
  [/^hammer$/i,'Hammer',454,421], [/^mace$/i,'Mace',452,421],
  [/^bow$/i,'Bow',456,425], [/^crossbow$/i,'Crossbow',456,425]
];
export const weaponModel=name=>{const row=WEAPON_MODELS.find(([re])=>re.test(name));
  return row?{class:row[1],proficiency:row[2],stroke:row[3]}:null;};
const verbs='runs through|fails to damage|incinerates|electrocutes|brutalizes|disfigures|dissolves|corrupts|purifies|mortifies|cleanses|flattens|appalls|pollutes|maligns|devours|thrashes|mangles|pummels|cleaves|lacerates|damages|wounds|nicks|slays|burns|sears|scorches|chars|singes|fries|shocks|jolts|freezes|frosts|chills|cools|infuses|slams|buffets|shakes|gnaws|bites|nips|shreds|rends|rakes|claws|impales|pricks|stings|irritates|slaps|maims|slashes|cuts|smashes|crushes|bashes|stabs|pokes|fells|pierces|grazes|hits';
export const isIncomingHit=text=>new RegExp(`^.+? (${verbs}) you(?: with .+?)?\\.$`,'i').test(text);
export function parsePlayerCombat(text,names=[]) {
  const line=String(text??'').trim();
  for(const name of [...new Set(names)].sort((a,b)=>b.length-a.length)) {
    const who=esc(name);let m;
    if((m=new RegExp(`^${who} (${verbs}) you(?: with (?:his|her|its|their|an?|the) (.+?))?\\.$`,'i').exec(line))||
       (m=new RegExp(`^${who}['’]s (.+?) (${verbs}) you\\.$`,'i').exec(line))) {
      const possessive=new RegExp(`^${who}['’]s `,'i').test(line);
      return {character:name,direction:'incoming',outcome:'hit',verb:possessive?m[2]:m[1],
        weapon:possessive?m[1]:m[2]??null,text:line};
    }
    m=new RegExp(`^You (block|dodge|parry|avoid) ${who}['’]s attack\\.$`,'i').exec(line);
    if(m)return {character:name,direction:'incoming',outcome:'miss',defense:m[1].toLowerCase(),text:line};
    m=new RegExp(`^${who} (blocks|dodges|parries|avoids) your attack\\.$`,'i').exec(line);
    if(m)return {character:name,direction:'outgoing',outcome:'miss',
      defense:{blocks:'block',dodges:'dodge',parries:'parry',avoids:'avoid'}[m[1].toLowerCase()],text:line};
    m=new RegExp(`^Your (.+?) (${verbs}) ${who}\\.$`,'i').exec(line);
    if(m)return {character:name,direction:'outgoing',outcome:'hit',weapon:m[1],verb:m[2],text:line};
  }
  return null;
}
const pos=o=>o?{row:o.row??null,col:o.col??null,x:o.x??null,y:o.y??null,predicted:!!o.predicted}:null;
const sameSquare=(a,b)=>Number.isFinite(a?.row)&&Number.isFinite(a?.col)&&a.row===b?.row&&a.col===b?.col;
const named=(c,o)=>String(o.name??c.rsc?.get?.(o.nameRsc)??'').slice(0,240);
const item=(c,o,at)=>({object_at_observation:o.id,name:named(c,o),name_resource:o.nameRsc??null,
  amount:o.amount>0?o.amount:1,wire_amount:o.amount??null,rarity:o.rarity??null,flags:o.flags??null,at:pos(o),first_seen_at:at});
const isPlayer=(c,o)=>!!(o.flags&OF.PLAYER)||c.playersOnline?.has?.(o.id);
export function targetState(c) {
  return {stats:Object.fromEntries(['agility','aim','might','stamina'].map(k=>[k,c.statsById?.get?.(k)?.value??null])),
    health:c.vitals?.()?.health??null,
    abilities:[...(c.abilities?.values?.()??[])].filter(a=>['dodge','parry','block'].includes(norm(a.name)))
      .map(a=>({name:norm(a.name),ability:a.ability})),
    equipment:(c.equipment?.()?.equipped??[]).slice(0,32).map(o=>({name:named(c,o),rarity:o.rarity??null}))};
}
export class PlayerEvidenceObserver {
  constructor({emit,now=Date.now,maxItems=512,maxPlayers=256}={}) {
    this.emit=emit;this.now=now;this.maxItems=maxItems;this.maxPlayers=maxPlayers;
    this.players=new Map();this.items=[];this.health=[];this.combat=[];this.pending=[];this.deaths=[];
    this.room=null;this.context=null;this.stats={events:0,dropped:0,errors:0,witnessed_deaths:0};
  }
  roomState(c,context,at) {
    this.context=context;
    const present=new Set();
    for(const o of c.room?.objects?.values?.()??[])if(isPlayer(c,o)) {
      present.add(o.id);
      if(this.players.size>=this.maxPlayers&&!this.players.has(o.id)){this.stats.dropped++;continue;}
      this.players.set(o.id,{id:o.id,name:named(c,o),at:pos(o),seen:at,room:context.room});
    }
    if(c.self&&c.me?.name){present.add(c.selfId);this.players.set(c.selfId,{id:c.selfId,name:c.me.name,at:pos(c.self),seen:at,room:context.room});}
    for(const [id,p] of this.players)if(!present.has(id)&&!p.vanished_at)p.vanished_at=at;
  }
  event(ev,c,context) {
    const at=ev.at??this.now();
    if(ev.kind==='room-entered'||this.room!==context.room) {
      this.flush(at,true,null);this.players.clear();this.items=[];this.health=[];this.combat=[];this.deaths=[];
      this.room=context.room;
    }
    if(context.room==null)return;
    this.context=context;
    if(['room-contents','appeared','message','stat'].includes(ev.kind))this.roomState(c,context,at);
    if(ev.kind==='moved'||ev.kind==='player-moved') {
      const o=c.room?.objects?.get?.(ev.id??c.selfId);
      if(o&&isPlayer(c,o))this.players.set(o.id,{id:o.id,name:named(c,o),at:pos(o),seen:at,room:context.room});
    }
    if(ev.kind==='vanished') {
      const p=this.players.get(ev.id);if(p)p.vanished_at=at;
      for(const i of this.items)if(i.object_at_observation===ev.id)i.gone_at=at;
    }
    if(ev.kind==='appeared') {
      const o=c.room?.objects?.get?.(ev.id);
      if(o&&!isPlayer(c,o)&&(o.flags&OF.GETTABLE))this.items.push(item(c,o,at));
    }
    this.items=this.items.filter(i=>at-i.first_seen_at<8000);
    if(this.items.length>this.maxItems){this.stats.dropped+=this.items.length-this.maxItems;this.items=this.items.slice(-this.maxItems);}
    for(const [id,p] of this.players)if(p.vanished_at&&at-p.vanished_at>5000)this.players.delete(id);
    if(ev.kind==='stat'&&ev.name==='health'&&Number.isFinite(ev.value)) {
      this.health.push({at,hp:ev.value,max:ev.max??null,room:context.room});
      const older=this.health.filter(h=>at-h.at>=30000).at(-1);
      this.health=[...(older?[older]:[]),...this.health.filter(h=>at-h.at<30000)].slice(-256);
    }else if(!this.health.length&&Number.isFinite(c.vitals?.()?.health?.value)) {
      this.health.push({at,hp:c.vitals().health.value,max:c.vitals().health.max,room:context.room});
    }
    if(ev.kind==='message'&&ev.text) {
      const players=[...this.players.values()].filter(p=>p.room===context.room&&(!p.vanished_at||at-p.vanished_at<3000));
      const parsed=parsePlayerCombat(ev.text,players.filter(p=>p.id!==c.selfId).map(p=>p.name));
      if(parsed) {
        const row={type:'combat',...context,...parsed,at,sequence:ev.seq??null,target_state:targetState(c)};
        this.combat.push(row);this.pending.push({kind:'combat',due:at+850,row});
      }else if(isIncomingHit(ev.text))
        this.combat.push({at,direction:'incoming',outcome:'hit',character:null,text:ev.text});
      const death=parseDeathBroadcast(ev.text);
      if(death) {
        const matches=players.filter(p=>norm(p.name)===norm(death.who));
        if(matches.length===1&&!this.deaths.some(d=>norm(d.character)===norm(death.who)&&at-d.at<3000)) {
          const row={type:'dropped_loadout',...context,character:matches[0].name,at,
            death_at:pos(matches[0].at),death_message:death.text,visible_player:matches[0].id,
            witness_basis:matches[0].vanished_at?'recently_vanished_player':'visible_player',
            last_seen_at:matches[0].seen,vanished_at:matches[0].vanished_at??null};
          this.deaths.push(row);this.pending.push({kind:'death',due:at+2000,row});this.stats.witnessed_deaths++;
        }
      }
    }
    this.combat=this.combat.filter(r=>at-r.at<5000).slice(-256);
    this.deaths=this.deaths.filter(r=>at-r.at<8000).slice(-32);
    if(this.pending.length>160){this.stats.dropped+=this.pending.length-160;this.pending=this.pending.slice(-160);}
    this.flush(at,false,c);
  }
  flush(at=this.now(),leaving=false,c=null) {
    const ready=this.pending.filter(p=>leaving||p.due<=at);this.pending=this.pending.filter(p=>!leaving&&p.due>at);
    for(const p of ready) {
      const row=p.row;
      if(p.kind==='combat') {
        row.health_window=this.health.filter(h=>h.room===row.room&&h.at>=row.at-1200&&h.at<=row.at+800).map(h=>({...h}));
        const baseline=this.health.filter(h=>h.room===row.room&&h.at<row.at-1200).at(-1);
        if(baseline)row.health_window.unshift({...baseline});
        row.competing_hits=this.combat.filter(r=>r!==row&&r.direction==='incoming'&&r.outcome==='hit'&&Math.abs(r.at-row.at)<=800)
          .map(r=>({at:r.at,character:r.character,text:r.text}));
        row.window_interrupted=leaving&&at<p.due;
      }else {
        const candidates=this.items.filter(i=>i.first_seen_at>=row.at-1000&&i.first_seen_at<=row.at+2000&&sameSquare(i.at,row.death_at));
        const other=this.deaths.filter(d=>d!==row&&Math.abs(d.at-row.at)<=3000&&sameSquare(d.death_at,row.death_at));
        row.dropped_loadout={items:candidates.map(i=>({...i,ownership:'inferred from place and time',
          candidate_characters:[row.character,...other.map(d=>d.character)]})),
          room_snapshot:[...(c?.room?.objects?.values?.()??[])].filter(o=>(o.flags&OF.GETTABLE)&&!isPlayer(c,o))
            .slice(0,this.maxItems).map(o=>item(c,o,null)),
          association:other.length?'ambiguous_multiple_deaths':'temporal_spatial_estimate',
          complete_inventory:false,window_interrupted:leaving&&at<p.due,capture_dropped:this.stats.dropped,
          position_uncertain:row.vanished_at!=null||!Number.isFinite(row.death_at?.row)||!Number.isFinite(row.death_at?.col)||row.death_at.predicted,
          window:{from:row.at-1000,to:Math.min(at,row.at+2000)},
          note:'Observed new ground items, including items already picked up. Drops prove neither equipped status nor a complete inventory; empty means none observed.'};
      }
      try{this.emit?.(row);this.stats.events++;}catch{this.stats.errors++;}
    }
  }
}

export function wilson(hits,total) {
  if(!total)return null;const p=hits/total,z=1.96,den=1+z*z/total,mid=(p+z*z/(2*total))/den;
  const half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/den;
  return {rate:p,low:Math.max(0,mid-half),high:Math.min(1,mid+half),n:total};
}
export function matchedDamage(row) {
  if(row.direction!=='incoming'||row.outcome!=='hit'||row.verb==='fails to damage'||row.competing_hits?.length||row.window_interrupted)return null;
  const h=[...(row.health_window??[])].sort((a,b)=>a.at-b.at),drops=[];
  for(let i=1;i<h.length;i++)if(h[i-1].hp>h[i].hp&&Math.abs(h[i].at-row.at)<=800)
    drops.push({lost:h[i-1].hp-h[i].hp,at:h[i].at,fatal:h[i].hp===0});
  return drops.length===1?{...drops[0],attribution:'single nearby hit message; provisional',
    actual_damage_lower_bound:drops[0].fatal}:null;
}
export function estimatePlayer(rows,{character,room=null,since=-Infinity,until=Infinity,aim=30,maxHp=100,defense=null,encounters=true}={}) {
  const defenseRows=rows.filter(r=>norm(r.character)===norm(character)&&r.type==='combat'&&r.at>=since&&r.at<=until);
  const defenseCombat=[...new Map(defenseRows.map(r=>[[r.observer,r.at,r.text].join('|'),r])).values()];
  rows=rows.filter(r=>norm(r.character)===norm(character)&&(room==null||r.room===room||(r.type==='operator_fact'&&r.room==null))&&
    (r.type==='operator_fact'||(r.at>=since&&r.at<=until)));
  const unique=new Map();for(const r of rows)unique.set([r.type,r.observer,r.at,r.text??r.death_message??r.fact?.item].join('|'),r);
  rows=[...unique.values()].sort((a,b)=>a.at-b.at);
  const combat=rows.filter(r=>r.type==='combat'),incoming=combat.filter(r=>r.direction==='incoming'),
    hit=incoming.filter(r=>r.outcome==='hit'),accuracy=wilson(hit.length,incoming.length);
  const weapons=[...new Set(hit.map(r=>r.weapon).filter(Boolean))];
  const defenses=Object.keys(DEFENSE_IDS).filter(skill=>defenseCombat.some(r=>r.direction==='outgoing'&&r.defense===skill))
    .map(skill=>({name:skill,id:DEFENSE_IDS[skill],ability:99,how:'operator-requested conservative assumption',
      observed_uses:defenseCombat.filter(r=>r.direction==='outgoing'&&r.defense===skill).length,
      observed_rooms:[...new Set(defenseCombat.filter(r=>r.direction==='outgoing'&&r.defense===skill).map(r=>r.room))],
      scope:'character skill evidence across rooms; equipment eligibility must be modeled separately'}));
  const damage=hit.map(matchedDamage).filter(Boolean),facts=rows.filter(r=>r.type==='operator_fact'),
    drops=rows.filter(r=>r.type==='dropped_loadout');
  const span=incoming.length>1?incoming.at(-1).at-incoming[0].at:0;
  const contiguous=incoming.length>1&&incoming.every((r,i)=>!i||r.observer===incoming[0].observer&&r.room===incoming[0].room&&r.at-incoming[i-1].at<10000);
  const estimate={schema:'m59-player-estimate/v1',character,room,observations:rows.length,
    weapon_observations:weapons.map(name=>({name,model:weaponModel(name),count:hit.filter(r=>r.weapon===name).length})),
    latest_weapon:hit.filter(r=>weaponModel(r.weapon??'')).at(-1)?.weapon??null,
    defensive_skills:defenses,accuracy,
    damage:{matched_hits:damage.length,hp_lost:damage.reduce((n,d)=>n+d.lost,0),
      per_matched_hit:damage.length?damage.reduce((n,d)=>n+d.lost,0)/damage.length:null,
      min:damage.length?Math.min(...damage.map(d=>d.lost)):null,max:damage.length?Math.max(...damage.map(d=>d.lost)):null,
      fatal_lower_bounds:damage.filter(d=>d.fatal).length,unmatched_hits:hit.length-damage.length,
      observed_span_ms:span,hp_loss_per_second_over_observed_span:contiguous&&span>0?damage.reduce((n,d)=>n+d.lost,0)/(span/1000):null,
      span_note:'First to last resolved attack; only reported for one contiguous victim/room window; starts with a hit and can underestimate or overestimate sustained DPS.'},
    operator_facts:facts.map(r=>({fact:r.fact,room:r.room,at:r.at,source:r.source})),
    dropped_loadout:drops.at(-1)?.dropped_loadout??null,dropped_loadout_observations:drops,
    offensive_skill_estimate:null,
    limitations:['Damage includes victim mitigation; fatal HP loss is a lower bound. HP/message association is provisional.',
      'Accuracy is observed resolved attacks, not all attempts. Defense words indicate a defense was available, not 99% proficiency.',
      'Retained postmortems select encounters ending in death; pooled hit rates are not an unbiased sample of all fights. Wilson intervals are descriptive binomial intervals.',
      'Weapon, stroke/proficiency, aim, maximum HP, faction effects, rings and victim defense are confounded; damage alone cannot identify skills.',
      'Cleaves is the slashing killing-blow descriptor in this server, not a numeric skill or damage tier.']};
  if(accuracy&&weapons.length===1&&weaponModel(weapons[0])&&Number.isFinite(defense)&&defense>0) {
    // battler.kod: chance=bound(offense*55/defense,10,95).
    // player.kod: offense=3*stroke+2*proficiency+4*aim+1.5*baseMaxHP, before modifiers.
    const berserk=facts.some(r=>r.fact?.item==='BerserkerRing'&&(r.room==null||r.room===room)),modifier=berserk?-200:0;
    const convert=p=>Math.max(1,Math.min(99,Math.round((p*100/55*defense-4*aim-Math.floor(1.5*maxHp)-modifier)/5)));
    estimate.offensive_skill_estimate={ability:accuracy.rate<=0.1||accuracy.rate>=0.95?null:convert(accuracy.rate),
      range:[accuracy.low<=0.1?1:convert(accuracy.low),accuracy.high>=0.95?99:convert(accuracy.high)],
      assumptions:{stroke_equals_proficiency:true,aim,maxHp,victim_defense:defense,berserker_mean_hitroll:modifier,
        other_modifiers:0},clipped_hit_chance:accuracy.low<=0.1||accuracy.high>=0.95,
      how:'conditional inverse accuracy model; not uniquely identified or a confidence interval on actual skills; point omitted at hit-chance boundaries'};
  }
  if(encounters) {
    const groups=[],latest=new Map();
    for(const row of incoming) {
      const key=[row.observer,row.room].join('|');let g=latest.get(key);
      if(!g||row.at-g.at(-1).at>10000){g=[];groups.push(g);latest.set(key,g);}g.push(row);
    }
    estimate.encounters=groups.map(g=>{
      const target=g.find(r=>r.target_state?.stats)?.target_state;
      const ability=name=>target?.abilities?.find(a=>norm(a.name)===name)?.ability??0;
      const armed=target?.equipment?.some(e=>weaponModel(e.name??'')),shield=target?.equipment?.some(e=>/shield/i.test(e.name??''));
      const base=Number.isFinite(target?.stats?.agility)&&Number.isFinite(target?.health?.max)?
        2*(armed?ability('parry'):0)+(shield?ability('block'):0)+3*ability('dodge')+4*target.stats.agility+Math.floor(1.5*target.health.max):null;
      const fit=estimatePlayer([...g,...facts],{character,room:g[0].room,aim,maxHp,defense:defense??base,encounters:false});
      return {observer:g[0].observer,room:g[0].room,first_at:g[0].at,last_at:g.at(-1).at,
        weapons:fit.weapon_observations,accuracy:fit.accuracy,damage:fit.damage,
        offensive_skill_estimate:fit.offensive_skill_estimate,
        victim_defense_model:defense!=null?{supplied:defense}:base==null?null:{base,source:'cached victim stats, visible weapon/shield and learned defenses',
          assumptions:'Missing abilities count as zero; armor bonuses, temporary effects, skill bonuses, faction and flags excluded; raw base maximum HP approximated by observed max.'}};
    });
  }
  return estimate;
}
