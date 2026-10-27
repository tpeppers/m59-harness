// THE PULL: drawing a quarry to the wall, farm buffs, closing on a quarry, breaking out.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 24 methods: pull, farmBuffContext, farmBuffAsk, farmBuffPass, castSelfSpell, pullFocusId,
//   closestPullable, closeOnQuarry, breakOut, pullFollowWaitMs, pullTargetCooling, deferPullTarget,
//   combatApproachCooling, deferBlockedCombatApproach, finishFailedCombatApproach, pendingPullWait,
//   switchFromStalledPull, pullDidNotConvert, pullAttemptFailed, pullConverted, huntRoomCheck,
//   yieldCheck, equipCheck, equippedNames
import { closeIfHealed, mayLogoff, noteLogoff } from '../m59-healing-session.mjs';
import { bodyAuthority } from '../m59-body-command.mjs';
import { withCastRite } from '../m59-castrite.mjs';
import { equipYield, reconcile } from '../m59-loadout.mjs';
import { isTerminalMovementReason } from '../m59-movement.mjs';
import { OF } from '../m59-parse.mjs';
import * as party from '../m59-party.mjs';
import { quarryApproachSignature } from '../m59-pocket-rails.mjs';
import { samplePullProgress } from '../m59-pull-progress.mjs';
import { PLAYER_REACH } from '../m59-safespots.mjs';
import * as skills from '../m59-skills.mjs';
import { goalYield, huntMatcher, huntRoomYield, huntedCreatures, loadSpawns } from '../m59-spawns.mjs';
import { FARM_BUFF_MS_PER_SQUARE, FARM_BUFF_SETTLE_MS, SPAWN_FILE, YIELD_PURPOSES, claimQuarry, pct, rankQuarries, releaseQuarry } from '../m59-autopilot.mjs';

export class PullPart {
  // @part 1

  // GO AND FETCH IT.
  //
  // A safe spot only pays if the fight happens AT it, and monsters do not queue up:
  // the generator drops them where it likes and plenty will simply stand there. So
  // the move a player makes is to run out, hit it once so that it follows, and run
  // back — the fight then happens where we chose rather than where it spawned.
  //
  // The single swing is the whole purpose of the trip. Standing out there trading
  // blows is precisely what walking to the wall was meant to avoid.
  async pull(want) {
    const s = this.s, c = s.client;
    if (!this.hold) return { pulled: false, why: 'not holding a spot to pull it back to' };

    // NOT IN A CROWD, AND NOT BELOW THE FLEE LINE. The two guards every other aggressive
    // rung in this file has, and the one that fetches monsters had neither.
    //
    // A pull is a walk OUT to the quarry, a blow, and a walk BACK. The note below argues
    // that distance does not make it more dangerous, and that is true of ONE monster: the
    // walk out happens before it has noticed us. It is false of six, because the walk is
    // through their reach and they have already noticed us — so the pull stops being a
    // fetch and becomes a lap of the melee, once per pass, for as long as the room stays
    // busy.
    //
    // Rowlf, room 39, 2026-09-06 04:55. Six battered skeletons in reach on every one of the
    // last sixteen frames (ten at peak), `doing: fighting` on all of them, oscillating
    // 23,8 - 24,8 - 23,8 - 22,8 while health went 34 -> 6. That oscillation IS this walk.
    // Gross 15 squares travelled, NET ONE. His flee threshold was 36 of 53 and he was under
    // it for the whole minute, still pulling, one second before he died: "pulled it to the
    // wall, went 3" and "waiting for it at the wall, follow_window_ms 8000".
    //
    // Below the flee line the survival ladder owns the body. This crowd guard only
    // refuses walking OUT to fetch another monster; it never refuses taking shelter.
    // forFighting: a crowd of things that cannot advance this body is not a reason to refuse
    // to go and fight. See `advancingThreatCountHere`.
    // EXCEPT A BUDDY-SYSTEM TAGGER AT FULL HEALTH (operator, 2026-10-09: "Drop the pull's crowd safety check,
    // as long as the puller is full health"). Its walk out is to an UNTOUCHED monster, its partner is standing
    // at the wall it walks back to, and Castle Victoria with twenty of our own in it read as a crowd on nearly
    // every pass -- one tag in four minutes. Below full health the guard is back; the flee-line refusal just
    // below, the survival ladder above this stage and the watchdog during the walk are all unchanged.
    const fullHealth = (() => { const h = s?.client?.vitals?.()?.health;
      return !!(h && Number(h.max) > 0 && Number(h.value) >= Number(h.max)); })();
    const buddyCrowdOk = fullHealth && this.mode === 'farm' && this.buddyRole?.()?.role === 'tag';
    // AND A FARM STRATEGY THAT SAYS SO (`pull.throughCrowd`, policy.pullThroughCrowd). Operator, 2026-10-12, of
    // Janice and Robin holding walls in the Barloque sewers' room 112 with 21 lupoggs and 4 rats in it and every
    // pull refused here: "Let strategies always pull through a crowd, but have them just always prefer the
    // closest target out of the crowd that fits the criteria". So the refusal is skipped, and the quarry is
    // re-picked as the qualifying creature the fewest walking steps from the wall (`closestPullable`): the
    // shortest walk out through the crowd and the shortest walk back. The flee-line refusal below, the
    // survival ladder above this stage and the watchdog during the walk are all unchanged.
    const crowd = this.crowded({ forFighting: true });
    const throughCrowd = crowd && this.policy?.pullThroughCrowd === true;
    if (!buddyCrowdOk && crowd && !throughCrowd) {
      this.noteCrowdRefusal('pulling quarry to the wall');
      return { pulled: false, why: 'too many things in this room to walk out and back through' };
    }
    // AND THE SAME ONE UNTIL IT DIES. Operator, 2026-10-12, after a lupogg room where each pull re-picked
    // the closest and a lupogg that had taken a cut was dropped for a fresh one nearer the wall: "fix it to
    // follow the same monster after starting one, and otherwise grab the closest". A fight from the wall is
    // a round at a time, so damage only adds up to a kill if every pull fetches the same body.
    if (throughCrowd && !buddyCrowdOk) {
      const pick = this.closestPullable({ preferId: this.pullFocusId() });
      if (pick && pick.id !== want?.id) {
        this.note(pick.focus ? 'pulling through a crowd: the one we already started on'
                             : 'pulling through a crowd: the closest qualifying target instead', {
          was: want?.id ?? null, now: pick.id, steps: pick.steps, focus: !!pick.focus,
          why: pick.focus ? 'damage only adds up to a kill on one body'
                          : 'pull.throughCrowd: the walk out and back is through everything in reach, so it is the shortest one' });
        want = pick;
      }
    }
    const frac = pct(s?.client?.vitals?.()?.health);
    if (frac !== null && frac < this.safety().fleeAt)
      return { pulled: false,
               why: `below the flee line (${Math.round(frac * 100)}% against ` +
                    `${Math.round(this.safety().fleeAt * 100)}%) — the ladder owns the body, ` +
                    'and a pull would fetch another one to it' };
    // A PRIVATE STRATEGY MAY BUFF FIRST, OR SAY "NOT NOW" (`farmBuff`), while the body is still on the wall.
    {
      const fb = await this.farmBuffAsk('before_pull', { target_id: want?.id ?? null }).catch(() => null);
      if (fb?.no_engage) return { pulled: false, why: `${fb.strategy}: ${fb.why ?? 'not now'}` };
    }
    const spot = { ...this.hold };
    // NEVER TRUST A CAPTURED OBJECT'S COORDINATES. BP_ROOM_CONTENTS replaces the
    // whole object map with fresh instances, so anything picked up earlier in the
    // pass — before we walked to the wall, say — still holds the position it was at
    // then. Routing to that is routing to where the monster used to be.
    const foe = c.room.objects.get(want.id);
    if (!foe) return { pulled: false, why: 'it is not in the room any more' };
    const name = c.rsc.get(foe.nameRsc), pullRoom = c.room.id, pullSave = c.idsAsOf?.()?.last_save_at;
    const approach = s.world?.approachSquare?.(foe.col, foe.row);
    if (!approach) return { pulled: false, why: 'no square beside it that we can reach' };
    // NO DISTANCE LIMIT. IF WE CAN GET TO IT, IT IS WORTH FETCHING.
    //
    // This refused anything more than `pullWithin` steps away as "too far to fetch and
    // get back", which reads as prudence and is not. The walk out is taken before the
    // thing has noticed us and the walk back is the only part that costs anything, so a
    // long pull is not more dangerous than a short one — it is the same danger for
    // longer, and it ends with the fight happening at the wall instead of in the open,
    // which is the entire point. Refusing it does not avoid the fight; it leaves the
    // keeper standing at a good spot with nothing to kill, which is how a character
    // spends an hour reporting itself safe and earning nothing.
    //
    // The step budgets below are all relative to `approach.steps`, so they scale with
    // the trip and nothing here needs a ceiling to stay bounded. Patience is the
    // correct behaviour: walk however far it is, hit it once, walk back.
    //
    // `pullWithin` survives as an explicit override for anyone who wants one — the
    // broker still exposes it as `pull_within` — but it is unset by default.
    if (approach.steps > (this.policy.pullWithin ?? Infinity))
      return { pulled: false, why: `${approach.steps} steps away — beyond the pull_within override` };

    this.doing = 'fighting';
    const out = await s.walkTo(approach.col, approach.row, { maxSteps: approach.steps + 8 })
                       .catch(e => ({ arrived: false, reason: e.message }));
    bodyAuthority(s).guard();
    this.movedAt = Date.now();
    if (!out.arrived) {
      const terminal = this.terminalMovement(out, 'pull movement');
      if (terminal) return { pulled: false, ...terminal };
      const home = await skills.returnToSpot(s, spot, { maxSteps: 24 }).catch(() => ({ arrived: false }));
      this.movedAt = Date.now();
      bodyAuthority(s).guard();
      if (!home.arrived) this.releaseHold('could not get back after a failed pull');
      return { pulled: false, why: out.reason || 'could not get to it' };
    }

    const it = c.room.objects.get(foe.id);
    const validQuarry = () => c === s.client && c.room.id === pullRoom &&
      c.idsAsOf?.()?.last_save_at === pullSave &&
      c.rsc.get(c.room.objects.get(foe.id)?.nameRsc) === name;
    if (!validQuarry()) {
      // A save or changed quarry is not a reason to leave the farmer in the
      // open at the end of an abandoned fetch. Survival may still preempt this
      // normal return; a different client or room receives no stale command.
      if(s.client===c&&c.room.id===pullRoom){
        const home=await skills.returnToSpot(s,spot,{maxSteps:approach.steps+12}).catch(()=>({arrived:false}));
        bodyAuthority(s).guard();
        if(!home.arrived)this.releaseHold('quarry changed and the original wall was not reached');
      }
      return {pulled:false, why:'pull quarry identity changed during approach'};
    }
    if (it) {
      await s.faceToward(it);
      await s.pacer.submit('attack', () => { if(validQuarry()) c.attack(foe.id); }, 1050);
      this.swungAt = Date.now();
      // ONLY WHEN THE THING SWUNG AT IS A PERSON. This path is nearly always a monster, and
      // stamping every swing would ban the whole fleet from the chalice permanently.
      if (it.flags & OF.PLAYER) this.notePlayerSwing();
      this.foeId = foe.id;
      // The body this character has started on, for the next pull (`pullFocusId`).
      this._pullFocus = { id: foe.id, room: s.world?.room?.num ?? null, at: Date.now() };
    }

    const home = await skills.returnToSpot(s, spot, { maxSteps: approach.steps + 12 })
                             .catch(e => ({ arrived: false, why: e.message }));
    this.movedAt = Date.now();
    bodyAuthority(s).guard();
    if (!home.arrived) {
      this.releaseHold('could not get back to it after pulling');
      return { pulled: true, back: false, target: name, target_id:foe.id,
               why: home.why || 'hit it but could not get back to the wall' };
    }
    // We left and returned, so nothing is proved about the square any more until the
    // experiment runs again. The belief survives; the running clock does not.
    this.hold.quietMs = 0;
    this.note('pulled it to the wall', {
      target: name, went: approach.steps, back_at: { col: spot.col, row: spot.row },
      why: 'a safe spot is only worth anything if the fight happens at it' });
    return { pulled: true, back: true, target: name, target_id:foe.id, steps: approach.steps };
  }

  // WALKING UP TO IT, WHEN THERE IS NO WALL TO FETCH IT TO.
  //
  // `pull()`'s whole shape — run out, hit it once, run BACK — exists so the fight happens
  // at a chosen square. Switch `use_safe_spots` off and there is no chosen square, so the
  // trip has no destination and `pull()` refuses on its first line. That refusal used to
  // be the end of the road: see the caller for the loop it produced.
  //
  // This is the same journey minus its second half. Same `approachSquare`, same `walkTo`,
  // same terminal-movement handling — we simply stay next to the quarry, because standing
  // out there trading blows is what fighting without a wall MEANS. It is not a degraded
  // pull; it is the correct behaviour for a posture that has declined the wall.
  //
  // No `returnToSpot`, no hold to release, and no claim about the square: nothing here
  // teaches the safe-spot book anything, which is right, because no spot was involved.
  /**
   * The creature to pull through a crowd: on the hunt list, not spared, not refused by the engagement band,
   * with a reachable square beside it -- the one the fewest WALKING steps from here (the wall). Euclidean
   * distance narrows the field to the nearest eight before any path is asked for. null when none qualifies.
   */
  // THE farmBuff SEAM: A PRIVATE STRATEGY'S SAY OVER BUFFS AND THE WALL WHILE FARMING.
  //
  // Operator, 2026-10-12: a self-buff tactic for the lupogg hunters -- when to cast it, being back on the
  // safe spot before it ends, and logging off to wait out what its end brings -- is to be PRIVATE. So the
  // tactic lives in substrate/strategies/ (gitignored) and answers `farmBuff`; this file only builds the
  // question and carries out a small, closed set of answers. No strategy, or a declining one, is the old
  // behaviour exactly.
  //
  // Asked with `phase`: 'pass' (every pass, ahead of the survival ladder's own rungs), 'before_pull' (on
  // the wall, before walking out) and 'before_swing' (the first swing of a fight at the wall).
  //   ctx = { phase, now, agent, character, room, farm_strategy, health, mana, enchantments: [names],
  //           held, in_reach (unspared bodies in melee reach), safe_spot: {col,row} | null,
  //           at_safe_spot, eta_to_safe_spot_ms, pack: { item: count }, spells: [known names],
  //           heard: [{ at, text }] (the last two minutes of server messages), ...extra }
  //   answer = { cast?: '<known spell>' (at ourselves), go_to_safe_spot?: true, no_engage?: true,
  //              logoff?: { for_ms } (1-60 s offline, then back), why?: string } | null
  // Never throws; a malformed answer does nothing.
  farmBuffContext(phase, extra = {}) {
    const s = this.s, c = s?.client, me = c?.self, now = Date.now();
    const key = v => String(v ?? '').toLowerCase().trim();
    const v = c?.vitals?.() ?? {};
    const enchantments = (c?.enchantments?.() ?? []).map(e => key(e.name)).filter(Boolean);
    const pack = {};
    for (const o of c?.inventory ?? []) {
      const n = key(c.rsc?.get?.(o.nameRsc) ?? o.name);
      if (n) pack[n] = (pack[n] ?? 0) + (Number(o.amount) || 1);
    }
    const spells = (c?.spells ?? []).map(sp => key(c.rsc?.get?.(sp.nameRsc) || sp.name)).filter(Boolean);
    const heard = (c?.events ?? []).filter(e => e?.kind === 'message' && e.text && now - (e.at ?? 0) < 120_000)
      .slice(-40).map(e => ({ at: e.at, text: String(e.text) }));
    const room = s?.world?.room?.num ?? null;
    const spot = this.hold && this.hold.room === room ? { col: this.hold.col, row: this.hold.row } : null;
    const squares = spot && me ? Math.max(Math.abs(me.col - spot.col), Math.abs(me.row - spot.row)) : null;
    const atSpot = squares != null && squares < 1;
    return { phase, now, agent: s?.name ?? null, character: this.who?.() ?? null, room,
      farm_strategy: this.policy?.farmStrategy ?? null, health: v.health ?? null, mana: v.mana ?? null,
      enchantments, held: enchantments.includes('hold'),
      in_reach: (this.inReachOfUs?.() ?? []).filter(o => !this.sparedHere(o)).length,
      safe_spot: spot, at_safe_spot: atSpot,
      eta_to_safe_spot_ms: spot ? (atSpot ? 0 : squares * FARM_BUFF_MS_PER_SQUARE + FARM_BUFF_SETTLE_MS) : null,
      pack, spells, heard, ...extra };
  }

  async farmBuffAsk(phase, extra = {}) {
    if (typeof this.s?._askStrategies !== 'function') return null;
    const ctx = this.farmBuffContext(phase, extra);
    const got = await this.s._askStrategies('farmBuff', ctx).catch(() => null);
    const a = got?.answer;
    if (!a || typeof a !== 'object') return null;
    const name = got.strategy ?? 'strategy', why = a.why == null ? phase : String(a.why);
    const out = { strategy: name, why, no_engage: a.no_engage === true };
    if (a.cast) out.cast = await this.castSelfSpell(String(a.cast), `${name}: ${why}`).catch(e => ({ landed: false, why: e.message }));
    if (a.go_to_safe_spot === true && ctx.safe_spot && !ctx.at_safe_spot && this.hold) {
      out.went = await skills.returnToSpot(this.s, this.hold, { maxSteps: 30 }).catch(e => ({ arrived: false, why: e.message }));
      this.movedAt = Date.now();
    }
    if (a.logoff && Number.isFinite(Number(a.logoff.for_ms))) {
      const ms = Math.max(1000, Math.min(60_000, Math.round(Number(a.logoff.for_ms))));
      this.note('farm buff: logging off to wait it out', { strategy: name, for_ms: ms, why });
      out.logoff = await this.reconnect(`${name}: ${why}`, { offlineMs: ms });
    }
    if (out.no_engage || out.cast || out.went || out.logoff)
      this.note('farm buff', { phase, strategy: name, why, cast: a.cast ?? null, landed: out.cast?.landed ?? null,
        went: out.went ? !!out.went.arrived : null, no_engage: out.no_engage, logoff_ms: out.logoff ? a.logoff.for_ms : null });
    return out;
  }

  /** The pass-phase question; true when the answer moved or removed the body (the pass is over). */
  async farmBuffPass() {
    const r = await this.farmBuffAsk('pass');
    return !!(r?.logoff?.ok || r?.went?.arrived);
  }

  /** Cast a known spell at ourselves; landed is judged by the mana it spent. Once in 10 s per spell. */
  async castSelfSpell(name, why) {
    const s = this.s, c = s?.client;
    if (!c?.selfId) return { landed: false, why: 'no object id for ourselves yet' };
    const key = v => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const want = key(name);
    const spell = (c.spells || []).find(sp => key(c.rsc?.get?.(sp.nameRsc) || sp.name) === want);
    if (!spell) return { landed: false, why: `does not know ${name}` };
    this._selfCastAt ??= new Map();
    if (Date.now() - (this._selfCastAt.get(want) ?? 0) < 10_000) return { landed: false, why: 'cast recently' };
    this._selfCastAt.set(want, Date.now());
    const mana = c.vitals?.()?.mana?.value ?? null;
    const before = c.evSeq;
    await withCastRite(s, { spell, targets: [c.selfId], why: 'castSelfSpell' }, () => s.pacer.submit('cast', () => c.cast(spell.id, [c.selfId]), 1050));
    await c.waitFor?.({ since: before, kinds: ['message', 'stat'], timeoutMs: 2500 })?.catch?.(() => {});
    const after = c.vitals?.()?.mana?.value ?? null;
    const landed = mana != null && after != null && after < mana;
    this.recordCast?.(name, { ok: landed, why, target: 'self', mana_before: mana, mana_after: after });
    return { landed, mana_before: mana, mana_after: after };
  }

  /** The creature this character last pulled, while it is still in this room; else null. */
  pullFocusId() {
    const f = this._pullFocus, c = this.s?.client;
    if (!f || f.room !== (this.s?.world?.room?.num ?? null)) return null;
    if (!c?.room?.objects?.get?.(f.id)) { this._pullFocus = null; return null; }
    return f.id;
  }

  closestPullable({ preferId = null } = {}) {
    const s = this.s, c = s?.client, world = s?.world, me = c?.self;
    if (!c?.room?.objects || !world?.approachSquare || !me) return null;
    let match;
    try { match = huntMatcher(loadSpawns(SPAWN_FILE), this.policy?.hunt); } catch { return null; }
    const rows = [];
    const players = this.policy?.gangUp ? this.gangUpPlayersHere() : null;
    for (const o of c.room.objects.values()) {
      if (o.id === c.selfId || (o.flags & OF.PLAYER) || !(o.flags & OF.ATTACKABLE)) continue;
      const name = o.name ?? c.rsc?.get?.(o.nameRsc) ?? '';
      if (!match(name) || this.sparedHere(o)) continue;
      // GANG UP (m59-gang-up.mjs): short of its quorum it is never pulled. WITH it, it is quarry the orders chose to fight
      // above the band -- the prey list never measures hunted prey against the ceiling -- so only the karma half of the
      // refusal applies here, or this re-pick would swap the guardian the selection chose for the nearest troll.
      const gang = players ? this.gangUpVerdict(o, players) : null;
      if (gang && !gang.met) continue;
      if (gang ? this.karmaForbids(name) : this.refuseEngagement(name)) continue;
      rows.push({ o, d: Math.hypot((o.col ?? 0) - me.col, (o.row ?? 0) - me.row) });
    }
    rows.sort((a, b) => a.d - b.d);
    // THE ONE ALREADY STARTED ON comes first, wherever it stands, while it qualifies and can be reached.
    const focus = preferId != null ? rows.find(r => r.o.id === preferId) : null;
    if (focus) {
      const a = world.approachSquare(focus.o.col, focus.o.row);
      if (a) return { id: focus.o.id, steps: a.steps, focus: true, name: focus.o.name ?? c.rsc?.get?.(focus.o.nameRsc) ?? '' };
    }
    let best = null;
    for (const { o } of rows.slice(0, 8)) {
      const a = world.approachSquare(o.col, o.row);
      if (!a) continue;
      if (!best || a.steps < best.steps) best = { id: o.id, steps: a.steps, name: o.name ?? c.rsc?.get?.(o.nameRsc) ?? '' };
    }
    return best;
  }

  async closeOnQuarry(want) {
    const s = this.s, c = s.client;
    // Same warning as pull(): BP_ROOM_CONTENTS replaces the whole object map, so a
    // captured monster carries the position it had when it was captured. Re-read it.
    const foe = c.room.objects.get(want.id);
    if (!foe) return { closed: false, why: 'it is not in the room any more' };
    const name = c.rsc.get(foe.nameRsc);
    const approach = s.world?.approachSquare?.(foe.col, foe.row);
    if (!approach) {
      // The geometric answer, and the definitive one: there is no square adjacent to it that
      // this map says we can stand on. Nothing about the next pass will change that.
      this.noteUnreachablePrey(s.world?.room?.num ?? null, foe.col, foe.row);
      this.note('ignoring prey we cannot walk to', {
        target: name, at: `r${foe.row}c${foe.col}`,
        why: 'no square beside it that this map says we can stand on',
        how: 'remembered by SQUARE for a few minutes, so a respawn in the same corner is ' +
             'skipped too and the next pass picks something reachable instead' });
      // AND THE RETURN, WHICH IS THE ONLY LINE HERE THAT DOES ANYTHING. Everything above it
      // is bookkeeping; without this the branch falls through to `approach.col` on a null
      // `approach` and throws, in precisely the case the branch was added to handle. It was
      // dropped by an edit that added the note ABOVE the return and replaced it rather than
      // preceding it — a class of mistake no reviewer catches by reading the new lines,
      // because the new lines are all correct.
      return { closed: false, target: name, why: 'no square beside it that we can reach' };
    }
    this.doing = 'fighting';
    const out = await s.walkTo(approach.col, approach.row, { maxSteps: approach.steps + 8 })
                       .catch(e => ({ arrived: false, reason: e.message }));
    this.movedAt = Date.now();
    if (!out.arrived) {
      // TERMINAL_MOVEMENT_REASONS propagate rather than loop — a heading no other heading
      // can fix is reported, not retried, which is what stops a bad route being learned.
      const terminal = this.terminalMovement(out, 'close-on movement');
      if (terminal) {
        // TERMINAL means no other heading fixes it, which is precisely the claim this memory
        // wants. A NON-terminal failure is deliberately NOT remembered: a body in the doorway
        // is the commonest one and it walks away by itself, so forgetting it after one try
        // would ban a perfectly good creature for five minutes.
        this.noteUnreachablePrey(s.world?.room?.num ?? null, foe.col, foe.row);
        // A BAN THAT LEAVES NO TRACE IS A BAN NOBODY CAN INVESTIGATE, and this site laid
        // one down silently while the `!approach` site above announced itself. That
        // asymmetry cost a real diagnosis on 2026-09-18: a postmortem sweep for "ignoring
        // prey we cannot walk to" came back 0 of 16 and was read as clearing this feature,
        // when it only ever covered the noisy half — every ban taken through a terminal
        // movement failure was invisible to the same query. The two sites ban the same
        // thing for different reasons and both must say so.
        this.note('ignoring prey we cannot walk to', {
          target: name, at: `r${foe.row}c${foe.col}`, reason: terminal.why ?? 'terminal movement',
          why: 'the walk to it failed for a reason no other heading can fix',
          how: 'remembered by SQUARE for a few minutes, like the no-approach case — but ' +
               'arrived at through the MOVER rather than the geometry, which is the half ' +
               'that used to be silent' });
        return { closed: false, target: name, ...terminal };
      }
      if(!out.cancelled&&c.self&&!c.self.predicted&&['movement_deviation','object_blocked','no_ground_gained','spinning_without_packets'].includes(out.reason)){
        const deferred=this.deferPullTarget(s.world?.room?.num,foe.id,`approach refused: ${out.reason}`);
        if(deferred)deferred.approachSignature=quarryApproachSignature(s,c.room.objects.get(foe.id));
        this.note('quarry approach deferred until its inputs change',{
          target:name,at:`r${foe.row}c${foe.col}`,reason:out.reason,
          until:deferred?.until,why:'retrying the same approach from the same pose and room bodies is a loop'});
      }
      return { closed: false, target: name, why: out.reason || 'could not get to it' };
    }
    this.note('closed on the quarry', {
      target: name, went: approach.steps,
      why: 'safe spots are off, so there is no wall to fetch it to — the fight happens here' });
    return { closed: true, target: name, steps: approach.steps };
  }

  // LEAVING A SAFE SPOT WITH A CROWD ON IT.
  //
  // Everything that makes the spot good makes stepping off it bad. The things that
  // could not reach us are standing in exactly the squares we have to walk through,
  // and every one of them gets its attacks back the moment we come out from behind
  // the wall — which is how a character survives twenty minutes of siege and then
  // dies in the four seconds after it decides to leave.
  //
  // A reconnect resets that. The entry grace period is handed out again and monsters
  // only wake as we act, so instead of walking out through five creatures that are
  // already swinging we walk out through five of which about one has noticed. It
  // costs a few seconds.
  async breakOut(why) {
    const t = this.threat();
    if (!this.policy.breakOutViaLogoff) return { did: false, crowd: t.near.length };
    if (t.near.length < (this.policy.breakOutAbove ?? 2)) return { did: false, crowd: t.near.length };
    // One logoff per healing session, whatever it is for (m59-healing-session.mjs).
    const me = String(this.s?.name ?? '');
    { const h = this.s.client?.vitals?.()?.health; closeIfHealed(me, { hp: h?.value, max: h?.max }); }
    if (!mayLogoff(me)) return { did: false, crowd: t.near.length, why: 'this healing session already logged off once' };
    this.note('reconnecting before stepping out', {
      why, crowd: t.near.length, camped_on_us: t.engaged, what: t.names,
      how: 'a reconnect hands back the entry grace period, so we walk out past a crowd that ' +
           'has to notice us one at a time rather than one that is already mid-swing' });
    noteLogoff(me, { why: 'breaking out of a crowded safe spot', room: this.s.world?.room?.num ?? null });
    const r = await this.reconnect('breaking out of a crowded safe spot');
    if (!r.ok) return { did: false, crowd: t.near.length };
    this.tally.breakouts = (this.tally.breakouts || 0) + 1;
    return { did: true, crowd: t.near.length };
  }
  // @end 1

  // @part 2

  // HOW LONG TO LET A PULLED QUARRY FOLLOW BEFORE CALLING THE PULL A MISS.
  //
  // The keeper decides every second. The quarry moves on roughly the same one-square-
  // per-second clock as the walk we just made, so "still out of reach next pass" says
  // almost nothing after a long pull. Give it the outbound distance plus a small reaction
  // margin, bounded so a genuinely stuck quarry cannot park a keeper forever.
  pullFollowWaitMs(steps = 0) {
    const min = Math.max(0, Number(this.policy.pullFollowMinMs ?? 8_000));
    const per = Math.max(0, Number(this.policy.pullFollowPerStepMs ?? 1_100));
    const max = Math.max(min, Number(this.policy.pullFollowMaxMs ?? 60_000));
    return Math.min(max, Math.max(min, Math.max(0, Number(steps) || 0) * per + 3_000));
  }

  pullTargetCooling(room, id, now = Date.now()) {
    if (room == null || id == null) return null;
    const store = (this.pullTargetCooldowns ??= new Map());
    const key = `${room}:${id}`;
    const record = store.get(key);
    if (!record) return null;
    if(record.quarry_position){
      const foe=this.s?.client?.room?.objects?.get?.(id),at=record.quarry_position;
      if(!foe||['row','col','x','y'].some(k=>foe[k]!==at[k])){store.delete(key);return null;}
    }
    if(record.approachSignature&&record.approachSignature!==quarryApproachSignature(this.s,this.s?.client?.room?.objects?.get?.(id))){
      store.delete(key);return null;
    }
    if (record.until <= now) { store.delete(key); return null; }
    return record;
  }

  deferPullTarget(room, id, why, now = Date.now()) {
    if (room == null || id == null) return null;
    const ms = Math.max(3_000, Number(this.policy.pullTargetCooldownMs ?? 30_000));
    const record = { room, id, at: now, until: now + ms, why };
    (this.pullTargetCooldowns ??= new Map()).set(`${room}:${id}`, record);
    return record;
  }

  combatApproachCooling(room,foe) {
    const cooling=this.pullTargetCooling(room,foe?.id),me=this.s?.client?.self;
    return !!cooling?.combat_approach&&!!me&&Math.hypot(foe.row-me.row,foe.col-me.col)>PLAYER_REACH;
  }

  deferBlockedCombatApproach(result) {
    if(!result?.approach_blocked||result.cancelled||result.left_room)return false;
    const room=this.s.world?.room?.num,id=result.target_id??result.foe_id,foe=this.s.client?.room?.objects?.get?.(id);
    if(!foe||this.s.client.self?.predicted)return false;
    const record=this.deferPullTarget(room,id,result.detour_reason??result.reason);
    if(!record)return false;
    record.combat_approach=true;
    record.quarry_position=Object.fromEntries(['row','col','x','y'].map(k=>[k,foe[k]]));
    if(this.foeId===id)this.foeId=null;
    if(!this.pendingPull)releaseQuarry(this.s.name);
    this.note('combat approach blocked - choosing another quarry',{
      target_id:id,quarry:record.quarry_position,position:result.position,blockers:result.blockers,
      reason:result.reason,detail:result.detour_reason,until:record.until,
      why:'the coarse adjacent square has no proved local fine route; a moved quarry or melee contact permits an immediate retry'});
    return true;
  }

  finishFailedCombatApproach(result) {
    if(this.deferBlockedCombatApproach(result)){
      this.noProgress('local combat approach blocked; exact quarry deferred briefly');
      return true;
    }
    if(result?.fought===false&&(result.cancelled||result.left_room||result.reason==='movement_deviation'||isTerminalMovementReason(result.reason))){
      this.note('combat approach returned control',{
        reason:result.reason,cancelled:!!result.cancelled,position:result.position??result.deviation?.position,
        deviation:result.deviation,why:'no attack occurred; the next pass must decide from the confirmed movement failure'});
      this.noProgress('combat approach stopped: '+(result.reason??'ownership changed'));
      return true;
    }
    return false;
  }

  // A deadline alone cannot distinguish a slow follower from a monster fighting somebody
  // else. Sample the exact pulled id every few seconds and ask whether its distance to the
  // chosen wall establishes a new low. Three non-closing samples is a disengagement; a
  // delayed packet or one awkward path step is not.
  pendingPullWait(now = Date.now()) {
    const p = this.pendingPull;
    if (!p) return null;
    const target = p.target_id != null
      ? this.s.client?.room?.objects?.get?.(p.target_id) : null;
    const sampled = samplePullProgress(p, target, {
      now,
      sampleEveryMs: this.policy.pullProgressSampleMs ?? 3_000,
      stalledSamples: this.policy.pullProgressStalledSamples ?? 3,
      minCloser: this.policy.pullProgressMinCloser ?? 0.25,
    });
    if (sampled.state) this.pendingPull = sampled.state;
    const { state, ...observation } = sampled;
    return {
      ...(sampled.state ?? p), ...observation,
      target_position: target ? { col: target.col, row: target.row } : null,
      remaining_ms: Math.max(0, Number(p.waitUntil ?? now) - now),
    };
  }

  // Lost aggro is TARGET evidence, never WALL evidence. Cool the exact quarry briefly,
  // preserve the wall if there is nothing else to fight, or release it and immediately
  // acquire the closest valid wall for an alternative. No barren/no-wall record is written.
  async switchFromStalledPull(waiting, found = [], why = 'the quarry stopped closing',
                              { cooldown = true } = {}) {
    const room = this.s.world?.room;
    const oldId = waiting?.target_id ?? null;
    if (cooldown && oldId != null)
      this.deferPullTarget(room?.num, oldId, why);
    this.pendingPull = null;
    this.pullsWithoutContact = 0;
    if (this.foeId === oldId) this.foeId = null;
    releaseQuarry(this.s.name);

    const alternatives = found.filter(o => o?.id != null && o.id !== oldId
      && !this.pullTargetCooling(room?.num, o.id));
    this.note('disengaging from a quarry that stopped following', {
      target: waiting?.target, target_id: oldId,
      wall: waiting?.wall ?? (this.hold
        ? { room: this.hold.room, col: this.hold.col, row: this.hold.row } : null),
      last_position: waiting?.last_position ?? null,
      last_distance: waiting?.last_distance ?? null,
      best_distance: waiting?.best_distance ?? null,
      non_closing_samples: waiting?.non_closing_samples ?? null,
      why,
      doing_instead: alternatives.length
        ? 'choosing another monster, then recomputing its closest safe spot'
        : 'holding this wall until a different target is available',
    });

    if (!alternatives.length) {
      this.doing = 'waiting';
      return { switched: false, waiting: true };
    }

    const agreed = party.agreedTarget(this.s.name);
    const preferId = alternatives.some(o => o.id === agreed?.id) ? agreed.id : null;
    const next = rankQuarries(this.s.name, room?.num, alternatives, { preferId })[0];
    if (!next) return { switched: false, waiting: true };

    if (this.hold)
      this.releaseHold('the selected quarry stopped following — choosing another target and wall');
    this.foeId = next.id;
    claimQuarry(this.s.name, room?.num, next.id);
    const spot = await this.takeSafeSpot('a new wall for the next quarry', next)
                           .catch(e => ({ took: false, why: e.message }));
    if (spot.took) this.progress('changed quarry and took its closest valid wall');
    else this.noProgress('changed quarry but could not take its safe spot: ' + (spot.why || 'unknown'));
    return { switched: true, target_id: next.id, spot };
  }

  // THE SPOT NOTHING CAN ACTUALLY REACH — the cliff.
  //
  // A whole band of the fleet stood on the clifftop above West Merchant Way, taking a
  // swing at things below, walking back to the wall, and waiting for a fight that could
  // not happen: the monsters could not climb, and the characters were holding melee
  // weapons that could not reach down. Statler, Bunsen, Scooter, Beaker and Janice all
  // reported "fighting from an untrusted safe spot" and "hunting centipedes" while doing
  // neither, for hours.
  //
  // Nothing caught it, and the reason is precise. The wall bookkeeping was written when
  // pull() FAILED. Here pull() SUCCEEDED every time — it reached the monster, hit it, and walked
  // back, which is exactly what it claims to do — so `progress('pulled something to the
  // wall')` fired every pass and cleared the stall counter. The keeper was busy, honest,
  // and completely stuck, and its own health check said so.
  //
  // The missing question is not "did the pull work" but "did the pull CONVERT". A pull
  // that never once results in something standing next to us is a pull into a place the
  // monster cannot follow, whatever the geometry says about the square. Counting them is
  // empirical and needs no height data, which is just as well: none is available, and
  // this failure catches human players too.
  // AND IT COUNTS, IT DOES NOT CONVICT. Removed 2026-08-27 on the operator's instruction:
  // **there is no concept of a safe wall that does not work.**
  //
  // What used to happen here: after `pullsBeforeBarren` non-converting pulls the square went
  // into `barrenSpots`, a per-room set the wall search then refused candidates from; after
  // `barrenSpotsBeforeRoomDecision` such squares the whole ROOM went into `noWallRooms` and
  // the keeper stopped looking for a wall in it at all. Three squares, and a room the fleet
  // crosses every day was written off for the life of the process.
  //
  // The argument against it is the one that has been right about this room every time. A pull
  // that does not convert is a fact about the PULL — where the quarry was, what lay between,
  // whether it lost interest — and the square somebody happened to be standing on is the one
  // thing in that sentence which did not move. The evidence was always circumstantial and it
  // was recorded as a verdict, in a structure with no way to be wrong: nothing ever left
  // `barrenSpots`, so one bad afternoon in a room permanently narrowed it, and the narrowing
  // was invisible because the keeper went on reporting that it was fighting.
  //
  // So the counter stays and the memory goes. Four pulls that produce nothing still means
  // stop standing here — that is a live decision about now, costs nothing if it is wrong, and
  // is what stops a character grinding a cliff edge for an hour. It just no longer writes
  // anything down, and the next selection is free to pick this square again.
  pullDidNotConvert(why) {
    this.pullsWithoutContact = (this.pullsWithoutContact ?? 0) + 1;
    const limit = this.policy.pullsBeforeMovingOn ?? 4;
    if (this.pullsWithoutContact < limit) {
      this.note('pulled, but nothing came', {
        attempt: this.pullsWithoutContact, of: limit, why,
        hint: 'if this keeps happening, stand somewhere else and try from there' });
      return false;
    }
    const room = this.s.world?.room;
    this.note('MOVING ON — this stand produced no fight', {
      at: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
      room: room?.num, attempts: this.pullsWithoutContact,
      why: 'every pull reached the target and none of them ever produced a fight. The ' +
           'commonest cause is standing somewhere the monsters cannot climb to, which ' +
           'also means a melee weapon cannot reach down to them.',
      note: 'nothing is recorded against this square — the next selection may well choose it ' +
            'again, and if the quarry is somewhere else by then it will work',
    });
    this.pullsWithoutContact = 0;
    this.releaseHold('this stand produced no fight');
    this.noProgress('holding a square that produced no fight');
    return true;
  }

  // A FAILED ATTEMPT TO SWING IS NOT YET A FAILED WALL.
  //
  // `pull()` can fail before the attack because a moving quarry invalidated its approach
  // square or because one walk was refused. The old branch retired the wall after that
  // single miss. Count per square and require the same patience as a pull that succeeded
  // but did not convert; at the limit the answer is to RELOCATE, and nothing is recorded
  // against the square — see pullDidNotConvert for why there is no such record any more.
  pullAttemptFailed(spot, why) {
    // A BUDGET KEYED ON A SQUARE WE MAY NOT HAVE IS NOT A BUDGET.
    //
    // This returned `attempt: 0` whenever `spot` was null — which is every single pass
    // once `use_safe_spots` is off, because the spot IS the hold. So the counter never
    // advanced, `relocate` could never fire, and the one escape from a failing pull was
    // unreachable in exactly the configuration that needs it most. Three characters sat in
    // the loop for 721s, 942s and 1025s reporting `attempt: 0 of 4` throughout.
    //
    // The caller no longer reaches here without a hold (it closes on the quarry instead),
    // but the fallback stays honest rather than free: with no wall, the thing that is not
    // working is the square we are STANDING on, so count against that. A counter that
    // silently stops counting is the failure this whole file keeps paying for.
    const me = this.s?.client?.self;
    const here = this.s?.world?.room?.num;
    const at = (spot?.room != null && spot?.col != null && spot?.row != null) ? spot
      : (here != null && me?.col != null && me?.row != null
          ? { room: here, col: me.col, row: me.row } : null);
    if (at == null)
      return { relocate: false, attempt: 0, limit: this.policy.pullsBeforeMovingOn ?? 4 };
    const id = `${at.room}:${at.col},${at.row}`;
    (this.pullFailures ??= new Map());
    const attempt = (this.pullFailures.get(id) ?? 0) + 1;
    this.pullFailures.set(id, attempt);
    const limit = this.policy.pullsBeforeMovingOn ?? 4;
    if (attempt < limit) return { relocate: false, attempt, limit };
    // A WALL THE QUARRY CANNOT BE PULLED TO IS NOT A BAD WALL — IT IS A DISTANT ONE.
    //
    // This used to add the square to the removed `barrenSpots` set and return `retired: true`, which
    // released the hold and — three walls later, via pullDidNotConvert/noWallRooms —
    // abandoned wall-fighting for the whole room. But a failed *reach* is about the
    // geometry BETWEEN us and the monster, not about the square we stand on: the common
    // cause is prey a couple of dozen cells away across ground the coarse pather cannot
    // cross. The square may be a perfect wall for a monster standing beside it. So this
    // never blacklists and never abandons the strategy — it tells the caller to RELOCATE
    // to a wall closer to the quarry and pull from there. Piggy and Lew, Valley of Ileria
    // 2026-08-27: prey 26-44 cells off, every wall they took was too far, and the old path
    // walked them in circles retiring good walls. The counter and note stay, for the log
    // and to pace the relocation; the failed wall's budget is reset so the next one gets
    // its own.
    this.pullFailures.set(id, 0);
    this.note('this wall cannot reach the quarry — trying one closer to it', {
      at: { col: at.col, row: at.row }, room: at.room, attempts: attempt, why,
      from_hold: spot != null,
      note: 'not a bad square, just too far from the prey to pull it; relocating nearer, never blacklisting' });
    return { relocate: true, attempt, limit };
  }

  // Contact with THE THING WE PULLED happened, so the pull converted. An unrelated
  // attacker reaching the wall proves only that it can reach us; it says nothing about
  // the groundworm (or other named quarry) whose full follow window is pending. Treating
  // any defensive swing as conversion reset the quarry's attempt to one forever in
  // mixed-spawn rooms.
  pullConverted(foeId = null, foeName = null) {
    if (this.pendingPull?.target_id != null && foeId !== this.pendingPull.target_id) {
      if (!this.pendingPull.otherContactNoted) {
        this.pendingPull.otherContactNoted = true;
        this.note('another creature reached the wall — the pull test is still open', {
          pulled: this.pendingPull.target,
          pulled_id: this.pendingPull.target_id,
          fought: foeName,
          fought_id: foeId,
          why: 'contact is evidence only for the creature that made contact; unrelated ' +
               'defensive combat cannot prove that the pulled quarry followed',
        });
      }
      return false;
    }
    this.pullsWithoutContact = 0;
    this.pendingPull = null;
    this.pulledLastPass = false; // clear state left by an older in-process keeper
    this.pullFailures?.clear();
    return true;
  }

  // DOES WHAT WE ARE KILLING STILL PAY FOR WHAT WE SAID WE WERE FARMING?
  //
  // The one question the stall detector structurally cannot ask. noProgress() fires when
  // nothing WORKS; this fires when everything works and none of it is worth anything.
  // They are different failures and they need different words, because the second one
  // wears the first one's healthy face.
  //
  // Returns null when it cannot know — no purpose set, no spawn index, prey not in the
  // index, vitals not read yet. Null means "no opinion", never "fine".
  /**
   * IS THE ROOM UNDER THIS CHARACTER'S FEET ONE THAT MAKES ITS QUARRY?
   *
   * `yieldCheck` asks whether the quarry is worth killing. It never asks whether the quarry is
   * HERE, so a character hunting skeletons in a room where no skeleton can spawn passes the one
   * audit that exists to catch a keeper earning nothing, and renders as `hunting: skeleton` —
   * the healthy string — on every board.
   *
   * MEASURED, prod, 2026-09-18: four to seven characters of twenty-three were in this state at
   * every one of sixty one-minute samples, spanning three configuration changes, none of which
   * moved it. Zoot hunting skeletons in the Bookmakers guild hall; Scooter hunting zombies in a
   * town room; Statler hunting skeletons in the Cragged Mountains, which makes black spiders and
   * trolls. All three assigned to 38 or 39.
   *
   * IT DOES NOT TRY TO FIX IT, and that is deliberate. `shouldRelocateToAssignedRoom` opens with
   * `if (movementLeased) return false`, and a bot that holds movement is the thing entitled to
   * decide where this character stands. Walking home from here would be the keeper taking back a
   * faculty it has given away. What the keeper owes is the TRUE SENTENCE, so that the bot, the
   * board and the next post-mortem can all see the state rather than reading it as work.
   */
  huntRoomCheck() {
    const want = this.policy?.hunt;
    if (!want || this.mode !== 'farm') return null;
    const room = this.s.world?.room?.num ?? this.s.client?.room?.num ?? null;
    if (room == null) return null;
    const spawns = loadSpawns(SPAWN_FILE);
    if (!spawns) return null;
    // `standingHere` is what turns "this room is not in the index" from missing data into an
    // answer: the body is in it, so it is a room, so an absent entry means it makes nothing.
    return huntRoomYield(spawns, room, want, { standingHere: true });
  }

  yieldCheck() {
    const { purpose, goals, hunt } = this.policy;
    if (!purpose || !hunt) return null;
    // AN UNRECOGNISED PURPOSE IS REPORTED, NOT IGNORED.
    //
    // This read `if (purpose !== 'advance') return null`, so every other value — a typo, a
    // purpose added later, or `equip` before it existed — silently turned the check OFF
    // and rendered as an ordinary healthy row. That is the exact failure this function was
    // written to catch, reachable by misspelling one word.
    if (!YIELD_PURPOSES.includes(purpose))
      return { paying: false, purpose,
               why: `\`${purpose}\` is not a purpose this keeper knows how to check ` +
                    `(${YIELD_PURPOSES.join(', ')}), so nothing is being measured`,
               hint: 'a purpose nobody recognises must not read the same as a purpose ' +
                     'being served — fix the spelling or clear policy.purpose' };

    const spawns = loadSpawns(SPAWN_FILE);
    if (!spawns) return null;
    // AN EXACT NAME MUST NOT RESOLVE TO A DIFFERENT CREATURE, AND SUBSTRING-FIRST MEANT IT
    // USUALLY DID.
    //
    // This was one `.find` on `name.includes(needle)`, so `hunt: "skeleton"` returned
    // whichever qualifying creature came first in the map — **battered skeleton**, level
    // 60 — rather than the skeleton, level 75. Observed live: the Castle fleet was
    // retargeted from the battered skeleton it had outgrown onto the full one, arrived in
    // room 38, and every row rendered `hunting: skeleton — PAYS NOTHING for advance`
    // while the kills it was making paid perfectly well. The audit was judging a creature
    // the character was not fighting, and the one it picked is the weakest of the four
    // that match — so the error is always in the direction of understating the prey.
    //
    // THE SUBSTRING FALLBACK STAYS, because it is load-bearing elsewhere: all three
    // faction troops are `... soldier`, and one substring is what catches them as a
    // family. So this is exact name, then exact class, then the old behaviour — a
    // deliberately loose name keeps working and a precise one stops being approximated.
    //
    // That rule is now huntedCreatures() in m59-spawns.mjs, and this reads it rather
    // than keeping its own copy: it was the third spelling of the same question and the
    // only one that had been got right, which is precisely how the other four went on
    // being wrong. A family order still lands on the first of its members here — one
    // audit cannot describe three creatures — and that is unchanged.
    const c = huntedCreatures(spawns, hunt)[0];
    if (!c) return null;

    // FARMING TO CLOSE THE GEAR GAP IS A REAL JOB, AND IT OUTLIVES ADVANCEMENT.
    //
    // Ten characters here are at max health 50, and a level-50 fungus beast cannot advance
    // any of them — the rule is strictly greater. That does not make their day worthless:
    // they are out for gear and coin. `equip` is how a keeper says so, and it is checked
    // rather than merely declared, because "farming for kit" is otherwise an excuse that
    // can never be wrong. See equipYield in m59-loadout.mjs.
    if (purpose === 'equip') return this.equipCheck(c);

    if (!goals?.length)
      return { paying: false, why: 'purpose is `advance` but no goals are set, so nothing ' +
                                   'can be checked — set policy.goals or clear policy.purpose' };
    const maxHealth = this.s.client?.vitals?.()?.health?.max ?? 0;
    if (!maxHealth) return null;
    // Stamina only moves the hit-point CEILING. Unknown is reported as unknown rather
    // than as 0, because 0 would put the ceiling at 101 and declare a healthy character
    // finished twenty hit points early.
    const stamina = this.s.client?.statsById?.get?.('stamina')?.value;
    const known = Number.isFinite(stamina) && stamina > 0;
    const ys = goals.map(g => goalYield(g, c, { maxHealth, stamina: known ? stamina : 0 }));
    const paying = ys.filter(y => y.pays);
    if (paying.length)
      return { paying: true, creature: c.name, level: c.level,
               for: paying.map(y => y.goal) };
    // Suppress a "finished" verdict we are not entitled to.
    const trustworthy = ys.filter(y => known || !y.done);
    if (!trustworthy.length) return null;
    return {
      paying: false, creature: c.name, level: c.level,
      why: trustworthy.map(y => `${y.goal} — ${y.why}`),
      hint: 'this keeper is working and gaining nothing. Re-target it with the `prey` ' +
            'tool; nothing in here will re-target it for you.',
      ...(known ? {} : { caveat: 'stamina unknown, so the hit-point ceiling was not checked' }),
    };
  }

  // The `equip` half of yieldCheck. Costs a stat() and some arithmetic — no request — so
  // it is safe on the path that renders the board every few seconds.
  equipCheck(creature) {
    const l = this.loadout();
    // NO LOADOUT IS NOT AN EMPTY LOADOUT. Everywhere else in this file a missing loadout
    // means "carry on as before" and is answered with null; here it means the question
    // cannot be asked at all, because the list of what this character needs IS the
    // loadout. Saying so beats reporting a gap of zero, which would read as "finished".
    if (!l)
      return { paying: false, purpose: 'equip',
               why: 'purpose is `equip` but this character has no loadout, so there is no ' +
                    'list of what it is short of',
               hint: 'write one in the planner (P on the fleet terminal), or clear ' +
                     'policy.purpose if it is out here for coin rather than kit' };
    const plan = reconcile(l, { items: this.packAsItems(), equipped: this.equippedNames() });
    const y = equipYield(plan, creature);
    if (!y) return null;
    return { paying: !!y.pays, purpose: 'equip', creature: y.creature,
             ...(y.pays ? { for: y.for } : {}),
             ...(y.done ? { done: true } : {}),
             ...(y.why ? { why: y.why } : {}),
             ...(y.short_of ? { short_of: y.short_of } : {}),
             ...(y.hint ? { hint: y.hint } : {}) };
  }

  // What the SERVER says is worn, in the shape reconcile() reads. The use list is the
  // authority — see wearArmourIfNeeded — because a pack holding leather and a character
  // fighting in its shirt look identical from the inventory alone.
  equippedNames() {
    const c = this.s.client;
    const using = skills.equippedNow(c);
    if (!c || !using) return [];
    return (c.inventory || []).filter(o => using.has(o.id))
      .map(o => ({ name: c.rsc.get(o.nameRsc) || '' }));
  }
  // @end 2
}
