# Cave and Ko'catan travel

`island-walk` follows the mainland cave (27), Ugol's Warren Entrance (2500),
2501, the Archaic Hollows (2502), 2503, 2504, Konima's Ascension (2505), and
Ko'catan (2000). The return uses those maps in reverse order, with different
paths inside them. The Hollows' northern east exit is reached through the
small western cavern and its climb. The return takes the lower east exit;
it does not attempt to reverse the outward fall.

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
where no chain exists; enabling it is not a claim that every crossing is safe.
Pending shopping trips are cleared before departure. A keeper shelter move
and recovery of this script's suspended journey are allowed to finish before
the hop resumes. On the observed recovery wall, the traveler rests and eats
carried food using fresh inventory handles. Rest alone caps vigor at 80; bring
food for both directions. The shadow convoy's provision trial purchased and
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
larger per-hop budget for a convoy (`budgetMs=500000` in the shadow experiment).
The expedition excludes the Underground Lake and the mainland south exit
from each hop, and suppresses shopping errands. Its first westward approach
uses the complete Dispel state observed by the character before applying
the matching baked mask.

The outward Hollows crossing is declared from the operator's successful native
client recording: r41c34 to r44c27, with the recorded fine takeoff and landing.
It requires running vigor. Followers serialize that crossing and clear its
landing. The western climb uses body-seeded 128-client-unit rails, with both
lattice bridges and wire-rounded command chords checked against ordinary
collision tracing. Fine movement prefers a safe-wall stop on its checked
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
keeper read, rather than the square summary in `look`. A waiting follower
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

Offline checks: `node tools/m59-island-test.mjs` and `npm run test:movement`.
