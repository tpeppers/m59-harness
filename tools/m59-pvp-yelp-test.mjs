// m59-pvp-yelp-test.mjs — Zalgo levels, the byte budget, UTF-8 say, the damage zones, and the keeper's yelp.
// Offline: a fake session, files in a temp directory. node tools/m59-pvp-yelp-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-yelp-'));
process.env.M59_PVP_DIR = join(dir, 'pvp');
process.env.M59_PVP_CALLOUTS = join(dir, 'callouts.json');
process.env.M59_PVP_YELPS = join(dir, 'yelps.json');
writeFileSync(process.env.M59_PVP_CALLOUTS, JSON.stringify({ lines: [
  'Wrong room, {enemy}.', { text: 'Hi-YAH! Moi does not miss.', voice: 'Piggy' }, { text: 'HE COMES, {enemy}.', tier: 4 }] }));
const YELPS = { settings: { mix_original: 0 }, zones: {
  1: ['A scratch. Only a scratch.'], 2: ['The walls are breathing.'], 3: ['It is in my blood now, {enemy}.'], 4: ['HE COMES.'] } };
writeFileSync(process.env.M59_PVP_YELPS, JSON.stringify(YELPS));

const Z = await import('./m59-zalgo.mjs');
const yelp = await import('./m59-pvp-yelp.mjs');
const callout = await import('./m59-pvp-callout.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const { Recorder } = await import('./m59-recorder.mjs');
const { M59Client } = await import('./m59-client.mjs');
const { OF } = await import('./m59-parse.mjs');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const seeded = (seed = 7) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const MARK = /[̀-ͯ]/;
const marked = w => MARK.test(w);
const words = s => s.split(' ');
const day = () => new Date().toISOString().slice(0, 10);
const rows = () => { const f = join(process.env.M59_PVP_DIR, `callouts-${day()}.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };

console.log('m59-pvp-yelp-test');

await test('level 0 is the line as written, names filled in', () => {
  const z = Z.zalgo('Wrong room, {enemy}.', 0, { vars: { enemy: 'Morpheus' } });
  assert.deepEqual(z, { text: 'Wrong room, Morpheus.', level: 0, truncated: false, utf8: false });
});

await test('level 1 corrupts exactly ONE word, lightly (one mark per touched letter)', () => {
  for (let seed = 1; seed < 40; seed++) {
    const z = Z.zalgo('The rats stopped squeaking an hour ago.', 1, { random: seeded(seed) });
    const hit = words(z.text).filter(marked);
    assert.equal(hit.length, 1, z.text);
    assert.ok(![...hit[0]].some((ch, i, a) => MARK.test(ch) && MARK.test(a[i - 1] ?? '')), 'no stacked marks at level 1');
    assert.equal(z.text.replace(/[̀-ͯ]/g, ''), 'The rats stopped squeaking an hour ago.');
  }
});

await test('level 2 touches a quarter to a half of the words', () => {
  const line = 'one two three four five six seven eight nine ten eleven twelve';
  for (let seed = 1; seed < 40; seed++) {
    const n = words(Z.zalgo(line, 2, { random: seeded(seed) }).text).filter(marked).length;
    assert.ok(n >= 3 && n <= 6, `${n} of 12`);
  }
});

await test('level 4 marks every letter and stacks them', () => {
  const z = Z.zalgo('HE COMES', 4, { random: seeded(3), budget: 4000 });
  const letters = z.text.match(/[A-Z][̀-ͯ҉]*/g);
  assert.equal(letters.length, 7);
  assert.ok(letters.every(l => l.length >= 3), 'each letter carries several marks');
  assert.equal(z.utf8, true);
});

await test('names stay readable unless corruptNames', () => {
  const clean = Z.zalgo('Fhtagn, {enemy}. Fhtagn.', 4, { vars: { enemy: 'Morpheus' }, random: seeded(5), budget: 4000 });
  assert.ok(clean.text.includes('Morpheus'), clean.text);
  const dirty = Z.zalgo('Fhtagn, {enemy}. Fhtagn.', 4, { vars: { enemy: 'Morpheus' }, corruptNames: true, random: seeded(5), budget: 4000 });
  assert.ok(!dirty.text.includes('Morpheus') && dirty.text.replace(/[̀-ͯ҉]/g, '').includes('Morpheus'), dirty.text);
});

await test('the budget cuts mid-line at a letter boundary, never mid-mark', () => {
  const long = 'Every shard drowns. Every shard sings. Every shard is His. '.repeat(3);
  for (let seed = 1; seed < 20; seed++) {
    const z = Z.zalgo(long, 4, { random: seeded(seed), budget: 200 });
    assert.ok(Z.utf8Bytes(z.text) <= 200, `${Z.utf8Bytes(z.text)} bytes`);
    assert.equal(z.truncated, true);
    assert.ok(!MARK.test(z.text[0]));
    // every mark follows a letter or another mark: no orphan at the cut
    const cut = Z.cutToBudget(z.text + 'X́̂', Z.utf8Bytes(z.text) + 2);
    assert.equal(cut.text, z.text, 'a letter is dropped whole with its marks');
  }
  assert.deepEqual(Z.cutToBudget('short', 400), { text: 'short', truncated: false });
});

await test('Latin-1 cannot carry the marks; say with encoding utf8 can', () => {
  assert.equal(Buffer.from('H̸E', 'latin1').toString('latin1'), 'H8E', 'the bug the option exists for');
  assert.equal(Z.needsUtf8('plain café'), false);
  assert.equal(Z.needsUtf8('H̸E'), true);
  const sent = [], tapped = [];
  const c = Object.create(M59Client.prototype);
  c.send = (op, ...parts) => sent.push(Buffer.concat(parts));
  c.tapSent = (k, d) => tapped.push(d);
  c.say('H̸E', 1, { encoding: 'utf8' });
  c.say('café');
  const body = b => b.subarray(3, 3 + b.readUInt16LE(1));
  assert.equal(body(sent[0]).toString('utf8'), 'H̸E');
  assert.equal(body(sent[1]).toString('latin1'), 'café', 'the default is still Latin-1');
  assert.equal(tapped[0].encoding, 'utf8');
  assert.equal(tapped[1].encoding, undefined);
});

await test('health level: 0 at full, 1..4 through 90/65/40/20', () => {
  assert.deepEqual([100, 95, 90, 70, 65, 41, 40, 21, 20, 1].map(p => Z.healthLevel(p)), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(Z.healthLevel(null), 0);
});

await test('one yelp per zone per episode; a deep hit says only the deeper zone; healing resets', () => {
  const t = new yelp.YelpTracker(), s = yelp.DEFAULT_SETTINGS;
  assert.deepEqual([100, 85, 80, 60, 55, 10, 50, 30, 0, 96, 85].map(p => t.observe(p, s)),
    [null, 1, null, 2, null, 4, null, null, null, null, 1]);
});

await test('yelps file: zones validated, settings defaulted', () => {
  const y = yelp.parseYelps({ zones: { 1: ['a'] } });
  assert.equal(y.settings.mix_original, 0.3);
  assert.deepEqual(y.zones[1], [{ text: 'a', voices: null }]);
  assert.throws(() => yelp.parseYelps({ zones: { 5: ['a'] } }), /not 1\.\.4/);
  assert.throws(() => yelp.parseYelps({ settings: { thresholds: [50, 60] }, zones: {} }), /falling/);
  assert.throws(() => yelp.parseYelps({}), /expected/);
});

await test('a callout tier is parsed; a bad tier refused; chorus ignores yelps', () => {
  assert.deepEqual(callout.parseCallouts([{ text: 'x', tier: 3 }]), [{ text: 'x', voices: null, tier: 3 }]);
  assert.throws(() => callout.parseCallouts([{ text: 'x', tier: 9 }]), /tier/);
  const now = 5e6, base = { room: 38, player: 'Morpheus', at: now };
  const v = callout.chorusVerdict([{ ...base, kind: 'yelp', speaker: 'Kermit' }, { ...base, kind: 'yelp', speaker: 'Piggy' }],
    { room: 38, player: 'Morpheus', speaker: 'Kermit', now });
  assert.equal(v.speak, true);
});

await test('pick: the zone line, or an ORIGINAL in the speaker\'s voice; never a tiered one; no {enemy} without one', () => {
  const y = yelp.parseYelps(YELPS), originals = callout.parseCallouts(JSON.parse(readFileSync(process.env.M59_PVP_CALLOUTS, 'utf8')));
  assert.deepEqual(yelp.pickYelp(y, 2, { originals, me: 'Kermit', random: () => 0.5 }),
    { source: 'yelp', index: 0, template: 'The walls are breathing.' });
  const mixed = { ...y, settings: { ...y.settings, mix_original: 1 } };
  const piggy = new Set(), kermit = new Set();
  for (let i = 0; i < 30; i++) {
    piggy.add(yelp.pickYelp(mixed, 1, { originals, me: 'Piggy', enemy: 'Morpheus', random: seeded(i) }).template);
    kermit.add(yelp.pickYelp(mixed, 1, { originals, me: 'Kermit', enemy: 'Morpheus', random: seeded(i) }).template);
  }
  assert.deepEqual([...piggy].sort(), ['Hi-YAH! Moi does not miss.', 'Wrong room, {enemy}.']);
  assert.deepEqual([...kermit], ['Wrong room, {enemy}.']);
  // no enemy: the {enemy} original is out, so Kermit falls back to the zone's own line
  assert.equal(yelp.pickYelp(mixed, 3, { originals, me: 'Kermit', random: () => 0 }), null, 'zone 3 names {enemy} too');
  assert.equal(yelp.pickYelp(mixed, 2, { originals, me: 'Kermit', random: () => 0 }).source, 'yelp');
});

function fixture({ loud = true, name = 'Kermit', pvp = true } = {}) {
  const said = [], hp = { value: 100, max: 100 };
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5 }, me: { name },
    room: { objects: new Map([[2, { id: 2, nameRsc: 2, row: 6, col: 6, flags: OF.PLAYER | OF.ATTACKABLE }]]) },
    rsc: new Map([[1, name], [2, 'Morpheus']]),
    vitals() { return { health: { ...hp } }; },
    say(text, type, opts) { said.push({ text, opts }); } };
  const s = { name, client: c, live: true, world: { room: { num: 38 } }, recorder: Object.create(Recorder.prototype) };
  const keeper = { policy: { pvpLoud: loud } };
  const mode = new CombatMode(s, { keeper: () => keeper, schedule: () => 0, unschedule() {} });
  if (pvp) mode.pvpSpeechUntil = Date.now() + 60_000;
  mode.lastCallout = { player: 'Morpheus' };
  const hit = pct => { hp.value = pct; mode.noteYelp(c); };
  return { c, mode, said, hit };
}

await test('a loud character in a PvP moment yelps once per zone, corrupted to the zone', () => {
  rmSync(process.env.M59_PVP_DIR, { recursive: true, force: true });
  const f = fixture();
  [100, 88, 80, 62, 35, 30, 15, 0].forEach(f.hit);
  assert.equal(f.said.length, 4, JSON.stringify(f.said));
  assert.equal(f.said[0].text.replace(/[̀-ͯ]/g, ''), 'A scratch. Only a scratch.');
  assert.equal(words(f.said[0].text).filter(marked).length, 1, 'zone 1 is one word');
  assert.ok(f.said[2].text.replace(/[̀-ͯ҉]/g, '').includes('Morpheus'), 'the attacker named');
  assert.ok(f.said.every(s => s.opts?.encoding === 'utf8'));
  const r = rows().filter(r => r.kind === 'yelp');
  assert.deepEqual(r.map(x => x.zone), [1, 2, 3, 4]);
  assert.deepEqual(r.map(x => x.level), [1, 2, 3, 4]);
  assert.equal(r[0].speaker, 'Kermit');
  assert.equal(r[0].player, 'Morpheus');
});

await test('quiet characters, and characters outside a PvP moment, do not yelp', () => {
  const quiet = fixture({ loud: false }); [100, 50, 10].forEach(quiet.hit);
  const calm = fixture({ pvp: false }); [100, 50, 10].forEach(calm.hit);
  assert.equal(quiet.said.length + calm.said.length, 0);
});

await test('a stat event for health reaches the yelp through CombatMode.event', () => {
  const f = fixture();
  f.c.vitals = () => ({ health: { value: 60, max: 100 } });
  try { f.mode.event({ kind: 'stat', name: 'health', value: 60, max: 100 }, f.c); } catch { /* the fake is thin */ }
  assert.equal(f.said.length, 1);
});

await test('an arrival callout is corrupted to its tier, or to the speaker\'s wounds', () => {
  rmSync(process.env.M59_PVP_DIR, { recursive: true, force: true });
  const f = fixture({ name: 'Rowlf' });
  f.c.vitals = () => ({ health: { value: 100, max: 100 } });
  const orig = Math.random;
  try {
    Math.random = () => 0.99;                       // the tier-4 line, the last in the file
    f.mode.sayCallout('Morpheus', 38, 'war book');
    Math.random = () => 0;                          // the plain original
    f.mode.pvpSpeechUntil = 0;
    f.c.vitals = () => ({ health: { value: 30, max: 100 } });
    rmSync(process.env.M59_PVP_DIR, { recursive: true, force: true });
    f.mode.sayCallout('Morpheus', 38, 'war book');
  } finally { Math.random = orig; }
  assert.equal(f.said.length, 2, JSON.stringify(f.said));
  assert.ok(f.said[0].text.replace(/[̀-ͯ҉]/g, '').startsWith('HE COMES'), f.said[0].text);
  assert.equal(f.said[0].opts?.encoding, 'utf8');
  assert.equal(f.said[1].text.replace(/[̀-ͯ҉]/g, ''), 'Wrong room, Morpheus.');
  assert.ok(MARK.test(f.said[1].text), 'level 3 at 30% health');
  assert.equal(rows().at(-1).level, 3);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
