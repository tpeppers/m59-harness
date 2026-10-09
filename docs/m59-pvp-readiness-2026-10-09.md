# PvP attack readiness, 2026-10-09

The Morpheus encounter beginning at 13:15:51Z exposed a movement veto, not a
need to aim more wand packets at the same location. The deployed code examined
was `c9a40d39`; this investigation used the durable shot/message logs without
controlling the live fleet.

## Evidence

For Bunsen's fight `24880-1791551751948-402`, room 150, the shots from
13:15:52.478Z through 13:18:06.240Z record:

| Observation | Count |
|---|---:|
| Wand apply packets | 50 |
| Server “nothing happens” refusals | 46 |
| Refusals with model LOS false | 45 |
| Refusals with model LOS true and no predicted timer/facing block | 1 |
| Server-confirmed lightning hits | 4 |

Bunsen's recorded square is r31c68 for every shot. Morpheus moves among multiple
squares; a representative refused shot targets r11c60, blocked at the staircase
edge r18c67 -> r18c66. The four accepted shots have actual “shocks” or “fries”
server replies, at 13:16:44.239Z, 13:16:46.256Z, 13:17:58.205Z and
13:18:02.223Z. The first refusal remains unexplained by the recorded model;
network timing, stale world state or another gate cannot be distinguished here.

The old telemetry labels 35 of the blocked shots `stale` and ten `los`.
Both groups have LOS false; `stale` only means the target's last position event
was older than 500ms. It does not prove the target moved or that the wall ceased
to block sight. A stationary visible target must not become unattackable merely
because it has stopped sending movement updates.

The logs are under ignored `substrate/pvp/prod/`, especially
`shots-2026-10-09.jsonl` and `messages-2026-10-09.jsonl`. They are evidence for
this encounter, not measurements of the corrected build.

The other available shot files show the same dominant problem. Counts at
inspection for named lightning wands or bare wands with decoded yellow primary
colour (these are retained telemetry, not a guarantee of full-day coverage):

| UTC file date | Shots | Refusals | Refusals with model LOS false |
|---|---:|---:|---:|
| 2026-10-07 | 707 | 691 | 686 |
| 2026-10-08 | 1400 | 1364 | 1357 |
| 2026-10-09 | 1053 | 1006 | 992 |

Across those readings, 3035 of 3061 refusals coincide with blocked model sight.
This makes establishing sight the first correction; cooldown/facing protection
also addresses separate failure paths but cannot explain the dominant volume.

Do not equate the old telemetry's `refused:false` with a successful attack.
It means the reply window contained no “nothing happens” message. Zoot's
SUPERHOTTIES episode below has one such row whose reply is actually “Only those
in guilds may attack each other here.” Likewise the old predictor applies
lightning LOS/timer rules to vampiric shock. Hit claims here require explicit
lightning damage messages, and the aggregate excludes vampiric wands.

## Earlier fights and counterfactual checks

The follow-up inventory found 114 pre-13:15:51Z sealed clips representing 60
fight IDs across 13 maps, plus 2110 earlier shot rows across 82 character fight
IDs. These sets differ because clips cover fights without wand shots, and are
retained separately. The clips pin four historical harness commits:
`05f58a2688d2`, `616d2b6b2903`, `452e58e4012f`, `b142ba584cd8`.
They are historical inputs, not regressions attributed to today's build.

I inspected representative sealed frame sequences for Animal/Optimus Prime,
Camilla/SUPERHOTTIES and Kermit/Rick Deckard, and selected the following diverse
shot positions for packet/movement counterfactuals. The tests run the corrected
CombatMode on current geometry with the recorded fine body position and a
stationary target. They do not replay opponent choices, ally movement, damage
or the server. Door execution is stubbed after verifying the real planner's
chosen trigger; the separate Castle suite checks the walking/crossing machinery.

| Earlier encounter (UTC) | Recorded behavior | Corrected static-position check |
|---|---|---|
| Zoot / SUPERHOTTIES, Oct 8 15:44:57, Castle 38 | 118 packets, 117 “nothing happens”, one guild-policy refusal; Zoot stays r8c34 | Chooses the chamber door, then two ordinary moves and a sight-valid apply. Server guild rules can still refuse it; this predicts positioning improvement, not damage. |
| Gonzo / Rick Deckard, Oct 7 20:43:32, map 102 | 29 packets, 23 refusals, six explicit lightning hits; fixed r46c31 | Takes 19 short steps from the first blocked target position before sending. Existing hits demonstrate that this opponent was attackable in the episode. |
| Kermit / Rick Deckard, Oct 8 16:17:15, map 2 | 19 packets, all refused with blocked sight; fixed r1c40 | Takes 37 short steps and establishes sight to the initial r21c3 position. The clip shows Rick later at r4c40: real pursuit must replan instead of completing this frozen-target route. |
| Pepe / Rick Deckard, Oct 8 16:18:25, map 2 | 17 packets, 12 explicit hits, five refusals; all five have LOS true and timer blocked | The actual-send shared timer suppresses those early packets. The first early attempt was 1053ms after a confirmed lightning hit; it must wait for 2000ms. |
| Lew / Optimus Prime, Oct 8 23:28:05, Castle 38 | 191 packets, all refused, fixed r8c13; target initially r13c1 | Suppresses the blocked shot, but has no safe firing approach in the current model. See limits below. |
| Zoot / SUPERHOTTIES, Oct 8 16:32:52, Ukgoth 599 | 24 packets, all refused, fixed r45c10 | Makes 30 moves, then the live-body fine route disproves the next coarse leg at r48c27. No sight-valid apply follows. |
| Zoot / Optimus Prime, Oct 8 20:26:09, Twisted Wood 578 | 20 packets, all refused, fixed r23c45 | Makes 44 moves, then stalls at r42c17 where the next coarse leg has no proven fine route. No sight-valid apply follows. |

The clips also show why a geometry-only claim would be too strong. Animal's
Castle clip retains overlapping/nearby fleet bodies and earlier
`object_blocked` movement attempts; Camilla's clip records a Hold opener,
37 wand sends, zero melee sends and a fixed r16c23 pose. The correction allows
movement despite a wand hold and checks targeted casting, but successful
multi-body pursuit and productive repeated debuffs are not established by these
static checks.

The Oct 6 19:43:52 Rick Deckard reconstruction is weaker evidence: it records five
lightning hits and three unexplained refusals, while the target disappears about
0.49s after arrival. The three refusal timestamps and cooldown inputs were not
retained. Identity/send-time checks protect against firing after disappearance;
the evidence cannot show that the correction would have improved that volley.

### Remaining edge cases

* At Castle 38's recorded r13c1 boundary target, the current directional LOS model
  finds sight only from the target's own square. Pursuit deliberately excludes
  occupying that square. It has no proven alternative firing position; this may
  be a boundary/model mismatch and needs server-verified geometry evidence.
* The Ukgoth and Twisted Wood counterfactuals expose coarse/fine disagreement
  after initial progress. Current short-leg pursuit has no persistent alternate
  route or recovery for that disagreement. The tests retain these failures
  explicitly instead of counting “stopped spamming” as successful pursuit.
* Castle upstairs (39) has wings whose known bridge leaves the room via the
  downstairs floor. Same-room door fixes handle ground floor 38; they do not
  authorize a map-confined combat order to take that bridge. No map-39 clip was
  in this earlier seal inventory.
* Guild/no-combat refusals remain server gates. The existing refusal handling
  must continue to honor them. Silence, missing costs, enemy enchantments and
  spell-specific rejection can also prevent casts even with valid positioning.
* Four earlier “nothing happens” rows have LOS true and no predicted timer block
  (Sweetums and Lew in Castle, Gonzo in map 102). Current telemetry does not
  establish their causes. Facing/current-target checks cover some possible
  races, but these rows do not prove that explanation.

## Causes and correction

The selected private wand hook returned `hold:true` for its decoded lightning
wand. The public fallback also holds while a timer wand is carried. The old
contract defined hold as suppressing both melee and approach; `advance` returned
after the volley, before reaching pursuit or `crossDoorToward`. Neither wand
selection nor the apply sender checked LOS. That explains the stationary loop
even though the harness already contained Castle chamber door handling.

The corrected harness keeps weapon/spell selection private, but enforces the
mechanics centrally. A hold reserves melee and permits pursuit during cooldowns.
Blocked sight first invokes the same-room door planner or a short movement leg.
The square router supplies long detours; the next short leg is checked from the
live fine body using the shared fine router. Collision masks, ground hazards and
known blocking objects remain respected. Door crossings are replanned one at a
time. The bot does not spend a shot, beat or cast timestamp on an unsent action.

Sight, facing, target identity and cooldown are checked again inside the paced
send callback. A moving target can invalidate the earlier turn or sight check.
The actual send starts the shared timer, so neither a wall-clock volley boundary
nor a replacement combat order can fire early. Targeted opener and sequence
casts get the same approach/facing checks. Room/self spells and vampiric shock
are exceptions because their prerequisites differ. Melee retains the existing
two-square range and the server's facing rule; imposing wand LOS on melee would
discard attacks the server permits.

The spell compiler now reads inherited `viPostCast_time`, including direct
subclass overrides: enfeeble/blind use 1s, hold uses 2s despite directly extending
Spell, and lightning uses 2s through the attack-spell hierarchy. An older
catalogue must be rebuilt for exact timing; unknown metadata reserves 2s.
The tracked catalogue ships timing metadata for all 175 compiled spells, with
its existing cost/prerequisite fields unchanged.
The shared LOS helper also checks the entire line instead of returning true
after a fixed 64-step prefix.

## Validation and limits

`m59-pvp-readiness-test.mjs` uses isolated fake sockets with real room 150 and
Castle 38 geometry. The recorded r31c68 -> r11c60 scenario makes collision-valid
progress until sight is established and a wand packet is sent. A decoded wand
holder crosses out of one Castle chamber and into another through the real
declared doors before firing. Other scenarios cover cooldown boundary races,
movement during a wand hold, target changes between turn and send, exact identity,
spell timers, room/self openers, vampiric shock and stationary targets.

These are offline geometry and packet tests. They do not measure live PvP damage
rate or guarantee server acceptance under network latency, moving targets,
imperfect geometry or server rule changes. No new live engagement was ordered
for the investigation.

The targeted combat, gear, wand telemetry, war, warband, guild refusal, PvP log,
strategy loader, desk practice and Castle chamber checks pass. The required
movement runner completed 31 suites with zero regressions (its exact known-red
baselines remain). The readiness suite subsequently expanded to 26 passing
scenarios, including three explicitly retained historical routing limits.
The separate combat-safety suite has five existing failures; the unmodified
deployed baseline reproduces the same five failures and 11 passes.
