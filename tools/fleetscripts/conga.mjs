// GATHER THE FLEET IN ONE ROOM AND LEAVE IT LISTENING FOR "FOLLOW ME".
//
// PUBLIC. The operator wants every character standing in one place, doing nothing, ready to
// walk behind a piloted character in a line. This is the GATHER and the QUIETING; the walking
// itself is already built and is not re-implemented here.
//
// WHAT ALREADY DOES THE CONGA, AND WHY NOTHING NEW WAS WRITTEN FOR IT.
//
// `m59-follow.mjs` is the line, and the keeper runs it every pass in `passFollow`. Say
// "follow me" (or "on me", or "with me") in the room and every fleet member there starts
// walking YOUR TRAIL — the squares you actually stood on, consumed OLDEST FIRST — until you
// say "stop" or "hold here". That is a conga line rather than a swarm, and the distinction is
// deliberate: walking AT a leader is a beeline, and a beeline is what fails in exactly the
// rooms a person leads a group through.
//
// So this script's whole job is to put everyone in earshot and make sure nothing else is
// giving them orders when you speak.
//
// ---------------------------------------------------------------- three things it has to do
//
// 1. GET THEM THERE. `walk` carries the guarantees: a health floor under every journey, the
//    keeper's own in-flight journey cancelled at claim time so the errand is not fighting it,
//    budgets sized from the journey's own p90, and travel issued once rather than re-issued
//    into itself.
//
// 2. STOP THEM LEAVING AGAIN. A keeper walks its character back to `assignedRoom` the moment
//    the errand's lease lapses, so a gather that only WALKS is undone within a minute. Each
//    character's station is therefore re-pointed at the gathering room and `roam` switched
//    off. This is the step that makes "gathered" mean something after the script exits.
//
// 3. LEAVE THE BODY LISTENING. `mode: idle` stops the keeper hunting without stopping the
//    keeper — `passFollow` still runs, which is the point. THIS IS NOT `autopilot stop`:
//    stopping disarms the survival ladder, and a fleet standing in a town with no ladder is
//    fine right up until it is not. Identity, mortality, survival and recovery stay with the
//    keeper throughout, exactly as they do during any errand here.
//
// AND THE LEASES COME BACK AT THE END. `fleetScript` releases every hold it took when it
// finishes — that is not new, but it is load-bearing here, because a character still held by
// a runner is a character whose `movement` faculty is spoken for, and following is movement.
// An operator who then says "follow me" would watch nothing happen.
//
// ---------------------------------------------------------------- who may command the line
//
// The leader must be ON THE ROSTER. `heardOrder` checks the speaker with `party.isFleetmate`,
// against the roster rather than against the text, because `prod` is a shared server and this
// is a command that moves twenty bodies — a stranger who worked out the phrase could walk the
// fleet into open ground. Anyone else saying it is heard and ignored.
//
// That check was DEAD inside keeper processes until 2026-08-27: the roster fallback was
// installed only by the broker, so every keeper called the whole fleet strangers, and four of
// them killed a fleetmate over it. It is installed in the keeper now (m59-keeper-process.mjs
// seeds it from the roster it just parsed and re-reads on mtime), which is why "follow me"
// works at all from inside a keeper — worth knowing, because if it ever regresses the symptom
// is silence rather than an error.
//
// ONE PRACTICAL NOTE ABOUT BEING THE LEADER. Logging a client in as one of these characters
// BUMPS THE BROKER OFF IT — one connection per character — so the character you pilot leaves
// the fleet's control and the rest follow it. That is the intended shape here and not a fault.
import { walk, act } from '../m59-fleetscript.mjs';

export const script = {
  name: 'conga',
  describe: 'Gather the fleet into one room, stop its work, and leave it listening for "follow me".',
  recipe: {
    effect: 'Walks every named character to one room, re-points its station there so a keeper ' +
            'does not walk it home again, and sets it idle with the survival ladder still ' +
            'armed. Leaves the bodies free — no lease held — so the follow order can move them.',
    run: 'conga agents=* room=52',
    needs: ['somewhere safe to stand — this parks the fleet, it does not defend it',
            'the leader to be a character on this roster, or the order is ignored',
            'nothing else steering: stop DUM first, or it re-stations them within the minute'],
    cost: { money: 'none', time: 'the longest single journey, run in parallel',
            risk: 'ordinary road risk on the way in; none once they are standing in a town' },
    scales: 'Every character walks its own route in parallel, so the wall-clock cost is the ' +
            'furthest one rather than the sum.',
    notes: ['Say "follow me", "on me" or "with me" to start the line; "stop", "hold here" or ' +
            '"stay put" to end it.',
            'The trail is consumed oldest-first, so followers walk where you WENT rather than ' +
            'at where you ARE — that is what makes it a line instead of a huddle.'],
  },

  provenance: {
    pinned: '098b96e',
    verified: '2026-09-12',
    touches: [
      'tools/m59-fleetscript.mjs',    // walk + act, and the lease that is released at the end
      'tools/m59-follow.mjs',         // the phrases and the trail — what actually does the line
      'tools/m59-autopilot.mjs',      // passFollow, and the policy this sets
      'tools/m59-keeper-process.mjs', // where passFollow runs and the roster source is installed
    ],
    refuseOnDrift: false,
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who to gather — `*` for the whole fleet' },
    // Familiars. A town inn: nothing spawns in it, it is where Paddock sells orc teeth, and it
    // is two hops from the Tos bank — so a fleet parked here is parked somewhere useful.
    room: { type: 'number', default: 52, describe: 'the room to gather in (52 = Familiars, Tos)' },
    // A GATHER IS NOT AN ESCORT. The health floor still applies to every journey; lower it only
    // if you would rather have a hurt character present than resting.
    minHealth: { type: 'number', default: 0.9, describe: 'health floor under each journey' },
    // A 20-max-health body crossing open country is what `fragileBody` exists to refuse, and a
    // gather is exactly the kind of order that would sweep one up without anybody deciding to.
    // Lower it deliberately if the host characters are wanted in the line.
    fragileBelow: { type: 'number', default: 25, describe: 'refuse to walk bodies smaller than this' },
    park: { type: 'boolean', default: true, describe: 'also re-point the station so they stay' },
  },

  async steps({ room, park }) {
    // A boolean parameter arrives from the REPL as a STRING, and "false" is truthy. Coerced at
    // the point of use rather than trusted — see the same note in fund-loial.
    const on = v => !(v === false || v === 'false' || v === '0' || v === 'no' || v === 0);

    return [
      walk(room),

      // THE STEP THAT MAKES THE GATHER STICK. Without it the keeper walks the character back
      // to wherever it was stationed as soon as the lease lapses, and the fleet dissolves in
      // about a minute.
      //
      // `mode: 'idle'` rather than `stop`: idle stops the HUNTING and leaves the keeper
      // running, which is what keeps `passFollow` alive to hear the order — and keeps the
      // survival ladder armed, which is not optional on a shared server.
      ...(on(park) ? [act('autopilot', {
        action: 'start', mode: 'idle', assigned_room: room, roam: false,
      })] : []),
    ];
  },
};
