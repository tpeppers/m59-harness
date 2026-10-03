#!/usr/bin/env node
// m59-ally-test.mjs — A BUFF OR A HEAL GOES TO ONE OF OURS, NEVER TO THE MAN KILLING US.
//
//   node tools/m59-ally-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster: every book the rule reads is
// pointed at a scratch directory before the first read.
//
// The incident, 2026-10-03 12:53:23Z on prod: Beaker (t6) cast BLESS on Morpheus -- a Human
// Resistance player in the war book with 297 hits in the grudge book -- thirty seconds after
// Morpheus had killed six fleet characters in Castle Victoria, with the ledger reason "an ally
// in the room". `Autopilot.buffAllies` took every player-flagged object as an ally. What this
// pins, in m59-ally.mjs's order:
//   - a fleet-mate is an ally; a stranger is not, by default;
//   - hostility (war flag, war book, grudge book of any age, a PvP-death killer) refuses the
//     buff EVEN IF the name is also a fleet-mate, a named friend, a guildmate or server-FRIEND;
//   - a source that throws fails CLOSED;
//   - buffAllies and medic cast only on allies, and with nobody but an enemy in the room they
//     cast nothing and say why.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOOKS = mkdtempSync(join(tmpdir(), 'm59-ally-'));
process.env.M59_GRUDGE_FILE = join(BOOKS, 'grudges.json');
process.env.M59_WAR_FILE = join(BOOKS, 'war.json');
process.env.M59_PVP_HOLD_DIR = join(BOOKS, 'holds');

const { allyVerdict, hostileBasis } = await import('./m59-ally.mjs');
const party = await import('./m59-party.mjs');
const grudge = await import('./m59-grudge.mjs');
const war = await import('./m59-war.mjs');
const { writePvpDeath, knownKillers } = await import('./m59-pvp-return.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

const P = OF.PLAYER;
const none = { isFleetmate: () => false, grudge: () => null, warMember: () => null, killers: () => new Set() };

console.log('\nthe rule, with every source injected');
{
  const mate = { ...none, isFleetmate: n => n === 'Kermit' };
  ok('a fleet-mate is an ally', allyVerdict({ name: 'Kermit', flags: P }, { sources: mate }).ally === true);
  ok('and the basis says why', allyVerdict({ name: 'Kermit', flags: P }, { sources: mate }).basis === 'fleetmate');
  ok('a stranger is NOT an ally', allyVerdict({ name: 'Passerby', flags: P }, { sources: mate }).ally === false);
  ok('and is called a stranger', allyVerdict({ name: 'Passerby', flags: P }, { sources: mate }).basis === 'stranger');
  ok('a named friend is an ally',
     allyVerdict({ name: 'Old Pal', flags: P }, { friends: ['old pal'], sources: none }).basis === 'friend');
  ok('a guildmate we do not run is not an ally by that alone',
     allyVerdict({ name: 'Swine', flags: P | war.GUILDMATE_FLAG }, { sources: none }).ally === false);
  ok('nor is a player the server flags FRIEND',
     allyVerdict({ name: 'Pal', flags: P | OF.FRIEND }, { sources: none }).ally === false);
  ok('a monster is not an ally', allyVerdict({ name: 'Kermit', flags: OF.ATTACKABLE }, { sources: mate }).ally === false);
  ok('an unresolved name is not an ally', allyVerdict({ name: '', flags: P }, { sources: mate }).ally === false);
}

console.log('\nhostility beats every reason to help');
{
  const everythingFriendly = { isFleetmate: () => true };
  const asFriend = { friends: ['Morpheus'] };
  const flags = P | war.GUILDMATE_FLAG | OF.FRIEND;
  const cases = {
    'the server war flag': { ...none, ...everythingFriendly },
    'the war book': { ...none, ...everythingFriendly, warMember: () => ({ guild: 'Human Resistance' }) },
    'the grudge book': { ...none, ...everythingFriendly, grudge: () => ({ hits: 297, victims: ['Beaker'] }) },
    'a PvP-death killer record': { ...none, ...everythingFriendly, killers: () => new Set(['morpheus']) },
  };
  for (const [what, sources] of Object.entries(cases)) {
    const f = what === 'the server war flag' ? flags | war.ENEMY_FLAG : flags;
    const v = allyVerdict({ name: 'Morpheus', flags: f }, { ...asFriend, sources });
    ok(`${what}: refused even as fleet-mate + friend + guildmate + FRIEND`, v.ally === false, JSON.stringify(v));
    ok(`${what}: and the reason says hostile`, /^hostile/.test(v.why));
  }
  const throws = { isFleetmate: () => { throw new Error('roster unreadable'); },
                   grudge: () => null, warMember: () => null, killers: () => new Set() };
  ok('a fleet-mate source that throws fails CLOSED',
     allyVerdict({ name: 'Kermit', flags: P }, { sources: throws }).ally === false);
}

console.log('\nthe real books, written by their own writers');
{
  party.setRosterSource(() => new Set(['Kermit', 'Beaker', 'Marco Polo']));
  war.declareEnemyGuild('Human Resistance');
  war.recordMembership('Morpheus', 'Human Resistance', { source: 'guild_combat' });
  // Refused lately: `rememberedEnemy` stops calling him a target, and he must STILL not be helped.
  war.markRefused('Morpheus', { why: 'out of reach' });
  war.recordMembership('Wenbo', 'Human Resistance', { source: 'guild_combat' });
  // A grudge from yesterday -- outside the hour that governs return fire, inside "ever attacked us".
  grudge.recordAttack('Sasquatch', { who: 'Robin', at: Date.now() - 24 * 3600_000 });
  mkdirSync(process.env.M59_PVP_HOLD_DIR, { recursive: true });
  writePvpDeath('t9', { died_at: Date.now(), killers: ['Gountrug'], basis: 'player_in_room' });
  writePvpDeath('t10', { died_at: Date.now(), killers: ['Kermit'], basis: 'fleetmate' });
  writeFileSync(join(process.env.M59_PVP_HOLD_DIR, 'broken.json'), '{nope');

  ok('the pvp holds name Gountrug as a killer', knownKillers(process.env, { ttlMs: 0 }).has('gountrug'));
  ok('but not a fleet-mate filed under basis fleetmate', !knownKillers(process.env, { ttlMs: 0 }).has('kermit'));
  const v = n => allyVerdict({ name: n, flags: P });
  ok('Kermit (roster) is an ally', v('Kermit').ally === true);
  ok('Marco Polo (roster) is an ally', v('Marco Polo').ally === true);
  ok('Morpheus (war book, refused lately) is not', v('Morpheus').ally === false && v('Morpheus').basis === 'war_book');
  ok('Wenbo (war book) is not', v('Wenbo').basis === 'war_book');
  ok('Sasquatch (grudge from yesterday) is not', v('Sasquatch').basis === 'grudge_book');
  ok('Gountrug (killed t9) is not', v('Gountrug').basis === 'killer');
  ok('a stranger is not', v('Rando').basis === 'stranger');
  ok('case and spacing do not let Morpheus through', v('  morpheus ').ally === false);
  ok('hostileBasis is null for one of ours', hostileBasis({ name: 'Kermit', flags: P }) === null);
}

// A client stub shaped like the real one where buffAllies and medic touch it.
const makeAp = (people, { cfg = { enabled: true } } = {}) => {
  const names = new Map([[3000, 'super strength'], [3001, 'bless'], [3002, 'minor heal'],
                         [2000, 'mushroom'], [2001, 'orc tooth'], [2002, 'sapphire'], [2003, 'herbs'],
                         [2004, 'elderberry']]);
  const objs = new Map([[1, { id: 1, flags: P, nameRsc: 4000 }]]);
  names.set(4000, 'Me');
  people.forEach(([name, flags = P], i) => {
    names.set(4001 + i, name);
    objs.set(90 + i, { id: 90 + i, flags, nameRsc: 4001 + i });
  });
  const casts = [];
  let mana = 60;
  const client = {
    selfId: 1,
    inventory: [500, 501, 502, 503, 504].map((id, i) => ({ id, nameRsc: 2000 + i, amount: 50 })),
    spells: [{ id: 11, nameRsc: 3000 }, { id: 12, nameRsc: 3001 }, { id: 13, nameRsc: 3002 }],
    abilities: new Map([[11, { ability: 20 }], [12, { ability: 20 }], [13, { ability: 20 }]]),
    rsc: { get: r => names.get(r) ?? '' },
    room: { objects: objs },
    vitals: () => ({ mana: { value: mana } }),
    cast: async (id, targets) => { casts.push({ id, to: targets.map(t => names.get(objs.get(t)?.nameRsc)) }); mana -= 5; return true; },
    waitFor: async () => ({ events: [] }),
  };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { buffAllies: cfg };
  ap.tally = {};
  ap.declined = [];
  ap.notes = [];
  ap.casts = casts;
  ap.s = { client, need: () => client, pacer: { submit: async (_k, fn) => fn() } };
  ap.declinedCast = (what, why, detail) => { ap.declined.push({ what, why, detail }); };
  ap.recordCast = () => {};
  ap.note = (what, detail) => { ap.notes.push({ what, detail }); };
  ap.progress = () => {};
  return ap;
};

console.log('\nbuffAllies: the 2026-10-03 room');
{
  const ap = makeAp([['Morpheus', P | war.ENEMY_FLAG], ['Kermit']]);
  await ap.buffAllies();
  ok('one cast went out', ap.casts.length === 1);
  ok('and it went to Kermit, not Morpheus', ap.casts[0]?.to?.[0] === 'Kermit', JSON.stringify(ap.casts));

  const alone = makeAp([['Morpheus']]);
  await alone.buffAllies();
  ok('with only Morpheus in the room NOTHING is cast', alone.casts.length === 0, JSON.stringify(alone.casts));
  ok('and it says there is no ally', alone.declined.at(-1)?.why === 'no ally in the room to buff');
  ok('naming why Morpheus was refused', JSON.stringify(alone.declined.at(-1)?.detail ?? {}).includes('Morpheus: war_book'));

  const stranger = makeAp([['Passerby']]);
  await stranger.buffAllies();
  ok('a stranger alone is not buffed either', stranger.casts.length === 0);

  const friend = makeAp([['Passerby']], { cfg: { enabled: true, friends: ['Passerby'] } });
  await friend.buffAllies();
  ok('unless the policy names him a friend', friend.casts.length === 1);

  const badFriend = makeAp([['Morpheus']], { cfg: { enabled: true, friends: ['Morpheus'] } });
  await badFriend.buffAllies();
  ok('and naming Morpheus a friend by mistake still buffs nothing', badFriend.casts.length === 0);
}

console.log('\nmedic: the same rule');
{
  const ap = makeAp([['Morpheus'], ['Sasquatch']]);
  ap.policy.buffAllies = null;
  await ap.medic();
  ok('nobody hostile is healed', ap.casts.length === 0, JSON.stringify(ap.casts));
  ok('and it says there is no ally', ap.declined.at(-1)?.why === 'no ally in the room to heal');
  const mate = makeAp([['Morpheus'], ['Beaker']]);
  await mate.medic();
  ok('a fleet-mate beside him is healed', mate.casts.length === 1 && mate.casts[0].to[0] === 'Beaker',
     JSON.stringify(mate.casts));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
