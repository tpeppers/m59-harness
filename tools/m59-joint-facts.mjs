// THE FACTS A JOINT IS ASKED WITH, built one way for every call site.
//
// A pak's conditions read `self.health_pct`, `self.resist.fire`, `self.curse.state`. If the movement call
// site built `self` one way and the combat call site another, the same rule would mean two things. So the
// keeper's call sites ask here, and everything here is read through tools/rpg/ from the session's own
// client -- never from a status cache, which on a keeper-backed character is a rebuilt snapshot.
//
// Cheap and synchronous: a joint is asked on a step or a blow.
import { sheetOf } from './rpg/sheet.mjs';
import { crossingCost } from './rpg/hazards.mjs';
import { channelsOf } from './rpg/channels.mjs';
import { pvpAllowedHere } from './m59-pvp-rooms.mjs';

/** The character sheet for a session, with what only its keeper knows. */
export function selfFacts(session, { keeper = null, now = Date.now() } = {}) {
  const c = session?.client;
  const k = keeper ?? safe(() => session?.combat?.keeper?.()) ?? null;
  const heard = (k?.recent5 ?? k?.recentLines ?? []).slice?.(-20)?.map?.(l => ({ text: l?.text ?? String(l ?? ''), at: l?.at ?? null })) ?? [];
  const sheet = sheetOf(c, { now, curseSuspect: k?._curseSuspect ?? null, heard });
  return { ...sheet, name: c?.me?.name ?? session?.name ?? null,
    karma: (() => { const k = safe(() => c?.stat?.('karma')); return k == null || k === '' ? null : Number(k); })(),
    row: c?.self?.row ?? null, col: c?.self?.col ?? null };
}

export function roomFacts(session) {
  const room = session?.world?.room?.num ?? null;
  const policy = safe(() => session?.combat?.keeper?.()?.policy) ?? null;
  return { room, pvp_allowed_here: policy ? safe(() => pvpAllowedHere(policy, room)) ?? null : null };
}

/** movement.hazard */
export function hazardFacts(session, effect, purpose, from = null, to = null) {
  const self = selfFacts(session);
  return { ...roomFacts(session), purpose, effect: { ...effect }, from: point(from), to: point(to), self,
    hazard: crossingCost(effect, self) };
}

/** combat.blocked / combat.channel */
export function fightFacts(session, o, target, extra = {}) {
  const c = session?.client, me = c?.self;
  const self = selfFacts(session);
  const t = target ? { id: target.id, name: String(c?.rsc?.get?.(target.nameRsc) ?? target.name ?? o?.targetName ?? ''),
    row: target.row, col: target.col, distance: me ? Math.hypot(target.row - me.row, target.col - me.col) : null,
    player: !!(target.flags & 4) } : null;
  return { ...roomFacts(session), target: t, pvp: !!o?.pvp, self, channels: safe(() => channelsOf(c)) ?? [], ...extra };
}

const point = p => p ? { row: p.row ?? null, col: p.col ?? null } : null;
function safe(f) { try { return f(); } catch { return null; } }
