// THE COMBAT PASSES: arming, engaging a player, conflict, playbooks, fighting back.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 8 methods: damageRate, timeToDeath, passArm, engagePlayerTarget, respondToConflict, passPlaybook,
//   fightNow, passFightBack
import * as grudge from '../m59-grudge.mjs';
import { activeConflicts, clearConflict, declareConflict, recordTargetKill, targetsFor } from '../m59-intel.mjs';
import { findPath } from '../m59-map.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { pvpAllowedHere, pvpRoomsOf } from '../m59-pvp-rooms.mjs';
import { refusedHere } from '../m59-refused-targets.mjs';
import * as skills from '../m59-skills.mjs';
import * as tougher from '../m59-tougher.mjs';
import { CONJURED_WEAPON_BULK, CONTINUE, FIGHT_BACK_STALE_MS, HANDLED, REACH, SPELL_EXERTION_VIGOR, partialFightMadeProgress, pct, releaseQuarry, scriptedWalkDefersArming, sleep, unarmedBlocker, vigorOf } from '../m59-autopilot.mjs';

export class PassCombatPart {
  // @part 1

  // HOW FAST HEALTH IS LEAVING, IN POINTS PER SECOND, OVER THE POSITION PULSE RING.
  //
  // The ring is the only instrument that reads the CHARACTER rather than the keeper — it
  // is written by a 500ms watchdog that keeps running through a travel await — so it is
  // the only place a rate can come from while something else is driving. Six samples is
  // about five seconds, which is wide enough that a single hit does not read as a cliff
  // and narrow enough to still be about now.
  //
  // Returns 0 when health is steady or climbing, and null when there is not enough ring
  // to say. Never negative: a rest that is working is not a rate anybody wants here.
  damageRate() {
    const ring = this.watch?.pulses;
    if (!ring || ring.length < 3) return null;
    const first = ring.find(p => Number.isFinite(p.health));
    const last = [...ring].reverse().find(p => Number.isFinite(p.health));
    if (!first || !last || first === last) return null;
    const seconds = (last.at - first.at) / 1000;
    if (!(seconds > 0)) return null;
    return Math.max(0, (first.health - last.health) / seconds);
  }

  // HOW LONG THE CHARACTER HAS AT THE CURRENT RATE, in ms. null when it is not losing.
  timeToDeath() {
    const rate = this.damageRate();
    if (rate === null || rate <= 0) return null;
    const now = this.s?.client?.vitals?.()?.health?.value;
    if (!Number.isFinite(now) || now <= 0) return null;
    return (now / rate) * 1000;
  }

  // ── passArm: extracted from pass() ────────────────────────────────
  async passArm(ctx) {
    const { s, c, room } = ctx;
    // The touch spell's START/STOP lines and every "Your punch"/"Your acid touch" swing are read
    // on every pass, wherever the character is, so the belief is current the moment it returns
    // to its ground. Memory only: no wire, no wait.
    if (this.policy?.touchSpell) this.observeTouchSpell(c);
    // Deliberate bare-hand practice is not a broken loadout. It is allowed only on
    // the assigned farm ground; after a death or during travel the ordinary arm-first
    // survival rule remains in force.
    // An interrupted road retains the road's guard. Requiring a weapon while its
    // parent is suspended deadlocks unarmed travellers on conjuring/policy loops,
    // even though the same journey deliberately allows walking unarmed when active.
    // Later flee/rest/ownership/resume gates still decide whether it may set off.
    if (this.suspendedJourney && this.travelGuard(this.suspendedJourney.guard).arm !== true || scriptedWalkDefersArming(this)) {
      this.clearRefusal('UNARMED_NO_DONOR');
      this.clearRefusal('UNARMED_CANNOT_CAST');
      if (['MANA_FOR_CREATE_WEAPON', 'VIGOR_FOR_CREATE_WEAPON'].includes(this.waitingOn?.code))
        this.doneWaiting?.();
      return CONTINUE;
    }
    const practice = this.trainingStyleFor();
    if (practice === 'unarmed' && this.mode === 'farm' &&
        room?.num === this.policy.assignedRoom) {
      // AND PUT DOWN WHAT IS ALREADY IN THE HAND. Declining to re-arm is not the same as
      // being unarmed, and this branch only did the first — so a character switched to
      // unarmed practice while holding a mace went on holding it between bouts.
      //
      // That is not cosmetic. SwingWeapon reads the proficiency of what is HELD and zeroes
      // piWeaponSwings the moment it differs from the one the counter is on
      // (player.kod:4753-4757), and no improvement fires at all until that counter reaches
      // 75 (player.kod:4536-4537, 4759). So ONE swing landed with the mace throws away a
      // bare-hand block that took twenty minutes to build.
      //
      // Worse on this fleet than it sounds: mace fighting runs 39-58 here and the quarry is
      // level 50, so for most characters the mace cannot improve either (stroke.kod:115).
      // The swing destroys the block and buys nothing with it.
      //
      // Measured 2026-09-08: 17 characters on `unarmed`, 16 of them holding a mace, hammer,
      // axe or long sword, and brawling pinned at 4-5 across all twenty-one.
      // `c &&` FIRST: isArmed() answers TRUE when it cannot see the equipment, which is the
      // right fail-safe for a live character whose use list has not arrived and the wrong
      // one for no client at all. Without the guard this path tried to unwield for a
      // session that does not exist and then threw inside note().
      if (c && skills.isArmed(c)) {
        // A touch-spell trainer gets the version that falls back to a DIRECT unuse by the
        // equipment list's own ids when the id join reads the hand as empty.
        const bare = await (this.touchTrainingHere() ? this.touchDisarm() : this.unuseTrainingWeapon())
          .catch(e => ({ ready: false, why: e.message }));
        if (bare.ready && bare.removed)
          this.note('unarmed practice: put down the weapon', { removed: bare.removed,
            why: 'a swing with it would reset the bare-hand improvement counter' });
        // AND SAY SO WHEN IT DOES NOT COME OFF. A silent failure here looks exactly like a
        // silent success from outside — the character carries on hunting either way — and
        // the whole point of the branch is that the hand is empty. Rate-limited to once a
        // minute so a server that simply will not take the weapon does not flood the log.
        else if (!bare.ready && Date.now() - (this._lastDisarmComplaint ?? 0) > 60_000) {
          this._lastDisarmComplaint = Date.now();
          this.note('unarmed practice: could NOT put the weapon down', {
            why: bare.why ?? 'no reason given',
            cost: 'every swing landed with it zeroes the bare-hand improvement counter' });
        }
      }
      return CONTINUE;
    }
    // NO WEAPON: FIX IT BEFORE ANYTHING ELSE, and never walk out to hunt without one.
    //
    // armSelf() already wields from the pack and falls back to conjuring, and makeWeapon
    // already exists — but nothing was GATING on the result, so a character whose weapon
    // shattered simply carried on hunting bare-handed. Scooter did it three times today,
    // Rowlf, Gonzo and Animal once each. An empty hand still swings and still reports
    // fighting, so it never reads as broken from outside.
    //
    // A REFUSAL THAT SURVIVES BEING SATISFIED IS A LIE ON THE BOARD.
    //
    // UNARMED_NO_DONOR was cleared in exactly one place, deep inside the branch that runs
    // only when a pass has already found prey, and gated on `weaponsOf(...).length` — on
    // CARRYING a weapon — while the refusal is raised on `isArmed`, which is about the
    // server's use list. Two different questions, and a character can answer them
    // differently: measured on prod 2026-09-11, Clifford was WIELDING a mace and Scooter a
    // short sword, and both still carried a blocking UNARMED_NO_DONOR. `blocking: true`
    // makes every stall reader step over them for ever.
    //
    // So it is cleared here instead: the same predicate that raises it, on every pass,
    // before anything branches on prey.
    // A POSTED CASTER IS NOT AN UNARMED FIGHTER, and everything below this line exists to
    // get a FIGHTER armed. Skip the whole apparatus for one.
    //
    // Measured 2026-09-12, and it is why this guard exists rather than being tidiness. Loial
    // was posted in room 39 to keep `forces of light` standing: policy applied and confirmed
    // at the keeper, 77 emeralds, 116 elderberries, 65 of 65 mana, holding nothing. He cast
    // NOTHING for a hundred seconds, because this branch fires ~1,800 lines before the room
    // enchantment pass and returned first every time, noting "unarmed and in a room that
    // spawns — leaving to regain mana".
    //
    // For him that errand could never succeed on any of its four routes: he is a Shal'ille
    // caster and does not know `create weapon` at all, so the mana it was saving up is for a
    // spell he cannot cast. It would have walked him out of the room he was posted in, for
    // ever, to wait for something that was never going to happen.
    //
    // The test is the JOB, not the hands. A character told to stand somewhere and keep an
    // enchantment up has no business hunting a weapon: it is not going to swing, its whole
    // value is that it does not move, and the survival ladder still belongs to the keeper if
    // something attacks it.
    if (this.policy.roomEnchant?.enabled && !skills.isArmed(this.s.client)) {
      this.clearRefusal('UNARMED_NO_DONOR');
      // Said once a minute rather than every pass: it is a standing condition, not an event.
      if (Date.now() - (this._casterUnarmedNoteAt ?? 0) > 60_000) {
        this._casterUnarmedNoteAt = Date.now();
        this.note('posted as a room caster and carrying no weapon — that is the job, not a fault',
          { room: this.s.world?.room?.num ?? null,
            why: 'the arm-yourself errand is for fighters. This character is here to keep a ' +
                 'room enchantment standing and must not be walked out of the room to chase ' +
                 'a weapon it will never swing' });
      }
    } else if (skills.isArmed(this.s.client)) {
      this.clearRefusal('UNARMED_NO_DONOR');
      if (this.waitingOn?.code === 'MANA_FOR_CREATE_WEAPON' ||
          this.waitingOn?.code === 'VIGOR_FOR_CREATE_WEAPON') this.doneWaiting?.();
    }
    // AHEAD OF THE DANGER AND REST BRANCHES ON PURPOSE — BUT NOT BELOW THE FLEE LINE.
    //
    // Being unarmed is WHY a fight is going badly, and the shortest way out is usually to be
    // holding something. That is true of a character that is losing. It is not true of one
    // that is dying: at 5 of 52 the answer is to leave, and every second spent conjuring is a
    // second the thing hitting you gets for free.
    //
    // THE ORDERING IS THE BUG. This rung sits 654 lines and twenty-two possible `return`s
    // ahead of `escapeIfWedgedAndHurt`, the survival rung below the flee line — so a hurt
    // character ran the whole arming ladder and the pass ENDED before survival was ever
    // asked. Measured across prod's postmortems: five deaths at 3-6% health, every one of
    // them with a weapon in the pack its own ban list forbade, so the ladder could not even
    // succeed. Sweetums spent its last thirteen passes over 13.9 seconds on "unarmed and in
    // a room that spawns — leaving to regain mana", at 3 of 49, with a battered skeleton
    // hitting it and a mace it was not allowed to hold.
    //
    // `fleeAt` is the same line `escapeIfWedgedAndHurt`, the flee rung and the trade rung all
    // use, so this hands the pass over at exactly the point the survival half starts caring.
    // A character hurt but SAFE still arms: it heals above the line in a sanctuary and the
    // next pass runs this normally — which is the common case, and the one that must not
    // regress into "never arms again".
    const armVitals = this.s.client?.vitals?.();
    const armHealth = armVitals?.health?.max > 0
      ? armVitals.health.value / armVitals.health.max : null;
    const tooHurtToArm = armHealth !== null && armHealth < this.safety().fleeAt;
    // The same exemption as above, applied to the two branches that actually walk the
    // character somewhere. Stated as one local so the pair cannot drift apart later.
    const postedCaster = !!this.policy.roomEnchant?.enabled;
    if (!postedCaster && tooHurtToArm && !skills.isArmed(this.s.client)) {
      // Said once a minute rather than every pass: a body below the flee line is having a
      // bad enough second without its own journal being the loudest thing in the room.
      if (Date.now() - (this._lastArmDeferAt ?? 0) > 60_000) {
        this._lastArmDeferAt = Date.now();
        this.note('unarmed, but too hurt to stop and fix it', {
          health: armVitals?.health ? `${armVitals.health.value}/${armVitals.health.max}` : null,
          flee_at: Math.round(this.safety().fleeAt * 100) + '%',
          why: 'the arming ladder ends the pass, and below the flee line the rungs that ' +
               'matter are the survival ones further down',
          doing: 'handing the pass to survival — it arms again once it is back above the line' });
      }
    }
    if (!postedCaster && !tooHurtToArm && !skills.isArmed(this.s.client)) {
      // A shattered weapon still occupies the room needed for its replacement.
      // The ordinary farm sweep is below this stage and cannot run while it is
      // blocked here. Keep the same drop policy and sweep rate when rearming.
      await this.sweepBroken().catch(() => null);
      await this.sweepCursed().catch(() => null);
      const ok = await this.armSelf().catch(() => false);
      if (ok && skills.isArmed(this.s.client)) { this.progress('armed itself'); return HANDLED; }
      // makeWeapon refreshes the spell list before reporting failure when mana is
      // sufficient. Below 15 mana it cannot do that, so refresh once in sanctuary
      // before deciding whether mana recovery can ever produce a weapon.
      if (!this.knowsCreateWeapon() && this.sanctuary()) {
        await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
        await sleep(400);
      }
      if (!this.knowsCreateWeapon() && this.sanctuary()) {
        const now = Date.now();
        const cooldown = 5 * 60_000;  // don't ask for a shopping trip on every pass
        // ASK, AND WAIT TO BE SERVICED. The request is a field the broker polls; see
        // requestWeaponPurchase for why the keeper must not run the errand itself.
        if (!this._lastOutfitAt || now - this._lastOutfitAt >= cooldown) {
          const why = 'unarmed and does not know create weapon — asking for one to be bought';
          this.noProgress(why);
          this._lastOutfitAt = now;
          this.requestWeaponPurchase({ why });
          // NOT A STOP. A request is outstanding, and stopping the keeper now would take
          // the character off the board while the thing that fixes it is still coming.
          return HANDLED;
        }
        // A request is outstanding or the cooldown has not run out, and the character is
        // still unarmed. Stop, so the board shows the real state and a human can step in
        // — hand it a weapon, or top up the bank the outfit run is spending from.
        if (this.wantsWeapon) {
          this.noProgress('unarmed — waiting for the weapon it asked for');
          return HANDLED;
        }
        const why = 'unarmed, does not know create weapon, and the shopping trip did not arm us';
        this.noProgress(why);
        this.note('cannot self-arm', {
          why,
          mana: c.vitals?.()?.mana?.value ?? null,
          action_needed: 'buy, recover, or receive a weapon before restarting combat',
          next_request_in_s: Math.round((cooldown - (now - (this._lastOutfitAt ?? now))) / 1000),
        });
        this.stop(why);
        return HANDLED;
      }
      // EVERYTHING BELOW THIS LINE IS ABOUT `create weapon`, AND NOT EVERY CHARACTER HAS IT.
      //
      // The two `!knowsCreateWeapon()` checks above are both gated on `sanctuary()`, so they
      // only catch a character standing somewhere safe. One that does NOT know the spell and
      // is NOT in sanctuary falls straight through to the mana wait below — which sits it
      // down, or walks it out of the room, to save fifteen mana for a spell it cannot cast.
      // No amount of waiting ends that.
      //
      // Measured 2026-09-12: Loial, a Shal'ille caster with no `create weapon` at all, posted
      // in room 39 with 65 of 65 mana, noting "unarmed and in a room that spawns — leaving to
      // regain mana" on every pass. Room 39 spawns, so `sanctuary()` was false, so neither
      // check above fired. He was never going to conjure anything: the errand's own
      // precondition was absent and nothing tested it.
      //
      // The other three routes to a weapon stay open — `armSelf()` above already tried them,
      // and the purchase request still runs in sanctuary. This removes only the route that
      // cannot work, which is the difference between a character waiting and one stuck.
      if (!this.knowsCreateWeapon()) {
        this.clearRefusal('UNARMED_NO_DONOR');
        this.clearRefusal('UNARMED_CANNOT_CAST');
        // A standing condition, not an event: said once a minute rather than every pass.
        if (Date.now() - (this._noConjureNoteAt ?? 0) > 60_000) {
          this._noConjureNoteAt = Date.now();
          this.note('unarmed and cannot conjure — skipping the create-weapon errand', {
            mana: c.vitals?.()?.mana?.value ?? null,
            why: 'this character does not know `create weapon`, so waiting for 15 mana '
               + 'achieves nothing and walking out of the room to wait achieves less',
            action_needed: 'buy, receive or loot a weapon' });
        }
        return CONTINUE;
      }

      // Not enough mana to conjure one yet. SIT DOWN — and do not let settle() decide
      // whether that happens.
      //
      // Rowlf spent twenty minutes and 1078 passes stuck on exactly this. settle()
      // answered "nowhere clear to rest here" three times and gave up, so the character
      // stayed on its feet, where mana regenerates slowly enough that it climbed 1 to 14
      // in twenty minutes — and needed 15. It then failed the roll (half cost) and began
      // the climb again. settle() is choosing a good square with elbow room, which is
      // the right question when picking a spot to fight from and the wrong one here:
      // sitting anywhere in a room nothing spawns in beats standing in the best square
      // of one.
      this.doing = 'recovering';
      // AN UNARMED CHARACTER IN A SPAWN ROOM CANNOT WAIT WHERE IT IS STANDING.
      //
      // Everything below sits down and waits for the 15 mana, which is right — but the
      // sit-anywhere fallback is gated on sanctuary(), so a character stuck in a room
      // that generates monsters got neither: settle() refuses because there is no clear
      // floor, the fallback declines because the room spawns, and the pass ends with it
      // still standing there. Mana regenerates barely at all on its feet while something
      // is hitting it, so it never reaches 15 and never conjures.
      //
      // That is the state the whole fleet reached: Kermit at 12 mana, Rizzo at 12, Animal
      // at 4, all three "hunting fungus beast" bare-handed in the Valley, with no spare
      // weapon anywhere, no shillings, and nothing able to sell them one. Four routes to a
      // weapon and all four shut.
      //
      // So walk out first — a character with nothing in its hands has no business in a
      // monster room, and the walk is the cheapest of the four routes because it needs no
      // money, no donor and no meeting. The argument, and the gate that used to make this
      // unreachable, are on `leaveForManaWhileUnarmed`.
      if (!this.sanctuary()) {
        if (await this.leaveForManaWhileUnarmed()) return HANDLED;
      }
      // settle() returns {settled}, not a boolean — reading it as one would make this
      // fallback dead code, which is exactly the kind of silent no-op this branch exists
      // to stop happening.
      const sat = await this.settle('no weapon, resting for the mana to make one')
                            .catch(() => ({ settled: false }));
      if (!sat?.settled && this.sanctuary()) {
        // SIT ONCE AND THEN LEAVE IT ALONE.
        //
        // The pass is about a second long, so the first version of this re-sent REST
        // every second. Rowlf spent hundreds of passes "sitting down anywhere to regain
        // mana" while its mana crawled from 2 to 4, and wrote the same journal line
        // hundreds of times, which buries everything else.
        //
        // WHAT A REST ACTUALLY NEEDS is PFLAG_MOVED_SINCE_ENTRY — set by having moved
        // since arriving in the room. A character that walked in and stopped regenerates
        // nothing however long it sits, which is why settle() walks to its square rather
        // than resting where it lands. Re-sending REST every second is noise rather than
        // harm; the reason to stop doing it is that it hides whether the rest is working
        // at all, which is the question that matters and is checked below.
        //
        // So sit when we are not already sitting, and say so once. Standing up for any
        // reason clears the flag, because the next thing to do is sit again.
        const now = Date.now();
        if (!this.sittingFor || now - this.sittingFor > 60_000) {
          await s.pacer.submit('rest', () => c.rest()).catch(() => {});
          this.sittingFor = now;
          // Baseline, so the next pass can answer the only question that matters about a
          // rest: is it paying? See restWatch below.
          // Health too, not only mana. The mana reading answers "is this rest paying";
          // the health reading answers "is this square safe to be paid on", which is a
          // different question and the one the rest ledger exists for.
          this.restWatch = { at: now, mana: c.vitals?.()?.mana?.value ?? null,
                             health: c.vitals?.()?.health?.value ?? null };
          this.note('sitting down anywhere to regain mana', {
            mana: c.vitals?.()?.mana?.value ?? null, needs: 15,
            why: 'settle() found nowhere it liked, and standing regenerates mana far too ' +
                 'slowly to ever reach the 15 this needs — sitting is what matters, not where',
          });
        }
        // CHECK THAT THE REST IS ACTUALLY PAYING, rather than assuming it.
        //
        // Resting is only awarded while PFLAG_MOVED_SINCE_ENTRY is set — a character that
        // walked into a room and stopped regenerates nothing, however long it sits, and
        // nothing in its own journal would ever say so. "Sitting down to regain mana" is
        // a report of an INTENTION; the number moving is the report of an effect, and the
        // two came apart for twenty-nine consecutive rest attempts once already.
        //
        // So take a reading a few seconds after sitting and compare. If it has not moved,
        // say that plainly — the cure is to move and sit again, which is what standing up
        // and re-entering this branch does.
        if (this.restWatch && now - this.restWatch.at > 8_000) {
          const manaNow = c.vitals?.()?.mana?.value ?? null;
          // ONE LEDGER ROW PER WINDOW OF SITTING, WHEREVER WE ARE SITTING.
          //
          // This is the open-rest half of the safe-wall experiment, and it is the half that
          // matters: a rest taken IN a wall was already recorded by the hold path, and on
          // prod that path fires for nobody — 22 keepers, zero holds. Everything the fleet
          // actually does when it sits down happens here.
          //
          // Damage is the health DROP across the window; a rise is a rest working and is
          // not evidence about the square. `swung` is COMPUTED from `this.swungAt` against
          // the window start rather than asserted here: this branch is the sit-for-mana path
          // and usually nothing is being attacked, but "usually" is not a thing to hard-code.
          // When it is wrong, classify() files the row as `swung` and it stops counting,
          // which is the safe direction.
          const healthNow = c.vitals?.()?.health?.value ?? null;
          const lost = (healthNow != null && this.restWatch.health != null)
            ? Math.max(0, this.restWatch.health - healthNow) : 0;
          this.recordRestOutcome({ damage: lost, settledMs: now - this.restWatch.at,
                                   since: this.restWatch.at });
          const gained = manaNow != null && this.restWatch.mana != null
            ? manaNow - this.restWatch.mana : null;
          if (gained !== null && gained <= 0 && !this.restNotPayingAt) {
            this.restNotPayingAt = now;
            this.note('resting is not restoring anything', {
              mana: manaNow, was: this.restWatch.mana,
              seconds: Math.round((now - this.restWatch.at) / 1000),
              why: 'a rest only pays while PFLAG_MOVED_SINCE_ENTRY is set, which having ' +
                   'moved since arriving is what sets. Sitting where we landed without ' +
                   'having walked buys nothing and looks identical to resting',
              doing: 'standing and re-seating so the flag is set again' });
            this.sittingFor = null;          // let the next pass sit again, after a step
            // skills.nudge(s), NOT c.nudge() — nudge is a skill helper and the client has
            // no such method, so `c.nudge?.()` would have been an optional call on
            // undefined: silent, inert, and indistinguishable from working.
            await skills.nudge(s).catch(() => {});
          } else if (gained > 0) {
            this.restNotPayingAt = null;     // it is paying; stop watching this window
          }
          this.restWatch = { at: now, mana: manaNow,
                             health: c.vitals?.()?.health?.value ?? null };
        }
      }
      // WAITING FOR MANA IS THE PLAN, NOT A STALL. Churning the keeper restarts the
      // decision, not the wait, and that is why it never used to finish.
      const manaNow = c.vitals?.()?.mana?.value ?? 0;
      const vigorLeft = vigorOf(c.vitals?.()) ?? 0;
      // NEVER SIT WHERE YOU STAND. DELETED 2026-09-10 AT THE OPERATOR'S INSTRUCTION.
      //
      // What used to be here: if vigor was too low to cast and settle() had declined, the
      // keeper sat down on the spot, gated only on a threat snapshot reporting nothing near
      // or adjacent. It was added for a real problem — `rests: 0` across 3.6 hours, an
      // unarmed character in the Valley ending every pass on its feet in the one posture
      // that recovers nothing — and it fixed that problem by creating a worse one.
      //
      // "Nothing can reach us RIGHT NOW" is not "this is a safe place to be still". It is a
      // sample, taken once, of a room that spawns; and a rest lasts minutes. This is the
      // posture Waldorf died in four times on 2026-09-08 — `strategy: fieldrest`,
      // `in_safe_spot: false`, health 5-10 of 51 with six hostiles, the survival ladder
      // quiet throughout because resting presupposes you already walked somewhere
      // unhittable. The presupposition was the thing that was never enforced.
      //
      // THE ORDER IS: RUN TO A SAFE WALL, LOG OFF AND BACK ON, ROTATE. Sitting in the open
      // is not on the list, and the vigor is not worth it.
      if (vigorLeft < SPELL_EXERTION_VIGOR && !sat?.settled && !this.sanctuary()) {
        // ROTATE. settle() has already tried this room once and marked it done; clearing
        // that is what lets the next pass look again — and since 2026-09-10 it looks for a
        // real safe wall before it will accept a corner (see restingSquare). A room whose
        // occupancy has changed can offer a wall it could not a minute ago, and the Valley
        // holds 20 characters against 8 walls, so "no wall" is very often "no wall YET".
        this.settledIn = null;
        this.settleTries = 0;

        // LOG OFF AND BACK ON — but through playDead, which REFUSES unless we are on a wall
        // that holds, and that refusal is not mine to route around. It carries three deaths:
        // shadow fleet, Twisted Wood, 2026-08-21, three characters frozen at 4, 10 and 13
        // health in rooms of twelve to fifteen monsters, all three dead, their own journals
        // reading "recovering vigor; health needs us to move again first". A freeze recovers
        // vigor and never health, so off a wall it spends the only seconds you had. Letting
        // the verb decide means this caller cannot be the one that gets it wrong.
        if (await this.playDead('no wall to sit at, and the vigor a cast needs')
                      .catch(() => false)) return HANDLED;

        if (!this.sittingFor || Date.now() - this.sittingFor > 60_000) {
          this.sittingFor = Date.now();
          this.note('will NOT sit in the open for vigor', {
            vigor: vigorLeft, needs: SPELL_EXERTION_VIGOR,
            why: 'there is no safe wall we can reach and a freeze is refused off one. ' +
                 'Sitting here would be the fieldrest posture that killed Waldorf four ' +
                 'times, and vigor is not worth it',
            doing: 'rotating — the room seat is given up so the next pass hunts a wall again',
          });
        }
      }
      // WHICH PRECONDITION IS ACTUALLY MISSING. The two have different remedies and only
      // one returns on its own: mana regenerates while we wait, vigor needs a rest or a
      // meal. Reporting mana while vigor was the blocker is the whole bug.
      // THE THIRD BLOCKER, AND IT IS THE ONE ACTUALLY BITING. Measured on prod 2026-08-30:
      // Gonzo, Rowlf and Janice were all unarmed with vigor and mana well over the bar and
      // 40-60 bulk free against a scimitar's 70, so makeWeapon declined 3762, 3183 and 1020
      // times with `no room for the weapon` — correctly, spending nothing — while THIS line
      // still reported "unarmed — 33 mana, needs 15 to make one". Right refusal, wrong
      // reason, which sends an operator after mana that was never short. The remedy for this
      // one is not waiting at all: nothing regenerates pack space.
      const bulkFreeNow = skills.carryCapacity(c)?.room_for?.bulk ?? null;
      const lastDecl = this.lastDeclinedCast;
      const declFresh = lastDecl && lastDecl.spell === 'create weapon'
                        && Date.now() - lastDecl.at < 120_000 ? lastDecl.why : null;
      const classified = unarmedBlocker({
        vigor: vigorLeft, mana: manaNow, bulkFree: bulkFreeNow,
        vigorNeeded: SPELL_EXERTION_VIGOR, manaNeeded: 15, bulkNeeded: CONJURED_WEAPON_BULK,
        declinedWhy: declFresh });
      const blocker = classified.blocker;
      let unblockedWhy = classified.declinedWhy;
      if (blocker === 'room') {
        // AND THEN DO IT. The remedy below is "a sale, a drop or a hand-over", and the sale is
        // `bankRun` — which lives in passErrand, a rung this one never lets run, because the
        // refusal below returns HANDLED every pass. So an unarmed character with a full pack
        // was a deadlock that only ever described itself: Clifford and Rowlf stood in room 2 on
        // 2026-09-26 at 2,668 and 2,684 of 2,700 bulk, no weapon, declining a conjure every
        // second for hours, with 525 emeralds and 258 diamonds aboard that the guild chest wants.
        // Open the same trip a full pack opens (it rides the chalice home where one is on duty).
        if (await this.bankRun().catch(() => false)) return HANDLED;
        // NOT A WAIT. Vigor and mana come back on their own; pack space does not, so a
        // `waitFor` here would be a promise nothing intends to keep. Say what has to happen.
        this.doneWaiting?.();
        this.note('unarmed and cannot hold what the spell would make', {
          bulk_free: bulkFreeNow, needs: CONJURED_WEAPON_BULK,
          why: 'ReqNewHold refuses on bulk and creaweap.kod deletes the weapon after the ' +
               'mana is spent, so the cast is declined rather than thrown away',
          doing: 'nothing regenerates pack space — this needs a sale, a drop or a hand-over' });
      } else if (blocker === 'vigor') {
        this.waitFor('VIGOR_FOR_CREATE_WEAPON', {
          expectedMs: Math.max(0, SPELL_EXERTION_VIGOR - vigorLeft) * 10_000,
          why: `unarmed and too tired to cast; ${vigorLeft} of the ` +
               `${SPELL_EXERTION_VIGOR} vigor create weapon needs (spell.kod:597)` });
      } else if (blocker === 'mana') {
        this.waitFor('MANA_FOR_CREATE_WEAPON', {
          // Mana regenerates on its own timer; this is an estimate for a reader deciding
          // whether to look again, not a promise.
          expectedMs: Math.max(0, (15 - manaNow)) * 20_000,
          why: `unarmed with no donor; ${manaNow} of the 15 mana create weapon needs` });
      } else {
        // NOTHING IS SHORT, AND SAYING "MANA" HERE IS THE BUG THIS BRANCH EXISTS TO STOP.
        //
        // `blocker` enumerates the preconditions this function knows about and calls the
        // leftover case 'neither'. It then fell into the mana branch, so a character with
        // vigor, mana AND pack space all sufficient was told it needed mana — and `waitFor`
        // promised a wait that nothing would ever end, because the thing it was waiting for
        // had already happened.
        //
        // Measured on prod 2026-09-19: Animal, standing in the Bookmaker's Guild House with
        // 23 mana against a bar of 15, `stuck.seconds` 25122 — SEVEN HOURS — and
        // `repeats` 22155, refusing with "unarmed — 23 mana, needs 15 to make one". Beaker
        // the same at 25 mana. The refusal was right that the cast was declined and wrong
        // about every actionable word in it, which is worse than silence: an operator who
        // reads it goes looking for mana.
        //
        // The real reason lives in `makeWeapon` — training unarmed on purpose, every
        // conjurable banned, or a hoard of results it may not hold — and is now carried on
        // `lastDeclinedCast`. A NO WAIT is issued deliberately: none of those three ends by
        // waiting, so a `waitFor` would be the same false promise pointed at a new noun.
        this.doneWaiting?.();
      }
      // A DIFFERENT CODE WHEN NOTHING IS SHORT, BECAUSE THE SUPERVISOR READS CODES AS DATA.
      //
      // `m59-supervise.mjs` skips any character refusing UNARMED_NO_DONOR — "waiting for
      // casting mana; churning the keeper restarts the decision, not the wait" — which is
      // exactly right for a character below the bar and exactly wrong for one above it. So
      // the false 'mana' reason did not merely mislead a reader: it matched the skip and
      // DISABLED the one automated layer that would have acted. Animal sat in the
      // Bookmaker's Guild House for seven hours and 22,155 repeats inside that skip.
      //
      // Structural rather than a better sentence, because the skip is a code test and a
      // regex over prose; a new code cannot be pattern-matched back into the old branch.
      this.refuse(classified.code, {
        faculty: 'work', blocking: true,
        why: blocker === 'room'
          ? `unarmed — no room to hold one: ${bulkFreeNow} bulk free, needs ${CONJURED_WEAPON_BULK}`
          : blocker === 'vigor'
          ? `unarmed — too tired to cast: ${vigorLeft} vigor, needs ${SPELL_EXERTION_VIGOR}`
          : blocker === 'mana'
          ? `unarmed — ${manaNow} mana, needs 15 to make one`
          : `unarmed and NOTHING is short — ${vigorLeft} vigor, ${manaNow} mana, ` +
            `${bulkFreeNow} bulk free, all sufficient. The cast is being declined` +
            (unblockedWhy ? `: ${unblockedWhy}` : ' for a reason this pass could not read'),
        remedy: blocker === 'room'
          ? 'sell, drop or hand over something — waiting does not make pack space, and the ' +
            'weapon is deleted on hand-over rather than refused before the mana is spent'
          : blocker === 'vigor'
          ? 'let it rest or feed it — casting spends vigor, and vigor is what it is short of'
          : blocker === 'mana'
          ? 'hand it a weapon, or leave it alone until it can cast one'
          // WAITING IS NOT ON THE LIST, and that is the point. Every reason `makeWeapon`
          // declines for with full bars is a POLICY reason, and no policy ends by waiting.
          : 'nothing here is short, so waiting changes nothing. Either the order forbids the ' +
            'cast (training unarmed, every conjurable banned, a hoard of unusable results) ' +
            'or the character needs a weapon handed to it',
        retryAfterMs: 60_000 });
      this.noProgress(blocker === 'room'
        ? `unarmed -- ${bulkFreeNow} bulk free, needs ${CONJURED_WEAPON_BULK} to hold one`
        : blocker === 'vigor'
        ? `unarmed -- ${vigorLeft} vigor, needs ${SPELL_EXERTION_VIGOR} to cast one`
        : blocker === 'mana'
        ? `unarmed -- ${manaNow} mana, needs 15 to make one`
        // A DISTINCT SENTENCE, so `stallRepeats` counts it as its own loop and
        // STALL_NO_LEVER declares THIS rather than a mana stall that is not happening.
        : `unarmed -- nothing short, cast declined${unblockedWhy ? ': ' + unblockedWhy : ''}`);
      return HANDLED;
    }

    return CONTINUE;
  }

  // A TARGET LIST NARROWS THE DEFENSIVE DECISION. IT CANNOT MAKE ONE.
  //
  // The authority is `grudge.mayReturnFire`, which is the only place the three conditions
  // are checked together — a grudge inside the hour, the live PF_KILLER/PF_OUTLAW flag
  // read from THIS object THIS moment, and the fleetmate test — and which is written to
  // refuse by default. This function asks it about a candidate and then requires, ON TOP
  // of that, that an operator has marked the person. Composed with `&&`, so a target
  // entry can only ever subtract people from the set the defensive rules already allow.
  //
  // It was the other way round: the list alone authorised a fight, keyed on a name, with
  // no flag test, no expiry, and entries the keeper wrote about itself. That is a fleet
  // deciding on its own to attack a named human being on a shared server.
  async engagePlayerTarget() {
    const c = this.s.client;
    if (!c) return false;
    const v = c.vitals?.();
    const hp = pct(v?.health);
    const safe = this.safety();
    if (hp !== null && hp < safe.engageAt) return false;

    const myName = c.me?.name ?? this.s?.name ?? this.who();
    const tList = targetsFor(myName);
    if (!tList.length) return false;

    const roomObjs = c.room?.objects;
    if (!roomObjs) return false;

    for (const tEntry of tList) {
      const tName = tEntry.name;
      const found = [...roomObjs.values()].find(o =>
        o.id !== c.selfId && (o.flags & OF.PLAYER) && (o.flags & OF.ATTACKABLE) &&
        (c.rsc.get(o.nameRsc) || '') === tName);
      if (!found) continue;
      // The server has already refused us this person in this room (guild-only): move on.
      if (refusedHere(this.s, tName)) continue;
      // Outside pvp_rooms a marked target is left alone too (m59-pvp-rooms.mjs).
      if (!pvpAllowedHere(this.policy, this.s.world?.room?.num)) {
        if (this.pvpRoomsTargetNoted !== `${this.s.world?.room?.num}|${tName}`) {
          this.pvpRoomsTargetNoted = `${this.s.world?.room?.num}|${tName}`;
          this.note('marked as a target, and left alone: outside pvp_rooms', {
            target: tName, room: this.s.world?.room?.num ?? null, pvp_rooms: pvpRoomsOf(this.policy) });
        }
        continue;
      }

      // THE GATE. Refused for anyone who has not attacked us inside the hour, for anyone
      // the server does not currently call a murderer or an outlaw, and for one of ours.
      const verdict = grudge.mayReturnFire({ name: tName, flags: found.flags },
                                           { fleetmate: party.isFleetmate(tName) });
      if (!verdict.engage) {
        this.note('marked as a target, and left alone', {
          target: tName, why: verdict.why,
          because: 'the target list narrows what self-defence already permits; it never ' +
                   'permits anything on its own',
        });
        continue;
      }

      this.note('engaging player target', {
        target: tName, id: found.id, room: this.s.world?.room?.num,
        health: hp == null ? null : Math.round(hp * 100) + '%',
        why: verdict.why,
        and: 'an operator marked this person auto_attack, which is why this is the one ' +
             'being fought rather than merely defended against',
      });

      // DECLARED BEFORE THE SWING, NOT AFTER IT. A conflict is what the rest of the fleet
      // converges on, and one published after the fight ends is an invitation to walk to
      // a room where nothing is happening any more. It is declared HERE, past the gate,
      // so the only thing anyone can be called to is a fight `mayReturnFire` allowed.
      const roomNum = this.s.world?.room?.num ?? null;
      declareConflict(myName, tName, roomNum);

      const f = await skills.fight(this.s, {
        target: tName, exactTargetId: found.id, includePlayers: true,
        rounds: this.policy.fightRounds ?? 30, disengageAt: safe.fleeAt,
        loot: false, holdPosition: !!this.hold, reach: REACH,
        ...(this.touchTrainingHere() ? { equip: false } : {}),
        weaponPriority: this.weaponPriorityNow(),
        bannedWeapons: this.bannedWeaponsNow(),
      }).catch(e => ({ killed: false, died: false, note: e.message }));

      if (f.killed) {
        recordTargetKill(myName, tName);
        clearConflict(tName);
        this.note('killed player target', { target: tName });
        this.progress('killed a player target');
      } else if (f.died) {
        clearConflict(tName);
        this.noProgress('died fighting a player target');
      } else {
        // BROKEN OFF IS NOT STILL FIGHTING. Left declared, the conflict keeps calling
        // fleetmates to a room the fight has already left — and a character arriving
        // alone at a murderer it did not choose is the worst version of this feature.
        // It is re-declared the moment the fight resumes, which costs nothing.
        clearConflict(tName);
        this.note('broke off player target engagement', { target: tName, why: f.note });
        this.noProgress('broke off from player target');
      }
      return true;
    }
    return false;
  }

  async respondToConflict() {
    const c = this.s.client;
    if (!c) return false;

    const vit   = c.vitals?.();
    const hp    = pct(vit?.health);
    const level = vit?.health?.max ?? 0;
    if (level <= 30) return false;
    if (hp !== null && hp < this.safety().engageAt) return false;

    const comm = this.commitment();
    if (comm && comm.takeable === false) return false;

    const myRoom    = this.s.world?.room?.num ?? null;
    const conflicts = activeConflicts();
    if (Object.keys(conflicts).length === 0) return false;

    const myName  = c.me?.name ?? this.s?.name ?? this.who();
    // FIVE HOPS, AND THE LIMIT IS REAL THIS TIME.
    //
    // It was `?? 0`, and zero meant "skip the check" — which then fell through to a
    // travel with `maxHops: 50`, i.e. anywhere in the world. Worse, the check it was
    // skipping could not have worked: `findPath(myRoom, cf.room, {maxHops})` passes the
    // room number where the MAP goes (m59-map.mjs:695 is `findPath(map, from, to, opts)`)
    // and the real function returns `{found, hops}`, so `path.length > maxHops` was
    // `undefined > n` — false for every value, for every route, always.
    //
    // Five is "the next few rooms", the same neighbourhood a courier delivers into. A
    // fleet crossing the world to join a fight is a fleet that has stopped doing its job
    // and started doing something that looks, from outside, like organised pursuit.
    const maxHops = Math.max(1, Number(this.policy.conflict_response_hops ?? 5) || 5);
    const map = this.s.world?.map;

    // ONLY OUR OWN PEOPLE MAY CALL US OUT OF A ROOM.
    //
    // This filtered on `cf.reporter !== myName` — "not me" — and nothing else, so any name in
    // the book could move this character. The book was one file for the whole machine and two
    // fleets run here, which is how, on 2026-08-27, ten SHADOW characters that had just
    // arrived at Outside Castle Victoria left it within two seconds of each other and walked
    // into Ukgoth because a PROD character was fighting. The journal said it outright:
    // "Scooter is fighting Morpheus — travelling to assist". Scooter is prod; Aaaa is shadow;
    // different accounts, different servers.
    //
    // The file is per fleet now and the records carry a fleet, and this is still checked
    // here, because those two are facts about STORAGE and this is the behaviour: answering a
    // stranger's call is wrong even when the stranger's call is in the right file. It is the
    // same rule `m59-follow.mjs` already applies to "follow me" — the speaker is checked
    // against the ROSTER rather than against the text — and for the same reason: this moves
    // bodies, on a shared server, and a stranger who knows one of our names must not be able
    // to do it.
    //
    // `party.isFleetmate` is the one answer to "is this one of ours", backed by the live
    // sessions unioned with the roster the broker actually loaded. Absent it, this refuses
    // rather than assumes — a keeper that cannot tell its own people from strangers has no
    // business crossing rooms on their behalf.
    const knowsOurOwn = typeof party?.isFleetmate === 'function';
    const candidates = Object.values(conflicts)
      .filter(cf => cf.reporter !== myName && cf.room !== myRoom
                    && knowsOurOwn && party.isFleetmate(cf.reporter)
                    // A fight in a room this character may not fight in is not one to walk to.
                    && pvpAllowedHere(this.policy, cf.room))
      .sort((a, b) => b.updated_at - a.updated_at);

    if (!candidates.length) return false;

    for (const cf of candidates) {
      // NEAR ENOUGH? Asked of the graph, and a route it cannot find is not a route we
      // walk. `map` missing means the world has not been read yet, which is "cannot say"
      // and therefore no.
      if (!map || myRoom == null || cf.room == null) return false;
      const path = findPath(map, myRoom, cf.room);
      if (!path?.found || path.hops.length > maxHops) continue;

      this.note('converging on conflict', {
        target: cf.target, conflict_room: cf.room, reporter: cf.reporter,
        why: `${cf.reporter} is fighting ${cf.target} — travelling to assist`,
        hops: path.hops.length, max_hops: maxHops,
      });
      this.doing = 'converging';

      const tResult = await this.travel(cf.room, { origin: keeperOrigin('conflict_response'), maxHops })
        .catch(() => ({ arrived: false }));

      if (!(tResult?.arrived)) {
        this.note('could not reach conflict room', { room: cf.room, target: cf.target });
        return false;
      }

      this.progress('arrived at conflict room');
      return true;
    }
    return false;
  }

  // ── passPlaybook: extracted from pass() ────────────────────────────────
  async passPlaybook(ctx) {
    // 1.9 THE THREE MOMENTS THE FLEET'S DIRECTOR MAY HAVE AN OPINION ABOUT.
    //
    //     ABOVE the danger ladder, because a player attacking us is the one case where
    //     the ladder is answering the wrong question — it will flee to a wall, which
    //     works on a monster and does nothing at all about somebody who can follow. And
    //     BELOW identity, mortality and the unarmed gate, which are not anybody's to
    //     redirect.
    //
    //     Free when nothing is declared: playbookFor is a stat() against an mtime cache,
    //     decide() is a loop over a list that is usually absent, and every one of these
    //     returns null in that case — leaving the ladder below to run exactly as it did
    //     before this existed.
    await this.consultPlaybook();

    // 1b. PLAYER TARGET. If an intel auto-attack target is in the room and we are
    //     healthy enough to engage, fight them now -- before the survival ladder and
    //     before normal farming. This is opt-in per target (auto_attack flag) and
    //     gated on being above the engage threshold so a hurt character retreats first.
    if (await this.engagePlayerTarget()) return HANDLED;

    // 1c. CONFLICT RESPONSE. If another fleet member has declared a conflict with a
    //     target player, eligible characters (level > 30, healthy, uncommitted) travel
    //     to that room to assist. engagePlayerTarget fires on arrival.
    if (await this.respondToConflict()) return HANDLED;
    return CONTINUE;
  }

  // ── passFightBack: the fight-back edict, answered on the pass ─────────────
  //
  // The watchdog counted the seconds and pulled the handbrake; this is the answer. See the
  // note above `fightBackAfterMs` for the order and the argument. Everything it swings at
  // goes through the same `skills.fight` and the same bookkeeping as passFarm's kill path,
  // so a kill earned here is a kill on the ledger and a max-health gain is attributable.
  //
  // Overridable seam for the offline test: the real thing is `skills.fight`.
  // A touch-spell trainer on its own ground fights BARE in every fight — a blocker, a fight-back,
  // a lever — because equip:true would wield the best weapon in the pack and swing it instead of
  // the touch. `equipBest` vetoes it too; this keeps the fight from even asking.
  fightNow(opts) {
    const o = (this.touchTrainingHere() && opts?.equip === undefined) ? { ...opts, equip: false } : opts;
    return skills.fight(this.s, o);
  }

  // THE NEAREST THING IN REACH THAT WE WOULD FIGHT ANYWAY, and why each of the others is refused. "Smaller than you"
  // is the fleet's engagement band — see the note above fightBackAfterMs for why not the level. Shared with the
  // watchdog's `fightBackCheck`, which must not cancel a walk for a fight this list will refuse.
  fightBackRows(c, onUs, roomNum) {
    const me = c?.self;
    if (!me) return [];
    return onUs.map(o => {
      const name = c.rsc.get(o.nameRsc) || '';
      return { o, name, d: Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row),
               refused: !name ? { why: 'it has no name' }
                 : (o.flags & OF.PLAYER) && refusedHere(this.s, name)
                   ? { why: 'the server refused us this player in this room (guild-only)' }
                 // pvp_rooms: a PLAYER is never fought back outside the listed rooms; monsters are.
                 : (o.flags & OF.PLAYER) && !pvpAllowedHere(this.policy, roomNum)
                   ? { why: 'outside pvp_rooms: players are not fought back in this room' }
                 // A SPARED MONSTER IS NEVER THE PICK: the swing would be refused at the packet, the
                 // pass spent on nothing, and a fightable body behind it never chosen.
                 : this.sparedHere(o) ? { why: 'spared (spare_creatures)' }
                   : this.refuseEngagement(name) };
    }).sort((x, y) => x.d - y.d);
  }

  async passFightBack(ctx) {
    const { s, c, room, v, hp } = ctx;
    const edict = this.fightBackAfterMs();
    // A BLOCKED DUE IS NOT THE DAMAGE EDICT AND MUST NOT BE GATED ON IT. `fight_back_after_s: 0`
    // says "do not swing back when hit"; it says nothing about a creature standing in the
    // walk, which is a different permission with its own faculty (`clear_path`). Gating both
    // on one number is how a switch comes to mean two things.
    if (!edict && this.fightBackDue?.reason !== 'blocked') return CONTINUE;
    const w = this.watch, a = w?.attack ?? null;
    const now = Date.now();
    // FLEEING OUTRANKS THIS -- WHEN THERE IS A FLEE LEFT. Below the line the survival ladder is the next stage and it is
    // the right one, unless every flee it owns has already been asked here and said no (spentAndCornered: the healing
    // session's one logoff spent, no reachable refuge, the exit just tried from this room). Then this is the only rung
    // that changes anything, and stepping aside is standing still being hit: Scooter (t21), Ko'catan 2125, 2026-10-27,
    // 79 s at r17c1 without a swing while a dragonfly on the exit square took him from 49 to 0. Cornered, it swings one
    // exchange per pass (rounds 1, no disengage line -- there is nowhere to disengage to), so the exit and the refuge are
    // asked again between swings, and it does not wait for the edict's window to re-arm after each one.
    const fleeAt = this.safety().fleeAt;
    const belowFlee = hp != null && hp < fleeAt;
    const cornered = belowFlee && !!this.spentAndCornered?.();
    // Either the watchdog asked, or the episode is old enough that it would have on its next
    // tick — a pass that arrives first should not wait half a second to be told.
    const due = this.fightBackDue
      ?? (a && (now - a.since >= edict || cornered) ? { since: a.since, hits: a.hits, lost: a.lost, at: now } : null);
    if (!due) return CONTINUE;
    this.fightBackDue = null;
    if (now - due.at > FIGHT_BACK_STALE_MS) return CONTINUE;
    // An errand owns the body; the inert rescue in the watchdog covers bleeding under one.
    if (this.inert) return CONTINUE;
    if (belowFlee && !cornered) return CONTINUE;
    if (!skills.isArmed(c)) return CONTINUE;          // passArm's problem, and it ran already
    const me = c?.self;
    if (!me) return CONTINUE;
    const onUs = this.inReachOfUs();
    if (!onUs.length) { if (w) w.attack = null; return CONTINUE; }

    const rows = this.fightBackRows(c, onUs, room?.num ?? this.s.world?.room?.num);
    const pick = rows.find(r => r.name && !r.refused);
    const underFor = Math.round((now - due.since) / 1000);
    if (!pick) {
      this.note('under attack and not swinging, but nothing on us is inside the band', {
        under_attack_s: underFor, in_reach: rows.map(r => r.name || '?').slice(0, 4),
        why: rows[0]?.refused?.why ?? 'no target',
        instead: 'the ordinary ladder — which walks away from what it will not fight',
      });
      return CONTINUE;
    }
    this.note('FIGHT BACK — under attack for ' + underFor + 's and getting nowhere', {
      target: pick.name, distance: +pick.d.toFixed(1), hits_taken: due.hits, lost: due.lost,
      was_doing: this.doing ?? null, from_safe_spot: !!this.hold,
      why: cornered
        ? 'below the flee line with nothing left to flee with: the session logoff is spent, no refuge is reachable ' +
          'and the exit was just tried -- one exchange at what is hitting us, then the exit is asked again'
        : 'the fight-back edict: something inside our band has been hitting us for longer ' +
          'than ' + Math.round(edict / 1000) + 's while we were not swinging',
      ...(cornered ? { cornered: true } : {}),
    });
    this.tally.fight_backs = (this.tally.fight_backs || 0) + 1;
    this.ledgerEvent('fought_back', {
      creature: pick.name, room: room?.name ?? null, room_num: room?.num ?? null,
      under_attack_s: underFor, hits_taken: due.hits, lost: due.lost,
      was_doing: this.doing ?? null, from_safe_spot: !!this.hold,
      ...(cornered ? { cornered: true } : {}),
    });
    const holding = !!this.hold;
    this.doing = 'fighting';
    const f = await this.fightNow({
      target: pick.name, preferId: pick.o.id, exactTargetId: pick.o.id,
      rounds: cornered ? 1 : (this.policy.fightRounds ?? 10), disengageAt: cornered ? 0 : fleeAt, loot: true,
      holdPosition: holding || cornered, reach: REACH, weaponPriority: this.weaponPriorityNow(),
      bannedWeapons: this.bannedWeaponsNow(),
    }).catch(e => ({ fought: false, killed: false, died: false, note: e.message }));
    // The clock restarts either way: ten more seconds of being hit re-arms it.
    if (w) w.attack = null;

    const looted = (f.looted || []).map(x => x.name + (x.amount ? ` x${x.amount}` : ''));
    if (f.killed) {
      releaseQuarry(this.s.name);
      this.tally.kills++;
      this.killTimes.push(Date.now());
      if (this.killTimes.length > 500) this.killTimes.shift();
      this.farmStrategyHook('onKill', { creature: f.target, room: room?.num ?? null, looted });
      tougher.recordKill(this.who(), {
        creature: f.target, room: room?.name ?? null, room_num: room?.num ?? null,
        level: v?.health?.max ?? null, rounds: f.rounds, looted, from_safe_spot: holding,
      });
      this.ledgerEvent('killed', {
        creature: f.target, room: room?.name ?? null, room_num: room?.num ?? null,
        rounds: f.rounds, from_safe_spot: holding, fought_back: true,
        looted: looted.length ? looted.join(', ') : undefined,
      });
      this.fledInARow = 0;
      this.progress('fought back and killed it');
    } else if (f.died) {
      releaseQuarry(this.s.name);
      this.noProgress('died fighting back');
    } else if (partialFightMadeProgress(f)) {
      this.progress('fought back and landed a hit');
    } else {
      this.noProgress('fought back without landing a hit');
    }
    this.countLoot(looted);
    await this.wearLootedArmour(looted);
    return HANDLED;
  }
  // @end 1
}
