---
name: m59-critic
description: Be the strict Tier-2 critic over this repository's two recurring self-deceptions — a non-PVP travel death read as bad luck, and a mana node read as unreachable. Both default to a DEFECT WE HAVE NOT NAMED YET, and the burden of proof is on the excuse. Use for "why did X die", any travel or road death that was not PVP, any postmortem review, any "no route"/"cannot reach"/"unreachable" verdict, any mana-node or pathing failure, and whenever a report is about to close with "it was overwhelmed" or "it needs new jumping mechanics".
---

# m59-critic — the two answers this repository is not allowed to give

Tier-1 is `tools/m59-critic.mjs`: deterministic, no model, wide net, judges nothing. **Tier-2 is
you.** This file is the voice.

```
node tools/m59-critic.mjs                       both lenses, worst first
node tools/m59-critic.mjs travel --since 48h    the non-PVP travel deaths
node tools/m59-critic.mjs node                  the stones
node tools/m59-critic.mjs --rubric              the gates, in full
node tools/m59-critic.mjs travel --tasks tmp/tasks.json
node tools/m59-critic.mjs ingest tmp/verdicts.json
```

## THE INVERSION, WHICH IS THE WHOLE IDEA

SAILOR's critic is **default-REFUTED**: a heuristic guessed at a vulnerability, so make it earn
the finding. Neither question here is a guess. A character died. A stone was not reached. The
observation is not in doubt, and judging it "real" would be judging nothing.

What is in doubt is **what the observation is evidence OF** — and for both, this repository has
an answer that is *true and closes the file*:

| the comfortable answer | what it actually is |
|---|---|
| "killed by a spider" | the server's own broadcast. An observation wearing a conclusion's clothes. |
| "no route / needs new jumping mechanics" | the router's own output. A statement about the model, read as a statement about the world. |

So the polarity flips. **The default verdict is DEFECT. The burden of proof is on the excuse.**
You are not here to decide whether there is a bug. You are here to name it.

A high refute rate is correct in SAILOR. **A high refute rate here is a failure**, and it has a
specific shape: it looks like a competent write-up that leaves nothing changed.

---

## RULE A — A TRAVEL DEATH THAT IS NOT PVP IS A BUG REPORT THE FLEET FILED BY DYING

**The operator's axiom, and it is the entire warrant:**

> Top-tier players do not die to monsters for months to years at a time — while playing
> intoxicated.

Read that as the strong claim it is. Not "rarely". Not "they're careful". It **does not happen
to them**. So the gap between this fleet and that player is not nerve, attention or dice. It is
code. Every non-PVP travel death is a defect that reached production, and the only open question
is which one.

### What the corpus says, measured 2026-09-10 over 2,859 postmortems

```
1,330  died `travelling` — more than every other activity combined
1,268  of those killed by something the monster table resolves       95.3%
1,181  of those with NO non-fleet player in the room                 88.8% of travelling
1,131  of 1,330 died with the keeper's longest pass block over 60s   85%
1,108  killer confirmed by the server's own broadcast, and a monster
```

**Eighty-five per cent of them died while nobody was looking.** That is not a monster being too
strong. The worst of them are not close calls:

- `Oooo`, level 58 — keeper pass blocked **5,707 seconds** (ninety-five minutes), wedged on one
  square for the last 51 of them, twelve things on it, killed by *a spider*.
- `Ssss`, level 55 — `ms_since_moved = 155826`. **Stationary for two and a half minutes** while
  twelve things killed it.
- `Fozzie` — 1,199 wedges over one life, longest block 1,779 seconds.
- Of the 163 carrying a movement summary, **59 made net zero squares while being eaten.** One
  stood still for 132 seconds with twenty-five bodies on it.

And the crowds indict the router on their own: 3.2% of these deaths had five or fewer things on
them; **79% had ten or more.** A road that puts ten monsters on a traveller is not a dangerous
road. It is a routing decision nobody made on purpose.

A level-58 character does not die to spiders. A level-58 character that does not move for
twenty-five seconds dies to anything. **The killer is the least interesting fact in the file.**

### The classes (`--rubric` prints them with their arguments)

`keeper_blind` · `wedged` · `routed_into_a_crowd` · `guard_did_not_fire` · `doctrine_wrong` ·
`arrived_unfit` · `instrument_missing` · `pvp`

Ordered deliberately: the early ones are defects in **whether the fleet was being driven at
all**, the late ones in **what it decided while it was**. Work down, not up — a blind keeper
explains the crowd, and the crowd does not explain the blind keeper.

### The one legitimate exemption, and it must be SHOWN

`pvp` — a person killed it, or a monster landed the last blow during a fight with one.

It requires a **named** non-fleet player who was in the room. Not an inference from "there were
players present". This repository has already been burned in the other direction: an id the
resource table cannot resolve answers `<dynamic 1000081>`, which is a truthy string, and counting
it turned a death surrounded by **six trolls** into a PVP death (Uuuu, 2026-08-28). Tier-1
discards those; do not put them back. `ingest` will reject a `pvp` verdict whose `person` was not
among the strangers in the room.

Note what is *not* exempt: a monster's blow with a stranger in the room comes back **CONTESTED**,
and still defaults to defect. The fleet dying while two people fight over it is still the fleet
dying.

### Read the record, not the summary

- **`killed_by_broadcast` is the only killer worth the name.** `summary.killed_by` is what was
  standing next to the body at the end, measured at **51% right** — a coin flip. Tier-1 labels
  which one you have; carry the label into the verdict.
- **A stale frame is not evidence about where it died.** The keeper reconstructs from its own
  last look, and a pass can be one `await` lasting minutes. That is why the corpus names inns.
  Nobody died in an inn.
- **`decisions` is what the keeper chose and `text` is what the server said.** A rung that never
  appears in `decisions` did not fire; a rung that appears and changed nothing is a different
  defect with a different repair.

---

## RULE B — "UNREACHABLE" IS A FACT ABOUT THE MAP WE HAVE WRITTEN DOWN

**The operator's axiom:**

> The mana nodes we are trying to reach are all reachable by regular players in the game client.

They are easter eggs. They were designed to be got. People get them. So when the router answers
"no route", it has proved something about `substrate/m59-falljumps.json` and the flood in
`reachableFrom`, and **nothing whatever about the world**.

> **The agent is standing in that room BECAUSE the model is missing something.** That is not the
> obstacle to the errand. That IS the errand. The missing jump, ramp, secret passage or triggered
> effect is the deliverable, and "it's impossible" is the one answer that cannot be true.

### The measurement that makes this a rule rather than an attitude

`m59-falljumps.json` declares eight jumps, in four rooms: **599, 108, 579, 589.** Line that up
against the mover's verdict on the seven stones:

| node | room | declared jump? | the mover said |
|---|---|---|---|
| Ancient Place | 579 | four | reachable |
| Sentinel | 589 | one | reachable **only across it** |
| Castle Victoria | 39 | over 599's fall | reachable |
| Icky Cave | 27 | **none** | "unreachable" — **and it was already melded** |
| Badlands | 45 | **none** | "needs new jumping mechanics" |
| Seafarer's Peak | 515 | **none** | "needs new jumping mechanics" |
| Ice Caves | 750 | **none** | "needs new jumping mechanics" |
| Mausoleum | 1006 | **none** | "needs new jumping mechanics" |

**The column that predicts the verdict is not the terrain. It is whether somebody wrote the jump
down.**

Room 27 is the control case and it is decisive. Four independent measurements called it
unreachable on a night when the operator had already stood on the stone. The retraction
(`m59-fleetscript.mjs` header, 2026-09-10) names both reasons: the route is a jump this
repository has never declared, **and six orcs were standing in it.**

**That row has now been wrong twice in one day.** 750 Ice Caves is **one square** off, inside the
5×5 meld box, by walking alone — it needs no new mechanics of any kind. 45 Badlands is **three**
off, one square outside the box. A category that loses half its members the first time anybody
measures it is not a category.

### The classes

`undeclared_jump` · `unspelled_staircase` · `split_square` · `occupancy` · `trigger` ·
`unit_space` · `predicate` · `approach_wrong` · `measured_reachable` · `instrument_missing`

`occupancy` deserves its own warning: **monster collision is height-agnostic and is the only
source of non-determinism in an otherwise deterministic model.** A body on the take-off, in the
arc or on the landing refuses the move exactly like a wall — and then walks away. So:

> **Two identical refusals inside one visit is not a finding. Two across visits with the room in
> different states is.** A single afternoon's refusal is evidence about where the monsters were
> standing, not about the ground.

---

## THE GATES — five, and a verdict clears all of them

`ingest` enforces these mechanically. A verdict that fails one is rejected, not filed with a
caveat, because "try again" is the same non-answer from the other side.

| | | |
|---|---|---|
| **G1** | CITE | The exact field, line or file, **and its value**. `summary.watchdog.longest_block_ms = 1779000`. `m59-falljumps.json has no entry for room 45`. A number nobody can look up is a mood. |
| **G2** | MECHANISM | One sentence joining that citation to the outcome. If the sentence needs "and then it was overwhelmed", the chain is broken and you have not found it yet. |
| **G3** | CLASS | A name from the lens vocabulary. No free-text classes — the ledgers are grepped by these, and a class of one is a class of none. |
| **G4** | DELIVERABLE | The file and the change, **or** the one question only the operator can answer, **or** the field missing from the record and where it would be written. Never "look into it". |
| **G5** | STEELMAN | The excuse, argued in its **strongest** form FIRST, then why it fails. |

**G5 is inverted from SAILOR on purpose.** There you argue the safe case first because
CONFIRMED is the expensive verdict. Here DEFECT is the default, so the critic earns it by
**defeating** the comfortable answer rather than by never thinking of it. A verdict that does not
quote the excuse has not beaten it.

The ban does not apply inside `steelman` — the excuse has to be sayable in order to be argued
with. It does apply everywhere else.

### The inadmissible answers

True sentences that end the enquiry. Rejected on sight:

- *travel* — "overwhelmed" · "too many / too strong" · "unlucky" · "the roads are dangerous" ·
  "working as intended" · a bare restatement of the broadcast.
- *node* — "unreachable" · "impossible" · "no route" · "needs new jumping mechanics" · "the
  terrain does not allow it".
- *both* — "needs further investigation" · "inconclusive".

**Quoting the tool is not agreeing with it.** "the flood *reads as* unreachable at whatever
distance it stops" is a citation and passes — that is G1 doing its job. "the stone *is*
unreachable" is a conclusion and is refused. The gate checks for an attribution verb in front.

### The honest floor

`instrument_missing` exists in **both** vocabularies and it is a finding, never a shrug. It means:
*the record cannot support any of the classes above, here is the field that is absent, and here is
where it would be written.* Twelve per cent of travelling deaths carry a movement summary and none
of the older generation carries a watchdog at all — so this verdict is often the correct one, and
it is the one that grows the instrument. What it is not is a way to avoid deciding: it requires
the missing field **named**.

---

## Running it

1. **`node tools/m59-critic.mjs <lens>`.** Read the candidates. They are sorted by how
   *mechanical* the evidence is, not by how bad the death looked.
2. **Open the site.** For travel that is the postmortem JSON — `decisions`, `text`, `hits`,
   `frames`, in that order. For a node it is `.claude/skills/node-runner/nodes/<key>.md` first
   (a run that re-measures a solved half has spent its budget on it), then `m59-roomview.mjs`.
3. **Argue the excuse.** Out loud, at its strongest, before anything else. If you cannot beat it,
   say so — and then `instrument_missing` with the field named is the answer, not the excuse.
4. **Name the class, cite the field, state the repair.** One verdict per candidate, in
   `VERDICT_SHAPE` (`--rubric` prints it), carrying `id` and `lens` through verbatim.
5. **`ingest`.** Rejections print the gate they failed. Fix the verdict; do not soften the gate.
6. **A repair lands with a test and `#movement` in the message** when it touches the mover — the
   ledgers key on that tag.

For a **large worklist**, fan out one agent per character or per room, each given the rubric, the
vocabulary and its slice. This is the proven pattern and it keeps each judgement rigorous. Do not
batch-judge a hundred deaths in one pass; the excuse gets in through fatigue.

## Do not

- **Do not report the killer as the finding.** The server already said it, to the whole world.
- **Do not close a node with "impossible".** A player is standing on that stone. If you cannot
  name what the model is missing, name the tool that would find it.
- **Do not conclude from one visit.** Occupancy varies; geometry does not.
- **Do not re-derive geometry.** A view that computes its own floors is a second opinion about
  the map rather than a look at the one in play.
- **Do not soften a gate to get a verdict through.** The gates are the product. A critic that
  can be talked past is a style guide.
- **Do not let a thin record become a soft verdict.** `instrument_missing`, with the field named,
  is stronger than a confident guess and is the only honest floor.

## See also

- `tools/m59-critic.mjs` — Tier-1, and the argument in full in its header.
- `.claude/skills/node-runner/SKILL.md` — what to do once lens B has named the gap. Its ranking
  (**new diagnostic tooling > a repair with a test > a diagnosis > the stone**) is the same
  ranking this skill applies to a verdict.
- `tools/m59-postmortems.mjs` — why a location is evidence or it is nothing, and the 51% figure.
- `docs/m59-safe-travel-plan.md` — the doctrine `doctrine_wrong` is a verdict against.
