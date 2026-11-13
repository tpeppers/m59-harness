# The GOAP distiller

Operator, 2026-11-13: *"build a GOAP-distiller that when looped will train the fleet to get everything they need to
get their character plans accomplished (the character plans being whatever was assigned via the compendium's party
planner for each character)."*

Two files:

| | |
|---|---|
| `tools/m59-distill.mjs` | the decision core. **Pure**: an observation in, one next action per character out. Pinned offline by `tools/m59-distill-test.mjs`. |
| `tools/m59-distill-run.mjs` | the loop: observe (read-only), decide, and with `--apply` act through executors that already exist. **Dry by default.** |

## What a plan is

The party planner writes `substrate/loadouts/<Character>.json` `plan`. The broker's `learningView` turns it into the
fleet row's `learning` field with the compendium's PlayerCanLearn arithmetic (`compendium/tools/learn.mjs`):
`planned.next` is the first ability of the first unfinished queue stage the server is expected to offer now, and a row
with `remaining_required > 0` is gated by school (or weaponcraft) points. The distiller reads that view; it never
recomputes it.

## What it decides, in priority order

One action per character per pass; the first that applies wins.

1. **Skip** — excluded, not in game, piloted by a person, dead, hurt (under 80% health), mid-errand (an untakeable
   commitment, a move someone else ordered, one of our actions still in flight), no plan. A **fragile** body (max health
   under 25) gets no road action at all; in-place actions still apply.
2. **Learn** the next planned ability when it is expected buyable, purse + bank covers the price, and the teacher is
   reachable: not on the island (rooms ≥ 2000), not a known trap, not listed unreachable, and — when the runner has the
   room graph — not on a route through the Cragged Mountains (578) or the Ancient Place (579) for a body at or under
   `risky_hp` (40).
3. **Practice** when an active planned spell is short of school points: the gate spells (the best three at the
   highest known level, weakest first — `m59-practice-plan.mjs`), in the home room. Pushed **only when the set of
   spells, the rooms or the floor differ** from what is in force; a re-order is not a re-push. Two corrections learned on
   prod, 2026-11-13, in the inn at 153:
   - a **creature-target** spell (zap, hold, splash of acid, enfeeble, vampiric drain, kara'hol's curse, dazzle) is
     never listed where the spawn index says there are no creatures — the keeper declines the *whole* practice pass when
     one heads the list with nothing to aim at — and goes **last** where there are;
   - the **mana floor** is capped at max mana less the dearest listed spell, and is 0 in a room with no creatures (a
     21-mana enchanter was held at a 17 floor against 10-mana spells: `reserve_leaves_no_room` for ever).
4. **Supply** the reagents the drill burns, when one is under its low-water mark (a quarter of the want, or blocking a
   gate spell — the gate's reagents first). A pack at 95% or more receives nothing, so the first step is
   **make-space** in place (only the keeper's own sale-plan rows are dropped); when that has already failed, a deposit
   of the shillings and gems is *proposed*. Then, in the operator's order, **use what we have → farm → buy**:
   1. a **same-room fleet-mate** with spare (it keeps its own want plus max(10, 25%) of what it holds, and gets no
      action of its own that pass);
   2. the **guild hall chests** (`--hall 714`; read from the chest cache, decremented across receivers in one pass);
   3. **farm** the safest source: every creature the drop index says rolls the item, kept only when it *and every
      huntable creature in its room* is at most `farm_band` × max health, the room is reachable, and its karma is
      allowed — smallest creature first. **Executed only when allow-listed** (`--farm-allow "baby spider@554"`);
      otherwise it is a proposal, and buying goes ahead;
   4. **buy** at the cheapest reachable, non-wandering counter that sells it, money permitting — never for a character
      whose loadout pins `buy_reagents: false`.
5. **Train** a weaponcraft skill short of points: a safe training quarry (highest level up to 45, karma-allowed, in
   band) as a **proposal** only in v1.

**Karma.** A character's protected direction is its policy `karma`, else its schools: Shal'ille is good, Qor is evil.
A good character is never assigned a positive-karma quarry (no living trees for entroot berries), an evil one never a
negative one, a `karma_strict` character only what moves its karma the right way (the keeper's own rule), and unknown
karma is refused whenever a direction is protected.

**The scheduler.** A road action (learn, hall-draw, farm, buy) needs the character **at home**, unconfined (unless
`--ignore-confine`) and a free away slot: `--away-limit` (default 1) counts in-scope characters already outside the
home room plus road actions granted this pass. A failure cools that (agent, action, item) down for 30 minutes; a learn
that may have spent money is not retried.

## Running it

`--fleet` is required and never defaulted. Run it from the deployed checkout, so the loadouts, chest cache and map are
the fleet's.

```bash
cd C:/code/m59-lab/prod-deploy
node tools/m59-distill-run.mjs --fleet prod --home 552                      # DRY, once: print every decision
node tools/m59-distill-run.mjs --fleet prod --home 552 --hall 714 --away-limit 1 --exclude hk3
node tools/m59-distill-run.mjs --fleet prod --home 552 --only practice      # just the practice pushes
node tools/m59-distill-run.mjs --fleet prod --home 552 --record             # DRY, but write the decisions to the ledger
node tools/m59-distill-run.mjs --fleet prod --home 552 --apply --once       # one pass, for real
node tools/m59-distill-run.mjs --fleet prod --home 552 --apply --interval 900
```

Other flags: `--farm-allow "creature@room[:item],..."`, `--ignore-confine`, `--json`, and `--config <file.json>` for
any key of `DEFAULTS` in `m59-distill.mjs` (`hurt_below`, `farm_band`, `risky_hp`, `unreachable_rooms`,
`buy_avoid_rooms`, `practice_creatures`, ...). Each dry line reads `DO`, `PROPOSE` or `--` (skipped, with the reason
and the notes on every option it passed over).

With `--apply` the runner first asks `m59-which.mjs` and refuses the pass on a mismatch or INDETERMINATE, then executes
one action at a time, in-place first:

| action | executor |
|---|---|
| learn | the broker's `buy_next_planned_skills` for that agent: a fresh PlayerCanLearn preflight, the burnt-purchase guard, `m59-learn-run.mjs --fleet` |
| practice | practice-plan's apply half: the distiller's list pushed as `practice_spells` (keeperLease waived) and read back |
| make_space | the `make-space` fleetscript |
| supply | a fleetScript of one `supply` step (donor's exact stack name, its keep floor), verified by the receiver's count |
| hall_draw | the `hall-draw` fleetscript, `home=<home>` |
| buy | the `buy` fleetscript, seller and room from the catalogue, `back=<home>` |
| farm | allow-listed only: walk, `harvest`, walk home, and the hunt and station put back as they were |
| train, deposit | proposals: printed and recorded, never executed |

Every order goes through fleetScript, so the run lock, liveStart (piloted bodies and other jobs refused), the health
floor, `fragileBody` and the trap check stand behind every decision as a second net. Only one fleetScript runs per
fleet at a time, so a pass that meets another session's run records a refusal and cools down.

## The ledger

`substrate/distill-<fleet>.jsonl` (gitignored). Per pass, one `decision` row per character (action, reason, notes,
proposals); per executed action a `start` row and an `outcome` row (`ok`, `refused`, `why`, and for practice the
`before` list it replaced). The `start` / `outcome` rows are what the next pass reads for in-flight bodies and
cooldowns. A dry pass writes nothing unless `--record`.

## Not in v1

Buff reagents (only the drill's), executing weaponcraft training, karma correction, deposits, wandering teachers'
current rooms, and routes beyond fewest hops over the baked room graph.
