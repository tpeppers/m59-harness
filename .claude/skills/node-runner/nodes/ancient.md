# Ancient Place — room 579, r52c30

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

### Current defect: `ancient_wall399_landing_clearance`

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

Recipe: `node-trial node=ancient room=579 row=38 col=74 route=rail
exit=edge:589:r38c74 quiet=true`. Run via FleetScript, never direct admin placement
in the middle of its route. `m59-ground` exact-point trace and
`m59-railfollow-test` retain the measured quantization/landing regressions.
