// GET A NEW CHARACTER OUT OF THE NEWBIE ZONE AND TO WHERE IT WILL LIVE.
//
// PUBLIC. The first errand any character ever runs, and until now the one thing FleetScript
// could not say. Raza has no door: the only way out is a portal standing in the Grand
// Museum (room 1018) at col 11 row 2, and it takes TWO touches — the first bounces you off
// with a warning. `travel` cannot express that and does not refuse either; asked to walk a
// character from the Raza Inn to Barloque it answered `started: true, hops: 0` and moved
// nobody. Nothing errored, which is this game's ordinary way of failing.
//
// THE ORDER OF THE TWO STEPS IS THE POINT. Leaving is a portal; the onward leg is a
// cross-world journey and belongs to `walk`, so it gets the health floor, the p90-sized
// wait, the once-only travel and the trap check. The broker's `leave_raza` tool will do the
// onward journey itself if asked (`then_travel_to`) and that is exactly what this must not
// use: it would run the most dangerous leg a new character ever takes outside every
// guarantee this file exists to compile in.
//
//   node tools/m59-fleet-repl.mjs                     then: run graduate agents=t22 home=101
//   node tools/fleetscripts/graduate.mjs --agents shadowmerch1 --home 101
import { leaveRaza, walk } from '../m59-fleetscript.mjs';

export const script = {
  name: 'graduate',
  provenance: {
    pinned: 'af74fe2', verified: '2026-09-09',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs'],
  },
  describe: 'Walk a new character out of Raza through the museum portal, then on to its town.',
  recipe: {
    effect: 'Takes a freshly created character out of the newbie zone and puts it in the ' +
            'world, then optionally walks it on to the town it will live in.',
    run: 'graduate agents=<a> home=<room>',
    needs: ['a character still in Raza', 'the museum portal reachable from where it stands'],
    cost: { time: 'a couple of minutes for the portal, then an ordinary road for the rest',
            risk: 'the portal drop is random, so the onward leg starts from somewhere unplanned',
            estimate: 'not separately measured; the onward leg is a come-home and costs what that costs' },
    notes: ['The portal is a STEP and the onward journey is a SEPARATE walk, which is what ' +
            'keeps the health floor and the trap check on the second half.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the new character(s)' },
    // OPTIONAL, because the museum portal does not drop you anywhere predictable — it is
    // random, and often nowhere near a town. Naming a `home` walks it on from wherever it
    // lands; omitting one leaves it there and reports the room, which is the right default
    // for a brand-new character nobody wants marched down a road at 20 hit points.
    home: { type: 'number', required: false, describe: 'room to walk on to; omit to stop where the portal drops it' },
    // A NEW CHARACTER IS NEVER AT FULL HEALTH FOR LONG AND THE ROAD IS WHAT KILLS IT.
    // The default is the harness's own travel_start_health rather than a lower number
    // chosen to make this errand succeed more often; the roads outside Raza have killed
    // characters on this fleet within twenty minutes of setting out.
    minHealth: { type: 'number', default: 1, describe: 'fraction of health required to set out' },
  },
  async steps({ home }) {
    return home == null ? [leaveRaza()] : [leaveRaza(), walk(home)];
  },
};
