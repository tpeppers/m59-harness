// Combat is a bounded, event-driven override in the process that owns the socket.
// No script compiler, snapshot fetch, external planner or keeper pass is on the
// arrival -> first attack path. All packets still use the ordinary server pacer.
import { randomUUID } from 'node:crypto';
import { OF, blocksMovement, playerClass, isKiller, isOutlaw } from './m59-parse.mjs';
import { accepts } from './m59-hazards.mjs';
import { withBodyCommand } from './m59-body-command.mjs';
import { withCastRite } from './m59-castrite.mjs';
import { withPacketScope } from './m59-packet-scope.mjs';
import { effectsAt, groundEffectSquares, groundEffectOnSegment } from './m59-ground-effects.mjs';
import { parsePlayerCombat } from './m59-player-evidence.mjs';
import { chooseSurvivalDecision, currentSurvivalDecision, finishSurvivalDecision,
  updateSurvivalDecision } from './m59-survival-decision.mjs';
import * as war from './m59-war.mjs';
import * as gear from './m59-pvp-gear.mjs';
import { sameRoomDoorPlan, renderState } from './m59-world.mjs';
import * as keepoff from './m59-keepoff.mjs';
import { parseDeathBroadcast } from './m59-death-attribution.mjs';
import * as pvplog from './m59-pvp.mjs';
import { locStamp, squaresBetween } from './m59-pvp-telemetry.mjs';
import * as wandShot from './m59-wand-shot.mjs';
import { Recorder } from './m59-recorder.mjs';
import { PersonalThreat } from './m59-personal-threat.mjs';
import { CombatFallback } from './m59-combat-fallback.mjs';
import { CombatSupport } from './m59-combat-support.mjs';
import { publishFleetHealth } from './m59-fleet-health.mjs';
import { isGuildOnlyRefusal, refusedHere, noteRefused, refusedTargets, forgetRefused } from './m59-refused-targets.mjs';
import { keeperOrigin } from './m59-move-origin.mjs';
import * as swarm from './m59-swarm-follow.mjs';
import { squareCentre } from './m59-coords.mjs';
import { lineOfSight } from './m59-safespots.mjs';
import { loadCatalogue } from './m59-deskpractice.mjs';
import { finePath, pointOfSquare, boundsAround } from './m59-finepath.mjs';
import { pvpRoomsRefusal, pvpRoomsStopReason, warScanAction, outsideRoomsRow } from './m59-pvp-rooms.mjs';
import { ENGAGE_WINDOW_MS, PLAYER_SEEN_EVERY_MS, DEFAULT_SORTIE_MS, DEFAULT_SORTIE_IDLE_MS, HOLD_FIRE_MS } from './m59-pvp-strategy.mjs';
import { recordGroan, latestHealth } from './m59-player-health.mjs';
import * as callout from './m59-pvp-callout.mjs';
import * as yelp from './m59-pvp-yelp.mjs';
import { zalgo, healthLevel } from './m59-zalgo.mjs';
// A joust exchange that has not sent its swings in this long gives up and evades (the attacker is keeping away).
export const JOUST_EXCHANGE_MAX_MS = 4_000;

/**
 * Where a jousting body steps back to: a standable square in this room at least `gap` from the attacker, near
 * where it already stands and not in a corner (a corner is where a chase ends). Pure; null when there is none.
 */
export function joustRetreat(geo, me, attacker, gap) {
  if (!geo?.standable || !me || !attacker) return null;
  let best = null;
  const reach = Math.ceil(gap) + 2;
  for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) {
    const row = me.row + dr, col = me.col + dc;
    if (row < 1 || col < 1 || (geo.rows && row > geo.rows) || (geo.cols && col > geo.cols)) continue;
    if (!geo.standable(row, col)) continue;
    const clear = Math.hypot(row - attacker.row, col - attacker.col);
    if (clear < gap) continue;
    let open = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if ((a || b) && geo.standable(row + a, col + b)) open++;
    const score = Math.min(clear, gap + 2) - 0.35 * Math.hypot(dr, dc) + 0.25 * open;
    if (!best || score > best.score) best = { row, col, score };
  }
  return best && { row: best.row, col: best.col };
}

// A strategy flight that did not land waits this long before another may start.
const FLIGHT_BACKOFF_MS = 15_000;
import { protocolToClient, clientToProtocol } from './m59-roo.mjs';
// THE JOINTS (tools/m59-joints.mjs): combat.blocked, combat.channel, combat.outcome, threat.classify and the
// combat half of movement.hazard are asked from this file. Each is asked only when a pak answers it.
import { fightFacts, selfFacts, roomFacts } from './m59-joint-facts.mjs';
import { readOurBlow, elementOf } from './rpg/damage.mjs';
import { assessCreature, isAnonymous } from './rpg/suspicion.mjs';
import { loadSpawns } from './m59-spawns.mjs';
import { loadMap, exitsOf } from './m59-map.mjs';
import { fileURLToPath as joint_fileURLToPath } from 'node:url';
const SPAWN_INDEX = process.env.M59_SPAWN_FILE || joint_fileURLToPath(new URL('../substrate/m59-spawns.json', import.meta.url));

// A FIGHT'S JOURNEY WALKS. Session.travel may take a Rescue chain (m59-rescue-travel.mjs) whenever the private
// rescueTravel policy enables it, and since 2026-10-21 that policy covers the whole fleet. A Rescue lands in the
// guild hall or at home, not beside the fight: a FleeTA responder, an ambush, a swarm member or a PvP flight
// would arrive somewhere else, on a clock the dispatcher priced as walking (prod-deploy-ac, 2026-10-21). So
// every travel this file issues says allowRescue: false.
const NO_TELEPORT = false;

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
// How often a long fight's replay ring is sealed: inside the ring's 120 frames, so nothing is lost between seals.
export const PVP_SEAL_EVERY_MS = 100_000;
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
// WHO SENT A PACKET: the first frames outside the client and this telemetry, as `fn@file`. Only
// computed for a packet sent inside a PvP window, so its cost is a stack walk per swing in a fight.
function callerOf() {
  const frames = String(new Error().stack ?? '').split('\n').slice(1)
    .map(l => /at (?:async )?(?:([^\s(]+) \()?.*?([\w.-]+\.mjs):\d+/.exec(l))
    .filter(m => m && m[2] !== 'm59-client.mjs' && !/noteFightAction|tapSent|callerOf/.test(m[1] ?? ''));
  return frames.slice(0, 3).map(m => `${(m[1] ?? 'anon').replace(/^.*\./, '')}@${m[2].replace(/^m59-|\.mjs$/g, '')}`).join('<') || null;
}
const characterName = (s, c) => String(c?.me?.name ?? s.name).toLowerCase();

export function normalizeCombatOrder(input) {
  demand(input && ['attack', 'kill', 'ambush'].includes(input.action), 'action must be attack, kill or ambush');
  const keys = new Set(['agent', 'fleet_state', 'action', 'target', 'map', 'position', 'door', 'ttl_ms', 'stop_below', 'sequence', 'repeat',
    'select_map', 'command_id', 'revision', 'when_absent', 'watch_maps', 'warband', 'keepoff', 'loud', 'rescue', 'accept']);
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
  // LOUD by default (operator, 2026-10-18: "we want all actual engaging PVP targets to be loud for now"):
  // a callout when a hostile enters the map (m59-pvp-callout.mjs). `loud: false` keeps an order quiet.
  demand(input.loud == null || typeof input.loud === 'boolean', 'loud must be boolean');
  // NAMED HAZARDS THIS ORDER ACCEPTS (m59-hazards.mjs). The only one a combat order can carry is go_red: striking an
  // innocent with safety off, which makes an outlaw of this character. Anything else is a typo, and refused.
  demand(input.accept == null || (Array.isArray(input.accept) && input.accept.every(x => x === 'go_red')),
    'accept takes ["go_red"] or nothing');
  const order = { action: input.action, target: typeof input.target === 'string' ? input.target.trim() : input.target,
    ttl_ms, stop_below, sequence: actions, repeat: input.repeat ?? true, loud: input.loud ?? true,
    ...(input.accept?.length ? { accept: ['go_red'] } : {}),
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
    // A RESCUE ambush goes to a fight already in progress: near the square is enough, and the target is
    // ALREADY in the room, so it engages him there rather than waiting for an entry that never comes.
    demand(input.rescue == null || typeof input.rescue === 'boolean', 'rescue must be boolean');
    demand(!(input.rescue && order.keepoff), 'rescue and keepoff are different orders');
    if (input.rescue === true) order.rescue = true;
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
  // A SUSPECTED PLAYER (threat.classify, below) is a player for targeting: a creature this keeper's pak
  // judged to be a morphed player. Only that object id -- the other creatures of its kind are not.
  const suspect = o => suspectedPlayer(client, o.id);
  const players = [...client.room.objects.values()].filter(o => o.id !== client.selfId && ((o.flags & OF.PLAYER) || suspect(o)));
  // `#<id>` names one object by id: how a suspected player (a morph, an anonymous body) is targeted, since
  // its name is a monster's or blank.
  const byId = typeof target === 'string' && /^#\d+$/.test(target) ? Number(target.slice(1)) : null;
  const matches = players.filter(o => typeof target === 'number' ? o.id === target : byId != null ? o.id === byId : exactName(client, o) === target.toLowerCase());
  demand(matches.length <= 1, 'player identity is ambiguous');
  return matches[0] ?? null;
}

/** Is this object one the threat.classify joint marked as a disguised player, still in force? */
export function suspectedPlayer(client, id) {
  const e = client?.suspectedPlayers?.get?.(id);
  if (!e) return null;
  if (Date.now() > e.until) { client.suspectedPlayers.delete(id); return null; }
  return e;
}

// One short ordinary move, then re-evaluate the live hazard and target. Never
// loosen BSP collision or choose a dangerous destination to escape a hazard.
export function safeCombatStep(session, destination, { avoidSquares = new Set(), fineBody = false } = {}) {
  const c = session.client, geo = session.world?.geometry, me = c?.self;
  if (!me || !geo) return null;
  const hazard = session.hazardOptions?.('combat') ?? {};
  const avoid = groundEffectSquares(c, hazard);
  // A pak may let the PATH cross an effect (movement.hazard `cross`); it never makes one a place to STAND.
  const standAvoid = hazard.crossable ? groundEffectSquares(c) : avoid;
  for (const key of avoidSquares) avoid.add(key);
  for (const object of c.room?.objects?.values?.() ?? []) {
    if (object.id === c.selfId || !blocksMovement(object.flags)) continue;
    if (object.row === me.row && object.col === me.col) continue;
    avoid.add(`${object.row},${object.col}`);
  }
  const goals = [];
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    const row = destination.row + dr, col = destination.col + dc;
    if (destination.exact && (dr || dc)) continue;
    if (!destination.exact && Math.hypot(dr, dc) > 2) continue;
    if (row < 1 || col < 1 || row > geo.rows || col > geo.cols || avoid.has(`${row},${col}`) || standAvoid.has(`${row},${col}`)) continue;
    if (!geo.standable(row, col)) continue;
    if (destination.sight && geo.canMove && !lineOfSight(geo, row, col, destination.row, destination.col)) continue;
    if (!destination.exact && !dr && !dc) continue; // never walk onto the target
    goals.push({ row, col, distance: Math.hypot(row - me.row, col - me.col) });
  }
  goals.sort((a, b) => a.distance - b.distance);
  const deadline = Date.now() + 100;
  for (const goal of goals) {
    if (Date.now() > deadline) break;
    const path = geo.path(me.row, me.col, goal.row, goal.col, { avoid, collision: true, maxNodes: 4000 });
    const nextSquare = path?.found && path.steps.find(p => p.row !== me.row || p.col !== me.col);
    // Start on the actual body, not the square's theoretical stand point. Share
    // the fine router with sameRoomDoorPlan, and keep its node/time budget local.
    // Square-only callers (ambush staging and swarm formation) keep their
    // documented square result; pursuit opts into consuming a fine waypoint.
    if (fineBody && !avoid.size && geo.collisionReady && Number.isFinite(me.x) && Number.isFinite(me.y) && typeof session.stepFine === 'function') {
      const origin = { x: protocolToClient(me.x), y: protocolToClient(me.y) };
      // The square route supplies the long detour. Prove only its next short leg
      // from the live body; a full fine search across a large room exhausts the
      // tactical budget before making any progress.
      const fineGoal = nextSquare || goal;
      const fine = finePath(geo, origin, pointOfSquare(geo, fineGoal.row, fineGoal.col),
        { bounds: boundsAround([me, fineGoal], 4), maxNodes: 1000, goalSquare: fineGoal });
      // Coalesce a straight prefix up to one ordinary square step. Sending only
      // the first quarter-square lattice point through the 1s movement pacer
      // would make pursuit four times slower. Never skip a bend through a wall.
      let p = null;
      if (fine?.found) for (const point of fine.points) {
        const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
        if (distance <= 1) continue;
        if (distance > 1.5 * 1024) break;
        const trace = geo.traceFineMoveClient(origin.x, origin.y, point.x, point.y, { slide: true });
        if (!trace.arrived) break;
        p = point;
      }
      if (p) {
        const x = clientToProtocol(p.x), y = clientToProtocol(p.y);
        const next = { row: Math.floor(y / 64), col: Math.floor(x / 64), x, y, fine: true };
        if (!groundEffectOnSegment(c, me, next, hazard)) return next;
      }
      continue; // a disproved fine leg must not borrow a coarse shortcut
    }
    if (nextSquare && !avoid.has(`${nextSquare.row},${nextSquare.col}`)) return nextSquare;
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
    this.calloutPresent = new Map(); this.calloutSeen = new Map(); this.calloutBornAt = this.now();
    this.calloutCtx = null; this.pvpSpeechUntil = 0;
    this.lastPvP = null;
    this.personalThreat = new PersonalThreat({ now: this.now });
    this.fallback = new CombatFallback(this);
    this.support = new CombatSupport(this);
    // THE WAR RESPONSE is off until the owning process says otherwise (`warEligibility`). The
    // keeper process wires it; a broker in-process session and every test that does not ask
    // for it keep the behaviour that was already there.
    this.warEligibility = null;
    this.fleetmate = () => false;
    this.warLookAt = 0; this.warPendingLook = null; this.warSeen = new Map();
    this.warAlarmed = new Map(); this.warLast = null; this.warError = null;
    // A PVP STRATEGY (m59-pvp-strategy.mjs) is null until the owning process assigns a host; with
    // none, every moment below is answered by the behaviour that was already here.
    this.pvpStrategy = null; this.pvpSeenAt = new Map(); this.strategyEngage = null;
    this.flightBackoffUntil = 0; this.lastFlight = null;
    // A SORTIE in force (m59-pvp-strategy.mjs `sortie`), the last one, and the alarm_elsewhere throttle.
    this.sortie = null; this.lastSortie = null; this.alarmAskedAt = new Map();
    // hold_fire: player (lower case) -> until. The groan book is read through latestHealth.
    this.holdFire = new Map(); this.lastGroan = null;
    // The last attacked/engaged alarm heard from each map, by map number (sortie wait_home_fight).
    this.alarmRoomAt = new Map();
  }

  status() {
    const o = this.active ?? this.last;
    const watch = this.watchStatus();
    const refused_targets = this.refusedStatus();
    const pvp_strategy = this.pvpStrategyStatus();
    const personal = { personal_threat: this.personalThreatStatus(), fallback_queue: this.fallback.snapshot(),
      support_queue: this.support.snapshot() };
    if (!o) return { active: false, ...personal, pvp_survival: this.pvpStatus(), war: this.warStatus(), ...(watch ? { watch } : {}),
      ...(pvp_strategy ? { pvp_strategy } : {}),
      ...(refused_targets?.length ? { refused_targets } : {}),
      ...(this.watchLoadError ? { watch_error: this.watchLoadError } : {}) };
    return { active: !!this.active, ...personal, order_id: o.id, action: o.order.action,
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
      attack_readiness: o.lastReadiness ?? null, last_approach: o.lastApproach ?? null,
      pvp_survival: this.pvpStatus(), keep_safety: !!o.keepSafety, war: this.warStatus(),
      ...(o.safetyKept ? { safety_kept: o.safetyKept } : {}),
      ...(o.flight ? { flight: o.flight } : {}), ...(pvp_strategy ? { pvp_strategy } : {}),
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
    const unknown = [], ours = [], seen = [], hostiles = [];
    for (const o of c.room?.objects?.values?.() ?? []) {
      if (o.id === c.selfId || !(o.flags & OF.PLAYER)) continue;
      const name = c.rsc?.get?.(o.nameRsc) ?? o.name;
      if (!name) continue;
      const mine = this.isOurs(name);
      if (mine) { ours.push(name); continue; }
      const verdict = war.warHostility({ name, flags: o.flags }, { fleetmate: mine, now });
      seen.push({ name, verdict });
      if (verdict.hostile) {
        // Refused to us in this room: not engaged here, and not re-engaged on every object change.
        // Chosen after the strategy below has spoken, so a hold_fire this scan is honoured.
        if ((o.flags & OF.ATTACKABLE) && !this.targetRefused(name)) hostiles.push({ o, name, verdict });
        continue;
      }
      if (!this.warSeen.has(o.id)) this.warSeen.set(o.id, now);
      if (!(o.flags & OF.GUILDMATE) && war.needsLook(name, { now })) unknown.push({ o, name });
    }
    if (this.warSeen.size > 512) this.warSeen.clear();
    this.noteCalloutArrivals(c, seen, room, now);
    // THE STRATEGY SEES EVERY STRANGER, hostile or not (m59-pvp-strategy.mjs `player_seen`): a flight
    // ends the scan here; an `engage` lifts this room's pvp_rooms refusal for the scan just below.
    if (this.sortie?.phase === 'posted' && this.sortie.room === room && seen.some(p => p.verdict?.hostile))
      this.sortie.last_hostile_at = now;
    for (const p of seen) {
      const d = this.consultSeen(p.name, p.verdict, room, now);
      if (d?.do === 'flee_to' && this.beginFlight(d, p.name, 'sighted')) { this.raiseWarAlarm(p.name, 'sighted', room); return; }
      if (d?.do === 'sortie' && this.beginSortie(d, p.name, 'sighted') === 'going') { this.raiseWarAlarm(p.name, 'sighted', room); return; }
    }
    hostile = hostiles.find(h => !this.fireHeld(h.name)) ?? null;
    // A fighter engages (which also raises the alarm); a sentinel only reports what it saw.
    // OUTSIDE pvp_rooms a fighter is a sentinel too (m59-pvp-rooms.mjs): no engagement, but the
    // sighting alarm still goes out, because fleet-mates in an allowed room fight on it.
    const scan = hostile ? warScanAction({ hostile, warEnabled: this.warEnabled(),
      leashed: this.warEnabled() && this.warLeashed(), pvpAllowed: !this.pvpRoomsRefusal() }) : null;
    if (scan === 'engage')
      this.beginWar(hostile.name, { basis: hostile.verdict.basis, why: hostile.verdict.why, room });
    else if (scan === 'sighted') {
      if (this.warEnabled()) this.notePvpRoomsSkip('war_skipped_outside_pvp_rooms', hostile.name);
      this.warLast = { at: now, enemy: hostile.name, basis: 'sighted', room, reporter: null };
      this.raiseWarAlarm(hostile.name, 'sighted', room);
    }
    if (unknown.length && war.enemyGuilds().length) this.lookForGuild(c, unknown, ours, now);
  }

  // LOUD PVP (m59-pvp-callout.mjs). A hostile player -- or the one a combat order names -- who was not in
  // this map at the previous scan, and not for ARRIVAL_GAP_MS before that, has ARRIVED. Any arrival opens
  // the speech window (what is said for the next minute goes to the PvP record, ours and theirs); a loud
  // character also says a line, after a short random pause and inside the fleet-wide chorus cap.
  noteCalloutArrivals(c, seen, room, now = this.now()) {
    try {
      const orderTarget = String(this.active?.order?.target ?? this.watch?.order?.target ?? '').toLowerCase();
      const here = new Set();
      for (const p of seen) {
        const key = String(p.name).toLowerCase();
        if (!(p.verdict?.hostile || (orderTarget && key === orderTarget))) continue;
        here.add(key);
        const was = this.calloutPresent.get(room)?.has(key);
        const last = this.calloutSeen.get(`${room}|${key}`);
        this.calloutSeen.set(`${room}|${key}`, now);
        if (was || (last != null && now - last < callout.ARRIVAL_GAP_MS)) continue;
        this.pvpSpeechUntil = Math.max(this.pvpSpeechUntil, Date.now() + 60_000);
        if (now - this.calloutBornAt < callout.STARTUP_QUIET_MS || !this.isLoud()) continue;
        const pause = Math.floor(Math.random() * callout.MAX_PAUSE_MS);
        const basis = p.verdict?.hostile ? p.verdict.basis ?? 'hostile' : 'combat order';
        this.schedule(() => this.sayCallout(p.name, room, basis), pause);
      }
      this.calloutPresent.set(room, here);
      if (this.calloutPresent.size > 64) this.calloutPresent.clear();
      if (this.calloutSeen.size > 512) this.calloutSeen.clear();
    } catch { /* a callout never stops a scan */ }
  }

  /** Loud: the policy's `pvp_loud`, or a loud combat order (an order is loud unless it says otherwise). */
  isLoud() {
    const order = this.active?.order ?? this.watch?.order ?? null;
    if (order && order.loud != null) return order.loud === true;
    return this.keeper?.()?.policy?.pvpLoud === true;
  }

  sayCallout(name, room, basis) {
    try {
      const c = this.s.client, s = this.s;
      if (!s.live || !c?.self || s.world?.room?.num !== room || c.vitals?.()?.health?.value === 0) return;
      const present = [...(c.room?.objects?.values?.() ?? [])].some(o => (o.flags & OF.PLAYER) &&
        String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase() === String(name).toLowerCase());
      if (!present || typeof c.say !== 'function') return;
      const me = this.pvpObserver(c);
      const dir = pvplog.pvpDirFor();
      const rows = callout.recentCallouts(dir, Date.now());
      const v = callout.chorusVerdict(rows, { room, player: name, speaker: me, now: Date.now() });
      if (!v.speak) { this.lastCallout = { at: Date.now(), player: name, room, skipped: v.why }; return; }
      const { lines, file, error } = callout.loadCallouts();
      const pick = callout.pickCallout(lines, { recent: rows.slice(-40).map(r => r.index), enemy: name, me });
      if (!pick) { this.lastCallout = { at: Date.now(), player: name, room, skipped: error ?? (lines.length ? `no line ${me} may say` : 'no lines') }; return; }
      // CORRUPTED to the line's own tier, or to how hurt the speaker already is, whichever is deeper.
      const ys = yelp.loadYelps().settings, hp = c.vitals?.()?.health;
      const level = Math.max(pick.tier ?? 0, hp?.max ? healthLevel(100 * hp.value / hp.max, ys.thresholds) : 0);
      const z = level ? zalgo(pick.template, level, { vars: { enemy: name, me }, corruptNames: ys.corrupt_names, budget: ys.budget_bytes })
        : { text: pick.text, level: 0, truncated: false, utf8: false };
      const at = Date.now(), loc = this.pvpLoc(c);
      pvplog.appendCallout({ kind: 'callout', at, speaker: me, player: name, room, loc, basis, index: pick.index,
        text: z.text, ...(level ? { template: pick.template, level, truncated: z.truncated } : {}), chorus: v.why, lines_file: file });
      this.calloutCtx = { player: name, basis, index: pick.index, chorus: v.why };
      try { if (z.utf8) c.say(z.text, 1, { encoding: 'utf8' }); else c.say(z.text); } finally { this.calloutCtx = null; }
      this.lastCallout = { at, player: name, room, text: z.text };
      this.pvpSpeechUntil = Math.max(this.pvpSpeechUntil, at + 60_000);
    } catch (e) { this.lastCallout = { at: Date.now(), player: name, room, error: e.message }; }
  }

  // THE WOLF THAT YELPS (m59-pvp-yelp.mjs). A loud character, in a PvP moment, says one line as its health
  // falls into each damage zone, corrupted to that zone's Zalgo level. Outside a PvP moment nothing is said
  // and no zone is spent, but healing still ends the episode.
  noteYelp(c) {
    try {
      const s = this.s, now = Date.now();
      if (!s.live || c !== s.client || typeof c.say !== 'function') return;
      const hp = c.vitals?.()?.health;
      if (!hp?.max) return;
      const pct = 100 * hp.value / hp.max;
      const y = yelp.loadYelps();
      this.yelpTracker ??= new yelp.YelpTracker();
      const moment = !!(this.active?.pvp || this.pvpWindow(now) || now < this.pvpSpeechUntil);
      if (!moment || !this.isLoud()) { if (pct >= y.settings.reset_at) this.yelpTracker.reset(); return; }
      const zone = this.yelpTracker.observe(pct, y.settings);
      if (!zone) return;
      const p = this.active?.pvp;
      const enemy = (p?.last_outcome?.direction === 'incoming' ? p.last_outcome.character : null) ??
        p?.attackers?.[0]?.character ?? this.lastCallout?.player ?? '';
      const me = this.pvpObserver(c), room = s.world?.room?.num ?? null;
      const recent = callout.recentCallouts(pvplog.pvpDirFor(), now).filter(r => r.kind === 'yelp' && r.speaker === me);
      const pick = yelp.pickYelp(y, zone, { originals: callout.loadCallouts().lines, me, enemy, recent });
      if (!pick) { this.lastYelp = { at: now, zone, skipped: y.error ?? `no yelp line ${me} may say` }; return; }
      const z = zalgo(pick.template, zone, { vars: { enemy, me }, corruptNames: y.settings.corrupt_names, budget: y.settings.budget_bytes });
      pvplog.appendCallout({ kind: 'yelp', at: now, speaker: me, player: enemy || null, room, loc: this.pvpLoc(c), zone,
        health_pct: Math.round(pct), source: pick.source, index: pick.index, template: pick.template, text: z.text,
        level: z.level, truncated: z.truncated, lines_file: y.file });
      this.calloutCtx = { player: enemy || null, yelp: zone, source: pick.source, index: pick.index };
      try { c.say(z.text, 1, z.utf8 ? { encoding: 'utf8' } : undefined); } finally { this.calloutCtx = null; }
      this.lastYelp = { at: now, zone, text: z.text };
      this.pvpSpeechUntil = Math.max(this.pvpSpeechUntil, now + 60_000);
    } catch (e) { this.lastYelp = { at: Date.now(), error: e.message }; }
  }

  // SPEECH HEARD IN A PVP WINDOW, or in the minute after a hostile arrived: kind 'said', with the speaker.
  // System prose goes through noteFightMessage; chat never did, so a fight's words were nowhere.
  noteFightSaid(ev) {
    try {
      const now = Date.now();
      if (!this.pvpLogging() || !(this.pvpWindow(now) || now < this.pvpSpeechUntil)) return;
      pvplog.appendFightMessage({ kind: 'said', at: now, observer: this.pvpObserver(),
        room: this.s.world?.room?.num ?? null, fight: this.active?.pvp?.decision_id ?? this.lastPvpFight ?? null,
        speaker: ev.name ?? null, say_type: ev.type ?? null, text: String(ev.text ?? '') });
    } catch { /* never stop the event loop for a log line */ }
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

  /** pvp_rooms (m59-pvp-rooms.mjs): the refusal for where the body stands, or null when a player
   *  may be engaged here. Read live off the keeper's policy, so a push takes effect at once. */
  pvpRoomsRefusal() {
    // A PvP strategy's `engage` lifts OUR room list for this room, for a window it renews by deciding
    // again. The server's own room flags are pvpForbiddenHere's, and nothing here touches them.
    const e = this.strategyEngage, here = this.s.world?.room?.num;
    if (e && e.room === here && this.now() < e.until) return null;
    let policy = null;
    try { policy = this.keeper?.()?.policy ?? null; } catch { policy = null; }
    return pvpRoomsRefusal(policy, this.s.world?.room?.num);
  }

  /** One combat line per room and player for a refusal that would otherwise repeat every tick. */
  notePvpRoomsSkip(event, name, extra = {}) {
    const refusal = this.pvpRoomsRefusal();
    if (!refusal) return null;
    const key = `${event}|${refusal.room}|${String(name).toLowerCase()}`;
    if (this.pvpRoomsNoted === key) return refusal;
    this.pvpRoomsNoted = key;
    this.s.recorder?.line?.('combat', { event, target: name, room: refusal.room,
      pvp_rooms: refusal.rooms, ...extra });
    return refusal;
  }

  beginWar(name, { basis, why, room, reporter = null }) {
    if (this.pvpEligibility?.() === false) return false;
    // A strategy's hold_fire: we do not START this fight (scan or alarm). A hit is beginPvP, not this.
    if (this.fireHeld(name)) return false;
    // A strategy's flight owns the body until it lands; a war engagement on the road is what it is fleeing.
    if (this.active?.flight) return false;
    // OUTSIDE pvp_rooms (operator, 2026-10-11): no war engagement here, from the scan or from a
    // fleetmate's alarm. Our own sighting is still reported, as a sighting.
    if (this.pvpRoomsRefusal()) {
      this.notePvpRoomsSkip('war_skipped_outside_pvp_rooms', name, { basis, reporter });
      if (!reporter) this.raiseWarAlarm(name, 'sighted', room);
      return false;
    }
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

  raiseWarAlarm(enemy, basis, room = this.s.world?.room?.num, extra = {}) {
    if (!this.sentinelEnabled() || !(room > 1) || !enemy) return;
    const key = `${room}|${String(enemy).toLowerCase()}`, now = this.now();
    // A sighting repeats for as long as the enemy stands there; say it again only every
    // WAR_SIGHTING_EVERY_MS. An engagement or an attack is the room's call to arms and is fast.
    const every = basis === 'sighted' ? WAR_SIGHTING_EVERY_MS : WAR_ALARM_EVERY_MS;
    if (now - (this.warAlarmed.get(key) ?? 0) < every) return;
    this.warAlarmed.set(key, now);
    if (this.warAlarmed.size > 256) this.warAlarmed.clear();
    war.raiseAlarm({ room, reporter: this.character?.() ?? characterName(this.s, this.s.client), enemy, basis, at: now, ...extra });
  }

  /** Another keeper's alarm. Joins the fight only when it names the map this character is in. */
  onWarAlarm(a) {
    if (!this.sentinelEnabled() || !a?.enemy) return false;
    const me = this.character?.() ?? characterName(this.s, this.s.client);
    if (this.isOurs(a.enemy)) return false;                  // never an alarm about one of ours
    // A SUSPECTED PLAYER'S ALARM (threat.classify) names an object id. A keeper takes it up only when its
    // own paks answer threat.classify -- the same consent the reporter had -- and only in the same map.
    if (a.suspect?.id != null && Number(a.room) === this.s.world?.room?.num && this.s.joints?.handles?.('threat.classify'))
      this.markSuspect(this.s.client, a.suspect.id, { name: a.suspect.name, label: a.suspect.label, ttl_ms: a.suspect.ttl_ms ?? 300_000,
        why: `${a.reporter ?? 'a fleetmate'} reported it`, pak: a.suspect.pak ?? null });
    // THE FLEET-WIDE WARNING. Every alarm, from any map, is the fleet's latest knowledge of
    // where an enemy is -- a sentinel's sighting in map 2 is what tells a guard in 39 to get
    // ready before anybody is hit. Kept here and reported in `combat status` (war.threat).
    this.warThreat = { enemy: a.enemy, room: Number(a.room), reporter: a.reporter ?? null,
      basis: a.basis ?? null, at: a.at ?? this.now() };
    if (a.basis !== 'sighted' && Number(a.room) > 1) {
      this.alarmRoomAt.set(Number(a.room), Math.max(this.alarmRoomAt.get(Number(a.room)) ?? 0, Number(a.at ?? this.now())));
      if (this.alarmRoomAt.size > 128) this.alarmRoomAt.clear();
    }
    if (!this.warEnabled() || this.warLeashed()) return false;
    if (String(a.reporter ?? '').toLowerCase() === String(me).toLowerCase()) return false;
    if (Number(a.room) !== this.s.world?.room?.num) {
      // A FIGHT NEXT DOOR. Silence -- no strategy, a sighting, or null -- is what was always here: an
      // alarm from another map is a report. Only a strategy's `sortie` turns it into a journey.
      if (!this.pvpStrategy || a.basis === 'sighted' || !(Number(a.room) > 1)) return false;
      const key = `${Number(a.room)}|${String(a.enemy).toLowerCase()}`, now = this.now();
      if (now - (this.alarmAskedAt.get(key) ?? -Infinity) < PLAYER_SEEN_EVERY_MS) return false;
      this.alarmAskedAt.set(key, now);
      if (this.alarmAskedAt.size > 256) this.alarmAskedAt.clear();
      const d = this.consultPvpStrategy('alarm_elsewhere', a.enemy, { hostile: true, basis: a.basis ?? null,
        alarm_room: Number(a.room), reporter: a.reporter ?? null });
      return d?.do === 'sortie' ? !!this.beginSortie(d, a.enemy, 'alarm') : false;
    }
    // A sighting in our map is a report, not a call to arms: our own scan sees the same enemy
    // and engages on its own terms. Only a fight in progress pulls the room in by alarm.
    if (a.basis === 'sighted') return false;
    return this.beginWar(a.enemy, { basis: a.basis ?? 'alarm', why: `${a.reporter} reported ${a.enemy}`,
      room: a.room, reporter: a.reporter ?? 'a fleetmate' });
  }

  // ------------------------------------------------------------------ the joints (tools/m59-joints.mjs)
  //
  // Every method here is reached only when a pak answers the joint; with none loaded each returns at its
  // first line and the fight is exactly what it was.

  /** combat.blocked: no square to approach from. True when a pak's answer was carried out. */
  answerBlocked(o, target, reason) {
    const joints = this.s.joints;
    if (!joints?.handles?.('combat.blocked')) return false;
    const c = o.client;
    const hazards = (() => { try { return [...groundEffectSquares(c)].length; } catch { return 0; } })();
    const d = joints.ask('combat.blocked', fightFacts(this.s, o, target, { reason, hazard_squares: hazards,
      exits_here: this.exitRooms() }));
    if (!d) return false;
    this.s.recorder?.line?.('combat', { event: 'joint_combat_blocked', pak: d.pak, decision: d.do, why: d.why ?? null,
      target: o.targetName ?? null, room: this.s.world?.room?.num ?? null });
    if (d.do === 'ranged' || d.do === 'hold') {
      o.holdApproachUntil = this.now() + (d.do === 'hold' ? d.ms : 2500);
      o.blockedAnswer = { ...d, at: this.now() };
      return true;
    }
    if (d.do === 'withdraw') {
      const room = d.room ?? this.exitRooms()[0] ?? null;
      if (!room) return false;
      return !!this.beginFlight({ do: 'flee_to', room, hold_ms: 0, hold_orders: false, max_ms: 5 * 60_000,
        why: d.why ?? 'combat.blocked: withdraw', strategy: `pak:${d.pak}` }, o.targetName ?? 'blocked', 'blocked');
    }
    return false;
  }

  /** The rooms one exit away from here, nearest exit first. */
  exitRooms() {
    try {
      const num = this.s.world?.room?.num, me = this.s.client?.self;
      const room = loadMap().rooms[String(num)];
      const rows = exitsOf(room).filter(e => Number(e.to) > 1 && Number(e.to) !== num)
        .map(e => ({ to: Number(e.to), d: me && e.row != null ? Math.hypot(e.row - me.row, e.col - me.col) : 999 }))
        .sort((a, b) => a.d - b.d);
      return [...new Set(rows.map(r => r.to))];
    } catch { return []; }
  }

  /** combat.channel: which channels this beat may use. */
  askChannel(o, wands) {
    const joints = this.s.joints;
    if (!joints?.handles?.('combat.channel')) return null;
    const live = o.client.room?.objects?.get?.(o.targetId);
    const now = this.now();
    const weights = Object.fromEntries([...(this.channelWeights ?? new Map())].filter(([, w]) => w.until > now)
      .map(([k, w]) => [k, w.weight]));
    return joints.ask('combat.channel', fightFacts(this.s, o, live, { volley: wands.map(w => `wand:${String(w.name).toLowerCase()}`),
      weights, timer: { attack_ready_in_ms: Math.max(0, (this.attackReadyAt ?? 0) - now) } }));
  }

  /** combat.outcome: our own blow, read back. */
  observeOutcome(ev, c) {
    const joints = this.s.joints;
    if (ev.kind !== 'message' || !ev.text || !joints?.handles?.('combat.outcome')) return;
    const o = this.active;
    if (!o?.pvp && !o?.targetName) return;
    const blow = readOurBlow(ev.text);
    if (!blow) return;
    if (blow.target && o.targetName && !blow.target.toLowerCase().includes(o.targetName.toLowerCase())) return;
    const now = this.now(), last = this.lastOutChannel;
    const channel = last && now - last.at < 4000 ? last.channel : blow.with ? (elementOf(blow.with) ? `spell:${blow.with}` : 'melee') : 'unknown';
    const element = blow.element ?? elementOf(channel.replace(/^\w+:/, '')) ?? null;
    const live = c.room?.objects?.get?.(o.targetId);
    const d = joints.ask('combat.outcome', { ...roomFacts(this.s), channel, outcome: { ...blow, element }, text: ev.text,
      target: { name: o.targetName, id: o.targetId, player: !!(live && (live.flags & OF.PLAYER)) }, self: selfFacts(this.s) });
    if (d?.do === 'adjust') {
      (this.channelWeights ??= new Map()).set(d.channel, { weight: d.weight, until: now + d.for_ms, pak: d.pak, why: d.why });
    }
  }

  markSuspect(c, id, { name = null, label = 'suspected_morph', ttl_ms = 300_000, why = null, pak = null } = {}) {
    if (id == null || !c) return null;
    const e = { id, name, label, why, pak, since: this.now(), until: this.now() + ttl_ms };
    (c.suspectedPlayers ??= new Map()).set(id, e);
    this.s.recorder?.line?.('combat', { event: 'suspect_marked', id, name, label, why, pak, room: this.s.world?.room?.num ?? null });
    return e;
  }

  /** threat.classify: a creature doing what a creature cannot. */
  observeCreature(ev, c) {
    const joints = this.s.joints;
    if (!joints?.handles?.('threat.classify')) return;
    const room = this.s.world?.room?.num ?? null, now = this.now();
    let subject = null, kind = null, detail = null;
    const creature = o => o && o.id !== c.selfId && !(o.flags & OF.PLAYER) && (o.flags & OF.ATTACKABLE);
    if (ev.kind === 'said' && ev.speaker != null) {
      const o = c.room?.objects?.get?.(ev.speaker);
      if (creature(o)) { subject = o; kind = 'spoke'; detail = { kind: 'spoke', text: ev.text }; }
    } else if (ev.kind === 'message' && ev.text) {
      // Prefix first, as observeMonsterCombat does: a crowded room must not parse every creature's name on
      // every line. Among same-named creatures the NEAREST is the one whose blow this was -- reach is 2-3 squares.
      const line = ev.text.toLowerCase(), me = c.self;
      let best = null;
      for (const o of c.room?.objects?.values?.() ?? []) {
        if (!creature(o)) continue;
        const name = c.rsc?.get?.(o.nameRsc) ?? o.name;
        if (!name) continue;
        const forms = [name, `The ${name}`, `A ${name}`, `An ${name}`];
        if (!forms.some(n => line.startsWith(n.toLowerCase() + ' '))) continue;
        const hit = parsePlayerCombat(ev.text, forms);
        if (hit?.direction !== 'incoming' || hit.outcome !== 'hit') continue;
        const d = me ? Math.hypot(o.row - me.row, o.col - me.col) : 0;
        if (!best || d < best.d) best = { o, d };
      }
      if (best) { subject = best.o; kind = 'hit'; detail = { kind: 'hit' }; }
      // AN ANONYMOUS BLOW. Anonymity blanks the name on the wire and keeps OF_PLAYER (anon.kod; user.kod:405-410),
      // so the name-based PvP path cannot match the line and nothing answers it. A blow from a nameless player,
      // with exactly one nameless player within reach, is that player.
      if (!subject && /^\s*(someone|somebody)\b/i.test(ev.text) && parsePlayerCombat(ev.text, ['Someone', 'Somebody'])?.direction === 'incoming') {
        const me = c.self;
        const anon = [...(c.room?.objects?.values?.() ?? [])].filter(o => o.id !== c.selfId && isAnonymous(o, id => c.rsc?.get?.(id))
          && (!me || Math.hypot(o.row - me.row, o.col - me.col) <= 4));
        if (anon.length === 1) { subject = anon[0]; kind = 'anonymous_hit'; detail = { kind: 'hit' }; }
      }
    } else if ((ev.kind === 'appeared' || ev.kind === 'changed') && ev.id != null) {
      const o = c.room?.objects?.get?.(ev.id);
      if (creature(o) && (playerClass(o.flags ?? 0) !== 0)) { subject = o; kind = 'appeared'; }
    }
    if (!subject || suspectedPlayer(c, subject.id)) return;
    const book = (this.creatureEvents ??= new Map());
    const evs = book.get(subject.id) ?? [];
    if (detail) evs.push({ ...detail, at: now });
    book.set(subject.id, evs.filter(e => now - e.at < 120_000).slice(-10));
    if (book.size > 64) book.delete(book.keys().next().value);
    const asked = (this.creatureAskedAt ??= new Map());
    if (now - (asked.get(subject.id) ?? 0) < 1500) return;
    asked.set(subject.id, now);
    const name = String(c.rsc?.get?.(subject.nameRsc) ?? subject.name ?? '').trim();
    let spawns = null;
    try { spawns = loadSpawns(SPAWN_INDEX); } catch {}
    const a = kind === 'anonymous_hit'
      ? { evidence: [{ signal: 'anonymous', weight: 1, detail: 'a nameless player (anonymity) hit us' }], score: 1, spawnable_here: null }
      : assessCreature(subject, { name, room, spawns, events: book.get(subject.id) });
    const d = joints.ask('threat.classify', { ...roomFacts(this.s), event: kind,
      object: { id: subject.id, name, flags: subject.flags, row: subject.row, col: subject.col },
      evidence: a.evidence, score: a.score, spawnable_here: a.spawnable_here, self: selfFacts(this.s) });
    if (d?.do !== 'treat_as_player') return;
    this.markSuspect(c, subject.id, { name, label: d.label, ttl_ms: d.ttl_ms, why: d.why, pak: d.pak });
    // Targeted as `#<id>`: a morph wears a monster's name and an anonymous player wears none.
    const handle = `#${subject.id}`, hit = kind === 'hit' || kind === 'anonymous_hit';
    if (d.alarm) this.raiseWarAlarm(handle, hit ? 'attacked' : 'engaged', room,
      { suspect: { id: subject.id, name, label: d.label, ttl_ms: d.ttl_ms, pak: d.pak } });
    if (hit) this.beginPvP({ character: handle, direction: 'incoming', outcome: 'hit', text: ev.text,
      reason: `${d.label}: ${d.why ?? 'a creature doing what a creature cannot'}`, reason_code: 'suspected_disguised_player' }, ev.at);
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
   * @returns {'hold'|'approach'|null} hold reserves melee; approach requires sight first.
   */
  async wandVolley(o) {
    const c = o.client, s = this.s;
    const cfg = gear.pvpGearConfig();
    this.spentWands ??= new Set();
    // A wand zap is an attack too (ReqSomethingAttack via CanPayCosts / ReqNewApply), so in a
    // no-combat room every beat is refused and the volley would keep firing into it. Checked
    // before any strategy is asked: no strategy may fire into a room that refuses it.
    if (this.pvpForbiddenHere()) return null;
    let wands = gear.volleyWandsIn(c, { spent: this.spentWands, cfg });
    // combat.channel: a pak may take wands out of this beat, or reserve the beat for one channel.
    const steer = this.askChannel(o, wands);
    if (steer?.do === 'skip') wands = wands.filter(w => !steer.channels.includes(`wand:${String(w.name).toLowerCase()}`));
    if (steer?.do === 'prefer') {
      if (!steer.channel.startsWith('wand:')) return null;      // the beat is melee's or a spell's: no volley
      wands = wands.filter(w => `wand:${String(w.name).toLowerCase()}` === steer.channel);
    }
    // Bare "wand" rows are offered to a private strategy (ctx.unidentified); the built-in never
    // fires them, so a fleet with no pvpWand strategy behaves exactly as before.
    const unidentified = gear.unidentifiedWandsIn(c, { spent: this.spentWands })
      .filter(u => !wands.some(w => w.o.id === u.id));
    if (!wands.length && !unidentified.length) return null;
    const ctx = this.wandContext(o, wands, cfg, unidentified);
    const decision = await this.decideWandVolley(o, ctx);
    const hold = decision.hold ? 'hold' : null;
    if (decision.fire == null && !hold) return null;
    const picked = wands.find(w => w.o.id === decision.fire);
    const unid = unidentified.find(u => u.id === decision.fire);
    // An opaque bare wand is not proof of SpecialWand's exceptions. Until a
    // type is identified, retain the ordinary Wand sight/timer prerequisites.
    const pick = picked ?? (unid ? { ...unid, name: 'wand', timer: true } : null);
    // A private hold can arrive without a fire id (e.g. the same volley beat). It still
    // cannot pin a lightning holder behind a wall. SpecialWand vampiric shock has no
    // attack timer, so it does not reserve the swing.
    const needsTimer = pick ? pick.timer !== false : wands.some(w => w.timer) || unidentified.length > 0;
    // EVERY WAND NEEDS LINE OF SIGHT, WHETHER OR NOT THE SERVER ASKS. SpecialWand (vampwand.kod)
    // checks only the same room -- no LineOfSight, no TargetWithinSightAndRange -- so a vampiric
    // zap through a wall or a stand of trees is accepted, and to the player on the other end it
    // is a wallhack. 2026-10-21 04:25Z, Twisted Wood: Zoot drained Rick Deckard from r18c3 at
    // 10-13 squares, 12 of 14 zaps with no sight by the same model the server's lightning refusals
    // confirm (3035 of 3039). The server's leniency is not our permission.
    let live = c.room.objects.get(o.targetId);
    const ready = this.attackReadiness(o, live, { sight: true, timer: needsTimer });
    o.fallbackPrimary = { sight: true, timer: needsTimer };
    o.lastReadiness = { action: 'wand', ...ready };
    if (!ready.positioned) {
      return 'approach';
    }
    if (!pick || !ready.ready) return hold ?? (needsTimer ? 'hold' : null);
    await this.stand(o);
    let faceDeg = null;
    const face = needsTimer || decision.face;
    if (face) await s.pacer.submit('turn', () => {
      const live = c.room.objects.get(o.targetId), me = c.self;
      if (!live || !me) return;
      faceDeg = (Math.round(Math.atan2(live.row - me.row, live.col - me.col) * 180 / Math.PI) + 360) % 360;
      c.face(faceDeg);
      o.faceDeg = faceDeg;
    });
    const queuedAt = Date.now();
    await s.pacer.submit('cast', () => {
      const live = c.room.objects.get(o.targetId);
      // The target can move behind a wall or behind our back while this is paced.
      // Do not count a skipped packet, consume its beat, or advance the cooldown.
      const ready = this.attackReadiness(o, live, { sight: true, timer: needsTimer, facing: face });
      o.lastReadiness = { action: 'wand', ...ready };
      if (!ready.ready) return;
      if (!c.inventory?.some(w => w.id === pick.o.id) || this.spentWands.has(pick.o.id)) return;
      const sentCtx = { ...ctx, beat: gear.beatOf(this.now(), cfg.volley_ms) };
      // THE SHOT RECORD (tools/m59-wand-shot.mjs): every input the server's gates will read,
      // taken the instant before the packet goes, so a refusal can be named afterwards.
      const shot = this.buildWandShot(o, { live, pick, decision: { ...decision, face }, ctx: sentCtx, faceDeg, queuedAt });
      c.apply(pick.o.id, live.id);
      this.lastOutChannel = { channel: `wand:${String(pick.name ?? 'wand').toLowerCase()}`, at: this.now() };
      this.lastVolleyBeat = sentCtx.beat;
      this.lastWandFireAt = this.now();
      if (needsTimer) this.attackReadyAt = this.now() + wandShot.ATTACK_TIMER_MS;
      if (shot) this.openWandShot(shot);
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
      readiness: this.attackReadiness(o, t, { sight: true }),
      personal_threat: this.personalThreatStatus(),
      pvp: !!o.pvp, warband: !!o.order?.warband, room: this.s.world?.room?.num ?? null,
    };
  }

  // Packet prerequisites belong to the socket owner, even when a strategy chooses
  // the weapon. LOS is directional (Room.LineOfSight, LOS_OLD). Lightning has no
  // hard distance limit; melee has radius 2. A received position's age alone does
  // not mean it is stale: a stationary enemy may send no movement for minutes.
  attackReadiness(o, target, { sight = false, range = null, timer = true, facing = false } = {}) {
    const c = o.client, me = c.self, geo = this.s.world?.geometry;
    const visible = !!(target && c.room?.objects?.get(target.id) === target &&
      target.id === o.targetId && exactName(c, target) === o.targetName && (target.flags & OF.ATTACKABLE));
    const distance = me && target ? Math.hypot(target.row - me.row, target.col - me.col) : null;
    let los = null;
    if (visible && me && geo?.canMove) {
      try { los = lineOfSight(geo, me.row, me.col, target.row, target.col); } catch {}
    }
    const swings = (c.attackLog ?? []).filter(a => !a.vetoed);
    const until = Math.max(this.attackReadyAt ?? 0,
      c.lastCastSent?.at != null ? c.lastCastSent.at + this.spellTimerMs(c.lastCastSent.name) : 0,
      swings.at(-1)?.at != null ? swings.at(-1).at + 1000 : 0);
    const timerRemaining = Math.max(0, until - this.now());
    const degrees = Number.isFinite(me?.degrees) ? me.degrees : o.faceDeg;
    const angle = Number.isFinite(degrees) ? Math.round(degrees * 4096 / 360) : me?.angle;
    const behind = facing ? wandShot.behindYou(me, target, angle) : false;
    const positioned = visible && Number.isFinite(distance) && (range == null || distance <= range) && (!sight || los === true);
    const reason = !visible ? 'target_not_visible' : !Number.isFinite(distance) ? 'position_unknown' :
      range != null && distance > range ? 'range' : sight && los !== true ? (los === false ? 'line_of_sight' : 'sight_unknown') :
      timer && timerRemaining > 0 ? 'cooldown' : facing && behind !== false ? 'facing' : null;
    return { ready: reason === null, positioned, reason, los, distance, timer_remaining_ms: timerRemaining };
  }

  spellTimerMs(name) {
    const sp = loadCatalogue().get(String(name ?? '').toLowerCase());
    if (Number.isFinite(sp?.post_cast_ms)) return sp.post_cast_ms;
    // Older catalogues omit overrides (Hold is a direct Spell subclass with a
    // 2s timer). Do not infer a subclass's timer from its parent name alone.
    return 2000;
  }

  async approachCombat(o, target, { sight = false } = {}) {
    if (!target || !o.client.self) return;
    if (o.holdApproachUntil > this.now()) return;   // a combat.blocked `ranged` or `hold` is standing here on purpose
    o.fallbackReason = 'pursuit';
    this.fallback.offer(o, o.fallbackReason);
    o.lastReadiness = this.attackReadiness(o, target, { sight, range: sight ? null : 2 });
    // Door planning must precede the square router even at close range. The fine
    // same-room planner carries Castle Victoria's exact trigger/landing fixes.
    if (await this.crossDoorToward(o, target)) return;
    const next = safeCombatStep(this.s, { ...target, sight }, { fineBody: true });
    if (!next && this.answerBlocked(o, target, 'no_safe_approach')) return;
    demand(next, 'no safe approach to player');
    await this.stand(o);
    const before = { row: o.client.self.row, col: o.client.self.col, x: o.client.self.x, y: o.client.self.y };
    const result = next.fine ? await this.s.stepFine(next.x, next.y) :
      await this.s.step(next.col, next.row, { confirm: true });
    o.lastApproach = { at: this.now(), from: before, toward: next, reason: result?.reason ?? null };
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

  async combatStrategyStatus() {
    const loaded = await this.combatStrategies();
    return { loaded: loaded != null, directory: loaded?.dir ?? null,
      strategies: (loaded?.strategies ?? []).map(st => ({ name: st.name, kind: st.kind,
        enabled: st.enabled === true, hooks: st.hooks ?? [] })),
      problems: loaded?.problems ?? [] };
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
      readiness: this.attackReadiness(o, target, { sight: true }),
      personal_threat: this.personalThreatStatus(),
      heard: this.heardHere(),
      karma: (() => { const k = c.stat?.('karma'); return k == null || k === '' ? null : Number(k); })(),
      fight: o.pvp?.decision_id ?? o.id ?? null, fight_started_at: o.acceptedAt ?? null,
      karma_refused: [...(o.karmaRefused?.keys?.() ?? [])] };
    for (const st of asked) {
      let answer;
      try { answer = await st.pvpOpener(ctx); }
      catch (e) { this.noteOpenerFault(o, st.name, `threw: ${e.message}`); continue; }
      if (answer == null) continue;
      if (answer.wait === true && answer.cast == null) {
        if (o.openerWaiting !== st.name) { o.openerWaiting = st.name; this.record('opener_wait', o); }
        if (o.openerAim === 'target' && !this.attackReadiness(o, target, { sight: true }).positioned) {
          o.fallbackPrimary = { sight: true };
          await this.approachCombat(o, target, { sight: true });
        }
        return true;
      }
      const name = typeof answer.cast === 'string' ? answer.cast.trim().toLowerCase() : null;
      if (name && o.karmaRefused?.has(name)) {
        this.noteOpenerFault(o, st.name, `the server refused ${name} for karma in this fight; passed over`);
        continue;
      }
      const spell = name && (c.spells ?? []).find(sp => exactName(c, sp) === name);
      if (!spell) { this.noteOpenerFault(o, st.name, name ? `named a spell it does not know: ${name}` : 'answered neither cast nor wait'); continue; }
      const aim = answer.target ?? 'target';
      if (!['target', 'self', 'none'].includes(aim)) { this.noteOpenerFault(o, st.name, `target must be target, self or none, not ${aim}`); continue; }
      o.lastReadiness = { action: 'opener', ...this.attackReadiness(o, target, { sight: aim === 'target' }) };
      if (aim === 'target' && !this.attackReadiness(o, target, { sight: true }).positioned) {
        o.fallbackPrimary = { sight: true };
        await this.approachCombat(o, target, { sight: true }); return true;
      }
      if (this.attackReadiness(o, target).timer_remaining_ms > 0) return true;
      await this.stand(o);
      if (aim === 'target') await this.faceCombatTarget(o);
      // A CASTING STRATEGY MAY DRESS FOR THIS CAST FIRST (m59-castrite.mjs): robe on, plate off.
      await withCastRite(this.s, { spell, pvp: !!o.pvp, why: 'pvp opener' }, () => this.s.pacer.submit('cast', () => {
        const live = c.room.objects.get(o.targetId);
        const ready = this.attackReadiness(o, live, { sight: aim === 'target', facing: aim === 'target' });
        o.lastReadiness = { action: 'opener', ...ready };
        if (!ready.ready) return;
        c.cast(spell.id, aim === 'none' ? [] : [aim === 'self' ? c.selfId : live.id]);
        o.openerAt = this.now(); o.openerSpell = name; o.openerAim = aim; o.openerWaiting = null;
        this.attackReadyAt = this.now() + this.spellTimerMs(name);
        o.casts++; o.openerCasts = (o.openerCasts ?? 0) + 1;
        if (o.pvp) { o.pvp.opener_casts = (o.pvp.opener_casts ?? 0) + 1; o.pvp.opener = { strategy: st.name, spell: name }; }
        if (o.firstAttackAt == null) { o.firstAttackAt = this.now(); o.reactionMs = o.firstAttackAt - (o.triggeredAt ?? o.acceptedAt); }
        try { this.s.lastPlayerAttackAt = this.now(); } catch {}
        this.record('opener_cast', o);
      }, 1050));
      return true;
    }
    return false;
  }

  /** What this keeper heard, kept briefly for the opener: a room enchantment says so out loud. */
  hear(ev) {
    if (!ev.text) return;
    // KARMA REFUSALS (spell.kod:32-33, KarmaCheck :465-481): "You are not vile enough to cast hold!" -- or "not
    // worthy" for Shal'ille. Karma does not move in a fight (short of a vampiric wand), so the spell is refused
    // for the rest of THIS fight: an opener that names it again is passed over and the fight falls through to
    // what the character can do. Before this, a Qor caster without the karma stood re-casting hold every two
    // seconds while it was cut down.
    const kr = /You are not (vile enough|worthy) to cast (.+?)!/i.exec(String(ev.text));
    if (kr && this.active) {
      (this.active.karmaRefused ??= new Map()).set(kr[2].trim().toLowerCase(), { at: this.now(), kind: kr[1].toLowerCase().startsWith('vile') ? 'vile' : 'worthy' });
      this.record('opener_karma_refused', this.active);
    }
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
                                         movementGeneration: s.movementGeneration, controlToken: token, allowRescue: NO_TELEPORT }));
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
          await withCastRite(s, { spell: sp, targets: [ally], why: 'warband buff' }, () => s.pacer.submit('cast', () => { c.cast(sp.id, [ally]); }, 1500));
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

  // ------------------------------------------------------------------ wand-shot telemetry
  //
  // One row per zap in substrate/pvp/<fleet>/shots-<day>.jsonl (pvplog.appendShot): the inputs
  // every refusal gate reads, the server's lines for REPLY_WINDOW_MS after it, and a named cause.
  // Bookkeeping only — nothing here may stop a zap, so every step is guarded.

  buildWandShot(o, { live, pick, decision, ctx, faceDeg, queuedAt }) {
    if (!this.pvpLogging()) return null;
    try {
      const c = o.client, me = c.self, now = Date.now();
      const flags = this.roomFlagsHere();
      const swings = (c.attackLog ?? []).filter(a => !a.vetoed);
      const unid = (ctx?.unidentified ?? []).find(u => u.id === pick.o?.id);
      const shot = wandShot.buildShot({
        now, shotId: `${this.pvpObserver(c) ?? 'agent'}-${now}-${(this.shotSeq = (this.shotSeq ?? 0) + 1)}`,
        fight: o.pvp?.decision_id ?? o.id ?? null, character: this.pvpObserver(c), room: this.s.world?.room?.num ?? null,
        roomFlags: { noCombat: !!(flags & ROOM_NO_COMBAT), guildPkOnly: !!(flags & 0x0008) },
        me: me ? { row: me.row, col: me.col, x: me.x, y: me.y, posAt: me.posAt, angle: me.angle, degrees: me.degrees } : null,
        target: { id: live.id, name: o.targetName ?? exactName(c, live) ?? null, row: live.row, col: live.col,
                  x: live.x, y: live.y, posAt: live.posAt, inRoom: c.room?.objects?.get?.(live.id) === live },
        wand: { id: pick.o?.id ?? null, name: pick.name ?? null, colour: unid?.colour ?? null,
                decoded: /decoded/i.test(String(decision.why ?? '')), serverGates: pick.timer !== false },
        strategy: decision.strategy ?? null, why: decision.why ?? null, beat: ctx?.beat ?? null,
        face: !!decision.face, faceDeg,
        geo: this.s.world?.geometry ?? null,
        lastAcceptedZapAt: this.lastAcceptedZapAt ?? null,
        lastCast: c.lastCastSent ?? null,
        lastSwingAt: swings.at(-1)?.at ?? null,
        lastApplyAt: c.lastApplySent?.at ?? null,
      });
      shot.sent_at = now;
      shot.queued_ms = Number.isFinite(queuedAt) ? now - queuedAt : null;
      return shot;
    } catch (e) { this.shotError = e.message; return null; }
  }

  openWandShot(shot) {
    this.closeWandShot();                          // a beat never overlaps the last window, but be sure
    this.openShot = shot;
    const t = setTimeout(() => this.closeWandShot(shot), wandShot.REPLY_WINDOW_MS);
    t.unref?.();
  }

  closeWandShot(only = null) {
    const shot = this.openShot;
    if (!shot || (only && shot !== only)) return;
    this.openShot = null;
    try {
      wandShot.finishShot(shot);
      if (!shot.refused) this.lastAcceptedZapAt = shot.sent_at;
      pvplog.appendShot(shot);
      this.lastShot = { at: shot.at, cause: shot.cause, refused: shot.refused };
    } catch (e) { this.shotError = e.message; }
  }

  // EVERY SERVER LINE WHILE A FIGHT IS ON, and for 30 s after: "You can't see your selected
  // target.", guild refusals, resist lines and the kill broadcast all arrive here and nowhere
  // durable. System prose only — chat ('said') is not taken.
  noteFightMessage(text) {
    try {
      const now = Date.now();
      if (this.openShot && now - this.openShot.sent_at <= wandShot.REPLY_WINDOW_MS) wandShot.addReply(this.openShot, text, now);
      if (!this.pvpLogging()) return;
      if (!(this.active?.pvp || now < (this.pvpTailUntil ?? 0))) return;
      pvplog.appendFightMessage({ kind: 'message', at: now, observer: this.pvpObserver(),
        room: this.s.world?.room?.num ?? null, fight: this.active?.pvp?.decision_id ?? this.lastPvpFight ?? null,
        shot: this.openShot?.shot_id ?? null, text: String(text) });
    } catch { /* never stop the event loop for a log line */ }
  }

  // IS A PVP WINDOW OPEN: a fight on, or the 30 s tail after one. The same test noteFightMessage uses.
  pvpWindow(now = Date.now()) {
    return this.pvpLogging() && !!(this.active?.pvp || now < (this.pvpTailUntil ?? 0));
  }

  // WHERE THIS BODY IS, as the standard stamp: map number, coarse square, fine offset (KOD units).
  pvpLoc(client = this.s.client) {
    try { return locStamp(this.s.world?.room?.num ?? null, client?.self ?? null); } catch { return null; }
  }

  tapClient(client) {
    if (!client?.tapAction || client.__pvpTap === this) return;
    try { client.__pvpUntap?.(); } catch {}
    client.__pvpTap = this;
    client.__pvpUntap = client.tapAction((a, c) => this.noteFightAction(a, c));
  }

  // EVERY PACKET THIS BODY SENDS IN A PVP WINDOW, whoever sent it: a swing, a cast (the opener, a
  // heal, a cast rite's spell), a robe put on or a plate taken off. Before this, the PvP record had
  // the opener's DECISION and nothing of the gear swap around it or the server's answer to it.
  // Each row carries where the body stood and where its target stood, and `via` names the code
  // that sent it -- the cheapest honest answer to "why did it do that".
  noteFightAction(a, client) {
    try {
      if (client !== this.s.client) return;
      const now = a.at ?? Date.now();
      // Anything SAID is kept through the speech window as well, and a callout always.
      const speech = a.verb === 'say';
      if (!this.pvpWindow(now) && !(speech && this.pvpLogging() && (this.calloutCtx || now < this.pvpSpeechUntil))) return;
      const o = this.active;
      const loc = this.pvpLoc(client);
      const objOf = id => id == null ? null : client.room?.objects?.get?.(id) ?? (client.inventory ?? []).find(i => i.id === id) ?? null;
      const nameOf = obj => obj ? (client.rsc?.get?.(obj.nameRsc) ?? obj.name ?? null) : null;
      const targetId = a.target ?? (a.targets?.length === 1 ? a.targets[0] : null);
      const tObj = targetId === client.selfId ? null : objOf(targetId);
      const tLoc = tObj && tObj.x != null ? locStamp(loc?.map ?? null, tObj) : null;
      const mana = a.verb === 'cast' ? client.vitals?.()?.mana : null;
      const rite = a.verb === 'cast' && this.s._rite ? `${this.s._rite.source ?? 'rite'}${this.s._rite.why ? `:${this.s._rite.why}` : ''}` : null;
      pvplog.appendAction({ kind: 'action', verb: a.verb, at: now, observer: this.pvpObserver(client),
        room: loc?.map ?? null, loc, fight: o?.pvp?.decision_id ?? this.lastPvpFight ?? null,
        ...(a.spell !== undefined ? { spell: a.spell } : {}),
        ...(a.item != null ? { item: a.item, item_name: nameOf(objOf(a.item)) } : {}),
        ...(targetId != null ? { target: targetId, target_name: targetId === client.selfId ? 'self' : nameOf(tObj),
          target_player: tObj ? !!(tObj.flags & OF.PLAYER) : null, target_loc: tLoc, dist: squaresBetween(loc, tLoc) } : {}),
        ...(a.vetoed ? { vetoed: true } : {}),
        ...(speech ? { text: a.text ?? '', say_type: a.say_type ?? null, ...(this.calloutCtx ? { callout: { ...this.calloutCtx } } : {}) } : {}),
        ...(mana ? { mana: mana.value ?? null, max_mana: mana.max ?? null } : {}),
        ...(rite ? { rite } : {}),
        phase: o?.phase ?? null, intent: o ? [o.order?.action, o.order?.target].filter(Boolean).join(' ') || null : null,
        via: callerOf() });
    } catch { /* telemetry never stops a packet */ }
  }

  // WHAT EACH ENEMY LOOKED LIKE, AND WHAT OURS PICKED UP AFTER ONE DIED. A reenactment of a fight
  // (m59-reenact) dresses a stand-in for every body in it, and on 2026-10-17 the fleet's own looks
  // could be read off the keepers but Morpheus's could not: nothing had kept the overlay stack the
  // server sent us while he stood in Castle Victoria, nor what fell when he died. So, in a PvP window:
  //
  //   verb 'appearance'  each non-fleet player in the room, rendered exactly as the client holds it
  //                      (renderState: body icon and translation, face, hair, clothes, one overlay
  //                      per worn item). Once per fight per player, and again when the server sends
  //                      that body a new look (a weapon drawn, a robe put on).
  //   verb 'loot'        what this body picked up off the floor, while the window is open or for two
  //                      minutes after an enemy died in the room: Robin's pickup on 2026-10-17 came
  //                      35 s after the kill, past the 30 s tail.
  notePvpAppearances(client) {
    try {
      if (!this.pvpWindow()) return;
      const fight = this.active?.pvp?.decision_id ?? this.lastPvpFight ?? null;
      if (this.pvpLooksFight !== fight) { this.pvpLooksFight = fight; this.pvpLooks = new Map(); }
      const room = this.s.world?.room?.num ?? null;
      for (const o of client.room?.objects?.values?.() ?? []) {
        if (o.id === client.selfId || !(o.flags & OF.PLAYER)) continue;
        const name = client.rsc?.get?.(o.nameRsc) ?? o.name ?? null;
        if (!name || this.isOurs(name)) continue;
        const rev = o.appearanceRevision ?? 0;
        if (this.pvpLooks.get(name) === rev) continue;
        this.pvpLooks.set(name, rev);
        const r = renderState(client, o);
        pvplog.appendAction({ kind: 'action', verb: 'appearance', at: Date.now(), observer: this.pvpObserver(client),
          room, fight, target_name: name, target_loc: o.x != null ? locStamp(room, o) : null,
          appearance: r.appearance, revision: rev });
      }
    } catch { /* telemetry never stops a fight */ }
  }

  notePvpLoot(items, client = this.s.client) {
    try {
      const now = Date.now();
      if (!this.pvpLogging() || !(this.pvpWindow(now) || now < (this.pvpLootUntil ?? 0))) return;
      if (!items?.length) return;
      const room = this.s.world?.room?.num ?? null;
      pvplog.appendAction({ kind: 'action', verb: 'loot', at: now, observer: this.pvpObserver(client), room,
        loc: this.pvpLoc(client), fight: this.active?.pvp?.decision_id ?? this.lastPvpFight ?? null,
        after_death_of: now < (this.pvpLootUntil ?? 0) ? this.pvpLootVictim ?? null : null,
        items: items.map(i => ({ name: i.name ?? null, amount: i.amount ?? null })) });
    } catch { /* telemetry never stops a pickup */ }
  }

  // A MAP CHANGE IN A PVP WINDOW. Fights cross maps -- a door in Castle Victoria, a run to an inn --
  // and who was where during which part of a fight is half of what the record is for.
  notePvpTraverse(client) {
    try {
      const num = this.s.world?.room?.num ?? null;
      if (num == null) return;
      const prev = this.pvpLastRoom;
      this.pvpLastRoom = num;
      if (prev == null || prev === num || !this.pvpWindow()) return;
      pvplog.appendAction({ kind: 'action', verb: 'traverse', at: Date.now(), observer: this.pvpObserver(client),
        room: num, from: prev, to: num, loc: this.pvpLoc(client),
        fight: this.active?.pvp?.decision_id ?? this.lastPvpFight ?? null,
        phase: this.active?.phase ?? null });
    } catch { /* never stop the event loop for a log line */ }
  }

  // SEAL THE REPLAY RING ON PVP, not only on our death. The ring holds the last 120 one-second
  // frames, every visible body's square and facing; on 2026-10-07 the frames of the Morpheus
  // volleys were overwritten within minutes because nobody of ours died in them. ONE keeper per
  // room seals — every keeper's frames show the whole room, and a ring is up to 16 MB — chosen as
  // the alphabetically first fleet character present. Sealed mid-fight every PVP_SEAL_EVERY_MS
  // (inside the ring's 120 s, so a long fight is covered end to end) and once when it finishes.
  pvpSealer() {
    try {
      const c = this.s.client, mine = this.pvpObserver(c);
      if (!mine || !c?.room?.objects) return false;
      const ours = [mine];
      for (const o of c.room.objects.values()) {
        if (o.id === c.selfId || !(o.flags & OF.PLAYER)) continue;
        const n = c.rsc?.get?.(o.nameRsc) ?? o.name;
        if (n && this.isOurs(n)) ours.push(String(n));
      }
      return ours.sort((a, b) => a.localeCompare(b))[0] === mine;
    } catch { return false; }
  }

  sealPvp(why, o = this.active) {
    const rr = this.s.replayRecorder;
    if (!rr?.seal || !this.pvpLogging()) return;
    const now = Date.now();
    if (why !== 'finished' && now - (this.lastPvpSealAt ?? 0) < PVP_SEAL_EVERY_MS) return;
    if (!this.pvpSealer()) return;
    this.lastPvpSealAt = now;
    try {
      rr.seal('pvp', { why, fight: o?.pvp?.decision_id ?? this.lastPvpFight ?? null,
        observer: this.pvpObserver(), room: this.s.world?.room?.num ?? null, target: o?.order?.target ?? null });
    } catch (e) { this.sealError = e.message; }
  }

  // A wand that has run out stays in the pack (a broken SpecialWand) or is deleted (a SpellItem
  // wand); either way it must not be picked again. "Nothing happens" is NOT only the attack timer:
  // it answers a target out of sight or in another room, the timer, a no-combat room, and (after
  // "You can't see your selected target.") a target behind us — see tools/m59-wand-shot.mjs, whose
  // per-shot row is what tells them apart.
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
  //
  // AND SAFETY COMES OFF FOR AN INNOCENT ONLY WHEN THE ORDER SAYS SO (operator, 2026-10-26: going red is a change to the
  // character that cannot be taken back, so it must be overridden explicitly). CheckStatusAndSafety (player.kod:3767):
  // "You can always successfully hit a murderer or outlaw" with safety ON, and morphs, anonymous players and mutual-war
  // enemies too. So safety ON loses nothing against those; it only stops a strike on an innocent, and that strike is
  // what makes us an outlaw. A character already a murderer has nothing left to lose. Otherwise the order has to carry
  // accept: ["go_red"]; without it safety stays on, the server refuses the blow, and `safety_kept` says why.
  needsSafetyOff(o) {
    if (!(o && o.order.action === 'kill' && !o.keepSafety && !this.targetAtWar(o))) return false;
    const t = o.targetId != null ? o.client?.room?.objects?.get?.(o.targetId) : null;
    if (t && (isKiller(t.flags) || isOutlaw(t.flags))) { o.safetyKept = null; return false; }
    if (isKiller(o.client?.self?.flags ?? 0)) return true;
    if (accepts(o.order.accept, 'go_red')) return true;
    if (!o.safetyKept) {
      o.safetyKept = t ? `${t.name ?? 'the target'} is not a murderer or outlaw: safety stays ON (accept go_red to strike an innocent)`
        : 'target not visible yet: safety stays ON until it is, and for an innocent unless the order accepts go_red';
      this.s.recorder?.line?.('combat', { event: 'safety_kept', order_id: o.id, target: o.order.target, why: o.safetyKept });
    }
    return false;
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
      this.personalThreat.note({ kind: result.outcome === 'hit' ? 'player_hit' : 'player_miss',
        attacker: result.character }, { engaged: this.personalThreatStatus().level !== 'quiet' });
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

  // ------------------------------------------------------------------ PvP strategies
  //
  // m59-pvp-strategy.mjs has the argument. This half is the keeper's: build the facts, ask the host
  // (a synchronous call on a module already loaded), and carry out the two decisions that act —
  // `engage` (lift our room list here) and `flee_to` (a survival flight to a named room, then a hold).

  pvpStrategyStatus() {
    const host = this.pvpStrategy;
    if (!host && !this.lastFlight && !this.sortie && !this.lastSortie) return null;
    const keeper = this.keeper?.();
    return { ...(host?.status?.() ?? {}), flight: this.active?.flight ?? null, last_flight: this.lastFlight,
      sortie: this.sortie, last_sortie: this.lastSortie, last_groan: this.lastGroan,
      hold_fire: Object.fromEntries([...this.holdFire].filter(([, u]) => u > this.now())),
      engage: this.strategyEngage, hold: keeper?.pvpStrategyHold ?? null,
      backoff_until: this.flightBackoffUntil > this.now() ? this.flightBackoffUntil : null };
  }

  personalThreatStatus() {
    const o = this.active, t = o?.client?.room?.objects?.get?.(o.targetId);
    return this.personalThreat.snapshot({ engaged: !!(o && (o.pvp || o.flight || t?.flags & OF.PLAYER)) });
  }

  strategyFacts(player, extra = {}) {
    const s = this.s, v = s.client?.vitals?.()?.health;
    const max = v?.max ?? v?.scale_max;
    let hold = null;
    try { hold = this.keeper?.()?.pvpStrategyHold ?? null; } catch { hold = null; }
    let ownRefusal = null;
    try { ownRefusal = pvpRoomsRefusal(this.keeper?.()?.policy ?? null, s.world?.room?.num); } catch { ownRefusal = null; }
    return { character: this.character?.() ?? characterName(s, s.client), agent: this.agentId ?? null,
      room: s.world?.room?.num ?? null, player, hostile: false, basis: null,
      pvp_allowed_here: !ownRefusal && !this.pvpForbiddenHere(),
      personal_threat: this.personalThreatStatus(),
      health_pct: Number.isFinite(v?.value) && max > 0 ? Math.round(100 * v.value / max) : null,
      max_health: Number.isFinite(max) ? max : null,
      in_flight: !!this.active?.flight, flight_room: this.active?.flight?.room ?? null,
      hold_room: hold && hold.until > this.now() ? hold.room : null, now: this.now(),
      ...this.roomCount(), sortie_room: this.sortie?.room ?? null, sortie_phase: this.sortie?.phase ?? null,
      alarm_room: null, reporter: null, player_health: this.playerHealth(player), pvp_episode: this.pvpEpisode(),
      ...extra };
  }

  /** The return-fire fight in progress, as a strategy sees it (m59-pvp-strategy.mjs `pvp_episode`), or null. */
  pvpEpisode() {
    const o = this.active, p = o?.pvp;
    if (!p) return null;
    const v = this.s.client?.vitals?.()?.health, j = p.joust;
    return { elapsed_ms: this.now() - p.chosen_at, start_health: p.start_health ?? null,
      health: Number.isFinite(v?.value) ? v.value : null, attacks_sent: p.attacks,
      incoming_hits: p.incoming_hits, incoming_misses: p.incoming_misses, attackers: p.attackers.map(a => a.character),
      joust: j ? { phase: j.phase, exchanges: j.exchanges, period_ms: j.period_ms, swings: j.swings } : null };
  }

  /** The fleet's groan-based estimate for a player, or null. Never throws on the strategy path. */
  playerHealth(player) {
    try { return latestHealth(player, { now: this.now() }); } catch { return null; }
  }

  /** true while a strategy's hold_fire says not to start a fight with this player. */
  fireHeld(name) {
    const k = String(name ?? '').toLowerCase(), until = this.holdFire.get(k);
    if (until == null) return false;
    if (this.now() < until) return true;
    this.holdFire.delete(k); return false;
  }

  /** A pain sound (m59-player-health.mjs): the hurt player's health band, recorded for players not ours. */
  observeGroan(ev, c) {
    if (ev.kind !== 'groan' || !ev.source || ev.source === c.selfId) return;
    const o = c.room?.objects?.get?.(ev.source);
    if (!o || !(o.flags & OF.PLAYER)) return;
    const name = c.rsc?.get?.(o.nameRsc) ?? o.name;
    if (!name || this.isOurs(name)) return;
    this.lastGroan = { at: this.now(), name, band: ev.band, room: this.s.world?.room?.num ?? null };
    recordGroan({ name, band: ev.band, room: this.s.world?.room?.num ?? null,
      reporter: this.character?.() ?? characterName(this.s, c), at: this.now() });
  }

  /** Who is in the room with us: fleet-mates (not counting us) and players marked hostile. */
  roomCount() {
    const c = this.s.client, now = this.now();
    let allies_here = 0, hostiles_here = 0;
    try {
      for (const o of c?.room?.objects?.values?.() ?? []) {
        if (o.id === c.selfId || !(o.flags & OF.PLAYER)) continue;
        const name = c.rsc?.get?.(o.nameRsc) ?? o.name;
        if (!name) continue;
        if (this.isOurs(name)) { allies_here++; continue; }
        if (war.warHostility({ name, flags: o.flags }, { fleetmate: false, now })?.hostile) hostiles_here++;
      }
    } catch { /* a count we could not take is zero, never a throw on the strategy path */ }
    return { allies_here, hostiles_here };
  }

  /** Ask the character's strategy; null is "the behaviour that was already here". */
  consultPvpStrategy(moment, player, extra = {}) {
    const host = this.pvpStrategy;
    if (!host?.decide || !player) return null;
    let d = null;
    try { d = host.decide(moment, this.strategyFacts(player, extra)); } catch { d = null; }
    if (!d) return null;
    const here = this.s.world?.room?.num;
    const key = `${moment}|${here}|${String(player).toLowerCase()}|${d.do}`;
    if (this.pvpStrategyNoted !== key) {
      this.pvpStrategyNoted = key;
      this.s.recorder?.line?.('combat', { event: 'pvp_strategy_decision', moment, target: player, room: here,
        strategy: d.strategy ?? null, decision: d.do, to: d.room ?? null, why: d.why ?? null });
    }
    // A joust is a fight too: it lifts our room list here exactly as `engage` does.
    if ((d.do === 'engage' || d.do === 'joust') && here > 1)
      this.strategyEngage = { room: here, until: this.now() + Math.max(ENGAGE_WINDOW_MS, d.do === 'joust' ? d.ms : 0), player, strategy: d.strategy ?? null };
    if (d.do === 'hold_fire') {
      this.holdFire.set(String(player).toLowerCase(), this.now() + (d.ms ?? HOLD_FIRE_MS));
      if (this.holdFire.size > 256) this.holdFire.clear();
    }
    return d;
  }

  /** `player_seen`, at most once per player per room per PLAYER_SEEN_EVERY_MS. */
  consultSeen(name, verdict, room, now = this.now()) {
    if (!this.pvpStrategy) return null;
    const key = `${room}|${String(name).toLowerCase()}`;
    if (now - (this.pvpSeenAt.get(key) ?? -Infinity) < PLAYER_SEEN_EVERY_MS) return null;
    this.pvpSeenAt.set(key, now);
    if (this.pvpSeenAt.size > 512) this.pvpSeenAt.clear();
    return this.consultPvpStrategy('player_seen', name,
      { hostile: !!verdict?.hostile, basis: verdict?.basis ?? null });
  }

  /** The keeper's hold on the room a flight lands in (Autopilot.travel refuses keeper journeys out). */
  setStrategyHold(d, threat) {
    if (!(d.hold_ms > 0)) return;
    const keeper = this.keeper?.();
    if (!keeper) return;
    const until = this.now() + d.hold_ms;
    const prev = keeper.pvpStrategyHold;
    if (prev && prev.room === d.room && prev.until >= until) return;
    keeper.pvpStrategyHold = { room: d.room, until, orders: d.hold_orders === true || (prev?.room === d.room && prev.until > this.now() && prev.orders === true),
      strategy: d.strategy ?? null, threat: threat ?? null, set_at: this.now() };
  }

  /** Take the body and travel to `d.room`, as survival. False when there is nothing to do. */
  beginFlight(d, threat, trigger, { sortie = null } = {}) {
    const s = this.s, c = s.client, here = s.world?.room?.num, now = this.now();
    if (!s.live || !c?.self || !(here > 1) || c.vitals?.()?.health?.value === 0) return false;
    // A flee_to decided during a sortie REPLACES it -- the retreat is the strategy's call, not the sortie's.
    if (!sortie && this.sortie && trigger !== 'sortie_over') this.endSortie(`replaced by a flight to ${d.room}`, { home: false });
    if (here === d.room) { this.setStrategyHold(d, threat); return false; }
    if (this.active?.flight || now < this.flightBackoffUntil) return false;
    // An operator's combat order is the operator's: a strategy does not preempt one.
    if (this.active && !this.active.pvp && !this.active.watchId) return false;
    const decision = chooseSurvivalDecision(s, { strategy: 'pvp_strategy_flight', status: 'active',
      reason: `${trigger === 'attacked' ? 'attacked by' : 'saw'} ${threat}; PvP strategy ${d.strategy ?? '?'} flees to ${d.room}`,
      reason_code: 'pvp_strategy_flight', source: 'combat',
      mitigation: 'the strategy chose distance to allies over fighting or resting here' },
    { because: 'the character\'s PvP strategy chose flight' });
    this.stop('superseded by PvP strategy flight', { preserveId: decision.id });
    s.combatEpoch = (s.combatEpoch ?? 0) + 1;
    s.fightGeneration = (s.fightGeneration ?? 0) + 1;
    const id = randomUUID();
    withBodyCommand(s, () => s.cancelMovement(null, 'PvP strategy flight', { preserveId: decision.id, origin: keeperOrigin('pvp_strategy') }), id);
    s._router?.clear?.();
    if (s.job && !s.job.done) { s.job.cancelled = true; s.job.done = true; s.job.finishedAt = now; }
    const keeper = this.keeper();
    if (keeper) {
      keeper.suspendedJourney = null;
      keeper.revive?.('PvP strategy flight');
      keeper.frozenUntil = null; keeper.freezeSample = null;
    }
    this.active = { id, order: { action: 'flee_to', target: threat, map: d.room, sequence: [{ swings: 1 }], stop_below: 0 },
      acceptedAt: now, expiresAt: now + (d.max_ms ?? 600_000),
      client: c, playerId: c.selfId, room: here, roomObject: c.room?.id ?? null,
      phase: 'fleeing', phaseRevision: 0, targetId: null, targetName: null,
      attacks: 0, casts: 0, index: 0, remaining: 1, nextAt: 0, running: false,
      flight: { room: d.room, from: here, threat, trigger, strategy: d.strategy ?? null, why: d.why ?? null,
        hold_ms: d.hold_ms ?? 0, hold_orders: d.hold_orders === true, decision_id: decision.id, started_at: now, arrived_at: null,
        ...(Number.isInteger(d.via) && d.via !== d.room ? { via: d.via } : {}),
        ...(Number.isInteger(d.row) && Number.isInteger(d.col) ? { post: { row: d.row, col: d.col } } : {}),
        ...(sortie ? { sortie } : {}) } };
    updateSurvivalDecision(s, decision.id, { activated_at: now, phase: 'pvp_strategy_flight' });
    this.record('pvp_strategy_flight', this.active);
    s.pacer?.wake?.();
    this.wake();
    return true;
  }

  async advanceFlight(o) {
    const s = this.s, f = o.flight;
    if (s.world.room.num !== f.room) {
      await this.stand(o);
      this.armTimer();
      // The ordinary validated router, under this flight's packet and identity guards -- the same walk
      // an ambush order takes to its map. It does not ask the keeper's confinement: a flight is survival.
      const origin = keeperOrigin('pvp_strategy', { run_id: o.id });
      const legOpts = () => ({ movementGeneration: s.movementGeneration, controlToken: o.id });
      // THE WAY IN. Ukgoth's NE corner is reached only from the Cragged Mountains; entered from the other two
      // neighbours a fled body lands on an island two hundred squares of trolls from its allies. So walk to
      // `via` first, planning around the destination (whose far half is no road to it), then step in. A way
      // in that fails is recorded and the flight goes straight in: the wrong half of the bastion beats the road.
      if (f.via != null && f.via_result == null && s.world.room.num !== f.via) {
        const v = await s.travel(f.via, { origin, ...legOpts(), avoid: [f.room], allowRescue: NO_TELEPORT })
          .catch(e => { if (/superseded|stale|generation/i.test(String(e?.message))) throw e; return { arrived: false, reason: e?.message }; });
        this.guard(o);
        f.via_result = { arrived: v?.arrived === true && s.world.room.num === f.via, reason: v?.arrived ? null : (v?.reason ?? null), at: this.now() };
        s.recorder?.line?.('combat', { event: 'pvp_strategy_flight_via', order_id: o.id, room: f.room, via: f.via, ...f.via_result });
      }
      const result = await s.travel(f.room, { origin, ...legOpts(), ...(f.post ? { arriveNear: f.post } : {}), allowRescue: NO_TELEPORT });
      this.guard(o);
      demand(result?.arrived && s.world.room.num === f.room, result?.reason ?? `flight to ${f.room} did not arrive`);
    }
    f.arrived_at = this.now();
    // THE POST: a named square, best effort, as a sortie's -- the room ended the flight, the square is where allies stand.
    if (f.post && !f.sortie && typeof s.walkTo === 'function') {
      const w = await s.walkTo(f.post.col, f.post.row, { maxSteps: 40, movementGeneration: s.movementGeneration,
        controlToken: o.id }).catch(e => ({ arrived: false, reason: e.message }));
      this.guard(o);
      f.post.arrived = w?.arrived === true; f.post.reason = w?.arrived ? null : (w?.reason ?? null);
    }
    if (f.sortie) {
      // THE POST: a named square, best effort. Not reaching it is not a reason to go home -- the map is.
      if (Number.isInteger(f.sortie.row) && Number.isInteger(f.sortie.col) && typeof s.walkTo === 'function') {
        const w = await s.walkTo(f.sortie.col, f.sortie.row, { maxSteps: 40, movementGeneration: s.movementGeneration,
          controlToken: o.id }).catch(e => ({ arrived: false, reason: e.message }));
        this.guard(o);
        f.sortie.post = { arrived: w?.arrived === true, reason: w?.arrived ? null : (w?.reason ?? null) };
      }
      this.stop(`PvP strategy sortie reached ${f.room}`);
      this.postSortie();
      return;
    }
    this.setStrategyHold({ room: f.room, hold_ms: f.hold_ms, hold_orders: f.hold_orders, strategy: f.strategy }, f.threat);
    this.stop(`PvP strategy flight reached ${f.room}`);
  }

  // ------------------------------------------------------------------ sorties
  //
  // m59-pvp-strategy.mjs `sortie`: walk out to ONE other map as a flight walks (ignoring the fight being
  // left), fight there with our room list lifted and the keeper held in it, and walk home when it goes
  // quiet. The keeper process ticks `sortieTick` every 250 ms; nothing here ever follows a player out of
  // the sortie map.

  /** Start a sortie: 'going' (a flight owns the body), 'posted' (already in the map; fight on), or false. */
  beginSortie(d, threat, trigger) {
    const s = this.s, here = s.world?.room?.num, now = this.now();
    if (this.sortie && this.sortie.room === d.room) return false;
    const sortie = { room: d.room, home: d.home, row: d.row ?? null, col: d.col ?? null, max_ms: d.max_ms ?? DEFAULT_SORTIE_MS,
      idle_ms: d.idle_ms ?? DEFAULT_SORTIE_IDLE_MS, home_hold_ms: d.home_hold_ms ?? 0, wait_home_fight: d.wait_home_fight === true, strategy: d.strategy ?? null, why: d.why ?? null,
      threat: threat ?? null, trigger, from: here, started_at: now, phase: 'going' };
    if (here === d.room) {
      if (this.active && !this.active.pvp && !this.active.watchId) return false;
      if (this.sortie) this.endSortie('replaced by another sortie', { home: false });
      this.sortie = sortie; this.postSortie(); return 'posted';
    }
    if (this.sortie) this.endSortie('replaced by another sortie', { home: false });
    this.sortie = sortie;
    if (!this.beginFlight({ do: 'flee_to', room: d.room, hold_ms: 0, max_ms: Math.min(sortie.max_ms, 600_000),
      strategy: d.strategy, why: d.why }, threat, trigger, { sortie })) { this.sortie = null; return false; }
    this.s.recorder?.line?.('combat', { event: 'pvp_strategy_sortie', phase: 'going', room: d.room, home: d.home,
      target: threat ?? null, trigger, strategy: d.strategy ?? null, why: d.why ?? null });
    return 'going';
  }

  /** Arrived (or already there): lift our room list, hold the keeper in the map, and look around. */
  postSortie() {
    const t = this.sortie, now = this.now();
    if (!t) return;
    t.phase = 'posted'; t.arrived_at = now; t.until = t.started_at + t.max_ms; t.last_hostile_at = now;
    this.strategyEngage = { room: t.room, until: t.until, player: t.threat, strategy: t.strategy, sortie: true };
    const keeper = this.keeper?.();
    if (keeper) keeper.pvpStrategyHold = { room: t.room, until: t.until, orders: true, strategy: t.strategy,
      threat: t.threat, set_at: now, sortie: true };
    this.s.recorder?.line?.('combat', { event: 'pvp_strategy_sortie', phase: 'posted', room: t.room, home: t.home,
      post: t.row != null ? { row: t.row, col: t.col } : null, strategy: t.strategy });
    try { this.scanForEnemies(this.s.client); } catch { /* the next object change scans again */ }
  }

  /** End the sortie; with `home`, walk back as a flight and hold there for home_hold_ms. */
  endSortie(reason, { home = true } = {}) {
    const t = this.sortie;
    if (!t) return;
    this.sortie = null;
    const keeper = this.keeper?.();
    if (this.strategyEngage?.sortie) this.strategyEngage = null;
    if (keeper?.pvpStrategyHold?.sortie) keeper.pvpStrategyHold = null;
    t.phase = 'ended'; t.ended_at = this.now(); t.end_reason = reason;
    this.lastSortie = t;
    this.s.recorder?.line?.('combat', { event: 'pvp_strategy_sortie', phase: 'ended', room: t.room, home: t.home,
      reason, strategy: t.strategy });
    if (!home) return;
    const here = this.s.world?.room?.num;
    const back = { do: 'flee_to', room: t.home, hold_ms: t.home_hold_ms, hold_orders: true, max_ms: 600_000,
      strategy: t.strategy, why: `sortie over: ${reason}` };
    if (here === t.home) this.setStrategyHold(back, t.threat);
    else this.beginFlight(back, t.threat, 'sortie_over');
  }

  /** Every 250 ms from the keeper process: keep a posted sortie honest, and end it when it is over. */
  sortieTick() {
    const t = this.sortie, s = this.s, c = s.client;
    if (!t) return;
    if (!s.live || !c?.self || c.vitals?.()?.health?.value === 0) { this.endSortie('no live body', { home: false }); return; }
    if (t.phase === 'going') {
      // The flight owns the walk; if it ended without posting, so did the sortie.
      if (!this.active?.flight?.sortie) this.endSortie('the walk out did not arrive', { home: false });
      return;
    }
    const here = s.world?.room?.num, now = this.now();
    // ONE MAP OUT AND NO FURTHER: anywhere but the sortie map ends it, and anywhere but home walks back.
    if (here !== t.room) { this.endSortie(`left the sortie map for ${here}`, { home: here !== t.home }); return; }
    if (this.roomCount().hostiles_here > 0) t.last_hostile_at = now;
    // A GUARD WAITS FOR THE FIGHT IT IS GUARDING. Rehearsal, 2026-10-16: two door guards posted outside the bastion
    // went home after 30 quiet seconds while the enemy was still fighting inside, and it walked out to nobody.
    if (t.wait_home_fight) {
      const home = this.alarmRoomAt.get(t.home) ?? 0;
      if (home > t.last_hostile_at && home <= now) t.last_hostile_at = home;
    }
    if (this.active?.pvp) return;                       // a fight in progress finishes first
    if (now >= t.until) this.endSortie('max_ms reached');
    else if (now - t.last_hostile_at >= t.idle_ms) this.endSortie(`no hostile for ${Math.round(t.idle_ms / 1000)}s`);
  }

  // ------------------------------------------------------------------ the joust
  //
  // m59-pvp-strategy.mjs `joust`: return fire in timed exchanges. An exchange is `swings` attacks sent by the
  // ordinary attack path below; then the body backs away INSIDE THIS ROOM until it is `gap` squares clear of
  // the attacker, and the next exchange starts `period_ms` after the last one began. The point is the clock,
  // not the distance: a fight that trades a blow every few seconds instead of every second lasts several times
  // as long, which is what lets help arrive while it is still going on.

  /** Install, re-pace or (d null) end the joust on the fight `o`. */
  applyJoust(o, d) {
    const p = o?.pvp, now = this.now();
    if (!p) return;
    if (!d) {
      if (p.joust) { p.joust = null; this.record('pvp_joust_ended', o); }
      return;
    }
    const fresh = !p.joust;
    const j = p.joust ??= { phase: 'exchange', phase_at: now, exchange_started_at: now, sent_at_start: (o.attacks ?? 0) + (o.casts ?? 0),
      exchanges: 0, started_at: now };
    Object.assign(j, { period_ms: d.period_ms, swings: d.swings, gap: d.gap, until: now + d.ms, why: d.why ?? null,
      strategy: d.strategy ?? null });
    if (fresh) this.record('pvp_joust_started', o);
  }

  /**
   * One combat tick under a joust. true: the tick was the joust's (an evading step, or standing clear);
   * false: the ordinary attack path takes it (an exchange, or no joust at all).
   */
  async joustTick(o, target) {
    const p = o.pvp, j = p?.joust, now = this.now();
    if (!j) return false;
    if (now >= j.until) { p.joust = null; this.record('pvp_joust_ended', o); return false; }
    const sent = (o.attacks ?? 0) + (o.casts ?? 0);
    if (j.phase === 'exchange') {
      // An exchange ends when its swings are sent, or when it cannot land them (the attacker keeps away).
      if (sent - j.sent_at_start < j.swings && now - j.phase_at < JOUST_EXCHANGE_MAX_MS) return false;
      j.phase = 'evade'; j.phase_at = now; j.exchanges++;
      this.record('pvp_joust_evade', o);
    }
    if (j.swings > 0 && now >= j.exchange_started_at + j.period_ms) {
      j.phase = 'exchange'; j.phase_at = now; j.exchange_started_at = now; j.sent_at_start = sent;
      this.record('pvp_joust_exchange', o);
      return false;
    }
    const c = o.client, me = c.self;
    if (!me || !target) return true;
    if (Math.hypot(target.row - me.row, target.col - me.col) >= j.gap) return true;
    const away = joustRetreat(this.s.world?.geometry, me, target, j.gap);
    const next = away && safeCombatStep(this.s, { ...away, exact: false }, { fineBody: true });
    if (!next) { j.last_step = { at: now, reason: away ? 'no safe step away' : 'no square clear of the attacker' }; return true; }
    await this.stand(o);
    const before = { row: me.row, col: me.col };
    const result = next.fine ? await this.s.stepFine(next.x, next.y) : await this.s.step(next.col, next.row, { confirm: true });
    j.last_step = { at: now, from: before, toward: away, reason: result?.reason ?? null };
    return true;
  }

  beginPvP(evidence, observedAt = this.now()) {
    const s = this.s, c = s.client;
    if (!s.live || !c?.self || !(s.world?.room?.num > 1) || c.vitals?.()?.health?.value === 0) return;
    // A STRATEGY FLIGHT IN PROGRESS keeps going: a blow on the road is the reason for the road. The
    // alarm still goes out, so fleet-mates in the room we are running to know what is coming.
    if (this.active?.flight) { this.raiseWarAlarm(evidence.character, 'attacked', s.world.room.num); return; }
    // THE CHARACTER'S PVP STRATEGY ANSWERS FIRST (m59-pvp-strategy.mjs). Silence -- no strategy, or
    // `default` -- leaves everything below exactly as it was. `engage` lifts our room list here (so
    // `outside` below reads null); `flee_to` takes the body and travels, as survival.
    const strategyDecision = this.consultPvpStrategy('attacked_by_player', evidence.character,
      { hostile: true, basis: 'attacked' });
    const fled = (strategyDecision?.do === 'flee_to' && this.beginFlight(strategyDecision, evidence.character, 'attacked'))
      || (strategyDecision?.do === 'sortie' && this.beginSortie(strategyDecision, evidence.character, 'attacked') === 'going');
    if (this.sortie?.phase === 'posted' && this.sortie.room === s.world.room.num) this.sortie.last_hostile_at = this.now();
    // OUTSIDE pvp_rooms (operator, 2026-10-11: "stop people from fighting back outside of
    // 599/2/38"). No return fire and the body is NOT taken: the keeper's own ladder (flee below the
    // line, playDead, panic logoff) is the survival that applies, as for anything else hurting us
    // that we will not fight. The attack is still evidence: a combat line, the durable PvP log
    // (a red-alert watcher reads it), and the war alarm, which fleet-mates in allowed rooms act on.
    const outside = this.pvpRoomsRefusal();
    if (outside) {
      const key = `${outside.room}|${String(evidence.character).toLowerCase()}`;
      if (this.pvpOutsideNoted !== key) {
        this.pvpOutsideNoted = key;
        s.recorder?.line?.('combat', { event: 'pvp_outside_rooms', target: evidence.character,
          room: outside.room, pvp_rooms: outside.rooms, text: evidence.text ?? null,
          survival: fled ? `PvP strategy ${strategyDecision.strategy}: flight to ${strategyDecision.room}`
            : 'keeper ladder (flee/logoff); outside pvp_rooms this character does not return fire' });
      }
      if (this.pvpLogging()) {
        try {
          pvplog.appendPvp(outsideRoomsRow({ at: Math.min(this.now(), Number.isFinite(observedAt) ? observedAt : this.now()),
            observer: this.pvpObserver(), room: outside.room, attacker: evidence.character,
            rooms: outside.rooms, text: evidence.text ?? null }));
        } catch { /* evidence, never a reason to change what the body does */ }
      }
      this.raiseWarAlarm(evidence.character, 'attacked', outside.room);
      // A fight that already owned the body ends here (syncPvP gives the reason).
      if (this.active?.pvp) this.syncPvP(this.active);
      return;
    }
    if (fled) { this.raiseWarAlarm(evidence.character, 'attacked', s.world.room.num); return; }
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
          reconnects: 0, ended_at: null, outcome: null,
          start_health: Number.isFinite(c.vitals?.()?.health?.value) ? c.vitals().health.value : null, joust: null } };
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
    // THE JOUST (m59-pvp-strategy.mjs): every blow asks the strategy again, and its latest answer paces the
    // fight. Any answer other than `joust` -- silence included -- is ordinary return fire again.
    if (this.pvpStrategy) this.applyJoust(o, strategyDecision?.do === 'joust' ? strategyDecision : null);
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
    // Walked (or was carried) out of pvp_rooms: the fight ends with ITS OWN reason, never the
    // suspension text above, and survival returns to the keeper ladder (m59-pvp-rooms.mjs).
    { const outside = this.pvpRoomsRefusal();
      if (outside && s.live && c?.self) { this.stop(pvpRoomsStopReason(outside)); return false; } }
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
      // A RESCUE is the fleet answering its own alarm; like a strategy flight it does not ask the confinement.
      demand(order.rescue || !confine.length || confine.map(Number).includes(order.map), 'ambush map is outside confinement');
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
    // A FLIGHT HAS NO HEALTH FLOOR: it is what the character does below one.
    demand((o.pvp || o.flight ? this.healthFraction() > 0 : this.healthOK(o.order)) &&
      this.s.world?.room?.num > 1, o.pvp || o.flight ? 'waiting for live health' : 'survival floor reached');
    if (o.phase !== 'positioning' && o.phase !== 'fleeing') demand(o.client.room.id === o.roomObject &&
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
    if (this.s.world?.room?.num === 1) this.personalThreat.reset();
    this.personalThreat.observe(ev, client, { engaged: this.personalThreatStatus().level !== 'quiet', skipCombat: true });
    this.fallback.observe(ev);
    this.tapClient(client);
    this.notePvpTraverse(client);
    if (ev.kind === 'room-contents' || ev.kind === 'appeared' || ev.kind === 'changed' || ev.kind === 'moved') this.notePvpAppearances(client);
    this.observeWar(ev, client);
    if (ev.kind === 'groan') { try { this.observeGroan(ev, client); } catch { /* evidence only */ } }
    if (ev.kind === 'stat' && String(ev.name).toLowerCase() === 'health') this.noteYelp(client);
    if (ev.kind === 'logged-on' || ev.kind === 'logged-off') this.onPlayerListEvent(ev);
    if (ev.kind === 'said' || ev.kind === 'message') { this.observeLeash(ev); this.hear(ev); }
    if (ev.kind === 'said') this.noteFightSaid(ev);
    if (ev.kind === 'message' && ev.text) this.noteFightMessage(ev.text);
    if (ev.kind === 'message' && ev.text && this.lastWandId != null) this.noteWandMessage(ev.text);
    if (ev.kind === 'message' && ev.text) this.recordPvpDeath(ev, client);
    this.observePlayerCombat(ev, client);
    this.observeMonsterCombat(ev, client);
    if (this.s.joints?.paks?.length) {
      try { this.observeOutcome(ev, client); } catch { /* a joint never stops the event loop */ }
      try { this.observeCreature(ev, client); } catch { /* likewise */ }
    }
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
    if (o.flight) {
      const f = o.flight;
      f.ended_at = this.now(); f.end_reason = reason; f.outcome = f.arrived_at ? 'arrived' : 'stopped';
      // A flight that did not land backs off before the next one, or a road the router cannot plan is
      // re-planned on every packet that shows the same player.
      if (!f.arrived_at) this.flightBackoffUntil = this.now() + FLIGHT_BACKOFF_MS;
      this.lastFlight = f;
      if (f.sortie && !f.arrived_at && this.sortie === f.sortie) this.endSortie(`the walk out stopped: ${reason}`, { home: false });
      finishSurvivalDecision(this.s, f.decision_id, f.outcome, reason);
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
        room: this.s.world?.room?.num ?? null, target: o.order.target ?? null, pvp, reason: o.reason ?? null,
        loc: this.pvpLoc(), detail: this.milestoneDetail(event, o) });
      if (row) pvplog.appendPvp(row);
      this.lastPvpFight = pvp.decision_id ?? this.lastPvpFight ?? null;
      if (event === 'finished') { this.pvpTailUntil = Date.now() + 30_000; this.closeWandShot(); this.sealPvp('finished', o); }
      else if (pvplog.COMBAT_EVENTS.has(event)) this.sealPvp('during', o);
    }
  }

  // The decision behind a milestone, for the record: what the opener asked for and why it waited,
  // how ready the body was. Small on purpose -- the actions file has the packets.
  milestoneDetail(event, o) {
    if (event === 'opener_cast' || event === 'opener_wait' || event === 'opener_strategy_fault') {
      const r = o.lastReadiness;
      return { spell: o.openerSpell ?? null, aim: o.openerAim ?? null, waiting: o.openerWaiting ?? null,
        fault: o.pvp?.opener_fault ?? null, phase: o.phase ?? null,
        readiness: r ? { ready: r.ready ?? null, positioned: r.positioned ?? null, timer_remaining_ms: r.timer_remaining_ms ?? null, why: r.why ?? r.reason ?? null } : null };
    }
    return o.phase ? { phase: o.phase } : null;
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
      // Any enemy's death heard here opens the loot window, whoever wrote the death row.
      // The guild-combat broadcast is war.parseGuildCombat's ("of the The Second Swines");
      // parseDeathBroadcast reads the other forms and returns null for this one.
      const g = war.parseGuildCombat(ev.text), b = g ? { who: g.victim } : parseDeathBroadcast(ev.text);
      if (b?.who && !this.isOurs(b.who)) { this.pvpLootUntil = Date.now() + 120_000; this.pvpLootVictim = b.who; }
    } catch { /* evidence only */ }
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
    // The normal keeper pass is suspended in combat. Keep its observed HP
    // available to fellow keepers even during a long movement await.
    publishFleetHealth(this.s, { now: this.now() });
    const phaseRevision = o.phaseRevision;
    withBodyCommand(this.s, () => withPacketScope(kind => {
      demand(o.phaseRevision === phaseRevision, 'combat visibility changed');
      this.guard(o, kind);
    }, () => {
      this.support.offer(o);
      if (o.fallbackReason) this.fallback.offer(o, o.fallbackReason);
    }), o.id);
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
    o.fallbackReason = null;
    o.fallbackPrimary = { range: 2 };
    if (o.flight) {
      o.fallbackReason = 'flight'; this.fallback.offer(o, o.fallbackReason);
      return this.advanceFlight(o);
    }
    if (!o.pvp && effectsAt(c, c.self).length) {
      demand(await escapeGroundEffect(s), 'ground effect underfoot; no safe escape step');
      return;
    }
    if (o.phase === 'positioning') {
      if (s.world.room.num !== o.order.map) {
        await this.stand(o);
        // Ordinary validated router, under this order's packet and survival guards.
        this.armTimer();
        const result = await s.travel(o.order.map, { origin: keeperOrigin('combat_order', { run_id: o.id }), movementGeneration: s.movementGeneration, controlToken: o.id, allowRescue: NO_TELEPORT });
        this.guard(o);
        demand(result?.arrived && s.world.room.num === o.order.map, result?.reason ?? 'ambush map was not reached');
      }
      if (o.order.keepoff || o.order.rescue) {
        // KEEP-OFF: near his ghost is enough (several of us share it), and if he is already standing
        // here there is nothing to wait for. A RESCUE is the same shape: the fight is already here.
        const here = combatTarget(c, o.order.target);
        const near = Math.hypot(c.self.row - o.order.position.row, c.self.col - o.order.position.col) <= 2;
        if (!here && !near) {
          const next = safeCombatStep(s, { ...o.order.position, exact: false });
          demand(next, o.order.rescue ? 'no safe path to the fight' : 'no safe path to the logoff ghost');
          await this.stand(o); await s.step(next.col, next.row); return;
        }
        o.room = s.world.room.num; o.roomObject = c.room.id; o.armedAt = this.now();
        o.phase = 'waiting'; o.phaseRevision++; this.record(o.order.rescue ? 'rescue_arrived' : 'keepoff_waiting', o);
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
      if (o.pvp) { o.fallbackReason = 'target_absent'; this.fallback.offer(o, o.fallbackReason); }
      await this.restoreSafety();
      if (o.pvp && this.active === o && o.phase === 'waiting') await this.shelterFromMonsters(o);
      return;
    }
    const target = c.room.objects.get(o.targetId);
    if (!target || exactName(c, target) !== o.targetName) { this.refreshTarget(o); return; }
    if (o.pvp?.joust && await this.joustTick(o, target)) return;
    await this.prepareSafety(o);
    if (o.pvp || this.targetAtWar(o) || o.order.warband) {
      // THE OPENER (pvpOpener, above) goes first, and its first cast goes even before the gear: an
      // opening spell lands on the beat the target appears, not after a gear swap.
      if (!o.pvpGearOn && !o.openerFirst) { o.openerFirst = true; if (await this.pvpOpener(o, target)) return; }
      // PVP GEAR ON, ONCE PER FIGHT, inside this fight's own packet scope (m59-pvp-gear.mjs).
      if (!o.pvpGearOn) await this.pvpGearOn(o);
      if (await this.pvpOpener(o, target)) return;
      // A wand hold reserves the shared attack timer, not the feet. Close the
      // gap during the cooldown so targeted openers and melee can become usable.
      const volley = await this.wandVolley(o);
      if (volley) {
        const live = c.room.objects.get(o.targetId);
        if (volley === 'approach' || live && Math.hypot(live.row - c.self.row, live.col - c.self.col) > 2)
          await this.approachCombat(o, live, { sight: volley === 'approach' });
        return;
      }
    }
    if (this.now() < o.nextAt) {
      if (o.order.sequence[o.index]?.do === 'attack' && Math.hypot(target.row - c.self.row, target.col - c.self.col) > 2)
        await this.approachCombat(o, target);
      return;
    }
    if (o.pendingAdvance) {
      o.pendingAdvance = false;
      this.nextAction(o);
      if (this.active !== o) return;
    }
    const step = o.order.sequence[o.index];
    if (step.do === 'wait') { o.nextAt = this.now() + step.ms; this.nextAction(o); return; }
    o.lastReadiness = { action: step.do, ...this.attackReadiness(o, target,
      { range: step.do === 'attack' ? 2 : null, sight: step.do === 'cast' && step.target === 'target' }) };
    if (step.do === 'attack' && !this.attackReadiness(o, target, { range: 2 }).positioned) {
      // One shared approach for melee, targeted spells and blocked wand sight.
      await this.approachCombat(o, target); return;
    }
    if (step.do === 'cast' && step.target === 'target' && !this.attackReadiness(o, target, { sight: true }).positioned) {
      o.fallbackPrimary = { sight: true };
      await this.approachCombat(o, target, { sight: true }); return;
    }
    if (this.attackReadiness(o, target).timer_remaining_ms > 0) return;
    await this.stand(o);
    if (step.do === 'attack') {
      await this.faceCombatTarget(o);
      await s.pacer.submit('attack', () => {
        // Range can change while facing or pacing; do not spend an attack on a
        // stale position. The next event/tick will plan the next short approach.
        const live = c.room.objects.get(o.targetId);
        const ready = this.attackReadiness(o, live, { range: 2, facing: true });
        o.lastReadiness = { action: 'attack', ...ready };
        if (!ready.ready) return;
        if (c.attack(live.id) === false) return;
        this.lastOutChannel = { channel: 'melee', at: this.now() };
        this.attackReadyAt = this.now() + 1000;
        o.nextAt = this.attackReadyAt;
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
    } else {
      const spell = (c.spells ?? []).find(sp => exactName(c, sp) === step.spell.toLowerCase());
      demand(spell, 'spell is no longer known');
      if (step.target === 'target') await this.faceCombatTarget(o);
      await withCastRite(s, { spell, pvp: !!o.pvp, why: 'combat sequence' }, () => s.pacer.submit('cast', () => {
        const live = c.room.objects.get(o.targetId);
        if (!this.attackReadiness(o, live, { sight: step.target === 'target', facing: step.target === 'target' }).ready) return;
        c.cast(spell.id, step.target === 'none' ? [] : [step.target === 'self' ? c.selfId : live.id]);
        this.lastOutChannel = { channel: `spell:${String(step.spell).toLowerCase()}`, at: this.now() };
        this.attackReadyAt = this.now() + this.spellTimerMs(step.spell);
        o.casts++; o.pendingAdvance = true;
        o.nextAt = this.now() + step.hold_ms;
      }, 1050));
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

  async faceCombatTarget(o) {
    await this.s.pacer.submit('turn', () => {
      const live = o.client.room.objects.get(o.targetId), me = o.client.self;
      if (!live || !me) return;
      const degrees = (Math.round(Math.atan2(live.row - me.row, live.col - me.col) * 180 / Math.PI) + 360) % 360;
      o.client.face(degrees); o.faceDeg = degrees;
    });
  }
}
