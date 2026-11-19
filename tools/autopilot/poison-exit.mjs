// THE POISON EXIT: A SHELTER THAT IS BEING REACHED IS NOT A SHELTER.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), installed onto Autopilot.prototype by
// `installParts` (tools/autopilot/parts.mjs). Do not import this file directly: import tools/m59-autopilot.mjs, which
// loads it. `autopilotSource()` (tools/autopilot/source.mjs) splices the `@part` block below into the keeper's text.
//
// 6 methods: poisonWatchNow, poisonExitState, poisonOverrideReason, takePoisonExit, curePotionInPack, drinkCurePotion
//
// THE OPERATOR'S RULE STANDS: "the correct solution to poison is to lock down in the nearest safe spot until the poison
// ends and healing occurs afterwards, not to flee through it". It is right because poison cannot kill (player.kod
// PoisonTimer clamps at 1). It is right ONLY while nothing can reach the spot: a poisoned body sheltering at 3 health with
// a black spider able to bite it is not sheltering. Waldorf (t4), 2026-11-19 04:11Z, Ancient Place 579, 146 max health:
// the recovery dispatcher (safe-spots.mjs continueSurvivalDecisionStep, status 'recovering') rested him from 112 to 10 on
// a square nothing could reach, 8 s at a time, every pass ending there before the survival ladder (the flee line at 45%
// and the doomed rung never ran); the one-logoff rule had already spent his logoff; and when a stacked poison's icon
// vanished the next tick read as an attack, the rest was "interrupted", and he walked off the square at 9 health into
// four black spiders.
//
// SO, WHILE POISONED, EVERY PASS ASKS m59-poison.mjs poisonExitVerdict:
//   shelter   nothing can reach the square (a geometric wall, nothing in reach, no attack for 12 s): stay. Unchanged.
//   respond   reached, health to spare: the square has failed. The rest is interrupted (restUntil now attributes falls by
//             the poison's own clock, so a bite on a poisoned body interrupts and a poison tick does not), the spot is
//             recorded as failed, and the existing replacement moves the body; the ladder's fight-back answers the biter.
//   exit      reached, and health -- or health less the poison still to come -- at the flee line or one blow from death:
//             the best exit there is, in order: cure (the spell, then a carried cure poison potion), heal, the play-dead
//             logoff EVEN IF this healing session spent its one (once: m59-healing-session.mjs mayOverrideLogoff), then
//             out of the room by its nearest permitted exit. The inn walk is retreatToSafety, switched off on this fleet
//             (retreat_to_inn), so the room's exit is the last one here. Nothing left: the ladder gets the pass.
import { castRecoveryCure, affordablePoisonCure } from '../m59-recovery-cure.mjs';
import { affordableHeal, castRecoveryHeal } from '../m59-recovery-heal.mjs';
import { mayLogoff, mayOverrideLogoff, SPENT_EXIT_RETRY_MS } from '../m59-healing-session.mjs';
import { levelBlow, PoisonWatch, poisonedNow, poisonExitVerdict, poisonStacks } from '../m59-poison.mjs';
import { potionCatalogue, potionCondition } from '../m59-potions.mjs';
import { chooseSurvivalDecision, currentSurvivalDecision } from '../m59-survival-decision.mjs';
import { roomIsNoCombat } from '../m59-hazards.mjs';
import { healAllowOf } from '../m59-autopilot.mjs';

// One attempt of each exit per this long, so a cure that fizzles or a heal that is refused is not the whole answer.
const EXIT_RETRY_MS = 8_000;

export class PoisonExitPart {
  // @part 1
  /** The session's poison watch, sampled now. A poison outlives the socket, so it lives on the session. */
  poisonWatchNow(now = Date.now()) {
    const s = this.s;
    if (!s) return null;
    const w = (s.poisonWatch ??= new PoisonWatch());
    try { if (s.client) w.sampleClient(s.client, now); } catch { /* the verdict reads what the watch already has */ }
    return w;
  }

  /**
   * THE VERDICT FOR THIS MOMENT (m59-poison.mjs poisonExitVerdict) over this keeper's own numbers. Pure apart from the
   * watch sample; cheap enough for every pass and for restUntil's 3-second cancel check.
   */
  poisonExitState(v = null, now = Date.now()) {
    const s = this.s, c = s?.client;
    if (!c || s.live === false || s.world?.room?.num === 1) return { act: 'none', why: 'no body to read' };
    const w = this.poisonWatchNow(now);
    const vit = v ?? c.vitals?.(), hp = vit?.health?.value, max = vit?.health?.max;
    const iconPoisoned = poisonedNow(c);
    const poisoned = iconPoisoned || !!w?.ticking(now, false);
    if (!poisoned) return { act: 'none', why: 'not poisoned' };
    const me = String(s.name ?? '');
    // Nothing swings in a NO_COMBAT room (an inn): whatever is "in reach" there cannot reach.
    const safeRoom = (() => { try { return roomIsNoCombat(s); } catch { return false; } })();
    let near = [];
    try { near = safeRoom ? [] : (this.inReachOfUs?.() ?? []); } catch { near = []; }
    let wall = null;
    try { wall = this.wallHere?.() ?? null; } catch { wall = null; }
    let fleeAt = null;
    try { fleeAt = this.safety?.()?.fleeAt ?? null; } catch { fleeAt = null; }
    fleeAt ??= this.policy?.fleeBelow ?? 0.45;
    const blows = near.map(o => levelBlow(this.creatureLevel?.(String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase())))
      .filter(Number.isFinite);
    const observed = w?.strongestAttack(now) ?? null;
    const strongestHit = Math.max(observed ?? 0, ...blows, 0) || null;
    const allow = healAllowOf(this);
    let cure = false, heal = false, potion = false;
    try { cure = !!affordablePoisonCure(c); } catch { cure = false; }
    try { heal = Number.isFinite(hp) && hp < max && !!affordableHeal(c, { allow }); } catch { heal = false; }
    try { potion = !!this.curePotionInPack?.(); } catch { potion = false; }
    // ON A WALL, ONLY A BLOW TAKEN SINCE ARRIVING ON IT (or since the last relog, which drops every attacker) says the
    // wall is being reached: the bites that drove the body here say nothing about the square it reached.
    let lastAttackAt = safeRoom ? null : (w?.lastAttackAt() ?? null);
    if (lastAttackAt != null && wall?.ok === true) {
      const since = Math.max(Number(this.hold?.takenAt) || 0, Number(this.rejoinedAt) || 0);
      if (since && lastAttackAt <= since) lastAttackAt = null;
    }
    const verdict = poisonExitVerdict({
      hp, max, poisoned,
      projection: w?.projection({ hp, now, poisoned: iconPoisoned, stacks: poisonStacks(c) }) ?? null,
      fleeAt, inReach: near.length, wallOk: wall ? wall.ok === true : null,
      lastAttackAt, now, strongestHit,
      can: { cure, heal, potion },
      logoff: { available: mayLogoff(me), overrideAvailable: mayOverrideLogoff(me) },
    });
    verdict.icon = iconPoisoned;
    // One journal line per change of answer, not one per pass.
    const key = `${verdict.act}|${(verdict.exits ?? []).join(',')}`;
    if (key !== this._poisonVerdictKey) {
      this._poisonVerdictKey = key;
      if (verdict.act === 'exit' || verdict.act === 'respond' || this._poisonVerdictSaid)
        this.note(verdict.act === 'exit' ? 'POISONED AND REACHED: the shelter will not hold'
          : verdict.act === 'respond' ? 'poisoned and the shelter is being reached' : 'poisoned: sheltering in place holds',
          { ...verdict, health: `${hp}/${max}`, flee_at: fleeAt });
      this._poisonVerdictSaid = verdict.act !== 'shelter' && verdict.act !== 'none';
    }
    this._poisonVerdict = { ...verdict, at: now };
    return verdict;
  }

  /** For playDead: a reason when this body may take the projected-death override logoff, else null. */
  poisonOverrideReason() {
    let v = null;
    try { v = this.poisonExitState(); } catch { v = null; }
    return v?.act === 'exit' && v.exits?.includes('logoff_override') ? v.why : null;
  }

  /** The exits, in order, one per call. True when something was done (the dispatcher's pass ends); false: the ladder. */
  async takePoisonExit(verdict, decision = currentSurvivalDecision(this.s)) {
    const s = this.s, c = s.client, now = Date.now();
    const room = s.world?.room?.num ?? null;
    const t = (this._poisonExitTried && this._poisonExitTried.room === room) ? this._poisonExitTried
      : (this._poisonExitTried = { room, at: {} });
    const due = step => !(now - (t.at[step] ?? 0) < (step === 'leave_room' ? SPENT_EXIT_RETRY_MS : EXIT_RETRY_MS));
    // A SHELTER THAT IS BEING HIT IS NOT A SHELTER: recorded, so the dispatcher, the session's "is this the spot" and the
    // refuge search stop calling it one.
    if (verdict.hit_ms_ago != null && c?.self && room != null) {
      try { this.noteFailedRestSpot?.(room, c.self.col, c.self.row); } catch { /* bookkeeping only */ }
    }
    const generation = s.movementGeneration, client = c;
    const cancelled = () => s.client !== client || s.movementWasCancelled?.(generation) || s.world?.room?.num !== room;
    for (const step of verdict.exits ?? []) {
      if (!due(step)) continue;
      t.at[step] = now;
      try {
        if (step === 'cure') {
          const r = await castRecoveryCure(s, { shouldCancel: cancelled });
          this.note('poison exit: cure poison', { ...r, why: verdict.why });
          if (r.cast) { this.recordCast?.(r.spell, { ok: r.confirmed, ...r }); return true; }
        } else if (step === 'potion') {
          const r = await this.drinkCurePotion();
          this.note('poison exit: cure poison potion', { ...r, why: verdict.why });
          if (r.drank) return true;
        } else if (step === 'heal') {
          const r = await castRecoveryHeal(s, { shouldCancel: cancelled, allow: healAllowOf(this) });
          this.note('poison exit: heal', { ...r, why: verdict.why });
          if (r.cast) { this.recordCast?.(r.spell, { ok: r.confirmed, ...r }); return true; }
        } else if (step === 'logoff' || step === 'logoff_override') {
          // playDead asks poisonOverrideReason itself, so the override is recorded with its reason in the session.
          const before = currentSurvivalDecision(s)?.id;
          const did = await this.playDead(verdict.why);
          if (did) { this.progress?.('logged off: poisoned and reached'); return true; }
          if (currentSurvivalDecision(s)?.id !== before) return true;   // it installed a move (nearest refuge): drained next
        } else if (step === 'leave_room') {
          const d = chooseSurvivalDecision(s, { strategy: 'leave_room', reason: verdict.why, reason_code: 'poison_exit',
            source: 'recovery', mitigation: 'poisoned and reached with no health to spare, and the logoff is spent: out by the nearest permitted exit' },
            { because: 'a shelter that is being reached is not a shelter', outcome: 'failed' });
          this.note('poison exit: leaving the room', { why: verdict.why, decision_id: d?.id ?? null, room });
          if (await this.leaveRoomForRecovery(d)) return true;
        }
      } catch (e) {
        this.note('poison exit step failed', { step, why: e?.message ?? String(e) });
      }
    }
    this.note('poisoned and reached, and every exit is spent or refused: the ordinary ladder takes the pass',
      { tried: t.at, verdict: verdict.why });
    return false;
  }

  /** A cure poison potion in the pack, by the compiled potion catalogue (substrate/m59-potions.json), or null. */
  curePotionInPack() {
    const c = this.s?.client;
    const cat = potionCatalogue();
    for (const item of c?.inventory ?? []) {
      const name = String(c.rsc?.get?.(item.nameRsc) ?? item.name ?? '').trim();
      const p = cat.get(name.toLowerCase());
      if (p && String(p.effect).toLowerCase() === 'cure poison') return { item, name, potion: p };
    }
    return null;
  }

  /**
   * Drink a carried cure poison potion, after a fresh LOOK proves it is not spoiled (a spoiled potion is harmful:
   * potion.kod vrBadDesc; m59-potions.mjs potionCondition). Returns {drank, why}.
   */
  async drinkCurePotion() {
    const s = this.s, c = s.client, found = this.curePotionInPack();
    if (!found) return { drank: false, why: 'no cure poison potion in the pack' };
    const { item, potion } = found;
    let since;
    await s.pacer.submit('read', () => { since = c.evSeq; c.look(item.id); });
    const seen = await c.waitFor({ since, kinds: ['look'], match: e => e.id === item.id, timeoutMs: 2000 }).catch(() => ({}));
    const look = seen?.events?.find?.(e => e.id === item.id);
    if (!look) return { drank: false, why: 'the potion could not be looked at' };
    const condition = potionCondition(potion, look.description);
    if (!condition.safe) return { drank: false, why: `not drinking it: ${condition.reason}` };
    if (!(c.inventory ?? []).some(i => i.id === item.id)) return { drank: false, why: 'the potion left the pack' };
    await s.pacer.submit('use', () => c.use(item.id));
    return { drank: true, item: item.id, condition: condition.reason };
  }
  // @end 1
}
