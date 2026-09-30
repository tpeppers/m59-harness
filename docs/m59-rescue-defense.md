# Rescue defense experiments

## Round 005: timed relay and shield reset

The objective is to interrupt conquest, including when the first arrivals cannot
win the fight. At 8:00, Floyd and Bunsen use their 3/3 chalices, then gift them
through the ordinary offer/counteroffer/accept protocol to Janice and Statler.
The recipients drink too. All four await Rescue without attacking. Both chalices
retain one charge; the last charge is unusable and queues the existing refill errand.
The other sixteen runners receive orders immediately, with zero launch spacing
in this round. Departure and coarse-position motion events are sampled at 500ms.

Two foyer arrivals proceed through the first two doors and park separately in
the corridor. At or after 8:00, four staged bodies breach. If travel fails, the
quorum drops to two at 9:15 and one at 9:30. Every responder, including Floyd,
first tries to reach an unoccupied square adjacent to the lever and raise it.
They can be attacked throughout. A sacrifice is allowed; survival is still
reported separately. Late arrivals join the established breach.

Native `GuildLever.LEVER_RANGE` is **one** square, not three. Raising the shield
deletes `ptConquer`; a subsequent successful raider lowering starts a fresh
ten-minute timer. The attackers contest through ordinary actions, walking back
to the lever if necessary. Ownership held at the fifteen-minute horizon with
living raiders is unresolved, not a win.

The native handoff probe confirmed one player using and then trading a chalice
while its player-owned Rescue timer remained active. The second player used it,
both reached hall 714, water went 3→2→1, and the harness refused the final charge.
Recipients must not already hold a chalice: native transfer can merge or refuse
chalices. A failed or uncertain handoff is not retried blindly.

Across valid rounds 000, 001, 003 and 004, only 10 of 76 road responders arrived
before conquest. Their successful-only median was 7:05.5, with fastest 5:47.0.
The fleet median was not reached in any trial. This pooled number mixes controller
versions and excludes failures; it is **not** a fleet travel ETA. The initial
orders spanned 6–38ms after activation; first castle exits took 28.7–32.1s and
successful departure medians 48.1–52.8s. Use the new metrics tool to retain the
non-arrival denominator and distinguish dispatch, release, departure and arrival.

## Follow-up after round 005

Round 005 completed with a native shield reset at 9:02.1; Floyd died at 9:06.2.
Eight of sixteen road responders and all four Rescue responders reached the
foyer by fifteen minutes. This was unresolved, not a victory. Combat ownership
blocked attacker lever actions until the first defense group died, and also
stopped later defenders' lever runs. The report is useful evidence of a reset
and the relay, but does not establish retention against working opposition.

### Round 006 changes

Both teams now explicitly yield combat ownership for a short lever objective.
Automatic retaliation is deferred during that operation, while incoming native
damage remains active; the exact prior eligibility policy is restored afterward.
The battle controller also yields while that actor owns the lever operation.

Wait for every living Rescue responder to reach the corridor before the first
four-person-or-larger breach, retaining the 9:15/9:30 emergency deadlines. This
avoids releasing Floyd with only the first road arrivals while his Rescue partners
are still behind the doors. Runners now launch one second apart (0–15 seconds).
This round combines fixes and pacing, so it cannot isolate the effect of spacing.

## Historical policy: rounds 002–004

Round 002 stopped at a client room-transition observation error and is invalid.
Round 003 repeats this strategy after adding a guard for the interval between
the room packet and the player-position packet. No tactical threshold changes.

Round 003 completed: Camilla reached the foyer at 5:47.0; both chalices added
responders, for five hall arrivals. Floyd finished at 45/45 HP and both cups
retained 2/3 charges. The hall fell at 10:05.3. Two door approaches ended during
collision-geometry updates, leaving only two fighters staged; nobody breached.
There were no recorded deaths. This improves response and survival, not retention.

Round 004 adds bounded passage recovery (six attempts, ninety-second deadline)
and distinct corridor waiting squares that clear the door landing. The native
five-body probe reproduced the animation interruption, then got all five to
their assigned squares and all four fighters through the final door while the
reserve stayed outside. Collision validation remains authoritative; an interrupted
walk is replanned rather than allowed to continue on obsolete geometry.

### Earlier objective and roles

Recover the owned Bookmaker hall (714) after two weaponcraft masters start inside
and lower its shield. All twenty defenders start upstairs Castle Victoria (39).
Keep the captured skills and prepared equipment from round 001. Give **Floyd
(t16)** and **Bunsen (t5)** one Chalice of the Rain each, explicitly initialized
at **3/3 charges** for this counterfactual. The other eighteen respond on foot.
This is an isolated native Simulator scenario, not a production order.

1. **Wait to cast.** Floyd and Bunsen wait upstairs until the first road responder
   actually reports reaching the hall foyer. This conservative trigger avoids
   trusting an ETA across unreliable road crossings. Neither attacks while Rescue
   is pending. An interrupted/uncertain cast is never automatically repeated.
2. **Gather before fighting.** A second runner plus both Rescue arrivals releases
   the group through the first two doors, to the corridor before the final door.
   Four combatants must physically reach that corridor before the breach. Floyd
   and the two dedicated lever guards do not count toward that quorum.
3. **Keep Floyd in reserve.** Floyd holds in the corridor until both attackers
   have died. This removes his dangerous road journey and avoids offering the
   lowest-HP defender as the first combat target. He can then help restore the
   shield. His survival and the hall's survival are separate success measures.
4. **Fight together and restore the shield.** The combat group focuses the first
   master, then the second. Bunsen approaches the lever and attempts to raise the
   shield before joining the fight. Lew and Scooter are backup lever guards.
   Late responders join the breach once it has begun.
5. **Account for resistance.** Masters hold the inner chamber, attack the lowest
   current-HP defender physically inside it, and may lower the shield again
   through ordinary activation. A defender is targetable while approaching the
   lever, even before its own combat controller starts.

Four fighters is a test threshold, **not an established winning force**. Earlier
trials established that eighteen prepared fighters can win, and that sequential
arrivals die; they did not prove four sufficient. If fewer arrive, this policy
holds its formation and can lose the hall without breaching. Test that tradeoff.
The fifteen-minute horizon allows a shield reset to be observed; surviving
ownership with live attackers at timeout is unresolved, not a victory.

This formation assumes the attackers hold the inner chamber. Doors are a staging
boundary, not guaranteed safety against raiders that open them and pursue.
All controllers share one process; production keepers run in separate processes.
No scripted invulnerability, wall crossing or runtime admin relocation is used.

## Inventory-dependent travel

`Session.travel` considers a conditional Rescue shortcut at room boundaries.
An expendable held chalice takes priority. Otherwise a learned Rescue, an emerald
and at least 16 mana can provide the candidate; known karma below 30 excludes
the spell. Native eligibility, casting chance and restrictions still apply.
The room graph itself is not changed.

The native destination is selected when Rescue completes: an owned same-region
guild hall first, Ko'catan Inn or the Pool of Vigor where applicable, otherwise
the home bind. Bookmaker Rescue arrives in the **foyer**, not at the lever.
Guild membership is checked through the player protocol. Configured hall
ownership/home bind remain operator assertions; the executor verifies the actual
landing and replans if it differs.

Loadout policy keys (inside the existing `policy` object):

```json
{
  "rescue_travel": true,
  "rescue_hall": 714,
  "rescue_guild": "The Second Swines",
  "chalice_recharge": true
}
```

Set `rescue_home` only when the home room is known. Guild precedence still wins.
The simulator supplies its temporary guild name, not the production name.
The cost estimate is deliberately simple: a 25-second Rescue allowance plus
20 seconds per remaining room, compared with walking hops. It is a candidate
ranking heuristic, not an ETA promise. Confinement, barred destinations and
hard hazards still constrain the shortcut/detour.

## Preserve and recharge

Automated Rescue never spends the final chalice charge. Ordinary LOOK descriptions
are intervals, not exact counts: “few sips” can mean one of three charges.
Use is permitted only if **every count consistent with the observed description
and local usage history is at least two**. Unknown descriptions fail closed.
Repeating Use while Rescue is pending wastes water on the native server, so a
pending/uncertain operation is latched against automatic recasting.

A one-charge or ambiguous-reserve chalice creates `chalice_errand` in keeper
status. On travel, the planner may use a qualifying room on the route or a detour
of at most two extra room hops. It defers dropping near players/attackable
objects or during combat. It drops and retrieves the exact item, verifies it is
held and full, and only then clears the errand. An unconfirmed pickup keeps an
item/room receipt and pauses this travel for recovery.

The terrain catalog is generated from native KOD inheritance, not room names:
`GetShalilleBonus > 20`, hence forest/jungle terrain. Mountain/swamp at 20 does
not qualify. The KA0 offering room is excluded because it consumes drops.
The catalog records its source revision and contains 73 rooms. Example: forest
H7 (587). Regenerate using `node tools/m59-rescue-catalog.mjs <M59_ROOT>`
when the server source changes. Dropping exposes the item briefly; this is why
refilling is deferred during threats and is not part of the urgent defense.

## Evidence and rounds

Research: `C:/code/m59-research/reports/chalice-of-the-rain.md`, checked against
native source revision `1fb1f51478d14a2a7fa37a2bb5899899c0115c44`.
Key sources: `kod/object/item/passitem/chalice.kod`,
`kod/object/passive/spell/rescue.kod`, and native room terrain/teleport code.

The acceptance probe exercises ordinary travel selecting Rescue, a 2-to-1
charge use, refused final-charge use, ordinary forest drop/pickup back to 3/3,
and learned Rescue with an emerald. Privileged operations only establish
separate test fixtures; the observed actions use player packets. Native item
properties are read afterward for evidence, never used by the travel planner.

Offline checks cover uncertain charge bands, interrupted/uncertain casts,
wrong destinations, resource requirements, pickup failures, travel integration,
and formation gates. The full round preserves native reports, check-ins,
console and runtime evidence under the [round workflow](m59-guild-defense-rounds.md).
Record arrivals by road/Rescue, corridor and inner arrival, shield changes,
Floyd HP, casualties, remaining charges and cleanup. Attach the outcome to the
exact tested commit with Git notes; do not rewrite that commit.

## Ported onto main, 2026-09-30 — what came and what did not

The branch `codex/guild-hall-defense-plan` was 456 commits behind main when this was ported.
Everything it ADDED came over unchanged: the controller, the Simulator, rounds and metrics,
the door and assembly probes, `m59-rescue*.mjs` and the terrain table. So did its lab-only
hooks in `m59-replay-players.mjs` and `m59-shadow-replay.mjs`, and the ceiling-door step-mask
fix.

**The Rescue-travel integration was NOT ported.** That is the `rescueTravelOption` hook in
`Session.travel`, the `rescueContext` set by `Autopilot.travel`, the `rescue_*` loadout keys,
and their travel-test cases. Main has since grown its own chalice system (`m59-chalice.mjs`)
and guild-hall exit (`exitGuildHall` in `m59-session-walk.mjs`). Merging both would have left
two independent ways out of hall 714 inside the movement core. The branch's own commits also
carried `Release-Hold: ... travel policy; not approved for production deployment`.

**What that changes in the Simulator:** `performRescue` relays still run, because the sim calls
them directly. The mid-journey chalice RECHARGE detour does not run, because it lived in the
travel loop. The `rescueContext` the sim sets is now unread. A round from this tree is
therefore not comparable with rounds 001-00x recorded on the branch without saying so.

**The production play is not this Simulator.** It uses DM powers (`place`, stat rewrites)
that FleetScript refuses on a non-lab fleet. The prod version is the private repository's
`strategy/pvp/pvp-hall-defense.mjs`: muster in 39, wait for a quorum, go in together, and let
the war response (`tools/m59-war.mjs`) do the fighting.
