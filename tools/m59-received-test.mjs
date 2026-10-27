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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
