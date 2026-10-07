# Vale of Sorrows — Fey node, room 532, r23c30

## 2026-10-06: connected Marion approach and town return verified

The old trials below started inside Vale. The new complete native run begins
at **Marion room 200 r56c39**, uses normal `Session.travel(532)` through
**200 → 534 → 533 → 522 → 521 → 531 → 532**, then checked walking to the exact
source spawn **r23c30, protocol x1920/y1472**. Normal travel returns by
**532 → 531 → 541 → 542 → 533 → 534 → 200**, ending in Marion r30c66.
One complete quiet run: **336,063 ms, 12 map crossings, 59/59 HP throughout**,
zero jumps, 44 checked local approach waypoints and 45 return waypoints.
Owned native baseline restored. No mid-journey teleport or node activation.

The first connected approach succeeded but its town return exposed a north
exit defect: from r1c28 x1824/y96, nearest outward x1842/y63 clips wall 296,
while x1888/y63 fully validates. Distance-only re-anchoring reused the blocked
chord across retries. The executor now prefers fully proved live chords inside
the existing boundary gate; wall, height, wrong-door and atomic queue checks
remain. Isolated native reproduction and the full repeat verify that repair.

Recipe: held owned 17959 lab, authored normal Marion spawn, current geometry,
`m59-node-path-lab --travel-to 532 --to r23c30 --return r1c29 --return-town 200
--quiet --quiet-rooms 511,521,522`, explicit config/scene/out paths. Quiet both
forest branches; preserve passive scenery and restore the native baseline.
The first approach only quieted its initial graph route; the full repeat covers
every room actually used. This proves terrain/travel for the observed karma
floors, not ordinary monster survival, all floor states, or node acquisition.

The Fey stone still requires the eight forest rooms' extreme karma alignment.
An empty spawn point is not a meld; keep this node conditional. See [the full
report](../../../../docs/m59-vale-peak-node-pathing.md) for source, scope and
private receipts, especially `node-path-1791342509209.json` under the connected
`vale-from-marion-2026-10-06` evidence directory.


## 2026-10-06: normal-entry spawn-location approach and walking return verified

Two quiet native trials started at the normal room-531 inbound, r1c29
(client x29184/y512), walked to the exact source spawn point r23c30
(KOD x1920/y1472), and returned to r1c29. Times: 74,467 and 75,291 ms;
health stayed 59/59. Both owned native baselines were restored. No activation.

Use checked `exactWalk` routes against the current session geometry; the room's
karma changes floor sectors. The final runner captures observed sector state.
Neither ordinary monster survival nor every karma floor configuration is proved.

These original proofs were local to room 532; they did not begin in Marion.
`c2.kod` creates the Fey stone after the eight Fey rooms align at the required extreme
karma. It remains a conditional faction outcome; do not auto-promote this trial
into the acquisition circuit or treat an empty spawn point as a meld.

Recipe: held owned native lab, authored normal-entry scene,
`m59-node-path-lab --to r23c30 --return r1c29 --quiet`, explicit config/out paths.
See [the full report](../../../../docs/m59-vale-peak-node-pathing.md) for receipts,
source, bounds and tools. Private evidence files `node-path-1791337204738.json`
and `node-path-1791338477942.json` are in the report's named evidence directory.
