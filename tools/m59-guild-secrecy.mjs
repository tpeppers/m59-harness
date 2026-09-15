// The guild invite dialog reads current_room->contents (guildinv.c).
// Refresh that server list, retaining invisible OF_PLAYER objects. Never send INVITE.
import { AsyncLocalStorage } from 'node:async_hooks';
import { OF } from './m59-parse.mjs';
import { isFleetmate } from './m59-party.mjs';

export const NORTH_BARLOQUE = 101;
const scope = new AsyncLocalStorage();
export function guildInviteOutsiders(c, players = [...c.room.objects.values()], ours = isFleetmate) {
  return players.filter(p => (p.flags & OF.PLAYER) && p.id !== c.selfId && p.id !== c.me?.id)
    .filter(p => !ours(p.name ?? c.rsc.get(p.nameRsc)))
    .map(p => ({ id: p.id, name: p.name ?? c.rsc.get(p.nameRsc) ?? null }));
}

export async function readGuildInviteList(s) {
  const c = s.need(), room = c.room.id, since = c.evSeq;
  const request = await s.pacer.submit('read', () => c.roomContents());
  let cursor = since;
  const end = Date.now() + 3500;
  while (Date.now() < end) {
    const r = await c.waitFor({ since: cursor, kinds: ['room-contents'], timeoutMs: Math.max(1, end - Date.now()) });
    const reply = r.events?.find(e => e.request === request && e.room === room && Array.isArray(e.players));
    if (reply && c.room.id === room) return { known: true, room, request, players: reply.players.length,
      outsiders: guildInviteOutsiders(c, reply.players).concat(guildInviteOutsiders(c)) };
    if (!r.events?.length || c.room.id !== room) break;
    cursor = r.seq ?? Math.max(...r.events.map(e => e.seq));
  }
  // An uncorrelated/old read never certifies secrecy. No ordinal retirement here.
  return { known: false, room, outsiders: [] };
}

// Scoped to this async errand: survival actions running alongside it keep their
// movement. Read BEFORE queueing a mutation, then recheck pushed arrivals at send.
export async function withGuildSecrecy(k, cfg, run) {
  const s = k.s, c = s.need(), pacer = s.pacer, original = pacer.submit;
  const previousEvent = c.onEvent;
  const guard = {
    blocked: null,
    active: () => k.coopVisit && k.coopVisit.stage !== 'return' &&
      [NORTH_BARLOQUE, cfg.hall_room].includes(Number(s.world?.room?.num)),
    fail(reason) { this.blocked ??= reason; throw new Error(this.blocked); },
    assert() {
      if (!this.active()) return;
      if (this.blocked) throw new Error(this.blocked);
      if (guildInviteOutsiders(c).length) this.fail('guild secrecy: non-fleet player present');
    },
    async fresh() {
      if (!this.active()) return;
      this.assert();
      const reading = await readGuildInviteList(s);
      if (!reading.known) this.fail('guild secrecy: fresh invite list unavailable');
      if (reading.outsiders.length) this.fail('guild secrecy: non-fleet player present');
      this.assert();
      if (this.lastRoom !== reading.room) {
        this.lastRoom = reading.room;
        k.note('guild invite list checked', { room: Number(s.world?.room?.num),
          players: reading.players, outsiders: 0, request: reading.request, includes_invisible: true });
      }
    },
  };
  const wrapped = async function(kind, action, ...rest) {
    if (scope.getStore() !== guard || !guard.active() || !['move', 'say', 'trade'].includes(kind))
      return original.call(this, kind, action, ...rest);
    await guard.fresh();
    return original.call(this, kind, () => { guard.assert(); return action(); }, ...rest);
  };
  const observe = e => {
    previousEvent?.(e);
    if (guard.active() && ['appeared', 'changed', 'room-contents'].includes(e.kind)) {
      try { guard.assert(); } catch { /* latched; the executing step unwinds next */ }
    }
  };
  pacer.submit = wrapped; c.onEvent = observe; k.coopSecrecy = guard;
  try { return await scope.run(guard, run); }
  finally {
    if (pacer.submit === wrapped) pacer.submit = original;
    if (c.onEvent === observe) c.onEvent = previousEvent;
    k.coopSecrecy = null;
  }
}
