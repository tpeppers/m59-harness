#!/usr/bin/env node
// Offline: an item leaving the pack is REPORTED, and the report says what left and what
// we had just asked for.
//
//   node tools/m59-leftpack-test.mjs
//
// WHAT THIS PINS, AND WHY IT EXISTS.
//
// BP_INVENTORY_REMOVE is the server's explicit "this is no longer in your pack", sent
// whatever the cause — sold, dropped, given, vaulted, eaten, spent, lost on death. The
// client threw it away: it filtered the object out of `this.inventory` and emitted
// nothing, while its exact counterpart BP_INVENTORY_ADD emitted `got`. So an item
// arriving was recorded and an item leaving was not, and when roughly two dozen magic
// items went missing across 2026-09-07/08 — the whole identification queue among them —
// there was no row of any kind to read. Not a wrong row. None.
//
// The three things a future edit is most likely to break, in order:
//
//   1. READING THE OBJECT AFTER THE FILTER. It is one line either side and the code
//      still runs; the event just carries a bare id for ever, which is the one field
//      that cannot be looked up later (object ids are renumbered by `save game`, and
//      the object is by definition no longer ours to ask about).
//   2. LETTING ANY PACKET SET THE BREADCRUMB. Movement outnumbers everything, so
//      `after` would read `move` on every departure in the fleet and the `after: null`
//      rows — the ones actually worth reading — would vanish.
//   3. DECODING `translation` HERE. It is the packed wire byte, and the wand
//      identification in substrate/hooks decodes it. Half-decoding it twice yields
//      silence, not an error.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BP, UC, M59Client, REQUEST_BREADCRUMB_MS } from './m59-client.mjs';

let passed = 0, failed = 0;
const ok = (cond, what) => {
  try { assert.ok(cond); console.log('  ok   ' + what); passed++; }
  catch { console.log('  FAIL ' + what); failed++; }
};
const eq = (a, b, what) => {
  try { assert.deepEqual(a, b); console.log('  ok   ' + what); passed++; }
  catch (e) { console.log(`  FAIL ${what} — got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); failed++; }
};

// Resource ids are the server's string table. Two entries is enough to prove the event
// resolves a NAME rather than passing the raw id through.
const RSC = new Map([[7001, 'wand'], [7002, 'mushroom']]);

// An inventory record as `extractObject` builds one — the fields the event reads.
const obj = (id, nameRsc, extra = {}) => ({
  id, nameRsc, amount: 0, iconRsc: 30499, translation: 201, tag: 0, flags: 0, ...extra,
});

function fixture({ inventory = [] } = {}) {
  const c = new M59Client({ verbose: false, resources: RSC });
  c.state = 'game';
  c.epoch = 1;
  c.seeds = [1, 2, 3, 4, 5];
  const sent = [];
  c.sock = { write(b) { sent.push(Buffer.from(b)); return true; } };
  c.inventory = inventory;
  const events = [];
  c.onEvent = ev => events.push(ev);
  return { c, events, sent };
}

// BP_INVENTORY_REMOVE's whole payload is one object id, and HandleInventoryRemove
// refuses anything that is not exactly SIZE_ID — so the length IS the validation.
const removeBody = id => { const b = Buffer.alloc(4); b.writeUInt32LE(id, 0); return b; };
const left = events => events.filter(e => e.kind === 'left');

console.log('the departing object is described, not just its id');
{
  const { c, events } = fixture({ inventory: [obj(511, 7001), obj(512, 7002)] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));

  eq(left(events).length, 1, 'one `left` event for one removal');
  const ev = left(events)[0];
  eq(ev.id, 511, 'the id the server named');
  eq(ev.name, 'wand', 'the NAME, resolved while the object was still ours to resolve');
  eq(ev.known, true, 'we were holding it');
  ok(/wand/.test(ev.what), '`what` is the human line the rest of the harness prints');
  eq(c.inventory.map(o => o.id), [512], 'and it is gone from the inventory');
}

console.log('appearance is carried, because afterwards there is nothing left to ask');
{
  const { c, events } = fixture({ inventory: [obj(511, 7001, { translation: 207 })] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  const ev = left(events)[0];
  eq(ev.icon_rsc, 30499, 'icon resource id — the sharp key for a wand');
  eq(ev.translation, 207,
     'the PACKED wire byte (0x87 + 11*primary + secondary), NOT a decoded XLAT_TO_* value');
}

console.log('the object is read BEFORE the filter, not after');
{
  // The regression this catches looks harmless and is total: move the read one line down
  // and every field except `id` becomes null for ever, with no error anywhere.
  const { c, events } = fixture({ inventory: [obj(900, 7001)] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(900));
  const ev = left(events)[0];
  ok(ev.name !== null && ev.icon_rsc !== undefined,
     'a filtered-first implementation would have nulls here');
  eq(c.inventory.length, 0, 'and the filter still ran');
}

console.log('an id we were not holding is reported as unknown, not invented');
{
  const { c, events } = fixture({ inventory: [obj(512, 7002)] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(999));
  const ev = left(events)[0];
  eq(ev.known, false, 'we never had it — a stale id, or a pack we never read');
  eq(ev.name, null, 'and no name is manufactured for it');
  eq(ev.what, 'id 999', 'the description says exactly what is known');
  eq(c.inventory.map(o => o.id), [512], 'nothing else was disturbed');
}

console.log('`after` names what WE asked for, when we asked for it');
{
  const { c, events } = fixture({ inventory: [obj(511, 7001)] });
  c.drop(511);
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  const ev = left(events)[0];
  eq(ev.after, 'drop', 'a drop we requested a moment ago explains the departure');
  ok(ev.after_ms !== null && ev.after_ms < 1000, 'and the age says how fresh that claim is');
}

console.log('...and every request that can cost an item is recognised');
{
  const cases = [
    ['drop',           c => c.drop(511)],
    ['put',            c => c.put(511, 42)],
    ['offer',          c => c.offer(42, [511])],
    ['accept_offer',   c => c.acceptOffer()],
    ['counteroffer',   c => c.counterOffer([511])],
    ['deposit_items',  c => c.depositItems(42, [511])],
    ['buy',            c => c.buy(511)],
    ['buy_items',      c => c.buyItems(42, [511])],
    ['use',            c => c.use(511)],
    ['apply',          c => c.apply(511, 42)],
    ['activate',       c => c.activate(511)],
    ['cast',           c => c.cast(77, [511])],
    // USERCOMMAND is a second dispatch table behind one opcode. Reading only the opcode
    // would file a bank deposit under nothing at all.
    ['bank_deposit',   c => c.userCommand(UC.DEPOSIT, Buffer.alloc(4))],
  ];
  for (const [verb, act] of cases) {
    const { c, events } = fixture({ inventory: [obj(511, 7001)] });
    act(c);
    c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
    eq(left(events)[0].after, verb, `${verb} is carried through`);
  }
}

console.log('a request that CANNOT cost an item never overwrites the breadcrumb');
{
  // Movement, turning and attacking outnumber item verbs by orders of magnitude. If any
  // packet could set this, `after` would read `move` fleet-wide and the interesting rows
  // — the ones with nothing to blame — would stop existing.
  const { c, events } = fixture({ inventory: [obj(511, 7001)] });
  c.drop(511);
  c.send(BP.REQ_TURN, Buffer.alloc(2));
  c.send(BP.REQ_ATTACK, Buffer.alloc(4));
  c.send(BP.REQ_LOOK, Buffer.alloc(4));
  c.send(BP.SAY_TO, Buffer.alloc(2));
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  eq(left(events)[0].after, 'drop', 'the drop still stands behind four unrelated packets');
}

console.log('nothing we asked for is reported as nothing — that is the row to read');
{
  const { c, events } = fixture({ inventory: [obj(511, 7001)] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  const ev = left(events)[0];
  eq(ev.after, null, 'the item went without us having requested anything');
  eq(ev.after_ms, null, 'and there is no age for a request that never happened');
}

console.log('a stale request is not an explanation');
{
  const { c, events } = fixture({ inventory: [obj(511, 7001)] });
  c.lastItemRequest = { verb: 'drop', at: Date.now() - (REQUEST_BREADCRUMB_MS + 5_000) };
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  const ev = left(events)[0];
  eq(ev.after, null, 'a minute-old drop does not get to explain this departure');
  ok(ev.after_ms > REQUEST_BREADCRUMB_MS,
     'but the age is still reported, so a reader can disagree with the threshold');
}

console.log('a malformed payload is a parse error, not a silent removal');
{
  const { c, events } = fixture({ inventory: [obj(511, 7001)] });
  c.onGameMessage(BP.INVENTORY_REMOVE, Buffer.concat([removeBody(511), Buffer.alloc(3)]));
  eq(left(events).length, 0, 'no event invented from a payload we could not read');
  eq(c.inventory.map(o => o.id), [511], 'and the inventory is left alone');
  eq(c.parseErrors.at(-1)?.what, 'INVENTORY_REMOVE', 'the parse error is recorded instead');
}

console.log('the payload cannot overwrite the event`s own fields');
{
  // emit(kind, data) spreads data over the event, so a payload field called `kind` wins
  // silently. Same shape as the ledger's recordEvent trap; it has cost an afternoon twice.
  const { c, events } = fixture({ inventory: [obj(511, 7001)] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  eq(events.at(-1).kind, 'left', 'the event kind survives the spread');
  ok(typeof events.at(-1).seq === 'number', 'and it is sequenced like every other event');
}

console.log('a stack reports its amount');
{
  const { c, events } = fixture({ inventory: [obj(511, 7002, { amount: 17 })] });
  c.onGameMessage(BP.INVENTORY_REMOVE, removeBody(511));
  eq(left(events)[0].amount, 17, 'seventeen mushrooms left, not one');
}

// --------------------------------------------------------------- the ledger row
//
// The client's event only exists to become a durable row. Session.noteLeftPack is the
// half that writes it, and it is where the two mistakes with a history live: writing the
// room OBJECT id into a field every reader treats as a MAP NUMBER, and letting a
// bookkeeping failure interrupt play.
//
// Set the scratch directory BEFORE importing anything that records — the ledger resolves
// its directory at module load, and refuses to write from a test that forgot.

process.env.M59_LEDGER_DIR = mkdtempSync(join(tmpdir(), 'm59-leftpack-'));
const { Session } = await import('./m59-game.mjs');

const rows = () => readdirSync(process.env.M59_LEDGER_DIR)
  .flatMap(f => readFileSync(join(process.env.M59_LEDGER_DIR, f), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l)))
  .filter(r => r.kind === 'left_pack');

// Only the fields noteLeftPack reads. A real Session drags a socket and a keeper behind it,
// and neither is part of what this is checking.
const session = (over = {}) => ({
  name: 't8',
  client: { me: { name: 'Robin' } },
  world: { room: { num: 544 } },
  ...over,
});

console.log('the ledger row names the MAP NUMBER, never the room object id');
{
  // 544 is the Valley of Ileria; 1386 is the same room's server object id. Object ids are
  // renumbered by `save game`, so a row carrying one drifts in meaning across a checkpoint
  // while continuing to look perfectly well formed. This line has been wrong twice before.
  Session.prototype.noteLeftPack.call(
    session({ world: { room: { num: 544 } }, client: { me: { name: 'Robin' } }, room: { id: 1386 } }),
    { id: 511, name: 'wand', amount: 0, icon_rsc: 30499, translation: 201,
      after: 'drop', after_ms: 40, known: true });
  const r = rows().at(-1);
  eq(r.room, 544, 'the map number');
  eq(r.character, 'Robin', 'keyed on the character NAME, which means the same thing tomorrow');
  eq(r.agent, 't8', 'and the agent that was driving');
}

console.log('...and its shape matches `looted`, so the two directions read side by side');
{
  const r = rows().at(-1);
  eq(Array.isArray(r.items), true, '`items` is an array even for a single departure');
  eq(r.items.length, 1, 'one item');
  eq(r.count, 1, 'and a count beside it, as `looted` carries');
  eq(r.items[0], { id: 511, name: 'wand', amount: 0, icon_rsc: 30499, translation: 201 },
     'the appearance travels into the row — after this the object cannot be asked');
  eq(r.after, 'drop', 'what we had requested');
  eq(r.after_ms, 40, 'and how long before the removal we requested it');
}

console.log('a room the map does not know is null, not a guess');
{
  Session.prototype.noteLeftPack.call(session({ world: null }),
    { id: 512, name: 'mushroom', known: true });
  const r = rows().at(-1);
  eq(r.room, null, 'a null says "I do not know"; a wrong-space number says 544 and is believed');
  eq(r.after, null, 'and an absent breadcrumb stays absent rather than becoming a verb');
}

console.log('a character we cannot name writes nothing');
{
  const before = rows().length;
  Session.prototype.noteLeftPack.call(session({ client: { me: null } }), { id: 513 });
  eq(rows().length, before, 'the ledger is keyed on the character name; a row without one is noise');
}

console.log('bookkeeping never interrupts play');
{
  // recordEvent is wrapped because a ledger write must not be able to cost us anything.
  // The throw here comes from the getter, which is the same position a full disk occupies.
  const hostile = { name: 't8', client: { me: { name: 'Robin' } },
                    get world() { throw new Error('synthetic'); } };
  let threw = false;
  try { Session.prototype.noteLeftPack.call(hostile, { id: 514 }); } catch { threw = true; }
  eq(threw, false, 'a failure inside the record is swallowed, not propagated to the keeper');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
