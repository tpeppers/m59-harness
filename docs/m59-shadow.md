# The shadow fleet — rehearsing an errand on a copy of production

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
