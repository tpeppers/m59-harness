#!/usr/bin/env node
// m59-spectate-route-test.mjs — THE BROKER TALKS TO WHICHEVER KEEPER IS DRIVING THE BODY.
//
//   node tools/m59-spectate-route-test.mjs
//
// Offline: no socket, no roster, no broker. The decision (m59-spectate-route.mjs) is pure and is
// driven here with fake heartbeats, fake pids and fake `/live` replies; scanKeepers is driven with a
// fake fetch and a temporary heartbeat directory; the broker, the keeper process and the launcher are
// read as TEXT (importing m59-broker.mjs runs it -- see CLAUDE.md).
//
// WHAT IT PINS. 2026-11-01, t17 (Zoot): the operator relinquished control to a spectate keeper, the
// broker went on reading the offline normal keeper, `fleet` put him in room 566 while he walked the
// East Tower (2013), and autopilot start, travel, cast and supply all went to a process with no
// socket. The fix routes to the spectate keeper; this suite fails if any half of that comes undone:
//   - spectate keeper alive and proven      -> routed there
//   - dead, stale, stopped, other roster     -> the normal keeper, as before
//   - a port answering for the wrong agent or pid -> refused, never routed and never swapped for the
//     offline keeper (the cached-port bugs of 2026-08-26 and 2026-10-04)
//   - human-held with no spectate keeper     -> hands-off, as before
//   - while a spectate keeper holds the body, the normal keeper is never asked to log in

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolSource } from './autopilot/source.mjs';
import {
  chooseKeeperRoute, spectateHolds, humanHeld, readSpectateBeat, writeSpectateBeat, listSpectateBeats,
  SPECTATE_BEAT_MAX_AGE_MS, SPECTATE_PROBE_MAX_AGE_MS, rowHumanHeld,
} from './m59-spectate-route.mjs';
import { scanKeepers, overlaySpectateKeepers } from './m59-keeper.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` -- ${extra}` : ''}`); }
};

const TOOLS = dirname(fileURLToPath(import.meta.url));
// Sources are read with their line endings normalised: a Windows checkout has CRLF, the repository LF.
const lf = text => String(text).split('\r\n').join('\n');
const NOW = 1_800_000_000_000;
const ROSTER = 'C:/code/m59-lab/prod-deploy/substrate/fleets/prod.json';
const SPID = 41234, SPORT = 50123;
const alive = new Set([SPID]);
const pidAlive = pid => alive.has(pid);
const beat = (over = {}) => ({ pid: SPID, at: NOW - 1000, agent: 't17', character: 'Zoot', player: 4464,
  port: 8932, attach_port: 8932, http_port: SPORT, roster: ROSTER, fleet: 'prod', state: 'driving', ...over });
const live = (over = {}) => ({ schema: 'm59-keeper-live/v1', agent: 't17', character: 'Zoot', pid: SPID,
  in_game: true, connected: true, spectate: { player: 4464, attach_port: 8932 }, ...over });
const probe = (over = {}) => ({ port: SPORT, pid: SPID, at: NOW - 500, value: live(), ...over });
const route = (o = {}) => chooseKeeperRoute({ agent: 't17', character: 'Zoot', roster: ROSTER, now: NOW, pidAlive, ...o });

console.log('\nthe decision: alive and proven -> routed there');
{
  const d = route({ beat: beat(), probe: probe() });
  ok('a proven spectate keeper is the route', d.route === 'spectate', JSON.stringify(d));
  ok('...to the port in its heartbeat, addressed to its pid', d.port === SPORT && d.pid === SPID);
  ok('...and it holds the body', d.holds === true);
  ok('the reply it was proven on travels with the decision', d.sample?.agent === 't17');
  ok('a reattaching spectate keeper is still the one holding the body',
     route({ beat: beat({ state: 'reattaching' }), probe: probe({ value: live({ connected: false }) }) }).route === 'spectate');
  ok('roster paths compare as paths (case, slashes)',
     route({ beat: beat({ roster: ROSTER.toUpperCase().replace(/\//g, '\\') }), probe: probe() }).route === 'spectate');
}

console.log('\nthe decision: not yet proven -> ask first');
{
  const d = route({ beat: beat() });
  ok('a heartbeat with a port and no probe asks /live first', d.route === 'probe' && d.port === SPORT && d.pid === SPID);
  ok('...and already holds the body while it asks', d.holds === true);
  ok('a probe of another port is a probe of another process', route({ beat: beat(), probe: probe({ port: SPORT + 1 }) }).route === 'probe');
  ok('a probe of another pid is a probe of another process', route({ beat: beat(), probe: probe({ pid: SPID + 1 }) }).route === 'probe');
  ok(`a probe older than ${SPECTATE_PROBE_MAX_AGE_MS}ms is asked again`,
     route({ beat: beat(), probe: probe({ at: NOW - SPECTATE_PROBE_MAX_AGE_MS - 1 }) }).route === 'probe');
}

console.log('\nthe decision: dead or stale -> the normal keeper, as before');
{
  const cases = {
    'no heartbeat at all': { beat: null },
    'a stale heartbeat': { beat: beat({ at: NOW - SPECTATE_BEAT_MAX_AGE_MS - 1 }) },
    'a heartbeat with no time': { beat: beat({ at: undefined }) },
    'a stopped spectate keeper': { beat: beat({ state: 'stopped: attachment gone for 15s' }) },
    'a dead pid': { beat: beat({ pid: 999 }) },
    'a heartbeat for another agent': { beat: beat({ agent: 't18' }) },
    "another roster's spectate keeper (a lab fleet's t17)": { beat: beat({ roster: 'C:/code/lab/substrate/fleets/shadow.json' }) },
  };
  for (const [why, o] of Object.entries(cases)) {
    const d = route({ ...o, probe: probe() });
    ok(`${why} -> keeper, not held`, d.route === 'keeper' && d.holds === false, JSON.stringify(d));
  }
  const old = route({ beat: beat({ http_port: undefined }), probe: probe() });
  ok('a spectate keeper with no HTTP port (predates routing, or not bound yet) is not routed to', old.route === 'keeper');
  ok('...but it HOLDS the body, so the normal keeper must not log in', old.holds === true);
  const noRoster = route({ beat: beat({ roster: undefined }), probe: probe() });
  ok('a heartbeat naming no roster is never routed to, and still holds', noRoster.route === 'keeper' && noRoster.holds === true);
}

console.log('\nthe decision: wrong agent or pid answering -> refused');
{
  const cases = {
    'another agent answering on the port': live({ agent: 't18' }),
    'another pid answering on the port (a recycled port)': live({ pid: SPID + 7 }),
    'another character answering on the port': live({ character: 'Statler' }),
    'a reply with no pid': live({ pid: undefined }),
    'a reply with no in_game': live({ in_game: undefined }),
  };
  for (const [why, value] of Object.entries(cases)) {
    const d = route({ beat: beat(), probe: probe({ value }) });
    ok(`${why} -> refused`, d.route === 'refused', JSON.stringify(d));
    ok(`  ...and still held, so the offline keeper is not used instead`, d.holds === true);
  }
  const silent = route({ beat: beat(), probe: probe({ value: null, error: 'ECONNREFUSED' }) });
  ok('a port that did not answer -> refused, naming why', silent.route === 'refused' && /ECONNREFUSED/.test(silent.why));
}

console.log('\nthe pilot flag: human-held with no spectate keeper -> hands-off as before');
{
  const spectating = route({ beat: beat(), probe: probe() });
  const nobody = route({ beat: null });
  const refused = route({ beat: beat(), probe: probe({ value: live({ pid: 1 }) }) });
  ok('piloted, nobody driving -> hands-off', humanHeld({ piloted: true, route: nobody }) === true);
  ok('piloted, spectate keeper driving -> commands go through', humanHeld({ piloted: true, route: spectating }) === false);
  ok('piloted, spectate keeper unproven -> still hands-off', humanHeld({ piloted: true, route: refused }) === true);
  ok('not piloted -> never hands-off on this account', humanHeld({ piloted: false, route: nobody }) === false);
  ok('spectateHolds is the conservative half: no probe needed',
     spectateHolds(beat(), { agent: 't17', roster: ROSTER, now: NOW, pidAlive }).holds === true);
  ok('spectateHolds with no liveness check refuses to guess',
     spectateHolds(beat(), { agent: 't17', roster: ROSTER, now: NOW }).holds === false);
}

console.log('\nthe heartbeat on disk');
const tmp = mkdtempSync(join(tmpdir(), 'spectate-route-'));
try {
  const dir = join(tmp, 'spectate');
  ok('a heartbeat is written atomically and read back', writeSpectateBeat(join(dir, 't17.json'), beat()) &&
     readSpectateBeat('t17', { dir })?.http_port === SPORT);
  writeFileSync(join(dir, 't17-roster.json'), JSON.stringify({ t17: { credentials: { account: 'a' } } }));
  writeFileSync(join(dir, 't17.log'), 'log');
  writeFileSync(join(dir, 'broken.json'), '{not json');
  const all = listSpectateBeats({ dir });
  ok('the roster copy, the log and a broken file are not heartbeats', all.length === 1 && all[0].agent === 't17',
     JSON.stringify(all.map(b => b.agent)));
  ok('a missing heartbeat reads as none', readSpectateBeat('t99', { dir }) === null);

  console.log('\nscanKeepers: the spectate keeper replaces the offline band keeper');
  const bandPort = 9017;
  const fakeFetch = answers => async url => {
    const port = Number(new URL(url).port);
    const v = answers[port];
    if (v === undefined) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => v };
  };
  const band = { base: 9011, end: 9020 };
  const offline = { agent: 't17', character: 'Zoot', pid: 777, in_game: true, connected: false };
  const scan = (answers, extra = {}) => scanKeepers({ fleet: 'prod', band, fetchImpl: fakeFetch(answers),
    spectateDir: dir, roster: ROSTER, now: () => NOW, pidAlive, ...extra });
  {
    const k = (await scan({ [bandPort]: offline, [SPORT]: live() })).get('t17');
    ok('t17 answers from the spectate keeper', k?.port === SPORT && k?.pid === SPID && k?.spectate === true, JSON.stringify(k));
    ok('...and says which band keeper it replaced', k?.band_port === bandPort);
  }
  {
    const k = (await scan({ [bandPort]: offline, [SPORT]: live({ pid: 1 }) })).get('t17');
    ok('a spectate port answering with the wrong pid is not believed', k?.port === bandPort && !k?.spectate);
    ok('...and the band entry says a spectate keeper holds it', /pid mismatch/.test(k?.spectate_holds ?? ''), JSON.stringify(k));
  }
  {
    const k = (await scan({ [bandPort]: offline, [SPORT]: live() }, { now: () => NOW + SPECTATE_BEAT_MAX_AGE_MS + 5000 })).get('t17');
    ok('a stale heartbeat leaves the band keeper alone', k?.port === bandPort && !k?.spectate && !k?.spectate_holds);
  }
  {
    const k = (await scan({ [bandPort]: offline, [SPORT]: live() }, { spectate: false })).get('t17');
    ok('spectate:false is the band alone', k?.port === bandPort && !k?.spectate);
  }
  {
    const k = (await scan({ [SPORT]: live() }, { band: { base: 9101, end: 9101 } })).get('t17');
    ok('a spectate keeper is found even with no band keeper for its agent', k?.port === SPORT && k?.band_port === null);
  }
  console.log("\noverlaySpectateKeepers: a caller that scans its own band (FleetScript's lease) sees the driver");
  {
    // holdKeeper scanned the band itself and took work/movement/economy on the OFFLINE band keeper of a
    // relinquished character, while the spectate keeper steered the body with nothing held.
    const found = new Map([['t17', { port: bandPort, character: 'Zoot', pid: 777 }], ['t3', { port: 9012, character: 'Statler', pid: 555 }]]);
    await overlaySpectateKeepers(found, { roster: ROSTER, spectateDir: dir, fetchImpl: fakeFetch({ [SPORT]: live() }),
                                          now: () => NOW, pidAlive });
    const k = found.get('t17');
    ok('the lease target is the spectate keeper', k?.port === SPORT && k?.pid === SPID && k?.spectate === true, JSON.stringify(k));
    ok('...with the identity a write must carry (character and pid)', k?.character === 'Zoot');
    ok('every other agent keeps its band entry', found.get('t3')?.port === 9012 && !found.get('t3')?.spectate);
    const unproven = new Map([['t17', { port: bandPort, character: 'Zoot', pid: 777 }]]);
    await overlaySpectateKeepers(unproven, { roster: ROSTER, spectateDir: dir, fetchImpl: fakeFetch({ [SPORT]: live({ agent: 't4' }) }),
                                             now: () => NOW, pidAlive });
    ok('a spectate port answering for somebody else is never the lease target', unproven.get('t17')?.port === bandPort &&
       !unproven.get('t17')?.spectate && !!unproven.get('t17')?.spectate_holds);
    const other = new Map([['t17', { port: bandPort, character: 'Zoot', pid: 777 }]]);
    await overlaySpectateKeepers(other, { roster: 'C:/elsewhere/substrate/fleets/prod.json', spectateDir: dir,
                                          fetchImpl: fakeFetch({ [SPORT]: live() }), now: () => NOW, pidAlive });
    ok("another checkout's roster is never routed to", other.get('t17')?.port === bandPort && !other.get('t17')?.spectate);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

console.log('\nrowHumanHeld: what a fleet-row reader steps over');
{
  ok('a row saying human_held:true is hands-off', rowHumanHeld({ piloted: { pid: 1 }, human_held: true }) === true);
  ok('a piloted row a spectate keeper drives (human_held:false) is NOT hands-off',
     rowHumanHeld({ piloted: { pid: 1 }, human_held: false }) === false);
  ok('a row from an older broker (no human_held) still means piloted', rowHumanHeld({ piloted: { pid: 1 } }) === true);
  ok('...and an unpiloted one is free', rowHumanHeld({ piloted: null }) === false && rowHumanHeld({}) === false);
  ok('no row is not human-held (the caller decides what a missing row means)', rowHumanHeld(null) === false && rowHumanHeld(undefined) === false);
}

console.log('\nthe broker routes through the decision (read as text: importing it runs it)');
{
  // Line endings normalised: a Windows checkout has CRLF, the repository LF.
  const broker = lf(readToolSource(join(TOOLS, 'm59-broker.mjs'), 'utf8'));
  const fn = (name, from = `async function ${name}(`) => {
    const i = broker.indexOf(from);
    if (i < 0) return '';
    const j = broker.indexOf('\n}\n', i);
    return broker.slice(i, j);
  };
  ok('the broker imports the pure decision', /from '\.\/m59-spectate-route\.mjs'/.test(broker) && /chooseKeeperRoute\(/.test(broker));
  ok('keeperAction sends to the ORDER target (spectate first)', /verifiedKeeperOrderTarget\(agent, index\)/.test(fn('keeperAction')));
  ok('keeperPolicy sends to the ORDER target', /verifiedKeeperOrderTarget\(agent, index\)/.test(fn('keeperPolicy')));
  ok('...and also to the normal keeper, so its rejoin re-applies the current orders',
     /if \(!target\.spectate\) return result;[\s\S]*verifiedKeeperWriteTarget\(agent, index\)\.then\(push\)/.test(fn('keeperPolicy')));
  ok('keeperGet reads from a routed spectate keeper', /proveSpectateRoute\(agent\)/.test(fn('keeperGet')));
  const order = fn('verifiedKeeperOrderTarget');
  ok('every ORDER re-proves the spectate keeper (force)', /proveSpectateRoute\(agent, \{ force: true \}\)/.test(order));
  ok('a held but unproven spectate keeper gets nothing, and neither does the offline keeper',
     /if \(sp\.holds\)\s*throw new Error/.test(order) &&
     order.indexOf('if (sp.holds)') < order.indexOf('return verifiedKeeperWriteTarget(agent, index)'));
  ok('a routed order is addressed to the HEARTBEAT pid', /identity: Object\.freeze\(\{ agent, character, pid: sp\.pid \}\)/.test(order));
  const prove = fn('proveSpectateRoute');
  ok('the proof is a /live of the heartbeat port', /keeperLiveAt\(ask\.port/.test(prove));
  ok("the proof feeds the spectate keeper's own liveness book, never the normal keeper's",
     /link\.liveness\.observe\(decision\.sample/.test(prove) && !/this\._liveness/.test(prove));
  const st = fn('spectateKeeperState');
  ok("a spectate /state is identity-checked against the heartbeat's pid", /validateKeeperSample\(j, \{ agent, character:[\s\S]*pid: route\.pid/.test(st));
  // Lifecycle stays on the process this broker spawned.
  for (const name of ['stopRecordedKeeper', 'keeperLeaveAndStop', 'wakeDormant', 'sleepDormant']) {
    const body = fn(name);
    ok(`${name} still addresses the normal keeper`, body && /verifiedKeeperWriteTarget\(/.test(body) && !/verifiedKeeperOrderTarget/.test(body));
  }
  ok('the /rejoin sweep still addresses the normal keeper',
     /const target = await verifiedKeeperWriteTarget\(agent, index\);\s*const port = target\.port;/.test(broker));
  // One driver per character.
  ok('the rejoin sweep skips a character a spectate keeper holds', /if \(spectateHolds\(agent\)\) continue;/.test(broker));
  ok('...in the preflight liveness fan-out too', /!pilotOf\(agent\) && !spectateHolds\(agent\)\)/.test(broker));
  ok('...and again right before the /rejoin is sent', /pilotOf\(agent\) \|\|\s*spectateHolds\(agent\) \|\|/.test(broker));
  ok('a keeper handoff treats a spectate-held body as piloted (dormant swap, no login over them)',
     /const piloted = !!pilotOf\(agent\) \|\| spectateHolds\(agent\);/.test(broker));
  ok('a staged start does not wake a spectate-held character', /staged\.filter\(agent => pilotOf\(agent\) \|\| spectateHolds\(agent\)\)/.test(broker));
  // `piloted` is informational while a keeper drives.
  ok('humanHeld is the pure rule', /spectateHumanHeld\(\{ piloted: !!pilotOf\(agent\), route: spectateRouteNow\(agent\) \}\)/.test(broker));
  ok('combat orders skip only a human-held character',
     /unavailable: humanHeld\(agent\)/.test(broker) && /if \(humanHeld\(a\.agent\)\) return \{ skipped: true/.test(broker));
  // The proxy object.
  const proxyStart = broker.indexOf('class KeeperProxy {');
  const proxy = broker.slice(proxyStart, broker.indexOf('\n}\n', proxyStart));
  ok('KeeperProxy.live/inGame/phantom read the routed status first',
     ['get live()', 'get inGame()', 'get phantom()'].every(g => {
       const i = proxy.indexOf(g); return i >= 0 && /this\._routedStatus\(\)/.test(proxy.slice(i, i + 200));
     }));
  const refresh = proxy.slice(proxy.indexOf('async _refreshState('), proxy.indexOf('async _refreshSpectateState('));
  ok('_refreshState routes to the spectate keeper before reading the normal one',
     refresh.indexOf('proveSpectateRoute(this.name)') >= 0 &&
     refresh.indexOf('proveSpectateRoute(this.name)') < refresh.indexOf('keeperState(this.name'));
  ok('a cached snapshot is never served across a route change', /this\._stateRoute === this\._routeKey\(\)/.test(refresh));
  ok('the fleet row says which keeper is driving', /driver: s instanceof KeeperProxy \? s\.driver : null/.test(broker));
  ok('...and whether to keep hands off (human_held)', /human_held: humanHeld\(name\),/.test(broker));
  ok('pilot status says whether each claim is relinquished', /human_held: humanHeld\(agent\),/.test(broker));

  // GAP 1: COMMANDER LEASES. A relinquished character is leasable; one a person plays is not.
  const lease = broker.slice(broker.indexOf("name: 'commander_lease',"), broker.indexOf("name: 'tactical_intent',"));
  const acquire = lease.slice(lease.indexOf("if (a.action === 'acquire')"), lease.indexOf('const record = commanderLeases.issue('));
  ok('commander_lease acquire refuses only a HUMAN-HELD character (proven fresh)',
     /if \(await humanHeldNow\(row\.agent\)\) throw new Error\('agent is being played by a local Meridian client'\)/.test(acquire) &&
     !/pilotOf\(row\.agent\)/.test(acquire));
  ok('...and finds the session of a character held at startup (routedSession)', /const s = routedSession\(row\.agent\);/.test(acquire));
  const heartbeat = lease.slice(lease.indexOf("if (a.action !== 'heartbeat')"));
  ok('a person taking control back ends the lease on the next heartbeat',
     /if \(await humanHeldNow\(row\.agent\)\) throw new Error\('a person took the controls back'\)/.test(heartbeat));
  ok('the RTS read offers a relinquished character for leasing', /else if \(humanHeld\(agent\)\) blocked = 'agent is being played by a local Meridian client'/.test(broker));
  const release = fn('releaseCommanderClaims');
  ok('releasing a claim the departed spectate keeper held does not throw',
     /try \{ released = \(await p\.releaseFaculties/.test(release) && /release_error/.test(release));
  ok('humanHeldNow proves the route before deciding',
     /async function humanHeldNow\(agent\) \{[\s\S]{0,200}proveSpectateRoute\(agent, \{ force: true \}\)[\s\S]{0,80}return humanHeld\(agent\);/.test(broker));
  ok('routedSession only mints a proxy for a rostered keeper-backed character a spectate keeper holds',
     /function routedSession\(agent\) \{[\s\S]{0,200}if \(!agentIndices\.has\(agent\) \|\| !inAnyRoster\(agent\) \|\| !spectateHolds\(agent\)\) return null;/.test(broker));
  ok('the liveness sweep adopts spectate-held characters so their proof stays fresh',
     /adoptSpectateSessions\(\)[\s\S]{0,300}const proxies = \[\.\.\.sessions\.values\(\)\]/.test(fn('runKeeperLivenessSweep')));

  // GAP 2: THE CHAT POLLER.
  const poll = broker.slice(broker.indexOf('function startControlChatWatch('), broker.indexOf('function startPilotWatch('));
  ok('the chat poller listens to every keeper-driven character, a relinquished one included',
     /sessions\.values\(\)\]\.filter\(s => s instanceof KeeperProxy && !humanHeld\(s\.name\)\)/.test(poll) &&
     !/!pilotOf\(s\.name\)/.test(poll));
  ok('...after adopting any spectate-held character it had no session for', /adoptSpectateSessions\(\)/.test(poll));
  ok('...and still only while a person is at some character (the operator it listens for)',
     /!\[\.\.\.piloted\.keys\(\)\]\.some\(a => pilotOf\(a\)\)/.test(poll));
}

console.log('\nFleetScript leases the keeper that is driving (read as text)');
{
  const fsrc = lf(readToolSource(join(TOOLS, 'm59-fleetscript.mjs'), 'utf8'));
  const ports = fsrc.slice(fsrc.indexOf('async function keeperPorts('), fsrc.indexOf('async function keeperMovecheck('));
  ok('the lease scan overlays a proven spectate keeper on the band', /overlaySpectateKeepers\(found, \{ fleet \}\)/.test(ports));
  const hold = fsrc.slice(fsrc.indexOf('export async function holdKeeper('));
  ok('every beat notices the driver changing and re-points the lease',
     /driverMoved\(\)\.then\(async moved => \{\s*if \(moved && await refresh\(\)\)/.test(hold) &&
     hold.indexOf('driverMoved().then') < hold.indexOf("ask('commander_heartbeat'"));
}

console.log('\nthe keeper process in spectate mode, and the launcher (read as text)');
{
  const keeper = lf(readToolSource(join(TOOLS, 'm59-keeper-process.mjs'), 'utf8'));
  const launcher = lf(readToolSource(join(TOOLS, 'm59-spectate-keeper.mjs'), 'utf8'));
  ok('spectate mode refuses to start without the attachment (it would LOG IN unguarded)',
     /if \(SPECTATE && !process\.env\.M59_KEEPER_ATTACH\) \{[\s\S]{0,200}process\.exit\(2\)/.test(keeper));
  ok('an unreadable spectate setting refuses rather than running as a normal keeper',
     /if \(process\.env\.M59_KEEPER_SPECTATE && !SPECTATE\) \{[\s\S]{0,200}process\.exit\(2\)/.test(keeper));
  ok('only spectate mode skips the ownership permit', /if \(SPECTATE\) console\.error[\s\S]{0,200}else try \{ await requireKeeperOwnership\(\); \}/.test(keeper));
  ok('the heartbeat publishes the bound HTTP port, pid and roster',
     /writeSpectateBeat\(SPECTATE\.beat, \{[\s\S]*pid: process\.pid[\s\S]*http_port: port, roster: SPECTATE\.roster/.test(keeper));
  ok('port 0 is replaced by the bound port before the heartbeat starts',
     keeper.indexOf("port = server.address()?.port ?? port;") >= 0 &&
     keeper.indexOf("port = server.address()?.port ?? port;") < keeper.indexOf('if (SPECTATE) startSpectateHeartbeat();'));
  ok('/live says it is a spectate keeper', /spectate: SPECTATE \? \{ player:/.test(keeper));
  ok('a spectate keeper writes no carry for the next real keeper to adopt', /function writeAssignmentCarry\(reason\) \{\s*if \(SPECTATE\) return;/.test(keeper));
  ok("its debugging snapshot never overwrites the normal keeper's", /const statePath = SPECTATE \?/.test(keeper));
  ok('it stops after 15s without its attachment', /Date\.now\(\) - lastAttached > 15_000[\s\S]{0,200}shutdown\('attachment gone for 15s'\)/.test(keeper));
  // The launcher.
  ok('the launcher runs the keeper process itself (same modules, same pid)', /await import\('\.\/m59-keeper-process\.mjs'\)/.test(launcher));
  ok('...after pointing the modules at the scrubbed roster copy',
     launcher.indexOf('process.env.M59_STATE_FILE = rosterCopy') >= 0 &&
     launcher.indexOf('process.env.M59_STATE_FILE = rosterCopy') < launcher.indexOf("await import('./m59-keeper-process.mjs')"));
  ok('...and setting the attachment, so it never logs in',
     launcher.indexOf('process.env.M59_KEEPER_ATTACH =') < launcher.indexOf("await import('./m59-keeper-process.mjs')"));
  ok('the scrubbed copy drops every password', /credentials: \{ \.\.\.v\.credentials, password: undefined \}/.test(launcher));
  const writes = [...launcher.matchAll(/writeFileSync\(([^,]+),/g)].map(m => m[1].trim());
  ok('the launcher writes only the roster COPY, never the live roster', writes.length === 1 && writes[0] === 'rosterCopy', writes.join(','));
  ok('the keeper is asked for an ephemeral port', /'--port', '0'/.test(launcher));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
