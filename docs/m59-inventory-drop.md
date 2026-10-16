# Confirmed inventory Drop

The C&C Quartermaster's carried-item menu offers Drop separately from persistent
sell/vault/equipment intentions. A confirmation binds the exact fleet, broker,
agent, character, player object, inventory decision revision, item ID/name and
observed stack quantity. Stacked items choose 1..observed quantity; a single item
requires a simple Okay/Cancel. Cancel is local and sends no RPC.

`POST /drop` uses the existing loopback-only, no-Origin, capability-authenticated
inventory service. It rejects stale observations, possessed characters, changed
decisions/counts and concurrent item actions. Each confirmation is consumed once.
It does not modify saved intentions or invoke a sale/withdrawal.

`dropOnce` acquires one 15-second commander lease, revalidates, calls
`inventory_drop` once and releases in finally. Failed releases expire; failed or
uncertain drops are never retried. Other characters and DUM settings are untouched.
Busy/possessed characters are refused rather than commandeered.

The broker validates its generation/fleet, exact saved character and endpoint,
current room and lease. It deliberately skips automatic stale-ID substitution for
this endpoint. Keeper-backed drops use `rts_inventory_drop_intent`; the verified
target keeper must advertise `inventory_drop: 1` in its existing `/live` proof.
Old keepers refuse without receiving the mutation. Core changes require the
normal qualified keeper handoff or natural replacement, not strategy hot loading.

`executeExactDrop` checks again inside the pacer callback: deadline, player,
room/endpoint/lease, exact item name/resource/translation and stack count. It sends
one native drop packet using `dropSpec` (including a number-tagged stack of ONE).
It never automatically unequips an item. The game server retains the final say.
An active background job is not cancelled to make room for a drop.

Only an observed pack reduction/removal while still bound is confirmed. A timeout,
disconnect or absent update is unconfirmed, not success; inspect pack and ground
before issuing a new confirmation. Sender exit 12 communicates this; exit 13 means
the helper/broker capability is unavailable and no drop was sent.

## Traffic and tests

Opening/cancelling the menu adds zero broker/game reads. Confirmation uses the
existing helper authentication/health read, three RPCs (lease acquire, drop,
release), existing keeper ownership proof and one paced game packet. Observation
waits up to two seconds for passive pushes; no inventory, equipment, stats or look
query is generated. Existing integration diagnostics account for these requests.

Offline tests (use M59_CNC_PERF_LOG=1 and M59_PERF_LOG=1):

- `node tools/m59-inventory-drop-test.mjs`
- `node tools/m59-inventory-drop-service-test.mjs`
- `node tools/m59-inventory-drop-routing-test.mjs`
- Existing inventory intent/service/storage and tactical-routing tests.

These tests use disposable inventories and mock HTTP; no live item is dropped.
