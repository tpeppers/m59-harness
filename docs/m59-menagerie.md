# The menagerie — characters that ride along and are never the fleet

A **menagerie** is a second roster of characters on the same broker, the same server and
the same keeper band as the fleet. Its members are **hosts**: characters whose whole job is
decided in advance — a merchant standing in Tos selling the fleet's excess gear, telling
passers-by what it has, answering whoever answers back — rather than characters that take
orders.

The requirement they exist for is one sentence from the operator:

> I don't ever want me to say "send everyone to Castle Victoria" and have it be interpreted
> to be ALSO one of these ride-along characters.

Everything below is that sentence, made structural.

| | |
|---|---|
| the fleet | `substrate/fleets/<fleet>.json` — commandable, enumerable, what "the fleet" means |
| the menagerie | `substrate/fleets/<fleet>.menagerie.json` — hosts, refused to every MCP caller |
| what drives hosts | `tools/m59-menagerie.mjs run` — a separate process, with its own door |
| what a host does | `substrate/menagerie/scripts/<name>.json` — data, reloaded on edit |
| guards | `m59-menagerie-test.mjs` (58), `m59-menagerie-script-test.mjs` (40) |

```bash
node tools/m59-menagerie.mjs status --fleet shadow      # what the menagerie is and is doing
node tools/m59-menagerie.mjs scripts                    # every script on disk, validated
node tools/m59-menagerie.mjs run --fleet shadow         # the driver
node tools/m59-menagerie.mjs enlist t9 --script merchant-tos --room 50
node tools/m59-menagerie.mjs discharge t9
```

## The separation is a FILE, never a naming convention

A host is a host because of the file its credentials were loaded from, and for no other
reason. Not a name prefix, not a flag inside the fleet roster.

This repository already learned the lesson one layer up, in `m59-which.mjs`: **a fleet is
its ROSTER FILE and never its name**, because two checkouts can each hold a fleet called
`prod` and they are not the same characters. Here the consequences are reversed — one
broker, two rosters — and the same rule applies.

The two files sit beside each other and the menagerie's path is *derived* from the fleet's:

```
substrate/fleets/shadow.json      ->  substrate/fleets/shadow.menagerie.json
substrate/fleet-state.json        ->  substrate/fleet-state.menagerie.json
```

Derived rather than configured, because a menagerie pointed at the wrong fleet is exactly
the failure this whole feature exists to prevent, and a path somebody types is a path
somebody mistypes. It cannot be addressed as a fleet in its own right either:
`--fleet shadow.menagerie` is refused by the name validator in `m59-fleetpath.mjs`, which
allows no dot.

### Why not a `host: true` flag in the fleet roster

Because `saveFleetState()` writes the whole of `fleetState` into the fleet's roster — the
only record of those account passwords — and deliberately carries forward every entry
already on disk so a truncated write can never lose a character. A host in that map is
therefore a host written **permanently** into the fleet's password file, by any of a dozen
code paths including every keeper that starts and writes its policy back.

`rememberJoin` was an unconditional `fleetState.set(agent, …)`, and every host joins. Two
maps and two writers is not the tidy version of one map and a flag; it is the only version
that survives.

## What is shared, and what is not

**The plumbing is shared; the roster, the command surface and the enumeration are not.**

Joining, spawning a keeper, allocating a port, rejoining after a drop, taking an account
lease — none of those cares whether a character is a merchant or a Muppet, and duplicating
them would mean two copies of the code that logs characters in. So the broker looks a name
up in *both* maps for anything structural (`rosterEntry`, `inAnyRoster`), and reads
`fleetState` alone for anything that decides who obeys an instruction.

| | fleet | menagerie |
|---|---|---|
| logged in by the broker | yes | yes |
| gets its own keeper process | yes | yes — top half of the same band |
| rejoined by the 45s sweep | yes | yes |
| appears in `fleet` | yes | **no** (counted, and said) |
| commandable over MCP | yes | **no** — refused by name |
| driven by | keeper + a bot | `m59-menagerie.mjs` |
| in the fleetmate / grudge set | yes | **yes** — see below |

### Hosts take the TOP HALF of the fleet's keeper band

A band is 100 ports wide and no fleet here is close to that, so hosts start at offset 50
(`M59_MENAGERIE_KEEPER_SLOT`). Shadow's fleet sits at 9111–9130 and its hosts at 9161+, so
`netstat` says at a glance which listeners are which. It stays inside the fleet's own
*registered* band, so it cannot collide with another fleet — the failure the band registry
exists for, where prod's `t10` and shadow's `shadow10` both wanted port 8920 and each
broker read the other's keeper.

### "Do not shoot" and "obey an order" are different questions

This is the one place the split deliberately does not apply, and getting it backwards is
expensive. `fleetCharacters()` in the broker answers *which characters on this server are
ours* — it feeds the party module, the grudge book and the fleetmate check, i.e. every
decision about whether to **attack** something. A host excluded from that set is a stranger
standing in a town full of our own armed characters.

This repository has already killed one of its own that way: **Statler, 2026-08-27** — a
keeper process that could not see its own roster called the whole fleet strangers, the
grudge book filled with our own names, and a fleet-mate turned red by hand was shot by
everyone with a false grudge.

So hosts are **ours** for every purpose that decides whether to attack, heal, buff or step
around a body, and **not** ours for any purpose that decides who obeys an instruction. Two
questions, two answers: `alliedCharacters()` and `fleetState`.

The keeper process needs telling separately (`m59-keeper-process.mjs`), because the broker
knowing a thing is not the keeper knowing it — that is the same Statler bug one process
deeper, and it is why the host characters are passed in the keeper's `extra` roster set.

## The refusal

There is exactly one door: `callTool` in `m59-broker.mjs`. Every MCP request over both
transports goes through it and nothing else does, so the rule is enforced there, once, and
*decided* in `m59-menagerie-guard.mjs` so it can be asked a question without starting a
broker.

**A tool call that names a host is refused. Every tool. Reads included.**

- by **agent** name and by **character** name, case-insensitively — the fleet page prints
  both, and naming the character where the agent goes is this repository's commonest
  identifier mistake;
- in **any argument at any depth** — `agent`, `agents[]`, `partner`, `farmer`, the two ends
  of a `supply`. The guard scans every string in the arguments rather than consulting a
  list of parameter names, because a list has to be taught each new one and fails open on
  the one nobody taught it;
- but **not** in free text. A fleet character may say "go see Ssss, he buys armour" —
  matching is whole-string equality, and prose fields are exempt.

Reads are included deliberately, and it is the part that looks excessive. An allowlist of
"harmless" tools grows by exactly the reasoning that produced this feature. The cost of the
strict rule is near zero: the enumeration surfaces already hide hosts, so the only way to
name one from MCP is to know its name already — and anyone who knows it can run one CLI
command.

### Every surface that hides a host says so

`fleet` reports `menagerie_hosts: 2` and a note; `/health` declares the menagerie's count
and file. A board that silently drops rows is a failure this repository has paid for more
than once: a fleet-wide instruction that acts on 18 of 20 characters looks identical to one
that acted on all of them. The **count** is published; the **names** are not, because
naming them there is the beginning of somebody passing one back in.

### The one door that opens

The menagerie runtime drives hosts through those same tools, so it needs to say *I am the
thing that owns these characters*. The broker mints a token at startup into
`<roster>.menagerie.token` (0600, rewritten every start) and accepts it in an
`x-m59-menagerie` header on loopback. The `caller.menagerie` flag is decided at the socket
and carried — never settable from a tool argument.

**This is a capability, not a security boundary, and it must never be described as one.**
Anything that can read a file on this machine can drive a host, and the operator is
supposed to be able to. What it stops is the **accident**, because nothing in the fleet's
path carries the token and nothing acquires it by mistake. That is the entire requirement.

## The conversion: a character is fleet-owned first

A host is made, not born. The path is deliberate:

1. Create the character into the **fleet** (`m59-makefleet.mjs`) and command it normally —
   out of the newbie area, across the world, to the town it will live in. All the ordinary
   tools work, because it is an ordinary fleet character.
2. `enlist` it. Its roster entry moves from the fleet's file to the menagerie's.
3. Restart the broker so it picks the split up.

`enlist` **refuses while a broker is holding the fleet**, because the broker keeps both
rosters in memory and writes them back — a conversion made underneath it is undone by the
next write and nothing says so. Both files are backed up first, and the menagerie is
written **before** the fleet roster is trimmed: a crash between the two writes leaves the
character in *both* files, which the broker refuses to resume, loudly, naming both paths.
The other order loses it from both, and that is a password gone.

`discharge` is the same thing backwards, and drops the `host` block on the way.

## What a host does: a script, which is data

`substrate/menagerie/scripts/<name>.json`, reloaded when its mtime changes, so changing
what a merchant says is an edit rather than a restart. **There is no language model
anywhere in it** — the input is a sentence typed by a stranger who may be trying to make
the thing reading it do something, and a lookup table cannot be injected. The same argument
`m59-chatter.mjs` makes for tier 0.

```json
{
  "name": "merchant-tos", "kind": "merchant",
  "broadcast": { "every_s": 240, "lines": ["Arms and armour, bought and sold."] },
  "dialogue": [ { "intent": "wares", "when": "\\b(what|sell|buy|wares)\\b",
                  "say": ["I deal in arms and armour."] } ],
  "routine": [ { "do": "stand", "seconds": 240 }, { "do": "broadcast", "seconds": 5 } ],
  "shop": { "sell_markup": 1.25, "buy_markdown": 0.6,
            "haggle": { "min_ratio": 0.85, "max_rounds": 2 },
            "free_for_fleet_above": 5000,
            "refuses": ["amulet of shadows", "ring of lethargy"] }
}
```

`substrate/menagerie/scripts.example/` holds the committed shape. The real scripts are
gitignored, because **a script is an instruction to a character, not a description of
one** — the same argument this repository already makes for loadouts, playbooks and tuning.
An instruction that arrives from somebody else's afternoon is obeyed silently by a
character talking to real players on a shared server. And the example lives *beside* the
directory the runtime enumerates, never inside it, because `listScripts()` reads every
`.json` in `scripts/`.

Rules the script engine enforces, each because the alternative is silent:

- a script that **will not load leaves the host doing what it was already doing** — the
  standing rule for every file here that carries orders. A mute merchant is
  indistinguishable from a healthy one to everything except the players in front of it.
- a rule that **matches but says nothing is dropped**, not half-loaded, or it would swallow
  every later rule.
- **patterns are bounded** (200 chars) and lines are bounded (400) — an operator's typo
  should be a refused load, not a driver that stops answering.
- the **haggle terminates**: below the floor it counters, and at `max_rounds` it refuses and
  names its floor. A negotiation that can run for ever is a character being talked at until
  the server drops it.
- the **routine is a pure function of elapsed time**, so a driver that crashed and came back
  resumes mid-cycle without having written anything down.

## The posture: a host is not a fleet character wearing a merchant's script

A host arrives from the fleet still wearing fleet orders — `goap`, hunting, roaming. Left
alone, its keeper walks the merchant out of the shop to go and kill things, and the driver,
seeing it in the wrong room, walks it back. **A livelock in which both halves are working
perfectly**, and nothing errors.

So being a host is a posture, converged every round (never set once — a keeper re-applies
its boot orders on every rejoin):

| | |
|---|---|
| `mode: survive` | never picks a fight the owner did not ask for |
| `roam: false` | it has a shop; it does not wander |
| `assigned_room` | so the keeper's "home" and the driver's are one number, not two opinions |

Identity, mortality, survival and recovery stay with the keeper. An unattended merchant
still runs from a fight it is losing — that is the protected-faculty rule from
[`m59-boundary.md`](m59-boundary.md) and it is not the menagerie's to switch off.

## Traps, one line each

- **A host is only a host once the broker has reloaded.** `enlist` moves a file; the broker
  holds a map. Until it restarts, the fleet's tools still reach that character.
- **A keeper resolves its own credentials from disk** and had to be taught the second file —
  both hosts spawned, exited with "not found in shadow.json", and the broker said only
  `keeper process did not become ready`. Nothing said "menagerie" anywhere in the failure.
- **Read the shape, do not remember it.** The room number is `status.where.num`. The first
  version of the driver read `where.room_id`, got `NaN`, and printed "nothing to do" for two
  hosts standing in the wrong towns. An unreadable room is now *said*, never treated as home.
- **A journey in flight is not a journey that needs starting.** Re-issuing `travel` into
  itself on a 30-second round is one of the three silent failures that broke
  `m59-outfit.mjs`; the driver checks `job.busy` first.
- **An agent in both rosters is a corrupted split**, and the broker refuses to resume rather
  than picking one — whichever file was written last would decide what the character is.
- **A menagerie roster that will not parse is not an empty menagerie.** An empty host set is
  an *open door*, so the load fails loudly and the broker holds no hosts at all rather than
  coming up healthy and quietly commandable.
