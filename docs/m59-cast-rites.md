# Cast rites and the trance door

Two things a spell needs from the harness, and where each one lives.

```bash
node tools/m59-castrite-test.mjs          # the guard (offline)
node tools/m59-strategies.mjs             # is a casting strategy loaded on this machine?
```

## 1. A trance is never broken by accident

A spell with `viCast_time` puts the caster in a **trance**: the cost is paid up front, and **any**
event fizzles it (trance.kod:96 ignores the event type): another cast, an attack, using or unusing an
item, sitting down, a room change, any health lost, and **running**. **Walking does not break it**
(user.kod:2958 tests `speed > USER_WALKING_SPEED`, which is 18). Sixty-odd spells charge, from create food
(0.5 s) to enchant weapon (30 s), and the charge lasts `viCast_time * (150 - spellpower) / 100`. Facts and
sentences: `tools/m59-trance.mjs`. Catalogue column: `cast_time_ms` in `substrate/m59-spells.json`.

Before 2026-10-16 only two cast sites held still for one: the keeper's `/action cast` and blink. Now
**every cast that leaves the socket** opens a hold, through `M59Client.cast` → `onCastSent` →
`Session.noteCastSent`:

| | a caller's own hold (`holdForCast`) | the automatic hold |
|---|---|---|
| opened by | the call site | the session, for any cast with a trance, when no hold is open |
| sized | by the caller | the longest the trance can last (spellpower 1) + 750 ms |
| ended by | the caller (`releaseCastHold`) | "concentration is broken", a refusal, a hit, a room change, no "You focus your whole will" within 3 s, or the clock |
| moves, sits, gear, attacks | dropped (`{held:true}`) | dropped |
| reads | dropped | **sent** (a query raises no trance event) |
| another cast | sent (it opened the hold) | **waits** for the trance to end, unless it passes `breakTrance` |

Breaking one on purpose is explicit: `pacer.breakTrance(reason)`, or a cast submitted with
`{ breakTrance: true }`. A move that must happen mid-trance is submitted with `{ walkInTrance: true }`,
and `M59Client.moveTo` clamps **every** move sent during a trance to walking speed.

## 2. Warm-up and warm-down around a cast: stash, dress, cast, pop

```bash
node tools/m59-spellgear.mjs roles               # role tags on this machine
node tools/m59-spellgear.mjs tag t5 mage         # substrate/cast-roles.json (gitignored orders)
node tools/m59-spellpower.mjs show               # every wearable item's spellpower modifier
node tools/m59-spellpower.mjs build              # regenerate substrate/m59-spellmods.json from the kod
node tools/m59-spellgear-test.mjs                # the framework, offline
```

**The harness ships the framework, and the framework does nothing on its own** (operator,
2026-10-16). What to wear for a spell, who counts as a mage, which weapon a caster prefers, and when a
robe may be worn are all private policy. Ours lives in m59-private
`strategy/strategies/cast-gear.mjs` and `_mage-plan.mjs`. With no strategy answering, a wrapped cast is
sent exactly as before, whatever a character is tagged.

| piece | public, in the harness | private, in a strategy |
|---|---|---|
| facts | each item's slot, hands and spellpower modifier for a spell (`m59-spellpower.mjs`, from the kod) | n/a |
| mechanics | legal hands, the fewest packets between two gear states, stash and pop, urgent pacing, the trance wait (`m59-spellgear.mjs`, `m59-castrite.mjs`) | n/a |
| tags | `substrate/cast-roles.json`, handed over as `ctx.role` and meaningless to the engine | what each role does |
| choice | the `castRite` / `idleGear` hooks and their closed answer shapes | the plan: what to wear, when, for whom |

**`castRite(ctx)`** may answer:
- `{ wear: { weapon?, shield?, armour?, helm? } }` gives the target per slot, an item id or `null` for
  empty. The engine finds the fewest legal packets. It refuses the whole target if it is illegal: a
  bow beside an ordinary shield, an item in the wrong slot, a cursed item to take off.
- `{ steps: [...] }` gives explicit packets instead.
- `{ skip: true }` means cast as-is.
- With `restore: 'after' | 'linger' (linger_ms, while_fighting) | 'never'`.

`ctx` carries the spell, the role tag, and PvP and fight state. It has the room and whether it is an
inn, and `hands_locked` (the keeper owns the hands for touch training or the roulette). It lists every
carried item with its slot, hands, grade, curse and broken marks, and its modifier for this spell.

**`idleGear(ctx)`** is asked on every room change and every ten seconds of a keeper pass, but never
inside a rite, a trance or a fight. It may answer `steps` (fix what is worn now), `forbid` (patterns
excluded from `wearBest`) and `prefer_weapons` (patterns `weaponRanking` puts first, after its
magic-first rule, until the next answer).

**The packets.** Using a weapon, shield, armour or helmet replaces what is in that slot
(`weapon.kod:474`, `shield.kod:93`, `armor.kod:49`, `helmet.kod:46`), so a swap costs one packet. A bow
takes both hands (`ranged.kod:45`), so it is unequipped explicitly first. The server's automatic
freeing of hand slots is upstream #1423, and the prod server may not have it. The pop runs the same
transition back to the stash, slot by slot.

**Speed.** The server counts packets per wall-clock second and drops use, unuse, cast, attack and
move after the fifth (`user.kod:874-886`). The Pacer already spaces packets 200 ms apart. Rite packets
are sent **urgent**, ahead of queued movement, and back to back without waiting for each echo. Measured
offline on the real Pacer: three swaps put the cast on the wire about 0.6 s after it was asked for.
While a rite is open, the keeper's own `equipBest`/`wearBest` stand down, and a failed cast still pops
the stash.

**What gear does to spellpower** (`m59-spellpower.mjs`, generated from the kod by `build`):

| | modifier | source |
|---|---|---|
| weapons, by type | slash -15, thrust -10, bludgeon 0 | `weapon.kod:45-48`, `:386` |
| weapon quality | low +5, high -5, nerudite +5 | `weapon.kod:73-75` |
| so | axe -15, scimitar -20, long sword -10, mystic sword -15, short sword -5, hammer 0, **mace +5** | |
| bows (two hands) | practice -10, longbow -20, bow/crossbow/magic bow -25, battle bow -30, nerudite 0 | `ranged.kod:209` |
| body armour | plate -30, scale -20, nerudite -20, chain -15, leather 0, robes +10 | `armor/*.kod` |
| helms | -5 | `helmet/*.kod` |
| by school | disciple robe +4 per spell level known in its school (max +20), else +5; ivy circlet Shal'ille +15 / Qor -15; orc shield Qor +15 / Shal'ille -15; torch Faren +10; sword of Riija Riija +10 / else -10 | each file's `GetBaseSpellModifier` |
| Kraanan | a negative total is halved | `spell.kod` GetSpellPower |

A disciple robe makes its wearer take 10% more damage from weapons and 20% more from fire, and 15%
less from shock (`robedisc.kod:298`). Its school appears only in its look text, so `idleGearCheck`
looks at each robe once while idle, and `ctx` reports `robe_school` once it is known. A guild shield's
insignia and a Duke's shield's rank are not read, so they count as 0.

**Which casts are wrapped.** Twelve autopilot sites (touch spells, cooking, weapons, self buffs,
provisioning, medic, rescue, chalice, room enchantment, desk practice, ally buffs), the three
CombatMode sites (PvP opener, sequence, warband buff), the heal in `m59-skills`, and the keeper's
`/action cast`, which DUM and fleetscripts use. **Not wrapped:** blink (an escape never waits on gear),
the behaviour-tree casts (`m59-bt-*`), `m59-tick`, `m59-decide`, RTS casts and `m59-rescue`. The trance
door in part 1 covers every site, wrapped or not.

**Status:** `autopilot action=status` carries `cast_rite`: the role tag, the costume being worn now with
its stash, or the last rite that was popped.
