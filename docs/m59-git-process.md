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

**The remedy is a push, not a conversation.** This refusal is mechanical — a tag must name a
fetchable commit — and says nothing about whose work is in the way. Landing a commit here is the
sign-off (rule 8), so `--cut --push` clears it without anybody's permission. The refusal used to
add *"on a machine with many worktrees that work is usually somebody else's"*, and that sentence
held a roll over seven good commits whose authors had mostly stopped existing.

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

* **Commits** should carry a `Claude-Session:` trailer. That already works: **39 of the last 40
  commits carry one**, so for anything in git the answer is usually written down already.
* **Machine-local order files** should carry an `_owner` field. `doctrines/local/*.jsonc` already
  carries a `_` field for its own explanation, so the shape exists.

**And there is a tool, because neither of the above reaches everything:**

```bash
node tools/m59-whowrote.mjs doctrines/local/prod-weaponcraft-training.jsonc
node tools/m59-whowrote.mjs --term "SELL_KEEP" --since 6h
```

It answers in two halves. The git half reads the `Claude-Session:` trailer off the commits that
touched a path. The disk half searches the transcripts both agent systems leave behind —
`~/.claude/projects/<slug>/*.jsonl` and `~/.codex/sessions/**` — because a transcript that
mentions a path is a session that touched it. That is the method a peer used by hand to settle
the doctrine's ownership; the tool only makes it repeatable.

**It is the only thing here that can see Codex.** Asked about `tools/m59-tactical-job.mjs`, git
reports the commit with **NO SESSION TRAILER** — Codex does not write them — while the disk half
reports **2,293 mentions in a Codex rollout** against 2 to 37 in the Claude sessions that merely
discussed it. The mention count is what separates an author from a bystander, and it is the
difference between "somebody was told about this" and "somebody wrote this".

**It prints metadata and never content, deliberately.** These transcripts carry whatever passed
through a session, which on this machine includes `substrate/fleets/prod.json` — the only copy of
twenty-three account passwords, with no reset and no email on the account. A tool that echoed
matching lines would be a credential dump wearing a helpful name.

**Recency is a reachability hint, not an answer.** A `claude` row minutes old is worth a
`SendMessage` — ask `ListAgents` for the name, which is the only authority on who is live. A
`codex` row cannot be messaged at all: read the transcript, or expect that work to keep arriving
unannounced.

Its own first version is the warning attached to it. It derived the project slug from
`basename(REPO)`, which from a worktree is the *worktree's* name — so it found the Codex sessions,
reported **zero** Claude ones for a file six Claude transcripts mention, and looked entirely
healthy doing it. The repository's name now comes from `--git-common-dir`. An attribution tool
that is confidently wrong is worse than no tool, because its answer gets acted on.

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

---

## 8. Landing a commit IS the sign-off

**Committing to this repository is consent for anyone to push, rebase, cherry-pick, merge and tag
that commit into a deploy, at any moment, without consulting you.** You do not need to be asked.
You will not be asked.

**What the opposite cost.** `--cut` used to refuse an unpushed trunk with this sentence:

> local `main` has commit(s) `origin/main` does not, so a tag cut here would name a commit nobody
> else can fetch — and on a machine with many worktrees **that work is usually somebody else's**.

Every word of that is true, and reading it stopped a roll on 2026-09-11 over seven perfectly good
commits — four of them movement and guild fixes — because the polite move looked like finding
their authors first.

That is a deadlock dressed as politeness, and it is structural rather than occasional. **The
authors here are mostly sessions, and a session that has ended cannot consent to anything.** So
"ask the author first" does not resolve to "ask later"; it resolves to *never ship it*, and the
work then sits in a local ref until somebody attempts the batch reconciliation that rule 5 exists
to say is the worse failure of the two. The old default manufactured the exact condition the rule
above forbids.

**The `Claude-Session:` trailer is for closing work out, never for gating it.** Rule 6 exists so
that a question about *intent* — why is this threshold 180, did you mean to leave this off — has
somewhere to go. It was never a permission slip, and treating it as one converts a helpful
attribution into a lock whose key is usually gone.

### Saying no, when you mean it

Some commits genuinely must not ship yet: half a protocol change whose other half is on another
branch, a schema whose migration is not landed. So say it **in the commit**, where it travels with
the work and needs no second file to stay in sync:

```
Release-Hold: the matching keeper change is not landed; shipping this alone logs out t9
```

`m59-deploy.mjs` reads every commit the cut would newly put in front of the fleet — the range
`prod..trunk` — and refuses on any that hold themselves back, quoting the reason. Nothing else
about a commit can stop a release: not who wrote it, not whether they are reachable, not how
recent it is.

**A reason is mandatory**, for the same argument `unsafe` in fleetScript makes: *"I know this must
not ship"* and *"I typed a trailer"* have to look different to the next person, who will be
holding a roll while they read it.

**And a malformed hold is a hold.** `Release-Hold` with no reason, `Release Hold:`, `release_hold:`
— anything reaching for this and missing refuses, with a different sentence saying to fix the
message. The two failure directions are not symmetric: reading a typo as *consent* ships something
its author tried to stop, silently, in front of twenty-one characters on a shared server, with no
way for anyone to notice. Reading a stray line as a hold costs one person one minute.

The parser gives ordinary English the benefit of the doubt precisely so that it can afford to be
strict about the punctuated form. `Release-Hold` is never prose and always counts; `do not
release the lock until the keeper answers` is a sentence, and only counts with a colon straight
after it. Measured against the last 88 commits here — bodies up to 4,478 characters of prose about
releases, deploys and locks — it holds none of them.

**A hold must be flush left, and an example is not a decision.** This is git's own convention for
a trailer, and it was learned ten minutes after the feature landed: **the commit introducing holds
quoted the trailer in its own message to explain it, and `--verify` promptly refused to release
that commit** — correctly, by the rule as written. Left alone, every commit documenting this would
have blocked itself, which is precisely the cry-wolf failure the rest of this file is built to
avoid. So an indented line is somebody quoting the trailer, a fenced block is skipped entirely,
and column 0 is somebody writing one. Writers already make that distinction without being taught
it, which is the only kind of convention worth depending on.

### The mechanical half is still real

A tag must name a commit somebody else can fetch (rule 3), and that has not changed. What changed
is that the remedy no longer requires finding anyone:

```bash
node tools/m59-deploy.mjs --cut --push     # push the trunk, then cut
```

`--push` checks holds **before** pushing, because pushing a held commit to `origin/main` hands it
to the next person who cuts — which is the thing the hold exists to stop — and it re-surveys
afterwards rather than reporting numbers computed from the refs it just moved.

`m59-release-consent.mjs` is the decision, pure and testable; `m59-release-consent-test.mjs` (39)
pins it, including that a `Claude-Session:` trailer is not a hold, that every typo'd form refuses,
and that an indented or fenced example does not hold the commit that explains it.
