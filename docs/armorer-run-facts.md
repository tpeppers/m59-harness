# Armorer run — facts (read-only research, 2026-09-24)

Errand under study: two armorers in Castle Victoria (2 / 38) collect the raiders' shillings, drink
the Chalice (Rescue -> guild hall), shed pack, buy hammers / leather / chain / small round shields,
walk back to 2 and hand out. Must run identically on prod and on a fresh shadow clone, no DM.
Live numbers are from the prod broker (8901) and shadow broker (8971) at ~13:30 local, read-only tools only.

## 1. Chalice

- **Use:** an ordinary item *apply* (use) on yourself. Item name on the wire is `Chalice of the Rain`
  (`m59-chalice.mjs` `CHALICE.match = /chalice/i`, weight 20 / bulk 20). `NewApplied` spends one sip, then
  casts Rescue at power 1 **on `apply_on`** (`kod/object/item/passitem/chalice.kod:189-208`). No spell, mana
  or reagents needed. Refusals: attacked a *player* within `TeleportAttackDelaySec` (10 min) and
  `PFLAG_NO_FIGHT` (resting sets it, so stand first) (`chalice.kod:164-186`). A second sip while a
  Rescue is pending wastes the sip (see `m59-research/reports/chalice-of-the-rain.md`). The delay is 15-25 s.
- **Where Rescue lands** (`kod/object/passive/spell/rescue.kod:113-167`, `DoRescue`):
  1. the drinker's **guild hall**, if it exists, is not the current room, and is in the same region.
     Room 2 and every mainland hall return `RID_DEFAULT`, so a Second Swines member drinking in room 2
     lands in **714, The Bookmaker's Guild House** (Barloque).
  2. the Ko'catan inn if in Ko'catan / Pool of Vigor. 3. the Pool of Vigor if in the orc caves.
  4. **Otherwise it runs `AdminGoToSafety`** (`user.kod:7076-7107`), which goes to `piHomeroom`. Nothing
     in kod sets that for an ordinary player except Cor Noth university (`Coruniv.kod:484`). If it is unset
     or not a hometown, `SetRandomHomeroom` (`user.kod:7000-7023`) picks **Marion inn 202 (30%), Cor Noth
     inn 153 (40%), or Jasper inn 370 (30%)**, and that choice then sticks. **So a guildless drinker lands in
     one of three inns, one per character, and not in Barloque.**
- **Guild membership (prod):** "The Second Swines". The memory note (2026-09-11) says all 21 `t*` are in:
  Gonzo t18 is master, Fozzie t12 is lieutenant, the rest are lords. The hall is 714. Rent is in credit
  (`substrate/storage/rent.json`: +27,698, observed today, asked by Gonzo). `guild-defense/guild-observed.json`
  (2026-09-15) lists 20 names and not Sweetums. That is probably the observer's own row omitted, but it is
  **unverified**. Run `guild action=status` on the chosen armorers before relying on the hall. **hk1/hk2
  can never join** (20 max hp < 30, `invitat.kod:174`). So **the drinkers must be `t*` characters, never Loial**.
- **Who holds it:** prod **hk1 "Loial the Ogier", room 2**, with `Chalice of the Rain x1` in his pack
  (fleet row, live). Config: `substrate/strategies/chalice-farming.mjs` (private) sets holder = Loial,
  alternate = Rizzo (t19), station_room 2, post_room 2 and fol_room 38. `CHALICE_DEFAULTS.enabled=false`
  and `holder=null` (`origin/main:tools/m59-chalice.mjs:78-150`). The strategy switches it on. Its duty file
  `substrate/.chalice/prod/state.json` has `duty.with = "Loial the Ogier"` and `lost:false`. It currently only
  shows `fol` tickets. The strategy notes that **no chalice ride had completed as of 2026-09-24**.
- **Two drinkers in a row: yes, indefinitely, in room 2.** Refill happens in `ReqNewOwner` when the **room**
  becomes the owner (the drop) and the room's `GetShalilleBonus() > 20` (`chalice.kod:103-115`). Room 2 is
  MOUNTAIN/FOREST (`castle1c.kod:30`), so each drop refills to the maximum (3-5, rolled at creation). The
  sequence is: A drinks, A drops (refills), B picks up, B drinks, B drops (refills), Loial picks up. The last
  sip deletes the cup (`chalice.kod:200-204`), but a refill before every drink means the cup never reaches it.
  Dropping while your own Rescue is pending does not cancel it. A pick-up is refused only if the picker
  already holds a full chalice with at least as many charges (`:86-99`). The cup cannot go in a vault or a
  guild chest.

**Bottom line:** a guilded `t*` drinking in room 2 lands in 714 (Barloque). A guildless drinker lands in a
random inn (202 / 153 / 370). Loial holds prod's only cup, and it serves any number of drinkers if each one
drops it in room 2.

## 2. Guild hall 714 and the roads

- 714 "The Bookmaker's Guild House" has a single exit, to `RID_BAR_NORTH` = **101 North Barloque**
  (`ghall/guildh14.kod:259-262`). **It is in Barloque.**
- BFS over `substrate/m59-map.json` (unlocked edge and go exits) is below. The median and p90 come from `travel_estimate`:

| leg | hops | route | median / p90 |
|---|---|---|---|
| 714 -> 113 smith | 3 | 714 > 101 > 102 > 113 | 33 s / 75 s |
| 113 -> 714 | 3 | reverse | 26 s / 35 s |
| 113 -> 2 | 11 | 113 > 102 > 593 > 583 > 584 Flatlands > 585 > 586 Tos gate > 587 > 597 > 598 Cragged > **599 Ukgoth** > 2 | **4.0 min / 10.4 min** |
| 714 -> 2 | 12 | 714 > 101 > then as above | 4.4 min / 11.4 min |
| 714 -> 374 Jasper smith | 11-13 | via 108 sewers, 562, 552, 544, 545, 556, 557, 382, 350 | 3.4 min / 11 min |
| 374 -> 2 | 7-10 | 350 > 568 > 578 > 579 > 589 > **599** > 2 | 4.7 min / 15.4 min |
| 714 -> 201 Marion smith | 9-11 | 101 > 108 > 562 > 552 > 544 > 545 > 535 > 200 > 201 | 2.4 min / 6.2 min |

- **Every walk into Castle Victoria crosses 599.** Room 2's only edge exit is west to 599. `goExits` only
  lead into 38. BFS with 599 removed finds **NO PATH** from any shop to room 2. So 599 is a cut vertex
  (memory: tos-is-the-short-road…). 599 is no longer in `KNOWN_TRAPS` (removed 2026-09-12,
  `origin/main:tools/m59-fleetscript.mjs:708-720`). It is still the deadliest room: Guardian of Zjiria =
  StoneTroll lv120, 180 of 182 deaths were in 599 (memory). The return walk also crosses the Flatlands (584)
  and 598 Cragged. A death drops the whole pack of freshly bought gear.
- The shop legs from 714 stay inside Barloque. They are 3 hops, all city.

**Bottom line:** the hall is in Barloque, 3 city hops from the smith (113). The only way back to room 2 is 11
hops through the Flatlands, Cragged and Ukgoth 599. That leg takes about 4 min median and 10 min p90, and
it is where a loaded armorer can lose everything.

## 3. Shops

Price = `GetInitValue * (100 + 20*markup)/100 * faction` (`monster.kod:4880-4904`). The faction factor is 100
unless the buyer is Princess faction (`util/parlia.kod:1144-1175`), and the fleet reads `neutral`. Markups are
in `blakston.khd:1370-1374`: bargain 1, discount 2, normal 3, expensive 4, ripoff 5. Base values are in §4.

| room | NPC | markup | hammer | leather | chain | small round shield | other |
|---|---|---|---|---|---|---|---|
| **113 Barloque** (Royal Blacksmith) | Fehr'loi Qan (`bqSmith.kod:41,59-62`) | expensive x1.8 | **810** | — | **1,800** | **288** | axe; teaches magic shield |
| **374 Jasper** (Quintor's Smithy) | Quintor (`jssmith.kod:36,115-121`) | bargain x1.2 | **540** | **480** | — | — | gold round shield 600, scale 1,800, mace, short sword |
| **201 Marion** (Ye Olde Slasher) | Colhorr (`MrSmith.kod:36,75`) | normal x1.6 | — | 640 | — | 256 | mace, short sword, axe |
| 154 Cor Noth | Rook (`cnsarge.kod:33`) | ripoff x2.0 | — | 800 | — | — | |
| wanders (last seen 593) | Izzio (`izzio.kod:51-54`) | discount x1.4 | 630 | 560 | — | 224 | **finite stock, max 25 items** |
| 2003 / 2101 Ko'catan, 1003/1013 Hazar | — | — | off-continent / guest servers | | | | |

- The Tos smithy (room 51) has **no smith placed**. `TosBlacksmith` is defined, but `tossmith.kod` creates
  only ornaments, and `m59-merchants.json` shows `room: null`.
- **Finite stock:** only **Izzio** and the Ko'catan shopkeeper have `vbSellFromInventory = TRUE`
  (`docs/m59-economy.md:374-399`). The three smiths build their list on demand and cannot run out.
- The `merchants` tool matches **class names** (`Hammer`, `ChainArmor`, `MetalShield`, `LeatherArmor`). A
  search for "chain armor" or "small round shield" returns **no matches**, so search `chain`, `leather`
  or `MetalShield`.
- Nearest to 714: **113** (3 hops). Nearest to room 2 by hops: 374 Jasper (7), then 113 (11). Marion 201
  back to 2 has no path in the unlocked graph (the 200 to 2 estimate is 13 hops, 5.6 min median / 27 min p90).
  **Leather is not sold in Barloque at all.** The nearest leather is Marion 201 (9 hops from 714) or Jasper 374.
- **Selling:** it is an allowlist (`tools/m59-skills.mjs:3254-3276` `SELL_TO`). In Barloque, **113 Fehr'loi
  Qan** buys wearables, weapons and misc at 60% of value (`bqSmith.kod:48-54`; `monster.kod:3137`).
  **109 Herbutte** buys gems, **104 Joguer** buys mushrooms, herbs and elderberry, and Quintor 374 buys too.
  **Never** sell to the bankers Skivlat, Yevitan, Setag or Huital, or to the vaults (Barloque 114). They take
  the goods and pay nothing (`NEVER_SELL_TO`; `docs/m59-economy.md:7-40`). Roq buys anything but sits behind
  room 110, which is `banned_destinations` on prod.
- **Free stock in 714 itself** (`substrate/storage/chests/*.json`, observed today): **4 chain armor,
  2 small round shields, 2 gold round shields, 6 knight's shields, 1 scale, 1 nerudite armor**. Any legal
  entrant may take from a guild chest (`ghall.kod:1386-1397`).

**Bottom line:** buy at 113 Barloque, 3 hops from the landing: hammer 810, chain 1,800, small round shield
288, unlimited stock. Barloque sells no leather. Jasper 374 is cheaper (hammer 540, leather 480) but 11+
hops away. Sell only to 113, 109 and 104.

## 4. Carry capacity

| item | kod | weight | bulk | base value |
|---|---|---|---|---|
| hammer | `weapon/hammer.kod:40-42` | 80 | 75 | 450 |
| leather armor | `defmod/armor/leather.kod:39-41` | 100 | 150 | 400 |
| chain armor | `defmod/armor/chain.kod:38-40` | 200 | 250 | 1000 |
| small round shield (`MetalShield`) | `defmod/shield/metlshld.kod:37-39` | 100 | 125 | 160 |
| scale armor | `armor/scale.kod:38-40` | 330 | 350 | 1500 |
| gold round shield | `shield/goldshld.kod:38-40` | 225 | 150 | 500 |
| shilling (`Money`) | `numbitem/money.kod:35-36` | **0** | **0** | 1 |

- A pack has **two ceilings, weight AND bulk, each `1700 + might*20`** (`player.kod:737-738, 10458-10463`),
  and it is full when either one is reached. Prod maxima are 1,900-2,700 (might 10-50). Shillings weigh nothing.
- One **empty 2,700** pack (bulk binds for everything except the hammer) holds **10 chain**, **18 leather**,
  **21 small round shields**, **33 hammers** (by weight), **7 shield+chain kits** (375 bulk each), **6
  shield+chain+hammer kits** (450), or **12 shield+leather kits** (275). A 2,200 pack holds 5 kits of
  shield+chain+hammer.
- Most free room right now (weight/bulk free): Sweetums t11 2056/1955 (max 2700), Camilla t9 1750/1798,
  Gonzo t18 1691/1581, Beaker t6 1559/1108, Janice t7 1442/1489, Statler t3 1394/1364, Loial hk1 1394/1260.
  Everyone else is at 57-100% full.
- **Need** (equipment tool, live; see the caveat below): worn armor exists only on **Zoot (chain)**, and no
  raider wears a shield. **14 raiders** hold no hammer: t1, t2, t3, t5, t8, t9, t10, t11, t12, t13, t14, t16,
  t18, t21. Hammers are held by t4, t6, t7, t15 (in pack), t17, t19 and t20. Spares already on hand are
  chain on t3, t4, t13 and t19, knight's shields on t15 (x2) and t11, gold round shields on t4 and hk1, and
  the chest stock in §3. *Caveat:* keeper-backed `equipment` is rebuilt from names. Kermit's fleet row says
  it wields a long sword while `equipment` says nothing. `ghost-raid-character-advice.md:51` says Rowlf wears
  a knight's shield. Re-read the world before counting.
- **Kits:** 21 shields + 20 chain + 14 hammers is 6,700 bulk, about **2.5 full 2,700-packs**. After the
  chest and pack spares (about 8 chain and 15 shields) it is about 12 chain + 6 shields + 14 hammers ≈ 4,800
  bulk. That is **two armorers with 2,400+ free each, one trip**, or one trip plus a second for hammers.
  Leather in place of chain saves 100 bulk per kit but is not sold in Barloque.

**Bottom line:** shillings are weightless. A cleared 2,700 pack carries 7 shield+chain kits or 6 kits with a
hammer. Two cleared armorers can bring the whole outfit in one trip only if the 714 chest spares are used;
otherwise it takes two trips.

## 5. Money

- Purses (live fleet rows): **t1-t21 = 42,875**. hk1 Loial 11,869, hk3 2,500, hk2 0. All 24 total **57,244**.
  Largest are Scooter 6,937, Beaker 5,754, Sweetums 5,621, Pepe 4,228, Piggy 3,251, Lew 3,157.
- Banked (last *observed* balances, several weeks stale): **t1-t21 ≈ 313,636**, mostly **Waldorf 154,151**
  and **Zoot 90,445**, then Kermit 19,154 and Piggy 13,179. There is one shared account; tellers are only in
  **Tos 54** and **Jasper 376** (memory: banks-are-one-system-two-towns). **Barloque has no bank.** From 714,
  Tos 54 is 10 hops and Jasper 376 is 10.
- **Guild chest in 714: 73,099 shillings** in chest `r18c6` (observed today), right where the armorers land.
  The chests also hold sellable gems: sapphire about 2,527, emerald 2,746, diamond 1,024, ruby 354.
- **Cost** at 113 prices: all-new 21 shields (6,048) + 20 chain (36,000) + 14 hammers (11,340) ≈ **53,400**.
  With the 714/pack spares it drops to about 12 chain + 6 shields + 14 hammers ≈ **34,700**. Hammers at
  Jasper would save 270 each.

**Bottom line:** the raiders' purses (42.9k) cover the reduced order (about 35k) and the chest's 73k covers
the full one. The only bank money is in Tos or Jasper, off the route.

## 6. Shadow clone fidelity

- The newest code is `C:/code/m59-lab/prod-deploy/tools/m59-shadow.mjs` (2026-09-16). It is gitignored, and
  `tools/m59-shadow-run.mjs:280-281` calls its `dress`. Its header (`:8`) says **"dress: level, karma,
  position and equipment"**.
- `snapshot` **records** the inventory, names and amounts, which would include shillings, reagents and the
  Chalice (`:322, :375-376`):
  `inventory: (inv?.items ?? inv?.inventory ?? []).map(x => ({ name: x.name, amount: x.amount ?? 1 }))`.
  It records equipment as `(eq?.worn ?? eq?.equipment?.worn ?? []).map(...)` (`:374`). **The `equipment`
  tool returns `equipped`, not `worn`, so this list is always empty.**
- `cmdDress` (`:700-857`) writes attributes, max health, vigor and **abilities** (unless `--no-skills`). It
  then creates **only the wielded weapon** (`WEAPON_CLASS` map, `create object ${cls}` + `NewHold`,
  `:806-817`) and places the character. **It never reads `c.inventory` or `c.equipment`**, and it has no
  money, reagent, bank or guild code.
- `docs/m59-shadow.md` on origin/main says items are "**done** … `dress` recreates the recorded pack;
  `--no-items` opts out". **No copy of `m59-shadow.mjs` on disk contains `no-items`**, and `git log -S` finds
  the string only in the doc commit `050291a`. The doc also says **guild: "half done … Nothing yet
  recreates the guild on the lab"**, and reagents: "a freshly dressed shadow has no reagents".
- The live shadow (8971) confirms it. It has 23 agents against prod's 24. Total purse is **3,769** against
  prod's 57,244. There is **no Chalice anywhere**, and its gear (leather, small shields) is its own history,
  not prod's.
- The snapshot numbers the shadows by fleet-row *index* (`shadowName(i)`). The prod fleet now has 24 rows
  including hk1-hk3, so which shadow is "Loial" depends on row order.

**Bottom line:** a fresh clone would **lack the shillings, reagents, every pack item including the Chalice
(only the wielded weapon is recreated), worn armor, bank balances, guild membership and the hall (so the
714 chest stock and its 73k too)**. It would copy only attributes, max health, vigor, abilities, one weapon
and position.

## Blocks a no-DM run on the shadow

1. **No Chalice on the clone.** Getting one without DM means the Cave2 (room 27) acquisition puzzle.
2. **No guild or hall on the clone.** Rescue would land each armorer in a random inn (202 / 153 / 370)
   instead of 714, so the "same run" diverges at the first step. Founding a guild costs 5,000 at Frular
   (room 700, Barloque), and a hall costs 25,000 plus rent. Both are possible without DM but are slow.
3. **No money on the clone** (3.8k fleet-wide against about 35-53k needed), and no chest stock.
4. On prod, the cup is held by **Loial (hk1)**, whose keeper serves it through the chalice-farming ticket
   queue. An errand that claims the armorers must either use that ride or take the cup by hand-over, and
   claiming hk1 stops the service for the whole fleet.
