# Shadow Rift — opening a prism portal with a group (`shadow-rift`)

`tools/fleetscripts/shadow-rift.mjs` casts the Qor multicast spell **Shadow Rift** with a group of
characters: it gathers them round a prism in one room, pools the reagents they need, dresses one
**primary** for the highest spell power the group can give it, feeds everyone to 200 vigor, and has
the primary chant almost all of the 1500 power on its own while the others keep its mana up with
**mystic touch**. When the prism is charged (or the primary is about to run dry) the remaining
seats join, which gives the prism its symmetry and fires it.

The mechanic — what a join costs, how fast a chanter charges, what breaks a chant, which rooms
refuse a portal and which are easy — is `m59-research/reports/shadow-rift.md`. The script cites
it by section; read it before you change anything about the ceremony.

## Running it

```bash
node tools/m59-fleet-repl.mjs --fleet <fleet>
> dry shadow-rift agents=a,b,c,d room=<room>        # plan only; nothing is sent
> shadow-rift agents=a,b,c,d room=<room>
> shadow-rift agents=a,b,c,d room=<room> primary=c  # a named primary instead of the strongest
> shadow-rift agents=a,b,c,d room=2009 square=r15c15 hold=true
```

`room` is required: it must allow player portals (not an inn, a guild hall, any no-combat room,
a boss or puzzle room; the report's **Easy rooms** table lists legal rooms without spawns). Every
member walks there from wherever it stands, so the run can be started with the group scattered.

Every member must know **shadow rift** (Qor 4) at **karma -40 or lower** to be a caster; Qor 4
is refused silently above it, with no mana spent. Members who know **mystic touch** refill. A
3-sided prism needs three distinct casters.

## What it does, in order

1. **Plan** (one survey for the whole run): who can cast, who can refill, how many dark angel
   feathers, inky caps and plain mushrooms the group holds and needs (4 feathers a join; sides
   joins plus `spareJoins` and `spareSeats`), and where the shortfall comes from.
2. **Source**, in order: the members' packs, each member's **own vault** (`vaults=true`; Obert
   114 on the mainland, Itzal 2005 on the island, from the cached vault reading), the **guild
   halls** you name (`halls=`, mainland only, none by default), then a plain-mushroom seller by
   region (or `mushroomShop=<room>:<seller>`). Every lot is re-counted; a lot that moves nothing
   ends that source. A draw checks the drawer's free bulk first.
3. **Gather** beside the prism, on a ring of squares round it — never on the prism's own square,
   where the portal opens. If a member carries the prism it walks to `square` and drops it; a
   prism held by someone outside the run is never commanded, the run waits `prismWaitMinutes`.
4. **Share** feathers, inky caps and mushrooms by verified hand-over; seats are whoever actually
   holds 4 feathers afterwards.
5. **Dress the primary** from the pooled gear (mace, a Qor disciple robe, the best shield, the
   circlet last for max mana), **eat to `vigorTarget`**, and pre-fill its mana.
6. **Validate every seat and forecast** before any feather is paid: will the donors' sustainable
   refill keep the primary chanting until the charge completes? It chooses `solo` (seats at the
   end), `together` (the whole circle at once), or refuses (`force=true` overrides).
7. **Chant**: the primary casts once; one loop per donor touches whenever a touch would not be
   wasted; the seats come in when the prism is charged, or early when the primary's mana trend
   says it will run dry first. A join is decided by the keeper's own enchantment reading, not by
   the cast reply.
8. **Report**: the portal (or the bind), where the prism leads, every touch and join. Nobody
   walks through.

Each chanter's cast role (`substrate/cast-roles.json`) is set to `rift` for the ceremony so no
cast-gear strategy re-dresses it mid-chant, and put back afterwards, also on process exit.

## Stopping it, and skipping a wait

The control files live in `logDir` — `substrate/logs/` by default (gitignored), or
`M59_SHADOW_RIFT_LOGS`, or `logDir=<dir>` on the command line.

| file | effect |
|---|---|
| `shadow-rift.stop` | the run stops at its next check. Delete it before the next run. |
| `shadow-rift.next` | **start next now**: the CURRENT wait (gather, prism, vigor, mana pre-fill, Qor hour) ends at its next check and the run moves on. The file is consumed, so one touch skips one wait. |
| `shadow-rift.events.log` | one JSON row per plan, eat, seat check, forecast, join, touch and result. |

## The hold end state (`hold=true`)

A portal stays open only while somebody stays in its room. With `hold=true`, once the portal
opens every caster is put on an ordinary autopilot order confined to the room — `mode: survive`,
roam off, town trips off, panic and break-out logoffs off, survival otherwise on. It is an end
state, not a timer: release it with an ordinary autopilot order when the portal has done its job.

## Parameters

| param | default | |
|---|---|---|
| `agents` | required | the group |
| `room` | required | the casting room |
| `primary` | `auto` | `auto` = the highest achievable spell power in the room, or an agent id |
| `sides` | 3 | prism sides when its look text cannot be read |
| `openOnly` | true | refuse an UNBOUND prism (a bind records the spot for ever) |
| `square` | — | `rNcM` where the prism belongs; a member carrying it drops it there |
| `hold` | false | hold the portal open afterwards (above) |
| `vaults` / `halls` | true / none | sources after the packs; `halls=714,703` names up to two |
| `mushroomShop` | by region | `<room>:<seller>` for plain mushrooms |
| `orcShield` | **false** | see below |
| `dukeRank` | 1 | a Duke soldier shield's rank (not on the wire): `15 x rank / 10` sp |
| `qorHour` | -1 | Qor hour bonus override; -1 reads the game clock |
| `minRate` / `hourWaitMinutes` | 1 / 0 | wait for a Qor hour that gives the primary at least this rate |
| `vigorTarget` / `vigorMinutes` | 200 / 15 | |
| `touchAt` / `touchPct` | 0.9 / 10 | a donor touches at this fraction of its max; the starting % a touch moves (learned) |
| `forecastMargin` / `force` | 1.1 / false | how much longer than the charge the mana must last; cast anyway |
| `spareJoins` / `spareSeats` / `seatRolls` | 1 / 1 / 2 | |
| `seatLeadSeconds` | 90 | bring the seats in early by this margin |
| `gatherMinutes` / `regatherMinutes` / `prismWaitMinutes` / `prefillMinutes` / `maxMinutes` | 20 / 5 / 10 / 4 / 45 | |
| `enemies` | none | comma-separated player names; any of them seen in the room stops the run |
| `restoreRole` | none | the cast role for a member a dead run left tagged `rift` |
| `logDir` | `substrate/logs/` | the stop / next / events directory |

## The orc shield is opt-in

An orc shield is +15 to Qor (`orcshld.kod` GetBaseSpellModifier), but its `ReqUse` refuses a
wearer above karma -50, and **faction soldiers cannot equip one** (operator, 2026-11-20). On a
fleet of soldiers a fetch is a wasted 200-bulk trip, so `orcShield=false` by default: an orc
shield is then neither fetched nor planned into anyone's gear. A supreme-hero Duke soldier
shield gives the same +15 — pass `dukeRank=10`. With `orcShield=true` one is fetched from the
vaults or halls for a primary that is known NOT to be a soldier (an unread one is not), and an
orc shield already in the group is pooled only for such a primary at karma -50 or lower.

## Still unverified

Said at the top of the script, and worth knowing before you rely on it: that receiving mystic
touch does not break a chant; that nothing on a keeper pass (an `idleGear` hook) strips the
primary's gear after the keeper's 60 s cast hold lapses — the loop watches and reports it; and
whether shadow rift has a 20 s personal trance before the join.

## Tests

`node tools/m59-shadow-rift-test.mjs` — offline, the pure halves: the spell-power model with
`dukeRank` and the orc-shield gate, the rift rate, the collapse forecast, the touch size and the
no-waste rule, the -40 karma gate and the seat check, the cluster squares, and that the declared
params carry no fleet's orders (room required, primary `auto`, no halls, no enemies, orc shield off).
