// THE TRAVELLING PASS.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 2 methods: requestWeaponPurchase, passTravelling
import { recordEvent } from '../m59-ledger.mjs';
import { keeperOrigin, liveMoveOrder } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { CONTINUE, HANDLED, TRAVEL_RESCUE_TTL_MS } from '../m59-autopilot.mjs';

export class PassTravellingPart {
  // @part 1

  // Walk to a smith, buy a weapon, and wield it. Spawns m59-outfit.mjs as a child
  // process the same way the broker does for ability buying. The outfit script stops
  // the keeper, does the shopping trip, then restarts it — so this method just waits
  // for the child to exit and reports whether the character is now armed.
  // ASK FOR A WEAPON. DO NOT GO AND BUY ONE FROM IN HERE.
  //
  // The keeper used to spawn `m59-outfit.mjs` itself, from inside `pass()`, and await the
  // child. Three things are wrong with that and only the first is obvious:
  //
  //  1. The child STOPS AND RESTARTS THIS KEEPER as part of its job. Awaiting it from
  //     inside the keeper's own pass means the pass is waiting on a process whose first
  //     act is to stop the thing doing the waiting.
  //  2. NOTHING DECLARED THE CHARACTER BUSY, so for the whole shopping trip — across the
  //     world, minutes — every stall detector in the fleet saw `ms_since_moved` climbing
  //     and read a character that was walking perfectly well as one standing still.
  //     `m59-supervise.mjs`'s unstick round would restart the keeper out from under it.
  //     That is the exact failure `busy` was added to this repository to prevent.
  //  3. The fleet board had no way to say why the character was unavailable, so it looked
  //     idle rather than shopping.
  //
  // So the keeper states the NEED and the broker runs the ERRAND — the same split as
  // every other outside operation, and the same spawn the broker already does for buying
  // an ability. `wantsWeapon` is the whole interface: a plain field the broker polls,
  // cleared by whoever services it.
  //
  // The request is a WANT, not a promise. Nothing here assumes it will be serviced — the
  // cooldown below and the fall-through to `stop()` both still apply, so a fleet with no
  // broker sweep behaves exactly as it did before this existed.
  requestWeaponPurchase({ why = 'unarmed' } = {}) {
    if (this.wantsWeapon) return this.wantsWeapon;    // already asked; do not re-stamp it
    this.wantsWeapon = { why, at: Date.now(), agent: this.s.name };
    this.note('asked the fleet for a weapon', {
      why, agent: this.s.name,
      what_happens_next: 'the broker claims this character, marks it busy, and runs ' +
                         'm59-outfit.mjs to walk it to the nearest smith',
      note: 'the keeper does not do this itself — an errand that walks a character must ' +
            'be declared busy or every stall detector in the fleet will restart it',
    });
    return this.wantsWeapon;
  }

  // ── passTravelling: the restricted ladder a journey leaves running ────────────
  //
  // Reached only from the gate in `passUnderworld`, and only while a JOURNEY holds the
  // character. It answers one question — is anything about staying alive worth ending this
  // journey for — and it answers it with the same numbers the ordinary ladder uses.
  //
  // IT NEVER MOVES ANYBODY. Every branch below cancels the movement, leaves the travelling
  // state, and returns CONTINUE so the ordinary stages decide on this same pass. That is
  // the watchdog rescue's contract and it is what keeps "only one thing drives a body"
  // true: the keeper does not fight the mover for the character, it ends the mover.
  //
  // Returns CONTINUE when it has taken the character back, HANDLED to let the journey run.
  async passTravelling(ctx) {
    const { s, c, v, hp } = ctx;
    const held = this.inert;
    // Hand back, once, with a reason the post-mortem can read.
    // ABANDONING A JOURNEY AND PAUSING ONE ARE DIFFERENT ACTS, AND ONLY ONE OF THEM IS
    // ALLOWED FOR A MONSTER.
    //
    // `abandon` defaults to FALSE on purpose: the rule is "never give up a journey unless a
    // PLAYER is attacking", so the safe default has to be the one that keeps the objective.
    // A new rung added without thinking about this pauses, which is recoverable; a rung
    // that abandons has to say so in writing.
    //
    // WHY A WALL BEATS RUNNING, which is the whole reason pausing is enough. Being attacked
    // on the road is the ordinary condition of travel here — there is no safe route, and a
    // trip that turns back every time something bites just accumulates the same damage in
    // both directions. A safe spot is a square a creature CANNOT PATH TO, and there is
    // almost always one closer than the next town: reaching one ENDS the fight instead of
    // gambling on outrunning it, and the character rests there to full and walks on.
    //
    // A player is the exception, and it is not a matter of degree. A wall stops monsters and
    // says nothing whatever about a person, who can walk to the same square, swing first and
    // take the pack — dying to the troll costs the walk back, dying to the player costs
    // everything carried. That asymmetry is why `travel_hold_pvp` refuses a rest with people
    // about, and it is the same argument here.
    const takeBack = (what, why, detail = {}, { abandon = false } = {}) => {
      const pausedOrigin=Number(liveMoveOrder(s)?.to)===Number(held.to)?liveMoveOrder(s)?.origin:held.origin;
      const stopped = (() => {
        try { return this.cancelForSurvival(null, 'a travel guard rung taking the character back', { origin: keeperOrigin('travel_guard') }); } catch (e) { return { cancelled: false, why: e.message }; }
      })();
      const was = held.why ?? 'travelling';
      this.tally.travel_takebacks = (this.tally.travel_takebacks || 0) + 1;
      // SUSPEND THE OBJECTIVE RATHER THAN LOSING IT.
      //
      // Every branch here cancels the journey because the character is in trouble, and that
      // is right — but it used to cancel the ERRAND as well as the movement, so a character
      // pulled off the road at 30% health healed up and then went back to farming with no
      // memory that it had been going anywhere. That is what a shuttle test sees as a
      // journey that "stopped being busy without arriving", and what an operator sees as
      // travel quietly not working.
      //
      // Kept on the keeper, deliberately NOT in `this.inert`: inert means something holds
      // this character, and a suspended journey holds nothing. It is a note about the past.
      // `attempts` carries across suspensions of the SAME destination so a corridor that
      // keeps taking the character back cannot resume for ever — see resumeSuspendedJourney.
      if (abandon) this.suspendedJourney = null;
      else if (held.to != null) {
        this.suspendedJourney ??= {
          to: held.to, why: was, at: Date.now(), trigger: what,
          ...(pausedOrigin?{origin:pausedOrigin}:{}),guard:{...held.guard},
          attempts: (held.attempts ?? 0) + 1,
          // The death count AT SUSPENSION. Resuming a journey the character died on is the
          // Cccc failure with extra steps, so the resume compares this against the live
          // count rather than trusting that a death would have cleared the note.
          deaths_at: this.tally?.deaths ?? 0,
        };
      }
      this.revive(`${what} while ${was}`);
      this.recordFrame(`! took the character back — ${what}`);
      this.note(abandon ? 'ABANDONED THE JOURNEY — A PLAYER IS ON US'
                        : 'PAUSED THE JOURNEY — TAKING A WALL, THEN CARRYING ON', {
        trigger: what, why, was_travelling_to: was,
        health: v?.health ? `${v.health.value}/${v.health.max}` : null,
        at_fraction: hp !== null ? Math.round(hp * 100) + '%' : null,
        flee_at: Math.round(this.safety().fleeAt * 100) + '%',
        interrupted: stopped.interrupted ?? null,
        ...detail,
        abandoned: abandon,
        note: abandon
          ? 'the objective is GONE. Only a player gets this: a wall does not stop a person, ' +
            'and what is carried is worth more than the destination'
          : 'the movement is cancelled and the objective is KEPT. The ordinary ladder runs ' +
            'on this same pass and its answer to being hurt on a road is a safe wall; the ' +
            'journey resumes from there once health and vigor are back up',
      });
      recordEvent(this.who(), abandon ? 'travel_abandoned' : 'travel_paused_for_wall', {
        trigger: what, was_travelling_to: was, abandoned: abandon,
        health: v?.health?.value ?? null, max: v?.health?.max ?? null,
        room: s.world?.room?.num ?? null,
      });
      // ASK FOR THE WALL. THE NOTE ABOVE USED TO ASSERT THIS HAPPENED BY ITSELF.
      //
      // "the ordinary ladder runs on this same pass and its answer to being hurt on a road
      // is a safe wall" — and that is true only for a character the ladder considers HURT,
      // which means below `restBelow`, 0.7. This rung now fires at ANY damage. So a
      // character at 85% cancelled its crossing for a wall, dropped into a ladder with no
      // answer for it, went idle, and was picked back up by the resume a few seconds later
      // having rested for none of them. Measured, both characters, this afternoon:
      //
      //   Aaaa  28/33 (85%)  travel_paused_for_wall   then  0r rest, dead at 92s
      //   Bbbb  15/20 (75%)  travel_paused_for_wall   then  0r rest, dead at 175s
      //
      //   +34s  room 587  idle
      //   +66s  room 587  inert — travelling to 38 (resumed)
      //
      // Thirty-two seconds of standing still, no wall taken, no health regained, and back
      // on the road. Two rungs that disagreed about what "hurt" means, with the gap between
      // them exactly where the resting was supposed to go.
      //
      // `wantsForwardShelter` is the mechanism that already existed for this — the watchdog
      // sets it when it rescues a stalled driver — and it takes a spot FORWARD on the route
      // and mends there. Pausing for a wall is the same request, so it makes the same one.
      if (!abandon) this.wantsForwardShelter = 'the journey paused for a wall';
      return this.frozenUntil > Date.now() ? HANDLED : CONTINUE;
    };

    // ---- 1. THE WEAPON IS GONE.
    //
    // Ahead of the damage tests for the same reason `passArm` is ahead of them in the
    // ordinary ladder: being unarmed is WHY the fight is going badly. A character that
    // shattered its weapon two rooms ago is walking the rest of the road unable to answer
    // anything that finds it, and no amount of continuing helps that.
    if (this.travelAllows('arm') && !this.armed())
      return takeBack('unarmed', 'the weapon is gone, and walking on with an empty hand is ' +
                                 'how the next room becomes the last one');

    // What is close enough to be swinging at us. Same test as passFleeAndRest's `near`,
    // and PLAYERS ARE DELIBERATELY EXCLUDED for the same reason: every character is
    // ATTACKABLE, and the fleet walks the same roads, so a fleetmate on the same square
    // would otherwise read as a monster. See the long note there.
    const me = c?.self;
    const near = me && c?.room ? [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= 2) : [];

    // WHAT IS WORTH ABANDONING A JOURNEY FOR, AND MONSTERS ARE NOT IT BY DEFAULT.
    //
    // Being attacked on the road is the ordinary condition of travel in this game, not an
    // emergency: there is no safe route, and a trip that turns back every time something
    // bites is a trip that never arrives — it just accumulates the same damage in both
    // directions. The way out of an attack during travel is THROUGH, and where it is not,
    // the rung above this one takes a wall.
    //
    // A PLAYER IS A DIFFERENT ANIMAL. A wall stops monsters and says nothing whatever about
    // a person, who can walk to the same square, swing first, and take the pack — so dying
    // to the troll costs the walk back and dying to the player costs everything carried.
    // That asymmetry is already why `travel_hold_pvp` refuses a rest with people about, and
    // it is the same argument here.
    //
    //   'players'  (default) only a stranger ends a journey; monsters are expected
    //   'anything'           the behaviour before this — any attacker ends it
    //   'never'              nothing does; the road is walked whatever happens
    //
    // `party.isFleetmate` tells one of ours from a stranger, and a keeper that has not had a
    // pass yet is absent from that roster — so this can briefly call a fleetmate a stranger
    // after a restart. Being wrong that way ends a journey that could have continued, which
    // is the cheap direction.
    const fleeFrom = this.policy.travelFleeFrom ?? 'players';
    const strangers = me && c?.room ? [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.PLAYER) && (o.flags & OF.ATTACKABLE) &&
      !party.isFleetmate(c.rsc?.get(o.nameRsc)) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= 2) : [];
    const worthEnding = fleeFrom === 'never' ? []
                      : fleeFrom === 'anything' ? [...near, ...strangers]
                      : strangers;

    // ---- 2. A WALL IS NEARER THAN THE NEXT ROOM.
    //
    // THE RUNG THAT WAS MISSING, AND THE ROOM THAT PROVED IT. Everything below this fires
    // LATE by construction: the flee line, two hits from death, an emptying bar. That is the
    // right shape when the only choices are run or stand — but it is the wrong shape when
    // there is a square nearby that a creature CANNOT PATH TO, because reaching one ends the
    // fight rather than gambling on it.
    //
    // Measured on the arena fleet, one clean window: eleven deaths, SEVEN of them in the
    // Cragged Mountains, at 1/45, 2/22, 4/49, 5/49, 5/52 and 2/53 health — and not one
    // refuge taken in that room. The refuge question was only ever asked at a hop BOUNDARY
    // (see TRAVEL_GUARD_CLOCK), and 578 is 2,450 squares: a body is found, fought and killed
    // deep inside it without ever reaching a boundary to be asked at.
    //
    // So it is asked here too, and it is asked EARLIER than the emergencies — at
    // `travel_hold_below` rather than at the flee line — because a wall is only worth
    // detouring to while there is still enough health to walk to it. It costs nothing when
    // there is no wall: `nearestSafeSpot` answers null and the ladder carries on to the
    // rungs that were already here.
    //
    // Handing back rather than steering from here is deliberate and is the same rule the
    // rungs around it obey: mid-hop the mover is walking, and only one thing may ever drive
    // a body. The ordinary ladder takes the wall on this same pass, with real numbers.
    // ITS OWN THRESHOLD, AND HIGH, BECAUSE THE ARITHMETIC IS TIGHT. The deaths this rung
    // exists for happened at 1, 2 and 5 health, by which point no detour is walkable. And a
    // full bar does not last: measured over 237 deaths, health leaves at a MEDIAN OF 4.7 A
    // SECOND once something starts on a character, and the average maximum on this fleet is
    // 45 — nine and a half seconds from full to dead. Sixty per cent bought 5.7 seconds to
    // notice, stop, replan and walk; eighty buys nine, which is the difference between a
    // detour and an epitaph.
    //
    // It is separate from `travel_hold_below` (0.75) rather than sharing it because the two
    // stops cost different things. At a hop boundary the journey is already paused and a rest
    // is nearly free, so it is worth taking early. Mid-hop the mover has to be stopped and
    // the hop replanned, so it waits a little longer — but nothing like as long as dying.
    //
    // AND IT HAD TO MOVE ABOVE PLAYING DEAD, BECAUSE BELOW IT IT WAS DEAD CODE. `play_dead`
    // fires at `worstHit * 2`, and for a fleet whose maxima run 22 to 56 that is 67% to 73%
    // of the bar -- ABOVE this rung's 60%, so it always won and the wall was never reached.
    // Measured over 26 minutes: fifteen journeys taken back, every one of them "two hits
    // from death", against six refuges and all six of those in towns where nothing was
    // attacking. Fourteen deaths.
    //
    // So it is asked first, and it is asked at its own threshold OR wherever playing dead
    // would have fired, whichever comes sooner. That second clause is the point: playing
    // dead is a gamble on what the room does next, and a wall is geometry. Where both are
    // available the wall is strictly better, and where there is no wall this falls straight
    // through to the gamble, which is what it is for.
    // The same fraction the ordinary ladder uses, borrowed rather than reinvented — see
    // `doomedAt` there. At 0.4 it now sits BELOW this rung's 0.6, so the wall is reached
    // first on the way down and this clause is a backstop rather than the usual trigger.
    const wouldPlayDead = near.length && hp !== null
      && hp < (this.policy.doomedInOpenBelow ?? 0.3);
    // A WALL MUST NOT BE ABLE TO STOP A JOURNEY FOR EVER, AND IT WAS.
    //
    // Measured in room 587: the body walked the first six squares of a 65-square baked
    // rail, was taken back for a wall, was returned to the entry anchor, and started the
    // line again. THIRTY times in one leg — the trace shows moves sent from exactly seven
    // squares, thirty each, with six refusals in two hundred and thirty attempts. Nothing
    // was blocked. It was being interrupted.
    //
    // The cause is this rung agreeing with itself. `travelShelterBelow` returns 1 — ANY
    // damage — when the zone outranks the character, which the Twisted Wood does for every
    // character this fleet has. So a scratch cancels the crossing, the character rests, and
    // the next scratch cancels it again. A room that cannot be crossed without being bitten
    // cannot be crossed at all, and this fleet's road runs through two of them.
    //
    // So the wall keeps absolute priority while the character is in REAL trouble — below
    // the flee line, or inside two hits of death — and is bounded otherwise. Above the flee
    // line, a character that has already taken shelter twice in this room has had the
    // benefit; a third detour is not survival, it is a loop. `travel_shelter_per_room` is
    // the knob and the counter resets on entering a new room, because the argument is about
    // one crossing rather than one journey.
    const shelterRoom = this.s.world?.room?.num ?? null;
    if (this.shelterStops?.room !== shelterRoom) this.shelterStops = { room: shelterRoom, taken: 0 };
    // WHAT "REAL TROUBLE" MEANS, NOW THAT THE FLEE LINE NO LONGER MEANS RUN.
    //
    // This bypass — shelter without limit, budget or no budget — used to key on the flee
    // line. That was coherent while the flee line was the point at which a character
    // abandoned what it was doing; it is not coherent now that only a person makes a
    // character run. A threshold that no longer triggers flight was still granting unlimited
    // interruptions, and in a zone that outranks the character `travelShelterBelow` returns
    // 1 — ANY damage — so the two together made a crossing impossible to even begin:
    //
    //   586  cancelled at 0 of 40 by a travel guard rung taking the character back
    //
    // Step zero, before the first square. The Twisted Wood cannot be crossed without being
    // bitten, so the bypass was permanently open and the budget never applied to anything.
    //
    // The doomed line is the one that still means an emergency: inside two of the biggest
    // hits this game lands, which is where a wall is worth any number of interruptions. Above
    // it the budget applies and the character crosses the room it was sent to cross.
    // `travel_shelter_unlimited_below` restores the old behaviour for anyone who wants it.
    const emergencyBelow = this.policy.travelShelterUnlimitedBelow
      ?? (this.policy.doomedInOpenBelow ?? 0.3);
    const inRealTrouble = wouldPlayDead || (hp !== null && hp < emergencyBelow);
    // THE LOOP GUARD, AND NOW THE ONLY ONE. With the trigger at any damage this is what
    // stops a hostile room becoming stop-and-restart for ever — and it is raised from 2
    // because each stop now returns the character to FULL health behind real geometry
    // rather than buying nothing on a patch of grass. Two stops was a bound on a thing that
    // did not work; four is a bound on a thing that does.
    const shelterBudget = this.policy.travelShelterPerRoom ?? 4;
    const shelterSpent = !inRealTrouble && this.shelterStops.taken >= shelterBudget;
    // SAID ONCE PER ROOM, because a decision that does nothing and says nothing is how a
    // switched-off faculty hides. The character is hurt, there is something on it, and it is
    // walking on anyway — that is worth a line even though it is the right answer.
    if (!wouldPlayDead && shelterSpent && this.travelAllows('safe_spot') && hp !== null
        && near.length && hp < this.travelShelterBelow() && !this.shelterStops.noted) {
      this.shelterStops.noted = true;
      this.note('walking on — the wall for this is at the end of the hop', {
        room: shelterRoom, health: Math.round(hp * 100) + '%',
        adjacent: near.length,
        doomed_below: emergencyBelow,
        shelter_stops_taken: this.shelterStops.taken, budget: shelterBudget,
        why: 'this room\'s mid-hop shelter budget is spent. The hop boundary can still ' +
             'PAUSE rather than cancel, and two hits from death stops us here regardless ' +
             'of any budget.',
      });
    }
    // MID-HOP THIS RUNG IS RETIRED ENTIRELY. There is no mid-hop shelter trigger.
    //
    // This line used to end "AND `wouldPlayDead` IS ALL THAT IS LEFT OF IT", which was not
    // true of the code underneath it — see the correction below, where that leftover was
    // deleted. The dying-mid-hop case belongs to the `flee` arm, which fires earlier and
    // plays dead; nothing here shelters mid-hop.
    //
    // The only thing a mid-hop trigger can do is CANCEL the crossing: the mover has the
    // body, and the keeper cannot walk to a wall without taking the body off the line
    // first. That is affordable for a rung that fires rarely. This one fires on ANY damage
    // in a zone that outranks the character — `travelShelterBelow` returns 1 there — which
    // in the Twisted Wood is continuous, so the crossing was torn down at step 0 of 40 and
    // rebuilt and torn down again until the leg ran out of clock.
    //
    // A shelter that prevents arrival is not shelter. The wall now belongs to the HOP
    // BOUNDARY, where nothing is contended: the mover is between rooms, the keeper can sit
    // the character down without fighting it for the body, and the journey PAUSES instead
    // of ending. See TRAVEL_GUARD_CLOCK.
    //
    // WHAT STAYS, AND WHERE IT ACTUALLY LIVES. Two hits from death is not "a bad room", it is
    // about to be a death, and waiting for a boundary 2,450 squares away is how the Cragged
    // Mountains killed seven of eleven. That case is still answered — by the `flee` arm below,
    // not by a rung here.
    //
    // CORRECTED 2026-09-10. This paragraph used to end "so the rung still fires for
    // `wouldPlayDead` — and only for that", above a `const shelterNow = wouldPlayDead || ...`
    // that NOTHING IN THE FILE READ. One occurrence, this assignment, in both this tree and
    // the prod deploy. The rung fired for nothing, and the comment said it fired for something.
    //
    // Deleted rather than re-wired, because re-wiring it would be redundant: `wouldPlayDead`
    // is `near.length && hp < doomedInOpenBelow (0.3)`, and the `flee` arm below triggers at
    // `hp < safety().fleeAt` — around 0.68, more than twice that — needs only
    // `(worthEnding.length || near.length)`, which `near.length` satisfies, and calls
    // `playDead()` unconditionally. That is the same action at a threshold reached strictly
    // earlier on the way down, so every state this expression could have caught is already
    // caught. The other half was the mid-hop trigger retired immediately above.
    //
    // The cost of leaving it was never to the fleet, it was to readers: an agent reviewing
    // these deaths read the old comment, believed a degraded mid-hop safety net existed, and
    // reported a defect that was not there. A dead variable with a live-sounding comment is a
    // claim the next person has to disprove.
    // NO ADJACENCY REQUIREMENT. BEING HURT ON A ROAD IS THE WHOLE CONDITION.
    //
    // This asked for something within melee reach AT THE INSTANT OF THE PASS, and that is
    // why a character shelters once and then never again for the rest of a journey. A
    // traveller gets hit and keeps walking; by the next sample the thing that hit it is
    // three squares back and `inReachOfUs()` is empty. The damage is real, the health is
    // gone, and the rung that would answer sees an empty room.
    //
    // Measured across a whole run: ZERO `travel_paused_for_wall` events for two characters
    // who between them lost thirty-eight health and both died. The one shelter that did
    // happen came from the ordinary ladder's rest rung, not from this one at all.
    //
    // Bbbb is the shape: rested to full in 586, resumed, then crossed 587, 597 and 598 in a
    // hundred and seven seconds, arriving in the Cragged Mountains at 8 of 20 having never
    // been offered a wall on the way. It died there in fifteen seconds.
    //
    // THIS REPOSITORY ALREADY MADE THIS ARGUMENT, about the watchdog rescue, and it is the
    // same one: "the trigger is DAMAGE, and it does not care whether the body is moving. A
    // character walking a road while something eats it is in exactly as much trouble as one
    // standing in the same place while something eats it, and the walking one is harder to
    // see." A stillness requirement missed it; an adjacency requirement misses it the same
    // way and for the same reason.
    //
    // What bounds it is the per-room budget, which is where the rationing belongs — not a
    // condition that happens to be false most of the time something is wrong.
    // ============ ONLY DEATH OR A PLAYER STOPS A JOURNEY. NOTHING ELSE. ============
    //
    // The operator's rule, stated repeatedly, and it is already written at the top of
    // m59-resumetravel-test: A JOURNEY IS NEVER ABANDONED UNLESS A PLAYER IS ATTACKING.
    // Every mid-hop health threshold this file has carried is a violation of it, and I have
    // now tuned that number four times in one day — 1, then 0.8, then 1 again, then 0.5 —
    // each time treating "what is the right level to stop at" as the question. The question
    // was whether to stop at all.
    //
    // WHAT THE RECORD SAYS. Every journey of one evening:
    //
    //     legs 2, planned_legs 7      hp 33 -> 29
    //     legs 2, planned_legs 7      hp 20 -> 15
    //
    // two legs of seven, four health down, cancelled by THIS RUNG, and then the character
    // stood idle in a 750-danger room until something killed it. Measured on one of them:
    // thirty health in eight seconds, stationary. Twenty-hitpoint mules cross to Castle
    // Victoria every day by never doing that.
    //
    // A WALL IS STILL TAKEN — AS A WAYPOINT, NOT AS AN ENDING. `shelterPolicy` hands the
    // walker a fuel-stop contract for the length of the journey and `walkPivots` splices the
    // next refuge into the route without stopping: one more waypoint, no replan, no handing
    // the character back. That is the whole of "run refuge to refuge and skip the stops you
    // do not need", and it needs nothing from this rung.
    //
    // SO WHAT IS LEFT MID-HOP IS `flee`, WHICH IS PLAYERS-ONLY. A person can follow you to a
    // wall, swing first and take the pack, so distance is the answer to a person and only to
    // a person. Death ends a journey by definition. Those are the two.


    // ---- 3. INSIDE TWO HITS OF DEATH, AND NO WALL TO PUT AT OUR BACK.
    //
    // The ordinary ladder's own test, borrowed rather than reinvented: below two of the
    // biggest hits this game lands, with something adjacent. Out on a road there is no
    // safe spot to make the sheltered case apply, so this is always the open-ground
    // version. `worstHit` is computed by the wall rung above, which asks the same
    // question first.
    //
    // WHAT THE LADDER DOES WITH IT CHANGED ON 2026-08-21, and this take-back is still
    // right afterwards. It used to hand over to a choice between running for a town and
    // PLAYING DEAD; playing dead off a proven wall is refused unless a PLAYER is here
    // (restored 2026-09-18, see playDead), because against monsters in the
    // open it recovers vigor and never health and three characters were measured freezing
    // at 4, 10 and 13 health in a fifteen-monster room and dying there. So the choice this
    // hands to is now between a town trip and a withdrawal — and both of them MOVE, which
    // is the whole reason ending the journey here is not the same as standing still.
    // If that ever stops being true, this rung becomes a way of stopping a character in a
    // corridor, which is what kills them.
    // IT STILL TAKES THE CHARACTER BACK. WHAT CHANGED IS WHAT THAT HANDS OVER TO.
    //
    // This rung used to be gated on `play_dead` and existed so the ordinary ladder could
    // freeze. Freezing off a proven safe spot is refused unless a player is here (see
    // playDead; restored 2026-09-18 after the open freeze was measured to buy nothing), so
    // the hand-over is a town trip or a withdrawal — and both of them MOVE, which is the
    // whole reason ending the journey here is not the same as standing still.
    //
    // I NEARLY DELETED THIS RUNG, AND THE SUITE CAUGHT IT. The argument for deleting it was
    // that rung 4 below takes the character back whenever `hp < fleeAt`, so anything this
    // caught that one would catch too. THAT IS FALSE, and the reason is worth keeping:
    // rung 4 tests `worthEnding`, which under the default `travel_flee_from: 'players'` is
    // the STRANGERS list — players only. A character two hits from death with six monsters
    // on it and no player in sight has `worthEnding.length === 0` and gets nothing from
    // rung 4. That is Cccc's exact situation, the case this whole suite is built from.
    //
    // So the gate moves from `play_dead` to `flee`: it is a flee decision taken at a lower
    // threshold than the flee line, for the case where the flee line cannot see the danger
    // because the danger is not a person.
    // `two hits from death` USED TO END THE JOURNEY HERE, AND IT NO LONGER DOES.
    //
    // The operator's rule: death or a player are the only two reasons to stop travelling.
    // Being nearly killed by a monster is neither, and the argument that it is only holds
    // if stopping helps. It does not — it is the thing that kills:
    //
    //     act=idle | hp 3/33 | for 8s | walked 5.4 | net 2.8 | shelter_after None | rooms [598]
    //
    // Thirty health in eight seconds while STATIONARY. A character two hits from death that
    // keeps walking outpaces most of what is chasing it; one that stops is surrounded by all
    // of it. The rung's own comment argued that ending the journey was safe because what it
    // handed over to — a town trip or a withdrawal — would MOVE. In practice the hand-over
    // left the character idle, and the record above is what idle costs.
    //
    // The wall it wanted is still taken, as a WAYPOINT: `shelterPolicy` gives the walker a
    // fuel stop for the whole journey and `walkPivots` splices the next refuge into the
    // route without stopping. That is shelter that does not cost the crossing.
    //
    // The one below this — `dying faster than this journey can finish` — survives, because
    // it is gated on `worthEnding`, which under the default `travel_flee_from: 'players'` is
    // a PERSON. That is the PVP half of the rule and it stays exactly as it was.

    // ---- 4. BELOW THE LINE THIS KEEPER FLEES AT, WITH SOMETHING ON US.
    //
    // THIS IS THE ONE THAT WOULD HAVE SAVED CCCC, and it is worth being exact about why
    // it is not the rescue that already existed. He entered West Merchant Way at 10 of 37
    // — 27%, against a flee threshold of 70% — with six things in the room, and walked
    // around at that fraction for twenty-two seconds. The old rescue could not fire
    // because it also demanded that he be STATIONARY for four seconds, and a two-square
    // shuffle against a wall resets that timer on every sample.
    //
    // Movement is not consulted here at all. Below the flee line with something adjacent
    // is a fight the keeper has already decided it does not take, and a journey is not a
    // reason to take it.
    // AND IT COULD NOT FIRE FOR A MONSTER, WHICH IS WHY IT SAVED NOBODY TONIGHT.
    //
    // The gate was `worthEnding.length` -- the STRANGERS list under the default
    // `travel_flee_from: 'players'` -- and the comment that used to sit at the bottom of this
    // rung said so proudly: "this rung cannot fire for monsters unless somebody sets 'anything'
    // -- and if they have, they have asked for the old behaviour."
    //
    // MEASURED AFTER THE FIRST FIX, WHICH IS THE POINT. I removed the same gate from rung 5
    // (the damage rate) in deploy-2026-09-10-11 and two characters died in transit within ten
    // minutes of the restart anyway, with the keepers demonstrably running the new code
    // (broker 02:57:44, keepers 02:57:46):
    //
    //   Floyd  room 597, spider, `doing: travelling`, trail 1/57 -> 1/57 -> 1/57 -> 2/57
    //          against a flee threshold of 0.667. He was at ONE HEALTH for the whole window.
    //   Pepe   room 70, zombie, `doing: travelling`, trail 4/49 -> 1/49 -> 1/49 -> 2/49
    //          against a flee threshold of 0.694.
    //
    // Rung 5 could not save either, and not because of its gate: `damageRate` is a DELTA across
    // the pulse ring, so a character that has already collapsed and is sitting at 1 health has
    // a rate of ZERO and a `timeToDeath` of null. The rate rung fires during a descent and is
    // blind at the floor. Absolute health is the signal at the floor, and that is this rung.
    //
    // So: any threat, not just a person. A journey is not a reason to stand and take a fight
    // the keeper has already decided it does not take, and which side of the monster/player
    // line the attacker falls on has nothing to do with whether the bar is emptying.
    //
    // AND THE ANSWER IS THE LOGOFF FIRST. Operator, 2026-09-10: "There is truly only one way:
    // The play_dead." Taking the journey back leaves the body standing in the room that is
    // killing it; the logoff stops the attack outright and costs a reconnect.
    //
    // Movement is still not consulted here at all -- that is the Cccc lesson (10 of 37 health,
    // six things in the room, twenty-two seconds of a two-square shuffle that reset every
    // stillness timer it met).
    // TWO DIFFERENT DECISIONS, AND CONFLATING THEM IS WHAT I GOT WRONG FIRST.
    //
    //   (a) SHOULD THE ATTACK BE STOPPED? Yes, always, below the flee line -- and the only
    //       thing that stops one outright is the logoff. That does not care whether a monster
    //       or a person is swinging.
    //   (b) SHOULD THE JOURNEY BE TAKEN AWAY? That is the road doctrine and it is still a
    //       PERSON-ONLY question. A character that keeps walking outpaces most of what is
    //       chasing it; one that stops is surrounded by all of it. CLAUDE.md's correction of
    //       2026-08-21 draws the line exactly here: "Walking through is still the answer to
    //       being HIT; it is not the answer to being below the flee line."
    //
    // My first version answered (a) by doing (b) -- freezing AND abandoning for monsters -- and
    // seven assertions in m59-travelling-test caught it, every one of them a record of a death
    // that came from stopping in a crowd. They were right and I was reinstating the failure
    // they were written from. The logoff needs no cancellation to work: it stops the attack
    // where the body stands, and the journey is still there when the reconnect lands.
    if (this.travelAllows('flee') && hp !== null && hp < this.safety().fleeAt
        && (worthEnding.length || near.length)) {
      const byPlayer = worthEnding.length > 0;
      // (a) ALWAYS. This is the rung Floyd and Pepe needed after deploy-11: both were
      // travelling far below their flee thresholds (1/57 at 0.667, 4/49 at 0.694) with a
      // monster on them, and rung 5 could not help because `damageRate` is a delta across the
      // pulse ring -- a body already sitting at 1 health has a rate of ZERO. The rate rung
      // fires during a collapse; absolute health is the signal at the floor.
      const froze = await this.playDead(
        'below the flee line at ' + Math.round(hp * 100) + '% while travelling, with ' +
        (byPlayer ? worthEnding.length + ' stranger(s) on us' : near.length + ' monster(s) on us')
      ).catch(() => false);

      // (b) ONLY FOR A PERSON. Unchanged, deliberately, and the detail says which happened so
      // a postmortem can tell a freeze-and-carry-on from a freeze-and-stop.
      if (byPlayer)
        return takeBack('below the flee line with someone adjacent',
                        'the keeper flees at this fraction when it is driving, and a journey ' +
                        'is not a reason to stand and take it',
                        { adjacent: worthEnding.length, monsters_near: near.length,
                          players_near: strangers.length, flee_from: fleeFrom,
                          logged_off: froze },
                        { abandon: true });

      if (froze) {
        return takeBack('logged off below the flee line',
          'movement would wake the room again; keep the destination for after recovery',
          { monsters_near: near.length, logged_off: true });
      }
      // Could not freeze (already frozen here and not yet acted). Fall through to rung 5 and
      // the rest of the guard rather than inventing a third answer.
    }
    // ---- 5. LOSING HEALTH FAST ENOUGH THAT THE ROAD WILL NOT END FIRST.
    //
    // The rate, not the position. A character being eaten while it walks is in exactly as
    // much trouble as one being eaten while it stands, and it is harder to see — every
    // stall instrument in this file reads it as healthy. `damageRate` reads the position
    // pulse ring, which is on the CHARACTER's clock rather than the keeper's, so it keeps
    // measuring through a travel await that nothing else can see into.
    // Gated the same way: an emptying bar with only monsters on it is the road doing what
    // the road does, and the wall rung above is the answer to it. A stranger emptying it is
    // somebody choosing to, which is worth ending a journey over.
    // A MONSTER EMPTYING THE BAR IS NOT "THE ROAD DOING WHAT THE ROAD DOES". IT IS A DEATH.
    //
    // This rung had the right instrument and the wrong gate. `worthEnding` is the strangers
    // list, and under the default `travel_flee_from: 'players'` it is EMPTY for monsters -- so
    // the rate rescue only ever fired for a PERSON emptying the bar. The comment that used to
    // sit here said it out loud: "A monster doing the same is the road doing what the road does,
    // and the wall rung is the answer to it."
    //
    // IT IS NOT THE ANSWER TO IT. Four deaths on 2026-09-10, every one a monster and every one
    // in transit, with this rung declining each time:
    //
    //   Floyd     room 40, The Throne Room of Victoria Castle. Ten TUSKED SKELETONS, level 100
    //             against an engagement ceiling of 87. 112 seconds without moving or swinging,
    //             41 -> 1 health, health_per_second -0.52, flee threshold 0.689 and his trail
    //             sat at 40-45 of 58 for a long stretch first. Flee had every opportunity.
    //   Gonzo     Ukgoth 599, `inert -- travelling to 39`. 36 -> 1 in FORTY-FIVE SECONDS, never
    //             swinging, never fleeing -- and `ms_since_moved` read 0 the whole way, because
    //             he was being WALKED while he was killed. Every stillness instrument in this
    //             file reads that as healthy, which is why the rate is the only signal.
    //   Camilla   Ukgoth 599, 34 minutes wedged, 20 -> 3.
    //   Rizzo     Ukgoth 599, 83 seconds after Camilla, 52 -> 7.
    //
    // So the gate is gone. The instrument was always right -- `damageRate` reads the position
    // pulse ring on the CHARACTER's clock, so it keeps measuring through a travel await nothing
    // else can see into -- and the arithmetic does not care what is holding the sword.
    //
    // AND THE ANSWER IS THE LOGOFF, not merely ending the journey. Operator, 2026-09-10:
    // "implement fall throughs to the singular correct behavior... the preexisting play_dead()
    // -- it is universally the best survival mechanism available." Taking the journey back leaves
    // the body standing in the room that is killing it, one pass richer and no safer; the logoff
    // stops the attack outright. So: freeze first, THEN hand the journey back so the character
    // is not walked straight back into it.
    if (this.travelAllows('fight_back')) {
      const ttl = this.timeToDeath();
      if (ttl !== null && ttl <= TRAVEL_RESCUE_TTL_MS) {
        const rate = Math.round(this.damageRate() * 100) / 100;
        const byPlayer = fleeFrom === 'anything' || worthEnding.length > 0;
        // The freeze is attempted before the take-back and its outcome is reported, because
        // "we decided to save it" and "we saved it" have looked identical in this file before
        // and that is what issue #51 was.
        const froze = await this.playDead(
          'dying at ' + rate + ' health/s while travelling, ' +
          Math.round(ttl / 100) / 10 + 's left'
        ).catch(() => false);
        return takeBack('dying faster than this journey can finish',
                        'health is falling at a rate that empties the bar inside ' +
                        Math.round(TRAVEL_RESCUE_TTL_MS / 1000) + ' seconds. Whether the body ' +
                        'is moving is not the question — the arithmetic is, and a monster ' +
                        'emptying it counts',
                        { seconds_left: Math.round(ttl / 100) / 10,
                          losing_per_s: rate,
                          adjacent: near.length,
                          logged_off: froze,
                          emptied_by: byPlayer ? 'a player' : 'monsters',
                          note: froze ? 'logged off first, so the attack has already stopped'
                                      : 'could not log off (already frozen here and not yet ' +
                                        'acted); the journey is still ended so the ladder below ' +
                                        'can take a wall or rest',
                        },
                        { abandon: byPlayer });
      }
    }

    // ---- 6. NOTHING WORTH STOPPING FOR. The journey keeps the character.
    //
    // NOT A STALL, for the same reason inert is not: the supervisor restarts keepers that
    // report no progress, and this one is doing what it was asked to do.
    this.progress('travelling — ' + (held.why ?? 'a journey is steering'));
    return HANDLED;
  }
  // @end 1
}
