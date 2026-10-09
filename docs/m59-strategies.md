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
| `protect` | `protectedItems` | economy | items resolved; **added to** the existing list, never replacing it |
| `overfarm` | `overfarm` | economy | `normalizeOverfarm`, unknown keys refused |
| `weapons.touchSpell` | `touchSpell` | work | `touchSpellName` |
| `weapons.touchSpellTiming` | `touchSpellTiming` | work | `touchCastTiming` |
| `weapons.priority` | `weaponPriority` | work | list of names |
| `weapons.banned` | `bannedWeapons` | work | list of names, lower-cased |
| `weapons.style` | `trainingStyle` | work | the five training styles |
| `weapons.preferMagic` | `preferMagicWeapon` | work | boolean |
| `confine.rooms` | `confineRooms` | movement | room numbers |
| `confine.station` | `assignedRoom` | movement | a room number |
| `confine.roam` | `roam` | movement | boolean |
| `vigor.fightAbove` | `fightAboveVigor`, `vigorFloor` | work | 0..200, as `applyFightAboveVigor` |
| `practice` | `practiceSpells` | work | `normalizePractice`, problems refused |

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

### The Icky Cave: the strategy holds the room, an errand takes the chalice

`icky-cave-orc-clear` (example) only REPORTS when room 27 is held. Taking the chalice is a sequence,
so it is a FleetScript: `substrate/fleetscripts.example/icky-chalice.mjs` puts the clearers on this
strategy (and then hands their lease back, since the file yields to whoever holds `work`), fetches one
cast of dispel illusion reagents for the caster from the guild chests or the Barloque vault when the
pack lacks them, waits for the hold, casts, and takes the chalice inside cave2's 30-second window.
The kod it rests on is in its header; `m59-icky-chalice-test.mjs` pins it.

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
  follows it in is swung at again, up to `tries`. The tag leaving the room ends the wait; `wait_s` gives up.
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
