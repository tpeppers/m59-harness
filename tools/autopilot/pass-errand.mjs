// THE ERRAND PASS, RESTED HOLDS, AND RESUMING A SUSPENDED JOURNEY.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 6 methods: passErrand, restVigorCeiling, releaseRestedHold, resumeDeclined,
//   resumeSuspendedJourney, cancelJourney
import { poisonedNow } from '../m59-poison.mjs';
import { traceDecision } from '../m59-keeper-trace.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { keeperOrigin, moveOrigin } from '../m59-move-origin.mjs';
import { opensFightFromWall } from '../m59-policydiff.mjs';
import * as skills from '../m59-skills.mjs';
import { scriptedDeviationResumeCandidate, scriptedTrafficResumeReady } from '../m59-traffic-resume.mjs';
import { CONTINUE, HANDLED, ORDINARY_VIGOR_FLOOR, REST_VIGOR_CAP, RESUME_FLAT_SAMPLES, STRATEGIES, TRAVEL_VIGOR_FLOOR, vigorPct } from '../m59-autopilot.mjs';

export class PassErrandPart {
  // @part 1

  async passErrand(ctx) {
    // THE CHALICE HOLDER AND ALTERNATE serve before anything else directional — a
    // traveller is standing at the station waiting on them.
    if (await this.chaliceDuty().catch(e => { this.note('chalice duty failed', { why: e.message }); return false; }))
      return HANDLED;
    // WAND DUTY, right after it: the bank serves a farmer standing at the gate, a farmer short of
    // wands steps over to it. Both hand the pass straight back when there is nothing to do.
    if (await this.wandDutyStep().catch(e => { this.note('wand duty failed', { why: e.message }); return false; }))
      return HANDLED;
    if (this._holderCargo && await this.chaliceDeliverCargo().catch(e => { this.note('restock delivery failed', { why: e.message }); return false; }))
      return HANDLED;
    // NOTHING AT THE DESK NEEDS US: PRACTISE, above the reserve the desk is owed. After the duty
    // on purpose — a ticket always outranks a drill — and it hands the pass back whenever it did
    // not cast, so a character with nothing to practise behaves exactly as it did before.
    if (this.policy.practiceSpells && await this.practiceAtDesk().catch(e => {
      this.note('desk practice failed', { why: e.message }); return false; }))
      return HANDLED;
    // Acquire shelter even at full health; a stationary caster must not wait for
    // the first hit before finding its post. Survival has already had its turn.
    if (this.isRoomEnchantPost()) {
      await this.maintainRoomEnchantPost({ acquire: true });
      return HANDLED;
    }
    // ROOM 2600 ON THE WAY TO 2601 IS WORKED, NOT WALKED. Above the errands and the journey
    // stand-down below, because a character bound through it IS on a road, and the puzzle is the
    // road. Below everything protected: survival, fight-back and fleeing have had their turns.
    {
      const lever = await this.passLeverPuzzle(ctx).catch(e => {
        this.note('lever puzzle step failed', { why: e.message });
        return CONTINUE;
      });
      if (lever !== CONTINUE) return lever;
    }
    // A JOURNEY IS ALREADY A DIRECTIONAL DECISION. THE ERRANDS STAND DOWN UNDER ONE.
    //
    // Every branch in this stage WALKS THE CHARACTER SOMEWHERE — the bank, the vault, a
    // delivery — and not one of them asked whether it was already going somewhere. So a
    // character with a live objective would set off for the bank instead, and from outside
    // that is indistinguishable from travel not working.
    //
    // Measured 2026-08-23, shadow02, holding `{to: 38}` for the whole of a ten-minute leg:
    //
    //     mode idle | passes 2 | running_for_seconds 592
    //     recent: First Royal Bank of Tos ... banking ... buying food ... resting
    //
    // TWO ladder passes in 592 seconds. It was not stuck and it was not lost — it was in
    // town, doing exactly what its policy tells it to do, while a journey waited. And
    // because `bankRun` is a long await, the ladder barely ran at all, so nothing further
    // down could get a turn either.
    //
    // This is the same rule the boundary in CLAUDE.md already states — work, movement and
    // economy decide on a clock of MINUTES and there is one of them per body. A journey is
    // one. Shopping mid-journey is two directional decisions on one character, which is the
    // configuration this whole carve-out exists to prevent.
    //
    // A SUSPENDED OBJECTIVE COUNTS. Standing down only while `travelling` would hand the
    // errands every tick of a paused journey — which is precisely when the resume is trying
    // to get the body back on the road — and the resume lives one rung BELOW this one.
    //
    // Nothing is lost by waiting: an errand is an END STATE, not a schedule. The bank is
    // still there on arrival, and `passFleeAndRest` above still eats, rests and shelters,
    // because those are survival and decide on a clock of one second.
    if (this.inert?.travelling || this.suspendedJourney) {
      if (!this.errandsStoodDown) {
        this.errandsStoodDown = true;
        this.note('errands stand down while there is a road to walk', {
          to: this.suspendedJourney?.to ?? this.inert?.to ?? null,
          state: this.inert?.travelling ? 'travelling' : 'journey suspended, waiting to resume',
          why: 'every branch of this stage walks the character somewhere, and it is already ' +
               'going somewhere. An errand is an end state rather than a schedule, so it ' +
               'keeps until the road is finished',
        });
      }
      return CONTINUE;
    }
    this.errandsStoodDown = false;
    // A TRIP ALREADY UNDER WAY IS STILL AN ECONOMIC DECISION. Claiming economy and movement
    // cancelled the JOURNEY in flight, not the trip that issued it, and the trip's next leg went
    // out as soon as the holder's own walk had arrived: on the 2026-09-25 rehearsal two raiders,
    // held by the raid in the stage room, walked to Barloque, sold their gems, bought herbs and
    // took a room at the inn while the raid handed them reagents they were not there to take.
    // So a held trip is set aside — deferred, not dropped — and resumes when the lease ends.
    if (this.townTrip && (this.facultyHeld('economy') || this.facultyHeld('movement'))) {
      this.deferredShoppingTrip = this.townTrip;
      this.townTrip = null;
      this.note('town trip set aside — economy or movement is leased', {
        economy: this.facultyOwner('economy'), movement: this.facultyOwner('movement'),
        why: 'the holder decides where this body goes and what its purse does' });
    }
    if (this.townTrip) { await this.continueTownTrip(); return HANDLED; }

    // An errand outranks farming and is outranked by everything above it: we are past
    // the death, danger and rest branches, so a runner in trouble has already dealt
    // with the trouble.
    if (this.errand && await this.runErrand().catch(e => {
      this.note('loot run failed', { why: e.message }); this.errand = null; return false;
    })) return HANDLED;

    // A LEASED PURSE IS SOMEBODY ELSE'S TO SPEND. Restored after the 2026-09-04 merge
    // dropped it: the keeper's economy stayed live through a supply errand and banked a
    // courier's purse down to walking_money the moment it stood beside a teller, which is
    // why the errand's own withdrawal arithmetic kept coming out wrong.
    //
    // Narrow, like the other: this withholds VOLUNTARY banking and the vault detour, both
    // of which are multi-minute economic decisions with no single right answer. It takes
    // nothing from the ladder. A leased character that dies still drops what it carries,
    // exactly as before — the lease is not a safe, and nothing here pretends otherwise.
    if (this.facultyHeld('economy')) {
      const owner = this.facultyOwner('economy');
      if (this.notedEconomyOwner !== owner) {
        this.notedEconomyOwner = owner;
        this.note('economy is leased — not banking or vaulting', {
          owner, why: 'the holder is spending this purse; banking it mid-errand is how a ' +
                      'courier arrives at a counter unable to pay' });
      }
    } else {
      this.notedEconomyOwner = null;
      // Standing in a bank? Put the takings away before anything can take them.
      await this.bankSurplus().catch(() => {});
      // Carrying enough that it is worth WALKING to one? Go. See bankRun().
      if (await this.vaultRunIfPassing().catch(() => false)) return HANDLED;
      if (await this.bankRun().catch(() => false)) return HANDLED;
    }
    // The ordinary farming relocation has brought a town runner back to its original
    // room. Complete the shared cargo hand-off before it eats, fights, or wanders.
    if (await this.deliverFarmSupplies().catch(error => {
      this.coordination.delivery.failed++;
      this.note('farm delivery failed', { why: error.message });
      return false;
    })) return HANDLED;
    // And any "while you're in town" favors this trip carried home (m59-town-favors.mjs).
    if (await this.deliverTownFavors().catch(error => {
      this.note('town favor delivery failed', { why: error.message });
      return false;
    })) return HANDLED;

    await this.healObservedFleetmate().catch(e=>this.note('observed ally heal failed',{why:e.message}));

    // Someone else is standing here and we can mend them: do that first. It costs a
    // second and it is the only action available that helps another character.
    if ((STRATEGIES[this.policy.strategy] || {}).medic) await this.medic().catch(() => {});

    // And buff them, for the same reason: it helps the ally and it is the only way the
    // spell improves. Gated on `policy.buffAllies` rather than on a strategy, so a doctrine
    // can post ONE character as the group's caster without moving it onto a strategy that
    // changes everything else about how it fights.
    // TAKE THE PAYMENT BEFORE DOING THE WORK, and before anything else in this pass: an
    // open trade window blocks the donor from doing anything else, and it costs one reply.
    if (this.policy.acceptDonations) await this.acceptDonations().catch(error =>
      this.note('donation pass failed', { why: error.message }));

    if (this.policy.buffAllies) await this.buffAllies().catch(error =>
      this.note('buff pass failed', { why: error.message }));

    // AND KEEP THE ROOM ENCHANTMENT UP. Separate from buffAllies on purpose: that one casts
    // AT a person and returns early when the room is empty, this one casts at the ROOM and
    // must keep going when it empties, because the enchantment is what the farmers walk back
    // INTO. Same gating style — a policy key rather than a strategy, so one character can be
    // posted as the room's caster without changing anything else about how it behaves.
    if (this.policy.roomEnchant) await this.roomEnchant().catch(error =>
      this.note('room enchantment pass failed', { why: error.message }));

    // HIBERNATING IS NOT DOING NOTHING. A keeper with no job still has a bar to fill,
    // and vigor is what a character walks out of an inn with — it sets the health
    // regeneration rate and it is what swinging spends. Standing about at 30 of 200
    // because nobody gave us a task is throwing away the one thing idle time is for.
    if (this.mode === 'idle') {
      // A SUSPENDED JOURNEY IS A JOB, AND "no job to do" WAS ASSERTED WITHOUT LOOKING.
      //
      // This branch claims the tick for ANY idle character, and `passFarm` — which is where
      // `resumeSuspendedJourney` lives — is the very next rung. A journey that ends short
      // sets the character idle, so from the instant an objective was suspended it could
      // never be picked back up: the rung that would have done it never ran again.
      //
      // That is the whole of a failure this session spent a day inside. Three separate
      // fixes went into the resume's own gates — the health floor, the vigor cap, the trend
      // test — and every one of them was inside a stage that was not being reached. The
      // measured shape, on the ladder tracer's first run:
      //
      //   ran: passUnderworld -> passArm -> passPlaybook -> passFleeAndRest
      //        -> passFollow -> passOutside -> passErrand          [28 passes, 33s, room 596]
      //
      // Seven rungs, and the eighth never got a turn.
      //
      // ASKED HERE RATHER THAN BY REORDERING THE LADDER. The resume belongs in `passFarm`:
      // it is a directional decision, and the ladder's order is load-bearing and asserted by
      // `m59-passorder-test.mjs`. What was wrong is not where the resume lives, it is that
      // an idle catch-all declared there was nothing to do without asking. So it asks, and
      // the answer is the same object either way — a resume that fires returns HANDLED here,
      // and one that declines falls through to the hibernate below, which is exactly what a
      // character that is still mending should be doing anyway.
      if (this.suspendedJourney
          && await this.resumeSuspendedJourney(ctx).catch(() => CONTINUE) === HANDLED)
        return HANDLED;
      // AN IDLE CHARACTER STILL READS ITS WEAPONS. The sweep used to live only inside
      // passFarm's farm block, and this branch returns before passFarm — so the Ukgoth troll
      // crew, which DUM stages IDLE at room 2 to be dedicated, never read a single weapon:
      // every one stayed `unknown`, the dedication rule found no mundane spare to enchant, and
      // an enchanted weapon handed back would never have been swapped in either. Measured on
      // prod 2026-09-26: twelve staged, every weapon `unknown`, zero dedications. The sweep is
      // rate-limited (60 s, two looks, paced) and does not move the character.
      this.sweepWeaponMagic().catch(() => {});
      // OUT OF THE PASSAGE BEFORE ANYTHING THAT SITS STILL. See makeWay.
      if (await this.makeWay().catch(() => false)) return HANDLED;
      if (await this.eatToFloor(ctx) === 'ate') return HANDLED;
      if (await this.hibernate('idle: no job to do').catch(() => false)) return HANDLED;
      return HANDLED;
    }
    return CONTINUE;
  }

  // ── passFarm: extracted from pass() ────────────────────────────────
  // FINISH WHAT YOU WERE DOING, ONCE YOU ARE WELL ENOUGH TO.
  //
  // The counterpart to the suspend in `passTravelling.takeBack`. A journey interrupted by
  // the survival ladder is not abandoned any more: the objective is kept, and picked up
  // again from here — which is the LAST stage, so by construction nothing more urgent
  // wanted this tick. That ordering is the whole gate and it is free: while the character
  // is in the Underworld, unarmed, fleeing or resting, an earlier stage returns HANDLED and
  // this is never reached. It runs on the first tick where the character is simply fine.
  //
  // FIVE REFUSALS, each of which is a way this could become the failure it is fixing:
  //
  //   died since      resuming the road that killed you is the Cccc post-mortem with extra
  //                   steps. Compared against the death count AT SUSPENSION rather than
  //                   trusting that dying would have cleared the note.
  //   too many tries  a corridor that keeps taking the character back will keep taking it
  //                   back. Two resumes, then the objective is dropped and said so.
  //   stale           an objective older than the window is somebody's earlier plan. A bot
  //                   or an operator has had time to want something else by now.
  //   too hurt        `travel_start_health` is the same floor a fresh journey honours. A
  //                   resume that sets out at 40% is a take-back waiting to happen.
  //   switched off    `resume_travel: false`, per character, live, like every other
  //                   faculty on this boundary.
  //
  // It returns CONTINUE on every refusal, so refusing to resume never costs the tick — the
  // character farms, which is what it would have done before any of this existed.
  // A REST STOP ENDS WHEN THERE IS NOTHING LEFT TO GAIN BY STANDING THERE.
  //
  // `leaveHold` only ever REFUSES a departure, and only while hurt. Nothing ever asked a
  // healed character to go — so a traveller that reached a proven wall, healed to full, and
  // topped its vigor out simply stayed. Measured: a character at 54 of 54 health and 80 of
  // 200 vigor, which the server itself reports as `rested: true`, still reading "holding a
  // proven safe spot" with `hold_resume_above` of 0.9 long since satisfied. Sixteen of
  // eighteen legs across the Twisted Wood ended in a timeout rather than a death, and this
  // is why: they were not stuck, they were parked.
  //
  // FULL IS FULL, AND VIGOR'S FULL IS 80 OF 200. Resting stops awarding vigor at the resting
  // cap and everything above it has to be EATEN, so waiting for more is waiting for the
  // timeout. Both ceilings met means the wall has given all it has.
  //
  // Forced, because the ordinary refusal is about being hurt and this character is not.
  /**
   * THE MOST VIGOR RESTING CAN ACTUALLY GIVE THIS CHARACTER, as a fraction of the bar.
   *
   * `REST_VIGOR_CAP` is 0.4 — 80 of 200 — and the game stops AWARDING rest vigor there, so a
   * test of `vig < REST_VIGOR_CAP` can be met exactly and never cleared. That was survivable
   * until something lowered the ceiling below it.
   *
   * A worn `ring of lethargy` does exactly that: `lethring.kod` calls
   * `SetVigorRestThreshold(current - piVigorRestThresholdChange)` with a change of 20 and a
   * floor of 10, so the wearer rests to 60 of 200 and not one point further. Against a bar of
   * 80 that is a wait with no end, and the wait happens against a wall — measured on prod
   * 2026-09-19, four characters at FULL HEALTH held a safe spot for nineteen minutes with
   * zero kills, waiting for vigor the curse had already forbidden them.
   *
   * So the bar is what THIS character can reach rather than what an uncursed one could. The
   * note it gates still reads "all the vigor resting can give", which is now true.
   */
  restVigorCeiling() {
    const worn = this.s?.client?.equipment?.()?.equipped ?? [];
    const rings = worn.filter(o =>
      /ring of lethargy/i.test(String(o?.name ?? this.s?.client?.rsc?.get?.(o?.nameRsc) ?? '')))
      .length;
    if (!rings) return REST_VIGOR_CAP;
    // 20 of 200 per ring, floored at 10 of 200 — the kod's own numbers, not a guess.
    // IN POINTS, THEN DIVIDED ONCE. Subtracting fractions gets this wrong in the only case
    // that matters: `0.4 - 0.1` is 0.30000000000000004, and a wearer sitting at exactly 60
    // vigor reads 0.3, which is LESS — so the bar would still be unclearable and the fix
    // would look right while changing nothing. `vigorPct` divides by the same 200, so
    // computing the ceiling the same way makes the two comparable exactly.
    const cap = Math.round(REST_VIGOR_CAP * skills.VIGOR_MAX);   // 80 of 200
    return Math.max(10, cap - rings * 20) / skills.VIGOR_MAX;
  }

  async releaseRestedHold() {
    // Full health does not finish a stationary room-enchantment assignment.
    if (this.isRoomEnchantPost()) return false;
    if (!this.hold) return false;
    const v = this.s.client?.vitals?.();
    const hp = v?.health?.max ? v.health.value / v.health.max : null;
    const vig = vigorPct(v);
    // ON A JOURNEY IT IS FULL HEALTH, NOT NINE-TENTHS OF IT.
    //
    // The note below has always said "full health" and the number has always been 0.9, and
    // for a farming character that is right: the last tenth is the slowest to come back, the
    // room it is standing in is the room it works in, and there is nothing on the other side
    // of leaving.
    //
    // A traveller is the opposite case. What it is about to do is walk into the NEXT room,
    // which is the whole reason it stopped, and the last tenth is exactly the margin that
    // decides whether it arrives. Measured, Bbbb, this afternoon:
    //
    //     + 94s  room 597  holding a proven safe spot
    //     +112s  room 597  idle                          18s of holding, 15r of rest
    //     +125s  room 597  inert — travelling to 38 (resumed)
    //     +154s  room 598  idle
    //           dead at 166s in the Cragged Mountains
    //
    // It gave up a proven wall at nine-tenths and was dead forty seconds later, one room on.
    // The operator's rule for this was set before any of it: rest to FULL when healing at a
    // safe spot while travelling.
    const onARoad = !!(this.inert?.travelling || this.suspendedJourney);
    // A farming wall is still doing its job while a quarry is being pulled or
    // monsters are in contact. Full health does not finish that fight. Releasing
    // here preempts passFarm's contact-clear hysteresis and reconnects every lap.
    // A BUDDY-SYSTEM TAGGER'S CORNER IS ITS JOB, NOT A REST STOP (live, 2026-10-09: every tagger took its
    // corner, and the next pass released it here as "rested to the ceiling" at full health -- a corner
    // taken and given up every second, and not one tag in four minutes).
    if (!onARoad && (this.pendingPull || this.inReachOfUs()?.length
        || (this.mode === 'farm' && opensFightFromWall(this.policy))
        || (this.mode === 'farm' && this.buddyRole?.()?.role === 'tag'))) return false;
    // POISONED: THE WALL IS KEPT UNTIL THE POISON ENDS. Operator, 2026-10-27: "lock down in the nearest safe spot until the
    // poison ends and healing occurs afterwards, not to flee through it and risk low-health travel. Shelter in place."
    // Health climbs between poison ticks and would release the hold at full; it is not released until the poison is gone,
    // and then the ordinary floor below makes it heal before it leaves.
    if (poisonedNow(this.s?.client)) {
      if (!this._poisonHoldSaid) { this._poisonHoldSaid = true;
        this.note('keeping the wall while poisoned', { why: 'shelter in place until the poison ends, then heal, then go on' }); }
      return false;
    }
    this._poisonHoldSaid = false;
    const floor = onARoad
      ? (this.policy.travelHoldResumeAbove ?? 1)
      : (this.policy.holdResumeAbove ?? 0.9);
    if (hp === null || hp < floor) return false;
    if (vig !== null && vig < this.restVigorCeiling()) return false;
    this.note('leaving the wall — full health and all the vigor resting can give', {
      health: `${v?.health?.value}/${v?.health?.max}`,
      vigor: `${v?.vigor?.value}/${v?.vigor?.scale_max ?? 200}`,
      needed: Math.round(floor * 100) + '%', on_a_road: onARoad,
      why: 'a rest stop is for getting well, and this character is as well as sitting down ' +
           'can make it. Staying is how a journey times out without ever being in danger.',
    });
    try {
      const left = await this.leaveHold('rested to the ceiling — back on the road', { force: true });
      return left.left === true;
    } catch (e) {
      this.note('could not leave the rested hold', { why: e.message });
      return false;
    }
  }

  // WHY THE RESUME SAID NO, ONCE PER REASON. A refusal that returns CONTINUE and writes
  // nothing is how this stayed unexplained through three fixes: the journey was kept, the
  // wall was released, the character stood there anyway, and every instrument said "idle".
  // Once per reason rather than once per pass, because this runs about once a second.
  resumeDeclined(why, detail = {}) {
    // Keyed on the reason AND the numbers, so a gate that is stuck at one reading says so
    // once and a gate that is genuinely working prints its progress. Keyed on the reason
    // alone, the note scrolled out of `recent` long before anybody looked and the refusal
    // was invisible again — which is the whole failure this was added to end.
    const key = why + '|' + JSON.stringify(detail);
    traceDecision(this.who?.() ?? '?', 'resume declined', { why, ...detail });
    if (this.resumeSaid === key) return CONTINUE;
    this.resumeSaid = key;
    this.note('not resuming the journey yet', { why, ...detail });
    return CONTINUE;
  }

  async resumeSuspendedJourney(ctx) {
    // Asked FIRST, and unconditionally: a held character that is whole should be moving
    // whether or not it has an objective to resume. Releasing costs nothing when there is
    // no hold, and the stage below decides where to go.
    await this.releaseRestedHold();
    const j = this.suspendedJourney;
    if (!j) { this.resumeBest = null; this.resumeFlat = 0; this.resumeSaid = null; return CONTINUE; }
    if (Date.now() < (j.next_try_at ?? 0)) return CONTINUE;
    if (this.policy.resumeTravel === false)
      return this.resumeDeclined('resume_travel is switched off for this character');

    // THE WALL COMES FIRST, AND THE ROAD WAITS FOR IT.
    //
    // `releaseRestedHold()` above is the thing that decides whether a rest is FINISHED — it
    // refuses below full health and the resting vigor cap. If it refused, the hold is still
    // there, the character is still mending, and taking the body off the wall now is the
    // race that produced two deaths this afternoon: paused for a wall at 85%, resumed
    // thirty-two seconds later having rested for none of it, dead two rooms on.
    //
    // Asked here rather than in the health gates below because it is a different question.
    // Those ask "is this character well enough to travel"; this asks "is something already
    // in the middle of making it well". A rest interrupted at the halfway mark is worse
    // than either answer.
    if (this.hold)
      return this.resumeDeclined('still mending at a wall — the rest is not finished',
                                 { room: this.hold?.room ?? null });
    // And if a wall has been ASKED FOR but not yet taken, the same applies: the shelter rung
    // is one pass away and resuming now would cancel the request before it was acted on.
    // BOUNDED, because nothing here can guarantee the shelter rung ever runs. During travel
    // the ordinary ladder does not run at all, so a request set and never acted on would
    // block the road for ever — the first draft of this did exactly that and a fixture
    // caught it declining forty passes in a row with the ask counter stuck at one.
    this.resumeShelterWaits = (this.resumeShelterWaits ?? 0) + 1;
    if (this.wantsForwardShelter && this.resumeShelterWaits <= (this.policy.resumeShelterWaits ?? 20))
      // NOT `why`. `resumeDeclined` spreads the detail over `{ why, ...detail }`, so a
      // detail field called `why` overwrites the reason it was meant to explain — the
      // `emit(kind, data)` trap this repository documents, arriving in a note two lines
      // after being written. The refusal read "the journey paused for a wall", which is
      // what was ASKED FOR rather than what is being waited on.
      return this.resumeDeclined('a wall has been asked for and not taken yet',
                                 { asked_for: this.wantsForwardShelter });

    const drop = (why, detail = {}) => {
      this.suspendedJourney = null;
      this.note('gave up on a suspended journey', { to: j.to, why, ...detail, attempts: j.attempts });
      recordEvent(this.who(), 'travel_resume_dropped', { to: j.to, why, attempts: j.attempts });
      return CONTINUE;
    };

    if ((this.tally?.deaths ?? 0) !== j.deaths_at)
      return drop('died since it was suspended — the road is not worth a second body');
    // THESE TWO ARE RUNAWAY BACKSTOPS, NOT THE ABANDON POLICY. The rule is that a journey
    // is only given up when a PLAYER is on us; everything else pauses at a wall and carries
    // on. A tight cap here would quietly become a second abandon rule and undo that — so it
    // is set where a genuinely stuck loop trips it and an ordinary corridor crossing with
    // several wall-rests in it does not. A road with eight walls on it is a road, not a bug.
    const maxAttempts = this.policy.resumeTravelAttempts ?? 12;
    if (j.attempts > maxAttempts)
      return drop(`paused ${j.attempts} time(s) for the same destination — that is a loop, ` +
                  `not a road. Dropped as a runaway guard rather than as a decision about the trip`);
    // Long enough to rest to FULL at a wall and still be resumed. The old five minutes was
    // shorter than a bad rest, so an objective could expire while the character was doing
    // exactly what it had been taken off the road to do.
    const within = this.policy.resumeTravelWithinMs ?? 1_800_000;
    if (Date.now() - j.at > within)
      return drop('stale — somebody else has had time to want something different');

    // NOT A DROP: WAIT UNTIL THE CHARACTER IS ACTUALLY FIT TO GO BACK OUT.
    //
    // Full health AND at least the vigor a rest can reach. Both, because the road is what
    // hurt it and setting out again half-mended is how the same take-back happens twice —
    // and `attempts` only allows that twice before the objective is dropped, so a resume
    // that leaves early spends the budget for nothing.
    //
    // Vigor is not a nicety here. It is what sets how fast health comes back between
    // fights and what pays for RUNNING, which is the one thing that works in the open.
    // REST_VIGOR_CAP is 80 of 200 — the ceiling of what sitting down can ever buy, since
    // everything above it has to be eaten — so this asks for what resting can actually
    // deliver rather than a number that would sit for ever waiting on food.
    // ...AND "FIT" MEANS THE WALL HAS STOPPED PAYING, NOT AN ABSOLUTE NUMBER.
    //
    // Full health is the right bar for a character resting somewhere safe. It is the wrong
    // bar for one stalled mid-journey, because a stalled character is usually stalled
    // SOMEWHERE IT CANNOT HEAL — and then the gate can never open and the journey never
    // resumes. Measured, both characters, the same shape:
    //
    //     +237s  room 597  idle
    //     +258s  room 597  holding a proven safe spot
    //
    // Aaaa rested out its whole clock at 21 of 33; Bbbb wandered back to the Western border
    // and spent three hundred and sixty seconds there at 9 of 20. Neither ever set off again,
    // because neither ever reached full.
    //
    // This is the same argument `releaseRestedHold` already makes about a rest stop: standing
    // there is worth it while it is buying something, and the moment it stops buying, staying
    // is just a slower way to run out of clock. So the gate is the TREND rather than the
    // level. Health still climbing behind a wall — wait, that is what the wall is for. Health
    // level for a few samples — go, at whatever it is, because waiting will not raise it.
    //
    // `travel_start_health` still sets an absolute floor for anyone who wants one; it is
    // simply no longer the only way through.
    const floor = this.policy.travelStartHealth ?? 1;
    const { hp, v } = ctx;
    // AGAINST THE BEST SEEN, NOT AGAINST THE LAST SAMPLE. This compared each reading to the
    // previous one, so ANY upward tick counted as still climbing and reset the counter. A
    // character at 19 of 20 regenerates to 20, gets scratched back to 19, regenerates again
    // — and every one of those ticks reset it, so `resumeFlat` never reached
    // RESUME_FLAT_SAMPLES and the journey never resumed. Measured on shadow02: whole,
    // unhurt, out of recovery, `mode idle` for six minutes holding a live objective, with
    // the trend gate refusing on the grounds that it was still getting better.
    //
    // The wall has stopped paying when health stops reaching a NEW high. An oscillation
    // between the same two points is not progress, and the default floor here is FULL
    // health, so without this the gate can only open on a character that hits its maximum
    // exactly and holds it.
    // FLAT ONLY MEANS "AS WELL AS I WILL GET" IF SOMETHING IS TRYING TO HEAL ME.
    //
    // The gate is "go on when the wall has stopped paying", and it counts samples where
    // health did not reach a new high. That is right for a character sitting behind a wall.
    // For one standing in the open it is exactly backwards: nothing is healing it, so health
    // is flat, so the counter fills in eight seconds and the gate opens on a hurt character.
    //
    // Measured, Aaaa, this evening — the whole failure in three lines of its own record:
    //
    //     +40s  room 587  idle                                  journey suspended
    //     +46s  room 587  inert — travelling to 38 (resumed)    SIX SECONDS later
    //     +194s room 598  idle          ... dead at 257s, 0r rest
    //
    // and the refusal note one pass before it went: `still mending — health below the start
    // floor, health 88%, flat 0`. It declined, counted eight flat samples of not healing,
    // and left at 88% into the room that kills things.
    const resting = !!this.hold
      || /rest|safe spot|holding|healing|mend/i.test(String(this.doing ?? ''));
    const nowHp = v?.health?.value ?? null;
    if (nowHp !== null) {
      const better = this.resumeBest == null || nowHp > this.resumeBest;
      this.resumeBest = better ? nowHp : this.resumeBest;
      this.resumeWatch = nowHp;
      // Not mending? Then flatness is evidence of nothing and the counter does not move.
      // ...UNLESS THE ASKING FOR A WALL HAS RUN OUT, and then flatness is allowed to count
      // again. Without this the two halves deadlock: the ask stops after three tries and a
      // character that is not resting can never accumulate a flat sample, so `stillMending`
      // stays true and the resume declines for ever. A room with no reachable wall would
      // become a character that never travels again — which is the failure mode every
      // refusal in this method is written to avoid.
      const askedEnough = (this.resumeWallAsks ?? 0) >= (this.policy.resumeWallAsks ?? 3);
      this.resumeFlat = better ? 0
        : ((resting || askedEnough) ? (this.resumeFlat ?? 0) + 1 : 0);
    }

    // AND IF IT IS HURT WITH NOWHERE TO MEND, ASK FOR A WALL RATHER THAN SETTING OFF.
    //
    // This is the difference between "wait until you are well" and "go and get well". Left
    // to wait, a character with no wall waits for a recovery that cannot happen where it is
    // standing; the objective then ages out and the trip is lost anyway.
    //
    // BOUNDED, because a room with no reachable wall must not become a character that never
    // travels again. After a few asks the trend gate below is allowed to open as it used to,
    // which is the old behaviour and is at least a decision.
    const asks = this.resumeWallAsks ?? 0;
    if (hp !== null && hp < floor && !resting && asks < (this.policy.resumeWallAsks ?? 3)) {
      this.resumeWallAsks = asks + 1;
      this.wantsForwardShelter ??= 'the road is waiting on health and there is no wall yet';
      return this.resumeDeclined('hurt with nowhere to mend — asking for a wall before the road',
                                 { health: Math.round(hp * 100) + '%', ask: asks + 1 });
    }
    if (resting || hp === null || hp >= floor) this.resumeWallAsks = 0;
    // A PLATEAU WAIT IN THE OPEN IS A COFFIN.
    //
    // The trend gate below waits for health to stop climbing. Regeneration in a room that
    // spawns is a climb of a few points a minute, so `better` kept resetting the flat count
    // and the gate never opened. Measured in The border of the Badlands (585), 2026-09-01:
    // Bbbb, journey cancelled by the guard at 7 of 20, the only wall the selector offered
    // 31 squares away behind a 24-step walk, rest refused because worms could reach it, inn
    // retreat off by policy — and then thirty-nine seconds standing on one square while
    // health read 4, 5, 6, 7 and the resume rung said "still mending" on every pass. Six
    // groundworms and a soldier were present at the end.
    //
    // ONE BAR, like the coffin rule in the safe-spot scan: once the wall asks are spent, the
    // room is not a sanctuary, and something is already in swing range, there is nothing
    // here to wait FOR. The ladder's own last rung already says it — "there is no wall to
    // be had here, so the way out is ON" — this makes the resume agree with it instead of
    // standing on the opposite answer. Everything else about the gate is unchanged: a
    // character that is resting, or in a sanctuary, or not being reached, still waits.
    const hunted = (() => { try { return (this.inReachOfUs?.() ?? []).length > 0; } catch { return false; } })();
    const noCoverHere = (this.resumeWallAsks ?? 0) >= (this.policy.resumeWallAsks ?? 3)
      && !resting && !this.sanctuary();
    const nothingToWaitFor = noCoverHere && hunted;
    if (nothingToWaitFor)
      this.note('not waiting to mend — no wall within reach and something is in swing range', {
        health: hp === null ? null : Math.round(hp * 100) + '%', in_reach: (this.inReachOfUs?.() ?? []).length,
        why: 'regeneration cannot outrun what is already hitting us; the road is the wall' });
    // The wall is still working: let it.
    const stillMending = !nothingToWaitFor && (this.resumeFlat ?? 0) < RESUME_FLAT_SAMPLES;
    if (hp !== null && hp < floor && stillMending)
      return this.resumeDeclined('still mending — health is below the start floor and climbing',
                                 { health: Math.round(hp * 100) + '%', floor, flat: this.resumeFlat ?? 0 });
    const vig = vigorPct(v);
    const continuationOptions={travelFloor:TRAVEL_VIGOR_FLOOR,ordinaryFloor:ORDINARY_VIGOR_FLOOR};
    if(scriptedDeviationResumeCandidate(this,j,v,continuationOptions)){
      const c=this.s.client,roomId=c.room?.id,generation=this.s.movementGeneration;
      const confirmed=await this.s.confirmPosition({timeoutMs:1500});
      if(!confirmed||this.s.client!==c||c.room?.id!==roomId||this.s.movementGeneration!==generation||this.suspendedJourney!==j||
         !scriptedTrafficResumeReady(this,j,this.s.client?.vitals?.()??v,{...continuationOptions,confirmedBody:c.self}))
        return this.resumeDeclined('ended deviation awaits a fresh healthy owned body');
      continuationOptions.confirmedBody=c.self;
    }
    const continuingTraffic=scriptedTrafficResumeReady(this,j,this.s.client?.vitals?.()??v,continuationOptions);
    if (vig !== null && vig < this.restVigorCeiling() && stillMending && !continuingTraffic)
      return this.resumeDeclined('still mending — vigor is under the resting cap and climbing',
                                 { vigor: vig, cap: REST_VIGOR_CAP, flat: this.resumeFlat ?? 0 });
    // Already there. Nothing to resume, and reporting it as a resume would put a journey in
    // the ledger that never moved.
    if (ctx.room?.num === j.to) { this.suspendedJourney = null; return CONTINUE; }

    this.suspendedJourney = null;
    this.note('RESUMING THE JOURNEY IT WAS TAKEN OFF', {
      to: j.to, interrupted_by: j.trigger, attempt: j.attempts,
      waited_s: Math.round((Date.now() - j.at) / 1000),
      why: 'the survival ladder ended the movement, not the objective',
    });
    recordEvent(this.who(), 'travel_resumed', { to: j.to, trigger: j.trigger, attempts: j.attempts });
    this.goTravelling(`travelling to ${j.to} (resumed)`, { to: j.to, attempts: j.attempts, guard: j.guard, origin: j.origin });
    const ours = this.inert;
    let outcome = null;
    try {
      outcome = await this.travel(j.to, { maxHops: 30,
        // STILL THE ORIGINAL ISSUER'S JOURNEY: a resume carries the order it suspended, and says
        // the keeper picked it back up. One the keeper started itself is its own.
        origin: j.origin ? { ...j.origin, resumed_by: 'keeper:resume_journey' } : keeperOrigin('resume_journey') });
    } catch (e) {
      this.note('resumed journey failed', { to: j.to, why: e.message });
    } finally {
      // Only ours. A take-back during the resume has already revived and may have started
      // something else; reviving that would be the two-drivers bug wearing a third hat.
      if (ours && this.inert === ours) {
        const here = Number(this.s.world?.room?.num);
        if (!ours.cancelled && outcome?.arrived !== true && here !== Number(j.to)
            && !outcome?.refused && here !== 1 && !this.recoverUntilWhole
            && (this.tally?.deaths ?? 0) === j.deaths_at) {
          this.suspendedJourney = { ...j, attempts: (j.attempts ?? 0) + 1,
            trigger: outcome?.reason ?? outcome?.outcome ?? 'resumed journey ended short',
            next_try_at: Date.now() + 5000 };
        }
        this.revive('resumed journey ended');
      }
    }
    return HANDLED;
  }

  // `origin` is the CALLER's provenance (m59-move-origin.mjs). Everything that reaches this is
  // external — the cancel_movement tool, POST /cancel, a FleetScript clearing the way — so a
  // caller that names nobody is `mcp:unattributed`, never the keeper.
  cancelJourney(why = 'external movement cancellation', controlToken = null, origin = null) {
    this.pendingBlockerLure=null;
    this.clearSurvivalJam('external cancellation');
    // A watchdog pauses a route through Session.cancelMovement. An external
    // cancellation withdraws its destination too; otherwise the next healthy
    // pass resurrects the order that the director has already abandoned.
    const to = this.suspendedJourney?.to ?? this.inert?.to ?? null;
    this.suspendedJourney = null;
    if (this.inert?.travelling) this.inert.cancelled = true;
    const result = this.s.cancelMovement(controlToken, why, {replacement:{
      strategy:'yield_to_controller',reason:why,reason_code:'explicit_cancellation',status:'yielded'},
      origin: moveOrigin(origin, { source: 'mcp', name: 'unattributed' })});
    this.note('journey cancelled by its caller', { to, why });
    return { ...result, retired_destination: to };
  }
  // @end 1
}
