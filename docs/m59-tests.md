# The offline test suites, and what each one pins

`m59-joints-test.mjs` (143) pins the joints (docs/m59-joints.md). FIRST: with no pak, every joint answers
default, every call site is guarded by `handles`, and a firewall step through the real Session is refused
exactly as before. Then the closed answer sets, the condition language, strikes, follow-ups and decision
records. Then the RPG vocabulary from the kod: a curse is never a debuff, three wands have no timer,
"laughs off" is resisted over 60%, a firewall costs one hit per square. Then the doors between 38 and 39
derived from the map, the service board, the posture save and read-back, and an operation's expectations.

`m59-hearing-test.mjs` (10) pins what a death records about whether the keeper was looking and could hear (prod
2026-10-26: nine deaths "stalled" with a flat health trail). A desynced frame header is counted, not only logged,
while the socket still reads as alive. The postmortem's `hearing` block carries the age of the last frame, the last
received bytes, the last parsed message, framing drops, STAT parse errors, and when the watchdog last ran and why it
last stepped aside.

`m59-posture-test.mjs` (18) pins a posture's live half against a fake broker. A hazardous order (survival off, no
flee line) is refused unless accepted by name, and nothing is pushed or saved. `tend` finds a handoff's reset by key
and re-pushes it, says out loud when the re-push is refused, and pushes nothing in a dry run. A lease releases itself
through `tend` and puts the character back.

`m59-tripwire-test.mjs` (39) pins tripwires (docs/m59-joints.md "Tripwires"). Nothing is armed without a fleet
file, and a file that does not parse arms nothing. A stale or missing `who` resets the quiet clock. A tripwire
never releases a posture it did not put on, and two on one posture release on the last. Unknown triggers are
refused at load. A dry watch reads only `fleet` and `who`, and never asks a piloted or host character.

`m59-farm-danger-test.mjs` exercises the real bounded farm stage, survival token
handoff, late queued-command refusal, preserved completed kill receipts and a
changed-generation pull that returns through real Session movement to its wall.
`m59-spotclaims-identity-test.mjs` checks batched PID-reuse proof, absent owners,
unknown identities, concurrent record replacement and retained traversal receipts.
Both are registered in the movement runner. `m59-active-self-heal-test.mjs` also
covers a patient becoming whole while the healer's actual paced cast waits.

`m59-courier-purchases-test.mjs` checks capacity-clamped maximum orders,
separate cash and pack arrival, one-attempt durable receipts, uncertain
purchases and acquisition-cost loss overhead. `m59-spotclaims-lock-test.mjs`
injects Windows acquisition sharing errors into the actual file store and
checks bounded retries, live-owner protection and persistent denial. These
are offline contracts; populated delivery measurements remain separate.

`m59-curse-cycle-test.mjs` (52) pins the curse cycle (docs/m59-economy.md). With no
strategy answering, no unidentified ring is ever picked up. The gate needs remove curse, +20 karma,
9 mana and an emerald over the reserve. Only one ring is taken per sweep and no amulet ever.
A worn amulet does not shut the gate, and is put back on after the cast.
A worn cursed ring is uncursed before it is dropped, never dropped while worn.

`m59-castrite-test.mjs` (31) pins the trance door and cast rites against the
real Pacer, Session and M59Client methods. With no casting strategy, a wrapped
cast sends exactly what it sent before. A caller's own cast hold is unchanged.
Every cast with a trance is now held: a second cast waits, reads pass, and the
hold ends on the broken, refused, hit or no-start evidence. No move sent during
a trance is a run. A rite dresses before the cast, never during the trance, and
restores exactly what it changed. Idle gear takes a robe off outside an inn, and
`wearBest` will not put a forbidden robe back on. See docs/m59-cast-rites.md.
`m59-spellgear-test.mjs` (17) pins the costume-change framework. A role tag alone
changes nothing. A strategy's `wear` target becomes the fewest legal packets, with
a bow freed explicitly, and an illegal target is refused. The stash is popped by
the same transition after the linger. The keeper's equipBest and wearBest stand
down while a rite is open, and a failed cast still pops. Rite packets jump the
queue ahead of movement. `prefer_weapons` ranks first after the magic-first rule,
and without it ranking is unchanged. The mage policy's own tests are in
m59-private beside it.

`m59-recovery-pacer-test.mjs` runs the actual five-packet scheduler, Session
stand and refuge-return code behind thirty queued reads. It checks that active
recovery reaches stand and movement without bypassing normal pacing, while
ordinary returns retain their scheduling. Cancellation, stale combat epochs,
explicit combat ownership, session isolation and concentration remain guarded.
This is an offline scheduling regression, not a native survival measurement.

## Recovered raid and process identity checks

- `node tools/runtime/process-identity-test.mjs`: process start-time and image
  matching, including recycled PIDs and unavailable identity evidence.
- `node tools/runtime/fleet-lock-test.mjs` and
  `node tools/runtime/account-leases-test.mjs`: guarded ownership, exact-roster
  adoption and consistent exclusion of positively identified recycled PIDs.
- `node tools/m59-wand-duty-test.mjs` (48): the wand bank at Castle Victoria's gate. Who drops off
  (leaving the region, never a trip that stays, never the bank) and who picks up (a Castle Victoria
  farmer short of 2, one attempt per visit, never to an empty bank, but a person at the bank overrides
  a published zero); the request wording parses back; and the real Autopilot stage machines move every
  wand on a drop-off, take 1 when only 1 is there and carry on, and give a silent person up after the wait.
- `node tools/m59-swarm-follow-test.mjs` (11): the swarm. The 30 MAXIMUM-health line (29 out, 30 in,
  unread out); hosts, noncombatants, human-held characters and the leader never join; the leader's
  room comes from the freshest keeper that sees him; every follower in a room computes the same slot
  from the same view; the wedge trails behind his walking direction, never on his square; the door
  he took is inferred from his last square, and nowhere near a door means no guess.
- `node tools/m59-jobs-test.mjs` (26): the broker's job board. Register, heartbeat, orphan by a
  dead owner, by a recycled pid (start time) and by a stale heartbeat; pause touches the stop file
  and kills every pid but leaves a finish-on-alert job running; an owner ending a paused job keeps
  the pause; resume spawns the restart and cancels a job with none; persistence round-trip, bounded
  history; the handover export/import never shares objects, a warm successor never writes the file;
  the client registers, ends once, and is a no-op with no broker.
- `node tools/runtime/broker-handover-test.mjs` (30): the live broker handover. The job board
  crosses it: late state is sent just before the commit and never on an abort, a job registered
  mid-window survives, a dead owner found at verify reads orphaned, and the predecessor's board is
  untouched. A lock
  TRANSFER keeps every keeper guard (a running keeper verifies against its new broker without
  being touched), only the current owner can make one, and it rolls back with the successor's
  token alone — successor alive, wedged or dead; a successor that dies after the transfer is
  recovered by ordinary guarded adoption; account leases move transactionally and are
  re-derived from the roster on import; the predecessor never freezes before the successor is
  warm, never commits before it serves, and every abort ends unfrozen, owning, with its held
  requests run locally; the successor touches nothing before it owns the fleet, and binds the
  ports itself if the predecessor vanishes after the transfer.
- `node tools/m59-checkpoint-test.mjs`: postconditions, unknown observations,
  bounded establishment and checkpoint invalidation.
- `node tools/m59-resistance-test.mjs` and `node tools/m59-mirror-test.mjs`:
  resistance estimates and saved-scene combat simulation.
- `node tools/m59-fleetscript-test.mjs`: includes verified cast outcomes and
  retry-aware transport alongside the existing FleetScript coverage.

These tests are offline. They do not execute a raid or shut down a server.

Island movement regressions run in `m59-movement-suite.mjs`: fine refuge
approaches and actual-distance bounds (`m59-fine-safeleg-test`), policy
transport including per-room distances (`m59-safeleg-policy-test`), bounded
keeper rest dispatch (`m59-rest-dispatch-test`), and declared takeoff refinement
with stock gravity at four frame intervals (`m59-jump-takeoff-test`). The
pocket suite also checks fall settlement and cancellation before a delayed
departure packet. Populated fleet trials remain separate live evidence.

`m59-traversal-admission-test` exercises shared room entry reservations, a
parallel returner's wait in the inn, confirmed exits, cancellation, and a real
crashed driver whose character must still be observed outside before release.
`m59-konima-crossing-test` also covers the explicitly enabled ordinary gutter
after bounded refused flights, including cancellation and unproved-escape guards.

`m59-fine-safeleg-test` also covers Konima's closed/open gate, the full-room
refuge worker, event-loop responsiveness, cancellation, and Merb's refuge
beyond the local window. Run it with `node --max-old-space-size=640` to exercise
the live keeper's heap configuration. `m59-doorplan-test` pins the nine Konima
buttons using the actual capitalized derived predicates. The posture and route
arrival suites cover checked recovery approaches and parent journey ownership
through a nested shelter order.

## Object ids across server saves

- `node tools/m59-idgen-test.mjs` (64): every system save renumbers every object id
  (`docs/m59-protocol-traps.md`, "an id is good until the next save"). Pins the pure half of
  `m59-idgen.mjs`: a generation retired at BP_WAIT and closed at BP_UNWAIT, and which
  generation a read at a given time belongs to (during a save still counts as before it;
  older than everything kept is `unknown`, never guessed); `checkIds` translating a pre-save
  pack id to the same stack by NAME, refusing a recycled id that now names something else when
  nothing says which was meant, refusing two carriers of one name and two entries landing on
  one stack; `SaveClock` collapsing one save reported by twenty keepers into one (earliest
  start, earliest end as the boundary) and the cadence (median interval, next expected, a
  prediction long past rolled forward); `stampReply` stamping `ids_as_of`/`ids_stale` and
  `id_stale` per entry; and the input side — `judgeArgs` finds ids handed out before the save at
  any depth under the tool's own id keys (never `amount`, never a travel `to`, which is a room),
  `reresolveRefs` keeps an unchanged id, swaps a renumbered one, refuses an ambiguous one, and
  `rewriteArgs` does not mutate the caller's arguments.
- `node tools/m59-savewire-test.mjs` (27) now also pins the client half: BP_WAIT retires the pack
  with names and amounts, BP_UNWAIT re-requests the pack and the room at once, `idsAsOf()` shows
  the pack read older than the save until the reply lands, and a socketless client survives.
- `node tools/m59-supply-test.mjs` (154) — a save landing between the call and the offer, with the
  old number recycled as a sapphire, offers the elderberry stack's NEW id; an id older than every
  remembered save is refused as `stale object id` with `stale_ids`, nothing offered.
- `node tools/m59-fleetscript-test.mjs` (374) — the `supply` step retries a stale-id refusal once
  after a fresh read, sends the new id, sends every id with its name, and stops after two.
- `node tools/m59-keeperproxy-test.mjs` — `ids_as_of`, `id_generations` and `saves` are checked on
  all three sides of the three-file rule (client keeps, keeper publishes, proxy rebuild carries),
  plus the clock feeds and the stamp at `callTool`.

## Travel and combat regressions

- `m59-track-midroom-test.mjs` (6): **a journey that starts inside a room still rides its track.**
  A resumed or re-issued walk has no entry door, so `rideTrack` asked for `room:?>to` and planned
  bare; `tracksLeavingBy` offers every unstruck track out by the same door and the nearest is ridden,
  with its strikes and clears on its own key. Kardde's Canyon (49) to 45, prod 2026-10-19: 40-67
  minutes per character in the fence pocket. Fails with `no track` on the old walker.
- `m59-body-held-square-test.mjs` (5): **a body standing on the next square's stand point does
  not close the square.** Real 599 geometry with the 2026-10-18 positions: Rowlf in the r19c35 wall
  pocket, whose only mover step out is r20c34, and the Guardian of Zjiria five units from r20c34's
  stand point. The point detour is refused, the square detour (`goalSquare`) lands inside r20c34
  clear of the body, `Session.enterBodyHeldSquare` walks it and says `via: 'body_held_square'`, a
  cancelled walk sends nothing, and a square behind the pocket's walls stays `object_blocked`.
  walkTo's `aroundBlockedWaypoint` calls it when the fine walk to the stand point is object_blocked.

- `m59-move-origin-test.mjs` (18): **who ordered a move and who cancelled it**, and the movement
  incident log (`docs/m59-boundary.md`, provenance; `docs/m59-routing.md`, the incident log). A
  cancel by another issuer records BOTH sides on `Session.cancelMovement` — the canceller's origin
  and the order it pre-empted — and `status.movement.last_preempted` says `walk to 714 ordered by
  fleetscript:buy-spell#r1 cancelled by keeper:shelter (…) at HH:MM:SSZ`; a script clearing its
  own walk is `self_cancel`, not a preemption; a cancel with no origin is `unattributed`, never the
  keeper; the job report carries `ordered_by`/`cancelled_by` and a busy refusal names whose walk
  holds the body. Through `Autopilot.travel` on a stand-in keeper: the `travel_journey` row carries
  `origin`/`ordered_by` and `cancelled_by_origin`, a cancel from BEFORE the journey is not blamed
  for it, and a journey with no origin is `keeper:unattributed`. The failed journey writes exactly
  one incident with start square and fine point, the stage square it failed to reach, route, trail,
  threats and canceller; a retry loop dedupes into one incident with a count; `--export` is a
  redacted fixture with a `replay` block. And a SOURCE SWEEP over the keeper and broker that fails,
  by file and line, on any `.travel(` or `cancelMovement(` call naming no origin.
  `m59-fleetscript-test.mjs` carries the step half: a walk whose journey the keeper pre-empts fails
  with the canceller FIRST and the time, every move the run sends carries its own
  `fleetscript:<name>#<run>` origin, and a keeper posture that will fight the walk is warned about
  once.

- `m59-hunt-priority-test.mjs` (42): `hunt_priority`, an order over the `hunt` set. A spider is
  chosen over a nearer tree; with no engageable spider the tree is; the ordering never adds a
  creature, keeps the wounded/pulled foe first, matches like `hunt` (spider is not black
  spider), and in the farm pass sits after the confinement, avoid, cooling and rank filters and
  before the claim and every engage gate; a malformed order is refused; a name outside `hunt` is
  reported. Also the policy surfaces for BOTH new keys (`huntPriority`, `lootOnly`): default
  object, JSON round trip through the keeper's push merge, broker schema, setter and reflection.
- `m59-lootfate-test.mjs` (30): what a kill dropped and what became of it. `killDropItems`
  takes only what arrived during the fight, matches a name-only refusal (the cursed ring) to one
  item and not every item of that name, and says "not attempted" rather than inventing a reason;
  `lootFate` counts an id two kill rows claim once, follows it across hands (a sword handed to the
  armourer and sold by him is SOLD), calls a stack merged rather than tracing it, and splits
  unidentified rings by icon class under one name. With no `kill_drop` rows it lists pickups and
  gives no share.
- `m59-loot-filter-test.mjs` (33): `loot_only`, a per-creature loot allow list, through the
  real `Session.lootFloor` against a fake client. After a spider kill only the purple mushroom
  is taken (whole names: "mushroom" is left); after a tree kill the wand and berries are, and the
  spider junk left earlier is not; attribution by novelty against fight()'s floor snapshot;
  memory expiry, recycled ids and room scoping; malformed shapes and unknown items refused.
- `m59-buddy-test.mjs` (66): the buddy system (`m59-buddy.mjs`, `Autopilot.passBuddy`) and the private
  farming-strategy directories. Pairs are exclusive and validated; the tag is an UNTOUCHED monster (no
  player within two squares) of the quarry; a landed blow is a tag and a miss or a full resist is not;
  the shared per-character record reads stale as absent. The tagger takes a corner, tags only with its
  killer beside the wall, vetoes every other attack while a tag is out and the tag itself once landed,
  swings again only at an unlanded tag that followed it in (up to `tries`, default 12), and gives up past `wait_s`. At FULL health a tagger is exempt from the pull's crowd guard; hurt, or not a tagger, it is not. The killer walks
  to the wall, kills only a landed tag, clears anything else at the wall, and farms as usual when its
  tagger is elsewhere. A local strategy file of the same name overrides a private one.
- `m59-strategy-engine-test.mjs` (116): farming strategy files (`farm_strategy`,
  `docs/m59-strategies.md`). The three committed examples load and mean today's orders; a file that
  will not parse, names a survival/war key at any depth, carries a bad value, a non-function hook,
  a name that is not its file, or nothing, is refused with its reason and NOTHING is applied; keys
  apply while the keeper owns their faculty and are not written at all while a bot or lease holds
  it (six passes, zero writes) and return when the lease ends; `protect` is additive; every write is
  credited in `policy_sources` and unassigning gives each key back; hot reload on mtime, a broken
  edit keeps the previous good version; a throwing, rejecting or overrunning hook is disabled and
  the keeper carries on, hooks skip while `work` is held, `ctx.set` refuses survival keys; the key
  is in the default policy, round-trips through the push merge, is carried by NAME only, and the
  broker validates and persists the orders without the overlay. **The leak of 2026-10-03** (Floyd's
  `spareCreatures ["spider"]` and `confineRooms [27]` outliving an unassignment) is driven end to end
  with a real Autopilot and the keeper's `/policy` merge rule: a push that echoes the effective
  policy back is recognised (`pushEcho`) and kept OUT of the keeper's order copy, a restatement of
  the shadowed order lands in the copy and not over the overlay, `policy_orders` and
  `ordersFromStatus` (also for an older keeper's status, via `shadowing`) give the broker the orders
  rather than the overlay, a rejoin then shadows the orders and an unassignment gives back every key;
  a copy contaminated BEFORE the fix is cleared by `strategyResidue` (to `policyDefaults()`, never
  `hunt`, never an argument in the same call, never the additive `protect`). And `spare_creatures`:
  normalised like the strategy's `spare` ([] and null clear, a non-list is refused), named in the
  default object, round-tripped through the push into the session's attack veto, declared and set by
  the broker, reflected by `policy_control`. **It should fail the day a broker seeds an order from
  the effective policy again.**
- `m59-spare-blocker-test.mjs` (14): a SPARED creature in the way (`spare_blockers`,
  `lureSparedBlocker`, `grantProvoke`). Silence is the old behaviour; `lure` backs off to the planned
  refuge and never swings; `provoke` swings once at exactly that id with the spare veto lifted only
  during it, and not at all while something already hits us; nothing is done with a fightable body in
  reach, below the flee line, unwedged, or past six lures per room per ten minutes; `passFightBack`,
  `clearPathCheck` and the trade never pick a spared body; the strategy field is `movement` and refuses
  a bad value. **It should fail the day a Qor caster's jam in the sewers is answered by killing a rat.**
- `m59-item-signature-test.mjs` (8): an unidentified wand or scroll named by its ICON RESOURCE ID
  (`m59-item-signature.mjs`). blakcomp gives every class its own `_icon_rsc` id even when eleven wands
  share `wand6.bgf`, and the server sends that id, so it names the class exactly where colour cannot
  (grey is four wands). A file with two classes on one icon string is left out; nothing is renamed
  without `substrate/item-identification.json`; an identified name is never touched; broker
  `inventory` rows carry `identified_as` and fleetscripts get `itemName`. Against this machine's real
  resources: prod's 2026-10-11 bare wands (30513, LightningWand) and scrolls (30461, MartyrScroll).
- `m59-training-weapon-only-test.mjs` (7): `training_weapon_only` / a strategy's `weapons.trainingWeaponOnly`.
  While the armed style names a weapon, `equipBest` (every call site, through `s.equipOnly`) chooses only
  that weapon: Janice's axe at 39 beats her hammer at 70; with none in the pack it refuses and sends nothing
  rather than reaching for the hammer; off by default; a throwing hook restricts nothing. A ban was the
  wrong tool (banned weapons are shed first and three of them switch create weapon off). The lupogg
  strategy sets it and nulls the leftover touch spell. **It should fail the day a lupogg hunter is
  re-armed with a hammer.**
- `m59-approach-test.mjs` (8): the station's APPROACH (`approach_rooms` / a strategy's `confine.approach`,
  `Autopilot.approachLegs`). A journey to the station or a confined room that starts outside the
  confinement walks the declared road first, resuming from whichever room of it the body is in; nothing
  once inside; the legs (and only the legs) are exempt from the confinement gate; the lupogg road 544 ->
  552 -> 562 -> 108 is checked against the map's own edges. **It should fail the day a Qor caster enters
  the sewers by Barloque's door.**
- `m59-pull-crowd-test.mjs` (8): PULLING THROUGH A CROWD (`pull_through_crowd` / a strategy's
  `pull.throughCrowd`, `Autopilot.closestPullable`). With the flag the crowd refusal on a pull is skipped and
  the quarry is the qualifying creature (hunted, not spared, inside the band, reachable) the fewest WALKING
  steps from the wall; without it the refusal stands; the flee-line refusal still runs. Written for 112 at
  its cap with ~20 lupoggs, where every pull was refused.
- `m59-farm-buff-test.mjs` (7): the `farmBuff` SEAM (`Autopilot.farmBuffContext` / `farmBuffAsk` /
  `farmBuffPass` / `castSelfSpell`, the strategy hook, `Session.rejoin`'s offline wait). The tactic that
  answers it is private (substrate/strategies/); pinned here are the question (vitals, enchantments, held,
  unspared reach, the safe spot and the ETA back to it, pack, spells, the last two minutes heard), the
  closed answers (cast at our own id, go to the spot, refuse the pull before walking out, log off 1-60 s),
  that silence and nonsense do nothing, and the call sites.
- `m59-walk-handoff-test.mjs` (3): SMOOTH HANDOFFS between a fleetscript's walks. A cancelled job is
  superseded by a new job from the same issuer (`Session.startJob`) and still refuses anyone else; the
  mid-journey sanctuary rest is skipped on the last hop and cancellable on every other. Written for Zheng He,
  refused twice on 2026-10-12 by his own run's previous walk. The strategy-engine suite gained the matching
  residue cases (unassign plus an explicit value in one push; unassign while a script holds movement; a
  shadow that is the file's own value).
- `m59-prefer-mundane-test.mjs` (5): PREFER MUNDANE (`prefer_mundane_weapon`, `c._preferMundane`). The troll crew keeps a
  dedicated weapon for trolls and an undedicated twin for everything else; with the flag the mundane twin wins inside the
  family (never across it), prefer-magic is unchanged, and the keeper swaps a magic weapon in hand for its mundane twin.
- `m59-icky-chalice-test.mjs` (43): `substrate/fleetscripts.example/icky-chalice.mjs`, the Icky Cave
  chalice errand. The kod facts it acts on are read back out of the kod (dispel illusion's 1 dragonfly
  eye / 1 uncut seraphym / 2 solagh and 20 mana, no target; cave2's one chalice at r23c11, the 30 s
  illusion timer, the orc check in `OkayToGetChalice`, orc/spider 50/50; the chalice's refusal
  sentence and vault refusal; the 7-square Manhattan get; a vault withdrawal being the same `@Buy`
  as a purchase) and SKIP without `M59_ROOT`. Where the reagents come from — pack, hall chests, vault,
  chests then vault, or a refusal naming the missing readings — and whether the cave is HELD (an
  empty or foreign reading never is; `orc` is a whole word). Both roles compile, the run-time walks
  declare candidates and pass `trapCheck`, they resolve to 714 / 114 / nowhere per source, and the
  tidy-up steps are `always`.
- `m59-touchspell-test.mjs` (76): touch spell training (`touch_spell`, `touch_spell_timing`). The kod's own start,
  stop, already and kill lines and the "Your acid touch …" / "Your punch …" combat log; on the
  assigned farm room a wielded weapon is unused, the touch is cast at the caster's numeric
  object id, a punch or the stop line triggers a rate-limited recast counted only on proof
  (start line, mana or reagent spent), short mana or reagents are reported rather than retried,
  and `equipBest`, `armSelf`, `makeWeapon` and `fightNow` do not re-arm; off the room the
  ordinary arming rules stand; the policy key exists in the default object, survives the
  keeper's push merge, and is declared, validated and reflected by the broker. Cast timing:
  `on_target` casts when a NEW quarry is chosen (once per target id), refreshes a buff with under
  20s of the 60s minimum left, settles on an *already* answer, still honours the rate limit;
  `before_swing` casts only at the swing; the farm pass calls it right after claiming the quarry.
- `m59-pvp-return-test.mjs` (49): the PvP return delay (`pvp_return_delay_ms`, default 30 min).
  Recognising a PvP death from the two live shapes of 2026-09-30 (a guild-combat kill the
  attribution could only guess, and a player standing in the room) and refusing every monster
  shape (an article, an unresolved `<dynamic …>` id, a monster's name in the frames, a
  fleetmate); a PvP death refuses keeper journeys to farming rooms for 30 minutes and then
  releases them; a monster death and a delay of 0 hold nothing; the hold survives a restart;
  an explicit order, a movement lease, a busy holder and a recovery detour are never held;
  and the schema, setter, fleet row, policy_control reflection and local policy carry the key.
- `m59-ally-test.mjs` (40): who a buff or a heal may go to (`tools/m59-ally.mjs`). A fleet-mate
  is an ally, a stranger is not, a named friend is; a guildmate or a server-FRIEND alone is not;
  the server war flag, the war book (even refused lately), a grudge-book row of any age and a
  PvP-death killer record each refuse the buff even when the name is also a fleet-mate, a friend,
  a guildmate and FRIEND; a fleet-mate source that throws fails closed. Then the real books,
  written by their own writers in a scratch directory, and `buffAllies` / `medic` in the
  2026-10-03 room: Morpheus and Kermit -> Kermit is buffed; Morpheus alone -> nothing is cast and
  the refusal names him; naming Morpheus a friend by mistake still buffs nothing. Run against the
  pre-fix autopilot it fails 9 (every cast went to Morpheus).
- `m59-who-test.mjs` (38): the `who` tool on both paths (`tools/m59-who.mjs`). A live client
  refreshes and returns `players`, `here` (monsters excluded, self marked), `refreshed`,
  `last_refreshed_ms`; the ONLY call it makes is `players()`, through the pacer as a read, and no
  say/tell/send of any kind; the keeper path (JSON across the process boundary) returns the same
  reply as the in-process path; a keeper error, `unknown action` or an empty reply throws rather
  than reading as "nobody online"; a list that does not come back says `refreshed:false` with the
  age of the last full one; `name` answers online / in_room / partial matches; and the wiring --
  the broker tool no longer calls `c.players()`, `KeeperProxy.who` forwards to `/action who`, the
  keeper's case runs `readWho` and speaks to nobody.
- `m59-sightings-test.mjs` (15): non-fleet logins and logoffs, written exactly once
  (`tools/m59-sightings.mjs`). 24 simulated keepers -- 0-5s jittered delivery in per-socket
  order, +-3s clock skew, three late joiners, a fast relog (logoff and logon 400ms apart) and a
  handoff with both processes alive for 20s -- give exactly the server's sequence of logon/logoff
  rows per name (three seeds), no `absent`, `present` only for who was online when the watch
  began, and one alert line per enemy event; 8 child processes racing for the real lock give one
  row per event and no lock left behind; a keeper 5s behind a 400ms relog absorbs all three copies
  (with "closest row" matching it wrote two duplicates); a keeper that logged in just AHEAD of a lagging peer holds a logoff the ledger cannot yet place until the peer writes the logon (found by the 15s soak: one duplicate in forty seeds), and alone records it after 30s marked `inconsistent`; one event heard either side of UTC
  midnight is one row; fleet-mates and hosts are excluded; the war-book/grudge class and the alert
  text; a logoff with only an id is named through the open session; a busy lock defers and a
  dead writer's stale lock is broken; a list read seconds ahead of a lagging peer writes nothing
  the peer's wire row explains; and the reader -- pairing, open sessions, unknown start, an end
  across a watch gap reported as `between` rather than invented, reader-side collapse, last seen,
  `watching:false` on a stale heartbeat, and the CLI. `SIGHT_SEEDS=150 SIGHT_DELAY=15000` is the
  soak.
- `m59-chestroom-exit-test.mjs` (5): leaving the Bookmaker's hall from the chest side (section 4)
  against a mover that refuses what `moverStepLands` refuses. The shipped ceiling-door table is
  the step-mask version the runtime applies (a stale one is refused wholesale and no ceiling door
  in 26 rooms ever opens for the mover); with the secret door open r7c7 -> r7c8 lands; r7c7 is
  still section 4; from r11c4 the doors are worked 3, 53, 55, 59; and a crossing that stops in
  the doorway throws `guild door 3 could not be crossed` rather than reporting success and
  failing at door 53's trigger (Camilla, prod 2026-10-01).
- `m59-wrynkeep-exit-test.mjs` (42): leaving The Wryn's Keep (704) from r42c28 and r39c24,
  whose entrance is three ceiling sectors raised one second apart by a counter
  (`#sector=piPos2`). The kod scan reads the counter as sectors 1+2+3, not its initial value 0;
  the shipped door table and ceiling table carry the run (one ceiling door, 32 states); the
  opener presses from r43c24/25, waits for the THIRD sector's event (2s after the press, past the
  old 1.5s window) and its 4.25s animation, and the body then walks to the south edge; two of
  three sectors up is still shut (Janice, prod 2026-10-01). And the REAL `travel`, lifted from
  m59-game.mjs, works the entrance BEFORE walking at the exit and arrives in 350 — on 7769305 it
  ground `walkTo` at r50c26/r50c27 and never pressed, exactly as prod did. Under the LIVE
  conditions — guildh4's twelve entry hotplates in the room and the walker's real avoid set,
  every door shut — from r39c26, r42c28 and the master's wing (r42c33, MASTERDOOR then the
  entrance) the journey still arrives; on 1b5629a the press square itself was refused.
- `m59-qor-temple-test.mjs` (13 tests): walking into the Temple of Qor (802). The gate
  declaration matches the kod (heights, sector, triggers, the 600 s alternation) when `M59_ROOT`
  is set; 598 is in the ceiling table and the observed lift is applied; open, the corridor is four
  straight steps from its mouth r34c26, shut it is sealed and still planned via the r39c25 sliver;
  a walk straight at r38c26 from r35c21 never arrives and through the mouth it does; the 598 exit
  names its mouth and gate; a code exit is a transit only from a door whose directed flood
  reaches the trigger (589 from both doors and 598 from the south are refused, the Icky Cave is
  not); 579 and 589 route to 802 via 597 > 598; the gate wait opens on the server's event plus
  the lift's travel, is bounded by one cycle, and stops on a cancel or a room change; the
  session walks to the mouth and waits only when the lift is SHUT (Camilla, prod 2026-10-01).
- `m59-leverpuzzle-test.mjs` (108): room 2600's lever puzzle on the way to 2601. The
  declaration matches the kod and the committed ceiling-door bake; the claim book gives the
  nearest free lever, the other to a second arrival and none to a third, expires an
  unrefreshed claim, settles a race by reading back, and refuses to overwrite a corrupt
  file; two keepers deciding apart adopt one beat and pull inside SLAM_TIME; door heights
  are trusted only from inside 2600 and never latched; players are never foes; a lone
  keeper waits at its lever with the status "waiting for a second lever puller"; two fake
  keepers pull on one beat, open the door and walk in; travel hands off in 2600 only.
- `m59-door-wait-test.mjs` and `m59-dooropen-test.mjs`: matched sector/height
  evidence, resolved timeouts, slow animations, cancellation and early closure.
  `m59-travel-test.mjs` also verifies that a confirmed opening permits another
  attempt at an exit exhausted while the door was shut, including relaxed routes.
- `m59-conjure-cleanup-test.mjs`: single-weapon roulette clears only summons
  confirmed by an item-matched description, verifies removal, preserves ordinary
  loot and protected equipment, and stops on unknown observations or cancellation.
- `m59-deskpractice-test.mjs` (120): practising spells at the service desk. The mana reserve is `reserve_casts` (2) x one cast of the dearest service the desk both OFFERS and the caster KNOWS, priced from the kod catalogue (60 on a desk with reveal, 24 without); the desk's reagents are kept back on top of the Rescue emeralds; a cast landing exactly on the reserve is allowed and one under is not; a cast that spends no mana sets the spell aside; and the keeper never practises away from its post, under an errand, or with a desk job in flight — and `passErrand` serves the desk first. Also: a spell named with the game's apostrophes (`kara'hol's curse`) finds its SID-named catalogue entry, the catalogue reads lower-case `cons` reagents (acid touch, vampiric drain), and `keep` holds a reagent floor no drill may spend.
- `m59-substrate-archive-test.mjs` (56): archiving cannot break a live import, and reviving an old posture restores it (incident 2026-10-21, docs/m59-operations.md "Archiving prod clutter"). The parser's edges: `?v=` queries, multi-line, side-effect, `export ... from`, dynamic `import()` of a literal and of `new URL(literal, import.meta.url)`, a bare `new URL('x.mjs', ...)`; commented imports and `${}` templates are not edges. `move` is refused (and moves nothing) while a live file imports one of the set, naming the importer, including a dynamic-only importer and one in an extra strategy directory from `pvp-strategy-dirs.json`; a pvp assignment or a `farm_strategy` value naming a file refuses too; `--with-importers` moves the closure and leaves `check` clean; `--to` outside `scratch/archive-*` refuses. `check` finds a broken import, its archived copies newest first, one with no copy, and an assignment naming an archived strategy. `restore` resolves a bare module name, is transitive through the restored module's own imports (resolved at its original path), takes the newest archive, logs `RESTORED.txt`, never overwrites and never takes from outside `scratch/archive-*`. `importWithAutoRestore` restores every missing import in one pass, not only the first the error named. The three loaders: `loadFleetScripts` imports after an auto-restore and retry (and keeps the error plus the `check` hint when nothing is archived); `PvpStrategyHost.refresh` loads bastion after its guard is restored, reports `last_restore`, and with nothing archived reports `stale`, `loaded_strategy` and `CONFIGURED "x" BUT RUNNING "y"`, logs it loudly and labels decisions with the module that answered; `m59-strategies.mjs` `load` restores chalice-farming's import and logs a load that still fails.
- `m59-practice-plan-test.mjs` (15): the practice planner behind `practice-plan`. A school named with the wire's curly apostrophe (`Shal’ille`) is `shal'ille`; the gate is the best three at the highest known level, drilled weakest first, a planned school before an unplanned one and the gate closest to opening (planner `remaining_required`) before a far one, an already-open gate last; a stuck best-three member is benched past only when nothing drillable is left in the three; the never-drill set (hard never dropped even when listed, soft kept only when listed); enchant weapon knowers keep a 17 floor; relay's `min_vigor` above the 80 rest cap, vigor short now and food reagent are blockers; reagent per-cast/on-hand/kept/wanted/shortfall arithmetic across `orctooth`/`orc tooth`/`herbs`; `reserve_leaves_no_room`; Qor karma ceilings; listed entries keep their fields and the config passes `normalizePractice`; courier requests are never lowered and an unshoppable reagent is a wishlist; the fleetscript is dry by default, waives only `keeperLease`, and reads REPL booleans (`request=false`) as booleans; `agents=all` and the agent list are resolved BEFORE the runner (piloted, excluded and not-in-roster characters never locked or marked busy), and an unreadable fleet list refuses the run. `m59-fleetlib-test.mjs` pins the runner half: `runNamed` hands `fleetScript` only what a script's `resolveAgents` returned.
- `m59-desk-chat-test.mjs` (40): the human service desk, broker half: `services?`, requests, `hold on` / `not now` / `done`, the fleetmates-only gate, and `m59-desk-report.mjs` counting a timeout as blocked and a decline as not. The keeper half is in `m59-chalice-test.mjs` and `m59-chalice-flow-test.mjs` (a person at the holder's controls, simulated).
- `m59-chalice-ride-test.mjs` (65): the chalice ride ON DEMAND (`chalice_ride`, `rideChalice`), outside a town trip, against a fake world with a real holder keeper and a real store. A courier lands in 714 served by the holder through the ordinary ride ticket, stands before the sip and sips once, takes no holder cargo, and hands back the faculties it took; each refusal (no holder, far station, PvP cooldown, busy cup with `queue:false`, desk away, hurt, already riding) comes back with its code before anything walks; health falling before the cup is in hand gives the ride to survival and withdraws the ticket; a sip the server refuses for the PvP lockout is a refusal at once rather than a 45 s landing wait; a drink stage re-entered after a thrown pass never sips twice and puts the cup down; the FleetScript step passes only when the world puts the rider in 714; and a town trip's ride is decided and landed as before.
- `m59-desk-travel-test.mjs` (12): the shared chalice desk as a way to get somewhere (`m59-desk-travel.mjs`), on the real map with every crossing at the 20 s fallback. From Ukgoth, North Barloque rides the desk (walk 1, sip at station 2, land in the guild hall 714, walk 1) while Tos walks, because the hall is further from Tos than Ukgoth is. A confinement without the station and landing, a blocked landing, a queue at the desk, a near tie under the margin, a station past the approach limit, and the unit's own Rescue landing in the hall directly all walk or take the other way; a guildless rider is priced from its hometown landing; and with no `desk: true` policy the keeper glue returns silence without asking the desk anything.
- `m59-roulette-test.mjs` (24): the training-weapon roulette at the wall — off for
  normal/unarmed styles, a skill at 70 or unread, low mana and unconjurable weapons; a miss
  drops only its own summon and never real long swords; a hit wields our unidentified
  summon while a foreign unidentified hammer is never wielded. Also the chest draw that
  takes a whole shilling stack and puts back everything the errand did not ask for.

Travel survival regressions:

- `m59-failed-hop-test.mjs`: 13 cases against the real fallback walker. Refused
  two-, three- and five-square moves restore the first swallowed waypoint;
  repeated refusals still leave every waypoint walkable. Both geometry and
  body refusals, legacy collinear retries, hop accounting and cancellation
  are covered.
- `m59-travel-continuity-test.mjs`: 29 cases. Fallback traces and route proofs start at
  the actual fine position; separate proved legs cannot license a corner cut.
  Recovery replaces intent immediately, retains the destination, and fulfills
  shelter requests only at a confirmed wall. Ordinary steps cannot manufacture
  a shelter stop or pay the progress guard without advancing. Blocked or displaced
  body/damage-clamped pivots trigger confirmation and replanning after one step;
  the original walk retains its destination and movement owner through a detour.
- `m59-refuge-posture-test.mjs`: eight shared refuge-entry cases, including a
  seated start, fine positioning, coarse fallback and queued cancellation.
- `m59-position-confirmation-test.mjs`: five cases covering unsolicited room
  snapshots, older outstanding replies, timeout recovery, failed sends and
  sent-posture telemetry.
- `m59-survival-decision-test.mjs`: 23 cases, including immediate replacement
  after blockage, refused logoff and lost cover, explicit ownership handoff,
  and repeated failed alternatives without an unbounded busy loop.

The related recovery-refuge, survival-handoff, survival-trace, track-shelter,
collision and death-replay suites exercise the shared paths independently.

`m59-sector-bindings-test.mjs` checks server animation tags against BSP indices,
including Qor tag 1 versus collision sector 114. It checks byte-matched binding,
unchanged geometry identity, multiple sectors per tag, legacy unknown metadata,
round trips, corrupted bindings, actual-door refusal and unrelated movement.
The death-replay suite also verifies detached copies of cached animation evidence.

Combat overrides: `node tools/m59-combat-mode-test.mjs` exercises preemption,
arrival-triggered ambushes, exact player identity, sequences, expiry and survival.
It also covers indefinite visibility waits, reacquisition, live map selection,
stop/dispatch races, temporary PvP safety and a 1500 ms first-attack budget under
normal server pacing. All player identities and combat packets are fixtures.
Standing farm-watch regressions cover unchanged farming jobs/body authority,
automatic return to farming, recovery and rearming, later arrivals in multiple
maps, pause/hold exclusion, scoped stop, durable restart and roster/endpoint
isolation. The integration suite drives the real TickLoop through farming,
combat takeover and return to farming.
`node tools/m59-ground-effects-test.mjs` covers hazard identity, uncertain fog,
spore extent, safe egress, segment crossings and projection lifecycle.
`node tools/m59-combat-integration-test.mjs` covers the real Session sender,
FleetScript fast path and FleetScratch input concurrency using offline fixtures.

Split out of [`CLAUDE.md`](../CLAUDE.md). All of these are safe to run any time; they open no socket and touch no roster.

## Saved-scene simulator

`node tools/runtime/lab-environment-test.mjs` preserves ordinary lab learning
while checking fresh replay directories, repeated scope/PID names, initial seed
hashes, retained books and missing inputs. `node tools/m59-replay-environment-test.mjs`
exercises the replay adapter's actual environment setup: repeated calls in the
same process must allocate different directories, retain earlier evidence and
restore the requested baseline. It also checks that report manifests are detached
snapshots and that explicit process reuse, including capture/reset before a run,
is reported. These tests do not connect to a fleet or game server.

Travel shelter count regressions are in
`node tools/m59-survival-handoff-test.mjs` (route, hop boundary and wedge
recovery at 0, 1, 5, 6 and 14 monsters) and
`node tools/m59-recovery-refuge-test.mjs` (actual geometry, occupied refuges
and blocked approaches). Monster proximity alone must not veto travel shelter.
The same suite pins the internal-door escape: a body in Castle Victoria's east
chamber (room 38, r7c32) whose four walls are taken crosses the door at r8c32
and takes a wall in the hall; a body on the door square, a failed crossing and a
combat (non-recovery) search all leave it on its own side.

Refuge arrival regressions in `node tools/m59-refuge-posture-test.mjs` and
`node tools/m59-recovery-refuge-test.mjs` cover zero-step predicted positions,
successful confirmation before safe logoff, corrections requiring a return walk,
unanswered/older replies and cancellation across movement, room or client changes.
`node tools/m59-route-refuge-arrival-test.mjs` exercises the real route policy:
predicted arrivals must confirm before safe logoff, failed arrivals replace
survival intent and retain the destination, and newer owners remain in control.

`node tools/m59-scene-guilds-test.mjs` checks explicit/opposing team plans,
identical idle-control assignments, native roster and membership verification,
neutral/allied/mutual-war relations, silent induction refusal, lost creation
replies, existing-guild and lab gates, cooldown restoration and disband cleanup
while native object nodes remain allocated. The postmortem suite checks that
both paired cases receive the same guild configuration.

`node tools/m59-scene-vital-timers-test.mjs` checks normal player health/mana
timer restoration after raw scene-stat loading, preservation of existing timers,
full/dead states, missing bindings/vitals, and silent or explicit server refusal.
It uses an offline native-admin fixture and awards no artificial regeneration.

`node tools/m59-player-evidence-test.mjs` exercises passive player-message/HP
matching, ambiguous and rapidly collected loot, room boundaries, server-scoped
worker persistence and conservative loadout models. `m59-postmortem-sim-test.mjs`
also checks guild-only attack-refusal reporting.

`node tools/m59-scene-loadout-test.mjs` uses an offline native-admin fixture to
check portable inventory/equipment/ability capture, exact restoration/readback,
enchantment timer staging, strict mappings, checksums and refusal cleanup.
`node tools/m59-postmortem-sim-test.mjs` also checks that paired attack/idle cases
retain identical loadouts and combat sequences, including cast outcomes.

`node tools/m59-scene-simulator-test.mjs` covers the fast native-reset cache,
container/endpoint identity, installed save hashes, completion acknowledgements,
response-driven lab ability reads and the shared FleetScript/FleetScratch trial
loop. Native commands and adapters are fakes. The 13 scenarios include stale and
empty replies, pristine per-case input and failure reporting; the existing
`m59-death-replay-test.mjs` covers recording similarity separately from useful
failure recurrence, including divergent deaths, nonfatal/invalid trial retention,
actual-baseline intervention selection and partial reports after later errors.

`node tools/m59-replay-journey-test.mjs` reproduces the missing shelter callbacks
after raw journey restoration, then verifies the real shelter trigger, explicit
guard disables, recorded deadline/retries, keeper travel dispatch and ownership
after interruption. It performs no game requests.

`node tools/m59-replay-provenance-test.mjs` verifies that new replay decisions
name the executing code, restored historical decisions keep their original
epoch, and both carry separate execution/source labels. It also covers dirty
source manifests and unknown execution identity without a game connection.

## The one that never fails, and why it is not a contradiction

```bash
node tools/m59-todo-test.mjs            # the known blockers; exits 0, always
node tools/m59-todo-test.mjs --strict   # the same list as failures, for the day they come due
node tools/m59-repro.mjs --list         # and the command that reproduces each one
```

**A known blocker has nowhere to live in a green suite.** Written as an ordinary test it goes
red, and a suite with a permanent red in it stops being read — so the honest failures around
it lose their audience. Left out entirely it becomes a sentence in a commit message that was
true on the day and is now neither true nor false. That is exactly how the claim that room
108's gully "cannot get out again" survived: right when it was written, wrong within the
hour, and quoted for days after.

So `m59-todo-test.mjs` prints each blocker with what it stops, what was measured, **when**,
under **which movement epoch**, and the command that runs it again — and exits zero. It is
safe in front of every other suite and will never be the reason somebody skips them.

What it *does* assert is each case's **premise**, offline: not whether the blocker still
blocks, which needs a fleet and minutes, but whether the thing the case is *about* is still
there. `crowded-pipe` is about a corridor one square wide; if that corridor is ever three
wide the case is not fixed, it is meaningless. A changed premise prints `PREMISE CHANGED` and
is still not a failure — it is a summons to re-measure. (It earned its keep immediately: the
first version asserted rows 35–42 and was wrong, because 35 and 43 are four-wide junctions
and only 36–42 are single-file.)

The registry lives in `m59-repro.mjs` and is imported by the test, so the list you read and
the thing that reproduces it cannot drift apart. `m59-repro.mjs` is **not** an offline test —
every case joins characters and relocates bodies, and it refuses a non-loopback host.

## Coordinate compatibility

```bash
node tools/m59-coordinate-contract-test.mjs
```

This is the asymmetric contract test from issue #44 (18 assertions). It pins
movement-wire Y-then-X encoding and decoding plus the normalized named
`{x,y,col,row}` result, confirms room 563 is 34 rows by 76 columns, and proves
that geometry's `walkable(row,col)` sees valid `r34c65` and floorless `r30c61`
as two different squares. It also pins the existing route-pivot `[row,col]`,
edge-stage `[col,row]`, and safe-spot `"col,row"` encodings. It reads the
checked-in map; it does not regenerate or rewrite an artifact. The human
notation and all stable exceptions are documented in
[`m59-coordinates.md`](m59-coordinates.md).

For a coordinate-context change, also run the existing routing, geometry,
collision, and fixture contracts. They protect the positional APIs, parser
normalization, movement behavior, serialized route tuples, and command grammars
that documentation must not redefine:

```bash
node tools/m59-routing-test.mjs
node tools/m59-roo-bounded-test.mjs
node tools/m59-collision-test.mjs
node tools/m59-recordjam-test.mjs
node tools/m59-rts-broker-read-test.mjs
```

A coordinate-labeling change must not rewrite map geometry, route or fall-jump
records, fixtures, history, recordings, commissions, or fleet state. Human-only
underscore metadata such as `_coordinates` may be corrected without changing
the records it describes.

- Offline tests, safe to run any time: `node tools/m59-safespot-test.mjs` (241 — pins, among
  the rest, that **"not required" is a third safe-wall setting and not the absence of the
  second**: with `require_safe_wall:false` the wall stops being the posture before every
  fight and becomes the answer to a crowd, taken at `wall_at_attackers` creatures inside
  melee reach and released when nothing is left in reach. Before it, clearing the flag
  changed only the room-denial branch and left every character walking to a corner anyway,
  because the decision underneath still asked "does this kill pay" — which on a grinding
  fleet is yes for every creature in every assigned room. And that **the safe walls are the
  red squares in the debug client**: `safeWalls()` is
  one function for the picture and the keeper's choice, `safeSpots()` iterates it with no
  membership gate, and the overlay has no second set that could drift from it),
  `node tools/m59-render-test.mjs` (81 — **what a renderer gets from a keeper-backed
  broker**, which for a while was nothing at all. Out-of-process keepers are the default and
  the broker holds a snapshot rather than a World, so `look` and `/rts/v1/read` answered a map
  with the keeper's `/state`: vitals, pack, skills, spells, and NO POSITION AND NO ROOM
  CONTENTS. Measured on prod with twenty-one characters in game, `/rts/v1/read` returned
  `looks: { t1: {}, ... }` for the whole fleet at status 200 — the strategy game drew an empty
  room for a fleet standing in it and reported no error. This pins the reshape from the
  keeper's `/room-view` into `World.perception()`'s shape: that a facing of 90 degrees is
  SOUTH, that the room's size comes from the `.roo` and not from the 50x48 the keeper sends
  for every room, that affordances come from the flag word through `affordances()` so a
  renderer can tell a merchant from a mummy from a bar stool, that an older keeper sending
  only two booleans gets exactly what those two booleans support and not one bit more, and —
  the rule with teeth — that an unavailable room view publishes NO `room` key rather than a
  null one, because this projection is folded OVER a state that does know the room and a null
  would overwrite a true answer with a false one. It also pins `keeperView`, the composition
  `look` actually returns — every field `arrivalReport` reads, exercised the way it reads
  them, because an ASYNC `view()` made `v.objects` a promise property and killed twenty-one
  of twenty-one travels with `Cannot read properties of undefined`; and the rule that a
  position from a room the character has LEFT is withheld and the disagreement reported,
  rather than handed to an arrival report as fact) and
  `node tools/m59-chat-test.mjs` (128) and
  `node tools/m59-rest-test.mjs` (38) and
  `node tools/m59-ledger-test.mjs` (25),
  `node tools/m59-ledger-space-test.mjs` (9 — **the one that asks what a ledger field
  MEANS**, which nothing else here does. A room identifier has two spaces: the server's
  room OBJECT id and the map NUMBER. On 2026-09-08 the `looted` emitter shipped writing
  the object id into a field every consumer reads as a map number — the Valley of Ileria
  is object 1386 and room 544 — and 404 offline assertions stayed green through it,
  because not one of them asserts a field's meaning. Five human-shaped checks passed it
  too. So this lints the source rather than the behaviour: a DURABLE record may never
  write `room:` from a `.id`, transient sites must each carry a written reason, and the
  bake has to agree that 544 is a room and 1386 is not. It strips comments before
  scanning and balances parens to the call's real end — both learned when its first
  version quoted its own documentation back and then missed the very bug it was written
  for**) and
  `node tools/m59-leftpack-test.mjs` (53 — **the counterpart to `looted`, and it exists
  because that counterpart did not**. `BP_INVENTORY_REMOVE` is the server saying "this is
  no longer in your pack" whatever took it — sold, dropped, given, vaulted, eaten, spent,
  lost on death — and the client filtered the object out of its inventory and emitted
  nothing, while `BP_INVENTORY_ADD` beside it emitted `got`. Arrivals were recorded and
  departures were not, so when roughly two dozen magic items went missing across
  2026-09-07/08 — the whole identification queue among them — there was no row of any kind
  to read. Not a wrong row. None. Three assertions carry the weight: that the object is
  read BEFORE the filter (move it one line down and every field but `id` is null for ever,
  silently — and an object id is precisely what cannot be looked up afterwards); that only
  an ALLOWLIST of requests may set the `after` breadcrumb, because movement outnumbers item
  verbs by orders of magnitude and a breadcrumb they could overwrite would read `move`
  fleet-wide and erase the `after: null` rows that are the entire point; and that
  `translation` travels as the PACKED wire byte rather than being half-decoded here and
  again in the wand identification. The first two are mutation-checked: the shipped version
  passes 53/53, reading after the filter fails 7, letting any packet set the breadcrumb
  fails 15**) and
  `node tools/m59-localpolicy-test.mjs` (71 — **the contract test for the overlay that
  separates this checkout's opinions from this repository's**: that an absent, empty or
  unparseable local file all mean the committed behaviour rather than an empty policy,
  that an unusable value keeps the committed one instead of unsetting it, that an
  unrecognised key is reported rather than dropped, and that no local file can move a
  mechanic or throw hard enough to stop a supervisor round) and
  `node tools/m59-gate-test.mjs` (29 — playing a character from another machine: the
  password that reaches the game server is the roster's and the placeholder never does, a
  character not granted is refused before the server sees a byte, an unknown or revoked key
  gets nothing, a changed gate key is refused, and the claim sits on a live local pid for
  exactly the session) and
  `node tools/m59-handoff-test.mjs` (112 — **the contract test for lending a character
  without lending the password**: that the token is never on disk so a leaked grant file is
  an audit record rather than a key, that expiry is decided on USE and revocation on the
  next request, that `read` cannot order and an agent allowlist actually excludes, that a
  grant is FULL CONTROL by default and `--safe` is opt-in, and that a restricted tool whose
  destructive verbs are chosen by an argument is refused when the argument is omitted. It
  caught a real intermittent auth bug: ids were base64url, whose alphabet contains the
  token separator) and
  `node tools/m59-playdead-test.mjs` (23 — **the turn that makes a safe spot worth having**:
  playing dead buys safety by not acting, and the same flag that keeps the monsters off keeps
  HealthTimer off with it, so a freeze recovers vigor and NEVER health. Out in the open that is
  the whole trade. On a safe spot it is not: nothing can reach the square, so a TURN sets
  PFLAG_MOVED_SINCE_ENTRY and gives up no ground, and being unreachable AND healing is
  available there and nowhere else. So this pins that the reconnect actually TURNS — a
  reconnect is a fresh entry and the flag comes back clear — that it does not round-trip
  room-contents to verify a packet carrying no coordinates, that a second freeze from an armed
  spot is REFUSED because it would clear the flag the first one was reclaimed to set, and that
  coming back somewhere else gives up the hold rather than turning for nothing. The failure it
  guards is invisible from outside: the wall holds, nothing reaches us, and the health sits at
  four for ever) and
  `node tools/m59-follow-test.mjs` (26 — **leading the fleet by walking in front of it, and
  the one line that must not move**: say "follow me" while piloting one of your own and every
  fleet member in the room walks the squares you stood on. ONLY OUR OWN PEOPLE MAY GIVE THAT
  ORDER — `prod` is a shared server and this moves twenty bodies at once, so the speaker is
  checked against the ROSTER rather than against the text, a stranger who knows one of our
  names is still ignored, and a character will not take the order from itself. The rest is
  trail discipline: the queue is consumed from the OLDEST end, because walking AT a leader is
  a beeline and a beeline is exactly what fails in the rooms this exists for; passing near a
  crumb counts as reaching it, since insisting on the exact square is how a follower stalls on
  geometry the leader crossed at a different angle; and the last order in a batch wins, so
  "follow me" then "stop" means stop) and
  `node tools/m59-commute-test.mjs` (31 — **one rule, and every bug this driver had was a
  violation of it**: do not send a command to a character that is busy. `travel` supersedes
  whatever movement is in flight and the ledger calls that `movement cancelled by a newer
  command`; measured across three windows the commute driver was the LARGEST single cause of
  travel failure in the fleet — 54 of 183, then 18 of 34, then 33 of 56 — and what it
  cancelled were a character resting at a safe wall, one resting to full before setting out,
  and one still finishing the journey that had just delivered it. None of those three reads
  as "travelling", which is why `committed` is the authority and the activity string only a
  second opinion. Moving the busy check back after the arrival branch fails three of these) and
  `node tools/m59-blink-test.mjs` (18 — **a portal every room has, and the one way it must
  not be used**: that a kod file naming two rooms is REFUSED rather than guessed at, because a
  blink point on the wrong room would claim exits a character cannot reach; and that blink
  reachability never answers the walking question. `anchorReach` is what `transitOk` refuses
  a hop over and it still says no where walking says no; `anchorReachVia` returns the WORD
  'blink' instead, because casting costs mana, may need a rest to afford, and can fail — a
  caller handed a boolean would plan a route needing a spell and report it as a walk. Also
  that a room with no blink point recorded loses nothing, since most of the map has none) and
  `node tools/m59-track-shelter-test.mjs` — real `rideTrack` with the real keeper
  shelter policy: geometry and exclusions, canonical station arrival, full health
  and restable vigor, damage abort, cancellation ownership, walked fallback, and
  exactly one count per actual rest. Offline; all mutable evidence goes to a temporary directory.

  `node tools/m59-tracks-test.mjs` (28 — **the monorail, which nothing tested until it was
  already wrong**: that RIDABILITY OUTRANKS TIME, in both arrival orders, because a crossing
  whose legs the mover refuses is not a quick one — it is `walkFine` groping between
  waypoints, which is the behaviour a track exists to replace — and that among equally
  ridable crossings the quicker still wins; that an unridable track is still KEPT when there
  is nothing better, and records how many of its legs cannot be sent, because a book with a
  hole beats no book; that a caller with no map gets a track marked unstraightened rather
  than one marked broken, since an unmeasurable leg is not a refused one; and that a
  struck-out track is refused while one strike short is still ridden. Ranking on time alone
  is defensible, was the rule for as long as the file existed, and left 578 The Cragged
  Mountains 31% ridable — nothing noticed, because a track that cannot be sent still looks
  exactly like a track) and
  `node tools/m59-dropall-test.mjs` (23 — **the one irreversible verb on the surface**: that
  an unknown equipment set REFUSES the whole operation rather than proceeding carefully,
  because `using` being null means the question was not answered and not that nothing is
  worn, and a drop planned against that puts a character's own armour in the road; that
  money is a FLOOR rather than a keep-list entry, so the caller that forgets it is covered;
  that a named reagent is kept while an unnamed one goes, which is why the list names
  `inky` and not `mushroom`; and that the result is judged by what LEFT the pack, since a
  drop is fire-and-forget and a refusal is prose or silence) and
  `node tools/m59-innerdoor-test.mjs` (38 — **a door that leads back into the room it is
  in**: that Castle Victoria is one room with a wall down it, that its trapdoor to the
  Underbasement is in a different region from every entrance so `anchorReach` honestly
  reports no walk, and that the only join is four `go` exits pointing back at room 38
  (castle1.kod:88-98). It pins the plan — one door, `r9c32`, from the body — and the two
  refusals that matter: no plan when the room declares no such door, and no plan when the
  target snaps more than three squares onto the floor, because `nearestWalkable` searches
  until it finds SOMETHING and an unbounded snap turns an unreachable square into a
  different one and then succeeds at going there. It also pins that `transitOk` now answers
  `null` rather than `false` for these rooms — `false` removes the room from the route
  graph, which is why `travel(41)` reported no route to a basement people walk to — while a
  room with no internal door keeps the hard refusal the bake earned. Eleven rooms declare
  one, and that census is part of the test: it is a class, not Castle Victoria) and
  `node tools/m59-travel-test.mjs` (71 — **one call is the whole journey**: that a refused
  doorway and an off-grid instant are re-settled and retried rather than returned, that a
  stumble is not a hop so re-settling cannot eat the room budget, that patience is bounded
  and the reason survives to the caller, that a journey whose last hop is also its last
  permitted hop reports arrival rather than "gave up", that exhausted candidate sets block
  only their exact directed hop and cannot be re-walked by the permissive route fallback,
  and that a cancelled movement still wins. Three cases cover the internal door: that it is
  opened when a hop's exit cannot be walked to, that opening one is NOT a hop — the body
  moved inside one room, so counting it would over-report every journey through such a room
  and spend the stumble budget on progress — and that a door which will not open falls
  through to the ordinary path rather than ending the journey. It lifts the real method out of
  `m59-broker.mjs` by brace-matching rather than
  reimplementing it, because that file cannot be imported without taking the fleet lock) and
  `node tools/m59-travelguard-test.mjs` (32 — **one character has one body**: that a second
  travel call is REFUSED while the first is in flight, and that both arms of the tool claim
  the same slot. `background: true` took a job slot and the foreground arm did not, so two
  travel calls on one character both ran — measured on arena as two journey ids walking one
  character to one destination at identical timestamps, each replanning against the other's
  steps. It is reached by the ordinary path: a travel runs for minutes, longer than a default
  HTTP client timeout, so a caller that gives up and retries starts a second one. Half the
  suite is STRUCTURAL — that the walk is spelled exactly once — because the mechanism was
  never broken and `startJob`'s own assertions pass on the buggy code; set
  `M59_BROKER_SRC` at a copy with the old path and exactly those two go red) and
  `node tools/m59-escapable-test.mjs` (4 — **from anywhere you can get to, you can get out**.
  This was FIRST WRITTEN AS A STEP-SYMMETRY TEST and was wrong: a step you can take is not a
  step you can take back, because you drop down a cliff in the Cragged Mountains and cannot
  climb it again, and `moverStepLands` models that deliberately. It reported 8% of that room
  as a defect; the 8% was the mountains. The true property is weaker — a cliff bottom is fine,
  you walk away along the bottom — so it floods FORWARD from every boundary square for what a
  body can arrive at, BACKWARD for what can still reach one, and the difference is the traps.
  Measured 2026-08-23: **1 in the Twisted Wood, 10 in the Cragged Mountains, 0 in the other
  two** — eleven squares, not thousands. A ratchet rather than a standard, so a mover change
  that starts manufacturing traps is visible and a fix shows as a number falling. Skips
  cleanly with no .roo files) and
  `node tools/m59-sincefull-test.mjs` (24 — **what the body did since it was last
  whole, and whether the moving went anywhere**. Health falling is in every reading here;
  none of them could say what the character was DOING about it, and on a journey under
  attack the job is exactly two things — keep going forward, or get to a wall. Both are
  movement, and movement is all a stillness detector can see. So the number is PATH against
  NET: ten squares walked ending ten away scores 1.0, and the 22<->23 oscillation walks the
  SAME TEN SQUARES and scores 0. One assertion exists only to say that out loud — the two
  are indistinguishable by distance walked and separated only by the ratio. Also pins that a
  room change is not counted as fifty squares of sprinting when the coordinate system starts
  again, that reaching shelter reports the seconds it took rather than a zero, that a second
  wall does not restart that clock, and that the window is measured between OBSERVATIONS
  rather than against the wall clock — which was a real bug in the first draft and would
  have reported every bleed slowing down at the moment the keeper stopped being able to see
  one) and
  `node tools/m59-travelling-test.mjs` (64 — **a journey steers a character; it does not
  switch off its will to live**. Every assertion is one line of Cccc's death record of
  2026-08-21: a commute driver saw him "stuck in room 1" — which is the UNDERWORLD — and
  re-sent a `travel`; `travelJob` called `goInert`, which switches the survival ladder off
  for the length of the walk; the keeper walked him out of the Underworld into an inn at 11
  of 37 and the journey walked him straight back out; six things ate him over twenty-two
  seconds at 27% health against a 70% flee threshold. The old rescue could not fire because
  it ALSO demanded four seconds of stillness, and his last pulses read `r3c23` / `r5c25` /
  `r5c26` / `r5c25` — a two-square shuffle that reset that timer on every sample. So this
  pins two
  things: that a journey takes `goTravelling` and an errand still takes `goInert`, and that
  none of the four mid-hop triggers asks whether the body is moving. The `flee` pair needs a
  character below the flee line and NOT inside two hits of death — 41 of 60, in the
  one-point gap between 40 and 42 — because Cccc at 10 of 37 was below both and is taken
  back whichever switch you throw, which is right for him and proves nothing about the
  switch. Half of it is STRUCTURAL for the same reason `m59-travelguard-test` is: the gate
  in `passUnderworld` is what routes a travelling keeper into the restricted ladder, and if
  it comes out every behavioural assertion above it still passes) and
  `node tools/m59-escape-test.mjs` (70) and
  `node tools/m59-combat-test.mjs` (383) and
  `node tools/m59-playbook-test.mjs` (37 — the three moments, the closed verb set, and
  the two rules that fail in the dangerous direction if inverted: silence means carry on,
  and an unknown condition never holds) and
  `node tools/m59-commitment-test.mjs` (71 — what counts as being spoken for, and the
  distinction between a bot OWNING a character and being mid-operation on it) and
  `node tools/m59-epoch-test.mjs` (20 — **the standard that decides which evidence is still
  about the code in play**, and the mechanism's whole job is to throw measurements away, so
  every way it can be wrong is expensive in one direction or the other. THE THREE ANSWERS
  ARE THE POINT: `sameEpoch` returns true, false, and `null` for "this checkout cannot say",
  and a caller that reads `null` as *stale* empties the ledger on every clone that has no
  `.git`. Pinned here in both directions — a row from a superseded `#movement` commit is
  dropped **however recent it is**, and a fortnight-old row from the current epoch is
  **kept**, because the clock does not overrule the commit. Also pins that the exit-gap book
  says WHY it reset a row: "movement code changed" and "no sighting in the window" are
  different facts, and a zero meaning *fixed* against a zero meaning *untested* is exactly
  the confusion that made Ukgoth's north door read `refused 182, crossings 0` on a day it
  crossed six times out of six. See [`m59-evidence.md`](m59-evidence.md)) and
  `node tools/m59-savelog-test.mjs` (68 — **the per-save-window roll-up, which is a READER,
  and a reader's failure mode is a number that is wrong while everything around it still adds
  up**. The first draft counted `k.what` for a kill against a ledger whose field is `creature`
  — every total correct, every breakdown empty — and invented two death splits that do not
  exist on a `died` row, which would have reported zero PVP and zero travel deaths for ever.
  So the cases here are all shapes that otherwise read as a healthy fleet: twenty-three
  keepers announcing one save are ONE boundary and two saves past the tolerance are two; a
  kill is attributed to `creature`; an unknown event kind is NAMED rather than dropped; a
  death nobody classified makes the travel rate `null` and never `0.0`; PVP *shown* and PVP
  *guessed* never merge; and adjacent windows partition rather than overlap, `from` inclusive
  and `to` exclusive. See [`m59-evidence.md`](m59-evidence.md)) and
  `node tools/m59-which-test.mjs` (27 — **the gate every `/m59*` command runs first, and the
  one tool that may never name the wrong fleet**. It builds a throwaway checkout in TEMP and
  runs the real `m59-which.mjs` against fake brokers, so it opens sockets only to itself and
  cannot see this machine's rosters. Two defects lived in one line — `live.find(x =>
  x.health.fleet === label) ?? live[0]` — and each fails in a different direction. The
  fallback meant that when OUR broker was slow to answer, an UNRELATED one was picked up and
  reported as the answer: measured here, prod's `/health` takes 1046ms idle and 2573ms under
  load, because it is the busy one and that is exactly what makes it the one that matters,
  while an idle broker on another port answers in 4ms — so a missed probe printed `MISMATCH:
  the broker is holding "shadow"`, naming 21 entirely different characters, about one run in
  four. The `find` matched on the fleet LABEL, which CLAUDE.md says outright is not an
  identity, and THAT one fails to an all-clear: run against the old code, a second checkout's
  broker calling its fleet "prod" while serving a different roster returns **exit 0**. So this
  pins that a broker is ours only when its `/health` state path resolves to our roster file,
  that an unreachable port is INDETERMINATE and never a statement about a fleet, that a
  disagreement between the socket and the records on disk is refused as the shape of a second
  broker on one fleet, that a lock whose live pid started long after the lock was written is a
  recycled pid rather than a holder — the process start time is 1ms from the pid file's own
  timestamp, because `m59-service.mjs` writes it as it spawns — and that nothing listening
  anywhere is still exit 0, or `./m59.sh up` could never start a fleet) and
  `node tools/m59-proxymutate-test.mjs` (59 — **the emulated client could not ACT, and eight
  MCP tools died on that**. `KeeperProxy.need()` hands its picture client to every tool that
  acts on something, and it implemented the reading side only — so `fight`, `attack`,
  `rest`, `escape_underworld`, `cast`, `shop`, `act` and `faction_status` threw a TypeError
  in the broker before a byte reached the wire: `c.roomContents is not a function`,
  `c.attack is not a function`, `c.apply is not a function`, and four more. Measured over
  ~4 hours of supervised play: no usable mutation path at all, on the only kind of
  character a running fleet has. Three things had to exist for the fix, and this pins all
  three. THE METHODS, each forwarding to `/action` — the same route the movement tools have
  used since the keeper split, so the broker still never touches the wire — with the
  argument names checked on BOTH sides, because a mismatch there is invisible (the keeper's
  own `travel` case records `toRoomNum` against `to` sending every journey nowhere while
  the fleet blamed the terrain). THE EVENT WINDOW, because sending the packet is never the
  whole of a tool here — a merchant refusal is a sentence spoken to the room — and
  `waitFor` used to answer "there is no event stream here", which eighty-odd call sites
  read as "nothing happened"; it now asks the process that owns the socket, and keeps the
  empty shape with `no_event_stream` as the fallback so an older keeper still reads as
  "nobody could hear" rather than "nothing was said". AND THE REAL SELF OBJECT ID, which is
  the half that would have gone wrong quietly: `selfId` was the placeholder `-1`, harmless
  only while this client could not act, and `apply(food, selfId)` is how EATING works
  (food.kod:56) — the only way past the vigor-80 rest cap. Both ends now refuse to forward
  a negative target) and
  `node tools/m59-policyrevert-test.mjs` (42 — **a spot policy that reverts has to leave a
  line, and for the two flags that have killed people it has to name the writer**. The
  persistence layer logged exactly one transition, `autopilot.mode`, and the comment beside
  it says why: a silent revert "was the undiagnosable part". That argument was never
  carried to the rest of the policy, so `useSafeSpots`/`requireSafeWall` going `true/true`
  -> `false/false` between two writes left NO line anywhere in the broker log, by
  construction — and those are the flags deaths #24, #25 and #26 were root-caused to.
  Death #26: room 586, centipede, `in_safe_spot: false`, every trial reading "not holding a
  spot — nothing to test", pinned in the open ~18 minutes, after a re-arm 19 minutes
  earlier had VERIFIED both flags true. Pins that the diff covers EVERY field rather than a
  watchlist — a watchlist is how `purpose` stayed out of a schema for a year with every
  keeper's audit switched off — while sorting the survival pair to the front and reading it
  in the order the policy is reasoned in rather than alphabetically; that a key appearing
  or disappearing is a change and not a silence, which is what a revert actually looks like
  on disk; that `requireSafeWall` without `useSafeSpots` is coerced UP rather than down,
  because a caller that asked for a wall asked for MORE caution and clearing the stricter
  flag would answer that by removing it, while the other three combinations are all
  meaningful and are left alone; and that the keeper's one `policy updated` line now
  carries before -> after and names the writer, which is the third reserved key on the
  wire beside `agent` and `mode`) and
  `node tools/m59-phantom-test.mjs` (40 — **one mistyped agent name used to degrade every
  health check for the life of the broker process**. `session()` minted a bare `Session` for
  any non-empty string, and a bare session can never be in game, because nothing ever tries
  to join a name the roster does not know. So naming the CHARACTER (`JohnsSlave`) where the
  AGENT (`psycho`) goes — the fleet page prints both — got `agent "JohnsSlave" is not in
  game — call join first`, which is a sentence about a CONNECTION for a fault that is a
  NAME, and sends a monitoring layer to rejoin a character that was never unwell. Two calls
  one second apart, same broker, same character, answered "fine" and "call join first". The
  phantom then outlived every 45s sweep — the sweep iterates the ROSTER — while
  `m59-service.mjs status` printed "the broker rejoins them on its own; watch the log" about
  a row it could never reach. Pins that an unknown name is refused before any session
  exists and that the refusal NAMES the agent whose character that is, that `join` and
  `create_character` keep the exemption because introducing a new name is their job and
  nothing else claims it, that a never-joined session stops blaming the connection, and that
  `status` counts and rejoin-promises only rows the sweep can actually see — failing OPEN on
  a broker too old to send `in_roster`, because reading undefined as "not mine" would report
  an empty fleet, which is the louder bug. The rule itself is in `m59-agent-name.mjs`
  precisely so it can be asked a question without starting a broker) and
  `node tools/m59-wedge-test.mjs` (66 — **a wedge broken by a cancel is a wedge re-issued**.
  The watchdog's second arm breaks a healthy wedge with `cancelMovement()` "so the next
  pass can decide with real numbers", and the numbers were identical — same square, same
  room, same destination — so the next pass issued the same walk and the arm broke it
  again: 589 times in 93 minutes on one character, then 18 minutes on one square with
  seven threats in the room and every decision-trail entry a variant of "moving to
  somewhere I can heal", dead to a centipede mid-"travel" (issue #37). Pins that both
  arms record WHERE they broke a wedge and count consecutive breaks at that place with the
  pinned radius (`noteWedgeBreak`), that `travel()` reads the record at its single gate
  before setting out (`answerWedge`) — below `WEDGE_REPEAT_CAP` the body is sidestepped two
  squares in a rotating direction so the plan starts from a square that has not wedged, at
  the cap the walk is refused once out loud and every walk from that place is refused fast
  until `WEDGE_GIVEUP_HOLD_MS` expires, after which the count starts fresh rather than the
  refusal becoming permanent; that moving away drops the record and an unknown position
  does not; that `wedgedInPlace` answers from four signals because the arm only fires at
  full health; that `tradeInPlaceIfWedged` swings at the nearest thing in reach when hurt,
  wedged and unsheltered — and not otherwise — holding position and never disengaging; and,
  by source, that the ladder reaches it BEFORE every rung that answers being hurt with
  distance, because a rung that exists and is never reached is what the second incident
  was made of. The fake mover MOVES the body, so "did the sidestep change the start
  square" has a real answer) and
  `node tools/m59-lasterror-test.mjs` (28 — **`last_error` is the field the status snapshot
  calls "the one field worth reading before anything else", and it was write-once for the
  life of the process**. Set in two places, cleared in one: the constructor. So it meant
  "the most recent error ever" while every reader — operator, hourly strategy review,
  ten-minute play tick — read it in the present tense. And the error it holds is usually a
  survival FEATURE firing: `breakOutViaLogoff` leaves a crowded spot via reconnect(), which
  nulls the client for ~800ms, so the in-flight pass throws. Sixteen of those in 58 minutes
  of healthy farming; six minutes after one, the same process reported "fighting from a
  proven safe spot", 4 kills, 0 deaths — and the identical stale error. Pins that a
  completed pass on a LIVE session clears it and leaves a `recovered` journal line, that a
  completed pass on a session that is NOT live does not (a pass can finish without touching
  the wire, and the class being cleared is exactly "the session went away"), and that the
  error is stamped and attributed — `last_error_live: false` is the self-healing reconnect
  window, `true` is a fault the session was awake for, and a climbing `failing_passes` is
  the genuinely dangerous case that used to look identical to the blip. It drives the real
  `notePassSucceeded`/`notePassFailed`, which were named for this: the catch arm sleeps five
  seconds, so a test going through `loop()` could ask one question a working day) and
  `node tools/m59-menagerie-test.mjs` (58 — **"the fleet" never means the ride-along
  characters**: a host is a host because of the FILE it was loaded from and never a name
  convention; a menagerie roster that will not parse is an ERROR rather than an empty
  menagerie, because an empty host set is an OPEN DOOR; every tool refuses a host by agent
  name and by character name, in nested and array arguments, reads included; free text is
  not an identifier, so a fleet character may SAY a host's name; only the menagerie runtime
  gets through, and the capability is set by the transport rather than claimable from an
  argument; a listing that hides hosts says how many it hid; and hosts are still OURS for
  the fleetmate check, which is a different question from who obeys an order — that last
  one is the Statler incident, and it is why the claim is pinned) and
  `node tools/m59-menagerie-script-test.mjs` (40 — **what a host does is a table**: a script
  reports every problem and never half-loads, a rule that matches but says nothing is
  dropped rather than swallowing every later rule, a pattern from disk cannot hang the
  driver, the haggle provably terminates and never sells below its floor, and the routine
  is a pure function of elapsed time so a crashed driver resumes mid-cycle) and
  `node tools/m59-unattended-test.mjs` (44 — **the contract test for the carve-out**: with
  no bot attached every faculty answers `keeper`, a bot asking for all eight gets only the
  directional four, an expired lease is the keeper's again, and the override takes a
  character back rather than letting the next heartbeat reclaim it. It should fail the day
  somebody moves a survival decision out of this repository) and
  `node tools/m59-deaths-test.mjs` (82) and
  `node tools/m59-stream-test.mjs` (54) and
  `node tools/m59-ability-test.mjs` (44) and
  `node tools/m59-compendium-test.mjs` (42) and
  `node tools/m59-prey-test.mjs` (56) and
  `node tools/m59-spellaudit-test.mjs` (28) and
  `node tools/m59-localclient-test.mjs` (65 — the last ten spawn REAL processes named
  `Meridian.exe`, because every failure mode of the POSIX scan is invisible to a fixture.
  **A PROTON LAUNCH IS SIX PROCESSES, NOT ONE** — reaper, srt-bwrap, pv-adverb, proton,
  steam.exe, the game — all repeating one command line, so a naive count reads six clients
  and refuses to claim any of them; the identity is the ACCOUNT. Only the last of the six
  has the executable at `argv[0]`, and that is the one a claim must bind to, because a
  claim is released when its pid exits. A process that merely mentions the client, like a
  grep or `m59-shortcuts.mjs --show`, must not be claimed off flags that are only quoted
  text. And the cap counts CLIENTS, not processes: at eight raw matches the second
  person's launch truncates mid-chain. The fixture symlinks `/bin/bash`, because a
  `#!/bin/bash` script runs with `argv[0]` = `/bin/bash` and would have tested the wrong
  shape. **The scan reads the whole machine**, so the assertions are scoped to accounts
  nobody plays — a live Kermit failed five of them by being correctly detected) and
  `node tools/runtime/pilot-lease-test.mjs` (15 — a remote pilot claim is held by the CLOCK and
  never by a pid, because a Steam Deck's pid means nothing on the broker's machine; a lapsed
  lease is not resurrected by a late heartbeat, and another machine cannot take a live one over
  by renewing it; **a released, lapsed or superseded lease answers `released`, never
  `reclaim`**, and a claim naming an ended lease_id is refused — Raphael, 2026-10-02 — while a
  broker with no memory of the lease still says reclaim; plus a source check that the broker
  is wired to the graveyard) and
  `node tools/m59-remote-pilot-test.mjs` (7 in process on every platform, +6 CLI cases on POSIX —
  the real hold loop: a release by hand ends the heartbeat and nothing re-claims, even against a
  broker that predates the record of ended leases (same broker pid = released, not restarted);
  a restarted broker IS re-claimed; two characters held, release one, only the other is
  heartbeated; a superseded holder stops. The CLI half: claims BEFORE the client exists, renews
  while it runs, releases its own lease when it exits; on an unrolled broker anchors on the
  broker pid and says so; refuses the wrong fleet before claiming anything; gives the character
  back if no client appears) and
  `node tools/m59-bank-test.mjs` (52) and
  `node tools/m59-routecheck-test.mjs` (56 — **can these bodies get to these rooms, asked
  before the lock**. The per-character mirror of `reachable`: that one asks whether ANYTHING
  arrives at a room, once and globally; this asks whether THIS character has a route from
  wherever a death or an errand left it, and the two disagree routinely. Advisory by default
  because "no route" is a fact about the bake and not about the world — `warnings: 'error'`
  on the script, or `M59_FLEETSCRIPT_WARNINGS=error`, promotes it, and the environment beats
  the script so an operator can tighten one they did not write. Pins the three refusals that
  keep it from becoming a nuisance: a body already IN the room is not a failed route, an
  unreadable position is not evidence of being stuck, and a router that throws or answers
  null is a question rather than an answer. **And it pins the wiring as source text**, because
  the bug worth having a test for was there rather than in the pure function: `findPath`
  answers `{found, hops, reason}` and is ALWAYS truthy, so the first predicate — `p &&
  p.length > 0` — was true for every pair in the game including `38 -> 999`, where 999 is not
  a room. A check that cannot fail, the same shape as `Boolean({ok:false})`) and
  `node tools/m59-overfarm-test.mjs` (70 — **the mixture arithmetic, and the four things the
  loot ranker refuses to do**. Its first case is the one worth reading: sifting 150% of pack
  capacity out of a half-preferred stream comes home 75/25, and that is not a tuning target
  that could be adjusted to taste — it falls out of `overfarm_percent` being measured in bulk
  sifted against capacity. If it ever stops coming out at 75/25 the unit has drifted and every
  number the strategy reports is in a different currency from the one it claims. The rest pins
  the refusals: an unpriced item scores `null` rather than 0 and is never dropped (160 of 249
  weighable items have no price, so this is the common path); a protected name is not a drop
  candidate at any score, singular or plural; cost is `max(weight, bulk)` because either
  ceiling full means the pack is full; and a swap must clear `swap_margin` before it is worth
  the drop, the get and the seconds they take in a monster room. A final section reads the
  broker, autopilot, game and stats sources as TEXT to pin the wiring — importing
  `m59-broker.mjs` would run it — because a policy that dies in transport is this
  repository's signature failure) and
  `node tools/m59-supply-test.mjs` (154 — **moving supplies between two characters one broker
  is driving, on the architecture production actually runs**. `supplyBetween` was written when
  the broker WAS the keeper and the pacer and the socket; per-character keeper processes have
  been the default since the split, and on that arrangement the exchange could not move a
  single item — while, in each case, failing in a way that sounded like the game's fault. The
  keeper hold was a SILENT NO-OP (`autopilotIfAny` answers undefined for a keeper-backed
  character, so nothing was stopped and both keepers drove straight through a four-step
  handshake any one of their actions cancels), `waitFor` resolved null, `roomContents` was not
  a function, the four trade packets did not exist on a snapshot, and `travelExclusive`
  returned the JOB WRAPPER so `t.arrived` was undefined and a walk that worked read as a
  refusal. This pins the fixed version against fakes of BOTH kinds of session: the handshake's
  order — accepting before the counteroffer arrives is logged by the server as cheating — that
  a delivery is judged on an arithmetic difference in the receiver's own count and never on a
  name it already carries, that whoever is standing still is held and the WALKER IS NOT
  (`goInert` switches the survival ladder off, which is the Cccc post-mortem), that a hold
  another errand holds is left alone but our own is RENEWED by presenting its token — an
  inert keeper wakes on a deadline, and a hold taken before a five-minute walk lapses in the
  seconds between arriving and offering — and that both ends are handed back on every path
  out including a throw. And the offer encoding, which cost a live run: THE TEST IS THE TAG, NOT
  WHETHER THERE IS MORE THAN ONE. A stack with ONE left carries amount 1 and went out as a
  bare id, which contributes nothing to the parallel number list the server pairs
  POSITIONALLY against the ids it thinks are NumberItems — so one untagged stack slides every
  count after it onto the wrong item and the whole offer moves nothing. Measured on shadow:
  Hhhh, holding one elderberry and one herb, could hand Jjjj neither, in either direction,
  with the handshake completing and `may_accept` true both times. Nobody was full; the packet
  was malformed. It is a separate file from `m59-broker.mjs` for the reason this whole
  document exists — that file cannot be imported without starting a broker, and a rule nobody
  can ask a question offline is how a no-op hold survived as long as it did) and
  `node tools/m59-policypush-test.mjs` (20 — **does an order reach the process that will obey
  it?** `autopilot action=start` wrote to exactly two places and neither of them was the
  character: the broker's own in-process Autopilot shell, which on a keeper-backed broker
  drives nobody, and the roster on disk, which a keeper reads ONCE at startup. So a policy
  change applied cleanly, persisted correctly, answered `running: true, mode: "farm"` — and
  the keeper went on running the orders it booted with. Measured on prod 2026-08-26: nine
  characters in Familiars switched to farm / "fungus beast" / `assigned_room` 544 /
  confinement released were right on disk and all nine were still `survive` with the old
  confinement in the live keeper a minute later, with nothing erroring anywhere. The second
  half of the bug has a longer fuse: `join()` ends by re-imposing the roster snapshot the
  keeper process read at STARTUP, so a push that updated only the live Autopilot object works
  and then silently reverts at the next rejoin sweep, phantom recovery or pilot hand-back —
  which is why the boot orders are `let` and the push moves them too. This pins both halves,
  plus the three things that make the push safe rather than merely present: that the write is
  identity-stamped and refused BEFORE it applies anything, because `keeperPort()` falls back
  to a guessed port and a policy is the least visible thing you can change on a stranger's
  character; that `mode` and `agent` are stripped out of the body so neither can land in
  `policy` as a key that looks authoritative and is read by nothing, which is how `purpose`
  sat outside a schema for a year; and that the wire format stays FLAT, because an older
  keeper handles the body as `Object.assign(autopilot.policy, body)` and a `{policy:{…}}`
  wrapper would make every keeper predating the change silently ignore the whole order. It
  reads source rather than opening a socket, for the reason this document exists — the
  behaviour needs a live broker and a live keeper, and this has to be answerable on a clone
  with no fleet) and
  `node tools/m59-lru-test.mjs` (26 — **the broker's geometry cache has a ceiling**.
  `_walkableCache` was a bare `new Map()` with no eviction, and its name undersold it: nine
  key prefixes, and the largest entries are whole decoded `.roo` rooms, one per room per
  prefix across 264 rooms, resident for the life of the process. Not a runaway leak — it is
  bounded by the world — and exactly the shape that hurt anyway. Measured on prod
  2026-08-27: the broker at 0.8-1.4 GB RSS taking ~10,700 page faults a second while Windows
  trimmed its working set, and a full GC over a heap that size produced a **736-second**
  event-loop stall. The tell was the shape of the failure — connections to 8901 were
  REFUSED, not slow, while the port sat listening, which is the accept backlog filling
  because nothing was calling `accept()`. This pins that the ceiling is enforced on the way
  in and that what falls out is the least recently USED rather than the least recently
  written: the fleet stands in a handful of rooms and asks about them repeatedly while a
  room-view sweep drags in a long tail, so insertion-order eviction would throw away the
  room the fleet is fighting in and keep the sweep's leftovers — trading bounded memory for
  a `.roo` re-parse on the one event loop every session shares, which is the worse bug. It
  is its own module for the reason this document exists: `m59-broker.mjs` cannot be imported
  without taking the fleet lock and starting rejoin timers) and
  `node tools/m59-describe-test.mjs` (52) and
  `node tools/m59-recordjam-test.mjs` (43 — **turning a live traffic jam into a fixture**:
  that `m59-recordjam.mjs` reads its documented region grammar as `col,row` (one of the
  repository's stable legacy positional encodings), collapses a run of
  samples to what stood still and what wiggled (a trace of position CHANGES with when each
  was first seen), counts a player once however many observers saw it while keeping two
  same-named rats apart by id, redacts our names to `player A…` and other people's to
  `stranger A…` unless `--names`, and measures the floor under the region off the real BSP —
  against the Sewers of Barloque, the rat picket line it was written for; and that **every
  jam fixture on disk stays redacted**: each player in `tools/fixtures/*.json` is a role and
  never a name, because a file that was clean when written is the one nobody re-checks —
  `spidertrap1.json` is pinned with its subject's square, vitals and load and the black
  spider three squares west of it) and
  `node tools/m59-fightback-test.mjs` (36 — **the fight-back edict**, an operator's order
  that is off by default: that the watchdog half counts blows only with something in reach,
  asks for a fight at ten seconds and not nine, pulls the handbrake once per pass, and stays
  silent below the flee line, while fighting, and under an errand; and that the pass half
  answers with the nearest thing inside the engagement band, fights in place from a wall,
  bookkeeps a kill exactly as passFarm does, and steps aside for the survival ladder, for an
  unarmed character, for a stale request, and for a target the band refuses) and
  `node tools/m59-party-test.mjs` (95 — pairing, shared walls, armour ranking, and **who is
  us in a process with no broker in it**: that the file-backed roster source the keeper
  process installs names every roster character and nobody else, folds case, follows the
  file's mtime, keeps its last answer when the file cannot be read, and that a red
  fleet-mate with a grudge on file is refused as "one of ours" — the assertion that was
  missing when the fleet killed Statler; it reads `m59-keeper-process.mjs` to check the
  source is still installed) and
  `node tools/m59-hits-test.mjs` (41) and
  `node tools/m59-devclient-test.mjs` (31 — the one file every patched-client launch goes
  through: that `shortcuts/dev.bat` names no character and carries no password, that its FOR
  variable is `%%a` and not the `%%%%a` the first version wrote — which cmd rejects, so every
  launcher it generated died on its endpoint lookup before starting anything — that a
  per-character file is one `call` line with the five arguments in dev.bat's order, and, on
  Windows, that the generated file actually runs: usage and exit 2 on too few arguments, exit 3
  with a message when no client is built, and under `M59_DEVCLIENT_DRYRUN` the endpoint it
  resolved and the account it would log in as, never the password) and
  `node tools/m59-loadout-test.mjs` (126 — the loadout format, the learning arithmetic, the
  composed sell decision, and the fleet-wide gear write, against scratch directories; it sets
  `M59_LOADOUT_DIR` so it never reads the real one, which a live keeper is reading every
  pass) and
  `node tools/m59-coordination-test.mjs` (25 — what the fleet is short of, who is near
  enough to be handed it, and how far a courier walks: that a loadout shortfall of any kind
  reaches the board with its quantity, that the neighbourhood is polled nearest-first, and
  that a stale declaration and a zero shortfall are both refused as delivery orders) and
  `node tools/m59-grudge-test.mjs` (48 — **the contract test for the only code here that
  can make a character hit a real person**: that `PF_*` is read as an enum so a Dungeon
  Master is never mistaken for a murderer, that a grudge and a live flag are BOTH required
  and neither alone is enough, that the hour is measured from the last blow, and that a
  fleetmate is refused before anything else is asked) and
  `node tools/m59-war-test.mjs` (21 — **the guild-war arm of that same gate**: that the
  server's `PLAYER_IS_ENEMY` mark or a remembered enemy-guild membership is enough with no
  grudge, that a fleetmate or guildmate is never a target whatever the flags say, that a war
  engagement never turns safety off and a server refusal suspends the memory, that a zone
  alarm pulls in fleetmates in the SAME map and only that map, that one look leader looks at a
  stranger, and that a corrupt war book is never overwritten) and
  `node tools/m59-pvp-test.mjs` (13 — **the PvP record behind /pvp**: that a death broadcast is
  written only by the keeper it names and never for a monster or a fleetmate, that "of the The Second
  Swines" still parses, that a ledger row naming the agent and one naming the character are one death,
  that alarms alone are never a battle, that `finished` does not stretch a 0.49 s fight to 30 s, and
  that a test fake without a real Recorder writes nothing),  `node tools/m59-pvp-telemetry-test.mjs` (10 — **what each of ours DID in a fight**: that every cast is
  joined to the reply its caster heard (landed, already in effect, failed, no mana) and a cast with none
  says `no reply heard`, that an old fight's opener rows stand in as casts, that a robe swap and a broken
  armour are counted, that a third-person line is kept once with who heard it while "your wand" stays per
  body, that a map change and every swing carry the `m38 r15c17 +12/+40` stamp, that the client's tap
  sees every attack/cast/use/unuse and a throwing listener never stops a packet, that a keeper writes
  an action row only inside a PvP window, and that an enemy's rendered look is kept once per fight and on
  every change while a fleetmate's never is, and what ours picked up is kept for two minutes after an enemy
  died and not otherwise),
  `node tools/m59-pvp-yelp-test.mjs` (16 — **the wolf that yelps**: that Zalgo level 1 corrupts exactly one word
  with single marks, level 2 a quarter to a half of the words, level 4 every letter stacked; that `{enemy}` stays
  readable unless `corrupt_names`; that the byte budget cuts mid-line at a letter boundary and never mid-mark;
  that Latin-1 turns `H̸E` into `H8E` while `say(..., { encoding: 'utf8' })` sends the marks and the
  default stays Latin-1; that a loud character in a PvP moment yelps ONCE per damage zone, a deep hit saying
  only the deeper zone and healing to 95% starting a new episode; that quiet characters and calm moments say
  nothing; that a yelp may borrow an untiered ORIGINAL callout in the speaker's own voice and never a tiered
  one; that an arrival callout is corrupted to max(its tier, the speaker's wounds); and that yelps do not
  fill the arrival chorus),
  `node tools/m59-pvp-callout-test.mjs` (15 — **loud PvP**: that a line in one muppet's voice (`voice`) is only
  picked for that muppet, case-insensitively, while unvoiced lines go to anyone; that a loud character says one line, `{enemy}`
  filled, when a hostile arrives, and the actions row carries the quote, the callout and the location stamp;
  that a hostile still present, or back inside two minutes, is not a new arrival; that a quiet policy, a
  `loud: false` order, a non-hostile stranger and a keeper just started stay silent while a loud order's
  target counts as hostile; that a third loud keeper is held back by the fleet-wide chorus of two; that speech
  heard in the minute after an arrival is kept with its speaker; and that the battle text quotes ours and
  theirs, drops our echo and keeps a line heard by many once),
  `node tools/m59-victory-taunt-test.mjs` (33 — **who broadcasts after a won battle**: that the LAST
  kill names the speaker, that a killer who is human-piloted, has no lines or cannot afford the
  broadcast hands over to the strongest who can, that a mana refusal in prose tries the next, that an
  unsettled, stale, traded or already-answered battle is never taunted, and that a win the ledger turns
  into a trade stays silent) and
  `node tools/m59-pvp-rooms-test.mjs` (53 — **where a player may be fought at all, `pvp_rooms`**:
  that silence allows every room and `[599,2,38]` allows 599 and refuses 576, that an unknown room
  is not a listed one, that the broker refuses a non-integer room naming the key, that outside the
  list a war enemy is not engaged but the sighting alarm still goes out, that a player hit is not
  answered, the body is not taken and `pvp_attacked_outside_rooms` reaches the durable PvP log as
  hostile contact, that a fight carried out of the list ends with "outside pvp_rooms" and never
  the suspension text, that inside the list nothing changes, and that every keeper gate asks the
  one function) and
  `node tools/m59-pvp-strategy-test.mjs` (149 — **modular PvP strategies**, docs/m59-pvp-strategies.md:
  that no assignment, `default`, an unknown verb, a throw, a promise or a slow decide is silence and the
  old behaviour, that agent beats character beats default and `null` stops the fall-through, that a local
  module overrides a private one of the same name and an edited one reloads, that `flee_to` takes the body,
  walks to the room, ends on arrival and holds there, that a blow on the road or a war engagement does not
  restart or preempt it, that a sighting flees once per window, that a failed flight backs off, that an
  operator's combat order is never preempted, that `engage` lifts pvp_rooms for that room only, that a
  `sortie` walks out ignoring the fight it leaves, posts on its square with the room list lifted and the
  keeper held, answers a hit there, walks home when the map goes quiet, never follows a second map out,
  and is replaced by a `flee_to`, that `wait_home_fight` keeps a posted guard waiting while its home map's alarms say the fight goes on (and only its home's), that `alarm_elsewhere` is opt-in by `moments`, asked only for a fight next door and once per
  window, that a groan (the pain sound) reads as the kod health band and reaches the strategy as
  `player_health` for players not ours, that `hold_fire` passes over a hostile on sight and on alarm but
  never stops return fire, that a `joust` swings its exchange, backs away inside the room to `gap` squares
  without swinging until `period_ms` has passed, re-paces on every blow with `pvp_episode` in the facts, lifts
  pvp_rooms like `engage`, only evades at `swings: 0` and ends on any other answer, that `joustRetreat` slips
  along a wall rather than into a corner, that a `rescue` ambush is accepted outside the confinement, travels,
  and engages an attacker already standing there, and that a menagerie host is never assigned anything) and
  `node tools/m59-wand-shot-test.mjs` (15 — **why a wand zap was refused**: that the server's
  "behind you" test and staircase line of sight are transcribed, that a stale target square is
  charged to `stale` and a missing one to `other_room` ahead of every other gate, that any zap,
  cast or swing inside 2 s predicts `timer`, that "You can't see your selected target." names
  `facing` itself, that a refusal nothing predicted is `unexplained` and a hit despite a
  prediction is `unexpected`, that the rate is refused over SHOTS, that shot and fight-message
  rows never enter the battle log, and that PvP replay seals evict oldest-first under a budget) and
  `node tools/m59-guild-refusal-test.mjs` (14 — **"Only those in guilds may attack each other
  here."** (room.kod `room_guild_combat`, a ROOM_GUILD_PK_ONLY refusal of one TARGET, not the
  room): that after it no path — operator order, war scan or alarm, return fire, fight-back,
  self-defence, a player hunt, the client's own attack packet — swings at that player again in
  that room, that another player there still is, that leaving the room or ten minutes forgets
  it, and that the refused player hurting us takes no body from the keeper's survival ladder
  while an attackable attacker still starts return fire, and that a hit FROM a refused player clears the refusal so return fire starts. See `tools/m59-refused-targets.mjs`) and
  `node tools/m59-purchase-funding-test.mjs` (**real shopping flow with simulated bank and
  merchant**: posted costs and quantities, exact shortfalls, reserved cash, failed and
  interrupted withdrawals, fresh merchant quotes after a price change, and separate bank
  accounts) and
  `node tools/m59-townrun-test.mjs` (15 — **which counter a town trip is aimed at, and what
  the errand costs**: that a reagent shortfall goes to the apothecary and never to a market
  that cannot sell it anything, that an empty purse sends it to a bank FIRST, that a full
  pack still goes to Roq, and that the bill the trip and the withdrawal both read has one
  home. See [`m59-economy.md`](m59-economy.md) on a trip that cannot fix the thing that
  opened it) and
  `node tools/m59-tuning-test.mjs` (43 — **the contract test for a config surface built to be
  edited in a hurry**: that an absent, empty or unparseable tuning file all mean the profile
  rather than an empty policy, that `flee_below: 60` (somebody typing a percentage) is refused
  rather than applied as 6000%, that a typo'd key is reported while the good key beside it
  still applies, that a character line beats a profile line beats a default and the plan says
  WHICH won, and that a refused `--set` leaves the file exactly as it was) and
  `node tools/m59-profiles-test.mjs` (87 — **the contract test for a posture whose whole
  value is in what it REFUSES**: that the town is a curated room set rather than a name
  match (the Deep Dark Woods *of Tos* is wilderness; Familiars and The Crypt are indoors
  and say neither), that a farm room outside the walls and a character standing outside
  them are both refused rather than quietly walked, that an unknown current room is the one
  thing allowed to be a note instead, and above all that every one of the thirteen policy
  fields which can walk a character out of a room is still suppressed — a list that grew
  one death at a time and passes cleanly if somebody adds a fourteenth) and
  `node tools/m59-guild-test.mjs` (192 — **the contract test for a command space that
  refuses in total silence**: that the permission check runs off the server's own bitmask
  rather than the rank table, that invite is LORD while exile is LIEUTENANT, that
  `set_password` inherits MASTER from a declaration it does not make, that UC_GUILDINFO's
  conditional password branch reads to the last byte on both shapes, that the ten rank
  titles are five ranks × two genders in packet order, that mutual enemies and one-sided
  declared enemies stay apart, and that induction is serial because the game makes it so.
  that the rent sign survives two overlapping negative sentences, and that the Bookmaker's
  own rent override is not the non-PK doubling in disguise. Founding costs 5,000 and cannot be
  undone and a hall is 25,000, so none of it can be learned live) and
  `node tools/m59-weapon-magic-test.mjs` (30 — whether a weapon bypasses a troll's NONMAGIC 80,
  as READ rather than assumed: an unread weapon is `unknown` and never mundane, born-magic and
  unflagged classes need no look, a lapse sentence re-opens every reading of that NAME because it
  names no id, a reading does not survive its id wearing another name, and the magic tie-break in
  `weaponRanking` wins a tie between two hammers but never lifts a magic long sword over a hammer
  the priority ranks first — the operator's "don't force swords" — and a conjured weapon is never
  offered in a sale plan, because IA_MADE makes every merchant refuse it in silence) and
  `node tools/m59-chest-eviction-test.mjs` (22 — the guild chest's "would give up first"
  ranking and its history on /inventory: unplanned before surplus, least value per bulk first,
  an unpriced or unsized item LAST in its tier and never read as zero, shillings never ranked, a
  history row only when a re-reading actually differs, and the history file never mistaken for a
  chest. Nothing evicts from a chest yet — the server never does — so the ranking is a plan the
  page shows, not a log) and
  `node tools/m59-economy-test.mjs` (73 — the Economy and Skills boards, the one
  tab bar all six boards share, and the pack drill-in: that it names what is in the pack
  rather than only how full it is, and that an EMPTY pack, a character the broker is not
  holding, and a broker too old to report the list are three different sentences) and
  `node tools/m59-stats-test.mjs` (60 — the Stats board and the pane it shares with the
  planner: that grouping is the six numbers and not the level, that a sheet with no
  attributes is never folded in as a zero roll, that a roster character with no sheet at all
  is named rather than silently absent from a page of percentages, that the read-only pane
  carries neither a slider nor the hatching that marks a typed value, and that the ceiling and
  carry arithmetic have one home. Runs against scratch sheets, never the fleet's own) and
  `node tools/m59-backup-test.mjs` (42 — backing the rosters up and putting them back,
  against scratch directories; never touches a real fleet) and
  `node tools/m59-testbed-test.mjs` (113 — the DM command vocabulary, the patrol ring, the
  scenario spec and the arena reply. **Opens no socket, deliberately**: every live failure
  these three tools have had was "the command we sent was not the command we meant" — a
  room object id read out of a reply header, a karma figure a hundred times too small, a
  name this repository sent that the server was always going to refuse — and all of those
  are decidable from a string. Nine of them are the CHARACTER NAME RULE, which is
  `checkCharacterName` in `m59-newchar.mjs` and mirrors `kod/util/system.kod`: three to
  thirty characters, and no hyphen. Both halves used to be wrong in opposite directions —
  a sixteen-character ceiling that was ours rather than the server's, and a hyphen we
  admitted and the server refuses, which turned a readable error into a bare
  `BP_CHARINFO_NOT_OK` with nothing in it) and
  `node tools/m59-keeperwhy-test.mjs` (25 — **the signatures that name a keeper's loop**. Each
  fixture is a keeper `/state` trimmed from the one read on prod; the test fails if a signature
  goes quiet on its own case, if an honest broke-off is misread as the pinned-to-nothing loop, or
  if a signature points at an `m59-stuck` entry that does not exist) and
  `node tools/m59-preyreach-test.mjs` (28 — **prey the keeper has proved it cannot walk to**, and
  since 2026-09-25 that the pass SELECTS by the same avoid set fight() filters by, and drops a
  pending pull whose creature is gone.
  `closeOnQuarry` always detected it and never remembered it, so the next pass ranked the same
  creature nearest and walked at it again, for ever, while every board read `hunting`. The case
  it pins hardest is the KEY: the memory is a SQUARE, not an object id, because an id is
  renumbered on every system save and recycled within hours — so an id-keyed memory would chase
  each respawn in the same walled-off corner in turn. It also pins that the memory EXPIRES,
  which is the critic rubric's rule that "unreachable" is a fact about our model of a room and
  never about the room; that an empty memory yields no filter rather than an always-true one;
  and that it does not leak into the safe-spot selector, because a square something unreachable
  is standing on may be a perfectly good square to stand on. Offline) and
  `node tools/m59-fs-test.mjs` (14 — **the /fs column, and the width is the point**. The
  operator's constraint was a line rather than a number, and it measured 43; a layout rule
  in a comment lasts one commit. `render()` is pure so the money columns can be tested
  against a hundred million banked and a three-digit roster without waiting months for
  them, and the staleness line is pinned both ways — present when a balance is dated, and
  ABSENT when none is, because a warning that always fires is one nobody reads. Offline) and
  `node tools/m59-buyers-test.mjs` (38 — **what a merchant will actually buy**: that a gem
  is also a reagent and the apothecaries' exclusion turns on it, that Marion's smith takes
  no body armour, that an exclusive rule excludes a sibling of the same family, and above
  all that "cannot say" falls through to OFFERING. The two failure directions are not
  symmetric — a wasted offer costs a round trip, a wrongly withheld item costs the sale and
  is invisible) and
  `node tools/m59-merchants-test.mjs` (95, dropping to 61 without `M59_ROOT` — including that
  `merchants {show:"Morrigan"}` finds the herb seller in 202 by NAME, that Frisconar is found,
  that `{here:true}` maps each live object to its own row instead of the room's first, and that
  a shop seen live at a counter is never "not found" again) and
  `node tools/m59-shop-arrival-test.mjs` (28 — **did the purchase arrive**: a fake keeper whose
  pack fills a few reads after the buy and sends no `got` frame; pins that 120 herbs in three
  chunks are all sent and all counted, that a partial delivery reports asked/arrived/short and
  why it stopped, and that the broker's `shop` tool counts the proxy's CURRENT client after a
  fresh /state rather than the snapshot literal it started on) and
  `node tools/m59-city-matrix-test.mjs` (123 — the loopback/DM safety boundary, exact
  25-pair parallel schedule, 150-leg serial schedule, exact staging square, authoritative
  in-process broker/DM identity, fresh trace lifecycle, protected report paths,
  clean-prefix resume contract, that the run holds the fleet run lock before it writes or
  asks anything and is refused naming the holder, and that every leg it sends is the walk
  alone — `run_errands: false` — while `runLeg`'s other callers keep the broker's default.
  **Opens no socket and touches no roster**) and
  `node tools/m59-collision-trace-verify-test.mjs` (44 — an entirely synthetic matrix,
  JSONL capture, map and BSP pin the offline proof: nested runner reports, stable room
  identity across object-id renumbering and reuse, exact off-map exits, collision replay,
  complete sequence evidence, trace loss, callsite and pair coverage, broker-observed
  fallback and single-writer policy, repo-rooted paths, and atomic private verdict output)
  and
  `node tools/m59-collision-trace-test.mjs` (49 — tracing is off by default, failed writes
  recover in order with durable loss markers, the physical cap survives restart, trace
  files are private, every actual send has a validated or explicitly unsafe wire row, and
  broker health publishes the effective trace and exit-fallback settings) and
  `node tools/m59-collision-test.mjs` (404 — **the fail-closed contract for all
  movement**: compact collision metadata survives a bake, legacy maps cannot authorize
  a coordinate packet, the player cylinder catches wall bodies and corners, long strides
  cannot tunnel, stock endpoint-0 slope and water-depth rules are preserved, every
  emitted packet is revalidated, a body on `walkFine`'s direct line comes back as
  `object_blocked` after three fans rather than a shuffle that spends the budget, **the
  client's own object rule is transcribed rather than modelled** — endpoint not swept,
  ending inside the zone allowed while moving away, and a slide instead of a refusal,
  all of `clientd3d/move.c:666-697` — and the documented Brownestone, Limping Toad, Icky,
  Farol, Ukgoth, Cor Noth, Temple, and Fey precision cases remain usable. **It also holds
  the crossing budget honest**: the three walks `M59_EXIT_CANDIDATES` pays for must land on
  three DIFFERENT squares rather than one square asked three times, `atEdgeOpening`'s own
  one-fine-square tolerance is what decides whether two openings are the same attempt, near
  duplicates are moved to the tail and never deleted, and a `geometry_blocked` refusal
  raised before the crossing packet is sent buys one free re-centre at the same square —
  free because the budget counts different squares, capped so a wall that refuses from its
  own centre still ends the crossing),
  `node tools/m59-needle-test.mjs` (30 — **getting past a body without treating its square
  as blocked**. You may share a SQUARE with a spider, never a fine position, so a corridor
  one square wide with a body in every square is still walkable. Pins the arithmetic
  (`MIN_NOMOVEON`, 16 kod, one exclusion zone — not two player radii, which is the wall
  rule and double the truth), that the .roo under a "one square wide" corridor is 82 to 110
  fine units rather than 64, two hand-built dead-centre configurations, a 200-corridor
  randomised sweep against an independent breadth-first search, and a negative case — three
  bodies abreast in one square — without which a modelling artefact let a body teleport
  through them. **Its verdicts have been wrong three times and a person walking the corridor
  caught it every time**; `tools/m59-needle-lay.mjs` lays any of those nine out on a live
  server so that keeps being possible) and
  `node tools/m59-routing-test.mjs` (90 — **the contract test for planning on the map the
  mover enforces**: that `moverStepLands` and not `stepAllowedByCollision` is the question
  that decides anything, that the quantizer has one answer for the planning half and the
  sending half, that a mask round-trips bit for bit and one of the wrong size is refused
  rather than mis-indexed, that with no mask the router plans exactly as it did before any
  of this existed, that a refusal removes an EDGE and not a SQUARE, that the tiny pockets
  against the walls are kept because they are the safe-spot signal, and that an exit a bake
  cannot reach is still OFFERED — a bake must never be the reason a doorway disappears, and
  that the clearance preference routes further from the walls while never removing a route) and
  `node tools/m59-exits-test.mjs` (91 — **the five sources of "an exit", and the one view that
  unions them**: that the evaluator and the sentence agree about a trigger predicate, in both the
  flat and the `values: [...]` shape — six of twenty-four entries were written flat, three
  renderers described them as impossibilities, and the fleet was crossing them the whole time, so
  DEADNESS is measured by asking `inRegion` (the mover's own evaluator) whether any square
  satisfies it and the flat shape is reported separately as AMBIGUOUS; that the room
  `m59-exitreport.mjs` called "NOTHING IN THE WORLD GRAPH
  ARRIVES HERE" has two inbound triggers with provenance and a landing square; that every room
  the inbound verdict refuses, `findPath` refuses too — asserted over the WHOLE map, because
  that equivalence is the only thing that makes it honest for fleetScript and the broker to
  refuse a journey on it; that a dead predicate leaves the room PLANNABLE, which is exactly the
  trap; and that the waiver works, needs a reason, and quotes it back — the errand that finds
  the missing trigger has to be able to aim at the room nothing arrives at) and
  `node tools/m59-impossible-test.mjs` (126 — **the polarity the 153 collision assertions do
  not cover**: every one of those asserts a legitimate move REMAINS USABLE, so that suite
  passes cleanly on the day the walls stop working. This one asserts refusals, by checked-in
  fine traces that each name the wall index that refused them, with controls in the same
  rooms out of the same bake — because a suite that only asserts refusals passes perfectly
  when everything is refused, which is the fleet standing still. Observation cannot be the
  oracle: another client's view of a player phasing through a wall is lag compensation) and
  `node tools/m59-safewall-test.mjs` (15 — **the mechanism, on real geometry, against
  squares characters actually held**. The other 141 safe-spot assertions are about the
  BOOK-KEEPING and the mechanism itself is tested only on synthetic grids, so nothing
  asserted that what the fleet stands on in the real world is a safe wall. It reads the
  book and the baked map: every held square is still nominated, a held square offers
  materially more unanswerable shots and more wall at its back than ordinary floor in the
  SAME room (3.24 vs 1.49 and 3.46 vs 0.85 across 37 rooms), and the chooser still lands on
  one. Its last section is the guard against the routing preference leaking back into the
  tactical questions and teaching the fleet off the walls — flip `path`'s clearance default
  back on and it goes red on 302 of 395 walks) and
  `node tools/m59-breadcrumb-test.mjs` (51 — **the contract test for getting out of a safe
  spot**: that a crumb is recorded at the one choke point every move passes through, that a
  retreat cannot invent an impossible traversal because every step goes back through the
  fine validator, that a broken trail is dropped whole rather than skipped, that it stops
  the moment the route reappears, and that a genuine dead end still reports itself.
  **Its last section lifts `selfOrResync` and `refreshRoomIdentity` out of the broker source
  and RUNS them**, which is the only way this class of fault is visible: both sent an
  identifier that is bound nowhere in that file, so both threw ReferenceError the moment
  they were reached — and both are recovery paths, so they could only fail once something
  else had already gone wrong. Every other assertion here about losing our own position
  drives the FIXTURE's stub of that method, and passed perfectly throughout) and
  `node tools/m59-pulse-test.mjs` (47 — **is the character moving, asked of the character**.
  Every other stall number measures the KEEPER. Most of the file is the exclusions, because
  a detector that shouts when somebody sits down gets switched off before the day it was
  needed: resting, fighting, trading, waiting and holding a safe wall are all silent, and a
  wall held for a full minute raises nothing. Its newest section is the one exclusion that
  was WRONG — `inert` meant an errand or a bot owned the character, and the pulse stood down
  for it, so two characters bled out stationary in The Flatlands with `wedges: 0` and
  `stood_down_for: "travelling to The Streets of Tos"` in both post-mortems. Inert now
  excuses standing still and not standing still while losing health, with steady health,
  healing, and genuinely leaving the neighbourhood all still silent. Two assertions in that
  section exist because the first implementation was useless and only the counters said so:
  a wedge must survive a painless second, since damage and the pulse both land about once a
  second and the excused branch clears the episode; and the body test must see a character
  ALTERNATING between two squares, which the exact-square comparison reads as movement. Its
  two newest assertions guard a ring that now serves TWO questions on two widths: the ring
  was widened to six samples so `damageRate` could read half a point a second off five
  seconds of it, and `pennedIn` kept the newest three — because that test gets STRICTER as
  the ring grows, so widening it too would have switched off the handbrake it feeds while
  every assertion here stayed green. Both constants are read out of the source rather than
  copied, and the pattern that reads them uses `[0-9]` rather than an escape because it
  lives in a template literal, which eats the backslash before RegExp sees it) and
  `node tools/m59-release-consent-test.mjs` (39 — **landing a commit IS the sign-off, and this
  pins what may still stop a release**. `--cut` used to refuse an unpushed trunk with *"on a
  machine with many worktrees that work is usually somebody else's"* — true, and a deadlock
  dressed as politeness: the authors here are mostly SESSIONS, and a session that has ended
  cannot consent to anything, so "ask the author first" resolves to *never ship it*. On
  2026-09-11 it held a roll over seven good commits, four of them movement and guild fixes. The
  work then waits for the batch reconciliation that rule 5 exists to call the worse failure, so
  the old default manufactured the condition the other rule forbids. The default is now inverted
  — silence is consent — and the only thing that stops a release is the commit saying so itself,
  with a mandatory reason the refusal quotes. **THE ASYMMETRY IS THE DESIGN**: reading a typo'd
  hold as CONSENT ships something its author tried to stop, silently, in front of twenty-one
  characters on a shared server; reading a stray line as a hold costs one person a minute. So
  every near-miss spelling refuses, with a DIFFERENT sentence saying to fix the message rather
  than argue with it. The parser gives ordinary English the benefit of the doubt exactly so it
  can be strict about the punctuated form — `Release-Hold` is never prose and always counts,
  `do not release the lock until the keeper answers` needs a colon — and against the last 67
  real commits, bodies up to 4,478 characters of prose about releases and deploys, it holds none.
  Also pins that a `Claude-Session:` trailer is NOT a hold, since rule 6 exists to let somebody
  ask what you meant and would become a lock whose key is gone if it gated shipping. And that an
  EXAMPLE is not a decision, which cost ten minutes to learn: the commit introducing holds quoted
  the trailer in its own message and `--verify` promptly refused to release it, correctly, by the
  rule as written — so a hold must be FLUSH LEFT, git's own convention for a trailer, with fenced
  blocks skipped) and
  `node tools/m59-deploy-drift-test.mjs` (20 — **ahead by HASH is not ahead by WORK, and the
  deploy check must be able to come down**. `--verify` is what stands between a `--cut` and
  burying somebody's work, and on 2026-09-11 it announced *"prod is 37 commit(s) AHEAD of main …
  that work is stranded until somebody notices and adopts it by hand"* on a tree where nothing
  was stranded and nothing had ever been lost. `rev-list --left-right` answers "does prod hold a
  commit OBJECT this ref cannot reach"; the question worth asking is "does prod hold a CHANGE
  nothing else holds", and on a machine with twenty-two worktrees and several sessions rebasing
  the same work onto origin at once those come apart daily — always in the direction that cries
  wolf. A refusal that fires on a healthy tree every day is one people learn to type past, and
  the next real one reads identically: the same argument the `#movement` epoch rule makes about
  a counter that cannot come down. So it asks `git cherry`, which compares PATCHES, and asks
  BOTH refs when the local trunk and origin have diverged — neither one alone is the trunk then,
  and a change is stranded only if it is missing from both. Pinned in all three directions: the
  measured false alarm reports nothing stranded, a commit absent from both refs is still an
  emergency, and **an unevaluable `git cherry` returns `null` rather than `[]`** so the caller
  keeps refusing — a guarantee that cannot be evaluated must refuse, which is the rule the
  pre-commit hook broke by sitting silently inert for an afternoon. The decision is a pure
  function in its own module for the reason `nextDeployTag` is: `m59-deploy.mjs` RUNS ON IMPORT,
  so a test that imported it would execute the modes that move production. **AND A PATCH-ID IS
  STILL A HASH** — `git cherry` computes it from the diff, so a change rebased onto different
  surrounding lines reads as brand new. An hour after the first fix, seven commits sat only on
  local `main` and cherry called all seven missing; comparing SUBJECTS against origin, which is
  what rule 5 actually prescribes, showed **five were already there**, and cherry-picking the
  first hit a conflict — what re-landing a landed change looks like from the inside. So
  `subjectSeen` is a third opinion, pinned as a NARROWING ONLY: it can take a commit off the
  stranded list and never add one, and a `null` from it leaves the commit stranded) and
  `node tools/m59-whowrote-test.mjs` (12 — **the attribution tool, against fixtures in a fake
  home**, so it reads none of this machine's real transcripts. It exists because the tool's own
  first version answered the question CONFIDENTLY AND WRONGLY: run from a worktree it derived the
  Claude project slug from `basename(REPO)` — the WORKTREE's name, `land-codex-a3` — which matches
  no project directory, so it found the Codex sessions, reported ZERO Claude ones for a file six
  Claude transcripts mention, and printed a tidy healthy-looking table. An attribution answer gets
  acted on: a wrong one was relayed to the wrong session twice in one night, about a file driving
  twenty-one characters on a shared server. So the two things that can silently go wrong are
  pinned — WHICH directories it looks in (the slug still resolves to `m59-harness` when the test
  itself is run from a worktree, which is the regression), and whether it ever carries CONTENT
  out. That second one is a safety rule rather than a style choice: these transcripts hold
  whatever passed through a session, including the roster that is the only copy of twenty-three
  account passwords, so a row is asserted to be exactly `file,hits,mtime,session,system` and the
  planted secret is asserted absent from the whole serialized result) and
  `node tools/m59-wallgrind-test.mjs` (36 — **grinding against a wall, as EPISODES rather than
  ticks**. Operator: *"are units just grinding against walls for hours?"* — and nothing in 651
  tools could answer it, because everything recorded about being stuck is a POINT EVENT.
  `m59-stucks.mjs` counts `stuck_backed_up` firings per square, which is "how often"; forty
  bounces in a minute and forty minutes of unbroken contact produce the same count and want
  completely different fixes. **The shuffle half is the one nothing could see at all**: CLAUDE.md
  has warned for months that "a stall detector that requires STILLNESS misses the commonest way
  to stand still: a two-square shuffle against a wall resets it on every sample", and a search of
  every tool for "oscillat" returned ZERO — a documented blind spot with no instrument. Two of
  these assertions were written against defects the suite then found. **Distinct squares is the
  WRONG discriminator**: a character moving one square every three samples shows two or three in
  any six-sample window, exactly like a shuffle, so honest slow progress was flagged; the test is
  now REVISITS, since a simple path through k squares has exactly k-1 transitions and every
  return adds one. And **a gap in the samples is a new stream**, found by the end-to-end check
  rather than a unit test — keepers restart about once a minute and passes block for twenty
  seconds, and carrying the ring across the silence dated a ninety-second shuffle as FIFTY
  MINUTES, in the one number the tool exists to produce. Also pins that a character with no
  destination is RESTING and never grinding, because an inn and a wedge look identical to a
  position sampler and flagging the inn is how an instrument earns its way into being switched
  off) and
  `node tools/m59-scratch-test.mjs` (26 — **FleetScratch's retention contract, which is the half
  that can silently destroy evidence**. Every other defect here shows up as a missing number;
  this one shows up as a recording that is not there, at the moment somebody goes looking, with
  no way to tell pruned from never-written. So the three rules are asserted rather than
  documented: `--dry` deletes NOTHING, the `keep/` half survives a year-old prune, and the
  aggregates survive a total one. **The retention split is the whole design and it argues with
  the operator's own brief**: fine data expiring at 24h is right, but the stated goal was to
  "look back at historical movement code through newer analysis lenses", and a window that drops
  everything after a day cannot answer a question asked next month. So aggregates never expire
  and every one is keyed by the `#movement` epoch that produced it — the same mechanism the
  exit-gap book uses, because a counter spanning a rewrite of the mover is a monument rather
  than a measurement. The epoch is stamped at WRITE time, since reading it later would label old
  evidence with today's mover, silently, in the direction that makes two incomparable things
  look comparable) and
  `node tools/m59-roo-test.mjs` (74, with raw-room checks skipping without a copy of the game's
  `resource/rooms`). The rest need a live server —
  `m59-autopilot-test`, `m59-skills-test` and `m59-coop-test` all want a broker on
  8899 and fail with `ECONNREFUSED` without one, which is not a regression.

## m59-wallstop-test.mjs (142, 1 skipped)

The wall stops that killed, pinned on the real geometry. Each `tools/fixtures/wallstop-<room>-r<r>c<c>.json`
is a spot where a traveller took "a wall on the way past", stood on it in a room of nine to eighteen monsters,
was reached anyway, and died without moving — thirteen spots from 2026-09-02, both fleets, built by
`m59-recordwallstop.mjs` from the postmortems and redacted like the jam fixtures. For every spot it pins
that the wall search WITH walls allowed offers a wall from the stop square and that the wall the keeper chose
is one the geometry calls safe (the old behaviour, and what killed); that with walls withheld (the crowd rule,
`Autopilot.crowded`) the search offers nothing without a journey; that the crowd was at or above the rule's
default (skipped with a note where it was not — the Flatlands pipe spot is the wedge class); that blows landed
on the stop square; and that no fixture names a character. **It should fail the day a wall in a crowd becomes
a candidate again.**

## m59-retreat-refusal-test.mjs (32)

**A retreat that was refused is not a retreat, and must not end the pass.** `retreatToSafety`
refuses outright while `retreat_to_inn` is off — the operator switched it off on 2026-08-27 —
and every caller reported success anyway, so the journal read like an escape while the body
stood still. JohnsSlave died of it four times in two days (issue #51); the last post-mortem
window is 31.3 seconds, 46 samples, `squares_per_second: 0.0`, `net_squares: 0`,
`rooms_crossed: 0`, seven things adjacent, 2 of 21 health, and a correct decision on every
single pass.

Two halves, and the suite pins both. The refusal now **dispatches the replacement it had been
describing** — the comment above it has said "the replacement is not nothing, it is the
route-adjacent safe spot" the whole time, so the branch takes a wall when there is one, shares
the ladder's own 30-second `wallTriedAt` budget so a wall-less room is not re-scanned once per
rung, obeys `use_safe_spots`, and still defers to the older guard that keeps a character on a
wall that has held. And the caller **no longer claims the pass for a refusal**: the rung that
decides "moving to somewhere I can heal" used to `progress()` and `return HANDLED` whatever
came back, which pre-empted the rung immediately below it — the one that walks out via
`leaveViaAny` with a reconnect to shed the crowd. The end-to-end assertion drives the real
`passFleeAndRest` on a keeper at 3 of 21 health with seven monsters in the room and checks that
the body actually leaves; its mirror checks that a retreat which DID arrive still ends the pass
and does not also abandon the room.

The last section is the churn guard, and it is the reason the class survived: five call sites
had the same bug in the same shape and each reads perfectly well on its own. So the rule is
checked over the file — every `retreatToSafety` call binds its answer, nothing follows one
straight into an unconditional `progress()`, and the two behaviour trees (`m59-bt-flee.mjs`,
`m59-bt-farm.mjs`) agree, because a selector's `SUCCESS` is the tree's version of `HANDLED` and
landing them otherwise would re-open the same grave. **It should fail the day a caller reports
a refused retreat as movement again.**

## m59-stall-lever-test.mjs (48)

**A stall has to name its lever, and "none" is an answer rather than a silence.** `noProgress`
counted idle passes and had exactly one keeper-side lever — blink — selected by testing the
reason *sentence* against a regex. A reason that did not match got no lever at all, and
nothing anywhere said so: the counter went up, `stuck.since` advanced, and the character
stood still. Measured at 27 minutes, 1,623 seconds, 943 idle passes, zero kills, in the
character's own assigned farm room, with the detector watching all of it (issue #50,
suggested direction 3 — the half the approach walk did not close).

The second lever is outside the keeper: `m59-supervise.mjs` restarts a keeper stalled for
eight passes. That is a real lever for a **stateful** stall, where the thing in the way is
keeper-local — a room written off for the session, a route given up on, a square's failure
budget. It is not one for a **deterministic** stall: a fresh keeper walks into the same room
with the same orders and re-enters the loop in seconds, once every ninety seconds, for ever,
each line reading `restarted <character>` as though something had happened. That file already
refuses the same trap twice by name, for `NO_SAFE_WALL` and for a character resting up the
mana to arm itself.

Four things are pinned. `stallLever` is the whole map from a reason to the thing that can act
on it, enumerable rather than buried in a branch, with `null` a legitimate answer — and the
blink classification is unchanged, which is asserted in both directions so making it explicit
cannot quietly become making it different. A **repeat run** is counted separately from idle
passes, because a character finding a new obstacle every pass is working and one reciting the
same sentence is in a loop its own inputs cannot leave; sixty different failures are never
declared. A leverless run past twenty repeats **declares** `STALL_NO_LEVER` on
`status.refusals` — once, with `since` surviving, carrying the repeating sentence and the
room, cleared by `progress()` and by nothing else. And the fact travels: `stalled`, `stuck`
and the keeper process's own `/state` all carry `lever` and `repeats`, asserted together,
because a field added in one publisher and forgotten in the other is how the fleet board once
reported `stalled: false` for a character standing in a corner for twenty minutes.

The last section is the supervisor's half: `stallRestartDecision` is pure and exported, an
undeclared stall is never rationed (this must not become a throttle on a mechanism that
works), a declared one gets two restarts and then the truth, a *different* declared reason
starts the count again, and a character that earns something is forgotten. **It should fail
the day a stall reason can go unclassified again.**


## m59-keeper-restart-test.mjs (60) — a keeper restart is a handoff unless memory says no

Pins `decideRestartMode` in `m59-keeper-restart.mjs`: handoff when free memory exceeds
(concurrency + 1) x per-keeper RSS + margin, strictly; a concurrency that does not fit is lowered
before the handoff is given up; short even for one is a `LOGOFF RESTART:` naming the free memory
and the threshold; `M59_RESTART_MODE` and `--mode` override it, a caller's flag beats the
environment, and an unrecognised value is reported and treated as `auto`; measured RSS beats
`M59_KEEPER_RSS_MB` and unusable sizes keep the defaults. Concurrency is one unless the broker's
`/health` advertises `keeper_handoff.port_reservation`. The RSS reading is one hidden `tasklist`;
the logoff fallback is addressed by agent, character and pid with one line per keeper; only an
`unknown tool` may fall through to a logoff — a wrong-broker refusal never does. And the callers
that used to `POST /stop` (friendly-reboot, node-keeper-build) now go through it.

`m59-nowindow-test.mjs` now also scans `tools/runtime/` and counts `tasklist`/`taskkill` as
program launches, because the process-identity checks there run on every keeper spawn, adoption
and handoff.

## m59-which-test.mjs (27) — the third answer a port can give

The gate every `/m59*` command runs first already had two answers and a rule about them:
a port that does not answer is a QUESTION, and a question may never become a statement about
a fleet. That is what `INDETERMINATE` is for, it exits non-zero, and a hung port still
produces it — prod's `/health` was measured at 2573ms under load, so the busiest broker is
the one most likely to be missed and it is always the one that matters.

**A port that answers in a protocol that is not HTTP is not a question.** A broker is a node
`http` server and always opens with `HTTP/1.x`, so anything else is positive evidence: there
is something on that port and it is not a broker. Filing that under "could not ask" is what
happened on 2026-09-05. `substrate/broker-boscontrol.pid` still named http 8911 for a broker
whose pid had been gone for days, the RTS gateway had since been given that port, and its
first bytes came back as `HPE_INVALID_CONSTANT` — so every run ended INDETERMINATE, and since
every `/m59*` command gates on the exit code, a fleet whose broker was answering `/health`
perfectly was unaddressable from that checkout.

**The line is drawn at the status line and deliberately not past it.** A truncated body, a
bad chunk size, an early EOF are what a REAL broker looks like when it dies or is cut off
mid-answer, and reading those as "not a broker" would be the original bug wearing the fix's
clothes. So only the codes raised before a valid status line — `HPE_INVALID_CONSTANT`,
`HPE_INVALID_VERSION`, `HPE_INVALID_STATUS`, `HPE_INVALID_METHOD` — are definite, `ECONNRESET`
stays a question, and the suite pins silence as indeterminate in the same breath as pinning
that a non-HTTP port no longer blocks an answer. It also pins that a non-HTTP port ALONE is
still an all-clear, or `./m59.sh up` could never start a fleet on a machine where anything
squats a recorded port.

The last four assertions are about WORDING, which is not a lesser thing here: the message is
the whole product of a tool whose only other output is an exit code. When a broker holds a
fleet carrying our label while serving a different roster file, the old text ended "or say
`--fleet prod` and mean it" — which is what the operator already said and how they got there.
It now names both roster files and the checkout to run from. On this machine that is the
difference between the trunk and the deploy worktree, which each have a
`substrate/fleets/prod.json` holding 21 characters called the Muppets, and only one of them is logged in.
**It should fail the day the tool turns an answer back into a question, or a question into an
answer.**

## The fine-movement instruments (m59-finepos 52, m59-stepbench 62, m59-pinch 44, m59-labctl 45)

These four are the measuring equipment for fine movement, and they are grouped because they failed
as a set on 2026-09-12: a controlled experiment on `walkFine`'s heading fan could not be run, and
each layer's defect was hidden by the one above it. Every assertion below is one of those.

**`m59-finepos-test.mjs` (52) — "where is this body" is not one question.** Four sources answer it
and three are wrong in ways that read as right; the suite keeps the failures DIFFERENT, because "no
keeper", "keeper silent" and "keeper answered without a position" are different problems and
conflating them throws away a working run. Three things it pins that cost a session each:

* **`/state` is a CACHE and `/state?fresh=1` is a READ.** The keeper serves a coalesced projection
  and sends no packet unless a reader asks. Measured at one instant after a teleport: `/state` gave
  `as_of_ms=435, fresh=false`, `/state?fresh=1` gave `as_of_ms=0, fresh=true`. Read from the cache,
  the pre-teleport square came back rock steady for 1.4–1.9 seconds, so two reads agreed and a body
  was declared settled on a square it had already left. `fresh` is not a staleness alarm — it reports
  whether THIS reply was refreshed — and reading the field's name instead of its definition is the
  same error as reading `arrive_within` as client units.
* **The PORT is the band; the PID is the build.** A keeper restart changes the pid and keeps the
  port, so a caller stamping rows with the port gave `compareBenches` the same value either side of a
  genuine respawn — a guard that could only ever abstain, which fails in the direction nobody checks.
* **`settledPosition` observes rather than assumes.** Two consecutive agreeing reads, not a sleep
  somebody tuned; and a stale read cannot settle anything however often it repeats. It says which of
  the two it hit, because "still moving" sends a reader looking for a body in flight, which is the
  wrong search when nobody is updating the record at all.

**`m59-stepbench-test.mjs` (62) — abstaining is the point.** The bench exists to stop a mover change
being credited with an improvement it did not make, so the cases that matter most are the ones where
it must refuse: a shared keeper pid means no respawn happened and possibly the same build, and a
contact-rate delta inside the noise band must be reported as NO DIFFERENCE. It also pins that the
bench cannot ask a question the mover cannot answer:

* **`checkCell` refuses a cell outside the mover's one-step range.** `walkFine` sizes a step
  `max(8, min(stride, remaining))`, so the minimum is 8 protocol units = 128 client. 64 is one step
  of the FLOOD LATTICE, and inheriting it here made an eighth of the matrix measure a body
  overshooting and dithering back: 193 units of travel at 86 degrees off a 64-unit request.
* **`stepRequest` builds the walk arguments in the same module that records the result**, because the
  two have to agree about what a cell means and apart they did not. One step — more is a search — and
  a tolerance strictly smaller than the aim, or walkFine returns `arrived: true` without moving.

**`m59-pinch-test.mjs` (44) — an OPEN square cannot answer a question about the fan.** On open ground
heading zero is accepted and the fan is never consulted, so a bench sited there reports a clean,
stable, perfectly reproducible number either side of a mover change and that number is about nothing.
It is the most convincing possible null result and it is an artefact of the site: 11,151 of 11,352
floored squares in The King's Way refuse no heading at all, and the bench had been sited on one.
OPEN, SEALED and NO FLOOR stay three different refusals — the first two both produce a contact rate
of zero and are opposite in cause, one body never having to choose and the other never moving.

**`m59-labctl-test.mjs` (45) — and this one was green about a protocol that does not exist.** Its fake
admin socket answered `show name` with a position and `show room` with an object id. BlakSton v2.4
does neither: `show name` returns an object id and nothing else, and `show room` is not a command. So
`stageAt`'s read-back could never match, `landed` was null on every call that ever ran, and nine
assertions passed about it — while the relocate had succeeded every time, exactly as the note that
`UtilGoNearSquare` never says no predicts. A fake that lies is worse than no fake. It now speaks v2.4,
keeps the legacy `show room` path covered so deleting it would fail, and pins that a `via` standing in
a DIFFERENT room resolves nothing.

**It should fail the day a position read is answered from a cache, a bench credits a change across a
single keeper pid, or a fake starts speaking a protocol no server does.**

## Faction join and the soldier shield

**`m59-faction-shield-test.mjs` (20 groups) — the sentences, the cover check, and the plan.**
`tools/fleetscripts/faction-shield.mjs` joins a faction through the liege's join quest and then
earns the soldier shield (questengine.kod templates 1-4, 199-200, 208-216). The liege's replies
are built from the kod's own assign hints (read from `M59_ROOT` when present) and run through
the parsers, so a reworded resource fails here instead of at a liege. It pins that Jonas asks
for a **helm** — `SimpleHelm`'s spoken name — which the table had as "simple helm" and so could
never have matched; that the Duke's ruby and all six of Jonas's items have no reliable seller,
so the run refuses to say "join" without them (a failed ask costs 24h of logged-in time); the
fixed kill order per liege; the hunt order (starting holdings, then the nearest other wilderness
flag rooms, never a town pole); and that the plan compiles for all three lieges with every
dynamic walk declared and a clean trap check, every `say` is one of four fixed lines, and a
character already carrying its shield walks nowhere.

**`m59-max-faction-shield-test.mjs` (18 groups) — the rank line, the hunt, and the no-ops.**
`tools/fleetscripts/max-faction-shield.mjs` ranks an earned shield up by farming the other two
armies' troops. Rank is `piFactionRank` (1-10, +1 per enemy troop, capped at
MAX_RANK_FROM_MONSTERS 10) and the only visible part is the band `AppendDesc` prints, so the
goal is the title "a supreme hero" (rank 9 or 10 — indistinguishable) and the kills needed are a
range. It pins the five titles and three army names against `soldshld.kod` and its subclasses;
that the shield in the pack decides the faction; that each army hunts the OTHER two (killing your
own costs a rank) and a corpse is not a troop; that a room is taken for enemy troops or an enemy
flagpole and never for our own; the search order (both enemies' starting holdings nearest first,
then the rest); that the shield read refuses another object's description and never asks about a
negative id; and that a maxed shield walks nowhere and farms nothing. The farm itself is
`harvest` with its `until` predicate, which the fleetscript suite covers.

**`m59-choose-hometown-test.mjs` (9 groups) — the five sentences, the verdicts, and a permanent
choice that has to be asked for.** `tools/fleetscripts/choose-hometown.mjs` says a town's sentence in
the Hall of Genealogy (Cor Noth, 156), which sets the home room LOCKED (Coruniv.kod `SetHomeRoom
#lock=TRUE`). Read from `M59_ROOT` when present, every sentence and reply must be the kod's own text,
because the hall matches with `StringEqual` and a sentence one character off is ignored in silence. It
pins that each town lands on the inn `HOMETOWNS` already knows; that Marion's and Barloque's replies,
which never name the town, still count, and the "already been chosen" refusal reads as `locked`; that
the plan declares its one room and passes the trap check; that it refuses without `confirm=true`; and
that a character already living in the target town walks nowhere and says nothing.

**`m59-faction-intel-test.mjs` (8 groups) — what the fleet overhears about the struggle, and the
`/faction` board.** The server never reports faction power; `tools/m59-faction-intel.mjs` catches
the sentences that leak it (flag claims, token returns, councilor thanks and news, townsfolk
rumours of a power band, the "balance of power" shift, and the 1-in-101 personal bonus hint) into
an append-only `substrate/faction-intel.jsonl` that every keeper writes. It pins those sentences
against `parlia.kod`, `flag.kod`, `token.kod` and `council.kod`; that a broadcast keeps no player
name; that the fold dedupes one broadcast heard by many keepers, lets the later claim win and keeps
two servers apart; `FigurePowerFromCount` and the power half of `CalcFactionBonus`; the Effects
Part's per-faction benefits (no to-hit for Duke or Princess, unfactioned a quarter and never
negative, the non-intriguing flat bonus); and that the board renders with its tab and route.

## The disciple gate — the level-3 spell quest

**`m59-disciple-test.mjs` (174) — three groups, none of which is about whether the errand runs.**
`tools/fleetscripts/disciple-quest.mjs` does a temple priestess's disciple quest, which is the
only thing that unlocks spells of level 3 and above in her school (`temples.kod:52-73`,
`monster.kod:4506-4518`). The whole derivation, with citations, is
`m59-research/reports/disciple-quests.md`.

**1. The sentences, read back out of the kod rather than out of a second copy.** Three of the four
quests are *carry this sentence to that NPC*, and the node matches with `StringContain` — which
after `FuzzyCollapseString` (`blakserv/ccode.c:626`) is uppercase-and-trim and then a plain
`strstr`. Its own comment says interior whitespace is squashed and the code does not do that. So
the two spaces after each full stop are load-bearing, and Faren's sentence spells `sacriligious`
the way the server spells it. These cases parse `kod/util/questengine.kod` and compare byte for
byte; **the failure they exist for is a reflowed comment or a helpful spell-check**, and the
symptom is a character standing in the right town, saying the right words to the right NPC, and
being ignored. They SKIP rather than fail where no `M59_ROOT` tree is present.

**2. The reading, which is the only instrument there is.** Every refusal in this errand is
silence: too far away, already a disciple, failed within the last hour of logged-in time, and
anonymous are four different facts and one identical nothing. The one thing that distinguishes
them is the free teach probe — say a level-3 spell's name to the priestess, and the library turns
that into a bare `CanDoTeach` with no money and no state change (`monster.kod:5711-5733`,
`library.kod:2868-2872`). The cases build her seven possible answers *from the kod resources*,
fill `%s` the way the server does, and run the errand's own classifier over them. The ordering is
asserted as well as the matching: the disciple refusal is the ONLY answer that means the quest is
undone, because `CanDoTeach` tests the gate before `PlayerCanLearn`, so every other sentence is
itself proof the gate is open. **A classifier that files the refusal as anything else reports
success over a locked shop.** `monster_teach_base` is the one that catches a lazy test: it is
split across two source lines mid-word, so a grep for the runtime wording finds nothing in the
source and a grep for the source finds nothing at runtime.

**3. The compiler changes this errand needed, and the hole one of them opened.** The server rolls
the destination — one monster of three for Kraanan, one NPC of three to five for the others — and
states it in a single private line that is never repeated. So a `walk`, a `fight` and a `say` may
take a function of the run state, resolved before the control guard so a run-time value is
inspected exactly like a literal one. `Number(someFunction)` is `NaN` and `KNOWN_TRAPS[NaN]` is
undefined, so a dynamic destination sailed through `trapCheck` **while looking as though it had
been checked** — hence the rule that such a walk must also declare `candidates`, every one of
which is then checked. Pinned here: a bare function destination is refused with or without
`allowTraps`; a trap among the declared candidates is caught before anything walks; and
`sayApproachSquare` honours the caller's radius, which it did not, so a step asking for the quest
node's reach of 25 was told it had already arrived at 36 and then failed the very check that had
sent it.

Also pinned, because it is the cheap half of an expensive mistake: `Q_NPC_CLOSE_ENOUGH` is still
5 and `SAY_RADIUS` is still 50, so the silent band between five and seven squares — where the
priestess demonstrably hears you and the quest node discards the sentence — is still real;
`"disciple"` is said exactly once in the whole errand and not at all for a character that is
already one, because joining a second instance of a quest already in flight is how a character
ends up holding a deadline nobody is working on; the Kraanan fight is `optional`, so an
unassigned run resolves to no target rather than swinging at whatever is nearest; and Riija and
Jala are refused **by name, with the reason** rather than being absent from a table.

**It should fail the day somebody tidies the whitespace in a quest sentence, teaches the probe to
read silence as a yes, or lets a run-time destination past the trap check.**

**And three more groups, every one of them written after a live rehearsal on the shadow fleet
found the thing it guards.** The rehearsal is the point: each of these was green in theory and
wrong in the world.

**Closing the last five squares.** `Q_NPC_CLOSE_ENOUGH` is a distance the errand has to *reach*,
not merely measure. Six characters walked into the Temple of Kraanan and every one then stood 17
to 39 squares from the priestess reporting a perfectly accurate `out_of_earshot` — a true
sentence that invites the wrong diagnosis, because she was reachable and the aim was not a route.
Three approaches were tried: `sayApproachSquare` aims at a point on the straight line between two
bodies and moved nothing, six times out of six, in a 49x50 room with a colonnade down it; the
broker's `approach` tool is the right idea and throws `s.world.approachSquare is not a function`
on every keeper-backed character, which is every character (same family as `act('fight')`); and
`walk_to` re-issued crossed fourteen rows and then WEDGED eight squares short, `refused_edges 5`,
identical reply four times running. `crawl_to` is the one that works, because it is the only one
that asks the KEEPER what it can step onto. Pinned: every say is preceded by a look and a crawl,
each crawl stops at chebyshev 3 (squared 18 at worst, inside the node's 25), each is `optional` so
an absent NPC stays the say step's problem to report, and a crawl to a square that resolved to
nothing is REFUSED rather than spending its whole deadline on `NaN`.

**Every prepared handler is in the plan and exactly one fires.** `steps` is compiled once, before
anything walks, so an errand whose instruction the server chooses cannot build its plan after
hearing it. Each handler therefore contributes its legs unconditionally and gates them on
`state.ask.kind`. Pinned: with a delivery in play the kill leg resolves to no target and the fetch
leg to no seller; with a kill in play no say has anything to say; every idle walk resolves to the
temple the body is already standing in; and an ask nothing recognises comes back
`kind: "unknown", handled: false` with the raw sentence rather than as an empty result.

**The questbook.** One transcript per run, written twice — once as soon as the ask is read, once
at the end — because the step loop BREAKS on an unrecovered death and a `break` skips even the
steps marked `always`. A single write at the end is therefore missing exactly when it matters.
Pinned: the second write lands on the same file rather than leaving two halves of one run on disk,
a finished run reads back with its outcome and with what she actually said, the ask index
collapses instances into shapes so the list is a specification rather than a log, and a corrupt
transcript is REPORTED rather than silently counting as a run that never happened.

- `node tools/m59-unarmed-refuge-test.mjs` (16 — **the gate an unarmed character could never
  satisfy**. `passArm`'s unarmed branch called `townTripIfCornered()`, whose third line is
  `if ((this.fledInARow || 0) <= 2) return false;`. `fledInARow` is incremented in exactly ONE
  place in the file — `gotOut()` in `passFleeAndRest`, after a successful `leaveViaAny` — so it
  counts successful FLEES. Being unarmed is not fleeing, so the precondition could never be met
  and the call was refused silently on every pass. Measured on prod 2026-09-19: Beaker 1,850
  consecutive repeats of the note and Animal 1,100, both bare-handed with a spider ONE SQUARE
  away. The case it pins hardest is not the fix but the DIAGNOSABILITY: the old note printed
  `went_to_town: false` for "refused by a gate", "no sanctuary within three hops" and "walked
  and failed" alike, so 1,850 identical lines said nothing. The test asserts the three outcomes
  are distinct strings, that a refusal reports `noProgress` rather than `progress` — the
  `retreat_to_inn` mistake, which hides a stuck body from every stall detector — and that the
  flee ladder is neither read nor written, because sharing that counter between the two callers
  is the tidy-up a later reader will be tempted into.)
- `npm run test:movement` (**the dozen offline suites a `#movement` commit has to clear**,
  `tools/m59-movement-suite.mjs`). It exists because a plain `&&` chain cannot run this list:
  some of these suites are ALREADY RED — 12 assertions in `m59-needle-test` and 4 in
  `m59-travelling-test` at origin/main, nobody's fault today — and a chain stops at the first
  and reports nothing about the ten behind it. **The baseline is BY ASSERTION NAME, never by
  count**, so a new failure fails the run even when the total is unchanged. That is the trap it
  closes: on 2026-09-18 a session compared "84 passed, 2 failed" against a remembered "84
  passed, 2 failed", concluded it had broken nothing, and had swapped two of somebody else's
  failures for two of its own. It also prints `FIXED` for a baseline entry that has started
  passing, because a known-red list nobody prunes becomes a list of things allowed to fail for
  ever. `--list` shows what it runs and why; `--strict` fails on the baseline too.

- `node tools/m59-blockedpath-test.mjs` (24 — **can a weak creature indefinitely block a fully
  built character**). The southeast exit of The Flatlands (584) is walkable on ROW 35 ALONE for
  columns 27-34 and pinches to exactly 64 fine units at columns 29-32, so everything leaving
  that way goes single file. `tools/fixtures/flatlands-584-row35.json` is that corridor captured
  off live keepers: an ant at the west mouth, a spider at r35c32, and TWO OF OUR OWN CHARACTERS
  pinned between them. The suite requires one of the two acceptable answers to be available and
  checks them in order. **Threading first** — and it measured something worth knowing: a body
  dead centre in EVERY pinch column is still crossable, because an obstacle is one
  MIN_NOMOVEON exclusion zone and `move.c` slides. **Clearing second** — two bodies per pinch
  column, which is exactly the room's own spawn cap of 8, genuinely does shut it, and that is
  the case `tradeInPlaceIfWedged` exists for. It then pins the band end to end: a built
  character (ceiling 83) may clear the ant and the spider that were actually there, a
  20-health service character may NOT be sent to fight a level-40 ant, and an unrecognised
  creature is refused rather than assumed harmless — which matters because `Guardian of
  Zjiria` killed four characters on 2026-09-19 and has no row in the creature table, so nothing
  would ever clear one out of a doorway.
- `node tools/m59-clearblockers-test.mjs` (17 — **killing the small thing standing in the way**.
  `tradeInPlaceIfWedged` is the one survival rung that does not answer being stuck with
  movement, and two gates made it unreachable in the state it exists for. `crowded()` was its
  FIRST line, so a room at or over `travelStopMaxThreats` (6) refused the swing before anything
  asked whether the character could still walk — and `crowded()` implements "in a crowd the only
  wall is the EXIT", which rests on the exit being reachable. A wedge is precisely the state
  where it is not. It also required the character to be BELOW its flee line, so a routine jam was
  unanswerable until somebody was nearly dead, by which point the room is always crowded too.
  Measured over 3,665 postmortems with a threat list: 3,131 (85.4%) died with six or more threats
  present and 3,057 (83.4% of ALL deaths) did so with `swinging: false`. The cases it pins are
  the two halves of the doctrine: a healthy wedged character now clears an IN-BAND blocker
  (`refuseEngagement`, the operator's own viDifficulty ceiling) and must NOT pick a fight with an
  out-of-band troll it merely bumped into, while below the flee line the band is dropped because
  there is no better option left. `tradeInPlaceWhenCrowded: false` restores the old precedence
  without a deploy, because the aggro argument for the veto is real.)
## m59-noderails-test.mjs (140) — the node/exit rail bake

Offline: no map, no socket, no room, no roster. The edge test and the router are injected, so
every case runs against a synthetic world whose shape is known exactly. The suite exists
because `m59-noderails.mjs` produces something that looks right when it is wrong — a list of
coordinates with a plausible shape — and four of its cases are failures that actually shipped
during the first afternoon of building it.

**The two it exists for.** `railSpan`'s unvalidated branch is a chord nobody traced; if it
were dropped, the rail would quietly shorten, and if the route were dropped, a reachable stone
would read as unreachable. `arrivalOf` is the other: `fineRouter` succeeds when the closure
holds a point whose SQUARE is the goal, and room 45's stone sits on a plateau with the valley
directly under it — so a flood reaching the valley half of `r63c46` satisfies that test exactly
as the plateau does. The case pins that reaching the square while 3,296 units below the
footing is reported as `arrived_in_square: true, arrived_off_shelf: true`, which is the whole
trap in two fields.

**`fineEdge` and the slide that shipped a false finding.** The trace answers `moved: true,
arrived: false, blocked: true, slid: true, destinationFloor: 1152` for an aim whose floor is
4096, with the body twenty units from it — inside every distance test. The suite pins that the
landing's SHELF decides, that the same slide landing on the aim's own shelf is still an edge
(sliding is how you hug a wall), that `destinationFloor` is preferred to re-reading geometry
the trace already resolved, and that an unreadable floor refuses rather than passing a guard
that did not run.

**What is written is what was checked.** One case drives a chord through a point the edge
refuses and asserts the span is not settled as a chord and that whatever it emits verifies
under the very edge it was cut with. Another walks a two-span leg and asserts no step exceeds
one lattice cell, which is the joint a cursor-less loop leaves untraced. A third covers
`cutRail`'s snapped seed, which reports `bridgeOk` and returns ok either way — on the real bake
that joint was 21 units, under the mover's floor, and was the last surviving disagreement
between the bake and `noderails check`.

**An aim below the mover's minimum step is a no-op that reports success.** A synthetic zigzag —
every step 64 units, every heading different, which is what a diagonal staircase looks like on
the lattice — asserts that corners get merged when a traced chord allows it, that every interior
aim clears `MIN_MOVER_STEP`, that a refusing edge cannot shorten a straight run (it needs no
trace at all), and that where the merge is refused the short aim survives and is COUNTED rather
than hidden.

**`check` must be able to be green.** An unvalidated point was kept rather than proved, so the
step into it refuses on every map for ever; a checker that counts that as drift is permanently
red and stops being read. The suite pins that such a step is skipped and the skip reported, that
real drift after the hole is still caught, and that the reported index is the position in the
whole rail rather than in the run — splitting the verification restarts the count at zero, and
a refusal in the second run would otherwise be reported as if it were in the first.

**And the rest is about not re-deriving what the repository already knows.** The exits come from
the bake's own anchors with `waypoint` entries dropped — in room 27 one of those IS the mana
stone, so keeping them would bake a rail from the node to itself; two exits through one wall get
two ids, because Western border of the Twisted Wood declares `east->586` and `east->597` on the
same boundary. The stone list comes from `m59-stones.mjs` with its documented aliases, so
`--node seafarer` and `--node peak` find the same room. `MANANODE_RANGE` is 3 and the box is
judged per axis: the diagonal corner melds while a nearer square on one axis does not, which a
euclidean radius scores wrong in both directions. And a refusal never says "unreachable" — it
carries `bound` and `closure_squares`.

**It should fail the day a rail is emitted that its own edge would refuse, or the day a slide
onto a different shelf is accepted as a step.**

## m59-survival-jam-test.mjs — survival ownership across a travel jam

Offline integration through the real watchdog pulse, cancellation, pending recovery
and retreat dispatcher. Covers loss of the old travel wedge when doing becomes null,
repeated failed recovery without watchdog evidence, sustained exact weak-target combat,
low-health retreat, safe-wall protection, ownership and expiry invalidation, escalation
across replacement decisions, changed-observation retry bypass, and resumption of the
original suspended journey. Larger-target fixtures cover retaliation, immediate/delayed
chase observations and body-aware local clearance; shared disappearance accounting is
also tested across separate keeper-like Node processes. Wire actions and geometry are
fixtures: this is not a live-server mortality or chase result. See
[the follow-up report](reports/2026-09-22-survival-jam-followup.md) for bounds and limitations.

## Tougher recording

`node tools/m59-tougher-observation-test.mjs` runs the production Session callback
against an offline client. It checks immediate persistence without an autopilot, paired
message deduplication, event-ring eviction, late kill attribution, names with spaces,
restart durability, multi-point sample recovery and honest page labels. It also checks
combat-message attribution before and after the gain, special kill prose, same-millisecond
ordering, and exclusion of distant, incoming and other-player combat.

## m59-safelegs-test.mjs (43) and m59-crossingtrial-test.mjs (17) — crossing a killing room

`m59-safelegs-test` pins the pure leg planner (`tools/m59-safelegs.mjs`) on synthetic rooms:
the exit one leg away needs no wall; a long corridor is walked in legs no longer than `maxLeg`,
each ending on a wall; a gap no leg can bridge is `no_chain`, never walked blind; a wall beside
a threat loses to one away from it; a chain much longer than the road is refused as `detour`;
a spent budget answers `deadline`, never half a plan; a fleet-mate standing on the next wall
does not break a convoy's chain (a held wall may be a later stop, never the first); a baked
track's corridor keeps every stop on walked ground; and the room switch (`SAFE_LEG_ROOMS`,
policy, `M59_SAFE_LEGS`, `M59_SAFE_LEG_ROOMS`). Against the baked map it checks Ukgoth both
ways — a chain exists, no stop on the rim, a warm re-plan under 150 ms — and that
`sheltersAlong` over a whole 599 crossing stays under 250 ms (it was 868 ms). It also pins that
`threatsHere()` reads the object list and never builds the tactical view. Skips the map half
loudly when there is no bake.

`m59-crossingtrial-test` pins the harness's reading half: a `[loop]` line's lateness against
the time OUR code spent in it (`code_ms` — an `(idle)`-dominated window is not a planning
stall), the profiler's own analysis not charged as a stall, and a sample stream reduced to
arrived / died / timeout / elsewhere with damage counted as every drop.

## Incoming communications

- `node tools/m59-communications-test.mjs` (97): decoded speech/system capture, source classification, fleet isolation, persistence and reconnect, filters/pagination, partial records, write failure isolation and HTML escaping. No game connection.

- `node tools/m59-proxy-communications-test.mjs`: passive human-proxy receipt, login and reconnect attribution, shared bot history, wire preservation, credential exclusion. No game connection.

## Keeper dormancy — a keeper that wants to be offline

- `node tools/m59-dormancy-test.mjs` (47): the model in `m59-dormancy.mjs`. The server's
  logoff-penalty window as kod states it (540-660 s, a safe-logoff room leaving no ghost, and the
  clock NOT resetting on a relog under 120 s -- including a logoff inside the old window, where the
  earliest strike that cannot be ruled out is now); every reason waking on its own rule with the
  penalty guard outranking all of them; a deadline wake without a deadline refused rather than read
  as "for ever"; an unreadable hand-over failing CLOSED; and a corrupt store throwing instead of
  reading as "nobody is held". Temp directory only.
- `node tools/m59-dormancy-shape-test.mjs` (22): that the keeper and the broker CONSULT it where
  forgetting to is the bug -- join, the autopilot's reconnect, `/join` and `/rejoin` refuse a dormant
  keeper (423, never the 409 a broker reads as a stranger's port), a dormant spawn never logs in, the
  rejoin sweep reads the store before any `/rejoin` and stops the lap if it cannot, `restart-keepers`
  replaces a piloted character dormant instead of skipping it, and a person logging off under a hold
  starts the penalty clock; and that a STAGED START holds everybody before the first spawn (never
  on an adoption, never over an existing hold) and `start_all` wakes only its own holds, in lanes,
  without bumping a pilot. Source text only, like `m59-handoff-shape-test.mjs`.

## Departure deviation guard

- `node --test tools/m59-deviation-test.mjs`: real Session methods and Cragged
  geometry; early large-slide refusal, ordinary-fall coverage, confirmed/unknown
  position evidence, send-time revalidation, movement-owner takeover, allowed
  small slides/timed falls, stale-push reconciliation, mandatory avoidance and
  departure routing to the exit stage. Registered in `npm run test:movement`.
- Paired native shadows must freeze and attest both source manifests, reset the
  same modeled scene/loadout per arm, verify scene release, preserve each outcome
  and clean up temporary accounts. Exit-stage reachability, living room escape
  and full destination arrival are separate endpoints. Modeled pursuit and
  unknown historical gear condition cannot prove a historical death avoided.

## Wall threading and the doorway after a refused slide

- `node --test tools/m59-wall-thread-test.mjs` (4): real `aimInto`/`threadInto`/`leaveVia`
  on Herbutte's shop (109). A wall between the body and the next square is labelled
  `unproved` rather than passed off as proved; `threadInto` then lines up along the wall
  and goes through, every leg a straight no-slide line; an uncontested proved step is
  unchanged to the byte; and a `movement_deviation` on the approach to a `go` doorway no
  longer ends `leaveVia` before its doorway fallbacks. Three of the four fail on
  `e7c4c6bd`. Registered in `npm run test:movement`.
- Known limit, printed by the last test: 109's exit row has no baked floor, so the
  offline doorway correction cannot stand on r13c4 and sends no `go`. Live, the server
  accepted `go` from r12c4 (Zheng He, 2026-10-13 20:53Z). Proving the exit end to end
  needs a shadow or live trial.


## Tos refuge and recovery regression coverage

The travel recovery arm suite exercises the actual watchdog rescue of an injured
journey, retaining its issuer and copied guards before cancellation. The Island
suite covers a survival logout between the body and status reads, rejects a
foreign recovery owner, and detects death in the later status snapshot. The
shared watchdog suite also checks suspension before cancellation removes the
live order.

The fine recovery integration supplies a mock keeper endpoint and the actual
Hollows geometry. An offline action reply after a keeper preemption must recover
at the observed refuge, then confirm the original fine goal. It uses no game
server or fleet roster. The movement-origin suite rejects stale or foreign
preemptions and later operator cancellation.

The fine safe-leg suite includes the recorded Phobos r26c70 body and monster
positions. It checks the shared refuge prefix's distance, actual wall membership,
body-clear edges and refusal when every refuge is excluded.

The fine recovery integration checks proactive yielding under a live movement
lease and declared side-exit avoidance. The walk avoidance dispatch test executes
the broker, proxy and keeper branches to verify that forbidden squares survive
transport and a new fine request cannot overwrite active injury recovery.

node tools/m59-tos-refuge-review-test.mjs exercises the recorded Tos fine geometry with the nearby body, revoked coarse-arrival confirmation, protected recovery departure, protective versus harmful enchantments, and concurrent ailment/attack evidence. The movement gate includes it. FleetScript's compiled-walk tests cover both recovery already active above a0.75 floor and recovery begun after the script handed a hurt body back, requiring full health before departure in each. Native shadow results are kept separately from these offline assertions.

## Bastion fallback tests

`node --test tools/m59-bastion-fallback-test.mjs` runs the actual travel, exit,
rail and collision code from 96 redacted positions associated with 41 PvP deaths
in the 48-hour capture ending October 15, 2026 at 07:05 UTC. Each death has a
named test; the most recent recorded stuck within that life is included when
available. Fifteen deaths had no recorded stuck. Cached predictions and death
square centers without a fine observation are explicitly labelled in
`tools/fixtures/bastion-fallbacks.json`; a synthetic center is not an observed
body position. Duplicate body-free positions reuse one completed run.

The socketless client models only declared KOD edge/code/go crossings and room
confirmation replies. It uses the committed geometry, real packet collision
checks and finite time/packet budgets. Every route must finish with confirmed
room 38 identity and avoid repeated fine-pose grinding. Starts already inside
38 are arrival checks. A separate test exercises the actual bastion flight's
call into travel and its hold after arrival. Guards cover newly arriving bodies,
changed rooms, cancelled movement generations/tokens, mandatory avoidance,
missing geometry, predicted starts and unconfirmed endpoints.

These are routing regressions, not native combat or survival replays. Frozen
historical body snapshots are retained for separate diagnostics; the full-route
tests deliberately isolate static geometry. No live attacker, damage, fatigue,
gear or server reply timing is reconstructed. Passing does not establish that a
historical death would have been survived. Registered in `npm run test:movement`.

Eight additional full-route checks restore captured frozen bodies. The Ukgoth
case asserts that the rail keeps the declared r36c16 -> r38c10 jump instead of
choosing the longer r38c8 landing by planar clearance. Predicted rail starts
must be refreshed before planning, and a takeover during that read forbids a
packet. Ordinary steps also recheck a cancelled control token during pacing.

## m59-roomyield-test.mjs (31) — a farm's kills against what its room can make

`m59-roomyield.mjs` answers "is this farm working" with three numbers beside the kill rate:
how many character-hours were really spent in the room, the room's spawn **ceiling**, and what
the five-minute samples say the bodies were doing. The test pins the parts that are arithmetic
on kod and therefore easy to get quietly wrong. Ukgoth makes ~218 trolls an hour because a room
always rolls at the five-player rate (`vbScaleSpawnRateWithPlayers = FALSE`, monsroom.kod:22),
so headcount is never a multiplier. A room class that declares no generator **inherits**
MonsterRoom's. The first draft read an undeclared field as `Number('') === 0`, which gave
Castle Victoria no ceiling at all. Weights summing under 100 are empty ticks
(`TryCreateMonster` makes nothing past the end of its table), so CV's 40+20 is 60% of its rolls,
not 100%. A silence longer than the gap is not residency. A journey places a body where it
ended. A room NAME is not a room number. And a kill sharing its creature with another
character's row inside 1.5 s is counted as **shared**: a keeper writes `killed` when its target
vanishes, so one skeleton can be two rows. Measured in CV on 2026-10-16: 843 rows in an hour
against a generator that can make 540. The last three cases load the committed room tables,
so a broken join between `tools/rooms.json`, `substrate/m59-spawns.json` and
`substrate/m59-map.json` fails here rather than printing a dash.


## Brax return queues, socket evidence and healing

- m59-queued-room-exit-test.mjs checks actual native crossings at legacy coarse/fine anchor mismatches.
- m59-queued-body-egress-test.mjs retains captured stationary monsters and shared fleet bodies through all graveyard/cavern exits.
- m59-queued-exit-recovery-test.mjs allows only known ended native operations to replan after fresh identity and ownership proof.
- m59-session-evidence-test.mjs checks socket handoff races, reconnect health baselines, bounds, scope and diagnostic write failures.
- m59-death-notices-test.mjs checks authoritative peer witnesses, duplicate broadcasts and ambiguous multi-death gaps.
- m59-death-location-test.mjs refuses guessed offline locations and resolves actual fatal socket locations.
- m59-recovery-heal-test.mjs exercises the real recovery and fieldrest ally-healing methods, resource checks and recycled target IDs.
- m59-rest-timing-test.mjs checks 60-second server regeneration gaps, genuine stalls, vigor ceilings, deadlines and damage with an injected clock.

Native fixture packet counts are offline regression evidence, not live group
arrival times. A migration benchmark requires all 24 actual room-39 baselines
at one common departure, with deaths and failed preparation attempts retained.

- m59-native-doorway-queue-test.mjs retains a recorded 16-character doorway pileup and stationary monsters, and checks that an intended approach crossing ends without chasing stale backward bends.
- m59-brax-native-onward-test.mjs exercises captured Sentinel, eastern Cragged and Cavern positions against native collision and retained monsters.
- m59-traffic-resume-native-test.mjs invokes the actual keeper resume method, including the formerly stuck healthy 69-vigor case.
- m59-convoy-provision-test.mjs covers parallel personal meals, one cohort stock scan, confirmed ordinary trades and donor reserves.
- m59-rail-coalesce-test.mjs checks opt-in same-floor chords, dense source retention and mandatory exits.
- m59-active-self-heal-test.mjs covers actual travel healing, single pending casts, login waiting and send-time takeovers.
- Healing tests also cover delayed HP after initial mana payment, paid failed spells and critical last-mana self recovery. Rest timing tests include native absolute/fractional vigor boundaries and requested mana.

The crowded socketless tests use immediate peer position broadcasts and static
monsters. They do not reproduce network delay or monster AI, and their packet
counts are not a substitute for live arrival percentiles.

Additional renewed Brax regressions cover actual file-backed passage claims,
old convoy adoption by the same process, and an injected ended north-head
confirmation failure. The socketless fixture alone cannot prove live-file
admission behavior. Tests reject another process's claim, predicted bodies,
missing convoy membership, and changed rooms. The native resume fixture now
includes the captured full-health62-vigor deviation, fresh confirmation and
send-time cancellation/identity/health changes. Fine recovery tests separately
exercise opted-in same-actor room transitions and strict fixed-room refusal.
Session evidence tests overflow the action window before and after reconnect,
then reload pinned login, health and fatal anchors from disk.

The castle regression replays all24 actual Victoria start poses with captured
non-fleet blockers and real isolated file-backed passage claims, then drains
two published GO transitions and the outside boundary independently per actor.
Captured players are excluded from static blockers by roster identity, even
when a legacy flag-derived is_player field is false. A separate test invokes
the actual unarmed takeback and verifies ownership survives cancellation.

For live reproduction, archive effective runtime policy as well as source
bytes. An old clone's near-zero recovery thresholds or disabled travel guards
can materially differ from the current fleet. Preserve the original clone
snapshot, record any aligned fields and their source, and keep earlier deaths
and failed attempts separate from the corrected run.

Recorded queue reproductions preserve each actor's actual numeric ID and flags;
the simulated client's own-body ID, predictions, room entry and peer-scene sync
must agree. The 17-body return-cliff fixture includes the captured NPCs and
real file-backed claims. Socketless results certify packet/geometry behavior,
not live monster survival or wall-clock speed. Combat session doubles must
bind `client` to the same object returned by `need()`, otherwise socket-change
guards cancel before the behavior under test. Source contract checks inspect
the actual method instead of fixed-length text windows.

The travel-origin regression invokes actual initial holds, nested wedge
shelter recovery and repeated suspension. Issuer and guard are captured before
a nested cell order can replace the parent road order. An explicit origin
remains available before Session registers that road and on subsequent resumes.

Captured exit regressions preserve the six-person castle GO jam and nine-person
graveyard boundary jam, including overlapping bodies, actual numeric IDs and
static NPCs. Real isolated file claims and immediate peer position updates
exercise complete queue drain. The castle head already occupies a legal alias
and sends zero movement packets; a different directed arrival branch is a
negative case. These remain socketless geometry checks, not live speed results.
Travel-gear tests exercise the actual captured unarmed/carrying-axe case,
changed sockets and protected recovery. Farm vigor tests invoke the real
recovery method and unchanged effective combat floor.

Movement-input evidence tests verify that consumed arguments and an immutable
observed scene survive one action and an ambiguous transport failure, without
repeating the POST or storing credentials/chat. The offset-corridor test retains
captured body IDs, peer-observed flags and skeletons, with delayed room snapshots.
Its continued corridor is explicitly reconstructed and terrain-proved; it is
not described as an exact replay of an original request that was never logged.
The NPC flight fixture similarly labels its later body capture and historical
high-floor validation separately. Future opt-in traces retain the missing inputs.


The jump-ownership regression executes the actual native handler and broker
forwarding branch, plus a local fake broker for the public FleetScript call.
It verifies one action, the same issuer during posture and movement, exact
preemption attribution, and the difference between yielded and live recovery.
The lift-member test covers a failed rider followed later by the final healthy
exit, not just repeated failure callbacks.

The south-queue fixture keeps separate real snapshots and timestamps.
The actual raised-lift r32c55 ledge is positive; the nearby r31c55 body is a
negative because its floor is 4736 client units lower. No reconstructed floor
or position is presented as a captured fact.

The Sentinel regression preserves an exact consumed native request and its
ordered pre-action scene. The original replay waited without emitting movement
while trying to reach an occupied anchor. Reusing the proved current boundary
stage crosses in two legal packets with every recorded blocking body retained.
The test checks their presence before every movement packet and retains wall,
prediction, other-cell and distance negatives. Snapshot NPCs are static in
this socketless reproduction; this does not certify live survival or timing.
The vital-evidence regression exercises the actual client reader with transient
post-death ceilings and refuses unsupported grant attribution.


m59-fineclimb-convoy-test.mjs executes the actual Brax child wrapper, CLI
validation and native-action branch. It requires the exact origin/cohort to
survive all three boundaries and rejects foreign or malformed metadata.
m59-return-cliff-queue-test.mjs covers the separate physical admission behavior
with all17 captured bodies/NPCs. The bounded egress planner uses the existing
goal-directed flood; m59-queued-exit-async-test.mjs verifies22 requests to the
specifically published eastern north shelf, responsive timers, and a later usable request after a deadline.

m59-farm-observation-test.mjs checks a requested target beyond twelve nearer
non-target monsters, guarded potential-idle classification, cached/unreported
position status, and missing/new-connection health samples. The recovery-heal
suite includes paid explicit spell failure coincident with an HP regeneration
tick; this must remain an unconfirmed heal.


m59-active-recovery-state-test.mjs executes the actual keeper logoff activation,
then checks native/public fine-walk protection and an interrupted-rest active
replacement using captured partial failure evidence. The surrounding full
state and resource progress are modeled and labeled. Ended and yielded intents
remain negative cases. The full24-scenario survival decision regression is
also in the movement gate; legacy busy announcements preserve survival, while
explicit protected-faculty handoffs still yield.

m59-brax-boarding-lanes-test.mjs checks real declared-lane geometry and file
claims, then executes the actual boarding block with modeled flight
acknowledgements. The next column starts after a confirmed landing and before
the first parking walk finishes; flights never overlap. The city recovery
budget test executes the actual wrapper on a modeled clock and retains the
original overall deadline. These are control/geometry regressions, not live
survival or speed measurements.

m59-brax-trial-observation-test.mjs distinguishes admitted/boarded/validated
riders, deduplicates physical group trips, rejects later arrivals outside the
completed trial window and preserves individual failures despite an aggregate
dispatch success flag. Partial arrivals never produce a full-roster p90.

The readable socket-history test checks first/last/fatal health, observed gaps
and overlapping handoffs, poison text, last living supplies, post-death health,
strong fatal-room precedence, conflicting rooms, scope/time fences and HTML
escaping. The trial timing reader derives stage intervals only from positive
matching-trip receipts. Missing stages remain missing, and every interval
percentile is explicitly an observed subset rather than a full-fleet claim.

The asynchronous platform refusal test explicitly requests the eastern north
opening at r1c62. A generic request for room578 can consider different western
openings and cannot establish access to the isolated eastern Brax component.
The test does not assert every exit from every platform pose is unreachable.


The Brax logistics gate covers captured stationary-trade readiness refusals,
concurrent accepted approaches settling before cleanup, the90%-exchange/
60%-idle-rest deadband, and enforcing the public ledge script's departure health
floor. These offline fixtures verify control flow; only native recipient gains,
actual equipped weapons and timed sampling establish successful live logistics
or farming. The owned-gear test also observes a completed weapon use through a
later protected recovery without issuing a second toggle.


`m59-delivery-cache-test.mjs` executes the native paced exact drop and the real
service/notice handlers. It checks partial stack quantities, no second packet
for a consumed token, source floors, changed save/body authority, giver-plus-ground
confirmation, durable unknown outcomes, optional broker notices, absent-recipient
continuation and surplus-only cache planning. `m59-supply-test.mjs` additionally
executes the actual missing-recipient branch and proves it sends no trade packet.
The public return regression keeps BACK on its checked path instead of adding a
generic wall-rest detour. These post-hour regressions do not retroactively validate
the frozen farming hour or constitute another native one-hour trial.

- `node tools/m59-hometowns-test.mjs`: fleet-scoped disk persistence, changed
  assignment history, failed/stale readings, unknown versus wandering, complete
  roster grouping, HTML escaping, and dashboard navigation.

## Cooperative logoff

`node tools/m59-cooperative-logoff-test.mjs` exercises socketless native
`playDead`/`Session.rejoin`, durable login waits across restarts, last-helper
admission, miss versus confirmed hit, multiple threats, stage/faculty preemption,
paced approach ownership, post-hit cleanup, immediate return before another
farming pass, ghost-position projection, stale-hint refusal and credited kills.
The cooperative suite also calls the actual native attack exchange to prove its
streamed notification precedes internal health reads and excludes chat.
`m59-combat-approach-test.mjs` exercises the real fight hit callback, verifies
streamed receipts are not repeated at cleanup, and rejects incoming damage and
misses as distraction proof.
The cooperative suite is also registered in the movement gate. Private policy
tests remain in the private repository; see `docs/m59-cooperative-logoff.md`.
`m59-recovery-refuge-test.mjs` also exercises the real peer-projected refuge
search and the native selector's same-call fallback when a prepared wall fills.
