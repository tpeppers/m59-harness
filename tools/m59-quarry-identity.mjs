// Object IDs are reusable handles. A pull must still name the same kind of quarry
// in the same room before it can override a freshly selected target.
export function stalePullReason(pull,{room,object,name,attackable,player,matches}={}){
 if(pull?.target_id==null)return null;
 if(pull.wall?.room!=null&&Number(pull.wall.room)!==Number(room))return 'pull belongs to another room';
 if(!object)return 'quarry is no longer present';
 if(player)return 'quarry handle now belongs to a player';
 if(!attackable)return 'quarry is no longer attackable';
 if(!name||!matches)return 'quarry handle no longer matches the pulled creature';
 return null;
}
