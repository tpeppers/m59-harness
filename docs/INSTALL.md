# Installing

From a bare clone to ten characters playing, on Windows or Linux.

If you are an LLM reading this because someone asked you to install Meridian 59,
start with [`CLAUDE.md`](../CLAUDE.md) in the repository root — it is the short
version, with the order of operations and the traps.

## The short version

```bash
git clone https://github.com/tpeppers/m59-harness
cd m59-harness
node tools/setup.mjs all 10
```

That clones the server source, builds it in a container, starts it, starts the
broker, creates ten characters, and writes a click-to-play shortcut for each of
them if a client is installed. Ten to fifteen minutes, most of it compiling.

Check what you have first if you would rather:

```bash
node tools/setup.mjs doctor
```

## What you actually need

| | needed for | if missing |
|---|---|---|
| **Node 22+** | everything; Node 24 LTS is recommended | https://nodejs.org |
| **git** | fetching the server source | https://git-scm.com |
| **Docker** | building and running the server | https://docs.docker.com/get-docker/ |
| **Python 3** | sprite decoding, source analysis | optional |
| **Steam + the game** | watching the fleet with your own eyes | optional — see below |

**The Steam client is optional.** This surprises people. Agents log in over the
wire with `tools/m59-client.mjs`, speaking the same protocol `Meridian.exe`
speaks. No client process is involved in running a fleet. You need the client for
two things: watching a character in first person, and decoding the sprite art the
compendium displays.

## The three pieces

```
   your agent  ──MCP──▶  broker :8901  ──IPC──▶ keeper children ──protocol──▶ server :5959
                              │                                             │
                              │                                        admin :9998
                         dashboard :8902                            (loopback only)
```

The **server** is `blakserv`, built from the Meridian 59 source. The standard
**broker** is this repository's supervisor/API process; it exposes 47 tools over
stdio MCP or HTTP and normally owns one keeper child process per character. The
optional lab runtime described later can instead hold a dedicated test fleet in
one shared process. Your **agent** is whatever drives either entry point.

## 1. The server

### Where the source comes from

Two trees work, and the container in `docker/` builds either one unmodified.
Both are public, and both are tested end to end — clone, build, run, admin
socket, `create automated`, `save game`:

- **https://github.com/Meridian59/Meridian59** — upstream. The default, and what
  `setup.mjs server` clones.
- **https://github.com/tpeppers/Meridian59-deck** — a fork adding gamepad
  support, borderless full screen and Steam Deck staging. Use it if you want a
  controller or a Deck client. Its server needs `2c6d8091` or later; before that
  it built and then exited during startup.

To use a tree you already have, or to prefer the fork, set `M59_ROOT`:

```bash
M59_ROOT=/path/to/Meridian59-deck node tools/setup.mjs server
```

### The container path (both platforms)

```bash
node tools/setup.mjs server
```

or by hand — no compose binary required:

```bash
docker build -f docker/Dockerfile -t m59-blakserv:local /path/to/Meridian59
docker run -d --name m59 --restart unless-stopped \
  -p 5959:5959 -p 127.0.0.1:9998:9998 \
  -v "$PWD/docker/data/channel:/m59/channel" \
  -v "$PWD/docker/data/savegame:/m59/savegame" \
  -i -t m59-blakserv:local
```

(`docker compose -f docker/docker-compose.yml up -d` also works if you have
compose, but nothing here needs it — `setup.mjs` uses the `docker run` above.)

This is the recommended path on Windows *and* Linux, because it is the same path
on both and needs no toolchain. It compiles `blakcomp`, then the Blakod to
bytecode, then `blakserv`, and runs it as a non-root user.

It publishes **5959** (game) openly and **9998** (admin socket) on loopback only.
That asymmetry is deliberate: the admin socket is authenticated by IP mask with
no password, so anything that can reach it can administer your server.

State lives in `docker/data/savegame`. Delete it to start over.

### macOS / Docker Desktop

Everything above works on macOS with one extra step: Docker Desktop must be
running before anything else. Install it from https://docs.docker.com/desktop/mac/
and start it. Verify with `docker ps` — if it says `Cannot connect to the Docker
daemon`, Docker Desktop is not running.

On **Apple Silicon (M1/M2/M3)**, the container builds and runs as `linux/arm64`
automatically. Nothing needs to be changed.

One macOS-specific wrinkle: Docker Desktop routes container traffic through a
bridge at `192.168.65.1`, not the standard `172.17.0.1`. The container's
`MaintenanceMask` is already set to cover both (`172.0.0.0` and `192.168.0.0`),
so the admin socket works from the host without any extra configuration.

### Native, if you would rather

**Windows** needs Visual Studio (Community is fine) and a developer command
prompt so `nmake` is on the path:

```
nmake RELEASE=1
cd run\server && blakserv.exe
```

**Linux** builds the server only:

```bash
cd blakserv && make -f makefile.linux RELEASE=1
```

The upstream README notes that `blakserv.cfg` needs manual changes on Linux —
Windows path separators, mostly. The `sed` block in `docker/Dockerfile` is a
worked list of exactly which lines, if you are doing it by hand.

### The trap that costs an afternoon

`[Channel] Flush` defaults to `No` (`blakserv/config.c`). With it off, **every
channel log is buffered and never reaches disk** — setting `DebugDisk Yes` is not
enough. Debug, error and log files are created at startup and stay at 0 bytes for
ever. This looks exactly like "my hook isn't firing". It is not; the output is
sitting in a buffer.

The container turns it on. If you build natively, either edit `blakserv.cfg` or
set it at runtime:

```bash
node tools/m59.mjs admin "set config boolean [Channel] Flush yes"
```

## 2. The client (optional)

The game is on Steam:

**https://store.steampowered.com/app/893390/Meridian_59/**

Steam will not install a game you do not own, and will not log in for you, so
this step is yours. Once it is installed:

```bash
node tools/setup.mjs client       # finds it, or tells you where to look
```

On **Linux** the client is a Windows binary and runs under Proton — enable it for
the title in Steam's compatibility settings. The Deck fork adds gamepad support
and a full screen toggle; upstream's client is keyboard and mouse.

Point it at your own server:

```
Meridian.exe /U:<account> /W:<password> /H:localhost /P:5959 /Q
```

`/Q` skips the splash and login dialog. Note that Meridian allows **one
connection per character** — logging in as a character the broker is driving
bumps the broker off. That is the mechanism `m59-fleet.mjs spec` uses to let you
watch one.

### Click-to-play shortcuts

Typing that line per character gets old, so it is generated:

```bash
node tools/setup.mjs shortcuts        # or: node tools/m59-shortcuts.mjs
```

One shortcut per character in `shortcuts/`, each carrying that character's host,
port, account and password — open it and you are in the world as that character
with nothing to type. The names come from the roster, so they are the character
names: `m59-Aldric.desktop`, `m59-Rowena.desktop`, and so on.

| | |
|---|---|
| `--desktop` | copy them to your Desktop as well (and mark them trusted, on GNOME/KDE) |
| `--proxy` | point them at `m59-proxy.mjs` on 5961 instead of the server |
| `--host H` `--port N` | for a server that is not `127.0.0.1:5959` |
| `Aldric s4 fleet03` | only those — matched against agent id, character or account |
| `--list` | the roster, writing nothing |
| `--show` | print the real command lines rather than masking the passwords |

**Windows** gets `.lnk` files, made through `WScript.Shell`, with the working
directory set to the client's own folder — the client resolves `resource\`
against the working directory and takes an access violation loading a module
without it. If PowerShell is unavailable it falls back to a `.cmd` that does the
same thing.

**Linux** gets `.desktop` files that run `steam -applaunch 893390 …`. That is not
a stylistic choice: the client is a Windows binary, it needs Proton, and Proton
is Steam's — so a copy of the client that did not come from Steam cannot be given
a working shortcut here, and the tool says so instead of writing one that fails.
Steam **Game Mode** ignores `.desktop` files entirely; for one character there,
paste its arguments into the title's Properties → Launch Options:

```
%command% /H:127.0.0.1 /P:5959 /U:fleet01 /W:<password> /Q
```

#### These files are passwords

The client has no credential store, no token, and no way to be handed a login
except `/W:` on its command line. So every shortcut contains one account's
password in plain text. `shortcuts/` is gitignored and written `0700` for that
reason, and the tool masks passwords in its own output unless you pass `--show`.
Treat the directory exactly like `substrate/fleet-accounts.json` — except that
this one is disposable, because it is regenerated from the roster in a second.

Deleting a fleet's shortcuts loses nothing. Deleting `fleet-accounts.json` loses
the characters.

### Sprites

With a client installed:

```bash
python tools/pull-client-assets.py
```

5,355 PNGs decoded from the client's `.bgf` files into `compendium/assets/img`.
They are not committed — they are the client's own art. Until you run this, the
compendium's pages render and its images 404.

Note that `blakston.pal`, the palette every sprite indexes into, ships with the
**source tree**, not with the retail client. The puller finds both.

## 3. The broker and a fleet

```bash
node tools/setup.mjs broker
node tools/setup.mjs fleet 10
```

or directly:

```bash
node tools/m59-service.mjs start
# foreground diagnostics only:
node tools/m59-broker.mjs --http 8901 --dashboard 8902
node tools/m59-makefleet.mjs --count 10
node tools/m59-makefleet.mjs --count 10 --dry-run    # plan only
```

### Running a local test fleet alongside prod

If you have a prod fleet on the default ports (8901/8902), use different ports
and a different fleet name for the local server so the two never collide:

```bash
node tools/m59-broker.mjs --http 8911 --dashboard 8912 \
  --fleet local --host 127.0.0.1 --port 5959 --no-rejoin

node tools/m59-makefleet.mjs --count 4 --broker 8911 --prefix fleet
```

`--fleet local` writes state to `substrate/fleets/local.json` rather than the
default `substrate/fleet-state.json`, so the two fleets' rosters stay separate.
`--no-rejoin` is optional but convenient for a test server — it means dropped
sessions stay out rather than being automatically rejoined, which keeps the log
quieter while you're working.

`m59-which.mjs` exits non-zero on a fleet mismatch, which is the failure that
once took down a live 46-session broker while every step reported success. Run it
before any command that touches characters if you are switching between fleets:

```bash
node tools/m59-which.mjs      # which fleet would the next command touch?
```

To use DM tools against the local server (teleporting characters into hunting
rooms, setting up test scenarios), pass `M59_ADMIN_PORT=9998`:

```bash
M59_ADMIN_PORT=9998 node tools/m59-dm.mjs relocate "Alfa,Bravo" 60 --verify
```

Every launch uses explicit `M59_MAP` first, then the gitignored server-matched
`substrate/m59-map.local.json`, then the checked reference map. Setup regenerates the
local map from the exact server room resources and service restarts preserve that choice.
The broker refuses startup if the selected map's collision payloads or manifest do not
validate; it never substitutes unchecked movement.

### What making a character actually involves

`create automated` on the admin socket makes an account and a character in one
call — and that character has **zero in every attribute**. Attributes are fixed
at creation and never move, and stamina *is* the max-health ceiling
(`101 + stamina`), so it is permanently capped at 102 max health and permanently
bad at everything.

`m59-makefleet.mjs` replaces it by sending `BP_NEW_CHARINFO` — the same packet
the real client sends when a new player chooses their stats. The server only
accepts it while `IsFirstTime()` holds (`user.kod:536`), which checks two fields:
`piLastLoginTime = 0 AND piLast_Restart_time = 0`. Fresh out of `create
automated`, both are zero. But the first login sets `piLastLoginTime = GetTime()`
(`user.kod:591`), and a suicide sets `piLast_Restart_time = GetTime()`
(`user.kod:1439`), so neither login nor suicide alone restores the first-time state.

The fix: immediately after `create automated`, zero both fields directly on the
user object via the admin socket (`set object <id> piLastLoginTime INT 0` and
`set object <id> piLast_Restart_time INT 0`). The broker then connects fresh,
sees `flags & 1` in `BP_CHARACTERS`, and sends `BP_NEW_CHARINFO` with real stats
— no login, no suicide.

**The server never says no.** Over budget, out of range, wrong list length — none
of it is refused. It silently stamps `3/1/4/1/5/9` and the default face on you,
and you find out weeks later when the character cannot get past level 15. Every
character is therefore verified after creation against what was asked for, and a
mismatch is reported as a failure rather than counted as a success.

The default mix for ten is 5 melee, 3 caster, 1 archer, 1 balanced, every one of
them with 50 stamina — the per-stat cap, and therefore the 151 max-health
ceiling. Casters get `create weapon` and `create food`, which are the two spells
that stop a fleet stalling and are both karma-free, so a fresh neutral character
can actually cast them.

Account passwords are generated and written to `substrate/fleet-accounts.json`,
which is gitignored. That file is the only record — do not delete it.

## Saving, and why the volume is not optional

Saves and restores work in the container, and they need the bind mount to do it.
Verified: create an account, `save game`, destroy the container entirely, bring
it back on the same volumes — the server logs `LoadAll loaded game saved at ...`
and the account is there.

The server mounts two directories, and both matter:

```
docker/data/savegame   the world: accounts, characters, everything
docker/data/channel    the logs, including player chat
```

**Without the mount the world lives in the container's writable layer and
`docker rm` destroys it.** The Dockerfile also declares `VOLUME` for both, so a
`docker run` with no `-v` gets anonymous volumes rather than silent loss — but
those are orphans you will not find again. This is why `setup.mjs` (and the
by-hand `docker run` above) bind these two host directories explicitly; the
compose file mounts the same two if you use it instead.

Nothing else needs persisting. `memmap/` and `loadkod/` are rebuilt from the
image, and a restore works without them.

A save set is four files sharing a timestamp — `gameuser`, `accounts`,
`striings`, `dynarscs` — plus `lastsave.txt`, whose `LASTSAVE <stamp>` line is
what blakserv reads to decide which set to load.

### `docker stop` does not save

blakserv installs no SIGTERM handler — the only signal it touches is `SIGPIPE`
(`blakserv/osd_epoll.c`) — so `docker stop` terminates it outright. Measured: it
dies in about 1.5 seconds, and an account created just before the stop is gone
afterwards. `[Auto] SavePeriod` defaults to **180 minutes**, so a hard stop can
cost three hours.

That is fine for a hard stop, which is what it is. For a deliberate shutdown:

```bash
node tools/m59-shutdown.mjs
```

It keeps **two** snapshots under `docker/data/checkpoints/`, then stops the
broker and the server:

| | |
|---|---|
| `<time>-standing` | the save already on disk when you asked, copied aside untouched |
| `<time>-checkpoint` | a fresh `save game` taken right then |

Two, because the fresh save is the one that can be bad — if the fleet has just
walked into something, or a re-roll went wrong, or errands are half-finished, the
checkpoint preserves exactly that, and the standing save is what you actually
want. Saving over the only copy is how you discover which one you needed.

```bash
node tools/m59-shutdown.mjs --checkpoint          # snapshot, stop nothing
node tools/m59-shutdown.mjs --keep-server         # stop the broker only
node tools/m59-shutdown.mjs --label "before the raid"
node tools/m59-shutdown.mjs --list
node tools/m59-shutdown.mjs --restore 2026-08-02T17-46-44-standing
```

Restore refuses while the server is running, because a live server holds the
world in memory and would write over the restored files at its next save.

If you would rather lose less to a hard stop, shorten the auto-save period —
`[Auto] SavePeriod` in `blakserv.cfg`, in minutes. Each save garbage-collects
first, so there is a cost to making it very frequent.

## 4. Wire up your agent

`.mcp.json` in this repository:

```json
{ "mcpServers": { "meridian59": {
    "command": "node",
    "args": ["/absolute/path/to/m59-harness/tools/m59-mcp-attach.mjs", "--port", "8901"]
} } }
```

Fix the path for your checkout. **Attach, do not spawn.** `m59-broker.mjs` with
no arguments serves stdio MCP *and* resumes a fleet; with one broker already
owning that fleet, a second is refused before its listener opens and exits with
status 3. It does not attach to the running process. `m59-mcp-attach.mjs`
forwards to the broker that already owns the fleet and holds no state.

Claude Code needs a restart to pick up a changed `.mcp.json`.

## Checking it worked

```bash
node tools/setup.mjs doctor
node tools/m59-fleet.mjs                 # list the characters
```

and the fleet page at **http://127.0.0.1:8902/fleet**.

## When it does not work

| symptom | cause |
|---|---|
| `no maintenance socket on 127.0.0.1:9998` | server not running, or 9998 not published. `docker ps --filter name=m59` |
| image build fails on `-Werror` | the container strips it from `common.mak.linux`; if you build natively you may hit it. |
| broker exits with `broker ownership refused before startup` | the roster or one of its accounts is already claimed. Run `node tools/m59-which.mjs`; if that is the broker you meant to use, attach with `m59-mcp-attach.mjs`. |
| `reroll` says "no character came back" | `IsFirstTime()` returned false. The broker zeros both `piLastLoginTime` and `piLast_Restart_time` via the admin socket before connecting — if that step fails, reroll will fail silently. Check the admin socket is reachable. |
| `reroll` says the server substituted junk | the request was rejected silently. Do not re-roll anything real until it passes on a spare. |
| channel logs are 0 bytes for ever | `[Channel] Flush` is `No`. See above. |
| character cannot get past level 15 | it is the zero-stat placeholder. It cannot be fixed; re-roll it. |
| a shortcut opens the client at the login dialog | its account and password are stale — re-run `node tools/setup.mjs shortcuts` after any re-roll. |
| a shortcut logs in and the broker stops driving | expected: one connection per character. Regenerate with `--proxy`. |
| a `.desktop` will not start from the file manager | it is not marked trusted. `--desktop` does that on copy; otherwise right-click → Allow Launching. |
| broker reports a fleet/account lock conflict | use `m59-which.mjs` to find the owner. An exact-roster restart can adopt guarded keepers; a lab or alias roster cannot. A stale pre-guard claim needs the one-time migration below. |

A dead broker PID does not prove that its keeper children or account sessions are gone.
New claims record each keeper PID in both the exact fleet and account locks, so an
exact-roster broker restart can atomically adopt verified survivors while lab and copied
rosters remain refused. Never delete a live or guarded lock.

Claims from brokers predating keeper guards fail closed. For the first restart after this
upgrade, verify the selected fleet and exact roster, then give that standard broker the
one-time migration override:

```powershell
$env:M59_ALLOW_UNGUARDED_TAKEOVER = '1'
node tools/m59-service.mjs start --fleet 'your-fleet-name'
Remove-Item Env:M59_ALLOW_UNGUARDED_TAKEOVER
```

On Linux, scope it to the one command:

```bash
M59_ALLOW_UNGUARDED_TAKEOVER=1 node tools/m59-service.mjs start --fleet 'your-fleet-name'
```

The override is broker-only. For each expected agent, the broker reads `/health`, stops
the exact legacy keeper PID it reports, waits for positive death, and only then starts a
replacement whose PID must be installed in both guarded claims before login. If that PID
does not stop, the replacement is refused. Remove the override after the migration; never
use it for a lab or copied/alias roster.

Never call the broker's `leave` tool on a fleet you care about: it drops the
roster, and the roster is the only record of the passwords.
