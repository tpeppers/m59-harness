// ASK FRULAR WHAT THE GUILD OWES, AND WRITE THE ANSWER DOWN.
//
// PUBLIC. The bootstrap the guild stockpile cannot do for itself: `guildStoreAvailable`
// refuses to let the fleet stock or draw from the guild chests until a rent reading is
// cached, and until this script existed nothing on any production path ever produced one.
//
// WHY THIS IS A SCRIPT AND NOT A BARE `tithe action=status` CALL.
//
// The tool works. It is the LEASE that is missing, and without it the errand is a coin flip.
// Asking Frular is not one action, it is three — walk into earshot, say "rent", read his
// reply — and the keeper owns movement the whole time. So the keeper walks the body back off
// its approach square between the walk and the say, or between the say and the reply, and
// the tool reports `out_of_earshot` about a character that WAS in earshot a second earlier.
//
// Measured on prod 2026-09-12, same character, same room, four attempts in ten minutes: once
// Frular answered in full ("The The Second Swines owes 6547 coins in rent at this time."),
// twice the say was echoed with no reply, once nothing at all. Nothing about the code changed
// between them. That is the signature of contending with the keeper for the body, and it is
// exactly what `commander_claim` exists to stop — FleetScript takes work, movement and
// economy for the whole run and leaves survival with the keeper.
//
// THE WALK IS THE EXPENSIVE PART AND IT IS ALSO THE DANGEROUS PART. `walk` refuses to set out
// on a body whose health cannot be read, which on this fleet is the normal state for the
// first minute after a broker restart — that refusal is the script working, not failing.
import { walk, act } from '../m59-fleetscript.mjs';

export const FRULAR_ROOM = 700;

export const script = {
  name: 'ask-the-rent',
  provenance: {
    pinned: 'c8caa77', verified: '2026-09-12',
    touches: ['tools/m59-tithe.mjs', 'tools/m59-storage.mjs', 'tools/m59-fleetscript.mjs'],
  },
  describe: "Ask Frular what the guild owes, under a lease, and cache the answer.",
  recipe: {
    effect: 'Walks one character to The Guildmaster\'s Hall and asks for the rent. The point ' +
            'is the CACHE: substrate/storage/rent.json is what `guildStoreAvailable` reads to ' +
            'decide whether the fleet has a hall at all, and nothing else writes it.',
    run: 'ask-the-rent agents=<a>',
    needs: ['a character in the guild — Frular answers a non-member with "thou belongest to ' +
            'no guild", which is a real answer and is cached as in_guild:false',
            'health readable enough to set out; a keeper that is not answering refuses the walk'],
    cost: { time: '1-6 minutes, almost all of it the road to Barloque',
            risk: 'the road. Barloque is a town and the hall is inside it, so a character ' +
                  'already in Barloque is nearly free; one at Castle Victoria is a long trip',
            measured: '2026-09-12 — 101->700 in 39s and 584->700 in 33s, both at full health' },
    scales: 'One character is enough for the whole fleet. The rent is a fact about the GUILD, ' +
            'not about the asker, and the cache is fleet-wide.',
    notes: ['Frular cannot hear you from across the room. SayRangeCheck (holder.kod:604) ' +
            'drops a user\'s speech to a non-MOB_FULL_TALK monster past SAY_RADIUS 50 ' +
            '(squared, ~7 squares) and says nothing about it, so `askRent` walks into ' +
            'earshot first — which only holds if nothing else is moving the body.',
            'A reply that parses is cached even if the body has drifted out of range by the ' +
            'time the position is sampled again: his answer is the evidence, not our square.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who asks — one is enough' },
    minHealth: { type: 'number', default: 1, describe: 'fraction of health required to set out' },
  },
  async steps() {
    return [
      walk(FRULAR_ROOM),
      // Inside the lease, so the approach walk it does internally is not undone by the keeper.
      act('tithe', { action: 'status' }, { timeoutMs: 120_000 }),
      // NO `verify` STEP HERE, DELIBERATELY. The thing worth checking is that
      // substrate/storage/rent.json now exists and carries a due — a fact about a FILE on the
      // machine that ran this, which a step running against the broker cannot see. A verify
      // that returns true unconditionally is worse than none: it reads as a check and is a
      // decoration. The tool's own `recorded` field says whether it wrote, and the operator
      // reads the file.
    ];
  },
};
