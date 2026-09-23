# Survival retreat escalation — 2026-09-22

## Recommendation

Fix failed retreat escalation first, then validate with a small comparable canary.
Keep the existing flee threshold, safe-wall doctrine, combat choices, equipment,
loadouts and intentional blind-watchdog settings. Do not introduce global early
fleeing, forced logoff or more aggressive travel.

This patch is prepared against production base
`bfd89db7abefabfb8a3c20552a18e1db92f33463`. It has not been deployed or tested
against live characters. The recurring monitoring automation was closed at the
operator's request; this recommendation does not recreate it.

## Evidence and limits

The final audit covered 2026-09-20 18:02:32 UTC through 2026-09-22 18:02:32 UTC.
It found 76 server-confirmed deaths (75 PvE and one PvP), plus two empty
Underworld records that were not counted as additional confirmed deaths.
The local evidence is in
`C:/code/m59-lab/prod-deploy/substrate/death-audit-2026-09-22/`,
particularly `report.md`, `reconciliation.json`,
`escalation-cases.json` and `full-method-repro.json`.

Twenty-five deaths across eleven characters had 176 failed survival retreats in
their final minute, all confined to rung 1. The cause is reproducible in the
actual autopilot methods: `stuckRung` counted `backUps`, but
`backUpToUnstick` recorded only successful escapes. Broken breadcrumbs therefore
could not unlock the already-existing entry-door and previous-room fallbacks.

Examples include five broken-trail retreats for Lew before the September 22
12:01:51 UTC death upstairs in Castle Victoria, and eleven for Scooter before
the September 22 02:31:59 UTC death downstairs. This establishes a control-flow
bug, not proof that the alternative paths would have saved those characters.
The audit spans eight builds and changing assignments; 25/76 is an affected-case
count, not a controlled death-rate reduction estimate.

Other observed mechanisms remain outside this patch: in-place trading,
exhausted alternatives around the Flatlands choke, and slow/oscillating refuge
approaches. Do not assume an active movement claim or a disabled blind watchdog
alone caused a death.

## Patch behavior

- Failed survival attempts unlock the existing sequence: breadcrumbs, then the
  remembered entry door, then the remembered previous room. Only failures at
  the same pinned location contribute; they expire after ten minutes and are
  cleared on successful displacement. Failed entries are capped at two.
- Failed survival history cannot make a later ordinary movement attempt skip
  its first option. Existing successful-escape history remains intact.
- Once an earlier fallback moves the character, do not immediately override it
  with a previous-room journey. Return to the survival ladder for reassessment.
- Carry the same movement generation through every fallback. Stop on
  supersession, a safe-wall hold, or a terminal movement/geometry refusal.
  A superseded survival pass does not fall through into trading or record a
  successful escape.

Eligibility is unchanged: the survival escape still requires a nearby threat,
health below the existing flee line, a recognized wedge, and no held safe wall.
Missing entry memory never invents a destination. Existing breadcrumb and travel
limits (12 crumbs, two hops, two stumbles) remain; these are not a hard elapsed-time
budget. A blocked rung 3 can still recur. The patch does not repair room geometry
or guarantee that the previous room is safer.

## Validation

All checks used inert sessions or offline tools; no fleet commands were issued.

| Check | Result |
| --- | --- |
| New survival-escalation regression suite | 17 passed |
| Same new suite against unmodified production base | 8 passed, 9 failed |
| Existing survival handoff regressions | Passed |
| Existing survival decision suite | 24 passed |
| Existing movement-claim wedge suite | 17 passed |
| Existing unattended suite | 63 passed |
| Existing wedge suite | 154 passed, 19 failed, identical on patch and base |
| JavaScript syntax and whitespace checks | Passed |

The existing wedge failures are pre-existing: eighteen source-text assertions
refer to movement code's former location, and one expects an obsolete
above-flee-line refusal. They were not rewritten to hide failures.

New tests cover the repeated-failure sequence, success without unnecessary room
exit, separation from healthy movement history, location/time reset, cancellation
at both fallback boundaries, safe-wall acquisition, missing entry memory,
unchanged eligibility, and terminal geometry refusal.

Run the new suite with:
`node --test tools/m59-survival-escalation-test.mjs`.

## Suggested rollout and rollback

Before deployment, reconcile this patch with any newer survival/routing changes.
Use two automated characters in a comparable role and farming room, with
unchanged matched controls and verified loaded code. Exclude human-controlled
characters and record guild transfers, gear/loadout changes, PvP and assignments
as confounders. Do not infer success from a short zero-death interval.

For each genuine trapped-and-hurt episode, inspect the existing
`stuck_back_up` ledger records: rung, reasons, displacement, cancellation,
elapsed time and subsequent survival. Also compare deaths per measured
character-hour, travel exposure and kill throughput against comparable controls.
Confirm that failed rung 1 attempts actually unlock alternatives; synthetic
tests alone cannot establish that the geometry permits escape.

Rollback the canary promptly if it walks out after a successful fallback,
overrides a newer command or held wall, repeatedly spends longer exposed in
fallback travel, or produces attributable extra dangerous room crossings.
Keep the settings unchanged if the canary yields too few comparable episodes.
Only widen after multiple real episodes across both canary characters show
useful escapes without those regressions.

Next investigation priority is the Flatlands choke and slow refuge approach:
measure time-to-displacement and refusal causes before adding a narrowly scoped,
cancellable time budget. Avoid raising flee thresholds globally to compensate
for an escape path that cannot move.
