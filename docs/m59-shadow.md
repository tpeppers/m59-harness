# The shadow fleet — rehearsing an errand on a copy of production

## THE FAST CLONE — prod onto the lab in seconds (`m59-shadow-clone.mjs`, TUI key `Z`)

```bash
node tools/m59-shadow-clone.mjs            # export prod's caches, re-dress every shadow, relog them
node tools/m59-shadow-clone.mjs export     # just the snapshot (read-only)
node tools/m59-shadow-clone.mjs dress      # re-dress from the snapshot on disk
node tools/m59-shadow-clone.mjs --json     # last line is a JSON report: timings, who could not log in
```

In the terminal (`m59-tui.mjs`), **`Z`** runs it and then launches the client as the clone of the
character under the cursor, on the lab server. Measured 2026-10-29 against the live 24-character
prod fleet:

| | hot (shadow broker already up) | cold (no shadow broker) |
|---|---|---|
| export from prod caches | 0.1 s | 0.1 s |
| log the clones out | 0.05 s | — |
| stats, karma, vitals, faction, 331 abilities, ~100 items, guild/hall/chests, login pose — written and read back | 0.3 s | 0.3 s |
| log them back in | 2.8 s (staggered relog) | 55–75 s (broker boot + 24 keeper processes at below-normal priority) |
| **total** | **3.3 s** | **~75 s, once** |

`m59-shadow-run.mjs` took about ten minutes, and almost none of it was cloning: ~120 sequential
broker calls to snapshot, a full login + reroll per character to create, 24 keeper processes six
at a time to play, then a settle. The fast clone does only the cloning:

- **Export from caches, not the wire.** Every prod keeper's `GET /state` answers from cache in ~2 ms
  with attributes, karma, vitals, room and fine position, the pack with amounts and grades, and what is
  worn. Abilities come from the keeper's ability book (`substrate/abilities/`), faction from
  `substrate/faction-status/`, chests from `substrate/storage/`, base attributes from the sheet (the
  keeper's stat group is AFTER gear — Clifford reads might 53 against a cap of 50). Guild roster and
  rank come from the last live snapshot: they are in no cache. Nothing is asked of the prod broker.
- **Never re-create a body; rewrite it.** The DM socket does 2000 commands in 130 ms, so every concern
  is one fleet-wide batch plus a read-back. A body missing from the lab is reported, not made — that is
  still `m59-shadow-run.mjs --until build`, once.
- **Never restart a keeper; relog it.** Hot path: `/leave` each keeper, `hangup user` each body (see the
  two traps below), dress offline, `/join` each keeper 60 ms apart. Cold path: dress offline, then start
  the broker from the **prod checkout** so the clones run prod's code, every keeper spawned at once.
- **A clone is exact by default.** Items prod does not carry are deleted (`--keep-surplus` keeps them).
  Soldier-shield RANK is not observable; clones get the default.
- **A clone starts with its original's ORDERS** — the roster's mode and policy and the character's
  loadout file — with every prod agent or character named in them rewritten to its clone, whole strings
  only. Cold: written into the shadow roster before the broker starts. Hot: pushed to each keeper while it
  is logged out with `/policy {replace: true}`, a keeper route added for this (an older keeper, which does
  not advertise `policy_replace` on `/live`, gets a merge and the clone says so). `--keep-orders` skips it.
  Then change the orders under test through the shadow broker (8971).
- **Every shadow account's password is `shadow`.** They are throwaway lab accounts. The first clone that
  finds a slot off it stops the shadow broker, runs `set account password <id> shadow` (the numeric id —
  the name is refused, which is probably why an older note here said the command did not work), rewrites
  the roster (backup `.before-fixed-password`), `save game`, and cold-starts.
- **Unidentified scrolls, wands and potions are made by ICON.** The wire's `icon_rsc` names the class
  exactly when a leaf class owns that icon (`m59-item-signature.mjs`): prod's bare scrolls are
  DiscordScrolls. An icon on a class with subclasses (prod's potion, 30298, is the base `Potion`'s and
  29 potions share it) is non-specific and is not copied.

Traps found building it, each now handled in the tool and pinned in `m59-shadow-clone-test.mjs`:

- **`M59Client` had no `close()`.** Every keeper path that logs off — `/leave`, `/rejoin`, dormancy,
  `/stop`, SIGTERM — called it inside `try {} catch {}`, so nothing was ever logged off: the keeper said
  `in_game: false` while the server held `pbLogged_on = 1`. Fixed in `m59-client.mjs`; a running keeper
  gets it only on restart, which is why the clone also hangs up server-side.
- **`hangup user` blocks the caller's IP for five minutes** (`SOCKET_BLOCK_TIME`, adminfn.c:4200), and
  every keeper and client here is 127.0.0.1 — the whole lab went dark. `hangup ip` is a TOGGLE: it lifts
  an existing block and adds a *permanent* one when there is none, so it is sent only after a hangup
  reported a disconnect.
- **blakserv listens with a backlog of five** (async.c:143). 24 simultaneous logins get ECONNREFUSED
  from a perfectly healthy server; hence the 60 ms stagger and the retry.
- **Phantom shields.** A soldier shield deletes itself when `ReqUse` finds its owner in another
  faction, and `Delete` clears `poOwner` without leaving the holder's list. Every shield the old,
  faction-blind dress tried to put on became an ownerless list node that the planner counted as
  carried. Listed-but-not-owned items are now detached and deleted, and faction is set before gear.
- **A shield takes the weapon off** (`FreeHandSlotsFor`); wearing is re-asked until it sticks.
- **A roster password the lab does not hold looks like a slow login.** The clone checks each roster
  password's MD5 against the lab's own `savegame/accounts.*` and names the slots that cannot log in.
  On 2026-10-29 seven shadow slots (04, 08–13) carried passwords that never reached the lab; the
  matching ones were in a September roster.


Held-item trimming must detach the item with `Holder.LeaveHold` before
calling its `Delete` message. `Delete` alone leaves a stale inventory node
and cached load behind (`kod/object/active/holder.kod:392`). A later clone can
then appear to carry duplicate army shields, including an item with no owner;
the jungle refill cannot drop that phantom item. `deleteHeldCmds` is the shared
construction primitive, while unheld failed creations still use bare deletion.
Read back the resulting pack before treating a dressed clone as a valid trial.

A **shadow fleet** is a disposable copy of production's characters standing on the loopback
test server: same attributes, same max health, same gear, same abilities, different bodies.
It exists so that "will twenty-three live characters survive this errand" stops being a
question anybody answers by running it on production.

```bash
node tools/m59-shadow-run.mjs farm-loop-test          # build a fresh copy, then run the script
node tools/m59-shadow-run.mjs farm-loop-test --dry    # say what it would do, touch nothing
node tools/m59-shadow-run.mjs --list                  # what can be run, pads included
node tools/m59-shadow-run.mjs farm-loop-test --from run    # the fleet is up; just run it again
node tools/m59-shadow-run.mjs farm-loop-test --no-items --no-guild   # skip the pack/gear and the guild
```

`m59-shadow-run.mjs` is the whole bring-up in one command — the **FleetScript shim**. The
five stages below all existed already; what did not exist was a command that did them in the
right order with the right flags, and refused the arrangements that silently do not work.

| stage | what it does |
|---|---|
| `preflight` | prod is readable, the test server is up, the maintenance socket answers, and the fleet about to be written is **not** prod |
| `snapshot` | read production **read-only**: names, attributes, max health, gear, abilities |
| `build` | a *construction* broker, then `create`, then `dress` |
| `play` | swap to an ordinary broker and wait for the characters to reach the world |
| `run` | compile the named FleetScript and drive the shadow fleet with it |

`--from <stage>` starts partway in, which is what you want while iterating on a script: the
fleet is already standing there and rebuilding it costs ten minutes for nothing.

## A SHADOW FLEET IS A REUSABLE TEST COPY, AND THAT IS NOW TRUE OF THE CODE

Operator, 2026-09-16: *"You can always clone a new shadow fleet, they're meant to be reusable
test copies from prod."* That was the intent from the beginning and the code did not honour
it — **the second build of a shadow fleet was impossible**, for two reasons that both
presented as something else.

**`create` skipped an account that already existed, permanently.** Making a shadow has two
halves that go to two different servers: the account is made over the maintenance socket, and
the character is made by `reroll` *through the broker*. Interrupt it between the two — or let
the broker be pointed somewhere else — and you get an account holding the server's own
placeholder character, `User394556136`. On the next run that account `already exists`, so it
was skipped, and skipping was for ever. The fleet sat as twenty-three accounts whose keepers
logged in perfectly and were refused by their own identity check with `expected Aaaa, got
User394556136`. `create` now **resumes** such an account and leaves a correct one completely
alone, which is the only case skipping was ever protecting.

**And the broker held its own door shut.** See the next section.

## A BROKER THAT IS BUILDING A FLEET MUST NOT BE PLAYING IT

The broker resumes its roster at startup and spawns one keeper process per entry, and **each
keeper takes that account's single allowed connection**. `reroll` has to log into the same
account to send `BP_NEW_CHARINFO`, so it can never get in, and the 45-second rejoin sweep puts
the keepers back for as long as the rebuild lasts.

This only bites the **second** time. The first shadow fleet is built against an empty roster,
which spawns no keepers and works perfectly — so it reads as "creation is broken now" rather
than "creation is holding its own door shut". Twenty-three characters reported `NOT CREATED —
no character came back` while the broker log showed nothing but its own keepers being refused
for holding the wrong character.

`--no-resume` and `--no-rejoin` both already existed on the broker and **neither was reachable
through `m59-service.mjs`**, which is the only supported way to start one. Both are now passed
through, and `build` uses them:

```bash
node tools/m59-service.mjs start --fleet shadow --http 8971 --dashboard 8972 \
     --no-resume --no-rejoin            # a construction broker: holds the roster, plays nobody
```

## THE FOUR THINGS THAT GO WRONG, AND WHAT THEY LOOK LIKE

**1. The game server must be named explicitly, always.** A broker with no roster to read falls
back to its own default, `127.0.0.1:5959` — a **different server**. It says so in its log, in
one line, among thousands: *"game server 127.0.0.1:5959 (this process's default; the roster
names none)"*. Characters were created there for an hour while the failure was read as a
broken world, a stale roster and a lost account in turn. The shim sets `M59_HOST`/`M59_PORT`
on every broker it starts and checks the port is listening in `preflight`.

**2. Stopping a broker takes BOTH ports.** `m59-service.mjs stop` quiesces via the
**dashboard** port, which has an independent default — so `stop --http 8971` finds the right
pid and sends the shutdown to 8902, which on this machine is production's dashboard. That took
prod down for twenty-five minutes on 2026-09-16, and nothing could have caught it because the
dashboard's `/health` carried no identity. Pass both ports on every stop.

**3. Naming the fleet is not enough — `M59_CONTROL_URL` decides who gets the orders.** It
defaults to **8901**, the production broker. A run correctly labelled `shadow`, with shadow's
roster and shadow's agents, will address twenty-three live production characters. The shim's
own first run did exactly that and was stopped by `fleetScript`'s identity check:

> `farm-loop-test (pad): WRONG BROKER. You named fleet "shadow" (…shadow.json) but
> http://127.0.0.1:8901/ is holding …prod.json. A fleet is its ROSTER FILE and never its name.`

That guard is the only thing that stood between the shim and the incident it exists to
prevent. **A fleet is its roster file and never its name** — the same rule `m59-which.mjs`
enforces, arriving through a different door.

**4. The 45-point ability budget cannot be spent exactly by any all-level-1 loadout.**
Abilities cost 10 at level 1 and 25 above it against a budget of 45, so the only exact spend
is two level-1 plus one level-2. `selfSufficient` is four level-1 spells — 40 of 45 — and the
`fullBudget` guarantee refused it for ever, while the error's own advice ("add another level-1
spell or skill") reaches 50 and is refused the other way. `reroll` never forwarded `unsafe`,
so the waiver `m59-newchar.mjs` defines could not be reached through the only tool that
creates characters. It is forwarded now, and `m59-shadow.mjs` waives `fullBudget` with a
reason: for a shadow, creation is **scaffolding** — `dress` grants every ability at the number
prod actually has immediately afterwards.

## IN GAME IS NOT THE SAME AS AVAILABLE — a new fleet goes shopping first

**A freshly dressed shadow has no reagents.** It is minutes old, its loadout carries the same
reagent floor as everybody else's, and that floor lives in the LOADOUT rather than the policy
— so `buy_reagents: false` does not stop it. The first thing twenty-three keepers do on login
is therefore set off for the apothecary, all of them, together.

Stage `play` originally waited only for characters to be **in game**. They were: walking to a
shop. The errand then started into a fleet that was already busy, and **a claim takes the
faculties, not the body** — a journey or town trip already in flight is a *job* and keeps
running through a successful claim.

Measured 2026-09-16, the first full run of the shim: **ten of twenty-three characters
completed a reagent town trip during the run** — about sixty purchases each, elderberry and
herb from Joguer, `"the posted shopping list, funded before purchase"` — standing in room 104
with `committed: -`, while the other thirteen walked the circuit normally. The first purchase
is timestamped **seven minutes before the script started**. Nothing was stalled, nothing was
refused, no character was hurt: half the fleet simply had other plans.

**The detector cannot be a list of busy-sounding verbs, and this is the part worth reading.**
A character standing at Joguer's counter working through a sixty-item shopping list reports
`activity: "waiting"` — identical to an idle one. Matching `activity` against
`travel|buy|shop|…` declares the fleet quiet on the first poll and changes nothing. So stage
`play` fingerprints what MOVES instead — each character's `room_num` and its
`town_service_at`, which advances across a town trip — and calls the fleet settled when
nothing has changed for `--quiet-s` (45s default). It needs no verb list and no knowledge of
the keeper's policy, so a keeper errand nobody has thought of still reads as activity.

`--no-settle` races the keepers deliberately; `--settle-m` bounds the wait. A timeout goes
ahead anyway and **says so**, because the old behaviour drove thirteen of twenty-three
perfectly well — what was missing was anybody saying why the other ten ignored the errand.

**The deeper fix is now in `dress` (2026-09-24):** prod characters *have* reagents, so a
shadow that starts with none is a less faithful mirror, not a more neutral one. `dress` copies
the whole pack, reagents included, so a fresh clone should no longer need the shopping trip —
but the settle stays, because a keeper can still find another errand of its own.

## A SHADOW WITHOUT SKILLS ANSWERS THE WRONG QUESTION

Until 2026-09-16 `dress` copied attributes, max health, position and equipment but never
abilities, so every shadow was a level-60 body with no weapon proficiency. Operator: *"it
makes a difference if they're dying because they're stuck and can't leave or if they're dying
because they have no combat skills."* That was the confound, and it inverted every survival
result: a shadow death told you about the road and the geometry and nothing about the fight.

`dress` now grants each recorded ability at the number prod actually has, over the maintenance
socket. `--no-skills` goes back to a bare body **deliberately**, which is the right tool for
isolating a geometry question, and the run says which it did.

## WHAT A CLONE SHOULD CARRY — items, abilities, guild

Operator, 2026-09-16: the default clone should be *"a copy of prod including items (like exact
state)"*, and should pull *"skills/spell/guild (& hall) … so Shadow clones can cast rescue"*.
Three parts, in different states:

| | state |
|---|---|
| **abilities** (skills + spells) | **done.** `dress` grants each at the number prod actually has — 317 across 22 characters on the first run. `--no-skills` opts out deliberately |
| **items** | **done 2026-09-24.** Every pack row by kod class and amount, the purse, the chalice; worn gear put on. `--no-items` opts out, `--trim-items` also deletes what prod does not carry |
| **guild and hall** | **done 2026-09-24.** Prod's guild founded on the lab, every shadow member at prod's rank, hall 714 claimed, its three chests filled to prod's cached contents. `--no-guild` opts out |

**Until 2026-09-24 the "items: done" row above was false.** The doc said `dress` recreated the
recorded pack and that `--no-items` opted out; no copy of `m59-shadow.mjs` on disk had either.
`dress` created only the wielded weapon — and created it on EVERY run, because it asked the
construction broker (which plays nobody) for `inventory`, got nothing, and concluded nobody was
armed. The snapshot's `equipment` list was always empty too: it read `eq.worn`, and the
`equipment` tool answers `equipped`. The live shadow fleet that day held 3,769 shillings
against prod's 57,244 and no chalice at all.

## FULL FIDELITY — what `dress` now copies, and how

The decisions live in [`tools/m59-shadow-fidelity.mjs`](../tools/m59-shadow-fidelity.mjs), which
is committed and pure; `m59-shadow-fidelity-test.mjs` pins the replies it reads, the classes it
picks and the exact maintenance-socket commands for a sample snapshot and lab state. The
gitignored `m59-shadow.mjs` only reads prod and moves bytes.

**Snapshot (prod, read-only).** Per character: `equipment` from `equipped` (an unresolved
`<rsc undefined>` — measured on Zoot — is repaired from the same pass's inventory by item id);
every `inventory` row with its amount and any non-normal grade; the purse; `guild status`.
Once per fleet: the guild's name, ten rank titles, roster with ranks, master and hall password
(never printed), plus the hall's **chests and rent credit from prod's own cache**
(`<prod root>/substrate/storage/chests/*.json`, `rent.json`) — a chest's contents are never
pushed, so the cached reading is the only one there is, and it is dated in the snapshot.
`guild` is allowed on the prod side for actions `status/list/halls/may` only.

**Slots are stable.** Shadows were assigned by fleet-row index, and the row order moves — prod
gained hk3 and reordered, which would have re-pointed Aaaa (built as Statler) at Floyd.
`assignShadowSlots` keeps every agent in the slot the previous snapshot gave it; newcomers take
the lowest free slot, and a departed agent's slot stays reserved.

**Pack and gear (lab, DM).** Read back with `show` only, then: a stack is SET to prod's number
(a purse is a state, not a top-up); a missing non-stack is created and handed over with
`NewHold`; a worn item is put on with `send object <player> TryUseItem what OBJECT <item>` —
`UserUseItem`'s own path (user.kod:4629), so slot conflicts are the game's; a worn item prod
is not wearing is taken off with `TryUnuseItem` and stays in the pack. Surplus is **reported**
and deleted only under `--trim-items`. Afterwards the lab is read again and re-planned — any
residue is printed as STILL DIFFERENT (e.g. a `TryUseItem` the server refused for an offline
body), because no error has never meant success here.

**Names are never guessed.** `shilling` now resolves (`Money` names itself with
`_name_one_rsc`/`_name_many_rsc`, which `m59-itemclass.mjs` did not index). `flask`/`wand` stay
ambiguous and are reported. **`scroll` is refused**: every real scroll is one of fifteen
subclasses that name themselves only once identified (`_label_name_rsc`), and the base
`Scroll` is a scroll of light — creating it would be a guess wearing a class name. An
uncommon long sword or an unidentified hammer is created as its class and reported
APPROXIMATED (its attributes are not on the wire). The chalice is an ordinary `Chalice` in
Loial's shadow's pack; its charges are rolled fresh (3-5), not copied.

**The guild (lab, DM), from the kod.** A player founds a guild with
`Create(&Guild,#master=…,#guildname=…)` (user.kod:1695); the admin socket can pass only one
quoted string, last, as a TEMP string, so the name goes in as a **dynamic resource**
(`create resource`), exactly as `m59-scene-guilds.mjs` already does for its temporary lab
guilds. At most nine blakod parms per `create` — the admin parser writes into a 10-slot array
with no bound check (adminfn.c:45, :849) — so the ten titles are `set` afterwards. Then
`piMature 0` (a hall refuses an immature guild), `piRentDue` = minus prod's credit,
`piGuildRejoinTimestamp 0` and `InductNewMember` per member, `ChangeRank` to prod's rank (no
promoter, so no cap check; prod's two lieutenants are the cap), and
`ClaimGuildHall oGuild … rep … password RESOURCE …` on hall 714 — what renting does once paid
(user.kod:1827). The chests are the three `Chest` objects in the hall's `plActive` at r20c4,
r18c2, r18c6 (ghall/guildh14.kod:518); items go in with `NewHold`. Re-running reuses a guild of
prod's name the shadows already belong to, inducts nobody twice, and never takes a hall owned
by another guild.

**Not copied, deliberately or because it cannot be:** bank balances (prose, stale, and a
per-account ledger nothing here writes); item attributes and charges; which spell an
unidentified scroll holds; the rent counter and maintenance timer phase; shield colours; a
character prod has with no attribute sheet (`create` still refuses it — hk3 on 2026-09-24).

**The save/load code cannot do the reading half, and that is worth knowing before reaching for
it.** `m59-scene-loadout.mjs` captures a player's carried items as portable native state, which
is exactly the right shape — but `capturePlayerLoadout` reads through the **maintenance
socket**, and `assertLab` refuses any host that is not loopback. Production is a remote server
we do not run maintenance against, and that refusal is correct rather than an obstacle to route
around. So a prod→lab clone reads over the **wire** (the broker's read-only `inventory`, which
the snapshot already did) and writes by **DM on the lab**, which is loopback. Scene save/load
remains the right tool for lab→lab.

**The class is derived, never hand-written.** `inventory` reports `{name: 'herb', amount: 60}`
and creating one needs `create object Herbs`. [`tools/m59-itemclass.mjs`](../tools/m59-itemclass.mjs)
reads each `Item` class's own display-name resource out of `koddb.json` — the same string the
wire sends back — covering 324 item classes and 332 names. Singular *and* plural are indexed,
because `Herbs` is named `herb` and pluralised `herbs` and a table built from one misses the
other. Seven names are genuinely ambiguous and **all seven refuse rather than guess**: `flask`
is `Arsenic`, `Flask` or `DenialPotion`, and creating the first where prod carried the second is
a poisoning, not a rounding error. `m59-itemclass-test.mjs` (33) pins it.

**A stack is one object with a count, not N objects** — `piNumber` is the pile, and sixty
separate `Herbs` would bury a fourteen-slot pack. `amount: 0` on the wire is the "not a stack"
marker and means ONE.

**Why guild is not optional.** Rescue's destination is **fixed and not chosen**: the guild hall,
else the caster's hometown, which is random per character. A shadow with no guild therefore
lands somewhere its original never would, and a rescue rehearsed on it proves nothing. Rank
matters for the same reason guild commands are dangerous to assume — what a member may do is a
bitmask keyed on rank, refused in **total silence** when the bit is absent.

**Reading guild from prod needed a second guard.** The prod-side allowlist was by TOOL NAME,
which was enough while every entry was a pure read. `guild` is not: the same tool that answers
`status` also disbands, exiles, sets ranks and rents halls. The name alone would have put all of
those on the production side of a file whose whole promise is that it never writes there. So the
**action** is checked too (`status`, `list`, `halls`, `may`), and the default is refusal — a new
action added upstream stays refused until somebody decides it is a read.

## Where the pieces live

`tools/m59-shadow.mjs` is **gitignored on purpose** — it carries the shape of a real roster —
so it lives in whichever checkout built the fleet and **does not travel with a deploy**. The
shim looks for it beside itself, then `--shadow-tool`/`M59_SHADOW_TOOL`, then the deploy.

The shim hands it the roster as `M59_STATE_FILE`, and the tool keeps its snapshot, sheets and
chatter file **beside that roster** (`dirname(dirname(roster))`). So a copy in a worktree still
builds the fleet whose passwords it holds, instead of starting a fresh roster there in which
every existing account reads "exists, password not held" for ever. It refuses a roster that is
not a `shadow.json`, so a shell left pointing at `prod.json` cannot have shadow credentials
merged into it.

A roster file **is** the credential store. `set account <n> password` does not work on this
server; it was tried. An account whose password is no longer held is unreachable for ever, and
the only repair is rebuilding the world. That is why `create` writes the credential the moment
the account is made, before the reroll that could fail.

Related: [`m59-fleetscratch.md`](m59-fleetscratch.md) for pads, [`m59-operations.md`](m59-operations.md)
for the broker lifecycle, [`m59-boundary.md`](m59-boundary.md) for what a claim takes.

## Offline placement must survive first login

`UserLogonSetPosition` restores `piSave_room`, square, fine offsets and angle.
Relocating an offline construction body alone does not update those fields; its
first login can therefore return to its initial inn. The construction shim now
closes creation sockets before dressing or hostile placement, then runs
`m59-shadow-position.mjs --construction --apply` with explicit loopback game,
maintenance, roster and snapshot arguments. It stores and reads back the saved
login pose before the ordinary broker starts. Without `--apply` a mismatch
refuses without writing. Production and non-construction writes are refused.

This is construction tooling. Never use it to repair a measured trial's failed
route, revive a casualty or move a live trial's administrative cutoff.

An administratively relocated offline player can still occupy the room's
holdings. Logging in only a subset does not remove the other staged bodies.
Keep unused clones outside the measured route before starting a subset trial;
verify the room's native player population rather than counting broker sessions.
Never remove those bodies during a measured crossing and call it unassisted.

`mode=idle` retains automatic economic errands. A funded clone can leave its
construction post for banking or selling before a large FleetScript finishes
preflight and claims its faculties. Set the fixture's persisted
`policy.townTrips=false` before resuming its keepers, then verify the live
departure positions, kits, purses and full cups. Script ownership still retains
normal keeper survival; this setup policy prevents an unowned preparation gap
from changing the intended starting state.

Existing construction stacks are resized through `NumberItem.AddNumber` or
`SubtractNumber` with the observed delta. Writing `piNumber` directly skips
`ChangeBulkAndWeight` on the holder and can leave its cached load different from
the visible inventory. The target and observed counts must both be positive;
re-running reconciliation then plans no further change. This is a construction
fix, never permission to repair an active trial's counters or inventory.
