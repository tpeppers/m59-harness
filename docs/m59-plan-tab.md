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

### What does NOT happen yet

**Nothing drives your character while the gate is held**, unless something injects
through the proxy (`m59-drive.mjs`, the proxy's `/walk`). The keeper *process* cannot
share your socket: the server allows one connection per character, and your client is
that connection. Today, "Keeper has the controls" means "you are locked out and
spectating". It does not yet mean "the keeper is playing".

Closing that gap means the keeper drives **through the proxy session** rather than
over its own login. Either:

- (a) a keeper transport that speaks to the proxy's injection channel instead of a
  socket, fed by the proxy's server→client stream, or
- (b) the keeper logs in through the proxy first and the human client *attaches* to that
  session. That needs the proxy to replay enough of the server→client stream for a
  freshly started client to reconstruct room, inventory and stats.

(a) is smaller, because the proxy already parses room contents and owns the stream.
Both are written up in `docs/m59-client-vs-harness.md`.

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
| `tools/m59-plan-desk-test.mjs`, `tools/m59-proxy-gate-test.mjs` | harness | offline tests |

The file protocol is documented at the top of `m59-plan-desk.mjs` and mirrored in
`planpane.c`. It is separate from the DUM pane's files on purpose, because the DUM
parser rejects any line it doesn't know.
