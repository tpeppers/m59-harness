---
description: Restart the broker on the current code, keeping the roster and every character's orders
argument-hint: [fleet]
---

Restart a fleet onto whatever is on disk now.

**Which fleet.** `$ARGUMENTS` if you named one, otherwise this checkout's default from
`substrate/fleet-default`. Never "whichever one is implied" — passing the wrong fleet,
or none, operates on the wrong fleet and does so quietly.

!`node tools/m59-which.mjs --fleet $ARGUMENTS 2>&1`

**If that reported a MISMATCH, stop and say so.** It means the running broker is holding
a different fleet from the one this command would restart, and going ahead would take
down a live fleet and bring back a different one.

!`node tools/m59-safespot-test.mjs 2>&1 | tail -1`

Do not restart if that test failed.

## Do this

```
node tools/m59-service.mjs restart --fleet <the fleet named above>
```

**Only the keepers changed?** Do not restart the broker — that logs every character off.
Hand the keepers off instead; nobody leaves the world (memory-gated, see
`docs/m59-operations.md`):

```
node tools/m59-service.mjs restart-keepers --fleet <the fleet named above>
```

That is the whole broker restart. It stops the broker **by asking `/health` which pid it is**,
then starts a new one with the same fleet, ports 8901/8902, a pid file, and its log
appended to `substrate/broker-<fleet>.log`.

Set `M59_CLIENT_EXE` first if the hero pages should be able to build launch scripts:

```
$env:M59_CLIENT_EXE = "C:\Program Files (x86)\Steam\steamapps\common\Meridian 59\Meridian.exe"
```

**Three things this must not do.**

- **Never `leave`.** It drops characters from the roster, and the roster is the only
  record of the account passwords. Stopping keepers and killing the process is safe —
  `resumeFleet` logs everyone back in and restarts their keepers with the policy they
  had — but `leave` is not undoable from here.
- **Never kill node processes by name.** More than one checkout of this tooling can be
  running, and matching `m59-broker` across all of them once killed another
  repository's broker and logged out every character in it. `m59-service.mjs` and
  `m59-shutdown.mjs` both identify a broker by `/health` before signalling it.
- **Never start a broker without naming the fleet.** A second broker is refused the
  lock, comes up healthy and **empty**, and answers every question about a fleet of
  nobody while the real one plays on.

## Reporting

Read the roster count printed above, then afterwards:

```
node tools/m59-service.mjs status --fleet <fleet>
```

Say how many resumed against how many are in the roster, how many are in game, and
anything that did not come back. `n/n in game` right after a restart is normal only
once the rejoin loop has run — it watches every 45s, so give it that long before
calling anyone missing.
