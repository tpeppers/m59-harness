// Offline guard for m59-item-signature.mjs: an unidentified wand or scroll named by its ICON RESOURCE ID.
//
//   node tools/m59-item-signature-test.mjs
//
// Pinned: the id names the class even when eleven wands share one bitmap; a file with two classes on
// one icon string is left out, never guessed; nothing is renamed without the private naming file, an
// identified item is never renamed, and only the bare unidentified names are; the broker's inventory
// rows carry `identified_as`. Against this machine's real resource files when they are present: the
// hold wand, the earthquake scroll, and the two classes measured on prod 2026-10-11.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIconTable, identifiedAs, identificationNames, itemName, iconTable } from './m59-item-signature.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

const cls = (name, file, icon, parent) => ({ name, file: `kod/x/${file}.kod`,
  chain: [name, parent, 'SpellItem', 'PassiveItem', 'Item', 'Object'],
  resources: { [`${name}_label_name_rsc`]: { kind: 'string', value: name.toLowerCase() },
               [`${name}_icon_rsc`]: { kind: 'file', value: icon } } });
const classes = {
  holdwand: cls('HoldWand', 'holdw', 'wand6.bgf', 'Wand'),
  blindwand: cls('BlindWand', 'blindw', 'wand6.bgf', 'Wand'),
  earthquakescroll: cls('EarthquakeScroll', 'earthscl', 'scr08.bgf', 'Scroll'),
  twina: cls('TwinA', 'twins', 'same.bgf', 'Wand'),
  twinb: cls('TwinB', 'twins', 'same.bgf', 'Wand'),
  notitem: { name: 'Room', file: 'kod/room.kod', chain: ['Room', 'Object'], resources: { Room_icon_rsc: { kind: 'file', value: 'r.bgf' } } },
};
const files = [
  { file: 'holdw.rsc', entries: [[30478, 'wand of immobilization'], [30479, 'wand6.bgf'], [30480, 'crackles']] },
  { file: 'blindw.rsc', entries: [[30475, 'wand of blindness'], [30476, 'wand6.bgf']] },
  { file: 'earthscl.rsc', entries: [[30439, 'scroll of earthquake'], [30440, 'scr08.bgf']] },
  { file: 'twins.rsc', entries: [[1, 'same.bgf'], [2, 'same.bgf']] },
  { file: 'room.rsc', entries: [[9, 'r.bgf']] },
];
const table = buildIconTable(files, classes);
const names = { HoldWand: 'hold wand', EarthquakeScroll: 'earthquake scroll' };

ok('one bitmap, many classes: the icon ID names the class', () => {
  assert.equal(table.get(30479)?.class, 'HoldWand');
  assert.equal(table.get(30476)?.class, 'BlindWand');
  assert.equal(table.get(30440)?.class, 'EarthquakeScroll');
});

ok('two classes on one icon string in one file: left out, never guessed; non-items ignored', () => {
  assert.equal(table.get(1), undefined);
  assert.equal(table.get(2), undefined);
  assert.equal(table.get(9), undefined);
});

ok('a bare "wand" with the hold wand icon is a hold wand; with the blind wand icon it is not named', () => {
  assert.equal(identifiedAs({ name: 'wand', icon_rsc: 30479 }, { table, names }), 'hold wand');
  assert.equal(identifiedAs({ name: 'wand', icon_rsc: 30476 }, { table, names }), null, 'BlindWand is not in the naming file');
  assert.equal(identifiedAs({ name: 'scroll', icon_rsc: 30440 }, { table, names }), 'earthquake scroll');
});

ok('silence is the old behaviour, and an identified or non-generic name is never renamed', () => {
  assert.equal(identifiedAs({ name: 'wand', icon_rsc: 30479 }, { table, names: {} }), null);
  assert.equal(identifiedAs({ name: 'wand of immobilization', icon_rsc: 30479 }, { table, names }), null);
  assert.equal(identifiedAs({ name: 'hold wand', icon_rsc: 30479 }, { table, names }), null);
  assert.equal(identifiedAs({ name: 'wand' }, { table, names }), null, 'no icon, no claim');
});

ok('itemName prefers identified_as and falls back to the wire name', () => {
  assert.equal(itemName({ name: 'wand', identified_as: 'hold wand' }), 'hold wand');
  assert.equal(itemName({ name: 'herb' }), 'herb');
});

ok('the naming file: read when present, {} when missing or broken, names lower-cased', () => {
  const d = mkdtempSync(join(tmpdir(), 'm59-ident-'));
  const f = join(d, 'item-identification.json');
  assert.deepEqual(identificationNames(f), {});
  writeFileSync(f, JSON.stringify({ name_unidentified_as: { HoldWand: 'Hold Wand', Bad: 3 } }));
  assert.deepEqual(identificationNames(f), { HoldWand: 'hold wand' });
  writeFileSync(f, '{ not json');
  assert.deepEqual(identificationNames(f), {});
});

ok('the broker puts identified_as on every inventory row', () => {
  const src = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("identified_as: identifiedAs({ name: c.rsc.get(o.nameRsc), icon_rsc: o.iconRsc }) ?? undefined,"));
  const fs = readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8');
  assert.ok(fs.includes("export { itemName, identifiedAs, classOfIcon } from './m59-item-signature.mjs';"));
});

// Against the real resource files, when this machine has them.
const real = iconTable();
if (real.size) {
  ok(`this machine's resources (${real.size} ids): hold wand, earthquake scroll, and prod's two measured classes`, () => {
    const at = cls => [...real].find(([, v]) => v.class === cls)?.[0];
    assert.ok(at('HoldWand') && at('EarthquakeScroll') && at('LightningWand') && at('MartyrScroll'));
    // Measured on prod 2026-10-11: bare "wand" at 30513 decoded yellow (lightning), bare "scroll" at 30461 grey (martyr).
    assert.equal(real.get(30513)?.class, 'LightningWand');
    assert.equal(real.get(30461)?.class, 'MartyrScroll');
    const wands = [...real.values()].filter(v => v.chain.includes('Wand'));
    assert.equal(new Set(wands.map(v => v.class)).size, wands.length, 'every wand class has its own id');
  });
} else console.log('skip: no resource files on this machine');

console.log(`\n${n} passed`);
