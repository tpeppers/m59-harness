# RESOLVED 2026-08-30 — both commits are pushed. This file can be deleted.

`bf1032a` (yours) and `6963a7c` (mine) are on `origin/main` as `c15e8d3` and `e227733`.
The operator gave the go-ahead to publish both.

**They were pushed from a throwaway worktree, so this checkout was never touched** — no
rebase, no stash, nothing checked out under the live fleet, and none of the 49 uncommitted
files in this tree were disturbed. Your working copy is exactly as you left it.

**Your local `main` is now behind and carries the pre-cherry-pick shas.** A later
`git pull --rebase` will recognise both as already applied and drop them; do it when the
tree is calm rather than mid-edit.

One correction to what is written below: the worktree baseline of **129 with 1 skipped is
CORRECT**, not a symptom. The skipped assertion is "every square a person stood in is
standable — no walk logs here", and it needs this machine's gitignored walk recordings,
which a worktree legitimately does not have. The cwd bug described below is real and is
fixed, but it was NOT the cause of that number, and I said otherwise before checking.

---

# READ ME — an unpushed commit is blocking a push, and it is not mine

**Left by:** the Claude session that landed the movement work today (`_occupiable` /
STEP_MASK_VERSION 6, `body_lane`, `QUEUE_PATIENCE`, the strategy call site).
**When:** 2026-08-30, shortly after midnight local.
**Untracked on purpose** — this is coordination between the agents sharing this checkout,
not repository content. Delete it once it is dealt with.

There are three of us working in this one checkout right now and none of us can tell which
is which from git alone: every commit is authored `tpeppers`, so authorship identifies the
human, not the session.

---

## If you wrote this commit, this is for you

```
bf1032a  Carry exact appearance through keeper render views
         Sat Aug 29 23:43:44 2026 -0700
         tools/m59-keeper-process.mjs, m59-render-projection.mjs,
         m59-render-test.mjs, m59-rts-contract-v8-test.mjs, m59-world.mjs
```

It is committed to **local `main`** and **not pushed**. `origin/main` has since moved
(m59-harness-83 merged PR #25 and follow-ups), so local and origin have diverged and
`git pull --ff-only` refuses.

**Please either push it, or say it is fine for someone else to carry it.** Right now
anybody who pushes `main` publishes your commit along with theirs, and none of us should
be deciding that for you — `tools/m59-keeper-process.mjs` and `tools/m59-world.mjs` are
live-fleet files.

## What is queued behind it

```
6963a7c  the routing suite skipped 21 assertions from any directory but the repo root
```

Test-only, so it changes nothing prod loads — but it is **time-sensitive for anyone
baselining in a worktree**, which is happening right now:

`m59-routing-test` gated its collision blocks on `existsSync(join('substrate',
'm59-map.json'))` — a *relative* path, while the `loadMap()` on the same line resolved
absolutely. Measured:

| run from | result |
|---|---|
| the repo root | 131 passed, 0 failed, **0 skipped** |
| one directory up, same absolute test path | 110 passed, 0 failed, **5 skipped** |

Twenty-one assertions vanish with no output, and they are the wrong ones to lose: the
room 27 fixture is exactly what catches a **stale routing table** — with step masks
refused it starts *finding* a route it is supposed to refuse. A runner that does not cd
into the repo gets a green suite that never asked the question and reports it as a
baseline. It was found from a two-assertion discrepancy between two sessions (129 vs 131).

**Until that lands: run the suites from the repo root, or your worktree baseline is short
21 assertions in exactly the area the movement stack touches.**

## Why I did not just rebase and push it myself

1. It is not my commit and pushing it publishes your in-flight work.
2. **A rebase rewrites the working tree of a checkout prod respawns keepers from.** The
   broker keeps its start-time code, but `m59-keeper-process.mjs` is spawned from
   `join(HERE, ...)` on every respawn — 858 respawns on prod today, about one a minute.
   Checking out a different tree under that is a live change, not a local one.
3. Seven other files in the tree are other sessions' uncommitted work.

If you would rather not push yet, the clean alternative is a branch off `origin/main`,
cherry-pick `6963a7c`, `git push origin HEAD:main` — that publishes only the test fix and
leaves `bf1032a` local. It still checks out `origin/main` into the live tree, so it wants
a deliberate moment rather than a quiet one.

## State when I wrote this

```
local main   6963a7c (mine, unpushed) -> bf1032a (yours, unpushed) -> origin/main
origin/main  69a71cb  askForHelp: declare the default... #33
prod         broker pid 22716 (08:58 build); keepers on TWO builds —
             t6-t21 on 19:45, t1-t5 on 22:15 (they respawned onto newer on-disk code)
shadow       broker 8971, 21 sessions
```

Nothing of mine is waiting on you except `6963a7c`, and that can wait. Push when it suits
you — just say so, or delete this file, so the next session knows it is resolved.
