# Retained player communications

The **Player communications** section on the fleet page and the Communications
tab retain only incoming non-fleet player **tell (`dm`), say, broadcast, yell, and emote**.
Filter by UTC day, receiving character, channel, sender, or text. Private messages
are visible on loopback only, like the Players board. Pagination and JSON use the
same player-only filter, including for records written by older releases.

NPC dialogue, resource speech, system/combat/login prose, unknown sender types,
group and guild channels are excluded before writing to disk. Messages sent by any character in the selected fleet roster are excluded before
writing, including offline and human-piloted members. Matching uses the complete
character name without case sensitivity; it never relies on recycled object IDs.
Roster changes refresh the exclusion list without a reconnect. An unreadable roster
prevents archive writes until it can be read again. Existing fleet-origin receipts
are also filtered out of the page and JSON before counts and pagination. Broadcasts heard by multiple fleet characters produce one receipt
per receiver, and repeated messages are not collapsed. Sender classification uses
current room flags and matching names, then the online-player roster, then the
protocol's player speech channels. A known NPC speaking on one of those channels
is still excluded. Player communication can be about the game; this is a sender
and channel filter, not a semantic interpretation of what the player says.

Messages stay in local gitignored JSONL files under
`<evidence substrate>/communications/<roster path hash>/<UTC date>/`, one file per
receiving agent. There is no repository synchronization or upload. No automatic
expiry is applied to retained player messages. Normal decoded receipts store the
text and metadata, not duplicate wire bytes. An undecodable player message can
include its communication packet for debugging; outgoing credentials are never
recorded.

The shared archive covers bot sessions and human connections through the local
proxy, including player messages during character login and reconnect. The proxy
uses character selection to identify the receiver before the first room snapshot.
It only observes traffic and sends no packets of its own. From the deployed checkout:

```powershell
node tools/m59-proxy.mjs --listen 5961 --bind 127.0.0.1 --server 76.214.42.186:5959 --observe --fleet-state C:/code/m59-lab/prod-deploy/substrate/fleets/prod.json
node tools/m59-communications-report.mjs --fleet prod --date 2026-09-29 --channel dm
```

The proxy CLI defaults to the selected fleet and refuses a mismatched upstream.
The TUI passes its selected roster; programmatic callers use `communicationStateFile`.
`--no-communications` disables retention for unrelated proxy use. Launchers discover
proxies in the shared evidence substrate. Direct clients bypassing the proxy and
characters without any connected client cannot be observed.

General client logs no longer echo incoming communications. The flight recorder
also excludes communication events, including when reading older recordings.
Internal event consumers still receive game prose for combat, trade and bot logic;
filtering informational logs does not change gameplay decisions.

The absolute resolved roster path identifies the archive. Use the deployed roster
when reading from another checkout. `M59_EVIDENCE_DIR` and the shared-worktree
resolver behave as on the other boards. Old NPC/system archive rows are hidden,
not rewritten or deleted. New excluded traffic does not grow the archive.

`node tools/m59-communications-test.mjs`,
`node tools/m59-proxy-communications-test.mjs`, and
`node tools/m59-recorder-test.mjs` cover write admission, persistence, reconnect,
player-only pagination, excluded traffic with no filesystem writes, byte-preserving
proxy forwarding, escaped rendering and intact internal events. Tests use temporary
files and open no game connections.
