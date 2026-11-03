# Spell practice and courier operations

## Shared FleetScript telemetry

The boards also read versioned receipts from
`substrate/history/<fleet>/activity/<UTC day>.jsonl`. The broker owns the writer,
so a script launched from a different checkout cannot silently create a second
history. `M59_ACTIVITY_DIR` overrides the directory; otherwise an explicit
`M59_LEDGER_DIR` is honoured before the broker's own checkout is used.

The shared FleetScript executor records per-agent run start/end, plan tags,
step timing and a 30-second heartbeat. Nested calls inside `verify()` retain
their run identity through async context, including parallel and nested runs.
Named scripts also record their source file's SHA-256 and explicit learning or
ability goals when their parameters provide them. Script descriptions and
delivery/restock legs supply discovery tags; a tag is not proof of delivery.

The broker observes cast, supply, purchase, inventory-after-purchase,
guild-chest/vault/bank/loot and learning-gate replies. This also covers standalone
scratch drivers that do not use FleetScript: the local Mystic Touch drill calls
the same broker cast door. A newly launched local arrow-courier lap uses the
shared executor, even though its filename does not contain “courier”. Neither
private script needs a separate logger or a hard-coded page integration.

No extra game packets or inventory queries are issued for telemetry. The
observer uses the result already produced by the tool and reads already-cached
identity/catalogue data. Lifecycle writes are queued, bounded to 64 pending
events, and flushed for at most two seconds after body/lock cleanup. Disk or
transport failures never fail a game action, retry a mutation, or keep a body
leased. Missing starts/ends stay incomplete and cannot count as successful laps.

Queued/accepted casts do not prove success. Failed-roll and broken-trance server
sentences win over mana changes. Full payment only supports success for a known
instant spell; trance/unknown-cost outcomes stay unknown until a verified
training receipt supplies the result. Matching receipts are merged one-for-one,
while keeper-origin practice remains a separate source. General broker spell
use is labelled as such instead of being claimed as an explicit training order.

The courier board shows in-progress runs and stocking receipts alongside ended
laps, with incoming PvP hits correlated to the actual courier. Inventory gains
after a purchase are labelled as observations; unknown transferred quantities
are not filled from requested quantities. Stationary donations do not create
standalone travel laps. Native and matching legacy lap receipts are deduplicated.

Coverage can be audited without importing or executing private source:

```powershell
node tools/m59-telemetry-audit.mjs --root C:/code/m59-lab/prod-deploy --json
node --test tools/m59-activity-telemetry-test.mjs
```

The November 2 audit found 211 candidate source files: 122 using the shared
runner, 79 standalone broker callers, and 10 pure helpers, readers or keeper
policy setters. No direct keeper/socket cast bypass was found in that audit.
Static discovery identifies possible paths, not proof that a script is running.
The telemetry tests replay the arrow-buying and Mystic Touch shapes without
touching production or importing private drivers. The FleetScript executor
suite passed 506 checks, including its new lifecycle and step receipt checks.

Deployment needs a rolling broker handover for the new observer/tool. Existing
standalone broker callers then report automatically, without a restart. Existing
long-lived FleetScript processes retain their imported executor; move those onto
new code at a natural run boundary, preserving their orders and human pilots.
The arrow courier's fresh per-lap REPL process picks up the hooks on its next lap.
Verify new `sources.activityRows`, the courier's named run/stock receipts, and
Mystic Touch outcomes in the JSON/page after rollout; old history is not backfilled.

Validation limitation: `m59-broker-demand-test.mjs` has a pre-existing static
assertion requiring the exact `Object.freeze({ port, identity, record })` return
spelling. It fails against unchanged `306cc221` as well as this change. The
telemetry, insights, executor, FleetScript library, dashboard, routing, training
ledger and RTS authority checks pass. This unrelated static assertion was not
weakened to clear the rollout.

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
