// Combat is a bounded, event-driven override in the process that owns the socket.
// No script compiler, snapshot fetch, external planner or keeper pass is on the
// arrival -> first attack path. All packets still use the ordinary server pacer.
import { randomUUID } from 'node:crypto';
import { OF } from './m59-parse.mjs';
import { withBodyCommand } from './m59-body-command.mjs';
import { withPacketScope } from './m59-packet-scope.mjs';
import { effectsAt, groundEffectSquares, groundEffectOnSegment } from './m59-ground-effects.mjs';
import { parsePlayerCombat } from './m59-player-evidence.mjs';
import { chooseSurvivalDecision, currentSurvivalDecision, finishSurvivalDecision,
  updateSurvivalDecision } from './m59-survival-decision.mjs';

export const PVP_DANGER_MS = 30_000;

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
    'select_map', 'command_id', 'revision', 'when_absent', 'watch_maps']);
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
  const when_absent = input.when_absent ?? 'wait';
  demand(['wait', 'farm'].includes(when_absent), 'when_absent must be wait or farm');
  if (when_absent === 'farm') {
    demand(input.action !== 'ambush' && typeof input.target === 'string', 'farm watch needs an attack/kill player name');
    demand(input.watch_maps == null || (Array.isArray(input.watch_maps) && input.watch_maps.length > 0 &&
      input.watch_maps.length <= 32 && input.watch_maps.every(n => Number.isSafeInteger(n) && n > 1)), 'invalid watch_maps');
  } else demand(input.watch_maps == null, 'watch_maps requires when_absent: farm');
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
    ttl_ms, stop_below, sequence: actions, repeat: input.repeat ?? true,
    ...(when_absent === 'farm' ? { when_absent, ...(input.watch_maps ? { watch_maps: [...new Set(input.watch_maps)] } : {}) } : {}) };
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
    this.watch = null;
    this.lastPvP = null;
  }

  status() {
    const o = this.active ?? this.last;
    const watch = this.watchStatus();
    if (!o) return { active: false, pvp_survival: this.pvpStatus(), ...(watch ? { watch } : {}),
      ...(this.watchLoadError ? { watch_error: this.watchLoadError } : {}) };
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
      reason: o.reason ?? null, attacks: o.attacks, casts: o.casts,
      pvp_survival: this.pvpStatus(),
      ...(watch ? { watch } : {}) };
  }

  pvpStatus() {
    const p = this.active?.pvp ?? this.lastPvP;
    if (!p) return null;
    return structuredClone({ ...p, active: !!this.active?.pvp,
      ...(this.active?.pvp && p.shelter?.status === 'approaching'
        ? { shelter: { ...p.shelter, ...this.shelterPath(p) } } : {}),
      phase: this.active?.pvp ? this.active.phase : 'finished',
      last_attack_ago_ms: Math.max(0, this.now() - p.last_attacked_at),
      danger_until: p.last_attacked_at + PVP_DANGER_MS,
      age_ms: this.now() - p.chosen_at });
  }

  // Exact server combat messages establish hostility. Merely sharing a room,
  // outgoing attacks, and chat mentioning a player do not authorize retaliation.
  observePlayerCombat(ev, c) {
    if (ev.kind !== 'message' || !ev.text || this.pvpEligibility?.() === false) return;
    const names = [...(c.room?.objects?.values?.() ?? [])]
      .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER))
      .map(o => c.rsc?.get?.(o.nameRsc) ?? o.name).filter(Boolean);
    for (const o of c.playersOnline?.values?.() ?? []) if (o.id !== c.selfId && o.name) names.push(o.name);
    for (const a of this.active?.pvp?.attackers ?? []) names.push(a.character);
    const result = parsePlayerCombat(ev.text, names);
    if (!result) return;
    if (result.direction === 'incoming') this.beginPvP(result, ev.at);
    const p = this.active?.pvp;
    if (!p) return;
    const attacker = p.attackers.find(a => a.character.toLowerCase() === result.character.toLowerCase());
    if (!attacker) return;
    const key = `${result.direction}_${result.outcome === 'hit' ? 'hits' : 'misses'}`;
    attacker[key]++; p[key]++;
    p.last_outcome = { ...result, at: this.now() };
    this.record('pvp_outcome', this.active);
    this.wake();
  }

  observeMonsterCombat(ev, c) {
    const p = this.active?.pvp;
    if (!p || ev.kind !== 'message' || !ev.text) return;
    const line = ev.text.toLowerCase();
    for (const monster of c.room?.objects?.values?.() ?? []) {
      if (monster.id === c.selfId || !(monster.flags & OF.ATTACKABLE) ||
          (monster.flags & OF.PLAYER) || c.playersOnline?.has?.(monster.id)) continue;
      const name = c.rsc?.get?.(monster.nameRsc) ?? monster.name;
      if (!name) continue;
      const names = [name, `The ${name}`, `A ${name}`, `An ${name}`];
      // A crowded room must not compile a suite of regexes for every monster
      // on every chat/outgoing-combat line. Only a matching prefix needs parsing.
      if (!names.some(n => line.startsWith(n.toLowerCase() + ' ') ||
        line.startsWith(n.toLowerCase() + "'s ") || line.startsWith(n.toLowerCase() + '’s '))) continue;
      const hit = parsePlayerCombat(ev.text, names);
      if (hit?.direction !== 'incoming' || hit.outcome !== 'hit' || hit.verb.toLowerCase() === 'fails to damage') continue;
      p.last_monster_hit = { at: this.now(), room: this.s.world?.room?.num,
        character: name, text: ev.text };
      this.record('pvp_monster_hit', this.active); this.wake(); return;
    }
  }

  playerThreatPresent(o) {
    return o.pvp.attackers.some(a => combatTarget(o.client, a.character));
  }

  shelterPath(p) {
    const d = currentSurvivalDecision(this.s);
    return d?.id === p.decision_id ? { chosen_refuge: d.chosen_refuge,
      selected_at: d.selected_at, path: d.path, path_length: d.path_length } : {};
  }

  interruptPvPShelter(o, reason) {
    const shelter = o.pvp?.shelter;
    if (!shelter || !['approaching', 'sheltered'].includes(shelter.status)) return;
    Object.assign(shelter, this.shelterPath(o.pvp), { status: 'interrupted', ended_at: this.now(), reason });
    updateSurvivalDecision(this.s, o.pvp.decision_id, { status: 'active', phase: 'return_fire',
      phase_reason: reason, chosen_refuge: null, path: null, path_length: null });
    this.record('pvp_shelter_interrupted', o);
  }

  async shelterFromMonsters(o) {
    const p = o.pvp, keeper = this.keeper(), hit = p?.last_monster_hit;
    if (!p || !keeper?.takeSafeSpot || this.playerThreatPresent(o)) return;
    const now = this.now();
    if (!hit || hit.room !== this.s.world?.room?.num || now - hit.at > PVP_DANGER_MS ||
        ![...o.client.room.objects.values()].some(m => !(m.flags & OF.PLAYER) && !o.client.playersOnline?.has?.(m.id) &&
          (m.flags & OF.ATTACKABLE) && exactName(o.client, m) === hit.character.toLowerCase())) return;
    if (now < (p.shelter_retry_at ?? 0)) return;
    if (keeper.adoptRecoveryWall?.()) {
      if (p.shelter?.status !== 'sheltered') {
        p.shelter = { status: 'sheltered', started_at: now, arrived_at: now,
          chosen_refuge: { ...keeper.hold }, reason: 'already covered from monsters; watching for player attackers' };
        updateSurvivalDecision(this.s, p.decision_id, { status: 'active', phase: 'monster_cover',
          chosen_refuge: keeper.hold, path: [], path_length: 0, phase_reason: p.shelter.reason });
        this.record('pvp_sheltered', o);
      }
      return;
    }
    const revision = o.phaseRevision;
    const interrupted = () => this.active !== o || o.phaseRevision !== revision ||
      !this.s.live || this.s.client !== o.client || this.playerThreatPresent(o);
    const shelter = p.shelter = { status: 'approaching', started_at: now,
      reason: 'player attackers absent; seek monster cover during the PvP danger window',
      monster_evidence: { ...hit } };
    p.shelter_attempts = (p.shelter_attempts ?? 0) + 1;
    updateSurvivalDecision(this.s, p.decision_id, { status: 'active', phase: 'monster_shelter',
      phase_reason: shelter.reason, chosen_refuge: null, selected_at: null, path: null, path_length: null });
    this.record('pvp_shelter_started', o);
    // Use the ordinary closest clear, exclusive recovery selector and confirmed
    // arrival. Do not invoke takeRecoverySpot: its next action is healing/logout.
    const result = await keeper.takeSafeSpot(shelter.reason, null, { source: 'pvp_monster_cover',
      recovery: true, nearestOnly: true, shelterOnly: true,
      decisionId: p.decision_id, shouldInterrupt: interrupted })
      .catch(error => ({ took: false, why: error.message }));
    if (interrupted() || p.shelter !== shelter) return;
    Object.assign(shelter, this.shelterPath(p), { status: result?.took ? 'sheltered' : 'blocked',
      approach_ended_at: this.now(), ...(result?.took ? { arrived_at: this.now() } : { ended_at: this.now() }),
      reason: result?.why ?? (result?.took ? 'reached monster cover' : 'no clear safe wall') });
    p.shelter_retry_at = this.now() + 1000;
    updateSurvivalDecision(this.s, p.decision_id, { status: 'active',
      phase: result?.took ? 'monster_cover' : 'waiting_for_player', phase_reason: shelter.reason });
    this.record(result?.took ? 'pvp_sheltered' : 'pvp_shelter_blocked', o);
  }

  beginPvP(evidence, observedAt = this.now()) {
    const s = this.s, c = s.client;
    if (!s.live || !c?.self || !(s.world?.room?.num > 1) || c.vitals?.()?.health?.value === 0) return;
    const at = Math.min(this.now(), Number.isFinite(observedAt) ? observedAt : this.now());
    let o = this.active;
    if (!o?.pvp) {
      const decision = chooseSurvivalDecision(s, { strategy: 'pvp_return_fire', status: 'active',
        reason: `attacked by ${evidence.character}; return fire until the threat leaves or we die`,
        reason_code: 'confirmed_player_attack', source: 'combat',
        mitigation: 'ordinary HP floors, shelter and healing cannot stop return fire' },
      { because: 'confirmed player attack supersedes ordinary recovery' });
      this.stop('superseded by confirmed player attack', { preserveId: decision.id });
      s.combatEpoch = (s.combatEpoch ?? 0) + 1;
      s.fightGeneration = (s.fightGeneration ?? 0) + 1;
      const id = randomUUID();
      withBodyCommand(s, () => s.cancelMovement(null, 'PvP survival: return fire', { preserveId: decision.id }), id);
      s._router?.clear?.();
      if (s.job && !s.job.done) { s.job.cancelled = true; s.job.done = true; s.job.finishedAt = this.now(); }
      const keeper = this.keeper();
      if (keeper) {
        keeper.suspendedJourney = null;
        keeper.revive?.('PvP survival: return fire');
        keeper.frozenUntil = null; keeper.freezeSample = null;
      }
      const order = normalizeCombatOrder({ action: 'kill', target: evidence.character });
      o = this.active = { id, order, acceptedAt: this.now(), expiresAt: null,
        client: c, playerId: c.selfId, room: s.world.room.num, roomObject: c.room.id,
        phase: 'waiting', phaseRevision: 0, targetId: null, targetName: null,
        attacks: 0, casts: 0, index: 0, remaining: 1, nextAt: 0, running: false,
        pvp: { version: 1, strategy: 'return_fire', character: characterName(s, c),
          decision_id: decision.id, chosen_at: this.now(), last_attacked_at: at,
          first_evidence: evidence.text, attackers: [], attacks: 0,
          incoming_hits: 0, incoming_misses: 0, outgoing_hits: 0, outgoing_misses: 0,
          reconnects: 0, ended_at: null, outcome: null } };
      updateSurvivalDecision(s, decision.id, { activated_at: this.now(), phase: 'return_fire' });
      s.pacer.wake?.();
    }
    const p = o.pvp;
    let a = p.attackers.find(a => a.character.toLowerCase() === evidence.character.toLowerCase());
    if (!a) {
      a = { character: evidence.character, first_attacked_at: at, last_attacked_at: at,
        incoming_hits: 0, incoming_misses: 0, outgoing_hits: 0, outgoing_misses: 0 };
      p.attackers.push(a);
    }
    a.last_attacked_at = Math.max(a.last_attacked_at, at);
    p.last_attacked_at = Math.max(p.last_attacked_at, at);
    this.syncPvP(o);
    this.record('pvp_attacked', o);
    this.wake();
  }

  // Keep ownership through disconnects and target disappearance. A reconnect
  // preserves HP and hostility; it is never evidence that resting is safe.
  syncPvP(o) {
    if (!o?.pvp || this.active !== o) return true;
    const s = this.s, c = s.client, p = o.pvp;
    if (this.pvpEligibility?.() === false) { this.stop('operator suspended connection'); return false; }
    if (!s.live || !c?.self || c.combatReady === false) {
      this.interruptPvPShelter(o, 'connection unavailable; retain PvP intent');
      if (o.phase !== 'offline') { o.phase = 'offline'; o.phaseRevision++; this.record('pvp_offline', o); }
      return false;
    }
    if (characterName(s, c) !== p.character) { this.stop('character identity changed'); return false; }
    if (c.vitals?.()?.health?.value === 0 || s.world?.room?.num === 1) {
      this.stop('PvP survival ended: died'); return false;
    }
    if (c !== o.client || c.selfId !== o.playerId || c.room.id !== o.roomObject || s.world?.room?.num !== o.room) {
      this.interruptPvPShelter(o, 'connection or room changed');
      if (c !== o.client) p.reconnects++;
      o.client = c; o.playerId = c.selfId; o.roomObject = c.room.id; o.room = s.world?.room?.num;
      o.phaseRevision++; o.standing = false; o.targetId = null; o.nextAt = 0;
      this.record('pvp_rebound', o);
    }
    if (o.phase === 'offline') o.phase = 'waiting';
    const present = p.attackers.map(a => ({ a, target: combatTarget(c, a.character) })).filter(x => x.target);
    if (present.length && p.shelter?.status === 'approaching') {
      this.interruptPvPShelter(o, 'player attacker present; return fire takes priority');
      withBodyCommand(s, () => s.cancelMovement(null, 'PvP attacker interrupted monster shelter',
        { preserveId: p.decision_id }), o.id);
      o.phaseRevision++; s.pacer.wake?.();
    } else if (present.length) this.interruptPvPShelter(o, 'player attacker present; return fire takes priority');
    if (!present.length && this.now() - p.last_attacked_at >= PVP_DANGER_MS) {
      this.stop('PvP survival ended: attackers absent after 30 seconds'); return false;
    }
    const pick = present.find(x => (x.target.flags & OF.ATTACKABLE) &&
      x.a.character.toLowerCase() === String(o.order.target).toLowerCase()) ??
      present.find(x => x.target.flags & OF.ATTACKABLE) ?? present[0];
    if (pick && String(o.order.target).toLowerCase() !== pick.a.character.toLowerCase()) {
      o.order.target = pick.a.character; o.phaseRevision++; o.targetId = null; o.nextAt = 0;
      this.record('pvp_retargeted', o);
    }
    return true;
  }

  combatFailure(o, reason) {
    if (!o?.pvp) { this.stop(reason); return; }
    if (this.active !== o || !this.syncPvP(o)) return;
    // A blocked path or server refusal must not hand the body to PvE recovery.
    // Keep retrying against fresh observations, without an automatic logout loop.
    if (o.pvp.blocked_reason !== reason) {
      o.pvp.blocked_reason = reason; this.record('pvp_blocked', o);
    }
    o.nextAt = this.now() + 1000;
    this.armTimer();
  }

  restorePvPForReplay(saved, capturedAt, names = new Map()) {
    if (!saved?.active) return false;
    demand(['127.0.0.1', 'localhost', '::1'].includes(this.s.credentials?.host) &&
      [15959, 17959].includes(Number(this.s.credentials?.port)), 'PvP replay requires the shadow server');
    const delta = this.now() - capturedAt;
    const attackers = (saved.attackers ?? []).map(a => ({ ...a,
      character: names.get(a.character) ?? a.character,
      first_attacked_at: a.first_attacked_at + delta, last_attacked_at: a.last_attacked_at + delta }));
    for (const a of attackers) this.beginPvP({ character: a.character,
      text: `restored PvP survival against ${a.character}` }, a.last_attacked_at);
    if (this.active?.pvp) {
      const p = this.active.pvp;
      for (const key of ['attacks', 'incoming_hits', 'incoming_misses', 'outgoing_hits', 'outgoing_misses', 'reconnects'])
        p[key] = saved[key] ?? 0;
      p.attackers = attackers; p.chosen_at = saved.chosen_at + delta;
      p.last_attacked_at = saved.last_attacked_at + delta;
      if (saved.last_monster_hit) p.last_monster_hit = { ...saved.last_monster_hit,
        at: saved.last_monster_hit.at + delta };
      this.active.attacks = p.attacks;
      this.record('pvp_restored', this.active);
    }
    return !!this.active?.pvp;
  }

  issue(input, fromWatch = null) {
    if (input.select_map != null && ['ready', 'status', 'stop'].includes(input.action) &&
        this.s.world?.room?.num !== input.select_map)
      return { skipped: true, reason: 'outside assigned map', map: this.s.world?.room?.num ?? null };
    if (input.action === 'ready') return { ready: true, combat_mode: 3, in_game: !!this.s.live,
      map: this.s.world?.room?.num ?? null, farming: this.farmEligible(), combat: this.status() };
    if (input.action === 'status') return { ...this.status(),
      ...(input.order_id ? { order_matches: this.active?.id === input.order_id ||
        this.watch?.id === input.order_id || this.last?.id === input.order_id } : {}) };
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
      if (input.order_id && input.order_id !== this.active?.id && input.order_id !== this.watch?.id)
        return { stopped: false, reason: 'order was already replaced', ...this.status() };
      if (!input.order_id || input.order_id === this.watch?.id) this.clearWatch();
      if (!input.order_id || input.order_id === this.active?.id) this.stop('operator stopped combat');
      return this.status();
    }
    // Validate completely before replacing the current order.
    const order = normalizeCombatOrder(input), s = this.s;
    if (this.active?.pvp) return { ...this.status(), accepted: false, skipped: true,
      reason: 'PvP survival owns the body; use explicit combat stop to release it' };
    if (input.command_id && this.cancelled.has(input.command_id))
      return { accepted: false, skipped: true, reason: 'command already stopped' };
    if (input.command_id && input.command_id === this.active?.id) return { accepted: true, ...this.status() };
    if (!fromWatch && input.command_id && input.command_id === this.watch?.id) return { accepted: true, ...this.status() };
    if (input.revision && input.revision <= this.revision)
      return { accepted: false, skipped: true, reason: 'superseded command' };
    if (order.when_absent === 'farm') return this.installWatch(order, input);
    const c = s.need();
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
    if (!fromWatch) this.clearWatch();
    this.stop('replaced by a newer combat order');
    s.combatEpoch = (s.combatEpoch ?? 0) + 1;
    s.fightGeneration = (s.fightGeneration ?? 0) + 1;
    withBodyCommand(s, () => s.cancelMovement(null, 'combat override accepted'), input.command_id ?? 'combat-accept');
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
      watchId: fromWatch?.id ?? null,
      targetId: target?.id ?? null, targetName: target ? exactName(c, target) : null,
      attacks: 0, casts: 0, index: 0, remaining: order.sequence[0].swings ?? 1, nextAt: 0, running: false };
    this.record('accepted', o);
    s.pacer.wake?.();
    this.wake();
    return { accepted: true, ...this.status() };
  }

  healthFraction() {
    const v = this.s.client?.vitals?.()?.health, max = v?.max ?? v?.scale_max;
    return Number.isFinite(v?.value) && Number.isFinite(max) && max > 0 ? v.value / max : null;
  }

  healthFloor(order) {
    const keeper = this.keeper();
    const computedFloor = keeper?.safety?.()?.fleeAt ?? keeper?._wdHost?.safety?.()?.fleeAt;
    const keeperFloor = Number.isFinite(computedFloor) ? computedFloor : keeper?.policy?.fleeBelow;
    return Math.max(order.stop_below, Number.isFinite(keeperFloor) ? keeperFloor : 0);
  }

  healthOK(order) {
    const fraction = this.healthFraction();
    return fraction != null && fraction > this.healthFloor(order);
  }

  watchStatus() {
    const w = this.watch;
    if (!w) return null;
    return { enabled: true, order_id: w.id, action: w.order.action, target: w.order.target,
      maps: w.maps, when_absent: 'farm', phase: this.active?.watchId === w.id ? 'engaging' : w.phase,
      reason: w.reason, accepted_at: w.acceptedAt, expires_at: w.expiresAt,
      engagements: w.engagements, last_engagement: w.lastEngagement ?? null,
      persistence_error: w.persistenceError ?? null };
  }

  farmEligible() {
    if (this.watchEligibility) return !!this.watchEligibility();
    const keeper = this.keeper();
    return !!(keeper?.mode === 'farm' && keeper.running && !keeper.inert);
  }

  installWatch(order, input) {
    const maps = order.watch_maps ?? (input.select_map ? [input.select_map] : [this.s.world?.room?.num]);
    demand(maps.length > 0 && maps.every(n => Number.isSafeInteger(n) && n > 1), 'farm watch needs assigned maps');
    if (this.s.world?.map?.rooms) demand(maps.every(n => this.s.world.map.rooms[String(n)]), 'unknown farm watch map');
    const acceptedAt = this.now();
    const w = { id: input.command_id ?? randomUUID(), order: { ...order, watch_maps: maps }, maps,
      character: this.character?.() ?? characterName(this.s, this.s.client),
      acceptedAt, expiresAt: order.ttl_ms == null ? null : acceptedAt + order.ttl_ms,
      phase: 'watching', reason: 'normal behavior while waiting for target', engagements: 0, recovering: false };
    // Durable configuration is written before reporting acceptance. No farming
    // job or body ownership changes merely because a passive watch was installed.
    this.saveWatch?.(w);
    this.watchLoadError = null;
    this.watch = w;
    if (input.revision) this.revision = input.revision;
    if (this.active && maps.includes(this.s.world?.room?.num)) this.stop('standing watch replaced immediate order');
    this.evaluateWatch(); this.wake();
    return { accepted: true, ...this.status() };
  }

  restoreWatch(saved) {
    if (!saved) return;
    demand(saved.character === (this.character?.() ?? characterName(this.s, this.s.client)), 'watch character changed');
    const order = normalizeCombatOrder(saved.order);
    demand(order.when_absent === 'farm' && order.watch_maps?.length, 'invalid saved watch');
    demand(typeof saved.id === 'string' && Number.isFinite(saved.acceptedAt) &&
      (saved.expiresAt == null || Number.isFinite(saved.expiresAt)), 'invalid saved watch identity');
    if (saved.expiresAt != null && this.now() >= saved.expiresAt) { this.saveWatch?.(null); return; }
    this.watch = { ...saved, order, maps: order.watch_maps, phase: 'watching', blockedTarget: null };
    this.wake();
  }

  clearWatch() {
    if (!this.watch) return;
    // Refuse a false durable success if the stop cannot be saved.
    this.saveWatch?.(null);
    this.watch = null;
    if (!this.active && this.timer) { this.unschedule(this.timer); this.timer = null; }
  }

  evaluateWatch() {
    const w = this.watch, s = this.s, c = s.client;
    if (!w || this.active) return;
    const pause = (phase, reason) => { w.phase = phase; w.reason = reason; };
    try {
      if (w.expiresAt != null && this.now() >= w.expiresAt) { this.clearWatch(); return; }
      if (!s.live || !c?.self || c.lastRxAt > 0 && this.now() - c.lastRxAt > 45000) {
        pause('offline', 'waiting for a live connection'); return;
      }
      if ((this.character?.() ?? characterName(s, c)) !== w.character) {
        pause('blocked', 'watch character changed'); return;
      }
      if (w.restoreSafety) {
        // A process restart can happen after safety-off reached the server.
        // Restore that obligation before farming or another encounter resumes.
        this.safetyLease ??= { client: c, playerId: c.selfId,
          character: characterName(s, c), watchId: w.id };
        void this.restoreSafety();
        pause('watching', 'restoring prior PvP safety'); return;
      }
      if (!w.maps.includes(s.world?.room?.num)) { pause('outside_map', 'normal behavior outside assigned maps'); return; }
      if (!this.farmEligible()) { pause('paused', 'normal farming is paused'); return; }
      if (!this.healthOK(w.order)) {
        w.recovering = true; pause('recovering', 'normal recovery until healthy enough to engage'); return;
      }
      const resumeAbove = Math.min(0.99, Math.max(0.8, this.healthFloor(w.order) + 0.1));
      if (w.recovering && this.healthFraction() < resumeAbove) {
        pause('recovering', 'normal recovery until healthy enough to engage'); return;
      }
      w.recovering = false;
      const target = combatTarget(c, w.order.target);
      if (!target || !(target.flags & OF.ATTACKABLE)) {
        w.blockedTarget = null; pause('watching', 'normal behavior while waiting for target'); return;
      }
      if (w.blockedTarget === target.id) { pause('blocked', w.reason); return; }
      const { when_absent, watch_maps, ...engage } = w.order;
      this.issue({ ...engage, command_id: w.id, select_map: s.world.room.num,
        ...(w.expiresAt == null ? {} : { ttl_ms: Math.max(1000, w.expiresAt - this.now()) }) }, w);
      if (this.active) {
        // Expiry is absolute across repeated engagements.
        this.active.expiresAt = w.expiresAt;
        this.active.triggeredAt = this.now();
        w.engagements++; pause('engaging', 'exact player visible in assigned map');
      }
    } catch (error) {
      pause('blocked', error.message);
      try { w.blockedTarget = combatTarget(c, w.order.target)?.id ?? null; } catch {}
    }
  }

  guard(o, kind = 'read') {
    demand(this.active === o, 'order cancelled or replaced');
    if (o.watchId && !o.pvp) demand(this.farmEligible(), 'normal farming is paused');
    demand(this.s.client === o.client && o.client.selfId === o.playerId && this.s.live,
      'connection or character identity changed');
    demand(o.expiresAt == null || this.now() < o.expiresAt, 'order expired');
    demand(!(o.client.lastRxAt > 0 && this.now() - o.client.lastRxAt > 45000),
      'connection stale: no server data for 45 seconds');
    demand((o.pvp ? this.healthFraction() > 0 : this.healthOK(o.order)) &&
      this.s.world?.room?.num > 1, o.pvp ? 'waiting for live health' : 'survival floor reached');
    if (o.phase !== 'positioning') demand(o.client.room.id === o.roomObject &&
      this.s.world.room.num === o.room, 'left the combat room');
    if (o.phase === 'armed') demand(o.client.self?.row === o.order.position.row &&
      o.client.self?.col === o.order.position.col, 'ambush position changed');
    if (o.pvp?.shelter?.status === 'approaching')
      demand(!this.playerThreatPresent(o), 'player threat preempts monster shelter');
    if (o.phase === 'engaging' && ['attack', 'turn', 'cast'].includes(kind)) {
      const t = o.client.room.objects.get(o.targetId);
      demand(t && t.id !== o.playerId && (t.flags & OF.PLAYER) && (t.flags & OF.ATTACKABLE) &&
        exactName(o.client, t) === o.targetName, 'target left or identity changed');
    }
  }

  event(ev, client = this.s.client) {
    if (!client || client !== this.s.client || client.combatReady === false) return;
    this.observePlayerCombat(ev, client);
    this.observeMonsterCombat(ev, client);
    const requested = this.safetyRequest;
    if (requested && ev.kind === 'changed' && ev.id === requested.playerId &&
        requested.client === this.s.client && !!(requested.client.self?.flags & OF.SAFETY) === requested.on)
      this.safetyRequest = null;
    const o = this.active;
    if (!o) { void this.restoreSafety(); this.evaluateWatch(); this.wake(); return; }
    if (o.pvp) {
      if (!this.syncPvP(o)) { this.wake(); return; }
      this.refreshTarget(o);
    }
    // Only a real CREATE after arming counts as an entry. A refresh, or somebody
    // already standing in the room when the ambush was armed, does not.
    if (ev.kind === 'message' && ev.text && o.phase === 'engaging') {
      if (/good thing your safety was on|cannot attack|can't attack|can't bring yourself to attack/i.test(ev.text)) {
        o.lastOutcome = { at: this.now(), text: ev.text, kind: 'refused' };
        this.combatFailure(o, `server refused combat: ${ev.text}`); return;
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
      try { this.guard(o); this.refreshTarget(o); } catch (e) { this.combatFailure(o, e.message); return; }
      this.evaluateWatch(); this.wake();
    }
  }

  wake() {
    if (!this.active && !this.watch) return;
    if (this.timer) this.unschedule(this.timer);
    this.timer = this.schedule(() => { this.timer = null; void this.tick(); }, 0);
    this.timer?.unref?.();
  }

  stop(reason, { preserveId = null } = {}) {
    const o = this.active;
    if (!o) return;
    if (o.pvp) {
      const p = o.pvp;
      this.interruptPvPShelter(o, reason);
      p.ended_at = this.now(); p.outcome = /ended: died/.test(reason) ? 'died' :
        /attackers absent/.test(reason) ? 'attackers_left' : 'stopped';
      p.end_reason = reason; this.lastPvP = p;
      finishSurvivalDecision(this.s, p.decision_id, p.outcome, reason);
    }
    withBodyCommand(this.s, () => this.s.cancelMovement(null, `combat: ${reason}`, { preserveId }), o.id);
    this.active = null; this.s.combatEpoch = (this.s.combatEpoch ?? 0) + 1;
    this.s.pacer.wake?.();
    if (this.timer) this.unschedule(this.timer);
    this.timer = null;
    o.phase = 'finished'; o.reason = reason; o.finishedAt = this.now(); this.last = o;
    this.record('finished', o);
    const w = this.watch;
    if (w && o.watchId === w.id) {
      w.lastEngagement = { finished_at: o.finishedAt, reason, attacks: o.attacks, casts: o.casts,
        reaction_ms: o.reactionMs ?? null };
      w.reason = reason; w.phase = 'watching';
      if (/survival floor/.test(reason)) { w.recovering = true; w.phase = 'recovering'; }
      else if (!/target no longer visible|left the combat room|connection|identity changed|normal farming is paused/.test(reason)) {
        w.blockedTarget = o.targetId; w.phase = 'blocked';
      }
      try { this.saveWatch?.(w); } catch (e) { w.persistenceError = e.message; }
    }
    // Cleanup has its own fresh packet scope, not the cancelled combat guard.
    void this.restoreSafety().catch(() => {});
    this.armTimer();
  }

  refreshTarget(o) {
    if (!['waiting', 'engaging'].includes(o.phase)) return;
    const t = combatTarget(o.client, o.order.target);
    const visible = t && (t.flags & OF.ATTACKABLE);
    if (visible && o.phase === 'engaging' && t.id === o.targetId && exactName(o.client, t) === o.targetName) return;
    if (!visible && o.phase === 'waiting') return;
    if (!visible && o.watchId) { this.stop('target no longer visible; normal behavior resumed'); return; }
    withBodyCommand(this.s, () => this.s.cancelMovement(null, 'combat visibility changed',
      { preserveId: o.pvp?.decision_id }), o.id);
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
      if (lease.watchId && this.watch?.id === lease.watchId) {
        this.watch.restoreSafety = false;
        try { this.saveWatch?.(this.watch); } catch (e) { this.watch.persistenceError = e.message; }
      }
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
      if (o.watchId && this.watch?.id === o.watchId) {
        this.watch.restoreSafety = true;
        this.saveWatch?.(this.watch);
      }
      o.client.safety(false);
      this.safetyRequest = { client: o.client, playerId: o.playerId, on: false };
      this.safetyLease = { client: o.client, playerId: o.playerId,
        character: characterName(this.s, o.client), watchId: o.watchId };
      o.firstPacketAt ??= this.now();
    });
  }

  record(event, o) {
    this.s.recorder?.line?.('combat', { event, order_id: o.id, target: o.order.target,
      action: o.order.action, phase: o.phase, room: this.s.world?.room?.num, reason: o.reason,
      attacks: o.attacks, casts: o.casts, ...(o.pvp ? { pvp_survival: this.pvpStatus() } : {}) });
  }

  async tick() {
    this.evaluateWatch();
    const o = this.active;
    if (!o) { this.armTimer(); return; }
    if (o.pvp && !this.syncPvP(o)) { this.armTimer(); return; }
    // Validate even during a slow movement await. Stop/expiry does not wait for it.
    try { this.guard(o); this.refreshTarget(o); } catch (e) { this.combatFailure(o, e.message); return; }
    if (this.active !== o) { this.armTimer(); return; }
    const phaseRevision = o.phaseRevision;
    if (o.running?.revision === phaseRevision) { this.armTimer(); return; }
    // A stale shelter mover may still be unwinding an await. Its packets were
    // revoked; the new combat phase must not wait for its completion/heartbeat.
    const running = o.running = { revision: phaseRevision };
    this.armTimer();
    try {
      await withBodyCommand(this.s, () => withPacketScope(kind => {
        demand(o.phaseRevision === phaseRevision, 'combat visibility changed');
        this.guard(o, kind);
      }, () => this.advance(o)), o.id);
    } catch (e) {
      if (this.active === o && o.phaseRevision === phaseRevision) this.combatFailure(o, e.message);
    } finally {
      if (o.running === running) o.running = false;
      if (this.active === o) this.armTimer();
    }
  }

  armTimer() {
    if (this.timer || (!this.active && !this.watch)) return;
    this.timer = this.schedule(() => { this.timer = null; void this.tick(); }, 100);
    this.timer?.unref?.();
  }

  async advance(o) {
    const s = this.s, c = o.client;
    if (!o.pvp && effectsAt(c, c.self).length) {
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
    if (o.phase === 'armed' || o.phase === 'waiting') {
      await this.restoreSafety();
      if (o.pvp && this.active === o && o.phase === 'waiting') await this.shelterFromMonsters(o);
      return;
    }
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
        if (o.pvp) { o.pvp.attacks++; o.pvp.blocked_reason = null; this.record('pvp_attack_sent', o);
          // THE TELEPORT BAN STARTS HERE. Ten minutes in which the chalice refuses a sip
          // (chalice.kod:168, util/settings.kod:88), and nothing tells us but our own swing.
          // Stamped on the session because that is what this module and the keeper share.
          try { this.s.lastPlayerAttackAt = this.now(); } catch {} }
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
