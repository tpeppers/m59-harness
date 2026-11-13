# Offline navigation mesh comparison

Recast/Detour is worth integrating as an optional accelerator for expensive fine searches, with the existing planner and local mover retained as fallback. This prototype does not justify replacing navigation wholesale. The sampled BSP portal prototype provides no consistent advantage on the expensive crossings.

The experiment contains 13 frozen scenarios: 9 routes proved by at least one current planner, 3 blocked controls, and 1 unresolved recorded approach. Recast at 1/16-square resolution supplies a native-validated path on 7/9 proved routes; the sampled BSP graph supplies 8/9. These are coverage counts for this selected scenario set, not world-wide reliability estimates.

## Measured results

All times below are warm in-process median search milliseconds. Existing fine and BSP use 5 measured samples after warm-up; Recast uses 25. The existing worker is measured separately in results.json. Native validation is additional; a fast partial or blocked route is never counted as complete.

| Scenario | Current full-room fine search ms | Sampled BSP portals ms | Recast 1/16 ms | Recast outcome after native proof |
|---|---:|---:|---:|---|
| flat-535-forward | 104.2 | 0.858 | 0.021 | native proof passed |
| flat-535-reverse | 146.2 | 0.819 | 0.014 | native proof passed |
| ancient-579-ledge-walk | 1.3 | 9.0 | 0.004 | endpoint_not_on_mesh |
| ancient-579-proved-narrow-band | 1.1 | 8.3 | 0.007 | partial_mesh_path |
| merb-2503-west-crossing | 558.2 | 942.1 | 0.350 | native proof passed |
| merb-2503-recorded-recovery | 13.4 | 0.113 | 0.013 | native proof passed |
| konima-2505-open-gate | 530.2 | 1935.4 | 0.355 | partial_mesh_path |
| konima-2505-closed-gate | 8.7 | 77.4 | 0.004 | partial_mesh_path |
| konima-2505-occupied-exact-stage | 510.3 | 1732.9 | 0.011 | object_blocked |
| konima-2505-freed-exact-stage | 0.413 | 0.080 | 0.011 | native proof passed |
| konima-2505-recorded-return-approach | 0.683 | 0.077 | 0.010 | native proof passed |
| hollows-2502-occupied-exact-guide | 379.7 | 1475.0 | 0.021 | object_blocked |
| hollows-2502-next-guide | 78.7 | 79.9 | 0.065 | native proof passed |

For the Merb full crossing, Recast search took 0.350 ms versus 558.2 ms for the current dense fine search. A separate native validation pass took 4.5 ms. Its checked path was 139.9 squares versus 144.5 for the dense lattice route. This compares route construction on a frozen scene, not travel time or survival.

Ordinary square A* remains a different, usually much cheaper operation. Each scenario's grid_context records it separately with its collision-mask status; it does not include continuous following or live-body proof. Current bounded local search is also measured where its eight-square scope applies. On the proved narrow Ancient Place band, the existing local search succeeds even though the full-room lattice, Recast and sampled portal planner miss it.

## Where coverage is lost

**Open Konima:** the current fine search and the sampled BSP graph produce fully checked routes, while every tested Recast profile returns a partial corridor. Increasing resolution from 1/8 to 1/16 to 1/32 square does not restore it. A separate zero-radius diagnostic also remains disconnected, so ordinary radius erosion alone does not explain this miss.

The current Konima route includes an ordinary walking descent of 2649 client units, exceeding the 384-unit step threshold used by ordinary Recast adjacency. A reference-fitted directed off-mesh link can bridge this descent locally, but none of 32 tested endpoint/radius variants restores the complete route: another gap remains after the landing. Closed-door controls remain disconnected with the link. See drop-diagnostic.json. This establishes a need for native movement semantics and better connectivity compilation, not proof that one drop explains every lost connection.

**Ancient Place:** a wire-quantized narrow ledge has a direct native witness and an existing local-search route, but all mesh resolutions and the full-room fixed lattice miss it. The separate longer recorded approach remains unresolved by every tested arm; it is not evidence that the world has no route.

**Occupied exact destinations:** the static mesh proposes routes to both occupied goal controls. Native proof refuses both as object_blocked. Recast has no live-body detour adapter in this prototype. A rejected static candidate is not an accepted movement command and is not an inherent limitation of polygon navigation.

**Ceilings:** adding conventional global ceilings does not change coverage on these scenarios. A separate synthetic ceiling-profile regression shows that conventional headroom filtering removes a low-ceiling route that the floor-wall profile retains. This identifies an adaptation requirement without claiming that it is responsible for Konima's gaps.

## Build cost and representation

Across the 6 room/state bakes at 1/16 resolution, export plus bake took 286–813 ms and serialized navmeshes occupied 501–1090 KiB each. Serialized size is not peak memory or runtime heap usage. Finer 1/32 bakes increased cost without recovering the missing routes in this sample.

Geometry comes from existing BSP floor polygons, native slope/depth helpers, void declarations and collision walls. The conservative triangle soup collapses asymmetric sidedefs into symmetric barriers; it is an approximation of Meridian movement. The floor-wall profile omits global ceilings, while conventional includes them. Both use the native player radius and nominal climb, minRegionArea=0, and no invented walkable obstacle tops.

The direct BSP alternative is a sampled portal graph, not a production-quality clearance-eroded mesh. It validates directed edges with native microsteps during each query and can miss thin portal bands. Its slow large queries do not establish that every possible BSP-derived navmesh would be slow.

## Method and limits

- All arms read the same committed map bytes and frozen body fixtures. Open and closed door states use separate geometry and mesh caches. Units are explicitly converted between 64-unit protocol coordinates, 1024-unit BSP coordinates and square-unit Recast geometry.
- Every accepted candidate starts at the exact body and reaches the exact goal. Native no-slide traces check packet-quantized steps no longer than 128 client units, bodies, mandatory exclusions and any minimum-floor fence. Partial corridors, truncated straight paths, prefixes and unproved goal bridges are refused.
- Recast is genuinely Recast/Detour through recast-navigation 0.44.0 WebAssembly. The lockfile pins dependencies. No production navigation imports this experiment.
- Native and portal timing scopes include their geometry checks. Recast search time excludes the separately reported common native proof. Warm timings and finite sample quantiles are descriptive measurements on this host, not statistical tail guarantees.
- Static Recast queries do not optimize threat costs, avoid-square constraints or floor fences while searching; the common guard applies constraints afterward. No arm in this run optimizes monster exposure or chooses a refuge chain. This experiment cannot establish movement-controller parity, crowd throughput, server position confirmation, combat survival or live journey completion.
- The native proof is a static grounded collision feasibility check, not execution of a moving body's full height/time model. No fleet sessions, sockets, game packets or server state were used.

Source revision: d72d89eb18b28c89ac97194a7fd4b1ad383ba2b5. Map SHA-256: f1c6708f4f78715c6c5d99133ee1b0624f242d45468c7d082f2de80bdaaee965. Geometry manifest: fbf11b1252e73e07f1fa07f1624c374efced9c9c272b8dc7a2c539579b2ade3f. Step-mask predicate version: 7. Host: v25.2.1, win32 x64, Intel(R) Core(TM) i7-14700F. Exact experiment-file hashes, bake configurations, all timings, path coordinates, scenario provenance and failure receipts are in results.json.

## Recommended next implementation

Add Recast as a candidate generator behind the current fine-route interface. Prove every candidate with the native validator and immediately fall back to current bounded local, declared/baked or fine planners when a complete checked path is unavailable. Keep room exits, door actions, passage admission, movement ownership and keeper survival in their existing controllers. Preserve mesh provenance against the exact collision digest and observed door state.

Before making it the default, resolve Konima's remaining directed connectivity gaps and the Ancient Place narrow band, add body/constraint-aware replanning, then measure complete journeys on the shadow fleet. Nothing here has been enabled in production.
