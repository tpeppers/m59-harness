# m59-harness

Play [Meridian 59](https://github.com/Meridian59/Meridian59) as a real player
character, from an agent.

Characters log in over the same port humans use. They see the room *and its
geometry*, enforce the same walls, cliffs, headroom, and player radius as the
normal client even though the server does not, travel across the world, fight, shop, talk, rest, hand each other
items and money, and hear each other. `who` lists them beside the humans. Any
MCP client — Claude Code, Codex, a local model with a `curl` loop — can drive
one.

This is a baseline, not a running fleet. Nobody's roster, character state or
chat history is in here; what is here is the protocol client, the world model,
the behaviours, and a reference compendium compiled from the game's own source.
Build your own fleet management on top.

## Install it

From nothing to ten characters playing, on Windows or Linux:

```bash
git clone https://github.com/tpeppers/m59-harness
cd m59-harness
node tools/setup.mjs all 10
```

That clones the [Meridian 59](https://github.com/Meridian59/Meridian59) source,
builds the server in a container, bakes a local collision map from that exact
server's room resources, starts the broker, and creates ten
characters. Ten to fifteen minutes, mostly compiling. `node tools/setup.mjs
doctor` reports what is present and what is missing without changing anything.

Or open the repository in Claude Code or Codex and ask it to install the game and
make you a fleet — [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md) are the
procedure, written for an agent.

The manual, with both platforms, the native build, and troubleshooting, is
[`docs/INSTALL.md`](docs/INSTALL.md).

**The Steam client is optional.** Agents log in over the wire; no `Meridian.exe`
is involved in running a fleet. You need
[the client](https://store.steampowered.com/app/893390/Meridian_59/) to watch a
character in first person, and for the compendium's sprite art.

If you do have it, `node tools/setup.mjs shortcuts` writes one shortcut per
character — host, port, account and password already filled in, so opening
`m59-Aldric.desktop` puts you in the world as Aldric with nothing to type. They
hold real passwords, so `shortcuts/` is gitignored; the details are in
[`docs/INSTALL.md`](docs/INSTALL.md#click-to-play-shortcuts).

## What you need

| | |
|---|---|
| Node 22+ | everything. Node 24 LTS is recommended; tools in `tools/` are standalone `.mjs` with no dependencies |
| Docker | building and running the server, the same way on both platforms |
| git | fetching the server source |
| Python 3 | the sprite puller and the source-analysis scripts. Optional |
| the source tree | set `M59_ROOT` (default `C:/code/Meridian59`). The compendium's citations point into it |

One dependency exists, for the chat responder only: `npm install`.

## Start here

```bash
node tools/m59-service.mjs start
```

This starts one supervised broker with a durable log. For foreground diagnostics,
`node tools/m59-broker.mjs --http 8901 --dashboard 8902` runs the same broker directly.
Both select maps in the same order: explicit `M59_MAP`, then
`substrate/m59-map.local.json` when setup generated one, then the checked reference.
The selected map is fully decoded and validated before the broker reports healthy.

One broker endpoint, N characters. The production default keeps each
character's keeper in a child process for fault isolation; the optional
[`m59-lab-runtime`](docs/m59-lab-runtime.md) gives an explicitly marked test fleet
event-driven scheduling and a lazy atlas. It defaults to a lowest-memory single process;
`--shards N` optionally isolates partner-preserving actor groups into hidden child
processes, each with its own V8 heap and one atlas, while a Meridian-free parent owns the
leases and aggregate control surface. Point a client at the broker:

```json
{ "mcpServers": { "meridian59": {
    "command": "node",
    "args": ["C:/code/m59-harness/tools/m59-mcp-attach.mjs", "--port", "8901"]
} } }
```

`.mcp.json` in this repo does exactly that — fix the path for your checkout.
**Attach, do not spawn.** `m59-broker.mjs` with no arguments serves stdio MCP
*and* resumes a fleet. With one broker already owning that fleet, a second is
refused before its HTTP or stdio listener opens and exits with status 3; it does
not attach to the existing process. `m59-mcp-attach.mjs` forwards stdio MCP to
the broker that already owns the fleet and holds no state itself.

### Resource-efficiency modes

The production entry point and isolation model are unchanged: `m59-service.mjs` still
runs the standard broker and one keeper child per character. Its idle work is now
demand-driven. Rich keeper state is projected only when an MCP/dashboard reader needs it,
bursts reuse a two-second snapshot, and one broker deadline checks all keepers through the
small projection-free `/live` identity/connection reply. State-file persistence, the
flight recorder, failed-start retry, and client keepalive use bounded one-shot deadlines
instead of permanent polling intervals.

The opt-in lab runner shares one lazy atlas and scheduler across all actors by default;
`--shards N` trades additional heaps/atlases for smaller GC, synchronous-stall, and crash
domains. The offline 100-actor lower-bound smoke measured about 14 KiB of used heap per
unstarted actor shell after one shared import, whose repeated forced-GC floor was about
138 MiB RSS. This is not a connected-fleet memory promise. A checked, lab-only exit atlas
removes the former multi-second fine-boundary derivation while exact tests compare every
projected approach. See [the lab runtime guide](docs/m59-lab-runtime.md) for the safety
boundary, measurements, fallbacks, and shard accounting.

An isolated one-character live canary measured 122–129 MiB working set for the shared
runtime versus 727 MiB for the ordinary broker plus one keeper on the same machine—about
82–83% less RAM—and replaced the standard broker's observed 8.5–8.7-second eager routing
startup with 0–1 ms lazy graph registration. The canary also passed authenticated control
shutdown, stale-lock reclaim, standard keeper resume in a dedicated 100-port band, and
orderly service shutdown. These are test-server measurements, not a promise that connected
actors remain constant-cost; the full setup and caveats are in the lab runtime guide.

A separate **experimental** image can scale only Blakod timers and the world-hour event;
anti-abuse timing (`GetTime()`), sockets, sessions, protocol pacing, logs, and save cadence
remain on wall time. It is never selected by the normal Dockerfile or production service:

```powershell
node tools/m59-sim-server-build.mjs --check --scale 10
node tools/m59-sim-server-build.mjs --build --scale 10 --tag m59-blakserv-sim:lab-10x
```

The wrapper requires the manifest's exact pinned source checkout through `M59_ROOT` or
`--source PATH`; it verifies preimage hashes and patch applicability without modifying that
checkout.
The pinned patch contract and a native Windows RELEASE/Werror build pass, but the Docker
daemon was unavailable: the Linux image build, container attestation, save/restart smoke,
and a live canary have not been run. Treat it as an isolated test-first artifact, not a
production option; the exact guarded run/stop commands and save boundary are in the lab
runtime guide.

Then read [`docs/m59-agent-primer.md`](docs/m59-agent-primer.md) — the rules of
the world, written for something that is about to play it.

## The map

```
tools/setup.mjs                     doctor / server / client / broker / fleet — the bootstrapper
tools/m59-makefleet.mjs             make N characters that are worth growing
tools/m59-shortcuts.mjs             a click-to-play client shortcut per character
tools/pull-client-assets.py         decode the client's sprites into the compendium
docker/Dockerfile                   builds blakserv from either source tree, on any platform
docker/Dockerfile.sim-clock         separate source-pinned experimental lab-clock image
server-patches/simulation-clock/    immutable manifest, hashes, and isolated server patch

docs/INSTALL.md                     the manual: both platforms, both build paths, traps
docs/m59-agent-primer.md            the rules of the world, for an agent that will play it
docs/m59-progression.md             how a character grows, how fast, how to tell it is working
docs/m59-mcp.md                     the broker: run it, wire it up, what the tools do
docs/m59-protocol-client.md         the wire protocol — login, perception, message formats
docs/m59-coordination-research.md   cited findings on trading, loot, PvP, kill credit
docs/m59-conversation.md            the chat bridge: hearing players, answering them
docs/m59-proxy-handoff.md           sitting between a human client and the server
docs/meridian59-bridge.md           the admin-socket control plane, runbook, and traps
docs/m59-lab-runtime.md             optional one- or multi-process event-driven test-fleet runtime

tools/m59-broker.mjs        the MCP control plane over N keeper-backed characters
tools/m59-lab-runner.mjs    opt-in event-driven runtime and shard supervisor for a dedicated test fleet
tools/m59-lab-roster.mjs    safely marks an existing local named roster for the lab runtime
tools/m59-lab-shard-child.mjs  minimal guarded child for optional process-sharded labs
tools/m59-sim-server-build.mjs  verifies/builds the isolated simulation-clock image
tools/m59-sim-server.mjs     guarded loopback lifecycle and clock attestation for that image
tools/runtime/shards/       ownership permits, IPC state/ACK control, aggregation, and exact stop
tools/m59-client.mjs        a protocol client that logs in as a real player
tools/m59-parse.mjs         the server→client parsers: perception and trading
tools/m59-world.mjs         the joined world model: perception + graph + geometry
tools/m59-map.mjs           the room graph — 264 rooms, 980 exits, both mechanisms
tools/m59-roo.mjs           .roo geometry: walkability, walls, A*, the minimap
tools/m59-skills.mjs        composite behaviours: fight, rest, escape, sell everything
tools/m59-autopilot.mjs     the keeper — a background loop that holds baseline state
tools/m59-merchants.mjs     who buys, sells and teaches what
tools/m59-spells.mjs        spell costs, reagents and the karma gate, compiled from kod
tools/m59-safespots.mjs     squares a character can hold, and against how many
tools/m59-rsc.mjs           the resource table, id → text, straight off the wire
tools/m59.mjs               say / listen / escort / follow, over the admin socket
tools/m59-fleets.mjs        every roster on this machine: slots, server, who is holding it
tools/m59-proxy.mjs         sit between a human client and the server and watch
tools/m59-tui.mjs           interactive fleet terminal
tools/m59-dashboard.mjs     the fleet web page — /, and the shared dashboard tab bar
tools/m59-observability-page.mjs  DUM interventions plus opt-in 2h strategy drill-ins — /dum, /harness
tools/m59-strategy-stats.mjs      rotating travel/fight/trade/vault detail spool (24h default)
tools/m59-deaths-page.mjs   /deaths and /tougher: what killed them, what it took to gain
tools/m59-economy.mjs       purses, bank balances and reagents — /economy
tools/m59-abilities.mjs     every skill and spell number the fleet holds — /skills
tools/m59-stats-page.mjs    /stats: the builds the fleet is made of, grouped by the roll

substrate/m59-map.json        264-room graph plus generated reference collision geometry
substrate/m59-merchants.json  70 merchants: who buys, sells and teaches what
substrate/m59-spells.json     175 spells: mana, reagents, level, karma requirement
substrate/m59-spawns.json     120 creatures across 183 rooms, with danger ratings
substrate/m59-safespots.json  11 rooms of proven standing squares
```

`substrate/` here is reference data, not a running fleet's state.
A setup also writes gitignored `substrate/m59-map.local.json` from the exact `.roo`
files used by its server. Ordinary restarts keep selecting that local artifact. If it
does not exist, the portable checked reference is used; movement still stops closed if
the live room security differs. Every map carries a semantic manifest over all room
security values and collision payloads. Corrupt or incomplete maps fail broker startup;
valid but server-mismatched/obsolete geometry fails movement closed on the live room's
security value.
A live broker writes `fleet-state.json`, `history/` and `recordings/` beside it;
all three are gitignored, because a roster carries account passwords in plain
text and recordings are one server's history rather than anything reusable.

## Tests

Offline, no server needed:

```bash
node tools/m59-safespot-test.mjs      # 91 tests — safe squares, errand pairing
node tools/m59-autopilot-policy-test.mjs # explicit keeper policy overrides, offline
node tools/m59-chat-test.mjs          # 102 tests — sanitiser and leak detection
node tools/m59-escape-test.mjs        # 29 tests — leaving and fighting from a sitting start
node tools/m59-collision-test.mjs     # fine BSP collision, cliffs, walls, slopes, exits
node tools/m59-fleets-test.mjs        # the roster inventory, against a fixture broker
node tools/m59-loadout-test.mjs       # 109 tests — loadouts, and what reaches the counter
node tools/m59-stats-test.mjs         # 60 tests — the builds board, and the pane it shares
node tools/m59-broker-demand-test.mjs # demand state and projection-free keeper /live seam
node tools/m59-keeper-idle-test.mjs   # event-driven keeper persistence and join retry
node tools/m59-client-keepalive-test.mjs # one-shot idle/proof-of-life wire keepalive
node tools/m59-recorder-test.mjs      # lazy event-driven flight recorder
node tools/m59-world-exit-atlas-test.mjs # exact lab atlas parity and cold-origin bound
node tools/runtime/server-clock-contract-test.mjs # isolated patch/image contract
node tools/m59-sim-server-test.mjs    # offline simulation-server controller contract
```

Against a live server, with test accounts:

```bash
node tools/m59-perception-test.mjs    # the parser, in every room on the server
node tools/m59-play-test.mjs          # the primer's rules, re-checked
node tools/m59-coop-test.mjs          # two agents: see, walk, talk, trade, split
node tools/m59-skills-test.mjs        # fight / rest / escape, end to end
node tools/m59-autopilot-test.mjs     # three unattended minutes with nobody driving
```

## The compendium

A static reference site: every spell, skill, item and creature, plus guides to
the systems that connect them. 1,030 pages. Nothing in it is remembered or
estimated — every page is compiled from the server's own Blakod source, and every
quantitative claim carries a `file:line` citation into `M59_ROOT`.

```bash
cd compendium && node tools/serve.mjs      # http://localhost:8099/
```

The pages are committed. **The 5,355 sprites are not** — they are the client's
own art, 40 MB of it. Decode them from any local client:

```bash
python tools/pull-client-assets.py
```

It finds a source checkout or a shipped client (Steam, GOG) on its own; pass
`--resource` and `--palette` if it does not. Note that `blakston.pal` ships only
with the source tree, so a retail client alone is not enough. Until you run it,
pages render and images 404.

To rebuild the site itself from a changed source tree: `node tools/build.mjs`
inside `compendium/`. See [`compendium/README.md`](compendium/README.md).

## Telling the fleet what a character should be carrying

The compendium's **planner** is the page between the reference site and the live
fleet. It rebuilds the client's own right-hand panel — inventory, spells, skills,
stats, the same four tabs — and makes it editable, so what comes out is a
**loadout**: one file per character saying what gear it should get back to, how
many of each thing it should carry, and what it should sell on sight.

```bash
node tools/m59-compendium.mjs --open --to /planner/    # or press P in the fleet terminal
node tools/m59-loadout.mjs                             # every loadout on this machine
node tools/m59-loadout.mjs Kermit --check              # ...against what Kermit holds now
node tools/m59-loadout.mjs Kermit --init               # seed one from its character sheet
node tools/m59-loadout.mjs Kermit --gear-to-fleet      # what giving everyone its gear would do
```

The **gear** half is the one part of a loadout that is about the fleet rather than
about a character — how many reagents a caster burns is its own business, but
"fight with a short sword and wear leather" is a decision about all of them. So
the planner's *Apply gear to fleet*, and `--gear-to-fleet --apply`, write that one
field into every character's loadout and change nothing else in any of them. Both
say what they would do first: it is one file per character, and an empty gear list
is refused rather than applied, because a loadout nobody has filled in is not an
instruction to strip the fleet.

The keeper reads `substrate/loadouts/<character>.json` every pass and acts on it:
it tops up to the minimums at a counter it is already standing at, holds back
what the floors protect, sheds what the ceilings and the sell list release, and
reaches for the weapon the list names rather than whichever one it happens to be
best with. Every rule in it used to be a constant shared by all twenty-one
characters.

**A loadout adds rules; it never removes them.** A character without one behaves
exactly as it did before loadouts existed, and a loadout that mentions only
elderberry changes nothing about anything else. That is the property
`m59-loadout-test.mjs` spends most of its 126 assertions on.

## Source analysis

`tools/*.py` and `experiments/*.py` read the Blakod tree directly rather than
playing, because the interesting numbers are never sent over the wire — a spell's
mana cost, its reagents, its karma requirement, armour resistances, monster
difficulty, treasure tables are all declared in kod and enforced server-side.
Both honour `M59_ROOT` and write beside themselves.

```bash
python tools/extract_monsters.py      # kod → monsters.json
python tools/xref2.py                 # which rooms spawn what
python tools/econ_shops.py            # what merchants pay
python experiments/ladder.py          # kills-to-next-HP by stamina and level
```

## Two things that made this harder than the protocol suggested

**Silence.** The server drops illegal and too-fast actions without saying so —
three rate limits, a facing check, a range check, all quiet. The broker paces
every request, so an agent trades visible latency for invisible failure.

**The state a player actually has.** A protocol client sees a list of objects
with coordinates, which is not enough to play. The human client has a minimap,
and that minimap is drawn from the room's `.roo` file — a per-square walkability
grid and a wall-segment list the protocol never mentions. All 264 rooms of it are
parsed and baked in, so `look` returns the room's shape, what is reachable and in
how many steps, and which square to stand on to leave.

A small model does not have to orchestrate any of that. `fight("spider")` finds
the nearest match, arms itself, walks there through the geometry, turns to face,
swings on the server's clock, breaks off if it is losing, and loots the drops —
one call, every stage reported. `autopilot` is a background keeper with no model
in it at all: it rests, withdraws, escapes the Underworld after a death, and
optionally farms one named creature, journalling each decision with a reason.

## Licence

The tooling here is ours. Meridian 59 itself — its source, its art, its data —
belongs to its owners; nothing of the client's is redistributed here, which is
why the sprites are pulled rather than committed.
