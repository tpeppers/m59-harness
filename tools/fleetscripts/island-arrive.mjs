// ARRIVED ON THE ISLAND TO STAY: VAULT WHAT THE JUNGLE WILL NOT TAKE, THEN TAKE UP THE ISLAND'S ORDERS.
//
// Operator, 2026-10-27: "People who arrive at the island should vault anything they can't bring into the jungle and
// prepare to start carefully farming Avar warriors". Run per arrival (island-trip with stay, or by hand):
//
//   island-arrive agents=t12                                         vault only
//   island-arrive agents=t12 strategy=<farm strategy> station=2115   vault, then farm it, carefully
//
// 1. Ko'catan's vault (2005, Itzal cha'Nosak): everything the jungle guard would refuse (jungleStashPlan) is deposited
//    by name, worn spares taken off first, and the pack is read back: nothing refusable may remain
//    (m59-island-chalice.mjs vaultForJungle).
// 2. With a strategy: the farm order, with the careful thresholds this script states out loud (rest at restBelow, log off on
//    a proven wall at fleeBelow) and town trips off (the mainland towns are a cave and a sea away). The ORDERS are this machine's: the
//    strategy file names the quarry and the rooms; this script only assigns it.
import { verify, act } from '../m59-fleetscript.mjs';
import { vaultForJungle } from '../m59-island-chalice.mjs';

export const script = {
  name: 'island-arrive',
  describe: "On the Island to stay: vault what the jungle guard refuses at Ko'catan (2005), then optionally take up a farm strategy carefully",
  params: {
    agents: { type: 'agents', required: true },
    strategy: { type: 'string', default: '', describe: 'a farm strategy to assign after vaulting (empty: vault only)' },
    station: { type: 'room', default: 0, describe: 'assigned room for the farm (0: the strategy\'s own station)' },
    restBelow: { type: 'number', default: 0.8, describe: 'careful: rest below this fraction of health' },
    // flee_below is the moment to LOG OFF on a proven wall (broker schema), not a withdrawal: the troll crew's 0.45.
    fleeBelow: { type: 'number', default: 0.45, describe: 'careful: log off on a proven wall below this fraction of health (not a withdrawal)' },
  },
  async steps(p) {
    if (!(p.fleeBelow > 0 && p.fleeBelow < p.restBelow && p.restBelow <= 1)) throw Error('fleeBelow must be under restBelow, both fractions of health');
    return [
      act('cancel_movement', {}),
      verify(ctx => vaultForJungle(ctx, { record: (ctx.state.islandArrive ??= {}) }), "Ko'catan vault step incomplete"),
      ...(p.strategy ? [verify(async ctx => {
        const r = await ctx.call('autopilot', { agent: ctx.agent, action: 'start', mode: 'farm', farm_strategy: p.strategy,
          rest_below: p.restBelow, flee_below: p.fleeBelow, town_trips: false, ...(p.station ? { assigned_room: p.station } : {}),
          why: 'island arrival: careful farming after the vault' });
        if (r?.started === false) throw Error('farm order refused: ' + (r.reason ?? 'unknown'));
        return true;
      }, 'island farm order not accepted')] : []),
    ];
  },
};
