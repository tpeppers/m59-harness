#!/usr/bin/env node
// ASK THE STONE BEFORE YOU WALK TO IT — and read the server's verdict instead of guessing at it.
//
//   node tools/m59-nodecheck.mjs --agent hk2           the room that character is standing in
//   node tools/m59-nodecheck.mjs --agent hk2 --json
//   node tools/m59-nodecheck.mjs --explain             the refusal ladder, in kod order
//
// WHY THIS EXISTS. Every other tool in the node-runner family reasons about GEOMETRY: where the
// floor is, which squares connect, what the mover will refuse. All of them answer the question
// "can a body get there". **None of them asks whether getting there would accomplish anything.**
//
// `TryActivate` (`kod/object/passive/mananode.kod:160`) refuses in FIVE places and only one of
// them is about position. Read in order, because the order is the whole point:
//
//   1. `poOwner = $`                        -> silence. A node with no owner answers nothing.
//   2. `piState = NODE_DEAD`                -> mananode_failed_meld.   BEFORE THE RANGE TEST.
//   3. `poOwner = Send(who,@GetOwner)`      -> silence. You and the stone must be held by the
//                                              same room object.
//   4. `abs(dRow) < 3 AND abs(dCol) < 3`    -> mananode_not_in_range
//   5. `GetNodeList & piNode_num`           -> mananode_already_melded
//   -> Meld                                 -> mananode_meld
//
// **A DEAD NODE IS INDISTINGUISHABLE FROM A MOVEMENT FAILURE UNLESS YOU READ THE MESSAGE**, and
// a night can be spent crawling a body across a contested room towards a stone that would have
// refused it standing on top of it. Step 2 is checked before step 4, so "I got into the box and
// nothing happened" and "I never got into the box" have the same shape from outside.
//
// YOU DO NOT HAVE TO TRY THE MELD TO FIND OUT. The state is on the wire continuously, as the
// node's ANIMATION (`mananode.kod:243`, `SendAnimation`):
//
//   NODE_NORMAL   ANIMATE_CYCLE  period 150  groups 1-5
//   NODE_CURSED   ANIMATE_CYCLE  period 250  groups 6-7
//   NODE_DEAD     ANIMATE_NONE               group  8
//
// and `extractAnimation` in `m59-parse.mjs` has been decoding it into every room-contents read
// this repository has ever done. The information was already here; nothing looked at it.
//
// THERE IS A SECOND, INDEPENDENT READ, and it is prose. `piState` also swaps the node's
// DESCRIPTION — `vrDesc = ManaNode_desc_rsc` at :275 against `ManaNode_Dead_desc_rsc` at :289 —
// so `look_at` corroborates the animation from a different field. When the two disagree, say so
// rather than picking one: that is a protocol bug worth a session, and it is invisible if this
// tool quietly prefers its favourite.
//
// ======================= THE TRAP THIS TOOL EXISTS TO REFUSE =======================
//
// `mananode_meld` and `mananode_failed_meld` SHARE THEIR FIRST 116 CHARACTERS:
//
//   "Closing your eyes, you put yourself in a trancelike state and reach out to bind yourself
//    mystically with the node.  "
//        success -> "Reality expands and time collapses, until you come to, refreshed ..."
//        failure -> "You are disappointed when nothing seems to happen."
//
// So the obvious implementation — match the message this repository already has a constant for,
// or take the first N characters — REPORTS A SUCCESSFUL MELD ON A DEAD STONE. Both sentences
// describe closing your eyes and reaching out. Only the tail says whether anything answered.
// `meldVerdict` therefore decides on the DISTINGUISHING TAIL only, and returns `ambiguous` for
// the shared prefix rather than guessing, because a false success here is a stone crossed off a
// list that was never melded.
//
// AND IT NEEDS NO MAP. Every square in this file is the server's own `GetRow`/`GetCol` as sent
// in BP_ROOM_CONTENTS, compared with the same fields for our own body — the exact two numbers
// `TryActivate` subtracts. No bake, no BSP, no fine grid, no opinion about where the floor is.
// When this tool and the geometry disagree about whether we are in the box, THE GEOMETRY IS
// WRONG, because this is the arithmetic the server actually performs.

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- the pure half

/** `kod/include/blakston.khd:2369`. Object animations are 1, 2 or 3; the rest are walls. */
export const ANIMATE = Object.freeze({ NONE: 1, CYCLE: 2, ONCE: 3 });

/** `mananode.kod:19` — and NODE_NORMAL is what the constructor sets (:64). */
export const NODE_STATE = Object.freeze({ NORMAL: 1, CURSED: 2, DEAD: 3 });

/** `mananode.kod:17`, applied per axis at :177 as `abs(d) < MANANODE_RANGE`. */
export const MANANODE_RANGE = 3;

/**
 * WHAT STATE IS THIS STONE IN, from its animation alone.
 *
 * Takes the `appearance.animation` object the `look` tool already returns — `{type, group,
 * period, group_low, group_high}` — and returns one of `normal` / `cursed` / `dead`, or
 * `unknown` with the reason it could not tell. It never throws on a shape it does not
 * recognise: an unreadable animation is a thing to REPORT, not to crash on, because the
 * caller is usually standing in a hostile room while it asks.
 */
export function classifyNode(animation) {
  if (!animation || typeof animation !== 'object')
    return { state: 'unknown', why: 'no animation field on this object' };
  const { type, group, period, group_low: lo, group_high: hi } = animation;
  if (type === ANIMATE.NONE) {
    // `AddPacket(1,ANIMATE_NONE, 2,8)` — a static node is a dead one, and group 8 is the
    // corpse frame. A static node in ANY other group is not a mana node we understand.
    if (group === 8) return { state: 'dead', why: 'ANIMATE_NONE group 8 (mananode.kod:259)' };
    return { state: 'unknown', why: `static, but group ${group} is not the dead node's 8` };
  }
  if (type === ANIMATE.CYCLE) {
    if (period === 150 && lo === 1 && hi === 5)
      return { state: 'normal', why: 'ANIMATE_CYCLE 150ms groups 1-5 (mananode.kod:245)' };
    if (period === 250 && lo === 6 && hi === 7)
      return { state: 'cursed', why: 'ANIMATE_CYCLE 250ms groups 6-7 (mananode.kod:252)' };
    return { state: 'unknown', why: `cycling ${period}ms groups ${lo}-${hi}, which is neither ` +
                                    `NORMAL (150/1-5) nor CURSED (250/6-7)` };
  }
  return { state: 'unknown', why: `animation type ${type} is not one a mana node sends` };
}

/**
 * THE FOUR THINGS THE SERVER SAYS, AND WHY A PREFIX MATCH GETS TWO OF THEM BACKWARDS.
 *
 * Keyed on the DISTINGUISHING TAIL of each resource string, never on the opening, because
 * `mananode_meld` and `mananode_failed_meld` open identically for 116 characters. A caller
 * that receives `ambiguous` has seen the shared prefix and nothing after it — which means the
 * message was truncated, and the right move is to read max mana rather than believe either.
 */
export const MELD_MARKERS = Object.freeze([
  { verdict: 'melded',    marker: 'reality expands',    rsc: 'mananode_meld' },
  { verdict: 'dead',      marker: 'you are disappointed', rsc: 'mananode_failed_meld' },
  { verdict: 'already',   marker: 'already bonded',     rsc: 'mananode_already_melded' },
  { verdict: 'not_in_range', marker: 'not close enough', rsc: 'mananode_not_in_range' },
  // A SUBCLASS CAN REFUSE FOR A REASON THE BASE CLASS HAS NO WORD FOR. `AvarNode` (room 2154)
  // overrides TryActivate and checks KARMA SIGN before anything else: a GOOD node refuses
  // karma < 0 and an EVIL one refuses karma > 0 (avarnode.kod:63). Karma of exactly 0 passes
  // both, which is the only state that can meld either variant.
  { verdict: 'karma',     marker: 'rejects your attempt', rsc: 'AvarNode_rejected' },
]);

const SHARED_PREFIX = 'trancelike state';

export function meldVerdict(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t.trim()) return { verdict: 'silent', why: 'the server said nothing — see the two ' +
    'silent refusals in the ladder: a nil owner, or a stone held by a different room object' };
  for (const m of MELD_MARKERS)
    if (t.includes(m.marker)) return { verdict: m.verdict, why: `matched ${m.rsc}` };
  if (t.includes(SHARED_PREFIX))
    return { verdict: 'ambiguous', why: 'this is the prefix mananode_meld and ' +
      'mananode_failed_meld SHARE. It says a meld was attempted and not whether it worked — ' +
      'read max mana inside this session to settle it' };
  return { verdict: 'unrelated', why: 'not one of the four mana-node messages' };
}

/** `mananode.kod:230` — `((5 + Mysticism) / 10) + 3`, kod integer division. Dead nodes give 0. */
export function manaAdjust(mysticism, { state = 'normal' } = {}) {
  if (state === 'dead') return 0;
  return Math.floor((5 + Number(mysticism || 0)) / 10) + 3;
}

/**
 * THE EXACT SUBTRACTION `TryActivate` PERFORMS, on the server's own numbers.
 *
 * It is a 5x5 BOX judged PER AXIS — `abs(dRow) < 3 AND abs(dCol) < 3` — not a radius and not a
 * distance. Sixteen squares other than the stone's own finish the errand, and the stone's own
 * square is frequently not standable because the stone is on it.
 */
export function meldBox(you, node, { range = MANANODE_RANGE } = {}) {
  const dRow = Number(node.row) - Number(you.row);
  const dCol = Number(node.col) - Number(you.col);
  const inBox = Math.abs(dRow) < range && Math.abs(dCol) < range;
  const needRow = Math.max(0, Math.abs(dRow) - (range - 1));
  const needCol = Math.max(0, Math.abs(dCol) - (range - 1));
  return { inBox, dRow, dCol, needRow, needCol,
           chebyshev: Math.max(Math.abs(dRow), Math.abs(dCol)) };
}

/** Mana nodes among a `look` reply's objects, by name and by icon, disagreements reported. */
export function nodesIn(objects = []) {
  const out = [];
  for (const o of objects) {
    const byName = String(o.name ?? '').toLowerCase() === 'mana node';
    const byIcon = String(o.appearance?.icon_resource ?? '').toLowerCase() === 'node.bgf';
    if (!byName && !byIcon) continue;
    out.push({ ...o, byName, byIcon,
      // A disagreement is a finding, not a tie to break. `FeyNode` and `AvarNode` are both
      // `is ManaNode` and may carry their own name or icon, so one signal alone is thin.
      identifiedBy: byName && byIcon ? 'name+icon' : byName ? 'name only' : 'icon only' });
  }
  return out;
}

/** The whole verdict for one room read, with nothing inferred that was not sent. */
export function nodeReport({ objects = [], you = null, mysticism = null } = {}) {
  const found = nodesIn(objects);
  return {
    count: found.length,
    nodes: found.map(n => {
      const cls = classifyNode(n.appearance?.animation);
      const box = you ? meldBox(you, n) : null;
      return {
        id: n.id, row: n.row, col: n.col, identifiedBy: n.identifiedBy,
        state: cls.state, why: cls.why,
        box,
        wouldGrant: manaAdjust(mysticism, { state: cls.state }),
        // The one sentence a caller wants. Order matches the kod's refusal ladder, so the
        // reason given is the one the SERVER would give first.
        verdict: cls.state === 'dead' ? 'DEAD — no amount of walking will meld this'
               : cls.state === 'unknown' ? 'UNKNOWN state — read the description to corroborate'
               : !box ? `${cls.state} — position not supplied, cannot judge range`
               : box.inBox ? `${cls.state} and IN THE BOX — meld now`
               : `${cls.state}, ${box.chebyshev} square(s) off — close to within 2 per axis`,
      };
    }),
  };
}

// ---------------------------------------------------------------- the live half

const LADDER = `
TryActivate refuses in five places (kod/object/passive/mananode.kod:160), IN THIS ORDER:

  1  poOwner = $                      silence      the node has no owning room
  2  piState = NODE_DEAD              "...You are disappointed when nothing seems to happen."
  3  poOwner <> GetOwner(who)         silence      you and the stone are in different rooms
  4  abs(dRow) < 3 AND abs(dCol) < 3  "The mana node is not close enough to meld with."
  5  GetNodeList & piNode_num         "You have already bonded with this mana node."
  -> Meld                             "...Reality expands and time collapses..."

STEP 2 IS BEFORE STEP 4. A dead stone refuses you standing on top of it, with a message whose
first 116 characters are identical to the success message. Two of the five refusals are SILENT.

State is readable without trying, as the animation (mananode.kod:243):
  NODE_NORMAL  ANIMATE_CYCLE 150ms groups 1-5      NODE_CURSED  ANIMATE_CYCLE 250ms groups 6-7
  NODE_DEAD    ANIMATE_NONE  group 8
and corroborated by the description, which piState swaps at :275 / :289.

Mana granted: ((5 + Mysticism) / 10) + 3, kod integer division (mananode.kod:230). Dead: 0.
`;

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = n => argv.includes('--' + n);

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('m59-nodecheck.mjs');
if (isMain) {
  if (has('help')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  if (has('explain')) { console.log(LADDER); process.exit(0); }

  const agent = flag('agent');
  if (!agent) {
    console.error('need --agent <name>  (or --explain for the refusal ladder, offline)');
    process.exit(2);
  }

  const RPC = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901/';
  const call = async (name, args) => {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json();
    try { return JSON.parse(d.result.content[0].text); } catch { return d.result?.content?.[0]?.text ?? d; }
  };

  const look = await call('look', { agent });
  if (!look?.in_game) {
    console.error(`${agent} is not in game: ${JSON.stringify(look).slice(0, 200)}`);
    process.exit(1);
  }
  const mysticism = look.skills?.mysticism?.value ?? look.skills?.Mysticism?.value ?? null;
  const report = nodeReport({ objects: look.objects ?? [], you: look.you, mysticism });

  if (has('json')) {
    console.log(JSON.stringify({ agent, room: look.room, you: look.you, mysticism, ...report }, null, 1));
    process.exit(0);
  }

  const where = `${look.room?.name ?? '?'} (${look.room?.num ?? '?'})`;
  console.log(`\n${look.character ?? agent} in ${where}, standing at ` +
              `r${look.you?.row}c${look.you?.col}   max mana ${look.mana?.max ?? '?'}` +
              (mysticism != null ? `   mysticism ${mysticism}` : ''));
  if (!report.count) {
    console.log(`\n  NO MANA NODE IN THIS ROOM'S CONTENTS.`);
    console.log(`  That is a fact about what the server sent, not about the map. Five of the`);
    console.log(`  thirteen stones APPEAR and DISAPPEAR — room 599's exists for 5 real minutes`);
    console.log(`  in every 2 hours — so an empty room may be the clock rather than the place.`);
    console.log(`  See tools/m59-stones.mjs for which stones are timed.\n`);
    process.exit(0);
  }
  for (const n of report.nodes) {
    console.log(`\n  mana node #${n.id} at r${n.row}c${n.col}   [${n.identifiedBy}]`);
    console.log(`    state     ${n.state.toUpperCase()} — ${n.why}`);
    if (n.box)
      console.log(`    range     dRow ${n.box.dRow >= 0 ? '+' : ''}${n.box.dRow}, ` +
                  `dCol ${n.box.dCol >= 0 ? '+' : ''}${n.box.dCol}   ` +
                  `${n.box.inBox ? 'INSIDE the 5x5 box' :
                     `outside — need ${n.box.needRow} row(s) and ${n.box.needCol} col(s) closer`}`);
    console.log(`    would add ${n.wouldGrant} max mana`);
    console.log(`    ${n.verdict}`);
  }
  console.log();
}
