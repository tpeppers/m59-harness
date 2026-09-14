# Morpheus death-attribution audit — 14 September 2026

The production postmortems confirm **18 murders by Morpheus**, from 21:45:17 through 23:19:35 UTC (14:45–16:19 Pacific). Each contains both the victim-only server message naming Morpheus and the global announcement that the victim was murdered. These are direct server observations, not an inference from who happened to be nearby.

The first scan found 15; three additional records arrived during the audit and rollout.

| Victim | Murders in this window |
|---|---:|
| Lew | 2 |
| Animal | 2 |
| Waldorf | 2 |
| Kermit | 2 |
| Floyd | 2 |
| Fozzie | 2 |
| Beaker | 1 |
| Bunsen | 1 |
| Janice | 1 |
| Zoot | 1 |
| Piggy | 1 |
| Gonzo | 1 |

## Why they were misreported

The global murder announcement intentionally omits the killer's identity. The recorder consequently stored an empty killed_by list. The dashboard and critic only accepted broadcasts with a named killer, so some reports fell through to a nearby-creature guess. The MCP listing was worse: it always reported the nearby threat list as killed_by, irrespective of the broadcast.

The victim receives a separate message: “You are dead, poor soul. Go now, and take revenge on Morpheus!” The server source at user.kod, Killed(), sends GetTrueName to the victim (around line 6915), explicitly including the real identity of a morphed or anonymous killer. Its message resource is user_was_killed. That is the authoritative identity source used here.

## Changes

- A shared attribution module joins the victim message with the matching death announcement. Personal evidence is bounded to five seconds from that announcement; player speech and old messages are excluded.
- An explicit murder with no surviving identity is “Unnamed player (murder)”. Nearby monsters or players cannot fill in its killer.
- Environmental and own-folly announcements likewise cannot become nearby-monster guesses.
- Raw broadcasts, server text, positions, frames, survival decisions and replay references remain intact. Derived summaries retain nearby actors separately from the killer.
- New keeper records, pending death events, activity feeds, ledger events, dashboard digests, MCP records/listings and travel-critic attribution use this interpretation. The critic recognizes confirmed PvP even when the killer has left visibility.
- The MCP newest-first listing now sorts by death timestamp in the filename, instead of character name.
- The cause chart defaults to individual player names. Radio options group all player killers together, or show PvP / PvE / Unknown. PvE includes creatures and environmental/self deaths; unresolved evidence stays Unknown. Source groups still drill down to victims.

## Historical correction and validation

The 17 original records were backed up byte for byte, with a SHA-256 manifest, under:
`substrate/attribution-backups/2026-09-14T23-18-01-942Z-f3d1c07f/`
in the production checkout. The repair updates only derived attribution fields and is idempotent. Original text and anonymous global announcements are preserved.

The final Gonzo record was corrected separately, with its original and manifest under
`substrate/attribution-backups/2026-09-14T23-22-49-508Z-5bfc4054/`.

Offline regression coverage includes real keeper death-writing logic, a personal message arriving during the broadcast wait, anonymous murder, stale messages, player-chat spoofing, another victim's announcement, repeated deaths, true versus morphed identity, monster/environment/self deaths, cause grouping, critic classification, and byte-identical repair backups. Existing death-dashboard and travel-critic tests also pass.

Deployed code: `b289df8`, tag `deploy-2026-09-14-8`. The service restart completed, with 23 keeper child processes and 23/23 characters in game. Live MCP checks confirmed chronological listing and Gonzo's corrected attribution while preserving the anonymous broadcast. Browser checks verified all three radio modes and returned the page to the default. At verification, the seven-day chart showed Morpheus 81, Rick Deckard 22; grouped players 103; PvE 398; Unknown 7. The shared reader also corrects older records at read time, which is why these week-long totals exceed today's 18 repaired files.

This corrects the attribution of the killing blow. It does not establish that travel/shelter behavior had no contributing defects, or that a different intervention could not have saved a victim.
