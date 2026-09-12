# FleetScratch — the scratchpad, and the lab bargain

**Paste this to an agent that is about to start work on a hard problem in this repository.**

FleetScratch is where you work out an errand that does not exist yet. A **pad** is a file you edit
while a session stays up: change the steps, `reload`, run again, without restarting a keeper or a
broker and without losing what you have already established. When the pad is right it becomes a
FleetScript — the same shape, so promotion is a move rather than a rewrite.

It exists for two reasons and the second one is the bigger.

1. **Composition.** A 15,000-line file that every agent edits is a merge conflict with extra steps.
   Pads are small, separate files, one per task or theme.
2. **Durable context.** A pad is more lasting than a session and less authoritative than a
   FleetScript. It is where knowledge lives while it is still WIP — including the knowledge that
   currently ends up in the header of whatever file somebody had open. Lines 12–88 of
   `m59-fleetscript.mjs` are 77 lines of mana-node reachability with two same-day retractions,
   sitting in the header of a compiler, because there was no pad to put them in.

---

## THE LAB BARGAIN — read this before you touch a DM command

**The problem we are actually solving is doing the walk on prod without cheating.** The lab exists to
decompose that, so the geometry gets solved first and cheaply. That gives one bright line:

| You may do anything that removes **noise** | You may never change the thing being **measured** |
|---|---|
| Teleport to the start of the walk, a hundred times | The room geometry, the `.roo`, the collision rules |
| Disable monster spawners so a body is not in your jump | `FINENESS`, the 24-unit step limit, `CanMoveInRoomFine` |
| Grant stats, health, mana, reagents, items | Anything the prod client will not also do |
| Skip to step 7 by putting the character where step 6 would have left it | The mover's own logic, "just for the test" |
| Record everything | |

The test of whether something is allowed: **would the walk you are developing still work on prod,
where none of this is available?** If disabling the thing changes whether the route *exists*, you are
no longer solving the problem. If it only changes whether you had to wait twenty minutes and fight an
orc to find out, take it.

**The repository already enforces the dangerous half of this, and it throws rather than warns:**

- `m59-dm.mjs` refuses any host that is not loopback. *"A DM tool pointed at a shared server is not a
  tool, it is an incident."*
- `m59-shadow.mjs` — **prod is READ, the test server is WRITTEN**. The prod side has a read-only
  allowlist and refuses everything else by name; the write side refuses any game server that is not
  `loopback:15959`.

Do not route around either. If a pad needs a DM power it declares that it needs one (below) and
refuses on a machine that does not have it.

---

## Start here — five minutes

```bash
node tools/m59-fleetscratch.mjs          # the session. Needs a TTY; refuses automation, exit 3.
> list                                   # pads on disk, and what each says it needs
> describe <pad>
> check  <pad> agents=t1,t2              # CAN these characters do this? Nothing is sent.
> dry    <pad> agents=t1,t2              # the compiled steps. Nothing is sent.
> go     <pad> agents=t1,t2              # run it, through the real compiler
> watch on                               # re-compile on save and SHOW the change. NEVER runs it.
```

Pads live in `substrate/fleetscratch/` (gitignored). Copy `substrate/fleetscratch.example.mjs` to
start. Set `M59_RESEARCH_DIR` to an m59-research checkout and `check` will also tell you whether
somebody has already written down what you are about to derive.

**A pad is invisible to everything that runs errands by name.** It is not in the directories
`loadFleetScripts` enumerates, the session refuses to start without an operator, and a promoted
FleetScript may not import a pad. Pads are for somebody who is watching — never a keeper, a DUM bot,
cron, or the harness.

---

## The cork board — a pad must be pinned before it may run

```bash
node tools/m59-board.mjs list
node tools/m59-board.mjs post badlands-rail --by "Marco Polo" --for "fine rail into 45" --agents hk2
node tools/m59-board.mjs note badlands-rail --by "FleetScratch" --text "walkFine is broker-side"
node tools/m59-board.mjs strike badlands-rail --why promoted
node tools/m59-board.mjs check
```

`go` refuses an unpinned pad. `list`, `describe`, `check` and `dry` do not — you have to be able
to read a pad before you can sensibly pin one, and those send nothing. **The gate is on driving,
not on looking.**

It buys three things, in the order they were asked for.

**You can see what is driving the fleet.** A pad is invisible to the fleet REPL by design and
untracked by git by design. Both are correct, and together they made scratchpads *unobservable*:
on 2026-09-11/12 two sessions built a tool called FleetScratch, from the same operator ask, all
night, without seeing each other. Neither was careless. There was nowhere to look.

**You can see when you are leaning on them.** A pad has no provenance pin, no recipe and no test —
that is what makes it a pad. One still pinned after three weeks is **production without
production's guarantees**, and nobody notices, because it works. `check` says so by age:
`aging` at 7 days, `STALE` at 21.

**They can coordinate.** Two pads claiming one character is a `COLLISION` line — reported, never a
refusal, because an operator may genuinely want two views of one body. And any session may pin a
**note** to any pad, which is the cork-board half rather than the lock-table half. What would have
saved that night was not a mutex, it was somewhere to leave *"I am in this too, and here is what I
learned"*.

```
scratchpad board — fleet "prod"
  ...\prod.scratchpads.json
  (location chosen by: M59_BOARD_DIR)

        badlands-rail        fine rail into 45
        Marco Polo · 0 day(s) · hk2
        note · FleetScratch: walkFine is broker-side; prod-deploy lacks the fix
        ghost-raid           two-phase boss raid
        shadow fleet control · 0 day(s) · hk2, t4, t5

  COLLISION  hk2 is claimed by badlands-rail and ghost-raid
```

### Where the board lives, and why that is the hard part

The board is beside the roster — and **the roster is per checkout**, which is the exact trap
`m59-runlock.mjs` already documents: *"a tool run from a clone and one run from prod-deploy take
two DIFFERENT locks, see each other as absent, and both drive."* A board with that failure mode
would be worse than none, because it would look like coordination.

So it follows the runlock's own convention rather than inventing a second one:

| | |
|---|---|
| `M59_BOARD_DIR` | an explicit shared board directory |
| `M59_RUNLOCK_DIR` | falls through to wherever a shared lock already points |
| `REPO/substrate` | this checkout, **which coordinates nothing outside it** |

Falling through to the runlock's directory is the point: a machine that has already pointed its
checkouts at one lock directory gets a shared board for free, and **cannot end up with a shared
lock and a private board.** `list` prints the path it read and which rule chose it, every time,
because *"nothing is pinned"* and *"nothing is pinned HERE"* are the same sentence about two
different facts.

Two more refusals worth knowing: an unreadable board **fails closed** — "I could not read the
board" is not permission, or a board outage silently turns the gate off. And a pin needs `--by`
and `--for`, because a pin nobody can act on is the state the board exists to end.

## Who else is in this — the intent registry

The cork board answers *"is this pad allowed to drive?"*. It does not answer the question that
actually cost an afternoon: **is somebody else already building this?**

On 2026-09-11/12 two sessions built a tool called FleetScratch. One operator ask, both all night,
and they found each other only because a third session happened to be talking to both. Nothing
was locked, nothing collided, and that is the point — *what went wrong was invisibility, not
collision.* Two sessions on one topic is frequently the RIGHT state, because that is where
feedback comes from. So this is **a notice, not a lock**:

```
node tools/m59-intent.mjs nearby "resistance ladders and combat feedback"
node tools/m59-intent.mjs claim  "<topic>" --by "<you>" --why "<what you are doing>"
node tools/m59-intent.mjs release "<topic>"
node tools/m59-intent.mjs list | check
```

and inside a session, `nearby <topic>` and `intend <topic>`, with live neighbours printed in the
startup banner beside the board's notes. **Nothing ever refuses because of an intent.** The
strongest thing it does is print names.

It lives in the same directory as the cork board, by the same rules and for the same reason.

### Why a ratio alone would have missed the case it exists for

The obvious scoring is shared-terms over total. Measured against the real collision:

| | |
|---|---|
| A | *"FleetScratch pads and the errand compiler"* |
| B | *"FleetScratch: a REPL toolkit and debugging tools for fleet issues"* |
| shared | `fleetscratch` — **one term**, a ratio of 0.25, under any floor worth having |

The one shared word *was* the entire signal and the proportion threw it away. So there are two
rules: the ratio, which catches paraphrases of one idea, and **any shared term that is not a
repository-common word**, which catches two sessions reaching for the same unusual noun. `fleet`,
`tool`, `keeper`, `harness` and friends are on the common list precisely so they cannot fire.
Every hit prints which rule matched it, so a reader can tell a real neighbour from two long
descriptions brushing past each other.

### A claim dies two ways, and a pid is a promise

A claim expires on its TTL (8 hours by default — a working day at most), **and** it dies when its
holder does: pid plus process start time, the same checksum `m59-runlock.mjs` uses, because a pid
alone passes a recycled number. `readProcessStartMs` is exported from the runlock rather than
copied a third time; a liveness test that drifts between copies is worse than one place to fix.

But **only a long-lived caller may offer a pid**, and that is the opposite of the obvious default.
`claim` originally recorded `process.pid` — so `m59-intent.mjs claim "..."`, a one-shot process,
wrote a claim and exited, and the holder check correctly called it abandoned before anybody could
read it. A pid is a promise that something is still sitting there. The FleetScratch session passes
its own (so quitting retires the claim without anyone remembering to `release`); a command typed at
a prompt has nobody to offer, and lives on its TTL alone.

A dead claim is still **shown**, marked with how it died — *"somebody tried this and stopped"* is
worth knowing, and it is the one case where the render does not say "talk to them."

## The pad shape

Identical to a FleetScript — `name`, `describe`, `params`, `steps(params)` — plus declarations of
what it needs. `steps` is a function of its parameters and does **no work at import time**: loading a
pad imports it, so a pad that drove the fleet on load would do so merely by being listed.

```js
import { knows, knowsAny, unknownBecause, MET } from '../../tools/m59-padcheck.mjs';
//                                                  ^^^^^^^^^^^ NEVER from m59-fleetscratch.mjs

export const script = {
  name: 'badlands-rail',
  describe: 'Walk the fine rail into room 45.',
  consults: ['room 45 badlands route', 'fine grid walkable'],   // ask the corpus first

  requires: [ /* unmet REFUSES before anything walks */ ],
  capabilities: [ /* the pad branches; reported, never refused */ ],
  suggests: [ /* advice, with the mechanism named */ ],

  params: { agents: { type: 'agents', required: true } },
  async steps({ agents }) { return [ ...approach(), ...rail() ]; },
};

// Composites are just factoring, and they are what promotion harvests into a library.
const rail = () => [ walkTo(18, 13), walkTo(18, 15) ];
```

### The three tiers, and the third verdict

The tier says what an unmet entry costs **the errand**:

- **`requires`** — structural. Without it the errand does not fail, it *spins*. A drill with no spell
  to drill and no intellect to learn one will try to buy, fail, and try again for ever. **Unmet
  refuses before anything walks.**
- **`capabilities`** — the pad has a branch for its absence. Reported, never a refusal.
- **`suggests`** — causal but not structural. Advice, with the mechanism named.

A check returns `true` (met), a **string** (unmet, and the string is why), or
`unknownBecause(why, cause)` — **unknown, which is neither permission nor refusal.** Say why you
cannot tell; do not return a bare `null` and let the renderer guess. Two extra fields:

- `scope: 'fleet'` — a fact about the roster, not a character. Evaluated once, rendered once. "The
  fleet has a caster" printed per agent invents a distribution for a fact that has none.
- `breaks: ['other entry']` — this entry's violation makes **another** answer unreadable. The other
  entry becomes `unknown` naming this one as the cause. A tier is about cost to the errand; `breaks`
  is about cost to the **check**. Different axes.

---

## What `check` gives you for free

1. **The feasibility matrix** — per character, per entry, with counts and only the exceptions listed.
2. **`act()` hazards** — `act` is the only general hatch and the only step with no safeties. Two
   known traps fire on the verb: `act('fight')` runs in the broker against a snapshot and returns
   `stale_identity` while reporting success; `act('walk_to')` gets none of `walk`'s
   cancel-before-send. Both warn rather than refuse — each has happened once, and the entry criterion
   for a hard guarantee is twice.
3. **The corpus lookup** — `consults:` asks m59-research whether this is already written down. A peer
   session spent a night deriving the Ghost of Far'Nohl's resistance table from kod a week after the
   corpus had it pinned, because they did not know to look. This is the cheapest thing in the tool
   and the one with a measured value.

---

## The lab toolkit: what exists

**`node tools/m59-dm.mjs`** — DM powers over the maintenance socket, as a library and as one command.
`where`, `relocate`, `kit`, `give`, `money`, `heal`, `exec`. Four things about it that cost time to
learn, all in its header and all worth reading before your first call:

- **It needs no pacing** — batch 2000 commands into one buffer.
- **Object ids are not stable.** The server renumbers around a save. Never cache one across a call.
- **The server never says no.** `UtilGoNearSquare` returns 1 for square (99,99) in a 24×24 room,
  because it searches outward and finds *something* standable. A reply of 1 means "somebody was moved
  somewhere". Use `relocate --verify` and read the body back.
- **`relocate --at` is `row,col`** (KOD order), not col,row. Read `docs/m59-coordinates.md` before you
  argue with it.

**`node tools/m59-shadow.mjs`** — `snapshot` / `plan` / `create` / `dress` / `verify`. Builds a copy
of a prod roster on the local test server. Shadow characters are named by repeated letter
(Aaaa, Bbbb, Cccc…) so they are instantly distinguishable from the prod Muppets.

**On the shadow-Marco question: ask `plan`, do not guess the name.** And note before you start —
**`hk2` does not exist.** `badlands-node.mjs` and `cave-node.mjs` both document themselves as
`agents=hk2`, and no roster on this machine has that handle; prod is `t1..t21` plus `hk1`
(Loial the Ogier). `check` will tell you this as *"not in this fleet's roster"* rather than pretending
the character knows nothing. Fix the pads' usage lines when you adopt them.

**`tools/m59-recorder.mjs`** — bounded per-session flight recorder, for the telemetry half.

---

## The lab toolkit: what does NOT exist, and is yours to build

These are pad work, in roughly this order. Building them *is* the task, not a detour from it.

1. **Spawner control.** There is no "monsters off" verb. The mechanism is in the corpus —
   `reports/monster-room-spawning.md`, 6/6 terms — and the route is `exec` / `setProp` / `sendMsg`
   against the room's generator. **A monster standing in a jump blocks it**, height-agnostically, and
   that is the commonest cause of "it worked yesterday and refuses today". Turning spawns off removes
   the single largest source of noise in movement work.
2. **`skipTo` / `runUntil`.** `skipTo` is not "do not run steps 0..N" — it is **establish the world
   state those steps would have produced**, by DM fiat. A step's `verify` is therefore its skip
   contract, and a step with no `verify` is one you cannot skip to. A checkpoint is a predicate plus a
   way to establish it, never a saved blob:

   ```js
   checkpoint('at the ledge', {
     holds, establish, establishCost: 'free',   // free requires a citation; only free
   })                                            // establishes on UNKNOWN, else it refuses
   ```

   `holds` is re-evaluated on resume and never cached, never keyed on an object id (ids recycle
   within hours), and is allowed to answer unknown.
3. **`ScratchToScript()`** — the promotion. Lifts composites into a module, stamps `provenance`
   (pinned at HEAD, `touches` seeded **narrow**), fills `recipe.cost.measured` from the session
   transcript, and emits a `-test.mjs` from the recorded outcomes. It must land as a **draft** and
   refuse to call itself finished until the blanks are filled.

---

## `setup` / `teardown` — BUILT

A pad may declare two phases that run **around** the steps, not as steps. They exist because a
pad's `steps[]` go to the **broker** and DM goes over a **different socket** — and because
`steps()` has to stay a pure function of its parameters, so that merely *listing* the pads cannot
drive anything.

```js
export const script = {
  lab: true,                       // injects REQUIRES: LOCALADMIN — see below
  async setup(ctx)    { await putUnitAt(ctx.agents[0], 45, { row: 60, col: 46 }); },
  async teardown(ctx) { await restoreSpawns(45); },
  async steps({ agents }) { return [ ...rail() ]; },
};
```

Three guarantees, each pinned by a test that drives the real session as a child process:

- **A failed `setup` stops the errand.** The pad was written against a world state that does not
  exist, so running anyway is running something else. The refusal says that rather than just
  reporting the error.
- **`teardown` runs even when the errand fails** — it is in a `finally`, for the same reason
  `fleetScript` frees a held body in one. The failure that wedges a lab is the one where the
  errand threw. A teardown that itself throws is reported and swallowed; it must not mask the
  error the author actually needs to read.
- **`teardown` does NOT run after a failed `setup`.** There is nothing to undo, and
  un-configuring a world the pad never configured is its own way to break a lab.

**`lab: true`** injects the `REQUIRES: LOCALADMIN` entry, which is fleet-scoped and **refuses**
when the admin socket is not loopback. This is for *legibility, not safety*: `m59-dm.mjs` refuses
a non-loopback host at connect time and always will. The declaration only moves the refusal
forward to `check`, naming the pad, instead of forty seconds into a setup that has already moved
four characters.

## Scenes — `save` and `load`, the long way round

`setup` is a scene somebody wrote by hand. A **scene** is the same thing captured wholesale, and
it is the only way to reconstruct something nobody would think to write down. They produce the
same result — a lab server in a known state — which is why a pad can take either.

```bash
node tools/m59-scene.mjs plan    substrate/scenes/feast-hall.json   # the DM commands, printed
node tools/m59-scene.mjs load    substrate/scenes/feast-hall.json   # rebuild it, HELD
node tools/m59-scene.mjs release substrate/scenes/feast-hall.json   # start the clocks
node tools/m59-scene.mjs scrub   substrate/scenes/feast-hall.json -o published/
```

**The scene comes up paused, and the pause is the order of the plan rather than a flag.** Every
animate actor is frozen first, in one batch, and only then positioned, dressed and healed — a
monster already acting while you place the other eleven is not a reconstruction. The freeze is
`ClearBasicTimers` (`monster.kod:4281`), which deletes a monster's own clocks; `StartBasicTimers`
(`:4242`) puts them back. **Paused means it will not act on its own, not that it is inert:**
reactive handlers (`SomethingMoved`, `SomethingAttacked` — `brain.kod:132`, `:190`) fire on
events, not timers, so a held monster still answers a body walking into it.

`loadPlan` is **pure** — it returns commands and sends nothing, so `plan` can print it and a test
can assert it without a server. `executeLoad()` is what actually sends, and it does two things the
plan cannot:

- **It resolves names again rather than trusting the capture.** Object ids are renumbered when the
  server garbage-collects, which it does around a save every fifteen minutes, so a scene captured
  an hour ago carries ids that may now be somebody else's furniture. `object_at_capture` is a
  breadcrumb and is never addressed.
- **It refuses a partial rebuild.** If any actor cannot be found, nothing is sent —
  *a scene half-rebuilt is worse than one not rebuilt, because the half that landed looks like the
  whole.*

`save <agent> --name <scene>` reads the room through the broker and writes the file. It will not
guess which broker: on a machine running more than one fleet it names the ones it could mean and
refuses, because 8901 is production.

### Reading one off a server — what a client can actually see

`captureRoom({ agent, read, ours, hpEstimate })` looks through one character and builds the scene.
`read` is injected, so the capture is testable against a fixture and this file opens no socket.

The shape of the reader is decided entirely by what the wire carries. One object in a room arrives
as `{ id, name, col, row, distance, facing, can, is_player }`
(`m59-render-projection.mjs:88-110`), and that is **everything** available about somebody else's
body:

- **There are no hit points on it** — not for a monster, not for another player. So `hpEstimate` is
  a **hook**, not a read, and with no estimator wired it records `unknown` rather than a number. An
  invented hit-point total is the one value in a scene nobody can check afterwards.
- **There is no `kind`.** A monster and a barrel arrive in the same shape; what separates them is
  the affordance list — attackable is a body, not attackable is scenery. That is an inference and
  it is stored as one (`kind_source: estimated`).
- **`exits` is always `[]`** for a keeper-backed character — `keeperView` returns the empty array
  unconditionally and says so in its own comment. A reader that captured exits from `look` would
  record *"this room has no way out"* about every room in the world. **So a scene does not capture
  exits.** That is a refusal, not an oversight, and the scene's notes say so.
- **We read our own roster deeply and everyone else shallowly.** `status` / `inventory` /
  `equipment` answer for a character we hold the socket for; for anybody else there is a name and a
  square. A scene captured from one viewpoint is therefore mostly `unknown` outside our own fleet,
  which `sceneConfidence()` reports rather than letting the gaps read as zeroes.

### An estimate stays an estimate

The interesting half of a scene is the half the wire does not carry. **A monster's hit points are
never sent to a client**; what we have is an inference from watching it take damage. Saving that
is most of why a scene beats a screenshot — and a file that lists a guessed 233 beside a measured
position, in the same shape, will be reloaded and cited as though the 233 were measured.

So every captured field carries `observed`, `estimated` or `unknown`, `sceneConfidence()` counts
them, and the load plan marks an estimated command `[ESTIMATED]` so it reaches the operator and
not just the file. Same three-valued discipline as the preflight verdicts, one layer up.

### What a stamp can honestly claim

**Measured in the server source, 2026-09-11, and it decides everything about reproducibility:**

- every kod `random(a,b)` is `C_Random` (`blakserv/ccode.c:1911`), the C library `rand()` called
  **twice** per draw (`:1943`);
- **`blakserv` never calls `srand`.** The only `srand` in the tree is in the Win32 *client's* face
  picker (`module/char/charface.c:113`). An unseeded `rand()` is defined to behave as though
  `srand(1)` were called — so **the server's random stream is the same sequence on every boot.**

A scene is therefore reproducible in principle and fragile in practice, and the fragility has a
name: **draw-order coupling.** There is one global stream and every consumer shares it. A
wandering monster, a second login, one extra spawn tick — each consumes draws and shifts
everything downstream. *That* is why `spawns: off` belongs in a scenario for **reproducibility**
and not only for quiet.

So `certification.tier` says which of these you actually have:

| tier | claim |
|---|---|
| `recorded` | this happened once. Nothing more. The only tier a capture may claim. |
| `reconstructible` | the scene rebuilds to the same state. Says nothing about the outcome. |
| `repeatable` | rebuilt and run N times in one reality; the outcome held N of N. |
| `surveyed` | run across N **realities**, with the distribution kept. |

**A reality is one seed.** The stream being identical every boot means there is exactly one
reality available today — and a scene that "always works" may only always work in that one.
Running it against other seeds is how you find out whether you have a scenario or a coincidence:
*"the toast happened 20/20, the guard died 3/20"* is a far more useful stamp than one green run.

### The seed patch — WRITTEN, applies cleanly, not yet compiled

`server-patches/deterministic-seed/` adds a `[SimSeed]` config group and one `srand(N)` in
`main.c`, immediately after `LoadConfig()` and before anything can draw. It follows the
`simulation-clock` discipline exactly: pinned source commit in `manifest.json`, per-file SHA-256,
clean `git apply` with no whitespace errors. All four hashes match the clock patch's for the files
both touch — independent confirmation that both pin the same unmodified tree.

**An unpatched server is not an error, and that constraint shaped the whole thing.** Off by
default and a no-op when off, so a harness that knows nothing about it sees no difference. The
harness asks `show simseed` and treats *not knowing the command* as an answer:

```
$ node tools/m59-reality.mjs which
unseeded (stock stream)
  this server does not know `show simseed`, so it is unpatched — one reality, the stock
  rand() stream, identical every boot
  (this is not a problem — it is one reality, and a perfectly good one)
```

`readSeed()` never throws — for an unpatched, unreachable, switched-off or remote server it
returns `{ patched, seed, reachable, why }` and everything downstream degrades to "one reality".

**Status: applies cleanly, never compiled.** Building it needs the Docker path
`m59-sim-server-build.mjs` uses. Treat the C as reviewed-by-inspection until a build has run.

### The sentence a survey produces

```
Ghost of Far’Nohl: fleet won 5 of 10 — A CLOSE ONE.

    5/10   50%  fleet   seeds: 11, 13, 15, 17, 19
    5/10   50%  ghost   seeds: 12, 14, 16, 18, 20

  10 realities, one run each.

  git sha:
    harness  aaaa1111bbbb
    server   cccc3333dddd
    dumbot   UNPINNED
```

**It counts realities, not runs.** Ten runs on one seed is one reality sampled ten times — depth,
not breadth — and the report says so rather than letting it read as ten. On an unseeded server it
reports *"N samples of one reality rather than N realities"* and names the patch that would vary
it. An unpinned repo prints `UNPINNED` rather than being omitted, and a dirty one is flagged as
uncheckoutable, because a distribution without the code that produced it is a story.

### Publishing one

Meridian 59 is open source, so a reproduction is worth more when somebody else can run it.
`sceneProvenance()` pins **three** repositories — harness, server, and dum-bots — and records
`dirty` for each, because a scene captured from a working tree with uncommitted changes cannot be
checked out by anybody, including us next week. `publishBlockers()` refuses on an unpinned or
dirty repo.

`scrub` **drops** secret-shaped keys rather than masking them, and aliases character names
positionally (`actor1`, `actor2`) so a reader can still follow *"actor3 attacked actor1"* through
the notes. A scrub that leaves holes is a scrub nobody can use.

## One checkpoint, several ways to reach it — BUILT

**DM-forcing a configuration and playing your way into it are two routes to the same
checkpoint.** One is faster, one is faithful; the destination is identical. Saying that out loud
collapses four things this repository had been treating as separate:

| strategy | what it is |
|---|---|
| `dm` | the maintenance socket. Absolute, instant, lab only. |
| `played` | the errand. Slow — and it is the thing we are actually trying to be able to do. |
| `scene` | a captured room rebuilt wholesale. The bulk version of `dm`. |
| `shadow` | `m59-shadow.mjs dress` — a scene load scoped to **characters** instead of a room. |

```js
const armed = checkpoint('the fleet is at the feast hall, armed', {
  holds: async (ctx) => /* every raider in room 40 wielding a MAGIC weapon */,
  establish: { dm: async (ctx) => {...}, played: async (ctx) => {...}, scene: 'feast-hall' },
  cost: { dm: 'free', played: 'expensive' },
  citation: { dm: 'persench.kod:76 — already-in-effect is raised in CanPayCosts, before cost' },
});

export const script = { lab: true, setup: [armed], async steps() { ... } };
```

`reach()` is four steps, and the fourth is the one that matters:

1. **Ask `holds`. If it already holds, run nothing** — re-running an establish that was not needed
   is how a scene gets clobbered by its own setup.
2. Choose a strategy that is available here (`dm`, `scene` and `shadow` need a loopback admin
   socket; `played` runs anywhere).
3. Run it.
4. **Ask `holds` again, and refuse if it still does not hold.**

**Step 4 is the entire point.** A shortcut you cannot check is not a shortcut, it is a different
experiment wearing the same name. The server never says no — `UtilGoNearSquare` returns 1 for a
square that does not exist — so *"the DM command succeeded"* and *"the world is as I asked"* are
different facts, and only the second is the checkpoint. Asserting the **same predicate the slow
route would have satisfied** is what makes the fast route evidence about the slow one.

**Unknown refuses — unless establishing is free**, in which case just establish. Asking is not
always the cheapest way to find out: casting at an already-enchanted weapon is refused in
`CanPayCosts` *before* cost, so the write is cheaper and more authoritative than the read.
**`cost: 'free'` therefore requires a `citation`**, checked at construction, because it is the only
value that changes behaviour — unsupported, it is an author being optimistic about their own code.

### What this says about the shadow fleet

`m59-shadow.mjs` clones characters and **not their surroundings** — and on this reading that is not
a gap in the feature, it is a consequence of the feature having been written as its own thing
rather than as one of the four strategies above. The whole point of a shadow fleet is *"what if
we…"*, and a character standing in an empty copy of a room answers a narrower question than the one
being asked.

`shadow` is declared as a strategy and **is not wired to `m59-shadow.mjs` yet.** The shape it wants:
`dress` becomes a scene load whose actor list is filtered to the roster, so that cloning a fleet
*with* its surroundings is the same code path as rebuilding a room — one `holds`, one loader, two
scopes.

## How much of this run was real — modes and the gap ledger

Loading the same raid script three ways is **three different questions**, not three configs. The
mode is how a run says which one it is asking.

| mode | the question | DM shortcuts |
|---|---|---|
| `prepared` | *"does the FIGHT work?"* Clone the fleet, DM-skip to everyone armed and in the hall. | freely |
| `prod-faithful` | *"could we actually DO this?"* Rebuild the scene, then no DM at all. | **refused**, unless conceded by name |
| `prod` | *"whatever happens, happens."* Not a simulation. | **impossible** — there is no socket |
| `anything` | the scratchpad. No claim is being made. | freely |

```js
const run = fidelity('prod-faithful', { allow: ['sell-to-afford'] });
const run = fidelity('prepared', { prebuffed: true });
```

`prebuffed` is refused in `prod-faithful` and in `prod` — it is a DM preparation, so it
contradicts the one claim those modes make, and the refusal names both ways out rather than just
rejecting. A `prod` run cannot `concede` anything either: there is no admin socket on production
to take a shortcut with, so a concession would name an intention the world cannot carry out.

### In-game solutions cost time. DM shortcuts cost fidelity.

That is the line that makes this measurable rather than a matter of taste, and it is the lab
bargain again one level up:

| | costs | fidelity |
|---|---|---|
| selling loot to afford the weapon | time | intact — production could do it |
| farming karma to the requirement | time | intact — production could do it |
| granting the weapon over the socket | nothing | **a gap** — production cannot |
| teleporting to the hall | nothing | **a gap** — production cannot |

So `played` is free of fidelity cost *however long it takes*, and `dm` / `scene` / `shadow` always
carry one. A waived `unknown` is a gap too: you paid for something without being able to tell
whether you needed it, and if the run then succeeds you cannot say which.

### The gaps are the error bars

Every shortcut is written down **at the moment it is taken**, beside the checkpoint it closed —
because that is the only way it is attributable afterwards.

```
GAPS — 2 shortcut(s) taken. These are the error bars on this result.
  mode: prepared   allow: sell-to-afford
  verdict: DOES-NOT-TRANSFER — 1 DM shortcut(s) were used, so this says the fight works
           FROM THAT STATE and nothing about whether production can reach it

  HIGH  at the hall  — closed by dm (teleport)
  time  armed        — closed by played, bought in, UNKNOWN WAIVED
```

The grade answers exactly one question — *does this transfer to production?* — and has four honest
answers: `transfers`, `transfers-with-exceptions`, `does-not-transfer`, and `is-production`. It is
**deliberately not a score**: a number would get compared between runs asking different questions,
and the useful output is the list.

`substrate/gaps.jsonl` keeps every run's ledger next to the production outcome, so
`shortcutHistory(label)` can answer the question the whole thing exists for: **has this shortcut
ever mattered?** A shortcut taken fifty times that never changed a result is one worth keeping; one
taken twice where prod then diverged is one to stop taking. That is how the fast methods get
*tuned* rather than merely distrusted — and neither number is knowable unless every shortcut was
recorded when it was used.

## Composable controllers — the `#dm` pad

Lab setup is itself reusable, so it wants to be a pad rather than a paragraph in each one. A `#dm`
pad holds **simulation controllers**: *put this unit in that room, on that square, with all monsters
disabled.* Each declares `REQUIRES: LOCALADMIN` in the tier system above, so on a machine without the
socket it refuses up front instead of half-configuring a scenario.

A pad may import composites from another pad. **The moment two pads use the same composite it wants
promoting to a real module** — that is the signal, and it is what `ScratchToScript` is for. What a
pad may never define is a new **step primitive**: a new `do:` needs an executor inside the compiler,
and an executor needs the socket.

---

## The `#movement` pattern — one pad per node

This is the worked example, and it is the shape for the Marco Polo work.

- **A pad per node**, beside the notes that already exist in
  `.claude/skills/node-runner/nodes/*.md`. The existing `badlands-node.mjs` (466 lines, the fine rail
  into 45) and `cave-node.mjs` (184, the region trigger `travel` cannot take) are proto-pads that
  landed in the local *orders* directory because nothing else would take them.
- **Encode what you think you learned, as you learn it.** A pad's claims are allowed to be
  provisional — that is the whole reason pads exist. They stop being allowed to be provisional at
  promotion, where every number gets a `kod/path/file.kod:line`.
- **The loop you want**: teleport to the start, spawns off, run the walk, record telemetry, read the
  failure, edit the pad, `reload`, go again — without the session, the keepers or the broker
  restarting, and without re-walking the twenty minutes that got you to the interesting square.
- **The deliverable is the prod walk.** A route that only works with spawns off is not done; it is
  diagnosed. Write down which of the lab's affordances the real route still depends on, because that
  list is the remaining work.

---

## House rules

- **Never run on save.** A watcher that ran the pad would drive live characters on a file you had not
  finished typing. `watch` re-compiles and shows the diff; `go` runs.
- **No auto-skip of steps that succeeded last attempt.** The world moved between attempts —
  conjures evaporate, keepers roam and re-equip. `skipTo` is the explicit version and it
  *re-establishes* rather than assumes.
- **Composites yes, primitives no. No raw `call()`.** `act` or nothing.
- **What reloads, and what does not.** A pad's `steps[]` reload with no restart; nothing long-lived
  imports the pad stack. But **how** a step behaves is broker code (`travel`, `fight`), and substrate
  hooks are load-once-cached. A peer session lost two full 21-character runs restarting 21 keepers
  while the broker ran old code.
- **A mechanism is not a tactic until you have found its caller.** In one afternoon this cost two
  wrong findings that were each correctly cited: `bonus` damage bypasses resistance (true — and
  nothing in the game supplies one, 0 of 39 call sites), and a 90%-resisted blow does zero (true of
  the scaling function — and both callers clamp it to 1). Neither error was in the cited line. Both
  were in the step after it. **Check hardest at the moment you think you have found the good bit** —
  doubt catches the other kind.
