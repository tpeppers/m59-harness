# Cooperative logoff execution

The public harness supplies an inert executor. A private strategy in
`substrate/strategies/` must opt in with `kind: 'cooperative'` and the
`cooperativeLogoff(ctx)` hook. It is independent of a character's farming assignment
and of the legacy `strategy: 'coop'` healing/economy preset.

The hook receives `phase` (`request` or `helper`), agent, room, whether the body is
at a safe spot, visible fleetmates, and nearby attackable monsters. It returns null
to retain existing behavior, or `{enabled:true, helper_health, danger_quiet_ms,
cooldown_ms, attempt_ms}`. The executor bounds all numeric settings. There is no
public strategy that enables this behavior by default.

## Handoff

When ordinary recovery would play dead away from a wall, an opted-in keeper can
request a cooperative logoff. Admission requires another opted-in, freshly observed
controlled fleetmate on the same server, roster and room, also visible to the victim.
A room admission lock excludes existing offline waiters and reserves the last helper;
the fleet cannot deliberately put every participating body offline at once.

The victim cancels its old movement and disconnects normally. Its reconnect waits
for observed outgoing hits against each captured nearby monster. A timer, an attack
submission, an incoming hit or a miss is not proof. A scoped native exchange
observer reports affirmative target-bound server messages as they arrive, before
even the attack exchange's internal health read. It accepts no chat and detaches
on both success and failure. The fight's final result does not repeat that receipt.

Helpers inspect pending requests after their own survival rung and before directional
work or farming. Active combat, a recent injury, low health/vigor, an active recovery,
cast, movement, another unfinished stage, an errand or foreign faculty ownership
defers the one-shot task. A helper makes one normal bounded melee attempt at the exact
requested PvE object. It does not attack players, bypass movement geometry, use an
admin action, loot the target or replace its farming policy. Missed attempts remain
pending with a retry interval. Its own survival and packet authority continue to apply.
The existing 100ms falling-health interrupt also fences the distraction stage;
late approach or attack callbacks cannot take the helper back from recovery.

Requests and hit receipts are stored under ignored `substrate/cooperative-logoff/`,
scoped to the exact roster path and game endpoint. The login gate runs inside
`Session.join`, so broker rejoin and keeper restart cannot silently bypass it.
Keep that runtime directory across deployments. When moving to another checkout,
set `M59_COOPERATIVE_LOGOFF_DIR` to the same persistent location for broker and
keepers; absence of a journal is not a migration procedure. Admission locks carry
PID/start metadata and an ownership token; a live or unknown lock is never broken
automatically, and release cannot remove a replacement owner's lock.
The native liveness response identifies a deliberate cooperative wait; only
identity-checked evidence from a live keeper defers the broker sweep. Explicit
`/join` and `/rejoin` requests return a typed refusal before stopping or replacing
the continuation, so a waiting farmer cannot stall recovery of other fleet members.
Receipts are rechecked against fresh, living, same-room helper observations, and
the request is marked resumed only after a successful login. Save/room/body changes
and expired claims invalidate queued commands. A permitted reconnect resumes normal
refuge recovery without adding the ordinary post-login ninety-second freeze.

The waiting keeper stays running with its modules and geometry warm, using the
native pre-login gate rather than a new broker-side movement controller. Before
the distracting swing, the helper prepares the nearest available refuge from the
victim's last confirmed fine position or its identity-matched logoff ghost. The
projection uses the victim's body ID; the helper remains an obstacle. This is a
read-only search, not a reservation or a movement command.

After the hit releases login, the returning keeper immediately attempts cover
inside the reconnect continuation, before another farming pass. A restarted waiter
does the same before starting its autopilot. The normal login observations and
body readiness still apply. The prepared goal is accepted only with a fresh plan,
the same subject, room, resource, save epoch and confirmed fine landing. Native
selection rechecks geometry, live obstacles, failed approaches and exclusive
claims. A changed landing or blocked hint falls back to a fresh nearest-refuge
search in the same escape. No peer's body, old packet stream or predicted position
becomes authority to move the returning character.

The condition proves a distraction hit, not the server's hidden aggro target. With
multiple captured threats, each must have a hit receipt; an unhit threat cannot be
ignored because a different monster was distracted.

## Failure and observation

No timeout forces the victim back into an undistracted room. After thirty seconds,
native `cooperative_logoff` status marks the wait stalled and lists outstanding
targets. If no helper can act, it remains offline; the game's existing logoff-ghost
penalties still apply to prolonged offline periods. Operator stop, dormancy and
handoff cancel the current login attempt rather than defeating its condition.

Helper start/result/defer events and confirmed distraction kills enter normal
keeper telemetry. Read-only cleanup can finish after the victim returns, but a
second attack from the old distraction scope cannot follow it.

Offline checks: `node tools/m59-cooperative-logoff-test.mjs`,
`node tools/m59-combat-approach-test.mjs`, `node tools/m59-rejoin-test.mjs` and the
full movement gate. The private policy has its own test and belongs only in the
private repository. Installing it or restarting live keepers is a separate operation.
