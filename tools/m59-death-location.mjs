import{parsePersonalDeathMessage}from'./m59-death-attribution.mjs';
// Socket events continue while a keeper's decision frames are absent. Recover
// only an actual fatal HP push/personal death line in a known non-Underworld
// room; the last room before a blind offline gap is not a death location.
export function deathLocationFromSessions(evidence,{at=Date.now(),windowMs=5000}={}){
 const candidates=[];
 for(const session of evidence?.sessions??[])for(const event of [...(session.events??[]),...(session.fatalEvidence??[])]){
  if(!Number.isFinite(event.at)||event.at<at-windowMs||event.at>at+1000||!Number.isSafeInteger(event.room)||event.room<=1)continue;
  const fatal=event.kind==='stat'&&event.name==='health'&&event.value===0;
  const personal=event.kind==='message'&&parsePersonalDeathMessage(event.text);
  if(fatal||personal)candidates.push({num:event.room,row:event.position?.row??null,col:event.position?.col??null,source:fatal?'socket_fatal_health':'socket_personal_death',at:event.at,session_id:session.id});
 }
 const rooms=new Set(candidates.map(e=>e.num));if(rooms.size!==1)return null;
 return candidates.sort((a,b)=>b.at-a.at)[0]??null;
}
