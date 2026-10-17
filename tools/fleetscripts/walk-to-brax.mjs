import {verify} from '../m59-fleetscript.mjs';
import {runBrax,ensureBraxApproach} from '../m59-brax.mjs';
import {prepareBraxGroup} from '../m59-brax-staging.mjs';
import {asAgents} from '../m59-fleetlib.mjs';

export const script={
  name:'walk-to-brax',
  provenance:{pinned:'b1af6975',verified:'2026-10-14',touches:['tools/m59-brax.mjs','tools/m59-moving-platform.mjs','tools/m59-railfollow.mjs','tools/m59-fineclimb.mjs','tools/m59-falljump.mjs','tools/m59-keeper-process.mjs'],refuseOnDrift:false},
  describe:'Walk groups of up to 25 through the Ancient Place lift and Winding Caverns to the Ancient Graveyard of Brax (827).',
  recipe:{
    effect:'Uses the mana-node cliff climb, two declared falls, the five platform levers, and the legal eastern Cragged Mountains route.',
    run:'walk-to-brax agents=a,b,c',
    needs:['keeper processes','running vigor','the tested Ancient Place movement geometry'],
    cost:{time:'road and cliff climb, a gathering window extended by new arrivals, capped at three minutes, then a 37.667-second lift ascent',risk:'hostile mountain and cavern creatures'},
    notes:['Arrival means alive in room 827. Each member has its own receipt.',
      'New arrivals extend gathering by up to 60 seconds, with a three-minute cap; a fully boarded requested cohort departs immediately. The center lever is pulled once; corner work is divided between members.',
      'The lift validates server-observed heights before the north fall. No administrative movement occurs in this script.'],
  },
  params:{agents:{type:'agents',required:true},minHealth:{type:'number',default:0.9},
    fragileBelow:{type:'number',default:1}},
  async steps({agents}){
    const members=asAgents(agents);
    if(!members.length||members.length>25||new Set(members).size!==members.length)throw Error('walk-to-brax needs 1..25 distinct characters');
    const approachFile=ensureBraxApproach();
    return [verify(ctx=>prepareBraxGroup(ctx,members,{approachFile}),'Brax crowd staging failed'),verify(ctx=>runBrax(ctx,{approachFile,expectedAgents:ctx.state.braxExpectedLiftAgents??members}),'Brax entry did not reach the Ancient Graveyard')];
  },
};
