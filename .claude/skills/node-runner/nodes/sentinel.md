# Under the shadow of the Sentinel — room 589, r45c32

The five-node tour enters from **599**, landing at r21c43, client
`x=43520, y=20992`, floor 3104. Use inbound rail `edge:599:r18c46`.
Its initial boarding is on the same shelf, about 772 client units from the rail;
the follower skips points behind the actual body instead of walking back to the
baked anchor.

The declared fall `r35c16 → r38c19` was exercised in tour receipt
`five-node-1790621039582-09-rail-sentinel-commands.jsonl`: exact landing
`x=18976, y=38368`, floor 4800. The following walk reached the node at
r45c32, `x=31760, y=45088`, floor 5024, health 20/20. Activation returned
already bonded, with stable 65 max mana. This is interaction evidence, not a new
grant; the earlier scratch receipt recorded the original 33 → 41 grant.

The checked outbound rail is `edge:579:r43c1`, direction `to_exit`. It walks
down to r43c1, `x=112, y=43040`, floor 0. Ordinary travel then crosses west into
Ancient Place at r39c71, `x=72192, y=39424`, floor 6304. The return toward 599
is a separate, unverified question; the circuit continues west.

Evidence is under ignored `substrate/node-tours/`. These are quiet-scene trials:
hostile bodies removed and generation disabled before the measured route.
See [the tour recipe](../../../../docs/m59-node-tour.md) and its append-only
ledger for current whole-loop counts. One successful connection is not three
repeat trials.
