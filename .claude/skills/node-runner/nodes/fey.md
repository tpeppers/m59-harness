# Vale of Sorrows — Fey node, room 532, r23c30

## 2026-10-06: normal-entry spawn-location approach and walking return verified

Two quiet native trials started at the normal room-531 inbound, r1c29
(client x29184/y512), walked to the exact source spawn point r23c30
(KOD x1920/y1472), and returned to r1c29. Times: 74,467 and 75,291 ms;
health stayed 59/59. Both owned native baselines were restored. No activation.

Use checked `exactWalk` routes against the current session geometry; the room's
karma changes floor sectors. The final runner captures observed sector state.
Neither ordinary monster survival nor every karma floor configuration is proved.

This solves the requested room-local pathing to the spawn location. `c2.kod`
creates the Fey stone after the eight Fey rooms align at the required extreme
karma. It remains a conditional faction outcome; do not auto-promote this trial
into the acquisition circuit or treat an empty spawn point as a meld.

Recipe: held owned native lab, authored normal-entry scene,
`m59-node-path-lab --to r23c30 --return r1c29 --quiet`, explicit config/out paths.
See [the full report](../../../../docs/m59-vale-peak-node-pathing.md) for receipts,
source, bounds and tools. Private evidence files `node-path-1791337204738.json`
and `node-path-1791338477942.json` are in the report's named evidence directory.
