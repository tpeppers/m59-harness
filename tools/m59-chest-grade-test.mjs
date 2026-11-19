#!/usr/bin/env node
// OFFLINE. A GUILD CHEST'S READING CARRIES EACH OBJECT'S GRADE, AND A DRAW LISTENS TO IT.
//
//   node tools/m59-chest-grade-test.mjs
//
// The incident (prod, 2026-11-19 05:34Z, hall 714): hall-sell-mundane asked the chests for "short sword" BY NAME. The chest
// held a plain one and an UNIDENTIFIED one (grade 100); it handed over the unidentified one, which was cursed underneath,
// and it wielded itself in Animal's hand in place of his hammer (item.kod:508-514). The server had sent every object's
// grade in BP_OBJECT_CONTENTS; the client, the broker's `container` tool, the keeper's `contents` op, refreshChestCache and
// the chest cache all kept {id, name, amount}.
//
// Pins, in order: the wire (the client's container event carries rarity/icon/flags), the row shape and the grade rule
// (gradedRow / gradeOf / drawGradeAllows), the cache (one row per object with its grade, no object ids, an old row reads
// UNKNOWN), the keeper's by-name draw (gear takes its plain grade only), and the keeper's BY-ID draw with the three
// handle rules (a read voided by a save is refused; the object must still be what was asked; what arrives is judged by
// name and grade, and anything else goes straight back and stops the draw).
//
// No socket, no keeper process, no roster: a fake session in a scratch storage directory and the REAL Autopilot methods.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-chest-grade-'));
process.env.M59_STORAGE_DIR = scratch;
process.env.M59_LEDGER_DIR = scratch;
const { M59Client } = await import('./m59-client.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { StorageCache, chestCacheRow } = await import('./m59-storage.mjs');
const { gradedRow, gradeOf, drawGradeAllows, plainGradeOf } = await import('./m59-items.mjs');

let pass = 0, fail = 0;
const ok = (c, what, detail = '') => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}${detail ? ' — ' + detail : ''}`); } };
const section = s => console.log(`\n${s}`);

// ------------------------------------------------------------------ 1. the wire
section('the client\'s container event carries each object\'s grade, icon and flags');
{
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
  const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
  const u8 = n => Buffer.from([n & 0xff]);
  const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0, 0); return b; };
  // extractObject: id (tagged), [amount], icon, name, flags, rarity, dlighting, animation, overlays.
  const obj = (id, nameRsc, rarity, { amount = null, icon = 5000, flags = 0 } = {}) => Buffer.concat([
    u32(amount != null ? (id | (1 << 28)) : id), ...(amount != null ? [u32(amount)] : []),
    u32(icon), u32(nameRsc), u32(flags), i32(rarity), u16(0), u8(1), u16(0), u8(0)]);
  const body = Buffer.concat([u32(777), u16(3),
    obj(41, 801, 0, { icon: 6001 }), obj(42, 801, 100, { icon: 6001 }), obj(43, 802, 0, { amount: 55, icon: 6002 })]);
  const c = new M59Client({ resources: new Map([[801, 'short sword'], [802, 'herbs']]), verbose: false });
  c.onGameMessage(135, body);
  const ev = c.events.find(e => e.kind === 'container');
  ok(!!ev && ev.id === 777, 'a container event for the box', JSON.stringify(ev));
  const [plain, unid, herbs] = ev?.items ?? [];
  ok(plain?.name === 'short sword' && plain.rarity === 0 && plain.icon_rsc === 6001, 'the plain short sword: grade 0, its icon', JSON.stringify(plain));
  ok(unid?.rarity === 100, 'the unidentified one: grade 100 -- the field every reader used to drop', JSON.stringify(unid));
  ok(plain?.amount === undefined && herbs?.amount === 55, 'amount stays undefined for an ordinary object (dropSpec reads it as "is a stack")', JSON.stringify([plain?.amount, herbs?.amount]));
  ok('flags' in (plain ?? {}) && 'tag' in (plain ?? {}), 'flags and tag ride along');
}

// ------------------------------------------------------------------ 2. the row and the rule
section('gradedRow / gradeOf: a missing grade is unknown, never normal');
{
  const r = gradedRow({ id: 1, name: 'short sword', rarity: 100, icon_rsc: 6001 });
  ok(r.rarity === 100 && r.rarity_name === 'unidentified' && r.unidentified === true && r.amount === 1, 'grade 100 named, amount defaults to 1', JSON.stringify(r));
  ok(gradeOf(gradedRow({ id: 2, name: 'x', rarity: 0 })) === 'normal', '0 is normal');
  ok(gradeOf(gradedRow({ id: 3, name: 'x' })) === 'unknown', 'absent is unknown');
  ok(gradeOf(gradedRow({ id: 4, name: 'x', rarity: null })) === 'unknown', 'null is unknown (Number(null) is 0, and that is the trap)');
  ok(gradeOf({ name: 'x', amount: 1 }) === 'unknown', 'an old cache row {name, amount} is unknown');
  ok(gradeOf({ name: 'x', rarity_name: 'uncommon' }) === 'uncommon', 'a row with only the name of its grade');
  ok(gradedRow({ id: 5, name: 'x', rarity: 200 }).cursed === true, 'cursed is flagged');
}
section('drawGradeAllows: by name, gear takes its plain grade only');
{
  const g = (rarity, name = 'short sword') => gradedRow({ id: 9, name, rarity });
  const gear = { gear: true };
  ok(drawGradeAllows(g(0), { item: 'short sword' }, gear).ok, 'normal gear: taken');
  for (const [r, n] of [[100, 'unidentified'], [1, 'uncommon'], [2, 'rare'], [4, 'legendary'], [200, 'cursed']])
    ok(!drawGradeAllows(g(r), { item: 'short sword' }, gear).ok, `${n} gear by name: left in the chest`);
  ok(!drawGradeAllows(g(null), { item: 'short sword' }, gear).ok, 'ungraded gear: left (an unread item is not a mundane item)');
  ok(drawGradeAllows(g(2, 'nerudite bow'), { item: 'nerudite bow' }, gear).ok && plainGradeOf('Nerudite Bow') === 'rare',
     'a nerudite bow is rare by CLASS (nerubow.kod:53): its plain grade, taken');
  ok(!drawGradeAllows(g(100, 'nerudite bow'), { item: 'nerudite bow' }, gear).ok, 'an unidentified nerudite bow is not');
  ok(drawGradeAllows(g(1), { item: 'short sword', magic: true }, gear).ok, 'magic: true -- a courier fetching a known magic item');
  ok(!drawGradeAllows(g(200), { item: 'short sword', magic: true }, gear).ok, 'never cursed, even asked for magic');
  ok(!drawGradeAllows(g(200), { item: 'short sword', grades: ['any'] }, gear).ok, 'nor with grades: any');
  ok(drawGradeAllows(g(100), { item: 'short sword', grades: ['unidentified'] }, gear).ok, 'an explicit grades list is exact');
  ok(!drawGradeAllows(g(0), { item: 'short sword', grades: ['uncommon'] }, gear).ok, '...in both directions');
  ok(drawGradeAllows(g(100, 'wand'), { item: 'wand' }, { gear: false }).ok, 'not gear (a wand by name): as before');
  ok(drawGradeAllows(g(null, 'herbs'), { item: 'herbs' }, { gear: false }).ok, 'reagents with no grade: as before');
}

// ------------------------------------------------------------------ 3. the cache
section('the cache keeps one row per object, its grade, and no object ids');
{
  const store = new StorageCache({ dir: scratch });
  store.writeChest('r18c2', { room: 714, object_id: 2578, by: 'test', items: [
    gradedRow({ id: 11, name: 'long sword', rarity: 0 }), gradedRow({ id: 12, name: 'long sword', rarity: 100 }),
    gradedRow({ id: 13, name: 'long sword', rarity: 1 }), gradedRow({ id: 14, name: 'herbs', amount: 30 }),
    { id: 15, name: 'long sword', amount: 1 } ] });
  const j = JSON.parse(readFileSync(join(scratch, 'chests', 'r18c2.json'), 'utf8'));
  ok(j.items.length === 5, 'five objects, five rows: a mixed-grade pile of one name does not collapse', JSON.stringify(j.items));
  ok(JSON.stringify(j.items.map(i => i.rarity_name ?? null)) === JSON.stringify(['normal', 'unidentified', 'uncommon', null, null]),
     'each keeps its own grade; one that came without a grade stays without', JSON.stringify(j.items));
  ok(j.items.every(i => typeof i.name === 'string' && i.amount >= 1), 'name and amount exactly as every old reader expects');
  ok(j.items.every(i => !('id' in i)), 'no object id is cached per row: an id is a handle a save renumbers');
  ok(gradeOf(j.items[3]) === 'unknown' && gradeOf(j.items[4]) === 'unknown', 'and an ungraded row reads back UNKNOWN');
  ok(JSON.stringify(chestCacheRow({ name: 'x', amount: 2 })) === JSON.stringify({ name: 'x', amount: 2 }), 'an ungraded row is byte-for-byte the old shape');
}

// ------------------------------------------------------------------ 4. the keeper
// A hall with chests; get/put move objects between a chest and the pack. `onGet(o)` may rewrite what arrives (a recycled
// id), `beforeGet` may start a save.
function fakeKeeper(chests, { onGet = null, beforeGet = null } = {}) {
  const notes = [], gets = [], puts = [];
  const objects = new Map(chests.map(ch => [ch.id, { id: ch.id, name: 'chest', nameRsc: ch.id, row: ch.row, col: ch.col }]));
  const c = {
    evSeq: 0, events: [], self: { row: 18, col: 4 }, me: { name: 'Tester' }, saveCount: 3, savePausedAt: null,
    room: { objects }, inventory: [{ id: 900, name: 'hammer', rarity: 0 }],
    rsc: { get: (r) => (objects.has(r) ? 'chest' : null) },
    requestInventory() {},
    contents(id) {
      const ch = chests.find(x => x.id === id);
      this.events.push({ seq: ++this.evSeq, kind: 'container', id, items: ch.items.map(i => ({ ...i })) });
    },
    getFromContainer(spec) {
      beforeGet?.(c);
      const id = typeof spec === 'object' ? spec.id : spec;
      gets.push(id);
      for (const ch of chests) {
        const i = ch.items.findIndex(x => x.id === id);
        if (i < 0) continue;
        const want = typeof spec === 'object' ? Number(spec.amount) : null;
        if (want && Number(ch.items[i].amount) > want) {          // a counted get splits the stack
          ch.items[i].amount -= want;
          c.inventory.push({ ...ch.items[i], id: 5000 + gets.length, amount: want });
          return;
        }
        const [o] = ch.items.splice(i, 1);
        c.inventory.push(onGet ? onGet({ ...o }) : { ...o });
        return;
      }
    },
    put(spec, into) {
      const id = typeof spec === 'object' ? spec.id : spec;
      puts.push(id);
      const i = c.inventory.findIndex(x => x.id === id);
      if (i >= 0) chests.find(x => x.id === into).items.push(c.inventory.splice(i, 1)[0]);
    },
    async waitFor({ since = 0, kinds = [] } = {}) { return { events: this.events.filter(e => e.seq > since && kinds.includes(e.kind)) }; },
  };
  const s = { name: 'Tester', need: () => c, client: c, world: { room: { num: 714 } },
    pacer: { submit: async (_kind, fn) => fn() }, walkTo: async () => ({}) };
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { s, name: 'Tester', policy: {}, note: (what, facts) => notes.push({ what, ...facts }), tradeFact: () => {},
    hallHere: () => ({ ok: true, room: 714 }), reachHallChests: async () => ({ ok: true, steps: [] }) });
  return { k, c, notes, gets, puts };
}
// The incident's chest: a plain short sword and an unidentified one, plus an uncommon long sword and some herbs.
const INCIDENT = () => [{ id: 2578, row: 18, col: 2, items: [
  { id: 51, name: 'short sword', rarity: 100 }, { id: 52, name: 'short sword', rarity: 0 },
  { id: 53, name: 'long sword', rarity: 1 }, { id: 54, name: 'herbs', amount: 40, rarity: 0 }] }];

section('by name: the unidentified short sword is never drawn, the plain one is');
{
  const { k, gets } = fakeKeeper(INCIDENT());
  const r = await k.hallWithdraw([{ item: 'short sword', amount: 2 }, { item: 'herbs', amount: 10 }], {});
  ok(!gets.includes(51), 'the unidentified short sword (#51) is never asked for', JSON.stringify(gets));
  ok(gets.includes(52) && r.took['short sword'] === 1 && r.short['short sword'] === 1, 'the plain one is taken; one short, said so', JSON.stringify(r.took));
  ok(r.diag['short sword'].left_by_grade?.unidentified >= 1, 'and the diag says one was left by grade', JSON.stringify(r.diag));
  ok(r.took.herbs === 10, 'herbs by name, unaffected', JSON.stringify(r.took));
}
section('by name with magic: true, an uncommon long sword is taken');
{
  const { k, gets } = fakeKeeper(INCIDENT());
  await k.hallWithdraw([{ item: 'long sword', amount: 1 }], {});
  ok(!gets.includes(53), 'by default, no');
  const f2 = fakeKeeper(INCIDENT());
  await f2.k.hallWithdraw([{ item: 'long sword', amount: 1, magic: true }], {});
  ok(f2.gets.includes(53), 'asked for magic, yes');
}

section('the reading comes back with ids, grades and its stamp');
let read0;
{
  const { k } = fakeKeeper(INCIDENT());
  read0 = await k.hallWithdraw([], {});
  const rows = read0.contents?.[0]?.items ?? [];
  ok(read0.contents?.length === 1 && rows.length === 4, 'one chest, four objects', JSON.stringify(read0.contents));
  ok(rows.find(x => x.id === 51)?.rarity_name === 'unidentified' && rows.find(x => x.id === 52)?.rarity_name === 'normal', 'each with its id and grade');
  ok(read0.chest_ids_as_of?.saves_seen === 3 && read0.chest_ids_as_of.saving === false, 'stamped with the save count it was read under', JSON.stringify(read0.chest_ids_as_of));
}

section('by id: exactly that object, verified by id, name and grade');
{
  const { k, c, gets } = fakeKeeper(INCIDENT());
  const rd = await k.hallWithdraw([], {});
  const r = await k.hallWithdraw([{ id: 52, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(JSON.stringify(gets) === '[52]', 'only #52 is asked for', JSON.stringify(gets));
  ok(r.took_ids?.length === 1 && r.took_ids[0].id === 52 && r.took_ids[0].grade === 'normal', 'took_ids says so', JSON.stringify(r));
  ok(c.inventory.some(x => x.id === 52) && !c.inventory.some(x => x.id === 51), 'the plain one is in the pack, the unidentified one is not');
  ok(!r.stopped && !r.chest_ids_stale, 'nothing stopped');
}
section('by id, the wrong grade asked for is refused in the chest');
{
  const { k, gets } = fakeKeeper(INCIDENT());
  const rd = await k.hallWithdraw([], {});
  const r = await k.hallWithdraw([{ id: 51, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(gets.length === 0 && r.refused_ids?.[0]?.id === 51 && /unidentified/.test(r.refused_ids[0].why), 'graded unidentified in the chest: refused', JSON.stringify(r.refused_ids));
  const r2 = await k.hallWithdraw([{ id: 51, item: 'short sword' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(gets.length === 0 && r2.refused_ids?.length === 1, 'and with no grade named, gear by id still takes only its plain grade');
}
section('rule 1: a save since the read voids every id');
{
  const { k, c, gets } = fakeKeeper(INCIDENT());
  const rd = await k.hallWithdraw([], {});
  c.saveCount++;                                  // a save ended since the read
  const r = await k.hallWithdraw([{ id: 52, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(gets.length === 0 && r.chest_ids_stale === true && /re-read/.test(r.stopped ?? ''), 'nothing drawn; chest_ids_stale; told to re-read', JSON.stringify(r));
  c.savePausedAt = Date.now();                    // a save running right now
  const fresh = await k.hallWithdraw([], {});
  ok(fresh.chest_ids_as_of?.saving === true, 'a reading taken DURING a save is stamped saving');
  c.savePausedAt = null;
  const r2 = await k.hallWithdraw([{ id: 52, grade: 'normal' }], { chestIdsAsOf: fresh.chest_ids_as_of });
  ok(gets.length === 0 && r2.chest_ids_stale, 'and its ids are never current');
  const r3 = await k.hallWithdraw([{ id: 52, grade: 'normal' }], {});
  ok(gets.length === 0 && /no chest_ids_as_of/.test(r3.stopped ?? ''), 'an id draw with no stamp is refused');
  const r4 = await k.hallWithdraw(['id:52'], {});
  ok(gets.length === 0 && r4.short_ids?.length === 1, '"id:N" is an id want too, never a name');
}
section('rule 1, inside the call: a save between the read and the get stops the draw');
{
  // A save begins while the id call's own chest read is in flight (the second `contents` of this fake: the first is
  // the reading the ids were picked from), so that read is stamped `saving`.
  const g = fakeKeeper(INCIDENT());
  const origContents = g.c.contents.bind(g.c);
  let reads = 0;
  g.c.contents = (id) => { origContents(id); if (++reads === 2) g.c.savePausedAt = Date.now(); };
  const rd2 = await g.k.hallWithdraw([], {});
  const r = await g.k.hallWithdraw([{ id: 52, item: 'short sword', grade: 'normal' }, { id: 54, item: 'herbs' }], { chestIdsAsOf: rd2.chest_ids_as_of });
  ok(r.chest_ids_stale === true && g.gets.length === 0 && /between the chest read and the get/.test(r.stopped ?? ''),
     'the read was stamped, the count moved before the get: nothing taken', JSON.stringify(r));
  // And a save that begins DURING the get: whatever arrived cannot be trusted by id; it goes back.
  const h = fakeKeeper(INCIDENT(), { beforeGet: c => { c.savePausedAt = Date.now(); } });
  const rd3 = await h.k.hallWithdraw([], {});
  const r3 = await h.k.hallWithdraw([{ id: 52, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd3.chest_ids_as_of });
  ok(r3.chest_ids_stale === true && h.puts.includes(52) && !(r3.took_ids ?? []).length && !!r3.stopped,
     'a save during the get: the arrival is put back, nothing counted as drawn', JSON.stringify(r3));
}
section('rule 2: an id that names something else now is refused');
{
  const { k, gets } = fakeKeeper(INCIDENT());
  const rd = await k.hallWithdraw([], {});
  const r = await k.hallWithdraw([{ id: 53, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(gets.length === 0 && /names "long sword"/.test(r.refused_ids?.[0]?.why ?? ''), 'id 53 is a long sword in the chest: refused, named', JSON.stringify(r.refused_ids));
  const r2 = await k.hallWithdraw([{ id: 999, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(r2.short_ids?.[0]?.id === 999, 'an id in no chest is short, with a reason', JSON.stringify(r2.short_ids));
}
section('rule 3: what arrives is judged by name and grade; anything else goes straight back and the draw stops');
{
  // A recycled handle: the get for #52 lands an unidentified piece under the same id.
  const { k, c, gets, puts } = fakeKeeper(INCIDENT(), { onGet: o => (o.id === 52 ? { ...o, rarity: 100 } : o) });
  const rd = await k.hallWithdraw([], {});
  const r = await k.hallWithdraw([{ id: 52, item: 'short sword', grade: 'normal' }, { id: 54, item: 'herbs' }], { chestIdsAsOf: rd.chest_ids_as_of });
  ok(puts.includes(52) && !c.inventory.some(x => x.id === 52), 'the wrong-graded piece is put straight back', JSON.stringify({ puts, inv: c.inventory }));
  ok(r.returned_ids?.[0]?.id === 52 && r.returned_ids[0].put_back === true, 'returned_ids says so', JSON.stringify(r.returned_ids));
  ok(!!r.stopped && !gets.includes(54) && !(r.took_ids ?? []).length, 'and the draw STOPS: the herbs are not drawn after it', JSON.stringify({ gets, stopped: r.stopped }));
  // A stray: the get for #52 brings a different object.
  const f2 = fakeKeeper(INCIDENT(), { onGet: o => (o.id === 52 ? { id: 77, name: 'scimitar', rarity: 0 } : o) });
  const rd2 = await f2.k.hallWithdraw([], {});
  const r2 = await f2.k.hallWithdraw([{ id: 52, item: 'short sword', grade: 'normal' }], { chestIdsAsOf: rd2.chest_ids_as_of });
  ok(f2.puts.includes(77) && r2.stopped && !(r2.took_ids ?? []).length, 'a different object arriving is put back too, and stops it', JSON.stringify(r2));
}

section('the plumbing carries the grade (source shape: the broker is not importable)');
{
  const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
  const broker = src('./m59-broker.mjs'), keeper = src('./m59-keeper-process.mjs'), client = src('./m59-client.mjs');
  const containerTool = broker.slice(broker.indexOf("name: 'container',"), broker.indexOf("name: 'container',") + 4000);
  ok(/gradedRow\(/.test(containerTool), 'the broker `container` tool maps rows through gradedRow');
  const contentsOp = keeper.slice(keeper.indexOf("case 'contents':"), keeper.indexOf("case 'contents':") + 2500);
  ok(/map\(gradedRow\)/.test(contentsOp), 'the keeper `contents` op does too');
  ok(/chest_ids_as_of/.test(keeper.slice(keeper.indexOf("case 'hall_withdraw':"), keeper.indexOf("case 'hall_withdraw':") + 900)),
     'the keeper `hall_withdraw` op passes the stamp');
  ok(/chest_ids_as_of: a\.chest_ids_as_of/.test(broker), 'the broker `hall_withdraw` tool passes the stamp');
  const emit = client.slice(client.indexOf("this.emit('container'"), client.indexOf("this.emit('container'") + 500);
  ok(/rarity: o\.rarity/.test(emit) && /icon_rsc/.test(emit), 'the client container event carries rarity and icon');
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nm59-chest-grade: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
