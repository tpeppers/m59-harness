# What to fight, and what it costs

For immediate player orders, ambushes, scripted combat sequences and live ground
effects, see [Combat mode](m59-combat-mode.md). Ordinary farming rules below
continue to apply outside an explicit combat override.

Split out of [`CLAUDE.md`](../CLAUDE.md). The engagement ceiling, the spawn tables, the undead clock and the armour arithmetic.

- **THE ENGAGEMENT CEILING IS A PROPORTION NOW, IT HAS ONE HOME, AND IT USED TO HAVE FOUR.**
  `refuseEngagement` and the three other gates that decide what a character may be hit by
  all spelled `level + (maxThreatOver ?? 6)` separately — four copies of the quantity this
  repository has learned always ends up with two answers, and this is the one where the
  second answer is a dead character. They now all call `threatCeiling()`.

  **A FLAT BAND IS A DIFFERENT BET AT EACH END OF A ROSTER.** `+24` widens a 45-health
  character by 53% and an 88-health one by 27%, so one policy was reckless for the small and
  timid for the large. The default is now `{mode: 'percent', value: 150}` — max health IS
  the level here, so 150% is the same bet everywhere. `{mode: 'flat', value: 25}` is still
  available and is the right answer when a fleet is levelling past a fixed prey and wants
  the band to stop growing with it. **The mode is explicit** so the two can never silently
  disagree, and it is settable over MCP (`autopilot threat_ceiling=…`) and from a doctrine
  (`prey.threat_ceiling`).

  Two directions it deliberately fails safe. **An unknown max health returns null and every
  caller reads null as "refuse"** — a ceiling that defaults open is the one that kills
  somebody. And **an unusable setting falls back to 150%, never to "no ceiling"**.

  `max_threat_over` is still accepted, still stored, and **no longer consulted** — and the
  broker says so in its reply rather than letting it become a silent no-op, which is the
  failure [`CLAUDE.md`](../CLAUDE.md) exists to keep naming.

## Prey: what is worth fighting, and what is not

- **SOLDIERS ARE NOT SPAWNED BY ROOMS, THEY ARE SUMMONED BY FLAGPOLES — AND A NEUTRAL
  FLAGPOLE SUMMONS NOTHING.** `substrate/m59-spawns.json` lists one huntable soldier in the
  whole world (a rebel soldier in the Sewers of Jasper) and that is not an omission: troops
  have no room spawn table. `flag.kod` generates them on a timer from the flagpole object —
  `FACTION_DUKE -> &DukeTroop`, `FACTION_PRINCESS -> &PrincessTroop`, rebel likewise — and
  the function returns immediately `if piFaction = FACTION_NEUTRAL`. Troop availability is a
  property of the TERRITORY GAME, not of the map: it depends on which flagpoles players have
  claimed, and it changes without warning.

  Setting `hunt` to a soldier when none are present is therefore not a harmless miss. The
  keeper finds nothing, roams looking for it, and roams somewhere it has no business being —
  which sent Sweetums out of Ileria into the Decaying City of Brax, where six narthyl worms
  killed it, and left three others stalled on "no safe wall here and nowhere better to go".

  **The flagpoles are already under the fleet's feet.** Thirty-one rooms declare
  `viFlag_row`/`viFlag_col` and thirty are rooms this fleet already hunts in or walks
  through — 534 Deep Woods of Ileria, 544 Valley of Ileria, 562 the sandy shores, 583
  Outskirts of Barloque, 586 Main gate to Tos, 596 Outskirts of Tos, plus 535, 545, 552,
  556, 557, 576, 584, 585, 587, 593, 603 and the four town rooms. They are the paths BETWEEN
  the towns, which is where the territory game is played. Nothing needs to travel somewhere
  new to find troops; the flagpole beside it needs to be claimed.

  **All three factions match the word `soldier`** — `soldier of the Princess' army`,
  `soldier of the Duke's army`, `rebel soldier` — so one substring catches them all and
  naming a faction would miss two thirds.

  **THEY ARE NOT LEVEL 50, AND THIS ENTRY USED TO SAY THEY WERE.** It read the declared
  `viLevel = 50 / viDifficulty = 2` off `duketr.kod` and concluded they were "barely more
  dangerous than the current prey" at a rating of 270 against a fungus beast's 210. That
  is wrong, and it is wrong in the direction that sends a fleet somewhere it cannot come
  back from. `FactionTroop.Constructor` (`troop.kod:215`) calls `SetEquipment`, which
  **overwrites both numbers at the moment of creation**:

  | roll | | sets |
  |---|---|---|
  | weapon — Longsword 35%, Axe 20%, Hammer 10%, Mace 10%, ShortSword 15%, Scimitar 10% | `+1..+4` | `viDifficulty = piBaseDifficulty + bonus` |
  | armour — Leather 35%, Chain 35%, Scale 30% | `+20/+50/+75` | `viLevel = piBaseLevel + bonus` |
  | gauntlets, 19% (`if iRandomNumber < 20`) | | `viLevel +20` **and** `viDifficulty +1` |

  So a soldier is level **70–145**, difficulty **3–7**, attack rating **390–855, mean 572**
  — between a zombie (405) and a groundworm (600), and *harder than the graveyard night
  shift rather than easier*. The necromancer troop is 540–1005. **The level bonus comes
  from the armour**, so the 30% carrying the best prize are also the worst to meet.

  The death record always agreed: faction soldiers were present at 241 of the 403 attended
  deaths on disk, which is not what a rating of 270 looks like. `m59-spawns.mjs` now
  computes the range (`rolledTroopStats`, and `rolled` on the creature row); the top-level
  `level`/`difficulty`/`attack_rating` carry the **worst** case, because every consumer of
  those is a safety gate. Ask `rolled.level.min` for the floor.

  **THEY ARE ABOVE THE BAND FOR EVERY CHARACTER THIS FLEET HAS EVER HAD.** `refuseEngagement`
  refuses anything whose level exceeds `max_health + maxThreatOver` (6). The weakest possible
  soldier is level 70; the strongest character here is 50. There is no roll of the dice that
  produces a soldier a level-50 character may fight, and raising `maxThreatOver` to 95 to
  permit it would permit everything else in the world too.

  And what they carry is worth less than it looks. **`EQUIPMENT_DROP_PERCENT = 20`**
  (`troop.kod:33`), rolled per item, and what does not drop is `Delete`d — so any body
  armour is 1 kill in 5, and *leather specifically* is `0.35 × 0.20` = **7%, about fourteen
  soldiers per leather**. **The shield never drops at all**: `AND (NOT
  IsClass(oUsedItem,vcShieldClass))`, commented *"Don't drop the shield! It's a
  quest/special item!"* (`troop.kod:1043`). This entry claimed a shield on every soldier
  and that they dropped on death; both were wrong.

  **SO DO NOT FARM SOLDIERS FOR ARMOUR — THE SPIDER AND THE ORC ARE BOTH BETTER AND BOTH
  FIGHTABLE.** Every creature in the world that drops body armour, by how dangerous it is:

  | | level | rating | per kill | in the band? |
  |---|---|---|---|---|
  | **spider** | 50 | **390** | leather 2% + chain 1% per roll, ~1.5 rolls -> **~4.5%** | **yes** |
  | zombie | 55 | 405 | chain 1%/roll | no |
  | **orc** | 45 | **495** | leather 5%/roll, ~2 rolls -> **~10%** | **yes** |
  | troll | 100 | 750 | scale 3%/roll | no |
  | faction soldier | 70–145 | 572 mean | **20%** — best rate in the game | **NO, never** |

  The soldier has by far the best drop rate and is the only one on the list a character
  here may not fight. The orc beats it on leather anyway (10% against 7%) at a lower
  rating. **A fungus beast drops no armour at all**, which is why a fleet farming them can
  grind for a week and stay bare.

  Take spiders from **536 Forest of Farol** (70%, cap 12) or **556 Deep Forest of Farol**
  (55%, cap 16) — nothing in either table rates above 390. **Not 596 Outskirts of Tos**
  (groundworm, 600), **not 597 The Twisted Wood** (troll, 750), and **not 35 The Spider
  Nest**, where the queen rates 1035.

- **THE GRAVEYARD OF TOS IS OPEN THIRTY-FIVE MINUTES IN EVERY TWO HOURS, AND THE CLOCK IS
  ARITHMETIC ON THE WALL CLOCK.** `tosgrave.kod` holds
  `plMonsters = [[&Zombie, 85], [&Skeleton, 15]]` and gates creation on
  `iHour = Send(SYS,@GetHour); if iHour < 5 or iHour > 21` — outside that window
  `TryCreateMonster` returns without propagating and the room generates nothing at all. A
  fleet parked there by day is standing in an empty field.

  The hour needs no packet. `system.kod` derives it from real time and says so in its own
  comment: `iTime = GetTime() - 5*HOUR`, `iMinutes = (iTime mod (2*HOUR))/60` ("our day is 2
  hours long now"), `piHour = iMinutes/5`. A game day is TWO REAL HOURS, a game hour is FIVE
  REAL MINUTES, and the undead window is 35 real minutes in every 120.
  `BP_LIGHT_AMBIENT` (220) is pushed by the server on every light change and this client does
  not parse it; it would corroborate the clock but is not needed to compute it.
  `tools/m59-nightshift.mjs` is that arithmetic.

  **A window that short is shorter than the walk to it.** Re-tasking the fleet at the edge
  put one character in room 70 and killed zero undead; the other twenty spent the window
  walking from Ileria. The shift sets off with a lead (default 20 minutes), which costs the
  tail of the day shift and is the cheap end to spend.

  The prey is a real step up — zombie level 55 difficulty 4 (405), skeleton level 75
  difficulty 5 (525), against 210 — and worth it, because nine characters are stuck at 50
  and a level-50 fungus beast cannot advance them (the rule is STRICTLY greater). It is also
  roughly twice the incoming hit rate, so armour stops being optional.

## Danger, and what armour is worth

- **A creature's LEVEL is not how dangerous it is.** Level sets hit points and what
  the kill pays; what it hits you *with* is `viDifficulty`, via
  `GetAttackAbility = 3*viLevel + 60*viDifficulty` (`monster.kod`). A fungus beast is
  level 50 and difficulty 1, so it rates 210 — against a centipede's 390 at level 30.
  Damage is `Fuzzy(viLevel/Random(10,15))`, 3–5 against 2–3. The level-50 creature is
  the *safer* fight, and the `prey` band, which sorts on level alone, will not offer
  it. `tools/m59-supervise.mjs` documents the full arithmetic.

- **Heavy armour is worse here — BUT BARE IS WORSE THAN ALL OF IT, AND THAT IS A
  DIFFERENT QUESTION.** Each piece carries `viDefense_base` (how often you are hit) and
  `viDamage_base` (absorption). They pull opposite ways: leather is +50/0, plate is
  -200/6 with a -30 spell modifier. On a scale where a monster's whole attack rating is
  ~210, -200 is enormous — and a character fighting from a safe spot intends to be hit
  zero times, which absorption does nothing about. `wear_best` ranks on that, so it buys
  leather over plate deliberately.

  What that ranking was also doing, wrongly, was **refusing to wear anything at all**
  when the only armour in the pack scored below zero — leaving fourteen of twenty-one
  characters bare while carrying chain or scale. Bare skin is not the neutral baseline
  the score treats it as: it has no defence bonus **and** no absorption. Worked against
  this fleet (agility 45, base max health 50, block 90, so `iDefense` = 345,
  `player.kod:4320`), expected damage per fungus-beast swing is **bare 1.34, chain 1.18,
  leather 1.17, scale 0.71** — bare is last. So there is now a **floor**: with the slot
  EMPTY, the best available piece is worn provided it absorbs something, it is reported
  as `floor: true` rather than silently, and a negative piece is no longer stripped down
  to skin when nothing better exists.

  Two things the arithmetic depends on, both of which cut against absorption and are
  priced in above. It is `random(reduce/3, reduce)`, not the face value, and it is
  bounded to `damage-1` (`defmod.kod:108`) — **a blow always lands for at least 1**.

  **And the hit chance is `offense * 55 / defence` BOUNDED TO [10,95]** (`battler.kod:331`).
  That bound is why "more defence" is not always the answer: against anything that pins
  us at 95% — a faction soldier at 572 does, leather or not — extra defence buys
  *literally nothing* and absorption is the only thing still working. Against a fungus
  beast the bound does not bind and leather wins. `ABSORB_IS_WORTH` (10) was deliberately
  **not** raised, because anything over 25 flips leather-versus-scale fleet-wide as a side
  effect, and that question turns on block, on shields, and on the spell modifier the
  create-food loop runs on. See `ARMOUR` and `absorbsSomething` in `m59-skills.mjs`.

## Touch spells are the weapon — `touch_spell`

A touch spell (acid touch, touch of flame, holy touch, icy fingers, zap) is a personal
enchantment that the server swings **instead of a fist, and only while the hand is empty**:
`Player.GetWeapon` returns a wielded weapon first and consults the touch enchantment only
when there is none (`player.kod:4712-4729`). A wielded weapon does not weaken the touch, it
hides it completely. A landed touch trains the SPELL (`ImproveStroke`, `touchatk.kod:99-104`).

```bash
autopilot action=start agent=t9 mode=farm hunt="living tree" touch_spell="acid touch"
autopilot action=start agent=t9 touch_spell=null            # off
autopilot action=status agent=t9                            # touch_spell: {active, recasts, ...}
```

On the assigned room in farm mode the keeper unuses any weapon (falling back to a direct
`unuse` by the equipment list's id), vetoes every `equipBest` on the session, fights with
`equip:false`, and before each swing keeps the buff on: it casts at its own numeric object id
when the server's stop line arrived, a swing read `Your punch …`, or it has not been told
since starting. The lines it reads are the kod's (`m59-touchspell.mjs` cites each): acid touch
starts with *"The corrosive spittle of Qor's love oozes from the pores of your hand."*, stops
with *"Your hands no longer drip with acidic ooze."*, and a cast while it is on answers
*"Your hands are already dripping with acidic ooze."* at no cost. A miss names no weapon and
proves nothing. Acid touch costs 10 mana and one entroot berry and lasts one to seven and a
half minutes by spell power (`touchatk.kod:390-400`). Short of either, `blocked_reason` says
so and the character fights bare. Off the room every ordinary arming rule stands.

**When it is cast — `touch_spell_timing`.** The operator, 2026-10-02: the buff lasts a minute or
two, so cast it once the next quarry is FOUND, not in the opening round of the fight and not in
an empty room. `on_target` (the default; `null` restores it) casts the moment the farm pass has
chosen its quarry, before the approach, and before a NEW quarry recasts a buff that may lapse:
the duration is never on the wire, so the estimate is the SHORTEST buff (10 ticks of 6s = 60s),
and a recast is due when under 20s of that may be left (`M59_TOUCH_REFRESH_MARGIN_MS`) or the
start was never seen. An *already* answer to that recast settles it for the margin rather than
being asked again on every target. `before_swing` is the old behaviour. Both keep the stop-line,
punch-line and unknown-state triggers and the same rate limit; `touch_spell.timing` and
`touch_spell.last_target_check` say what was decided. `touchRefreshDue` in
`m59-touchspell.mjs` is the whole rule.

## Which quarry first — `hunt_priority`

`hunt` is a SET; `hunt_priority` is an ORDER over it, opt-in and null by default
(`tools/m59-hunt-priority.mjs`). The operator's case, 2026-10-02: Kermit farms living trees in
Faronath (537), and the Qor casters there will not kill its spiders for the karma, so he should
take a spider first whenever one is engageable.

```bash
autopilot action=start agent=t1 hunt='["spider","living tree"]' hunt_priority='["spider","living tree"]'
autopilot action=start agent=t1 hunt_priority=null            # off
```

It only REORDERS the candidate list the keeper already built — after the hunt match,
confinement, the proved-unreachable avoid set, pull cooling and the island filter — so every
gate that shaped the list, and every gate after selection (engage health, vigor floor, wall,
flee line, crowd), still applies to whatever comes first. No engageable spider, and the next
entry (then the unlisted remainder, in the usual order) wins. The foe already wounded or being
pulled stays first, because a kill pays only its damager. A name `hunt` never produces is
reported as `hunt_priority.ignored`, never acted on.

## Automatic healing wands

Farmers can opt into `heal_wand_below` (0–1 health fraction; 0 disables,
which is the default) through `autopilot`, tuning, or their loadout's `policy`.
The keeper checks between ordinary passes and combat swings. It applies one
identified **wand of healing** to itself below the threshold, with at least two
seconds between attempts. This does not override retreat, a control lease, an
inert/parked keeper, or a survival freeze.

`HealWand` restores 2–10 HP per application. `SpecialWand` starts with five charges,
but the protocol does not report the remaining count. The keeper therefore uses
LOOK: a fresh, matching “The once pristine wand is now a blackened mess.” confirms
an empty healing wand and allows dropping it, including during healthy farming
passes. Failed/missing/stale LOOK replies never authorize a drop. Unknown and
vampiric wands are neither applied nor discarded by this routine; existing saving
rules remain in force. Journal entries distinguish an application sent from healing
observed. Tests: `node tools/m59-healing-wands-test.mjs`.

The loot filter also leaves healing wands with the server's broken animation group
(3) on the ground, preventing pickup/drop loops across farmers and reconnects.


## Ordinary recovery healing and reconnect evidence

Active keeper recovery can use a known affordable heal before passive rest.
Minor heal costs three mana and one herb; the helper keeps a mana reserve and
rechecks socket, body, room, resources and recovery ownership at the actual
paced send. Healthy farmers can also heal a wounded fleetmate without requiring
the coop strategy. Ally HP comes from that character's own ready socket, with
matching game endpoint, room, body ID, name and a maximum age of five seconds.
Missing reports never become invented HP. A recycled target ID cancels the cast.
Mana paid and observed HP gain are separate measurements: a paid ally cast alone
does not prove how much health the recipient gained.

SessionEvidence starts before login and writes separate socket UUID records,
linked across reconnects and keeper handoffs. It retains bounded combat text,
health/mana/vigor, room/pose, paced action opcodes, login phases and close reasons.
Independent files prevent a late old-socket close from overwriting the new
keeper's evidence. Payloads, passwords and player speech are excluded. The
postmortem retains original event times and separate socket health baselines;
missing time is not synthesized into damage. Peer fleet sockets can preserve an
authoritative victim-specific server death notice. Multiple separate deaths in
an offline interval remain ambiguous.

The death-location helper only recovers a known non-Underworld room from a recent
fatal health push or personal death message. A last-alive room across an offline
gap is insufficient. This resolves the observed case where a zombie killed a
character in room 39 while its keeper had no decision frames: socket evidence
proved the location even though the old frame-only postmortem left it blank.

Ordinary health and mana regeneration timers can take up to 60 seconds in the
server. restUntil therefore allows 65 seconds without progress while one of
those requested resources is pending, bounded by the caller's original timeout.
Damage and cancellation still interrupt immediately. Vigor-only recovery still
reports a ceiling promptly: normal sitting restores at most 80 of 200 vigor.

Known self-healing also runs on ready health/resource events while ordinary
travel owns movement. One pending cast and a short cooldown prevent callback
races; login readiness waits for an already queued heal before resuming a road
journey. Socket, room, body, generation, resources, human control and protected
faculties are checked again at the paced send. This grants no spells or items.

Healing telemetry distinguishes unread inventories/spellbooks from known empty
ones, and records affordability, mana reserve, sent casts, mana payment,
observed HP gain and exact server success/failure feedback. The first mana
packet can precede the heal, so one bounded observation window follows later
feedback without sending another cast. Mana payment alone does not confirm
an ally heal. Critical self recovery can spend its last three mana on a known
minor heal; ordinary recovery keeps a one-mana reserve.

The native rest API accepts vigor as a fraction or an absolute value above one
on the 200 scale: 0.4 and 80 both mean the ordinary resting ceiling. Its default
and rest_up target that attainable ceiling, and native rest forwards explicit
mana targets. Health and mana remain fractions of their own maxima.

Reconnect evidence keeps login-ready, first/last health and up to eight fatal
observations outside each socket's rolling action window. The event count
dropped by that window is explicit. Killer-message and fatal-room attribution
read the preserved anchors too. This retains a login-to-death transition after
heavy action traffic; it does not infer damage or a killer during an offline
gap. Independent socket files preserve late old-keeper close observations.

Healing readiness diagnostics deduplicate unchanged resource refreshes by
functional state while retaining unread/ready distinctions. Repeated inventory
timestamps cannot crowd useful combat evidence out of the recent window.

A ready character that already knows cure poison may use its carried herbs and
elderberries through the same protected self-recovery path. Local cpoison.kod
costs10mana,2herbs and1elderberry; the selection keeps a one-mana reserve. A
successful cast can weaken the poison rather than remove it, so payment, exact
server weakening feedback and observed removal are recorded separately. No
spell, reagent or ally ailment is assumed.

Route transport failures retain bounded error names, messages, socket codes,
addresses, ports, stacks and nested causes, including the final failed read.
Arbitrary request and credential properties are excluded. A generic fetch
failure must not replace its underlying timeout or connection evidence.

Recovery healing establishes standing for the current room through the urgent
pacer before casting. Both sends recheck ownership. The pacer checks spell
concentration again when draining a queued packet: a rest or run queued before
a new cast cannot interrupt its trance, while safe reads remain available.

Cross-session evidence keeps the last structured healing result outside the
rolling event window. It retains mana payment, the server outcome, observed HP
gain and the last posture command; a command is not an authoritative posture
observation. An unpaid coincident regeneration tick is not a confirmed spell.
Ally healing contributes the same evidence, with the recipient's fresh own-socket
HP reports and timestamps. Those reports describe net observed health, not
damage or healing inferred across an offline gap. Structured fields are
whitelisted before any human-readable reason is clipped.

A fully healthy farmer with known gear, inventory and nearby matching prey may
hand a vigor-only rest back to farm work once it meets the existing effective
fighting floor (70 with an empty larder). The earlier rest gate must not demand
80 and prevent the later 70-vigor combat gate from running. Post-death recovery,
ailments, casting, wounded health, unread inventory and protected ownership
retain their recovery behavior. The farm rung still applies its full target,
weapon, food, vigor and engagement checks before attacking.

Ordinary idle keepers may provide the same observed-fleetmate healing as farmers.
The caster must still be healthy, know and afford the spell, and have no work
lease, PvP control, freeze or cast rite. The target must have a fresh matching
own-socket report, be below90% and miss at least3HP. This reaches the normal
readiness threshold without spending casts on nearly whole allies. Self-health
and send-time body, room, identity and ownership checks remain authoritative.


Resource telemetry preserves both current value and observed ceiling when
asynchronous stat pushes temporarily disagree, including around death.
An over-ceiling value alone does not establish an administrative grant.
Retain the raw sequence and report the cause as unestablished.

A full mana bar does not make an unknown or reagent-starved healing spell
available. Post-mortem readiness evidence distinguishes unread inventories,
zero herbs, unknown heals and affordable casts. Likewise, observed poison
before a disconnect and matching health on the next login do not establish
damage inside the offline gap. A later named victim-only death message can
identify the final killer while the earlier poison remains a separately
observed contributor.


Healing confirmation must respect explicit server failure even when the cast
spent mana and an ordinary regeneration tick raised HP in the same observation
window. Keep those three facts separate: mana paid, net observed HP change, and
server outcome. A failed or unnecessary cast is never a confirmed heal.

The farm observation helper retains every visible requested target, including
targets beyond the nearest twelve generic monsters. It records raw object flags,
distances, connection revision, prediction status, and the keeper's recent
combat, casting and recovery decisions. Full health, full mana, sufficient vigor
and nearby requested prey identify a sampled potential idle opportunity; they
do not prove line of sight, reachability or engagement eligibility. Report sample
counts as sample counts, not inferred idle durations. Missing socket samples and
new keeper/connection identities reset consecutive health-ceiling confirmations;
a missing first sample must not terminate the measurement.


The shared recovery predicate includes the native active state. The actual
keeper sets active before awaiting its logoff/reconnect action and can publish
that state while a previously awaited rest returns interrupted. Omitting it
misclassifies owned recovery as an ended handoff. Pending, active, approaching,
arrived, holding and recovering decisions remain protected until ended;
yield_to_controller is explicitly excluded. An announcement that an errand is
busy does not itself lease survival. A protected-faculty handoff remains
explicit.

Completed migration accounting uses the exact receipt set and the trial's end
timestamp. A later retry or another public run cannot supply an arrival for an
earlier failed run. Individual actor outcomes and positive living arrivals are
reported separately from aggregate dispatch success. Lift admissions, boarding
before launch and individual height validation are distinct observations;
duplicate raised receipts for the same group are one physical trip.

The readable death digest and death detail page expose the collected linked
socket history: each session's first and last observed HP, final combat messages,
fatal anchors, last structured healing verdict and last living reagent/spell
readiness. Within the retained evidence, the last combat messages are selected separately
from the last movement events. Older text already evicted by the bounded writer
window remains unavailable.
A post-death Underworld HP/inventory observation is displayed separately and
cannot replace fatal HP or the last living supply observation. Explicit observed
close-to-open gaps and overlapping handoffs remain distinct from unobserved
boundaries; no cross-session HP delta is presented as measured damage.
Fatal own-socket room evidence takes precedence over stale keeper frames.
Conflicting fatal rooms remain unplaced. Text from the new history is escaped
before rendering, and unrelated character evidence is refused.
The history is bounded to the retained four sessions; missing or dropped evidence
is reported rather than reconstructed. Reader changes take effect on the next
normal broker load and do not require restarting a live trial.
