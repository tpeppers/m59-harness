# Ancient Graveyard of Brax capacity trial — 2026-10-19

The fleet can earn substantial hammer kill credit in map827, but this build did
not demonstrate reliable unattended logistics or acceptable survival. The corrected
real hour produced **91 credited kills (51 daemon skeleton, 40 narthyl worm)**,
**three distinct farmer deaths in827**, and **one courier death in578**. No complete
rolling supply cycle finished during that hour. Do not deploy this scenario as a
self-sustaining farm on the strength of the kill total.

## Measurement and population

The corrected window ran from **14:04:06 to15:04:07 PDT**, with each of20 positively
acknowledged farming orders measured for its own real60minutes. The population was
24 intended farmers plus two extra mainland couriers. Four farmers had already
been lost during setup/an earlier aborted attempt; they were neither replaced nor
rescued. The upper runner was one of the20 farmers, not free logistics labor.

The measured source was the owned build at8477229f, before the subsequent main
integration, generalized convoy changes and courier pre-submission deferral fix.
Twenty-one runtime/controller/manifest inputs were archived by SHA256. All26 native
policy audits matched the full cloned policy plus explicit scenario overlay, and
external loadout floors were present. All20 starting farmers had native equipped
hammers. The server, monsters and world were unchanged after the construction cutoff;
all later movement, purchases, gifts, recovery and deaths used ordinary game rules.

Clone fidelity has limits: source capture spans time; hidden item condition,
charges and enchantment state were not proven identical. Source external loadouts
were copied with explicit missing-file records and task floors; the lab guild mirror
does not reproduce every production guild resource. These limits constrain causal
comparison, even though the native full-policy/ability checks passed.

The private `capacity-audit3.json` reconciles ledger and postmortems using actual
`death_at`, not the later time a `died` event was emitted. The controller's original
audit double-counted each of the four measured deaths this way; its raw output is
preserved, not silently rewritten. Canonical incidents agree with keeper death-counter
deltas. All measured kill-counter deltas agree with durable credited-kill events.
Kill events have no unique creature ID:91 is credit across characters, not proof
that91 distinct monster bodies died. Nineteen of20 ordered farmers earned credit.

## Occupancy, equipment and time

| Measure | Result |
|---|---:|
| Intended24 farmer-minutes | 1,440 |
| Ordered20 farmer-minutes | 1,200 |
| Alive time in827 | 1074.8 minutes |
|827 occupancy, ordered20 denominator | 89.6% |
|827 occupancy, intended24 denominator | 74.6% |
| Equipped hammer time within alive827 time | 99.6% |
| Full-resource nearby-target wait candidates | 133.6 minutes |
| End-of-hour ordered farmers physically in827 |16 |
| End-of-hour upper runner |578, service stalled |
| Ordered farmers that avoided a measured death |17/20 |

Time below uses the20 ordered farmers, including their runner and post-death time:

| Sampled category | Farmer-minutes | Share |
|---|---:|---:|
| healthy wait | 173.5 | 14.5% |
| unknown or disconnected | 9.1 | 0.8% |
| combat or fight attempt | 254.8 | 21.2% |
| other wait | 59.6 | 5.0% |
| recovery | 539.7 | 45.0% |
| movement or pull | 45.1 | 3.8% |
| death recovery | 1.5 | 0.1% |
| outside lock | 63.0 | 5.2% |
| internal hauling | 4.6 | 0.4% |
| exchange | 0.3 | 0.0% |
| service stalled | 48.8 | 4.1% |

Samples were collected about every15seconds and carry at most30seconds of evidence
across a gap; the rest is unknown. These categories describe sampled state, not
precise attack wall time. Healthy wait means full HP/full MP and vigor at least70
out of200. It can include a pull window, a blocked approach or the gap between fight
attempts. Nearby visible enemies do not prove line of sight or a legal attack path.
Healthy wait plus other wait was19.4% of ordered time; adding the upper service stall
makes23.5%. Recovery alone occupied45.0%. The nearby-target candidate count overlaps
these categories and must not be added to them.

Casting does not disappear because no sample landed in the standalone casting
category. The durable ledger recorded952 cast events:804 minor heal,141 create food,
and7 create weapon. Only7 of those minor-heal events were marked `ok:true`;797 were
non-success, including attempts on already whole allies. These are the recorded
event outcomes, not a complete census of paid recovery heals. Repeated ineffective
support casting deserves investigation alongside recovery and targeting stalls.

## Logistics: ledge proof succeeded, continuous service failed

Ordinary bidirectional small-cargo ledge trades passed. Loaded qualification also
proved upper827→826→578→826→827 and lower Jasper/350→568→578→568→350 returns, with
the farmer side retained on the upper component. No elevator was used. The final
pre-hour preparation passed actual hammer, policy, loadout and return checks.

During the measured hour, Jasper sales and purchases did occur. The journal proves
19 herbs passed from a courier to the upper runner; a separate native gift event
also records six bread at that runner. Neither proves delivery to the workforce.
Five other successful journal trades collected farmer loot/funds into the runner.
There were **zero complete measured service cycles** and no journal-proved onward
provisioning to ordinary farming recipients during this hour. Preparation stock,
source inventory, ordinary food creation and loot supported the farm independently
of a successful rolling loop.

Courier B was killed by a troll during its lower578 return. Courier A subsequently
stopped with `cargo changed before submission`, leaving itself and the upper runner
in578. A system save renumbered object IDs during the sequential exchange. The
service had retained its earlier chosen-item list, then rejected a missing old
handle against a fresh inventory. Correlation and the code expose a stale-plan
failure mechanism; the raw evidence does not identify every disappearing item.
The post-hour fix defers a proved stale/missing *unsubmitted* row with explicit
zero-submission evidence, so a later ordinary cycle can select fresh cargo. It
still stops ambiguous or partial accepted trades. That fix has offline regression
coverage and was **not** retroactively tested by this measured hour.

Pack capacity, source-protected inventory, reserve floors and90%-health stationary
trade admission also limited service. Some native full-pack refusals disagreed
with predicted free capacity and were correctly deferred. Readiness refusals at
very low courier/runner health were not deliveries. Income is not established:
source gems, preparation stock and two extra funded couriers confound any estimate
of self-financing profit.

## Deaths and cross-session explanations

| Phase | Farmer incidents | Courier incidents | Location/attribution |
|---|---:|---:|---|
| Setup |1 |0 | Floyd: unknown pre-login fatal location/cause |
| Aborted first episode,11.8847minutes |3 |0 | All827; one worm, two daemons |
| Intervening ordinary preparation |0 |0 | No additional incident found |
| Corrected full hour |3 |1 | Farmers827/daemon; courier578/troll |
| Post-window cleanup |0 |0 | No additional incident found |

The earlier episode's8 daemon credits and three deaths remain separate. All four
corrected-hour deaths have linked session evidence and explicit victim/broadcast
killer messages; none is assigned a guessed killer or location.

- Raphael,26HP,21:31:30UTC: reconnected at a recovery wall, left it, recorded a
  three-round fight with zero landed hits, used a healing wand at3HP and briefly
  reached10HP, then died before reaching the selected recovery wall. The fatal
  position was outside the held wall. Healing/high vigor did not overcome this
  small health buffer and the exposed recovery transition.
- Bunsen,74HP,21:44:10UTC: linked sessions show recovery32→74HP with hammer and armor
  equipped, then a new pull. Quarry tracking detected an ID/name mismatch, switched
  focus, and the final farming pass lasted about29seconds. The body was two squares
  from its claimed wall, with no recent swing and no watchdog interrupt before the
  daemon killed it. Full mana did not imply an available heal: its session evidence
  listed no known healing spells. The post-death one-item pack is not evidence that
  it had discarded its hammer before death; pre-death samples prove the opposite.
- The81HP farmer,21:51:36UTC: `object_blocked` prevented reaching the selected wall.
  At33% health it chose the permitted retreat into826, but fell to6–8HP and stalled
  before reaching the exit. A daemon killed it in827. Confinement correctly refused
  an828 escape while preserving826; the retreat was too late/unsuccessful.
- Courier B,21:11:11UTC: prolonged very low health during lower578 travel, no held
  wall at the fatal location, and explicit troll attribution. Its later21:15:40
  ledger notice describes this same incident, not a second death.

The traces identify failure sequences and remaining hypotheses, not proof that a
single proposed scheduling change would have prevented each death. The setup Floyd
loss remains unknown because no pre-login fatal sequence was captured.

## Comparison with the plan and previous hour

The previous test earned16 credits (10 worms,6 daemons), had two farmer deaths,
and placed515/1,440 farmer-minutes in827 (35.8%). This corrected hour earned91
credits, with1,074.8/1,440minutes in827 (74.6%), three farmer deaths and an additional
courier death. Occupancy improved substantially, but continuous service failed and
survival did not meet a reliable unattended-farming standard.

The plan's85% occupancy target was for the intended cohort. After four prior losses,
20/24 gives a maximum83.3% even before hauling or further deaths. The ordered20
view exceeded85% at89.6%; it must not substitute for the24-person result. Source
capture, current health, policies, equipment retention, initial monster stock,
build changes, population and two extra courier accounts differ from the prior
hour. This is not a clean A/B test and the credit increase cannot be attributed
entirely to lockdown.

The inspected room source has25-monster cap,60/40 daemon/worm mix,7–9 initial
monsters and a40,000ms generation period with80% chance. With default division by
five and100% server spawn setting, about360 successful chance rolls/hour are a
source-derived reference before cap/placement effects. Saved runtime settings and
compiled identity were not verified against that reference. The native qualified
pre-hour observer did see25 targets (13 daemons,12 worms). Neither figure is an
achieved unique-kill capacity.

## Readiness and next work

Hammer farming in827 is viable for this population, but the automation is not yet
reliable enough to promise persistent24-person farming. Priorities are reliable
courier recovery/returns and fresh inventory intent, bounded health-aware combat
and pull continuations, early retreat through occupied geometry, and support-heal
selection backed by actual recipient needs. Reproduce the linked fatal sequences
before claiming prevention. A future sustained trial must verify recipient stock,
complete service cycles and survivability without relying on preloaded inventories.

Generalized passage/rail changes developed after this hour have their own offline
native-packet and concurrency tests. This report does not claim they improved the
measured hour or establish a new live migration p90.

Only the trial broker and26 keepers were stopped after the audit. The local server
PID41300 was verified alive for replay-video work. Runtime rosters, credentials,
raw actor histories, controller scripts and the credential worktree are preserved
locally and are not part of the repository report.
