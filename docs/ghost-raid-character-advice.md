# Ghost raid: character changes for the 30-minute throne-room hold

Written 2026-09-24. Advice only: nothing in this document was applied. Prod characters were read
through the broker's read-only tools (`status`, `abilities`, `inventory`, `equipment`). Kod is
`C:/code/Meridian59/kod`. Merchant data is `substrate/m59-merchants.json`.

## Summary: the top five, ranked by survival gained per shilling

The hold is lost on damage taken, not on healing given. One tusked skeleton swings about every
**2.1 s** (`monster.kod:4322-4325`: `Fuzzy(1000) + 3500 - 70*(3*6+16)`) for **7-10** (`monster.kod:1494`,
level 100 / random(10,15)). Against today's bare raider it hits about **67%** of the time, which
is about **2.7 health per second, or 160 a minute, from ONE skeleton**. A healer on minor heal
can put out about **20 health a minute** before running out of mana (see §2). So the biggest
gains come from getting hit less and taking less per hit. Better healers come second.

| # | change | who | cost | effect (typical raider, per skeleton swing) |
|---|---|---|---|---|
| 1 | **Wear a shield.** Block 78-99 is worth **zero** without one, and 20 of 21 raiders fight without one | everyone but Rowlf | ~290 sh per small round shield (Barloque smith, room 113), or free for t4 and t11, who already carry one | hit chance 67% → 57%, plus 10% slash resistance. Expected damage **5.8 → 4.3 (-25%)** |
| 2 | **Wear chain armour** on top of the shield. The skeleton's blow is SLASH, and chain takes 20% off slash | everyone | ~1,800 sh (room 113). t4 and t13 carry one already, and t17 wears one | with the shield: **5.8 → 3.0 (-48%)**. Leather would only reach 3.9, so buy chain, not leather, for this fight |
| 3 | **Cast magic shield on raiders** before the door opens (+50 + 2×spellpower defence, lasting about 7-8 min) | Camilla casts it now; Bunsen can learn it | 2,000 sh for Bunsen; 2 mushroom + 1 red mushroom per cast | on top of 1+2: **3.0 → 2.3**, a total of **-60%** against bare |
| 4 | **Heal with mysticism-50 characters**, not Pepe and Statler (mysticism 30, minor heal 5-6). Janice (t7) learns minor heal | t7 (also t8 or t5) | 500 sh each, plus about 2 h of training each | cast success about **41% → 58%** on day one, and **~73%** at ability 60 |
| 5 | **Test holy symbol** on the shadow fleet. Skeletons are undead and flee from whoever turns them. The turn roll for a 65-health raider with 70 karma is **93-98%**, and a turn lasts **90 s** | any raider with karma ≥10 | 500 sh; 8 mana + 3 elderberry per cast | possibly the largest single change, but **unmeasured**. Rehearse before buying 20 of them |

**Do not buy parry first.** It costs 4,000. It arrives at ability ~1 and is worth +2 defence per
point (`player.kod:4320`). It trains only on a blow that misses, and only 30% of those go to parry
(`player.kod:7862-7871`). Pepe and Robin, who own it, sit at 11-12, which is worth +22-24 defence.
A 290-shilling shield is worth +90 to +104 defence on the first day.

## Per-character table

Columns: dodge/block/parry and hammer wielding are skill abilities (%). MH is minor heal ability.
"Hit" is the tusked skeleton's current chance to hit, and the next four columns are expected
damage per skeleton swing: bare / +small round shield / +shield+chain / +shield+chain+magic shield
(at spellpower ~60). Pack room is the free weight/bulk (a shield is 100/125 and chain is 200/250,
`substrate/m59-items.json`).

| agent | character | max hp | karma | dodge/block/parry | hammer | MH | hit | bare | +shield | +chain | +mshield | pack room w/b | recommended |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1 | Kermit | 65 | 70 | 99/85/- | 61 | - | 68% | 5.8 | 4.3 | 3.0 | 2.3 | 722/1050 | shield + chain; eligible for parry (not first) |
| t2 | Pepe | 75 | 70 | 99/96/11 | 75 | 5 | 66% | 5.6 | 4.1 | 2.8 | 2.2 | 146/480 | shield + chain (**shed pack weight first**); stop being a primary healer, or train MH |
| t3 | Statler | 72 | 70 | 99/94/- | 75 | 6 | 67% | 5.7 | 4.2 | 2.9 | 2.2 | 1543/1559 | shield + chain; same as Pepe on healing |
| t4 | Waldorf | 65 | 70 | 99/99/- | 75 | - | 68% | 5.8 | 4.2 | 2.9 | 2.3 | 183/228 | **already carries a gold round shield and chain, unworn: wear them (free)** |
| t5 | Bunsen | 74 | 70 | 99/90/- | 75 | - | 69% | 5.8 | 4.3 | 3.0 | 2.3 | 485/123 | shield + chain (bulk tight); **learn magic shield (eligible, 129/122)**; minor-heal candidate (myst 50) |
| t6 | Beaker | 50 | 0 | 99/27/- | 50 | - | 74% | 6.3 | 5.1 | 3.6 | 2.6 | 1562/1111 | shield + chain; block is only 27, so the shield gains least here; karma 0 bars all Shal'ille |
| t7 | Janice | 63 | 70 | 99/86/- | 65 | - | 71% | 6.0 | 4.5 | 3.1 | 2.4 | 1469/1499 | shield + chain; **learn minor heal and become a healer** (myst 50, int 45, 33 mana) |
| t8 | Robin | 63 | 70 | 99/91/12 | 62 | - | 71% | 6.0 | 4.4 | 3.1 | 2.3 | 254/370 | shield + chain (tight); minor-heal candidate (myst 50, 41 mana) |
| t9 | Camilla | 60 | 77 | 99/99/- | 59 | - | 72% | 6.1 | 4.4 | 3.0 | 2.3 | 1750/1798 | shield + chain; **the magic shield caster (51%, 65 mana)** |
| t10 | Animal | 61 | 70 | 99/99/- | 16 | - | 64% | 5.4 | 4.0 | 2.7 | 2.2 | 178/396 | shield + chain; hammer wielding only 16 |
| t11 | Sweetums | 68 | 70 | 99/95/- | 41 | - | 63% | 5.3 | 4.0 | 2.7 | 2.1 | 2056/1955 | **carries a knight's shield, unworn: wear it**; chain |
| t12 | Fozzie | 57 | 69 | 98/92/- | none | - | 65% | 5.5 | 4.1 | 2.8 | 2.2 | 985/1167 | shield + chain; can learn hammer wielding (205/199) |
| t13 | Rowlf | 50 | 28 | 99/95/- | none | - | 66%* | 5.6* | — | 2.8 | 2.2 | 1127/415 | *already wears a knight's shield; **carries chain, unworn: wear it** |
| t14 | Piggy | 59 | 70 | 99/88/- | none | - | 64% | 5.5 | 4.1 | 2.8 | 2.2 | 181/573 | shield + chain (shed weight) |
| t15 | Clifford | 51 | 68 | 98/97/- | none | - | 66% | 5.6 | 4.1 | 2.8 | 2.2 | 2124/2115 | shield + chain; can learn hammer wielding (211/199) |
| t16 | Floyd | 55 | 67 | 98/99/- | none | - | 65% | 5.5 | 4.1 | 2.8 | 2.2 | 68/557 | shield + chain (**must shed weight**) |
| t17 | Zoot | 65 | 70 | 99/99/- | 42 | - | 63%† | 5.4† | — | 2.7 | 2.1 | 54/5 | †already wears chain; add a shield (**pack is full**) |
| t18 | Gonzo | 70 | 70 | 99/88/- | 37 | - | 65% | 5.5 | 4.1 | 2.8 | 2.2 | 158/442 | shield + chain (shed weight) |
| t19 | Rizzo | 74 | 70 | 99/96/- | 67 | - | 64% | 5.4 | 4.0 | 2.8 | 2.2 | 1365/1466 | shield + chain |
| t20 | Lew | 50 | -1 | 99/78/- | 34 | - | 68% | 5.8 | 4.4 | 3.0 | 2.3 | 998/445 | shield + chain; karma -1 bars Shal'ille |
| t21 | Scooter | 75 | 70 | 99/90/- | 69 | - | 64% | 5.4 | 4.0 | 2.8 | 2.2 | 688/245 | shield + chain (bulk tight) |
| hk1 | Loial | 20 | 64 | — | — | 59 | — | — | — | — | — | 1289/1155 | carries scale armour and a gold round shield, both unworn; he stays out of room 40 anyway. Keep him on minor heal in room 38; see §2 on major heal |

Raiders read 50-75 max health on prod today. That is higher than the 45-61 in the shadow copy the
rehearsals ran on, so prod starts somewhat better off.

## 1. Defence skills: parry, block, dodge

**The formula** (`player.kod:4294-4334`):

    defence = parry*2 + block + dodge*3 + agility*4 + base_max_health*3/2   (then modifiers, bound 1..1000)
    chance to be hit = offense * 55 / defence, bound 10..95                  (battler.kod:19, :329-333)

The tusked skeleton has offense 3×100 + 60×6 = **660** (`monster.kod:1440`; level 100, difficulty 6,
`skel/tuskskel.kod:45-49`) and attacks with **SLASH** (`tuskskel.kod:46`). Each term:

- **Dodge** (`skill/dodge.kod`, weaponcraft level 2, taught by Rook for 1,000). It works unless you are held
  (`PFLAG_NO_MOVE`, `dodge.kod:52`). **Everyone is already at 98-99, so it is maxed.**
- **Block** (`skill/block.kod`, weaponcraft level 1, 500 from Jonas D'Accor, room 371). It counts **only while
  a shield is in use**: `GetBlockAbility` returns 0 with no shield (`player.kod:4372-4378`). With a shield it is
  `bound(block + shield bonus, 1, 120)` (`defmod/shield.kod:63`). A shield also gives a damage reduction
  on a successful block roll (`shield.kod:73-88`) and its own resistances. **20 of 21 raiders have block
  78-99 and hold no shield, so the fleet has already paid for about +90 defence each and is not collecting it.**
  Block also trains only while a shield is held (`player.kod:7874-7880`).
- **Parry** (`skill/parry.kod`, weaponcraft level 4). Rook, **The Weapon Master's Abode, room 154** (Cor Noth),
  **4,000** (`towns/crnthtwn/cnsarge.kod:64-66`; skill prices are `250*2^level` and have no markup,
  `monster.kod:4880-4905`). It needs a weapon in hand (`player.kod:4360-4366`) and pays 2 defence per
  point. It improves only when an enemy blow misses (`PFLAG_DODGED`), and then 30% of the time
  (`player.kod:7862-7871`, `viChance_to_Increase = 20`). Gate: the best three weaponcraft level-3 skills must
  sum to the need computed in `player.kod:10588-10920`. Computed per character (have/need):
  **eligible now: t1 Kermit (191/157), t3 Statler (189/164), t5 Bunsen (160/122), t7 Janice (149/115)**.
  Close: t18 Gonzo 187/199, t19 Rizzo 183/199, t9 Camilla 142/150, t4 Waldorf 141/157. The rest are far off.
  t2 and t8 already have it.
- **Agility ×4 and max health ×1.5** cannot be bought quickly.

**Shields** (`defmod/shield/*.kod`). Bonus is the block bonus; "absorb" is `random(max/3, max)` on a
successful block roll (`defmod.kod:100-112`):

| shield | block bonus | absorb | resistances | value | where |
|---|---|---|---|---|---|
| small round shield (`metlshld.kod`) | +5 | 0-1 | **slash 10** | 160 | Barloque smith 113, Hazar 1003/1013, Marion 201, Kocatan 2101, Izzio (wanders) |
| gold round shield (`goldshld.kod`) | +10 | 0-1 | **slash/bludgeon/thrust 10** | 500 | Kocatan 2003, Jasper 374 |
| knight's shield (`knhtshld.kod`) | +15 | 0-2 | pierce 10, **spells -20** (you take more spell damage) | 800 | not sold; t11 and t13 carry them |
| orc shield (`orcshld.kod`) | +20 | 0-2 | — | 1000 | needs karma ≤ -50, so not for this fleet |

Against a slash-only enemy, the round shields' slash 10 is worth more than the knight's shield's
extra +5 to +10 block. On the Barloque blacksmith (`MERCHANT_EXPENSIVE` = 4, `bqSmith.kod:41`) an item
costs `value × (100 + 20×4)/100` (`monster.kod:4899`): about **288** for a small round shield and
**1,800** for chain, before the faction price bonus.

## 2. Healing

**Minor heal** (`spell/heal.kod`, Shal'ille level 1, 3 mana + 1 herb, 600 ms cast):

    heal = random(1,5) + (spellpower+1)/20 + target_karma/20, bound 1..10   (heal.kod:105-106)
         + random(2,5) if the target is NOT pkill-enabled                    (heal.kod:109-112)

With targets at karma ~70 that is 4-8 at low ability and 7-10 at high. **Raising the ability does
little for the amount healed.** What it raises is the **chance the cast lands**:

    success = (100 - mysticism) * spellpower/100 + mysticism, bound 5..95   (spell.kod:1193-1215)
    spellpower = ability/2 + room bonus + |karma|/10 + forces_of_light/10 + ...   (spell.kod:2066-2240)

Mysticism is the requisite for Shal'ille (`spell.kod:392-399`), so the **mysticism** of the healer
matters more than anything else. Estimates, with forces of light lit and karma 70:

| healer | myst | MH ability | est. success | notes |
|---|---|---|---|---|
| Pepe t2, Statler t3 | 30 | 5 / 6 | ~41% | matches the ~30-40% landing seen in the rehearsals. Soft cap at 59 (`spell.kod:1749`: ability > 2×myst-1 → /4) |
| a fresh myst-50 learner (t5, t7, t8, t9) | 50 | ~1 | ~58% | soft cap at 99 |
| same, trained to 60 | 50 | 60 | ~73% | |
| Loial hk1 | 50 | 59 | ~72% | cannot stand in room 40 (20 health) |

**Throughput is mana-bound, and it is small.** Mana returns one point every
`(150000 + (25-myst)*1000) * 200/vigor / max_mana` ms (`player.kod:5645-5663`). That comes to about
8-12 mana a minute for a 27-33 mana healer at vigor 150, and about 23 a minute for Loial. So a raider-healer
lands roughly **20 health a minute** once its opening pool (9-11 casts) is spent. That is one eighth of one
skeleton's damage. This is why §1 and §3 come first.

**Training minor heal.** Each cast rolls to improve twice (`spell.kod:1604-1700`):
`20 × (1 + int/100)` and then about `60 + myst - 10 - learn points outside the school`. It is capped at
**10 improvements per 15-22 minutes**, and a room change refunds 2 (`player.kod:7647`; see memory note
spell-advancement-two-gates). A cast on a full-health target is refused before it costs anything, and teaches
nothing (`heal.kod:88-94`). So training needs a wounded body. `tools/m59-shalille-train.mjs` does exactly that
with an Amulet of Shadows, in SOLO mode (the caster hurts and heals himself). It measured hospice at +9 an hour.
Estimates:

- Janice (t7), fresh, to ~60: about 16% improvement per attempt, about 360 attempts. The advancement cap binds,
  so it takes **about 2 h**, about 200 herbs, and 500 sh to learn.
- Pepe/Statler, 5 → 59: about 7-8% per attempt, about 700 attempts. Mana binds, so it takes **about 3 h** each.
  Past 59 it slows to a quarter. **Better to add a myst-50 healer than to train these two.**
- Shal'ille level 1 needs **karma ≥ 10** (`spell.kod:482-496`). Beaker (t6, karma 0) and Lew (t20, karma -1)
  cannot learn it or cast it.

**Better Shal'ille heals.** Major heal (`majheal.kod`, level 5, 20 mana + 5 herbs) heals
`random(7,13) + sp/5 + target_karma/5`, bound 0..50 (`majheal.kod:100-101`). That is about 25 per landed cast.
Only **Loial** qualifies. He already knows a level-5 Shal'ille spell (reveal), and knowing any spell at the
target level passes the gate (`player.kod:10620-10633`); karma 64 ≥ 50. It costs **8,000 at Priestess Xiana,
room 48**, and needs the Shal'ille disciple quest (`temples.kod:52-73`,
`C:/code/m59-research/reports/disciple-quests.md`). I did not verify that Loial is a disciple. The report's free
test is to say the spell's name to Xiana. **But per mana it heals about 0.7 per point against minor heal's
~1.7.** It only helps when cast time, not mana, is the limit. **Not recommended at this price.**
Hospice (level 3, which Loial has at 89) is the existing middle option.

## 3. Armour and buffs

**Body armour** (`defmod/armor/*.kod`). Defence is added straight to the defence total (`defmod.kod:95-98`).
Resistances of the SAME type add together (`battler.kod:268-290`); across types, only the largest applies
(`battler.kod:189-249`). The skeleton does SLASH:

| armour | defence | absorb | slash resist | expected dmg/swing with a small round shield (typical raider) |
|---|---|---|---|---|
| none | 0 | 0 | 10 (shield) | 4.3 |
| leather (`leather.kod`) | +50 | 0 | 10 (its 5 "all" loses to the shield's 10) | ~3.9 |
| **chain (`chain.kod`)** | -50 | 0-2 | **30** (20 + shield 10) | **~3.0** |
| scale (`scale.kod`) | -100 | 1-4 | 10 (its resist is bludgeon) | ~3.4 |
| plate (`plate.kod`) | -200 | 2-6 | 10 | ~2.9, but not sold nearby and -30 spell modifier |

`docs/m59-combat.md` says leather beats chain. That holds against weak monsters, and is also what
`wear_best` assumes (`m59-skills.mjs` ARMOUR). **Against this one enemy, chain wins, because the blow is slash.**
If a character carries both, the keeper's `wearArmourIfNeeded` (`m59-autopilot.mjs:3308`) will prefer
leather. So carry chain only. A helm (Izzio sells "helm": +20 defence, absorb 0-1, `simphelm.kod:45-46`) is a
small extra.

**Buffs** (`node tools/m59-buffs.mjs`; kod in `spell/persench/`):

- **magic shield** (Kraanan level 3, 9 mana, 2 mushroom + 1 red mushroom, `mshield.kod`). Adds `50 + 2×spellpower`
  defence (`mshield.kod:104-110`) and lasts `1 + (sp+5)/10` minutes (`mshield.kod:67-76`). It can be cast on
  others (`persench.kod:51`). Kraanan spellpower gets +1 per object in the room (max 30) and up to +10 for full
  health (`spell.kod` Kraanan branch), so Camilla (51) lands about **sp 55-65 → +160-180 defence, 7-8 minutes**,
  with about 80% success (the requisite is stamina 50). She holds **65 mana, or about 7 casts per pool**. So she
  can cover about 7 raiders before the door, and cannot keep 20 covered for 30 minutes. **Bunsen (t5) is eligible
  to buy it (129/122) from Fehr'loi Qan, The Royal Blacksmith of Barloque (room 113), for 2,000.** That seller is
  not a temple, so there is no disciple gate (`bqSmith.kod:57-64`). Give the first casts to the lowest-health
  raiders (Beaker, Rowlf, Lew, Clifford).
- **armor of Gort** (level 5, absorbs random(0, sp/25), `gort.kod:87-114`): nobody can learn it. Camilla's
  level-4 set sums to 58 against a need of ~150.
- **bless / super strength**: offence, already in the raid.
- **dazzle** (Loial has it at 15%): one target, 3-15 s (`Dazzle.kod:152,179-192`). Not worth the emerald.
- **holy symbol** (Shal'ille level 1, 8 mana, 3 elderberry, `holysymb.kod`). Every undead in the room rolls
  `sp*3/4 + (caster_max_health - monster_level/2) + (caster_karma - monster_karma)`, minus 5 if it already has a
  target, bound 2..98 (`holysymb.kod:87-96`). A tusked skeleton is undead (`skel.kod:211`) with karma -70
  (`tuskskel.kod:50`). A 65-health, karma-70 raider therefore rolls about 93-98% **even at ability 0**. A
  turned monster flees **the caster** (`monster.kod:5362-5370`, `brain.kod:424-431, 484-494`) for
  `TURN_TIME/difficulty` = 540 s / 6 = **90 s** (`monster.kod:19, 5768-5776`). Two caveats, both unmeasured: it
  protects only the caster, and skeletons are `AI_FIGHT_SWITCHALOT`, so a turned one may switch to a fleetmate.
  A roll that misses by more than 25 makes the monster hunt the caster (`holysymb.kod:105-110`). Loial knows it
  (23%). The spell success chance for low-mysticism raiders (15-20) is only about 30%.
  `practice-shalille` lists it as a FREE loop.

## 4. Other findings

- **Unworn gear already in packs:** t4 has a gold round shield and chain armour; t11 has a knight's shield; t13 has
  chain armour; Loial has scale armour and a gold round shield. The autopilot is supposed to wear carried armour
  (`m59-autopilot.mjs:3298-3325`). That it has not may mean the item is broken ("You can't use the gold round
  shield--it's broken", `m59-skills.mjs:1030`) or that the read is stale. **Check with `look` before buying
  replacements.**
- **Hammer proficiency.** Offence is `slash*3 + proficiency*2 + aim*4 + max_health*3/2` (`player.kod:4244-4254`),
  against the skeleton's defence of 660. t12-t16 have no hammer wielding at all, and t10 has 16, so with a hammer
  their offence is about 360-400, or **~30% to hit**, against ~45% for Kermit. t12 and t15 can learn hammer
  wielding (Rook, 154, 2,000). t13, t14 and t16 fall just short of the gate (187-196/199-225). A new skill starts
  near 1, so this pays off only over many fights. Hammer is the proficiency the weapon asks for
  (`weapon/hammer.kod:38`, `profic/profhamr.kod:19`).
- **Karma** is 64-77 everywhere except Rowlf (28), Beaker (0) and Lew (-1). It affects heal size (target karma/20),
  Shal'ille spellpower (caster karma/10) and holy symbol.
- **Learning costs a little elsewhere.** Every new school level adds "learn points". Those lower improvement chances
  in other schools (`spell.kod:1720-1722`) and raise every later gate (`player.kod:10834-10838`). Parry moves
  weaponcraft 3 → 4 (+2 points). Minor heal adds Shal'ille 1 (+1 point).

## How to carry each change out

All of these go through FleetScript (CLAUDE.md, "ANY ORDER YOU GIVE THE FLEET GOES THROUGH FLEETSCRIPT").

| change | tool | cost | time |
|---|---|---|---|
| wear what is already carried | the keeper does it on its own pass (`wearArmourIfNeeded`), or the broker's `wear_best` tool | 0 | minutes |
| buy shields and chain | a FleetScript `shop` step (`m59-fleetscript.mjs:1276`) at Fehr'loi Qan, room 113; or `node tools/m59-outfit.mjs --agents ... --dry-run` first. Its gear half was not re-verified after the 2026-09-07 breakage (see `learn-skill.mjs` header). **Shed weight first**: t2, t4, t5, t8, t10, t14, t16, t17, t18, t21 lack room for 300 weight / 375 bulk | ~290 + ~1,800 per raider, ~42k for the whole fleet | one town trip |
| learn minor heal (t7, optionally t8/t5) | `learn-skill agents=t7 skill="minor heal" teacher="Priestess Xiana" teacherRoom=48 price=500 home=39` | 500 each | round trip |
| train minor heal | `node tools/m59-shalille-train.mjs --healer t7 --room <inn>` (solo; needs an Amulet of Shadows and herbs) | ~200 herbs | ~2 h per character |
| learn magic shield (t5) | `learn-skill agents=t5 skill="magic shield" teacher="Fehr'loi Qan" teacherRoom=113 price=2000 home=39` | 2,000 | round trip |
| cast magic shield on others before the hold | **needs a code change.** `raid-prep` casts on the caster only (`m59-ghostraid.mjs:286`). Add it beside `STRENGTH` in `m59-ghostraid-lib.mjs`, using `buddyAssignments`. The REPL also splits `buffs=` on spaces (`raid-prep.mjs` params comment) | 2 mushroom + 1 red mushroom per cast | — |
| holy symbol trial | shadow fleet first. `learn-skill ... skill="holy symbol" teacher="Priestess Xiana" teacherRoom=48 price=500`; practice with `practice-shalille` (a FREE loop) | 500 + 3 elderberry per cast | one rehearsal |
| parry (low priority) | `learn-skill ... skill=parry teacher=Rook teacherRoom=154 price=4000` for t1, t3, t5, t7 | 4,000 each | round trip; trains only in combat |
| hammer wielding (t12, t15) | `learn-skill ... skill="hammer wielding" teacher=Rook teacherRoom=154 price=2000` | 2,000 each | round trip |

Shillings on hand (pack only; bank balances not read) range from 0 (t16) to 6,937 (t21). Loial holds 11,869.

## What I could not verify

- **Equipment on keeper-backed characters is rebuilt from names** (CLAUDE.md, "SOME IDS ARE NOT IDS"). So
  "carried but unworn" and broken-ness need an in-game look. `abilities` also warned "the server sent 0 ability
  slot(s) … numbers may be mislabelled" on every read.
- The learn-gate numbers use kod defaults: `piMaxLearnPoints = 16` (`settings.kod:71`) and the reported intellect
  taken as raw. If prod's settings differ, the have/need numbers shift. Borderline cases (Bunsen's magic shield,
  129/122) may fail; a failure shows as silence, with the item missing from the shop list.
- Shop prices ignore the faction price bonus (`monster.kod:4900`). Stock at Fehr'loi Qan was not checked live.
  `m59-learnskill-test.mjs` names Rook at room 106 while `m59-merchants.json` and `m59-factions.mjs` say 154.
- The Shal'ille room bonus for rooms 38/40, whether prod characters are pkill-enabled (+2-5 on minor heal), and
  the exact damage and hit numbers are kod arithmetic, not measurements. Expected damage assumes average skeleton
  damage 8.5 and a ~50% block roll for the shield's absorb.
- Holy symbol's effect on a crowded fight (the SWITCHALOT target switching) is unmeasured. So is whether Loial is
  a Shal'ille disciple.
- Skeleton swing interval (~2.1 s) is from `GetAttackTime`. The fuzz on the 1000 ms term was not measured.
