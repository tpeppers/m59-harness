// ONE ROW PER WAND ZAP, NAMING WHY THE SERVER REFUSED IT.
//
// "You point your wand but nothing happens." is ONE message for several gates, and on 2026-10-07
// it answered 147 of 182 volleys at Morpheus (81%). Against a player only three of those gates are
// silent — players never resist (battler.kod:184-187 is not overridden by player.kod or user.kod):
//
//   1. SIGHT    the target is in another room, or Room.LineOfSight fails      wand.kod:77-85
//   2. TIMER    under 2 s since the last ACCEPTED zap, cast or swing           spell.kod:760, player.kod:5305
//   3. ROOM     a no-combat room                                               spell.kod:888-892
//
// and one more says "not in view" FIRST and then the same line, so a reader that matches only
// "nothing happens" files it with the silent three:
//
//   4. FACING   the target is behind you: "You can't see your selected target."  player.kod:246,4186-4204
//
// So the server's reply cannot tell us which gate it was. What can is writing down, AT SEND TIME,
// every input those gates read, and predicting the answer. A refusal the prediction did not see
// coming is the interesting one: it means a gate is missing from this model.
//
// Pure: no I/O, no clock. CombatMode builds the row (tools/m59-combat-mode.mjs wandVolley) and
// writes it with pvplog.appendShot. See m59-research design/wand-refusal-telemetry.md.

import { lineOfSight } from './m59-safespots.mjs';

export const SHOT_SCHEMA = 'm59-wand-shot/1';
// How long after a zap the server's reply is collected. Every refusal on 2026-10-07 arrived
// inside 300 ms of its volley; 800 leaves room for a slow evening without swallowing the next beat.
export const REPLY_WINDOW_MS = 800;
// The server's attack timer after a lightning bolt: AttackSpell viPostCast_time = 2 (atakspel.kod:31),
// in seconds, through IsOkayAttackTime(#seconds=...).
export const ATTACK_TIMER_MS = 2000;
// A target square older than this is a guess about where he WAS; such a shot is charged to
// 'stale', not to the wall it would have been behind.
export const STALE_MS = 500;
// Server LOS mode: settings.kod:119 `piLOS = LOS_OLD` — the coarse CanMoveInRoom. Stamped on every
// row so a server that changes it does not silently invalidate the history.
export const LOS_MODE = 'LOS_OLD';

const MAX_ANGLE = 4096;
const A16 = n => (n * MAX_ANGLE) / 16;
const ESE = A16(1), SSE = A16(3), SSW = A16(5), WSW = A16(7), WNW = A16(9), NNW = A16(11), NNE = A16(13), ENE = A16(15);

/**
 * TargetWithinSightAndRange's "behind you" test, transcribed (player.kod:4186-4204). `angle` is
 * the server's 0-4095 (0 = east, clockwise; blakston.khd:1231-1248); squares are COARSE, as
 * SquaredDistanceTo uses (nomoveon.kod:104). Returns true when the server would say "not in view".
 * null when an input is missing — unknown is not "in front".
 */
export function behindYou(me, target, angle) {
  if (![me?.row, me?.col, target?.row, target?.col, angle].every(Number.isFinite)) return null;
  const a = ((Math.round(angle) % MAX_ANGLE) + MAX_ANGLE) % MAX_ANGLE;
  const r = me.row, c = me.col, tr = target.row, tc = target.col;
  const dist = (tr - r) ** 2 + (tc - c) ** 2;
  if (!(dist > 1)) return false;
  return ((a > ENE || a <= ESE) && tc < c)
    || (a > ESE && a <= SSE && (tr - r) < (c - tc))
    || (a > SSE && a <= SSW && tr < r)
    || (a > SSW && a <= WSW && (tr - r) < (tc - c))
    || (a > WSW && a <= WNW && tc > c)
    || (a > WNW && a <= NNW && (tr - r) > (c - tc))
    || (a > NNW && a <= NNE && tr > r)
    || (a > NNE && a <= ENE && (tr - r) > (tc - c));
}

/** The first step of the server's staircase walk that a body could not take, or null. */
export function losBlock(geo, from, to) {
  if (!geo?.canMove) return null;
  let r = from.row, c = from.col, r2 = r, c2 = c;
  const rs = to.row - from.row >= 0 ? 1 : -1, cs = to.col - from.col >= 0 ? 1 : -1;
  for (let guard = 0; (r !== to.row || c !== to.col) && guard < 512; guard++) {
    if (Math.abs(r - to.row) > Math.abs(c - to.col)) r2 += rs; else c2 += cs;
    if (!geo.canMove(r, c, r2, c2, { fine: false })) return { from: [r, c], to: [r2, c2] };
    r = r2; c = c2;
  }
  return null;
}

const since = (now, at) => (Number.isFinite(at) ? now - at : null);
const sq = o => (o && Number.isFinite(o.row) && Number.isFinite(o.col) ? { row: o.row, col: o.col } : null);

/**
 * The row, at send time. Everything here is what THIS client believes the instant before the
 * packet goes; the server's own copy of each is newer by a round trip, which is why the
 * staleness of each position is part of the row rather than an afterthought.
 *
 * @param {object} p
 *   now, shotId, fight, character, room, roomFlags { noCombat, guildPkOnly },
 *   me { row, col, x, y, posAt, angle, degrees }, target { id, name, row, col, x, y, posAt, inRoom },
 *   wand { id, name, colour, decoded }, strategy, why, beat, face (bool), faceDeg,
 *   geo (RoomGeometry or null), lastAcceptedZapAt, lastCast { at, name }, lastSwingAt, lastApplyAt
 */
export function buildShot(p) {
  const now = p.now;
  const me = sq(p.me), tgt = sq(p.target);
  const sameRoom = !!p.target?.inRoom;
  const geo = p.geo ?? null;
  let los = null, losReverse = null, block = null;
  if (geo && me && tgt && sameRoom) {
    try {
      los = lineOfSight(geo, me.row, me.col, tgt.row, tgt.col);
      losReverse = lineOfSight(geo, tgt.row, tgt.col, me.row, me.col);
      if (!los) block = losBlock(geo, me, tgt);
    } catch { los = losReverse = null; }
  }
  // The angle the server will judge us by: what we just asked for when the strategy turned us
  // (the turn packet is sent ahead of the apply on the same pacer), else the last the server pushed.
  const serverAngle = Number.isFinite(p.me?.angle) ? p.me.angle : null;
  const judgedAngle = p.face && Number.isFinite(p.faceDeg)
    ? Math.round(p.faceDeg * MAX_ANGLE / 360) & (MAX_ANGLE - 1)
    : Number.isFinite(p.me?.degrees) ? Math.round(p.me.degrees * MAX_ANGLE / 360) & (MAX_ANGLE - 1) : serverAngle;
  const behind = me && tgt ? behindYou(me, tgt, judgedAngle) : null;
  const sinceZap = since(now, p.lastAcceptedZapAt);
  const sinceCast = since(now, p.lastCast?.at);
  const sinceSwing = since(now, p.lastSwingAt);
  // The timer is set by the last ACCEPTED action of any kind. A cast or swing we sent is assumed
  // accepted — the conservative direction for this question, since it can only add timer blame.
  const timerSince = [sinceZap, sinceCast, sinceSwing].filter(Number.isFinite);
  const timerBlocked = timerSince.length ? Math.min(...timerSince) < ATTACK_TIMER_MS : false;
  const tgtAge = since(now, p.target?.posAt), meAge = since(now, p.me?.posAt);
  const shot = {
    schema: SHOT_SCHEMA, kind: 'shot', shot_id: p.shotId, at: now, fight: p.fight ?? null,
    character: p.character ?? null, room: p.room ?? null,
    target: { id: p.target?.id ?? null, name: p.target?.name ?? null },
    wand: { id: p.wand?.id ?? null, name: p.wand?.name ?? null, colour: p.wand?.colour ?? null, decoded: !!p.wand?.decoded },
    strategy: p.strategy ?? null, why: p.why ?? null, beat: p.beat ?? null,
    sight: {
      los_mode: LOS_MODE, same_room: sameRoom,
      me: me ? { ...me, x: p.me.x ?? null, y: p.me.y ?? null, pos_age_ms: meAge } : null,
      tgt: tgt ? { ...tgt, x: p.target.x ?? null, y: p.target.y ?? null, pos_age_ms: tgtAge } : null,
      dist: me && tgt ? +Math.hypot(tgt.row - me.row, tgt.col - me.col).toFixed(2) : null,
      los, los_reverse: losReverse, los_block: block, geometry: !!geo,
    },
    timer: {
      timer_ms: ATTACK_TIMER_MS,
      since_last_accepted_zap_ms: sinceZap,
      since_last_cast_ms: sinceCast, last_cast: p.lastCast?.name ?? null,
      since_last_swing_ms: sinceSwing,
      since_last_apply_ms: since(now, p.lastApplyAt),
      blocked: timerBlocked,
    },
    facing: {
      face_sent: !!p.face, face_deg: Number.isFinite(p.faceDeg) ? p.faceDeg : null,
      local_degrees: Number.isFinite(p.me?.degrees) ? p.me.degrees : null,
      angle_server: serverAngle, angle_judged: judgedAngle,
      bearing_deg: me && tgt ? (Math.round(Math.atan2(tgt.row - me.row, tgt.col - me.col) * 180 / Math.PI) + 360) % 360 : null,
      behind,
    },
    room_flags: { no_combat: !!p.roomFlags?.noCombat, guild_pk_only: !!p.roomFlags?.guildPkOnly },
    sent_at: null, queued_ms: null,
    reply: { window_ms: REPLY_WINDOW_MS, messages: [] },
    refused: null, hit_text: null,
    predicted: null, cause: null,
  };
  shot.predicted = predictCause(shot);
  return shot;
}

/**
 * The first gate expected to refuse, in the order the server runs them: the wand's own sight
 * check (wand.kod:77-85) before CanPayCosts' timer (spell.kod:760) before its range/facing check
 * (spell.kod:836-840) before the no-combat room (spell.kod:888-892). 'stale' replaces 'los' when
 * the target square we judged by was already old — that is a wrong square, not a wall.
 */
export function predictCause(shot) {
  const s = shot.sight;
  if (!s.same_room) return 'other_room';
  if (s.los === false) return (s.tgt?.pos_age_ms ?? 0) > STALE_MS ? 'stale' : 'los';
  if (shot.timer.blocked) return 'timer';
  if (shot.facing.behind === true) return 'facing';
  if (shot.room_flags.no_combat) return 'no_combat';
  return 'none';
}

const NOTHING = /point your wand but nothing happens/i;
// player_attack_not_in_view (player.kod:246), sent by the facing test before Wand_fails.
const NOT_IN_VIEW = /can'?t see your selected target/i;

/** Attach one server line heard inside the reply window. Mutates and returns the shot. */
export function addReply(shot, text, at) {
  if (!shot || shot.reply.messages.length >= 24) return shot;
  shot.reply.messages.push({ at, dt_ms: Number.isFinite(shot.sent_at) ? at - shot.sent_at : null, text: String(text) });
  if (NOTHING.test(text)) shot.refused = true;
  const name = shot.target?.name;
  if (!shot.hit_text && name && !NOTHING.test(text) && String(text).toLowerCase().includes(String(name).toLowerCase()))
    shot.hit_text = String(text);
  return shot;
}

/**
 * Close the row when its window ends. `cause` is what the row is FOR:
 *   refused + predicted gate      -> that gate
 *   refused + nothing predicted   -> 'unexplained'  (a gate this model does not know about)
 *   accepted + predicted refusal  -> 'unexpected'   (the model is wrong about a gate)
 *   accepted + nothing predicted  -> 'none'
 * A "not in view" line in the window overrides the prediction: the server named the gate itself.
 */
export function finishShot(shot) {
  if (!shot) return shot;
  if (shot.refused == null) shot.refused = false;
  const said = shot.reply.messages.some(m => NOT_IN_VIEW.test(m.text) && !NOTHING.test(m.text));
  if (shot.refused) shot.cause = said ? 'facing' : shot.predicted === 'none' ? 'unexplained' : shot.predicted;
  else shot.cause = shot.predicted === 'none' ? 'none' : 'unexpected';
  return shot;
}

/** Tally rows by cause: the one number this exists to produce. */
export function summarizeShots(rows) {
  const out = { shots: 0, refused: 0, by_cause: {} };
  for (const r of rows) {
    if (r?.kind !== 'shot') continue;
    out.shots++;
    if (r.refused) out.refused++;
    const k = r.cause ?? 'open';
    out.by_cause[k] = (out.by_cause[k] ?? 0) + 1;
  }
  out.refusal_rate = out.shots ? +(out.refused / out.shots).toFixed(3) : null;
  return out;
}
