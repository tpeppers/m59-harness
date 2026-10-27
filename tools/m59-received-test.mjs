#!/usr/bin/env node
// A DELIVERY IS NOT A SPARE -- offline, no socket, no roster.
//
//   node tools/m59-received-test.mjs
//
// Prod, 2026-10-27: six maces delivered to the dedication desk were dropped six seconds after a keeper handoff by the
// field weapon cap, because the new keeper could not know they had just arrived. What this pins (m59-received.mjs and
// the keeper's fieldSpareWeapons / noteReceivedGoods):
//   * arrivals are counted by the pack, not the offer (a cancelled trade arrives nothing);
//   * the record is on disk, so a new keeper process reads it; old rows age out of the protection window;
//   * the field cap leaves delivered copies alone, and enchanted weapons, and still caps everything else;
//   * a trade we RECEIVED that ended with the pack richer is recorded by the pass; one we GAVE is not.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.M59_RECEIVED_DIR = mkdtempSync(join(tmpdir(), 'm59-received-'));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const R = await import('./m59-received.mjs');

console.log('what arrived');
const before = new Map([['mace', 0], ['herbs', 10]]), after = new Map([['mace', 6], ['herbs', 10]]);
ok('six maces offered and six in the pack: six arrived', JSON.stringify(R.arrivedFrom([{ name: 'mace' }], before, after)) === '[{"name":"mace","amount":6}]');
ok('a cancelled trade (the pack unchanged) arrived nothing', R.arrivedFrom([{ name: 'mace' }], before, before).length === 0);
const now = 10_000_000;
R.noteReceived('hk3', [{ name: 'Mace', amount: 6 }], { from: 'Zheng He', now });
ok('the record is on disk, read by a new process', R.protectedReceived('hk3', { now: now + 60_000 }).get('mace') === 6);
ok('outside the window it no longer protects', !R.protectedReceived('hk3', { now: now + R.RECEIVED_PROTECT_MS + 1 }).has('mace'));

console.log('the field cap');
const { Autopilot } = await import('./m59-autopilot.mjs');
function keeper(items, { name = 'hk3', maxWeapons = 1, magicIds = [] } = {}) {
  const c = { inventory: items.map((x, i) => ({ id: 100 + i, nameRsc: x, amount: 0 })), rsc: { get: k => k },
              equipment: () => ({ known: true, equipped: [] }) };
  return Object.assign(Object.create(Autopilot.prototype), { s: { name, client: c }, policy: { maxWeapons },
    protectedItemNames: () => ['long sword'], weaponMagicBook: () => ({ keepIds: () => new Set(magicIds) }) });
}
{
  R.noteReceived('hk3b', [{ name: 'mace', amount: 6 }], { now: Date.now() });
  const spares = keeper(['mace', 'mace', 'mace', 'mace', 'mace', 'mace', 'hammer', 'hammer'], { name: 'hk3b' }).fieldSpareWeapons();
  ok('the six delivered maces are not spares; the two hammers still are', spares.length === 2 && spares.every(o => o.nameRsc === 'hammer'),
     spares.map(o => o.nameRsc).join(','));
  const none = keeper(['mace', 'mace', 'hammer'], { name: 'nobody' }).fieldSpareWeapons();
  ok('with no delivery, everything not protected is a spare as before', none.length === 3);
  const magic = keeper(['mace', 'hammer'], { name: 'nobody', magicIds: [100] }).fieldSpareWeapons();
  ok('a weapon the reading book knows is enchanted is never a spare', magic.length === 1 && magic[0].nameRsc === 'hammer');
}

console.log('the pass records a trade we received');
{
  let seq = 0; const events = [];
  const c = { get evSeq() { return seq; }, inventory: [], rsc: { get: k => k },
              eventsSince: since => events.filter(e => e.seq > since) };
  const notes = [];
  const k = Object.assign(Object.create(Autopilot.prototype), { s: { name: 'desk1', client: c }, note: (w, d) => notes.push({ w, d }) });
  k.noteReceivedGoods();                                         // first sight: a baseline, nothing recorded
  c.inventory.push(...[0, 1, 2].map(i => ({ id: 200 + i, nameRsc: 'mace', amount: 0 })));
  events.push({ seq: ++seq, kind: 'trade-ended', was: { role: 'recipient', withName: 'Zheng He', theirs: [{ name: 'mace' }] } });
  k.noteReceivedGoods();
  ok('three maces received by trade are on the record', R.protectedReceived('desk1').get('mace') === 3 && notes.some(n => n.w === 'received by trade'));
  events.push({ seq: ++seq, kind: 'trade-ended', was: { role: 'giver', withName: 'X', theirs: [{ name: 'hammer' }] } });
  c.inventory.push({ id: 300, nameRsc: 'hammer', amount: 0 });
  k.noteReceivedGoods();
  ok('a trade we were not the receiver of records nothing', !R.protectedReceived('desk1').has('hammer'));
}

console.log('one rule for every path that gives, sells, ejects or drops');
{
  // Prod 2026-10-27: Piggy's only dedicated mace, in the pack while he wielded a hammer, was given to a fleet-mate's
  // weapon demand by the sharing rule -- twice in 32 seconds.
  R.noteReceived('t14', [{ name: 'axe', amount: 1 }], { now: Date.now() });
  const c = { inventory: [{ id: 12365, nameRsc: 'mace', amount: 0 }, { id: 2, nameRsc: 'mace', amount: 0 }, { id: 3, nameRsc: 'axe', amount: 0 }],
              rsc: { get: k => k }, room: { objects: new Map([[9, { id: 9, nameRsc: 'Bunsen', flags: 0x80 }]]) } };
  const k = Object.assign(Object.create(Autopilot.prototype), { s: { name: 't14', client: c, need: () => c },
    weaponMagicBook: () => ({ keepIds: () => new Set([12365]) }) });
  const held = k.heldBackIds(c);
  ok('the enchanted mace and the delivered axe are held back; the plain mace is not', held.has(12365) && held.has(3) && !held.has(2), [...held].join(','));
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('a gift never takes a held-back item', /filter\(o => !held\.has\(Number\(o\.id\)\) && this\.matchesKind/.test(src));
  ok('loot ejection never offers one', /const items = \(plan\?\.items \?\? \[\]\)\.filter\(i => !heldBack\.has/.test(src));
  ok('a market visit never counts one as sellable', /i\.sale_amount > 0 && !heldBack\.has\(Number\(i\.id\)\)/.test(src));
  const { readFileSync } = await import('node:fs');
  const kp = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  ok('and the counter\'s sell_all never offers one', /\.items\.filter\(i => !\(autopilot\?\.heldBackIds\?\.\(\) \?\? new Set\(\)\)\.has/.test(kp));
}

console.log('a handoff keeps the weapon readings');
{
  // Prod 2026-10-27: after a handoff Piggy fought on a plain hammer, his dedicated mace reading "unknown" until a look.
  const { WeaponMagicBook } = await import('./m59-weapon-magic.mjs');
  const old = new WeaponMagicBook();
  old.readings.set(12365, { name: 'mace', class: 'enchanted', bypasses_nonmagic: true, made: false, at: Date.now(), source: 'look' });
  old.readings.set(500, { name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false, at: Date.now(), source: 'look' });
  const saved = JSON.parse(JSON.stringify(old.toJSON()));
  const fresh = new WeaponMagicBook().load(saved);
  const pack = [{ id: 12365, name: 'mace' }, { id: 500, name: 'hammer' }];
  const sum = fresh.summary(pack);
  ok('the new keeper believes the old keeper\'s reading from its first fight', sum.weapons.find(w => w.id === 12365)?.bypasses_nonmagic === true);
  ok('and queues it for a fresh look anyway', fresh.needsLook(pack).some(i => i.id === 12365));
  fresh.reconcile([{ id: 12365, name: 'hammer' }]);
  ok('an id that now names another item drops the carried reading', !fresh.readings.has(12365));
  const stale = new WeaponMagicBook().load({ readings: [[1, { name: 'mace', class: 'enchanted', at: Date.now() - 3 * 3_600_000 }]] });
  ok('an old saved reading is not loaded', !stale.readings.has(1));
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the keeper loads them at start and saves them after every sweep', /this\._weaponMagic\.load\(JSON\.parse/.test(src) && /this\._weaponMagicBusy = false; this\.saveWeaponMagic\(\);/.test(src));
}

console.log('a server save renumbers the pack; the dedicated weapon keeps its protection');
{
  // Prod 2026-10-27: the 05:59:59 save renumbered every id; Clifford's keeper dropped his dedicated mace at 06:16:02.
  const { WeaponMagicBook } = await import('./m59-weapon-magic.mjs');
  const book = new WeaponMagicBook();
  book.readings.set(100, { name: 'mace', class: 'enchanted', bypasses_nonmagic: true, made: false, at: Date.now(), source: 'look' });
  book.readings.set(101, { name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false, at: Date.now(), source: 'look' });
  book.reconcile([{ id: 900, name: 'mace' }, { id: 901, name: 'hammer' }]);           // same pack, new ids
  ok('the one mace after the save carries the enchanted reading', book.readings.get(900)?.bypasses_nonmagic === true && book.keepIds().has(900));
  ok('and a look confirms it next sweep', book.needsLook([{ id: 900, name: 'mace' }]).length === 1);
  ok('a mundane reading does not follow its name', !book.readings.has(901));
  const two = new WeaponMagicBook();
  two.readings.set(100, { name: 'mace', class: 'enchanted', bypasses_nonmagic: true, made: false, at: Date.now(), source: 'look' });
  two.reconcile([{ id: 900, name: 'mace' }, { id: 902, name: 'mace' }]);
  ok('two maces and one reading: both protected as unknown until a look tells them apart',
     two.keepIds().has(900) && two.keepIds().has(902) && two.readings.get(900)?.class === 'unknown');
  const c = { inventory: [{ id: 900, nameRsc: 'mace', amount: 0 }, { id: 901, nameRsc: 'hammer', amount: 0 }, { id: 903, nameRsc: 'hammer', amount: 0 }],
              rsc: { get: k => k }, equipment: () => ({ known: true, equipped: [] }) };
  const fresh = new WeaponMagicBook();
  fresh.readings.set(100, { name: 'mace', class: 'enchanted', bypasses_nonmagic: true, made: false, at: Date.now(), source: 'look' });
  const k = Object.assign(Object.create(Autopilot.prototype), { s: { name: 'renumbered', client: c }, policy: { maxWeapons: 1 },
    protectedItemNames: () => [], weaponMagicBook: () => fresh });
  const spares = k.fieldSpareWeapons();
  ok('the field cap, asked right after the save and before any sweep, does not drop the mace',
     !spares.some(o => o.nameRsc === 'mace'), spares.map(o => o.nameRsc).join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
