# Item sell-value estimates

`node tools/m59-item-value.mjs "red mushroom" --quantity 12 --merchant normal`
is an offline lookup; it never contacts a merchant or sends a game command.
Import `estimateItemSellValue(name, options)` for the same structured result.

The default normal merchant pays 70% of `GetValue`. The complete source-defined
tiers are flat 100%, bargain 90%, discount 80%, normal 70%, expensive 60%, ripoff
50% (`kod/include/blakston.khd`, MERCHANT_*). `Monster.Offer` in
`kod/object/active/holder/nomoveon/battler/monster.kod` applies that discount to
each offered object/stack, truncates the integer, then clamps it to at least one
shilling. A stack is multiplied BEFORE the discount and truncation. An empty
quantity estimates zero; separately offered objects must be quoted separately.

Default values come from the checked-in `substrate/m59-values.json` reference
catalog. Unknown names return null, not zero; decorated item names are not
silently mapped to ordinary gear. Without condition data the estimate assumes
reference condition and no unknown item-attribute price adjustment.

For one non-stack item, `condition: {hits, maxHits, originalMaxHits}` implements
the integer durability calculation in `Item.GetValue` (`kod/object/item.kod`).
It does not infer hidden condition or run magical attributes' `AdjustPrice`.
If a caller already knows the total object `GetValue`, pass `getValue` instead.
`NumberItem.GetValue` (`kod/object/item/passitem/numbitem.kod`) is stack size
times initial unit value.

`itemSellValueRule` exports the reference unit value and a rational discount for
native clients; `applySellValueRule` is its reference evaluator. This keeps the
merchant policy in the harness, not copied as a second table into a UI.

These are sell estimates, not shop purchase prices: `Monster.GetPrice` has a
different markup and faction calculation. An NPC must also accept the item and
use the standard offer method. Bank storage, robbers, special gifts, signet
returns, and custom offer methods are not guaranteed by this estimate. Money
already in the purse should be shown at face value, not as a merchant sale.

Tests: `node tools/m59-item-value-test.mjs` (fully offline).
