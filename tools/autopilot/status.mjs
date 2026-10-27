// STATUS: what the keeper reports about itself.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 2 methods: status, countLoot
import { riteStatus } from '../m59-castrite.mjs';
import { lootOnlyStatus } from '../m59-loot-filter.mjs';
import { movementReport, originLabel } from '../m59-move-origin.mjs';
import { purchasePlan } from '../m59-purchase-plan.mjs';
import { pvpReturnDelayMs } from '../m59-pvp-return.mjs';
import { pvpAllowedHere, pvpRoomsOf } from '../m59-pvp-rooms.mjs';
import { refusedTargets } from '../m59-refused-targets.mjs';
import { castRole } from '../m59-spellgear.mjs';
import { survivalDecisionSnapshot } from '../m59-survival-decision.mjs';
import { survivalTraceSummary } from '../m59-survival-trace.mjs';
import { TitheBook } from '../m59-tithe.mjs';
import * as watchdog from '../m59-watchdog.mjs';
import { TITHE_FLEET, TRAVEL_GUARD_CLOCK, TRAVEL_GUARD_KEYS, WANT_FIGHT_VIGOR, farmRoomDenials, stageDeadlineMs } from '../m59-autopilot.mjs';

export class StatusPart {
  // @part 1

  status({ full = false } = {}) {
    const deniedFarmRooms = farmRoomDenials(this.noWallRooms, this.cappedRooms);
    return {
      running: this.running, mode: this.mode, policy: this.policy,
      cooperative_logoff: this.s.cooperativeLogoffWaiting??this.s.cooperativeLogoffReturn??null,
      healing_wand_support: this.farmWandSupport?.snapshot() ?? null,
      loadout_retention: { present: !!this.loadout(), carry_floors: this.carryFloors() },
      // WHICH OF THIS CHARACTER'S WEAPONS BYPASS NONMAGIC, as READ (look text, a lapse), never
      // assumed. Rides out on status so the keeper-backed fleet row gets it with no rebuild.
      weapon_magic: this.weaponMagicStatus(),
      survival_trace: survivalTraceSummary(this.s),
      survival_decisions: survivalDecisionSnapshot(this.s,{history:false}),
      survival_decision_log: this.survivalRecorder?.stats?.() ?? null,
      replay_capture: this.s.replayRecorder?.status?.() ?? (this.s.replayCaptureError?{errors:1,last_error:this.s.replayCaptureError}:null),
      // Null unless a fleet update is waiting on this character. See park().
      parked: this.parkStatus(),
      // Null unless something else is driving this character. `running: true` with
      // `inert` set is the normal shape of an errand in progress — the loop is watching
      // and recording, and it is not the thing moving the character.
      inert: this.inertStatus(),
      // ALWAYS PRESENT, EVEN WHEN NOTHING IS TRAVELLING, because the question an operator
      // asks is "what WILL this character do if a journey takes it", and an answer that
      // only exists while one already has is an answer arriving too late to act on. The
      // effective guard: the defaults, with this character's policy over the top.
      travel_guard: Object.fromEntries(TRAVEL_GUARD_KEYS.map(k =>
        [k, { allowed: this.travelGuard()[k], clock: TRAVEL_GUARD_CLOCK[k] }])),
      // WHY A HEALTHY CHARACTER IS SITTING IN AN INN. Null unless a player killed it inside
      // the return delay; never absent, so a board can tell "no hold" from "not reported".
      // The effective delay beside it for the same reason `travel_guard` is always present.
      pvp_return_hold: this.pvpReturnHold(),
      pvp_return_delay_ms: pvpReturnDelayMs(this.policy),
      // WHERE A PLAYER MAY BE ENGAGED, and whether that includes where the body stands now.
      // Always present: `rooms: null` is "everywhere", the behaviour before pvp_rooms existed.
      pvp_rooms: { rooms: pvpRoomsOf(this.policy),
        room: this.s?.world?.room?.num ?? null,
        allowed_here: pvpAllowedHere(this.policy, this.s?.world?.room?.num) },
      pvp_loud: this.policy?.pvpLoud === true,
      // THE TOUCH SPELL BEING TRAINED, and whether the server last said it was on. Null when
      // touch_spell is unset. `blocked_reason` is why it is not being cast (mana, reagents, an
      // unknown spell) while the character fights bare.
      touch_spell: this.touchSpellStatus(),
      // Null when unset, like touch_spell. `ignored` names priority entries hunt never produces.
      hunt_priority: this.huntPriorityStatus(),
      loot_only: lootOnlyStatus(this.policy.lootOnly ?? null, this.s?._lootOnlyMemory ?? null),
      // THE FARMING STRATEGY: which file, applied or yielded per key, what it shadows, its hooks.
      // Null when none is assigned. And WHO SET EACH KEY, whichever writer it was.
      farm_strategy: this.farmStrategyStatus(),
      // THE CAST RITE (m59-castrite.mjs): this character's cast role, the costume it is wearing for a
      // spell right now and what it will put back, or the last one it took off.
      cast_rite: { role: castRole(this.s?.name), ...riteStatus(this.s) },
      // THE ORDERS, WITH THE FILE'S OVERLAY TAKEN BACK OUT, whenever a strategy engine exists. The
      // broker seeds an order from this, never from `policy` above: seeding from the effective
      // policy is how a file's keys were persisted into the roster and carried after the file was
      // unassigned (Floyd's spareCreatures, 2026-10-03 -- m59-strategy-engine.mjs ordersFromStatus).
      ...(this._farmStrategy ? { policy_orders: this.policyForOrders() } : {}),
      policy_sources: this.policySources?.snapshot() ?? null,
      // WHO OWNS WHICH HALF OF THIS CHARACTER. Always present, never undefined: a reader
      // has to be able to tell "the keeper owns everything" from "this broker does not
      // answer that question", and undefined reads as the second. With nothing attached
      // every entry is the string 'keeper', which is the case m59-faculty-test pins.
      faculties: this.facultyStatus(),
      recovery_travel: this.s.keeperRecoveryTravel??null,
      // NULL UNLESS THIS CHARACTER IS WORKING A LEVER PUZZLE (room 2600 on the way to 2601).
      // `waiting` is the line an operator looks for: a lone traveller at a lever square reads
      // "waiting for a second lever puller" here rather than looking wedged.
      lever_puzzle: this.leverPuzzleStatus(),
      // What it is up to, in the words someone watching would use. Belongs here rather
      // than only on the fleet snapshot: anything reading a keeper's status — the
      // terminal board, another agent — wants the sentence, not the time buckets.
      activity: this.activity(),
      town_service: this.lastTownServiceAt ? { last_at: this.lastTownServiceAt } : null,
      // IS THE FLEET ALREADY USING THIS CHARACTER FOR SOMETHING? Null for nearly all of
      // them, and never absent — a board that greys committed rows has to be able to tell
      // "free" from "this broker does not answer that question", and undefined is what it
      // reads as the second. See m59-commitment.mjs for what counts and why the answer is
      // computed there rather than here.
      committed: this.commitment(),
      // HOW BLIND THIS KEEPER HAS BEEN, and what it did about it. `longest_block_ms` is
      // the headline: it is how long the decide loop has gone inside a single await, and
      // it is the number the whole watchdog exists to bound the damage from. Null before
      // the keeper has started, never absent while it is running.
      entry: this.s?.enteredVia ?? null,
      last_decision: this.lastDecision ? {...this.lastDecision, age_ms: Date.now()-this.lastDecision.at} : null,
      farm_combat: this.farmCombat ?? null,
      ladder: {
        stage: this.passStage ?? null,
        stage_age_ms: this.passStageAt ? Date.now() - this.passStageAt : null,
        in_flight: [...(this.stageInFlight?.keys() ?? [])].map(stage => ({
          stage, age_ms: this.stageFlightStartedAt?.has(stage)
            ? Date.now() - this.stageFlightStartedAt.get(stage) : null,
          deadline_ms: stageDeadlineMs(stage),
        })),
        overruns: this.tally.stage_overran ?? 0,
        skipped_in_flight: this.tally.stage_skipped_in_flight ?? 0,
      },
      watchdog: this.watchTimer ? {
        ticks: this.watch.ticks, frames_written: this.watch.frames,
        interrupts: this.watch.interrupts,
        longest_block_ms: this.watch.longest_block_ms,
        blocked_now_ms: this.passStartedAt ? Date.now() - this.passStartedAt : 0,
        last_frame_s_ago: this.lastFrameAt ? Math.round((Date.now() - this.lastFrameAt) / 1000) : null,
        // AND WHETHER THE BODY IS MOVING, which is a different question from all of the
        // above — those measure the keeper. `wedged` is non-null only while the character
        // has somewhere to be and has not changed square for two pulses. See PULSE_MS.
        wedges: this.watch.wedges ?? 0,
        wedged: this.watch.wedged ? {
          ...this.watch.wedged, for_ms: Date.now() - this.watch.wedged.since } : null,
        // THE FIGHT-BACK EDICT'S CLOCK: how long something in reach has been landing blows
        // while this character was not swinging, and whether the order is even on.
        fight_back_after_ms: this.fightBackAfterMs() || null,
        under_attack: this.watch.attack ? {
          for_s: Math.round((Date.now() - this.watch.attack.since) / 1000),
          hits: this.watch.attack.hits, lost: this.watch.attack.lost } : null,
      } : null,
      // PLAYERS THE SERVER WILL NOT LET US ATTACK IN THIS ROOM ("Only those in guilds may attack
      // each other here."). Every attack path skips them here; leaving the room forgets them.
      refused_targets: (() => { try { return refusedTargets(this.s)?.list() ?? []; } catch { return null; } })(),
      passes: this.passes,
      running_for_seconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      // The summary is the part a returning model should read first; the journal is
      // there for when the summary is surprising.
      did: {
        ...this.tally,
        // THIS KEEPER'S OWN VIEW, AND IT IS NARROWER THAN ITS NAME. `killTimes` starts
        // empty in the constructor and the supervisor restarts keepers about once a
        // minute, so this really means "kills since the last restart, capped at 30
        // minutes" — it is the keeper's opinion of its own run, not a fleet-wide rate.
        // Anything rendering a kills/30m column must use countKills() in m59-ledger.mjs,
        // which counts `killed` events off disk and therefore survives a keeper. The
        // fleet rows do; this stays because a returning model reading `did` wants to
        // know what THIS keeper has managed since it started.
        kills_30m: this.killsSince(30 * 60_000),
        looted: Object.entries(this.tally.looted).map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`),
        rooms_visited: [...this.visited],
      },
      // WHAT WILL THIS CHARACTER DO IF IT FILLS ITS PACK — answerable BEFORE the post-mortem,
      // for the same reason `travel_guard` is reported whether or not anything is travelling.
      overfarm: this.policy.overfarm?.enabled ? {
        enabled: true,
        selective_at: this.policy.overfarm.selective_at,
        overfarm_percent: this.policy.overfarm.overfarm_percent,
        prefer: this.policy.overfarm.prefer, avoid: this.policy.overfarm.avoid,
        lap: this.s?._overfarm ? {
          sifted: this.s._overfarm.sifted, taken: this.s._overfarm.taken,
          dropped: this.s._overfarm.dropped, left_behind: this.s._overfarm.left,
        } : null,
      } : { enabled: false },
      coordination: {
        movement_region: { contract: this.policy.movementRegion, last_refusal: this.s.movementRegionStatus ?? null },
        farm_cleanup: { enabled: !!this.policy.farmCleanup?.enabled, ...this.coordination.cleanup },
        farm_delivery: { enabled: !!this.policy.farmDelivery?.enabled, ...this.coordination.delivery,
          pending: this.pendingFarmDelivery ? {
            room: this.pendingFarmDelivery.room, room_name: this.pendingFarmDelivery.room_name,
            polled: this.pendingFarmDelivery.polled.length,
            radius: this.pendingFarmDelivery.radius,
            requested: this.pendingFarmDelivery.requested, bought: this.pendingFarmDelivery.bought,
            cargo: this.pendingFarmDelivery.cargo,
          } : null },
      },
      last_error: this.lastError,
      // WHEN, AND WHETHER THE SESSION WAS AWAKE FOR IT. Without these the field could not
      // distinguish a healed reconnect blip from a session that is actually dead, and
      // polling again did not help because nothing ever cleared it. Null whenever
      // `last_error` is null, so the three always tell one story.
      last_error_age_s: this.lastErrorAt
        ? Math.round((Date.now() - this.lastErrorAt) / 1000) : null,
      // false = it threw while the client was gone, which is what a deliberate breakout
      // looks like and what heals itself. true = it threw with the session live, which is
      // the kind worth acting on.
      last_error_live: this.lastError ? this.lastErrorLive : null,
      // How many passes in a row have failed. 1 is a blip; a climbing number is a keeper
      // that is not going to get out of it on its own.
      failing_passes: this.consecutivePassFailures || 0,
      // WHETHER THE WATCHDOG IS BREAKING THE SAME WEDGE OVER AND OVER, which used to be
      // visible only as a climbing `watchdog_pinned_interrupts` and 217 identical notes.
      // `repeats` climbing at one square is the loop; `gave_up` is the pass declining to
      // feed it. Null when nothing is recorded.
      wedge: this.watch?.wedgeBreak ? {
        room: this.watch.wedgeBreak.room,
        square: `${this.watch.wedgeBreak.col},${this.watch.wedgeBreak.row}`,
        repeats: this.watch.wedgeBreak.repeats, cap: watchdog.WEDGE_REPEAT_CAP,
        doing: this.watch.wedgeBreak.doing, to: this.watch.wedgeBreak.to,
        for_s: Math.round((Date.now() - this.watch.wedgeBreak.first_at) / 1000),
        gave_up: !!(this.wedgeHold && Date.now() < this.wedgeHold.until),
        hold_left_s: this.wedgeHold && Date.now() < this.wedgeHold.until
          ? Math.round((this.wedgeHold.until - Date.now()) / 1000) : null,
      } : null,
      // The one field worth reading before anything else, and it now means what it says:
      // the most recent error THAT HAS NOT SINCE BEEN RECOVERED FROM. A completed pass on
      // a live session clears it (see loop()). Everything this keeper got
      // wrong in practice was invisible: it kept running, kept journalling, and did
      // no work. If this is set, it has been going through the motions.
      // The second invisible failure, alongside `stalled`: working perfectly and earning
      // nothing. Null when there is no opinion to give — never a quiet "fine".
      yield_check: this.yieldCheck(),
      // Beside yield_check rather than inside it: one answers "is this prey worth killing",
      // the other "is this prey reachable from where I am standing", and a caller that wants
      // to act on the second must not have to infer it from the first being silent.
      hunt_room: this.huntRoomCheck(),
      // "poor orc teeth", in a field rather than in prose. A shortage the fleet has DECIDED to
      // live with has to be visible, or the next reader sees a caster that quietly stopped
      // casting and goes looking for a bug in the spell path.
      reagent_short: this.reagentShort ?? [],
      // THE OBJECTIVE A STOPPED JOURNEY IS STILL CARRYING, or null if it carries none.
      //
      // Every leg of a twenty-one character run went `idle` between +170s and +400s, several
      // of them at 45 to 56 health — not hurt, just stopped. Whether the destination survived
      // is the obvious next question and it could not be asked: nothing reported this, so a
      // reader got `undefined` and read it as "no journey". That is the same mistake as
      // reading a missing ailments field as "nothing was on us", and I made it twice in a day.
      //
      // A record that cannot answer a question is worse than one that says "I do not know",
      // because it answers anyway.
      blink_rung: this.s.blinkRungStats ?? null,
      // WHO IS STEERING THE BODY, AND WHO LAST TOOK A MOVE FROM SOMEBODY ELSE.
      // `movement.order.ordered_by` is the current move's issuer; `movement.last_preempted` is
      // the last time one issuer's move was cancelled by another — what, by whom, when, why.
      movement: movementReport(this.s),
      last_preempted: movementReport(this.s)?.last_preempted ?? null,
      suspended_journey: this.suspendedJourney
        ? { to: this.suspendedJourney.to,
            ordered_by: this.suspendedJourney.origin ? originLabel(this.suspendedJourney.origin) : null,
            trigger: this.suspendedJourney.trigger ?? null,
            attempts: this.suspendedJourney.attempts ?? 0,
            age_s: Math.round((Date.now() - (this.suspendedJourney.at ?? Date.now())) / 1000) }
        : null,
      stalled: this.stalledSince
        ? { since_seconds: Math.round((Date.now() - this.stalledSince) / 1000),
            idle_passes: this.idlePasses, why: this.stalledWhy,
            // WHAT COULD ACT ON IT, AND WHETHER THE SENTENCE IS REPEATING. Without these
            // two a reader can see that a number is going up and cannot tell a character
            // working through a hard room from one reciting the same failure. `lever: null`
            // with a high `repeats` is the shape that ran for 27 minutes unseen.
            lever: this.stalledLever ?? null,
            repeats: this.stallRepeats ?? 0 }
        : false,
      // THE SAME FACT AGAIN, IN THE ONE SHAPE EVERY READER CAN USE.
      //
      // `stalled` is three different types depending on who is answering — a sentence from a
      // keeper proxy, this object from an in-process pilot, `false` from either — because it
      // has always been a thing to PRINT. Anything that wants to act on it (a fleet board
      // column, a watcher deciding whether to shout) needs one shape that is either null or
      // an object, and needs it to mean the same thing on both kinds of broker. That is
      // `stuck`, and m59-keeper-process.mjs publishes exactly this from /state.
      stuck: this.stalledSince
        ? { since: this.stalledSince,
            seconds: Math.round((Date.now() - this.stalledSince) / 1000),
            why: this.stalledWhy ?? null,
            lever: this.stalledLever ?? null,
            repeats: this.stallRepeats ?? 0 }
        : null,
      // THE SAME TWO FACTS AS `stalled`, AS DATA RATHER THAN AS A SENTENCE.
      //
      // Always arrays/null rather than absent, because a reader has to be able to tell
      // "this keeper reports no refusals" from "this broker does not answer that
      // question" — undefined reads as the second and is what makes a new field
      // invisible to whoever forgot to redeploy. See refuse().
      refusals: [...(this.refusals?.values() ?? [])],
      waiting_on: this.waitingOn ?? null,
      home_room: this.homeRoom,
      // WHAT VIGOR IT IS ACTUALLY FIGHTING AT. Vigor sets how fast health comes back
      // between fights, so a character that engages tired stays tired. `below_want`
      // over `engagements` is the honest score; `starved_passes` says the reason is
      // an empty pack rather than a bad threshold.
      vigor: this.vigor.engagements || this.vigor.waited ? {
        floor_now: this.fightFloor(), want: WANT_FIGHT_VIGOR,
        engagements: this.vigor.engagements,
        average_at_engage: this.vigor.engagements
          ? Math.round(this.vigor.total_at_engage / this.vigor.engagements) : null,
        lowest_at_engage: this.vigor.lowest_at_engage,
        started_below_want: this.vigor.engagements
          ? Math.round(100 * this.vigor.below_want / this.vigor.engagements) + '%' : null,
        waited_for_vigor: this.vigor.waited,
        starved_passes: this.vigor.starved_passes,
        // Self-provisioning: how often it fed itself rather than needing a supply run.
        cooked: this.vigor.cooked, cook_failed: this.vigor.cook_failed,
        reagents: this.reagentCount(),
      } : null,
      // WHAT IT CAST, WHAT IT REFUSED TO CAST, AND WHAT IT BOUGHT INSTEAD.
      //
      // Since the broker restarts this is only the current session; `history spells:true`
      // is the same question over days. Both, because they answer different ones — this
      // says what the keeper in front of you is doing, that says whether it has ever
      // worked. Null when it has neither cast nor declined anything, so an idle keeper
      // does not render an empty table that reads as "casting nothing on purpose".
      spells: this.spellSummary(),
      // ROOMS THIS KEEPER HAS REFUSED, and why. Null when it has refused none.
      //
      // Reported rather than merely obeyed, because refusing rooms is a self-inflicted
      // limit: a keeper that quietly declines half the map looks identical to one that
      // is simply unlucky with spawns, and the fleet would slowly stop working with no
      // single thing to point at. This is the list to read when output falls.
      denied_rooms: deniedFarmRooms.size
        ? { count: deniedFarmRooms.size,
            rooms: [...deniedFarmRooms.entries()].map(([room, why]) => ({
              room, why,
              kind: this.cappedRooms?.has(room) ? 'spawn_cap_blocked' : 'no_safe_wall',
            })),
            note: 'session-local room refusals only. The keeper tries other hunting grounds; ' +
                  'these do not block or fail the strategic goal' }
        : null,
      // IS THE MONEY GETTING TO A BANK. banked is the total put away; carried_at_death
      // is what was lost on the floor anyway, and is the number to drive to zero.
      money: (this.money.trips || this.money.carried_at_death || this.tally.banked) ? {
        bank_above: this.bankAboveNow(), float_kept: this.walkingFloat(), purse_lease: this.purseLeaseStatus(),
        carrying: this.lastSeenPurse ?? null,
        banked: this.tally.banked ?? 0,
        trips: this.money.trips, trips_failed: this.money.trips_failed,
        carried_at_death: this.money.carried_at_death,
        why_not: this.money.why_not,
      } : null,
      pending_shopping_trip: this.townTrip ? {
        to: this.townTrip.target.room, next_service: this.townTrip.nextService,
        started_at: this.townTrip.startedAt,
        market_index: this.townTrip.marketIndex ?? null,
        market_stops: this.townTrip.marketStops?.map(stop => stop.room) ?? null,
        purchase_plan: this.townTrip.purchasePlan ?? null,
      } : null,
      purchase_funding: this.purchaseFunding ?? null,
      reagent_coop: this.policy.reagentCoop?.enabled ? {
        config: this.policy.reagentCoop, last_visit: this.coopStatus ?? null,
        pending: this.coopVisit ? { mode: this.coopVisit.mode, stage: this.coopVisit.stage } : null,
      } : null,
      poor_farming: this.poorSupply ? { ...this.poorSupply, active: this.poorFarmingActive(),
        vigor_floor: this.poorVigorFloor() } : null,
      deferred_shopping: this.deferredShoppingTrip ? {
        to: this.deferredShoppingTrip.target.room, next_service: this.deferredShoppingTrip.nextService,
      } : null,
      town_trip_control: this.townTripControlStatus(),
      guild_tithe: this.policy.guildTithe?.enabled ? {
        daily_amount: this.policy.guildTithe.daily_amount,
        paid_today: new TitheBook({ agent: this.name ?? this.s.name,
          fleet: TITHE_FLEET }).paidToday(),
        paid_since_restart: this.tally.guild_tithe ?? 0,
      } : null,
      // WHERE IT WAS PUT, AND WHETHER THAT STUCK. Three numbers, in the order worth
      // arguing about: did the assignment work, does it work every time, and how does
      // it fail. `held` null means it has never had to relocate, which is the good
      // case and must not read as 0%.
      placement: this.policy.assignedRoom == null && !this.placement.relocations ? null : {
        assigned_room: this.policy.assignedRoom,
        assignment_deferred: this.policy.assignedRoom != null
          ? deniedFarmRooms.has(this.policy.assignedRoom) : false,
        assignment_deferred_reason: this.policy.assignedRoom != null
          ? deniedFarmRooms.get(this.policy.assignedRoom) || null : null,
        standing_where_assigned: this.policy.assignedRoom != null
          ? this.s.world?.room?.num === this.policy.assignedRoom : null,
        held: this.placement.relocations
          ? Math.round(100 * this.placement.returned_to_assignment / this.placement.relocations) + '%'
          : null,
        ...this.placement,
        drifted_to: Object.entries(this.placement.drifted_to)
          .map(([r, n]) => `${r}${n > 1 ? ` x${n}` : ''}`),
      },
      // WHERE WE ARE STANDING AND WHETHER IT WORKS. Read this before deciding
      // anything about a fight: `works` true means the character cannot be hit unless
      // it swings first, which makes breaking off free, makes resting to full
      // possible in a monster room, and makes fleeing the wrong move.
      safe_spot: this.hold ? {
        at: { col: this.hold.col, row: this.hold.row },
        works: this.holdWorks(),
        evidence: this.hold.proven
          ? (this.hold.inherited && !this.hold.provenAt
              ? 'held under attack on an earlier visit'
              : `nothing landed in ${Math.round(this.hold.quietMs / 1000)}s with ` +
                `${this.hold.mostAttackers} thing(s) standing next to us`)
          : (this.hold.failures
              ? `hit ${this.hold.failures} time(s) while standing still — this square does not work`
              : 'untested: treated as open floor until something stands next to us without landing a blow'),
        // Not "sides open" any more: how many of the 28 squares within melee reach can
        // actually swing at this one, and how many we can hit from it for free.
        can_reach_you: this.hold.canReachYou, free_shots: this.hold.freeShots,
        back_cover: this.hold.backCover,
        held_s: Math.round((Date.now() - this.hold.takenAt) / 1000),
      } : false,
      // Who is on us, and how that is known — the protocol never says outright.
      threat: (() => {
        const t = this.threat();
        return { could_reach_us: t.near.length, camped_on_us: t.engaged,
                 in_swing_range: t.adjacent.length, what: t.names,
                 landing_damage: t.landing || 0,
                 note: 'nothing in the protocol says who has targeted us. `camped_on_us` is things ' +
                       'that have stayed next to us for more than one pass; `landing_damage` is the ' +
                       'only direct evidence, and it is what proves or disproves a safe spot' };
      })(),
      // Where the time went. `stalled` here means only what it says: standing about
      // not knowing what to do, while not recovering.
      time: (() => {
        const t = this.time, act = this.activeSeconds, total = act + t.stalled;
        const r = n => Math.round(n);
        return { fighting_s: r(t.fighting), pulling_s: r(t.pulling), waiting_s: r(t.waiting),
                 recovering_s: r(t.recovering), zoning_s: r(t.zoning),
                 travelling_s: r(t.travelling), trading_s: r(t.trading),
                 stalled_s: r(t.stalled),
                 active_s: r(act),
                 stalled_pct: total ? +((100 * t.stalled) / total).toFixed(1) : 0 };
      })(),
      last_death: this.lastDeath ?? null,
      // Visible on purpose: "resting and refusing to fight" and "stuck doing nothing"
      // look identical from outside, and the whole point of the flag is that it holds a
      // character still on purpose for a while.
      recovering_from_death: this.recoverUntilWhole ? {
        until: 'health >= 95% and vigor >= the resting cap',
        why: 'came back from the dead; not going out again until whole',
      } : null,
      // WHAT THE BODY HAS DONE SINCE IT WAS LAST WHOLE, and null while it is whole.
      //
      // Health falling is already in every reading here. What none of them could answer is
      // whether the moving that happens while it falls is going anywhere — and on a journey
      // under attack, "forward, or to a wall" is the entire job. `progress_ratio` is the
      // number: 1.0 is a straight line, near 0 is a body moving and getting nowhere, and
      // `reached_shelter_after_s` reading null after a long bleed is its own finding.
      since_full_health: this.sinceFullHealth?.() ?? null,
      recent: this.journal.slice(-12),
      // THE MEASUREMENT, NOT THE CONCLUSION. Every window observe() looked at, with
      // the readings it was looking at, so that someone standing in the room can
      // disagree with a specific one. Discards are here too and are the interesting
      // half: a window wrongly thrown away is how this would be quietly broken.
      trials: this.trials.slice(-12),
      // THE GOAP PLAN, if this character is running the GOAP keeper.
      // A visible plan is the only plan you can argue with: what goal
      // it's chasing, the chain of actions it found, and the world
      // state it saw when it planned. Null when not on GOAP.
      goap: this._goapKeeper?.state() ?? null,
      ...(full ? { journal: this.journal, all_trials: this.trials } : {}),
    };
  }

  countLoot(items = []) {
    for (const it of items) {
      const name = String(it).replace(/ x\d+$/, '');
      const n = Number(/ x(\d+)$/.exec(String(it))?.[1] ?? 1);
      this.tally.looted[name] = (this.tally.looted[name] || 0) + n;
    }
  }
  // @end 1
}
