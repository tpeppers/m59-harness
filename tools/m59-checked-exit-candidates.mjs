import{edgeCandidatesOf}from'./m59-map.mjs';import{squareCentreClient,clientToProtocol}from'./m59-finepos.mjs';import{spreadEdges}from'./m59-world.mjs';
// A checked fine leg names the physical boundary, not the coarse boarding anchor.
export function checkedExitCandidates(session,to){const room=session.world?.map?.rooms?.[session.world?.room?.num];if(!room)return spreadEdges(session.world.exits().filter(e=>e.to===to));
 const edges=(room.edgeExits??[]).filter(e=>e.to===to).flatMap(e=>edgeCandidatesOf(room,e).filter(c=>c.fine_stand_on&&c.edge_target).map(c=>({kind:'edge',direction:e.leaveName,to,stand_on:{row:c.row,col:c.col},fine_stand_on:c.fine_stand_on,edge_target:c.edge_target})));
 const doors=(room.goExits??[]).filter(e=>e.to===to&&!e.locked).map(e=>({kind:'go',to,locked:e.locked,stand_on:{row:e.row,col:e.col},fine_stand_on:clientToProtocol(squareCentreClient(e.row,e.col))}));return[...edges,...doors];}
