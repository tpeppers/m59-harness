# Ancient Place — room 579, r52c30

## Follow-up: timed fall repair, 2026-09-28

The repair in **0bccf18** passed **3/3 independent full quiet-shadow approaches**,
including a broker/keeper restart. One first meld raised max mana 57 → 65;
the next two returned already bonded. Both repaired jump landings and the final
node endpoint repeated exactly, with health 20/20 throughout.
The separate `node-escape node=ancient` walking return passed 1/1 from that
endpoint through the east exit into room 589 r46c5; receipt
`ancient-escape-1790619807314` retains the pessimistic final command reply and
the confirmed actual room transition. Return repeatability is not yet established.
See [the timed-fall report](../../../../docs/reproductions/ancient-timed-fall-2026-09-28.md)
for current repetition counts and receipts. The older failures below remain
useful reproductions; their conclusions are superseded where this update differs.

Jump 2 now names the measured (30720,38400)/8000 landing at r38c31. Jump 3
starts there and explicitly requests `requires.timed_fall`: gravity advances
while the body waits against wall 407, until it fits below the 6080 ceiling.
The ordinary BSP/object collision checks remain active throughout. The first
live run landed exactly at (30320,42000)/4800, walked to r52c30 at
(29952,52256)/5088, and received the distinct first-meld response with stable
same-keeper max mana **57 → 65**. Health stayed 20/20.

`node tools/m59-node-defect-audit.mjs ancient` now prints the frozen-height
refusal alongside the timed trajectory. `m59-falltrace-test.mjs` and the packet
regression in `m59-collision-test.mjs` pin the cause and retain wall/body refusals.

## 2026-09-28 shadow measurements

Use the checked east inbound rail `edge:589:r38c74`. Actual trial start:
r38c74, client (75264,38400), floor 6560, health 20/20. Hostile bodies were
removed and generation disabled during each trial. Broker: local-main 1258ce4.
These are quiet-scene experiments, not a proof with monsters present.

Two full approach trials stopped short of the node. Evidence IDs under ignored
`substrate/node-attempts/20260928/`:

1. `ancient-1790611873469`: leg 3 waypoint 20 requested client (34327,36038),
   floor 7360. Nearest wire point (34320,36032) is on floor 3392. Body fell to
   (34224,35920), floor 3392. The mover's `arrived:true` was insufficient.
2. `ancient-1790612212744`: floor-aware wire quantization selected (34336,36032)
   on 7360 and passed **all 81 aims** of leg 3. Jump 2 then landed at
   (30720,38400), floor 8000, 241 units from declared (30480,38384).
   The new post-settle landing check stopped there. No node interaction.

Both trials ended with health 20/20, mana 41/41; administrative rescue to room 52
was outside the measured approach. Neither proves a walking escape.

### Historical defect: `ancient_wall399_landing_clearance`

Wall 399 is impassable at x30464, y37888..38912. The declared fine landing is
only 16 client units east of it, inside the body's 248-unit wall clearance.
From (30736,38432), a 64-unit trace toward (30480,38384) slides against wall 399
instead of reaching its aim. See `ancient-wall399.json` and the second jump receipt.

Next experiment: cut a walk on the actual 8000 shelf south of the landing,
measure clearance beyond y38912, and test the existing third declared fall from
a reachable takeoff. Do not loosen landing tolerance to declare the current fine
point reached. The keeper currently reuses the declared fine landing even when
the caller perturbs the destination square; such a perturbation alone is not an
independent landing test. A corrected declaration needs live evidence and a new bake.

Follow-up offline measurement: all twelve 64-unit steps from the actual landing
(30720,38400)/8000 to (30720,39168)/8000 arrive. From there, the falling trace
toward the existing third landing (30320,42000)/4800 is clipped by **wall 407**:
actual trace endpoint (30326,40938), ground floor 3200, `arrived:false`.
See `ancient-south-wall407.json` and its adjacent `ancient-south-audit.mjs`.
This is a model experiment, not another live trial. The next test is a clearance
audit around wall 407 from that reachable southern shelf, followed by one bounded
shadow replay only if a declared landing can be supported. No height-gaining jump
or widened landing tolerance follows from this result.

Recipe: `node-trial node=ancient room=579 row=38 col=74 route=rail
exit=edge:589:r38c74 quiet=true`. Run via FleetScript, never direct admin placement
in the middle of its route. `m59-ground` exact-point trace and
`m59-railfollow-test` retain the measured quantization/landing regressions.
