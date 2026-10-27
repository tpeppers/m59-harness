# Cave and Ko'catan travel

An independent native lab can retain artificial Dispel with an explicit named
roster and `retainShadowIslandDispel({fleet,stateFile,gamePort,adminPort})`.
Nondefault ports require the exact roster identity, a matching loopback game
endpoint in broker health, and matching configured game/maintenance ports.
Production fleets and the default production game port are refused. This lets
two local test worlds stay separate without weakening ordinary travel checks.

Konima's normal outbound crossings are r27c60 to r27c65 and r46c80 to r46c84.
The preferred return walks one square west on the right-hand shelf, then drops
from r27c64 directly onto the r23c60 refuge. Independent native fine reads
confirmed that landing, and its westbound rail bypasses r25c60–64. The older
observed r27c65-to-r29c63 drop remains an alternate into the lower gutter.
A missed first outbound
crossing also uses that lower floor: go south through r31c64 and r33c64,
then west to the refuge at r33c59. The northern lower-floor approach is about
12 walking squares from that refuge; the southern approach is about nine.
Never retry the outward jump while below its takeoff shelf.
The same handoff applies when a keeper recovery move reaches the lower floor
during the approach. Each confirmed position is checked; that approach ends
before it can spend its remaining budget aiming for the higher takeoff. The
crossing controller then reads the body again and walks the declared gutter.
Cancellation remains a cancellation and cannot start an escape walk.
The staging walk carries the same fence. It can begin below the shelf and
climb normally; only near the takeoff shelf does a later lower
pose trigger the escape. This prevents an interrupted staging walk from
spending its full budget aiming back up at an inaccessible ledge.
Equal height in a distant corridor does not arm that fence. Once armed, the
minimum floor constrains the rail and body-detour planner before movement.
The short takeoff approach requires that constraint from its first point.

The declarations live in `m59-falljumps.json` and `m59-gutters.json`, so the
shared router can use them. `node tools/m59-fine-guidebake.mjs` generates the
directional fine guides and separate r72c1-to-r5c57 and reverse traversal
chains. The shared fine rail worker uses these guides only after checking
the current geometry, avoidance, boarding chord and exact endpoint; movement
still checks live bodies. An open-door guide cannot open a closed door.
The shared guide lookup can also use a forward segment ending at an interior
staging point. The return clears the animated door at x4456/y416 on its
authored corridor before following that guide.
`operate_door` uses the shared trigger, ordinary GO and observed animation
wait. The crossing helper serializes approach through landing clearance,
confirms the actual fine floor, and sends lower landings through their gutter.

Component checks on October 14 (local time) used stock local monsters, initial 20 HP,
200 vigor, no skills or spells, and no measured administrator mutations.
Each crossing and the gutter reached its expected server-confirmed landing
without a death. These are component observations, not a fleet survival rate.
The earlier completed 20-courier build `48f8973a` reached the inn with 15/20
and completed the round trip with 4/20; 13 deaths lost 520,000 synthetic
shillings, and three living route failures retained their purses. All deaths
were in Konima: nine around r25c60–64, two around r21c61–62, one at r23c61
and one at r31c64. The later return scenes had more creatures, while each
death scene had zero or one other courier nearby. This does not establish a
twenty-character player pileup. The new route requires its own populated trial.
An interrupted trial of private planner copies retained all twenty travelers
and all 800,000 shillings. It exposed a floor-door cache keyed only by room:
later copies could report the open Dispel state without receiving its mask.
Door application is now tracked per geometry and mask, with separate typed
floor and ceiling events; the two-copy regression is covered offline. That
interrupted attempt is not a completed survival sample.

The completed populated cohort on `ebc7154b` (source hash
`d61ca3a36b9796febb803a8f28a5255524f32d7bd3820b627e22d0ffe50b3f6b`)
reached the inn with 11/20 and completed 10/20 roundtrips. Eighteen survived;
there were no return-leg deaths and no Konima deaths. The two outward deaths
were a shadow beast at Merb r46c52 and an orc wizard at Obfal r32c23. Both
recorded body-detour search exhaustion during recovery, with no other courier
within six squares in the death scenes. Native wallet audits found 400,000
shillings home, 320,000 retained by eight living stopped couriers, and 80,000
lost by the two deaths. All twenty retained the pinned source and zero known
skills/spells. The initial profile was 20 HP, 200 vigor, 40,000 shillings,
plate armor, helm and eight cheese wheels, with no healing flasks; monsters
remained enabled and measured administrator actions were Dispel only.
Seven outward living failures and one return living failure keep this cohort
below courier acceptance despite the improved survival. The pending candidate
addresses refuge-search latency, interrupted staging/approach gutter handoff,
Hollows queue staging, and completed recovery-label lag. It needs its own
native components and populated cohort before enabling the private recipe.

A later two-courier Hollows component on `016659f6` (source hash
`9665bb1fbb87c13c763789f70da14f4801f2f87cf7f932f0bd7c228aa2fc643a`)
completed both crossings to Merb with no deaths and both 40,000-shilling
purses intact. They began at the map's normal login point after a broker
restart, at 20 HP and 184/182 vigor; there were no administrator mutations
during this component. Minimum HP was 4 and 14, and final HP was 20 for both.
This checks the live staging and western-cavern climb, not full-trip safety.
The previous staging-cell centre was physically unreachable. The shared
refuge-footing resolver now supplies a proved enterable, reversible fine point;
generated Hollows guides cover both the map entrance and native login point.
That staging candidate subsequently passed all 69 movement suites with zero new
regressions and the existing baseline failures unchanged.

The next completed populated cohort on `4652abce` (source hash
`8ba2342a1c02ca297e891b0c61bffa1e840887f13a89d220afaaebb1cfc1b67b`)
had zero deaths but completed only 1/20 round trips. All twenty native
wallets retained 40,000 shillings: 40,000 home and 760,000 held by nineteen
living stopped travelers. Eighteen stopped in the Hollows and one in the
Chamber; the successful courier completed both Konima directions. All twenty
keepers retained the pinned source and zero known skills/spells, and no new
postmortems appeared. The run continued every traveler after failures and
finished its final native audit before further setup. Minimum observed HP
was 4. This is 100% survival and 5% completion, not an accepted courier result.
The follow-up candidate addresses interrupted refined crossings and traffic
detours into irreversible lower refuges. It needs its own native validation.
The later candidate source
`c87a0fe8ecdacbb2cf1a2f674e499a8e62f4f49d4b550780e6c71d6fcefb7a14`
completed a two-courier native Hollows retry from the recorded upper stopped
positions. All twenty initial poses were reconstructed before measurement;
current HP, vigor, purses and monsters were retained. The two departures had
20 HP and 172/194 vigor, and measured administrator mutations were zero.
Both reached Merb alive with their original 40,000 shillings and no known
skills/spells. Minimum HP was 17 and 14. This validates the direct takeoff
and recovery revision as a component, not the next full-cohort success rate.
The same movement candidate then passed all 69 offline movement suites with
zero new regressions and the existing baseline failures unchanged.

`island-walk` follows the mainland cave (27), Ugol's Warren Entrance (2500),
2501, the Archaic Hollows (2502), 2503, 2504, Konima's Ascension (2505), and
Ko'catan (2000). The return uses those maps in reverse order, with different
paths inside them. The Hollows' northern east exit is reached through the
small western cavern and its climb. The return takes the lower east exit;
it does not attempt to reverse the outward fall.
Takeoff refinement and recovery now use the shared declared-crossing controller.
A live-body refusal waits at a nearby unoccupied reversible refuge, and an
owned keeper interruption can resume from its observed healthy body. Traffic
side refuges must lead back to the proved rail. An ordinary walking escape
from the lower pocket beneath this takeoff has not been proved; it is not
Konima's gutter, and the controller refuses there instead of aiming uphill.
The normal route must prevent that unplanned descent.

Run from a checkout with the intended roster and keeper band, and verify the
broker before selecting characters. For the isolated shadow broker:

```powershell
$env:M59_FLEET = 'shadow'
$env:M59_CONTROL_URL = 'http://127.0.0.1:8971/'
node tools/m59-which.mjs --fleet shadow --port 8971
node tools/m59-fleet-repl.mjs --fleet shadow
```

Then use the REPL, with actual agent IDs:

```text
island-walk agents=shadow01 direction=out
island-walk agents=shadow01 direction=back
island-walk agents=shadow01 roundtrip=true
island-chalice agents=shadow01
island-home agents=shadow01
island-trip agents=shadow01 outbound=chalice task=island-bows taskParams={"bows":1,"arrows":200}
```

The walking recipe requires the correct starting endpoint, readable health,
full health at departure by default, at least 20 maximum HP, and at least
120 vigor at departure by default (`minVigor`). It refuses an unfed
departure from the mainland cave. On Ko'catan it first rests and eats carried
food if health or vigor needs recovery for the return. It holds
movement ownership, records each one-room hop and HP samples, and cancels
unfinished movement on failure. It temporarily adds the cave maps to the
existing safe-leg policy, then restores that policy unless the operator has
changed it during the trip. Safe-leg planning can fall back to direct travel
where no chain exists in an advisory geometry experiment. `island-trip` and
`island-home` require a complete refuge chain and refuse that fallback.
Pending shopping trips are cleared before departure. A keeper shelter move
and recovery of this script's suspended journey are allowed to finish before
the hop resumes. On the observed recovery wall, the traveler rests and eats
carried food using fresh inventory handles. Rest alone caps vigor at 80; bring
food for both directions. A fully healed, rested body can resume when the
completed `recovering` label is waiting for the keeper's next decision pulse;
that label cannot consume repeated recovery attempts. Injured or exhausted
bodies and active approaches keep the ordinary recovery gate.
The shadow convoy's provision trial purchased and
traded food to carry 90–180 nutrition each, according to starting vigor,
through ordinary tools,
including redistribution of existing surplus. Departure meals use ordinary
food actions in the inn when vigor is below the requested threshold.
This quantity is an experiment's starting load, not a survival guarantee.
For several travelers, a roundtrip waits for every outward attempt to finish
before anyone starts back. This avoids opposing traffic on Konima's narrow
climb. Failed participants report through cleanup so successful arrivals can
return, with departures spaced by `departSpacingMs`. Waiting travelers
continue health and cancellation checks. Allow a
larger per-hop budget for a convoy (`budgetMs=800000` and
`departSpacingMs=60000` are the current `island-trip` defaults).
The expedition excludes the Underground Lake and the mainland south exit
from each hop, and suppresses shopping errands. Its first westward approach
uses the complete Dispel state observed by the character before applying
the matching baked mask.

The outward Hollows crossing is declared from the operator's successful native
client recording. The approach near r41c34 leads to a physics-checked fine
takeoff at r40c33 and landing at r44c27; the ordinary jump uses stock gravity.
It requires running vigor. Followers serialize that crossing and clear its
landing. The western climb uses body-seeded 128-client-unit rails, with both
lattice bridges and wire-rounded command chords checked against ordinary
collision tracing. The shared fine cutter can scope observed blocking bodies
to the current prefix. Island walking uses that scope and re-cuts before an
upcoming command can leave it; distant bodies still affect threat pricing.
Temporary body refusals receive bounded fresh observations and replanning.
If bodies temporarily disconnect the full destination, an explicitly partial
plan may advance to a reachable refuge beside the geometry route. Every edge
to that refuge retains body collision checks; the prefix cannot certify final
arrival. The controller refreshes live bodies before choosing each chord and
does not return to previously used partial refuges during the same approach.
The sender repeats collision checks against the current
room contents. Fine movement prefers a safe-wall stop on its checked
rail when one is available. The mover's shelf guard rejects a collision slide
onto an unintended lower ledge while allowing a planned descent onto the
command's destination floor. A position that cannot bridge back to a valid
rail is a stopped trial, with its floor and seed recorded for diagnosis.
When the closest rounded seed is across collision, up to eight nearby seeds
are tried with fully checked body-to-seed bridges. Shelf refusals reduce the
stride from 48 to 16 and then 8 protocol units for narrow turns; the collision
and shelf guards remain active.
Observed body refusals remain traffic waits even when the shelf guard's reply
also says its step budget ended. A predicted arrival that disagrees with the
fresh body gets bounded rereads and retries; prediction alone never completes
a waypoint.
The shelf guard preserves a blocked-body reason even when it refuses before
sending a step. Exact small strides halve after a refusal instead of being
raised to the ordinary 24-unit minimum.
Positions come from the selected fleet's fresh
keeper read, rather than the square summary in `look`. The outward Hollows
queue stages at the r42c36 wall, behind the active takeoff corridor; takeoff
refinement checks observed bodies as well as the static geometry. Staging
uses fine footing proved enterable and returnable from the approach. The cell's
centre is unreachable; the shared staging planner resolves its valid edge
footing, and generated guides cover both the cave entrance and authored login
point. A waiting follower
continues health and cancellation checks, and the crossing queue shares the
Hollows leg's time budget. Konima's final door is opened by the ordinary
`go` action from inside the actual trigger; no door or room geometry is edited.

Dispel Illusions must keep map 27 open during departure and the return.
The lab wrapper uses the permitted artificial Dispel and serializes recasts
through the local server's authenticated administrator console. It verifies
deletion of every pending Dispel reset timer for that room before recasting;
the maintenance socket does not permit timer deletion. A shared recast loop
keeps the cave open until the last traveler finishes, and current closed
sector observations stop the fine approach. Local administrator credentials
stay in the gitignored `substrate/island-admin/` directory.
Its five simultaneous floor changes are baked together, including the floors
that the legacy absolute-height gate detector misses. To regenerate only
that room from the game source:

```text
node tools/m59-varsectors.mjs --room 27 --write
node tools/m59-doorbake.mjs --room 27 --risk --write
```

`island-walk-shadow` checks for the shadow fleet on loopback:15959. It can
stage and heal disposable copies before an experiment (including setting
initial vigor to 200), keeps Dispel active,
and parks them in town during cleanup. `quiet=true` explicitly suppresses
monster generation and removes aggressive monsters for a geometry trial;
generation settings are restored afterwards. `roundtrip=true` turns around
from the real arrival without an admin heal or relocation between trips.
Do not run independent quiet wrappers concurrently: their shared scene
ownership belongs to one FleetScript process. Quiet results establish
geometry and traffic behavior, not survival against production monsters.

The Hollows takeoff and landing are exposed to shadow beasts. Serializing the
fall prevents followers occupying the landing; it does not protect the queue
from monsters. A successful quiet convoy must be followed by a populated-cave
trial and a tested escort or control strategy before sending fragile characters.
Light does not repel shadow beasts. Their presence and the keeper's recovery
behavior must be measured rather than inferred from an empty geometry trial.
An arrival can precede cleanup of the previous travel job. The next hop waits
and retries a bounded number of times when that busy job has the same order
owner; an unrelated busy order does not qualify.

The chalice recipe requires exactly one Chalice of the Rain whose current
description says it is filled to the brim. From map 27 it first enters the
orc caves. Before the first sip it requires full departure health and moves
to a nearby non-rim safe wall with zero geometric attackers, confirming the
actual arrival. Rescue needs the traveler to stay still: an emergency keeper
logout can interrupt its preparation. It observes the first Rescue landing at the Pool of Vigor (2510)
before taking the second sip, and observes that landing at the Aerie Guest
House (2001). Jungle refill is a mandatory continuation of the ride.

Refill goes through Ko'catan's East Guard Tower (2013), stashes restricted
cargo, walks outside (2115), drops and picks up the same chalice, confirms
that it is full, returns, retrieves and re-equips the stashed items, and
finishes in Ko'catan. The town guard's source permits two ordinary weapons
and one each of armor, helmet, gauntlets and shield; it forbids alcohol and
raw nerudite. Black daggers, robes/light robes, circlets/ivy circlets, and
torches have the same exceptions as the guard. Unknown item classes are
stashed conservatively, and equipped protection is retained ahead of spares.

Cargo receipts and a process-identity-checked exclusive refill lock prevent
travelers mixing identical stashes. Fresh item handles and the recorded
equivalent-item group handle server save renumbering. A retry resumes an
observed teleport or an unfinished refill; an unobserved sip outcome is
refused rather than consuming more water. Abandoned cargo keeps its lock
until its owner recovers it. Keep the receipt directory when retrying.
An attempt that failed before any sip or stash can restart after the full-cup
check; its earlier receipt is archived.
`keepItems=false` intentionally leaves the stash behind after refilling.

Receipts are gitignored under `substrate/island-trials/` and
`substrate/island-chalice/`. Inspect individual agent results: FleetScript's
top-level `ok` means at least one agent completed, not the entire roster.

An owned journey can wait through several bounded rest polls at one confirmed
wall, including while poison wears off. Its retry allowance counts actual
travel resumptions rather than those polls; the overall leg deadline,
cancellation and observed health checks still apply.

Ordinary cave hops remember their actual entry. A healthy courier still within
two squares of that confirmed arrival can retreat and retry when required
safe-leg travel ends there with a nearby blocking body. The border must be
explicitly reversible. The shared controller walks back, waits 30 seconds,
re-enters and retries, at most twice under the original hop deadline. It does
not relocate the character, fight the blocker or waive the required safe-leg
policy. A different destination owner, cancellation or unreadable/dead body
still ends the attempt.

Offline checks: `node tools/m59-island-test.mjs` and `npm run test:movement`.

## Shadow validation, 2026-10-10

Before the shared-admission change (main `c912e2c0`), the final quiet convoy
completed all 24 roundtrips: 336 observed one-room
hops, zero damage, zero deaths, and no maximum-health loss. Both 20 HP
travelers stayed at 20 HP through all 14 of their hops. This used the
shadow wrapper's initial health/vigor fixture and monster suppression;
there was no admin heal or relocation between the outward and return trips.
It establishes the asymmetric route and convoy traffic behavior.

A separate 20 HP chalice trial completed both observed Rescue landings,
the mandatory jungle refill, retrieval of duplicate weapons and raw ore,
and confirmation of its original equipment, with no damage. It finished in Ko'catan
with a full chalice and 20/20 HP. Monster generation was not suppressed
for that ride or refill. Cargo recovery was also exercised across a
server save that renumbered item handles.

An unarmored 20 HP populated walking trial used its original hammer,
matched karma, ordinary food to reach 140 vigor, and no health or vigor
boost for the trial. It crossed map 27 without damage, but did not finish
2500 to 2501. Several wall approaches failed as monster traffic grew;
the fallback route took 7 HP of damage, reaching 13/20 HP. The keeper
performed an emergency logout before a control call timed out. No death
or maximum-health loss was observed.

These results do not establish a safe populated-cave walking convoy.
Keep walking experimental until the monster exposure and any required
escort or control strategy have been tested with fragile travelers.

## Populated validation, 2026-10-15

The completed 20-courier cohort on main `39dd7955` started each traveler at
20/20 HP, 200 vigor, zero skills/spells and 40,000 synthetic shillings, with
plate, helm, ordinary food and no healing flasks. Native monster generation
remained enabled; only Dispel Illusion was artificial during measurement.
Sixteen reached the inn, five completed the roundtrip and nineteen survived.
One Konima return death near r24c62 lost 40,000. Five homeward purses retained
200,000, and fourteen living stopped couriers retained 560,000. Eight
returners stopped at Ugol's r1c27 arrival. This is 25% completion despite
95% survival, below the operator's accepted 90–95% roundtrip milestone.

Subsequent native components on `e9528015` completed the Hollows upper
approach and both travelers of an occupied Konima staging pair. Minimum
health was 19/20/20 and all three 40,000-shilling purses were retained.
The corrected Konima return completed separately at full health with its
purse intact. A blocked Ugol traveler also completed an ordinary retreat,
30-second wait, re-entry and onward crossing with minimum 20 HP and no cash
loss. These measured components used no health, vigor, cash or monster
resets; initial positions were reconstructed explicitly. They validate
components, not a replacement full cohort or shopping/cargo acceptance.

## Composition and shared movement guards

`island-trip` starts with a full cup in the cave region (or `outbound=walk`
from Tos, walking to map 27), performs the compulsory jungle refill after a ride, executes a
named Island FleetScript, walks the asymmetric return, and goes home to Tos
(52). `island-bows` buys practice bows from Kochtal ko'Tulca in 2014 and
arrows from Hanla zax'Ta in 2100 through ordinary verified shop steps, then
returns to Ko'catan town. `taskParams` is a JSON object; a task's
parameters compile before departure. The parent keeps its driver and health
floors, and a task that waives expedition guarantees is refused.

Refill leases can have many waiters in one FleetScript process. Its own start
time is now read from that process's stable identity without launching an OS
query. Previously every waiter synchronously started PowerShell on Windows;
enough waiters blocked the lease holder's network callbacks and caused a cascade
of position timeouts and abandoned cargo. Foreign process identities still use
the normal batched OS proof. The twenty-waiter regression exercises real stash
leases and asserts that self checks launch no process; cargo abandonment and
same-owner recovery retain their existing guards.
The refill lease now uses the caller's convoy queue budget (four hours by
default), rather than an unrelated fifteen-minute cap that can expire before
twenty serialized refills finish. The active travel and cargo operations keep
their own bounds; an explicitly shorter queue still expires without taking
someone else's lease.

An ordinary measured hop defaults to one crossing. Callers that explicitly
allow a town detour can provide `maxHops` (1–12) and `intermediateRooms`;
the same ownership, cancellation, health and deadline checks continue across
those rooms. An undeclared intermediate room still stops the hop. Chalice
refill permits the bounded Guest House–Barking Monster–settlement detour,
and a two-sip receipt stranded in the bar resumes refill without another sip.
Directional cave legs retain the one-crossing default.
The settlement detour budgets three minutes per declared hop, up to twelve
minutes total, rather than sharing a one-hop deadline across four crossings.
Tower and jungle hops retain the three-minute, one-crossing limit.

Rooms with locked internal doors also check sibling `go` portals against the
body's fine-geometry component. A complete bounded search can downgrade a
coarse-only portal so the ordinary exit executor tries a connected sibling
first. It does not remove declared portals, infer failure from a timed-out
search, or freeze operable door geometry. This repairs the bar's adjacent
exit-square mismatch without a room-specific route or relaxed collision checks.
When that proof reveals a partition mismatch, connected siblings use the
planned `approachFine` waypoints before a coarse approach or a rail to the old
anchor. The local steering fan alone cannot backtrack around this partition.
The same cancellation, actual-room and final-position checks still precede
`go`; a refused fine approach retains the coarse fallback.

Repeated ordinary travel failures whose exit approaches all refused on unsent
body collisions now retain their age across short driver-owned jobs. After ten
seconds, the same owner's next routing attempt may use the normal Blink escape
rung. Doors, combat, low health, insufficient mana, missing Blink and the
per-character opt-out still gate that cast. No admission waiter or active
external job is interrupted. The caster waits for the actual trance to finish
before judging its position and replanning; a cancel cannot start another walk.

`RID_TOS_FORGET` (room 59) is a historical name, not a mainland shortcut. Blink
in the Island Hall of Heroes enters that room, whose coded exits lead back to
the Island. Use the room graph rather than the numeric ID to locate a landing.

The named `icky-chalice` script supplies the committed acquisition recipe's
clear-orcs, hold-ten-spiders, dispel and grab stage. Use `home=0`, then
ordinary verified trade if the courier is different from the caster. A
full cup remains the entry requirement; acquisition does not imply that a
previously consumed cup is ready. Production requires normal Dispel casting.

`island-home` and `island-trip` default to `requireSafeLegs=true`. This uses a
general safe-leg policy key, `safe_legs.required`: when an enabled room lacks
geometry, a complete wall chain, or walkable legs, ordinary travel ends with
`safe_legs_required`. It does not continue onto a direct crossing. The normal
safe-leg default remains advisory; `island-walk` retains that default for
explicit geometry experiments. Requiring a chain prevents that fallback; it
does not guarantee an absence of attacks during an otherwise valid leg.

The nearest-seed repair now belongs to the shared `cutRail`, so every rail
consumer checks alternate body-to-lattice bridges. The Island wrapper no
longer implements its own cutter. The shared packet send boundary also
admits one keeper at a time to detected connected one-square passages,
including bends. Admission covers grid steps, fine steps and declared jumps,
uses the fleet/server atomic claim store, checks visible human occupants,
and applies in both directions. A predicted exit cannot release a claim:
the exit is read back first. An incumbent may leave, and cancellation does
not erase a claim while its body still occupies the passage. Keeper survival
remains active; a traffic refusal spends the walker's existing bounded body
waits rather than occupying a second walkway square or altering geometry.
Detection uses the current walkable grid and invalidates with its step mask;
isolated wall pockets and broad staging areas are not passage reservations.
Sub-square ledges still need checked fine rails and the existing body guard.

The private `island-courier` profile requires a safe-leg chain and composes
$40,000 funding, the full ride/refill, bow/arrow purchases and the return.
It currently refuses before funding because populated 20 HP roundtrip
survival has not passed. Its deployment note records the tests needed to
enable dispatch; the quiet convoy is not that evidence. No production
deployment or dispatch accompanies these changes.

Additional offline checks: `m59-passage-admission-test.mjs` exercises the
real send boundary, opposing traffic, confirmed exits, human occupancy and
a race between OS processes; `m59-island-composition-test.mjs` covers task
validation, retained ownership/health floors and required-route refusal.

The shared-admission working tree subsequently passed a simultaneous Konima
smoke test: both a 75 HP traveler and a 20 HP traveler entered Ko'catan,
with zero damage, in 205 and 339 seconds respectively. This used explicit
quiet geometry mode and initial health/vigor fixtures, with no healing or
relocation during either measured crossing. It checks the new shared walker;
it does not replace the missing populated full-roundtrip survival evidence.
The completed offline run reported 34 movement suites with zero new
regressions (existing baseline reds retained), 392 FleetScript checks with
zero failures, and passing shared-wall, rail, library, acquisition and epoch
checks.

## Rescue instead of a sip

Operator, 2026-10-27: *"anyone who knows rescue doesn't need to grab a chalice they can just go in the first lap and
bring 5 emeralds and cast rescue when the chalice would be drank during the trip"*. `rideIslandCup` (and the
`island-trip` / `island-chalice` scripts, `rideMode: auto | cup | rescue`) rides by casting when there is no cup.

- **It lands where the sip lands, because a sip IS a Rescue.** `chalice.kod` NewApplied casts `SID_RESCUE` at spell
  power 1, and `rescue.kod` DoRescue picks the destination for both: from the orc caves the Pool of Vigor (2510), from
  the pool Ko'catan Inn (2001), and a guild hall first if it is in the same region. A cast only differs in its delay,
  which is shorter at higher power.
- **What the cup skips, the cast pays:** 16 mana, one emerald, and karma of **+30** (`spell.kod` KarmaCheck; Shal'ille
  level 3). `rescueReady` requires the spell known, karma read and at least +30, and an emerald per leg (two).
  An unreadable spell list or karma is a no, never "does not know".
- **auto:** exactly one full cup rides the cup; no cup and rescue ready rides rescue; neither is refused as
  `requires_exactly_one_chalice_or_rescue`, naming why. Two cups are still refused.
- **A failed roll is retried** ("You were unsuccessful in casting rescue.": half the mana, no emerald), up to
  `rescueTries` (6), resting for mana when the cast tool says it is short. A karma refusal or a PvP lockout ("You've
  attacked a player too recently.") stops the ride at once. The pool of vigor is drunk between the casts as between the
  sips, and a rescuer skips the jungle refill: it has no cup. `m59-island-rescue-test.mjs` (14).

## Arriving to stay: vault, then farm carefully

Operator, 2026-10-27: *"People who arrive at the island should vault anything they can't bring into the jungle and
prepare to start carefully farming Avar warriors"*. `tools/fleetscripts/island-arrive.mjs`;
`m59-island-arrive-test.mjs` (15).

- **The vault is Ko'catan's**: Itzal cha'Nosak, The Hungry Vaults, room 2005 (`kcvaultm.kod`, `kocbank.kod`). The
  vault readers matched only Obert Cair'bre and would have answered "no vaultman in this room" there; both are now one
  table, `tools/m59-vaults.mjs`. Unproven on prod until the first arrival uses it.
- **`vaultForJungle`** walks to 2005, plans with the same `jungleStashPlan` the refill uses (worn protection first, the
  guard's per-category limits), takes worn spares off, deposits by name with a `keep` count for the copies that may go
  through, and reads the pack back: anything still refusable is an error. The refill's drop-and-retrieve is for a rider
  coming straight back; a rider who stays would leave it on a shared server's floor.
- **Then the farm**, if `strategy` is given: `mode: farm`, the strategy, `rest_below` 0.8, `flee_below` 0.45 (the
  moment to log off on a proven wall, not a withdrawal), `town_trips: false`. The thresholds are survival keys, so they
  belong to the assignment, never to a strategy file.
- **Postures can select by room** now (`who.rooms`, `who.room_range: [2000, 2699]`), for anything that should hold
  "everyone on the Island". An unknown room is not a match.
