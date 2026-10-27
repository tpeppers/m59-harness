# Sword of Riija quest automation

`riija-sword` completes the four island shard quests for **one prepared good-karma bot**,
verifies a finished sword naming that character, and returns control to its keeper.
It does not run on import or select a production character automatically.

## Prepare the character

- Karma **at least +10**, and neither anonymous nor morphed. The script recognizes only
  Hanla's good-karma trade assignment and Wulfgang's good-karma cargo table.
- Safe jungle travel, an accessible route and permission through Ko'catan's east tower.
- **Orc pit boss head** from an earlier party raid. The recipient need not kill the boss.
- **Chunk of nerudite**, or the feather if already on Hanla's return leg.
- **Meat pies** for a queen; keep spare pies beyond any Wulfgang shipment.
- Wulfgang's requested cargo, in one stack if stackable. Ask first if necessary; the
  script records his assignment and stops without offering an undersized stack.

The bot must be able to survive Cliff Hive and the return road. There is no raid organizer,
supply shopping loop, karma manipulation, tower bribe, evil-route shaman hunt or temple-bridge
crossing in this script. It changes no standing autopilot policy.

## Run

From the deployed harness checkout, select the actual fleet explicitly:

```text
node tools/m59-which.mjs --fleet <fleet>
node tools/m59-fleet-repl.mjs --fleet <fleet>
> describe riija-sword
> dry riija-sword agents=<bot> home=<return-room>
> riija-sword agents=<bot> home=<return-room>
```

Replace the placeholders. `home` is optional. A specified return leg is marked `always`,
so ordinary step failures still attempt it. Fatal death/recovery failure or process loss
can prevent returning home; return is not a guarantee of survival.

Wulfgang's good-karma choices, transcribed from `questengine.kod:2973–2976`:

| Cargo | Amount |
|---|---:|
| Meat pies | 50 |
| Water skins | 70 |
| Apples | 150 |
| Grapes | 200 |
| Elderberries | 350 |
| Herbs | 250 |
| Mushrooms | 200 |
| Jewel of Froz | 1 |

## Progress, failures and handback

Assignments are saved immediately in the fleet's gitignored `substrate/questbook/` directory.
Inspect them with `node tools/m59-questbook.mjs list` and `show <id>` under that fleet.
Resupply and rerun within the recorded deadline; an open assignment is reused instead of
asking the NPC to repeat a one-time instruction. The script also reads existing shard
signatures and checks each shard's ownership description. Unknown icons require the
correct server build's resource files via `M59_RSC_DIR`; identical display names are not
enough to distinguish the pieces.

An offer is recorded before sending. If no reward can be verified, the next run refuses to
send that delivery again until its server state has been reconciled. This protects cargo
after a lost acknowledgment or interrupted run; a missing shipment that was never offered
can still be resupplied and resumed normally.

Every delivery node has a one-hour wall-clock deadline. After expiry, let the server fail
the quest and accumulate one hour of logged-in cooldown, then run with `reset=true` to
discard expired local assignments. Reset refuses an unexpired local assignment and does
not change server state. The ledger is keyed by fleet and agent and rejects a changed
character identity.

The queen is selected by object ID and offered exactly one pie. Each room leg approaches
the departure, waits for that same queen within two squares, crosses through a standard
FleetScript walk, and checks her presence before further travel. Missing queens, wrong
rooms, unrecognized assignments, expired deadlines and absent rewards stop the quest.
Failed or dead queens may require a fresh capture on a later run.

Completion requires an inventory sword whose description says `Let <character> walk with
faith.` Command acknowledgments alone are insufficient. The normal FleetScript runner's
`finally` cancels pending journeys, releases keeper faculties and clears `busy` on success
or failure. No persistent farming policy was rewritten, so ordinary keeper control resumes.
Force termination or machine failure still has the runner's existing lease limitations.

The script stops after obtaining the sword. **Equip your own bound sword before crossing
the Riija temple bridge**: the server checks equipped ownership and kills an unqualified
character on the bridge (`temprii.kod:337–359`).

## Verification and source

```text
node tools/m59-riija-sword-test.mjs
```

The offline scenarios execute the real quest callbacks and resolve the actual plan against
fake game replies. They cover all good-karma shipment quantities, prepared-item refusal,
resupply/resume, exact offers, the escort plan, completion idempotence and owner verification.
They do not measure real movement, timing, combat, production lease release or jungle survival.
No live quest completion is claimed.

Game mechanics were checked against Meridian59 source commit
`fe93b6c6e4a576e7f4ff25dbf1f59cd8b6549b83` on 2026-10-27. The accompanying
[quest report](riija-sword-quest.md) covers both karma routes, acquisition and repairs.
