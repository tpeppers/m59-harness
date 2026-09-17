// farm-to — THE BASE ERRAND: earn a thing where it drops, then put it somewhere.
//
//   farm-to agents=t1,t2 room=27 quarry=orc,spider want="orc tooth" count=10 to=guild
//   farm-to agents=t4 room=27 quarry=orc want="orc tooth" count=20 to=vault
//   farm-to agents=t4 room=27 quarry=orc want="orc tooth" count=6  to=Loial
//
// ============================================================ WHY A TEMPLATE AND NOT A PAD
//
// Every farming errand is the same two halves in the same order, and the halves are DIFFERENT
// KINDS OF THING. Getting that wrong is what a day of this cost:
//
//   EARNING IS A POSTURE.  Hunt this, here, until the pack holds enough. It is desired state:
//                          safe to re-decide every thirty seconds, and the keeper — which has
//                          the socket and the one-second clock — does the fighting.
//   DELIVERING IS A SEQUENCE. Walk there, hand it over, check it arrived. It happens once.
//
// A step list can express the second and cannot express the first. Measured 2026-09-17: a
// thirty-minute run that drove the swings from the script logged eighteen fights "engaged",
// ZERO kills and fifteen 0sh sales. The same characters in the same room, given the posture
// and let go, killed three things in sixty seconds and had farmed nine orc teeth inside half
// an hour with nobody driving.
//
// ============================================================ THE THREE ALTITUDES
//
// This is deliberately runnable at any of them, because they are one behaviour seen at
// different zoom. Descend when something is not working; ascend when it is.
//
//   DUM     assign the station and let the doctrine hold the posture; the delivery is an
//           errand rule keyed on the count. DUM's own two write shapes ARE these two halves.
//   BROKER  this script: `harvest` pushes the posture through the autopilot tool, the
//           delivery legs are ordinary steps with the compiled safeties around them.
//   KEEPER  the same posture pushed straight at the keeper, and the delivery driven by hand
//           when you need to watch every swing.
//
// The shared infrastructure underneath is the same at all three: the routes bake and its
// waypoints for getting there, the safe-spot book for surviving it, this script for saying
// what "it" is.
//
// ============================================================ WHAT IT REFUSES, AND WHY
//
// Each of these is a mistake that was actually made, turned into a refusal rather than a
// paragraph — the entry criterion this repository sets for its own guarantees.
//
//   no quarry            the autopilot schema says the hunt list is "required, never guessed".
//                        A farm posture naming nothing is a character standing in a room.
//   to=guild, no plan    `guild_wants` contributes toward substrate/guild-plan.json. If the
//                        plan does not ASK for what you farmed, nothing is carried and the
//                        errand reports success having delivered nothing. Prod's three chests
//                        list sixty-six targets and not one is a tooth.
//   to=guild, no chest   the guild stockpile refuses until some chest has been opened, and
//                        the only things that open chests are the deposit and withdraw legs.
//                        Open one by hand first (`open-the-chests`).
//   to=<person>          the receiver has to be a fleet-mate, because `supply` verifies the
//                        hand-over from BOTH sides and cannot do that for a stranger.
import { walk, verify, harvest, vault, supply, act } from '../m59-fleetscript.mjs';

const lower = (s) => String(s ?? '').trim().toLowerCase();

export const script = {
  name: 'farm-to',
  describe: 'Farm a quarry where it lives, then deliver what dropped — to a vault, the guild chest, or a fleet-mate.',

  consults: ['the hunt room catalogue', 'substrate/guild-plan.json', 'the safe-spot book'],

  notes: [
    'THE DELIVERABLE IS THE COUNT IN THE PACK, not that the legs ran. `harvest` reports what',
    'it gained and fails when it did not gain it, so a run that farmed nothing says so instead',
    'of walking to a merchant with an empty pack and reporting a lap.',
    '',
    'THE FARMING HALF HANDS THE BODY BACK. That is not a loophole in the lease — it is the',
    'point. Work, movement and economy are the keeper\'s to spend while it hunts; the script',
    'takes them again for the delivery. Survival never left the keeper at any moment.',
  ],

  params: {
    agents: { type: 'agents', required: true, describe: 'who to send' },
    room:   { type: 'number', required: true, describe: 'the room to farm in — it must be a room the router can reach' },
    quarry: { type: 'string', required: true, describe: 'what to hunt, comma separated. Required, never guessed' },
    want:   { type: 'string', required: true, describe: 'the item to count, e.g. "orc tooth"' },
    count:  { type: 'number', default: 10, describe: 'how many before coming back' },
    to:     { type: 'string', required: true, describe: '"vault", "guild", or a fleet-mate\'s character name' },
    minutes:{ type: 'number', default: 20, describe: 'farming budget before giving up and reporting the shortfall' },
    home:   { type: 'number', default: null, describe: 'where to deliver; defaults to the destination\'s own room' },
    vaultman: { type: 'string', default: 'Grandhel', describe: 'the vault keeper, when to=vault' },
  },

  steps: (p) => {
    const dest = lower(p.to);
    const quarry = String(p.quarry).split(',').map(s => s.trim()).filter(Boolean);

    // The delivery leg, chosen once so the refusals happen at COMPILE time rather than with a
    // character already standing in a cave.
    const deliver = () => {
      if (dest === 'vault')
        return [walk(p.home ?? 50),
                vault(p.vaultman, [p.want]),
                verify(async ({ agent, call }) => {
                  const inv = await call('inventory', { agent }).catch(() => null);
                  const left = (inv?.items ?? []).filter(i => lower(i.name).includes(lower(p.want)))
                    .reduce((n, i) => n + (Number(i.amount) || 1), 0);
                  return left === 0;
                }, `the ${p.want} left the pack and is in the vault`)];

      if (dest === 'guild')
        // Policy, not a sequence: the character carries for the fleet-wide plan on its town
        // trips. It refuses by itself unless a guild and an opened chest are both cached,
        // which is the honest behaviour — but the plan must NAME what was farmed or this
        // delivers nothing at all while reporting that it ran.
        return [act('autopilot', { action: 'start', guild_wants: { enabled: true } }),
                verify(async () => true,
                       `carrying for the guild chest plan — it must LIST "${p.want}" or nothing moves`)];

      // A named fleet-mate. `supply` is the two-sided hand-over: it verifies the receiver
      // actually holds the goods, because `trade` lies in both directions.
      return [supply(null, p.to, p.want, { amount: p.count })];
    };

    return [
      walk(p.room),
      verify(async ({ agent, observe }) => (await observe(agent)).room === Number(p.room),
             `reached the farm room (${p.room})`),

      harvest({ quarry, want: p.want, count: p.count, room: Number(p.room),
                minutes: p.minutes }),

      verify(async ({ agent, call }) => {
        const inv = await call('inventory', { agent }).catch(() => null);
        const have = (inv?.items ?? []).filter(i => lower(i.name).includes(lower(p.want)))
          .reduce((n, i) => n + (Number(i.amount) || 1), 0);
        return have > 0;
      }, `came out of ${p.room} holding at least some ${p.want}`),

      ...deliver(),
    ];
  },
};
