// TRAVEL: the keeper's journeys, their holds and shelter stops.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 11 methods: recordFrame, travelArmFor, travelHoldMode, recordTravelShelterStop,
//   travelHoldCandidate, travelHold, travelRestAtSanctuary, restBeforeSettingOut,
//   travelInterrupted, recoveryTravel, travel
import { folRoomsOf } from '../m59-chalice.mjs';
import * as grudge from '../m59-grudge.mjs';
import { recordSightings } from '../m59-intel.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { puzzleBlocksJourney } from '../m59-leverpuzzle.mjs';
import { journeyProvenance, keeperOrigin, liveMoveOrder, moveOrigin, originLabel } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { preySideFor } from '../m59-preyside.mjs';
import { recoveryRefugeReach } from '../m59-recovery-refuge.mjs';
import { nearestSafeSpot } from '../m59-safespots.mjs';
import * as skills from '../m59-skills.mjs';
import { detailSettings } from '../m59-strategy-stats.mjs';
import { currentSurvivalDecision } from '../m59-survival-decision.mjs';
import { traceSurvival } from '../m59-survival-trace.mjs';
import { noteTrafficJam, trafficBlinkAdvice } from '../m59-traffic-blink.mjs';
import { routeTravelKind } from '../m59-travel-kind.mjs';
import { UNDERWORLD } from '../m59-travelgate.mjs';
import { compactRefusals, travelJourneyMetrics, withTravelJourneyMetrics } from '../m59-trip-telemetry.mjs';
import { REST_VIGOR_CAP, REST_VIGOR_WORTH_WAITING, TRAVEL_FORWARD_BIAS, TRAVEL_HOLD_ARM, TRAVEL_HOLD_MODE, journeyIncident, vigorPct } from '../m59-autopilot.mjs';

export class TravelPart {
  // @part 1

  recordFrame(why = null) {
    const c = this.s.client;
    if (!c?.room) return null;
    const v = c.vitals?.() ?? {};
    const room = this.s.world?.room;
    const nowT = Date.now();
    const mine = (flag) => [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && (flag ? (o.flags & OF.PLAYER) : !(o.flags & OF.PLAYER)));
    const f = {
      at: nowT, room: room?.name ?? null, num: room?.num ?? null,
      col: c.self?.col ?? null, row: c.self?.row ?? null,
      health: v.health?.value ?? null, max: v.health?.max ?? null,
      // HOW OLD THAT HEALTH READING IS. A flat trail at full health right up to a death is either one-pass kills or a
      // keeper that stopped hearing its own stat packets (2026-10-26: Fozzie, Clifford, Rowlf, all `stalled`, all flat).
      // The age of the last health packet at each frame tells the two apart.
      health_age_ms: (() => { const t = c.statsById?.get?.('health')?.observed_at; return Number.isFinite(t) ? nowT - t : null; })(),
      // Health is sent only when it CHANGES, so an old health reading at full health is normal. These two say whether
      // the link was alive: bytes off the socket, and the last message that actually parsed.
      rx_age_ms: c.lastRxAt ? nowT - c.lastRxAt : null,
      msg_age_ms: c.lastGameMsgAt ? nowT - c.lastGameMsgAt : null,
      vigor: v.vigor?.value ?? null,
      doing: this.doing ?? this.lastDoing ?? null,
      ...(why ? { why } : {}),
      holding: this.hold ? { col: this.hold.col, row: this.hold.row,
                             proven: this.holdWorks?.() ?? null } : false,
      // Ages rather than timestamps: a post-mortem is read by someone asking "was it
      // moving", not "what was the clock".
      moved_ms: this.movedAt ? nowT - this.movedAt : null,
      swung_ms: this.swungAt ? nowT - this.swungAt : null,
      // NEVER SWUNG IS NOT THE SAME FACT AS WE DO NOT KNOW, and collapsing them cost a whole
      // analysis. `swung_ms` is null in both cases — there is no `swungAt` to subtract from —
      // so `was.swinging` came out FALSE either way. Asked of the 268 deaths that happened on
      // a square the geometry calls a safe wall, 242 read `swinging: false`, which reads as a
      // refutation of "nothing can hit you unless you swing first" and is in fact 172 rows
      // saying nothing at all. This separates them: false HERE means the body genuinely never
      // swung in this keeper session, which is knowable, and is the shape a real
      // counterexample has to have.
      ever_swung: Number(this.swungAt) > 0,
      // WHICH RUNG WAS RUNNING WHEN THIS FRAME WAS WRITTEN.
      //
      // The death summary used to read `this.passStage` LIVE, and by the time a death is
      // noticed the body is already in the Underworld — the death is complete, the penalties
      // are applied, and the ladder has moved on to the rung that walks it home. So the field
      // recorded the clean-up, not the killing: 14 of 50 deaths on 2026-09-20 read
      // `passUnderworld`, which is a stage no living character dies in.
      //
      // Carried on the frame instead, so it goes through the same underworld filter as room,
      // health and `doing` and is pre-death by construction.
      stage: this.passStage ?? null,
      stage_ms: this.passStageAt ? nowT - this.passStageAt : null,
      // COUNT SEPARATELY FROM NAMING, because the cap on the names was silently becoming
      // the answer. `most_at_once` is derived from this list's LENGTH, and the list was
      // sliced to 6 — so every swarm death recorded "6 on them at the end", 55 times out
      // of 55 in room 586, and the real number was never written down. A constant that
      // appears in 100% of your records is a measurement artefact, not a finding.
      //
      // NOT FLEETMATES: every character in this fleet is ATTACKABLE and they stand next
      // to each other by design, so without the player bit a death record names four
      // Muppets as the things that killed you. They are recorded separately instead.
      threat_count: mine(false).length,
      threats: mine(false).map(o => c.rsc.get(o.nameRsc)).slice(0, 6),
      players_present: [...c.room.objects.values()]
        .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER))
        .map(o => c.rsc.get(o.nameRsc)).slice(0, 6),
    };
    // WHO ELSE WAS IN THE ROOM. Sightings only — this writes a record and decides
    // nothing; see the header of m59-intel.mjs for why that separation is load-bearing.
    //
    // `party.isFleetmate` is the fleetmate answer, and it is the SAME one the grudge book
    // uses two screens down. The broker backs it with `fleetCharacters()`, which unions
    // the live sessions with the roster this broker actually loaded — so it is right at
    // boot, when the runtime map is still empty, and it is right for whichever fleet is
    // being held rather than for whichever roster happens to sit at a fixed path.
    {
      const myName = c.me?.name ?? this.s?.name ?? this.who();
      const strangerObjs = [...c.room.objects.values()]
        .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER));
      try {
        // Empty frames are meaningful to the runtime edge detector: they retire the
        // current encounter so a later re-entry is recorded once. They perform no I/O.
        recordSightings(
          myName,
          strangerObjs.map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc) })),
          this.s.world?.room?.num ?? null,
          party.isFleetmate,
        );
      } catch { /* a record is never worth a pass */ }
    }

    this.recent5 = (this.recent5 || []);
    // WHEN THE RECORD LAST BREATHED. The watchdog spaces its own frames against this, so
    // an ordinary busy pass costs nothing extra and only a genuinely blind stretch does.
    this.lastFrameAt = nowT;
    this.recent5.push(f);
    // Deep enough to cover the whole of a death rather than its last few seconds. At an
    // 8s pass this is about three minutes, which is longer than any fight that kills one
    // of these characters — and a multi-hop journey now spends frames from the same
    // budget, which is the trade this exists to make.
    //
    // WIDENED FOR THE WATCHDOG. It writes a frame per health change during a blind walk,
    // which is the resolution the record most wants and also the fastest it can be spent:
    // a character under attack while travelling can burn twenty frames in twenty seconds,
    // and at 24 that evicted the entire run-up to the death being explained. Forty-eight
    // frames is about 12KB in a post-mortem — the text log is already larger.
    if (this.recent5.length > 48) this.recent5.shift();
    return f;
  }

  // TRAVEL, WITH THE TWO ENDS WRITTEN DOWN.
  //
  // Every `s.travel(...)` in this file goes through here so that setting off and arriving
  // are both observations rather than a silence with a conclusion drawn from whichever
  // side of it a pass happened to land on. The wrapper returns the same promise shape, so
  // the ten call sites keep their own `.catch(...)` exactly as they were, and the arrival
  // frame is written in a `finally` — a journey that THREW is the case where knowing
  // where it stopped matters most.
  // ------------------------------------------------- resting at walls while travelling
  //
  // THE EXPERIMENT. 61% of all the damage this fleet takes happens while travelling, and
  // eight of thirteen deaths in a day were `travelling` while not one was `fighting`. A
  // safe spot is the only place outside a town where health comes back without a fight,
  // so the question is whether stopping at one mid-journey is worth the seconds it costs.
  //
  // It is a QUESTION and not an improvement, which is why it ships as an A/B rather than
  // as a change. Standing still in a hostile room is not obviously safer than walking
  // through it: the hold costs exposure, the spot is a geometric guess that has never been
  // stood on (the safe-spot book covers 29 rooms the fleet FIGHTS in, and none of the ones
  // it walks through), and at the resting cap of 80 vigor a 15-point top-up costs 87
  // seconds — as long as an entire p90 journey.
  //
  // RANDOMISED PER JOURNEY, NOT PER CHARACTER. The characters differ by max health, by
  // hunting ground and by strategy, and with twenty-one of them a split by character would
  // be confounded by all three. Per journey, every character contributes to both arms and
  // the confounders cancel. The arm is derived from the journey's own id so it is stable,
  // reproducible from the record, and not re-rolled if the decision is asked twice.
  // THE LOW BIT OF FNV-1a IS NOT RANDOM, and taking it was a real bug caught by the test
  // rather than by reading.
  //
  // FNV-1a finishes with `h = h * 16777619`. That constant is ODD, and the low bit of a
  // product with an odd number is the low bit of the other operand — so the final low bit
  // is just (running hash) XOR (last character), and nothing else in the seed reaches it.
  // Measured: seeds differing only in their last character alternated arms exactly with
  // that character's parity, and forty seeds from one character all landed in one arm.
  //
  // In production the seed ends in a millisecond timestamp, so the split would have looked
  // fine — 50/50, because `Date.now() % 2` is a decent coin. That is what makes it
  // dangerous: the experiment would have been randomising on one bit of the clock, the
  // character and pass number would have contributed NOTHING, and any later change to the
  // seed's tail could have frozen every journey into a single arm without the split
  // looking any different until the deaths came in.
  //
  // So: avalanche the accumulator before taking a bit (fmix32, the MurmurHash3 finaliser),
  // which makes every input bit reach every output bit.
  // RETIRED 2026-08-21 AND KEPT ON PURPOSE. Nothing in the live path calls this any more —
  // see TRAVEL_HOLD_MODE for why the experiment is closed — but the historical
  // `travel_journey` rows were assigned by it, so `m59-travel-ab.mjs` still needs it to
  // read them back, and `m59-travel-ab-test.mjs` still pins the avalanche bug below.
  // Deleting it would delete the only explanation of what those old rows mean.
  travelArmFor(seed) {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 16; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    h ^= h >>> 16;
    return ((h >>> 0) & 1) ? 'hold' : 'walk';
  }

  // THE MODE, NORMALISED, AND THE RETIREMENT SAID OUT LOUD ONCE PER KEEPER.
  //
  // Two places read this — the arm choice at the top of a journey and the hook at every hop
  // boundary — and they must not be able to disagree about what `ab` means. That is the
  // same shape as the bug the block above `travel()` describes, where one of them honoured
  // the enum and the other left the coin in charge.
  travelHoldMode() {
    if(this.policy?.survivalEnabled===false)return 'off';
    const m = this.policy.travelHold ?? TRAVEL_HOLD_MODE;
    if (m !== 'ab' && m !== 'half') return m;
    if (!this._saidAbRetired) {
      this._saidAbRetired = true;
      this.note('travel_hold: the A/B is retired — treating this as "on"', {
        was: m,
        why: 'holding at a wall to heal is the behaviour now, not a treatment. The control ' +
             'arm walked hurt characters straight past the only free healing on the road, ' +
             'and the deaths this fleet actually suffers are stuck-and-eaten rather than ' +
             'travelled-badly — which no arm of the experiment addressed',
        what_to_do: 'set travel_hold to on/observe/off; ab and half will keep meaning on',
      });
    }
    return 'on';
  }

  // ONE JOURNEY-SCOPED COUNTER, WITH THE KIND KEPT BESIDE THE TOTAL. A hop-wall
  // hold, sanctuary pause, route-adjacent refuge and baked-track station are all
  // shelter, but only the first is literally a wall taken at a hop boundary.
  recordTravelShelterStop(kind, { count = 1, heldMs = 0 } = {}) {
    const n = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
    const ms = Number.isFinite(Number(heldMs)) ? Math.max(0, Math.trunc(Number(heldMs))) : 0;
    if (!n) return;
    this.travelSafeStops = (this.travelSafeStops ?? 0) + n;
    // `travelHeldMs` is also the hop-wall budget clock. Preserve that control meaning:
    // route/track rests are telemetry, and must not spend the budget that decides whether a
    // later boundary hold is allowed. The inclusive clock is separate.
    if (kind === 'hop_wall' || kind === 'sanctuary')
      this.travelHeldMs = (this.travelHeldMs ?? 0) + ms;
    this.travelShelterHeldMs = (this.travelShelterHeldMs ?? 0) + ms;
    const field = {
      hop_wall: 'travelHopWallStops', sanctuary: 'travelSanctuaryStops',
      route: 'travelRouteStops', track: 'travelTrackStops',
    }[kind];
    if (field) this[field] = (this[field] ?? 0) + n;
    traceSurvival(this.s, 'travel_shelter_stop', { kind, count: n, held_ms: ms,
      journey_stops: this.travelSafeStops, journey_held_ms: this.travelShelterHeldMs });
  }

  // Is this a moment where a hold is even the question? Cheap, and asked at every hop
  // boundary in BOTH arms — the control has to log the counterfactual or the comparison is
  // between "journeys where we held" and "all journeys", which is not a comparison.
  travelHoldCandidate(at) {
    const c = this.s.client;
    const v = c?.vitals?.();
    const hp = v?.health, vig = v?.vigor?.value ?? null;
    if (!hp?.max) return { candidate: false, why: 'health unreadable' };
    const frac = hp.value / hp.max;
    const below = this.policy.travelHoldBelow ?? 0.75;
    // ARRIVING HURT IS FINE — the destination is somebody's decision and there is usually
    // a reason to be there. Only the rooms in the MIDDLE are ours to stop in.
    if (!(at.remaining > 0)) return { candidate: false, why: 'last room of the journey' };
    if (frac >= below) return { candidate: false, why: `healthy enough (${Math.round(frac * 100)}%)`, frac };
    // VIGOR DOES NOT GATE REFUGE, AND IT NEVER SHOULD HAVE.
    //
    // This gate has now been wrong three times and the third time is the interesting one,
    // because the first two were about the NUMBER and the number was never the problem.
    //
    //   100  above anything an unfed fleet can present, so the hold never fired at all
    //    80  REST_VIGOR_CAP itself — the most resting can give you — so a character even
    //        slightly under was refused while vigor drains as it walks. Measured: 8 of 18
    //        deaths were characters down to 1 or 2 health refused at 74, 76, 78.
    //   none this
    //
    // The argument for having one was exposure: health returns at a rate set by vigor, so a
    // top-up at low vigor costs more standing still than it buys. THAT ARGUMENT DOES NOT
    // APPLY HERE, because the place being stood in is a safe spot — a square the coarse grid
    // offers and the mover refuses, which is exactly why a creature cannot path to it. The
    // whole mechanism is that standing there is not exposure. And where the square turns out
    // to be wrong, `restUntil` aborts the moment health falls rather than sitting out the
    // leash, so a bad wall costs one interrupted rest and not a death.
    //
    // It was also a deadlock in its own right: resting is how vigor comes back, and the gate
    // on resting was vigor. A character at 2 health and 74 vigor was refused the only thing
    // that would have fixed either number.
    //
    // So a traveller that is hurt and has a wall rests, and rests to FULL health and at least
    // the resting cap of vigor — see the restUntil call below, which asks for both. The knob
    // survives for anyone who wants the old behaviour (`travel_hold_vigor: 80`), and nothing
    // is the default.
    const minVigor = this.policy.travelHoldVigor ?? 0;
    if (minVigor > 0 && vig != null && vig < minVigor)
      return { candidate: false, why: `vigor ${vig} — under the floor this fleet set at ${minVigor}`,
               frac, vigor: vig };
    // Nearby monsters do not veto cover. The selector checks whether bodies or
    // walls block the actual approach to each refuge.

    // AND A WALL STOPS MONSTERS, NOT PEOPLE. THIS IS THE ONE THING THAT OUTRANKS BEING HURT.
    //
    // A safe spot works because a creature cannot path to it — that is the whole mechanism,
    // and it says nothing whatever about a player, who can walk to the same square, swing
    // first, and take the pack. `PREFERRED_QUIET_RETREATS` learned this the expensive way:
    // "no monsters spawn here" is TRUE of room 2 and is not the same fact as player-safe,
    // and Gonzo was killed there twice in one evening.
    //
    // So the trade a hold makes is different when there are people about. Standing still
    // for eighty-seven seconds with a full pack is the best target this game offers.
    // Running for the next room is worse against the troll and better against the person:
    // dying to the troll costs the walk back, dying to the player costs everything carried.
    //
    //   'refuse' (the default) — no hold while a player who is not ours is in the room, or
    //                            while the FLEET-WIDE grudge book has a live entry. A grudge
    //                            is somebody who attacked one of us within the hour, which
    //                            is the closest thing to "PvP is anticipated" that exists.
    //   'room'                 — only the player standing here counts; a grudge elsewhere
    //                            does not stop a hold on a quiet road.
    //   'ignore'               — the behaviour from before this existed.
    //
    // `party.isFleetmate` is how one of ours is told from a stranger, and a keeper that has
    // not had a pass yet is absent from that roster — so this can call a fleetmate a
    // stranger for a few seconds after a restart. Being wrong that way costs a pause we
    // would have taken, which is the cheap direction.
    const pvp = this.policy.travelHoldPvp ?? 'refuse';
    if (pvp !== 'ignore') {
      // A ROOM WE CANNOT READ REPORTS NOBODY, which is the pre-existing behaviour and the
      // honest one: this gate can only ever say "somebody is here", never "nobody is".
      const here = c?.room?.objects ? [...c.room.objects.values()] : [];
      const strangers = here.filter(o =>
        o.id !== c.selfId && (o.flags & OF.PLAYER) &&
        !party.isFleetmate(c.rsc?.get(o.nameRsc)));
      if (strangers.length)
        return { candidate: false, frac, players: strangers.length,
                 why: `${strangers.length} player(s) here who are not ours — a wall stops ` +
                      `monsters, not people` };
      if (pvp === 'refuse') {
        const live = grudge.activeGrudges();
        if (live.length)
          return { candidate: false, frac, grudges: live.length,
                   why: `${live.length} live grudge(s) — PvP is anticipated, and a stationary ` +
                        `character with a full pack is the best target in the game` };
      }
    }
    return { candidate: true, frac, vigor: vig, health: hp.value, max: hp.max };
  }

  // The hook body. Runs at every interior hop boundary of every journey.
  async travelHold(at, arm) {
    // THE HOP BOUNDARY IS THE SAFE PLACE TO ACT, and both halves of it live here.
    //
    // The mover is not stepping between rooms, so nothing is contended: the keeper can sit
    // the character down without fighting the journey for it. That is why `rest` and
    // `safe_spot` are on this clock and `flee`/`fight_back`/`play_dead`/`arm` are not —
    // see TRAVEL_GUARD_DEFAULTS.
    //
    // SANCTUARY FIRST, BECAUSE IT IS FREE. If this hop landed us in an inn, healing costs
    // nothing at all: nothing spawns there and nothing can reach us. A wall in the open is
    // the SECOND-best answer to the same question and every second of it is exposed.
    //
    // This is the gap Cccc fell through. `restBeforeSettingOut` runs once, at the top of a
    // journey, and his journey started in the Underworld — "not somewhere safe to sit
    // down". He then passed THROUGH the Limping Toad Inn nineteen seconds later at 11 of
    // 37 and walked straight out the far door, because nothing asked the question a second
    // time. It is asked at every boundary now.
    await this.travelRestAtSanctuary(at, arm).catch(e =>
      this.note('mid-journey sanctuary rest failed', { why: e.message }));

    const mode = this.travelHoldMode();
    if (mode === 'off') return;
    // The switch, and it is deliberately AFTER the sanctuary rest: they are two different
    // faculties and turning the wall hold off is not a statement about inns.
    if (!this.travelAllows('safe_spot')) {
      this.ledgerEvent('travel_pause', {
        journey: at.journey, arm, room: at.room?.num ?? null, room_name: at.room?.name ?? null,
        hops_done: at.hops_done, remaining: at.remaining,
        spot: null, did: 'did not consider a wall',
        why: 'travel_guard.safe_spot is off for this character',
      });
      return;
    }
    const look = this.travelHoldCandidate(at);
    if (!look.candidate) {
      // A REFUSAL THAT LEAVES NO TRACE CANNOT BE ARGUED WITH.
      //
      // This used to `return` here and write nothing, and the cost of that was exact: across
      // one window of 1,599 travel-journey events and 13 deaths, the ledger held FOUR hold
      // decisions. Asked "of the characters that died, how many tried to shelter at a wall",
      // the honest answer was that the record could not say -- 7 of the 10 had the question
      // refused silently, and which of the six gates did it was unknowable after the fact.
      // That is the same shape as `purpose` sitting outside a schema for a year with every
      // keeper's audit switched off: a decision that does nothing and says nothing.
      //
      // Not every refusal is worth a line. Two of them are the system working -- a healthy
      // character has no business stopping, and the last room of a journey is the caller's
      // to arrive hurt in -- and writing those would put a record on every hop of every
      // journey and drown the ones that matter. So the ones recorded are exactly the ones
      // where the character WANTED to stop and something else refused it: hurt, mid-journey,
      // and turned away by an explicit vigor floor or by people about.
      if (look.frac != null && look.frac < (this.policy.travelHoldBelow ?? 0.75) && at.remaining > 0)
        this.ledgerEvent('travel_pause', {
          journey: at.journey, arm, room: at.room?.num ?? null, room_name: at.room?.name ?? null,
          hops_done: at.hops_done, remaining: at.remaining,
          health: look.health ?? null, max: look.max ?? null, vigor: look.vigor ?? null,
          spot: null, did: 'did not consider a wall', why: look.why,
          note: 'hurt and mid-journey, so this is a refusal worth counting rather than the ' +
                'ordinary case of a character that did not need to stop',
        });
      return;
    }

    // A spot is looked for in BOTH arms. Whether one exists is a fact about the room, not
    // about the arm, and the control arm's record is worth nothing without it: "we would
    // have held here" and "there was nowhere to hold" are the two different answers this
    // experiment is trying to tell apart.
    const geo = this.s.world?.geometry, me = this.s.client?.self;
    let spot = null;
    if (geo && me) {
      try {
        // THE SAFE-SPOT BOOK IS RETIRED AND NOTHING IS CONSULTED HERE BUT GEOMETRY.
        // A handle on it used to be read at this point so that "a square the book has
        // already discredited is never offered to travel either", and written back on
        // failure so a travel hold could condemn a square PERMANENTLY. Both are gone: the
        // record was filed against the hold rather than the body, so it condemned squares
        // nobody had stood on. See the tombstone in m59-safespots.mjs.
        const onward = this.onwardExit(at.room?.num ?? null, at.destination ?? null);
        // book: null -- see the note at the shelter selector. The formula answers this, not
        // the ledger, and that is the operator's instruction rather than an optimisation.
        spot = nearestSafeSpot(geo, me, { book: null, room: at.room?.num ?? null,
                                          unreachable: this.unreachableIn(at.room?.num ?? null),
                                          reach: recoveryRefugeReach(geo, me,
                                            this.s.client?.room?.objects, this.s.client?.selfId,
                                            this.s.client?.playersOnline),
                                          // The cap is the operator's if set; otherwise the
                                          // room, and with an exit named it is not applied.
                                          within: this.policy.travelHoldWithin
                                            ?? (Math.max(geo.rows ?? 0, geo.cols ?? 0) || 64),
                                          onward, forwardBias: TRAVEL_FORWARD_BIAS });
      } catch { spot = null; }
    }

    const base = { journey: at.journey, arm, room: at.room?.num ?? null, room_name: at.room?.name ?? null,
                   hops_done: at.hops_done, remaining: at.remaining,
                   health: look.health, max: look.max, vigor: look.vigor,
                   spot: spot ? { col: spot.col, row: spot.row, steps: spot.steps_away,
                                  proven: !!spot.proven, back_cover: spot.back_cover ?? null } : null };

    // WALKING ON, AND THERE ARE ONLY TWO REASONS LEFT TO. `arm === 'walk'` now means
    // `travel_hold: off` and nothing else — the coin that used to produce it is retired
    // (see TRAVEL_HOLD_MODE) — so a `walked on` row is somebody's setting or an empty
    // room, never an experiment spending half its journeys on the worse answer.
    if (arm === 'walk' || mode === 'observe' || !spot) {
      this.ledgerEvent('travel_pause', { ...base, did: spot ? 'walked on' : 'walked on — no spot here',
        why: !spot ? 'nothing in this room scored as a wall'
           : mode === 'observe' ? 'observing only'
           : 'travel_hold is off for this character' });
      return;
    }

    // ---- holding
    const budget = this.policy.travelHoldBudgetMs ?? 180_000;
    this.travelHeldMs ??= 0;
    if (this.travelHeldMs >= budget) {
      this.ledgerEvent('travel_pause', { ...base, did: 'walked on — out of holding budget',
        held_so_far_ms: this.travelHeldMs,
        why: 'a journey that keeps stopping is a journey that never arrives' });
      return;
    }

    const t0 = Date.now();
    const hpBefore = look.health;
    const took = await this.takeRecoverySpot('resting at a wall part-way through a journey',
                                          { source: 'travel' })
      .catch(e => ({ took: false, why: e.message }));
    if (!took?.took) {
      // `fine_tried` is what the fine approach said when the square walk had already failed.
      // Carried through because "could not walk back to the square" is the commonest refusal
      // here and on its own it does not say whether the fallback ran, let alone why it lost.
      this.ledgerEvent('travel_pause', { ...base, did: 'could not take the spot',
                                         why: took?.why ?? 'unknown',
                                         ...(took?.fine_tried ? { fine_tried: took.fine_tried } : {}) });
      return;
    }
    // restUntil polls every 3s and aborts on damage, which is exactly the behaviour wanted
    // here: a wall that is being hit is not a wall, and walking on is the better of two
    // bad options once that is known.
    // FULL, NOT NINE TENTHS, AND NOT A SIP EITHER.
    //
    // The last tenth costs as long as the first half and every second of it is a second
    // something can find you — true on open ground, and NOT true on a square a creature
    // cannot path to, which is the whole mechanism of a safe spot. A traveller that has gone
    // to the trouble of reaching a wall should leave it healed, and `restUntil` aborts on
    // damage if the wall turned out to be wrong.
    //
    // I shortened this to a sip and it was the wrong lesson from the right measurement. A
    // leg that spends 180 seconds resting is not a slow road — it is a character getting
    // well, and the harness already counts that separately for exactly this reason. What must not
    // happen is the stop DIVERTING the journey: the pause belongs to the hop boundary, the
    // objective is kept, and the crossing afterwards resumes the same line it was walking.
    const rest = await skills.restUntil(this.s, {
      health: this.policy.travelHoldTo ?? 1,
      // VIGOR COMES ALONG IF IT IS CLOSE — AND IS THE WHOLE REASON TO STOP IF IT IS GONE.
      //
      // This read "it does not hold the journey up from the bottom", and the bottom is
      // exactly where it has to. The argument was that climbing from near-zero is slow and
      // only buys RUNNING; what it missed is that running is not a luxury on these roads, it
      // is the speed every downstream budget assumes. A traveller that gets up at vigor one
      // walks at half pace into the next room, and if that room is Ukgoth it does not come
      // out: 43 minutes, four `every square for that exit refused`, on a crossing that runs
      // in 24-27 seconds.
      //
      // So there are two regimes and the old rule only described one. ABOVE the travel floor,
      // vigor is a nice-to-have and tags along if it is close. BELOW it, being tired IS the
      // emergency that stopped us, and getting up before the cap means stopping for nothing.
      vigor: this.tooTiredToTravel() ? REST_VIGOR_CAP
             : (vigorPct(this.s.client?.vitals?.()) ?? 0) >= REST_VIGOR_WORTH_WAITING
               ? REST_VIGOR_CAP : 0,
      maxSeconds: Math.round(Math.min(90_000, budget - this.travelHeldMs) / 1000),
    }).catch(e => ({ error: e.message }));
    const heldMs = Date.now() - t0;
    this.recordTravelShelterStop('hop_wall', { heldMs });
    const hpAfter = this.s.client?.vitals?.()?.health?.value ?? null;

    // LEAVING IS FORCED, and it has to be. `leaveHold` refuses a DISCRETIONARY departure
    // below the rest threshold, which is right for roaming and would be catastrophic here:
    // the character would be pinned at a wall in the middle of nowhere by the very rule
    // meant to protect it, with the rest of the journey still to walk. Continuing a
    // journey somebody asked for is not discretionary.
    const left = await this.leaveHold('carrying on with the journey', { force: true })
                           .catch(e => ({ refused: true, why: e.message }));

    this.ledgerEvent('travel_hold', {
      ...base, did: 'held a wall and rested',
      held_ms: heldMs, health_after: hpAfter,
      gained: hpAfter != null && hpBefore != null ? hpAfter - hpBefore : null,
      rested: rest?.reason ?? rest?.why ?? rest?.error ?? null,
      hit_while_held: rest?.interrupted_by_damage ?? null,
      left_ok: !left?.refused,
      why: 'safe spots are the only place outside a town where health comes back without a fight',
    });
    this.note('rested at a wall mid-journey', {
      room: at.room?.name, held_s: Math.round(heldMs / 1000),
      health: `${hpBefore} -> ${hpAfter}`, spot: `${spot.col},${spot.row}`,
      proven: !!spot.proven, remaining_hops: at.remaining,
    });
  }

  // DO NOT SET OUT HURT FROM A PLACE THAT IS FREE TO HEAL IN.
  //
  // A character standing in an inn is in the one situation where resting costs nothing at
  // all: nothing spawns there, nothing can reach it, and the recovery that would take
  // eighty-seven exposed seconds at a wall in the Cragged Mountains takes the same eighty-
  // seven safe ones here. Walking out at 40% and topping up later is strictly worse — the
  // topping up happens on a road with trolls on it, if it happens.
  //
  // It is also the commonest way the fleet is hurt at all. A character that has just come
  // out of the Underworld arrives in an inn at a fraction of its health, and the next thing
  // anything asks it to do is cross the world; on the arena fleet that is a death cascade,
  // one death putting a character on a long road it is in no state to walk.
  //
  // VIGOR CANNOT REACH 100% BY RESTING AND THE DEFAULT SAYS SO. `REST_VIGOR_CAP` is 80 of
  // 200 — everything above it has to be EATEN (`create food` is 2 elderberry AND 2 herbs) —
  // so "rest to full vigor" means the resting cap, which is the highest an unfed character
  // can present. Asking for more would be a gate nothing could ever pass, which is the
  // failure mode this repository keeps paying for.
  //
  // Only from a SANCTUARY, and that is the whole safety argument: `sanctuary()` reads the
  // spawn index rather than the room name, so it is true of inns, banks, shops and quiet
  // stretches of road, and false of anywhere that generates monsters. Somewhere hostile,
  // the ordinary survival ladder decides — sitting down there is how characters die.
  // SIT DOWN IF THIS HOP LANDED US SOMEWHERE HEALING IS FREE.
  //
  // Called at every hop boundary of every journey, and it is the answer to the question
  // `restBeforeSettingOut` can only ask once. A journey crosses inns; a journey that
  // STARTS somewhere it cannot rest (the Underworld, a corridor, a field) and then walks
  // through one is the ordinary case after a death, and it is exactly the case that was
  // getting characters killed a room later.
  //
  // BOTH BARS, TO THE HIGHEST SITTING CAN TAKE THEM. Health to full and vigor to the
  // resting cap — 80 of 200, because everything above it has to be EATEN and `restUntil`
  // would otherwise sit for its whole budget waiting for a number that cannot arrive.
  //
  // Full health rather than `travel_hold_to`, and the difference is the room. That setting
  // stops at 0.9 for a good reason — at a wall in the open the last tenth costs as long as
  // the first half and every second of it is a second something can find you. In a
  // sanctuary that argument does not apply at all: the exposure is zero, so the only thing
  // the last tenth costs is time, and arriving at 100 rather than 90 is worth it.
  //
  // VIGOR IS NOT A DETAIL HERE. It sets the rate health comes back at, so a character that
  // leaves an inn at full health and 11 vigor is a character that will not heal again for
  // the rest of the road. Cccc left the Limping Toad at 11 of 200 and never rose above it.
  async travelRestAtSanctuary(at, arm) {
    if (!this.travelAllows('rest')) return;
    // NOT ON THE LAST HOP. A rest "part-way through a journey" in the destination room is not part-way:
    // the journey is over, and holding its job open here for up to four minutes is what refused the next
    // walk of the same fleetscript run as "busy" (Zheng He in South Barloque and Marion, 2026-10-12). The
    // keeper's own ladder rests the body there once the job has ended.
    if (at && at.remaining === 0) return;
    const room = this.s.world?.room;
    if (!this.sanctuary(room)) return;
    const v = this.s.client?.vitals?.();
    const hp = v?.health;
    if (!hp?.max) return;
    const frac = hp.value / hp.max;
    const wantHealth = this.policy.travelStartHealth ?? 1;
    if (!(wantHealth > 0)) return;
    const vig = vigorPct(v);
    // Same rule as the wall, and the same correction: a traveller that is merely tired takes
    // whatever vigor arrives with the health, but one BELOW THE TRAVEL FLOOR is stopping
    // *because* it is empty and must leave full. A sanctuary is the cheapest possible place
    // to do it — nothing can reach us and the only cost is seconds.
    const wantVigor = this.tooTiredToTravel() || (vig ?? 0) >= REST_VIGOR_WORTH_WAITING
      ? Math.min(this.policy.travelStartVigor ?? REST_VIGOR_CAP, REST_VIGOR_CAP) : 0;
    if (frac >= wantHealth && (vig == null || vig >= wantVigor)) return;
    // An inn is player-safe, not fleetmate-free, and something swinging makes this a fight
    // rather than a pause — the same gate the mid-journey hold and the pre-departure rest
    // both use.
    const near = this.inReachOfUs();
    if (near?.length) {
      this.ledgerEvent('travel_pause', {
        journey: at.journey, arm, room: room?.num ?? null, room_name: room?.name ?? null,
        hops_done: at.hops_done, remaining: at.remaining,
        health: hp.value, max: hp.max, vigor: v?.vigor?.value ?? null,
        spot: null, did: 'walked on — a sanctuary with something in reach',
        why: `${near.length} in reach — not a moment to sit`,
      });
      return;
    }
    const t0 = Date.now();
    const before = { health: hp.value, vigor: v?.vigor?.value ?? null };
    // Restored in the `finally` below. Left as 'recovering' it would tell the position
    // pulse that this character is not going anywhere for the rest of the journey — which
    // is the excuse that stops the wedge instrument looking, on a character that is about
    // to walk back out onto a road.
    const wasDoing = this.doing;
    this.doing = 'recovering';
    try {
      // PFLAG_MOVED_SINCE_ENTRY has to be set or a rest recovers nothing however long it
      // sits — the commonest reason a rest in an inn does nothing at all.
      await this.settle('resting part-way through a journey').catch(() => {});
      const budget = this.policy.travelSanctuaryBudgetMs ?? 240_000;
      // AND CANCELLABLE: a cancel_movement (a fleetscript re-issuing, an operator) ends the rest, so it
      // cannot hold a journey's job open against the walk that replaces it.
      const restGeneration = this.s.movementGeneration;
      const rest = await skills.restUntil(this.s, {
        health: wantHealth, vigor: wantVigor,
        maxSeconds: Math.round(budget / 1000),
        shouldCancel: () => !!(this.travelInterrupted?.() || this.s.movementWasCancelled?.(restGeneration)),
      }).catch(e => ({ error: e.message }));
      const after = this.s.client?.vitals?.();
      const heldMs = Date.now() - t0;
      this.recordTravelShelterStop('sanctuary', { heldMs });
      this.ledgerEvent('travel_hold', {
        journey: at.journey, arm, room: room?.num ?? null, room_name: room?.name ?? null,
        hops_done: at.hops_done, remaining: at.remaining,
        health: before.health, max: hp.max, vigor: before.vigor,
        spot: null, kind: 'sanctuary',
        did: 'rested in a sanctuary part-way through a journey',
        held_ms: heldMs,
        health_after: after?.health?.value ?? null,
        vigor_after: after?.vigor?.value ?? null,
        gained: after?.health?.value != null ? after.health.value - before.health : null,
        rested: rest?.reason ?? rest?.why ?? rest?.error ?? null,
        hit_while_held: rest?.interrupted_by_damage ?? null,
        why: 'this hop landed somewhere nothing spawns and nothing can reach us, so the ' +
             'points that cost exposure at a wall cost nothing at all here',
      });
      this.note('rested in a sanctuary mid-journey', {
        room: room?.name ?? null, held_s: Math.round(heldMs / 1000),
        health: `${before.health} -> ${after?.health?.value ?? '?'}/${hp.max}`,
        vigor: `${before.vigor} -> ${after?.vigor?.value ?? '?'} of ${skills.VIGOR_MAX} ` +
               `(sitting caps at ${Math.round(REST_VIGOR_CAP * skills.VIGOR_MAX)})`,
        remaining_hops: at.remaining,
        note: 'vigor as well as health — it sets the rate health comes back at, so leaving ' +
              'an inn full but exhausted is leaving with no recovery for the rest of the road',
      });
    } finally { this.doing = wasDoing; }
  }

  async restBeforeSettingOut() {
    const target = this.policy.travelStartHealth ?? 1;
    if (!(target > 0)) return { rested: false, why: 'travel_start_health is off' };
    // The same faculty as the mid-journey sanctuary rest, so the same switch. An operator
    // turning `rest` off means "do not stop this character to heal", and a version of that
    // which still stopped it at the start of every journey would be a setting that half
    // works — which is the failure mode this repository keeps a whole document about.
    if (!this.travelAllows('rest'))
      return { rested: false, why: 'travel_guard.rest is off for this character' };
    const room = this.s.world?.room;
    if (!this.sanctuary(room)) return { rested: false, why: 'not somewhere safe to sit down' };
    const v = this.s.client?.vitals?.();
    const hp = v?.health;
    if (!hp?.max) return { rested: false, why: 'health unreadable' };
    const frac = hp.value / hp.max;
    // A FRACTION, LIKE EVERYTHING ELSE HERE. `REST_VIGOR_CAP` is 0.4 — 80 of the 200 the
    // bar is drawn against — and `restUntil` takes fractions too. Comparing it against the
    // raw vigor value would make the gate `80 >= 0.4`, always true, and the whole thing
    // would be off while reading on.
    const vig = vigorPct(v);
    const wantVigor = Math.min(this.policy.travelStartVigor ?? REST_VIGOR_CAP, REST_VIGOR_CAP);
    if (frac >= target && (vig == null || vig >= wantVigor))
      return { rested: false, why: 'already fit to set out' };
    // Anything swinging at us makes this a fight rather than a pause, exactly as it does
    // for the mid-journey hold.
    const near = this.inReachOfUs();
    if (near?.length) return { rested: false, why: `${near.length} in reach — not a moment to sit` };

    this.doing = 'recovering';
    this.note('resting before setting out', {
      health: `${hp.value}/${hp.max}`, vigor: v?.vigor?.value ?? null,
      want: Math.round(target * 100) + '%',
      want_vigor: Math.round(wantVigor * 200) + ' of 200 (the resting cap)',
      room: room?.name ?? null,
      why: 'this is the one place healing is free — nothing spawns here and nothing can ' +
           'reach us, so the points that would cost exposure on the road cost nothing at all',
      note: 'vigor stops at the resting cap because everything above it has to be eaten' });
    // PFLAG_MOVED_SINCE_ENTRY has to be set or the character recovers nothing however long
    // it sits, which is what `settle` is for. Cheap, and the commonest reason a rest in an
    // inn does nothing at all.
    await this.settle('about to set out, and resting only works after moving').catch(() => {});
    const rest = await skills.restUntil(this.s, {
      health: target, vigor: wantVigor,
      maxSeconds: Math.round((this.policy.travelStartBudgetMs ?? 240_000) / 1000),
    }).catch(e => ({ error: e.message }));
    const after = this.s.client?.vitals?.();
    this.note('set out after resting', {
      health: after?.health ? `${after.health.value}/${after.health.max}` : null,
      vigor: after?.vigor?.value ?? null,
      gained: after?.health && hp ? after.health.value - hp.value : null,
      stopped_because: rest?.reason ?? rest?.why ?? rest?.error ?? 'reached the target' });
    return { rested: true, health_after: after?.health?.value ?? null };
  }

  travelInterrupted() {
    return (this.survivalInterruptedPass != null && this.survivalInterruptedPass === this.passes)
      || (this.frozenUntil != null && Date.now() < this.frozenUntil);
  }

  // A sanctuary is a detour, not a replacement order. Keep the parent note in
  // place throughout the await: cancellation/death may delete it, and we must
  // never resurrect it from a saved local after control changes.
  async recoveryTravel(room, opts = {}) {
    if (!this.suspendedJourney) this.suspendJourney('recovery detour');
    // A fine walk also owns packets even though it is not goTravelling.
    // Cancel that generation before starting a protected detour, and publish
    // its lifetime so a controller cannot re-enter between fine requests.
    this.cancelForSurvival(null,'recovery detour retains the destination',
      {preserveId:currentSurvivalDecision(this.s)?.id,origin:keeperOrigin('recovery_detour')});
    if (this.inert?.travelling) this.revive('recovery detour retains the destination');
    const trip={id:process.pid+'-'+Date.now(),to:room,at:Date.now(),origin:keeperOrigin('recovery_detour')};
    this.s.keeperRecoveryTravel=trip;
    this.ledgerEvent('travel_recovery_detour', {to:room,resume_to:this.suspendedJourney?.to??null});
    try{return await this.travel(room,{...opts,recoveryDetour:true,origin:opts?.origin??trip.origin});}
    finally{if(this.s.keeperRecoveryTravel===trip)this.s.keeperRecoveryTravel=null;}
  }

  async travel(room, opts) {
    // Explicit orders enter through travelJob/goTravelling and retire the old
    // objective there. Keeper rungs (including provisioning) are subordinate to
    // an existing suspended objective, even if they use ordinary travel().
    const { holdBetweenRooms = true, recoveryDetour = !!this.suspendedJourney, onHop,
            chalice: _chalice, chaliceRoom: _chaliceRoom, explicitOrder = false,
            approachLeg = false, deskRide = true, ...sessionOpts } = opts ?? {};
    // Capture the issuer before a nested shelter walk replaces the live cell order.
    const capturedTravelOrigin = sessionOpts.origin ?? (Number(this.inert?.to) === Number(room) ? this.inert?.origin : null)
      ?? (Number(liveMoveOrder(this.s)?.to) === Number(room) ? liveMoveOrder(this.s)?.origin : null);
    const journeyGuard = { ...this.travelGuard(this.inert?.travelling ? this.inert.guard : null) };
    // NOTHING TRAVELS TO THE UNDERWORLD, AND A JOB HOLDING IT MUST BE DROPPED RATHER THAN
    // RETRIED. The gate in m59-travelgate.mjs says the same thing for the broker's `travel`
    // tool and for fleetScript, and it is repeated here because the KEEPER's own travel does
    // not go through that gate — which is why the loop it describes ran for two hours on a
    // keeper-backed character with the gate already in the tree.
    //
    // Zoot, prod 2026-09-20: died at 20:50:01, woke in room 1, escaped, and then re-issued
    // `travel(1)` 767 times between 21:05 and 23:05 — one every 8.7 seconds, `legs: 0` and
    // `planned_legs: 0` every time, until a keeper restart cleared it. Refusing is only half
    // the fix: the suspended journey is what kept handing the destination back, so it goes too.
    if (room != null && Number(room) === UNDERWORLD) {
      const held = this.suspendedJourney?.to;
      this.suspendedJourney = null;
      this.note('refusing a journey to the Underworld and dropping the job that held it', {
        to: Number(room), was_suspended_to: held ?? null,
        why: 'room 1 has no inbound route: a body arrives by dying and leaves by a portal, so ' +
             'this destination can only ever be refused, and retrying it is the whole defect' });
      return { arrived: false, reason: 'the Underworld is not a travel destination' };
    }
    // THE PVP RETURN DELAY, at the same single gate as the Underworld and the confinement:
    // every keeper-initiated journey passes through here. `recoveryDetour` is read from the
    // CALLER's options, never the default — a recovery detour is survival, while the default
    // merely reflects that some journey is suspended. See `pvpReturnGate`.
    {
      const refused = this.pvpReturnGate(room, { explicitOrder: explicitOrder === true,
                                                 recoveryDetour: opts?.recoveryDetour === true });
      if (refused) return refused;
    }
    // THE STATION'S APPROACH (policy.approachRooms; a farm strategy's `confine.approach`). Operator,
    // 2026-10-11, of the Qor masters' lupogg station in the Barloque sewers: "Fix the lupogg strategy to
    // work going from outside and have it include going to the sewers, *always going* through via valley
    // of ileria -> sandy shores -> ocean -> sewers" -- 544 Valley of Ileria, 552 the Great Ocean, 562 the
    // sandy shores, 108 the sewers (m59-map.json edgeExits: 544 north is 552, 552 east is 562, 562 east is
    // 108). Without it the router may take Barloque's own door (101 -> 108), and a character outside its
    // confinement had no declared way in at all: Robin sat in Marion reporting "stranded in 201".
    //
    // A journey to the station (or any confined room) that STARTS OUTSIDE the confinement walks the
    // approach first, leg by leg, from wherever on it the body already is; each leg is an ordinary
    // journey through this same function, so every gate below still applies to it, except that an
    // approach room is not "outside the confinement" -- the operator declared that road. A failed leg
    // returns its failure; the next pass asks again from the room the body reached.
    if (!approachLeg) {
      const legs = this.approachLegs?.(room);
      if (legs?.length) {
        this.note('taking the station approach', { to: Number(room), legs,
          here: this.s.world?.room?.num ?? null, approach: this.policy.approachRooms });
        for (const leg of legs) {
          const r = await this.travel(leg, { ...(opts ?? {}), origin: opts?.origin ?? keeperOrigin('station_approach'), approachLeg: true });
          if (!r?.arrived) return { ...(r ?? {}), arrived: false, approach: { failed_at: leg, legs } };
        }
      }
    }
    // A cancelled stockpile leg used to fall through into an apothecary leg in
    // the same awaited errand. Give the next survival pass the body first.
    if (this.travelInterrupted())
      return { arrived: false, paused: true, cancelled: true, reason: 'travel paused for survival' };
    // In 2600 bound for 2601: passLeverPuzzle works it; no walk, no meal, no journey row.
    const handedOff = this.leverPuzzleHandoff?.(this.s.world?.room?.num, room);
    if (handedOff) return handedOff;
    await this.eatBeforeTravel(room);
    const movementGeneration = sessionOpts.movementGeneration ?? this.s.movementGeneration;
    // ONE GATE, BECAUSE THERE IS MORE THAN ONE DOOR AND I KEPT FINDING NEW ONES.
    //
    // `confineRooms` was enforced first in `retreatToSafety`, and a character left anyway —
    // through `nearestSanctuary`, a second chooser reached by the post-death recovery walk.
    // Gating choosers one at a time is a losing game: each is survival code, none of them
    // announces itself as travel, and the operator's rule is not about choosers at all. It
    // is "a bot does not change maps outside the region it was confined to", full stop.
    //
    // So it is enforced HERE, at the single call every keeper-initiated journey passes
    // through, and it is a REFUSAL rather than a re-plan: there is nowhere else to send a
    // confined character, and the ordinary pass already knows how to hold a wall.
    //
    // Measured cost of not having this, prod 2026-08-19: Gonzo walked to room 2 twice and
    // was killed there; Camilla was walked out of Castle Victoria through room 2 and on
    // toward an inn TEN legs away, through Ukgoth, minutes after the first gate went in.
    //
    // Silence is the old behaviour: with no `confineRooms` this costs one array check.
    const confine = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms : null;
    // THE ONE EXCEPTION IS CHALICE DUTY, and only to its own rooms: the station, the post,
    // or the room a hand-off was arranged in. A confined holder that could not step out to
    // the station would hold the fleet's only chalice and never hand it to anybody.
    const chaliceRooms = opts?.chalice && this.chaliceCfg
      ? [this.chaliceCfg.station_room, this.chaliceCfg.post_room, ...folRoomsOf(this.chaliceCfg), opts.chaliceRoom]
          .filter(r => r != null).map(Number)
      : [];
    // WAND DUTY USED TO BE THE SECOND EXCEPTION ("a confined Castle Victoria farmer has to reach the
    // bank"), and it was the leak. Operator, 2026-10-10: "Lock everyone over 30HP into room 38" -- and
    // 199 of 204 journeys from 38 to the gate in the next two hours were keeper:wand_duty, every farmer
    // confined to [38] walking out to a station at 2 where Morpheus camps. A confinement is the operator's
    // and outranks an errand's convenience: wandDutyStep now stands down when the station is outside it.
    const approachRoom = approachLeg && (this.policy?.approachRooms ?? []).map(Number).includes(Number(room));
    if (confine?.length && !confine.map(Number).includes(Number(room)) && !chaliceRooms.includes(Number(room))
        && !approachRoom) {
      this.note('refused to leave the confinement', {
        wanted: Number(room), confined_to: confine.map(Number),
        here: this.s.world?.room?.num ?? null, doing: this.doing,
        why: 'the operator confined this character to these rooms. A journey out of them is ' +
             'the thing that has been killing it, and no destination is worth the road',
        note: 'this refuses the JOURNEY, not the reason for it — the pass falls through to ' +
              'whatever it does when it cannot travel, which is normally to hold a wall',
      });
      recordEvent(this.who(), 'confinement_refused_travel', {
        wanted: Number(room), confined_to: confine.map(Number),
        room: this.s.world?.room?.num ?? null,
      });
      return { arrived: false, refused: true, confined: true,
               why: `room ${room} is outside the confinement ${confine.join('/')}` };
    }

    // A PVP STRATEGY'S HOLD (m59-pvp-strategy.mjs `flee_to` with `hold_ms`). The flight landed the body
    // where its allies are; the keeper's own next journey -- back to the farm, to an errand -- would
    // walk it straight out to whoever it ran from. So keeper journeys out of the hold room are refused
    // until it expires, exactly as the confinement refuses them. An EXPLICIT order (travelJob, the
    // operator's travel) is not the keeper's own idea and is let through -- unless the strategy asked
    // for `hold_orders`, because a director (the DUM) moves its units with explicit travel and would
    // walk a fled unit back to its attacker on the next pass. Silence is unset.
    const hold = this.pvpStrategyHold;
    if (hold && Date.now() >= hold.until) this.pvpStrategyHold = null;
    else if (hold && (!explicitOrder || hold.orders === true) && Number(room) !== Number(hold.room)) {
      this.note('refused to leave the PvP strategy hold', {
        wanted: Number(room), hold_room: hold.room, until: new Date(hold.until).toISOString(),
        strategy: hold.strategy ?? null, threat: hold.threat ?? null, orders_held: hold.orders === true, explicit: !!explicitOrder,
      });
      return { arrived: false, refused: true, held: true,
               why: `holding in ${hold.room} for PvP strategy ${hold.strategy ?? '?'} until ${new Date(hold.until).toISOString()}` };
    }

    // AND NOT FROM A SQUARE THE WATCHDOG HAS ALREADY BROKEN A WALK ON. Here, at the same
    // single gate, for the same reason the confinement is: every keeper journey passes
    // through it, and the loop this closes — cancel, re-issue the identical walk, cancel —
    // is a property of re-issuing, not of any one caller. Below the cap the body is moved
    // a couple of squares first so the plan starts somewhere new; at the cap the journey
    // is refused the way the confinement refuses one, and the pass falls through. See
    // `answerWedge` and WEDGE_REPEAT_CAP in m59-watchdog.mjs.
    // A claimed travel job can fail on bodies in a few seconds, before the
    // healthy watchdog (which stands down for its driver) records a wedge.
    // Recover only at this same owner's next routing attempt, never by
    // interrupting its active job, admission wait or cast from the tick loop.
    const trafficOwner=originLabel(capturedTravelOrigin??moveOrigin(null));
    const trafficAdvice=trafficBlinkAdvice(this.trafficJam,{place:this.wedgePlace?.(),to:room,owner:trafficOwner});
    if(trafficAdvice){
      const blinked=await this.wedgeBlink(trafficAdvice).catch(e=>({moved:false,why:e.message}));
      if(this.s.movementWasCancelled?.(movementGeneration))return {arrived:false,cancelled:true,reason:'travel cancelled during traffic recovery'};
      if(blinked?.moved){
        this.trafficJam=null;
        if(this.watch)this.watch.wedgeBreak=null;
        this.tally.traffic_blinks=(this.tally.traffic_blinks??0)+1;
        this.note('blinked past repeated body traffic',{to:Number(room),attempts:trafficAdvice.repeats,from:{room:trafficAdvice.room,row:trafficAdvice.row,col:trafficAdvice.col},landed:blinked.to});
      }
    }
    const wedge = await this.answerWedge(Number(room)).catch(e => {
      this.note('wedge check failed', { why: e.message }); return null;
    });
    if(wedge?.cancelled||this.s.movementWasCancelled?.(movementGeneration))return {arrived:false,cancelled:true,reason:'travel cancelled during wedge recovery'};
    const askedByWatchdog = !!(this.crowdExit && Date.now() - this.crowdExit.at < 60_000
                               && Number(this.crowdExit.room) === Number(this.s.world?.room?.num));
    if (askedByWatchdog) this.crowdExit = null;
    if (wedge?.refused || askedByWatchdog) {
      // Escape a wedge using the nearest local recovery wall, regardless of monster count.
      // A wall means recovery owns the body;
      // falling through to the journey would immediately walk away from it.
      {
        const here = this.s.world?.room?.num ?? null;
        this.note('seeking shelter from a wedge', { room: here, to: Number(room) });
        const left = await this.takeRecoverySpot('wedged — need route shelter',
                                                 { source: 'travel' })
                               .catch(e => ({ took: false, why: e.message }));
        if (this.travelInterrupted() || this.s.movementWasCancelled?.(movementGeneration))
          return { arrived: false, paused: true, cancelled: true, reason: 'travel interrupted during wedge recovery' };
        if (left?.took) {
          const why = 'sheltering after a wedge';
          this.wedgeHold = null;
          this.wantsForwardShelter = null;
          this.survivalInterruptedPass = this.passes;
          this.suspendedJourney ??= { to: Number(room), why: `travelling to ${room}`,
            at: Date.now(), trigger: why, attempts: (this.inert?.attempts ?? 0) + 1,
            deaths_at: this.tally?.deaths ?? 0, guard: journeyGuard,
            ...(capturedTravelOrigin ? { origin: capturedTravelOrigin } : {}) };
          this.s.cancelMovement?.(null, why, { origin: keeperOrigin('wedge_shelter') });
          this.revive(why);
          this.note('journey paused at the wall after a wedge', { to: Number(room) });
          return { arrived: false, paused: true, wedged: true, sheltered: true, reason: why };
        }
        if (left?.via === 'exit' || left?.crossed) {
          this.wedgeHold = null;
          this.note('left a wedge by the exit', { from: here, to: this.s.world?.room?.num ?? null, why: wedge?.why ?? 'the watchdog asked: wedged and taking hits' });
          return { arrived: false, refused: false, wedged: true, left_by_exit: true,
                   why: `left the wedge in room ${here} by the exit; the journey re-plans from room ${this.s.world?.room?.num ?? '?'}` };
        }
        this.note('could not find shelter from the wedge', { why: left?.why ?? 'no answer' });
      }
      if (wedge?.refused) {
        journeyIncident(this, { kind: 'wedge', outcome: { refused: true, wedged: true, reason: wedge.why },
                                     to: room, startedIn: Number(this.s?.world?.room?.num ?? NaN) || null,
                                     startedAt: Date.now(), origin: this.s?.moveOrder?.origin ?? null });
        return { arrived: false, refused: true, wedged: true, gave_up: true, why: wedge.why };
      }
    }

    // THE SHARED CHALICE AS A WAY THERE (m59-desk-travel.mjs). Here, after every gate above has passed the
    // destination, and before the body sets out: when the private `rescueTravel` policy says `desk: true` and
    // walking to the desk, being served and walking on from the landing beats walking (and the unit's own
    // Rescue) by the margin, ride it, then continue from the landing through this same gate. Not on the ride's
    // own legs (`chalice`, `_rideNow`), not on a station approach leg, and never twice in one journey. Silence,
    // a refusal or a failed ride all fall through to the walk.
    if (deskRide && !_chalice && !approachLeg && !this._rideNow && room != null) {
      const { deskRideFirst } = await import('../m59-desk-travel.mjs');
      const desk = await deskRideFirst(this, Number(room), sessionOpts).catch(e => {
        this.note('chalice desk planning failed; walking', { why: e.message }); return null; });
      if (desk?.landed) {
        if (this.travelInterrupted() || this.s.movementWasCancelled?.(movementGeneration))
          return { arrived: false, paused: true, cancelled: true, reason: 'travel paused after the chalice desk ride', via_desk: desk.room };
        // The landing does not change who ordered the journey: the continuation carries the same issuer.
        const rest = await this.travel(room, { ...(opts ?? {}), deskRide: false,
          origin: opts?.origin ?? capturedTravelOrigin ?? keeperOrigin('desk_travel') });
        return { ...(rest ?? {}), via_desk: { landed_in: desk.room, saves_ms: desk.decision?.saves_ms ?? null } };
      }
    }

    // AND SET OUT FIT, IF THIS IS SOMEWHERE FIT CAN BE HAD FOR FREE. Above the journey
    // rather than inside it, because the question is about LEAVING: once the first boundary
    // is crossed the character is on the road and the mid-journey hold owns the decision.
    await this.restBeforeSettingOut().catch(e => this.note('rest before setting out failed',
                                                           { why: e.message }));
    if (this.travelInterrupted() || this.s.movementWasCancelled?.(movementGeneration))
      return { arrived: false, paused: true, cancelled: true, reason: 'travel paused for survival' };

    // The same primitive crosses a nearby room boundary and undertakes a journey. Those
    // are different activities: upstairs-to-downstairs patrol movement is zoning, while
    // a route with intermediate rooms is travel. Decide from the route before the await
    // so the activity clock, hit attribution and any death mid-movement all use the same
    // meaning as the completed trip record.
    let initialRoute = null;
    try { initialRoute = this.s.world?.route?.(room) ?? null; } catch { initialRoute = null; }
    const travelKind = routeTravelKind(initialRoute);
    const plannedLegs = Array.isArray(initialRoute?.hops) ? initialRoute.hops.length : null;
    if (travelKind === 'zoning') this.doing = 'zoning';
    this.recordFrame('setting off');
    // One arm per journey, fixed before the first step so it cannot drift mid-route.
    // THE MODE DECIDES THE ARM, AND FOR "ON" IT DID NOT.
    //
    // `travelHold` checks `mode` for 'off' and 'observe' and then honours `arm === 'walk'`
    // whatever the mode says — so `travel_hold: "on"` was accepted, stored, reported back
    // by `autopilot status`, and SILENTLY LEFT THE COIN IN CHARGE. Half of every journey
    // walked on hurt with the setting reading "on".
    //
    // Found by counting: the shadow fleet ran a whole evening with `travelHold: 'on'` on
    // all twenty-one characters and the ledger holds THREE travel-hold events for the day,
    // two of them `arm: "walk"` — the control arm of an experiment nobody meant to be
    // running. `'on'` was not even in the tool's own enum; the broker stores the string it
    // is given, so a value the schema never allowed became a value the code half-honoured.
    //
    // The enum is the contract: `on` always holds, `observe` writes down what it would have
    // done, `off` is the behaviour from before it existed.
    //
    // AND THERE IS NO COIN LEFT TO LEAVE IN CHARGE. `ab`/`half` were the experiment and the
    // experiment is closed (see TRAVEL_HOLD_MODE). They are accepted so that a roster on
    // disk carrying one does not throw on restart, and they are SAID OUT LOUD rather than
    // quietly honoured — the bug this whole comment block is about was a setting that
    // reported one thing and did another, and mapping a value silently is how you get a
    // second one.
    const holdMode = this.travelHoldMode();
    const arm = holdMode === 'off' ? 'walk' : TRAVEL_HOLD_ARM;
    this.travelHeldMs = 0;
    this.travelShelterHeldMs = 0;
    this.travelSafeStops = 0;
    this.travelHopWallStops = 0;
    this.travelSanctuaryStops = 0;
    this.travelRouteStops = 0;
    this.travelTrackStops = 0;
    const startedAt = Date.now();
    // The room this journey BEGAN in, captured before anything walks. A destination is not a
    // route; two characters asked for the same room from different places are not making the
    // same trip, and comparing them as if they were is how a road looks safe on average.
    const startedIn = Number(this.s?.world?.room?.num ?? NaN) || null;
    // WHO ORDERED THIS JOURNEY. The prototype wrapper (installMoveOrders, bottom of this file)
    // has registered it as the live move order; read it here, before anything can cancel it.
    const journeyOrigin = capturedTravelOrigin ?? moveOrigin(null);
    // WHERE THE BODY STOOD WHEN IT SET OUT, square and fine point, for the incident log.
    const startAt = (me => me ? { room: startedIn, row: me.row, col: me.col, x: me.x, y: me.y } : null)(this.s.client?.self);
    const v0 = this.s.client?.vitals?.()?.health;
    const hpStart = v0?.value ?? null, hpMax = v0?.max ?? null;
    const detailed = detailSettings(this.policy, 'travel');
    const journeyDamageStart = this.hitDamageTotal();
    const maps = [];
    let map = detailed ? {
      room: this.s.world?.room?.num ?? null, name: this.s.world?.room?.name ?? null,
      started_at: startedAt, damage_at_start: journeyDamageStart, health_start: hpStart,
    } : null;
    const closeMap = (at = Date.now()) => {
      if (!map) return;
      const hp = this.s.client?.vitals?.()?.health?.value ?? null;
      const damageAtEnd = this.hitDamageTotal();
      maps.push({ room: map.room, name: map.name, duration_ms: Math.max(0, at - map.started_at),
        damage: Math.max(0, damageAtEnd - map.damage_at_start),
        health_start: map.health_start, health_end: hp });
      map = null;
    };
    let legs = 0;
    let outcome = null;

    // EVERY JOURNEY IS A JOURNEY, INCLUDING THE ONE A SHOPPING TRIP IS MADE OF.
    //
    // `shelterPolicy` is what makes the shelter planner in `walkTo` live rather than dead
    // code — it is read while the route is being planned, and `sheltersAlong` works out
    // which route-adjacent walls a hurt walker may duck into on the way. It is set in
    // exactly ONE place, `goTravelling`, and until now `goTravelling` had exactly one
    // caller: `travelJob`, the external journey path.
    //
    // So the keeper's OWN travel — which is what a supply run is built from,
    // `restockInTown` -> `Autopilot.travel` -> `Session.travel` — crossed the same roads
    // with no shelters planned, no `travel_guard`, and no job slot. Those roads are 599
    // Ukgoth and 598 The Cragged Mountains, which is where most of this fleet's road deaths
    // happen. The comment beside the assignment even asserted the opposite — "an errand, a
    // fight or a shopping trip has no route ahead to divert along" — and a shopping trip is
    // precisely a route ahead: eleven hops out, and eleven back.
    //
    // The operator's model settles the shape: a shop trip IS travel-shop-travel-shop, so
    // each leg is a journey and gets a journey's protection. That is why this goes here,
    // around every internal journey, rather than lifting `shelterPolicy` out of
    // `goTravelling` and installing it piecemeal — the posture and the shelters are the
    // same thing, and splitting them is how they drift apart.
    //
    // NESTING IS SAFE AND IS THE COMMON CASE. `travelJob` already installs the posture
    // before calling this method, and `goTravelling` returns early when a journey or an
    // errand already holds the keeper — so `ours` is false there and the finally below
    // hands nothing back. An ERRAND still outranks a journey and is not upgraded.
    let ourTravelHold = null;
    let holdTimer = null;
    if (!this.inert) {
      if(recoveryDetour && this.suspendedJourney)
        this.ledgerEvent('travel_parent_retained',{to:room,resume_to:this.suspendedJourney.to});
      this.goTravelling(`travelling to ${room}`, { to: room, recoveryDetour, origin: capturedTravelOrigin });
      ourTravelHold = this.inert;
      // Renew only this live owner's lease. Recreating a revoked hold erased the
      // watchdog's suspended destination while the cancelled mover was unwinding.
      if (ourTravelHold) {
        holdTimer = setInterval(() => {
          if (this.inert === ourTravelHold && !this.travelInterrupted()
              && !this.s.movementWasCancelled?.(movementGeneration))
            ourTravelHold.at = Date.now();
        }, 2000);
        holdTimer.unref?.();
      }
    }

    try {
      // A FRAME PER ROOM, NOT PER JOURNEY.
      //
      // 'setting off' and 'arrived' bracket the whole thing, which tells you when the
      // blindness started and nothing about what happened inside it. Camilla's last frame
      // read `why: "setting off"` 17.8 seconds before she died. The watchdog fixed the
      // record's cadence — a frame at least every 8s — but a timer frame says only what
      // the vitals were; it cannot say which room the character was in, because the pass
      // is the only thing that knows where it has got to.
      //
      // So the hop hook writes one too, and between them the record has both: the
      // watchdog's clock and the journey's geography.
      // PUBLISHED ON THE KEEPER FOR AS LONG AS THE JOURNEY LASTS, so that a death can be
      // attributed to the arm that was running when it happened. Deaths are the outcome
      // this experiment is measured on and they are rare — one per 1,180 journeys — so an
      // unattributable death is a real loss of power, not a rounding error.
      // Zoning is not part of the travel-safety experiment. There is no intermediate
      // room in which its treatment can fire, and including it only inflates the
      // denominator with crossings that can never receive a hold.
      const participatesInTravelHold = travelKind === 'travel' && holdBetweenRooms;
      this.travelArm = participatesInTravelHold
        ? { arm, since: Date.now(), to: room, planned_legs: plannedLegs }
        : null;
      // WHICH SIDE, IF THIS ROOM HAS SIDES AND WE ALREADY LEARNED WHICH ONE WE WANT.
      //
      // `crossSameRoomIsland` knows the quarry's square, but it can only be planned from
      // INSIDE the room. A character part-way through the bridge — standing in the via
      // room, which is exactly where these wedge — falls back to plain travel, and plain
      // travel picks the nearest door. In Castle Victoria that is a coin flip between two
      // islands, and losing it means arriving to look at six battered skeletons it cannot
      // path to. So the side survives the trip out and is handed back on the way in.
      const liveSide = this.wantSide && Number(this.wantSide.room) === Number(room)
        && (Date.now() - this.wantSide.at) < 300_000 ? this.wantSide.target : null;
      // AND FAILING THAT, WHERE THE PREY WAS LAST SEEN STANDING IN THAT ROOM.
      //
      // `wantSide` only exists if this keeper planned a bridge in this process, so a
      // RESTART loses it — and a character stranded in the via room after a restart is
      // exactly the case that spent a night picking doors blind. The book is written from
      // inside the room, whenever the quarry is in sight, and read here on the way back.
      // A remembered square that today's geometry cannot use degrades to no opinion:
      // `doorsLandingNear` returns null and the ordinary door ordering stands.
      let remembered = null;
      if (!liveSide && this.policy?.hunt) {
        try { remembered = preySideFor(room, this.policy.hunt); }
        catch { remembered = null; }
      }
      const wantSide = liveSide ?? (remembered ? { col: remembered.col, row: remembered.row } : null);
      if (wantSide) this.note('heading for the side of the room the quarry is on', {
        room, at: wantSide, hunting: this.policy?.hunt ?? null,
        from: liveSide ? 'a bridge this keeper planned' : 'the prey-side book',
        why: 'this room has disconnected halves served by different doors, so which door ' +
             'we take decides whether the prey is reachable when we arrive',
      });
      outcome = await this.s.travel(room, {
        ...sessionOpts,
        // The same order one layer down: same issuer, same room, so it is inherited, not re-issued.
        origin: journeyOrigin,
        movementGeneration,
        ...(wantSide ? { arriveNear: wantSide } : {}),
        // A ROOM THAT IS WORKED RATHER THAN WALKED ends the walk on arrival and hands the body
        // to the keeper (passLeverPuzzle). Only 2600 on the way to 2601 today.
        handOffAt: (here, to) => puzzleBlocksJourney(here, to),
        onHop: async (at) => {
          legs++;
          if (detailed) {
            closeMap();
            const hp = this.s.client?.vitals?.()?.health?.value ?? null;
            map = { room: at.room?.num ?? null, name: at.room?.name ?? null,
              started_at: Date.now(), damage_at_start: this.hitDamageTotal(), health_start: hp };
          }
          this.recordFrame(`travelling — ${at.hops_done + 1} room(s) in, ${at.remaining} to go`);
          if (holdBetweenRooms)
            await this.travelHold(at, arm).catch(e => this.note('travel hold failed', { why: e.message }));
          if (onHop) await onHop(at);
        },
        // The shared shelter policy records route and track rests at the rest itself.
        // Do not count Session's onTrackRest summary again here.
      });
      if (outcome?.handed_off) {
        const handed = this.leverPuzzleHandoff(outcome.room?.num ?? this.s.world?.room?.num, room);
        if (handed) outcome = { ...outcome, ...handed, hops: outcome.hops, log: outcome.log };
      }
    } finally {
      // ONLY IF IT IS STILL THE VERY HOLD WE TOOK. Reviving somebody else's is how a
      // character ends up driven by two things at once — the same rule travelJob follows.
      if (holdTimer) clearInterval(holdTimer);
      if (ourTravelHold && this.inert === ourTravelHold) {
        try { this.revive('journey finished'); }
        catch { /* the body is handed back on the next pass regardless */ }
      }
      if (detailed) closeMap();
      this.recordFrame('arrived');
      const v1 = this.s.client?.vitals?.()?.health;
      // THESE COUNTERS BELONG TO THIS JOURNEY, BUT THE KEEPER FIELDS DO NOT. They are
      // cleared below so the next journey starts clean. Snapshot them first and attach the
      // immutable value to the returned outcome, which is the only record travelJob can
      // use after this finally has run. Without this, arrival broadcasts read tally.rests
      // instead and report zero while the travel hook may have sheltered several times.
      const journeyMetrics = travelJourneyMetrics({
        shelterStops: this.travelSafeStops, heldMs: this.travelShelterHeldMs,
        hopWallStops: this.travelHopWallStops,
        sanctuaryStops: this.travelSanctuaryStops,
        routeStops: this.travelRouteStops,
        trackStops: this.travelTrackStops,
      });
      outcome = withTravelJourneyMetrics(outcome, {
        shelterStops: journeyMetrics.shelter_stops, heldMs: journeyMetrics.held_ms,
        hopWallStops: journeyMetrics.hop_wall_stops,
        sanctuaryStops: journeyMetrics.sanctuary_stops,
        routeStops: journeyMetrics.route_stops,
        trackStops: journeyMetrics.track_stops,
      });
      // ONE ROW PER JOURNEY — the denominator. Deaths per journey is the measurement, and
      // without the journeys written down there is nothing to divide by.
      //
      // Damage is recorded too and is NOT the outcome. The hypothesis players state is
      // that fighting from a wall means you take MORE damage and die LESS — so a fix that
      // works is expected to look worse on damage, and judging it on damage would reject
      // exactly the intervention worth having. It is here as a mechanism check: if the
      // treatment arm is not taking more damage, the holds are not doing anything.
      this.ledgerEvent(travelKind === 'travel' ? 'travel_journey' : 'zone_change', {
        ...(travelKind === 'travel' && holdBetweenRooms ? { arm } : {}),
        to: room, legs, planned_legs: plannedLegs,
        // WHERE IT STARTED AND WHERE IT ACTUALLY STOPPED.
        //
        // `to` alone cannot answer the question the operator asks of this ledger — "did it go
        // to the wrong place" — because a row that says only `to: 953` looks identical whether
        // the character is standing in the Duke's hall or two rooms short of it in the
        // Courtyard. `from` makes a ROUTE out of a destination, so survivors and casualties on
        // the same road can be compared; `ended_in` is the other half, and "asked for 953,
        // ended in 950" is the whole hypothesis in two fields.
        //
        // `arrived` and `reason` were on the opt-in detailEvent below and not here, so the
        // always-on row could not say whether the journey worked. A denominator you cannot
        // split by outcome is a count of attempts.
        from: startedIn ?? null,
        ended_in: Number(this.s?.world?.room?.num ?? NaN) || null,
        arrived: outcome?.arrived ?? false,
        reason: outcome?.reason ?? null,
        // WHICH STEP OF WHICH CROSSING REFUSED, not only that the exits ran out. The travel
        // result has carried `refusals` (each candidate's stand_on, stage and reason) since the
        // exhausted-exit work, and only the caller ever saw it: on 2026-10-04 Camilla failed
        // 48 -> 714 thirteen times in two minutes standing ON the corrected stage, and every row
        // here said `route_progressing_exits_exhausted` and nothing else. Failed journeys only,
        // compacted, and capped so one stuck room cannot bloat the ledger.
        ...(!(outcome?.arrived) && Array.isArray(outcome?.refusals) && outcome.refusals.length
          ? { refusals: compactRefusals(outcome.refusals) } : {}),
        // A THIRD OUTCOME: the road ended at a room the keeper works rather than walks (the
        // lever puzzle in 2600). Not a failure, and a reader splitting by `arrived` alone would
        // file it as one — so it says so. Absent on every other row.
        ...(outcome?.handed_off ? { handed_off: true, puzzle: outcome.puzzle ?? null } : {}),
        // WHO CANCELLED IT, when that is what ended the journey. `reason` says "movement
        // cancelled by a newer command", which names the mechanism and not the caller — and
        // for one night that was the entire account the fleet could give of 46 of 46 failed
        // journeys. Session.cancelMovement has always recorded a `why`; this carries it onto
        // the row so the question is a COLUMN rather than an investigation.
        //
        // ONLY A CANCEL DURING THIS JOURNEY. This used to carry whatever the last cancel had been,
        // so an arrived journey could name the clear-the-way cancel issued before it set out.
        cancelled_by: (this.s?.lastMovementCancel?.at ?? 0) >= startedAt
          ? this.s.lastMovementCancel.why ?? null : null,
        cancelled_ms_ago: (this.s?.lastMovementCancel?.at ?? 0) >= startedAt
          ? Date.now() - this.s.lastMovementCancel.at : null,
        // AND WHO, ON BOTH SIDES (m59-move-origin.mjs): `origin`/`ordered_by` is this journey's
        // issuer, `cancelled_by_origin` the canceller's. The 2026-10-04 buy-spell walk to 714 was
        // cancelled by `keeper:shelter` three times and the row could only say so in prose.
        ...journeyProvenance({ origin: journeyOrigin, cancel: this.s?.lastMovementCancel,
                               startedAt }),
        stumbles: Number.isFinite(outcome?.stumbles) ? outcome.stumbles : null,
        ms: Date.now() - startedAt,
        // The A/B field retains its old budget-clock meaning. The inclusive recovery time
        // is separate so observing route/track stops cannot change the experiment's units.
        held_ms: this.travelHeldMs ?? 0,
        shelter_held_ms: journeyMetrics.held_ms,
        shelter_stops: journeyMetrics.shelter_stops,
        hop_wall_stops: journeyMetrics.hop_wall_stops,
        sanctuary_stops: journeyMetrics.sanctuary_stops,
        route_stops: journeyMetrics.route_stops,
        track_stops: journeyMetrics.track_stops,
        hp_start: hpStart, hp_end: v1?.value ?? null, hp_max: hpMax ?? v1?.max ?? null,
        // Whether this journey ended in a death is not knowable here — the keeper is still
        // alive to write this line. It is joined afterwards, from the postmortem's own
        // `travel_arm`, which is why that field exists.
      });
      // AND A MOVEMENT INCIDENT, when it did not arrive: one self-contained chunk a script can
      // replay (m59-movement-incidents.mjs). A hand-off to a worked room is not a failure.
      if (!outcome?.arrived && !outcome?.handed_off)
        journeyIncident(this, { outcome, to: room, startedIn, startedAt, startAt,
                                     origin: journeyOrigin, route: initialRoute, legs, hpStart, hpMax });
      if (travelKind === 'travel') {
        this.detailEvent('travel', 'trip', {
          to: room, arrived: outcome?.arrived ?? false, reason: outcome?.reason ?? null,
          duration_ms: Date.now() - startedAt, legs, planned_legs: plannedLegs,
          damage: Math.max(0, this.hitDamageTotal() - journeyDamageStart),
          safe_spot_stops: journeyMetrics.shelter_stops, safe_spot_ms: journeyMetrics.held_ms,
          health_start: hpStart, health_end: v1?.value ?? null,
          health_max: hpMax ?? v1?.max ?? null, maps,
        });
      }
      this.travelArm = null;
      this.travelHeldMs = 0;
      this.travelShelterHeldMs = 0;
      this.travelSafeStops = 0;
      this.travelHopWallStops = 0;
      this.travelSanctuaryStops = 0;
      this.travelRouteStops = 0;
      this.travelTrackStops = 0;
    }
    this.trafficJam=noteTrafficJam(this.trafficJam,{outcome,place:this.wedgePlace?.(),to:room,owner:trafficOwner});
    return outcome;
  }
  // @end 1
}
