#!/usr/bin/env node
// The fleet, with a way to climb inside any of them.
//
//   node tools/m59-fleet.mjs                    list every character
//   node tools/m59-fleet.mjs spec s4            watch Theron in first person
//   node tools/m59-fleet.mjs --serve 8911       the same list as a page, with buttons
//
// WHAT "SPEC" DOES, AND WHY IT IS THIS SIMPLE
//
// Meridian allows ONE connection per character. That is usually the obstacle — it is
// why the broker and a human client cannot both hold a character — but for
// spectating it is the whole mechanism: log a real client in as a character the
// broker is driving and the broker is BUMPED off, no negotiation required.
//
// The client takes its credentials on the command line (clientd3d/config.c:401-460):
//
//     Meridian.exe /H:host /P:port /U:account /W:password /Q
//
// and /Q ("quickstart") skips the splash screen and the login dialog and goes
// straight into the world (statoffl.c:55, login.c:236). So SPEC is one process spawn.
//
// The port matters more than it looks: we point the client at the PROXY, not at the
// server. The proxy is then the only connection to the character, which is what lets
// commands keep reaching it after the broker has been bumped — see m59-proxy.mjs.
//
// SPECTATE VS DUAL OPERATION
//
// Once a human is inside a character there are two modes and nobody has to declare
// which: the proxy watches for client-originated BP_REQ_MOVE, which we never
// generate ourselves, so movement arriving FROM the client is the person at the
// keyboard. `human_driving` in /status is that signal, and this view shows it as
// DUAL rather than SPEC.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFleet } from './m59-fleetpath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Same resolver the broker uses. If this file disagreed with the broker about which
// roster is the fleet, the disagreement would show up as an empty list rather than
// as an error — pass --fleet <name> here exactly as you pass it there.
const { label: FLEET_LABEL, stateFile: STATE } = resolveFleet();

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const CONTROL = Number(arg('--control', 8910));
const PROXY_HOST = arg('--proxy-host', '127.0.0.1');
const PROXY_PORT = Number(arg('--proxy-port', 5961));

// The Steam build is the one actually installed here; the source tree also produces
// a meridian.exe. Either works — it is the same command line.
const CLIENT = arg('--client', process.env.M59_CLIENT ||
  'C:/Program Files (x86)/Steam/steamapps/common/Meridian 59/Meridian.exe');

function roster() {
  const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return Object.entries(raw).map(([agent, v]) => ({
    agent,
    character: v.credentials?.character ?? '?',
    account: v.credentials?.account,
    password: v.credentials?.password,
    mode: v.autopilot?.mode ?? null,
    hunt: v.autopilot?.policy?.hunt ?? null,
  }));
}

async function proxyStatus() {
  try {
    const r = await fetch(`http://127.0.0.1:${CONTROL}/status`);
    return await r.json();
  } catch { return null; }
}

// Which roster entry, if any, is the one currently being watched. The proxy knows the
// player's OBJECT id, which is reassigned by every save game and so cannot be stored;
// it is matched at runtime against whoever the broker most recently reported, and
// failing that we simply report that someone is connected.
function spectatedAgent(status, list) {
  if (!status?.in_game) return null;
  return list.find(a => a.objectId && a.objectId === status.player_id) ?? null;
}

function launch(entry) {
  if (!entry.account || !entry.password)
    throw new Error(`no credentials for ${entry.agent} in ${STATE}`);
  if (!fs.existsSync(CLIENT))
    throw new Error(`client not found at ${CLIENT} — pass --client or set M59_CLIENT`);
  const args = [`/H:${PROXY_HOST}`, `/P:${PROXY_PORT}`,
                `/U:${entry.account}`, `/W:${entry.password}`, '/Q'];
  // /S means "this is a Steam install" and exists to stop the client interpreting a
  // download_time of 9999 as a real download (config.c:445-470). Getting it wrong on
  // a Steam build makes the client try to patch itself instead of connecting.
  if (/steam/i.test(CLIENT)) args.push('/S');
  // LAUNCH IT FROM ITS OWN DIRECTORY.
  //
  // The client resolves `resource\` relative to the working directory, so starting it
  // from anywhere else leaves it unable to find the module DLLs it is told to load.
  // Launched from the repo it took an access violation shortly after the server sent
  // BP_LOAD_MODULE for the character module (Meridian.exe+0x27fd5, reading 0x994000),
  // with char.dll absent from the loaded-module list in the dump — which reads as a
  // stall, because the last thing on the wire is a perfectly healthy ping exchange.
  //
  // Detached, so the viewer outlives this command. The client is a GUI process and
  // has nothing useful to say on stdio.
  const child = spawn(CLIENT, args,
    { cwd: path.dirname(CLIENT), detached: true, stdio: 'ignore', windowsHide: false /* visible on purpose */ });
  child.unref();
  return { pid: child.pid, character: entry.character, account: entry.account,
           through: `${PROXY_HOST}:${PROXY_PORT}` };
}

const GREEN = '\x1b[32m', AMBER = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';

async function list() {
  const list = roster();
  const st = await proxyStatus();
  const watching = spectatedAgent(st, list);
  console.log(`${DIM}client -> ${PROXY_HOST}:${PROXY_PORT} (proxy), control :${CONTROL}${OFF}`);
  if (st?.in_game)
    console.log(`${DIM}connected: player ${st.player_id}, room ${st.known_room ?? '?'}` +
                `${st.human_driving ? ', human driving' : ''}${OFF}`);
  console.log();
  for (const a of list) {
    const isWatched = watching?.agent === a.agent || (!watching && false);
    const tag = isWatched
      ? (st?.human_driving ? `${AMBER}[DUAL]${OFF}` : `${GREEN}[SPEC]${OFF}`)
      : `${DIM}[    ]${OFF}`;
    console.log(`${tag} ${a.agent.padEnd(8)} ${(a.character ?? '').padEnd(16)} ` +
                `${DIM}${a.mode ?? '-'}${a.hunt ? ' ' + a.hunt : ''}${OFF}`);
  }
  console.log(`\n${DIM}watch one:  node tools/m59-fleet.mjs spec <agent>${OFF}`);
}

const PAGE = (rows, st) => `<title>fleet</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem auto;max-width:52rem;padding:0 1rem}
 table{border-collapse:collapse;width:100%}
 td,th{padding:.45rem .6rem;text-align:left;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}
 button{font:inherit;border:0;border-radius:.3rem;padding:.25rem .7rem;cursor:pointer;
   background:#1a7f37;color:#fff}
 button.dual{background:#9a6700}
 button:disabled{opacity:.35;cursor:default}
 .muted{opacity:.6}
</style>
<h1>fleet</h1>
<p class=muted>client &rarr; ${PROXY_HOST}:${PROXY_PORT} (proxy)${
  st?.in_game ? ` &middot; connected: player ${st.player_id}, room ${st.known_room ?? '?'}${
    st.human_driving ? ' &middot; <b>human driving</b>' : ''}` : ' &middot; nobody connected'}</p>
<table><tr><th></th><th>agent</th><th>character</th><th>doing</th></tr>
${rows.map(a => `<tr><td><button onclick="spec('${a.agent}',this)"${
  a.account ? '' : ' disabled'}>SPEC</button></td>
  <td>${a.agent}</td><td>${a.character}</td>
  <td class=muted>${a.mode ?? '-'}${a.hunt ? ' ' + a.hunt : ''}</td></tr>`).join('\n')}
</table>
<script>
async function spec(agent, btn){
  btn.disabled = true; btn.textContent = '...';
  const r = await fetch('/spec/' + agent, {method:'POST'}).then(r=>r.json());
  btn.textContent = r.error ? 'failed' : 'watching';
  if (r.error) { alert(r.error); btn.disabled = false; btn.textContent = 'SPEC'; }
  setTimeout(()=>location.reload(), 2500);
}
setInterval(()=>fetch('/status').then(r=>r.json()).then(s=>{
  if (s && s.human_driving) document.querySelectorAll('button').forEach(b=>b.classList.add('dual'));
}), 3000);
</script>`;

function serve(port) {
  http.createServer(async (req, res) => {
    const send = (code, o, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(o) : o);
    };
    if (req.url === '/status') return send(200, (await proxyStatus()) ?? { session: null });
    const m = req.url.match(/^\/spec\/(.+)$/);
    if (m && req.method === 'POST') {
      const entry = roster().find(a => a.agent === decodeURIComponent(m[1]));
      if (!entry) return send(404, { error: 'no such agent' });
      try { return send(200, launch(entry)); }
      catch (e) { return send(500, { error: e.message }); }
    }
    send(200, PAGE(roster(), await proxyStatus()), 'text/html; charset=utf-8');
  }).listen(port, '127.0.0.1', () =>
    console.error(`fleet view on http://127.0.0.1:${port}`));
}

const cmd = process.argv[2];
if (arg('--serve')) serve(Number(arg('--serve')));
else if (cmd === 'spec') {
  const who = process.argv[3];
  const entry = roster().find(a => a.agent === who || a.character === who);
  if (!entry) { console.error(`no agent or character called "${who}"`); process.exit(1); }
  try { console.log(JSON.stringify(launch(entry), null, 2)); }
  catch (e) { console.error(e.message); process.exit(1); }
} else await list();
