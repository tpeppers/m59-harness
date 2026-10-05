# Fleet plans — Plan A, Plan B, … as one declared, switchable thing

**Status: DESIGN PROPOSAL (2026-10-05). Nothing here is implemented yet.** Operator, 2026-10-05:
*"These kind of 'plan A/B(/C/D/…)'-fallbacks with conditionals is likely going to be a common thing in
fleetscripts that will want to properly manage various states, supply lines, and dynamic requirements
across routing, decision making, etc., and should be fully supported by our strategy/dumbot config
fleetscripts."*

## What exists today, and why it hurts

On 2026-10-04/05 the fleet switched Plan A → Plan B → Plan A twice. Each plan turned out to be **three
different things kept in three different places, by hand**:

| piece | where it lived | how it was switched |
|---|---|---|
| the **posture** (mode, room, hunt, strategy, practice, reagent rules) | `planA3`/`planA4` scratch scripts, raw `autopilot start` pushes, now the local `plan-a` fleetscript | run a script |
| the **loops** that do the work (tree-farm, hold/fog/curse practice, create-weapon, Kraanan drills) | `.cmd` files fed to fleet REPLs, `plan-a-full` | relaunched by hand — and after the first lockdown, **nobody did**, so Plan A came back as postures only |
| the **trigger** (first PvP hit, or monster deaths over `9 + floor(toughers/2)`) | `watch-pvp-firsts.mjs`, a scratch watcher in one session | it runs `lockdown`, which kills every fleet REPL |

Consequences actually seen: loops not restarted after a resume; scripts written *during* a lockdown that
kept behaving as if in one (`curse-cycle`: "no travel in lockdown") after it lifted; supply lines
(Raphael's berries, Janice's mushrooms, emerald restocks) re-invented per script, each with its own
failure modes; and no single answer to "what plan are we in, and what does it require".

## The proposal: a plan is a declared object, and one conductor switches between them

```jsonc
// plans/prod.jsonc   (local: it names characters and rooms — gitignored, like a DUM local doctrine)
{
  "fleet": "prod",
  "plans": {
    "A": {
      "why": "normal operations",
      "postures": {                      // per character or per role; the same keys as autopilot policy
        "@cv-hunters": { "mode": "farm", "assigned_room": 38, "hunt": ["skeleton","zombie"], "overfarm": 250,
                         "practice": "relay-where-they-farm" },
        "t5,t6,t8":    { "mode": "survive", "assigned_room": 537 }
      },
      "loops": [                         // fleetscripts kept running; restarted if they die (keep-training rules)
        { "script": "tree-farm",  "agents": "t5,t6,t8", "args": "goal=none deposit=keep rooms=537,536", "until": "never" },
        { "script": "hold-practice", "agents": "t7", "args": "hours=24", "requires": "supply:purple-mushroom>=2" }
      ],
      "supply": [                        // standing supply lines: who keeps whom stocked, from where, how
        { "id": "purple-mushroom", "for": "t7", "low": 4, "fill": 200, "from": "hall",
          "couriers": "@cv-hunters,t2,@tree-farmers", "approach": "chalice-first" },
        { "id": "entroot", "cache": "hk3", "cap": 300, "low_water": 150, "overflow": "hall" }
      ],
      "routing": { "avoid_rooms": [599], "travel": "allowed" },
      "rules": { "entroot berry": "never-sell, deposit-to-hall" }
    },
    "B": {
      "why": "PvP lockdown",
      "extends": null,
      // LOCK WHERE YOU STAND, never "walk to an inn": the first lockdown walked to inns and about ten
      // died to Morpheus on those roads. Posts and hosts are named, never swept up by "*".
      "postures": { "*": { "mode": "survive", "lock": "where-they-stand", "errands": "off" },
                    "@posts": "keep" },
      "sweeps": ["clear-arrival-doors"],   // e.g. Cibilo Creek's arrival square is its only door
      // NOT zero loops: anyone who can practise without travelling keeps casting until out of
      // reagents or able to buy the next level (operator rule).
      "loops": [ { "script": "practice-in-place", "agents": "@can-practise-here", "until": "reagents-out|next-level-affordable" } ],
      "routing": { "travel": "forbidden" }
    }
  },
  "transitions": [
    { "from": "A", "to": "B", "when": "pvp_death OR monster_deaths > 9 + floor(toughers/2)",
      "since": { "pvp_death": "armed_at", "monster_deaths": "A.started_at", "toughers": "A.started_at" } },
    { "from": "B", "to": "A", "when": "operator" }
    // NO transition on an enemy LOGGING IN: the standing rule is to let them score the first kill,
    // and the fleet keeps a predictable routine.
  ],
  "posts": { "@posts": { "t4": 2, "hk3": 202, "<marco polo>": 106 } }   // part of EVERY plan
}
```

### The pieces, and which repository owns each

- **The plan file** follows DUM doctrine conventions on purpose: `.jsonc`, `extends`, roles instead of
  names where possible, local overrides gitignored, and an `explain` that prints every effective value
  with the layer that set it. A plan is to the fleet what a doctrine is to a character.
- **The conductor** (harness, `tools/m59-plan.mjs`): `status` (which plan, since when, why), `switch <plan>`
  (one transition, below), `check` (is the live fleet in the declared state — every posture, every loop
  alive, every supply line above its low mark), and a watch mode that evaluates `transitions`. It
  replaces `lockdown`, `unlockdown`, `planA4`, `plan-a-full` and `watch-pvp-firsts`.
- **A transition** is always the same five steps, so none is ever half-done: stop the outgoing plan's
  loops (by their run locks, never by process name) → save what the incoming plan must restore → apply
  the incoming postures through the `plan-a`-style fleetscript (policy-only, read back) → start the
  incoming loops → record the switch in the ledger with its reason.
- **Supply lines** become a harness mechanism, not per-script code: a `supply` entry is watched by the
  conductor and fulfilled by a fleetscript built on `m59-hall-access.mjs` (chalice first, passage
  refusals recovered, the pack as evidence), with the rules learned this week built in — two low reads
  before anyone walks, skip characters held by another run lock, never the same courier twice running.
- **Loops read the active plan** instead of hard-coding a mode: `curse-cycle`'s travel-for-stock rule
  becomes `plan.routing.travel !== "forbidden"`, so nothing written during a lockdown keeps acting like one.
- **DUM** reads the active plan's `routing`, `rules` and `claim`-relevant parts for its minute-scale
  decisions (where to send a character, which errands are allowed), and a doctrine can name the plan it
  assumes. DUM never switches plans; it may *propose* a transition the conductor evaluates. The clock
  boundary stays as it is: survival is the keeper's, always.

### What the first lockdowns taught the conductor (prod-deploy-84, 2026-10-05)

These are requirements, not notes; each one cost a death or a silent failure.

1. **A PvP death is classified from the post-mortem, not from grudge rows or `pvp_survival`.** Lew's
   23:21 death to Morpheus fired neither. Read `death_attribution.was_killed_by_player`, or any non-fleet
   capitalised name in `hits[].by`. Operator ruling: any player in the hit log makes it a PvP death.
2. **Every trigger carries its own `since`, persisted across restarts.** Monster deaths and toughers
   count from the plan's start; the PvP check from the moment it was *armed*. Otherwise a restarted
   watcher re-fires on old rows (Zoot, Lew).
3. **Deaths appear two or three times in the ledger** (`death_cost`, the summary, a later
   re-attribution). Dedupe on character plus `death_at` to the second.
4. **A tougher is a `gains[]` entry in `substrate/tougher/<char>.json`**, counted from the same baseline.
5. **Plan B has loops**: practice that needs no travel continues (above).
6. **Lock where you stand, and clear arrival doors.** Never route a lockdown through roads.
7. **Every posture push is read back, and a refused key fails loudly.** `guild_tithe {enabled:false}`
   was refused and silently failed the WHOLE push; the right value is `null`. The conductor's `check`
   compares effective values, not the push's reply.
8. **Posts and hosts are declared in every plan** (Loial at 2, Raphael at 202, Marco Polo at 106) and
   are never matched by `"*"`.
9. **No transition on enemy logins.**

### What it deliberately does not do

- It does not move the keeper's one-second decisions anywhere. A plan changes postures and loops; the
  keeper still decides whether to run from a fight.
- It is not automatic beyond the declared `transitions`. "Back to Plan A" stays the operator's call
  unless a plan says otherwise.
- It does not hold passwords or credentials; it addresses characters by agent id and role, like a doctrine.

## Migration, in order

1. **Plan A and B as data**: express today's `plan-a` table and the `lockdown` behaviour as `plans/prod.jsonc`
   (local). No behaviour change — the conductor's `check` just reports drift.
2. **`switch`** replaces lockdown/unlockdown/plan-a-full; the existing scripts become what it calls.
3. **Supply lines** move from `hold-supply-watch` and the per-script restock code into `supply` entries.
4. **Transitions** move from `watch-pvp-firsts` into the conductor's watch mode.
5. **DUM** gains `plan` awareness: read `routing`/`rules`, propose transitions.

Each step is useful on its own and reversible; step 1 is a read-only report.

## Decisions (proposed; prod-deploy-84 concurs, operator to confirm)

1. Plan files live in the harness, `substrate/plans/` (gitignored, with an example beside it); DUM reads them.
2. Only declared `transitions` switch automatically. DUM may PROPOSE a switch; the conductor logs the
   proposal and asks the operator.
3. Conditions on a loop (e.g. "only while no war enemy is online") go in that loop's own `requires`,
   not in a new plan.
