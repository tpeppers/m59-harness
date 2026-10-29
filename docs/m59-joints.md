# Joints, paks, postures and operations

The keeper's behaviour, made replaceable at named places, in this game's own terms. Split out of
[`CLAUDE.md`](../CLAUDE.md). The code is [`tools/m59-joints.mjs`](../tools/m59-joints.mjs) (the joint catalogue,
the pak host, the condition language, the dry run), [`tools/rpg/`](../tools/rpg/index.mjs) (the vocabulary),
[`tools/m59-posture.mjs`](../tools/m59-posture.mjs) and [`tools/m59-operation.mjs`](../tools/m59-operation.mjs).
The guard is `node tools/m59-joints-test.mjs` (143, offline).

```bash
node tools/m59-joints.mjs joints                  # every joint: where it is asked, its facts, its answers
node tools/m59-joints.mjs dry <pak>               # a pak's scenarios: every rule considered, which fired, the answer
node tools/m59-joints.mjs dry <pak> --joint movement.hazard --facts now.json   # your situation instead
node tools/m59-posture.mjs show lockdown-cv --fleet prod                       # what a lockdown would change (reads only)
node tools/m59-operation.mjs dry substrate/operations.example/example-door-ambush.json
```

## What the operator asked for (2026-10-25)

Behaviours *"modularly replaceable for the major components (e.g., so people can override w/their own mover,
their own router ... each PVP behavior being broken out)"*, *"not all in a single file"*, organised along the
joints the problem already has in RPG terms, so that *"precise and specific orders that cover most edge-cases"*
stay *"human-reviewable, understandable"*. Five cases to check the design against, each solved as its own file.
And: *"the behaviors of the base harness shouldn't change"*.

## The keeper is in parts now

`m59-autopilot.mjs` was one class of 31,000 lines. Its methods live, verbatim, in 45 files under
[`tools/autopilot/`](../tools/autopilot/parts.mjs) named for the faculty they serve (`travel.mjs`,
`pass-farm.mjs`, `chalice.mjs`, `pass-survival.mjs`, `wedge.mjs` ...), installed onto `Autopilot.prototype` by
`installParts` right after the class. `this` is the keeper exactly as before; the core keeps the constructor, the
lifecycle and the pass loop. Two rules come with it:

- **No name twice.** `installParts` refuses a method defined by two parts, which `m59-shadowed-method-test.mjs`
  could only check inside one file.
- **Tests read the whole keeper.** A test that reads tools as text calls `readToolSource` (`autopilot/source.mjs`),
  which splices the parts back in at their `// @autopilot-part` markers. A slice between any two methods means
  what it meant before. `m59-epoch.mjs` counts `tools/autopilot` as movement code, and a FleetScript pin that
  touches the keeper sees its parts.

A part is where the keeper's own code for a faculty is written down. **It is not a plug-in.** To replace
a behaviour, use a joint.

## Joints

A joint is a moment the keeper already has, with a **name**, **frozen facts** and a **closed set of answers**.
The keeper asks. With nothing loaded, the answer is null and the keeper does what it always did. That sentence
is the compatibility promise, and the test's first section pins it per joint.

| joint | asked at | answers |
|---|---|---|
| `movement.hazard` | `Session.groundEffectBlock` (every step); `safeCombatStep` (combat approach paths) | `cross` the effect, `avoid` it, default |
| `combat.blocked` | `CombatMode.approachCombat`, when a fight has no safe approach square | `ranged` (hold the approach; the volley and casts fire from here), `withdraw` (the keeper's own flight to a room out), `hold`, default |
| `threat.classify` | `CombatMode.observeCreature`: a creature hits us, speaks, or shows player marks; a nameless player's blow | `treat_as_player` (mark the object; fight it as a player; raise the alarm with its id) |
| `combat.outcome` | `CombatMode.observeOutcome`: our blow read back (band, element, "laughs off") | `adjust` a channel's weight for a while |
| `combat.channel` | `CombatMode.wandVolley`, before the volley picks a wand | `skip` channels this beat; `prefer` one |
| `upkeep.curse` | `Autopilot.jointCurseUpkeep`, at most once a minute from the pass | `request` a service on ourselves |

What no answer can do:

- No answer turns safety off.
- No answer speaks.
- No answer takes a protected faculty by stealth. `cross` still goes through the mover's collision checks.
  `withdraw` is the keeper's own flight. `treat_as_player` still passes `pvp_rooms`, the room flags,
  refused targets and the server's own safety.
- **A combat step never ends on a fire square**, whatever a pak says. Crossing is about the path, not about where
  the body stops.

Any answer may carry `also: [{ do: 'request', service, target }, { do: 'note', text }]`. These follow-ups are
performed by the host, never by the pak. **Every answer is recorded twice**: a `joint_decision` line in the
keeper's combat log, and a row in `substrate/pvp/<fleet>/decisions-<day>.jsonl` beside the shots and actions.
Each row carries the facts summary, the pak, the rule that fired, and any `ctx.branch(name, data)` the pak
recorded at its own decision points. A fight replay can then show *why* a body did something, as well as where it
was.

## Paks

A pak is one file of behaviour, shareable on its own:

```js
export default {
  name: 'firewall-doctrine', about: '...', options: { cross_min_health_pct: 45 },
  joints: {
    'movement.hazard': [
      { name: 'resistant: one tick is affordable',
        when: { all: [['hazard.resist_pct', '>', 0], ['self.health_pct', '>=', '$options.cross_min_health_pct']] },
        then: { do: 'cross', why: '...' } },
    ],
  },
  scenarios: { 'healthy, bare, at a firewall': { joint: 'movement.hazard', facts: {...}, expect: { do: 'cross' } } },
};
```

- **Rules.** A handler is a function, or a list of rules tried in order; first match wins, and a rule answering
  null lets the next one try. That is the Baldur's Gate AI-script shape, `IF trigger THEN RESPONSE`.
- **Conditions are data.** `[path, op, value]`, `{all}`, `{any}`, `{not}`, with `$options.x` and `$memory.x`, or
  a function where code is genuinely needed. Because they are data, the dry run can say which clause failed.
- **Scenarios are the pak's own tests.** `dry` runs them through the keeper's exact validator.
- **Where paks live.** `substrate/paks/<name>.mjs`, then `M59_PAK_PATH`, then `substrate/pak-dirs.json`.
- **Assignment.** `substrate/paks-<fleet>.json`:
  `{ "enabled": [...], "agents": { "t9": { "disable": [...] } }, "characters": { "Alpha": { "enable": [...] } } }`.
  Order is precedence. A menagerie host loads none.
- **Rules carried over from the PvP strategy host.** Hot reload every 2 s. A pak that throws, returns a promise, or
  takes over 25 ms gets a strike; three strikes stand it down until its file changes.
- **Paks are orders, so they are this machine's.** The shape is
  [`substrate/paks.example/`](../substrate/paks.example/example-hazard-crossing.mjs).

The existing hook systems are unchanged by this: travel strategies, farm strategies, PvP strategies, cast rites,
playbooks. Joints are the place new behaviour goes. Moving an old hook onto a joint is a separate change, made
when that hook is next touched.

## The RPG vocabulary (`tools/rpg/`)

Each module answers in the game's own terms and cites the kod it rests on.

- **`sheet.mjs`**
  - Buffs and debuffs come from the kod spell catalogue's `harmful` flag, never a hand list.
  - Resistances count live enchantments and *worn* rings. A ring in the pack resists nothing.
  - **A curse is not a debuff.** It is an item worn that will not come off. `curse.state` is
    `cursed` / `suspected` / `none_known` / `unknown`, with its evidence (cursed grade, cursed name, the cling
    line, the pickup line).
  - The cure is `remove curse` cast **on the player**. It unequips every cursed item worn; the item stays
    cursed and clings again if re-worn.
- **`timers.mjs`**
  - There is one shared attack timer (`ptAttackTimer`).
  - Melee and bows are 1 s. Spells use `viPostCast_time`. Spell-wands use their spell's time (lightning wand 2 s).
  - **The wands of fire, healing and vampiric shock have no timer at all.** A heal wand can be used between
    swings without moving the next swing.
- **`channels.mjs`** — every way to attack right now: `melee`, `bow`, `wand:<name>`, `spell:<name>`, each with
  its timer and element.
- **`damage.mjs`** — our blow read back: the verb band (shock jolts / shocks / fries / electrocutes), and
  "laughs off" (resist over 60%) or "shrugs off" (over 20%).
- **`hazards.mjs`**
  - A wall of fire does **not** block. It hits on entry and every ~1.5 s for 0–16, resisted, never below 1.
  - One square crossed is one hit.
- **`suspicion.mjs`**
  - Morph strips `OF_PLAYER`, but keeps the murderer and outlaw marks.
  - A morphed player that speaks uses its own say format.
  - The room's spawn table says what can be there.
  - Anonymity is a player with a blank name.
- **`doors.mjs`** — every exit between two rooms, grouped by landing square, with posts around each. Posts are
  never on the landing square and never on an exit.
- **`requests.mjs`**
  - The fleet's service board: `substrate/requests-<fleet>.jsonl`.
  - A pak asks; a desk serves.
  - Asking twice refreshes rather than duplicates. A claim lapses after a minute.

## Postures: the lockdown, and the undo that used to fail

```bash
node tools/m59-posture.mjs apply   lockdown-cv --fleet prod --why "enemy online"
node tools/m59-posture.mjs release lockdown-cv --fleet prod
node tools/m59-posture.mjs status  --fleet prod
node tools/m59-posture.mjs apply   lockdown-cv --fleet prod --for 2h     # a lease: comes off by itself
node tools/m59-posture.mjs tend    --fleet prod [--watch]            # re-read, re-push drift, expire leases
```

The commonest reactive order of October 2026 was a lockdown: about ten incidents and four different hand-rolled
scripts. Its undo was the commonest silent failure:

- a stand-down that restored every mode as null;
- one that hard-coded what it "restored" (`pvp_rooms: [38]`);
- a two-hour return delay accepted by all 24 characters and dropped by every keeper.

So a posture is a set of orders with these rules:

- **The save is written before anything is pushed.** It holds exactly the keys the posture changes, as each keeper
  reported them.
- **A second `apply` never overwrites the save.** It would record the lockdown as the thing to go back to.
- **Every key is read back, on apply and on release.** A key that did not take is a named failure and exit 1.
- **A key the keeper did not report before is not "restored" as null** (the broker may coerce it). It is named.
- **A release that half-worked keeps the save active.**
- **`pause_jobs: true` pauses the job board** before the orders go, and release resumes only what it paused.
- **Never touched:** menagerie hosts and piloted characters.
- **An active posture is tended, not trusted.** A keeper handoff resets a character to its roster orders, and a key
  pushed to a keeper is lost with it (prod, 2026-10-26). `tend` re-reads every unit of every posture that is on,
  re-pushes drift and records it by key on the save. The tripwire watcher tends once a minute; `tend --watch` runs it
  alone.
- **A temporary stand-down is a lease.** `apply --for 2h` writes `expires_at`, and `tend` releases it when it runs out.
  A forgotten release cannot leave survival off for ever, which is what happened to `second-wind-drill`'s restore.
- **A hazardous order has to be accepted by name** (`ORDER_HAZARDS`): `survival_off` (stops all ordinary keeper work,
  practice included, silently), `no_flee`, `travel_unguarded`. Without `--accept <id>` nothing is pushed and the error
  names the flag. A tripwire accepts in its `then: { posture, accept: [...] }`.

### A lockdown accepts ANY no-combat room (`lock_no_combat`)

The default shape of a lockdown since 2026-10-29 (operator: *"keep any characters in whatever rooms I leave them in ...
as long as it's a no combat room ... any no combat room is acceptable"*). The keeper policy `lock_no_combat: true`
makes the lock room **whatever NO_COMBAT room the character stands in** (every inn, shop, bank and hall; the room's
own flag, `m59-hazards.mjs`), re-decided on every pass: a person can walk a character to another inn, log off, and it
stays there. Outside a no-combat room it walks to the nearest one by hops and locks there. Off by default; a posture
turns it on. `substrate/postures.example/example-no-combat-lock.mjs` is the shape.

**It is decided in the keeper, not in `tend`, and that is the point.** A keeper that relogs in room B while still
assigned room A leaves on its first pass (`readyToLeaveSanctuary`: *"leaving on unknown vitals -- there is somewhere
else to be"*), a minute before any tend loop could re-point it. So `noCombatLockAdopt` runs at the top of `passOnce`,
right after the live check and before combat, survival or any mover; it also drops a journey suspended toward the old
room. `noCombatLockShepherd` runs after the survival ladder, through `Autopilot.travel` (travel guard armed), at most
every 20 s, never from the Underworld and never over a journey already moving the body.

A posture using it sets `assigned_room` and `confine_rooms` ONLY for a unit standing in a no-combat room (so the save
holds them and release restores them), and leaves them out for a unit outside one: the keeper picks the destination,
and `tend` re-pushing its own guess would fight it. The release restores `lock_no_combat: false` because the keeper
reports the default. `node tools/m59-no-combat-lock-test.mjs` (20) pins it.

A posture is the "posture" piece of the [fleet plans](m59-fleet-plans.md) design proposal. The conductor that
switches plans, and the loops and supply lines, are still to come.

## Named hazards: say it, or it is refused

`tools/m59-hazards.mjs` is one list of acts that are sometimes exactly what the operator wants and otherwise cost a
character. An order carrying one is refused unless it names it: `accept: ["<id>"]` on an MCP call or in a FleetScript
call, `--accept <id>` on a CLI. The refusal says nothing was done and names the flag.

| id | refused where | when |
|---|---|---|
| `survival_off`, `no_flee`, `travel_unguarded` | `m59-posture.mjs apply` | a posture would set it |
| `survival_off_move` | the broker's tool door | `travel` for a character whose survival is off, to a room that is not NO_COMBAT. The safe rooms come from the map's own room flag (`noCombatRooms`, 73 rooms: every inn, shop, bank and hall), not a hand list |
| `go_red` | combat mode (`needsSafetyOff`) | a `kill` would lower safety against an innocent, and this character is not already a murderer |
| `reroll` | the broker's `reroll` tool | already wanted `confirm: true` |

**Survival off is a lease.** `survival_enabled: false` stores `survivalOffUntil`: 30 minutes by default,
`survival_off_ms` to choose, at most 12 hours. After it the keeper treats survival as ON whatever the stored flag says
(`survivalOffOf`). A flag with no lease (pushed straight to a keeper, or set before leases existed) stays off as before.
The night of 2026-10-25 a drill's restore left six keepers with survival off until morning. Scripts and a bot then
travelled them into Ukgoth, and seven deaths followed with every hit heard and none acted on.

## Tripwires: a posture that goes on by itself (off by default)

```bash
node tools/m59-tripwire.mjs try   red-alert --who "Somebody,An Enemy"   # offline: would this trip it?
node tools/m59-tripwire.mjs look  --fleet prod                         # one live observation, read-only
node tools/m59-tripwire.mjs watch --fleet prod --dry                   # the watcher, pushing nothing
node tools/m59-tripwire.mjs watch --fleet prod                         # the watcher
node tools/m59-tripwire.mjs fire | stand-down red-alert --fleet prod   # by hand
node tools/m59-tripwire.mjs status --fleet prod
```

A tripwire says only WHEN; the orders and the undo are a posture. It follows the red-alert supervisor of
2026-10-17, which locked the fleet down on a `who` sighting and stood it down after 15 minutes of fresh
absence. The operator ruled (2026-10-25) that this behaviour is allowed, off by default.

- **Triggers** (a closed set; an unknown one is refused at load): `who_online` (an exact name in a fresh
  `who`), `war_alarm` (a keeper's alarm, by enemy / room / basis / age), `pvp_death` (a count of fleet PvP
  deaths in a window, optionally by killer), or a function of the observation.
- **Armed only twice over.** `substrate/tripwires-<fleet>.json` must name it in `enabled`, and a `watch` must be
  running for that fleet. A fresh clone has neither.
- **A stale `who` is not quiet.** It resets the quiet clock. Only fresh absence counts toward a stand-down.
- **It only takes off what it put on.** If the posture was already on when it tripped, it is `owned: false` and
  never released by the tripwire.
- **Two tripwires on one posture:** it comes off when the last of them is quiet.
- **One watcher per fleet**, and it refuses to run while a pid in the fleet file's `exclusive_pids` is alive
  (the private red-alert supervisor, which would fight it for the same bodies).
- Every trip, quiet, stand-down and refusal goes to `substrate/tripwire-state/<fleet>/events.jsonl`.

Not carried over from the private supervisor: benching characters that die during the alert at an inn, dropping
them from DUM's scope, and the per-unit drill record. DUM can still re-decide a locked-down character; the job
board pause covers leased runs only.

## Operations: a battle plan as data

[`tools/m59-operation.mjs`](../tools/m59-operation.mjs) is the shape a Fleet Management page can draw and edit:

- **roles** — filled from the fleet by channel, spell or a condition;
- **zones** — squares, a rectangle, or `doors_between: [a, b]`;
- **phases** — the first whose `when` holds;
- **posts** per role per phase;
- **expectations**, each anticipating something (`he runs for a door: melee heads him off`) until its
  `invalidate_when` holds. Then its reactionary `then` replaces it (`he stopped to slug it out: assist`);
- **states**: `proposed → approved → running → paused/done/cancelled`, with `double_down` on a running plan.

Everything here is pure. `dry` walks a timeline of facts through the plan and prints each change of phase and
order, which is exactly what a runner would decide, without a packet. **There is no runner yet**: the posting
loop exists in the door-guard play, and wiring operations to it, and to the pages, is the next step.

## The five cases

| | case | solved by (private, `m59-private`) | built on (public) |
|---|---|---|---|
| 1 | fan out to the doors between any two connected maps | `pvp-door-guard rooms=38,39 agents=...` | `rpg/doors.mjs`. The doors are derived from the map, so no door file is needed; it reproduces the hand-written `cv-east-stairs` and `cv-front-door` squares exactly |
| 2 | Morph and Anonymous | `paks/morph-watch.mjs` | `threat.classify`; `rpg/suspicion.mjs`; `combatTarget` accepts a marked object by `#id`; war alarms carry the id so the room converges |
| 3 | firewalls | `paks/firewall-doctrine.mjs`: cross when one hit is cheap, else shoot from here, else leave the map | `movement.hazard`, `combat.blocked`, `rpg/hazards.mjs` |
| 4 | battle timers; channel feedback; a purge request | `paks/wand-feedback.mjs` and `fleetscripts/service-desk.mjs service=purge` | `combat.outcome`, `combat.channel`, `rpg/timers.mjs`, `rpg/damage.mjs`, `rpg/requests.mjs` |
| 5 | curses and remove curse | `paks/curse-watch.mjs` and `service-desk service="remove curse"` | `upkeep.curse`, `rpg/sheet.mjs` |
| + | lock the fleet down, and undo it | `postures/lockdown-cv.mjs`, `postures/bastion-38.mjs` | `m59-posture.mjs` |

### And the Qor opener that stood still (2026-10-25)

A caster without the karma for hold got *"You are not vile enough to cast hold!"* and re-cast it every two seconds
while it was cut down. Two fixes, one in each place:

- **The harness, for every opener strategy.** `CombatMode` records the karma refusal ("not vile enough", or
  "not worthy" for Shal'ille) on the fight, and `pvpOpener` passes over any answer naming that spell for the
  rest of the fight. The fight falls through to the next strategy, then to the volley and melee. The opener
  context now carries `karma`, `fight`, `fight_started_at` and `karma_refused`.
- **The strategy, `strategy/strategies/qor-disable.mjs` (private).**
  - It knows each disable's requirement: −10 × level, so enfeeble −30, hold −40, blind −50.
  - It turns a spell off for the fight, with every spell that needs as much or more, and steps aside at once.
  - When karma is within 10 of a requirement and a typical vampiric wand would close the gap, it posts
    `give:wand of vampiric shock` once per fight. The arithmetic: each zap pushes karma toward −80 by the kod's
    `CalculateKarmaChangeFromAct`, about −0.5 a zap near −35, and a wand has 10–18 charges.
  - The volley fires the wand on its own beat, and hold comes back the moment karma reaches it.
  - `service-desk service="give:wand of vampiric shock"` is the fleet-mate who hands one over.

### What is not covered yet

These are limits found while building, not hidden.

- **`combat.blocked` and `combat.channel` live in `CombatMode`.** That is PvP and operator combat orders. The
  keeper's ordinary monster fight (`skills.fight`) has no joint yet.
- **A bow's attack still uses melee range in the combat sequence.** So `ranged` with only a bow holds the approach
  without firing. Wands and targeted spells fire.
- **The router does not plan around ground effects.** The mover refuses the step at send time, which is where
  `movement.hazard` is asked. A route through a firewall is therefore asked about once, at the wall.
- **The service desk serves a target in its own room**, or a fleet-mate up to `hops` rooms away with `travel=true`.
  A purge is never walked to.
- **Not yet observed live.** Nothing here has run against the live server. The read-back in postures, and the
  decision records, are how the first live run will say what is wrong.
