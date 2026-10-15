# What a player sees and what the harness sees

This report lists discrepancies between the stock Meridian 59 client, as a player uses it,
and this harness, as LLM agents drive it through files and tools. Agreements are kept
too, because an agreement that was only reached after a measurement is itself a finding.
Each item is marked **DISCREPANCY**, **AGREEMENT** or **UNVERIFIED**.

Path abbreviations: `C/` = `Meridian59/clientd3d/`, `K/` = `Meridian59/kod/`, `S/` =
`Meridian59/blakserv/`, `H/` = this repository. Compiled 2026-10-14 from the sources and
from this repository's own measured notes. The citations were read, and nothing was
changed in the process. Items marked ✔ were re-checked against the source line by hand.

**The one fact under most of the physical items:** the server does not check geometry on
a player's own move. The client is the only collision detector, so the harness has to
rebuild that detector, and most of the gaps below are about how faithfully it does.

---

## Part 1: physical space

### 1. Coordinates and grids

| | item | client / server | harness | |
|---|---|---|---|---|
| 1.1 | Three scales, one square | `FINENESS 1024`, `KOD_FINENESS 64`, conversion by a 4-bit shift (`C/drawdefs.h:42,52,56-57`) | same table (`H/docs/m59-coordinates.md:17-21`, `H/tools/m59-roo.mjs:88-90`) | AGREEMENT |
| 1.2 | +KOD_FINENESS offset, 1-based squares | client sends `FinenessClientToKod(y)+KOD_FINENESS` (`C/protocol.h:75-76`); `CanMoveInRoom` subtracts 1 (`S/ccode.c:1504`) | `col*64+32` (`H/tools/m59-client.mjs:1069-1072`) | AGREEMENT |
| 1.3 | Square numbering | square N is `[(N-1)*FINENESS, N*FINENESS)`; the debug overlay carries a `shift` field for exactly this (`C/m59dbg.c:552-556`) | `m59-trails.squareOf()` still adds one after dividing, "a known off-by-one compatibility anomaly" (`m59-coordinates.md:73-77`) | DISCREPANCY, reconciled at the boundary |
| 1.4 | Axis order | the wire is y-then-x, one convention (`C/protocol.h:75`) | at least five positional orders across helpers and on-disk keys (`m59-coordinates.md:39-45,58-82`); Issue #44 mistook a floorless r30c61 for evidence against the valid exit r34c65 | DISCREPANCY (convention only) |
| 1.5 | What "walkable" is stored as | the server keeps a 1-byte-per-square direction grid, a flags grid and (roo v12+) a monster grid (`S/roofile.c:336-380`); the **client never reads them** and collides with BSP walls (`C/move.c:460-615`) | carries both models; they "disagree by 21% of squares" (`m59-roo.mjs:3720`) | DISCREPANCY |

### 2. Movement

- **2.1 Who is authoritative. AGREEMENT, measured ✔.** User moves go through
  `ReqSomethingMoved` with `server_validate` false, because they have "already been
  checked by client (HAHA!)" (`K/object/active/holder/room.kod:2046`). The server only
  counts speed hacks and snaps you back for low-vigor running or `PFLAG_NO_MOVE`
  (`user.kod:2953-3002`). The harness: "We are the client, and the client is the
  collision detector… We could walk through walls and nothing would stop us. We must
  not." (`H/docs/m59-geometry-plan.md:18-28`).
- **2.2 Your own move is never echoed back. AGREEMENT.** `BP_MOVE` is gated on
  `what <> self OR cause <> CAUSE_USER_INPUT` (`user.kod:6171-6176`). The harness
  measured "a six-square walk produced one self `moved` event" and switched to dead
  reckoning (`H/docs/m59-movement-parity.md:115-125`). For the same reason, the proxy
  forges `BP_MOVE` to a human's own client when it injects a step (`m59-proxy.mjs`,
  `step()`).
- **2.3 Step granularity. DISCREPANCY, now converged.** The client moves
  `MOVEUNITS = FINENESS>>2` per 100 ms tick, doubled when running, split into up to 20
  microsteps (`C/draw3d.h:53`, `C/move.c:52-53,176-184,270`). That is 2.5 squares/s
  walking and 5 running. The old harness `step()` sent one square per packet. The
  operator measured 2.28–4.1 sq/s for a human against 0.55 for the fleet
  (`movement-parity.md:26-34`). `m59-mover.mjs` now copies the client
  (`MOVEUNITS_PROTO 16`, `RUNUNITS_PROTO 32`).
- **2.4 Report threshold. DISCREPANCY ✔.** The client compares a **squared** distance
  against `MOVE_THRESHOLD = FINENESS/4`, which is not squared (`C/move.c:58,772`), and
  never uses `MOVE_THRESHOLD2` (`:59`). So the threshold is about one kod unit, not a
  quarter square. The mover's comment says "(FINENESS/4)² … 0.25 squares" and cites the
  wrong lines (`m59-mover.mjs:56-63`). This makes little difference in practice, because
  the 1 s `MOVE_INTERVAL` dominates, but the harness describes the client wrongly.
- **2.5 Speed byte. DISCREPANCY.** The stock client sends only 18, 36, or 0 when leaving
  a room (`C/move.c:354,775-777`). Exertion is `(speed*5/6)²` (`user.kod:3019-3022`).
  The harness treats speed as "a real choice… Running at 24 costs 1.8x"
  (`m59-client.mjs:1025-1036`), so it sends values no human client ever produces. A
  server-side heuristic could tell the two apart.
- **2.6 Why multi-square moves are accepted. DISCREPANCY in the harness's explanation.**
  The doc credits `CanMoveInRoom`'s teleport branch (`movement-parity.md:144-147`).
  That branch exists (`S/roomdata.c:177-183`), but user moves never reach it, because
  `server_validate` is false (2.1).
- **2.7 Packet throttle. AGREEMENT.** `INCOMING_PACKET_THROTTLE = 5`; "normal players only
  send 1 movement packet per second" (`user.kod:50,2924-2928`). The mover reports lazily
  on purpose to stay under it.
- **2.8 Wading slowdown. UNVERIFIED in the harness.** The client scales speed to 3/4,
  1/2 or 1/4 by sector depth (`C/move.c:193-201`). The harness models depth only as a
  floor allowance (`m59-roo.mjs:201-203`). No speed scaling was found in the mover.

### 3. Collision

- **3.1 Walls. AGREEMENT by transcription, with measured leaks.** Both sides use the
  same BSP intersection, `min_distance = width/2`, slide and side-step
  (`C/move.c:279,313-334,460-615`; `m59-roo.mjs:220-226`). The leaks:
  - `moverStepLands` was over-permissive on 211 rooms. "Twenty-one characters 'arrived'
    at Castle Victoria… through solid rock" (`H/tools/m59-falljump.mjs:23-28`).
  - Step-mask v7 deleted 10,856 through-wall steps (`m59-roo.mjs:683-690`).
- **3.2 Bodies block bodies. AGREEMENT, and only the client enforces it.** Users are
  `MOVEON_NO` (`user.kod:7306`). The client treats such an object as a square with
  half-side `FINENESS/4` that you may always move away from (`C/move.c:62,667-700`). The
  harness ports this and adds lane rules: one aim point per side past a rat, and keep
  right (`m59-roo.mjs:724-736,884-895`). The server would let a body walk through
  another, so the harness keeps this rule by choice.
- **3.3 Which grid says "walkable". DISCREPANCY, and the root of a long fault.** The
  harness's `neighbors()` "was asking the monster map". Fixing it lifted the walkable
  body from 185,211 to 235,588 squares. "137 of the 2,164 positions in the operator's
  own walk logs are squares the coarse grid calls wall" (`H/docs/NEXT-STEPS-pathing.md:366-384,516-518`).
- **3.4 Safe walls. AGREEMENT, exploited on purpose.** Monsters path on the grid and
  check `LineOfSight` (`monster.kod:1782`); the player-side check does not
  (`player.kod:4115`). "A safe wall is the coarse grid and the BSP disagreeing"
  (`NEXT-STEPS-pathing.md:14-17`). This is knowledge only the harness has; see 6.2.
- **3.5 Doors. DISCREPANCY.** A player sees a sector animate. The mover enforces one
  frozen sector state, so a shut door is `geometry_blocked`, and room 714 trapped three
  characters (`H/tools/m59-doorplan.mjs:13-17`).
- **3.6 The ground-truth reader is missing. UNVERIFIED ✔.** The proxy records every
  human move request as "GROUND TRUTH… both [models] have been caught being wrong" into
  `substrate/walks/*.jsonl`. The file it names as the reader, `m59-walkcheck.mjs`, does
  not exist. The data is collected and nothing compares it against the models.

### 4. Height, drops, jumps

- **4.1 Climb limit. AGREEMENT on the constant ✔.** `MAX_STEP_HEIGHT = HeightKodToClient(24)`
  (`C/move.c:55`). The harness has the same value and notes "THE CLIMB LIMIT IS NOT IN
  kod" (`m59-roo.mjs:101-112`). **Stale:** `height-nav-plan.md:15-23` still states the
  old ±1.0 rule.
- **4.2 Where the limit applies. DISCREPANCY, measured.** The client checks height only
  when crossing a wall, and skips it when there is no below-texture (`C/move.c:549-554`),
  so an untextured riser can be climbed at any height. The harness adds a floor-to-floor
  test: "the harness has TWO height rules where the game has one, and the blunt one
  answers first". Two crossings the operator made in room 45 are refused as
  `step_too_high` (`m59-roo.mjs:1655-1700`).
- **4.3 Drops. DISCREPANCY.** The client has no limit going down; you fall
  (`C/move.c:414-422`). `heightStepOk` uses `Math.abs` and refuses drops too
  (`m59-navgeom.mjs:86-95`). Fall-jumps are "DECLARED, NOT DERIVED" in
  `m59-falljumps.json`. Consequence: one-way rooms such as 598 are right in the harness
  only because somebody declared them.
- **4.4 Head room. AGREEMENT after a correction.** The client tests only at an
  above-textured wall (`C/move.c:553-554`). Step-mask v5 removed a "sector taller than
  player" rule that had deleted 3,961 squares (`m59-roo.mjs:675-682`).
- **4.5 No Z on the wire. AGREEMENT.** `BP_REQ_MOVE` has no height. The harness treats
  height as a pure function of (room, col, row).

### 5. Pathing

- **5.1 Planning. DISCREPANCY in kind.** A player has no planner, only the 3D view and an
  automap of walls already seen. The harness has a room graph, step masks and a fine
  A*. "The router's own numbers said 0.6 was an improvement for a year. The only thing
  that disagreed was walking" (`NEXT-STEPS-pathing.md:760-762`).
- **5.2 Leaving a room. AGREEMENT, plus a client crash the harness found.** The client
  sends speed 0 off the grid and waits for the server (`C/move.c:346-361`). Forging an
  out-of-room square **into** the client reads past its grid array and crashes it
  (ACCESS_VIOLATION), so the proxy never forges one.

### 6. Who knows what

**6.1 Only the player has:**
- the 3D view, lighting, animation and sound;
- an automap limited to walls already seen (`C/map.c:327-328`). The harness draws even
  `WF_MAP_NEVER` walls (`m59-roo.mjs:3725-3728`);
- sector animation;
- **a human's eye for "that is a door".** "Ten minutes of that beat hours of telemetry"
  (`NEXT-STEPS-pathing.md:46-47`).

**6.2 Only the harness has:**
- the whole BSP, including hidden walls;
- kod read as source: the LOS asymmetry, the step limit, merchant buying rules;
- `m59-merchants.json` (what every shop sells), spawns, safe spots, fall-jumps;
- every other fleet character's position, pack and orders;
- what every running FleetScript is about to do.

**6.3 Bridges already built into the dev client:**
- the automap overlay ("THE OVERLAY IS READ, NEVER COMPUTED", `C/m59dbg.c:11-24`);
- F9 record windows;
- UDP object annotations and camera turns;
- the help key opening `m59-roomserve.mjs`;
- the DUM pane, plus, as of this report, the PLAN tab (Part 2).

---

## Part 2: control and intent

These findings came out of building the PLAN tab and the control gate
(`docs/m59-plan-tab.md`). They are about who can act, not where the walls are.

- **7.1 One connection per character. DISCREPANCY, and it governs everything below.**
  The server bumps whoever logged in first. A player's client and the character's
  keeper can therefore never both be connected. The harness models a piloted character
  as **absent**. Its keeper is stopped, the 45 s rejoin sweep skips it, and every
  courier stop skips `r.piloted` (eight places in `zheng-he-lap.mjs`). To the fleet, a
  person playing their own character is a hole in the roster.
- **7.2 A trade is two halves, and the harness only knew how to do both. DISCREPANCY,
  now bridged.** `supply` drives the giver and the receiver from two keeper sessions.
  A player has no keeper session, so the fleet could neither deliver to them nor take
  from them, even standing in the same room. `m59-human-handoff.mjs` lets the fleet own
  **one** half: it counters a person's offer with nothing (a gift), or offers and
  accepts once they counter. The player keeps doing what players always do in the
  trade window.
- **7.3 "Spectating" was aspirational. DISCREPANCY.** `dev.bat` said "the broker can keep
  driving the character while you watch". In practice, proxies run `--observe`, nothing
  could drop a human packet, and the keeper process cannot ride the human's socket.
  What exists now: the **control gate** drops the human's world-changing packets,
  keeps the anti-spoof stream correct across the drops (tested against a fake server
  that hangs up on the first wrong value), lapses by lease, and always lets logoff
  through. What does not exist yet: something that **drives** during the hold. The
  keeper would need a transport that speaks through the proxy session (the proxy already
  owns the stream and parses room contents), or the human client would need to attach
  to a keeper's session. This is the largest open item.
- **7.4 Movement prediction. DISCREPANCY the lock has to respect.** The client moves its
  own view before the server agrees (2.1). A locked client that still predicted motion
  would show a character walking that the world never saw move. So the client refuses
  movement locally while the gate is held, but that refusal is only cosmetic. The
  enforcement is at the proxy, where a stock client cannot get round it.
- **7.5 What the fleet "can do" lived in three schemas that never met. DISCREPANCY,
  partly unified.**
  - DUM's `STRATEGY_CATALOG.settings`: typed, bounded, served at `/strategies`.
  - FleetScript `script.params`.
  - Hard-coded constants in lap scripts (`SHOPPING`, `POOL`, `GIVE`), which have no
    schema at all.

  The plan desk renders the second directly and the third **by reading the script's
  source**. That works on any deployed copy, but it is only as good as the lap's table
  format staying regular.
- **7.6 Town stock is wider than what the courier can buy. DISCREPANCY made visible.**
  `m59-merchants.json` knows everything stocked in the lap's towns (25 options for Zheng
  He today). The lap can buy only the items it has a `SHOPPING` line for, since it needs
  a pack regex, a seller and sometimes a phrase to say first. Requests for the rest go to
  `courier-wishlist.json`, and the row says plainly that they will not be bought.
- **7.7 "Running" has no registry. DISCREPANCY, worked around.** Run locks and repeat-loop
  pid files are what the runners leave behind, and the desk reads those. A repeat loop
  logs its line only at start-up, so a restarted loop is identified by the last
  `repeat up` line.

## The cross-expressions: one intent, both sides

| intent | player (dev client) | harness (agents, files) |
|---|---|---|
| I want reagents delivered | PLAN → Request a delivery (pick from the lap's lines and the town stock) | `courier-requests.json` / the lap's top-up |
| Sell my goods on the next trip | PLAN → Carry my goods to sell, then offer them at home | `courier-holds.json`; `reservedPercent()`; `acceptGiftFrom()` |
| Change what the next lap buys | PLAN → Next lap: bring back only… | `zheng-he-next-lap.json` |
| Run or try a script | double-click a FleetScript row, or `fs <line>` / Dry-run | `m59-fleet-repl.mjs` line |
| Hand the character to the keeper / take it back | PLAN → Relinquish control to Keeper / Take control back; the tab turns red | proxy `/gate` and `/ungate`, a 2 min lease |
| Where am I, what does the harness believe here | help key, automap overlay | `m59-roomserve`, `.ovl` files |
| What does the bot plan for me | DUM pane | DUM `/strategies` |

## Open items, in the order they would pay off

1. **Keeper transport through the proxy (7.3).** Without it, "Keeper has the controls"
   means "locked out", not "being played". The proxy can already inject, forge client
   moves, and parse room contents. A keeper that attaches mid-session can rebuild its
   state by injecting the existing resend requests (`BP_SEND_PLAYER` 40,
   `BP_SEND_STATS` 41, `BP_SEND_ROOM_CONTENTS` 42, `BP_REQ_INVENTORY` 117), all of which
   the gate already lets through.
2. **Write `m59-walkcheck.mjs` (3.6).** The ground truth is being recorded and nobody
   reads it.
3. **Fix the stale harness descriptions:** 2.4 threshold, 2.6 explanation, 4.1 doc, 4.3
   symmetric drops, 4.2 the second height rule.
4. **Live-test the human handoff (7.2) and the gate (7.3) on a server.** Both are tested
   only offline. Neither has been exercised on the shared prod server, which has real
   players on it.
