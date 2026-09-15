# Production recovery and source preservation — September 15, 2026

## Production recovery

The broker was down after the unexpected machine restart. Its guarded ownership
records retained keeper PIDs that Windows had assigned to unrelated processes.
Exact-roster recovery excluded confirmed non-node processes from the fleet guard
set but counted them in the account guard set, refusing startup with
`account-guard-absent-from-fleet`.

Commit `810bfce` applies the same cached classification to both sets. The regression
test fails before the change and passes after it; real node and unknown processes
retain their guards. The account-leases, fleet-lock and lease-guards suites pass.
No ownership locks were deleted and no takeover override was used.

Production resumed on `deploy-2026-09-15-19` at `810bfce`, with all 23 characters
in game. The existing DUM configuration resumed as well. This recovery does not
restart the expired, time-limited room-enchantment order.

## Work recovered into main

| Work | Result |
| --- | --- |
| All production code through `deploy-2026-09-15-18` / `6f2e86f` | Already reachable from GitHub main before recovery. |
| Reboot recovery | `810bfce`, deployed. |
| Four-death investigation | Original `dda5556` integrated as `fe9edc5`; historical probes and source hashes retained. |
| Inventory purpose, withdrawal and authenticated equip integration | `32fe3dd`; three relevant offline suites pass against current main. |
| Native context, human guidance, passive proxy observations and opt-in performance preload | `97bf7e4`; eight relevant suites pass against current main. |
| Shadow survival experiment | Report, scripts, figures and the credential-free 20-trial evidence bundle recovered from the uncommitted research worktree. Offline unpacking and analysis reproduce the published severe and milder trial counts. |
| Stranded `lease-guard-identity` branch at `29c80c8` | Reconciled source from 40 commits: process start-time guard identity, raid preparation/action/checkpoints, verified cast outcomes and concentration holds, room clearing, resistance and mirror simulation, and shutdown save completion. Runtime safe spots and raid state were excluded. |

The source audit checked registered harness worktrees. The latest Codex replay,
combat, reagent-coop, telemetry and refuge-release branches already land on main,
apart from the explicitly held research below. The nine apparent local-main-only
commits were checked by patch/content and subject: their work is already upstream,
including `buyLines` and the four movement-instrument suites. They should not be
merged again solely because their hashes differ.

### Stranded raid and guard branch

The `lease-guard-identity` branch was local-only. Its source was applied to current
main, retaining the newer keeper-address helper, retry-aware FleetScript transport,
packet authority checks and shared server-save-set parser. Superseded regex edits
were omitted. The combined FleetScript tests retain both NPC speech-range and cast
outcome coverage. Existing supply assertions were updated to check the factored
keeper identity rules, and the combat-mode fixture includes the Pacer's new
concentration allow-list.

Validation passed for process identity, fleet locks, account leases, combat safety,
checkpoint postconditions, resistance, mirror simulation, FleetScript (319 checks),
fleet selection, combat integration, buff service, keeper addressing, combat mode
(40 scenarios), supplies (145 checks), and routing (148 checks). All changed JavaScript passes syntax
checks. This is source preservation and offline integration validation; the raid
and shutdown commands were not exercised against the production fleet. Production
continues running the small reboot recovery release at `810bfce`.

## Preserved work requiring separate review

| Remote branch | Preserved revision | Reason it is separate |
| --- | --- | --- |
| [codex/death-replay-2026-09-14](https://github.com/tpeppers/m59-harness/tree/codex/death-replay-2026-09-14) | `c0d2448` | `99abe53` and `c0d2448` explicitly carry release holds: repeated recovery loops and successful onward travel still require native replay validation. The intermediate replay-state change is already main under another hash. |
| [archive/trunk-source-20260915](https://github.com/tpeppers/m59-harness/tree/archive/trunk-source-20260915) | `390cd93` | Source-only snapshot of 42 original trunk files at base `98acd96`. Validated feature sets were integrated individually; remaining instructions and older edits are retained without replacing newer main files. |
| [archive/cnc-travel-b1049-20260915](https://github.com/tpeppers/m59-harness/tree/archive/cnc-travel-b1049-20260915) | `7d241b5` | Exact eight-file CNC leased-travel prototype at base `b486900`. Its controller integration needs reconciliation and validation against current movement code. |

These archives carry release holds so a later deploy cannot silently treat a
historical snapshot as a production candidate. Do not merge either archive wholesale.

## Machine-local material

Credentials, fleet state, learned safe-spot data, stockpile state, captures and
expired character-specific errands remain local. Named one-off `muster/run-*`
scripts, private guild errands, the Loial restock source/notes and `prod-deaths.txt`
were copied into the recovery workspace's source backup. They are not reusable
public fleet configuration. The expired Loial order remains disabled.

The local backup and detailed file inventory are under the recovery task workspace:
`C:/Users/taimp/.codex/visualizations/2026/09/15/01a0a64a-c2e2-70f3-b760-fd4ff020915a/`.
`source-backup/` contains the source copies; `worktree-audit-preserved.json` records
the original path, base revision and comparison results. The report's original
source worktrees remain intact. No reset, clean, stash or force push was used.

## Continuing safely

Use a fresh worktree based on fetched `origin/main` for new implementation work.
The original trunk checkout is still stale and dirty; its raw status is not an
inventory of missing upstream features. Its source has been preserved above, so
reconciling that checkout must not mean copying its old files over current main.
Production remains a detached deployment tag and should receive future releases
only after their commits are on GitHub main.
