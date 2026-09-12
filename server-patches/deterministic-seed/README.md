# Lab-only deterministic seed patch

This directory is an immutable patch input, in the same shape as `simulation-clock` beside it. It
is not consumed by the normal server image and it never writes into `M59_ROOT`.

## What it does, and what it does not

The stock `blakserv` **never calls `srand`**. Every kod `random(a,b)` is `C_Random`
(`blakserv/ccode.c:1911`), which calls the C library `rand()` twice per draw (`:1943`), and an
unseeded `rand()` is defined to behave as though `srand(1)` were called. So the server's random
stream is **the same sequence on every boot** — there is exactly one reality, and it is a
perfectly good one.

This patch adds a `[SimSeed]` config group and one `srand(N)` in `main.c`, immediately after
`LoadConfig()` and before anything else can draw. That makes the reality **selectable**, which is
what turns *"it worked when I tried it"* into *"it worked in 5 of 10 realities"* — the only
sentence that distinguishes a close fight from a reliable one.

**It does not make a run reproducible on its own.** One global stream is shared by every consumer,
so a wandering monster or a second login consumes draws and shifts everything downstream. Seeds
select the stream; quiescing the room is what keeps two runs on the same part of it.

```ini
[SimSeed]
Enabled  Yes
Seed     4242
```

## An unpatched server is not an error

**Off by default, and a no-op when off.** With `Enabled No` or `Seed 0` the server keeps stock
behaviour exactly, so a harness that knows nothing about this patch sees no difference at all.

The harness asks with `show simseed` and treats *not knowing the command* as an answer rather than
a failure:

```
$ node tools/m59-reality.mjs which
unseeded (stock stream)
  this server does not know `show simseed`, so it is unpatched — one reality, the stock
  rand() stream, identical every boot
  (this is not a problem — it is one reality, and a perfectly good one)
```

`readSeed()` returns `{ patched, seed, reachable, why }` and never throws for an unpatched,
unreachable or remote server. A survey run against one degrades to *"N samples of one reality
rather than N realities"*, which is honest, and says which patch would vary it.

## What is verified before Docker sees the source

The same three identities the `simulation-clock` build wrapper checks:

1. the exact Meridian git commit in `manifest.json` — `1fb1f51478d1`;
2. the SHA-256 of every source file the patch touches, in `source.sha256`;
3. that `git apply` applies it cleanly with no whitespace errors.

All four hashes here match `simulation-clock/source.sha256` for the files both patches touch,
which is independent confirmation that both pin the same unmodified tree.

## Files touched

| file | change |
|---|---|
| `blakserv/config.h` | `SIMSEED_GROUP`, `SIMSEED_ENABLED`, `SIMSEED_VALUE` before `NUM_CONFIG_VALUES` |
| `blakserv/config.c` | the `[SimSeed]` group and its two rows, after `[Webhook]` |
| `blakserv/main.c` | `srand()` after `LoadConfig()`, guarded and logged |
| `blakserv/adminfn.c` | `show simseed`: prototype, dispatch row, and implementation |

One note for whoever rebases this: the `adminfn.c` prototype hunk is anchored on
`AdminShowMemory` rather than on `AdminShowStatus`, because `AdminShowStatus`'s own prototype in
this fork carries a typo — `seFssion_id` at `adminfn.c:94`. It is harmless (C ignores parameter
names in prototypes, which is why it has survived), but anchoring a patch to a typo makes the
patch break when somebody fixes it.

## Status — BUILT AND BOOTED, 2026-09-12

`docker/Dockerfile.sim-seed` builds it. Verified on a real container:

| | |
|---|---|
| patch applies in-container, after the CR strip | yes |
| `blakcomp`, the kod and `blakserv` all compile | yes |
| unseeded build (`SIM_SEED=0`) boots and serves | yes |
| seeded build (`SIM_SEED=4242`) boots and serves | yes |
| logs `SimSeed: seeded rand() with 4242 (lab determinism)` | yes, in `channel/log-*.txt` |
| `show simseed` answers, and the harness reads it | `seed 4242` |
| a stock unpatched server still reads as unseeded | yes |

### What the build caught that inspection did not

**The first version segfaulted on startup — exit 139, empty logs, no message at all.** It called
`lprintf` at the seed site, immediately after `LoadConfig()`. That is several calls before
`InitChannelBuffer()` and `OpenDefaultChannels()`, so the channel buffer it writes through does
not exist yet. The unseeded build was unaffected, because the guard skipped the whole block — so
the bug was invisible in exactly the configuration that gets built by default.

The fix separates the two concerns: **seed early, log late.** `srand()` stays immediately after
`LoadConfig()` where it must be, and the announcement moved to just after the stock server's own
`lprintf("Starting %s")` — the first point in `main()` where logging is known to work, because
that is where the server itself first does it.

This is the entire argument for compiling a patch rather than reviewing one.

### Why the seed point is correct

There are exactly **two** `rand()` consumers in the whole server, and neither can run before the
seed:

- `blakserv/ccode.c:1937` and `:1943` — `C_Random`, the kod builtin. Needs the interpreter, which
  is started long after `main()`'s config phase.
- `blakserv/synched.c:561-563` — per-session login seeds. Needs a client that has reached the
  menu.

Everything that runs before `LoadConfig()` — `InitInterfaceLocks`, `InitInterface`, `InitMemory`,
`InitConfig` — draws nothing.

### Still unproven

**That a given seed reproduces a given outcome end to end.** That needs a scenario run twice on
one seed and once on another, which needs the scene stack pointed at this image. The mechanism is
verified; the claim about fights is not, and `certification.tier` should stay at `repeatable` or
below until it is.
