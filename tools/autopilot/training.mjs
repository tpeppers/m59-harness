// TRAINING: touch spells, training weapons and styles, and arming up for a player.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 26 methods: touchTrainingHere, touchState, observeTouchSpell, approachLegs, policyDefaultFor,
//   trainingWeaponOnlyNow, touchEquipVeto, touchDisarm, maintainTouchSpell, touchTimingNow,
//   touchOnTarget, touchSpellStatus, bannedWeaponsHeld, hostilePlayersInReach, escalateArmForPvp,
//   bannedWeaponUseless, bannedConjurablesHeld, weaponPriorityNow, trainingStyleFor,
//   styleForNonPrey, onTrainingImprovement, isTrainingPrey, finishTrainingBout,
//   unuseTrainingWeapon, trainingWeaponNow, prepareTrainingStyle
import { bannedWeaponsHeld } from '../m59-arming.mjs';
import { withCastRite } from '../m59-castrite.mjs';
import { normalizePractice } from '../m59-deskpractice.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import * as skills from '../m59-skills.mjs';
import { TouchSpellState, touchCastTiming, touchRecastBackoffMs, touchRefreshDue } from '../m59-touchspell.mjs';
import { CONJURABLE_WEAPONS, REACH, policyDefaults } from '../m59-autopilot.mjs';

export class TrainingPart {
  // @part 1

  /** Is this character training its touch spell RIGHT HERE, right now? */
  touchTrainingHere(room = this.s?.world?.room) {
    const spec = this.touchSpellNow();
    if (!spec) return false;
    const assigned = this.policy?.assignedRoom;
    return this.mode === 'farm' && assigned != null && room?.num === assigned;
  }

  /** The tracker for the configured spell, rebuilt if the order names a different one. */
  touchState() {
    const spec = this.touchSpellNow();
    if (!spec) return null;
    if (this._touch?.name !== spec.name) this._touch = new TouchSpellState(spec.name);
    return this._touch;
  }

  /** Read every new server line into the tracker. Memory only — no wire, no wait. */
  observeTouchSpell(c = this.s?.client) {
    const st = this.touchState();
    if (!st || !c) return [];
    try { return st.consume(c); } catch { return []; }
  }

  // THE TRAINING WEAPON, AND NOTHING ELSE, WHEN THE OPERATOR SAYS SO.
  //
  // Operator, 2026-10-11: "we want lupoggs hunted with axes for the damage type slash" (a lupogg takes
  // -10 from slash and resists every weapon 70, lupogg.kod). Janice carried a hammer at 70 and an axe
  // at 39, and with `training_style: short_sword` + `training_weapon: axe` + `weapon_priority: [axe]`
  // she was still found holding the hammer: one of the ten equip call sites re-armed her with it
  // within forty seconds of the axe going on, and banning the hammer was what stopped it. A ban is the
  // wrong tool -- a banned weapon is the first thing shed when the pack needs room, and three of them
  // switch create weapon off (`bannedConjurablesHeld`), which is the spell that makes the axe.
  //
  // So this answers `s.equipOnly`, which `equipBest` asks once for every call site, exactly as it asks
  // `s.equipVeto`: while `trainingWeaponOnly` is set and the armed style names a weapon, only that
  // weapon may be chosen. With none in the pack the hand stays empty and the roulette / makeWeapon
  // conjures one. PvP escalation ranks with `weaponRanking` directly and is not affected.
  /**
   * The approach rooms still to walk before `room`, or null. Only for a journey to the station or a
   * confined room that starts outside the confinement; resumes after the approach room the body is in.
   */
  approachLegs(room, here = this.s?.world?.room?.num) {
    const path = Array.isArray(this.policy?.approachRooms) ? this.policy.approachRooms.map(Number) : null;
    if (!path?.length || room == null || here == null) return null;
    const dest = Number(room), at = Number(here);
    const confine = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms.map(Number) : [];
    if (dest !== Number(this.policy?.assignedRoom) && !confine.includes(dest)) return null;
    if (confine.includes(at) && !path.includes(at)) return null;     // already inside, off the approach
    const legs = path.slice(path.indexOf(at) + 1).filter(r => r !== dest && r !== at);
    return legs.length ? legs : null;
  }

  /** A policy key's committed default (the farm strategy engine resets a leaked shadow to it), or undefined. */
  policyDefaultFor(key) {
    const d = policyDefaults();
    return d && Object.hasOwn(d, key) ? d[key] : undefined;
  }

  /** `s.equipOnly`: the only weapon names `equipBest` may choose, or null for no restriction. */
  trainingWeaponOnlyNow() {
    if (this.policy?.trainingWeaponOnly !== true) return null;
    if ((this.policy?.trainingStyle ?? 'normal') !== 'short_sword') return null;
    const w = String(this.policy?.trainingWeapon ?? '').trim().toLowerCase();
    return w ? [w] : null;
  }

  /** `s.equipVeto`: a reason string while the hand is meant to stay empty, else null. */
  touchEquipVeto() {
    if (!this.touchTrainingHere()) return null;
    return `touch spell training: ${this.touchSpellNow().name} is the weapon on room ` +
      `${this.policy.assignedRoom}, and a wielded weapon would be swung instead of it ` +
      '(player.kod:4712-4729). Unset touch_spell to arm here.';
  }

  /**
   * EMPTY THE HAND, AND PROVE IT. `unuseTrainingWeapon` first (the id join, then the name), and
   * if the server still says armed, a DIRECT `unuse` of every weapon the equipment list names by
   * a real id — the one path measured to work instantly on prod (unarmed-training-never-disarms).
   */
  async touchDisarm() {
    const s = this.s, c = s?.client;
    if (!c || !skills.isArmed(c)) return { ready: true, already: true };
    const first = await this.unuseTrainingWeapon().catch(e => ({ ready: false, why: e.message }));
    if (first.ready && !skills.isArmed(c)) return first;
    const worn = (c.equipment?.()?.equipped ?? [])
      .filter(o => Number.isFinite(o?.id) && o.id > 0 &&
        skills.weaponScore(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '') > 0);
    const removed = [];
    for (const o of worn) {
      const before = c.evSeq;
      await s.pacer.submit('use', () => c.unuse(o.id)).catch(() => {});
      await c.waitFor?.({ since: before, kinds: ['equipment', 'message'], timeoutMs: 3000 })?.catch?.(() => {});
      removed.push(o.name ?? c.rsc?.get?.(o.nameRsc) ?? `#${o.id}`);
    }
    const ready = !skills.isArmed(c);
    return { ready, removed: removed[0] ?? first.removed, direct: removed,
             ...(ready ? {} : { why: first.why ?? 'the server still reports a weapon in the hand' }) };
  }

  /**
   * KEEP THE HAND EMPTY AND THE BUFF ON. Called before a swing on the assigned room.
   *
   * Never blocks a fight: whatever happens here, the caller swings next, bare. A cast that
   * cannot be afforded says why on the status and the character keeps fighting with its fists
   * (or rests, by the ordinary ladder) — refusing to fight for want of a buff would turn a
   * reagent shortage into an idle character.
   *
   * MANA IS THE PROOF A CAST LANDED, NOT THE REPLY (cast-is-a-decision-not-an-outcome): a
   * cast is counted as landed only on a START line, mana spent, or a reagent consumed. An
   * ALREADY line settles an unknown state for free.
   */
  async maintainTouchSpell(why = 'before a swing', { refresh = false } = {}) {
    if (!this.touchTrainingHere()) return { skipped: 'not training here' };
    const spec = this.touchSpellNow();
    const st = this.touchState();
    const s = this.s, c = s?.client;
    if (!c) return { skipped: 'no client' };
    this.observeTouchSpell(c);

    // 1. THE HAND.
    if (st.needDisarm || skills.isArmed(c)) {
      const bare = await this.touchDisarm().catch(e => ({ ready: false, why: e.message }));
      st.needDisarm = !bare.ready;
      if (bare.ready && bare.removed)
        this.note('touch spell training: put down the weapon', { removed: bare.removed,
          spell: spec.name, why: 'a wielded weapon is swung instead of the touch (player.kod:4712-4729)' });
      else if (!bare.ready && Date.now() - (this._touchDisarmComplaint ?? 0) > 60_000) {
        this._touchDisarmComplaint = Date.now();
        this.note('touch spell training: could NOT put the weapon down', { why: bare.why ?? null,
          spell: spec.name, cost: 'every swing is the weapon, and the touch spell trains nothing' });
      }
    }

    // 2. THE BUFF.
    // `refresh` is the on-target timing asking to cast OVER a buff that may be about to lapse
    // (touchRefreshDue). Without it an active touch is left alone, as it always was.
    if (st.active === true && !refresh) { st.blockedReason = null; return { active: true }; }
    const now = Date.now();
    const wait = touchRecastBackoffMs(this._touchUnprovenRun ?? 0);
    if (st.lastCastAt != null && now - st.lastCastAt < wait)
      return { active: st.active, waiting_ms: wait - (now - st.lastCastAt) };

    const block = (reason, extra = {}) => {
      const changed = st.blockedReason !== reason;
      st.blockedReason = reason;
      if (changed || now - (this._touchBlockedNoteAt ?? 0) > 60_000) {
        this._touchBlockedNoteAt = now;
        this.note('touch spell training: cannot cast it, fighting bare', { spell: spec.name, reason, ...extra });
      }
      return { active: st.active, blocked: reason };
    };
    const selfId = c.selfId;
    if (!selfId) return block('no object id for ourselves yet — a self-cast needs the numeric id');
    let spell = (c.spells || []).find(sp => (c.rsc?.get?.(sp.nameRsc) || sp.name || '').toLowerCase() === spec.name);
    if (!spell && !this._touchSpellsAsked) {
      this._touchSpellsAsked = true;
      await s.pacer.submit('read', () => c.requestSpells?.()).catch(() => {});
      await new Promise(x => setTimeout(x, 400));
      spell = (c.spells || []).find(sp => (c.rsc?.get?.(sp.nameRsc) || sp.name || '').toLowerCase() === spec.name);
    }
    if (!spell) return block(`the character does not know ${spec.name}`);
    const mana = c.vitals?.()?.mana?.value ?? null;
    if (mana != null && mana < spec.mana)
      return block('not enough mana', { mana, needs: spec.mana });
    const count = (re) => (c.inventory || []).filter(o => re.test(c.rsc?.get?.(o.nameRsc) || o.name || ''))
      .reduce((n, o) => n + (Number.isFinite(Number(o.amount)) && o.amount != null ? Math.max(0, Number(o.amount)) : 1), 0);
    // practiceSpells.keep is a floor for EVERY drill on this pack, the touch included: acid touch and
    // the darkness it must leave berries for spend the same entroot (m59-deskpractice.mjs `keep`).
    const keep = normalizePractice(this.policy.practiceSpells)?.keep ?? {};
    for (const r of spec.reagents) {
      const have = count(r.match);
      const kept = keep[r.item] || 0;
      if (have - kept < r.count) return block(kept ? `short of ${r.item} above the ${kept} kept back` : `short of ${r.item}`,
        { have, kept, needs: r.count });
    }
    const reagentsBefore = spec.reagents.map(r => count(r.match));

    // 3. CAST, AT OUR OWN OBJECT ID. Not the name (it does not resolve) and never "me" (it
    // resolved to somebody else on prod). A touch spell takes no target (touchatk.kod:120-123);
    // [selfId] is the request the server builds from an empty list anyway (persench.kod:75-86).
    const wasActive = st.active;
    st.lastCastAt = now;
    st.castAttempts++;
    const before = c.evSeq;
    await withCastRite(s, { spell, targets: [selfId], why: 'maintainTouchSpell' }, () => s.pacer.submit('cast', () => c.cast(spell.id, [selfId]), 1050));
    await c.waitFor?.({ since: before, kinds: ['message', 'stat'], timeoutMs: 3000 })?.catch?.(() => {});
    const seen = this.observeTouchSpell(c);
    const manaAfter = c.vitals?.()?.mana?.value ?? null;
    const spent = mana != null && manaAfter != null && mana - manaAfter > 0;
    const usedReagent = spec.reagents.some((r, i) => count(r.match) < reagentsBefore[i]);
    const started = seen.includes('start');
    const already = seen.includes('already');
    const landed = started || spent || usedReagent;
    if (landed) {
      st.active = true;
      if (!started && st.lastStart == null) st.lastStart = Date.now();
      st.recasts++;
      st.punchesSinceCast = 0;
      st.blockedReason = null;
      st.castsUnproven = 0;
      this._touchUnprovenRun = 0;
      st.lastCastResult = started ? 'started' : spent ? 'mana spent' : 'reagent spent';
    } else if (already) {
      st.active = true;
      st.blockedReason = null;
      this._touchUnprovenRun = 0;
      st.lastCastResult = 'already on';
    } else {
      st.castsUnproven++;
      this._touchUnprovenRun = (this._touchUnprovenRun ?? 0) + 1;
      st.lastCastResult = 'no proof — no start line, no mana or reagent spent';
      st.blockedReason = 'the last cast left no trace (refused in silence?)';
    }
    this.recordCast?.(spec.name, { ok: landed || already, why: `touch spell training: ${why}`,
      target: 'self', mana_before: mana, mana_after: manaAfter, was_active: wasActive,
      result: st.lastCastResult });
    this.note(landed ? 'touch spell training: cast the touch on ourselves'
              : already ? 'touch spell training: the touch was already on'
              : 'touch spell training: the cast left no trace', {
      spell: spec.name, why, was_active: wasActive, mana_before: mana, mana_after: manaAfter,
      result: st.lastCastResult });
    return { cast: true, landed, already, active: st.active };
  }

  /** The configured cast timing; an unusable stored value reads as the default. */
  touchTimingNow() {
    try { return touchCastTiming(this.policy?.touchSpellTiming); } catch { return 'on_target'; }
  }

  /**
   * THE TOUCH, AT THE TARGET. Called once the farm pass has CHOSEN its quarry, before the
   * approach (timing 'on_target'). A cast here lands during the walk instead of costing the
   * opening round; a buff that may lapse within the margin is refreshed before a NEW quarry.
   * Once per target id: the same quarry chosen again next pass is not a new fight. Never blocks
   * the pass — whatever happens, the approach and the before-swing check follow.
   */
  async touchOnTarget(target, name = null) {
    if (!this.touchTrainingHere() || this.touchTimingNow() !== 'on_target') return { skipped: 'timing' };
    if (target?.id == null || target.id === this._touchTargetId) return { skipped: 'same target' };
    this._touchTargetId = target.id;
    const st = this.touchState();
    this.observeTouchSpell();
    const due = touchRefreshDue(st, Date.now());
    this._touchTargetLast = { id: target.id, name, at: Date.now(), due: due.due, why: due.why,
                              remaining_ms: due.remaining_ms };
    if (!due.due) return { skipped: due.why };
    return this.maintainTouchSpell(`target chosen: ${name ?? `#${target.id}`} (${due.why})`,
                                   { refresh: due.refresh });
  }

  /** For `status()`: always present, null when the posture is off. */
  touchSpellStatus() {
    const st = this.touchState();
    if (!st) return null;
    return { ...st.snapshot(), training_here: this.touchTrainingHere(),
             assigned_room: this.policy?.assignedRoom ?? null,
             timing: this.touchTimingNow(), last_target_check: this._touchTargetLast ?? null };
  }

  /**
   * Conjured weapons in the pack that this character's own ban list forbids it to hold.
   *
   * This is the hoard `create weapon` builds when the ban and the spell disagree: every cast
   * succeeds, every result is refused by `equipBest`, and the pack fills with them. A full
   * pack then answers `receiver_full` to every `supply`, so the character cannot even be
   * handed a weapon it IS allowed to use.
   *
   * THIS COMMENT SAT ON TOP OF `hostilePlayersInReach()` WITH NO METHOD UNDER IT until
   * 2026-09-20 — written for a function that was never added, or removed with the comment
   * left. So the diagnostic the 2026-09-18 incident asked for ("the diagnostic is
   * `bannedWeapons` ∩ pack contents, not the refusal text") did not exist, and `m59-rearm.mjs`
   * walked donors across the map to characters that could not keep what they were given. The
   * predicate is in `m59-arming.mjs` so `m59-rearm.mjs` can ask it too without importing
   * thirteen thousand lines of keeper; this is the keeper's door onto it.
   */
  bannedWeaponsHeld() {
    return bannedWeaponsHeld({
      items: this.s?.client?.inventory ?? [],
      banned: this.bannedWeaponsNow(),
      weaponScore: skills.weaponScore,
      isBannedWeapon: skills.isBannedWeapon,
    });
  }

  /**
   * Hostile PLAYERS within melee reach — the same predicate the survival ladder's
   * `strangers` uses: a player flag, attackable, and NOT a fleetmate. The fleetmate
   * exclusion is load-bearing rather than tidy; turning a fleet-mate red by hand and then
   * shooting it is the Statler incident of 2026-08-27.
   */
  hostilePlayersInReach() {
    const c = this.s?.client, me = c?.self;
    if (!me || !c?.room?.objects) return [];
    return [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.PLAYER) && (o.flags & OF.ATTACKABLE) &&
      !party.isFleetmate(c.rsc?.get(o.nameRsc)) &&
      Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row) <= REACH);
  }

  /**
   * ESCALATION: A MURDERER IS ABOUT TO INHERIT THE LOADOUT ANYWAY.
   *
   * `bannedWeapons` is a TRAINING preference — it protects a proficiency block that a
   * different weapon type would reset (player.kod:4753-4757). That is worth defending
   * against a fungus beast. It is not worth defending against a person who is killing you,
   * because everything in the hand and the pack drops on death and the training block dies
   * with the character holding it. The operator's framing, 2026-09-18: there is no reason
   * to be precious about equipment that is all about to be stolen by your murderer.
   *
   * So the ban is lifted for THIS case only: a hostile player in reach, no legal weapon in
   * hand. Scoped that narrowly on purpose — the general "may a starving character break its
   * ban" question is a training-versus-survival judgement and belongs to whoever owns the
   * split, not to the keeper.
   *
   * WHAT IS NOT LIFTED. `weaponRanking` filters cursed and unrevealed weapons
   * independently of the ban, so this keeps both. A ban is a preference and can be
   * overridden; wielding a cursed weapon is the one irreversible mistake in this game and
   * an emergency is exactly when somebody would be tempted to skip the check.
   *
   * WHAT IT PICKS. `weaponRanking` already sorts by the character's ABILITY in the
   * weapon's proficiency (`abilityOf(c, proficiencyFor(name))`), falling back to the crude
   * name score when the ability has not been read — so "most effective" means the weapon
   * this character is actually best with, not the biggest one. A bow is excluded unless
   * ammunition is aboard, because nothing else in the pipeline checks it and a drawn bow
   * with no arrows is strictly worse than fists.
   *
   * Returns the weapon taken up, or null — and null is a legitimate outcome: fists are a
   * weapon, and `passFightBack` swings either way.
   */
  async escalateArmForPvp(attacker = null) {
    const c = this.s?.client;
    if (!c) return null;
    const banned = this.bannedWeaponsNow();
    const hasAmmo = (c.inventory || []).some(o => {
      const n = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
      return /arrow|bolt/.test(n) && !/water finding/.test(n) && (o.amount ?? 1) > 0;
    });
    const ranked = skills.weaponRanking(c, { banned: null })
      .filter(r => hasAmmo || !/\bbow\b|crossbow|sling/i.test(r.name));
    if (!ranked.length) return null;                   // fists it is, and that is an answer
    const pick = ranked[0];
    const eq = await skills.equipBest(this.s, { priority: [pick.name], banned: null })
      .catch(() => null);
    if (!eq?.wielding) return null;
    const broke = banned?.length
      ? banned.some(b => String(eq.wielding).toLowerCase().includes(String(b).toLowerCase()))
      : false;
    if (broke) this.tally.pvp_ban_escalations = (this.tally.pvp_ban_escalations || 0) + 1;
    this.note(broke ? "PVP — breaking this character's own weapon ban to fight back"
                    : 'PVP — arming to fight back', {
      took_up: eq.wielding, proficiency: pick.skill ?? null, ability: pick.ability ?? null,
      banned_weapons: banned ?? undefined, attacker: attacker ?? null,
      why: broke
        ? 'a hostile player is in reach and every weapon this character is ALLOWED to ' +
          'hold is absent, so the alternative was fists. The ban protects a training ' +
          'block that dies with the character, and the pack drops to the killer either way'
        : 'a hostile player is in reach and the hand was empty',
      kept: 'cursed and unrevealed weapons are still refused — a ban is a preference, a ' +
            'curse is permanent' });
    return eq.wielding;
  }

  // A WEAPON THIS CHARACTER IS FORBIDDEN TO HOLD, WHATEVER MADE IT.
  //
  // Deliberately about the BAN and not about provenance: `equipBest` refuses it on every pass
  // whether the fleet conjured it or an orc dropped it, so it is dead weight either way. The
  // drop ranking uses this; the conjure gate below counts a narrower set.
  bannedWeaponUseless(name) {
    const n = String(name ?? '').toLowerCase();
    if (!n) return false;
    const banned = this.bannedWeaponsNow();
    if (!banned?.length) return false;
    // Only WEAPONS — the ban list is matched by substring elsewhere too, and a name fragment
    // like "dagger" must not catch a "dagger fern" if one is ever added.
    if (!(skills.weaponScore?.(n) > 0)) return false;
    return banned.some(b => n.includes(String(b).toLowerCase()));
  }

  bannedConjurablesHeld() {
    const c = this.s?.client;
    const banned = this.bannedWeaponsNow();
    if (!c || !banned?.length) return 0;
    const forbidden = n => banned.some(b => n.includes(String(b).toLowerCase()));
    return (c.inventory || []).filter(o => {
      const n = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
      if (!n) return false;
      return CONJURABLE_WEAPONS.some(w => n.includes(w)) && forbidden(n);
    }).length;
  }

  weaponPriorityNow(targetName = null) {
    // Undead override, above even the operator's list: blunt for a skeleton, a short
    // sword for a zombie (operator order, 2026-09-01). Only these two prey — every
    // other target keeps whatever answer the rungs below give. The fragments PREPEND
    // rather than replace, so a character carrying neither still reaches for its own
    // best weapon instead of standing unarmed on a technicality.
    const t = String(targetName ?? '').toLowerCase();
    const base = this.policy.weaponPriority
      ?? (() => { const l = this.loadout(); return l && l.gear.weapon.length ? l.gear.weapon : null; })();
    if (t.includes('skeleton')) return ['hammer', 'mace', ...(base ?? [])];
    if (t.includes('zombie')) return ['short sword', ...(base ?? [])];
    return base;
  }

  // A training bout belongs to one quarry. `skills.fight` deliberately resumes a
  // damaged target over a fresh one because changing targets discards advancement
  // credit; weapon style has to be just as sticky or an interrupted fight can count
  // once with each hand. The next style flips when a new quarry is selected.
  // SWITCHING WEAPON TYPE COSTS UP TO 74 SWINGS OF PROGRESS, so when to flip is not a
  // detail — it decides whether a training style trains anything at all.
  //
  // The server counts swings per proficiency and pays out in blocks of 75:
  // `SwingWeapon` (player.kod:4736-4765) resets `piWeaponSwings` to 0 whenever the wielded
  // weapon's proficiency differs from the one being counted, and BARE HANDS COUNT AS
  // SKID_BRAWLING — so short sword <-> fists is a proficiency change like any other. Only
  // every 75th swing raises `GetWeaponSwingBonus`, and `AssessHit` (player.kod:4536-4537)
  // will not roll for an improvement at all while that bonus is 0.
  //
  // `alternate` flips per QUARRY, and a fungus beast dies in well under 75 swings. That
  // combination never reaches the first payout: the counter is zeroed on every new monster,
  // the bonus stays 0, and NOT ONE improvement roll ever fires. It does not fail loudly —
  // the character fights normally for ever and simply never improves.
  //
  // `alternate_on_improve` flips only when an improvement actually lands, which is the one
  // free moment: `ChangeSkillAbility` already zeroes the counter itself when a Stroke or
  // Proficiency goes up (player.kod:7335-7339), so switching there discards nothing. Every
  // other switching schedule throws away part of a block.
  trainingStyleFor(targetId = null) {
    // A TOUCH SPELL IS SWUNG BY AN EMPTY HAND, so on its own ground it outranks whatever weapon
    // regimen is configured: passArm's disarm, prepareTrainingStyle('unarmed'), armSelf's and
    // makeWeapon's refusals and styleForNonPrey all key off this one answer.
    if (this.touchTrainingHere()) return 'unarmed';
    const configured = this.policy.trainingStyle ?? 'normal';
    if (configured === 'alternate_on_improve')
      return this._trainingNextStyle ?? 'short_sword';
    if (configured !== 'alternate') return configured;
    if (targetId == null)
      return this._trainingBout?.style ?? this._trainingNextStyle ?? 'short_sword';
    if (this._trainingBout?.target_id === targetId) return this._trainingBout.style;
    const style = this._trainingNextStyle ?? 'short_sword';
    this._trainingBout = { target_id: targetId, style };
    this._trainingNextStyle = style === 'short_sword' ? 'unarmed' : 'short_sword';
    return style;
  }

  /**
   * What to hold for a fight that is NOT the configured quarry. See the block at the call
   * site: 'normal' means equip:true, which re-arms a bare-handed character and undoes
   * passArm. Only the assigned farm ground gets the bare-handed answer -- everywhere else
   * the ordinary arm-first survival rule wins.
   */
  styleForNonPrey(room = null) {
    const onOwnGround = this.mode === 'farm' && room?.num === this.policy?.assignedRoom;
    return (onOwnGround && this.trainingStyleFor() === 'unarmed') ? 'unarmed' : 'normal';
  }

  /**
   * An improvement landed. Under `alternate_on_improve` this is the only place the style
   * flips — the server has just reset the swing counter for us, so the next block starts
   * on the other proficiency at no cost. Returns the style now in force, for telemetry.
   *
   * Deliberately a no-op under every other style: `alternate` owns its own schedule and
   * `normal`/`short_sword`/`unarmed` do not switch at all.
   */
  onTrainingImprovement(facts = null) {
    if ((this.policy.trainingStyle ?? 'normal') !== 'alternate_on_improve') return null;
    const was = this._trainingNextStyle ?? 'short_sword';
    // Only a stroke or a proficiency resets the counter server-side, so only those are a
    // free switch. An improvement in dodge or a spell leaves the block running and must
    // not move us off the weapon that is part-way through it.
    const skill = String(facts?.skill ?? facts?.name ?? '').toLowerCase();
    if (skill && !/sword|mace|hammer|axe|scimitar|brawl|punch|slash|thrust|pierce|bow|archery/.test(skill))
      return was;
    this._trainingNextStyle = was === 'short_sword' ? 'unarmed' : 'short_sword';
    this._trainingBout = null;
    return this._trainingNextStyle;
  }

  isTrainingPrey(name) {
    const want = this.policy.hunt;
    return !!want && this.huntMatch(want)(String(name || ''));
  }

  finishTrainingBout(targetId) {
    if (targetId == null || this._trainingBout?.target_id === targetId)
      this._trainingBout = null;
  }

  async unuseTrainingWeapon() {
    const s = this.s, c = s.client;
    let using = skills.equippedNow(c);
    if (!using) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory', 'equipment'], timeoutMs: 3000 }).catch(() => {});
      using = skills.equippedNow(c);
    }
    if (!using) return { ready: false, why: 'the server use list is not known' };
    const weaponish = (o) => skills.weaponScore(c.rsc?.get?.(o.nameRsc) || o.name || '') > 0;
    let held = (c.inventory || []).find(o => using.has(o.id) && weaponish(o));
    // THE ID JOIN CAN FAIL WHILE THE HAND IS STILL FULL, AND THAT USED TO BE SILENT.
    //
    // `using` is the server's use list and carries ids and little else; `c.inventory` is a
    // different list with its own ids. They are joined here on the id, which is the one
    // thing this repository has written down as untrustworthy -- renumbered on every save,
    // recycled within hours. When the join misses, this returned `{ready: true, already:
    // true}`, which reads as "the hand was already empty" and is indistinguishable from
    // success. `passArm` notes only on `ready && removed` and complains only on `!ready`,
    // so `ready && !removed` wrote NOTHING ANYWHERE.
    //
    // Measured on prod 2026-09-19: Floyd, `trainingStyle: unarmed`, mode farm, room 27,
    // assignedRoom 27 -- every gate true -- holding a short sword, with the decision ring
    // not advancing at all. No disarm, no complaint, and brawling cannot advance because a
    // swing with a weapon zeroes piWeaponSwings against the proficiency being trained
    // (player.kod:4753-4757).
    //
    // So: fall back to the NAME, which is what the server's own equipment list speaks, and
    // if the hand is provably full and nothing matched, say so as a REFUSAL rather than as
    // an empty hand. A caller that is told "already bare" stops asking; one that is told it
    // failed asks again and complains where somebody can read it.
    if (!held) {
      // `||` AND NOT `??` ON BOTH SIDES. `rsc.get` answers '' for a name it cannot resolve,
      // and '' is neither null nor undefined, so `??` keeps the empty string and the
      // fallback never reaches `o.name`. That is the same shape as the bug being fixed:
      // two readers of one object disagreeing about which field carries the name.
      const worn = new Set((c.equipment?.()?.equipped ?? [])
        .map(o => String(o.name || c.rsc?.get?.(o.nameRsc) || '').toLowerCase())
        .filter(Boolean));
      if (worn.size)
        held = (c.inventory || []).find(o =>
          worn.has(String(c.rsc?.get?.(o.nameRsc) || o.name || '').toLowerCase()) && weaponish(o));
    }
    if (!held) {
      if (skills.isArmed(c))
        return { ready: false, why: 'the server says this character is armed and nothing in ' +
                 'the pack matched the use list, by id or by name — the weapon cannot be ' +
                 'identified to take it off' };
      return { ready: true, already: true };
    }
    const name = c.rsc.get(held.nameRsc) || 'weapon';
    const before = c.evSeq;
    await s.pacer.submit('use', () => c.unuse(held.id)).catch(() => {});
    const ev = await c.waitFor({ since: before, kinds: ['equipment', 'message'], timeoutMs: 3000 })
      .catch(() => ({ events: [] }));
    // READ THE REFUSAL, DO NOT JUST OBSERVE THAT NOTHING HAPPENED.
    //
    // A cursed weapon answers "<Item> seems to cling to your hand!" and stays on
    // (wacursed.kod:35, ItemReqUnuse returns FALSE unconditionally). Without this the
    // caller sees only `ready:false`, treats it as a transient server hiccup, and asks
    // again on every pass for the rest of the session -- while the real news, that this
    // weapon can never come off and the character needs a remove curse potion, is sitting
    // in the message we threw away.
    const said = (ev?.events || []).filter(e => e.text).map(e => e.text);
    const cursed = said.some(t => skills.noteCursedFromMessage(c, t, held.id));
    if (cursed) this.noteCurseSuspect({ items: [{ id: held.id, name }], certain: true,
      said: said.find(t => skills.CURSE_SAID.test(t)) ?? null });
    const ready = !skills.isArmed(c);
    return { ready, removed: name, ...(cursed ? { cursed: true, said } : {}),
             ...(ready ? {} : { why: cursed
               ? `${name} is cursed and cannot be removed -- a remove curse potion (Marion healer) `
                 + 'unuses it, or it comes off when the weapon breaks'
               : `the server did not take off ${name}` }) };
  }

  // Prepare one exact, observable combat style. `equip:false` is passed to fight()
  // after this succeeds so its ordinary best-weapon convenience cannot silently undo
  // an unarmed bout or replace a missing short sword with a different weapon.
  // THE TRAINED WEAPON IS A POLICY, NOT A CONSTANT.
  //
  // This branch was hardcoded to /short\s?sword/i and refused every other style with
  // "unknown training style". That was right while short sword was the only proficiency
  // anyone was training, and wrong the moment a character outgrew it: an armed proficiency
  // stops improving once its ability reaches the TARGET's level (stroke.kod:115), so on a
  // level-50 fungus beast a short sword at 50 trains nothing at all. Measured on prod
  // 2026-09-08 — Camilla sat at exactly 50 with hammer at 7 and axe at 3, alternating a
  // capped skill against her fists and gaining nothing on the armed half.
  //
  // `policy.trainingWeapon` names what to hold instead. It defaults to short sword, so
  // every doctrine written before this behaves exactly as it did.
  trainingWeaponNow() {
    const w = String(this.policy?.trainingWeapon ?? '').trim();
    return w || 'short sword';
  }

  async prepareTrainingStyle(style, targetId) {
    if (style === 'normal') return { ready: true, equip: true };
    const s = this.s, c = s.client;
    if (style === 'unarmed') {
      const bare = await this.unuseTrainingWeapon();
      if (bare.ready && bare.removed)
        this.note('training bout: fighting unarmed', { target_id: targetId, removed: bare.removed });
      return { ...bare, equip: false, style, rounds: 1 };
    }
    // `short_sword` is kept as the style NAME for compatibility — every caller and every
    // stored policy already says it, and renaming it would be a migration for no gain.
    // What it means now is "the armed half", and the weapon comes from policy.
    if (style !== 'short_sword')
      return { ready: false, equip: false, style, why: `unknown training style ${style}` };

    const want = this.trainingWeaponNow();
    // WHOLE WORDS, ESCAPED. "sword" must not match "short sword": a character told to
    // train swordsmanship and handed a short sword would train the wrong proficiency and
    // report success, which is the silent-wrong-answer shape this file keeps recording.
    // Spaces are flexible because the server writes "short sword" and some resources
    // write "shortsword".
    const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s?');
    const rx = new RegExp(`\\b${escaped}\\b`, 'i');
    const equippedWanted = () => {
      const using = skills.equippedNow(c);
      if (!using) return null;
      return (c.inventory || []).find(o => using.has(o.id) &&
        !skills.brokenSet(c).has(o.id) &&
        rx.test(c.rsc.get(o.nameRsc) || '')) || null;
    };
    let held = equippedWanted();
    if (held)
      return { ready: true, equip: false, style, already: true, weapon_id: held.id,
               weapon: want, rounds: 1 };

    const off = await this.unuseTrainingWeapon();
    if (!off.ready) return { ...off, equip: false, style };
    const carries = () => (c.inventory || []).some(o =>
      !skills.brokenSet(c).has(o.id) && rx.test(c.rsc.get(o.nameRsc) || ''));
    if (!carries()) {
      // Create Weapon ROLLS a ladder rather than granting a choice (creaweap.kod:66-107),
      // so this may well produce something else. It is still worth one attempt — it is free
      // and it sometimes lands — but it is not a supply plan, which is what
      // fleetscripts/fish-for-weapon.mjs is for.
      await this.makeWeapon(`this training bout requires a ${want}`).catch(() => false);
    }
    if (carries() && !equippedWanted())
      await skills.equipBest(s, { priority: [want], banned: this.bannedWeaponsNow() }).catch(() => null);
    held = equippedWanted();
    if (held) {
      this.note(`training bout: fighting with a ${want}`, { target_id: targetId, weapon: want });
      return { ready: true, equip: false, style, weapon_id: held.id, weapon: want, rounds: 1 };
    }

    // Do not leave a failed experiment empty-handed. Re-arm normally for survival,
    // but refuse this bout: fighting with a fallback weapon would corrupt the split.
    await skills.equipBest(s, { priority: this.weaponPriorityNow(), banned: this.bannedWeaponsNow() }).catch(() => null);
    return { ready: false, equip: false, style, weapon: want,
             why: `no usable ${want} could be made or equipped` };
  }
  // @end 1
}
