// RECIPES FOR CAPABILITIES THAT ARE NOT FLEETSCRIPTS YET.
//
// The FleetBook's home is a `recipe` block on the script it describes, because a recipe next
// to its steps cannot drift from them. Some of what this fleet can actually DO is not a
// fleetscript though — it is a standalone tool with its own loop — and leaving those out
// would make the book quietly wrong about the fleet's capabilities, which is the one failure
// a generated index exists to prevent.
//
// So they live here, MARKED. `backed_by` names the tool that really does the work and
// `fleetscript: false` says out loud that this one has not been compiled into the guarantees
// yet. That is a to-do list as much as a book: anything in this file is a capability nobody
// can get the run lock, the health floor or the read-back verification for.
export const recipes = [
  {
    name: 'master-shalille',
    fleetscript: false,
    backed_by: 'tools/m59-shalille-train.mjs',
    recipe: {
      effect: 'Raises a healer through the Shal\'ille ladder by healing a high-karma patient ' +
              'who hurts himself on purpose with an Amulet of Shadows. Earns the KARMA the ' +
              'school gates on at the same time, which is the reason to do it this way rather ' +
              'than by buying spells alone.',
      run: 'node tools/m59-shalille-train.mjs --healer <agent> --patient <agent> --room <room> ' +
           '--mode heal --gather --apply --stop-when-learnable "<ability>"',
      needs: [
        'a patient with HIGH karma holding an Amulet of Shadows (Beaker, karma 70)',
        'both characters in ONE room, and an inn is the right kind of room',
        'the healer holds the level-N spell already — this practises, it does not buy',
        '3 herbs per hospice cast; ~10 mana per cast against the healer\'s ceiling',
        'a commander lease for the whole run: an unheld 20-health caster is walked into ' +
          'open country by its own keeper within minutes',
      ],
      cost: {
        time: 'about 6 casts per ability point, and ~3 minutes per cast at a 25 mana ceiling ' +
              '— so roughly 18 minutes per point, or ~17 HOURS for the 54 points that the ' +
              'level-4 gate ("forces of light") wanted from 61/115',
        reagents: '3 herbs per cast; ~320 casts is ~960 herbs, far more than the fleet holds',
        risk: 'low while both stay in the inn; the healer never fights',
        measured: '2026-09-09 on Loial the Ogier — hospice 24 -> 25 over 8 casts, ' +
                  'level-3 sum 60 -> 61 of the 115 needed',
      },
      scales: 'Cost per point is set by INTELLECT and by the mana ceiling, and both help ' +
              'twice. GetInitialChance is viChance_to_increase * (1 + intellect/100) — 15 * ' +
              '1.4 = 21 at intellect 40 — so ~79% of casts are thrown away before the ' +
              'second roll is even reached. A bigger mana pool buys more casts per rest. ' +
              'Every mana node melded therefore shortens this materially; see mana-nodes.',
      notes: [
        'THE GATE IS A SUM OF THREE, NOT ONE SPELL. PlayerCanLearn wants the best THREE ' +
          'abilities at level N-1 to total 115 for level 4, so practising a second and third ' +
          'level-3 spell is worth exactly as much as pushing the first one higher.',
        'There is an ANTI-BOT CAP: 10 improvements, then advancement stops until a timer ' +
          'of 15-22 minutes resets it, and changing room refunds 2 (player.kod:1465, ' +
          'commented "give them a break on the botting imp cap"). It allows ~33/hour and a ' +
          'mana-bound grind delivers ~2, so it is not usually what is limiting you — but ' +
          'check before blaming the loop.',
        'Hospice REFUSES a target at full health (hospice.kod:88, CanPayCosts) and the ' +
          'refusal is silent, so casts land on an undamaged patient and practise nothing. ' +
          'The patient has to be kept hurt for the loop to be worth anything.',
      ],
    },
  },
  {
    name: 'mana-nodes',
    fleetscript: false,
    backed_by: 'tools/m59-mananode.mjs, tools/m59-node-run.mjs',
    recipe: {
      effect: 'Permanently raises a character\'s MAX MANA by bonding with mana nodes. This is ' +
              'the only thing in the game that lifts the ceiling rather than refilling what is ' +
              'under it, and the nodes STACK — one bit each in a bitmask on the player.',
      run: 'walk the character into the node\'s room, then: node tools/m59-mananode.mjs --agent <agent>',
      needs: [
        'to be STANDING at the stone: the test is per-axis, abs(drow) < 3 AND abs(dcol) < 3 ' +
          '— a 5x5 box, not a radius, so 2 rows and 2 columns off is fine and 3 rows off is not',
        'positive karma for some nodes (a rejection is a sentence spoken to the room)',
        'a road to the node, which is the hard part rather than the meld',
      ],
      cost: {
        money: 'nothing — the stones are free',
        time: 'all of it is travel; 10-40 minutes per node depending on the road',
        risk: 'HIGH for a fragile character. The roads are what kills, not the stone.',
        measured: '2026-09-09 — Loial the Ogier, mysticism 50, melded NODE_ORCCAVES: ' +
                  'max mana 25 -> 33, exactly the +8 the formula predicts',
      },
      scales: 'The grant is ((5 + Mysticism) / 10) + 3, integer division — +3 at mysticism 0 ' +
              'and +8 at 45 and above. So a point of mysticism is usually worth nothing and ' +
              'a high-mysticism caster gets nearly three times what a fighter does.',
      notes: [
        'Room 27 has NO INBOUND EXIT and the router is right to say so. You get in by walking ' +
          'onto a TRIGGER: rows 15-17 x columns 1-6 of room 587 teleports you to r57c46 ' +
          '(h7.kod SomethingMoved). A trigger is a square with a consequence, not an exit.',
        'Routes to NODE_VICTORIA (39) and NODE_H9 (589) cross room 599, Ukgoth — which killed ' +
          'a 20-health caster on the first attempt. FleetScript now refuses a route through a ' +
          'known trap, so these need { allowTraps: true } and a character who can actually ' +
          'cross 599 (it needs a Relic of Qor and a spoken phrase).',
        'For a character already at the 20 max-health floor, dying costs NOTHING: piMax_health ' +
          'is bound below at 20 (player.kod:5930), abilities were unchanged across a measured ' +
          'death, and the corpse keeps its goods long enough to collect. That makes a fragile ' +
          'caster a BETTER node runner than it looks.',
      ],
    },
  },
];
