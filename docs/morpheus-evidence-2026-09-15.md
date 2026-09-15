# Morpheus evidence and witnessed loot — 15 September 2026 UTC

The feature records combat observations and dropped-loadout snapshots, and can
produce explicitly assumed loadouts for the existing shadow simulator. It does
not change live survival decisions.

The initial backfill examined 3,570 retained postmortems and added 850 distinct
player-combat observations. No referenced replay failed its checksum/read. From
14 September UTC through the last retained observation at 15 September 02:53
UTC, Morpheus's records contained:

| Observation | Result |
|---|---:|
| Resolved incoming attacks | 139 |
| Hits naming a scimitar | 129 |
| Observed hit rate | 92.8% |
| Descriptive 95% Wilson interval | 87.3–96.0% |
| Hits with a single nearby replay HP-loss push and no competing retained hit | 127 |
| HP loss across those matches | 1,475 |
| Mean observed loss per matched hit | 11.6 HP |
| Fatal, damage-censored matches | 46 |
| Observed defensive uses | 6 dodge, 6 block |

These are retained death encounters, not an unbiased sample of Morpheus's fights.
HP associations remain provisional: incomplete message retention can hide other
damage. Fatal HP loss understates a blow that exceeded remaining HP. Longer-term
records also contain hammer and arrow attacks, so equipment changed over time.

The narrow Upstairs Castle Victoria record was Beaker's encounter: three
scimitar hit messages, with only the final 13-HP fatal loss matching cleanly.
The earlier two have competing damage and remain available as unmatched evidence.
The operator's berserker-ring observation is recorded for room 39; it is not
applied automatically to the Valley or another room.

Native source explains the limits of inverse inference. Offense combines stroke,
weapon proficiency, aim and maximum HP, then modifiers; defense combines skills,
agility, maximum HP and equipment/effects. The berserker ring subtracts a random
150–250 offense and adds 1–4 damage on a non-ranged attack, consuming durability.
“Cleaves” is the slashing killing-blow description, not a numerical damage tier.
Several plausible skill/stat combinations therefore fit these observations.
The estimator supplies conditional ranges with explicit assumptions, and omits a
point estimate at the hit-chance boundary. Seen Dodge and Block become 99%
modeling assumptions; Parry is not asserted as observed here.

## Validation

- Native Scimitar/BerserkerRing capture, restore and complete readback passed.
  A further template with a MetalShield passed, so a 99% Block scenario can
  actually use a shield. The precise shield type is an assumption.
- The CV scene attempted five attacks, but all were refused by the room's
  guild-only rule. Its survival result is inconclusive for PvP effectiveness.
  That refusal is now recognized and explained in simulation reports.
- An explicitly varied Valley scene using the scimitar and ring produced a
  confirmed stand-in kill; the paired idle control survived eight seconds.
  Five witnesses captured the dead player's axe and shilling, associated with
  the victim, including fine coordinates and rarity. Cleanup verified for both
  trials. This checks the machinery, not a causal claim about historical CV.
- These multi-player, full-loadout trial restores took approximately 11 seconds.
  The new passive observer processed 10,000 cached health events with 200 ground
  objects in approximately 75 ms in the offline benchmark. Journaling runs on a
  separate worker; overload and write failures are counted.

Offline checks cover message parsing, competing HP losses, death/drop ordering,
rapid pickup, multiple deaths, cross-room/global broadcasts, source-server
isolation, skill assumptions, native loadouts, postmortem controls, scene replay,
keeper authority and death observation. All 301 existing FleetScript checks
passed for the public workflow.

Private evidence is under `substrate/player-evidence/` in production. The owned
development worktree retains the model/template and live receipts under
`substrate/replay-smoke/intel-*`, with witness journals under the lab roster's
`.lab-runtime/replay-native/shards/` directory. No credentials or runtime records
are committed. Usage and limitations: [player evidence](m59-player-evidence.md).
