// THE ROOM YOU ARE STANDING IN, DRAWN, ON A URL A GAME CLIENT CAN OPEN.
//
//   node tools/m59-roomserve.mjs                 serve on 8977
//   node tools/m59-roomserve.mjs --port 9100
//   node tools/m59-roomserve.mjs --fleet shadow  whose ledgers to draw on top
//
//   http://127.0.0.1:8977/108                    the room, by number
//   http://127.0.0.1:8977/                       an index of every room with a baked route
//   http://127.0.0.1:8977/here?agent=shadow01    wherever that character is right now
//
// WHY A SERVER AND NOT A FILE. `m59-roomview.mjs` writes an HTML file, which is the right
// shape for "go and look at Ukgoth" and the wrong one for "I am standing somewhere odd and
// want to see it NOW" -- by the time you have found the room number, run the tool and opened
// the file, the thing you were looking at has moved. The debug client's help button points
// here, so "what does the harness think of this room?" is one keypress from inside the game.
//
// GENERATED ON DEMAND AND CACHED ON THE LEDGERS' MTIME. Drawing a room is about a second of
// work and the ledgers move constantly, so a cache keyed on "has anything been written
// since" gives a fresh picture without redrawing on every refresh.
//
// LOOPBACK ONLY, and that is not decoration: these pages carry positions, refusals and death
// sites for a live fleet. `m59-roomview.mjs` redacts character names; it does not make the
// rest of it fit to publish. Bind to localhost and leave it there.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, existsSync,
         readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRoom, renderPage } from './m59-roomview.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const PORT = Number(flag('port', 8977));
const FLEET = flag('fleet', null) ?? fleetName();

// AM I THE PROGRAM, OR AM I A LIBRARY? Computed before anything that exits or binds, because
// the two things below this line -- `--help` calling process.exit(0), and `server.listen` --
// are both fatal to an importer, and the TUI imports this file to run its G key.
const IS_ENTRY = !!process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (IS_ENTRY && argv.includes('--help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

// The newest mtime across everything a page is drawn from. Cheap, and it changes exactly
// when the picture would change.
function ledgerStamp() {
  let newest = 0;
  for (const p of ['substrate/transits', 'substrate/tactics', 'substrate/m59-routes.json',
                   'substrate/m59-map.json', 'substrate/m59-safespots.json']) {
    const full = join(REPO, p);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        for (const f of readdirSync(full)) {
          const s2 = statSync(join(full, f));
          if (s2.mtimeMs > newest) newest = s2.mtimeMs;
        }
      } else if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* a missing ledger is a thinner picture, not an error */ }
  }
  return newest;
}

const cache = new Map();

function pageFor(room) {
  const stamp = ledgerStamp();
  const hit = cache.get(room);
  if (hit && hit.at === stamp) return hit.html;
  const data = collectRoom(room, { fleets: FLEET ? [FLEET] : null });
  const html = renderPage(data);
  cache.set(room, { at: stamp, html });
  return html;
}

function roomsWithRoutes() {
  try {
    const t = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-routes.json'), 'utf8'));
    const m = JSON.parse(readFileSync(join(REPO, 'substrate', 'm59-map.json'), 'utf8'));
    return Object.keys(t.rooms ?? {})
      .map(Number).filter(Number.isFinite)
      .map(n => ({ num: n, name: m.rooms?.[String(n)]?.name ?? ('room ' + n),
                   routes: Object.keys(t.rooms[String(n)]?.routes ?? {}).length }))
      .sort((a, b) => a.num - b.num);
  } catch { return []; }
}

// Where a character is, so the client can ask for "here" without knowing a room number.
async function whereIs(agent, port) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                                params: { name: 'fleet', arguments: {} } });
  return await new Promise(done => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 8000 }, res => {
      let t = '';
      res.on('data', c => { t += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(JSON.parse(t).result.content[0].text);
          const row = (j.fleet ?? []).find(c => c.agent === agent || c.character === agent);
          done(row?.room_num ?? null);
        } catch { done(null); }
      });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const send = (code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname === '/here') {
      const agent = url.searchParams.get('agent');
      const brokerPort = Number(url.searchParams.get('broker') ?? 8971);
      const room = agent ? await whereIs(agent, brokerPort) : null;
      if (room == null) {
        return send(404, 'text/plain; charset=utf-8',
          'cannot tell where "' + (agent ?? '(no agent given)') + '" is - ask /<room> directly');
      }
      res.writeHead(302, { location: '/' + room });
      return res.end();
    }
    const m = url.pathname.match(/^\/(\d+)$/);
    if (m) return send(200, 'text/html; charset=utf-8', pageFor(Number(m[1])));
    if (url.pathname === '/') {
      const rows = roomsWithRoutes();
      const style = 'body{font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#14161a;'
                  + 'color:#d8dee9;margin:2rem}a{color:#8fb7ff;text-decoration:none}'
                  + 'a:hover{text-decoration:underline}td{padding:.15rem .8rem .15rem 0}';
      return send(200, 'text/html; charset=utf-8',
        '<title>' + TITLE + '</title><meta name=viewport content="width=device-width,initial-scale=1">'
        + '<style>' + style + '</style>'
        + '<h2>rooms with a baked route - fleet "' + (FLEET ?? '(unnamed)') + '"</h2><table>'
        + rows.map(r => '<tr><td><a href="/' + r.num + '">' + r.num + '</a></td><td>'
                      + r.name + '</td><td>' + r.routes + ' route(s)</td></tr>').join('')
        + '</table>');
    }
    send(404, 'text/plain; charset=utf-8', 'try / or /<room number>, e.g. /108');
  } catch (e) {
    send(500, 'text/plain; charset=utf-8', 'could not draw that room: ' + e.message);
  }
});

// ---------------------------------------------------------------- start it from elsewhere
//
// THE TUI'S "G" KEY NEEDS TO ASK AND TO START, so this file has to be importable -- and
// until now importing it BOUND A SOCKET, because `server.listen` ran at the top level. That is
// the same trap CLAUDE.md records against m59-broker.mjs ("importing runs it: it tries to take
// the fleet lock and start rejoin timers") and the same fix m59-supervise.mjs already took: guard
// the main loop on being the entry point, and the pure parts can be read by anybody.

const SUB = join(REPO, 'substrate');
const PID_FILE = join(SUB, 'roomserve.pid');
const LOG_FILE = join(SUB, 'roomserve.log');

// The index page's own <title>, and the only thing that tells "our site is here" from
// "something else has 8977". A port that answers is not an answer -- that distinction is why
// m59-which.mjs grew an INDETERMINATE verdict, and the cost of skipping it is a browser opened
// on somebody else's server. It is NOT enough to tell this checkout's copy from another's,
// which is why nothing here is ever killed on the strength of it.
export const TITLE = 'Geometry Debug Maps';
export const MAPS_PORT = PORT;

const probe = (port, path = '/', ms = 1500) => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path, timeout: ms }, res => {
    let body = '';
    res.setEncoding('utf8');
    // The title is in the <head>, so a few kilobytes settles it. Reading a whole room index
    // to answer "is this ours" would make the check cost as much as the page.
    res.on('data', chunk => { if (body.length < 4096) body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('timeout', () => { req.destroy(); resolve(null); });
  req.on('error', () => resolve(null));
});

const readPid = () => {
  try {
    if (!existsSync(PID_FILE)) return null;
    const rec = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    // A pid file is a claim, not a fact: the process may be long gone and the number reused.
    // It is only ever used to say "we started this one", never to decide it is alive.
    return rec && Number.isFinite(rec.pid) ? rec : null;
  } catch { return null; }
};

/**
 * Is the geometry site up, is it OURS, or is something else on the port?
 *
 * Three answers rather than two, for the same reason m59-which.mjs has three: a port that
 * does not answer and a port answering with somebody else's server are different problems and
 * only one of them is fixed by starting ours.
 */
export async function status() {
  const ours = readPid();
  const served = await probe(PORT);
  const isSite = !!served && typeof served.body === 'string' && served.body.includes(TITLE);
  if (ours && isSite) return { running: true, ours: true, pid: ours.pid, port: PORT, fleet: FLEET };
  if (isSite) return { running: true, ours: false, port: PORT, fleet: FLEET,
    why: `something is serving ${TITLE} on ${PORT} and this checkout did not start it` };
  if (served) return { running: false, blocked: true, port: PORT,
    why: `port ${PORT} is answering and it is not ${TITLE}` };
  return { running: false, port: PORT, fleet: FLEET };
}

/**
 * Start it detached, logging into substrate/ beside every other service log.
 *
 * BEST EFFORT, ALWAYS -- every failure returns rather than throws, because the caller is an
 * operator pressing a key and a thrown error there takes the whole terminal down.
 *
 * AND IT WAITS FOR THE PAGE, not for the process. A browser opened at a port that is still
 * binding shows a connection error and teaches the operator that the key is broken.
 */
export async function start({ log = console.error, waitMs = 20_000 } = {}) {
  const now = await status();
  if (now.running && now.ours) { log(`${TITLE} already up on ${PORT} (pid ${now.pid})`); return { ok: true, ...now }; }
  if (now.running) { log(now.why); return { ok: false, ...now }; }
  if (now.blocked) { log(now.why); return { ok: false, ...now }; }

  mkdirSync(SUB, { recursive: true });
  const fd = openSync(LOG_FILE, 'a');
  // `process.execPath` rather than 'node': this repository is run from a Windows shell where
  // 'node' on PATH is not always the node that is running us.
  const args = [join(HERE, 'm59-roomserve.mjs'), '--port', String(PORT)];
  if (FLEET) args.push('--fleet', FLEET);
  const child = spawn(process.execPath, args,
                      { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, fleet: FLEET,
                                           at: Date.now() }, null, 2));

  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 300));
    const s = await status();
    if (s.running) return { ok: true, ...s, started: true };
  }
  return { ok: false, running: false, port: PORT, pid: child.pid,
           why: `started pid ${child.pid} but ${PORT} did not answer within ` +
                `${Math.round(waitMs / 1000)}s — read ${LOG_FILE}` };
}

// RUN ONLY WHEN RUN. See the note above: importing this file used to bind port 8977.
if (IS_ENTRY) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('room views on http://127.0.0.1:' + PORT + '/   (fleet "' + (FLEET ?? '(unnamed)') + '")');
    console.log('  /108  a room     /  the index     /here?agent=shadow01  wherever it is now');
  });
}
