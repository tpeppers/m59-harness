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
