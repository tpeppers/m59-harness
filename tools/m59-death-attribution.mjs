// Pure, shared death evidence interpretation. Nearby players are identity/context,
// never evidence that they struck the killing blow.
const FORMS=[
  {re:/^###\s+(.+?)\s+was just killed by\s+(?:an?\s+|the\s+)?(.+?)\.?$/i,how:'killed',killer:2},
  {re:/^###\s+The notorious murderer,\s*(.+?),\s*has been killed by\s+(?:an?\s+|the\s+)?(.+?)\.?$/i,how:'killed as a murderer',killer:2},
  {re:/^###\s+The feared outlaw,\s*(.+?),\s*has just met justice at\s+(?:an?\s+|the\s+)?(.+?)'s hands\.?$/i,how:'killed as an outlaw',killer:2},
  {re:/^###\s+(.+?)\s+has been murdered in cold blood\.?$/i,how:'murdered by a player'},
  {re:/^###\s+(.+?)\s+was just slain by\s+\S+\s+own folly\.?$/i,how:'own folly'},
  {re:/^###\s+(.+?)\s+met an untimely end\.?$/i,how:'the room itself'},
];
export function parseDeathBroadcast(text) {
  const t=String(text??'').trim();
  for(const f of FORMS){const m=f.re.exec(t);if(m)return {who:m[1].trim(),killer:f.killer?m[f.killer].trim():null,how:f.how,text:t};}
  return null;
}
export function parsePersonalDeathMessage(text) {
  const m=/^You are dead, poor soul\.\s+Go now, and take revenge on (.+)!$/i.exec(String(text??'').trim());
  if(!m)return null;
  const raw=m[1].trim();
  return {raw_killer:raw,killer:raw.replace(/^(?:an?|the)\s+/i,''),text:String(text).trim()};
}
const norm=x=>String(x??'').trim().toLowerCase();
const serverMessage=e=>e&&(!e.kind||e.kind==='message');
const knownTime=x=>Number.isFinite(x);
function broadcastFor(pm) {
  const who=pm.character,stored=pm.killed_by_broadcast;
  if(stored&&(!who||!stored.who||norm(stored.who)===norm(who)))return stored;
  const at=pm.summary?.at??pm.at,candidates=[];
  for(const e of pm.text??[]) {
    if(!serverMessage(e))continue;const b=parseDeathBroadcast(e.text);
    if(!b||!who||norm(b.who)!==norm(who)||!knownTime(at)||!knownTime(e.at)||Math.abs(e.at-at)>30000)continue;
    candidates.push({...b,at:e.at,source:'retained_server_text'});
  }
  candidates.sort((a,b)=>Math.abs(a.at-at)-Math.abs(b.at-at));return candidates[0]??null;
}
export function attributeDeath(pm = {}) {
  const b=broadcastFor(pm),deathAt=pm.summary?.at??pm.at;
  // Pair the victim-only message with this death's announcement, not an old
  // revenge line elsewhere in the buffer. Without an announcement use death time.
  const anchor=knownTime(b?.at)?b.at:deathAt;
  const personals=(pm.text??[]).filter(serverMessage).map(e=>{
    const p=parsePersonalDeathMessage(e.text);
    return p&&knownTime(e.at)&&knownTime(anchor)&&Math.abs(e.at-anchor)<=5000?{...p,at:e.at}:null;
  }).filter(Boolean).sort((a,c)=>Math.abs(a.at-anchor)-Math.abs(c.at-anchor));
  const personal=personals[0]??null,murder=b?.how==='murdered by a player';
  const environment=b?.how==='the room itself',self=b?.how==='own folly';
  const personalName=personal?(murder?personal.raw_killer:personal.killer):null;
  // user.kod deliberately gives the victim GetTrueName, even when the public
  // announcement uses a morphed identity. Preserve that distinction as evidence.
  const identityDiffers=!!(b?.killer&&personalName&&norm(b.killer)!==norm(personalName));
  let killer=personalName??b?.killer;
  // An explicit nameless environmental/self death must not acquire a culprit.
  if(environment||self)killer=null;
  const evidence=[];
  if(b)evidence.push({source:'death_broadcast',text:b.text??null,at:b.at??null,who:b.who??pm.character,how:b.how,killer:b.killer??null});
  if(personal)evidence.push({source:'personal_death_message',text:personal.text,at:personal.at,killer:personalName});
  const observed=!!killer,causeObserved=!!b||observed;
  const playerIdentity=!!killer&&(pm.threats?.players_present??[]).some(n=>norm(n)===norm(killer));
  const playerKill=murder||playerIdentity?true:environment||self?false:identityDiffers?null:
    killer?!/(?:killed by|at)\s+(?:an?|the)\s/i.test(b?.text??'')&&!/^(?:an?|the)\s/i.test(personal?.raw_killer??''):null;
  const playerObserved=murder||playerIdentity||environment||self;
  const base={schema:'m59-death-attribution/v1',killer:killer??null,observed,cause_observed:causeObserved,
    how:b?.how??(observed?'killed':null),
    kind:murder?'player_murder':environment?'environment':self?'self_inflicted':playerIdentity?'player_kill':killer?'named_kill':'unknown',
    was_killed_by_player:playerKill,killed_by_player_is_a_guess:playerKill!=null&&!playerObserved,
    evidence,conflict:false,broadcast_identity_differs:identityDiffers,said:b?.text??personal?.text??null,
    why:personalName&&killer?'the victim-only server death message names the killer':
      b?.killer?'the server announced the killer':murder?'the server confirmed player murder but did not name the killer':
      b?'the server announced the cause of death':null};
  if(causeObserved)return base;
  const crowd=pm.summary?.was_nearby??pm.threats?.present_at_the_end??pm.summary?.killed_by??[];
  const tally=new Map();for(const name of crowd)tally.set(name,(tally.get(name)??0)+1);
  const guess=[...tally].sort((a,c)=>c[1]-a[1])[0]?.[0]??null;
  return {...base,killer:guess,crowd,why:guess?
    'no server death evidence — this is only the commonest thing standing nearby, which matches the real killer about half the time':
    'no server death evidence reached us and nothing was in view at the end'};
}
export function deathCauseLabel(cause) {
  if(cause.killer)return cause.killer;
  if(cause.kind==='player_murder')return 'Unnamed player (murder)';
  if(cause.kind==='environment')return 'Environment';
  if(cause.kind==='self_inflicted')return 'Own folly';
  return 'Unattributed';
}
// Raw broadcasts/text are preserved; derived fields share one interpretation.
export function applyDeathAttribution(pm) {
  const a=attributeDeath(pm);pm.death_attribution=a;
  const summary=pm.summary??={};
  if(a.cause_observed) {
    summary.was_nearby??=summary.killed_by??pm.threats?.present_at_the_end??[];
    summary.killed_by=a.killer?[a.killer]:[];
    summary.killed_by_is_a_guess=false;summary.how_died=a.how;summary.death_kind=a.kind;
    summary.note_killer=a.why;
    summary.was_killed_by_player=a.was_killed_by_player;
    summary.killed_by_player_is_a_guess=a.killed_by_player_is_a_guess;
  }
  return pm;
}
