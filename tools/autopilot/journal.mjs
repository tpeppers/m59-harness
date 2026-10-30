// THE JOURNAL: progress, refusals, notes, debug lines, telling the pilot, ledger events.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 21 methods: progress, noProgress, blinkFree, terminalMovement, refuse, clearRefusal, waitFor,
//   doneWaiting, note, flagDebug, debugLines, tellPilot, recordJourneyIncident, ledgerEvent,
//   bookFor, recordCast, declinedCast, recordPurchase, recordHealUse, spellSummary,
//   declinedPurchase
import { recordEvent } from '../m59-ledger.mjs';
import { isTerminalMovementReason } from '../m59-movement.mjs';
import { OF } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { traceSurvivalNote } from '../m59-survival-trace.mjs';
import { waitForBlinkCast } from '../m59-traffic-blink.mjs';
import { BLINK_COOLDOWN_MS, BLINK_MANA, DEBUG_STATES, DEBUG_TELLS_ON, DEBUG_TELL_COOLDOWN_MS, REST_VIGOR_CAP, STALL_NO_LEVER_REPEATS, bearingIn, journeyIncident, pilotedNow, stallLever, tellCooldown, tellSuppressed, vigorOf } from '../m59-autopilot.mjs';

export class JournalPart {
  // @part 1

  // Something useful happened; clear the stall.
  progress(why) {
    this.idlePasses = 0;
    this.stalledSince = null;
    this.stalledWhy = null;
    // The repeat run and the declaration go with it. A character that has done something
    // is not in the loop any more, and leaving `STALL_NO_LEVER` standing would make the
    // refusal outlive the condition — which is the failure `since` was added to avoid.
    this.stallRepeats = 0;
    this.stalledLever = null;
    this.lastNoProgressWhy = null;
    if (this.refusals?.has('STALL_NO_LEVER')) this.clearRefusal('STALL_NO_LEVER');
    if (why) this.lastProgress = { at: Date.now(), why };
  }

  // Nothing useful happened. After a few of these in a row, say so out loud.
  noProgress(why) {
    this.idlePasses++;
    const reason = String(why ?? '');
    // Same sentence again, or a different way of failing? See STALL_NO_LEVER_REPEATS.
    this.stallRepeats = reason && reason === this.lastNoProgressWhy
      ? (this.stallRepeats ?? 0) + 1 : 1;
    this.lastNoProgressWhy = reason;
    // WHAT COULD ACT ON THIS, NAMED. `null` is an answer and it is the interesting one.
    const lever = stallLever(reason);
    this.stalledLever = lever;
    if (this.idlePasses >= 5 && !this.stalledSince) {
      this.stalledSince = Date.now();
      this.stalledWhy = why;
      this.note('STALLED', { why, passes: this.idlePasses, lever,
                             hint: 'nothing has worked for several passes running' });
    } else if (this.stalledSince) this.stalledWhy = why;
    // A STALL THAT IS ABOUT GETTING OUT OF A ROOM HAS A SPELL FOR IT — see blinkFree.
    // Flagged rather than cast, because this is called from synchronous code deep in the
    // pass and casting is several seconds of protocol.
    if (this.idlePasses >= 5 && lever === 'blink')
      this.wantsBlink = { why, at: Date.now() };
    // AND A STALL NOTHING CAN ACT ON IS DECLARED RATHER THAN ENDURED.
    //
    // Not a cure — there is no verb here that fixes an unknown loop, and inventing one is
    // how a fleet gets 107 room-flees and 0 kills. What this fixes is that the state was
    // INVISIBLE: `stuck.since` advanced for 27 minutes while every reader saw a number
    // going up and no way to tell it from a character being patient. A code on
    // `status.refusals` is the one channel the supervisor and the fleet board already read
    // as data, and it carries the sentence that is repeating, so whoever is on shift can
    // see WHICH loop rather than that there is one.
    if (!lever && this.stallRepeats >= STALL_NO_LEVER_REPEATS) {
      if (!this.refusals?.has('STALL_NO_LEVER'))
        journeyIncident(this, { kind: 'stall', outcome: { reason: `stalled with no lever: ${reason}` },
          to: this.suspendedJourney?.to ?? this.inert?.to ?? null,
          startedIn: Number(this.s?.world?.room?.num ?? NaN) || null, startedAt: Date.now(),
          origin: this.s?.moveOrder?.origin ?? null });
      if (!this.refusals?.has('STALL_NO_LEVER'))
        this.note('STALLED WITH NO LEVER', {
          why: reason, repeats: this.stallRepeats, passes: this.idlePasses,
          room: this.s?.world?.room?.num ?? null,
          note: 'the same reason this many times running is a loop its own inputs cannot ' +
                'leave, and no lever in this keeper matches it. Declaring it so somebody ' +
                'can, rather than counting to a thousand quietly' });
      this.refuse('STALL_NO_LEVER', {
        faculty: 'work', blocking: true,
        why: `the same stall ${this.stallRepeats} times running, and nothing here can act ` +
             `on it: ${reason}`,
        remedy: 'a keeper restart clears keeper-local state and is worth ONE try; if the ' +
                'same reason comes back it is deterministic, and what it needs is a ' +
                'different room, different orders, or a fix',
        retryAfterMs: 300_000,
      });
    }
  }

  /**
   * BLINK IS THE WAY OUT OF A PLACE YOU CANNOT WALK OUT OF, and it is the game's own
   * answer rather than ours.
   *
   * Riija level 1, 15 mana, no reagents, no target. It relocates you within the room, and
   * the guarantee that matters is that it lands you somewhere you can reach at least one
   * exit from. In the Cragged Mountains it is the ONLY way onto the upper cliff — there is
   * no walking route there from the lower entrance, so a router that refuses to plan one
   * is right and a character that keeps trying is not.
   *
   * WHY THIS IS NEEDED NOW. Movement is validated against the client's collision model as
   * of #18, and that model is stricter than what the old code sent. Characters that the
   * old code had walked into places the model does not accept were left marooned — not
   * standing in a wall exactly, but with no step the mover will take. Every one of them
   * re-planned the same impossible route every pass. Outside Castle Victoria and North
   * Barloque both produced one.
   *
   * BOUNDED, because a spell that fires on every stalled pass is a mana leak that also
   * teleports a working character away from its safe spot. One attempt per cooldown, only
   * when the stall is about MOVEMENT, and never below the mana a cast costs.
   */
  async blinkFree({ cooldownMs = BLINK_COOLDOWN_MS } = {}) {
    const want = this.wantsBlink;
    if (!want) return null;
    this.wantsBlink = null;
    if (Date.now() - (this.blinkedAt ?? 0) < cooldownMs) return null;
    const s = this.s, c = s.client;
    if (!c) return null;
    const mana = c.vitals?.()?.mana?.value ?? null;
    if (mana !== null && mana < BLINK_MANA)
      return this.note('would blink free, but cannot afford it',
        { mana, needs: BLINK_MANA, why: want.why,
          note: 'mana comes back by resting; this is not a permanent refusal' });
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'blink');
    if (!spell) return this.note('stuck, and this character does not know blink',
      { why: want.why, note: 'Riija 1 — the only in-room escape the game offers' });

    const before = c.self ? { room:s.world?.room?.num??null,col: c.self.col, row: c.self.row } : null;
    const generation=s.movementGeneration;
    this.blinkedAt = Date.now();
    await s.pacer.submit('cast', () => c.cast(spell.id, []), 1050).catch(() => {});
    const quiet=await waitForBlinkCast(s.pacer,{sentAt:c.lastCastSent?.at??this.blinkedAt,cancelled:()=>s.movementWasCancelled?.(generation)===true});
    if(!quiet.quiet)return {moved:false,cancelled:quiet.cancelled===true,why:quiet.why??'blink cancelled'};
    // THE POSITION IS THE EVIDENCE, not the cast reply. A cast that reports success and
    // leaves the character where it was is the same shape as every other silent refusal
    // in this game, and the whole point here is whether we MOVED.
    await new Promise(r => setTimeout(r, 1200));
    await s.pacer.submit('read', () => c.roomContents()).catch(() => {});
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 }).catch(() => {});
    const after = c.self ? { room:s.world?.room?.num??null,col: c.self.col, row: c.self.row } : null;
    const moved = !!(before && after && (before.room!==after.room||before.col !== after.col || before.row !== after.row));
    this.tally.blinks = (this.tally.blinks || 0) + 1;
    this.note(moved ? 'blinked free' : 'blinked and did not move', {
      from: before, to: after, why: want.why, mana_before: mana,
      because: 'the collision model would not take any step from there; blink is the ' +
               'game\'s own way out and lands somewhere an exit is reachable from',
    });
    if (moved) {
      // A new square is a new situation: forget the safe spot we were holding and let the
      // ordinary pass decide again with fresh geometry.
      this.releaseHold?.('blinked to a different square');
      this.progress('blinked out of somewhere unwalkable');
    }
    return { moved, from: before, to: after };
  }

  // A COLLISION-CONTRACT FAILURE IS NOT AN OCCUPIED SQUARE OR A BAD TACTIC.
  //
  // Every keeper movement path uses this one classification seam. Retrying a missing,
  // stale, mismatched, or live-mutated room geometry contract cannot produce a better
  // route; it only burns retry budgets and eventually teaches the wrong room lesson.
  // Preserve the exact machine-readable reason, leave ordinary retry counters alone,
  // and surface the recovery action to the controller.
  terminalMovement(result, context, detail = {}) {
    if (!isTerminalMovementReason(result?.reason)) return null;
    // EVERY KEEPER MOVEMENT PATH COMES THROUGH HERE, which is why the grind tracker is fed
    // from this seam rather than from each caller. It sees the TERMINAL class only -- the
    // collision-contract refusals -- so `wall_contact` today means "the geometry said no",
    // not "any step that failed". Ordinary refusals (a body in the way, a door wanting the
    // exact square) do not pass through this function and are not yet counted; the shuffle
    // half needs no refusal at all and sees everything.
    this.grindRefusal = result.reason;
    this.stalledSince ??= Date.now();
    this.stalledWhy = `${context} stopped: ${result.reason}`;
    // This writes the stall directly rather than through noProgress, so it has to name its
    // own lever — otherwise `stuck.lever` would report whatever the last ordinary stall
    // decided, which is a stale answer to the one question a reader is asking here.
    this.stalledLever = stallLever(this.stalledWhy);
    this.note(`${context} stopped by the local collision contract`, {
      ...detail,
      reason: result.reason,
      note: result.note,
      recovery: 'refresh/re-enter with matching room geometry; do not retry or classify the room',
    });
    return {
      terminal: true,
      reason: result.reason,
      note: result.note,
      why: result.note ?? result.reason,
    };
  }

  // A REFUSAL IS NOT A STALL, AND SAYING SO IN PROSE MADE SOMETHING ELSE PARSE PROSE.
  //
  // A keeper that will not fight in a room with no safe wall, or that is sitting to
  // accumulate the 15 mana `create weapon` needs, is doing exactly the right thing — and
  // from outside it is indistinguishable from a character doing nothing. The external
  // supervisor told the two apart with regular expressions over this file's own sentences:
  //
  //     if (/no safe wall|refusing to fight/i.test(reason)) …
  //     if (/needs \d+ to make one|resting for the mana|regain mana|unarmed —/i.test(reason)) …
  //
  // Both exist because of recorded loops. Restarting a keeper that refused a room throws
  // away the session record of WHICH rooms it refused, so the fresh keeper walks back in,
  // re-probes, refuses again and reports a stall again — once a minute, for ever, with
  // every log line looking like the supervisor working. Eight characters were caught in
  // that inside a minute. The mana one is the same shape: Sweetums sat at 4 of 18, Animal
  // at 11, Zoot at 13, each restarted every 90 seconds, each re-deciding rather than
  // waiting, all three bare-handed.
  //
  // The coupling is to SENTENCES, and the sentences belong to this file. Reword one and
  // the fleet starts churning again with nothing to say so. So the reason becomes data:
  // a stable code that is never localised, the faculty it blocks, whether it is blocking
  // at all, and when to look again. Anything outside reads the code; the prose stays for
  // people.
  //
  // `refusals` are conditions that persist until cleared. `waitingOn` is the outward half
  // of progress() — the difference between STUCK and DELIBERATELY WAITING, which is the
  // distinction the whole supervisor problem turns on.
  refuse(code, { faculty = 'work', blocking = true, why = '', remedy = null,
                 retryAfterMs = null } = {}) {
    const had = this.refusals?.get(code);
    (this.refusals ??= new Map()).set(code, {
      code, faculty, blocking, why, remedy,
      retry_after_ms: retryAfterMs,
      // `since` survives a refresh: how long a character has been refusing is the
      // question a reader actually asks, and restamping it on every pass would answer
      // "no time at all" for ever.
      since: had?.since ?? Date.now(),
    });
    return code;
  }

  clearRefusal(code) { this.refusals?.delete(code); }

  // Deliberately waiting for something that arrives on its own — mana, a stomach, a
  // respawn. One at a time, because a character waits for one thing.
  waitFor(code, { expectedMs = null, why = '' } = {}) {
    this.waitingOn = { code, expected_ms: expectedMs, why, since: Date.now() };
  }
  doneWaiting() { this.waitingOn = null; }

  // A DETAIL FIELD MUST NOT BE ABLE TO EAT THE RECORD'S OWN KEYS.
  //
  // This was `{ at: Date.now(), pass, what, ...detail }` — spread LAST — which is the
  // same shape CLAUDE.md documents for `emit(kind, data)` and for `recordEvent`, and it
  // failed the same way. `note('hitting back', { at: engageName, ... })` overwrote the
  // timestamp with "soldier of the Princess' army", so the one journal line that
  // explains why Waldorf picked a fight with four guards is the one line that cannot be
  // placed in time. The write succeeded; the record lied.
  //
  // Reserved keys are therefore applied AFTER the spread, so a colliding detail field is
  // inert rather than silent. It is preserved under `detail_<key>` rather than dropped,
  // because a caller that passed it meant something by it — see `detail_at` on the
  // retaliation note, which is the creature's name.
  note(what, detail = {}) {
    traceSurvivalNote(this.s, what, detail);
    const e = { ...detail };
    for (const k of ['at', 'pass', 'what'])
      if (k in e) { e[`detail_${k}`] = e[k]; delete e[k]; }
    e.at = Date.now(); e.pass = this.passes; e.what = what;
    this.lastDecision = { ...e, stage: this.passStage ?? null };
    this.journal.push(e);
    if (this.journal.length > 200) this.journal.splice(0, this.journal.length - 200);
    if (what in DEBUG_STATES) this.flagDebug(what, e);
    return e;
  }

  // ------------------------------------------------------------------ debugging states
  //
  // Note it as usual, then keep the whole thing where the chat interface can find it and
  // push it to whoever has a client open. Called from note() rather than from the three
  // sites, so a state cannot be flagged in one place and forgotten in another.
  flagDebug(what, entry) {
    const c = this.s.client, me = c?.self;
    const room = this.s.world?.room, geo = this.s.world?.geometry;
    const v = c?.vitals?.() ?? {};
    this.debug = {
      what, label: DEBUG_STATES[what], at: Date.now(), pass: this.passes,
      room: room?.name ?? null, room_num: room?.num ?? null,
      col: me?.col ?? null, row: me?.row ?? null,
      grid: geo ? { rows: geo.rows, cols: geo.cols } : null,
      bearing: geo && me ? bearingIn(me.row, me.col, geo.rows, geo.cols) : null,
      on_floor: geo && me ? geo.walkable(me.row, me.col) : null,
      doing: this.doing ?? null, mode: this.mode, hunting: this.policy.hunt ?? null,
      health: v.health?.value ?? null, health_max: v.health?.max ?? null,
      vigor: vigorOf(v), rest_ceiling: this.restVigorCap() * skills.VIGOR_MAX,
      holding: this.hold ? { col: this.hold.col, row: this.hold.row, proven: this.hold.proven } : null,
      monsters: c?.room ? [...c.room.objects.values()].filter(o =>
        o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)).length : null,
      detail: entry,
    };
    this.debugSeen = this.debugSeen || {};
    this.debugSeen[what] = (this.debugSeen[what] || 0) + 1;
    this.tellPilot(this.debug).catch(() => {});   // never let a tell break a pass
  }

  // The full state as lines of prose, which is what both the tell and the in-game answer
  // want. Everything the journal entry carries is here — the entry is spread last so a
  // state-specific field (`considered`, `unreachable`, `spot`, `left_s`) is never lost.
  debugLines(d = this.debug) {
    if (!d) return ['nothing flagged — I am not in one of the three states being chased.'];
    const at = d.col != null ? `col ${d.col}/${d.grid?.cols ?? '?'}, row ${d.row}/${d.grid?.rows ?? '?'}` : 'position unknown';
    const lines = [
      `[${d.label}] ${d.room ?? 'unknown room'} (${d.room_num ?? '?'})`,
      `at ${d.bearing ?? 'somewhere'} — ${at}${d.on_floor === false ? ' — STANDING OFF THE FLOOR' : ''}`,
      `doing: ${d.doing ?? '?'} | mode ${d.mode} | hunting ${d.hunting ?? 'nothing'}`,
      `hp ${d.health ?? '?'}/${d.health_max ?? '?'} | vigor ${d.vigor ?? '?'} (rest cap ${d.rest_ceiling})`,
      `monsters here: ${d.monsters ?? '?'} | holding: ${d.holding ? `${d.holding.col},${d.holding.row}` : 'no spot'}`,
      `seen ${this.debugSeen?.[d.what] ?? 1}x this run`,
    ];
    // Whatever the specific state recorded, minus the keys already spoken above.
    const skip = new Set(['at', 'pass', 'what', 'why', 'note', 'hint']);
    const extra = Object.entries(d.detail || {})
      .filter(([k, v]) => !skip.has(k) && v != null && typeof v !== 'object')
      .map(([k, v]) => `${k}=${v}`);
    if (extra.length) lines.push(extra.join(' '));
    if (d.detail?.why) lines.push(`why: ${d.detail.why}`);
    return lines;
  }

  // SEND IT TO WHOEVER IS ACTUALLY HOLDING A CHARACTER, and to nobody otherwise.
  //
  // The recipient is not configured and cannot be: it is whichever of the fleet's own
  // characters a desktop client is currently piloting, which the broker knows because IT
  // spawned that client and can see the pid. No pilot means no tell — this must never
  // pick a name and message a stranger on a shared server.
  async tellPilot(d) {
    // OFF UNLESS SOMEBODY ASKS FOR IT, AND ASKING IS PER-SESSION.
    //
    // This speaks in-game, on a live server shared with other players, from twenty-one
    // characters at once. Even rate-limited to one tell per character per condition per
    // five minutes, three conditions across twenty-one characters is a steady trickle of
    // chatter that a person standing nearby sees, that costs mana, and that — per the
    // note below about UserSayGroup — is an ACTION, so it wakes the room's AIs.
    //
    // A debugging instrument should not be the fleet's default voice. It stays available
    // for the case it was built for (stand next to a character and have it explain
    // itself) but has to be turned on deliberately:
    //
    //   M59_DEBUG_TELLS=1 node tools/m59-broker.mjs ...
    //
    // Checked here rather than at the two call sites so there is one switch and no way to
    // add a third caller that misses it.
    if (!DEBUG_TELLS_ON) return { sent: false, why: 'debug tells are off (set M59_DEBUG_TELLS=1)' };
    const p = pilotedNow();
    if (!p || !p.character) return { sent: false, why: 'nobody is piloting a character' };
    if (p.agent === this.s.name) return { sent: false, why: 'that is this character' };
    const key = `${this.s.name}|${d.what}`;

    // NEVER SPEAK WHILE PLAYING DEAD. This is a backstop, not the mechanism.
    //
    // Settled from the server rather than guessed at. A tell runs UserSayGroup, which
    // begins:
    //
    //   % User took an action!  Wake any AIs in the room to the user's presence!
    //   if NOT (piFlags & PFLAG_MOVED_SINCE_ENTRY)
    //   { Send(self,@NotifyMonstersOfPresence); }        user.kod:4171
    //
    // UserSay carries the identical guard at user.kod:4052. So speech IS an action in the
    // one state where that matters: between the reconnect and the unfreeze the flag is
    // clear, and a single tell hands back the grace period the freeze exists to buy — on
    // a character that is, by definition, too hurt to survive the room noticing it.
    //
    // The freeze report is therefore sent from playDead() BEFORE the reconnect, where the
    // flag is still set from all the walking and swinging and the wake branch does not
    // run. That is both free and earlier. Anything still trying to speak in here is a
    // caller that has not been through that path, and it is refused rather than trusted.
    if (this.frozenUntil && Date.now() < this.frozenUntil) {
      tellSuppressed.set(key, (tellSuppressed.get(key) ?? 0) + 1);
      return { sent: false, why: 'playing dead — a tell would wake the room (user.kod:4171)' };
    }

    const last = tellCooldown.get(key) ?? 0;
    const since = Date.now() - last;
    if (since < DEBUG_TELL_COOLDOWN_MS) {
      const q = tellSuppressed.get(key) ?? 0;
      tellSuppressed.set(key, q + 1);
      return { sent: false, why: `cooled down, ${Math.round((DEBUG_TELL_COOLDOWN_MS - since) / 1000)}s left` };
    }
    const c = this.s.client;
    if (!c || !this.s.live) return { sent: false, why: 'not in game' };

    // Resolve the recipient by NAME through the online roster, the same way the `say`
    // tool does. Object ids are reissued by `save game`, so a stored id can silently
    // address the wrong thing; a name that is not logged on simply finds nobody.
    let id = null;
    try {
      await this.s.pacer.submit('read', () => c.players());
      await c.waitFor({ kinds: ['who'], timeoutMs: 3000 });
      const want = String(p.character).toLowerCase();
      id = [...c.playersOnline.values()].find(x => x.name && x.name.toLowerCase() === want)?.id ?? null;
    } catch { /* fall through to "not found" */ }
    if (id == null) return { sent: false, why: `${p.character} is not in the online roster` };

    const suppressed = tellSuppressed.get(key) ?? 0;
    tellSuppressed.set(key, 0);
    tellCooldown.set(key, Date.now());
    const head = `${this.s.name}: ${d.label}` +
                 (suppressed ? ` (+${suppressed} more in the last ${Math.round(DEBUG_TELL_COOLDOWN_MS / 60000)}m)` : '');
    // One tell per line rather than one long one: the server truncates a long say, and a
    // truncated tell would drop exactly the tail detail this exists to deliver. Capped,
    // and the cap is stated rather than silent.
    const lines = [head, ...this.debugLines(d).slice(1)];
    const MAX = 6;
    const send = lines.slice(0, MAX);
    if (lines.length > MAX) send.push(`(+${lines.length - MAX} more lines — ask me "debug" in game)`);
    for (const line of send) {
      try {
        await this.s.pacer.submit('say', () => c.sayGroup([id], line.slice(0, 200)));
      } catch { break; }        // out of mana, or the pilot logged off mid-send
    }
    return { sent: true, to: p.character, lines: send.length };
  }

  // Into the LONG record, keyed by character name, so it survives the keeper.
  //
  // The journal above is the flight recorder — 200 entries, gone when the broker
  // restarts, and the broker restarts often. An audit of what a character decided over
  // a week cannot live there. Bookkeeping must never break play, so this swallows
  // everything: a character with no name yet is simply not recorded.
  // ONE MOVEMENT INCIDENT (m59-movement-incidents.mjs): where the body stood, what it was trying
  // to reach, the route and the hop, why it failed and WHO cancelled it, the last few positions,
  // health and the crowd. Deduped in the log, so a retry loop is one incident with a count.
  // Never throws: the record must not break the play it is recording.
  recordJourneyIncident(args = {}) { return journeyIncident(this, args); }

  ledgerEvent(kind, detail = {}) {
    const who = this.s.client?.me?.name;
    if (!who) return;
    try { recordEvent(who, kind, { agent: this.name ?? this.s.name ?? undefined, ...detail }); }
    catch { /* never let the record break the play it is recording */ }
  }

  bookFor(spell) {
    const name = String(spell || 'unknown').toLowerCase();
    let b = this.spellbook.by_spell[name];
    if (!b) b = this.spellbook.by_spell[name] =
      { cast: 0, produced: 0, nothing: 0, mana_spent: 0, declined: {} };
    return b;
  }

  // A CAST THAT HAPPENED, with what it cost and what came back.
  //
  // `ok` is decided by the CALLER, from an inventory diff or a stat change, never from
  // the absence of an error — the server does not send one. `why` is the decision that
  // led here, and it is the field the audit is actually for: "cast create food" is a
  // fact, "cast create food because the larder was empty and a shop was four rooms
  // away" is a decision someone can disagree with.
  //
  // `outcome` is what the cast came to when the caller could tell (m59-trance.mjs practiceOutcome: completed, failed
  // roll, broken, refused), counted per spell and written to the ledger, so "how many trances broke" has an answer.
  recordCast(spell, { ok = false, made = [], why = null, target = null, outcome = null,
                      mana_before = null, mana_after = null, reagents_before = null } = {}) {
    const name = String(spell || 'unknown').toLowerCase();
    const b = this.bookFor(name);
    b.cast++;
    if (ok) b.produced++; else b.nothing++;
    if (outcome) (b.outcomes ||= {})[outcome] = (b.outcomes[outcome] || 0) + 1;
    // Only when both readings are real and the mana went DOWN. A cast that completes as
    // the character regenerates can read as negative, and a guessed cost is worse than
    // no cost — it would be summed into a fleet total and quietly believed.
    const cost = (typeof mana_before === 'number' && typeof mana_after === 'number'
                  && mana_before >= mana_after) ? mana_before - mana_after : null;
    if (cost != null) b.mana_spent += cost;
    const e = { at: Date.now(), pass: this.passes, spell: name, ok: !!ok, why, outcome: outcome || undefined,
                made: made.length ? made : undefined, target: target || undefined,
                mana_cost: cost ?? undefined, reagents_before: reagents_before || undefined };
    this.spellbook.casts.push(e);
    if (this.spellbook.casts.length > 60)
      this.spellbook.casts.splice(0, this.spellbook.casts.length - 60);
    this.ledgerEvent('cast', { spell: name, ok: !!ok, why, outcome: outcome || undefined, target: target || undefined,
                               made: made.length ? made : undefined,
                               mana_cost: cost ?? undefined, reagents_before: reagents_before || undefined });
    return e;
  }

  // A CAST IT DECIDED AGAINST, and the reason.
  //
  // Counted every time; written to the long ledger at most once every ten minutes per
  // (spell, reason). provision() runs every pass and a pass is eight seconds, so a
  // character that has been two herbs short since lunch would otherwise write four
  // hundred identical lines a day — twenty-one of those, into a file nothing rotates.
  // The count is the interesting part anyway; the line is only there to date it.
  declinedCast(spell, why, detail = {}) {
    const name = String(spell || 'unknown').toLowerCase();
    // KEEP THE LAST REASON, because the refusal that reports this to an operator is raised
    // somewhere else entirely and had no way to see it. `UNARMED_NO_DONOR` spent seven hours
    // telling an operator a character needed mana it already had, because all it could see
    // was its own precondition chain and not the answer `makeWeapon` had actually given.
    this.lastDeclinedCast = { spell: name, why: String(why ?? ''), at: Date.now() };
    const b = this.bookFor(name);
    b.declined[why] = (b.declined[why] || 0) + 1;
    const key = name + '/' + why;
    const last = this.spellbook.declined_logged.get(key) || 0;
    if (Date.now() - last >= 600_000) {
      this.spellbook.declined_logged.set(key, Date.now());
      this.ledgerEvent('cast_declined', { spell: name, why, times_so_far: b.declined[why], ...detail });
    }
    return false;
  }

  // WHAT IT BOUGHT AND WHY, one line per item.
  //
  // `kind` is the audit's actual question — reagent or food. The fleet's supply plan is
  // to cast rather than shop, and reagents at a counter it is already standing at are
  // the cheap top-up that makes casting possible; food bought outright is the fallback
  // that admits the casting loop is not keeping up. Which of those is happening is not
  // visible in a purse balance.
  recordPurchase(what, cost, { kind = null, from = null, why = null } = {}) {
    const k = kind || 'other';
    const price = Number(cost) || 0;
    this.spending.spent += price;
    const by = this.spending.by_kind[k] || (this.spending.by_kind[k] = { items: 0, spent: 0 });
    by.items++; by.spent += price;
    this.spending.bought.push({ at: Date.now(), what, cost: price, kind: k, from, why });
    this.tradeFact({ spent: price, bought: [{ what, cost: price, item_kind: k, from }] });
    if (this.spending.bought.length > 60)
      this.spending.bought.splice(0, this.spending.bought.length - 60);
    // `item_kind`, NOT `kind`. The ledger record has a `kind` of its own — the event
    // type — and a detail field of the same name used to overwrite it, filing every
    // purchase under 'elderberry' or 'herb' so that nothing looking for 'bought' ever
    // found one. recordEvent now refuses to be clobbered, but the field still reads
    // better named for what it is.
    this.ledgerEvent('bought', { what, cost: price, item_kind: k, from: from || undefined, why });
  }

  // healUp() may spend a flask, cast a heal on ourselves, or both, and an audit wants
  // those apart: a flask is an item the character had to find or buy, a cast is mana it
  // regenerates for free. `used` carries the spell's own name for a cast and the
  // literal 'flask' otherwise (m59-skills.mjs healUp), so that is the discriminator.
  //
  // Recorded from here rather than inside healUp so that module keeps no opinion about
  // bookkeeping — it is called by tools that have no keeper and no ledger.
  recordHealUse(h, why) {
    for (const used of h?.used || []) {
      if (/^flask$/i.test(used)) continue;
      this.recordCast(used, { ok: !!h.healed, target: 'self', why });
    }
  }

  // THE SESSION'S CASTING, as one block for `status`.
  //
  // Null rather than an empty table when nothing has happened: a keeper that has been
  // up for thirty seconds and one that has spent an hour declining to cast are
  // different states, and a row of zeroes reads as the second.
  spellSummary() {
    const spells = Object.entries(this.spellbook.by_spell);
    const bought = Object.entries(this.spending.by_kind);
    if (!spells.length && !bought.length) return null;
    return {
      cast: spells.map(([spell, b]) => ({
        spell, cast: b.cast, produced: b.produced, nothing: b.nothing,
        // The number the audit exists for. A spell cast forty times that produced
        // nothing forty times is not a working supply loop, and every count above this
        // line would say it was.
        worked: b.cast ? Math.round(100 * b.produced / b.cast) + '%' : null,
        mana_spent: b.mana_spent || undefined,
        outcomes: b.outcomes || undefined,
        declined: Object.keys(b.declined).length ? b.declined : undefined,
      })).sort((a, b) => b.cast - a.cast),
      // Spells it only ever declined appear above with cast: 0 — that is the point.
      bought: bought.length
        ? { total_spent: this.spending.spent,
            by_kind: Object.fromEntries(bought.map(([k, v]) => [k, v])),
            recent: this.spending.bought.slice(-5).map(p => `${p.what} @${p.cost}`) }
        : null,
      never_bought_food: !this.spending.by_kind.food,
      note: 'nothing in this fleet buys prepared food: restockReagents filters the shop ' +
            'list through skills.SHAREABLE, which is elderberry and herbs only. So an ' +
            'empty larder is answered by casting or by looting, never by shopping — if ' +
            'that is not what you want, the list is the place to change it',
    };
  }

  // A PURCHASE IT DECIDED AGAINST. Same rate limit and same reason as declinedCast:
  // makeRoom() reaches a merchant often, and "already had enough" every time is not
  // worth a line each, but the count answers "why has this one never restocked".
  declinedPurchase(why, detail = {}) {
    this.spending.declined[why] = (this.spending.declined[why] || 0) + 1;
    const key = 'buy/' + why;
    const last = this.spellbook.declined_logged.get(key) || 0;
    if (Date.now() - last >= 600_000) {
      this.spellbook.declined_logged.set(key, Date.now());
      this.ledgerEvent('buy_declined', { why, times_so_far: this.spending.declined[why], ...detail });
    }
  }
  // @end 1
}
