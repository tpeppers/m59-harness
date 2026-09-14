# The boundary, in detail

An explicit [combat override](m59-combat-mode.md) temporarily owns directional
actions in the keeper process. It preempts old work at the packet boundary and
keeps health, mortality, identity and expiry checks local. It does not change
standing policy or permanently transfer the protected faculties.

A standing farm watch owns no directional faculties while passive. Only a
visible exact target in an assigned map activates its combat override. Target
loss returns ownership to farming; survival suspends the encounter while the
watch remains armed for recovery. Paused or held farming cannot activate it.

Split out of [`CLAUDE.md`](../CLAUDE.md), which carries the clock table this expands on: the three moments a playbook answers, and the difference between owning a character and being busy with it.

### The three moments the keeper asks about — `m59-playbook.mjs`

The clock table in [`CLAUDE.md`](../CLAUDE.md) is about *standing* decisions. There are also **moments** where the
keeper has no opinion and should not invent one, and where the fleet's director might.
A **playbook** is that answer, declared per character in
`substrate/playbooks/<character>.json`:

| trigger | why the keeper cannot answer it |
|---|---|
| `attacked_by_player` | the keeper is **structurally blind** to this. `inReachOfUs()` filters `OF.PLAYER` out — correctly, since without it the retaliation branch picked a *fleetmate* 131 times in one sample — so a stranger standing over a character was not merely unanswered, it was unobserved. A monster and a player are not the same problem: a monster does not follow you to another town, does not wait, and does not come back tomorrow |
| `died` | recovering is `mortality` and is unchanged. What the *fleet* does about it — whether somebody rich re-arms the corpse, whether the room comes off the list — is not answerable from inside one character |
| `improved` | max health **is** the level, and a kill only pays when the creature's level is strictly above it. A gain can make the current prey worthless, and the keeper's answer to that is to carry on hunting it, reporting kills, indefinitely |

**THE KEEPER ASKS, IT DOES NOT CALL.** A playbook is a table this process already holds,
read from disk and cached on mtime, consulted with a synchronous function call. There is
no network round trip and there must never be one — the first trigger is precisely the
moment a thirty-second round trip is worth nothing. `ask_for_orders` is the one verb that
waits; it is bounded, opt-in per trigger, and validation refuses more than 5s of it on
`attacked_by_player` because the answer would arrive after the fight.

Three properties, each of which is easy to undo:

- **Silence means the behaviour that was already there, never paralysis.** With no
  playbook, `decide` returns null and the ordinary survival ladder runs exactly as
  before. A playbook ADDS a response; **there is deliberately no verb for standing
  still**, and none for suppressing the floor.
- **The verbs are a closed set** — `nothing, retreat, leave_room, logoff, say, tell,
  ask_for_orders, stand_down`. A bot may not hand the keeper a tool call or a script. An
  unrecognised verb falls through to the next rule and is reported, never guessed at.
- **An unknown condition never holds**, so a typo disables its rule rather than promoting
  it to unconditional — and `validate()` names the fields that trigger actually knows.

The two outward verbs put text in front of real people on a shared server, so the message
must be a **literal written in the playbook**; anything template-shaped is refused,
because text assembled at the moment is how a fleet says something nobody chose.

`node tools/m59-playbook-test.mjs` (37) pins all of it against fixtures — which is the
point, since testing these for real means arranging a player attack, a death and a level
gain on a live shared server.

### An errand takes a character away. A journey only steers it.

**`goInert` and `goTravelling` are two different stand-downs and the difference is a life.**

`inert` means *stop looking at the survival question* — the loop keeps running, so frames,
observations, the partner register and the death record all keep working, and everything
that would MOVE, SWING, SPEAK, TRADE or CAST is skipped. That is exactly right for an
errand: `m59-outfit.mjs` walks the character across town and the keeper has no useful
opinion about any of it. The one exemption is death, because a corpse produces no telemetry
at all.

It was also, until 2026-08-21, what a **journey** took — and a journey is not an errand. It
steers; it does not take the body away from the keeper's opinion about staying alive. The
cost of conflating them, from `substrate/postmortems/Cccc-2026-08-21T02-30-25-005Z.json`:

| | |
|---|---|
| `02:29:13` | a commute driver saw `stuck in 1` — room 1 is **the Underworld** — and re-sent `travel`. `travelJob` called `goInert` |
| `02:29:31` | the keeper escaped the Underworld into an inn at 11 of 37. A sanctuary |
| `02:29:40` | the journey walked it back out at **27% health, against a 70% flee threshold** |
| `02:30:00` | West Merchant Way through Ilerian Woods. Six things in the room |
| `02:30:23` | dead, twenty-two seconds later, with no swing recorded and no flee attempted |

Nothing in the survival ladder was broken. The ladder was **switched off**.

So a journey now takes `goTravelling`, which keeps the ladder armed and enumerates what it
may do. Five faculties, on **two clocks**, and the split is what keeps *only one thing drives
a body* true:

| | clock | what it does |
|---|---|---|
| `flee` | mid-hop | below `flee_below` with something adjacent |
| `fight_back` | mid-hop | losing health fast enough to empty the bar before the road ends |
| `arm` | mid-hop | the weapon is gone |
| `rest` | hop boundary | sit in a sanctuary until health **and** vigor are as high as sitting takes them |
| `safe_spot` | hop boundary | hold a defensible wall part-way through |

**Mid-hop, the mover is walking, so none of those three act — they CANCEL the journey** and
hand the character back to the ordinary ladder, which then decides on the next breath with
real numbers. That is the watchdog rescue's contract and it is why the keeper never fights
the mover for a body. **At a hop boundary the mover is between rooms and nothing is
contended**, so the other two pause the journey instead of ending it.

**None of the four asks whether the body is moving.** The rescue this replaced required four
seconds of stillness, and Cccc's last pulses read 23,3 / 25,5 / 26,5 / 25,5 — a two-square
shuffle against a wall that reset that timer on every sample, so it fired 5.1 seconds before
the end. A character being eaten while it walks is in exactly as much trouble as one being
eaten while it stands, and it is harder to see.

```bash
autopilot action=set agent=<a> travel_guard='{"safe_spot": false}'   # one faculty off
autopilot action=set agent=<a> travel_guard=off                      # the old inert behaviour
autopilot action=set agent=<a> travel_guard=on                       # all six back
```

All six default **on**, because a character nobody has an opinion about must still defend
itself — the same argument `PROTECTED_FACULTIES` makes above. An unrecognised faculty name
is **refused**, never ignored. `autopilot action=status` reports the effective guard whether
or not anything is travelling, because the question is *what will this character do if a
journey takes it* and an answer that only exists once one has is an answer arriving too
late. `node tools/m59-travelling-test.mjs` (64) is the guard.

### Owning a character and being busy with it are different facts

This is the distinction the whole split runs on, and conflating it deadlocks the bot that
asked for it.

- **`claim`** — a bot holds `work`/`movement` on a character for its whole run. The board
  shows `held_by`, and the character stays **takeable**: a bot steering nine characters
  must not grey nine rows, and `m59-supervise.mjs`'s unstick round must keep running on
  them.
- **`busy`** — the holder says an operation is *in flight*. This is the one that makes
  everything step over the character, and it exists because **an external errand walks a
  character with its keeper inert by design**: `ms_since_moved` measures the KEEPER, so it
  climbs while the character is moving perfectly well, and every stall detector in the
  fleet reads it as standing still and restarts the keeper out from under the errand.

```bash
autopilot action=claim faculties=[work,movement] by=<who> lease_ms=120000
autopilot action=busy  by=<who> kind=crate-check label="checking the crate"
autopilot action=free  by=<who>
```

**`busy` is a WINDOW THE HOLDER ESTIMATES, and it extends as the work goes.** A flat lease
is wrong in both directions: too short and a supervisor round walks in halfway through a
trip across the world, too long and a thirty-second errand blocks the unstick round for
ten minutes. So a holder asks for what its remaining work expects — padded, because a leg
that goes *slightly* wrong is the ordinary case and is exactly when being interrupted
costs the whole errand — and re-declares before each step with only what is left. The
harness caps one ask at `BUSY_MAX_MS`, which is `INERT_MAX_MS` (15 min) on purpose: both
answer "how long may something else hold a character before this repository takes it
back", and two answers to that would be two opinions about when a fleet is unattended.
The cap **clamps and says so** rather than refusing, because a refused declaration leaves
the errand unannounced, which is the worse of the two.

Both are **leased and fail back to the keeper**, checked on read rather than on a timer,
so a bot that dies leaves nothing owned and nothing marked busy. Only the holder may
declare or clear `busy`; an operator with no name may always clear it, which is what the
fleet board's override key does — and that override drops the **claim** as well, or the
bot's next heartbeat quietly takes the character back thirty seconds later.

Consumers ask `isTakeable(committed)`, never `!committed`. Those were the same question
for exactly as long as the only commitments were operations; `m59-commitment.mjs` has the
argument and `m59-commitment-test.mjs` (71) pins the regression.
