#!/usr/bin/env node
// Offline guard for the PvP replay: tools/m59-pvp-replay.mjs (sentences, HP ranges, naming the trail's
// bodies, the windowed reader, the dossier) and tools/m59-pvp-replay-page.mjs (the page it draws).
// Opens no socket and touches no roster; every file lives in a temp directory.
//
//   node tools/m59-pvp-replay-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-replay-test-'));
process.env.M59_PVP_DIR = join(dir, 'pvp');
process.env.M59_REPLAY_DIR = join(dir, 'replays');

const rp = await import('./m59-pvp-replay.mjs');
const { renderReplayPage } = await import('./m59-pvp-replay-page.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const T = s => Date.parse(`2026-10-29T${s}Z`);

await test('a hit on us is read as a tier and an HP range scaled to our max HP', () => {
  const r = rp.readSentence('Rick Deckard scorches you with his blast of fire.', { observer: 'Fozzie', maxHp: () => 52 });
  assert.equal(r.cat, 'hit_in_player');
  assert.equal(r.actor, 'Rick Deckard');
  assert.equal(r.family, 'fire');
  assert.equal(r.tier, 'damage');
  // T = 17 → damage is min(16,17)=16 up to ceil(52/3)=18, ×1.15 for the faction shield = 20
  assert.deepEqual(r.hp, [16, 20]);
  const m = rp.readSentence('The troll nicks you with its attack.', { observer: 'Fozzie', maxHp: () => 52 });
  assert.equal(m.cat, 'hit_in_monster');
  assert.deepEqual(m.hp, [1, 5]);
});

await test('our hits on a player assume an enemy of 88+ HP; resist lines and refusals are their own categories', () => {
  const r = rp.readSentence('Your lightning bolt fries Rick Deckard.', { observer: 'Floyd' });
  assert.equal(r.cat, 'hit_out');
  assert.deepEqual(r.hp, [16, 34]);
  assert.equal(rp.readSentence('Rick Deckard laughs off your pitiful blow.', { observer: 'Floyd' }).cat, 'resist_out');
  const s = rp.readSentence('Hey!  You almost hit Rick Deckard!  Good thing your safety was on!', { observer: 'Kermit' });
  assert.equal(s.cat, 'refused'); assert.match(s.why, /safety/);
  assert.match(rp.readSentence('You are not vile enough to cast darkness!', { observer: 'Beaker' }).why, /karma/);
  assert.deepEqual(rp.readSentence('Something smells like burnt hair.  Wait, it\'s you!', { observer: 'Clifford' }).hp, [5, 9]);
  const c = rp.readSentence('Rick Deckard murmurs something under his breath and points a finger at Rick Deckard.', { observer: 'Floyd' });
  assert.equal(c.cat, 'cast_enemy'); assert.equal(c.self, true);
  assert.equal(rp.readSentence('A magical tingling pulses through your body.  You are unable to move.', { observer: 'Floyd' }).effect, 'held');
});

await test('the windowed reader returns exactly the rows inside the window, from a file it never reads whole', () => {
  const f = join(dir, 'rows.jsonl');
  const rows = [];
  for (let i = 0; i < 20000; i++) rows.push(JSON.stringify({ at: T('10:00:00') + i * 100, i, pad: 'x'.repeat(40) }));
  writeFileSync(f, rows.join('\n') + '\n');
  const got = rp.readJsonlWindow(f, T('10:10:00'), T('10:10:05'));
  assert.equal(got.length, 51);
  assert.equal(got[0].at, T('10:10:00'));
  assert.equal(got.at(-1).at, T('10:10:05'));
});

await test('a trail body with no name takes the name of the one of ours logged standing on it', () => {
  const battle = { id: 'b-x', start: T('17:23:00'), end: T('17:23:30'), rooms: [2154], result: 'lost', kills: 0, our_deaths: 0,
    ours: [{ name: 'Fozzie' }], enemies: [{ name: 'Rick Deckard' }], events: [] };
  const loc = (x, y) => ({ map: 2154, row: Math.floor(y / 64), col: Math.floor(x / 64), x, y });
  const actions = [
    { kind: 'action', verb: 'attack', at: T('17:23:01'), observer: 'Fozzie', room: 2154, loc: loc(1000, 900), target: 6735, target_name: 'Rick Deckard', target_player: true, target_loc: loc(1080, 900), dist: 1.3 },
    { kind: 'action', verb: 'attack', at: T('17:23:03'), observer: 'Fozzie', room: 2154, loc: loc(1010, 905), target: 6735, target_name: 'Rick Deckard', target_player: true, target_loc: loc(1090, 905), dist: 1.3 },
  ];
  // room_rsc of Avar Village in the committed map; the body ids are server handles, here invented
  const trow = (at, id, x, y) => ({ at, room: 999, room_rsc: 23286, room_name_rsc: 23285, id, player: true, x, y });
  const trails = [trow(T('17:23:01') + 50, 4457, 1000, 900), trow(T('17:23:03') + 50, 4457, 1010, 905), trow(T('17:23:02'), 6735, 1085, 902)];
  const r = rp.buildReplay(battle, { actions, trails, messages: [
    { kind: 'message', at: T('17:23:02'), observer: 'Fozzie', room: 2154, text: 'Rick Deckard scorches you with his blast of fire.' }],
    isOurs: n => n === 'Fozzie', maxHp: new Map([['fozzie', 52]]) });
  assert.equal(r.ids[4457]?.name, 'Fozzie', 'the trail body standing where Fozzie logged himself is Fozzie');
  assert.ok(r.tracks['Rick Deckard'].length >= 3, 'the enemy is named from the action\'s target id');
  assert.equal(r.sources.unnamed_bodies, 0);
  assert.equal(r.dossier.counts.swings, 2);
  assert.equal(r.dossier.counts.hits_in_player, 1);
  assert.deepEqual(r.dossier.damage_in.player, [16, 20]);
  const html = renderReplayPage(r, { geoms: {} });
  assert.match(html, /<title>PvP replay — 2026-10-29 17:23:00Z vs Rick Deckard<\/title>/);
  const data = html.slice(html.indexOf('var D = '), html.indexOf('\n', html.indexOf('var D = ')));
  assert.ok(data.length > 100 && !data.includes('</'), 'the embedded data cannot close the script early');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
