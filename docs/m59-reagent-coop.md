# Reagent coop

Enable the keeper policy `reagent_coop: { "enabled": true }` through `autopilot`
or the reflected human controls. It defaults to:

- All 27 reagent types in the game's `Spell.ResetReagents` data.
- 90% of each 24,000-bulk guild chest divided equally among those types:
  **800 bulk per type per chest**. Unit counts round down.
- **20% of bank-bound shillings** contributed, after retaining walking and posted
  shopping money. The percentage rounds up to a whole shilling.
- **75,000 shillings total across the hall's chests**, including any additional
  chest outside the configured deposit squares. Shillings consume no bulk.
- Bookmaker's Guild House (map 714), chests `r18c2`, `r18c6`, `r20c4`.

The schema in `tools/m59-reagent-coop.mjs` supplies the descriptions and fields
to the terminal, website and authenticated in-game control interface. Read live
orders, edit the desired configuration, then explicitly save to the live fleet.
Null disables the coop. The runtime status exposes its pending stage and last
visit under `reagent_coop`.

DUM's multi-shop circuit also includes contribution and cash-tithe stops when
the bot's live policy enables the coop. These call the broker `reagent_coop`
command with a stable `request_id`, polling the same background job until it
finishes. The command is also available to FleetScripts and manual operators;
its actions are `contribute`, `supply`, `tithe`, and `town`. The town action combines
surplus reagents and the cash tithe in one visit.

Guild visits require secrecy. Before entering from North Barloque (101), again
inside the hall, and before paced movement/speech/transfers, the keeper refreshes
the guild invite dialog's room-player data. It includes invisible players and
compares names with the fleet roster, including human-piloted fleet characters.
Unknown or timed-out reads fail closed. A pushed outsider arrival also blocks the
next inward action; the bot abandons transfers, leaves the hall, and continues
its next town task. Survival retains control throughout.

The game client builds its invite dialog from room contents
(`module/merintr/guildinv.c`); there is no separate invite-list network request.
The server's `ToCliRoomContents` includes invisible players. We deliberately omit
the GUI's visibility filter. Server-hidden administrative characters are not
exposed by this protocol. No guild invitation is sent by these checks.

DUM tries the combined tithe before the first vault/shop stop. If secrecy
prevents it, that town task goes ahead. Another chance is offered before the
next business task only when its route passes North Barloque. A successful visit
consumes all later chances. No chance is offered after the last vault/shop stop:
banking and the return continue, and ordinary keeper banking cannot reinsert a
hall visit. Cash is 20% of available bank-bound money **at the accepted visit**;
sales after that visit do not cause another hall trip. Shopping supplies also
obey secrecy; a refused coop supply visit falls through to private funding.

Before selling on a town trip, bots contribute only reagents selected for sale
by the existing inventory rules. Explicitly protected items, fleet keep items,
equipped gear and personal loadout supplies stay with the bot. A reagent's
overflow remains eligible for sale; legacy `guild_wants` protection and transfers
are superseded while the coop is enabled. The old chest plan is preserved on disk.

Before purchasing, bots visit the hall for their requested reagent quantities,
subject to their carrying capacity. They subtract confirmed withdrawals from
the purchase plan and source shared shillings for the remaining reagent bill.
The cash allowance is bounded once for the entire visit; food, gear and extra
cash reserves cannot multiply it across chests. Private banking funds the
remaining bill. An unavailable hall does not cancel shopping or the assigned
farming destination. Existing poor-farming behavior still applies when funding
remains insufficient.

Every automated coop transaction takes a fleet-scoped process lock, reads actual
chests from the server, sends tagged quantities, and checks inventory and chest
deltas. Unknown chest contents cannot be treated as empty; unknown bulk cannot
be treated as room for a deposit. Interrupted return journeys resume without
repeating completed transfers. A completed town-trip cash tithe is not charged
again on a banking retry. Manual chest users do not participate in the keeper
lock; contents are refreshed before transfers to reduce that race.

Receipts are appended to `substrate/stockpile/<fleet>.coop.ndjson`; chest snapshots
also refresh the existing storage display. Never edit/delete an active coop lock.
This shared-money tithe is separate from the existing Frular guild-rent tithe.

Hall access uses the foyer-side entrance trigger and the inner, hall and secret
door triggers in both directions. `m59-ceiling-doors.json` holds all 32 exact
combinations of these five ceiling doors, generated with
`node tools/m59-ceiling-doorbake.mjs --write` against the unchanged routing
baseline. The keeper observes the actual client's `onEvent` stream (the client
is not an EventEmitter), updates both collision geometry and route masks, and
uses the ceiling lift's speed to wait for it. An eight-second generic movement
block would outlast the hall's five-second opening. Floor and ceiling updates
are distinct, and room entry clears the previous room's sector observations.
`node tools/m59-ceiling-doors-test.mjs` checks the live packet seam and both
directions of every hall passage against the real baked geometry.
The six invisible guild entrance sensors are recognized by their exact room
resource, positions, flags and blank icon. They are harmless entry triggers,
not unknown damaging spell objects; the rest of the hazard filter still applies.

Offline verification: `node tools/m59-reagent-coop-test.mjs`, plus the purchase
funding, purchase strategy, human controls, stockpile, guild wants and tithe tests.
