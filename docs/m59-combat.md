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
