# m59-harness — instructions for an agent working in this repository

Read this if you are Codex, or any agent that does not read `CLAUDE.md`. The two
files carry the same instructions; `CLAUDE.md` is the fuller version, the subject
files under `docs/` (`m59-routing.md`, `m59-combat.md`, `m59-keeper.md`,
`m59-economy.md`, `m59-guilds.md`, `m59-protocol-traps.md`, `m59-boards.md`,
`m59-operations.md`, `m59-policy.md`, `m59-boundary.md`, `m59-coordinates.md`,
`m59-tests.md`) are where the traps are actually written down, and
[`docs/INSTALL.md`](docs/INSTALL.md) is the manual with troubleshooting.

This repository lets an agent play Meridian 59 as a real player character.

## Asked to install the game and make a fleet?

```bash
node tools/setup.mjs doctor      # read this first — it says what is missing
node tools/setup.mjs all 10      # clone + build + run server, start broker, make 10 characters
```

Ten to fifteen minutes, mostly compiling. Every step is idempotent. Individually:

| | command |
|---|---|
| 1 | `node tools/setup.mjs server` — clones + builds + runs `blakserv` in Docker |
| 2 | `node tools/setup.mjs client` — finds a Steam install; **cannot install one** |
| 3 | `node tools/setup.mjs broker` — MCP broker on 8901, dashboard 8902 |
| 4 | `node tools/setup.mjs fleet 10` — creates ten characters |

## Which fleet — check this before you touch anything

A fleet is a named roster, one per server, and passing the wrong one operates on the
wrong fleet quietly. The name resolves `--fleet` → `M59_FLEET` → `substrate/fleet-default`
(one line, gitignored, what this checkout cares about) → the unnamed
`substrate/fleet-state.json`. `--fleet -` asks for that unnamed one on purpose.

```bash
node tools/m59-which.mjs      # fleet, roster, what the broker actually holds
```

Read-only, and non-zero if the broker is holding a different fleet from the one your next
command would act on. Every `/m59*` command runs it first.

## Running the broker as a service

```bash
node tools/m59-service.mjs start   --fleet prod     # detached, survives this terminal
node tools/m59-service.mjs status  --fleet prod     # up/down, pid, how many are in game
node tools/m59-service.mjs restart --fleet prod
node tools/m59-service.mjs stop    --fleet prod
node tools/m59-service.mjs logs    --fleet prod --follow
```

**Start it this way rather than by hand.** A broker started from a terminal belongs to
that terminal. One was found running with its whole ancestry dead — it had survived only
because Windows does not cascade-kill children — while its log went to a temp directory
that gets cleaned up. This gives it a pid file, a log in `substrate/broker-<fleet>.log`,
and a stop that finds it by `/health` rather than by process name.

It does **not** survive a reboot. `start` is one command; a Windows service would have
meant a third-party binary in a repository where every other tool is dependency-free.

**Every keeper is a child process of the broker** — `m59-keeper-process.mjs`, one per
character, each holding its own socket. A broker death can leave those children alive.
New broker fleet/account claims guard the exact keeper PIDs before login; a restart of the
exact same roster may atomically adopt verified guarded survivors, while a lab or copied
roster is refused. Pre-guard broker claims fail closed and use the one-time migration in
[`docs/INSTALL.md`](docs/INSTALL.md#when-it-does-not-work). Never delete a live or guarded
lock.

### The page has buttons, on the broker machine only

The fleet page carries Rejoin / Restart / Stop when it is opened on `127.0.0.1`. It binds
to every interface so it can be read from a phone, so the controls are rendered only for
loopback **and** the POST behind them is refused at the socket for anything else — a
hidden button is not a permission check. There is no Start button and there cannot be:
when the broker is down, nothing is serving that page.

### It puts back characters that fall out

The broker rejoins sessions that drop, every 45s, and restarts their keepers. This exists
because twenty-one characters once sat logged out for twenty-five minutes while the
broker reported itself healthy and holding twenty-one sessions, every one of them
answering "not in game". Three things it will not do:

- **Undo a `leave`.** Without `forget` that means "out until a restart", and it is honoured.
- **Fight a human.** One connection per character, so a click-to-play shortcut bumps the
  broker off. A character that drops again within 90s of being rejoined is read as
  contention and the wait doubles, to a 15-minute cap. To play one yourself, `leave` it
  first or use `--proxy` shortcuts.
- **Restore orders that were stopped on purpose.** It restarts the keeper that was
  running when the drop happened, not whatever the roster last wrote down.

`--no-rejoin` or `M59_REJOIN=0` turns it off.

## Asked to shut down, stop the server, or "we're done for now"?

```bash
node tools/m59-shutdown.mjs
```

**Always this, never a bare `docker stop`.** blakserv has no SIGTERM handler and
`[Auto] SavePeriod` defaults to 180 minutes, so stopping the container directly
can silently discard three hours of play.

It keeps **two** snapshots under `docker/data/checkpoints/` and then stops the
broker and server: `<time>-standing` (the save already on disk when you were
asked) and `<time>-checkpoint` (a fresh `save game`). Keep both — the fresh one
is the one that can capture a bad state, and the standing one is then what you
want back.

Variants: `--checkpoint` (snapshot only), `--keep-server`, `--label "..."`,
`--list`, `--restore <id>`. Restore refuses while the server is up. Report where
the checkpoints went; do not delete old ones unasked.

## Tell the user, do not work around

- **Steam cannot be automated.** It will not install a game the user does not own
  or log in for them. If step 2 finds nothing, give them
  https://store.steampowered.com/app/893390/Meridian_59/ and carry on. Do not
  script a Steam login or fetch the client from anywhere else.
- **The client is optional for a fleet.** Agents log in over the wire; no
  `Meridian.exe` is involved. It is for watching the fleet and for compendium
  art. A missing client does not block anything and should not be presented as
  if it does.
- **Either server tree works.** `setup.mjs` clones `Meridian59/Meridian59`
  (upstream) by default. `tpeppers/Meridian59-deck` is a public fork adding
  gamepad and Steam Deck support and works too, from `2c6d8091` onward. Set
  `M59_ROOT` to prefer it. Do not switch trees to "fix" an unrelated problem.
- **Docker's daemon is separate from its CLI.** `docker --version` succeeding
  proves nothing can be built. If the daemon is down, ask the user to start
  Docker Desktop rather than starting it yourself.

## Traps

- **Coordinates have several stable legacy spellings.** MCP tools use named
  `col`/`row` fields, positional movement helpers use `(col,row)`, geometry/KOD
  grid APIs use `(row,col)`, and movement bytes go over the wire Y then X. In
  prose use `r34c65` or named `row`/`col`; never infer a pair's order from
  appearance. Read [`docs/m59-coordinates.md`](docs/m59-coordinates.md) before
  interpreting, logging, or changing one. Existing commands and serialized tuples
  keep their documented grammar.
- **`create automated` makes a character with ZERO in every attribute.** They are
  fixed at creation and never move, and stamina *is* the max-health ceiling
  (`101 + stamina`), so it is capped at 102 max health for ever. Unrepairable;
  only re-rollable. Use `m59-makefleet.mjs` rather than creating characters by
  hand.
- **The server never says no.** A malformed or over-budget character request is
  silently replaced with `3/1/4/1/5/9`. Never report a character as created
  without checking `stats_as_asked` in the `reroll` result.
- **Attach to the broker, never spawn a second.** `m59-broker.mjs` with no
  arguments serves stdio MCP *and* resumes a fleet; a second owner is refused
  before its listener opens and exits with status 3. It does not attach to the
  running broker. Use `tools/m59-mcp-attach.mjs`, which holds no state.
- **Never call the `leave` tool** on a fleet anyone cares about — it drops the
  roster, and the roster is the only record of the passwords.
- **`substrate/fleet-accounts.json` is the only copy of the account passwords.**
  Gitignored. Never commit it, never print it into a shared transcript, never
  delete it.
- **`[Channel] Flush` defaults to `No`**, and with it off every server log stays
  at 0 bytes for ever — which looks exactly like a hook not firing. The container
  turns it on; a native build may not have.
- **Hunt bands are scaled by level.** `floor(level/2)` when armed, `floor(level/4)`
  when unarmed. Ceiling = level + band. A lv21 character has ceiling 31, so lv30
  giant rats are "in band" — but they are still too tough, and each death drops
  max HP by 1–2, starting a death spiral. Baby spiders (lv25) in the Deep Woods
  (rooms 534, 535, 545, 554, 568, 574, 575, 593, 603) are the safe target for
  lv20–24. Giant rats (lv30) in the Sewers (room 377/600) are the target for
  lv25+. See `docs/GOAP-HANDOFF.md` § "Scaled hunt bands" for the full table.
- **`nearestHuntRoom` uses the engagement ceiling, not the raw level.** A
  character in the Sewers sees giant rats as in-band even when they are
  over-level. If a character is losing HP over successive passes, route them
  to a weaker-mob room — do not raise the ceiling.

## Working here

- Every tool in `tools/` is standalone `.mjs`, zero dependencies. Only the chat
  responder needs `npm install`.
- `M59_ROOT` points at the Meridian 59 source tree.
- Offline tests, safe any time: `node tools/m59-safespot-test.mjs` (91),
  `node tools/m59-chat-test.mjs` (102) and `node tools/m59-rest-test.mjs` (6) and
  `node tools/m59-ledger-test.mjs` (15) and `node tools/m59-escape-test.mjs` (29).
  The rest need a live server.
- Sprites are not committed; `python tools/pull-client-assets.py` decodes them
  from a local client. Do not commit `compendium/assets/img/`.
- Do not commit what a running fleet writes — `fleet-state.json`, `history/`,
  `recordings/`, `commissions/`. `.gitignore` covers them; add no exceptions.
