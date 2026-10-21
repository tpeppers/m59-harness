// THE GUARD FOR m59-worldbook.mjs — offline, opens no socket, writes only temp books.
//
//   node tools/m59-worldbook-test.mjs
//
// What must stay true: a monster, an item and a player are never NPCs; a seller is one even if
// no catalogue knows her; an NPC seen gone from his recorded room is GONE, not "still there";
// a travelling merchant's last list follows the PERSON; and a quiet keeper does not write every
// tick, but does write the moment the room's NPCs change.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNpc, applyRoom, applyShop, emptyBook, npcInfo, whoSells, roomInfo, readBook,
         createWorldObserver, observeRoom, _setKnownNames, REFRESH_MS } from './m59-worldbook.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${what}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);

_setKnownNames(['Maleval', 'Parrin Aragone', 'Frular']);
const PLAYER = 0x4, ATTACK = 0x8, GET = 0x10, OFFER = 0x200, BUY = 0x400;

// ---- what an NPC is -----------------------------------------------------------------------
ok(isNpc({ name: 'Morrigan', flags: BUY | OFFER }), 'a seller nobody catalogued is an NPC (flags)');
ok(isNpc({ name: 'Frular', flags: 0 }), 'a catalogued person with no shop flag is an NPC (name)');
ok(!isNpc({ name: 'fountain', flags: 0 }), 'an unflagged unknown thing is not');
ok(!isNpc({ name: 'orc', flags: ATTACK }), 'a monster is not');
ok(!isNpc({ name: 'Maleval', flags: PLAYER }), 'a PLAYER who calls himself Maleval is not');
ok(!isNpc({ name: 'sword', flags: GET }), 'an item is not');
ok(isNpc({ name: 'Maleval', can: ['offer', 'look'], is_player: false }), 'a broker look\'s `can` list works too');
ok(!isNpc({ name: 'Izzio', can: ['attack'], is_player: false }), '...and an attackable one is still not');

// ---- sightings ------------------------------------------------------------------------------
const t0 = 1_700_000_000_000;
const w = emptyBook();
eq(applyRoom(w, { agent: 'a', room: 53, objects: [{ name: 'Maleval', flags: OFFER, row: 2, col: 6 }, { name: 'rat', flags: ATTACK }], now: t0 }),
   ['Maleval'], 'the room yields Maleval and not the rat');
{
  const m = npcInfo(w, 'maleval', { now: t0 + 60_000 });
  ok(m.fresh && m.room === 53 && m.wanderer === 'maleval' && m.square.row === 2, 'fresh in 53, known as a wanderer, square kept');
  ok(!npcInfo(w, 'maleval', { now: t0 + 10 * 60_000 }).fresh, 'ten minutes on it is a rumour');
}
applyRoom(w, { agent: 'b', room: 53, objects: [], now: t0 + 120_000 });
{
  const m = npcInfo(w, 'maleval', { now: t0 + 130_000 });
  ok(m.room === null && m.last_room === 53 && m.left_at, 'his room seen empty: gone, last room kept');
  eq(m.absent_min_ago['53'], 0, 'and 53 is marked as seen empty');
}
applyRoom(w, { agent: 'c', room: 952, objects: [{ name: 'Maleval', flags: OFFER }], now: t0 + 3_600_000 });
{
  const m = npcInfo(w, 'maleval', { now: t0 + 3_600_000 });
  eq(m.history.map(h => h.room), [952, 53], 'history is newest first');
  ok(m.room === 952 && !m.left_at, 'a new sighting clears "left"');
}
applyRoom(w, { agent: 'c', room: 150, objects: [], now: t0 });
ok(npcInfo(w, 'parrin', { now: t0 })?.absent_min_ago?.['150'] === 0, 'a wanderer never seen still collects absences in his rooms');
eq(roomInfo(w, 952).npcs, ['Maleval'], 'the room remembers who stood in it');

// ---- shops follow the person ----------------------------------------------------------------
applyShop(w, { agent: 'a', room: 575, seller: 'Izzio', items: [{ name: 'plate armor', cost: 9000 }, { name: 'prism', cost: 5000 }], now: t0 });
applyShop(w, { agent: 'a', room: 593, seller: 'Izzio', items: [{ name: 'scimitar', cost: 800 }], now: t0 + 7_200_000 });
eq(npcInfo(w, 'izzio').last_shop.room, 593, 'the person\'s last list is the newest, wherever it was');
eq(whoSells(w, 'prism').map(s => [s.name, s.room]), [['Izzio', 575]], 'whoSells answers from the list that had it');
applyShop(w, { agent: 'a', room: 575, seller: '', items: [{ name: 'x' }], now: t0 });
eq(Object.keys(w.shops).length, 2, 'an unnamed seller is not a row');

// ---- the keeper's observer --------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'worldbook-'));
  const obs = createWorldObserver({ dir, agent: 'k' });
  const room = (objects, now) => ({ room: 802, objects, now });
  obs.tick(room([{ name: 'Maleval', flags: OFFER }], t0));
  ok(!readBook(dir).npcs.maleval, 'the first tick after a room change writes nothing (contents may be stale)');
  obs.tick(room([{ name: 'Maleval', flags: OFFER }], t0 + 5000));
  ok(readBook(dir).npcs.maleval?.room === 802, 'the second does');
  obs.tick(room([{ name: 'Maleval', flags: OFFER }], t0 + 10_000));
  eq(readBook(dir).npcs.maleval.at, t0 + 5000, 'an unchanged room inside a minute is not rewritten');
  obs.tick(room([{ name: 'Maleval', flags: OFFER }], t0 + 5000 + REFRESH_MS));
  eq(readBook(dir).npcs.maleval.at, t0 + 5000 + REFRESH_MS, 'a minute on, the sighting is re-stamped');
  obs.tick(room([], t0 + 6000 + REFRESH_MS));
  ok(readBook(dir).npcs.maleval.left === t0 + 6000 + REFRESH_MS, 'he goes: written at once');
  const list = { raw: {}, seller: 'Maleval', items: [{ name: 'spore burst', cost: 100 }] };
  obs.tick({ room: 802, objects: [], buyList: list, now: t0 + 7000 + REFRESH_MS });
  eq(readBook(dir).npcs.maleval.shop?.items?.[0]?.name, 'spore burst', 'an opened buy list is recorded against the person');
  ok(observeRoom(dir, { agent: 'z', room: 1, objects: [], now: t0 }), 'observeRoom writes when the lock is free');
}

console.log(`\nm59-worldbook: ${pass} assertion(s) passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
