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

**The deeper fix is worth doing and is not done:** prod characters *have* reagents, so a
shadow that starts with none is a less faithful mirror, not a more neutral one. Copying the
reagent stock in `dress` would remove the shopping trip and the confound together.

## A SHADOW WITHOUT SKILLS ANSWERS THE WRONG QUESTION

Until 2026-09-16 `dress` copied attributes, max health, position and equipment but never
abilities, so every shadow was a level-60 body with no weapon proficiency. Operator: *"it
makes a difference if they're dying because they're stuck and can't leave or if they're dying
because they have no combat skills."* That was the confound, and it inverted every survival
result: a shadow death told you about the road and the geometry and nothing about the fight.

`dress` now grants each recorded ability at the number prod actually has, over the maintenance
socket. `--no-skills` goes back to a bare body **deliberately**, which is the right tool for
isolating a geometry question, and the run says which it did.

## Where the pieces live

`tools/m59-shadow.mjs` is **gitignored on purpose** — it carries the shape of a real roster —
so it lives in whichever checkout built the fleet and **does not travel with a deploy**. The
shim looks for it beside itself, then `--shadow-tool`/`M59_SHADOW_TOOL`, then the deploy.

A roster file **is** the credential store. `set account <n> password` does not work on this
server; it was tried. An account whose password is no longer held is unreachable for ever, and
the only repair is rebuilding the world. That is why `create` writes the credential the moment
the account is made, before the reroll that could fail.

Related: [`m59-fleetscratch.md`](m59-fleetscratch.md) for pads, [`m59-operations.md`](m59-operations.md)
for the broker lifecycle, [`m59-boundary.md`](m59-boundary.md) for what a claim takes.
