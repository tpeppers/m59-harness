// THE SHAPE OF A PAD. Copy this into substrate/fleetscratch/ and start cutting.
//
// BESIDE the directory, never inside it — `loadPads` enumerates every .mjs in
// substrate/fleetscratch/, so an example in there is an extra pad on the list. Same rule as
// substrate/loadouts.example.json, and for the same reason.
//
// A PAD IS A FLEETSCRIPT THAT HAS NOT EARNED ITS STATUS YET. Identical shape on purpose, so
// promoting one is a MOVE and not a rewrite: `name`, `describe`, `params`, `steps(params)`.
// What a pad adds is the declaration of what it needs, and what it is allowed to leave out is
// everything a finished errand must have — a `provenance` pin, a `recipe`, a test.
//
// WHAT THAT MEANS FOR THE CLAIMS IN IT. Everything below about the game is WIP: it is what the
// operator said, or what one afternoon appeared to show, and none of it has been read out of
// kod. That is allowed in a pad and is the whole reason pads exist. It is NOT allowed in a
// promoted fleetscript, where every number is cited `kod/path/file.kod:line` — so the figures
// here are marked, and promoting this file means going and getting the citations.
import { walk, verify } from '../tools/m59-fleetscript.mjs';
// FROM m59-padcheck.mjs, NEVER FROM m59-fleetscratch.mjs. Importing the helpers from the
// session module closes a cycle through its pad loader, and Node does not call that an error --
// it prints an unsettled-top-level-await warning and exits 0 with no pads and no prompt. This
// example told every pad to do exactly that until 2026-09-11.
import { knows, knowsAny } from '../tools/m59-padcheck.mjs';

export const script = {
  name: 'example-pad',
  describe: 'The three tiers of declaration, against an errand that does nothing.',

  // WHAT THIS PAD IS ABOUT, so `check` can ask whether somebody already wrote it down. The corpus
  // had the Ghost of Far'Nohl's resistance table for a week before a session spent a night deriving
  // it from kod, because they did not know to look. Declaring this costs nothing and is the one
  // feature in the tool with a measured value: one night.
  consults: ["ghost of far'nohl resistances", 'enchant weapon'],

  // ---------------------------------------------------------------- what this needs, and how
  //
  // REQUIRED — unmet refuses before anything walks.
  //
  // The test for this tier is not "how important is it". It is: WITHOUT THIS, DOES THE ERRAND
  // FAIL, OR DOES IT SPIN? A drill that can neither cast the spell nor buy it will try to buy,
  // fail, and try again for as long as you leave it — burning a held character and reporting
  // success at every level. Those are the ones that belong here, because a refusal up front is
  // the only thing that turns an infinite loop into a sentence.
  requires: [{
    what: 'knows at least one Shal\'ille spell',
    why: 'UNVERIFIED (operator, 2026-09-11): with no spell to drill and no intellect left to ' +
         'learn one, the drill loops for ever buying nothing. Cite the intellect cap from kod ' +
         'before promoting this.',
    // `abilities` is checked against the game's own skill and spell tree AT LOAD, because a
    // misspelled name does not fail — it evaluates false for every character and reports the
    // whole fleet ineligible, which reads as a finding. Note that "shal'ille" is NOT an ability
    // name; it is a school, and its spells have their own names. Declaring the school would be
    // refused, which is the check doing its job.
    abilities: ['minor heal', 'bless'],
    check: knowsAny(['minor heal', 'bless']),
  }],

  // A capability — the pad routes around its absence, so this is reported and never refuses.
  capabilities: [{
    what: 'can enchant a weapon',
    why: 'UNVERIFIED (operator, 2026-09-11): the Ghost of Far\'nohl resists non-magical ' +
         'weapons at about 90%. Either already carrying enchanted weapons or having somebody ' +
         'who can cast it will do, which is exactly why this is a branch and not a gate.',
    abilities: ['enchant weapon'],
    check: knows('enchant weapon'),
  }],

  // A suggestion — advice with the mechanism named. Never blocks anything.
  suggests: [{
    what: 'bring somebody tougher than the caster',
    why: 'The roads are what kills this fleet, and a 20-health caster travelling alone is a ' +
         'different bet from one with an escort. Measured for come-home, not for this.',
    check: () => null,                 // nothing on disk can answer this one; honest as unknown
  }],

  notes: [
    'Pads carry their working notes here. This is the half that would otherwise end up in the',
    'header of whatever file was open — which is how 77 lines of mana-node reachability ended',
    'up inside a compiler.',
  ],

  params: {
    agents: { type: 'agents', required: true, describe: 'who to drive' },
    home: { type: 'number', default: 39, describe: 'where they end up' },
  },

  // STEPS IS A FUNCTION OF ITS PARAMETERS AND NOTHING ELSE, and it does no work when the module
  // is loaded — loading a pad imports it, so a pad that drove the fleet at import time would do
  // so merely by being listed.
  //
  // A pad may define composite helpers freely: a function returning an array of existing steps
  // is just factoring, and it is what promotion harvests into a library. What it may not define
  // is a new step KIND — a new `do:` needs an executor inside the compiler, and a pad must never
  // hold one, because an executor needs the socket.
  async steps({ home }) {
    return [...goHome(home)];
  },
};

// A composite: the thing ScratchToScript lifts out.
// `verify` is handed { agent, observe, call, state } — observe is the FUNCTION, not a reading,
// so the read happens when the step runs rather than when the plan was built. That is the whole
// point of guarantee 6: the outcome is what the world says afterwards.
const goHome = (home) => [
  walk(home),
  verify(async ({ agent, observe }) => (await observe(agent)).room === home,
         `ends in room ${home}`),
];
