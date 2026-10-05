# The Meridian 59 Compendium

A static reference site for the game: every spell, skill, item and creature, plus
guides to the systems that connect them. Nothing here is remembered or estimated —
every page is compiled from the server's own Blakod source and the client's own
sprite files, and every quantitative claim carries a `file:line` citation into
`C:\code\Meridian59`.

## Read it

```bash
node tools/serve.mjs          # http://127.0.0.1:8099/ , this computer only
```

If you have the harness's fleet running, `node ../tools/m59-compendium.mjs --open
--agent t1` serves it instead and loads a **real character** into the bestiary — or
just press `C` in the fleet terminal on whichever character you are looking at.

### Reading it from another device

Both servers take `--access <mode>` (or `M59_COMPENDIUM_ACCESS`), and the default is
`local`:

| mode | who can connect | who can write |
|---|---|---|
| `local` | this computer only | this computer |
| `lan-read` | anything on the network | this computer only — the LAN is refused with 403 |
| `lan-write` | anything on the network | anything on the network |

"Write" means the harness server's planner: saving a loadout or a guild plan, and the
hand-overs to the fleet. Those are **instructions the keepers obey**, so `lan-write` is a
deliberate choice. `lan-read` still shows every live character — their equipment and
levels — to anyone on the network, because the harness server reads the broker for
whoever asks.

In either LAN mode the server prints its LAN URLs; open `http://<this-PC-LAN-IP>:8099/` on
the other device, and allow inbound TCP 8099 on the private network in Windows Firewall if
it cannot connect. A server that is already running keeps the mode it started with —
restart it to change it. `--status` says which mode a running one is in.

1,003 pages: 186 spells, 323 items, 267 zones, 171 creatures and NPCs, 22 skills,
23 guides, and nine catalogue indexes. 5,355 sprites decoded from the client's
`.bgf` files and 254 room maps decoded from its `.roo` files.
`node tools/lint.mjs` reports zero broken links, zero malformed fragments, and
zero citations pointing at a line that does not exist.

Three pages do real work rather than listing things:

- **`planner/index.html`** is the page between this site and the live fleet, and the only
  one here that can *write*. It rebuilds the client's own right-hand panel — inventory,
  spells, skills, stats, the same four tabs in the same order, the same stat bars and the
  same stack counts in the corner of each cell — and makes all of it editable. Bring a
  character in (press `P` on it in the fleet terminal, or tick it in the character list),
  choose the level you want in each spell school, tick the skills, and put items in the
  inventory with a **minimum** to carry and a **ceiling** to shed above. Saving writes
  `substrate/loadouts/<character>.json`, which the keeper then reads before it buys, sells,
  keeps or drops anything — so the gear a character gets back to after a day of breaking
  things is a decision somebody made rather than a constant shared by twenty-one of them.

  **Its stats tab is not only its own.** The frame, the bars and the arithmetic under them
  live in `tools/statpane.mjs`, which the build writes out as `assets/statpane.js` and
  `assets/statpane.css` — and which the harness's own `/stats` board imports directly, to
  draw the same pane read-only over every character in the fleet. `assets/planner.css` holds
  only the editable half, so a change to how a bar looks belongs in `statpane.mjs`.

  Two things it will tell you that nothing else does. Picking a school shows the **reagents
  those spells eat**, with a button that turns them into the carry list — a spell list is
  also a shopping list, and until now nothing joined the two. And each school shows what
  its **next** level costs, computed the way `PlayerCanLearn` computes it, including the
  scarcity relief that makes a thin level below cost a third as much. Only the next level:
  a level four out is priced against knowledge the character does not have yet, so a total
  for it would be arithmetic about an imaginary character.

  Spell-school and Weaponcraft targets also form one ordered **acquisition queue**. Each
  row is one exact school level; the fleet may buy from the first unfinished row only, and
  every ability at that level must be known before the next row opens. Individual skills
  can be appended and rows can be reordered in the same editor.

  The inventory tab also holds the **gear** — an ordered weapon and armour preference, best
  first, which is a different kind of answer from a carry list: the keeper reaches for the
  first of these the character owns and an outfitting run buys the first it is missing, so a
  character holding the second is one upgrade short rather than missing its gear. That is
  also the part of a loadout that can be shared across characters. **Apply gear + carry to
  fleet** writes both the ordered gear preferences and the desired carry list into every
  character's loadout while preserving schools, skills, sell/keep rules, purse settings and
  notes. It says what it would do first, per character. The character picker is a checkbox
  list; with several checked, the inventory tab becomes a shared gear-and-carry editor and
  the character-specific spells, skills and stats tabs are disabled.

  Served by the harness it saves; opened any other way it exports the same file for you to
  drop in by hand, and says which of the two it is doing.


- **`creatures/index.html`** is a combat calculator. Describe a character —
  five presets from a mace-wielding newbie to a maxed scimitar build, all
  editable and saveable — and every creature's hit chances, damage, swings to
  kill and swings to die recompute against it. Two ways to describe one:
  **detailed** (attributes, skills, equipment) or **simple** (offence, defence,
  damage and health typed straight in). The panel pops out to ride along as you
  scroll, and collapses to a one-line summary. Columns can be shown, hidden and
  reordered. The arithmetic is `tools/calc.mjs`, which the generator and the
  browser both use, so the page cannot disagree with itself.
  It opens filtered to **monsters that actually spawn somewhere**.
  When it is served by the harness's `tools/m59-compendium.mjs`, a **live
  character** appears in the dropdown under "From the game" and is selected on
  arrival: its real attributes, the abilities the server has confirmed, and what
  it is genuinely wielding and wearing. Anything it has never learned counts as
  zero and the page says which, because every number in the table is computed
  from those. Absent everywhere else — the site stays static and works as files.
- **`zones/world-map.html`** lays the outdoor rooms out geographically by
  walking the compass exits declared in the source, and reports the seams where
  the world does not tile flat.
- **Zone pages carry a "Set piece" section** for the 53 rooms that run
  machinery of their own — timers with their periods, and the trigger
  rectangles the room tests, drawn on its map. Those rectangles are invisible in
  play and are the thing players guess at; `tools/setpiece.mjs` recovers them by
  parsing the room's own predicates, so a half-open clause clipped to the room's
  bounds is included rather than missed.

## Build it

```bash
node tools/build.mjs          # parse kod, decode sprites, generate every page
node tools/build.mjs --fast   # skip sprite decoding (slow, rarely changes)
```

The pipeline is four stages, each of which can be run alone:

| stage | script | produces |
|---|---|---|
| parse | `tools/kodparse.mjs` | `data/koddb.json` — 1,232 classes with their variables, resources and message bodies |
| sprites | `tools/bgf.mjs all` | `assets/img/*.png` + `data/images.json` — the first frame of every group of every `.bgf` |
| extract | `tools/extract-*.mjs` | `data/spawns.json`, `data/treasure.json`, `data/zones.json` — cross-references too expensive to redo per page |
| maps | `tools/roo.mjs` | wall geometry out of `resource/rooms/*.roo`, drawn as SVG (used by the zones module) |
| set pieces | `tools/setpiece.mjs` | room timers and trigger rectangles, parsed out of the room's own conditions |
| generate | `tools/gen.mjs` | the site |

`tools/gen.mjs` wraps two kinds of source into the same shell:

- `content/*.html` — hand-written guide fragments, one per system, become `guides/*.html`.
- `tools/derive/*.mjs` — one module per catalogue. Each turns `koddb.json` into an
  index page and one page per entity. See [`tools/derive/README.md`](tools/derive/README.md)
  for the contract; `tools/derive/spells.mjs` is the worked reference.

## Why it is built this way

The interesting facts about a Meridian 59 spell — its mana cost, its reagents, its
karma requirement — are never sent over the wire. `BP_SPELLS` gives a name, a target
count and a school; everything else is declared in kod and enforced server-side. The
same is true of armour resistances, monster difficulty and treasure tables. So a
reference that is *correct* cannot be assembled by playing; it has to be compiled
from the source, which is what this is.

The consequence worth knowing: when the game changes, re-running `tools/build.mjs`
re-derives the whole site. Nothing here is hand-maintained except the prose in
`content/`, and that carries citations so it can be checked the same way.
