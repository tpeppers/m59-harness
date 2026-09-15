# Player combat evidence and dropped loadouts

Every ordinary Session passively observes player combat messages, health pushes,
visible player positions, death broadcasts and newly appearing ground items.
This includes keepers inside travel/shopping awaits. It sends no additional game
requests and changes no production combat or survival policy.

The Session keeps bounded event windows. A separate worker thread appends JSONL
under `substrate/player-evidence/<server-hash>/`, with one file per writer/day.
Rows retain the server, observer, subject character, room, timestamps and recorder
code provenance. Missing commit provenance remains null, with hashes of the
evidence module bytes loaded by the process. Lab rosters use their own runtime
directory. `player_evidence` in keeper state reports persisted, pending, dropped
and error counts. A forced process kill can lose pending data; graceful stops
flush for up to five seconds.

## Inspect and model a player

These commands read local evidence; `--server` identifies its source and does not
connect to that endpoint. Use the exact roster host and port.

```powershell
node tools/m59-player-intel.mjs estimate Morpheus --server HOST:PORT --room 39 --since 2026-09-14 --out morpheus.json
node tools/m59-player-intel.mjs backfill substrate/postmortems --server HOST:PORT
node tools/m59-player-intel.mjs fact Morpheus --server HOST:PORT --room 39 --item BerserkerRing --source 'Operator observation; encounter description'
```

`--dir` selects another evidence directory. Backfill is idempotent against existing
server/character/observer/time/message records. It uses checksummed replay health
pushes when available, retains text without HP when unavailable, and reports read
failures. It does not invent historical dropped loot from inventory prose.

An estimate includes weapons, resolved-attack accuracy, nearby unconfounded HP
losses, fatal lower bounds, per-victim encounter windows and defensive skill
assumptions. Dodge, parry and block messages produce the operator-requested 99%
scenario for that specific defense. “Avoid” does not identify a defense skill.
Skill evidence follows the character across rooms; equipment facts stay scoped
to their recorded room. A fact records when we learned it, not an invented
historical observation time. Older facts remain in the journal.

The conditional inverse accuracy model uses the native 55% equal-offense/defense
constant and the 10–95% chance bounds. It assumes equal stroke/proficiency,
attacker aim 30 and base maximum HP 100 unless overridden with `--aim` and
`--max-hp`. `--defense` supplies a victim-defense scenario; otherwise encounter
estimates use cached victim stats and abilities, with omitted armor/effects
explicitly listed. A hit-rate boundary has no unique point estimate. Damage,
accuracy and weapon prose cannot uniquely identify actual skills. The retained
death records are a selected sample, not a random sample of all combat.

Build a portable model from a complete native loadout template:

```powershell
node tools/m59-player-intel.mjs model Morpheus --server HOST:PORT --room 39 --template scimitar-ring-shield.json --offense 99 --out morpheus-model.json
```

The template must equip the observed weapon, match the room-scoped berserker-ring
fact, and include a shield if Block was observed. Shield type, durability,
enchantments, armor and other template state remain explicit assumptions.
`--offense` deliberately selects a 1–99 offensive scenario; it is not silently
promoted from an uncertain estimate to a historical fact. The resulting ordinary
`m59-player-loadout/v1` file works with the shared simulator `--loadouts` mapping
and its exact native restore/readback. “Exact” verifies the supplied model.

FleetScript/FleetScratch can import `readPlayerEvidence`, `estimatePlayerCombat`
and `modelPlayerLoadout` from `m59-fleetscript.mjs`, then pass the resulting
loadouts to `simulatePostMortem` or `simulateScene`. See
[the shared replay workflow](m59-death-replay.md).

## Witnessed loot

A player death broadcast is associated with a player currently visible in the
room, or seen there immediately before vanishing. A global announcement alone
does not qualify. The observer records new gettable objects on that player's
last coarse square from one second before the announcement to two seconds after,
plus a snapshot of visible ground items. Fine coordinates, names, quantities,
rarity, object IDs at observation, appearance time and disappearance time survive
even if another player picks an item up immediately. No bot picks up loot to
collect this evidence.

The character's estimate exposes `dropped_loadout` and the complete
`dropped_loadout_observations` history. Attribution is a spatial/temporal estimate:
several deaths on the same square retain all candidate owners. Recently vanished
players, predicted positions, shortened observation windows and dropped capture
events are marked. Existing floor items stay contextual and are not newly
attributed. An empty observation means no new drops were seen, not an empty
inventory. Dropped carried items do not prove they were equipped or reveal all
attributes; they are never automatically equipped by the model builder.

PvP simulation receipts include each stand-in's evidence status and recent
records. The postmortem report also exposes `witnessed_dropped_loadouts`, keeping
the shadow witness and original captured identity together. Temporary account
cleanup preserves these reports.

Guild-only rooms still require eligible guild identities. A refusal such as
“Only those in guilds may attack each other here” is counted and flagged in
`pvp_validation`; survival in that trial does not establish protection against
the intended attacker.
