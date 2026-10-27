// THE FARM PASS.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 2 methods: recordInterruptedFarmOutcome, passFarm
import { bodyAuthority } from '../m59-body-command.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { opensFightFromWall } from '../m59-policydiff.mjs';
import { notePreySide } from '../m59-preyside.mjs';
import { beginPullProgress } from '../m59-pull-progress.mjs';
import { stalePullReason } from '../m59-quarry-identity.mjs';
import { PLAYER_REACH } from '../m59-safespots.mjs';
import * as skills from '../m59-skills.mjs';
import { huntLabel, huntMatcher, loadSpawns } from '../m59-spawns.mjs';
import * as tougher from '../m59-tougher.mjs';
import { sameRoomIslandBridgePlan } from '../m59-world.mjs';
import { claimQuarry, farmRoomDenials, HANDLED, healAllowOf, MIN_FIGHT_VIGOR, openFightReadiness, partialFightMadeProgress, pct, quarryPermittedByConfinement, rankQuarries, reachableOpenFightVigorBar, releaseQuarry, REST_VIGOR_CAP, shouldRelocateToAssignedRoom, SPAWN_FILE, STRATEGIES, vigorBarFor, vigorOf, WANT_FIGHT_VIGOR } from '../m59-autopilot.mjs';

export class PassFarmPart {
  // @part 1

  recordInterruptedFarmOutcome(f,{room,holding,preempted}={}) {
    const receipt={creature:f?.target??null,room_num:room?.num??null,room:room?.name??null,
      killed:f?.killed===true,died:f?.died===true,rounds:f?.rounds??null,
      from_safe_spot:!!holding,preempted,reason:f?.reason??f?.why??null};
    this.ledgerEvent('interrupted_farm_result',receipt);
    if(f?.killed===true){
      this.tally.kills=(this.tally.kills??0)+1;this.killTimes?.push(Date.now());
      if(this.killTimes?.length>500)this.killTimes.shift();
      this.ledgerEvent('killed',{...receipt,survival_interrupted:true});
    }
  }

  async passFarm(ctx) {
    const { s, c, room, v, hp } = ctx;
    // Before any work is chosen: is there an unfinished journey to pick back up? Ahead of
    // the `work` claim check on purpose — resuming restores a decision that was ALREADY
    // made and interrupted, it does not make a new directional one, so it is not the
    // claimant's to own. A bot that has changed its mind issues a travel, and that clears
    // the note (see goTravelling).
    const resumed = await this.resumeSuspendedJourney(ctx);
    // A recovery/backoff wait retains its destination. Only an explicit drop or
    // new order releases it for ordinary farming to choose another journey.
    if (resumed === HANDLED || this.suspendedJourney) return HANDLED;
    // KILLED BY A PLAYER: rest out the return delay where it recovered, before any work is
    // chosen. Below the resume on purpose — a resumed journey to a farming room is refused by
    // the gate in `travel()` and dropped, and one to anywhere else is not this rung's business.
    if (await this.holdOffTheFarm(ctx) === HANDLED) return HANDLED;
    // Every mode reads its weapons, not only farm (see the idle branch in passErrand): a
    // `survive` character — Raphael, the troll crew's dedicator — skips the farm block below.
    this.sweepWeaponMagic().catch(() => {});
    this.s._fieldWeaponCap = this.fieldWeaponCap();
    this.shedUnusedConjures().catch(() => {});
    // 4. Work. Only in farm mode, and only on what we were told to hunt.
    //
    // AND ONLY IF NOBODY ELSE OWNS IT. This is the seam the carve-out is cut along: every
    // branch above decides on a one-second clock and has one right answer, and this one
    // decides on a clock of minutes and has none. A bot holding `work` is choosing the
    // quarry, the room and the errand; the keeper below it still flees, rests, re-arms and
    // gets itself out of the Underworld, because those are decided further up and returned
    // before reaching here.
    //
    // The check is deliberately at the TOP of the branch rather than sprinkled through it.
    // Half-owned work — a bot picking the room while the keeper picks the prey — is two
    // movers on one character, which is the configuration error this whole exercise exists
    // to avoid, and it reads as working from both sides.
    // A CLAIM ON `work` IS OWNERSHIP OF THE DECISION, NOT A STOP ORDER — AND THE FIRST
    // VERSION OF THIS GOT THAT BACKWARDS.
    //
    // It returned here when `work` was claimed, which reads as "something else is driving,
    // so stand down". That is right for `inert`, where another PROCESS is moving the
    // character step by step, and it is exactly wrong for a directional bot. DUM does not
    // move anybody: it writes ORDERS — what to hunt, which room, which thresholds — and
    // the keeper executes them, on its own one-second clock, as it always has.
    //
    // So the early return would have idled every character it was applied to. Claiming
    // `work` on all twenty-one would have stood the whole fleet down while DUM reported
    // that it was driving them and the board reported healthy keepers: the exact
    // both-logs-look-correct failure this carve-out is supposed to remove.
    //
    // What the claim actually buys is COORDINATION. It records who owns the directional
    // fields so two writers cannot fight over them, it is visible on the board, and it
    // expires back to the keeper. The keeper keeps working throughout — which is also what
    // makes the parity claim testable at all: a fleet under a doctrine that reproduces its
    // own settings should be indistinguishable from one with no bot attached.
    //
    // Noted once per holder so the ownership is legible without a line every eight seconds.
    if (this.mode === 'farm') {
      const owner = this.facultyOwner('work');
      if (this.notedWorkOwner !== owner) {
        this.notedWorkOwner = owner;
        if (owner !== 'keeper') this.note('work is directed by something else', {
          owner, faculties: this.facultyStatus(),
          note: 'that bot chooses the orders — quarry, room, thresholds. This keeper still ' +
                'carries them out, and still owns survival, resting, re-arming and the ' +
                'Underworld, which are decided far above this branch' });
      }
    }
    if (this.mode !== 'farm' && await this.eatToFloor(ctx) === 'ate') return HANDLED;
    if (this.mode === 'farm') {
      // EAT FIRST — BEFORE THE ROOM, THE PREY, THE PACK OR THE WALL.
      //
      // provision() used to sit far below this, under the prey lookup, and every path that
      // does not end in a fight returns before reaching it: a room that cannot spawn the
      // quarry, a relocation, an empty room, a sanctuary, a roam, a full pack, and — the
      // one that mattered most — the too-tired-to-start branch, which rests to 80 and
      // returns. So a character only ate while standing in front of something it could
      // kill, which is both the moment it is least free to stop and eat and a small
      // fraction of the passes of a fleet that spends its day walking between grounds.
      //
      // That made a closed loop out of the two halves of the same system. The fight floor
      // here is 180; resting stops dead at 80 (REST_VIGOR_CAP); only food crosses the gap.
      // A character below its floor went to the rest branch, rested to 80, noted in its own
      // journal that "resting alone stops at 80; if this does not clear, the character needs
      // food" — and returned, every eight seconds, for hours, with the food in its pack.
      // Measured with food in all twenty-one packs: over four minutes vigor fell on fifteen
      // characters, rose on two by the +2 that resting alone gives, and seven sat at exactly
      // the cap. Eating one loaf by hand moved the same character 80 -> 99 immediately.
      //
      // ONLY A MOUTHFUL ENDS THE PASS. provision() also returns "wait, the stomach is full"
      // — a legitimate answer, and a disastrous one to honour here: the stomach drains 0.12
      // a second, so a character below its floor with a full stomach would stand still for
      // up to fourteen minutes rather than walk to its hunting ground. Waiting to get hungry
      // is something to do WHILE travelling, so only a real meal is worth the pass. Nothing
      // is lost by carrying on: the too-tired branch still refuses to start a fight below
      // the floor, so this cannot send anyone into combat empty.
      const plan = STRATEGIES[this.policy.strategy] || STRATEGIES.baseline;
      if (await this.provision(plan, v) === 'ate') return HANDLED;

      // THE STRATEGY MAY SAY THIS FARM SHOULD NOT RUN (m59-strategy-gate.mjs): the body lacks what the file
      // `requires` (a troll crew without a magic weapon), or its kill-rate `floor` tripped. Then no quarry is
      // chosen and the pass ends here; everything above (fleeing, resting, fighting back, eating) already ran.
      // Operator, 2026-10-26: six hours in Ukgoth with weapons that could not hurt a troll "should be at-worst a
      // bounce-back". Below the meal on purpose: a stood-down body still eats.
      if (this.farmStrategyGate()?.blocked) return HANDLED;
      this.farmStrategyFarming();

      // NEVER STAND IN A ROOM THAT CANNOT PRODUCE THE PREY.
      //
      // This does not need to be discovered by waiting. The spawn table says up
      // front whether a giant rat can ever appear here, so tolerating three empty
      // passes first is three passes of pretending. Riven spent them standing in
      // Quintor's Smithy "hunting giant rats" — a shop, where nothing is generated,
      // nothing can be fought, and no amount of patience would have changed either.
      //
      // The check is on GENERATORS, not on the room's object list: a smithy contains
      // the blacksmith, who is placed once at construction, so "does anything spawn
      // here" is true of every shop in the game unless you distinguish the two.
      if (room) {
        const spawns0 = loadSpawns(SPAWN_FILE);
        const here = (spawns0?.rooms?.[room.num] || []).filter(x => x.huntable);
        const isPrey0 = huntMatcher(spawns0, this.policy.hunt);
        const preyHere = here.some(x => isPrey0(x.creature));
        const deniedFarmRooms = farmRoomDenials(this.noWallRooms, this.cappedRooms);
        const assignmentDenied = this.policy.assignedRoom != null
          ? deniedFarmRooms.get(this.policy.assignedRoom) : null;
        const offAssignment = shouldRelocateToAssignedRoom(this.policy, room, deniedFarmRooms,
                                                          this.facultyHeld('movement'));
        if (preyHere && assignmentDenied && this.warnedAssignmentDeferred !== this.policy.assignedRoom) {
          this.warnedAssignmentDeferred = this.policy.assignedRoom;
          this.note('working an alternate room while the assignment is deferred', {
            room: room.name, room_num: room.num,
            assigned_room: this.policy.assignedRoom,
            why_assignment_deferred: assignmentDenied,
            why: 'the assigned room was denied by this keeper\'s bounded room evidence; ' +
                 'sending it straight back would oscillate between assignment and refusal',
            scope: 'session-only — the configured assignment is unchanged and a fresh keeper ' +
                   'can reconsider it',
          });
        }
        if (!preyHere || offAssignment) {
          // MOVEMENT IS LEASED — SOMEBODY ELSE PICKS THE DESTINATION. Restored after the
          // 2026-09-04 merge dropped it; `shouldRelocateToAssignedRoom`'s lease parameter
          // covers the assignment, and this covers every other reason to leave a room.
          //
          // The suspended-journey fix was necessary and not sufficient, because homing is a
          // NEW decision every pass rather than a resumed one. Measured on Sweetums:
          // 587 -> 598 -> 599 -> 2 -> 39, the lease held and live the whole way, crossing
          // the killing ground twice for nothing.
          //
          // Narrow on purpose. This gates the choice of WHERE TO GO and nothing else: the
          // survival ladder, resting, fleeing, self-defence and the Underworld are all
          // decided above this branch on a one-second clock and are untouched — they are
          // PROTECTED_FACULTIES and no lease can take them. A leased character still eats,
          // still fights what is in front of it, still sits down when hurt. It simply does
          // not pick a destination while somebody else is holding its legs.
          //
          // The lease expires in 30s without a heartbeat, so a holder that dies gives the
          // room back on its own rather than leaving a character stranded — which is the
          // hazard the old advisory-only design was written to avoid.
          if (this.facultyHeld('movement')) {
            const owner = this.facultyOwner('movement');
            if (this.notedMovementOwner !== owner) {
              this.notedMovementOwner = owner;
              this.note('movement is leased — not choosing where to go', {
                owner, assigned_room: this.policy.assignedRoom, here: room?.num,
                why: 'the holder decides the destination; this keeper still owns survival, ' +
                     'resting, fighting back and the Underworld' });
            }
            return HANDLED;
          }
          this.notedMovementOwner = null;
          const known = this.preyRooms(room);
          if (known.length) {
            const target = known[0];
            // NOT WHILE HURT OR EMPTY-HANDED. Eleven of the last fifty deaths set off on
            // this exact line. The room is still the wrong room; that is not a reason to
            // arrive at the right one in no state to be there.
            if (!await this.readyToLeaveSanctuary(target.room_name)) return HANDLED;
            // Asked BEFORE giving up a wall and before the relocation bookkeeping: a refusal
            // here is a timer, not a failed route, and counting it as a miss would put the
            // assignment on the unreachable list after three passes.
            if (this.pvpReturnGate(target.room)) return HANDLED;
            this.note(offAssignment ? 'leaving for the explicitly assigned farming room'
                                    : 'this room cannot produce our prey — leaving now', {
              room: room.name, hunting: this.policy.hunt,
              generates: here.map(x => x.creature),
              going_to: target.room_name,
              why: offAssignment ? `room ${this.policy.assignedRoom} is the explicit fleet assignment`
                               : here.length ? 'none of what spawns here is what we hunt'
                               : 'nothing is generated here at all — it is not a hunting ground' });
            this.doing = 'travelling';
            if ((await this.leaveHold('travelling to a room that generates our prey')).refused) return HANDLED;
            // THE THREE THINGS WE WANT TO KNOW ABOUT AN ASSIGNMENT, recorded where a
            // human and an agent can both read them later: does it do what we hoped
            // (did we end up where we were assigned), does it do it every time
            // (drifts vs holds), and how does it fail (why_not, kept verbatim).
            const mine = this.policy.assignedRoom;
            const p = this.placement;
            p.relocations++;
            if (mine != null) p.aimed_at_assignment += (target.room === mine ? 1 : 0);
            const r0 = await this.travel(target.room, { origin: keeperOrigin('hunt_relocation'), maxHops: 14 })
                             .catch(e => ({ arrived: false, reason: e.message }));
            // HANDED TO THE LEVER PUZZLE IS NOT A MISS. Counting it would blacklist the assigned
            // room after three passes (relocFails -> unreachable) for a journey that is going fine.
            if (r0.handed_off) {
              this.progress(`in room ${r0.puzzle ?? r0.room?.num}: the lever puzzle takes it from here`);
              return HANDLED;
            }
            if (r0.arrived) {
              this.homeRoom = target.room;
              this.emptyPasses = 0;
              this.relocFails.delete(target.room);   // it works; forget the near misses
              if (mine != null) {
                if (target.room === mine) p.returned_to_assignment++;
                else { p.drifted++; p.drifted_to[target.room] = (p.drifted_to[target.room] || 0) + 1; }
              }
              this.progress('moved to a room that generates the prey');
            } else {
              p.failed++;
              if (p.why_not.length < 8) p.why_not.push({ room: target.room, why: r0.reason || 'travel did not arrive' });
              // ONE MISS IS NOT A PROOF OF UNREACHABILITY, and treating it as one is
              // how a spread fleet quietly re-collapses: the first transient failure
              // blacklists the ASSIGNED room, so the keeper never tries it again and
              // goes back to the top-ranked room for ever. Both failures seen in
              // practice were transient — a crowded `go` square ("stood on the exit
              // square and nothing happened"), and a route the planner picked through
              // an edge with no floor, which succeeds from a different starting room.
              const n = (this.relocFails.get(target.room) ?? 0) + 1;
              this.relocFails.set(target.room, n);
              if (n >= 3) this.unreachable.add(target.room);
              this.noProgress('cannot reach anywhere that generates ' + huntLabel(this.policy.hunt));
            }
            return HANDLED;
          }
        }
      }

      if (!this.policy.hunt) {
        // No quarry named is the same situation as idle mode: rest up rather than
        // stand there, so that whenever a job does arrive it starts from a full bar.
        if (await this.hibernate('farm mode with nothing named to hunt').catch(() => false)) return HANDLED;
        this.note('idle: nothing to hunt', { hint: 'set policy.hunt to a creature name' });
        return HANDLED;
      }
      // Bags full. This used to stop and say so, and then say so again every eight
      // seconds for as long as you left it — a third of one run spent announcing a
      // problem it could have solved. Sell to anyone here who buys; failing that,
      // drop the biggest pile of junk. Keep money, gems, and anything in use.
      // BROKEN GEAR IS DEAD WEIGHT FROM THE MOMENT IT BREAKS, and until now the only thing
      // that cleared it was `makeRoom`, which fires when the pack is FULL. So a character
      // carried its broken swords for however long it took to fill fifty slots — Floyd had
      // six and Kermit eight — and every one of them was weight and bulk spent on nothing.
      //
      // There is no reason to wait for a full pack to drop something that is useless at
      // every pack size, so this runs on its own clock. `inspectForBroken` is the cheap
      // half and is asked only about SPARES, never the weapon in hand.
      await this.sweepBroken().catch(() => {});
      await this.sweepCursed().catch(() => {});
      this.sweepGearCondition().catch(() => {});
      // Read which weapons are magic, and keep a magic one in hand when the policy asks.
      this.sweepWeaponMagic().catch(() => {});

      // KEEP SHELTER FARMERS ABLE TO PICK UP THE NEXT DROP WITHOUT OPENING A TOWN
      // ERRAND. sellAtLoad answers "when should I visit a merchant"; dropAtLoad is the
      // deliberately local answer for a travel-forbidden shift. It sheds one safe stack
      // per pass, then re-measures from the server-refreshed inventory in makeRoom().
      // One-at-a-time is important: weights are static, but the server is authoritative
      // about whether a particular stacked drop was accepted.
      const dropAt = Number(this.policy.dropAtLoad);
      if (dropAt > 0 && dropAt < 1) {
        const cap = skills.carryCapacity(c);
        const frac = (value, max) => max > 0 && Number.isFinite(value) ? value / max : 0;
        const fullness = cap?.known && cap.load
          ? Math.max(frac(cap.load.weight, cap.weight_max), frac(cap.load.bulk, cap.bulk_max))
          : null;
        if (cap?.load?.exact === false) {
          this.note('cannot prove the shelter pack is below its load ceiling', {
            target_percent: Math.round(dropAt * 100), unweighed: cap.load.unweighed,
            why: 'unknown item weights make the measured load a lower bound; nothing is ' +
                 'guessed disposable from an unknown weight' });
        } else if (fullness != null && fullness > dropAt) {
          const freed = await this.makeRoom();
          this.note('shelter pack above its local load ceiling — ' + freed.did, {
            load_percent: Math.round(fullness * 100), target_percent: Math.round(dropAt * 100),
            ...freed.detail });
          if (freed.ok) this.progress('made local room for the next farm drop');
          else this.noProgress('protected supplies alone exceed the local load ceiling');
          return HANDLED;
        }
      }

      if (c.inventory.length >= this.policy.maxCarry) {
        const freed = await this.makeRoom();
        this.note('bags full — ' + freed.did, { carrying: c.inventory.length, max: this.policy.maxCarry, ...freed.detail });
        if (freed.ok) this.progress('made room in bags'); else this.noProgress('bags full and could not make room');
        return HANDLED;
      }
      let found = skills.findCreature(s, this.policy.hunt, { match: this.huntMatch() });
      this.clearing = null;

      // WHICH SIDE OF THIS ROOM THE PREY IS ON — written down while we can see it, because
      // the question gets asked from the NEXT room, where nothing can answer it.
      //
      // Upstairs Castle Victoria is two islands sharing a room number, and Castle Victoria's
      // four doors into it land on only two squares, one per island. A character arriving by
      // the nearest door has a coin-flip chance of landing where its quarry is not, and then
      // watches six battered skeletons it cannot path to. The spawn index carries no
      // coordinates, so a sighting is the only evidence there is. See m59-preyside.mjs.
      if (found?.length && room?.num != null) {
        const seen = found[0];
        if (Number.isFinite(Number(seen?.col)) && Number.isFinite(Number(seen?.row)))
          try { notePreySide(room.num, this.policy.hunt, { col: seen.col, row: seen.row }); }
          catch { /* the book is an optimisation; never let it break a pass */ }
      }

      // IS THIS ROOM STILL WORTH HUNTING IN, or is it silting up?
      //
      // Asked whether or not our prey is present — see capBlockers().should_clear. The
      // first version only asked when the room held no prey at all, and so did nothing
      // in the case it was built for: two centipedes among eight baby spiders reads as
      // "prey available", and the keeper hunted the two while the eight held the cap.
      // CLEARING IS A FARMING DECISION ABOUT THE ROOM WE FARM. IT IS NEVER A REASON TO
      // STOP GOING SOMEWHERE.
      //
      // The argument for clearing is that the spawn cap is a room-wide TOTAL, so the
      // creatures we decline to kill are what stop our prey appearing. That is true of the
      // room we are ASSIGNED to and meaningless anywhere else: a character standing in a
      // room it is only passing through has no stake in that room's generator, and killing
      // its occupants buys nothing.
      //
      // Worse, it does not merely waste the pass — it CANCELS THE JOURNEY. Clearing issues
      // movement, and a new command cancels the walk in flight. Measured on prod
      // 2026-08-27, Clifford stranded in "Off the beaten path" (room 567) while assigned to
      // 39: 1,322 passes of `clearing the room so it can spawn again` against 8 giant rats
      // in a room with zero of his prey, two passes a second, and his own placement record
      // reading
      //
      //     aimed_at_assignment 3 · returned_to_assignment 0 · failed 3
      //     why_not: [{room: 39, why: "movement cancelled by a newer command"} x3]
      //
      // He tried to go home three times and his own clearing cancelled it every time. He
      // sat there for eighteen minutes, at full health, with nothing wrong with him.
      //
      // So: only clear where we are supposed to be. No assignment means every room is ours
      // to farm and the old behaviour stands, which is what an unassigned character wants.
      const farmingHere = this.policy.assignedRoom == null
        || Number(room?.num) === Number(this.policy.assignedRoom);
      if (!farmingHere && this.policy.clearWeak !== false && this.clearWeakElsewhere !== room?.num) {
        this.clearWeakElsewhere = room?.num;
        this.note('not clearing this room — it is not the one we farm', {
          room: room?.name, here: room?.num, assigned: this.policy.assignedRoom,
          why: 'the spawn cap is a room-wide total for the room we hunt in, and this is not ' +
               'it. Clearing here buys nothing and the movement it issues cancels the walk ' +
               'back to the room that does.',
        });
      }
      if (farmingHere) this.clearWeakElsewhere = null;
      if (farmingHere && this.policy.clearWeak !== false) {
        const capped = this.capBlockers(room);
        if (capped?.should_clear) {
          const target = capped.clearable[0];
          // target.name came out of the catalogue, so it is an identity and must not be
          // widened back into a substring on the way to the room.
          const shot = skills.findCreature(s, target.name, { match: this.huntMatch(target.name) });
          if (shot.length) {
            this.clearing = target.name;
            found = shot;
            this.note('clearing the room so it can spawn again', {
              killing: target.name, of_them: target.count,
              room: room?.name, at_cap: `${capped.present}/${capped.cap}`,
              prey_present: capped.prey_present, hunting: this.policy.hunt,
              why: capped.why_clear,
              note: 'the cap is a room-wide total, so what we decline to kill is what ' +
                    'stops our prey appearing. Leaving would not reset it.' });
          }
        // A CAP FULL OF OUR OWN PREY IS NOT A BLOCKED ROOM. Every kill frees a slot, so the room
        // keeps producing for as long as we keep killing. 2026-09-27, Ukgoth: 18/15 was three
        // Guardians of Zjiria and fifteen trolls, and the denial fired anyway — Janice and Animal
        // walked out of the troll room mid-streak (five kills between them) for room 516. Only a
        // cap with NONE of the prey present is one that nothing we do will reopen.
        } else if (capped?.full && !capped.clearable.length && capped.blocked.length
                   && !(capped.prey_present > 0)) {
          // Cannot clear it, so the room is finished for us — and it will still be
          // finished when we come back, because an abandoned full room keeps its
          // generator switched off. Go, and prefer somewhere else next time.
          const reason = `spawn cap ${capped.present}/${capped.cap} is occupied by ` +
            capped.blocked.map(b => `${b.count}x ${b.name}`).join(', ') +
            ' that this keeper will not safely fight';
          (this.cappedRooms ??= new Map()).set(room.num, reason);
          this.tally.rooms_denied = farmRoomDenials(this.noWallRooms, this.cappedRooms).size;
          this.note('this room is capped by things we will not fight', {
            room: room?.name, at_cap: `${capped.present}/${capped.cap}`,
            blocked_by: capped.blocked.map(b => `${b.count}x ${b.name} — ${b.why}`),
            why: 'the generator is gated on the room total, so nothing new spawns while ' +
                 'these are alive. Leaving does NOT reset it (monsroom.kod:353 only ' +
                 'reloads a room left with zero monsters) — this is giving it up.',
            doing_instead: 'leaving for a different room that generates the prey',
            goal_scope: 'this refuses only the current room for this keeper session; the ' +
                        'strategic goal remains active',
          });

          // GIVING UP A ROOM MUST ACTUALLY LEAVE IT. `roam` is deliberately false for
          // assigned keepers, so gating this transition on policy.roam turned the line
          // above into narration rather than behavior. Select through preyRooms(), which
          // now excludes both wall-refused and cap-blocked rooms, and use the same bounded
          // travel path as the no-wall refusal below.
          const elsewhere = this.preyRooms(room);
          if (elsewhere.length) {
            this.doing = 'travelling';
            await this.leaveHold('leaving a room whose spawn cap cannot recover',
                                 { force: true }).catch(() => {});
            const go = elsewhere[0];
            const moved = await this.travel(go.room, { origin: keeperOrigin('spawn_cap_relocation'), maxHops: 14 })
                                    .catch(e => ({ arrived: false, reason: e.message }));
            if (moved.arrived) {
              this.homeRoom = go.room;
              this.emptyPasses = 0;
              this.placement.relocations++;
              this.note('left a spawn-blocked hunting room', {
                from: room.name, to: go.room_name, room: go.room,
                why: reason,
                note: 'the abandoned room stays denied only for this keeper session',
              });
              this.progress('left a room whose spawn cap cannot recover');
              return HANDLED;
            }
            this.note('could not leave the spawn-blocked room', {
              room: room.name, tried: go.room_name, why: moved.reason,
            });
          } else {
            this.note('no alternate room remains for this prey', {
              room: room.name, hunting: this.policy.hunt,
              why: 'every generated hunting ground is unreachable or has a session-local ' +
                   'room refusal; this does not block the goal from being replanned',
            });
          }
          this.noProgress('room capped by creatures we will not fight');
          return HANDLED;
        }
      }

      // A QUARRY IN ANOTHER PART OF THIS ROOM MAY REQUIRE LEAVING THE ROOM TO
      // REACH IT. Castle Victoria's upstairs is the worked example: changing wings is
      // 39 -> 38 -> 39. Filtering at the source is important. Refusing the bridge only
      // inside takeSafeSpot leaves the keeper repeatedly selecting the unreachable
      // creature, and a cap-clearing target can replace the ordinary prey above, so this
      // one filter deliberately runs after both selections and before quarry ranking.
      const visibleBeforeConfinement = found;
      found = found.filter(target => quarryPermittedByConfinement({
        map: s.world?.map,
        room,
        geo: s.world?.geometry,
        from: c.self,
        target,
        confineRooms: this.policy.confineRooms,
      }));
      if (visibleBeforeConfinement.length && !found.length) {
        // This is a vigil, not an empty hunting room. Do not let the normal empty-pass
        // machinery count toward roaming, and do not retain an advisory claim on prey
        // this keeper is forbidden to cross the room boundary to reach.
        releaseQuarry(this.s.name);
        this.clearing = null;
        this.emptyPasses = 0;
        const alreadySheltered = !!this.hold && !!this.holdWorks?.();
        const shelter = alreadySheltered
          ? { took: true }
          : await this.takeSafeSpot(
              'all visible quarry is across a split-room bridge outside the confinement', null)
              .catch(e => ({ took: false, why: e.message }));
        this.doing = 'waiting';
        this.note('visible quarry is outside this room component — sheltering in place', {
          room: room?.name,
          excluded: visibleBeforeConfinement.length,
          confined_to: Array.isArray(this.policy.confineRooms)
            ? this.policy.confineRooms.map(Number) : [],
          sheltered: !!shelter.took,
          why_not_sheltered: shelter.took ? undefined : shelter.why,
          why: 'reaching it would temporarily leave the permitted rooms; waiting here keeps ' +
               'the confinement intact and lets this component\'s next spawn come to us',
        });
        return HANDLED;
      }

      // PREY WE HAVE PROVED WE CANNOT WALK TO IS NOT A QUARRY, HERE AS IN fight().
      //
      // `preyAvoid` was only ever handed to fight(), never consulted by the selection that
      // chooses what fight() is sent at. The two disagreed, and the disagreement is a loop:
      // the selection ranks the nearest creature first, fight() is pinned to that exact id
      // (`exactTargetId`), filters it out through the same avoid set, and answers "nothing
      // here matches — try one of the names above". No `out_of_reach`, so no pull and no
      // close; the pass logs "broke off" and the next pass picks the same creature again.
      //
      // Measured on prod 2026-09-25 in the Icky Cave (27): six characters on proven walls at
      // r27-32 c41-45, the west lip of the one-way pocket (rows 17-34, cols 46-56) that holds
      // two of the room's generators. The nearest orc was in the pocket every time, proved
      // unreachable, and re-selected once a second — `broke off` x12 in every journal, zero
      // landed hits, 0-2 kills in thirty minutes per character in a room at its cap of ten.
      //
      // Same predicate, same square key, same TTL as fight() uses, so this can only ever
      // agree with it. When it empties the list the pass falls through to the ordinary
      // empty-pass handling, which waits at a working wall for the next reachable spawn.
      const avoidPrey = this.preyAvoid(room?.num ?? null);
      if (avoidPrey && found.length) {
        const reachable = found.filter(o => !avoidPrey(o));
        if (!reachable.length && (!this.allPreyAvoidedAt || Date.now() - this.allPreyAvoidedAt > 60_000)) {
          this.allPreyAvoidedAt = Date.now();
          this.note('every visible quarry is somewhere we proved we cannot walk to', {
            room: room?.name, skipped: found.length,
            at: found.slice(0, 6).map(o => `r${o.row}c${o.col}`),
            why: 'selecting one anyway would pin fight() to a creature its own avoid filter ' +
                 'removes — a broke-off loop with no pull and no close. Waiting for one on ' +
                 'our side instead; the memory expires in a few minutes and is re-tested' });
        }
        found = reachable;
      }

      // THE HUNT AREA (policy.huntArea): in its room only quarry standing inside it is chosen. Everything
      // outside is left for whoever is not bound to the area; with nothing inside, the pass is empty and the
      // empty branch below walks us back onto the area.
      const huntArea = this.huntAreaHere(room?.num);
      if (huntArea && found.length) {
        const inside = found.filter(o => huntArea.has(`${o.row},${o.col}`));
        if (inside.length < found.length) this.huntAreaSkipped = { at: Date.now(), skipped: found.length - inside.length };
        found = inside;
      }

      // ONE NEAREST TARGET PER KEEPER PRODUCES A PILE, NOT A FLEET.
      // Keep a wounded foe first, then a partner's deliberate shared target, otherwise
      // prefer the least-claimed creature while retaining findCreature's distance order
      // as the tie-break. This is advisory: with ten monsters and twenty-one keepers the
      // second lap still happens, but only after all ten have somebody assigned.
      let coolingTargets = [];
      if (found.length) {
        // A quarry whose live position stopped closing after a tagged pull gets a short
        // room-local cooldown. Do not immediately select it again; only a creature already
        // within guaranteed melee reach is exempt because immediate survival outranks rotation.
        const meNow = c.self;
        found = found.filter(o => {
          const cooling = this.pullTargetCooling(room?.num, o.id);
          if (!cooling) return true;
          const urgent = meNow && Math.hypot(o.col - meNow.col, o.row - meNow.row) <= PLAYER_REACH;
          if (urgent) return true;
          coolingTargets.push({ o, cooling });
          return false;
        });
      }
      if (found.length) {
        // Finish reachable prey before spending a round trip through another room.
        // Advisory target claims must not make an inaccessible monster outrank one
        // on our own side. Only restrict when the bridge planner proves the split.
        const local = found.filter(o => !sameRoomIslandBridgePlan(s.world?.map,
          room?.num, s.world?.geometry, c.self, o));
        if (local.length) found = local;
        const agreed = party.agreedTarget(this.s.name);
        const preferId = found.some(o => o.id === this.pendingPull?.target_id)
          ? this.pendingPull.target_id
          : found.some(o => o.id === this.foeId) ? this.foeId
          : found.some(o => o.id === agreed?.id) ? agreed.id : null;
        found = rankQuarries(this.s.name, room?.num, found, { preferId });
        // hunt_priority: reorder only — every filter above has already run (m59-hunt-priority.mjs).
        if (this.policy.huntPriority) found = this.huntPriorityOrder(found, preferId);
        claimQuarry(this.s.name, room?.num, found[0]?.id);
        // THE TOUCH AT THE TARGET (touch_spell_timing 'on_target'): the quarry is chosen, so cast
        // now, during the approach. A no-op unless training a touch spell here. m59-touchspell.mjs.
        if (found[0] && this.touchTrainingHere())
          await this.touchOnTarget(found[0], c.rsc?.get?.(found[0].nameRsc) || found[0].name || null)
            .catch(e => { const st = this.touchState(); if (st) st.blockedReason = e.message; });
      } else {
        releaseQuarry(this.s.name);
      }

      if (!found.length && coolingTargets.length) {
        this.emptyPasses = 0;
        this.doing = 'waiting';
        const soonest = Math.min(...coolingTargets.map(x => x.cooling.until));
        if (coolingTargets.some(x => !x.cooling.waitNoted)) {
          for (const x of coolingTargets) x.cooling.waitNoted = true;
          this.note('waiting for a different quarry after one stopped following', {
            skipped: coolingTargets.map(x => ({ id: x.o.id, name: c.rsc.get(x.o.nameRsc) })),
            retry_in_ms: Math.max(0, soonest - Date.now()),
            holding_wall: this.hold
              ? { room: this.hold.room, col: this.hold.col, row: this.hold.row } : null,
            why: 'immediately selecting the same non-follower would repeat the pull; a new ' +
                 'visible target will be chosen as soon as one is available',
          });
        }
        return HANDLED;
      }

      if (!found.length && huntArea && c.self && !huntArea.has(`${c.self.row},${c.self.col}`)) {
        // OUTSIDE THE HUNT AREA WITH NOTHING TO DO: walk back onto it rather than holding a wall elsewhere.
        // Not onto a square a body already holds: measured 2026-10-16, seven farmers walked back to the
        // same nearest square of the Castle Victoria door cone.
        const taken = new Set([...(c.room?.objects?.values?.() ?? [])].filter(o => o.id !== c.selfId)
          .map(o => `${o.row},${o.col}`));
        const back = this.nearestHuntAreaSquare(huntArea, c.self, taken);
        if (back) {
          if (this.hold && !huntArea.has(`${this.hold.row},${this.hold.col}`)) this.hold = null;
          this.doing = 'returning to the hunt area';
          const w = await s.walkTo(back.col, back.row, { maxSteps: 40 }).catch(e => ({ arrived: false, reason: e.message }));
          this.huntAreaReturn = { at: Date.now(), to: back, arrived: w?.arrived === true, reason: w?.arrived ? null : (w?.reason ?? null) };
          return HANDLED;
        }
      }

      if (!found.length) {
        // HOLDING A WALL IN A ROOM THAT SPAWNS IS WORK. WAITING IS THE JOB.
        //
        // An empty pass means "nothing of ours is visible RIGHT NOW", and in a spawning
        // room that is the normal state between a kill and the next wanderer. Monsters
        // take their time crossing a big outdoor room, and the whole value of a safe spot
        // is that waiting there costs nothing — nothing can reach the square, so patience
        // is free and the alternative is walking around in the open looking for a fight.
        //
        // Counting those passes the same as fruitless ones is what makes a character give
        // up a proven square and roam, which is both worse ground and the state most of
        // the death record happens in ("travelling" and "recovering" are 21% and 35% of
        // deaths; "fighting" is 17%). A spot that took a walk and a probe to find should
        // not be abandoned because the room was quiet for eight seconds.
        //
        // So while we are holding a working spot in a room that generates our prey, an
        // empty pass is not counted at all. Everything that ends a vigil for a real
        // reason still fires: being hit in the spot releases it, the room going capped is
        // handled above, hunger and health run on their own clocks.
        //
        // BUT ONLY WHERE THE WAIT CAN END. "This room spawns" is not "this room spawns OUR
        // quarry", and neither is "this is where we were told to be". A keeper re-tasked while
        // standing on a proven wall — new hunt, new assigned room — took this branch on every
        // pass and never reached the station walk below it, because this returns first.
        // Measured on prod 2026-09-25: six characters re-assigned from Castle Victoria (38)
        // to the Icky Cave (27) held their 38 walls for ten minutes, full health, reading
        // "holding a proven safe spot", hunting orcs and spiders in a room of skeletons and
        // zombies, until a fleetscript walked them over. Both conditions are the ones the
        // station walk below already tests, computed once and shared.
        // Only when an order names a quarry — with policy.hunt unset every room fails this
        // test and the fleet would walk home from everywhere.
        const spawnHere = loadSpawns(SPAWN_FILE)?.rooms?.[room?.num] || [];
        const producesQuarry = !this.policy.hunt ? true
          : spawnHere.some(x => x.huntable && this.huntMatch()(x.creature));
        // A room the spawn table does not list is a gap in the table, not a barren room, so it
        // keeps the vigil it always had rather than being walked away from.
        const waitingInASpot = !!this.hold && this.holdWorks() && !this.sanctuary(room)
          && (producesQuarry || !spawnHere.length) && !this.awayFromStation(room);
        if (waitingInASpot) {
          this.doing = 'waiting';
          if (!this.waitedInSpotAt || Date.now() - this.waitedInSpotAt > 60_000) {
            this.waitedInSpotAt = Date.now();
            this.note('holding the spot and waiting for something to come to us', {
              room: room?.name, spot: { col: this.hold.col, row: this.hold.row },
              proven: this.hold.proven,
              why: 'nothing in reach this pass, but this room spawns and the square holds. ' +
                   'Waiting behind a wall costs nothing; wandering to find a fight is how ' +
                   'characters end up dying while travelling' });
          }
          return HANDLED;
        }
        this.emptyPasses++;
        // A ROOM THAT SPAWNS NOTHING IS NOT AN EMPTY ROOM, AND WAITING IN IT IS NOT WORK.
        //
        // "They respawn eventually" is true of a hunting ground between spawns and false
        // of a tavern. This branch could not tell them apart, so a character that drifted
        // into an inn after a death or a shop trip stood there for the rest of the
        // session logging "nothing to hunt here" — perfectly accurately — and roam:false
        // meant it never left.
        //
        // Fourteen of twenty-one were doing exactly that: Kermit and Floyd in Cibilo
        // Creek Inn, Statler in The Limping Toad, Janice in Marion, Pepe and Camilla in
        // Barloque. Three characters were producing every kill the fleet made.
        //
        // sanctuary() already answers "does anything huntable spawn here". When the
        // answer is no, leaving is not roaming — it is going to work — so it does not
        // wait on the roam permission, which exists to stop characters wandering off
        // productive ground.
        // A ROOM THAT CANNOT PRODUCE OUR QUARRY IS AS USELESS AS ONE THAT SPAWNS NOTHING.
        //
        // The branch below was gated on sanctuary() alone — "does anything huntable spawn
        // here" — which catches the tavern and misses the wilderness. A character that dies
        // on the road, or finishes a shop trip, lands in a forest that spawns plenty and
        // none of it is a battered skeleton; sanctuary() is false, so it stands there
        // logging "nothing to hunt here", perfectly accurately, for the rest of the session
        // with roam:false meaning it never leaves. Statler did minutes of it at Off the
        // beaten path and the Lake of Jala's Song, hunting quarry that spawns in neither.
        //
        // The distinction the branch actually wants is not "is anything here" but "is
        // anything here that I AM ALLOWED TO KILL". Both answers mean the same thing about
        // waiting: a respawn cannot fix it, because what respawns is not what we are for.
        //
        // `producesQuarry` is computed above, beside the wall vigil that needs it too.
        const inSanctuary = this.sanctuary(room);
        // A STATION IS AN ORDER, AND BEING SOMEWHERE ELSE IS REASON ENOUGH TO WALK.
        //
        // This branch used to fire only in a sanctuary or in a room that cannot produce our
        // quarry. Both are good reasons and neither covers the commonest one: we were told
        // where we live, we are not there, and nothing is happening here.
        //
        // `roam: false` DOES NOT MEAN "GO TO YOUR STATION AND STAY". It means idle wherever
        // you happen to be standing — so a character whose journey ended anywhere short of
        // its destination stands there for ever, and nothing reports it: `activity: idle`,
        // `stalled: false`, `busy` unset, `committed` null. Every detector we have is
        // looking for a character that cannot move, and this one simply has nothing telling
        // it to.
        //
        // Measured on prod 2026-09-05: twelve characters dispatched to the Duke's feast hall
        // were standing in the Graveyard of Tos, the Cragged Mountains, Ukgoth, the
        // Underworld and their own home room — every one of them with `assigned_room: 953`,
        // `roam: false` and `activity: idle`. The feast trip arrived 56 times out of 438,
        // and this is where the other 382 went. It also starved the sell circuit, because
        // cleaning up after a failed journey is an errand and it wins the fleet pass.
        //
        // Only `policy.assignedRoom` counts here, never `homeRoom`: the first is an explicit
        // order somebody gave, the second is just wherever we last settled, and walking
        // "back" to that would move characters nobody asked to move.
        const awayFromStation = this.awayFromStation(room);
        if ((inSanctuary || !producesQuarry || awayFromStation) && this.emptyPasses >= 2) {
          // policy.assignedRoom is where `spread` put us; homeRoom is where we last
          // settled. `this.assignedRoom` does not exist — reading it would have made this
          // whole branch quietly do nothing, which is the failure mode this fix is about.
          const home = this.policy.assignedRoom ?? this.homeRoom;
          if (home != null && home !== room?.num) {
            // The other door out of an inn, and it killed Zoot, Piggy and Rizzo inside
            // twenty minutes: all three woke up in a tavern after a death, took this
            // branch on pass 2, and never got to the unarmed check further down because
            // they were already walking. Going back to work is right; going back to work
            // hurt and bare-handed is what the last twenty minutes of records are.
            if (!await this.readyToLeaveSanctuary(home)) return HANDLED;
            this.note(inSanctuary ? 'this room spawns nothing at all — going back to work'
                      : !producesQuarry ? 'this room cannot produce our quarry — going back to work'
                      : 'not at our assigned station — walking to it', {
              room: room?.name, room_num: room?.num, going_to: home,
              hunting: this.policy.hunt, produces_quarry: producesQuarry,
              // WHICH of the three reasons fired, because they have different fixes: a
              // sanctuary means we died or shopped, a barren room means the orders and the
              // spawn table disagree, and this one means a journey ended short.
              reason: inSanctuary ? 'sanctuary' : !producesQuarry ? 'no_quarry' : 'away_from_station',
              why: 'a tavern has no spawn table, so waiting for a respawn here waits for ' +
                   'something that cannot happen. This is not roaming; roam guards against ' +
                   'leaving GOOD ground, and this is not that.' });
            this.doing = 'travelling';
            const moved = await this.travel(home, { origin: keeperOrigin('station_return'), maxHops: 20 })
                                  .catch(e => ({ arrived: false, reason: e.message }));
            if (moved.arrived) { this.emptyPasses = 0; this.progress('left a room that spawns nothing'); return HANDLED; }
            this.note('could not get back to the assigned room', { going_to: home, why: moved.reason });
          }
        }
        if (this.policy.roam && this.emptyPasses >= this.policy.roamAfterEmptyPasses) {
          await this.roam(room);
        } else {
          this.note('nothing to hunt here', {
            looking_for: this.policy.hunt, room: room?.name, empty_passes: this.emptyPasses,
            hint: this.policy.roam ? undefined
              : 'they respawn eventually; set roam:true to move on instead of waiting',
          });
        }
        return HANDLED;
      }
      this.emptyPasses = 0;

      // (Provisioning ran further up, before the prey lookup. It was here, and being here
      // meant it was skipped on every pass that found nothing to fight.)

      // ARMED? Both of this fleet's characters-can-fix-it-themselves problems are
      // checked in the same place and for the same reason: they are silent. An empty
      // larder caps vigor at what resting gives, and an empty hand turns every fight
      // into punching — and the server reports neither. `create food` and `create
      // weapon` are carried by every character here, so the first question when either
      // is missing is whether we can simply make one.
      // The clear that used to be here asked whether a weapon was in the PACK, which is not
      // the question the refusal was raised on and left it standing on characters that were
      // demonstrably armed. It is done on `isArmed`, every pass, at the top of the arming
      // stage — see the note there. Carrying one it may not wield is exactly the state this
      // fleet is in, so the pack is the wrong evidence.
      //
      // THE TRAINING WEAPON FIRST, AND ON ARMED CHARACTERS TOO. The roulette was first hooked
      // inside armSelf(), and every caller of armSelf() asks it only when the character is
      // UNARMED — so a character holding a long sword and told to train hammers never reached
      // it: prod, 2026-09-25, thirteen trainers, zero casts after the deploy. This is the one
      // stage every farm pass crosses before a fight, armed or not.
      await this.trainingWeaponRoulette().catch(e =>
        this.note('training-weapon roulette failed', { why: e.message }));
      if (!skills.weaponsOf(this.s.client).length) {
        const armed = await this.armSelf().catch(() => false);
        if (!armed) {
          this.note('about to fight unarmed', {
            mana: this.s.client?.vitals?.()?.mana?.value,
            why: 'no weapon in the pack and create weapon could not be cast — it needs 15 mana',
            note: 'UserAttack falls back to a punch silently, so this would otherwise look like ' +
                  'a character that is fighting badly rather than one that is not armed' });
        }
      }

      // Resume the creature we already hurt rather than whatever is nearest now. A
      // kill scores nothing unless we damaged it and it was our current target, and
      // each new attack resets both flags — so breaking off at 40% health and then
      // starting fresh on a different monster silently throws away every point of
      // progress the first fight earned.

      // Refuse the fight outright if we are not healthy enough to take it. Heal
      // first — that is a real action now, not a euphemism for resting.
      const safe = this.safety();
      if (hp !== null && hp < safe.engageAt) {
        const h = await skills.healUp(s, { target: 0.95, allow: healAllowOf(this) }).catch(() => ({ healed: false }));
        this.recordHealUse(h, 'too hurt to start the fight in front of us');
        if (h.healed) this.note('healed before engaging', { used: h.used, health: h.health });
        else {
          this.note('too hurt to start a fight', {
            health: Math.round(hp * 100) + '%', need: Math.round(safe.engageAt * 100) + '%',
            worst_single_hit: safe.maxHit,
            why: 'a single hit can take ' + safe.maxHit + ' of ' + (s.client.vitals()?.health?.max) +
                 ', and health does not come back on its own' });
          // ONLY WHEN ACTUALLY BADLY HURT. engageAt is a "do not START a fight" line,
          // not a distress signal — for a character under thirty max health it sits at
          // 90%, so this was broadcasting for a rescue at 89% health, every five
          // minutes, in front of everybody. Being unready to pick a fight and being in
          // trouble are different states and only one of them is worth asking about.
          if ((hp ?? 1) < 0.35)
            await this.askForHelp('badly hurt and out of flasks').catch(() => {});
          // NOT A STALL — PROVIDED WE ARE ACTUALLY RECOVERING. Regenerating on the
          // vigor timer is the most useful thing available and calling it a stall made
          // a working system look broken. But the claim has to be true: if we got here
          // it means the rest branch above declined, which now happens only when
          // something hostile is stood over us, and a character being hit while
          // refusing to fight or flee is the definition of stuck. Reporting progress
          // in that state is what let the dead zone hide for so long.
          this.doing = 'recovering';
          // `near` IS NOT IN SCOPE HERE — it never was. Every other pass declares its own
          // (passFleeAndRest, line ~10635); this one read a name that exists only in the
          // comments around it, so the first hurt character to reach this branch threw
          // `ReferenceError: near is not defined`, the pass died as "pass failed", and the
          // character did nothing that pass — which for a hurt character stood next to a
          // monster is the worst possible pass to lose. Piggy in the valley and Janice in
          // Castle Victoria, 2026-08-26/27. What the note wants is "what is stood over us",
          // which is inReachOfUs(): the same filter passFleeAndRest builds by hand.
          const near = this.inReachOfUs();
          if (near.length) {
            this.note('cornered while too hurt to engage', {
              health: Math.round(hp * 100) + '%', crowd: near.length,
              what: near.map(o => c.rsc.get(o.nameRsc)),
              why: 'cannot rest with something on us and not healthy enough to start a fight' });
            this.noProgress('too hurt to fight and not safe enough to rest');
          } else {
            this.progress('recovering to fighting strength');
          }
          return HANDLED;
        }
      }
      // TOO TIRED TO START. Checked before choosing a wall, not after, because the
      // answer is the same either way — go and sit down — and doing it here means a
      // character that is out of vigor spends its pass recovering rather than walking
      // somewhere to be out of vigor in.
      //
      // The retreat is deliberately TO A SAFE SPOT rather than away: resting is what
      // is needed, resting next to a monster is only possible behind a wall, and a
      // character that has to leave the room to recover has to walk back afterwards
      // through everything it just walked past.
      const vigorNow = vigorOf(v);
      const vigorFloor = this.fightFloor();
      // THE INKY RESERVE. A character can be BELOW the floor and unable to do anything
      // about it, because the food that would fix it is too big to fit.
      //
      // `eat` refuses anything that would carry vigor past 200, and an inky cap is fifty
      // — the most vigor per unit of stomach in the game, which is why a well-supplied
      // character is usually holding one. So at 177 with an inky and an empty stomach
      // there is nothing to eat, nothing to rest for (resting stops at 80), and a floor
      // of 180 it cannot reach. Measured: three characters sat behind proven walls doing
      // exactly this, fully supplied, at 165, 166 and 177 against a floor of 180 — zero
      // fighting and zero travel, indefinitely, while reporting themselves healthy.
      //
      // Fighting is what breaks the deadlock: it burns about thirty vigor a minute, which
      // is what makes room for the inky. So when the shortfall is smaller than the food
      // being carried, go and fight — the reserve is in the pack, not in the bar.
      //
      // Bounded deliberately. It only applies while a reserve is actually held and only
      // down to `inky_reserve_floor`, so it relaxes the wellfed floor rather than removing
      // the survival one: a character still will not open a fight exhausted.
      const reserve = this.policy.inkyReserve === true ? this.uneatableReserve(vigorNow) : null;
      const reserveFloor = Math.max(MIN_FIGHT_VIGOR, this.policy.inkyReserveFloor ?? 120);
      if (reserve && vigorNow != null && vigorNow >= reserveFloor && vigorNow < vigorFloor) {
        this.note('below the fighting floor with a reserve in the pack', {
          vigor: vigorNow, floor: vigorFloor, holding: reserve.name, worth: reserve.nutrition,
          would_reach: vigorNow + reserve.nutrition, cap: 200,
          why: 'it cannot be eaten without overshooting the cap, and resting stops at 80 — ' +
               'fighting is what makes room for it' });
      } else if (vigorNow != null && vigorNow < vigorFloor) {
        this.vigor.waited++;
        this.doing = 'recovering';
        // A wall first, if one is going and we do not already have it — resting with
        // something adjacent is only safe behind one.
        if (!this.hold && room)
          await this.takeRecoverySpot('too tired to fight — need somewhere safe to rest')
            .catch(() => {});
        const r = await skills.restUntil(s, {
          health: 0.98, vigor: REST_VIGOR_CAP, maxSeconds: 120 }).catch(() => null);
        this.tally.rests++;
        this.note('too tired to start a fight', {
          vigor: vigorNow, need: vigorFloor, after_resting: r?.vitals?.vigor?.value,
          behind_a_wall: !!this.hold,
          why: 'attacking costs about thirty vigor a minute and vigor also sets how fast health ' +
               'comes back, so starting a fight below ' + vigorFloor + ' means breaking off ' +
               'part-way and recovering slower than if we had waited',
          note: (r?.vitals?.vigor?.value ?? 0) < vigorFloor && !this.hadFood
            ? 'resting alone stops at 80; if this does not clear, the character needs food'
            : undefined });
        this.progress('resting up to fighting vigor');
        return HANDLED;
      }

      if (await this.bridgeToQuarry(found[0])) return HANDLED;

      // PUT YOUR BACK TO A WALL BEFORE FIGHTING ANYTHING WORTH FIGHTING.
      //
      // This used to trigger on a crowd of three, which reads as caution and is
      // actually the wrong test: it made the safe spot an emergency measure for when
      // things had already gone wrong, when it is really the normal way to fight.
      // Every fight the keeper picks on purpose is against something at or above its
      // own level — that is what makes the kill pay at all — and something at your
      // own level can take a third of your bar in one blow.
      //
      // So the test is the owner's rule of thumb, which is also the game's own
      // advancement rule: IF YOU CAN GAIN MAX HEALTH FROM IT, FIGHT IT FROM A WALL.
      // See holdWorthwhile(). Against prey we genuinely outclass, and only then, the
      // walk to the corner costs more than the fight does.
      const foundNames = [...new Set(found.map(o => c.rsc.get(o.nameRsc)))];
      const worth = this.holdWorthwhile([...new Set([...foundNames, ...this.threat().names])]);
      const selectedQuarry = found[0] ?? null;
      // A safe spot is part of a quarry/spot pair, not a room-wide home forever. Once
      // the selected quarry changes, recompute the closest valid wall for the new one.
      // Do not step off a wall while something is already in melee range; finish that
      // immediate contact first, then rebind on the next pass.
      if (worth.hold && this.hold && selectedQuarry
          && this.hold.quarry_id !== selectedQuarry.id
          && !this.pendingPull && !(this.inReachOfUs()?.length)) {
        this.releaseHold('the selected quarry changed — recomputing its closest safe spot');
      }
      // A WALL TAKEN AS A RESPONSE HAS TO BE GIVEN BACK, OR THE SETTING IS A ONE-WAY DOOR.
      //
      // Under NOT REQUIRED the wall is held because two things were hitting us. Without
      // this, the first crowd of the session takes a corner and the character stays in it
      // for ever — which is the REQUIRED behaviour arrived at by accident, and it would
      // look exactly like the setting working.
      //
      // THE RELEASE BAR IS ZERO IN REACH, NOT "BELOW THE TAKE BAR", and the gap between
      // the two is deliberate hysteresis. Releasing at one attacker would step off the
      // wall the instant a crowd of two became a crowd of one — mid-fight, with something
      // still swinging — and the next pass would find two again and walk back. Take at
      // two, hold while anything is in contact, let go when the floor is clear.
      if (!opensFightFromWall(this.policy) && this.hold && !worth.hold
          && !this.pendingPull && !(this.inReachOfUs()?.length)) {
        this.releaseHold('the crowd this wall was taken for has cleared, and the wall is ' +
                         'not required here — back to fighting in the open');
      }
      if (worth.hold && !this.hold && room) {
        // The quarry was ranked and claimed above. Its identity stays attached to the
        // hold and through the pull; distance to it is the selector's primary order.
        const t = await this.takeSafeSpot(worth.why, selectedQuarry);
        if (t.took) {
          // Do not burn the pass on arriving. The whole point of the spot is that the
          // fight happens here, and the fight is directly below.
          this.progress('took up a defensible position');
        } else if (!this.warnedNoSpot || this.warnedNoSpot !== room.num) {
          // Say this once per room rather than every eight seconds: a room with no
          // corner in it is a fact about the room, not an event.
          this.warnedNoSpot = room.num;
          this.note('no safe spot available here', {
            room: room.name, why: t.why,
            consequence: 'fighting in the open, so the flee threshold is doing all the work',
            hint: 'somewhere with a wall to put our back to would be worth moving to' });
        }
      }

      // NO WALL, NO FIGHT — AND THE ROOM IS WRITTEN OFF UNTIL SOMEONE FIXES DETECTION.
      //
      // Not "prefer a wall". A room this keeper cannot find a defensible square in is
      // treated as UNUSABLE and left, whatever is standing in it and whatever its
      // level. That is a deliberate over-reaction and it is worth being explicit about
      // why, because it will make the fleet refuse places it could probably survive:
      //
      // The wall is the entire survival model. In a spot that holds, nothing lands a
      // blow unless we swing first, so a fight is a sequence of exchanges we choose;
      // in the open it is a race between their damage and our health, which is the
      // race the death log is made of — characters going from full health to dead
      // inside one eight-second pass, faster than any withdrawal could have helped.
      //
      // And this keeper's detection is known to be weak rather than merely unlucky.
      // The candidate ranking was, until recently, capped at the 400 best-scoring
      // squares in the room, which in a large outdoor room filled up with alcoves
      // before a single plain wall edge was considered — and a plain edge is exactly
      // what the known-good squares are. So "found no wall here" has often meant "did
      // not look properly".
      //
      // The honest response to a detector we do not trust is to STOP, not to guess. So
      // a room with no wall we can find is a denial of service for that area: recorded,
      // reported, and left alone until better detection earns it back. Under-using the
      // world is recoverable; the alternative is not.
      // GATED ON THE OPENING PULL, because that is what it is a consequence of: if a
      // fight may only be opened from a wall, a room with no wall cannot be fought in.
      // With `pullToSafeWall` false the fight opens in the open and the room is fine.
      if (opensFightFromWall(this.policy) && !this.hold && room?.num != null) {
        // Ask once per room, not once per pass. takeSafeSpot is a scan plus pathfinds,
        // and the answer does not change while we stand here — but it DOES change when
        // the book learns something, so this is per session rather than persisted.
        if (!this.noWallRooms) this.noWallRooms = new Map();
        let denied = this.noWallRooms.get(room.num);
        if (denied === undefined) {
          const probe = await this.takeSafeSpot(
            'testing whether this room can be fought in at all', found[0] ?? null)
            .catch(() => ({ took: false, why: 'the search threw' }));
          // DENY THE ROOM ONLY WHEN NO SQUARE WAS FOUND — not when we failed to WALK to
          // one. Those are different facts about different things: the first is about
          // the room, the second is about us, and takeSafeSpot returns took:false for
          // both. Conflating them meant a character that could not cross the floor
          // (blocked, mid-fight, position unsettled after an edge crossing) wrote off a
          // room full of walls, permanently for that session, and then had nowhere to
          // go because preyRooms excludes denied rooms. Three characters were stuck
          // exactly that way, reporting "no safe wall here and nowhere better to go"
          // about rooms with hundreds of usable squares in them.
          //
          // A walk that failed is retried next pass, which costs a pass. A room wrongly
          // denied costs the room.
          const noneExist = !probe.took && /more defensible than open floor|out of the fight/i
                              .test(String(probe.why || ''));
          denied = probe.took ? false : (noneExist ? (probe.why || 'no defensible square found') : undefined);
          if (denied !== undefined) {
            this.noWallRooms.set(room.num, denied);
            // Data, not a sentence. The supervisor used to read this off the prose.
            if (denied) this.refuse('NO_SAFE_WALL', {
              faculty: 'work', blocking: true,
              why: `no wall in ${room.name} held under test: ${denied}`,
              remedy: 'assign a different room; the keeper relocates itself',
              retryAfterMs: 600_000 });
            else this.clearRefusal('NO_SAFE_WALL');
          }
          else this.note('could not reach a wall this pass — not blaming the room', {
            room: room.name, why: probe.why,
            note: 'the room has candidate squares; getting to one failed, which is about us ' +
                  'and is retried next pass' });
        }
        // WHEN THE CHARACTER CAN AFFORD AN OPEN FIGHT, TAKE IT.
        //
        // Refusing outright turned a risk into a certainty. With this absolute, the fleet
        // spent 95% of its time travelling and 0% fighting: fifteen of twenty-one walked
        // between rooms looking for one the detector approved of, scored no kills in
        // forty-five minutes, and lost four levels to the deaths that happened anyway.
        // Under-using the world is recoverable, but only if something is being used.
        //
        // Where the risk actually lives is now measurable rather than assumed. Across
        // 6,570 observations and 221 deaths, deaths per thousand observations ran 75.7
        // below 85 vigor and 12.4 above 160 — a six-fold difference, and vigor is the
        // variable, not the wall. Vigor sets how fast health returns between exchanges,
        // so a rested character in the open is in a different fight from a tired one.
        //
        // So the wall is still preferred and still taken whenever one is found. It stops
        // being mandatory only for a character that is close to whole, above the vigor
        // band where the death rate collapses, and facing prey no higher level than
        // itself. Anything short of all three, the old refusal stands.
        // HOW MANY BLOWS CAN WE TAKE, not how the two levels compare.
        //
        // holdWorthwhile asks `prey level > our max health`, which is the right test for
        // whether a kill PAYS — AdvancementCheck uses exactly that — and the wrong one
        // for whether it is survivable. A fungus beast is level 50 against our 32, so
        // that test says "wall required" for every one of them, and the fleet walked.
        //
        // Damage is Fuzzy(viLevel / Random(10,15)) — about level/12 a blow — and it
        // depends on the LEVEL alone. Difficulty decides how often the blow lands and how
        // far it reaches, not how hard it hits. So the number that says whether an open
        // fight can be broken off is our health divided by that: a fungus beast does
        // about four to a 32-health character, which is eight exchanges, and eight is a
        // long time when a withdrawal takes one.
        const vNow = this.s.client?.vitals?.();
        const hpFrac = pct(vNow?.health);
        const vigNow = vNow?.vigor?.value ?? null;
        const myMax = vNow?.health?.max ?? null;
        const myNow = vNow?.health?.value ?? null;
        const preyLvl = worth.level ?? null;
        const openVigorBar = reachableOpenFightVigorBar(
          vigorBarFor([this.policy.hunt, ...this.threat().names], this.policy),
          this.fightFloor());
        const readiness = openFightReadiness({
          healthValue: myNow, healthMax: myMax, vigor: vigNow,
          vigorBar: openVigorBar,
          preyLevel: preyLvl, alreadyFighting: this.warnedFightingOpen === room.num,
          openFightHealth: this.policy.openFightHealth ?? 0.9,
          restBelow: this.policy.restBelow ?? 0.75,
          minimumBlows: this.policy.openFightBlows ?? 7,
        });
        const blowsWeCanTake = readiness.blows;
        const canFightOpen =
          // WHAT WE INTEND TO FIGHT, not what happens to be standing next to us.
          //
          // This asked threat().names — creatures inside the crowd radius right now — and
          // at the moment the room decision is taken that list is normally EMPTY, so the
          // bar fell back to the strict 130 every time and the relaxation never fired
          // once. Thirteen "REFUSING TO FIGHT HERE" entries and zero "fighting anyway"
          // across the whole fleet.
          //
          // The question being asked is whether to fight our PREY without a wall, so the
          // prey is what should set the bar; anything else in the room that is worse
          // still has to get past blowsWeCanTake and the room's own danger filter.
          readiness.ready;
        if (denied !== false && !this.hold && canFightOpen) {
          // AN EXPLICIT ROOM THAT PASSED THIS GATE IS USABLE FOR THIS SESSION.
          //
          // Leaving `noWallRooms` denied while fighting here worked for the first fight
          // and failed on recovery: the unit retreated to the Castle front step at its
          // health floor, then preyRooms excluded its own assignment and sent it to
          // Marion's crypt. Floyd and Clifford both began the same cross-world circuit
          // immediately after an otherwise correct local recovery. We have current
          // evidence that this unit can fight here under the open-fight guard, so retain
          // the operator's assignment; the ordinary recovery branch still takes it out
          // again when health reaches restBelow.
          if (this.policy.assignedRoom === room.num) {
            this.noWallRooms.set(room.num, false);
            this.clearRefusal('NO_SAFE_WALL');
          }
          // ONE FLAG PER BRANCH, BECAUSE THE TRANSITION IS THE INTERESTING EVENT.
          //
          // Both branches shared `warnedOpenFight` and both SET it before logging, so a
          // character that refused a room once could never log fighting in it: the
          // refusal wrote the room number, and every later pass — including every pass
          // where the relaxation fired — found the flag already equal and said nothing.
          // "Fighting anyway" could only ever appear if the very first evaluation in a
          // room passed the gate, which for a fleet that starts tired is close to never.
          //
          // This cost two rounds of chasing a gate that was working. The counter sat at
          // 0 across both while kills broadened from three characters to seven and
          // fighting time went 2% to 7% — the behaviour had changed and the instrument
          // could not show it. A shared one-shot flag across two mutually exclusive
          // branches does not report a state, it reports whichever state was seen first.
          if (this.warnedFightingOpen !== room.num) {
            this.warnedFightingOpen = room.num;
            this.warnedOpenFight = null;   // so flipping back reports the change
            this.note('no safe wall here, but fighting anyway', {
              room: room.name, room_num: room.num, why_no_spot: denied,
              health_pct: Math.round(hpFrac * 100), vigor: vigNow,
              prey_level: preyLvl, my_max_health: myMax,
              blows_we_can_take: Math.round(blowsWeCanTake * 10) / 10,
              why: 'whole, well above the vigor band where the death rate collapses, and it ' +
                   'takes this thing seven or more blows to finish us — the wall is worth ' +
                   'having and is not worth another twenty minutes of walking to find' });
          }
        } else if (denied !== false && !this.hold) {
          this.tally.rooms_denied = this.noWallRooms.size;
          this.emptyPasses++;
          if (this.warnedOpenFight !== room.num) {
            this.warnedOpenFight = room.num;
            this.warnedFightingOpen = null;   // so flipping back reports the change
            this.note('REFUSING TO FIGHT HERE — no safe wall in this room', {
              room: room.name, room_num: room.num, why_no_spot: denied,
              prey_level: worth.level ?? null, my_level: worth.my_level ?? null,
              treated_as: 'a denial of service for this area until safe-wall detection improves',
              why: 'fighting in the open is the condition the wall exists to prevent, and this ' +
                   'detector is known to miss plain wall edges — so a miss here is not evidence ' +
                   'the room has no wall, which is exactly why we do not gamble on it',
              doing_instead: 'roaming to a room we can hold a square in' });
          }
          // LEAVING IS THE POINT, and it must not depend on `roam`.
          //
          // The first version only set emptyPasses and reported no progress, which
          // assumed the roam logic would carry the character out. Most of this fleet
          // runs roam:false so it stays in its assigned room — so the refusal became a
          // permanent stall, the supervisor restarted the keeper, the fresh keeper
          // re-probed the same room and refused again, once a minute. Eight characters
          // did that within a minute of the rule going live.
          //
          // A denied room is not a stall, it is a decision, and the decision is to go
          // somewhere else. Relocation is the same machinery the "this room cannot
          // produce our prey" branch uses, and preyRooms now excludes denied rooms so
          // it cannot pick another one of these.
          const elsewhere = this.preyRooms(room);
          if (elsewhere.length) {
            this.doing = 'travelling';
            // FORCED: the room has been denied for having no usable wall, so whatever is held
            // here is not the shelter the refusal exists to protect.
            await this.leaveHold('leaving a room with no wall in it', { force: true }).catch(() => {});
            const go = elsewhere[0];
            const moved = await this.travel(go.room, { origin: keeperOrigin('wall_relocation'), maxHops: 14 })
                                    .catch(e => ({ arrived: false, reason: e.message }));
            if (moved.arrived) {
              this.homeRoom = go.room;
              this.emptyPasses = 0;
              this.placement.relocations++;
              this.note('left a room with no safe wall', {
                from: room.name, to: go.room_name, room: go.room,
                why: 'refused to fight here, so staying would be standing still for ever' });
              this.progress('left a room that cannot be fought in safely');
              return HANDLED;
            }
            this.note('could not leave the wall-less room', {
              room: room.name, tried: go.room_name, why: moved.reason });
          } else {
            this.note('nowhere else to hunt this', {
              room: room.name, hunting: this.policy.hunt,
              why: 'every room that generates it is either unreachable or has already been ' +
                   'refused for having no wall',
              hint: 'this prey has no safely fightable room for this character — re-target it' });
          }
          // STANDING STILL WHILE SOMETHING CHEWS ON YOU IS NOT A DECISION, IT IS A GAP.
          //
          // This `return` sat four lines above "FIGHT WHAT IS ACTUALLY HITTING YOU", so a
          // character that found no wall and could not leave bailed out of the pass just
          // before the branch that would have swung back — and then did it again next
          // pass, and the pass after that. Beaker was found in Valley of Ileria at 29/29
          // with monsters in the room, reporting STALLED once a second and never lifting
          // its weapon. Every refusal on the way here is individually correct and the sum
          // of them is a punching bag.
          //
          // So the dead end stops ending the pass when the character is OTHERWISE READY TO
          // FIGHT and exactly one thing is on it. Three gates, and each rules out a way
          // that "might as well swing back" turns into a death:
          //
          //   ONE ATTACKER. A swarm is the commonest death in this fleet, and swinging at
          //   one of four is not a fight, it is choosing which one lands the last blow.
          //   Against a crowd the existing withdraw/leave path is still correct.
          //
          //   HEALTH WE WOULD NORMALLY OPEN ON. safety().engageAt is already the "do not
          //   start what you cannot finish" line (0.9 under 30 max health, 0.75 above).
          //   Below it the answer is to heal, not to trade blows without a wall.
          //
          //   A TARGET WE WOULD NORMALLY TAKE. refuseEngagement is the same band that
          //   killed Waldorf when nothing consulted it. Unrecognised or over the band and
          //   we withdraw, exactly as the retaliation branch does.
          //
          // Deliberately NOT a blanket "always swing". The whole safe-spot mechanic is
          // that nothing can hit you until you swing first, so retaliating is exactly
          // wrong while a spot is holding — which is why this lives in the branch where
          // there is provably no spot and no hold, and nowhere else.
          const onUs = this.inReachOfUs();
          const lone = onUs.length === 1 ? onUs[0] : null;
          const loneName = lone ? (c.rsc.get(lone.nameRsc) || '') : '';
          const vNow = c.vitals?.() ?? {};
          const hpNow = pct(vNow.health);
          const ready = hpNow == null || hpNow >= this.safety().engageAt;
          const refusedLone = lone ? this.refuseEngagement(loneName) : null;

          if (!lone || !ready || refusedLone) {
            if (onUs.length) this.note('not fighting my way out of this one', {
              room: room.name, in_reach: onUs.length,
              what: onUs.map(o => c.rsc.get(o.nameRsc)).filter(Boolean).slice(0, 4),
              health: hpNow == null ? null : Math.round(hpNow * 100) + '%',
              engage_at: Math.round(this.safety().engageAt * 100) + '%',
              why: !lone ? `${onUs.length} of them are in reach and a swarm without a wall is ` +
                           'how these characters die'
                   : !ready ? 'below the health we would open a fight at, so healing beats trading blows'
                   : `would not normally fight a ${loneName}: ${refusedLone.why}` });
            this.noProgress('no safe wall here and nowhere better to go');
            return HANDLED;
          }
          this.note('no wall, nowhere to go, and one thing is on us — fighting back', {
            room: room.name, what: loneName,
            health: hpNow == null ? null : Math.round(hpNow * 100) + '%',
            why: 'one attacker, health we would open a fight at, and a target inside the band — ' +
                 'there is no spot to protect by holding fire and no exit to walk to, so the ' +
                 'only thing standing still buys is being hit for free' });
        }
      }

      // FIGHT WHAT IS ACTUALLY HITTING YOU, not only what you came for.
      //
      // Farm mode named one creature and fought only that, which is correct as a
      // statement of intent and fatal as a policy: the rooms are shared. Every room a
      // Qor character can legally hunt in is 50-75% BABY SPIDER and only 25-50%
      // centipede, so a Qor student attacks its centipede while two or three spiders
      // it is deliberately ignoring chew on it from behind. Thirteen of the last
      // twenty deaths in this fleet were the five Qor characters, and this is why —
      // not their karma, which is the story I first reached for, but the fact that
      // they alone are hunting the MINORITY spawn in every room open to them.
      //
      // So: if something attackable is adjacent and it is not the prey, it is the
      // prey now. Refusing to hit back is not a strategy.
      // Re-read where we are: taking a spot may have walked us across the room, and
      // "adjacent" computed from before the walk is a different question.
      const here = c.self;
      // See inReachOfUs() for why fleetmates are excluded and why the radius is 3.
      const adjacent = here ? this.inReachOfUs() : [];
      // WITH NO ORDER, NOTHING IS A BYSTANDER. The old spelling got this for free —
      // every string contains the empty string, so an absent hunt made everything "the
      // prey" — and a matcher that answers false to everything would invert it and make
      // the whole room a bystander. Say it out loud rather than relying on either.
      const want = this.clearing || this.policy.hunt || null;
      const isOurs = want ? this.huntMatch(want) : () => true;
      // A karma-strict character does not hit back at what it may not kill — and does not leave
      // the room over it either (the refusal branch below would): it keeps on its quarry, and
      // the flee line is what protects it. See karmaForbids.
      // A SPARED attacker is skipped for the same reason: fight() refuses it, so picking it here broke
      // off every pass and the quarry beside it was never chosen (Scooter in Icky Cave, 2026-10-25: a
      // spared spider biting him, five orcs in reach, "broke off" once a second for minutes).
      const bystander = adjacent.find(o => { if(this.combatApproachCooling(room?.num,o))return false;
                                             if (this.sparedHere(o)) return false;
                                             const n = c.rsc.get(o.nameRsc) || '';
                                             return !isOurs(n) && !this.karmaForbids(n); });
      if (!bystander && this.policy?.karmaStrict) {
        const spared = adjacent.map(o => c.rsc.get(o.nameRsc) || '').filter(n => n && !isOurs(n) && this.karmaForbids(n));
        if (spared.length) this.note('sparing an attacker (karma_strict)', {
          spared: spared.slice(0, 4), instead: want,
          why: 'killing it would move karma the wrong way; the flee line still protects this body' });
      }

      // HITTING BACK IS STILL A CHOICE, AND IT IS NOT ALWAYS THE RIGHT ONE.
      //
      // "Refusing to hit back is not a strategy" is true of a baby spider chewing on a
      // Qor student, which is the case this branch was written for. It is not true of
      // four soldiers of the Princess' army, and the branch could not tell them apart
      // because it asked nothing about what it was swinging at.
      //
      // So the same question capBlockers asks before CLEARING a room is now asked before
      // RETALIATING in one. A refused attacker is not ignored — ignoring it really is how
      // these characters die — it is escaped from: withdraw, which retreats to a wall
      // where the health timer can run, and failing that leaves the room. Standing and
      // trading blows with something outside our band is the one option removed.
      const refused = bystander ? this.refuseEngagement(c.rsc.get(bystander.nameRsc)) : null;
      if (refused) {
        this.note('will not trade blows with this', {
          creature: refused.name, level: refused.level, rating: refused.rating,
          adjacent: adjacent.length, why: refused.why,
          instead: 'leaving the room entirely — hitting back at something outside our ' +
                   'safety band is how a level-27 character dies at full health, and so is ' +
                   'stepping four squares away from it' });
        this.tally.refused_retaliation = (this.tally.refused_retaliation || 0) + 1;
        // WALKING A FEW SQUARES FROM A TROLL IS NOT ESCAPING A TROLL.
        //
        // This called withdraw(), which retreats to a wall a few squares off. Against
        // something inside our band that is right — the wall is the whole advantage.
        // Against something OUTSIDE it, which is exactly the case this branch has just
        // identified, it is not a retreat at all: GetVisionDistance is 4 + difficulty/2
        // (monster.kod:1676), so a troll at difficulty 8 sees eight squares and a
        // groundworm at 5 sees six. There is no square in the room that is out of range.
        //
        // The border of the Badlands is what this costs. Measured over all history: a
        // successful crossing takes a median of 15.8 seconds, and the median DEATH
        // there had been in the room 208 seconds — thirteen times longer. The fastest
        // of 24 was 32 seconds, still twice a crossing, and not one died faster than a
        // median crossing. Nobody dies passing through; they die refusing, shuffling
        // four squares, being followed, and refusing again. 51 of 52 of them were
        // nominally hunting giant rats, in a room that generates none — only trolls at
        // attack rating 750 and groundworms at 600.
        const left = await this.retreatToSafety({
          because: 'refused to fight ' + refused.name + ' (rating ' + refused.rating + ')',
          adjacent: adjacent.length,
        });
        // REPORT THE RETREAT THAT HAPPENED, NOT THE ONE THAT WAS DECIDED ON. See issue #51:
        // with `retreat_to_inn` off this returns a refusal, and calling it progress hid a
        // motionless character from the stall detector for as long as it took to die. The
        // pass still ends here — the survival ladder runs FIRST on the next one and is
        // where a body that could not retreat is supposed to be handled — but it ends
        // saying nothing moved.
        if (left?.arrived)
          this.progress('left the room rather than trade blows with something out of band');
        else
          this.noProgress('could not retreat from something out of band: ' +
                          (left?.refused ?? 'no reason given'));
        return HANDLED;
      }

      // `clearing` is a target for THIS PASS only — a creature we are killing to free
      // the room's cap, not a change of orders. policy.hunt is never rewritten by it.
      let engageName = bystander ? c.rsc.get(bystander.nameRsc)
                                 : (this.clearing || this.policy.hunt);
      if (bystander)
        this.note('hitting back', { target: engageName, instead_of: this.policy.hunt,
                                    why: 'it is adjacent and attacking; ignoring it is how these characters die' });

      // SWING AT WHAT MY PARTNER IS SWINGING AT.
      //
      // This is the whole of the party. Advancement needs that WE damaged it and that
      // it was OUR current target when it died, per character — so two characters on
      // one creature both advance from one corpse, and two characters on two creatures
      // are two solo fights sharing a room, with the danger of both and the benefit of
      // neither.
      //
      // Deliberately below the bystander rule: something already hitting us outranks
      // convergence, because ignoring it is how these characters die, and a partner
      // whose target we cannot see is not a target at all.
      let partyFoe = null;
      if (!bystander) {
        const agreed = party.agreedTarget(this.s.name);
        const seen = agreed ? c.room.objects.get(agreed.id) : null;
        // The partner preference was already part of quarry ranking before the wall was
        // chosen. Do not replace that validated quarry here with a different distant id.
        if (seen && seen.id === selectedQuarry?.id
            && (seen.flags & OF.ATTACKABLE) && !(seen.flags & OF.PLAYER)
            && !this.karmaForbids(c.rsc.get(seen.nameRsc) || '')) {
          partyFoe = seen;
          engageName = c.rsc.get(seen.nameRsc) || engageName;
          if (this.foeId !== seen.id)
            this.note('joining my partner\'s fight', {
              target: engageName, partner: agreed.from,
              why: 'both of us have to land a hit on the same creature for both of us to ' +
                   'advance from it — a kill only scores for a character that damaged it' });
        }
      }

      // DO NOT START A PAIRED FIGHT ALONE.
      //
      // Everything that makes a fungus beast survivable at level 30 assumes two
      // characters: the damage is split between them while each regenerates on its own
      // clock, and it dies in half the time. One character doing it alone is not
      // running the plan at reduced efficiency, it is running a different and much
      // worse plan — the whole margin is the second swinger.
      //
      // So a partnered character whose partner is elsewhere waits rather than engages.
      // The wait is cheap and self-correcting: the partner is walking to the same
      // assigned room, and the rejoin logic puts it back if it dropped.
      if (this.policy.partner && !party.together(this.s.name, room?.num ?? null)) {
        const mate = party.mateOf(this.s.name);
        this.doing = 'travelling';
        this.waitedForMate = (this.waitedForMate || 0) + 1;

        // THE WAIT WAS NOT SELF-CORRECTING, AND IT WAS NOT CHEAP.
        //
        // The note below says the partner is walking to the same assigned room. It very
        // often is not: characters drift, the supervisor re-deploys one of a pair, and
        // the two simply stay in different rooms. Measured on the fleet: 15 of 18 paired
        // characters were in a different room from their partner, and Gonzo had been
        // waiting 640 CONSECUTIVE PASSES. Every one of those waiting characters had zero
        // kills; the only three killing anything were the unpaired ones.
        //
        // So bound it. First go to them — the pairing is worth keeping and the partner's
        // room is known. If that keeps failing, engage alone: a worse plan than the pair,
        // and an enormously better one than standing still for an hour.
        if (this.waitedForMate > 8 && mate?.room != null && mate.room !== room?.num) {
          this.note('going to my partner rather than waiting for it', {
            partner: this.policy.partner, they_are_in: mate.room, waited_passes: this.waitedForMate,
            why: 'the wait assumed they were walking to meet us and they are not — 640 passes ' +
                 'of waiting was the record before this was bounded' });
          const t = await this.travel(mate.room, { origin: keeperOrigin('partner'), maxHops: 8 })
                              .catch(e => ({ arrived: false, reason: e.message }));
          if (t.arrived) { this.waitedForMate = 0; this.progress('joined my partner'); return HANDLED; }
          this.note('could not reach my partner', { why: t.reason ?? 'refused' });
        }
        if (this.waitedForMate > 20) {
          this.note('engaging without my partner', {
            partner: this.policy.partner, waited_passes: this.waitedForMate,
            why: 'we could neither meet nor reach them. Fighting this alone is the worse ' +
                 'plan and standing here is not a plan at all — nothing has been earned ' +
                 'in twenty passes of waiting' });
          this.waitedForMate = 0;
          // fall through to the ordinary fight path
        } else {
        this.note('waiting for my partner before engaging', {
          waited_passes: this.waitedForMate,
          partner: this.policy.partner,
          they_are_in: mate?.room ?? 'unknown — no fresh reading',
          i_am_in: room?.num ?? null,
          why: 'this prey is only survivable as a pair: two of us split what it deals and each ' +
               'heal at our own rate. Alone it is simply a stronger monster',
          note: mate ? undefined
            : 'no fresh report from them at all — they may be logged out, in which case the ' +
              'broker rejoins them within 45s' });
        // Rest while waiting rather than standing about: arriving at full is the point.
        await skills.restUntil(this.s, { health: 0.98, vigor: REST_VIGOR_CAP, maxSeconds: 20 })
                    .catch(() => {});
        // NOT progress(). Calling it here is why nobody noticed: progress clears the
        // stall detector, so a character waiting for a partner it will never meet looked
        // busy and honest for 640 passes and never once reported itself stuck.
        this.noProgress(`waiting for ${this.policy.partner}, who is in ${mate?.room ?? 'somewhere unknown'}`);
        return HANDLED;
        }   // end of "still willing to wait"
      }

      // WHOEVER IS BEING HURT STOPS SWINGING. The monster chooses who it hits and
      // nothing in the protocol tells us who that is, so there is no tanking rota to
      // run — only the observable fact that one of us is losing health faster.
      //
      // CRITICALLY, BREAKING OFF MUST NOT RE-TARGET. Stopping costs nothing; switching
      // to something else resets both advancement flags and throws away the credit for
      // every hit already landed. So this returns without touching foeId, and the
      // healing happens exactly where we stand — behind the wall we already hold.
      if (this.policy.partner && this.hold) {
        const role = party.roleFor(this.s.name,
          { health: hp, floor: this.policy.partyHealBelow ?? 0.5 });
        if (role === 'heal') {
          this.doing = 'recovering';
          const h = await skills.healUp(this.s, { target: 0.95, allow: healAllowOf(this) }).catch(() => ({ healed: false }));
          this.recordHealUse(h, 'partner is carrying the fight while I heal');
          this.note('stepping out of the fight to heal', {
            health: hp == null ? null : Math.round(hp * 100) + '%',
            floor: this.policy.partyHealBelow ?? 0.5,
            partner: this.policy.partner, still_targeting: this.foeId ?? null,
            healed: !!h.healed,
            why: 'my partner keeps swinging while I come back up. Not re-targeting: a kill ' +
                 'only pays a character that damaged it AND still has it targeted' });
          this.progress('healing while my partner holds the fight');
          return HANDLED;
        }
      }

      // Something has come to the wall and we have never tested this square: watch it
      // for a pass before hitting it. This is the only way proof ever arrives on
      // purpose rather than by accident. See maybeTestSpot().
      if (this.maybeTestSpot(adjacent)) return HANDLED;

      this.doing = 'fighting';
      // The measurement the vigor floor exists for: not what we intended to set out
      // at, but what we actually swung at.
      const vAt = vigorOf(this.s.client?.vitals?.() ?? {});
      if (vAt != null) {
        const V = this.vigor;
        V.engagements++;
        V.total_at_engage += vAt;
        V.lowest_at_engage = V.lowest_at_engage == null ? vAt : Math.min(V.lowest_at_engage, vAt);
        if (vAt < WANT_FIGHT_VIGOR) V.below_want++;
      }
      const holding = !!this.hold;
      // TELL THE PARTNER WHAT WE ARE ABOUT TO HIT, before hitting it. Declaring after
      // the swing means the first exchange of every fight is two characters choosing
      // independently, which is the one moment convergence is worth most — whoever
      // gets there first sets the target and the other joins on its next pass.
      // A PULL WHOSE QUARRY IS GONE IS NOT A PLAN. The pending pull outranks the selection
      // here, and fight() is pinned to the id it names (`exactTargetId`) — so when somebody
      // else kills the pulled creature, or it despawns, fight() finds nothing, answers "try
      // one of the names above" without `out_of_reach`, and the branch that would notice the
      // missing quarry (pendingPullWait, which lives under out_of_reach) never runs. Sweetums,
      // Icky Cave, prod 2026-09-25: `broke off` 367 passes in a row on a proven wall, ten live
      // prey in the room, three orc corpses beside the pull. Drop it here, where the id is read.
      if (this.pendingPull?.target_id != null) {
        const pulled = c.room.objects.get(this.pendingPull.target_id);
        const pulledName = pulled ? c.rsc.get(pulled.nameRsc) : null;
        const stale = stalePullReason(this.pendingPull, {
          room: room?.num, object: pulled, name: pulledName,
          attackable: !!(pulled?.flags & OF.ATTACKABLE), player: !!(pulled?.flags & OF.PLAYER),
          matches: !!pulledName && this.huntMatch(this.pendingPull.target)(pulledName),
        });
        if (stale) {
          this.note('the pulled quarry is gone — choosing again', {
            target: this.pendingPull.target, target_id: this.pendingPull.target_id,
            actual: pulledName, why: stale,
            note: 'a vanished quarry says nothing about the wall, so the square is not charged' });
          this.pendingPull = null;
        }
      }
      const plannedQuarryId = this.pendingPull?.target_id ?? selectedQuarry?.id ?? null;
      const swingAt = bystander ? bystander.id : (partyFoe ? partyFoe.id : plannedQuarryId);
      const claimedSwing = swingAt ?? null;
      // The experiment is about the configured farm prey, not weak-room cleanup or a
      // defensive contact. Use the same canonical matcher as every other hunt decision,
      // so class and alias orders (for example `soldier`) train their actual prey too.
      const trainingPrey = this.isTrainingPrey(engageName);
      // A NON-PREY FIGHT MUST NOT RE-ARM A CHARACTER WHOSE REGIMEN IS BARE HANDS.
      //
      // This used to fall back to 'normal', and 'normal' means `equip: true`, and `equip:
      // true` means fight() wields the best weapon in the pack. So one weak-room cleanup or
      // one defensive contact put a weapon back in the hand of a character that passArm had
      // just deliberately emptied -- and it stayed there, because nothing takes a weapon off
      // except passArm, which then loses the same race on the next non-prey contact.
      //
      // Measured on prod 2026-09-08 with the station assignment held steady at 544 and
      // trainingStyle 'unarmed' the whole time: Fozzie read bare at 19:17:57 and was holding
      // the mace again by 19:18:08. Eleven seconds. Across the fleet that is the difference
      // between fleet brawling +0 and the regimen actually running -- every swing with the
      // weapon zeroes piWeaponSwings for the bare-hand block (player.kod:4753-4757) and no
      // improvement fires at all until that counter reaches 75 (player.kod:4536-4537).
      //
      // Dropping the weapon does not fix it either: `unuse` then `drop` loses the same race,
      // and the drop is refused because the thing is wielded again by the time it lands.
      // Three characters were watched failing exactly that way.
      //
      // So the fallback is the character's OWN configured style, not 'normal'. The original
      // reason for 'normal' was to keep the 50/50 experiment honest by not counting a
      // cleanup kill as a training bout -- that intent is preserved, because the style only
      // decides WHAT IS IN THE HAND. `finishTrainingBout` and the alternation schedule still
      // only advance on the prey the order names.
      //
      // Only while standing on the assigned farm ground, which is the same gate passArm
      // uses. Travelling, or anywhere else, the ordinary arm-first survival rule wins: being
      // unarmed in a strange room is how the road kills people.
      const trainingStyle = trainingPrey ? this.trainingStyleFor(claimedSwing)
                                         : this.styleForNonPrey(room);
      const training = await this.prepareTrainingStyle(trainingStyle, claimedSwing)
        .catch(e => ({ ready: false, why: e.message, style: trainingStyle }));
      if (!training.ready) {
        this.note('training bout could not start', {
          target_id: claimedSwing, style: trainingStyle, why: training.why,
          note: 'the keeper refused a fallback weapon so the 50/50 measurement stays honest',
        });
        this.noProgress(`training ${trainingStyle} unavailable: ${training.why}`);
        return HANDLED;
      }
      // THE TOUCH, BETWEEN SWINGS. An unarmed bout is one round a pass, so this runs before every
      // swing on the assigned room: empty hand, buff on, recast when the server said it stopped
      // or a swing read "Your punch". It never refuses the fight — a buff we cannot afford is a
      // reason on the status, and the character swings bare.
      this.farmStrategyHook('beforeSwing', { target: engageName, target_id: claimedSwing ?? null,
                                             room: room?.num ?? null });
      await this.farmBuffAsk('before_swing', { target: engageName }).catch(() => null);
      if (this.touchTrainingHere())
        await this.maintainTouchSpell(`before swinging at ${engageName}`)
          .catch(e => { const st = this.touchState(); if (st) st.blockedReason = e.message; });
      // Defensive contact must not release the claim on a pulled quarry whose progress
      // is still being watched. Once that experiment ends, normal claim convergence resumes.
      if (!this.pendingPull && claimedSwing != null)
        claimQuarry(this.s.name, room?.num, claimedSwing);
      if (this.policy.partner && !this.pendingPull)
        party.declareTarget(this.s.name, claimedSwing, engageName);
      this.farmCombat = {at:Date.now(),pending:true,target:engageName,target_id:claimedSwing,holding:!!holding};
      const f = await skills.fight(s, { target: engageName,
                                        // The same predicate that chose the quarry. An order naming
                                        // several creatures is not a string, and fight() would
                                        // otherwise substring against "battered skeleton,zombie"
                                        // and find nothing in a room full of both.
                                        match: this.huntMatch(engageName),
                                        // Prey this character has already proved it cannot walk
                                        // to, skipped by SQUARE so a respawn in the same corner
                                        // is skipped too. Null when there is none.
                                        //
                                        // NOT FOR A BYSTANDER. It was chosen from inReachOfUs():
                                        // already within reach, so no walk is involved, and an
                                        // unreachable-square memory says nothing about it. Passed
                                        // anyway, fight() is pinned to its id (exactTargetId), drops
                                        // it, answers "try one of the names above", and the next
                                        // pass picks the same attacker. Pepe, Badlands (45), prod
                                        // 2026-10-18: a groundworm two squares off, `broke off`
                                        // every 1.5s, zero landed hits.
                                        avoid: bystander ? null : this.preyAvoid(s.world?.room?.num ?? null),
                                        preferId: claimedSwing,
                                        exactTargetId: claimedSwing,
                                        disengageAt: safe.fleeAt, loot: true,
                                        holdPosition: holding, reach: PLAYER_REACH,
                                        equip: training.equip,
                                        rounds: training.rounds,
                                        weaponPriority: this.weaponPriorityNow(engageName),
                                        bannedWeapons: this.bannedWeaponsNow() });

      try { bodyAuthority(s).guard(); } catch(error) {
        // The old invocation may finish its already-sent fight after survival
        // takes over. Retain a completed receipt without resuming body work.
        this.recordInterruptedFarmOutcome(f,{room,holding,preempted:error.code??error.message});
        return HANDLED;
      }
      this.farmCombat = {at:Date.now(),pending:false,target:engageName,target_id:claimedSwing,holding:!!holding,killed:!!f.killed,died:!!f.died,out_of_reach:!!f.out_of_reach,reason:f.reason??f.why??null,rounds:f.rounds??null,combat:(f.combat??[]).slice(-8)};
      if(this.finishFailedCombatApproach(f))return HANDLED;

      // With equip:false fight() cannot know which prepared weapon shattered. Remember
      // the exact short-sword id here so the next pass makes a replacement instead of
      // repeatedly offering the same server-refused item.
      if (training.weapon_id != null && (f.combat || []).some(skills.brokenWeaponText))
        skills.brokenSet(c).add(training.weapon_id);
      if (trainingPrey && (f.killed || f.died)) this.finishTrainingBout(claimedSwing);

      if (trainingPrey && (f.killed || f.died)) this.finishTrainingBout(claimedSwing);

      // NOTHING IN REACH, AND WE ARE NOT GOING TO CHASE IT. fight() refuses to walk
      // while we are holding, which is correct and leaves the interesting half to us:
      // a monster that will not come to the wall has to be fetched. Hit it once and
      // walk back, and the fight happens where we chose.
      if (f.out_of_reach) {
        this.doing = 'pulling';
        // A DISTANT QUARRY IS STILL ON THE ROAD.
        //
        // Decisions run every second. Counting the first decision after a pull as a miss
        // gave a quarry one or two seconds to cross routes that took us tens of seconds,
        // then hit it again and repeated the mistake. Wait out a distance-sized follow
        // window before this pull is allowed to count toward the empirical cliff verdict.
        let waiting = this.pendingPullWait();
        // A quarry that despawned, died to somebody else, or left the room did not fail
        // to follow. Rotate immediately without charging the square.
        if (waiting?.missing) {
          await this.switchFromStalledPull(
            waiting, found,
            'the pulled quarry left the room or disappeared; that says nothing about the wall',
            { cooldown: false });
          return HANDLED;
        }
        if (waiting?.stalled) {
          await this.switchFromStalledPull(
            waiting, found,
            `its distance to the wall stopped improving for ${waiting.non_closing_samples} sampled checks`);
          return HANDLED;
        }
        if (waiting) {
          if (!this.pendingPull.waitNoted) {
            this.pendingPull.waitNoted = true;
            this.note('giving the pulled quarry time to reach the wall', {
              target: waiting.target, pull_steps: waiting.steps,
              sample_every_ms: this.policy.pullProgressSampleMs ?? 3_000,
              last_distance: waiting.last_distance,
              best_distance: waiting.best_distance,
              why: 'its live position is sampled every few seconds. As long as it keeps ' +
                   'getting closer we wait; repeated non-closing samples rotate the target' });
          }
          this.doing = 'waiting';
          return HANDLED;
        }
        const pullSpot = this.hold
          ? { room: this.hold.room, col: this.hold.col, row: this.hold.row }
          : null;
        // `claimedSwing` may be an urgent bystander rather than the hunt-list head.
        // Pull the exact object fight() just range-checked; substituting found[0] here
        // validates one target/wall pair and then fetches a different monster to it.
        const quarryId = f.nearest?.id ?? claimedSwing;
        const quarry = quarryId != null ? c.room.objects.get(quarryId) ?? null : null;
        // THERE IS NOTHING TO PULL IT BACK TO, SO DO NOT PULL — WALK UP TO IT.
        //
        // `pull()` fails on its own first line without a hold, and with `use_safe_spots`
        // off there is never one. That made this branch a loop with no exit: the fetch
        // failed instantly, `pullAttemptFailed` was handed a null square so the budget
        // never advanced, `failed.relocate && this.hold` could never both be true, and the
        // keeper reported "retrying from the same wall" — a wall it did not have — every
        // 1.7 seconds, indefinitely. Valley of Ileria 2026-09-04: Gonzo wedged 721s, Rizzo
        // 942s, Lew 1025s, all reading `attempt: 0 of 4`, and Rizzo was eaten mid-wedge at
        // `gross_squares: 0` over thirty-two seconds while it happened.
        //
        // The pull exists to make the fight happen AT A WALL. With no wall that purpose is
        // gone and the honest move is the one the operator asked for by switching spots
        // off: close the distance and fight it where it stands. Same approach square and
        // same walk as `pull()`, without the walk back.
        if (!this.hold) {
          const closed = quarry ? await this.closeOnQuarry(quarry)
                                : { closed: false, why: 'nothing to close on' };
          if (closed.closed)
            this.progress(`closed on ${closed.target} — no wall to fetch it to, so the ` +
                          'fight happens where it stands');
          else this.noProgress(`could not close on the quarry: ${closed.why}`);
          return HANDLED;
        }
        const p = quarry ? await this.pull(quarry) : { pulled: false, why: 'nothing to pull' };
        bodyAuthority(s).guard();
        if (p.pulled && p.back) {
          const waitMs = this.pullFollowWaitMs(p.steps);
          const startedAt = Date.now();
          const pulledId = p.target_id ?? quarry?.id ?? null;
          const liveQuarry = pulledId != null ? c.room.objects.get(pulledId) : null;
          this.pendingPull = {
            at: startedAt, waitUntil: startedAt + waitMs,
            target: p.target, target_id: pulledId, steps: p.steps, wait_ms: waitMs,
            ...beginPullProgress(liveQuarry, pullSpot, { now: startedAt }),
          };
          // DELIBERATELY NOT progress(). A pull is not an achievement, it is an attempt,
          // and calling it progress is what kept the stall detector quiet through hours
          // of this. Contact is the achievement, and the fight path below reports that.
          this.note('waiting for it at the wall', {
            target: p.target, pull_attempt: (this.pullsWithoutContact ?? 0) + 1,
            follow_window_ms: waitMs, pull_steps: p.steps,
            why: 'it has been hit and is following; only after its distance-sized follow ' +
                 'window expires can this pull count against the square' });
        } else {
          // Fetching failed before a swing. One moving target or refused step is not a
          // property of the wall; retire it only after repeated misses from this square.
          const failed = this.pullAttemptFailed(pullSpot, p.why || 'the pull did not complete');
          this.note('could not bring it to the wall', {
            why: p.why, target: p.target, attempt: failed.attempt, of: failed.limit,
            note: failed.relocate
              ? 'this wall is too far from the quarry — moving to one closer to it'
              : 'keeping the wall and trying again; a single failed approach proves nothing' });
          if (failed.relocate && this.hold && quarry) {
            // Not a bad wall — a distant one. Give up THIS hold (only) and take a wall
            // biased hard toward the quarry, so the next pull is a short one. Never
            // blacklist, never abandon the strategy: if no closer wall turns up this pass
            // we simply keep trying. Relocating IS progress, so it is reported as such.
            this.releaseHold('this wall cannot pull the quarry — moving to one closer to it');
            const closer = await this.takeSafeSpot('a wall the quarry can be pulled to', quarry,
                                    { nearQuarry: true }).catch(() => ({ took: false }));
            if (closer.took) this.progress('relocated to a wall closer to the quarry');
            else this.noProgress('no closer wall to the quarry this pass — will keep trying');
          } else {
            this.noProgress('a pull attempt failed transiently; retrying from the same wall');
          }
        }
        return HANDLED;
      }
      // We got a fight. Whatever we are standing on can be fought from, so the cliff
      // counter resets — this is the only evidence that actually settles the question.
      // A submitted round is not contact: range-refused attacks can consume a round and
      // land nothing. Close the exact quarry's progress watch only on an observed hit or
      // its death, and use the id fight() actually selected rather than our old claim.
      if ((f.landed_hits ?? 0) > 0 || f.killed)
        this.pullConverted(f.target_id ?? f.foe_id, f.target ?? engageName);
      this.swungAt = Date.now();
      this.foeId = f.foe_id ?? null;
      // fight() can now tell death apart from a stale object id. If it is the
      // latter, reconnecting fixes it; treating it as death would loop forever.
      if (f.stale_identity) {
        this.note('stale object id during a fight — reconnecting', { why: f.note });
        await this.reconnect('clearing a stale object id mid-fight');
        this.noProgress('reconnected after a stale object id');
        return HANDLED;
      }
      // WE BROKE OFF. GO ALL THE WAY.
      //
      // This branch did not exist, which is why the fleet has been dying at a fifth of
      // its health bar standing perfectly still. `fight()` set `disengaged`, wrote a
      // note saying to walk away, and returned into code that read neither.
      //
      // Behind a wall the advice inverts and `fight()` says so: sitting still IS the
      // recovery there, because nothing can land a blow unless we swing first. So a
      // held safe spot rests where it stands; everything else leaves the room.
      if (f.disengaged) {
        const hp = v.health?.max ? Math.round(100 * v.health.value / v.health.max) + '%' : null;
        if (f.disengaged.unarmed) {
          const reason = f.disengaged.reason
            ?? 'the weapon was lost and no verified replacement could be equipped';
          // A wall limits added attackers; it does not make the one already engaged
          // harmless. Leave the live pocket before ordinary recovery can choose to rest.
          if (holding) await this.leaveHold(reason, { force: true }).catch(() => null);
          const away = await this.retreatToSafety({
            because: reason,
            mid_round: !!f.disengaged.mid_round,
            unarmed: true,
            still_here: (this.inReachOfUs() ?? []).length,
          });
          // Same rule as every other retreat here, and the same incident behind it (#51):
          // a refusal is not a retreat, and reporting it as one is what kept four dying
          // characters looking healthy to the stall machinery.
          if (away?.arrived) this.progress('retreated after losing the weapon');
          else this.noProgress('unarmed and could not retreat: ' + (away?.refused ?? 'no reason given'));
          return HANDLED;
        } else if (holding && this.holdWorks?.()) {
          this.note('broke off behind the wall — resting here rather than running', {
            at_health: f.disengaged.at_health, mid_round: !!f.disengaged.mid_round,
            why: 'nothing can hit us on this square unless we swing first, so standing still ' +
                 'is a free heal and walking off it would start the damage' });
        } else {
          const away = await this.retreatToSafety({
            because: f.disengaged.reason
              ?? ('broke off a fight at ' + (f.disengaged.at_health ?? hp)),
            mid_round: !!f.disengaged.mid_round,
            still_here: (this.inReachOfUs() ?? []).length,
          });
          if (away?.arrived) this.progress('retreated after breaking off a fight');
          else this.noProgress('broke off a fight and could not retreat: ' +
                               (away?.refused ?? 'no reason given'));
          return HANDLED;
        }
      }
      const looted = (f.looted || []).map(x => x.name + (x.amount ? ` x${x.amount}` : ''));
      if (f.killed) {
        releaseQuarry(this.s.name);
        this.tally.kills++;
        this.killTimes.push(Date.now());
        if (this.killTimes.length > 500) this.killTimes.shift();
        this.farmStrategyHook('onKill', { creature: f.target, room: room?.num ?? null, looted });
        // ON THE FEED, WITH THE CREATURE AND THE ROOM. The tally counts; this remembers
        // what and where, which is what makes a max-health gain attributable to the thing
        // that paid for it. Ten per character, in memory — see m59-tougher.mjs.
        tougher.recordKill(this.who(), {
          creature: f.target, room: room?.name ?? null, room_num: room?.num ?? null,
          level: v.health?.max ?? null, rounds: f.rounds, looted, from_safe_spot: !!holding,
        });
        // AND INTO THE LONG RECORD, because every in-process count of a kill is wiped
        // constantly. `tally.kills` and `killTimes` are both fields on this object, and
        // the supervisor restarts keepers about once a minute — so both really mean
        // "since the last restart", and the board column asking "is this character
        // earning RIGHT NOW" was answered from a counter that had been zeroed since the
        // last kill. Measured: the fleet killed at least 26 things in half an hour while
        // every kills/30m on the page read 0. countKills() in m59-ledger.mjs counts these
        // instead, and this is the only thing that survives a keeper.
        this.ledgerEvent('killed', {
          creature: f.target, room: room?.name ?? null, room_num: room?.num ?? null,
          rounds: f.rounds, from_safe_spot: !!holding,
          looted: looted.length ? looted.join(', ') : undefined,
        });
        // A kill means the wilderness is working again, so the run of flees that would
        // otherwise accumulate over a long healthy session is cleared. Without this a
        // character that fled three times an hour ago gets marched to town mid-fight.
        this.fledInARow = 0;
        // Remember where the work is. This is what roaming steers back toward.
        if (room?.num != null) this.homeRoom = room.num;
        this.progress('killed something');
      } else {
        if (f.died) {
          releaseQuarry(this.s.name);
          this.noProgress('died in a fight');
        } else if (partialFightMadeProgress(f)) {
          // THE QUARRY MOVING OUT OF REACH IS NOT THE FIGHT FAILING.
          //
          // fight() preserves foe_id so the next pull resumes this exact wounded object.
          // A landed hit is therefore durable progress toward the same kill even when the
          // exchange ends because it stepped 3.2 squares away. The old unconditional
          // noProgress() turned five such damaging exchanges into STALLED and the
          // controller stopped healthy keepers after about a minute. Count only the
          // server-confirmed landed blow, never the attempted swing: all-miss breaks still
          // accumulate and expose a genuinely ineffective fight.
          this.progress('damaged the current quarry');
        } else {
          this.noProgress('broke off without a landed hit or a kill');
        }
      }
      this.countLoot(looted);
      await this.wearLootedArmour(looted);
      this.note(f.killed ? 'killed' : (f.died ? 'died' : 'broke off'), {
        target: f.target, rounds: f.rounds, looted,
        landed_hits: f.landed_hits ?? 0,
        damage_dealt: f.damage_dealt ?? null,
        health: f.health?.after?.value, why: f.note,
        ...(holding ? { from_safe_spot: { col: this.hold?.col, row: this.hold?.row,
                                          proven: this.holdWorks() } } : {}),
        ...(f.refused?.length ? { left_on_the_floor: f.refused.length } : {}),
      });
      return HANDLED;
    }

    this.note('nothing to do', { health: v.health, vigor: v.vigor, room: room?.name });
    // The last stage, so there is nothing to fall through TO — but it answers anyway, so
    // that "every stage returns a verdict" is a rule with no exceptions to remember.
    return HANDLED;
  }
  // @end 1
}
