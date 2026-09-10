# Money, merchants, gear and supply

Split out of [`CLAUDE.md`](../CLAUDE.md). Who buys what, what a loadout is, what a guild want is, and every way a trade can succeed while moving nothing.

## Who will actually pay you

- **"BUYS ANYTHING" IS USUALLY A ROBBERY, AND BOTH THE FLAGS AND THE INDEX SAY IT
  CHEERFULLY.** `substrate/m59-merchants.json` reports `buys_anything: true` for the
  bankers, and the object's affordances include `buy`. Both are accurate and neither
  means it will pay you. **Skivlat takes what you hand him, says thank you, and gives
  nothing back** — it is a trick played on new players, and nothing on the wire
  distinguishes it from a sale. This nearly emptied the fleet: a town-selling change
  was one trip away from handing twenty-one packs, 1,864 units of mushroom, gem and
  tooth, to a banker for nothing.

  Three different NPCs answer to "buys anything" and only one is a market:

  - **Roq** — the only NPC known to buy an unlimited quantity of anything. It is the
    Barloque assassin (`assassin.kod`, `Assassin is BarloqueTown`) and it is **not in
    the merchant index at all**, which is why nothing has ever sold to it. **Izzio** and
    the island vendor are close to it with rules of their own. **And this fleet no longer
    goes there**: the road into "A shadowy corner" (room 110) crosses a lupogg's ground
    with a jump in it, characters kept colliding with the lupogg on the jump and being
    eaten for a sale that pays poorly, so 2026-08-27 every prod character carries
    `banned_destinations: [110]`. That key is the general form — rooms a character must not set out
    for, for any reason the keeper can generate (sell, bank, farm). A destination ban,
    not an avoidance: a route that merely passes through one is not rerouted; a trip whose every
    destination is struck is dropped and noted once, never re-routed. It is an ORDER, so it
    lives in the roster, not here.
  - **The two vaults**, one mainland (Barloque) and one on the island. They "buy"
    anything and sell it back for about a shilling. They are **storage, not a market** —
    and storage that SURVIVES DEATH, which is the only thing in the game that does. That
    makes them the right tool for holding something the fleet will need later rather
    than dropping it on the next corpse, and for one character to leave something where
    another can collect it. Never sell into one by accident.
  - **Everyone else claiming it** — assume the robbery.

  So selling is an ALLOWLIST, not a check: `SELL_TO` and `NEVER_SELL_TO` in
  `m59-skills.mjs`, via `trustedBuyer()`. Being wrong about a buyer costs the whole
  pack; being wrong about a walk costs a walk.

## Money: banks, purses and signet rings

- **A BANK BALANCE IS PROSE, IT IS SENT ONCE, AND A WITHDRAWAL DOES NOT STATE IT.**
  There is no packet for the balance. The banker says it out loud — `Lm_bnkr_balance`,
  `monster.kod:136` — and never mentions it again, so the only way to *read* one is to
  walk a character to a counter and ask. That is why it is caught off the event stream
  and written to `substrate/banks/<character>.json` the moment it goes past, exactly as
  abilities are. `node tools/m59-bank.mjs` reads the whole fleet's balances back without
  moving anybody; the `fleet` tool carries `purse` and `banked` on every row.

  Two things about it are counter-intuitive. **A withdrawal reports the amount handed
  over, not the new balance** (`Lm_bnkr_did_withdraw`, `monster.kod:144`), so that one
  figure is arithmetic against the last stated balance and is flagged
  `observed: false` — do not report a derived number as though a banker said it. And
  **there are two accounts, not one per town**: Jasper and Tos both pay into bank 1,
  because `BANK_BASIC` and `BID_TOS` are both `1` (`blakston.khd:1275`) and `JasperBanker`
  is created with `#bid=BID_TOS`, while Ko'catan is bank 2. "But you only have N shillings
  in your **possession**" is the purse, not the account, and differs from the account line
  by one word.

  **Correction, 2026-08-12: this used to say Barloque was a third counter on bank 1, and
  there is no bank in Barloque at all.** `BarloqueBanker` — "Setag'lib", `bqbanker.kod:11` —
  is declared, compiled and present in `kodbase.txt`, and `Create(&BarloqueBanker)` occurs
  **nowhere in the room tree**; only `jasbank.kod`, `tosbank.kod` and `kocbank.kod` ever
  place one. A class that exists is not an NPC that stands somewhere, and a source-derived
  table cannot tell the two apart — which is how a banker nobody has ever spoken to got into
  three documents. The tooling was always right: `BANKS` in `m59-autopilot.mjs` lists 54 and
  376 and no Barloque room. Only the prose was wrong.

- **A SIGNET RING IS WORTH TEN TIMES MORE IN A SMALL CHARACTER'S HANDS, AND THE OWNER
  USUALLY HAS AN ADDRESS.** Returning one pays its value ten times over to a character
  that has not enabled player-killing and plain value to one that has (`ringsgnt.kod:94`)
  — and nobody here enables that deliberately. `EvaluatePKStatus` (`player.kod:11047`)
  sets it *for* you the moment base max health reaches 30, or you join a guild. Max health
  is the level here, so **a ring returned by a character under level 30 is worth ten times
  the same ring returned by anyone else**: up to 1500 shillings against up to 150. Which
  of them is holding it is decided by whoever happened to loot it, so `signets
  action=redistribute` moves them down and `action=return` sends them to be cashed.

  Three things about it read backwards. **1500 is a ceiling, not a price** — `GetValue`
  scales with a condition this class refuses to show (`vbShow_condition = FALSE`), so the
  real payout is anywhere from 100 to 1500 and cannot be predicted; read the purse
  afterwards. **The owners mostly do not wander** — I recorded that they did and that an
  NPC-location table would not help, and that was wrong: `CreateSignetRing`
  (`library.kod:4245`) draws from nineteen NPCs, fifteen of which stand in a fixed room in
  Barloque, Cor Noth, Jasper, Marion or Tos. `SIGNET_OWNERS` in `m59-skills.mjs` is that
  table, and two classes that exist in the kod are deliberately absent from it because
  nothing ever creates them. **And they expire** — the world holds twenty signets, and a
  twenty-first deletes the oldest out of whoever is carrying it (`library.kod:4288`), so
  hoarding one loses it.

## Faction service — a subscription with a four-hour warning

- **A FACTION IS A SUBSCRIPTION, THE BILL IS ONE SENTENCE, AND THE CLOCK RUNS WHILE THE
  CHARACTER IS LOGGED OUT.** `FactionServiceTimer` (`player.kod:11238`) re-arms every 20
  minutes and accumulates **wall-clock** unserved time. At `FACTION_WARN_TIME` (72000s,
  20h) it sends `player_faction_time` — *"Your liege is no longer convinced of your
  loyalty. You should visit your liege at court again."* At `FACTION_RESIGN_TIME` (86400s,
  24h) it calls `ResignFaction`. **Four hours between them**, and the expulsion announces
  itself only afterwards.

  There is no packet, no stat and nothing to poll — it is `MsgSendUser` prose, so it is
  caught off the event stream and written to `substrate/faction-status/<character>.json`
  exactly as a bank balance is. `node tools/m59-loyalty.mjs` reads the fleet back without
  moving anybody; `--serve <name>` plans the errand.

  Five things that read backwards:

  - **THE WARNING IS WHAT CREATES THE QUEST.** Service quests declare
    `QT_SCHEDULE_CHANCE = 0` (`questengine.kod:1657`), so the ordinary quest timer never
    makes one. Only `JoinFaction`, a completed previous service, and the warning branch
    itself (`#override=TRUE`) do. Saying "loyalty" to a liege that has not warned you does
    nothing at all, silently — and the warning is reliable evidence that a node is waiting.
  - **THE WARNING REPEATS EVERY 20 MINUTES AND IT IS THE SAME DEADLINE.** Re-dating on
    each repeat pushes the due time forward for ever, and the character is expelled while
    the record says it has hours left. `noteLoyaltyWarning` refuses to re-date an open one.
  - **ASKING TRADES FOUR HOURS FOR ONE, AND THE PENALTY IS EXPULSION.** Every faction's
    last node carries `#penaltylist = [[QN_PRIZETYPE_FACTION, QN_PRIZE_FACTION_NEUTRAL]]`
    on a one-hour timer (half an hour for the Duke), and arriving one second late awards
    the penalty rather than the prize (`questnode.kod:846`). Make the trade anyway — not
    asking loses the membership with certainty — but **carry the payment first**.
  - **THE LIEGE NAMES ONE ITEM OUT OF SEVEN.** `pCargo` is a single
    `GetRandomCargoFromQuestNodeTemplate` (`questnode.kod:226`) compared by CLASS
    (`:699`), so carrying a candidate is a one-in-seven head start, not readiness. Rook in
    **room 154** is the only reliable counter — `CorNothSergeant` does not declare
    `vbSellFromInventory`, so he cannot run out of long swords. Izzio can, and wanders.
  - **A SOLDIER IS WARNED FOR EVER AND NEVER EXPELLED.** `UpdateFactionService`
    (`player.kod:11203`) clamps the counter at the warn threshold while a `SoldierShield`
    is worn. Read naively that sends every soldier on the errand every 20 minutes for ever,
    so `loyaltyDebt` reports a soldier's debt with **no deadline** rather than as no debt.

  **A quest node is deaf beyond five squares and says nothing about it** — `SquaredDistanceTo
  > Q_NPC_CLOSE_ENOUGH^2` is checked before the message is (`questnode.kod:650`), so in a
  large chamber the word is spoken, the room hears it and the quest does not. Checked before
  speaking. **And a node belongs to ONE character** (`questnode.kod:800`): a fleet all
  shouting "loyalty" at one liege gets one quest and twenty silences.

  **The Duke is recognised and deliberately not automated** — his middle leg is "say `tax`
  to whichever townsperson I name", which would need a speech allowlist covering three
  towns, on two half-hour timers. `node tools/m59-faction-test.mjs` (63 more assertions)
  pins all of the above; the DUM side is `factions.keep_membership`.

## Trading, packs and what a character may hold

- **A CHARACTER CAN BECOME UNABLE TO RECEIVE, AND IT LOOKS EXACTLY LIKE A BROKEN TRADE
  PROTOCOL.** It can still GIVE, still fight, and reads as completely healthy on the board —
  but every attempt to hand it a new item fails, with `supply` reporting only *"the trade
  did not complete — nothing moved"*. Nothing names the pack.

  This cost two check-ins on one character. Lew sat at zero kills for five of them, unarmed,
  standing in a room where one fleetmate carried 22 weapons and another 19. Its keeper said
  so plainly — `UNARMED_NO_DONOR`, *"unarmed — 10 mana, needs 15 to make one"*, remedy
  *"hand it a weapon"* — and thirteen donors in the same room all failed identically.
  **Shedding four heavy stacks fixed it instantly** and it killed something within a minute.

  **CORRECTION, same day: this entry first said the limit was 14 STACKS. That is WRONG.**
  Written from one character at 14 that could not receive and could at 10, which is a sample
  of one and a coincidence of counting. Measured across the fleet an hour later: characters
  routinely carry **26, 28, 30, 34 and 35 stacks**, and one that had just failed to receive
  at 22 accepted an item at 19 — while another accepted at 28. There is no 14. What the
  successful fix actually removed was **WEIGHT and BULK**: the four stacks shed from Lew were
  55 red mushrooms, 59 mushrooms and 34 emeralds, and its pack went from 74% to 35% in one
  step. `pack.binding` on the fleet row already says which of the two is the live ceiling,
  and it differs per character (`1700 + might*20`, so 2000–2700 here).

  The honest state of this trap: **a character that cannot receive is nearly always full,
  the board's `pack.percent` and `pack.binding` are the numbers to read, and shedding the
  heaviest stacks is the fix.** Do not go looking for a stack count. And note what the wrong
  version cost — nothing, because the remedy was the same either way, which is exactly why
  it survived a commit without anybody noticing.

  **Every diagnosis that fits the symptom is wrong in a way that wastes a session.** It is
  not the keeper (it fails with the keeper stopped). It is not the room (`supply` checks,
  and says so when they are apart). It is not the trade tooling: the CONTROL matters
  here, and it is one call. Ask three questions, not one:

  | | Lew | reading |
  |---|---|---|
  | can it RECEIVE a light item? | no | — |
  | can it GIVE? | **yes** | so its session and the protocol are fine |
  | can two OTHER characters trade? | **yes** | so the tooling is fine |

  One-directional failure is the signature. **`pack.percent` and `pack.binding` are the
  numbers to read — not `carrying`**, which is what the first version of this entry said and
  is what led it to invent a stack limit that does not exist.

  **`trade` lies in BOTH directions and must never be trusted over a re-read.** It returned
  `offered: false` on an offer that had in fact landed with the item on the table — so the
  natural response, retrying, cancels a working trade. It then returned `accepted: true`
  with `carried_before` equal to `carried_after`, having transferred nothing. Watch the
  recipient's `mayAccept`: it stayed **false** through a successful counter, so the giver's
  accept was the only one and it ENDED the trade rather than completing it. **Use `supply`**
  — it drives both ends and verifies the receiver actually holds the goods afterwards, which
  is the whole reason it exists.

  **BUT READ `supplied`, NOT `!error`.** A refused exchange answers with a complete, honest,
  well-shaped account of the refusal and **no `error` field anywhere in it**:

      { supplied: false,
        reason: "Loial the Ogier is not in the room with Floyd",
        giver_in: 544, receiver_in: 370,
        players_the_giver_can_see: [ ... ] }

  A caller testing `!r.error` therefore reads every refusal as a success, and the failure
  surfaces at whatever step next asks the world a question — which points at the wrong half
  of the errand entirely. That cost three diagnosed runs on 2026-09-09, each blamed on a
  different innocent step: a lease released too early, then a mover that could not move,
  then an arrival that had not happened. All three were real and none of them was why the
  item had not moved. `reason` had been saying so the whole time, unread.

  This is the ordinary shape of an answer here, not a quirk of `supply`: **an outcome field
  and a prose reason, with `error` reserved for the call going wrong rather than the errand
  being refused.** Test the field that names the outcome.

- **A HELD CHARACTER CANNOT BE WALKED BY `supply`.** `who_travels` will happily name an end
  to move, and `m59-supply.mjs` says why it then does not: *"the mover is deliberately NOT
  held; `travelJob` already stops its keeper driving and leaves it able to defend itself."*
  So if your script has already taken work/movement/economy with `commander_claim` — which
  every fleetScript does — the travel is refused as busy, and the exchange still returns
  without an `error` because it did issue what it meant to issue. Measured 2026-09-09: both
  ends held, supply's step reporting ok, and the courier still standing in room 544 seven
  minutes later having never taken a step.

  **Issue the journey through the script that holds the body** — fleetScript's `walk(room)`,
  which carries the same lease, health floor and journey guards as any other movement — and
  call `supply` with `who_travels: 'neither'` once they are standing together. And wait for
  them to actually BE together by reading the two keepers, not the fleet rows: a fleet row is
  a snapshot with an age on it, and `supply` checks the live world.

- **A HAND-OVER THAT COMPLETES THE HANDSHAKE AND MOVES NOTHING IS USUALLY A MALFORMED ID
  LIST, NOT A FULL PACK.** `may_accept` true, the counteroffer seen, the accept sent, and
  zero counts move: the entry above says read `pack.percent`, and that is right most of the
  time and was wrong here. Measured on shadow 2026-08-26: Hhhh, carrying one elderberry and
  one herb, could hand Jjjj neither — **in either direction**, which is the one signature the
  full-pack diagnosis cannot produce, and two other characters traded fine between the same
  two attempts.

  The cause is written down in `dropSpec`'s own note in `m59-parse.mjs` and `supply` was on
  the wrong side of it: **the test is the TAG, not whether there is more than one.**
  `extractObject` files an amount only for an object the server tagged as a NumberItem, so a
  stack with ONE left carries `amount: 1` — and `supply` encoded with `amount > 1 ? {id,
  amount} : id`, which sent that stack as a bare id. A bare id contributes nothing to the
  PARALLEL number list `UserDropItems` walks, and that list is paired POSITIONALLY against
  the ids the server thinks are NumberItems. So one untagged stack slides every count after
  it onto the wrong item and the **whole offer** fails, not just that entry. `Split` then
  refuses each one and, as far as the wire is concerned, the request succeeded.

  Two things follow, and the second is the one that will catch somebody again:

  - `dropSpec(o, want)` is the one place that question is answered. Anything encoding an id
    list for the wire should go through it rather than testing a quantity.
  - **A keeper-backed session has to publish the amount the WIRE reported, which for
    anything that is not a stack is ZERO and not one.** `m59-keeper-process.mjs` was
    coercing every item to `amount: 1`, which makes a sword indistinguishable from a herb
    and defeats the tag test at the source. It now sends the real amount and the server's
    own `tag` beside it, and `KeeperProxy` hands both through unchanged.

  `node tools/m59-supply-test.mjs` pins the encoding from both ends: a stack of one still
  goes out with its count, and an ordinary item beside it still goes out bare.

- **"BOUGHT X BUT WON'T WIELD IT" IS ALMOST ALWAYS "CAN'T PUT DOWN Y", AND THERE ARE
  EXACTLY TWO THINGS THAT DO IT.** A character that buys a mace and keeps swinging a long
  sword is not a ranking bug and not a failed purchase — something already in its hands
  refuses to come off, and both culprits are silent about it in the ways these notes keep
  warning about.

  **A CURSED WEAPON CANNOT BE PUT DOWN, EVER.** `WeapAttCursed.ItemReqUnuse`
  (`wacursed.kod:97`) tests nothing at all — it returns FALSE unconditionally and says
  *"%s%s seems to cling to your hand!"* — and `ItemReqLeaveOwner` refuses the drop for as
  long as the item is in `getplayerusing`. So **wielding one is the only irreversible
  mistake in this repository**: no swap, no sale, no handover, no drop, for the life of
  the character.

  And it is a **downgrade, not a trade-off**: `ModifyDamage` and `ModifyHitRoll` both
  return `x - 2*power`, so it is strictly worse than what it replaced at hitting *and* at
  hurting. There is no upside to weigh against being stuck with it.

  Nothing in the harness knew the attribute existed. The name is `"cursed %s"`, so a
  cursed long sword matches `/long ?sword/` and scored **7** — ahead of every mace in the
  pack. It is **10% of the item-attribute treasure table**
  (`AddToItemAttTreasureTable(#percent=10)`) and this fleet loots a weapon from almost
  every kill, so it is a live hazard rather than a curiosity. `isCursed` in
  `m59-skills.mjs` keeps it out of `weaponRanking`.

  **The guard is on WIELDING only, and that is deliberate.** One that is merely carried is
  harmless and still sellable — `ItemReqLeaveOwner` refuses only while it is in the use
  list — so it stays a weapon to `weaponScore`, `sellable` and the equipment plan, and the
  ordinary sell rules shed it. Scoring it zero would make it invisible to the very code
  that should be getting rid of it. **Unwieldable, not invisible.**

  **The other culprit is a TOKEN**, which takes both hand slots and is already on the
  fleet row as `holding_token` — see the note in `m59-broker.mjs` about why it is a flag
  rather than a reading. Check that first; it is free.

## What each merchant deals in

- **A SMITH DOES NOT BUY MUSHROOMS, AND OFFERING HIM ONE IS A SUCCESSFUL CALL THAT RETURNS
  A SILENCE.** What a merchant deals in is `ObjectDesired`, declared per class.
  `Monster.ObjectDesired` (`monster.kod:4707`) returns TRUE and its own docstring says
  *"This is set in individual buyers. It allows them to pick and choose what they want to
  buy."* — **fifteen classes in the tree override it**, each in a couple of lines of
  category tests. That is the whole vocabulary, and `m59-buyers.mjs` is it with citations.

  The categories are **not** the item kinds, and nothing else groups them this way:

  | predicate | is | `monster.kod` |
  |---|---|---|
  | `IsObjectWeapon` | Weapon | :4142 |
  | `IsObjectWearable` | Armor, Helmet, Gauntlet, Necklace, **Shield**, Pants | :4183 |
  | `IsObjectSundry` | Torch, Flask, Mug, **Food** | :4152 |
  | `IsObjectMisc` | Chalice, Scepter, SpecialWand, SpellItem, Book, Arsenic, SpiderEgg(Shell), Key | :4165 |
  | `IsObjectGem` | JewelofFroz, Emerald, Ruby, Sapphire, Diamond, **Ring** | :4198 |
  | `IsObjectReagent` | `IsItemType(ITEMTYPE_REAGENT)` — asks the item | :4213 |

  **A GEM IS ALSO A REAGENT**, which is why three of the four apothecaries name the
  exclusion explicitly (`TsApoth.kod:66`, `bqapoth.kod:128`, `kcapoth.kod:49`) and why
  **Hazar is the only apothecary that takes one** (`hzapoth.kod:55`). `Ring` counting as a
  gem is how a signet ring gets refused by a counter buying every other reagent. And the
  smiths are not interchangeable: five buy weapons *and* wearables, but **Marion's buys
  weapons and shields and no body armour** (`MrSmith.kod:80`), so folding the six into one
  rule sells his leather to a silence.

  **`buys_anything` on the merchant row does not answer this and inverts it.** It is
  computed as "did this class override `ObjectDesired`", which is accurate and is a
  different question: it is TRUE for the bankers who take your goods and thank you, and
  FALSE for every merchant actually worth walking to.

  This cost real trips. `sell_all` offered whatever the loadout marked sellable to whoever
  was standing there, so a run at Quintor's Smithy in Jasper offered him sapphires,
  mushrooms and water skins — each a full offer/cancel round trip plus 900ms of pacing,
  each returning `no counteroffer came back`, and together burying the one line that
  mattered. It now partitions first and returns **`not_offered`** beside `sold` and
  `refused`, with a reason and a citation per item.

  ```bash
  node tools/m59-buyers.mjs                              # the whole table
  node tools/m59-buyers.mjs Quintor "long sword" sapphire
  node tools/m59-buyers.mjs --who-buys sapphire          # who takes it — ask BEFORE the walk
  ```

  The MCP tool is `who_buys`, and it moves nobody. **`refused` and `not_offered` are
  different facts**: the first was turned down at the counter, the second never left the
  pack and is still saleable somewhere else.

  **CANNOT SAY IS NOT NO, and that asymmetry is the whole safety argument.** An
  unrecognised merchant class or an item missing from the index answers `null`, and every
  caller offers it anyway. Being wrong about a category costs a round trip; holding
  something back that would have sold costs the sale **invisibly** — the trip reports
  success, the goods are still in the pack, and nothing says why.

- **TWO MERCHANTS HOLD A REAL INVENTORY AND CAN RUN OUT — OF STOCK, AND OF SHELF SPACE.**
  Every other merchant assembles its list on demand and cannot run dry: `monster.kod`
  declares `vbSellFromInventory = FALSE` and only two classes in the whole tree override
  it, both `MOB_BUYER | MOB_SELLER` with `MAX_FORSALE = 25`.

  | | file | when full it says |
  |---|---|---|
  | **Izzio**, the wanderer | `izzio.kod:54` | "Look at my pack. Where would I put it?" |
  | **Ko'catan shopkeeper**, the island vendor that buys anything | `kcshopk.kod:54` | "I wish I could take that off of your hands for you, but mine are all full too!" |

  This cuts BOTH ways and the selling half is the one that will catch you. Each has three
  separate refusals — full (`length(lForSale) < MAX_FORSALE`), already-have-one
  (no duplicates), and *"I already have several of those for sale"* — and **every one of
  them is a sentence spoken to the room, not an error on the wire**. So a `sell_all` at
  these two can decline item by item while the call reports success, which is why
  `m59-reagents.mjs` reads the PURSE afterwards rather than trusting what the buy or sell
  was asked to do. Fill one up and it stops buying until somebody clears it.

  **Do not generalise a "the shop had none" reading to a merchant that is not one of these
  two.** I did, from a real run: Beaker and Sweetums were told "202 sells no elderberry or
  herbs after all", and 202 is MarionInnkeeper, which inherits `FALSE` and cannot run out
  — Statler bought twelve from that same counter seconds later. The tell that it was a
  failed interaction rather than an empty shop is that both had an UNCHANGED PURSE: every
  character that sold also bought. **Roq is Rook** (`cnsarge.kod:19`,
  `cornothsergeant_name_rsc = "Rook"`) and he does not declare it either.
  `m59-merchants.mjs` now resolves the flag and puts `finite_stock` on the row, so ask it
  rather than assuming.

  **And CLASS NAMES ARE CASE-INSENSITIVE TOO — that is the third kind of name in this
  tree that is, after resource names and property names.** `crnthtwn.kod` declares
  `CorNothTown`; `cngrocer.kod` says `CornothGrocer is CornothTown`. `kodbase.txt` lists
  it once, so they are one class to the compiler and were two keys to a plain `Map` —
  which stopped every walk up that chain at the first hop, silently and in the direction
  that looks like a legitimate answer. `descendsFrom` had been returning false for it all
  along, so Solomon in Cor Noth was reported as stationary whether or not he is. The class
  map is now case-insensitive on lookup while keeping the file's own spelling on iteration.

## Guild wants and the four containers

- **A GUILD WANT IS AN END STATE, NOT AN ERRAND, AND THAT IS WHAT MAKES IT SAFE TO GIVE TO
  TWENTY-ONE CHARACTERS.** A loadout says what one character should carry; a guild want says
  what should end up IN THE HALL, and it is answered by whoever walks past with the right
  thing. `substrate/guild-plan.json` holds it — per chest, per item, a target — written by
  the planner's **Guild hall** sheet and read by the keeper on every town trip. It is
  **gitignored**, because it is an instruction to a whole fleet about a hall on one server
  and it withholds goods from vendors until it is satisfied; `substrate/guild-plan.example.json`
  is the shape.

  Stating it as "chest 2 should hold 300 mushrooms" rather than "take 40 mushrooms to chest
  2" is the whole design: the shortfall shrinks as others contribute, nobody owns the
  errand, it cannot double-count, and **a satisfied plan produces no work and no walk**.
  That last part is the point — a check-in that walked to the hall on every sale to look at
  a full chest would be a tax on every town trip. `m59-guildwants.mjs` owns it and
  `contributionPlan(...).walk` is what the keeper honours.

  **THE ORDER IS pack -> the character's own floor -> the guild's chests -> sold -> banked**,
  and it has to be that order. A mushroom sold in the first line of a town trip cannot be
  un-sold into a chest in the last, so contributing runs BEFORE `sellInTown`; and a bank
  balance is the only unlimited store in the game and the only one that survives death, so
  it is where overflow ends up. **Guild-wanted items are protected from the vendor exactly
  while a chest is still short of them and become sellable the moment the target is met** —
  without the release half, a full hall would mean a fleet that could never sell anything
  again.

  Four refusals, each of which is the cheap mistake:

  - **It does nothing at all without a guild AND a hall**, checked from the cache, and it
    reports WHICH is missing rather than a bare false — "nobody has asked Frular" and "this
    guild has no hall" have different fixes. The planner sheet and the POST that saves it
    are gated the same way, because a plan against a hall the fleet does not own would sit
    on disk holding items back from every vendor for a chest that does not exist.
  - **The contributor keeps its own loadout floor.** A guild is not entitled to the
    elderberry a caster eats with — the same rule `deliverableSpare` follows.
  - **An unopened chest is never read as empty.** `never_opened` means nobody looked, which
    is the opposite fact, and treating it as empty would send the whole fleet to fill a
    chest that may already be full. The keep test goes the other way for the same reason:
    an unopened chest holds its whole target back, because selling is not reversible.
  - **Two chests wanting the same item cannot each be promised the whole stack**, and two
    lines for one item in one chest are a contradiction rather than a sum — the larger is
    kept and the collision is reported.

  **The hall is a SHEET, not a character.** It is `compendium/planner/guild-hall.html` and
  `/_guildplan`, not a loadout under a reserved name: a character called "GUILD HALL" would
  be indistinguishable from a real one to every tool that iterates loadouts, and the first
  of those to run would try to give it a weapon.

  `node tools/m59-guildwants-test.mjs` (39) pins all of it, including that an empty pack
  never walks and that a met target releases the item to the vendor.

- **FOUR CONTAINERS, FOUR DIFFERENT RULES, AND ONLY ONE OF THEM HAS TWO CEILINGS.**
  `m59-storage.mjs` owns all of it, because the arithmetic is different in each case and a
  page that averaged them would be confidently wrong four ways:

  | | limited by | ceiling | scope |
  |---|---|---|---|
  | a pack | **weight AND bulk** | `1700 + might*20` | one character |
  | a vault | bulk only | 3000 | **one character**, not one vault |
  | a guild chest | bulk only | **24000** | the whole hall |
  | a store box | bulk only | 4000 | the hall |

  **A pack is full when EITHER ceiling is reached** (`holder.kod:259` -> `:281`), so its
  fullness is the WORSE of the two fractions and the board says which one binds. The other
  three declare `viWeight_hold_max = $` — nil, meaning unlimited — so weighing them at all
  would invent a limit the server does not have. **A vault's 3000 is per depositor**:
  `CanDepositItems` sums `GetCurrentBulkStored(#who=who)` (`storage.kod:88-99`), so
  twenty-one characters have twenty-one separate 3000s in the same vault. A chest is one
  pool. The Bookmaker's hall builds **three** chests (`guildh14.kod:518,520,522`) and a hall
  may hold four, so the board keeps four slots.

  **NONE OF RENT, VAULT CONTENTS OR CHEST CONTENTS IS PUSHED**, so all three are the
  `substrate/banks/` pattern — caught when somebody happens to be told, written to
  `substrate/storage/`, and never rendered as current. Two consequences the board must keep:
  **"never looked" and "empty" are opposite facts** (an unopened chest renders hatched, not
  0%), and **rent's SIGN is its whole meaning** — positive is a debt that loses the hall,
  negative is credit, and an answer nobody parsed stores as `null` rather than as a guild
  that owes nothing.

  **`BP_WITHDRAWAL_LIST` (231) was declared and never parsed**, which is the `UC_LOOK_PLAYER`
  trap again: a packet nobody parses is indistinguishable from a packet nobody sends, so the
  vault looked unreadable. It carries the BUY_LIST shape (`user.kod:5741`), where the per-item
  u32 is `GetVaultRetrievalFee` rather than a price. Chest contents still have no such packet
  parsed — a look answers with prose — so a chest slot fills only when something records one.

  `node tools/m59-storage-test.mjs` (37) pins the ceilings against their citations and both
  never-looked-is-not-empty rules, against scratch directories.

## Buying skills, and the loadout that decides what to carry

- **A SKILL IS BOUGHT LIKE A HAT, AND FOR A YEAR NO LIVE MERCHANT APPEARED TO SELL ONE.**
  `plFor_sale` is four positional slots and `AssembleForSaleList` names them in its own
  docstring — **"(items, skills, spells, conditionals)"** (`monster.kod:4819`).
  `m59-merchants.mjs` read slot 3 as the abilities and called slot 2 `?`, so every skill
  sold by a merchant standing in the world was dropped on the floor. Nothing errored;
  `who-teaches block` simply answered with a WANDERER, because the only surviving trace
  of block was a source-derived entry for a class nobody had seen. The man who actually
  sells it — Jonas D'Accor — has been standing still in Pietro's Wicked Brews the whole
  time. Recovering slot 2 also found Rook in Cor Noth teaching **ten** skills, including
  every weapon proficiency.

  **A merchant is a CLASS; a person can wear more than one.** `RebelLiege` and
  `JealousGeneral` are both "Jonas D'Accor" and differ only in that one stands still and
  one walks a circuit — on the wire that is two ids and two class names and nothing else.
  The catalogue links them by NAME RESOURCE, and calls it the same man only when the ICON
  agrees too: the Barloque and Tos blacksmiths are both "Fehr'loi Qan" and are two
  different people, which is the counter-example that stops the name alone being trusted.

  **And the price is fixed by LEVEL with no markup** (`Skill.GetValue` skill.kod:128,
  `Monster.GetPrice` monster.kod:4880) — `250 * 2^level`, so a level 1 skill is **500**,
  not 250. That is why `m59-outfit.mjs --learn <name>` can withdraw the right amount at a
  bank before setting off, which it must: nobody in this fleet carries 500 shillings.

- **THE OFFER LIST IS FILTERED PER BUYER, AND A REFUSAL IS SILENCE.** A skill you already
  have, or cannot yet learn, is not refused — it is simply ABSENT from the shop list
  (`monster.kod:4855-4861`), with no message of any kind. So "the buy did not complain"
  means nothing, exactly as it means nothing for equipping. `--learn` re-reads
  `abilities` after every purchase and reports `paid N and DID NOT GET IT` rather than
  assuming. Whether a character *can* learn one is `PlayerCanLearn` (`player.kod:10509`),
  and it short-circuits to SUCCESS if you already know two abilities in that school at
  that level — which every character here does for weaponcraft, via *mace fighting* and
  *slash*.

- **EVERY BUY, SELL, KEEP AND DROP RULE USED TO BE ONE CONSTANT FOR TWENTY-ONE CHARACTERS.**
  `WANTS` in `m59-outfit.mjs` (a mace, leather, a shield). `KEEP` in `m59-reagents.mjs`.
  The `keep` regex in `makeRoom`. `REAGENT_TARGET` in the keeper. So a caster that needs
  forty mushrooms and a fighter that needs none were told the same number, and the only way
  to change it for one character was to edit a tool and restart the broker — which logs out
  the fleet.

  A **loadout** is that answer per character: `substrate/loadouts/<character>.json`, written
  in the compendium's planner (`P` on the fleet terminal, or
  `node tools/m59-compendium.mjs --open --to /planner/`) and read by the keeper every pass.
  `node tools/m59-loadout.mjs <name> --check` says what a character is short of; the
  `loadout` MCP tool says the same thing to an agent.

  **THE DIRECTORY IS GITIGNORED, and that reverses an earlier decision** — see the argument
  in `.gitignore`. A loadout is not a description of a character, it is an INSTRUCTION to
  one, and orders belong to the machine that gives them: committed, every clone's planner
  edits them back and two rosters hand each other conflicting orders through git, silently,
  because a loadout that parses is a loadout the keeper obeys. The SHAPE is committed as
  `substrate/loadouts.example.json`, deliberately outside the directory, because an example
  inside it would be an extra character to `listLoadouts()`.

  **IT IS AN OVERLAY, NOT A REPLACEMENT, and that is the property to preserve.** Silence
  means "carry on as before" — every helper returns `null` for an absent or empty loadout,
  and `null` means "the behaviour that was already there", never "protects nothing". A
  loadout saying only "twenty-four elderberry" must not start a character selling its
  armour. `m59-loadout-test.mjs` pins that directly: with no loadout, `skills.sellable`
  gives exactly its pre-loadout answer.

  Four things about it that read backwards:

  - **A NAMED WANT IS NOT SATISFIED BY THE FAMILY.** The fleet default says "a mace" and
    means "some weapon" — its fallback is `/sword|axe|hammer|mace/`, because one answer for
    twenty-one characters cannot be fussier. A loadout says "short sword", and a character
    holding a mace *is* missing it. The first version widened the loadout's fallback to the
    slot's family and thereby made every loadout mean what the default meant: Kermit, whose
    list says short sword and whose pack held a mace, reported `already stocked`.
  - **A FLOOR PROTECTS THE STACK UP TO THE FLOOR, so the keep test has to be able to count.**
    Twelve elderberry under a floor of twelve are all protected and the thirteenth is not.
    Asked without a pack it protects the whole stack, which is the safe direction.
  - **A CEILING BELOW A FLOOR IS A LOOP, NOT A PREFERENCE** — buy up to the floor, sell down
    to the ceiling, pay the vendor spread on every lap, for ever. `normalise` raises the
    ceiling and says so rather than honouring a pair that cannot both be satisfied.
  - **THE SELL LIST BEATS THE NAME GUARD, deliberately.** `keep` protects anything that
    *looks* like equipment or money, which is right by default and is why a character
    carrying fifty-six sapphires it will never cast with could not shed them without editing
    a regex twenty-one characters share. Worn still beats everything: `plUsing` is the
    server's own answer and no list can sell the shield off your arm.

  Keyed on the **character name**, never the agent handle — `t1` is this checkout's word for
  a roster slot, and a loadout follows the character. `loadoutFor` caches on mtime, so the
  per-pass cost is a `stat()`.

  **THE GEAR HALF IS THE ONE PART THAT IS ABOUT THE FLEET RATHER THAN ABOUT A CHARACTER**,
  and so it is the one part worth handing to all of them at once — *Apply gear to fleet* in
  the planner, or `node tools/m59-loadout.mjs <name> --gear-to-fleet --apply`. How many
  reagents a caster burns is its own business; "fight with a short sword and wear leather" is
  a decision about how the fleet plays, and saying it twenty-one times is how it ends up said
  twenty-one slightly different ways. Four things it does rather than documents:

  - **It copies `gear` and nothing else.** Every carry list, school plan, sell list, keep
    list, note and purse floor it passes over is left exactly as it was found, which is what
    makes it safe against characters somebody has already planned by hand.
  - **An empty gear list is REFUSED.** That is the ordinary state of a loadout nobody has
    filled in — not an instruction to clear twenty-one weapon preferences — and applying it
    would have reported success. `allowEmpty` is how somebody says they meant it.
  - **It plans first and the plan is the same function as the write**, `applyGearToAll` with
    `apply: false`. A preview computed by different code from the write it previews is a
    preview of something else, and this one writes a file per character.
  - **A loadout that will not parse is left alone**, not replaced with one holding only gear:
    the carry list that went missing would look like something nobody ever wrote.

  `gear.from` records which plan a character's gear arrived from, and the planner clears it
  the moment somebody edits the list — a line claiming the gear came from Kermit, over a list
  Kermit never had, is worse than no line.

## Supply: shortfalls, couriers and the trips they cause

- **A SHORTFALL THE BOARD CANNOT STATE IS INVISIBLE TO THE ONLY THING THAT FETCHES IT, AND
  A FLEET SWIMMING IN ONE HALF OF A RECIPE LOOKS WELL SUPPLIED.** `create food` is 2
  elderberry AND 2 herbs, so what a character can cast is `min(elder, herb) / 2` — and the
  fleet total is the one number that cannot say so. Measured 2026-08-11: 61 elderberry and 160
  herbs across twenty-one characters, and **twenty of them could cast zero times**, because
  the herb-rich (1/28, 1/26, 1/23) were standing next to the elderberry-rich (6/1, 6/1, 5/0).
  Read the per-character minimum, never the sum.

  Farm delivery is what is supposed to fix that, and three things stopped it:

  - **`declareInterest` merged the loadout's `wants` and `spare` but not its `needs`** — and
    `needs` is the only field `demandsForRoom` filters on. So only the two reagents with a
    hard-coded target could ever be delivered, and a caster short of forty mushrooms was
    unreachable by the mechanism built to reach it. `wantsOf` now returns quantities;
    **`wants` is a name for "may somebody sell this", `needs` is a number for "how many
    should a courier buy", and a want with no quantity is not a delivery order.**
  - **The recipient list was frozen at pickup.** A courier polls, walks to the apothecary,
    walks back — minutes — and the fleet has moved. Iterating the frozen list and looking
    each name up gave "farmer left the room or is dead" and carried the goods home. A
    delivery is now **addressed to a PLACE**: the board is re-read on arrival and the cargo
    goes to whoever is standing there and short, polled or not.
  - **It was addressed to one room**, so a character one door away got nothing.
    `radius_rooms` (default 2, capped at 3) lets the courier walk the neighbourhood, nearest
    first, stopping the moment the cargo is gone. `roomsWithin` in `m59-map.mjs` walks the
    same three exit sources the router does, so "next door" cannot drift from what `travel`
    believes.

  Two things it now reports rather than swallows. **A counter that does not stock a kind is
  named** (`counter_did_not_stock`) — the run that exposed all this hit one counter with no
  elderberry and another with no herbs and still reported itself loaded. And **what left the
  pack is counted, not what the offer asked for**: a trade that handshakes and moves nothing
  is the same family as Skivlat saying thank you, and only the count tells them apart.

  `node tools/m59-coordination-test.mjs` (25) pins all of it, including that a stale
  declaration and a zero shortfall are both refused as delivery orders.

- **A TRIP THAT CANNOT FIX THE THING THAT OPENED IT WILL RUN FOR EVER, AND EVERY LAP OF IT
  REPORTS SUCCESS.** `bankRun` has five doors and they have different remedies: a full pack
  is fixed by SELLING, a reagent shortfall only by BUYING, and buying needs money. The
  `supply` trigger was added to `checkIfShouldSell` long after `bankRun` learned to read
  that function's answer as `packFull`, so a shortfall was routed to a **market** — Roq
  buys and sells nothing — and the character arrived with an empty pack, sold nothing,
  walked one room to the apothecary with the two shillings it set out with, was refused,
  and walked back with the condition exactly as true as when it started.

  Measured 2026-08-16: **Fozzie made the 110 → 104 round trip every thirty-five seconds for
  over five hours** — 155 `buy_declined` in one day, every one reading `spendable: 2`, 0
  kills in the last half hour — **while holding 27,282 shillings in the bank**. Twelve of
  twenty-one were in the same loop and the fleet was sitting on **666,540 banked
  shillings**. Nothing errored, nothing stalled, and `m59-supervise.mjs` had nothing to
  unstick because the character was moving perfectly well.

  Three things kept it invisible, and all three are the general lesson:

  - **Every trip that was not the food one logged `going to the bank`**, including the ones
    walking to a market. The one line an operator had named neither the destination nor the
    reason, so an hour of ping-pong read as a fleet doing its banking. The note now names
    the errand and carries the trigger and the bill.
  - **THE CHARACTER WAS NOT POOR, IT WAS ILLIQUID** — and the door for that already existed.
    `needsCashFirst` sends a character to a bank before the shop and was written for hunger;
    nobody wired it to supply. A balance buys nothing while it is in the bank.
  - **The comment saying this trip "cannot spin, because it always achieves something" was
    true when it was written** and stopped being true when the trigger was added. A cooldown
    was declined on that reasoning, so the loop ran at one lap per keeper pass.

  `townDestinations` is now the single ordered answer to "which counter", written as a table
  so the next door added is a row rather than another arm of a nested conditional, and
  `reagentGapCost` is the single answer to "what does this errand cost" — the trip and the
  withdrawal both read it, and two answers there is how a character draws pocket money for
  an 8,400sh fill and is back on the road inside the hour. There is a cooldown as well as a
  destination, because the destination fix assumes there is a balance to fetch: with an
  empty bank too, the shortfall is real and unfixable this hour and the character should be
  farming rather than walking.


## The reproduction that settled it

The rule this is the worked example of — a claim that contradicts what is already written
down needs a reproduction before anything is decided on it — is in
[`CLAUDE.md`](../CLAUDE.md).

- **A CLAIM THAT CONTRADICTS WHAT IS ALREADY WRITTEN DOWN NEEDS A REPRODUCTION BEFORE
  ANYTHING IS DECIDED ON IT — and the private server is where that reproduction goes.**
  Not every fact needs an experiment; most observations are just observations, and
  demanding proof of each would stop the work. The bar is **two things at once**: the
  claim cuts against [`CLAUDE.md`](../CLAUDE.md), these notes, the kod, or the extracted
  indexes, **and** something is
  about to be decided on it. Contradicting the literature about a detail nobody acts on
  can wait. Contradicting it about a number a resupply plan rests on cannot.

  The failure this exists to stop, **and it was checked and is WRONG**: *"Meidei only
  sells one item per call"* went into a fleet report as a constraint on feeding
  twenty-one characters. It contradicted a source-cited fact three sections above, and
  the source settles it — `monster.kod:238` declares `vbSellFromInventory = FALSE` for
  every merchant in the tree, exactly **two** classes override it to TRUE
  (`kcshopk.kod:54`, `izzio.kod:54`), and Meidei is `BarloqueBartender is BarloqueTown`
  (`bqbart.kod:11`), which is neither. **She assembles her list on demand and cannot run
  out.** Ask again and she sells again.

  The evidence for overturning the literature had been ONE ambiguous reading: a `shop`
  call whose `got` field listed a single item, with no second call, no purse reading, and
  no catalogue check afterwards. The same session had already logged `apple x10` from
  that same merchant and did not notice the contradiction. **An inventory line saying
  `x1` is a STACK SIZE, not a refusal**, and the two are indistinguishable unless you
  measure the purse. Reading a one-item response as an empty shop also had a cost beyond
  being wrong: it argued for a second food vendor the fleet does not need.

  So when the bar is met: **measure the thing that must change if the claim is true** —
  the purse before and after each call, not the wording of one response — and **repeat
  the call**, because "it stopped after one" and "I only asked once" produce identical
  evidence. A merchant refusal is a sentence spoken to the room (see the Izzio/Ko'catan
  note above), never an error on the wire, so no error has never meant success here.

  **Prod cannot answer this kind of question at all: the fleet is being driven, so the
  subject walks away mid-experiment.** Five candidates in a row were walked out of the
  shop before a second buy. That is not a flaky test, it is the bot holding movement —
  and it is why the controlled reading has to happen on the private server.

