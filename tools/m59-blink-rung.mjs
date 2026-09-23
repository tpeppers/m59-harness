// Portable traffic escape policy. Private blink-escape strategies remain explicit
// overrides (including disabled ones); a clean checkout still has this rung.
import {canBlinkOut} from './m59-blink.mjs';

export function blinkAdmission(ctx) {
  const no = reason => ({can:false,reason});
  if (ctx.disabled) return no('disabled');
  if (!ctx.knowsBlink) return no('spell_unknown');
  if (ctx.underFire) return no('under_fire');
  const hp=ctx.vitals?.health, mana=ctx.vitals?.mana?.value, vigor=ctx.vitals?.vigor?.value;
  if (!hp?.max || hp.value/hp.max < Math.max(0.9,ctx.healthFloor??0)) return no('low_health');
  if (!(mana>=18)) return no('low_mana');
  if (!(vigor>=40)) return no('low_vigor');
  if (!(ctx.stuck_ms>=10000)) return no('jam_not_measured_long_enough');
  if (ctx.cooldown) return no('cooldown');
  if (!(ctx.room?.rows>0 && ctx.room?.cols>0)) return no('missing_room_bounds');
  if (!ctx.blink || !ctx.goal || !ctx.geo || !ctx.self) return no('missing_geometry_or_goal');
  if (ctx.self.row===ctx.blink.row && ctx.self.col===ctx.blink.col) return no('already_at_landing');
  // The flood treats its origin as free; a teleport landing must not borrow that
  // exemption for another character/monster standing there.
  if ((ctx.bodies??[]).some(b=>b.row===ctx.blink.row&&b.col===ctx.blink.col))
    return no('landing_occupied');
  return {can:true,reason:'admitted'};
}

export function chooseTrafficBlink(ctx) {
  const gate=blinkAdmission(ctx); if(!gate.can)return gate;
  const verdict=canBlinkOut({geo:ctx.geo,blink:ctx.blink,from:ctx.self,goal:ctx.goal,
    bodies:ctx.bodies,rows:ctx.room.rows,cols:ctx.room.cols,stalled:ctx.stalled});
  return {can:verdict.can,reason:verdict.can?'useful_landing':'no_reachable_gain',verdict,
    ...(verdict.can?{answer:{do:'blink',expect:ctx.blink,why:verdict.why}}:{})};
}
