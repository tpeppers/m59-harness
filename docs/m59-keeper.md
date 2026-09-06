# The keeper: what it can see, and what it cannot

Split out of [`CLAUDE.md`](../CLAUDE.md). Postmortems, the watchdog, the yield check, and the counters that are not rates.

## What a death record can and cannot say

- **A POSTMORTEM KNOWS WHAT KILLED IT AND USUALLY DOES NOT KNOW WHERE.** The two halves of
  a death have completely different evidence behind them and must never be read the same
  way. **What** is announced by the server to the whole world — `### X was just killed by a
  Y.` (`system.kod:49-57`, caught as `killed_by_broadcast`), an observation. **Where** is
  reconstructed from the keeper's last frame, and a keeper pass can be a single `await`
  lasting minutes, so the record names the last place anybody looked. Measured over 637
  deaths: the last frame is more than a minute stale in 203 of them, worst case 17 minutes.
  That is why the raw data lists inns as places characters died. Nobody died in an inn.

  `m59-postmortems.mjs` refuses to place a death unless an independent observation lands
  within 30 seconds of the killing blow — a `hits` segment first, because the event stream
  keeps recording while the keeper is blind, then the last frame. The window is measured,
  not chosen: 30s keeps 384 of 637 and leaks no inn, 60s starts letting them back in. The
  253 it cannot place are reported as a count, never as a room.

- **"WAS THE KEEPER UP" IS THE WRONG QUESTION. IT USUALLY WAS, AND IT USUALLY WAS NOT
  LOOKING.** Of 715 deaths, 645 had a keeper the uptime ledger says was running — and
  **521 of those 645 (81%) had it BLIND at the moment of death**, median gap 18 seconds,
  p90 219 seconds. A pass can be a single `await` lasting minutes (a travel loops up to 25
  hops with no observation in it), so the keeper goes on deciding against a view of the
  world that stopped changing. Every one of those decisions includes "should I flee".

  `keeperOf()` in `m59-postmortems.mjs` therefore answers both halves, and the deaths page
  shows `Y 3s` / `Y blind 18s` / `N` rather than a bare Y. The blind threshold is
  **`WATCH_MS`, 8s — the keeper's own `resyncMs` default**, the longest it is designed to
  go without re-asking the server. It is deliberately NOT `TRUST_MS` (30s): that one asks
  whether a reading still places a death, this one asks whether the keeper could have acted
  on it, and a character can bleed out entirely inside a window that still places it.

  The worked example is Camilla, 2026-08-06 23:59. The keeper was up continuously for 16
  minutes either side. At −18.0s it saw 69% health, took a safe spot and refused to rest in
  the open. **0.2 seconds later, in the same pass, the room check fired — "this room cannot
  produce our prey — leaving now" — and it gave up the wall it had just taken (`held_s: 0`)
  and walked.** Its last frame reads 22/29, above its own flee threshold of 0.69. The
  event stream recorded the next 18 seconds — 22 → 19 → 18 → 16 → 14 → 11 → 10 → 5 → 4 → 0
  — while she ping-ponged across the 574/584 boundary taking a hit from each room's
  monsters on every crossing. She never swung once; `ms_since_swung` was 409783.

  **`leaveHold` now refuses a DISCRETIONARY departure below the rest threshold** — routing,
  roaming, banking and errands all go through it, and the room will still be the wrong room
  in thirty seconds. `force: true` keeps the withdraw path open, because a hurt character
  is exactly who is withdrawing. `readyToLeaveSanctuary` is the same rule for inns and does
  not cover this: it returns true immediately unless `sanctuary()`, and a monster room with
  a proven wall in it is not one — though it is the safest square in the world to be hurt
  in, which is precisely why leaving was the mistake. The refusal cannot deadlock (the rest
  gate above rests to full on the wall) and is capped at three minutes anyway.

## The watchdog, and the counters that are not rates

- **THE KEEPER IS A LONG-AWAIT MACHINE, AND THE WATCHDOG IS THE ONLY THING WATCHING
  DURING ONE.** `pass()` is one async function and a single `await` inside it can run for
  minutes. Measured across 703 deaths with a usable frame: **82% had the keeper blind
  (>8s since its last observation) at the moment of death**, and the last thing it was
  doing breaks down as

  | doing | deaths | mean blind | worst |
  |---|---|---|---|
  | travelling | 203 | 183s | 909s |
  | recovering | 153 | 73s | 736s |
  | stalled | 120 | 40s | 1043s |
  | fighting | 87 | 44s | 540s |

  **Bracketing the await does not fix it, and travel already brackets.** `Autopilot.travel`
  records 'setting off' and 'arrived' frames either side; Camilla's last frame reads
  `why: "setting off"` 17.8s before she died, and the `finally` frame never described
  anything because she died inside. A bracket tells you when the blindness started.

  So the fix is a timer, not another await. `startWatchdog()` ticks every 500ms
  independently of the pass — free, because the server PUSHES health, so `client.vitals()`
  is live whatever the call stack is blocked on. It writes a frame on every health change
  and at least every 8s, and if health crosses the flee line while a pass has been blocked
  over 3s it calls `Session.cancelMovement()`, which travel honours in twelve places
  including inside the paced step loops. **It decides nothing** — it interrupts, and the
  ordinary pass, which already knows how to flee and rest, decides with fresh numbers.

  Worth knowing before extending it: `restUntil` already polls every 3s and aborts on
  damage, and `fight` already aborts below `disengageAt`. **Travel was the only long await
  with nothing watching health**, which is why it is both the largest bucket above and the
  one the interrupt targets. An interrupt that costs an errand its attempt is the correct
  outcome, not a bug to route around.

- **"YOU SUDDENLY FEEL A LITTLE TOUGHER." IS THE ONLY ANNOUNCEMENT OF THE ONLY THING THIS
  FLEET IS FOR, AND NOTHING WAS LISTENING.** `player_improve_maxhealth` (`player.kod:144`)
  is sent the instant `GainBaseMaxHealth` fires, inside the killing blow. The ledger
  instead INFERRED gains by diffing five-minute samples, so two points in one window were
  one event, a point gained and lost in the same window was no event, and anything during a
  broker outage never happened. `m59-tougher.mjs` catches the line and attributes it to the
  kill that paid for it — which the diff could never do.

  **Attribution is symmetric in time and that is not fussiness.** The kill is written down
  after `fight()` returns; the message is read off the event ring on the next pass. So the
  kill usually lands a few milliseconds AFTER the announcement it caused. Requiring it to
  come first filed the fleet's very first real gain — Lew 22→23 in The Queen's Way — as
  "cause unknown" with the kill sitting in the feed 40ms later.

- **A COUNTER THAT LIVES ON THE KEEPER IS NOT A RATE, BECAUSE THE KEEPER IS RESTARTED
  ABOUT ONCE A MINUTE.** `Autopilot.tally.kills` and `killTimes` are both fields set to
  empty in the constructor, and the external supervisor stops and restarts keepers
  continuously — so both mean "since the last restart" and neither can answer "is this
  character earning now". The board's `kills/30m` was worse than wrong: `recordSample`
  never wrote the field at all, so `r.kills_30m` was undefined on every render, `?? 0`
  made it a number, and the template paints zero in the colour reserved for a broken row.
  Twenty-one characters that had killed at least 26 things in half an hour rendered as a
  page of red zeroes, and plumbing the keeper's own figure through would only have
  changed a permanent zero into a near-permanent one.

  Kills are therefore appended to the ledger as `killed` events at the moment of the
  kill, and `countKills` in `m59-ledger.mjs` is the **only** definition of the number —
  the web board and the broker's live rows both count the same events, because a
  quantity with two homes in this repository has always ended up with two answers.
  `kills` beside it is still a high-water mark over the whole window (`Math.max`, for
  exactly the same restart reason), so a row honestly reading `134` and `0` is not a
  contradiction: the two columns are on different clocks and neither is the other's rate.

## A wedge broken by a cancel is a wedge re-issued

The second arm of the watchdog — "wedged while perfectly healthy" — has exactly one action,
`cancelMovement()`, and its own comment says why: "so the next pass can decide with real
numbers — this keeper does not decide anything itself". That is the right division of
labour and it had a hole in it. **The numbers were not real. They were identical**: the
next pass re-decided from the same square, in the same room, with the same destination and
the same policy, so it emitted the same walk, which wedged on the same server-side
condition, and the arm broke it again. Measured on `acba925`, one character, two
incidents (issue #37):

| | where | how long | what the record showed |
|---|---|---|---|
| transit stall | room 575, assigned to 586 | 93 minutes, 217 passes | 589 wedge-breaks, 28 placement failures all reading `movement cancelled by a newer command`, zero rooms entered |
| death | square 18,18 of room 586 | 18.5 minutes | seven threats in the room, health 22 → 3, `squares_per_second: 0` across 46 frames, every decision-trail entry a variant of "moving to somewhere I can heal", killed by a centipede mid-"travel" |

The second is the worse one, and it is a second hole rather than the same one. Below the
flee line with something adjacent, every rung the ladder had was **movement-shaped** —
run for a town, a route-adjacent spot, "somewhere I can heal", the nearest exit — and the
in-place rungs each refused for their own correct reason ("a freeze recovers no health").
Movement was the thing that was not happening, so the ladder chose it eighteen minutes
running, from a square the body never left. At 3 of 22 with a mace, one swing at the
adjacent centipede had more expected value than the eighteenth minute of "moving".

Three changes, one per hole and one for the bound, and none of them moves a decision
into the watchdog:

- **The break records where it happened and counts.** Both copies of the arm — the module's
  `tick` and the autopilot's `watchdogTick` — call `noteWedgeBreak` with the pinned anchor
  (where the wedge *started*, which a pocket-wanderer's newest pulse is not), and
  consecutive breaks within the pinned radius are one wedge with a climbing `repeats`.
  The note carries `repeats_here` and the `status` snapshot carries `wedge`, so one poll
  shows the loop instead of 217 identical trail entries.
- **`travel()` reads it at the single gate, before setting out** — the same gate the
  confinement is enforced at, for the same reason: the loop is a property of re-issuing,
  not of any one caller. Below `WEDGE_REPEAT_CAP` (5) the body is **sidestepped two squares
  in a rotating direction first**, so the plan starts from the one input the planner cannot
  get from the map. At the cap the pass **gives up out loud, once** — `WATCHDOG — gave up:
  5 walks from the same square went nowhere` — and every walk from that place is refused
  fast, without a new line, until `WEDGE_GIVEUP_HOLD_MS` (2 minutes) expires. Then the
  record is dropped and the count starts fresh: a transient wedge earns another try, a
  permanent one earns another single line two minutes later, which is a cadence an operator
  can read and `m59-recordjam.mjs` can be pointed at. Moving away drops the record too; an
  unknown position does not, because "I do not know where I am" is not evidence of having
  moved.
- **Wedged, hurt and something in reach trades in place**, ahead of every rung that answers
  being hurt with distance. `tradeInPlaceIfWedged` is gated on being below the flee line
  with no working wall, and `wedgedInPlace` answers from four signals — a recorded break,
  a hold, the pulse's same-square episode past `WATCHDOG_PINNED_MS`, or an anchor that old
  — because the arm itself only fires at full health and the character in the second
  incident was being eaten. `wedgedInPlace` has exactly two callers, this and
  `escapeIfWedgedAndHurt`; **it does not gate the escape ladder**, so shortening its clock
  does not make the ladder run sooner — it makes a hurt character stand and swing, and
  pre-empts the panic-logoff rung below it. The swing holds position and never disengages: disengaging is
  what was already not working. `trade_in_place_when_wedged: false` switches it off per
  character.

**Recording a wedge and cancelling a walk are two decisions.** The escape ladder is reached
from `answerWedge`, which needs `wedgeBreak`, which only the healthy arm in
`m59-autopilot.mjs` writes. That arm used to do both behind one `if`, so raising
`WATCHDOG_HEALTHY_CANCEL_MS` — the supported way to stop the watchdog manufacturing
journeys — also stopped the ladder ever running for a healthy character, silently and with
nothing logged. The record is now gated on `WEDGE_LADDER_MS` (10s, overridable in
`substrate/watchdog.local.json`) and the cancel on `WATCHDOG_HEALTHY_CANCEL_MS`. Five
records at one place is `WEDGE_REPEAT_CAP`, so the ladder is climbed after ~50s of
deliberate stillness. `pinnedSince` is cleared only by a real cancel, or the survival rungs
above would never reach `WATCHDOG_PINNED_MS`.

`node tools/m59-wedge-test.mjs` (141) is the guard, and it pins the call sites by source as
well as the methods by driving them — a rung that exists and is never reached is what the
second incident was made of.

## Being spoken for, and earning nothing

- **A CHARACTER CAN BE SPOKEN FOR, AND THE BOARD HAS TO SAY SO.** A loot run, a
  provisioning cast, a signet errand and a pairing all have another end, and pulling a
  character out of one abandons that end silently. `m59-commitment.mjs` is the single
  rule for what counts; the keeper publishes it as `committed` on its status and on the
  fleet row, and `m59-tui.mjs` greys those rows and steps over them, with `X` to override
  and take one back. Add a new errand kind and it shows up on the board that day — an
  unrecognised kind is reported as itself rather than dropped, which is what stops a new
  operation being invisible to the one thing meant to protect it.

- **A KEEPER EARNING NOTHING LOOKS EXACTLY LIKE A HEALTHY ONE, AND THE CHECK THAT SAYS SO
  WAS UNREACHABLE FOR A YEAR.** `noProgress()` fires when nothing WORKS. `yieldCheck()` fires
  when everything works and none of it is worth anything — the keeper kills something every
  pass, so `progress()` fires, so the stall detector never trips, and the board reads
  `hunting: giant rat` for as long as you leave it.

  It never ran. The guard was `if (purpose !== 'advance') return null`, **`null` means "no
  opinion"**, and `policy.purpose` was not in the `autopilot` tool's schema — so every keeper
  in the fleet ran at `purpose: null` and the audit was off. Both halves are fixed: `purpose`
  and `goals` are settable over MCP, and an **unrecognised** purpose is now reported as such
  rather than silently disabling the check.

  There are two, and the second exists because **advancement is not the only reason to be
  out**. Ten characters are at max health 50 and a level-50 fungus beast cannot advance them
  (the rule is strictly greater) — which does not make their day worthless, it makes it a
  different job:

  | `purpose` | asks | from |
  |---|---|---|
  | `advance` | can this creature still raise what `goals` names? | the spawn index |
  | `equip` | does this creature drop anything this character is still short of? | **the loadout** |

  `equip` reads the gear gap rather than a constant, because "what this character needs" is
  exactly what a loadout is for and a second definition would drift from the first. Three
  things it does deliberately:

  - **A missing loadout is not an empty one.** Everywhere else in the keeper a null loadout
    means "carry on as before"; here it means the question cannot be asked, because the list
    *is* the loadout. Reporting a gap of zero would read as "finished".
  - **FINISHED AND FUTILE ARE BOTH "NOT PAYING" AND ONLY ONE IS BAD NEWS.** A character whose
    list is complete renders as `list complete, nothing left to fetch` and wants re-tasking;
    one grinding prey that can never drop what it needs renders as `PAYS NOTHING`.
  - **A treasure share is not a per-kill chance.** The table is rolled `1 + level/55 +
    random(0, difficulty/3)` times, so `per_roll_percent` is one roll's share; carried gear
    (`per_kill_percent`) is the real thing. They are kept under separate names so nobody
    averages the two columns.

  And the reason this needed the spawn work first: **every faction troop is `TID_NONE`** —
  the treasure table honestly says they drop nothing, because their gear is `plUsing` dropped
  by `DropEquipment` on a roll the extractor never saw. Asked "does a soldier drop leather"
  from `loot` alone, the answer was a confident no.


## A keeper process called its own fleet strangers

On 2026-08-27, 04:25–04:30Z, four prod keepers returned fire on Statler in the Valley of
Ileria until he was dead. He was red — a hand mis-click while piloting him had attacked an
innocent with safety off, which is the one path in `CheckStatusAndSafety`
(`player.kod:3815-3847`) that sets `PF_OUTLAW` — and the server's safety flag *permits*
hitting an outlaw. That satisfied the live-flag rule. The memory rule was satisfied by a
grudge book that named him as an attacker thirteen times.

**None of those thirteen were real.** `substrate/grudges-prod.json` held entries for twenty
of the twenty-one characters in the roster (Zoot: fifty-nine "hits" on twelve of ours,
accumulating for two days). `checkAttackedByPlayer` records a grudge when health has gone
down since the last look and an attackable non-fleet-mate player is within reach — and the
fleet farms shoulder to shoulder, so every fungus-beast bite was written down as the
nearest fleet-mate's attack. Nothing fired for two days because nobody was red.

The fleet-mate test, `party.isFleetmate`, consults a runtime map and then a roster source.
The map is keyed by **agent id** (`party.report(this.s.name)` — `t3`, not `Statler`), so it
never matches a name off the wire. The roster source — the fix for the *first* time the
book named our own people, a minute after a broker restart — was installed by
`parties.setRosterSource(fleetCharacters)` **in the broker process only**. The keepers had
since moved to one process per character, and none of them had a source. Inside every
keeper, `isFleetmate` answered "stranger" for the entire fleet, and the comment in
`mayReturnFire` that "the flag test is what actually protects us" described exactly the
protection a manual accident removes.

What changed: `m59-keeper-process.mjs` installs `party.rosterFileSource(fleetPath)` at
startup — seeded from the roster it has already parsed, re-read on mtime, never downgraded
on a failed read; `isFleetmate` folds case and whitespace the way the grudge book folds its
keys; `node tools/m59-grudge.mjs --forgive-ours` removes every roster name from a fleet's
book and leaves the strangers; and `m59-party-test.mjs` reads the keeper process's source to
assert the line is still there. **A keeper picks the fix up only when its process is
restarted** — a broker restart adopts survivors.

Two things this did not fix. The 04:30 death was never logged as a `died` event (Statler
was mid-`travel_journey`; only `level_lost` was written and the keeper's `deaths` stayed at
0). And the rule for people: **do not turn a fleet character red by hand while the others
are near it** — death clears the flag, but at the cost of a level.

## The fight-back edict: "if dithering and being attacked for more than ten seconds, fight back if it is smaller than you"

An operator's standing order, 2026-08-27, given after watching six characters stand in one
corner of the Valley of Ileria being chewed on. Each keeper was inside a walk it could not
finish — an approach the fine grid refused, a pull, a wall it had just been told to leave —
and passFarm's "hitting back" branch, which is the right answer, was never reached because
the pass never ended. Lew: 482 pulse wedges in 460 passes, five kills in two and a half
hours, `landed_hits: 0`.

It is two halves on the two clocks this repository already keeps apart, and **it is off
unless asked for** — `fightBackAfterMs` unset means the behaviour that was already there:

- **`fightBackCheck`, on the watchdog (500ms), decides nothing.** It keeps an attack
  episode — health going down while something attackable is within reach; a ledge or a
  poison tick with nothing near starts nothing, and six quiet seconds end one — and once
  the episode is older than the edict it pulls the same handbrake the other two arms pull,
  once per pass, so the blind await ends and a pass can answer. Silent below the flee line,
  silent while already fighting, silent under an errand.
- **`passFightBack`, on the pass, answers.** It sits directly above `passFleeAndRest` and
  steps aside below the flee line, so fleeing still outranks it; what it outranks is every
  wall, pull and walk below. The target is the nearest thing in reach that
  `refuseEngagement` would let this character fight anyway. **"Smaller than you" is the
  engagement band, not the level** — a level-50 fungus beast is the safer fight for a
  level-45 character ([`m59-combat.md`](m59-combat.md)), and the band already encodes that
  with the operator's own ceiling. What the band refuses, the ladder still walks away from.
  A kill earned here is bookkept exactly as passFarm's, and the ledger carries a
  `fought_back` event with how long the beating had gone on.

Set it with `fight_back_after_s` — the `autopilot` tool, or `substrate/tuning.json`; zero
switches it off. `autopilot action=status` reports `watchdog.under_attack` (how long, how
many blows, how much lost) and `watchdog.fight_back_after_ms`, so whether the order is on
and whether it is about to fire are both readable before the post-mortem.
`node tools/m59-fightback-test.mjs` pins both halves.

**What it does not fix.** A character that fights back with a weapon it has no proficiency
for still lands nothing — Lew was swinging a conjured scimitar with short-sword and mace
skills, and the edict makes that visible (`fought back without landing a hit`) rather than
better. That is a `weapon_priority` problem.

## Nobody begs in public: the plea for help is opt-in

`askForHelp` used to broadcast — *"If anyone can spare a flask or cast a heal on me I would
be in your debt"*, or after a death *"I was killed and lost everything… if anyone can spare
a blade or a few shillings"* — once per five minutes per character, whenever one was badly
hurt with no shelter or came back from the dead unarmed. Twenty-one characters entitled to
that on a shared server is a fleet begging in public, and on 2026-08-27 the operator saw it
from the other side and ordered it stopped.

Since then the plea is gated on `askForHelp: true` (`ask_for_help` on the `autopilot` tool,
in `substrate/tuning.json`, and in a loadout's `policy` block — the one that survives a
broker restart), default **off** and declared in the policy defaults so `status` shows it.
Everything the function does *before* the plea — re-equip from the pack, conjure a blade —
still runs on the same five-minute cadence, because those fix the post-death case by
themselves and cost nobody anything. **The cadence is the point, not a leftover:** being
hurt with no flask lasts many passes, and an inventory round-trip plus a 15-mana Create
Weapon on every one of them is the recovery mechanics running once a second for as long as
the character is hurt, which is what throttling only the speech (PR #33) would have bought.
The journal records `not asking for help — broadcasts are off` once per cadence rather than
nothing, so "why did nobody ask" has an answer, and the silent pass is still `noProgress`,
so a character that cannot rearm does not look busy. The plea itself is plain hyphens: the
wire is Latin-1 and an em-dash in it went out as byte 0x14. `m59-safespot-test.mjs` pins the
default, the opt-in, the cadence, the stall accounting and the wire; `m59-loadout-test.mjs`
pins the loadout key.

## A keeper's HTTP API had two `/action` handlers, and the second one had never run

`m59-keeper-process.mjs` is one `createServer` callback with a long chain of
`if (req.method === … && path === …)` blocks, and **two of them tested `path === '/action'`**.
The first answered every name it knew and closed with

```js
default:
  json({ error: `unknown action "${name}"` }, 400);
  return;
```

so control never reached the second one. Everything only that second switch answered was
dead: **`shop`, `buyitem`, `use`, `equip`, `cast`, `look`, `go`, `attack`, `rawmove` and
`movetest`** — on the architecture production runs, which is every broker now. `shop` and
`buyitem` are how a character supplies itself and `equip` is how it arms itself.

It is the failure this repository keeps writing down — code that looks written and does
nothing — moved up a level, from a method to the ROUTING, where none of the existing guards
look. A stubbed method at least appears in a grep for its own name; a shadowed route does
not appear anywhere at all, and the 400 it produces reads exactly like a verb nobody
implemented.

The fix is deliberately not a merge of the two switches: the first one is the newer and
better half (its `rest` forwards to `session.rest`, the second's answers
`{note: 'use goap instead'}`), and rewriting the half that works to rescue the half that
never ran is the wrong risk. Instead the first switch's `default` hands the name down:

```js
default:
  actionFallthrough = { name, args };
  break;
```

and the second block's guard became `if (actionFallthrough)`. A name neither switch knows
still ends as `unknown action`, so nothing that was answered before is answered differently.

**The body has to travel with it.** The request stream is consumed by the first handler, so
the second one re-reading it would get `''`, parse to `{}`, and turn every delegated call
into `unknown action: undefined` — the same bug wearing the fix's clothes. It reads
`actionFallthrough` instead.

`node tools/m59-supply-test.mjs` pins that there is only one `/action` guard left, that the
first no longer refuses a name the second knows, and that the parsed body is what crosses.

## A broker that lost a keeper port GUESSES one, and then commands whoever is there

`KEEPER_PORT_BASE` is a hardcoded `8911` with no override, so every broker on a machine
allocates keeper ports from the same number, and `keeperPort()` falls back to
`KEEPER_PORT_BASE + index` whenever this broker has no record of its own keeper on that
slot. Two brokers survive that, because the second one's collision check finds the first.
**Three do not**, and this is what the third one does.

Measured 2026-08-26 with `prod`, `shadow` and a six-slot `arena` fleet up at once. Arena's
keepers were displaced from their ports by a shadow broker restart, and arena then:

- **polled** its guessed ports, correctly saw a stranger, and logged *"dropping that
  allocation so the next spawn re-picks"* — for ever, at poll rate. There is no next spawn:
  the polling path calls `keeperPort()`, never `allocateKeeperPort()`. The fleet sat at
  "6 registered" with every row null and **reported itself UP the whole time**;
- **wrote** to them. Its 45s rejoin sweep posted `/rejoin` to a shadow fleet's keepers, and
  the server logged `ACCOUNT 64 (shadow05) in use; new connection overrides old one` every
  90 seconds for that broker's entire life, destroying a set of timed tours belonging to
  nobody involved.

**Be exact about the second one, because the alarming reading is the wrong one.** The
keeper's `/rejoin` handler IGNORES the posted body — `join()` takes no arguments and uses
that process's own account and password. No credential crosses and nobody is logged in as
somebody else's character. What happens is a forced logout and re-login of a stranger's
character, on repeat. That is bad enough and it is what those log lines are; it is not a
hijack, and reporting it as one would send the next reader hunting for a credential leak
that is not there.

### The asymmetry: the read path checked identity and the write paths did not

`keeperState()` has always read `j.agent` off the reply, refused a port answering for
somebody else, and dropped the allocation. Nothing else did. `keeperAction` — which now
carries `hold`, `release`, `room_contents` and `trade` — posted to whatever was listening,
as did the rejoin sweep, `/room-view`, `/path3d` and everything through `keeperGet`.

The check belongs on the RECEIVING end, because a caller that has guessed a port has by
definition already lost track of who is on it. So every request is stamped with the agent it
is addressed to (`keeperEnvelope`, or `?agent=` on a GET) and the keeper answers **409**
naming itself when that is not who it is. The broker turns a 409 into "drop the allocation
and respawn" rather than retrying into the same stranger.

Three rules in that, each of which had to be argued:

- **It fails open on an unaddressed request.** An older broker sends no `agent` field, and
  refusing those would strand every character the moment the two halves disagreed about
  versions. Naming the wrong agent is a mistake; naming nobody is merely old.
- **`/health` and `/state` stay answerable by anyone.** They name their own agent in the
  reply, and they are how a caller discovers whose port this is. Refusing them would remove
  the one tool that resolves the confusion.
- **`waitForKeeper` had to stop adopting strangers**, and this is the root of the whole
  family. It accepted any healthy reply as the keeper it had just spawned and recorded that
  port — and `keeperPort()` prefers a recorded port over everything, so a lost bind race
  became total confidence. `stopKeeper` posts `/stop` to that recorded port without further
  question, which makes a mis-recorded port a licence to kill another fleet's keeper.

`node tools/m59-supply-test.mjs` pins all of it. **The underlying limit is not fixed**: a
displaced fleet still spins rather than re-allocating, and it still reports itself UP. What
is fixed is that it no longer drives somebody else while it does.

## A stall names its own cause

blakserv logs a session out after 30 seconds of silence (`INACTIVE_GAME`), and on
2026-09-01 the shadow fleet lost about five keepers a tour that way while their own logs said
nothing: the broker's `/live` probe went unanswered, then "joined as" twice. A keeper whose
event loop is blocked cannot report it while it is blocked, so two things were added to
`m59-keeper-process.mjs`:

- **The stall monitor.** A 500 ms timer measures how late it fired; anything over
  `M59_LOOP_STALL_MS` (1500) is written to the keeper log WITH A CLOCK (`[loop] … blocked
  ~Nms, resumed <ISO>`) and to the tactics ledger as a `loop_stall` row.
- **The self-profiler.** V8's sampling profiler runs on its own thread and keeps sampling
  while the loop is blocked, and `node:inspector` lets the process drive it on itself with
  no flags and no port (an outside attach failed here because the strategy-game server holds
  9229). It runs continuously at 5 ms, restarts every two minutes to bound memory, and when
  the monitor fires the row carries the hottest self frames of the blocked window (`hot:`)
  and the hottest inclusive frames from our own files (`callers:`). `M59_KEEPER_PROFILE=0`
  switches it off.

What it found on 2026-09-02, in one tour of the shadow fleet: 313 stalls, the worst 158 s,
concentrated in the Sewers of Barloque and North Barloque, and every one of them was the
fine-move tracer (`_blockingWall`, `intersectNode` under `_resolveClientMicrostep`) called
from `step -> threadInto -> _legIsLegal -> bodyWalkArrives`: the needle, the solver that runs
whenever the next square holds a body, with an unbounded direct phase (see
[`docs/m59-routing.md`](m59-routing.md#the-needle-has-a-clock)). Every offline reproduction
of the earlier suspects — route planning, the exits flood, step masks, wall reservations —
had come back in milliseconds; the profiler took one tour. **Read the `callers:` half**: the
self frames say "the tracer" for every stall, and that is not a cause.

The cross-epoch measure of liveness is the server's own log: `grep "hasn't been heard from"`
on `log-<date>.txt`, counted per tour hour. The tactics ledger prunes rows from superseded
movement epochs, so a comparison across a code change cannot be made from it.

### The clock was not enough: a refused step must yield

With the needle clocked at 400 ms, tour 11 still had one 45 s stall, and the `callers:` half
said why: `walkPivots -> step -> threadInto`, a hundred times over. No single needle ran long;
they ran back to back, because a step refused locally without a packet returns through an
already-settled `await`, which is a MICROTASK and not a turn of the event loop. A loop of them
starves the keepalive timer, the HTTP server and the stall monitor for as long as it runs.
`walkTo` had a spin guard that yielded every twenty-fifth packetless iteration, tuned for
refusals of a tenth of a millisecond; with a clocked needle inside each one, twenty-five is ten
seconds. `Session._yieldIfPacketless` is one 25 ms macrotask yield per step result that moved
nothing and sent nothing, called after every step loop, and `walkTo` calls it on every
iteration. Two memos landed with it — `World.approachSquare` for 750 ms from the square we
stand in, `provedSquares` for two seconds per geometry — because both were being recomputed on
every walker iteration and had become the whole of the 2–5 s stalls that remained. Tour 12:
two stalls in twenty minutes, both in the loop the last yield now covers; prod: 9 stalls in a
quarter hour with the worst 3.3 s, against 313 and 158 s in the tour that found them.

## A rung that decided to move, said so, and reported progress for it

`retreatToSafety` is the ladder's answer to "get out of here". It refuses outright while
`retreat_to_inn` is off — the operator's call, 2026-08-27, on the grounds that walking to an
inn means crossing more of the road that is already killing us — and returns
`{ arrived: false, refused: 'retreat_to_inn is off' }` having moved nothing.

Every caller ignored that. The post-mortems read:

```
what:  "hurt in the open — running for a town rather than playing dead"
what:  "no wall and no town — withdrawing rather than freezing"
what:  "not waiting this out — moving to somewhere I can heal"
what:  "not changing objective for an inn"          <- the refusal
progress: "moved toward somewhere I can heal"       <- the lie
```

JohnsSlave, four deaths in two days (2026-09-03 ×2, 2026-09-04, 2026-09-05), every one of them
`in_safe_spot: false`, `at_a_safe_wall: null`, and the last one **0.0 squares per second across
the whole 31-second window** with seven creatures adjacent at 2 of 21 health. The keeper
understood the situation correctly on every single pass. Reported externally as issue #51.

**Two separate faults, and only the second one is about survival.**

The first is that the refusal did nothing at all while the comment above it declared what the
replacement was: "the replacement is not nothing — it is the route-adjacent safe spot." A
sentence in a comment is not a behaviour. The refusal now takes a wall when there is one to
take, and returns `{ arrived: true, took_spot: true }` when it does. It shares `wallTriedAt`
with the ladder's own wall rung, so a room with no reachable wall is searched once per pass
rather than once per rung that wants one, and it obeys `use_safe_spots` — the operator
switching spots off is an instruction, not a preference this branch gets to override because
somebody is dying.

The second is the one that killed. The rung that calls it —

```js
if (hurt && combatZone && !sheltered && !testing && !this.hold && vigor > restCeiling)
```

— called `progress()` and `return HANDLED` **whatever came back**. `HANDLED` ends the pass, so
the rung immediately below it never ran, and that rung is the escape: `leaveViaAny` over every
exit in the room, a `breakOut()` reconnect to shed the crowd when the walk is refused, and
another try. A refusal now falls THROUGH to it, and only a retreat that actually happened may
claim the pass or the progress.

**The class, not the site.** Five call sites had this bug in the same shape — the ladder rung,
the out-of-band retaliation refusal, both disengage branches, and the playbook's `retreat` and
`leave_room` verbs — and it survived because each one reads perfectly well on its own. A
`progress()` for something that did not happen is worse than a missing one: it is what keeps
the stall detector quiet, so the character is invisible to `m59-status.mjs`, to the supervisor,
and to the pulse, for exactly as long as it takes to die. `m59-retreat-refusal-test.mjs` (32)
checks the rule over the whole file rather than per site, and checks that the two behaviour
trees agree — in a selector, `SUCCESS` is the tree's version of `HANDLED`.

## The detector saw it for 27 minutes and had nothing to pull

`noProgress(why)` increments a counter, sets `stalledSince` at five passes, and has exactly
one keeper-side lever: `wantsBlink`, armed when the reason matches `STUCK_IN_PLACE` — a regex
over the English sentence. Everything else got **no lever at all**, and nothing said so.

That is the shape of the 27-minute wedge in issue #50: `stuck.since` advancing, `idle_passes`
climbing past 900, `why: "a pull attempt failed transiently; retrying from the same wall"`
recited every 1.5 seconds, in the character's own assigned farm room, with zero kills. The
detector was working perfectly. It had nothing to pull.

**There is a second lever and it is not in this file.** `m59-supervise.mjs` restarts a keeper
stalled for eight passes, and that is a genuine lever for a *stateful* stall — one where the
obstruction is keeper-local: `noWallRooms`, `unreachable`, `cappedRooms`, `pullFailures`, a
stale hold. A fresh process throws all of it away and the character gets another go.

It is not a lever for a **deterministic** stall, and telling them apart is the whole problem.
A fresh keeper walks into the same room with the same orders and the same geometry and
re-enters the loop within seconds — once every ninety seconds, for ever, each round printing
`restarted <character>` as though something had been achieved. `m59-supervise.mjs` already
refuses that trap twice by name (`NO_SAFE_WALL`, and a character sitting for `create weapon`
mana), and both were found the same way: somebody noticed the log looked like work.

### What changed

**The lever is data.** `stallLever(why)` is the whole map from a reason to the thing that can
act on it — today `{ blink: STUCK_IN_PLACE }` — and `null` is a legitimate, reportable
answer. The classification of blink reasons is unchanged; what changed is that it can be
enumerated, tested, and *reported* rather than being an implicit fall-through. An unrecognised
reason is reported and never dropped, which is the same rule this repository applies to policy
keys, and for the same reason: a setting that silently does nothing is how `purpose` stayed
out of a schema for a year.

**A repeat run is counted separately from idle passes.** The same sentence twice is a
different fact from two ways of failing. A character finding a new obstacle every pass is
working; one reciting the same sentence is in a loop its own inputs cannot leave. Only the
second is worth declaring.

**A leverless run is declared, not endured.** Past twenty repeats with no lever, the keeper
raises `STALL_NO_LEVER` on `status.refusals` — the channel the supervisor and the fleet board
already read as data — carrying the repeating sentence, the count and the room, said once,
with `since` surviving, and cleared by `progress()`. `lever` and `repeats` also ride along on
`stalled`, on `stuck`, and on the keeper process's own `/state`.

**And the restart is bounded against that declaration.** `stallRestartDecision` allows two —
the first is a real experiment, the second covers one that raced something — and then stops
and says why, leaving the refusal standing.

### What this is not

It is not a cure. There is no verb in this file that fixes an unknown loop, and inventing one
is how a fleet gets 107 room-flees and 0 kills: every one of those was a character below the
vigor floor that fled a room it could have fought in, and the escape working better only
converted "die where you stand" into "run for ever". Guessing at a lever for a stall nobody
has classified would be the same mistake with a longer stride.

What it fixes is that the state was **invisible**. "Stalled for 27 minutes" and "stalled for
27 minutes with nothing that can act on it" are different facts, and only the second is an
emergency. A character nobody can help and a character nobody can *see* look identical from
outside, and only one of them is fixable by whoever is on shift.
