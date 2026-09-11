# Working on this repository with other agents

This machine runs many sessions against one repository at once. On 2026-09-11 there were
**thirty-seven worktrees**, four Claude sessions editing the trunk checkout simultaneously, and
an agent committing into production that no session could see or message.

Nothing here is git advice. Every rule below is one incident, and the incident is named so the
rule can be argued with — a rule whose cost you cannot see is a rule the next person in a hurry
deletes.

---

## 1. Do not work in the trunk checkout

`C:\code\mindmap\maps\m59-harness` is for reading, fetching and pulling. Work happens in a
worktree of your own:

```bash
git worktree add ../work-<what> -b <branch> origin/main
```

**What it cost, 2026-09-11.** The trunk checkout held **18 modified tracked files and 26
untracked**, belonging to at least four parties. The consequences compound:

* Nobody can `pull`, because the incoming commits touch files somebody is editing.
* Nobody can `merge`, for the same reason.
* Nobody can `stash` — correctly. A stash there takes another session's work with it, and
  attempting one is properly treated as interfering with somebody else's workload.
* So work accumulates on a local branch instead: **29 commits sat unpushed for hours**, while the
  broker wedged twice. One power cut from gone.

The practice already exists — thirty-seven worktrees is not an accident. It is simply not
universal, and the one checkout everybody *also* edits is the one that has to stay mergeable.

**Corollary: push before you go idle.** A branch that only exists on this disk is not work that
has landed. It is work nobody else can see, build on, or rescue.

---

## 2. A deploy is read-only

`C:\code\m59-lab\prod-deploy` is a versioned checkout of a tag. Never commit there.

This is enforced now rather than asked for: `tools/hooks/pre-commit` refuses a commit in any
worktree whose HEAD is detached at a `deploy-*` tag. Install it once per clone —

```bash
# from the trunk checkout, and ABSOLUTE — see below
git config core.hooksPath "$(git rev-parse --show-toplevel)/tools/hooks"
```

**The path must be absolute, and this is not a style preference.** `core.hooksPath` is resolved
against *each worktree's own files*, so a relative `tools/hooks` makes the deploy look for a hook
inside the deployed tag — which does not contain it until a deploy carrying the hook has already
shipped. Installed that way the guard is simply absent exactly where it is needed, and it fails
the way everything else in this file fails: silently, with the commit succeeding.

That is not hypothetical. It is how this hook was first installed, and the mistake was found by
attempting a real commit in production and watching it succeed. Test a guard by trying to do the
thing it forbids; an install that reports no error has told you nothing.

**What it cost.** Prod went AHEAD of the trunk three times in one night: twice by an agent
outside the session graph committing straight into `prod-deploy`, once by a session cutting a tag
from a trunk line that had never been pushed. Each left commits reachable from nothing but a
detached HEAD, and each needed a hand adoption to get back onto main.

The hook keys on **the tag, not the path**, so it protects the next deploy worktree as well as
this one. `--no-verify` still works, deliberately: a hook nobody can bypass is a hook that gets
uninstalled by the first person it blocks at 02:00. What it removes is committing there by
accident, which is what all three incidents were.

---

## 3. A tag must name a commit somebody else can fetch

`m59-deploy.mjs --cut` now **refuses** when the local trunk has commits `origin/main` does not.
It used to say so in a note and proceed.

**What it cost.** `--cut` proposed tagging local `main` while that ref was seven commits BEHIND
origin and carrying ten unpushed commits belonging to a different session. The proposed tag would
have shipped production **without the fix the roll existed for** — and it fails silently in both
directions: the tag cuts cleanly, the worktree checks out cleanly, and the broker comes up
healthy running the wrong tree.

Three sessions walked up to this in one night. Two stopped. That ratio is the argument for a
refusal rather than a warning: the note was accurate, complete, and printed directly above the
commands to run.

**When you do cut, read which ref it names.** If the trunk checkout is diverged, tag
`origin/main` explicitly rather than accepting the default.

---

## 4. A guarantee that cannot be evaluated must refuse, not proceed

Some state is deliberately machine-local and gitignored: `substrate/keeper-bands.json`,
`substrate/fleets/*`, `substrate/loadouts/*`, `doctrines/local/*`. A worktree does not have it.

**What it cost.** A fleetScript run from a worktree could not find the keeper band, so it could
not read the route, so `trapCheck` — the refusal written after a character was walked into room
599 and died there — was skipped. It logged one advisory line and walked. `keeperLease` degraded
in the same breath to a broker-side claim with **no-op** `cancelJourney` and `release`, while
announcing "the keeper cannot be steering" — an inference from the missing file rather than an
observation. The character had a keeper the whole time.

`m59-which.mjs` already models the right shape and should be copied rather than admired: its
third answer is `INDETERMINATE`, and it exits non-zero. *A port that does not answer is a
question, not a fleet.* A guarantee that cannot be checked is not a guarantee that passed.

---

## 5. Reconcile continuously, never in a batch

Do not run a "close out all the WIP" project.

**What it cost.** One was attempted on 2026-09-11: 29 unpushed commits merged, five conflicts
resolved, tests green — and the push was rejected, because another session was landing the same
work by rebase at the same moment. Checking by **content rather than hash** showed **27 of the 29
were already on origin** under different hashes. Pushing would have duplicated 27 commits into
the history.

The real remaining gap was **two commits**. The merge was thrown away and those two were
cherry-picked.

Two lessons, and the second is the general one:

* **Compare by content, not by hash.** `git log --format=%s origin/main..main` against the
  subject lines already on origin catches a rebase that a hash comparison calls divergence.
* **Concurrent reconciliation of the same work is worse than either party doing it alone.**
  Frequent small pushes make the batch unnecessary; a batch makes collisions certain.

---

## 6. Say who you are, in the commit and in the file

Git attributes everything on this machine to one author, and the interesting state is gitignored.

**What it cost.** Establishing who owned one live doctrine file took a peer session searching its
own transcripts for the `Edit` call that wrote it and matching the timestamp against
`ListAgents`. Two sessions — including this one — guessed first and guessed wrong.

* **Commits** should carry a `Claude-Session:` trailer. That is attribution for anything in git.
* **Machine-local order files** should carry an `_owner` field. `doctrines/local/*.jsonc` already
  carries a `_` field for its own explanation, so the shape exists; there is nowhere else for the
  answer to live.

---

## 7. Not every committer is in `ListAgents`

`ListAgents` enumerates Claude sessions. It does not enumerate everything that writes here.

**What it cost.** `m59-deploy.mjs --verify` found ten uncommitted files in production. Two Claude
peers had both just reported prod clean — truthfully, from samples two minutes stale. The writer
was an OpenAI Codex agent, live on this machine since 09:00, which had edited a keeper source
file and bounced all 23 keepers onto it twenty-five seconds later. Every cross-session
negotiation that evening had been reasoning about a peer set that excluded the actual writer.

So: **ask who else is here, and then check anyway.** CLAUDE.md's instruction to ask before a
fleet-down is necessary and not sufficient. `--verify` and the process list were the only
instruments that saw it, and a tree that was clean two minutes ago is not evidence.
