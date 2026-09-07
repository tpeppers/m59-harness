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
