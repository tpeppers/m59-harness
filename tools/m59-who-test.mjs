#!/usr/bin/env node
// m59-who-test.mjs — `who` ANSWERS ON A KEEPER-BACKED CHARACTER, AND IT NEVER SPEAKS.
//
//   node tools/m59-who-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster.
//
// 2026-10-03: asked whether Morpheus (a hostile player who had killed six of the fleet that
// morning) was online, the broker's `who` tool answered `error: c.players is not a function` --
// on every prod character, because every one is keeper-backed and `s.need()` there is
// KeeperProxy's PICTURE client, rebuilt from /state with no wire. What this pins:
//   1. readWho on a live client refreshes the list and returns {players, here, refreshed,
//      last_refreshed_ms, refreshed_at};
//   2. it sends exactly one thing -- the players request -- and never says, tells or sends;
//   3. the keeper path (KeeperProxy.who -> /action who -> readWho in the keeper, JSON across)
//      gives the SAME reply shape as the in-process path;
//   4. a keeper error is thrown, never reported as "nobody is online";
//   5. a reply that does not come back in time says so, and reports the age of the last list;
//   6. `name` answers "is X online / here";
//   7. the wiring: the broker tool no longer calls c.players(), KeeperProxy forwards `who`, and
//      the keeper's `who` case runs readWho and sends no speech.

import { readFileSync } from 'node:fs';
import { readWho, whoReply, runWho } from './m59-who.mjs';
import { OF } from './m59-parse.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// A live client: a players() that answers with a 'who' event, and every way of speaking wired
// to a recorder so a single word out is caught.
const fakeLive = ({ answers = true, online = [[7, 'Morpheus'], [8, 'Kermit'], [9, 'Me']] } = {}) => {
  const calls = [];
  const events = [];
  let seq = 0;
  const names = new Map([[100, 'Me'], [101, 'Kermit'], [102, 'Morpheus']]);
  const c = {
    selfId: 9, evSeq: 0, calls,
    playersOnline: new Map(),
    rsc: { get: r => names.get(r) ?? '' },
    room: { objects: new Map([
      [9, { id: 9, flags: OF.PLAYER, nameRsc: 100 }],
      [8, { id: 8, flags: OF.PLAYER, nameRsc: 101 }],
      [55, { id: 55, flags: OF.ATTACKABLE, nameRsc: 0 }],           // a monster, not a player
    ]) },
    players() {
      calls.push('players');
      if (!answers) return;
      c.playersOnline.clear();
      for (const [id, name] of online) c.playersOnline.set(id, { id, name });
      events.push({ seq: ++seq, kind: 'who' }); c.evSeq = seq;
    },
    waitFor: async ({ since = 0, kinds } = {}) =>
      ({ events: events.filter(e => e.seq > since && (!kinds || kinds.includes(e.kind))) }),
  };
  for (const v of ['say', 'sayGroup', 'tell', 'send', 'yell', 'broadcast', 'sayGuild', 'attack', 'cast'])
    c[v] = (...a) => { calls.push(v); };
  return c;
};
const fakePacer = () => { const kinds = []; return { kinds, submit: async (k, fn) => { kinds.push(k); return fn(); } }; };

console.log('\n1. a live client: refreshed, and the shape');
{
  const c = fakeLive(), pacer = fakePacer();
  const r = await readWho(c, { pacer, now: () => 1_000_000 });
  ok('players lists everyone online', r.players.map(p => p.name).join() === 'Morpheus,Kermit,Me');
  ok('with their ids', r.players[0].id === 7);
  ok('here is the players in the room, monsters excluded', r.here.map(p => p.name).join() === 'Me,Kermit');
  ok('self is marked', r.here.find(p => p.name === 'Me')?.self === true);
  ok('refreshed is true', r.refreshed === true);
  ok('last_refreshed_ms is 0 for a list that just arrived', r.last_refreshed_ms === 0);
  ok('refreshed_at is an ISO time', r.refreshed_at === new Date(1_000_000).toISOString());
}

console.log('\n2. read-only: one request, and no speech of any kind');
{
  const c = fakeLive(), pacer = fakePacer();
  await runWho({ client: c, pacer, name: 'Morpheus' });
  ok('the only call on the client is players()', c.calls.join() === 'players', c.calls.join());
  ok('and it went through the pacer as a READ', pacer.kinds.join() === 'read', pacer.kinds.join());
}

console.log('\n3. the keeper path gives the same reply as the in-process path');
{
  // The keeper half: the live client is in the keeper process, and its reply crosses as JSON.
  const keeperLive = fakeLive();
  const keeper = { asked: [], async who(opts) { this.asked.push(opts);
    return JSON.parse(JSON.stringify(await readWho(keeperLive, { pacer: fakePacer(), now: () => 5 }))); } };
  // The broker's picture client has no players() -- exactly what threw on prod.
  const picture = { room: { objects: new Map() }, rsc: { get: () => '' } };
  const viaKeeper = await runWho({ keeper, client: picture, pacer: fakePacer(), name: 'morpheus' });
  const inProcess = await runWho({ client: fakeLive(), pacer: fakePacer(), name: 'morpheus' });
  const strip = r => ({ ...r, last_refreshed_ms: null, refreshed_at: null });
  ok('the keeper was asked once', keeper.asked.length === 1);
  ok('the two replies are identical apart from the clock',
     JSON.stringify(strip(viaKeeper)) === JSON.stringify(strip(inProcess)),
     JSON.stringify(strip(viaKeeper)) + ' vs ' + JSON.stringify(strip(inProcess)));
  ok('and the keeper reply is marked refreshed', viaKeeper.refreshed === true);
  ok('the keeper-side client spoke to nobody', keeperLive.calls.join() === 'players');
  let threw = null;
  try { await runWho({ client: picture, pacer: fakePacer() }); } catch (e) { threw = e.message; }
  ok('asking the picture directly is a loud error, not an empty list', /live client/.test(threw ?? ''), threw);
}

console.log('\n4. a keeper error is an error');
{
  for (const reply of [{ error: 'fetch failed', timed_out_after_ms: 15000 }, { error: 'unknown action: who' }, null, {}]) {
    let threw = null;
    try { await runWho({ keeper: { who: async () => reply } }); } catch (e) { threw = e.message; }
    ok(`${JSON.stringify(reply)} throws rather than answering "nobody online"`, !!threw, String(threw));
  }
}

console.log('\n5. no full list in time: said, and the age of the last one');
{
  const c = fakeLive();
  let t = 1_000;
  await readWho(c, { pacer: fakePacer(), now: () => t });                  // a good one at t=1000
  const silent = fakeLive({ answers: false });
  silent.playersOnline = c.playersOnline; silent._whoRefreshedAt = c._whoRefreshedAt;
  t = 61_000;
  const r = await readWho(silent, { pacer: fakePacer(), timeoutMs: 10, now: () => t });
  ok('refreshed is false', r.refreshed === false);
  ok('last_refreshed_ms is the age of the last full list', r.last_refreshed_ms === 60_000, String(r.last_refreshed_ms));
  ok('the incremental list is still returned', r.players.length === 3);
  ok('and a note says it may be stale', /stale/.test(r.note ?? ''));
  const never = await readWho(fakeLive({ answers: false }), { pacer: fakePacer(), timeoutMs: 10 });
  ok('a client that never saw a list says null, not 0', never.last_refreshed_ms === null);
}

console.log('\n6. "is X online right now"');
{
  const raw = await readWho(fakeLive(), { pacer: fakePacer() });
  const q = n => whoReply(raw, { name: n }).query;
  ok('Morpheus is online', q('Morpheus').online === true);
  ok('case-insensitively', q('  MORPHEUS ').online === true);
  ok('but not in this room', q('Morpheus').in_room === false);
  ok('Kermit is online and here', q('Kermit').online && q('Kermit').in_room);
  ok('a partial name is a partial match, not "online"', q('Morph').online === false && q('Morph').matches.length === 1);
  ok('nobody by that name: online false, no matches', q('Wenbo').online === false && q('Wenbo').matches.length === 0);
  ok('no name, no query block', whoReply(raw).query === undefined);
}

console.log('\n7. the wiring');
{
  const BROKER = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  const KEEPER = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  const start = BROKER.indexOf("name: 'who',");
  const tool = BROKER.slice(start, BROKER.indexOf("name: 'wait_for_event'", start));
  ok('the broker has a who tool', start > 0);
  ok('it no longer calls c.players() on whatever s.need() returned',
     !/c\.players\(\)/.test(tool.replace(/^\s*\/\/.*$/gm, '')));
  ok('it runs runWho, with the KeeperProxy as the keeper when there is one',
     /s instanceof KeeperProxy \? s : null/.test(tool) && /runWho\(/.test(tool));
  ok('KeeperProxy forwards who to the keeper op',
     /async who\(opts = \{\}\) \{ return keeperAction\(this\.name, this\._index, 'who', opts/.test(BROKER));
  const kStart = KEEPER.indexOf("case 'who': {");
  const kCase = KEEPER.slice(kStart, KEEPER.indexOf('return;\n          }', kStart));
  ok('the keeper has a who case', kStart > 0);
  ok('which runs readWho on its live client', /readWho\(c, \{ pacer: session\.pacer/.test(kCase));
  ok('and speaks to nobody', !/say|tell|sayGroup|send\(/.test(kCase.replace(/^\s*\/\/.*$/gm, '')));
  ok('the keeper imports readWho', /import \{ readWho \} from '\.\/m59-who\.mjs';/.test(KEEPER));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
