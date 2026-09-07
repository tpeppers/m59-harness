# Production slow stall: routing and town completion

Operator correction: Ukgoth (599) has an eastern **entrance**, not an eastern
exit. The directed block 599 -> 598 in `m59-oneway.json` must survive geometry
rebakes. A boundary point in a baked artifact does not establish a usable route.

Castle Victoria's north-east room exposed another false shortcut. From the live
protocol position `{x:2224,y:275}` (r4c34), the coarse planner promises the front
door at r16c19, but fine collision search cannot walk there. The internal door
at r8c32 is reachable and transfers the character to r10c32. In rooms with
internal doors, `sameRoomDoorPlan` now checks the direct route from the actual
fine position before deciding that no door is needed. Square-only planning
fixtures retain their earlier contract.

`sell_all` now supports bounded offers through `max_offers`. Each response has
confirmed inventory removals, refused names, and `more`/`resume` when work
remains. Continue with the same merchant and protection policy plus `resume`.
The keeper holds its ordinary job slot during a sale, so travel cannot overlap
an unfinished sale after an HTTP client times out. A non-stackable inventory
object has `amount:0`; it counts as one item, not zero.

DUM controls the merchant sequence and consumes those continuations. Its former
30-second response timeout could abort the sequence while the keeper continued
selling, then dispatch the character to the feast hall with cargo still aboard.
Fuel circuits must finish selling and clearing cargo before food collection.

Vault fees also need an explicit outcome: Pepe's first vault visit refused five
nerudite arrows for lack of 20 shillings. He then earned 641 from the three
shops and banked it, but the old empty giveaway keep-list dropped those arrows.
DUM now preserves its keep/vault list at cleanup and retries the vault with
sale proceeds before banking. A trip to a counter alone is not a deposit.

Do not describe `larder_vigor` as a meal count. For example, 117 vigor worth of
slice of pork is 13 slices at nine vigor each. Rizzo reaching the hall with his
old unsold cargo verified only the hall door and dispenser, not a town circuit.

Offline regressions: `m59-ukgoth-oneway-test.mjs`, `m59-innerdoor-test.mjs`,
`m59-keeper-sale-test.mjs`, and `m59-navgeom-routing-test.mjs`.

Follow-up live checks found a Blackstone Keep loop at r10c15. A bounded fine
search to one distant exit failed, and the planner repeatedly chose a portal
whose landing was already reachable on foot. Internal-door plans now exclude
that first crossing. The executor checks cancellation after each awaited
operation and requires movement caused by `go`, rather than proximity to the
landing, before reporting a crossing. `m59-innerdoor-crossing-test.mjs` covers
cancellation and a silent refusal.

Singleton quantities also matter at the vault and the street. A carried scroll
or wand reports `amount:0`; it must be deposited by object id, not as a stack
of zero. Deposits and drops now count an unchanged singleton as one remaining
item. Vault refusals are tracked per object, including duplicates and partially
deposited stacks. See `m59-vault-test.mjs` and `m59-dropall-test.mjs`.

Faronath exposed an intermediate stand point that fine collision cannot reach
(r36c12), while the route's following point at r36c11 is reachable from the same
body position. The local fine detour now searches up to four points ahead within
one shared node budget, rejoins only after an observed arrival, and never skips
a declared fall. `m59-fine-detour-test.mjs` checks the live geometry.

A numbered stack needs an explicit offered quantity even when only one remains:
`UserOffer` consumes `number_list` for every `NumberItem`. The keeper's sale
regression now sells 51 gems as 25 + 25 + 1. Rizzo's initial tagged run exposed
the missing final quantity; a refused last gem is not a completed stack sale.

The upstairs go squares are doorway pockets too. From Castle's southern room,
the body can reach r3c19 beside the stairs, although fine search cannot occupy
the modeled center of r2c19. The internal-door planner now proves reachable
approaches to a published go exit; otherwise it incorrectly sends the body back
into the northern room. The live north/south positions are both pinned by
`m59-innerdoor-test.mjs`.
