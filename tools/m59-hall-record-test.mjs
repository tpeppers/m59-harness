#!/usr/bin/env node
// OFFLINE. `hallWithdraw` WRITES DOWN EVERY CHEST IN THE HALL IT IS STANDING IN, once per run.
//
//   node tools/m59-hall-record-test.mjs
//
// A hall visit is the only moment a chest can be read at all -- nothing is pushed -- and the draw
// read the chests it took from and kept nothing. So after the stash/deposit and the draws, every
// chest visible is read back through `refreshChestCache` and filed under the hall's ROOM NUMBER:
// `chests/713/<square>.json` for the Hall of the Slaughtered Command, the flat layout for 714.
// A call with `wants: []` and no stash or deposit is therefore a pure "read and record" errand.
//
// No socket, no keeper, no roster: a fake session in a scratch storage directory, and the REAL
// `hallWithdraw` and `refreshChestCache` off the Autopilot prototype.
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STORAGE_DIR is read at import time, so the scratch directory goes in first.
const scratch = mkdtempSync(join(tmpdir(), 'm59-hall-record-'));
process.env.M59_STORAGE_DIR = scratch;
process.env.M59_LEDGER_DIR = scratch;
const { Autopilot } = await import('./m59-autopilot.mjs');
const { StorageCache } = await import('./m59-storage.mjs');

let pass = 0, fail = 0;
const ok = (c, what, detail = '') => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}${detail ? ' — ' + detail : ''}`); } };
const section = s => console.log(`\n${s}`);

// Four chests where guildh13.kod:313-320 puts them, each with its own contents.
const CHESTS713 = [
  { id: 9101, row: 12, col: 24, items: [{ id: 1, name: 'elderberry', amount: 40 }] },
  { id: 9102, row: 13, col: 24, items: [] },
  { id: 9103, row: 12, col: 29, items: [{ id: 2, name: 'orc tooth', amount: 12 }, { id: 3, name: 'emerald', amount: 3 }] },
  { id: 9104, row: 13, col: 29, items: [{ id: 4, name: 'herbs', amount: 7 }] },
];

function fakeKeeper(roomNum, chests, { unreadable = new Set() } = {}) {
  const notes = [], asked = [];
  const objects = new Map(chests.map(ch => [ch.id, { id: ch.id, name: 'chest', nameRsc: ch.id, row: ch.row, col: ch.col }]));
  const c = {
    evSeq: 0, events: [], self: { row: 10, col: 26 }, me: { name: 'Tester' },
    room: { objects }, inventory: [],
    rsc: { get: (r) => (objects.has(r) ? 'chest' : null) },
    requestInventory() {},
    contents(id) {
      asked.push(id);
      const ch = chests.find(x => x.id === id);
      if (unreadable.has(id)) { this.events.push({ seq: ++this.evSeq, kind: 'message', text: 'You can\'t reach that.' }); return; }
      this.events.push({ seq: ++this.evSeq, kind: 'container', id, items: ch.items.map(i => ({ ...i })) });
    },
    async waitFor({ since = 0, kinds = [] } = {}) {
      return { events: this.events.filter(e => e.seq > since && kinds.includes(e.kind)) };
    },
  };
  const s = { name: 'Tester', need: () => c, client: c, world: { room: { num: roomNum } },
    pacer: { submit: async (_kind, fn) => fn() }, walkTo: async () => ({}) };
  const k = Object.create(Autopilot.prototype);
  Object.assign(k, { s, name: 'Tester', policy: {},
    note: (what, facts) => notes.push({ what, ...facts }),
    tradeFact: () => {},
    hallHere: () => ({ ok: true, room: roomNum }),
    reachHallChests: async () => ({ ok: true, chests: chests.length, steps: [] }) });
  return { k, c, notes, asked };
}

section('713: an empty errand reads and records every chest, under 713');
{
  const { k, asked, notes } = fakeKeeper(713, CHESTS713);
  const r = await k.hallWithdraw([], {});
  ok(r.ok === true, 'the run succeeds', JSON.stringify(r));
  ok(r.chests === 4, 'four chests seen');
  ok(JSON.stringify([...r.recorded].sort()) === JSON.stringify(['r12c24', 'r12c29', 'r13c24', 'r13c29']),
     'all four recorded, by square', JSON.stringify(r.recorded));
  ok(asked.length === 4 && new Set(asked).size === 4, 'each chest read exactly once', JSON.stringify(asked));
  for (const ch of CHESTS713) {
    const path = join(scratch, 'chests', '713', `r${ch.row}c${ch.col}.json`);
    ok(existsSync(path), `chests/713/r${ch.row}c${ch.col}.json written`);
    if (!existsSync(path)) continue;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    ok(j.room === 713, `...filed under room 713, not an object id`, JSON.stringify(j.room));
    ok(JSON.stringify(j.items) === JSON.stringify(ch.items.map(i => ({ name: i.name, amount: i.amount }))),
       `...with what the chest held`, JSON.stringify(j.items));
  }
  // An EMPTY chest is a reading too: "empty" read off the chest is a fact, unlike "would not say".
  const store = new StorageCache({ dir: scratch });
  const read = store.readChest('r13c24', 713);
  ok(read && Array.isArray(read.items) && read.items.length === 0, 'the empty chest reads back as an empty list', JSON.stringify(read));
  ok(store.allChests({ room: 713 }).length === 4, 'and the store lists four chests for 713',
     JSON.stringify(store.allChests({ room: 713 }).map(x => x.slot ?? x.key)));
  ok(!existsSync(join(scratch, 'chests', 'r12c24.json')), 'nothing leaked into the flat (714) layout');
  ok(notes.some(n => n.what === 'hall withdrawal for an errand' && n.recorded?.length === 4), 'the note says what was recorded');
}

section('a chest that will not answer is skipped, never recorded as empty');
{
  const { k } = fakeKeeper(713, CHESTS713.map(ch => ({ ...ch, items: [] })), { unreadable: new Set([9103]) });
  // Leaves the previous reading of r12c29 in place: 12 orc teeth and 3 emeralds.
  const before = JSON.parse(readFileSync(join(scratch, 'chests', '713', 'r12c29.json'), 'utf8'));
  const r = await k.hallWithdraw([], {});
  ok(!r.recorded.includes('r12c29'), 'the unreadable chest is not in `recorded`', JSON.stringify(r.recorded));
  ok(r.recorded.length === 3, 'the other three are');
  const after = JSON.parse(readFileSync(join(scratch, 'chests', '713', 'r12c29.json'), 'utf8'));
  ok(JSON.stringify(after.items) === JSON.stringify(before.items), 'and its last good reading stands', JSON.stringify(after.items));
}

section('714 keeps the flat layout');
{
  const { k } = fakeKeeper(714, [{ id: 9201, row: 18, col: 2, items: [{ id: 5, name: 'mushroom', amount: 9 }] }]);
  const r = await k.hallWithdraw([], {});
  ok(r.recorded.length === 1 && r.recorded[0] === 'r18c2', 'the one chest recorded', JSON.stringify(r.recorded));
  ok(existsSync(join(scratch, 'chests', 'r18c2.json')), 'chests/r18c2.json, the layout every 714 reader knows');
}

section('a run that never reached the chests records nothing');
{
  const { k, asked } = fakeKeeper(713, CHESTS713);
  k.reachHallChests = async () => ({ ok: false, why: 'guild door 5 could not be crossed', steps: [] });
  const r = await k.hallWithdraw([], {});
  ok(r.ok === false && asked.length === 0, 'refused before a single chest is asked', JSON.stringify(r));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
