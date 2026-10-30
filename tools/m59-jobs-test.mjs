// OFFLINE. Pins m59-jobboard.mjs, the broker's job board: register, heartbeat, orphan by a dead pid and by a recycled
// pid, a stale heartbeat, pause (stop file + kill, finish-on-alert left alone), resume (restart spawned, nothing-to-
// restart cancelled), an owner ending a paused job keeps the pause, persistence round-trip, bounded history. No socket,
// no roster, no process is ever killed or started: every effect is a fake.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { JobBoard, formatJob } from './m59-jobboard.mjs';

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('ok ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); } };

function rig(over = {}) {
  const w = { t: 1_000_000, alive: new Set([100, 200, 300]), starts: new Map(), killed: [], touched: [], spawned: [] };
  const board = new JobBoard({
    fleet: 'prod', now: () => w.t, pidAlive: p => w.alive.has(p), pidStarts: pids => new Map(pids.map(p => [p, w.starts.get(p) ?? null])),
    kill: p => { w.killed.push(p); w.alive.delete(p); }, touch: (f, o) => w.touched.push([f, !!o?.remove]),
    spawnDetached: (cmd, cwd, o) => { w.spawned.push({ cmd, cwd, o }); return 999; }, ...over,
  });
  return { w, board };
}

test('register: a running job with its agents, owner and restart', () => {
  const { board } = rig();
  const j = board.register({ name: 'archerplus', kind: 'fleetscript', agents: 't6,t5', owner_pid: 100, restart: 'bash x.sh', stopFile: 's.stop' });
  assert.equal(j.state, 'running'); assert.deepEqual(j.agents, ['t6', 't5']);
  assert.equal(j.owner_pid, 100); assert.equal(j.restart.cmd, 'bash x.sh'); assert.equal(j.stop.stopFile, 's.stop'); assert.equal(j.kind, 'fleetscript');
});
test('register refuses a job with no name', () => { const { board } = rig(); assert.throws(() => board.register({ agents: ['t1'] })); });
test('sweep: owner pid gone -> orphaned, with the reason', () => {
  const { w, board } = rig();
  const j = board.register({ name: 'x', agents: ['t1'], owner_pid: 200 });
  w.alive.delete(200);
  assert.equal(board.sweep().length, 1); assert.equal(j.state, 'orphaned'); assert.match(j.history.at(-1).why, /gone/);
});
test('sweep: a recycled pid (start time differs) -> orphaned', () => {
  const { w, board } = rig();
  const j = board.register({ name: 'x', agents: ['t1'], owner_pid: 300, owner_start: 5000 });
  w.starts.set(300, 50_000);
  board.sweep(); assert.equal(j.state, 'orphaned'); assert.match(j.history.at(-1).why, /different process/);
});
test('sweep: the same start within tolerance stays running', () => {
  const { w, board } = rig();
  const j = board.register({ name: 'x', agents: ['t1'], owner_pid: 300, owner_start: 5000 });
  w.starts.set(300, 6000);
  board.sweep(); assert.equal(j.state, 'running');
});
test('sweep: a declared heartbeat that stops -> orphaned; one that beats stays', () => {
  const { w, board } = rig();
  const a = board.register({ name: 'a', agents: ['t1'], owner_pid: 100, heartbeat_ms: 30_000 });
  const b = board.register({ name: 'b', agents: ['t2'], owner_pid: 100, heartbeat_ms: 30_000 });
  w.t += 4 * 60_000; board.heartbeat(b.id);
  w.t += 2 * 60_000;
  board.sweep(); assert.equal(a.state, 'orphaned'); assert.equal(b.state, 'running');
});
test('heartbeat from an orphan brings it back to running', () => {
  const { w, board } = rig();
  const j = board.register({ name: 'x', agents: ['t1'], owner_pid: 200 });
  w.alive.delete(200); board.sweep(); assert.equal(j.state, 'orphaned');
  board.heartbeat(j.id); assert.equal(j.state, 'running');
});
test('pause by agents: stop file touched, every pid killed, state paused, restart kept', () => {
  const { w, board } = rig();
  const j = board.register({ name: 'q', agents: ['t17', 't5'], owner_pid: 100, pids: [200], stopFile: 'q.stop', restart: 'node q.mjs' });
  const other = board.register({ name: 'r', agents: ['t1'], owner_pid: 300 });
  const r = board.pause({ agents: ['t5'], by: 'retreat', why: 'Wenbo online' });
  assert.deepEqual(r.paused, [j.id]); assert.equal(j.state, 'paused'); assert.equal(j.paused_by, 'retreat');
  assert.deepEqual(w.touched, [['q.stop', false]]); assert.deepEqual(w.killed.sort(), [100, 200]);
  assert.equal(other.state, 'running'); assert.equal(j.restart.cmd, 'node q.mjs');
});
test('pause all leaves a finish_on_alert job running (the island ride), unless forced', () => {
  const { w, board } = rig();
  const ride = board.register({ name: 'wave', agents: ['t4', 't9'], owner_pid: 100, finish_on_alert: true });
  const r = board.pause({ all: true });
  assert.deepEqual(r.left_to_finish, [ride.id]); assert.equal(ride.state, 'running'); assert.deepEqual(w.killed, []);
  board.pause({ all: true, force: true }); assert.equal(ride.state, 'paused');
});
test('the owner ending a paused job (its child was killed) keeps the pause', () => {
  const { board } = rig();
  const j = board.register({ name: 'q', agents: ['t1'], owner_pid: 100, restart: 'x' });
  board.pause({ ids: [j.id] });
  const e = board.end(j.id, { ok: false });
  assert.equal(e.kept, true); assert.equal(j.state, 'paused');
});
test('resume: restart spawned with its cwd, stop file removed, state resumed with the new pid', () => {
  const { w, board } = rig();
  const j = board.register({ name: 'q', agents: ['t1'], owner_pid: 100, stopFile: 'q.stop', restart: { cmd: 'node q.mjs', cwd: '/r' } });
  board.pause({ ids: [j.id] });
  const r = board.resume({ all: true, by: 'retreat' });
  assert.deepEqual(r.resumed, [{ id: j.id, pid: 999 }]); assert.equal(j.state, 'resumed'); assert.equal(j.resumed_pid, 999);
  assert.deepEqual(w.spawned[0], { cmd: 'node q.mjs', cwd: '/r', o: { resumes: j.id } });
  assert.deepEqual(w.touched.at(-1), ['q.stop', true]);
});
test('resume: a paused job with nothing to restart is cancelled, not left paused for ever', () => {
  const { board } = rig();
  const j = board.register({ name: 'one-off', agents: ['t1'], owner_pid: 100 });
  board.pause({ ids: [j.id] });
  const r = board.resume({ all: true });
  assert.deepEqual(r.cancelled, [j.id]); assert.equal(j.state, 'cancelled');
});
test('cancel: a tripwire-paused job over the launch characters is retired, and resume never brings it back', () => {
  const { w, board } = rig();
  const paused = board.register({ name: 'buy-sapphires', agents: ['t17', 't20'], owner_pid: 100, stopFile: 'b.stop', restart: 'x' });
  board.pause({ ids: [paused.id], by: 'tripwire island-pvp' });
  const live = board.register({ name: 'second-wind-drill', agents: ['t21'], owner_pid: 200, stopFile: 'd.stop', restart: 'y' });
  const other = board.register({ name: 'unrelated', agents: ['t5'], owner_pid: 300, restart: 'z' });
  board.pause({ ids: [other.id] });
  const r = board.cancel({ agents: ['t20', 't21'], by: 'avar-jumpstart', why: 'launch' });
  assert.deepEqual(r.cancelled.map(x => `${x.name}:${x.was}`).sort(), ['buy-sapphires:paused', 'second-wind-drill:running']);
  assert.equal(paused.state, 'cancelled'); assert.equal(live.state, 'cancelled'); assert.equal(paused.cancelled_by, 'avar-jumpstart');
  assert.ok(w.killed.includes(200), 'the live one is stopped, as pause stops it');
  const back = board.resume({ all: true, by: 'tripwire island-pvp' });
  assert.deepEqual(back.resumed.map(x => x.id), [other.id], 'only the job nobody cancelled comes back');
});
test('the restarted run names the paused job it resumes, and the old one records the link', () => {
  const { board } = rig();
  const j = board.register({ name: 'q', agents: ['t1'], owner_pid: 100, restart: 'x' });
  board.pause({ ids: [j.id] }); board.resume({ ids: [j.id] });
  const n = board.register({ name: 'q', agents: ['t1'], owner_pid: 200, resumes: j.id });
  assert.equal(j.resumed_as, n.id); assert.equal(n.resumes, j.id);
});
test('end: done / failed / cancelled, with result and ended_at', () => {
  const { board } = rig();
  const a = board.register({ name: 'a', owner_pid: 100 }), b = board.register({ name: 'b', owner_pid: 100 });
  board.end(a.id, { ok: true, result: '3/3' }); board.end(b.id, { ok: false });
  assert.equal(a.state, 'done'); assert.equal(a.result, '3/3'); assert.ok(a.ended_at); assert.equal(b.state, 'failed');
});
test('list filters by state, agent and kind; report groups and names the held agents', () => {
  const { w, board } = rig();
  board.register({ name: 'a', kind: 'fleetscript', agents: ['t1'], owner_pid: 300 });   // its own pid: pausing b kills 100
  const p = board.register({ name: 'b', agents: ['t2'], owner_pid: 100, restart: 'x' }); board.pause({ ids: [p.id] });
  const o = board.register({ name: 'c', agents: ['t3'], owner_pid: 200 }); w.alive.delete(200);
  const d = board.register({ name: 'd', agents: ['t4'], owner_pid: 100 }); board.end(d.id);
  assert.equal(board.list({ state: 'running' }).length, 1); assert.equal(board.list({ agent: 't2' })[0].id, p.id);
  assert.equal(board.list({ kind: 'fleetscript' }).length, 1);
  const r = board.report();
  assert.equal(r.running.length, 1); assert.equal(r.paused.length, 1); assert.equal(r.orphaned[0].id, o.id); assert.equal(r.recent[0].id, d.id);
  assert.deepEqual(r.held.sort(), ['t1', 't2', 't3']);
});
test('persistence: a board saved and loaded keeps every job and keeps numbering', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'jobs-')), 'jobs-prod.json');
  const { board } = rig({ file });
  const j = board.register({ name: 'q', agents: ['t1'], owner_pid: 100, restart: 'x' }); board.pause({ ids: [j.id] });
  const again = rig({ file }).board.load();
  assert.equal(again.get(j.id).state, 'paused'); assert.equal(again.get(j.id).restart.cmd, 'x');
  const n = again.register({ name: 'n', owner_pid: 100 });
  assert.notEqual(n.id, j.id);
});
test('load of a missing or broken file starts empty instead of throwing', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'jobs-'));
  fs.writeFileSync(join(dir, 'bad.json'), '{not json');
  assert.equal(rig({ file: join(dir, 'bad.json') }).board.load().jobs.size, 0);
  assert.equal(rig({ file: join(dir, 'none.json') }).board.load().jobs.size, 0);
});
test('history is bounded: the oldest ended jobs go, live ones never', () => {
  const { board } = rig({ historyMax: 3 });
  const live = board.register({ name: 'live', owner_pid: 100 });
  for (let i = 0; i < 6; i++) { const j = board.register({ name: 'e' + i, owner_pid: 100 }); board.end(j.id); }
  assert.equal(board.list({ state: 'done' }).length, 3); assert.ok(board.get(live.id));
});
test('handover: export/import round-trip keeps revision and seq, and neither side shares objects', () => {
  const { board } = rig();
  const j = board.register({ name: 'q', agents: ['t1'], owner_pid: 100, restart: 'x' });
  const s = board.exportSnapshot();
  const { board: next } = rig(); next.importSnapshot(s);
  assert.equal(next.revision, board.revision); assert.equal(next.get(j.id).restart.cmd, 'x');
  next.get(j.id).state = 'changed'; s.jobs[0].state = 'changed';
  assert.equal(board.get(j.id).state, 'running');
  assert.equal(next.importSnapshot({ format: 'other' }).ok, false);
  const n2 = next.register({ name: 'n', owner_pid: 100 }); assert.notEqual(n2.id, j.id);
});
test('a warm successor (persist false) never writes the board file', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'jobs-')), 'jobs-prod.json');
  const { board } = rig({ file }); board.persist = false;
  board.register({ name: 'q', owner_pid: 100 });
  assert.equal(fs.existsSync(file), false);
  board.persist = true; board.save(); assert.equal(fs.existsSync(file), true);
});
test('verifyAfterHandover reports what it orphaned and what still runs', () => {
  const { w, board } = rig();
  board.register({ name: 'ok', agents: ['t1'], owner_pid: 100 });
  const d = board.register({ name: 'dead', agents: ['t2'], owner_pid: 200 }); w.alive.delete(200);
  const v = board.verifyAfterHandover();
  assert.equal(v.running_before, 2); assert.equal(v.running, 1); assert.deepEqual(v.orphaned.map(x => x.id), [d.id]);
});
test('formatJob says state, agents, and why a paused or orphaned job stopped', () => {
  const { board } = rig();
  const j = board.register({ name: 'q', agents: ['t1', 't2'], owner_pid: 100, restart: 'x' }); board.pause({ ids: [j.id], why: 'Wenbo' });
  const line = formatJob(j, 1_000_000);
  assert.match(line, /paused/); assert.match(line, /\[t1,t2\]/); assert.match(line, /restart/); assert.match(line, /Wenbo/);
});

// ---------------------------------------------------------------- the client (m59-jobclient.mjs) against a fake broker
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never reached: fetch is faked below
const { registerJob, setJobContext, getJobContext } = await import('./m59-jobclient.mjs');
const atest = async (name, fn) => { try { await fn(); passed++; console.log('ok ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); } };
const realFetch = globalThis.fetch;
function fakeBroker() {
  const board = new JobBoard({ fleet: 'prod', pidAlive: () => true }), calls = [];
  globalThis.fetch = async (_u, o) => {
    const { name, arguments: a } = JSON.parse(o.body).params; calls.push({ name, ...a });
    const run = { job_register: () => board.register(a), job_end: () => board.end(a.id, a),
                  job_heartbeat: () => { if (a.add_pid) board.addPid(a.id, a.add_pid); return board.heartbeat(a.id, a); } }[name];
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(run()) }] } }) };
  };
  return { board, calls };
}
await atest('registerJob: registers with this pid, its restart and stop file; end() marks it done once', async () => {
  const { board, calls } = fakeBroker();
  const h = await registerJob({ name: 'fire-queue', agents: ['t17'], restart: 'node q.mjs', stopFile: 'q.stop', heartbeatMs: 0 });
  assert.equal(h.registered, true);
  const j = board.get(h.id);
  assert.equal(j.owner_pid, process.pid); assert.equal(j.restart.cmd, 'node q.mjs'); assert.equal(j.stop.stopFile, 'q.stop');
  await h.end({ ok: true, result: 'sent' }); await h.end({ ok: false });
  assert.equal(j.state, 'done'); assert.equal(calls.filter(c => c.name === 'job_end').length, 1);
});
await atest('registerJob: finishOnAlert and an added pid reach the board', async () => {
  const { board } = fakeBroker();
  const h = await registerJob({ name: 'wave', agents: ['t4'], finishOnAlert: true, heartbeatMs: 0 });
  h.addPid(4242); await new Promise(r => setTimeout(r, 10));
  assert.equal(board.get(h.id).finish_on_alert, true); assert.deepEqual(board.get(h.id).stop.pids, [4242]);
});
await atest('registerJob with no broker is a no-op handle that never throws', async () => {
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  const said = [];
  const h = await registerJob({ name: 'x', agents: ['t1'], onLog: m => said.push(m) });
  assert.equal(h.registered, false); h.addPid(1); await h.end(); await h.heartbeat();
  assert.equal(said.length <= 1, true);
});
await atest('setJobContext / getJobContext carry the REPL line and clear', async () => {
  setJobContext({ line: 'archerplus agents=t6' }); assert.equal(getJobContext().line, 'archerplus agents=t6');
  setJobContext(null); assert.equal(getJobContext(), null);
});
globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
