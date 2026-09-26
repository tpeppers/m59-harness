#!/usr/bin/env node
// Offline tests for the raid map (m59-raidmap.mjs): frames from a track and from a trackless run,
// interpolation and ordering, the "since the last checkpoint" window, sankey bucketing, loose ends,
// and that the page carries its data. Opens no socket and touches no roster; the fixture runs are
// written to the OS temp directory and removed afterwards.
//
//   node tools/m59-raidmap-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRun, buildRaidData, framesFromTrack, framesFromObservations, observations, frameIndexAt, unitAt,
         orderAt, sinceWindow, sankeyBuckets, looseEnds, renderHtml, extractData, stepKey, parseVital,
         roomGeometry, deathTime, U, SRC, IDLE_MS } from './m59-raidmap.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ------------------------------------------------------------------ small helpers
ok(stepKey({ label: 'arm.hall-draw', why: 'x', do: 'verify' }) === 'arm.hall-draw', 'stepKey: label wins');
ok(stepKey({ label: null, why: 'the farm could not be read back', do: 'verify' }) === 'the farm could not be read back', 'stepKey: then why');
ok(stepKey({ label: null, why: null, do: 'walk', to: 38 }) === 'walk:38', 'stepKey: else do:to');
ok(stepKey({ do: 'say' }) === 'say', 'stepKey: do alone when there is no destination');
ok(parseVital('61/75').now === 61 && parseVital('61/75').max === 75, 'parseVital "61/75"');
ok(parseVital(80).now === 80 && parseVital(80).max === null, 'parseVital bare number');
ok(parseVital({ value: 3, max: 9 }).max === 9 && parseVital(null) === null && parseVital('?') === null, 'parseVital object / null / junk');
ok(deathTime({ t: 1790381679517, postmortem: 'C:\\x\\postmortems\\Eeee-2026-09-26T00-13-56-376Z.json' }) === Date.parse('2026-09-26T00:13:56.376Z'),
  'deathTime: the post-mortem file name beats a batch-written ledger t');
ok(deathTime({ t: 1000, postmortem: 'a/Eeee-2026-09-26T00-13-56-376Z.json' }) === 1000, 'deathTime: a post-mortem AFTER the recorded t is somebody else\'s');
ok(deathTime({ t: 5 }) === 5, 'deathTime: no post-mortem, the recorded t');

// ------------------------------------------------------------------ geometry
{
  const flags = Buffer.from([1, 1, 0, 1, 1, 1]).toString('base64');
  const g = roomGeometry({ num: 7, name: 'Test Hall', rows: 2, cols: 3,
    roo: { walls: [[0, 0, 3072, 0, 1], [0, 2048, 0, 0, 2]], flags },
    goExits: [{ row: 2, col: 3, to: 8, locked: false }], edgeExits: [{ leaveName: 'west', to: 9 }] });
  ok(g.rows === 2 && g.cols === 3 && g.walls.length === 2, 'roomGeometry keeps the size and every wall');
  ok(g.walls[0][2] === 3 && g.walls[1][1] === 2, 'roomGeometry scales walls to squares (1024 fine units each)');
  ok(g.floor === '110111', 'roomGeometry decodes the floor bit per square, row-major');
  ok(g.exits[0].to === 8 && g.edges[0].side === 'west', 'roomGeometry keeps go exits and edge exits');
  ok(roomGeometry(null) === null, 'roomGeometry of a missing room is null');
}

// ------------------------------------------------------------------ frames from a track
const agentIndex = new Map([['a1', 0], ['a2', 1]]);
function interner() { const S = [], m = new Map(); return { S, id: v => { if (v == null) return null; if (!m.has(v)) { m.set(v, S.length); S.push(v); } return m.get(v); } }; }
const T = 1_000_000;
const unit = (agent, room, row, col, hp = '50/100', step = null) =>
  ({ agent, character: agent.toUpperCase(), room, row, col, health: hp, mana: '5/10', vigor: 80, activity: 'hunting', last_action: null, step });
const track = [
  // deliberately out of order, with a duplicate t: the later line wins
  { t: T + 20_000, units: [unit('a1', 40, 10, 5), unit('a2', 38, 3, 3)] },
  { t: T, units: [unit('a1', 40, 2, 5, '100/100', { script: 's', label: 'raid.fight', to: 40, since: T - 5000 }), unit('a2', 38, 1, 1)],
    monsters: { room: 40, list: [{ name: "ghost of Far'Nohl", row: 2, col: 5 }] } },
  { t: T + 10_000, units: [unit('a1', 40, 6, 5)] },                       // a2 missing: carried forward
  { t: T + 10_000, units: [unit('a1', 40, 6, 5), unit('a2', 38, 2, 2)] }, // same t again: this one wins
  { t: T + 30_000, units: [unit('a1', 38, 23, 4), unit('a2', 38, 4, 4)] },
  { t: T + 200_000, units: [unit('a1', 38, 1, 1)] },                      // a2 gone longer than the carry
];
{
  const I = interner();
  const fr = framesFromTrack(track, agentIndex, I);
  ok(fr.length === 5, `one frame per distinct t (got ${fr.length})`);
  ok(fr.every((f, i) => i === 0 || f.t > fr[i - 1].t), 'frames are sorted by time');
  ok(fr[1].u[1][U.row] === 2, 'a duplicate t keeps the later line');
  ok(fr[0].u[0][U.hp] === 100 && fr[0].u[0][U.max] === 100 && fr[0].u[0][U.mana] === 5, 'vitals parsed into the tuple');
  ok(I.S[fr[0].u[0][U.step]] === 'raid.fight' && fr[0].u[0][U.to] === 40 && fr[0].u[0][U.since] === T - 5000, 'the step (order) is carried');
  ok(fr[0].u[0][U.src] === SRC.track, 'track units are marked as track');
  ok(fr[0].m && fr[0].m.room === 40 && fr[0].m.list[0][0].startsWith('ghost') && fr[0].m.list[0][1] === 2, 'monsters kept with their room');
  ok(fr[4].u[1] === null, 'a unit missing for longer than the carry window is not invented');

  // interpolation
  const mid = unitAt(fr, 0, T + 5000);
  ok(near(mid.row, 4) && near(mid.col, 5), `halfway between r2 and r6 is r4 (got r${mid.row})`);
  ok(unitAt(fr, 0, T).row === 2, 'exactly on a frame, no interpolation');
  const across = unitAt(fr, 0, T + 25_000);
  ok(across.room === 40 && across.row === 10, 'never interpolated across a room change');
  ok(unitAt(fr, 0, T - 1) === null, 'nothing before the first frame');
  const gap = unitAt(fr, 0, T + 100_000);
  ok(gap.row === 23, 'no interpolation across a gap longer than a minute');
  ok(frameIndexAt(fr, T + 15_000) === 1 && frameIndexAt(fr, T + 10_000) === 1 && frameIndexAt(fr, 0) === -1, 'frameIndexAt: last frame at or before t');
}

// ------------------------------------------------------------------ frames without a track
{
  const run = {
    samples: [{ t: T + 1000, agent: 'a1', character: 'A1', room_num: 38, hp: 40, max: 80 }],
    steps: [{ agent: 'a2', do: 'walk', to: 2, t0: T, ms: 5000, ok: true }, { agent: 'a2', do: 'walk', to: 99, t0: T + 6000, ms: 1000, ok: false }],
    events: [{ t: T + 50_000, kind: 'left', agent: 'a1', room: 153 }],
    deaths: [{ t: T + 90_000, agent: 'a2' }],
  };
  const obs = observations(run, agentIndex);
  const fr = framesFromObservations(obs, 2, { t0: T, t1: T + 200_000, period: 10_000, hpStaleMs: 120_000 });
  ok(fr.length === 21 && fr[0].t === T && fr[fr.length - 1].t === T + 200_000, `frames every period across the span (got ${fr.length})`);
  ok(fr[0].u[0] === null && fr[1].u[0][U.room] === 38 && fr[1].u[0][U.hp] === 40, 'a sample places a unit and gives it health');
  ok(fr[1].u[0][U.row] === null, 'a sample carries no square');
  ok(fr[5].u[0][U.room] === 153, 'an event naming a room moves the unit');
  ok(fr[1].u[1][U.room] === 2 && fr[5].u[1][U.room] === 2, 'a finished walk places a unit; a FAILED walk does not move it');
  ok(fr[13].u[0][U.hp] === null, 'health older than the stale window is not shown as current');
  ok(fr[9].u[1][U.hp] === 0, 'a death reads as health 0');
}

// ------------------------------------------------------------------ orders and the since-window
{
  const steps = [
    { a: 0, k: 'arm.dress', t0: 100, ms: 50, ok: true },
    { a: 0, k: 'raid.fight', t0: 120, ms: 1000, ok: true },
    { a: 1, k: 'walk:38', t0: 100, ms: 10, ok: false },
  ];
  ok(orderAt(steps, 0, 130).k === 'raid.fight', 'orderAt: the latest step to start wins');
  ok(orderAt(steps, 0, 110).k === 'arm.dress', 'orderAt: before the second starts, the first');
  ok(orderAt(steps, 1, 111) === null, 'orderAt: a finished step is no longer an order');
  ok(orderAt(steps, 0, 99) === null, 'orderAt: nothing before the first step');
  const data = {
    steps,
    events: [{ t: 60_000, a: 0, kind: 'retreat' }, { t: 100_000, a: 0, kind: 'kill' }, { t: 120_000, a: 0, kind: 'return' },
             { t: 90_000, a: -1, kind: 'phase' }, { t: 95_000, a: 1, kind: 'kill' }],
    deaths: [{ t: 110_000, a: 0 }, { t: 50_000, a: 0 }],
  };
  const w = sinceWindow(data, 0, 120_000, 60_000);
  ok(w.events.map(e => e.kind).join() === 'kill,return', 'window is (t-60s, t]: the lower edge is out, t itself is in');
  ok(w.deaths.length === 1 && w.deaths[0].t === 110_000, 'deaths in the window only');
  ok(sinceWindow(data, 0, 200, 60_000).steps.map(s => s.k).join() === 'arm.dress', 'finished steps are those that ENDED in the window');
  ok(sinceWindow(data, -1, 120_000).events.map(e => e.kind).join() === 'phase', 'ai -1 is the fleet-wide events');
  ok(sinceWindow(data, 1, 120_000).events.length === 1, 'another raider\'s events are its own');
}

// ------------------------------------------------------------------ sankey
{
  const mk = (t, rooms) => ({ t, u: rooms.map(r => r == null ? null : [r]) });
  const frames = [
    mk(0, [1, 1, 2]), mk(60_000, [1, 1, 2]), mk(120_000, [1, 2, 2]),        // bucket 0: a0->1, a1->1 (2 of 3), a2->2
    mk(300_000, [3, 2, 2]), mk(360_000, [3, 2, null]),                        // bucket 1: a0->3, a1->2, a2->2 (1 vs unknown)
    mk(600_000, [4, 5, null]), mk(660_000, [4, 5, null]),                     // bucket 2: a2 unknown
  ];
  const sk = sankeyBuckets(frames, 3, u => (u ? String(u[0]) : null), { bucketMs: 300_000 });
  ok(sk.cols.length === 3 && sk.cols[1].t === 300_000, `three five-minute columns (got ${sk.cols.length})`);
  ok(sk.cols[0].nodes['1'] === 2 && sk.cols[0].nodes['2'] === 1, 'each raider counted once, under its majority key');
  ok(sk.cols.every(c => Object.values(c.nodes).reduce((a, b) => a + b, 0) === 3), 'every column accounts for every raider');
  ok(sk.cols[2].nodes.unknown === 1 && sk.keys.includes('unknown'), 'a raider with no key is "unknown"');
  const out0 = sk.links.filter(l => l.c === 0).reduce((a, l) => a + l.n, 0);
  ok(out0 === 3, 'links conserve raiders between columns');
  ok(sk.links.some(l => l.c === 0 && l.from === '1' && l.to === '3' && l.n === 1), 'a move is a link from one key to the next');
  const top = sankeyBuckets(frames, 3, u => (u ? String(u[0]) : null), { bucketMs: 300_000, topK: 2 });
  ok(top.keys.includes('other') && top.cols[2].nodes.other >= 1, 'keys past topK collapse into "other"');
  ok(sankeyBuckets([], 3, () => null).cols.length === 0, 'no frames, no sankey');
}

// ------------------------------------------------------------------ a whole run on disk
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'raidmap-test-'));
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const START = Date.parse('2026-09-25T21:56:08.597Z');
function writeRun(name, { withTrack }) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'raid.json'), JSON.stringify({ fleet: 'shadow', agents: ['a1', 'a2'], lightbearer: 'a2', started: new Date(START).toISOString(),
    git: { sha: 'abcdef1234567', short: 'abcdef1', dirty: false, branch: 'b' }, provenance: { harness: 'abcdef1' }, composed: true }));
  fs.writeFileSync(path.join(dir, 'steps.jsonl'), jsonl([
    { script: 's', agent: 'a1', at: 0, do: 'walk', label: null, why: null, to: 38, t0: START + 1000, ms: 4000, ok: true },
    { script: 's', agent: 'a1', at: 1, do: 'verify', label: 'arm.convoy', why: 'x', to: null, t0: START + 5000, ms: 10 * 60_000, ok: true },
    { script: 's', agent: 'a2', at: 0, do: 'walk', label: null, why: null, to: 598, t0: START + 1000, ms: 20 * 60_000, ok: false },
    { script: 's', agent: 'a2', at: 1, do: 'verify', label: 'arm.convoy', why: 'x', to: null, t0: START + 21 * 60_000, ms: 60_000, ok: true },
  ]));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl([
    { t: START + 12 * 60_000, kind: 'entered', expected: 2, arrived: 2 },
    { t: START + 13 * 60_000, kind: 'died', agent: 'a1' },
    { t: START + 14 * 60_000, kind: 'ghost_gone', by: 'a2', after_s: 120 },
    { t: START + 14 * 60_000 + 1, kind: 'heal_failed', agent: 'a2', on: 'A1', why: 'no mana' },
  ]));
  fs.writeFileSync(path.join(dir, 'samples.jsonl'), jsonl([
    { t: START + 12 * 60_000, agent: 'a1', character: 'Aaaa', room_num: 40, hp: 30, max: 60 },
    { t: START + 12 * 60_000, agent: 'a2', character: 'Bbbb', room_num: 38, hp: 50, max: 50 },
  ]));
  if (withTrack) {
    const lines = [];
    for (let k = 0; k <= 30; k++) lines.push({ t: START + 11 * 60_000 + k * 10_000, units: [
      unit('a1', 40, 20 - Math.min(k, 15), 5, `${60 - k}/60`, { script: 's', label: 'raid.fight', to: 40, since: START + 11 * 60_000 }),
      unit('a2', 38, 3, 3)], ...(k % 3 === 0 ? { monsters: { room: 40, list: [{ name: 'tusked skeleton', row: 5, col: 3 }] } } : {}) });
    fs.writeFileSync(path.join(dir, 'track.jsonl'), jsonl(lines));
  }
  return dir;
}
const rooms = {
  38: { num: 38, name: 'Castle Victoria', rows: 23, cols: 49, roo: { walls: [[0, 0, 49 * 1024, 0, 1]] }, goExits: [{ row: 8, col: 32, to: 40 }] },
  40: { num: 40, name: 'The Throne Room of Victoria Castle', rows: 23, cols: 10, roo: { walls: [[0, 0, 9216, 23552, 1]] }, goExits: [{ row: 23, col: 5, to: 38 }] },
};
try {
  // no track.jsonl
  const dirA = writeRun('no-track', { withTrack: false });
  const runA = loadRun(dirA);
  ok(runA.track.length === 0 && runA.report === null && runA.deaths.length === 0, 'loadRun: absent files read as empty, not errors');
  const A = buildRaidData(runA, { rooms, period: 10_000 });
  ok(A.hasTrack === false && A.trackRange === null, 'a trackless run says so');
  const span = A.span.t1 - A.span.t0;
  ok(A.frames.length === Math.floor(span / 10_000) + 1 || A.frames.length === Math.ceil(span / 10_000) + 1, `frames cover the span every period (${A.frames.length} for ${span} ms)`);
  ok(A.agents.map(a => a.character).join() === 'Aaaa,Bbbb' && A.agents[1].role === 'light', 'characters and the light-bearer resolved');
  ok(A.deaths.length === 1 && A.deaths[0].observed === true && A.deaths[0].a === 0 && A.deaths[0].step === null,
    'a raid-observed death with no ledger row is still a death');
  ok(A.markers.some(m => m.kind === 'entered') && A.markers.some(m => m.kind === 'ghost_gone') && A.markers.some(m => m.kind === 'died'), 'timeline markers for entry, ghost and death');
  ok(A.rooms[40] && A.rooms[38] && A.roomNames[598] === null, 'geometry for visited rooms; a destination never reached is named, not drawn');
  const L = A.loose;
  ok(L.failed.length === 1 && L.failed[0].k === 'walk:598', 'loose ends: the failed step');
  ok(L.slowest[0].k === 'walk:598' && L.slowest.find(x => x.k === 'arm.convoy').n === 2 && L.slowest.find(x => x.k === 'arm.convoy').max === 10 * 60_000, 'loose ends: slowest per label with its count');
  ok(L.idle.some(x => x.a === 0 && x.order === 'arm.convoy' && x.room === 38 && x.ms > IDLE_MS), 'loose ends: ten minutes in 38 under arm.convoy is idle');
  ok(L.refusals.some(r => r.kind === 'heal_failed' && r.n === 1), 'loose ends: the refused heal');
  ok(L.unseen.length === 0, 'everybody placed');
  const htmlA = renderHtml(A);
  const backA = extractData(htmlA);
  ok(backA && backA.frames.length === A.frames.length && backA.agents.length === 2, 'the page embeds the data and it parses back');
  ok(!/<script[^>]+src=/i.test(htmlA) && !/<link[^>]+href=/i.test(htmlA) && !/https?:\/\/(?!www\.w3\.org)/.test(htmlA), 'the page loads nothing from the network');
  ok(htmlA.includes('function unitAt(') && htmlA.includes('function sinceWindow('), 'the page runs the same helpers the tests do');

  // with a track
  const dirB = writeRun('with-track', { withTrack: true });
  const B = buildRaidData(loadRun(dirB), { rooms, period: 10_000 });
  ok(B.hasTrack && B.trackRange.n === 31, 'the track is read');
  ok(B.frames.every((f, i) => i === 0 || f.t > B.frames[i - 1].t), 'frames strictly increasing across lead, track and tail');
  ok(B.frames[0].t === B.span.t0 && B.frames.some(f => f.u[0] && f.u[0][U.src] === SRC.inferred), 'the muster before the track is filled from steps and samples');
  const inTrack = B.frames.find(f => f.t === START + 11 * 60_000 + 50_000);
  ok(inTrack && inTrack.u[0][U.row] === 15 && B.S[inTrack.u[0][U.step]] === 'raid.fight', 'track frames carry squares and orders');
  ok(B.frames.filter(f => f.m).length === 11, 'monster lists kept on their frames');
  ok(B.sankey.order.keys.includes('raid.fight') && B.sankey.room.keys.includes('40'), 'both sankeys built');
  const backB = extractData(renderHtml(B));
  ok(backB.frames.length === B.frames.length && backB.hasTrack === true && backB.special.generators.length === 6, 'the page carries the track and the throne room\'s spawn squares');
  const inj = extractData(renderHtml({ ...B, meta: { ...B.meta, name: '</script><b>x' } }));
  ok(inj && inj.meta.name === '</script><b>x', 'a name containing </script> cannot break out of the data block');

  // raid.json is the one required file
  const dirC = path.join(TMP, 'empty'); fs.mkdirSync(dirC);
  let threw = false; try { loadRun(dirC); } catch { threw = true; }
  ok(threw, 'a directory without raid.json is refused');
  fs.writeFileSync(path.join(dirC, 'raid.json'), JSON.stringify({ fleet: 'x', agents: ['z'] }));
  const C = buildRaidData(loadRun(dirC), {});
  ok(C.frames.length >= 0 && C.loose.unseen.length === 1 && extractData(renderHtml(C)) != null, 'a run with nothing but raid.json still renders, and says who was never placed');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the real rehearsal, when this checkout has it
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const real = path.join(HERE, '..', 'substrate', 'raids', 'ghost-shadow-2026-09-25T21-56-08');
  if (fs.existsSync(path.join(real, 'raid.json'))) {
    const R = buildRaidData(loadRun(real), { rooms: {} });
    ok(!R.hasTrack && R.frames.length > 500 && R.agents.length === 22, `rehearsal 24 builds without a track (${R.frames.length} frames)`);
    ok(R.deaths.length >= 15 && R.markers.some(m => m.kind === 'ghost_gone'), 'rehearsal 24: deaths and the kill on the timeline');
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
