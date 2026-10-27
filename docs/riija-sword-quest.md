---
title: "Sword of Riija quest and completion guide"
status: current
tags: [quests, riija, sword, kocatan, shards, escort, fleetscript]
entities: [RiijaSword, SwordShardA, SwordShardB, SwordShardC, SwordShardD, Wulfgang zax'Ak, Hanla zax'Ta, Bahal zax'Ot, The Bone Priestess, dragonfly queen, Cliff Hive, orc pit boss head, chunk of nerudite, feather of an avar shaman, karma]
answers:
  - Write a report on the Riija sword quest and how to accomplish it. If you can, also write a FleetScript that will have the assigned m59-harness bot complete the Riija sword quest and then hand back control and commit that to the m59-harness public repository
sources:
  - kod/util/questengine.kod
  - kod/object/passive/quest.kod
  - kod/object/passive/questnode.kod
  - kod/include/blakston.khd
  - kod/object/item/passitem/swshard.kod
  - kod/object/item/passitem/weapon/riijaswd.kod
  - kod/object/item/passitem/bosshead.kod
  - kod/object/active/holder/nomoveon/battler/monster/BossBody.kod
  - kod/object/active/holder/nomoveon/battler/monster/dflyq.kod
  - kod/object/active/holder/nomoveon/battler/monster.kod
  - kod/object/active/holder/room/monsroom/orcpitb.kod
  - kod/object/active/holder/room/monsroom/kcforest/ka1.kod
  - kod/object/active/holder/room/monsroom/kcforest/kc5.kod
  - kod/object/active/holder/room/monsroom/kcforest/kd1.kod
  - kod/object/active/holder/room/monsroom/kcforest/kmadscih.kod
  - kod/object/active/holder/room/bowhut.kod
  - kod/object/active/holder/room/tpost1.kod
  - kod/object/active/holder/room/temprii.kod
  - kod/object/active/holder/room/kocarm/koctower.kod
  - kod/object/item/passitem/numbitem/food/gobletst.kod
  - kod/object/active/holder/nomoveon/battler/monster/towns/kocatwn/kcguardE.kod
repo_commit: fe93b6c6e4a576e7f4ff25dbf1f59cd8b6549b83
verified: 2026-10-27
---

# Sword of Riija quest and completion guide

Earn one personally bound sword shard from each of **Wulfgang, Hanla, the Bone Priestess, and Bahal**. Hold the complete set together and it assembles automatically. Prepare the pit-boss head, nerudite, meat pies and shipment supplies before starting the timed deliveries. The simplest combat-free Hanla route requires **karma at least +10**; karma at most **−10** gets her shaman-killing route. Neutral characters between those thresholds cannot obtain either Hanla or Wulfgang assignment. Each delivery node allows **one real-time hour**, and repeating a completed or failed quest requires **one hour of logged-in time**. These are separate clocks. Sources: `questengine.kod:1734–1794,2905–3059`; `quest.kod:126–134,265–306`; `questnode.kod:615–616`; `swshard.kod:137–150`.

The mechanics below are verified against the local server-source commit above. Check a differently customized server before relying on exact cargo tables or timers.

## The four pieces

| Piece | NPC and location | Say | What completes it |
|---|---|---|---|
| A, tip | The Bone Priestess, Lair of the Bone Priestess, room **2141** | `riija` | Give her an **orc pit boss head** after she requests it. |
| B, blade | Bahal zax'Ot, Hut of the Mad Scientist, room **2136** | `kohuzotz` | Bring a live **dragonfly queen** into his hut, then speak to him. |
| C, crosspiece | Wulfgang zax'Ak, Remote Trading Post, room **2144** | `inventory` | Deliver the particular shipment he names. Your karma selects the cargo table. |
| D, handle | Hanla zax'Ta, Bowmaker's Hut, room **2100** | `arrows` | Good karma: nerudite to the Bone Priestess, feather back to Hanla. Evil karma: kill a shaman for the quest feather and deliver it. |

Quest-to-piece mapping: `questengine.kod:2917–2924,2944–2951,2971–3000,3017–3058`. NPC placement: `kd1.kod:93–95`, `kmadscih.kod:68–70`, `tpost1.kod:85–87`, `bowhut.kod:86–88`. Room numbers: `blakston.khd:794,817,820,824`. The shape labels are useful for recognizing the art; the authoritative identifiers are the A/B/C/D subclasses. All share the display name **“shard of a sword”** (`swshard.kod:18`).

Stand close enough when speaking: the quest compares squared distance to **25**, equivalent to five squares in a straight line (`questnode.kod:650–653`; `blakston.khd:2779`). Ordinary audible speech reaches farther, so an NPC hearing you does not prove that a quest trigger counted. Remove anonymity or Morph before starting; the shared Monster.SomeoneSaid speech hook rejects anonymous or morphed speakers.

## Preparation and a practical order

1. **Obtain the boss head before asking the Bone Priestess.** It can come from another player's raid: this quest is a class-based item delivery, not a personal kill requirement (`questengine.kod:2917–2924`; `questnode.kod:687–744`).
2. **Choose your karma route.** Good means **≥ +10**, evil **≤ −10**, with the endpoints included (`quest.kod:126–134`). A good character needs a **chunk of nerudite** for Hanla. An evil one needs to survive an avar-shaman kill and receive kill credit.
3. **Arrange access to the jungle.** The east tower checks the captain's `CanPass`; an evil captain accepts a **1,000-shilling** bribe. This is access preparation, not a fifth sword shard (`koctower.kod:144–162`; `kcguardE.kod:16,96–126`).
4. **Bring meat pies and supplies.** Keep extra pies for the queen even if Wulfgang asks for pies. Obtain his actual assignment before making a costly mainland shipment; the request is random.
5. **Do Wulfgang first**, so an unavailable shipment does not consume another quest's deadline. Finish Hanla's two deliveries next, then exchange the already prepared head, and do the live queen last. This order is a planning recommendation; there is no required order among the four shard quests.

Do not collect all eight possible good-karma shipments by default. Ask, record the exact request, and fetch that cargo within its deadline. If a shipment cannot be acquired in time, let the quest fail and wait out the retry restriction before asking again.

## Wulfgang's shipment

At the trading post, say **`inventory`** and save his answer. Only one entry from the relevant table is requested.

| Good karma, ≥ +10 | Amount | Evil karma, ≤ −10 | Amount |
|---|---:|---|---:|
| Meat pies | 50 | Mystic sword | 1 |
| Water skins | 70 | Plate armor | 1 |
| Apples | 150 | Mugs of brew (`StoutGoblet`) | 100 |
| Grapes | 200 | Chunk of nerudite | 1 |
| Elderberries | 350 | Goblets of wine | 70 |
| Herbs | 250 | Goblets of ale | 70 |
| Mushrooms | 200 | — | — |
| Jewel of Froz | 1 | — | — |

Cargo and quantity definitions: `questengine.kod:2971–2999`. Trigger and assignment: `questengine.kod:365–370`. “Mug of brew” is the actual `StoutGoblet` name (`kod/object/item/passitem/numbitem/food/gobletst.kod:19`), distinct from the ale goblet. Both routes have the same **one-hour** delivery limit (`questengine.kod:2982,2999`).

Offer the required amount in one stack for stackable cargo. The engine refuses an undersized offer and reports the remaining count; it does **not** bank small deliveries toward the total (`questnode.kod:710–729`). Successful delivery awards C and says **“Splendid. Here, I don't need this.”** (`questengine.kod:368`).

Public guides include other quantities and even a chess board. Those are not in this source's table; follow your server's request and source rather than silently substituting a guide's shopping list.

## Hanla's feather

Say **`arrows`** in the Bowmaker's Hut. Your karma determines which task she assigns; it is not a free choice between two favors (`questengine.kod:1774–1794`).

**Good route:** after the assignment, take one chunk of nerudite to the Bone Priestess. That node expects the ore and advances to a feather-delivery node; take the **feather of an avar shaman** back to Hanla. Each node has its own **one-hour** limit, so the return timer starts when the ore trade advances the quest (`questengine.kod:3017–3041`; `questnode.kod:615–616`). This is a step in Hanla's quest, not the Priestess's separate head-for-tip quest.

**Evil route:** kill an **avar shaman** after receiving Hanla's assignment. The quester must receive the killing blow; another player's kill will not advance it. The engine places the quest feather at the corpse's location, so **pick it up** before returning to Hanla. It is not sufficient merely to fight the shaman or watch it die (`questengine.kod:3047–3058`; `questnode.kod:1527–1584`). Hand over that feather for D. The shaman route's delivery deadline is **one hour**, including the hunt (`questengine.kod:3058`).

Use the good route when arranging a sword for a noncombatant. For a fighter choosing the evil route, consult the jungle spawn data and confirm the monster is an avar shaman, rather than an ordinary avar or chieftain.

## Bone Priestess and the boss head

Say **`riija`** and wait for **“Hedd of Pit Boss!”** Offer the prepared head within **one hour** for A (`questengine.kod:351–355,2905–2925`). There is no requirement that this character killed the boss.

If gathering the head yourself, plan a party excursion through the Orc Caves. The pit chamber puzzle compares the populations in two chambers: **A:B = 1:3, 1:2, or 2:3** (`orcpitb.kod:199–227`). The smallest positive population is one character in A and two in B, which explains the usual three-player preparation. These ratios do not replace the puzzle's switches, positions or the subsequent boss fight.

The head is explicitly created on the ground when the **OrcPitBossBody** is killed (`BossBody.kod:66–78`). Recover the actual **orc pit boss head** item; merely killing the first boss form or possessing a different orc trophy is not the delivery. Coordinate the raid and loot first, then start the Priestess's short delivery timer.

## Bahal and the live queen

Say **`kohuzotz`** at Bahal's hut and confirm the live-specimen assignment. You now have **one hour** (`questengine.kod:357–363,2931–2954`).

Go to **Cliff Hive**, room **2111** (`ka1.kod:19,38`; `blakston.khd:799`). Queens are part of its normal spawn table, with dragonflies weighted **90** and queens **10**; the generation attempt runs every **90 seconds** with **70%** generation chance, subject to the room's population limit. A queen is not guaranteed every tick (`ka1.kod:44–57`).

Offer a queen **one meat pie**. Other foods are accepted but do not produce the same charm. A meat pie makes you her master if she is unmastered or currently belongs to a user. The confirmation says she looks at you with **“obvious adoration.”** A queen already owned by a nonplayer master, including Bahal, cannot be stolen this way (`dflyq.kod:295–340`). Avoid trying to reuse the scientist's penned specimens.

Escort her back while keeping her alive:

- Approach the next exit, wait for the queen to catch up, cross, and verify that the same queen arrived before continuing.
- A helper with Truce can reduce attack risk. Rescue is a possible shortcut when your binding and resources suit it; check your Rescue binding before choosing that shortcut. Verify the queen's landing as well as your own.
- Following is conditional. The monster's room-change hook checks proximity to the master's departure, and its destination refuses additional mastered monsters once it holds **six** (`monster.kod:933–980`). Do not assume she followed because you reached the destination.

Bring her into **Bahal's hut**, not just the outdoor pen, and say `kohuzotz` again near him. The delivery accepts a queen mastered by the quester, or an unmastered queen, in the same room. A queen mastered by another player does not qualify for your delivery. The quest makes Bahal her master, moves her into the pen, and awards B (`questnode.kod:747–803`; `questengine.kod:2944–2951`). If a helper escorted her, transfer mastery with your own meat pie before turning her in.

## Assembly, binding, bridge access and repairs

The four pieces must share the **same original quester**. On acquiring a shard, the server checks the holder's pack for A/B/C/D with that quester. It automatically deletes the matching set and creates a sword bound to that quester (`swshard.kod:52–150`). There is no blacksmith combine command. Mixing different players' pieces does not satisfy the check (`swshard.kod:85–158`). The resulting sword retains the original quester even if someone else holds the complete matching set, so earning your own set matters.

Look at the finished sword and verify the runes say **“Let YOUR NAME walk with faith.”** Carrying an arbitrary sword of Riija is insufficient for the temple bridge: the room checks the player's **equipped** items for a Riija sword whose quester is that player, and kills a player on the bridge without one (`riijaswd.kod:90–96`; `temprii.kod:337–359`). **Equip your own sword before crossing.** The automation below finishes sword acquisition; it does not cross the bridge.

The sword uses short-sword proficiency. While equipped it contributes **+10** to Riija's base spell modifier and **−10** for other schools; Riija casting also restores one durability hit, bounded by its maximum (`riijaswd.kod:42–44,196–208`). These are spell-modifier values, not a claim of 10% more final damage.

When shattered, it returns **three of the four bound pieces**, choosing the missing type randomly (`riijaswd.kod:169–192`). Identify the missing subclass and repeat only its corresponding quest after the retry restriction clears. Preserve the surviving shards and avoid mixing owners.

## FleetScript implementation and its limits

The public harness addition is `tools/fleetscripts/riija-sword.mjs`, with usage in `docs/m59-riija-sword.md`. It implements the **good-karma route for one prepared bot**, through the existing FleetScript runner:

1. Verify character identity, readable inventory and personally bound preexisting shards or sword.
2. Require a prepared head, nerudite or feather, and meat pies before timed requests.
3. Ask Wulfgang, persist his exact shipment and deadline, and deliver it if stocked. Missing supplies stop the run; resupply and rerun before the deadline.
4. Complete Hanla's ore/feather route and the Priestess's head delivery.
5. Ask Bahal, charm a queen at Cliff Hive, approach each planned departure, wait for the same queen, and escort her to his hut.
6. Verify a sword naming the assigned character; optionally attempt the requested return room. The runner cancels pending travel, releases its keeper hold and clears its busy state in `finally`.

The script does **not** organize the multiplayer pit-boss raid, gather missing shipment supplies, change karma, bribe the tower captain, automate the evil shaman route, or cross the temple bridge. Those preparation requirements are deliberate scope limits. It does not select a live bot implicitly: pass the bot through `agents` on the intended fleet. Offline tests exercise the quest callbacks and scripted escort sequence against simulated game replies; they do not establish live jungle survival or successful production completion.

For use from the harness directory:

```text
node tools/m59-which.mjs --fleet <your-fleet>
node tools/m59-fleet-repl.mjs --fleet <your-fleet>
> dry riija-sword agents=<assigned-bot> home=<return-room>
> riija-sword agents=<assigned-bot> home=<return-room>
```

The persisted questbook is local to the fleet and must not be committed. After an expired assignment, wait for server failure and the logged-in cooldown before using `reset=true`; resetting the local record cannot reset a server quest.

## Actions to take

- Prepare the head and choose a karma route before opening delivery timers.
- Record Wulfgang's actual shipment; deliver the whole required stack.
- Keep the queen close at departures and verify her after every crossing.
- Verify the sword's binding and equip it before attempting the bridge.
- Run the FleetScript only on a prepared good-karma bot, with the correct fleet explicitly selected.
