// flee-to-room — THE SHAPE OF A PVP STRATEGY, not anybody's orders. Copy it into substrate/pvp-strategies/
// (or a private directory listed in substrate/pvp-strategy-dirs.json) under a name of your own, and assign
// it in substrate/pvp-strategy-<fleet>.json. tools/m59-pvp-strategy.mjs has the contract.
//
// Assignment example (substrate/pvp-strategy-<fleet>.json):
//   { "default": { "strategy": "flee-to-room", "options": { "room": 714, "enemies": ["Somebody"], "hold_ms": 600000 } },
//     "characters": { "A Merchant Friend": null } }
//
// What it does: a hit from any player, or the sight of a named enemy, anywhere but `room`, sends the character
// to `room` and holds it there for `hold_ms`. In `room` it answers nothing, so the character's own pvp_rooms
// and war response decide -- or set `engage_in_room: true` to fight there whatever pvp_rooms says.
export default {
  name: 'flee-to-room',
  describe: 'Run to one room when attacked or when a named enemy is seen; fight only there.',
  decide(moment, facts, options) {
    const room = Number(options.room);
    if (!(room > 1)) return null;
    const enemies = (options.enemies ?? []).map(n => String(n).toLowerCase());
    const named = enemies.includes(String(facts.player ?? '').toLowerCase());
    if (facts.room === room) {
      if (options.engage_in_room && (moment === 'attacked_by_player' || named || facts.hostile)) return { do: 'engage' };
      return null;
    }
    if (Number(options.min_max_health) > 0 && Number(facts.max_health) <= Number(options.min_max_health)) return null;
    const hold_ms = options.hold_ms ?? 600_000;
    if (moment === 'attacked_by_player') return { do: 'flee_to', room, hold_ms, why: `attacked by ${facts.player}` };
    if (moment === 'player_seen' && (named || (options.flee_on_hostile && facts.hostile)))
      return { do: 'flee_to', room, hold_ms, why: `saw ${facts.player}` };
    return null;
  },
};
