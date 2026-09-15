# PvP survival recovery

Rowlf and Gonzo's September 15 Castle Victoria deaths exposed an incorrect
handoff from player combat to ordinary recovery. Their standing kill watches
stopped at the keeper's computed two-thirds HP floor, then waited for health
recovery while Morpheus continued attacking. Ordinary safe-wall healing does
not neutralize hostile players.

Confirmed incoming player attacks now create a `pvp_return_fire` survival
decision and preempt ordinary recovery immediately. Blocks and dodges also
establish incoming hostility. The bot repeatedly attacks at any positive HP,
keeps ownership through reconnects, and only resumes ordinary recovery after
all known attackers leave and the 30-second danger window expires. Explicit
operator stop and death remain termination conditions. Continuous return fire
is the default; this change does not implement an automatic low-HP logout.

The fix also guards raw reconnect against stale recovery work. Old queued rest,
movement and cleanup packets cannot take over. Server combat restrictions and
validated movement still apply; an attack refusal or blocked path retains the
PvP intent and reports the blockage instead of switching to healing.

## Live behavioral verification

A test derived from Rowlf's recorded CV scene used the shared isolated Docker
scene loader, retained Rowlf and Morpheus's recorded positions, and supplied
opposing temporary guilds. It deliberately set the victim to 30/51 HP with a
67% floor, removed monsters/other players, retained lab scenery, used the lab
victim's approximate axe loadout and a modeled unarmed attacker. This verifies
behavior under the reported trigger, not historical survival probability.

During an 18-second trial, the victim returned **14 attacks: 5 server-confirmed
hits and 9 defenses**. It received 8 hits and avoided/dodged 6 attacks, finished
at **8/51 HP**, and remained in PvP return fire throughout. No guild-rule attack
refusals occurred. The temporary attacker and guild setup were cleaned up.

Raw report: development worktree `substrate/replay-smoke/pvp-survival-smoke.json`, SHA-256
`4a1f97c1b99b672559d8e58a81180c7ed7ffddc23c8a4e6d27ed148157e91b7d`.
Its execution manifest records the modified source used for the experiment.
Surviving the observation window does not establish that the new strategy
prevents the historical death or wins a fight against Morpheus's actual loadout.

A second, 45-second trial deliberately disconnected the victim for 20 seconds
after PvP began, then reconnected the same character. Login completed 21.75
seconds after disconnect. The same survival decision and its counters survived;
the bot resumed return fire rather than healing. Across the trial it returned
**19 attacks: 13 confirmed hits and 6 defenses**, finishing at 8/51 HP with the
mode still active. Cleanup was verified. This was a test-induced disconnect,
not an automatic strategy activated by the new policy.

Reconnect report: `substrate/replay-smoke/pvp-survival-reconnect-smoke.json`, SHA-256
`0ca680b98f2771dc8318169c1eeba630dd07c88596c6fbb03ee300f161e7391b`.

## Regression coverage

The combat suite covers 51 scenarios, including 1 HP, blocked/dodged incoming
attacks, multiple attackers, the full absence timer, continued presence beyond
30 seconds, reconnect identity/counter retention, death, explicit stop, failed
approach, server refusal, queued old recovery, and shadow name/time rebinding.
Integration exercises the real keeper recovery entry points and raw
`Session.rejoin` boundary. Existing survival-decision, death-replay, session
readiness, player-evidence and temporary replay-account tests also pass.
The packet-scope fixture had a stale source-extraction boundary that omitted
the pacer's existing `CONCENTRATION_SAFE` constant. Updating that fixture lets
its real queued-packet revocation and scope-isolation checks execute again.

Postmortems and scene controllers now include `pvp_survival`. Attempted packets
are separate from confirmed hits/defenses, and counters survive reconnects.
The shared replay adapter restores captured hostility against the correct
temporary player names; scripted attacker behavior remains controlled by the
experiment rather than being replaced by the victim's retaliation policy.
