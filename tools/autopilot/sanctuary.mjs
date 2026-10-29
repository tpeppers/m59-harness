// SANCTUARY: inns and resting squares, settling, leaving for mana, hibernating.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 9 methods: sanctuary, readyToLeaveSanctuary, restingSquare, settle, leaveForManaWhileUnarmed,
//   nearestSanctuary, townTripIfCornered, makeWay, hibernate
import { JUNGLE_SANCTUARIES } from '../m59-kocatan-gate.mjs';
import { OF, blocksMovement } from '../m59-parse.mjs';
import { nearestSafeSpot } from '../m59-safespots.mjs';
import * as skills from '../m59-skills.mjs';
import { loadSpawns } from '../m59-spawns.mjs';
import { recordTactic } from '../m59-tactics.mjs';
import { thoroughfareYield } from '../m59-thoroughfare.mjs';
import { CITY_INNS } from '../m59-underworld.mjs';
import { RECOVER_MAX_MS, REST_VIGOR_CAP, SPAWN_FILE, pct, preferredQuietRetreat, vigorOf, vigorPct } from '../m59-autopilot.mjs';

export class SanctuaryPart {
  // @part 1

  // ------------------------------------------------------------- resting up
  //
  // A room nothing is generated in. The spawn table answers this directly and better
  // than the name does: an inn is safe, but so is a bank, a shop and a stretch of
  // road, and "tavern" is not a flag on anything.
  sanctuary(room = this.s.world?.room) {
    if (!room) return false;
    const here = loadSpawns(SPAWN_FILE)?.rooms?.[room.num] || [];
    return !here.some(x => x.huntable);
  }

  // WHAT HAS TO BE TRUE BEFORE A CHARACTER WALKS OUT OF SAFETY.
  //
  // THIS IS THE COMMONEST DEATH IN THE FLEET AND IT IS NOT CLOSE. Of the last fifty
  // deaths, twenty-three happened with the keeper mid-travel and blind; of those,
  // SEVENTEEN WERE OUTBOUND TO A HUNTING GROUND and only four were escapes. Eleven of
  // them set off on the line "this room cannot produce our prey — leaving now". The
  // shape is always the same: a character standing perfectly safely in an inn, which the
  // keeper marches to room 586 or 562 because an inn spawns nothing, and which arrives
  // hurt, unarmed, or both, into eight-plus monsters.
  //
  // Neither departure branch asked anything about the character before setting off. They
  // asked about the ROOM — does this room make what we hunt — which is a fine question
  // and the wrong one to leave on.
  //
  // Three conditions, and each one has a body count:
  //
  //   ARMED, ON EVIDENCE. armedForSure() rather than armed(), because `known` is false
  //   for the first pass after a login and a resume logs in twenty-one characters at
  //   once. See armedForSure for why the optimistic answer is right everywhere else and
  //   catastrophic here.
  //
  //   WHOLE. Health, mana AND vigor — the same bar recovered() uses, for the same
  //   reasons, and mana is in it because `create weapon` costs 15 and a character that
  //   leaves at ten cannot arm itself anywhere it is going.
  //
  //   AND A DEADLINE ON BOTH, because a rule that can never be satisfied is a character
  //   retired into an inn, and this fleet has retired characters that way before. After
  //   RECOVER_MAX_MS it goes anyway and says which condition it gave up on — a stall a
  //   human can read beats a character quietly parked for the rest of the session.
  //
  // When it says no it does not merely refuse: it SITS THE CHARACTER DOWN IN A CORNER
  // and rests, which is the thing that makes the answer become yes. The caller's only
  // job is to stop.
  async readyToLeaveSanctuary(going_to = null) {
    // Only ever a gate on leaving somewhere SAFE. A character standing in a monster room
    // must never be held there by this — that would be the same bug pointing the other
    // way, and it is the worse direction.
    if (!this.sanctuary()) return true;

    const v = this.s.client?.vitals?.();
    const hp = pct(v?.health), mp = pct(v?.mana), vig = vigorPct(v);
    const armed = this.armedForSure();

    // UNKNOWN VITALS ARE NOT A REASON TO STAY, WHEN THERE IS SOMEWHERE TO BE.
    //
    // This is the case at the top of m59-sanctuary-test.mjs, and it has been RED — the
    // behaviour the file was written to protect was not in the code. JayB and Lee sat in
    // room 1016 with `assignedRoom: 586` and null vitals and never came out.
    //
    // WHY IT READS AS EMPTY. A resume logs twenty-one characters in at once and the bars
    // take several seconds to arrive, so `pct(null)` is the ORDINARY state after a restart
    // rather than a rare one. `whole` below defaults health to 0 on a null — deliberately,
    // because a character with nowhere to be should wait for real numbers — and the effect
    // is that a keeper that has just come up cannot leave anywhere it happens to be safe.
    // Given how often this fleet restarts, "just after a restart" is a lot of the time.
    //
    // AND THE REFUSAL COULD NOT SAY WHY, which is how it survived. `whole` defaults health
    // to 0 while `blocked` below defaults it to 1, so a blind keeper was held with an EMPTY
    // reason list: no weapon complaint, no health complaint, nothing. Both halves are fixed
    // — this rung lets it go, and `blocked` now names an unknown bar when it holds.
    //
    // `armed()` RATHER THAN `armedForSure()`, and the difference is the whole point. After
    // a restart the equipment list is unknown too, and `armedForSure` answers false to no
    // evidence — so requiring it would re-break exactly this case for exactly this reason.
    // `armed()` is the optimistic twin: it refuses only when the list is KNOWN and holds no
    // weapon, which is a real reason to stay in a safe room.
    const blind = hp === null;
    const assigned = this.policy.assignedRoom;
    const here = this.s.world?.room?.num ?? null;
    const elsewhereToBe = assigned != null && here != null
      && Number(assigned) !== Number(here);
    if (blind && elsewhereToBe && this.armed()) {
      this.sanctuaryHoldSince = null;
      this.sanctuaryHoldNoted = false;
      this.note('leaving on unknown vitals — there is somewhere else to be', {
        going_to, assigned_room: assigned, here,
        why: 'the bars have not arrived yet, which is the ordinary state for several ' +
             'seconds after a resume. A character with an assignment it is not standing ' +
             'in has a reason to move, and waiting for numbers that may be minutes away ' +
             'is how a keeper gets retired into a room by accident',
      });
      return true;
    }

    // A null reading is "no such bar", not "empty" — blocking on one would be the
    // retirement this is careful about everywhere else. Health is the exception and
    // defaults to 0: with nowhere else to be, waiting for a real number is right, and
    // the rung above is what keeps that from becoming permanent.
    const whole = (hp ?? 0) >= 0.95 && (mp ?? 1) >= 0.95 && (vig ?? 1) >= REST_VIGOR_CAP;
    if (armed && whole) {
      this.sanctuaryHoldSince = null;
      this.sanctuaryHoldNoted = false;
      return true;
    }

    const blocked = [
      !armed ? 'no weapon in the use list' : null,
      // NAMED, because a hold with an empty reason list is unarguable. This is the half
      // that let the bug above go unnoticed.
      blind ? 'vitals have not arrived yet' : null,
      (hp ?? 1) < 0.95 ? 'health' : null,
      (mp ?? 1) < 0.95 ? 'mana' : null,
      (vig ?? 1) < this.restVigorCeiling() ? 'vigor' : null,
    ].filter(Boolean);

    this.sanctuaryHoldSince ??= Date.now();
    const held = Date.now() - this.sanctuaryHoldSince;
    if (held > RECOVER_MAX_MS) {
      this.note('going out anyway — waited long enough', {
        waited_s: Math.round(held / 1000), still_short: blocked, going_to,
        health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null, vigor: vigorOf(v),
        why: 'a condition that cannot be met is a character retired into an inn by ' +
             'accident. Twelve minutes is far longer than any real recovery takes, so ' +
             'this is a stall worth seeing rather than a wait worth continuing' });
      this.sanctuaryHoldSince = null;
      this.sanctuaryHoldNoted = false;
      return true;
    }

    // Once per hold, not once per pass: the pass is about a second long and this branch
    // can hold a character for minutes.
    if (!this.sanctuaryHoldNoted) {
      this.sanctuaryHoldNoted = true;
      this.note('not leaving safety yet', {
        room: this.s.world?.room?.name ?? null, going_to, short_of: blocked,
        health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null, vigor: vigorOf(v),
        armed_for_sure: armed,
        why: 'seventeen of the last twenty-three travel deaths were outbound to a hunting ' +
             'ground, most of them straight out of an inn. Nothing in here can hurt us and ' +
             'nothing out there gets easier by arriving early' });
    }

    this.doing = 'recovering';
    // Sit in a corner and fill the bars. hibernate() settles first, which is what arms
    // the health timer — a character that walked in and stopped regenerates nothing.
    await this.hibernate('waiting to be whole and armed before going back out')
              .catch(() => false);
    // THEN ARM, because the resting is what pays for it: armSelf() wields from the pack
    // and falls back to conjuring, and the conjure is the case that was failing for want
    // of the 15 mana this branch has just been sitting for.
    if (!this.armedForSure()) await this.armSelf().catch(() => false);
    // PROGRESS, NOT A STALL. The supervisor restarts keepers that report no progress, and
    // it was doing exactly that to characters sitting for mana — `restarted Animal:
    // {"why":"unarmed — 10 mana, needs 15 to make one"}` — which threw away the sit and
    // started the climb again. Recovering on purpose is the keeper working.
    this.progress('resting in safety until whole and armed');
    return false;
  }

  // A CLEAR PATCH OF FLOOR TO SIT ON.
  //
  // Bots do not merely share an inn, they stack: they all arrive by the same route
  // and stop on the same square, so four of them end up on the identical coordinate.
  // That is not cosmetic. Every character is ATTACKABLE, so a pile of friendly bots
  // reads to each of them as a crowd of things that can kill it — which is exactly
  // how one of them spent half an hour panic-logging-off at four health next to three
  // of its own fleet.
  //
  // Sitting somewhere with space around it fixes that at the source, and it is free:
  // walking there is itself the step that arms HealthTimer, so the character that
  // moves aside is also the only one actually regenerating.
  restingSquare({ within = 12, clear = 3 } = {}) {
    const s = this.s, c = s.client;
    const geo = s.world?.geometry, me = c?.self;
    if (!geo || !me) return null;

    // A SAFE WALL FIRST. SITTING SOMEWHERE THINGS CAN REACH YOU IS AN ORDER, NOT A DEFAULT.
    //
    // Everything below this block picks a CORNER — two of four orthogonal neighbours
    // blocked, scored on the coarse grid — and a corner is not a safe wall. The distinction
    // is the whole argument of m59-safespots.mjs, in its own words: "a flat wall blocks
    // three of eight neighbours and scores as a 62% improvement, while leaving twenty of
    // the twenty-eight squares that can really reach you completely open." Melee reach is a
    // DISC OF RADIUS 3 filtered by line of sight, not the ring of squares you are touching.
    //
    // So the old default sat characters somewhere that merely LOOKED sheltered, and the
    // journal recorded `seat: 'corner'` while `in_safe_spot` was false. That is exactly
    // how Waldorf died four times on 2026-09-08 — every one `strategy: fieldrest`, three
    // with `in_safe_spot: false`, at 5-10 health of 51 with six hostiles in the room, the
    // survival ladder quiet because resting presupposes you walked somewhere unhittable
    // first. The presupposition was never enforced. This enforces it.
    //
    // Operator's rule, 2026-09-10: safe-wall behaviour is ALWAYS the default, and stopping
    // somewhere that is not a safe wall has to be something you deliberately asked for.
    // `restAnywhere` is that order, it is per-character, and it defaults to false — so the
    // unsafe case is reachable, named, and never arrived at by accident.
    // `this.policy?` — restingSquare is callable on a bare instance with no policy (that is
    // how m59-rest-test drives it), and a hard `this.policy.` threw there. Absent policy
    // means the DEFAULT, and the default is to look for a wall: an unreadable setting must
    // never be the thing that decides to sit in the open.
    if (this.policy?.restAnywhere !== true) {
      try {
        const wall = nearestSafeSpot(geo, me, {
          within,
          room: s.world?.room?.num ?? null,
          // Squares this session already failed to WALK to. A different fact from a square
          // that failed to hold, and the only history consulted here — the safe-spot book
          // is retired and its failure column is inverted (see m59-safewall.mjs).
          unreachable: this.unreachableSpots ?? null,
          // Never a seat in a passage: see m59-thoroughfare.mjs (East Jasper's stair tunnel).
          avoidChokes: true,
        });
        if (wall && Number.isInteger(wall.col) && Number.isInteger(wall.row)) {
          const steps = Math.max(Math.abs(wall.col - me.col), Math.abs(wall.row - me.row));
          return { col: wall.col, row: wall.row, steps,
                   clearance: null, value: Infinity, seat: 'a safe wall', wall: true,
                   can_reach_you: wall.can_reach_you ?? null,
                   free_shots: wall.free_shots ?? null,
                   refused_approaches: wall.refused_approaches ?? null,
                   offered_approaches: wall.offered_approaches ?? null };
        }
      } catch { /* geometry could not answer; the corner heuristic is still better than
                   sitting where we stand, so fall through rather than refusing to rest */ }
    }
    // BODIES ONLY, by the server's MOVEON bits, the same predicate the mover enforces. A groundworm's "Loose soil"
    // (GroundWormTrailClump, a PassiveObject: flags 64, MOVEON_YES, wrmtrail.kod), loot and slain bodies are walked
    // over in the client, and The Badlands (45) has twenty soil clumps at a time: counted here, every corner near a
    // worm read as occupied.
    const others = [...c.room.objects.values()].filter(o => o.id !== c.selfId && blocksMovement(o.flags ?? 0));
    const gap = (col, row) => others.length
      ? Math.min(...others.map(o => Math.hypot(o.col - col, o.row - row))) : 99;
    // SIT IN A CORNER, AND IN THE EMPTIEST ONE THERE IS.
    //
    // It is what a person does — you take the corner table, not the middle of the floor —
    // and here it is also the only free tactical improvement available while sitting. A
    // corner has two of its four approaches walled off, so anything that wants to reach
    // the character has half as many squares to do it from; the same asymmetry the safe
    // spot book is built on, bought for nothing because we are sitting still anyway.
    //
    // walkable() reads out-of-bounds as false, so the edge of the grid counts as wall,
    // which is right: the far side of a room boundary is not floor you can be attacked
    // across.
    //
    // A PERPENDICULAR PAIR IS A CORNER; TWO OPPOSITE WALLS ARE A CORRIDOR. Scoring
    // "blocked neighbours" alone would rank the middle of a passage equal to a corner and
    // it is not — a corridor is open at both ends and things come down it.
    const corner = (col, row) => {
      const n = !geo.walkable(row - 1, col), s2 = !geo.walkable(row + 1, col);
      const w = !geo.walkable(row, col - 1), e = !geo.walkable(row, col + 1);
      if ((n && e) || (e && s2) || (s2 && w) || (w && n)) return 2;   // a corner
      if (n || s2 || w || e) return 1;                                // a wall at the back
      return 0;                                                       // open floor
    };
    // TWO ANSWERS, BECAUSE THE GRID LIES ABOUT INNS.
    //
    // The movement grid is one byte per square, and a room full of furniture and
    // doorways narrower than a square comes out of it disconnected: in the Limping
    // Toad, 76 squares are both free and clear of everyone, and the grid says NOT ONE
    // of them can be walked to from the middle of the floor. It is wrong — people sit
    // at those tables — but it is wrong in the direction that makes a keeper conclude
    // there is nowhere to go and stand in the doorway for ever.
    //
    // The fine BSP has more resolution than that grid. So keep the best square the
    // grid endorses AND the best one it merely dislikes, and let settle() walk to the
    // second with local BSP collision. The server accepts player coordinates and must
    // never be treated as the judge of a step.
    let best = null, byFine = null;
    for (let row = 2; row < geo.rows; row++) {
      for (let col = 2; col < geo.cols; col++) {
        if (!geo.walkable(row, col)) continue;
        const d = Math.max(Math.abs(col - me.col), Math.abs(row - me.row));
        if (d > within) continue;
        const space = gap(col, row);
        if (space < clear) continue;
        const p = s.world.reach(col, row);
        // Elbow room first, then closeness — but cap the value of space, because the
        // far corner of an inn is no safer than a clear table and costs the walk.
        //
        // The corner bonus is weighted to be worth about three squares of elbow room, so
        // it decides between two comparable squares without ever sending a character the
        // length of an inn for a corner it does not need. Space still counts inside that,
        // which is what "the open corner if there is one" means: an empty corner beats a
        // corner with somebody already sitting in it, and both beat the middle of the room.
        const nook = corner(col, row);
        const value = Math.min(space, 6) * 2 + nook * 3 - (p?.steps ?? d) * 0.3;
        // `wall: false` SAYS THIS IS NOT A SAFE WALL, and it is carried rather than inferred.
        // A corner is a coarse-grid shape; a safe wall is a fact about the melee disc and
        // line of sight. Callers that need to know which one they got — the journal, and the
        // rest ledger — must not have to re-derive it from the word "corner".
        const cand = { col, row, steps: p?.steps ?? d, clearance: +space.toFixed(1), value,
                       wall: false,
                       seat: nook === 2 ? 'corner' : nook === 1 ? 'against a wall' : 'open floor' };
        if (p?.reachable) { if (!best || value > best.value) best = cand; }
        else if (!byFine || value > byFine.value) byFine = { ...cand, viaFine: true };
      }
    }
    return best || byFine;
  }

  // Take a seat, once, on arriving somewhere safe. Doing it on ENTRY rather than when
  // the resting eventually starts is the whole point: the walk is what sets
  // PFLAG_MOVED_SINCE_ENTRY, and until that is set the character recovers no health at
  // all however long it sits. Arriving and stopping is the failure; arriving and
  // crossing the room is the fix.
  async settle(why) {
    const room = this.s.world?.room;
    if (!room) return { settled: false };
    if (this.settledIn === room.num) return { settled: false, already: true };
    // A FAILED ATTEMPT IS NOT A SEAT. Marking the room settled up front meant the
    // first try was the only try — and the first try is exactly the one that fails,
    // because the pass right after a reconnect can run before room contents have come
    // back, so we do not yet know where we are standing and every square looks
    // unreachable. Isolde spent that pass concluding there was nowhere to sit in a
    // sixteen-by-sixteen room with a hundred and thirty-five free squares in it.
    const tries = (this.settleTries || 0);
    const spot = this.restingSquare();
    if (!spot) {
      this.settleTries = tries + 1;
      // Say it once, and once more when giving up; not every eight seconds in between.
      if (tries === 0 || tries === 2)
        this.note('nowhere clear to rest here', {
          room: room.name, why, attempt: tries + 1,
          know_where_we_are: !!this.s.client?.self,
          note: tries === 2
            ? 'giving up on finding a clear corner in this room'
            : 'resting anyway, but crowded — health regeneration still needs us to have moved' });
      if (tries >= 2) this.settledIn = room.num;     // stop trying, but only after trying
      return { settled: false };
    }
    if (spot.steps === 0) {
      this.settledIn = room.num;
      this.settleTries = 0;
      return { settled: true, already: true, spot };
    }
    this.doing = 'recovering';
    // Fine movement when the grid refuses the route, because in an inn the grid is
    // usually the thing that is wrong. FINENESS is 64 units to the square and the
    // centre is the half — the same arithmetic moveToSquare does.
    const w = spot.viaFine
      ? await this.s.walkFine(spot.col * 64 + 32, spot.row * 64 + 32,
                              { maxSteps: 24, stride: 48, arriveWithin: 48 })
                    .then(r => ({ arrived: r.arrived, reason: r.reason, fine: true }))
                    .catch(e => ({ arrived: false, reason: e.message, fine: true }))
      : await this.s.walkTo(spot.col, spot.row, { maxSteps: Math.max(20, spot.steps + 8) })
                    .catch(e => ({ arrived: false, reason: e.message }));
    this.movedAt = Date.now();
    const terminal = this.terminalMovement(w, 'settling movement', { room: room.name });
    if (terminal) return { settled: false, ...terminal, spot };
    if (w.arrived) { this.settledIn = room.num; this.settleTries = 0; }
    else this.settleTries = tries + 1;
    this.note(w.arrived ? 'found a quiet corner to rest in' : 'could not reach the quiet corner', {
      room: room.name, why, to: { col: spot.col, row: spot.row },
      seat: spot.seat ?? null,
      nearest_other_character: spot.clearance, steps: spot.steps, reason: w.reason,
      routed: w.fine ? 'in fine coordinates — the square grid called this room disconnected'
                     : 'through the movement grid',
      because: 'characters stack on the square they arrive at, and every character is attackable — ' +
               'a pile of friendly bots reads as a crowd of threats to every one of them. Walking ' +
               'clear also arms the health timer, which sitting still never does.' });
    return { settled: !!w.arrived, spot };
  }

  // EXTRACTED SO IT CAN BE TESTED. It lives inside `passArm`, which is far too large to
  // rig in a unit test, and the defect it fixes was a silent early return — exactly the
  // class that only a direct test catches. Returns true when the character is now
  // somewhere safe and the pass should end.
  // So walk out first — a character with nothing in its hands has no business in a
  // monster room, and the walk is the cheapest of the four routes because it needs no
  // money, no donor and no meeting.
  //
  // AND IT ASKS `nearestSanctuary` DIRECTLY, NOT `townTripIfCornered`, BECAUSE THAT
  // FUNCTION'S FIRST GATE CANNOT BE SATISFIED FROM HERE. Its line 3 is
  // `if ((this.fledInARow || 0) <= 2) return false;` and `fledInARow` is incremented in
  // exactly ONE place in this file — `gotOut()` in `passFleeAndRest`, after a successful
  // `leaveViaAny`. It counts successful FLEES. Being unarmed is not fleeing and never
  // touches that counter, so this caller asked a question whose precondition it could
  // never meet, and was refused SILENTLY, every pass, for ever.
  //
  // Measured on prod 2026-09-19: Beaker 1,850 consecutive repeats of the note below and
  // Animal 1,100, both bare-handed with a spider ONE SQUARE away, `went_to_town: false`
  // on every one of them. The flag was the only output and it could not say why.
  //
  // The gate is not widened, because it is load-bearing for the original caller: three
  // flees in a row IS the escalation ladder, and `townTripIfCornered` resets the counter
  // on success. An unarmed character has no business incrementing a flee counter to buy
  // itself a sit-down. It wants the other half of that function — "where is the nearest
  // place I can sit down safely" — which is already extracted, already prefers a real
  // inn over a quiet field (`CITY_INNS` first, and see the note on the spawn index), and
  // is already what the post-death recovery calls.
  //
  // AND THE NOTE NAMES WHICH OF THE THREE OUTCOMES HAPPENED. `went_to_town: false` meant
  // "refused by a gate", "nothing within three hops" and "walked and could not get
  // there" indistinguishably, which is what made 1,850 identical lines say nothing. A
  // failure that cannot name itself gets rediscovered from scratch.
  async leaveForManaWhileUnarmed() {
    // A CHARACTER TRAINING UNARMED ON ITS OWN GROUND IS NOT LOOKING FOR A WEAPON.
    //
    // `makeWeapon` already declines for exactly this reason and with exactly this predicate —
    // "training unarmed on its own ground: the bout disarms whatever this makes" — and the two
    // must agree, or the pass refuses to conjure and then walks off to find the mana for a
    // conjure it has already refused.
    //
    // Measured on prod 2026-09-19, minutes after the refuge fix shipped: Beaker at 25 mana and
    // Animal at 23, both in room 27 with `trainingStyle: unarmed`, both noting "leaving to
    // regain mana" on every pass. `create weapon` needs FIFTEEN. They had it and to spare.
    // Being bare-handed was the ORDER, not a shortfall, and the whole premise of this rung —
    // "this is how a character with no weapon, no money and no donor gets armed again" — is
    // false for them. Room 27 is where they are supposed to be, punching things.
    if (this.bareHandedByTraining()) return false;
    const searchedRecently = this.noUnarmedRefugeUntil && Date.now() < this.noUnarmedRefugeUntil;
    const best = searchedRecently ? null : this.nearestSanctuary({ maxHops: 3 });
    let went = false, outcome, toRoom = best?.room ?? null;
    if (searchedRecently) {
      // SAY IT ONCE PER BACKOFF, NOT ONCE PER PASS. The first version of this noted every
      // pass while rate-limited, which reproduced the 1,850-repeat spam it was written to
      // stop — with a better label on it, which is not the same as fixing it. Measured on
      // prod within ten minutes of shipping.
      return false;
    } else if (!best) {
      // Keep looking eventually, but not every pass: the flood is the expensive part.
      this.noUnarmedRefugeUntil = Date.now() + 120_000;
      outcome = 'no_sanctuary_within_3_hops';
    } else {
      this.doing = 'travelling';
      const t = await this.recoveryTravel(best.room, { maxHops: 6 })
                          .catch(e => ({ arrived: false, reason: e.message }));
      if (t.arrived) { went = true; outcome = 'arrived'; }
      else {
        // BACK OFF ON A FAILED WALK TOO, NOT ONLY ON A FAILED SEARCH. `townTripIfCornered`
        // has a SECOND silent gate — `noTownUntil` — and bypassing the flee counter skips
        // that backoff as well. Without one here, a character that can see a refuge and
        // cannot reach it re-plans the identical walk every pass: a loop of failed walks,
        // which reads healthier on a board than a silent refusal and is worse in the room.
        // Shorter than the no-search backoff because a blocked route is likelier to clear
        // than an empty map is to fill.
        this.noUnarmedRefugeUntil = Date.now() + 60_000;
        outcome = 'travel_failed: ' + (t.reason || 'refused');
      }
    }
    this.note('unarmed and in a room that spawns — leaving to regain mana', {
      mana: this.s.client?.vitals?.()?.mana?.value ?? null,
      needs: 15, went_to_town: went, outcome,
      to_room: toRoom, hops: best?.hops ?? null, preferred: best?.preferred ?? null,
      why: 'create weapon needs 15 mana and mana barely moves while standing in a ' +
           'fight. Sitting somewhere nothing spawns is the only way this character ' +
           'gets armed again when it has no weapon, no money and no donor' });
    if (went) {
      this.progress('reached a refuge to regain mana while unarmed');
      await this.hibernate('unarmed, resting for the 15 mana a weapon costs')
                .catch(() => {});
      return true;
    }
    // A REFUSAL THAT MOVED NOTHING IS NOT PROGRESS. Reporting progress() here would hide
    // a permanently stuck body from every stall detector, which is the `retreat_to_inn`
    // mistake: five callers reported progress for a retreat that returned {arrived:false}
    // having moved nobody, and four characters died inside it.
    this.noProgress('unarmed, could not reach a refuge: ' + outcome);
    return false;
  }

  // GO TO TOWN WHEN THE WILDERNESS HAS STOPPED WORKING.
  //
  // Called after a successful escape. Two flees is a bad patch; a third says this
  // character cannot fight anywhere it can currently reach, and the next wilderness room
  // will be the same. See the note at the call site for how that state is manufactured.
  //
  // FED AND RESTED CHARACTERS ARE EXEMPT. Above 140 vigor with food in the pack, the
  // fleeing is tactical — a bad room, a bad crowd — and hauling it to town would throw
  // away a working session for nothing.
  // THE NEAREST ROOM NOTHING IS GENERATED IN, by hops.
  //
  // Sanctuary is the right test rather than a list of town names: an inn qualifies, so
  // does a bank, a shop and a stretch of road, and "tavern" is not a flag on anything.
  //
  // Extracted from townTripIfCornered because the post-death recovery asks the identical
  // question — where is the nearest place I can sit down safely — and a second copy of
  // this would be a second place for the hop limit to drift.
  // AN INN IS NOT IN THE SPAWN INDEX, WHICH IS WHY THIS NEVER SENT ANYBODY TO ONE.
  //
  // The candidate list was built from `Object.keys(spawns.rooms)` — every room the spawn
  // index KNOWS ABOUT — then filtered down to those with nothing huntable. A room that
  // generates nothing at all has no entry in that index, so every inn in the world was
  // invisible to it. What survived the filter was outdoor rooms that happen to carry only
  // non-huntable spawns, and those are neighbours of the wilderness rather than refuges.
  //
  // Measured: a character fled the Graveyard of Tos at 2 health and set off for the
  // Twisted Wood — which holds trolls at attack rating 750 — while Familiars, the Tos inn,
  // sat two rooms away and was never a candidate. The route to a distant "safe" room is
  // the part that kills, because a planned trip is not reconsidered and goes THROUGH
  // whatever is on the way.
  //
  // `CITY_INNS` is the answer and was already imported into this file. Inns are real
  // sanctuaries: nothing spawns, resting is safe, and the counters sell the bread that is
  // the only way past the vigor cap of 80 — which is the whole reason this function is
  // called. They are listed FIRST and win ties, so a refuge is preferred over a merely
  // quiet field at the same distance.
  nearestSanctuary({ maxHops = 3 } = {}) {
    const s = this.s;
    const here = s.world?.room?.num;

    // THE CONFINEMENT IS CHECKED HERE TOO, AND THAT IS THE POINT OF CHECKING IT TWICE.
    //
    // `retreatToSafety` was patched first and it was not enough: this is a SECOND chooser,
    // reached by the post-death recovery walk, and on 2026-08-19 it took Camilla out of
    // Castle Victoria through room 2 and on toward an inn ten legs away — through Ukgoth —
    // minutes after the first patch went in. A confinement enforced at one of two doors is
    // not a confinement, and the reason it reads as one is that both doors are survival
    // code and neither announces itself as travel.
    //
    // `allowed` is a predicate rather than a filter on the list, because `preferred` below
    // is returned before the list is ever built.
    const confine = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms : null;
    const allowed = confine?.length
      ? (n) => confine.map(Number).includes(Number(n))
      : () => true;

    // A deliberately named exception before the generic search. Outside Castle
    // Victoria has no spawn-index row at all (because it spawns nothing), so it cannot
    // emerge from `quiet` below. It is the right short retreat from either floor of the
    // castle, but not a true player-safe inn; the returned metadata preserves that fact.
    //
    // AND IT IS THE FIRST THING THE CONFINEMENT HAS TO REFUSE: `PREFERRED_QUIET_RETREATS`
    // maps BOTH 38 and 39 to room 2, so a character confined to the castle would be handed
    // the one adjacent room a player can kill it in, by the code that exists to save it.
    const preferred = preferredQuietRetreat(s.world, { maxHops });
    if (preferred && allowed(preferred.room)) return preferred;
    if (preferred)
      this.note('the preferred quiet retreat is outside the confinement', {
        room: preferred.room, name: preferred.name, confined_to: confine,
        why: 'monster-free is not player-safe, and this is the room the operator named' });
    const spawns = loadSpawns(SPAWN_FILE)?.rooms || {};
    // THE TRADING POST COUNTS AS AN INN (operator 2026-10-29: in the Avar Village it is "the safe room" for PvP escape,
    // selling and healing). It is a true sanctuary with bread for sale (tpost1.kod, kcmerch.kod), and it is one room past
    // the quiet clearing (2144) from the village, so it wins over a quiet room up to ONE hop nearer -- for these listed
    // sanctuaries only, so every city inn keeps the old strictly-closer rule.
    const inns = [...Object.values(CITY_INNS).map(x => x.inn), ...JUNGLE_SANCTUARIES]
      .filter(n => n !== here && allowed(n));
    const quiet = Object.keys(spawns)
      .filter(n => !(spawns[n] || []).some(x => x.huntable))
      .map(Number).filter(n => n !== here && !inns.includes(n) && allowed(n));
    let best = null;
    for (const room of [...inns, ...quiet]) {
      const r = s.world?.route?.(room);
      if (!r?.found) continue;
      const hops = r.hops.length;
      if (hops > maxHops) continue;           // further than that is its own expedition
      const isInn = inns.includes(room);
      const reachOver = JUNGLE_SANCTUARIES.includes(room) && best && !best.isInn && hops <= best.hops + 1;
      // Strictly closer wins; at equal distance the inn wins, because only an inn can
      // actually fix the thing that drove us out — food, and a safe place to eat it.
      if (!best || reachOver || hops < best.hops || (hops === best.hops && isInn && !best.isInn))
        best = { room, hops, isInn, preferred: false,
                 safety: isInn ? 'true sanctuary' : 'no huntable monsters spawn here',
                 playerSafe: isInn };
    }
    return best;
  }

  async townTripIfCornered() {
    const s = this.s, c = s.client;
    if ((this.fledInARow || 0) <= 2) return false;
    if (this.noTownUntil && Date.now() < this.noTownUntil) return false;   // searched recently
    const v = c?.vitals?.();
    const vig = v?.vigor?.value ?? 0;
    const fed = this.larder(c).length > 0;
    if (vig > 140 && fed) { this.fledInARow = 0; return false; }
    if (this.sanctuary()) { this.fledInARow = 0; return false; }   // already somewhere safe

    const best = this.nearestSanctuary({ maxHops: 3 });
    if (!best) {
      // DO NOT FORGET THAT WE ARE CORNERED. The first version reset the counter here,
      // so a character with no town within three hops re-decided from zero every third
      // flee and could never escalate — it just fled for ever, which is precisely what
      // this was written to stop. The count is kept and only the SEARCH is rate-limited.
      this.noTownUntil = Date.now() + 120_000;
      this.note('cornered but no town within reach', {
        fled_in_a_row: this.fledInARow, vigor: vig, has_food: fed,
        why: 'nothing unhuntable within three hops — carrying on in the wilderness ' +
             'because the alternative is a long walk through worse, but still counting ' +
             'the flees, because this is not a state to sit in' });
      return false;
    }
    this.doing = 'travelling';
    this.note(best.preferred ? 'going to a monster-free retreat' : 'going to town', {
      fled_in_a_row: this.fledInARow, vigor: vig, has_food: fed,
      to_room: best.room, hops: best.hops,
      safety: best.safety, player_safe: best.playerSafe,
      why: best.preferred
        ? 'fled more than twice; Outside Castle Victoria has no monster spawns and is ' +
          'close enough to rest in, though another player can still attack there'
        : 'fled more than twice with neither the vigor nor the food to fight — the ' +
          'wilderness cannot fix that, and a town can: resting is safe there and the ' +
          'counters sell bread, which is the only way past the resting cap of 80' });
    const t = await this.recoveryTravel(best.room, { maxHops: 6 }).catch(e => ({ arrived: false, reason: e.message }));
    this.fledInARow = 0;
    if (!t.arrived) { this.noProgress('could not reach town: ' + (t.reason || 'refused')); return false; }
    this.progress(best.preferred ? 'reached a monster-free retreat' : 'reached town to resupply');
    await this.hibernate(best.preferred
      ? 'resting outside Castle Victoria after being driven out'
      : 'resting in town after being driven out of the wilderness').catch(() => {});
    return true;
  }

  // Nothing to do and nowhere to be: sit down somewhere safe and get the bar back up.
  // Vigor is what a character actually leaves an inn with, and resting is the only way
  // to raise it without food — so idling on your feet is throwing away the one thing
  // idle time is good for.
  // MANA IS THE THIRD BAR AND IT IS THE ONE THAT MATTERS MOST AFTER A DEATH.
  //
  // This used to leave when health and vigor were back, which released characters at ten
  // mana — below the 15 `create weapon` needs, and with everything they owned lying on the
  // floor of the room that killed them, that spell is the whole plan. They walked out
  // bare-handed and died again. Mana genuinely does refill by sitting, unlike vigor, so
  // waiting for it is a wait that ends.
  // AN IDLE BODY IN A PASSAGE IS A WALL THAT NEVER MOVES. Every rung of the walker's body
  // ladder assumes the blocker is going somewhere; an idle character is not, and in a one-lane
  // tunnel there is no side to step round it. East Jasper, 2026-10-16: Scooter idle at r51c28
  // in the stair tunnel, Fozzie behind him travelling east for forty-five minutes. So an idle
  // keeper standing in a choke with another player within two squares walks out to open
  // ground, away from them (thoroughfareYield). Any player, not only ours: a stranger is
  // blocked by the same body. Rate-limited, so a refused walk is not retried every pass.
  async makeWay() {
    const s = this.s, c = s.client, geo = s.world?.geometry, me = c?.self;
    if (!geo || !me || !c?.room?.objects || this.inert) return false;
    if (this._madeWayAt && Date.now() - this._madeWayAt < 60_000) return false;
    const players = [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER) && Number.isFinite(o.row) && Number.isFinite(o.col));
    const plan = thoroughfareYield(geo, me, players);
    if (!plan) return false;
    this._madeWayAt = Date.now();
    const room = s.world?.room;
    const from = { row: me.row, col: me.col };
    this.doing = 'making way';
    const t0 = Date.now();
    const w = await s.walkTo(plan.to.col, plan.to.row, { maxSteps: plan.steps + 8 })
      .catch(e => ({ arrived: false, reason: e.message }));
    this.movedAt = Date.now();
    recordTactic({ character: this.who?.() ?? s.name ?? null, room: Number(room?.num ?? 0),
                   tactic: 'make_way', trigger: 'idle_in_choke', worked: !!w?.arrived,
                   ms: Date.now() - t0, hp_lost: 0, attempted: true,
                   note: `r${from.row}c${from.col} -> r${plan.to.row}c${plan.to.col} ` +
                         `(${plan.steps} step(s), ${plan.clear ? 'clear of' : 'only out of'} the passage) ` +
                         `for a player at r${plan.from_player.row}c${plan.from_player.col}` +
                         (w?.arrived ? '' : `; ${w?.reason ?? 'did not arrive'}`) });
    this.note(w?.arrived ? 'made way in a passage' : 'could not make way in a passage', {
      room: room?.name, from, to: plan.to, steps: plan.steps, reason: w?.reason ?? null,
      because: 'an idle body in a one-lane passage is a wall nobody can walk round' });
    return true;
  }

  async hibernate(why, { mana = 0.95 } = {}) {
    const s = this.s;
    if (!this.sanctuary()) return false;
    await this.settle(why);
    const v = s.client?.vitals?.();
    const vig = vigorPct(v), hp = pct(v?.health), mp = pct(v?.mana);
    // A missing mana reading means no bar to fill, not a shortfall to wait on.
    if ((vig ?? 1) >= REST_VIGOR_CAP && (hp ?? 1) >= 0.95 && (mp ?? 1) >= mana) return false;
    this.doing = 'recovering';
    const r = await skills.restUntil(s, {
      health: 0.98,
      // Resting stops at 80 of 200 — RestTimer will not take vigor past its threshold,
      // so asking for more is asking to sit until the timeout. Everything above this
      // has to be eaten, which is a supply problem and not something to wait out.
      vigor: this.restVigorCap(), mana,
      // Longer than the old 120s because mana is the slowest of the three and this is now
      // waiting on it. Still bounded, and the caller's own deadline bounds the repeats.
      maxSeconds: 180 });
    this.tally.rests++;
    this.note('resting up', {
      why, seconds: r.seconds, health: r.vitals?.health, vigor: r.vitals?.vigor,
      mana: r.vitals?.mana, reached: r.reached_target,
      note: 'vigor tops out around 80 of 200 on rest alone; past that it has to come from food' });
    this.progress('resting up between jobs');
    return true;
  }
  // @end 1
}
