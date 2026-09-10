#!/usr/bin/env node
// MELD THE FLEET WITH THE MANA NODES IT WALKS PAST.
//
//   node tools/m59-mananode.mjs --list           where they are, nobody moves
//   node tools/m59-mananode.mjs                  meld whoever is already standing in one
//   node tools/m59-mananode.mjs --agent t3       just this one
//
// A mana node is a permanent, free, irreversible-in-the-good-direction gain in MAX MANA,
// and it is the only thing in this game that raises the ceiling rather than refilling
// what is under it. `ManaNode.Meld` (koddb, ManaNode:163) grants
//
//     GetManaAdjust = ((5 + Mysticism) / 10) + 3
//
// which is +3 at mysticism 0 and +8 at 45 — integer division, so it moves in whole steps
// and a point of mysticism is usually worth nothing. It is recorded on the PLAYER as a
// bitmask, `piNodelist |= node_num` (NewMaxMana), so the nodes STACK: every one melded is
// another few points of ceiling, for ever, on that character.
//
// WHY THIS IS WORTH A WALK. Statler sat stalled for the length of a shift on
// `unarmed — 11 mana, needs 15 to make one`: a character with no weapon, whose way out is
// to conjure one, permanently four mana short of being able to. Three points of ceiling
// is the difference between that stall and a character that arms itself. Nothing else the
// fleet can do in an afternoon moves that number.
//
// THE RANGE TEST IS A SQUARE, NOT A DISC, AND IT IS EXCLUSIVE ON BOTH AXES:
//
//     abs(who.row - node.row) < MANANODE_RANGE AND abs(who.col - node.col) < MANANODE_RANGE
//
// with MANANODE_RANGE = 3 — so Chebyshev distance 2 or less, and a character 3 squares
// away on EITHER axis is refused however close it is on the other. `approach` ranks by
// straight-line distance, which is not that metric, so this asks for 1 and then checks the
// real test against the coordinates before spending the activate.
//
// A refusal is a SENTENCE SPOKEN TO THE ROOM, never an error on the wire — the same trap
// as selling to Izzio. `mananode_already_melded` ("You have already bonded with this mana
// node."), `mananode_not_in_range` and `AvarNode_rejected` all arrive as ordinary text
// with a successful call underneath them, so this reads the event stream afterwards and
// reports what the server actually said rather than what the activate was asked to do.
import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(`--${flag}`);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const RPC = `http://127.0.0.1:${arg('port', 8901)}/`;
const LIST_ONLY = !!arg('list', false);
const ONLY = arg('agent', null);
const DRY = !!arg('dry-run', false);

// EVERY MANA NODE IN THE WORLD, read out of the room classes that create them
// (koddb.json, `Create(&ManaNode,#node_num=...)` inside each room's constructor) and
// joined to room numbers through substrate/m59-map.json.
//
// `row`/`col` are the node's own square as the room places it. They are stated in the
// kod's order — ROW FIRST — and `look`/`walk_to` speak col/row, which is the transposition
// this file exists to get wrong in exactly one place instead of five.
const NODES = [
  { room:   39, node: 'NODE_VICTORIA', row: 13, col: 46, where: 'Upstairs in Castle Victoria' },
  { room:   45, node: 'NODE_BADLANDS', row: 63, col: 46, where: 'The Badlands' },
  { room:  515, node: 'NODE_A5',       row: 20, col: 17, where: "Seafarer's Peak" },
  { room:  589, node: 'NODE_H9',       row: 45, col: 32, where: 'Under the shadow of the Sentinel' },
  { room:   27, node: 'NODE_ORCCAVES', row: 23, col: 53, where: 'A Deep, Dark, Spooky, Icky Cave' },
  { room:  750, node: 'NODE_ICECAVE1', row: 25, col: 23, where: 'The Dreaded Caves of Ice' },
  { room: 1006, node: 'NODE_GUEST',    row: 35, col:  5, where: 'Mausoleum' },
];

const byRoom = new Map(NODES.map(n => [n.room, n]));

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// The one place the range rule lives. Exclusive, per-axis, and against MANANODE_RANGE 3.
const inRange = (a, b) => Math.abs(a.row - b.row) < 3 && Math.abs(a.col - b.col) < 3;

// WHAT THE SERVER SAID, which is the only evidence that a meld happened. Matched on the
// text of the resources rather than on a code, because none of these carry one.
function readOutcome(text) {
  const t = String(text || '');
  if (/already bonded with this mana node/i.test(t))        return 'already';
  if (/not close enough to meld/i.test(t))                  return 'out of range';
  if (/node rejects your attempt/i.test(t))                 return 'rejected (karma)';
  if (/trancelike state and reach out to bind/i.test(t))    return 'MELDED';
  return null;
}

async function meldOne(agent, character) {
  const st = await call('status', { agent }).catch(() => null);
  // `status` HAS TWO SHAPES AND THIS READ ONLY ONE OF THEM. A keeper-backed character
  // reports `room_num`; a character the broker holds IN-PROCESS reports `where: {num, name}`
  // — so this resolved null for the second kind, `byRoom.get(null)` missed, and the tool
  // announced "no node in this room" while the character was standing on the stone. Marco
  // Polo in room 27, 2026-09-10. Third instance of this exact family in one session, after
  // fleetScript's `observe()` reading `s.hp` and not `s.vitals.health`, so `where` is asked
  // FIRST here: it is the one the status tool documents.
  const roomNum = st?.where?.num ?? st?.room?.num ?? st?.room_num ?? null;
  const spot = byRoom.get(Number(roomNum));
  if (!spot) return { agent, character, room: roomNum, result: 'no node in this room' };

  const seen = await call('look', { agent }).catch(() => null);
  const objects = seen?.objects || seen?.room?.objects || [];
  // The node is scenery, not a monster: it is the object in the room whose name says so.
  const node = objects.find(o => /node/i.test(o.name || ''));
  if (!node) return { agent, character, room: roomNum, where: spot.where,
                      result: `no object naming a node in ${spot.where} — the room table says ` +
                              `there is one at row ${spot.row} col ${spot.col}` };

  if (DRY) return { agent, character, where: spot.where, result: `would meld ${node.name}` };

  // Ask to be adjacent, then CHECK the real rule rather than trusting the walk. `approach`
  // ranks by straight-line distance and the server's test is per-axis, so "close enough"
  // is not the same question in the two places.
  await call('approach', { agent, target: node.id ?? node.name, distance: 1 }).catch(() => {});
  let me = await call('look', { agent }).catch(() => null);
  let at = { row: me?.self?.row ?? me?.row, col: me?.self?.col ?? me?.col };
  if (!inRange(at, spot)) {
    // Fall back to the node's own square out of the room table. walk_to speaks col/row.
    await call('walk_to', { agent, col: spot.col, row: spot.row }).catch(() => {});
    me = await call('look', { agent }).catch(() => null);
    at = { row: me?.self?.row ?? me?.row, col: me?.self?.col ?? me?.col };
  }

  // MEASURE THE THING THAT MUST CHANGE, which is MAX mana and not the current value.
  // A meld raises the CEILING; the pool underneath it moves on its own every second.
  const maxManaOf = (v) => v?.vitals?.mana?.max ?? v?.mana?.max ?? null;
  const before = maxManaOf(await call('status', { agent }).catch(() => null));

  await call('act', { agent, verb: 'activate', target: node.id ?? node.name }).catch(() => {});

  // THE RECEIPT IS THE CEILING, NOT THE SENTENCE.
  //
  // This read `history` for the server's own words and `history` does not carry them: it
  // answers a fleet-wide SUMMARY -- {window_hours, characters, fleet, recent_events, ...} --
  // with no `events` key at all, so `(hist?.events || hist || []).map` called `.map` on the
  // summary object and every run died with "(...).map is not a function". Standing on the
  // stone in room 27 and unable to spend the activate, 2026-09-09. `recent_events` is
  // structured rows (kind, character, creature) and never the spoken text either, so there
  // was no version of this read that could have worked.
  //
  // Max mana is the better witness anyway. mananode.kod grants it and the grant is what we
  // came for, so a rise IS the meld and needs no prose parsed. It is also the one number an
  // already-bonded node leaves alone, which separates the two outcomes that matter.
  await new Promise(r => setTimeout(r, 2500));
  const after = maxManaOf(await call('status', { agent }).catch(() => null));
  const gained = Number.isFinite(before) && Number.isFinite(after) ? after - before : null;

  let outcome;
  if (gained > 0) outcome = `MELDED -- max mana ${before} -> ${after} (+${gained})`;
  else if (gained === 0) outcome = `no change -- max mana still ${after}; already bonded with ` +
    `this node, or out of range (the test is per-axis: abs(drow) < 3 AND abs(dcol) < 3)`;
  else outcome = 'could not read max mana before and after -- nothing is proven either way';

  return { agent, character, where: spot.where, node: spot.node,
           at: `${at.col},${at.row}`, in_range: inRange(at, spot),
           max_mana_before: before, max_mana_after: after, result: outcome };
}

async function main() {
  if (LIST_ONLY) {
    console.log(`${NODES.length} mana nodes in the world — +((5 + mysticism)/10 + 3) max mana each, and they stack\n`);
    for (const n of NODES)
      console.log(`  ${String(n.room).padStart(4)}  ${n.where.padEnd(34)} ${n.node.padEnd(15)} row ${n.row} col ${n.col}`);
    console.log('\n  the meld needs Chebyshev distance 2 or less — abs(drow) < 3 AND abs(dcol) < 3');
    return;
  }

  const fleet = await call('fleet', {});
  // THE KEY IS `fleet`, AND GUESSING AT THREE OTHERS MEANT FALLING THROUGH TO THE WHOLE
  // REPLY. `fleet` answers `{agents, stalled_count, fleet: [...], world_clock}`; this chain
  // named `characters` and `rows`, neither of which exists, then defaulted to the OBJECT and
  // called `.filter` on it — `mananode failed: (...).filter is not a function` for every run.
  // Standing on the stone in room 27 with the tool unable to list anybody, 2026-09-09.
  const rowsRaw = fleet?.fleet ?? fleet?.characters ?? fleet?.rows ?? fleet;
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : [])
    .filter(r => !ONLY || r.agent === ONLY);
  if (!rows.length) { console.log('nobody to meld'); return; }

  const out = [];
  for (const r of rows) out.push(await meldOne(r.agent, r.character ?? r.name ?? r.agent));

  const melded = out.filter(o => o.result === 'MELDED');
  for (const o of out) {
    if (/no node in this room/.test(o.result) && !ONLY) continue;   // the ordinary case, not news
    console.log(`${String(o.character ?? o.agent).padEnd(10)} ${o.where ?? ''} — ${o.result}`);
  }
  console.log(`\n${melded.length} melded, ${out.filter(o => o.result === 'already').length} already bonded`);
}

main().catch(e => { console.error('mananode failed:', e.message); process.exit(1); });
