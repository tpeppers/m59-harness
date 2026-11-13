# Meridian navigation mesh

The enhanced mesh combines Recast's walkable polygons with native Meridian
footings, narrow ledge ribbons and explicitly declared running falls. Recast
alone misses valid Meridian shelves and moving-door states. The mesh supplies
topology; the existing client collision model and final packet validator remain
the movement authority.

`tools/m59-navmesh.mjs` is the dependency-free runtime. All its points use named
CLIENT/BSP `{x,y}` fields, 1024 units per square. Existing adapters retain their
documented KOD or square contracts; see [coordinates](m59-coordinates.md).

## Movement integration

The body detour, whole-room fine rail, fine router, player fine-path view,
Session `walkTo`/`approachFine`, and node-tour cutters consult a matching mesh.
They preserve exact versus square arrival, exclusions, floor fences, live body
collision, threat prices, cancellation, movement ownership and the original
time/node budget. A missing, stale or insufficient mesh uses the existing native
planner within the remaining budget. Monster reachability keeps its existing
geometry view. Off-map exits keep the published native crossing machinery.
Short local detours retain their native fast path. Optional body-mesh searches
use an already loaded shard and a small fraction of the request budget, so a
cold large-room decode cannot consume an emergency detour's planning time.

Walk edges are directed. A returned walking path contains the exact small wire
segments that passed native no-slide collision checks. Execution may combine
same-height segments only after both a whole-chord trace and wire-step proof,
with the caller's constraints and price preserved. Dense `sourceWaypoints`
remain available separately from execution aims. A predicted move is never
reported as confirmed arrival.

The legacy fine-router adapter also checks its rounded 64-unit rail
serialization and emits bounded aims with the dense mesh proof retained.
Checked slope chords can span at most one native step in height. A mesh route
that the old serializer cannot reproduce uses the native closure instead.

Each validated chord reserves every intersected body-width passage zone in one
atomic admission. Overlapping adjacent corridors can retain both reservations;
only an independently confirmed exit releases an individual zone. A conflicting
holder still blocks entry. This handles the Ice Cave's legal diagonal corner
without disabling corridor ownership.

Jump edges refer to `substrate/m59-falljumps.json` and are compiled only after
native timed-gravity proof. Queries must explicitly allow `jump` and provide a
jump budget. They return typed walk/jump legs, with no flattened walking path.
Runtime proof checks the declaration, exact quantized endpoints, sector
requirements, running state, bodies and caller constraints. Existing execution
still checks observed jump prerequisites and owns the send. New physics
candidates do not become declarations automatically.
Exclusions inspect every crossed grid cell; fall constraints also inspect the
actual timed frame path, including sliding, rather than assuming a straight
flight. Sentinel corner and Ancient sliding-fall regressions guard this rule.

## Geometry states and artifacts

`substrate/m59-navmesh.json.gz` is a small index into packed room-state shards
under `substrate/navmesh/`. A query loads only its matching room state; the
reader retains one shard. Node edges and their proof points decode lazily.
The compiler clips padded BSP geometry to the canonical room bounds.

Each state is bound to collision data, collision-predicate version, dimensions,
sector floors/ceilings/slopes/depths, void sectors and effective physical depth
overrides. Observed sector changes invalidate an old state. PK and lighting
flags do not change physical identity. Unknown states fail closed and use the
native planner; a preview of an opened door is conditional planning data.

The packed format uses named parallel coordinate arrays and typed actions. It
does not add a runtime npm dependency. Large intricate rooms still require
substantial memory; authoring and load checks include the fine worker's 256 MiB
old-generation heap limit. Largest-room plain and threat-priced worker queries
complete or refuse within the normal four-second budget. Total V8 memory also
includes the young generation; compressed shard size is not in-memory size.

Rebuild explicitly, offline:

```text
npm ci --prefix experiments/navmesh
node tools/m59-navmesh-bake.mjs --rooms 535,579,750,2505
node tools/m59-navmesh-bake.mjs --rooms all
node tools/m59-navmesh-bake.mjs --rooms 579 --actions-only
```

The baker runs sequentially at reduced priority. It includes known floor and
ceiling states and saves completed rooms incrementally. `--states shipped` or
semicolon-separated state names selects a subset; `--out` selects another book.
`--actions-only` refreshes declared links and room bounds on existing matching
shards. If Recast cannot encode a room, native-proved footing/ribbon topology
remains available with explicit failure provenance. It does not invent geometry.

## Mana Nodes and the Ice Caves

`tools/m59-navmesh-objectives.mjs` catalogues all thirteen nodes, exact approach
semantics, return goals and game conditions. `m59-navmesh-acceptance.mjs` audits
returned dense proof points independently. Passing an approach proves a route
in the specified geometry state; it does not prove ownership, monster survival
or a timed game event.

For the Ice Caves, the normal entrance can reach the first trigger with both
gates closed. Opening only the first gate permits the main-chamber approach and
return through the inside trigger. Sector 1 is the first door; sector 2 is the
independent mana gate. Previewing sector 1 never opens sector 2. The mana gate
requires an observed non-node Yeti kill and lasts two seconds. Use a valid
activation footing within the node's range rather than requiring its raised
pedestal center. See [Ice node pathing](m59-ice-node-pathing.md).

The enhanced route completed a fresh quiet native entrance-square → first
trigger → Yeti chamber → inside trigger → entrance-square trial in 364.2
seconds, with 36 HP throughout and baseline restoration. All four legs used
the mesh; sector 2 remained observed closed at 380 throughout. The first door
was operated normally in both directions. No attack or node activation was
performed. The sanitized evidence is in `enhanced-native-results.json`.

Seafarer's Peak now has a verified normal-entrance route through two declared
falls, the node approach and a walking return. Two complete quiet native trials
confirmed both fall landings and the node endpoint exactly; the return was
within 23 CLIENT units on the correct entrance floor. Two additional isolated
boarding-flight trials passed. Baselines were restored after every trial.
`experiments/navmesh/enhanced-native-results.json` retains the independent
position/floor evidence and server identity. The offline search remains in
`experiments/navmesh/peak-boarding-diagnostic.json`. These movement trials did
not activate the node or promote a new acquisition circuit.

Other nodes retain their real conditions: karma/faction, the Ukgoth relic and
hour, Avar's faction swing, Martyr portal activation and the Underworld puzzle.
The Mausoleum demonstration is guest-only. Navigation does not remove those
game rules. The objective catalogue keeps unresolved normal approaches visible.

## Verification

The five runtime and pure lab suites documented in [tests](m59-tests.md) are part of the
required movement suite. Compiler tests exercise generic narrow-ledged and
stateful maps with Recast installed only under `experiments/navmesh`.

```text
node tools/m59-movement-suite.mjs
node experiments/navmesh/enhanced-bake-test.mjs
node tools/m59-navmesh-acceptance.mjs --run --room 750 --max-ms 5000
```

The original `experiments/navmesh` comparison and its pinned source hashes are
retained separately from this enhanced implementation.

The final 2026-11-12 validation ran 192 movement suites with zero regressions
against the named existing baseline, 40 artifact acceptance cases and six
enhanced compiler checks. The original comparison verification also passed.
`artifact-audit.json` replays 22,920,480 distinct stored walk segments;
`artifact-audit-actions.json` checks all 24 declared links and their incident
walks against the current query guards. Both report zero failures. Three real
largest-room worker tests completed or refused cleanly under the normal limits.
The separate general path-URL audit retains eight preexisting offenders; the
touched fine-router CLI guard was corrected.
