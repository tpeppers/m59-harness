# Orders as desired state: the stack, leases, stocks and flows

A design, not yet a build. Written 2026-10-26 from three sources: the keeper-joints refactor, the prod session's
evidence (eight principles: "intent should be durable desired state, reconciled, not a push"), and the operator's
direction that night. The private repository holds the evidence with names (`notes/prod-findings-2026-10-26/`); this
file holds the shape.

## What it is for

One night's operation spent its hours on three things, none of which was the operator's intent:

1. **Finding out that something had silently stopped.** Six keepers had survival switched off by a drill's
   save-and-restore and cast nothing for nine hours, with no row saying why. A troll crew ground for six hours with
   weapons that could not hurt a troll.
2. **Re-asserting state that something had silently undone.** A keeper handoff reset each character to its roster
   orders: an assigned room, a confinement, a practice list. A suspended journey resumed into a road with a hostile
   player online. A lockdown's saved state was a hand-written JSON file.
3. **Proving whether an action happened.** A sell that reported price 0 on a real sale. A purse banked by a standing
   rule halfway through a courier errand. A cast judged by mana spent.

The operator, verbatim in part: jobs should be bound to *"a likely limited number of 'matches requirements, so
available'"* characters with *"automatic breadboxing of tasks"*; repetition should be *"first-class ... with a local
cache of resources, the cache growing/shrinking from importing/exporting based on flows"*; plans should apply to a
broker, keeper, fleet or region, triggered by events (a lockdown *"on the island"* or *"of everyone not on the island"*);
and rules can be complex as long as they are *presented simply* (if/then/else, flow charts, tabs). *"It is starting to
feel a lot like something that belongs managed in terraform, kubernetes, helm."*

Borrow the concepts, not the products: no external control plane, no YAML, no second store of truth. The broker is
the one store; each keeper process converges to it on its own clock.

## The model

### 1. One store of desired state per character, in layers

Each character's orders are a stack of layers. A key's effective value is the value from the highest layer that sets it:

| layer | who writes it | lifetime | today |
|---|---|---|---|
| **survival** | the keeper itself | always | the protected four: identity, mortality, survival, recovery |
| **operator** | an explicit order: `autopilot`, a combat order | until changed | a live push, credited `policy` in `policy_sources` |
| **posture** | a named profile: lockdown, bastion, inn | until lifted or expired | `m59-posture.mjs`: saved, pushed, read back, tended |
| **mission** | a FleetScript or courier job | for the job, under a lease | `commander_claim` and the errand's `inert` |
| **strategy** | a farm strategy file | while assigned | `m59-strategy-engine.mjs`, which already yields per faculty |
| **roster** | the character's standing orders | durable | `substrate/fleets/<fleet>.json` |

Survival sits on top and is not a writable layer. That is the clock boundary in `CLAUDE.md`, unchanged.

**Lifting a layer restores the one under it.** A lockdown is never undone by "put back what I saw". It is a layer, so
removing it shows what was underneath. That one rule deletes the save-and-restore that left survival off overnight, the
hand-kept `lockdown-saved/` files, and the handoff reset: a replacement keeper converges to the stack, not to the
roster.

**Every key says who set it and why.** `policy_sources` already credits the writer of every key. The stack adds the
layer and the expiry, so "why is this character confined to 27" has one answer.

### 2. Leases are the rules of engagement

A layer above the roster is held under a **lease**: an owner, the faculties or keys it covers, an expiry, and the
named hazards it accepts. Today that idea is split across four mechanisms that should be one:

- faculty claims (`commander_claim`, `PROTECTED_FACULTIES`, `may_yield`);
- the survival-off lease (`survivalOffUntil`, 30 minutes by default, 12 hours at most);
- posture expiry (`apply --for`);
- named hazards (`m59-hazards.mjs`: `survival_off`, `go_red`, `survival_off_move`, `requires_unmet`, ...).

The rules:

- **A lease expires by itself.** Nothing is "restored" by a second command that might never run.
- **Leases do not stack silently.** A second lease on a held key is refused, or queued behind the first, and the
  board shows the holder. That fixes the double-booked courier (one body, two jobs).
- **A dangerous lease has to name its hazard.** That is the operator's rule: "easy things should be easy ... but it
  should be hard to make mistakes without getting a warning or having to pass a --confirm". Survival off, going red,
  travelling with survival off, and assigning a farm whose requirements are unmet already work this way.
- **A standing rule respects a lease.** `bank_above` must not bank a purse a running errand has claimed. A purse,
  a pack slot, a spell's practice and a body's movement are resources a lease can claim.

### 3. Stocks and flows

From the operator's direction. Every place a resource sits is a **stock**: a pack, a desk's cache, a bank account, a
merchant's shelf (finite, and restocked slowly), a spawn zone. Every way it moves is a **flow** with a rate: buy,
sell, cast (reagents and mana in, skill out), farm (health, vigor, arrows and time in; loot, max health and skill out),
courier, bank.

- A **desk** is a stock plus a service loop: the chalice desk, the dedication armoury, the reveal desk, the inn's
  reagent cache. One abstraction, many instances.
- A **courier** executes flows. One courier serving several regions is a fine fit.
- **Farming is a flow too**, with resupply (arrows, reagents, weapons) going in and loot coming out to be couriered.

**Balance is checkable at plan time.** A plan whose outflow from a stock exceeds the inflow it can get is a warning
before it runs, not a discovery at 2 a.m. That night's case: a practice drill burned about 75 herbs an hour against a
merchant whose shelf went 36, 10, 0.

### 4. Resources with controllers

Desired-state objects, each reconciled by a small loop, each with a status that carries `blocked_by: {faculty, stage,
reason, since}` whenever it is not progressing:

| resource | what it says | replaces |
|---|---|---|
| `SupplyOrder` | who, item, low-water mark, how many to buy, source, budget class | per-character courier scripts |
| `Courier` | a job that executes supply orders and transfers | hand-run courier loops |
| `Desk` | cache, service, inputs, who staffs it | the chalice, dedication, reveal and inn desks, each built separately |
| `Farm` | strategy, requirements, kill-rate floor, resupply, output | a farm strategy plus by-hand restocking |
| `Lockdown` (a posture) | selector, layer, trigger, expiry | scripts written per lockdown, plus the alert watchers |

### 5. A scheduler binds jobs to bodies by requirements

A job declares what a body must have: a health band, a skill or spell, a magic weapon, pack space, "may travel while
hostiles are online". Characters carry labels. The scheduler binds a job to a body that matches, time-slices one body
across several jobs, and refuses a collision rather than letting two jobs fight for one body. A body can carry a
**taint** that keeps a job off it: that night's operator rule, "over 30 HP, no travel during this lockdown", is a
taint on travel.

**A job no body can take bounces back with the reason.** The troll crew is the reference case. *"Cannot be assigned
without a way to get weapons dedicated"* is the answer the operator asked for, at assignment, not six hours later.

### 6. Selectors and triggers

A plan applies to a selector: fleet, broker, keeper, region (a room set: "the island", "Jasper", every NO_COMBAT room
from the map), or "everyone not in" any of those. An event can apply a profile to a selector: a hostile player in
`who`, a war alarm, PvP deaths. The tripwires (`m59-tripwire.mjs`, off by default) are the first triggers.

### 7. Plan, then apply, with admission checks

Nothing moves before a diff. The checks that refuse a bad plan, each overridable by naming it:

- **spawn**: the hunt target can spawn in the assigned rooms. Two layers, the map's spawners and kod triggers. Warn
  and require an override, because DM spawns and wanderers make an anomaly real.
- **buyer**: the item has a buyer, and the plan sells to it (one item per offer where a merchant demands that).
- **protected inputs**: a sale or a drop does not take what another flow needs: a dedication's spare weapons, a
  caster's casting hammer, a desk's reagents.
- **flow balance**: as above.
- **requirements**: as above.
- **safe rooms**: an inn is any NO_COMBAT room from the map, never a hand-kept list.

### 8. Presented simply

The same graph renders three ways: as rules (if/then/else), as a flow chart (stocks and flows with their rates), and
as tabs, one per module. The DebugClient's MANAGE tab and the field page are the natural places for it.

## What already exists and becomes part of it

| piece | is, in this model |
|---|---|
| `policy_sources` | the "who set it" column of the store |
| farm strategies (`m59-strategy-engine.mjs`) | the strategy layer; it already yields per faculty and refuses survival keys |
| postures (`m59-posture.mjs`) | profiles; tending re-pushes any drift |
| tripwires (`m59-tripwire.mjs`) | event triggers on a selector |
| named hazards (`m59-hazards.mjs`) | the override vocabulary for leases and admission |
| survival as a lease | the first expiring lease on a protected key |
| `requires`, `floor` and `otherwise` (`m59-strategy-gate.mjs`) | admission, `blocked_by` and the remedy loop for the `Farm` resource (below) |
| the service board (`tools/rpg/requests.mjs`) | the request half of a `Desk` |
| FleetScript guarantees and `unsafe.waives` | admission checks for missions, already in force |
| joints and paks | per-moment rules inside a keeper: below this layer, unchanged |

## The first piece, built: what a farm needs, a kill-rate floor, and the escalation

A farm strategy file may now say:

```js
requires:  { magicWeapon: true },        // and/or items; request: { service } (dedicate by default for magicWeapon)
floor:     { kills: 4, minutes: 30 },    // at least 4 kills per 30 minutes of farming
otherwise: 'some-safer-strategy',        // the catch-all orders when no desk can fix it
```

- **At assignment** an unmet `requires` is refused, naming the weapons found, unless `accept: ["requires_unmet"]`.
- **After that, nothing just stops.** The operator: *"I don't want stoppage as a reaction except if there's no
  desk-solution available, and for those cases we'd want a gutter/catchall orders"*. A tripped floor first re-reads
  every weapon. A cause with a desk remedy (a lapsed dedication, a curse) posts the request and keeps farming with the
  clock paused. No remedy, or no answer within the ttl, serves the `otherwise` strategy, or this machine's default,
  while the assignment stays as it was. It returns by itself when the requirement is met. Only with no fallback at all
  does it stand down, and it says so.
- It is saved per character, so a handoff carries it. An explicit assignment, or an edit of the file, means "try again".

This is the `Farm` resource's admission check, `blocked_by`, and remedy loop, in miniature. A desk is "available" when
the file or the cause names its service, bounded by the ttl: the service board does not yet know who staffs which desk.
That registry is step 5 below.

## Unreadable is never empty

Prod, 2026-10-27: an inn-practice tick read six keepers fresh from a handoff, got an empty abilities list (the server had
not sent it yet), planned "nothing to drill", and pushed practice off on all six. Every controller in this design
(supply orders, desks, the scheduler, the gate) has to keep three answers apart: **known and empty, known and
something, and not known yet**. The last one means "skip this tick", never "plan for nothing". The `abilities` tool now
answers an unread list with `null` and a `*_unreadable` reason when the keeper's record names entries the live list lacks.

## Build order

1. **Requirements, the floor and the escalation.** Done (above).
2. **The handoff converges to the live stack.** A replacement keeper takes the outgoing keeper's live orders, the wall
   it holds, and its current holds, and never resumes a stale suspended journey. This is the smallest piece of layer
   (1), and it removes the snapshot/diff/re-push routine run by hand after every deploy.
3. **One lease shape.** Claims, survival off, posture expiry and hazards become one record: owner, keys or faculties,
   expiry, accepted hazards. The broker refuses a write to a leased key from anyone but the holder.
4. **`SupplyOrder` and the courier as a scheduled job.** Merchant stock is modelled from what each buy actually
   returned. A standing rule respects a claimed purse. The herb courier is the first instance.
5. **Desks as one abstraction.** Chalice, dedication, reveal and the inn cache become instances.
6. **Plan-time admission:** spawn, buyer, protected inputs, flow balance.
7. **Selectors plus event-triggered profiles**, absorbing the lockdown scripts and the alert watchers.
8. **Farming as a flow**, with resupply in and couriered output.

Each step is useful alone, and none boxes in the next.

## Open questions for the operator

- **Floor defaults.** One kill per 30 minutes is the floor as proposed. A troll crew with mundane weapons may still
  land an occasional kill, so a troll file probably wants something closer to four per 30 minutes. Should there be a
  fleet-wide default floor for files that declare none, or keep silence as the old behaviour?
- **The scheduler's authority.** Should it only *refuse* a collision (step 3), or also *pick* the body for a job from
  the ones that match?
