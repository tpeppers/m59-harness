# Convoy queues in ordinary movement

Native `Session.step`, `walkTo`, `walkFine` and checked rails share passage
admission through `m59-passage-admission.mjs`. It is enforced immediately before
an ordinary paced movement packet is sent, after collision and target guards.
No Brax map number or FleetScript is required for ordinary fleet traffic.

## Entrances and ownership

The geometry detector groups connected one-square-wide cells into passages,
including a single-cell neck with two collision-proved, returnable openings. A one-ended wall pocket remains
a destination. Published fine chokes augment coarse geometry where necessary and own their immediate
approach, so a second adjacent coarse gate cannot block an incumbent between tickets.
Adjacent open cells outside a passage identify its entrance mouths. Ordinary
keepers with positively known roster identities share an inferred flow for the
same entrance; entering from the opposite mouth remains conflicting traffic.
Explicit checked-rail convoy flows retain their declared membership and destination,
with entrance direction checked separately.

`crossingAdmissionConflict` in `m59-crossing-queue.mjs` is the common admission
rule. At most one entrance packet can await native confirmation. A predicted
position does not open the next ticket. Once the owner observes its body inside,
a following member of the same flow can enter through the newly available gap;
the predecessor continues walking. Opposing flows wait until every incumbent
has a confirmed exit. No timeout evicts a live owner. A visible player without
matching confirmed admission remains an obstacle, even when its name is in the
roster. Strangers, human occupants and unknown flows are never assumed clear.

Passage occupancy includes a conservative 16 protocol-unit body margin. A
confirmed foot point just outside a cell can still overlap its curved neck;
that body retains ownership until it fully clears. Reentry into the same held
zone does not require a second ticket. New entrants reserve before their body
reaches the margin, and unknown overlapping occupants still block entry. The
captured room826 case at `x=2058,y=1207` to `x=2072,y=1216` exercises this in the
real Session/collision fixture: the leader clears rather than waiting on its
followers behind it.

Checked rail telemetry retains the last eight fine-walk refusals, including
passage admission, so a generic step-budget failure keeps its underlying cause.

The same state is shared atomically across keeper processes using the existing
fleet/server spot-claim namespace. Records carry entrance, flow, character and
`entryPending`; updates preserve ownership. Existing script crossing journals
keep their historical directory name so rolling versions cannot split live locks.
Do not delete a live claim to unblock a queue.

Service startup reconciles ephemeral wall, passage and participant records
before new keepers can reuse old PIDs. A batched OS start-time read can prove
that a record predates the process now holding its PID. Cleanup queries outside
the mutex, then rechecks the exact unchanged record under lock. Live and unknown
ownership stays protected. Retained traversal receipts keep their separate
confirmed-exit contract and are excluded from this cleanup. The native Brax
qualification exposed a recycled PID belonging to a different shadow character;
its stale passage record was removed using this proof, without moving a body.


## Keep the line

`lineQueuePredecessor`, `planStraightQueueAdvance` and `queueLineGuard` in
`m59-rail-traffic.mjs` use named protocol-fine coordinates. Ordinary narrow-passage
walks recognize fleet predecessors, advance only through a collision-proved clear
prefix, and wait when the next square does not fit. They do not thread sideways,
learn the blocked square as bad terrain, or treat that convoy as opposing traffic.
The fine walker can use a partial prefix; the square walker waits for its complete
next square. Unknown geometry, predicted origins and missing clearance refuse.

Checked rails with `stayInLane` retain that line even when an NPC blocks it.
The paced endpoint guard rejects a collision slide away from the selected line.
Open-ground routes and non-strict queue paths retain their existing checked NPC
and body detours. This distinction lets a constrained shelf remain a line without
turning every open field into a single-file road.

Queue waits remain bounded by the caller's movement budget and retain ordinary
cancellation, casting, survival and room-change checks. Traffic refusals carry
`traffic: convoy_queue` or `passage_admission`, with predecessor/zone evidence.
They yield promptly rather than manufacturing a movement success.

## Verification

`m59-convoy-traffic-test.mjs` covers 25 ordinary fleet members without a script
convoy, single-cell necks versus wall pockets, opposite entrances, predicted
positions, unknown incumbents, raw name resources and independent OS-process
races. Its actual Session/collision fixture walks the one-square corridor in
Western border of the Twisted Wood (587), proves fine and square walkers retain
their line, then resumes after the predecessor clears. Existing Castle Victoria,
doorway, takeoff, region and survival regressions exercise the shared callers.
Run `npm run test:movement` before publishing a movement change.

These are offline geometry, scheduling and packet-boundary tests. They do not
establish a new live fleet travel-time percentile or deploy the code to production.
