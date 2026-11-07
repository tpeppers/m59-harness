#!/usr/bin/env node
// All listeners and process starts below are fixtures. In particular, a legacy
// proxy's occupied game port is never connected to, stopped or replaced.
import assert from 'node:assert/strict';
import { chooseProxyPorts, confirmsProxy, ensureRidealongProxy, ridealongCapable,
  compareProxyAdverts, sameProxyServer, clientContextForDesk, deskMatchesRoster } from './m59-plan-proxy.mjs';
const server = { host: '198.51.100.7', port: 5959 };
const legacy = { listen: 5962, server, pid: 100, at: 1, gate_control: 8931, attach: 8932 };
const modern = { listen: 5963, server, pid: 200, at: 2, gate_control: 8933, attach: 8934, ridealong: 1 };
const statusOf = a => ({ ...a, attach_port: a.attach });
let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`  ok ${name}`); };
check('legacy gate support is insufficient for managed ridealong', !ridealongCapable(legacy));
check('all three ports and the version are required', ridealongCapable(modern) && !ridealongCapable({ ...modern, attach: null }));
check('the same server includes loopback aliases', sameProxyServer({ server: { host: 'localhost', port: 5959 } }, '127.0.0.1', '5959'));
check('a different server is never reused', !sameProxyServer(modern, server.host, 15959));
check('capability wins over legacy freshness', [legacy, { ...modern, at: 0 }].sort(compareProxyAdverts)[0].pid === modern.pid);
check('equally capable adverts are ordered by freshness', [modern, { ...modern, pid: 300, at: 5 }].sort(compareProxyAdverts)[0].pid === 300);
check('HTTP status must confirm the advertised identity', confirmsProxy(modern, statusOf(modern), server.host, server.port) &&
  !confirmsProxy(modern, { ...statusOf(modern), pid: 999 }, server.host, server.port));
check('HTTP status must confirm the requested backend', !confirmsProxy(modern,
  { ...statusOf(modern), server: { ...server, port: 15959 } }, server.host, server.port));

const occupied = new Set([5962, 8931, 8932]);
const ports = await chooseProxyPorts({ available: async p => !occupied.has(p) });
check('a legacy default tuple gets a free adjacent tuple', ports.listen === 5963 && ports.gate === 8933 && ports.attach === 8934);
check('an occupied explicit listener is honored instead of silently changed', await chooseProxyPorts({ explicit: { listen: true }, available: async p => !occupied.has(p) }) === null);
const mixed = await chooseProxyPorts({ gate: 9000, explicit: { gate: true }, available: async p => !occupied.has(p) });
check('an explicit gate remains fixed while default ports move', mixed.gate === 9000 && mixed.listen === 5963 && mixed.attach === 8934);
check('unknown occupied listeners are left untouched when no tuple is free', await chooseProxyPorts({ available: async () => false, attempts: 3 }) === null);
const local = 'C:/trunk/substrate/client-context', deployed = 'C:/prod-deploy/substrate/client-context';
check('a trunk launch uses the existing production desk client folder', clientContextForDesk({ local, desk: { elsewhere: { dir: deployed } } }) === deployed);
check('an explicit client context override wins over desk discovery', clientContextForDesk({ explicit: 'C:/chosen', local, desk: { elsewhere: { dir: deployed } } }) === 'C:/chosen');
check('a local desk keeps the local client folder', clientContextForDesk({ local, desk: { started: true } }) === local);
const roster = 'C:/prod-deploy/substrate/fleets/prod.json';
check('a current desk must name this exact roster', deskMatchesRoster({ fleet: 'prod', state_file: roster }, { fleet: 'prod', stateFile: roster }));
check('a same-named lab fleet cannot supply the client desk', !deskMatchesRoster({ fleet: 'prod', state_file: 'C:/lab/substrate/fleets/prod.json' }, { fleet: 'prod', stateFile: roster }));
check('a legacy desk can prove its conventional substrate roster', deskMatchesRoster({ fleet: 'prod', substrate: 'C:/prod-deploy/substrate' }, { fleet: 'prod', stateFile: roster }));
check('explicit advertised roster identity overrides a conventional inference', !deskMatchesRoster({ fleet: 'prod', state_file: 'C:/lab/substrate/fleets/prod.json', substrate: 'C:/prod-deploy/substrate' }, { fleet: 'prod', stateFile: roster }));

function fixture(initial, { badStatus = false, fixed = {}, blocked = occupied } = {}) {
  let adverts = [...initial]; const starts = [], availability = [], statusPorts = [];
  const used = new Set([...blocked, ...initial.flatMap(a => [a.listen, a.gate_control, a.attach])]);
  const find = wanted => adverts.filter(a => (!wanted?.listen || Number(a.listen) === Number(wanted.listen)) &&
    (!wanted?.gate || a.gate_control === Number(wanted.gate)) && (!wanted?.attach || a.attach === Number(wanted.attach)))
    .sort(compareProxyAdverts)[0] ?? null;
  const run = () => ensureRidealongProxy({ host: server.host, port: server.port, explicit: fixed,
    find, available: async p => { availability.push(p); return !used.has(p); }, wait: async () => {}, polls: 2,
    status: async p => { statusPorts.push(p); const a = adverts.find(a => a.gate_control === p); return badStatus ? { ...statusOf(a), ridealong: 0 } : statusOf(a); },
    start: async tuple => { starts.push(tuple); adverts.push({ ...modern, listen: tuple.listen,
      gate_control: tuple.gate, attach: tuple.attach, at: 10 }); },
  });
  return { run, starts, availability, statusPorts, get adverts() { return adverts; } };
}
{
  const f = fixture([modern]), r = await f.run();
  check('a confirmed compatible proxy is reused at its actual port', r.ok && !r.started && r.listen === 5963 && !f.starts.length && !f.availability.length);
}
{
  const f = fixture([legacy]), r = await f.run();
  check('a legacy proxy starts a separate managed proxy', r.ok && r.started && r.listen === 5963 && f.starts.length === 1);
  check('the original advert and session listener remain intact', f.adverts[0] === legacy && f.availability.includes(5962));
  check('readiness probes only the HTTP gate endpoint', f.statusPorts.every(p => p === 8933));
}
{
  const f = fixture([legacy]), [one, two] = await Promise.all([f.run(), f.run()]);
  check('simultaneous character launches share one new proxy startup', one.ok && two.ok && one.listen === two.listen && f.starts.length === 1);
}
{
  const f = fixture([{ ...modern, server: { ...server, port: 15959 } }]), r = await f.run();
  check('a compatible proxy for another backend is never used', r.ok && r.started && f.starts.length === 1);
}
{
  const f = fixture([legacy], { fixed: { listen: true } }), r = await f.run();
  check('an occupied explicit legacy listener is reported without a process start', !r.ok && !f.starts.length && f.adverts.length === 1);
}
{
  const f = fixture([], { badStatus: true, blocked: new Set() }), r = await f.run();
  check('an advert without confirmed runtime capability never reports success', !r.ok && r.started && f.starts.length === 1);
}
console.log(`\n${passed} passed`);
