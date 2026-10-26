// SENSES: is it safe here, what threatens us, is this wall a wall, are we armed, and the observe loop.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 16 methods: safety, threat, holdWorks, noteSpotRush, spotRushedAt, recordShelterStop, wallHere,
//   armed, armedForSure, recovered, observe, recordRestOutcome, operatorSurvivalStandDown,
//   releaseHold, creatureLevel, holdWorthwhile
import { publishCooperativePresence } from '../m59-cooperative-logoff.mjs';
import { publishFleetHealth } from '../m59-fleet-health.mjs';
import { OF } from '../m59-parse.mjs';
import { opensFightFromWall } from '../m59-policydiff.mjs';
import { recordRest } from '../m59-restwatch.mjs';
import { RoomGeometry } from '../m59-roo.mjs';
import { exposureAt } from '../m59-safespots.mjs';
import { safeWallVerdict, verdictFromRow } from '../m59-safewall.mjs';
import * as skills from '../m59-skills.mjs';
import { loadSpawns } from '../m59-spawns.mjs';
import { currentSurvivalDecision, finishSurvivalDecision } from '../m59-survival-decision.mjs';
import { CROWD_RADIUS, PROOF_MS, REACH, RECOVER_MAX_MS, SETTLE_GRACE_MS, SPAWN_FILE, pct, releaseSpot, vigorOf, vigorPct } from '../m59-autopilot.mjs';

export class SensesPart {
  // @part 1

  // The arithmetic moved to skills.safetyFor(client, policy) so the GOAP keeper's
  // watchdog reads the same withdraw line this one does. A move, not a fix.
  safety() { return skills.safetyFor(this.s.client, this.policy); }

  // ------------------------------------------------------------- safe spots
  //
  // THE MOST VALUABLE THING ON THE MAP IS A PLACE TO STAND.
  //
  // In a working safe spot NO MONSTER CAN HIT YOU UNLESS YOU SWING AT IT FIRST. That
  // one sentence reorganises the whole of the rest of this file, because every
  // expensive decision the keeper makes is a decision about damage it cannot stop:
  //
  //   fleeing      is a walk of several seconds during which it is still being hit,
  //                and it is a gamble that has killed characters here. From a spot
  //                there is nothing to flee: stop swinging and the damage stops.
  //   logging off  buys a minute of safety at the price of not healing, because the
  //                same flag gates the grace period and HealthTimer. From a spot we
  //                can spend the flag — turn, wake them, let them come, and heal to
  //                full anyway, because none of them can reach us.
  //   a swarm      is the commonest death in this fleet. Seven of the eight squares
  //                a swarm needs are wall.
  //
  // So the policy is: fight from a wall whenever the fight is worth fighting, and
  // treat "am I in a spot that is actually working?" as a question with an
  // observable answer rather than a hope. That is what observe() is for.

  // WHO IS ACTUALLY TRYING TO KILL US.
  //
  // The protocol never says, and there is no packet to ask with — the server keeps
  // targeting on the monster's side and sends us positions and damage. So this is two
  // estimates, and they answer different questions:
  //
  //   COULD reach us   things standing close enough to swing. A count, nothing more,
  //                    and it is what decides whether walking out of here is safe.
  //   IS reaching us   health going down while we sit still and do not swing. Ground
  //                    truth, and the only evidence that says whether where we are
  //                    standing works.
  //
  // `engaged` is the useful middle: things that have been camped next to us for more
  // than one pass are trying to hit us whether or not they are landing anything. That
  // is the number a reconnect resets to about one, and the reason breakOut() works.
  threat() {
    const c = this.s.client, me = c?.self;
    const empty = { adjacent: [], near: [], engaged: 0, landing: 0, names: [] };
    if (!c || !me) return empty;
    const hostiles = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));
    const d = o => Math.hypot(o.col - me.col, o.row - me.row);
    const adjacent = hostiles.filter(o => d(o) <= REACH);
    const camped = this.campedIds || new Set();
    return {
      adjacent,
      near: hostiles.filter(o => d(o) <= CROWD_RADIUS),
      engaged: adjacent.filter(o => camped.has(o.id)).length,
      landing: this.idleDamage || 0,
      names: [...new Set(hostiles.filter(o => d(o) <= CROWD_RADIUS).map(o => c.rsc.get(o.nameRsc)))],
    };
  }

  // Are we standing somewhere we have EVIDENCE about, or somewhere that merely looks
  // right? Nothing in this file may spend the safe-spot advantage on a guess: an
  // unproven spot is treated exactly like open floor, which is what it might be.
  // A SAFE WALL IS A SAFE WALL. THERE IS NO SUCH THING AS AN UNPROVEN ONE ANY MORE.
  //
  // This used to be `!!(this.hold && this.hold.proven)`, and `proven` meant a square that had
  // been stood on under attack without being hit. Everything that decides whether a character
  // may REST asks this, so an unproven wall was a wall you could stand on and not sit down at.
  //
  // The operator retired the distinction on 2026-08-28: **anything we identify as a safe wall
  // must be trusted with lives.** The reason is that the identification changed underneath the
  // flag. The wall search now works on the fine geometry rather than the coarse grid — the same
  // correction that ran through the mover today — so a "safe spot" is no longer the ordinary
  // floor it was when `proven` was introduced to compensate. Fifteen squares in the Cragged
  // Mountains against 1,778 real walls in the room is what the old book contained, and `proven`
  // was the patch over it.
  //
  // What it cost while it stood: resting is gated on this, taking a wall is not, so a character
  // could hold a perfectly good wall and still refuse to rest — for ever, because proving a wall
  // requires standing on it WHILE SOMETHING ATTACKS YOU, and a character that will not sit down
  // does not linger. Fozzie, prod, 2026-08-28: vigor 1 in a room with twenty-three giant rats,
  // full health falling to 37/48 over ten minutes, holding no wall and unable to earn one.
  //
  // The bar is now "am I on a wall", which is the question every caller thought it was asking.
  holdWorks() { return !!this.hold; }

  // ONE WALL-RUSH PER ROOM PER WINDOW, for the doomed rung in passFleeAndRest.
  //
  // That rung fires on EVERY pass while health is under `doomedInOpenBelow`, and the rush is a
  // walk rather than a test — so without a bound, a room with no reachable wall turns the
  // emergency into a treadmill that re-walks and re-fails while the freeze below it never gets
  // asked. The window is deliberately short: this is an emergency, and a room whose occupancy
  // changed may offer a wall it could not twenty seconds ago.
  //
  // Keyed on the ROOM, so walking into a new one is always allowed a fresh attempt. A rush that
  // SUCCEEDS needs no bound of its own — `currentRecoveryWall()` answers on the next pass and
  // the caller skips the rush entirely.
  noteSpotRush(room) { this.spotRush = { room: room ?? null, at: Date.now() }; }

  spotRushedAt(room) {
    const last = this.spotRush;
    if (!last || last.room !== (room ?? null)) return false;
    return Date.now() - last.at < (this.policy.doomedSpotRetryMs ?? 20_000);
  }

  // ONE SURVIVAL SHELTER STOP, COUNTED AGAINST THE ROOM IT WAS TAKEN IN.
  //
  // SELF-INITIALISING ON PURPOSE. The only other place `shelterStops` is created is inside
  // `passTravelling`, so a character that is standing and fighting rather than crossing has
  // never had the bucket made for it — and the doomed rush in `passFleeAndRest` is exactly a
  // stop taken by a character that is not travelling. Creating it here on the same rule the
  // travel guard uses means the counter means the same thing whichever rung filled it.
  //
  // The room is read AFTER the take, because the stop belongs to the room the wall is in: a
  // take that crosses an exit (`the first wall after the exit`) shelters us in the next room
  // and should start that room's budget rather than finish the old one's.
  //
  // `noted` is deliberately not preserved across the reset — it is the once-per-room latch on
  // the `walking on` line, and a new room is a new thing worth saying once.
  recordShelterStop() {
    const room = this.s?.world?.room?.num ?? null;
    if (this.shelterStops?.room !== room) this.shelterStops = { room, taken: 0 };
    this.shelterStops.taken = (this.shelterStops.taken ?? 0) + 1;
    return this.shelterStops.taken;
  }

  // DOES THE SQUARE I AM ON SHELTER ME — ASKED OF THE GEOMETRY, NEVER OF THE LEDGER.
  //
  // Operator, 2026-09-10: "do *not* consult the safe spot ledger regarding safe walls, use the
  // formula". This is that formula, and it is the same one `safeWalls` uses and the debug client
  // paints red: a square the coarse grid admits, from which no square inside a monster's reach
  // has coarse line of sight to us -- `attackers === 0`. The two grids disagreeing about one
  // square is the whole mechanism.
  //
  // Why this is not `holdWorks()`: that asks whether we hold a spot the BOOK proved, which is a
  // fact about history. A wall that held before is not a wall that holds now, and the book's own
  // rows say so -- 78% of room 39's failures are the fleet crowding onto its own shelter. This
  // asks the only question that matters at the moment of asking, and it needs no file.
  wallHere() {
    const geo = this.s?.world?.geometry, me = this.s?.client?.self;
    if (!geo || !me) return null;      // unreadable geometry is not a wall, and not a refusal
    const row = me.row ?? me.y ?? null, col = me.col ?? me.x ?? null;
    if (row == null || col == null) return null;
    try {
      const los = this.s?.world?.room?.los ?? 0;
      const ex = exposureAt(geo, Math.round(row), Math.round(col),
                            { fine: RoomGeometry.monsterUsesFine(los) });
      if (!ex) return null;
      return { ok: (ex.attackers ?? 0) === 0, attackers: ex.attackers ?? null,
               free_shots: ex.free_shots ?? null, row: Math.round(row), col: Math.round(col) };
    } catch { return null; }
  }

  // IS THERE A WEAPON IN OUR HAND — asked of the server, never of our own intentions.
  //
  // plUsing is the only authority (see equipment()): "the last use we sent was not
  // refused" has been wrong every time it mattered, because a weapon that shatters
  // mid-fight leaves the use list without anything being sent at all. A character that
  // cannot answer is treated as ARMED, because refusing to fight on a failed read would
  // idle the whole fleet the first time an inventory request timed out — the guard is
  // meant to catch the empty hand, not to become a new way to stop.
  // THE SAME QUESTION, FAILING THE OTHER WAY.
  //
  // armed() treats "cannot answer" as armed, and that is right where it is used: a
  // failed read must not stop a character mid-fight. It is exactly wrong for deciding
  // whether to WALK OUT OF AN INN, and that difference killed characters.
  //
  // `known` is false until the first BP_USE_LIST lands, which is precisely the window
  // just after a login — and a resume logs in twenty-one characters at once. So on the
  // pass right after a restart, every character answers "armed" on no evidence at all,
  // the farm branch reads that as permission, and marches an empty-handed character out
  // of the sanctuary it woke up in. Zoot did it with ten mana and no weapon: pass 0
  // "started", pass 2 "this room spawns nothing at all — going back to work", and dead
  // in the Yonder Inn's back yard four minutes later without one unarmed note in the
  // journal, because nothing ever asked a question this could answer no to.
  //
  // Leaving safety is the one decision that should need POSITIVE EVIDENCE. Waiting a
  // pass for the use list costs a second; being wrong costs the character everything it
  // was carrying.
  // ARMED, OPTIMISTICALLY — the twin `armedForSure` is named against, and it was missing.
  //
  // `known` is false for the first pass after a login, and a resume logs in twenty-one
  // characters at once, so "no evidence" is the ordinary state for several seconds rather
  // than a rare one. Which way that resolves has to depend on what the caller DOES with it:
  //
  //   armedForSure()  no evidence -> NOT armed.  For a gate that holds a character back.
  //                   Being wrong costs a few seconds in a sanctuary.
  //   armed()         no evidence -> armed.      For a rung that TAKES SOMETHING AWAY.
  //                   Being wrong cancels a crossing that was going fine.
  //
  // This one did not exist, and its only caller is the travel guard's first rung — the one
  // that abandons a journey because the weapon is gone. So every keeper pass inside a
  // journey threw `this.armed is not a function` before reaching a single defensive rung:
  // no flee, no rest, no shelter, no cancel. 328 failed passes across 32 postmortems in one
  // evening, and every death in them reads the same way — `doing: "stalled"`, standing
  // still for one to fourteen minutes with thirteen to eighteen monsters on the square.
  // The guard was not deciding to walk on through; it was never asked.
  armed() {
    const c = this.s.client;
    const eq = c?.equipment?.();
    if (!eq || eq.known === false) return true;   // no evidence is not a MISSING weapon
    return (eq.equipped || []).some(o =>
      skills.weaponScore(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '') > 0);
  }

  armedForSure() {
    const c = this.s.client;
    const eq = c?.equipment?.();
    if (!eq || eq.known === false) return false;       // no evidence is not a weapon
    return (eq.equipped || []).some(o =>
      skills.weaponScore(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '') > 0);
  }

  // WHOLE ENOUGH TO GO BACK OUT, asked only after a death.
  //
  // Health to nearly full, and vigor to what RESTING CAN ACTUALLY DELIVER — not to
  // full. Everything above REST_VIGOR_CAP (80 of 200) has to be eaten, so demanding
  // more than that here would demand a number sitting down can never reach and the
  // character would rest in an inn for ever. That is the same trap `vigorRestAt`
  // exists to avoid a few lines below, and it is worth saying twice: getting it wrong
  // does not error, it silently retires the character.
  //
  // 0.95 rather than 1 because health arrives in whole points — a 29-max character
  // sits at 28/29 for a long time, and the last point is not worth blocking on.
  // Deliberately the same pair of numbers as the sanctuary check at the top of rest().
  //
  // MANA IS REQUIRED NOW, AND IT WAS THE MISSING THIRD. This used to say mana was not
  // needed because nothing needs it to swing. That is true and it is beside the point:
  // `create weapon` costs 15, it is the only route to a weapon for a character that
  // just lost everything it owned, and a character that leaves the inn at 10 mana
  // cannot cast it and cannot get back above 10 anywhere else — mana barely moves while
  // something is hitting you.
  //
  // That is the loop this closes. Zoot, Rizzo and Animal were all released by the old
  // bar — full health, vigor at the cap, ten-odd mana, no weapon — walked to a hunting
  // ground they could not fight in, and died there. Unlike vigor, mana genuinely does
  // refill on its own while sitting, so waiting for it is a wait that ends.
  //
  // Vigor stays at what RESTING CAN ACTUALLY DELIVER — not full. Everything above
  // REST_VIGOR_CAP (80 of 200) has to be eaten, so demanding more would demand a number
  // sitting down can never reach and the character would rest in an inn for ever. That
  // trap is why this is worth saying twice: getting it wrong does not error, it
  // silently retires the character. The shortfall above 80 is a food problem and
  // provision()/cookSomething() are what answer it.
  //
  // AND A DEADLINE, for the same reason. Three vitals means three ways to wait for
  // something that is not coming — a mana bar that will not fill because the character
  // is being nibbled, a health point that never lands. RECOVER_MAX_MS is long enough
  // that a genuine recovery always finishes inside it and short enough that a stuck one
  // is a stall rather than a retirement.
  recovered() {
    const v = this.s.client?.vitals?.();
    const hp = pct(v?.health);
    if (hp === null) return false;                     // cannot tell — keep resting
    const done = (why) => { this.recoverUntilWhole = false; this.recoverSince = null;
                            if (why) this.note('going back out before fully recovered', why);
                            return true; };
    // The deadline is checked FIRST, so a character that cannot reach the bar leaves
    // rather than sitting for ever — and says which vital it gave up on.
    const since = this.recoverSince ?? null;
    if (since && Date.now() - since > RECOVER_MAX_MS)
      return done({ waited_s: Math.round((Date.now() - since) / 1000),
                    health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null,
                    vigor: vigorOf(v),
                    why: 'recovering has a deadline: three vitals is three ways to wait for ' +
                         'something that is not coming, and a character parked in an inn for ever ' +
                         'is a character retired by accident' });
    if (hp < 0.95) return false;
    // The per-character ceiling, not the global cap: a cursed character can never reach 80
    // of 200, so against the bare cap `recovered()` answers false for ever and the body
    // stays parked in an inn — the exact retirement-by-accident this method guards against.
    if ((vigorPct(v) ?? 1) < this.restVigorCeiling()) return false;
    // A zero or unreadable mana ceiling is not a shortfall — it is a character that has
    // no bar to fill, and blocking on it would be the retirement this guards against.
    const mp = pct(v?.mana);
    if (mp !== null && mp < 0.95) return false;
    return done(null);
  }

  // The experiment, run once per pass, for free, out of readings we already take.
  //
  // Between the last look and this one: did we stand still, did we refrain from
  // swinging, was there something adjacent that wants us dead — and did our health
  // hold? All four have to be true for the answer to mean anything, which is why this
  // tracks when we last moved and last swung. Damage arriving after a swing is
  // retaliation and says nothing at all about the square.
  observe() {
    try { publishCooperativePresence(this); } catch(e) { this.note('cooperative presence unavailable',{why:e.message}); }
    publishFleetHealth(this.s);
    void Promise.resolve(this.s.activeSelfHealTick?.('keeper_observe')).catch(error=>this.note?.('active self heal failed',{why:error.message}));
    const s = this.s, c = s.client, me = c?.self;
    const room = s.world?.room, now = Date.now();
    const health = c?.vitals?.()?.health?.value ?? null;
    const prev = this.lastObs;

    const hostiles = me ? [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)) : [];
    const adjacentIds = me
      ? hostiles.filter(o => Math.hypot(o.col - me.col, o.row - me.row) <= REACH).map(o => o.id)
      : [];
    this.campedIds = new Set(adjacentIds.filter(id => (prev?.adjacentIds || []).includes(id)));

    // A hold belongs to a room and to a square. Losing either loses it, and saying so
    // out loud matters more than it looks: a keeper that believes it is behind a wall
    // when it is not will make every following decision the wrong way round.
    if (this.hold && room?.num != null && this.hold.room !== room.num)
      this.releaseHold('we are not in that room any more');
    if (this.hold && me && (me.col !== this.hold.col || me.row !== this.hold.row))
      this.releaseHold('we are not standing on it any more');
    if (this.hold && me && me.x != null) { this.hold.x = me.x; this.hold.y = me.y; }

    // ARE THEY EVEN ALLOWED TO HIT US YET? On entry — including every reconnect —
    // the server withholds the monsters until the player acts. A quiet window inside
    // that period says nothing about the walls, and counting it would let the single
    // most dangerous mistake in this file happen quietly: a bad square proved safe by
    // evidence gathered while nothing was permitted to swing.
    const acted = Math.max(this.swungAt, this.movedAt, this.turnedAt);
    const awake = acted > this.rejoinedAt;

    this.idleDamage = 0;
    // Strictly before, not at: observe() runs at the top of a pass and everything else
    // in that pass happens after it, so a swing stamped at the same instant as the last
    // look is a swing we have not accounted for. Ambiguity here throws the window away,
    // which costs one reading and can never invent evidence either way.
    const stillness = prev ? (this.swungAt < prev.at && this.movedAt < prev.at) : false;
    const company = (prev?.adjacentIds || []).length;
    const lost = prev && health != null && prev.health != null ? prev.health - health : null;
    // HOW LONG WE HAD BEEN STANDING STILL ON THIS SQUARE WHEN THIS WINDOW OPENED — see
    // SETTLE_GRACE_MS. The later of the two clocks, because either one being recent
    // means damage from before we settled can still be arriving: `movedAt` covers
    // walking in, `hold.takenAt` covers claiming a square we were already on.
    const settledAt = Math.max(this.movedAt, this.hold?.takenAt ?? 0);
    const settledMs = prev ? prev.at - settledAt : 0;
    const settled = settledMs >= SETTLE_GRACE_MS;

    // The reading, whatever became of it. `verdict` is the thing to argue with; the
    // fields above it are what the argument is about. A discard is recorded exactly as
    // carefully as a conclusion, because a wrong discard is invisible otherwise.
    const trial = {
      at: now, pass: this.passes,
      room: room?.num ?? null,
      at_col: me?.col ?? null, at_row: me?.row ?? null,
      window_s: prev ? +((now - prev.at) / 1000).toFixed(1) : null,
      health_before: prev?.health ?? null, health_after: health, lost,
      adjacent_at_start: company, adjacent_now: adjacentIds.length,
      swung_in_window: prev ? this.swungAt >= prev.at : null,
      moved_in_window: prev ? this.movedAt >= prev.at : null,
      // How settled we were when this window opened. On a counted failure this is the
      // number that says whether SETTLE_GRACE_MS is wide enough; without it the question
      // can only be argued from intuition, which is how the square gets retired twice.
      settled_ms: prev ? Math.max(0, settledMs) : null,
      monsters_awake: awake,
      verdict: null, counted: false,
    };
    const settle = (verdict, counted = false) => {
      trial.verdict = verdict;
      trial.counted = counted;
      if (this.hold) {
        trial.quiet_total_s = Math.round(this.hold.quietMs / 1000);
        trial.proven_after = this.hold.proven;
      }
      this.trials.push(trial);
      if (this.trials.length > 120) this.trials.splice(0, this.trials.length - 120);
      return trial;
    };

    if (!this.hold) settle('not holding a spot — nothing to test');
    else if (!prev) settle('no previous reading to compare against');
    else if (health == null || prev.health == null) settle('health unreadable in one of the two readings');
    else if (!awake) settle('inside the entry grace period — the server is holding them back, so quiet proves nothing');
    else if (!stillness) settle(this.swungAt >= prev.at ? 'we swung in this window — damage would be retaliation'
                                                        : 'we moved in this window — we were not standing here throughout');
    else if (company === 0) settle('nothing was in swing range — a quiet window with nothing to be quiet about');
    else if (!settled) settle(`only ${Math.max(0, settledMs)}ms settled on this square when the window ` +
                              `opened, under the ${SETTLE_GRACE_MS}ms grace — a blow resolved before we ` +
                              'got here can still be arriving, and it is not this square\'s fault');

    if (this.hold && awake && prev && health != null && prev.health != null) {
      if (stillness && company > 0 && settled) {
        this.hold.mostAttackers = Math.max(this.hold.mostAttackers, company);
        if (lost > 0) {
          // POISON IS NOT THE WALL FAILING, AND IT USED TO BE RECORDED AS ONE.
          //
          // The caveat below this used to end "poison and archers look the same from here,
          // so this reading can be wrong — but it is still permanent, and deliberately so".
          // Both halves of that have moved. Archers — Avars, mostly — do not shoot into a
          // working spot either, so a stray one is not the explanation it was standing in
          // for; and poison is no longer invisible: BP_ADD_ENCHANTMENT (147) was declared and
          // never handled, so a sickness reached the client and was dropped on the floor.
          //
          // THAT DOES NOT MAKE POISON THE ONLY ANSWER, and this guard does not claim it is.
          // A PLAYER can reach a square a monster cannot, and area spells (heat, earthquake)
          // may not care about walls at all — though whether monsters cast either is not
          // established here. What the guard actually says is narrower and survives all of
          // them: nothing is adjacent AND something is draining us AND we are carrying a
          // sickness that explains it. A player hitting us at a wall is not the wall failing
          // either, so declining to discredit on that reading is right for that case too.
          //
          // Poison takes health with nobody adjacent and CANNOT KILL, which is exactly what a
          // leaking wall is supposed to look like and exactly what a working one produces
          // while a character is poisoned. So a poisoned character was quietly discrediting a
          // good square on every rest it took, permanently, with no way back into the
          // recommendations — and the book is shared, so it did it for everybody.
          //
          // The one-failure rule is untouched and still right: being wrong about a bad spot
          // costs a character and being wrong about a good one costs a walk to the next
          // corner. This does not soften it. It removes a reading that was never evidence.
          const ailing = this.s.client?.ailments?.() ?? [];
          if (ailing.length && !company) {
            this.hold.quietMs = 0;
            this.note('losing health at a wall, and it is poison rather than the wall', {
              where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
              lost_health: lost, attackers: company,
              ailments: ailing.map(e => e.name).filter(Boolean),
              why: 'nothing is adjacent and something is draining us — poison cannot kill and ' +
                   'does not care what square we are on, so this says nothing about the wall',
              what_happens: 'the spot keeps its record and is NOT discredited; the rest ends ' +
                            'because it is not winning, not because the square failed',
            });
            return;
          }
          // It does not work. Say so loudly, forget the proof, and write it down so
          // that the geometry cannot talk us back onto this square in ten minutes.
          this.idleDamage = lost;
          this.hold.failures++;
          this.hold.damageWhileIdle += lost;
          this.hold.quietMs = 0;
          const wasProven = this.hold.proven;
          this.hold.proven = false;
          this.noteFailedRestSpot(this.hold.room, this.hold.col, this.hold.row);
          // THE ONE OBSERVATION THAT DISPROVES THE DEFINITION, WRITTEN SOMEWHERE CLEAN.
          //
          // A `book.failed(...)` write stood here and is gone. The note beside it already
          // conceded it was not evidence — 78% of that file's failure events carry
          // `failed_via: "fight"`, which is retaliation and therefore the mechanic WORKING,
          // and a further 11% were recorded before the character even arrived — and it was
          // kept only because other code still read the book's shape. Nothing does now.
          //
          // The deeper reason it could not be salvaged: it filed the row against
          // `this.hold.col/row`, the square this keeper had RESERVED, which in nine of ten
          // reviewed deaths was 5 to 68 squares from where the body actually stood. A
          // per-square outcome record whose writer does not know where the body was is not
          // a record about squares.
          //
          // This row is the same event recorded under the four qualifiers that make it mean
          // something, and nothing that chooses a square may ever read it. See
          // tools/m59-restwatch.mjs.
          this.recordRestOutcome({ damage: lost, settledMs, since: prev?.at ?? null });
          this.note('THIS IS NOT A SAFE SPOT', {
            where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
            lost_health: lost, attackers: company, was_proven: wasProven,
            settled_ms: Math.max(0, settledMs),
            why: 'we were hit while standing still and not swinging, which is the one thing ' +
                 'that cannot happen in a working spot',
            caveat: 'poison is checked for above and is not this — an ailing character with ' +
                    'nothing adjacent returns before here. This keeper temporarily skips the ' +
                    'square while recovering; the historical ledger does not decide wall geometry' });
          // Settle the reading BEFORE letting the hold go, or the record loses the
          // very state it is a record of.
          settle(`HIT for ${lost} while standing still with ${company} adjacent — this square does not work`, true);
          // And stop standing in it. Keeping the hold would mean fighting from a
          // square we have just watched fail — refusing to approach, refusing to
          // withdraw, and taking hits the whole time. Letting it go puts the next
          // pass back on the ordinary path, which will either find a better square or
          // fight in the open with the flee threshold live.
          this.releaseHold('it does not work — we were hit standing still in it');
        } else {
          this.hold.quietMs += now - prev.at;
          const alreadyProven = this.hold.proven;
          if (!this.hold.proven && this.hold.quietMs >= PROOF_MS) {
            this.hold.proven = true;
            this.hold.provenAt = now;
            // A `book.held(...)` write stood here. It recorded the same hold coordinates the
            // failure path did, so its successes were as unattributable as its failures —
            // and a square's past quiet was never the reason to trust it anyway.
            // THE CASE THE DEFINITION PREDICTS: things stood next to us for PROOF_MS and not
            // one of them landed a blow. Recorded so `clean` has a denominator — a rule with
            // no violations and no observations says nothing at all.
            this.recordRestOutcome({ damage: 0, settledMs: this.hold.quietMs,
                                     since: this.hold.takenAt ?? null });
            this.note('this safe spot works', {
              where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
              quiet_for_s: Math.round(this.hold.quietMs / 1000), attackers: this.hold.mostAttackers,
              why: 'things have been standing next to us for ' +
                   Math.round(this.hold.quietMs / 1000) + 's and none of them has landed a blow',
              means: 'we can now rest to full here instead of running, and break off any fight ' +
                     'that turns against us at no cost',
              ...(this.spotTest ? { learned_by: 'deliberately holding the swing to find out' } : {}) });
            this.spotTest = null;      // the question is answered; get on with the fight
          }
          // Settled last, so that `proven_after` on this reading says what this
          // reading concluded rather than what was believed before it.
          settle(this.hold.proven && !alreadyProven
            ? `PROVED: ${Math.round(this.hold.quietMs / 1000)}s quiet with up to ` +
              `${this.hold.mostAttackers} adjacent, nothing landed`
            : alreadyProven
              ? `still holding: ${company} adjacent, nothing landed`
              : `quiet with ${company} adjacent — ${Math.round(this.hold.quietMs / 1000)}s of the ` +
                `${PROOF_MS / 1000}s needed`, true);
        }
      }
    }

    // Where we were standing, kept briefly after the hold itself is gone. A death
    // releases the hold before anything gets to ask about it — the Underworld is a
    // different room, so observe() drops it on the very pass that discovers we died —
    // and "were we in a spot when we were killed?" is the question the whole thesis
    // turns on. Thirty seconds is long enough to survive that ordering and short
    // enough that it cannot be mistaken for where we are now.
    if (this.hold) this.lastHold = { ...this.hold, at: now };

    this.lastObs = { at: now, health, adjacentIds,
                     col: me?.col ?? null, row: me?.row ?? null, room: room?.num ?? null };
  }

  // ONE REST EPISODE, INTO THE CLEAN LEDGER. Never throws and never decides anything: the
  // ledger it writes may not be read by anything that chooses a square, which is the
  // guarantee the retired safe-spot book did not have and is exactly how that book stopped
  // being a record of what happened and became an input to the thing it was measuring.
  //
  // `ailing` is asked HERE rather than passed in, so the poison exclusion cannot be
  // forgotten by a future caller — a poison tick drains through any wall ever built and
  // says nothing about the square.
  recordRestOutcome({ damage = 0, settledMs = 0, since = null, swung = null } = {}) {
    try {
      const ailing = (this.s.client?.ailments?.() ?? []).length > 0;
      // SWUNG IS COMPUTED HERE, NOT ASSERTED BY THE CALLER.
      //
      // Both call sites passed a literal `false`, which made `swung` UNREACHABLE — an entire
      // outcome category that could never occur. After 2,270 rows the ledger read
      // `swung 0, settling 0, ailing 0` and I nearly read that as a clean fleet rather than
      // as three buckets with no path into them. `this.swungAt` has been on the keeper the
      // whole time (it is what `swung_in_window` upstairs is built from), so the honest
      // answer is a comparison against the window, exactly as `ailing` is asked rather than
      // passed. A caller may still override deliberately.
      const windowStart = Number.isFinite(since) ? since
        : Date.now() - Math.max(0, Number(settledMs) || 0);
      const didSwing = swung != null ? !!swung
        : (Number(this.swungAt) > 0 && this.swungAt >= windowStart);
      // WHERE THE BODY ACTUALLY WAS, MEASURED, NOT WHERE IT HAD RESERVED.
      //
      // This is the defect that retired the old safe-spot book, and this ledger inherited it
      // unnoticed: the hold branch below attributes the outcome to `this.hold.col/row`, which
      // is the square this keeper RESERVED. A hold is not a position. Nine of ten deaths
      // reviewed on 2026-09-20 had the body between 5 and 68 squares from the hold filed
      // against them, and the first three violations recorded after this rule went to prod
      // were filed against 10,29 / 21,4 / 21,10 in room 554 while the body was at 14,31 —
      // so not one of them can be read as evidence about those squares.
      //
      // The fix is not to guess which is right. It is to record BOTH and the gap between
      // them, so a row says whether it is about a square at all. `off_by` is the number an
      // analysis must filter on: 0 means the body was on its hold and the row is evidence;
      // anything else means it was somewhere else and the row is about a hold.
      const body = this.s.client?.self;
      const at = (Number.isInteger(body?.row) && Number.isInteger(body?.col))
        ? { col: body.col, row: body.row } : null;
      let verdict = null, room = null, offBy = null, held = null;
      if (this.hold) {
        room = this.hold.room ?? null;
        held = { col: this.hold.col, row: this.hold.row };
        if (at) offBy = Math.max(Math.abs(at.col - held.col), Math.abs(at.row - held.row));
        // MEASURE THE SQUARE THE BODY IS ON, falling back to the hold only when the client
        // cannot say where it is. Measuring the hold while standing elsewhere is how a wall
        // gets blamed for a beating taken in the open.
        const geo = this.s.world?.geometry;
        verdict = (at && geo) ? safeWallVerdict(geo, at.row, at.col) : verdictFromRow({
          col: this.hold.col, row: this.hold.row,
          can_reach_you: this.hold.canReachYou, free_shots: this.hold.freeShots,
          refused_approaches: this.hold.refusedApproaches,
          offered_approaches: this.hold.offeredApproaches,
        });
      } else {
        // NO HOLD IS THE CASE THAT ACTUALLY KILLS, AND IT WAS THE ONE NOT BEING RECORDED.
        //
        // The first version of this returned early without a hold, so the ledger only ever
        // saw rests taken IN a safe wall — it recorded the case that was already working
        // and missed the one that killed Waldorf, whose four deaths were all `fieldrest`
        // with `in_safe_spot: false`. Measured on prod 2026-09-10: 22 keepers up, ZERO
        // holding a wall, and a ledger that would therefore have read empty for ever while
        // looking perfectly healthy.
        //
        // So measure the square actually being sat on. `is_wall: false` rows are the point
        // of the experiment, not noise in it: they are how "we rested somewhere things
        // could reach us, and here is what it cost" becomes a number instead of a memory.
        const geo = this.s.world?.geometry, me = this.s.client?.self;
        if (!geo || !Number.isInteger(me?.row) || !Number.isInteger(me?.col)) return;
        room = this.s.world?.room?.num ?? null;
        verdict = safeWallVerdict(geo, me.row, me.col);
      }
      recordRest({
        agent: this.s.name ?? null, room, verdict,
        damage, swung: didSwing, ailing, rested_ms: Math.max(0, settledMs),
        // `at` is the body, `held` is the reservation, `off_by` is the Chebyshev gap. A row
        // with off_by > 0 is NOT evidence about the square it names — see above.
        body: at, held, off_by: offBy,
        // AILING IS A DEFAULT, NOT A MEASUREMENT, WHENEVER THIS IS NULL. `client.ailments()`
        // is absent on this build — `look` reports the field as undefined — so `ailing:false`
        // has been asserting something nobody checked, on a ledger whose whole purpose is to
        // exclude poison. Recorded so a reader can tell the two apart.
        ailing_known: typeof this.s.client?.ailments === 'function',
      });
    } catch { /* a ledger may never take a character down */ }
  }

  operatorSurvivalStandDown() {
    if(this.policy?.survivalEnabled!==false)return false;
    const d=currentSurvivalDecision(this.s);
    if(d)finishSurvivalDecision(this.s,d.id,'operator_disabled','autonomous survival disabled by operator');
    this.frozenUntil=null;this.freezeSample=null;this.suspendedJourney=null;
    if(this.hold)this.releaseHold('autonomous survival disabled by operator');
    return true;
  }

  releaseHold(why) {
    if (!this.hold) return;
    const h = this.hold;
    this.note('gave up the safe spot', {
      where: { col: h.col, row: h.row }, why, proven: h.proven,
      held_s: Math.round((Date.now() - h.takenAt) / 1000) });
    this.hold = null;
    // Pull evidence belongs to the square being released. Letting two misses from one
    // wall follow us to the next would condemn the new wall on its second experiment.
    this.pendingPull = null;
    this.pullsWithoutContact = 0;
    this.pulledLastPass = false; // compatibility with state created by older code
    releaseSpot(this.s.name);
  }

  // What level is this thing, so we can ask whether killing it pays.
  creatureLevel(name) {
    const all = loadSpawns(SPAWN_FILE)?.creatures;
    const q = String(name || '').toLowerCase();
    if (!all || !q) return null;
    if (all[q]) return all[q].level ?? null;
    // "rat" has to resolve to "giant rat". Where a partial name matches several,
    // take the TOUGHEST: the cautious reading of an ambiguous name is the dangerous
    // one, and being wrong in that direction only costs a walk to a corner.
    let best = null;
    for (const [k, v] of Object.entries(all)) {
      if (!k.includes(q) && !q.includes(k)) continue;
      if (v.level != null && (best == null || v.level > best)) best = v.level;
    }
    return best;
  }

  // IS THIS FIGHT WORTH A WALL? The owner's rule of thumb, which turns out to be
  // exactly the rule the game already uses: if you can gain max health from it, fight
  // it from a safe spot.
  //
  // AdvancementCheck only rolls when monster_level > base_max_health, and max health
  // IS the level here — so "this kill can make me stronger" and "this creature is at
  // or above my level" are the same statement, and something at or above your level
  // is something that can take a third of your bar in one blow. The two halves of the
  // rule are the same fact read from either end.
  //
  // The exception is the one the rule names: prey we outclass pays nothing, cannot
  // realistically kill us, and the walk to the corner costs more than the fight.
  holdWorthwhile(names = []) {
    // NOT `useSafeSpots` — that is the always-on non-combat facility now (rest, park,
    // recover, the ladder) and cannot be switched off. This function is COMBAT, and the
    // only combat choice is whether the fight OPENS with a walk to a wall.
    const mine = this.s.client?.vitals?.()?.health?.max ?? 0;
    const levels = names.map(n => this.creatureLevel(n)).filter(x => x != null);
    const worst = levels.length ? Math.max(...levels) : null;
    const crowd = this.threat().near.length;

    // THE WALL IS A RESPONSE, NOT A POSTURE — unless `pullToSafeWall` says otherwise.
    //
    // History, because the setting reads oddly without it. There were two flags and only
    // two of the four states they describe were ever used: `useSafeSpots:false` (never
    // take a wall) and `requireSafeWall:true` (refuse a fight without one). The state the
    // fleet actually wanted — the wall is AVAILABLE and is not the plan — did not exist,
    // because clearing `requireSafeWall` alone only skipped the room denial and still
    // walked to a corner before every single engagement.
    //
    // Operator, 2026-09-05: "for 'not required', it should flee to a safe wall by default
    // if 2+ creatures are attacking it, but otherwise not use a safe wall."
    //
    // Operator, 2026-09-10: the wall is always on for everything that is NOT combat, and
    // the only remaining choice is the opening pull. So the flag was renamed to say that
    // and nothing else, and `useSafeSpots` stopped being a switch — the non-combat rungs
    // no longer ask it, and this function no longer asks it either.
    //
    // One creature in reach is the fight we came for and is answered by fighting; two is
    // the thing that actually kills characters here, and it is answered by putting our
    // back somewhere. `wallAtAttackers` is the bar and it is a policy rather than a
    // constant, because it is the whole content of the setting.
    //
    // MELEE REACH, NOT THE CROWD RADIUS. `near` is four squares and counts creatures that
    // are walking past; `adjacent` is REACH (3) and is as close to "is hitting us" as this
    // keeper can read without waiting for the damage. The count that decides whether to
    // move has to be the one that is true before the blows land.
    if (!opensFightFromWall(this.policy)) {
      const attackers = this.threat().adjacent.length;
      const bar = Number.isFinite(Number(this.policy.wallAtAttackers))
        ? Number(this.policy.wallAtAttackers) : 2;
      if (attackers >= bar)
        return { hold: true, level: worst, my_level: mine, crowd, attackers, bar,
                 why: `${attackers} creatures are inside melee reach against a bar of ${bar} — ` +
                      'a wall is not required here, but a crowd is the one thing it is for' };
      return { hold: false, level: worst, my_level: mine, crowd, attackers, bar,
               why: `${attackers} creature(s) in reach against a bar of ${bar}: the wall is ` +
                    'available and not required, so fight this one where it stands rather ' +
                    'than spending the pass walking to a corner' };
    }

    if (worst == null)
      return { hold: true, crowd,
               why: 'nothing is known about what is here, and the careful reading of an unknown ' +
                    'creature is that it can hurt us' };
    if (worst > mine)
      return { hold: true, level: worst, my_level: mine, crowd,
               why: `a level ${worst} kill can raise our maximum health of ${mine}. Anything that ` +
                    'pays is by definition at or above our level, and anything at our level can ' +
                    'take a third of the bar in one blow — so fight it from a wall' };
    if (crowd >= 3)
      return { hold: true, level: worst, my_level: mine, crowd,
               why: `we outclass a level ${worst}, but there are ${crowd} of them within four ` +
                    'squares and swarms are what actually kills characters here' };
    return { hold: false, level: worst, my_level: mine, crowd,
             why: `level ${worst} against our ${mine}: the kill pays nothing — AdvancementCheck ` +
                  'needs the monster above our max health — and we are strong enough that the ' +
                  'walk to a corner costs more than the fight does' };
  }
  // @end 1
}
