// HOW A SURPLUS IS SHARED OUT: THE PURE HALF OF THE ALMONER, SO IT CAN BE TESTED.
//
// m59-almoner.mjs is a script with top-level side effects — it takes the fleet run lock and
// starts calling the broker on import — which is the same reason m59-broker.mjs must not be
// imported to check it. So the two decisions that have actually been wrong live here instead,
// as functions of their arguments, and m59-almoner-share-test.mjs pins them.
//
// Both bugs this file exists for were invisible in the code and obvious in a dry run:
//
//   1. A donor preference that could not say "neither". `a.room === n.room ? -1 : ...` answers
//      -1 the moment `a` is in the recipient's room, INCLUDING when `b` is standing there too,
//      so with every donor in one room the hops and remaining-stock tie-breaks after it were
//      never reached. Measured room 39: Fozzie holding 224 meals and Kermit 191, and all seven
//      hand-overs planned out of Kermit while the larger larder was never asked.
//
//   2. Dealing a larder in pack order. What a hungry character converts into vigor in one
//      sitting is bounded by `filling`, not by how many objects it was handed — a stomach
//      admits 100. Ten slices of pork (9 nutrition, 20 filling) is 45 vigor in the sitting;
//      ten inky-caps (50 nutrition, 25 filling) is 200 over the same stomach.

/** Vigor per unit of stomach. The ranking that matters to someone who is about to eat. */
export const foodDensity = (f) => (f?.nutrition ?? 0) / Math.max(1, f?.filling ?? 1);

/**
 * Best-first, so a hand-over deals the densest food in the larder rather than the topmost.
 *
 * `suspect` names food the HARNESS cannot see — a stack whose wire name is plural misses
 * `foodValue`'s raw lookup, so `larderOf` returns nothing, `has_food` reads false and the
 * fighting floor collapses to 80 however much of it the character is carrying. Such a stack is
 * still real food and still worth handing over when there is nothing better; it is simply
 * worth LESS than an equal weight of pork, because the recipient will not be told to eat it.
 * So it sorts last rather than being excluded — a hungry character with only spider eyes to
 * offer should still offer them.
 */
export const orderLarder = (stacks, suspect = null) => {
  const bad = (s) => (suspect && suspect.has?.((s.name || '').toLowerCase())) ? 1 : 0;
  return [...stacks].sort((a, b) => bad(a) - bad(b) ||
                                    foodDensity(b.food) - foodDensity(a.food) ||
                                    (b.food?.nutrition ?? 0) - (a.food?.nutrition ?? 0));
};

/**
 * Which food names this fleet is currently carrying that the harness does not resolve.
 *
 * Derived from the fleet rather than hard-coded, because the list is a property of the name
 * table and the wire, not of this tool. The inference is sound in one direction only: if a
 * character holds a non-empty larder and `has_food` is false, then `larderOf` resolved NOTHING
 * in that pack, so every food name in it failed. Union those.
 *
 * `alive` guards the innocent case — a character between logging out and being rejoined has a
 * session and no client, so `larderOf` honestly returns nothing and its perfectly ordinary pork
 * would otherwise be indicted. Sweetums did exactly that once, holding nine slices with `vigor
 * 0` on the same row, and read true again on the next pass.
 */
export function invisibleFoodNames(larders) {
  const out = new Set();
  for (const h of larders) {
    if (h.harnessSeesFood !== false || !h.meals || h.alive === false) continue;
    for (const s of h.stacks || []) if (s.name) out.add(String(s.name).toLowerCase());
  }
  return out;
}

/**
 * Which {id, amount} entries make up one share, and what is left behind.
 *
 * Named ids rather than a symbolic `what: 'food'`, because that form hands over the giver's
 * ENTIRE larder — the first recipient would take the whole trip and everyone behind it would
 * get nothing, while the run reported success for both.
 */
export function dealShare(stacks, want, keepBack = 0, suspect = null) {
  const ordered = orderLarder(stacks.filter(s => s.id != null && s.amount > 0), suspect);
  const have = ordered.reduce((n, s) => n + s.amount, 0);
  let left = Math.max(0, Math.min(want, have - keepBack));
  const give = [];
  for (const s of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, s.amount);
    if (take <= 0) continue;
    give.push({ id: s.id, amount: take });
    left -= take;
  }
  return { give, dealt: give.reduce((n, g) => n + g.amount, 0), had: have };
}

/**
 * Who should feed this one. Prefers a donor already standing with the recipient, because the
 * walk through monster rooms is the expensive and failure-prone half; then the shorter walk;
 * then whoever has most left, which is what spreads the load instead of draining one larder.
 */
export function chooseDonor(donors, recipient, { left, trips, foodAmount, keepFood,
                                                 maxHops, maxDeliveries, hops,
                                                 splitRooms = null }) {
  // A ROOM NUMBER IS NOT A PLACE IN A SPLIT ROOM.
  //
  // Room 39, Upstairs in Castle Victoria, is 17x48 and its walkable area is TWO components —
  // cols 1-24 and cols 27-47, with 25-26 solid — and each half owns one of the two doorways to
  // room 38 (`r8c24`/`r9c24` west, `r8c27`/`r9c27` east, all arriving at `r1c18`). Two
  // characters "in room 39" may therefore be unable to reach each other without walking out to
  // 38 and back. Ten rooms on this map are like that; the fleet lives in three of them (39,
  // 377 The Sewers of Jasper, 578 The Cragged Mountains).
  //
  // The fleet row carries no coordinates, so which half somebody is in is NOT knowable here.
  // Hence: keep the same-room preference — it is still the best guess and free when it is right
  // — but withhold the cap exemption, which is what let one donor be assigned unlimited
  // "free" deliveries in a room where half of them cannot happen.
  const free = (d) => d.room === recipient.room && !splitRooms?.has?.(d.room);
  const eligible = donors.filter(d =>
    d.agent !== recipient.agent &&
    (left.get(d.agent) ?? 0) >= foodAmount + keepFood &&
    // THE CAP COUNTS WALKS, NOT EXCHANGES. `--max-deliveries` was written against a pass that
    // assigned one character five recipients across three towns; that cost is the WALK. Two
    // characters on the same square cost each other no steps, so capping those guards nothing
    // and starves a room: three donors held 520 meals for eight starving room-mates and a cap
    // of two would have fed six of them and called it a pass.
    (free(d) || (trips.get(d.agent) ?? 0) < maxDeliveries) &&
    hops(d.room, recipient.room) <= maxHops);
  // Subtracting the two booleans gives the honest three-way answer: -1, 0 or 1. A ternary that
  // returns -1 whenever `a` qualifies can never report a tie, and a comparator that cannot
  // report a tie silently discards every tie-break behind it.
  return eligible.sort((a, b) =>
    ((b.room === recipient.room) - (a.room === recipient.room)) ||
    hops(a.room, recipient.room) - hops(b.room, recipient.room) ||
    (left.get(b.agent) ?? 0) - (left.get(a.agent) ?? 0))[0];
}

/** The whole food round's plan: who hands what to whom, before anything is on the wire. */
export function planFoodHandovers({ larders, foodAmount, keepFood, floor,
                                    maxHops, maxDeliveries, hops, alreadyHandled = null,
                                    splitRooms = null }) {
  const donors = larders.filter(h => h.meals >= foodAmount + keepFood)
                        .sort((a, b) => b.meals - a.meals);
  // NEED IS A FLOOR IT CANNOT REACH, NOT AN EMPTY PACK — and not the character's OWN target.
  // The harness drops that to the resting cap whenever a larder is empty, precisely so an
  // unfed character is not idle-locked, so the hungriest characters are the ones whose target
  // reads 80 and who therefore look perfectly satisfied. Judge against the floor being given.
  //
  // AND DO NOT DO BOTH THINGS TO ONE CHARACTER IN ONE PASS. `alreadyStocked` has just told this
  // character it may fight above the floor, on the grounds that its own larder covers the climb.
  // Planning a hand-over to it as well contradicts that in the same breath — it is not short, it
  // was only mis-targeted — and it spends an exchange that a genuinely empty pack could have had.
  // Measured 2026-09-05, 10:50 pass: the only two hand-overs planned were to Robin and Janice,
  // both of whom appear in that pass's raise list, and both failed. Nothing else was attempted.
  const hungry = larders.filter(h => h.meals < foodAmount && h.vigor < floor &&
                                     !alreadyHandled?.has?.(h.agent))
                        .sort((a, b) => a.vigor - b.vigor);
  const left = new Map(donors.map(d => [d.agent, d.meals]));
  const trips = new Map(donors.map(d => [d.agent, 0]));
  const plan = [];
  for (const n of hungry) {
    const pick = chooseDonor(donors, n, { left, trips, foodAmount, keepFood,
                                          maxHops, maxDeliveries, hops, splitRooms });
    if (!pick) continue;
    left.set(pick.agent, (left.get(pick.agent) ?? 0) - foodAmount);
    // Only a NON-split same-room pair is free of the walk cap; see chooseDonor.
    const free = pick.room === n.room && !splitRooms?.has?.(pick.room);
    if (!free) trips.set(pick.agent, (trips.get(pick.agent) ?? 0) + 1);
    plan.push({ from: pick, to: n, sameRoom: pick.room === n.room, free,
                maybeFarHalf: pick.room === n.room && !!splitRooms?.has?.(pick.room) });
  }
  return { donors, hungry, plan };
}

/**
 * Who is already holding the answer and being told not to use it.
 *
 * A larder is only drawn on BELOW the fighting floor, and the harness drops that floor to the
 * resting cap when a pack is empty. Nothing puts it back when food arrives by another route —
 * a hall run, a lucky drop, a bot's errand — so a character can carry a fortnight of meals at
 * a target of 80, never eat one, and look satisfied to every report here. Gonzo with 100
 * spider eyes at 80/80 and Scooter with 140 at 88/80 were found this way: 240 meals, the
 * almoner's usual day's work, released by one call each and no hand-over at all.
 *
 * THE CLAMP IS ONE-WAY, AND THAT IS THE WHOLE BUG. `reachableFightFloor(floor, max, food)` is
 * `min(floor, 0.4*max + food)`, so an empty larder collapses any floor you ask for to 80
 * (m59-autopilot.mjs:1309, and m59-autopilot-policy-test pins `reachableFightFloor(140,200,0)
 * === 80`). It runs when the food runs out. Nothing runs when the food comes back.
 *
 * A RAISED FLOOR IS NOT DURABLE WHILE A BOT IS ATTACHED, AND ONE SWEEP PER PASS IS THE POINT.
 *
 * First measurement, 2026-09-05: `fight_above_vigor: 140` set on two characters and read back
 * at +20s, +40s, +60s and +90s held at 140 every time, with DUM running `--commit`. That was
 * read as "nobody is contesting this number", and it was too short a window to say so. Over
 * the next thirty minutes the same characters were back at 80 — Scooter, Bunsen and Waldorf
 * were each raised to 140 by a pass and read 80 at the next one, while the fleet-wide count of
 * characters above the resting cap went 14 -> 5 with everyone still carrying food.
 *
 * The tell is the VALUES. Something writes 80 and 200 and never 140, which is not this tool's
 * vocabulary — so a second policy source with its own two-valued doctrine is reasserting over
 * the top on a clock somewhere between 90 seconds and half an hour.
 *
 * That does not make the sweep useless; it makes it a REPEATING one. `fight_above_vigor` is
 * work policy, and work belongs to whichever bot the operator pointed at the fleet (see the
 * boundary table in CLAUDE.md) — so the answer is NOT to re-write the floor on a heartbeat and
 * fight for it. It is to raise it once per pass, take the vigor that buys between passes, and
 * fix the doctrine in the bot if the reversion turns out to be wrong there. Mean fleet vigor
 * over three passes on that morning: 101 -> 113 -> 118, while the floor readings sawtoothed.
 * The vigor is the outcome; the floor reading is an instrument, and a noisy one.
 */
export const alreadyStocked = (larders, floor) =>
  larders.filter(h => h.target < floor && h.vigor < floor && h.nutrition >= (floor - h.vigor));

/**
 * Which of these rooms have their walkable area in more than one piece.
 *
 * Derived from the bake, never a hard-coded list: it is a fact about the geometry, and a
 * hand-maintained list of room numbers is exactly the thing that goes stale after a re-bake.
 * Only rooms the survey actually mentions are examined, so this costs a flood fill over a
 * handful of grids rather than the whole world.
 *
 * `minPart` ignores slivers — a two-square ledge cut off behind a wall is not a "half" anybody
 * is standing in, and counting it would mark almost every outdoor room split.
 */
export function splitRoomsAmong(roomNums, { map, geometryFor, minPart = 20 } = {}) {
  const out = new Set();
  for (const num of new Set([...roomNums].filter(n => Number.isInteger(n)))) {
    const room = map?.rooms?.[String(num)];
    if (!room?.roo) continue;
    let geo;
    try { geo = geometryFor(room); } catch { continue; }
    const R = geo?.rows, C = geo?.cols;
    if (!R || !C) continue;
    const seen = new Set();
    const key = (r, c) => r * (C + 2) + c;
    let big = 0;
    for (let r = 1; r <= R && big < 2; r++) {
      for (let c = 1; c <= C && big < 2; c++) {
        if (!geo.walkable(r, c) || seen.has(key(r, c))) continue;
        const stack = [[r, c]];
        seen.add(key(r, c));
        let n = 0;
        while (stack.length) {
          const [a, b] = stack.pop();
          n++;
          for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nr = a + dr, nc = b + dc;
            if (nr < 1 || nc < 1 || nr > R || nc > C) continue;
            if (!geo.walkable(nr, nc) || seen.has(key(nr, nc))) continue;
            seen.add(key(nr, nc));
            stack.push([nr, nc]);
          }
        }
        if (n >= minPart) big++;
      }
    }
    if (big > 1) out.add(num);
  }
  return out;
}
