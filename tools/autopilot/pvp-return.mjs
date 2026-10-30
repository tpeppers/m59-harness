// AFTER A PVP DEATH: whether a journey ended in a death, and when it is safe to go back to the farm.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 8 methods: journeyEndedInADeath, pvpHoldKey, pvpDeathRecord, pvpReturnHold,
//   classifyAndRememberPvp, isFarmingDestination, pvpReturnGate, holdOffTheFarm
import { recordEvent } from '../m59-ledger.mjs';
import * as party from '../m59-party.mjs';
import { classifyPvpDeath, pvpHoldState, pvpReturnDelayMs, readPvpDeath, writePvpDeath } from '../m59-pvp-return.mjs';
import { loadSpawns } from '../m59-spawns.mjs';
import { rememberedEnemy } from '../m59-war.mjs';
import { CONTINUE, HANDLED, SPAWN_FILE } from '../m59-autopilot.mjs';

export class PvpReturnPart {
  // @part 1

  // A DEATH ENDS THE JOURNEY — AND THIS IS THE ONLY COPY OF THAT RULE.
  //
  // Four different places suspend an objective: the travel job's `finally`, the watchdog's
  // rescue of a stalled driver, a guard take-back, and the resume itself. The rule was first
  // written into ONE of them, and shadow02 duly came back from the Cragged Mountains still
  // carrying `{to: 38, trigger: 'the watchdog rescued a stalled driver'}` twelve minutes
  // after being killed by a troll, because the death had arrived through a different door
  // than the one the rule was nailed to.
  //
  // So it lives here, on the keeper, and is called from the moment a death is DISCOVERED
  // rather than from whichever path happened to end the walk. Everything that suspends a
  // journey is upstream of waking up dead.
  //
  // `travel_deaths_allowed` is the whole policy: nought — the default — is "a death is a
  // failed journey", and higher is a road worth dying for. Per OBJECTIVE, not per lifetime,
  // because `tally.deaths` belongs to a keeper and keepers restart about once a minute.
  journeyEndedInADeath(where = 'a death') {
    const dest = Number(this.suspendedJourney?.to ?? this.inert?.to ?? NaN);
    if (!Number.isFinite(dest)) { this.journeyDeaths = null; return null; }

    const allowed = Number(this.policy?.travelDeathsAllowed ?? 0);
    const book = this.journeyDeaths;
    const spent = (book && Number(book.to) === dest ? Number(book.count) : 0) + 1;
    this.journeyDeaths = { to: dest, count: spent };

    if (spent <= allowed) {
      // The resting is not optional and is not enforced here: `passUnderworld`'s recovery
      // hold is the FIRST rung and the resume is in the LAST, so a retry physically cannot
      // start before health, mana and vigor are back.
      this.note('died on the way, and this road is worth another try', {
        to: dest, deaths_on_this_objective: spent, allowed, discovered_at: where,
        what_happens_first: 'out of the Underworld and rest to whole',
      });
      return { kept: true, spent, allowed };
    }

    this.suspendedJourney = null;
    this.journeyDeaths = null;
    this.note('the journey ended in a death, so it is not resumed', {
      to: dest, deaths_on_this_objective: spent, allowed, discovered_at: where,
      what_happens_now: 'out of the Underworld, then rest at the inn it lands in',
      why: allowed === 0
        ? 'a death is a failed journey. Whatever killed the character is still on that road, ' +
          'everything carried is on the floor where it fell, and max health has already been ' +
          'paid for the trip'
        : `this objective has now cost ${spent} death(s) against an allowance of ${allowed}`,
    });
    return { kept: false, spent, allowed };
  }

  // ------------------------------------------------------------ THE PVP RETURN DELAY
  //
  // "set it so that there's a 30m PVP delay on returning to any farming zone" — the operator,
  // 2026-09-30, after Morpheus (Human Resistance) camped Castle Victoria's front door, the Tos
  // gate and Outside Castle Victoria and killed respawned characters one at a time as each
  // walked straight back: five deaths in twenty minutes, every one from full health. A monster
  // does not wait at the door for you. A person does.
  //
  // So a death to a PLAYER starts a window (`pvp_return_delay_ms`, default 30 minutes, 0
  // disables) in which this keeper will not START a journey to a farming room. It rests where
  // it recovered — normally the inn the Underworld portal dropped it in, which is
  // ROOM_NO_COMBAT, so nobody can touch it there.
  //
  // WHAT IT DOES NOT BLOCK, deliberately, because each is a protected faculty or somebody
  // else's decision: the Underworld exit (a portal walk, never `travel`), the post-escape walk
  // to a sanctuary (a sanctuary is not a farming room), fleeing and every recovery detour
  // (`recoveryTravel` — survival), an EXPLICIT travel order (the broker's `travel` tool and
  // FleetScript arrive through `travelJob`, which marks them), and anything while the movement
  // faculty is leased or an outside operation holds the character busy — THE LEASE HOLDER
  // DECIDES THE DESTINATION, the same rule `passFarm` applies to every other directional
  // choice. Monster deaths are unchanged. m59-pvp-return-test.mjs pins all of it.

  // The key the persisted record is filed under: the roster slot, which survives a restart and
  // a rename of nothing. The character name is the fallback for a shell with no slot.
  pvpHoldKey() { return this.s?.name ?? this.who(); }

  // Read once per process, then kept in memory; this keeper is the only writer of its file.
  pvpDeathRecord() {
    if (this.pvpDeath === undefined) {
      try { this.pvpDeath = readPvpDeath(this.pvpHoldKey()); } catch { this.pvpDeath = null; }
    }
    return this.pvpDeath;
  }

  /** The live hold, or null: {until, killer, killers, remaining_s, died_at, delay_ms, basis}. */
  pvpReturnHold(now = Date.now()) {
    return pvpHoldState(this.pvpDeathRecord(), pvpReturnDelayMs(this.policy), now);
  }

  // Classify a death as PvP or not, stamp the answer on the death record (so the post-mortem
  // says so), and — when it was a player — persist the time so a restart inside the window
  // still holds. Never throws: this runs inside the death report, whose failure would stop
  // the Underworld escape.
  classifyAndRememberPvp(death, { attribution = null, text = [], frames = [] } = {}) {
    let v;
    try {
      v = classifyPvpDeath({ character: this.who(), deathAt: death?.at, attribution, text, frames,
        attacks: this.playerAttacks ?? [], isFleetmate: n => party.isFleetmate(n), enemy: n => rememberedEnemy(n) });
    } catch (e) {
      try { this.note('could not classify the death as PvP or not', { why: e?.message ?? String(e) }); } catch {}
      return null;
    }
    Object.assign(death, { pvp: v.pvp, pvp_killers: v.killers, pvp_basis: v.basis, pvp_why: v.why });
    if (!v.pvp || !Number.isFinite(Number(death?.at))) return v;
    const prev = this.pvpDeathRecord();
    if (prev && Number(prev.died_at) >= Number(death.at)) return v;
    const rec = { died_at: Number(death.at), killers: v.killers, basis: v.basis, why: v.why,
                  died_in: death.died_in ?? null, room_num: death.room_num ?? null };
    this.pvpDeath = rec;
    this.pvpHoldNoted = null;
    this.pvpGateNoted = null;
    try { writePvpDeath(this.pvpHoldKey(), rec); }
    catch (e) {
      this.note('could not persist the PvP death', { why: e?.message ?? String(e),
        what_it_costs: 'the hold still applies in this process; a keeper restart inside the ' +
                       'window would forget it' });
    }
    const hold = this.pvpReturnHold();
    this.note('killed by a player — holding off the farm', {
      killers: v.killers, basis: v.basis, evidence: v.why,
      delay_s: Math.round(pvpReturnDelayMs(this.policy) / 1000),
      until: hold ? new Date(hold.until).toISOString() : null,
      why: 'a player who camps the road kills each character again as it walks straight ' +
           'back; resting out the window where it recovers costs nothing but time',
    });
    try { recordEvent(this.who(), 'pvp_return_hold_started', { killers: v.killers, basis: v.basis,
      died_at: rec.died_at, until: hold?.until ?? null, room: rec.room_num }); } catch {}
    return v;
  }

  // A FARMING ROOM is one the spawn table says generates something huntable — the same test
  // `sanctuary()` inverts — or this farmer's explicit assignment. Towns, inns and the monster-
  // free retreats are not, so a walk to one of those is never held.
  isFarmingDestination(room) {
    const num = Number(room);
    if (!Number.isFinite(num)) return false;
    if (this.mode === 'farm' && this.policy?.assignedRoom != null
        && Number(this.policy.assignedRoom) === num) return true;
    const here = loadSpawns(SPAWN_FILE)?.rooms?.[num] || [];
    return here.some(x => x.huntable);
  }

  // THE GATE, asked by `travel()` for every keeper journey. Null means go; otherwise the
  // refusal `travel()` returns. See the block comment above for what is exempt and why.
  pvpReturnGate(room, { explicitOrder = false, recoveryDetour = false } = {}) {
    const hold = this.pvpReturnHold();
    if (!hold || explicitOrder || recoveryDetour) return null;
    if (this.busyStatus?.() || this.facultyHeld?.('movement')) return null;
    if (!this.isFarmingDestination(room)) return null;
    this.tally.pvp_return_refusals = (this.tally.pvp_return_refusals || 0) + 1;
    const key = `${hold.died_at}:${Number(room)}`;
    const why = `killed by ${hold.killer ?? 'a player'} ${Math.round((Date.now() - hold.died_at) / 60_000)}m ` +
                `ago; not returning to a farming room for another ${Math.ceil(hold.remaining_s / 60)}m`;
    if (this.pvpGateNoted !== key) {
      this.pvpGateNoted = key;
      this.note('not returning to a farming room yet — PvP return delay', {
        wanted: Number(room), here: this.s.world?.room?.num ?? null, killer: hold.killer,
        remaining_s: hold.remaining_s, until: new Date(hold.until).toISOString(),
        why: 'pvp_return_delay_ms: the operator\'s order after a player camped the farm ' +
             'entrances and killed each character as it walked back' });
      try { recordEvent(this.who(), 'pvp_return_hold_refused_travel', { wanted: Number(room),
        room: this.s.world?.room?.num ?? null, killer: hold.killer, remaining_s: hold.remaining_s }); } catch {}
    }
    return { arrived: false, refused: true, pvp_hold: true, reason: why, why,
             until: hold.until, remaining_s: hold.remaining_s };
  }

  // THE RUNG, at the top of `passFarm`: inside the window, a character standing somewhere
  // safe stays there and rests rather than choosing work. A character already standing in a
  // farming room is not moved by this — the ordinary pass works the room it is in and the
  // gate in `travel()` stops it setting off for another one.
  async holdOffTheFarm(ctx) {
    const hold = this.pvpReturnHold();
    if (!hold) {
      if (this.pvpHoldNoted) {
        this.note('the PvP return delay is over — back to work', { died_at: this.pvpHoldNoted });
        this.pvpHoldNoted = null;
      }
      this.pvpHoldingNow = false;
      return CONTINUE;
    }
    const room = ctx?.room ?? this.s.world?.room;
    if (this.facultyHeld('movement') || (room && !this.sanctuary(room))) {
      this.pvpHoldingNow = false;
      return CONTINUE;
    }
    this.pvpHoldingNow = true;
    if (this.pvpHoldNoted !== hold.died_at) {
      this.pvpHoldNoted = hold.died_at;
      this.note('resting out the PvP return delay', {
        room: room?.name ?? null, room_num: room?.num ?? null, killer: hold.killer,
        remaining_s: hold.remaining_s, until: new Date(hold.until).toISOString(),
        why: 'killed by a player; farming rooms are off limits until the window closes' });
    }
    await this.hibernate('resting out the PvP return delay').catch(() => false);
    this.progress(`holding off the farm after a PvP death — ${Math.ceil(hold.remaining_s / 60)}m left`);
    return HANDLED;
  }
  // @end 1
}
