# The Sword of Riija, in three phases

The Monk of Riija (Ko'catan, room 2151) teaches Riija spells only to someone **wielding** a sword
of Riija bound to themselves (`kcrjmonk.kod` `CanAddSpell`). The sword assembles itself the moment
a character holds all four shards earned by the same quester (`swshard.kod:52-150`). The full
derivation with kod citations is `m59-research/reports/riija-sword-quest.md`. The data the scripts
share (rooms, NPC lines, both of Wulfgang's tables, the manifest, the pit puzzle) is
`tools/m59-riija.mjs`. Tests: `node tools/m59-riija-test.mjs` (21, offline).

| shard | NPC, room | say | what completes it |
|---|---|---|---|
| A tip | The Bone Priestess, **2141** | `riija` | an orc pit boss head (anyone's kill), within 1 h |
| B blade | Bahal zax'Ot, **2136** | `kohuzotz` | a live dragonfly queen from Cliff Hive **2111**, charmed with a meat pie and escorted into his hut, within 1 h |
| C crosspiece | Wulfgang zax'Ak, **2101** | `inventory` | the one shipment he names from his karma table, in one stack, within 1 h |
| D handle | Hanla zax'Ta, **2100** | `arrows` | good: nerudite to the Bone Priestess, feather back to Hanla. Evil: the quester kills an avar shaman and picks up the feather |

Speech counts only within five squares (squared distance 25). Karma must be **>= +10 or <= -10**.
Anything in between gets nothing from Wulfgang or Hanla, and the quester refuses that case before it
asks. Each node lasts one real hour. A failure locks a retry for one logged-in hour.

## The phases

All three are FleetScripts. Run them from the fleet REPL (`node tools/m59-fleet-repl.mjs --fleet <f>`,
`dry <script> ...` first). Each one resumes where it stopped. No public file names a character.

```text
# 1. PREP: stock hall 713 for the quester's side. Start with `plan`, which is read-only.
riija-prep agents=<courier> side=good mode=plan
riija-prep agents=<courier> side=good mode=buy where=island          # Moxal pies, Wulfgang apples, Tepal ore -> 713
riija-prep agents=<courier> side=good mode=buy where=mainland items=herbs,elderberry,mushroom,waterSkin
island-trip agents=<courier> task=riija-prep taskParams={"side":"good","mode":"deposit"}
riija-prep agents=<courier> side=good mode=dispense                  # Duke's Feast Hall 953: grapes (ale for evil)
riija-prep agents=<courier> side=good mode=draw fromHall=714 items=jewelOfFroz

# 2. PIT BOSS HEAD: team of four, first agent to chamber A, the rest to chamber B
riija-pitboss agents=<a>,<b1>,<b2>,<b3> [lever=<b1>] [holder=<a>] [stow=hall]

# 3. QUESTER: per shard, ask -> draw from 713 -> deliver -> verify; then prove and wield the sword
riija-quester agents=<quester> [shards=C,D,A,B] [home=<room>]
island-trip agents=<quester> task=riija-quester taskParams={"shards":"C,D,A,B"}   # from the mainland
```

**Prep** reads the hall's last chest readings (`m59-hall-chests.mjs --hall 713`) and compares them
with the side's manifest. The manifest is Wulfgang's whole table for that side, a chunk of nerudite
on the good side, `queenPies` spare pies, and the head. Each lap fetches at most `cap` of one item.
Use `skip=elderberry` (any manifest key) to fetch a row only when it is asked for. The courier must
be able to enter 713, which means being a guild member or ally of rank sir or higher.

**Getting to chamber A.** Grog's Antechamber (2507) has one door from the caves: the Archaic
Hollows' (2502) **north** edge (`orccave3.kod:68`, landing r164c25; the way back, `orcpita.kod:70`,
lands r3c41). Brog's (2508) is entered the same way over 2501's north edge (`orccave2.kod:67`).
The Hollows' north edge is the top of a corridor on its upper shelf (floor 9600), which the lower
Hollows cannot climb to, so `travel 2507` from where 2501 lets you in bounces and gives up after
25 hops. Chamber A's agent therefore takes the island's admitted Hollows transit and turns north at
the upper passage (`enterGrogsAntechamber`, `tools/m59-island-route.mjs`; `grog-antechamber
agents=<a>` on its own). It needs running vigor for the declared r40c33 > r40c29 crossing. Inside
2507 the corridor meets the chamber only through a ceiling-lift door at r92 that a `go` from
r93c24-26 opens for 60 s (`orcpita.kod:76-85`); that door is not yet confirmed live.

**Pit boss.** The lever at 2508 r48c29 solves the puzzle when the users in chamber A (2507) and
chamber B (2508) satisfy the kod's arithmetic: `A*3=B`, `A*2=B` or `A*2=B*3`, which is 1:3, 1:2 or
**3:2**. The kod comment's "2/3" is wrong, and 2:3 does not solve. Every user counts, so a stranger
in a chamber breaks the ratio. A barrier keeps the four bodies together: if any one is off its
square, all four stop before the lever. One farm posture on "orc pit boss" covers the boss and the
`OrcPitBossBody` it leaves behind. The head drops when the body dies. The holder loots it, plus a
mystic sword if one dropped (that is the evil table's cheapest row), and deposits both in 713.

**Quester.** It first draws a kit from 713 containing only what is certain to be needed: the head,
the ore on the good side, and pies. Then it asks each NPC. Wulfgang's request line goes into the
questbook (`substrate/questbook/<fleet>/`, gitignored) before anything else happens. The quester
then draws exactly that row and hands it over. Each shard is read back by class and by its binding
sentence. On a re-run, an open node resumes without being asked again. When an expired node has
failed on the server and the cooldown has passed, `reset=true` clears it from the questbook. Bahal's
leg waits for a queen to spawn, charms her, and escorts her hop by hop: at each exit it stops at the
departure square and waits for the same queen. The last step proves the sword names the quester and
wields it.

## Corrections to the report

- **Wulfgang's room is 2101, not 2144.** `tpost1.kod` is `RID_JUNGLE_TRADING_POST` = 2101. 2144
  (`RID_KD4`, aliased `RID_TRADING_POST`) is the jungle clearing outside the shop.
- **The third pit ratio is 3:2, not 2:3**, as described above.
- **The "all B squares" solution can never fire.** `OrcPitB.AllBUsed` sets `bBTwo` three times and
  never sets `bBThree` or `bBFour`. The reachable outcomes are `plain` (A 900 / B 0) and `squares`
  (A 600 / B 250).

## Not yet confirmed live

The table below lists what the scripts assume and what happens if an assumption is wrong. Each
failure is loud: the step stops and says why.

| assumption | if wrong |
|---|---|
| request-line wording after the client's markup | `readShipment` refuses, and the line stays in the questbook |
| the chamber squares in `PIT` are standable | the team aborts before the lever |
| the 2507 corridor door at r92 opens to a `go` from r93c24-26, and the chamber walk passes it | the walk stops short and the team aborts at the chamber check |
| `walk(2506)` gets through while the floors are moved (the moving `SOLUTIONSECTOR` is not baked into `m59-variable-sectors.json`) | the walk is refused, and the team aborts at the boss-area check |
| the keeper engages a level-115 boss, and an avar shaman on the evil route | `harvest` times out |
| `loot` takes the head and the feather off the floor | the holder or quester check fails |
| Tepal sells nerudite after `precious stones`; the Feast Hall dispensers' names and access | the prep lap reports nothing bought or dispensed |
| the queen follows across each hop | the escort stops and the node stays open |

Shop prices, Feast Hall access and the east-tower guard on the way into the jungle are covered in
the report. An evil captain takes a 1,000-shilling bribe (`kcguardE.kod:96-126`).
