// BRING ONE CHARACTER TO A GUILD MEMBER AND INDUCT IT, WITHOUT EVER LETTING GO OF EITHER.
//
//   join-guild joiner=t3 inviter=t12 room=39
//
// PUBLIC. The errand `spread-guild` cannot do for a character nobody ever stands next to,
// and the one `come-home` plus an invitation cannot do either — for a reason that is worth
// writing down, because it wasted two attempts on 2026-09-10.
//
// THE LEASE IS THE ERRAND. A walk and an invitation look like two steps and are one.
//
// `come-home agents=t3 home=38` worked perfectly: Statler crossed eight hops from the
// Graveyard of Tos in 3m36s against a 482s budget. Then the script ended, the lease went
// back to the keeper, and the keeper read the policy it has always had — `assigned_room: 70`,
// `roam: false` — and started walking him home. Ninety seconds after arriving he was in room
// 589 and still moving; the invitation issued there died on the spot, because it dies if
// EITHER party leaves the room (invitat.kod:145). Four further rounds found him nowhere near
// a member. The walk was never the hard part. **Arriving is not staying**, and a character
// whose assigned room is somewhere else starts leaving the instant it is released.
//
// So the invite happens INSIDE the held window, with the inviter held too, and both bodies
// are only handed back once the roster has confirmed the join.
//
// WHY THE INVITER IS HELD AS WELL. It is not a courtesy. The inviter's own bot re-decides it
// about every thirty seconds, and an inviter that wanders costs the invitation exactly as
// surely as a joiner that does — plus the inviter's ONE outstanding-invitation slot, which
// `CheckInvitationList` then refuses to reissue for two minutes with no message at all
// (gcinvite.kod:81).
//
// PICK AN INVITER THAT CAN ALSO PROMOTE, i.e. rank >= LIEUTENANT (4). Invite needs only LORD
// (3), but `set_rank` needs 4 — so a lord inviter recruits a member it cannot then promote,
// and an apprentice can never recruit in turn. `promoteWith` exists for when the nearest
// member is only a lord: set_rank needs neither the same room nor the same moment, so the
// promotion can be issued by a lieutenant standing anywhere in the world.
//
// AND THE JOIN IS READ OFF THE INVITER'S ROSTER, NEVER OFF THE REPLY. `guild action=accept`
// returns its flag from a roster re-read on the INVITEE, which is a round trip through the
// keeper; a slow one leaves it false while the same reply carries "Please welcome the newest
// member…". Measured 2026-09-10 on Waldorf. The inviter is a different session and is the
// witness.
import { walk, verify } from '../m59-fleetscript.mjs';

// The rank that can invite AND promote. Named because 3 looks close enough and is not.
export const LIEUTENANT = 4;
// The rank each new member is promoted to: uncapped, and all that inviting needs.
export const LORD = 3;
// Below this the server refuses the invitation outright (PFLAG_PKILL_ENABLE, invitat.kod:174).
export const PKILL_MIN_MAX_HEALTH = 30;

const standStill = (ms, why) => ({ ...verify(async () => {
  await new Promise(r => setTimeout(r, ms)); return true;
}, why), why, optional: true });

export const script = {
  name: 'join-guild',
  provenance: {
    pinned: '97412fa', verified: '2026-09-11',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs', 'tools/m59-guild.mjs'],
  },
  describe: 'Walk one character to a guild member and induct it without releasing either body.',
  recipe: {
    effect: 'The joiner ends up in the guild at lord, standing next to the inviter. The point ' +
            'is that the walk and the invitation happen under ONE lease: a character whose ' +
            'assigned room is elsewhere starts walking back the moment it is released, and ' +
            'the invitation dies the instant either party moves.',
    run: 'join-guild joiner=<agent> inviter=<agent> room=<room> [promoteWith=<agent>]',
    needs: ['an inviter already in the room, at rank LORD or above',
            'a promoter at LIEUTENANT or above — the inviter itself, or promoteWith',
            '30 max health on the joiner, or the server refuses the invitation',
            'a route the bake knows; the joiner sets out only above minHealth'],
    cost: { time: 'the walk, plus about a minute for the handshake',
            money: 'nothing',
            risk: 'the road. Holding the inviter still also takes it off hunting for that long',
            measured: '2026-09-11 — 70->38 was 8 hops and 3m36s against a 482s budget, ' +
                      'crossing 599. The failure this exists for is measured too: released ' +
                      'at 38, the same character was in 589 and moving 90 seconds later' },
    scales: 'One joiner at a time, by necessity — the inviter holds ONE invitation slot.',
    notes: ['Statler is the worked example: assigned_room 70, roam false, so every release ' +
            'sends him back to the Graveyard of Tos.',
            'This does NOT change the joiner\'s policy. It puts it in the guild and hands it ' +
            'back; the keeper then walks it home, which is correct and is not a failure.'],
  },
  params: {
    // THE CONTROLLED SET, AND IT MUST CONTAIN BOTH. fleetScript claims a lease for each agent
    // in `agents` and `steps()` is called once per agent — so an `agents` that names only the
    // joiner leaves the INVITER on its keeper, free to walk off mid-handshake and take the
    // invitation with it. Both bodies held, or the errand is the one that already failed.
    agents:  { type: 'agents', required: true,
               describe: 'exactly the joiner and the inviter, e.g. t3,t12' },
    joiner:  { type: 'string', required: true, describe: 'the character to induct' },
    inviter: { type: 'string', required: true, describe: 'a member already standing in `room`' },
    room:    { type: 'number', required: true, describe: 'where the inviter is standing' },
    promoteWith: { type: 'string', required: false,
                   describe: 'who issues set_rank, if the inviter is only a lord. Needs rank 4+ ' +
                             'and needs to be nowhere in particular' },
    promoteTo: { type: 'number', default: LORD,
                 describe: 'rank for the new member. 3 (lord) is uncapped and can invite; 4 is ' +
                           'capped at two guild-wide and the third is refused in silence' },
    minHealth: { type: 'number', default: 0.85,
                 describe: 'fraction of health the joiner needs to set out. Lower than ' +
                           'come-home\'s full-health default on purpose: a character that is ' +
                           'fighting where it stands never settles at 100% and the errand ' +
                           'never starts' },
    holdMs:  { type: 'number', default: 240000,
               describe: 'how long the inviter stands still. Must cover the joiner\'s whole walk' },
  },
  async steps({ agent, joiner, inviter, room, promoteWith, promoteTo = LORD, holdMs = 240_000 }) {
    if (promoteTo === LIEUTENANT)
      return [verify(() => false,
        'promoteTo 4 is lieutenant, capped at TWO guild-wide (MAX_LIEUTENANT, guild.kod:49). ' +
        'The third promotion and every one after is refused with no message, and the refusal ' +
        'goes to the promoter — so it appears to work. Use 3 (lord).')];

    // THE INVITER'S JOB IS TO NOT MOVE. Its bot re-decides it about every thirty seconds, and
    // an inviter that wanders costs the invitation and burns its one slot for two minutes.
    if (agent === inviter)
      return [standStill(holdMs,
        'holding the room under lease so the invitation survives — it dies if EITHER party ' +
        'leaves (invitat.kod:145), and this character\'s bot would move it in ~30s')];

    if (agent !== joiner) return [];

    return [
      walk(room),
      verify(async ({ call }) => {
        // WHO THIS CHARACTER IS, ASKED OF THE SERVER. The invite is addressed by OBJECT ID,
        // never by name: this is a shared server and an invitation is an outward-facing act.
        // THE PRECONDITION IS THE SAME ROOM AS THE INVITER — not a room NUMBER, and getting
        // that wrong cost a whole run. `walk(39)` reported ok and a `look` one second later
        // put the body in 38; room 39 is reached THROUGH 38, so an exact-number check called
        // a correct arrival "already walking home" and refused. Ask the question that the
        // invitation actually asks: are these two standing in the same room?
        //
        // And give arrival a moment. `walk` returning ok and the body being settled are not
        // the same instant, so this settles rather than judging the first reading.
        let me = null, mine = null, theirs = null, id = null;
        for (let i = 0; i < 10; i++) {
          me = await call('look', { agent: joiner }, 30_000);
          const them = await call('look', { agent: inviter }, 30_000);
          id = me?.you?.object_id ?? me?.intent_observation?.player_id ?? null;
          mine = me?.room?.num ?? null;
          theirs = them?.room?.num ?? null;
          if (mine !== null && mine === theirs) break;
          await new Promise(r => setTimeout(r, 3000));
        }
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Error(`cannot read ${joiner}'s object id — refusing to invite by name`);
        if (mine === null || mine !== theirs)
          throw new Error(`${joiner} is in room ${mine} and ${inviter} is in room ${theirs} — an ` +
                          `invitation only exists while both stand in ONE room (invitat.kod:145). ` +
                          `Point the room parameter at where the inviter actually is.`);
        const maxHp = me?.hp?.max ?? 0;
        if (maxHp < PKILL_MIN_MAX_HEALTH)
          throw new Error(`max health ${maxHp} is under ${PKILL_MIN_MAX_HEALTH}: the server ` +
                          `refuses the invitation when it is USED (invitat.kod:174) and no ` +
                          `retry helps — the inviter's slot would be burnt for nothing`);

        await call('guild', { agent: inviter, action: 'invite', target: id }, 60_000);
        // The scroll is an object in the pack, and the pack has to be re-read to see it.
        await call('inventory', { agent: joiner }, 30_000);
        await call('guild', { agent: joiner, action: 'accept' }, 60_000);

        // THE INVITER'S ROSTER IS THE WITNESS, not `accept`'s own flag, which comes from a
        // re-read on the invitee and reads false on a slow keeper for a join that landed.
        const seen = await call('guild', { agent: inviter, action: 'status' }, 60_000);
        const joined = (seen?.guild?.roster ?? []).some(m => m.id === id);
        if (!joined) return false;

        // Promote, so this member can recruit in turn. set_rank needs LIEUTENANT, which the
        // inviter may not have — hence promoteWith, which needs no room and no moment.
        const promoter = promoteWith || inviter;
        if (promoteTo > 1)
          await call('guild', { agent: promoter, action: 'set_rank', target: id, rank: promoteTo },
                     60_000).catch(() => null);
        return true;
      }, `inviting ${joiner} into the guild and promoting it, both bodies still held`),
    ];
  },
};
