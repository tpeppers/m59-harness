# Cooperative logoff execution

The public harness supplies an inert executor. A private strategy in
`substrate/strategies/` must opt in with `kind: 'cooperative'` and the
`cooperativeLogoff(ctx)` hook. It is independent of a character's farming assignment
and of the legacy `strategy: 'coop'` healing/economy preset.

The hook receives `phase` (`request` or `helper`), agent, room, whether the body is
at a safe spot, visible fleetmates, and nearby attackable monsters. It returns null
to retain existing behavior, or `{enabled:true, helper_health, danger_quiet_ms,
cooldown_ms, attempt_ms, max_offline_ms}`. The executor bounds all numeric settings.
`max_offline_ms` is optional (60 000 to 1 800 000); absent, null or non-positive means no
deadline, which is the original behaviour. There is no public strategy that enables this
behavior by default.

## Handoff

When ordinary recovery would play dead away from a wall, an opted-in keeper can
request a cooperative logoff. Admission requires another opted-in, freshly observed
controlled fleetmate on the same server, roster and room, also visible to the victim.
A room admission lock excludes existing offline waiters and reserves the last helper;
the fleet cannot deliberately put every participating body offline at once.

A keeper that already logged off can request another cooperative rescue after a
later recovery at verified cover restored lost health to full and cleared its
ailments. The next emergency must be off cover and below the flee line. An
admitted request spends the new episode's allowance. Ordinary play-dead and
breakout relogs retain their five-minute guard.

In the opted-in Ocean recovery policy, if no melee threat is in reach, a request
can capture visible rock-throwing mollusks within ten squares with confirmed
geometry and line of sight.

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
multiple captured threats, each must have a receipt; an unresolved threat cannot be
ignored because a different monster was distracted.

## A target that is gone

A target can also be resolved by a `gone` receipt. In a busy farm room the captured
monster is usually killed by another farmer before a helper swings, and a dead monster
cannot take a hit receipt: measured on prod 2026-10-31, about 25 of 30 play-deads in two
hours waited offline indefinitely for that reason.

`gone` is an observation, not a timer. Every opted-in keeper publishes presence from its
500ms watchdog, including while it fights, and the same call runs
`observeCooperativeTargets`. For each `offline` or `returning` request in the helper's own
room (same room number, room object and save epoch), it reads the helper's live object
list. That read counts only if the helper is live and combat-ready, its own body is in the
list, no save is running, and the helper has no pending request of its own. An unreadable
read is never absence and restarts the clock. A target id absent across repeated reads
spanning `GONE_MS` (15s), with no gap over `GONE_GAP_MS` (3s), gets
`{kind:'gone', request_id, target_id, name, helper, helper_body, seen_absent_since,
observations, at}`. The receipt is written under the room lock to `offline` records only,
because `returning` belongs to the requester. It is refreshed every `GONE_REFRESH_MS` (5s)
while the absence lasts and never overwrites a fresh hit receipt. If the id is seen again,
the receipt is deleted.

The gate accepts a gone receipt under the same rules as a hit receipt. It must be under
30 seconds old and no older than the request's `offline_at`, its writer must have fresh,
living presence in the request's room and body, and the writer must not be waiting on a
request of its own. Its absence span must also be at least `GONE_MS`.

## Failure and observation

No timeout forces the victim back into an undistracted room unless the strategy asked
for one. After thirty seconds, native `cooperative_logoff` status marks the wait stalled
and lists each target as hit, gone or neither, with `deadline_at` when one applies. If no
helper can act and no deadline was granted, it remains offline; the game's existing
logoff-ghost penalties still apply to prolonged offline periods. Operator stop, dormancy
and handoff cancel the current login attempt rather than defeating its condition.

The opt-in `max_offline_ms` is stored on the request when it is admitted, so a restarted
keeper or a broker rejoin applies the same bound. Once `now - offline_at` reaches it and
the targets are still unresolved, the gate marks the request `state:'aborted',
reason:'deadline', released:'deadline'` and lets the login proceed.
`cooperativeLogoffReturn.released` is then `'deadline'`. The returning keeper still heads
straight for cover, and its survival decision says the wait ran out, not that a
distraction happened.

## A record nobody is finishing ends by itself

Prod, 2026-11-01: Robin sat in `preparing` for 4.5 hours and Scooter in `offline` for an hour
past a four-minute `max_offline_ms`, both out of the game, and hand-aborting Scooter's file did
not bring him back. The trigger was Windows: `renameSync` over a request file another keeper is
reading at that instant throws EPERM, and about twenty keepers read every request file twice a
second. 142 orphaned `request-*.json.<pid>.<uuid>.tmp` files are the writes that never landed;
Robin's holds the `offline` from `markCooperativeOffline`, Scooter's the deadline `aborted`.
What made a failed write permanent was this code: the throw escaped the rejoin, a `preparing`
record refused every later login (in-process and the keeper's `/join`/`/rejoin`, answered 423
to the broker's sweep every 45 s), and a waiter that died by throwing left
`cooperativeLogoffWaiting` set, so the keeper reported `cooperative_wait: true` and the sweep
stepped over the character for good.

Now:

- Writes retry a busy rename briefly (`replaceFileSync`) and never leave a tmp; an EPERM on the
  room lock's exclusive create is "busy", like EEXIST. A held lock is still never broken.
- `markCooperativeOffline` never throws, and remembers the departure in memory; the login gate
  confirms a `preparing` record this session departed for (`confirmed_offline`).
- A `preparing` record older than `PREPARING_MAX_MS` (60 s; the honest window is under a second)
  is abandoned and the login proceeds (`preparing_timeout`).
- Past `max_offline_ms` the gate releases as before; if the release cannot be written it retries,
  and past `max_offline_ms + OFFLINE_OVERRUN_MS` (30 s) it logs in anyway (`offline_overrun`).
  A store that stays unreadable for `STORE_FAILURE_MAX_MS` (60 s) ends the gate too.
- A waiter that exits by throwing clears its flag, after-login clears it unconditionally, and the
  keeper reports `cooperative_wait` only while a login is in flight (`cooperativeWaitActive`).
- `/join` and `/rejoin` refuse only while a continuation is running. With none, a stuck record is
  abandoned and a pending one inside its bound is re-gated by the join itself (`regated`).
- A failed cooperative reconnect aborts its `preparing` record whether or not the socket survived.

Every one of those writes a `cooperative_logoff_recovered` ledger row (`action`, `reason_code`,
`why`, `by`, the request's times, and whether the record could be written), keyed on the
character. None of them logs anybody in by itself: the gate only runs inside a login somebody
asked for, still refuses when `cooperativeLoginAllowed()` is false (dormancy, handoff, leave, a
stopping keeper), and a human pilot is the broker's to honour, as before. A body released this way
is undistracted, so `cooperativeLogoffReturn.released` names the bound and the keeper heads
straight for cover.

Helper start/result/defer events and confirmed distraction kills enter normal
keeper telemetry. Read-only cleanup can finish after the victim returns, but a
second attack from the old distraction scope cannot follow it.

Offline checks: `node tools/m59-cooperative-logoff-test.mjs`,
`node tools/m59-combat-approach-test.mjs`, `node tools/m59-rejoin-test.mjs` and the
full movement gate. The private policy has its own test and belongs only in the
private repository. Installing it or restarting live keepers is a separate operation.
