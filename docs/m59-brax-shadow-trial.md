# Brax full-shadow trial, 2026-10-16

The public `walk-to-brax` script reached Ancient Graveyard of Brax (827) with
**1 of 24 clones**. There were **zero observed character deaths**. The other
23 ended in Ancient Place (579). The strict-majority condition did not hold,
so no farming orders were issued and no first-hour farming measurement exists.
This is a failed fleet-scale route trial, despite the earlier three-character
setup trial succeeding.

The original order started at 19:48 UTC (12:48 PDT). Four bounded attempts,
including three corrected retries from actual current positions, ended at
20:31:54 UTC (13:31:54 PDT), about 43.6 minutes later. The first three attempts
had zero full-route successes; the fourth had one. Retries retained all prior
failures and deaths. This is not a fresh-clone success rate for each build.

## Final outcomes

| Outcome | Count | Production equivalents |
|---|---:|---|
| Arrived alive in 827 | 1 | Rizzo (78/78 HP) |
| North exit follower stopped after the second jump | 4 | Zoot, Fozzie, Lew, Raphael son of Mephistopheles |
| Position confirmation failed after the second jump | 1 | Beaker |
| Waiting for preceding jumper to clear the north ledge | 1 | Robin |
| Cliff follower stopped | 15 | Kermit, Bunsen, Camilla, Animal, Sweetums, Pepe, Piggy, Janice, Zheng He, Rowlf, Loial the Ogier, Clifford, Floyd, Gonzo, Scooter |
| Rail entry follower stopped | 1 | Statler |
| Cliff follower ended outside required takeoff tolerance | 1 | Waldorf |

Both 20-HP characters, Zheng He and Loial the Ogier, survived but stopped on
the cliffs. Raphael, at 26 HP, rode the lift and made the second jump, then
stopped on the north exit rail. No result demonstrates their farming survival.

## Elevator evidence

Nine distinct clones boarded the platform across the attempts. Three lift
ascents were observed: the first with Kermit/Janice, the second with
Beaker/Zoot, and the final one with seven riders. A separate third-attempt
puzzle was abandoned on a Windows shared-journal rename error before its
corners were completed. These are debugging trips, not three successful
transport batches into Brax.

The final batch was Rizzo, Zoot, Raphael, Beaker, Fozzie, Robin and Lew.
All seven boarded and completed their corner assignments. Six recorded the
second-jump landing; Robin stopped while waiting for Beaker's lane clearance.
Beaker reached the north shelf but failed the subsequent confirmed-position
read before recording clearance, which held that lane. Rizzo alone completed
579 -> 578 -> 826 -> 827.

The lift delay remained 37,667 ms, followed by observed-height validation.
No geometry, collision, gravity or movement-authority rule was relaxed.

## Corrections and remaining failures

The trial exposed an ordinary entrance offset from the saved rail, synchronous
exit planning in keeper status reads, stale/failed state refreshes under load,
occupied platform stations from previous batches, animation waits shorter than
the puzzle animation, and Windows atomic journal replacement contention.
Corrections add a proved entrance connector, cache-only status exit reporting,
ordered identity-checked position reads, bounded transport/body waits, free
platform stations, resumption from physically reached route stages and bounded
Windows replacement retries. These changes do not establish reliable fleet
travel: the final result above remains the acceptance evidence.

An experimental strict straight-chord rail option rejected existing mana-node
rails during attempt three and was removed for attempt four. The stock mover's
existing geometry, body, height and ownership checks remained enabled.

Many final cliff followers stopped on failed state refreshes (several cached
snapshots were 7-10 seconds old); others reported route deviation or a wrong
shelf. North-exit followers also reported deviation. Waldorf's follower reported
arrival at the takeoff square, but its actual fine position missed the outer
script's tighter takeoff tolerance. These failures must remain visible rather
than being counted as success based on coarse squares.

The last journal replacement retry helper was written after the fourth
controller imported its module. Its offline checks therefore apply to the
saved code; the final live run did not validate that helper. Extra journal
polling readers were stopped before the final lift operation.

## Conditions and limits

All 24 production roster equivalents were included, including weak mules.
Source rooms and coarse coordinates, captured current HP/vigor/mana, attributes,
abilities, observed inventory and policies were copied during construction.
After the recorded cutoff at 19:46:21.399 UTC, there were no administrative
commands, teleports, healing/stat/item grants, monster changes or world resets.
Normal monsters and ordinary keeper survival remained enabled. The server and
keepers were left running after measurement.

Clones are an approximation: hidden item properties/charges were approximated
by class, unidentified items were not invented, bank balances and the mana-node
mask/base-mana were not cloned, and some faction shields did not equip. The
fresh clone guild has no hall because the corresponding native hall already
belongs to an existing lab guild. Recovery and provisioning can consequently
differ from production. These limits constrain production predictions; they
do not turn the route failures into evidence of successful travel.

## Local evidence

Private runtime evidence is intentionally gitignored. In the trial worktree:

- `substrate/brax-shadow-trial/status.json`: final 1/24, no deaths, no farm window.
- `substrate/brax-shadow-trial/events.jsonl` and `samples.jsonl`: observations.
- `substrate/brax-shadow-trial/travel-result*.json`: preserved attempts.
- `substrate/brax-attempts/braxshadow22-1792181826187.jsonl`: Rizzo's successful route.
- Other `braxshadow*-*.jsonl`, follower command receipts and stdout retain failures.
- `substrate/brax-shadow-admin-cutoff.json`: construction cutoff.

Do not publish the source snapshot or roster: they contain private credentials.

## Regression validation

The saved fixes completed `npm run test:movement`: **81 suites, zero
regressions**, with the existing named baseline failures unchanged. Focused
body-wait tests additionally cover expiry, changed rooms, cancellation,
unknown positions and terrain refusals. Offline regressions validate those
contracts; the live acceptance result remains 1/24.
