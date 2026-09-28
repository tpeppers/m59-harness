# Death cost and travel on the fleet dashboard

The death columns show **True Deaths / no HP loss / unknown**. True Deaths require
recorded loss of maximum HP. A character below 30 max HP is marked separately;
level alone never establishes the cost of a death. Old records lacking before/after
evidence remain unknown. `/deaths?impact=true_deaths` filters the log and charts;
`no_hp_loss`, `unknown`, and `under_30` are also supported.

The keeper requests fresh health stats while waiting for the death broadcast and
writes `max_hp_before`, `max_hp_after`, and `max_hp_lost` into its death summary.
No fresh response means unknown. A `death_cost` ledger event joins a sampler's
earlier `died` event by character and exact `death_at`, so an in-flight report does
not permanently lose its HP classification.

`/travel` supports `hours` (6, 24, 168, 720 in the selector) and map sorting by
`crossings`, `issues`, `collisions`, `stuck_ms`, or `issue_rate`. It reads the fleet
ledger and retained transit books, filtered by the serving broker's character set.

- Distinct maps come from actual observations and arrivals. Failed intended
  destinations are excluded. Map-entry events are recorded on room changes, with
  a fresh baseline after reconnect.
- Journeys include travel and zone-change outcomes; missing outcomes are unknown.
  Elapsed journey time includes pauses.
- Chalice rides require `landed`. Rescue and Elusion count cast requests, not
  successful teleports. Portals require a confirmed portal crossing. Leaving map
  1 records an Underworld exit; an Underworld portal can count in both categories.
- Map crossing statistics use at most 600 retained transits per character. The
  selected time window can exceed that history; the page states this limitation.
- A crossing issue means failure, recorded refusals, or multiple exit attempts.
  Collision counts require a refusal explicitly naming collision.
- Stuck time unions overlapping `wedged_for_ms` intervals per character and map,
  clipped to the selected window. It never substitutes total transit or rest time.
- The busiest map without recorded issues requires at least five crossing attempts,
  known outcomes, no crossing issues, and no recorded stuck time.

Offline checks: `node tools/m59-death-impact-test.mjs` and
`node tools/m59-travel-summary-test.mjs`, alongside the existing ledger, dashboard,
death observation, death tally, post-mortem, and collision suites.
