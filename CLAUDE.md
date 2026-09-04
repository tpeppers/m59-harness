# m59-harness — instructions for an agent working in this repository

This repository lets an agent play Meridian 59 as a real player character. If
someone has just cloned it and asked you to **install the game and make them a
fleet**, this file is the whole procedure. Follow it in order.

The long version, with troubleshooting, is [`docs/INSTALL.md`](docs/INSTALL.md).

**This file is an index as much as a briefing.** Everything here was learned the
expensive way, and most of it now lives one file deeper, in `docs/`, so that this page
stays readable. **The pointers are not optional reading** — they are where the traps
are written down, and a trap you have not read costs a session. Read the one that
covers what you are about to touch, before you touch it. Comments across `tools/` that say
"see CLAUDE.md" mean the entry this table points at.

| about to | read |
|---|---|
| move a character; edit the router, the mover, an anchor or a bake | [`docs/m59-routing.md`](docs/m59-routing.md) |
| decide what to fight; change a threat, prey, spawn or armour rule | [`docs/m59-combat.md`](docs/m59-combat.md) |
| debug a keeper, a death, a stall, or a rate that reads zero | [`docs/m59-keeper.md`](docs/m59-keeper.md) |
| buy, sell, trade, supply, bank, or change a loadout | [`docs/m59-economy.md`](docs/m59-economy.md) |
| send any guild command, or found or fund a hall | [`docs/m59-guilds.md`](docs/m59-guilds.md) |
| parse a packet, read a stat, trust a reply, or hit a player | [`docs/m59-protocol-traps.md`](docs/m59-protocol-traps.md) |
| touch a board, the compendium or the planner | [`docs/m59-boards.md`](docs/m59-boards.md) |
| run, back up, restore, lend out or shut down the fleet | [`docs/m59-operations.md`](docs/m59-operations.md) |
| change a threshold, a posture, an area or a tactic | [`docs/m59-policy.md`](docs/m59-policy.md) |
| hand a bot a character, or take one back | [`docs/m59-boundary.md`](docs/m59-boundary.md) |
| read a ledger, or land a commit that changes how the fleet moves | [`docs/m59-evidence.md`](docs/m59-evidence.md) |
| interpret, log, serialize, or compare a coordinate | [`docs/m59-coordinates.md`](docs/m59-coordinates.md) |
| run or extend the offline tests | [`docs/m59-tests.md`](docs/m59-tests.md) |

## The one-liner

```bash
node tools/setup.mjs all 10
```

That clones the server source, builds it in a container, starts it, starts the
broker, creates ten characters, and — if a client is installed — writes a
click-to-play shortcut for each of them. Ten to fifteen minutes, mostly
compiling.

**Run `node tools/setup.mjs doctor` first** and read what it says. It reports
each prerequisite and each port, and it is the fastest way to tell which of the
steps below still need doing. Every step is idempotent — running it twice finds
what the first run made and says so.

## The steps, if you are doing them one at a time

| | command | notes |
|---|---|---|
| 1 | `node tools/setup.mjs server` | clones + builds + runs `blakserv` in Docker |
| 2 | `node tools/setup.mjs client` | finds a Steam install; **cannot install one** |
| 3 | `node tools/setup.mjs broker` | starts the MCP broker on 8901, dashboard 8902 |
| 4 | `node tools/setup.mjs fleet 10` | creates ten characters |
| 5 | `node tools/setup.mjs shortcuts` | one click-to-play shortcut per character |

Step 5 needs both of the others: a client to launch and a roster to read. It is
skipped harmlessly when either is missing, and `all` runs it last for that reason.

## Click-to-play shortcuts

`node tools/m59-shortcuts.mjs` writes one per character. They carry the character's **host,
port, account and password** on the client's command line, so `shortcuts/` is gitignored
and `0700` and `--show` must never appear in a shared transcript. Logging in **bumps the
broker off that character** — one connection per character — which is expected; use
`--proxy` when you do not want it. The rest is in
[`docs/m59-operations.md`](docs/m59-operations.md).

## The boundary: what this repository decides, and what it does not

Behaviour is split across three repositories and **the split is by CLOCK, not by
importance**. Anything that has to be right within a second stays here. Anything with no
single right answer, that can be re-decided in five minutes, belongs to whoever the
operator pointed at the fleet.

| | decides at | owner | examples |
|---|---|---|---|
| identity, mortality, survival, recovery | **1s** | **this repository, always** | am I dead; something is hitting me; sit down while I am hurt and safe; get out of the Underworld |
| unstick a stalled keeper | 60s | **this repository** | `m59-supervise.mjs`. Telling a deliberate refusal from a stall needs keeper internals, and it runs on bot-held characters too |
| work, movement, economy, social | minutes | **a bot**, when one is attached | what to hunt; which room; which errands to stop for; when to bank |

`meridian59-dum-bot` is the deterministic driver of the third row and
`meridian59-llm-bot` is the hands-on one. Neither may take the first row silently: the
four protected faculties are refused unless the **roster** consents
(`PROTECTED_FACULTIES`, `may_yield`), because an unattended character — one whose bot
crashed, was `Ctrl-C`'d, or was never started — must still run from a fight it is losing.

`node tools/m59-unattended-test.mjs` (55) is the guard, and it is the cheapest insurance
here: with nothing attached, every faculty answers `keeper`, a bot asking for all eight
gets only the directional four, an expired lease is the keeper's again, and the override
takes a character back from a bot rather than letting its next heartbeat reclaim it.
**It should fail the day somebody moves a survival decision out of this repository.**

**AND A JOURNEY IS NOT AN ERRAND.** An errand takes a character away — `goInert`, the
survival ladder off, which is right when `m59-outfit.mjs` is walking it across town. A
journey only *steers*, and giving it the errand's silence is what killed Cccc on
2026-08-21: re-sent a `travel` while dead, walked out of a sanctuary at 27% health against
a 70% flee threshold, eaten over twenty-two seconds with the keeper watching every frame.
`travelJob` takes **`goTravelling`** instead — the ladder stays armed, six faculties on two
clocks, every one of them switchable live per character with `travel_guard`. Mid-hop
triggers CANCEL the journey rather than fighting the mover for the body; hop-boundary ones
pause it. **None of them asks whether the character is moving** — his last pulses were a
two-square shuffle against a wall, which resets every stillness timer it meets.
`node tools/m59-travelling-test.mjs` (64) is that guard;
[`docs/m59-boundary.md`](docs/m59-boundary.md) has the table and the argument.

The rest of the split — the three moments a keeper asks a **playbook** about
(`attacked_by_player`, `died`, `improved`), the closed verb set, and the difference
between a bot **claiming** a character and declaring it **busy** — is in
[`docs/m59-boundary.md`](docs/m59-boundary.md). Two rules from it that get broken by
accident: **silence means the behaviour that was already there, never paralysis or an
empty policy**, and **`claim` leaves a character takeable while `busy` is what makes
everything step over it**, because `ms_since_moved` measures the KEEPER and climbs while
an errand is walking the character perfectly well.

## Which fleet — check this before you touch anything

A fleet is a named roster, one per server, and **passing the wrong one operates on the
wrong fleet quietly**. Nothing errors; you just get a healthy broker holding characters
nobody is playing. So every fleet tool resolves the name the same way, most explicit
first:

| | |
|---|---|
| `--fleet <name>` | what this invocation said |
| `M59_FLEET=<name>` | what this shell said |
| `substrate/fleet-default` | what this checkout cares about — one line, gitignored |
| nothing | `substrate/fleet-state.json`, as it always was |
| `--fleet -` | that unnamed fleet, asked for on purpose |

```bash
node tools/m59-which.mjs            # which fleet, which roster, what the broker holds
```

Read-only, and it **exits non-zero on a mismatch** — when the broker is holding one fleet
and your next command would act on another. Every `/m59*` command runs it first for that
reason. If it reports a mismatch, stop: that is the failure that once took down a live
46-session broker while every step reported success.

**A broker is ours only when its `/health` state path IS our roster file** — never when its
fleet label merely matches, because two checkouts can each hold a fleet called `prod` and
they are not the same characters. It corroborates that against the roster lock, the pid
file, and the **process start time** of the pid answering, which is the checksum that tells
a genuine claim from a recycled pid wearing the same number.

**And it now has a third answer besides yes and no: `INDETERMINATE`, which also exits
non-zero.** A port that does not answer is a question, not a fleet. It used to fall back to
"some other broker that did answer" and report that as the verdict — so one slow reply from
the prod broker printed `MISMATCH: the broker is holding "shadow"`, naming 21 entirely
different characters, roughly one run in four. Prod's `/health` was measured at 1046ms idle
and 2573ms under load against 4ms for an idle broker, so **the busiest broker is the one
most likely to be missed, and it is always the one that matters**. `m59-which-test.mjs` (16)
pins all of it; run against the old code, another checkout's `prod` returned exit 0.

`m59-which.mjs` answers for **one** fleet — the one the next command would touch. When
the question is *which fleets does this machine have at all*, ask the other one:

```bash
node tools/m59-fleets.mjs           # every roster here: slots, server, who is holding it
node tools/m59-fleets.mjs --json    # the same, for a launcher
```

A roster file **is** the credential store, so "the fleets with local credentials" is
exactly "the roster files under `substrate/`". It lists every one of them — named and
unnamed — with its slot names, the game server all its credentials agree on, whether a
broker is holding it and on which loopback HTTP port, and whether it is eligible for
local control. It never prints an account, a password or a character name, and it never
starts a broker. A broker is matched to a roster by the **state path** that broker's own
`/health` reports, never by fleet label: two checkouts can each hold a fleet called
`prod` and they are not the same characters.

`maps/m59-boswars`'s commander client is the first consumer — its main menu offers what
this reports rather than only what somebody typed on a command line.

## Running the broker as a service

```bash
node tools/m59-service.mjs start   --fleet prod     # detached, survives this terminal
node tools/m59-service.mjs status  --fleet prod     # up/down, pid, how many are in game
node tools/m59-service.mjs restart --fleet prod
node tools/m59-service.mjs stop    --fleet prod
node tools/m59-service.mjs logs    --fleet prod --follow
```

**Start it this way rather than by hand.** A broker started from a terminal belongs to
that terminal. One was found running with its whole ancestry dead — it had survived only
because Windows does not cascade-kill children — while its log went to a temp directory
that gets cleaned up. This gives it a pid file, a log in `substrate/broker-<fleet>.log`,
and a stop that finds it by `/health` rather than by process name.

It does **not** survive a reboot. `start` is one command; a Windows service would have
meant a third-party binary in a repository where every other tool is dependency-free.

**Every keeper is a child process of the broker** — `m59-keeper-process.mjs`, one per
character, each holding its own socket, on this fleet's port band (`substrate/keeper-bands.json`).
**Corrected 2026-08-27:** this line used to say every keeper ran *inside* the broker, and code
was written against that claim — the fleet-mate check's roster fallback was installed only in
the broker process, so inside every keeper it called the whole fleet strangers
(see [`docs/m59-keeper.md`](docs/m59-keeper.md#a-keeper-process-called-its-own-fleet-strangers)).
Two consequences: stopping the broker does **not** necessarily stop them, and a keeper
picks up new code only when it is itself restarted (`POST /stop` on its port; the 45s sweep
respawns it from the roster on disk). New fleet/account claims guard each exact keeper PID
before login. A broker restarting the exact same roster may atomically adopt verified
guarded survivors; a lab or copied/alias roster cannot. Claims predating keeper guards fail
closed and use the one-time `M59_ALLOW_UNGUARDED_TAKEOVER=1` migration in
[`docs/INSTALL.md`](docs/INSTALL.md#when-it-does-not-work), never lock deletion.

Everything else about running it — the loopback-only buttons on the fleet page, the
piloted-client check it does before logging anybody in, why the roster never shrinks by
accident, and the 45s rejoin sweep and the three things it will not do — is in
[`docs/m59-operations.md`](docs/m59-operations.md).

## The two front ends

```bash
./m59.sh                 # the fleet terminal (m59.ps1 on Windows)
./m59.sh up              # broker + field command page, for this checkout's fleet
./m59.sh status          # both of them, and which fleet
./m59.sh down            # both of them again
./m59.sh field           # just open the page
```

`npm run terminal|start|stop|status|field` are the same commands. **Nothing lives in
these scripts** — every behaviour is in `tools/`, so prefer changing the tool. `m59-tui.mjs`
is a list and a keyboard; **`maps/m59-strategy-game` is a map in a browser**, a separate
repository that may not be here, and a web page failing to build **never blocks the
broker**. [`docs/m59-operations.md`](docs/m59-operations.md) has the lifecycle rules.

## The collision map is EVIDENCE ABOUT A SERVER, NEVER AUTHORITY OVER ONE

`substrate/m59-map.json` carries baked BSP, sidedefs, sector heights and wall chains, and
the broker validates every in-room move against them with the same rules the stock client
uses — because the server accepts whatever coordinates you send and expects the CLIENT to
enforce collision. Using the server as a collision oracle is how bots walked through walls.
**A move that cannot be validated is refused, not retried**; `TERMINAL_MOVEMENT_REASONS`
in `m59-movement.mjs` is the closed list of failures no other heading can fix, and they
propagate instead of looping, which is what stops a bad route being learned.

```bash
node tools/setup.mjs routes        # bake the routing table; `all` runs this, before the broker
node tools/setup.mjs doctor        # says whether the table on disk carries masks
node tools/m59-routes.mjs          # what is baked, and whether it matches the map
```

**Read [`docs/m59-routing.md`](docs/m59-routing.md) before changing any of it.** The five
things that will otherwise cost you a day: the router must plan on the map the mover
enforces (`moverStepLands`, not `stepAllowedByCollision`); an anchor belongs to a
DESTINATION and not to a direction, and getting that wrong does not fail, it arrives
somewhere else; a stale map is a warning rather than a refusal, on purpose; a safe spot is
a pocket the router frequently cannot plan out of, which is what breadcrumbs are for; and
**exits are not doors and are not 1:1** — a failed return trip is the normal case and is
not evidence of a one-way door.

## The reports, and the two questions people actually ask

```bash
node tools/m59-minimal.mjs         # six numbers: min/max/avg max health, kills per minute
node tools/m59-overhead.mjs        # worst first: travel + trade against fighting
```

Asked for a "minimal summary", run the first: the same request gives the same shape every
time, so two readings can be compared. **Kills come from the ledger, never from a keeper's
own tally** — `Autopilot.tally.kills` is emptied in the constructor and keepers restart
constantly. Asked who is not fighting, run the second, and **read the castings column
rather than the reagent pair**: castings are `min(elderberry, herbs) / 2`, so 3/94 is ONE
casting and reads as well stocked to anything that sums. Both are explained in
[`docs/m59-operations.md`](docs/m59-operations.md).

## Asked WHERE a room goes wrong, rather than how often

```bash
node tools/m59-roomview.mjs 599            # one self-contained HTML file for that room
node tools/m59-roomview.mjs "Cragged"      # by name; two rooms share that one, and it says so
node tools/m59-roomview.mjs --list         # every room with a baked route
node tools/m59-recordjam.mjs --room 108 --region 38,25-48,29   # a live jam, sampled for 5s, as a redacted fixture
```

**Asked to capture a traffic jam as a test case** — a line of rats in a one-square sewer
pipe, a doorway with a crowd in it — `m59-recordjam.mjs` reads the fleet's own keepers in
that room over loopback, unions what they see for a few seconds, keeps one line for
anything that stood still and a trace for anything that wiggled, redacts every player to
`player A…`/`stranger A…` so the file can be committed, and measures the fine floor under
the region off the BSP so a needle test has the corridor and not just the bodies.
`tools/fixtures/sewers-108-row27.json` is the first: six giant rats one per square centre
on row 27 of the Sewers of Barloque, columns 39–41 exactly one square wide, and two
characters oscillating in the gaps for seventy seconds. `tools/fixtures/spidertrap1.json`
is the second, built from a single snapshot rather than a run: a character crossing the
Cragged Mountains (578) south to north on a journey to Barloque, held for twenty minutes
at `r45c16` by a black spider at `r44c13` — boarding the baked line from the west anchor and
slipping at the same index every seventy seconds, aiming an undeclared fall two rows north
with the spider on the line and never taking it, vigor falling four a minute — with its
vitals, load and policy under `subject` and the ledger's own rows under `trap`. A jam
fixture records the bodies; `m59-recordjam-test.mjs` checks every one on disk is still
roles and not names.

"Ukgoth crossed 7 times out of 190" is true and tells you nothing about where. This draws
the room the way the mover sees it — the coarse grid, the BSP floor, the step degree, the
.roo walls — with the baked route, the packets the rail actually sends, the declared
fall-jumps and the tactics ledger's failures plotted on top of it. Hovering a square says
what every predicate thinks of it. **Its first run answered a question that had cost two
sessions**: square `r5c65` in Ukgoth is walkable, has seven of eight mover steps out and zero
refused approaches, and 84 boarding failures happen on it — so the geometry is not what is
refusing, and `no_ground_gained` is firing on a walk the map supports.

Everything it draws is read through the modules the broker moves on, never re-derived: a
debugging view that computes its own geometry is a second opinion about the map rather than
a look at the one in play. It reports the step-mask count for the same reason — without
masks the picture is of a map the fleet is not walking on.

**It never writes a character name.** The ledgers it reads are full of them, including
inside the game's own sentences (`### <agent> was just killed by a groundworm`), so every
string it embeds is redacted against this machine's rosters. `/substrate/roomviews/` is
gitignored: the pages are derived, and regenerating one is a second.

## Backing the fleet up, DM powers, and a scenario in one file

```bash
node tools/m59-backup.mjs                 # every destination, everything
node tools/m59-backup.mjs --credentials-only    # just the irreplaceable part, seconds
node tools/m59-restore.mjs --latest       # says what it WOULD do, changes nothing
node tools/m59-dm.mjs where TESTER Alpha  # names -> object ids, on a LOOPBACK server only
node tools/m59-testbed.mjs up scenarios/arena.json
```

The **rosters** are what is actually at risk: they are the only record of the account
passwords, there is no reset and no email on the account. **Restore is the dangerous
half** — a week-old roster is a smaller, valid-looking file that restores cleanly and
silently loses every account added since — so it plans by default, refuses while a broker
holds the fleet, and refuses a roster that would shrink. The DM tools **refuse a host that
is not loopback**: the maintenance port is unauthenticated and pointing it at `prod` is not
a configuration choice. Both are in [`docs/m59-operations.md`](docs/m59-operations.md),
along with why **object ids are not stable** and why **`UtilGoNearSquare` never says no**.

## Asked to shut down, stop the server, or "we're done for now"?

```bash
node tools/m59-shutdown.mjs
```

**Always this, never a bare `docker stop`.** blakserv installs no SIGTERM
handler, and `[Auto] SavePeriod` defaults to 180 minutes, so stopping the
container directly can silently throw away three hours of play.

This keeps **two** snapshots under `docker/data/checkpoints/`, then stops the
broker and the server:

- `<time>-standing` — the save already on disk when the shutdown was asked for,
  copied aside untouched.
- `<time>-checkpoint` — a fresh `save game` taken right then.

Both, because the fresh one is the one that can be bad: if the fleet just walked
into something, or a re-roll went wrong, or errands are half-finished, the
checkpoint faithfully preserves that mess and the standing save is what you
actually want back. Do not "tidy up" by keeping only one.

Useful variants: `--checkpoint` (snapshot, stop nothing), `--keep-server`
(stop the broker only), `--label "before the raid"`, `--list`, and
`--restore <id>`. Restoring refuses while the server is up, because a live
server would overwrite it at the next save.

Report where the checkpoints went. Do not delete old ones without being asked.

## Things to tell the user rather than work around

**Steam cannot be automated.** It will not install a game the user does not own,
and will not log in for them. If step 2 finds nothing, give them the link —
https://store.steampowered.com/app/893390/Meridian_59/ — and carry on. Do not
attempt to script a Steam login or download the client from anywhere else.

**The client is optional for a fleet.** Agents log in over the wire; no
`Meridian.exe` is involved. The client is for *watching* the fleet, for the
click-to-play shortcuts, and for the compendium's sprite art. If the user only
wants a fleet, a missing client is not a blocker and you should not present it as
one.

**Either server tree works.** `setup.mjs` clones `Meridian59/Meridian59`
(upstream) by default. `tpeppers/Meridian59-deck` is a public fork adding gamepad
and Steam Deck support; it works too, from `2c6d8091` onward. Someone who wants
it sets `M59_ROOT`. Do not switch trees to "fix" an unrelated problem.

**Docker's daemon is separate from its CLI.** `docker --version` succeeding does
not mean anything can be built. If the daemon is down, say so and ask the user to
start Docker Desktop; do not try to start it yourself unless they ask.

## Traps that will waste your time if you do not know them

One line each. **Every one of these has cost somebody a session**, and the sentence here
is only enough to make you go and read the entry — none of them is safe to act on from
the summary alone.

**Silence is the default failure mode of this game.** A merchant refusal is a sentence
spoken to the room, not an error on the wire. A guild command you lack the bit for sends
nothing at all. A skill you cannot learn is simply absent from the shop list. A malformed
character request is silently replaced with `3/1/4/1/5/9`. **No error has never meant
success here** — verify by reading the world back.

Wire, kod and the shape of a reply — [`docs/m59-protocol-traps.md`](docs/m59-protocol-traps.md):

- A `send` reply names its RECEIVER before its answer, so a bare `/OBJECT (\d+)/` reads the wrong number.
- Three messages refill a vital and only one of them clamps; `GainHealth` caps at TWICE the maximum.
- Max mana LOOKS stored and is recomputed on every login.
- `create automated` makes a character with zero in every attribute, for ever. Use `m59-makefleet.mjs`.
- What you CARRY and what you are WEARING are two different lists; `client.equipment()` is the only answer.
- Ability levels are PUSHED — read once and keep, and never search `statsById` by name.
- The weapon proficiencies are called "mace fighting", "fencing" and "wielding", not what you would guess.
- `emit(kind, data)` spreads `data` over the event, so a payload field called `kind` silently wins.
- Looking at a player is `UC_LOOK_PLAYER`, not `BP_LOOK`; a packet nobody parses looks exactly like one nobody sends.
- A description REPLACES the look text, clearing is not undoing, and the wire is Latin-1.
- `PF_*` is an ENUM, not a bitmask: `flags & PF.KILLER` is true for every Dungeon Master.
- The server's own safety flag already refuses ordinary players and allows murderers — leave it on.
- Self-defence needs a grudge AND a live flag AND the safety; the grudge book is fleet-wide and gitignored.
- A keeper PROCESS has to hold its own roster source, or it calls the whole fleet strangers — and a fleet-mate you turn red by hand is then shot by everyone with a false grudge. Statler, 2026-08-27.
- One or two of the five Underworld portals are unlit at any moment, not all of them, and an unlit one is silent.

Money, merchants and supply — [`docs/m59-economy.md`](docs/m59-economy.md):

- "Buys anything" is usually a ROBBERY. Skivlat takes what you hand him and gives nothing back; selling is an allowlist.
- A smith does not buy mushrooms, and offering him one is a successful call that returns a silence.
- Exactly two merchants hold a real inventory and can run out — of stock and of shelf space.
- A bank balance is prose, sent once; a withdrawal states the amount handed over, not the new balance. There is no bank in Barloque.
- A character that cannot RECEIVE is nearly always full — read `pack.percent` and `pack.binding`, not `carrying`.
- `trade` lies in both directions. Use `supply`, which verifies the receiver actually holds the goods.
- A hand-over that completes the handshake and moves nothing is usually a malformed id list, not a full pack — the test is the TAG, not whether there is more than one.
- A cursed weapon can never be put down: wielding one is the only irreversible mistake here.
- A loadout is an OVERLAY — silence means the behaviour that was already there, and a named want is not satisfied by the family.
- A guild want is an END STATE, not an errand, which is what makes it safe to give to twenty-one characters.
- Four containers, four different rules, and only the pack has two ceilings.
- A trip that cannot fix the thing that opened it will run for ever, and every lap reports success.

Keepers, deaths and the numbers on the board — [`docs/m59-keeper.md`](docs/m59-keeper.md):

- A postmortem knows WHAT killed a character and usually not WHERE. Nobody died in an inn.
- "Was the keeper up" is the wrong question: it usually was, and 81% of the time it was BLIND.
- The keeper is a long-await machine; the 500ms watchdog is the only thing watching during one, and it interrupts rather than decides.
- A counter that lives on the keeper is not a rate — keepers restart about once a minute.
- "You suddenly feel a little tougher." is the only announcement of the only thing this fleet is for.
- A keeper earning nothing looks exactly like a healthy one; that is what `yieldCheck` is for, and it was off for a year because `purpose` was missing from a schema.
- A character can be spoken for, and the board has to say so — ask `isTakeable(committed)`, never `!committed`.
- A broker that lost a keeper port guesses one and commands whoever is there; two fleets on a machine is the working limit.
- A wedge broken by a cancel is re-issued by the next pass with the SAME inputs — 589 breaks in 93 minutes, then 18 minutes dying on one square. The arm now counts breaks at a place, `travel()` sidesteps before re-planning and gives up out loud at five, and a hurt body that cannot move swings instead.

What to fight — [`docs/m59-combat.md`](docs/m59-combat.md):

- A creature's LEVEL is not how dangerous it is; `viDifficulty` is. A level-50 fungus beast is the safer fight.
- Faction soldiers are summoned by FLAGPOLES, are level 70–145 rather than 50, and are above the band for every character this fleet has ever had.
- Do not farm soldiers for armour — the spider and the orc are both better and both fightable.
- Heavy armour is worse here, but BARE is worse than all of it.
- The Graveyard of Tos generates nothing for 85 minutes in every two hours, and the clock is arithmetic on the wall clock.
- The engagement ceiling is a proportion with ONE home; `max_threat_over` is accepted and no longer consulted.

Movement — [`docs/m59-routing.md`](docs/m59-routing.md):

- **A COORDINATE NEEDS ITS SPACE AND AXIS ORDER.** MCP tools use named `col`/`row` fields, positional movement helpers use `(col,row)`, geometry/KOD grids use `(row,col)`, and the movement payload is serialized Y then X. Use `rNcM` or named fields in human-facing text and read [`docs/m59-coordinates.md`](docs/m59-coordinates.md) before changing a boundary; existing command and artifact encodings are compatibility contracts.
- **THE FINE GRID IS THE REALITY. A SQUARE IS A SUMMARY, AND ON INTERESTING GROUND IT IS A FALSE ONE.** Ask the coarse grid where the floor is and it answers per square; ask it about a ledge and it lies. `r40c52` in the Ancient Place is `walkable: true` with NO FLOOR AT ITS CENTRE — 21 of 49 sampled points inside it are standable and the middle is not one. `r38c30` is `walkable: false` and you jump onto it anyway, because the footing is a sliver. `r40c33` spans 3520 to 10880: the valley floor and the high ledge, one square, one number. Every movement decision that matters — where to stand, whether a step lands, whether a jump clears — has to be asked of the BSP at fine resolution. Three separate failures in one day came from forgetting it: a walker aimed at square centres stepped off the ledge after thirteen waypoints, a jump finder could not see `r40c33` → `r40c32` because both halves are one square, and a height profile read off single fine points swung ±7000 because one unit either side of a ledge edge is a different sector. Use squares to talk to humans and to index the bake; use fine coordinates when the rubber hits the road.
- A body in the way is not a wall and not a clearance — the client tests the move's ENDPOINT, lets you end inside the zone while moving away, and SLIDES. Two spiders 25 apart are passable; a clearance model says they are not.
- "One square wide" is a fact about the coarse grid. The .roo under Twisted Wood's one-wide corridor is 82–110 fine units, not 64.
- Melee reach is a disc of radius 2–3 SQUARES, and fine coordinates do not exist to it.
- A logoff ghost and an item on the ground have NO collision — `MOVEON_YES` on the wire — and a body list that counts any object reads a mushroom as a crowd that never leaves.
- A one-square pipe is TWO lanes: keep to the right wall for your own direction of travel and two characters pass; both aim at the centre line and they stall nose to nose. `keepRightAim`, always on.
- A journey's retreat may be the EXIT: crossing breaks every attack, so the onward square is a wall of `kind: 'exit'`, and the mending happens at the first wall on the far side.
- IN A CROWD THE ONLY WALL IS THE EXIT. 57 of 89 road deaths on one day were characters that had STOPPED at a "wall" in a room of 9–18 monsters and stood there for minutes; the divert rule sent them there at the first scratch. At or above `travelStopMaxThreats` (6) a journey makes no stops and a retreat considers only the exit. And a wall we can walk back from is always eligible — "reaches the exit" is an addition, never the gate; redefining it as the gate told a character in the Cragged Mountains there were no walls.
- A safe wall is the two grids disagreeing — measurable, dose-responsive, and the same fact that fragments the routing view.
- A planned trip accepts the risk of a FIGHT — but no longer of a death. **Corrected 2026-08-21:** this line used to read "the way out of an attack during travel is always THROUGH", and a journey held the keeper inert to enforce it. That is how Cccc was walked out of a sanctuary at 27% health and eaten in twenty-two seconds. Walking through is still the answer to being *hit*; it is not the answer to being below the flee line, or to losing health faster than the road ends. See `travel_guard`.
- `ms_since_moved` is about the KEEPER, not the character, and reads as a stall during every errand.
- A stall detector that requires STILLNESS misses the commonest way to stand still: a two-square shuffle against a wall resets it on every sample. Ask the damage rate instead.
- A keeper whose event loop is BLOCKED is silent, and the server logs it out at 30 s. The keeper profiles itself: a `loop_stall` row carries `hot:` and `callers:`, and the callers half is the cause. The needle solver is on a 400 ms clock (`M59_NEEDLE_MS`) because it was 29 s in a crowded room.
- `start_has_no_floor` usually means the position and the geometry are from DIFFERENT ROOMS, not that the map has a hole — 1,535 of 2,361 hop failures in one window, mostly leaving a 10x13 room with every square walkable. It is `position_outside_room_geometry` when the coordinates are off the map.

Boards, the compendium and the planner — [`docs/m59-boards.md`](docs/m59-boards.md):

- Six boards share one tab bar in `m59-page-chrome.mjs`; a seventh written by hand is invisible from whichever copy nobody edited.
- A bank balance leaves a trace and a purse does not, so a column of dashes means no sample, not a broke fleet.
- The planner is the only page that can WRITE, and it shares its stat pane with the `/stats` board rather than copying it.

Guilds — [`docs/m59-guilds.md`](docs/m59-guilds.md):

- A guild command you lack the bit for is refused by TOTAL SILENCE. Check the bitmask the server handed you, before the send.
- Lieutenant is capped at 2 and lord is uncapped, so spread to lord; the refusal goes to the promoter and is invisible from the member's side.
- An invitation is an object in the invitee's pack that dies if either of them walks, and an inviter may hold only one.

## ANY ORDER YOU GIVE THE FLEET GOES THROUGH FLEETSCRIPT. Do not write a script.

```bash
node tools/fleetscripts/come-home.mjs          # the shape: declare the errand, run it
node tools/m59-fleetscript-test.mjs            # 72, offline
```

Move some characters, buy something, fetch somebody out of a hole — **declare it as a
`fleetScript` and let it compile the safeties in.** Not because a hand-written script
cannot work, but because the record is that it does not: five ad-hoc scripts drove this
fleet in one day and each got a *different* subset of the same mandatory concerns wrong.

The point is not that the traps are undocumented. **They are all documented, in this file,
and they were still walked into** — a rule you have to remember is a rule you forget at
02:00 with a character dying. So they live in
[`tools/m59-fleetscript.mjs`](tools/m59-fleetscript.mjs) as guarantees that **refuse before
anything walks**: one driver per fleet, the body held, a health floor on every journey,
waits sized from the journey's own p90, travel issued once and never re-issued while
walking, results read back from the world, the bot's lease taken, and a known trap room
refused outright.

**Two of those are the ones a hand-written script always misses.**

- **`busy` does not stop the keeper, and it does not stop a bot.** `busy` is broker-side.
  The thing holding the socket is the keeper process, and a DUM bot re-decides about every
  thirty seconds — so an order given without a lease is quietly overwritten and you watch
  a character do the opposite of what you asked while every call reports success.
  `commander_claim` takes work, movement and economy off the keeper and leaves identity,
  mortality, survival and recovery with it. FleetScript does this for every agent.

- **A claim takes the FACULTIES, not the BODY.** A journey already in flight is a *job*,
  and it keeps running through a successful claim: every travel you then issue comes back
  `"<agent> is busy: walk to …"`. Measured 2026-09-04 — three characters stranded in
  Ukgoth, the claim granting movement every eight seconds for six minutes, all three still
  walking the castle patrol's route. `holdKeeper` now cancels the journey right after
  claiming, and that single call was the difference between "refused: is busy" every round
  and all three accepting the new destination.

**When a fleet operation goes wrong for a reason this file already covered, the fix is a
new guarantee in `m59-fleetscript.mjs`, not another paragraph here.** That is the entry
criterion for the list: every guarantee in it is a mistake somebody made twice. Add the
check, add its test, and name the incident in the comment — a refusal that cannot say why
it fired gets deleted by the next person in a hurry.

`KNOWN_TRAPS` is the same idea for geography. A collision map cannot see a lock, so a room
that cannot be left by any route the bake knows is learned by stranding somebody in it —
room 599 (Ukgoth) is the first entry, and `{ allowTraps: true }` is how a rescue says out
loud that it is going in on purpose.

## Rules that have no exceptions

- **Attach to the broker, do not spawn a second one.** `m59-broker.mjs` with no
  arguments serves stdio MCP *and* resumes a fleet. With one already running,
  the second owner is refused before its listener opens and exits with status 3;
  it does not attach to the running process. `.mcp.json` points at
  `m59-mcp-attach.mjs`, which forwards to an existing broker and holds no state.
  Keep it that way.

- **Never call the `leave` tool** on a fleet anyone cares about. It drops the
  roster, and the roster is the only record of the account passwords.

- **`substrate/fleet-accounts.json` is the only copy of the passwords** for
  characters `m59-makefleet.mjs` created. It is gitignored. Never commit it,
  never print its contents into a shared transcript, and never delete it.

- **`[Channel] Flush` defaults to `No`**, and with it off every server log stays
  at 0 bytes for ever. This looks exactly like a hook not firing. The container
  turns it on; a native build may not have.

- **Hunt bands are scaled by level, and the ceiling is not a safety net.**
  `floor(level/2)` when armed, `floor(level/4)` when unarmed. Ceiling = level + band.
  A lv21 character has ceiling 31, so lv30 giant rats are "in band" — but they are
  still too tough, and each death drops max HP by 1–2, starting a death spiral.
  Baby spiders (lv25) in the Deep Woods (rooms 534, 535, 545, 554, 568, 574, 575,
  593, 603) are the safe target for lv20–24. Giant rats (lv30) in the Sewers
  (room 377/600) are the target for lv25+. `nearestHuntRoom` uses the engagement
  ceiling, so a character in the Sewers sees giant rats as in-band even when
  over-level. If a character is losing HP over successive passes, route them to
  a weaker-mob room or an inn — do not raise the ceiling. See
  `docs/GOAP-HANDOFF.md` § "Scaled hunt bands" for the full table.

## LENDING CHARACTERS OVER THE INTERNET WITHOUT LENDING THE PASSWORD

There is no resume verb and no transferable session — `SynchedAcceptLogin` is the whole of
authentication and re-checks the password on every TCP connect, and the MD5 on the wire IS
the credential. So what moves is **authority**: the broker stays here holding the roster
and the sockets, and somebody else drives part of it through a door that can be shut.

```bash
node tools/m59-handoff.mjs mint --to "a guildmate" --agents t1,t2 --for 4h   # owner
node tools/m59-lend.mjs --port 8931                                          # owner, behind a tunnel
node tools/m59-mcp-attach.mjs --host <tunnel> --port 8931 --token m59g_...   # borrower
```

**A grant is FULL CONTROL by default** (`--safe` withholds the irreversible verbs), the
token is never stored, `fleet` comes back filtered to the granted characters, and
**there is no TLS** — put it behind a VPN or an SSH tunnel.
[`docs/m59-operations.md`](docs/m59-operations.md) has the argument for each of those.

## A number that is this checkout's opinion does not belong in git

`fight_above_vigor: 180` was two claims wearing one coat: a **mechanic** (resting stops
awarding vigor at 80 of 200, so everything above it has to be EATEN, and `create food`
costs 2 elderberry **and** 2 herbs) and a **bet** about whether this fleet's apothecary run
is keeping twenty-one characters fed. The mechanic is this repository's and stays committed
with its citation. The bet is this machine's and lives in gitignored local files.

```bash
node tools/m59-localpolicy.mjs --explain    # the overridable surface, and the mechanics behind each key
node tools/m59-profiles.mjs --room 70       # where the fleet is ALLOWED to be, and who is held back
node tools/m59-tuning.mjs --explain         # tactics, changed live, no restart
```

A fourth surface obeys the same rules and is not a number: **`travel_guard`**, what a
journey may interrupt itself for. All six faculties default ON, an unrecognised one is
refused, and `autopilot action=status` reports the effective guard whether or not anything
is travelling — because "what will this character do if something sends it across the
world" is a question that has to be answerable BEFORE the post-mortem.

All three obey the same four rules, and [`docs/m59-policy.md`](docs/m59-policy.md) argues
each of them: **silence means the behaviour that was already there, never an empty policy**;
a file that will not parse **is not an empty file** and says so; an unusable value keeps the
committed one rather than unsetting it; and an unrecognised key is **reported**, never
applied and never dropped — because a setting that silently does nothing is how `purpose`
stayed out of a schema for a year with every keeper's audit switched off.

`m59-tuning.mjs` is **not** `m59-tactics.mjs` — that one is the append-only ledger of which
walker tactic fired and whether it worked. This file was once written straight over it,
which took the broker down.

### AND NEITHER DO ORDERS. THE TOOLS ARE SHARED; THE FLEET IS NOT.

The same argument runs past thresholds. **A loadout, a tuning line, a guild plan and a
playbook are not descriptions of a character, they are INSTRUCTIONS TO ONE**, and an
instruction that arrives from somebody else's afternoon is obeyed silently — a file that
parses is a file the keeper acts on. So everything that tells a character what to do lives
on the machine that owns the roster, and git carries the SHAPE instead:

| this machine's | the shape, committed |
|---|---|
| `substrate/loadouts/<character>.json` | `substrate/loadouts.example.json` |
| `substrate/tuning.json` | `substrate/tuning.example.json` |
| `substrate/guild-plan.json` | `substrate/guild-plan.example.json` |
| `substrate/policy.local.json` | `node tools/m59-localpolicy.mjs --example` |
| `substrate/playbooks/`, `substrate/goap-goals.json` | `substrate/goap-goals.example.json` |
| `substrate/fleet-default`, `substrate/gy-cycle.json`, `substrate/overhead-last.json` | — one machine's answer; regenerate or re-anchor |

`.gitignore` carries the argument for each. **An example file goes BESIDE the directory the
tools enumerate, never inside it** — `listLoadouts()` reads every `.json` in
`substrate/loadouts/`, so an example in there is an extra character on the board.

A fresh clone therefore gets every tool for running a fleet and no orders for ours, which
is the only arrangement in which two people can both use this repository.

## Working in this repository

- **A claim that contradicts what is already written down needs a reproduction before
  anything is decided on it.** The bar is two things at once: the claim cuts against this
  file, the kod or the extracted indexes, **and** something is about to be decided on it.
  Then measure the thing that must change if the claim is true — the purse before and after
  each call, not the wording of one response — and **repeat the call**, because "it stopped
  after one" and "I only asked once" produce identical evidence. The worked example, and
  why prod cannot answer this kind of question at all (the fleet is being driven, so the
  subject walks away mid-experiment), is in
  [`docs/m59-economy.md`](docs/m59-economy.md#the-reproduction-that-settled-it).

- **A COMMIT THAT CHANGES HOW THE FLEET MOVES CARRIES `#movement` IN ITS MESSAGE.** The
  ledgers are keyed on that tag, so evidence recorded before it resets rather than being
  averaged in for ever. What it cost to not have this: Ukgoth's north door read
  `refused 182, crossings 0` — a boundary never once crossed — on a day it was crossing in
  three seconds six times out of six, and the tactics ledger answered "27% of crossings ride
  a rail" over five days against 48.5% over the last ninety minutes, because a third of the
  file was a bug fixed days earlier. **A counter that cannot come down is not a measurement,
  it is a monument.** No clock fixes that — a fortnight of quiet evidence is still good and
  four-hour-old evidence is worthless if the mover was rewritten in between; the clock does
  not know what changed and the commit does. Uncommitted movement code is its own epoch, so
  the half nobody has to remember works on its own. `node tools/m59-epoch.mjs` says which
  epoch is in play and which commit declared it; the standard, and how to add a domain, is
  in [`docs/m59-evidence.md`](docs/m59-evidence.md).

- **The private server is on `127.0.0.1:15959`, not 5959.** It is a native Windows
  `blakserv.exe`, its admin port moves with it (19998), and `docker ps` reports nothing
  because there is no container. A bare port check against 5959 returns `ECONNREFUSED`
  and reads exactly like "the server is down" — which is what the parent repository's
  notes still say, and it is wrong. Check the listening port of the running process
  before concluding anything is down.

- Every tool in `tools/` is standalone `.mjs`, zero dependencies, run with
  `node tools/<name>.mjs`. Only the chat responder needs `npm install`.
- `M59_ROOT` points at the Meridian 59 source tree. The compendium's citations
  and the Python analysis scripts both read it.
- **The offline tests are safe to run any time** — they open no socket and touch no
  roster. `node tools/m59-safespot-test.mjs`, `m59-which-test` (the gate that decides
  which fleet everything else acts on), `m59-chat-test`, `m59-collision-test`,
  `m59-routing-test`, `m59-impossible-test`, `m59-guild-test`, `m59-loadout-test`,
  `m59-supply-test` (the two-sided hand-over, against fakes of both kinds of session) and two
  dozen more; [`docs/m59-tests.md`](docs/m59-tests.md) lists every one with its assertion
  count and **what it pins**, which is the part worth reading before you change the code it
  guards. The rest need a live server — `m59-autopilot-test`, `m59-skills-test` and
  `m59-coop-test` want a broker on 8899 and fail with `ECONNREFUSED` without one, which is
  not a regression.
- **Do not `import` `m59-broker.mjs` to check it.** Importing runs it: it tries to
  take the fleet lock and start rejoin timers. `node --check tools/m59-broker.mjs`
  is the syntax check. `m59-supervise.mjs` had the same problem and now guards its
  main loop on being the entry point, so it can be imported for its pure helpers.
- The compendium's sprites are not committed. `python tools/pull-client-assets.py`
  decodes them from a local client. Do not commit `compendium/assets/img/`.
- Do not commit anything a running fleet writes — `fleet-state.json`,
  `history/`, `recordings/`, `commissions/`. The `.gitignore` already covers
  them; do not add exceptions.
