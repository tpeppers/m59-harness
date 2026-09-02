#!/usr/bin/env node
// CORE NAVIGATION AND COMBAT TEST
//
//   node tools/m59-core-test.mjs [agent]
//
// Tests fundamental operations on a LIVE character via the
// keeper HTTP API. Each step reports PASS/FAIL/SKIP.

import { loadMap } from './m59-map.mjs';

const agent = process.argv[2] ?? 't1';
const num = parseInt(agent.replace(/\D/g, ''));
const port = 8910 + num;
const BURL = `http://127.0.0.1:${port}`;
let keeperIdentity = null;

let passed = 0, failed = 0, skipped = 0;

function report(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  (' + detail + ')' : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
function skip(name, reason) {
  skipped++; console.log(`  SKIP  ${name}  — ${reason}`);
}

async function get(path) {
  const res = await fetch(BURL + path, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function act(name, args = {}, timeout = 30_000) {
  const t0 = Date.now();
  const res = await fetch(BURL + '/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...keeperIdentity, name, args }),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { ...data, ms: Date.now() - t0 };
}

async function post(path, body = {}, timeout = 5000) {
  return fetch(BURL + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...keeperIdentity, ...body }),
    signal: AbortSignal.timeout(timeout),
  });
}

console.log(`\n=== CORE TEST: ${agent} (${BURL}) ===\n`);

const live = await get('/live');
if (!live?.ok || !Number.isInteger(Number(live.pid))) {
  console.log(`  FATAL: keeper identity endpoint not responding at ${BURL}`);
  process.exit(1);
}
keeperIdentity = { agent: live.agent, character: live.character, keeper_pid: live.pid };

// Pause GOAP so it doesn't fight with the test
await post('/pause').catch(() => {});
await new Promise(r => setTimeout(r, 1000));
console.log(`  GOAP paused`);

// Check keeper
const health = await get('/health');
if (!health?.ok) {
  console.log(`  FATAL: keeper not responding at ${BURL}`);
  process.exit(1);
}
console.log(`  ${health.character} in ${health.room?.name} (map ${health.room?.num})`);
console.log(`  HP ${health.hp?.value}/${health.hp?.max}  Vigor ${health.vigor?.value}  Mana ${health.mana?.value}`);

// Get room view for position and objects
const room0 = await get('/room-view');
const me0 = room0.self;
const roomCols = room0.cols ?? 32;
const roomRows = room0.rows ?? 32;
const objects0 = room0.objects ?? [];
const mobs = objects0.filter(o => !o.is_self && !o.is_player && o.can_attack);

console.log(`  Position: (${me0?.col},${me0?.row})  Room: ${roomCols}x${roomRows}  Objects: ${objects0.length}  Mobs: ${mobs.length}`);

// =====================================================================
// TEST 1: Walk 10 cells east (coarse)
// =====================================================================
console.log(`\n--- TEST 1: Coarse walk (10 cells east) ---`);
if (!me0) {
  skip('coarse walk', 'no position');
} else {
  const tc = Math.min(me0.col + 10, roomCols - 2);
  const tr = me0.row;
  const r = await act('walk', { col: tc, row: tr, maxSteps: 60 });
  if (r.arrived) {
    report(`walk to (${tc},${tr})`, true, `${r.ms}ms, ${r.steps} steps`);
  } else {
    report(`walk to (${tc},${tr})`, false, r.error ?? r.reason ?? 'unknown' + ` (${r.ms}ms)`);
  }
}

// =====================================================================
// TEST 2: Walk 10 cells west (coarse, different direction)
// =====================================================================
console.log(`\n--- TEST 2: Coarse walk (10 cells west) ---`);
const rv1 = await get('/room-view');
const me1 = rv1.self;
if (!me1) {
  skip('coarse walk west', 'no position');
} else {
  const tc = Math.max(me1.col - 10, 2);
  const tr = me1.row;
  const r = await act('walk', { col: tc, row: tr, maxSteps: 60 });
  if (r.arrived) {
    report(`walk to (${tc},${tr})`, true, `${r.ms}ms, ${r.steps} steps`);
  } else {
    report(`walk to (${tc},${tr})`, false, r.error ?? r.reason ?? 'unknown' + ` (${r.ms}ms)`);
  }
}

// =====================================================================
// TEST 3: Diagonal walk (fine)
// =====================================================================
console.log(`\n--- TEST 3: Diagonal walk (5 east, 5 south) ---`);
const rv2 = await get('/room-view');
const me2 = rv2.self;
if (!me2) {
  skip('diagonal walk', 'no position');
} else {
  const tc = Math.min(me2.col + 5, roomCols - 2);
  const tr = Math.min(me2.row + 5, roomRows - 2);
  const r = await act('walk', { col: tc, row: tr, maxSteps: 80 });
  if (r.arrived) {
    report(`walk to (${tc},${tr})`, true, `${r.ms}ms, ${r.steps} steps`);
  } else {
    report(`walk to (${tc},${tr})`, false, r.error ?? r.reason ?? 'unknown' + ` (${r.ms}ms)`);
  }
}

// =====================================================================
// TEST 4: Leave room via exit
// =====================================================================
console.log(`\n--- TEST 4: Leave room via exit ---`);
// Use the 'go' action which picks an exit automatically
const r4 = await act('go', {}, 60_000);
if (r4.left) {
  report('leave room', true, `${r4.ms}ms, arrived in ${r4.arrived_in ?? 'new room'}`);
} else {
  // List available exits for debugging
  const exits = r4.exits ?? [];
  report('leave room', false,
    r4.error ?? r4.reason ?? 'unknown' + ` (${r4.ms}ms)` +
    (exits.length ? ` [exits: ${exits.map(e => e.kind + '→' + e.to).join(', ')}]` : ''));
}

// =====================================================================
// TEST 5: Walk to a mob
// =====================================================================
console.log(`\n--- TEST 5: Walk to a mob ---`);
const rv3 = await get('/room-view');
const me3 = rv3.self;
const mobs3 = (rv3.objects ?? []).filter(o => !o.is_self && !o.is_player && o.can_attack);

if (!me3 || mobs3.length === 0) {
  skip('walk to mob', !me3 ? 'no position' : 'no mobs in room');
} else {
  // Nearest mob
  const target = mobs3.map(m => ({ ...m, dist: Math.hypot(m.col - me3.col, m.row - me3.row) }))
    .sort((a, b) => a.dist - b.dist)[0];
  console.log(`  Target: ${target.name} at (${target.col},${target.row}), ${target.dist?.toFixed(1)} cells away`);

  const r = await act('walk', { col: target.col, row: target.row, maxSteps: 60 }, 45_000);
  if (r.arrived) {
    report(`walk to ${target.name}`, true, `${r.ms}ms`);
  } else {
    report(`walk to ${target.name}`, false, r.error ?? r.reason ?? 'unknown' + ` (${r.ms}ms)`);
  }
}

// =====================================================================
// TEST 6: Attack a mob
// =====================================================================
console.log(`\n--- TEST 6: Attack ---`);
const rv4 = await get('/room-view');
const me4 = rv4.self;
const mobs4 = (rv4.objects ?? []).filter(o => !o.is_self && !o.is_player && o.can_attack);

if (!me4 || mobs4.length === 0) {
  skip('attack', 'no position or mobs');
} else {
  // Nearest mob
  const target = mobs4.map(m => ({ ...m, dist: Math.hypot(m.col - me4.col, m.row - me4.row) }))
    .sort((a, b) => a.dist - b.dist)[0];
  console.log(`  Target: ${target.name} at (${target.col},${target.row}), ${target.dist?.toFixed(1)} cells away`);

  if (target.dist > 3) {
    // Walk close first
    console.log(`  Walking close first...`);
    const walkR = await act('walk', { col: target.col, row: target.row, maxSteps: 40 }, 30_000);
    if (!walkR.arrived) {
      skip('attack', `couldn't reach target: ${walkR.reason}`);
    } else {
      // Re-check position after walk
      const rv5 = await get('/room-view');
      const me5 = rv5.self;
      const dist2 = me5 && target ? Math.hypot(target.col - me5.col, target.row - me5.row) : 99;
      console.log(`  Now ${dist2?.toFixed(1)} cells away`);

      if (dist2 > 3) {
        skip('attack', `still too far (${dist2?.toFixed(1)} cells)`);
      } else {
        const r = await act('attack', { target: target.id }, 10_000);
        if (r.sent) {
          report(`attack ${target.name}`, true, `${r.ms}ms${r.killed ? ', KILLED' : ''}`);
        } else {
          report(`attack ${target.name}`, false, r.error ?? r.reason ?? 'unknown' + ` (${r.ms}ms)`);
        }
      }
    }
  } else {
    const r = await act('attack', { target: target.id }, 10_000);
    if (r.sent) {
      report(`attack ${target.name}`, true, `${r.ms}ms${r.killed ? ', KILLED' : ''}`);
    } else {
      report(`attack ${target.name}`, false, r.error ?? r.reason ?? 'unknown' + ` (${r.ms}ms)`);
    }
  }
}

// =====================================================================
// RESUME GOAP
// =====================================================================
console.log(`\n--- RESUME GOAP ---`);
await post('/resume').catch(() => {});
console.log(`  GOAP resumed`);

// =====================================================================
// SUMMARY
// =====================================================================
console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped ===\n`);
if (failed > 0) process.exit(1);
