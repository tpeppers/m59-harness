// Offline: a quest item is never dropped and never offered to a merchant; a trade to a player still carries it.
// The incident: Janice's shard A (Riija tip) left her pack in the avar jungle, 2026-11-15 22:20Z. See m59-quest-items.mjs.
import { M59Client, BP } from './m59-client.mjs';
import { QUEST_ITEMS, isQuestItem } from './m59-quest-items.mjs';

let pass = 0, fail = 0;
const ok = (what, cond) => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}`); } };

// A client object with no socket: inventory, a room, a resource table and a send() that records.
function fakeClient() {
  const c = Object.create(M59Client.prototype);
  const names = { 1: 'shard of a sword', 2: 'red mushroom', 3: 'orc pit boss head', 4: 'Sword of Riija', 9: 'Frisconar', 10: 'Robin' };
  c.rsc = { get: k => names[k] ?? '' };
  c.inventory = [{ id: 101, nameRsc: 1 }, { id: 102, nameRsc: 2, amount: 20 }, { id: 103, nameRsc: 3 }, { id: 104, nameRsc: 4 }];
  c.room = { objects: new Map([[900, { id: 900, nameRsc: 9, flags: 0 }], [901, { id: 901, nameRsc: 10, flags: 0x0004 }]]) };
  c.sent = [];
  c.send = (op, ...parts) => c.sent.push({ op, bytes: Buffer.concat(parts.map(p => Buffer.from(p))) });
  c.emitted = [];
  c.emit = (kind, data) => c.emitted.push({ kind, ...data });
  return c;
}
const idsIn = buf => { const n = buf.readUInt16LE(0); const out = []; for (let i = 0; i < n; i++) out.push(buf.readUInt32LE(2 + i * 4)); return out; };
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

console.log('\nthe list');
ok('every Riija quest item is on it', ['shard of a sword', 'orc pit boss head', 'feather of an avar shaman', 'sword of riija'].every(isQuestItem));
ok('case and plural do not matter', isQuestItem('Shard of a Sword') && isQuestItem('orc pit boss heads'));
ok('ordinary loot is not a quest item', !isQuestItem('red mushroom') && !isQuestItem('long sword') && !isQuestItem(''));
ok('the list is frozen', Object.isFrozen(QUEST_ITEMS));

console.log('\ndrop');
{
  const c = fakeClient();
  quiet(() => c.drop([101]));
  ok('a lone shard is never sent as a drop', c.sent.length === 0);
  ok('and the hold-back is reported', c.emitted.some(e => e.kind === 'quest_item_kept' && e.why === 'drop'));
}
{
  const c = fakeClient();
  quiet(() => c.drop([101, 102, { id: 103, amount: 1 }]));
  ok('a mixed drop goes out without the quest items', c.sent.length === 1 && c.sent[0].op === BP.REQ_DROP);
  ok('only the mushroom is dropped', c.sent.length === 1 && JSON.stringify(idsIn(c.sent[0].bytes)) === JSON.stringify([102]));
}
{
  const c = fakeClient();
  c.drop(102);
  ok('ordinary loot drops as before', c.sent.length === 1 && JSON.stringify(idsIn(c.sent[0].bytes)) === JSON.stringify([102]));
}

console.log('\noffer');
{
  const c = fakeClient();
  quiet(() => c.offer(900, [101, 104]));
  ok('nothing is offered to a merchant when every item is a quest item', c.sent.length === 0);
}
{
  const c = fakeClient();
  quiet(() => c.offer(900, [101, 102]));
  ok('a merchant offer goes out without the shard', c.sent.length === 1 && idsIn(c.sent[0].bytes.subarray(4)).join() === '102');
}
{
  const c = fakeClient();
  c.offer(901, [103]);
  ok('a trade to a PLAYER still carries the head (holder to quester)', c.sent.length === 1 && idsIn(c.sent[0].bytes.subarray(4)).join() === '103');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
