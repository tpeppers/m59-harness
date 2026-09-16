# Operating the fleet

Split out of [`CLAUDE.md`](../CLAUDE.md). Shortcuts, the service, the front ends, backups, the DM socket, the reports, and lending characters out.

For per-character world-tour stall counts and thresholds, see
[world-tour progress monitoring](m59-tour-progress.md).

## Click-to-play shortcuts

`node tools/m59-shortcuts.mjs` writes one shortcut per character into
`shortcuts/` — a `.desktop` file on Linux, a `.lnk` on Windows — carrying that
character's **host, port, account and password** on the client's command line, so
opening it drops you into the world as that character with no dialog:

```
Meridian.exe /H:127.0.0.1 /P:5959 /U:fleet01 /W:<password> /Q /S
```

- `--desktop` copies them to the user's Desktop as well.
- `--proxy` points them at `m59-proxy.mjs` (5961) instead of the server, which is
  what you want if the broker should keep driving while a human is inside.
- `--list` shows the roster; `--show` prints the real command lines.

**Each shortcut is a plaintext password**, so `shortcuts/` is gitignored and
written `0700`, exactly like `substrate/fleet-accounts.json`. Terminal output
masks the password unless `--show` is given — do not pass `--show` in a shared
transcript, and do not commit or paste the files.

**On Linux the shortcut can only be `steam -applaunch 893390 …`**, because the
client is a Windows binary and Proton belongs to Steam. A non-Steam copy on Linux
is reported honestly rather than guessed at. Steam **Game Mode** does not show
`.desktop` files at all; there, put one character's arguments in the title's
Properties → Launch Options.

**Logging in bumps the broker off that character** — Meridian allows one
connection per character. That is expected, and is how `m59-fleet.mjs spec`
works; use `--proxy` when you do not want it.


## Running the broker as a service

### The page has buttons, on the broker machine only

The fleet page carries Rejoin / Restart / Stop when it is opened on `127.0.0.1`. It binds
to every interface so it can be read from a phone, so the controls are rendered only for
loopback **and** the POST behind them is refused at the socket for anything else — a
hidden button is not a permission check. There is no Start button and there cannot be:
when the broker is down, nothing is serving that page.

### It looks before it logs anybody in

A resume logs in every character in the roster, and Meridian allows one connection each —
so a restart is exactly the thing that throws a person out of the world. It happened here:
a restart to load new code bumped the operator off Zoot mid-sentence, and the auto-claim
only noticed twenty seconds later, because it matches against live sessions and at boot
there are none.

So before the first login, `resumeFleet` reads the command line of every running
`meridian.exe` (`/U:` is the account — `m59-shortcuts.mjs` puts it there), matches it
against the **roster** rather than against sessions, and claims those agents as piloted.
A claim is what the reconciler honours, so one call keeps the character out of the resume
*and* out of the 45s rejoin sweep.

**A claim records whether the keeper was driving, and a second claim must not forget the
first one's answer.** Claiming stops the keeper, so anything that recomputes "was it
running" afterwards reads *stopped* — and this boot-time claim runs before there is a
session to ask at all. Robin, 2026-08-27: claimed "keeper was running" when the operator
logged in, re-claimed "keeper was stopped" at a broker resume, released as "stays
stopped", and rejoined with no keeper. So an existing claim's answer stands, and the resume
path passes the roster's standing orders as the answer — a character with orders was
driving, whatever the empty shell says.

Then it checks. A command line says what a process was *asked* to do, not that anyone
reached the world, so another character reads the who list and looks for that name — and
if the character is **not** online, the claim is released and the character resumed after
all. Otherwise a client left at the login screen would strand a character out of the fleet
for as long as its window stayed open, silently, because standing down looks exactly like
working correctly.

The who list speaks names and the roster speaks accounts, which is why a successful login
now writes the character's name back into the roster entry. That is also why the resume
log says `resumed t1 (Kermit)` rather than `resumed t1 (?)`.

### The roster never shrinks by accident

`substrate/fleets/<fleet>.json` is the only record of the account passwords, and a save
writes whatever `fleetState` currently holds — which *during a resume* is "everyone
processed so far". Anything saving inside that loop, and a keeper starting does, published
a truncated roster to disk for a few seconds: watched live it went 13 of 21 and back. The
old guard noticed, kept a `.prev`, and wrote the smaller file anyway. Now entries on disk
that this process has not loaded are carried forward, and only `forget` removes one.

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

## The two front ends, and the one command that starts everything

```bash
./m59.sh                 # the fleet terminal (m59.ps1 on Windows)
./m59.sh up              # broker + field command page, for this checkout's fleet
./m59.sh status          # both of them, and which fleet
./m59.sh down            # both of them again
./m59.sh field           # just open the page
```

`npm run terminal|start|stop|status|field` are the same commands for anyone who reaches
for npm first. **Nothing lives in these scripts** — every behaviour is in `tools/`, so
prefer changing the tool.

There are two views of the same fleet and neither replaces the other. `m59-tui.mjs` is a
list and a keyboard: it is the only one that can start a program, which is what `L`, `B`,
`C` and `F` are for. **`maps/m59-strategy-game` is a map in a browser** — the world, the
roster on it, and a small order set that becomes ordinary broker calls. It holds no
credentials, starts no broker, pins itself to `127.0.0.1`, and its worker refuses
non-loopback hosts, because it is a control plane rather than a dashboard.

`m59-webui.mjs` owns its lifecycle, and `m59-service.mjs` starts and stops it with the
broker — **after** the broker answers, since a page that comes up first spends its first
seconds reporting a fleet that is not there. `F` in the terminal ensures it is running and
then opens a browser at it. `node tools/setup.mjs webui` installs it; `all` runs that.

Four things it does rather than documents:

- **IT NEVER BLOCKS THE BROKER.** The broker holds twenty-one irreplaceable sessions and a
  web page failing to build is not a reason for the fleet not to come up. An absent
  sibling, an uninstalled one and a failed start are all reported and `start` still exits 0.
- **IT IS A SEPARATE REPOSITORY AND MAY NOT BE HERE** — same arrangement `B` has with
  `maps/m59-boswars`. `M59_STRATEGY_DIR` names it when it does not live beside us, and
  "absent", "not installed" and "somebody else is on the port" are three different answers
  that the tool says apart.
- **IT NEVER STOPS SOMETHING IT DID NOT START.** The pid file is the authority; a port
  answering with no pid file of ours is reported as somebody else's and left alone. Stop
  signals the process GROUP, because `npm run dev` is npm with a child and a bare kill
  leaves the dev server orphaned and holding the port — which then reads as "not ours" for
  ever after.
- **It runs `npm run dev`, not the bundler directly**, because that script's `predev`
  refreshes the page's generated world and room maps out of this harness. Skipping it
  serves whatever the map looked like the last time somebody built.

A one-shot HTTP GET in that module has a hard timer under it and settles on `close` as
well as on `end`. The first version capped the body with `req.destroy()`, which emits no
`end` — so the promise never settled, the status line silently stopped printing, and the
only symptom was Node's "Detected unsettled top-level await" on the one code path where it
happened to be the last thing running.


## The client `L` starts is the patched one, and it does not log itself off

```bash
node tools/m59-devclient.mjs --check                # is a patched client built, and where
node tools/m59-devclient.mjs --universal            # write shortcuts/dev.bat and nothing else
node tools/m59-devclient.mjs --fleet arena TESTER   # dev-TESTER.bat: one `call` line into dev.bat
shortcuts\dev.bat <host> <port> <account> <password> [label]
```

There are two clients on this machine and they are different binaries. Steam's is a
stock 32-bit retail build. The one in the source tree's `run/localclient/` is built from
`clientd3d/` **as x64**, with `m59dbg.c` in it — the overlay, the caption that names the
room and the square, the F5 signal, the help key that opens the room view — and, since
2026-08-26, **without the idle logoff**. Stock, `LogoffTimerStart` arms a timer that quits
the session after `[Miscellaneous] Timeout` minutes (20 by default) with no key or click,
the setting is per-machine and rewritten on exit, and nothing on a launch line can turn it
off; a client left up overnight to gather data was gone by morning with a clean `REQ_QUIT`
in the log and no other trace. In the patched build the timer never arms. The Timeout
dialog still saves its number and the number is not read. Two more, since 2026-08-27:
**the safety is on at every login** — stock reads `[Interface] Aggressive` back from the ini
and merintr sends it as the `UC_SAFETY` on entering the game, so one `safetyoff` in an
earlier session came back for every session after it; the patched build never reads it,
and `safetyoff` or the preferences dialog still turns it off for the rest of that session
only. And **a stackable purchase opens at 50** (`DEFAULT_PURCHASE` in `buy.c`) instead of
the merchant's own stack size — the 5 herbs and 4 elderberries at Morrigan's that every
restock began by retyping; withdrawals still open at all of what is there. `M59_CLIENT`
names the binary when it is not in the default tree; the build line is what `--check` prints when nothing is
there (**`vcvars64`**, not 32 — the objects in `clientd3d
elease` are x64, and one x86
object among them fails the link rather than producing a wrong binary).

**`shortcuts/dev.bat` is the one file that knows how to start it.** It names no character:
the character is its five arguments, in the order host, port, account, password, label.
The per-character `dev-<name>.bat` files are one `call` line each into it, and the fleet
terminal's `L` key calls the same file with the same five arguments built by the same
function (`universalLauncherArgs`), so the terminal and the shortcuts cannot start two
different clients. Every launch that routes through it rewrites it first when it is stale,
so the file on disk is always the current tool's opinion. What the calling environment
already says — `M59_OVERLAY_DIR`, `M59_SIGNAL_PORT`, `M59_DEBUG_TITLE`, `M59_MAP_URL` —
wins over what the file would set. The endpoint is decided at start-up, not when the file
was written: `--endpoint <host> <port>` asks `substrate/proxies/` whether a live proxy is
fronting that server and answers with the proxy if so, which is what lets the broker keep
driving a character while you watch it. `M59_DEVCLIENT_DRYRUN=1` prints what it resolved
and starts nothing, which is how `m59-devclient-test.mjs` (31) exercises the real file.

The terminal prefers the patched client whenever `--check` would find one and falls back
to Steam's otherwise; `M59_TUI_STOCK_CLIENT=1` asks for Steam's on purpose. A `.bat` that
`start`s something cannot hand a pid back, and everything after the launch — the pilot
claim, the wait for a window, the injection — needs one, so the client is found afterwards
by the account on its command line and by having been created after the launch was asked
for; a second window somebody left open on the same account is excluded by the timestamp,
and a client that never appears is reported in `substrate/m59-launch.log` rather than
waited on for ever.

**Two architectures means two agent DLLs.** `m59agent.dll` is x86 and loads only into
Steam's client; `m59agent64.dll` is the same `m59agent.c` built x64 for the patched one
(`cl /LD /O2 /MT m59agent.c /link /OUT:m59agent64.dll ws2_32.lib user32.lib` under
`vcvars64`). `LoadLibrary` of the wrong one returns NULL with no other symptom, so
`m59-inject.ps1` asks each client which it is (`IsWow64Process`), injects the 64-bit
clients from the 64-bit PowerShell it starts in, and re-launches as 32-bit for the rest.

The password is on `dev.bat`'s command line rather than in its body, which is the same
exposure as the client's own command line, readable to anything that can list processes;
`shortcuts/` stays gitignored regardless.

## Backing the fleet up, and putting it back

```bash
node tools/m59-backup.mjs                 # every destination, everything
node tools/m59-backup.mjs --list          # what exists, where, and how many rosters
node tools/m59-backup.mjs --credentials-only    # just the irreplaceable part, seconds
node tools/m59-backup.mjs --verify <dir>  # re-hash a backup against its own manifest
```

Two destinations by default — `C:\m59\backups` and `D:\m59\backups`, override with
`M59_BACKUP_DIRS` or repeated `--to` — because a backup on the same disk as the original
protects against somebody deleting a file and against nothing else.

**What is actually at risk, in order.** The **rosters** (`substrate/fleets/<name>.json`,
`substrate/fleet-state.json`, `substrate/fleet-accounts.json`) are the only record of the
account passwords: no reset, no email on the account, no way to ask the server. Lose one
and those characters are not deleted, just permanently unreachable. Then the **character
sheets**, which are the only snapshot of `prod` — `m59-shutdown.mjs` copies the *server's*
savegame aside, and prod's server is somebody else's machine, so run against prod it copies
a stale local save and reports success. Then the **records** (abilities, banks, tougher,
descriptions, history), none of which can be backfilled.

The backup refreshes the character export first (`m59-sheet.mjs --checkpoint`), and carries
on without it if the broker is down — saying so — because a backup that refuses to run when
the fleet is down is missing exactly when the rosters most need copying.

Four things it enforces rather than documents:

- **A backup with no roster in it is refused.** The failure that matters is not a crash, it
  is a nightly job reporting success while containing everything except the one file nobody
  can regenerate.
- **`*.lock` is never backed up.** `prod.json.lock` is 32 bytes naming a pid; restored it is
  a stale claim that stops a broker starting. It was also being *counted as a roster*, so a
  directory holding nothing but a lock would have satisfied the guard above.
- **Nothing is written inside the repository** — in there it is either committed (plaintext
  passwords in git, for ever) or gitignored and deleted by the next clean.
- **What was written is read back**, hashed. That caught a real bug on the first live run:
  hashing each file once but re-reading the source per destination gave D: different bytes
  for `substrate/hits/*.json`, which the running broker rewrites every few seconds. Sources
  are now read once and the same bytes go to every destination, so the copies are identical.

```bash
node tools/m59-restore.mjs --list
node tools/m59-restore.mjs --latest          # says what it WOULD do, changes nothing
node tools/m59-restore.mjs --latest --apply
```

**Restore is the dangerous half, in a specific way.** A roster gains entries over time — a
new character, a name written back after a first login — so a week-old backup is a smaller,
older, entirely valid-looking file that restores cleanly and silently loses every account
added since. So: it plans by default and needs `--apply`; it **refuses while a broker holds
the fleet**, which owns the roster and rewrites it from memory (stop it with
`m59-service.mjs stop` first); it copies whatever it replaces to
`substrate/.before-restore-<stamp>/` — gitignored, and holding rosters, so it is as secret
as the originals; and **a roster that would shrink is refused outright** unless you pass
`--force`. A backup that does not verify against its manifest is never restored at all.

`node tools/m59-backup-test.mjs` (42) pins all of that against scratch directories.

## Setting a test scenario up — DM powers, and a scenario in one file

Everything in this section is for a server running **on this machine**, and all three tools
refuse a host that is not loopback rather than trusting you to remember. The maintenance
port is unauthenticated and IP-restricted and that is its entire security model, so
pointing it at `prod` — somebody else's machine, with real players on it — is not a
configuration choice.

```bash
node tools/m59-dm.mjs where TESTER Alpha           # names -> object ids
node tools/m59-dm.mjs relocate Alpha,Bravo 60 --at 13,16 --verify
node tools/m59-dm.mjs kit TESTER --stats 50 --health 151 --karma -60 --spells 99
node tools/m59-dm.mjs heal Alpha,Bravo
node tools/m59-testbed.mjs up    scenarios/arena.json     # the whole scenario
node tools/m59-testbed.mjs reset scenarios/arena.json     # between rounds
node tools/m59-patrol.mjs --agents arena1,arena2 --room 60 --radius 5
```

**WALKING IS THE WRONG TOOL FOR PLACING A TEST CHARACTER.** Getting six characters from the
newbie island to the Tos arena by travelling took about twenty minutes and failed halfway
on five of them; the same placement over this socket is **0.22 seconds, verified**. The
primitive is `System.UtilGoNearSquare` (`util.kod:20`), whose own docstring is "Move any
object anywhere in any room" and which is what the DM rescue spell uses.

**A SCENARIO FILE IS A CREDENTIAL STORE**, because creating the account is the one step that
cannot go over the game protocol. `/scenarios/*.json` is gitignored for the same reason a
roster is; `*.example.json` is the exception and its passwords are placeholders.

Five things these tools do that are not obvious:

- **THE SOCKET NEEDS NO PACING AT ALL, and every other caller in this repository paces
  itself.** 70ms in `m59-godmode.mjs`, 400ms in `m59-makefleet.mjs` — and that pacing IS
  their runtime. Measured: **2000 commands written as one buffer got 2000 replies**, with
  no elapsed time beyond the settle wait the measurement itself imposed. `m59-dm.mjs`
  writes a batch in one go and reads until a sentinel, so a full character kit went from
  fourteen seconds to under one.
- **OBJECT IDS ARE NOT STABLE. The server renumbers them when it garbage-collects, which it
  does on every save** — `[Auto] SavePeriod` is 15 minutes here. In one session a character
  resolved as 7218, was configured as 7218 successfully, and half an hour later object 7218
  was a heartstone while the character had become 7124. Nothing errored. So resolve names in
  the same batch that uses them and **never cache an id across a call**; a broker holding
  stale ids goes quietly deaf and the cure is `m59-service.mjs restart`.
- **`reset` IS THE VERB THAT MATTERS**, because it runs between every round rather than once
  per scenario. It is deliberately the cheap one — ceilings, heal, place, all pure
  maintenance-socket batches, no broker, no walking, no logins.
- **A SPEC STATES AN END STATE, NOT AN ERRAND** — the same shape as the guild wants, and for
  the same reason. `reagents: 50` means "carries 50", so `give` reads the pack and creates
  only the shortfall. The first live `up` re-run doubled every stack to 100 before this was
  fixed, which is what a delivery does and not what a spec means. It tops up and never takes
  away: trimming would mean deleting objects out of a character to satisfy a number.
- **SAY A BOT'S NAME IN AN ARENA AND IT SAYS `challenge`.** `arenaCall` in `m59-chatter.mjs`,
  guarded on a loopback server AND an arena room AND the whole utterance being the name —
  not a substring, or a bot called Echo answers "echo location" and the keeper's own status
  line (which opens with the character's name) calls every bot in the room into the ring for
  ever. The keeper's `social()` stands down when it matches rather than answering first,
  which it used to: asked to challenge, Alpha replied "Alpha: not hunting anything, 88/50
  health."

## Asked for a "minimal summary"?

```bash
node tools/m59-minimal.mjs            # min/max/avg max health and kills per minute
node tools/m59-minimal.mjs --minutes 60
node tools/m59-minimal.mjs --json
```

Six numbers and nothing else, so the same request gives the same shape every time and
two readings can be compared. Max health because it IS the level here; kills per minute
because it is the rate that vigor, supply, safe spots and room choice all exist to
protect.

**Kills come from the ledger, never from a keeper's own tally.** `Autopilot.tally.kills`
is emptied in the constructor and keepers restart constantly, so that field means "since
the last restart" and cannot answer "is this character earning now". Do not answer this
question by averaging `fleet` rows.

## Who is not fighting, and what is stopping them

```bash
node tools/m59-overhead.mjs           # worst first: travel + trade against fighting
```

Overhead is travel plus trade. A character at 90% overhead and 0% fighting is not idle
and not stalled — it is busy doing something that is not the job, and the fleet board
cannot show that because every row looks healthy.

**Read the castings column, never the reagent pair.** Castings are
`min(elderberry, herbs) / 2`, so 3/94 is ONE casting and reads as well stocked to
anything that sums or averages. Measured on this fleet: every character at or below 3
castings ran 76-100% overhead with 0-8% fighting, and every character above 18 castings
ran under 55% overhead. Characters without reagents spend all their time getting reagents.

**And read the band.** `walking_money` is both the float kept after banking and the floor
`restockReagents` refuses to spend below, so what a character can actually spend is
`bank_above - walking_money`. At the shipped 500/400 that band is 100 shillings: purses
sat at 0-586 against bank balances of 10,000-36,000, restocks arrived 150 shillings at a
time against a 3,360sh full fill, and trading reached 54% of all active time against 17%
fighting. Raising `walking_money` makes it worse, not better — it is a floor.


## LENDING CHARACTERS OVER THE INTERNET WITHOUT LENDING THE PASSWORD

The fleet cannot be handed over the way a session is handed over, and the server source
says why. `SynchedAcceptLogin` (`blakserv/synched.c:321`) is the whole of authentication —
`a = AccountLoginByName(name)` then `a->password != password` — re-checked on every TCP
connect. **There is no resume verb in the AP table**, so there is no session to pass. The
wire carries `MD5(password)` rather than the plaintext (`m59-client.mjs`, `mdpass`), but
that digest IS the credential: it is compared directly against what is stored, so shipping
digests instead of passwords moves the same authority under a different name.

Nor can the live connection travel. Every session holds anti-spoof state — `seeds[]`,
`secure_token`, `sliding_token` — advancing on **every packet** in lockstep with the server
(`commcli.c:160-177`); one step out of line sets `seeds_hacked` and the server drops you
silently. And the IP is not the obstacle people expect: it appears only in a ban list and
in `MaxPerIPAddress` (default `0`, unlimited), never binding a session to an address.

**So what moves is AUTHORITY.** The broker stays here holding the roster and the sockets;
somebody else drives part of it through a door that can be shut.

```bash
node tools/m59-handoff.mjs mint --to "a guildmate" --agents t1,t2 --for 4h   # owner
node tools/m59-lend.mjs --port 8931                                          # owner, behind a tunnel
node tools/m59-mcp-attach.mjs --host <tunnel> --port 8931 --token m59g_...   # borrower
```

The borrowed characters then appear in the borrower's own tooling as ordinary MCP tools.
`node tools/m59-handoff.mjs list` shows every grant and what it has been used for;
`revoke <id>` ends it on the next request.

- **A grant is FULL CONTROL by default**, including what cannot be undone. That is
  deliberate: half-lending a character produces a bot that stalls on the verb you withheld,
  and you find out from a silence rather than an error. `--safe` opts into withholding the
  irreversible ones (`leave`, `forget`, `reroll`, `pilot`, `describe`, and the destructive
  guild verbs). **`leave` and `forget` are the worst of them** — they drop the roster entry,
  and the roster is the only record of the account password.
- **What a grant still is not, even at full control**, is the reason it beats telling
  somebody the password: it is revocable in one command, it expires on its own, it is
  scoped to named characters rather than the account, every use is attributed — and the
  holder never learns the credential, so revoking actually ends it.
- **The token is never stored**, only a salted SHA-256, so a leaked grant file names who was
  trusted and grants nothing.
- **`fleet` comes back filtered** to the characters the grant covers. A borrower of two
  characters gets a board of two; otherwise every lend leaks the whole roster's positions,
  health and money.
- **`m59-lend.mjs` is a separate process from the broker and must stay one.** The broker's
  own port has no authentication — its controls render only for loopback and the POST is
  refused at the socket for anything else — which is right for something holding twenty-one
  irreplaceable accounts, and exactly what you do not bolt an internet-facing auth layer
  onto. The lend door owns no sessions, no roster and no lock, and can do nothing a local
  operator could not.
- **There is no TLS here.** Put it behind a VPN or an SSH tunnel; never expose either port
  directly. `substrate/grants/` is gitignored, like the roster.
