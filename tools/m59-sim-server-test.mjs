#!/usr/bin/env node
// Offline boundary tests. Nothing here invokes Docker or opens a socket.
import assert from 'node:assert/strict';
import { parseBuildArgs } from './m59-sim-server-build.mjs';
import { parseServerArgs } from './m59-sim-server.mjs';

let assertions = 0;
const throws = (argv, pattern) => {
  assert.throws(() => parseServerArgs(argv), pattern);
  assertions++;
};

const start = parseServerArgs([
  'start', '--id', 'clock-lab', '--image', 'm59-blakserv-sim:10x', '--scale', '10',
  '--game-port', '15959', '--admin-port', '19998', '--memory', '1536m', '--cpus', '1.5',
]);
assert.equal(start.action, 'start'); assertions++;
assert.equal(start.id, 'clock-lab'); assertions++;
assert.equal(start.scale, 10); assertions++;
assert.equal(start.gamePort, 15959); assertions++;
assert.equal(start.adminPort, 19998); assertions++;
assert.equal(start.cpus, 1.5); assertions++;

assert.equal(parseServerArgs(['status', '--id', 'clock-lab']).action, 'status'); assertions++;
assert.equal(parseServerArgs(['--help']).help, true); assertions++;
throws([], /one action is required/);
throws(['start', '--id', 'clock-lab'], /--image is required/);
throws(['start', '--id', 'prod-lab', '--image', 'x:y', '--scale', '10',
  '--game-port', '15959', '--admin-port', '19998'], /production-like/);
throws(['start', '--id', 'clock-lab', '--image', 'x:y', '--scale', '10',
  '--game-port', '5959', '--admin-port', '19998'], /ordinary server port/);
throws(['start', '--id', 'clock-lab', '--image', 'x:y', '--scale', '10',
  '--game-port', '15959', '--admin-port', '15959'], /ports must differ/);
throws(['start', '--id', 'clock-lab', '--image', 'x:y', '--scale', '101',
  '--game-port', '15959', '--admin-port', '19998'], /integer from 1 through 100/);
throws(['attest', '--id', 'clock-lab', '--scale', '10'], /reads its image/);
throws(['status', '--id', '../clock-lab'], /--id/);

const check = parseBuildArgs(['--check', '--source', 'C:/code/Meridian59', '--scale', '10'], {});
assert.equal(check.action, 'check'); assertions++;
assert.equal(check.scale, 10); assertions++;
assert.equal(parseBuildArgs(['--build', '--tag', 'm59-blakserv-sim:test'], {}).action, 'build');
assertions++;
assert.throws(() => parseBuildArgs(['--build', '--check'], {}), /mutually exclusive/); assertions++;
assert.throws(() => parseBuildArgs(['--scale', '0'], {}), /integer from 1 through 100/); assertions++;
assert.throws(() => parseBuildArgs(['--tag', 'UPPER/repository:tag'], {}), /lowercase Docker/); assertions++;

console.log(`simulation server boundary: PASS (${assertions} assertions)`);
