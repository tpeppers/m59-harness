# Policy, profiles and tuning

An explicit operator can set `autopilot survival_enabled:false` to stand down
autonomous noncombat behavior. The default is `true`. The switch clears old
recovery decisions and freezes, disables watchdog interventions and journey
recovery, and leaves the body available for explicit movement orders. Player
combat (including a configured fallback strategy), identity handling and death/
Underworld escape remain active. Ordinary farming strategies cannot set it.
Set it back to `true` to restore the normal keeper behavior.

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

## ONE TASK'S POSTURE IN ONE FILE — farming strategies, and who set each key

A **farming strategy** (`substrate/farm-strategies/<name>.mjs`, assigned with
`autopilot farm_strategy=<name>`) is the same four rules applied to a whole task: what to hunt and
in what order, the weapons or touch spell, the loot filter, the confinement, plus small hooks. It
is laid over the policy only while the keeper owns each key's faculty, refuses any survival or
war key, keeps the previous good version when an edit breaks, and carries nothing but its name.
Every writer of the policy now credits what it changed, so `autopilot status` answers "who set
this key" as `policy_sources`. [`docs/m59-strategies.md`](m59-strategies.md) has all of it.

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

## OVERMATCH: A FARMER FAR STRONGER THAN ITS PREY FIGHTS IN THE OPEN AND DOES NOT STOP — `overmatch`

```bash
node tools/m59-overmatch-test.mjs       # 34, offline
```

Operator, 2026-11-17/18: *"Characters seem to rest far more than needed, especially when farming creatures significantly
below their power level ... most of the fleet right now is 2x+ stronger than what they're farming and likely don't need
to rest at all ... they could probably all just rely on second wind and constantly fight unless/until they find
themselves below, say, 1/3rd max health."* And: *"we definitely don't want people farming monsters less than half their
strength to be caring about safe spots at all."* His yardstick is 60+ kills in 30 minutes for a body over 100 health; he
does 80 by hand. The fleet did 25-30.

**What was measured.** Over six hours the Castle Victoria farmers (143-150 max health against level-75 skeletons and
level-55 zombies) spent 25-78% of their samples "holding a proven safe spot" and most of the rest "fighting from a
proven safe spot"; 78% of the room's kills were made from a wall and the room gave 31% of its spawn ceiling. Three rules
did it, and **no policy could lower any of them**:

| | the rule | what it did to a 150-health farmer |
|---|---|---|
| health | `safetyFor` hard-codes `engageAt` 0.75; the wall is left at `hold_resume_above` 0.9 | stopped fighting at three quarters, sat until nine tenths |
| vigor | "hurt" whenever vigor is under the resting cap (80 of 200) -- and resting restores vigor only TO that cap | without a meal: fight to 79, wall, rest to 80, back, for ever |
| walls | a wall at `wall_at_attackers` (2) in melee reach, or every fight opened from one (`pull_to_safe_wall`) | two in reach is the ordinary state of a room that holds ten |

A live A/B on 2026-11-18 said which of the three pays: taking only the combat wall away cut kills-from-a-wall from about
80% to under 10% and left the kill rate where it was. **The health and vigor lines are the part that matters.**

**The predicate** (`tools/m59-overmatch.mjs`, pure; `Autopilot.overmatch()` gathers it). A farmer is overmatched when its
maximum health is at least `prey_ratio` (1.8) times the level of the STRONGEST thing that can stand in its room:
every row of the room's spawn table, huntable or not, and every hostile creature in sight. Not what it hunts -- what
can hit it while it hunts. Room 377 is level-30 giant rats and a level-105 lupogg, so a 150-health farmer there is not
overmatched; nor is anyone against trolls (90, and the stone troll at 120), or with a creature of unknown level in
sight, or in a room whose table can spawn one (the Mausoleum's shadow mummy; a townsperson a room creates is not one),
or in a room with no spawn table. It is also off while the body is not the farm's: travelling or on an errand (a
journey keeps its own lines), a faculty leased away, recovering from a death, poisoned or diseased, or within five
minutes of a player's blow. Every inactive verdict says why in one sentence.

1.8 and not 2: the operator counts Kermit (143), Lew (146), Rizzo (148) and Piggy (149) as overmatched against level 75,
which is 1.91 to 1.99.

**It is a statement about proportion, so it means the same at every size.** A monster's blow is about `level / 12`
(`Fuzzy(viLevel / Random(10,15))`, monster.kod), so a body at exactly the ratio reaches its flee line with
0.25 x 1.8 x 12 = 5.4 of the room's hardest blows still in hand, whether it has 54 health or 250. And nobody small is
ever it: the weakest levelled room in the spawn table is level 30, so the smallest body the predicate can call
overmatched anywhere has 54 health, and the under-30 rule of `safetyFor` (do not start a fight below nine tenths) is
never the one overridden. A 60-health character among level-30 rats IS overmatched; a 99-health one in Castle Victoria
is not.

**While it is on**, every faculty reads the same answer, so none can disagree with another:

| | not overmatched | overmatched |
|---|---|---|
| stop opening fights, go and rest | below `engageAt` 0.75 (0.9 under 30 health) or `rest_below` | below `rest_below` **0.34** |
| get up from the wall | `hold_resume_above` 0.9 | `resume_above` **0.67** |
| break a fight off; the watchdog and the 1-second ladder (`safety().fleeAt`) | `max(flee_below, two of the biggest blows)` | `flee_below` **0.25** |
| the play-dead logoff | on arrival at a recovery wall; at the flee line; at `doomed_in_open_below` / `doomed_in_spot_below` (0.3) | only below `flee_below`: the doomed thresholds are capped there, and a stop above it takes its wall without one |
| vigor is a reason to sit | under the resting cap (80), or spent | only SPENT (under `ordinaryVigorFloor`, 20) |
| vigor a fight is opened at (`fightFloor`) | the fed 140 / the rested 70 | the ordinary floor (20); 0 with Second Wind |
| a wall for a fight | at `wall_at_attackers`, or always (`pull_to_safe_wall`) | none -- unless `overmatch.wall_at_attackers` says so |

**Three places ended a rest, with three numbers, and now they read one answer.** The survival dispatcher
(`continueSurvivalDecisionStep`, which runs before the ladder) ended a recovery only at FULL health and 80 vigor; the
rest gate rested to `hold_resume_above`; `releaseRestedHold` let the wall go at the resting ceiling. The dispatcher was
the one that actually held a farmer on its wall, because the pass never reached the other two.
`Autopilot.overmatchRested` is the one answer all three ask while overmatched: health at the resume line, and vigor no
longer a reason to sit.

**The logoff belongs to the flee line.** Every play-dead logoff opens a healing session (`m59-healing-session.mjs`) that
bars a second logoff, and every town trip, until the body is back at FULL health -- which a farmer that returns to the
fight at two thirds may not see for an hour. So a stop above the flee line, for health or for spent vigor, is a
voluntary one: the same wall, no logoff on arrival. Below the line the doomed and flee rungs log off as they always
did, and a wall that turns out not to hold still answers with a reconnect. **And a body that HAS spent its logoff heals
as it always did:** while that session is open its resume line is `hold_resume_above` again (`lines.healing_session` on
status). With no wall to be had at all, the open-floor rungs below are the ones the ladder always had.

A rest begun spent runs to its bar: the resting ceiling (80, less a ring of lethargy), or just clear of the floor (30)
when Second Wind is the vigor supply. **Spent while Second Wind is still running** is the one state resting cannot fix:
the server holds the rest threshold at 10 until the skill ends and refuses food with it, so the body waits on its wall,
on its feet, and says so once a minute (`spent, and resting cannot pay yet`) instead of resting, gaining nothing and
giving the square up.

**It outranks `pull_to_safe_wall`.** The roster carries `pull_to_safe_wall: true` on half the fleet -- it was the
default -- including Kermit and three other Castle Victoria and Ancient Place farmers, exactly the characters the order
names. To keep an overmatched character on walls, say so where the decision is made: `overmatch: "off"`, or
`overmatch: { wall_at_attackers: 2 }`.

**Untouched:** a journey (`travel_guard`, `travelHoldBelow`, `travelStartHealth`, `travelHoldResumeAbove`, and the
"too hurt to set off" gate of `leaveHold`), death recovery (rests to whole), poison (shelters in place: the verdict is
off while it lasts), the PvP response, and the needle, patrol, buddy, gang-up, guard-zone and room-enchant postures.
Target choice, the pull machinery, chase on foot, loot and town trips are not changed by this either. A body that is
NOT overmatched reads exactly the numbers it read before: `safety()` is `skills.safetyFor`, the doomed thresholds are
the policy's, and a recovery ends where it always ended.

| value | meaning |
|---|---|
| `"auto"` (default) | on when the predicate holds |
| `"on"` / `true` | on whenever farming, whatever the prey (still off while held, recovering, poisoned or in PvP) |
| `"off"` / `false` | never: the lines and walls this character had before, exactly |
| `{ mode, prey_ratio, rest_below, resume_above, flee_below, wall_at_attackers }` | no `mode` means `"auto"`. Refused unless `flee_below` < `rest_below` < `resume_above` |

A farm strategy file may say `overmatch` too (mode, `prey_ratio`, `wall_at_attackers`): whether ITS farm is one. It may
not set the three health lines -- when a character rests and flees stays with the keeper and the operator.

`autopilot status` reports `overmatch`: the verdict (`active`, `why`, `ratio`, `prey_level`), the `lines` every farming
decision is reading at that moment, `opens_fight_from_wall`, the `vigor` bars, and `spent_rest_since`. The journal says
`overmatch on: ...` and `overmatch off: ...` once on each edge (a logoff is not an edge), and a death record carries
`vitals.overmatch` -- how long before the death the verdict was last on, in which room, and the lines it gave -- so a
death on these lines can be told from one on the old ones.

**THE ROSTER REMEMBERS THE OLD DEFAULT OF ITS NEIGHBOUR.** `overmatch` is a new key, so every character gets `"auto"`
from the code. `second_wind_farming` is not: the broker saves a character's WHOLE policy on every `autopilot` call, so
every character whose keeper was started since 2026-11-05 carries the old default `"off"` as if somebody had ordered
it, and a default changed in code never reaches it. Push `second_wind_farming: "auto"` once to each farmer that should
rely on the skill (`autopilot status .second_wind.mode` says which it has). Until then an overmatched farmer keeps its
meals, which is no hardship: it eats when there is room, never waits to digest above the ordinary floor, and the skill
still fires by itself under 25 when the pack is empty. And restart the KEEPERS before the broker: a keeper still on the
old code that is pushed `"auto"` reads it the old way (twice the worst huntable spawn) with the old rest rules, which
is the combination that sat farmers on a wall waiting for vigor the skill forbids.

**WHAT NO OFFLINE SUITE CAN SAY, AND WHERE TO READ IT ONCE THE KEEPERS ARE ON THIS CODE.** The suite pins the decisions;
it cannot pin the room. Each of these is a question about a live farmer, with the field or the sentence that answers it:

| question | read |
|---|---|
| is it on, and if not, why | `autopilot status .overmatch.active` and `.why`; on a Castle Victoria farmer `.overmatch.lines` reads rest 0.34, resume 0.67, flee 0.25 and `.overmatch.opens_fight_from_wall` is `false` |
| did the yield move | the fleet row's `kills_30m` (the ledger's, not the keeper's own tally, which a restart empties), against 25-30 before and the operator's 60 |
| does it still walk to a wall while healthy | the journal: `took a wall before resting` above a third of its health is the old rule still in force; `hurt, and far stronger than this room — a wall before a rest` is this one, and belongs under 34% |
| does it leave the wall again | `leaving the wall — rested to the overmatch lines`, at two thirds and not at nine tenths. After a play-dead logoff `.overmatch.lines.resume` reads `hold_resume_above` until the body is whole: that is the healing session, not a fault |
| what the skill's cooldown costs | `spent, and resting cannot pay yet — waiting it out`, once a minute while it lasts, and `.overmatch.spent_rest_since`. A large share of the half hour here is an argument for meals, never for a lower line |
| does the verdict flap | count the `overmatch on:` and `overmatch off:` edges in an hour; `.why` names the level or the unlisted creature that turned it off (a faction soldier in sight does, for as long as it is in sight) |
| did these lines cost a life | a death record's `vitals.overmatch`: a small `ms_before` is a death on these lines, and it is absent when the verdict was never on |

## SECOND WIND IS THE LARDER AGAINST WEAK PREY — `second_wind_farming`

```bash
node tools/m59-second-wind-test.mjs     # 9, offline
```

Operator, 2026-11-05: characters far stronger than their prey, with Second Wind, should not eat -- "just have second wind
keep giving them vigor back (and a chance for an improve!)". Second Wind (secwind.kod) fires on any exertion below 25
vigor, adds 40 + stamina/2 + ability, rolls a 50% chance to improve, and for its 5-10 minutes pins resting at 10 and
REFUSES food. So a meal holds vigor above the only place the skill pays, and a fight floor (Scooter's was 95, with three
edible mushrooms) idles the character: 60% of a 20-minute window resting or eating, 2026-11-05.

| value | meaning |
|---|---|
| `"auto"` (default) | on for a farmer that knows Second Wind and is OVERMATCHED: the same predicate, at the same ratio (1.8, every spawn-table row and every creature in sight), that takes its walls and rests away |
| `"on"` / `true` | on whenever it knows Second Wind and is farming |
| `"off"` / `false` | never: the old floor and the old meals |
| `{ mode, prey_ratio, eat }` | no `mode` means `"auto"`; `eat: true` keeps the meals and still drops the floor. A `prey_ratio` WRITTEN here keeps its older meaning -- max health over the worst HUNTABLE spawn of the room, at that ratio -- whatever overmatch says |

**THE DEFAULT WAS `"off"` UNTIL 2026-11-18**, a staged rollout through `icky-cave-patrol`. The operator's order that day
("rely on second wind") made `"auto"` the default, with one question behind it instead of two. A roster written before
then still says `"off"` -- see the note at the end of the overmatch section.

On: `fightFloor()` is 0 and `provision()` eats nothing. Untouched: survival and its 1-second ladder,
`ORDINARY_VIGOR_FLOOR` (20 -- below the trigger, so a fighting character triggers first), and the meal before a
journey. Why a ratio at all: health regenerates about 2.6x slower at 10 vigor than at 100 (player.kod
CalculateHealthTime), and the fleet has died at 101.8 per thousand observations at or below 85 vigor against 4.4 at
86-120 -- mostly against prey its own size. `autopilot status` reports the verdict as `second_wind` (`by: "overmatch"`
when the predicate answered).

Expected rhythm per trigger: about four minutes of fighting on the refill, then, if vigor reaches 20 while the skill is
still running, a wait on a wall until it ends (resting cannot help before then, and the keeper no longer sits down to
find that out), a rest to 30, and the next swings under 25 fire the skill again. `ordinaryVigorFloor` is the
per-character key that shortens the wait. How long that wait is depends on the character's Second Wind ability (the
refill grows and the duration shrinks with it), and it is the number to watch after a deploy.

## THE PVP RETURN DELAY — `pvp_return_delay_ms`

The operator's order, 2026-09-30: *"set it so that there's a 30m PVP delay on returning to any
farming zone"*. That evening a Human Resistance player camped Castle Victoria's front door, the
Tos gate and Outside Castle Victoria, and killed respawned characters one at a time as each
walked straight back: five deaths in twenty minutes, every one from full health. A monster does
not wait at the door for you. A person does.

```bash
autopilot action=start agent=<a> pvp_return_delay_ms=1800000   # the default: thirty minutes
autopilot action=start agent=<a> pvp_return_delay_ms=0         # off for this character
autopilot action=start agent=<a> pvp_return_delay_ms=null      # back to the default
autopilot action=status agent=<a>                              # pvp_return_hold: {until, killer, remaining_s, …}
```

**A death to a player starts a window in which the keeper will not START a journey to a farming
room** — its assignment, or any room the spawn table says generates something huntable. It rests
where it recovered, which is normally the inn the Underworld portal dropped it in, and an inn is
`ROOM_NO_COMBAT`. The fleet row and `autopilot status` carry `pvp_return_hold`, and the activity
line says *"holding off the farm after a PvP death by …"*, so a healthy character sitting in an
inn reads as deliberate. Deaths to monsters start nothing.

**How a PvP death is recognised** (`classifyPvpDeath`, `tools/m59-pvp-return.mjs`), from evidence
available at death time, strongest first: the server's *"… has been slaughtered by X of <guild> in
guild combat"* naming us (printed only for mutual war enemies, and it REPLACES the ordinary death
line — which is why the death attribution could only ever guess at a Morpheus kill); a murder
broadcast; the killer being a player object in the last living frame; the killer being remembered
in the war book; the killer seen as a player in an earlier frame; and last, the server naming the
killer without an article when the name is not a monster that was standing there. **Never a
player:** an unresolved `<dynamic …>` id, a fleetmate, or a monster's name. The answer is stamped
on the death record (`pvp`, `pvp_killers`, `pvp_basis`, `pvp_why`) so the post-mortem says so.

**A player's minute makes it PvP, whoever struck last** (operator, 2026-10-21). When none of the
killer evidence above names a player, the death is still PvP — `pvp_basis: player_attack_recent`
— if a stranger player hit this character in the **60 seconds** before it died
(`recentPlayerAttacks`, `RECENT_PVP_MS`). The camper does not need the kill: he hits, the character
flees into a room of monsters, a frogman finishes it, and without this the keeper filed a monster
death and walked straight back to the gate. Two sources, both *a stranger within reach AND our
health fell*, the same standard `checkAttackedByPlayer` writes the grudge book on: that check's own
per-character record (`Autopilot.playerAttacks` — the grudge book keys on the attacker and cannot
say "hit ME, when"), and the death's frames, where `players_near` beside a falling `health` covers
the blind walks the watchdog records. `pvp_killers` names the attackers; the last blow is kept as
`killed_by`. Mere presence in the room (`players_present`) is not an attack.

**Where it is enforced.** At `Autopilot.travel()` — the one gate every keeper-initiated journey
passes, the same one the Underworld refusal and the confinement use — and as a rung at the top of
`passFarm`, which rests instead of choosing work while the character stands somewhere safe. A
character already standing in a farming room is not moved by it: the pass works the room it is in
and the gate stops it setting off for another.

**What it deliberately does not block**, each for a reason that is not negotiable here:

| | |
|---|---|
| the Underworld exit | a portal walk, never `travel`; mortality |
| fleeing, and every recovery detour | `recoveryTravel` is survival, and survival is the keeper's |
| a walk to a sanctuary or a town | not a farming room |
| an explicit travel order | the broker's `travel` tool and FleetScript reach the keeper through `travelJob`, which marks them `explicitOrder`; somebody chose that destination on purpose |
| a leased or busy character | **the lease holder decides the destination** — the same rule `passFarm` applies to every directional choice. A bot holding `movement` that sends a character back to the farm has made that call |

**It survives a keeper restart.** Keepers restart about once a minute on a busy day and
`lastDeath` dies with the process, so the death time and the killer are written to
`substrate/pvp-holds-<fleet>/<agent>.json` (gitignored — it names players and our characters) and
read back by the next keeper on the same slot. The window is measured against the delay
**currently** in policy, so setting 0 releases a held character on its next pass.

The same four rules as every other surface here: silence is the default (thirty minutes, **on**,
because the operator asked for it fleet-wide and an unconfigured character is exactly the one
walking back into the camper); an unusable value is refused at the setter rather than coerced
(`Number(null)` is 0, which would switch it off); `m59-localpolicy.mjs` accepts it as an
overridable key and warns when a block switches it off; and `policy_control` reflects it from
the schema like every other order. `node tools/m59-pvp-return-test.mjs` (62) pins all of it.

## WHERE A CHARACTER MAY FIGHT A PLAYER — `pvp_rooms`

The operator's order, 2026-10-11: *"stop people from fighting back outside of 599/2/38 (Ukgoth
<-> Castle Victoria)"* — it *"overrides fight back in maps outside of 599/2/38"*.

```bash
autopilot action=start agent=<a> pvp_rooms=[599,2,38]   # players are fought only in these rooms
autopilot action=start agent=<a> pvp_rooms=null         # every room again (also [])
autopilot action=status agent=<a>                       # policy.pvpRooms, and pvp_rooms: {rooms, room, allowed_here}
```

**Map room numbers (`room.num`), never object ids.** A non-integer, zero or a word is refused at the
setter with an error naming `pvp_rooms`, because a list that quietly dropped a typo would leave a
character fighting where the operator said not to. Unset, `null` or `[]` is the behaviour from
before the key existed.

**The one decision** is `pvpAllowedHere(policy, roomNum)` in `tools/m59-pvp-rooms.mjs`, and every
path that can swing at a PLAYER asks it: combat mode's return fire after a hit (`beginPvP`), the
war's engage-on-sight and a fleetmate's alarm (`beginWar`), `syncPvP` (a fight carried out of the
list ENDS, with the reason *"PvP: outside pvp_rooms (room N; allowed …)"* and never "operator
suspended connection"), and the keeper's `defendAgainstPlayers`, `engagePlayerTarget`,
`respondToConflict` (it will not converge on a fight in a room it may not fight in) and the PLAYER
rows of `passFightBack`. An unknown room (no ROOM yet) is not a listed one.

**What it deliberately does not touch.** Survival: the body is never taken or frozen; a character
hit outside the list is left to the keeper's own ladder — flee below the line, playDead, panic
logoff — exactly as for anything else hurting it that it will not fight. Monsters. And an
operator's explicit `combat_order`, which is a person choosing a target on purpose.

**It still reports.** Outside the list a war enemy produces the `sighted` alarm, and a hit produces
the `attacked` alarm — fleet-mates standing in an allowed room fight on those. The hit is also
written as a `pvp_outside_rooms` combat line (target, room, `survival: keeper ladder`) and as a
`pvp_attacked_outside_rooms` row in `substrate/pvp/<fleet>/<day>.jsonl` (observer, room, attacker,
at), which the battle reader counts as hostile contact, so a red-alert watcher sees the attack
that was not answered. A farming strategy cannot set it (`PROTECTED_NAMES`: a war/PvP path).
`node tools/m59-pvp-rooms-test.mjs` (53) pins it.

## Monster count does not veto shelter

Travel shelters and recovery walls are available regardless of how many monsters
are in the room or within melee reach. Eligibility is about the specific refuge:
its geometry, occupancy and a reachable approach around walls and bodies. The
ordinary health thresholds and explicit travel guard settings still apply.

The September 15 audit removed a remaining minimum-of-six gate on wedge recovery
and a nearby-monster veto on hop-boundary shelter. Hop-boundary selection now
uses the shared recovery path check. Routine route diversion and the recovery
selector had already stopped using the old maximum crowd threshold.

`travelStopMaxThreats` (legacy input `travel_stop_max_threats`, environment
`M59_TRAVEL_STOP_MAX_THREATS`, default 6, 0 disables) now only gates aggressive
quarry pulls and stationary melee trading. It cannot disable shelter. New
refusals use `crowd_combat_refusal` telemetry; historical `crowd_no_stop` records
must be interpreted using their code epoch and trigger, not as current policy.

### Historical crowd experiment, September 2–3 (superseded)

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

That observation led to a room-count rule: at six live threats the journey
withheld wall stops, and retreat passed `wallsAllowed: false` to
`nearestSafeSpot`, leaving only exits. This was a historical policy inference,
not proof that monster count invalidates a wall. The rule is no longer used for
shelter. The explicit exit-only selector option remains available for simulations;
no production caller derives that option from monster count.

**The historical wedge-exit experiment.** With the crowd rule on, tour 14 (2026-09-02) had no wall-stop deaths and two
wedges: the wedge arm had given up ("N walks from this square went nowhere") and the journey attempt
returned refused, which means the body STANDS for the hold — one stood 160 s in Ukgoth before the first
blow. So when the arm gives up in a crowd the attempt calls `takeSafeSpot` with the journey's onward
exit and destination; with walls withheld its only candidate is the exit, the wedge becomes one hop out,
and the journey re-plans from the far side (`left_by_exit` in the attempt's answer, "left a wedge by the
exit" in the notes, a `crowd_no_stop` row with trigger "standing in a wedge").

**Three corrections from tour 15** (2026-09-03). A crowd is counted by BODIES (`threatCountHere`: attackable,
not a player), not by names — `namedThreatsHere()` drops any object whose name resource is unresolved,
and in the Sewers of Barloque that left a room of 25 rats and lupoggs counting as empty while a traveller
took a wall there. The exit crossing refreshes the journey's control lease (`inert.at`) on both sides of
its one-hop travel, because the lease is never otherwise touched and "reviving myself — nobody came back"
was cancelling crossings mid-hop. A fourth was tried and withdrawn on tour 16: letting the
watchdog's four-second "wedged, travelling, taking hits" cancel the walk in a crowd so the next pass could
leave by the exit. Cancelling ENDS a runner-driven journey ("no longer travelling"), and the body was left
standing in the crowd with nothing to do — the death it was meant to prevent (5 in the first 25 legs). The
wedge-exit stays on the arm's give-up, where the retreat and the re-plan belong to one pass; the arm's
slowness in a crowd is the open item.
