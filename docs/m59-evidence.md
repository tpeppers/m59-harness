# Evidence has an expiry date, and it is a commit

Every ledger in this repository is a measurement of code that has since changed. This is
the standard for saying which code, so that a number an operator reads is a number about
the thing that is running.

## The rule

**A commit that changes how the fleet moves carries `#movement` in its message.**

```
edge exits: aim the gate at the opening the body is standing in

Ukgoth's north boundary publishes two openings inside column 27 and the
ranked one only admits a body from square 27 exactly, so a character that
climbed the whole cliff and stopped on 1,28 was refused...

#movement
```

From that commit onward, movement evidence recorded before it is not old — it is about
**different code**, and no time window makes it relevant again. The ledgers keyed on the
movement epoch reset themselves there and start measuring what is actually running.

```bash
node tools/m59-epoch.mjs          # what the epoch is, and which commit declared it
node tools/m59-epoch.mjs --json   # the same, for a tool
node tools/m59-epoch-test.mjs     # 20 assertions; offline, safe any time
```

## Why not a clock

Historical deaths from another or unknown movement epoch can still seed tactical
experiments. Keep their recorded epoch and uncertainty; run the reconstructed
scenario on explicitly stamped current code. This is new evidence about that
experiment, not permission to count the historical route failure as a regression
in the current mover. Preserve divergent and nonfatal results as well.

That was the first fix here and it is wrong in both directions at once. "Older than 48
hours" is a guess about how fast this repository changes: a fortnight of quiet evidence is
still perfectly good, and four-hour-old evidence is worthless if the mover was rewritten in
between. **The clock does not know what changed. The commit does.**

The hours remain underneath as a fallback, for the two cases the epoch cannot cover — a
checkout with no `.git`, and rows written before this existed. Both answer `null` from
`sameEpoch`, and **`null` means "cannot say", never "stale"**: a caller that reads it as
stale deletes the ledger on every fresh clone.

## Why not hash the files

Because most commits to `m59-game.mjs` are comments, a rename, or a fix to something else
in an 18,000-line file. Invalidating every measurement for those trains everybody to ignore
the mechanism. Only the author knows whether a change to the code changed its **meaning**.

The precedent is `STEP_MASK_VERSION` in `m59-roo.mjs`, and it is worth reading. A baked
step mask is verified against `geometryManifestSha256`, which hashes the *geometry* — so a
mask baked by different **code** against the same map "matches perfectly and is attached
without a word", and once silently kept the fleet out of 773 steps per room. The answer
there was a hand-bumped version number for exactly this reason. `#movement` is that same
declaration, moved out of a constant in one file and into the commit that makes the change,
so it cannot be forgotten somewhere else.

**But an uncommitted edit is its own epoch**, and that is not a caveat, it is the common
case: the movement code is being changed right now by somebody who has not committed yet,
and that is when evidence goes stale fastest. A working tree differing from `HEAD` in any
file the domain owns gets an id of `<ref>+<content hash>`. Nobody has to remember anything
for that half to work.

## What it cost to not have this

**Ukgoth's north door read `refused 182, crossings 0`** — a boundary that had never once
been crossed — on a day when that same door was crossing in three seconds, six times out of
six. Every one of those 182 refusals was real. None was about the code then running, and
the number could not come down. A counter that only increments is not a measurement, it is
a monument: it sends somebody to repair a door that works and buries the one that broke
this morning under five days of history.

**The tactics ledger, asked what fraction of crossings ride a baked rail**, answered 27%
over five days and 48.5% over the last ninety minutes. A third of the file was a lookup bug
fixed days earlier. Reading the whole thing made a solved problem look like the dominant
one, and the figure an operator would have acted on was wrong by a factor of two.

## The epoch is read once per process, on purpose

`git` is a subprocess and `epochId` is called from inside a walk that twenty-one sessions
share an event loop with, so the answer is computed on first use and memoised. A broker or
keeper that was already running when you commit `#movement` therefore goes on stamping the
old epoch.

That is correct rather than a gap: **every keeper is a child process of the broker and
picks up new code only when it is itself restarted** (`POST /stop` on its port; the 45s
sweep respawns it from the roster on disk). An epoch change means the code changed, which
means a restart was needed anyway. The two facts move together — a keeper still stamping
the old epoch is a keeper still *running* the old code, which is exactly what you want the
ledger to say.

So: restart the keepers when you land `#movement`, the same as for any other movement
change, and check with `node tools/m59-epoch.mjs` against a fresh row in the ledger.

## Adding a domain

One entry in `DOMAINS` in `tools/m59-epoch.mjs` — a tag and the files it owns — and the
commit tag works from then on. Nothing else is configured anywhere.

**List files generously.** A file listed here only ever costs a false invalidation, which
is evidence discarded that was still good. A file *missing* costs the thing this exists to
prevent: a measurement that outlives its subject and is believed.

## Where it is wired in

| ledger | keyed on | what a superseded row does |
|---|---|---|
| `substrate/exit-gaps.json` | `movement` | counters reset; `first`, `previously_refused` and `reset_because` kept |
| `substrate/tactics/*.jsonl` | `movement` | row dropped at the next trim |
| `substrate/m59-safespots.json` | `safespots` | *domain declared; the book is not yet keyed on it* |

The `safespots` domain exists because of a mistake this repository nearly reasoned from.
Asked whether resting on the road could have prevented 37 deaths, the book was read and
answered `held: 0, failed: 180` across the five corridor rooms — under a definition of "safe
spot" that was already being replaced. The honest answer was never "the spots do not hold";
it was **"this book cannot say"**. A held/failed tally measures the PREDICATE that chose the
square, exactly as a step mask measures the predicate that chose the door.

Neither is committed — both name characters. `reset_because` distinguishes **"movement code
changed"** from **"no sighting in the window"**, because a zero that means *fixed* and a
zero that means *untested* are different facts and an operator has to tell them apart.

## The rule that outranks the mechanism

None of this makes a stale claim safe to reason from. It makes staleness **visible**. A
claim that contradicts what is written down still needs a reproduction before anything is
decided on it — see the top of [`CLAUDE.md`](../CLAUDE.md).

## The save window — attributing FLOW to a build

The epoch above says *which code* a number is about. It does not say *how much opportunity*
there was, and a count without its opportunity is the other half of every wrong conclusion
this repository has reached. `deaths per day` fell 84 → 5 over a fortnight of `#movement`
work; the journeys **quadrupled** in the same window, so the honest figure was 20.7 → 0.3
per thousand journeys — a sixty-nine-fold improvement that the daily count understated by a
factor of four.

```bash
node tools/m59-savelog.mjs                  # the last few windows
node tools/m59-savelog.mjs --write          # append closed ones to substrate/savelog/<fleet>.jsonl
node tools/m59-savelog.mjs --all --since 7d
node tools/m59-savelog-test.mjs             # 68 assertions; offline, safe any time
node tools/m59-savewire-test.mjs            # 14 — the BP_WAIT half, driven by the real dispatcher
```

**Stock and flow.** The server's save holds every inventory, vault, chest and position, and
`m59-shutdown.mjs` keeps two copies of it. Recording any of that again is a third copy of an
authoritative file, and a worse one. What a save cannot hold is what *happened* between two
of them — kills, journeys, levels, earnings, deaths — and that is gone the instant it passes.
So the savelog records flow and nothing else.

**But read the pairing claim carefully, because it is only half true for prod.** On a server we
run, the checkpoint for that same instant is ours and the two halves genuinely compose. **The
prod fleet does not play on a server we run** — its roster points at `76.214.42.186:5959`, a
shared test server, and we hold no save of it and cannot make it save. Corrected 2026-09-17: a
`--checkpoint` taken to verify this chain end to end produced files, reported success, and could
not possibly have produced a marker, because it saved a *local* server the fleet is not connected
to. What aligning to the boundary buys on prod is therefore the *alignment itself* — our windows
begin and end where the world committed its state, so two windows are comparable and neither
straddles a save — and not a checkpoint we can load. On a lab or shadow server, it buys both.

**The boundary is the server's, observed.** `user.kod GarbageCollecting()` sends every
logged-in player `BP_WAIT` when a save begins and `BP_UNWAIT` when it ends
(`user.kod:2154`, `:2182`). `m59-client.mjs` raises those as a `server-save` event,
`m59-game.mjs` writes them to the ledger as `server_save`, and `m59-savelog.mjs` partitions
on them. It is **not** derived from `[Auto] SavePeriod`, which lives in a config no tool here
can read and which the operator can change without telling anyone — and an assumed boundary
files one build's events under another's account.

All twenty-three keepers see each save, so the markers arrive in a burst and are collapsed on
a 20-second tolerance. Every character writing its own marker is deliberate: one nominated
observer is one restart away from a silently missing boundary.

**What each window carries, and why.** Fighting, dying, moving and earning, plus a
`provenance` block — the prod harness SHA, the deploy tag, the **private repo pin** and the
DUM head. The private pin is the one that describes the *whole* fleet, code and orders
together: two windows on the same harness commit with different loadouts are not the same
experiment, and nothing else in this repository would have said so. `promote.mjs` moves that
pin as part of every production promotion, so it is always the orders that were actually
running.

**A reader's failure mode is not a crash.** It is a number that is wrong while everything
around it still adds up. The first draft of `m59-savelog.mjs` counted `k.what` for a kill
against a ledger whose field is `creature` — every total correct, every breakdown empty — and
invented two death splits (`players_present`, `doing`) that do not exist on a `died` row at
all, which would have reported zero PVP deaths and zero travel deaths for ever. Three
consequences, all load-bearing:

- every field name in it was read off the ledger on disk before it was written down;
- each window carries `unaccounted`, naming every event kind in it that nothing counts, so a
  renamed event surfaces as a line of output instead of as a quieter fleet;
- `deaths_per_1000_journeys` is `null`, never `0`, when no death in the window was
  classified — unknown has to look unknown.

**`was_travelling` on a death row is new, and old rows are `null`.** The classification the
whole `#movement` question turns on used to exist only in the postmortem store, so a window
aggregate either re-opened three thousand files or went without, and it went without. It is
now on the `died` ledger row, read off `governed_by.doctrine` rather than off a room or a
strategy name — a character resting at a wall mid-journey is still travelling, and only the
doctrine knows that. Deaths written before the field are counted as `deaths_unclassified`
rather than as "not travelling", which would halve the number.

**The write is derived, idempotent and bounded, so the cadence does not matter.** The
boundaries live in the ledger; only closed windows are written, never the open one, and never
twice. The broker rolls it up every fifteen minutes as a **child process** — parsing a day of
ledger is twenty megabytes and fifty thousand rows, and doing that on the broker's event loop
is how a keeper goes silent for long enough that the server logs it out at thirty seconds.
`M59_SAVELOG=off` disables it; `M59_SAVELOG_INTERVAL_MS` changes the freshness, never the
contents.

**It lives beside the ledger it is derived from**, at `substrate/savelog/<fleet>.jsonl`, and
that path is *derived from* `ledgerDirFor()` rather than resolved again. `evidenceDirFor()`
and `ledgerDirFor()` do not agree in a worktree — prod's ledger lands in the pinned deploy's
own substrate while `evidenceDirFor` sends evidence home to the checkout the worktree was cut
from — so resolving it independently would put a summary in one tree describing a ledger in
another, and the mismatch would present as missing days rather than as a path bug.
