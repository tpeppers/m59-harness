// WALK BACK TO THE ROOM YOU ARE SUPPOSED TO BE IN.
//
// PUBLIC. The commonest errand there is, and the one most often written badly: a character
// that dies, or finishes a shop trip, is left wherever that put it, and with `roam: false`
// it then idles there indefinitely — not stalled, not flagged, just standing in a room its
// quarry does not spawn in.
//
// The health floor is the entire reason this is a script rather than a `travel` call. A
// recall written as a bare travel walked a character out of the inn it was healing in at 1
// of 44 health, back down the road that had just killed it. fleetScript refuses to start any
// journey below `minHealth` (default full, matching the harness's own travel_start_health),
// and treats UNKNOWN health as a refusal rather than as permission — which is what caught a
// character whose keeper had died and whose state could not be read at all.
import { walk } from '../m59-fleetscript.mjs';

export const script = {
  name: 'come-home',
  describe: 'Walk characters back to a room, refusing to set out hurt.',
  params: {
    agents: { type: 'agents', required: true, describe: 'who to bring back' },
    home: { type: 'number', required: true, describe: 'the room they belong in' },
    // Lowered only deliberately: an escort that leaves at half health is a different bet
    // from one that leaves whole, and the roads are what kills this fleet.
    minHealth: { type: 'number', default: 1, describe: 'fraction of health required to set out' },
  },
  async steps({ home }) {
    return [walk(home)];
  },
};
