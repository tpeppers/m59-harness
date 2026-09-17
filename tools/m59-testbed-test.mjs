#!/usr/bin/env node
//
// The offline half of the test bed: the DM command vocabulary, the patrol ring, the
// scenario spec, and the one reply the chatter will make on its own in an arena.
//
// NONE OF THIS OPENS A SOCKET, and that is deliberate rather than convenient. Every
// live failure these three tools have had was "the command we sent was not the command
// we meant" — a room object id read out of a reply header, a karma figure a hundred
// times too small, a name with a digit in it that the server accepts and silently
// replaces. All of those are decidable from a string, and none of them needs a server
// to decide. What DOES need a server — whether the character actually moved — is the
// half these tools verify at runtime instead.
//
// The properties pinned here are the ones that fail in the DANGEROUS direction if
// inverted:
//
//   - a bare /OBJECT (\d+)/ over a `send` reply reads the RECEIVER, not the return
//     value, so `FindRoomByNum 60` answered 0 and six characters were relocated into the
//     system object while the server reported success;
//   - karma is stored in hundredths, so the obvious `set piKarma -60` is -0.6 karma and
//     looks like it worked;
//   - a character name may not contain a digit and the server does not refuse one, it
//     substitutes its 3/1/4/1/5/9 junk character;
//   - the arena reply must be refused on any server that is not this machine, because it
//     is speech addressed to a room that on prod contains real people.
import assert from 'node:assert/strict';
import * as dm from './m59-dm.mjs';
import { ring, phased } from './m59-patrol.mjs';
import { expand, validate, fill, ordinalWord, NAME_RE } from './m59-testbed.mjs';
import { CHAR_NAME_MIN, CHAR_NAME_MAX, checkCharacterName } from './m59-newchar.mjs';
import { arenaCall, isLocalServer, ARENA_ROOMS, ARENA_CHALLENGE_WORD } from './m59-chatter.mjs';

let n = 0;
const ok = (cond, why) => { assert.ok(cond, why); n++; };
const eq = (a, b, why) => { assert.deepEqual(a, b, why); n++; };

// ================================================================== m59-dm.mjs

// ------------------------------------------------------- reading a reply back
//
// THE FAILURE THIS EXISTS FOR. A `send` comes back as
//
//     :< return from OBJECT 0 MESSAGE FindRoomByNum (10268)
//     : OBJECT 267
//     :   is CLASS TosArena (10374)
//
// and the first `OBJECT n` in it is the object the message was SENT TO. Reading that as
// the answer made every relocate target the system object, and `UtilGoNearSquare` --
// which never says no -- returned 1 each time.
const FIND_ROOM_REPLY =
  ':< return from OBJECT 0 MESSAGE FindRoomByNum (10268)\r\n' +
  ': OBJECT 267\r\n' +
  ':   is CLASS TosArena (10374)\r\n:>\r\n';
eq(dm.returnedObject(FIND_ROOM_REPLY), 267,
   'the return value is the line that is a colon and an object, not the reply header');
ok(dm.returnedObject(FIND_ROOM_REPLY) !== 0, 'the receiver in the header is never the answer');

// The same shape for money, where the old fallback would have matched the PLAYER and
// then set piNumber on a player, which is not a property a player has.
eq(dm.returnedObject(
  ':< return from OBJECT 7124 MESSAGE GetMoneyObject (99)\r\n: OBJECT 7226\r\n:   is CLASS Money (12)\r\n'),
  7226, 'the money object, not the player that was asked for it');

eq(dm.returnedObject('Cannot find user with name Nosuchperson.'), null,
   'no return value reads as null rather than as some other object');

// ---------------------------------------------------------- lining replies up
//
// A batch is one write and the replies come back in order. Splitting on the echoed
// command is what lets a caller match a reply to the thing it asked -- which is the
// whole point of resolving twenty names in one round trip.
const CMDS = ['show name TESTER', 'show name Nobody', 'show name Alpha'];
const BATCH = '> show name TESTER\r\n:< object 7124\r\n:>\r\n> \r\n' +
              'show name Nobody\r\nCannot find user with name Nobody.\r\n> \r\n' +
              'show name Alpha\r\n:< object 7125\r\n:>\r\n';
const blocks = dm.split(BATCH, CMDS);
eq(blocks.length, 3);
ok(/7124/.test(blocks[0]), 'the first block belongs to the first command');
ok(/Cannot find/.test(blocks[1]), 'a missing name keeps its own slot');
ok(/7125/.test(blocks[2]) && !/7124/.test(blocks[2]),
   'a later block does not bleed the earlier one — that would map Alpha onto TESTER');

eq(dm.rejections(BATCH), ['Cannot find user with name Nobody.'],
   'a rejection is reported once, verbatim');
eq(dm.rejections('> set object 7124 piKarma INT -6000\r\n> \r\n'), [],
   'an ordinary success produces no complaint');

// ------------------------------------------------------------------- builders

eq(dm.setProp(7124, 'piKarma', -6000), 'set object 7124 piKarma INT -6000');

// KARMA IS IN HUNDREDTHS (player.kod:822) and NewKarma bounds it to +/-10000. Taking the
// number the player sees and multiplying is the whole conversion; getting it backwards
// gives -0.6 karma on a character that reads as done.
eq(dm.karmaCmd(7124, -60), 'set object 7124 piKarma INT -6000');
eq(dm.karmaCmd(7124, 0), 'set object 7124 piKarma INT 0');
eq(dm.karmaCmd(7124, -500), 'set object 7124 piKarma INT -10000',
   'past the limit clamps to the limit rather than writing a number the game will bound anyway');
eq(dm.karmaCmd(7124, 999), 'set object 7124 piKarma INT 10000');

// ALL THREE HEALTH PROPERTIES OR NONE. piHealth alone is refigured straight back down,
// and piMax_Health alone leaves the base — which is what the game reads as level.
eq(dm.healthCmds(7125, 50), [
  'set object 7125 piHealth INT 50',
  'set object 7125 piMax_Health INT 50',
  'set object 7125 piBase_Max_Health INT 50',
]);
eq(dm.manaCmds(7124, 200),
   ['set object 7124 piMana INT 200', 'set object 7124 piMax_Mana INT 200']);

// A number means all six; an object means the ones it names, and nothing else.
eq(dm.statCmds(7124, 50).length, 6);
ok(dm.statCmds(7124, 50).every(c => / INT 50$/.test(c)));
eq(dm.statCmds(7124, { might: 40, aim: 12 }),
   ['set object 7124 piMight INT 40', 'set object 7124 piAim INT 12']);
eq(dm.statCmds(7124, { nonsense: 5 }), [],
   'an attribute the game does not have is dropped, never sent as a typo');
eq(dm.statCmds(7124, { might: 900 }), ['set object 7124 piMight INT 50'],
   'clamped to the 50 the creation protocol caps at');

// bDM is the flag the game's own DM grants pass, and it is what skips the prerequisite
// checks — without it a grant is refused for a character that cannot yet learn the thing.
eq(dm.skillCmds(7125, 50, [401, 402]), [
  'send object 7125 AddSkill num INT 401 iability INT 50 bDM INT 1',
  'send object 7125 AddSkill num INT 402 iability INT 50 bDM INT 1',
]);
eq(dm.spellCmds(7124, 99, [1]),
   ['send object 7124 AddSpell num INT 1 iability INT 99 bDM INT 1']);

// ------------------------------------------------------------------- squares
//
// UtilGoNearSquare searches OUTWARD from the square it is handed until it finds one that
// will hold the object, so an out-of-bounds target does not fail — it lands somewhere
// else and returns 1. Clamping is what makes the request mean what it says.
eq(dm.clampSquare(13, 13, 24, 24), { row: 13, col: 13 });
eq(dm.clampSquare(99, 99, 24, 24), { row: 24, col: 24 }, 'clamped into the room, not sent as 99');
eq(dm.clampSquare(0, -5, 24, 24), { row: 1, col: 1 }, 'the grid is 1-based');
eq(dm.clampSquare(12.6, 12.4, 24, 24), { row: 13, col: 12 }, 'rounded to a square');

eq(dm.relocateCmd(7125, 267, 13, 16),
   'send object 0 UtilGoNearSquare what OBJECT 7125 where OBJECT 267 new_row INT 13 new_col INT 16');

// ---------------------------------------------------------------- the guard
//
// The maintenance port is unauthenticated and IP-restricted, and that is the entire
// security model, so pointing this at somebody else's server is not a configuration
// choice. prod is 76.214.42.186.
ok(dm.isLoopbackHost('127.0.0.1') && dm.isLoopbackHost('localhost') && dm.isLoopbackHost('::1'));
ok(!dm.isLoopbackHost('76.214.42.186'), 'prod is not this machine');
ok(!dm.isLoopbackHost(''), 'an empty host is not quietly treated as local');
ok(!dm.isLoopbackHost(undefined));
await assert.rejects(() => dm.dm(['show status'], { env: { M59_ADMIN_HOST: '76.214.42.186' } }),
                     /refusing to open a DM socket/,
                     'a remote host is refused before the connect, not after');
n++;

// ------------------------------------------------------ a pack, and topping it up
//
// A STACK REPORTS ITS piNumber; AN OBJECT WITHOUT ONE IS ONE THING. Getting that
// backwards counts fifty heartstones as one and hands the character fifty more.
const PACK_CMDS = ['show object 7301', 'show object 7306', 'show object 7307'];
const PACK_OUT =
  '> show object 7301\r\n:< OBJECT 7301 is CLASS Mushroom (12)\r\n: piNumber = INT 50\r\n:>\r\n' +
  '> show object 7306\r\n:< OBJECT 7306 is CLASS HeartStone (91)\r\n: poOwner = OBJECT 7124\r\n:>\r\n' +
  '> show object 7307\r\n:< OBJECT 7307 is CLASS HeartStone (91)\r\n: poOwner = OBJECT 7124\r\n:>\r\n';
eq(dm.parsePack(PACK_OUT, PACK_CMDS), { Mushroom: 50, HeartStone: 2 });

// A TARGET, NOT A DELIVERY. This is the bug the first live run of `m59-testbed.mjs up`
// had: re-running it added another 50 of everything rather than leaving 50, so a spec
// that is supposed to describe an end state described an errand instead.
eq(dm.topUp({ have: { Mushroom: 50 }, each: 50, stacking: ['Mushroom'] }), [],
   'a satisfied target produces no work at all');
eq(dm.topUp({ have: { Mushroom: 20 }, each: 50, stacking: ['Mushroom'] }),
   ['create object Mushroom number INT 30'], 'only the shortfall is created');
eq(dm.topUp({ have: {}, each: 50, stacking: ['Mushroom'] }),
   ['create object Mushroom number INT 50']);
eq(dm.topUp({ have: { Mushroom: 500 }, each: 50, stacking: ['Mushroom'] }), [],
   'more than the target is kept — trimming would mean deleting somebody\'s things');
eq(dm.topUp({ have: { mushroom: 50 }, each: 50, stacking: ['Mushroom'] }), [],
   'kod class names are case-insensitive, and a case-sensitive map is how a lookup ' +
   'fails silently in the direction that looks like a legitimate answer');
eq(dm.topUp({ have: { HeartStone: 48 }, each: 50, singles: ['HeartStone'] }),
   ['create object HeartStone', 'create object HeartStone'],
   'a class that does not stack needs one object each');

// ------------------------------------------------------------- refilling a vital
//
// THREE MESSAGES LOOK RIGHT AND ARE NOT, WHICH IS WHY heal() SETS RATHER THAN GAINS.
// `GainHealth` caps at TWICE piMax_health, `GainMana` does not clamp unless passed
// bCapped, and `GainHealthNormal` — the one that does clamp — returns 0 and changes
// nothing when health is already over the maximum, so it cannot undo the first one.
// The first live run left a 50-health opponent reading 88/50.
eq(dm.parseCeilings(':< OBJECT 7121 is CLASS User\r\n: piHealth = INT 88\r\n' +
                    ': piMax_Health = INT 50\r\n: piMax_Mana = INT 18\r\n'),
   { maxHealth: 50, maxMana: 18 });
ok(Number.isNaN(dm.parseCeilings(': piHealth = INT 3').maxHealth),
   'a ceiling that was not in the reply is NaN, not zero — writing zero would kill it');
eq(dm.MAX_VIGOR, 200, 'viMax_vigor, player.kod:740');

// The reagent list is the thing a caster needs and the thing a spell index named, so a
// silent divergence between the two is a test character that cannot cast.
ok(dm.REAGENTS.includes('ElderBerry') && dm.REAGENTS.includes('Herbs'),
   'create food is 2 elderberry + 2 herbs, so both must be in the list');
ok(!dm.REAGENTS.includes('HeartStone'),
   'HeartStone is a PassiveItem and does not stack — it belongs in the singleton list');
eq(dm.UNSTACKABLE_REAGENTS, ['HeartStone']);
eq(new Set(dm.REAGENTS).size, dm.REAGENTS.length, 'no duplicates, or the pack gets two stacks');

// ============================================================== m59-patrol.mjs

// A ring is a cycle of distinct squares. The two ways it degenerates are a rounding
// collision between neighbours and a collision across the seam, and both produce a step
// that never moves — a patrol that spins on the spot while reporting "ok".
const r8 = ring({ centre: [13, 13], radius: 6, points: 8 });
eq(r8.length, 8);
ok(r8.every(([c, rr]) => Number.isInteger(c) && Number.isInteger(rr)), 'squares are integral');
eq(new Set(r8.map(p => p.join(','))).size, r8.length, 'no duplicate waypoints');

const tiny = ring({ centre: [13, 13], radius: 1, points: 12 });
eq(new Set(tiny.map(p => p.join(','))).size, tiny.length,
   'a radius small enough to round neighbours together drops the collisions');
ok(tiny.length < 12, 'and says so by being shorter, rather than walking on the spot');

const clamped = ring({ centre: [13, 13], radius: 40, points: 8, rows: 24, cols: 24 });
ok(clamped.every(([c, rr]) => c >= 1 && c <= 24 && rr >= 1 && rr <= 24),
   'a ring bigger than the room is clamped into it');

// Phasing is a rotation: same cycle, different starting index, so N characters spread
// round the ring from the first step instead of queueing for waypoint one.
eq(phased(r8, 0), r8, 'the first character walks the ring as given');
eq(phased(r8, 1)[0], r8[1], 'the second starts one segment further round');
eq(new Set(phased(r8, 3).map(p => p.join(','))).size, r8.length,
   'a phase shift is still the whole ring');
eq(phased(r8, 8), r8, 'a full turn is the identity');
const starts = [0, 1, 2, 3, 4].map(i => phased(r8, i)[0].join(','));
eq(new Set(starts).size, 5, 'five characters get five different first waypoints');

// ============================================================= m59-testbed.mjs

eq(ordinalWord(1), 'One');
eq(ordinalWord(5), 'Five');
eq(fill('arena{n}', 3), 'arena3');
eq(fill('{word}', 3), 'Three');
eq(fill('t0', 2), 't0', 'a template with no placeholder is itself');

// A squad is the same entry `count` times. Everything downstream sees one flat list, so
// there is no second code path for "the squad case".
const SPEC = {
  fleet: 'arena',
  server: { host: '127.0.0.1', port: 15959 },
  broker: { http: 8931 },
  characters: [{ agent: 't0', account: 't0', password: 't0', name: 'TESTER',
                 roll: 'balanced', kit: { stats: 50, karma: -60 },
                 place: { room: 60, at: [13, 8] } }],
  squads: [{ count: 5, agent: 'arena{n}', account: 'arena{n}', password: 'arena{n}',
             name: '{word}', roll: 'melee', kit: { stats: 50, health: 50, skills: 50 },
             place: { room: 60, at: [13, 16] }, keeper: { mode: 'survive' } }],
};
const flat = expand(SPEC);
eq(flat.length, 6, 'one character plus a squad of five');
eq(flat.map(c => c.agent), ['t0', 'arena1', 'arena2', 'arena3', 'arena4', 'arena5']);
eq(flat.map(c => c.name), ['TESTER', 'One', 'Two', 'Three', 'Four', 'Five']);
ok(!('count' in flat[1]), 'count belongs to the squad, not to the characters it made');
eq(flat[1].keeper, { mode: 'survive' }, 'the squad entry is copied to each member');
eq(validate(SPEC), [], 'the worked example validates');

// A DIGIT IN A NAME IS THE TRAP a template walks into on its own, so it is named as such
// rather than lumped in with "invalid". CORRECTED: this comment used to say the server
// accepts a digit and substitutes 3/1/4/1/5/9. It does accept one — digits are in
// system.kod:3740's legal set — but the substitution is the STATS path (player.kod:2081)
// and has nothing to do with the name. A name this repository refuses is refused HERE; a
// name the server refuses never becomes a character at all.
const digits = validate({ ...SPEC, characters: [], squads: [{ ...SPEC.squads[0], name: 'bot{n}' }] });
eq(digits.length, 5, 'every member of the squad is named, not just the first');
ok(digits.every(p => /contains a digit/.test(p) && /\{word\}/.test(p)),
   'the message says which placeholder to use instead');
ok(!NAME_RE.test('bot1') && NAME_RE.test('Alpha') && NAME_RE.test("Fehr'loi Qan"),
   'the name rule is one letter then letters, apostrophes and spaces');

// THE TWO BOUNDARIES THAT WERE WRONG IN OPPOSITE DIRECTIONS, pinned here because the gate
// only earns its keep if neither can come back. The ceiling was ours and uncitable at
// sixteen; the hyphen was admitted by us and refused by the server, which turned a
// readable error into a bare BP_CHARINFO_NOT_OK with no reason in it.
eq(CHAR_NAME_MAX, 30, "the ceiling is the server's MAX_CHAR_NAME_LEN, not a number of ours");
eq(CHAR_NAME_MIN, 3, "the floor is the server's MIN_CHAR_NAME_LEN");
ok(checkCharacterName('Raphael son of Mephistopheles').ok,
   'twenty-nine characters is a name the server takes, so the gate takes it too');
ok(!checkCharacterName('Raphael Cambion son of Mephisto').ok,
   'thirty-one is over the server ceiling and is refused here, where the reason is readable');
ok(!checkCharacterName('Jean-Luc').ok,
   'THE HYPHEN IS NOT IN system.kod:3740 - a gate that admits it moves the refusal onto the wire');
ok(/does not allow it either/.test(checkCharacterName('Jean-Luc').why),
   'and the message separates what the server refuses from what only this repository does');
ok(!checkCharacterName('Ao').ok && !checkCharacterName('Raphael ').ok,
   'two characters is under the floor, and a trailing space is trimmed by the client but not the server');
ok(!checkCharacterName('Qor').ok && !checkCharacterName(' qor ').ok,
   'a reserved name is reserved fuzzily: StringEqual trims the ends and uppercases');
ok(!checkCharacterName('A Guardian Angel').ok,
   'and "guardian angel" is a StringContain refusal, so it is refused anywhere in the name');

// A COLLISION IS THE FAILURE THAT LOOKS LIKE SUCCESS: two entries on one account means
// the second re-roll suicides the character the first one made, and both report fine.
const dup = validate({ ...SPEC, squads: [],
  characters: [SPEC.characters[0], { ...SPEC.characters[0], agent: 't1' }] });
ok(dup.some(p => /account "t0" is used twice/.test(p)));
ok(dup.some(p => /name "TESTER" is used twice/.test(p)));

// AN EXPLICIT NAME LIST BEATS THE TEMPLATE — the names people want are not ordinals.
const named = expand({ ...SPEC, characters: [],
  squads: [{ ...SPEC.squads[0], count: 3, names: ['Alpha', 'Bravo', 'Charlie'] }] });
eq(named.map(c => c.name), ['Alpha', 'Bravo', 'Charlie']);
eq(named.map(c => c.agent), ['arena1', 'arena2', 'arena3'],
   'only the name comes from the list; the handles still come from the template');
ok(!('names' in named[0]), 'the list belongs to the squad, not to the characters it made');

// A SHORT LIST WOULD SILENTLY FALL BACK, giving Alpha, Bravo, Three, Four, Five.
ok(validate({ ...SPEC, characters: [], squads: [{ ...SPEC.squads[0], names: ['Alpha', 'Bravo'] }] })
     .some(p => /names lists 2 but count is 5/.test(p)));

// prod has no maintenance socket and is not ours to create accounts on.
ok(validate({ ...SPEC, server: { host: '76.214.42.186', port: 5959 } })
     .some(p => /only ever runs against a server on this machine/.test(p)));

eq(validate({ ...SPEC, characters: [], squads: [] }),
   ['no characters and no squads — there is nothing to build']);
ok(validate({ ...SPEC, squads: [{ ...SPEC.squads[0], roll: 'wizard' }] })
     .some(p => /roll "wizard"/.test(p)));
ok(validate({ ...SPEC, characters: [{ ...SPEC.characters[0], place: { at: [1, 1] } }] })
     .some(p => /place has no room/.test(p)));
ok(validate({ ...SPEC, characters: [{ ...SPEC.characters[0], place: { room: 60, at: [1] } }] })
     .some(p => /place\.at must be/.test(p)));
ok(validate({ ...SPEC, characters: [{ agent: 'x', account: 'x', name: 'Xavier' }], squads: [] })
     .some(p => /password is missing/.test(p)),
   'a missing password is caught before an account is created without one');

// ====================================== the arena reply, in m59-chatter.mjs

const IN_ARENA = { character: 'Alpha', roomNum: 60, host: '127.0.0.1' };

eq(arenaCall({ ...IN_ARENA, text: 'Alpha' }), ARENA_CHALLENGE_WORD);
eq(arenaCall({ ...IN_ARENA, text: '  alpha  ' }), 'challenge', 'case and whitespace do not matter');
eq(arenaCall({ ...IN_ARENA, text: 'Alpha!' }), 'challenge', 'people type a name with punctuation');
eq(arenaCall({ ...IN_ARENA, text: '"Alpha?"' }), 'challenge');

// THE WORD IS THE LITERAL THE WATCHER MATCHES. `challenger` is not a near miss that
// still works — StringEqual (tswatch.kod:224) matches nothing, the Watcher says nothing,
// and silence is also what success looks like.
eq(ARENA_CHALLENGE_WORD, 'challenge');

// NOT A SUBSTRING. Two of these would be live bugs: a bot called Echo answering "echo
// location", and the keeper's own status reply — which opens with the character's name —
// calling every bot in the room into the ring for ever.
eq(arenaCall({ ...IN_ARENA, text: 'Alpha, come here' }), null);
eq(arenaCall({ ...IN_ARENA, text: 'Alpha: not hunting anything, 50/50 health.' }), null,
   'the keeper\'s own status line must not be a trigger, or the bots loop');
eq(arenaCall({ ...IN_ARENA, character: 'Echo', text: 'echo location' }), null);
eq(arenaCall({ ...IN_ARENA, text: 'hello' }), null);
eq(arenaCall({ ...IN_ARENA, text: '' }), null);
eq(arenaCall({ ...IN_ARENA, text: '   ' }), null);

// THE TWO GUARDS THAT MAKE THIS SAFE TO DEFAULT ON.
eq(arenaCall({ ...IN_ARENA, host: '76.214.42.186', text: 'Alpha' }), null,
   'on prod the room contains real people and this must never fire');
eq(arenaCall({ ...IN_ARENA, host: null, text: 'Alpha' }), null,
   'an unknown server is not assumed to be this one');
eq(arenaCall({ ...IN_ARENA, roomNum: 1011, text: 'Alpha' }), null,
   'outside an arena the word means nothing to anybody');
eq(arenaCall({ ...IN_ARENA, roomNum: null, text: 'Alpha' }), null);
eq(arenaCall({ ...IN_ARENA, character: null, text: 'Alpha' }), null,
   'a character with no name of its own answers to nothing');

// Both arenas, because there are two rooms called The Arena of Kraanan.
eq(arenaCall({ ...IN_ARENA, roomNum: 73, text: 'Alpha' }), 'challenge');
eq([...ARENA_ROOMS].sort((a, b) => a - b), [60, 73]);

ok(isLocalServer === dm.isLoopbackHost,
   'the chatter and the DM socket ask ONE question about what counts as local');

console.log(`\nok — ${n} passed, 0 failed`);
