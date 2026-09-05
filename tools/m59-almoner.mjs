#!/usr/bin/env node
// MOVE FOOD AND REAGENTS FROM THE RICH TO THE STARVING, THEN TURN THEM INTO VIGOR.
// AND MOVE SIGNET RINGS DOWNWARD, WHICH IS WORTH TEN TIMES MORE THAN ANY OF IT.
//
//   node tools/m59-almoner.mjs --dry-run
//   node tools/m59-almoner.mjs                    # hand out and set the vigor floor
//   node tools/m59-almoner.mjs --amount 10        # per reagent kind, default 10
//   node tools/m59-almoner.mjs --floor 140        # vigor to fight above afterwards
//   node tools/m59-almoner.mjs --max-hops 2       # locality cap for reagent handovers
//   node tools/m59-almoner.mjs --max-deliveries 2 # per donor that has to WALK, in one pass
//   node tools/m59-almoner.mjs --signets-only     # just the rings
//   node tools/m59-almoner.mjs --no-signets       # just the reagents and the larders
//   node tools/m59-almoner.mjs --room 39          # only hand out among the people standing there
//   node tools/m59-almoner.mjs --room "Castle Victoria"   # the same, by name
//   node tools/m59-almoner.mjs --food-amount 20   # meals per hand-over, default --amount
//   node tools/m59-almoner.mjs --no-food          # reagents only, as it used to be
//   node tools/m59-almoner.mjs --food-only        # larders only, skip the reagent round
//   node tools/m59-almoner.mjs --drop-for-space   # let a full recipient drop mushrooms (OFF)
//
// `--food` used to mean "hand out the feast INSTEAD of the reagents, then exit". Both halves
// now run every pass, so it is accepted and does nothing — the behaviour it used to select
// is `--food-only`. It is spelled out here because an old command line quietly meaning
// something new is worse than one that errors.
//
// THE RINGS COME FIRST AND THEY ARE NOT A SIDE ERRAND. A signet ring pays its value TEN
// TIMES OVER to a character the server considers a newbie, and plain value to everyone
// else — and "newbie" is not a choice anybody here made: EvaluatePKStatus enables
// player-killing for you the moment base max health reaches 30 (player.kod:11047). Max
// health is the level here. So the same ring is worth up to 1500 shillings in the hands
// of a level-24 character and up to 150 in the hands of a level-31 one, and which of them
// is holding it is decided by whichever happened to loot it.
//
// That is exactly the almoner's job. The fleet's small characters are the ones with no
// money, no food and no floor under them, and this is the one mechanism in the game that
// pays them ten times what it pays anyone else. Redistributing rings downward and then
// sending them to be cashed is the single largest transfer available to this tool — one
// ring is worth more than every elderberry it will ever move — so it runs FIRST and it
// runs even on the passes where there is no reagent work to do.
//
// WHY THIS IS THE HIGHEST-VALUE ERRAND AVAILABLE. The fleet's food supply is not
// bought, it is CAST: `create food` turns 2 ElderBerry and 2 Herbs into a meal, and
// both drop free in the rooms these characters already hunt. A character with no
// reagents cannot cast, so it cannot eat; resting alone tops out at 80 vigor of 200,
// and everything above 80 has to come from food. So an empty pack is not a small
// inconvenience — it caps a character at the resting floor for ever.
//
// And vigor is not a comfort stat. It sets the HEALTH REGENERATION RATE:
// ((200-vigor)^2/6 + 1000) ms a point, which is 1.0 hp/s at 200 and 0.29 hp/s at 80.
// A character stuck at 80 recovers three and a half times slower than one at 200,
// between every fight, for ever. That is most of the difference between a fleet that
// grinds upward and one that dies in the same room all night.
//
// The distribution in this fleet was extreme when this was written: three characters
// held 329 ElderBerry and 670 Herbs between them, while seven had none at all — and
// every one of the seven was standing in the two rooms where the fleet was dying.
// Nothing was wrong with any of them individually. Nothing was moving the surplus.
//
// It does NOT do the trade itself: `supply` already drives both ends of a two-sided
// protocol between characters this broker holds, and verifies the receiver actually
// ended up with the goods. A half-finished trade is silent, which is exactly why that
// tool exists and why this one calls it rather than reimplementing it.
import { findPath, loadMap } from './m59-map.mjs';
// WHAT COUNTS AS FOOD IS NOT A WORD LIST. `foodValue` answers out of the game's own Food
// class tree and returns the vigor a bite is worth, so a courier carrying something the
// Duke's tables do not dispense still counts, and scenery with a promising name does not.
import { foodValue } from './m59-items.mjs';
// THE SHARING RULES LIVE IN A MODULE SO THEY CAN BE TESTED. This file takes the fleet run
// lock and starts calling the broker on import, so it cannot itself be imported by a test —
// the same reason m59-broker.mjs must not be. m59-almoner-share-test.mjs (48) pins these.
import { orderLarder, dealShare, planFoodHandovers, alreadyStocked, invisibleFoodNames,
         splitRoomsAmong } from './m59-almoner-share.mjs';
// A ROOM NUMBER IS NOT A PLACE IN A SPLIT ROOM — room 39's walkable area is two components
// joined only through room 38. Read through RoomGeometry rather than re-deriving the grid.
import { RoomGeometry } from './m59-roo.mjs';
import { takeRunLock } from './m59-runlock.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const AMOUNT = Number(arg('amount', 10));
const FLOOR = Number(arg('floor', 140));
// A meal is not worth turning the best farmer into a global courier. Piggy's three-hour
// travel outlier included one pass that assigned her five recipients across Castle
// Victoria, Tos and Marion. Keep this the local redistribution layer; the keeper's
// farm-delivery strategy already moves stock opportunistically within two rooms.
const MAX_HOPS = Math.max(0, Number(arg('max-hops', 2)) || 0);
const MAX_DELIVERIES = Math.max(1, Number(arg('max-deliveries', 2)) || 2);
const WORLD_MAP = loadMap();
export const deliveryHops = (from, to, map = WORLD_MAP) => {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return Infinity;
  const route = findPath(map, from, to);
  return route.found ? route.hops.length : Infinity;
};
// Keep the giver able to feed itself: handing away the last of it just moves the
// problem. One casting is 2 of each, so this is several meals of margin.
const KEEP_BACK = Number(arg('keep', 20));
// FOOD AND REAGENTS ARE ONE PASS, NOT TWO MODES. `--food` used to be a whole separate
// errand that ran instead of the reagents and exited; the reagent round never saw a fleet
// that had been handed a feast, and the feast round never saw one that could cook. Nothing
// about them conflicts — they are the same donor-and-recipient shape over two different
// surpluses — and a character short of both wants both. So both run, food first, and each
// is a clean no-op when there is no surplus of its kind.
//
// Measured on prod the morning this was changed, room 39, fourteen characters: Kermit held
// 72 spider eyes and 121 slices of pork, Fozzie 226 pork, Gonzo 100 spider eyes — 520 meals
// standing in one room — while eight characters held NOTHING and sat at exactly 80 vigor
// with their target dropped to 80 to match. Not one elderberry or herb in the room, so the
// reagent round had nothing to do and the old default did nothing at all while the fleet's
// entire food supply stood three feet away.
const FOOD = !arg('no-food', false);
const FOOD_ONLY = !!arg('food-only', false);
// A meal is not a reagent and the right share is not the same number. `--amount` is per
// reagent kind; this is per hand-over of food, and defaults to it only because one number
// is usually enough.
const FOOD_AMOUNT = Math.max(1, Number(arg('food-amount', AMOUNT)) || AMOUNT);
// A stomach admits 100 and the hall's best dish fills 20, so five is one sitting. Ten
// leaves a courier two sittings of its own before it walks back for more.
const KEEP_FOOD = Number(arg('keep-food', 10));
// --drop-for-space: let a failed hand-over put the recipient's mushrooms on the floor to make
// room. OFF by default — see the note at the drop itself; it fired twice on prod, failed twice,
// and cost real sellable stock both times.
const DROP_FOR_SPACE = !!arg('drop-for-space', false);
// --room: hand out only among the people standing in one room, by number or by name.
//
// The almoner is fleet-scoped by nature and normally should be. But "feed the fourteen
// characters parked in Castle Victoria" is a real errand with a real reason to be narrow:
// every hand-over inside one room is free, and the moment the set widens, the locality
// preference is competing against hungry characters a walk away — and that walk through
// monster rooms is the expensive and failure-prone half of this. Scoping is how you say
// "spread what is already here" without also volunteering the room's best farmer as a
// courier to Jasper.
const ROOM = arg('room', null);
const roomMatches = (r) => {
  if (ROOM === null || ROOM === true) return true;
  const n = Number(ROOM);
  if (Number.isInteger(n) && String(n) === String(ROOM).trim()) return r.room_num === n;
  return String(r.room || '').toLowerCase().includes(String(ROOM).toLowerCase());
};

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const t = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const countOf = (items, re) => (items || []).filter(i => re.test(i.name || ''))
                                            .reduce((t, i) => t + (i.amount || 1), 0);

// `fleet` throws "Cannot read properties of null (reading 'inventory')" while a
// character is between logging out and being rejoined — the session exists and its
// client does not. It is transient and clears within a rejoin cycle, but it takes the
// whole call down with it, so a run that happens to start during one gets nothing.
// (It also killed a supervisor round. Worth fixing in the fleet tool itself; retried
// here so this errand does not depend on that.)
const LOCK_FLEET = fleetName();
const FORCE = process.argv.includes('--force');

// ONE THING DRIVING THE FLEET AT A TIME, AND SAY WHO HAS IT.
//
// The almoner walks givers to receivers, so it collides with anything else moving the same
// characters. Two runs do not halve the work, they fight for the bodies: each re-issues
// travel at a character the other is already walking, and every collision lands in the
// transit book as "movement cancelled by a newer command" - the same sentence a genuine
// survival interrupt produces, which is what makes it expensive to diagnose.
//
// Measured here 2026-09-02: a supply run covering t17,t12,t8 was still alive ninety minutes
// after it started, having delivered nothing, when a second run covering t3,t17,t6 was
// launched over the top of it. Zoot was in both. Earlier the same day three runs were live
// at once because a kill had silently failed and nobody checked.
//
// FLEET-WIDE RATHER THAN PER-AGENT, deliberately: this tool is fleet-scoped by nature, and
// 'these two name different characters' is not 'these two cannot collide' - the roads and
// the counters are shared. m59-runlock already makes exactly this argument and corroborates
// a pid against its start time, so a dead holder is taken over rather than refused forever.
const runClaim = takeRunLock(LOCK_FLEET, {
  label: `almoner, amount ${AMOUNT} keep ${KEEP_BACK} floor ${FLOOR}`, force: FORCE });
if (!runClaim.ok) {
  const h = runClaim.holder ?? {};
  console.error(`REFUSING - fleet "${LOCK_FLEET}" is already being driven by another run.`);
  console.error(`  pid    ${h.pid ?? '?'}`);
  console.error(`  what   ${h.label ?? '?'}`);
  console.error(`  since  ${h.at ? new Date(h.at).toISOString() : '?'}` +
                (h.at ? `  (${Math.round((Date.now() - h.at) / 1000)}s ago)` : ''));
  console.error(`  argv   ${h.argv ?? '?'}`);
  console.error('');
  console.error('Wait for it, stop that pid, or re-run with --force if you know it is dead.');
  process.exit(3);
}
if (runClaim.tookOverFrom)
  console.error(`note: took over a stale lock - ${runClaim.tookOverFrom.why}`);

let f = null;
for (let i = 0; i < 4 && !f; i++) {
  f = await call('fleet', {}).catch(async (e) => {
    if (i === 3) throw e;
    console.log(`  fleet unreadable (${String(e.message).slice(0, 60)}) — retrying`);
    await sleep(4000);
    return null;
  });
}
// A HANDOVER HOLDS BOTH ENDS INERT, AND AN INERT KEEPER CANNOT FLEE OR REST.
//
// This filtered on `in_game` alone, so a character was eligible for an exchange at any
// health at all. Measured on prod the morning this was added: Fozzie was held inert for a
// supply exchange at 4 of 52 in a battered-skeleton room and Piggy at 3 of 49, and both
// were still LOSING health while held — Piggy went 9 -> 3 -> 1 before an operator took it
// back and rested it to 31. Nothing was wrong with the exchange; it simply has no opinion
// about whether the character can afford to stand still for it.
//
// Survival decides at one second and belongs to this repository, always — a reagent
// delivery is minutes of work that can wait for the next round, and the next round is
// sixty seconds away. So anyone under half health sits this one out, on both ends: a
// donor because it has to walk, and a recipient because it is held just the same.
//
// Deliberately NOT the keeper's flee threshold (0.35). That one asks "should I run from
// this fight"; this asks "can I afford to be unable to run at all", and the honest answer
// is a wider margin — the whole point is that the character has no way to react while the
// exchange is in flight.
const HURT_BELOW = Number(arg('hurt-below', 0.5));
const pctOf = (r) => {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(r.health ?? ''));
  return m ? Number(m[1]) / Number(m[2]) : null;
};
const inGame = (f.fleet || []).filter(x => x.in_game !== false);
// Scope BEFORE the health filter so the "sitting this round out" line names the people this
// run was actually about, rather than reporting a hurt character in another town at somebody
// who asked about one room.
const scoped = inGame.filter(roomMatches);
if (ROOM !== null && ROOM !== true)
  console.log(`scoped to room "${ROOM}": ${scoped.length} of ${inGame.length} in game ` +
              `(${[...new Set(scoped.map(x => `${x.room_num} ${x.room || ''}`.trim()))].join(', ') || 'nobody'})`);
if (ROOM !== null && ROOM !== true && !scoped.length) {
  console.log('nobody is standing there — nothing to do');
  process.exit(0);
}
const hurt = scoped.filter(x => { const p = pctOf(x); return p !== null && p < HURT_BELOW; });
const live = scoped.filter(x => !hurt.includes(x));
if (hurt.length)
  console.log(`  ${hurt.length} sitting this round out below ${Math.round(HURT_BELOW * 100)}% health ` +
              `(a handover holds them inert, and an inert keeper cannot flee): ` +
              hurt.map(h => `${h.character} ${h.health}`).join(', '));

// ------------------------------------------------------------------ the rings, first
//
// Three steps and each is refused cleanly when it has nothing to do, so this costs a
// single survey call on the passes — most of them — where the fleet is carrying none.
// THE RINGS ARE FLEET-WIDE AND CANNOT BE SCOPED, SO `--room` TURNS THEM OFF.
//
// `signets redistribute` and `signets return` are broker-side and act on the whole fleet —
// the return errand DISPATCHES carriers to towns. There is no room-scoped form of either,
// so a `--room` run that still ran them would answer a narrow question with a fleet-wide
// action, which is exactly the class of surprise this tool is supposed not to be. Say so
// out loud rather than doing it quietly, and `--signets` overrides.
const SCOPED = ROOM !== null && ROOM !== true;
const doSignets = !arg('no-signets', false) && (!SCOPED || !!arg('signets', false));
if (SCOPED && !doSignets && !arg('no-signets', false))
  console.log('signet rings: skipped — they are fleet-wide and this run is scoped to a room ' +
              '(pass --signets to do them anyway)\n');
if (doSignets) {
  const survey = await call('signets', { action: 'survey' }).catch(e => ({ __err: e.message }));
  if (survey.__err) {
    // A broker predating the signets tool answers "no such tool", and that must not take
    // the reagent run down with it — this errand has been the fleet's food supply for
    // months and the rings are the new part.
    console.log(`signets: ${survey.__err}`);
  } else if (!survey.rings) {
    console.log('signet rings: none in the fleet');
  } else {
    console.log(`signet rings: ${survey.rings} carried, ${survey.in_the_wrong_hands} in hands that ` +
                `would be paid a tenth`);
    for (const cr of survey.carriers)
      console.log(`  ${cr.character} (${cr.level}, ${cr.paid}) ` +
                  cr.holding.map(h => `${h.owner} -> ${h.go_to}`).join('; ') +
                  (cr.committed ? `  [busy: ${cr.committed}]` : ''));
    if (DRY) console.log('  dry run — no rings moved and nobody dispatched');
    else {
      if (survey.in_the_wrong_hands) {
        const moved = await call('signets', { action: 'redistribute' })
                            .catch(e => ({ moved: 0, __err: e.message }));
        console.log(`  redistributed ${moved.moved ?? 0}` +
                    (moved.__err ? ` (${moved.__err})` : ''));
        for (const m of moved.moved_detail ?? []) console.log(`    ${m}`);
        for (const m of moved.failed ?? []) console.log(`    could not: ${m}`);
      }
      const sent = await call('signets', { action: 'return' })
                        .catch(e => ({ dispatched: 0, __err: e.message }));
      console.log(`  dispatched ${sent.dispatched ?? 0} return errand(s)` +
                  (sent.__err ? ` (${sent.__err})` : ''));
      for (const e of sent.errands ?? [])
        console.log(`    ${e.carrier} -> ${e.to} at ${e.where} (${e.town}), paid ${e.paid}`);
      for (const s of sent.skipped ?? []) console.log(`    skipped: ${s}`);
    }
  }
  console.log('');
}
if (arg('signets-only', false)) process.exit(0);

// ------------------------------------------------------------------ or the Duke's feast
//
// FOOD MODE — `--food`, for as long as the hall is open.
//
// While the Duke's tables give food away the fleet's supply stops being CAST and starts
// being CARRIED: couriers fill a pack at the hall and walk it home. That inverts the
// problem below. There is nothing to cook, nothing to pair and no scarce half — just a
// stack of pork in three packs and, measured on the morning this was written, eleven of
// fifteen characters sitting at the resting cap of 80 against a target of 140 they had no
// way to climb to, with one meat pie between the lot of them.
//
// It is deliberately the same errand rather than a second tool: same donor-and-recipient
// shape, same locality preference, same `supply`, same "raise the floor afterwards"
// ending. Only what counts as a surplus and what counts as need are different.
//
// `what: 'food'` IS NOT THE CALL TO MAKE, and this is the trap worth writing down. It
// hands over the giver's ENTIRE larder — m59-supply.mjs answers it with
// `larderOf(give.client())`, every edible object it holds — so the first recipient would
// take the whole trip and everyone behind it would get nothing, while the run reported
// success for both. Dealing a SHARE means naming stacks as {id, amount}, which the same
// tool accepts and which is what this does.
if (FOOD) {
  // DEAL THE DENSEST FOOD FIRST, BECAUSE THE RECIPIENT'S CONSTRAINT IS ITS STOMACH.
  //
  // The old code dealt stacks in whatever order the pack listed them, which reads as
  // harmless and is not: what a hungry character can convert into vigor in one sitting is
  // bounded by `filling`, not by how many objects it was handed. A stomach admits 100. Ten
  // slices of pork (9 nutrition, 20 filling) is 200 filling — five of them is the sitting,
  // 45 vigor, and the other five ride around waiting for it to drain at 7.2 a minute.
  // Ten inky-cap mushrooms (50 nutrition, 25 filling) is 200 vigor over the same stomach.
  //
  // So sort by nutrition per unit of filling and hand over the best of the larder. The
  // donor is by definition the one standing on a surplus; the recipient is the one pinned
  // at the resting cap, and it is the one whose next hour is decided by which stack it got.
  const larders = [];
  for (const r of live) {
    const inv = await call('inventory', { agent: r.agent }).catch(() => ({ items: [] }));
    const stacks = orderLarder((inv.items || [])
      .map(i => ({ id: i.id, name: i.name, amount: i.amount || 1, food: foodValue(i.name) }))
      .filter(x => x.food && x.id != null));
    larders.push({ agent: r.agent, character: r.character, room: r.room_num,
                   vigor: Number(r.vigor ?? 0), target: Number(r.vigor_target ?? FLOOR),
                   meals: stacks.reduce((n, s) => n + s.amount, 0),
                   nutrition: stacks.reduce((n, s) => n + s.amount * (s.food.nutrition ?? 0), 0),
                   // GROUND TRUTH FOR "WILL THE KEEPER EVER EAT THIS", WHICH IS NOT THE SAME
                   // QUESTION AS "IS IT FOOD". See the block below.
                   harnessSeesFood: r.has_food === true,
                   // A rejoining character has a session and no client; its vitals read empty
                   // and its larder honestly reads empty with it. Not a name-table miss.
                   alive: Number(r.vigor ?? 0) > 0 || !!r.health, stacks });
  }

  // A LARDER THIS TOOL CAN SEE AND THE HARNESS CANNOT IS WORSE THAN AN EMPTY ONE.
  //
  // `has_food` on the fleet row is `larderOf(c).length > 0`, and `larderOf` resolves names with
  // `foodValue`, which is a RAW lowercase lookup into m59-items.json. `itemNameKey` — the
  // canonical normaliser, twelve lines further down the same file — folds plurals, and
  // `foodValue` does not use it. So a stack whose wire name is plural is not food to the
  // harness: `foodValue('spider eye')` hits and `foodValue('spider eyes')` is null.
  //
  // That is not cosmetic. An empty larder collapses the fighting floor to 80
  // (`reachableFightFloor(140, 200, 0) === 80`), so a character carrying nothing the harness
  // recognises is pinned at the resting cap AND never eats its way off it — and this tool will
  // cheerfully keep dealing it more of the same, reporting every delivery as a success.
  //
  // Measured 2026-09-05 across all 21 prod characters: every PERSISTENT `has_food: false` held
  // only spider eyes and/or water skins (Scooter 86 spider eyes, Waldorf 20, Bunsen 14 + 6
  // water skins, Floyd 4 water skins), stable across samples half an hour apart, while every
  // row holding pork, bread, inky-cap or edible mushroom read true — Rowlf's 1 loaf plus 6
  // water skins read true on the loaf alone. Floors set to 140 on three of them reverted to
  // exactly 80 within 60 seconds and stayed there for the whole twenty minutes sampled.
  //
  // THERE IS A SECOND, INNOCENT SOURCE OF `has_food: false` AND THIS LIST WILL SHOW IT.
  // A character between logging out and being rejoined has a session and no client, so
  // `c.inventory` is null and `larderOf` honestly returns nothing — the same shape that makes
  // `fleet` throw "Cannot read properties of null (reading 'inventory')" and that the retry at
  // the top of this file exists for. Sweetums appeared here once holding nine slices of pork,
  // with `vigor 0` on the same row, and read true again on the next pass. So a row in this list
  // whose vitals look empty is a rejoin, not a name-table miss; one that persists across passes
  // while the pack is full of a single item is the real thing. Do not tighten this into a
  // filter on a guessed threshold — print both and let the reader tell them apart.
  //
  // The fix belongs in `foodValue` (use `itemNameKey`), NOT here — it is a shared predicate the
  // keepers, the sell path and the vault path all read, and prod's keepers run from another
  // checkout, so it only reaches them on a keeper restart. Until then, say it out loud: a
  // silent inert delivery is exactly the failure this repository keeps paying for.
  const INVISIBLE = invisibleFoodNames(larders);
  const SPLIT = splitRoomsAmong(larders.map(h => h.room),
                                { map: WORLD_MAP, geometryFor: r => RoomGeometry.fromJSON(r.roo) });
  if (SPLIT.size)
    console.log(`rooms here whose walkable area is in more than one piece: ${[...SPLIT].join(', ')} ` +
                `— "same room" does not mean "can reach each other" in these
`);
  const invisible = larders.filter(h => h.meals > 0 && !h.harnessSeesFood && h.alive !== false);
  if (invisible.length) {
    console.log(`${invisible.length} carrying food the HARNESS CANNOT SEE (has_food=false with a ` +
                `non-empty larder) — their floor will collapse to 80 whatever we set, and food ` +
                `dealt to them is inert until foodValue() folds plurals:`);
    for (const h of invisible)
      console.log(`  ${h.character}: ${h.meals} meals — ` +
                  h.stacks.map(s => `${s.name} x${s.amount}`).join(', '));
    console.log('');
  }

  // THE CHEAPEST VIGOR IN THE FLEET IS ALREADY IN SOMEBODY'S PACK, BEING IGNORED.
  //
  // A larder is only drawn on BELOW the fighting floor, and the harness drops that floor to
  // the resting cap whenever a pack is empty (`reachableFightFloor`) so an unfed character is
  // not idle-locked. Nothing puts it back up when the food arrives by some other route — a
  // hall run, a lucky drop, a bot's own errand. So a character can stand there holding a
  // fortnight of meals with a target of 80, never eat one, and look perfectly satisfied to
  // every report in this repository.
  //
  // Measured on prod the morning this was added: Gonzo carrying 100 spider eyes at 80/80 and
  // Scooter 140 at 88/80 — 240 meals, two characters, both pinned at the resting cap by a
  // number rather than by a shortage. That is the whole almoner's usual day's work, sitting
  // in two packs, and it costs one call each to release. It runs BEFORE the hand-overs on
  // purpose: it may remove the need for one, and it cannot fail in a way that hurts.
  const canAffordTheClimb = alreadyStocked(larders, FLOOR);
  if (canAffordTheClimb.length) {
    console.log(`${canAffordTheClimb.length} already carrying enough to reach ${FLOOR} but ` +
                `capped at a lower floor — raising it, no hand-over needed:`);
    for (const h of canAffordTheClimb) {
      console.log(`  ${h.character}: ${h.meals} meals (${h.nutrition} nutrition), ` +
                  `${h.vigor}/${h.target} -> floor ${FLOOR}`);
      if (!DRY) await call('autopilot', { agent: h.agent, fight_above_vigor: FLOOR }).catch(() => {});
    }
    console.log('');
  }

  // The donor test, the "need is a floor it cannot reach" test, the same-room preference and
  // the walks-only delivery cap are all in m59-almoner-share.mjs with their arguments, because
  // every one of them has been wrong at least once and none of them was checkable from here.
  const { donors, hungry, plan } = planFoodHandovers({
    larders, foodAmount: FOOD_AMOUNT, keepFood: KEEP_FOOD, floor: FLOOR,
    maxHops: MAX_HOPS, maxDeliveries: MAX_DELIVERIES, hops: deliveryHops, splitRooms: SPLIT,
    // Raised just above; it does not also need feeding this pass.
    alreadyHandled: new Set(canAffordTheClimb.map(h => h.agent)) });

  console.log(`feast: ${donors.length} carrying a surplus, ${hungry.length} below ${FLOOR} vigor ` +
              `with fewer than ${FOOD_AMOUNT} meals`);
  for (const d of donors)
    console.log(`  ${d.character}: ${d.meals} meals in ${d.room} — ` +
                d.stacks.map(s => `${s.name} x${s.amount}`).join(', '));
  if (!donors.length) console.log('  nobody is carrying the feast — send a courier to the hall first');
  if (!hungry.length) console.log('  nobody is short');


  for (const p of plan)
    console.log(`  ${p.from.character} -> ${p.to.character} (${FOOD_AMOUNT} meals, ` +
                `${p.to.vigor} vigor)` +
                (p.free ? '  [same room — no walk]'
                        : p.maybeFarHalf ? `  [room ${p.from.room} is split — may be the far half]`
                        : `  [walk: ${p.from.room} -> ${p.to.room}]`));
  if (!plan.length) console.log('  nothing to hand over this pass');
  if (DRY) console.log('  dry run — nothing handed over');

  // AN INVENTORY ID GOES STALE, AND A PLAN MADE OF IDS ROTS WHILE IT IS BEING EXECUTED.
  //
  // This used to deal from the stacks read during the survey, decrementing a local copy. That
  // is only correct if nothing else touches the pack — and something always does. Measured on
  // the run that found it, room 39: the first two hand-overs landed, and then
  //
  //   Kermit -> Floyd: NOT delivered  "Kermit is carrying nothing matching those ids"
  //     carrying: ["hammer","mushroom","long sword","shilling","spider eye","slice of pork", ...]
  //
  // Kermit was still holding the pork. The IDS had moved — splitting a stack to hand part of
  // it over renumbers what is left, and the survey was minutes and several exchanges old by
  // then. Two of six deliveries failed this way, and the failure is the nastiest shape there
  // is: a successful call that moves nothing and blames the goods.
  //
  // The reagent round never had this bug because it passes the symbolic `what: 'reagents'` and
  // lets m59-supply.mjs resolve ids at the moment of the trade. Food has no symbolic form that
  // deals a SHARE — `what: 'food'` hands over the entire larder — so the ids have to be named,
  // and the only safe moment to read them is immediately before the offer.
  for (const p of (DRY ? [] : plan)) {
    const fresh = await call('inventory', { agent: p.from.agent }).catch(() => null);
    if (!fresh) { console.log(`  ${p.from.character}: could not re-read the pack — skipping`); continue; }
    const stacks = (fresh.items || [])
      .map(i => ({ id: i.id, name: i.name, amount: i.amount || 1, food: foodValue(i.name) }))
      .filter(x => x.food && x.id != null);
    // Still keep something back for the courier itself, against the pack as it is NOW.
    // Pork before spider eyes when the courier has both: equally dense, but only one of them
    // makes the recipient's floor hold. Falls back to the invisible stock rather than starving
    // somebody when it is all there is.
    const { give, dealt, had } = dealShare(stacks, FOOD_AMOUNT, KEEP_FOOD, INVISIBLE);
    if (dealt < FOOD_AMOUNT)
      console.log(`  ${p.from.character}: down to ${had} meals since the survey — ` +
                  (dealt > 0 ? `dealing ${dealt}` : 'nothing left to deal'));
    if (!give.length) { console.log(`  ${p.from.character}: nothing left to deal`); continue; }
    try {
      let r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                     what: give, who_travels: 'from' });
      // A CHARACTER IN FLIGHT IS NOT A CHARACTER WALLED IN, AND SWAPPING WHO WALKS DOES NOT
      // HELP IT. The retry below is for GEOMETRY — a blocked edge is directional and about the
      // room being LEFT, so sending the other one is a different question with its own answer.
      // "busy", "already held" and "travelling" are not that: they say somebody else has the
      // body, and the honest response is to leave it alone and come back next pass.
      //
      // The reason strings collide, which is why this needs to be tested first. Measured on the
      // same run: `"Janice could not get there: t7 is busy: walk to The Duke's Feast Hall"`
      // matched the geometry pattern on "could not get there" and bought a second doomed
      // exchange against a character the DUM bot was walking across town.
      const busy = /is busy|already held|travelling|cancelled by a newer/i.test(JSON.stringify(r));
      if (r?.supplied !== true && busy) {
        console.log(`    ${p.to.character} or ${p.from.character} is mid-errand — ` +
                    `leaving it for the next pass rather than fighting for the body`);
      } else if (r?.supplied !== true && /could not get there|no floor|boundary/i.test(JSON.stringify(r))) {
        console.log(`    ${p.from.character} is walled in — sending ${p.to.character} to fetch instead`);
        r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                   what: give, who_travels: 'to' })
                  .catch(e => ({ supplied: false, reason: e.message }));
      }
      let ok = r.supplied === true && (r.receiver_carrying ?? 0) > 0;
      console.log(`  ${p.from.character} -> ${p.to.character}: ` +
                  (ok ? 'delivered' : 'NOT delivered') + ' ' + JSON.stringify(r).slice(0, 160));
      // A RECEIVER THAT CAN GIVE BUT NOT RECEIVE IS FULL, AND A FULL PACK IS FIXABLE.
      //
      // m59-supply.mjs names this case itself and says so in its own `note`, because it is
      // otherwise indistinguishable from an accept that ended the trade: no count rose on the
      // receiver. Operator-authorised 2026-09-05 — "you're permitted to have anyone drop any
      // items required to make space for carrying food".
      //
      // ONLY THE MUSHROOMS, AND ONLY AFTER A FAILURE. This is deliberately not a tidy-up pass.
      // The mushroom-and-gem pile is what m59-reagents.mjs walks to the counter — Camilla once
      // carried 148 mushrooms to a shop — so dropping is spending money to buy pack space, and
      // it is only worth it against a hand-over that has actually just failed for want of room.
      // Gems, weapons, armour, reagents, food and the purse are all kept: gems are the dense
      // half of that value and the mushrooms are the bulky, cheap half, which makes them
      // exactly the right thing to put down. `drop_all` withholds money and worn kit itself,
      // and refuses outright when it cannot read the equipment set.
      // A REJOINING CHARACTER PRODUCES THE SAME SIGNATURE AS A FULL PACK, AND DROPPING IS THE
      // ONE THING HERE THAT CANNOT BE TAKEN BACK.
      //
      // `supply`'s own note says a receiver that can give but not receive "is nearly always
      // full" — nearly. The other cause is a character between logging out and being rejoined:
      // it has a session and no client, so no count can rise on it and the trade ends exactly
      // the way a full pack ends. Measured 2026-09-05: Camilla read `vigor 0` on the plan line,
      // the hand-over failed with the full-pack note, and this dropped four mushrooms and a red
      // mushroom into room 39 before the retry failed the same way. The pack was never the
      // problem, and mushrooms are what m59-reagents.mjs walks to a counter for money.
      //
      // So the vitals gate the drop. Everything else here is recoverable; putting items on the
      // floor of a shared server is not, and a rejoin clears itself within a sweep.
      if (!ok && p.to.alive === false)
        console.log(`    ${p.to.character}: looks mid-rejoin (no vitals), not a full pack — ` +
                    `dropping nothing and leaving it for the next pass`);
      // DISARMED 2026-09-05 AFTER TWO FOR TWO. It fired twice on prod, the retry failed both
      // times, and both times it put real money on the floor — 5 mushrooms off Camilla (who was
      // mid-rejoin), then 57 off Robin (25 mushroom, 28 red, 4 purple) at vigor 122, wide awake,
      // with the gate above satisfied. The pack was not the constraint on either occasion.
      //
      // So the trigger is wrong, not the gate. `supply` says a receiver that can give and not
      // receive "is NEARLY always full", and the residue is evidently common — while the cost is
      // asymmetric: a missed delivery waits thirty minutes for the next pass, and dropped
      // mushrooms are what m59-reagents.mjs walks to a counter for money, gone the moment
      // another player picks them up on a shared server.
      //
      // A destructive fallback that has never once worked does not stay armed. `--drop-for-space`
      // opts back in for someone who has a genuinely full pack in front of them and knows it.
      // Re-arming by default needs a POSITIVE full-pack signal — `pack.percent` would be it, and
      // it reads null fleet-wide here because `carryCapacity` cannot see MIGHT.
      else if (!ok && DROP_FOR_SPACE && /nearly always full|too full/i.test(JSON.stringify(r))) {
        const inv = await call('inventory', { agent: p.to.agent }).catch(() => null);
        const names = [...new Set((inv?.items || []).map(i => i.name).filter(Boolean))];
        const junk = names.filter(n => /mushroom/i.test(n) && !foodValue(n));
        if (!junk.length) {
          console.log(`    ${p.to.character}: pack is full and holds no mushrooms to spare — ` +
                      `leaving it alone`);
        } else {
          const keep = names.filter(n => !junk.includes(n));
          console.log(`    ${p.to.character}: pack full — dropping ${junk.join(', ')} to make room`);
          const dropped = await call('drop_all', { agent: p.to.agent, keep })
                                .catch(e => ({ __err: e.message }));
          console.log(`      ${JSON.stringify(dropped).slice(0, 200)}`);
          r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                     what: give, who_travels: 'from' })
                    .catch(e => ({ supplied: false, reason: e.message }));
          ok = r.supplied === true && (r.receiver_carrying ?? 0) > 0;
          console.log(`    ${p.from.character} -> ${p.to.character} (retry): ` +
                      (ok ? 'delivered' : 'still NOT delivered') + ' ' + JSON.stringify(r).slice(0, 140));
        }
      }
      if (!ok) continue;
      // VERIFY BY READING THE WORLD BACK, not by trusting a successful call. `supply` proves
      // the goods MOVED; it cannot know whether the harness will ever count them. A recipient
      // that started with nothing and still reads `has_food: false` after a verified delivery
      // has been handed a stack the food table does not resolve (see the plural note above),
      // and its floor is about to collapse to 80 again no matter what we set next.
      if (!p.to.harnessSeesFood) {
        const after = await call('fleet', {}).catch(() => null);
        const row = (after?.fleet || []).find(x => x.agent === p.to.agent);
        if (row && row.has_food !== true)
          console.log(`    ${p.to.character}: INERT DELIVERY — the goods moved and has_food is ` +
                      `still false, so this stack is invisible to the keeper and the floor ` +
                      `below will not hold. Deal it pork or bread instead.`);
      }
      // The food is the easy half; the floor is the half that makes it worth carrying. A
      // character left at a target of 80 eats nothing, because a larder is only drawn on
      // BELOW the fighting floor — so the pork would ride around in its pack untouched.
      await call('autopilot', { agent: p.to.agent, fight_above_vigor: FLOOR }).catch(() => {});
      console.log(`    ${p.to.character}: fed, now fighting above ${FLOOR} vigor`);
    } catch (e) {
      console.log(`  ${p.from.character} -> ${p.to.character}: FAILED ${e.message}`);
    }
  }
  console.log('');
}
if (FOOD_ONLY) { if (DRY) console.log('dry run — nothing handed over'); process.exit(0); }

// ------------------------------------------------------------------ then the reagents

const held = [];
for (const r of live) {
  const inv = await call('inventory', { agent: r.agent }).catch(() => ({ items: [] }));
  held.push({ agent: r.agent, character: r.character, room: r.room_num, level: r.level,
              has_food: r.has_food,
              eb: countOf(inv.items, /elder\s?berry/i), hb: countOf(inv.items, /^herbs?$/i) });
}

// A recipient is someone who cannot cast their way out: no food AND not enough
// reagents to make any. Having no food but a full pack is not a problem, it is a
// character that has not got round to cooking yet.
const CASTABLE = 2;
const needy = held.filter(h => !h.has_food && (h.eb < CASTABLE || h.hb < CASTABLE))
                  .sort((a, b) => (a.eb + a.hb) - (b.eb + b.hb));
// A DONOR IS A DONOR OF ONE REAGENT, NOT OF BOTH — AND REQUIRING BOTH MEANT NOBODY WAS.
//
// This used to ask for a full share of elderberry AND herbs from the same character. That
// reads as prudence and is actually the bug: what the fleet holds is not a shortage of
// reagents, it is a SEGREGATION of them. Measured across twenty-one characters: 374
// elderberries and 499 herbs in the packs — 187 castings' worth — and eleven characters
// held only elderberry, nine only herbs, one both. So the both-hands test found zero
// donors and this printed "the fleet is genuinely short" while standing on the surplus.
//
// Nothing about the hand-over needs one character to carry both. Two deliveries from two
// donors leave the recipient exactly as able to cast as one delivery would, and a fleet
// that splits its reagents by where it hunts will always look like this.
// AND THE KEEP-BACK HAS TO BE PAIRABLE, FOR EXACTLY THE SAME REASON.
//
// The comment above fixed "a donor must hold both halves". The identical mistake was
// still one level down in the threshold: `AMOUNT + KEEP_BACK` is a FLAT 20 per reagent,
// and a reagent you cannot pair buys you nothing. Measured the morning this was found —
// every one of twenty-one characters unable to cast, and the tool printing "nobody has a
// surplus, the fleet is genuinely short" over it:
//
//   Statler   1 elderberry, 26 herbs   ->  0 castings, withholding 20 herbs
//   Sweetums  1 elderberry, 23 herbs   ->  0 castings, withholding 20 herbs
//   Piggy    15 elderberry,  1 herb    ->  0 castings, withholding 15 elderberry
//
// A character's own castings are bounded by min(eb, hb), so what it can USE of one half is
// capped by how much it holds of the other. Everything above that is dead weight it is
// guarding from a fleet that cannot cook. So the keep-back is capped by the pair.
//
// The honest counter-argument is that a character might loot the missing half later and
// want the buffer back. Under the prey this fleet actually farms it will not — skeleton,
// battered skeleton and zombie drop NEITHER half (see m59-reagents.mjs) — and the almoner
// runs every supervisor round, so herbs can move back the moment elderberry appears.
// Guarding against a drop that cannot happen, at the cost of a fleet pinned at the resting
// cap, is the wrong side of that trade.
const KINDS = [{ kind: 'elderberry', field: 'eb', pair: 'hb' },
               { kind: 'herbs',      field: 'hb', pair: 'eb' }];
const keepFor = (h, k) => Math.min(KEEP_BACK, h[k.pair] ?? 0);
const donorsOf = k => held.filter(h => h[k.field] >= AMOUNT + keepFor(h, k))
                          .sort((a, b) => b[k.field] - a[k.field]);
const pool = new Map(KINDS.map(k => [k.kind, donorsOf(k)]));
const anyDonor = [...new Set([...pool.values()].flat())];

console.log(`${needy.length} character(s) cannot cast create food; ` +
  KINDS.map(k => `${pool.get(k.kind).length} can spare ${k.kind}`).join(', '));
if (!needy.length) { console.log('nothing to do'); process.exit(0); }
// Say WHICH set was short. Scoped, this is a fact about one room and not about the fleet —
// there may be a donor two towns away that this run deliberately declined to send for.
if (!anyDonor.length) {
  console.log(SCOPED ? `nobody in room "${ROOM}" has a surplus — widen the scope or send a courier`
                     : 'nobody has a surplus — the fleet is genuinely short');
  process.exit(0);
}

// Give each donor a fair number of recipients rather than draining the richest one,
// and PREFER A DONOR ALREADY IN THE RECIPIENT'S ROOM — the giver travels, and a walk
// across the world through monster rooms is the expensive and failure-prone part of
// this. Somebody standing next to the person who needs it should be the one to give.
// Capacity is counted per reagent, because that is now what a share is.
const capacity = new Map();
for (const k of KINDS)
  for (const d of pool.get(k.kind))
    // Same pairable keep-back the donor test uses. A flat KEEP_BACK here would let a
    // character qualify as a donor and then be credited with zero shares to give.
    capacity.set(`${d.agent}/${k.kind}`,
                 Math.max(1, Math.floor((d[k.field] - keepFor(d, k)) / AMOUNT)));
const cap = (d, kind) => capacity.get(`${d.agent}/${kind}`) || 0;
const deliveries = new Map();
const tripsBy = donor => deliveries.get(donor.agent) || 0;
const canDeliver = (donor, recipient, kinds) => donor.agent !== recipient.agent &&
  tripsBy(donor) < MAX_DELIVERIES && kinds.every(kind => cap(donor, kind) > 0) &&
  deliveryHops(donor.room, recipient.room) <= MAX_HOPS;
const spendDelivery = (donor, kinds) => {
  for (const kind of kinds)
    capacity.set(`${donor.agent}/${kind}`, cap(donor, kind) - 1);
  deliveries.set(donor.agent, tripsBy(donor) + 1);
};

const plan = [];
for (const n of needy) {
  // What this one is actually short of. A character with plenty of herbs and no
  // elderberry needs one delivery, not two.
  const short = KINDS.filter(k => n[k.field] < CASTABLE);
  // ONE DONOR IF ONE WILL DO. `supply what=reagents` hands over both kinds in a single
  // trip, so a donor holding both closes the whole gap with one walk — which is the case
  // this tool was originally written for and is still the cheapest when it exists.
  const both = short.length > 1
    ? held.filter(d => canDeliver(d, n, short.map(k => k.kind)))
    : [];
  const pickFrom = (list, kinds) => list.filter(d => canDeliver(d, n, kinds))
    .sort((a, b) => deliveryHops(a.room, n.room) - deliveryHops(b.room, n.room) ||
      (b.eb + b.hb) - (a.eb + a.hb))[0];
  const one = pickFrom(both, short.map(k => k.kind));
  if (one) {
    const kinds = short.map(k => k.kind);
    spendDelivery(one, kinds);
    plan.push({ from: one, to: n, kinds, sameRoom: one.room === n.room,
      hops: deliveryHops(one.room, n.room) });
    continue;
  }
  for (const k of short) {
    const pick = pickFrom(pool.get(k.kind), [k.kind]);
    if (!pick) {
      console.log(`  ${n.character}: nobody within ${MAX_HOPS} hops can spare ${k.kind}`);
      continue;
    }
    spendDelivery(pick, [k.kind]);
    plan.push({ from: pick, to: n, kinds: [k.kind], sameRoom: pick.room === n.room,
      hops: deliveryHops(pick.room, n.room) });
  }
}

for (const p of plan)
  console.log(`  ${p.from.character} -> ${p.to.character} (${AMOUNT} ${p.kinds.join(' + ')})` +
              (p.sameRoom ? '  [same room — no walk]' : `  [walk: ${p.from.room} -> ${p.to.room}]`));
if (DRY) { console.log('\ndry run — nothing handed over'); process.exit(0); }

// COOK ONCE, AFTER THE LAST DELIVERY THIS ONE IS WAITING ON. A recipient short of both
// reagents now gets two hand-overs from two donors, and casting after the first spends an
// errand on a spell that fails silently for want of the other half. Count down instead,
// and only cast for a recipient whose deliveries all landed — a partial resupply is a
// character to leave stocked for the next pass, not one to make cast and fail.
const owed = new Map();
for (const p of plan) owed.set(p.to.agent, (owed.get(p.to.agent) || 0) + 1);
const missed = new Set();

for (const p of plan) {
  try {
    // THE GIVER WALKS BY DEFAULT — but if it cannot, send the receiver instead.
    //
    // The surplus pools where the good farmers are, and they are good farmers partly
    // because they stay put. When every donor sits in one room whose exit is refused
    // ("no floor anywhere on the west boundary"), giver-walks fails for the whole
    // fleet at once and nothing moves — which is exactly what happened: seven of seven
    // deliveries, one error, one room.
    //
    // Swapping who walks costs nothing and fails independently: a blocked edge is
    // directional and about the room being LEFT, so the reverse trip is a different
    // question with a different answer. It is also the better trip on its own terms —
    // the starving character has an empty pack and nothing to lose by moving, while
    // the donor is mid-hunt with a full one.
    let r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                   what: 'reagents', amount: AMOUNT, who_travels: 'from' });
    if (r?.supplied !== true && /could not get there|no floor|boundary/i.test(JSON.stringify(r))) {
      console.log(`    ${p.from.character} is walled in — sending ${p.to.character} to fetch instead`);
      r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                 what: 'reagents', amount: AMOUNT, who_travels: 'to' })
                .catch(e => ({ supplied: false, reason: e.message }));
    }
    // `supplied` is the field the tool actually returns — not `delivered`, `ok` or
    // `received`, all of which I guessed and none of which exist. Guessing read a
    // successful hand-over as a failure and skipped the cast that was the whole point,
    // while the goods sat in the recipient's pack. Verify against the response, and
    // against `receiver_carrying`, which is the tool's own proof it landed.
    const ok = r.supplied === true && (r.receiver_carrying ?? 0) > 0;
    console.log(`  ${p.from.character} -> ${p.to.character}: ` +
                (ok ? 'delivered' : 'NOT delivered') + ' ' + JSON.stringify(r).slice(0, 160));
    owed.set(p.to.agent, (owed.get(p.to.agent) || 1) - 1);
    if (!ok) { missed.add(p.to.agent); continue; }
    if (owed.get(p.to.agent) > 0) {
      console.log(`    ${p.to.character}: still waiting on another reagent — cooking after that one`);
      continue;
    }
    if (missed.has(p.to.agent)) {
      console.log(`    ${p.to.character}: one of its deliveries failed, so not asking it to cast yet`);
      continue;
    }

    // COOK, EAT, THEN AIM HIGHER. Handing over reagents changes nothing on its own —
    // the character has to spend them, and then be told that 80 vigor is no longer
    // good enough to set out at. provision() climbs to the floor by eating, which it
    // can only do now that it has something to cook.
    await call('cast', { agent: p.to.agent, spell: 'create food' }).catch(() => {});
    await sleep(1200);
    await call('autopilot', { agent: p.to.agent, fight_above_vigor: FLOOR }).catch(() => {});
    console.log(`    ${p.to.character}: cast create food, now fighting above ${FLOOR} vigor`);
  } catch (e) {
    console.log(`  ${p.from.character} -> ${p.to.character}: FAILED ${e.message}`);
  }
}
process.exit(0);
