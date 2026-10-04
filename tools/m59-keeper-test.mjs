// Offline guard for tools/m59-keeper.mjs and the keeper's identity headers. Opens no socket.
//
//   node tools/m59-keeper-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanKeepers, pickKeeper, identityOf, identityMismatch, pick } from './m59-keeper.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// The band after the 2026-10-04 broker restart: Lew had landed on Bunsen's old port.
const live = { 9530: { agent: 't20', character: 'Lew', pid: 36100, in_game: true },
               9515: { agent: 't5', character: 'Bunsen', pid: 45972, in_game: true },
               9516: { agent: 't6', character: 'Beaker', pid: 9908, in_game: true } };
const fakeFetch = async url => {
  const port = Number(new URL(url).port);
  if (!live[port]) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  return { ok: true, json: async () => ({ schema: 'm59-keeper-live/v1', ok: true, ...live[port] }) };
};
const band = { base: 9511, end: 9534 };

await ok('the scan finds each keeper by what it SAYS it is, not by a remembered port', async () => {
  const k = await scanKeepers({ band, fetchImpl: fakeFetch });
  assert.equal(k.get('t5').port, 9515);
  assert.equal(k.get('t20').port, 9530, 'Lew is on the port Bunsen used to have');
  assert.equal(k.size, 3);
});
await ok('an agent id or a character name, either case', async () => {
  const k = await scanKeepers({ band, fetchImpl: fakeFetch });
  assert.equal(pickKeeper(k, 'Bunsen').agent, 't5');
  assert.equal(pickKeeper(k, 'T6').character, 'Beaker');
  assert.equal(pickKeeper(k, 'Kermit'), null);
});
await ok('THE INCIDENT: a reply from Lew to a question for Bunsen is refused', () => {
  const asked = { agent: 't5', character: 'Bunsen', pid: 45972 };
  const why = identityMismatch(asked, identityOf({ 'x-m59-agent': 't20', 'x-m59-character': 'Lew', 'x-m59-keeper-pid': '36100' }, {}));
  assert.match(why, /answered by t20 \(Lew\), not t5/);
});
await ok('a restarted keeper (same agent, new pid) is refused too, with what to do', () => {
  const why = identityMismatch({ agent: 't5', character: 'Bunsen', pid: 45972 },
    identityOf({ 'x-m59-agent': 't5', 'x-m59-character': 'Bunsen', 'x-m59-keeper-pid': '111' }, {}));
  assert.match(why, /keeper restarted; ask again/);
});
await ok('the right keeper passes; headers win over the body; an old keeper is read from its body', () => {
  const asked = { agent: 't6', character: 'Beaker', pid: 9908 };
  assert.equal(identityMismatch(asked, identityOf({ 'x-m59-agent': 't6', 'x-m59-character': 'Beaker', 'x-m59-keeper-pid': '9908' }, { agent: 'zz' })), null);
  const old = identityOf({}, { agent: 't6', character: 'Beaker', pid: 9908 });
  assert.equal(old.from, 'body');
  assert.equal(identityMismatch(asked, old), null);
  assert.match(identityMismatch(asked, identityOf({}, { agent: 't20' })), /answered by t20/);
});
await ok('a body that names nobody is left to the keeper\'s own 409 on addressed paths', () => {
  assert.equal(identityMismatch({ agent: 't6' }, identityOf({}, { neighbors: [] })), null);
});
await ok('a percent-encoded character name is decoded', () => {
  assert.equal(identityOf({ 'x-m59-character': encodeURIComponent('Zoë') }, {}).character, 'Zoë');
});
await ok('--pick reads a dotted path', () => {
  assert.equal(pick({ a: { b: { c: 3 } } }, 'a.b.c'), 3);
  assert.equal(pick({ a: null }, 'a.b'), null);
});
await ok('every keeper reply carries the headers, set before any handler runs', () => {
  const src = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('const server = createServer(async (req, res) => {'));
  const set = body.indexOf("res.setHeader('x-m59-agent', identityHeader(agent));");
  const firstReply = body.indexOf('const json = ');
  assert.ok(set > 0 && set < firstReply, 'before the first reply can be written');
  assert.ok(body.includes("res.setHeader('x-m59-character', identityHeader(character));"));
  assert.ok(body.includes("res.setHeader('x-m59-keeper-pid', String(process.pid));"));
  // The same names a caller sends to address a write, so one vocabulary in both directions.
  assert.ok(src.includes("req.headers['x-m59-agent']") && src.includes("req.headers['x-m59-keeper-pid']"));
});
await ok('the CLI is read-only: it never POSTs', () => {
  const src = readFileSync(new URL('./m59-keeper.mjs', import.meta.url), 'utf8');
  assert.ok(!/method:\s*'POST'/.test(src));
});
await ok('arguments: the name survives whichever flags are absent (--port without --pick dropped it)', () => {
  const src = readFileSync(new URL('./m59-keeper.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('[pickAt, fleetAt].filter(i => i >= 0)'), 'an absent flag skips nothing');
  assert.ok(!src.includes('i !== pickAt + 1'));
  assert.ok(src.includes("(?:Program Files[\\\\/])?Git[\\\\/]"), "Git Bash's /live -> C:/Program Files/Git/live is undone");
});

console.log(`\n${n} passed`);
