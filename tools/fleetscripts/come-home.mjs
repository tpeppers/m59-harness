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
  // GUARANTEE 9. A recall is one `walk`, so the only things that can move under it are the
  // step itself and the travel tool behind it. Narrow `touches` on purpose: a pin that
  // watches the whole tree cries wolf on every commit and gets ignored, which is worse than
  // no pin at all.
  provenance: {
    pinned: 'dbcc73e', verified: '2026-09-07',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs'],
  },
  describe: 'Walk characters back to a room, refusing to set out hurt.',
  recipe: {
    effect: 'Puts named characters in a named room. The point is the REFUSAL: it will not ' +
            'start a journey on a hurt character, and it treats health it cannot read as a ' +
            'refusal rather than as permission.',
    run: 'come-home agents=<a,b> home=<room>',
    needs: ['full health to set out, unless minHealth is lowered on purpose',
            'a route the bake knows — and one that does not cross a KNOWN_TRAP'],
    cost: { time: '1-15 minutes a character, all of it road',
            risk: 'the roads are what kills this fleet; a 20-health caster is at real risk ' +
                  'and a 60-health fighter mostly is not',
            measured: '2026-09-09 — 370->587 and 27->49 arrived at FULL health; 376->39 died ' +
                      'to trolls because the route crossed 599' },
    scales: 'Cost is the road, not the errand: distance and what lives on it. Sending a ' +
            'tougher character along with a fragile one measurably helped.',
    notes: ['A journey deliberately does NOT flee monsters — "a monster cannot end a journey" ' +
            '— so the flee threshold does not save a fragile character en route.'],
  },
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
