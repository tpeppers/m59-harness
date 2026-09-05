// WHICH CHARACTERS THE FLEET IS ALREADY USING FOR SOMETHING.
//
// A fleet board is a list of characters you might pick up and drive. Most of the time
// that is true of every row. It is not true of a character that is halfway through a
// loot run, walking a signet ring across the map, standing still while `supply` drives
// both ends of a trade, or paired with somebody who is counting on it being in the same
// room — those are MULTI-CHARACTER operations, and taking one half of one is not a small
// act. It abandons the other half, silently, and the only sign is that some other
// character stands in a field waiting for a partner that is now in a client window.
//
// So the board has to be able to say "this one is spoken for". That is one question with
// one answer, and it is asked in two places at once — the keeper publishes it in its own
// status, and the terminal greys the row and steps over it — so it lives here rather than
// being written twice and drifting.
//
// Nothing in this file talks to a broker or a server. It is data in, data out, which is
// what makes the skip-and-override behaviour testable without joining anybody to a game.

// The order matters. A character can be several of these at once — an errand runs by
// making the keeper inert, so an errand is nearly always ALSO 'driven' — and the board
// has one line to say what is going on. Most specific first.
//
//   bot      a NAMED PROCESS OUTSIDE THIS REPOSITORY says it is mid-operation on this
//            character right now. First because it is the most specific claim anything
//            can make and because it is the one nothing in here can see for itself; see
//            the note on `held` below for why this is not the same as "a bot owns it".
//   errand   this character was dispatched somewhere: a loot run, a provisioning cast,
//            a signet ring to hand back. It is travelling on the fleet's business.
//   driven   something else has the controls. `supply` holds both ends of a trade this
//            way, and so does the almoner. The keeper is awake and is not steering.
//   parked   getting behind a wall because a fleet update is about to stop everything.
//   partner  a standing arrangement rather than a journey: two keepers agreeing to fight
//            the same creature. Weakest of the five, and the only one that persists.
const ORDER = ['bot', 'errand', 'driven', 'parked', 'partner'];

// OWNING A CHARACTER AND BEING BUSY WITH IT ARE DIFFERENT FACTS, AND CONFLATING THEM
// DEADLOCKS THE BOT THAT ASKED FOR THIS.
//
// A directional bot claims `work` and `movement` on every character it manages and holds
// them for its whole run. If that alone rendered as a commitment, three things break at
// once: the bot's own "leave committed characters alone" rule refuses every character it
// just claimed, the fleet board greys the entire fleet, and `m59-supervise.mjs` — whose
// unstick round is the harness's job and must keep running — steps over a keeper that
// really has stalled.
//
// So ownership is `held_by`, which rides on WHATEVER commitment comes back (including
// none), and is an answer to "who is driving this" rather than to "may I take it".
// Being mid-operation is `busy`, which the holder declares and retracts, and which is
// the thing that reads as hands-off.
//
// The distinction is not theoretical: it is exactly the case that produced this. A crate
// errand walks a character out of its room for three minutes with the keeper inert by
// design, so `ms_since_moved` — which measures the KEEPER — climbs while the character
// is moving perfectly well, and every stall detector in the fleet reads it as stuck.
function botLabel(b) {
  if (!b) return null;
  const who = b.by ? String(b.by).split('@')[0] : 'a bot';
  return `${who}: ${b.label || b.kind || 'working'}`;
}

// Human words for the errand kinds the keeper dispatches. An unknown kind is reported as
// itself rather than dropped — a new errand type must show up on the board the day it is
// added, not the day someone remembers to update this list.
function errandLabel(e) {
  if (!e) return null;
  if (e.kind === 'provision')
    return `${e.service || 'provisioning'} for ${e.supplicant_name || e.supplicant || 'a crewmate'}`;
  // KEPT SHORT ON PURPOSE, and in the same register as the rest of the column.
  //
  // The board gives the activity column 28 characters and cuts the tail. The first
  // version of this read "returning a signet ring to Paddock in Tos", which arrives on
  // the board as "returning a signet ring to …" — every character spent on words that
  // are identical for every ring, and the two that actually vary lost. The prefix has to
  // be short enough that THE OWNER SURVIVES THE CUT for the longest name in the table
  // (Parrin Aragone, 14), because the owner is the destination.
  //
  // `signet:` also matches what the column already says elsewhere — "hunting: giant rat".
  if (e.kind === 'signet')
    return `signet: ${e.owner || 'its owner'}` + (e.town ? `, ${e.town}` : '');
  if (e.kind === 'lootrun' || e.farmer_name || e.farmer)
    return `loot run for ${e.farmer_name || e.farmer}`;
  return String(e.kind || 'an errand');
}

// The shape every consumer reads. `kind` is for logic, `label` is for a person, `detail`
// is the sentence underneath. `since` is a timestamp or null — an operation that has been
// running for forty minutes is a different thing from one that started ten seconds ago,
// and the board should be able to say so.
export function describeCommitment({ errand = null, inert = null, parked = null,
                                     partner = null, busy = null, held = null } = {}) {
  // `held_by` rides on every answer, including the null one, so "who is driving this
  // character" is answerable without first asking "is it busy". Those are the two halves
  // of the question and only one of them means hands-off.
  const owner = held?.by
    ? { by: held.by, faculties: held.faculties ?? [], since: held.at ?? null }
    : null;
  const withOwner = c => (c && owner) ? { ...c, held_by: owner } : (c ?? (owner ? {
    // HELD, NOT BUSY, NOT OTHERWISE COMMITTED. This is a real state and it needs a row on
    // the board — a bot quietly steering nine characters should not be invisible — but it
    // must NOT read as a commitment, so it is the one answer that carries `takeable`.
    kind: 'bot', label: `${String(owner.by).split('@')[0]} is steering`, since: owner.since,
    takeable: true,
    detail: `holds ${owner.faculties.join(', ') || 'nothing'}; the keeper has the rest and ` +
            `takes these back when the lease lapses. Not an operation — nothing is mid-flight`,
    held_by: owner,
  } : null));

  if (busy && !busy.done)
    return withOwner({ kind: 'bot', label: botLabel(busy), since: busy.at ?? null,
                       detail: busy.detail ||
                         'a process outside the harness says it is mid-operation on this ' +
                         'character; its keeper is inert on purpose, so a stall reading here ' +
                         'is the errand walking, not a character standing still' });
  if (errand && !errand.done)
    return withOwner({ kind: 'errand', label: errandLabel(errand), since: errand.at ?? null,
             detail: errand.kind === 'signet'
               ? 'a returned ring pays ten times its value to a character under 30 max health'
               : 'dispatched by the fleet; taking it abandons the other end' });
  // A COMMITMENT WITH NO `since` CANNOT BE TOLD FROM A DEAD ONE.
  //
  // This said `since: null` while `goInert` had recorded the time all along — so a `driven`
  // hold was the one commitment on the board that could not be aged. When an accidental
  // import left all 21 characters inert and exited, the board showed 21 rows of "all hands —
  // mustering at Cor Noth" with a null timestamp and no owner, every rule in the fleet
  // stepped over them, and the only way to learn it was stale was for a second session to
  // enumerate the running processes and prove the driver did not exist.
  //
  // `expires_at` matters as much as `since`: an inert keeper lapses on its own after fifteen
  // minutes, and a reader that cannot see the deadline cannot tell "held" from "about to
  // stop being held" — which is the difference between waiting and intervening.
  if (inert)
    return withOwner({ kind: 'driven', label: inert.why || 'something else is driving',
             since: inert.at ?? null,
             expires_at: inert.expires_at ?? null,
             by: inert.by ?? null,
             detail: 'the keeper is awake and is not steering — usually a two-sided trade' +
                     (inert.by ? `; taken by ${inert.by}` : '') +
                     (inert.at ? '' : '. NO START TIME RECORDED — this predates the code that ' +
                                      'stamps one, so it cannot be aged') });
  if (parked)
    return withOwner({ kind: 'parked', label: parked.ready ? 'parked, ready for a fleet update'
                                                 : 'parking for a fleet update',
             since: null,
             detail: 'an update is waiting on this character to get somewhere survivable' });
  if (partner)
    return withOwner({ kind: 'partner', label: `fighting alongside ${partner}`, since: null,
             detail: 'both advance from one kill; a partner alone will not start a fight' });
  return withOwner(null);
}

/**
 * MAY I REDIRECT THIS CHARACTER? — the question every caller of the above is really
 * asking, answered once so that five callers do not each get it slightly wrong.
 *
 * The subtle case is the whole reason this function exists: a character a bot merely
 * OWNS is takeable (the bot is steering it, not mid-operation on it), while the same
 * character with `busy` declared is not. A consumer testing `if (committed)` gets that
 * backwards and greys a fleet somebody is quietly running perfectly well.
 */
export const isTakeable = (c) => !c || c.takeable === true;

/** Who is driving, whatever else is true — null when it is the keeper. */
export const heldBy = (c) => c?.held_by ?? null;

// THE TERMINAL'S SIDE, and it deliberately does not require a broker that knows about any
// of this. `ap.committed` is what a current keeper publishes; the three fields under it
// are what every keeper has published for months. So an old broker still greys the right
// rows — one fewer thing that has to be restarted before the board tells the truth.
const ERRAND_SENTENCE = /^(loot run for |create (food|weapon) for |returning a signet)/;

export function commitmentOf(row) {
  const ap = row?.ap ?? row ?? null;
  if (!ap) return null;
  if (ap.committed !== undefined) return ap.committed;      // null is an answer, not a gap
  // An old broker does not publish the errand itself, only the sentence it produces.
  // Reconstructing the kind from that sentence would be guesswork, so this does not try:
  // it reports THAT there is an errand and lets the keeper's own sentence stand as the
  // label.
  if (ERRAND_SENTENCE.test(ap.activity || ''))
    return { kind: 'errand', label: ap.activity, since: null,
             detail: 'dispatched by the fleet; taking it abandons the other end' };
  return describeCommitment({
    inert: ap.inert ?? null,
    parked: ap.parked ?? null,
    partner: ap.policy?.partner ?? null,
  });
}

// Rank, for a board that wants to sort or colour by how firmly a character is held.
export const commitmentRank = (c) => (c ? ORDER.indexOf(c.kind) : ORDER.length);

// ---------------------------------------------------------------- moving the cursor
//
// Skipping is the whole point and it has one failure mode worth guarding: a fleet where
// EVERY character is committed. Naively, the cursor then refuses to move and the terminal
// looks frozen — which is the worst possible way to discover that you need the override
// key. So a step that finds nothing selectable returns where it started, and the caller
// is expected to say why on the status line.
//
// No wrapping, because the list does not wrap today and a cursor that jumps from the
// bottom to the top while skipping rows is genuinely hard to follow.
//
// THE TEST IS `isTakeable`, NOT "has a commitment", AND THE DIFFERENCE ARRIVED WITH BOTS.
// Every one of these used to read `!commitmentOf(row)`, which was the same question while
// the only commitments were operations. It stopped being the same question the moment a
// character could report an OWNER without an operation: a bot steering nine characters
// would have greyed nine rows and, with a doctrine on the whole fleet, frozen the board
// entirely — the exact "looks like a dead keyboard" failure the note above is about.
const takeableRow = (r) => isTakeable(commitmentOf(r));

export function stepSelection(rows, from, delta, { override = false } = {}) {
  if (!rows?.length) return 0;
  const start = Math.max(0, Math.min(rows.length - 1, from | 0));
  if (override) return Math.max(0, Math.min(rows.length - 1, start + delta));
  for (let i = start + delta; i >= 0 && i < rows.length; i += delta)
    if (takeableRow(rows[i])) return i;
  return start;
}

// Where the cursor should sit when the list is first drawn, or after a refresh has
// reordered it. Same rule: prefer a free character, but never point at nothing.
export function firstSelectable(rows, { override = false } = {}) {
  if (!rows?.length) return 0;
  if (override) return 0;
  const i = rows.findIndex(takeableRow);
  return i < 0 ? 0 : i;
}

// True when the cursor cannot move at all without the override — the case the status line
// has to explain rather than leave looking like a broken key.
export const allCommitted = (rows) => !!rows?.length && !rows.some(takeableRow);
