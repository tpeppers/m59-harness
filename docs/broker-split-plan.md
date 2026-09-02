# Untangling the broker: per-character processes

A plan to fix the latency problem where GOAP passes, the HTTP server, and the
dashboard all share one event loop, causing 11+ second response times on health
checks while characters are fighting.

**Decision: each character runs in its own process.** The broker becomes a thin
HTTP/RPC gateway that talks to per-character keeper processes. No shared event
loop, no `worker_threads`, no IPC within one process. The simplest possible
isolation: one process per character, talking over localhost.

---

## 0. The problem

The broker (`m59-broker.mjs`, 15,335 lines) runs everything in one process:

- The HTTP server (port 8901) — MCP tools, health checks, fleet state
- The dashboard (port 8902) — fleet page, hero pages
- 5+ character keepers — each running a GOAP loop at 1-pass-per-second
- The rejoin watcher (every 45s)
- The ability sweep (every 120s)
- The ledger, reconciler, weapon errands, pilot watch

Each GOAP pass that calls `scavenge` does:
1. `takeSafeSpot` — walk to a wall (~10-20 steps × 250ms = 2.5-5s)
2. `walkTo` the mob (~10-30 steps × 250ms = 2.5-7.5s)
3. `attack` (1 swing × 1050ms = ~1s)
4. `walkTo` back to the wall (~10-30 steps × 250ms = 2.5-7.5s)
5. `fight` 10 rounds × 2 swings × 1050ms = ~21s

**Total: 30-40 seconds of paced work per scavenge pass.** During that time the
event loop is not *blocked* (it's `await`ing `setTimeout` and socket I/O), but
it is *busy* — the pacer's `pump()` is running a tight while-loop, and every
HTTP request has to queue behind it. The result: 11.5s for a health check.

With 5 characters, up to 5 of these can be running concurrently. The event
loop is a single thread — there is no parallelism, only interleaving. The
interleaving is fine for `await setTimeout`, but the pacer's pump loop
`while (this.q.length)` holds the event loop in a tight async loop that
re-enters on every microtask, starving the HTTP server's socket reads.

### What "async hell" means (and why we avoid it)

The tempting fix is to make the pacing truly non-blocking: replace the
sequential `await` chain in `walkTo`/`fight` with a fire-and-forget pattern
where movement commands are queued and the GOAP pass returns immediately.
This is async hell because:

- The GOAP planner reads world state to make decisions. If the movement
  commands haven't been confirmed by the server yet, the world state is
  stale and the plan is wrong.
- The pacer exists to respect server rate limits. Decoupling it from the
  caller means the caller can't know when a command was actually sent,
  so it can't know when to re-read the world.
- Every call site (`walkTo`, `fight`, `leaveVia`, `step`, `stepFine`,
  `walkFine`, `pull`) would need to be rewritten to handle "I asked for a
  move but I don't know if it happened yet."
- The error handling, re-planning, and stuck detection all assume
  synchronous movement: "I asked to walk, I arrived (or didn't), now I
  decide the next step."

**We do not do this.** The pacing stays synchronous. We isolate it instead.

---

## 1. Target architecture

```
┌─────────────────────────────────────────────────────────┐
│  broker (HTTP/RPC gateway)                              │
│  - serves MCP tools on :8901                            │
│  - serves dashboard on :8902                            │
│  - health check, fleet state, rejoin watcher            │
│  - NO keepers, NO pacing, NO walkTo, NO fight           │
│  - thin: ~2000 lines, mostly HTTP routing               │
└──────────┬──────────┬──────────┬──────────┬─────────────┘
           │          │          │          │
     ┌─────┴───┐ ┌────┴────┐ ┌──┴─────┐ ┌──┴────────┐
     │ keeper  │ │ keeper  │ │ keeper │ │ keeper    │
     │ t1      │ │ t2      │ │ t3     │ │ t5        │
     │ :8911   │ │ :8912   │ │ :8913  │ │ :8915     │
     │ (own    │ │ (own    │ │ (own   │ │ (own      │
     │  event  │ │  event  │ │  event │ │  event    │
     │  loop)  │ │  loop)  │ │  loop) │ │  loop)    │
     └─────────┘ └─────────┘ └────────┘ └───────────┘
```

Each keeper process:
- Owns one character's game session (TCP socket to the game server)
- Runs its own GOAP loop (1 pass/sec)
- Runs its own pacer, walkTo, fight, takeSafeSpot
- Exposes a small HTTP API on a unique port (8911-8950)
- Reports its state to the broker periodically

The broker:
- Starts/stops keeper processes
- Proxies MCP tool calls to the right keeper
- Aggregates fleet state from all keepers
- Serves the dashboard
- Handles the rejoin watcher (tells keepers to rejoin)
- Has NO game session, NO pacing, NO movement

### Port allocation

- 8901: broker HTTP (MCP tools)
- 8902: dashboard
- 8911-8950: keeper t1-t40 (8911 + agent_index, then the first port a keeper can BIND)
- 8951-8990: reserved for future use

**THE KEEPER RANGE IS FORTY PORTS WIDE AND IT HAS NEIGHBOURS.** `8911 + agent_index` was
only ever a starting guess, and two things collide with it in practice:

- **Two fleets on one machine want the same numbers.** `prod`'s t10 and `shadow`'s shadow10
  are both index 9 and both want 8920. Whichever broker bound it first owned it, and the
  other one polled it anyway — reading a stranger's keeper and believing the answer. That is
  why `keeperPort` remembers what was actually allocated and why the free-port check is a
  bind attempt rather than an HTTP probe: "nothing answered in two seconds" is not "free",
  and reading it that way left three production characters with no keeper at all.
- **`meridian59-dum-bot` serves its strategy-control API on 8916 by default**, which is
  `KEEPER_PORT_BASE + 5`. Any fleet of six or more reaches it, so on this machine a keeper
  owns that port and answers every request the DUM bot was meant to. Observed from
  `maps/m59-strategy-game`: `GET :8916/observability` returning
  `{"error":"unknown endpoint: GET /observability"}` — a keeper's 404, rendered in a page as
  though the bot had refused. The two are distinguishable by `/health`: a keeper names its
  `agent`, the DUM control service names its `fleet`. Either side can move; whoever does not
  should at least identify who answered before reporting a failure.

---

## 2. Keeper process API

Each keeper exposes a small HTTP API on its port. All endpoints are
`GET` or `POST` with JSON bodies.

### `GET /health`
```json
{
  "ok": true,
  "agent": "t1",
  "character": "Gountrug",
  "in_game": true,
  "room": {"name": "East Jasper", "num": 477},
  "health": 45, "max_health": 54,
  "goal": "has_loot",
  "pass": 342,
  "last_pass_ms": 1200,
  "uptime_s": 3600
}
```

### `GET /state`
Full fleet-state entry for this character:
```json
{
  "agent": "t1",
  "character": "Gountrug",
  "in_game": true,
  "room": {"name": "East Jasper", "num": 477},
  "hp": {"value": 45, "max": 54},
  "vigor": {"value": 30, "max": 40},
  "mana": {"value": 20, "max": 25},
  "gold": 150,
  "equipment": ["oak bow"],
  "pack": ["arrow (x20)", "ration"],
  "goap": {"goal": "has_loot", "action": "scavenge", "plan": ["scavenge"]},
  "log_tail": ["last 20 log lines"]
}
```

### `POST /join`
```json
{"account": "costas2", "password": "costas", "character": "Gountrug"}
```
Joins the game. Returns `{ok: true}` or `{ok: false, reason: "..."}`.

### `POST /leave`
Leaves the game. Returns `{ok: true}`.

### `POST /rejoin`
Disconnects and re-joins. Used by the broker's rejoin watcher.

### `POST /pass`
Forces a GOAP pass immediately (for debugging).

### `POST /policy`
Updates the keeper's policy (hunt target, thresholds, etc.).
```json
{"hunt": "giant rat", "fleeBelow": 0.4}
```

### `POST /stop`
Gracefully stops the keeper (saves state, disconnects, exits).

### `GET /log`
Returns the last N log lines.
```
GET /log?n=50
```

### `POST /cancel`
Cancels the current movement/fight action (sends a new movement
generation, which invalidates in-progress walks).

---

## 3. Broker changes

### What moves out of the broker

| Component | Current location | New location |
|-----------|-----------------|--------------|
| Game session (TCP socket) | `Session` class in broker | Keeper process |
| Pacer | `Pacer` class in broker | Keeper process |
| `walkTo`, `step`, `stepFine`, `walkFine` | `Session` methods | Keeper process |
| `fight()`, `doFight()` | `m59-skills.mjs` | Keeper process |
| GOAP keeper loop | `m59-keeper-goap.mjs` | Keeper process |
| Autopilot (legacy + GOAP) | `m59-autopilot.mjs` | Keeper process |
| Atomics (scavenge, bank, buy, etc.) | `m59-act/*.mjs` | Keeper process |
| World state computation | `m59-worldstate.mjs` | Keeper process |
| Safe spot logic | `m59-safespots.mjs` | Keeper process |

### What stays in the broker

| Component | Why |
|-----------|-----|
| HTTP server (MCP tools) | Single entry point for agents |
| Dashboard rendering | Aggregates all keepers |
| Fleet state file (`fleet-state.json`) | Single source of truth for credentials |
| Rejoin watcher | Needs to coordinate across all keepers |
| Ledger, reconciler, weapon errands | Fleet-wide coordination |
| MCP tool routing | Maps tool names to keeper ports |
| Lock file management | Prevents two brokers on one fleet |
| `m59-which.mjs` logic | Fleet resolution |

### MCP tool routing

The broker's MCP tools currently operate on the session directly. After the
split, they need to proxy to the keeper:

```
Agent calls: m59_walk(agent="t1", col=10, row=5)
  → broker receives on :8901
  → broker looks up t1's keeper port (8911)
  → broker POSTs to http://127.0.0.1:8911/walk {col:10, row:5}
  → keeper executes walkTo, returns result
  → broker returns result to agent
```

Most MCP tools are read-only (state, stats, room) — these proxy to
`GET /state` on the keeper. Mutation tools (walk, attack, rest, etc.)
proxy to a `POST /action` endpoint on the keeper.

**New keeper endpoint:**
```
POST /action
{"name": "walk", "args": {"col": 10, "row": 5}}
{"name": "attack", "args": {"target": "giant rat"}}
{"name": "rest", "args": {}}
```

This keeps the keeper's API small — one mutation endpoint, not one per
action. The keeper routes by name internally.

---

## 4. Keeper process structure

The keeper process is a new entry point: `tools/m59-keeper-process.mjs`.

```
m59-keeper-process.mjs
  ├── reads its agent ID and port from argv/env
  ├── loads credentials from fleet-state.json
  ├── creates a Session (moved from broker)
  ├── creates a Pacer (moved from broker)
  ├── starts the GOAP loop (1 pass/sec)
  ├── starts an HTTP server on its port
  └── handles signals (SIGTERM → save state, disconnect, exit)
```

### What it imports (moved from broker)

- `Session` class (or a slimmed-down version)
- `Pacer` class
- `walkTo`, `step`, `stepFine`, `walkFine` methods
- `m59-skills.mjs` (fight, walkTo wrappers)
- `m59-keeper-goap.mjs` (GOAP keeper)
- `m59-autopilot.mjs` (legacy keeper, for fallback)
- `m59-act/*.mjs` (atomics)
- `m59-worldstate.mjs`
- `m59-safespots.mjs`
- `m59-world.mjs`
- `m59-roo.mjs` (pathfinding)
- `m59-client.mjs` (game protocol)

### What it does NOT import

- The MCP server
- The dashboard
- The rejoin watcher
- The ledger/reconciler/weapon errands
- The fleet state file writing (it reads credentials, the broker owns writes)

### Process lifecycle

1. **Start**: broker spawns `node tools/m59-keeper-process.mjs --agent t1 --port 8911`
2. **Ready**: keeper binds its HTTP port, broker polls `/health` until it responds
3. **Join**: broker sends `POST /join` with credentials
4. **Running**: keeper runs its GOAP loop, broker polls `/health` every 10s
5. **Stop**: broker sends `POST /stop`, keeper saves state, disconnects, exits
6. **Crash**: broker detects keeper death (health poll fails), restarts it

### State persistence

The keeper writes its latest observed state to `substrate/keeper-t1.json` after a real
HTTP reader refreshes the snapshot. Refreshed values coalesce behind one trailing timeout,
at most once per 30 seconds. A graceful stop or ordinary process exit performs one final
flush. An unobserved keeper owns no persistence timer and does not build state for disk.

State includes: current room, position, health, pack, equipment, GOAP state
(goal, target, persisted target ID), safe spot book entries.

The file is an operator/debugging snapshot, not a recovery source; current code does not
load it on restart. Credentials and durable orders come from `fleet-state.json` (owned by
the broker), while the restarted keeper reconstructs live state from the server.

---

## 5. Phased implementation

### Phase 1: C — Reduce per-pass blocking (quick win, ~1 hour)

**Goal: reduce the 11s health check to <2s without any architectural change.**

Changes to `tools/m59-act/scavenge.mjs`:
- Reduce `rounds` from 10 to 3
- Reduce `swingsPerRound` from 2 to 1
- Reduce `maxSteps` on walkTo calls from 15/30 to 10/20
- The GOAP re-plans every second, so the fight continues across passes

Changes to `tools/m59-skills.mjs` `fight()`:
- Reduce default `rounds` from 10 to 3
- Reduce default `swingsPerRound` from 2 to 1

Changes to `tools/m59-keeper-goap.mjs`:
- Add a `maxPassMs` guard: if a pass takes >5s, abort the current
  action and re-plan. This prevents a single pass from monopolizing
  the event loop for 30+ seconds.

**Verification:** `curl /health` should respond in <2s while a
character is fighting.

**Risk:** Low. The characters fight less per pass but the GOAP
re-plans continuously, so they still complete kills. The only
behavioral change is that fights take more passes (more re-planning
overhead), which is the correct trade-off for a responsive broker.

### Phase 2: D — Separate the dashboard (medium effort, ~2-3 hours)

**Goal: move the dashboard to its own process so it doesn't compete
with the HTTP server for the event loop.**

The dashboard currently renders HTML by reading all 5 sessions' state
synchronously. This is expensive (5 × room contents, 5 × stats, etc.)
and happens on every page load.

Changes:
1. New file: `tools/m59-dashboard-server.mjs`
   - Stands up its own HTTP server on :8902
   - Polls the broker's `/fleet-state` endpoint every 5s
   - Renders the dashboard from cached state
   - No game sessions, no pacing, no movement

2. Broker change:
   - Remove `serveDashboard(dashboardPort)` from `m59-broker.mjs`
   - Add a `/fleet-state` endpoint that returns aggregated state
     from all sessions
   - The broker starts the dashboard server as a child process

3. `m59-service.mjs` change:
   - Start the dashboard server separately
   - Track its PID for `stop`/`restart`

**Verification:** Dashboard page loads in <500ms regardless of what
the keepers are doing. Broker health check stays fast.

**Risk:** Low. The dashboard is read-only. The only coupling is the
`/fleet-state` endpoint, which is a simple JSON aggregation.

### Phase 3: A — Per-character keeper processes (large effort, ~1-2 days)

**Goal: each character runs in its own process, fully isolated.**

This is the big one. It's the plan in §1-4 above. Sub-phases:

#### 3a: Extract the Session class (~3-4 hours)

Move `Session` and its dependencies from `m59-broker.mjs` to a new
file `tools/m59-session.mjs`. This is the hardest part — the Session
class is deeply entangled with the broker:

- It references `sessions` (the Map of all sessions) for peer detection
- It uses `fleetState` for credentials
- It calls back into the broker for chat listening
- The Pacer is a Session property
- `walkTo`/`step`/`stepFine` are Session methods

Approach:
1. Create `tools/m59-session.mjs` with a `Session` class
2. The Session takes its dependencies as constructor params:
   - `credentials` (account, password, character)
   - `name` (agent ID)
   - `callbacks` (onRoomChange, onHealthChange, onDeath, etc.)
   - `peers` (a function that returns the list of other agent names)
3. Move all movement methods (walkTo, step, stepFine, walkFine,
   leaveVia) into the Session class
4. Move the Pacer into the Session
5. The broker imports Session from m59-session.mjs
6. The broker's `sessions` Map still exists, but each Session is
   now self-contained

**Key constraint:** This must be a pure refactoring. No behavior
change. The broker still runs all sessions in-process. Verify with
`m59-which.mjs` and a live fleet before moving to 3b.

#### 3b: Create the keeper process entry point (~2-3 hours)

New file: `tools/m59-keeper-process.mjs`

```js
// m59-keeper-process.mjs
// One process per character. Runs the GOAP loop and a small HTTP API.
//
// Usage: node tools/m59-keeper-process.mjs --agent t1 --port 8911
//        --fleet substrate/fleet-state.json

const agent = argv[argv.indexOf('--agent') + 1];
const port = Number(argv[argv.indexOf('--port') + 1]);
const fleetPath = argv[argv.indexOf('--fleet') + 1];

// Load credentials
const fleet = JSON.parse(read(fleetPath));
const creds = fleet[agent].credentials;

// Create session
const session = new Session(creds, agent);
await session.join(creds);

// Start GOAP loop
const keeper = new GoapKeeper(session, policy);
keeper.loop().catch(console.error);

// Start HTTP API
serveKeeperApi(session, keeper, port);
```

The HTTP API is ~200 lines: express-free, plain `http.createServer`,
routing by URL path. Endpoints as described in §2.

**Key constraint:** The keeper process must be a drop-in replacement
for the in-process session. If I run one character in a keeper process
and the rest in the broker, the fleet should work normally.

#### 3c: Broker becomes a gateway (~3-4 hours)

Modify `m59-broker.mjs`:
1. Remove the Session creation and GOAP loop from `resumeFleet()`
2. Instead, spawn keeper processes:
   ```js
   for (const [agent, entry] of Object.entries(fleetState)) {
     const port = 8911 + index;
     spawn(`node tools/m59-keeper-process.mjs --agent ${agent} --port ${port}`);
   }
   ```
3. The broker's MCP tools proxy to keeper ports
4. The broker's `/fleet-state` aggregates from keeper `/state` endpoints
5. The rejoin watcher polls keeper `/health` and sends `POST /rejoin`

**Key constraint:** The broker must handle keeper crashes gracefully.
If a keeper process dies, the broker detects it (health poll fails),
logs it, and restarts it. The character's state is preserved in
`substrate/keeper-<agent>.json`.

#### 3d: Testing and rollout (~2-3 hours)

1. Start with 1 character in a keeper process, 4 in the broker
2. Verify the fleet works: `m59-which.mjs`, dashboard, MCP tools
3. Move all 5 characters to keeper processes
4. Verify the broker has NO game sessions (only HTTP + dashboard)
5. Load test: fight + health check + dashboard simultaneously
6. Verify health check responds in <200ms

**Rollback:** If the per-process architecture has problems, the broker
can fall back to in-process sessions. The Session class is the same —
it's just running in a different process. The `--in-process` flag on
the broker disables keeper process spawning.

---

## 6. What we explicitly do NOT do

- **We do not make the pacing async.** The pacer stays synchronous.
  The fix is isolation, not concurrency.
- **We do not use `worker_threads`.** Separate processes are simpler
  to debug, restart, and kill. A worker thread that crashes takes the
  whole process with it.
- **We do not add a coordination layer between keepers.** The
  characters don't need to talk to each other. If they do in the
  future, it's a separate problem with a separate design.
- **We do not use a message queue, Redis, or any external
  infrastructure.** The communication is localhost HTTP between
  processes. If that's not fast enough (it will be — localhost HTTP
  is ~1ms), we'll know and can add something.
- **We do not rewrite the game protocol client.** `m59-client.mjs`
  stays as-is. The keeper process owns the TCP socket to the game
  server.
- **We do not change the GOAP planner, the atomics, or the world
  state computation.** They move to the keeper process unchanged.

---

## 7. Files created/modified

### New files
- `tools/m59-session.mjs` — extracted Session class (Phase 3a)
- `tools/m59-keeper-process.mjs` — keeper process entry point (Phase 3b)
- `tools/m59-dashboard-server.mjs` — standalone dashboard (Phase 2)
- `tools/m59-keeper-process-test.mjs` — offline tests for keeper process

### Modified files
- `tools/m59-broker.mjs` — remove sessions, add proxy (Phases 2-3)
- `tools/m59-act/scavenge.mjs` — reduce rounds/swings (Phase 1)
- `tools/m59-skills.mjs` — reduce default fight params (Phase 1)
- `tools/m59-keeper-goap.mjs` — add maxPassMs guard (Phase 1)
- `tools/m59-service.mjs` — manage keeper processes + dashboard (Phases 2-3)
- `tools/m59-which.mjs` — report keeper process status

### Unchanged
- `tools/m59-client.mjs` — game protocol
- `tools/m59-goap-planner.mjs` — GOAP planner
- `tools/m59-worldstate.mjs` — world state
- `tools/m59-safespots.mjs` — safe spot book
- `tools/m59-roo.mjs` — pathfinding
- `tools/m59-world.mjs` — world model
- All `tools/m59-act/*.mjs` — atomics (they move, not change)

---

## 8. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Session extraction breaks movement | Medium | High | Phase 3a is a pure refactor. Test with live fleet before moving on. Keep `--in-process` fallback. |
| Keeper process crashes take character out | Low | Medium | Broker restarts the keeper from the durable fleet roster; the character re-joins and reconstructs live state. |
| Two brokers start, both spawn keepers | Low | High | Lock file. Keeper process checks if its port is already in use. |
| Keeper process leaks (doesn't die on stop) | Low | Medium | `POST /stop` sends SIGTERM to self. Broker sends SIGKILL after 5s timeout. |
| MCP tool proxy adds latency | Low | Low | Localhost HTTP is ~1ms. The tool was already taking 100ms+ for the game action. |
| Dashboard polling floods keepers | Low | Low | Poll every 5s, not every request. 5 keepers × 1 poll/5s = 1 req/s total. |

---

## 9. Success criteria

After all phases are complete:

1. **Health check** responds in <200ms while all 5 characters are
   fighting, walking, and the dashboard is open in a browser.
2. **Dashboard** page loads in <500ms under the same conditions.
3. **Killing a keeper process** does not affect other characters.
   The broker restarts the dead keeper within 10s.
4. **Restarting the broker** does not lose any characters. Keepers
   survive broker restart (they're separate processes).
5. **`m59-service.mjs stop`** stops the broker AND all keepers.
6. **`m59-service.mjs start`** starts the broker AND all keepers.
7. **`m59-which.mjs`** shows keeper PIDs and their health.

---

## Phase 1 results (2026-08-19)

**Implemented:**
- `scavenge.mjs`: rounds 10→3, swingsPerRound 2→1, pull capped at 12 steps, safe spot walk capped at 8 steps, `atWall` tracked separately from `spotCol`
- `skills.mjs`: rounds 12→3, swingsPerRound 4→1, approach capped at 6 grid steps / 8 raw cells, fine grid fallback capped at 10 steps, room refresh skipped when `holdPosition=true`
- `keeper-goap.mjs`: 8s SLOW pass logging (does not abort — aborting mid-atomic is not safe)
- `broker.mjs` Pacer: `setTimeout(0)` yield when `wait=0`, `setImmediate` yield after every job
- `flee.mjs`: maxSteps 30→12

**Results:**
- Characters at walls: "holding safe spot" passes in **0-1ms** (was 5-20s)
- Characters not at walls: still 6-43s during approach walks and `travel_to_hunt`
- Health check: 20-30ms when no walk in progress, 3-28s when a walk is in progress
- Before Phase 1: 11.5s consistently

**Not achieved:**
- Health check <2s while any character is walking — requires Phase 3 (per-character processes)

**Next:** Phase 2 (dashboard separation) or Phase 3 (per-character processes).
