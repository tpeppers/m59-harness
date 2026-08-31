// THE UKGOTH JUMP, ON ITS OWN, AS MANY TIMES AS YOU LIKE.
//
//   node tools/m59-jumptest.mjs --agent shadow03 --trials 5
//   node tools/m59-jumptest.mjs --agent shadow03 --trials 5 --vigor 1    force the walk case
//   node tools/m59-jumptest.mjs --agent shadow03 --from 34,19 --to 2
//   node tools/m59-jumptest.mjs --report
//
// CLI CONTRACT: `--from`, `--takeoff`, and `--landing` square pairs are `row,col`
// (KOD/RoomGeometry order).
//
// WHY THIS EXISTS. A full lap is fifty minutes and the jump is four seconds of it. Three
// rounds were spent changing code, waiting an hour, and reading a number that turned out to
// be about the other forty-nine minutes. The operator's suggestion is the right one: put the
// character on the approach, ask for the jump, and read the answer — then a change costs a
// minute instead of an afternoon.
//
// THE CLASSIFICATION IS THE POINT, AND IT IS READ OFF THE FLOOR RATHER THAN THE SQUARE.
// Ukgoth's landing shelf and the gulley beside it are ONE SQUARE APART and 640 units of
// elevation between them, so "row 38" does not say which happened. The floor height does:
//
//     5872   still on the take-off ledge — it never left
//     3840   the landing shelf — the jump worked
//     3200   the gulley — it fell short, and there is no way out
//     room 2 — it crossed, which is the whole errand
//     room 1 — it died on the way
//
// LOOPBACK ONLY. This teleports a character repeatedly and sets its vigor, which is a
// maintenance-port operation and belongs on a test server. The roster says which one.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { fleetName, stateFileFor, rosterGameEndpoint } from './m59-fleetpath.mjs';
import {
  discoverKeeperStates,
  readVerifiedKeeperState,
  resolveKeeperBand,
} from './runtime/keeper-discovery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const PORT   = Number(arg('port', 8971));
const AGENT  = arg('agent', 'shadow03');
const FLEET  = arg('fleet', null) ?? fleetName();
const TRIALS = Number(arg('trials', 5));
const VIGOR  = arg('vigor', null) === null ? null : Number(arg('vigor'));
const ROOM   = Number(arg('room', 599));
const DEST   = Number(arg('to', 2));
const FROM   = (arg('from', '34,19')).split(',').map(Number);
// The tight loop walks these three squares and jumps; --travel runs the whole pipeline.
const DIRECT  = !has('travel');
const TAKEOFF = (arg('takeoff', '36,16')).split(',').map(Number);
const LANDING = (arg('landing', '38,10')).split(',').map(Number);
const PATIENCE = Number(arg('patience', 30)) * 1000;   // the jump is ~4s; 30 is already generous
const BOOK   = join(REPO, 'substrate', `jumptest-${FLEET ?? 'default'}.json`);

const load = () => { try { return JSON.parse(readFileSync(BOOK, 'utf8')); } catch { return { runs: [] }; } };
const save = b => { try { mkdirSync(dirname(BOOK), { recursive: true }); writeFileSync(BOOK, JSON.stringify(b, null, 1)); } catch {} };

if (has('report')) {
  const b = load();
  if (!b.runs.length) { console.log('no jump trials recorded yet'); process.exit(0); }
  for (const run of b.runs.slice(-Number(arg('report', 5) === true ? 5 : arg('report', 5)))) {
    const tally = {};
    for (const t of run.trials) tally[t.outcome] = (tally[t.outcome] ?? 0) + 1;
    console.log(`${new Date(run.at).toISOString().replace('T', ' ').slice(0, 19)}  ` +
      `${run.character}  ${run.trials.length} trial(s)  vigor ${run.vigor ?? 'as found'}`);
    for (const [k, v] of Object.entries(tally).sort((a, c) => c[1] - a[1]))
      console.log('   ' + String(v).padStart(3) + '  ' + k);
  }
  process.exit(0);
}

const endpoint = (() => { try { return rosterGameEndpoint(stateFileFor(FLEET)); } catch { return null; } })();
const host = String(endpoint?.host ?? '');
if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
  console.error(`refusing: fleet "${FLEET}" plays on ${host || '(unknown)'}, which is not loopback.`);
  process.exit(1);
}

function call(name, args = {}, ms = 60000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
      agent: false, timeout: ms }, res => {
      let t = ''; res.setEncoding('utf8');
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try {
          const text = JSON.parse(t)?.result?.content?.[0]?.text ?? t;
          if (typeof text === 'string' && text.startsWith('error: ')) return done({ _error: text.slice(7) });
          done(JSON.parse(text));
        } catch { done({ _error: 'unparseable' }); }
      });
    });
    req.on('error', e => done({ _error: e.message }));
    req.on('timeout', () => { req.destroy(); done({ _error: 'timeout' }); });
    req.end(body);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// THE BROKER'S `status` DOES NOT RELIABLY CARRY A POSITION, and without one every trial
// classifies as "floor unknown" — which is the instrument failing, not the jump. The keeper
// that owns the body answers `/state?fresh=1` with `you` every time, and it is one hop
// closer as well. Discovered once by probing, because the port is assigned at spawn.
let KEEPER_IDENTITY = null;
// THE BAND IS RECORDED, NOT GUESSED. This scanned 8911-8950, which is where keepers used to
// live; they are on `substrate/keeper-bands.json` now -- prod 9011, shadow 9111 -- so the
// sweep found nothing and the tool reported "could not find a keeper for shadow01" about a
// keeper that was up and healthy on 9111. A hard-coded port range is a copy of a fact that
// moved, and this one moved without it.
//
// There is deliberately no old-range fallback: on a multi-fleet host that range belongs
// to somebody else. A missing named assignment is an explicit failure, not permission to
// probe a neighbour's keepers.
async function findKeeper() {
  const band = resolveKeeperBand(FLEET, {
    ...(Object.hasOwn(process.env, 'M59_KEEPER_PORT_BASE')
      ? { override: process.env.M59_KEEPER_PORT_BASE }
      : {}),
  });
  const found = await discoverKeeperStates({
    band,
    expectedAgents: [AGENT],
    liveTimeoutMs: 1500,
    stateTimeoutMs: 8000,
  });
  return found.states.get(AGENT)?.__identity ?? null;
}
async function where() {
  if (KEEPER_IDENTITY == null) return { room: null, pos: null, vigor: null };
  try {
    const s = await readVerifiedKeeperState(KEEPER_IDENTITY, {
      fresh: true,
      timeoutMs: 8000,
    });
    return { room: s?.room?.num ?? null,
             pos: Number.isFinite(s?.you?.row) ? { row: s.you.row, col: s.you.col } : null,
             vigor: s?.vigor?.value ?? s?.vigor ?? null };
  } catch { return { room: null, pos: null, vigor: null }; }
}

// The floor is what distinguishes the shelf from the gulley; the square does not.
const geo = await (async () => {
  const roo = await import('./m59-roo.mjs');
  const { loadMap } = await import('./m59-map.mjs');
  const { movementMapFile } = await import('./m59-map-path.mjs');
  const map = loadMap(movementMapFile());
  const room = map?.rooms?.[String(ROOM)] ?? map?.rooms?.[ROOM];
  return room ? roo.sharedRoomGeometry(room) : null;
})();
const C = 1024;
const floorAt = (r, c) => {
  try { return geo?.floorBaseAtClient((c - 1) * C + C / 2, (r - 1) * C + C / 2) ?? null; }
  catch { return null; }
};

const LEDGE = 5872, SHELF = 3840, PIT = 3200;
function classify(roomNum, pos) {
  if (roomNum === DEST) return 'CROSSED to ' + DEST;
  if (roomNum === 1) return 'DIED';
  if (roomNum !== ROOM) return `left to room ${roomNum}`;
  const f = pos ? floorAt(pos.row, pos.col) : null;
  if (f == null) return 'in ' + ROOM + ', floor unknown';
  if (Math.abs(f - SHELF) <= 96) return 'LANDED on the shelf';
  if (Math.abs(f - PIT) <= 96) return 'FELL into the gulley';
  if (Math.abs(f - LEDGE) <= 96) return 'never left the ledge';
  return `in ${ROOM} at floor ${f}`;
}

async function setUp(character) {
  const dm = await import('./m59-dm.mjs');
  const ids = await dm.resolve([character]).catch(() => ({}));
  const obj = ids[character];
  if (!obj) return { error: `cannot resolve ${character}` };
  const reads = [`show object ${obj}`];
  const { maxHealth, maxMana } = dm.parseCeilings(dm.split(await dm.dm(reads), reads)[0]);
  const cmds = [];
  if (Number.isFinite(maxHealth)) cmds.push(dm.setProp(obj, 'piHealth', maxHealth));
  if (Number.isFinite(maxMana)) cmds.push(dm.setProp(obj, 'piMana', maxMana));
  if (VIGOR != null) cmds.push(dm.setProp(obj, 'piVigor', VIGOR), dm.setProp(obj, 'piExertion', 0));
  cmds.push(`send object ${obj} NewHealth`, `send object ${obj} NewVigor`);
  await dm.dm(cmds, { timeoutMs: 60000 }).catch(() => null);
  return dm.relocate([character], ROOM, { row: FROM[0], col: FROM[1], verify: true })
    .catch(e => ({ error: e.message }));
}

const s0 = await call('status', { agent: AGENT });
if (s0?._error) { console.error(`cannot read ${AGENT}: ${s0._error}`); process.exit(2); }
const character = s0.character ?? AGENT;
KEEPER_IDENTITY = await findKeeper();
if (KEEPER_IDENTITY == null) {
  console.error(`could not find a verified keeper for ${AGENT} in fleet ${FLEET || 'default'}`);
  process.exit(2);
}
console.log(`(reading position straight from keeper ${KEEPER_IDENTITY.port})`);

console.log(`jump trials: ${character} (${AGENT}) in room ${ROOM}, from ${FROM.join(',')} -> room ${DEST}`);
console.log(`${TRIALS} trial(s), vigor ${VIGOR == null ? 'left as found' : 'set to ' + VIGOR}, ` +
            `${PATIENCE / 1000}s each\n`);

const trials = [];
for (let n = 1; n <= TRIALS; n++) {
  const placed = await setUp(character);
  if (placed?.error) { console.log(`  trial ${n}: could not place — ${placed.error}`); continue; }
  await sleep(2000);

  const start = await where();
  const startVigor = start.vigor;
  process.stdout.write(`  trial ${n}: placed at ${start.pos ? start.pos.row + ',' + start.pos.col : '?'} ` +
                       `vigor ${startVigor ?? '?'} ... `);
  if (DIRECT) {
    // THE TIGHT LOOP. No travel pipeline, no route planning: walk the three squares onto
    // the ledge and ask for the jump. This is the four seconds under test and nothing else.
    await call('walk_to', { agent: AGENT, row: TAKEOFF[0], col: TAKEOFF[1] }, 30000);
    const at = await where();
    process.stdout.write(`ledge ${at.pos ? at.pos.row + ',' + at.pos.col : '?'} -> `);
    const j = await call('jump', { agent: AGENT, to_row: LANDING[0], to_col: LANDING[1] }, 30000);
    if (j?._error || j?.jumped === false) process.stdout.write(`refused(${j?.reason ?? j?._error}) `);
  } else {
    await call('travel', { agent: AGENT, to: DEST, background: true });
  }

  const t0 = Date.now();
  let best = null, lastRoom = null, lowVigor = startVigor;
  for (;;) {
    await sleep(600);
    const s = await where();
    const rn = s.room;
    if (Number.isFinite(s.vigor)) lowVigor = Math.min(lowVigor ?? s.vigor, s.vigor);
    const pos = s.pos;
    const what = classify(rn, pos);
    // SETTLE BEFORE BELIEVING IT. A fall takes under a second and this polls at 600ms, so a
    // sample can land MID-FLIGHT — the body passes over the gulley on its way to the shelf,
    // and reading that instant as "FELL" would both mis-score the trial and reset the
    // character while it was still moving. The operator spotted exactly that from inside the
    // game. So a terminal-looking reading has to repeat before it counts.
    if (/CROSSED|DIED|LANDED|FELL/.test(what)) {
      await sleep(1200);
      const s2 = await where();
      const confirmed = classify(s2.room, s2.pos);
      if (confirmed === what) { best = { what, pos: s2.pos ?? pos, rn: s2.room ?? rn }; break; }
      // It moved on: keep watching rather than scoring the frame we happened to catch.
      continue;
    }
    lastRoom = rn;
    if (Date.now() - t0 > PATIENCE) { best = { what, pos, rn }; break; }
  }
  const ms = Date.now() - t0;
  const outcome = best?.what ?? 'no reading';
  trials.push({ n, outcome, ms, start_vigor: startVigor, low_vigor: lowVigor,
                ended: best?.pos ?? null, room: best?.rn ?? lastRoom });
  console.log(`${outcome}  ${Math.round(ms / 1000)}s  vigor ${startVigor ?? '?'}->${lowVigor ?? '?'}` +
              (best?.pos ? `  at ${best.pos.row},${best.pos.col}` : ''));
  await call('cancel', { agent: AGENT }).catch(() => null);
}

const book = load();
book.runs.push({ at: Date.now(), agent: AGENT, character, room: ROOM, from: FROM, to: DEST,
                 vigor: VIGOR, trials });
save(book);

console.log('');
const tally = {};
for (const t of trials) tally[t.outcome] = (tally[t.outcome] ?? 0) + 1;
for (const [k, v] of Object.entries(tally).sort((a, c) => c[1] - a[1]))
  console.log('  ' + String(v).padStart(3) + '/' + trials.length + '  ' + k);
console.log(`\nrecorded in ${BOOK}`);
