// DEATH: the broadcast, the post-mortem, the Underworld pass.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 6 methods: awaitDeathBroadcast, postMortem, writePostMortem, observeDeath, observeDeathRoom,
//   passUnderworld
import { applyDeathAttribution } from '../m59-death-attribution.mjs';
import { deathLocationFromSessions } from '../m59-death-location.mjs';
import { findDeathNotice } from '../m59-death-notices.mjs';
import { keeperOrigin, liveMoveOrder, originLabel } from '../m59-move-origin.mjs';
import * as skills from '../m59-skills.mjs';
import { currentSurvivalDecision, finishSurvivalDecision, survivalDecisionSnapshot } from '../m59-survival-decision.mjs';
import { survivalTraceSnapshot } from '../m59-survival-trace.mjs';
import * as tougher from '../m59-tougher.mjs';
import { UNDERWORLD } from '../m59-travelgate.mjs';
import * as uptime from '../m59-uptime.mjs';
import * as watchdog from '../m59-watchdog.mjs';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { CONTINUE, HANDLED, ITEM_VALUE, POSTMORTEM_DIR, UNDERWORLD_ROOM_OBJECT_ID, pct, vigorOf } from '../m59-autopilot.mjs';
import { survivalOffOf } from '../m59-hazards.mjs';

// How many escape attempts an island death spends on the rip before it will take any portal.
// The rip is never unlit, so a miss is a walk that did not land; three passes is a minute or
// two in a room nothing can hurt us in, against a mainland exit that costs the farm an hour.
export const KOCATAN_RIP_HOLD_ATTEMPTS = 3;

export class DeathPart {
  // @part 1

  // The whole record, as one object. Written on death, and readable any time — calling
  // it while alive is how you check the recorder works without killing anything.
  // Listen for our own death broadcast. Bounded and short: it normally lands within a
  // second, and everything after this point — the Underworld, the walk back — destroys
  // the evidence, so waiting long is worse than missing it.
  //
  // Matched on OUR name. A fleet of twenty-one dies often enough that "the most recent
  // ### line" is regularly about somebody else, which is exactly the sort of near-miss
  // that would make the record confidently wrong instead of honestly empty.
  async awaitDeathBroadcast({ waitMs = 3000 } = {}) {
    const c = this.s.client;
    if (!c) return null;
    const name = c.me?.name ?? this.s.name;
    const at = Date.now();
    // TIGHT FIRST, THEN THE WHOLE BUFFER.
    //
    // The windowed search is the precise answer when the death was noticed promptly, and
    // it is worth keeping for the `dt` it reports. But noticing is the slow part — death
    // is inferred from the Underworld on a LATER pass — so when the keeper is a journey
    // behind, the broadcast scrolled past the window before anything looked for it, and
    // the record lost the killer in exactly the cases where it is hardest to reconstruct
    // by hand. That was 69% of attended deaths: the line was sitting in `text` the whole
    // time, unmatched.
    const near = () => skills.deathBroadcastFor(name, c.events ?? [], at);
    const anywhere = () => skills.deathBroadcastFor(name, c.events ?? [], null);
    const liveTimes=(this.s.sessionEvidence?.records??[]).flatMap(r=>r.events.filter(e=>e.kind==='stat'&&e.name==='health'&&e.value>0&&e.room!=null&&e.room!==1&&e.at<=at).map(e=>e.at));
    const lastAlive=liveTimes.length?Math.max(...liveTimes):null;
    const peer=()=>findDeathNotice(this.s.credentials,name,{at,since:lastAlive==null?at-30000:Math.max(at-890000,Math.min(at-30000,lastAlive))});
    const already = near() ?? anywhere() ?? peer();
    if (already) return already;
    await c.waitFor({ kinds: ['message'], timeoutMs: waitMs }).catch(() => null);
    // `dt` is null on the fallback, which is the honest answer: we know the killer and we
    // do not know how long ago, because the thing that would have told us is the clock we
    // just admitted was wrong.
    return near() ?? anywhere() ?? peer();
  }

  postMortem(reason = 'died') {
    const decision=currentSurvivalDecision(this.s);
    if (decision) finishSurvivalDecision(this.s,decision.id,'died',reason);
    const frames = (this.recent5 || []).filter(f => !/underworld/i.test(f.room || ''));
    const last = frames[frames.length - 1] || null;
    const capturedAt=Date.now(),sessionEvidence=this.s.sessionEvidence?.snapshot?.()??null;
    const fatalLocation=deathLocationFromSessions(sessionEvidence,{at:capturedAt});
    const where=fatalLocation?{room:last?.num===fatalLocation.num?last.room:null,...fatalLocation}
      :last?{room:last.room,num:last.num,col:last.col,row:last.row}:null;
    // Rank frames on the true count, not the capped name list — otherwise every frame
    // with 6-or-more ties at 6 and "the worst moment" is just the first one that
    // saturated the cap. Falls back to the list length for records written before
    // threat_count existed.
    const crowd = f => f?.threat_count ?? f?.threats?.length ?? 0;
    const worst = frames.reduce((a, f) => (a && crowd(a) >= crowd(f)) ? a : f, null);
    return {
      character: this.s.client?.me?.name ?? this.s.name ?? null,
      agent: this.s.name ?? null,
      at: capturedAt, reason,
      // WHAT IT WAS DOING. The question everyone asks first.
      was: {
        doing: last?.doing ?? this.doing ?? this.lastDoing ?? null,
        mode: this.mode, hunting: this.policy.hunt, purpose: this.policy.purpose ?? null,
        strategy: this.policy.strategy,
        in_safe_spot: last?.holding ?? false,
        moving: last?.moved_ms != null && last.moved_ms < 12_000,
        swinging: last?.swung_ms != null && last.swung_ms < 12_000,
        ms_since_moved: last?.moved_ms ?? null,
        ms_since_swung: last?.swung_ms ?? null,
        // THE FIELD THAT MAKES A DEATH ON A WALL ATTRIBUTABLE. `swinging: false` with
        // `ms_since_swung: null` used to mean either "never swung" or "no frame to read",
        // and only the first of those is evidence. Null here is the honest "no frame".
        ever_swung: last ? (last.ever_swung ?? null) : null,
        // THE JOURNEY IT WAS ON, AND WHICH RULE LET IT BE THERE. The live order, else the one a cancel just took
        // (death cancels the walk). `exception` is the permission a tagged errand carried (a chalice refill out of
        // its confinement): operator, 2026-10-27, "for traceability in case he dies".
        ...(() => {
          const o = liveMoveOrder(this.s) ?? this.s?.lastMovementCancel?.preempted ?? null;
          if (!o) return {};
          return { journey: { to: o.to ?? null, ordered_by: o.ordered_by ?? originLabel(o.origin) },
                   ...(o.origin?.exception || o.exception ? { exception: o.origin?.exception ?? o.exception } : {}) };
        })(),
      },
      where,
      vitals: {
        last_health: last?.health ?? null, level: last?.max ?? null,
        last_vigor: last?.vigor ?? null,
        health_per_second: this.healthRate(frames),
        trail: frames.map(f => f.health).filter(h => h != null),
        // Age of the health reading at each frame (ms; null on frames written before this field existed). Large ages
        // under a flat trail mean the keeper was not hearing health; small ones mean it was, and the death was fast.
        health_age_ms: frames.map(f => f.health_age_ms ?? null),
        flee_threshold: this.safety?.().fleeAt ?? null,
      },
      // WAS THE KEEPER LOOKING, AND COULD IT HEAR? (prod 2026-10-26: nine deaths "stalled" with a flat health trail.)
      // last_frame_age_ms large: frames stopped, so the trail is old and the keeper was not looking (see watchdog).
      // rx fresh but msg old, or framing_drops/stat_parse_errors climbing: the socket was alive and nothing parsed.
      // both fresh and the trail flat: the server sent no damage the keeper could read; look at the STAT drops.
      hearing: (() => {
        const c = this.s.client, w = this.watch, age = t => (t ? capturedAt - t : null);
        return {
          last_frame_age_ms: last?.at ? capturedAt - last.at : null,
          rx_age_ms: age(c?.lastRxAt), msg_age_ms: age(c?.lastGameMsgAt), game_msgs: c?.gameMsgs ?? null,
          framing_drops: c?.framingDrops ?? 0, last_framing_drop_age_ms: age(c?.lastFramingDropAt),
          stat_parse_errors: (c?.parseErrors ?? []).filter(e => /^STAT/.test(String(e?.what ?? ''))).slice(-3)
            .map(e => ({ what: e.what, why: e.why, age_ms: age(e.at) })),
          watchdog: w ? { last_tick_age_ms: age(w.lastTickAt), last_skip: w.lastSkip ? { why: w.lastSkip.why, age_ms: age(w.lastSkip.at) } : null } : null,
          combat_mode: !!this.s.combat?.active,
          // The likeliest answer of all: survival_enabled:false makes every pass return at once and turns the travel
          // guard off, so a body walked into a fight by anybody else stands there and dies.
          survival_enabled: !survivalOffOf(this.policy),
          survival_off_until: this.policy?.survivalOffUntil ?? null,
        };
      })(),
      threats: {
        present_at_the_end: last?.threats ?? [],
        // Prefer the real count; fall back to the capped list length for frames written
        // before threat_count existed, and say which it is so a mixed record is readable.
        most_at_once: worst?.threat_count ?? worst?.threats?.length ?? 0,
        most_at_once_is: worst?.threat_count != null ? 'a true count' : 'capped at 6 — old record',
        // Who else was standing there. Not a threat — these are ours — but it answers
        // "was anyone with it", which is the second question after "what killed it".
        players_present: last?.players_present ?? [],
      },
      // The three things that were being kept and never joined.
      frames,
      decisions: (this.journal || []).slice(-14),
      survival_trace: survivalTraceSnapshot(this.s),
      survival_decisions: survivalDecisionSnapshot(this.s),
      combat: this.s.combat?.status?.() ?? null,
      pvp_survival: this.s.combat?.pvpStatus?.() ?? null,
      replay: reason==='died' ? this.s.replayRecorder?.death({reason,character:this.s.client?.me?.name??this.s.name,
        where:where?{room:where.num,row:where.row,col:where.col}:null,
        survival_decisions:survivalDecisionSnapshot(this.s)})??null : null,
      text: this.recentText(30),
      session_evidence: sessionEvidence,
      // WHERE THE DAMAGE ACTUALLY LANDED, which the three above cannot say.
      //
      // Frames are one per pass and a pass can be a multi-minute travel await, so the
      // record of a travelling death is a before and an after with the death in the gap.
      // These come off the event stream instead — health is pushed, one packet per change
      // — so they keep arriving through exactly that gap, and through an errand holding
      // the keeper inert. The last twenty segments are about the last few minutes of
      // trouble, which is longer than any fight that kills one of these characters.
      //
      // Read them against `frames`: a death whose frames say "inn, full health" and whose
      // hits say "nine squares of room 562 while travelling" is not a mystery, it is a
      // journey nobody was watching.
      hits: (this.s.hits?.segments || []).slice(-20),
      note: 'frames are one keeper pass each, oldest first. `text` is what the server ' +
            'sent, `decisions` is what the keeper chose, `hits` is where damage landed ' +
            'and comes off the event stream rather than the keeper — so it is the only ' +
            'one of the four that keeps recording during a travel or an errand. Read ' +
            'them side by side against the timestamps — the interesting moment is ' +
            'usually where they disagree.',
    };
  }

  // Durable, because the whole point is that somebody picks it up later. One file per
  // death under substrate/postmortems/, gitignored with everything else a fleet writes.
  writePostMortem(record) {
    try {
      mkdirSync(POSTMORTEM_DIR, { recursive: true });
      const who = String(record.character || record.agent || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
      const stamp = new Date(record.at).toISOString().replace(/[:.]/g, '-');
      const file = `${POSTMORTEM_DIR}/${who}-${stamp}.json`;
      writeFileSync(file, JSON.stringify(record, null, 2));
      // Also append a one-line summary to a single death log for easy grepping.
      try {
        const logLine = {
          character: record.character ?? record.agent ?? 'unknown',
          agent: record.agent ?? null,
          at: new Date(record.at).toISOString(),
          reason: record.reason ?? 'died',
          room: record.where?.room ?? null,
          room_num: record.where?.num ?? null,
          col: record.where?.col ?? null,
          row: record.where?.row ?? null,
          level: record.vitals?.level ?? null,
          last_health: record.vitals?.last_health ?? null,
          was_doing: record.was?.doing ?? null,
          hunting: record.was?.hunting ?? null,
          in_safe_spot: record.was?.in_safe_spot ?? false,
          nearby_threats: record.threats?.present_at_the_end ?? [],
          players_present: record.threats?.players_present ?? [],
        };
        appendFileSync(POSTMORTEM_DIR + '/../deaths.jsonl', JSON.stringify(logLine) + '\n');
      } catch { /* non-fatal */ }
      return file;
    } catch (e) {
      // A failed write must not take the keeper down on the one pass where it is
      // already having a bad time.
      this.note('could not write the post-mortem', { why: e.message });
      return null;
    }
  }
  // @end 1

  // @part 2

  // Record mortality independently of movement. The normal pass and the room
  // event share one promise, so retries in the Underworld count one death and
  // neither observer starts a second escape while travel already owns the body.
  observeDeath() {
    if (this.reportedDeath) return this.deathReportTask;
    this.deathReportTask = (async () => {
      this.tally.deaths = (this.tally.deaths || 0) + 1;
      this.deathsThisRun = (this.deathsThisRun || 0) + 1;
      // WHAT THE PURSE WAS WORTH WHEN IT HIT THE FLOOR. Recorded from the last frame
      // before the Underworld, because by now the inventory is already gone — and it
      // is the only honest score for whether the banking trips are worth their walk.
      const lastPurse = this.lastSeenPurse ?? 0;
      if (lastPurse > 0) {
        this.money.carried_at_death += lastPurse;
        this.note('died carrying money', { shillings: lastPurse,
          bank_above: this.policy.bankAbove,
          why: lastPurse > (this.policy.bankAbove ?? Infinity)
            ? 'over the banking threshold — the trip did not happen in time'
            : 'under the banking threshold, so this was the float we accept losing' });
      }

      // Reconstruct the death from the short memory, ONCE, when first observed.
      // The last frame that was not the Underworld is where it
      // actually happened, and what was standing there is the best evidence of what
      // did it.
      if (!this.reportedDeath) {
        this.reportedDeath = true;
        // Were we behind a wall when it happened? See lastHold in observe().
        const diedHolding = this.lastHold && Date.now() - this.lastHold.at < 30_000
          ? this.lastHold : null;
        const before = (this.recent5 || []).filter(f => !/underworld/i.test(f.room || ''));
        const at = before[before.length - 1] || null;
        const trail = before.slice(-4).map(f => `${f.health}/${f.max}`).join(' -> ');
        const death = this.lastDeath = {
          at: Date.now(),
          died_in: at?.room ?? null, room_num: at?.num ?? null,
          at_col: at?.col ?? null, at_row: at?.row ?? null,
          level: at?.max ?? null,
          health_trail: trail || null,
          last_health: at?.health ?? null,
          last_vigor: at?.vigor ?? null,
          killed_by: at?.threats?.length ? at.threats : null,
          hunting: this.policy.hunt,
          strategy: this.policy.strategy,
          flee_threshold: this.safety().fleeAt,
          // DID THIS HAPPEN AT A SAFE WALL? THE ANSWER SHOULD BE "ONLY TO A PERSON".
          //
          // The operator's expectation, 2026-08-28, and it is a falsifiable claim about the
          // whole safe-spot machine rather than a diagnostic: a wall the fleet identifies is
          // now trusted with lives — `proven` was retired the same day — so a death ON one
          // should only ever be PVP. A monster killing somebody at a wall means the wall was
          // not a wall, and that is the single most important thing this record can say.
          //
          // Flagged rather than inferred, because inferring it later is exactly what goes
          // wrong: `hold` is cleared on death by several paths, so a postmortem written a
          // moment afterwards cannot reconstruct where the body was standing. `lastHold`
          // already carries it for the 30s window `diedHolding` uses.
          // ON the wall, not NEAR one. `diedHolding` is "held a wall in the last 30 seconds",
          // which is a different claim and a much weaker one. Uuuu, 2026-08-28: held 46,13,
          // died at 47,14, and this reported a death at a safe wall — the character had left
          // it. A flag that fires for a body one square away cannot test whether walls hold.
          at_a_safe_wall: (diedHolding && at
                           && diedHolding.col === at.col && diedHolding.row === at.row) ? {
            at: { col: diedHolding.col, row: diedHolding.row },
            held_for_s: Math.round((Date.now() - diedHolding.at) / 1000),
            // The killers, so "only PVP" can be checked rather than asserted. `players_present`
            // is the other half — a monster landing the last blow during a PVP fight is still
            // a PVP death, and the two columns together say which it was.
            killed_by: at?.threats?.length ? at.threats : null,
            players_present: this.namedPlayersHere?.() ?? null,
            expectation: 'a death at a safe wall should be PVP. A monster here means the wall '
                       + 'was not one, and the safe-spot book needs to hear about it.',
          } : null,
          // WHY IT DID NOT FIRE, BECAUSE NULL WAS THREE DIFFERENT FACTS WEARING ONE VALUE.
          //
          // `at_a_safe_wall` is null on 114 of 114 deaths reviewed on 2026-09-20, and an
          // analysis reading `?? false` scores every one of them as "not at a wall". That is
          // the right default and the wrong record: null here means ANY of
          //
          //   the character was not holding a wall at all        — says nothing about walls
          //   it held one and died somewhere else                — the interesting case, and
          //                                                        the one this session spent
          //                                                        hours reconstructing by hand
          //   the position could not be read                     — says nothing about anything
          //
          // Only the second is evidence, and it was indistinguishable from the other two. So
          // the reason is recorded, with the GAP: `left_the_wall` carries how far the body
          // had strayed from the square it had reserved, which is the number that decides
          // whether a death belongs to a wall or to the open ground beside one.
          at_a_safe_wall_absent: (diedHolding && at
                                  && diedHolding.col === at.col && diedHolding.row === at.row)
            ? null
            : !diedHolding ? { why: 'not_holding' }
            : !at ? { why: 'position_unknown', held: { col: diedHolding.col, row: diedHolding.row } }
            : { why: 'left_the_wall',
                held: { col: diedHolding.col, row: diedHolding.row },
                died_at: { col: at.col, row: at.row },
                off_by: Math.max(Math.abs(diedHolding.col - at.col),
                                 Math.abs(diedHolding.row - at.row)) },
          // AND WHAT THAT NUMBER ACTUALLY GOVERNED, because on its own it misleads and it
          // misled the operator on 2026-08-27. `flee_threshold: 0.7` next to a travelling
          // death reads as "it should have fled at 70% and did not", and the truth is the
          // opposite: a traveller is not supposed to flee from a monster at all. The rung is
          // gated on `worthEnding`, which under the default `travel_flee_from: 'players'` is
          // PEOPLE ONLY — so 0.7 is the ordinary ladder's number being reported at a moment
          // when the ordinary ladder was not the thing in charge.
          //
          // A postmortem that reports a threshold has to report which policy was live, or the
          // reader reconstructs the wrong doctrine from the right number.
          // WHAT IT WAS DOING, CARRIED INTO THE SUMMARY BECAUSE `governed_by` CANNOT ANSWER IT.
          //
          // The postmortem has had this all along in its `was` block, and the ledger has not,
          // because the ledger is handed `lastDeath` and `doing` was never on it. So the one
          // field that survives the survival ladder taking over was unavailable to every
          // window aggregate. Same shape as the `in_safe_spot` omission recorded below it:
          // the keeper computed it and nothing carried it across.
          //
          // `at` is the last frame before the Underworld, so this is what the character was
          // doing when it was last seen alive — not what it was doing after it died.
          // NO LIVE FALLBACK. `this.doing`/`this.lastDoing` are read after the body is in
          // the Underworld, so falling back to them answers the question with the clean-up
          // state — and this field is what `travellingAtDeath` classifies on. Null is the
          // honest answer when no living frame survives; the classifier treats null as
          // "nobody asked" and lets `governed_by` answer instead.
          doing: at?.doing ?? null,
          governed_by: this.travelling
            ? { doctrine: 'travel', flee_from: this.policy.travelFleeFrom ?? 'players',
                divert_below: this.policy.travelDivertBelow ?? 1,
                shelter_detour: this.policy.travelShelterDetour ?? 5,
                guard: this.travelGuard?.() ?? null,
                note: 'a monster cannot end a journey; the answer to a monster is the next '
                    + 'route-adjacent wall, so flee_threshold above did not apply here' }
            : { doctrine: 'ordinary ladder', flee_at: this.safety().fleeAt },
          // WAS IT STILL GOING ANYWHERE? The operator's question, 2026-08-27, and it separates
          // two deaths that read identically in a health trail: a character overwhelmed while
          // crossing ground, and a character that stopped covering ground some seconds earlier
          // and was then chewed where it stood. `ms_since_moved` cannot answer it — it measures
          // the KEEPER, and CLAUDE.md is explicit that a two-square shuffle against a wall
          // resets every stillness timer it meets. Squares per second over the last frames does
          // answer it, and `net` against `gross` is the shuffle detector: a body that covered
          // eleven squares of travel and ended one square from where it started was fighting a
          // wall, not walking.
          movement: (() => {
            const f = before.filter(x => x.at != null
              && Number.isFinite(x.row) && Number.isFinite(x.col));
            if (f.length < 2) return { samples: f.length, why: 'not enough frames to say' };
            const span = (f[f.length - 1].at - f[0].at) / 1000;
            let gross = 0;
            const steps = [];
            for (let i = 1; i < f.length; i++) {
              // Chebyshev, because that is how a step moves — and a room change is not
              // distance, it is a different coordinate system, so it is skipped rather than
              // counted as a leap of forty squares.
              if (f[i].num !== f[i - 1].num) { steps.push(null); continue; }
              const d = Math.max(Math.abs(f[i].row - f[i - 1].row),
                                 Math.abs(f[i].col - f[i - 1].col));
              gross += d;
              const dt = (f[i].at - f[i - 1].at) / 1000;
              steps.push(dt > 0 ? +(d / dt).toFixed(2) : null);
            }
            const net = f[f.length - 1].num === f[0].num
              ? Math.max(Math.abs(f[f.length - 1].row - f[0].row),
                         Math.abs(f[f.length - 1].col - f[0].col))
              : null;
            const last4 = steps.slice(-4).filter(x => x != null);
            return {
              samples: f.length,
              seconds: +span.toFixed(1),
              squares_per_second: span > 0 ? +(gross / span).toFixed(2) : null,
              // The four passes before it died, which is the window that decides whether the
              // death was "caught while moving" or "died standing".
              squares_per_second_at_the_end: last4.length
                ? +(last4.reduce((a, b) => a + b, 0) / last4.length).toFixed(2) : null,
              gross_squares: gross,
              net_squares: net,
              // Ground covered that went nowhere. High gross with low net is the shuffle.
              shuffled: net != null && gross >= 4 && net <= 1,
              rooms_crossed: f.slice(1).filter((x,i)=>x.num!==f[i].num).length,
              distinct_rooms: new Set(f.map(x => x.num)).size,
              per_pass: steps.slice(-8),
            };
          })(),
          // The two questions worth asking of any death.
          fled_in_time: at && at.max ? (at.health / at.max) : null,
          had_flasks: this.hadFlasks ?? null,
          // DID THE HANDBRAKE FIRE, AND WAS IT EVEN ALLOWED TO?
          //
          // Without this a death is unreadable in the one way that decides what to do
          // about it. Four travelling deaths in a day spent several samples below the
          // flee line before dying, and nothing on disk could say whether the watchdog
          // interrupted and the character died anyway, whether it never fired, or whether
          // it stood down because an errand owned the character — three different faults
          // with three different fixes, all rendering identically as "died travelling".
          //
          // `interrupted_this_pass` is the one that matters: the watchdog fires at most
          // once per pass, so a death in a pass it already interrupted means the
          // interrupt was not enough, while a death in a pass it never touched means it
          // never got the chance.
          // WHICH ARM OF THE TRAVEL EXPERIMENT WAS RUNNING, or null if the character was
          // not on a journey. This is the numerator: deaths are the only outcome that
          // experiment is judged on, because the mechanism it is testing is expected to
          // INCREASE damage taken while reducing deaths, and a death that cannot be
          // attributed to an arm is a death that cannot be counted.
          travel_arm: this.travelArm
            ? { arm: this.travelArm.arm, to: this.travelArm.to,
                into_journey_ms: Date.now() - this.travelArm.since,
                held_ms: this.travelHeldMs ?? 0 }
            : null,
          // DID IT EVER TRY FOR A WALL? THE RECORD COULD NOT SAY, AND THAT WAS THE PROBLEM.
          //
          // The operator's question, 2026-09-10: "it seems like these dying characters aren't
          // even trying to make it to safe spots — do we capture that?" The answer was no. The
          // postmortem carried the OUTCOME (`at_a_safe_wall`, `in_safe_spot`, both empty in 250
          // of 270 travelling deaths) and nothing about the attempt, so "tried for a wall and
          // could not reach one" and "never looked" were the same record.
          //
          // The counters existed and went somewhere else. `recordTravelShelterStop` feeds
          // `journeyMetrics`, which is written to the travel/A-B ledger at JOURNEY END — a line
          // a character that dies mid-journey never reaches. The join back was meant to be
          // `travel_arm` (see its comment above), and `travel_arm` is null in 247 of those 270,
          // because it is only set while a journey hold is live. So the one field designed to
          // connect a journey to its death is absent exactly when the death happens.
          //
          // Read straight off the counters, no new bookkeeping. A journey resets them, so these
          // are "this journey", which is the window that matters.
          shelter: {
            stops: this.travelSafeStops ?? 0,
            hop_wall: this.travelHopWallStops ?? 0,
            sanctuary: this.travelSanctuaryStops ?? 0,
            route: this.travelRouteStops ?? 0,
            track: this.travelTrackStops ?? 0,
            held_ms: this.travelShelterHeldMs ?? 0,
            // The per-ROOM budget, which is what actually refuses a stop. `taken >= budget`
            // is the state in which the guard says "walking on — the wall for this is at the
            // end of the hop", so a death with a spent budget is a different story from one
            // with an untouched budget and no stops at all.
            this_room: this.shelterStops?.room ?? null,
            // COUNTED ONLY WHEN THE BUCKET IS ABOUT THE ROOM WE ARE STANDING IN.
            //
            // `shelterStops` is re-made on entering a room, but only by the rungs that run —
            // so a character that left the bucket's room without one of them firing carries a
            // stale bucket, and this field then reported another room's spend as this room's.
            // Measured over the 36 deaths of 2026-09-19/20: 19 of 36 had `this_room` naming a
            // room the character did not die in, which is a reading nobody can act on and one
            // that silently understates or overstates the budget it sits next to.
            //
            // STILL ALWAYS A NUMBER. `m59-death-observation-test` pins that — "is always a
            // number, never absent" — and it is right to: a field that is sometimes missing
            // reads as 0 in every analysis that does `?? 0`, which is the same silent
            // misreading in the other direction. So a stale bucket reports 0 rather than null,
            // and `this_room` beside it is what says which room the bucket was actually about.
            //
            // COMPARED AGAINST THE ROOM THEY DIED IN, NOT THE LIVE ONE. By the time this record
            // is written the character is in the Underworld, so `world.room.num` is 1 and every
            // bucket would look stale. `at` is the last frame that was not the Underworld — the
            // same source `room_num` and `died_in` above are taken from — which is the room the
            // budget is actually a statement about.
            //
            // AND ONLY WHEN BOTH ROOMS ARE KNOWN. An unreadable death room is not evidence that
            // the bucket is stale, and zeroing a good count because the frame ring happened to
            // be empty would be inventing a second wrong reading to fix the first.
            taken_this_room: (at?.num != null && this.shelterStops?.room != null
                              && this.shelterStops.room !== at.num)
              ? 0 : (this.shelterStops?.taken ?? 0),
            budget_per_room: this.policy.travelShelterPerRoom ?? 4,
            // The threshold the shelter rung compares health against, recorded because it is
            // zone-dependent — it returns 1 (any scratch at all) where the zone outranks the
            // character — so the same number cannot be reconstructed afterwards.
            below: (() => { try { return this.travelShelterBelow(); } catch { return null; } })(),
            // The ORDINARY ladder's wall attempt, which is the one that applies when no journey
            // hold is live — 241 of 270. Throttled to one attempt per 30s, so its age says
            // whether the rung had even come round again.
            ordinary_wall_tried_ms_ago:
              this.wallTriedAt ? Date.now() - this.wallTriedAt : null,
          },
          // WHERE THE PASS WAS WHEN IT STOPPED DECIDING.
          //
          // `pass_blocked_ms` has always said a pass went quiet and never said what it was
          // waiting on, and every reading of these deaths has had to guess. See the note in
          // `runPassLadder`. `stage` is the rung that was awaiting; `in_stage_ms` is how long
          // it has been in it, which is the number to compare against `pass_blocked_ms` —
          // when they match, the stage named here is the one that stopped the keeper.
          //
          // READ OFF THE LAST PRE-UNDERWORLD FRAME, NOT LIVE. `at` is the same source
          // `room_num`, `died_in` and the health trail come from, so this now answers "what
          // was the ladder doing while the character was dying" rather than "what is it doing
          // now that the character is dead". The live reading is kept beside it under a name
          // that cannot be mistaken for the other, because it is still the right answer when
          // the question is why the keeper is quiet THIS second.
          blocked_in: at?.stage
            ? { stage: at.stage, in_stage_ms: at.stage_ms ?? null, from: 'last living frame' }
            : null,
          blocked_in_after_death: this.passStage
            ? { stage: this.passStage,
                in_stage_ms: this.passStageAt ? Date.now() - this.passStageAt : null,
                note: 'the body is in the Underworld by now — this is the clean-up rung, '
                    + 'never the one that failed to save it' }
            : null,
          watchdog: (() => {
            const w = this.watch;
            if (!w) return { running: false, why: 'no watchdog on this keeper' };
            return {
              running: true,
              interrupts_total: w.interrupts ?? 0,
              interrupted_this_pass: w.interruptedPass === this.passes,
              frames_written: w.frames ?? 0,
              // How long the pass that died had been inside one await. This is the
              // number the whole watchdog exists for, and it was only ever visible live.
              pass_blocked_ms: this.passStartedAt ? Date.now() - this.passStartedAt : 0,
              longest_block_ms: w.longest_block_ms ?? 0,
              ms_since_frame: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
              // The watchdog returns early while something else is driving, so an errand
              // death is one it was never allowed to act on. Recorded rather than
              // inferred from `during_keeper_outage`, which means something else.
              stood_down_for: this.inert ? (this.inert.why ?? 'inert') : null,
              // WHICH STAND-DOWN, AND WHAT IT STILL ALLOWED. `stood_down_for` alone reads
              // the same for an errand that switched the survival ladder off and a journey
              // that left it armed, and those are opposite readings of the same death. The
              // post-mortems that motivated the travelling state all say
              // `stood_down_for: "travelling to ..."` and could not say more than that.
              stand_down_state: this.inert ? (this.inert.travelling ? 'travelling' : 'inert') : null,
              travel_guard: this.inert?.travelling ? this.inert.guard : null,
              // HOW FAST IT WAS LOSING, on the character's own clock. The trigger the
              // travelling guard acts on, recorded whether or not it fired — "it was
              // dying at half a point a second and nothing took it back" and "it died to
              // one burst" are different failures and used to look identical.
              losing_per_s: (() => {
                const r = this.damageRate();
                return r === null ? null : Math.round(r * 100) / 100;
              })(),
              take_backs: this.tally?.travel_takebacks ?? 0,
              // Was the BODY moving in the seconds before this death, sampled on its own
              // clock. `pass_blocked_ms` says the keeper stopped looking; this says
              // whether the character was going anywhere while it did.
              wedges: w.wedges ?? 0,
              wedged_at_death: w.wedged ? { ...w.wedged,
                for_ms: Date.now() - w.wedged.since } : null,
              last_pulses: (w.pulses ?? []).map(p => ({
                s_ago: Math.round((Date.now() - p.at) / 1000),
                col: p.col, row: p.row, room: p.room, doing: p.doing })),
            };
          })(),
          // WHAT WAS ON THE FLOOR WHEN WE FELL, so something can decide whether the walk
          // back is worth making. Dying drops the whole inventory, and until now nothing
          // recorded what that was — so a recovery errand had to treat every death site
          // as equally promising and walk to all of them. It sent couriers to sites that
          // held nothing, through the two rooms this fleet dies in most, and the trips
          // cost more lives than the drops were worth.
          //
          // Counted from the last inventory the client saw, because the corpse is already
          // gone by the time anything asks. Names kept for the notable kinds only — a
          // weapon or reagent is worth a walk, four mushrooms are not.
          carrying: (() => {
            try {
              const inv = this.s.client?.inventory ?? [];
              const names = inv.map(o => ({ name: this.s.client.rsc.get(o.nameRsc) || '',
                                            amount: o.amount > 0 ? o.amount : 1 }));
              // WHAT IT IS WORTH, NOT HOW MANY THINGS IT WAS. A stack count cannot tell
              // four mushrooms from four swords. viValue_average is declared per item
              // class in the kod — emerald 30, sapphire 60, mace 50, mushroom 10 — so the
              // pile has an actual number and the walk back can be judged against it.
              let value = 0;
              for (const it of names) {
                if (/shilling/i.test(it.name)) { value += it.amount; continue; }
                value += (ITEM_VALUE[String(it.name).toLowerCase()] ?? 0) * it.amount;
              }
              const worth = names.map(x => x.name).filter(n =>
                /mace|sword|axe|hammer|bow|armor|armour|shield|helm|elder|herb|shilling|emerald|sapphire|ruby|diamond|flask/i.test(n));
              return { stacks: inv.length, value, notable: [...new Set(worth)].slice(0, 8) };
            } catch { return null; }
          })(),
          // DID WE DIE SOMEWHERE WE BELIEVED WAS SAFE? The whole safe-spot thesis
          // predicts this should be close to never: a working spot cannot be hit out
          // of unless we swing first, so anything that dies in one is either standing
          // somewhere that does not work, or was killed on the way in or out. Which
          // of those it is matters, and only recording it can tell them apart.
          in_safe_spot: diedHolding ? {
            at: { col: diedHolding.col, row: diedHolding.row },
            proven: diedHolding.proven,
            held_s: Math.round((Date.now() - diedHolding.takenAt) / 1000),
          } : false,
        };
        if (diedHolding) {
          this.tally.deaths_in_safe_spot = (this.tally.deaths_in_safe_spot || 0) + 1;
          if (diedHolding.proven)
            this.tally.deaths_in_proven_safe_spot = (this.tally.deaths_in_proven_safe_spot || 0) + 1;
          // A `book.failed(...)` write stood here, on the reasoning that "a square that got
          // somebody killed has failed the only test that counts". That reasoning is what
          // the death review of 2026-09-20 broke: it filed against `diedHolding.col/row`,
          // the HOLD, and nine of the ten deaths examined had the body 5 to 68 squares away
          // from it — Robin by 68, Kermit by 47. So the squares this path condemned were
          // mostly squares nobody died on, and the one character genuinely standing on its
          // wall had swung 22 seconds earlier. The post-mortem below records the death with
          // the position it actually happened at, which is the record worth having.
        }
        // THE FULL RECORD, WRITTEN BEFORE ANYTHING ELSE HAPPENS. Everything below this
        // point — escaping the Underworld, walking back, rejoining — overwrites the
        // evidence: the client's event buffer fills with the Underworld, the frames roll
        // over, and the journal moves on. `lastDeath` is the summary; this is the thing
        // somebody can actually read afterwards.
        //
        // Assembled from `lastDeath` rather than beside it, so the two cannot drift.
        // WAIT FOR THE SERVER TO SAY WHO DID IT.
        //
        // The death is broadcast to the whole world and the broadcast NAMES THE KILLER —
        // the one that struck the final blow, not the crowd (system.kod:49-57). It
        // arrives a moment after we notice we are dead, so the record used to be written
        // just before the single most authoritative fact about the death showed up, and
        // `killed_by` was filled in from whatever happened to be standing next to us.
        //
        // That is a different question and it answers it badly. Against 249 deaths with a
        // matching broadcast, the crowd's most common member was the actual killer 51% of
        // the time — a coin flip, written into the record as a cause of death. It also
        // manufactured a culprit: twelve deaths at the border of the Badlands were blamed
        // on "soldier of the Duke's army" purely for being nearby, when the broadcasts say
        // groundworm and troll, and faction soldiers do not start fights with the
        // unaligned in the first place.
        //
        // A couple of seconds is worth it once per death. If it never comes, the record
        // says so rather than falling back silently.
        // Travel may leave the Underworld during this wait. Capture the record now,
        // and retain this death's summary even if another death arrives first.
        const pm = structuredClone(this.postMortem('died'));
        const levelAfterDeath = this.s.client?.vitals?.()?.health?.max ?? null;
        // Ask for a fresh post-death ceiling; an unchanged cached value is not proof
        // that this death cost no HP. The existing broadcast wait bounds this read.
        const healthBeforeRequest = this.s.client?.statsById?.get('health');
        const healthRequestSeq = this.s.client?.evSeq;
        try { this.s.client?.stats?.(1); } catch { /* unknown is still a valid report */ }
        const freshHealth = this.s.client?.statsById?.get('health') !== healthBeforeRequest ? null
          : this.s.client?.waitFor?.({ since: healthRequestSeq, kinds: 'stat', timeoutMs: 1500,
            match: event => event.name === 'health' })?.catch(() => null);
        const [bcast] = await Promise.all([this.awaitDeathBroadcast().catch(() => null), freshHealth]);
        const afterStat = this.s.client?.statsById?.get('health');
        death.max_hp_before = death.level;
        death.max_hp_after = this.lastDeath === death && afterStat !== healthBeforeRequest && afterStat?.observed_at >= death.at
          ? afterStat.currentMax : null;
        death.max_hp_lost = Number.isFinite(death.max_hp_before) && Number.isFinite(death.max_hp_after)
          && death.max_hp_before >= death.max_hp_after ? death.max_hp_before - death.max_hp_after : null;
        this.ledgerEvent('death_cost', { death_at: death.at, max_hp_before: death.max_hp_before,
          max_hp_after: death.max_hp_after, max_hp_lost: death.max_hp_lost });
        // WAS ANYTHING DRIVING WHEN THIS HAPPENED? A character whose keeper stopped
        // stands still in whatever fight it was in; attributing that to a hunting
        // decision charges the strategy for an operator restart. Marked, not excluded —
        // it is still a real death, it just should not be read as evidence about how the
        // fleet fights.
        const unattended = uptime.outageAround(this.s.name, death.at);
        Object.assign(pm, { summary: death, killed_by_broadcast: bcast,
                            during_keeper_outage: unattended });
        if (bcast) {
          // The authoritative answer wins, and what was nearby is kept beside it — the
          // crowd is still the right answer to "how outnumbered were we".
          death.was_nearby = death.killed_by;
          death.killed_by = bcast.killer ? [bcast.killer] : [];
          death.death_broadcast = bcast.text;
          death.how_died = bcast.how;
        } else {
          death.killed_by_is_a_guess = true;
          death.note_killer = 'no death broadcast arrived within the wait, so ' +
            'killed_by is only what was standing nearby — right about half the time';
        }
        if (unattended) {
          death.unattended = true;
          death.keeper_was_down_for_seconds = Math.round(unattended.ms / 1000);
          death.note_unattended = 'nothing was driving this character when it died — ' +
            'do not read this as evidence about the hunting strategy';
        }
        // Capture messages delivered during the wait without mixing later deaths.
        if (this.lastDeath === death) {
          const seen = new Set((pm.text ?? []).map(e => JSON.stringify([e.at, e.kind, e.text])));
          for (const e of this.recentText(30)) {
            const key = JSON.stringify([e.at, e.kind, e.text]);
            if (!seen.has(key) && Math.abs(e.at - death.at) <= 5000) {
              (pm.text ??= []).push(e); seen.add(key);
            }
          }
        }
        // Preserve victim-specific messages that crossed a socket boundary. Their
        // original times remain intact; the attribution code retains its normal windows.
        for(const e of this.s.sessionEvidence?.messages?.({since:death.at-30000,until:death.at+5000})??[]) {
          if(!(pm.text??[]).some(old=>old.at===e.at&&old.kind===e.kind&&old.text===e.text))(pm.text??=[]).push(e);
        }
        pm.session_evidence=this.s.sessionEvidence?.snapshot?.()??pm.session_evidence??null;
        applyDeathAttribution(pm);
        const attribution = pm.death_attribution;
        // WAS IT A PLAYER? Decided here, from evidence available at death time, and stamped
        // on the record before the post-mortem is written so the file says so. A PvP death
        // starts the return delay — see `pvpReturnGate`.
        this.classifyAndRememberPvp(death, { attribution,
          text: [...(pm.text ?? []), ...this.recentText(60)], frames: before });
        const file = this.writePostMortem(pm);
        death.post_mortem = file;
        if (this.lastDeath === death) this.lastPostMortem = pm;
        // WHAT THE FLEET DOES ABOUT A DEATH IS NOT A ONE-SECOND DECISION AND THE KEEPER
        // CANNOT MAKE IT. Getting back out of the Underworld is `mortality` and stays
        // here, unchanged. Whether somebody rich re-arms this character, whether the room
        // is now off the list, whether anyone is told — none of that is answerable from
        // inside one character, and today nothing asks.
        //
        // Queued rather than run here: this branch is inside the death handling, the
        // character is in the Underworld, and a playbook that walked it somewhere would be
        // arguing with the escape. It fires on the next ordinary pass.
        const pendingDeath = {
          killed_by: death.killed_by?.[0] ?? null,
          // Explicit murder is certain; article-based player guesses remain labelled.
          was_killed_by_player: attribution.was_killed_by_player,
          killed_by_player_is_a_guess: attribution.killed_by_player_is_a_guess,
          pvp: death.pvp ?? null, pvp_killers: death.pvp_killers ?? null,
          death_kind: attribution.kind,
          death_attribution: attribution,
          room: death.room_num ?? null,
          purse_lost: death.purse ?? null,
          level: levelAfterDeath,
        };
        // ON THE FEED TOO, beside the kills, and only now — after the broadcast has had
        // its couple of seconds. Recording it any earlier would put the 51%-accurate
        // guess on the live feed while the authoritative answer arrived a moment later
        // and went only into the file.
        if (this.lastDeath === death) this.pendingDeath = pendingDeath;
        tougher.recordDeath(this.who(), {
          at: death.at, killer: death.killed_by?.[0] ?? null,
          observed: attribution.observed, how: attribution.how,
          death_kind: attribution.kind, cause_observed: attribution.cause_observed,
          attribution_sources: attribution.evidence.map(e => e.source),
          room: death.died_in, room_num: death.room_num,
          level: death.level, in_safe_spot: !!diedHolding,
        });
        this.note('DIED', { ...death, ...(file ? { post_mortem: file } : {}) });
      }
    })().catch(e => {
      // A REPORT THAT FAILED MUST STILL SETTLE. This promise is memoised and re-returned
      // to every later observer, and `passUnderworld` awaits it BEFORE the escape — so a
      // rejection here is not one bad pass, it is a character that never leaves the
      // Underworld. Recording is evidence; escaping is mortality, and mortality wins.
      // The same idiom `writePostMortem` already uses one screen up.
      try { this.note('death record failed', { why: e?.message ?? String(e),
              why_it_matters: 'the death is still real and the escape still runs — only ' +
                              'the post-mortem was lost' }); }
      catch { /* the note is the last thing that may take a death down */ }
    });
    return this.deathReportTask;
  }

  observeDeathRoom(event) {
    if (!event?.roomName) return; // an unresolved resource is not proof of revival
    if (!/underworld/i.test(event.roomName)) {
      this.reportedDeath = false;
      return;
    }
    return this.observeDeath();
  }

// ── passUnderworld: extracted from pass() ────────────────────────────────
  async passUnderworld(ctx) {
    const { s, c, room, v } = ctx;
    // 1. Dead. The Underworld has no graph exits, so a character left there stays
    //    there forever unless something walks it onto a portal.
    // Check both the map room (nameRsc) and the client room (name, num).
    const roomName = room?.name ?? c?.room?.name ?? '';
    // ONE VARIABLE, TWO SPACES, AND A CONSTANT THAT ONLY MEANS SOMETHING IN ONE OF THEM.
    //
    // This read `room?.num ?? c?.room?.num ?? room?.objId` and compared it to 6. The Underworld
    // is ROOM 1 and its room object's id is 6, so the `=== 6` test could only ever fire on the
    // third fallback — and in the ordinary case the variable held 1 and the comparison was dead.
    // What actually caught a death was the NAME test beside it, which the two lines above
    // already warn is not proof when a resource has not resolved.
    //
    // So the spaces are separated and each is compared against its own constant. `UNDERWORLD`
    // is the room number, shared with the journey gate; 6 is the object id and is named here
    // because it belongs to this one room. See tools/m59-roomref.mjs.
    const roomNum   = room?.num ?? c?.room?.num ?? null;
    const roomObjId = room?.objId ?? c?.room?.id ?? null;
    if (/underworld/i.test(roomName) || roomNum === UNDERWORLD ||
        roomObjId === UNDERWORLD_ROOM_OBJECT_ID) {
      await this.observeDeath();
      this.note('woke up dead', { room: room.name, attempt: (this.underworldTries || 0) + 1 });
      // BEFORE ANY OF THE GETTING-OUT. Whatever suspended the objective — the travel job,
      // the watchdog, a take-back — this is the one moment every death passes through.
      this.journeyEndedInADeath('woke up dead in the Underworld');
      // A tell costs nothing and we have no mana for anything else.
      await this.answerWhere().catch(() => {});

      // NEVER SIT HERE. The Underworld has no exits in the room graph — only
      // portals you walk onto — so a character left in it stays in it until
      // something acts. One failed attempt is not a reason to stop trying: one or
      // two of the five fixed portals are unlit at random and the sixth changes
      // destination every few seconds, so trying again IS the strategy.
      this.underworldTries = (this.underworldTries || 0) + 1;
      // COME OUT NEAR THE CORPSE. Everything the character was carrying is on the floor
      // where it died, and the walk back is the real cost of dying — a keeper that comes
      // out at the far end of the world has turned a recoverable death into an
      // unrecoverable one. The room is in the post-mortem we just wrote, which is
      // deliberately taken before the Underworld overwrites the frames.
      const diedIn = this.lastPostMortem?.where?.num ?? null;
      // AN ISLAND DEATH GOES BACK THROUGH THE RIP (operator, 2026-10-27), and the skill does
      // that first whenever the death room is Ko'catan's and the rip still shows the island —
      // see `diedInKocatan` in m59-underworld.mjs. If it reads the island and this attempt
      // cannot get through it, the first few attempts HOLD OUT rather than take a side portal
      // to the mainland; after KOCATAN_RIP_HOLD_ATTEMPTS, out is out.
      let e = await skills.escapeUnderworld(s, { maxSeconds: 60, nearestTo: diedIn,
        kocatanHoldOut: this.underworldTries <= KOCATAN_RIP_HOLD_ATTEMPTS });
      console.error(`[autopilot] ${this.policy?.agent ?? '?'} escapeUnderworld result: left=${e.left} reason=${e.reason ?? 'none'} tried=${JSON.stringify(e.tried ?? [])}`);
      // If the legacy escape failed with a pathfinding error, try a
      // direct walk to the nearest portal, bypassing the pathfinder.
      if (!e.left) {
        const pathFail = (e.tried ?? []).some(t => /kept ending up|never got onto/.test(t.why ?? ''));
        if (pathFail) {
          try {
            const { directWalkToPortal } = await import('../m59-act/escape-underworld.mjs');
            const direct = await directWalkToPortal(c, s);
            if (direct.left) {
              e = { left: true, arrived_in: direct.arrived_in, via: direct.via };
              console.error(`[autopilot] ${this.policy?.agent ?? '?'} DIRECT WALK SUCCEEDED: ${direct.via} -> ${direct.arrived_in}`);
            } else {
              console.error(`[autopilot] ${this.policy?.agent ?? '?'} direct walk failed: ${direct.reason}`);
            }
          } catch (de) {
            console.error(`[autopilot] ${this.policy?.agent ?? '?'} direct walk threw: ${de.message}`);
          }
        }
      }
      if (e.left) {
        this.reportedDeath = false;
        this.tally.rooms_moved++;
        this.underworldTries = 0;
        this.needsRecovery = true;      // we lost everything we were carrying
        // AND DO NOT GO BACK OUT UNTIL WHOLE. A character comes out of the Underworld
        // at a fraction of its health, with mana and vigor to match, and the ordinary
        // rest threshold lets it leave again long before any of that is back — which is
        // how Scooter died twice inside forty minutes, the second time at 5 health with
        // no weapon, having been sent straight back to the room that killed it.
        //
        // This is a separate flag from needsRecovery because that one is a one-shot: it
        // fires askForHelp once and clears on the same pass. Recovery is a STATE, and it
        // has to outlive the pass that noticed it. Cleared in recovered() once health,
        // mana and vigor are all back as far as their own mechanisms can carry them.
        this.recoverUntilWhole = true;
        // When the clock started, so recovered() can give up on it. Stamped here rather
        // than on the first resting pass: the walk to an inn is part of the recovery and
        // a character that spends ten minutes failing to find one has not been recovering
        // slowly, it has been stuck, and that is what the deadline is for.
        this.recoverSince = Date.now();
        this.progress('escaped the underworld');
        this.note('escaped the underworld', {
          to: e.arrived_in, via: e.via, city: e.city ?? null,
          ...(e.wanted ? { wanted: e.wanted, got_it: e.got_what_was_wanted !== false } : {}),
          ...(diedIn != null ? { died_in_room: diedIn, hops_from_death: e.hops_from_death ?? null } : {}),
          ...(e.kocatan ? { kocatan: e.kocatan } : {}),
        });
      } else {
        this.noProgress('stuck in the Underworld: ' + (e.reason || 'no portal took us'));
        this.note('could not escape — will keep trying', { why: e.reason, tried: e.tried,
          ...(e.kocatan ? { kocatan: e.kocatan } : {}) });
      }
      return HANDLED;
    }

    // ====================== INERT STOPS HERE. TRAVELLING DOES NOT. ======================
    //
    // Everything above this line is looking: where we are, what we need, what our partner
    // should know, the observation, the frame, and — if it came to it — the death record
    // and the walk out of the Underworld. Everything below is DOING, and while an ERRAND
    // is driving this character we must not.
    //
    // Placed here rather than at the top of the pass because that is the whole point of
    // the state. A keeper stopped for an errand went blind, and the deaths that happened
    // in those windows are the ones nothing can explain afterwards.
    //
    // A JOURNEY IS NOT AN ERRAND. It steers; it does not take the body away from the
    // keeper's opinion about staying alive. `passTravelling` is that distinction — see
    // TRAVEL_GUARD_DEFAULTS for why the state exists and what killed Cccc without it.
    if (this.inert) {
      // The deadline. An errand that crashed between the hold and the restore would
      // otherwise leave a character watching itself until the next broker restart.
      if (Date.now() - this.inert.at > this.inert.maxMs) {
        const held = Math.round((Date.now() - this.inert.at) / 1000);
        const why = this.inert.why;
        this.revive('nobody came back for it');
        this.note('reviving myself — nobody came back', {
          was_inert_for_s: held, was_held_for: why,
          why: 'whatever took the controls has not given them back inside the deadline, and ' +
               'an unattended character is worse than a contested one. If that errand is ' +
               'still running it will now report being fought for control, which is the ' +
               'symptom worth seeing' });
        // Fall through and act on this pass: the character has been standing still long
        // enough already.
      } else if (this.inert.travelling) {
        // A JOURNEY IS STEERING. Ask the restricted ladder whether anything about staying
        // alive is worth interrupting it for. It returns CONTINUE when it has taken the
        // character back — and then the ORDINARY stages below run on this same pass, with
        // real numbers, because the twenty-two seconds this is here to prevent were spent
        // waiting for exactly that.
        const verdict = await this.passTravelling(ctx);
        if (verdict !== CONTINUE) return HANDLED;
      } else {
        // NOT A STALL. The supervisor restarts keepers that report no progress, and an
        // inert keeper is doing exactly what it was asked to do.
        this.progress('inert -- something else is driving');
        return HANDLED;
      }
    }

    // Just came back from the dead. Everything carried dropped where we fell, so
    // the character is unarmed and unarmoured and cannot fight anything. A human
    // in this position rests somewhere safe and asks for help, which is a real and
    // surprisingly effective move in a populated world — so do that rather than
    // walk a naked character back into a monster room.
    if (this.needsRecovery) {
      this.needsRecovery = false;
      await this.askForHelp();
      return HANDLED;
    }

    // AND THEN SIT DOWN SOMEWHERE SAFE UNTIL WHOLE. THIS IS THE POINT OF THE FLAG.
    //
    // recoverUntilWhole was already set here and already refused fights and raised the
    // resting bar — but nothing ever put the character in a chair. It relied on the
    // ordinary rest branch further down, and that branch is satisfied by health and
    // vigor, so a character at full health, 80 vigor and ten mana was "not hurt", never
    // rested, and dropped through to the farm branch, which walked it out of the inn.
    // Zoot, Rizzo and Animal each did exactly that within the last half hour.
    //
    // So make it explicit and put it AHEAD of everything else: while recovering, the job
    // is to be somewhere nothing spawns, sitting in a corner, until health, mana and
    // vigor are all back — and then to be holding a weapon before anything else happens.
    // hibernate() waits on all three now; recovered() clears the flag and has its own
    // deadline, so this cannot become a character parked for ever.
    if (this.recoverUntilWhole && !this.recovered()) {
      if (this.sanctuary()) {
        await this.hibernate('recovering after a death — health, mana and vigor')
                  .catch(() => false);
        // Everything we owned is on the floor where we died, so this is usually a
        // conjure, and the conjure is why the mana in hibernate's bar is there.
        if (!this.armedForSure()) await this.armSelf().catch(() => false);
        this.progress('recovering after a death');
        return HANDLED;
      }
      // Not somewhere safe yet. Walk to the nearest room that spawns nothing rather than
      // recovering where we stand — resting in the open is how a rest becomes a death,
      // and that is doubly true for a character that has just lost its weapon.
      const safe = this.nearestSanctuary({ maxHops: 3 });
      if (safe) {
        this.doing = 'travelling';
        this.note('going somewhere safe to recover', {
          to_room: safe.room, hops: safe.hops,
          safety: safe.safety, player_safe: safe.playerSafe,
          health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null, vigor: vigorOf(v),
          why: 'just came back from the dead with nothing on us. Resting in a room that ' +
               'spawns is the thing that turns a recovery into the next death' });
        const t = await this.travel(safe.room, { origin: keeperOrigin('underworld_escape'), maxHops: 6 })
                        .catch(e => ({ arrived: false, reason: e.message }));
        if (t.arrived) { this.progress('reached somewhere safe to recover'); return HANDLED; }
        this.note('could not reach somewhere safe', { to_room: safe.room, why: t.reason });
      }
      // No sanctuary in reach. Fall through — the danger and rest branches below are the
      // right handlers for "hurt in a bad room with nowhere to go", and holding the
      // character here would only add a way to do nothing.
    }

    return CONTINUE;
  }
  // @end 2
}
