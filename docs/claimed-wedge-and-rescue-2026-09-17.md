# The claimed body that bounces — one repair, and three more to pick up

Date: 2026-09-17. Scope: the 24-hour death review of the prod fleet (8 deaths, 2 exempt as
PVP/Morpheus, 6 defects). Repair #1 is done and is in this checkout. **Repairs #2–#4 are
written up here for somebody else to take, in the order they should be taken.**

All line numbers are `tools/m59-autopilot.mjs` in **`C:\code\m59-lab\prod-deploy`**, which is
what prod is running (`bcd302d` plus two commits that do not touch this file). `muster` is the
same file at the same commit, plus repair #1.

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

**Cited.** `pulsePosition`, prod-deploy line 11493:

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
mid-migration to it). It carries **the identical bug** at its line 393, and its rescue at 490
is `host.inert`-only as well. Its documented host contract (line 37) does not even expose
`facultyHeld`, so fixing it there means extending the contract. Prod does not run it today —
`watchdogTick` at 11635 calls the inline `this.pulsePosition`, and the module supplies only
`freshState()` — but whoever finishes the extraction will reintroduce this death unless the
fix goes across with it.

---

## TO DO — #2 `keeper_blind`: the rescue is rationed per *pass*, and a blocked pass is minutes

**Cite.** Line 11800 (and the same clause at 11705):

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
rescue firing every tick, and that is still right. Both sites (11705, 11800) take the same
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
| 3 | the stall line's own room field | nothing — the line records the room it blocked IN | **use this** |

The stall line reads `(room 578, doing travelling, travelling to 113)`. It names the room at
the moment of the block, so there is no join to get wrong. Both earlier readings — the
`prod-deploy-fa` session's and my own shadow sample of 308,011 ms in room 150, 144,747 ms in
584, 138,684 ms in room 2 — were built on a join and neither is evidence about where the cost
is. **My shadow numbers do not contradict the prod reading and I should not have written them
up as counter-evidence.** That window had almost no keeper exposure to 578.

**The reading that stands.** 23 prod keepers, ~35 minutes after the restart reset the logs,
106 stalls totalling 192.6s blocked — profiling by the `prod-deploy-fa` session:

```
  by room                         by top caller
  578   90 stalls  158.6s         provedSquaresUncached    52  93.3s   (m59-game.mjs)
  599   10 stalls   20.9s         nearestSafeSpot          26  44.2s   (m59-safespots.mjs)
  557    5 stalls   11.1s         _approachSquareUncached   6  11.5s
  579    1 stall     1.9s         sheltersAlong             3   5.8s
```

**It is NOT "the safe-spot search", which is what the earlier drafts of this document said.**
The largest single caller is `provedSquaresUncached` at 93.3s against `nearestSafeSpot`'s
44.2s — at least two hot callers, and the safe-spot search is the smaller half. What is hot
under *both* is the raycast: `_blockingWall` and `intersectNode`, `m59-roo.mjs:1083` and
`:1103` (verified present in the deployed tree). **That is the repair site.** Optimising a
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

## TO DO — #3 `guard_did_not_fire`: after the rescue, the holder's walk comes straight back

**Cite.** Lines 11840–11852, the comment that ends "…taking ownership back is the operator's
call (`autopilot action=release`), and survival never needed it to act. The claim stands".

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
