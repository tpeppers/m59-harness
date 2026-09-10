# The Meridian 59 MCP broker

One process, N player characters, arbitrary agents driving them. `tools/m59-broker.mjs`.

```
   Claude Code ─┐
   Codex ───────┼── MCP (stdio / HTTP) ──► broker ──► blakserv :5959
   local models ┘                          N sessions    (same port as humans)
   humans ──────────── meridian.exe ───────────────────►
```

Agents and humans are peers. A character held by the broker has an ordinary player
session: the broker validates movement before the server sees it, `who` lists it beside the humans, and
it perceives only what a player perceives. The admin socket is not involved at all
— which matters, because `:9998` has no password and must stay on loopback,
whereas this works from anywhere the game port is reachable.

Read **`docs/m59-agent-primer.md`** before driving a character. It is the rules of
the world, and most of them fail silently if you do not know them.

---

## Run it

```bash
# stdio — one MCP client, which may still drive several characters
node tools/m59-broker.mjs

# HTTP — many heterogeneous clients share ONE supervised broker process
node tools/m59-service.mjs start --http 8899
curl -s http://127.0.0.1:8899/health

# drive it end to end with no agent at all
node tools/m59-broker.mjs --selftest agent1 agentpass1
```

Environment: `M59_HOST` (default `127.0.0.1`), `M59_PORT` (`5959`), `M59_RATE`
(outbound packets per second, default 4 — see pacing below).
`M59_MAP` explicitly selects a collision map. Without it, every launch path prefers
the gitignored server-matched `substrate/m59-map.local.json`, then the checked reference;
the broker validates the complete semantic manifest before accepting sessions.

Prefer HTTP when more than one agent is playing. One process means one resource
table, one client per character, and one place where pacing is enforced.

### Claude Code

`.mcp.json` in the project root, or `claude mcp add`:

```json
{
  "mcpServers": {
    "meridian59": {
      "command": "node",
      "args": ["C:/code/m59-harness/tools/m59-broker.mjs"]
    }
  }
}
```

### Codex and other stdio clients

Same shape — a command that speaks line-delimited JSON-RPC on stdin/stdout. In
`~/.codex/config.toml`:

```toml
[mcp_servers.meridian59]
command = "node"
args = ["C:/code/m59-harness/tools/m59-broker.mjs"]
```

### Anything that can POST JSON

The HTTP transport takes a JSON-RPC request (or a batch) on `POST /` and answers
with the result. That is enough for a local model with a loop and no MCP library:

```bash
curl -s -X POST http://127.0.0.1:8899/ -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"look","arguments":{"agent":"alpha"}}}'
```

`GET /health` reports which sessions are live.

---

## Accounts

Every agent needs its own account, because a second login to the same account is
refused with `AP_ACCOUNTUSED`. `create automated` makes the account and a character
in one call:

```bash
node tools/m59.mjs admin "create automated agent2 agentpass2"
node tools/m59.mjs admin "save game"
```

The character gets a generated name like `User778682567`. Fresh characters carry
nothing and know nothing — no weapon, no skills, no spells. An unarmed character
can still fight (`UserAttack` falls back to punch) but will be bad at it. To hand
one a weapon for testing:

```bash
node tools/m59.mjs admin "create object ShortSword"        # -> Created object N.
node tools/m59.mjs admin "send object <charId> NewHold what OBJECT <N>"
```

then `act use` it in game to wield it.

**`save game` renumbers object ids.** It garbage-collects first, so a character id
noted before a save may point at unrelated furniture after. Re-resolve from the
account (`show account <n>`) rather than trusting a remembered id — and inside the
game, always take ids from a fresh `look`.

---

## The `agent` parameter

Every tool takes an `agent` name. It is the broker's key for one character's
session: its socket, its world view, its event cursor, and its pacing queue. Use
the same name for every call belonging to one character, and different names for
different characters. Two agents in one broker never share anything except the
resource table.

---

## Coordinate arguments

Tool JSON uses named coordinate fields. `look` reports square `col` and `row`,
and `walk_to` accepts those same named square fields; fine positions use named
`x` and `y`, where X selects the column and Y selects the row. Named JSON
properties have no positional order.

Inside the repository, movement helpers retain their historical `(col,row)`
order, while `RoomGeometry` and KOD grid operations retain `(row,col)`. The
movement wire payload writes Y before X, but that is an adapter detail: decode it
to named fields before comparing it with an MCP result. KOD/protocol fine points
use 64 units per square; stock-client/BSP points use 1024. In prose use `r30c61`
or `row=30, col=61`; `rNcM` is not accepted by existing tool arguments. The full
contract, including stable artifact exceptions, is in
[`m59-coordinates.md`](m59-coordinates.md).

---

## The tools

### Start here if you are a small model

Six tools cover most of playing. The rest are there when you want finer control.

| tool | what it does |
|---|---|
| `join` | log in |
| `look` | where you are, what is there, what you may do with each thing, and the minimap |
| `fight <creature>` | **the whole engagement in one call** — find, arm, approach, face, swing, watch your health, break off if losing, loot the drops |
| `rest_up` | sit until recovered, then stand |
| `travel <room>` | go somewhere, picking the right exit mechanism at every hop |
| `autopilot` | hand upkeep to a background loop so the character survives between your calls |

`fight` is the one that matters. Doing it by hand is a dozen paced calls each with a
silent failure mode; `fight("spider")` does all of it and reports every stage, so you
can see what it chose and override next time. It will **not** fight to the death — it
disengages at 35% health and says so, because dying drops everything you carry.

### The full surface

| tool | what it is for |
|---|---|
| `join` | log in; call first |
| `look` | **the call to make each turn** — position, vitals, every object with its id and affordances, every exit, and the minimap |
| `look_at` | the description a human would read |
| `map` | the room graph beyond what you can see; route to a named room |
| `travel` | go to another room, hop by hop, picking the right exit mechanism each time |
| `go_through` | use one exit — the neighbouring-room version of `travel` |
| `walk_to` | walk to a square, routed around walls through the room geometry |
| `approach` | walk to within N squares of a target **and turn to face it** |
| `face` | turn to a bearing or toward a target |
| `attack` | face, then swing, repeatably, one per second |
| `shop` | ask a seller what it sells; buy. Sellers also sell **skills and spells** |
| `trade` | hand items or money to another player: `offer` → `counter` → `accept` |
| `split` | compute a fair division of a pile between agents; carry it out with `trade` |
| `loot` | pick up what is on the floor — loot drops there, there is nothing to open |
| `sell` | sell to a merchant; `confirm: false` quotes the price without committing |
| `merchants` | who sells, buys or teaches what, and where — with each buying rule as source |
| `spells` | what you know, what each costs, and when you cannot cast it — why |
| `cast` | cast by name, refusing up front rather than spending a doomed attempt |
| `fight` | a whole engagement in one call: find, arm, approach, face, swing, disengage, loot. Stands up if the swings come back refused |
| `rest_up` | sit until health and vigor come back, watching the numbers since resting is silent |
| `equip_best` | wield the best weapon you carry |
| `sell_all` | quote and sell everything a merchant will take, keeping money and weapons |
| `escape_underworld` | stand up, then walk onto the portal for the city nearest where you died |
| `autopilot` | a background keeper: rests, withdraws, escapes death, optionally farms |
| `abilities` | **how good you are** at each skill and spell, 0-100, kept across restarts with a log of every change |
| `bank` | deposit, withdraw, balance. A bank balance is the only thing that survives dying |
| `safety` | the PvP safety flag: refuse to strike innocents, so you never become a murderer |
| `inventory` | what you carry, with ids |
| `equipment` | **what you are actually wearing and wielding** — the server's own list, not a guess |
| `who` | everyone logged in, agents and humans |
| `status` | health, mana, vigor, attributes, position, what you know, queue depth |
| `say` | speak — `say`, `yell`, `broadcast`, `emote` |
| `chat` | **what people have said** — its own stream, which combat cannot evict |
| `act` | `use`, `unuse`, `get`, `drop`, `activate`, `go` |
| `rest` | sit to recover vigor, or stand |
| `wait_for_event` | **block until something happens** |
| `converse` | **make a character responsive when spoken to** — no model in it; see below |
| `inbox` | everything anyone said to your characters, and the only way to answer it |
| `leave` | log out |

Targets accept either an object id from `look` or a name, resolved against the
room and then your inventory, nearest first. Names are convenient; ids are exact.

### `wait_for_event` is how an agent listens

MCP is request/response. The world cannot reach an agent that is not asking. Other
players' speech, things appearing and vanishing, damage, stat changes and shop
replies all arrive here. It returns a `cursor`; pass it back as `since` and no
event is seen twice or missed between polls.

If a human is anywhere near your character, poll it. Otherwise you are playing
with your eyes closed.

**The first poll returns a backlog, not the present.** Events queue from the moment
you `join`, and nothing is dropped, so an agent that acts for a minute and then
polls gets a minute of history in one gulp — returned instantly, with
`backlog: true` to say so. That is deliberate: missing an event is worse than
getting an old one. Read it, then poll again with the returned `cursor` to wait on
what happens next.

Verified live, two agents in one room as two separate HTTP clients:

```
beta heard:
  [say] User671943211 (obj 6667): User671943211 says, "beta, can you hear me from over here?"

alpha drained 1 backlogged event(s), backlog=true
alpha then heard:
  [say] User778682567 (obj 6845): User778682567 says, "yes. loud and clear."
```

### Speech is a separate stream from everything else

`wait_for_event` is one 500-entry ring carrying everything the world does, and a
fight writes hundreds of lines into it. Speech was being evicted from it before
anyone polled — by the character's own swings.

So speech has its own ring, its own sequence, and its own tool. `chat` reads it,
for one character or the whole fleet; the two cursors are independent and cannot be
used for each other. Server prose — combat text, refusals, a shopkeeper reading
from a script — is **not** in it, which is what keeps the untrusted-input banner on
`chat` meaning "a player wrote this".

`inbox` is still the queue for things that need *answering*, and `converse` is what
puts a character on it. `chat` is the transcript: always on, no policy, every
character.

## `abilities` — kept, not re-asked

Ability levels are the only progress signal the game gives for skills and spells, and
reading them is expensive: four requests and ~1.2s, because the spell and skill lists
have to be re-read before the ability groups — a group-3 packet is one slot per entry
of `plSpells` and carries nothing that says which spell a slot is, so against a stale
list every number is mislabelled, silently and plausibly. For twenty-one characters
that is eighty-four requests out of a budget of five a second.

So it is read **once after login** and then kept current from the server's own pushes:
`ChangeSkillAbility` calls `DrawStatSkill` on every change (`player.kod:7343`), which
sends `BP_STAT` for the slot that moved. A periodic re-read exists but is a safety net
for what the pushes cannot cover — a character that advanced while logged out, and
atrophy.

The record is on disk, one file per **character** (the agent name is which slot of the
fleet is driving, and gets reassigned):

```bash
node tools/m59-abilities.mjs                # every character on record
node tools/m59-abilities.mjs Kermit         # one, with its history
```

That is what makes `advancement` in the tool's reply a **log of what happened** rather
than the difference between two polls — and it still has a "before" from before the
last broker restart. Watch `atrophied`: what you stop using decays when the
advancement window rolls over, and a number quietly going back down is invisible
without a record of what it used to be.

`refresh: true` forces a live read. It is rarely needed and is mostly for proving the
record right.

## `equipment` — what is actually being worn

The pack and the equipped set are two different lists in Meridian, and the harness
used to only read the first. The server keeps the second in `plUsing` and volunteers
it: whole on `BP_USE_LIST`, then one line per change on `BP_USE` / `BP_UNUSE`. The
use list rides along behind **every** inventory request (`user.kod:955`), including
the keepalive's, so it stays current at no cost in requests.

Every earlier way of answering "what is it wielding" was an inference, and each
failed differently:

| the guess | how it broke |
|---|---|
| the weapon `equip_best` picked | it never read the reply, so a refusal still reported success |
| "the `use` was not refused as broken" | wielding something already wielded is refused with **"your hands are too full"**, which is not the broken message |
| "it is in the inventory" | that is what you *carry* |

`known: false` means no use list has arrived yet. That is **not** the same as
empty-handed and is never reported as such — on `fleet`, the `wielding` field is
simply absent rather than `false`.

---

## What `look` gives you

`look` is not a list of objects. It is the join of three things that live in three
different places, and the join is the point:

- **perception** — `BP_ROOM_CONTENTS` and friends: ids, names, squares, object flags
- **the room graph** — `substrate/m59-map.json`: which rooms connect to which, and how
- **the geometry** — the `.roo` walkability grid and wall list, the same data the
  player's minimap is drawn from

So a single call answers questions the protocol alone cannot:

```
room     name, number, dimensions, which .roo file it is
you      square, facing, whether you are on walkable floor, which of the eight
         directions you can step
objects  id, name, square, distance, "can" (what the server will accept),
         reachable, steps_to_reach, stand_on — and for players, relation
         (enemy / friend / guildmate / neutral) and whether their safety is on
exits    kind, destination room and name, THE SQUARE TO STAND ON, steps away,
         and for a conditional edge exit, the condition on it
minimap  two pictures, below
```

`reachable` and `steps_to_reach` come from A* over the real geometry. They matter
because finding out by walking costs a second a square, and a wrong guess costs a
minute.

### Two minimaps, because they answer different questions

`minimap.text` is the **movement grid** — one character per square, from the same
walkability planes the server uses for its own pathing:

```
   1 ##############
   2 ####.......###
   3 ###.........##
   7 ##....###.####      # no floor   . floor   + floor with no exits
```

`minimap.walls` is **what the client actually draws** (`clientd3d/map.c`): wall
segments at twice the resolution, so a wall *between* two floor squares is visible
and a doorway is distinguishable from a wall:

```
             /-------------\
   2         /. . . D . . .\
   5      /·········. . . T .\
   6      . . . Q·.·. . . . . \
                 |------·-----|
```

`|` `-` `/` `\` are walls; `·` is a doorway you can walk through (`WF_PASSABLE`).

Objects, exits and you are placed on both, with a `legend` naming each mark. Read the
picture: it answers "is that monster behind a wall" and "which way is out", which the
object list cannot.

## Getting somewhere

Two exit mechanisms, and they are **not** interchangeable — using the wrong one
produces no reply at all:

- **walk off the room edge.** Crossing row 0 / `piRows+1` or col 0 / `piCols+1` calls
  `Room.StandardLeaveDir`, which looks the direction up in `plEdge_Exits`. Outdoor
  rooms connect this way. Some edges are conditional: one boundary can lead to two
  different rooms depending on where along it you crossed.
- **stand on the square and `go`.** `Room.SomethingTryGo` matches your row and col
  **exactly** — one square off and nothing happens. Interior rooms, which have no edge
  exits at all, connect this way.

`travel` picks the right one per hop and replans on arrival. `map {to: ...}` shows the
route first without walking it. Names resolve against the graph; an ambiguous name
comes back as an error listing the matches.

The graph is built over the admin socket. Collision geometry must be refreshed from
the exact room resources used by the server; `setup.mjs` does this automatically into
a gitignored local map:

```bash
M59_ROO_DIR=/path/to/server/resource/rooms node tools/m59-map.mjs build # 264 rooms, 980 exits
# maintainer: refresh the portable checked reference
M59_ROO_DIR=/path/to/reference/resource/rooms node tools/m59-map.mjs refresh-geometry
# setup does this automatically for a server-local artifact:
M59_MAP=substrate/m59-map.local.json M59_ROO_DIR=/path/to/server/resource/rooms \
  node tools/m59-map.mjs refresh-geometry
node tools/m59-map.mjs path "Yonder Inn of Jasper" "The Streets of Tos"
node tools/m59-roo.mjs show "The Spider Nest"
node tools/m59-roo.mjs show "Yonder Inn of Jasper" --walls
```

Refresh it after any change to the game's rooms. An explicit `M59_ROO_DIR` is
exclusive: a missing server room is an error, never silently filled from a Steam
install, during both full build and geometry-only refresh. A setup-local refresh always
starts from the current checked graph, so obsolete exits cannot survive in an old local
artifact. The graph keys off room *numbers* and *name resources*, both of which survive
`save game`; object ids do not. A security mismatch or live wall/sector mutation stops
movement with a specific fail-closed reason until matching geometry is available.

## Handing things over

There is no one-sided give. `BP_REQ_GIVE` exists as an opcode but appears in no
dispatch table anywhere in the server, so every transfer is a two-sided trade:

```
offer     you propose               -> the other side gets an "offered-to-us" event
counter   they reply, POSSIBLY WITH NOTHING — an empty counter is how a gift is
          accepted, and countering is what grants the OTHER side permission to accept
accept    legal only after you have received a counteroffer
```

Accepting early is logged by the server as cheating and cancels the trade, so the
permission is real and `trade {action: "accept"}` refuses rather than trying.

Both parties must be **in the same room**. Items are ids from `inventory`; pass
`{id, amount}` to hand over *part* of a stack — the only way to split money, because
the id list has a variable stride and a tagged id carries a quantity after it.

Two things the server does quietly, which the tool reports:

- your offered stack amount is **silently clamped** to what you actually hold, so read
  `on_the_table` in the reply rather than assuming
- on success the **accepting** side is told nothing at all, while the other side gets
  a message that also means "cancelled". Compare inventories to tell which happened.

`split` computes a division first — money to the coin, indivisible items dealt out to
even the totals — so two agents can agree on a plan before anyone offers anything.

## Loot and money

**Nothing to open.** When anything dies, `CreateTreasure` drops its generated loot
*and everything it was carrying* straight into the room at the square it died on
(`monster.kod:5027`, `NewHold` into `poOwner`). There is no corpse container. A corpse
object is usually lying there too, but the items are on the floor beside it, and they
arrive in `look` as ordinary objects with `get` in their `can` list.

`loot` walks into range of each and takes it. Three rules it works around:

- **pickup range is Manhattan, not straight-line** — `|Δrow| + |Δcol| > 7` is refused
  (`UserGet`). That is far more generous than melee, so you rarely have to stand on
  a thing to take it.
- **a freshly killed player's belongings are reserved to their killer for 25 seconds**
  (`body.kod:100`, `ptNoSteal`). The refusal is a message naming whose corpse it is.
- **carrying capacity is finite**, and for a stack the server will hand you as much
  as you can hold rather than refusing outright.

**Selling is the trade protocol, not a separate command.** You offer a merchant your
items and it counteroffers with **money**; you accept. So `sell` with `confirm: false`
gets you a *price quote and nothing else* — the offer is cancelled and you still have
the goods. Verified live: one sapphire quoted and sold for 30 shillings, two for 60,
and `{id, amount}` sells part of a stack.

A merchant refuses by **speaking** (`SayToOne`), so the reason arrives as
`merchant_said`, not as a system message. Only one customer at a time, and lawful
merchants will not trade with a murderer.

### Who buys what is a rule, not a table

Each merchant decides in `ObjectDesired`, a kod method overridden per merchant. The
Hazar apothecary takes reagents **or** gems; the Barloque one takes reagents **and not**
gems. That distinction cannot be expressed as a flag, so the catalogue keeps the rule
as source text and `merchants` hands it to you to read:

```bash
node tools/m59-merchants.mjs build            # 67 merchants, from the world + the source
node tools/m59-merchants.mjs who-teaches heal # -> ShalillePriestess, room 48
node tools/m59-merchants.mjs who-buys gem     # marks which rules EXCLUDE gems
node tools/m59-merchants.mjs show BarloqueApothecary
```

`merchants {buys: "..."}` greps those rules and flags the ones that name a thing in
order to refuse it. Narrowing the search is all a catalogue can honestly do; the
certain test is `sell` with `confirm: false`.

**Skills and spells come from the same shop.** `plFor_sale` slot 3 holds spell and
skill numbers, and buying one calls `AddSkill`/`AddSpell` — so `merchants {teaches:
"..."}` is how a character finds out where to learn anything.

## Magic, and the karma gate

The protocol carries a spell's name, target count and school, and **nothing else** —
no mana, no reagents, no level, no karma requirement. Those come from a catalogue
compiled out of the game's source:

```bash
node tools/m59-spells.mjs build              # 175 spells, matching all 175 source files
node tools/m59-spells.mjs show "major heal"  # 20 mana, 5 x Herbs, karma >= +50
node tools/m59-spells.mjs reagents herb      # which spells eat herbs
node tools/m59-spells.mjs castable 0         # what a neutral character is locked out of
```

`spells` joins that against what your character actually knows and carries, and marks
each castable or not **with the reason** — karma, mana, or a missing reagent.

**Karma is the trap.** It is not stored on the spell; it is derived
(`Spell.GetRequiredKarma`, `spell.kod:482`): Qor needs karma ≤ `level × -10`,
Shal'ille needs ≥ `level × +10`, everything else has no requirement. Karma runs
-100..+100 and *is* on the wire (stat group 2, slot 7).

So a neutral character at karma 0 can cast **neither** divine school — 55 spells
locked, verified live — and the two pull in opposite directions, so no one holds both.
You do not choose karma either: killing shifts it by the negative of your victim's
karma. What you fight is what you become.

`cast` checks affordability before sending, because a refused cast is usually silent.
So is a *successful* one: `create weapon` puts a sword in your hands without a word.
Compare inventory and vitals rather than reading silence as failure.

84 spells override `CanPayCosts` with a rule of their own. As with merchants,
`spells {show: "..."}` hands you that kod to read rather than pretending it is data.

## Portals: the third way out of a room

Neither an edge exit nor a door. `Portal.SomethingMoved` (`portal.kod:97`) fires when
your square equals the portal's and moves you — **walking is the action**, there is
nothing to send. Portals are identified by a flag, not a name: `OF_MOVEON_TELEPORTER`
in the low two bits (`proto.h:417`). The broker reports it as `teleports-you` in
`can`, and as `kind: "portal"` in `exits`.

This matters because **the Underworld has no graph exits at all**, and that is where
you go when you die. Five of its portals are fixed but switched off until their
brazier is `activate`d; the sixth, the "rip in space", changes destination every
5–10 seconds and only `look_at` tells you where it currently leads — in prose naming
an inn rather than a city. See the primer for that table and the timing.

## Growing a character

`docs/m59-progression.md` is the rules and the rates; this is the surface that reaches
them.

**`status` tells you what you know. `abilities` tells you how good you are.** The 0-100
ability numbers were on the wire all along — stat groups 3 and 4, one slot per entry,
positionally matched to the spell and skill lists (`user.kod:2694`) — and `status` was
discarding them. They are the only signal the game gives that practice is working, so
record them at the start of a session and compare at the end.

Three things about advancement that change how an agent should play:

- **Only a monster whose level is above your max health teaches you anything.** Equal or
  below gives nothing, and a 10% chance the game says your character spits in contempt.
- **Practise across rooms, not in one.** The ability cap is 10 points per ~18 minutes, but
  every room change refunds 2 (`player.kod:1465` — "give them a break on the botting imp
  cap"). A circuit of five rooms doubles your rate; a town divides it by ten.
- **Attributes never change after creation, and stamina is your health ceiling** —
  `101 + stamina`, permanently. A character made with `create automated` has zero in
  every attribute and is capped at 102 max health. `status` says so when it sees one.

**Skills cannot be invoked.** In this fork the 19 skills are passive: the server fires
dodge, parry, block, disarm and second wind for you, the eight weapon proficiencies are
multipliers, and the stroke you swing is chosen by your weapon. `BP_REQ_ATTACK` accepts
only `ATTACK_NORMAL`. `assess`, `thrust` and `kick` are unreachable by any client,
including the official one — `module/merintr/statlist.c:381` builds a `"perform "` command
and then `return; // not implimented yet`, and no server opcode would receive it. So
weapon skills improve from ordinary `attack` and `fight` calls, and there is nothing else
to call.

**But only skills you actually have.** `ImproveAbility` bails unless `HasSkill`
(`skill.kod:317`), and a `create automated` character starts with `plSkills` empty —
verified live. Until it buys a proficiency through `shop`, fighting earns it max health
and no ability progress whatever. `abilities` returning an empty list is that diagnosis.

## Money that survives dying

Everything you carry drops on the floor where you die. A bank balance does not, which
makes `bank` the difference between a character that accumulates across days and one that
resets. Deposit before anything dangerous.

You must be in a bank with the banker present — the request is relayed to whatever is in
the room with you (`holder.kod:828`), so anywhere else it fails quietly. Each town keeps a
separate account: **Jasper and Tos share one, Ko'catan has its own.** The banker answers
in prose and there is no structured balance on the wire, so `bank` parses the number out
of what it says and returns both.

## The keeper

`autopilot` is a background loop, one per character, with **no language model in it**.
It exists because of a mismatch of clocks: the server runs at one action per second
and a fight takes half a minute, while a model thinks in a burst and then is gone. In
between, a character in a monster room bleeds out, or stands at full health doing
nothing for an hour.

It makes only the decisions that are genuinely mechanical, in order of urgency:

1. **dead** — the Underworld has no graph exits, so a character left there stays
   forever. It walks onto a portal.
2. **in danger** — below `flee_below` with something hostile adjacent **and a wall the
   safe-spot book has confirmed**, it logs off and back on. Corrected 2026-09-10: this
   used to say it "routes to the nearest square far enough away", and that walk is gone.
   Walking out costs a second a square *while still being hit*, and waiting on a wall
   lets the attack run for dozens of seconds; the logoff ends it at once. Off a proven
   wall the verb refuses and the character rests instead — the refusal is the safe
   direction. It is the same call the `doomed` rung makes, so `flee_below` chooses when
   to reach for it, never what it does.
3. **hurt but safe** — rests, but only with nothing adjacent; resting next to a monster
   just feeds it.
4. **work** — in `farm` mode only, and only the creature you named.

Two rules keep it from surprising you: **it never picks a fight you did not name**, and
**everything it does is journalled with a reason**. `action: "status"` returns a summary
(`kills`, `looted`, `deaths`, `rooms_visited`) plus the tail; `full_journal: true` gives
all of it.

```
autopilot {agent, action:"start", mode:"farm", hunt:"spider", roam:true}
```

`roam` is off by default — wandering changes where you left your character, which is
a surprise — but with it on the keeper moves to a neighbouring room when the current
one is cleared, up to `roam_limit` rooms.

Measured over three unattended minutes: 3 kills, emeralds and berries looted, no
crashes, and the journal explaining each pass.

## Pacing, and why tool calls take a second

The server has three rate limits and **all three fail silently** — no error, no
message, the request simply never happened:

- **more than 5 packets in one second** and attack, cast, use, get, look, activate,
  apply, offer, rest, stand and go are all discarded for the remainder of that
  second (`INCOMING_PACKET_THROTTLE`, `user.kod:50`)
- **one attack or spell per second** (`IsOkayAttackTime`, `player.kod:5305`)
- **about one move per second** before the session is logged as a suspected
  speedhacker (`MOVEMENT_COUNT_THRESHOLD`, `user.kod:61`)

Measured on the live server: twelve `look` requests sent inside one second
produced **one** reply and no error at all.

So the broker queues every outbound request per session and holds each one until
all three rules allow it. A tool returns only once its request has actually gone
out. Ten `attack` calls take ten seconds and land ten attacks, instead of taking
no time and landing one.

This is the trade the broker exists to make: **visible latency instead of
invisible failure.** `status` reports `queued_requests` if you want to know how far
behind the queue you are. `M59_RATE` tunes the global limit; the default of 4
leaves a packet of headroom under a boundary the broker does not control.

The consequence for an agent: **do not batch tool calls.** Act, read the result,
act again. Six parallel calls are five thrown away.

---

## Verifying it still works

```bash
node tools/m59-rsc.mjs                                    # resource table loads
node tools/m59-roo.mjs stats                              # every room's geometry parses
node tools/m59-map.mjs stats                              # the room graph
node tools/m59-spells.mjs build                           # spell costs, reagents, karma
node tools/m59-client.mjs agent1 agentpass1               # login + perceive one room
node tools/m59-perception-test.mjs agent1 agentpass1      # every room, invariant held
node tools/m59-play-test.mjs agent1 agentpass1 1337       # the rules, re-checked live
node tools/m59-broker.mjs --selftest agent1 agentpass1    # every tool, end to end

node tools/m59-broker.mjs --http 8899 &                   # two agents cooperating
node tools/m59-coop-test.mjs
node tools/m59-skills-test.mjs                            # fight / rest / escape
node tools/m59-autopilot-test.mjs                         # three unattended minutes
node tools/m59-chat-test.mjs                              # listening and answering, offline
```

`m59-perception-test.mjs` is the one that matters most. `BP_ROOM_CONTENTS` is a
packed stream with no per-item length, so a sub-parser that consumes one byte too
few produces *plausible* output from a desynchronised cursor. The only real check
is the invariant the C client itself uses — after parsing `count` objects, exactly
zero bytes must remain — and that test asserts it in every room on the server.

Last full run: **167 rooms, 1640 objects, 145 distinct things named, zero
invariant failures.**
