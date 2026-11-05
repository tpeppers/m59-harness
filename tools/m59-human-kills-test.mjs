// Offline guard for COUNTING A PERSON'S KILLS (m59-human-kills.mjs; dedupeKills in m59-ledger.mjs, which countKills
// and m59-roomyield go through; the gate proxy's attach and the MANAGE tab's status line). Opens no socket, touches no
// roster, writes no ledger.
//
//   node tools/m59-human-kills-test.mjs
//
// Operator, 2026-11-04: pull kills/30m for the characters he plays by hand through the DebugClient, to compare with
// the bots'. Pinned: the kill sentence and only it; the row has the keeper's shape plus human:true; nothing is written
// while a keeper is attached, for a player, or before the character is known; a kill both a keeper and the proxy saw
// counts once (and a different creature or a later kill does not merge); the 30-minute window and its rate; the
// per-room split; the status line; and the proxy / desk wiring.
// 2026-11-05: the stroke / touch-spell kill lines (which replace "You killed"); bystander, victim and assassin lines
// are not kills; the row lands in the ledger beside the roster the proxy serves (end to end, into a temp dir, read
// back through countKills); and the broker's not-in-game row -- where a piloted character sits -- carries kills_30m.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { killedCreature, killRates, HumanKillObserver, killStatusLine, dedupeKills, HUMAN_DEDUPE_MS } from './m59-human-kills.mjs';
import { countKills, recordEventIn } from './m59-ledger.mjs';
import { attachHumanKills } from './m59-human-kills.mjs';
import { ledgerDirForRoster } from './m59-fleetpath.mjs';
import { mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const MIN = 60_000, NOW = 1_800_000_000_000;

await ok('the kill sentence, with or without colour codes and articles; nothing else', () => {
  assert.equal(killedCreature('You killed the orc.'), 'orc');
  assert.equal(killedCreature('~bYou killed a spider.'), 'spider');
  assert.equal(killedCreature('Your sword slashes the orc.'), null);
  assert.equal(killedCreature('The orc killed you.'), null);
  assert.equal(killedCreature(null), null);
});

// --- the observer, on hand-built packets ------------------------------------------------------------------
const FMT = 900001;
function msgPacket(text, op = 32) {
  const b = Buffer.alloc(5); b[0] = op; b.writeUInt32LE(FMT, 1);
  return { packet: b, text };
}
function observer({ attached = false, name = 'Scooter', online = [] } = {}) {
  const rows = [];
  let text = '';
  const comms = { inGame: true, lookup: id => (id === FMT ? text : undefined),
    c: { me: name ? { name } : null, playersOnline: new Map(online.map((nm, i) => [i, { name: nm }])) },
    characters: new Map([['scooter', { agent: 't21', name: 'Scooter' }]]) };
  const obs = new HumanKillObserver({ comms, record: (c, kind, d) => rows.push({ character: c, kind, ...d }),
    attached: () => attached, roomOf: () => 27 });
  obs.roomNum = 27; obs.roomName = 'A Deep, Dark, Spooky, Icky Cave';
  return { obs, rows, say: t => { text = t; obs.serverPacket(msgPacket(t).packet); } };
}
await ok('a kill line in a piloted session writes the keeper\'s row shape, marked human', () => {
  const { rows, say } = observer();
  say('You killed the orc.');
  say('Your mace bashes the spider.');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { character: 'Scooter', kind: 'killed', agent: 't21', creature: 'orc',
    room: 'A Deep, Dark, Spooky, Icky Cave', room_num: 27, human: true, source: 'proxy', from_safe_spot: null });
});
await ok('NEVER TWICE at the source: nothing while a keeper drives the connection', () => {
  const { obs, rows, say } = observer({ attached: true });
  say('You killed the orc.');
  assert.equal(rows.length, 0); assert.equal(obs.skipped.attached, 1);
});
await ok('a player is not a monster kill, and an unknown character writes nothing', () => {
  const a = observer({ online: ['Morpheus'] }); a.say('You killed Morpheus.'); assert.equal(a.rows.length, 0);
  const b = observer({ name: null }); b.say('You killed the orc.'); assert.equal(b.rows.length, 0);
});

// --- dedupe and the readers -------------------------------------------------------------------------------
const K = (character, t, extra = {}) => ({ type: 'event', kind: 'killed', character, creature: 'orc', room_num: 27, t, ...extra });
await ok('a kill both a keeper and the proxy recorded counts ONCE (the keeper row kept)', () => {
  const ev = [K('Scooter', NOW - 10 * MIN, { agent: 't21' }), K('Scooter', NOW - 10 * MIN + 1200, { human: true })];
  assert.equal(dedupeKills(ev).length, 1);
  assert.equal(dedupeKills(ev)[0].human, undefined);
  assert.equal(countKills(ev, 0).get('Scooter'), 1);
});
await ok('...but a different creature, another character, or a kill outside the dedupe window is its own kill', () => {
  const base = K('Scooter', NOW - 10 * MIN);
  assert.equal(dedupeKills([base, K('Scooter', base.t + 500, { human: true, creature: 'spider' })]).length, 2);
  assert.equal(dedupeKills([base, K('Kermit', base.t + 500, { human: true })]).length, 2);
  assert.equal(dedupeKills([base, K('Scooter', base.t + HUMAN_DEDUPE_MS + 1, { human: true })]).length, 2);
});
await ok('with no human rows the readers see exactly what they saw before', () => {
  const ev = [K('Kermit', 1), K('Kermit', 2)];
  assert.equal(dedupeKills(ev), ev);
});
await ok('the 30-minute window: by hand vs keeper, rate per 30 minutes of window, per room', () => {
  const ev = [
    K('Scooter', NOW - 40 * MIN, { human: true }),                       // outside 30 min
    ...[5, 10, 15, 20].map(m => K('Scooter', NOW - m * MIN, { human: true, agent: 't21' })),
    K('Scooter', NOW - 3 * MIN, { human: true, room_num: 599, creature: 'troll' }),
    ...[2, 12].map(m => K('Kermit', NOW - m * MIN, { agent: 't1' })),
  ];
  const rows = killRates(ev, { from: NOW - 30 * MIN, to: NOW });
  const s = rows.find(r => r.character === 'Scooter'), k = rows.find(r => r.character === 'Kermit');
  assert.deepEqual([s.human, s.keeper, s.total], [5, 0, 5]);
  assert.deepEqual(s.kills_30m, { human: 5, keeper: 0, total: 5 });
  assert.deepEqual(s.rooms, { 27: { human: 4, keeper: 0 }, 599: { human: 1, keeper: 0 } });
  assert.deepEqual(k.kills_30m, { human: 0, keeper: 2, total: 2 });
  const sixty = killRates(ev, { from: NOW - 60 * MIN, to: NOW });
  assert.equal(sixty.find(r => r.character === 'Scooter').kills_30m.human, 3, '6 by hand in 60 min is 3 per 30');
  assert.equal(killRates(ev, { from: NOW - 30 * MIN, to: NOW, room: 27 }).find(r => r.character === 'Scooter').total, 4);
});
await ok('the MANAGE-tab status: mine (by hand) beside the bots', () => {
  const rows = killRates([K('Scooter', NOW - MIN, { human: true }), K('Kermit', NOW - MIN), K('Kermit', NOW - 2 * MIN),
    K('Floyd', NOW - MIN)], { from: NOW - 30 * MIN, to: NOW });
  assert.equal(killStatusLine(rows, 'Scooter'), 'kills/30m 1 (by hand 1) | bots avg 1.5, best Kermit 2');
  assert.match(killStatusLine([], 'Scooter'), /^kills\/30m 0 \(by hand 0\) \| bots avg 0\.0$/);
});

// --- the other kill lines (2026-11-05) -----------------------------------------------------------------------
// player.kod KilledSomething sends "You killed %s%s." UNLESS the stroke or touch spell supplies its own line; then
// "You killed" never arrives. Texts are the kod resources verbatim with %s%s = GetCapDef + GetName filled in.
await ok('stroke and touch-spell kill lines are kills (kod text verbatim)', () => {
  const cases = [
    ['The orc crumples to the ground, never to rise again.', 'orc'],                              // punch.kod:25
    ["The troll is knocked to the ground by your kick - and doesn't get up.", 'troll'],             // kick.kod:25
    ['With a quick thrust, you finish off the giant rat.', 'giant rat'],                          // thrust.kod:22
    ['The living tree screams and melts into an unobtrusive puddle.', 'living tree'],             // acidtch.kod:33
    ['An ant, engulfed in flames, lets out a final scream.', 'ant'],                              // flametch.kod:34
    ["The mummy finally succumbs, finding peace through Shal'ille's purifying energy.", 'mummy'], // holytch.kod:35
    ['A spider finds a cold unsurpassed by any other death.', 'spider'],                          // icyfing.kod:33
    ['The kriipa lets out a final scream in protest to your electric touch.', 'kriipa'],          // zap.kod:32
    ['~bThe orc crumples to the ground, never to rise again.', 'orc'],
  ];
  for (const [text, want] of cases) assert.equal(killedCreature(text), want, text);
});
await ok("ANOTHER PLAYER'S KILL IS NOT OURS: bystander, victim and assassin lines are not kills", () => {
  for (const text of [
    'Morpheus has slain the orc.',                                    // someone else's announcement
    'Morpheus killed the orc.',
    'The orc killed you.',
    "The last thing you see is Morpheus's fist speeding towards your nose.",   // punch_player_was_killed
    'At the touch of Morpheus, you let out a final scream and die.',           // AcidTouch_player_was_killed
    'You have slain Morpheus with your black dagger!',                         // assassin game: a PLAYER kill
    'The orc crumples to the ground.',                                          // not the whole sentence
    'You killed the orc. Or did you?',
  ]) assert.equal(killedCreature(text), null, text);
});
await ok('a stroke kill of a PLAYER on the online list is skipped like "You killed <player>"', () => {
  const a = observer({ online: ['Morpheus'] });
  a.say('Morpheus crumples to the ground, never to rise again.');
  assert.equal(a.rows.length, 0); assert.equal(a.obs.skipped.player, 1);
  a.say('The orc crumples to the ground, never to rise again.');
  assert.equal(a.rows.length, 1); assert.equal(a.rows[0].creature, 'orc');
});

// --- the ledger the row lands in ----------------------------------------------------------------------------
await ok("the ledger is the one BESIDE THE ROSTER the proxy serves, not the proxy code's checkout", () => {
  const sub = resolve('C:/code/m59-lab/prod-deploy/substrate');
  assert.equal(ledgerDirForRoster(join(sub, 'fleets', 'prod.json'), {}), join(sub, 'history', 'prod'));
  assert.equal(ledgerDirForRoster(join(sub, 'fleet-state.json'), {}), join(sub, 'history'));
  assert.equal(ledgerDirForRoster(join(sub, 'elsewhere.json'), {}), null);
  assert.equal(ledgerDirForRoster(null, {}), null);
  assert.equal(ledgerDirForRoster(join(sub, 'fleets', 'prod.json'), { M59_LEDGER_DIR: 'X' }), 'X');
});
await ok('END TO END: a piloted kill packet -> a row in that ledger -> countKills counts it, keeper-shaped', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'm59-pilot-kills-'));
  const guard = join(tmp, 'never-written');
  const prevEnv = process.env.M59_LEDGER_DIR;
  process.env.M59_LEDGER_DIR = guard;   // satisfies the ledger's test guard; the row must NOT land here
  try {
    const dir = ledgerDirForRoster(join(tmp, 'substrate', 'fleets', 'prod.json'), {});
    let text = '';
    const session = new EventEmitter();
    session.communications = { inGame: true, lookup: id => (id === FMT ? text : undefined),
      c: { me: { name: 'Zoot' }, playersOnline: new Map([[1, { name: 'Morpheus' }]]) },
      characters: new Map([['zoot', { agent: 't17', name: 'Zoot' }]]) };
    const obs = await attachHumanKills(session, { ledgerDir: dir });
    obs.roomNum = 2143; obs.roomName = 'Avar Village outskirts';
    for (const t of ['You killed the avar shaman.', 'Morpheus has slain the troll.', 'You killed Morpheus.',
                     'The avar warrior crumples to the ground, never to rise again.']) {
      text = t; session.emit('received-server-packet', msgPacket(t).packet);
    }
    // A keeper's row for another character, written the way autopilot/journal.mjs ledgerEvent writes one.
    recordEventIn(dir, 'Kermit', 'killed', { agent: 't1', creature: 'orc', room: 'X', room_num: 27, rounds: 3,
      from_safe_spot: false, fought_back: true });
    session.emit('closed');
    assert.equal(existsSync(guard), false, 'nothing written into the env ledger');
    const files = readdirSync(dir).filter(f => /^fleet-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    assert.equal(files.length, 1);
    const rows = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const human = rows.filter(r => r.human === true), keeper = rows.find(r => r.character === 'Kermit');
    assert.deepEqual(human.map(r => r.creature), ['avar shaman', 'avar warrior']);
    for (const r of human) {
      assert.equal(r.type, 'event'); assert.equal(r.kind, 'killed'); assert.equal(r.character, 'Zoot');
      assert.equal(r.agent, 't17'); assert.equal(r.room_num, 2143); assert.equal(r.source, 'proxy');
      assert.ok(Number.isFinite(r.t) && typeof r.iso === 'string');
      for (const k of ['t', 'iso', 'type', 'character', 'kind', 'agent', 'creature', 'room', 'room_num'])
        assert.ok(k in r && k in keeper, `both rows carry ${k}`);
    }
    const by = countKills(rows, 0);
    assert.equal(by.get('Zoot'), 2, 'the broker tally (countKills, behind killsIn -> kills_30m) counts them');
    assert.equal(by.get('Kermit'), 1);
    assert.equal(by.get('Morpheus'), undefined);
  } finally {
    if (prevEnv === undefined) delete process.env.M59_LEDGER_DIR; else process.env.M59_LEDGER_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- wiring ------------------------------------------------------------------------------------------------
await ok('the gate proxy attaches it beside the communications decoder; the desk shows the line', () => {
  const proxy = readFileSync(new URL('./m59-proxy.mjs', import.meta.url), 'utf8');
  assert.match(proxy, /s\.communications=attachProxyCommunications[^\n]*\n[\s\S]{0,400}attachHumanKills\(s,/);
  assert.match(proxy, /killLedgerDir=communicationStateFile\?ledgerDirForRoster\(communicationStateFile\)/);
  assert.match(proxy, /attachHumanKills\(s,\{log,ledgerDir:killLedgerDir\}\)/);
  const broker = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  assert.match(broker, /in_game: false,\s*kills_30m: offName \? \(recentKills\.get\(offName\) \?\? 0\) : 0,/,
    'a piloted (keeper-stopped, not-in-game) row still carries kills_30m');
  const desk = readFileSync(new URL('./m59-plan-desk.mjs', import.meta.url), 'utf8');
  assert.match(desk, /killStatusLine\(rows, req\.character\)/);
  const ry = readFileSync(new URL('./m59-roomyield.mjs', import.meta.url), 'utf8');
  assert.match(ry, /for \(const e of dedupeKills\(events\)/);
});

console.log(`\n${n} passed`);
