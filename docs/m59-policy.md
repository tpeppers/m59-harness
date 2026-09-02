# Policy, profiles and tuning

Split out of [`CLAUDE.md`](../CLAUDE.md). Where this checkout's opinions live, and where the fleet is allowed to stand.

## A NUMBER THAT IS THIS CHECKOUT'S OPINION DOES NOT BELONG IN GIT

`fight_above_vigor: 180` was two different claims wearing one coat, and they have
opposite homes.

One is **mechanics**: resting stops awarding vigor at 80 of 200 (`RestTimer`, and
`REST_VIGOR_CAP` here), so everything above 80 has to be EATEN, and `create food` costs 2
elderberry **and** 2 herbs. That is not an opinion, it is what the game does, and it
belongs in the repository with its citation.

The other is a **bet**: that this fleet's apothecary run is working well enough to keep
twenty-one characters fed past the cap. That is true on a good afternoon and false on a
bad one — measured 2026-08-14, herbs were **zero on all 21 characters** with 10
elderberry between them, so not one of them could cast it — and it was never true for
anybody else's roster at all. Committed, it ships as advice to a stranger whose fleet it
will get killed, and the history fills with an argument about a number that was only ever
local.

So the bet moves out:

```bash
node tools/m59-localpolicy.mjs             # what this checkout overrides, and what it does not
node tools/m59-localpolicy.mjs --explain   # the overridable surface, and the mechanics behind each key
node tools/m59-localpolicy.mjs --example   # a starter file to copy
```

`substrate/policy.local.json` is gitignored and holds this machine's answer, per block —
`valley_orders` and `lowland_orders` are the two `m59-supervise.mjs` deploys with. The
committed defaults in that file are untouched and remain **exactly what a fresh clone
runs**. `meridian59-dum-bot` has the same split already and now uses it the same way: the
committed doctrine keeps 180 as its documented example, `doctrines/local/` carries what
prod actually runs, and `loadDoctrine`'s provenance names the local file so you can see
which one won.

Four properties, each of which is the cheap mistake:

- **Silence means the behaviour that was already there, never an empty policy.** An
  absent file, an empty one, a block this build has no name for — all three return the
  committed orders object unchanged. Returning `{}` would strip every flee threshold off
  a live fleet while looking like doing nothing, which is the same failure the loadout
  overlay is built to avoid.
- **A file that will not parse is not an empty file.** It keeps the committed defaults
  *and says so*, because the operator who just edited it is the last person who would
  suspect that their broken JSON silently reverted the fleet.
- **An unusable value keeps the committed one rather than unsetting it.** `flee_below: 35`
  is somebody typing a percentage; it must not become a threshold of 3500% and it must not
  quietly remove the floor. Falling back to the default is the safe direction.
- **An unrecognised key is reported, never applied and never dropped.** A setting that
  silently does nothing is how `purpose` stayed out of a schema for a year while every
  keeper in the fleet ran with an audit switched off that everyone believed was on.

And the **mechanics are not overridable**. `VIGOR_MAX`, `REST_VIGOR_CAP` and
`MIN_FIGHT_VIGOR` are exported for citation and a local file naming one is refused —
but a floor **above** the cap is *allowed* and **warned about**, naming the recipe,
because a fleet holding out for a vigor no amount of resting can deliver looks on the
board exactly like a fleet that is working. That warning is the whole reason the module
exists: it is the sentence that would have been printed on the round the fleet sat at
exactly 80 vigor with an empty larder, reading as twenty-one healthy characters.

`MIN_FIGHT_VIGOR` (100) sits **above** `REST_VIGOR_CAP` (80), so the two are not the ends
of a quiet middle band — there is no setting that clears both. Written as an either/or,
every value warned about something, which reads the same as nothing. They are independent
remarks and a value may collect both.

## A PROFILE IS THE OTHER HALF: NOT A NUMBER, BUT WHERE THE FLEET IS ALLOWED TO BE

The local policy above overrides *thresholds*, and its surface is deliberately small. What
it cannot say is the thing that actually keeps a bare fleet alive, because that is not a
threshold: it is **where the fleet may stand**, and the dozen unrelated-looking policy
fields that each quietly walk a character out of it.

```bash
node tools/m59-profiles.mjs --room 70                        # plan: who is ready, who is held, why
node tools/m59-profiles.mjs --area undead --split --apply    # confine to the graveyard + crypt
```

`town_safe_farming` is the first one and it means *farm what is inside the walls and never
step outside them*. **It is one setting in spirit and thirteen in practice** — `roam`,
`bank_above`, `sell_at_load`, `sell_when_broke`, the three `buy_*`, `vault_items`,
`guild_wants`, `guild_tithe`, `conflict_response_hops`, `farm_delivery`, `farm_cleanup` —
and **not one of them looks like travel**. `vault_items` deposits at the *Barloque* vault;
`conflict_response_hops` runs to a fleetmate's fight five rooms away.

Why it exists, measured 2026-08-19: a graveyard shift put **14 of 21 characters in the
Underworld inside one 35-minute window, and not one of them died to the prey.** They died
crossing — 584 The Flatlands, 585 the border of the Badlands, 576 The King's Way, 587 the
Western border of the Twisted Wood — and a death costs max health, which *is* the level.

**THE GUARD IS THE POINT, NOT THE POLICY BLOB.** Anyone can set `assigned_room`. What this
refuses is the two ways a town-safe posture silently stops being one, and both look like
success from the fleet board:

- **a farm room outside the town**, which makes the character walk out to reach its own
  assignment. A boundary room is refused by name, because 585 and 587 are where this fleet
  actually died rather than merely where it could have;
- **a character that is not in the town yet.** Applying a posture does not move anybody, so
  this would send it across exactly the wilderness the profile exists to avoid. It says
  "walk it in first" — which is a real workflow, since walking them in by hand is what an
  operator does while the routing is untrusted.

An unknown *current* room is the one thing allowed to be a note rather than a refusal.

### TACTICS CHANGE FASTER THAN CODE DOES — `m59-tuning.mjs`

```bash
node tools/m59-tuning.mjs                       # what is overridden, and which line won
node tools/m59-tuning.mjs --explain             # the surface, and what each key costs
node tools/m59-tuning.mjs --set defend_chase=false
node tools/m59-tuning.mjs --character Camilla --set "weapon_priority=mace,short sword,hammer"
```

Measured on one afternoon: the operator asked for player self-defence, then for chasing
anywhere on the map, then for no chasing at all — **three reversals in two hours, each right
when it was made**, and two of them were shipped by editing `m59-autopilot.mjs` and
restarting a broker holding twenty-one irreplaceable sessions. That is the wrong price for a
decision somebody is entitled to change their mind about, so the tunables moved to
`substrate/tuning.json`: read live, validated, layered over the profile by
`planProfile`, no restart. It is **gitignored** for the same reason
`substrate/policy.local.json` is — it names characters on one roster and says how to fight
with them, which is this machine's answer and nobody else's; `substrate/tuning.example.json`
is the shape.

**Layering is defaults → profile → character**, and the plan reports *which* line won, because
"why is this character different" is the question an overlay creates. The four properties are
deliberately the same ones `m59-localpolicy.mjs` argues for — silence means the profile rather
than an empty policy, a file that will not parse is **not** an empty file and says so, an
unusable value keeps the profile's rather than unsetting it, and an unrecognised key is
reported rather than dropped.

**`defend_chase` is the one this exists for.** Off (the default, and the behaviour before any
of this) engages only what has closed to melee. On, `defendAgainstPlayers` searches the whole
room and walks to a flagged attacker — which answers a group that hits and steps back out of a
3-square disc, and also takes a character off its wall. The melee reach itself belongs to the
SERVER (`SquaredDistanceTo <= GetAttackRange^2`) and is deliberately not a setting.

**`m59-tuning.mjs` is not `m59-tactics.mjs`.** That one is the append-only ledger of which
walker tactic fired and whether it worked — evidence, not settings. The names are close enough
that `m59-tactics.mjs` was once overwritten with tuning code, which took the broker down: `m59-broker.mjs`
imports `recordTactic` from it, and the fleet was logged out until it was restored from git.

**AN AREA IS TIGHTER THAN A TOWN, AND `restInTown` IS WHAT LEAKS OUT OF ONE.** Confining to
a town still lets a character walk to an inn, and it does: every strategy except
**`fieldrest`** carries `restInTown: true`, which walks a hurt character back to town to
recover **with its assignment still reading 70 and the board still reading healthy**. That
is how Camilla was seen leaving the graveyard. `town_safe_farming` therefore pins
`strategy: 'fieldrest'` — *"never walk back to town; withdraw within the hunting area and
rest there"* — which is the whole posture in one field.

`--area undead` narrows Tos to **the Graveyard (70) and the Crypt (71)**, and the map says
that pair is a genuine pocket rather than a hopeful rule: **71 has exactly one exit and it
is 70**, while 70 has the door back to 71 and one west EDGE to 50. So there is a single
leak, `70 -> 50`, and the tool **prints it** rather than pretending it is shut — nothing
here can close a door, what the profile does is remove every *reason* to take it, and
naming the door is what lets somebody check by watching one room instead of the whole map.
`--split` spreads the fleet over both rooms, because two rooms generating the same prey are
two respawn pools and stacking everybody in one wastes the other.

An area **narrows, it never widens**: asking for one that does not exist is a refusal, since
requesting a two-room pocket and silently getting a fourteen-room town would look like it
worked. Being *in the town but outside the area* stays a note rather than a refusal —
walking Familiars to the graveyard is a town walk, which is exactly what this profile
considers safe.

Two behaviours it deliberately does **not** suppress, both survival: the post-death recovery
that seats a character in an inn until health, mana and vigor are back, and
`retreatToSafety`, which leaves a room entirely when overwhelmed. Those are `mortality` and
`survival`, they decide at one second, and moving them out of this repository is what
`m59-unattended-test` exists to catch.

**The town is a curated room set and a name cannot do this job.** "The Deep Dark Woods **of
Tos**" (4) carries the name and is wilderness; "Familiars" (52) and "The Crypt" (71) carry
nothing and are indoors. `TOWNS.tos.boundary` names the way out rather than merely omitting
it. And the profile **reports what a character cannot do instead of assigning it silently**:
the engagement ceiling refusing the prey, or a kill that pays nothing because the creature's
level is not *strictly* above max health, are notes on a plan that is still ready — being
unable to earn is not a reason to leave somebody outside the walls.

## WHAT A JOURNEY MAY INTERRUPT ITSELF FOR — `travel_guard`

The fourth overridable surface, and the only one whose default is not a number but a
**refusal to go quiet**. Full argument and the table in
[`docs/m59-boundary.md`](m59-boundary.md); what belongs here is why it obeys the same four
rules as the other three.

```bash
autopilot action=set agent=<a> travel_guard='{"safe_spot": false}'
autopilot action=set agent=<a> travel_guard=off      # every faculty off — the old inert journey
autopilot action=status agent=<a>                    # the EFFECTIVE guard, travelling or not
```

### THE ROAD DOCTRINE — only a person and dying may end a journey

**Corrected 2026-08-27.** The bullet below used to read "all six faculties default **on** …
still flees, still rests, still re-arms". That is no longer true and the change is the
operator's, measured off 37 shadow road deaths across two five-inn pilgrimages — every one
`mode: idle`, pure travel, and 36 of 37 in five corridor rooms with none in a town:

| | |
|---|---|
| decline from peak health to death | median **119s**, 32 of 37 over a minute |
| time spent below the flee line | median **68s**, max 243s |
| regenerated 5hp+ *during* the decline | 23 of 37, several by +20 to +25 |
| frames spent `stalled` | **1,155 of 1,498** |
| frames holding a safe spot | **29 of 1,498 — 1.9%** |
| fifteen attackers at once | 26 of 37 |

An enormous window, and nothing used it. The thresholds were never the problem.

**And the answers the ladder had are not answers.** Walking away does not work on a monster —
vision is 4 + difficulty/2 squares and they follow — which is why the ordinary flee rung was
removed long ago. Changing objective for an inn is the same move with more road attached,
begun at the health that made it an emergency, through the rooms that caused it.

So there is **one** answer to everything on a road that is not a player or death: find the
next safe spot within `travel_shelter_detour` (5) squares of the **planned route**, park on
it, play dead **once** to make what is chasing forget, rest to **full**, and carry on. The
objective is never abandoned.

| faculty | | why |
|---|---|---|
| `flee` | **on** | gated on `worthEnding` — **people only** under `travel_flee_from` |
| `fight_back` | **on** | same gate; it is the "a *person* is emptying the bar" abandon, not trading blows |
| `rest` | **on** | a hop-boundary pause, never an abandon |
| `safe_spot` | **on** | the whole replacement behaviour, on both clocks |
| `arm` | **off** | the only one a **monster** can trigger, and it cancels at full health |

The rule a new faculty has to answer: **can this fire because of a monster? Then it does not
default on.**

### THE HOLE THAT WAS NOT IN ANY OF THESE SETTINGS

`travel_guard` was narrowed to a person and dying, `retreat_to_inn` was switched off, and the
flee rung had been gone for months — and a walk through a dangerous room was **still** cancelled
after two or three steps, from a completely different code path, on a threshold none of those
settings can see:

```
cancelled_by: "the watchdog pulling us out of a blind walk below the flee line"
```

The keeper's own watchdog cancels a walk whenever health is under the flee line and the pass has
been inside one await for three seconds. On an ordinary road that is most of a crossing. Measured
in the row-29 corridor of the Western border of the Twisted Wood with eight bodies parked along
it: **four separate live crossings cut off after two or three steps, every one by that line.**
Held off, the same walk ran nineteen. It also made every live movement measurement in a dangerous
room meaningless — the thing being measured was the watchdog.

**A doctrine with an exception nobody configured is not a doctrine.** So it is off, by default and
permanently, per the operator's rule: *"My bots either complete their travel orders, get
interrupted by PVP, or die."* Being hurt on a road is answered by the route-adjacent safe spot
instead, which runs on the keeper's own clock and does not need the walk torn down to happen.

**Only that half.** The watchdog's *pinned-wedge* rung is untouched and still fires — it is gated
on health being at or ABOVE the flee line, so it catches a healthy character that has covered no
ground for minutes (a stuck bot) and can never fire on a hurt traveller.

Three behaviours are **kept and switched off** rather than deleted, because a behaviour that is
gone cannot be measured again:

```bash
autopilot action=set agent=<a> travel_guard='{"arm": true}'    # stop on the road to re-arm
autopilot action=set agent=<a> retreat_to_inn=true             # change objective for a sanctuary
autopilot action=set agent=<a> blind_walk_watchdog=true        # cancel a walk when hurt
```

`retreat_to_inn` refuses **out loud**, naming itself, because a behaviour that is off and
silent is indistinguishable from one that is broken. What it does *not* gate: a character
already standing on a wall that has held stays there, and a character already in a sanctuary
or a monster-free retreat still counts as arrived. Those are statements about where the body
already is, and they sit above the switch on purpose.

- **Silence means the behaviour that was already there, never an empty policy.** A character
  whose roster says nothing about travelling still gets the doctrine above — it still shelters,
  still rests full, still ends a journey for a person — because the population that has no
  opinion configured is exactly the population nobody is watching.
- **An unusable value keeps the committed one.** `travel_guard` merges over whatever is
  already set, so `{"flee": false}` turns off one faculty rather than turning off the other
  five by omission. Pass the string `off` to mean all of them; `null` clears the override.
- **An unrecognised key is REPORTED, never applied and never dropped.** A misspelled faculty
  is an error naming the six valid ones. This is the same rule that `purpose` broke by
  sitting outside a schema for a year with every keeper's audit switched off, and the cost
  of breaking it here is higher: a `travel_guard` typo would read as configured and behave
  as unconfigured on the one axis where unconfigured used to mean *dead*.
- **And the setting is visible before it matters.** `autopilot status` reports the effective
  guard whether or not a journey is running, because the question an operator asks is *what
  will this character do if something sends it across the world*, and an answer that only
  exists once one already has is an answer arriving after the post-mortem.

**`travel_hold` is a different setting and is no longer an experiment.** It chooses whether
a journey stops at a WALL in the open; `travel_guard.safe_spot` chooses whether it is
allowed to at all. The safe-wall A/B was retired on 2026-08-21 — `on` is the default,
`ab`/`half` are accepted as `on` and say so in the journal rather than being silently
remapped. It was not closed by reaching significance: it compared two ways of travelling
*well*, and what kills this fleet is getting stuck, lost or unresponsive and being eaten
where it stands, which neither arm addressed while the control arm paid for the asking by
walking hurt characters straight past the only free healing on the road.

## In a crowd, the only wall is the exit

Read off 89 road deaths across both fleets on 2026-09-02 (10 on prod, 79 on shadow, farming
rooms excluded): 57 of them had STOPPED — "taking a wall on the way past", "resting at a
refuge on the way", a hop-boundary hold below `travelHoldBelow`, or "wedged and hurt with
something in reach — trading in place" — in a room holding 9 to 18 monsters, and stood
there a median of two to three minutes before dying. 23 were wedged. 9 were moving. The
"set out at one health" bug the operator fixed the same day explains almost none of them:
the road dead entered their last ninety seconds at or near full health.

The mechanism is the divert rule: in a room that outranks the character
`travelDivertBelowOutranked` is 1, so the first scratch sends it to the nearest wall the
geometry calls unreachable — and in a room of thirteen trolls and spiders that wall is
reached, and the character dies on it without moving. The same squares recur on both
servers: the Cragged Mountains' r18c16/r19c16 and r45c16/r46c16, the Twisted Wood
border's r29c43/44, Ukgoth's r48c9/r50c10 and its row-24 road, the Badlands' column 9–12.

So: `travelStopMaxThreats` (autopilot tool `travel_stop_max_threats`, env
`M59_TRAVEL_STOP_MAX_THREATS`, default 6, 0 disables). At or above that many live
threats in the room, a journey makes no stops of any kind — no wall on the way past, no
hop-boundary hold, no trading in place — and a retreat withholds every wall
(`wallsAllowed: false` in `nearestSafeSpot`) so the exit is the only candidate, which is
the one square that actually breaks every attack. Each refusal writes one `crowd_no_stop`
row per room per minute. Silence keeps the old behaviour: the rule is a number this
machine can change live, and `m59-forward-shelter-test.mjs` pins the search half.
