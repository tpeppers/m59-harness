// Published openings on the same directed boundary share convoy admission.
import{edgeCandidatesOf}from'./m59-map.mjs';
export function exitConvoyBranch(map,roomNum,exit){
 const room=map?.rooms?.[roomNum];
 const edge=room?.edgeExits?.find(e=>e.to===exit.to&&edgeCandidatesOf(room,e).some(c=>c.row===exit.row&&c.col===exit.col));
 const go=room?.goExits?.find(g=>!g.locked&&g.to===exit.to&&g.row===exit.row&&g.col===exit.col);
 if(go)return['go',go.to,go.arriveRow,go.arriveCol,go.angleChange];
 return edge?['edge',edge.to,edge.leave,edge.arriveRow,edge.arriveCol,edge.condition?.type??null,edge.condition?.threshold??null]:['exit',exit.to,exit.row,exit.col];
}
