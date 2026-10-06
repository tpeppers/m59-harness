// Offline guard for the PvP record and the /pvp board: tools/m59-pvp.mjs, m59-pvp-page.mjs, and
// the combat-mode tee that writes the log. Opens no socket and touches no roster; every file lives
// in a temp directory.
//
//   node tools/m59-pvp-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-test-'));
process.env.M59_PVP_DIR = join(dir, 'pvp');
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(dir, 'war-alarms.jsonl');

const pvp = await import('./m59-pvp.mjs');
const { renderPvp } = await import('./m59-pvp-page.mjs');
const { TABS } = await import('./m59-page-chrome.mjs');
const { isDashboardOnlyPath } = await import('./m59-dashboard-route.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const { Recorder } = await import('./m59-recorder.mjs');

let tests = 0;
async function test(name, fn) { await fn(); tests++; console.log(`ok ${name}`); }
const OURS = new Set(['gonzo', 'pepe', 'fozzie', 'lew', 'statler']);
const isOurs = n => OURS.has(String(n ?? '').toLowerCase());
const T = s => Date.parse(`2026-10-06T${s}Z`);

// The server's own sentences (system.kod:49-60). Note the doubled article: our guild is named
// "The Second Swines" and the server puts GetDef ("the ") in front of every guild name.
const KILLED_US = '### Pepe of the The Second Swines has been slaughtered by Rick Deckard of the Human Resistance in guild combat.';
const WE_KILLED = '### Rick Deckard of the Human Resistance has been slaughtered by Gonzo of the The Second Swines in guild combat.';

await test('our death to a player in guild combat is written by the victim\'s keeper only', () => {
  const r = pvp.deathRowFromMessage(KILLED_US, { me: 'Pepe', isOurs, at: 5, room: 101 });
  assert.equal(r.victim, 'Pepe'); assert.equal(r.killer, 'Rick Deckard');
  assert.equal(r.our_side, 'victim'); assert.equal(r.killer_guild, 'Human Resistance');
  assert.equal(r.how, 'guild combat'); assert.equal(r.room, 101);
  assert.equal(pvp.deathRowFromMessage(KILLED_US, { me: 'Gonzo', isOurs }), null,
    'every keeper hears it; only the one it is about writes it');
});

await test('our kill of a player is written by the killer\'s keeper, guilds read through "the The"', () => {
  const r = pvp.deathRowFromMessage(WE_KILLED, { me: 'Gonzo', isOurs, at: 7 });
  assert.equal(r.our_side, 'killer'); assert.equal(r.victim, 'Rick Deckard');
  assert.equal(r.victim_guild, 'Human Resistance'); assert.match(r.killer_guild, /^The Second Swines$/);
  assert.equal(pvp.deathRowFromMessage(WE_KILLED, { me: 'Pepe', isOurs }), null);
});

await test('a death to a monster is not PvP; a death to a named player and a murder are', () => {
  assert.equal(pvp.deathRowFromMessage('### Pepe was just killed by a troll.', { me: 'Pepe', isOurs }), null);
  assert.equal(pvp.deathRowFromMessage('### Pepe was just killed by the Guardian of Zjiria.', { me: 'Pepe', isOurs }), null);
  const named = pvp.deathRowFromMessage('### Pepe was just killed by Morpheus.', { me: 'Pepe', isOurs });
  assert.equal(named.killer, 'Morpheus');
  const murder = pvp.deathRowFromMessage('### Pepe has been murdered in cold blood.', { me: 'Pepe', isOurs });
  assert.equal(murder.how, 'murdered by a player'); assert.equal(murder.killer, null);
  assert.equal(pvp.deathRowFromMessage('### Gonzo was just killed by a troll.', { me: 'Gonzo', isOurs }), null);
  assert.equal(pvp.deathRowFromMessage('### Gonzo was just killed by Statler.', { me: 'Gonzo', isOurs }), null,
    'a fleetmate killing a fleetmate is an accident, not a battle');
  assert.equal(pvp.deathRowFromMessage('Pepe was just killed by Morpheus.', { me: 'Pepe', isOurs }), null,
    'only the server\'s ### broadcast counts, never chat repeating it');
  assert.ok(pvp.deathRowFromMessage('~B' + WE_KILLED, { me: 'Gonzo', isOurs }), 'colour codes are stripped');
});

await test('a combat record is a PvP row only for a milestone with a PvP decision', () => {
  const p = { decision_id: 'd1', outcome: null, zaps: 1, last_wand: 'wand',
    attackers: [{ character: 'Rick Deckard', incoming_hits: 0, incoming_misses: 0, outgoing_hits: 1, outgoing_misses: 0 }],
    last_outcome: { character: 'Rick Deckard', direction: 'outgoing', outcome: 'hit', text: 'Your lightning bolt shocks Rick Deckard.' } };
  assert.equal(pvp.combatRow('wand_volley', { observer: 'Gonzo', pvp: null }), null);
  assert.equal(pvp.combatRow('pvp_gear_on', { observer: 'Gonzo', pvp: p }), null);
  const r = pvp.combatRow('pvp_outcome', { observer: 'Gonzo', room: 101, target: 'Rick Deckard', pvp: p, at: 3 });
  assert.equal(r.decision, 'd1'); assert.equal(r.attackers[0].outgoing_hits, 1);
  assert.equal(r.last_outcome.text, 'Your lightning bolt shocks Rick Deckard.');
});

await test('the log is one file per UTC day and reads back across midnight', () => {
  assert.ok(pvp.appendPvp({ kind: 'death', at: Date.parse('2026-10-05T23:59:59Z'), victim: 'Pepe' }));
  assert.ok(pvp.appendPvp({ kind: 'death', at: Date.parse('2026-10-06T00:00:01Z'), victim: 'Lew' }));
  assert.deepEqual(readdirSync(process.env.M59_PVP_DIR).sort(), ['2026-10-05.jsonl', '2026-10-06.jsonl']);
  const rows = pvp.readPvpLog({ since: Date.parse('2026-10-05T23:00:00Z'), until: Date.parse('2026-10-06T01:00:00Z') });
  assert.deepEqual(rows.map(r => r.victim), ['Pepe', 'Lew']);
});

await test('the ledger joins a hold\'s room onto a death row, and an agent name folds into its character', () => {
  const rows = [
    { kind: 'pvp_return_hold_started', character: 't2', died_at: T('17:31:46.070'), killers: ['Rick Deckard'], basis: 'war_book', room: 101 },
    { kind: 'died', character: 'Pepe', death_at: T('17:31:46.070'), killed_by: 'Rick Deckard', was_killed_by_player: true,
      killed_by_player_is_a_guess: true, died_in: 'North Barloque', level: 73 },
    { kind: 'died', character: 'Lew', death_at: T('17:40:00'), killed_by: 'a troll', was_killed_by_player: false },
  ];
  const deaths = pvp.ledgerPvpDeaths(rows);
  assert.equal(deaths.length, 2, 'before aliasing, t2 and Pepe look like two people');
  const r = pvp.pvpReport({ now: T('18:00'), days: 1, characters: ['Pepe'], aliases: new Map([['t2', 'Pepe']]),
    log: [], ledger: deaths, alarms: [], reconstructed: [], members: {} });
  assert.equal(r.totals.our_deaths, 1, 'one death, not two');
  const d = r.battles[0].events.find(e => e.kind === 'death');
  assert.equal(d.room, 101); assert.equal(d.room_name, 'North Barloque'); assert.equal(d.guess, true);
});

const report = (over = {}) => pvp.pvpReport({ now: T('23:00'), days: 1, characters: [...OURS], aliases: new Map(),
  log: [], ledger: [], alarms: [], reconstructed: [], members: {}, ...over });
const death = (at, victim, killer, extra = {}) => ({ kind: 'death', source: 'ledger', at: T(at), victim, killer, our_side: 'victim', room: 101, ...extra });

await test('deaths to one enemy minutes apart, across maps, are ONE battle', () => {
  const r = report({ ledger: [death('17:21:44', 'Pepe', 'Rick Deckard', { room: 50 }), death('17:27:13', 'Lew', 'Rick Deckard', { room: 593 }),
    death('17:31:46', 'Fozzie', 'Rick Deckard', { room: 101 })] });
  assert.equal(r.battles.length, 1);
  assert.deepEqual(r.battles[0].rooms, [50, 593, 101]);
  assert.equal(r.battles[0].our_deaths, 3); assert.equal(r.battles[0].result, 'lost');
  assert.equal(r.enemies.find(e => e.name === 'Rick Deckard').kills_on_us, 3);
});

await test('a long quiet, or a different enemy, starts another battle', () => {
  const r = report({ ledger: [death('10:00', 'Pepe', 'Rick Deckard'), death('10:30', 'Lew', 'Rick Deckard'),
    death('10:31', 'Fozzie', 'Morpheus')] });
  assert.equal(r.battles.length, 3);
  const g = report({ gapMs: 40 * 60_000, ledger: [death('10:00', 'Pepe', 'Rick Deckard'), death('10:30', 'Lew', 'Rick Deckard')] });
  assert.equal(g.battles.length, 1, 'the gap is a parameter');
});

await test('alarms alone are never a battle; inside one they are context', () => {
  const alarms = [{ at: T('12:00'), room: 106, reporter: 'Lew', enemy: 'Rick Deckard', basis: 'war_flag' },
    { at: T('12:00:30'), room: 106, reporter: 'Lew', enemy: 'Rick Deckard', basis: 'sighted' }];
  assert.equal(report({ alarms }).battles.length, 0);
  const r = report({ alarms, ledger: [death('12:00:20', 'Pepe', 'Rick Deckard')] });
  assert.equal(r.battles.length, 1);
  assert.equal(r.battles[0].events.filter(e => e.context).length, 2);
  assert.equal(r.battles[0].duration_ms, 0, 'context does not stretch the battle');
  assert.equal(r.enemies[0].alarms, 2);
});

await test('our kill from the log, the same death heard twice, and bookkeeping that closes 30s later', () => {
  const log = [
    { kind: 'combat', event: 'pvp_attacked', at: T('19:43:52.887'), observer: 'Gonzo', room: 101, target: 'Rick Deckard', decision: 'd', attackers: [{ character: 'Rick Deckard', incoming_hits: 0, incoming_misses: 0, outgoing_hits: 0, outgoing_misses: 0 }] },
    { kind: 'combat', event: 'wand_volley', at: T('19:43:53.305'), observer: 'Gonzo', room: 101, target: 'Rick Deckard', decision: 'd', attackers: [{ character: 'Rick Deckard', incoming_hits: 0, incoming_misses: 0, outgoing_hits: 0, outgoing_misses: 0 }] },
    { kind: 'combat', event: 'pvp_outcome', at: T('19:43:53.339'), observer: 'Gonzo', room: 101, target: 'Rick Deckard', decision: 'd', attackers: [{ character: 'Rick Deckard', incoming_hits: 0, incoming_misses: 0, outgoing_hits: 1, outgoing_misses: 0 }] },
    { kind: 'death', at: T('19:43:53.370'), observer: 'Gonzo', victim: 'Rick Deckard', killer: 'Gonzo', our_side: 'killer', victim_guild: 'Human Resistance', room: 101 },
    { kind: 'combat', event: 'finished', at: T('19:44:22.901'), observer: 'Gonzo', room: 101, target: 'Rick Deckard', decision: 'd', attackers: [{ character: 'Rick Deckard', incoming_hits: 0, incoming_misses: 0, outgoing_hits: 1, outgoing_misses: 0 }] },
    { kind: 'death', at: T('19:50:00'), observer: 'Pepe', victim: 'Pepe', killer: 'Rick Deckard', our_side: 'victim', room: 101 },
  ];
  const r = report({ log, ledger: [death('19:50:01', 'Pepe', 'Rick Deckard')] });
  assert.equal(r.battles.length, 1);
  const b = r.battles[0];
  assert.equal(b.kills, 1); assert.equal(b.our_deaths, 1, 'the log line and the ledger row are one death');
  assert.equal(b.result, 'traded'); assert.equal(b.hits_out, 1, 'cumulative tallies are not summed per row');
  assert.equal(b.volleys, 1);
  assert.equal(b.ours.find(o => o.name === 'Gonzo').kills, 1);
  assert.equal(b.enemies[0].guild, 'Human Resistance');
  const only = report({ log: log.slice(0, 5) }).battles[0];
  assert.equal(only.duration_ms, T('19:43:53.370') - T('19:43:52.887'), '`finished` does not stretch it');
});

await test('a reconstructed battle stays one battle, and an unattributed kill still counts', () => {
  const recon = { id: 'b-recon', title: 't', provenance: 'p', notes: ['n'], enemies: [{ name: 'Rick Deckard', guild: 'Human Resistance' }],
    scene: { room: 101, actors: [{ name: 'Gonzo', side: 'ours', row: 16, col: 23, facing: 90 }, { name: 'Rick Deckard', side: 'enemy', row: 18, col: 26, facing: 257 }] },
    events: [
      { kind: 'seen', event: 'appeared', at: T('19:43:52.880'), observer: 'Gonzo', room: 101, enemies: ['Rick Deckard'], hostile: true, text: 'appears' },
      { kind: 'combat', event: 'wand_volley', at: T('19:43:53.305'), observer: 'Gonzo', room: 101, target: 'Rick Deckard' },
      { kind: 'combat', event: 'pvp_outcome', at: T('19:43:53.339'), observer: 'Gonzo', room: 101, target: 'Rick Deckard',
        last_outcome: { direction: 'outgoing', outcome: 'hit', text: 'Your lightning bolt shocks Rick Deckard.' } },
      { kind: 'death', at: T('19:43:53.370'), victim: 'Rick Deckard', killer: null, our_side: 'killer', room: 101, evidence: "operator's report" },
    ] };
  const r = report({ reconstructed: [recon] });
  assert.equal(r.battles.length, 1);
  const b = r.battles[0];
  assert.equal(b.id, 'b-recon'); assert.equal(b.kills, 1); assert.equal(b.result, 'won');
  assert.equal(b.hits_out, 1); assert.equal(b.duration_ms, 490);
  assert.ok(b.reconstructed.scene);
});

await test('the page: a tab in the shared nav, a dashboard route, escaped names, a scene', () => {
  assert.ok(TABS.some(t => t.key === 'pvp' && t.href === '/pvp'));
  assert.ok(isDashboardOnlyPath('/pvp'), 'the broker port redirects /pvp to the dashboard');
  const r = report({ ledger: [death('10:00', 'Pepe', '<script>x</script>')], reconstructed: [] });
  const html = renderPvp({ report: r });
  assert.match(html, /<a href="\/pvp" class="on">PVP<\/a>/);
  assert.ok(!html.includes('<script>x'), 'a player name is escaped');
  assert.ok(html.includes('&lt;script&gt;x'));
  const empty = renderPvp({ report: report() });
  assert.match(empty, /No battles in this window/);
});

await test('only a session with a real recorder writes the durable log', () => {
  const before = existsSync(join(process.env.M59_PVP_DIR, '2026-10-06.jsonl'))
    ? readFileSync(join(process.env.M59_PVP_DIR, '2026-10-06.jsonl'), 'utf8') : '';
  const fake = Object.create(CombatMode.prototype);
  fake.s = { name: 'Gonzo', recorder: { line() {} }, world: { room: { num: 101 } } };
  fake.now = () => T('19:43:53.370'); fake.isOurs = isOurs;
  fake.recordPvpDeath({ kind: 'message', text: WE_KILLED, at: T('19:43:53.370') }, { me: { name: 'Gonzo' } });
  const mid = existsSync(join(process.env.M59_PVP_DIR, '2026-10-06.jsonl'))
    ? readFileSync(join(process.env.M59_PVP_DIR, '2026-10-06.jsonl'), 'utf8') : '';
  assert.equal(mid, before, 'a test fake writes nothing');
  fake.s.recorder = new Recorder('Gonzo', { directory: join(dir, 'rec') });
  fake.recordPvpDeath({ kind: 'message', text: WE_KILLED, at: T('19:43:53.370') }, { me: { name: 'Gonzo' } });
  const rows = pvp.readPvpLog({ since: T('19:00'), until: T('20:00') });
  assert.equal(rows.length, 1); assert.equal(rows[0].our_side, 'killer'); assert.equal(rows[0].room, 101);
  fake.s.recorder.stop();
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${tests} passed`);
