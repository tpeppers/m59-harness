# The DebugClient: the patched client the fleet terminal launches

Read from source on 2026-10-21. Line numbers are at harness `f6011623` and client `d9d78a6e`,
except `planpane.c` and the plan desk, which are cited at the MANAGE-tab commit that rewrote
them (client `70a2b8dc`). Path prefixes: `H/` = this repository, `C/` = `C:\code\Meridian59`.

**Managing the fleet from it** is the MANAGE tab (formerly PLAN), covered in depth in
[`m59-plan-tab.md`](m59-plan-tab.md). This page is the whole client: what it is, how it is
launched, every switch it reads, and every surface it adds.

## Bottom line

The DebugClient is `C/run/localclient/meridian.exe`: an **x64 build of the tpeppers Meridian59 fork**, not the
32-bit Steam `Meridian.exe` (`H/tools/m59-devclient.mjs:11-21,48-49`; `H/tools/m59-inject.ps1:6-11`). Every
harness feature is **switched on by environment variables**, so with none set it plays like stock
(`C/clientd3d/m59dbg.c:26-28`). Some behaviour changes are always on: no idle logoff, safety on at every
login, buy quantity opens at 50, profanity filter off by default, and frame pacing.

- **Launch:** select a character in `node tools/m59-tui.mjs` and press **L**. The terminal uses the
  DebugClient whenever the exe exists. `M59_TUI_STOCK_CLIENT=1` forces Steam (`H/tools/m59-tui.mjs:16-22,659`).
  Without the terminal: `node tools/m59-tui.mjs --launch <agent>` (same code path, prints the log tail;
  `:1136-1167`), or `node tools/m59-devclient.mjs --fleet <f> <char> [--launch]` / `shortcuts\dev.bat <host>
  <port> <account> <password> [label]` (`H/tools/m59-devclient.mjs:4-9,132`).
- **Binary path:** `M59_CLIENT`, else `<M59_SOURCE or C:\code\Meridian59>\run\localclient\meridian.exe`
  (`H/tools/m59-devclient.mjs:48-49`). The client makefile copies its output there (`C/common.mak:59`).
- **Build:** `cd C:\code\Meridian59` then `"...\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && nmake /nologo RELEASE=1 Bclient Bmodules`.
  It must be vcvars**64**: an x86 object fails the link with LNK1112 (`H/tools/m59-devclient.mjs:303-308`).
  `node tools/m59-devclient.mjs --check` reports whether the exe is built. The MANAGE/DUM tabs live in
  `merintr.dll`, which only `Bmodules` builds (`C/makefile:25`): `Bclient` alone keeps the old tab.

## How it differs from the Steam client (fork commits)

| commit | date | what | always on? |
|---|---|---|---|
| `9ee73510` | 08-17 | `m59dbg.c`: automap overlay from `.ovl` files, position caption, F5-F8 UDP signals (`C/clientd3d/m59dbg.c:11-31`) | gated by env |
| `ee06710c` | 08-17 | incoming profanity filter defaults off (`C/clientd3d/config.c:272`) | yes |
| `8961564b` | 08-25 | help key opens the harness room view (`C/clientd3d/winmsg.c:28-48`) | gated by `M59_MAP_URL` |
| `361383d3` | 08-25 | F9 record toggle, `[* RECORDING *]` in caption (`C/clientd3d/m59dbg.c:706-718,971`) | gated by `M59_SIGNAL_PORT` |
| `6f24dfc1` | 08-26 | idle logoff never arms (`C/clientd3d/logoff.c:108-120`) | yes |
| `1fb1f514` | 08-27 | safety ON at every login (`C/clientd3d/config.c:249-260`); stackable buy opens at 50 (`C/clientd3d/buy.c:20,225`) | yes |
| `14f193e6` | 10-14 | DUM + PLAN tabs, inventory sell/keep badges, condition pips, `M59ObservedDescription` look hook, object annotation halos + `turn=`, `plan`/`fs` chat commands, KEEPER veto. Also carries the native-context work that sat uncommitted since 09-09 (commit message) | gated by env |
| `d7c1f227` | 10-14 | PLAN rows with args/settings open in their own window; room players (`W` rows) go to the desk | — |
| `32b30cb0` | 10-15 | PLAN parser skips rows past a cap instead of rejecting the reply (`C/module/merintr/planpane.c:109-112`) | — |
| `70a2b8dc` | 10-21 | PLAN tab renamed **MANAGE**; protocol 2: agents multi-select, sliders with dependent ranges, combos, dependent dropdowns, nested FleetScript forms, 16 args | — |
| `d9d78a6e` | 10-16 | present on vblank in both GPU modes; max 30 fps when minimized/unfocused (`C/clientd3d/d3ddriver.c:103`, `C/clientd3d/graphics.c:58,348-350`) | yes |
| `de3d49e1` | 07-30 | Steam Deck gamepad + full screen (`clientd3d/gamepad.c`, `fullscreen.c`) | config |

Server-side commits in the same fork (`2c6d8091`, `e8a6b53f`) and CI commits do not affect the client.

## Launch path end to end

### L (`launch()`, `H/tools/m59-tui.mjs:652-821`)

1. **Credentials and server** come from the roster entry, falling back to `M59_HOST`/`M59_PORT` (`:653,676-677`).
2. **Pick the exe:** the DebugClient if Windows, `!M59_TUI_STOCK_CLIENT` and the exe exists. Otherwise Steam via `findClient()` (`:659-663`).
3. **PLAN plumbing** (DebugClient only, not via a swarm proxy, no gate/remote, `M59_TUI_NO_PLAN!=='1'`; `:688-701`):
   - `ensurePlanProxy`: if nothing listens on **5962** (`M59_PLAN_PROXY_PORT`), it spawns detached
     `m59-proxy.mjs --listen 5962 --bind 127.0.0.1 --server <real> --observe --gate-control 8931 --attach 8932 --fleet-state … --fleet …`.
     It waits up to about 5 s (`:606-624`).
   - `ensurePlanDesk`: starts nothing if a desk already serves `M59_CLIENT_CONTEXT_DIR` (default `H/substrate/client-context`),
     or if a desk for this fleet runs in another checkout. Otherwise it spawns detached `m59-plan-desk.mjs --fleet … --substrate <M59_PLAN_SUBSTRATE or H/substrate>` (`:625-643`).
     Normally the **broker** already runs the desk (`H/tools/m59-broker.mjs:6366-6374`).
   - The client connects via `127.0.0.1:5962` **only if** that proxy's advert says it fronts this character's server (`:699`).
4. **Write `shortcuts\dev.bat`** if it is stale (`ensureUniversalLauncher`, `H/tools/m59-devclient.mjs:230-240`). PowerShell then runs it hidden with
   the five args (`devStartLines`, `H/tools/m59-tui.mjs:854-872`) and finds the new `meridian.exe` by `/U:<account>` and creation time.
   It gives up after 15 s.
5. **dev.bat** (`H/tools/m59-devclient.mjs:152-224`) fills in each env var that is not already set (`:187-195`). It then asks
   `node m59-devclient.mjs --endpoint <host> <port>` for a proxy fronting that server (prefers a gate-capable one, `:95-125,281-287`),
   `cd`s to the exe's directory and runs `start "" meridian.exe /H: /P: /U: /W: /Q` (`:216-221`).
6. **Pilot claim** from the PowerShell script: a POST `pilot {action:claim, agent, pid}` to the broker, which stops the keeper (`H/tools/m59-tui.mjs:760-774`).
   It then waits up to 60 s for a window, sleeps 3 s, and runs `m59-inject.ps1`, which injects `m59agent64.dll` (`:775-782`, `H/tools/m59-inject.ps1:2-11`).
7. **Log:** stdout and stderr are appended to `H/substrate/m59-launch.log` (`:721-723`).
8. **Rearm:** the terminal calls `pilot {action:'rearm'}` so the broker scans for the new client. This is skipped for a remote broker or gate (`:816-820`).
9. The status line says to **keep the client focused or it drops movement** (`:801`).

### S (swarm, `H/tools/m59-tui.mjs:948-969`)

- It calls `launch(row, {viaProxy:true})`. This **skips the PLAN plumbing** and goes through the **5961 observe-only shim**
  (`ensureProxy`, `:557-593`). The shim gets `--gate-control` only if `M59_PROXY_GATE_CONTROL` is set.
- It then spawns detached `m59-swarm.mjs start --leader <agent>` (log `substrate/swarm-<fleet>.out`). The swarm admits your room
  and walk-ins, never a body under 30 max HP. Survival, mortality and recovery stay with each keeper.
- **V** (PvP camera, `:1011-1036`) is the same as S, plus `M59_ANNOTATE_PORT=8930+hash%60` (`:992-997`), `m59-cameraman.mjs` and `m59-pvp-capture.mjs`.

## Environment variables the client reads

| var | read at | set by dev.bat to | switches on |
|---|---|---|---|
| `M59_OVERLAY_DIR` | `C/clientd3d/m59dbg.c:434-439` | `H/substrate/overlay` | automap overlay `<dir>\<room objid>.ovl`, re-read on mtime change about every 1 s (`:902-933`) |
| `M59_SIGNAL_PORT` | `m59dbg.c:441-442` | `8907` | outbound UDP JSON to loopback on room entry and F5-F9 (`:654-677,687-725`) |
| `M59_DEBUG_TITLE` | `m59dbg.c:444-445` | `1` | caption `M59 <acct> \| <room id> <name> \| sq r,c \| fine x,y \| ovl… [* RECORDING *]` (`:960-972`). Defaults on even if unset (`:71`) |
| `M59_MAP_URL` | `m59dbg.c:452-453` | `http://127.0.0.1:8977` | help key opens `<url>/<harness room#>` (needs a loaded overlay with a `room` line) or `<url>/` (`:141-150`) |
| `M59_ANNOTATE_PORT` | `m59dbg.c:490-521` | not set (V sets it) | inbound loopback UDP: `id=<obj> colour=RRGGBB ttl=<ms>` object halos (16 slots, ttl 1 s-10 min) and `turn=<0..4095>` |
| `M59_CLIENT_CONTEXT_DIR` | `C/module/merintr/clientcontext.c:145-149` | `H/substrate/client-context` | DUM and MANAGE tabs (6 buttons instead of 4, `C/module/merintr/statbtn.c:37-38`) and the `manage`/`plan`/`fs` commands |
| `M59_INVENTORY_INTENT_DIR` | `C/module/merintr/inventoryintent.h:40-41` | not set | sell/keep badges dir. If unset it uses `<parent of M59_OVERLAY_DIR>\inventory-intent` (`:42-44`) |
| `M59_INVENTORY_SERVER` | `clientcontext.c:33`, `inventoryintent.h:90` | `%1:%2` (the real server, **before** proxy routing) | the server identity in DUM/PLAN/badge files, so a proxied client still binds to the real world |

The launcher also reads: `M59_DEVCLIENT_DRYRUN` (dev.bat prints the endpoint and starts nothing, `H/tools/m59-devclient.mjs:208-211`),
`M59_CLIENT`, `M59_SOURCE`, and the TUI's `M59_TUI_STOCK_CLIENT`, `M59_TUI_NO_PLAN`, `M59_PLAN_SUBSTRATE`,
`M59_PLAN_PROXY_PORT`/`_GATE_PORT`/`_ATTACH_PORT` (5962/8931/8932), `M59_PROXY_PORT` (5961) and `M59_PROXY_GATE_CONTROL`.
A variable the caller already set wins over dev.bat (`if not defined`).

## UI surfaces

### Automap overlay, caption, hotkeys, annotations (`C/clientd3d/m59dbg.c`)

- **Overlay** (`.ovl`, text): `rows/cols/shift/security/room/name`, `color <ch> <hex> [solid|hatch|cross|diag] [label]`,
  `mark <r> <c> <hex> [label]`, and a `grid` block (`:304-368`). A file whose `security` does not match the room's is refused as
  `ovl WRONG ROOM a!=b` (`:381-392`). It is drawn under the walls on both the map and the minimap (`C/clientd3d/map.c:232,269`).
  Written by `H/tools/m59-overlay.mjs` (`OVERLAY_DIR`, `:66`) and by `H/tools/m59-annotate.mjs` marks. **Nothing writes overlays automatically on L.**
- **Hotkeys** (handled before the modules, only when the signal port is on): F5-F8 send `key`, F9 toggles `record`
  (`m59dbg.c:687-725`; hook `C/clientd3d/winmsg.c:228`). The listener is `node tools/m59-signal.mjs`, which writes the book
  `substrate/client-signals.jsonl` (`H/tools/m59-signal.mjs:2-8,32-35`).
- **Object halos:** when `DebugAnnotationFor` is true, the renderer draws the target halo on that object
  (`C/clientd3d/d3drender_objects.c:1262-1271,1825-1834`). Sources: `m59-annotate.mjs --client-port` and `m59-cameraman.mjs` (`turn=` only).

### DUM tab (`C/module/merintr/clientcontext.c`)

- **Shows** a list of DUM strategies as `[ON]/[off] <title>`, with a detail pane (`:75-81,61-74`). Also in the pane: PLAN-style text
  lines from the harness (stat values, condition legend, item purposes; `H/tools/m59-client-context.mjs:76-96`).
- **Clicks:** left-click or Space toggles a strategy. Right-click opens a menu of its settings; picking one opens an edit box, and
  Apply submits it (`clientcontext.c:100-111,88-99,139`). Types are boolean/integer/number/number-list/item-list
  (`C/module/merintr/clientcontextmodel.h:60`). This writes **local DUM policy only**. The view is greyed out when it is older than 6 s
  or bound to another identity (`clientcontext.c:59,122`).
- **Files** (every 1 s, `:112-134,164`):
  - client to harness: `<dir>\native\<pid>.tsv` with header `M59CTXREQ 1 <at> <pid> <server> <acct> <char> <player_id> <room obj> <room res> <security> <DUM|PLAN|hidden> <seq> <token> <op> <strategy> <field> <value>`,
    plus `C` (condition pips), `P` (position in 1024-unit fineness) and `N` (numeric stats from groups 1-4, `C/module/merintr/stats.c:393,432`) rows.
  - harness to client: `<dir>\views\<pid>.tsv` with header `M59CTX 1 …` and `T`/`S`/`F` rows (`clientcontextmodel.h:38-64`).
- **Served by** `H/tools/m59-client-context.mjs` (HTTP 8918, read-only). It reads `/plans` from the inventory-intent service on **8913**
  (`H/tools/m59-inventory-intent-service.mjs:81,203`) to prove the client is a **pilot-claimed** human (`m59-client-context.mjs:49-57`).
  It reads and writes DUM at **8916** `/health` and `/strategies`, and needs `strategy_cas===1` before it will save (`:68-75,145-154`).
  **Nothing in the repo starts this process** (see Problems).

### MANAGE tab (once PLAN; `C/module/merintr/planpane.c`) — depth in [`m59-plan-tab.md`](m59-plan-tab.md)

- A list of fleet intents grouped like Spells: every FleetScript, the courier's rows, the Control rows. Double-click or Enter
  runs a row; right-click describes it; a row with arguments opens a **form** in its own window. Rows come from
  `H/tools/plans/{control,courier,fleetscripts}.mjs` and `<substrate>/plans/*.mjs`.
- **Every argument is a picker** (protocol 2, client `70a2b8dc`): a multi-select of the fleet's agents (bank balances on the
  labels, the character you pilot left out), dropdowns of merchants and **what the chosen merchant sells**, banks, wanderers,
  every room by number and name, fixed choices, checkboxes, and numbers with a **slider whose range follows another field**
  (withdraw is capped at the most anyone has banked at the chosen bank). A FleetScript can take another as an argument
  (island-trip's task, chain's stages): pick it, press **Configure...**, and fill its own form on top. What each param becomes
  is `H/tools/m59-plan-kinds.mjs`; the wire format is the header of `H/tools/m59-plan-desk.mjs`.
- **Files:** `<dir>\plan\in\<pid>.tsv` (`M59PLANREQ 2 …`, `I` inventory, `W` room players, `R <seq> <entry> <args>`) and
  `<dir>\plan\out\<pid>.tsv` (`M59PLAN 1|2 … <control none|keeper|other>`, `E`/`A`/`O`/`N`/`M` rows). A request runs at
  most once, by sequence number against the ack. A client built before `70a2b8dc` asks for protocol 1 and is answered in it:
  six arguments, the new types as text boxes.
- Served by `H/tools/m59-plan-desk.mjs`, normally a child of the broker (heartbeat `<dir>plandesk.json`). A reply older than
  6 s reads as "plan desk is not answering" (`planpane.c` `Fresh`).

### KEEPER lock

- When the desk reports `control=keeper`, the MANAGE button turns red and reads **KEEPER** (`planpane.c:558`, `C/module/merintr/statbtn.c:316-322`).
- `InterfaceAction` refuses move, turn, attack, pickup, drop, put, use, unuse, offer, buy, apply, go, activate, deposit, withdraw and
  toggle-use (`C/module/merintr/mermain.c:249-251`, `planpane.c:550-557`).
- The real enforcement is the proxy gate on 5962/8931 (`H/tools/m59-proxy-gate.mjs:1-12`). While the gate is held, a spectate keeper
  attaches to your connection on 8932 (`H/tools/m59-spectate-keeper.mjs:1-8`, `H/tools/m59-proxy-attach.mjs`).

### Typed chat commands

`manage` (list rows; `plan` is the old name and still works), `manage <row-prefix> k=v …` (`%20` stands for a space; with no
args it opens the form), and `fs <fleetscript line>` (queued as row `fs.line`). Registered at `C/module/merintr/merintr.c:346-348`,
implemented at `planpane.c:560-590`.

### Inventory badges and condition pips

- **Badges:** green `$` = sell queued, blue `K` = keep, amber `$` = requested but protected. The client publishes
  `<intent dir>\clients\<pid>.tsv` (`M59PACK`) and reads `views\<pid>.tsv` (`M59SELL`) every 1 s (`inventoryintent.h:56-109`,
  `C/module/merintr/inventry.c:204,469-485`). They are served by `m59-inventory-intent-service.mjs` (`H/docs/m59-inventory-intent.md`).
- **Condition pips:** when you look at a carried item, `M59ObservedDescription` (`C/clientd3d/server.c:963-968` → `clientcontext.c:198-202`)
  maps the description text to 5 levels (`clientcontextmodel.h:65-75`). The pip is drawn on the item icon, filled for 60 s and hollow
  after that (`clientcontext.c:203-210`, `inventry.c:755-756`).

### Help key

`StartHelp` opens `M59_MAP_URL/<room#>` instead of the public guides (`C/clientd3d/winmsg.c:28-48`). This needs
`m59-roomserve.mjs` on 8977, which the TUI starts with the **G** key (`H/tools/m59-tui.mjs:1294-1320`).

## Data flow

```
                       env (dev.bat)                         UDP loopback
 meridian.exe (x64) ─────────────────── m59dbg.c ──F5-F9/room──▶ :8907 m59-signal.mjs ─▶ substrate/client-signals.jsonl
   │  ▲                                    ▲  ▲◀── id=/turn= ── :M59_ANNOTATE_PORT ◀── m59-annotate.mjs / m59-cameraman.mjs
   │  │                                    │  └── reads substrate/overlay/<objid>.ovl ◀── m59-overlay.mjs / m59-annotate.mjs
   │  │ help key ─▶ browser ─▶ :8977 m59-roomserve.mjs
   │  │
   │  ├─ client-context/native/<pid>.tsv ──▶ m59-client-context.mjs :8918 ──▶ :8913 inventory-intent /plans (pilot check)
   │  └─ client-context/views/<pid>.tsv  ◀──┘                         └──▶ :8916 DUM /strategies (policy writes)
   │  ├─ client-context/plan/in/<pid>.tsv ──▶ m59-plan-desk.mjs (broker child) ──▶ providers (courier files, fleetscripts, runlocks)
   │  └─ client-context/plan/out/<pid>.tsv ◀─┘        │ POST gate / trade/accept-from / trade/give
   │  ├─ inventory-intent/clients/<pid>.tsv ──▶ m59-inventory-intent-service :8913 ──▶ broker :8901
   │  └─ inventory-intent/views/<pid>.tsv  ◀──┘       ▼
   │  game TCP                                  :8931 gate ── m59-proxy.mjs :5962 (--observe --gate-control --attach 8932) ── game server
   └───────────────────────────────────────────────────────────▶ :5962 ─────────────────────────────────────────────▶ (5959 / 15959)
                                                                 ▲ :8932 attach ◀── m59-spectate-keeper.mjs (started by plans/control.mjs)
 broker ◀── pilot claim (PowerShell, pid) + pilot rearm (TUI); m59agent64.dll injected (MCP drive)
```

S and V go through the 5961 observe-only shim instead of 5962, so they have no gate, no Full Auto, and no attach unless
`M59_PROXY_GATE_CONTROL` is set. dev.bat finds proxies through adverts in `<evidence>/proxies/<listen>.json` (`H/tools/m59-proxy.mjs:1133-1140`).

## Known problems and limits

From docs and comments:

- `table_lookup` crash at `meridian.exe+0x44095` has not been investigated (`H/docs/m59-plan-tab.md:268`).
- A spectated logoff is capped at 20 s (`AWAY_MAX_MS`, `H/tools/m59-proxy.mjs:90`; doc `:265-267`).
- An L-started desk on the wrong substrate is mostly moot since 10-17, but still applies with an older broker or `M59_NO_PLAN_DESK=1` (doc `:260-264`).
- Keep the client focused or it drops movement (`H/tools/m59-tui.mjs:801`).
- A PLAN proxy started before attach existed has no attach port; close it and press L again (doc `:246-247`).
- Linux has no DLL injection and is playable by hand only (`H/tools/m59-tui.mjs:880-902`).
- Overlay marks name squares, not objects, and every patched client in that room sees them (`H/tools/m59-annotate.mjs:23-33`).
- The help key opens a specific room only when an overlay with a `room` line is loaded for it; otherwise it opens the index (`m59dbg.c:141-150`).
- The MANAGE tab needs a reply less than 6 s old, so the desk must work once a second while a client is open (doc `:44-50`).

Found while reading for this page (2026-10-21), none fixed yet:

- **The DUM tab has no server by default.** Nothing but its own test refers to `m59-client-context.mjs`, and the broker reads its
  output only with `M59_CLIENT_CONTEXT_URL` set (`H/tools/m59-broker.mjs:19905`). Neither L, the broker nor `m59-service` starts it.
  It also needs the 8913 service and a DUM on 8916. Until those run, the DUM tab shows only "Cached context; changes paused".
- **5962 is one per machine.** If it fronts a different server, `ensurePlanProxy` still reports "proxy up" (`H/tools/m59-tui.mjs:616,694`).
  The client then quietly goes direct or through 5961 (`:699`), with no lock and no Full Auto.
- **`m59-devclient.mjs --proxy <port>` swaps only the port** (`H/tools/m59-devclient.mjs:370`): the roster's host stays, so on prod it
  writes `76.214.42.186:5961`, finds no proxy for that address, and the client sits at a dead login screen.
- **The swarm comment contradicts the code.** `H/tools/m59-tui.mjs:934` says S "DOES NOT START A PROXY"; `:949-952` launches with
  `viaProxy:true`, which starts the 5961 shim.
- **Stale comments:** `H/tools/m59-annotate.mjs:25-27,37-39` say the halo needs a client change (it shipped in `14f193e6`);
  `C/clientd3d/m59dbg.c:685` says "these four" keys (there are five, F5-F9).

## What to do

- **Launch with L from the fleet terminal**, not dev.bat by hand: L is the only path that brings up the gate proxy and checks for a desk.
- **To direct the fleet, use the MANAGE tab.** Pick a FleetScript row; every field is a list to pick from. `buy` and `chain`
  (public, 2026-10-21) cover most one-off errands without a new script: see [`m59-plan-tab.md`](m59-plan-tab.md#managing-fleetscripts).
- **After pulling client changes, rebuild both targets:** `nmake /nologo RELEASE=1 Bclient Bmodules` under vcvars64. The tabs are in
  `merintr.dll`, so `Bclient` alone leaves the old PLAN tab in place. Close running dev clients first: they hold the DLL open.
- **Don't expect the DUM tab to work** until something starts `m59-client-context.mjs` (above).

## Files

| file | side | role |
|---|---|---|
| `C/clientd3d/m59dbg.c`, `.h` | client | overlay, caption, signals, annotations, `turn=`, room URL |
| `C/clientd3d/map.c:161,169,232,269,653` | client | init, close, draw and room-enter hooks |
| `C/clientd3d/winmsg.c:28-48,228,526` | client | StartHelp, DebugKey, DebugIdle hooks |
| `C/clientd3d/d3drender_objects.c:1262-1271,1825-1834` | client | annotation halo |
| `C/clientd3d/server.c:963-968` | client | `M59ObservedDescription` call after a look reply |
| `C/clientd3d/logoff.c`, `config.c`, `buy.c`, `d3ddriver.c`, `graphics.c` | client | always-on behaviour patches |
| `C/module/merintr/clientcontext.c`, `clientcontextmodel.h` | client | DUM tab, native heartbeat, pips |
| `C/module/merintr/planpane.c`, `.h` | client | MANAGE tab, its forms, lock, `manage`/`plan`/`fs` |
| `C/module/merintr/inventoryintent.h`, `inventry.c` | client | sell/keep badges |
| `C/module/merintr/statbtn.c`, `stats.c/.h`, `mermain.c`, `merintr.c`, `merintr.def` | client | tab buttons, groups 6/7, veto, commands, export |
| `H/tools/m59-tui.mjs` | harness | L/S/V/G, MANAGE-tab plumbing (proxy 5962, desk), launch log |
| `H/tools/m59-devclient.mjs` | harness | exe path, dev.bat generator, `--endpoint` proxy choice |
| `H/shortcuts/dev.bat`, `dev-<char>.bat` | harness (generated, gitignored, plaintext passwords) | launchers |
| `H/tools/m59-client-context.mjs` | harness | DUM tab server (:8918) |
| `H/tools/m59-plan-desk.mjs`, `H/tools/plans/*.mjs`, `H/tools/m59-plan-kinds.mjs` | harness | MANAGE tab server; what each FleetScript param becomes as a picker |
| `H/tools/m59-inventory-intent-service.mjs` | harness | badges, and `/plans` on :8913 for the DUM pilot check |
| `H/tools/m59-overlay.mjs`, `m59-annotate.mjs`, `m59-signal.mjs`, `m59-roomserve.mjs`, `m59-cameraman.mjs` | harness | overlay, marks/halos, F-key listener, room views, camera turns |
| `H/tools/m59-proxy.mjs`, `m59-proxy-gate.mjs`, `m59-proxy-attach.mjs`, `m59-proxy-trade.mjs`, `m59-spectate-keeper.mjs` | harness | proxy, lock, spectate, Full Auto trade |
| `H/tools/m59-inject.ps1` | harness | injects `m59agent64.dll` |
| `H/docs/m59-plan-tab.md`, `H/docs/m59-inventory-intent.md`, `H/docs/m59-client-vs-harness.md` | docs | related depth |
