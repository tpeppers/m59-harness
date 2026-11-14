// #movement: THE ARCHAIC HOLLOWS' NORTH EDGE, AND WHY `travel 2507` FROM ITS LOWER BODY BOUNCED.
//
//   node tools/m59-hollows-north-test.mjs        offline: map, step masks, fine rails, fakes
//
// 2026-11-14, Zoot in 2502: `travel to 2507` gave up after 25 hops and every walk_to toward the
// north edge ended movement_deviation. orccave3.kod:68 puts 2502's only door to Grog's
// Antechamber on its NORTH edge (r1c41), and that edge is the top of a 9600 corridor on the
// Hollows' upper shelf. The lower Hollows (4800-8000, where travellers from 2501 arrive) has no
// climb to it: its one way up is a 9280 bridge between square centres (r42/r43 c44-51) and the
// declared r40c33 > r40c29 running crossing, which only the island's Hollows controller flies.
// The coarse router plans neither, so it never had a route to r1c41 to give.
//
// Pinned here: the geometry fact (lower body cannot step to r1c41, the upper passage can), the
// north leg the controller now walks (HOLLOWS_NORTH_POINTS, level 9600 fine rails), the baked
// guides for it, the leg selection, and the entry helper riija-pitboss and grog-antechamber use.
import assert from 'node:assert/strict';
import {roomGeometry} from './m59-ground.mjs';
import {loadMap} from './m59-map.mjs';
import {DIR} from './m59-roo.mjs';
import {cutRail} from './m59-railcut.mjs';
import {protocolToClient} from './m59-finepos.mjs';
import {fineGuideBook,findFineGuide} from './m59-fine-guides.mjs';
import {fallJumpsIn} from './m59-falljump.mjs';
import {HOLLOWS_OUT_POINTS,HOLLOWS_NORTH_POINTS,hollowsOutLeg} from './m59-island-finewalk.mjs';
import {enterGrogsAntechamber,GROG_ANTECHAMBER} from './m59-island-route.mjs';

let passed=0;const ok=(c,m)=>{assert.ok(c,m);passed++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);passed++;};
const map=loadMap(),geo=roomGeometry(2502);
const sq=p=>({row:Math.floor(p.y/64),col:Math.floor(p.x/64)});   // KOD protocol point -> square

// 1. The kod's door, as the map carries it: 2502 north -> 2507 r164c25, and 2507 south -> 2502 r3c41.
const north=map.rooms[2502].edgeExits.find(e=>e.leaveName==='north');
eq([north?.to,north?.arriveRow,north?.arriveCol],[2507,164,25],'orccave3.kod:68 LEAVE_NORTH -> RID_ORC_PIT_A r164c25');
const back=map.rooms[2507].edgeExits.find(e=>e.leaveName==='south');
eq([back?.to,back?.arriveRow,back?.arriveCol],[2502,3,41],'orcpita.kod:70 LEAVE_SOUTH -> RID_ORC_CAVE3 r3c41');
ok(map.rooms[2502].edgeExits.every(e=>e.leaveName!=='south'),'2502 has no south edge: "entered from 2502 (south edge)" was wrong');

// 2. The diagnosis. Flood the mover's own step mask forward.
const flood=(r0,c0)=>{const seen=new Set([r0+','+c0]),q=[[r0,c0]];
  while(q.length){const [r,c]=q.shift();for(const d of Object.values(DIR)){const nr=r+d.dr,nc=c+d.dc,k=nr+','+nc;
    if(nr<1||nc<1||nr>geo.rows||nc>geo.cols||seen.has(k))continue;
    let s=false;try{s=geo.moverStepLands(r,c,nr,nc);}catch{}if(s){seen.add(k);q.push([nr,nc]);}}}return seen;};
for(const [r,c,why] of [[30,45,"Zoot's start"],[49,52,'the native login point'],[48,77,'the arrival from 2501']])
  ok(!flood(r,c).has('1,41'),`the lower Hollows (${why}, r${r}c${c}) has no step-mask route to the north edge r1c41`);
const upper=sq(HOLLOWS_OUT_POINTS[3]);
eq(upper,{row:16,col:37},'HOLLOWS_OUT_POINTS[3] is the upper passage r16c37');
ok(flood(upper.row,upper.col).has('1,41'),'the upper passage reaches the north edge on the ordinary step mask');
const jump=fallJumpsIn(2502).find(j=>j.to?.row===40&&j.to?.col===29);
ok(jump&&!flood(30,45).has('40,33'),'the declared crossing r40c33 > r40c29 exists and its take-off is not on the coarse lower body: the 9280 bridge is between square centres');

// 3. The north leg is walkable at fine resolution, level on the 9600 shelf, start to edge.
const edge=(a,b)=>{const t=geo.traceFineMoveClient(a.x,a.y,b.x,b.y,{slide:false});return t.arrived&&!t.blocked;};
const chain=[HOLLOWS_OUT_POINTS[3],...HOLLOWS_NORTH_POINTS];
for(let i=1;i<chain.length;i++){
  const a=protocolToClient(chain[i-1]),b=protocolToClient(chain[i]);
  const cut=cutRail(a,b,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice:128});
  ok(cut.ok&&cut.bridgeOk,`north leg ${i} r${sq(chain[i-1]).row}c${sq(chain[i-1]).col} -> r${sq(chain[i]).row}c${sq(chain[i]).col} is a proved fine rail`);
  const floors=new Set(cut.waypoints.map(w=>Math.round(geo.floorBaseAtClient(w.x,w.y))));
  eq([...floors],[9600],`north leg ${i} never leaves the 9600 shelf`);
}
eq(sq(HOLLOWS_NORTH_POINTS.at(-1)),{row:3,col:41},'the north approach is where 2507 lands southbound travellers');
ok(flood(3,41).has('1,41'),'from the approach, the one-hop travel has an ordinary route to the edge anchor');

// 4. The guides baked for it, and the lookup the fine-rail worker uses.
const guides=fineGuideBook().rooms[2502].guides,named=n=>guides.find(g=>g.name===n);
eq(named('north_out_1')?.from,HOLLOWS_OUT_POINTS[3],'north_out_1 branches off western_out_4 at the upper passage');
eq(named('north_out_2')?.to,HOLLOWS_NORTH_POINTS.at(-1),'north_out_2 ends at the north approach');
for(const g of ['north_out_1','north_out_2']){
  const r=findFineGuide(geo,protocolToClient(named(g).from),protocolToClient(named(g).to),{edge});
  ok(r?.ok&&r.guide===g,`findFineGuide serves ${g}`);
}
ok(findFineGuide(geo,{x:46592,y:30208},protocolToClient(HOLLOWS_NORTH_POINTS.at(-1)),{edge})===null,
  'no guide carries a body from the lower Hollows straight to the north edge: the crossing stays a declared jump');

// 5. Leg selection: 2503 unchanged, 2507 turns north at the upper passage, anything else refused.
eq(hollowsOutLeg(),{points:HOLLOWS_OUT_POINTS.slice(1),allowEdgeTo:2503},'the island leg is unchanged');
eq(hollowsOutLeg(2507),{points:[...HOLLOWS_OUT_POINTS.slice(1,4),...HOLLOWS_NORTH_POINTS],allowEdgeTo:2507},'the 2507 leg');
assert.throws(()=>hollowsOutLeg(2501),/hollows_exit_not_on_upper_shelf_2501/);passed++;

// 6. The entry helper: already there, wrong start, and the admitted transit it delegates to.
const ctxIn=room=>({agent:'a',state:{},call:async name=>name==='look'?{room:{num:room},you:{row:30,col:45,x:2912,y:1952},hp:{value:50,max:50}}:{}});
eq(await enterGrogsAntechamber(ctxIn(GROG_ANTECHAMBER),{transit:()=>{throw Error('no transit');}}),{ok:true,already:true},'already in 2507');
await assert.rejects(enterGrogsAntechamber(ctxIn(2500),{transit:async()=>({})}),/requires_room_2501_or_2502_not_2500/);passed++;
let asked=null;
const r=await enterGrogsAntechamber(ctxIn(2502),{budgetMs:1234,transit:async(ctx,o)=>{asked=o;return {enter:{ok:true},leave:{ok:true}};}});
eq([r.ok,asked.from,asked.to,asked.room,asked.budgetMs],[true,2501,2507,2502,1234],'one admitted 2502 transit, leaving for 2507');

console.log(`m59-hollows-north-test: ${passed} passed`);
