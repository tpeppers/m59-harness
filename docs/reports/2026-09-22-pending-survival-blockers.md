# Sustained blocker combat and retreat escalation

The 48-hour production audit (September 20 18:02:32 through September 22
18:02:32 UTC) found 76 confirmed deaths: 75 PvE and one PvP. Forty were in
Castle Victoria and 17 in the Flatlands. Twenty-five deaths across 11 bots
carried 176 failed first-rung retreat attempts in their final minute. This
supports escalating unsuccessful retreats instead of endlessly retrying rung
one; it does not establish a preventable-death percentage.

Clifford's September 20 18:54:48 UTC Flatlands postmortem showed an additional
dispatcher problem at r35c33. Pending refuge recovery exhausted alternatives
and returned before the ordinary survival ladder could reach blocker combat.
The pending dispatcher now reaches the same blocker operation as ordinary
measured jams.

## Final behavior

- Confirm an actual wedge, an equipped weapon, a known attackable non-player
  in reach, keeper ownership, and absence of protected safe cover.
- Select a weaker blocker first: known monster level below character max HP,
  also permitted by the existing engagement rule. Keep its exact object ID
  through successive attack rounds until it dies, leaves reach, or survival
  interrupts. Use the existing best-weapon selection and weapon prohibitions.
  Do not loot or pursue while clearing the route.
- Reassess health and cancellation every swing. At the existing flee line,
  take a reachable recovery wall. If already hurt and that escape is refused,
  permit only one last-resort weak-target swing before reassessing survival.
  Do not newly provoke a larger monster at low health.
- Equal/stronger blockers use a lure. Before any swing, require a same-room
  safe refuge with the normal body-aware player path, occupancy/claim and
  return-route checks. It must be at least four squares behind the jam,
  reachable by the monster to combat distance, with a bidirectional 2x2
  monster staging area outside the one-body-wide passage.
- Attack the exact blocker until its return attack is observed, then retreat
  to the planned refuge. A miss counts as retaliation. Combat prose is
  name-only: duplicate names cannot prove the selected body's aggro, so
  ambiguous lures are refused. Low health retreats immediately without waiting.
- Revalidate the lure route between swings and claim it again on movement.
  Twenty unproductive swings or 30 seconds without lure retaliation end the
  attempt with a retreat. These safeguards do not truncate productive weak
  fights at an arbitrary three-round limit.
- Normal farming, protected wall recovery, player exclusions and handoff
  ownership remain in force. No production deployment is part of this test.

The branch retains failed-retreat escalation from 91c8c63 and the production
Castle routing fix cf9f1e0. Regression tests exercise the actual pending
dispatcher, sustained exact targeting, low-health escape, handoff/cancellation,
retaliation, equal/stronger target selection and needle rejection. Legacy
blocker fixtures now provide real attackable flags and exercise the fightNow
seam; their former suicidal-troll expectation is replaced by the requested
health-aware lure policy.

Validation on this revision: 31 blocker tests and 17 failed-retreat tests pass;
survival decision, handoff, preemption (18 assertions) and Castle chamber (25)
checks pass. All 13 movement suites finish with zero regressions against their
named baseline (12 existing needle failures and four existing travelling
failures remain). This is offline validation; live effectiveness is unmeasured.

## Shadow validation

The operator requested one hour of continuous reverse world-tour loops.
Runtime evidence, checkpoints, progress and results live under
substrate/survival-tour-20260922 in this worktree. The isolated tour server uses
loopback game/admin ports 18959/18998, broker/dashboard 8981/8982 and keeper
ports 9011–9031. It contains 21 reusable shadow characters, not a fresh matched
clone of production. Record starting health/equipment and loaded clean commit.

The controller captures before/after server saves, observations and critical
scenes, then stops only its own broker after the measured hour. Report actual
completed legs/full circuits, deaths, blocked episodes, observed blocker fights
and lures, and incomplete trips. A tour that never exercises a lure is a
coverage gap, not proof that luring works. This is a stress test, not a
controlled mortality comparison. Production release remains on hold pending
the results.
