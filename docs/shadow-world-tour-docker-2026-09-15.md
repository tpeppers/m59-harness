# Full shadow fleet world tour and independent Docker replays

Date: 2026-09-15. **The 21-character fleet completed 166 checkpoint legs with no deaths across two 15-minute runs.** Both directions exercised every link in the seven-stop circuit. With no deaths to dissect, the investigation focused on dangerous recovery episodes. A poisoned traveler exposed a missing initial effect-list read after reconnect; an isolated replay demonstrated fewer recovery interruptions when that information was supplied.

This is an owned-server movement experiment, not a production death-rate comparison. It does not establish a percentage of historical deaths prevented.

## Measured results

| Run | Characters | Scheduled window | Completed legs | Characters completing a leg | Deaths | Handoff failures |
|---|---:|---:|---:|---:|---:|---:|
| Forward, seed 15 | 21 | 15 minutes | 74 | 21 | 0 | 0 |
| Reverse, seed 15 | 21 | 15 minutes | 92 | 21 | 0 | 0 |
| Total | Same 21, restored between runs | 10.5 scheduled character-hours | 166 | — | 0 | 0 |

The death counters and both isolated postmortem directories agree: no deaths. These are repeated checkpoint crossings, not 166 full world circuits or independent statistical trials. Characters completed 1–6 legs forward and 2–6 reverse; no individual completed all seven within either window. Every directed checkpoint link was nevertheless crossed by the fleet. Median completed-leg time was about 140 seconds in both directions. Starting HP and learned-map seeds were reset for the reverse run; server RNG was not held equal. The difference in throughput is not an A/B estimate of code effectiveness.

Forward completed roads: 52→106: 8; 106→153: 11; 153→202: 15; 202→370: 17; 370→39: 15; 39→110: 5; 110→52: 3. Reverse: 52→110: 20; 110→39: 11; 39→370: 10; 370→202: 10; 202→153: 11; 153→106: 14; 106→52: 16.

The forward report's zero-valued HP minima were a harness bug: `Number('')` treated a temporarily logged-out character's unavailable HP as zero. Missing vitals now remain unknown; an actual `0/max` is still preserved. This correction was active in the reverse run. It does not change either run's death count, which used Underworld observations and was checked against postmortems.

## Cases investigated

**Iiii: poison repeatedly mistaken for incoming attacks.** During forward travel toward Castle Victoria, Iiii stopped at a wall at r10c8 in room 587. Native state confirmed poison strength 2500 and an active poison timer. Health eventually reached 1/52 while the decisions repeatedly said `recovery interrupted: took 1 damage while resting — something is hitting us`. Poison alone is nonfatal: the server's `PoisonTimer` clamps health to at least 1. This was not a death or proof that monsters could attack through the wall. It was a low-health recovery loop that would leave little margin for a subsequent real attack.

The native world and cached controller scene were saved during this episode (`tour-critical-forward-20260915`, stamp `1789501094`). Diagnostic replays ran separately while the reverse fleet kept moving; the final normal-code validation followed both fleet runs:

| 120-second replay | Poisoned samples recognized by client | New recovery-interruption choices | Lowest HP | Final HP | Death |
|---|---:|---:|---:|---:|---:|
| Original code, baseline 1 | 0 / 98 | 7 | 1/52 | 8/52 | No |
| Standard player-effect request per connection, request 2 | 77 / 77 | 0 | 1/52 | 19/52 | No |
| Implemented normal login read, baseline 2 (no diagnostic override) | 76 / 77 | 0 | 1/52 | 19/52 | No |

The standard request returned the real `poison` effect. It used no privileged poison information to make a decision. The server protocol requires the player-type byte: `BP_SEND_ENCHANTMENTS` followed by `1`. Normal login/reconnect now makes that read alongside its other initial reads, allowing the existing poison-aware rest behavior to work. This follow-on change was made **after** both fleet runs; it cannot be credited for their zero-death result. Scene captures now retain observed effect coverage and recognized ailments, without making a request on the crisis-capture path. Hidden poison strength and native timers still require the native checkpoint; an empty observed list is not proof of no poison.

An earlier diagnostic awareness override was lost on reconnect and recognized zero poisoned samples. Another attempt broke its diagnostic wrapper's nullable-client handling and remained disconnected. Both raw trials were retained and excluded from the comparison; the latter's generic `survived_window` label is not a valid survival observation. The usable comparison is one original-code baseline, one request trial and one normal-code validation, with timing/initial-state limitations, not a survival-rate study. All reached 1 HP. The implemented read was independently verified with no diagnostic requests, the same 19/52 ending HP and zero interruption choices. Its first poisoned sample preceded recognition. Mixed real attacks plus poison must also be tested before treating the existing broad ailment exemption as universally safe.

**Llll: recovery followed by onward travel.** In room 536, health fell to 29/48. The character established a wall at r23c18, recovered to 46/48 and resumed its original Jasper journey. It completed five legs in the forward window. This validates recovery plus continued movement in this episode; without a no-intervention control, it does not prove that the intervention saved a life.

**Tttt: interrupted approach, then recovery.** Its forward episode in Ukgoth (599) recorded a minimum of 18/47 in decision telemetry. A blocked approach was replaced with an onward-refuge decision. It subsequently reached 47/47 and exited to room 2, with four completed legs by the window's end. A mid-recovery scene still called the decision `approaching` while the actor was healing at another position, which is worth checking when refining decision-completion reporting. It is not evidence of a death or a lost final destination.

**Pppp, reverse:** the corrected harness recorded a low of 11/45, yet the character completed six legs and survived. Other repeated recoveries concentrated around the Badlands (585). These episodes, rather than manufactured deaths, are retained as future tactical test inputs.

Navigation throughput remains a separate concern: in the forward window Jasper→Castle Victoria averaged 342 seconds, and ten Castle Victoria→shadowy-corner legs were unfinished at the bell. A preserved destination and survival do not guarantee prompt progress. A matched old-code/new-code tour with identical world and loadout inputs is still needed before attributing a mortality improvement to these changes.

## What is running

| Purpose | Container | Game / maintenance ports | Broker / dashboard |
|---|---|---|---|
| Entire 21-character shadow fleet | `m59-tour-lab` | `127.0.0.1:18959` / `18998` | `8981` / `8982` |
| Individual saved-scene experiments | `m59-replay-lab` | `127.0.0.1:17959` / `17998` | Dedicated replay worker; no tour broker |
| Production, unchanged by this experiment | Remote production server | `76.214.42.186:5959` | Existing `8901` / `8902` |

Both lab servers run in Docker. They use the same pinned scene-capable image, but different native world volumes, account rosters, ports, keeper ownership claims and writable telemetry/learning directories. Reloading the replay world therefore does not reload the tour world. The tour server has a 2-CPU / 2-GiB container limit; the broker and its 21 child keepers run on the host. This is operational isolation, not dedicated physical CPU hardware.

Image: `sha256:1f6d74022530f07c8a69f8f6944d59adcb8e2275f60f435b91ec2e8d3612bd36` (`m59-scene:lab-pvp`). Server source `1fb1f51478d14a2a7fa37a2bb5899899c0115c44`; scene patch SHA-256 `ab79891bfe2243a606ba8b63bbe28bbf4a883aba17f0519381e1df6839758938`.

Movement code for both tours: experimental `c0d24481adb2cc1ecdc89ab3d5f83b9a91dc6198`, including the held continuity / failed-hop fixes. No production survival policy was deployed for this test. The tour setup's mana correction preserves each character's existing mana maximum instead of changing every maximum to 50. Report/wrapper additions during the tests did not change the running keepers' movement code. The subsequent login-effect read and capture additions remain on the experimental branch.

## Starting population and limitations

The complete existing 21-character shadow combat roster, Aaaa through Uuuu, was imported from the stopped native shadow world's complete four-part save. Its accounts match the older `shadow-ab` roster. A first attempt using newer shadow credentials failed for 19 characters; that was setup, not a movement trial. All 21 were verified online before launch.

Two inherited test characters had 500 maximum HP. Before any tour, all 21 characters received the corresponding current production t1–t21 character's attributes, karma, HP ceiling and mana ceiling, read from cached production scenes. HP was restored to full and vigor to 200. Verified starting HP ceilings range from 45 to 60. Production characters were only read, not moved or modified.

Native shadow inventory, equipment, skills and spells were retained and captured exactly. This is **not an exact clone of today's production loadouts**. Nineteen characters initially had weapons equipped and two did not; none had armor equipped in that initial capture. The imported world has its own monster population, item history and RNG/timer phase. Three sampled occupied rooms contained active monsters; native reads confirmed they were not scene-held and included live targeting/behavior timers. This is useful stress/coverage evidence, but it cannot estimate what fraction of historical production deaths these fixes prevent.

The normalized baseline is a checksummed native save, stamp `1789500206`, captured at 19:23:26 UTC. The initial world, normalized world, roster backups and exact loadouts remain private local evidence. No account data belongs in Git.

Both directions began with the same shelter-book SHA-256 `33d8024ec4afe86d23cdef7618d402066bb914c1ad33478741baab6c947d9e64` and bad-exit SHA-256 `28f69d975bbee936abdc9dc8eb3ce99202e565114616d44b47a8855891f42409`. Prey-side and track-strike overlays were initially absent. Reverse evidence used a fresh `reverse-20260915` scope; it did not inherit the forward run's learned shelter/exit writes.

## Circuit and accounting

`m59-pilgrimage.mjs` cycles through the five mainland inns (Tos 52, Barloque 106, Cor Noth 153, Marion 202, Jasper 370), Upstairs in Castle Victoria 39 and the shadowy corner 110. The reverse option reverses the same ring. Seed 15 scatters all 21 characters over the five inns (five in Tos and four at each other inn), then issues ordinary travel with errands disabled. Only initial placement and health preparation use DM commands. Journeys and recovery thereafter use the keeper's movement/survival mechanisms.

Report completed legs, deaths, unique affected characters and unfinished journeys separately. A survivor still trying to leave one room is not a completed trip. The harness samples Underworld entries; reconcile its count with actual postmortems. Starts are staggered before its timed measurement loop, and expiration of the measurement does not itself cancel the last journeys. Stop/quiesce the tour broker after the window before restoring a world or teleporting for another run.

## Concurrent replay proof

While the forward fleet was moving, historical Janice scene 104 was loaded in the replay container and run for 240 seconds with the same experimental movement code and normal threat costs. The replay container restarted at 19:24:09 UTC. The tour container retained its 19:14:19 UTC start time, broker PID 36372 and all 21 sessions while characters continued changing rooms.

That replay survived to its horizon, ending at 42/49 HP, with no completed onward journey. The runner's `recovered` label must not be interpreted as an arrival. It is an isolation demonstration and another retained movement observation, not a new measured production survival improvement. Private receipt: `substrate/tour-sim/isolation-proof.json`; full trial: `substrate/replay-smoke/travel-zero-2026-09-15/trial-104-route-fixed-natural-10.json`.

The reverse tour likewise continued through the poisoned-wall replays, keeping broker PID 36916 and its own world start at 19:40:19 UTC. The poisoned-scene cold restore-to-start took 6.24 seconds; warm full replay preparations took about 3.90–3.91 seconds, including login and scene verification. The native world-reload portion alone took 0.33–0.35 seconds. These timings were measured while the full tour fleet was running.

## Repeatable commands

The new `m59-lab-command.mjs` wraps the normal broker/service and CLI tools in the same per-fleet mutable-state isolation used by scene replays. It requires an explicit lab fleet and game/maintenance ports, validates every roster endpoint, rejects production/default server ports, and never prints credentials. Use the same fleet and scope for start, tour and stop. A new `--scope` starts a separate persistent evidence/learning directory; reusing a scope retains its learned state. It does not create accounts or reset a server implicitly.

```powershell
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 -- tools/m59-service.mjs start --http 8981 --dashboard 8982 --no-ui
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 -- tools/m59-which.mjs
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 -- tools/m59-pilgrimage.mjs --port 8981 --to 39 --cycle --timeout 900 --seed 15 --out substrate/tour-sim/forward-next.json
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 -- tools/m59-service.mjs stop --http 8981 --dashboard 8982 --no-ui
# After restoring the chosen world/roster baseline, use a new scope consistently:
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 --scope reverse-next -- tools/m59-service.mjs start --http 8981 --dashboard 8982 --no-ui
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 --scope reverse-next -- tools/m59-pilgrimage.mjs --port 8981 --to 39 --cycle --reverse --timeout 900 --seed 15 --out substrate/tour-sim/reverse-next.json
node tools/m59-lab-command.mjs --fleet tour-shadow --game-port 18959 --admin-port 18998 --scope reverse-next -- tools/m59-service.mjs stop --http 8981 --dashboard 8982 --no-ui
```

`--out` creates a new structured result file with per-character legs, observed rooms, lows, deaths, direction, timing and source provenance. It refuses to overwrite a prior result. The output directory must already exist. For a different independent server, provision another labelled Docker container, unique loopback port pair and separate roster, then use those explicit values. Native saves use the existing shared `m59-scene-server-save.mjs capture/verify/restore` path; restoration requires a stopped, scene-labelled lab. Save/terminate the owned world before restoring; never use a bare `docker stop` to discard play.

The separate replay workflow continues to use `m59-replay-lab` / `replay-native` and its explicit replay config. Do not redirect the scene reset tool at the moving tour world. Private setup and result files are excluded under `substrate/tour-sim/`; shared lab state is under `substrate/fleets/.lab-runtime/tour-shadow/`.

## Preserved evidence and finish state

The tour broker was stopped after each measurement, and all 21 keeper children were quiesced. Both Docker game servers were left running for future work. Production was not restarted or modified. Final native checkpoints: forward stamp `1789501217`, reverse stamp `1789502242`; the original normalized baseline and the poisoned critical snapshot remain intact.

Private artifacts under `substrate/tour-sim/`: `forward.log`, `reverse.json` / `reverse.log`, `observations.jsonl`, starting/final rosters, exact initial loadouts, setup receipts, native-status reads and all poison trials. The critical cached scene is `scenes-1789501094653.json`. The forward follow-through after the timed bell and all setup/failed trials are retained separately from the timed result interpretation.

Validation: 33 pilgrimage checks, 17 lab-command guard checks, 58 rest checks, shared lab-environment checks, client keepalive tests and 32 death-replay scenarios passed. The implemented login read also passed the ordinary-code native replay above. The cached-capture benchmark at 201 actors measured p95 0.147 ms (serialization and disk writing excluded and kept off the capture path).
