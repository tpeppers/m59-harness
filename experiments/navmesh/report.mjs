import fs from 'node:fs';
const r=JSON.parse(fs.readFileSync(new URL('./results.json',import.meta.url)));
const a=(c,id)=>c.arms.find(a=>a.id===id),valid=arm=>arm?.proof?.valid===true;
const f=x=>x==null?'—':x<1?x.toFixed(3):x.toFixed(1);
const nativeValid=r.cases.filter(c=>valid(a(c,'existing-fine-search'))||valid(a(c,'existing-local-search')));
const blocked=r.cases.filter(c=>c.kind==='recorded-occupied-goal'||c.id==='konima-2505-closed-gate');
const unexplained=r.cases.filter(c=>!nativeValid.includes(c)&&!blocked.includes(c));
const meshId='recast-1/16',meshWins=nativeValid.filter(c=>valid(a(c,meshId))).length;
const bspWins=nativeValid.filter(c=>valid(a(c,'bsp-portals'))).length;
const bake=r.bakes.filter(b=>b.id===meshId),size=bake.map(b=>b.bytes/1024),times=bake.map(b=>b.build_ms);
const rows=r.cases.map(c=>`| ${c.id} | ${f(a(c,'existing-fine-search')?.timing.median_ms)} | ${f(a(c,'bsp-portals')?.timing.median_ms)} | ${f(a(c,meshId)?.timing.median_ms)} | ${valid(a(c,meshId))?'native proof passed':a(c,meshId)?.proof?.reason} |`).join('\n');
const merb=r.cases.find(c=>c.id==='merb-2503-west-crossing'),native=a(merb,'existing-fine-search'),mesh=a(merb,meshId);
const text=`# Offline navigation mesh comparison

Recast/Detour is worth integrating as an optional accelerator for expensive fine searches, with the existing planner and local mover retained as fallback. This prototype does not justify replacing navigation wholesale. The sampled BSP portal prototype provides no consistent advantage on the expensive crossings.

The experiment contains ${r.cases.length} frozen scenarios: ${nativeValid.length} routes proved by at least one current planner, ${blocked.length} blocked controls, and ${unexplained.length} unresolved recorded approach. Recast at 1/16-square resolution supplies a native-validated path on ${meshWins}/${nativeValid.length} proved routes; the sampled BSP graph supplies ${bspWins}/${nativeValid.length}. These are coverage counts for this selected scenario set, not world-wide reliability estimates.

## Measured results

All times below are warm in-process median search milliseconds. Existing fine and BSP use ${r.rounds} measured samples after warm-up; Recast uses ${r.query_rounds}. The existing worker is measured separately in results.json. Native validation is additional; a fast partial or blocked route is never counted as complete.

| Scenario | Current full-room fine search ms | Sampled BSP portals ms | Recast 1/16 ms | Recast outcome after native proof |
|---|---:|---:|---:|---|
${rows}

For the Merb full crossing, Recast search took ${f(mesh.timing.median_ms)} ms versus ${f(native.timing.median_ms)} ms for the current dense fine search. A separate native validation pass took ${f(mesh.validation_ms)} ms. Its checked path was ${mesh.proof.distance_squares.toFixed(1)} squares versus ${native.proof.distance_squares.toFixed(1)} for the dense lattice route. This compares route construction on a frozen scene, not travel time or survival.

Ordinary square A* remains a different, usually much cheaper operation. Each scenario's grid_context records it separately with its collision-mask status; it does not include continuous following or live-body proof. Current bounded local search is also measured where its eight-square scope applies. On the proved narrow Ancient Place band, the existing local search succeeds even though the full-room lattice, Recast and sampled portal planner miss it.

## Where coverage is lost

**Open Konima:** the current fine search and the sampled BSP graph produce fully checked routes, while every tested Recast profile returns a partial corridor. Increasing resolution from 1/8 to 1/16 to 1/32 square does not restore it. A separate zero-radius diagnostic also remains disconnected, so ordinary radius erosion alone does not explain this miss.

The current Konima route includes an ordinary walking descent of 2649 client units, exceeding the 384-unit step threshold used by ordinary Recast adjacency. A reference-fitted directed off-mesh link can bridge this descent locally, but none of 32 tested endpoint/radius variants restores the complete route: another gap remains after the landing. Closed-door controls remain disconnected with the link. See drop-diagnostic.json. This establishes a need for native movement semantics and better connectivity compilation, not proof that one drop explains every lost connection.

**Ancient Place:** a wire-quantized narrow ledge has a direct native witness and an existing local-search route, but all mesh resolutions and the full-room fixed lattice miss it. The separate longer recorded approach remains unresolved by every tested arm; it is not evidence that the world has no route.

**Occupied exact destinations:** the static mesh proposes routes to both occupied goal controls. Native proof refuses both as object_blocked. Recast has no live-body detour adapter in this prototype. A rejected static candidate is not an accepted movement command and is not an inherent limitation of polygon navigation.

**Ceilings:** adding conventional global ceilings does not change coverage on these scenarios. A separate synthetic ceiling-profile regression shows that conventional headroom filtering removes a low-ceiling route that the floor-wall profile retains. This identifies an adaptation requirement without claiming that it is responsible for Konima's gaps.

## Build cost and representation

Across the ${bake.length} room/state bakes at 1/16 resolution, export plus bake took ${Math.min(...times).toFixed(0)}–${Math.max(...times).toFixed(0)} ms and serialized navmeshes occupied ${Math.min(...size).toFixed(0)}–${Math.max(...size).toFixed(0)} KiB each. Serialized size is not peak memory or runtime heap usage. Finer 1/32 bakes increased cost without recovering the missing routes in this sample.

Geometry comes from existing BSP floor polygons, native slope/depth helpers, void declarations and collision walls. The conservative triangle soup collapses asymmetric sidedefs into symmetric barriers; it is an approximation of Meridian movement. The floor-wall profile omits global ceilings, while conventional includes them. Both use the native player radius and nominal climb, minRegionArea=0, and no invented walkable obstacle tops.

The direct BSP alternative is a sampled portal graph, not a production-quality clearance-eroded mesh. It validates directed edges with native microsteps during each query and can miss thin portal bands. Its slow large queries do not establish that every possible BSP-derived navmesh would be slow.

## Method and limits

- All arms read the same committed map bytes and frozen body fixtures. Open and closed door states use separate geometry and mesh caches. Units are explicitly converted between 64-unit protocol coordinates, 1024-unit BSP coordinates and square-unit Recast geometry.
- Every accepted candidate starts at the exact body and reaches the exact goal. Native no-slide traces check packet-quantized steps no longer than 128 client units, bodies, mandatory exclusions and any minimum-floor fence. Partial corridors, truncated straight paths, prefixes and unproved goal bridges are refused.
- Recast is genuinely Recast/Detour through recast-navigation 0.44.0 WebAssembly. The lockfile pins dependencies. No production navigation imports this experiment.
- Native and portal timing scopes include their geometry checks. Recast search time excludes the separately reported common native proof. Warm timings and finite sample quantiles are descriptive measurements on this host, not statistical tail guarantees.
- Static Recast queries do not optimize threat costs, avoid-square constraints or floor fences while searching; the common guard applies constraints afterward. No arm in this run optimizes monster exposure or chooses a refuge chain. This experiment cannot establish movement-controller parity, crowd throughput, server position confirmation, combat survival or live journey completion.
- The native proof is a static grounded collision feasibility check, not execution of a moving body's full height/time model. No fleet sessions, sockets, game packets or server state were used.

Source revision: ${r.source_revision}. Map SHA-256: ${r.map.sha256}. Geometry manifest: ${r.map.geometryManifestSha256}. Step-mask predicate version: ${r.map.step_mask_version}. Host: ${r.node}, ${r.platform}, ${r.cpu}. Exact experiment-file hashes, bake configurations, all timings, path coordinates, scenario provenance and failure receipts are in results.json.

## Recommended next implementation

Add Recast as a candidate generator behind the current fine-route interface. Prove every candidate with the native validator and immediately fall back to current bounded local, declared/baked or fine planners when a complete checked path is unavailable. Keep room exits, door actions, passage admission, movement ownership and keeper survival in their existing controllers. Preserve mesh provenance against the exact collision digest and observed door state.

Before making it the default, resolve Konima's remaining directed connectivity gaps and the Ancient Place narrow band, add body/constraint-aware replanning, then measure complete journeys on the shadow fleet. Nothing here has been enabled in production.
`;
fs.writeFileSync(new URL('./REPORT.md',import.meta.url),text);
console.log(`Wrote REPORT.md: ${meshWins}/${nativeValid.length} Recast, ${bspWins}/${nativeValid.length} BSP, ${blocked.length} blocked controls`);
