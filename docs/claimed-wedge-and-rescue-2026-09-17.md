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

**AND WHY THE PASS BLOCKS AT ALL — a lead, and it is NOT yet a general finding.** This defect
was filed with the blocking as an unexplained given: 308s measured on an idle lab fleet, 877s
on Waldorf's death, no cause. The `prod-deploy-fa` session profiled prod on 2026-09-17 and
found the stalls hot in `_blockingWall` / `intersectNode` (`m59-roo.mjs`) underneath
`nearestSafeSpot` / `sheltersAlong` / `safeSpots` (`m59-safespots.mjs`). Janice's keeper log
was 120 of 120 lines "event loop was blocked", ~1.8–2.5s per stall, 224 seconds of blockage in
one window; Pepe 76 of 77, 157s. That profiling is theirs.

**Read the scope carefully, because its author has already corrected it once.** The first
report was "all 23 keepers stalling"; that was withdrawn the same night — after a broker
restart only 2 of 23 showed stalls, and because the restart RESET the logs most of those zeros
mean "no log yet", not "fixed". What survives the reset: the two that re-accumulated stalls
within minutes were Pepe and Janice, **both in room 578 (Cragged Mountains)**, and every stall
seen with a `nearestSafeSpot`/`sheltersAlong` caller that night was in 578. So the honest
hypothesis is that the hot path may be specific to that room's geometry, which would be far
cheaper to reproduce — one character parked in 578.

**Counter-evidence from this repository's own shadow runs, which is why it is still open.**
During the tours above, sampled live across all 23 shadow keepers, the longest pass blocks were
308,011 ms in room 150, 144,747 ms in 584, 138,684 ms in room 2, and 96,661 ms in 108 — **not
one of them in 578, on a seven-inn circuit that never enters 578.** The caveat that keeps this
from being decisive in the other direction: `longest_block_ms` is a lifetime maximum and the
room is where the keeper was when sampled, not necessarily where it blocked, and nothing
profiled the shadow blocks, so they are not attributed to the safe-spot search. What the two
readings together DO establish is that "the safe-spot search is slow in 578" is not yet
supported enough to build a fix on, and multi-minute blocks occur in fleets that never go
there.

So: `"the safe-spot search is slow"` and `"…is slow in 578"` are different bugs with different
repairs, and which one this is has not been settled. **Settle it before building either.** The
cheap experiment is the one its author named — park a character in 578, profile, then park one
in 150 and do it again; if both stall, the room is a red herring.

Either way this reorders the work. The geometry hot path blocks the pass for minutes; the
per-pass ration then hands the watchdog exactly one rescue per multi-minute block, while the
thing the rescue exists for is a body losing half a point of health a second. **The hot path is
probably the cheaper repair of the two** — a keeper that is not blocked for five minutes does
not need two rescues in one pass — but it is the one still owing a reproduction, and the
rationing fix is small, bounded and can land regardless.

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
