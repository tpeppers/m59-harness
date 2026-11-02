# Spell practice and courier operations

`/practice` and `/couriers` are read-only dashboard boards on port 8902, with
shared navigation and `?format=json`. Choose 30 minutes, 2 hours, 24 hours,
7 days or 30 days with `?hours=`. Both refresh every 30 seconds while visible;
refresh can be disabled. They never submit game orders or take a character.

Spell practice combines the current roster's ability books, training run logs,
standing training orders when present, live keeper practice/touch policies,
and keeper-ledger casts explicitly marked as practice. Changes without a
matching order are labelled as observations. Configured does not mean casting.
Keeper training status expires after three minutes. Training-ledger casts take
precedence over keeper-ledger casts for each character/spell/window; the two
are not added. Unknown outcomes remain in the attempt denominator.

Gain and atrophy are separate. Rate is net ability percentage points per
wall-clock hour over the retained observation span, including pauses. The
ability book keeps at most 400 changes; a capped history shortens that span
and the coverage note says so. ETA requires an explicit ability target, at
least two changes over five minutes, positive net progress and current
training evidence; it is suppressed while paused or human piloted.
New `m59-keep-training` runs record `goals` with `--until-ability` targets and
the next `--until` learning goal. The next-unlock panel forecasts its learnable
gate from two matching gate reads spanning five minutes, with positive net
progress and an observation within five minutes. A changed learning requirement
suppresses the forecast. Buying/questing for the spell is not part of the ETA.
Goals are never guessed from spell names or old command strings.

Couriers combines the pigeon book with finished single-character FleetScript
loop logs named for a `courier` or `zheng-he-lap`. Log identity deduplicates
the sources. The legacy pigeon file is unscoped; its script's declared
agent must belong to this exact fleet before it is used. Other fleets'
ability books, training agents and courier actors are excluded.

Legacy lap-end timestamps describe collection time. The report instead uses
the UTC run clock and the timestamp encoded in its filename, including
midnight rollover. p50/p75/p90 use nearest rank over successful laps with
known durations. Failed laps remain in completion rate. Transfer success
includes pickups and deliveries; script completion does not guarantee every
request was filled. Standing supply targets are desired stock, not shortfalls.

Quiet/PvP-hit laps match incoming PvP hit outcomes to a courier's measured
lap interval. Repeated `last_outcome` fields are deduplicated by observer,
outcome timestamp, attacker and text. Sightings, misses and outgoing attacks
are excluded. Without readable complete daily records for an interval, a lap
is unmeasured rather than quiet. Quiet means no recorded incoming hits.
The hourly table shows clock hours containing hits on identified couriers,
and separately hits during measured laps. These are not continuous combat
hours. UI times use the browser's timezone; underlying hour buckets are UTC.
No damage totals are collected or displayed by these reports.

Readers bound training logs to 4 MB, the pigeon book to 12 MB, and daily
keeper/PvP logs to 12 MB each. Partial coverage is labelled. Finished courier
parses and unchanged daily filtered records are cached. GET requests never
append, migrate or repair historical records.

A broker that predates the boards can be inspected through a temporary
companion, without starting another broker:

```powershell
node tools/m59-fleet-insights-server.mjs --root C:/code/m59-lab/prod-deploy --fleet prod --port 8903
```

This binds to loopback and verifies the broker's exact root and fleet. It
reads only the in-memory fleet tool and existing files, never a password
roster. Stop the companion after the regular dashboard is deployed. The
normal broker route also includes logged-out roster members.

Offline checks: `node --test tools/m59-fleet-insights-test.mjs`,
`node tools/m59-dashboard-route-test.mjs`,
`node tools/m59-training-ledger-test.mjs`, and
`node tools/m59-dashboard-test.mjs`.

Claude's earlier Training/Couriers implementation was found on
`feat/training-couriers` in `m59-harness-training` (page commit `926ac08f`).
It manages orders, courier signups and requests. These operations boards
consume its order/status formats when available without adding another writer.
