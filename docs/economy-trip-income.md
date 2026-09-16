# Farming income on the economy page

Each character has a **farming shillings/hr — last town trip** column. Expand its
row to see the completed trip's date, cycle duration, starting and ending cash,
recorded vendor sales, purchases and other cash changes.

The rate is `(ending purse + bank - starting purse - bank) / elapsed hours`.
Boundaries are consecutive **completed native keeper town service circuits**.
Elapsed time includes farming, recovery, travel, shopping and offline time, so
extra town trips carry their time cost. This is realized cash return, not just
combat income or a valuation of everything collected.

Bank deposits and withdrawals cancel out. Purchases, cash lost on death and cash
guild contributions reduce the result. Gifts and manual transfers also change
it. Unsold loot and items put into guild storage have no assumed shilling value.
Vendor/purchase receipts are supporting detail; any other cash change is shown
separately instead of being guessed to be monster loot.

The first completed trip establishes a baseline. A rate appears after the next
completed trip with known purse and bank balances. Unknown balances, changed
bank account coverage or invalid durations show a reason rather than zero.
Historical town-trip boundaries were not recorded, so no historical rate is
invented. Partial merchant stops, survival interruptions and deferred shopping
do not close the cycle or replace its last completed result.

The keeper atomically saves a small per-character record under the selected
fleet's `history/<fleet>/town-income/`, and writes each completed summary as a
`town_trip_completed` ledger event. These runtime files are gitignored. Records
survive keeper restarts and are independent of the page's date filter. No
additional game commands or decisions are introduced.

Offline checks: `node tools/m59-town-income-test.mjs` exercises cash accounting,
missing evidence, persistence, fleet isolation, interrupted service completion,
and the economy report and HTML. Existing economy, reagent income, town-run,
town-stop and purchase-funding suites cover the surrounding behavior.
