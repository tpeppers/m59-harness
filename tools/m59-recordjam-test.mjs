#!/usr/bin/env node
// RECORD JAM, OFFLINE. Safe any time — no socket, no roster, no broker:
//
//   node tools/m59-recordjam-test.mjs
//
// The recorder's decisions are pure functions and this drives them: how a region is read,
// how a run of samples collapses to "what stood still" and "what wiggled", that a player is
// one unit however many observers report it while the observer's own body still counts,
// that names come out as roles unless asked otherwise, and that the ground under the region
// is measured off the real BSP — against the Sewers of Barloque, which is the jam this was
// written for.
import { readFileSync, readdirSync } from 'node:fs';
import { parseRegion, regionAround, inRegion, makeRedactor, compress, unitKey, kindOf,
         floorExtents, buildJam, summarise, FORMAT } from './m59-recordjam.mjs';
import { sharedRoomGeometry, KOD_FINENESS } from './m59-roo.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

console.log('\nthe region');
{
  ok('c1,r1-c2,r2 is read col,row like every square in this repository',
     JSON.stringify(parseRegion('38,25-48,29')) === JSON.stringify({ c1: 38, r1: 25, c2: 48, r2: 29 }));
  ok('and either corner may come first', JSON.stringify(parseRegion('48,29-38,25')) === JSON.stringify({ c1: 38, r1: 25, c2: 48, r2: 29 }));
  ok('a malformed region is refused, not guessed', parseRegion('27,42') === null && parseRegion('') === null);
  ok('around a square with a radius', JSON.stringify(regionAround(43, 27, 2)) === JSON.stringify({ c1: 41, r1: 25, c2: 45, r2: 29 }));
  ok('and never below zero', regionAround(1, 1, 5).c1 === 0 && regionAround(1, 1, 5).r1 === 0);
  const reg = parseRegion('38,25-48,29');
  ok('a unit on the edge is in', inRegion({ col: 48, row: 29 }, reg) && inRegion({ col: 38, row: 25 }, reg));
  ok('one square past it is out', !inRegion({ col: 49, row: 27 }, reg) && !inRegion({ col: 43, row: 30 }, reg));
  ok('no region means everything', inRegion({ col: 999, row: 999 }, null));
}

console.log('\ncompression: what stood still and what wiggled');
{
  const rat = (id, x, y) => ({ id, name: 'giant rat', is_player: false, flags: 9, col: Math.floor(x / 64), row: Math.floor(y / 64), x, y });
  const who = (name, x, y) => ({ name, is_player: true, col: Math.floor(x / 64), row: Math.floor(y / 64), x, y });
  const samples = [
    { t_ms: 0,    units: [rat(1, 2784, 1760), rat(2, 2848, 1760), who('Rowlf', 2800, 1750), who('Fozzie', 2864, 1747)] },
    { t_ms: 1000, units: [rat(1, 2784, 1760), rat(2, 2848, 1760), who('Rowlf', 2800, 1746), who('Fozzie', 2864, 1747)] },
    { t_ms: 2000, units: [rat(1, 2784, 1760), rat(2, 2848, 1760), who('Rowlf', 2832, 1745), who('Fozzie', 2864, 1747)] },
    { t_ms: 3000, units: [rat(1, 2784, 1760), rat(2, 2848, 1760), who('Rowlf', 2832, 1745), who('Fozzie', 2864, 1747)] },
    { t_ms: 4000, units: [rat(1, 2784, 1760),                     who('Rowlf', 2800, 1747), who('Fozzie', 2864, 1747)] },
  ];
  const { static: still, moving } = compress(samples.map(s => ({ ...s, units: s.units.map(u => ({ ...u, key: unitKey(u) })) })));
  ok('two rats and one parked player are static', still.length === 3 && still.filter(u => u.kind === 'monster').length === 2);
  ok('a static unit is one line with a position and how many samples saw it',
     still.find(u => u.name === 'Fozzie')?.seen === 5 && still.find(u => u.name === 'Fozzie')?.x === 2864);
  ok('a monster that vanished mid-recording is still one static line, seen fewer times',
     still.find(u => u.kind === 'monster' && u.x === 2848)?.seen === 4);
  const rowlf = moving.find(u => u.name === 'Rowlf');
  ok('the wiggler is the only mover', moving.length === 1 && !!rowlf);
  ok('its trace keeps only CHANGES of position, with when each was first seen',
     rowlf.points.length === 4 && rowlf.points.map(p => p.t_ms).join(',') === '0,1000,2000,4000',
     JSON.stringify(rowlf.points));
  ok('static units are ordered by row then x, so a picket line reads left to right',
     still.map(u => u.x).join(',') === '2784,2848,2864');
}

console.log('\none body, however many saw it');
{
  const p = { name: 'Rowlf', is_player: true, col: 43, row: 27, x: 2800, y: 1750 };
  const q = { name: 'ROWLF', is_player: true, col: 43, row: 27, x: 2800, y: 1750 };
  ok('a player is keyed by name, case-folded, so two observers do not make two of them', unitKey(p) === unitKey(q));
  const m = { id: 7, name: 'giant rat', is_player: false, flags: 9 };
  const m2 = { id: 8, name: 'giant rat', is_player: false, flags: 9 };
  ok('a monster is keyed by object id, so two rats with one name stay two', unitKey(m) !== unitKey(m2));
  ok('and identity does not depend on what the flags say the thing is',
     unitKey({ id: 7, flags: 9 }) === unitKey({ id: 7, flags: 16 }) && unitKey({ id: 7 }) === unitKey({ id: 7, flags: 9 }));
  // THE FORK THE FIRST FIXTURE HAD: a unit keyed before redaction in one sample and after
  // it in the next came out as two units, one seen 2x and one seen 24x.
  const twice = buildJam({ room: { num: 108, name: 'x' }, region: null, seconds: 1, intervalMs: 1000, observers: [], geometry: null,
    redact: makeRedactor(new Set(['Rowlf'])),
    samples: [ { at: 0, t_ms: 0,    units: [{ name: 'Rowlf', is_player: true, col: 43, row: 27, x: 2800, y: 1750 }] },
               { at: 0, t_ms: 1000, units: [{ key: 'p:rowlf', name: 'Rowlf', is_player: true, col: 43, row: 27, x: 2800, y: 1750 }] } ] });
  ok('a body seen with and without a precomputed key, before and after redaction, is ONE unit',
     twice.static.length === 1 && twice.static[0].seen === 2 && twice.static[0].name === 'player A', JSON.stringify(twice.static));
}

console.log('\nwhat a unit is comes from the flags, not the name');
{
  ok('attackable and not a player is a monster', kindOf({ flags: 9 }) === 'monster');
  ok('a player flag word is a player, whatever else it says', kindOf({ flags: 8717 }) === 'player' && kindOf({ is_player: true, flags: 9 }) === 'player');
  ok('an emerald on the square is an ITEM, not a body a test would route around', kindOf({ name: 'emerald', flags: 16 }) === 'item');
  ok('an observer\'s own body, which carries no flag word, is not mistaken for an item', kindOf({ is_player: true }) === 'player');
  const still = compress([{ t_ms: 0, units: [
    { id: 1, name: 'emerald', flags: 16, col: 39, row: 27, x: 2528, y: 1760 },
    { id: 2, name: 'giant rat', flags: 9, col: 40, row: 27, x: 2579, y: 1755 } ] }]).static;
  ok('so the recording tells the two apart', still.find(u => u.name === 'emerald')?.kind === 'item' && still.find(u => u.name === 'giant rat')?.kind === 'monster');
}

console.log('\nnames come out as roles');
{
  const redact = makeRedactor(new Set(['Rowlf', 'Fozzie']));
  ok('one of ours becomes a player role', redact('Rowlf', true) === 'player A');
  ok('stably — the same name gets the same role', redact('rowlf', true) === 'player A' && redact('Fozzie', true) === 'player B');
  ok('a stranger gets a stranger role, so a real person is not committed either', redact('Spartacus', true) === 'stranger A');
  ok('a monster keeps its name — a giant rat is not anybody', redact('giant rat', false) === 'giant rat');
  const keep = makeRedactor(new Set(['Rowlf']), { keepNames: true });
  ok('--names keeps them', keep('Rowlf', true) === 'Rowlf');
}

console.log('\nthe ground under the region, off the real BSP');
{
  const map = JSON.parse(readFileSync('substrate/m59-map.json', 'utf8'));
  const room = map.rooms['108'];
  ok('the Sewers of Barloque are in the map', room?.name === 'The Sewers of Barloque' && room.rooFile === 'barlsew.roo');
  const geo = sharedRoomGeometry(room);
  const region = parseRegion('38,25-48,29');
  const g = floorExtents(geo, region);
  const c43 = g.floor_y_by_col[43], r27 = g.floor_x_by_row[27];
  ok('every column of the region is measured', Object.keys(g.floor_y_by_col).length === 11 && Object.keys(g.floor_x_by_row).length === 5);
  ok('column 43 has floor across row 27 — where the rats stood',
     c43.lo != null && c43.lo <= 27 * KOD_FINENESS + 32 && c43.hi >= 27 * KOD_FINENESS + 32, JSON.stringify(c43));
  ok('and row 27 has floor across column 43', r27.lo != null && r27.lo <= 43 * KOD_FINENESS && r27.hi >= 44 * KOD_FINENESS, JSON.stringify(r27));
  ok('extents are in fine units, not squares', c43.hi - c43.lo >= KOD_FINENESS / 2);

  const samples = [{ at: Date.now(), t_ms: 0, units: [
    { name: 'giant rat', id: 1, is_player: false, flags: 9, col: 43, row: 27, x: 2784, y: 1760 },
    { name: 'Rowlf', is_player: true, col: 43, row: 27, x: 2800, y: 1750 } ] }];
  const jam = buildJam({ room, region, samples, redact: makeRedactor(new Set(['Rowlf'])), seconds: 5, intervalMs: 1000,
                         observers: ['Rowlf'], geometry: g, fleet: 'test' });
  ok('a jam carries its format, room, roo, region, ground and units', jam.format === FORMAT && jam.room.roo === 'barlsew.roo' &&
     jam.region.c2 === 48 && jam.geometry === g && jam.static.length === 2);
  ok('and no character name', !JSON.stringify(jam).includes('Rowlf') && jam.observers[0] === 'player A');
  const text = summarise(jam);
  ok('the summary names the room, lists the static units and the floor extents',
     text[0].includes('Sewers') && text.some(l => /giant rat/.test(l)) && text.some(l => /floor y-extent/.test(l)));
}

console.log('\nthe fixtures on disk stay redacted and well-formed');
{
  // Every committed jam is a picture of a real room with real people in it, and the rule
  // that nothing naming a character is committed has no exception for a file that was
  // correct when it was written. So: every unit is a monster, an item, or a role.
  const dir = new URL('./fixtures/', import.meta.url);
  const jams = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => ({ f, j: JSON.parse(readFileSync(new URL(f, dir), 'utf8')) }))
    .filter(({ j }) => j.format === FORMAT);
  ok('there is at least one jam fixture (the sewer picket line)', jams.some(({ f }) => f === 'sewers-108-row27.json'));
  ok('and the spider trap is the second', jams.some(({ f }) => f === 'spidertrap1.json'));
  const role = /^(player|stranger) [A-Z]+$/;
  const units = jams.flatMap(({ f, j }) => [...(j.static ?? []), ...(j.moving ?? [])].map(u => ({ f, u })));
  ok('every player in every fixture is a role, never a name',
     units.filter(({ u }) => u.kind === 'player').every(({ u }) => role.test(u.name)) && units.some(({ u }) => u.kind === 'player'),
     JSON.stringify(units.filter(({ u }) => u.kind === 'player' && !role.test(u.name)).map(({ f, u }) => f + ':' + u.name)));
  ok('every observer too', jams.every(({ j }) => (j.observers ?? []).every(o => role.test(o))));
  ok('and every fixture carries the floor under its region, measured, not the coarse grid',
     jams.every(({ j }) => Object.keys(j.geometry?.floor_y_by_col ?? {}).length > 0));
  const trap = jams.find(({ f }) => f === 'spidertrap1.json')?.j;
  ok('the spider trap records the subject as a role with its vitals, load and vigor, on its square',
     !!trap && role.test(trap.subject?.name) && trap.subject.position?.col === 16 && trap.subject.position?.row === 45
     && trap.subject.vigor_at_capture === 10 && trap.subject.carry?.weight_max === 2700);
  ok('with the black spider that sat on the line three squares west of it',
     !!trap && trap.static.some(u => u.name === 'black spider' && u.col === 13 && u.row === 44));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
