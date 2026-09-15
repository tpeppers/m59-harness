# Guild-aware PvP simulation — 2026-09-15

The Castle Victoria replay now admits real player attacks. In three trials with
temporary opposing guilds, the Morpheus stand-in killed the victim in every trial
without an attack refusal. All three corresponding idle controls survived the
eight-second window without damage. An unguilded control reproduced the bug:
six attempted attacks, six guild-rule refusals, no damage.

This validates the simulator repair. It does not establish that a survival
strategy works, or that the modeled attacker exactly matches historical Morpheus.

## What changed

Postmortem PvP comparisons create two temporary native guilds by default. The
victim and unselected player bodies join Guild A; selected attackers join Guild B.
The comparison resolves these assignments once and preserves them in the idle
control. The default relationship is neutral, which satisfies the guild-only
room rule without adding the effects of a declared guild war.

Setup uses the server's existing Guild constructor and InductNewMember method.
It verifies the system guild registry, guild rosters, each player's guild pointer,
and any requested relationships. The simulator also records the room's
AllowGuildAttack result and verifies memberships again immediately before release.
Attacks still use ordinary client combat inputs and the server's combat rules.
No room flags, combat rules, or server image were changed for this repair.

Custom fixtures support multiple teams and mutual neutral, allied, or war
relationships. War fixtures fund the native guild rent accounts so war backing
exists. This provides the membership and relationship setup for guild exercises;
the existing postmortem attacker controller still targets the selected victim.
It does not add a multi-target team tactics controller.

Guilds are created only in the owned isolated scene lab, with a native snapshot
reset configured. Existing native membership is refused before changes. Explicit
`preserve` mode retains that membership, or keeps an unguilded baseline for a
control. Generic scene simulations retain their previous preserve default until
`pvp.guilds` is supplied.

## Live results

Source: `Beaker-2026-09-14T21-45-17-639Z.json`, Castle Victoria, with the victim at
12 HP and seven other captured players represented by temporary accounts. Morpheus
was the only selected attacker. Every trial restored the same native baseline,
used the same supplied player models, removed monsters, and used the existing
lab-scenery override. The observation limit was eight seconds except for the
explicit setup-only exercise.

| Fixture | Trials | Attack attempts / refusals | Result |
| --- | ---: | --- | --- |
| Unguilded, attacker active | 1 | 6 / 6 | Survived 8.086 s, zero damage; intended PvP did not occur |
| Opposing neutral guilds, attacker active | 3 | 2 / 0; 2 / 0; 4 / 0 | Three server-confirmed Morpheus kills at 2.919, 2.917, and 5.405 s |
| Same opposing guilds, attacker idle | 3 | 0 / 0 in every trial | Survived 8.091, 8.070, and 8.088 s, zero damage |
| Opposing guilds at mutual war | 1 | 4 / 0 | Server-confirmed Morpheus kill at 5.407 s |
| Three teams: Red/Blue/Green | 1 | No combat window | Native alliance, war, and neutral relationships all verified |

The three-team exercise placed two players in Red, two in Blue, and four in
Green. Red–Blue were allied, Blue–Green were at war, and Red–Green were neutral.
This was a setup test, not an additional survival result.

All nine valid trials verified scene load/release and temporary-account cleanup.
All eight guilded trials also verified guild teardown. Guild setup and native
verification took **58–85 ms**. Complete restoration of this eight-player scene
took **11.30–11.77 seconds**, including its existing temporary-account creation,
login, and loadout work. The guild fix adds little to that cost; the complete
eight-player restore is still above the desired one-to-five-second loop.

The active guilded trials recorded 12 or 13 cumulative HP lost; values above the
initial 12 HP include healing during the window. The evidence is observed HP
loss plus server-confirmed killer attribution, not merely attack packet counts.

## Fidelity and interpretation

Guild assignment is a deliberate model assumption. These older production
captures do not establish the historical guild membership or diplomacy of every
player. Morpheus's supplied loadout is the existing evidence-informed estimate,
not a verified inventory or exact skill record. Lab scenery, absent monsters,
unknown human inputs, and different random outcomes also limit historical claims.

The useful conclusion is narrow and reproducible: guild-only eligibility was
preventing these modeled fights; ordinary attacks now land and can kill after
native guild setup. Eight-second idle survival is censored. These trials cannot
rank survival interventions, establish long-term safety, or imply that guilding
production bots would improve survival. Other room restrictions still apply;
guild membership does not override a no-PvP room or other attack refusals.

## Teardown and retained failures

Cleanup stops the stand-in controllers, disconnects their sessions, verifies the
identity and ownership of each temporary guild, disbands it, checks registry
removal and empty rosters/timers, restores original rejoin cooldowns, and then
deletes the verified temporary accounts. Failed guild cleanup retains account
identities and a private journal for recovery. Native baseline restoration clears
setup mail, news, and dynamic resources before the next trial.

The first development run exposed an incorrect cleanup check: native Guild.Delete
disbands a guild, but its object node may remain allocated until garbage
collection. The simulator initially interpreted that node as a failed deletion.
The check now verifies logical disbanding instead. The original failure and
journal were retained. Recovery verified both exact guild identities were
disbanded, deleted the seven owned temporary accounts, verified their absence,
and restored the native baseline. All subsequent trials completed cleanup.

## Reuse and evidence

The [death replay guide](m59-death-replay.md#guild-only-pvp-and-guild-teams)
documents `--guild-mode opponents|preserve`, `--guilds TEAMS.json`, FleetScript's
`simulatePostMortem({guilds: ...})`, and FleetScratch configuration. Custom
assignments must include every captured player; `null` deliberately leaves one
unguilded. Reports include modeled assignments, native identities, verified
relationships, guild-only room permission, setup time, refusals, and cleanup.

Private raw evidence remains under `substrate/replay-smoke/` in the
`codex/death-replay-2026-09-14` worktree:

- `guild-cv-live-2.json`: first active/idle pair.
- `guild-cv-unguilded.json`: unguilded refusal control.
- `guild-cv-repeats.json`: two further active/idle pairs.
- `guild-cv-war.json`: mutual-war combat.
- `guild-three-team-setup.json`: multi-team relationship verification.
- `guild-validation-summary.json`: extracted results and timings.
- `guild-cleanup-recovery.json`: failed-development-run recovery proof.

The valid trials ran from base commit `d83885c` with this repair present in the
working tree. Reports record the runtime source manifest, native server source
`1fb1f51478d14a2a7fa37a2bb5899899c0115c44`, and image
`sha256:1f6d74022530f07c8a69f8f6944d59adcb8e2275f60f435b91ec2e8d3612bd36`.
The isolated target was `m59-replay-lab`, game/admin ports 17959/17998.

Offline regression checks cover team resolution and identical idle assignments,
native membership/relationships, silent induction refusal, an absent creation
reply, ownership checks, cleanup, and lab restrictions. Existing replay-player,
postmortem, scene-simulator, death-replay, and loadout tests also pass.
