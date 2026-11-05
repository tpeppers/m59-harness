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
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { killedCreature, killRates, HumanKillObserver, killStatusLine, dedupeKills, HUMAN_DEDUPE_MS } from './m59-human-kills.mjs';
import { countKills } from './m59-ledger.mjs';

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

// --- wiring ------------------------------------------------------------------------------------------------
await ok('the gate proxy attaches it beside the communications decoder; the desk shows the line', () => {
  const proxy = readFileSync(new URL('./m59-proxy.mjs', import.meta.url), 'utf8');
  assert.match(proxy, /s\.communications=attachProxyCommunications[^\n]*\n[\s\S]{0,400}attachHumanKills\(s,/);
  const desk = readFileSync(new URL('./m59-plan-desk.mjs', import.meta.url), 'utf8');
  assert.match(desk, /killStatusLine\(rows, req\.character\)/);
  const ry = readFileSync(new URL('./m59-roomyield.mjs', import.meta.url), 'utf8');
  assert.match(ry, /for \(const e of dedupeKills\(events\)/);
});

console.log(`\n${n} passed`);
