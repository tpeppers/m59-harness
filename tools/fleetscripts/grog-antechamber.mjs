// #movement: into Grog's Antechamber (2507) over the Archaic Hollows' north edge.
//
// orccave3.kod:68 is the only cave-side door: 2502 LEAVE_NORTH -> RID_ORC_PIT_A, landing r164c25.
// That edge is on the Hollows' upper shelf (floor 9600), which the lower Hollows cannot climb to,
// so `travel 2507` from the lower body bounces and gives up after 25 hops (Zoot, 2026-11-14).
// This walks the island's admitted Hollows transit instead and turns north at the upper passage:
// see enterGrogsAntechamber in tools/m59-island-route.mjs and HOLLOWS_NORTH_POINTS in
// tools/m59-island-finewalk.mjs. The declared crossing needs running vigor (12+).
//
// Inside 2507 the corridor from the south edge reaches the chamber only through a ceiling-lift
// door at r92 that a `go` from r93c24-26 opens for 60 s (orcpita.kod:76-85); this script stops at
// the room boundary and does not operate it.
import {act,verify,walk} from '../m59-fleetscript.mjs';
import {enterGrogsAntechamber,GROG_ANTECHAMBER} from '../m59-island-route.mjs';
export const script={name:'grog-antechamber',
  describe:"Walk from the Orc Caves into Grog's Antechamber (2507) over the Archaic Hollows' north edge",
  params:{agents:{type:'agents',required:true},budgetMs:{type:'number',default:240000}},
  async steps(p){
    return [act('rest',{stand:true}),
      walk(st=>[2502,GROG_ANTECHAMBER].includes(st.startRoom)?st.startRoom:2501,
        {candidates:[2501,2502,GROG_ANTECHAMBER],why:'the Hollows transit starts in 2501 or 2502'}),
      verify(async ctx=>enterGrogsAntechamber(ctx,{budgetMs:p.budgetMs}),"Grog's Antechamber transit failed; read islandFineFailure"),
      verify(async ctx=>(await ctx.call('look',{agent:ctx.agent}))?.room?.num===GROG_ANTECHAMBER,"not in Grog's Antechamber")];
  }};
