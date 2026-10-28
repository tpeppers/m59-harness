# Cooperative combat strategy hook

Private fleet tactics may answer `cooperativeCombat({phase:'configure',agent})`
with `{decide(context)}`. `decide` is synchronous and cheap; return null for the
existing behavior, or `{target_id,hold,why,started_at?}`. The optional start timestamp propagates
an encounter deadline through participants and finisher changes. No public default strategy opts in.
The ordinary strategy loader caches modules until keeper restart. This hook is
additional to `farmStrategy`; assigning it does not replace quarry, weapon,
confinement or loot orders. A keeper with a fixed `buddy` assignment yields to it.

The context contains `now`, `me`, fresh `members`, visible `monsters`, and the
requested attack id. Each member carries its agent, positively identified visible
body, room, HP fraction, named position, current target, confirmed damaging tag,
and local eligible targets. Candidates must match that character's hunt, engagement
band and advancement level, and have a local melee approach. Movement uses the
existing body/height/collision checked melee executor. The normal health, vigor,
prey and wall gates precede active cooperative attacks. A separate passive rung
preserves a held tag before ordinary work can select another quarry.

Records use atomic replacement, one writer per character, scoped by the canonical
absolute roster path. Other-roster, stale, future, invisible and mismatched-body
records cannot enlist a participant. Records expire in six seconds. These are
observations, never credentials or orders. Room/body/client changes and server
saves invalidate local tags; reports older than the local save are rejected.

Packet gates cover repeated swings, changed targets, ordinary non-self casts and
damaging item applications. A successful damaging combat reply is required;
misses, full resists, range refusals and quoted chat are insufficient. Self buffs
and self healing remain available. PvP, low HP, explicit control, recovery and
defensive fight-back bypass cooperation. A bypass attack retires the old tag.
The controller never delays a flee, rest, logout or recovery action.

Policy owns crowd thresholds, participant selection, waiting deadlines and
finisher election. The harness owns candidate validation, evidence and execution.
A broken policy is reported and cooperation declines for that keeper process.
`autopilot status.cooperative_combat` reports its current tag and decision.

The KOD rules are in
[player.kod](https://github.com/Meridian59/Meridian59/blob/master/kod/object/active/holder/nomoveon/battler/player.kod):
`DidDamage(amount > 0)` sets `PFLAG_DID_DAMAGE`; changing `poKill_target` resets
gain flags; same-room `SomethingKilled` calls `AdvancementCheck`. Above base
max HP the ordinary contribution is 2 with a roll; a killing blow together
with having taken damage contributes 3. The ratio describes gain contribution,
not a guaranteed HP increase. Newbie and other server modifiers also apply.
The candidate gate conservatively uses observed max HP, so altered forms can
exclude an otherwise valid base-HP participant. Remaining in the room and keeping
the victim as the last attack target are necessary for a non-killer roll.

Offline checks: `node tools/m59-cooperative-combat-test.mjs`, existing strategy,
buddy, combat and unattended suites, and `npm run test:movement`. Private tactics
keep their policy and complete group simulations in the private repository.
These tests establish no live advancement-rate improvement; monsters can still
die before every participant lands a hit.
