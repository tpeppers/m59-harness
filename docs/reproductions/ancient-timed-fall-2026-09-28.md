# Ancient Place: corrected landing and timed third fall

Follow-up to the [four-stone report](four-mana-2026-09-28.md). Only the local
Marco clone `shadow22` / `Vvvv` was controlled, on shadow-mana broker 8971,
game endpoint 127.0.0.1:15959. Production was not changed.

## The two defects

The second declared landing (30480,38384)/8000 is inside the 248-unit clearance
of solid wall 399. The previous live body stopped at (30720,38400)/8000 instead.
The declaration now names that reachable point, r38c31. The third takeoff is
updated to the same point; the follower's 128-unit tolerance was not widened.

The third fall enters a corridor whose ceiling is 6080 and floor 4800. Wall 407
refuses a body still at 8000. The old trace carried its starting height for the
entire command, so it could never fit under that ceiling. The new opt-in
`requires.timed_fall` declaration advances gravity and reuses ordinary BSP and
body collision each frame. It can wait against the overhang while airborne;
it cannot cross solid walls, gain more than the 384-unit step cap, or ignore a
blocking body. A grounded repeated refusal ends the bounded simulation.

Only a complete simulated arrival on settled floor authorizes a packet. The
sender pays the simulated duration, then recomputes against the live body and
scene before sending. A changed scene requiring more time refuses. Ordinary
walks and falls retain their previous collision behavior. The follower allows
the keeper's existing five-second conservative vertical interval to settle
before starting the next declared fall.

## Reproduction and evidence

Implementation tested at **0bccf18**, movement epoch **0bccf1888759**. Broker PID
39772 and the restarted 42676 were started from that build. Working-tree additions made during repetitions
are documentation, offline audit presentation and a separate return experiment;
the inbound script, follower, fall table and movement implementation are unchanged.

```powershell
node tools/m59-falltrace-test.mjs
node tools/m59-node-defect-audit.mjs ancient
node tools/m59-noderails.mjs bake --node ancient
node tools/m59-noderails.mjs check
```

Run the `node-trial` FleetScript with `node=ancient room=579 row=38 col=74
route=rail exit=edge:589:r38c74 quiet=true`, explicit shadow roster, control URL
8971 and the attested deployed SHA. The recipe holds the keeper lease, stages
before the measured route, dry-runs the rail, follows it, reads the actual node
response and rescues afterward. Rescue is not a walking-return claim.

All local evidence is under
[`substrate/node-attempts/20260928`](../../substrate/node-attempts/20260928).
The exact rail snapshot is `ancient-timed-rails-0bccf18.json`, SHA-256
`36d28a44ed43b052329bb1ad4d3c26dd1f6eea5a4b99067cc7c115cbc4a9f956`.

| Trial | Actual start | Node arrival | Objective |
|---|---|---|---|
| `ancient-1790618942391` | 579 r38c74, (75264,38400)/6560 | r52c30, (29952,52256)/5088 | Distinct first meld; stable max mana 57 → 65 |
| `ancient-1790619211730` | Same reset | Same exact endpoint | Already bonded; max mana 65 |
| `ancient-1790619525739` | Same reset, restarted broker PID 42676 | Same exact endpoint | Already bonded; max mana 65 |

**3/3 independent complete approaches passed**, including a fresh broker/keeper.
The operator was notified as soon as the third objective receipt arrived. The
two pre-repair failures remain in `attempts.jsonl`: 5 Ancient trials total,
3 arrivals, one first grant and two already-bonded interactions. This does not
claim three first-time grants. A startup dispatch before the first keeper had
finished login was refused before setup or movement and was retried once ready.

Each trial has `-scene.json`, `-node-dry.txt`, `-node-commands.jsonl`,
`-node-follow.txt`, and `-objective.json`, plus its append-only `attempts.jsonl`
record. The first trial's second and third jumps arrived exactly at
(30720,38400)/8000 and (30320,42000)/4800. Health remained 20/20.

Focused checks: timed fall **35**, collision including packet timing **409**,
walking dependency seam **15**, movement epoch **23**, follower **151** passed.
The timed-fall cases include 8/16/33/50ms frames, the former wall-407 refusal,
solid wall rejection, excessive rise rejection, a blocking body, and an unsettled
starting height. This is a client-style discrete model, not server altitude
telemetry; server positions and the distinct meld response establish live outcome.

The standard rail check passes with no unvalidated spans in the selected east
inbound rail. A stricter exact-endpoint audit still flags 45 of its 1,469 dense
walk edges as partial slides (`ancient-strict-bake-audit.json`). This is retained
as a bake precision limitation. The floor-aware, wire-quantized follower and
its live position receipts establish the successful route; the bake alone does
not. The generic coarse `mana-node` crawl is not the tested recipe here.

## Scope and next experiment

The separate `node-escape node=ancient` experiment passed **1/1** walking return:
`ancient-escape-1790619807314` in `escapes.jsonl`. Setup reproduced the recorded
node endpoint before the measured return. The checked outbound rail walked
169 aims to r38c74 in 140 seconds, with no jumps; an ordinary edge movement then
reached **room 589 r46c5, (4608,46592)/160**, health 20/20, mana 65/65. No
administrative placement occurred during the return. Its final `walk_to` reply
said `arrived:false` / `goal is outside the room grid`; the subsequent actual
room and authoritative room read confirm the transition. Both are retained in
the receipt. This establishes a real exit, not three repeat return trials.

Afterward the scripted rescue returned the clone to room 52 r6c10,
(9728,5632)/1600, health 20/20, mana 65/65. The broker still runs the tested
0bccf18 build; later packaging is not a deployment claim. Checkpoint-only
preservation stopped nothing. Under
`C:/code/mindmap/maps/m59-harness/docker/lab-data/checkpoints/`, snapshots
`2026-09-28T18-28-09-standing` retain the prior 18:00 save and
`2026-09-28T18-28-09-checkpoint` preserve the new gain (four save files verified).
See `ancient-checkpoint.txt` and `ancient-final-state.json` in the evidence directory.

These runs intentionally remove hostile bodies and disable generation before
the route, restoring generation afterward. Monster tolerance is not established.
After repeatable arrival, capture and replay one blocker beside the staircase
or fall corridor; verify that the route either succeeds or stops on its shelf
with a named body refusal, retaining an actual escape receipt.
