# The claimed body that bounces — one repair, and three more to pick up

Date: 2026-09-17. Scope: the 24-hour death review of the prod fleet (8 deaths, 2 exempt as
PVP/Morpheus, 6 defects).

**Repair #1 is DEPLOYED.** Commit `8251d7a` on `origin/main`, cut as tag
**`deploy-2026-09-17-11`**, with `prod-deploy` checked out to it and its broker and 23 keepers
restarted onto it at 21:25 on 2026-09-17. Rollback is `git -C C:/code/m59-lab/prod-deploy
checkout deploy-2026-09-17-10` plus `node tools/m59-service.mjs restart --fleet prod --http
8901 --dashboard 8902`.

**Repairs #2–#4 are unclaimed** and are written up here for whoever takes them, in the order
they should be taken. As of this document's last revision nobody is working on them: the
`prod-deploy-fa` session, which did the stall profiling below, explicitly declined the raycast
work — its own task is the fleet's kill rate and it is blocked on a doctrine restart only the
operator can run.

**Keeper citations below name SYMBOLS, not lines**, per CLAUDE.md: *"CITE THE SYMBOL, NOT THE
LINE… a harness-to-harness line number is pinned to nothing and rots the moment two trees
differ, which is always. A symbol survives a rebase."* This document learned that the hard
way. It first cited `tools/m59-autopilot.mjs` by line, and then repair #1 inserted 42 lines
*above* the #2 and #3 sites and silently invalidated every one of them — the same rot the rule
was written for, arriving from a third direction: not two checkouts diverging, but **one tree
where the repair moved the code below it**. Re-reading the numbers would only have held until
the next repair above those sites. The symbols need no maintenance.

The one exception is section #1 below, which keeps its pre-repair line numbers on purpose: it
is an argument about what the code used to do, and renumbering it against a file that no longer
reads that way would make it unfollowable.

## The window

`node tools/m59-postmortems.mjs --since 24h`, read against
`C:\code\m59-lab\prod-deploy\substrate\postmortems`:

| | character | room | killed by (server broadcast) | marker |
|---|---|---|---|---|
| 1 | Rowlf 52 | 39 Upstairs in Castle Victoria | battered skeleton | claim held, `wedges: 415` |
| 2 | Animal 55 | 599 Ukgoth | troll | claim held, froze at 4 hp |
| 3 | Animal 56 | 584 The Flatlands | spider | claim held, `for_ms: 86124` |
| 4 | Waldorf 59 | 599 Ukgoth | Guardian of Zjiria | 17 threats, return leg |
| 5 | Scooter 58 | 585 Badlands | groundworm | 4.78 hp/s burst |
| 6 | Clifford 55 | 584 The Flatlands | spider | claim held, 92 passes of refuge loop |
| — | Lew, Beaker | 544 Valley of Ileria | Morpheus (player) | exempt, per the operator |

Four of the six carry `wedged_at_death.inert = "movement held by dum/prod Valley and Castle
Victoria HP bands@pid-…"`. That string is the whole story of repair #1.

---

## DONE — #1 `keeper_blind` / `wedged`: the bounce test never ran for a claimed body

**Cited.** `pulsePosition`, **pre-repair** line 11493 — this section describes the defect as it
stood before the deploy, so its line numbers are the old ones:

```js
const bleedingWhileInert = at && this.inert
  && (this.inertBleeding(w, hp) || !!w.wedged?.inert);
```

**Mechanism.** That flag does two things: it skips the excuse ladder, and it turns on
`pennedIn` inside `stillHere` — `pennedIn` being the only test that sees a body oscillating
between adjacent squares. It asked `this.inert`: *has the keeper stood ITSELF down.* A
commander claim on `movement` (DUM, a fleetscript, a bot) deliberately leaves survival with
the keeper, so `this.inert` is null and the flag was false. The claimed body therefore got
only the exact-square test, and an oscillating character reads as **moving** on every pair —
so `w.wedged` was set to null and the episode thrown away, once per step, for ever.

`drivenByOther` (11576) and **both** rescues (11798) had already been widened to
"or a claim holds movement". This clause was left behind, so the widened rescues could only
ever act on an episode the exact-square test opened — which a bouncing body never produces.

**Failure scenario, measured.** Rowlf: `wedges: 415`, `movement.net_squares = 1` over 94.7 s,
`wedged_at_death.for_ms = 1104`. Four hundred and fifteen episodes, none older than about a
second, while he went 41 → 0 bouncing 16,8 / 17,8 / 18,8. The rescue at `INERT_RESCUE_MS`
(4 s) could never mature because the clock kept restarting.

**Repair, in `muster`.** Split the flag so the claim widens the *bounce test only*:

```js
const bleedingWhileInert  = at && this.inert && (…);
const bleedingWhileClaimed = at && !this.inert && this.facultyHeld('movement') && (…);
…
|| ((bleedingWhileInert || bleedingWhileClaimed) && this.pennedIn(w));
```

**Why not the one-line version.** Folding the claim into the single flag also skips the
excuse ladder, and for a claimed keeper — which is awake, still sets `doing`, and can be
resting or holding a wall — that flagged a character deliberately holding a safe wall. The
non-travelling rescue would then have cancelled its movement and pulled it off the wall. The
first cut did exactly that; `tools/m59-claimwedge-test.mjs` §3 is the gate that caught it and
the reason that gate exists.

**Evidence.** `node tools/m59-claimwedge-test.mjs` — 17 assertions. Run against the deployed
file it fails the 7 repair assertions and passes every regression gate:

```
M59_AUTOPILOT_MODULE=../../prod-deploy/tools/m59-autopilot.mjs node tools/m59-claimwedge-test.mjs
  →  10 passed, 7 failed      (the claimed bouncing body is never caught: wedges=0)
node tools/m59-claimwedge-test.mjs
  →  17 passed, 0 failed
```

Pre-existing suite failures are unchanged by the repair — `m59-wedge-test` 155/18,
`m59-wedgedeath-test` 21/1, `m59-travelling-test` 142/4, identical on both files.
`m59-pulse-test` 51/0 and `m59-watchdog-test` 28/0 pass.

### The shadow-fleet world tours, and what they do and do not show

Three arms of `m59-solo-run.mjs --random --legs 4 --seed 15 --stagger 5 --timeout 180` against
the 23-character shadow fleet on the loopback lab server (127.0.0.1:15959), broker 8971 out of
this checkout. A side-car held `movement` on all 23 as `dum-sim/shadow tour@pid-28472` for the
whole of every arm, so the fleet was driven the way DUM drives prod.

| arm | keeper code | fleet state | legs | arrived | timed out | **died** | median arrived |
|---|---|---|---:|---:|---:|---:|---:|
| 1 baseline | unfixed | warm, 2 days' uptime | 56 | 35 | 20 | **0** | 92s |
| 2 fixed | **fixed** | cold, just restarted | 42 | 21 | 20 | **0** | 115s |
| 3 control | unfixed | cold, just restarted | 50 | 32 | 17 | **0** | 117s |

**Arm 3 exists because arm 2 looked like a regression and was not one.** Against arm 1 the
fixed arm was slower on almost every seed-matched first leg — 12 of the 13 characters that
arrived in both, median 89s → 131s. The confound is that arm 1 ran on a fleet with two days of
warm in-memory route, shelter and tripbook caches and arm 2 ran ninety seconds after a broker
restart. Arm 3 is the same unfixed code under arm 2's cold-start condition, and it reproduces
the slowdown without the fix present: paired against arm 1 it goes 96s → 147s.

So the like-for-like comparison is **arm 3 against arm 2, both cold**, on the 13 characters
that completed leg 1 in both:

```
control (unfixed, cold)   median 145s      arrived 15   timed out 6
fixed             (cold)  median 129s      arrived 14   timed out 7
```

Nine of thirteen were faster with the fix and four slower. That is noise, and it is the
finding: **the repair costs nothing measurable at fleet scale.** A restart costs about 50%
of a leg's time; the repair costs nothing distinguishable from zero.

**What these tours CANNOT show, and it matters.** They do not demonstrate the repair working,
and no number in that table is evidence that it does. `m59-solo-run` drives each leg through
the `travel` tool, which makes the keeper **inert** for the duration — and `facultyOwner`
answers the inert reason before any claim, so the claim is masked and
`bleedingWhileClaimed` (which requires `!this.inert`) cannot fire during a leg. Sampled live
mid-arm, every wedge episode on the fleet read `inert: "travelling to …"` and **not one**
carried the `dum-sim` marker. The prod window is the other one: DUM's errand ends and releases
inert while its 900-second lease keeps running, and the character then walks under its own
keeper journey with `this.inert` null and the claim still held. That is where Rowlf, Clifford
and both Animals died, and a solo-run tour never enters it.

The evidence that the repair *works* is therefore the offline test above, run against the
deployed file. The tours are evidence that it does not hurt — which is what they were asked
for, and all they can honestly carry. **The confirmation still owed** is either a targeted live
reproduction (claim `movement`, let the claim holder stall while the keeper's own ladder walks
a hurt body into a crowd) or prod's own postmortems after deployment: the signature to watch
for is `wedged_at_death.inert` naming a claim while `wedges` runs into the hundreds.

Incidental, and it is evidence for #2 below: the fleet recorded a keeper pass blocked for
**308,011 ms** during arm 2 — five minutes, against an `INERT_RESCUE_MS` of 4,000 — on an idle
lab server with nothing else running.

**Residual, stated rather than hidden.** `pennedIn` requires every one of the newest three
samples within one square of the newest. A three-square sweep (16 → 18) still escapes it on
the triples whose endpoints are two apart. The repair converts "never caught" into "caught on
most triples", which is enough for an episode to mature past 4 s — it is not a proof that no
bounce escapes. Widening `pennedIn` itself is a handbrake change and a separate, unmeasured
decision; the code says so at `pennedIn`'s own comment and I have not touched it.

**Migration hazard — read this before the watchdog extraction lands.**
`tools/m59-watchdog.mjs` is the extracted copy of this logic (the harness working tree is
mid-migration to it). Its exported `pulse()` carries **the identical bug** — the same
`bleedingWhileInert = at && host.inert && …` — and the inert rescue in its exported `tick()` is
`host.inert`-only as well. Its documented host contract (the `host.*` list in the file header)
does not even expose `facultyHeld`, so fixing it there means extending the contract. Prod does
not run it today — `Autopilot.watchdogTick` calls the inline `this.pulsePosition`, and the
module supplies only `freshState()` — but whoever finishes the extraction will reintroduce this
death unless the fix goes across with it.

---

## TO DO — #2 `keeper_blind`: the rescue is rationed per *pass* — **PREMISE CURRENTLY ABSENT**

> **RE-MEASURED 2026-09-18 05:40, after `deploy-2026-09-18-1`. Do not pick this up on the
> evidence below without re-checking the premise first.** This defect only bites when a pass
> blocks for minutes. Over 508 seconds across all 23 prod keepers, **not one set a new worst
> pass-block** (`longest_block_ms` grew for 0 of 23), and an 11-minute window recorded **zero**
> stall lines at the shipped 1500ms threshold. The multi-minute values still visible in
> `longest_block_ms` are lifetime maxima from startup and rejoin, not ongoing cost — the same
> lifetime-max trap documented in the instrument table above.
>
> **What cannot be concluded:** that the raycast fixed it. The fleet is now 12.6% moving against
> ~28% in the pre-fix window — it is farming, not travelling — so "blocks stopped" is confounded
> between *each query got cheaper* and *the fleet stopped doing the expensive thing*. Both fit.
>
> The code defect below is real and unfixed. It is simply not currently costing anything, and it
> will return the moment the fleet travels heavily again. Cheap insurance, low present yield.
> Sized over 31 deaths in 72h: the premise (pass blocked >60s) appears in 29 of 31 — but every
> one of those deaths predates the deploy.

**Cite.** `Autopilot.watchdogTick`, in **both** rescue arms — the stalled-claimed-driver rescue
and the wedged-mid-journey rescue — the same guard clause:

```js
&& (now - wedge.since) >= INERT_RESCUE_MS && w.rescuedPass !== this.passes) {
```

**Mechanism.** The watchdog runs on its own timer *precisely because* keeper passes block —
that is the whole argument in its header. Gating its rescue on pass identity hands the
rationing back to the thing it was built to route around: one rescue per pass, and a pass can
last minutes.

**Failure scenario, measured.** Animal, 584 The Flatlands, 2026-09-17 10:42. The claim rescue
fired at −86 s. The same pass (`pass: 26412`) then ran another 135 seconds
(`summary.watchdog.pass_blocked_ms = 135618`), so no second rescue was reachable while he
stood at 30,35 and lost 30 more health — `wedged_at_death.for_ms = 86124`,
`health_lost = 30`, eight threats on him. He died in that pass.

**Deliverable.** Replace the pass-identity guard with an elapsed-time cooldown on `w` (e.g.
`w.rescuedAt` + a `RESCUE_COOLDOWN_MS` of about `INERT_RESCUE_MS`), so a long pass can be
rescued more than once. Keep a cooldown — the point of the original guard was to stop the
rescue firing every tick, and that is still right. Both rescue arms take the same
change. Test alongside `m59-claimwedge-test.mjs`: drive a wedge past the threshold twice
without advancing `host.passes`, and assert two rescues.

**AND WHY THE PASS BLOCKS AT ALL — read the instrument before the number.** This defect was
filed with the blocking as an unexplained given: 308s measured on an idle lab fleet, 877s on
Waldorf's death, no cause. Finding the cause took three readings on 2026-09-17 and the first
two were artefacts of how they were measured. That history is kept here because the same trap
is waiting for whoever picks this up.

| | instrument | what it joined | verdict |
|---|---|---|---|
| 1 | top caller of an agent's whole log, vs where that agent stood now | a block to a position minutes away | withdrawn |
| 2 | `longest_block_ms` (a LIFETIME max) vs the room at sample time | same join, other direction | withdrawn — this one was mine |
| 3 | the stall line's own room field | nothing — the line records the room it blocked IN | correct, but **counts rank by exposure** |
| 4 | #3 plus dwell sampled every 20s over the same window | nothing — gives a **rate** | **use this to rank** |

Instrument 3 is sound and still got the ranking wrong, and that is the lesson worth carrying
out of this whole section: a correct numerator ranked 599 second-worst when it is the cheapest
room on the board, because a room the fleet stands in for 35 minutes accumulates stalls a room
it passes through never will. Nothing is wrong with the counts; they answer "where did blocking
happen", and the question was "which room is expensive".

**This is a worse failure than the bad joins in rows 1 and 2, not a milder one.** A bad join
announces itself the moment anybody checks it. A correct instrument answering the adjacent
question is silent — it produces a clean, defensible table that ranks the wrong thing, and it
is trusted precisely because it is sound. Both sessions were caught by it in the same window
and in opposite directions: 584 on one side, 599 on the other. The 599 reading in particular
was confident, and was being used to correct the other session's numbers at the time.

The stall line reads `(room 578, doing travelling, travelling to 113)`. It names the room at
the moment of the block, so there is no join to get wrong. Both earlier readings — the
`prod-deploy-fa` session's and my own shadow sample of 308,011 ms in room 150, 144,747 ms in
584, 138,684 ms in room 2 — were built on a join and neither is evidence about where the cost
is. **My shadow numbers do not contradict the prod reading and I should not have written them
up as counter-evidence.** That window had almost no keeper exposure to 578.

**The count reading.** 23 prod keepers, ~35 minutes after the restart reset the logs, 106
stalls totalling 192.6s blocked — profiling by the `prod-deploy-fa` session:

```
  by room                         by top caller
  578   90 stalls  158.6s         provedSquaresUncached    52  93.3s   (m59-game.mjs)
  599   10 stalls   20.9s         nearestSafeSpot          26  44.2s   (m59-safespots.mjs)
  557    5 stalls   11.1s         _approachSquareUncached   6  11.5s
  579    1 stall     1.9s         sheltersAlong             3   5.8s
```

**THE RATE READING, WHICH IS THE AUTHORITATIVE ONE AND INVERTS THAT RANKING.** Same session,
12.0 min window, 36 dwell samples, 38 stalls, 23 keepers — numerator and denominator over the
same period:

```
  room  keeper-min  stalls  blocked_s  stalls/min  % keeper time blocked
  557         2.0       7       13.4       3.50      11.2%   <- most expensive, PROVISIONAL
  578        17.7      23       38.4       1.30       3.6%
  579         3.0       2        4.1       0.67       2.3%
  599        35.7       5        8.0       0.14       0.4%   <- CHEAP; the count said 2nd worst
  38         24.3       1        1.6       0.04       0.1%
  27         36.0       0        0.0       0.00       0.0%
  39         24.0       0        0.0       0.00       0.0%
  714        33.7       0        0.0       0.00       0.0%
  584         9.0       0        0.0       0.00       0.0%
  (~30 more rooms with dwell and zero stalls)
```

Four things in it, two of which overturn conclusions both sessions had accepted:

1. **599 is cheap — 0.4% of keeper time — and the count made it second worst.** Its 10 stalls
   were the highest dwell in the fleet (35.7 keeper-minutes), not cost. This is the exposure
   artefact both readings were warned about, landing on the count this time.
2. **557 is the most expensive room per minute and neither session had it on the list**: 3.50
   stalls/min, 11.2% of keeper time blocked, 2.7× 578's rate. **Provisional** — 2.0
   keeper-minutes and 7 stalls is a thin sample. It was third by count and first by rate, so
   the ranking flipped on the metric rather than on new data.
3. **578 survives the better metric** at 1.30 stalls/min and 3.6% blocked, consistent with the
   earlier window. Genuinely expensive, but not uniquely so and not by the margin the count
   implied.
4. **584 logged 9.0 keeper-minutes and ZERO stalls**, where 578's rate predicts ~12. That is
   evidence against my own shadow reading of 144,747 ms "in 584" specifically, and it is what a
   lifetime maximum carried in from another room looks like. (150 at 1.0 min and room 2 at 2.7
   min were also zero, but too thin to mean anything.)

**And the output neither earlier sample could produce:** rooms 27, 38, 39 and 714 each logged
24–36 keeper-minutes at zero-to-one stalls. Those are **cheap rooms measured rather than
assumed** — the distinction between a cheap room and a merely quiet one, which no one-shot log
read can make. It settles the scope: **the fleet's farming rooms are not where the cost is, so
this is a road/transit cost**, which is what the feedback finding above predicts rather than
something that undercuts it.

The 20s dwell granularity bites hardest on rooms that are transited rather than parked in —
which is both of the worst two — so **557 and 578 are floors, not estimates.**

**It is NOT "the safe-spot search", which is what the earlier drafts of this document said.**
The largest single caller is `provedSquaresUncached` at 93.3s against `nearestSafeSpot`'s
44.2s — at least two hot callers, and the safe-spot search is the smaller half. What is hot
under *both* is the raycast: `_blockingWall` and its inner `intersectNode`, in `m59-roo.mjs`
(both verified present in the deployed tree). **That is the repair site.** Optimising a
caller would leave the other callers paying the same cost.

**The confound, which cannot be removed from this data.** Rooms with no fleet presence
contribute no stalls whatever they cost. Both 578 characters were mid-journey *through* it
(Pepe to 113, Janice to 376) and Pepe had been crossing that one room for 25+ minutes. So
578's 82% of blocked time is partly that it is expensive and partly that two characters were
sitting in it.

**Which is a finding in its own right, independent of scope:** a road room that blocks the
keeper loop costs a multiple of its own transit time, because the block extends the exposure
that generates more blocks. It is a positive feedback, and it means an expensive room shows up
in the data as a *stuck* room — which is exactly how a cost problem gets mistaken for a
routing problem.

**So the experiment needs a RATE, not a count.** Park-in-578 and park-in-150 both produce
stalls in whichever room was watched longer; comparing counts measures the watching. The
comparable number is **stalls per minute of keeper time in that room**.

### The instrument, so nobody builds a fourth one

From the `prod-deploy-fa` session. Point it at the keeper band — prod is **9511–9533**
(verified: t1…t21, hk1, hk2, 23 keepers):

```js
const seen = new Set(), byRoom = {}, byCaller = {};
for (let p = 9511; p <= 9533; p++) {
  let lines = [];
  try { const r = await fetch(`http://127.0.0.1:${p}/log?n=400`, {signal: AbortSignal.timeout(15000)});
        lines = (await r.json()).lines || []; } catch { continue; }
  for (const l of lines) {
    const ms = l.match(/blocked ~(\d+)ms/); if (!ms) continue;
    if (seen.has(l)) continue; seen.add(l);                    // two reads would double-count
    const rm  = (l.match(/\(room (\d+)/) || [])[1] ?? '?';     // where it was WHEN IT BLOCKED
    const top = ((l.split('callers:')[1] || '').trim().split(',')[0] || '').trim().split(' ')[0] || '(none)';
    (byRoom[rm]   ??= {n:0, ms:0}).n++;  byRoom[rm].ms   += +ms[1];
    (byCaller[top] ??= {n:0, ms:0}).n++; byCaller[top].ms += +ms[1];
  }
}
```

Three things in it that are not obvious, each of which cost a reading:

1. **Dedupe on the whole line** — two reads of an overlapping window otherwise double-count.
2. **`callers:` names the cause; `hot:` names the symptom.** Take the caller. Reading `hot:`
   is how the raycast looks like the whole answer instead of the shared floor under several.
3. **`/log?n=400` only reaches back to the last keeper restart.** This is why the "only 2 of
   23 keepers stall" reading was mostly empty zeros rather than healthy ones — a restart wipes
   the evidence, so never compare a post-restart log against a pre-restart one.

**For the rate, the denominator has to cover the same window as the numerator:** sample every
keeper's room every 20s to accumulate keeper-minutes per room, and count only stalls whose
`resumed <ISO>` falls inside that window. A one-shot log read cannot give you this. Two outputs
worth having beyond the rate itself — *percentage of keeper time blocked per room*, which is
the number that actually says "this room is expensive", and *rooms with dwell and ZERO stalls*,
which is a cheap room measured rather than assumed. Both our earlier samples lacked the second
entirely.

Its caveat, stated by its author rather than found later: dwell is sampled at 20s granularity,
so a room a character only transits is under-counted against one it parks in. That biases
against exactly the road rooms this is about, so **treat a high rate in a transit room as a
floor.**

#### And the denominator that supersedes it: MOVING keeper-minutes (`stallshape`)

All-dwell was still wrong, because a parked keeper cannot stall in the shape that costs. Split
the denominator. `/state` exposes no `doing`, so transit is derived — a changed position in the
SAME room means that interval was moving:

```js
const PORTS = Array.from({length:23}, (_,i) => 9511+i);   // prod band
const SAMPLE_MS = 15000;
const move = {}, still = {}, last = {};
const states = await Promise.all(PORTS.map(p => get(p, '/state?fresh=1')));
for (const s of states) {
  if (!s?.agent) continue;
  const rm = s.room?.num, me = s.you || {};
  if (rm == null || me.col == null) continue;
  const prev = last[s.agent];
  const moved = prev && prev.rm === rm ? (prev.col !== me.col || prev.row !== me.row) : null;
  if (moved === true)  move[rm]  = (move[rm]  ?? 0) + SAMPLE_MS;
  if (moved === false) still[rm] = (still[rm] ?? 0) + SAMPLE_MS;
  last[s.agent] = { rm, col: me.col, row: me.row };
}
// numerator: the parser above, windowed on `resumed <ISO>`, AND cross-checked against the
// log's own /travelling|travelling to/ marker.
```

Four properties that are not obvious, from its author:

1. **`moved` is deliberately `null` on the first sample and on a room change** — a transition
   is charged to NEITHER bucket rather than guessed.
2. **A room change between samples is invisible as transit**, so moving-minutes are
   under-counted. A moving-rate is therefore a **ceiling on cost per moving minute and a floor
   on exposure** — the opposite direction from the 20s-granularity caveat above, and **they do
   not cancel.** Carry both.
3. **The travelling marker is the cross-check.** If the derived split and the log's own words
   disagree, trust the marker and distrust the split. (3 of 3 in 599 agreed, which is why the
   split is trusted at all.)
4. **It cannot see a room with no keeper in it.** That is exactly how 578 ended up unmeasured
   post-deploy, and no amount of window length fixes it — only a character going there does.

#### A finding about what a STUMBLE is, obtained from a performance fix

Worth separating out, because it is a fact about the mover rather than about this repair. The
raycast change is **answer-identical by construction**: it cannot alter a collision verdict, so
it cannot make a geometrically-refused step succeed. Therefore if a `stumble` were a geometric
refusal, this change could not have moved the count at all, and the 196 → 30 would have to
belong to the doctrine change or the restart.

It did move. So **stumbles are predominantly staleness, not geometry** — consistent with the
classic case in `travel()`'s own comment, *"the character arrives at an edge, its coordinates
read as off the grid for an instant… nothing is wrong; the position has not settled."* A keeper
that is not blocked re-observes sooner and asks its routing questions against fresher data.

The inference is only available because the repair *forbids* something. A change that could
have altered verdicts would have told us nothing about which kind of failure a stumble is.
(The restart remains a shared confound for the magnitude, and tonight's data cannot separate
them — this is a claim about the KIND of failure, not its size.)

### The prediction that makes the repair site falsifiable

A stall count cannot distinguish an expensive room from a stuck character, because each
produces the other — 578 currently shows both, with Pepe 25+ minutes crossing one room while
his keeper blocks ~1.5–2s a pass. So if some of this fleet's 578 and 599 "routing failures"
are COST rather than geometry, **they improve when the raycast gets cheaper and not when the
bake changes.** That is a test the repair site above can be held to, and it is worth running
before anyone re-bakes those two rooms.

Either way this reorders the work. The geometry hot path blocks the pass for minutes; the
per-pass ration then hands the watchdog one rescue per multi-minute block, while the thing the
rescue exists for is a body losing about half a point of health a second. **The raycast is
probably the larger win**, but it owes a rate measurement before anyone sizes it — and the
rationing fix is small, bounded, and can land without waiting for that answer.

### THE RAYCAST REPAIR IS WRITTEN AND MEASURED — commit `3f0f568`, not deployed

`RoomGeometry._blockingWall` visited EVERY internal BSP node on every collision query: the box
test sat at the top of `intersectNode`, returned null, and the traversal pushed both children
anyway. One step's collision cost scaled with the size of the WHOLE ROOM. Hoisting the box test
into the traversal lets a rejected box prune its subtree. Offline, against the shipped rooms:
**811 node visits per query → 28.2 in room 578 (−96.5%), 41ms → 3ms (12.4×)**, with the pruned
cost nearly flat at 14–29 visits regardless of room size.

Equivalence was the real work, since a faster raycast that answers differently is a silent
movement change: all 266 rooms and 109,172 internal nodes confirm every box bounds its subtree,
and 62,832 queries run through both walks agree on verdict, reason and wall index. See
`m59-raycast-test.mjs`.

**LIVE A/B ON THE SHADOW FLEET.** Twelve characters working room 578, two 5-minute windows,
identical but for `M59_RAYCAST_NO_PRUNE`. The stall threshold was lowered to 150ms
(`M59_LOOP_STALL_MS`) in BOTH arms because at the shipped 1500ms the lab fleet is silent —
it does not reproduce prod's blocking, and three earlier attempts measured nothing at all.

```
                         prune OFF      prune ON      change
  stalls                    90             49          -46%
  blocked total           42.7s          11.6s         -73%
  room 578 blocked        17.8s           7.4s         -58%
  room 579 blocked        23.2s           2.6s         -89%
  _approachSquareUncached  7.9s           2.4s         -69%
  shadow keeper CPU      222.9s         193.8s         -13%
  prod keeper CPU        377.3s         452.4s         +20%   <- control
```

**The control is what makes this readable.** The prod keepers, untouched by the change, used
20% MORE cpu during the second window — the machine was busier, not quieter. The shadow fleet's
13% cpu drop happened against that, so it is a conservative figure rather than an artefact of a
calmer box. (A single 5-minute window per arm, one character drifted out of 578 in arm B
(11/12 vs 12/12), and the arms were not repeated: this is a direction, not an effect size.)

**Read the room-578 line carefully, because it is the interesting one.** Stall COUNT there
barely moved (35 → 36) while blocked TIME fell 58%. The fix does not stop the keeper being
interrupted; it makes each interruption shorter. That is exactly the signature a cheaper
raycast should produce, and it is a different claim from "fewer stalls".

**What this does NOT establish.** The lab's hot callers are not prod's: this fleet farms in
place, so its biggest caller was `snapshot`, while prod — whose characters run long journeys —
is dominated by `provedSquaresUncached` (93.3s) and `nearestSafeSpot` (44.2s), which barely
appear here. So the lab understates the prod effect and cannot confirm the prediction above.
That still wants prod's own stall rate after deployment, with 599 as the control that should
not move.

### DEPLOYED 2026-09-18 as `deploy-2026-09-18-1`, and what prod actually shows

**A DWELL DENOMINATOR IS STILL THE WRONG ONE — this is the fourth time exposure inverted a
reading, and it caught the post-deploy numbers too.** The first clean post-deploy readings
(zero stalls fleet-wide; 599 at 17.7 keeper-minutes and zero) were **diluted, not clean**:
the fleet had largely stopped travelling, and a keeper standing still cannot stall in the shape
that produced the pre-fix cost. `prod-deploy-fa` rebuilt the instrument to split dwell into
**moving** and **stationary** keeper-minutes (position changed between 15s samples ⇒ that
interval was transit) and rate against MOVING time. 12.0 min, 48 samples, 23 keepers, 3 stalls:

```
  room   moving-min  still-min  stalls  stalls/MOVING-min
  714       15.8       14.8        0        0.00
  599       10.3       15.0        3        0.29   <- all 3 carry a travelling marker
  27         5.0       25.0        0        0.00
  38         4.5       33.3        0        0.00
  39         1.5       44.0        0        0.00
```

**The farming rooms are ~90% stationary** (39 is 44.0 still against 1.5 moving). So any
all-dwell rate computed while the fleet farms is dominated by keepers standing in one place —
which is exactly how the first post-deploy table looked so good.

**599 STILL STALLS WHEN TRANSITED**, 3 stalls in 10.3 moving-minutes, every one marked
travelling. Transit cost has not gone to zero, and whether the residual is this code path or
another is not established.

**BUT 0.14 → 0.29 IS NOT A REGRESSION, AND MUST NOT BE READ AS ONE.** The pre-fix 0.14 was
stalls per ALL-DWELL minute; the 0.29 is per MOVING minute. Different denominators, not
comparable. On the pre-fix denominator the same post-fix window gives 3 / 25.3 = **0.119**,
against 0.140 before — flat to slightly down, on 5 and 3 stalls, which is no signal either way.
Which is what a control is supposed to do: 599 was measured cheap and did not move.

**578 IS UNMEASURED POST-FIX.** Nobody entered it during that window, so the room the whole
prediction turns on has no post-deploy transit data at all. Treat it as open. The earlier
"zero over 8.7 keeper-minutes" claim is withdrawn — it could not establish those minutes were
transit.

**What the deploy DID move**, fleet-wide and on the same 1500ms threshold: 38 stalls per 12 min
→ 3. From the savelog ledger, independent of the stall threshold entirely: interrupted journeys
298 → 25, raw arrival 40% → 64–73%, stumbles 196 → 30. Fleet kills 1.28 → 3.47 per
character-hour — that last one confounded by a doctrine change landing in the same window, by
its author's own statement.

**The mechanism, stated because it is falsifiable.** This repair is answer-identical by
construction, so it cannot change a single collision verdict and therefore cannot make a
geometrically-blocked step succeed. A `stumble` is not a geometric refusal — it is a transient
failure to progress, the classic being *"the character arrives at an edge, its coordinates read
as off the grid for an instant… nothing is wrong; the position has not settled."* Those are
STALENESS failures. A keeper that is not blocked re-observes sooner and asks its routing
questions against fresher position data. So the causal claim is **"the keeper keeps up"**, never
"the geometry changed" — and if stumbles had been purely geometric, this change could not have
moved them at all. It also means the restart is a shared confound: a wedged character re-reading
a room burns stumbles repeatedly, and the restart cleared those.

**RECOMMENDATION FOR WHOEVER MEASURES THIS NEXT: make the moving/stationary split the default,
not the follow-up.** Four readings tonight were inverted by exposure — a correct count ranking
599 worst when it was cheapest, a lifetime-max joined to the wrong room, a rate diluted by
standing keepers, and a "zero" that measured who happened to be parked. The instrument is
`stallshape.mjs` (prod-deploy-fa's). The open test is unchanged and now sharper: **a window with
real transit through 578 under load.**

## DONE — #4b the open freeze, DEPLOYED as `deploy-2026-09-18-2`

Filed here as small (2 of 31 deaths). **It was not small, and the sizing was the wrong
instrument.** Counting deaths whose own trail shows a freeze undercounts it, because the
tactic's cost lands on characters that froze and then died of something else a few seconds
later in a room they never left.

**The cluster, from the `prod-deploy-fa` session's window-3 analysis.** Window 3 (23:00–02:00)
had 5 deaths where windows 2 and 4 had none. Killers: `{"Guardian of Zjiria": 3, "troll": 2}` —
**every one a room 599 creature** — with `deaths_in_safe_spot: 1`. Animal is one of the five:
599, `in_safe_spot: false`, frozen twelve seconds at 4/55, `before {health: 4} → now
{health: 4}`, dead 1.4s after unfreezing. Five deaths, one room, one tactic. That session had
been holding those deaths against its own overfarm push; overfarm was live for the whole of
window 4, which had zero deaths, so it does not fit and the freeze does.

**The rule now:** no wall and no player → refuse, and fall through to a rung that MOVES. A wall
is still fine (there the freeze is half of reconnect-TURN-heal, which is what arms
`PFLAG_MOVED_SINCE_ENTRY`). A player is still fine — a person can be convinced you are dead, a
monster cannot. Reverses the 2026-09-10 instruction; both rounds kept in the source.

**THE ROLLBACK CRITERION, and it is a real risk rather than a formality.** Falling through to a
rung that moves, at 4/55 with every exit through fifteen trolls and three Guardians, is not
self-evidently safer than standing still — it is better only because the freeze was measured to
buy *zero* health, not because crossing that crowd is safe. So the failure mode is a character
that now dies **in transit** rather than stationary, landing in a different bucket than the one
this empties.

> **If `deaths_travelling` rises while total deaths do not fall, this change MOVED deaths
> rather than prevented them — go back to `deploy-2026-09-18-1`.** Window 3's baseline is 2 of
> 5 travelling. Do not read one window either way.

**Side effect worth expecting rather than misreading:** converting open freezes into refuge
attempts and withdrawals turns stationary keeper-minutes into MOVING ones — the exact
denominator the 578 test has been starved of. More exposure in the next moving-rate table is
this working, not drift.

## TO DO — #5 `provedSquares` memoises on the FINE position, so a walking body never hits it

**The best-value item on this list as of 2026-09-18, and it is a MEASUREMENT before it is a
fix.** Added after the raycast landed, because it is the residual that repair structurally
cannot touch: the raycast made each collision query ~14× cheaper; this is about how many
queries happen at all.

**Cite.** `m59-game.mjs`, `provedSquares` — the memo wrapper around `provedSquaresUncached`:

```js
const memoKey = `${from.row},${from.col}|${from.x},${from.y}|${steps.length}|…`;
if (hit && now - hit.at < 2000) return hit.value;
const value = provedSquaresUncached(geo, from, steps);
if (perGeo.size > 64) perGeo.clear();
```

**Mechanism.** The key carries `from.x, from.y` — the FINE position, not just the square. A
walking body has a different fine position on essentially every call, so the key is unique
every time and the cache cannot hit **for a moving character**, which is exactly when it is
called most and exactly the workload that stalls. Two aggravators: a 2s TTL, and a wholesale
`perGeo.clear()` at 64 entries rather than evicting one.

**Evidence it matters.** `provedSquaresUncached` was the single largest caller in the prod stall
profile at **93.3s inclusive**, more than double `nearestSafeSpot` (44.2s) — i.e. the *uncached*
path dominates, which is what a never-hitting cache looks like.

**Why this is NOT a free win, and must not be done the way the raycast was.** The raycast prune
was answer-identical by construction. **This is not.** Whether a step is provable may genuinely
depend on where in the square the body stands, so loosening the key could change movement
decisions. The order of work is therefore:

1. Instrument the memo for a real hit/miss rate — establish the cache is actually missing before
   changing anything. (If it hits, this item is void.)
2. Determine whether fine position changes the ANSWER: same square, many fine positions, compare
   `provedSquaresUncached` results. That is the equivalent of the 266-room bbox scan, and it is
   what licenses any change.
3. Only then quantise the key — and only to a granularity step 2 shows is safe.

**Deliverable if steps 1–2 hold:** quantise the fine component, evict one entry rather than
clearing 64, and revisit the 2s TTL. With a test in the shape of `m59-raycast-test.mjs` — run
both key schemes over a real corpus and assert identical results.

## TO DO — #3 `guard_did_not_fire`: after the rescue, the holder's walk comes straight back

**Cite.** `Autopilot.watchdogTick`, the claimed-mover branch — `else this.note('WATCHDOG — the
mover was claimed and had stopped; cancelled its walk', …)` — and the comment immediately above
it, which ends "…taking ownership back is the operator's call (`autopilot action=release`), and
survival never needed it to act. The claim stands".

**Mechanism.** The rescue cancels the *current* walk but deliberately leaves the claim in
place. The holder is still driving, so it re-issues, and the escape the survival ladder just
planned is cancelled by the next command from the very driver that had stalled.

**Failure scenario, measured.** Animal again: fourteen seconds after the rescue his own escape
logged `"why": "movement cancelled by a newer command", "tried": 0`, then `"could not leave"`,
then a reconnect to shed the crowd; he never moved again and died 72 s later. Clifford's
version is the same shape from the other side — 92 consecutive passes of
`nearest_refuge` / `logoff did not establish recovery` / `survival alternatives exhausted`
at 4/55 health, one pair per second for 90 seconds, the safe-spot walk finally issued 0.3 s
before death.

**Deliverable — one of these two, and it is a judgement call, not a defect with one answer:**

- *Keeper side.* A survival-precedence window: while below the flee line and inside N seconds
  of a rescue, refuse the claim holder's movement commands (refuse, do not silently drop —
  the holder must be able to see it). This keeps ownership with the operator while making the
  claim yield to survival, which is what the faculty split already promises in
  `PROTECTED_FACULTIES`.
- *DUM side.* `src/act/errands.mjs` aborts a travel step when the subject drops below its own
  flee line. `isStranded` (`src/decide/rules/station.mjs:202`) already refuses to *start* a
  journey on a hurt character; nothing stops one mid-leg. This is the smaller change and it
  does not touch the keeper.

**The question only the operator can answer:** which side owns "survival outranks the claim".
The faculty design says the keeper never yields survival; the claim comment says ownership is
the operator's to take back. Those two are in tension exactly here.

## TO DO — #4 `doctrine_wrong` / `routed_into_a_crowd`: the sell circuit is back on the roads that were measured as the killer

**Cite.** `doctrines/local/prod-valley-ileria.jsonc` lines 186–189, which is the fleet's own
measurement:

> of 26 deaths in one six-hour window, 22 were on its road — 585 the Badlands 7, 597 the
> Twisted Wood 6, 584 the Flatlands 5, 598 Cragged 2, 599 Ukgoth 2 — against 3 in any actual
> hunting ground.

`prod-castle-hp-bands.jsonc` then hands economy back to the keeper (`"claim": {"economy":
"keeper"}`) and switches on `sell_when_broke`, and this window reproduces that table exactly:
all six defect deaths were `travelling`, on those rooms — 584 twice, 585 once, 599 twice, 39
once.

**Mechanism.** Repairs #1–#3 make a stalled traveller survivable. They do not reduce the
number of times a character is sent down a road the fleet has already measured as the place it
dies. Two specifics worth having on their own:

- **584 The Flatlands, squares 30,35 and 32,35.** Clifford and Animal died on adjacent squares
  of the same room hours apart, both to spiders, both mid-crossing. That is a chokepoint, not
  bad luck — `m59-death-patterns.mjs` is the tool that names this class.
- **599 Ukgoth on the return leg.** Waldorf met 17 threats and Animal 15 walking *back* to room
  39. `threats.most_at_once` ≥ 15 on a transit route is the `routed_into_a_crowd` signature.

**Deliverable.** Route the Barloque circuit around 599; re-spot or waypoint the 584 crossing.
Both are doctrine/route edits with no keeper change. If the circuit is not worth that, the
alternative the doctrine already documents is to cut it again — that decision is the
operator's, and the evidence for re-cutting it is above.

## TO DO — #4b (small) the freeze rung will play dead at critical health with something adjacent

**Cite.** `froze_at` / `refusing to freeze again` at lines 22124–22166; the guard's own note
says playing dead "recovers vigor and never health".

**Failure scenario.** Animal's second death spent its final 12 seconds frozen at **4** health
(`froze_at: 4, times: 2`) with a troll in reach, unfroze, and died 1.4 s later.

**Deliverable.** Refuse the freeze when health is already below the flee line *and* a threat is
in swing range — the existing note proves the rung knows freezing cannot help there; it just
does not consult health before choosing it.

---

## Order, and why

#1 (done) → #2 → #3 → #4. This is the critic's own ordering: the early ones are defects in
*whether the fleet was being driven at all*, the later ones in *what it decided while it was*.
A blind keeper explains the crowd; the crowd does not explain the blind keeper. #2 and #3 are
both small and both touch the same forty lines, so they are naturally one sitting — but they
are separate defects with separate evidence and should land as separate commits with separate
tests, each tagged `#movement`.
