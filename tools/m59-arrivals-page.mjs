import {loadMap} from './m59-map.mjs';
import {hometownReport} from './m59-hometowns-page.mjs';
import {loadBook} from './m59-transits.mjs';
import {epochFor} from './m59-epoch.mjs';
import {arrivalOptions,transitEvidence,quantile} from './m59-arrival-model.mjs';
import {rescueTravelPolicy} from './m59-rescue-travel.mjs';
import {NAV,STYLE,esc} from './m59-page-chrome.mjs';
const duration=x=>x==null?'—':x<60000?`${(x/1000).toFixed(1)}s`:`${(x/60000).toFixed(1)}m`;
const bounded=(q,key,def,min,max)=>{const x=Number(q.get(key)??def);return Number.isFinite(x)?Math.max(min,Math.min(max,x)):def;};
export async function renderArrivals({stateFile,live=[],readiness={},query=new URLSearchParams(),map=loadMap(),epoch=epochFor()}={}){
 const to=Math.floor(bounded(query,'to',50,1,9999)),fallbackMs=bounded(query,'hop',20,1,600)*1000,
 overheadMs=bounded(query,'dispatch',2,0,300)*1000,hall=Math.floor(bounded(query,'hall',714,0,9999)),count=Math.floor(bounded(query,'count',3,1,100));
 const mode=['current','walk','chalice','spell','mixed'].includes(query.get('mode'))?query.get('mode'):'current';
 const {rows}=hometownReport({stateFile});
 const edges=transitEvidence(rows.map(r=>loadBook(r.character)),{since:epoch.dirty?Infinity:Date.parse(epoch.at)||Infinity});
 const methods=mode==='walk'?[]:mode==='chalice'?[{kind:'chalice',uses:2}]:mode==='spell'?[{kind:'spell',uses:2}]:[{kind:'spell',uses:2},{kind:'chalice',uses:2}];
 const results=[];
 for(const row of rows){
  const current=live.find(r=>r.agent===row.agent),from=current?.room_num;
  const policy=await rescueTravelPolicy({agent:row.agent,character:row.character,spells:[],to});
  const ready=readiness[row.agent];
  const options=mode==='current'&&(!ready||ready.unavailable)?[]:arrivalOptions({map,from,to,homeRoom:row.record?.current.room,guildHall:mode==='current'?ready?.guildHall:hall||null,methods:mode==='current'?ready?.methods??[]:methods,edges,fallbackMs,overheadMs});
  results.push({...row,from,current,enabled:policy?.enabled===true,readiness:ready,options,best:options[0]});
 }
 results.sort((a,b)=>(a.best?.p90_ms??Infinity)-(b.best?.p90_ms??Infinity));
 const cohort=query.get('cohort')==='enabled'?'enabled':'all';
 const shown=cohort==='enabled'?results.filter(r=>r.enabled):results;
 const eligible=shown.filter(r=>r.best&&r.current?.in_game!==false);
 // Conditional independent scenarios. Cups are assumed individually carried, never
 // pretend that a single shared holder can serve simultaneous two-sip riders.
 const kth=eligible.length>=count?quantile(Array.from({length:1024},(_,i)=>eligible.map((r,j)=>r.best.draws[(i+j*71)%1024]).sort((a,b)=>a-b)[count-1])):null;
 const rooms=Object.values(map.rooms).sort((a,b)=>a.num-b.num);
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arrival explorer</title><style>${STYLE}table{width:100%}td{vertical-align:top}input,select,button{font:inherit;padding:.4rem;max-width:22rem}form{display:flex;gap:1rem;flex-wrap:wrap}label{display:grid;gap:.25rem}.scroll{overflow:auto}.route{min-width:22rem}summary{cursor:pointer}</style></head><body><div class="wrap"><h1>Arrival explorer</h1>${NAV('arrivals')}
<p>Conditional P90 arrival estimates from current reported rooms. This page sends no movement orders. Arrival means reaching the map, not completing a combat action.</p>
<form><label>Destination<select name="to">${rooms.map(r=>`<option value="${r.num}" ${r.num===to?'selected':''}>${esc(r.name)} [${r.num}]</option>`).join('')}</select></label>
<label>Resources to model<select name="mode">${[['current','Current inspected resources'],['walk','Walking only'],['chalice','Each responder carries a full chalice'],['spell','Each responder can afford two Rescues'],['mixed','Both resources available']].map(([v,l])=>`<option value="${v}" ${v===mode?'selected':''}>${l}</option>`).join('')}</select></label>
<label>What-if guild hall (0 = none)<input name="hall" type="number" min="0" value="${hall}"></label>
<label>Unmeasured hop (seconds)<input name="hop" type="number" min="1" max="600" value="${fallbackMs/1000}"></label>
<label>Dispatch allowance (seconds)<input name="dispatch" type="number" min="0" max="300" value="${overheadMs/1000}"></label>
<label>Group<select name="cohort"><option value="all" ${cohort==='all'?'selected':''}>All fleet members</option><option value="enabled" ${cohort==='enabled'?'selected':''}>Tactic-enabled casters</option></select></label>
<label>Responders wanted<input name="count" type="number" min="1" value="${count}"></label><button>Compare routes</button></form>
<div class="cards"><div class="card"><div class="k">Fastest individual modeled P90</div><div class="v">${duration(eligible[0]?.best.p90_ms)}</div><div>${esc(eligible[0]?.character??'No route')}</div></div><div class="card"><div class="k">${count} responders on map · modeled P90</div><div class="v">${duration(kth)}</div><div>Assumes independent travel and individual resources</div></div></div>
<p><b>Arrival estimate, not a combat-readiness promise.</b> Current mode inspects eligible carried resources. What-if resource choices assume the named resources, sufficient mana/reagents and compatible karma, no PvP lockout, and the specified guild hall for each character. Human control, recovery, queued handoffs and combat preemption can prevent dispatch. Automatic routing checks these conditions separately. A full cup is retained across two sips; shared-station acquisition is not included.</p>
<p>Movement evidence build: ${esc(epoch.id??'unknown')} · ${edges.size} directed crossings recorded since ${esc(epoch.at??'unknown')}. At least five successful samples per edge are required; other hops use your ${fallbackMs/1000}s assumption. P90s come from simulated whole journeys, not added edge percentiles. Failures are shown separately; estimates are conditional on completion and assume independent legs. Teleport timers use source defaults and conservative spell power 1, not a server-settings read.</p>
<div class="scroll"><table><thead><tr><th>Character / routing tactic</th><th>From / hometown</th><th>P50</th><th>P90</th><th>Best route and alternatives</th><th>Evidence</th></tr></thead><tbody>${shown.map(r=>`<tr><td>${esc(r.character)}<br>${r.enabled?'Enabled':'Not enabled'}<br>${esc(r.readiness?.reason??'What-if resources')}</td><td>${esc(map.rooms[r.from]?.name??r.from??'Unknown')} [${esc(r.from??'—')}] / ${esc(r.town)}</td><td>${duration(r.best?.p50_ms)}</td><td><b>${duration(r.best?.p90_ms)}</b></td><td class="route">${esc(r.best?.label??'No modeled route')}<details><summary>Compare ${r.options.length} options</summary>${r.options.map(o=>`<p>${duration(o.p90_ms)} · ${esc(o.label)}</p>`).join('')}</details></td><td>${r.best?`${r.best.known_hops}/${r.best.walking_hops} sampled walking legs<br>${r.best.failed_attempts}/${r.best.attempts} observed crossing failures`:'—'}</td></tr>`).join('')}</tbody></table></div><p>Snapshot generated ${esc(new Date().toISOString())}. Refresh to update positions. Unknown hometowns cannot offer a hometown leg. Island routes obey regional Rescue precedence: orc caves → Pool of Vigor → Ko’catan inn.</p></div></body></html>`;
}
