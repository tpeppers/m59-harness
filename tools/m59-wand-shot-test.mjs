// Offline guard for the wand-shot record (tools/m59-wand-shot.mjs) and its side files
// (pvplog.appendShot / appendFightMessage) and the PvP replay seal budget (m59-replay-worker.mjs).
// Opens no socket and touches no roster; every file lives in a temp directory.
//
//   node tools/m59-wand-shot-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-wand-shot-test-'));
process.env.M59_PVP_DIR = join(dir, 'pvp');
const ws = await import('./m59-wand-shot.mjs');
const pvp = await import('./m59-pvp.mjs');
const { pruneSeals } = await import('./m59-replay-worker.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }

// A geometry with one wall: the step INTO column 5 is refused on rows 0-9, open elsewhere.
const wallAtCol5 = { canMove: (r, c, r2, c2) => !(c2 === 5 && c !== 5 && r2 < 10) };
const open = { canMove: () => true };
const E = 0, S = 1024, W = 2048, N = 3072;   // server angles: 0 east, clockwise (blakston.khd:1233-1240)

const base = (over = {}) => ({
  now: 10_000, shotId: 's1', character: 'Beaker', room: 38,
  me: { row: 5, col: 2, posAt: 9_900, angle: E, degrees: 0 },
  target: { id: 7, name: 'Morpheus', row: 5, col: 8, posAt: 9_950, inRoom: true },
  wand: { id: 3, name: 'wand' }, geo: open, face: false, ...over,
});

await test('behindYou transcribes the server: facing east, a target to the west is behind', () => {
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 5, col: 2 }, E), true);
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 5, col: 9 }, E), false);
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 2, col: 5 }, S), true, 'facing south, north is behind');
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 9, col: 5 }, N), true, 'facing north, south is behind');
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 5, col: 9 }, W), true);
});

await test('behindYou: adjacent (squared distance 1) is never behind, and unknown is null not false', () => {
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 5, col: 4 }, E), false);
  assert.equal(ws.behindYou({ row: 5, col: 5 }, { row: 5, col: 4 }, null), null);
});

await test('losBlock names the first refused step of the staircase walk', () => {
  assert.deepEqual(ws.losBlock(wallAtCol5, { row: 5, col: 2 }, { row: 5, col: 8 }), { from: [5, 4], to: [5, 5] });
  assert.equal(ws.losBlock(open, { row: 5, col: 2 }, { row: 5, col: 8 }), null);
});

await test('a clear, timely, facing shot predicts none; refused anyway it is unexplained', () => {
  const s = ws.buildShot(base());
  assert.equal(s.sight.los, true); assert.equal(s.predicted, 'none');
  s.sent_at = 10_000; ws.addReply(s, 'You point your wand but nothing happens.', 10_150);
  ws.finishShot(s);
  assert.equal(s.refused, true); assert.equal(s.cause, 'unexplained', 'a gate this model does not know');
});

await test('a wall between us predicts los and records where it is', () => {
  const s = ws.buildShot(base({ geo: wallAtCol5 }));
  assert.equal(s.sight.los, false); assert.equal(s.predicted, 'los');
  assert.deepEqual(s.sight.los_block, { from: [5, 4], to: [5, 5] });
  ws.addReply(s, 'You point your wand but nothing happens.', 10_100); ws.finishShot(s);
  assert.equal(s.cause, 'los');
});

await test('a wall with a stale target square is charged to stale, not to the wall', () => {
  const s = ws.buildShot(base({ geo: wallAtCol5, target: { ...base().target, posAt: 9_000 } }));
  assert.equal(s.predicted, 'stale');
});

await test('a target missing from our room predicts other_room, ahead of every other gate', () => {
  const s = ws.buildShot(base({ target: { ...base().target, inRoom: false }, lastAcceptedZapAt: 9_500 }));
  assert.equal(s.predicted, 'other_room');
});

await test('the attack timer counts any accepted zap, cast or swing inside 2 s', () => {
  assert.equal(ws.buildShot(base({ lastAcceptedZapAt: 8_100 })).predicted, 'timer');
  assert.equal(ws.buildShot(base({ lastAcceptedZapAt: 7_900 })).predicted, 'none', '2.1 s is clear');
  assert.equal(ws.buildShot(base({ lastCast: { at: 9_000, name: 'hold' } })).predicted, 'timer');
  const s = ws.buildShot(base({ lastSwingAt: 9_500 }));
  assert.equal(s.predicted, 'timer'); assert.equal(s.timer.since_last_swing_ms, 500);
});

await test('facing judges the angle we just turned to, and the server naming it wins', () => {
  // Facing west with the target east, no turn: behind.
  assert.equal(ws.buildShot(base({ me: { ...base().me, angle: W, degrees: 180 } })).predicted, 'facing');
  // Same, but the strategy turned us to 0 degrees first: in front.
  assert.equal(ws.buildShot(base({ me: { ...base().me, angle: W, degrees: 180 }, face: true, faceDeg: 0 })).predicted, 'none');
  const s = ws.buildShot(base());
  ws.addReply(s, "You can't see your selected target.", 10_050);
  ws.addReply(s, 'You point your wand but nothing happens.', 10_060);
  ws.finishShot(s);
  assert.equal(s.cause, 'facing', 'the server said which gate');
});

await test('accepted despite a predicted refusal is flagged unexpected', () => {
  const s = ws.buildShot(base({ geo: wallAtCol5 }));
  ws.addReply(s, 'Your lightning bolt strikes Morpheus.', 10_200);
  ws.finishShot(s);
  assert.equal(s.refused, false); assert.equal(s.cause, 'unexpected');
  assert.match(s.hit_text, /Morpheus/);
});

await test('summarizeShots divides refused by SHOTS (the 147/182 mistake)', () => {
  const rows = [...Array(182)].map((_, i) => ({ kind: 'shot', refused: i < 147, cause: i < 147 ? 'los' : 'none' }));
  const t = ws.summarizeShots(rows);
  assert.equal(t.refusal_rate, 0.808); assert.equal(t.by_cause.los, 147);
});

await test('shots and fight messages go to side files the battle reader never reads', () => {
  const at = Date.parse('2026-10-07T01:40:00Z');
  const s = ws.finishShot(ws.buildShot({ ...base(), now: at }));
  assert.ok(pvp.appendShot(s));
  assert.ok(pvp.appendFightMessage({ kind: 'message', at, observer: 'Beaker', text: 'x' }));
  const files = readdirSync(process.env.M59_PVP_DIR).sort();
  assert.deepEqual(files, ['messages-2026-10-07.jsonl', 'shots-2026-10-07.jsonl']);
  assert.equal(pvp.readPvpLog({ since: at - 1000, until: at + 1000 }).length, 0, 'not a battle row');
  assert.equal(pvp.readShots({ since: at - 1000, until: at + 1000 }).length, 1);
});

await test('the seal budget evicts the oldest seals first and leaves the rest', async () => {
  const sub = join(dir, 'replays', 'pvp');
  rmSync(sub, { recursive: true, force: true });
  (await import('node:fs')).mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 4; i++) {
    const f = join(sub, `s${i}.json`); writeFileSync(f, 'x'.repeat(100));
    utimesSync(f, 1000 + i, 1000 + i);
  }
  const removed = await pruneSeals(sub, 250);
  assert.equal(removed, 2);
  assert.deepEqual(readdirSync(sub).sort(), ['s2.json', 's3.json']);
  assert.equal(await pruneSeals(join(dir, 'nope'), 1), 0, 'a missing directory is not an error');
});

await test('CombatMode builds, collects and writes one row per zap, and tees fight lines', async () => {
  const { CombatMode } = await import('./m59-combat-mode.mjs');
  const P = CombatMode.prototype;
  const self = { id: 1, row: 5, col: 2, x: 0, y: 0, posAt: Date.now(), angle: 0, degrees: 0 };
  const foe = { id: 7, row: 5, col: 8, posAt: Date.now(), flags: 0, name: 'Morpheus' };
  const client = { selfId: 1, self, room: { objects: new Map([[1, self], [7, foe]]) }, me: { name: 'Beaker' },
                   attackLog: [], lastCastSent: null, lastApplySent: null };
  const fake = Object.assign(Object.create(P), {
    s: { client, world: { room: { num: 38 }, geometry: wallAtCol5, map: { rooms: { 38: { flags: 0x0008 } } } } },
    pvpLogging: () => true, active: { pvp: { decision_id: 'd1' } },
  });
  const o = { client, targetName: 'Morpheus', pvp: { decision_id: 'd1' } };
  const shot = fake.buildWandShot(o, { live: foe, pick: { o: { id: 3 }, name: 'wand' },
    decision: { strategy: 'pvp-wand-volley', why: 'on the beat (decoded lightning wand)', face: true },
    ctx: { beat: 9, unidentified: [{ id: 3, colour: 8 }] }, faceDeg: 0, queuedAt: Date.now() - 40 });
  assert.equal(shot.predicted, 'los'); assert.equal(shot.room_flags.guild_pk_only, true);
  assert.equal(shot.wand.colour, 8); assert.equal(shot.wand.decoded, true);
  assert.ok(shot.queued_ms >= 40);
  fake.openWandShot(shot);
  fake.noteFightMessage('You point your wand but nothing happens.');
  fake.closeWandShot();
  const rows = pvp.readShots({ since: shot.at - 1000, until: shot.at + 1000 }).filter(r => r.shot_id === shot.shot_id);
  assert.equal(rows.length, 1); assert.equal(rows[0].refused, true); assert.equal(rows[0].cause, 'los');
  assert.equal(fake.lastAcceptedZapAt, undefined, 'a refused zap does not arm the timer');
  fake.active = null; fake.pvpTailUntil = 0;
  fake.noteFightMessage('outside any fight');      // not written: no fight and no tail
});

await test('against the real room 38 geometry, the transcribed LOS answers both ways', async () => {
  const { readFileSync } = await import('node:fs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  let map;
  try { map = JSON.parse(readFileSync(new URL('../substrate/m59-map.json', import.meta.url))); } catch { map = null; }
  if (!map?.rooms?.[38]?.roo) { console.log('  (skipped: no substrate/m59-map.json in this checkout)'); return; }
  const geo = sharedRoomGeometry(map.rooms[38]);
  // Two fleet squares from the 2026-10-07 replay frames: Robin (8,13) and Janice (9,23).
  const s = ws.buildShot(base({ geo, me: { row: 8, col: 13, posAt: 9_900, angle: 0, degrees: 0 },
    target: { id: 7, name: 'X', row: 9, col: 23, posAt: 9_900, inRoom: true } }));
  assert.equal(typeof s.sight.los, 'boolean'); assert.equal(typeof s.sight.los_reverse, 'boolean');
  assert.equal(s.sight.geometry, true);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} tests passed`);
