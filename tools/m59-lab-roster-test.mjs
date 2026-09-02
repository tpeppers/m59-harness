#!/usr/bin/env node

import assert from 'node:assert/strict';
import { markLabRoster, validateLabRoster } from './m59-lab-roster.mjs';

const fixture = {
  a: { credentials: { account: 'one', password: 'secret-one', character: 'Alfa',
    host: '127.0.0.1', port: 15959 } },
  b: { credentials: { account: 'two', password: 'secret-two', character: 'Bravo',
    host: 'localhost', port: 15959 } },
};
const marked = markLabRoster(fixture);
assert.equal(marked.count, 2);
assert.equal(marked.endpoint.endsWith(':15959'), true);
assert.equal(marked.roster.a.credentials.lab_runtime, true);
assert.equal(fixture.a.credentials.lab_runtime, undefined, 'input is not mutated');
assert.equal(marked.roster.a.credentials.password, 'secret-one');

assert.throws(() => validateLabRoster({ a: { credentials: {
  account: 'x', password: 'y', character: 'X', host: 'example.com', port: 15959,
} } }), /loopback-only/);
assert.throws(() => validateLabRoster({ a: { credentials: {
  account: 'x', password: 'y', character: 'X', host: '127.0.0.1', port: 5959,
} } }), /non-production/);
assert.throws(() => validateLabRoster({ a: fixture.a, b: { credentials: {
  ...fixture.b.credentials, port: 15960,
} } }), /cannot span/);

console.log('lab roster marker: PASS');
