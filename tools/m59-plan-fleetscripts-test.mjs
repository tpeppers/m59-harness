#!/usr/bin/env node
// MANAGE FleetScript dispatch, offline: use real reflected modules and the provider's
// launch boundary, without starting a REPL, a broker or a character connection.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFleetScriptsProvider, argsFor } from './plans/fleetscripts.mjs';
import { gatherEntries, runRequest } from './m59-plan-desk.mjs';

process.env.M59_FLEET = 'test';
const root = mkdtempSync(join(tmpdir(), 'm59-manage-fs-'));
const substrate = join(root, 'substrate'), local = join(substrate, 'fleetscripts');
mkdirSync(local, { recursive: true });
writeFileSync(join(local, 'manage-task.mjs'), `export const script = {
  name: 'manage-test', params: { agents: { type: 'agents', required: true },
    count: { type: 'number', default: 2 }, note: { type: 'string' } },
  async steps() { return []; }
};`);
writeFileSync(join(local, 'default-self.mjs'), `export const script = {
  name: 'default-self', params: { agents: { type: 'agents', default: 't1' } },
  async steps() { return []; }
};`);
writeFileSync(join(local, 'multi-target.mjs'), `export const script = {
  name: 'multi-target', params: { agents: { type: 'agents', required: true },
    helpers: { type: 'agents', default: 't1' } }, async steps() { return []; }
};`);
writeFileSync(join(local, 'compose-task.mjs'), `export const script = {
  name: 'manage-compose', params: { agents: { type: 'agents', required: true },
    task: { type: 'script', paramsIn: 'taskParams' }, taskParams: { type: 'string', default: '' } },
  async steps() { return []; }
};`);
const launched = [];
const provider = createFleetScriptsProvider({ launchScript: (...args) => {
  launched.push(args); return { pid: 1234, log: join(root, 'script.log') };
} });
const harness = dirname(dirname(fileURLToPath(import.meta.url)));
const ctx = { substrate, harness, fleet: 'test', client: { agent: 't1' }, control: 'none', agents: [
  { agent: 't1', character: 'Watched Character' },
  { agent: 't2', committed: { kind: 'bot', by: 'DUM', takeable: true } },
] };
let count = 0;
const check = (name, cond) => { assert.ok(cond, name); count++; console.log(`  ok ${name}`); };
const gathered = await gatherEntries([provider], ctx);
let seq = 0;
const run = async (entry, args, overrides = {}) => {
  const current = { ...ctx, ...overrides };
  return runRequest({ seq: ++seq, entry, args: { ...args } }, await gatherEntries([provider], current), current);
};
const reject = async (name, entry, args, overrides = {}, message = /piloting.*release to Keeper/i) => {
  const before = launched.length, r = await run(entry, args, overrides);
  check(name, !r.ok && message.test(r.message) && launched.length === before);
};

try {
  const row = gathered.entries.find(e => e.id === 'fs.manage-test');
  check('local FleetScripts appear in MANAGE', !!row && row._script === 'manage-test');
  check('reflected required arguments retain their requirement', row.args.find(a => a.id === 'agents').required === true);
  check('blank optional arguments retain their optional status', row.args.find(a => a.id === 'note').required === false);
  check('numeric parameters preserve their protocol2 number picker', row.args.find(a => a.id === 'count').type === 'number' && row.args.find(a => a.id === 'count').default === '2');
  check('protocol2 forms retain sixteen parameters', argsFor({ params: Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`arg${i}`, { type: 'string' }])) }).length === 16);
  check('the current pilot is absent from agent picker options', !row.args.find(a => a.id === 'agents').options.some(o => o.value === 't1'));
  const releasedRows = await gatherEntries([provider], { ...ctx, control: 'keeper', keeperRegistered: true });
  check('the registered watched keeper is offered in the agent picker', releasedRows.entries.find(e => e.id === 'fs.manage-test').args
    .find(a => a.id === 'agents').options.some(o => o.value === 't1'));

  await reject('a reflected run cannot take the character being piloted', 'fs.manage-test', { agents: 't1' });
  await reject('the typed line has the same human pilot guard', 'fs.line', { line: 'manage-test agents=t1' });
  await reject('a mixed fleet selection cannot silently include the pilot', 'fs.line', { line: 'manage-test agents=t2,t1' });
  await reject('target matching is case insensitive', 'fs.line', { line: 'manage-test agents=T1' });
  await reject('encoded targets receive the same guard after REPL decoding', 'fs.line', { line: 'manage-test agents=%74%31' });
  await reject('a whole fleet selection cannot silently include the pilot', 'fs.line', { line: 'manage-test agents=*' });
  await reject('default target parameters receive the pilot guard', 'fs.default-self', {});
  await reject('typed lines cannot bypass the guard using a default', 'fs.line', { line: 'default-self' });
  await reject('additional agents parameters also receive the pilot guard', 'fs.multi-target', { agents: 't2' });
  await reject('a gate without a registered keeper explains that attachment is pending', 'fs.line', { line: 'manage-test agents=t1' }, { control: 'keeper' }, /not registered.*retry once it is attached/);
  await reject('another gate holder is not a release to Keeper', 'fs.manage-test', { agents: 't1' }, { control: 'other', keeperRegistered: true });

  const mate = await run('fs.manage-test', { agents: 't2' });
  check('a currently running DUM fleetmate can be targeted', mate.ok && launched.at(-1)[2] === 'manage-test agents=t2');
  check('the normal REPL remains the dispatch boundary for its run locks and leases', launched.at(-1)[0] === root &&
    launched.at(-1)[1] === 'test' && launched.at(-1)[3] === substrate);
  const released = { control: 'keeper', keeperRegistered: true };
  const current = await run('fs.manage-test', { agents: 't1,t2' }, released);
  check('a released watched character and its active fleetmates can run together', current.ok && launched.at(-1)[2].includes('agents=t1,t2'));
  const typed = await run('fs.line', { line: 'manage-test agents=t1 count=4' }, released);
  check('typed FleetScripts can target the released watched character', typed.ok && launched.at(-1)[2] === 'manage-test agents=t1 count=4');
  const defaulted = await run('fs.default-self', {}, released);
  check('default targets are runnable after release', defaulted.ok);
  const dry = await run('fs.dry', { line: 'manage-test agents=t1' });
  check('a dry run remains available while piloting', dry.ok && launched.at(-1)[2] === 'dry manage-test agents=t1');
  const blank = await run('fs.manage-test', { agents: 't2', note: '' });
  check('blank optional fields no longer block a MANAGE form', blank.ok && !launched.at(-1)[2].includes('note='));
  const composed = await run('fs.manage-compose', { agents: 't2', task: 'fs.manage-test?count=5&note=read%20me' });
  const composedLine = launched.at(-1)[2];
  check('nested script forms still expand into the task and its encoded JSON', composed.ok &&
    composedLine.includes('task=manage-test') && composedLine.includes('taskParams=') &&
    decodeURIComponent(composedLine.split('taskParams=')[1]) === '{"count":5,"note":"read me"}');

  for (const [name, entry, args, pattern] of [
    ['a missing required target is refused before launching', 'fs.manage-test', {}, /required/],
    ['a malformed numeric value is refused before launching', 'fs.line', { line: 'manage-test agents=t2 count=oops' }, /number/],
    ['a missing script is reported before launching', 'fs.line', { line: 'no-such-script agents=t2' }, /no script named/],
    ['REPL control commands cannot be submitted as a script line', 'fs.line', { line: 'quit' }, /no script named/],
    ['a line with extra shell-like tokens is refused', 'fs.line', { line: 'manage-test agents=t2 & quit' }, /expected/],
  ]) {
    const before = launched.length, r = await run(entry, args);
    check(name, !r.ok && pattern.test(r.message) && before === launched.length);
  }
  console.log(`\n${count} passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
