# Playing Meridian 59 as an agent

For any agent — Claude, Codex, a local model — driving a character through the MCP
broker. It is about the **rules of the world**, not the wire protocol: what the
server will and will not let a character do, and which refusals arrive as text
versus which arrive as silence.

Every rule here is cited to the kod that enforces it, in `C:\code\meridian59\kod`.
Every rule here has also been checked against the live server by
`tools/m59-play-test.mjs`, which re-runs the claims and reports which ones held.

You are playing alongside humans. They see your character in `who`, they hear you
speak, and they can kill you. Nothing about your session is privileged.

---

## If you only read one section

Most of this document explains *why* things work. If you just want to play, six tools
cover it:

```
join                      log in
look                      where you are, what is there, and the minimap
fight <creature>          the whole engagement in one call
rest_up                   sit until recovered
travel <room>             go somewhere
autopilot                 keep the character alive between your turns
```

`fight("spider")` finds the nearest match, wields your best weapon, walks to a square
beside it through the real geometry, turns to face it, swings on the server's clock,
reads your health between rounds, breaks off if you are losing, and picks up the
drops. Doing that by hand is a dozen calls, every one of which can fail silently.

Two things that will otherwise catch you out:

- **Do not batch tool calls.** The server discards everything past five packets a
  second, without saying so. Act, read the result, act again.
- **Dying drops everything you carry**, and you wake in the Underworld, which has no
  ordinary exits. `escape_underworld` gets you out; `autopilot` does it for you.

The rest of this document is the detail behind those.

---

## The first thing to understand: most failures are silent

This is the difference between an agent that plays and one that appears to play.
The server drops illegal actions on the floor far more often than it complains.
There are three separate rate limits, and **all three fail without a message.**

| limit | value | what it drops | where |
|---|---|---|---|
| packets per second | more than **5** | attack, cast, use, unuse, get, activate, apply, offer, look, object contents, rest, stand, go | `user.kod:50`, checked at `user.kod:883` |
| attack/cast interval | **1 per second** | the attack or spell itself | `player.kod:5305` `IsOkayAttackTime` |
| movement | ~**1 move per second** | nothing, but you are logged as a suspected speedhacker | `user.kod:61` `MOVEMENT_COUNT_THRESHOLD` |

Exceed the packet throttle and kod sets an internal `bSpam` flag for the rest of
that second; the affected handlers `return` immediately. From your side the
request simply never happened. Measured on the live server: **12 `look` requests
sent in one second produced exactly one reply and no error.**

**The broker paces every request for you.** That is its main job. A tool call
returns only after its request has actually gone out, so ten `attack` calls take
ten seconds instead of producing one attack and nine silences. If a tool seems
slow, that is the game's clock, not overhead — check `queued_requests` in
`status` to see how far behind you are.

The practical consequence: **do not batch.** Decide, act, read the result, decide
again. An agent that fires off six tool calls in parallel is throwing five of
them away.

### The silent failure that bites agents specifically: the 30-second hangup

`GameProcessSessionTimer` (`game.c:99`) hangs up any session it has not heard
from in `[Inactive] Game` seconds, **default 30** (`config.c:99`). Nothing is
sent when it fires. The session just ends, and the next tool call reports "not in
game" as though the broker had lost its mind.

For a human client this never happens; for an agent it is the normal case,
because *thinking* for thirty seconds between two tool calls is ordinary. The
broker now sends a heartbeat every 20s so this cannot happen (`startKeepalive` in
`m59-client.mjs`).

The heartbeat is **`BP_REQ_INVENTORY`, deliberately not `BP_PING`.** Answering a
ping makes the server pick a fresh `secure_token` and from then on XOR the opcode
byte of every packet it sends (`game.c:368`, `commcli.c:162`), walking the token
along a string per packet. A client that pings without implementing that
handshake scrambles its own inbound stream. The token starts at zero and stays
there as long as nobody pings — which is the only reason this client can read the
wire at all.

---

## Perception: you have to ask, and ids are everything

Nothing arrives unrequested except changes to things you already know about.

- `look` re-reads the room. Do it after anything that might have changed the
  world, and always after moving.
- The server sends incremental updates — something appeared, something moved,
  something vanished — only for objects it has already told you about. It never
  volunteers a fresh list.
- **Your own moves are not confirmed.** The room builds a move packet for
  everyone else in the room and deliberately skips the mover
  (`room.kod:2325`, "People need to know they moved" — the mover gets an internal
  state update, not a packet). Verified live: no reply at all. Never dead-reckon;
  re-read.

Every action takes a numeric **object id**, and ids come only from `look`. They
are not stable across a server restart or a `save game`. Re-read rather than
caching across a long gap.

### Let the flags tell you what is possible

Each object carries flags saying what the server will accept, and the broker turns
them into a `can` list (`proto.h:357`):

```
"name": "Pacal ix'Anoak", "id": 913, "distance": 1, "can": ["buy", "offer", "look"]
"name": "living tree",    "id": 8210, "distance": 1, "can": ["attack"]
"name": "cooking cauldron","id": 908, "distance": 4, "can": []
```

Requests are scarce — four per second, spent by the broker on your behalf. Reading
`can` before acting is the cheapest possible way not to waste them. An object with
`can: []` will refuse everything.

`look_at` gives you the prose a human reads. It is also how you learn what a thing
*is* when the name is unhelpful — several objects are literally named
`"something"` until examined.

---

## Space: rooms, squares, and how you leave

A room is a grid of `piRows` × `piCols` squares, 1-based. Positions are reported
as `col`/`row` squares; distances are in squares.

Coordinate order changes at legacy subsystem boundaries. MCP movement uses named
`col`/`row` fields (and movement helpers are column first), while room geometry
and KOD grids use `(row,col)`; movement coordinate bytes are serialized Y then X.
In human-facing text, write `r30c61` or `row=30, col=61`, not an unlabeled pair.
`rNcM` is prose notation, not a command argument. See
[`m59-coordinates.md`](m59-coordinates.md) for units and the stable serialized
exceptions.

**The server does not check walls for player movement.** `UserMove`
(`user.kod:2914`) calls `Room.SomethingMoved` directly, which records the new
position and never consults room geometry. The geometry check
(`ReqSomethingMoved`, `room.kod:2042`) exists but is only ever called for monsters
and dropped items — its own comment says user moves "have already been checked by
client (HAHA!)". The protocol therefore lets an unchecked custom client walk
through walls. The broker must never use that as permission: ordinary movement
follows the room grid, and fine movement locally applies the official client's BSP
wall, radius, elevation, slope, and headroom rules before sending a coordinate.
At the protocol level:

- an unchecked client can write any in-room coordinate, including one through a wall
- but a squared distance of 200 or more in under three seconds is logged as
  possible cheat-teleporting (`user.kod:3071`), so **walk, do not jump**
- moving drains vigor in proportion to speed squared (`EXERTION_PER_MOVE = 2`)
- speed above `USER_WALKING_SPEED = 18` is running, and running with vigor below
  10 snaps you back to where you were

Use `walk_to` and `approach`. Ordinary square walking locally validates each emitted
segment, predicts accepted positions between periodic/hop-boundary room reads, and
stops with a concrete collision/state reason when it cannot make progress.

### Leaving a room

**Three** mechanisms, and they are not interchangeable. The third one is invisible to
every runtime query, so read that part even if you think you know this:

1. **Walk off the edge.** A move past row 1/`piRows` or col 1/`piCols` calls
   `StandardLeaveDir` (`room.kod:2645`), which looks up the direction in the
   room's `plEdge_Exits` and hands you to the destination room. This is how
   outdoor rooms connect. Some entries are **conditional** — the same boundary
   leads to two different rooms depending on where along it you crossed, and the
   condition is checked against the square you were standing on, not the one you
   moved to.
2. **Stand on the exit and `act go`.** `BP_REQ_GO` asks the room
   `SomethingTryGo` for whatever is under your feet — doors, stairs, portals
   (`user.kod:1164`, dispatching to `UserGo` at `user.kod:5656`). The match is
   `row = First(i) AND col = Nth(i,2)`: an **exact square**, not a radius. One
   square off and nothing happens at all.

3. **Walk into a region the room class watches.** A room can override
   `SomethingMoved` and hand you to a neighbour when your new square falls inside a
   coordinate test. **This exists only in the `.kod` source.** It is not in
   `plEdge_Exits`, not in `plExits`, and not visible over the maintenance socket or
   the game protocol — the room object simply does not record it.

   Marion is the case that proves it matters. Its `plEdge_Exits` is `$` (nil) and its
   `plExits` are four shops and a locked crypt gate, so **every data source agrees the
   town has no way out**. It has two:

   ```
   SomethingMoved(what, new_row, new_col)
      if (new_row < 32) and (new_col > 66)   -> RID_C4   % the northeast sliver
      if (new_row > 83) and (new_col > 48)   -> RID_C5   % the southeast sliver
   ```

   Walk into either corner and the room moves you across. There is nothing to press
   and no message beforehand. Twenty-three characters of mine sat in Marion because I
   trusted the room object over the source. `m59-codeexits.mjs` extracts these from
   the kod tree — eleven rooms have them, including the Graveyard of Tos and most of
   the deep forest — and the router now includes them as `kind: 'region'` exits.

Interior rooms like shops have **no** edge exits whatsoever. If you are in one and
walking does nothing, you need `act go`, not a different direction. And a character
parked *outside* the grid in such a room cannot move at all: every move reads as
leaving, and there is no exit to leave by.

The lesson generalises past exits: **when the room object and the source disagree
about what a room can do, the source is right.** Anything a room class overrides is
invisible to every query the protocol offers.

The `travel` tool picks the right mechanism per hop. Use it rather than doing this
by hand.

### The exit square is often not walkable, and that is not a bug

An exit square is frequently drawn as **wall** in the room's own grid, and the
direction bits of the square beside it do not open onto it. The pathfinder is then
telling the truth when it says "no route" to the only way out. The Royal Bank of
Jasper is the clean case: its two exit squares sit in a column the grid seals off
completely, so a router that trusts the geometry leaves the character stuck in the
bank permanently.

You do not have to stand on it. Movement is in **fine units — 64 to the square** —
and the broker locally clips the requested point to the closest legal fine position.
Requesting the exit square from the square next door can therefore slide you hard
against the doorway, close enough for `REQ_GO` to find the door, without sending a
coordinate through the wall. `leaveVia` does this automatically now, and
`travel`/`go_through` try **every** square a doorway publishes, in reachability
order — the bank lists two and one of them has a brazier standing on it.

One more trap in this path, since it cost an afternoon: **wait for the room
change, not for a message.** A door answers "You open the door and walk through."
a beat *before* `BP_PLAYER` reports the new room. `waitFor` returns on the first
match of any kind it is given, so listening for `['room-entered','message']`
reliably catches the announcement of success and reports it as failure.

### Ledges: the square grid cannot describe them, and the world is full of them

The movement grid is **one byte per square** — eight direction bits, 64 fine units
to the square. A walkable strip *narrower than one square* has nowhere to live in
that structure. The square reads solid, and `walk_to` refuses before sending a
packet. The fine BSP geometry still describes the ledge, but that geometry is
client-side: the broker must validate it locally because the server does not.

The cliff path in Kardde's Canyon is the sharp case — it is the **only** way into
The Badlands, and the grid marks rows 22–24 of column 20 as having no floor at
all. Verified live: `walk_to` says "no route through the geometry", and the same
walk with `fine:true` completes in fifteen steps without once needing to slide.

So: **if you can see a way and the pathfinder says there is no route, suspect the
resolution of the square grid before you conclude the way is shut.** Turn on
`movement_mode` (or pass `fine:true`) to use locally validated BSP movement. Route
normally up to the hard yard and switch to fine only for that stretch — fine mode
has no global route planning, so it can still walk into a dead end a map would have
avoided, but it will not submit an endpoint through a wall or up a cliff.

Three rules make fine movement work, and each is easy to get wrong:

- **Validate before sending.** Split a request into local microsteps, keep the
  player's radius off solid wall bodies and corners, enforce the 24-kod climb limit
  and player-height headroom using the stock client's source-facing sidedef and
  cached endpoint-0 wall heights, and slide along a blocking wall. The server accepts
  player coordinates and is not a collision oracle.

- **Confirm where precision requires it.** Fine/slide movement re-reads after each
  packet because the exact clipped endpoint becomes the next collision start.
  Ordinary grid walking predicts locally validated endpoints for speed, re-reading
  periodically and at room/door boundaries. The server does not echo accepted moves,
  so neither mode treats silence as collision evidence.
- **When locally blocked, slide.** A clipped heading usually means the straight line
  touched rock, not that the way is shut. Fanning the heading to either side is what
  "hugging the wall" is.

**Elevation is part of fine collision.** The baked `.roo` payload includes sector
floor/ceiling planes, water depth, BSP leaf polygons, and directional sidedefs. A
passable flag alone is insufficient: a passable wall still blocks when the upward
step exceeds 24 kod or there is less than one player-height of headroom. Downward
movement remains directional, so a ledge can still be a one-way drop.

### You can see the room, not just its contents

Every `.roo` file carries the room's geometry, and the broker ships all 264 rooms'
worth as data. `look` returns two pictures of it:

- the **movement grid** — one character per square, from the same walkability planes
  the server uses. `#` is no floor, `.` is floor.
- the **wall map** — the line segments the human client's minimap actually draws
  (`clientd3d/map.c`), at twice the resolution so a wall *between* two floor squares
  is visible, and doorways (`WF_PASSABLE`) show as `·` rather than as wall.

Both have every object, every exit and you placed on them, with a legend. Objects
also come back with `reachable` and `steps_to_reach`, computed by A* through the real
geometry — so you can tell "behind a wall" from "far away" without spending a minute
finding out at one square per second.

Use `walk_to`; it routes around walls. Use the picture to decide *where* to go.

---

## Combat

Before any of the checks below, `UserAttack` (`user.kod:4663`) asks whether you can
lift a weapon at all — `PFLAG_NO_FIGHT`, refused with
`"You find yourself unable to lift your weapon."` **Resting sets that flag**
(`player.kod:1162`), together with `PFLAG_NO_MOVE`, and nothing clears resting except
standing up or logging off. So a rest that was interrupted, or a safe spot you sat down
in and never got back up from, turns every swing into that line — and the combat log
reads like a fight going badly rather than like a fight not happening. `fight` stands
you up and takes the round again when it sees it. Hold, Dazzle, Blind and a DM freeze
set the same flag and standing will not clear those.

`Player.TryAttack` (`player.kod:3960`) then checks, in order. Knowing the order matters
because the first failing check is the only one you hear about.

1. **Not yourself.** Refused with a message.
2. **Attack timer.** One per second. **Silent.**
3. **Same room as the target.** Silent.
4. **Not holding a Token.** Silent.
5. **Can pay the skill's costs** (mana, vigor). Refused by the skill.
6. **Range.** `stroke.GetRange = weapon.GetRange + stroke range factor`, compared
   as *squared* distance against squared range. Refused with a message:
   `"The baby spider is too far away to hit with a short sword."`
7. **Facing.** For melee strokes and single-target spells at distance > 1, the
   target must not be behind you. Refused with a message about view, not range —
   which reads like a different problem entirely.
8. **The monster is willing to be fought**, and the PK rules allow it.

So the sequence that works is: **close the distance, turn to face, then swing.**
The broker's `attack` tool faces the target for you before every swing, and
`approach` does both. Skipping the turn is the most common way for an agent's
attacks to disappear.

Two useful details:

- **Lag is accounted for, a little.** If your target is a player who moved
  recently and you are swinging a melee weapon, range is extended by
  `RANGE_MOVEMENT_BONUS = 1` square (`player.kod:4006`) — the code's own comment
  is "a little fudge factor to account for lag drift". Ranged weapons get no such
  bonus. One square of slack is all you get; do not count on more.
- **An empty hand still fights.** With no weapon, `UserAttack` falls back to
  `SKID_PUNCH` — punch range, punch damage. So an unarmed character is not
  helpless, merely bad.
- **Attacking wakes the room.** Attacking, casting, speaking or moving calls
  `NotifyMonstersOfPresence`. There is no acting quietly.

Hit chance is `offense * EQUAL_CHANCE_HIT / defense` with `EQUAL_CHANCE_HIT = 55`, clamped to
10–95 (`battler.kod:319`), so
you always have at least a 1-in-10 chance and never a sure thing. Watch health
after every exchange: monsters swing back on their own schedule, and
`attack` returns your vitals with each swing.

---

## Getting stronger

Three separate systems. Only one of them is "kill things".

### Hit points — this is your level

`piBase_Max_health` is what other systems mean by your level.
`AdvancementCheck` (`player.kod:7736`) runs on a kill and gives more the harder the
fight was:

- the monster's level must **exceed** your max health for a real chance
- **3 points** if you took damage *and* landed the killing blow
- **2 points** if only one of those
- **1 point** if the monster was within 5 levels of you, you landed the blow, and
  you took damage
- **nothing** if it was too easy — and a 10% chance the game tells you your
  character spits in contempt
- a bonus point while you are still a newbie

Fighting things that cannot hurt you teaches you nothing. The mechanic explicitly
requires you to have been in danger.

Two consequences that are easy to miss and expensive to learn by observation:

**Prey goes worthless the instant you reach its level, and nothing tells you.**
Mummies are level 25. A level-24 character in the Mausoleum is advancing nicely; at
25 the same character in the same room with the same kills earns *nothing*, because
`monster_level > base_max_health` is now false and no roll is attempted at all.
There is no message. Fifteen characters of mine ground that room for the better part
of an hour after they had stopped gaining. Check `progress`, or check the arithmetic
yourself, but do not infer from "it is still killing things" that it is still
getting stronger.

**Do not switch targets.** The credit requires that you damaged it *and* that it was
your current target, and every new attack resets both flags. Breaking off a wounded
creature at 40% health and then attacking whatever is nearest throws away everything
the first fight earned — and leaves a half-dead monster behind to heal. `fight`
takes `preferId` for exactly this; pass back the `foe_id` it returns.

### Leaving the newbie zone: walk through the portal twice

The way out of Raza is a **portal inside the Grand Museum of Raza** — the map labels
the building "Tutorial Exit Inside". Walk onto the portal at `r2c11`. **The first
touch only warns you and bounces you off; the second one takes you.** That is the
entire mechanism. It is one-way, and `leave_raza` does it for you.

There is no door, no key, and no quest. And to be explicit, because it is the kind of
thing a stuck agent starts reaching for: **dying has nothing to do with it.** Death
is not a travel mechanism anywhere in this game. It costs a point of maximum health
permanently and drops everything you are carrying on a corpse you may not be able to
return to. The only thing `escape_underworld` is for is getting out of the Underworld
*after* you have already died.

Leave as soon as your max health reaches 25. Raza generates nothing but level-25
mummies, and advancement needs `monster_level > base_max_health`, so from 25 onward
the whole zone pays exactly nothing.

### Finding something to fight: it is a lookup, not a search

Monsters do not wander the world. Every room has a generator with a fixed spawn
table, and a creature appears in a room **if and only if that room's table names
it**. Exploring to find prey is therefore searching for something that was never
going to move, and it goes wrong in both directions: a character of mine wandered
into a castle whose table contains no vermin at all and stood there hunting rats,
and another kept dying in a room that lists giant rats at 60% *and* a level-35
groundworm larva.

`hunting_grounds` answers all three forms of the question:

- `creature` — every room that generates it, with spawn share and population cap
- `room` — everything that room generates, worst first
- `for_level` — what a character of that level should be hunting *next*

The field to read first is **`also_here`**: two rooms can both list giant rats at
60–70% while only one of them also rolls something that will kill you. Pass
`max_danger` (normally current max HP plus 50%, or 1.5 × current max HP) and
the dangerous rooms come back under
`rejected` **with the reason**, rather than being silently dropped — otherwise you
will keep re-picking the obvious room and keep dying in it.

For the schools, `karma` restricts the answer. A kill is an act worth the *negative*
of the victim's karma, so Qor must kill positive-karma creatures and Shal'ille
negative ones. Between level 30 and 50 there is no positive-karma creature a Qor
student can survive — the way through is `karma: "neutral"`, prey whose karma is 0
and which therefore moves nobody's alignment at all.

### Skills and spells — improve by use

Using a skill or spell rolls to improve it (`ImproveAbility`, `skill.kod:294`). The chance depends
on your intellect, the requisite stat, the spell's level, how good you already
are, and **how hard the target was** — `difficulty` is the target monster's level.
Practising on something trivial is close to worthless.

Two throttles you will hit:

- **`ADVANCEMENT_LIMIT = 10`** points per window, cleared every 15–22 minutes
  (`player.kod:68`). Past it, nothing improves, and the game occasionally hints
  that you should move rooms.
- **`ROOM_HARD_LEARN`** rooms divide your improve chance by ten
  (`room.kod:1399`). Towns and safe rooms are typically flagged this way. If you
  are practising somewhere comfortable, you are practising at a tenth rate.

There is also **atrophy**: when the advancement window rolls over, skills and
spells you have not used can decay (`AdvancementTimer`, `player.kod:7680`). What
you neglect, you lose.

### Some spells have targets you cannot farm

**Defile (Qor, level 3) is castable ONLY on the corpse of a player who died with POSITIVE
karma.** `defile.kod` `CanPayCosts` wants one target that `IsClass(target, &DeadBody)` and
`WasGoodPlayer`, and a corpse is "good" only when `player.kod` built it with `#good=(piKarma>0)`
(`body.kod` `pbWas_good_player`). Every monster corpse is created without `#good`
(`monster.kod`, `Create(&DeadBody, ...)`), so a skeleton or zombie corpse is refused with
*"Qor may only harvest the souls of the good at heart."* — and so is a negative-karma player,
murderer or not. The test is the dead player's karma, not their murderer flag.

So defile cannot be drilled in a farming room, however many corpses it holds. Three more rules
from the same file: the cast is refused at **3 × max mana**; it deletes the corpse; and a body
whose NAME was defiled recently anywhere on the server (`plRecent`, `DEFILE_RECENT_LIST`) neither
improves the spell nor moves the caster's karma. Found 2026-10-10, when the Qor disciples were about
to be handed fairy wings for "defile on the skeleton corpses in Castle Victoria".

### Skills and spells — learning new ones is shopping

This surprises people. You do not find a teacher and train; you **buy** the skill
from an NPC merchant using the ordinary `shop` path. A merchant's for-sale list can
contain Skill and Spell objects alongside items, and buying one calls `AddSkill` or
`AddSpell` (`monster.kod:3870`). Skills and spells are sold at face value with no
markup (`GetPrice`, `monster.kod:4880` — "No markup for skills or spells").

So: `shop` every merchant you meet and read the list. Some of what is for sale is
not an object at all.

---

## Working with other agents, and against them

Everything below is what the game actually enforces. Which conventions two agents
adopt on top of it is theirs to choose — but the conventions have to fit these.

### Giving something away is a negotiation

There is no one-sided give. `BP_REQ_GIVE` is an opcode with no dispatch table entry
anywhere in the server, so every transfer runs the offer protocol:

```
A: trade offer   -> B sees an "offered-to-us" event
B: trade counter -> may be EMPTY. This is how a gift is accepted, and it is also
                    what grants A permission to accept.
A: trade accept  -> only legal after receiving a counteroffer
```

Accepting without having been countered is logged server-side as an ALERT and
cancels the trade (`user.kod:5518`). Both parties must be in the same room. One open
trade per player at a time.

Two silences to know about:

- your offered quantity from a stack is **clamped without comment** to what you
  actually hold. The `offered` reply reports what the server accepted; read it.
- on success the **accepting** side is told nothing at all. The other side gets
  `BP_OFFER_CANCELED`, which is the *same* message it would get from a cancellation.
  Compare inventories to find out which happened.

### Money can be split; most things cannot

The offer item list has a **variable stride**: an id tagged `CLIENT_TAG_NUMBER`
carries a four-byte quantity after it. That is the entire mechanism for handing over
part of a stack — half your coins, twenty of your fifty arrows. Everything else moves
whole or not at all.

So a 50/50 split of mixed loot is: deal the indivisible items to even the totals,
then use money to close the remaining gap exactly. The `split` tool does this and
shows its working, which matters when the counterparty is another agent deciding
whether the deal was honest.

### Fighting together

Advancement is scored **per player**, from that player's own participation
(`AdvancementCheck`, `player.kod:7736`): you must have done damage, the monster must
have been worth it, and you get the most for having *taken* damage and landed the
killing blow. So:

- there is no shared pool to dilute — two players killing one monster is not half
  the reward each
- but a player who stands back and takes no damage earns strictly less than one who
  is in it, even if the kill happens
- and "let the strong one do it" teaches the weak one nothing at all: the monster
  must exceed *your own* max health for a real chance

The room wakes when you act. Attacking, casting, speaking or moving all call
`NotifyMonstersOfPresence`.

### Fighting each other

Players are not attackable by default. `EvaluatePKStatus` (`player.kod:11047`) turns
`PFLAG_PKILL_ENABLE` on when **any** of these becomes true:

- base max health reaches `PKILL_ENABLE_HP` = **30** (`blakston.khd:2094`)
- you join a guild
- you are flagged murderer or outlaw

Below that you have what the game calls an angel — you cannot attack other players
and they cannot attack you. `AllowPlayerAttack` (`player.kod:3615`) enforces it in
both directions, so the protection is mutual and a fresh character simply cannot
duel. Growing past 30 hit points is the price of admission to PvP.

`safety` (`UC_SAFETY`) is the opposite switch: it keeps a PK-enabled character from
attacking players by accident. Turn it on unless fighting people is the point.

What you can read about another player before deciding, all from the object flags on
them in `look`:

| what | how |
|---|---|
| is a player | `OF_PLAYER` |
| enemy / friend / guildmate | `OF_ENEMY`, `OF_FRIEND`, `OF_GUILDMATE` — set by the server from *your* guild's relationships |
| safety on | `OF_SAFETY` |
| invisible or shadowed | the `DRAWFX` effect bits |

The broker surfaces these as `relation` and `safety_on`. They come from the server's
own view of the relationship, so they are more trustworthy than a name.

Killing a player has consequences the game tracks: outlaw and murderer flags,
revenants, and a karma shift. Dying costs you what you were carrying.

## Magic, and why karma decides what you may cast

The protocol tells you almost nothing about a spell. `BP_SPELLS` carries its name, how
many targets it takes, and which school it belongs to — and that is all. **Mana cost,
reagents, spell level and the karma requirement are never sent.** They are declared in
kod, so the `spells` tool joins what the server says you know against a catalogue
compiled from the source, and tells you whether each is castable *right now* and if
not, which of the four things is missing.

### Reagents are consumed

137 of the 175 spells need physical ingredients, declared as `[class, count]` pairs in
each spell's `ResetReagents`. Major heal takes **5 Herbs**; animate takes **1 Shaman
Blood**. They come out of your inventory on a successful cast, so a caster is also a
shopper — apothecaries stock exactly these.

### Karma is the part that catches people

It is not a stat you choose. It is **derived from school and level**
(`Spell.GetRequiredKarma`, `spell.kod:482`):

| school | requirement |
|---|---|
| Qor | karma **at most** `level × -10` — you must be that evil |
| Shal'ille | karma **at least** `level × +10` — you must be that good |
| Kraanan, Faren, Riija, Jala | none |

Karma runs **-100 to +100** (`GetKarma` returns `piKarma/100`, clamped to ±10000 in
hundredths), and it *is* readable — stat group 2, slot 7, so `status` and `spells`
both report it.

The consequences are worth understanding before building a character:

- **A neutral character can cast neither divine school.** At karma 0, 55 spells are
  locked — 29 Shal'ille and 26 Qor. Verified live.
- **The two schools pull apart.** Deep Qor spells need -60 or worse; deep Shal'ille
  need +60 or better. You cannot hold both.
- **Level gates within a school too.** At karma 50 exactly the Shal'ille spells up to
  level 5 unlock; level 6 still refuses.
- **You do not set karma — you earn it by what you do.** A kill is scored as an *act*
  worth the negative of the victim's karma, so killing something good makes you worse
  and killing something evil makes you better. There is no karma change in the newbie
  region, in arenas, during a frenzy, or from neutral monsters.
- **But an act weaker than you already are does nothing at all.** This is the part
  that wastes an afternoon. `CalculateKarmaChangeFromAct` (`player.kod:6508`) returns
  **0** when doer and act have the same sign and the doer is further from neutral:

  > *"Do not change karma if player is good, act is good, but not as good as player."*

  Measured live: at karma **50**, killing a karma **-30** spider — a good act worth
  +30 — changed karma by **exactly nothing**, twice. Grinding weak evil monsters
  cannot push you past the value of the monster itself. To climb you need acts worth
  *more* than your current karma: worse victims, or Shal'ille healing, which scores as
  a good act through the same function (`heal.kod:122`, `majheal.kod:110`).
- **Moving back toward neutral is deliberately slowed.** The swing factor is 6 for a
  monster kill but drops to 2 when the kill would move you toward neutral
  (`settings.kod:50`), so digging out of a karma hole is slower than digging in.

`KarmaCheck` refuses the cast outright, so `cast` checks affordability first and tells
you the reason rather than spending the attempt.

### Two silences

- **A successful cast is often silent.** `create weapon` puts a short sword in your
  hands and says nothing. Compare inventory and vitals rather than reading silence as
  failure.
- **Many spells override `CanPayCosts`** with a rule of their own — 84 of them. No
  table can hold an arbitrary rule, so `spells {show: "..."}` hands you that kod to
  read, exactly as `merchants` does for buying rules.

## Money and things

- **Money is an object** in your inventory, of class `Money`, carried as a stacked
  quantity. `look` and `inventory` report stacks with an `amount`.
- **Loot lands on the floor.** `CreateTreasure` (`monster.kod:4938`) makes
  `1 + level/55 + random(0, difficulty/3)` items, capped at 6, and then drops them —
  along with everything the dead thing was carrying — into the *room* at the square
  it died on (`monster.kod:5027`). **There is no corpse to open.** A corpse object is
  usually lying there too, but it is scenery; the items are beside it and appear in
  `look` as ordinary objects with `get` in their `can` list. Summoned monsters and
  illusions drop nothing, so conjuring your own targets earns nothing.
- **Picking up** is `loot`, or `act get` for one thing. Range is **Manhattan**:
  `|Δrow| + |Δcol|` must be 7 or less (`UserGet`), which is much more generous than
  melee — you rarely have to stand on a thing to take it.
- **A dead player's belongings are reserved to their killer for 25 seconds**
  (`body.kod:100`). After that anyone may take them. The refusal names whose corpse
  it is, so you can tell this apart from being overloaded.
- **Selling is the trade protocol.** There is no sell command: you *offer* items to a
  merchant and it *counteroffers with money*, then you accept. That means you see the
  price before committing — `sell` with `confirm: false` quotes and cancels. A
  merchant refuses by **speaking**, so the reason comes back as speech rather than as
  a system message.
- **Merchants are picky, and the pickiness is not in the protocol.** Each decides in
  a kod method, `ObjectDesired`, overridden per merchant. The Hazar apothecary buys
  reagents *or* gems; the Barloque one buys reagents *and not* gems. No flag could
  express that, so the `merchants` tool returns the rule as source text and you read
  it. `merchants {buys: "gem"}` finds rules that *mention* gems and marks which ones
  mention them in order to refuse. The certain test is still to offer and see.
- **Skills and spells are bought from merchants too**, out of the same `plFor_sale`
  list as the items — slot 3 holds spell and skill numbers. `merchants {teaches: ...}`
  finds who. This is how a character learns anything.
- **Merchants mark up.** Price is `initial value * (100 + 20 * markup) / 100`,
  adjusted by your political faction standing (`monster.kod:4880`). Merchants also have a
  **mood** that shifts with what you do (`AffectMood`), including at dawn and
  dusk, and drifts back toward neutral over time. The same item is not always the
  same price.
- **Banking exists**: `deposit`, `withdraw`, `balance` through `BP_USERCOMMAND`.
  Money in the bank is money you do not drop when you die.

---

## Running against someone else's server

Everything in this document is the ordinary client protocol on **one TCP port**, so
none of it needs the server to be local. Point the broker at a remote host with
`M59_HOST` / `M59_PORT`, or pass `host` and `port` to `join` — per session, so one
broker can drive characters across several servers at once. Verified by logging in
over a LAN address rather than loopback.

The parts that are **not** remote, and should not be:

- **Account creation.** The login protocol's `AP_REGISTER` does not create anything
  — `synched.c:279` appends the form to a text file for a human to read. Accounts
  are made on the maintenance socket (`create automated`, `create user`), which has
  **no password at all, only an IP mask** (`blakserv/adminfn.c`). So on a server you
  do not run, an operator has to issue you accounts. That is the correct boundary:
  nobody should be able to mint twenty accounts on a stranger's server remotely.
- **Anything else the maintenance socket does.** Handy locally, unavailable
  remotely, and nothing in the broker depends on it — it never opens port 9998.

Everything after an account exists is pure client protocol, including **building the
character**: `BP_SYSTEM` → `BP_NEW_CHARINFO` sets name, stats, skills and spells. So
"give me twenty accounts" is the whole of what an operator must provide; the fleet
builds and plays itself from there.

One caution on the broker's own HTTP transport: it binds loopback and has **no
authentication**, so anyone who can reach it can drive every character. `M59_BIND`
exists to expose it deliberately, and should be put behind something that
authenticates.

---

## Talking

Speech types, from `UserSay` (`user.kod:4030`) and the `SAY_*` enum
(`blakston.khd:2179`). All of them are the one `say` tool, chosen with `type`:

| type | reach | cost |
|---|---|---|
| `say` | everyone in the room | free |
| `emote` | the room, as a described action | free |
| `yell` | this room **and every room in its yell zone** (`plYell_Zone`) | free |
| `tell` | **one named player, anywhere in the world** | 1 mana |
| `send` | several named players at once | 1 mana **each** |
| `guild` | your guild, wherever its members are | free |
| `broadcast` | the whole server, if `TryBroadcast` allows it | a share of max mana |

`tell` and `send` are **a different opcode** — `BP_SAY_GROUP` (111,
`sprocket.c:28`), which carries a *list of player object ids*, not names, so the
broker resolves names against `who` first. One recipient is a private tell and
comes back typed `SAY_GROUP_ONE`; more than one is a group send
(`user.kod:4203`). `TrySayGroup` (`player.kod:3210`) refuses the whole thing
when `piMana < recipients`, and `TryBroadcast` (`player.kod:3173`) refuses while
squelched. **Both refuse in prose, not as an error** — so check `echoed`. A null
echo means it probably did not go out, and `messages` will say why.

This is the whole of how agents and humans reach each other: they share one
world, and two agents in different rooms have no channel but `tell`.

Player-to-player speech inside a room is **not** distance-clipped. `SayRangeCheck`
(`holder.kod:604`) only clips user↔monster speech, at `SAY_RADIUS = 50` squared —
about 7 squares. So a human anywhere in your room hears you, but an NPC across a
large room may not.

Your own speech comes back to you as a `said` event, which is how you confirm it
went out. Text carries two-character colour codes introduced by `~` or a backtick;
the broker strips them, so `You say, "hello~n"` reaches you as
`You say, "hello"`.

**`wait_for_event` is how you listen.** MCP is request/response — the world cannot
reach an agent that is not asking. Speech from others, things appearing and
vanishing, damage, and shop replies all arrive there. It returns a `cursor`; pass
it back as `since` and you will never see an event twice or miss one that landed
between polls. If you are in company, poll it.

A room can block any communication type outright (`RoomReqCommunication`), so
silence may be the room rather than a bug.

---

## Staying alive

Three vitals, all in stat group 1. Read them with `status`, and note the broker
reports `max` from the server's `current_max` field — the protocol's `max` field
is a fixed display scale of 100, and reading it says every character has 100 hit
points.

- **health** — at zero you die.
- **mana** — spells.
- **vigor** — gates running and some skill costs. Recovered by resting, **and it is
  what sets how fast health comes back**.

`rest` sits you down; `rest` with `stand: true` gets you up. Rest time is
`1000 + 30 * (51 - stamina)` milliseconds per tick (`GetRestTime`, `player.kod:10009`), so high
stamina recovers faster. Resting is silent unless something changes — do not read
the silence as failure.

### Health regenerates constantly, but only if you have moved

`HealthTimer` (`player.kod:2639`) awards one point at a time on a repeating timer.
`CalculateHealthTime` (`player.kod:5611`) sets the interval:

```
ms_per_point = ((200 - vigor)² / 6 + 1000) × (125 - stamina) / 100
               × 100 / bound(max_health, 40, 100)      clamped to [1000, 60000]
```

The comment in the source reads *"Faster regen with higher vigor"*, and it dominates:
at vigor 80 with 50 stamina and 26 max health that is about **6.4 seconds a point**;
at full vigor it is under two. **This is why you rest when hurt** — not because
resting heals, but because it restores vigor, and vigor is the rate.

**The gate that will catch you:** `HealthTimer` only awards the point when
`PFLAG_MOVED_SINCE_ENTRY` is set — *"only gain health if we've moved since entry"*.
Walk into a room, stand still, and you recover **nothing at all**, indefinitely. A
character of mine sat in an inn at 5 of 26 health and rested twenty-nine times
without gaining a single point, which reads exactly like a game with no regeneration
in it. Take one step after entering a room, then rest.

Flasks (the only `Healer` item, 5–10 health, 60sh, from Joguer, Ravi, Lady Aftyn or
Frisconar) and heal spells are still worth carrying: they are the only way to gain
health *during* a fight, where six seconds a point is far too slow to matter.

### Death, and getting back

`Player.Killed` (`player.kod:7908`) then `ApplyDeathPenalties` (`player.kod:8203`):

- **you drop what you carry**, in the room where you died, unless it was a
  "cheap" death (arena, an out-of-grace prison, a room flagged safe, or a special
  item that intervenes)
- skills and spells take a penalty
- a chance to **lose a point of max health** — your level going backwards
- you go to the Underworld and re-enter the world on leaving it
- you cannot die twice within two seconds; the second death is discarded

Loss is real. Fight things that can hurt you, because that is the only way to
advance, but bank your money and read your health between exchanges.

**The Underworld has no exits in the room graph. You get out by walking onto a
portal.** This is a third transition mechanism: `Portal.SomethingMoved`
(`portal.kod:97`) fires when your square equals the portal's square and teleports
whatever is standing there. Walking *is* the action — there is nothing to send.

A portal does announce itself, in the low two bits of its object flags:
`OF_MOVEON_TELEPORTER = 2` (`proto.h:417`, "kod will move you elsewhere"). Nothing
else about it stands out — its name is "portal" and its only affordance is `look` —
so that flag is the whole signal. The broker surfaces it as `teleports-you` in an
object's `can` list and as `kind: "portal"` in `exits`.

### The Underworld specifically

**Which exit you take matters more than getting out.** Everything you were carrying
is on the floor where you died, so coming out at the wrong end of the world is the
expensive half of dying. `escape_underworld` therefore aims, by default, at the city
**nearest to where the character died** — measured over the room graph, from that
character's own death record. It needs no argument to do that.

#### The five fixed portals

Five portals stand in a pentagram, each going to one city **every time**, hard-coded
when the room is built (`uworld.kod:649-662`):

| city | the inn you arrive in | kod square |
|---|---|---|
| Tos | Familiars (52) | row 3, col 7 |
| Cornoth | Cibilo Creek Inn (153) | row 2, col 25 |
| Barloque | Brownestone Inn (106) | row 21, col 30 |
| Marion | The Limping Toad (202) | row 32, col 16 |
| Jasper | Yonder Inn of Jasper (370) | row 21, col 2 |

(kod squares are 1-based; the client reports them 0-based.)

**They are not all off.** `ResetPuzzle` (`uworld.kod:460`) lights all five and then
turns **one or two off at random** — so three or four are live at any moment. An
unlit one is *silent*: `Portal.SomethingMoved` returns immediately when the portal is
not animating, so standing on a dead portal does nothing at all and looks exactly
like a portal that is not there. The braziers carry `activate` (`TogglePortal`,
`uworld.kod:155`) and each one toggles **three** portals at once, which is the puzzle.

Each fixed portal describes itself, and in different words from the rip — the two
tables below are both needed, and the Cornoth and Barloque wordings share nothing at
all between them:

| what you read on a fixed portal | where it goes |
|---|---|
| Looking in the portal, you see the bustling bar of Familiars. | Tos |
| A lazy inn next to a quiet creek rests on the other side of this portal. | Cornoth |
| Gazing into the portal, you see an expensive inn in a bustling city. | Barloque |
| Through the portal, you see the laid-back atmosphere of the Limping Toad. | Marion |
| The quiet Yonder Inn of Jasper lies through this portal. | Jasper |

#### The rip in space — the fallback, not the plan

A sixth, the **"rip in space"** (`HellPortal`), shifts. Every
`random(5000, 10000)` milliseconds it picks a new destination from five city inns,
and `SwapLocations` guarantees the new one differs from the current one — so it never
repeats twice running (`hellport.kod:65`).

Where it currently leads is only readable by **looking at it**. The description is
`"Gazing through the anomaly, you can see %s."` and the `%s` names an *inn*, not a
city:

| what you read | where it goes |
|---|---|
| the bustling bar of Familiars | Tos |
| the laid-back atmosphere of the Limping Toad | Marion |
| the quiet Yonder Inn of Jasper | Jasper |
| the lazy happenings in the Cibilo Creek Inn | Cornoth |
| the fine Brownstone Inn in a bustling Barloque | Barloque |
| the sturdy, island fortress of Ko'catan | Ko'catan — see below |

Using it is a timing problem: `look_at` the rip repeatedly, and when it reads as your
destination, walk onto it before the next swap. You have between 5 and 10 seconds,
unknown which — and walking there is a second per square, so **stand adjacent first
and check from there**, not from across the room.

Which is why you should not use it if you do not have to. A named city has a portal
that goes there every time, standing a few squares away; `escape_underworld` walks to
that and only falls back to polling the anomaly if it is one of the unlit ones.

**Ko'catan is not a choice.** It has no portal in the pentagram, and the rip's five
possible destinations are the mainland inns (`hellport.kod:57`). The one exception is
a character who *died* in Ko'catan: `NewDeath` sets `PFLAG2_KOCATAN_DEATH`
(`uworld.kod:598`), and for that character the rip shows the island and nothing else
and takes them there regardless of where it currently points
(`hellport.kod:106,148`). So if you died there the rip is a Ko'catan-only door until
you use it, and if you did not, no exit from the Underworld goes there.

`node tools/m59-underworld.mjs` prints all of this, and
`node tools/m59-underworld.mjs <room>` says which city is nearest to any room and how
far every other one is.

**Stand up before you try any of this.** Resting sets `PFLAG_NO_MOVE`
(`ResetPlayerFlagList`, `player.kod:1162`), and a move request from a player carrying
that flag is not refused with a message — `user.kod:2988` puts you back on the square
you are already on and returns. Nothing clears resting on death; only logging off does
(`UserLogoffHook`, `player.kod:1913`). So a character killed *while resting* wakes up
here still sitting down, walks nowhere, never lands on a portal, and every portal in
the pentagram looks unlit. `escape_underworld` sends `stand` first for exactly this
reason, and standing when already standing costs nothing — `UC_STAND` is `StopResting`,
which returns immediately when there is no rest timer.

An agent that ignores portals and dies is stuck in the Underworld permanently.

### Living with the humans

- **`safety`** (`UC_SAFETY`, `user.kod:1541`) sets a flag that keeps you from
  attacking other players by accident. If PK is enabled on the server and you are
  not there to fight people, turn it on.
- `AllowPlayerAttack` (`player.kod:3615`) will not let a PK-disabled player attack
  or be attacked, so the protection is mutual.
- Attacking a player starts a timer (`ATTACKED_PLAYER_WAIT`) before it can happen
  again.
- Object flags mark other players as enemy, friend or guildmate.

The social rule is simpler than the mechanical one: a human on this server is a
person having an evening, and your character is standing in their room.

---

## A loop that works

```
join                                     once
look                                     position, vitals, ids, exits, the minimap
  ↓
wait_for_event  (pass back the cursor)   listen if anyone is around
  ↓
travel <room>                            or walk_to {"col": C, "row": R} inside this one
approach <id> distance:1                 walks AND turns; both are required
attack <id> swings:3                     paced one per second, faces each swing
  ↓
look                                     the world moved while you were swinging
  ↓
rest                                     when vigor is low, stand when it is not
shop <merchant>                          items AND skills AND spells
split / trade                            divide what you found, then hand it over
```

The shape to keep: **one action, then read.** The server's clock is one second,
not one thought, and it will not tell you when you have outrun it.

---

## When the docs and the code disagree, the code wins

The authorities for anything in this file:

| | file |
|---|---|
| what a player may do, and the refusals | `kod/object/active/holder/nomoveon/battler/player.kod` |
| the client→server command handlers | `kod/.../player/user.kod` `UserCommand` |
| trading, offer state machine | `kod/.../player/user.kod` `UserOffer`/`ReqOffer`/`CounterOffer`/`AcceptOffer` |
| rooms, movement, exits, speech propagation | `kod/object/active/holder/room.kod` |
| monsters, loot, merchants | `kod/.../battler/monster.kod` |
| skill and spell improvement | `kod/object/passive/skill.kod` |
| room geometry and walkability | `blakserv/roofile.c`, `blakserv/roomdata.c` |
| what the minimap draws | `clientd3d/map.c`, `clientd3d/bspload.c` |
| object flags and opcodes | `include/proto.h` |
| request layouts | `blakserv/sprocket.c` |

`tools/m59-play-test.mjs` re-checks the claims in this document against a live
server. If something here stops being true, that is where it will show up first.
