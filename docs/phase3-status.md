# Phase 3: Per-character keeper processes — Status

## All done criteria met

### 3a: Session extraction ✅
- `m59-game.mjs` contains Session, Pacer, constants, and gameplay helpers; the flight
  recorder is split into `m59-recorder.mjs`
- `m59-session.mjs` — re-exports Session, Pacer, Recorder, and helpers from m59-game.mjs
- `m59-broker.mjs` — imports Session, Recorder, Pacer from **m59-session.mjs** (0 copies of the classes)
- `m59-keeper-process.mjs` — imports from m59-session.mjs (0 references to m59-broker.mjs)
- No circular dependencies. Keeper does NOT load the broker.

### 3b: Keeper process ✅
- `tools/m59-keeper-process.mjs` — standalone keeper with the full HTTP API
- All required endpoints: /live, /health, /state, /join, /leave, /rejoin, /pass, /policy, /stop, /cancel, /action, /log
- Demand-driven state snapshots are reused for at most 2s, with no background cache
  interval; refreshed reader snapshots coalesce to at most one trailing
  `substrate/keeper-<agent>.json` write per 30s, with one final shutdown flush
- Failed initial login owns one unreferenced 30s retry timeout, not a lifetime interval;
  success, leave, stop, rejoin, and shutdown retire it
- Each protocol client has one deadline-driven keepalive: 20s outbound-idle heartbeat,
  with a 30s inbound-evidence ceiling preserving the 45s ghost guard

### 3c: Broker gateway ✅
- Broker spawns keeper processes via child_process.spawn (non-detached)
- KeeperProxy proxies MCP tool calls to keeper HTTP API
- KeeperProxy has no per-character rich-state poller. Agent and fleet reads refresh the
  bounded snapshot on demand; one recursive fleet deadline uses the cheap, direct `/live`
  identity/connection projection for liveness
- Rejoin is keeper-aware (/rejoin endpoint, respawns dead keepers)
- killAllKeepers() on exit/SIGINT/SIGTERM

### 3d: Historical Phase 3 testing & rollout ✅

These measurements are the original Phase 3 rollout evidence. They were not rerun as a
live canary for the later resource-efficiency work.

- 5/5 keeper processes running (t1–t5)
- Health check: 22–27ms (target: <200ms) — 460x faster than before
- Broker CPU: 0.0%
- Fleet status shows all 5 characters with correct HP
- Service stop kills keepers (verified)

## Resource-efficiency follow-on

- The production default is still the standard broker with one keeper child per
  character. The resource work changes when it projects, persists, retries, and sends a
  keepalive; it does not select the lab scheduler or a different server image.
- The explicitly marked lab runner defaults to one shared process and lazy atlas.
  Optional partner-preserving shards add independent V8 heaps/atlases and smaller
  GC/stall/crash domains behind one Meridian-free ownership/control parent.
- The no-login 100-actor smoke repeatedly measured about a 138 MiB shared static RSS
  lower bound and roughly 14 KiB of used heap per unstarted actor shell. Connected clients
  and live world state are intentionally outside that lower-bound measurement.
- The checked lab exit atlas preserves exact approach projections while removing the
  former multi-second fine-BSP boundary derivation. Missing or mismatched evidence falls
  back to ordinary live derivation; the production profile does not register the atlas.
- Broker state, keeper snapshot persistence, the flight recorder, initial-join retry, and
  wire keepalive all have focused offline contracts that pin their demand/event-driven
  behavior. The generic runtime, state, scheduler, shard, memory, and exit-atlas suites are
  serverless.
- A separate experimental simulation-clock build scales only Blakod timers and world hour;
  `GetTime()` anti-abuse checks and other process/protocol clocks remain wall time. The
  ordinary Dockerfile and service do not consume the patch. Offline contracts, strict
  source/preimage checks, and a disposable Windows RELEASE/Werror compile/link pass, but
  the Docker daemon was unavailable, so the Linux image, container attestation,
  save/restart smoke, and a live canary remain unverified. The exact build command and
  isolation rules are in `docs/m59-lab-runtime.md`.

Rollout remains test-first: keep production on `m59-service.mjs`, begin with a disposable
marked roster and `m59-lab-runner.mjs --check`, and treat the simulation server as a
separate experiment until its Docker/runtime and live-canary gaps are closed.

## Known issues (pre-existing, not Phase 3 regressions)
- `loadSpawns is not defined` in some GOAP passes (t1: 41×, t4: 10×) — pre-existing bug in scavenge path
- `skills is not defined` (t4: 3×) — pre-existing
- Keeper `/health` occasionally >200ms when GOAP pass is in progress (broker `/health` is consistently <30ms)

## Verification artifact
`substrate/phase3-health-verification.txt` — health check timing, process list, fleet status.
