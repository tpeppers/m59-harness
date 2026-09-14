// Combat is a bounded, event-driven override in the process that owns the socket.
// No script compiler, snapshot fetch, external planner or keeper pass is on the
// arrival -> first attack path. All packets still use the ordinary server pacer.
import { randomUUID } from 'node:crypto';
import { OF } from './m59-parse.mjs';
import { withBodyCommand } from './m59-body-command.mjs';
import { withPacketScope } from './m59-packet-scope.mjs';
import { effectsAt, groundEffectSquares, groundEffectOnSegment } from './m59-ground-effects.mjs';

const demand = (ok, why) => { if (!ok) throw new Error(`combat: ${why}`); };
const square = (p, label) => {
  demand(p && Number.isSafeInteger(p.row) && p.row > 0 &&
    Number.isSafeInteger(p.col) && p.col > 0, `${label} needs positive integer row and col`);
  return { row: p.row, col: p.col };
};
const exactName = (c, o) => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').trim().toLowerCase();
const characterName = (s, c) => String(c?.me?.name ?? s.name).toLowerCase();

export function normalizeCombatOrder(input) {
  demand(input && ['attack', 'kill', 'ambush'].includes(input.action), 'action must be attack, kill or ambush');
  const keys = new Set(['agent', 'fleet_state', 'action', 'target', 'map', 'position', 'door', 'ttl_ms', 'stop_below', 'sequence', 'repeat',
    'select_map', 'command_id', 'revision']);
  demand(Object.keys(input).every(key => keys.has(key)), 'unknown combat order option');
  if (input.action !== 'ambush') demand(input.map == null && input.position == null && input.door == null,
    'attack uses the current room; use ambush for a map and position');
  demand((typeof input.target === 'string' && input.target.trim().length > 0 && input.target.length <= 100) ||
    (Number.isSafeInteger(input.target) && input.target > 0), 'target must be an exact player name or visible object id');
  const ttl_ms = input.ttl_ms ?? null;
  demand(ttl_ms === null || (Number.isSafeInteger(ttl_ms) && ttl_ms >= 1000 && ttl_ms <= 1_800_000),
    'ttl_ms must be 1000..1800000, or omitted to wait until stopped');
  demand(input.select_map == null || (Number.isSafeInteger(input.select_map) && input.select_map > 1),
    'select_map needs a map number');
  demand(input.command_id == null || (typeof input.command_id === 'string' && /^[\w-]{1,100}$/.test(input.command_id)),
    'invalid command_id');
  demand(input.revision == null || (Number.isSafeInteger(input.revision) && input.revision > 0), 'invalid revision');
  const stop_below = input.stop_below ?? 0.35;
  demand(Number.isFinite(stop_below) && stop_below >= 0.05 && stop_below <= 0.95,
    'stop_below must be a fraction from 0.05 through 0.95');
  const sequence = input.sequence ?? [{ do: 'attack', swings: 1 }];
  demand(Array.isArray(sequence) && sequence.length > 0 && sequence.length <= 16, 'sequence needs 1..16 actions');
  const actions = sequence.map(step => {
    demand(step && ['attack', 'cast', 'wait'].includes(step.do), 'sequence verbs are attack, cast, wait');
    if (step.do === 'attack') {
      const swings = step.swings ?? 1;
      demand(Number.isSafeInteger(swings) && swings >= 1 && swings <= 20, 'swings must be 1..20');
      return { do: 'attack', swings };
    }
    if (step.do === 'wait') {
      demand(Number.isSafeInteger(step.ms) && step.ms >= 0 && step.ms <= 10_000, 'wait ms must be 0..10000');
      return { do: 'wait', ms: step.ms };
    }
    demand(typeof step.spell === 'string' && step.spell.trim(), 'cast needs an exact known spell name');
    demand(['target', 'self', 'none'].includes(step.target ?? 'target'), 'cast target must be target, self or none');
    const hold_ms = step.hold_ms ?? 1000;
    demand(Number.isSafeInteger(hold_ms) && hold_ms >= 1000 && hold_ms <= 60000,
      'cast hold_ms must be 1000..60000');
    return { do: 'cast', spell: step.spell.trim(), target: step.target ?? 'target', hold_ms };
  });
  demand(actions.some(s => s.do !== 'wait'), 'sequence must contain an attack or cast');
  demand(input.repeat == null || typeof input.repeat === 'boolean', 'repeat must be boolean');
  const order = { action: input.action, target: typeof input.target === 'string' ? input.target.trim() : input.target,
    ttl_ms, stop_below, sequence: actions, repeat: input.repeat ?? true };
  if (input.action === 'ambush') {
    demand(Number.isSafeInteger(input.map) && input.map > 1, 'ambush needs a map number, not a room object id');
    demand(typeof order.target === 'string', 'ambush needs a player name that survives room changes');
    order.map = input.map;
    order.position = square(input.position, 'ambush position');
    if (input.door != null) {
      order.door = square(input.door, 'door arrival area');
      order.door.radius = input.door.radius ?? 1;
      demand(Number.isFinite(order.door.radius) && order.door.radius >= 0 && order.door.radius <= 5,
        'door radius must be 0..5 squares');
    }
  }
  return order;
}

export function combatTarget(client, target) {
  const players = [...client.room.objects.values()].filter(o => o.id !== client.selfId && (o.flags & OF.PLAYER));
  const matches = players.filter(o => typeof target === 'number' ? o.id === target : exactName(client, o) === target.toLowerCase());
  demand(matches.length <= 1, 'player identity is ambiguous');
  return matches[0] ?? null;
}

// One short ordinary move, then re-evaluate the live hazard and target. Never
// loosen BSP collision or choose a dangerous destination to escape a hazard.
export function safeCombatStep(session, destination) {
  const c = session.client, geo = session.world?.geometry, me = c?.self;
  if (!me || !geo) return null;
  const avoid = groundEffectSquares(c);
  const goals = [];
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const row = destination.row + dr, col = destination.col + dc;
    if (destination.exact && (dr || dc)) continue;
    if (!destination.exact && Math.hypot(dr, dc) > 2) continue;
    if (row < 1 || col < 1 || row > geo.rows || col > geo.cols || avoid.has(`${row},${col}`)) continue;
    if (!geo.standable(row, col)) continue;
    goals.push({ row, col, distance: Math.hypot(row - me.row, col - me.col) });
  }
  goals.sort((a, b) => a.distance - b.distance);
  for (const goal of goals) {
    const path = geo.path(me.row, me.col, goal.row, goal.col, { avoid });
    const next = path?.steps?.find(p => p.row !== me.row || p.col !== me.col);
    if (path?.found && next && !avoid.has(`${next.row},${next.col}`)) return next;
  }
  return null;
}

export async function escapeGroundEffect(session) {
  const c = session.client;
  const hazards = effectsAt(c, c?.self);
  if (!hazards.length) return false;
  const geo = session.world?.geometry, me = c.self;
  const candidates = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const point = { row: me.row + dr, col: me.col + dc };
    if (!geo?.standable(point.row, point.col) || groundEffectOnSegment(c, me, point)) continue;
    candidates.push({ ...point, distance: hazards.reduce((sum, e) => sum + Math.hypot(e.row - point.row, e.col - point.col), 0) });
  }
  candidates.sort((a, b) => b.distance - a.distance);
  if (candidates.length) await session.pacer.submit('rest', () => c.stand());
  for (const next of candidates) {
    const before = { row: c.self.row, col: c.self.col };
    await session.step(next.col, next.row);
    if (c.self.row !== before.row || c.self.col !== before.col) return true;
  }
  return false;
}

export class CombatMode {
  constructor(session, { keeper = () => null, now = Date.now, schedule = setTimeout, unschedule = clearTimeout } = {}) {
    this.s = session; this.keeper = keeper; this.now = now;
    this.schedule = schedule; this.unschedule = unschedule;
    this.active = null; this.last = null; this.timer = null;
    this.revision = 0; this.cancelled = new Set(); this.safetyLease = null; this.safetyRequest = null;
  }

  status() {
    const o = this.active ?? this.last;
    if (!o) return { active: false };
    return { active: !!this.active, order_id: o.id, action: o.order.action,
      target: o.order.target, map: o.order.map ?? o.room, position: o.order.position,
      door: o.order.door, phase: o.phase, accepted_at: o.acceptedAt,
      armed_at: o.armedAt ?? null, triggered_at: o.triggeredAt ?? null,
      first_packet_at: o.firstPacketAt ?? null, first_attack_at: o.firstAttackAt ?? null,
      reaction_ms: o.reactionMs ?? null,
      safety_on: !!(o.client.self?.flags & OF.SAFETY),
      safety_restore_pending: !!this.safetyLease,
      safety_restore_error: this.safetyRestoreError ?? null,
      last_outcome: o.lastOutcome ?? null,
      expires_at: o.expiresAt, finished_at: o.finishedAt ?? null,
      reason: o.reason ?? null, attacks: o.attacks, casts: o.casts };
  }

  issue(input) {
    if (input.select_map != null && ['ready', 'status', 'stop'].includes(input.action) &&
        this.s.world?.room?.num !== input.select_map)
      return { skipped: true, reason: 'outside assigned map', map: this.s.world?.room?.num ?? null };
    if (input.action === 'ready') return { ready: true, combat_mode: 2, in_game: !!this.s.live,
      map: this.s.world?.room?.num ?? null, combat: this.status() };
    if (input.action === 'status') return { ...this.status(),
      ...(input.order_id ? { order_matches: this.status().order_id === input.order_id } : {}) };
    if (input.action === 'stop') {
      // A scoped stop can beat the original POST. Remember it without revoking
      // unrelated newer commands; late delivery must never resurrect this order.
      if (input.order_id) {
        this.cancelled.add(input.order_id);
        if (this.cancelled.size > 1024) this.cancelled.delete(this.cancelled.values().next().value);
      } else if (input.revision) {
        if (input.revision < this.revision) return { stopped: false, reason: 'superseded stop', ...this.status() };
        this.revision = input.revision;
      }
      if (input.order_id && input.order_id !== this.active?.id)
        return { stopped: false, reason: 'order was already replaced', ...this.status() };
      this.stop('operator stopped combat');
      return this.status();
    }
    // Validate completely before replacing the current order.
    const order = normalizeCombatOrder(input), s = this.s, c = s.need();
    if (input.command_id && this.cancelled.has(input.command_id))
      return { accepted: false, skipped: true, reason: 'command already stopped' };
    if (input.command_id && input.command_id === this.active?.id) return { accepted: true, ...this.status() };
    if (input.revision && input.revision <= this.revision)
      return { accepted: false, skipped: true, reason: 'superseded command' };
    demand(c.self && s.world?.room?.num > 1, 'live player and map identity required');
    if (input.select_map != null && s.world.room.num !== input.select_map)
      return { accepted: false, skipped: true, reason: 'outside assigned map', map: s.world.room.num };
    const target = combatTarget(c, order.target);
    if (typeof order.target === 'number') demand(target && (target.flags & OF.ATTACKABLE),
      'exact player is not here or not attackable; use a player name to wait');
    const keeper = this.keeper();
    const confine = keeper?.policy?.confineRooms ?? [];
    if (order.map) {
      demand(!confine.length || confine.map(Number).includes(order.map), 'ambush map is outside confinement');
      const map = s.world.map?.rooms?.[String(order.map)];
      demand(map && order.position.row <= map.rows && order.position.col <= map.cols, 'ambush position is outside the known map');
    }
    for (const step of order.sequence) if (step.do === 'cast')
      demand((c.spells ?? []).some(sp => exactName(c, sp) === step.spell.toLowerCase()), `spell is not known: ${step.spell}`);
    demand(this.healthOK(order), 'health is unknown or at/below the survival floor');
    if (input.revision) this.revision = input.revision;
    this.stop('replaced by a newer combat order');
    s.combatEpoch = (s.combatEpoch ?? 0) + 1;
    s.fightGeneration = (s.fightGeneration ?? 0) + 1;
    s.cancelMovement(null, 'combat override accepted');
    s._router?.clear?.();
    // The old job retains its own completion promise. It no longer owns the body.
    if (s.job && !s.job.done) { s.job.cancelled = true; s.job.done = true; s.job.finishedAt = this.now(); }
    if (keeper) {
      keeper.suspendedJourney = null;
      keeper.revive?.('combat override accepted');
    }
    const acceptedAt = this.now();
    const visible = target && (target.flags & OF.ATTACKABLE);
    const o = this.active = { id: input.command_id ?? randomUUID(), order, acceptedAt,
      expiresAt: order.ttl_ms == null ? null : acceptedAt + order.ttl_ms,
      client: c, playerId: c.selfId, room: s.world.room.num, roomObject: c.room.id,
      phase: order.action === 'ambush' ? 'positioning' : visible ? 'engaging' : 'waiting',
      phaseRevision: 0,
      targetId: target?.id ?? null, targetName: target ? exactName(c, target) : null,
      attacks: 0, casts: 0, index: 0, remaining: order.sequence[0].swings ?? 1, nextAt: 0, running: false };
    this.record('accepted', o);
    s.pacer.wake?.();
    this.wake();
    return { accepted: true, ...this.status() };
  }

  healthOK(order) {
    const v = this.s.client?.vitals?.()?.health, max = v?.max ?? v?.scale_max;
    const keeper = this.keeper();
    const computedFloor = keeper?.safety?.()?.fleeAt ?? keeper?._wdHost?.safety?.()?.fleeAt;
    const keeperFloor = Number.isFinite(computedFloor) ? computedFloor : keeper?.policy?.fleeBelow;
    const floor = Math.max(order.stop_below, Number.isFinite(keeperFloor) ? keeperFloor : 0);
    return Number.isFinite(v?.value) && Number.isFinite(max) && max > 0 && v.value / max > floor;
  }

  guard(o, kind = 'read') {
    demand(this.active === o, 'order cancelled or replaced');
    demand(this.s.client === o.client && o.client.selfId === o.playerId && this.s.live,
      'connection or character identity changed');
    demand(o.expiresAt == null || this.now() < o.expiresAt, 'order expired');
    demand(!(o.client.lastRxAt > 0 && this.now() - o.client.lastRxAt > 45000),
      'connection stale: no server data for 45 seconds');
    demand(this.healthOK(o.order) && this.s.world?.room?.num > 1, 'survival floor reached');
    if (o.phase !== 'positioning') demand(o.client.room.id === o.roomObject &&
      this.s.world.room.num === o.room, 'left the combat room');
    if (o.phase === 'armed') demand(o.client.self?.row === o.order.position.row &&
      o.client.self?.col === o.order.position.col, 'ambush position changed');
    if (o.phase === 'engaging' && ['attack', 'turn', 'cast'].includes(kind)) {
      const t = o.client.room.objects.get(o.targetId);
      demand(t && t.id !== o.playerId && (t.flags & OF.PLAYER) && (t.flags & OF.ATTACKABLE) &&
        exactName(o.client, t) === o.targetName, 'target left or identity changed');
    }
  }

  event(ev) {
    const requested = this.safetyRequest;
    if (requested && ev.kind === 'changed' && ev.id === requested.playerId &&
        requested.client === this.s.client && !!(requested.client.self?.flags & OF.SAFETY) === requested.on)
      this.safetyRequest = null;
    const o = this.active;
    if (!o) { void this.restoreSafety(); return; }
    // Only a real CREATE after arming counts as an entry. A refresh, or somebody
    // already standing in the room when the ambush was armed, does not.
    if (ev.kind === 'message' && ev.text && o.phase === 'engaging') {
      if (/good thing your safety was on|cannot attack|can't attack|can't bring yourself to attack/i.test(ev.text)) {
        o.lastOutcome = { at: this.now(), text: ev.text, kind: 'refused' };
        this.stop(`server refused combat: ${ev.text}`); return;
      }
      if (/your .* (hits|misses) |out of range/i.test(ev.text))
        o.lastOutcome = { at: this.now(), text: ev.text, kind: 'server_message' };
    }
    if (o.phase === 'armed' && ev.kind === 'appeared') {
      let target;
      try { this.guard(o); target = combatTarget(o.client, o.order.target); }
      catch (e) { this.stop(e.message); return; }
      const door = o.order.door;
      if (target?.id === ev.id && (!door || Math.hypot(target.row - door.row, target.col - door.col) <= door.radius)) {
        o.targetId = target.id; o.targetName = exactName(o.client, target);
        o.triggeredAt = this.now(); o.phase = 'engaging'; this.record('triggered', o);
      }
    }
    if (['appeared', 'vanished', 'changed', 'player-moved', 'moved', 'room-entered', 'room-contents', 'stat', 'disconnected'].includes(ev.kind)) {
      try { this.guard(o); this.refreshTarget(o); } catch (e) { this.stop(e.message); return; }
      this.wake();
    }
  }

  wake() {
    if (!this.active) return;
    if (this.timer) this.unschedule(this.timer);
    this.timer = this.schedule(() => { this.timer = null; void this.tick(); }, 0);
    this.timer?.unref?.();
  }

  stop(reason) {
    const o = this.active;
    if (!o) return;
    withBodyCommand(this.s, () => this.s.cancelMovement(null, `combat: ${reason}`), o.id);
    this.active = null; this.s.combatEpoch = (this.s.combatEpoch ?? 0) + 1;
    this.s.pacer.wake?.();
    if (this.timer) this.unschedule(this.timer);
    this.timer = null;
    o.phase = 'finished'; o.reason = reason; o.finishedAt = this.now(); this.last = o;
    this.record('finished', o);
    // Cleanup has its own fresh packet scope, not the cancelled combat guard.
    void this.restoreSafety().catch(() => {});
  }

  refreshTarget(o) {
    if (!['waiting', 'engaging'].includes(o.phase)) return;
    const t = combatTarget(o.client, o.order.target);
    const visible = t && (t.flags & OF.ATTACKABLE);
    if (visible && o.phase === 'engaging' && t.id === o.targetId && exactName(o.client, t) === o.targetName) return;
    if (!visible && o.phase === 'waiting') return;
    withBodyCommand(this.s, () => this.s.cancelMovement(null, 'combat visibility changed'), o.id);
    o.phaseRevision++;
    o.phase = visible ? 'engaging' : 'waiting';
    o.targetId = visible ? t.id : null; o.targetName = visible ? exactName(o.client, t) : null;
    o.index = 0; o.remaining = o.order.sequence[0].swings ?? 1; o.pendingAdvance = false;
    o.nextAt = 0; o.standing = false;
    if (visible) o.triggeredAt = this.now();
    this.record(visible ? 'visible' : 'waiting', o);
    this.s.pacer.wake?.();
    if (!visible) void this.restoreSafety().catch(() => {});
  }

  async restoreSafety() {
    const lease = this.safetyLease, s = this.s;
    if (!lease) return;
    if (!s.live) return; // Retry after reconnect; do not lose the restoration duty.
    if (s.client !== lease.client || s.client?.selfId !== lease.playerId) {
      if (characterName(s, s.client) !== lease.character) { this.safetyLease = null; return; }
      lease.client = s.client; lease.playerId = s.client.selfId;
    }
    if (this.active?.order.action === 'kill' && this.active.phase === 'engaging') return;
    if (this.restorePending?.lease === lease && this.restorePending.epoch === s.combatEpoch)
      return this.restorePending.promise;
    const owner = this.active?.id ?? 'combat-safety-restore';
    const pending = { lease, epoch: s.combatEpoch };
    this.restorePending = pending;
    pending.promise = withBodyCommand(s, () => withPacketScope(() => {
      demand(this.safetyLease === lease && s.client === lease.client && s.live &&
        s.client.selfId === lease.playerId, 'safety lease changed');
      demand(!(this.active?.order.action === 'kill' && this.active.phase === 'engaging'), 'kill resumed');
    }, () => s.pacer.submit('safety', () => {
      lease.client.safety(true);
      this.safetyRequest = { client: lease.client, playerId: lease.playerId, on: true };
      this.safetyLease = null; this.safetyRestoreError = null;
    })), owner).catch(error => { this.safetyRestoreError = error.message; }).finally(() => {
      if (this.restorePending === pending) this.restorePending = null;
    });
    return pending.promise;
  }

  async prepareSafety(o) {
    if (o.order.action !== 'kill') { await this.restoreSafety(); return; }
    if (this.safetyLease?.client !== o.client || this.safetyLease?.playerId !== o.playerId) this.safetyLease = null;
    if (this.safetyLease) return;
    const request = this.safetyRequest;
    const safetyOn = request?.client === o.client && request.playerId === o.playerId
      ? request.on : !!(o.client.self.flags & OF.SAFETY);
    if (safetyOn) await this.s.pacer.submit('safety', () => {
      o.client.safety(false);
      this.safetyRequest = { client: o.client, playerId: o.playerId, on: false };
      this.safetyLease = { client: o.client, playerId: o.playerId, character: characterName(this.s, o.client) };
      o.firstPacketAt ??= this.now();
    });
  }

  record(event, o) {
    this.s.recorder?.line?.('combat', { event, order_id: o.id, target: o.order.target,
      action: o.order.action, phase: o.phase, room: this.s.world?.room?.num, reason: o.reason });
  }

  async tick() {
    const o = this.active;
    if (!o) return;
    // Validate even during a slow movement await. Stop/expiry does not wait for it.
    try { this.guard(o); this.refreshTarget(o); } catch (e) { this.stop(e.message); return; }
    if (o.running) { this.armTimer(); return; }
    o.running = true;
    const phaseRevision = o.phaseRevision;
    this.armTimer();
    try {
      await withBodyCommand(this.s, () => withPacketScope(kind => {
        demand(o.phaseRevision === phaseRevision, 'combat visibility changed');
        this.guard(o, kind);
      }, () => this.advance(o)), o.id);
    } catch (e) {
      if (this.active === o && o.phaseRevision === phaseRevision) this.stop(e.message);
    } finally {
      o.running = false;
      if (this.active === o) this.armTimer();
    }
  }

  armTimer() {
    if (this.timer || !this.active) return;
    this.timer = this.schedule(() => { this.timer = null; void this.tick(); }, 100);
    this.timer?.unref?.();
  }

  async advance(o) {
    const s = this.s, c = o.client;
    if (effectsAt(c, c.self).length) {
      demand(await escapeGroundEffect(s), 'ground effect underfoot; no safe escape step');
      return;
    }
    if (o.phase === 'positioning') {
      if (s.world.room.num !== o.order.map) {
        await this.stand(o);
        // Ordinary validated router, under this order's packet and survival guards.
        this.armTimer();
        const result = await s.travel(o.order.map, { movementGeneration: s.movementGeneration, controlToken: o.id });
        this.guard(o);
        demand(result?.arrived && s.world.room.num === o.order.map, result?.reason ?? 'ambush map was not reached');
      }
      if (c.self.row !== o.order.position.row || c.self.col !== o.order.position.col) {
        const next = safeCombatStep(s, { ...o.order.position, exact: true });
        demand(next, 'no safe path to ambush position');
        await this.stand(o); await s.step(next.col, next.row); return;
      }
      o.room = s.world.room.num; o.roomObject = c.room.id;
      o.phase = 'armed'; o.armedAt = this.now(); this.record('armed', o); return;
    }
    if (o.phase === 'armed' || o.phase === 'waiting') { await this.restoreSafety(); return; }
    const target = c.room.objects.get(o.targetId);
    if (!target || exactName(c, target) !== o.targetName) { this.refreshTarget(o); return; }
    await this.prepareSafety(o);
    if (this.now() < o.nextAt) return;
    if (o.pendingAdvance) {
      o.pendingAdvance = false;
      this.nextAction(o);
      if (this.active !== o) return;
    }
    const step = o.order.sequence[o.index];
    if (step.do === 'wait') { o.nextAt = this.now() + step.ms; this.nextAction(o); return; }
    if (step.do === 'attack' && Math.hypot(target.row - c.self.row, target.col - c.self.col) > 2) {
      const next = safeCombatStep(s, target);
      demand(next, 'no safe approach to player');
      await this.stand(o); await s.step(next.col, next.row); return;
    }
    await this.stand(o);
    if (step.do === 'attack') {
      await s.pacer.submit('turn', () => {
        const live = c.room.objects.get(o.targetId), me = c.self;
        const degrees = (Math.round(Math.atan2(live.row - me.row, live.col - me.col) * 180 / Math.PI) + 360) % 360;
        c.face(degrees);
      });
      await s.pacer.submit('attack', () => {
        // Range can change while facing or pacing; do not spend an attack on a
        // stale position. The next event/tick will plan the next short approach.
        const live = c.room.objects.get(o.targetId);
        if (Math.hypot(live.row - c.self.row, live.col - c.self.col) > 2) return;
        c.attack(live.id);
        if (o.firstAttackAt == null) {
          o.firstAttackAt = this.now(); o.reactionMs = o.firstAttackAt - (o.triggeredAt ?? o.acceptedAt);
        }
        o.attacks++;
        if (--o.remaining <= 0) this.nextAction(o);
      }, 1050);
      o.nextAt = this.now() + 1000;
    } else {
      const spell = (c.spells ?? []).find(sp => exactName(c, sp) === step.spell.toLowerCase());
      demand(spell, 'spell is no longer known');
      await s.pacer.submit('cast', () => {
        c.cast(spell.id, step.target === 'none' ? [] : [step.target === 'self' ? c.selfId : target.id]);
        o.casts++; o.pendingAdvance = true;
        o.nextAt = this.now() + step.hold_ms;
      }, 1050);
    }
  }

  nextAction(o) {
    o.index++;
    if (o.index >= o.order.sequence.length) {
      if (!o.order.repeat) { this.stop('sequence completed'); return; }
      o.index = 0;
    }
    o.remaining = o.order.sequence[o.index].swings ?? 1;
  }

  async stand(o) {
    if (o.standing) return;
    await this.s.pacer.submit('rest', () => { o.client.stand(); o.firstPacketAt ??= this.now(); });
    o.standing = true;
  }
}
