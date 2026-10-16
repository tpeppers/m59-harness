# The PLAN tab: the fleet as a spellbook, and who holds the controls

The dev client (`shortcuts/dev.bat`, built from `C:\code\Meridian59` with the
`module/merintr/planpane.c` patch) has a **PLAN** tab next to Inventory / Spells /
Skills / Stats / DUM. It is a list that works like Spells. Each row is something the
fleet can be asked to do: double-click it (or press Enter) to run it, and right-click it
to read what it does. A row that needs arguments opens them first, with the choices
supplied by the fleet itself. The rows also run from the chat box:

```
plan                                  list every row
plan courier item=orc%20tooth count=40   run a row by unique prefix; %20 is a space
plan control                          opens the row's arguments if none were typed
fs zheng-he-lap agents=hk2            a FleetScript REPL line, exactly as if typed there
```

## Running it

**The normal way: the fleet terminal's L.** A normal launch now starts the gate-capable proxy
(5962, gate control 8931) and the plan desk if they aren't already up, and `dev.bat` goes
through that proxy. Nothing else needs starting. `M59_TUI_NO_PLAN=1` launches the old way.

While prod-deploy predates this work (no deploy cut), run the terminal from the **trunk**
against the prod fleet, with the roster and the desk pointed at prod-deploy:

```powershell
cd C:\code\mindmap\maps\m59-harness
$env:M59_STATE_FILE     = 'C:\code\m59-lab\prod-deploy\substrate\fleets\prod.json'
$env:M59_PLAN_SUBSTRATE = 'C:\code\m59-lab\prod-deploy\substrate'
node tools/m59-tui.mjs --fleet prod
```

The live courier lap (prod-deploy's local `zheng-he-lap.mjs`) imports
`m59-human-handoff.mjs` from the trunk by absolute path until a deploy carries it.

**By hand**, the pieces are:

The client half needs only `M59_CLIENT_CONTEXT_DIR`, which `dev.bat` already sets. The
other half is the **plan desk**:

```
node tools/m59-plan-desk.mjs --fleet prod --substrate C:\code\m59-lab\prod-deploy\substrate
```

`--substrate` must be the substrate of the deployment that **runs** the fleet's loops,
because that is where the courier's request files and the loops' pid files live. With no
desk running, the tab says so and nothing can be queued.

For the lock you also need a proxy that serves the gate. Either start one yourself, or
set `M59_PROXY_GATE_CONTROL=8931` before the fleet terminal starts its swarm proxy:

```
node tools/m59-proxy.mjs --observe --gate-control 8931 --listen 5961 --server 76.214.42.186:5959
```

`dev.bat` finds the proxy by itself (`m59-devclient.mjs --endpoint`).

## Where the rows come from

Nothing in the tab is hard-coded in the client. The desk loads **providers** from
`tools/plans/*.mjs` and `<substrate>/plans/*.mjs`. Each provider exports `provider =
{ id, entries(ctx), run(entryId, args, ctx) }`:

| provider | rows | how it knows |
|---|---|---|
| `control` | Relinquish control to Keeper / Take control back | the proxy gate, found through the proxy's advert in `<evidence>/proxies/` |
| `courier` | Request a delivery · Carry my goods to sell · Next lap only… · cancel rows | **read out of the lap's own source**: its `SHOPPING` and `POOL` tables, plus `m59-merchants.json` for everything stocked in the towns those lines name |
| `fleetscripts` | one row per FleetScript, plus Run/Dry-run a line | **reflection over `script.params`**, the same schema the REPL's `describe` prints. A script may also export `plans` for intents that are not "run me" |

"Running" (the green dot) means a live per-agent run lock (`m59-runlock.mjs`) or a live
repeat loop (`substrate/fleetscripts/lib/repeat.mjs`) that names the script. Nobody
maintains these as a registry. They are what the runners already leave behind.

To add rows, drop a provider into `<substrate>/plans/`, or export `plans` from a
FleetScript. The desk re-imports a provider whenever its mtime changes.

## The courier rows, concretely

| row | writes | what the lap does with it |
|---|---|---|
| Request a delivery | `courier-requests.json` `{agent: {item: target}}` | buys the total of all requests and tops each requester up first (existing behaviour) |
| …an item the lap has no line for | `courier-wishlist.json` | **nothing** — kept separate so the gap is visible rather than silently ignored |
| Carry my goods to sell | `courier-holds.json` `{agent: {items, character}}` | lowers every fill threshold by `reservedPercent()` and, at home (38), waits for **you** to offer the goods |
| Next lap: bring back only… | `zheng-he-next-lap.json` | existing one-shot order, retired by the lap |

A character you are piloting has **no keeper session**, so the lap's usual `supply`
(which drives both ends of a trade) cannot reach it. The lap used to skip piloted
characters in eight places. It now owns one half of the trade
(`tools/m59-human-handoff.mjs`):

- **pickup:** you offer in your client → it counters with nothing (that is how a gift is accepted) → you accept;
- **delivery:** it offers → you counter with nothing → it accepts.

Both halves time out and cancel, so you can't leave a trade open that wedges its next
`supply`.

### Automated Courier: Full Auto or Manual

Double-click **Automated Courier** to open its settings window. Rows flagged as settings
open in their own window, like the Guild page; every row with arguments does too. It has:

- **Handling:** a dropdown.
  - *Full Auto:* the proxy carrying your client does your half of the trade
    (`tools/m59-proxy-trade.mjs`). No trade window opens. Items simply leave and arrive in
    your inventory.
  - *Manual:* you work the trade window yourself, as above.
- **With instruction text:** a checkbox. The courier sends you a private **tell**, never
  room speech, starting `[COURIER SERVICE]`. In Manual it says what to do ("type 'offer'
  and offer back 40 diamond…"). In Full Auto it says what is happening.

How Full Auto works:

- The client reports the players in your room by name (`W` rows), because only the
  client can resolve those names. The desk publishes them to
  `<substrate>/human-presence.json`.
- When the courier stands in your room, the desk tells the proxy
  `POST /trade/accept-from` (the courier's object id, 15 s lease). An offer from the
  courier is then answered with an empty counteroffer.
- When the lap reaches its pickup step it writes `courier-ready.json`. The desk then
  tells the proxy `POST /trade/give` with the held items' ids from your own pack. The
  proxy offers them and accepts once the courier counters.
- The proxy swallows every server→client packet of an automated trade.
- It never acts while you have a trade window of your own open (two minutes after your
  last trade packet).
- It needs a gate-capable proxy, the same precondition as the lock: the proxy must
  own the stream to inject. Only the harness-local copy of `zheng-he-lap.mjs` has this so far. **The
prod-deploy copy has not been changed.**

## The lock

"Relinquish control to Keeper" takes the proxy's **control gate** (`tools/m59-proxy-gate.mjs`)
for your character:

- The proxy stops forwarding your movement, turning, combat, item, trade and user-command
  packets. Chat, look, inventory, data requests and **logoff** still pass, so you can
  always leave. Leaving is releasing.
- Dropping a client packet desynchronises the anti-spoof stream by one step. The gate
  is therefore refused until the proxy has calibrated against the live stream, and from
  the first drop onward the proxy re-frames every client packet itself, exactly as it
  does after an injection. `tools/m59-proxy-gate-test.mjs` checks this against a fake
  server that runs blakserv's security arithmetic and hangs up on the first wrong value.
- The gate is a **lease** (2 min, renewed every 30 s by the desk). A desk that dies hands
  the controls back by itself.
- The client refuses the same actions locally and paints the tab button red with
  **KEEPER** on it. That is only so the screen does not pretend to move: a stock client
  through the same proxy is locked out just the same.

### Spectate: the keeper plays, you watch

"Relinquish control to Keeper" does two things:

1. It takes the gate (above).
2. It starts a **spectate keeper** (`tools/m59-spectate-keeper.mjs`) for your character.

The spectate keeper is the same keeper the broker runs: the same `Session` and `Autopilot`,
with the roster's standing orders. Its client does not log in, because your client holds
the one connection the server allows. Instead it **attaches** to your connection through
the proxy's attach port (`tools/m59-proxy-attach.mjs`, `--attach 8932`):

- It receives a copy of everything the server sends you. It rebuilds its picture by
  asking the server to resend player, room, inventory and stats. The gate lets those
  requests through, and your client just redraws.
- Its packets are injected **only while it holds the gate**. Taking control back silences
  it on its very next packet; nothing depends on the keeper noticing.
- **Your screen follows it.** The server never tells you about your own moves, so the
  proxy mirrors each keeper step and turn to your client. Steps are mirrored only inside
  the current room's grid, with the room size taken from `substrate/m59-map.json`. A
  forged out-of-room square crashes the client, so it is never sent: crossing into the
  next room arrives with the server's own room burst instead.
- **Take control back** releases the gate first, then stops the spectate keeper.
- **If the keeper dies while holding the gate**, the desk gives the controls back within
  about 20 seconds and tells you.
- The broker sees the character as piloted throughout and leaves it alone. The spectate
  keeper never registers with the broker and holds no claim.
- It runs against a password-free copy of the roster (`substrate/spectate/<agent>-roster.json`),
  because `Session` can write to its roster and the real one is the only copy of the passwords.

To check it is driving, look at the Control row's description: it shows how many keeper
packets were sent and how many moves were mirrored. `GET http://127.0.0.1:8931/gate` shows
the same under `attached`. The spectate keeper's heartbeat is
`substrate/spectate/<agent>.json`.

**The keeper is handed a de-scrambled stream.** A real client pings, and the server answers
each ping by XOR-scrambling the opcode byte of every later message with a sliding token
(`tools/m59-proxy-token.mjs`). The harness's own client never pings and reads token 0, so the
proxy decodes the stream before the keeper and its own parsers see it. It re-encodes for your
client whenever it has forged or swallowed a message, because either one shifts your client's
token walk by one. The first live relinquish ran without this: the keeper read garbage, the
session fell back to character select, and the client crashed in `char.dll`. The spectate
keeper's output is in `substrate/spectate/<agent>.log`.

**Logging off to survive really logs off.** The keeper's last resort in a losing fight is
to leave the world and come straight back. A keeper with its own connection drops its socket.
The spectate keeper's socket is only its attachment, so at first that "logoff" just
re-attached, and the character stayed in the fight. Now an attached rejoin sends `BP_REQ_QUIT`
first, and the proxy does the round trip on your connection (`ProxySession.logoffAway`):

1. The server takes the character out of the world and drops to its menu, still logged in.
2. The proxy holds it there until the keeper re-attaches (about a second).
3. It sends `AP_REQ_GAME` and `BP_USE_CHARACTER`. No password is needed.

Your client sees none of the menu: the proxy swallows everything in between, both ways. The
character just reappears as if it had changed room. Taking control back mid-logoff brings it
back at once. If nothing asks within 20 seconds it comes back by itself. If the server refuses
any step, the proxy hangs up, which logs the character off.

**The keeper's looks stay off your screen.** The keeper inspects items with `REQ_LOOK`. Each
answer used to open an "Object Description" window on your client. The proxy now notes who
asked for each look and swallows the answers to the keeper's. The keeper still receives them.

A plan proxy started before this change has no attach port. Restart it (close it, then
press L again) or the desk will say the keeper cannot drive.

## Known problems, to fix later (2026-10-16)

- **Two desks can answer one client.** The single-desk guard is a heartbeat per *substrate*
  (`<substrate>/plan-desk.json`), but every desk writes replies into the same client folder
  (`substrate/client-context/plan/`). A terminal started without `M59_PLAN_SUBSTRATE` started
  a trunk-substrate desk beside the prod-deploy one already running. Both then handled each
  request: the reply file was rewritten twice a second, and a Full Auto courier tick could run
  twice. The fix: make the guard (and `m59-tui.mjs ensurePlanDesk`) key on the client folder,
  not the substrate, and say which substrate the running desk serves. A desk pass costs about
  8 ms, so this is a correctness problem, not a load problem.
- **The terminal's desk uses the wrong substrate.** Without `M59_PLAN_SUBSTRATE`, L's desk reads
  the trunk's `substrate/`, while the prod fleet's loops (and the courier's request files) live
  in the prod-deploy checkout's.
- **A spectated logoff that is meant to stay off is cut to 20 s.** `AWAY_MAX_MS` in
  `m59-proxy.mjs` caps it, but a farm-buff "wait it out" asks for up to 60 s. Raising the cap
  needs a live check of how long the server lets a connection sit on the character menu.
- **The client's `table_lookup` crash** (`meridian.exe+0x44095`) is not investigated.

The machine-wide slowdown while the dev client ran was the client, not the desk: performance
mode (`gpuefficiency=false`) presented up to 120 uncapped frames a second, focused or not.
Fixed in the client fork (`d9d78a6e`): it now presents on vblank and draws at most 30 fps
when the window isn't focused or is minimized.

## Files

| file | side | what |
|---|---|---|
| `Meridian59/module/merintr/planpane.c` | client | the tab, the typed commands, the local veto |
| `Meridian59/module/merintr/planpane_test.cpp` | client | offline: protocol, rows, args, ack, lock and its expiry |
| `tools/m59-plan-desk.mjs` | harness | the desk: file protocol, provider registry, at-most-once execution |
| `tools/plans/{control,courier,fleetscripts}.mjs` | harness | the providers |
| `tools/m59-proxy-gate.mjs` | harness | the gate rules (allowlist, lease) |
| `tools/m59-proxy.mjs` | harness | `setGate`/`clearGate`, `--gate`, `--gate-control` |
| `tools/m59-human-handoff.mjs` | harness | the courier's half of a trade with a person |
| `tools/m59-proxy-attach.mjs`, `tools/m59-spectate-keeper.mjs` | harness | spectate: the keeper attached to your connection |
| `tools/m59-spectate-test.mjs` | harness | offline: attach, gate handover, mirrored moves, edge safety |
| `tools/m59-plan-desk-test.mjs`, `tools/m59-proxy-gate-test.mjs` | harness | offline tests |

The file protocol is documented at the top of `m59-plan-desk.mjs` and mirrored in
`planpane.c`. It is separate from the DUM pane's files on purpose, because the DUM
parser rejects any line it doesn't know.
