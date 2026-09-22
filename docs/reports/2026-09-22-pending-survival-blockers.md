# Pending recovery must reach blocker combat

The Flatlands hypothesis exposed a reproducible dispatcher bug. `passOnce`
returns when `continueSurvivalDecision` handles a pending refuge decision.
That dispatcher could exhaust nearest-refuge, route-refuge and open-logoff
alternatives repeatedly without reaching `passFleeAndRest`, where the existing
stationary blocker-fighting rung lives.

Clifford's September 20 18:54:48 UTC production postmortem records this sequence
at Flatlands r35c33: unreachable walls, refused open freeze, another pending
nearest-refuge choice, adjacent monsters, and death at 3/46 HP. This supports
the mechanism; it does not establish that combat would save every Flatlands jam.

The pending dispatcher now offers the existing three-round, exact-target,
stationary, no-loot fight before another refuge attempt or retry wait when:

- The character is confirmed armed and wedged, without a safe wall or freeze.
- An attackable non-player is already in melee reach.
- The target satisfies the existing engagement ceiling / gentle-rating rule.
- Survival has not been explicitly handed off, and the existing trade policy
  and optional crowd veto permit it.

The pending recovery intent survives the bout and is reassessed on the next
pass. Hurt pending recoveries do not inherit the ordinary rung's desperation
permission to attack an out-of-band target. Equipment, flee thresholds, pursuit,
normal healthy farming, and protected wall recovery are unchanged.

Validation: 16 new offline dispatcher tests pass; four fail on production base
`cf9f1e0`. The previous failed-retreat suite passes all 17 tests. Existing
survival decision (24), preemption (18), handoff, and Castle chamber (25)
regressions pass. No production deployment is part of this test.

The combined branch also retains failed-retreat escalation from `91c8c63`
and the latest production Castle routing fix `cf9f1e0`. The operator requested
a one-hour continuous reverse shadow world tour. Its isolated raw evidence,
progress and results are under `substrate/survival-tour-20260922/` in this
worktree. Keep production and shadow death evidence separate; report completed
legs, actual full circuits, deaths, blocked episodes and incomplete trips.
This is a stress test, not a controlled mortality comparison.
