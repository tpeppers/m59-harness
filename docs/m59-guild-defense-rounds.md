# Guild defense simulation rounds

Run only against the attested isolated native Simulator, using its existing lab
config and roster lease. The scenario driver never connects to production.

## One commit per round

1. State the hypothesis, change the controller and run focused tests.
2. Commit the source. Use a `Release-Hold:` trailer for experimental changes.
3. From a clean checkout, run:

   ```powershell
   $env:SIM_PARENT_ROUND='000-baseline'
   node tools/m59-guild-defense-round.mjs run 001-recovery-entry "Recovery resumes paused journeys; live door geometry permits entry"
   ```

4. Review the bundle, including validity and temporary-account cleanup.
5. Attach a concise outcome, report hash and bundle location to that exact commit
   with `git notes --ref=m59-sim-results add -F <note-file> <commit>`.
   Publish the experimental branch and the notes ref together. Read results with
   `git log --show-notes=m59-sim-results`. Do not amend the tested commit afterward.

Bundles live under ignored `substrate/guild-defense/rounds/<round>`. Existing
round names are refused. Keep report.json, summary.json, REPORT.md, all 30-second
check-ins, event log, console log, input snapshot, driver snapshot, runtime evidence,
and manifest with SHA-256 hashes. Full reports and captures remain private and
uncommitted; code, methodology and concise Git notes are versioned.

A crashed process leaves its started manifest and streaming log. Preserve it as an
incomplete attempt; use a fresh round name to retry. Setup/recorder failures are
not defense outcomes. An imported historical report retains its own execution
provenance; the importing commit does not pretend to be the commit that ran it.

## Controlled scenario

Twenty captured guild defenders begin upstairs Castle Victoria (39), two raiders
inside the owned Bookmaker hall (714). Raiders have 100 HP, all six stats 50,
all nineteen weaponcraft skills 99%, scimitars, knight shields and plate.
Defenders retain captured skills/max HP and use matched weapons, knight shields
and scale armor. Full HP, 200 vigor, light packs, no spells or consumables.
Road monsters remain. The raid timer begins with an ordinary lever activation.

Round 000 archives the one-shot travel controller: watchdog active, no recovery
loop after a journey pauses, and no live door observer. Earliest arrival was
Beaker in the foyer at 399163 ms; nobody reached the inner hall; Floyd died.
The native entrance trigger r3c28 is valid through inherited guild-hall code.

Compare foyer/inner arrival times, all casualties, Floyd's recovery, native hall
ownership/timer and setup/cleanup validity. A combined controller change is one
bundle of hypotheses, not proof of each change independently. Native randomness,
shared-process contention and modeled loadouts limit production conclusions.
