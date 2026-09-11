// MELD ONE MANA NODE. THE ROAD, THE LAST TWELVE SQUARES, AND THE STONE.
//
// PUBLIC. A mana node is the only thing in this game that raises the MAX mana ceiling rather
// than refilling what is under it, and they STACK — one bit each in a bitmask on the player,
// `((5 + Mysticism) / 10) + 3` per node, so +8 for a caster at mysticism 45 and up.
//
// THREE THINGS MAKE THIS A SCRIPT RATHER THAN A `travel` AND AN `activate`.
//
// 1. ARRIVING IN THE ROOM IS NOT ARRIVING AT THE STONE. The meld test is the server's own and
//    it is a 5x5 BOX, not a radius — `abs(drow) < 3 AND abs(dcol) < 3`, judged per axis
//    (mananode.kod:177). So sixteen squares finish this errand and only one of them is the
//    stone's own square, which is frequently NOT STANDABLE because the stone is on it. That
//    is why the approach is `crawlTo(..., { within: 2 })` and not a walk to the stone.
//
// 2. THE LAST SQUARES ARE NOT A WALK. In a contested room `walk_to` PLANS, and its planner
//    uses the coarse grid, which in room 39 believes in ground the mover refuses — asked for
//    the square next door it routed a one-square step as a forty-square loop back across the
//    room. `crawlTo` hops one square at a time and asks the keeper's own `/movecheck` first.
//
// 3. AND A MONSTER IN THE WAY IS NOT THE GROUND REFUSING. The operator's own diagnosis of
//    the commonest inconsistency here: "maybe a monster blocked the jump". Collision is
//    height-agnostic, so a body on the take-off, in the arc or on the landing refuses a move
//    exactly like a wall — and unlike a wall, it walks away. `crawlTo` tells the two apart by
//    `object_blocked` vs `geometry_blocked` and WAITS the first one out.
//
// It cost a night to learn that the hard way: room 27's stone read as unreachable from every
// entrance, four different measurements agreed, and the operator had already melded it. The
// room had six orcs in it.
import { walk, crawlTo, rest, act, verify } from '../m59-fleetscript.mjs';

// EVERY MANA NODE IN THE WORLD, read out of the room classes that create them and stated in
// the KOD's own order — ROW FIRST. `tools/m59-mananode.mjs` carries the same table; that file
// and this one are the only two places this transposition is allowed to be got wrong.
// TEN STONES, AND THIS LIST HAD SEVEN. Derived against the kod on 2026-09-10 by
// `node tools/m59-stones.mjs --diff`, which reads every `Create(&ManaNode, ...)` in the source
// tree and joins it to the bake by .roo file. What was missing, and why nobody noticed:
//
//   * `ancient` (579, NODE_g9) was in m59-node-run.mjs's own separate list and not in this one,
//     so the errand could not be asked for a stone the circuit walks to.
//   * `martyr` (47, NODE_Q) and `ukgoth` (599, NODE_i9) are created WITHOUT A POSITION and
//     placed later by the room, so a grep for `#new_row=` cannot see them at all.
//
// Keep this list and the kod in step with `node tools/m59-stones.mjs --check`, which exits
// non-zero on drift. Two hand-written lists of the same ten things is how the last one rotted.
export const NODES = Object.freeze({
  cave:     { room: 27,   node: 'NODE_ORCCAVES', row: 23, col: 53, where: 'A Deep, Dark, Spooky, Icky Cave' },
  victoria: { room: 39,   node: 'NODE_VICTORIA', row: 13, col: 46, where: 'Upstairs in Castle Victoria' },
  badlands: { room: 45,   node: 'NODE_BADLANDS', row: 63, col: 46, where: 'The Badlands' },
  peak:     { room: 515,  node: 'NODE_A5',       row: 20, col: 17, where: "Seafarer's Peak" },
  ancient:  { room: 579,  node: 'NODE_g9',       row: 52, col: 30, where: 'An ancient place, its origin forgotten' },
  sentinel: { room: 589,  node: 'NODE_H9',       row: 45, col: 32, where: 'Under the shadow of the Sentinel' },
  // AN APPROACH, NOT A MELD. Operator, 2026-09-10: "the Dreaded Caves of Ice node requires
  // killing the Yeti to get access... the goal should actually just be to walk to within a few
  // coarse squares away from the mana node (in the dreaded caves this means the biggest room)."
  //
  // The kod is more specific and worse: a yeti kill lifts the MANA_DOOR ceiling sector to 510
  // for TWO SECONDS and then drops it back to 380, and it does not lift at all if the node's
  // own attack made the kill (icecave1.kod SomethingKilled / LowerManaDoorTimer). So this
  // errand's `verify` step — which requires MAX MANA to rise — cannot pass here, and should
  // not be asked to: send the walk, stop at the chamber.
  ice:      { room: 750,  node: 'NODE_ICECAVE1', row: 25, col: 23, where: 'The Dreaded Caves of Ice',
              objective: 'approach', approach_within: 5,
              gate: 'killing a yeti lifts the MANA_DOOR ceiling sector for 2s (icecave1.kod)' },

  // A STONE THAT IS NOT THERE UNTIL SOMETHING HAPPENS. Neither of these is a walk-and-stand
  // errand, and sending a character to the square before the condition holds is standing on
  // nothing. `appears` is the citation, not a predicate to evaluate.
  martyr:   { room: 47,   node: 'NODE_Q',        row: 57, col: 45, where: "Martyr's Battleground",
              appears: 'only after canyon2.kod ActivatePortal() has run — a lever, not a walk',
              also: 'the room itself is unrouted: its only inbound is room 32 and the bake has ' +
                    'no route to either from town' },
  ukgoth:   { room: 599,  node: 'NODE_i9',       row: 27, col: 61, where: 'Ukgoth, Holy Land of Trolls',
              appears: 'only while the game hour is 0 (i9.kod RecalcLightAndWeather); the room ' +
                       'deletes it the rest of the day' },

  // THE ONE STONE THAT IS NOT MEANT TO BE GOT, and the only exception to this repository's own
  // axiom that every node stands where a person can walk. Operator, 2026-09-10: "The 'Hazar'
  // mana node is unreachable for normal players, by the way, it's meant to demo the mana node
  // existence for guest players." It sits in the instanced guest Mausoleum, which the bake
  // carries as BOTH 1006 and 1016 and to which no route exists from anywhere — that absence is
  // the design, not a missing affordance, and a run that spends a night on it has been fooled
  // by its own tooling.
  mausoleum:{ room: 1006, node: 'NODE_GUEST',    row: 35, col:  5, where: 'Mausoleum',
              rooms: [1006, 1016], guest_demo: true,
              appears: 'for GUEST players, as a demonstration — unreachable by design' },
});

// EVERY ROAD TO VICTORIA AND THE SENTINEL CROSSES 599, UKGOTH, WHICH IS IN `KNOWN_TRAPS` —
// AND THAT NO LONGER NEEDS A WAIVER. `routeCrossesTrap` used to refuse any route with a trap
// room anywhere in it; hop 8 of every Castle Victoria route is `598 -> 599`, so it refused the
// destination along with the transit and no character could travel to 39 or 2 at all. It is
// now ADVISORY for transit and still a refusal for a trap as the DESTINATION, which is the
// distinction that was missing. Nothing here waives anything.

export const script = {
  name: 'mana-node',
  provenance: {
    pinned: '3297122', verified: '2026-09-10',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-mananode.mjs'],
  },
  describe: 'Walk a character to a mana node and meld with it, waiting out whatever is standing in the way.',
  recipe: {
    effect: 'Permanently raises MAX mana by ((5 + mysticism) / 10) + 3. The nodes stack, and ' +
            'a meld cannot be undone or lost.',
    run: 'mana-node agents=<a> node=<cave|victoria|badlands|peak|ancient|sentinel|ice|fey>',
    // TWO OF THEM ARE APPROACHES AND THIS SCRIPT'S `verify` CANNOT PASS THEM. `ice` and `fey`
    // are gated behind a yeti and a faction war; the errand for those is to walk to within a
    // few coarse squares and stop. See tools/m59-stones.mjs, which is the tracked table this
    // list should be read from, and `node tools/m59-stones.mjs --check` for the drift.
    needs: ['a road the bake knows. victoria and sentinel cross 599 (Ukgoth) and no longer ' +
            'need a waiver to do it — transit through a trap is advisory, only a trap as the ' +
            'DESTINATION refuses',
            'positive karma at some stones; a rejection is a sentence spoken to the room',
            'a keeper process, because /movecheck and short_hop both live in it'],
    cost: { time: '10-40 minutes, nearly all of it road',
            risk: 'HIGH for a fragile character. The roads are what kills, not the stone. For a ' +
                  'character already at the 20 max-health floor a death costs nothing permanent ' +
                  '(piMax_health is bound below at 20, player.kod:5930) — but a corpse run costs ' +
                  'the night',
            measured: '2026-09-09 Loial the Ogier melded NODE_ORCCAVES, max mana 25 -> 33, exactly ' +
                      'the +8 the formula predicts. 2026-09-10 Marco Polo reached room 39 from ' +
                      'room 27 in under four minutes at full health and got within 4 squares of ' +
                      'NODE_VICTORIA' },
    scales: 'The grant is by MYSTICISM, so a high-mysticism caster gets nearly three times what ' +
            'a fighter does. The ROAD does not scale at all — it is the same walk either way.',
    notes: ['The receipt is MAX MANA, read before and after inside ONE session. Never across a ' +
            'login: ComputeMaxMana rebuilds the ceiling from the node bitmask on every login, so ' +
            'a delta measured across that boundary measures the recompute and not the meld.',
            'A refusal — "You have already bonded with this mana node", "not close enough" — is a ' +
            'SENTENCE SPOKEN TO THE ROOM with a successful call underneath it. There is no error ' +
            'on the wire to read.',
            'A failed attempt is evidence about where the monsters were standing, not about the ' +
            'ground. Two identical refusals inside one visit is not a finding; two across visits ' +
            'with the room in a different state is.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who is going' },
    node: { type: 'string', required: true,
            describe: `which stone: ${Object.keys(NODES).join(', ')}` },
    // The road is what kills, so the default is to set out whole. Lowered deliberately for a
    // character at the max-health floor, for whom dying is cheap.
    minHealth: { type: 'number', default: 1, describe: 'fraction of health required to set out' },
    healBelow: { type: 'number', default: 0.5,
                 describe: 'stop and rest at a safe wall when health falls below this, mid-crawl' },
    bodyRetries: { type: 'number', default: 8,
                   describe: 'how many times to wait for a monster to move out of the way' },
  },

  async steps({ node, healBelow, bodyRetries }) {
    const spot = NODES[String(node ?? '').toLowerCase()];
    if (!spot)
      throw new Error(`no mana node called "${node}". Pick one of: ${Object.keys(NODES).join(', ')}`);

    return [
      // Set out whole where possible. OPTIONAL because a refusal here is the guarantee
      // working — `rest` walks to a safe wall and will not sit down in the open — and a road
      // with nowhere safe on it is not a reason to abandon the errand.
      rest({ health: 0.99, optional: true }),
      act('rest', { stand: true }),

      // The road. `walk` keeps the health floor, a budget sized from the road's own p90, and
      // the trap check that refuses a route through a room we know keeps characters.
      walk(spot.room),
      act('rest', { stand: true }),

      // The last squares. `within: 2` because the meld box is 2 per axis and the stone's own
      // square is often not standable.
      crawlTo(spot.col, spot.row, {
        within: 2, room: spot.room, healBelow, bodyRetries,
        deadlineMs: 600_000,
      }),

      // THE MELD, AND ITS RECEIPT IS THE CEILING.
      verify(async ({ agent, call, state }) => {
        const seen = await call('look', { agent }).catch(() => null);
        const stone = (seen?.objects || []).find(o => /mana node/i.test(o.name || ''));
        if (!stone) {
          console.log(`  no mana node among the room's contents — ${spot.where} should have ` +
                      `one at r${spot.row}c${spot.col}`);
          return false;
        }
        const before = await call('status', { agent, brief: true }).catch(() => null);
        const ceiling = s => s?.mana?.max ?? s?.vitals?.mana?.max ?? null;
        const was = ceiling(before);
        await call('act', { agent, verb: 'activate', target: stone.id ?? stone.name })
          .catch(() => {});
        // The grant lands on the player and the status read is not instant.
        await new Promise(r => setTimeout(r, 3000));
        const now = ceiling(await call('status', { agent, brief: true }).catch(() => null));
        state.meld = { node: spot.node, room: spot.room, before: was, after: now,
                       gained: Number.isFinite(was) && Number.isFinite(now) ? now - was : null };
        console.log(`  ${spot.node}: max mana ${was} -> ${now}` +
                    (now > was ? `  MELDED, +${now - was}`
                               : '  no change — already bonded with it, or out of the 5x5 box'));
        return now > was;
      }, 'max mana did not rise: either already bonded with this node, or not inside the ' +
         '5x5 box (abs(drow) < 3 AND abs(dcol) < 3, per axis)'),
    ];
  },
};
