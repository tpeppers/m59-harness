# Useful failure reproduction and recording fidelity

A reproducible death is useful even when it occurs at a different time, refuge
or point along a route. The system should help find and improve these failures.
A close match to a historical death is additional evidence about capture/load
fidelity; it is not the entrance requirement for every intervention experiment.

The default death-replay workflow now measures three things separately:

1. **Was the trial usable?** The scene and known player state must verify, release
   and execution must succeed, and the outcome/duration must be observed. Failed
   or uncertain trials remain in the evidence with explicit exclusion reasons.
2. **Does a death recur?** By default, two deaths across three requested baseline
   runs qualify the reconstructed scenario for intervention testing. All baseline
   runs finish, including survivors. Counts and observation horizons remain visible.
3. **How closely did it match the recording?** Code, capture gaps, server image,
   timing, room, refuge/path and survival decisions are assessed separately. These
   differences do not automatically invalidate a usable repeated failure.

The default criterion is `reproducible-death`. `recorded-behavior` retains the
stricter check for investigations specifically asking whether the recording was
closely reproduced. A same-root-cause claim still needs evidence of the mechanism:
for example, movement intent continuing while progress stops and damage accumulates.
The exact blocked square need not match. Two deaths alone do not establish that
they share that mechanism. Reports can carry an explicitly unconfirmed hypothesis.

Intervention cases now come from protections actually observed in the usable
baseline trials, including an active checkpoint decision. The recording's original
checklist remains alongside them. A reproduced failure can therefore teach us which
interventions to test even when its behavior differs from the historical trace.

## Evidence retention

Every completed trial is saved atomically by the CLI. Default output filenames
include a timestamp. Earlier observations and descriptive summaries survive a
later failed trial or cleanup. Insufficient recurrence still yields an outcome
summary, rather than an empty strategy section.

Variant outcomes with no confirmed activation/suppression remain under `observed`
and `unapplied`; they are not counted as evidence about the intended intervention.
Nonfatal windows, deaths, recovered outcomes and invalid trials remain distinct.
The report's eligibility flag describes its chosen baseline criterion, not proof
that a particular production death would have been prevented.

## Live check using the preserved fixture

The original controlled fixture death occurred after **13.594 seconds**. Its first
replay died after **4.309 seconds**, which the previous gate rejected on timing.
Those old files and measurements are still retained. This fixture intentionally
starts a shadow character at 3/36 HP alongside two rats; it validates the replay
workflow and does not represent a production incident.

The revised workflow was tested on the isolated server at 17959/17998:

| Experiment | Baseline observations | Workflow result |
|---|---|---|
| Three runs, 10-second horizon | One death at 1.081 s; two survivors to the horizon | All three retained and summarized; insufficient recurrence for automatic comparisons. |
| Five runs, 30-second horizon | Four deaths at 1.088, 10.268, 4.438 and 10.897 s; one survivor to the horizon | Reproducible failure accepted; all recording differences retained. |
| One disable-`logoff_open` variant, 30-second horizon | Death at 23.892 s; suppression did **not** trigger | Retained as an observed death and marked unapplied; no efficacy conclusion. |

The two baseline experiments have different horizons and must not be pooled into
one mortality rate. The changed code/server identity is recorded as well as timing
differences. No run certified identical historical reproduction. The five-run
experiment nevertheless supplied a usable recurrent failure and selected the
logging-off intervention from actual baseline behavior. The unapplied variant is
also useful data, but does not show whether suppressing that protection helps.

The [sanitized observations](replay-recurrence-validation-2026-09-14.json) retain
counts, elapsed times, decisions, provenance and assessment reasons. Detailed
reports remain private under `substrate/replay-smoke/recurrence-report.json` and
`recurrence-30s-report.json` in the development worktree. The lab was restored to
its native baseline afterward.

Verification: **31 death-replay scenarios** and **13 simulator scenarios** passed.
New coverage includes divergent recurring deaths, nonfatal/invalid retention,
strict recording mode, actual-baseline strategy selection, pristine scene inputs,
and preservation after later execution/cleanup errors.

See [the replay guide](m59-death-replay.md) for CLI options and report fields.
