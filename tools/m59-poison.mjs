// POISON, AS THE KEEPER NEEDS TO KNOW IT. Pure.
//
// player.kod: AddPoison raises piPoisonStrength and starts a 10-second PoisonTimer; each tick takes strength/1000 health and
// CLAMPS AT 1 -- poison cannot kill, it only leaves a body one hit from death. The timer re-arms only while the player is in
// the world, and UserLogonHook starts a fresh one whenever strength remains, so a relog inside ten seconds runs two. A
// black spider (dethspid.kod) poisons one bite in ten: 5000 = 0.5 HP/s for 180 s, stacking.
//
// Operator, 2026-10-27: "the correct solution to poison is to lock down in the nearest safe spot until the poison ends
// and healing occurs afterwards, not to flee through it and risk low-health travel. Shelter in place."
//
// THAT RULE STANDS, AND IT RESTS ON ONE PREMISE: NOTHING CAN REACH THE SHELTER. Poison alone never kills (player.kod
// PoisonTimer: `if piHealth < 1 { piHealth = 1; }`), so a body on a square nothing can reach always lives through it. What
// kills a poisoned body is the poison bringing it to a few health WHILE SOMETHING CAN HIT IT. Waldorf (t4), 2026-11-19,
// Ancient Place 579, 146 max health: two black-spider poisons (10 a tick), the session's one logoff spent, 112 -> 10 on a
// square nothing could reach -- correct so far. Then the first poison ended, the client dropped the ailment while the
// second still drained (one spell object, two enchantments: m59-client.mjs ADD_ENCHANTMENT), the next tick read as "took
// 4 damage while resting -- something is hitting us", and the keeper walked off the safe square at 9 health into four
// black spiders. So this module answers two questions the keeper could not:
//
//   WHICH FALL WAS THE POISON (PoisonWatch). A tick lands on the poison's own 10 s clock and is no bigger than the last
//   one; a fall off that clock, a bigger one, or one with a hit message beside it is an ATTACK, poisoned or not. And a fall
//   on the clock shortly after the ailment vanished is still the poison (a stack can outlive the icon).
//
//   WHEN THE SHELTER STOPS BEING ONE (poisonExitVerdict). Exposed -- something in reach of a square that is not a geometric
//   wall, or an attack within the last few seconds -- and health, or health less the poison still to come, at or under the
//   flee line or one blow from the strongest thing in reach: leave by the best exit there is (cure, heal, the logoff even
//   if this healing session spent its one, then the room's way out). Not exposed: shelter in place, as ordered.
import { isEnemyHit } from './m59-combatlog.mjs';

export const POISON_RELOG_OFFLINE_MS = 12_000;
// The poison's own clock (player.kod AddPoison / PoisonTimer: CreateTimer(self,@PoisonTimer,10000)).
export const POISON_TICK_MS = 10_000;
// The longest poison in the game: the spider and the black spider, 180 s a stack (spider.kod / dethspid.kod
// POISON_DURATION = 180000). The dusk rat and the spider queen are 30 s. Used as an UPPER bound on what is still to come.
export const POISON_MAX_MS = 180_000;
// Before a tick has been seen: the strongest single stack in kod, the dusk rat's 10000 (duskrat.kod POISON_LOSSRATE),
// i.e. 10 a tick. The black spider's is 5.
export const POISON_TICK_DEFAULT = 10;
// player.kod PoisonTimer clamps at 1.
export const POISON_FLOOR = 1;
// A tick is on the clock within this much either side (pushed health vs a 500 ms watchdog sample, and a busy server).
export const POISON_CADENCE_SLACK_MS = 2_000;
// An attack this recent means the square is being reached, whatever the geometry says.
export const POISON_EXPOSED_MS = 12_000;
// A hit message this close to a fall is that fall's cause (the message and the health push are separate packets).
const HIT_BEFORE_MS = 2_500, HIT_AFTER_MS = 600;

/** Is this client poisoned now? The ailment enchantment the server pushes, by name. */
export function poisonedNow(c) {
  try { return (c?.ailments?.() ?? []).some(e => /poison|venom/i.test(String(e?.name ?? e ?? ''))); } catch { return false; }
}
/** When the newest poison landed, as the client saw it (the newest ADD of the counted entry), or null. */
export function poisonAddedAt(c) {
  try {
    const at = (c?.ailments?.() ?? []).filter(e => /poison|venom/i.test(String(e?.name ?? '')))
      .map(e => Number(e.last_at ?? e.at)).filter(Number.isFinite);
    return at.length ? Math.max(...at) : null;
  } catch { return null; }
}
/** How many poisons the client counts on us (m59-client.mjs counts each enchantment), 0 when none. */
export function poisonStacks(c) {
  try {
    return (c?.ailments?.() ?? []).filter(e => /poison|venom/i.test(String(e?.name ?? '')))
      .reduce((n, e) => n + (Number(e.count) || 1), 0);
  } catch { return 0; }
}

/**
 * Every fall in health, attributed. One per session (it outlives a reconnect, as the poison does); sampled by the
 * keeper's 500 ms watchdog and by restUntil before it decides a rest was interrupted. Memory only, no I/O.
 */
export class PoisonWatch {
  constructor() {
    this.falls = [];          // {at, lost, kind: 'poison'|'attack'}, newest last
    this.lastHp = null; this.lastAt = null; this.client = null;
    this.poisonedAt = null;   // last sample that read poisoned
    this.addedAt = null;      // newest poison onset seen
    this.hitAt = null;        // newest enemy-hit message
    this.hitSeq = null;
    this.anchor = null;       // the last poison tick: {at, lost} -- the clock the next one is checked against
  }

  /** Read the client's own memory (vitals, ailments, new messages) and attribute any fall. Returns the new fall or null. */
  sampleClient(c, now = Date.now()) {
    if (!c) return null;
    let hp = null; try { hp = c.vitals?.()?.health?.value ?? null; } catch { hp = null; }
    // New hit messages since the last sample: only the events added since (seq), so this stays cheap at 2 Hz.
    const events = Array.isArray(c.events) ? c.events : [];
    if (this.client !== c) { this.hitSeq = null; }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (this.hitSeq != null && e.seq != null && e.seq <= this.hitSeq) break;
      if (e.kind === 'message' && isEnemyHit(e.text)) { this.hitAt = Math.max(this.hitAt ?? 0, Number(e.at) || now); }
    }
    const top = events[events.length - 1];
    if (top?.seq != null) this.hitSeq = top.seq;
    return this.sample({ at: now, hp, poisoned: poisonedNow(c), addedAt: poisonAddedAt(c), client: c });
  }

  /** One reading. A new client (a reconnect) restarts the poison's clock: UserLogonHook creates a fresh PoisonTimer. */
  sample({ at, hp, poisoned = false, addedAt = null, client = null, hitAt = null } = {}) {
    if (client !== this.client) { this.client = client; this.anchor = null; this.lastHp = null; }
    if (Number.isFinite(hitAt)) this.hitAt = Math.max(this.hitAt ?? 0, hitAt);
    if (poisoned) {
      this.poisonedAt = at;
      if (Number.isFinite(addedAt)) this.addedAt = Math.max(this.addedAt ?? 0, addedAt);
      else this.addedAt ??= at;
    }
    if (!Number.isFinite(hp)) return null;
    const before = this.lastHp;
    this.lastHp = hp; this.lastAt = at;
    if (before == null || hp >= before) return null;
    const lost = before - hp;
    const kind = this.classify({ at, lost, poisoned });
    const fall = { at, lost, kind };
    if (kind === 'poison') this.anchor = { at, lost };
    this.falls.push(fall);
    if (this.falls.length > 64) this.falls.splice(0, this.falls.length - 64);
    return fall;
  }

  /** Is a poison still running on this body, by the ailment or by its own ticks since the icon went? */
  ticking(now = Date.now(), poisoned = false) {
    if (poisoned) return true;
    const a = this.anchor;
    if (!a || now - a.at > POISON_TICK_MS + POISON_CADENCE_SLACK_MS) return false;
    return this.addedAt == null || now - this.addedAt <= POISON_MAX_MS + POISON_TICK_MS;
  }

  /** 'poison' or 'attack'. Pure over this watch's memory. */
  classify({ at, lost, poisoned = false }) {
    if (this.hitAt != null && at - this.hitAt <= HIT_BEFORE_MS && this.hitAt - at <= HIT_AFTER_MS) return 'attack';
    const lingering = !poisoned && this.ticking(at, false);
    if (!poisoned && !lingering) return 'attack';
    const a = this.anchor;
    if (!a) return poisoned ? (lost <= POISON_TICK_DEFAULT * 3 ? 'poison' : 'attack') : 'attack';
    const since = at - a.at;
    const phase = since % POISON_TICK_MS;
    const onClock = since >= POISON_TICK_MS - POISON_CADENCE_SLACK_MS &&
      (phase <= POISON_CADENCE_SLACK_MS || phase >= POISON_TICK_MS - POISON_CADENCE_SLACK_MS);
    // A NEW stack since the last tick makes the next one bigger; a bite brings it, and the bite's message says attack.
    const grew = this.addedAt != null && this.addedAt > a.at;
    const size = grew ? a.lost + POISON_TICK_DEFAULT : a.lost;
    // Regeneration between ticks can hide a point; a coarse reader (restUntil, 3 s) can merge one regen into a tick.
    return onClock && lost <= size + 1 ? 'poison' : 'attack';
  }

  /** The newest poison tick's size, or null when none has been seen. */
  tickSize() { return this.anchor?.lost ?? null; }

  /** Losses attributed in (from, to]: {poison, attack}. */
  attribute(from, to = Infinity) {
    let poison = 0, attack = 0;
    for (const f of this.falls) if (f.at > from && f.at <= to) { if (f.kind === 'poison') poison += f.lost; else attack += f.lost; }
    return { poison, attack };
  }
  /** The newest attack: a hit message, or a fall attributed to an attack. */
  lastAttackAt() {
    let at = this.hitAt ?? null;
    for (let i = this.falls.length - 1; i >= 0; i--) if (this.falls[i].kind === 'attack') { at = Math.max(at ?? 0, this.falls[i].at); break; }
    return at;
  }
  /** The biggest single attack fall in the last minute, or null. */
  strongestAttack(now = Date.now(), windowMs = 60_000) {
    const seen = this.falls.filter(f => f.kind === 'attack' && now - f.at <= windowMs).map(f => f.lost);
    return seen.length ? Math.max(...seen) : null;
  }

  /** Health less every tick still to come, never under the clamp. An upper bound on the drain (see POISON_MAX_MS). */
  projection({ hp, now = Date.now(), poisoned = false, stacks = 0 } = {}) {
    const on = this.ticking(now, poisoned);
    const tick = this.tickSize() ?? POISON_TICK_DEFAULT * Math.max(1, stacks || 1);
    // From the newest onset: a logoff freezes the enchantment (player.kod FreezeAllEnchantments) and the relog re-sends
    // it, so this over-states what is left -- the safe direction for a bound on what is still to come.
    const remainingMs = on ? Math.max(0, Math.min(POISON_MAX_MS, (this.addedAt ?? now) + POISON_MAX_MS - now)) : 0;
    const ticks = Math.ceil(remainingMs / POISON_TICK_MS);
    const drain = on ? tick * ticks : 0;
    return { ticking: on, tick: on ? tick : 0, remaining_ms: remainingMs, remaining_ticks: ticks, drain,
             floor: Number.isFinite(hp) ? Math.max(POISON_FLOOR, hp - drain) : null };
  }

  status(now = Date.now()) {
    return { ticking: this.ticking(now, this.poisonedAt != null && now - this.poisonedAt < 1_500),
             tick: this.tickSize(), last_tick_at: this.anchor?.at ?? null, added_at: this.addedAt,
             last_attack_at: this.lastAttackAt(), recent: this.falls.slice(-6) };
  }
}

/**
 * The biggest blow a monster of this level deals by default (monster.kod GetDamage: Fuzzy(viLevel / Random(10,15)); Fuzzy:
 * num - num/4 + Random(0, num*2/4), integer division). A level-75 black spider: 9. A monster with its own piMaxDamage can
 * exceed it, which is why an OBSERVED blow outranks this wherever there is one.
 */
export const levelBlow = level => {
  if (!(Number.isFinite(level) && level > 0)) return null;
  const n = Math.floor(level / 10);
  return n - Math.floor(n / 4) + Math.floor(n * 2 / 4);
};

/**
 * WHAT A POISONED BODY ON (OR SEEKING) ITS SHELTER DOES NOW.
 *   hp, max            health now
 *   poisoned           the ailment, or the watch's lingering tick
 *   projection         PoisonWatch.projection(): .floor is health less the poison still to come (clamped at 1)
 *   fleeAt             the flee line this body runs on (a fraction)
 *   inReach            hostile creatures within melee reach of the body
 *   wallOk             the square is a geometric wall nothing can attack (senses.wallHere().ok)
 *   lastAttackAt, now  the newest attack (hit message or an off-clock fall)
 *   strongestHit       the biggest blow the things in reach deal (observed, or levelBlow)
 *   can                { cure, potion, heal } -- what this body can do right now
 *   logoff             { available, overrideAvailable } -- the healing session's answer (m59-healing-session.mjs)
 * Returns { act: 'none'|'shelter'|'respond'|'exit', exposed, line, floor, why, exits }.
 *   shelter   nothing can reach the square: stay, the poison cannot kill (the operator's rule)
 *   respond   the square is being reached but health has room: it is not a shelter -- give it up, fight back or move
 *   exit      reached, and health (or health less the poison to come) at the flee line or one blow from death
 */
export function poisonExitVerdict({ hp, max, poisoned = false, projection = null, fleeAt = 0.45, inReach = 0,
                                    wallOk = null, lastAttackAt = null, now = Date.now(), strongestHit = null,
                                    can = {}, logoff = {} } = {}) {
  if (!poisoned) return { act: 'none', why: 'not poisoned' };
  const reached = inReach > 0 && wallOk !== true;
  const hitRecently = Number.isFinite(lastAttackAt) && now - lastAttackAt <= POISON_EXPOSED_MS;
  const exposed = reached || hitRecently;
  const floor = Number.isFinite(projection?.floor) ? Math.min(hp, projection.floor) : hp;
  const line = Math.max(Math.ceil((Number(fleeAt) || 0) * (max || 0)), Number(strongestHit) || 0);
  const base = { exposed, line, floor, hp, in_reach: inReach, wall_ok: wallOk, hit_ms_ago: hitRecently ? now - lastAttackAt : null };
  if (!exposed)
    return { act: 'shelter', ...base, why: 'poison cannot kill (player.kod PoisonTimer clamps at 1) and nothing can reach this ' +
      'square: shelter in place until it ends' };
  if (!(Number.isFinite(hp) && Number.isFinite(floor)) || floor > line)
    return { act: 'respond', ...base, why: `the shelter is being reached (${reached ? inReach + ' in reach of a square that is not a wall' : 'hit ' +
      Math.round((now - lastAttackAt) / 1000) + 's ago'}) with ${floor} health still projected over the line at ${line}: it is not a shelter` };
  const exits = [];
  if (can.cure) exits.push('cure');
  if (can.potion) exits.push('potion');
  if (can.heal) exits.push('heal');
  if (logoff.available) exits.push('logoff');
  else if (logoff.overrideAvailable) exits.push('logoff_override');
  exits.push('leave_room');
  return { act: 'exit', ...base, exits,
    why: `poisoned and reached: ${hp} health, ${floor} after the poison still to come, against a line of ${line} ` +
      `(flee ${Math.round((fleeAt || 0) * 100)}% or one blow): the shelter will not hold, take the best exit there is` };
}
