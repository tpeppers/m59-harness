// m59-pvp-callout-test.mjs — loud PvP: the lines, the chorus cap, the keeper's moment, and the record.
// Offline: a fake session, files in a temp directory. node tools/m59-pvp-callout-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-callout-'));
process.env.M59_PVP_DIR = join(dir, 'pvp');
process.env.M59_PVP_CALLOUTS = join(dir, 'callouts.json');
writeFileSync(process.env.M59_PVP_CALLOUTS, JSON.stringify({ lines: ['Wrong room, {enemy}.', 'I am {me}. Run.', 'Third line.'] }));

const callout = await import('./m59-pvp-callout.mjs');
const { CombatMode, normalizeCombatOrder } = await import('./m59-combat-mode.mjs');
const { Recorder } = await import('./m59-recorder.mjs');
const { OF } = await import('./m59-parse.mjs');
const { battleTelemetry, battleText } = await import('./m59-pvp-telemetry.mjs');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const day = () => new Date().toISOString().slice(0, 10);
const rows = prefix => { const f = join(process.env.M59_PVP_DIR, `${prefix}-${day()}.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };
const reset = () => rmSync(process.env.M59_PVP_DIR, { recursive: true, force: true });

function fixture({ loud = true, name = 'Kermit' } = {}) {
  let clock = 1_000_000;
  const timers = [], said = [];
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, x: 5 * 64 + 10, y: 5 * 64 + 20 }, me: { name },
    room: { objects: new Map([[2, { id: 2, nameRsc: 2, row: 6, col: 6, flags: OF.PLAYER | OF.ATTACKABLE }]]) },
    rsc: new Map([[1, name], [2, 'Morpheus']]),
    vitals() { return { health: { value: 80, max: 80 } }; },
    say(text) { said.push(text); mode.noteFightAction({ verb: 'say', text, say_type: 'say', at: Date.now() }, c); } };
  const s = { name, client: c, live: true, world: { room: { num: 38 } }, recorder: Object.create(Recorder.prototype) };
  const keeper = { policy: { pvpLoud: loud } };
  const mode = new CombatMode(s, { keeper: () => keeper, now: () => clock, schedule: fn => { timers.push(fn); return timers.length; }, unschedule() {} });
  return { c, s, keeper, mode, timers, said, advance(ms) { clock += ms; }, seen: [{ name: 'Morpheus', verdict: { hostile: true, basis: 'war book' } }] };
}
const settled = f => { f.advance(callout.STARTUP_QUIET_MS + 1); return f; };

console.log('m59-pvp-callout-test');

await test('lines: an array or {lines}, blanks dropped, an empty list refused', () => {
  assert.deepEqual(callout.parseCallouts(['a', ' ', 'b']), [{ text: 'a', voices: null }, { text: 'b', voices: null }]);
  assert.deepEqual(callout.parseCallouts({ lines: ['x'] }), [{ text: 'x', voices: null }]);
  assert.throws(() => callout.parseCallouts({ lines: [] }), /no lines/);
  assert.throws(() => callout.parseCallouts({}), /expected/);
});

await test('a voiced line is parsed with its names; a bad voice is refused', () => {
  assert.deepEqual(callout.parseCallouts([{ text: 'Hi-YAH!', voice: 'Piggy' }, { text: 'Doh ho ho!', voice: ['Statler', ' Waldorf '] }]),
    [{ text: 'Hi-YAH!', voices: ['piggy'] }, { text: 'Doh ho ho!', voices: ['statler', 'waldorf'] }]);
  assert.throws(() => callout.parseCallouts([{ text: 'x', voice: 7 }]), /voice must be/);
  assert.throws(() => callout.parseCallouts([{ text: 'x', voice: [] }]), /empty voice/);
});

await test('a voiced line is only picked for its muppet; generic lines for anyone', () => {
  const lines = callout.parseCallouts(['Generic, {enemy}.', { text: 'Moi does not miss.', voice: 'Piggy' },
    { text: 'Wocka wocka.', voice: 'Fozzie' }, { text: 'Doh ho ho!', voice: ['Statler', 'Waldorf'] }]);
  const said = me => new Set(Array.from({ length: 40 }, (_, k) => callout.pickCallout(lines, { me, random: () => k / 40 }).text));
  assert.deepEqual([...said('Kermit')], ['Generic, .'], 'Kermit gets the generic line');
  assert.ok(![...said('Kermit')].some(t => /Moi|Wocka|Doh/.test(t)), 'Kermit says no one else\'s line');
  assert.ok(said('Piggy').has('Moi does not miss.') && !said('Piggy').has('Wocka wocka.'), 'Piggy says hers, not Fozzie\'s');
  assert.ok(said('piggy').has('Moi does not miss.'), 'names match case-insensitively');
  assert.ok(said('Waldorf').has('Doh ho ho!') && said('Statler').has('Doh ho ho!'), 'a shared voice is either of theirs');
  const p = callout.pickCallout(lines, { me: 'Fozzie', recent: [0], random: () => 0 });
  assert.equal(p.text, 'Wocka wocka.'); assert.equal(p.index, 2, 'index is the position in the whole file');
  assert.deepEqual(p.voice, ['fozzie']);
  assert.equal(callout.pickCallout([{ text: 'Bork!', voices: ['swedish chef'] }], { me: 'Kermit' }), null, 'nothing he may say');
});

await test('the committed example has lines, and the fleet file overrides it', () => {
  const ex = callout.loadCallouts({ file: join(dir, 'missing.json') });
  assert.ok(ex.lines.length >= 5 && ex.file.endsWith('pvp-callouts.example.json'), ex.error ?? '');
  assert.equal(callout.loadCallouts().lines.length, 3);
});

await test('a pick fills {enemy} and {me}, and avoids recently used lines', () => {
  const lines = ['Wrong room, {enemy}.', 'I am {me}.', 'Third.'];
  const p = callout.pickCallout(lines, { recent: [1, 2], enemy: 'Morpheus', me: 'Kermit', random: () => 0.9 });
  assert.deepEqual(p, { index: 0, text: 'Wrong room, Morpheus.' });
  assert.equal(callout.pickCallout(lines, { recent: [0, 1, 2], random: () => 0 }).index, 0, 'all used: any line');
  assert.equal(callout.pickCallout([], {}), null);
});

await test('chorus: at most CHORUS speakers per arrival, never the same one twice', () => {
  const now = 5_000_000, r = (speaker, at = now - 1000) => ({ room: 38, player: 'Morpheus', speaker, at });
  assert.equal(callout.chorusVerdict([], { room: 38, player: 'Morpheus', speaker: 'A', now }).speak, true);
  assert.match(callout.chorusVerdict([r('A')], { room: 38, player: 'morpheus', speaker: 'a', now }).why, /already spoke/);
  assert.match(callout.chorusVerdict([r('A'), r('B')], { room: 38, player: 'Morpheus', speaker: 'C', now }).why, /chorus full/);
  assert.equal(callout.chorusVerdict([r('A', now - 60_000), r('B', now - 60_000)], { room: 38, player: 'Morpheus', speaker: 'C', now }).speak, true, 'an old arrival is not this one');
  assert.equal(callout.chorusVerdict([r('A'), r('B')], { room: 39, player: 'Morpheus', speaker: 'C', now }).speak, true, 'another map');
});

await test('a loud character says a line when a hostile arrives, and the PvP record has it in quotes', () => {
  reset();
  const f = settled(fixture());
  f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  assert.equal(f.timers.length, 1, 'one callout scheduled');
  f.timers[0]();
  assert.equal(f.said.length, 1);
  assert.ok(['Wrong room, Morpheus.', 'I am Kermit. Run.', 'Third line.'].includes(f.said[0]), f.said[0]);
  const co = rows('callouts'), act = rows('actions');
  assert.equal(co.length, 1); assert.equal(co[0].speaker, 'Kermit'); assert.equal(co[0].player, 'Morpheus'); assert.equal(co[0].text, f.said[0]);
  assert.equal(co[0].loc.map, 38);
  const say = act.find(a => a.verb === 'say');
  assert.ok(say, 'say action row'); assert.equal(say.text, f.said[0]); assert.equal(say.callout.player, 'Morpheus');
  assert.equal(say.loc.map, 38);
});

await test('still in the map at the next scan: no second callout; gone and back after the gap: a new one', () => {
  reset();
  const f = settled(fixture());
  f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  f.advance(5000); f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  assert.equal(f.timers.length, 1);
  f.mode.noteCalloutArrivals(f.c, [], 38);                // left
  f.advance(10_000); f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  assert.equal(f.timers.length, 1, 'a flicker inside ARRIVAL_GAP_MS is not an arrival');
  f.mode.noteCalloutArrivals(f.c, [], 38);
  f.advance(callout.ARRIVAL_GAP_MS + 1); f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  assert.equal(f.timers.length, 2);
});

await test('quiet: not loud, a quiet combat order, a stranger who is not hostile, or a keeper just started', () => {
  const quiet = settled(fixture({ loud: false }));
  quiet.mode.noteCalloutArrivals(quiet.c, quiet.seen, 38);
  assert.equal(quiet.timers.length, 0, 'policy off');
  const order = settled(fixture({ loud: true }));
  order.mode.active = { order: { target: 'Morpheus', loud: false } };
  order.mode.noteCalloutArrivals(order.c, order.seen, 38);
  assert.equal(order.timers.length, 0, 'order says quiet');
  const stranger = settled(fixture());
  stranger.mode.noteCalloutArrivals(stranger.c, [{ name: 'Passerby', verdict: { hostile: false } }], 38);
  assert.equal(stranger.timers.length, 0);
  const young = fixture();
  young.mode.noteCalloutArrivals(young.c, young.seen, 38);
  assert.equal(young.timers.length, 0, 'startup quiet');
});

await test('a loud combat order speaks for a policy that is not loud, and its target counts as hostile', () => {
  const f = settled(fixture({ loud: false }));
  f.mode.active = { order: { target: 'Morpheus', loud: true } };
  f.mode.noteCalloutArrivals(f.c, [{ name: 'Morpheus', verdict: { hostile: false } }], 38);
  assert.equal(f.timers.length, 1);
});

await test('the chorus cap holds across keepers: a third loud character stays quiet', () => {
  reset();
  for (const n of ['A', 'B', 'C']) {
    const f = settled(fixture({ name: n }));
    f.mode.noteCalloutArrivals(f.c, f.seen, 38); f.timers[0]();
  }
  assert.deepEqual(rows('callouts').map(r => r.speaker), ['A', 'B']);
});

await test('gone before the pause ends, or another map: nothing said', () => {
  reset();
  const f = settled(fixture());
  f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  f.c.room.objects.delete(2); f.timers[0]();
  assert.equal(f.said.length, 0);
});

await test('speech heard in the minute after an arrival goes to the messages file with the speaker', () => {
  reset();
  const f = settled(fixture({ loud: false }));
  f.mode.noteFightSaid({ name: 'Morpheus', type: 'say', text: 'too early' });
  assert.equal(rows('messages').length, 0, 'no window, no arrival: not kept');
  f.mode.noteCalloutArrivals(f.c, f.seen, 38);
  f.mode.noteFightSaid({ name: 'Morpheus', type: 'say', text: 'You again?' });
  const m = rows('messages');
  assert.equal(m.length, 1); assert.equal(m[0].kind, 'said'); assert.equal(m[0].speaker, 'Morpheus'); assert.equal(m[0].text, 'You again?');
});

await test('combat orders are loud by default; loud must be boolean', () => {
  assert.equal(normalizeCombatOrder({ action: 'kill', target: 'Morpheus' }).loud, true);
  assert.equal(normalizeCombatOrder({ action: 'kill', target: 'Morpheus', loud: false }).loud, false);
  assert.throws(() => normalizeCombatOrder({ action: 'kill', target: 'Morpheus', loud: 'yes' }), /loud/);
});

await test('telemetry: speech in quotes, our echo dropped, a line heard by many kept once', () => {
  const t = 2_000_000;
  const battle = { id: 'b1', start: t, end: t + 20_000, rooms: [38], ours: [{ name: 'Kermit' }, { name: 'Piggy' }], events: [] };
  const actions = [{ kind: 'action', verb: 'say', at: t + 100, observer: 'Kermit', room: 38, loc: { map: 38, row: 5, col: 5, fx: 10, fy: 20 },
    text: 'Wrong room, Morpheus.', say_type: 'say', callout: { player: 'Morpheus', basis: 'war book' } }];
  const messages = [
    { kind: 'said', at: t + 150, observer: 'Kermit', room: 38, speaker: 'Kermit', say_type: 'say', text: 'Wrong room, Morpheus.' },
    { kind: 'said', at: t + 160, observer: 'Piggy', room: 38, speaker: 'Kermit', say_type: 'say', text: 'Wrong room, Morpheus.' },
    { kind: 'said', at: t + 900, observer: 'Kermit', room: 38, speaker: 'Morpheus', say_type: 'say', text: 'lol' },
    { kind: 'said', at: t + 950, observer: 'Piggy', room: 38, speaker: 'Morpheus', say_type: 'say', text: 'lol' },
  ];
  const tm = battleTelemetry(battle, { actions, messages });
  assert.deepEqual(tm.speech.map(x => [x.speaker, x.text, x.ours]), [['Kermit', 'Wrong room, Morpheus.', true], ['Morpheus', 'lol', false]]);
  assert.deepEqual(tm.speech[1].heard_by, ['Kermit', 'Piggy']);
  assert.equal(tm.characters.find(c => c.name === 'Kermit').callouts, 1);
  const text = battleText({ ...battle, telemetry: tm });
  assert.match(text, /Kermit says "Wrong room, Morpheus\." \(callout: Morpheus entered the map, war book\) @ m38 r5c5/);
  assert.match(text, /Morpheus says "lol"  \(heard by Kermit, Piggy\)/);
  assert.equal((text.match(/Wrong room/g) ?? []).length, 1, 'the echo is not a second line');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
