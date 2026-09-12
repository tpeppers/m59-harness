// LOOK INSIDE THE GUILD CHESTS, SO THE FLEET KNOWS IT HAS A HALL.
//
// PUBLIC. The other half of the guild stockpile's bootstrap, and the half nothing can do for
// itself. `guildStoreAvailable` refuses to let the fleet stock or draw from the chests until
// two things are cached: a rent reading (see `ask-the-rent`, or `pay-guild-rent`) and evidence
// that somebody has opened a chest. And the only things that open chests are the deposit and
// withdraw legs — which run only after that gate says yes.
//
//     guildStoreAvailable   refuses unless some chest has been opened
//     the deposit leg       opens chests — but runs only after the gate says yes
//     the withdraw leg      the same
//
// So the first chest can only be opened on purpose. This is that errand.
//
// NO PASSWORD IS NEEDED TO LOOK. The hall hides its chests behind a secret door that opens
// only for a spoken word, and that matters for REACHING them — but not for reading them.
// `UserObjectContents` (user.kod:3977-3996) checks `IsClass(what,&Holder)` and
// `IsInSameRoom`, and nothing else: no distance, no walls, no line of sight. So a character
// anywhere in room 714 can read all three, and the password is only required later, when
// something wants to put items in or take them out.
//
// THE DOOR IS STILL RANK. `CanEnter` (ghall.kod:1039) admits members and allies at rank >=
// SIR and refuses apprentices by name, with no message — so a freshly inducted character
// walks to Barloque and is turned away in silence. Every member of this guild is lord or
// above, which is why this is not a parameter.
import { walk, verify } from '../m59-fleetscript.mjs';

const BOOKMAKERS_HALL = 714;

export const script = {
  name: 'open-the-chests',
  provenance: {
    pinned: '5f16c64', verified: '2026-09-12',
    touches: ['tools/m59-storage.mjs', 'tools/m59-broker.mjs', 'tools/m59-fleetscript.mjs'],
  },
  describe: 'Look inside every guild chest and cache what is in them, keyed by square.',
  recipe: {
    effect: 'Writes substrate/storage/chests/r<row>c<col>.json for each chest in the hall. ' +
            'That is what the economy board renders and what the stockpile reads before ' +
            'walking anyone to a merchant.',
    run: 'open-the-chests agents=<a>',
    needs: ['guild membership at rank SIR or better — the hall door refuses in silence',
            'nothing else: reading a container needs only to be in the same room'],
    cost: { time: '1-6 minutes, almost all of it the road to Barloque',
            risk: 'the road. Inside the hall this is three read packets',
            measured: '2026-09-12 — first run of this errand' },
    scales: 'One character, once. The cache is fleet-wide, and it goes stale the moment ' +
            'anybody deposits — which is why the deposit and withdraw legs refresh it ' +
            'themselves once this has run at all.',
    notes: ['Chest contents are NEVER pushed by the server. The only record is the last look, ' +
            'so a reading is a fact about a moment, not a standing truth.',
            'A chest is named by the SQUARE it stands on, never by an object id — ids recycle ' +
            'and a chest is GETTABLE_NO, so the square is the durable name.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who goes and looks' },
    minHealth: { type: 'number', default: 0.85 },
  },

  async steps({ agent }) {
    const seen = [];

    return [
      walk(BOOKMAKERS_HALL, { why: 'the chests are only readable from inside the hall' }),

      verify(async ({ call }) => {
        // READ THE ROOM FIRST. The chest ids are whatever the server minted this boot, so they
        // are discovered here and used immediately — never stored, never carried between runs.
        // `look`, NOT `status`. Both report a room; only `look` carries its CONTENTS. A
        // status snapshot in the guild hall answered `objects: 0` while `look` in the same
        // room a moment later listed thirty-four, three of them the chests — so a script that
        // asks `status` concludes the hall is empty and says so with confidence. Measured
        // 2026-09-12, first run of this errand.
        const st = await call('look', { agent }, 60_000).catch(() => null);
        const here = st?.room?.num ?? st?.where?.num ?? null;
        if (here !== BOOKMAKERS_HALL) throw new Error(
          `standing in room ${here}, not ${BOOKMAKERS_HALL} — the walk reported success but ` +
          'the world says otherwise, and reading a container needs the same room');

        const chests = (st?.objects ?? []).filter(o => /chest/i.test(o.name || ''));
        if (!chests.length) throw new Error(
          'no chest in this room. Either the hall is not ours, or the room snapshot arrived ' +
          'without its objects — which is not the same thing and must not be recorded as an ' +
          'empty hall');

        for (const ch of chests) {
          // `record: true` files it under the square read off the object we just looked
          // inside. A chest with no position is refused rather than named by a guess.
          const r = await call('container', { agent, target: ch.id, record: true }, 90_000)
            .catch(e => ({ error: e.message }));
          seen.push({ at: `r${ch.row}c${ch.col}`, id: ch.id,
                      stacks: r?.count ?? null, recorded: r?.recorded_as_chest ?? null,
                      why: r?.why ?? r?.error ?? undefined });
        }
        console.log('CHESTS', agent, JSON.stringify(seen, null, 1));

        const recorded = seen.filter(s => s.recorded).length;
        if (!recorded) throw new Error(
          `looked in ${seen.length} chest(s) and recorded none: ${JSON.stringify(seen)}`);
        return true;
      }, 'reading every chest in the hall and caching each under the square it stands on'),
    ];
  },
};
