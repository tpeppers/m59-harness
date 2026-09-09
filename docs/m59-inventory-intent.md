# Shared inventory sell plan

This is item-specific local metadata, shared by bot policy, the C&C viewer,
and an opt-in patched Meridian client. It sends no game orders.

AI recommendations enter the next-town sale queue automatically. An operator
click on a queued item means **keep**; another click means **sell**. Explicit
operator decisions beat later AI suggestions. Equipped items, money, unknown
equipment state, configured reserves and protected items remain guarded.
The queue does not start a town trip or perform an immediate sale.

The normal merchant workflow consults the plan, then checks veto/possession
again inside the paced accept callback. A veto can cancel a pending quoted
sale until acceptance is actually sent; it cannot undo an accepted sale.
Keep means "do not sell", not a prohibition on every possible use/transfer/drop.

## Runtime

    node tools/m59-inventory-intent-service.mjs --fleet <fleet> --broker-root <running-checkout>

This binds only 127.0.0.1:8913. It reads broker health and pilot status, never
game action endpoints. Start only one service per runtime directory.

- M59_INVENTORY_INTENT_DIR selects shared local state; the default is this
  checkout's ignored substrate/inventory-intent/. All participating processes
  must resolve the same directory. Never commit its token, reports or decisions.
- Keepers publish their existing town-sale policy assessment. The service
  binds it to roster, broker identity, character object ID, and current room.
- Possessed clients publish fresh inventory to clients/<pid>.tsv.
  Only a broker-claimed, matching live pilot is accepted. Assessments survive
  the login gap; new pickups await bot assessment unless explicitly marked.
- views/<pid>.tsv supplies native badges: green **$** queued, blue **K** kept,
  amber **$** requested but protected. Views expire after six seconds.
- viewer.tsv supplies C&C inventory plans. Possessed inventory is display/
  metadata only; it does not grant bot movement, equipment or combat authority.

The native module needs M59_INVENTORY_INTENT_DIR, or derives its sibling
directory from M59_OVERLAY_DIR. dev.bat records the original endpoint in
M59_INVENTORY_SERVER before proxy routing. No proxy is required for badges.
Existing native clients must be reopened after installing the rebuilt module.

## AI/operator integration

Read GET http://127.0.0.1:8913/plans for fresh identities, items and revisions.
Then import sendIntent from tools/m59-inventory-intent-send.mjs and call it
with viewer:false for a local harness caller:

    await sendIntent({
      fleet, broker_pid, agent, player_id, character,
      item_id, item_name, revision, clicked_at: Date.now(),
      source: 'ai', state: 'sell', reason: 'surplus for next town trip'
    }, {viewer: false});

Use the exact fields from the latest plan, not a guessed ID or name. States
are sell, keep, or auto (clear the explicit decision). source:'operator'
sets a veto/override; AI cannot clear it. Changes use an exclusive writer lock
and revision comparison. Refresh after a conflict. Do not print service.json:
the helper reads its local authentication token internally.

C&C uses the same helper with additional session and installed-DLL attestation.
Its launcher must explicitly pass M59_INVENTORY_INTENT_DIR and
M59_INVENTORY_INTENT_HELPER; inherited unrelated M59 settings stay stripped.
Click without $ mode inspects. In $ mode, clicking a whole stack toggles its
sale designation. Right-click cancels the mode.

Decisions bind server, account, character object ID, item object ID and exact
name. They are not a rule for every future item with that name. Corrupt intent
state holds sales rather than silently discarding a veto. A crashed writer's
lock is left for inspection, never automatically removed from under a writer.

## Offline checks

    node tools/m59-inventory-intent-test.mjs
    node tools/m59-inventory-intent-service-test.mjs
    node tools/m59-inventory-sale-race-test.mjs
    node tools/m59-selling-test.mjs
    node tools/m59-devclient-test.mjs

These use isolated fixtures; no live sale is needed for verification.
