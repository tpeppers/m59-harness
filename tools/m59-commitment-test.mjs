#!/usr/bin/env node
// THE RULE FOR WHICH CHARACTERS THE BOARD WILL NOT LET YOU PICK. Offline, no server,
// no broker, safe any time:
//
//   node tools/m59-commitment-test.mjs
//
// This is a keyboard behaviour, which is the sort of thing that normally only gets
// tested by pressing the key — and pressing the key needs a live fleet, twenty-one
// logged-in characters and something actually in progress to skip over. So the rule
// lives in a pure module and this pins it: what counts as being spoken for, what the
// cursor does when it meets one, and the two ways the whole thing can go wrong quietly.
//
// The two:
//
//   EVERY ROW COMMITTED. The cursor cannot move and the terminal looks frozen. It must
//   stay put rather than run off the end of the list, and the caller must be able to
//   tell that is what happened.
//
//   AN OLD BROKER. `committed` is a field this repository added; a broker that has been
//   up for two days does not send it. The board still has to grey the right rows, from
//   the fields that have always been there, or the answer to "is anyone on an errand?"
//   silently becomes "no" for exactly as long as it takes somebody to restart the fleet.

import { describeCommitment, commitmentOf, stepSelection, firstSelectable, allCommitted,
         commitmentRank, isTakeable, heldBy } from './m59-commitment.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

// A row as the terminal builds it: a fleet row with the keeper's status merged in under
// `ap`. `ap.committed` present and null means "this broker answers that question, and the
// answer is no"; absent means "this broker does not answer it".
const row = (agent, ap = {}) => ({ agent, character: agent, ap: { running: true, ...ap } });
const free = (agent, extra = {}) => row(agent, { committed: null, ...extra });
const busy = (agent, what, extra = {}) => row(agent, { committed: what, ...extra });

// ------------------------------------------------------------ what counts as committed

console.log('\nwhat counts as being spoken for');
{
  ok('nothing at all is not a commitment', describeCommitment({}) === null);
  ok('and neither is an empty call', describeCommitment() === null);

  const lootrun = describeCommitment({ errand: { kind: 'lootrun', farmer_name: 'Rowlf', at: 1000 } });
  ok('a loot run is an errand', lootrun.kind === 'errand');
  ok('and it names the farmer', lootrun.label === 'loot run for Rowlf', lootrun.label);
  ok('and it carries when it started', lootrun.since === 1000);

  const prov = describeCommitment({ errand: { kind: 'provision', service: 'create food',
                                              supplicant_name: 'Zoot' } });
  ok('a provisioning cast names the spell and who for',
     prov.label === 'create food for Zoot', prov.label);

  const sig = describeCommitment({ errand: { kind: 'signet', owner: 'Yevitan', town: 'Jasper' } });
  ok('a signet errand names the owner and the town',
     sig.label === 'signet: Yevitan, Jasper', sig.label);
  ok('and explains the payout, because that is the whole reason it exists',
     /ten times/.test(sig.detail));

  // THE BOARD GIVES THE ACTIVITY COLUMN 28 CHARACTERS AND CUTS THE TAIL. What must
  // survive the cut is the OWNER, because the owner is the destination — the first
  // version of this label read "returning a signet ring to Paddock in Tos" and arrived
  // as "returning a signet ring to …", every character spent on the part that is the
  // same for every ring. Checked against the longest name the table can produce rather
  // than against a length, because it is the property that matters.
  const BOARD = 28;
  const longest = 'Parrin Aragone';
  const cut = (s) => (s.length <= BOARD ? s : s.slice(0, BOARD - 1) + '…');
  ok('the owner survives the board\'s truncation even for the longest name',
     cut(describeCommitment({ errand: { kind: 'signet', owner: longest, town: 'Cor Noth' } }).label)
       .includes(longest),
     cut(describeCommitment({ errand: { kind: 'signet', owner: longest, town: 'Cor Noth' } }).label));

  // A NEW ERRAND KIND MUST SHOW UP ON THE BOARD THE DAY IT IS ADDED. Reporting an
  // unknown kind as itself rather than dropping it is what makes that true: the failure
  // mode being guarded against is a character quietly staying selectable while walking
  // somewhere on the fleet's business.
  const odd = describeCommitment({ errand: { kind: 'archaeology' } });
  ok('an errand kind nothing knows about is still a commitment', odd.kind === 'errand');
  ok('and says what it is rather than being dropped', odd.label === 'archaeology', odd.label);

  // A FINISHED ERRAND IS NOT A COMMITMENT. The keeper leaves `errand` in place for one
  // more pass so it can journal what happened; a board that greyed the row for that pass
  // would flicker.
  ok('an errand marked done releases the character',
     describeCommitment({ errand: { kind: 'lootrun', farmer_name: 'Rowlf', done: true } }) === null);

  ok('an inert keeper is driven by something else',
     describeCommitment({ inert: { why: 'a supply trade is driving' } }).kind === 'driven');

  // A COMMITMENT WITH NO `since` CANNOT BE TOLD FROM A DEAD ONE.
  //
  // This was the one commitment on the board that could not be aged: `goInert` had recorded
  // the time all along and this builder hardcoded null. An accidental import left all 21
  // characters inert and exited; the board showed 21 rows with a null timestamp and no
  // owner, every rule in the fleet stepped over them, and the only way to learn it was
  // stale was for a second session to enumerate running processes and prove the driver did
  // not exist. Twenty minutes of a fleet not eating.
  {
    const at = 1_700_000_000_000;
    const c = describeCommitment({ inert: { why: 'all hands — mustering', at,
                                            expires_at: at + 900_000, by: 'm59-allhands' } });
    ok('it reports when it was taken', c.since === at, String(c.since));
    ok('and who took it', c.by === 'm59-allhands', String(c.by));
    ok('and says so in the detail a human reads', /taken by m59-allhands/.test(c.detail));
    // `expires_at` matters as much: an inert keeper lapses on its own after fifteen minutes,
    // and a reader that cannot see the deadline cannot tell "held" from "about to stop being
    // held" — the difference between waiting and intervening.
    ok('and when it stops being true on its own', c.expires_at === at + 900_000);
  }
  {
    // A HOLD FROM BEFORE THIS CODE SAYS SO rather than quietly reading as brand new. Null is
    // still possible and the one thing it must not do is look like a timestamp.
    const c = describeCommitment({ inert: { why: 'something older' } });
    ok('an unstamped hold still works', c.kind === 'driven');
    ok('reports no start time', c.since === null);
    ok('and admits it cannot be aged', /NO START TIME RECORDED/.test(c.detail));
  }
  ok('and reports the reason it was given',
     describeCommitment({ inert: { why: 'a supply trade is driving' } }).label === 'a supply trade is driving');
  ok('an inert keeper with no reason still greys the row',
     describeCommitment({ inert: { inert: true } })?.kind === 'driven');

  ok('parking for an update is a commitment',
     describeCommitment({ parked: { parked: true, ready: false } }).kind === 'parked');
  ok('a partner is a commitment',
     describeCommitment({ partner: 'q7' }).label === 'fighting alongside q7');
}

console.log('\nthe most specific reason wins');
{
  // An errand runs by making the keeper inert, so nearly every errand is ALSO 'driven'.
  // The board has one line; it must say the useful half.
  const both = describeCommitment({ errand: { kind: 'lootrun', farmer_name: 'Rowlf' },
                                    inert: { why: 'a loot run is driving' },
                                    partner: 'q7' });
  ok('an errand outranks the inert hold it created', both.kind === 'errand');
  ok('driven outranks parked',
     describeCommitment({ inert: { why: 'x' }, parked: { parked: true } }).kind === 'driven');
  ok('parked outranks a pairing',
     describeCommitment({ parked: { parked: true }, partner: 'q7' }).kind === 'parked');
  ok('and the ranking is ordered, hardest first',
     commitmentRank(both) < commitmentRank(describeCommitment({ partner: 'q7' })));
  ok('a free character ranks last of all',
     commitmentRank(null) > commitmentRank(describeCommitment({ partner: 'q7' })));
}

// ------------------------------------------------------------------ reading a fleet row

console.log('\nreading it off a fleet row');
{
  ok('a row with committed:null is free', commitmentOf(free('q1')) === null);
  ok('a row the broker says is busy is busy',
     commitmentOf(busy('q2', { kind: 'errand', label: 'loot run for Rowlf' }))?.kind === 'errand');
  ok('no row at all is not a crash', commitmentOf(null) === null);
  ok('a row with no keeper is free', commitmentOf({ agent: 'q9' }) === null);

  // THE OLD BROKER. No `committed` field anywhere, and the board still has to be right.
  const oldErrand = { agent: 'q3', ap: { running: true, activity: 'loot run for Rowlf' } };
  ok('an old broker\'s errand sentence still greys the row',
     commitmentOf(oldErrand)?.kind === 'errand');
  ok('and the keeper\'s own words are used as the label',
     commitmentOf(oldErrand).label === 'loot run for Rowlf');

  const oldInert = { agent: 'q4', ap: { running: true, activity: 'inert — a supply trade is driving',
                                        inert: { why: 'a supply trade is driving' } } };
  ok('an old broker\'s inert hold still greys the row', commitmentOf(oldInert)?.kind === 'driven');

  const oldPartner = { agent: 'q5', ap: { running: true, activity: 'hunting: mummy',
                                          policy: { partner: 'q6' } } };
  ok('an old broker\'s pairing still greys the row', commitmentOf(oldPartner)?.kind === 'partner');

  // AND IT MUST NOT INVENT ONE. "hunting: mummy" is the ordinary case and by far the most
  // common row on the board; a fallback that matched it would grey the whole fleet.
  const oldFarming = { agent: 'q6', ap: { running: true, activity: 'hunting: mummy' } };
  ok('an ordinary hunting row is left alone', commitmentOf(oldFarming) === null);
  ok('and so is a keeper holding a wall',
     commitmentOf({ agent: 'q7', ap: { activity: 'holding a proven safe spot' } }) === null);

  // A CURRENT BROKER'S null BEATS THE SENTENCE. If it says the character is free, it is
  // free — the fallback exists for a broker that cannot answer, not to second-guess one
  // that can.
  ok('committed:null wins over a sentence that looks like an errand',
     commitmentOf(row('q8', { committed: null, activity: 'loot run for Rowlf' })) === null);
}

// ----------------------------------------------------------------- moving the cursor

console.log('\nthe cursor steps over them');
{
  const E = { kind: 'errand', label: 'loot run for Rowlf' };
  const rows = [free('a'), busy('b', E), busy('c', E), free('d'), busy('e', E)];

  ok('down from a free row lands past two busy ones', stepSelection(rows, 0, 1) === 3);
  ok('up from there comes back over them', stepSelection(rows, 3, -1) === 0);
  ok('down from the last free row has nowhere to go and stays put',
     stepSelection(rows, 3, 1) === 3);
  ok('up from the top stays put', stepSelection(rows, 0, -1) === 0);

  ok('with the override on it moves one row at a time',
     stepSelection(rows, 0, 1, { override: true }) === 1);
  ok('and still stops at the end', stepSelection(rows, 4, 1, { override: true }) === 4);

  // The cursor may be SITTING on a committed row — it does, straight after the override
  // is used to take one — and stepping off it must work.
  ok('stepping off a committed row finds the next free one',
     stepSelection(rows, 1, 1) === 3);

  ok('the cursor opens on the first free character', firstSelectable(rows) === 0);
  ok('and on the first row of all when overriding', firstSelectable(rows, { override: true }) === 0);

  const busyFirst = [busy('a', E), busy('b', E), free('c')];
  ok('a board whose first rows are busy opens further down', firstSelectable(busyFirst) === 2);

  // THE FROZEN BOARD. Every character on fleet work is a real state — a fleet-wide loot
  // run dispatch produces it — and it must not look like a dead keyboard.
  const allBusy = [busy('a', E), busy('b', E), busy('c', E)];
  ok('every row committed is detectable', allCommitted(allBusy) === true);
  ok('and the cursor refuses to move rather than running off the list',
     stepSelection(allBusy, 1, 1) === 1 && stepSelection(allBusy, 1, -1) === 1);
  ok('and still points somewhere real', firstSelectable(allBusy) === 0);
  ok('a fleet with one free character is not all committed',
     allCommitted([busy('a', E), free('b')]) === false);
  ok('an empty fleet is not all committed', allCommitted([]) === false);
  ok('and does not move a cursor it does not have', stepSelection([], 0, 1) === 0);
}

// ---------------------------------------------------------------- an outside owner
//
// OWNING A CHARACTER AND BEING BUSY WITH IT ARE DIFFERENT FACTS, and getting them the
// same way round is the failure this whole section exists for. A directional bot claims
// `work` and `movement` on every character it manages, for its whole run. If that alone
// counted as a commitment then the bot's own "leave committed characters alone" rule
// refuses every character it just claimed, the board greys the entire fleet, and the
// unstick round — which is the harness's job and must keep running — steps over keepers
// that have genuinely stopped.
{
  const HELD = { by: 'dum/castle-crate@pid-1234', faculties: ['work', 'movement'], at: 111 };

  const owned = describeCommitment({ held: HELD });
  ok('a character a bot merely owns still reports who is driving',
     heldBy(owned)?.by === HELD.by);
  ok('and names the faculties it actually holds',
     JSON.stringify(heldBy(owned)?.faculties) === '["work","movement"]');
  ok('and is STILL TAKEABLE, because steering is not an operation', isTakeable(owned) === true);
  ok('but is not invisible — a bot quietly running nine characters gets a row',
     owned?.kind === 'bot' && /is steering/.test(owned.label));

  // The other half: the holder says an operation is in flight.
  const working = describeCommitment({
    held: HELD, busy: { by: HELD.by, kind: 'crate-check', label: 'checking the crate', at: 222 } });
  ok('a declared operation is not takeable', isTakeable(working) === false);
  ok('and says who and what', working.kind === 'bot' && /crate-check|checking the crate/.test(working.label));
  ok('and carries the owner as well as the operation', heldBy(working)?.by === HELD.by);
  ok('and keeps its own start time, not the claim\'s', working.since === 222);
  // The reason this matters, stated where somebody changing it will read it: an external
  // errand walks a character with its keeper inert BY DESIGN, so ms_since_moved — which
  // measures the keeper — climbs while the character is moving perfectly well.
  ok('and explains why a stall reading here is not a stall',
     /is the errand walking/.test(working.detail));

  // A bot-held character that is ALSO doing something the harness knows about.
  const both = describeCommitment({ held: HELD, errand: { kind: 'lootrun', farmer: 'someone' } });
  ok('the harness\'s own errand still wins over bare ownership', both.kind === 'errand');
  ok('and the owner rides along on it', heldBy(both)?.by === HELD.by);
  ok('and an errand is not takeable either', isTakeable(both) === false);

  // Nothing at all.
  ok('no owner and no commitment is still null', describeCommitment({}) === null);
  ok('and null is takeable', isTakeable(null) === true);
  ok('and heldBy of nothing is null', heldBy(null) === null);

  // The ranking: an operation in flight outranks everything, because it is the only one
  // nothing inside the harness can see for itself.
  ok('a declared operation ranks above the harness\'s own errand',
     commitmentRank(working) < commitmentRank(both));
  ok('and a partner still ranks last',
     commitmentRank(describeCommitment({ partner: 'someone' })) > commitmentRank(both));
}

// ---------------------------------------------------------------- the board, with a bot on it
//
// THE REGRESSION THIS SECTION EXISTS TO CATCH. Every cursor helper used to ask
// `!commitmentOf(row)`, which was the same question as "is this takeable" for exactly as
// long as the only commitments were operations. A bot that merely OWNS characters broke
// that equivalence: running a doctrine over the whole fleet would have greyed every row
// and frozen the terminal, which is the "looks like a dead keyboard" failure the module's
// own note is about — reintroduced by the feature meant to make bots visible.
{
  const held = (name, by = 'dum/x@pid-1') => ({
    agent: name, ap: { committed: describeCommitment({ held: { by, faculties: ['work'] } }) } });
  const working = (name, by = 'dum/x@pid-1') => ({
    agent: name, ap: { committed: describeCommitment({
      held: { by, faculties: ['work'] }, busy: { by, kind: 'crate-check', at: 1 } }) } });
  const idle = (name) => ({ agent: name, ap: { committed: null } });

  const wholeFleetOnADoctrine = [held('a'), held('b'), held('c')];
  ok('a fleet a bot is steering is NOT all committed', allCommitted(wholeFleetOnADoctrine) === false);
  ok('and the cursor still moves through it', stepSelection(wholeFleetOnADoctrine, 0, 1) === 1);
  ok('and opens on the first row', firstSelectable(wholeFleetOnADoctrine) === 0);

  // But the one that is actually mid-operation is stepped over, which is the point.
  const mixed = [held('a'), working('b'), idle('c')];
  ok('and steps over the one with an operation in flight', stepSelection(mixed, 0, 1) === 2);
  ok('which the override still reaches', stepSelection(mixed, 0, 1, { override: true }) === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
