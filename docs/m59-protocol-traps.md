# Protocol and kod traps

Split out of [`CLAUDE.md`](../CLAUDE.md). Things the wire, the server or the source will tell you wrongly if you ask the obvious way.

- **A `send` REPLY NAMES ITS RECEIVER BEFORE IT NAMES ITS ANSWER, so a bare
  `/OBJECT (\d+)/` reads the wrong number.** The maintenance socket answers

      :< return from OBJECT 0 MESSAGE FindRoomByNum (10268)
      : OBJECT 267
      :   is CLASS TosArena (10374)

  and the first match in that is the object the message was SENT TO. Asking for the arena
  therefore returned **0**, and six characters were relocated into the system object while
  every reply said success — because `UtilGoNearSquare` never says no either: handed a
  target square of (99,99) in a 24x24 room it searches outward, lands somewhere else, and
  returns 1. `returnedObject` in `m59-dm.mjs` takes the line that is only a colon and an
  object; `m59-godmode.mjs` had the same fallback for its money lookup, where it would have
  matched the player. **Verify a placement by reading the character back**, which
  `relocate --verify` does — a reply of 1 means "somebody was moved somewhere".

- **THREE MESSAGES FOR REFILLING A VITAL LOOK RIGHT AND ARE NOT.** `GainHealth` is not the
  one whose docstring says it stops at the maximum: it caps at **twice** `piMax_health`
  ("some attempt here to quell the vamp touch bugs"), so a flat `GainHealth 10000` leaves a
  50-health character reading **88/50**. `GainMana` does not clamp **at all** unless passed
  `bCapped`, which defaults FALSE. And `GainHealthNormal`, the one that does clamp, returns
  0 and changes nothing when health is already over the maximum — so it cannot undo the
  first. `m59-dm.mjs heal` reads each character's own ceiling and SETS the property, which
  is the only thing that brings an over-max character back down.

- **MAX MANA IS DERIVED, AND IT LOOKS STORED.** `piMax_Mana` is declared at 20 and the only
  thing that visibly writes it is `GainMaxMana`, so grepping for writers says "stored" —
  which is what these notes once concluded out loud, and it is wrong.
  `ComputeMaxMana` (`player.kod:6116`) throws the number away and rebuilds it from
  `GetInitialMaxMana = 15 + mysticism/5`, plus melded mana nodes, worn items and
  enchantments; it runs **on login**, on an equipment change and on an enchantment change.
  So a character set to 200 reads 200 for as long as you watch it and comes back from the
  next relog at 25. The durable lever is mana nodes — `piNodelist`, what `m59-mananode.mjs`
  exists to earn. For a test character the ceiling is the test bed's to maintain, which is
  why `m59-testbed.mjs reset` re-asserts it before healing.

- **`create automated` makes a character with ZERO in every attribute.**
  Attributes are fixed at creation and never move, and stamina *is* the
  max-health ceiling (`101 + stamina`), so such a character is capped at 102 max
  health for ever. It cannot be repaired, only re-rolled. This is why
  `m59-makefleet.mjs` exists and why you should not create characters by hand.

- **The server never says no.** An out-of-budget or malformed character request
  is not refused — it is silently replaced with `3/1/4/1/5/9` and the default
  face, and you find out weeks later. Never report a character as created
  without checking `stats_as_asked` in the `reroll` result. `m59-makefleet.mjs`
  already does this; if you do it by hand, do it too.

- **What you CARRY and what you are WEARING are two different lists.** Equipment
  lives in `plUsing`, not the inventory, and the server volunteers it: whole on
  `BP_USE_LIST`, one line per change on `BP_USE`/`BP_UNUSE`, and free behind every
  inventory request (`user.kod:955`). `client.equipment()` is the only authoritative
  answer — do not re-derive it from what a `use` was asked to do. Wielding something
  you already wield is **refused** ("your hands are too full", `player.kod:131`), so
  "no error" has never meant "equipped".

- **Ability levels are pushed, so do not poll for them.** `ChangeSkillAbility` calls
  `DrawStatSkill` on every change (`player.kod:7343`), which sends `BP_STAT` for the
  one slot that moved. Reading them costs four requests and 1.2s — the spell and skill
  LISTS have to be re-read first, because a group-3 packet is positional against
  `plSpells` and against a stale list every number is mislabelled silently. So it is
  read once after login and kept: `substrate/abilities/<character>.json`, one file per
  character, `node tools/m59-abilities.mjs` to read it.

- **The skill names are not what they sound like.** Seven of the eight weapon
  proficiencies were invented in this repository until recently: the mace one is
  called **"mace fighting"**, the sword one **"fencing"**, and axe/scimitar/hammer are
  **"wielding"** rather than "proficiency". Take them from `WEAPON_PROFICIENCY` in
  `m59-skills.mjs`, which cites each kod file. A name nothing answers to is
  indistinguishable from a skill the character has not learned — both come back null,
  which is why it survived so long.

- **A stat's `name` only exists for groups 1 and 2.** `STAT_NAMES` covers condition
  and attributes, so `statsById` files a group-3/4 stat under `"4.7"` and nothing
  else. Any by-name search of that map for a skill returns null — which is also the
  legitimate "not read yet" answer, which is why it went unnoticed for so long. Use
  `client.abilityOf(name)`, which is keyed off the object id the stat actually carries.

- **`emit(kind, data)` spreads `data` over the event.** A payload field called `kind`
  replaces the event's own, and every listener waiting on the real kind silently
  starves while the emit itself looks fine. The ability event carries `what`, not
  `kind`, for exactly this reason.

  The ledger's `recordEvent(character, kind, detail)` had the same shape and the same
  bug: a purchase whose detail carried `kind: 'elderberry'` filed itself as an
  elderberry event, so nothing searching for `bought` ever found one — and the write
  succeeded. It now applies `type`/`character`/`kind` *after* the spread, so a detail
  field of the same name is inert instead of silent. The purchase payload is
  `item_kind`. `m59-spellaudit-test.mjs` pins both halves.

- **One or two of the five Underworld portals are unlit, not all of them.**
  `ResetPuzzle` (`uworld.kod:460`) lights all five and turns one or two off at
  random, so three or four work at any moment and each has a fixed, known
  destination. An unlit one is silent, which is why the old code read a working
  pentagram as a dead one. `node tools/m59-underworld.mjs` prints the table.

## Looking at a player, and describing one

- **LOOKING AT A PLAYER IS NOT `BP_LOOK`.** `Player.TryLook` (`user.kod:4374`) diverts to
  `SendLookPlayer`, which answers with **`BP_USERCOMMAND` / `UC_LOOK_PLAYER` (2)** —
  object, an editable byte, a formatted description, then two plain strings
  (`merintr.c:1501`). This client sent `BP_USERCOMMAND` and never parsed an incoming one,
  so every `look_at` on a character timed out and blamed `OF_NOEXAMINE`, **and I read that
  silence as proof the protocol could not answer.** It can. A packet nobody parses is
  indistinguishable from a packet nobody sends, and the difference is a whole command
  space. A player in another room is refused (`user.kod:4383`); a player looking at
  *itself* is not, which is exactly what the real client's right-click-your-own-portrait
  dialog does.

- **A DESCRIPTION REPLACES THE LOOK TEXT.** The bio another player sees is
  `psPlayerDescription`, set with `BP_CHANGE_DESCRIPTION` (126) and saved with the
  character. `Player.ShowDesc` (`player.kod:1521`) sends it under the `"%q"` resource and
  **returns**, never reaching the propagate that builds the default prose — so a character
  carrying one stops announcing its own level and guild to anyone who looks. The server
  acknowledges the write with nothing at all, so `describe` records what it sent to
  `substrate/descriptions/<character>.json` and `m59-describe.mjs --verify` goes and looks:
  the record is the claim, the look is the evidence.

  Two traps. **Clearing is not undoing** — `""` is not `$`, so an empty description is a
  *blank* bio, not the default text, and there is no way back short of a re-roll
  (`user.kod:4444` reads a nil string as "keep the old one"). And **the wire is Latin-1**:
  `pstr` is `Buffer.from(s, 'latin1')`, which keeps the LOW BYTE of anything above
  U+00FF, so an em dash goes out as `0x14` and nothing errors. `cleanDescription` folds
  the punctuation people actually type and drops what it cannot fold.


## Players, flags and self-defence

- **THE RED NAME IS ALREADY ON THE WIRE, AND `PF_*` IS AN ENUM RATHER THAN A BITMASK — SO
  THE OBVIOUS TEST OPENS FIRE ON EVERY DUNGEON MASTER.** The client colours a player's
  name from nothing but its object flags (`GetPlayerNameColor`, `clientd3d/color.c:619`):
  red for a killer, orange for an outlaw. Every room description we already receive
  carries it; this repository simply never read it.

  The bits live in `OF.PLAYER_MASK` (0x1C000) as an **enumerated field**, and
  **`PF.DM` is 0xC000, which is exactly `PF.KILLER | PF.OUTLAW`**. So `flags & PF.KILLER`
  is true for every DM on the server. The game's own client `switch`es on the masked
  value; `playerClass()` in `m59-parse.mjs` does the same, and `flaggedAggressor()` is the
  only predicate anything defensive should ask.

- **THE SERVER IS THE SAFETY, AND THE RIGHT MOVE IS TO LEAVE IT ON.** `PFLAG_SAFETY` is a
  real server-side flag, not a client courtesy, and `Player.CheckStatusAndSafety`
  (`player.kod:3767`) says what it does in its own docstring: *"PFLAG_SAFETY prevents
  accidental attacks. **You can always successfully hit a murderer or outlaw, though.**"*

  So with safety ON the server does exactly the discrimination a defensive fleet wants:

  | | with our safety ON |
  |---|---|
  | attack an ordinary player | **refused** — *"Hey! You almost hit %s%s! Good thing your safety was on!"* (`player.kod:177`) |
  | attack a murderer or outlaw | allowed, and the outlaw-granting branch is skipped entirely (`player.kod:3816`) |
  | **kill** a murderer or outlaw | `piJustified_kill_count`, **no** murderer flag, **no** outlaw flag, no faction loss (`player.kod:4841`, `:4856`) |

  Turning safety off to fight back would be strictly worse: it buys nothing we need and
  removes the interlock. `defend_against_players` therefore never touches it.

- **A MONSTER DOES NOT COME BACK TOMORROW, SO SELF-DEFENCE NEEDS A MEMORY AND THE MEMORY
  IS THE FLEET'S.** `m59-grudge.mjs` records who attacked us, fleet-wide, for an hour. One
  character being hit is everybody's information — that is what lets eight fleetmates in
  the room defend the one that got hit, and what lets any of them recognise the same
  person later in another town.

  **Three things must all hold before a swing**, and only the first is ours to get wrong:

  1. the **grudge** — this name attacked one of ours inside the hour;
  2. the **live flag** — the object in front of us is carrying `PF_KILLER` or `PF_OUTLAW`
     *right now*, re-read every time and never taken from the record;
  3. the **server's own safety**, above.

  **It is keyed on the NAME, which is the weaker key, and deliberately.** Everything else
  here insists on the object id — but that rule exists because a live session gives the
  server's own answer, and **a stranger gives us no session**, while object ids are
  renumbered on every save. An hour-long grudge keyed on an id would outlive the id. The
  cost is bounded by rule 2: to be hit under a coincidental name you must *also* be
  currently flagged, which the server permits and penalises nobody for.

  `node tools/m59-grudge.mjs` reads the book; `--forgive <name>` and `--clear` empty it.
  It is **gitignored**, because every row is an accusation against a named real person.

  `node tools/m59-grudge-test.mjs` (48) is the contract test, and the DM assertion in it
  should never be deleted.


## DID THE CAST EVEN START? THE REAGENT ANSWERS; THE REPLY DOES NOT

A cast has three outcomes and the harness's replies collapse them into one. The keeper's
`/action {name:'cast'}` returns `{sent: true, spell, targets}` whether the spell landed,
missed its roll, or was refused before it began, and the broker's `cast` tool on a
keeper-backed character reports `cast: true` off a snapshot. Neither is evidence.

**`CanPayCosts` takes the reagent and the mana UP FRONT, before `BeginCastingTrance`
(`spell.kod:1820`), and only the effect arrives at the far end.** So the reagent count is
the test for whether a cast BEGAN, and it separates the two failures that look identical:

| observation | what happened |
|---|---|
| reagent count **unchanged** | the cast never started — refused up front |
| reagent **gone**, no effect | it started, then missed the roll or was interrupted |

The commonest reason for the first row is **the character was already casting**, and the
server says so with `"You find yourself unable to cast a spell."` — a sentence to the room,
not an error on the wire. Measured 2026-09-09/10: five `identify` attempts on Loial the
Ogier returned `sent: true` with his orc-tooth count frozen at 16, and the cause was this
session's own karma pump casting hospice on the same character throughout. Two independent
sessions each spent about an hour on it, and one of them (mine) concluded from the silence
that **the harness could not cast at an inventory item at all** and wrote that down. It can:
`{spell: 'identify', target: <object id>}` works — the spell wants a NAME and the handler
reads `target` SINGULAR (`m59-keeper-process.mjs:3593`), so `targets: [id]` is dropped and a
targeted spell with an empty list is refused with no message.

Two further traps on the same path:

- **`holdMs` may be inert.** The keeper freezes its tick loop only when `session._tickLoop`
  exists; where it does not, the option is accepted and does nothing, and the reply says so
  by omission — no `frozenMs`, no `timedOut`. A reply of exactly `{sent, spell, targets}`
  means nothing was frozen.
- **A trance is longer than it looks.** `identify` is `viCast_time` 15000 scaled by
  `(150 - spellpower)%`, up to ~22s. Retrying inside that window is your own casts breaking
  each other, and the server calls it
  `"Your concentration is broken and the identify spell fizzles."` Poll for at least ~32s.

And the effect itself may not be a message: `identify` arrives as a **LOOK event carrying the
object id**, so polling `/state` sees nothing at all. `substrate/hooks/identify-loot/errand.mjs`
has a `castAndRead()` that tells the three outcomes apart.

**The general rule this keeps re-teaching is the one in CLAUDE.md: read the value that must
change, not the instrument's own account of itself.** The reagent is that value for a cast,
the room number is that value for an edge crossing, and max mana is that value for a mana
node.
