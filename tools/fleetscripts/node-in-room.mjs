// Meld a promoted node from INSIDE its room: cut to the stone's measured rail, follow it, meld, cut back to the
// room's entrance. For a character already posted in the stone's room (a farmer), where the full get-all-nodes
// circuit would mean a trip to room 2 and back. See inRoomNodePlan in m59-node-tour.mjs for which stones qualify.
//
//   node-in-room agents=t8 node=badlands expectedGame=<host:port>    (required on a remote server: fineclimb refuses
//                                                                    remote_requires_exact_expected_game without it)
//
// Operator, 2026-10-19: "go get the node, on each character in that room". One character at a time; the
// receipt (melded / already) is written to substrate/node-tours/ and to the character's node memory.
import {act,verify} from '../m59-fleetscript.mjs';
import {asAgents} from '../m59-fleetlib.mjs';
import {runTour,inRoomNodePlan} from '../m59-node-tour.mjs';

export const script={
  name:'node-in-room',
  describe:"From inside a promoted stone's room: rail to the stone, meld (or read 'already bonded'), back to the entrance",
  recipe:{run:'node-in-room agents=<a> node=badlands expectedGame=<host:port>',
    needs:['the character already standing in the stone\'s room, on its common floor']},
  params:{agents:{type:'agents',required:true},node:{type:'string',required:true,describe:'badlands'},
    expectedGame:{type:'string'},railFile:{type:'string',default:'substrate/node-tour-rails.json'},
    evidenceDir:{type:'string',default:'substrate/node-tours'}},
  async steps(params){
    if(asAgents(params.agents).length!==1)throw Error('node-in-room takes one character at a time');
    const node=String(params.node??'').toLowerCase();
    inRoomNodePlan(node);   // refuses an unsupported stone at load, before anything walks
    return [
      act('rest',{stand:true}),
      verify(async ctx=>{
        try{const ok=await runTour(ctx,{...params,node:undefined,inRoom:node});ctx.state.nodeInRoom=ctx.state.tour;return ok;}
        catch(e){console.error('NODE IN ROOM: '+e.message);return false;}
      },'in-room node run stopped; inspect the receipt in substrate/node-tours'),
    ];
  },
};
