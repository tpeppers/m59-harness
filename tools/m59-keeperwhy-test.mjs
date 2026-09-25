#!/usr/bin/env node
// THE GUARD FOR m59-keeperwhy.mjs — offline, no socket, no keeper, no roster.
//
// Each case is a keeper /state shaped like the one that was actually read on prod 2026-09-25,
// trimmed to the fields the classifier reads. If a signature stops firing on its own fixture, the
// tool has gone quiet on exactly the loop it was written to name.
import { classify, digest, SIGNATURES, bandFor } from './m59-keeperwhy.mjs';
import { ENTRIES } from './m59-stuck.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  — ' + extra : '')); }
};
const ids = (state) => classify(state).findings.map(f => f.id);
const state = ({ room = 27, activity = 'holding a proven safe spot', assignedRoom = 27, recent = [],
                 stuck = null, in_game = true } = {}) => ({
  agent: 't1', character: 'Kermit', in_game, room: { num: room, name: 'x' },
  you: { row: 27, col: 41 }, hp: { value: 75, max: 75 },
  autopilot_status: { activity, policy: { assignedRoom, hunt: ['orc', 'spider'] },
                      did: { kills: 0 }, stuck, recent },
});
const brokeOff = { what: 'broke off', why: 'try one of the names above', landed_hits: 0 };

console.log('\nthe Icky Cave loop, as it was read');
{
  const s = state({ recent: Array(12).fill(brokeOff) });
  ok('twelve "try one of the names above" is fight-pinned-to-nothing', ids(s).includes('fight-pinned-to-nothing'));
  ok('...and the tally counts them', classify(s).tally['broke off'] === 12);
  ok('two is not a loop', !ids(state({ recent: [brokeOff, brokeOff] })).includes('fight-pinned-to-nothing'));
  // A real fight that ended without a kill is not this signature, however many there are.
  const honest = { what: 'broke off', why: 'still alive after 3 rounds', landed_hits: 2 };
  ok('an honest broke-off is not the loop', !ids(state({ recent: Array(12).fill(honest) })).includes('fight-pinned-to-nothing'));
}

console.log('\nthe re-tasked wall-holder');
{
  ok('holding a wall in 38 while stationed in 27',
     ids(state({ room: 38, assignedRoom: 27 })).includes('wall-vigil-off-station'));
  ok('holding a wall at the station is not flagged',
     !ids(state({ room: 27, assignedRoom: 27 })).includes('wall-vigil-off-station'));
  ok('no station at all is not flagged',
     !ids(state({ room: 38, assignedRoom: null })).includes('wall-vigil-off-station'));
  ok('travelling away from the station is not a vigil',
     !ids(state({ room: 38, assignedRoom: 27, activity: 'travelling' })).includes('wall-vigil-off-station'));
}

console.log('\nstranded while a bot holds movement');
{
  // Barloque, 2026-09-25: Pepe and Bunsen in 114, Scooter in 101, all stationed in 27, every
  // keeper quiet because DUM held movement and its recall did not list 27.
  const leased = (s) => { s.autopilot_status.faculties = { movement: { owner: 'dum/prod bands@pid-1' } }; return s; };
  const pepe = leased(state({ room: 114, assignedRoom: 27, activity: 'stranded in 114: no orc or spider here' }));
  ok('stranded off-station under a DUM lease is the leased signature', ids(pepe).includes('stranded-movement-leased'));
  ok('...and not the generic dry room, whose lever is wrong for it', !ids(pepe).includes('stranded-dry-room'));
  ok('...and it names the holder', classify(pepe).findings[0]?.held_by === 'dum/prod bands@pid-1');
  const own = state({ room: 114, assignedRoom: 27, activity: 'stranded in 114: no orc or spider here' });
  own.autopilot_status.faculties = { movement: 'keeper' };
  ok('with the keeper holding its own legs it is a plain dry room',
     ids(own).includes('stranded-dry-room') && !ids(own).includes('stranded-movement-leased'));
}

console.log('\nthe rest');
{
  ok('the new all-unreachable note is recognised',
     ids(state({ recent: [{ what: 'every visible quarry is somewhere we proved we cannot walk to' }] }))
       .includes('all-prey-unreachable'));
  ok('a dry room', ids(state({ activity: 'stranded in 101: no orc or spider here' })).includes('stranded-dry-room'));
  ok('a long stall carries its reason and lever',
     classify(state({ stuck: { why: 'broke off without a landed hit or a kill', repeats: 367, lever: null } }))
       .findings.find(f => f.id === 'stall-no-lever')?.repeats === 367);
  ok('not in game', ids(state({ in_game: false })).includes('not-in-game'));
  ok('a healthy hunter is not flagged at all',
     ids(state({ activity: 'hunting: orc or spider', recent: [{ what: 'killed' }] })).length === 0);
}

console.log('\nthe shape the tool depends on');
{
  // The journal lives on the KEEPER's /state as autopilot_status.recent. If that moves, every
  // signature above goes silent together — which reads exactly like a healthy fleet.
  ok('digest reads the journal from autopilot_status.recent',
     digest(state({ recent: [brokeOff] })).recent.length === 1);
  ok('a bare-number room is accepted too', digest({ room: 27, autopilot_status: {} }).room === 27);
  ok('an empty state does not throw', Array.isArray(classify({}).findings));
  // Every signature that names a stuck entry must name one that exists, or the pointer is dead.
  const known = new Set(ENTRIES.map(e => e.id));
  for (const sig of SIGNATURES.filter(s => s.stuck))
    ok(`signature ${sig.id} points at a real m59-stuck entry (${sig.stuck})`, known.has(sig.stuck));
  ok('an unknown fleet has no band rather than a guessed one', bandFor('no-such-fleet') === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
