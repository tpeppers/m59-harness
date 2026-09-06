# The offline test suites, and what each one pins

Split out of [`CLAUDE.md`](../CLAUDE.md). All of these are safe to run any time; they open no socket and touch no roster.

## The one that never fails, and why it is not a contradiction

```bash
node tools/m59-todo-test.mjs            # the known blockers; exits 0, always
node tools/m59-todo-test.mjs --strict   # the same list as failures, for the day they come due
node tools/m59-repro.mjs --list         # and the command that reproduces each one
```

**A known blocker has nowhere to live in a green suite.** Written as an ordinary test it goes
red, and a suite with a permanent red in it stops being read — so the honest failures around
it lose their audience. Left out entirely it becomes a sentence in a commit message that was
true on the day and is now neither true nor false. That is exactly how the claim that room
108's gully "cannot get out again" survived: right when it was written, wrong within the
hour, and quoted for days after.

So `m59-todo-test.mjs` prints each blocker with what it stops, what was measured, **when**,
under **which movement epoch**, and the command that runs it again — and exits zero. It is
safe in front of every other suite and will never be the reason somebody skips them.

What it *does* assert is each case's **premise**, offline: not whether the blocker still
blocks, which needs a fleet and minutes, but whether the thing the case is *about* is still
there. `crowded-pipe` is about a corridor one square wide; if that corridor is ever three
wide the case is not fixed, it is meaningless. A changed premise prints `PREMISE CHANGED` and
is still not a failure — it is a summons to re-measure. (It earned its keep immediately: the
first version asserted rows 35–42 and was wrong, because 35 and 43 are four-wide junctions
and only 36–42 are single-file.)

The registry lives in `m59-repro.mjs` and is imported by the test, so the list you read and
the thing that reproduces it cannot drift apart. `m59-repro.mjs` is **not** an offline test —
every case joins characters and relocates bodies, and it refuses a non-loopback host.

## Coordinate compatibility

```bash
node tools/m59-coordinate-contract-test.mjs
```

This is the asymmetric contract test from issue #44 (18 assertions). It pins
movement-wire Y-then-X encoding and decoding plus the normalized named
`{x,y,col,row}` result, confirms room 563 is 34 rows by 76 columns, and proves
that geometry's `walkable(row,col)` sees valid `r34c65` and floorless `r30c61`
as two different squares. It also pins the existing route-pivot `[row,col]`,
edge-stage `[col,row]`, and safe-spot `"col,row"` encodings. It reads the
checked-in map; it does not regenerate or rewrite an artifact. The human
notation and all stable exceptions are documented in
[`m59-coordinates.md`](m59-coordinates.md).

For a coordinate-context change, also run the existing routing, geometry,
collision, and fixture contracts. They protect the positional APIs, parser
normalization, movement behavior, serialized route tuples, and command grammars
that documentation must not redefine:

```bash
node tools/m59-routing-test.mjs
node tools/m59-roo-bounded-test.mjs
node tools/m59-collision-test.mjs
node tools/m59-recordjam-test.mjs
node tools/m59-rts-broker-read-test.mjs
```

A coordinate-labeling change must not rewrite map geometry, route or fall-jump
records, fixtures, history, recordings, commissions, or fleet state. Human-only
underscore metadata such as `_coordinates` may be corrected without changing
the records it describes.

- Offline tests, safe to run any time: `node tools/m59-safespot-test.mjs` (187 — pins, among
  the rest, that **the safe walls are the red squares in the debug client**: `safeWalls()` is
  one function for the picture and the keeper's choice, `safeSpots()` iterates it with no
  membership gate, and the overlay has no second set that could drift from it),
  `node tools/m59-render-test.mjs` (81 — **what a renderer gets from a keeper-backed
  broker**, which for a while was nothing at all. Out-of-process keepers are the default and
  the broker holds a snapshot rather than a World, so `look` and `/rts/v1/read` answered a map
  with the keeper's `/state`: vitals, pack, skills, spells, and NO POSITION AND NO ROOM
  CONTENTS. Measured on prod with twenty-one characters in game, `/rts/v1/read` returned
  `looks: { t1: {}, ... }` for the whole fleet at status 200 — the strategy game drew an empty
  room for a fleet standing in it and reported no error. This pins the reshape from the
  keeper's `/room-view` into `World.perception()`'s shape: that a facing of 90 degrees is
  SOUTH, that the room's size comes from the `.roo` and not from the 50x48 the keeper sends
  for every room, that affordances come from the flag word through `affordances()` so a
  renderer can tell a merchant from a mummy from a bar stool, that an older keeper sending
  only two booleans gets exactly what those two booleans support and not one bit more, and —
  the rule with teeth — that an unavailable room view publishes NO `room` key rather than a
  null one, because this projection is folded OVER a state that does know the room and a null
  would overwrite a true answer with a false one. It also pins `keeperView`, the composition
  `look` actually returns — every field `arrivalReport` reads, exercised the way it reads
  them, because an ASYNC `view()` made `v.objects` a promise property and killed twenty-one
  of twenty-one travels with `Cannot read properties of undefined`; and the rule that a
  position from a room the character has LEFT is withheld and the disagreement reported,
  rather than handed to an arrival report as fact) and
  `node tools/m59-chat-test.mjs` (128) and
  `node tools/m59-rest-test.mjs` (38) and
  `node tools/m59-ledger-test.mjs` (25) and
  `node tools/m59-localpolicy-test.mjs` (71 — **the contract test for the overlay that
  separates this checkout's opinions from this repository's**: that an absent, empty or
  unparseable local file all mean the committed behaviour rather than an empty policy,
  that an unusable value keeps the committed one instead of unsetting it, that an
  unrecognised key is reported rather than dropped, and that no local file can move a
  mechanic or throw hard enough to stop a supervisor round) and
  `node tools/m59-handoff-test.mjs` (112 — **the contract test for lending a character
  without lending the password**: that the token is never on disk so a leaked grant file is
  an audit record rather than a key, that expiry is decided on USE and revocation on the
  next request, that `read` cannot order and an agent allowlist actually excludes, that a
  grant is FULL CONTROL by default and `--safe` is opt-in, and that a restricted tool whose
  destructive verbs are chosen by an argument is refused when the argument is omitted. It
  caught a real intermittent auth bug: ids were base64url, whose alphabet contains the
  token separator) and
  `node tools/m59-playdead-test.mjs` (23 — **the turn that makes a safe spot worth having**:
  playing dead buys safety by not acting, and the same flag that keeps the monsters off keeps
  HealthTimer off with it, so a freeze recovers vigor and NEVER health. Out in the open that is
  the whole trade. On a safe spot it is not: nothing can reach the square, so a TURN sets
  PFLAG_MOVED_SINCE_ENTRY and gives up no ground, and being unreachable AND healing is
  available there and nowhere else. So this pins that the reconnect actually TURNS — a
  reconnect is a fresh entry and the flag comes back clear — that it does not round-trip
  room-contents to verify a packet carrying no coordinates, that a second freeze from an armed
  spot is REFUSED because it would clear the flag the first one was reclaimed to set, and that
  coming back somewhere else gives up the hold rather than turning for nothing. The failure it
  guards is invisible from outside: the wall holds, nothing reaches us, and the health sits at
  four for ever) and
  `node tools/m59-follow-test.mjs` (26 — **leading the fleet by walking in front of it, and
  the one line that must not move**: say "follow me" while piloting one of your own and every
  fleet member in the room walks the squares you stood on. ONLY OUR OWN PEOPLE MAY GIVE THAT
  ORDER — `prod` is a shared server and this moves twenty bodies at once, so the speaker is
  checked against the ROSTER rather than against the text, a stranger who knows one of our
  names is still ignored, and a character will not take the order from itself. The rest is
  trail discipline: the queue is consumed from the OLDEST end, because walking AT a leader is
  a beeline and a beeline is exactly what fails in the rooms this exists for; passing near a
  crumb counts as reaching it, since insisting on the exact square is how a follower stalls on
  geometry the leader crossed at a different angle; and the last order in a batch wins, so
  "follow me" then "stop" means stop) and
  `node tools/m59-commute-test.mjs` (31 — **one rule, and every bug this driver had was a
  violation of it**: do not send a command to a character that is busy. `travel` supersedes
  whatever movement is in flight and the ledger calls that `movement cancelled by a newer
  command`; measured across three windows the commute driver was the LARGEST single cause of
  travel failure in the fleet — 54 of 183, then 18 of 34, then 33 of 56 — and what it
  cancelled were a character resting at a safe wall, one resting to full before setting out,
  and one still finishing the journey that had just delivered it. None of those three reads
  as "travelling", which is why `committed` is the authority and the activity string only a
  second opinion. Moving the busy check back after the arrival branch fails three of these) and
  `node tools/m59-blink-test.mjs` (18 — **a portal every room has, and the one way it must
  not be used**: that a kod file naming two rooms is REFUSED rather than guessed at, because a
  blink point on the wrong room would claim exits a character cannot reach; and that blink
  reachability never answers the walking question. `anchorReach` is what `transitOk` refuses
  a hop over and it still says no where walking says no; `anchorReachVia` returns the WORD
  'blink' instead, because casting costs mana, may need a rest to afford, and can fail — a
  caller handed a boolean would plan a route needing a spell and report it as a walk. Also
  that a room with no blink point recorded loses nothing, since most of the map has none) and
  `node tools/m59-tracks-test.mjs` (28 — **the monorail, which nothing tested until it was
  already wrong**: that RIDABILITY OUTRANKS TIME, in both arrival orders, because a crossing
  whose legs the mover refuses is not a quick one — it is `walkFine` groping between
  waypoints, which is the behaviour a track exists to replace — and that among equally
  ridable crossings the quicker still wins; that an unridable track is still KEPT when there
  is nothing better, and records how many of its legs cannot be sent, because a book with a
  hole beats no book; that a caller with no map gets a track marked unstraightened rather
  than one marked broken, since an unmeasurable leg is not a refused one; and that a
  struck-out track is refused while one strike short is still ridden. Ranking on time alone
  is defensible, was the rule for as long as the file existed, and left 578 The Cragged
  Mountains 31% ridable — nothing noticed, because a track that cannot be sent still looks
  exactly like a track) and
  `node tools/m59-dropall-test.mjs` (23 — **the one irreversible verb on the surface**: that
  an unknown equipment set REFUSES the whole operation rather than proceeding carefully,
  because `using` being null means the question was not answered and not that nothing is
  worn, and a drop planned against that puts a character's own armour in the road; that
  money is a FLOOR rather than a keep-list entry, so the caller that forgets it is covered;
  that a named reagent is kept while an unnamed one goes, which is why the list names
  `inky` and not `mushroom`; and that the result is judged by what LEFT the pack, since a
  drop is fire-and-forget and a refusal is prose or silence) and
  `node tools/m59-innerdoor-test.mjs` (38 — **a door that leads back into the room it is
  in**: that Castle Victoria is one room with a wall down it, that its trapdoor to the
  Underbasement is in a different region from every entrance so `anchorReach` honestly
  reports no walk, and that the only join is four `go` exits pointing back at room 38
  (castle1.kod:88-98). It pins the plan — one door, `r9c32`, from the body — and the two
  refusals that matter: no plan when the room declares no such door, and no plan when the
  target snaps more than three squares onto the floor, because `nearestWalkable` searches
  until it finds SOMETHING and an unbounded snap turns an unreachable square into a
  different one and then succeeds at going there. It also pins that `transitOk` now answers
  `null` rather than `false` for these rooms — `false` removes the room from the route
  graph, which is why `travel(41)` reported no route to a basement people walk to — while a
  room with no internal door keeps the hard refusal the bake earned. Eleven rooms declare
  one, and that census is part of the test: it is a class, not Castle Victoria) and
  `node tools/m59-travel-test.mjs` (71 — **one call is the whole journey**: that a refused
  doorway and an off-grid instant are re-settled and retried rather than returned, that a
  stumble is not a hop so re-settling cannot eat the room budget, that patience is bounded
  and the reason survives to the caller, that a journey whose last hop is also its last
  permitted hop reports arrival rather than "gave up", that exhausted candidate sets block
  only their exact directed hop and cannot be re-walked by the permissive route fallback,
  and that a cancelled movement still wins. Three cases cover the internal door: that it is
  opened when a hop's exit cannot be walked to, that opening one is NOT a hop — the body
  moved inside one room, so counting it would over-report every journey through such a room
  and spend the stumble budget on progress — and that a door which will not open falls
  through to the ordinary path rather than ending the journey. It lifts the real method out of
  `m59-broker.mjs` by brace-matching rather than
  reimplementing it, because that file cannot be imported without taking the fleet lock) and
  `node tools/m59-travelguard-test.mjs` (32 — **one character has one body**: that a second
  travel call is REFUSED while the first is in flight, and that both arms of the tool claim
  the same slot. `background: true` took a job slot and the foreground arm did not, so two
  travel calls on one character both ran — measured on arena as two journey ids walking one
  character to one destination at identical timestamps, each replanning against the other's
  steps. It is reached by the ordinary path: a travel runs for minutes, longer than a default
  HTTP client timeout, so a caller that gives up and retries starts a second one. Half the
  suite is STRUCTURAL — that the walk is spelled exactly once — because the mechanism was
  never broken and `startJob`'s own assertions pass on the buggy code; set
  `M59_BROKER_SRC` at a copy with the old path and exactly those two go red) and
  `node tools/m59-escapable-test.mjs` (4 — **from anywhere you can get to, you can get out**.
  This was FIRST WRITTEN AS A STEP-SYMMETRY TEST and was wrong: a step you can take is not a
  step you can take back, because you drop down a cliff in the Cragged Mountains and cannot
  climb it again, and `moverStepLands` models that deliberately. It reported 8% of that room
  as a defect; the 8% was the mountains. The true property is weaker — a cliff bottom is fine,
  you walk away along the bottom — so it floods FORWARD from every boundary square for what a
  body can arrive at, BACKWARD for what can still reach one, and the difference is the traps.
  Measured 2026-08-23: **1 in the Twisted Wood, 10 in the Cragged Mountains, 0 in the other
  two** — eleven squares, not thousands. A ratchet rather than a standard, so a mover change
  that starts manufacturing traps is visible and a fix shows as a number falling. Skips
  cleanly with no .roo files) and
  `node tools/m59-sincefull-test.mjs` (24 — **what the body did since it was last
  whole, and whether the moving went anywhere**. Health falling is in every reading here;
  none of them could say what the character was DOING about it, and on a journey under
  attack the job is exactly two things — keep going forward, or get to a wall. Both are
  movement, and movement is all a stillness detector can see. So the number is PATH against
  NET: ten squares walked ending ten away scores 1.0, and the 22<->23 oscillation walks the
  SAME TEN SQUARES and scores 0. One assertion exists only to say that out loud — the two
  are indistinguishable by distance walked and separated only by the ratio. Also pins that a
  room change is not counted as fifty squares of sprinting when the coordinate system starts
  again, that reaching shelter reports the seconds it took rather than a zero, that a second
  wall does not restart that clock, and that the window is measured between OBSERVATIONS
  rather than against the wall clock — which was a real bug in the first draft and would
  have reported every bleed slowing down at the moment the keeper stopped being able to see
  one) and
  `node tools/m59-travelling-test.mjs` (64 — **a journey steers a character; it does not
  switch off its will to live**. Every assertion is one line of Cccc's death record of
  2026-08-21: a commute driver saw him "stuck in room 1" — which is the UNDERWORLD — and
  re-sent a `travel`; `travelJob` called `goInert`, which switches the survival ladder off
  for the length of the walk; the keeper walked him out of the Underworld into an inn at 11
  of 37 and the journey walked him straight back out; six things ate him over twenty-two
  seconds at 27% health against a 70% flee threshold. The old rescue could not fire because
  it ALSO demanded four seconds of stillness, and his last pulses read `r3c23` / `r5c25` /
  `r5c26` / `r5c25` — a two-square shuffle that reset that timer on every sample. So this
  pins two
  things: that a journey takes `goTravelling` and an errand still takes `goInert`, and that
  none of the four mid-hop triggers asks whether the body is moving. The `flee` pair needs a
  character below the flee line and NOT inside two hits of death — 41 of 60, in the
  one-point gap between 40 and 42 — because Cccc at 10 of 37 was below both and is taken
  back whichever switch you throw, which is right for him and proves nothing about the
  switch. Half of it is STRUCTURAL for the same reason `m59-travelguard-test` is: the gate
  in `passUnderworld` is what routes a travelling keeper into the restricted ladder, and if
  it comes out every behavioural assertion above it still passes) and
  `node tools/m59-escape-test.mjs` (70) and
  `node tools/m59-combat-test.mjs` (383) and
  `node tools/m59-playbook-test.mjs` (37 — the three moments, the closed verb set, and
  the two rules that fail in the dangerous direction if inverted: silence means carry on,
  and an unknown condition never holds) and
  `node tools/m59-commitment-test.mjs` (71 — what counts as being spoken for, and the
  distinction between a bot OWNING a character and being mid-operation on it) and
  `node tools/m59-epoch-test.mjs` (20 — **the standard that decides which evidence is still
  about the code in play**, and the mechanism's whole job is to throw measurements away, so
  every way it can be wrong is expensive in one direction or the other. THE THREE ANSWERS
  ARE THE POINT: `sameEpoch` returns true, false, and `null` for "this checkout cannot say",
  and a caller that reads `null` as *stale* empties the ledger on every clone that has no
  `.git`. Pinned here in both directions — a row from a superseded `#movement` commit is
  dropped **however recent it is**, and a fortnight-old row from the current epoch is
  **kept**, because the clock does not overrule the commit. Also pins that the exit-gap book
  says WHY it reset a row: "movement code changed" and "no sighting in the window" are
  different facts, and a zero meaning *fixed* against a zero meaning *untested* is exactly
  the confusion that made Ukgoth's north door read `refused 182, crossings 0` on a day it
  crossed six times out of six. See [`m59-evidence.md`](m59-evidence.md)) and
  `node tools/m59-which-test.mjs` (27 — **the gate every `/m59*` command runs first, and the
  one tool that may never name the wrong fleet**. It builds a throwaway checkout in TEMP and
  runs the real `m59-which.mjs` against fake brokers, so it opens sockets only to itself and
  cannot see this machine's rosters. Two defects lived in one line — `live.find(x =>
  x.health.fleet === label) ?? live[0]` — and each fails in a different direction. The
  fallback meant that when OUR broker was slow to answer, an UNRELATED one was picked up and
  reported as the answer: measured here, prod's `/health` takes 1046ms idle and 2573ms under
  load, because it is the busy one and that is exactly what makes it the one that matters,
  while an idle broker on another port answers in 4ms — so a missed probe printed `MISMATCH:
  the broker is holding "shadow"`, naming 21 entirely different characters, about one run in
  four. The `find` matched on the fleet LABEL, which CLAUDE.md says outright is not an
  identity, and THAT one fails to an all-clear: run against the old code, a second checkout's
  broker calling its fleet "prod" while serving a different roster returns **exit 0**. So this
  pins that a broker is ours only when its `/health` state path resolves to our roster file,
  that an unreachable port is INDETERMINATE and never a statement about a fleet, that a
  disagreement between the socket and the records on disk is refused as the shape of a second
  broker on one fleet, that a lock whose live pid started long after the lock was written is a
  recycled pid rather than a holder — the process start time is 1ms from the pid file's own
  timestamp, because `m59-service.mjs` writes it as it spawns — and that nothing listening
  anywhere is still exit 0, or `./m59.sh up` could never start a fleet) and
  `node tools/m59-proxymutate-test.mjs` (59 — **the emulated client could not ACT, and eight
  MCP tools died on that**. `KeeperProxy.need()` hands its picture client to every tool that
  acts on something, and it implemented the reading side only — so `fight`, `attack`,
  `rest`, `escape_underworld`, `cast`, `shop`, `act` and `faction_status` threw a TypeError
  in the broker before a byte reached the wire: `c.roomContents is not a function`,
  `c.attack is not a function`, `c.apply is not a function`, and four more. Measured over
  ~4 hours of supervised play: no usable mutation path at all, on the only kind of
  character a running fleet has. Three things had to exist for the fix, and this pins all
  three. THE METHODS, each forwarding to `/action` — the same route the movement tools have
  used since the keeper split, so the broker still never touches the wire — with the
  argument names checked on BOTH sides, because a mismatch there is invisible (the keeper's
  own `travel` case records `toRoomNum` against `to` sending every journey nowhere while
  the fleet blamed the terrain). THE EVENT WINDOW, because sending the packet is never the
  whole of a tool here — a merchant refusal is a sentence spoken to the room — and
  `waitFor` used to answer "there is no event stream here", which eighty-odd call sites
  read as "nothing happened"; it now asks the process that owns the socket, and keeps the
  empty shape with `no_event_stream` as the fallback so an older keeper still reads as
  "nobody could hear" rather than "nothing was said". AND THE REAL SELF OBJECT ID, which is
  the half that would have gone wrong quietly: `selfId` was the placeholder `-1`, harmless
  only while this client could not act, and `apply(food, selfId)` is how EATING works
  (food.kod:56) — the only way past the vigor-80 rest cap. Both ends now refuse to forward
  a negative target) and
  `node tools/m59-policyrevert-test.mjs` (42 — **a spot policy that reverts has to leave a
  line, and for the two flags that have killed people it has to name the writer**. The
  persistence layer logged exactly one transition, `autopilot.mode`, and the comment beside
  it says why: a silent revert "was the undiagnosable part". That argument was never
  carried to the rest of the policy, so `useSafeSpots`/`requireSafeWall` going `true/true`
  -> `false/false` between two writes left NO line anywhere in the broker log, by
  construction — and those are the flags deaths #24, #25 and #26 were root-caused to.
  Death #26: room 586, centipede, `in_safe_spot: false`, every trial reading "not holding a
  spot — nothing to test", pinned in the open ~18 minutes, after a re-arm 19 minutes
  earlier had VERIFIED both flags true. Pins that the diff covers EVERY field rather than a
  watchlist — a watchlist is how `purpose` stayed out of a schema for a year with every
  keeper's audit switched off — while sorting the survival pair to the front and reading it
  in the order the policy is reasoned in rather than alphabetically; that a key appearing
  or disappearing is a change and not a silence, which is what a revert actually looks like
  on disk; that `requireSafeWall` without `useSafeSpots` is coerced UP rather than down,
  because a caller that asked for a wall asked for MORE caution and clearing the stricter
  flag would answer that by removing it, while the other three combinations are all
  meaningful and are left alone; and that the keeper's one `policy updated` line now
  carries before -> after and names the writer, which is the third reserved key on the
  wire beside `agent` and `mode`) and
  `node tools/m59-phantom-test.mjs` (40 — **one mistyped agent name used to degrade every
  health check for the life of the broker process**. `session()` minted a bare `Session` for
  any non-empty string, and a bare session can never be in game, because nothing ever tries
  to join a name the roster does not know. So naming the CHARACTER (`JohnsSlave`) where the
  AGENT (`psycho`) goes — the fleet page prints both — got `agent "JohnsSlave" is not in
  game — call join first`, which is a sentence about a CONNECTION for a fault that is a
  NAME, and sends a monitoring layer to rejoin a character that was never unwell. Two calls
  one second apart, same broker, same character, answered "fine" and "call join first". The
  phantom then outlived every 45s sweep — the sweep iterates the ROSTER — while
  `m59-service.mjs status` printed "the broker rejoins them on its own; watch the log" about
  a row it could never reach. Pins that an unknown name is refused before any session
  exists and that the refusal NAMES the agent whose character that is, that `join` and
  `create_character` keep the exemption because introducing a new name is their job and
  nothing else claims it, that a never-joined session stops blaming the connection, and that
  `status` counts and rejoin-promises only rows the sweep can actually see — failing OPEN on
  a broker too old to send `in_roster`, because reading undefined as "not mine" would report
  an empty fleet, which is the louder bug. The rule itself is in `m59-agent-name.mjs`
  precisely so it can be asked a question without starting a broker) and
  `node tools/m59-wedge-test.mjs` (66 — **a wedge broken by a cancel is a wedge re-issued**.
  The watchdog's second arm breaks a healthy wedge with `cancelMovement()` "so the next
  pass can decide with real numbers", and the numbers were identical — same square, same
  room, same destination — so the next pass issued the same walk and the arm broke it
  again: 589 times in 93 minutes on one character, then 18 minutes on one square with
  seven threats in the room and every decision-trail entry a variant of "moving to
  somewhere I can heal", dead to a centipede mid-"travel" (issue #37). Pins that both
  arms record WHERE they broke a wedge and count consecutive breaks at that place with the
  pinned radius (`noteWedgeBreak`), that `travel()` reads the record at its single gate
  before setting out (`answerWedge`) — below `WEDGE_REPEAT_CAP` the body is sidestepped two
  squares in a rotating direction so the plan starts from a square that has not wedged, at
  the cap the walk is refused once out loud and every walk from that place is refused fast
  until `WEDGE_GIVEUP_HOLD_MS` expires, after which the count starts fresh rather than the
  refusal becoming permanent; that moving away drops the record and an unknown position
  does not; that `wedgedInPlace` answers from four signals because the arm only fires at
  full health; that `tradeInPlaceIfWedged` swings at the nearest thing in reach when hurt,
  wedged and unsheltered — and not otherwise — holding position and never disengaging; and,
  by source, that the ladder reaches it BEFORE every rung that answers being hurt with
  distance, because a rung that exists and is never reached is what the second incident
  was made of. The fake mover MOVES the body, so "did the sidestep change the start
  square" has a real answer) and
  `node tools/m59-lasterror-test.mjs` (28 — **`last_error` is the field the status snapshot
  calls "the one field worth reading before anything else", and it was write-once for the
  life of the process**. Set in two places, cleared in one: the constructor. So it meant
  "the most recent error ever" while every reader — operator, hourly strategy review,
  ten-minute play tick — read it in the present tense. And the error it holds is usually a
  survival FEATURE firing: `breakOutViaLogoff` leaves a crowded spot via reconnect(), which
  nulls the client for ~800ms, so the in-flight pass throws. Sixteen of those in 58 minutes
  of healthy farming; six minutes after one, the same process reported "fighting from a
  proven safe spot", 4 kills, 0 deaths — and the identical stale error. Pins that a
  completed pass on a LIVE session clears it and leaves a `recovered` journal line, that a
  completed pass on a session that is NOT live does not (a pass can finish without touching
  the wire, and the class being cleared is exactly "the session went away"), and that the
  error is stamped and attributed — `last_error_live: false` is the self-healing reconnect
  window, `true` is a fault the session was awake for, and a climbing `failing_passes` is
  the genuinely dangerous case that used to look identical to the blip. It drives the real
  `notePassSucceeded`/`notePassFailed`, which were named for this: the catch arm sleeps five
  seconds, so a test going through `loop()` could ask one question a working day) and
  `node tools/m59-unattended-test.mjs` (44 — **the contract test for the carve-out**: with
  no bot attached every faculty answers `keeper`, a bot asking for all eight gets only the
  directional four, an expired lease is the keeper's again, and the override takes a
  character back rather than letting the next heartbeat reclaim it. It should fail the day
  somebody moves a survival decision out of this repository) and
  `node tools/m59-deaths-test.mjs` (82) and
  `node tools/m59-stream-test.mjs` (54) and
  `node tools/m59-ability-test.mjs` (44) and
  `node tools/m59-compendium-test.mjs` (42) and
  `node tools/m59-prey-test.mjs` (56) and
  `node tools/m59-spellaudit-test.mjs` (28) and
  `node tools/m59-localclient-test.mjs` (65 — the last ten spawn REAL processes named
  `Meridian.exe`, because every failure mode of the POSIX scan is invisible to a fixture.
  **A PROTON LAUNCH IS SIX PROCESSES, NOT ONE** — reaper, srt-bwrap, pv-adverb, proton,
  steam.exe, the game — all repeating one command line, so a naive count reads six clients
  and refuses to claim any of them; the identity is the ACCOUNT. Only the last of the six
  has the executable at `argv[0]`, and that is the one a claim must bind to, because a
  claim is released when its pid exits. A process that merely mentions the client, like a
  grep or `m59-shortcuts.mjs --show`, must not be claimed off flags that are only quoted
  text. And the cap counts CLIENTS, not processes: at eight raw matches the second
  person's launch truncates mid-chain. The fixture symlinks `/bin/bash`, because a
  `#!/bin/bash` script runs with `argv[0]` = `/bin/bash` and would have tested the wrong
  shape. **The scan reads the whole machine**, so the assertions are scoped to accounts
  nobody plays — a live Kermit failed five of them by being correctly detected) and
  `node tools/m59-bank-test.mjs` (52) and
  `node tools/m59-supply-test.mjs` (115 — **moving supplies between two characters one broker
  is driving, on the architecture production actually runs**. `supplyBetween` was written when
  the broker WAS the keeper and the pacer and the socket; per-character keeper processes have
  been the default since the split, and on that arrangement the exchange could not move a
  single item — while, in each case, failing in a way that sounded like the game's fault. The
  keeper hold was a SILENT NO-OP (`autopilotIfAny` answers undefined for a keeper-backed
  character, so nothing was stopped and both keepers drove straight through a four-step
  handshake any one of their actions cancels), `waitFor` resolved null, `roomContents` was not
  a function, the four trade packets did not exist on a snapshot, and `travelExclusive`
  returned the JOB WRAPPER so `t.arrived` was undefined and a walk that worked read as a
  refusal. This pins the fixed version against fakes of BOTH kinds of session: the handshake's
  order — accepting before the counteroffer arrives is logged by the server as cheating — that
  a delivery is judged on an arithmetic difference in the receiver's own count and never on a
  name it already carries, that whoever is standing still is held and the WALKER IS NOT
  (`goInert` switches the survival ladder off, which is the Cccc post-mortem), that a hold
  another errand holds is left alone but our own is RENEWED by presenting its token — an
  inert keeper wakes on a deadline, and a hold taken before a five-minute walk lapses in the
  seconds between arriving and offering — and that both ends are handed back on every path
  out including a throw. And the offer encoding, which cost a live run: THE TEST IS THE TAG, NOT
  WHETHER THERE IS MORE THAN ONE. A stack with ONE left carries amount 1 and went out as a
  bare id, which contributes nothing to the parallel number list the server pairs
  POSITIONALLY against the ids it thinks are NumberItems — so one untagged stack slides every
  count after it onto the wrong item and the whole offer moves nothing. Measured on shadow:
  Hhhh, holding one elderberry and one herb, could hand Jjjj neither, in either direction,
  with the handshake completing and `may_accept` true both times. Nobody was full; the packet
  was malformed. It is a separate file from `m59-broker.mjs` for the reason this whole
  document exists — that file cannot be imported without starting a broker, and a rule nobody
  can ask a question offline is how a no-op hold survived as long as it did) and
  `node tools/m59-policypush-test.mjs` (20 — **does an order reach the process that will obey
  it?** `autopilot action=start` wrote to exactly two places and neither of them was the
  character: the broker's own in-process Autopilot shell, which on a keeper-backed broker
  drives nobody, and the roster on disk, which a keeper reads ONCE at startup. So a policy
  change applied cleanly, persisted correctly, answered `running: true, mode: "farm"` — and
  the keeper went on running the orders it booted with. Measured on prod 2026-08-26: nine
  characters in Familiars switched to farm / "fungus beast" / `assigned_room` 544 /
  confinement released were right on disk and all nine were still `survive` with the old
  confinement in the live keeper a minute later, with nothing erroring anywhere. The second
  half of the bug has a longer fuse: `join()` ends by re-imposing the roster snapshot the
  keeper process read at STARTUP, so a push that updated only the live Autopilot object works
  and then silently reverts at the next rejoin sweep, phantom recovery or pilot hand-back —
  which is why the boot orders are `let` and the push moves them too. This pins both halves,
  plus the three things that make the push safe rather than merely present: that the write is
  identity-stamped and refused BEFORE it applies anything, because `keeperPort()` falls back
  to a guessed port and a policy is the least visible thing you can change on a stranger's
  character; that `mode` and `agent` are stripped out of the body so neither can land in
  `policy` as a key that looks authoritative and is read by nothing, which is how `purpose`
  sat outside a schema for a year; and that the wire format stays FLAT, because an older
  keeper handles the body as `Object.assign(autopilot.policy, body)` and a `{policy:{…}}`
  wrapper would make every keeper predating the change silently ignore the whole order. It
  reads source rather than opening a socket, for the reason this document exists — the
  behaviour needs a live broker and a live keeper, and this has to be answerable on a clone
  with no fleet) and
  `node tools/m59-lru-test.mjs` (26 — **the broker's geometry cache has a ceiling**.
  `_walkableCache` was a bare `new Map()` with no eviction, and its name undersold it: nine
  key prefixes, and the largest entries are whole decoded `.roo` rooms, one per room per
  prefix across 264 rooms, resident for the life of the process. Not a runaway leak — it is
  bounded by the world — and exactly the shape that hurt anyway. Measured on prod
  2026-08-27: the broker at 0.8-1.4 GB RSS taking ~10,700 page faults a second while Windows
  trimmed its working set, and a full GC over a heap that size produced a **736-second**
  event-loop stall. The tell was the shape of the failure — connections to 8901 were
  REFUSED, not slow, while the port sat listening, which is the accept backlog filling
  because nothing was calling `accept()`. This pins that the ceiling is enforced on the way
  in and that what falls out is the least recently USED rather than the least recently
  written: the fleet stands in a handful of rooms and asks about them repeatedly while a
  room-view sweep drags in a long tail, so insertion-order eviction would throw away the
  room the fleet is fighting in and keep the sweep's leftovers — trading bounded memory for
  a `.roo` re-parse on the one event loop every session shares, which is the worse bug. It
  is its own module for the reason this document exists: `m59-broker.mjs` cannot be imported
  without taking the fleet lock and starting rejoin timers) and
  `node tools/m59-describe-test.mjs` (52) and
  `node tools/m59-recordjam-test.mjs` (43 — **turning a live traffic jam into a fixture**:
  that `m59-recordjam.mjs` reads its documented region grammar as `col,row` (one of the
  repository's stable legacy positional encodings), collapses a run of
  samples to what stood still and what wiggled (a trace of position CHANGES with when each
  was first seen), counts a player once however many observers saw it while keeping two
  same-named rats apart by id, redacts our names to `player A…` and other people's to
  `stranger A…` unless `--names`, and measures the floor under the region off the real BSP —
  against the Sewers of Barloque, the rat picket line it was written for; and that **every
  jam fixture on disk stays redacted**: each player in `tools/fixtures/*.json` is a role and
  never a name, because a file that was clean when written is the one nobody re-checks —
  `spidertrap1.json` is pinned with its subject's square, vitals and load and the black
  spider three squares west of it) and
  `node tools/m59-fightback-test.mjs` (36 — **the fight-back edict**, an operator's order
  that is off by default: that the watchdog half counts blows only with something in reach,
  asks for a fight at ten seconds and not nine, pulls the handbrake once per pass, and stays
  silent below the flee line, while fighting, and under an errand; and that the pass half
  answers with the nearest thing inside the engagement band, fights in place from a wall,
  bookkeeps a kill exactly as passFarm does, and steps aside for the survival ladder, for an
  unarmed character, for a stale request, and for a target the band refuses) and
  `node tools/m59-party-test.mjs` (95 — pairing, shared walls, armour ranking, and **who is
  us in a process with no broker in it**: that the file-backed roster source the keeper
  process installs names every roster character and nobody else, folds case, follows the
  file's mtime, keeps its last answer when the file cannot be read, and that a red
  fleet-mate with a grudge on file is refused as "one of ours" — the assertion that was
  missing when the fleet killed Statler; it reads `m59-keeper-process.mjs` to check the
  source is still installed) and
  `node tools/m59-hits-test.mjs` (41) and
  `node tools/m59-devclient-test.mjs` (31 — the one file every patched-client launch goes
  through: that `shortcuts/dev.bat` names no character and carries no password, that its FOR
  variable is `%%a` and not the `%%%%a` the first version wrote — which cmd rejects, so every
  launcher it generated died on its endpoint lookup before starting anything — that a
  per-character file is one `call` line with the five arguments in dev.bat's order, and, on
  Windows, that the generated file actually runs: usage and exit 2 on too few arguments, exit 3
  with a message when no client is built, and under `M59_DEVCLIENT_DRYRUN` the endpoint it
  resolved and the account it would log in as, never the password) and
  `node tools/m59-loadout-test.mjs` (126 — the loadout format, the learning arithmetic, the
  composed sell decision, and the fleet-wide gear write, against scratch directories; it sets
  `M59_LOADOUT_DIR` so it never reads the real one, which a live keeper is reading every
  pass) and
  `node tools/m59-coordination-test.mjs` (25 — what the fleet is short of, who is near
  enough to be handed it, and how far a courier walks: that a loadout shortfall of any kind
  reaches the board with its quantity, that the neighbourhood is polled nearest-first, and
  that a stale declaration and a zero shortfall are both refused as delivery orders) and
  `node tools/m59-grudge-test.mjs` (48 — **the contract test for the only code here that
  can make a character hit a real person**: that `PF_*` is read as an enum so a Dungeon
  Master is never mistaken for a murderer, that a grudge and a live flag are BOTH required
  and neither alone is enough, that the hour is measured from the last blow, and that a
  fleetmate is refused before anything else is asked) and
  `node tools/m59-townrun-test.mjs` (15 — **which counter a town trip is aimed at, and what
  the errand costs**: that a reagent shortfall goes to the apothecary and never to a market
  that cannot sell it anything, that an empty purse sends it to a bank FIRST, that a full
  pack still goes to Roq, and that the bill the trip and the withdrawal both read has one
  home. See [`m59-economy.md`](m59-economy.md) on a trip that cannot fix the thing that
  opened it) and
  `node tools/m59-tuning-test.mjs` (43 — **the contract test for a config surface built to be
  edited in a hurry**: that an absent, empty or unparseable tuning file all mean the profile
  rather than an empty policy, that `flee_below: 60` (somebody typing a percentage) is refused
  rather than applied as 6000%, that a typo'd key is reported while the good key beside it
  still applies, that a character line beats a profile line beats a default and the plan says
  WHICH won, and that a refused `--set` leaves the file exactly as it was) and
  `node tools/m59-profiles-test.mjs` (87 — **the contract test for a posture whose whole
  value is in what it REFUSES**: that the town is a curated room set rather than a name
  match (the Deep Dark Woods *of Tos* is wilderness; Familiars and The Crypt are indoors
  and say neither), that a farm room outside the walls and a character standing outside
  them are both refused rather than quietly walked, that an unknown current room is the one
  thing allowed to be a note instead, and above all that every one of the thirteen policy
  fields which can walk a character out of a room is still suppressed — a list that grew
  one death at a time and passes cleanly if somebody adds a fourteenth) and
  `node tools/m59-guild-test.mjs` (192 — **the contract test for a command space that
  refuses in total silence**: that the permission check runs off the server's own bitmask
  rather than the rank table, that invite is LORD while exile is LIEUTENANT, that
  `set_password` inherits MASTER from a declaration it does not make, that UC_GUILDINFO's
  conditional password branch reads to the last byte on both shapes, that the ten rank
  titles are five ranks × two genders in packet order, that mutual enemies and one-sided
  declared enemies stay apart, and that induction is serial because the game makes it so.
  that the rent sign survives two overlapping negative sentences, and that the Bookmaker's
  own rent override is not the non-PK doubling in disguise. Founding costs 5,000 and cannot be
  undone and a hall is 25,000, so none of it can be learned live) and
  `node tools/m59-economy-test.mjs` (73 — the Economy and Skills boards, the one
  tab bar all six boards share, and the pack drill-in: that it names what is in the pack
  rather than only how full it is, and that an EMPTY pack, a character the broker is not
  holding, and a broker too old to report the list are three different sentences) and
  `node tools/m59-stats-test.mjs` (60 — the Stats board and the pane it shares with the
  planner: that grouping is the six numbers and not the level, that a sheet with no
  attributes is never folded in as a zero roll, that a roster character with no sheet at all
  is named rather than silently absent from a page of percentages, that the read-only pane
  carries neither a slider nor the hatching that marks a typed value, and that the ceiling and
  carry arithmetic have one home. Runs against scratch sheets, never the fleet's own) and
  `node tools/m59-backup-test.mjs` (42 — backing the rosters up and putting them back,
  against scratch directories; never touches a real fleet) and
  `node tools/m59-testbed-test.mjs` (104 — the DM command vocabulary, the patrol ring, the
  scenario spec and the arena reply. **Opens no socket, deliberately**: every live failure
  these three tools have had was "the command we sent was not the command we meant" — a
  room object id read out of a reply header, a karma figure a hundred times too small, a
  name with a digit in it that the server accepts and silently replaces — and all of those
  are decidable from a string) and
  `node tools/m59-buyers-test.mjs` (38 — **what a merchant will actually buy**: that a gem
  is also a reagent and the apothecaries' exclusion turns on it, that Marion's smith takes
  no body armour, that an exclusive rule excludes a sibling of the same family, and above
  all that "cannot say" falls through to OFFERING. The two failure directions are not
  symmetric — a wasted offer costs a round trip, a wrongly withheld item costs the sale and
  is invisible) and
  `node tools/m59-merchants-test.mjs` (77, dropping to 43 without `M59_ROOT`) and
  `node tools/m59-city-matrix-test.mjs` (123 — the loopback/DM safety boundary, exact
  25-pair parallel schedule, 150-leg serial schedule, exact staging square, authoritative
  in-process broker/DM identity, fresh trace lifecycle, protected report paths,
  clean-prefix resume contract, that the run holds the fleet run lock before it writes or
  asks anything and is refused naming the holder, and that every leg it sends is the walk
  alone — `run_errands: false` — while `runLeg`'s other callers keep the broker's default.
  **Opens no socket and touches no roster**) and
  `node tools/m59-collision-trace-verify-test.mjs` (44 — an entirely synthetic matrix,
  JSONL capture, map and BSP pin the offline proof: nested runner reports, stable room
  identity across object-id renumbering and reuse, exact off-map exits, collision replay,
  complete sequence evidence, trace loss, callsite and pair coverage, broker-observed
  fallback and single-writer policy, repo-rooted paths, and atomic private verdict output)
  and
  `node tools/m59-collision-trace-test.mjs` (49 — tracing is off by default, failed writes
  recover in order with durable loss markers, the physical cap survives restart, trace
  files are private, every actual send has a validated or explicitly unsafe wire row, and
  broker health publishes the effective trace and exit-fallback settings) and
  `node tools/m59-collision-test.mjs` (333 — **the fail-closed contract for all
  movement**: compact collision metadata survives a bake, legacy maps cannot authorize
  a coordinate packet, the player cylinder catches wall bodies and corners, long strides
  cannot tunnel, stock endpoint-0 slope and water-depth rules are preserved, every
  emitted packet is revalidated, a body on `walkFine`'s direct line comes back as
  `object_blocked` after three fans rather than a shuffle that spends the budget, **the
  client's own object rule is transcribed rather than modelled** — endpoint not swept,
  ending inside the zone allowed while moving away, and a slide instead of a refusal,
  all of `clientd3d/move.c:666-697` — and the documented Brownestone, Limping Toad, Icky,
  Farol, Ukgoth, Cor Noth, Temple, and Fey precision cases remain usable),
  `node tools/m59-needle-test.mjs` (30 — **getting past a body without treating its square
  as blocked**. You may share a SQUARE with a spider, never a fine position, so a corridor
  one square wide with a body in every square is still walkable. Pins the arithmetic
  (`MIN_NOMOVEON`, 16 kod, one exclusion zone — not two player radii, which is the wall
  rule and double the truth), that the .roo under a "one square wide" corridor is 82 to 110
  fine units rather than 64, two hand-built dead-centre configurations, a 200-corridor
  randomised sweep against an independent breadth-first search, and a negative case — three
  bodies abreast in one square — without which a modelling artefact let a body teleport
  through them. **Its verdicts have been wrong three times and a person walking the corridor
  caught it every time**; `tools/m59-needle-lay.mjs` lays any of those nine out on a live
  server so that keeps being possible) and
  `node tools/m59-routing-test.mjs` (90 — **the contract test for planning on the map the
  mover enforces**: that `moverStepLands` and not `stepAllowedByCollision` is the question
  that decides anything, that the quantizer has one answer for the planning half and the
  sending half, that a mask round-trips bit for bit and one of the wrong size is refused
  rather than mis-indexed, that with no mask the router plans exactly as it did before any
  of this existed, that a refusal removes an EDGE and not a SQUARE, that the tiny pockets
  against the walls are kept because they are the safe-spot signal, and that an exit a bake
  cannot reach is still OFFERED — a bake must never be the reason a doorway disappears, and
  that the clearance preference routes further from the walls while never removing a route) and
  `node tools/m59-impossible-test.mjs` (126 — **the polarity the 153 collision assertions do
  not cover**: every one of those asserts a legitimate move REMAINS USABLE, so that suite
  passes cleanly on the day the walls stop working. This one asserts refusals, by checked-in
  fine traces that each name the wall index that refused them, with controls in the same
  rooms out of the same bake — because a suite that only asserts refusals passes perfectly
  when everything is refused, which is the fleet standing still. Observation cannot be the
  oracle: another client's view of a player phasing through a wall is lag compensation) and
  `node tools/m59-safewall-test.mjs` (15 — **the mechanism, on real geometry, against
  squares characters actually held**. The other 141 safe-spot assertions are about the
  BOOK-KEEPING and the mechanism itself is tested only on synthetic grids, so nothing
  asserted that what the fleet stands on in the real world is a safe wall. It reads the
  book and the baked map: every held square is still nominated, a held square offers
  materially more unanswerable shots and more wall at its back than ordinary floor in the
  SAME room (3.24 vs 1.49 and 3.46 vs 0.85 across 37 rooms), and the chooser still lands on
  one. Its last section is the guard against the routing preference leaking back into the
  tactical questions and teaching the fleet off the walls — flip `path`'s clearance default
  back on and it goes red on 302 of 395 walks) and
  `node tools/m59-breadcrumb-test.mjs` (51 — **the contract test for getting out of a safe
  spot**: that a crumb is recorded at the one choke point every move passes through, that a
  retreat cannot invent an impossible traversal because every step goes back through the
  fine validator, that a broken trail is dropped whole rather than skipped, that it stops
  the moment the route reappears, and that a genuine dead end still reports itself.
  **Its last section lifts `selfOrResync` and `refreshRoomIdentity` out of the broker source
  and RUNS them**, which is the only way this class of fault is visible: both sent an
  identifier that is bound nowhere in that file, so both threw ReferenceError the moment
  they were reached — and both are recovery paths, so they could only fail once something
  else had already gone wrong. Every other assertion here about losing our own position
  drives the FIXTURE's stub of that method, and passed perfectly throughout) and
  `node tools/m59-pulse-test.mjs` (47 — **is the character moving, asked of the character**.
  Every other stall number measures the KEEPER. Most of the file is the exclusions, because
  a detector that shouts when somebody sits down gets switched off before the day it was
  needed: resting, fighting, trading, waiting and holding a safe wall are all silent, and a
  wall held for a full minute raises nothing. Its newest section is the one exclusion that
  was WRONG — `inert` meant an errand or a bot owned the character, and the pulse stood down
  for it, so two characters bled out stationary in The Flatlands with `wedges: 0` and
  `stood_down_for: "travelling to The Streets of Tos"` in both post-mortems. Inert now
  excuses standing still and not standing still while losing health, with steady health,
  healing, and genuinely leaving the neighbourhood all still silent. Two assertions in that
  section exist because the first implementation was useless and only the counters said so:
  a wedge must survive a painless second, since damage and the pulse both land about once a
  second and the excused branch clears the episode; and the body test must see a character
  ALTERNATING between two squares, which the exact-square comparison reads as movement. Its
  two newest assertions guard a ring that now serves TWO questions on two widths: the ring
  was widened to six samples so `damageRate` could read half a point a second off five
  seconds of it, and `pennedIn` kept the newest three — because that test gets STRICTER as
  the ring grows, so widening it too would have switched off the handbrake it feeds while
  every assertion here stayed green. Both constants are read out of the source rather than
  copied, and the pattern that reads them uses `[0-9]` rather than an escape because it
  lives in a template literal, which eats the backslash before RegExp sees it) and
  `node tools/m59-roo-test.mjs` (74, with raw-room checks skipping without a copy of the game's
  `resource/rooms`). The rest need a live server —
  `m59-autopilot-test`, `m59-skills-test` and `m59-coop-test` all want a broker on
  8899 and fail with `ECONNREFUSED` without one, which is not a regression.

## m59-wallstop-test.mjs (142, 1 skipped)

The wall stops that killed, pinned on the real geometry. Each `tools/fixtures/wallstop-<room>-r<r>c<c>.json`
is a spot where a traveller took "a wall on the way past", stood on it in a room of nine to eighteen monsters,
was reached anyway, and died without moving — thirteen spots from 2026-09-02, both fleets, built by
`m59-recordwallstop.mjs` from the postmortems and redacted like the jam fixtures. For every spot it pins
that the wall search WITH walls allowed offers a wall from the stop square and that the wall the keeper chose
is one the geometry calls safe (the old behaviour, and what killed); that with walls withheld (the crowd rule,
`Autopilot.crowded`) the search offers nothing without a journey; that the crowd was at or above the rule's
default (skipped with a note where it was not — the Flatlands pipe spot is the wedge class); that blows landed
on the stop square; and that no fixture names a character. **It should fail the day a wall in a crowd becomes
a candidate again.**

## m59-retreat-refusal-test.mjs (32)

**A retreat that was refused is not a retreat, and must not end the pass.** `retreatToSafety`
refuses outright while `retreat_to_inn` is off — the operator switched it off on 2026-08-27 —
and every caller reported success anyway, so the journal read like an escape while the body
stood still. JohnsSlave died of it four times in two days (issue #51); the last post-mortem
window is 31.3 seconds, 46 samples, `squares_per_second: 0.0`, `net_squares: 0`,
`rooms_crossed: 0`, seven things adjacent, 2 of 21 health, and a correct decision on every
single pass.

Two halves, and the suite pins both. The refusal now **dispatches the replacement it had been
describing** — the comment above it has said "the replacement is not nothing, it is the
route-adjacent safe spot" the whole time, so the branch takes a wall when there is one, shares
the ladder's own 30-second `wallTriedAt` budget so a wall-less room is not re-scanned once per
rung, obeys `use_safe_spots`, and still defers to the older guard that keeps a character on a
wall that has held. And the caller **no longer claims the pass for a refusal**: the rung that
decides "moving to somewhere I can heal" used to `progress()` and `return HANDLED` whatever
came back, which pre-empted the rung immediately below it — the one that walks out via
`leaveViaAny` with a reconnect to shed the crowd. The end-to-end assertion drives the real
`passFleeAndRest` on a keeper at 3 of 21 health with seven monsters in the room and checks that
the body actually leaves; its mirror checks that a retreat which DID arrive still ends the pass
and does not also abandon the room.

The last section is the churn guard, and it is the reason the class survived: five call sites
had the same bug in the same shape and each reads perfectly well on its own. So the rule is
checked over the file — every `retreatToSafety` call binds its answer, nothing follows one
straight into an unconditional `progress()`, and the two behaviour trees (`m59-bt-flee.mjs`,
`m59-bt-farm.mjs`) agree, because a selector's `SUCCESS` is the tree's version of `HANDLED` and
landing them otherwise would re-open the same grave. **It should fail the day a caller reports
a refused retreat as movement again.**

## m59-stall-lever-test.mjs (48)

**A stall has to name its lever, and "none" is an answer rather than a silence.** `noProgress`
counted idle passes and had exactly one keeper-side lever — blink — selected by testing the
reason *sentence* against a regex. A reason that did not match got no lever at all, and
nothing anywhere said so: the counter went up, `stuck.since` advanced, and the character
stood still. Measured at 27 minutes, 1,623 seconds, 943 idle passes, zero kills, in the
character's own assigned farm room, with the detector watching all of it (issue #50,
suggested direction 3 — the half the approach walk did not close).

The second lever is outside the keeper: `m59-supervise.mjs` restarts a keeper stalled for
eight passes. That is a real lever for a **stateful** stall, where the thing in the way is
keeper-local — a room written off for the session, a route given up on, a square's failure
budget. It is not one for a **deterministic** stall: a fresh keeper walks into the same room
with the same orders and re-enters the loop in seconds, once every ninety seconds, for ever,
each line reading `restarted <character>` as though something had happened. That file already
refuses the same trap twice by name, for `NO_SAFE_WALL` and for a character resting up the
mana to arm itself.

Four things are pinned. `stallLever` is the whole map from a reason to the thing that can act
on it, enumerable rather than buried in a branch, with `null` a legitimate answer — and the
blink classification is unchanged, which is asserted in both directions so making it explicit
cannot quietly become making it different. A **repeat run** is counted separately from idle
passes, because a character finding a new obstacle every pass is working and one reciting the
same sentence is in a loop its own inputs cannot leave; sixty different failures are never
declared. A leverless run past twenty repeats **declares** `STALL_NO_LEVER` on
`status.refusals` — once, with `since` surviving, carrying the repeating sentence and the
room, cleared by `progress()` and by nothing else. And the fact travels: `stalled`, `stuck`
and the keeper process's own `/state` all carry `lever` and `repeats`, asserted together,
because a field added in one publisher and forgotten in the other is how the fleet board once
reported `stalled: false` for a character standing in a corner for twenty minutes.

The last section is the supervisor's half: `stallRestartDecision` is pure and exported, an
undeclared stall is never rationed (this must not become a throttle on a mechanism that
works), a declared one gets two restarts and then the truth, a *different* declared reason
starts the count again, and a character that earns something is forgotten. **It should fail
the day a stall reason can go unclassified again.**


## m59-which-test.mjs (27) — the third answer a port can give

The gate every `/m59*` command runs first already had two answers and a rule about them:
a port that does not answer is a QUESTION, and a question may never become a statement about
a fleet. That is what `INDETERMINATE` is for, it exits non-zero, and a hung port still
produces it — prod's `/health` was measured at 2573ms under load, so the busiest broker is
the one most likely to be missed and it is always the one that matters.

**A port that answers in a protocol that is not HTTP is not a question.** A broker is a node
`http` server and always opens with `HTTP/1.x`, so anything else is positive evidence: there
is something on that port and it is not a broker. Filing that under "could not ask" is what
happened on 2026-09-05. `substrate/broker-boscontrol.pid` still named http 8911 for a broker
whose pid had been gone for days, the RTS gateway had since been given that port, and its
first bytes came back as `HPE_INVALID_CONSTANT` — so every run ended INDETERMINATE, and since
every `/m59*` command gates on the exit code, a fleet whose broker was answering `/health`
perfectly was unaddressable from that checkout.

**The line is drawn at the status line and deliberately not past it.** A truncated body, a
bad chunk size, an early EOF are what a REAL broker looks like when it dies or is cut off
mid-answer, and reading those as "not a broker" would be the original bug wearing the fix's
clothes. So only the codes raised before a valid status line — `HPE_INVALID_CONSTANT`,
`HPE_INVALID_VERSION`, `HPE_INVALID_STATUS`, `HPE_INVALID_METHOD` — are definite, `ECONNRESET`
stays a question, and the suite pins silence as indeterminate in the same breath as pinning
that a non-HTTP port no longer blocks an answer. It also pins that a non-HTTP port ALONE is
still an all-clear, or `./m59.sh up` could never start a fleet on a machine where anything
squats a recorded port.

The last four assertions are about WORDING, which is not a lesser thing here: the message is
the whole product of a tool whose only other output is an exit code. When a broker holds a
fleet carrying our label while serving a different roster file, the old text ended "or say
`--fleet prod` and mean it" — which is what the operator already said and how they got there.
It now names both roster files and the checkout to run from. On this machine that is the
difference between the trunk and the deploy worktree, which each have a
`substrate/fleets/prod.json` holding 21 characters called the Muppets, and only one of them is logged in.
**It should fail the day the tool turns an answer back into a question, or a question into an
answer.**
