// ROOM 2600'S LEVER PUZZLE.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 13 methods: leverPuzzleVia, leverPuzzleHandoff, leverClaimsFile, leverPuzzleStatus,
//   leaveLeverPuzzle, passLeverPuzzle, leverPuzzleObjects, leverWalk, leverFight, leverIdle,
//   watchLeverDoor, recordLeverDecision, leverPuzzleStep
import { STATUS as LEVER_STATUS, PULL_BEAT_MS, PULL_LEAD_MS, agreeBeat, chebyshev, claimLever, claimLeverOnDisk, claimsFile, decideLeverStep, doorState, finalFoes, heldLever, inFinalZone, leverPuzzleFor, markReady, nextApproachLeg, partnerReady, puzzleBlocksJourney, readClaims, releaseLevers, trustedDoorHeights, updateClaims } from '../m59-leverpuzzle.mjs';
import { OF } from '../m59-parse.mjs';
import { PLAYER_REACH } from '../m59-safespots.mjs';
import * as tougher from '../m59-tougher.mjs';
import { CONTINUE, HANDLED, sleep } from '../m59-autopilot.mjs';

export class LeverPuzzlePart {
  // @part 1

  // ------------------------------------------------------------ THE LEVER PUZZLE (room 2600)
  //
  // Operator, 2026-09-30: travel to Marion crypt 2 (2601) has to be "basically automatic", and
  // 2600 stands in the way of every such journey: two levers pulled inside two seconds open the
  // final door, the final area has to be cleared with a player inside it, and only then does the
  // well down to 2601 open (m59-leverpuzzle.mjs has the kod). No single walk does that and no
  // single character can, so the journey HANDS THE BODY TO THIS RUNG — `travel` returns
  // `handed_off` in 2600 rather than walking at a shut well — and the rung works the puzzle one
  // bounded step per pass, below survival, fight-back and fleeing, which keep their turns.
  //
  // WHAT BINDS A CHARACTER TO IT: a journey this keeper was given to 2601 (`leverPuzzleBound`),
  // a suspended one, or the assignment. A character already in 2601 never comes back up: the
  // rung only runs while the world says the body is IN 2600.
  //
  // IT NEVER FIGHTS A PLAYER. Every swing goes through `fightNow` with the creature-only default
  // and an `avoid` that refuses players as well — PvP belongs to the war response.

  /** Why this character is working the puzzle in `puzzle`'s room, or null if it is not. */
  leverPuzzleVia(puzzle) {
    if (!puzzle) return null;
    if (this.leverPuzzleBound && Number(this.leverPuzzleBound.to) === puzzle.to) return 'travel';
    if (Number(this.suspendedJourney?.to) === puzzle.to) return 'journey';
    // An assignment is a FARMING order; a keeper told to idle is not walked into a puzzle by it.
    if (this.policy?.assignedRoom != null && Number(this.policy.assignedRoom) === puzzle.to
        && (this.mode ?? 'farm') === 'farm') return 'assignment';
    return null;
  }

  /**
   * The journey half: called by `travel` (before it walks) and by the Session's hop loop (as
   * `handOffAt`). True means "this room is worked, not walked" and binds the character to it.
   */
  leverPuzzleHandoff(here, to) {
    // A journey anywhere else is a new order, and it ends the old binding.
    if (this.leverPuzzleBound && Number(to) !== Number(this.leverPuzzleBound.to)) this.leverPuzzleBound = null;
    if (!puzzleBlocksJourney(here, to)) return null;
    const puzzle = leverPuzzleFor(here);
    if (!this.leverPuzzleBound || Number(this.leverPuzzleBound.to) !== puzzle.to) {
      this.leverPuzzleBound = { to: puzzle.to, room: puzzle.room, since: Date.now() };
      this.note('the journey hands the body to the lever puzzle', {
        room: puzzle.room, to: puzzle.to,
        why: `room ${puzzle.room} opens only to two characters pulling its levers inside ` +
             `${puzzle.windowMs} ms and a cleared final area; the keeper works it pass by pass`,
      });
    }
    return { arrived: false, paused: true, handed_off: true, puzzle: puzzle.room,
             room: { num: puzzle.room, name: puzzle.name },
             reason: `room ${puzzle.room} is a two-person lever puzzle, worked by the keeper` };
  }

  leverClaimsFile() { return this.policy?.leverClaimsFile ?? claimsFile(); }

  /** For `status()`. Null when no puzzle is being worked. */
  leverPuzzleStatus() {
    const st = this.leverPuzzleState;
    if (!st) return null;
    return { room: st.room, to: st.to, via: st.via, phase: st.phase, why: st.why,
             lever: st.lever ?? null, door: st.door ?? null, well: st.well ?? null,
             waiting: st.phase === 'wait_partner' ? LEVER_STATUS.wait_partner
                    : st.phase === 'wait_hall' || st.phase === 'wait_cycle' ? LEVER_STATUS[st.phase] : null,
             waiting_since: st.waitingSince ?? null, since: st.since, pulls: st.pulls ?? 0 };
  }

  /** Let go of the puzzle: release the lever on disk and forget the visit. */
  leaveLeverPuzzle(roomNum, why = 'left the room') {
    const st = this.leverPuzzleState;
    const arrived = !!st && Number(roomNum) === Number(st.to);
    if (st) {
      try { updateClaims(book => releaseLevers(book, { room: st.room, agent: this.who() ?? this.s.name }),
                         { file: this.leverClaimsFile() }); }
      catch (e) { this.note('could not release the lever claim', { why: e.message }); }
      this.note(arrived ? 'through the lever puzzle' : 'left the lever puzzle', {
        room: st.room, to: st.to, now_in: Number(roomNum) || null, why, via: st.via,
        took_ms: Date.now() - (st.since ?? Date.now()), pulls: st.pulls ?? 0 });
      this.ledgerEvent?.(arrived ? 'lever_puzzle_through' : 'lever_puzzle_left', {
        room: st.room, to: st.to, now_in: Number(roomNum) || null, via: st.via,
        took_ms: Date.now() - (st.since ?? Date.now()), pulls: st.pulls ?? 0 });
    }
    // A journey that has arrived is finished; one that ended elsewhere (a death, a flight, a
    // new order) is not ours to keep re-issuing — whoever gave it can give it again.
    if (this.leverPuzzleBound) this.leverPuzzleBound = null;
    if (arrived && Number(this.suspendedJourney?.to) === Number(st.to)) this.suspendedJourney = null;
    this.leverPuzzleState = null;
    this.leverPuzzleVisit = null;
  }

  async passLeverPuzzle(ctx) {
    const s = this.s;
    const roomNum = Number(s.world?.room?.num);
    const puzzle = leverPuzzleFor(roomNum);
    if (!puzzle) {
      // Out of the room — through the well, or anywhere else. Either way the lever is not ours.
      if (this.leverPuzzleState || this.leverPuzzleBound) this.leaveLeverPuzzle(roomNum);
      return CONTINUE;
    }
    const via = this.leverPuzzleVia(puzzle);
    if (!via) {
      if (this.leverPuzzleState) this.leaveLeverPuzzle(roomNum, 'no longer bound for ' + puzzle.to);
      return CONTINUE;
    }
    // AN ASSIGNMENT IS THE KEEPER'S OWN CHOICE OF DESTINATION, SO A MOVEMENT LEASE OUTRANKS IT.
    // A journey somebody ORDERED (travel, possibly by that same lease holder) is the order
    // itself, and working the puzzle is how it is carried out.
    if (via === 'assignment' && this.facultyHeld?.('movement')) return CONTINUE;
    // AND THE PVP RETURN DELAY HOLDS IT THE SAME WAY IT HOLDS travel(). An assignment or a
    // suspended keeper journey is the keeper's own choice, so a character killed by a player
    // is not walked into the crypt by either until the window ends. A journey somebody ORDERED
    // ('travel') was already let through the gate in travel() (explicitOrder), and is worked.
    if (via !== 'travel' && this.pvpReturnGate?.(puzzle.to)) return CONTINUE;
    return this.leverPuzzleStep(puzzle, via);
  }

  /** The room's objects as plain rows, for the pure decisions. */
  leverPuzzleObjects() {
    const c = this.s.client;
    const out = [];
    for (const o of c?.room?.objects?.values?.() ?? []) {
      if (o.id === c.selfId) continue;
      out.push({ id: o.id, row: o.row, col: o.col, name: c.rsc?.get?.(o.nameRsc) ?? o.name ?? '',
                 player: !!(o.flags & OF.PLAYER), attackable: !!(o.flags & OF.ATTACKABLE) });
    }
    return out;
  }

  async leverWalk(to, { maxSteps = 40 } = {}) {
    await this.s.standBeforeGo?.().catch(() => null);
    const r = await this.s.walkTo(to.col, to.row, { maxSteps })
      .catch(e => ({ arrived: false, reason: e.message }));
    return r ?? { arrived: false, reason: 'the walk gave no answer' };
  }

  /** One fight through the keeper's own fight, creature-only, counted like any other kill. */
  async leverFight(puzzle, opts, why) {
    const room = this.s.world?.room;
    const f = await this.fightNow({
      match: () => true, loot: true, reach: PLAYER_REACH, rounds: 8,
      disengageAt: this.safety().fleeAt,
      bannedWeapons: this.bannedWeaponsNow?.() ?? null,
      ...opts,
      includePlayers: false,
    }).catch(e => ({ fought: false, killed: false, died: false, note: e.message }));
    const looted = (f.looted || []).map(x => x.name + (x.amount ? ` x${x.amount}` : ''));
    if (f.killed) {
      this.tally.kills = (this.tally.kills || 0) + 1;
      this.killTimes?.push(Date.now());
      if (this.killTimes?.length > 500) this.killTimes.shift();
      try { tougher.recordKill(this.who(), { creature: f.target, room: room?.name ?? null,
        room_num: room?.num ?? null, level: this.s.client?.vitals?.()?.health?.max ?? null,
        rounds: f.rounds, looted, from_safe_spot: false }); } catch { /* a record is never worth a fight */ }
      this.ledgerEvent?.('killed', { creature: f.target, room: room?.name ?? null,
        room_num: room?.num ?? null, rounds: f.rounds, lever_puzzle: puzzle.room,
        looted: looted.length ? looted.join(', ') : undefined });
      this.progress(`lever puzzle: killed ${f.target ?? 'a monster'} (${why})`);
    } else if (f.fought) this.progress(`lever puzzle: fought (${why})`);
    this.countLoot?.(looted);
    return f;
  }

  /**
   * WAITING IS NOT STANDING STILL TO BE EATEN. Hit back at whatever is in reach (never a player),
   * and otherwise sit down to heal while nothing hostile is close. Standing up again is the job
   * of `leverWalk` and of the pull, both of which stand first.
   */
  async leverIdle(puzzle) {
    const c = this.s.client, me = c?.self;
    if (!me) return;
    const d = o => Math.hypot(o.row - me.row, o.col - me.col);
    const monsters = this.leverPuzzleObjects().filter(o => !o.player && o.attackable);
    const inReach = monsters.filter(o => d(o) <= PLAYER_REACH + 0.5);
    if (inReach.length) {
      await this.leverFight(puzzle, {
        target: inReach[0].name, holdPosition: true, rounds: 5,
        avoid: o => !!(o.flags & OF.PLAYER) || Math.hypot(o.row - me.row, o.col - me.col) > PLAYER_REACH + 0.5,
      }, 'defending a waiting square');
      return;
    }
    const v = c.vitals?.()?.health;
    const hp = v && v.max ? v.value / v.max : null;
    if (hp != null && hp < 0.95 && !monsters.some(o => d(o) <= 6))
      await this.s.pacer?.submit?.('rest', () => c.rest?.()).catch(() => null);
  }

  /** Watch sector heights (from inside the room only) until the door opens or `ms` passes. */
  async watchLeverDoor(puzzle, ms) {
    const until = Date.now() + ms;
    for (;;) {
      const heights = trustedDoorHeights({ roomNum: this.s.world?.room?.num, puzzle,
                                           sectorHeights: this.s.client?.room?.sectorHeights });
      if (doorState(heights, puzzle.door) === 'open') return true;
      if (Date.now() >= until) return false;
      await sleep(100);
    }
  }

  recordLeverDecision(puzzle, via, d, now) {
    const st = this.leverPuzzleState ??= { room: puzzle.room, to: puzzle.to, since: now, pulls: 0 };
    const wasWaiting = st.phase === d.kind && /^wait_/.test(d.kind);
    Object.assign(st, { via, phase: d.kind, why: d.why, lever: d.lever ?? null,
                        door: d.door ?? null, well: d.well ?? null, at: now });
    st.waitingSince = /^wait_/.test(d.kind) ? (wasWaiting ? st.waitingSince : now) : null;
    if (d.kind !== 'wait_partner') st.saidWaiting = false;
    this.doing = d.status;
  }

  async leverPuzzleStep(puzzle, via) {
    const s = this.s, c = s.client, me = c?.self;
    const now = Date.now();
    const agent = this.who() ?? s.name;
    if (!me) { this.doing = 'lever puzzle: own position unknown'; return HANDLED; }
    const pos = { row: me.row, col: me.col };
    // ONE VISIT = ONE ROOM ENTRY. The approach index belongs to it, so a character that died and
    // came back starts the walk from where it stands, not from where it was.
    if (!this.leverPuzzleVisit || this.leverPuzzleVisit.roomId !== (c.room?.id ?? null))
      this.leverPuzzleVisit = { roomId: c.room?.id ?? null, at: now, leg: null, legFails: 0 };
    const visit = this.leverPuzzleVisit;
    const file = this.leverClaimsFile();
    const heights = trustedDoorHeights({ roomNum: s.world?.room?.num, puzzle,
                                         sectorHeights: c.room?.sectorHeights });
    const foes = finalFoes(this.leverPuzzleObjects(), puzzle);
    const book = readClaims({ file });
    const d = decideLeverStep({ puzzle, roomNum: s.world?.room?.num, pos, heights, book, agent, now, foes });
    this.recordLeverDecision(puzzle, via, d, now);
    const st = this.leverPuzzleState;
    const release = () => {
      try { updateClaims(b => releaseLevers(b, { room: puzzle.room, agent }), { file }); }
      catch (e) { this.note('could not release the lever claim', { why: e.message }); }
    };

    switch (d.kind) {
      case 'approach': {
        const leg = nextApproachLeg(pos, puzzle, visit.leg != null ? { index: visit.leg } : null);
        if (!leg) return HANDLED;
        visit.leg = leg.index;
        const r = await this.leverWalk(leg.to);
        if (r.arrived) {
          visit.legFails = 0;
          visit.leg = leg.index + 1 < puzzle.approach.length ? leg.index + 1 : null;
          this.progress(`lever puzzle: reached r${leg.to.row}c${leg.to.col} on the way to the lever hall`);
        } else {
          // THREE MISSES AT ONE SQUARE AND IT IS SKIPPED, NOT RETRIED FOR EVER. The next square
          // is planned from wherever the body is; the walker finds its own way between them.
          if (++visit.legFails >= 3) {
            visit.legFails = 0;
            visit.leg = leg.index + 1 < puzzle.approach.length ? leg.index + 1 : null;
          }
          this.noProgress(`lever puzzle: could not reach r${leg.to.row}c${leg.to.col}: ${r.reason ?? r.why ?? 'refused'}`);
        }
        return HANDLED;
      }
      case 'claim': {
        let got = null;
        try { got = claimLeverOnDisk({ puzzle, agent, pos, file, now }); }
        catch (e) { this.note('could not claim a lever', { why: e.message }); return HANDLED; }
        if (got == null) return HANDLED;                  // somebody else won the race; re-decide
        st.lever = got;
        this.note('took a lever square', { room: puzzle.room, lever: got,
          stand: puzzle.levers[got].stand, book: file });
        const r = await this.leverWalk(puzzle.levers[got].stand, { maxSteps: 20 });
        if (r.arrived) this.progress(`lever puzzle: at lever ${got}`);
        return HANDLED;
      }
      case 'go_to_lever': {
        try { updateClaims(b => claimLever(b, { puzzle, agent, now, pos }), { file }); } catch { /* next pass */ }
        const r = await this.leverWalk(d.to, { maxSteps: 20 });
        if (r.arrived) this.progress(`lever puzzle: at lever ${d.lever}`);
        else this.noProgress(`lever puzzle: could not reach lever square r${d.to.row}c${d.to.col}`);
        return HANDLED;
      }
      case 'wait_partner': {
        try { updateClaims(b => markReady(b, { room: puzzle.room, agent, now }), { file }); }
        catch (e) { this.note('could not mark the lever ready', { why: e.message }); }
        if (!st.saidWaiting) {
          st.saidWaiting = true;
          this.note('waiting for a second lever puller', { room: puzzle.room, lever: d.lever,
            why: `one character cannot open room ${puzzle.room}: the second lever has to be pulled ` +
                 `inside ${puzzle.windowMs} ms of the first. Resting and defending here until a ` +
                 'fleet-mate bound for the same room takes the other lever' });
        }
        await this.leverIdle(puzzle);
        return HANDLED;
      }
      case 'pull': {
        let beat = null;
        try {
          updateClaims(b => { markReady(b, { room: puzzle.room, agent, now });
                              beat = agreeBeat(b, { room: puzzle.room, now }); }, { file });
        } catch (e) { this.note('could not agree a pull beat', { why: e.message }); return HANDLED; }
        if (!beat || beat.fireAt - Date.now() > PULL_BEAT_MS + PULL_LEAD_MS) return HANDLED;
        // STAND BEFORE THE WAIT, NOT AFTER IT: a stand queued behind the beat is a pull that
        // lands late, and the window is two seconds.
        await s.standBeforeGo?.().catch(() => null);
        await sleep(Math.max(0, beat.fireAt - Date.now()));
        const after = readClaims({ file });
        if (!partnerReady(after, { room: puzzle.room, agent, now: Date.now() })
            || Number(s.world?.room?.num) !== puzzle.room) return HANDLED;
        // THE LEVER BY WHERE IT STANDS, re-read now: an id is a handle and a handle recycles.
        const l = puzzle.levers[d.lever].lever;
        const lever = this.leverPuzzleObjects()
          .filter(o => puzzle.leverName.test(o.name) && chebyshev(o, l) <= 1)
          .sort((a, b) => chebyshev(a, l) - chebyshev(b, l))[0];
        if (!lever) { this.note('no lever object at its square', { lever: d.lever, at: l }); return HANDLED; }
        const since = c.evSeq ?? 0;
        await s.pacer.submit('act', () => c.activate(lever.id)).catch(() => null);
        st.pulls = (st.pulls ?? 0) + 1;
        // THE DOOR IS THE ANSWER. The refusals are sentences and are read only to explain a miss.
        const opened = await this.watchLeverDoor(puzzle, puzzle.windowMs + 1500);
        const said = (c.eventsSince?.(since) ?? []).filter(e => e.kind === 'message')
          .map(e => String(e.text ?? '')).filter(t => /lever/i.test(t)).join(' | ');
        this.ledgerEvent?.('lever_pull', { room: puzzle.room, lever: d.lever, beat: beat.beat,
          adopted_beat: beat.adopted, opened, said: said || undefined });
        if (!opened) {
          this.note('pulled, and the final door did not open', { lever: d.lever, beat: beat.beat,
            server_said: said || null,
            next: /not close enough/i.test(said) ? 'standing on the lever square again'
                : 'trying again on the next beat — a lone pull slams shut after 2 s and resets both levers' });
          return HANDLED;
        }
        // IN, BEFORE FIGHTTIMER FINDS THE FINAL AREA EMPTY. The claim goes: nothing is left to pull.
        release();
        this.note('both levers pulled — the final door is open', { lever: d.lever, beat: beat.beat });
        this.progress('lever puzzle: the final door opened');
        const r = await this.leverWalk(puzzle.enterAt, { maxSteps: 15 });
        if (r.arrived) this.progress('lever puzzle: inside the final area');
        return HANDLED;
      }
      case 'enter_final': {
        if (heldLever(book, puzzle.room, agent, now) != null) release();
        const r = await this.leverWalk(d.to, { maxSteps: 30 });
        if (r.arrived) this.progress('lever puzzle: inside the final area');
        else this.noProgress(`lever puzzle: could not get into the final area: ${r.reason ?? 'refused'}`);
        return HANDLED;
      }
      case 'fight': {
        const foe = d.foes[0];
        await this.leverFight(puzzle, {
          target: foe.name,
          // Only what CountInFinal counts, and never a player, whatever it is called.
          avoid: o => !!(o.flags & OF.PLAYER) || !inFinalZone(o, puzzle),
        }, 'clearing the final area');
        return HANDLED;
      }
      case 'wake': {
        // ALREADY BESIDE IT AND IT HAS NOT WOKEN: it is not a monster we can do anything about
        // from here, so hold the area (and defend) rather than walking into it for ever.
        if (chebyshev(pos, d.foe) <= 2) { await this.leverIdle(puzzle); return HANDLED; }
        const r = await this.leverWalk({ row: Math.max(puzzle.final.rows[0], d.foe.row - 1), col: d.foe.col },
                                       { maxSteps: 12 });
        if (!r.arrived) await this.leverIdle(puzzle);
        return HANDLED;
      }
      case 'hold_final': {
        await this.leverIdle(puzzle);
        return HANDLED;
      }
      case 'descend': {
        const exits = (s.world?.exits?.() ?? []).filter(e => Number(e.to) === puzzle.to)
          .sort((a, b) => Math.hypot((a.row ?? 0) - d.exit.row, (a.col ?? 0) - d.exit.col)
                        - Math.hypot((b.row ?? 0) - d.exit.row, (b.col ?? 0) - d.exit.col));
        if (exits.length && s.leaveVia)
          await s.leaveVia(exits[0]).catch(e => ({ left: false, reason: e.message }));
        if (Number(s.world?.room?.num) !== puzzle.to) {
          // THE BARE WAY: stand on the go-square and press. The well is a pair of `go` exits.
          const r = await this.leverWalk(d.exit, { maxSteps: 12 });
          if (r.arrived && s.rawGo) await s.rawGo().catch(() => null);
          await sleep(1500);
        }
        if (Number(s.world?.room?.num) === puzzle.to) {
          this.progress(`lever puzzle: down the well into ${puzzle.to}`);
          this.leaveLeverPuzzle(puzzle.to, 'down the well');
        } else this.noProgress('lever puzzle: the well is open and the go did not take');
        return HANDLED;
      }
      case 'wait_hall':
      case 'wait_cycle': {
        if (heldLever(book, puzzle.room, agent, now) != null) release();
        if (chebyshev(pos, puzzle.stage) > 1 && !inFinalZone(pos, puzzle)) {
          const r = await this.leverWalk(puzzle.stage, { maxSteps: 20 });
          if (r.arrived) return HANDLED;
        }
        await this.leverIdle(puzzle);
        return HANDLED;
      }
      default:
        return CONTINUE;
    }
  }
  // @end 1
}
