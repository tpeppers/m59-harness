# Travel and simulator production release, 2026-09-15

The operator explicitly requested merging the available fixes to main and
deploying them, including restarting brokers and keepers. This release combines
the pending travel work with main at `e2da4db` (which includes the production
account-ownership fix at `810bfce`).

The pending source changes are `99abe53`, `b2f7efe`, `c0d2448` and `ea0f025`.
They are integrated as one release commit so their historical research holds
remain intact on the research branch without holding this explicitly authorized
release. The replay-state isolation change at `b88096b` is already on main as
`6f2e86f` and is not applied again. Both sides of the sole merge conflict, the
private-data ignore list, are retained.

## Behavior activated

- Keep the travel destination through recovery, hand failed refuge approaches
  directly to the recovery controller, and clear fulfilled shelter intent.
- Check movement from the actual fine position and retain every intermediate
  waypoint when a coalesced move is refused.
- Request existing player enchantments during login/reconnect, allowing recovery
  to observe poison that survived logout. Capture observed effects in scenes.
- Provide isolated full-fleet test commands and structured tour results, with
  unknown health represented as unknown.
- Include main's recovered inventory intent/equip controls, passive client and
  proxy observations, raid/checkpoint tools, and process start-time ownership
  guards. These features retain their existing activation controls.

## Evidence and limits

The [Docker tour report](shadow-world-tour-docker-2026-09-15.md) records 21 shadow
characters completing 166 checkpoint legs across forward and reverse circuits,
with zero deaths in two 15-minute windows. The circuits covered every checkpoint
edge in both directions; individual characters did not complete whole laps.
Those runs exercised the travel changes before the login-effect fix was added.
They were not a comparison against the old production code or an exact clone of
production equipment and skills.

The ordinary-code poison replay subsequently recognized poison on 76 of 77
samples and made no false rest-interruption decisions, versus zero of 98 samples
and seven interruptions in the original replay. Both survived and reached 1 HP;
this establishes improved observation/recovery, not a demonstrated life saved.

Some focused recovery replays still survived without completing onward travel.
The pre-existing rest logic also does not separate simultaneous poison and attack
damage when an ailment is observed. This release does not establish that those
cases are solved, or that travel deaths are eliminated. Original failed,
divergent and nonfatal trials remain available in the linked reports.

Production remains a detached tag of a commit pushed to GitHub main. The live
shelter book, roster, credentials and local investigation files are preserved.
The remote production game server does not need a restart for this release.

## Release validation

The combined tree passes 43 targeted offline suites, including movement,
survival, replay, account/fleet ownership, FleetScript, combat, inventory and
passive client/proxy observations. FleetScript passes all 319 assertions after
rerunning with Windows process-query access; its first run was denied that
access by the sandbox. A mistyped storage-suite invocation was corrected to
`m59-inventory-storage-test.mjs`, which passes. All 78 changed JavaScript files
pass syntax checks; the generated tool index and diff whitespace checks pass.

The generic deploy checker reports the stale, diverged local `main` checkout and
pre-existing untracked production files. This release instead checks the exact
GitHub `origin/main` commit and tags that commit. The empty `floor` file and
operator-provided `prod-deaths.txt` are preserved, as are the private stockpile
and investigation directories. There are no uncommitted production source edits.
