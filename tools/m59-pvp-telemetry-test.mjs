#!/usr/bin/env node
// Offline guard for the PvP telemetry: tools/m59-pvp-telemetry.mjs, the client's action tap, the
// combat-mode tee that writes actions-<day>.jsonl, and the /pvp page drawing it. Opens no socket and
// touches no roster; every file lives in a temp directory.
//
//   node tools/m59-pvp-telemetry-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-telemetry-test-'));
process.env.M59_PVP_DIR = join(dir, 'pvp');
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');
process.env.M59_TAUNT_LOG = join(dir, 'taunts.jsonl');

const tm = await import('./m59-pvp-telemetry.mjs');
const pvp = await import('./m59-pvp.mjs');
const { renderPvp } = await import('./m59-pvp-page.mjs');
const { M59Client } = await import('./m59-client.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const { Recorder } = await import('./m59-recorder.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const T = s => Date.parse(`2026-10-17T${s}Z`);
const OURS = ['Camilla', 'Janice', 'Beaker', 'Floyd', 'Zoot'];

await test('the location stamp is map, square and the fine offset inside it', () => {
  const l = tm.locStamp(38, { x: 17 * 64 + 12, y: 15 * 64 + 40 });
  assert.deepEqual([l.map, l.row, l.col, l.fx, l.fy], [38, 15, 17, 12, 40]);
  assert.equal(tm.locText(l), 'm38 r15c17 +12/+40');
  assert.equal(tm.locStamp(38, null), null);
  assert.equal(tm.squaresBetween(l, tm.locStamp(38, { x: 20 * 64 + 12, y: 15 * 64 + 40 })), 3);
  assert.equal(tm.squaresBetween(l, tm.locStamp(39, { x: 0, y: 0 })), null, 'two maps have no distance');
});

await test('the kod\'s spell sentences classify, with their target', () => {
  const c = t => tm.classifyMessage(t);
  assert.deepEqual(c('Morpheus is now held in place by a magical force.'), { cls: 'spell_landed', target: 'Morpheus', effect: 'held in place by a magical force' });
  assert.equal(c('Morpheus is already held.').cls, 'spell_already');
  assert.equal(c('You were unsuccessful in casting hold.').cls, 'spell_failed');
  assert.equal(c("You don't have enough mana to cast blind!").cls, 'spell_no_mana');
  assert.equal(c("You don't have the reagents to cast hold!").cls, 'spell_no_reagents');
  assert.equal(c('Morpheus resists your spell!').cls, 'spell_resisted');
  assert.equal(c("You've attacked a player too recently.").cls, 'spell_too_soon');
  assert.equal(c('Your words catch in your throat and you cannot speak.').cls, 'spell_silenced');
  assert.deepEqual(c('Camilla murmurs something under his breath and points a finger at Morpheus.'), { cls: 'cast_seen', caster: 'Camilla', target: 'Morpheus' });
  assert.deepEqual(c("You can't use the leather armor--it's broken."), { cls: 'gear_broken', item: 'leather armor' });
  assert.equal(c('Morpheus narrowly dodges your vampiric attack.').cls, 'wand_dodged');
  assert.equal(c('Morpheus laughs off your pitiful blow.').cls, 'no_effect');
  assert.equal(c('Morpheus maims you with his scimitar.').cls, 'swing_in_hit');
  assert.equal(c('~BSomething nobody wrote down.').cls, 'other');
});

// The Morpheus fight of 2026-10-17, as the record had it: two opener holds from Camilla, two from
// Janice, one each from Beaker and Robin, and nothing saying what came of any of them.
const battleRows = () => ({
  log: [
    { kind: 'combat', event: 'pvp_attacked', at: T('17:28:24.996'), observer: 'Zoot', room: 38, target: 'Morpheus', attackers: [{ character: 'Morpheus' }] },
    { kind: 'combat', event: 'opener_cast', at: T('17:28:25.437'), observer: 'Camilla', room: 38, target: 'Morpheus', opener: 'hold', opener_casts: 1, attackers: [] },
    { kind: 'combat', event: 'opener_cast', at: T('17:28:25.561'), observer: 'Janice', room: 38, target: 'Morpheus', opener: 'hold', opener_casts: 1, attackers: [] },
    { kind: 'death', at: T('17:28:28.253'), observer: 'Floyd', victim: 'Morpheus', killer: 'Floyd', how: 'guild combat', our_side: 'killer', room: 38 },
  ],
  messages: [
    { at: T('17:28:25.464'), observer: 'Janice', room: 38, text: 'Camilla murmurs something under his breath and points a finger at Morpheus.' },
    { at: T('17:28:25.465'), observer: 'Beaker', room: 38, text: 'Camilla murmurs something under his breath and points a finger at Morpheus.' },
    { at: T('17:28:25.474'), observer: 'Camilla', room: 38, text: 'Morpheus is now held in place by a magical force.' },
    { at: T('17:28:25.627'), observer: 'Janice', room: 38, text: 'Morpheus is already held.' },
    { at: T('17:28:25.827'), observer: 'Janice', room: 38, text: "You can't use the leather armor--it's broken." },
    { at: T('17:28:25.300'), observer: 'Floyd', room: 38, text: 'The wand pulses once in your hand.' },
    { at: T('17:28:25.301'), observer: 'Zoot', room: 38, text: 'The wand pulses once in your hand.' },
  ],
  actions: [
    // the new file: Janice's rite takes off the leather and puts on a robe, then the hold, then the swing
    { kind: 'action', verb: 'unuse', at: T('17:28:25.300'), observer: 'Janice', room: 38, item: 7, item_name: 'leather armor', loc: tm.locStamp(38, { x: 1100, y: 980 }) },
    { kind: 'action', verb: 'use', at: T('17:28:25.400'), observer: 'Janice', room: 38, item: 8, item_name: 'robe', loc: tm.locStamp(38, { x: 1100, y: 980 }) },
    { kind: 'action', verb: 'cast', at: T('17:28:25.562'), observer: 'Janice', room: 38, spell: 'hold', target_name: 'Morpheus', loc: tm.locStamp(38, { x: 1100, y: 980 }), mana: 30, max_mana: 40, rite: 'cast-gear:pvp opener' },
    { kind: 'action', verb: 'attack', at: T('17:28:26.000'), observer: 'Zoot', room: 38, target_name: 'Morpheus', loc: tm.locStamp(38, { x: 1088, y: 960 }), target_loc: tm.locStamp(38, { x: 1152, y: 960 }), dist: 1 },
    { kind: 'action', verb: 'traverse', at: T('17:28:27.000'), observer: 'Beaker', room: 41, from: 38, to: 41, loc: tm.locStamp(41, { x: 640, y: 640 }) },
  ],
  taunts: [{ at: T('17:29:30'), battle: 'b-2026-10-17T17:28:24.996Z', killer: 'Floyd', spoke: { character: 'Floyd', line: 'Dig it.', why: 'last kill' }, tried: [] }],
});

const reportOf = (rows) => pvp.pvpReport({ now: T('17:40'), days: 1, characters: OURS, log: rows.log, ledger: [], alarms: [],
  reconstructed: [], members: {}, aliases: new Map(), actions: rows.actions, messages: rows.messages, taunts: rows.taunts });

await test('every cast is joined to the reply its caster heard', () => {
  const b = reportOf(battleRows()).battles[0];
  const t = b.telemetry;
  const camilla = t.casts.find(c => c.observer === 'Camilla');
  assert.equal(camilla.outcome, 'spell_landed'); assert.equal(camilla.reply_ms, 37);
  assert.ok(camilla.inferred, 'a fight before the actions file still has its opener casts');
  const janice = t.casts.filter(c => c.observer === 'Janice');
  assert.equal(janice.length, 1, 'an opener row and its packet row are one cast, not two');
  assert.equal(janice[0].outcome, 'spell_already'); assert.equal(janice[0].rite, 'cast-gear:pvp opener');
  const jp = t.characters.find(c => c.name === 'Janice');
  assert.deepEqual([jp.casts, jp.wasted, jp.gear, jp.gear_broken], [1, 1, 2, 1], 'the robe swap and the broken leather are counted');
});

await test('a cast with no reply says so rather than reading as success', () => {
  const rows = battleRows();
  rows.messages = rows.messages.filter(m => m.observer !== 'Camilla');
  const c = reportOf(rows).battles[0].telemetry.casts.find(x => x.observer === 'Camilla');
  assert.equal(c.outcome, 'no_reply');
  assert.match(tm.describeAction(c), /no reply heard/);
});

await test('a third-person line is kept once with who heard it; a first-person one stays per body', () => {
  const t = reportOf(battleRows()).battles[0].telemetry;
  const seen = t.messages.filter(m => m.cls === 'cast_seen');
  assert.equal(seen.length, 1); assert.deepEqual(seen[0].heard_by.sort(), ['Beaker', 'Janice']);
  assert.equal(t.messages.filter(m => m.cls === 'wand_pulse').length, 2, '"your wand" is two different wands');
});

await test('map traversal, every swing\'s location and the taunt reach the summary', () => {
  const b = reportOf(battleRows()).battles[0];
  const t = b.telemetry;
  assert.deepEqual(t.characters.find(c => c.name === 'Beaker').maps, [38, 41]);
  assert.equal(t.traversals.length, 1);
  assert.match(tm.describeAction(t.traversals[0]), /crosses map 38 → 41 arriving @ m41 r10c10 \+0\/\+0/);
  const swing = t.actions.find(a => a.verb === 'attack');
  assert.match(tm.describeAction(swing), /Zoot swings → Morpheus @ m38 r15c18 \+0\/\+0 \(1 sq\) @ m38 r15c17 \+0\/\+0/);
  assert.equal(t.taunt.character, 'Floyd'); assert.equal(t.taunt.line, 'Dig it.');
  const text = tm.battleText(b);
  assert.match(text, /📣 Floyd broadcasts "Dig it\."/);
  assert.match(text, /Janice casts hold → Morpheus @ m38 r15c17 \+12\/\+20 mana 30\/40 rite:cast-gear:pvp opener.*⇒ wasted/);
});

await test('the /pvp page draws the casts, the gear, the map changes and the taunt', () => {
  const html = renderPvp({ report: reportOf(battleRows()) });
  assert.match(html, /What ours did/);
  assert.match(html, /📣 <b>Floyd<\/b>: “Dig it\.”/);
  assert.match(html, /hold ×1: wasted \(already in effect\) 1/);
  assert.match(html, /crosses map 38 → 41/);
  assert.match(html, /\(1 broken\)/);
});

await test('the client taps every attack, cast, use and unuse after it is sent', () => {
  const c = Object.create(M59Client.prototype);
  const sent = [];
  c.send = (op) => sent.push(op);
  c.room = { objects: new Map() };
  c.spells = [{ id: 5, name: 'hold' }];
  const seen = [];
  const untap = c.tapAction(a => seen.push(a));
  c.attack(99); c.cast(5, [99]); c.use(7); c.unuse(8); c.apply(9, 99); c.activate(10);
  assert.deepEqual(seen.map(a => a.verb), ['attack', 'cast', 'use', 'unuse', 'apply', 'activate']);
  assert.equal(seen[1].spell, 'hold'); assert.deepEqual(seen[1].targets, [99]);
  assert.equal(sent.length, 6, 'every packet still went out');
  c.tapAction(() => { throw new Error('a broken listener'); });
  c.use(7);
  assert.equal(sent.length, 7, 'a listener that throws never stops a packet');
  untap();
});

await test('the keeper writes an action row only inside a PvP window, with the body\'s location and the code that sent it', () => {
  const fake = Object.create(CombatMode.prototype);
  const me = { id: 1, x: 17 * 64 + 12, y: 15 * 64 + 40, nameRsc: 0 };
  const foe = { id: 99, x: 19 * 64, y: 15 * 64, name: 'Morpheus', flags: 0 };
  const client = Object.create(M59Client.prototype);
  client.send = () => {}; client.selfId = 1; client.me = { name: 'Janice' };
  client.room = { objects: new Map([[1, me], [99, foe]]) }; client.spells = [{ id: 5, name: 'hold' }];
  client.vitals = () => ({ mana: { value: 30, max: 40 } });
  fake.s = { name: 'Janice', recorder: new Recorder('Janice', { directory: join(dir, 'rec') }), world: { room: { num: 38 } }, client };
  fake.active = null; fake.pvpTailUntil = 0;
  fake.tapClient(client);
  client.cast(5, [99]);
  const day = new Date().toISOString().slice(0, 10);
  const read = () => tm.readSide('actions', { dir: process.env.M59_PVP_DIR, since: Date.parse(day), until: Date.now() + 1000 });
  assert.equal(read().length, 0, 'no fight, no row');
  fake.active = { pvp: { decision_id: 'd1' }, phase: 'engaging', order: { action: 'defend', target: 'Morpheus' } };
  client.cast(5, [99]);
  const [row] = read();
  assert.equal(row.verb, 'cast'); assert.equal(row.spell, 'hold'); assert.equal(row.target_name, 'Morpheus');
  assert.equal(tm.locText(row.loc), 'm38 r15c17 +12/+40'); assert.equal(row.dist, 1.9);
  assert.equal(row.mana, 30); assert.equal(row.phase, 'engaging'); assert.equal(row.intent, 'defend Morpheus');
  assert.match(row.via ?? '', /@pvp-telemetry-test/, 'via names the code that sent the packet');
  fake.s.world.room.num = 38; fake.notePvpTraverse(client);
  fake.s.world.room.num = 41; fake.notePvpTraverse(client);
  const trav = read().find(r => r.verb === 'traverse');
  assert.deepEqual([trav.from, trav.to], [38, 41]);
  fake.s.recorder.stop();
});

await test('an enemy\'s look is kept once per fight and on every change, and what fell when he died', () => {
  const fake = Object.create(CombatMode.prototype);
  const me = { id: 1, x: 640, y: 640, nameRsc: 0 };
  const foe = { id: 99, x: 19 * 64, y: 15 * 64, name: 'Morpheus', flags: 0x0004, iconRsc: 29379, translation: 9, appearanceRevision: 1,
    overlays: [{ iconRsc: 20068, hotspot: 1, animate: { translation: 3 } }] };
  const mate = { id: 98, x: 18 * 64, y: 15 * 64, name: 'Zoot', flags: 0x0004, appearanceRevision: 1, overlays: [] };
  const client = Object.create(M59Client.prototype);
  client.send = () => {}; client.selfId = 1; client.me = { name: 'Janice' };
  client.room = { objects: new Map([[1, me], [99, foe], [98, mate]]) }; client.rsc = new Map();
  fake.s = { name: 'Janice', recorder: new Recorder('Janice', { directory: join(dir, 'rec2') }), world: { room: { num: 38 } }, client };
  fake.fleetmate = n => n === 'Zoot';
  fake.active = { pvp: { decision_id: 'd-look' }, phase: 'engaging', order: { action: 'defend', target: 'Morpheus' } };
  fake.pvpTailUntil = 0;
  const day = new Date().toISOString().slice(0, 10);
  const rows = () => tm.readSide('actions', { dir: process.env.M59_PVP_DIR, since: Date.parse(day), until: Date.now() + 1000 });
  const looks = () => rows().filter(r => r.verb === 'appearance' && r.fight === 'd-look');
  fake.notePvpAppearances(client); fake.notePvpAppearances(client);
  assert.equal(looks().length, 1, 'once per fight, not once per packet');
  assert.equal(looks()[0].target_name, 'Morpheus', 'a fleetmate is never recorded');
  assert.equal(looks()[0].appearance.icon_rsc, 29379);
  assert.equal(looks()[0].appearance.overlays[0].hotspot, 1);
  foe.appearanceRevision = 2; fake.notePvpAppearances(client);
  assert.equal(looks().length, 2, 'a new look from the server is a new row');
  // The loot window outlives the fight: two minutes after an enemy death.
  fake.active = null; fake.pvpTailUntil = 0;
  fake.recordPvpDeath({ text: '### Morpheus of the Human Resistance has been slaughtered by Floyd of the The Second Swines in guild combat.', at: Date.now() }, client);
  fake.notePvpLoot([{ name: 'scimitar' }, { name: 'shilling', amount: 312 }], client);
  const loot = () => rows().filter(r => r.verb === 'loot');
  assert.equal(loot().length, 1);
  assert.equal(loot()[0].after_death_of, 'Morpheus');
  assert.deepEqual(loot()[0].items, [{ name: 'scimitar', amount: null }, { name: 'shilling', amount: 312 }]);
  fake.pvpLootUntil = 0; fake.notePvpLoot([{ name: 'herb' }], client);
  assert.equal(loot().length, 1, 'an ordinary pickup outside any window is not PvP evidence');
  fake.s.recorder.stop();
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
