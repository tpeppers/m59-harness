# The boards and the planner

Split out of [`CLAUDE.md`](../CLAUDE.md). What each page can honestly answer, and which of them can write.

- **THERE ARE SIX BOARDS AND ONE TAB BAR, AND A PURSE HAS NO RECORD BUT THE SAMPLE.**
  `/` (fleet), `/deaths`, `/tougher`, `/economy`, `/skills` and `/stats`, all on the
  dashboard port (8902 — the MCP port serves only the fleet page). The nav, the stylesheet
  and the inlined treemap live in **`m59-page-chrome.mjs`**: a new board is one line in
  `TABS`, and it is one line because six hand-written copies of a tab list means the seventh
  board is invisible from whichever copy nobody remembered to edit. That had already
  happened once — the fleet page and the deaths page carried two separate copies.

  What each board can answer is decided by whether the quantity leaves a trace.
  **A bank balance does** — a banker says it aloud and `substrate/banks/` catches it — so
  `/economy` can report it with the broker down. **A purse and a pack do not.** Nothing
  announces an inventory, so their only record is the ledger sample, `recordSample` writes
  them, and a purse column full of dashes means the broker predates that code rather than
  that the fleet is broke. `/economy` is therefore the ONE board that asks the running
  fleet: the broker passes live rows in and they win, and the record answers when nothing
  is running. Reagents have a third source — every `cast` and `cast_declined` event states
  the caster's stock — and the row says which of the three it got, because a two-hour-old
  figure and a live one must not render identically.

  `/skills` reads `substrate/abilities/`, which exists because the numbers are PUSHED.
  **Read it for the atrophy**, which is the half nothing else would show: over a week the
  fleet gained 1846 points and lost 1558, with `relay` and `blink` losing hundreds and
  gaining nothing. The page never nets the two, because a fleet gaining 40 and losing 38
  is standing still and one number cannot say so.

  **`/stats` IS THE ONE BOARD WITH NO CLOCK ON IT, AND IT GROUPS RATHER THAN LISTS.**
  Attributes are fixed at creation and never move, so unlike a purse or a bank balance a
  reading of them cannot go stale — it reads `substrate/sheets/` and needs nothing live,
  carries no freshness pill, and takes no `?hours=`. It draws the client's own stats screen,
  read-only, one pane per **set of attributes** with every character rolled that way beside
  it: twenty-one characters here are **four builds** — 8, 5, 4 and 4 — and that shape is the
  finding, because it says how many bets this fleet has actually placed and a row-per-character
  table hid it behind a wall of repeated numbers. Two things it refuses to flatten. **A sheet
  with no attributes is not a build**: it is named apart, because `create automated` really
  does roll zeroes and "nobody has read this" must not render as "it rolled nothing". And
  **the tallest bar is not what a build is for** — every character in this fleet was rolled
  with 50 stamina, so stamina is the tallest bar in three of the four and distinguishes none
  of them; an attribute every build shares is stated once above the panes (one ceiling of 151
  for the whole fleet, which is why nine characters being stuck is a fleet-wide fact) and left
  out of the per-build line, where what remains is the attributes that build holds the fleet's
  best of. One build here leads in nothing at all, and no pane on its own could say so.

  The pane itself is **`compendium/tools/statpane.mjs`** — the same file the planner draws
  from, imported in node and inlined into `assets/statpane.js` + `assets/statpane.css` for the
  browser. Both panes therefore agree on the six stats, their order, the CSS and the three
  derived numbers (`101 + stamina`, `1700 + might*20`, points spent). The board's copy has no
  slider and no hatching, deliberately: attributes cannot move, so a bar you could drag would
  be offering a re-roll, which is the planner's job and not a board's.

- **THE PLANNER IS THE ONLY PAGE IN THE COMPENDIUM THAT CAN WRITE, and it looks like the
  game because it is editing the game's own four screens.** `compendium/planner/` rebuilds
  the client's right-hand panel — inventory, spells, skills, stats, same order, same stat
  bars, same stack counts in the corner of each cell — and everything in it is editable.
  It deliberately ignores the site's light/dark theme: the point is that it looks like the
  thing next to it on the desktop.

  `node tools/m59-planner-data.mjs` writes `compendium/data/planner.json`, which is what it
  reads: 22 skills with their requisite stat and level, 150 spells with school and level,
  202 items with weight, value and sprite, and the constants `PlayerCanLearn` runs on.

  **ITS STATS TAB IS NOT ONLY ITS OWN** — the fleet's `/stats` board draws the same pane,
  read-only, so `compendium/tools/statpane.mjs` owns the six stats, their order, the labels,
  the frame and bar CSS, and the three derived numbers. Same arrangement as `learn.mjs`
  below: imported in node by `m59-planner-data.mjs` and `m59-stats-page.mjs`, inlined into
  `assets/statpane.js` + `assets/statpane.css` for the browser. `planner.css` keeps only the
  editable half — the tab strip, the draggable bar, the hatching for a typed value — so a
  rule about the bars belongs in `statpane.mjs` or the two panes will drift.

  **THE LEARNING ARITHMETIC HAS ONE HOME**, `compendium/tools/learn.mjs`, imported by
  `m59-loadout.mjs` and inlined into `assets/learn.js` by the page's build — the same trick
  `creatures.mjs` uses for `calc.mjs`, and for the same reason. Three things about it:

  - **`POINTS_SLOPE` (7), `MIN_NEEDED_TO_ADVANCE` (75) and `piMaxLearnPoints` (16) are not
    in `koddb.json`** — the builder folds `.khd` includes and not a class's own `constants:`
    block. They are read out of the source tree with the line they came from, and stay
    `null` when it is absent: an invented cost curve reads as authoritative, which is worse
    than none. Anchor the regexes with `^[ \t]*`, not `^\s*` — `\s` matches a newline, so a
    declaration preceded by a blank line cites the wrong line, which is the one kind of
    wrong a citation must never be.
  - **THERE ARE SEVEN TRACKS, NOT SIX.** `iNeed` sums `GetLevelLearnPoints` over the six
    schools *and* over `iWeapon`, the highest `viSkill_level` of any skill known
    (`player.kod:10813`). A planner costing only the schools understates every build that
    has learned a proficiency.
  - **LEVEL 50 IS A SENTINEL AND IT IS FREE.** assess, thrust and kick declare
    `viSkill_level = 50` on a six-entry table — "granted, not sold", since `GetValue`
    doubles per level and 250·2⁵⁰ is nobody's price. `Nth(vlLevelPoints, 50)` falls off the
    end and returns NIL (`blakserv/list.c:178`), so that track contributes **nothing** —
    and because `iWeapon` is a MAX, knowing thrust *hides* the proficiency levels the
    character would otherwise be charged for. Clamping to the last entry is the natural
    thing to write and is wrong in the expensive direction.

  Two discounts sit outside the formula and are worth a factor of three: when the level
  below holds fewer than three abilities you cannot reach 297 at all, so `iNeed` is divided
  by 3 (prev level 1) or multiplied by 2/3 (prev level 2), `player.kod:10915`. That is why
  Faren level 2 costs Kermit 43 and Kraanan level 2 costs 129.


- **Communications** (/communications) retains incoming player, NPC/world-object, system and unknown messages by UTC day, with recipient/channel/text filters. It is loopback-only. See [incoming communications](m59-communications.md) for source evidence, retention, and receiver activation.

- **PVP** (/pvp) is every battle between this fleet and a player: our deaths to them, our kills of
  them, and every return-fire volley, refusal and hit between. Battles are grouped by time (ten minutes
  of quiet ends one, `?gap=` overrides it) and by shared enemy, and a battle may cross maps. It is
  loopback-only, because it names real players. **Our kills were recorded nowhere before it.** The server's
  kill line ("### Rick Deckard of the Human Resistance has been slaughtered by Gonzo of the The Second
  Swines in guild combat.", with the doubled article, system.kod:60) is a `message`, which the flight
  recorder refuses on purpose. Only a postmortem ever held one, and a postmortem is written when WE die.
  So each keeper now appends to `substrate/pvp/<fleet>/<UTC day>.jsonl` (gitignored), via
  `tools/m59-pvp.mjs`. It writes a death broadcast only when the line names that keeper's own
  character, so the line every keeper hears is written once. It also writes the PvP milestones of the
  combat mode. Our deaths come from the ledger as far back as it goes. War alarms are context: an
  enemy SEEN is not a battle, and a week of `war_flag` alone once read as forty battles in which
  nothing was hit. A battle rebuilt by hand from evidence that has since rotated away goes in
  `substrate/pvp/<fleet>/reconstructed/` and says what it was rebuilt from. The 0.49 s Rick Deckard
  volley of 2026-10-06 is the first.
