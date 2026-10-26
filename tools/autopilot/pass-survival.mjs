// THE SURVIVAL PASS: flee and rest.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 1 methods: passFleeAndRest
import { recordEvent } from '../m59-ledger.mjs';
import { OF } from '../m59-parse.mjs';
import { continuingProvenRefugeLeg } from '../m59-refuge-leg.mjs';
import * as skills from '../m59-skills.mjs';
import { AILING_SHELTER_BELOW, CONTINUE, HANDLED, ORDINARY_VIGOR_FLOOR, REST_VIGOR_CAP, STRATEGIES, TRAVEL_VIGOR_FLOOR, belowRoomRetreatHealth, farmVigorWorkReady, scriptedWalkDefersVigorRest, vigorOf, vigorPct } from '../m59-autopilot.mjs';

export class PassSurvivalPart {
  // @part 1

  // ── passFleeAndRest: extracted from pass() ────────────────────────────────
  async passFleeAndRest(ctx) {
    if(this.operatorSurvivalStandDown())return CONTINUE;
    const { s, c, room, v, hp } = ctx;
    if(continuingProvenRefugeLeg(s)){
      this.note('continuing the proved route to cover', {refuge:s.provenRefugeLeg.goal,why:'recent confirmed forward progress; recovery at its end'});
      return HANDLED;
    }
    if (await this.farmBuffPass().catch(() => false)) return HANDLED;
    // 2. In danger. "Something attackable is adjacent and we are hurt" is the only
    //    threat signal available — the protocol does not say who is targeting us.
    //
    //    OTHER PLAYERS ARE NOT THREATS, and leaving them in this list is not a
    //    conservative choice, it is a catastrophic one. Every character is ATTACKABLE,
    //    so a friendly bot standing next to you is indistinguishable from a monster
    //    here — and they do not merely stand next to each other, they stack on the
    //    identical square, because they all walk to the same inn by the same route.
    //    Isolde sat at 4 of 25 health in the Limping Toad with Aurelia, Malig and
    //    Yorick all on square (8,15) beside her, concluded she was about to be killed
    //    by three of her own fleet, and panic-logged-off in a loop that could never
    //    end: freezing is what stops health coming back, so she woke at 4 health,
    //    counted the same three, and froze again. Thirty passes, no healing, no
    //    stall reported, nothing wrong with any single decision.
    //
    //    The trade is real and worth stating: a genuinely hostile player will now not
    //    register here. That costs us a fight we were losing anyway; the other way
    //    round costs a character that never recovers.
    const me = c.self;
    const near = me ? [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= 2) : [];
    // EVERYTHING IN THE ROOM THAT CAN SWING, not just what is adjacent right now.
    // `near` looks two squares out, which is the right question for "am I in a fight"
    // and the WRONG one for "is this a place to sit down": a room with four monsters
    // in it and none of them currently beside us read as safe to rest in, and the
    // first one to wander over got a free run at a character sitting still and not
    // looking. Most of this fleet's deaths were logged as happening while resting.
    const hostiles = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));

    // WEDGED, HURT, AND SOMETHING IN REACH — BEFORE ANY RUNG THAT MOVES. Every rung
    // below answers being hurt with distance: run for a town, a route-adjacent spot,
    // "somewhere I can heal", the nearest exit. On a body that cannot move they are all
    // the same non-answer, repeated once a pass until the character dies, which is what
    // happened on square 18,18 of room 586 for eighteen minutes. See `tradeInPlaceIfWedged`.
    //
    // ESCAPE IS ASKED FIRST, AND TRADING IS WHAT HAPPENS WHEN IT CANNOT. Both rungs share a
    // premise — the body is not moving — but only one of them ever tested whether it could
    // move BACKWARDS. The way we came in is validated ground by construction, so it cannot
    // fail for the reason the forward walk is failing, and getting out of reach beats
    // swinging at something that is beating us. If it moves, the pass ends here and the next
    // one runs this whole ladder from a square that is not a trap.
    if (await this.escapeIfWedgedAndHurt({ near, v }).catch(() => false)) return HANDLED;
    if (await this.tradeInPlaceIfWedged({ near, v }).catch(() => false)) return HANDLED;

    // THERE ARE TWO DEFENSIVE MANOEUVRES IN A FIGHT AND THERE IS NO THIRD.
    // Operator's doctrine, 2026-09-06. See `defensiveAnswer`.
    if (await this.defensiveAnswer({ near, v }).catch(() => false)) return HANDLED;

    // ABOUT TO DIE. Below two hits of margin with something adjacent, withdrawing is
    // a gamble — the walk takes seconds during which it keeps swinging, and losing
    // that gamble costs a point of maximum health for ever. Logging off costs a
    // minute and cannot fail.
    //
    // UNLESS WE ARE IN A SPOT THAT WORKS, in which case none of that applies: we are
    // not about to die at all, we are merely hurt somewhere nothing can reach us. The
    // correct move is to stop swinging and sit down, which the rest branch below
    // does. Note the test is holdWorks() and not "we are standing in a corner" —
    // spending this on an unproven square is exactly the mistake it exists to
    // prevent, and an unproven square gets us the logoff, which is also how we
    // survive long enough to prove it.
    const worstHit = Math.min(30, Math.floor(((v.health?.max ?? 0) + 2) / 3));
    const sheltered = this.holdWorks();
    // THE TRIGGER IS DIFFERENT BEHIND A WALL, and it has to be, because the cost of a
    // false alarm is not zero. Two of the biggest hit the game can land works out at
    // about 70% of health for these characters — sensible in the open, absurd in a
    // spot, where the things that could hit us are on squares they cannot reach us
    // from and we choose which one we swing at. Cedric logged off three times in five
    // minutes at 71%, and each of those minutes was a minute of not healing and not
    // killing anything. Below a third of health it is still worth it.
    // AND IN THE OPEN IT IS A FRACTION NOW TOO, FOR THE SAME REASON. `worstHit * 2` is a
    // real arithmetic about this game's biggest single hit, and on this fleet it lands at
    // 67% to 73% of the bar — the note above already calls 70% absurd behind a wall, and it
    // is not much better in the open. Playing dead is a MONSTER-FIGHTING move, not a
    // response to being two thirds healthy: freezing at 70% spends a minute of not healing
    // and not killing anything, and it pre-empts every rung that would have done something
    // useful. Measured over 26 minutes of commuting: fifteen journeys taken back, every one
    // of them "two hits from death", six refuges, fourteen deaths.
    const doomedAt = Math.round((v.health?.max ?? 0) * (this.hold
      ? (this.policy.doomedInSpotBelow ?? 0.3)
      : (this.policy.doomedInOpenBelow ?? 0.3)));
    const doomed = hp !== null && near.length && v.health?.value != null &&
                   v.health.value <= doomedAt;
    // PLAY DEAD ONLY WHERE STANDING STILL IS ALREADY SAFE. FLEE EVERYWHERE ELSE.
    //
    // This was gated on `!sheltered` — it froze precisely when the character was NOT
    // behind a wall, which is the case where freezing helps least and costs most. A
    // freeze keeps the monsters off by not acting, and the same flag keeps HealthTimer
    // off with it, so the character comes back with the same health it went down with,
    // still standing in the open, still surrounded. That is why playDead needs its own
    // "refusing to freeze again — it is not helping" guard: the tactic was being used in
    // the one place it cannot work.
    //
    // In a safe spot it is a different move entirely. Nothing can reach the square, so
    // the character can turn in place — which sets PFLAG_MOVED_SINCE_ENTRY without giving
    // up the square — and heal back to full while the room mills about outside its reach.
    //
    // Out in the open with something adjacent, this used to say the only thing that changes the
    // situation is DISTANCE -- run for the nearest town, become combat-ready, come back -- and
    // that is the sentence the operator overturned on 2026-09-10. Distance is dozens of seconds
    // of being hit on the way out, through the rooms that were already killing us. The logoff is
    // immediate. Kept as a comment because the reasoning is the thing that changed, and the code
    // it describes is gone.
    // DOOMED: ONE ANSWER, NO BRANCH. Operator, 2026-09-10: fall through to the singular correct
    // behaviour, which is play_dead, and "log out/in if the danger is immediate".
    //
    // THIS USED TO BE A FORK and the fork is what the operator is removing. Sheltered, it played
    // dead; unsheltered, it ran for a town via townTripIfCornered, on the reasoning that "the only
    // thing that changes the situation is distance". That reasoning is wrong about this game: a
    // logoff makes the attacker stop AT ONCE, while a run for a town is dozens of seconds of
    // being hit on the way out, through the rooms that were already killing us. The fleet's own
    // corpus says which one the roads are: 274 of the deaths on record are trolls and 423 are in
    // Ukgoth alone, most of them on journeys.
    //
    // So there is no sheltered/unsheltered question here any more. Being cornered and nearly dead
    // is exactly the state the logoff is for, and having no wall does not make it worse -- it
    // makes it the only thing left. Camilla and Rizzo both died in this state with
    // `at_a_safe_wall: null`, which is the branch that used to send them running.
    //
    // The town trip is NOT deleted as a capability -- it is still the right errand for a
    // character that wants a smith, a teller or a bed. It is no longer a SURVIVAL strategy, and
    // `withdrawForFood` and the shop journeys keep it for what it is good at.
    if (doomed && this.policy.panicLogoff !== false) {
      // MOVE TO THE NEAREST WALL FIRST, THEN FREEZE. Operator, 2026-09-20: "the fix imho is to
      // move to the nearest safe spot and then play dead."
      //
      // THE HOLE THIS FILLS, and it is the one that was killing the fleet. `playDead` refuses
      // outright in the open against monsters (2026-09-18: "it will not save you from
      // monsters") and its own refusal note promises that "the ladder falls through to
      // something that MOVES". For a character that is TRAVELLING that is true — the travel
      // guard's shelter rungs move it. For a character standing in a farm room it was not true
      // of anything: this rung noted and fell through, the rest gate below refuses to rest in
      // the open, and no rung between here and the bottom of the ladder relocates the body.
      // `continueSurvivalDecision`, which the refusal's own comment says "drains this
      // replacement in the current pass", is never called anywhere in passFleeAndRest.
      //
      // Measured on prod over the 36 deaths of 2026-09-19/20: 36/36 died with
      // `was.moving: false`, 35/36 at or below a quarter of health (most at 1-7 of ~55),
      // 36/36 with `fled_in_time` under 0.25 against a recorded threshold of ~0.68, and
      // 36/36 having taken ZERO shelter in the room they died in while every one of them
      // carried a budget of 4. 19 of the 36 were `doing: "stalled"` — not travelling, so not
      // covered by the travel guard's emergency, which is the only place `doomedInOpenBelow`
      // had teeth.
      //
      // WHY THIS IS NOT THE TOWN RUN THE OPERATOR OVERTURNED ON 2026-09-10. That argument was
      // against DISTANCE as a survival strategy — "dozens of seconds of being hit on the way
      // out, through the rooms that were already killing us". The nearest safe wall is a few
      // squares inside the room we are already standing in, and it is the precondition the
      // freeze needs rather than an alternative to it. Nothing here runs for a town.
      //
      // AND IT DOES NOT RETURN. The spot is taken as a side effect and the pass carries on into
      // the playDead immediately below, because moving to the wall is only half the sequence —
      // the freeze, the turn and the heal are the other half, and a `return HANDLED` here would
      // strand the character at a wall it never used. That is the same correction the vigor rung
      // further down already carries in its own words.
      const wallBefore = this.currentRecoveryWall();
      if (!wallBefore && !this.spotRushedAt?.(room?.num)) {
        this.noteSpotRush(room?.num);
        const rushed = await this.takeSafeSpot(
          `doomed at ${v.health.value}/${v.health.max} with ${near.length} adjacent — the ` +
          `nearest wall first, because the freeze is refused in the open`,
          null, { source: 'doomed', recovery: true, nearestOnly: true })
          .catch(e => ({ took: false, why: e?.message ?? 'take_safe_spot threw' }));
        this.note(rushed?.took ? 'ran to the nearest wall before freezing'
                               : 'no wall to run to — freezing is all that is left', {
          health: v.health.value, adjacent: near.length,
          took: !!rushed?.took, why: rushed?.why ?? null,
          doomed_below: this.policy.doomedInOpenBelow ?? 0.3,
        });
      }
      const wall = this.wallHere();
      if (await this.playDead('at ' + v.health.value + ' health with ' + near.length +
                              ' adjacent' + (wall?.ok ? ', behind a wall the geometry confirms'
                                                      : ', in the open and out of better options'))
            .catch(() => false)) {
        // Every rung that reaches the logoff reports the same way, because a landed logoff IS an
        // action and a supervisor that cannot see it restarts the keeper mid-freeze.
        this.progress('logged off rather than dying');
        return HANDLED;
      }
      // playDead only answers no when we have ALREADY frozen at this spot and not yet acted --
      // freezing again would clear PFLAG_MOVED_SINCE_ENTRY and undo the regeneration the last
      // one bought. There is nothing better to reach for in that state, so say so and let the
      // stages below mend rather than inventing a third strategy here.
      this.note('cornered and cannot freeze again yet', {
        health: v.health.value, adjacent: near.length,
        wall_here: wall ? { attackers: wall.attackers, ok: wall.ok } : null,
        why: 'the logoff is the only thing that stops an attack outright, and it has just been ' +
             'used here; re-freezing would clear the moved-since-entry flag and stop the ' +
             'healing it bought',
      });
    }
    // AND THE SAME ANSWER, EARLIER: THERE IS NO FLEE RUNG AT ALL ANY MORE, ONLY THIS ONE.
    //
    // `flee_below` used to be a separate strategy and then, on 2026-09-10, was made identical
    // to play_dead at the operator's instruction: "make sure it's identical to play_dead, such
    // that there's no real point in having flee_below". It is now literally the same call the
    // doomed rung above makes, at a higher health, which is the whole of what the key selects:
    // a MOMENT, never a behaviour.
    //
    // WHY EARLIER IS BETTER, and it is the reason this rung is kept rather than folded away.
    // The logoff ends the attack outright, so reaching for it at 40% costs a freeze and saves
    // the 27 health between there and `doomed`. Camilla crossed this threshold at 40 of 60 and
    // was still alive for another thirty-one minutes of being hit; nothing reached for the one
    // verb that would have stopped it.
    //
    // no LESSER PATH LEFT: there is no note-and-stand, no withdrawal to open floor, and no run
    // for a town below this. If playDead declines -- which it now only does when we have just
    // frozen here and not yet acted -- the pass falls through to the resting stage below, which
    // is the one thing that is strictly better in that exact state because it actually heals.
    if (!doomed && this.policy.panicLogoff !== false) {
      const frac = v.health?.max ? v.health.value / v.health.max : null;
      const fleeAt = this.safety().fleeAt;
      if (frac !== null && fleeAt != null && frac < fleeAt && near.length) {
        const wall = this.wallHere();
        if (await this.playDead(`at ${Math.round(frac * 100)}% with ${near.length} adjacent` +
                                (wall?.ok ? ', behind a wall the geometry confirms'
                                          : ', in the open — the logoff is what stops the attack'))
              .catch(() => false)) {
          this.progress('logged off at the flee line rather than waiting it out');
          return HANDLED;
        }
      }
    }
    // SIT DOWN PROPERLY THE MOMENT WE ARRIVE SOMEWHERE SAFE.
    //
    // Not when the resting eventually starts — on entry. The walk to a clear patch of
    // floor is what sets PFLAG_MOVED_SINCE_ENTRY, and until it is set the character
    // recovers no health at all no matter how long it sits there. A bot that walks
    // into an inn and stops is not resting, it is waiting, and nothing in its own
    // journal will ever say so.
    //
    // It also un-stacks the pile. They all arrive on the same square by the same
    // route, and since every character is attackable, a heap of friendly bots is
    // indistinguishable from a mob to every bot in it.
    if (this.sanctuary(room) && this.settledIn !== room?.num &&
        ((hp !== null && hp < 0.95) || (vigorPct(v) ?? 1) < this.restVigorCeiling()))
      await this.settle('arrived somewhere safe and not at full strength').catch(() => {});
    // Leaving a room means the next safe one gets its own seat, and its own attempts.
    if (this.settledIn != null && room?.num !== this.settledIn && !this.sanctuary(room)) {
      this.settledIn = null;
      this.settleTries = 0;
    }

    // EAT BEFORE RESTING, WHEN RESTING CANNOT GET THERE. Past the danger rungs above, and ahead of
    // every wall and rest below: a floor above the rest cap (80) is reached only by eating, and
    // this stage used to take the pass first. Measured 2026-09-27 on the Ukgoth troll crew, floor
    // 160, bread in every pack. A hunter in the troll room was hit (fight-back answered), stepped
    // onto a wall at 78 as "hurt" (vigor under 40%), rested to 80, left the wall and fought again.
    // It never reached passFarm's provision, the only place that ate. The chalice alternate parked
    // at the station every pass (passErrand), so it never reached the idle branch's eatToFloor.
    // Both sat at 80 with food for hours; room 2 was 42% of fleet time that day, 98% of it dead,
    // and 64% of that was this. Fed by hand, a loaf was accepted at once (78 -> 97): the server
    // had room, the keeper never asked.
    //
    // eatToFloor is inert below a floor of 81, so the rest of the fleet behaves exactly as before.
    if (await this.eatToFloor(ctx) === 'ate') return HANDLED;

    // 3. Hurt but safe. Resting next to something hostile just feeds it — out in the
    //    open. In a proven safe spot "next to something hostile" is not a danger at
    //    all, and refusing to rest there is refusing the single largest advantage the
    //    game offers: a free heal to full, in the middle of a monster room, with
    //    three things standing next to us that cannot do anything about it.
    //
    //    THIS IS THE MULLIGAN. A fight going badly stops being a death and becomes a
    //    draw we can re-take at full health.
    const vig = vigorPct(v);
    // Sheltered, rest at whatever it takes to be fit to fight — never leave a gap
    // between "too hurt to start" and "hurt enough to rest", because a character
    // standing at a wall in that gap does neither and simply stops. engageAt is in
    // here for exactly that reason.
    // NEVER LEAVE A GAP BETWEEN "TOO HURT TO START" AND "HURT ENOUGH TO REST".
    //
    // This was applied to the sheltered case and not to the ordinary one, and the
    // ordinary one is where the whole fleet lives. restBelow is 0.6; engageAt is 0.9
    // for anything under thirty max health. A character at 64% is therefore too hurt
    // to pick a fight and not hurt enough to sit down, so it does NEITHER — and the
    // branch that declines the fight calls progress(), so it does not even register
    // as stalled. Cedric held that state at the Tos gate with full vigor, a wall
    // available and centipedes wandering past, reporting a healthy-looking journal
    // line every eight seconds.
    //
    // The fix is to say it once: whatever health it takes to be willing to fight is
    // the health worth resting to. Anything less is a keeper that waits for a number
    // nothing will ever move.
    // AFTER A DEATH, REST TO WHOLE BEFORE ANYTHING ELSE.
    //
    // recoverUntilWhole is set when we come out of the Underworld and stays set until
    // recovered() says otherwise. While it is set this does two things, and it needs
    // both: it refuses to fight, and it raises the resting bar to full. Raising the bar
    // alone would leave the character willing to take a fight it stumbled into on the
    // way to sit down; refusing to fight alone would leave it standing around at 11%
    // health because the ordinary restBelow of 0.7 was already satisfied.
    const recovering = !!this.recoverUntilWhole && !this.recovered();
    // AN EMPTY HAND IS NOT A FIGHT, IT IS A BEATING.
    //
    // The keeper sent unarmed characters out to hunt over and over: Scooter three times,
    // Rowlf, Gonzo, Animal. An unarmed character still swings, still reports fighting,
    // and punches for almost nothing while everything hits back — so nothing about it
    // reads as broken from outside, and the only reason it was ever caught is that a
    // human looked at the board.
    //
    // Weapons break constantly here and the pack usually has no spare, so this is not an
    // edge case. It is the steady state after a few hours. The answer is not to hunt
    // anyway: it is to stop, make one, and go back out — which costs a couple of minutes
    // and 15 mana, against a character that otherwise farms nothing until someone
    // notices. See armed() for why the server's own use list is the only acceptable
    // evidence here.
    const unarmed = !skills.isArmed(this.s.client);
    const wantsToFight = this.mode === 'farm' && !!this.policy.hunt && !recovering && !unarmed;
    const restAt = Math.max(
      this.policy.restBelow,
      sheltered ? this.policy.holdResumeAbove : 0,
      recovering ? 1 : 0,
      wantsToFight ? this.safety().engageAt : 0);
    // NEVER SIT DOWN FOR SOMETHING SITTING DOWN CANNOT FIX.
    //
    // restBelow is one threshold used for two vitals that recover by different means.
    // Resting restores vigor only as far as RestTimer's threshold — 80 of 200, which is
    // REST_VIGOR_CAP — and everything above that has to be eaten. Comparing vigor
    // against restBelow (0.6, i.e. 120) therefore asks for a level resting can never
    // reach, so the character was still "hurt" when it stood up and went straight back
    // down on the next pass. Hungry characters spent entire sessions in that loop.
    // For vigor the trigger is what resting can actually deliver; the shortfall above
    // it is a food problem, and eat()/loot runs are what answer it.
    // THE SAME CEILING AS THE RELEASE, FOR THE SAME REASON. `REST_VIGOR_CAP` is where the
    // game stops awarding rest vigor, so using it as the SIT-DOWN threshold asks a cursed
    // character to reach a bar its curse forbids: a worn ring of lethargy caps the wearer
    // at 60 of 200 against this 80, so `vig < vigorRestAt` is permanently true, `hurt` is
    // permanently true, and the branch below parks it at a recovery wall and RETURNS --
    // before `releaseRestedHold` further down can ever be reached. Fixing the release bar
    // alone left this one holding them, which is what prod showed: full health, zero
    // kills, held_s climbing past a thousand seconds.
    const vigorRestAt = Math.min(this.policy.restBelow, this.restVigorCeiling());
    // SPENT is not the same as hurt, and it is not negotiable. See ORDINARY_VIGOR_FLOOR: the
    // vigor trigger above makes a character want to rest, and wanting has been refused for an
    // hour at a time. This is the floor no ordinary activity crosses.
    // THE RAW VALUE, READ DIRECTLY. `vig` here is `vigorPct`, which divides by `scale_max`,
    // and reconstructing a raw number from a fraction means guessing which denominator was
    // used. The floor is written in the server's own unit, so read the server's own number.
    const rawVigor = this.s.client?.vitals?.()?.vigor?.value ?? null;
    const spent = Number.isFinite(rawVigor)
      && rawVigor < (this.policy.ordinaryVigorFloor ?? ORDINARY_VIGOR_FLOOR);
    const hurt = (hp !== null && hp < restAt) || ((vig !== null && vig < vigorRestAt) || spent)&&!scriptedWalkDefersVigorRest(this,v)&&!farmVigorWorkReady(this,v);
    if(hurt && this.currentRecoveryWall()) {
      await this.takeRecoverySpot('recovery needed while already at a safe wall');
      // TAKE THE SPOT AS A SIDE EFFECT AND LET THE PASS CARRY ON — the same correction the
      // branch below already carries, in its own words: "returned as soon as takeSafeSpot()
      // succeeded, and that deadlocked characters ... the branch fired again next pass".
      // This one kept the `return` and deadlocks in the identical way, except that it is
      // reached by a VIGOR deficit rather than a health one, which is what makes it
      // permanent: `hurt` is true because vigor is under the rest ceiling, and the only
      // thing that raises vigor is the REST GATE FURTHER DOWN THIS PASS. Returning here
      // parks the character at the wall and skips the rest that would clear the condition
      // that parked it.
      //
      // Measured on prod 2026-09-19, Camilla (t9) in room 589: full health 59/59, vigor
      // frozen at exactly 70 of 200 against a ceiling of 80, no ring of lethargy, held_s
      // 4,388 and climbing, `stuck: null` and `refusals: []` throughout — nothing anywhere
      // reported a problem. Six errand journeys were issued from that room in ninety
      // minutes, three to 113 and three to 39; every one "actually set out" and not one
      // arrived, because this branch fetched her back to the wall on the next pass. A
      // character that cannot leave a room is indistinguishable from a mover failure until
      // you notice the wall is being RE-taken rather than held.
      //
      // The rest gate below is unchanged and still refuses to rest in the open, which was
      // always the real requirement — so nothing that could not rest before can rest now.
      // It just gets asked.
      if (!this.hold) return HANDLED;
    }

    // RUN THE EXPERIMENT ON PURPOSE. A spot is only proved by standing in it without
    // swinging while something tries to kill us — and every other branch here is
    // gated on already having that proof, so without this the keeper can fight from
    // an untested corner forever and never find out whether it works.
    //
    // The window it needs is the same window resting needs, so testing costs nothing
    // beyond the pause. Bounded twice, because being wrong here means sitting still
    // while something eats us: only while we still have flee margin in hand, and for
    // one pass at a time, so observe() gets to adjudicate quickly either way.
    const testing = !sheltered && !!this.hold && !this.hold.failures &&
                    hp !== null && hp >= this.policy.fleeBelow;
    // RESTING IN A COMBAT ZONE IS SOMETHING YOU DO BEHIND A WALL OR NOT AT ALL.
    // Sheltered means the square is proven; testing means we are deliberately proving
    // it with margin in hand. Anything else, with anything hostile in the room, and the
    // answer is to go and get a wall first — not to sit down and find out.
    const combatZone = hostiles.length > 0;
    // Go and get a wall — but DO NOT CONSUME THE PASS DOING IT. The first version
    // returned as soon as takeSafeSpot() succeeded, and that deadlocked characters
    // outright: holding a square is not the same as the square being PROVEN, so
    // `sheltered` stayed false, the branch fired again next pass, and a character at
    // 100% health spent sixty consecutive passes taking a wall and doing nothing else.
    // It was `hurt` on VIGOR, not health, which is the state a keeper is in most of the
    // time. Take the spot as a side effect and let the pass carry on — the rest gate
    // below already refuses to rest in the open, which was the actual requirement.
    // AN EMPTY SPAWN ROOM IS NOT AN EMPTY ROOM — IT IS A ROOM BETWEEN SPAWNS.
    //
    // This asked for a wall only when something hostile was ALREADY standing there, so a
    // character that sat down during the gap between spawns rested in the open with
    // nothing to fetch it a wall. That is how Waldorf died, and its own journal reads the
    // sequence out: "hit while resting in the open — there was no wall at our back; this
    // is the case the safe spot exists for", then a reconnect to shed aggro, then "could
    // not reach the safe spot", then dead. The resting came first and the damage second.
    //
    // Across characters at or below the resting cap, resting ran 529 deaths per thousand
    // observations against 7.5 for holding a proven safe spot — the same act of sitting
    // still, differing only in whether a wall was at their back.
    //
    // sanctuary() is the existing test for "nothing huntable spawns here". This only
    // widens WHEN A WALL IS FETCHED; the rest gate below is untouched, so nothing that
    // could rest before is forbidden from resting now — it just sits down behind
    // something first.
    // A WALL THAT HAS FINISHED ITS WORK IS RELEASED HERE, NOT FOUR STAGES LATER.
    //
    // `releaseRestedHold` lives at the top of `resumeSuspendedJourney`, which lives in
    // `passFarm` — the LAST stage. A character holding a wall never reaches it, because this
    // stage handles the pass and returns first. So the release could only ever run for a
    // character that was not holding anything, which is the one case it is not for.
    //
    // Watched live, one sample every fifteen seconds:
    //
    //   holding a proven safe spot | 587 | hp 30/46 | suspended to 38  age  21s
    //   holding a proven safe spot | 587 | hp 46/46 | suspended to 38  age 106s
    //   holding a proven safe spot | 587 | hp 46/46 | suspended to 38  age 206s
    //
    // Everything worked: the watchdog kept the journey, the character took a proven wall, it
    // healed thirty to forty-six. Then it sat at FULL HEALTH for another hundred seconds
    // carrying a destination, with health at 100% and vigor at the resting cap — both release
    // conditions satisfied, and nothing asking.
    //
    // Called here so the wall is given up on the pass that finishes it. The release itself is
    // unchanged and still refuses a hurt character; all that changes is that it is asked.
    // ASKED FOR A FARMER TOO. `releaseRestedHold` computes `onARoad` and branches on it —
    // a farming floor of `holdResumeAbove ?? 0.9` against a travelling floor of 1, plus
    // farm-only refusals for a pending pull and for contact — so it was plainly written for
    // both. The `&& this.suspendedJourney` here made the farming half unreachable, which left
    // farmers in the original bug this call was added to fix: "a character holding a wall
    // never reaches [passFarm], because this stage handles the pass and returns first."
    if (this.hold) await this.releaseRestedHold();
    if(this.hold)await this.healObservedFleetmate().catch(e=>this.note('observed ally heal failed',{why:e.message}));

    // A posted room caster works from its refuge. Ordinary errands are below this
    // recovery stage and cannot run while it is holding a wall.
    if (this.isRoomEnchantPost() && this.holdWorks() && hp !== null && hp >= 0.9) {
      if (await this.maintainRoomEnchantPost()) return HANDLED;
    }

    // A HEALER BEHIND A WALL NEVER HEALED ANYBODY, AND THAT IS THIS STAGE'S DOING.
    //
    // `medic()` is called from the WORK pass, several stages below. The note above says why
    // that is unreachable, about a different victim: "a character holding a wall never
    // reaches it, because this stage handles the pass and returns first." Exactly the same
    // sentence applies to mending an ally, and it bites harder — a dedicated healer's normal
    // resting state IS holding a wall. It is not an edge case, it is the configuration.
    //
    // Measured on prod 2026-09-10: Loial the Ogier in the Valley of Ileria on the `coop`
    // strategy, 65 of 65 mana, hospice in his book, one and then two wounded fleet-mates in
    // the room with him, activity "holding a proven safe spot" — and six samples over a
    // hundred seconds with mana never moving. The pass that would have cast was never run.
    //
    // So it is asked HERE, additively: the ladder's ordering is untouched, because that
    // ordering is the survival ladder and mis-ranking one rung of it has already cost four
    // deaths (see the retreat note below). Gated on being SHELTERED AND WHOLE — a wall at our
    // back and health at or above the rest threshold — because a character still mending
    // itself is the one case where spending mana on somebody else is wrong, and because
    // `medic()` carries its own 45s gap, mana floor and reagent check on top.
    if (this.hold && (STRATEGIES[this.policy.strategy] || {}).medic) {
      const vit = this.s.client?.vitals?.()?.health;
      const whole = vit?.max > 0 ? vit.value / vit.max : null;
      if (whole != null && whole >= 0.9) await this.medic().catch(() => {});
    }

    // THE RECOVERY STOP A JOURNEY ASKED FOR, and the one poison always needs.
    //
    // Two triggers, one answer — a wall FORWARD on the route, mended at, objective kept:
    //
    //   the watchdog rescue, which used to leave the body idle in the room it was dying in
    //   poison below three quarters, which drains past any line the character can fight at
    //     and then makes it rest to full anyway once the enchantment ends
    //
    // Cleared the moment it is taken or there is nothing ahead to take, so this can never
    // become a standing instruction that outlives the trouble that set it.
    const ailingNow = (this.s.client?.ailments?.() ?? []).length > 0;
    const poisonedAndFading = ailingNow && hp !== null
      && hp < (this.policy.ailingShelterBelow ?? AILING_SHELTER_BELOW);
    // AND A THIRD TRIGGER, BECAUSE AN EXHAUSTED TRAVELLER IS A STRANDED ONE.
    //
    // Vigor is not a comfort here, it is the difference between walking and running, and
    // running is the only speed at which these roads are survivable: `RUN_VIGOR_FLOOR` is 12
    // and below it the server refuses the speed, so the body drops from about five squares a
    // second to two and a half. Everything downstream is budgeted for the fast one.
    //
    // Mmmm is the case, 2026-08-27, and it is the clearest single failure in the whole
    // five-inn run. It crossed ELEVEN ROOMS IN FOUR MINUTES — every leg `ok`, 6 to 43
    // seconds each — reached Ukgoth, and then spent FORTY-THREE MINUTES failing to leave it:
    //
    //     10:01  599 -> 2  FAIL   353s  every square for that exit refused (4 tried)
    //     10:09  599 -> 2  FAIL   829s  every square for that exit refused (4 tried)
    //     10:20  599 -> 2  FAIL  1512s  every square for that exit refused (4 tried)
    //     10:36  599 -> 598 FAIL 1061s  every square for that exit refused (3 tried)
    //
    // It was at vigor ONE. The climb from the Ukgoth valley to the Castle Victoria doorway
    // is 86 to 126 mover steps, and the same crossing from the same valley was measured at
    // 24-27 seconds, six times out of six, by characters that could run. At walking pace it
    // exhausts `leaveViaAny`'s candidate budget every time and reports the DOORWAY as
    // refused — a geometry verdict on what is actually an energy problem, which is why this
    // cost two sessions to find.
    //
    // A road-travel floor, well above the server's 12: the point is not to keep running for
    // one more second, it is to never arrive at a hard crossing unable to run at all.
    // Sitting down is the only way to get it back — vigor above REST_VIGOR_CAP has to be
    // eaten — so this asks for exactly what the health trigger asks for and gets the same
    // answer: the nearest clear recovery spot, the objective kept, and a resume when full.
    const vigorFloor = this.policy.travelVigorFloor ?? TRAVEL_VIGOR_FLOOR;
    const spentOnTheRoad = this.tooTiredToTravel(v);
    if ((this.wantsForwardShelter || poisonedAndFading || spentOnTheRoad)
        && !sheltered && !this.hold) {
      const why = this.wantsForwardShelter
        || (spentOnTheRoad
            ? `down to ${v?.vigor?.value} vigor — below ${vigorFloor}, which is walking pace on a `
              + 'road budgeted for running. Filling up before going on'
            : `ailing and down to ${Math.round(hp * 100)}% — mending before going on`);
      this.wantsForwardShelter = null;
      if (await this.shelterForwardAndMend(why).catch(() => false)) return HANDLED;
      if (this.travelInterrupted()) return HANDLED;
    }

    const spawnsHere = !this.sanctuary();
    if (hurt && (combatZone || spawnsHere) && !sheltered && !testing && !this.hold
        && (!this.wallTriedAt || Date.now() - this.wallTriedAt > 30_000)) {
      this.wallTriedAt = Date.now();
      const got = await this.takeRecoverySpot(
        'hurt in a room that spawns monsters — a wall before a rest')
        .catch(() => false);
      if (this.travelInterrupted() || got?.cancelled) return HANDLED;
      this.note('will not rest in the open here', {
        health: hp === null ? null : Math.round(hp * 100) + '%',
        monsters_in_room: hostiles.length, adjacent: near.length, got_a_wall: !!got?.took,
        room_spawns: spawnsHere, nothing_visible_yet: hostiles.length === 0 || undefined,
        why: 'resting is sitting still and not looking. Doing it where something can reach us is ' +
             'how a rest becomes a death, and an empty room that spawns is a room between spawns' });
    }
    // VIGOR TO SPARE MEANS WALK, DO NOT WAIT.
    //
    // The deadlock this closes: hurt, something hostile somewhere in the room, no wall
    // to be had. The branch above tries for a wall once every thirty seconds; the rest
    // gate below refuses to sit down in a combat zone; and the fight path refuses to
    // engage while too hurt. So the character does nothing at all — not resting, not
    // fighting, not leaving — and it does not even register as a stall, because each
    // individual refusal is correct.
    //
    // Piggy sat in it at 12 of 27 health with FULL VIGOR, nothing in swing range and
    // zero landing damage, in the room where the fleet has been dying. At 200 vigor she
    // would have healed to full in fifteen seconds anywhere safe.
    //
    // 80 is the line because 80 is what RESTING alone can reach — the rest threshold.
    // Below it, standing still is at least buying back the vigor that walking spends.
    // Above it, waiting buys nothing at all: the vigor is already there, it is only in
    // the wrong place, and moving is the only thing that converts it into health.
    //
    // withdraw() retreats to a WALL now rather than to open floor, so this is a move
    // toward somewhere it can actually heal, not merely away from here.
    // REST_VIGOR_CAP is a FRACTION (0.4), not a vigor value — it is passed to
    // restUntil, which takes fractions. Comparing a raw vigor of 200 against 0.4 is
    // true for every character that has any vigor at all, which would have fired this
    // branch at 5 vigor: the precise opposite of the rule, and it would have sent
    // exhausted characters walking instead of resting.
    const vigorNow2 = vigorOf(v);
    const restCeiling = REST_VIGOR_CAP * skills.VIGOR_MAX;      // 0.4 * 200 = 80
    if (hurt && combatZone && !sheltered && !testing && !this.hold &&
        vigorNow2 != null && vigorNow2 > restCeiling) {
      this.note('not waiting this out — moving to somewhere I can heal', {
        health: hp === null ? null : Math.round(hp * 100) + '%',
        vigor: vigorNow2, rest_ceiling: restCeiling,
        monsters_in_room: hostiles.length, in_swing_range: near.length,
        why: 'hurt, no wall here, and too much vigor for waiting to be worth anything — resting ' +
             'cannot raise vigor past ' + restCeiling + ' and we are already above it, so the ' +
             'only thing standing still produces is time spent hurt in a monster room' });
      // "Somewhere I can heal" is an inn, not a wall in the same monster room. The
      // wall version left us inside the vision of everything that was already hitting
      // us, healing at a rate that damage cancelled out.
      // THE INN RETREAT IS GONE. IT IS THE LOGOFF. Operator, 2026-09-10: "Remove all other code
      // that attempts other survival strategies (especially never resting in the open: use SAFE
      // WALLS, and log out/in if the danger is immediate)".
      //
      // This is precisely the state the instruction describes: hurt, NO WALL HERE, monsters in
      // the room, and resting cannot help because vigor is already above the resting ceiling.
      // The old answer was to walk to an inn -- across the rooms that were already hitting us --
      // and the record on that is four deaths (issue #51, JohnsSlave 2026-09-03/04, every one
      // `in_safe_spot:false`, `at_a_safe_wall:null`, the last at 0.0 squares per second for the
      // whole 31-second window) plus the fact that `retreat_to_inn` has been switched OFF since
      // 2026-08-27, so the call returned `{arrived:false}` having moved nothing while five
      // callers reported progress for it.
      //
      // The logoff needs no walk, no destination and no wall: it stops the attack outright.
      const went = await this.playDead('hurt with no wall here and vigor above the rest ceiling')
        .catch(() => false);
      // A LOGOFF THAT LANDED IS PROGRESS; ONE THAT WAS REFUSED IS NOT. That distinction is the
      // whole of issue #51 -- the old rung reported progress whatever came back, which told every
      // stall detector the body was fine while it stood still and died. Report the one that
      // happened, and say nothing for the one that did not.
      if (went) {
        this.progress('logged off rather than standing hurt in a monster room');
        return HANDLED;
      }
      // A RETREAT THAT WAS REFUSED IS NOT A RETREAT, AND MUST NOT END THE PASS.
      //
      // This called progress() and returned HANDLED whatever came back — and what comes
      // back on this fleet is `{arrived:false, refused:'retreat_to_inn is off'}`, because
      // the operator switched the inn walk off on 2026-08-27. So the rung that decides to
      // move consumed the pass, told the stall detector everything was fine, and PRE-EMPTED
      // the rung immediately below, which is the one that actually leaves the room —
      // `leaveViaAny`, a reconnect to shed the crowd, and another try.
      //
      // That is issue #51 and it is four deaths: JohnsSlave, 2026-09-03 and 2026-09-04,
      // every one of them `in_safe_spot:false`, `at_a_safe_wall:null`, and the last one
      // 0.0 squares per second across the whole 31-second post-mortem window. The journal
      // said "moving to somewhere I can heal" once a pass while the body stood still.
      //
      // So: only a retreat that actually happened is progress. A refusal falls THROUGH to
      // the escape below, which is exactly where a character that cannot reach an inn and
      // cannot hold a wall is supposed to end up.
      if (went?.arrived) {
        this.progress(went.took_spot ? 'took a wall rather than waiting it out'
                                     : 'moved toward somewhere I can heal');
        return HANDLED;
      }
      this.note('the retreat was refused — not ending the pass on it', {
        refused: went?.refused ?? 'no reason given', no_spot: went?.no_spot ?? null,
        why: 'saying we are moving is not moving. The next rung leaves the room, and it ' +
             'only gets to run if this one does not claim the pass' });
    }

    // AND BELOW THE RESTING CEILING: GET OFF THE MAP ENTIRELY.
    //
    // The other half of the same deadlock, and the worse one. Hurt, something hostile
    // in the room, no wall — and now too little vigor to want a fight or to make a
    // long walk pay. The branch above does not fire, the rest gate refuses (combat
    // zone), the fight path refuses (too hurt). Sweetums sat in it for 670 passes,
    // roughly three hours, and Piggy before her. Every individual refusal is correct
    // and the sum of them is a character quietly doing nothing until it dies.
    //
    // Resting here is not an option — that is the one thing that turns this into a
    // death — so the answer is to stop being here at all: LEAVE THE ROOM by the
    // nearest exit. Out of the room the hostiles are not, and resting becomes legal.
    //
    // Then fix the actual cause, which is an empty larder: cook if we can, and
    // otherwise declare the want so the fleet's supply machinery can answer it. A
    // character at this vigor with no food is not in a fight it can win; it is in a
    // supply problem wearing a fight's clothes.
    // LOW VIGOR IS NOT A REASON TO RUN AWAY. LOW HEALTH IS.
    //
    // `hurt` is true when EITHER health or vigor is short, which is right for deciding to
    // rest and badly wrong for deciding to abandon a room. Vigor does not fall because
    // there is a monster nearby; health does. So a character at full health and the
    // vigor cap read as "hurt", found something hostile, and left — then did it again in
    // the next room, for ever.
    //
    // Measured: of 107 room-flees, ALL 107 were by characters below 180 vigor and NONE
    // by a well-fed one, and every single fleeing character had zero kills. Robin fled
    // 54 times at 29 of 29 health and killed nothing. Fixing the escape so it actually
    // works converted "die where you stand" into "run for ever", which is better and
    // still not farming.
    //
    // The deadlock this branch exists to break is real — too hurt to fight, unable to
    // rest because something is watching — but it is a HEALTH deadlock. At full health
    // there is no deadlock: a tired character fights worse, not not-at-all, and the
    // answer to low vigor is food, which is somewhere else entirely.
    // Vigor is handled by provision() before quarry selection and by the single fight
    // gate below. It never belongs in the escape predicate: duplicating the raw fleet
    // target here made this branch stricter than the strategy it was supposedly serving.
    // LEAVING THE ROOM IS AN EMERGENCY HEALTH DECISION, NOT AN ENGAGEMENT PREFERENCE.
    // restAt includes engageAt so an 89%-healthy character can choose to recover before
    // opening at 90%. That is not evidence it is dying. The raw fightAboveVigor value is
    // provisioning intent; the strategy fight gate below is its only combat authority.
    // Reading 180 here as an escape threshold made healthy bots walk for minutes at 156.
    const mustLeaveForHealth = belowRoomRetreatHealth(hp, this.policy.restBelow);
    if (mustLeaveForHealth && combatZone && !sheltered && !testing && !this.hold) {
      this.doing = 'travelling';
      let ways = (s.world?.exits() || []).filter(e => e.to != null && e.reachable !== false);

      // THE THIRD DOOR, AND THE ONE THAT PROVES A CHOKE POINT HAS TO BE FOUND RATHER THAN
      // ASSUMED. `confineRooms` was enforced at `retreatToSafety`, then at
      // `nearestSanctuary`, then at `Autopilot.travel` — which I claimed was the single
      // call every keeper journey passes through. It is not. This branch takes a room EXIT
      // directly, so it never calls travel(), never recorded a refusal, and walked Rizzo
      // out of Castle Victoria into room 2 with the gate showing zero refusals and his
      // policy still reading confine [38,39].
      //
      // The trigger is worth reading before changing it: it fires when health is below the
      // recovery line AND there is no reachable proven wall. Rizzo's room had TEN monsters
      // and his safe spot was unreachable, so the honest state is "this room cannot be
      // rested in" — and the confinement's answer is still no. That is the operator's
      // instruction and it is not free: it trades a walk-out for a fight in place.
      const confineOut = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms : null;
      if (confineOut?.length) {
        const allowedOut = confineOut.map(Number);
        const blocked = ways.filter(e => !allowedOut.includes(Number(e.to)));
        ways = ways.filter(e => allowedOut.includes(Number(e.to)));
        if (blocked.length)
          this.note('exits refused by the confinement', {
            confined_to: allowedOut, refused: blocked.map(e => ({ to: e.to, name: e.to_name })),
            still_open: ways.map(e => e.to),
            why: 'leaving to recover is still leaving. The operator confined this character ' +
                 'to these rooms, and a walk out of them is what has been getting it killed',
            cost: ways.length ? 'a permitted exit is still available'
                              : 'no permitted exit — it stays and recovers where it stands, ' +
                                'which is the trade the confinement makes' });
        if (!ways.length) recordEvent(this.who(), 'confinement_refused_travel', {
          wanted: blocked.map(e => Number(e.to)), confined_to: allowedOut,
          room: s.world?.room?.num ?? null, via: 'leave-to-recover',
        });
      }
      const out = ways.sort((a, b) => (a.steps_away ?? 999) - (b.steps_away ?? 999))[0];
      this.note('leaving the room to recover safely', {
        health: hp === null ? null : Math.round(hp * 100) + '%', vigor: vigorNow2,
        monsters_in_room: hostiles.length, leaving_via: out?.to_name ?? 'nothing reachable',
        retreat_below: Math.round(this.policy.restBelow * 100) + '%',
        why: 'health is below the configured recovery line and there is no proven wall here. ' +
             'Resting where a monster can reach us is unsafe; vigor alone never triggers this trip',
        then: 'recover health outside the monster room, then return' });
      // TRY EVERY WAY OUT, AND THEN STOP BEING SURROUNDED.
      //
      // THIS IS WHAT IS KILLING THE FLEET. Of 37 deaths since the reach model went in,
      // 33 decided to leave and 13 recorded "could not leave" — and every single death
      // was slow attrition: median -0.03 health per second, nothing worse than -0.22.
      // Nobody was killed in a fight. They chose correctly, failed to get out, and then
      // bled to death over minutes at 10-12 attackers, standing exactly where they were.
      //
      // Two things were wrong here and both are one-liners:
      //
      //   ONE EXIT. This picked the nearest and tried it once, so the boundary-wide
      //   candidates from world.exits() were never used. leaveViaAny walks the whole
      //   wall and every other exit besides.
      //
      //   NO FALLBACK. When the walk out failed it gave up and returned, and the pass
      //   ended with the character still standing in the room. But a walk failing while
      //   surrounded is the EXPECTED case — that is what being surrounded does — and
      //   there is already a tool for it: a reconnect hands back the entry grace period,
      //   so we come back with about one of them aware of us instead of twelve. It was
      //   only ever wired to stepping off a safe spot, which is the same problem in a
      //   politer setting.
      // A CONFINED CHARACTER WITH NO PERMITTED EXIT TAKES A WALL, IT DOES NOT STAND THERE.
      //
      // The operator's rule, and it is a better one than "leave the room": a genuine safe
      // spot cannot be reached by a monster at all, so a single room WITH safe spots and
      // without players in it is safe — the wall is the answer to being surrounded, and
      // walking is only the answer when there is no wall to be had. So when the
      // confinement closes every exit, the fallback is the spot, not the bleeding.
      //
      // This is also where my own first patch was wrong and would have leaked: `tryOut`
      // below falls back to `s.world.exits()` — EVERY exit — whenever `ways` is empty, so
      // filtering the list down to nothing did not close the door, it opened all of them.
      // Both the primary list and that fallback have to be filtered, which is why the
      // confinement is applied inside `tryOut` rather than only to `ways`.
      if (confineOut?.length && !ways.length) {
        const took = await this.takeRecoverySpot(
          'confined to this room and hurt — a wall is the way to rest here',
          { source: 'confinement' }).catch(() => null);
        this.note(took?.took ? 'took a wall instead of leaving' : 'confined, hurt, and no wall yet', {
          confined_to: confineOut.map(Number), spot: took?.spot ?? null,
          why_not: took?.took ? undefined : (took?.why ?? 'no reason given'),
          why: 'a genuine safe spot cannot be reached by a monster, so a room with one is a ' +
               'place a confined character can recover without taking a door',
          note: took?.took ? undefined
            : 'no reachable spot this pass — the ordinary ladder keeps trying rather than ' +
              'walking out, which is what the confinement is for' });
        return;
      }

      const tryOut = async () => {
        let cands = ways.length ? ways : (s.world?.exits() || []).filter(e => e.to != null);
        // The fallback above is the whole-room exit list, so re-apply the confinement to it.
        if (confineOut?.length)
          cands = cands.filter(e => confineOut.map(Number).includes(Number(e.to)));
        if (!cands.length) return { left: false, reason: 'no exit from this room at all' };
        return await s.leaveViaAny(cands).catch(e => ({ left: false, reason: e.message }));
      };
      const gotOut = async (r) => {
        this.tally.fled_rooms = (this.tally.fled_rooms || 0) + 1;
        this.fledInARow = (this.fledInARow || 0) + 1;
        await skills.restUntil(s, { health: 0.95, vigor: REST_VIGOR_CAP, maxSeconds: 90 })
                    .catch(() => {});
        await this.cookSomething('got out of a bad room and need food before going back')
                  .catch(() => {});
        this.progress('left a room I could neither fight nor rest in');
        // FLEEING TWICE IS A SUPPLY PROBLEM WEARING A TACTICS PROBLEM'S CLOTHES.
        //
        // Leaving one bad room is a decision. Leaving three is a character that cannot
        // fight anywhere, and walking to a fourth wilderness room will not change that.
        // Animal proved it: 168 flees and 2 kills, because the supervisor graduates a
        // pair with fight_above_vigor 180 and a character at the resting cap of 80 can
        // never meet it — so it refused every fight, fled every room, earned nothing,
        // and therefore never got the food that would have let it fight. The loop is
        // closed and nothing inside the wilderness opens it.
        //
        // Town does open it: it is a sanctuary, so resting is legal and safe, and it
        // has counters that sell bread — which is the only route past 80 vigor.
        //
        // The exemption is for a character that is merely having a bad room: plenty of
        // vigor and food in the pack means the fleeing is tactical, not structural, and
        // sending it to town would be throwing away a working session.
        await this.townTripIfCornered().catch(() => {});
        return r;
      };

      let r = await tryOut();
      if (r.left) { await gotOut(r); return HANDLED; }
      this.note('could not leave', { why: r.reason, tried: r.tried?.length ?? 1,
        next: 'reconnecting to shed the crowd, then trying again' });

      // Being unable to walk out IS the crowd. Reset it and try once more.
      const broke = await this.breakOut('cannot walk out of a room that is killing us')
                              .catch(() => ({ did: false }));
      if (broke.did) {
        r = await tryOut();
        if (r.left) {
          this.note('got out after reconnecting', { crowd_before: broke.crowd,
            why: 'the walk failed because twelve things were already swinging; after a ' +
                 'reconnect only about one of them has noticed' });
          await gotOut(r);
          return HANDLED;
        }
      }
      // EAT BEFORE DECLARING YOURSELF TRAPPED — IT IS USUALLY THE WHOLE PROBLEM.
      //
      // "Cannot fight" here almost always means BELOW THE FIGHT FLOOR rather than hurt:
      // the floor is 180 and sixteen of twenty-one characters sit under it at any moment,
      // median vigor 148. So a character at full health, in a room full of its own prey,
      // with food in its pack, declares itself trapped and waits for a rescue that is
      // sitting in its own inventory. Rizzo did exactly that — 46 of 46 health, vigor 141,
      // three fleet-mates and four fungus beasts in the room — and stalled for seventeen
      // minutes.
      //
      // The comment above this branch already names the loop, in Animal's case: refuse
      // every fight for want of vigor, flee every room, earn nothing, and therefore never
      // get the food that would have let it fight. Eating is the one move that opens it
      // from inside the wilderness, and the escape path already reaches for it AFTER a
      // successful walk (`gotOut` calls cookSomething) — which is precisely the case that
      // did not need it.
      //
      // So try the pack first, and only then say nobody can help. If it eats, the next
      // pass re-decides with more vigor and the fight gate may simply open.
      const plan0 = STRATEGIES[this.policy.strategy] || STRATEGIES.baseline;
      if (await this.provision(plan0, v).catch(() => false) === 'ate') {
        this.note('ate rather than reporting myself trapped', {
          why: 'could not fight, rest or leave — and "cannot fight" here is usually vigor ' +
               'below the fight floor, which food fixes and a rescue does not' });
        return HANDLED;
      }
      // Nowhere to go and nothing to eat. Say what is actually needed rather than looping
      // silently — the interest board is what the almoner and the quartermaster read.
      this.declareInterest();
      this.noProgress('trapped: cannot fight, cannot rest, cannot leave -- needs food or a rescue');
      return HANDLED;
    }

    if ((!combatZone || sheltered || testing) && hurt) {
      if (testing && near.length)
        this.note('testing this spot the only way there is', {
          where: { col: this.hold.col, row: this.hold.row }, crowd: near.length,
          health: Math.round(hp * 100) + '%',
          why: 'sitting still without swinging is the experiment. If nothing lands we can rest to ' +
               'full here from now on; if something does, we find out in one pass and with two ' +
               'hits of margin still in hand' });
      // HEALTH AND VIGOR COME BACK BY COMPLETELY DIFFERENT MEANS, and only one of
      // them comes back by resting. RestTimer restores vigor and never touches
      // health (player.kod:10033). Having a high vigor then enhances your health regeneration.
      this.doing = 'recovering';
      // Arm whenever we are here for HEALTH, at whichever threshold brought us — a
      // sheltered character resting at 85% still needs the flag set, and gating this
      // on the open-floor threshold would have it sit there collecting vigor and
      // wondering why its health never moved.
      if (hp !== null && hp < restAt) {
        // ARM THE TIMER FIRST. HealthTimer only awards a point if
        // PFLAG_MOVED_SINCE_ENTRY is set, so a character that walked into an inn and
        // stopped regenerates nothing at all — which is precisely what happened to one
        // of mine for twenty-nine consecutive rest attempts.
        //
        // HOW we arm it depends entirely on where we are standing. A step arms it and
        // gives up the square; a TURN arms it and does not. Out in the open that
        // distinction does not exist, which is why the original only ever stepped —
        // but stepping off a safe spot to start healing is giving away the reason the
        // healing is safe, and it is worth being exact about.
        const n = this.hold
          ? await skills.turnInPlace(s).catch(() => ({ turned: false }))
          : await skills.nudge(s).catch(() => ({ moved: false }));
        // Both of these end the entry grace period, which is the point: from here on
        // anything that fails to hit us is failing because of the walls.
        if (n.turned) this.turnedAt = Date.now();
        if (n.moved) this.movedAt = Date.now();
        if (n.moved && this.hold) {
          // DRIFTING OFF A PROVEN SQUARE IS A REASON TO WALK BACK, NOT TO GIVE IT UP.
          //
          // This released the hold outright, on the reasoning that REQ_TURN carries no
          // coordinates so a move here "should be impossible". It is not impossible, and
          // it killed Animal: a proven spot at (23,6) in the Main gate to the city of Tos
          // that had held for 44 seconds, broken off from correctly at 34% health, then
          // abandoned on this line with the note "a turn moved us off the square". He
          // healed in the open instead — 10 health, then 2, then dead, with three
          // centipedes and two of the Duke's soldiers in the room.
          //
          // And the detection cannot support the conclusion it draws. turnInPlace
          // compares position from before the turn against a read taken after a 300ms
          // sleep and a room-contents round trip — up to 2.3 seconds of live combat. All
          // `moved` establishes is that the square changed at some point in that window;
          // it does not establish that the turn did it.
          //
          // Whatever moved us, the right answer at low health is the square we already
          // know holds. returnToSpot closes to the fine unit, which matters because a
          // safe spot can sit most of a square off centre. Give it up only if we cannot
          // get back.
          const back = await skills.returnToSpot(
            s, { col: this.hold.col, row: this.hold.row, x: this.hold.x, y: this.hold.y },
            { maxSteps: 12 }).catch(() => ({ arrived: false }));
          if (back.arrived) {
            this.note('drifted off the safe square and walked back', {
              where: { col: this.hold.col, row: this.hold.row }, off_by: back.off_by ?? null,
              proven: this.hold.proven, health: hp,
              why: 'the square is known to hold and we are too hurt to fight in the open; ' +
                   'returning is cheaper than finding another one' });
          } else {
            this.releaseHold(`moved off the square and could not get back: ${back.why || 'unknown'}`);
          }
        } else if (n.turned) {
          this.note('turned to arm health regeneration', {
            ...n, kept: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
            why: 'this wakes the monsters, and in a working safe spot that costs nothing — ' +
                 'they cannot reach us, and the flag it sets is what lets health come back' });
        } else if (n.moved) {
          this.note('stepped to arm health regeneration', n);
        }
        const h = await skills.healUp(s, { target: 0.9 }).catch(e => ({ healed: false, reason: e.message }));
        this.recordHealUse(h, 'hurt, and resting behind a wall');
        if (h.healed) {
          this.tally.heals = (this.tally.heals || 0) + 1;
          this.progress('healed');
          this.note('healed', { used: h.used, health: h.health });
        } else if (h.reason === 'nothing to heal with') {
          // No flask and no heal spell is NOT a dead end — health comes back on its
          // own now that we have moved. It is only slow, at roughly
          // ((200-vigor)^2/6 + 1000) milliseconds a point, which is why resting
          // matters: it is vigor, not time, that sets the rate. Only ask for help if
          // we are badly hurt AND cannot rest safely.
          this.note('healing the slow way', {
            health: h.health, armed_by: n.turned ? 'turning in place' : (n.moved ? 'a step' : 'nothing'),
            note: 'no flask or heal spell; regenerating on the vigor timer' });
          // Being out of flasks is only an emergency when we have nowhere safe to be.
          // In a spot that holds, it is a wait.
          if ((hp ?? 1) < 0.25 && !sheltered)
            await this.askForHelp('badly hurt and out of flasks').catch(() => {});
        }
      }
      this.tally.rests++;
      // Sheltered, resting is free and uninterruptible, so take it all the way to
      // full rather than to a threshold — the next fight starts from whatever we
      // stand up with, and there is nothing to spend the difference on.
      const r = await skills.restUntil(s, {
        // Always finish above the threshold that sent us here, or the next pass sends
        // us straight back and the character rests in one-second slices forever.
        health: Math.min(0.99, Math.max(0.95, restAt + 0.02)),
        // Not 0.95. RestTimer stops awarding vigor at 80 of 200, so asking for more
        // guarantees the full timeout is burned every single rest and reached_target
        // is always false.
        vigor: REST_VIGOR_CAP,
        // A short leash while the spot is only a hypothesis: resting does not look at
        // anything, so a two-minute rest in a corner that does not work is two minutes
        // of being hit with nobody watching.
        //
        // AND A PROOF IS ABOUT THE ROOM IT WAS TAKEN IN. The long leash is earned by
        // evidence — this square held while N things stood next to it — and it stops
        // meaning anything once more than N are there. Twenty-one of our own characters
        // moved into the Mausoleum and the mummy cap is twenty; squares proven against
        // one or two attackers were suddenly being approached by four, from angles the
        // proof never covered. Zoot took the full sheltered leash on such a square and
        // spent it going from 17 health to 3.
        //
        // So the leash is the SHORT one whenever the present crowd is bigger than the
        // one the square was proven against. Not a demotion — the square may well still
        // work — just a refusal to bet two minutes of not looking on it.
        maxSeconds: testing ? 15
                  : (sheltered ? (near.length > (this.hold?.mostAttackers ?? 0) ? 20 : 150)
                               : 90) });
      this.note('rested', { seconds: r.seconds, to: r.vitals?.health, reached: r.reached_target, why: r.note,
                            in_safe_spot: sheltered || undefined,
                            crowd: sheltered ? near.length : undefined,
                            interrupted: r.interrupted || undefined,
                            note: r.interrupted
                              ? 'cut short — see interrupted'
                              : sheltered
                              ? 'resting to full in a monster room, which the safe spot is what makes possible'
                              : 'resting restores vigor, and vigor sets how fast health regenerates' });
      // TAKING DAMAGE THROUGH A REST IS EVIDENCE, AND IT IS THE SAME EVIDENCE the hold
      // evaluator acts on — hit while standing still and not swinging. It just arrived
      // three seconds after the fact instead of at the end of the leash, which is the
      // entire point. Give the square up now rather than resting into it again on the
      // next pass and waiting for observe() to reach the same conclusion a minute later.
      if (r.interrupted) { await this.restBroken(room, near).catch(() => {}); return HANDLED; }

      // AND A REST THAT GAINS NOTHING IS THE SAME EVIDENCE AS ONE THAT IS CUT SHORT.
      //
      // `interrupted` is set when a blow lands hard enough to break the rest, and that is
      // the loud version of the square not working. The quiet version killed Waldorf.
      //
      // He held (7,41) in West Merchant Way — proven, six things in the room — and bled at
      // 0.16 health a second, which is slow enough that no single blow ever tripped
      // `interrupted`. Every pass rested, gained nothing, and fell through this `return`
      // to rest again. restUntil reported it accurately each time: "nothing recovered for
      // several checks — something may be preventing rest". His health trail is 20, 19,
      // 20, 18 … 2, 1, and then twenty-five consecutive samples at 1 to 3 health, with the
      // keeper resting and refusing to freeze in turn and never once leaving. He was at 3%
      // health against a flee threshold of 0.7 — `fled_in_time` came out at 2.9% — and
      // what finally killed him was a reconnect: the session dropped, the rejoin put him
      // back at 1 health in a room with five giant rats, and he lasted 3.4 seconds.
      //
      // So the test is not "was a blow big enough to notice", it is "is sitting here
      // working". A sheltered rest that ends no better than it started has answered that,
      // and the answer means the same thing as an interruption: give the square up, let
      // restBroken pick somewhere else. Being wrong costs a walk to the next corner, which
      // is the trade this whole file already makes everywhere else about safe spots.
      const after = r.vitals?.health;
      const afterHp = after?.max ? after.value / after.max : null;
      if (sheltered && r.reached_target !== true && afterHp != null && hp != null && afterHp <= hp) {
        this.note('rested and gained nothing — giving the square up', {
          health_before: Math.round(hp * 100) + '%', health_after: Math.round(afterHp * 100) + '%',
          seconds: r.seconds, crowd: near.length, why: r.note,
          note: 'a safe spot is what makes resting in a monster room possible, so a rest ' +
                'that recovers nothing is the square failing quietly rather than loudly — ' +
                'the same conclusion as `interrupted`, reached without waiting for a big hit' });
        await this.restBroken(room, near).catch(() => {});
        return HANDLED;
      }
      return HANDLED;
    }
    return CONTINUE;
  }
  // @end 1
}
