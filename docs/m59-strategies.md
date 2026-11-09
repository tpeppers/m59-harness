# Farming strategy files

One file per farming task, assigned to a character by name, applied by the keeper. Split out of
[`CLAUDE.md`](../CLAUDE.md), whose "about to / read" table points here.

```bash
node tools/m59-strategy-engine.mjs                 # what this machine has, and whether each one loads
node tools/m59-strategy-engine.mjs check <name>    # one file: what it sets, under which faculty
node tools/m59-strategy-engine.mjs --example       # the committed examples
node tools/m59-strategy-engine-test.mjs            # the guard (offline)
```

```text
autopilot action=start agent=t9 mode=farm farm_strategy=qor-acid-touch-trees   # assign
autopilot action=start agent=t9 farm_strategy=null                             # unassign (and clear residue)
autopilot action=start agent=t16 spare_creatures=null                          # clear a spare list
autopilot action=status agent=t9            # farm_strategy {state, keys, hooks, refused}, policy_sources
```

## What the operator asked for, and the split it implies

The operator, 2026-10-02, in order:

1. *"autopilot should support a kind of generic 'farming strategy'-FleetScript file that it will
   execute on, with the FleetScript file outlining what weapons to use, what monsters to
   hunt/prioritize, what loot to prioritize, what maps to confine the farming to, etc."*
2. *"when I call it generic, I just mean from the perspective of the keeper/autopilot, the farming
   strategy files intend to be highly specialized for their tasks"*
3. *"Just the autopilot/keeper side of it should be generic support for it, not having a bunch of
   'if using acid touch …' on the autopilot/keeper side, that specialized logic belongs in the
   farming strategy files"*
4. *"That all said, the generic touch spell support belongs in the keeper/autopilot/whatever
   central location"*

So there are three layers, and each one knows nothing about the one above it:

| layer | where | knows |
|---|---|---|
| **primitives** | `m59-touchspell.mjs`, `m59-hunt-priority.mjs`, `m59-loot-filter.mjs`, `m59-overfarm.mjs`, confinement, arming and banned weapons, `m59-deskpractice.mjs` | how to do one generic thing — train any touch spell, order any hunt set, filter any creature's drop |
| **the engine** | `m59-strategy-engine.mjs`, `m59-strategy-schema.mjs`, `m59-policy-sources.mjs` | how to load, validate, apply, yield, reload and report a file — and nothing about spells, creatures, items or rooms |
| **the file** | `substrate/farm-strategies/<name>.mjs` | one task: which primitives, with which arguments, plus the logic only this task needs |

The keeper (`m59-autopilot.mjs`) is bound to the engine in a handful of lines and reads no field
of a strategy: `applyFarmStrategy` at the top of every pass (and after a push, a rejoin, or a
loadout write), `farmStrategyHook` at the swing and the kill, `farmStrategyStatus` and
`policy_sources` in status, `policyForOrders` for anything that persists. The test pins that no
line naming `farmStrategy` in the keeper also names a spell, creature or room.

## Not `substrate/strategies/`

That directory already exists and is a different system: the TRAVEL strategies
(`m59-strategies.mjs` — blink-escape, convoy, town stops, chalice). A travel strategy is a
fleet-wide hook module that every keeper asks at a stuck walk or a counter, switched by its own
`enabled`. A farming strategy is **assigned to one character by name**, is declarative first, is
re-applied every pass, and is hot-reloaded. Folding the two together would have meant giving the
travel files an assignment they do not have, or giving these an `enabled` that would make one
file every character's orders. So they are siblings:

| | travel strategies | farming strategies |
|---|---|---|
| directory | `substrate/strategies/` | `substrate/farm-strategies/` |
| committed shape | `substrate/strategies.example.mjs` | `substrate/farm-strategies.example/` |
| loader | `m59-strategies.mjs`, enumerates its directory | `m59-strategy-engine.mjs`, reads exactly `<name>.mjs` |
| in force | every file with `enabled: true`, for every keeper | the one file named by `policy.farmStrategy`, for that character |

Neither loader reads the other's directory. **m59-private's sync carries `strategy/strategies`;
farming strategies need their own carry entry there** (not added by this repository).

## The file

Declarations first. Every declared field maps onto a policy key the keeper already obeys and is
validated by the same function the broker's `autopilot` tool uses for that key — so a file can
say nothing an operator could not already say with one `autopilot` call. It only says it once, by
name, for one task.

```js
// substrate/farm-strategies/wand-farmer-spiders-first.mjs
export default {
  name: 'wand-farmer-spiders-first',          // must equal the file name
  describe: 'Faronath 537: spiders first; from a spider only purple mushrooms.',

  hunt: ['spider', 'living tree'],            // -> hunt                     [work]
  huntPriority: ['spider', 'living tree'],    // -> huntPriority             [work]
  lootOnly: { spider: ['purple mushroom'] },  // -> lootOnly                 [economy]
  protect: ['wand', 'entroot berry'],         // -> protectedItems (ADDED)   [economy]
  confine: { station: 537, roam: false },     // -> assignedRoom, roam       [movement]

  hooks: {
    onKill(ctx, kill) { ctx.memory.n = (ctx.memory.n ?? 0) + 1; },
  },
};
```

| field | policy key | faculty | validator |
|---|---|---|---|
| `hunt` | `hunt` | work | the broker's hunt normal form |
| `huntPriority` | `huntPriority` | work | `huntPrioritySpec` |
| `lootOnly` | `lootOnly` | economy | `lootOnlySpec`, items resolved |
| `lootUnrevealedWeapons` | `lootUnrevealedWeapons` | economy | `unrevealedWeaponMode`: `'always'` \| `'desk'` \| `'never'`; see [Unidentified weapons](#unidentified-weapons-lootunrevealedweapons-a-cursed-one-wields-itself) |
| `protect` | `protectedItems` | economy | items resolved; **added to** the existing list, never replacing it |
| `overfarm` | `overfarm` | economy | `normalizeOverfarm`, unknown keys refused |
| `weapons.touchSpell` | `touchSpell` | work | `touchSpellName` |
| `weapons.touchSpellTiming` | `touchSpellTiming` | work | `touchCastTiming` |
| `weapons.priority` | `weaponPriority` | work | list of names |
| `weapons.banned` | `bannedWeapons` | work | list of names, lower-cased |
| `weapons.style` | `trainingStyle` | work | the five training styles |
| `weapons.preferMagic` | `preferMagicWeapon` | work | boolean |
| `weapons.preferMundane` | `preferMundaneWeapon` | work | boolean |
| `weapons.magicFor` | `magicWeaponFor` | work | creature name fragments, lower-cased; `[]`/`null` is off -- see [Magic for](#magic-for-weaponsmagicfor-the-dedicated-weapon-for-these-quarries-only) |
| `confine.rooms` | `confineRooms` | movement | room numbers -- the destination AND the road: a journey plans only through these (`confinementAvoid`; from outside them, the confined road home when one exists) |
| `confine.station` | `assignedRoom` | movement | a room number |
| `confine.roam` | `roam` | movement | boolean |
| `vigor.fightAbove` | `fightAboveVigor`, `vigorFloor` | work | 0..200, as `applyFightAboveVigor` |
| `vigor.relayBeforeRest` | `relayBeforeRest` | work | Boolean, default off. Enables [Relay-optimized farming](#relay-optimized-farming) where the cohort and drops qualify. |
| `practice` | `practiceSpells` | work | `normalizePractice`, problems refused |
| `huntArea` | `huntArea` | work | `normHuntArea`: `{ room, squares: [[row, col], ...] }` — in that room only quarry on a listed square is chosen, and an idle farmer walks back onto the area (`m59-hunt-area-test.mjs`) |
| `gangUp` | `gangUp` | work | `normalizeGangUp`: `{ '<creature>': { min, radius } }` (defaults `min: 2`, `radius: 4`) — a listed creature is quarry only while `min - 1` other fleet-mates stand within `radius` squares of IT; see [Gang up](#gang-up-gangup-a-creature-fought-only-two-on-one) (`m59-gang-up-test.mjs`) |
| `patrol` | `patrol` | work | `normPatrol` (`m59-patrol-farm.mjs`): `{ room, loop: [{ row, col }, ...], engageWithin?, engageWalk?, arriveWithin?, legSteps?, resumeSlack? }` — in that room a farmer with nothing in reach walks the loop instead of holding a wall; see [Patrol](#patrol-patrol-walk-the-spawn-points-in-a-loop) (`m59-patrol-farm-test.mjs`) |
| `chaseOnFoot` | `chaseOnFoot` | work | boolean, default off: rank quarry by steps on foot and walk the route to one round a ledge; see [chase on foot](m59-combat.md#chase-on-foot--walk-as-if-to-stand-on-the-quarry) (`m59-chase-test.mjs`) |
| `secondWind` | `secondWindFarming` | work | `'off'` (default), `'auto'`, `'on'`, `{ mode, prey_ratio, eat }`: against weak prey, no vigor floor and no meals; see [docs/m59-policy.md](m59-policy.md) (`m59-second-wind-test.mjs`) |
| `patrol` | `patrol` | work | `normPatrol` (`m59-patrol-farm.mjs`): `{ room, loop: [{ row, col }, ...], engageWithin?, arriveWithin?, legSteps?, resumeSlack? }` — in that room a farmer with nothing in reach walks the loop instead of holding a wall; see [Patrol](#patrol-patrol-walk-the-spawn-points-in-a-loop) (`m59-patrol-farm-test.mjs`) |
| `needle` | `needle` | work | `normNeedle` (`m59-needle-farm.mjs`): `{ site: '<name>' \| {...}, role: 'striker' \| 'archer' }` — in the site's room the keeper holds its needle slot (the striker at the tip, an archer on its station), strikes or shoots the closest valid monster in reach, and the front archer pulls after 15 s of quiet; the squares and replacement order are this machine's `substrate/needles/<site>.json`; see [The needle](#the-needle-needle-one-striker-at-the-tip-archers-behind-it-a-pull-when-it-goes-quiet) (`m59-needle-farm-test.mjs`) |
| `town` | `farmTown` | economy | `normalizeFarmTown` (`m59-farm-town.mjs`): `{ name?, sell: [{ seller, room }], buy: { food \| weapons \| armor \| reagents: [{ seller, room, items }] }, bank: { room } \| null, keep: [items], hall?: { room, magicWeapons?, weaponsTripAt? }, uncurse?: { seller, room, item? } }` — this farm's own town: every mainland town trip uses these counters and only these, buys only the listed items (a kind with no counter is not bought at all), sells to the named sellers, never offers `keep` there; the island and the Avar Village keep their own towns; see [A farm's own town](m59-economy.md#a-farms-own-town-town-shop-where-the-farm-is) (`m59-farm-town-test.mjs`) |
| `guildTithe` | `guildTithe` | economy | `normalizeGuildTithe` (`m59-tithe.mjs`): a daily amount or `{ dailyAmount }` — the broker's `guild_tithe` from a strategy: pay Frular (700) at most this much a day from verified town-sale proceeds; with a farm town `hall`, on the hall road; see [The guild hall instead of a bank](m59-economy.md#the-guild-hall-instead-of-a-bank-the-rent-magic-weapons-and-a-cursed-weapon-townhall-townuncurse-guildtithe) (`m59-farm-hall-test.mjs`) |
| `travelHunt` | `travelHunt` | work | `normalizeTravelHunt` (`m59-travel-hunt.mjs`): `true` or `{ reach, maxThreats, maxPerJourney (null: uncapped), cooldownS, skipRooms, origins }` — on the keeper's OWN work journeys (town trips, the walk back to the station) fight in-band monsters within `reach` squares of the road, then walk on; never on another issuer's order, never below the flee line, a new fight only at the engage line; see [docs/m59-boundary.md](m59-boundary.md#a-journey-may-hunt-on-the-road-travelhunt-and-only-its-own) (`m59-travel-hunt-test.mjs`) |
| `cookFood` | `cookFood` | work | `normalizeCookFood` (`m59-cook-food.mjs`): `true` or `{ first, reserveCasts }` — a create-food knower casts from carried elderberry + herbs before eating carried food while below its vigor ceiling (off: cook only with an empty larder); never with something in reach (`m59-cook-food-test.mjs`) |

**A GUARD ZONE OVERRIDES IT FOR ONE CHARACTER.** `autopilot action=start guard_zone={ room, from: {row, col}, to: {row, col} }` (or `{ room, squares }`) is an operator order to one character, stored as `policy.guardZone` (`normGuardZone`, which keeps the drawn `rect`). In its own room it is the area `huntAreaHere` uses, in place of the strategy file's `huntArea`; `guard_zone: null` hands the room back to the file. The field command's room map draws one by dragging a rectangle (operator 2026-10-16).

`protect` is additive on purpose: a strategy that replaced the list would quietly unprotect the
reagents the roster put there, and the next sell would take them.

`confine.rooms` already binds where the survival ladder may retreat to (that is what a
confinement is, whoever sets it, and the Underworld escape is exempt). It is listed under
movement because it is the operator's "what maps to confine the farming to"; a strategy cannot
change *whether* or *when* a character retreats.

The three committed examples, each one of 2026-10-02's real orders:

| file | order |
|---|---|
| `qor-acid-touch-trees` | Camilla (t9): acid touch through the central touch support, living trees, station 536, entroot berries protected |
| `wand-farmer-spiders-first` | Kermit (t1): spider + living tree, spiders first, from a spider only purple mushrooms, station 537, wand + entroot berry protected |
| `cv-skeletons` | the Castle Victoria undead: battered skeleton, skeleton, zombie; hammer then mace; confined to 39 and its bridge room 38 |

### Relay-optimized farming

Set `vigor: { fightAbove: 140, ceiling: 200, relayBeforeRest: true }` on a farming strategy.
The keeper uses the mode in a room with at least two verified automated farmers, Relay
known by the farming cohort, and edible mushrooms in the spawn loot table. It uses the
personal resting threshold reported by the game.

A farmer below that threshold can spend vigor on an eligible ally before sitting safely
to recover it for free. A healthy farmer can also help a rested ally who is below its
fight floor when the entire possible donation leaves the donor with at least 150 vigor
and its own fight floor. Optional top-offs in the assigned room save edible mushrooms
for Relay. A farmer who needs food to reach its fight floor can still eat them. Relay
costs five mana and one edible mushroom and only admits recipients below 150 vigor.
The server adds a 25% transfer bonus, so the last cast can land slightly above 150.
An Inky-cap mushroom provides 50 vigor when there is room under the 200 cap.

### Hooks

For the logic only this task needs. Five moments:

| hook | when | payload |
|---|---|---|
| `onPass(ctx)` | every pass, after the file is applied | `{ reason }` |
| `onCombatLine(ctx, line)` | each new combat line (`classifyCombatLine` parsed it) | `{ text, parsed }` |
| `onServerMessage(ctx, msg)` | each new non-combat server line | `{ text }` |
| `beforeSwing(ctx, s)` | before each prey swing, before the touch-spell check | `{ target, target_id, room }` |
| `onKill(ctx, kill)` | after a counted kill | `{ creature, room, looted }` |

`ctx` is: `strategy`, `agent`, `now`, `room` (number), `vitals`, `policy` and `touch` (frozen
copies), `memory` (a scratch object, reset on reload), `pack()` (name and amount, a copy),
`note(what, data)`, `set(path, value)` and `requestTouchRecast(why)`.

- `ctx.set` takes a field **path** from the table above (`'huntPriority'`, `'weapons.touchSpell'`),
  validates it the same way, applies it at once if the keeper owns its faculty and returns
  `{ applied: false, yielded_to }` if not, and credits it `strategy:<name>` with `hook: true`.
  Anything else — `fleeBelow`, a war key, a made-up name — THROWS, which disables the hook.
- `ctx.requestTouchRecast` marks the CENTRAL touch-spell state stale; the keeper's own
  `maintainTouchSpell` recasts at the next opportunity under its own rate limit. The hook never
  casts.

Hooks are **isolated, not sandboxed**. A strategy file is code this machine chose to run, like a
playbook. What the engine guarantees is that a bad one cannot take the keeper down: hooks are
called synchronously and never awaited; a hook that throws, or whose promise rejects, is
**disabled and noted**; one over its time budget (`M59_STRATEGY_HOOK_MS`, 25ms) three times is
disabled too; the rest of the strategy keeps applying; an edit to the file re-enables it. Hooks
do not run at all while a bot or lease holds `work` (counted as `skipped_held`). A file whose
top-level code never returns would still hang the keeper at import — keep top level to
declarations.

## The rules

### 1. Two writers is the known failure — so the file yields

A key is applied only while the keeper owns its faculty (`facultyOwner(f)` is `keeper`, or the
keeper's own `combat:<id>`). While a bot (DUM), a lease, or an errand (`inert`) holds it, the
engine **writes nothing to that key**, notes "yielding to the faculty holder" once, and status
shows `yielded_to: <holder>` per key. When the lease ends the file's value returns, once. The
test drives six passes with a bot changing its mind under a held `work` and counts zero writes.

### 2. Never the protected four, never the war paths

The schema refuses — the WHOLE file — any field named for identity, mortality, survival or
recovery (`fleeBelow`, `restBelow`, `travelGuard`, `panicLogoff`, …) or for the war and PvP paths
(`defendAgainstPlayers`, `pvpReturnDelayMs`, `warResponse`, `warband`, `keepOff`, `leash`,
`combatOrder`, …), at any depth. Refused whole because its author believed the file would change
how the character survives, and applying the rest while silently not doing that is the setting
that does nothing. `mode` is refused too: it is the switch the ASSIGNMENT throws. A strategy chooses
what to hunt; it cannot change when a character flees, fights back or answers a war alarm.
`m59-unattended-test.mjs` stays the guard for the faculty split.

### 3. One answer per key — `policy_sources`

Every writer of `autopilot.policy` now credits what it **changed** (only changed: the broker pushes
the whole policy on every `autopilot` call) in `m59-policy-sources.mjs`, reported as
`policy_sources`:

| source | writer |
|---|---|
| `default` | nothing has written it |
| `roster` | the roster the keeper booted with |
| `carry` | a push the previous keeper process carried across its restart |
| `policy` | a live push; `by` names the writer |
| `bot:<owner>` | a live push that changed a key while `<owner>` held its faculty |
| `loadout` | the loadout file's policy block |
| `strategy:<name>` | the farming strategy (`hook: true` when a hook set it) |

`farm_strategy.keys` adds, per key, the file's value, the effective value, whether it is applied,
who it is yielded to, and what it is **shadowing** (value and source) — which is also what an
unassignment gives back. "Why is t1 hunting spiders" is `policy_sources.hunt`.

While the keeper owns a faculty and a strategy is assigned, the file is the answer for its keys:
a push of `hunt` is kept underneath and the file reasserts at once (in the same `/policy` request,
not a pass later), and the broker's reply says so as `farm_strategy_shadows`. To change such a
key, edit the file or unassign it.

### 4. Files are orders, so they are this machine's — and silence is the old behaviour

`substrate/farm-strategies/` is gitignored; `substrate/farm-strategies.example/` is committed
BESIDE it, never inside it. No directory, no assignment, or `farm_strategy=null` is exactly the
behaviour that was already there.

A missing or unparseable file is **not an empty policy**:

- at assignment, the broker refuses it with the reason and changes nothing;
- at a later load (the file was edited, deleted, broken), the engine refuses it, notes it once,
  and the character keeps its posture — the **previous good version** of the same file if there
  was one (`refused.keeping`), otherwise nothing from the file is applied at all;
- an unrecognised key is reported (`unrecognised`), never applied, never fatal.

### 5. The carry

**Only the assignment travels.** `farmStrategy` is an ordinary policy key in the Autopilot default
object, set by the broker, pushed over `/policy`, written into the keeper's order copy and carried
across a keeper restart like any push (`m59-keeper-carry.mjs`). The file's own keys are written
straight into `autopilot.policy` and **never** into the keeper's order copy, the roster or the
carry: each keeper process re-derives them from the file on its first pass (and on `join`, before
`start()`). A carried copy of a file's keys would be a second, stale source for the same key that
reads as a live push. The broker persists `policyForOrders()` — the policy with the overlay taken
back out — for the same reason.

### The leak this rule did not stop (2026-10-03/04), and the three seams that now do

**Observed on prod.** Floyd (t16) was unassigned from `icky-cave-orc-clear` and retasked, and kept
`spareCreatures ["spider"]` and `confineRooms [27]` for ever; Animal (t10) had done the same earlier.
`autopilot status` showed per key `shadowing: {value: ["spider"], source: "carry"}` — the file's own
value, underneath the file. The engine never wrote a key to the roster. **The broker did, by reading
it back:**

1. `m59-broker.mjs`, the `autopilot` tool, `action=start` on a keeper-backed character, seeded the shell
   it assembles an order in with `p.policy = { ...live.autopilot_status.policy }` — the keeper's
   EFFECTIVE policy, overlay included.
2. It persisted that with `rememberAutopilot(..., p.policyForOrders?.() ?? ...)`. But the shell never
   runs a pass, so it never converges a strategy, so its `policyForOrders()` is the overlay unchanged:
   the file's values went into the roster as orders. (The rule above held only for an in-process
   keeper; every prod character is keeper-backed.)
3. `pushPolicyToKeeper` sent the whole object to the keeper's `POST /policy`, which merges it into its
   ORDER COPY (`Object.assign(policy, fields)`, `m59-keeper-process.mjs`) — the copy the carry
   captures and every rejoin re-imposes, credited `carry` at join.
4. On the next rejoin or keeper restart a fresh engine took that value for what the file was
   SHADOWING, so unassigning "gave back" the file's own value. And nothing could clear
   `spareCreatures` from outside: the `autopilot` tool had no argument for it.

**Fixed at each seam:**

- **The keeper publishes its orders.** `autopilot_status.policy_orders` is `policyForOrders()` whenever a
  strategy engine exists. The broker seeds from `ordersFromStatus(status)` (`m59-strategy-engine.mjs`),
  which reads `policy_orders`, or — from a keeper that predates it — puts each APPLIED key back to its
  `farm_strategy.keys[k].shadowing.value`, so the roster stops receiving the overlay on the broker
  restart alone.
- **The keeper refuses an echo.** `/policy` asks the engine (`pushEcho`) which pushed keys carry exactly
  the value the FILE wrote (an echo: kept out of the order copy and out of the live policy) or exactly
  what the file is shadowing (a restatement: into the order copy, not over the overlay, so the file does
  not "reassert" on every push). The reply says so as `strategy_echo`. This is what protects against any
  OTHER writer that pushes the effective policy back — an older broker, anything on the port.
- **An unassignment clears old damage.** A roster or carry written before the fix still holds the file's
  values. When `farm_strategy=null` arrives, every key the file declares whose ORDER still reads exactly
  the file's value goes back to the Autopilot default (`strategyResidue`, defaults from `policyDefaults()`,
  captured from the first orderless Autopilot) and the reply says so as `farm_strategy_released`
  (`reset_to_default`, `kept_matching_the_file`). Three exceptions: an argument given in the same call
  wins (that is an order, given now); `protect` is additive and never a replacement; and `hunt` is kept
  and reported, because a farm with nothing to hunt is refused and a hunt that matches the file's is as
  likely the operator's own order as a residue. Silence then means the behaviour that was there before
  the file — the rule in CLAUDE.md — not the file's value wearing an order's clothes.

### `spare_creatures`

The `autopilot` tool now takes `spare_creatures` (a list, or `null`/`[]` to clear), normalised by the
same function as a strategy's `spare` (whole words, lower-cased; a non-list is refused, not coerced).
`spareCreatures` was already named in the Autopilot default object, so the keeper's push merge applies
it and the session's attack veto reads it on the next swing (`m59-spare.mjs`); `policy_control` reflects
it. While a strategy that declares `spare` is assigned and the keeper owns `work`, the file's value is the
one in force and the argument is held underneath (`farm_strategy_shadows`).

**Deploying it** needs a broker restart (the tool argument, the seeding and the residue clearing are the
broker's) and a keeper restart (`policy_orders` and the echo filter are the keeper's) —
`m59-service.mjs restart` then `restart-keepers`. The broker half alone already stops new damage, through
`shadowing`; the keeper half is what holds against every other writer.

### `spare_blockers`: a spared creature IN THE WAY

Operator, 2026-10-11, of Qor casters crossing the Barloque sewers: walk them *"without fighting/killing
its rats, even if they get stuck ... maybe sometimes you have to hit them once and then back up so they'll
chase you"*. A spared rat in a one-square pipe is a wall, and before this the two rungs that answer a jam
by swinging (`tradeInPlaceIfWedged`, `passFightBack`) picked the spared body and had the swing refused by
the spare filter — a wasted pass every pass, with a fightable creature behind it never chosen; and
`clearPathCheck` cancelled the walk to make room for that refused swing. All three now skip spared bodies.

When a spared body is ALL that is in reach of a wedged character above its flee line, `lureSparedBlocker`
answers, by `spareBlockers` (strategy) / `spare_blockers` (tool), movement faculty:

| value | does |
|---|---|
| `null` / `"off"` | the old behaviour: the movement ladder sidesteps, lanes and backs off |
| `"lure"` | back off to a refuge outside the needle (`planBlockerLure`) so the creature follows us out; the chase is watched by object id |
| `"provoke"` | as `lure`, but first ONE swing at it — only when nothing is already hitting us. The spare veto is lifted for that one id for a few seconds (`grantProvoke`) |

At most six lures per room per ten minutes, then it is the movement ladder's again. A provoking swing that
kills is noted loudly (`SPARED BLOCKER DIED`, `tally.spared_killed`). `qor-lupogg-sewers` (example) is the
first user; `m59-spare-blocker-test.mjs` (14, offline) pins it.

### Magic for (`weapons.magicFor`): the dedicated weapon for THESE quarries only

Operator, 2026-11-06, of the Great Ocean mollusk hunters (552/562): *"have them kill the slimes with other
weapons (non-dedicated)" ... "Slimes or fungus, whatever else is on that map".* A Kraanan dedication lapses
after 1-25 h and wears with use, so every swing at a frogman or slime spends it on a creature a plain weapon
kills as well. `preferMagic` / `preferMundane` answer "which weapon" once for the whole day; this answers it
per quarry:

```js
weapons: { priority: ['axe'], preferMagic: true, magicFor: ['mollusk creature'] },
```

- **At fight entry** (`skills.fight` -> `equipBest({ quarry })` -> the keeper's `beforeEquip` hook ->
  `syncMagicSet` / `magicForMode`, `m59-magic-for.mjs`) the quarry's name is matched, case-insensitive
  substring, against the list: listed -> `'magic'` (a weapon the weapon-magic book READ as
  `bypasses_nonmagic`), anything else -> `'mundane'` (any weapon NOT read magic, **any family** -- a hammer
  beside the dedicated axe counts). The swap happens before the first swing; the re-arm after a shatter
  names the quarry too.
- **The wanted kind outranks the family priority** (`weaponRanking`'s first key, `c._magicFor`), and inside
  it the ordinary order decides (a mundane axe before a mundane hammer for an axe trainee).
- **A ranking, never a refusal.** With none of the wanted kind carried every row ties and the weapon in hand
  stays -- it cannot unarm a character or refuse a fight. Cursed, banned, broken and identified-magic-loot
  filters are `weaponRanking`'s, untouched; an **unread** (grade 100) weapon never counts as the mundane kind.
- **One change per 10 s.** A change asked for inside the window is HELD (`MAGIC FOR HELD`, once per window;
  `weapon_magic.magic_for_held`), so a room with both kinds does not swap at every fight. A change is noted
  `MAGIC FOR`.
- **Between fights the decision stands**: an equip that names no quarry (fix-unarmed, a gift, `equip_best`)
  ranks with the last decision, and the timed `applyMagicPreference` swap stands aside once one exists.
  Before the first fight, `preferMagic` / `preferMundane` decide as before; after it, `magicFor` overrides them.
- **Silence is today exactly**: no key (or `[]`/`null`) and nothing above runs. Broker: `magic_weapon_for`;
  status: `policy.magicWeaponFor`, `weapon_magic.magic_for_mode`.

`m59-magic-for-test.mjs` (14, offline) pins it through the real `equipBest` and keeper hook.

### Unidentified weapons (`lootUnrevealedWeapons`): a cursed one wields itself

**PICKING UP A CURSED WEAPON IS WIELDING IT.** `item.kod:508-514` (`NewOwner`) posts `TryUseItem` on
the picker for any item `IsCursed` answers for, and `WeapAttCursed` is one of the attributes it asks; then
`ItemReqUnuse` refuses for ever ("The axe seems to cling to your hand!"). The curse is hidden until the item
is revealed, so on the floor it is a plain `axe`, rarity 100. Operator, 2026-10-30: many of the fleet found
wielding weapons they could not put down, all of them looted. Unidentified rings were already refused for the
same reason; weapons were not, on the mistaken argument that the wield was a separate decision.

```js
lootUnrevealedWeapons: 'desk',   // -> lootUnrevealedWeapons [economy]; broker arg loot_unrevealed_weapons
```

| value | an unidentified weapon on the floor |
|---|---|
| unset / `null` | taken, exactly as before (silence is the old behaviour) |
| `"always"` | taken, said out loud |
| `"desk"` | taken only while some desk on the service board publishes `{ kind: 'uncurse', ok: true }` and has published within 15 minutes; a desk inside `confine.rooms` is preferred. No desk, a stale one, or a board that will not read: left on the floor |
| `"never"` | left on the floor |

Under `desk` and `never` a weapon already graded cursed (rarity 200) is refused too, desk or no desk. A revealed
weapon is never refused, bows count as weapons, and an explicit id list is held to it like the unidentified ring.
The refusal is visible in the loot result (`unidentified weapon — a cursed one equips itself on pickup; no
remove-curse desk`). `autopilot status` reports the verdict as `unrevealed_weapons` (mode, allow, the desk it
rests on, and any refused policy value: an unrecognised value on a keeper is reported and not applied).
`m59-unrevealed-weapons-test.mjs` (offline) pins it.

### Gang up (`gangUp`): a creature fought only two-on-one

Operator, 2026-10-27, of the Guardians of Zjiria in Ukgoth (599; kod StoneTroll, level 120, attack rating 840;
`i9.kod` makes three at game hour 0 whenever none is alive and never removes them): *"If a guardian is seen, they
should try to fight it 2-on-1 (or more than 2 against it), that's the only change it should have from regular
trolls."*

```js
hunt: ['troll', 'guardian of zjiria'],
huntPriority: ['guardian of zjiria', 'troll'],
gangUp: { 'guardian of zjiria': { min: 2, radius: 4 } },
```

**The quorum is at the MONSTER, and the keeper reads it itself.** Minutes before the order a coordinator script had
switched the whole 599 crew to the guardian strategy because two of them were in the ROOM; Janice (t7) was the only one
at the cluster, Bunsen forty rows away, and she fought it alone (`substrate/postmortems/Janice-2026-10-27T19-41-42-645Z.json`).
So a listed creature is a legal target only while at least `min - 1` OTHER fleet-mates stand within `radius` coarse
squares of THAT creature — Chebyshev, `max(|d row|, |d col|)` — in this keeper's own room view, at the moment it
chooses. A fleet-mate is `party.isFleetmate` (the roster and the menagerie's hosts); a stranger beside it never counts.
Where somebody stands is all a keeper can see of who is fighting what, so position is the whole test.

**Without its quorum it is handled exactly as if `hunt` did not name it** — the operator's "only change from regular
trolls", read literally:

- `Autopilot.gangUpFilter` takes it off passFarm's prey list after confinement, the avoid set and the hunt area and
  before the ranking, so the wall chosen for the quarry, the fight, the pull and the close never see it; the farmer
  takes its trolls. `closestPullable` (`pull.throughCrowd`) and the buddy tagger skip it too, and a pull already out for
  one is dropped when its quorum lapses (re-asked every pass, like everything else).
- One that walks up to us is a BYSTANDER, so the regular rules answer it unchanged: the engagement ceiling's *"will not
  trade blows with this"* for a body it outclasses (under 80 max health against a level-120 guardian), hitting back at
  one inside the band. **Self-defence never consults it**: the fight-back edict, the flee and rest ladder and
  `refuseEngagement` are untouched, so a guardian that attacks first is answered as it always was.

**With its quorum it is prey like any other `hunt` entry, and prey is never measured against the engagement ceiling**
(`huntingGrounds`: "the threat ceiling is about bystanders, not about the prey") — which is what lets a 79-health
character take a level-120 guardian with a fleet-mate at it and not without one. The one chooser that did measure prey
against the ceiling, `closestPullable`, applies only the karma half of the refusal to a quorum-met gang-up creature, or
its re-pick would swap the guardian the selection chose for the nearest troll.

It never widens the hunt: a listed creature `hunt` does not name is not prey with or without a quorum, and
`autopilot status` reports such a rule under `gang_up.ignored`. `gang_up.last` names what was left alone, and what was
taken, with the fleet-mates at it. A strategy key only: the `autopilot` tool takes no `gang_up` argument (like
`huntArea`), so it reaches a keeper through a file, needs no broker restart, and is hot-reloaded with the file. The keeper
code that asks it (`gangUpFilter` and the rest) needs a `restart-keepers` handoff. See `m59-gang-up-test.mjs`.

Set `fightInPlace: true` in a creature's rule to let a ready keeper approach that
creature where it stands. The keeper requires the existing opening health and
vigor checks, enough health for the configured open-fight blow count, and fewer
monsters in reach than the crowd threshold. It rechecks the quorum before leaving
cover and before each attack packet. If a crowd forms or support moves away, the
keeper re-evaluates on its next pass. For example, the Great Ocean can use
`gangUp: { 'mollusk creature': { min: 2, radius: 6, fightInPlace: true } }`.

### Patrol (`patrol`): walk the spawn points in a loop

Operator, 2026-11-04, of the Icky Cave (27): *"walk across all the various spawn locations and kill any monsters seen
... those are the rails I'd have it take in an infinite loop, killing everything it comes across ... I'd like to see if
you can get its kills/30m as high as a human player like mine."*

```js
patrol: { room: 27, loop: [{ row: 23, col: 53 }, { row: 35, col: 58 }, { row: 31, col: 31 }, { row: 32, col: 35 },
                           { row: 51, col: 14 }, { row: 50, col: 34 }],
          engageWithin: 8 },          // squares; also arriveWithin 1, legSteps 20, resumeSlack 3
```

**There is one farming path, and this goes through it.** Every farming keeper decides in `Autopilot.passFarm`
(`tools/autopilot/pass-farm.mjs`); a strategy reaches it only as policy keys; the hunt setup, the wall, the pull and
`fight()` are things passFarm calls. FleetScript's `fight` step and the broker's `fight` tool are one-shot fights an
errand or an operator asks for, not farming, and cooperative combat / the buddy system are their own pass stages. So the
patrol changes passFarm at two seams and nowhere else:

- **Which quarry.** After confinement, the avoid set, the hunt area and gang-up, quarry farther than `engageWithin`
  squares (Euclidean) is dropped, and so is quarry farther than `engageWalk` steps **on foot** (default twice
  `engageWithin`; [chase on foot](m59-combat.md#chase-on-foot--walk-as-if-to-stand-on-the-quarry)), except whatever we
  are already fighting or pulling, and anything already within two squares. The rest is left for the loop to meet. In
  the Icky Cave a third of the quarry within 8 squares is round a ledge -- r32c54 -> r32c57 is three squares and 55
  steps -- and the straight radius alone engaged it, failed the approach and waited. The ranking, `huntPriority`, the wall a fight opens from, the pull and the fight then run exactly as before.
- **Nothing to do.** Where passFarm would hold a wall and wait for something to come (the vigil), a patrol walks one
  piece of the loop -- and so does a pass whose only quarry is briefly deferred, rather than standing "waiting" for it
  (Zoot, r35c40, 2026-11-05): `legSteps` squares of the walker's own plan (`geometry.path`, replayed on `moverStepLands` with
  declared jumps exempt, which is the bake's rule), then the pass ends and the room is looked at again. A leg the mover
  would refuse is never sent (walkTo would otherwise fall back to a collision-free plan); its waypoint is skipped for
  that lap, as is one whose walk moves nothing three times running. A hurt body goes through `leaveHold`'s gate (it
  takes or keeps a wall), and a bot or lease holding `movement` pauses the patrol, so the ordinary branch answers.

After a fight the loop resumes at the **nearest** waypoint, unless the one it was heading for is within `resumeSlack`
squares of that (so it carries on forward rather than doubling back). Survival, flee lines, fight-back, the engagement
ceiling, spare and gang-up, loot and any `practice_spells` are above or beside this and untouched. `autopilot status`
reports `patrol: { loop, waypoint, laps, arrivals, skipped, last_walk, last_engagement }`.

**Prove a loop before you assign it:** `node tools/m59-patrol-farm.mjs check --strategy <name>` (or `--room 27 --loop
r23c53 r35c58 ...`) plans every leg, replays it on the mover and reports the baked route. The Icky Cave's last leg,
r50c34 -> r23c53, was *"missing from the bake"*: the pocket round r23c53 (rows 17-34, cols 45-56) is entered only by a
running drop over the row-35 trench, r36c46 -> r34c46, which `geo.path` planned as an auto-detected fall and the bake
refused as not-a-step (`reach 1`, no route). It is now declared in `substrate/m59-falljumps.json` (proved offline with
`proveDeclaredJump`; not yet walked by a bot, so read its `jump-outcomes` rows after the first lap) and room 27 is
rebaked. `substrate/farm-strategies.example/icky-cave-patrol.mjs` is the shape.

A strategy key only (no `autopilot` argument), hot-reloaded with the file; the keeper code needs a `restart-keepers`
handoff.

### The needle (`needle`): one striker at the tip, archers behind it, a pull when it goes quiet

Operator, 2026-11-05, of 2143 Deep in the Jungle (Ko'catan): *"a single striker stands in front of the
safe-spot/choke-point and strikes at whatever monster stands in the front of the pack, regardless of if it changes ...
while the archers stand back safely and train their abilities ... the goal is it just becomes a killzone, and the
monsters on the map all wander over into your stationary farming spot. If monsters aren't coming to the kill-needle
location, the melee striker can step forward/aside, and the bower in the front can step out and shoot at an enemy
before returning to their station"*. Then: *"Idle for 15s even is enough to be worth pulling ... the melee striker is
optional but assumed -- my intuition is that the method can be close to break even at 1/(1-4) striker/archers ... but
probably can't support just lone archers without incoming money."*

```js
needle: { site: 'deep-jungle-2143', role: 'striker' },   // or role: 'archer'
```

```bash
node tools/m59-needle-farm.mjs derive --room 2143 --striker r35c42 --kill r34c43   # every candidate square, and why
node tools/m59-needle-farm.mjs check  --site deep-jungle-2143                       # a site file, proved on the map
node tools/m59-needle-farm.mjs status --site deep-jungle-2143                       # who holds the tip and each station
node tools/m59-needle-farm.mjs econ   --site deep-jungle-2143 --since 2h            # the break-even readout
```

**Why a needle works, from the server's own rules.** On a stock server (`piLOS = LOS_OLD`) monsters move on the
COARSE grid (CanMoveInRoom: the source's direction bit, the destination's floor bit) and see along a staircase of the
same steps (Room.LineOfSight, `room.kod:2125`); a monster attacks only with sight (`monster.kod:1782`). A needle is a
coarse cul-de-sac. In 2143 the kill square r34c43 steps only NE, E and SW; SW is r35c42, whose only direction is back
to r34c43. With the striker standing on r35c42 the pack stops at the tip, in its reach. Around it are squares the
player walks to on the BSP that no monster square within reach can see: an archer there is never swung at, and if it
also sees the tip (`player.kod:4096-4108`) every shot counts toward archery. This is the same "two grids disagree"
fact [the safe wall](m59-routing.md) is made of, read for a crowd instead of for one body.

**The site is data, and it is this machine's.** `substrate/needles/<site>.json` (gitignored: squares a character is
told to stand on and the order it is replaced in are orders); the shape is `substrate/needles.example/deep-jungle-2143.json`.
It names the kill square, the striker's station (and an optional `pullStep`), the archer stations best first, the
archers' `capacity` (default 4: the operator's 1 striker : 1-4 archers; 2143 holds seven by operator order: Statler, Pepe, Animal, Piggy, Clifford, Janice and Camilla as the +1), the
`pullSquare`, the `pull` clock, the bench (`reserve`), and the replacement order (`roster`). An unknown key is refused;
a key starting `_` (or `why`) is a note. `derive` ranks the squares: off the monster component, walkable from the
striker (`reachableFrom`, the router's step rule), threat 0 (no monster square within 3 has coarse sight of it), sees
the tip, then fewest monster squares within 3 at all (the robust choice if a sight bit is off). The pull square is the
safe square within 6 of the striker that sees the most of the room. 2143's choices and why are in the example file.
`check` also says, per square, whether the server's monster_grid (a `LOS_NEW_MONSTER` server) would reach it: in 2143
it reaches all of them, so **the whole site assumes the coarse grid** -- which is the only setting consistent with the
operator's observation that the pack stops at the tip.

**Roles and who holds what.** The ROLE is the assignment (`needle.role` in the strategy file, so the coordinator gives
it by giving a strategy). The SLOT is decided by the keepers among themselves: each one in the site's room publishes a
row (`substrate/.needle/<site>/<agent>.json`, one writer each, like the buddy system's) with its role, health and
fitness, and every keeper runs the same `allocate` over the fresh rows and gets the same answer:

| slot | who | does |
|---|---|---|
| striker | the first fit, fresh striker-role row: the incumbent first, then `roster.strikers`, then name | holds the striker station; swings at the closest valid monster within its weapon's reach (2, or 3 for a thrust weapon -- the site's `reach` is clamped to the weapon in hand); never leaves the square to chase |
| archer | up to `capacity` archer-role rows; incumbents keep their station, a free one fills lowest first | holds its station; shoots the closest valid monster in bow reach (ties go to one it can see) |
| puller | the archer on the lowest occupied station; with no archer, the striker only if it has a `pullStep` | as an archer, plus the pull |
| bench | every other fit striker, and archers past capacity | `reserve.mode: "hold"` stands on a reserve square; `"farm"` (the default) is ordinary farming |

**Closest wins, every swing.** `rounds: 1` (the default) re-chooses before each exchange, so a new monster stepping
to the front takes the next swing; two at the same distance keep the current one. "Valid" is passFarm's own prey list
after every filter (hunt, confinement, avoid, hunt area, gang-up, karma), plus anything able to hit us that is not
spared or karma-forbidden; never a player, so never a fleet-mate.

**The pull.** When no valid monster has been within `killRadius` (3) of the tip, nor in the striker's reach, for
`pull.idleS` (15 s), something valid is visible in the room, the puller is not being hit and is above `pull.minHealth`,
the last pull AT THIS SITE (anyone's, from the rows) is `pull.everyS` (20 s) ago and fewer than `pull.maxPer10m` (20)
happened in ten minutes: the puller walks to the pull square, takes one exchange at the valid monster nearest it, and
walks back -- one pass, bounded by the walks' step budgets. While an archer's pull is out, a striker with a `pullStep`
steps there and back. 2143 sets no `pullStep`: every square forward of r35c42 is monster ground, so the striker holds
the tip and the front archer pulls from r30c43 (threat 0, sees 122 monster squares).

**The striker is optional.** With no fit striker the needle runs **archers-only**: they hold their stations, the front
archer pulls, and the mode is said out loud as MONEY-LOSING (`needle running archers-only`, `needle.money_losing` in
status, minutes in that mode in `econ`). With no archer it runs striker-only.

**THE REPLACEMENT RULE.** A striker under `striker.minHealth` (default 0.5) publishes itself unfit and goes to the
bench; a striker whose keeper's survival ladder took the body (flee, rest, retreat, death, the Underworld) stops
publishing, and its row goes stale after `staleS` (20 s). Either way the next `allocate` gives the tip to the next
eligible melee: the incumbent rule first, then `roster.strikers`, then name. A newcomer needs `minHealth + 0.2` so a
body the ladder just let go is not handed the tip at the edge of its flee line; the incumbent needs only to stay fit,
so a healed striker coming back does not displace its replacement. This needs a second melee carrying the striker
strategy on the bench -- the coordinator gives it to two by default.

**THE ROTATION CHAIN: ARROW COURIER -> STRIKER -> ARCHER.** Operator, 2026-11-05: *"Let's have Sweetums be the
striker, so he gets first dibs on next becoming a bower as people cycle out/in (he'll replace the bower, another striker
will be selected, they become the next bower, etc.)... and we'll have the Han-lan arrow person become the next striker, as
each person rotates (that way the arrow person is what's really rotating, which leaves the group basically never without
a striker)."* The decisions are pure (`chainVacancies`, `rotateChain` in `m59-needle-farm.mjs`) and the island
coordinator executes them (`avar-village-ops.needle-draft.mjs`, config `needle.chain { striker, courier, ... }`; 2143:
Sweetums t11 strikes, Kermit t1 couriers, and every courier after him is CHOSEN, below):

| step | when | what |
|---|---|---|
| vacancy | an archer reaches `stop_at` (99), leaves the roster, or is away from the island's farm rooms (dead, logged out, locked out) for `seat_vacant_s` (300) | the seat is free |
| call-up | a free seat, a courier, and the courier not on a lap (`scratch/needle-courier-state.json`) | the courier gets the striker strategy and goes back on the roster; its keeper walks to the needle and waits on the bench (the incumbent keeps the tip). The pre-dispatched next courier takes the job -- or, if none was sent, the rule chooses one now -- or nobody (none eligible): logged with the reasons, and the courier job stops |
| handover | the called-up striker is IN the needle's room, fit for the tip (`minHealth + 0.2`), and no pull is out | the old striker gets the archer strategy and takes the free seat first; `archers.skill_by` FIRE when it knows no archery (Sweetums: fire 11, archery unknown). The tip passes at the next keeper pass |

While either step waits, the free seat is HELD for the striker (the archer queue may not fill it), up to `hold_max_s`
(2700 s, longer than a courier lap). With no courier there is no call-up, nothing is held, the archer queue fills the seat
and the striker stays at the tip. **The needle is never without a striker:** the old striker leaves the tip only after
its replacement is a fit striker-role keeper in the room, and `m59-needle-farm-test.mjs` drives 2000 random ticks of the
chain to pin it. Every step is logged with why. The courier half is `hanla-courier.needle-draft.mjs`: it serves whoever
the chain names, lives in the clearing (2144) between laps, drops its arrows on Zheng He (and any 2101 cache) where the
archers restock, and never on the guild hall chests.

**THE NEXT COURIER IS CHOSEN, AND SENT EARLY.** Operator, 2026-11-05: *"The arrow carrier should be replaced by the
highest health person who has fire but not [archery or discordance] each time, unless the bow practicer in the needle who
has the highest remaining archery skill knows discordance, in which case the next hanlan arrow carrier should be someone
who knows discordance: this should ensure someone who knows discordance is always in the room that sandstorms are cast
... The next arrow carrier should actually just head to the island when someone hits 98 archery (since they'll imminently
hit 99 archery, in the next hour or two, but it's a long walk to the island)."* `chooseNextCourier`:

- **candidates**: the fleet's `t<n>` characters only (never the service fleet `hk*`), never piloted, never anyone already
  in the needle (its striker, courier, called-up striker, pre-dispatched courier, archers), never anyone posted in the
  Barloque guild hall (room 714, or `hall_group`: the maxed-archery group t19, t18, t21, t13, t20), never `exclude`;
- **default**: the highest MAX health that knows fire and knows neither archery nor Discordance;
- **disco**: when the needle archer with the most training still ahead knows Discordance, the highest max health
  Discordance knower instead -- so a Discordance knower is always in the sandstorm room.

**"Highest remaining" is read as the most training still ahead: the largest `99 - skill`** in the skill the archer trains
(archery, or fire for an archer `skill_by` fire). That is the archer who will be at the needle longest. The other reading
-- the archer closest to 99, who leaves next -- is `top_by: 'next_out'`; this is an open question for the operator. Every
choice is logged with its reasons (`NEEDLE NEXT COURIER`), including who was refused and why when nobody qualifies.

**PRE-DISPATCH.** When any needle archer reaches `pre_dispatch_at` (98) in the skill it trains, the next courier is chosen
then and walked to `stage_room` (2144, the clearing beside the needle, where the courier lives; NO_COMBAT for monsters) so
it is on the island before the seat frees. It is kept out of the archer queue and the candidate pool meanwhile, and the
call-up hands it the courier job.

**DISCO DUTY.** Operator: *"Ideally one person in each group has 'Discordance' and can be on 'disco duty' to keep the
sandstorms down, the sandstorms can be a serious problem for this strategy."* The site's `disco.agents` (2143: Camilla,
t9, the seventh archer) are its Discordance casters. While a Sandstorm is on the room (the keeper's own room-enchantment
observations), such an archer stops shooting -- a sandstorm ruins shots anyway (`player.kod` WindsRuinShot) -- and stands
by while the island coordinator casts Discordance through it (the dispel module, `cast_all`: every knower in the room
casts, each cast freezing that keeper for the trance). Its row says `away: 'disco'` with a `hold_until` (`disco.holdS`,
120 s), so the seconds its frozen keeper publishes nothing do not free its seat, and the front-archer pull passes to the
next archer meanwhile. `disco.castSquare` null (2143) casts from the station -- threat 0, the casting safety standard's
best case; set it to make the caster step out and back. The storm lifted, it shoots again from the same seat. A needle
with no configured caster present is `disco_missing`, and both the keepers (`NEEDLE HAS NO DISCORDANCE CASTER`) and the
coordinator (by spell knowledge, every 5 minutes) say so loudly. Disco duty is a property of the NEEDLE SITE only
(operator: "No other places will have sandstorms"); nothing else in this repository gains Discordance logic. The island
coordinator's own dispel module is unchanged.

**THE MENDER.** Operator, 2026-11-05: *"let's have the discord caster for the archery needle group also provide mending
services for bows, so they'll need to carry extra orc teeth and sapphires, give them 30 of each.. and let's actually have
the hanlan arrow courier be the guild hall version *optionally, as-needed* so it can bring those orc teeth and sapphires
with it to keep the mending desk supplied as well as the arrows"*. Mend (Kraanan 4: 9 mana, 1 sapphire + 1 orc tooth,
`mend.kod:55-56`) reaches an item in the caster's pack OR ON THE FLOOR OF ITS ROOM (`mend.kod` IsTargetInRange: the
target's owner is the caster's owner), so nobody walks:

- the site's `mend` block: `agents` null = the disco-duty archers that know Mend; `at` = the bow band to mend at
  (`med`, read by look with `m59-practicebow.mjs` bowBand every `checkS`; mend late, `mend.kod:112-134`); `stock` =
  30 orc teeth + 30 sapphires USABLE on top of the mender's PvP floor;
- an archer whose bow reads `med` or worse, with nothing in reach, unwields it and drops it ON ITS OWN STATION (threat 0),
  says `mend_req` in its row (its seat held, not the puller), and waits up to `waitS`; the mender (`alloc.mender`: the
  front-most archer whose row says `mend_ready`) casts Mend on it from its own station and says `mended`; the archer picks
  the bow back up. The mender mends its own bow in its pack. Each is a `needle_mend` / `needle_mended` ledger row;
- `mend_ready` is honest: knows Mend, a sapphire and an orc tooth usable above the PvP floor, and the reserve would not
  veto the cast. **The PvP floor is always named** (`needle.mend.pvp_floor` in status): the reserve book's
  casts-to-keep turned into reagents. An "everything" item sentinel (`sapphire: 100000`, the PvP-and-Discordance lock) is
  not a floor; what lets Mend past it is `agents.<a>.exempt: ['mend']`, which the coordinator draft moves to whoever holds
  the mender role and takes from whoever it gave it to (`mendExemptPlan`; it never touches an exemption it did not add);
- the stock comes from the courier: each round `chooseCourierLap` decides HALL or HANLA by need -- the mender's need
  (from its row) is always a hall lap to 713 (`hall_withdraw`, with whatever arrows the hall can spare above its floor;
  the reagents handed to the mender directly), and arrows the hall cannot spare are a Hanla lap. The hall's plain-arrow
  floor is an open question for the operator (`HALL_FLOOR` in the courier draft).

**LIVE, 2026-11-06: TWO THINGS TOOK THE NEEDLE'S PASSES, AND BOTH ARE CLOSED.** Within twenty minutes of going live in 2143
the operator saw archers off their stations, on the monsters' side, being hit. The keepers' own presence rows and status
said the needle WAS running (`needle.last` was null only because it was written by the pull path alone; it now records
every decision: `walk`, `stand_in`, `fight`, `wait`, `pull`, `bench`). What took the passes:

- **A refused station walk handed the pass to ordinary farming.** Walks to the stations beside the tip come back
  `object_blocked` while bodies crowd it, and every third refusal returned null, so passFarm's ordinary branch ran: it took
  "walls" at r32c46 and r34c45, approached quarry, and joined cooperative distractions -- on monster ground. Now a refused
  walk marks that square blocked for 30 s and the pass stays the needle's: `standInFor` puts the body on the station if it
  is free, else on the nearest free square of the role's SAFE SET (`safeSquaresFor`: an archer's stations, the pull square
  and the bench; a striker's station and the bench), and an archer on any of them shoots from there. A square a body stands
  on is not walked to. Nothing in the needle's room falls back to ordinary farming for a walk.
- **The cooperative combat strategy vetoed the needle's swings.** `CooperativeCombat.ordinary()` counted needle keepers as
  ordinary farmers, so its attack veto (`cooperativeAttackVeto`, consulted by `client.attack`) refused every swing at a
  monster other than its own choice -- "broke off, landed 0" pass after pass -- and its passive hold took whole passes before
  passFarm. A keeper with a needle in its room is now out of cooperative combat, like a buddy farmer.

- **Two of the seven stations and the pull square could only be walked to ACROSS MONSTER GROUND.** The derivation had
  asked "can the mover reach it from the striker's square", and in 2143 every shortest walk from the pocket to the east
  stations ran through the tip and the kill square; r32c43 and the old pull square r30c43 had no other way at all. Now
  `deriveNeedle` seeds the bench and keeps only squares reachable from it without stepping on the monster component
  (`reachAvoiding`, `safe_route`; `unsafe_route` lists the rest), `checkSite` fails a station, the pull square, the bench
  or a yield square that has no safe route unless the site names it in `archers.acceptUnsafeRoute` (a compromise, said in
  the check), and every needle walk passes the monster component, the tip excepted, as `avoidSquares`. In 2143 only SIX
  sighted stations have a safe route, and they form a ONE-WIDE CORRIDOR (bench -> r34c40 -> r34c41 -> r34c42 -> r35c43 ->
  r35c44 -> r34c45, r33c43 off r34c42): the example orders them FAR END FIRST so each arrival passes empty squares, and the
  front archer pulls from its own seat, r34c45, which sees 90 monster squares. The operator's seventh seat is r32c43,
  accepted by name: threat 0, sees the tip, and every walk to it crosses r34c43/r33c44.

**THE STRIKER ALWAYS MAKES SPACE.** Operator, 2026-11-06: *"the striker should step back/aside (toward the archers, away
from monsters) if/when the courier try to walk past, because they don't want to be blocking the thin part of the needle
and start a forever traffic jam that stops their own archers from resupplying"*, and then *"It should just always make
space, they dont actually block the needle from monsters, only from players (the monsters are blocked by the map
itself)"*. So there is NO exception for a monster at the kill square: the tip is a coarse-grid dead end, and the geometry,
not the striker's body, stops the pack. `yieldDecision`:

- a PASSER is a fleet-mate (`party.isFleetmate`: the roster and the menagerie) within `striker.passRadius` (3) of the tip
  that is in transit -- not standing on one of the site's safe squares -- or a needle keeper whose row says `passing`
  (written by `needleWalk` before it walks, with its target). A body that has not moved for 30 s is PARKED, not passing,
  or one idling beside the tip would keep the striker off it for ever;
- the striker steps to the first of `striker.yieldSquares` (derived: safe squares one mover step off the tip and back,
  not stations, farthest from monster ground first -- 2143: r36c41, r35c41) that is free and not on a passer's planned
  way, stays while anyone is passing, at most `striker.yieldMaxS` (20 s) at a time, then goes back, and yields again
  after a 3 s cooldown if somebody still is. It swings from a yield square if something comes into reach (threat 0);
- `needle.yield` in status says who it made space for and why. The no-deadlock test walks two bodies through the
  one-wide part in opposite directions with the striker in the middle, and both get through.

**LIVE, 2026-11-06 EVENING (deploy-2026-11-06-3), four more, and the site's premise.**

- **Cooperative LOGOFF still took needle keepers.** Camilla went NOT IN GAME twice ("rejoin: cooperative logoff: wait for
  distraction"). The fix above took needle keepers out of cooperative COMBAT only. Now `fleetLogoff` refuses while the
  keeper holds a needle in its room, `cooperativeHelperReady` is false for one, and its cooperative presence publishes
  `enabled: false`, so nobody counts it as a helper either.
- **A monster stood on the tip and the striker waited beside it.** t11 at r36c41 read "r35c42 is occupied" for minutes:
  an avar warrior (id 12966) stood on r35c42, with others on r34c43, r33c44, r34c44 (t11's own room view). On the coarse
  grid r35c42 IS monster ground -- r34c43 steps SW onto it -- so the body on the tip holds it, and a striker that steps off
  has to win it back. A striker on any square of its safe set now fights what is in reach, and when the tip is taken it
  stands in beside it (yield squares before the bench), kills what is there, and takes the tip.
- **The coordinator re-seeded the chain every tick.** `rotateChain` rebuilt the chain without the coordinator's `seed`,
  so every 15 s it read as un-seeded (140 "NEEDLE CHAIN seeded" lines). It now keeps every field it does not own.
- **"NEEDLE HAS NO DISCORDANCE CASTER" with Camilla there.** Her keeper was in game with `spells: []`: after a rejoin the
  spell list arrives only when asked. `needleKnows` now asks the server for it (at most once a minute) and believes the
  ability book (`substrate/abilities/<character>.json`) meanwhile; the coordinator draft's readFarmer does the same.

**THE SITE'S PREMISE IS IN DOUBT, AND THE OPERATOR'S SQUARES WIN.** Operator: *"The needle positions are wrong. The correct
needle should have nobody east of r36,c40 -- r36,c40 is the striker position for the needle"*. Why the derivation said
otherwise: it never chose r35c42 / r34c43 -- those were the operator's first squares, and `derive` only proved them -- and
it models monsters on the COARSE grid (a stock server, `piLOS = LOS_OLD`). There, the monster component reaches r35c42
and stops; nothing in the pocket west of it (r36c40 included) is monster ground at all, so r36c40 cannot be a coarse dead
end. On the `monster_grid` (a LOS_NEW_MONSTER server; `derive --grid fine`) the component covers the pocket too, and r36c40
can be entered from r36c41, r35c41, r37c41, r35c40 and r36c39 -- not a dead end either. Neither 2D grid reproduces "the
striker at r36c40, nobody east of c40"; the live room view (the pack on r34c43, r35c42, r33c44, r34c44, all coarse squares)
fits the coarse grid, while archers on "threat 0" squares east of c40 losing health fits it less well (or was spell
damage: shamans cast with no sight check). The server is two-dimensional (`CanMoveInRoomFine` takes no z), so sector
heights are not the answer. What settles it is observation: where the avars stand, and which squares take melee hits.

So a site may say `"trust": "operator"`: its squares are the operator's, taken VERBATIM. `checkSite` still reports what
the model thinks of each square, as WARN lines and `warnings`, and passes; and needle walks do not route around the
model's monster ground, since the model is what is in doubt. `derive --grid coarse|fine` shows either model.

**THE 2143 SITE IS NOW THE OPERATOR'S** (2026-11-06): *"Striker r36c40. Kill square r35c41: the monster stops there, NE of the
striker. Archers, in fill order: r37,c40 , r38,c38 , r40,c36, r41,c36 , r42,c36 , r43,c36 and anywhere in between it's
basically just 'line up along the wall that has line of sight to r36,c41 area'"*. The example (`trust: "operator"`) has
those six in that order, then the wall squares between them (r39c37, r38c39), capacity 7; the bench south along the same
wall (r44c36, r44c37, r45c37, r46c37); the striker's yield squares west and south-west of it (r36c39, r37c39); the
front archer pulling from r27c37 -- OPEN GROUND toward the generator round r23c32 (operator: "they might have to step out
into the open to pull from that area"): 13 steps from r37c40, and the nearest square that sees that area at all -- after the
15 s idle trigger, with a 45 s excursion and an 80% health floor. Nothing is east of c40. Every square is walkable, BSP-standable and reachable. The model's
staircase line of sight says only r37c40 sees r35c41 (and only on the monster_grid), and `check` says so as warnings --
the operator's squares stand. The first site (striker r35c42, kill r34c43) is retired.

**LIVE, 2026-11-07 (deploy-2026-11-07).** Archers on their stations never shot ("nothing valid within 2"): the keeper took
the reach from the FIRST equipped item in the pack, armour as often as not, and armour reaches like a fist. `needleWielded`
now reads the keeper's equipment list and picks the bow (then anything the weapon ranking scores), so an archer shoots at
the site's bow range (17) and a striker swings at its sword's. Line of sight stays a tie-break, not a gate, because the
model's line of sight disagrees with the operator's wall. "No Discordance caster" is now said only after five minutes
without one (the keepers; the coordinator draft counts the needle's members wherever they are and waits the same five
minutes for one who is away). Status says why a keeper has no slot (`in_needle_room`, `why_no_slot`): a slot exists only
in the needle's room, and a recalled archer in 2101 is "not there yet".

Not changed, and reported: the striker left the room through the survival ladder's caster exit ("a caster is in the room:
no spot here holds") -- avar shamans cast without a range or sight check (monster.kod MonsterCanCastSpell), so no square in
2143 is safe from a spell, and archers resting on a station can still take spell damage. That is survival, and it is the
keeper's.

**Survival is the keeper's, unchanged** ([the boundary](m59-boundary.md)). The needle runs inside passFarm, below
passFleeAndRest and the fight-back rungs; every exchange is `fight()` held to the square with the keeper's own flee
line as `disengageAt`; a striker that breaks off retreats through `retreatToSafety`, the call passFarm makes; an
archer that breaks off rests on its square (nothing can swing at it). The schema refuses a `needle` with any key but
`site` and `role`, and the site file refuses unknown keys, so no survival or war key can ride in on it.
`m59-unattended-test.mjs` stays green.

**Archers restock the normal way.** No bow, fewer than `archers.minArrows`, or hurt: the archer is unfit and the
needle hands the pass back to ordinary farming -- which is where the island coordinator's sticky archers and resupply,
the town trip and the couriers answer (arrows at the trading post 2101, Zheng He in 2144). Restocked and back in 2143,
the keeper walks to its station by itself. Archery practice is the fight itself: the archer strategy bans every melee
weapon (a swing zeroes the 75-attempt block) and the needle passes the same training gate passFarm does.

**Why a farm strategy field, not a keeper faculty or a coordinator mode.** The four protected faculties are the
keeper's and the needle takes none of them; what it decides -- where to stand, what to swing at, when to fetch -- is
`work` and movement on the farm clock, which is exactly what a strategy file carries, assigned to one character by
name, yielded to a lease, hot-reloaded. A coordinator mode could not do the per-swing part at all: the island
coordinator ticks every 15 s and drives through the broker, and "the closest monster, switching when another is
closer" has to be decided on the keeper's one-second clock from its own room view. So the coordinator decides WHO
(by giving a strategy), the keepers decide WHERE and WHAT (by `allocate` and `chooseTarget`), and survival stays above
both. It is wired like `patrol`: one field (`m59-strategy-schema.mjs`), one seam in passFarm after every filter and
before the ranking (`needlePass` owns the pass or returns null), status as `needle`. Silence -- no `needle`, another
room, a movement lease, a bench that farms, an archer out of arrows -- is the farm pass that was there before.

**The break-even readout** (`econ`). Never a count without its denominator: every rate is per 30 minutes OF DUTY in
that role, and duty minutes come from the keepers' own `needle_duty` ledger rows (every `econ.tickMin`, 5 minutes;
gaps over two minutes between needle passes are not duty). Kills are the `killed` rows the needle tagged
`needle: { site, role }` -- the same rows every kills/30m counts. Shots are attempts (each spends an arrow); income is
the shillings in those kills' loot; arrows bought are the keepers' own `bought` rows for arrows. `--arrow-price N`
values the shots; without it the cost is null, not zero. Sold loot is not valued, and arrows a courier bought on an
archer's behalf are not keeper rows -- both said in the report. Every pull is a `needle_pull` row.

**Deploying it.** The keeper code needs a `restart-keepers` handoff; the strategy field needs nothing from the broker
(no `autopilot` argument). On prod, the island coordinator gives the roles: `avar-village-ops.needle-draft.mjs` (beside
the live file, for review) adds a `needle` module -- the first `needle.strikers` melee (default 2) get the striker
strategy, the rationed archers get the needle's archer strategy, and `needle.archers` (`max`, `prefer`) replaces
`archers.max` and `archers.prefer` and takes the preferred names out of `archers.exclude` -- for 2143, seven archers. `m59-needle-farm-test.mjs` (66) pins it.

### The Icky Cave: the strategy holds the room, an errand takes the chalice

`icky-cave-orc-clear` (example) only REPORTS when room 27 is held. Taking the chalice is a sequence,
so it is a FleetScript: `substrate/fleetscripts.example/icky-chalice.mjs` puts the clearers on this
strategy (and then hands their lease back, since the file yields to whoever holds `work`), fetches one
cast of dispel illusion reagents for the caster from the guild chests or the Barloque vault when the
pack lacks them, waits for the hold, casts, and takes the chalice inside cave2's 30-second window.
The kod it rests on is in its header; `m59-icky-chalice-test.mjs` pins it.

## What the body needs, the kill-rate floor, and the escalation

Operator, 2026-10-26, of a troll crew that ground Ukgoth for six hours with weapons that could not hurt a troll: that
*"should be at-worst a bounce-back of 'cannot be assigned without a way to get weapons dedicated'"*; and then *"I don't
want stoppage as a reaction except if there's no desk-solution available, and for those cases we'd want a
gutter/catchall orders"*. `tools/m59-strategy-gate.mjs` and the gate in `m59-strategy-engine.mjs`;
`m59-strategy-gate-test.mjs` (58) pins it.

```js
requires:  { magicWeapon: true },       // and/or items: ['purple mushroom']; request: { service: 'dedicate' } | null
floor:     { kills: 4, minutes: 30 },   // at least 4 kills in every 30 minutes of farming
otherwise: 'cragged-spiders',           // the catch-all: another farm strategy, served when no desk can fix it
```

**At assignment** the broker refuses a strategy whose `requires` this body does not meet, naming the weapons it found,
unless the call says `accept: ["requires_unmet"]`. Unknown (weapons not read since the keeper started) is allowed, and
the reply says so as `farm_strategy_requires`.

**After that, a farm that is not working escalates. It does not just stop:**

| stage | entered when | what the character does |
|---|---|---|
| `diagnosing` | the floor trips | keeps farming; every weapon is read afresh (a lapsed dedication is the likeliest cause, and an old reading hides it), for up to 3 minutes |
| `awaiting_desk` | the cause has a desk remedy: a missing magic weapon (`dedicate`, or the file's `requires.request`), a weapon that will not come off (`uncurse`) | posts the request to the service board and **keeps farming**, the floor clock paused, until the cause clears (escalation over) or the request's ttl (15 min) runs out |
| `fallback` | no desk remedy (the room, or no cause found), or the desk did not answer | serves the file's `otherwise` strategy, else this machine's `substrate/farm-strategy-otherwise.json` (`{ "strategy": "<name>" }`, gitignored). The assignment is unchanged; it comes back by itself when a requirement that caused this is met |
| `stood_down` | there is no fallback, the fallback will not load, or the fallback trips its own floor | chooses no quarry. The only stop, and it says which of those it was |

Survival is never on the ladder: passFarm checks the gate below the meal, so a body that stands down still eats, and
fleeing, resting, fighting back and the Underworld are decided above it. The board line names a fallback or a stand
down; status has `farm_strategy.gate: { blocked, serving, escalation, requires, floor, request }` and
`farm_strategy.serving` while a fallback is in force.

**The floor's clock** advances only on passes that reached the hunt. A gap of more than two minutes between two such
passes (resting, travelling, a lockdown in an inn, a held body) is not counted. A kill is any counted kill (the same
moment `onKill` fires, with or without a hook).

**It survives a handoff, and "try again" is explicit.** The floor and the escalation are saved per character in
`substrate/.strategy-floor/`, keyed by the strategy and its file's mtime, so a keeper restart neither forgives a trip
nor restarts the clock, and a fallback stays in force. An explicit assignment (the broker) clears them; so does editing
the assigned file.

**All of it is silent unless declared**, and off while a bot or lease holds `work` (the file is not in force). A
fallback names no fallback of its own: it either works or stands down. Set a floor the quarry can honestly meet: a
mundane-armed troll crew may still land the odd kill, so one per 30 minutes would not catch it.

## Private strategy directories

A strategy file is an order, so it is this machine's — and some orders belong in a PRIVATE repository
rather than in this machine's gitignored `substrate/farm-strategies/`. The engine searches, in order:

1. `substrate/farm-strategies/` (or `M59_FARM_STRATEGY_DIR`) — this machine's own;
2. every directory in `M59_FARM_STRATEGY_PATH` (platform delimiter, `;` on Windows);
3. every directory listed in `substrate/farm-strategy-dirs.json` — `{ "dirs": ["C:/code/m59-private/strategy/farm-strategies"] }` (gitignored).

The FIRST directory holding `<name>.mjs` wins, so a local file of the same name OVERRIDES the private
one. The dirs file is re-read on every lookup (no keeper restart to add a directory); a directory that does
not exist is skipped. `node tools/m59-strategy-engine.mjs` lists every directory searched. Assignment,
hot reload, yielding and the residue rules are unchanged: only where the file is found has moved.

## The buddy system (`buddy`)

Operator, 2026-10-09 — the "Qor buddy system": a karma-locked disciple gains max health from monsters
somebody else kills. `tools/m59-buddy.mjs` has the kod for each clause; in short, `SomethingKilled`
reaches everyone in the room, a non-killer whose LAST target was the victim and who did DAMAGE to it gets
the advancement roll (only when the monster's level is above its base max health), attacking anything
else resets it, and karma moves only for the killer.

```js
buddy: { pairs: { t5: 't4', t6: 't10' }, wait_s: 120, tries: 3, reach: 2, quarry: ['skeleton'] }
```

One value for every member; each keeper finds its own role (`pairs` maps TAGGER -> KILLER, exclusive).
`Autopilot.passBuddy` (pass stage directly above `passFarm`, inert unless the slot is named):

- **tagger** — takes a corner (`takeSafeSpot`), waits until its killer's record shows it within `reach`+1 of
  that wall, `pull()`s the nearest UNTOUCHED quarry (no player within two squares — creature health is not
  on the wire), and then swings at nothing else: the session's `attackVeto` refuses every other id while a
  tag is out, and the tag itself once a landed blow has been read from the combat log. An unlanded tag that
  follows it in is swung at again, up to `tries` (default 12, at most 20). The tag leaving the room ends the wait; `wait_s` gives up.
- **killer** — walks beside its tagger's wall, kills the tag once it has landed (or after 20s), and clears
  anything else at the wall. With its tagger not in the room it farms as usual.

Survival is untouched: the stage is below `passFleeAndRest` and the veto refuses only attack packets.
The two keepers share `substrate/.buddy/<slot>.json` (one writer each; `M59_BUDDY_DIR`) because the party
register in `m59-party.mjs` is per process and every prod keeper is its own process.

## Hot reload

Every converge stats the file. A changed mtime is re-imported under a fresh URL (`?v=<mtime>`, which
is what defeats Node's module cache), validated, and applied on the same pass — no keeper restart.
Keys a new version dropped go back to what they shadowed; hook state and `memory` reset. A broken
version is refused once per mtime, not on every pass. A re-push of `farm_strategy` with the same
name also converges at once.

## Not covered

- The **tick driver** (`mode: 'tick'`) is not an Autopilot pass and does not apply a strategy.
- A strategy does not change `mode`; pass `mode: "farm"` with the assignment.
- Two characters may share a file; each keeper applies it to itself.

## Fleet-wide cooperative combat

The private strategy loader also has an additional `cooperativeCombat` hook. It
can coordinate nearby farmers without replacing individual farming assignments.
See [the hook contract and evidence](m59-cooperative-combat.md).
