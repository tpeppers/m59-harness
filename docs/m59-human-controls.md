# Human fleet controls

DBFST, the strategy-game DUM page, and authenticated in-game control all edit the
same reflective model served by the running DUM process. Reads and local edits
never change orders. **Reset to current** discards the draft and reads the actual
keeper and running DUM strategy store. **Save to live fleet** checks the process,
fleet and revision, applies only the patch, persists it and reads the keeper back.
No keeper restart is needed for these policy changes.

## Terminal and FleetScratch

Run `node tools/m59-dbfst.mjs --fleet <fleet>` or press **D** in `m59-tui.mjs`.
`node tools/m59-fleetscratch.mjs --dum` opens the same terminal. The broker discovers
the registered DUM controller; it never guesses a keeper port. Multiple controllers
require an explicit `--url http://127.0.0.1:<port>`.

Commands: `list vigor`, `next`, `show no food vigor floor`,
`no food vigor floor 70`, `room lock on`, `inherit order.buy_food`,
`templates`, `template create-food`, `patch`, `restart`, `reset to current`,
`save to live fleet`, `quit`. Booleans accept on/off; arrays and objects use JSON.
`agents <IDs separated by commas>` selects another group and reloads it.

Each DUM strategy has an automatically generated minor FleetScratch template.
Its `extends: strategy:<id>` identifies the existing behavior; `patch` contains only
the selected differences. These are declarative control patches, not JavaScript
programs or unattended scratchpads. Existing action/errand FleetScripts remain on
their existing compiler and lease path. The control patch never spawns a broker.

## Website

Select units, open the DUM tab, and use **Configure the DUM fleet**. Search controls,
select a strategy template, expand descriptions, stage changes, then Save. Show
after restart exposes the saved keeper policy and a fresh reading of DUM doctrine
files. Changing the roster selection leaves an existing draft intact and disables
Save until Reset loads that selection. Mixed per-bot values remain mixed until
explicitly edited. The page remains local because the broker is local.

## In-game

Launch a character with the terminal's **L** action so the broker recognizes the
live local client. Tell another bot `control`. It replies privately with
`confirm <bot ID>`. Confirm that bot, then use the same setting names, for example
`no food vigor floor 70`. `list vigor`, `show <setting>`, `next`, `changes`,
`reset to current`, and `save to live fleet` work by chat. `cancel control` exits.
Only one bot is active per operator; confirmation replaces the previous selection.

The broker verifies the speaker's object ID against a living local pilot process
for every command and every outgoing tell. A matching displayed name is not enough.
Sessions expire after ten idle minutes and do not survive broker restarts. No
stranger gets replies. Replies are bounded private tells; general small talk stays
under its existing opt-in policy. The chat reader consumes the keeper's real chat
ring, including tells and other speech channels, independently of chatter opt-in.

## Ownership and restart semantics

Keeper order edits become per-bot human overrides in DUM's ignored runtime control
file. DUM yields those keys before rule selection and at dispatch. Inherit releases
the pin, restores its pre-override value, and lets DUM decide subsequent changes.
Room lock uses the assigned farming room, falling back to the current room; off
clears confinement and releases DUM movement. Existing in-flight DUM writes must
finish before Save can claim those bots, so an old request cannot overwrite a save.

The restart column is a preview of current files, not a simulation of later world
decisions. Runtime and restart values can differ. External strategy file edits no
longer silently replace live state during reads; restart loads them. Saving from a
stale view is refused. Partial application is reported per bot with actual values;
reset and review before retrying after an error.

## Extending and testing

DUM `STRATEGY_CATALOG` supplies strategy options, types, descriptions and templates.
The broker's `autopilot` schema and actual policy fields supply keeper options.
New ordinary snake_case to camelCase fields appear automatically after process
restart; exceptional mappings belong in `reflectPolicy` aliases. Retired controls
are omitted, including the always-on safe-spot facility. All three UIs consume this
same schema; none has its own setting-name list.

Run `node tools/m59-human-controls-test.mjs` offline and the DUM human-control tests.
The no-supplies behavior is covered by `m59-purchase-funding-test.mjs`: a confirmed
unaffordable bill releases the trip, retains it for retry, preserves the farm
assignment and fed settings, and temporarily farms at `no_food_vigor_floor` (70).
