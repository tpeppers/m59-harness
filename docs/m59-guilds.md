# Guilds

Split out of [`CLAUDE.md`](../CLAUDE.md). A command space that refuses in total silence.

For shared reagent storage, chest reserves and the 20% shared-money tithe, see
the [reagent coop](m59-reagent-coop.md).

Rent payments to Frular are public and separate from the secret chest visit.
After each payment, the payer uses FleetScript's shared NPC-speaking method to
approach Frular, verify it is within hearing range, and ask `rent`. It waits past
its own echo and unrelated messages for the actual rent answer, and refreshes
the shared rent cache. An unsuccessful approach prevents speech and leaves the
new balance unknown.
Payment receipts and the durable daily tithe book retain `due_after`,
`credit_after`, `rent_checked_at`, and `rent_check_ok`. A failed balance check
reports an unknown balance while retaining the verified payment; it never
repeats the payment or substitutes the previous cached balance for a fresh answer.

- **A GUILD COMMAND IS REFUSED BY TOTAL SILENCE — NOT A SENTENCE SPOKEN TO THE ROOM, WHICH
  IS THE REFUSAL EVERYTHING ELSE IN THIS FILE WARNS ABOUT, BUT NOTHING AT ALL.**
  `User.UserGuildCommand` (`user.kod:4848`) tests the caller's command bitmask and, when the
  bit is absent, takes the else branch: `Debug("Player ... trying to use a guild command he
  doesn't have!!!")` and returns. That line goes to the **server log**. The player is sent no
  message, no resource string, nothing on the wire. So for fourteen commands — invite, exile,
  set_rank, abdicate, vote, disband, the four alliance/war verbs, abandon_hall, set_password
  — an under-ranked send is **byte-for-byte identical to one that worked**.

  `m59-guild.mjs` is therefore a permission check that runs BEFORE the send, against
  `piGuild_commands` as the server itself handed it over in `UC_GUILDINFO`. Ask with the
  FLAGS, not with the rank: `ResetPowers` only re-runs on a rank change (`guild.kod:562`) and
  `RemoveGuildCommand` exists, so a bit can be missing from a rank the table says holds it.
  `mayI()` accepts either and says which it used.

  **The rank table has an asymmetry somebody will try to tidy up.** Invite is **LORD (3)**
  while exile and set_rank are **LIEUTENANT (4)** — there is a rank that can recruit and
  neither expel nor promote. `set_password` declares no `viRank_needed` of its own and
  inherits `GuildCommand`'s default of **MASTER** (`guildcmd.kod:41`); reading the absent
  declaration as "unrestricted" is the natural mistake and is wrong in the permissive
  direction.

  Four more things that read backwards:

  - **THE INVITATION IS AN OBJECT IN THE INVITEE'S PACK AND IT DIES IF EITHER OF THEM WALKS.**
    `SomethingLeft` and `OwnerChangedOwner` (`invitat.kod:145,155`) both delete it when the
    inductor OR the inductee leaves the room. It lives **two minutes** — `SELF_DELETE_DELAY`
    is 120000, and the invite command's own description resource saying "1 minute"
    (`gcinvite.kod:22`) is wrong. And `CheckInvitationList` allows the inviter exactly **one
    outstanding invitation**, refused with `return FALSE` and no message. So inducting a
    fleet is strictly serial with both parties standing still; a fan-out reports twenty
    successes and inducts one. `guild action=induct` is that choreography, and it plans
    unless `apply` is true.
  - **JOINING NEEDS `PFLAG_PKILL_ENABLE`, AND SO DOES FOUNDING.** Base max health 30 sets it
    (`EvaluatePKStatus`, `player.kod:11047`). Under that, `use` on the invitation is refused
    — *after* the inviter has burned its one slot for two minutes. Every character in this
    fleet is well past it.
  - **A HALL NEEDS THE GUILD MATURE, WHICH IS TICKS AND NOT A CLOCK.** 30 maintenance ticks
    of 6 minutes — three hours — for a plain guild, 60 for a secret one, and the tick only
    counts down while a member is logged on (`guild.kod:692`). **The last tick is conditional
    on three members** (`guild.kod:705`): a two-member guild holds at 1 for ever, three hours
    in, looking finished. Price is `quality * 5000`; `GetRentValue` is **hourly** but the
    packet carries `24 *` it, so the wire figure is a day.
  - **THE 50,000 WAR FORFEIT IS PREPAID RENT, NOT A PURSE.** `declare_war` is refused unless
    the guild's rent account is that far in credit (`guild.kod:2290`), so no character
    carrying the sum satisfies it. And only a **mutual** war can cost it: `UC_GUILD_LIST`
    carries four id lists and the last two are the one-sided `declared_*` forms, which the
    `guild list` action keeps separate for exactly that reason.

  Founding is 5,000 from the **purse**, not a bank balance (`system.kod:243`), standing next
  to Frular in **room 700, The Guildmaster's Hall** in Barloque. **There is no way to rename a
  guild** — the only correction is disband and pay again — so `validateGuild` checks the name
  and all ten rank titles first. Ten, not five: five ranks × two genders, flat, in the order
  `user.kod:1697` reads them, and the wrong order does not error, it gives every woman in the
  guild a man's title for the life of the guild.

  **SPREADING A GUILD ACROSS A FLEET IS A DIFFERENT OPERATION FROM GATHERING ONE, AND ONLY
  ONE OF THEM IS FREE.** `guild action=induct` walks everybody to one room, which costs each
  of them its errand. `guild action=spread` walks nobody: it asks each guilded character who
  is ALREADY standing next to it, invites those, and promotes them so they can do the same
  wherever they drift. A fleet that hunts together converts itself over a few rounds for the
  price of no travel at all — and a round that invites nobody stops early rather than
  spinning.

  **`promote_to` defaults to 4, lieutenant, and 3 would not do.** Rank 3 (lord) is enough to
  invite but NOT to promote — `set_rank` needs 4 — so a fleet promoted only to lord would
  recruit one generation and then dead-end, every new member able to invite and none able to
  pass the power on. That asymmetry is reported per invitee rather than silently leaving a
  member who cannot continue the chain.

  **WHO COUNTS AS OURS IS MATCHED BY OBJECT ID AGAINST THIS BROKER'S OWN LIVE SESSIONS,
  NEVER BY NAME.** `prod` is a shared server with real players on it and an invitation is an
  outward-facing act addressed to a stranger. Names are chosen by their owners and two
  characters can be made confusingly alike; a session's object id is the server's own answer
  to "is this a character this broker is driving". The map is rebuilt every call, because a
  rejoin changes the object id and a stale one could carry an id that now belongs to somebody
  else.

  **A RANK IS A SEAT AS WELL AS A PERMISSION, AND ONLY ONE RANK IS RATIONED.**
  `MAX_LIEUTENANT = 2` (`guild.kod:49`): `NewLieutenantOkay` counts the members already at
  rank 4 and refuses the third. `NewLordOkay` is two lines whose own docstring says
  *"Currently, always returns TRUE"*, so **lord is unlimited**. Measured live 2026-08-12:
  Piggy promoted Lew to lieutenant and was then refused for five more, all of whom stayed
  apprentices — **and the refusal goes to the PROMOTER, so from the member's side it is
  silent**, which is how a spread can report five promotions and produce one. So "promote
  everyone to the second-highest rank so they can recruit too" is not possible and is not
  needed: **invite needs only LORD**, which is uncapped. `promote_to` defaults to 3 for that
  reason, and `guild action=promote` exists separately because a promotion — unlike an
  invitation — needs neither the same room nor the same moment.

  **THE HALL LIST AND THE FOUNDING PRICES ARE PUSH-ONLY, AND WHAT TRIGGERS THEM IS A
  SHOPPING REQUEST THAT DELIBERATELY SELLS NOTHING.** There is no `UC_GUILD_HALLS` request:
  `merintr.c` lists it in the incoming table and NOT in `user_msg_table`, and `user.kod` has
  no branch for it — sending one reaches *"got unknown UserCommand"*. This repository had
  such a sender and it was silent in the usual way. What produces both dialogs is
  `GuildCreator.GetForSale`, whose own docstring calls itself hacky: *"user.kod:UserBuy()
  aborts if it gets $ returned from here, so we can use it as a hook"* (`gcreator.kod:250`).
  So **`shop` at Frular looks like a merchant with nothing for sale, and that is the same
  call**. A hall list can only be obtained standing in front of him.

  **AND THE SILENT-REFUSAL RULE IS NOT ONLY ABOUT PERMISSION BITS.** `guild action=spread`
  had two live failures that both came from trusting the wrong source for membership. A
  fresh broker found ZERO inviters inside a guild of six, because `client.guild` is filled
  only by `UC_GUILDINFO` and **nothing volunteers guild membership at login** — unlike
  health or equipment. Then a whole round spent eleven inviters on one character who was
  already a member, each told *"This person already belongs to your guild"* and none getting
  a scroll, which the slot-guard read as a burnt slot. **The roster is the answer to both**:
  `UC_GUILDINFO` carries every member's OBJECT ID (`user.kod:2020`), the same id our sessions
  carry, so one read identifies the whole fleet exactly. Ask the guild, not the characters.

  **PAYING RENT IS AN OFFER THAT THE SERVER REFUSES, AND THE REFUSAL IS THE SUCCESS.**
  `GuildCreator.ReqOffer` (`gcreator.kod:325`) intercepts the offer, sums its value,
  subtracts it from the payer's purse, credits the guild with `PayRent`, says *"I thank thee
  for thy payment"* — and returns FALSE, which cancels the trade. So the dialog closing with
  nothing handed over is exactly what a successful payment looks like, and the only proof is
  the purse going down. **`m59-tithe.mjs` owns all of that** — the payment, the rent parser,
  Frular's constants, a durable once-per-day book keyed `<fleet>-<agent>`, and the
  `guild_tithe` keeper policy that lets a bot tithe out of its sale proceeds without being
  asked. `m59-guild.mjs` re-exports the rent half rather than keeping a second copy: both
  files grew a `parseRentLine` on the same afternoon, from the same kod, and agreed by luck.
  The broker's `tithe` tool is a thin wrapper over that module and writes to the book **only
  the verified purse delta**, never the amount offered — recording the offer would make a
  refused tithe look paid for the rest of the day, which is exactly the day the fleet would
  then skip. The book's fleet name goes through `fleetName()`, the same resolver as every
  other fleet tool: the keeper had its own argv/env reading with a literal `default`
  fallback, so a broker started with no `--fleet` but a recorded `substrate/fleet-default`
  wrote `default-t14` while the tool read `prod-t14`, and `paid_today` would have read zero
  all day. **And the balance is prose sent once, exactly like a bank balance**: no packet,
  Frular answers the spoken word `rent` (`gcreator.kod:97`).

  **UNVERIFIED, 2026-08-12: Frular did not in fact answer `rent` when asked.** Piggy, a
  guildmaster standing in room 700, said it twice and got back only its own echo — and got
  nothing for the other keyword branch either (a guildmate's name, which `SomeoneSaid` should
  answer with active/inactive for a speaker of rank LORD or above). `MOB_LISTEN` is set
  (`gcreator.kod:74`), so either the speech never reaches his `SomeoneSaid` or something
  earlier in `Monster.SomeoneSaid` (`monster.kod:2581`) returns first. **Do not treat
  `tithe action=status` as working until somebody reproduces it**; the parser is pinned
  against the three sentences and is fine, but nothing has yet produced one. The paying half
  does not depend on it — `ReqOffer` is a different path entirely — though that too is
  untested against a guild that actually owes rent.

  THE SIGN IS THE WHOLE
  MEANING — *"owes N coins"* is a debt, *"has a positive balance of N"* is credit already
  negated for display. Worse, *"Thou belongest to no guild, and thus owest no rent"* CONTAINS
  the zero-rent phrase, so a parser that tests for zero first reads "this character has no
  guild" as "this guild owes nothing".

  **The Bookmaker's Guild House is room 714 and the general price formula gets its rent
  wrong.** Quality 5, so 25,000 to buy — but it overrides `GetRentValue` with a doubling of
  its own (`guildh14.kod:191`), giving 500/hour and **12,000 a day**. On a non-PK server
  that coincides with the non-PK doubling and one of the two is invisible; on a PK server the
  general formula would understate it by half. `KNOWN_HALLS` carries the real numbers with
  the citation, and `guild action=fund_hall` plans the pooling — **plan only, always**,
  because executing it is a dozen bank trips by characters whose keepers own their movement
  and money already moved cannot be rolled back. A hall is paid from the **buyer's purse**,
  so every banked contribution is a detour to Tos or Jasper first — never Barloque.

  `node tools/m59-guild-test.mjs` (192) pins the permission check, the four packet layouts
  against server-built fixtures, the title ordering, the rent sign and its overlapping
  sentences, the Bookmaker's override, and the pooling arithmetic.
