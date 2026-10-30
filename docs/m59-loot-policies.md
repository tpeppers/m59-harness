# Composed loot dispositions and source editing

The patchwork is intentional. Repository-owned strategies remain independent inputs;
the harness owns composition, enforcement and explanations. No existing policy file is
rewritten or migrated automatically, and no profile is assigned by installing this code.

## Declarative contributions

`tools/m59-loot-policies.mjs` reads `m59-loot-policies/1` documents. The unassigned
shape is in `substrate/loot-policies.example.json`. Register source files with
`M59_LOOT_POLICY_SOURCES`, a JSON array in low-to-high assignment precedence:

```json
[
  { "path": "C:/code/mindmap/maps/m59-harness/substrate/loot-policies.example.json", "writable": false },
  { "path": "C:/code/mindmap/maps/m59-private/strategy/loot-policies.json", "writable": true }
]
```

Paths above illustrate registration; create an intended contribution before registering
it. Registration does not discover or copy files. Broker and keepers must inherit the
same environment. The final source is `<absolute fleet-state-file>.loot-policies.json`,
a fleet-local writable overlay. Its absence preserves current behavior. A string entry
in the registry is read-only; `{path,writable:true}` explicitly enables source writeback.
The UI writes exactly the selected registered file, never synchronizes repositories,
commits or pushes. To edit a public contribution, register that exact file as writable.

Profile IDs must be globally unique. Duplicate definitions are errors, not silent
replacement. Assignments may reference profiles defined in any registered source.
Assignments in later sources override earlier assignments and produce a
provenance warning. Character names compare case-insensitively; guild scopes use observed
numeric guild IDs, not guessed membership. Null means no assignment in that scope; fleet
null inherits earlier sources. Character/guild null clears that source-composed scope and
falls back to the less-specific scope. Matching rules resolve individual → guild → fleet.
Each profile has at most one rule per canonical item name. Unmatched items use legacy rules.

Actions: `leave`, `keep`, `sell`, `vault`, `drop_town`. All except `leave` permit ordinary
pickup, overriding legacy loot-ignore and per-creature filters for that matched item.
They do not override cursed/unidentified-jewellery, broken-item, reachability, capacity,
or already-shed-item guards. Existing carried `leave` items are retained, not discarded.

`min_condition` uses the server-description bands **0 broken / 1 poor / 2 worn / 3 good /
4 flawless** and requires `otherwise`, another disposition. This is not a percentage.
Unknown condition means pickup-if-safe and retain for inspection, never the low-quality
branch. Known-condition readings are ID+name bound and expire after 60 seconds. Existing
equipment inspection supplies readings; town sell/vault services inspect pending items.

## Enforcement and limitations

The same decision is consulted by floor pickup, merchant planning, the paced sale accept
guard and vault deposits. Non-sale dispositions are protected from overfarm eviction and
ordinary pack cleanup. Guild contribution does not take items with a named disposition
to a different destination. Equipped items, required spare equipment, loadout reserves,
operator item intents, explicit protected items and guild/cargo needs still veto disposal;
the keeper inventory preview reports those conflicts. A new rule cannot silently remove
a pre-existing hard protection. Resolve its owning source through `loot_policies`.

Vaulting currently uses the existing Barloque opportunistic service: within four route
hops, respecting bans/confinement. An unavailable route retains the goods; diagnostics
state the route requirement. This version does not invent new vault routes or quantities.
Town drops run after town services, only in the explicit bank/shop/vault room allowlist,
outside combat and without a movement interruption. Inventory deltas verify drops.
Uncertain receipts are not retried within that pass. Whole-stack reserve checks may keep
more than necessary; partial-stack town disposal is deliberately not implemented yet.

Legacy-only contradictions such as vault demand plus ignore/creature exclusion appear as
`unreachable_accumulation`. A disposition that intentionally overrides such a filter
reports `pickup_override`. Disabled town trips are a warning, not an invented journey.
This is not a static proof of every arbitrary strategy hook: packet refusals, runtime
leases, reachability and other planners may still delay or prevent a desired action.

`loot_policies` MCP actions: `read`, `preview`, `save`. Saves need exact `expected_state`,
`expected_pid`, composite `expected_revision`, registered `source`, and its `document`.
The service validates the entire composition, locks the target, rechecks revision, then
atomically writes only that source. Compatible keepers must have observed the base revision.
`saved` is not `applied`: refresh and compare each keeper's reported revision. Corrupt or
missing configured sources fail closed for pickup/disposal and report an error, not legacy
fallback that might sell goods protected by the unavailable file.

## Existing JSON and JavaScript strategies: NOT LANDED

The same 2026-10-27 work drafted `strategy_sources` (`m59-strategy-source-controls.mjs`): a
broker tool that reads and WRITES registered `.mjs` strategy files, which keepers then
import. It was held back when this landed on 2026-10-30, because a lending grant is full
control by default (`m59-handoff.mjs` `toolAllowed`) and nothing withholds the tool, so a
lent token could write code that runs on the owner's machine. It is preserved on the local
branch `wip/trunk-checkout-20261030`. It needs, at least, a place in `RESTRICTED_VERBS` (or
loopback-operator-only, like the fleet page's buttons) before it is offered anywhere.

## Rollout and tests

Deploy compatible broker and keeper code through the usual verified handoff workflow;
do not start a second broker. The editor page drafted alongside it is not landed either; the
`loot_policies` MCP tool is the interface. Register intended public/private source paths on
that deployment, reload, preview, then explicitly assign profiles. No live assignment
or production file is changed by these tests:

```powershell
node --test tools/m59-loot-policies-test.mjs tools/m59-loot-policy-runtime-test.mjs
```
