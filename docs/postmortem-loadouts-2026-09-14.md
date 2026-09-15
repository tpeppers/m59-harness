# Exact loadouts in postmortem simulations

The postmortem simulator now accepts complete portable loadouts for victims and temporary player stand-ins. The same code serves scene preparation, held-scene capture, CLI simulations, FleetScript and FleetScratch. It verifies restored native state before starting combat, rather than treating successful item creation as proof of a match.

Implemented and tested on September 14, 2026 Pacific time (September 15 UTC). All live work used the owned Docker scene lab on loopback ports 17959/17998. Production keepers and the separate shadow fleet were not used for these experiments.

## What the model carries

- Item class, equipped status, spare inventory, stack quantities and native scalar properties: durability, attack type, damage/hit/defense modifiers, charges and appearance flags where present.
- Permanent item attributes and timed enchantments with their remaining duration. Timers are paused during preparation, armed before release and checked against native timer state.
- The full skill/spell lists, including proficiency and used/unused encoding. Server school totals, carried weight/bulk and lighting are recalculated after restoration.
- Per-player combat sequences using normal casts and attacks. Spell availability does not invent a historical casting strategy.
- Checksum-protected files, source provenance, expected/actual state hashes, timer receipts and explicit refusals for unsupported state.

Exact loadout verification is relative to the supplied profile. The historical Gonzo recording does not reveal Morpheus's hidden gear or abilities. The following profiles were lab fixtures assigned to his stand-in, not discoveries about his historical equipment. Character attributes/vitals and player effects remain separate from the portable item/ability model.

## Live results

All paired experiments used the latest living frame from `Gonzo-2026-09-14T23-19-35-270Z.json`, with the selected victim at 5/48 HP and five other player bodies. Morpheus alone was selected to attack. Monsters were removed and lab scenery was selected explicitly. Every case reloaded the native checkpoint and created fresh temporary accounts.

| Fixture | Attacking result | Idle control | Restore to start |
|---|---|---|---|
| Exported lab axe loadout: 2 items, 10 skills, 6 spells | 1/1 died; server-confirmed axe kill | 0/1 deaths in 10 s | 10.06–10.72 s |
| Worn enchanted axe (+3 damage, +6 hit), worn leather armor, spare axe, 37 coins; 10 skills, 6 spells | 2/2 died; server-confirmed axe kills | 0/2 deaths in 6 s | 10.07–10.46 s |
| Equipped caster fixture: 6 items, 10 skills, 7 spells, 20 red mushrooms and 20 orc teeth; victim also given an explicit loadout | 1/1 died to fireball; two casts, first unsuccessful, then a confirmed kill | 0/1 deaths in 8 s | 11.09–11.14 s |

Every trial verified complete native item/ability state and confirmed temporary-account cleanup. The enchanted fixture restored 44,982 ms remaining on the enchantment; pre-release reads showed 44,972–44,976 ms. Its complete scene preparation took 113–122 ms. Most total setup time still belongs to five account-backed stand-ins and their paced login/read synchronization, not item construction.

These results prove that equipped weapons, armor, spell proficiency and reagent inventory participate in real server combat through the reusable simulator. They are not estimates of historical Morpheus damage or of lives saved by a survival intervention. An idle control's survival ends at the stated observation horizon.

## Round-trip and failure checks

A separate live test restored a 1,500 ms enchantment, captured the held scene through both the in-process `snapshot()` and serialized `capturePreparedScene` routes, and verified both retained the full requested duration. `releasePreparedScene` armed it with 1,493 ms remaining; after 1.8 seconds the native callback had removed the enchantment. The test closed its leased lab session afterward.

An early armor trial was correctly refused because normal equip handling recolored the item for the stand-in. Restoration now preserves the supplied item fields after normal equip handling and still verifies that equipment use succeeded. That failed trial's partial report was retained. No unsupported state was silently substituted.

Offline coverage checks native-list parsing, malformed/unsupported state, exact condition/modifier/equipment/ability mismatches, timer pause/arm behavior, strict name binding, checksums, equipment refusal cleanup, production-address refusal, and identical loadouts/sequences across paired cases. The existing postmortem, scene, death replay, simulator and combat suites were also run.

Private evidence remains in this session's `substrate/replay-smoke/`: `loadout-live-1.json`, `loadout-live-enchanted.json` (refused setup), `loadout-live-enchanted-2.json`, `loadout-roundtrip.json`, and `loadout-live-caster.json`. Runtime captures and account journals are intentionally excluded from Git. The lab image was `sha256:1f6d74022530f07c8a69f8f6944d59adcb8e2275f60f435b91ec2e8d3612bd36`, built from server commit `1fb1f51478d14a2a7fa37a2bb5899899c0115c44`; each trial also carries harness/source and checkpoint provenance.

Usage and limits are documented in [the replay guide](m59-death-replay.md#exact-supplied-loadouts).
