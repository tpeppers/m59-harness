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
import * as war from './m59-war.mjs';
import * as gear from './m59-pvp-gear.mjs';
import { sameRoomDoorPlan } from './m59-world.mjs';
import * as keepoff from './m59-keepoff.mjs';
import { parseDeathBroadcast } from './m59-death-attribution.mjs';
import * as pvplog from './m59-pvp.mjs';
import { Recorder } from './m59-recorder.mjs';
import { isGuildOnlyRefusal, refusedHere, noteRefused, refusedTargets, forgetRefused } from './m59-refused-targets.mjs';
import { keeperOrigin } from './m59-move-origin.mjs';
import * as swarm from './m59-swarm-follow.mjs';
import { squareCentre } from './m59-coords.mjs';

export const PVP_DANGER_MS = 30_000;
// What a keeper heard, for the pvpOpener's ctx.heard: long enough to span a room enchantment.
export const HEARD_MS = 5 * 60_000;
export const HEARD_MAX = 60;
// One look at a stranger per keeper per this long, and only by the room's look leader unless
// the stranger has gone unread for WAR_LOOK_FALLBACK_MS. Twenty characters in one room must not
// all look at the same entrant.
export const WAR_LOOK_EVERY_MS = 1500;
export const WAR_LOOK_FALLBACK_MS = 4000;
// The same (map, enemy) alarm is not re-raised by one keeper more often than this.
export const WAR_ALARM_EVERY_MS = 3000;
// A swarm leader's target stands until it dies or the leader names another; an entry older than
// this is never taken up at all (object ids recycle within hours).
export const WARBAND_TARGET_MAX_AGE_MS = 15 * 60_000;
// A sentinel watching an enemy stand in its room reports it again this often.
export const WAR_SIGHTING_EVERY_MS = 15_000;

// ROOMS WHERE THE SERVER WILL NOT LET ANYBODY SWING (blakston.khd room flags, checked in
// room.kod ReqSomethingAttack before anything else). 2026-09-30: nine characters sat in
// Familiars (52, an inn: 0x10a2) on a kill order against Wenbo for ten minutes and 470 attacks,
// every one answered "You can't fight here.", and could not be walked out because the combat
// override owned the body. 73 rooms carry NO_COMBAT, Marion (200) among them.
export const ROOM_NO_COMBAT = 0x0002;
export const ROOM_NO_PK = 0x0004;
// The sentences ReqSomethingAttack answers with when the ROOM forbids it (room.kod resources
// room_no_attack, room_no_pk_allowed). A room refusal says nothing about the target.
//
// room_guild_combat, "Only those in guilds may attack each other here.", is NOT one of them any
// more. It is refused by AllowGuildAttack(what, victim), which in a ROOM_GUILD_PK_ONLY room says
// no when the VICTIM is unguilded, not a murderer, and holds no token or soldier shield (the fleet
// is guilded, so the attacker half does not apply): a fact about one target in one room. It is
// remembered per (room number, name) in m59-refused-targets.mjs and every attack path skips that
// target there; other players in the room are unaffected. Operator, 2026-10-01.
export const ROOM_REFUSAL = /you can't fight here|you cannot attack another player here/i;
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
    'select_map', 'command_id', 'revision', 'when_absent', 'watch_maps', 'warband', 'keepoff']);
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
    // A WARBAND ORDER follows the swarm leader's target, which may be a monster: it names an
    // object id and is the one kind of order allowed to target something that is not a player.
    ...(input.warband === true && Number.isSafeInteger(input.target) ? { warband: true } : {}),
    ...(when_absent === 'farm' ? { when_absent, ...(input.watch_maps ? { watch_maps: [...new Set(input.watch_maps)] } : {}) } : {}) };
  if (input.action === 'ambush') {
    demand(Number.isSafeInteger(input.map) && input.map > 1, 'ambush needs a map number, not a room object id');
    demand(typeof order.target === 'string', 'ambush needs a player name that survives room changes');
    order.map = input.map;
    order.position = square(input.position, 'ambush position');
    // A KEEP-OFF ambush (m59-keepoff.mjs) waits NEAR a logoff ghost, not on one exact square, and
    // engages a target already standing there -- several characters share one ghost.
    if (input.keepoff === 'wait' || input.keepoff === 'rush') order.keepoff = input.keepoff;
    if (input.door != null) {
      order.door = square(input.door, 'door arrival area');
      order.door.radius = input.door.radius ?? 1;
      demand(Number.isFinite(order.door.radius) && order.door.radius >= 0 && order.door.radius <= 5,
        'door radius must be 0..5 squares');
    }
  }
  return order;
}

export function combatTarget(client, target, { anyAttackable = false } = {}) {
  // A warband order names an object id and may be a monster; everything else is a player.
  if (anyAttackable && typeof target === 'number') {
    const o = client.room.objects.get(target);
    return o && o.id !== client.selfId && (o.flags & OF.ATTACKABLE) ? o : null;
  }
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
    // THE WAR RESPONSE is off until the owning process says otherwise (`warEligibility`). The
    // keeper process wires it; a broker in-process session and every test that does not ask
    // for it keep the behaviour that was already there.
    this.warEligibility = null;
    this.fleetmate = () => false;
    this.warLookAt = 0; this.warPendingLook = null; this.warSeen = new Map();
    this.warAlarmed = new Map(); this.warLast = null; this.warError = null;
  }

  status() {
    const o = this.active ?? this.last;
    const watch = this.watchStatus();
    const refused_targets = this.refusedStatus();
    if (!o) return { active: false, pvp_survival: this.pvpStatus(), war: this.warStatus(), ...(watch ? { watch } : {}),
      ...(refused_targets?.length ? { refused_targets } : {}),
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
      pvp_survival: this.pvpStatus(), keep_safety: !!o.keepSafety, war: this.warStatus(),
      ...(refused_targets?.length ? { refused_targets } : {}),
      ...(watch ? { watch } : {}) };
  }

  // ------------------------------------------------------------------ refused here
  //
  // ONE MEMORY FOR EVERY ATTACK PATH (m59-refused-targets.mjs), on the session, so the keeper's
  // own self-defence, fight-back and target list read the same entries this module writes.
  // Kept on this module's clock so its TTL agrees with every other timer here.

  /** The server refused us this player in the room we stand in; null when it has not. */
  targetRefused(name) {
    try { return name ? refusedHere(this.s, name, this.now()) : null; } catch { return null; }
  }

  refuseTarget(name, { why = 'guild_only', text = null, source = 'combat' } = {}) {
    try { return name ? noteRefused(this.s, name, { why, text, at: this.now(), source })?.entry ?? null : null; }
    catch { return null; }
  }

  refusedStatus() {
    try { return refusedTargets(this.s)?.list(this.now()) ?? null; } catch { return null; }
  }

  warStatus() {
    return { enabled: this.warEnabled(), sentinel: this.sentinelEnabled(), last: this.warLast,
      threat: this.warThreat ?? null, error: this.warError,
      keepoff: { last: this.keepoffLast ?? null, error: this.keepoffError ?? null },
      leash: this.leashStatus(),
      enemy_guilds: (() => { try { return war.enemyGuilds().map(g => g.name); } catch { return null; } })() };
  }

  warEnabled() { return !!this.warEligibility?.(); }
  // A SENTINEL SEES AND SAYS, AND NEVER SWINGS. Every fighter is also a sentinel; a menagerie
  // host is ONLY one. Loial the Ogier sits Outside Castle Victoria (2), on the road Morpheus
  // walks to the stairs, and a host that fought would be a merchant thrown at a killer -- but a
  // host that reports what walks past is the fleet's early warning.
  sentinelEnabled() { return this.warEnabled() || !!this.sentinelEligibility?.(); }

  isOurs(name) {
    if (!name) return false;
    if (String(name).trim().toLowerCase() === characterName(this.s, this.s.client)) return true;
    try { return !!this.fleetmate(name); } catch { return false; }
  }

  // ------------------------------------------------------------------ the war response
  //
  // THREE INPUTS, ONE OUTPUT. A player in our room is hostile because the server marks it
  // (OF.ENEMY, a mutual guild war), or because the war book remembers its guild; a fleetmate in
  // our MAP raised an alarm. Every one of them ends in beginPvP â€” the same body-owning return
  // fire an incoming hit already starts â€” with `keepSafety`, because a mutual war passes the
  // server's safety check with safety ON and nothing here should ever need it off.
  // See tools/m59-war.mjs for the argument.
  observeWar(ev, c) {
    if (!this.sentinelEnabled()) return;
    try {
      let learned = null;
      if (ev.kind === 'message' && ev.text) learned = war.learnFromMessage(ev.text, { isOurs: n => this.isOurs(n) });
      if (ev.kind === 'look' && ev.player) this.learnFromLook(ev, c);
      if (learned || ['appeared', 'room-contents', 'changed', 'room-entered', 'look'].includes(ev.kind))
        this.scanForEnemies(c);
    } catch (e) { this.warError = e.message; }
  }

  learnFromLook(ev, c) {
    const pending = this.warPendingLook;
    const o = c.room?.objects?.get?.(ev.id);
    const name = (pending?.id === ev.id ? pending.name : null) ?? (o ? c.rsc?.get?.(o.nameRsc) ?? o.name : null);
    if (pending?.id === ev.id) this.warPendingLook = null;
    if (!name || this.isOurs(name)) return;
    const g = war.parseGuildLine(ev.extra ?? '');
    if (g) war.recordMembership(name, g.guild, { source: 'look', rank: g.rank });
    else war.recordUnguilded(name);
  }

  scanForEnemies(c) {
    const s = this.s, room = s.world?.room?.num;
    if (!s.live || !c?.self || !(room > 1) || c.vitals?.()?.health?.value === 0) return;
    const now = this.now();
    let hostile = null;
    const unknown = [], ours = [];
    for (const o of c.room?.objects?.values?.() ?? []) {
      if (o.id === c.selfId || !(o.flags & OF.PLAYER)) continue;
      const name = c.rsc?.get?.(o.nameRsc) ?? o.name;
      if (!name) continue;
      const mine = this.isOurs(name);
      if (mine) { ours.push(name); continue; }
      const verdict = war.warHostility({ name, flags: o.flags }, { fleetmate: mine, now });
      if (verdict.hostile) {
        // Refused to us in this room: not engaged here, and not re-engaged on every object change.
        if ((o.flags & OF.ATTACKABLE) && !hostile && !this.targetRefused(name)) hostile = { o, name, verdict };
        continue;
      }
      if (!this.warSeen.has(o.id)) this.warSeen.set(o.id, now);
      if (!(o.flags & OF.GUILDMATE) && war.needsLook(name, { now })) unknown.push({ o, name });
    }
    if (this.warSeen.size > 512) this.warSeen.clear();
    // A fighter engages (which also raises the alarm); a sentinel only reports what it saw.
    if (hostile && this.warEnabled() && !this.warLeashed())
      this.beginWar(hostile.name, { basis: hostile.verdict.basis, why: hostile.verdict.why, room });
    else if (hostile) {
      this.warLast = { at: now, enemy: hostile.name, basis: 'sighted', room, reporter: null };
      this.raiseWarAlarm(hostile.name, 'sighted', room);
    }
    if (unknown.length && war.enemyGuilds().length) this.lookForGuild(c, unknown, ours, now);
  }

  lookForGuild(c, unknown, ours, now) {
    if (now - this.warLookAt < WAR_LOOK_EVERY_MS || typeof c.look !== 'function') return;
    // THE LOOK LEADER is the fleet character in this room whose name sorts first. Deterministic
    // and needs no messaging; if the leader is busy or dead, anyone looks after the fallback.
    const me = characterName(this.s, c);
    const leader = [me, ...ours.map(n => n.toLowerCase())].sort()[0] === me;
    const pick = unknown.find(u => leader || now - (this.warSeen.get(u.o.id) ?? now) >= WAR_LOOK_FALLBACK_MS);
    if (!pick) return;
    this.warLookAt = now;
    this.warPendingLook = { id: pick.o.id, name: pick.name, at: now };
    war.noteLooked(pick.name, { at: now });
    c.look(pick.o.id);
  }

  /** The server's own room flags for where the body stands: the world map carries the kod
   *  viPermanent_flags per room; a fixture may put them on s.world.room.flags instead. */
  roomFlagsHere() {
    const num = this.s.world?.room?.num;
    const f = this.s.world?.map?.rooms?.[String(num)]?.flags ?? this.s.world?.room?.flags;
    return Number.isFinite(Number(f)) ? Number(f) : 0;
  }

  /** Can a player be attacked in this room at all? NO_COMBAT forbids every swing, NO_PK every
   *  swing at a player. Guild-only rooms (Castle Victoria, 0x8) allow a guild war. */
  pvpForbiddenHere() {
    return (this.roomFlagsHere() & (ROOM_NO_COMBAT | ROOM_NO_PK)) !== 0;
  }

  beginWar(name, { basis, why, room, reporter = null }) {
    if (this.pvpEligibility?.() === false) return false;
    // THE GATE FOR BOTH ENTRY PATHS — the on-sight scan and another keeper's alarm both come
    // through here, and the scan re-runs on every object change, so a gate on the refusal path
    // alone would re-engage within a tick. Sighting alarms are still raised elsewhere: an inn is
    // a good lookout; it is only a bad place to swing.
    if (this.pvpForbiddenHere()) {
      const key = `${this.s.world?.room?.num}:${String(name).toLowerCase()}`;
      if (this.warSkippedRoom !== key) {
        this.warSkippedRoom = key;
        this.s.recorder?.line?.('combat', { event: 'war_skipped_no_combat_room', target: name,
          room: this.s.world?.room?.num, room_flags: this.roomFlagsHere() });
      }
      return false;
    }
    // THE SERVER ALREADY REFUSED US THIS PLAYER IN THIS ROOM (guild-only). Both entry paths --
    // the scan and a fleetmate's alarm -- come through here, so this is where it is held.
    if (this.targetRefused(name)) return false;
    // An operator's own combat order owns the body; the war does not take it away from them.
    if (this.active && !this.active.pvp) return false;
    const had = !!this.active?.pvp;
    const known = this.active?.pvp?.attackers?.some(a => a.character.toLowerCase() === name.toLowerCase());
    if (!known) {
      this.beginPvP({ character: name, text: reporter ? `zone alarm from ${reporter}: ${why}` : `at war: ${why}`,
        reason: reporter ? `${reporter} is fighting ${name} in this map; the room fights together`
                         : `${name} is at war with this fleet (${basis}); engage on sight`,
        reason_code: reporter ? 'zone_alarm' : 'guild_war' }, this.now());
      // A war engagement NEVER turns safety off; an incoming hit that already owned the body
      // keeps whatever it decided.
      if (this.active?.pvp && !had) this.active.keepSafety = true;
    }
    this.warLast = { at: this.now(), enemy: name, basis, room, reporter };
    if (!reporter) this.raiseWarAlarm(name, basis, room);
    return !!this.active?.pvp;
  }

  // ------------------------------------------------------------------ the swarm leash
  //
  // m59-war.mjs has the argument. War mode AND swarming: nobody engages an enemy unprovoked until
  // the operator says "go", attacks something, or the character he plays dies. Until then a
  // swarm character is a sentinel (it reports what it sees) that still fights back when hit.

  /** true while this swarm character must wait for the operator's word. */
  warLeashed() {
    if (!this.warbandEligibility?.()) { this.swarmSince = null; this.leashBooted = true; return false; }
    // Joined the swarm while this process watched: only a trigger after that counts. Started
    // mid-swarm (a war restart): inherit the fleet's unleash, unless it is ancient.
    this.swarmSince ??= this.leashBooted ? this.now() : this.now() - war.UNLEASH_MAX_MS;
    this.leashBooted = true;
    const l = war.readLeash();
    const since = Math.max(this.swarmSince, Number(l.hold_at) || 0);
    // THE OPERATOR ATTACKING ANYTHING unleashes: read off his own REQ_ATTACK (m59-proxy).
    const leadAt = Number(gear.readSwarmLeader()?.at);
    if (Number.isFinite(leadAt) && leadAt > since && leadAt > (Number(l.unleashed_at) || 0) && this.now() - leadAt < WARBAND_TARGET_MAX_AGE_MS)
      try { war.unleash({ at: leadAt, why: 'the operator attacked', by: this.character?.() ?? null }); } catch {}
    const unleashedAt = Math.max(Number(war.readLeash().unleashed_at) || 0,
      Number.isFinite(leadAt) && this.now() - leadAt < WARBAND_TARGET_MAX_AGE_MS ? leadAt : 0);
    return !(unleashedAt > since);
  }

  leashStatus() {
    const l = war.readLeash();
    return { swarming: !!this.warbandEligibility?.(), leashed: this.warLeashed(),
      unleashed_at: l.unleashed_at ?? null, why: l.unleash_why ?? null, hold_at: l.hold_at ?? null };
  }

  /** The operator's word, and his death, as the swarm hears them. */
  observeLeash(ev) {
    if (!this.warbandEligibility?.()) return;
    const leader = this.leaderCharacter?.();
    if (!leader) return;
    const me = this.character?.() ?? null, at = this.now();
    if (ev.kind === 'said' && war.normName(ev.name) === war.normName(leader)) {
      if (war.isGoOrder(ev.text)) try { war.unleash({ at, why: `${leader} said go`, by: me }); } catch {}
      else if (war.isHoldOrder(ev.text)) try { war.holdLeash({ at, why: `${leader} said hold`, by: me }); } catch {}
      return;
    }
    if (ev.kind !== 'message' || !ev.text) return;
    const text = String(ev.text).replace(/~[A-Za-z]/g, '');
    const died = parseDeathBroadcast(text)?.who ?? war.parseGuildCombat(text)?.victim ?? null;
    if (died && war.normName(died) === war.normName(leader))
      try { war.unleash({ at, why: `${leader} died: ${text}`, by: me }); } catch {}
  }

  raiseWarAlarm(enemy, basis, room = this.s.world?.room?.num) {
    if (!this.sentinelEnabled() || !(room > 1) || !enemy) return;
    const key = `${room}|${String(enemy).toLowerCase()}`, now = this.now();
    // A sighting repeats for as long as the enemy stands there; say it again only every
    // WAR_SIGHTING_EVERY_MS. An engagement or an attack is the room's call to arms and is fast.
    const every = basis === 'sighted' ? WAR_SIGHTING_EVERY_MS : WAR_ALARM_EVERY_MS;
    if (now - (this.warAlarmed.get(key) ?? 0) < every) return;
    this.warAlarmed.set(key, now);
    if (this.warAlarmed.size > 256) this.warAlarmed.clear();
    war.raiseAlarm({ room, reporter: this.character?.() ?? characterName(this.s, this.s.client), enemy, basis, at: now });
  }

  /** Another keeper's alarm. Joins the fight only when it names the map this character is in. */
  onWarAlarm(a) {
    if (!this.sentinelEnabled() || !a?.enemy) return false;
    const me = this.character?.() ?? characterName(this.s, this.s.client);
    if (this.isOurs(a.enemy)) return false;                  // never an alarm about one of ours
    // THE FLEET-WIDE WARNING. Every alarm, from any map, is the fleet's latest knowledge of
    // where an enemy is -- a sentinel's sighting in map 2 is what tells a guard in 39 to get
    // ready before anybody is hit. Kept here and reported in `combat status` (war.threat).
    this.warThreat = { enemy: a.enemy, room: Number(a.room), reporter: a.reporter ?? null,
      basis: a.basis ?? null, at: a.at ?? this.now() };
    if (!this.warEnabled() || this.warLeashed()) return false;
    if (String(a.reporter ?? '').toLowerCase() === String(me).toLowerCase()) return false;
    if (Number(a.room) !== this.s.world?.room?.num) return false;
    // A sighting in our map is a report, not a call to arms: our own scan sees the same enemy
    // and engages on its own terms. Only a fight in progress pulls the room in by alarm.
    if (a.basis === 'sighted') return false;
    return this.beginWar(a.enemy, { basis: a.basis ?? 'alarm', why: `${a.reporter} reported ${a.enemy}`,
      room: a.room, reporter: a.reporter ?? 'a fleetmate' });
  }

  // ------------------------------------------------------------------ PvP gear and the volley
  //
  // See tools/m59-pvp-gear.mjs for the mechanics. The gear goes on at the first engaging tick of a
  // PvP fight and comes off when the fight ends; `c.pvpGearActive` is what keeps the keeper's own
  // armSelf/wearBest/equipBest from swapping it back for the farming set in between.
  async pvpGearOn(o) {
    const c = o.client, s = this.s;
    o.pvpGearOn = true;
    c.pvpGearActive = true;
    const wear = gear.pvpItemsIn(c).filter(r => !r.worn);
    for (const r of wear) await s.pacer.submit('use', () => { c.use(r.o.id); });
    if (wear.length) { o.pvpGearWorn = wear.map(r => r.name); this.record('pvp_gear_on', o); }
  }

  pvpGearOff(o) {
    const c = o.client, s = this.s;
    if (!c?.pvpGearActive) return;
    c.pvpGearActive = false;
    const off = gear.pvpItemsIn(c).filter(r => r.worn);
    if (!off.length) return;
    // A fresh body command, like restoreSafety: the fight's own guard has just been cancelled.
    void withBodyCommand(s, () => withPacketScope(() => {}, () => s.pacer.submit('unuse', () => {
      for (const r of off) c.unuse(r.o.id);
    })), 'pvp-gear-off').then(() => this.record('pvp_gear_off', o)).catch(e => { this.pvpGearError = e.message; });
  }

  /**
   * The wand volley. WHAT to do is decided by `decideWandVolley` -- a private `pvpWand`
   * strategy if this machine has one, else gear.chooseWandVolley (one zap per wall-clock beat,
   * every keeper in the fight on the same beat). This method only builds the question and
   * sends the packets.
   * @returns {'hold'|null} 'hold' = no melee and no approach this tick.
   */
  async wandVolley(o) {
    const c = o.client, s = this.s;
    const cfg = gear.pvpGearConfig();
    this.spentWands ??= new Set();
    // A wand zap is an attack too (ReqSomethingAttack via CanPayCosts / ReqNewApply), so in a
    // no-combat room every beat is refused and the volley would keep firing into it. Checked
    // before any strategy is asked: no strategy may fire into a room that refuses it.
    if (this.pvpForbiddenHere()) return null;
    const wands = gear.volleyWandsIn(c, { spent: this.spentWands, cfg });
    // Bare "wand" rows are offered to a private strategy (ctx.unidentified); the built-in never
    // fires them, so a fleet with no pvpWand strategy behaves exactly as before.
    const unidentified = gear.unidentifiedWandsIn(c, { spent: this.spentWands })
      .filter(u => !wands.some(w => w.o.id === u.id));
    if (!wands.length && !unidentified.length) return null;
    const ctx = this.wandContext(o, wands, cfg, unidentified);
    const decision = await this.decideWandVolley(o, ctx);
    const hold = decision.hold ? 'hold' : null;
    if (decision.fire == null) return hold;
    // Claimed before any await: one zap per beat. advance() never overlaps itself (tick's
    // o.running), so claiming after the decision's own await is still exclusive.
    this.lastVolleyBeat = ctx.beat;
    this.lastWandFireAt = ctx.now;
    const pick = wands.find(w => w.o.id === decision.fire)
      ?? { ...unidentified.find(u => u.id === decision.fire), name: 'wand' };
    await this.stand(o);
    if (decision.face) await s.pacer.submit('turn', () => {
      const live = c.room.objects.get(o.targetId), me = c.self;
      if (!live || !me) return;
      c.face((Math.round(Math.atan2(live.row - me.row, live.col - me.col) * 180 / Math.PI) + 360) % 360);
    });
    await s.pacer.submit('cast', () => {
      const live = c.room.objects.get(o.targetId);
      if (!live) return;
      c.apply(pick.o.id, live.id);
      this.lastWandId = pick.o.id;
      o.zaps = (o.zaps ?? 0) + 1;
      o.wandShots = [...(o.wandShots ?? []), { at: this.now(), wand: pick.name, refused: false }].slice(-gear.SHOT_HISTORY);
      if (o.pvp) { o.pvp.zaps = (o.pvp.zaps ?? 0) + 1; o.pvp.last_wand = pick.name; o.pvp.wand_strategy = decision.strategy; }
      if (o.firstAttackAt == null) { o.firstAttackAt = this.now(); o.reactionMs = o.firstAttackAt - (o.triggeredAt ?? o.acceptedAt); }
      try { this.s.lastPlayerAttackAt = this.now(); } catch {}
      this.record('wand_volley', o);
    }, 1050);
    return hold;
  }

  /** The question a `pvpWand` strategy is asked: plain data, documented at gear.chooseWandVolley. */
  wandContext(o, wands, cfg, unidentified = []) {
    const c = o.client, now = this.now();
    const health = c.vitals?.()?.health ?? null;
    const t = c.room?.objects?.get(o.targetId), me = c.self;
    return {
      character: this.character?.() ?? characterName(this.s, c),
      now, volley_ms: cfg.volley_ms, beat: gear.beatOf(now, cfg.volley_ms),
      lastVolleyBeat: this.lastVolleyBeat ?? null, lastFireAt: this.lastWandFireAt ?? null,
      wands: wands.map(w => ({ id: w.o.id, name: w.name, timer: !!w.timer })),
      unidentified: unidentified.map(u => ({ id: u.id, translation: u.translation, colour: u.colour })),
      target: t ? { id: t.id, name: o.targetName ?? null, player: !!(t.flags & OF.PLAYER), row: t.row, col: t.col,
                    dist: me ? Math.hypot(t.row - me.row, t.col - me.col) : null } : null,
      me: me ? { row: me.row, col: me.col, hp: health?.value ?? null, max_hp: health?.max ?? null } : null,
      shots: (o.wandShots ?? []).map(x => ({ ...x })),
      pvp: !!o.pvp, warband: !!o.order?.warband, room: this.s.world?.room?.num ?? null,
    };
  }

  /**
   * Private strategy first, built-in otherwise. NEVER THROWS: a strategy that throws, answers
   * nonsense or is missing leaves the fight on the built-in volley, and says so once per fight.
   * The strategies are loaded once per process, like Session._askStrategies -- an edited
   * strategy takes effect when the keeper restarts.
   */
  /** This machine's private strategies, loaded once per process; the volley and the opener share them. */
  async combatStrategies() {
    let loaded = this.wandStrategies;
    if (loaded === undefined) {
      loaded = this.wandStrategies = null;
      try {
        const mod = await import('./m59-strategies.mjs');
        loaded = this.wandStrategies = await mod.load();
        const problems = loaded?.problems ?? [];
        if (problems.length) console.error('[strategies] ' + problems.map(p => `${p.file}: ${p.why}`).join('; '));
      } catch (e) { console.error(`[strategies] could not load for combat: ${e.message}`); }
    }
    return loaded;
  }

  async decideWandVolley(o, ctx) {
    const builtin = () => ({ ...gear.chooseWandVolley(ctx), strategy: 'builtin' });
    const loaded = await this.combatStrategies();
    const asked = (loaded?.strategies ?? []).filter(st => st.enabled && typeof st.pvpWand === 'function');
    for (const st of asked) {
      let answer;
      try { answer = await st.pvpWand(ctx); }
      catch (e) { this.noteWandStrategyFault(o, st.name, `threw: ${e.message}`); continue; }
      if (answer == null) continue;
      const checked = gear.checkWandAnswer(answer, ctx);
      if (checked.invalid) { this.noteWandStrategyFault(o, st.name, checked.invalid); continue; }
      return { ...checked, strategy: st.name };
    }
    return builtin();
  }

  // ------------------------------------------------------------------ the pvpOpener seam
  //
  // A PRIVATE STRATEGY MAY CLAIM A FIGHT BEAT BEFORE THE GEAR, THE VOLLEY AND THE SWING -- a caster
  // opening with a spell at the enemy before it does anything else. It answers ABOUT the target
  // this fight already chose; it never chooses one. Who is fought is decided above this (war
  // book, grudge book, an incoming hit, an operator's order) and nothing here widens it.
  //   ctx    = { agent, character, target: { id, name, player, dist }, mana, max_mana,
  //             spells: [known, lowercase], pack: { item: count }, now, last_cast_at, last_spell,
  //             pvp, warband, room, heard: [{ at, kind, text }] }
  //   heard  = what this keeper heard in THIS room over the last few minutes (messages and room
  //             speech, colour codes stripped): a room enchantment announces itself going up and
  //             coming down, and that is the only way to know it is up.
  //   answer = { cast: '<spell it knows>', target?: 'target' | 'self' | 'none' }
  //                                           cast it this beat; at the fight's target by default,
  //                                           at nothing for a room spell, at itself for a buff
  //          | { wait: true }                 send nothing this beat, and do not fall through
  //          | null                           decline: the fight goes on as it always did
  // Never throws. A fault (a throw, an unknown spell, a malformed answer) is reported once per
  // fight and the fight goes on as if the strategy had declined.
  async pvpOpener(o, target) {
    if (this.pvpForbiddenHere()) return false;
    const loaded = await this.combatStrategies();
    const asked = (loaded?.strategies ?? []).filter(st => st.enabled && typeof st.pvpOpener === 'function');
    if (!asked.length) return false;
    const c = o.client, me = c.self;
    if (!me || !target) return false;
    const known = (c.spells ?? []).map(sp => exactName(c, sp)).filter(Boolean);
    const pack = {};
    for (const it of c.inventory ?? []) {
      const n = exactName(c, it);
      if (n) pack[n] = (pack[n] ?? 0) + (Number(it.amount) || 1);
    }
    const mana = c.vitals?.()?.mana ?? null;
    const ctx = { agent: this.agentId ?? null, character: this.character?.() ?? characterName(this.s, c),
      target: { id: target.id, name: o.targetName ?? null, player: !!(target.flags & OF.PLAYER),
                dist: Math.hypot(target.row - me.row, target.col - me.col) },
      mana: mana?.value ?? null, max_mana: mana?.max ?? null, spells: known, pack, now: this.now(),
      last_cast_at: o.openerAt ?? null, last_spell: o.openerSpell ?? null,
      pvp: !!o.pvp, warband: !!o.order?.warband, room: this.s.world?.room?.num ?? null,
      heard: this.heardHere() };
    for (const st of asked) {
      let answer;
      try { answer = await st.pvpOpener(ctx); }
      catch (e) { this.noteOpenerFault(o, st.name, `threw: ${e.message}`); continue; }
      if (answer == null) continue;
      if (answer.wait === true && answer.cast == null) { o.openerWaiting = st.name; return true; }
      const name = typeof answer.cast === 'string' ? answer.cast.trim().toLowerCase() : null;
      const spell = name && (c.spells ?? []).find(sp => exactName(c, sp) === name);
      if (!spell) { this.noteOpenerFault(o, st.name, name ? `named a spell it does not know: ${name}` : 'answered neither cast nor wait'); continue; }
      const aim = answer.target ?? 'target';
      if (!['target', 'self', 'none'].includes(aim)) { this.noteOpenerFault(o, st.name, `target must be target, self or none, not ${aim}`); continue; }
      o.openerAt = this.now(); o.openerSpell = name; o.openerWaiting = null;
      await this.stand(o);
      await this.s.pacer.submit('cast', () => {
        const live = c.room.objects.get(o.targetId);
        if (!live) return;
        c.cast(spell.id, aim === 'none' ? [] : [aim === 'self' ? c.selfId : live.id]);
        o.casts++; o.openerCasts = (o.openerCasts ?? 0) + 1;
        if (o.pvp) { o.pvp.opener_casts = (o.pvp.opener_casts ?? 0) + 1; o.pvp.opener = { strategy: st.name, spell: name }; }
        if (o.firstAttackAt == null) { o.firstAttackAt = this.now(); o.reactionMs = o.firstAttackAt - (o.triggeredAt ?? o.acceptedAt); }
        try { this.s.lastPlayerAttackAt = this.now(); } catch {}
        this.record('opener_cast', o);
      }, 1050);
      return true;
    }
    return false;
  }

  /** What this keeper heard, kept briefly for the opener: a room enchantment says so out loud. */
  hear(ev) {
    if (!ev.text) return;
    this.heard ??= [];
    this.heard.push({ at: this.now(), room: this.s.world?.room?.num ?? null, kind: ev.kind,
                      text: String(ev.text).replace(/~[A-Za-z]/g, '').trim() });
    if (this.heard.length > HEARD_MAX) this.heard.splice(0, this.heard.length - HEARD_MAX);
  }

  heardHere() {
    const room = this.s.world?.room?.num ?? null, since = this.now() - HEARD_MS;
    return (this.heard ?? []).filter(h => h.at >= since && h.room === room).map(h => ({ at: h.at, kind: h.kind, text: h.text }));
  }

  noteOpenerFault(o, strategy, why) {
    o.openerFaults ??= new Set();
    if (o.openerFaults.has(strategy)) return;
    o.openerFaults.add(strategy);
    console.error(`[strategies] ${strategy} pvpOpener ${why}; the fight goes on without it`);
    if (o.pvp) o.pvp.opener_fault = { strategy, why };
    this.record('opener_strategy_fault', o);
  }

  noteWandStrategyFault(o, strategy, why) {
    o.wandStrategyFaults ??= new Set();
    if (o.wandStrategyFaults.has(strategy)) return;
    o.wandStrategyFaults.add(strategy);
    console.error(`[strategies] ${strategy} pvpWand ${why}; using the built-in volley`);
    if (o.pvp) o.pvp.wand_strategy_fault = { strategy, why };
    this.record('wand_strategy_fault', o);
  }

  // ------------------------------------------------------------------ WARBAND COMBAT
  //
  // SWARM ON = WARBAND. The terminal's S key hands every other fleet character's movement and work
  // to `swarm/<leader>@terminal`, and the proxy writes whatever the operator attacks to
  // swarm-leader.json. A keeper whose claim is held by a swarm is in the warband, and every 250ms
  // (keeper process) it:
  //   * focus-fires the LEADER'S target -- player or monster -- whenever it is in this character's
  //     room: a warband attack order on that object id, which puts on the PvP gear and fires the 2s
  //     wand volley like any PvP fight. The target STANDS until it is dead or the leader issues a
  //     new one (operator, 2026-09-30) -- not while the leader keeps swinging. Safety stays ON (an
  //     `attack`, never a `kill`), so an innocent the leader swings at is refused by the server
  //     and dropped; a fleetmate, host or guildmate the leader swings at is never a target at all;
  //   * when not fighting, and if this character is a named buffer (pvp-gear warband_buffs), keeps
  //     EVERY warband ally in its room -- itself and the leader included -- buffed: the operator's
  //     rule is that the warband is collectively buffed and ready.
  // Movement between fights stays with the swarm driver; this owns the body only while it fights.
  async warbandTick() {
    const s = this.s, c = s.client;
    const leaving = why => { if (this.active?.order?.warband || this.active?.order?.keepoff) this.stop(why); };
    if (!this.warbandEligibility?.()) { leaving('warband ended: no longer swarm-held'); return; }
    if (!s.live || !c?.self || c.vitals?.()?.health?.value === 0) return;
    this.keepoffTrack();
    if (this.active?.pvp) return;                       // a war fight already owns the body
    // THE STANDING TARGET. A new target from the leader -- a different id, or the same id attacked
    // again after it was finished -- replaces it; nothing else does. An entry older than
    // WARBAND_TARGET_MAX_AGE_MS is never taken up: object ids are recycled within hours, and a
    // target from a previous session would name something else.
    const lead = gear.readSwarmLeader();
    const leadAt = Number(lead?.at), leadId = Number(lead?.target);
    const w = this.warbandTarget;
    if (Number.isSafeInteger(leadId) && Number.isFinite(leadAt) && this.now() - leadAt < WARBAND_TARGET_MAX_AGE_MS &&
        (!w || w.id !== leadId || (w.done && leadAt > w.at)))
      this.warbandTarget = { id: leadId, at: leadAt, name: null, seenInRoom: null, done: false };
    const target = this.warbandTarget;
    const room = s.world?.room?.num;
    let t = target && !target.done ? c.room?.objects?.get?.(target.id) : null;
    const name = t ? String(c.rsc?.get?.(t.nameRsc) ?? t.name ?? '') : '';
    if (target && !target.done) {
      if (t) {
        // The same id on a different thing is a RECYCLED id, not our target: it died.
        if (target.name && name.toLowerCase() !== target.name.toLowerCase()) { target.done = 'id recycled'; t = null; }
        else {
          target.name ??= name; target.seenInRoom = room; target.player = !!(t.flags & OF.PLAYER);
          target.lastAt = { room, row: t.row, col: t.col, at: this.now() }; target.goneAt = null;
        }
      } else if (target.seenInRoom != null && target.seenInRoom === room) {
        // Gone from the room we saw it in, while we are still standing in it: dead, fled -- or, for
        // a player who is also off the server's player list, LOGGED OFF, which takes the keep-off
        // lock (m59-keepoff.mjs). The list removal can trail the room removal by a packet or two,
        // so a player still listed is given a moment before being called gone.
        if (target.player && target.name && this.playerOnline(target.name) === false) {
          this.lockLoggedOff(target.name, target.lastAt); target.done = 'logged off';
        } else if (target.player && this.now() - (target.goneAt ??= this.now()) < 2000) { /* wait for the list */ }
        else target.done = 'gone from the room';
      }
      // NEVER ONE OF OURS. The operator may swing at a fleetmate by accident; the warband does not
      // follow, and the target is dropped rather than retried.
      if (t && (this.isOurs(name) || (t.flags & OF.GUILDMATE))) { target.done = 'a fleetmate'; t = null; }
    }
    const ok = !!t && t.id !== c.selfId && (t.flags & OF.ATTACKABLE) &&
      !((t.flags & OF.PLAYER) && this.targetRefused(name)) && !this.pvpForbiddenHere();
    if (this.active?.order?.warband) {
      if (ok && this.active.order.target === t.id) return;
      this.stop(ok ? 'warband: the leader switched target' : 'warband: the leader\'s target is gone');
    }
    // The leader naming a NEW target here outranks waiting at a ghost or rushing a login.
    if (ok && this.active?.order?.keepoff && target.at > this.active.acceptedAt)
      this.stop('keep-off: the leader named a new target');
    if (ok && !this.active) {
      try {
        this.issue({ action: 'attack', target: t.id, warband: true, command_id: `warband-${t.id}`,
          select_map: s.world?.room?.num, repeat: true });
        this.warbandLast = { at: this.now(), target: t.id, name };
      } catch (e) { this.warbandError = e.message; }
      return;
    }
    await this.keepoffTick();
    if (!this.active) await this.warbandBuff().catch(e => { this.warbandError = e.message; });
    if (!this.active) await this.swarmFollowTick().catch(e => { this.swarmFollowError = e.message; });
  }

  // ------------------------------------------------------------------ SWARM FOLLOW
  //
  // tools/m59-swarm-follow.mjs has the argument. A member of the swarm holds a WEDGE slot behind
  // the leader while he is in its room, goes through the door he took when he leaves it, walks to
  // the room the driver last saw him in when it never saw him go, and walks back to the room it
  // joined from when the swarm ends. It runs only when nothing else owns the body: a fight order,
  // a PvP fight and a buff all come first, and a body below its own flee line is left to survival.
  //
  // `this.swarmContext()` is installed by the keeper process: membership, the leader's character,
  // the members' characters, the driver's sighting of the leader's room, and this agent's home.
  async swarmFollowTick() {
    const ctx = this.swarmContext?.();
    if (!ctx?.member || this.swarmMoving) return;
    // PACED. A follow leg is at most one a second: back-to-back legs at a slot the body cannot
    // quite reach kept a lab keeper's packet pacer so busy that its own fresh state reads starved
    // and the broker could not see the character at all.
    if (this.now() - (this.swarmLegAt ?? 0) < swarm.LEG_GAP_MS) return;
    const s = this.s, c = s.client, me = c?.self, room = s.world?.room?.num;
    if (!me || !(room > 1) || this.active) return;
    const hp = c.vitals?.()?.health;
    const flee = Number(this.keeper?.()?.policy?.fleeBelow ?? 0.45);
    if (hp?.max > 0 && hp.value / hp.max < flee) { this.swarmFollow = { at: this.now(), why: 'below the flee line' }; return; }

    // EVERY LEG HAS A DEADLINE, and missing it cancels that leg's own token and nothing else. A
    // lab follower started a walk from a pocket it could not leave; the walk never returned, the
    // "moving" flag stayed up, and the follower ignored its leader for the rest of the swarm.
    const leg = async (ms, fn) => {
      const token = `swarm-follow-${randomUUID()}`;
      let timer;
      const late = new Promise(resolve => { timer = setTimeout(() => {
        s.cancelledMovementTokens?.add?.(token);
        resolve({ arrived: false, moved: false, reason: `swarm leg over its ${Math.round(ms / 1000)}s deadline` });
      }, ms); });
      try { return await Promise.race([fn(token), late]); } finally { clearTimeout(timer); }
    };
    const go = async (dest, why) => {
      this.swarmLegAt = this.now();
      this.swarmMoving = true;
      this.swarmFollow = { at: this.now(), travelling_to: dest, why };
      try {
        const r = await leg(swarm.TRAVEL_LEG_MS, token => s.travel(dest, { origin: keeperOrigin('swarm_follow', { leader: ctx.leader }),
                                         movementGeneration: s.movementGeneration, controlToken: token }));
        this.swarmFollow = { at: this.now(), arrived: !!r?.arrived, room: s.world?.room?.num, why,
                             ...(r?.arrived ? {} : { reason: r?.reason ?? null }) };
      } finally { this.swarmMoving = false; }
    };

    if (ctx.phase === 'returning') {
      if (ctx.home > 1 && room !== ctx.home) await go(ctx.home, 'swarm ended: back where it joined');
      return;
    }

    const wanted = String(ctx.leaderCharacter ?? '').toLowerCase();
    const nameOf = o => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
    const players = [...(c.room?.objects?.values?.() ?? [])].filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER));
    const leader = wanted ? players.find(o => nameOf(o) === wanted) : null;

    if (leader) {
      const at = { row: leader.row, col: leader.col };
      const prev = this.swarmLeaderSeen;
      // HEADING FROM HIS FEET, not from his facing: a moved leader faces where he walked, and the
      // squares are unambiguous where an angle convention is not.
      let heading = prev?.room === room ? prev.heading : null;
      if (prev?.room === room && swarm.chebyshev(prev, at) >= 1) heading = swarm.headingBetween(prev, at) ?? heading;
      const memberChars = new Map([...ctx.members].map(([a, ch]) => [String(ch ?? '').toLowerCase(), a]));
      const present = players.map(o => memberChars.get(nameOf(o))).filter(Boolean);
      if (!heading) {
        const followers = players.filter(o => memberChars.has(nameOf(o))).map(o => ({ row: o.row, col: o.col }));
        heading = swarm.restingHeading(at, [...followers, { row: me.row, col: me.col }]);
      }
      this.swarmLeaderSeen = { room, row: at.row, col: at.col, heading, at: this.now() };
      const index = swarm.slotIndex(ctx.me, present);
      const slot = swarm.wedgeSlot(at, heading, index);
      // NEVER "IN SLOT" ON HIS SQUARE. Slack is a square, so a follower standing on the leader --
      // which is where everyone lands after following him through a door, the arrival square --
      // counted as in position, and the whole swarm stood stacked in the doorway (lab, 2026-10-06).
      const onLeader = me.row === at.row && me.col === at.col;
      if (!onLeader && swarm.chebyshev(me, slot) <= swarm.SLACK) { this.swarmFollow = { at: this.now(), in_slot: slot }; return; }
      // ITS OWN SLOT FIRST, THEN THE REST OF THE WEDGE, THEN ANYWHERE BY HIM. A slot can sit on
      // ground this body cannot walk to from where it stands -- behind a counter, or out of a
      // pocket the fine grid will not plan through -- and a follower that only ever tried its own
      // slot would stand still for the whole swarm.
      const candidates = [slot, ...[1, 2, 3, 4].map(k => swarm.wedgeSlot(at, heading, index + 2 * k)), at];
      // A STEP THE MOVER REFUSED IS NOT RETRIED for a few seconds. The planner does not see bodies
      // and the mover does, so the obvious step can be a square somebody is standing on; asking
      // for it again every 250 ms is a follower that never moves (measured in the lab).
      const refused = (this.swarmRefused ??= new Map());
      for (const [k, until] of refused) if (until < this.now()) refused.delete(k);
      let next = null, goal = null;
      for (const g of candidates) {
        next = safeCombatStep(s, { row: g.row, col: g.col, exact: false });
        if (next && !(next.row === at.row && next.col === at.col) && !refused.has(`${g.row},${g.col}`)) { goal = g; break; }
        next = null;
      }
      if (!next || (next.row === at.row && next.col === at.col)) {
        // SAY WHY, because "stuck" is the question this status exists to answer: where it stands,
        // and what the planner said about the slot from there.
        const geo = s.world?.geometry;
        let plan = null;
        try { const p = geo?.path?.(me.row, me.col, slot.row, slot.col); plan = p ? { found: !!p.found, steps: p.steps?.length ?? null, reason: p.reason ?? null } : null; }
        catch (e) { plan = { error: e.message }; }
        this.swarmFollow = { at: this.now(), slot, from: { row: me.row, col: me.col }, plan,
                             why: 'no safe step toward the wedge or the leader from here' };
        return;
      }
      // THE FINE MOVER, NOT A SQUARE STEP. `s.step` to the next square reported `moved: true` while
      // the body stayed put (lab, two followers overlapping on one square): a square step is a
      // summary, and the body moves in fine units. `walkFine` to the goal square's CENTRE is the
      // validated walk the jump work relies on; a short leg, so a moving leader is re-aimed each tick.
      const centre = squareCentre(goal.row, goal.col);
      const fromXY = { x: me.x, y: me.y };
      const before = Math.hypot(Number(me.x) - centre.x, Number(me.y) - centre.y);
      this.swarmLegAt = this.now();
      this.swarmMoving = true;
      let r = null;
      try {
        r = await leg(swarm.ROOM_LEG_MS, token => withBodyCommand(s, () => s.walkFine(centre.x, centre.y, {
          maxSteps: 6, arriveWithin: 24, controlToken: token }), 'swarm-follow'));
      } finally { this.swarmMoving = false; }
      const moved = Number.isFinite(fromXY.x) && (c.self?.x !== fromXY.x || c.self?.y !== fromXY.y);
      // PROGRESS, NOT MOTION. A leg that moved the body without bringing it closer to the goal
      // (sliding along a body or a wall) is as stuck as one that did not move, and the next slot
      // is tried instead -- the lab follower that "moved" every leg and never arrived.
      const after = Math.hypot(Number(c.self?.x) - centre.x, Number(c.self?.y) - centre.y);
      const closer = Number.isFinite(after) && after < before - 8;
      if (!closer) refused.set(`${goal.row},${goal.col}`, this.now() + 8_000);
      this.swarmFollow = { at: this.now(), stepping_to: goal, slot, moved,
                           ...(moved ? {} : { refused: r?.reason ?? r?.why ?? r?.error ?? null }) };
      return;
    }

    // NOT HERE. The door we saw him take beats the driver's sighting: it is ours, and it is now.
    const seen = this.swarmLeaderSeen;
    let dest = null, why = null;
    if (seen?.room === room && this.now() - seen.at < 20_000) {
      const exit = swarm.inferExit(s.world?.map?.rooms?.[String(room)], seen);
      if (exit) { dest = exit.to; why = `followed him through the ${exit.via}`; }
    }
    if (dest == null && ctx.leaderRoom > 1 && ctx.leaderRoom !== room) {
      dest = ctx.leaderRoom; why = 'walking to the room he was last seen in';
    }
    if (dest == null) { this.swarmFollow = { at: this.now(), why: 'leader not here and not located' }; return; }
    this.swarmLeaderSeen = null;
    await go(dest, why);
  }

  // ------------------------------------------------------------------ the keep-off lock
  //
  // tools/m59-keepoff.mjs has the argument. A warband target who LOGS OFF is locked by name at the
  // square he left; `keepoff_waiters` swarm characters (default 2) wait near his ghost, and when the
  // server announces his login (BP_PLAYER_ADD, which every client receives for every player) every
  // swarm character not already in a PvP fight rushes the ghost's map and attacks. Safety stays on
  // throughout -- an `ambush`, never a `kill` -- so somebody the server will not let us hit ends
  // the lock instead of being swung at for ever.

  /** true / false from the server's player list; null when this client has no list to ask. */
  playerOnline(name) {
    const list = this.s.client?.playersOnline;
    if (!list?.size) return null;
    const want = keepoff.norm(name);
    for (const p of list.values()) if (keepoff.norm(p?.name) === want) return true;
    return false;
  }

  lockLoggedOff(name, seen) {
    if (!name || this.isOurs(name)) return null;
    const now = this.now();
    const pos = seen && now - seen.at < 15_000 ? { room: seen.room, row: seen.row, col: seen.col } : {};
    try {
      // A room the server forbids combat in (an inn) is not worth waiting in: locked, not waited.
      const noCombat = pos.room != null && pos.room === this.s.world?.room?.num && this.pvpForbiddenHere();
      const l = keepoff.markOffline(name, { ...pos, at: now, by: this.character?.() ?? null, noCombat });
      this.keepoffLast = { at: now, event: 'locked', name, room: l?.room ?? null };
      return l;
    } catch (e) { this.keepoffError = e.message; return null; }
  }

  /** Where each locked player was last seen by this keeper: the square a re-logoff leaves a ghost on. */
  keepoffTrack() {
    const c = this.s.client, room = this.s.world?.room?.num;
    if (!c?.room?.objects) return;
    const locks = keepoff.activeLocks({ now: this.now(), ttl: gear.pvpGearConfig().keepoff_ms });
    if (!locks.length) return;
    this.keepoffSeen ??= new Map();
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId) continue;
      const n = exactName(c, o);
      const l = locks.find(x => keepoff.norm(x.name) === n);
      if (!l) continue;
      if (o.flags & OF.PLAYER) this.keepoffSeen.set(n, { room, row: o.row, col: o.col, at: this.now() });
      // HIS GHOST: same name, not a player. It is where he will come back, to the square.
      else if (l.offline && (l.room !== room || l.row !== o.row || l.col !== o.col)) {
        try { keepoff.notePosition(l.name, { room, row: o.row, col: o.col }); } catch {}
      }
    }
  }

  issueKeepoff(l, role) {
    try {
      return this.issue({ action: 'ambush', target: l.name, map: l.room, position: { row: l.row, col: l.col },
        keepoff: role, repeat: true, ttl_ms: role === 'rush' ? 600_000 : 1_800_000,
        command_id: `keepoff-${role}-${keepoff.norm(l.name)}-${l.offline ? l.offline_at : l.online_at}` });
    } catch (e) { this.keepoffError = `${role} ${l.name}: ${e.message}`; return null; }
  }

  /** Idle and swarm-held: take a waiter slot at a logged-off target's ghost. */
  async keepoffTick() {
    const cfg = gear.pvpGearConfig(), now = this.now(), room = this.s.world?.room?.num;
    const a = this.active;
    if (a?.order?.keepoff === 'wait') { try { keepoff.heartbeatWaiter(a.order.target, this.agentId, { now }); } catch {} return; }
    if (a || !cfg.keepoff_waiters) return;
    const locks = keepoff.activeLocks({ now, ttl: cfg.keepoff_ms })
      .filter(l => l.offline && l.room > 1 && l.row != null && !l.no_combat)
      .sort((x, y) => (y.room === room) - (x.room === room));
    for (const l of locks) {
      // Those already in his map get first claim; everybody else only after five seconds.
      if (l.room !== room && now - Number(l.offline_at) < 5000) continue;
      if (this.keepoffRefusedAt?.[keepoff.norm(l.name)] > now - 60_000) continue;
      let mine = false;
      try { mine = keepoff.claimWaiter(l.name, this.agentId, { max: cfg.keepoff_waiters, now, ttl: cfg.keepoff_ms }); } catch { mine = false; }
      if (!mine) continue;
      const r = this.issueKeepoff(l, 'wait');
      if (r?.accepted) { this.keepoffLast = { at: now, event: 'waiting', name: l.name, room: l.room }; return; }
      (this.keepoffRefusedAt ??= {})[keepoff.norm(l.name)] = now;
      try { keepoff.releaseWaiter(l.name, this.agentId); } catch {}
    }
  }

  /** The server's player list moved: a locked player logged on or off. */
  onPlayerListEvent(ev) {
    if (!ev?.name || !this.warbandEligibility?.()) return;
    const cfg = gear.pvpGearConfig(), now = this.now(), n = keepoff.norm(ev.name);
    if (ev.kind === 'logged-off') {
      const w = this.warbandTarget;
      const isTarget = !!(w && w.player && w.name && keepoff.norm(w.name) === n && w.done !== 'a fleetmate');
      if (!isTarget && !keepoff.lockOf(ev.name, { now, ttl: cfg.keepoff_ms })) return;
      // A rusher lets go; waiters (everybody) re-claim at the ghost he has just left.
      if (this.active?.order?.keepoff && keepoff.norm(this.active.order.target) === n) this.stop('keep-off: he logged off again');
      const seen = isTarget && w.lastAt && now - w.lastAt.at < 15_000 ? w.lastAt : this.keepoffSeen?.get(n);
      this.lockLoggedOff(ev.name, seen);
      if (isTarget && !w.done) w.done = 'logged off';
      return;
    }
    if (ev.kind !== 'logged-on') return;
    const l = keepoff.lockOf(ev.name, { now, ttl: cfg.keepoff_ms });
    if (!l) return;
    try { keepoff.markOnline(ev.name, { at: now }); } catch {}
    this.keepoffLast = { at: now, event: 'logged on', name: l.name, room: l.room };
    if (!cfg.keepoff_rush || !(l.room > 1) || l.row == null || l.no_combat) return;
    const a = this.active;
    if (a?.pvp || a?.order?.keepoff) return;             // already fighting a person, or already there
    // "Not currently doing PvP fighting": a warband fight against a PLAYER is one; a monster is not.
    if (a?.order?.warband && a.phase === 'engaging' && (a.client?.room?.objects?.get?.(a.targetId)?.flags & OF.PLAYER)) return;
    const r = this.issueKeepoff(l, 'rush');
    if (r?.accepted) this.keepoffLast = { at: now, event: 'rushing', name: l.name, room: l.room };
  }

  async warbandBuff() {
    const cfg = gear.pvpGearConfig();
    const spells = cfg.warband_buffs?.[this.agentId] ?? [];
    if (!spells.length || this.warbandBuffing) return;
    if (this.now() - (this.warbandBuffAt ?? 0) < cfg.warband_rebuff_ms) return;
    const s = this.s, c = s.client;
    const known = spells.map(n => (c.spells ?? []).find(sp => exactName(c, sp) === String(n).toLowerCase())).filter(Boolean);
    if (!known.length) return;
    // Every ally in the room: ourselves by object id (a caster's own name does not resolve as a
    // target), and every fleet character we can see -- the leader among them.
    const allies = [c.selfId, ...[...(c.room?.objects?.values?.() ?? [])]
      .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER) && this.isOurs(c.rsc?.get?.(o.nameRsc) ?? o.name))
      .map(o => o.id)];
    this.warbandBuffing = true;
    this.warbandBuffAt = this.now();
    try {
      await withBodyCommand(s, () => withPacketScope(() => {}, async () => {
        for (const ally of allies) for (const sp of known) {
          if (this.active) return;                      // a fight started: stop buffing
          await s.pacer.submit('cast', () => { c.cast(sp.id, [ally]); }, 1500);
        }
      }), 'warband-buff');
      this.warbandBuffed = { at: this.now(), allies: allies.length, spells: known.map(sp => exactName(c, sp)) };
    } finally { this.warbandBuffing = false; }
  }

  /** Cross the internal door that leads toward the target, if the room has one. true when tried. */
  async crossDoorToward(o, target) {
    const s = this.s, c = o.client;
    if (typeof s.crossSameRoomDoor !== 'function' || !s.world?.map || !s.world?.geometry || !c.self) return false;
    let plan = null;
    try {
      plan = sameRoomDoorPlan(s.world.map, s.world.room?.num, s.world.geometry, c.self,
        [{ row: target.row, col: target.col }]);
    } catch { plan = null; }
    const door = plan?.doors?.[0];
    if (!door) return false;
    await this.stand(o);
    const result = await s.crossSameRoomDoor(door, { movementGeneration: s.movementGeneration })
      .catch(e => ({ crossed: false, reason: e.message }));
    o.lastDoor = { at: this.now(), stand_on: { row: door.row, col: door.col },
      lands: { row: door.arriveRow, col: door.arriveCol }, crossed: result?.crossed === true, why: result?.reason ?? null };
    this.record('pvp_door', o);
    return true;
  }

  // A wand that has run out stays in the pack (a broken SpecialWand) or is deleted (a SpellItem
  // wand); either way it must not be picked again. "Nothing happens" is the attack timer refusing
  // a zap -- no charge spent -- and is only recorded.
  noteWandMessage(text) {
    if (/is broken|has no more charges|shatters into pieces|is out of charges/i.test(text) && this.lastWandId != null)
      this.spentWands?.add(this.lastWandId);
    if (/point your wand but nothing happens/i.test(text) && this.active) {
      // Marked on the shot it answers, so a strategy can see a refusal streak (gear.SHOT_HISTORY).
      const last = this.active.wandShots?.at(-1);
      if (last) last.refused = true;
      this.record('wand_refused', this.active);
    }
  }

  targetAtWar(o) {
    const t = o?.targetId != null ? o.client?.room?.objects?.get?.(o.targetId) : null;
    return !!(t && (t.flags & OF.ENEMY));
  }

  // Safety comes off only for a kill that needs it: never for a war engagement, and never for a
  // target the server marks as a mutual-war enemy (CheckStatusAndSafety, player.kod:3803).
  needsSafetyOff(o) {
    return !!(o && o.order.action === 'kill' && !o.keepSafety && !this.targetAtWar(o));
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
    if (result.direction === 'incoming') {
      // THEIR STROKE REACHED US, so AllowGuildAttack (symmetric) no longer refuses them: a
      // guild-only refusal of this player here is stale. Forgotten FIRST, so return fire below
      // runs exactly as it would for anybody else (m59-refused-targets.mjs forgetRefused).
      try { forgetRefused(this.s, result.character, { source: 'incoming_' + result.outcome }); } catch {}
      this.beginPvP(result, ev.at);
      // THE VICTIM IS THE ONLY ONE WHO HEARS THIS LINE, so it is the one fact the room does
      // not already share. Say it, so every fleet character in this map fights with us.
      if (this.active?.pvp) this.raiseWarAlarm(result.character, 'attacked');
    }
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
        line.startsWith(n.toLowerCase() + "'s ") || line.startsWith(n.toLowerCase() + 'â€™s '))) continue;
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
    // A PLAYER THE SERVER WILL NOT LET US HIT HERE is not somebody return fire can answer. The
    // body is NOT taken: the keeper's ordinary ladder (flee below the line, rest when safe) is
    // the survival that applies, exactly as for anything else hurting us that we will not fight.
    // Inside a fight that already owns the body they are still counted, just never targeted.
    if (!this.active?.pvp && this.targetRefused(evidence.character)) {
      const key = `${s.world.room.num}|${String(evidence.character).toLowerCase()}`;
      if (this.pvpRefusedNoted !== key) {
        this.pvpRefusedNoted = key;
        s.recorder?.line?.('combat', { event: 'pvp_attacker_refused_here', target: evidence.character,
          room: s.world.room.num, text: evidence.text ?? null,
          survival: 'keeper ladder; this player cannot be attacked in this room' });
      }
      return;
    }
    const at = Math.min(this.now(), Number.isFinite(observedAt) ? observedAt : this.now());
    let o = this.active;
    if (!o?.pvp) {
      const decision = chooseSurvivalDecision(s, { strategy: 'pvp_return_fire', status: 'active',
        reason: evidence.reason ?? `attacked by ${evidence.character}; return fire until the threat leaves or we die`,
        reason_code: evidence.reason_code ?? 'confirmed_player_attack', source: 'combat',
        mitigation: 'ordinary HP floors, shelter and healing cannot stop return fire' },
      { because: 'confirmed player attack supersedes ordinary recovery' });
      this.stop('superseded by confirmed player attack', { preserveId: decision.id });
      s.combatEpoch = (s.combatEpoch ?? 0) + 1;
      s.fightGeneration = (s.fightGeneration ?? 0) + 1;
      const id = randomUUID();
      withBodyCommand(s, () => s.cancelMovement(null, 'PvP survival: return fire', { preserveId: decision.id, origin: keeperOrigin('pvp_survival') }), id);
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
    const seen = p.attackers.map(a => ({ a, target: combatTarget(c, a.character) })).filter(x => x.target);
    // Refused to us in this room: still in the room, never a target (m59-refused-targets.mjs).
    const present = seen.filter(x => !this.targetRefused(x.a.character));
    if (!present.length && seen.length) {
      this.stop('PvP: every attacker here cannot be attacked in this room (guild-only); ' +
        'survival returns to the keeper ladder'); return false;
    }
    if (present.length && p.shelter?.status === 'approaching') {
      this.interruptPvPShelter(o, 'player attacker present; return fire takes priority');
      withBodyCommand(s, () => s.cancelMovement(null, 'PvP attacker interrupted monster shelter',
        { preserveId: p.decision_id, origin: keeperOrigin('pvp_survival') }), o.id);
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
    const target = combatTarget(c, order.target, { anyAttackable: !!order.warband });
    if (typeof order.target === 'number') demand(target && (target.flags & OF.ATTACKABLE),
      'exact player is not here or not attackable; use a player name to wait');
    // Refused to us in this room already: an order here would only be refused again.
    const refusedName = order.action === 'ambush' ? null
      : target && (target.flags & OF.PLAYER) ? exactName(c, target) : typeof order.target === 'string' ? order.target : null;
    if (refusedName && this.targetRefused(refusedName))
      return { accepted: false, skipped: true, reason: `${refusedName} cannot be attacked in this room (guild-only)`,
        map: s.world.room.num };
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
    withBodyCommand(s, () => s.cancelMovement(null, 'combat override accepted', { origin: keeperOrigin('combat_override') }), input.command_id ?? 'combat-accept');
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
      if (this.targetRefused(exactName(c, target))) {
        pause('refused_here', 'target cannot be attacked in this room (guild-only); normal behavior'); return;
      }
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
      demand(t && t.id !== o.playerId && (o.order.warband || (t.flags & OF.PLAYER)) && (t.flags & OF.ATTACKABLE) &&
        exactName(o.client, t) === o.targetName, 'target left or identity changed');
    }
  }

  event(ev, client = this.s.client) {
    if (!client || client !== this.s.client || client.combatReady === false) return;
    this.observeWar(ev, client);
    if (ev.kind === 'logged-on' || ev.kind === 'logged-off') this.onPlayerListEvent(ev);
    if (ev.kind === 'said' || ev.kind === 'message') { this.observeLeash(ev); this.hear(ev); }
    if (ev.kind === 'message' && ev.text && this.lastWandId != null) this.noteWandMessage(ev.text);
    if (ev.kind === 'message' && ev.text) this.recordPvpDeath(ev, client);
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
    if (ev.kind === 'message' && ev.text && o.phase === 'engaging' && isGuildOnlyRefusal(ev.text)) {
      // THE TARGET IS REFUSED, NOT THE ROOM (room.kod AllowGuildAttack). Remembered for this room
      // so no path here swings at them again; the body moves on rather than standing there.
      // The name as the server spells it, for the log; the memory itself is case-insensitive.
      const t = o.targetId != null ? o.client.room?.objects?.get?.(o.targetId) : null;
      const name = (t ? String(o.client.rsc?.get?.(t.nameRsc) ?? t.name ?? '').trim() : '') || o.targetName ||
        (typeof o.order.target === 'string' ? o.order.target : null);
      o.lastOutcome = { at: this.now(), text: ev.text, kind: 'refused_here' };
      this.refuseTarget(name, { text: ev.text });
      this.record('target_refused_here', o);
      // A keep-off lock on somebody we cannot hit is no lock at all (as for a safety refusal).
      if (o.order.keepoff) try { keepoff.clearLock(o.order.target, `server refused: ${ev.text}`); } catch {}
      if (o.pvp) {
        // Another attacker who CAN be hit keeps the fight; syncPvP stops it if none is left.
        o.targetId = null; o.targetName = null; o.phase = 'waiting'; o.phaseRevision++;
        if (this.syncPvP(o)) this.refreshTarget(o);
        this.wake(); return;
      }
      this.stop(`${name ?? 'target'} cannot be attacked in this room (guild-only); not retrying here`); return;
    }
    if (ev.kind === 'message' && ev.text && o.phase === 'engaging') {
      // THE ROOM REFUSED, NOT THE TARGET. Checked first because "cannot attack another player
      // here" would otherwise fall into the branch below and mark a genuine enemy's membership
      // as wrong. Ends every engagement — war, return fire, operator order — because nothing
      // can land here and the body is stuck under the override until it does.
      if (ROOM_REFUSAL.test(ev.text)) {
        o.lastOutcome = { at: this.now(), text: ev.text, kind: 'room_refused' };
        this.record('room_refused', o);
        if (o.order.keepoff) try { keepoff.markNoCombat(o.order.target); } catch {}
        this.stop(`the server forbids combat in this room: ${ev.text}`); return;
      }
      if (/good thing your safety was on|cannot attack|can't attack|can't bring yourself to attack/i.test(ev.text)) {
        o.lastOutcome = { at: this.now(), text: ev.text, kind: 'refused' };
        // The leader swung at somebody the server will not let us hit (an innocent, with our
        // safety on): drop this target for the warband rather than re-issuing it every tick.
        // Remembered by room and NAME (ids recycle), in the one refused-here memory.
        if (o.order.warband && o.targetName) this.refuseTarget(o.targetName, { why: 'safety', text: ev.text });
        // A keep-off target the server will not let us hit (safety on: not at war, not a murderer)
        // is no target at all: lift the lock rather than camp him for three hours.
        if (o.order.keepoff) try { keepoff.clearLock(o.order.target, `server refused: ${ev.text}`); } catch {}
        // A WAR ENGAGEMENT THE SERVER REFUSES WAS A WRONG MEMORY, and safety did its job: the
        // player is not at war with us now (left the guild, newbie, war over). Stop swinging
        // at them and stop remembering them as an enemy for a while.
        if (o.pvp && o.keepSafety && o.targetName) {
          try { war.markRefused(o.targetName, { at: this.now(), why: ev.text }); } catch {}
          o.pvp.attackers = o.pvp.attackers.filter(a => a.character.toLowerCase() !== o.targetName);
          this.record('war_refused', o);
          if (!o.pvp.attackers.length) { this.stop('war target refused by server safety'); return; }
          o.targetId = null; o.targetName = null; o.phase = 'waiting'; o.phaseRevision++;
          this.syncPvP(o); this.wake(); return;
        }
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
    withBodyCommand(this.s, () => this.s.cancelMovement(null, `combat: ${reason}`, { preserveId, origin: keeperOrigin('combat_mode') }), o.id);
    this.active = null; this.s.combatEpoch = (this.s.combatEpoch ?? 0) + 1;
    // AFTER the epoch bump, like restoreSafety: started before it, the unequip is preempted as
    // part of the fight being stopped.
    if (o.pvpGearOn) this.pvpGearOff(o);
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
    const t = combatTarget(o.client, o.order.target, { anyAttackable: !!o.order.warband });
    const visible = t && (t.flags & OF.ATTACKABLE);
    if (visible && o.phase === 'engaging' && t.id === o.targetId && exactName(o.client, t) === o.targetName) return;
    if (!visible && o.phase === 'waiting') return;
    if (!visible && o.watchId) { this.stop('target no longer visible; normal behavior resumed'); return; }
    withBodyCommand(this.s, () => this.s.cancelMovement(null, 'combat visibility changed',
      { preserveId: o.pvp?.decision_id, origin: keeperOrigin('combat_mode') }), o.id);
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
    if (this.needsSafetyOff(this.active) && this.active.phase === 'engaging') return;
    if (this.restorePending?.lease === lease && this.restorePending.epoch === s.combatEpoch)
      return this.restorePending.promise;
    const owner = this.active?.id ?? 'combat-safety-restore';
    const pending = { lease, epoch: s.combatEpoch };
    this.restorePending = pending;
    pending.promise = withBodyCommand(s, () => withPacketScope(() => {
      demand(this.safetyLease === lease && s.client === lease.client && s.live &&
        s.client.selfId === lease.playerId, 'safety lease changed');
      demand(!(this.needsSafetyOff(this.active) && this.active.phase === 'engaging'), 'kill resumed');
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
    if (!this.needsSafetyOff(o)) { await this.restoreSafety(); return; }
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
    const pvp = o.pvp ? this.pvpStatus() : null;
    this.s.recorder?.line?.('combat', { event, order_id: o.id, target: o.order.target,
      action: o.order.action, phase: o.phase, room: this.s.world?.room?.num, reason: o.reason,
      attacks: o.attacks, casts: o.casts, ...(pvp ? { pvp_survival: pvp } : {}) });
    // THE RECORDINGS ROTATE IN HALF AN HOUR; A BATTLE HAS TO OUTLIVE THEM. The PvP milestones go
    // to the durable log as well (tools/m59-pvp.mjs) — the Rick Deckard volley of 2026-10-06 was
    // gone from every recording before anybody asked to see it.
    if (pvp && this.pvpLogging()) {
      const row = pvplog.combatRow(event, { at: this.now(), observer: this.pvpObserver(),
        room: this.s.world?.room?.num ?? null, target: o.order.target ?? null, pvp, reason: o.reason ?? null });
      if (row) pvplog.appendPvp(row);
    }
  }

  // Only a session with a REAL flight recorder writes the durable log: a live keeper has one, and
  // the offline suites' fake sessions do not — so running a test never writes a battle that
  // did not happen into substrate/pvp/.
  pvpLogging() { return this.s.recorder instanceof Recorder; }

  pvpObserver(client = this.s.client) {
    return client?.me?.name ?? this.character?.() ?? this.s.name ?? null;
  }

  // A death broadcast that names THIS character on either side — our death to a player, or our
  // kill of one. Every keeper hears every broadcast; only the one it is about writes it, so the
  // log holds each line once. Our kills were recorded nowhere before this.
  recordPvpDeath(ev, client) {
    if (!this.pvpLogging()) return;
    try {
      const row = pvplog.deathRowFromMessage(ev.text, { me: this.pvpObserver(client),
        isOurs: n => this.isOurs(n), at: Number.isFinite(ev.at) ? ev.at : this.now(),
        room: this.s.world?.room?.num ?? null });
      if (row) pvplog.appendPvp(row);
    } catch { /* evidence, never a reason to stop fighting */ }
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
        const result = await s.travel(o.order.map, { origin: keeperOrigin('combat_order', { run_id: o.id }), movementGeneration: s.movementGeneration, controlToken: o.id });
        this.guard(o);
        demand(result?.arrived && s.world.room.num === o.order.map, result?.reason ?? 'ambush map was not reached');
      }
      if (o.order.keepoff) {
        // KEEP-OFF: near his ghost is enough (several of us share it), and if he is already standing
        // here there is nothing to wait for.
        const here = combatTarget(c, o.order.target);
        const near = Math.hypot(c.self.row - o.order.position.row, c.self.col - o.order.position.col) <= 2;
        if (!here && !near) {
          const next = safeCombatStep(s, { ...o.order.position, exact: false });
          demand(next, 'no safe path to the logoff ghost');
          await this.stand(o); await s.step(next.col, next.row); return;
        }
        o.room = s.world.room.num; o.roomObject = c.room.id; o.armedAt = this.now();
        o.phase = 'waiting'; o.phaseRevision++; this.record('keepoff_waiting', o);
        this.refreshTarget(o); return;
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
    if (o.pvp || this.targetAtWar(o) || o.order.warband) {
      // THE OPENER (pvpOpener, above) goes first, and its first cast goes even before the gear: an
      // opening spell lands on the beat the target appears, not after a gear swap.
      if (!o.pvpGearOn && !o.openerFirst) { o.openerFirst = true; if (await this.pvpOpener(o, target)) return; }
      // PVP GEAR ON, ONCE PER FIGHT, inside this fight's own packet scope (m59-pvp-gear.mjs).
      if (!o.pvpGearOn) await this.pvpGearOn(o);
      if (await this.pvpOpener(o, target)) return;
      // THE VOLLEY. 'hold' means a lightning wand is carried: no swing between beats, because a
      // swing would take the attack timer the next zap needs.
      if (await this.wandVolley(o) === 'hold') return;
    }
    if (this.now() < o.nextAt) return;
    if (o.pendingAdvance) {
      o.pendingAdvance = false;
      this.nextAction(o);
      if (this.active !== o) return;
    }
    const step = o.order.sequence[o.index];
    if (step.do === 'wait') { o.nextAt = this.now() + step.ms; this.nextAction(o); return; }
    if (step.do === 'attack' && Math.hypot(target.row - c.self.row, target.col - c.self.col) > 2) {
      // THROUGH A SAME-ROOM DOOR WHEN ONE IS NEEDED. Castle Victoria (38) is one room number and
      // many regions joined only by `go` doors back into itself (m59-world.mjs sameRoomDoors), so an
      // enemy who steps through one is still visible and still "in the room" but has no floor path
      // to him. The monster chase has crossed these since bridgeToQuarry; a PvP approach demanded a
      // floor path and stood still, which Morpheus used (2026-09-30). One door per tick; the next
      // tick re-plans from wherever the door put us.
      // ASKED FIRST, NOT AS A FALLBACK. safeCombatStep plans on the COARSE grid, which joins
      // Castle Victoria's chambers through stand points a body cannot use -- r7c26 toward r12c26
      // returns a detour step via r2c34 -- so "no floor step" never happens there and the door was
      // never tried. sameRoomDoorPlan uses the live body's FINE position and returns doors only
      // when the walk really needs one; with no doors needed it returns none and we fall through.
      if (await this.crossDoorToward(o, target)) return;
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
